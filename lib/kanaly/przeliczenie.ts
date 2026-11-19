// Przeliczenie zamówień czekających na powiązanie oferty. Bez zależności od adapterów i konfiguracji
// kont, żeby import katalogu (lib/import/zapis.ts), „Pobierz oferty” (lib/kanaly/oferty.ts) i skrypt jednorazowy
// (scripts/przelicz-zamowienia.ts) wołały ten sam kod. Każde zamówienie osobno (try/catch), powtórka nic nie zmienia:
// `remapOrder` bierze tylko pozycje bez produktu, a zmapowana pozycja już takiej nie ma.
import type { Channel, OrderStatus, PrismaClient } from '@prisma/client'
import { remapOrder } from '../rdzen/zamowienia'

export const REMAP_STATUSES: OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'DO_WYJASNIENIA']

export interface KontoKanalu {
  channel: Channel
  channelAccountId: string
}

export interface WynikPrzeliczenia {
  remapped: number
  failed: number
}

/**
 * Zamówienia konta z pozycjami bez produktu, które wskazują te oferty: `remapOrder` dopisuje produkt i rezerwację, a gdy
 * „niezmapowana oferta” była jedynym powodem „Do wyjaśnienia”, zamówienie wraca do swojego statusu. Każde osobno.
 */
export async function przeliczZamowienia(
  db: PrismaClient,
  ref: KontoKanalu,
  offerExternalIds: string[],
  opts: { now?: Date; onError?: (orderId: string, e: unknown) => Promise<void> } = {},
): Promise<WynikPrzeliczenia> {
  if (!offerExternalIds.length) return { remapped: 0, failed: 0 }
  const orders = await db.order.findMany({
    where: {
      channel: ref.channel,
      channelAccountId: ref.channelAccountId,
      status: { in: REMAP_STATUSES },
      lines: { some: { productId: null, removed: false, offerId: { in: offerExternalIds } } },
    },
    select: { id: true },
    orderBy: { createdAtChannel: 'asc' },
  })
  let remapped = 0
  let failed = 0
  for (const o of orders) {
    try {
      const r = await remapOrder(db, o.id, { now: opts.now })
      if (r.mapped > 0) remapped++
    } catch (e) {
      failed++
      await opts.onError?.(o.id, e)
    }
  }
  return { remapped, failed }
}

export interface WynikZaleglych extends WynikPrzeliczenia {
  /** Konta, w których były pozycje bez produktu z aktywną już ofertą. */
  accounts: number
  /** Liczba ofert (aktywnych, z produktem), na które czekały pozycje. */
  offers: number
  /** Zamówienia do przeliczenia (z pozycją bez produktu wskazującą aktywną ofertę); przy `naSucho` tylko ta liczba. */
  orders: number
  /** Pozycje bez produktu, dla których oferty nadal nie ma albo jest wyłączona (zostają „Do wyjaśnienia”). */
  stillWithoutOffer: number
}

export interface OpcjeZaleglych {
  now?: Date
  onError?: (orderId: string, e: unknown) => Promise<void>
  channel?: Channel
  channelAccountId?: string
  /** Tylko policz, nic nie zapisuj (skrypt bez --zapisz). */
  naSucho?: boolean
}

/**
 * Wszystkie zaległe: pozycje bez produktu w otwartych zamówieniach, dla których oferta konta jest już aktywna (powstała
 * albo została włączona po przyjęciu zamówienia, np. importem katalogu z oknem sprzedaży). Konto po koncie,
 * zamówienie po zamówieniu. Idempotentne: drugi przebieg nie ma już czego przeliczać.
 */
export async function przeliczZalegle(
  db: PrismaClient,
  opts: OpcjeZaleglych = {},
): Promise<WynikZaleglych> {
  const lines = await db.orderLine.findMany({
    where: {
      productId: null,
      removed: false,
      offerId: { not: null },
      order: {
        status: { in: REMAP_STATUSES },
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(opts.channelAccountId ? { channelAccountId: opts.channelAccountId } : {}),
      },
    },
    select: { offerId: true, order: { select: { channel: true, channelAccountId: true } } },
  })
  const wanted = new Map<string, { ref: KontoKanalu; ids: Set<string> }>()
  for (const l of lines) {
    const k = `${l.order.channel}|${l.order.channelAccountId}`
    const e = wanted.get(k) ?? { ref: { channel: l.order.channel, channelAccountId: l.order.channelAccountId }, ids: new Set<string>() }
    e.ids.add(l.offerId!)
    wanted.set(k, e)
  }
  const out: WynikZaleglych = { remapped: 0, failed: 0, accounts: 0, offers: 0, orders: 0, stillWithoutOffer: 0 }
  for (const { ref, ids } of wanted.values()) {
    const active = await db.channelOffer.findMany({
      where: { channel: ref.channel, channelAccountId: ref.channelAccountId, active: true, externalId: { in: [...ids] } },
      select: { externalId: true },
    })
    const found = new Set(active.map((o) => o.externalId))
    out.stillWithoutOffer += lines.filter((l) => l.order.channel === ref.channel && l.order.channelAccountId === ref.channelAccountId && !found.has(l.offerId!)).length
    if (!found.size) continue
    out.accounts++
    out.offers += found.size
    out.orders += await db.order.count({
      where: { channel: ref.channel, channelAccountId: ref.channelAccountId, status: { in: REMAP_STATUSES }, lines: { some: { productId: null, removed: false, offerId: { in: [...found] } } } },
    })
    if (opts.naSucho) continue
    const r = await przeliczZamowienia(db, ref, [...found], opts)
    out.remapped += r.remapped
    out.failed += r.failed
  }
  return out
}
