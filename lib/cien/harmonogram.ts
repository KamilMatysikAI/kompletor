// Planowanie odczytów zamówień: zadanie harmonogramu firmy co kilkanaście sekund wrzuca do kolejki
// osobne zadanie odczytu dla każdego konta kanału, któremu minął odstęp (limit adaptera, ustawienie konta, przy
// awarii co 5 min). Osobne zadanie na konto = izolacja: błąd albo wolny kanał jednego konta nie blokuje innych.
import type { Channel, PrismaClient } from '@prisma/client'
import { loadChannelAccounts } from '../adaptery/konta'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { firmaMaBl } from '../kanaly/firma'
import { parseOrgSettings } from '../organizacje'
import type { SecretSource } from '../sekrety'
import { enqueue } from '../worker/kolejka'
import { pollIntervalMs } from './odczyt-zamowien'
import type { AccountInfo } from './bl-porownanie'

export const POLL_JOB = 'cien-zamowienia'

export interface PollJobPayload {
  channel: Channel
  channelAccountId: string
}

export interface PlanResult {
  planned: number
  notDue: number
  withoutAdapter: string[]
}

export async function planOrderPolls(db: PrismaClient, registry: AdapterRegistry, now = new Date()): Promise<PlanResult> {
  const res: PlanResult = { planned: 0, notDue: 0, withoutAdapter: [] }
  const accounts = await loadChannelAccounts(db)
  const cursors = await db.channelCursor.findMany()
  for (const acc of accounts) {
    // EasyTools wchodzi przez API Kompletora (POST /api/v1/zamowienia) — nie ma dziennika do czytania
    if (acc.channel === 'EASYTOOLS') continue
    // konto wyłączone po błędach — bez odczytów do „Włącz ponownie” (kursor stoi, nic nie ginie)
    if (acc.wylaczonePoBledach) {
      res.notDue++
      continue
    }
    const def = registry.get(acc.adapterKey)
    if (!def || !def.manifest.capabilities.includes('orders.feed')) {
      res.withoutAdapter.push(`${acc.channel}/${acc.channelAccountId}`)
      continue
    }
    const cur = cursors.find((c) => c.channel === acc.channel && c.channelAccountId === acc.channelAccountId)
    const every = pollIntervalMs(def.manifest.rateLimit.minPollIntervalMs, acc.config, !!cur?.failingSince)
    if (cur?.lastPollStartedAt && now.getTime() - cur.lastPollStartedAt.getTime() < every) {
      res.notDue++
      continue
    }
    const payload: PollJobPayload = { channel: acc.channel, channelAccountId: acc.channelAccountId }
    const id = await enqueue(db, POLL_JOB, { ...payload }, { dedupeKey: `${POLL_JOB}:${acc.channel}:${acc.channelAccountId}`, maxAttempts: 1 })
    if (id) res.planned++
  }
  return res
}

/**
 * Kanały bez źródła w BL (`channelOfOrder`, lib/import/normalizacja.ts): w porównaniu z BL dałyby pusty wiersz
 * „nieczytane” albo fałszywy „brak w BL”, więc ich tu nie ma. EasyTools (wejście przez API, BL zapisuje te
 * zamówienia jako BL_INNE i zostają w „unpolled”)./083: sklepy Shoper i PrestaShop nie mają importu do BL. IdoSell tak samo (konto podłączone w Kompletorze).
 */
const KANALY_POZA_BL: readonly Channel[] = ['EASYTOOLS', 'SHOPER', 'PRESTASHOP', 'IDOSELL']

/** Konta firmy z informacją, od kiedy nasz odczyt je pokrywa (do porównania z BL). */
export async function accountsForComparison(db: PrismaClient, src?: SecretSource): Promise<AccountInfo[]> {
  const accounts = (await loadChannelAccounts(db)).filter((a) => !KANALY_POZA_BL.includes(a.channel))
  const cursors = await db.channelCursor.findMany()
  // konto dodane w panelu firmy bez BL nie ma odpowiednika w BL, więc nie może być rozjazdem
  // „firma ma BL” z jednego źródła (firmaMaBl: inventory albo token), gdy znamy źródło sekretów
  const org = await db.organization.findFirst({ select: { settings: true } })
  const hasBl = src ? await firmaMaBl(db, src) : !!parseOrgSettings(org?.settings).baselinker?.inventoryId
  const panelOnly = hasBl
    ? new Set<string>()
    : new Set((await db.channelAccountStatus.findMany({ where: { createdInPanel: true }, select: { channel: true, channelAccountId: true } })).map((s) => `${s.channel}/${s.channelAccountId}`))
  return accounts.filter((a) => !panelOnly.has(`${a.channel}/${a.channelAccountId}`)).map((a) => ({
    channel: a.channel,
    channelAccountId: a.channelAccountId,
    name: a.name,
    coverageFrom: cursors.find((c) => c.channel === a.channel && c.channelAccountId === a.channelAccountId && c.lastOkAt)?.coverageFrom ?? null,
  }))
}

/**
 * Czy firma ma integrację z BL do porównań cienia (krok 7): inventory BL w ustawieniach i token — sekret
 * firmy w bazie albo (self-host jednofirmowy) env. Bez odszyfrowania: sama obecność sekretu.
 */
export async function blConfigured(db: PrismaClient, src: SecretSource): Promise<boolean> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  if (!parseOrgSettings(org?.settings).baselinker?.inventoryId) return false
  if ((await db.integrationSecret.count({ where: { name: 'BASELINKER_TOKEN', channel: null } })) > 0) return true
  return src.envFallback && !!src.env['BASELINKER_TOKEN']
}
