// Rejestr zadań workera. Nowe rodzaje (polling zamówień, propagacja stanów — F2) dopisuje się tutaj.
// handler dostaje klienta firmy zadania (RLS) i źródło jej sekretów; nie widzi innych firm.
import { sprzatajAkcje, wykonajWTle, ZADANIE_MASOWE, ZADANIE_SPRZATANIA } from '../zamowienia/masowo'
import { wykonajPrzesylkiWTle, ZADANIE_PRZESYLEK } from '../wysylka/masowo'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Prisma, PrismaClient } from '@prisma/client'
import { moveOrder } from '../rdzen/przejscia'
import { TransitionError } from '../rdzen/statusy'
import { analyze, collectSources } from '../import/katalog'
import { loadOfferOverrides } from '../import/nadpisania'
import { dniSprzedazyZEnv, oknoSprzedazy } from '../import/okno-sprzedazy'
import { renderReport } from '../import/raport'
import { persistImport } from '../import/zapis'
import { NonRetryableError } from '../bledy'
import { clientsForOrg, type Env, WFIRMA_KEYS } from '../konfiguracja'
import { channelMapOf } from '../organizacje'
import { auditInvariants, auditStale } from '../rdzen/niezmienniki'
import { zamknijNieaktualneAlertyFakturyBl } from '../rdzen/faktura-bl'
import { reapStaleInvoices } from '../rdzen/rozchod'
import { bezWysylkiPrzyStanieKompletora, type OdczytStanowWfirma, type QueueStats, requestFullRead, runWfirmaQueueExclusive } from '../rdzen/kolejka-wfirmy'
import { WfirmaStockReader } from '../cien/odczyt-stanow-wfirmy'
import { accountsToPush, isNightSyncDue, runFanout, runNightlyFullSync, runRecoveredFullSyncs } from '../rdzen/propagacja'
import { allocationGuard, processAllocateEvents } from '../rdzen/przydzial'
import { runReservationExpiry } from '../rdzen/zamowienia'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import { resolveSecrets, type SecretSource } from '../sekrety'
import { defaultRegistry } from '../adaptery/domyslne'
import { loadChannelAccounts } from '../adaptery/konta'
import { AdapterConfigError } from '../adaptery/rejestr'
import { blOrderHeader, runBlComparison } from '../cien/bl-porownanie'
import { syncWfirmaWz, WfirmaWzZrodlo, WZ_JOB } from '../cien/wz-wfirmy'
import { ostatniUdanyPrzebieg, zapiszUdanyPrzebieg } from '../cien/przebiegi'
import { accountsForComparison, planOrderPolls, POLL_JOB, type PollJobPayload } from '../cien/harmonogram'
import { DEFAULT_LOOKBACK_MS, pollAccount } from '../cien/odczyt-zamowien'
import { INVOICES_BACKFILL_DAYS, INVOICES_JOB, syncBlInvoices, WfirmaWzReader } from '../cien/faktury-bl'
import { odswiezOpisZKanalu } from '../karta/opis-z-kanalu'
import type { WynikNumeru } from '../cien/parowanie-faktur'
import { REVIEW_JOB, reviewOpenOrders, reviewStaleMs } from '../cien/przeglad-otwartych'
import { alertOfficeItems, buildDailyReport, renderDailyReport, REPORT_CHECK, reportWaitsForMirror, saveDailyReport } from '../cien/raport-dzienny'
import { dayToClose, runDaySalesCheck, SALES_CHECK, warsawDay } from '../cien/sprzedaz-dnia'
import { addDays, toWarsaw } from '../rdzen/kalendarz'
import { WfirmaReadOnly } from '../zrodla/wfirma'
import { WfirmaZapis } from '../zrodla/wfirma-zapis'
import { FakturyWfirmaZapis } from '../wfirma/adapter-zapis'
import { KorektyWfirmaZapis } from '../wfirma/korekta-zapis'
import { odczytZwrotowKanalow } from '../zwroty/z-kanalu'
import { dostawcaWfirmy } from '../wfirma/dostawca'
import { WzWfirmaZapis } from '../wfirma/wz-zapis'
import { wystawWzDlaWydanych } from '../rdzen/wz-wydanie'
import { ustawieniaDokumentowFirmy } from '../dokumenty/firma'
import { korektyWlaczone } from '../dokumenty/ustawienia'
import { odbiorcaDoCelu } from '../klienci/wejscia'
import type { FakturyWfirma } from '../rdzen/rozchod'
import type { KorektyWfirma } from '../rdzen/zwroty'
import { loadImportConfig } from '../organizacje'
import { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { cienOdczytZEnv, KSEF_WYSYLKA_JOB, LUSTRO_WFIRMY_JOB, lustroWfirmyZEnv, ZWROTY_KANALOW_JOB } from './harmonogram'
import { przebiegKsefZLimitem } from '../ksef/wysylka'
import { zadaniePlanuAkcji } from '../akcje/silnik'
import { przetworzCzas, przetworzZdarzenia, ZADANIE_AUTOMATOW, ZADANIE_AUTOMATOW_CZAS } from '../automaty/silnik'
import { sprzatajDruk } from '../druk/zlecenia'
import { WFIRMA_GOOD_JOB, zadanieOdczytuTowaru } from '../produkty/wfirma-towar'
import { ZDJECIA_Z_OFERTY_JOB, zadanieZdjecZOferty } from '../produkty/zdjecia'
import { PACKSHOT_JOB, zadaniePackshotu } from '../produkty/packshot'
import { OFERTY_MASOWO_JOB, przebiegPrzygotowania } from '../oferty/masowo'
import { zaleznosciPrzebieguOfert } from '../oferty/publikacja-serwer'
import { FEED_JOB, feedNalezny, przebiegFeedow } from '../produkty/zdjecia-feed'
import { zadaniePowiadomienZulip } from '../powiadomienia/zadanie'
import { KANAL_OFERTY_JOB, KANAL_TEST_JOB, wykonajPobranieOfert, wykonajTestPolaczenia } from '../kanaly/zadania'
import { PRZEPROWADZKA_JOB, wykonajPrzeprowadzkeZPanelu } from '../przeprowadzka/z-panelu'
import { PRZEWOZNIK_TEST_JOB, wykonajTestKonta } from '../wysylka/konta'
import { KLIENT_ZAPIS_JOB } from '../klienci/kolejka'
import { przebiegRetencji, RETENCJA_JOB } from '../klienci/retencja'
import { wykonajZapisKlienta } from '../klienci/zapis'
import { cleanupMcpCalls, MCP_LOG_JOB } from '../mcp/dziennik'
import { EMPIK_AKCEPTACJA_JOB, runEmpikAcceptance } from '../empik/akceptacja'
import { IMPORTY_STANOW_JOB, przebiegImportowStanow } from '../kanaly/importy-stanow'
import { ZADANIE_RESETU } from '../auth/reset-hasla'
import { ZADANIE_SPRZATANIA_RESETOW, zadanieResetuHasla, zadanieSprzataniaResetow, zadanieWysylkiPoczty } from '../poczta/zadanie'
import { ZADANIE_WYSYLKI } from '../poczta/wysylka'
import { ZADANIE_ODBIC, zadanieOdbicPoczty } from '../poczta/czytnik-odbic'
import { przebiegZapisuKanalow, wyslijStanyKonta, ZAPIS_KANALOW_JOB } from '../kanaly/zapis-host'
import { ZADANIE_SLEDZENIA, ZADANIE_WYSLANE_PO_PRZYJEZDZIE, zadanieSledzenia, zadanieWyslanePoPrzyjezdzie } from '../pakowanie/wyslane-po-przyjezdzie'

/**
 * Katalog raportu z payloadu zadania: tylko podkatalog RAPORTY_DIR (domyślnie ./raporty), bez ścieżek
 * bezwzględnych i „..” — payload nie może wskazać dowolnego miejsca zapisu na dysku workera (przegląd r2, uwaga 15).
 */
export function reportDir(env: Env, requested: string): string {
  const base = path.resolve(env['RAPORTY_DIR'] || 'raporty')
  if (path.isAbsolute(requested) || /^[a-zA-Z]:/.test(requested) || requested.split(/[\\/]/).includes('..')) {
    throw new NonRetryableError(`raportDir „${requested}” odrzucony: dozwolona tylko ścieżka względna wewnątrz RAPORTY_DIR`)
  }
  const dir = path.resolve(base, requested)
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new NonRetryableError(`raportDir „${requested}” wychodzi poza RAPORTY_DIR`)
  return dir
}

export interface HandlerCtx {
  organizationId: string
  secrets: SecretSource
  /** numer próby zadania (handler może zakończyć swój stan przy ostatniej próbie) */
  job?: { id: string; attempts: number; maxAttempts: number }
}

export type Handler = (db: PrismaClient, payload: Prisma.JsonValue, ctx: HandlerCtx) => Promise<void>

const registry = defaultRegistry()

/** Okno pierwszego odczytu konta i porównania z BL (env CIEN_OKNO_GODZINY, domyślnie 24 h). */
function windowMs(env: Record<string, string | undefined>): number {
  const h = Number(env['CIEN_OKNO_GODZINY'])
  return Number.isFinite(h) && h > 0 && h <= 24 * 30 ? h * 3600_000 : DEFAULT_LOOKBACK_MS
}

/**
 * Wyłącznik cienia egzekwowany też w handlerze, nie tylko w harmonogramie: zadanie cienia już w kolejce
 * (zaplanowane przed `CIEN_ODCZYT=0`, ręczne enqueue) kończy się bez dotykania bazy i kanałów. Zła wartość = błąd
 * bez ponawiania.
 */
function cienWylaczony(env: Env, kind: string): boolean {
  try {
    return !cienOdczytZEnv(env)
  } catch (e) {
    throw new NonRetryableError(`${kind}: ` + (e instanceof Error ? e.message : String(e)))
  }
}

/** Wyłącznik lustra stanów wFirmy w handlerze: jak `cienWylaczony`, zła wartość = błąd bez ponawiania. */
function lustroWylaczone(env: Env): boolean {
  try {
    return !lustroWfirmyZEnv(env)
  } catch (e) {
    throw new NonRetryableError(`${LUSTRO_WFIRMY_JOB}: ` + (e instanceof Error ? e.message : String(e)))
  }
}

/** Firmy, dla których worker już zalogował brak kluczy wFirmy (jeden ślad na proces, nie co 2 min). */
const lustroBezKluczy = new Set<string>()

/**
 * Jeden przebieg lustra stanów wFirmy: sam odczyt (`faktury`/`korekty` = null), budżet i dzierżawa kolejki.
 * Pierwszy pełny odczyt po wdrożeniu rusza sam: gdy firma nie ma jeszcze żadnego (`lastFullReadAt`) ani
 * zleconego (`fullReadDueSince`), przebieg go zleca; dalej zleca go noc (`rdzen-noc`). Limit wFirmy wstrzymuje kolejkę
 * w niej samej (`pausedUntil`); inny błąd leci wyżej (Job.lastError).
 */
/** najwyżej tyle wysyłek z WZ na przebieg (2 wywołania wFirmy na wysyłkę, limit wspólny z fakturami). */
export const WZ_NA_PRZEBIEG = 10
/** Pełny odczyt stanów wFirmy w ciągu dnia: nie rzadziej niż co tyle od poprzedniego udanego. */
export const PELNY_ODCZYT_CO_MS = 10 * 60_000

/**
 * 19.11.2026: stanowisko tworzy przesyłkę od razu po „Spakowano”, czyli przed fakturą, a rdzeń wtedy odmawia
 * „Do wysłania” („najpierw faktura”). Po wystawieniu faktury nikt statusu nie ruszał, więc zamówienia z fakturą
 * i przesyłką stały w „Spakowane”. Ten przebieg dopycha je do „Do wysłania” zwykłym przejściem rdzenia (te same
 * warunki co z ekranu); odmowa przejścia nie jest błędem przebiegu.
 */
export async function doWyslaniaPoFakturze(db: PrismaClient, now = new Date(), opts: { limit?: number; odrzucone?: Map<string, number> } = {}): Promise<number> {
  // odmowa przejścia nie zmienia `updatedAt` (transakcja się wycofuje), więc bez pamięci te same
  // najstarsze odrzucone zajmowały każdy przebieg, a nowe z fakturą stały w „Spakowane”. Odrzucone wracają po
  // DO_WYSLANIA_ODROCZENIE_MS. Okno 3 dni liczy się od zmiany zamówienia ALBO od wystawienia faktury (faktura
  // wystawiona po kilku dniach od ostatniej zmiany zamówienia też łapie).
  const odrzucone = opts.odrzucone ?? odrzuconeDoWyslania
  const t = now.getTime()
  for (const [id, do_] of odrzucone) if (do_ <= t) odrzucone.delete(id)
  const okno = new Date(t - 3 * 86_400_000)
  const pominiete = [...odrzucone.keys()].slice(-1000)
  const lista = await db.order.findMany({
    where: {
      status: 'SPAKOWANE',
      ...(pominiete.length ? { id: { notIn: pominiete } } : {}),
      OR: [{ updatedAt: { gte: okno } }, { invoices: { some: { state: 'ISSUED', updatedAt: { gte: okno } } } }],
      invoices: { some: { state: 'ISSUED' } },
      carrierShipments: { some: { state: 'UTWORZONA' } },
    },
    select: { id: true, carrierShipments: { where: { state: 'UTWORZONA' }, orderBy: { createdAt: 'desc' }, take: 1, select: { trackingNumber: true } } },
    orderBy: { updatedAt: 'asc' },
    take: opts.limit ?? 50,
  })
  let przeniesione = 0
  for (const o of lista) {
    const numer = o.carrierShipments[0]?.trackingNumber ?? null
    try {
      await moveOrder(db, o.id, 'DO_WYSLANIA', { actorId: 'system:po-fakturze', now, ...(numer ? { trackingNo: numer } : {}) })
      przeniesione++
    } catch (e) {
      odrzucone.set(o.id, t + DO_WYSLANIA_ODROCZENIE_MS)
      if (!(e instanceof TransitionError)) console.error(`[do-wyslania-po-fakturze] ${o.id}: ${e instanceof Error ? e.name : 'błąd'}`)
    }
  }
  return przeniesione
}

/** zamówienie, któremu rdzeń odmówił „Do wysłania”, wraca do kolejnych przebiegów po tym czasie. */
export const DO_WYSLANIA_ODROCZENIE_MS = 30 * 60_000
/** Pamięć odrzuconych w procesie workera (id zamówienia → do kiedy pomijać); id są unikalne między firmami. */
const odrzuconeDoWyslania = new Map<string, number>()

export async function runLustroWfirmy(db: PrismaClient, odczyt: OdczytStanowWfirma | null, ctx: { now?: Date; faktury?: FakturyWfirma | null; korekty?: KorektyWfirma | null } = {}): Promise<QueueStats & { skipped?: true; fullReadRequested?: true }> {
  const now = ctx.now ?? new Date()
  const s = await db.wfirmaQueueState.findFirst({ select: { lastFullReadAt: true, fullReadDueSince: true } })
  let fullReadRequested = false
  // firma, której stan prowadzi Kompletor, nie dostaje zlecenia pełnego odczytu
  // 19.11.2026: przyjęcie towaru wpisane w wFirmie (PZ, produkcja) widać dopiero w pełnym odczycie, więc pełny odczyt
  // idzie też w ciągu dnia, co PELNY_ODCZYT_CO_MS od poprzedniego; faktury dalej mają pierwszeństwo w kolejce
  const przeterminowany = !!s?.lastFullReadAt && now.getTime() - s.lastFullReadAt.getTime() >= PELNY_ODCZYT_CO_MS
  if (odczyt && (!s?.lastFullReadAt || przeterminowany) && !s?.fullReadDueSince && (await zrodloStanu(db)) === 'WFIRMA') {
    await requestFullRead(db, { now })
    fullReadRequested = true
  }
  // faktury z prawdziwym adapterem zapisu tylko dla kont w PRACA (`tylkoPraca`) — konto w podglądzie ma fakturę z BL
  const faktury = ctx.faktury ?? null
  // korekty przy zwrotach tym samym wyłącznikiem co faktury; adapter sam odmawia dla konta w podglądzie
  const r = await runWfirmaQueueExclusive(db, { odczyt, faktury, korekty: ctx.korekty ?? null }, { ...(ctx.now ? { now } : {}), ...(faktury ? { tylkoPraca: true } : {}) })
  return fullReadRequested ? { ...r, fullReadRequested: true } : r
}

/**
 * po udanym imporcie katalogu (kopia stanów BL `accounting_1`) zlecenie pełnego odczytu lustra wFirmy, żeby
 * raport rozjazdów porównywał stany z tej samej chwili. Bez tego lustro czytało pełny stan tylko nocą, a BL wieczorem:
 * 04.11 16 towarów z PZ w ciągu dnia (u nas 0, BL 10) i sprzedaż spoza cienia wyszły jako rozjazdy. Wyłączone lustro
 * (albo zła wartość wyłącznika — tę i tak zatrzymuje start workera) = nic. Zlecenie jest idempotentne (`requestFullRead`).
 * Błąd zlecenia nie cofa zapisanego importu: ślad w logu, pełny odczyt i tak zleci noc (`rdzen-noc`).
 */
export async function requestMirrorAfterImport(db: PrismaClient, env: Env, ctx: { now?: Date } = {}): Promise<boolean> {
  try {
    if (!lustroWfirmyZEnv(env)) return false
  } catch {
    return false
  }
  try {
    await requestFullRead(db, ctx)
    return true
  } catch (e) {
    console.error(`[import-katalogu] zlecenie pełnego odczytu lustra wFirmy po imporcie nie przeszło: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** Token BL firmy; null = firma bez BL (zadanie kończy cicho, jak porównanie). */
async function blToken(db: PrismaClient, ctx: HandlerCtx): Promise<string | null> {
  const s = await resolveSecrets(db, ['BASELINKER_TOKEN'], ctx.secrets)
  return s['BASELINKER_TOKEN'] || null
}

/** Dzień z payloadu zadania na żądanie: „dzis” albo RRRR-MM-DD; brak = tryb harmonogramu (null). */
function payloadDay(payload: Prisma.JsonValue, kind: string, now: Date): string | null {
  const d = (payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)['day'] : undefined) ?? null
  if (d === null || d === undefined) return null
  if (d === 'dzis') return toWarsaw(now).day
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  throw new NonRetryableError(`${kind}: day „${String(d)}” — dozwolone „dzis” albo RRRR-MM-DD`)
}

export const handlers: Record<string, Handler> = {
  // Test życia workera (scripts/smoke-worker.ts).
  ping: async () => {},
  // akcja masowa z listy zamówień w tle (próg per rodzaj, masowo-progi.ts): postęp i wynik per zamówienie w OrderBulkAction
  [ZADANIE_MASOWE]: async (db, payload, ctx) => {
    await wykonajWTle(db, payload, ctx.job)
  },
  // akcja masowa z listy przesyłek w tle (druk etykiet, anulowanie): ten sam wiersz postępu, osobne zadanie
  [ZADANIE_PRZESYLEK]: async (db, payload, ctx) => {
    await wykonajPrzesylkiWTle(db, payload, ctx.job, { secrets: ctx.secrets })
  },
  // akcje bez ruchu > 1 h → przerwane, raporty starsze niż 30 dni usuwane
  [ZADANIE_SPRZATANIA]: async (db) => {
    await sprzatajAkcje(db)
  },
  // automatyczne akcje (zapisy tylko przez hosty i rdzeń za ich wyłącznikami); błędy zbiorczo do Job.lastError
  [ZADANIE_AUTOMATOW]: async (db, _payload, ctx) => {
    const w = await przetworzZdarzenia(db, { env: ctx.secrets.env, deps: { registry, secrets: ctx.secrets } })
    if (w.bledy.length) throw new Error(`automatyczne akcje: ${w.bledy.join('; ')}`.slice(0, 4000))
  },
  [ZADANIE_AUTOMATOW_CZAS]: async (db, _payload, ctx) => {
    const w = await przetworzCzas(db, { env: ctx.secrets.env, deps: { registry, secrets: ctx.secrets } })
    if (w.bledy.length) throw new Error(`automatyczne akcje (czas): ${w.bledy.join('; ')}`.slice(0, 4000))
  },
  'akcje-plan': zadaniePlanuAkcji, // plan akcji („wysłałbym”), nic nie wychodzi
  // zlecenia druku po 8 h → WYGASLO, bajty plików zakończonych zleceń (dane zamówień) usuwane po 7 dniach
  'druk-sprzatanie': async (db) => {
    await sprzatajDruk(db)
  },
  [WFIRMA_GOOD_JOB]: zadanieOdczytuTowaru, // „Dodaj produkt” — jeden towar wFirmy po kodzie, tylko find
  // zdjęcia z oferty sklepu dla produktu założonego z oferty (https, limit rozmiaru, osłona uploadu)
  [ZDJECIA_Z_OFERTY_JOB]: async (db, payload) => {
    await zadanieZdjecZOferty(db, payload)
  },
  // zdjęcia produktów z feedu produktowego (Google Merchant XML), tylko odczyt feedu; automat raz na dobę nocą
  // (harmonogram co godzinę, `feedNalezny`), przycisk w panelu z `{ wymus: true }`. Feed z błędem = wynik FAILED
  // z komunikatem na ekranie, bez wyjątku (worker nie ponawia).
  [FEED_JOB]: async (db, payload, ctx) => {
    const wymus = !!payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string, unknown>)['wymus'] === true
    const now = new Date()
    if (!wymus && !(await feedNalezny(db, now))) return
    const r = await przebiegFeedow(db, { zrodlo: wymus ? 'panel' : 'noc', now })
    if (r) console.log(`[${FEED_JOB}] firma ${ctx.organizationId}: pozycje ${r.feedy.reduce((a, f) => a + f.pozycje, 0)}, do pobrania ${r.doPobrania}, zlecone ${r.zlecone}, ponad limit ${r.pominiete}, błędy feedów ${r.feedy.filter((f) => f.blad).length}`)
  },
  // packshot AI (Kie.ai) ze zdjęcia produktu, za wyłącznikiem firmy; wynik jako nowe zdjęcie
  // „Przygotuj oferty” dla zaznaczonych produktów — same podglądy (odczyt kanałów przez osłonę konta), raport
  // w ImportRun; nic nie wystawia. Powtórka po zakończonym przebiegu nic nie robi.
  [OFERTY_MASOWO_JOB]: async (db, payload, ctx) => {
    await przebiegPrzygotowania(db, payload, zaleznosciPrzebieguOfert(db, { registry, src: ctx.secrets }))
  },
  [PACKSHOT_JOB]: async (db, payload, ctx) => {
    await zadaniePackshotu(db, payload, { env: ctx.secrets.env, job: ctx.job })
  },
  'powiadomienia-zulip': zadaniePowiadomienZulip(), // alerty na Zulip, domyślnie nic nie wychodzi
  // maile z planu akcji (tylko konta w PRACA, bramki POCZTA_WYSYLKA i włącznik firmy) i link resetu hasła
  [ZADANIE_WYSYLKI]: zadanieWysylkiPoczty(),
  [ZADANIE_RESETU]: zadanieResetuHasla(),
  [ZADANIE_SPRZATANIA_RESETOW]: zadanieSprzataniaResetow(),
  [ZADANIE_ODBIC]: zadanieOdbicPoczty(), // raporty o niedoręczeniu ze skrzynki nadawcy (IMAP)
  // konto kanału z panelu — test połączenia i pobranie ofert (tylko odczyt kanału, zlecane z ekranu)
  [KANAL_TEST_JOB]: async (db, payload, ctx) => {
    await wykonajTestPolaczenia(db, payload, { registry, secrets: ctx.secrets })
  },
  [KANAL_OFERTY_JOB]: async (db, payload, ctx) => {
    await wykonajPobranieOfert(db, payload, { registry, secrets: ctx.secrets })
  },
  // przeprowadzka z BaseLinkera z panelu (tryb próbny albo import; BL tylko get*, wynik w ImportRun)
  [PRZEPROWADZKA_JOB]: async (db, payload, ctx) => {
    await wykonajPrzeprowadzkeZPanelu(db, payload, { registry, secrets: ctx.secrets })
  },
  // konto przewoźnika z panelu — test połączenia (tylko odczyt, wynik w ustawieniach firmy)
  [PRZEWOZNIK_TEST_JOB]: async (db, payload, ctx) => {
    await wykonajTestKonta(db, payload, { registry, secrets: ctx.secrets })
  },
  // dane klienta po przyjęciu zamówienia (payload = sam Order.id), odczyt przez pobierzOdbiorce (ZAPIS)
  [KLIENT_ZAPIS_JOB]: async (db, payload, ctx) => {
    await wykonajZapisKlienta(db, payload, { registry, secrets: ctx.secrets })
  },
  // retencja danych klientów raz na dobę; domyślnie RAPORT (tylko licznik), USUWAJ po zmianie ustawienia firmy
  [RETENCJA_JOB]: async (db, _payload, ctx) => {
    const r = await przebiegRetencji(db, ctx.secrets.env)
    if (r.bledy) throw new Error(`retencja danych klientów: ${r.bledy} rekordów nie usunięto`)
  },
  // retencja dziennika wywołań narzędzi MCP (McpCall, 90 dni); w funkcji, nigdy przy imporcie modułu
  // przyjmowanie zamówień Empiku (lib/empik/akceptacja.ts). Konto w cieniu: tylko zdarzenie „zaakceptowałbym”;
  // konto w PRACY z kluczem mirakl.empik.zapis.v1 i włączonym zapisem: OR21. Błędy zamówień zbiorczo do Job.lastError.
  [EMPIK_AKCEPTACJA_JOB]: async (db, _payload, ctx) => {
    const r = await runEmpikAcceptance(db, { registry, secrets: ctx.secrets })
    if (r.bledy.length) throw new Error(`przyjmowanie zamówień Empik: ${r.bledy.join('; ')}`.slice(0, 4000))
  },
  // wynik importów stanów w kanale (STO02/STO03), każdy import osobno; błędy kont zbiorczo do Job.lastError
  [IMPORTY_STANOW_JOB]: async (db, _payload, ctx) => {
    const r = await przebiegImportowStanow(db, { registry, secrets: ctx.secrets })
    if (r.bledy.length) throw new Error(`wynik importów stanów: ${r.bledy.join('; ')}`.slice(0, 4000))
  },
  [MCP_LOG_JOB]: async (db) => {
    await cleanupMcpCalls(db)
  },
  'import-katalogu': async (db, payload, ctx) => {
    const p = (payload ?? {}) as { raportDir?: string; salesDays?: unknown }
    // Okno sprzedaży = payload przycięty do sufitu KATALOG_IMPORT_DNI_SPRZEDAZY (puste = 0 = bez zamówień BL).
    // Brak salesDays w payloadzie = sufit, nie 90.
    let salesDays: number
    try {
      salesDays = oknoSprzedazy(p.salesDays, dniSprzedazyZEnv(ctx.secrets.env))
    } catch (e) {
      throw new NonRetryableError('import-katalogu: ' + (e instanceof Error ? e.message : String(e)))
    }
    // Walidacja przed jakimkolwiek odczytem API: zła ścieżka, zła tabela nadpisań, brak konfiguracji = błąd od razu.
    // Raport każdej firmy w osobnym podkatalogu (id firmy).
    const dir = p.raportDir ? reportDir(ctx.secrets.env, path.join(p.raportDir, ctx.organizationId)) : null
    const c = await clientsForOrg(db, ctx.secrets) // sekrety i konfiguracja z bazy — bez sieci
    const channels = channelMapOf(c.config)
    const overrides = loadOfferOverrides(ctx.organizationId, new Set(Object.keys(channels.names ?? {})))
    // Jak w CLI: bez kluczy wFirmy nie czytamy BL ani zamówień, bo persistImport i tak odmówi.
    // Brak Empiku nie blokuje: źródło pominięte = FetchIssue brak-kluczy, kanał Empik niepełny (r3, drobna 7).
    if (c.missing.length) throw new NonRetryableError('import-katalogu: brak kluczy wFirmy: ' + c.missing.join(', ') + ' — zadanie zamknięte bez ponawiania')
    const raw = await collectSources({
      bl: c.bl,
      wfirma: c.wfirma,
      empik: c.empik,
      inventoryId: c.config.inventoryId,
      salesDays,
      wfirmaWarehouseId: c.config.wfirmaWarehouseId,
      shopStorages: c.config.shops.map((x) => x.storageId),
      channels,
    })
    const a = analyze(raw, overrides, c.config.catalog)
    const stats = await persistImport(db, raw, a)
    // lustro wFirmy z tej samej chwili co kopia BL (firma bez wFirmy, przeprowadzka z BL: nie ma czego czytać)
    if (raw.stockSource !== 'bl') await requestMirrorAfterImport(db, ctx.secrets.env)
    if (dir) {
      const rep = renderReport(raw, a, { generatedAt: new Date(), runId: stats.runId })
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'raport-mapowania.md'), rep.markdown, 'utf8')
      for (const [name, body] of Object.entries(rep.csv)) await writeFile(path.join(dir, name), '﻿' + body, 'utf8')
    }
  },
  // ─── Rdzeń stanów i rezerwacji. Bez adapterów zapisu: propagacja tylko w trybie CIEN. ───
  'rdzen-wygasanie': async (db) => {
    await runReservationExpiry(db)
    await reapStaleInvoices(db) // porzucone SENDING → UNKNOWN (rozstrzygnie find, gdy będzie adapter wFirmy)
    // e-book (zamówienie bez wysyłki) w firmie ze stanem Kompletora — spakowanie i „Odebrane” bez biura
    await bezWysylkiPrzyStanieKompletora(db)
    // alerty o fakturze BL zamykają się też bez tokenu BaseLinkera (przebieg `cien-bl-faktury` go wymaga),
    // gdy zamówienie wyszło z kolejki pakowania, zostało anulowane albo nie trzyma już towaru. Bez zmian w stanie.
    // błąd tego kroku nie oznacza wygasania rezerwacji jako nieudanego; trafia do logu workera
    try {
      await zamknijNieaktualneAlertyFakturyBl(db, new Date())
    } catch (e) {
      console.error(`[rdzen-wygasanie] samozamykanie alertów o fakturze BL: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
  'rdzen-przydzial': async (db) => {
    await processAllocateEvents(db)
    await allocationGuard(db)
  },
  'rdzen-fanout': async (db) => {
    await runFanout(db)
  },
  // konto w PRACA dostaje adapter zapisu stanów od hosta (zdolność stock.write + `zapisWlaczony`); bez
  // tego job czeka z powodem w StockSyncJob.lastError — nic nie wychodzi na kanały. Konto w cieniu: „wysłałbym”.
  // Konto po koncie: błąd jednego konta nie zatrzymuje pozostałych, zbiorczy błąd trafia do Job.lastError.
  // Nazwa zadania zostaje (harmonogram i klucze dedupe), choć wysyła też w PRACA.
  'rdzen-propagacja-cien': async (db, _payload, ctx) => {
    const errors: string[] = []
    for (const acc of await accountsToPush(db)) {
      try {
        await wyslijStanyKonta(db, acc, { registry, secrets: ctx.secrets })
      } catch (e) {
        errors.push(`${acc.channel}/${acc.channelAccountId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (errors.length) throw new Error(`propagacja: ${errors.join('; ')}`.slice(0, 4000))
  },
  // statusy i numery nadania do kanałów (plan z zamówień i zdarzeń NUMER_NADANIA_GOTOWY, potem zapis za
  // wyłącznikami konta); każdy wiersz osobno, wynik w ChannelWrite, błędy i niepewne w alertach.
  [ZAPIS_KANALOW_JOB]: async (db, _payload, ctx) => {
    await przebiegZapisuKanalow(db, { registry, secrets: ctx.secrets })
  },
  // „Przyjechał <przewoźnik>” → spakowane z numerem nadania do „Wysłane” (raport w CarrierPickupShipping)
  [ZADANIE_WYSLANE_PO_PRZYJEZDZIE]: async (db, payload, ctx) => {
    await zadanieWyslanePoPrzyjezdzie(db, payload, { env: ctx.secrets.env })
  },
  // śledzenie przesyłki (sam odczyt u przewoźnika) — paczka odebrana bez kliknięcia przyjazdu → „Wysłane”
  [ZADANIE_SLEDZENIA]: async (db, _payload, ctx) => {
    await zadanieSledzenia(db, { registry, secrets: ctx.secrets, env: ctx.secrets.env })
  },
  'rdzen-audyt': async (db) => {
    await auditInvariants(db)
    await auditStale(db)
  },
  // kolejka wywołań wFirmy (kolejka-wfirmy.ts) w cieniu — TYLKO ODCZYT stanów (lustro):
  // `odczyt` = WfirmaStockReader na WfirmaReadOnly, `faktury` i `korekty` = null (zapis w wFirmie to osobne GO, F2).
  // Blokada przebiegu na firmę i budżet wywołań (`runWfirmaQueueExclusive`, domyślnie 20 wywołań).
  // wystawianie faktur w wFirmie za wyłącznikiem firmy „Wystawiaj faktury z Kompletora”
  // (`settings.faktury.fakturyWlaczone`, program wFirma). Wyłączone = jak dotąd sam odczyt. Wyłączone lustro stanów
  // (zmienna instancji CIEN_LUSTRO_WFIRMY=0) wyłącza całe zadanie, więc wtedy faktur z Kompletora też nie ma.
  [LUSTRO_WFIRMY_JOB]: async (db, _payload, ctx) => {
    if (lustroWylaczone(ctx.secrets.env)) return
    const dok = await ustawieniaDokumentowFirmy(db)
    const fakturyWlaczone = dok.program === 'wfirma' && dok.fakturyWlaczone
    const wf = await resolveSecrets(db, WFIRMA_KEYS, ctx.secrets)
    if (!WFIRMA_KEYS.every((k) => wf[k])) {
      // firma bez wFirmy: cichy koniec co 2 min, jeden ślad w logu na proces workera
      if (!lustroBezKluczy.has(ctx.organizationId)) {
        lustroBezKluczy.add(ctx.organizationId)
        console.log(`[${LUSTRO_WFIRMY_JOB}] firma ${ctx.organizationId}: brak kluczy wFirmy — lustro stanów pominięte`)
      }
      return
    }
    lustroBezKluczy.delete(ctx.organizationId)
    const keys = { accessKey: wf['WFIRMA_ACCESS_KEY']!, secretKey: wf['WFIRMA_SECRET_KEY']!, appKey: wf['WFIRMA_APP_KEY']!, companyId: wf['WFIRMA_COMPANY_ID']! }
    const reader = new WfirmaStockReader(new WfirmaReadOnly(keys))
    const zapis = fakturyWlaczone ? new WfirmaZapis(keys) : null
    const faktury = zapis
      ? new FakturyWfirmaZapis(new WfirmaReadOnly(keys), db, {
          zapis,
          odbiorca: async (orderId) => (await odbiorcaDoCelu(db, orderId, 'FAKTURA', { modul: 'faktury', registry, secrets: ctx.secrets })).odbiorca,
        })
      : null
    // korekty faktur przy zwrotach — ten sam klient zapisu i wyłącznik co faktury (pierwsza korekta = osobne GO)
    const korekty = zapis && korektyWlaczone((await db.organization.findFirst({ select: { settings: true } }))?.settings ?? null) ? new KorektyWfirmaZapis(new WfirmaReadOnly(keys), db, { zapis }) : null
    const r = await runLustroWfirmy(db, reader, { faktury, korekty }) // bez `now`: zegar rzeczywisty, requestSentAt każdej strony osobno
    console.log(`[${LUSTRO_WFIRMY_JOB}] firma ${ctx.organizationId}: ${JSON.stringify({ ...r, ...(reader ? { odczyt: reader.stats } : {}), faktury: !!faktury })}`)
    if (faktury) {
      try {
        const n = await doWyslaniaPoFakturze(db)
        if (n) console.log(`[${LUSTRO_WFIRMY_JOB}] firma ${ctx.organizationId}: do wysłania po fakturze ${n}`)
      } catch (e) {
        console.error(`[${LUSTRO_WFIRMY_JOB}] firma ${ctx.organizationId}: do wysłania po fakturze: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // WZ w wFirmie dla zamówień wysłanych bez faktury — ten sam wyłącznik co faktury plus „WZ przy wysyłce bez
    // faktury” (sprawdzany w `wystawWzDlaWydanych`); po kolejce, gdy wFirma nie wstrzymała pracy limitem. Błąd tu nie
    // cofa przebiegu kolejki (faktury już poszły): ślad w logu, ponowienie w następnym przebiegu.
    if (zapis && !r.paused) {
      try {
        const w = await wystawWzDlaWydanych(db, dostawcaWfirmy({ wz: new WzWfirmaZapis(new WfirmaReadOnly(keys), zapis) }), { maxOrders: WZ_NA_PRZEBIEG })
        if (!w.skipped || w.issued + w.found + w.errors + w.waiting) console.log(`[${LUSTRO_WFIRMY_JOB}] firma ${ctx.organizationId}: WZ ${JSON.stringify(w)}`)
      } catch (e) {
        console.error(`[${LUSTRO_WFIRMY_JOB}] firma ${ctx.organizationId}: WZ bez faktury: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  },
  // Zlecony nocą pełny odczyt czeka w WfirmaQueueState na przebieg kolejki (`rdzen-wfirma`).
  // Raz na dobę od godziny 3, odporne na dryf i restart (`lastNightSyncAt`); oba kroki idempotentne, ślad na końcu.
  // zwroty klientów z kanałów (Allegro customer-returns) → zwrot „Nowe” z zamówieniem; tylko odczyt kanału
  [ZWROTY_KANALOW_JOB]: async (db, _payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, ZWROTY_KANALOW_JOB)) return
    const r = await odczytZwrotowKanalow(db, { registry, secrets: ctx.secrets })
    const wpisy = Object.entries(r).filter(([, s]) => 'blad' in s || s.nowe || s.pominiete || s.nieczytelne)
    if (wpisy.length) console.log(`[${ZWROTY_KANALOW_JOB}] firma ${ctx.organizationId}: ${JSON.stringify(Object.fromEntries(wpisy))}`)
  },
  // faktury i korekty do KSeF dla firm z programem „KSeF bezpośrednio” (bramka w lib/ksef/api/bramka.ts);
  // dokument po dokumencie, błąd jednego zostaje przy nim (lastError, lista faktur), ślad w logu tylko przy ruchu
  [KSEF_WYSYLKA_JOB]: async (db, _payload, ctx) => {
    // twardy limit czasu tylko tego zadania: KSeF „w toku” bez końca nie zawiesza workera
    const r = await przebiegKsefZLimitem(db, { secrets: ctx.secrets, env: ctx.secrets.env })
    if (r.wyslane + r.przyjete + r.bledy + r.porzucone + r.uzupelnione + r.ponowione + r.doRecznego || r.przerwany || r.logowanieNieudane) console.log(`[${KSEF_WYSYLKA_JOB}] firma ${ctx.organizationId}: ${JSON.stringify(r)}`)
  },
  'rdzen-noc': async (db) => {
    const now = new Date()
    if (!(await isNightSyncDue(db, now))) return
    await requestFullRead(db, { now })
    await runNightlyFullSync(db, { now })
  },
  'rdzen-kanaly-powrot': async (db) => {
    await runRecoveredFullSyncs(db)
  },
  // ─── Cień zamówień: odczyt kanałów przez adaptery, tylko odczyt; porównanie z BL ───
  'cien-zamowienia-planuj': async (db, _payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, 'cien-zamowienia-planuj')) return
    await planOrderPolls(db, registry)
  },
  [POLL_JOB]: async (db, payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, POLL_JOB)) return
    const p = (payload ?? {}) as Partial<PollJobPayload>
    const acc = (await loadChannelAccounts(db)).find((a) => a.channel === p.channel && a.channelAccountId === p.channelAccountId)
    if (!acc) return // konto wyłączone albo usunięte po zaplanowaniu
    try {
      await pollAccount(db, acc, { registry, secrets: ctx.secrets, initialLookbackMs: windowMs(ctx.secrets.env) })
    } catch (e) {
      // zła konfiguracja konta (brak klucza, adresu) jest już w ChannelCursor.lastError, a po 15 min w alercie;
      // bez FAILED co minutę w kolejce. Inne błędy odczytu idą też do Job.lastError.
      if (!(e instanceof AdapterConfigError)) throw e
    }
  },
  'cien-bl-porownanie': async (db, _payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, 'cien-bl-porownanie')) return
    const s = await resolveSecrets(db, ['BASELINKER_TOKEN'], ctx.secrets)
    // porównanie z BL to funkcja migracji z BL, nie każdej firmy: bez tokena BL cicho nic
    if (!s['BASELINKER_TOKEN']) return
    const run = await db.importRun.create({ data: { kind: 'cien-bl' } })
    try {
      const map = channelMapOf(await loadImportConfig(db))
      const r = await runBlComparison(db, new BaseLinkerReadOnly(s['BASELINKER_TOKEN']), map, await accountsForComparison(db, ctx.secrets), { windowMs: windowMs(ctx.secrets.env) })
      await db.importRun.update({
        where: { id: run.id },
        data: { status: r.blComplete ? 'OK' : 'PARTIAL', finishedAt: new Date(), stats: JSON.parse(JSON.stringify(r)), error: r.blErrors.join('; ').slice(0, 2000) || null },
      })
    } catch (e) {
      await db.importRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: (e instanceof Error ? e.message : String(e)).slice(0, 2000) } })
      throw e
    }
  },
  // ───: faktury BL, sprzedaż dnia, raport rozjazdów, przegląd otwartych ───
  [INVOICES_JOB]: async (db, _payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, INVOICES_JOB)) return
    const token = await blToken(db, ctx)
    if (!token) return
    const wf = await resolveSecrets(db, WFIRMA_KEYS, ctx.secrets)
    const wz = WFIRMA_KEYS.every((k) => wf[k])
      ? new WfirmaWzReader(new WfirmaReadOnly({ accessKey: wf['WFIRMA_ACCESS_KEY']!, secretKey: wf['WFIRMA_SECRET_KEY']!, appKey: wf['WFIRMA_APP_KEY']!, companyId: wf['WFIRMA_COMPANY_ID']! }))
      : null
    const bl = new BaseLinkerReadOnly(token)
    // para od strony faktury dla zamówień sprzed okna porównania (getOrders po numerze, tylko odczyt)
    const map = channelMapOf(await loadImportConfig(db))
    const fetchBlOrder = async (blOrderId: number) => {
      const res = await bl.call<{ orders?: Record<string, unknown>[] }>('getOrders', { order_id: blOrderId, get_unconfirmed_orders: true })
      const o = (Array.isArray(res.orders) ? res.orders : []).find((y) => Number(y?.['order_id']) === blOrderId)
      return o ? blOrderHeader(o, map) : null
    }
    // jednorazowe douczytanie faktur sprzed startu odczytu; wyłącznik instancji CIEN_FAKTURY_WSTECZ=0
    const backfillDays = ctx.secrets.env['CIEN_FAKTURY_WSTECZ'] === '0' ? 0 : INVOICES_BACKFILL_DAYS
    const startedAt = new Date()
    // zamówienia bez numeru w sklepie (przyjęte przed jego zapisem): numer odczytem ze sklepu, tylko gdy para po nim nie
    // powstała; błąd odczytu sklepu = ponowienie w następnym przebiegu (bez znacznika na fakturze)
    const registry = defaultRegistry()
    const uzupelnijNumer = async (orderId: string): Promise<WynikNumeru> => {
      const w = (await odswiezOpisZKanalu(db, orderId, { registry, secrets: ctx.secrets })).wynik
      return w === 'OK' ? 'OK' : w === 'BLAD' ? 'BLAD' : 'BRAK'
    }
    const r = await syncBlInvoices(db, bl, wz, { initialLookbackMs: windowMs(ctx.secrets.env), fetchBlOrder, uzupelnijNumer, backfillDays })
    // kompletny odczyt faktur BL (błędy pojedynczych faktur nie przeszkadzają: kopia jest pełna)
    if (r.blComplete) await zapiszUdanyPrzebieg(db, INVOICES_JOB, startedAt)
    if (r.errors.length) throw new Error(`faktury BL: ${r.errors.join('; ')}`.slice(0, 4000))
  },
  // WZ z wFirmy (tylko odczyt) — rozliczenie faktur, których rdzeń nie rozliczył (faktura sprzed cienia,
  // zamówienie bez pary z BL), i dokumenty do raportu rozjazdów. Wymaga lustra wFirmy i kluczy; bez nich cicho nic.
  [WZ_JOB]: async (db, _payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, WZ_JOB) || lustroWylaczone(ctx.secrets.env)) return
    const wf = await resolveSecrets(db, WFIRMA_KEYS, ctx.secrets)
    if (!WFIRMA_KEYS.every((k) => wf[k])) return
    const src = new WfirmaWzZrodlo(new WfirmaReadOnly({ accessKey: wf['WFIRMA_ACCESS_KEY']!, secretKey: wf['WFIRMA_SECRET_KEY']!, appKey: wf['WFIRMA_APP_KEY']!, companyId: wf['WFIRMA_COMPANY_ID']! }))
    // firma z BL (token) — wiązanie po pozycjach tylko po kompletnym odczycie faktur BL; bez BL od razu
    const fakturyBl = (await blToken(db, ctx)) ? { ostatniOk: await ostatniUdanyPrzebieg(db, INVOICES_JOB) } : null
    const r = await syncWfirmaWz(db, src, { fakturyBl })
    if (r.errors.length) throw new Error(`WZ wFirmy: ${r.errors.join('; ')}`.slice(0, 4000))
  },
  // Harmonogram (bez payloadu): zamyka wczorajszy dzień po północy, raz. Na żądanie: { day: "dzis" | "RRRR-MM-DD" }.
  'cien-sprzedaz-dnia': async (db, payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, 'cien-sprzedaz-dnia')) return
    const now = new Date()
    const token = await blToken(db, ctx)
    if (!token) return
    let day = payloadDay(payload, 'cien-sprzedaz-dnia', now)
    if (!day) {
      day = dayToClose(now)
      if (!day || (await db.shadowDailyCheck.count({ where: { kind: SALES_CHECK, day, final: true } }))) return
    }
    const map = channelMapOf(await loadImportConfig(db))
    await runDaySalesCheck(db, new BaseLinkerReadOnly(token), map, await accountsForComparison(db, ctx.secrets), { day, now })
  },
  // Raport za wczoraj, gdy sprzedaż dnia jest zamknięta (albo 3 h po północy bez niej, wtedy przeliczany po zamknięciu
  // sprzedaży); plik w RAPORTY_DIR.
  'cien-raport-rozjazdow': async (db, payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, 'cien-raport-rozjazdow')) return
    const now = new Date()
    let day = payloadDay(payload, 'cien-raport-rozjazdow', now)
    if (!day) {
      const yesterday = addDays(toWarsaw(now).day, -1)
      const existing = await db.shadowDailyCheck.findFirst({ where: { kind: REPORT_CHECK, day: yesterday }, select: { stats: true } })
      const salesClosed = (await db.shadowDailyCheck.count({ where: { kind: SALES_CHECK, day: yesterday, final: true } })) > 0
      // raport z 3 h po północy bez zamkniętej sprzedaży dnia przelicza się, gdy sprzedaż zamknie się później (przegląd
      // dzień z błędem BL zostaje otwarty — wiersz `final: false`, w raporcie sprzedaż jest, ale nieostateczna —
      // i ponawia się co godzinę); poza tym jeden raport na dzień
      if (existing && (!salesClosed || (existing.stats as { sales?: { final?: boolean } | null } | null)?.sales?.final === true)) return
      if (!salesClosed && now.getTime() - warsawDay(yesterday).to.getTime() < 3 * 3600_000) return
      // zlecony pełny odczyt lustra (po imporcie katalogu) najpierw — stany BL i wFirmy z tej samej chwili
      // przy wyłączonym lustrze nikt nie zdejmie znacznika `fullReadDueSince` (zlecenie nocne), więc bez czekania
      if (!lustroWylaczone(ctx.secrets.env) && reportWaitsForMirror(await db.wfirmaQueueState.findFirst({ select: { fullReadDueSince: true } }), yesterday, now)) return
      day = yesterday
    }
    const r = await buildDailyReport(db, day, now)
    await saveDailyReport(db, r, now)
    await alertOfficeItems(db, r) // jeden alert „Dla biura” na dzień raportu (dedupe z dniem)
    const dir = reportDir(ctx.secrets.env, path.join('rozjazdy', ctx.organizationId))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `rozjazdy-${day}.md`), renderDailyReport(r), 'utf8')
  },
  [REVIEW_JOB]: async (db, _payload, ctx) => {
    if (cienWylaczony(ctx.secrets.env, REVIEW_JOB)) return
    const r = await reviewOpenOrders(db, { registry, secrets: ctx.secrets, staleMs: reviewStaleMs(ctx.secrets.env) })
    if (r.errors.length) throw new Error(`przegląd otwartych: ${r.errors.join('; ')}`.slice(0, 4000))
  },
}
