// Czy cień zamówień naprawdę czyta (krok 3b). 26.10.2026 log workera mówił „0 błędów”, a baza miała
// 0 udanych odczytów na wszystkich 4 kontach: błąd konfiguracji konta lądował cicho w ChannelCursor.lastError.
// Tu czysta ocena per konto z kursorów i otwartych alertów — tę samą liczbę pokazują /api/health (wszystkie firmy,
// klient systemowy) i pulpit panelu (jedna firma, RLS). Bez danych klientów: konta, daty, treść błędu odczytu.
import type { PrismaClient } from '@prisma/client'
import { DEFAULT_CHANNEL_ADAPTER } from '../adaptery'
import { defaultRegistry } from '../adaptery/domyslne'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { cienOdczytZEnv } from '../worker/harmonogram'
import { cachedCheck } from '../zdrowie'
import { NOT_READING_ALERT } from './odczyt-zamowien'

/** Konto „nie czyta”, gdy nie ma udanego (pełnego) odczytu od tylu minut albo ma otwarty alert konta. */
export const NOT_READING_AFTER_MS = 15 * 60_000

export interface ShadowAccount {
  organizationId: string
  channel: string
  channelAccountId: string
  name: string
  adapterKey: string
}

export interface ShadowCursor {
  organizationId: string
  channel: string
  channelAccountId: string
  firstPollAt: Date | null
  lastOkAt: Date | null
  failingSince: Date | null
  lastError: string | null
}

/** Otwarty alert KANAL_ZAMOWIENIA_NIEDOSTEPNY (ref = `KANAL/konto`). */
export interface ShadowAlert {
  organizationId: string
  ref: string
}

export type NotReadingReason = 'alert' | 'brak-udanego-odczytu' | 'nigdy-nie-czytane'

export interface AccountReading extends ShadowAccount {
  reading: boolean
  reason: NotReadingReason | null
  lastOkAt: Date | null
  failingSince: Date | null
  lastError: string | null
}

export interface ShadowReadingState {
  /** CIEN_ODCZYT: false = cień wyłączony świadomie, wtedy nic nie jest „nie czyta”. */
  enabled: boolean
  status: 'ok' | 'degraded' | 'off'
  /** Konta z adapterem odczytu zamówień (orders.feed) w aktywnych firmach. */
  accounts: number
  notReading: number
  /** Otwarte alerty „nie czyta” kont z `accounts` (bez kont nieaktywnych i spoza cienia). */
  openAlerts: number
  /**
   * Aktywne konta kanałów sprzedaży bez adaptera z odczytem zamówień (dziś np. Allegro) — cień ich nie czyta z
   * założenia, więc nie są „nie czyta”, ale health mówi wprost, ile ich jest.
   */
  withoutAdapter: number
  details: AccountReading[]
}

/**
 * Włączenie cienia widziane z panelu / health: ta sama zmienna co w workerze (`CIEN_ODCZYT`, ustawiana na obu
 * aplikacjach). Zła wartość = traktujemy jak włączony — worker i tak na niej nie wstanie, a health ma krzyczeć.
 */
export function shadowEnabled(env: Record<string, string | undefined>): boolean {
  try {
    return cienOdczytZEnv(env)
  } catch {
    return true
  }
}

const same = (a: { organizationId: string; channel: string; channelAccountId: string }, b: typeof a) =>
  a.organizationId === b.organizationId && a.channel === b.channel && a.channelAccountId === b.channelAccountId

/**
 * Ocena kont: `accounts` to już tylko konta aktywne z adapterem odczytu (filtr robi wołający). Konto czyta, gdy
 * ostatni pełny odczyt (`lastOkAt`) jest młodszy niż 15 min i nie ma otwartego alertu. Konto bez żadnego odczytu
 * liczymy od pierwszej próby (`firstPollAt`, `failingSince`); bez kursora w ogóle (worker go nie dotknął) — nie czyta
 * od razu. Okres rozruchu po starcie workera (5 min) należy do sprawdzającego (deploy, staging_kompletor.py).
 */
