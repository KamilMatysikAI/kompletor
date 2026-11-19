// zdrowie integracji per KONTO (konto kanału, konto przewoźnika, program do faktur z rejestru) i automatyczne
// wyłączenie po N kolejnych porażkach uwierzytelnienia albo konfiguracji. Wzorzec z Open Integration Platform
// `platform/core/connector_health.py` (commit ae43d1e, Apache-2.0, THIRD_PARTY_NOTICES.md: licznik kolejnych porażek
// per instancja i `auto_disable_threshold`), własna implementacja w TS na Postgresie.
//
// Zasady (lekcja Liveko 29.04.2026: jeden zły adres wywalał cały batch i spamował):
//   - porażka = test połączenia nie OK albo wynik TRWALY klasy uwierzytelnienia/konfiguracji; PRZEJSCIOWY,
//     NIEJEDNOZNACZNY i błędy danych jednego rekordu się nie liczą (jeden zły rekord nie wyłącza integracji);
//   - sukces zeruje licznik;
//   - wyłączenie to osobny stan (`disabledAt`), nigdy zmiana konfiguracji konta: tryb konta, `zapisWlaczony`, sekrety
//     i reguły zostają, więc „Włącz ponownie” przywraca konto dokładnie do poprzedniego stanu;
//   - jedno wyłączenie = jeden alert (klucz deduplikacji z chwilą wyłączenia); alert idzie zwykłą drogą powiadomień.
// Wyłączenie konta nie rusza rezerwacji ani stanów w rdzeniu: host tylko przestaje wołać kanał, a zadania czekają.
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { alert } from '../rdzen/stan'

export const ALERT_INTEGRACJA_WYLACZONA = 'INTEGRACJA_WYLACZONA'
/** Domyślny próg kolejnych porażek (Ustawienia → Powiadomienia, `settings.integracje.progWylaczenia`). */
export const PROG_DOMYSLNY = 5
export const PROG_MIN = 2
export const PROG_MAX = 50

export type RodzajIntegracji = 'channel' | 'carrier' | 'invoicing'

/** Konto integracji: klucz (`kanal:WOO/sklep1`, `przewoznik:dpd~EMPIK`, `dokumenty:<adapter>`), rodzaj i nazwa. */
export interface KontoIntegracji {
  klucz: string
  rodzaj: RodzajIntegracji
  nazwa: string
}

export const kluczKanalu = (channel: string, channelAccountId: string) => `kanal:${channel}/${channelAccountId}`
export const kluczPrzewoznika = (kontoId: string) => `przewoznik:${kontoId}`
export const kluczDokumentow = (adapterKey: string) => `dokumenty:${adapterKey}`

export interface StanWylaczenia {
  klucz: string
  disabledAt: Date
  powod: string
  porazki: number
  /** Wynik ostatniej próby „Włącz ponownie”, gdy nieudana (krok i komunikat). */
  ostatniaProba: string | null
  /** „Włącz ponownie” zlecone, a test jeszcze się nie zakończył. */
  wlaczanieOd: Date | null
}

/**
 * „Włącz ponownie” zlecone dawniej niż tyle bez wyniku (worker padł, zadanie porzucone, błąd zapisu
 * wyniku) = nieaktualne: przycisk znowu aktywny, bo to jedyna droga powrotu konta.
 */
export const WLACZANIE_NIEAKTUALNE_MS = 5 * 60_000

/** Czy test po „Włącz ponownie” jeszcze trwa (przycisk zablokowany); false także dla zlecenia starszego niż 5 min. */
export function wlaczanieTrwa(stan: Pick<StanWylaczenia, 'wlaczanieOd'>, now: Date): boolean {
  return !!stan.wlaczanieOd && now.getTime() - stan.wlaczanieOd.getTime() < WLACZANIE_NIEAKTUALNE_MS
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Próg z ustawień firmy (liczba całkowita w granicach), inaczej domyślny. */
export function progZUstawien(settings: unknown): number {
  const v = asObject(asObject(settings)['integracje'])['progWylaczenia']
  return typeof v === 'number' && Number.isInteger(v) && v >= PROG_MIN && v <= PROG_MAX ? v : PROG_DOMYSLNY
}

export async function progWylaczenia(db: PrismaClient): Promise<number> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return progZUstawien(org?.settings)
}

