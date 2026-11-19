// Przegląd otwartych zamówień rdzenia kontra kanał (krok 6): raz dziennie
// zamówienia w NOWE/DO_REALIZACJI, których kopii (`ChannelOrderSnapshot.lastSeenAt`) kanał dawno nie pokazał, są
// pobierane pojedynczo (`getOrder` adaptera, tylko odczyt). Kanał zwraca zamówienie → zwykła ścieżka odczytu (kopia,
// rdzeń; kosz Woo →). Kanał mówi „nie ma” (null/404: usunięte, kosz bez podglądu) → DO_WYJASNIENIA + alert, bez
// automatycznego anulowania — rezerwacje zostają do decyzji obsługi (kasowanie stwierdza tylko kanał).
import type { OrderStatus, PrismaClient } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts } from '../adaptery/konta'
import { hasOrderFeed } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { alert } from '../rdzen/stan'
import { clarifyOrder } from '../rdzen/zamowienia'
import type { SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { handleChannelOrder } from './odczyt-zamowien'

export const REVIEW_JOB = 'cien-przeglad-otwartych'
export const DEFAULT_REVIEW_STALE_MS = 24 * 3600_000
const OPEN: OrderStatus[] = ['NOWE', 'DO_REALIZACJI']
const MAX_PER_ACCOUNT = 300
/** Od tylu sprawdzanych zamówień „kanał nie zna żadnego” traktujemy jako błąd konfiguracji, nie kasowanie. */
const MIN_ALL_GONE = 3
export const GONE_REASON = 'kanał nie zna zamówienia (usunięte albo w koszu)'

export interface ReviewStats {
  accounts: number
  checked: number
  refreshed: number
  gone: number
  errors: string[]
}

/** `CIEN_PRZEGLAD_GODZIN` (domyślnie 24): po ilu godzinach bez widoku w kanale zamówienie idzie do przeglądu. */
export function reviewStaleMs(env: Record<string, string | undefined>): number {
  const h = Number(env['CIEN_PRZEGLAD_GODZIN'])
  return Number.isFinite(h) && h > 0 && h <= 24 * 30 ? h * 3600_000 : DEFAULT_REVIEW_STALE_MS
}

export async function reviewOpenOrders(
  db: PrismaClient,
  deps: { registry: AdapterRegistry; secrets: SecretSource; fetch?: FetchLike; now?: Date; staleMs?: number },
): Promise<ReviewStats> {
  const now = deps.now ?? new Date()
  const cutoff = new Date(now.getTime() - (deps.staleMs ?? DEFAULT_REVIEW_STALE_MS))
  const stats: ReviewStats = { accounts: 0, checked: 0, refreshed: 0, gone: 0, errors: [] }
  for (const acc of await loadChannelAccounts(db)) {
    const def = deps.registry.get(acc.adapterKey)
    if (!def || !def.manifest.capabilities.includes('orders.feed')) continue
    // najpierw otwarte zamówienia konta (zwykle kilkadziesiąt), potem ich kopie — kopii zamkniętych zamówień przybywa
    // z każdym dniem, więc nie czytamy ich wszystkich
    const open = await db.order.findMany({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId, status: { in: OPEN }, parentOrderId: null }, select: { id: true } })
    if (!open.length) continue
    const todo = await db.channelOrderSnapshot.findMany({
      where: { channel: acc.channel, channelAccountId: acc.channelAccountId, lastSeenAt: { lt: cutoff }, orderId: { in: open.map((o) => o.id) } },
      select: { externalId: true, orderId: true },
      orderBy: { lastSeenAt: 'asc' },
      take: MAX_PER_ACCOUNT,
    })
    if (!todo.length) continue
    stats.accounts++
    let adapter
    try {
      const a = await createAccountAdapter(db, deps.registry, acc, deps.secrets, { fetch: deps.fetch, now: () => now })
      if (!hasOrderFeed(a)) continue
      adapter = a
    } catch (e) {
      stats.errors.push(`${acc.channel}/${acc.channelAccountId}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const gone: typeof todo = []
    for (const s of todo) {
      stats.checked++
      try {
        const o = await adapter.getOrder(s.externalId)
        if (o) {
          await handleChannelOrder(db, acc, o, now)
          stats.refreshed++
        } else gone.push(s)
      } catch (e) {
        // błąd odczytu ≠ „nie ma”: zamówienie zostaje bez zmian, spróbujemy przy następnym przeglądzie
        stats.errors.push(`${acc.channel}/${acc.channelAccountId}/${s.externalId}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300))
      }
    }
    // Kanał „nie zna” żadnego z kilku sprawdzanych zamówień = raczej zła konfiguracja (adres sklepu, wyłączone REST,
    // 404 na wszystko) niż masowe kasowanie — bez zmian w zamówieniach, błąd zadania do wyjaśnienia.
    if (gone.length >= MIN_ALL_GONE && gone.length === todo.length) {
      stats.errors.push(`${acc.channel}/${acc.channelAccountId}: kanał nie zna żadnego z ${gone.length} sprawdzanych zamówień — podejrzenie złej konfiguracji konta, zamówienia bez zmian`)
      continue
    }
    for (const s of gone) {
      try {
        if (await clarifyOrder(db, s.orderId!, GONE_REASON, { allowed: OPEN, actorId: `system:przeglad:${acc.channel}:${acc.channelAccountId}`, now })) {
          stats.gone++
          await alert(db, 'ZAMOWIENIE_ZNIKNELO_Z_KANALU', `${acc.channel}/${acc.channelAccountId}/${s.externalId}`, `Zamówienie ${s.externalId} (${acc.name}): ${GONE_REASON} — „Do wyjaśnienia”, rezerwacja zostaje do decyzji obsługi`, `zniknelo-z-kanalu:${acc.channel}:${acc.channelAccountId}:${s.externalId}`)
        }
      } catch (e) {
        stats.errors.push(`${acc.channel}/${acc.channelAccountId}/${s.externalId}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300))
      }
    }
  }
  return stats
}