export function shadowReadingState(input: {
  enabled: boolean
  accounts: ShadowAccount[]
  cursors: ShadowCursor[]
  openAlerts: ShadowAlert[]
  now: Date
  withoutAdapter?: number
}): ShadowReadingState {
  const { enabled, now } = input
  const details: AccountReading[] = input.accounts.map((a) => {
    const cur = input.cursors.find((c) => same(c, a))
    const alerted = input.openAlerts.some((x) => x.organizationId === a.organizationId && x.ref === `${a.channel}/${a.channelAccountId}`)
    const base = { ...a, lastOkAt: cur?.lastOkAt ?? null, failingSince: cur?.failingSince ?? null, lastError: cur?.lastError ?? null }
    let reason: NotReadingReason | null = null
    if (alerted) reason = 'alert'
    else if (!cur) reason = 'nigdy-nie-czytane'
    else {
      const since = cur.lastOkAt ?? cur.firstPollAt ?? cur.failingSince
      if (!since) reason = 'nigdy-nie-czytane'
      else if (now.getTime() - since.getTime() > NOT_READING_AFTER_MS) reason = cur.lastOkAt ? 'brak-udanego-odczytu' : 'nigdy-nie-czytane'
    }
    return { ...base, reading: !enabled || reason === null, reason: enabled ? reason : null }
  })
  const notReading = details.filter((d) => !d.reading).length
  // alert konta wyłączonego w trakcie awarii zostaje otwarty, ale nie jest już kontem cienia — nie liczymy go
  const openAlerts = input.openAlerts.filter((x) => input.accounts.some((a) => a.organizationId === x.organizationId && x.ref === `${a.channel}/${a.channelAccountId}`)).length
  return {
    enabled,
    status: !enabled ? 'off' : notReading > 0 ? 'degraded' : 'ok',
    accounts: details.length,
    notReading,
    openAlerts,
    withoutAdapter: input.withoutAdapter ?? 0,
    details,
  }
}

/**
 * Odczyt z bazy dla `shadowReadingState`. Działa na kliencie systemowym (/api/health: wszystkie aktywne firmy) i na
 * kliencie firmy (pulpit: RLS zostawia tylko jej wiersze). Konta: aktywne, w aktywnej firmie, z adapterem, który ma
 * zdolność orders.feed (te same, które planuje harmonogram cienia).
 */
export async function loadShadowReading(db: PrismaClient, opts: { enabled: boolean; now?: Date; registry?: AdapterRegistry }): Promise<ShadowReadingState> {
  const registry = opts.registry ?? defaultRegistry()
  const [configs, cursors, alerts] = await Promise.all([
    db.channelConfig.findMany({
      where: { active: true, organization: { active: true } },
      select: { organizationId: true, channel: true, channelAccountId: true, name: true, adapterKey: true },
      orderBy: [{ organizationId: 'asc' }, { channel: 'asc' }, { channelAccountId: 'asc' }],
    }),
    db.channelCursor.findMany({ select: { organizationId: true, channel: true, channelAccountId: true, firstPollAt: true, lastOkAt: true, failingSince: true, lastError: true } }),
    db.alert.findMany({ where: { kind: NOT_READING_ALERT, closedAt: null, organization: { active: true } }, select: { organizationId: true, ref: true } }),
  ])
  // rodzina AI to integracja, nie kanał sprzedaży — nie liczy się ani do kont cienia, ani do `withoutAdapter`;
  // EASYTOOLS wchodzi przez API Kompletora, bez dziennika zamówień do czytania — tak samo poza cieniem
  const sales = configs.filter((c) => c.channel !== 'AI' && c.channel !== 'EASYTOOLS').map((c) => ({ ...c, adapterKey: c.adapterKey || DEFAULT_CHANNEL_ADAPTER[c.channel] }))
  const accounts = sales.filter((c) => registry.get(c.adapterKey)?.manifest.capabilities.includes('orders.feed'))
  return shadowReadingState({ enabled: opts.enabled, accounts, cursors, openAlerts: alerts, now: opts.now ?? new Date(), withoutAdapter: sales.length - accounts.length })
}

/** Ile pamiętamy stan cienia dla otwartej ścieżki /api/health. */
export const HEALTH_CACHE_MS = 10_000

const healthCache = new Map<boolean, () => Promise<ShadowReadingState>>()

/**
 * Stan cienia dla /api/health: najwyżej jedno liczenie (3 zapytania na kliencie systemowym) na 10 s, niezależnie od
 * ruchu na otwartej, niechronionej ścieżce — jak `appRoleHealthCached`. Klient bazy brany przy każdym
 * liczeniu (`db()`), osobny bufor dla włączonego i wyłączonego cienia. Kto widzi `details`, decyduje route per żądanie
 * (Basic Auth), więc bufor tego nie zmienia. Błąd odczytu nie jest pamiętany (`cachedCheck`). 10 s przy granicy 15 min
 * nie ma znaczenia.
 */
export function shadowReadingForHealth(db: () => PrismaClient, enabled: boolean): Promise<ShadowReadingState> {
  let check = healthCache.get(enabled)
  if (!check) {
    check = cachedCheck(() => loadShadowReading(db(), { enabled }), HEALTH_CACHE_MS)
    healthCache.set(enabled, check)
  }
  return check()
}

/** Tylko testy: kolejne wywołanie health liczy stan od nowa. */
export function resetShadowHealthCache(): void {
  healthCache.clear()
}