/** Zapis progu (Ustawienia → Powiadomienia). Zła wartość = błąd z tekstem dla człowieka. */
export async function zapiszProg(db: PrismaClient, prog: number): Promise<void> {
  if (!Number.isInteger(prog) || prog < PROG_MIN || prog > PROG_MAX) throw new Error(`Próg musi być liczbą całkowitą od ${PROG_MIN} do ${PROG_MAX}.`)
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; settings: Prisma.JsonValue }[]>`SELECT id, settings FROM "Organization" FOR UPDATE`
    const org = rows[0]
    if (!org) return
    const s = asObject(org.settings)
    await tx.organization.update({ where: { id: org.id }, data: { settings: { ...s, integracje: { ...asObject(s['integracje']), progWylaczenia: prog } } as Prisma.InputJsonValue } })
  })
}

const doStanu = (r: { integrationKey: string; disabledAt: Date | null; disabledReason: string | null; consecutiveFailures: number; enableError: string | null; enableRequestedAt: Date | null }): StanWylaczenia | null =>
  r.disabledAt
    ? { klucz: r.integrationKey, disabledAt: r.disabledAt, powod: r.disabledReason ?? '', porazki: r.consecutiveFailures, ostatniaProba: r.enableError, wlaczanieOd: r.enableRequestedAt }
    : null

/** Stan wyłączenia jednego konta (null = konto działa). */
export async function stanWylaczenia(db: PrismaClient, klucz: string): Promise<StanWylaczenia | null> {
  const r = await db.integrationHealth.findUnique({ where: { organizationId_integrationKey: { organizationId: organizationIdOf(db), integrationKey: klucz } } })
  return r ? doStanu(r) : null
}

/** Surowy stan konta (licznik i wyłączenie) do osłony adaptera; null = konto bez historii błędów. */
export async function stanKonta(db: PrismaClient, klucz: string): Promise<{ consecutiveFailures: number; disabledAt: Date | null; disabledReason: string | null } | null> {
  return db.integrationHealth.findUnique({ where: { organizationId_integrationKey: { organizationId: organizationIdOf(db), integrationKey: klucz } }, select: { consecutiveFailures: true, disabledAt: true, disabledReason: true } })
}

/** Wszystkie wyłączone konta firmy (klucz → stan), do list kont i odznak. */
export async function wylaczoneKonta(db: PrismaClient): Promise<Map<string, StanWylaczenia>> {
  const rows = await db.integrationHealth.findMany({ where: { disabledAt: { not: null } } })
  return new Map(rows.flatMap((r) => { const s = doStanu(r); return s ? [[r.integrationKey, s] as const] : [] }))
}

/** Licznik kolejnych porażek konta (bez wyłączenia: 0, gdy nie było wiersza). */
export async function licznikPorazek(db: PrismaClient, klucz: string): Promise<number> {
  const r = await db.integrationHealth.findUnique({ where: { organizationId_integrationKey: { organizationId: organizationIdOf(db), integrationKey: klucz } }, select: { consecutiveFailures: true } })
  return r?.consecutiveFailures ?? 0
}

const krotko = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Porażka konta: licznik +1 (atomowo), a po osiągnięciu progu wyłączenie z powodem i jednym alertem. Zwraca true, gdy
 * TO wywołanie wyłączyło konto (wołający przestaje wtedy wołać integrację).
 */
export async function zapiszPorazke(db: PrismaClient, konto: KontoIntegracji, powod: string, now: Date): Promise<{ wylaczono: boolean; porazki: number }> {
  const blad = krotko(powod)
  const rows = await db.$queryRaw<{ consecutiveFailures: number; disabledAt: Date | null }[]>`
    INSERT INTO "IntegrationHealth" AS h ("integrationKey", kind, name, "consecutiveFailures", "lastFailureAt", "lastError", "updatedAt")
    VALUES (${konto.klucz}, ${konto.rodzaj}, ${konto.nazwa}, 1, ${now}, ${blad}, ${now})
    ON CONFLICT ("organizationId", "integrationKey") DO UPDATE SET
      "consecutiveFailures" = h."consecutiveFailures" + 1, "lastFailureAt" = EXCLUDED."lastFailureAt", "lastError" = EXCLUDED."lastError",
      kind = EXCLUDED.kind, name = EXCLUDED.name, "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "consecutiveFailures", "disabledAt"`
  const r = rows[0]
  if (!r || r.disabledAt) return { wylaczono: false, porazki: r?.consecutiveFailures ?? 0 }
  const prog = await progWylaczenia(db)
  if (r.consecutiveFailures < prog) return { wylaczono: false, porazki: r.consecutiveFailures }
  const opis = `${r.consecutiveFailures} kolejnych błędów połączenia; ostatni: ${blad}`
  const u = await db.integrationHealth.updateMany({ where: { integrationKey: konto.klucz, disabledAt: null }, data: { disabledAt: now, disabledReason: krotko(opis, 500), enableError: null, enableRequestedAt: null } })
  if (!u.count) return { wylaczono: false, porazki: r.consecutiveFailures }
  await alert(
    db,
    ALERT_INTEGRACJA_WYLACZONA,
    konto.klucz,
    `${konto.nazwa}: integracja wyłączona automatycznie po ${r.consecutiveFailures} kolejnych błędach połączenia (ostatni: ${blad}). Kompletor przestał ją wołać, zadania czekają, nic nie zginęło. Popraw dane połączenia i kliknij „Włącz ponownie” w szczegółach konta.`,
    `integracja-wylaczona:${konto.klucz}:${now.toISOString()}`,
  )
  return { wylaczono: true, porazki: r.consecutiveFailures }
}

/** Sukces konta: licznik do zera (bez zapisu, gdy już zero). Nie zdejmuje wyłączenia (to robi „Włącz ponownie”). */
export async function zapiszSukces(db: PrismaClient, klucz: string, now: Date): Promise<void> {
  await db.integrationHealth.updateMany({ where: { integrationKey: klucz, consecutiveFailures: { gt: 0 } }, data: { consecutiveFailures: 0, lastOkAt: now } })
}

/** „Włącz ponownie” zlecone (test połączenia w kolejce): ślad na ekranie do wyniku. */
export async function zlecWlaczenie(db: PrismaClient, klucz: string, now: Date): Promise<boolean> {
  const u = await db.integrationHealth.updateMany({ where: { integrationKey: klucz, disabledAt: { not: null } }, data: { enableRequestedAt: now, enableError: null } })
  return u.count > 0
}

/**
 * Wynik testu po „Włącz ponownie”: OK = konto wraca (wyłączenie i licznik zdjęte, alert zamknięty), konfiguracja konta
 * bez zmian; błąd = zostaje wyłączone z komunikatem, na którym kroku padło.
 */
export async function wynikWlaczenia(db: PrismaClient, klucz: string, wynik: { ok: true } | { ok: false; krok: string; komunikat: string }, now: Date): Promise<'WLACZONE' | 'NADAL_WYLACZONE' | 'BRAK'> {
  if (wynik.ok) {
    const u = await db.integrationHealth.updateMany({ where: { integrationKey: klucz, disabledAt: { not: null } }, data: { disabledAt: null, disabledReason: null, consecutiveFailures: 0, lastOkAt: now, enabledAt: now, enableError: null, enableRequestedAt: null } })
    await db.alert.updateMany({ where: { kind: ALERT_INTEGRACJA_WYLACZONA, ref: klucz, closedAt: null }, data: { closedAt: now } })
    return u.count ? 'WLACZONE' : 'BRAK'
  }
  const u = await db.integrationHealth.updateMany({ where: { integrationKey: klucz, disabledAt: { not: null } }, data: { enableError: krotko(`${wynik.krok}: ${wynik.komunikat}`, 500), enableRequestedAt: null } })
  return u.count ? 'NADAL_WYLACZONE' : 'BRAK'
}
