// Jedna kolejka wywołań wFirmy na firmę (spec 3.4, 8.1; przypadek 44c). Ten sam klucz API wystawia faktury i czyta
// stany, a limit wFirmy jest wspólny i ruchomy, więc wszystko idzie jednym torem z priorytetem:
//   1. faktury i korekty (rozstrzyganie timeoutów przez `find`, nowe dokumenty),
//   2. ponowienia odczytu WZ (2.2 pkt 5 v1.5), odczyty celowane (zdarzenia WFIRMA_READ), pełny odczyt, raport magazynów.
// Pełny odczyt czeka na faktury najwyżej 30 min — potem jedna jego strona idzie w każdym przebiegu przed fakturami.
// Błąd limitu wstrzymuje CAŁĄ kolejkę firmy (stan w `WfirmaQueueState`, przeżywa restart workera) na 5 min albo tyle,
// ile podała wFirma; każde żądanie w trakcie blokady mogłoby ją przedłużyć.
// Kolejka nie trzyma zadań w pamięci: każdy przebieg wylicza pracę z bazy (spakowane bez faktury, korekty, outbox).
// Zapis w wFirmie: bez adaptera zapisu (`api.faktury`/`api.korekty` puste) kolejka tylko czyta. Faktury podaje worker
// za wyłącznikiem firmy (lib/wfirma/adapter-zapis.ts), korekty za osobnym wyłącznikiem „Korekty faktur przy
// zwrotach z Kompletora” (lib/wfirma/korekta-zapis.ts), obie tylko dla zamówień kont w trybie Aktywny.
// W testach wyłącznie atrapy.
import type { Channel, OrderStatus, Prisma, WfirmaQueueState } from '@prisma/client'
import { organizationIdOf } from '../db'
import { applyStockPage, applyStockRead } from './lustro'
import { flagsOf } from './rezerwacja'
import { finishWithoutShipping } from './przejscia'
import { parseUstawieniaDokumentow, statusyMomentu } from '../dokumenty/ustawienia'
import { type CallBudget, checkFindFilter, type FakturyWfirma, issueDocument, issueInvoice, PackError, packOrder, resolveUnknownInvoices, resolveWzReads, WfirmaLimitError } from './rozchod'
import { alert, type Db, DEFAULT_WAREHOUSE, type Tx } from './stan'
import { TransitionError } from './statusy'
import { fakturaZBl, FAKTURA_BL_POMINIETA, oznaczPominietaFaktureBl } from './faktura-bl'
import { zrodloZMagazynu } from './zrodlo-stanu'
import { recordOrderError } from './zamowienia'
import { correctionPrefix, issueCorrection, type KorektyWfirma, resolveUnknownCorrections } from './zwroty'

export interface GoodCount {
  wfirmaGoodId: string
  /** `count` z wFirmy w jej jednostce (szt. albo kg) — przeliczenie na jednostkę bazową robi kolejka. */
  count: number
}

export interface OdczytStanowWfirma {
  /** goods/get (albo find po id) dla wskazanych towarów, z jawnym `warehouse_id` w zapytaniu (8.1). */
  readGoods(goodIds: string[], warehouseId: string): Promise<GoodCount[]>
  /** Strona pełnego odczytu goods/find (1…), z jawnym `warehouse_id` (8.1). */
  readGoodsPage(page: number, warehouseId: string): Promise<{ items: GoodCount[]; last: boolean }>
  /** Raport dzienny (8.1): niezerowe stany na magazynach innych niż skonfigurowany. Brak metody = bez raportu. */
  readOtherWarehouses?(exceptWarehouseId: string): Promise<{ warehouseId: string; wfirmaGoodId: string; count: number }[]>
}

export interface WfirmaApi {
  faktury?: FakturyWfirma | null
  korekty?: KorektyWfirma | null
  odczyt?: OdczytStanowWfirma | null
}

export const LIMIT_PAUSE_MS = 5 * 60_000 // „AUTH FAILED LIMIT WAIT 5 MINUTES”
export const FULL_READ_MAX_DEFER_MS = 30 * 60_000
const FIND_CHECK_EVERY_MS = 24 * 3600_000
const FIND_CHECK_RETRY_MS = 3600_000
const OTHER_WH_REPORT_EVERY_MS = 24 * 3600_000
const READ_BATCH = 20
/** Towar nieobecny w odpowiedzi goods/get (skasowany, przeniesiony): po tylu próbach zdarzenie zamykane z alertem. */
export const MISSING_GOOD_MAX_TRIES = 5
/** Po zamknięciu nowe zdarzenia tego towaru zamykane od razu przez dobę (bez wywołań), potem jedna nowa seria prób. */
const MISSING_GOOD_QUIET_MS = 24 * 3600_000
const MISSING_GOOD_ERR = 'brak towaru w odpowiedzi wFirmy'
const MISSING_GOOD_GAVE_UP = 'brak towaru w odpowiedzi wFirmy — zamknięte po próbach (alert WFIRMA_BRAK_TOWARU)'
/** Znacznik zamknięcia po próbach niesie towar wFirmy: poprawione powiązanie produktu kończy ciszę od razu. */
const missingGoodGaveUp = (goodId: string) => `${MISSING_GOOD_GAVE_UP} [${goodId}]`
/** Zdarzenia zamykane w ciszy po alercie — osobny znacznik, żeby nie odnawiały doby ciszy. */
const MISSING_GOOD_SKIPPED = 'brak towaru w odpowiedzi wFirmy — pominięte (cisza po alercie)'
/** Odczyt przyszedł, ale nie dał się zapisać: po tylu próbach zdarzenie zamykane z alertem; poprawi pełny odczyt. */
export const READ_APPLY_MAX_TRIES = 5
/** Przebieg, który padł bez zwolnienia (zabity worker), blokuje firmę najwyżej tyle. Żywy odnawia przed każdym wywołaniem. */
export const RUN_LEASE_MS = 10 * 60_000
/** Mniej niż tyle: sonda `find` z dokumentem (2 wywołania) nie weszłaby w budżet i timeouty stałyby bez alertu. */
export const MIN_CALLS_PER_RUN = 2
const DEFAULT_CALLS_PER_RUN = 20

export interface QueueStats {
  paused: boolean
  /** dokumenty bez rozchodu (magazyn prowadzi Kompletor) wysłane w tym przebiegu. */
  documents?: number
  pausedUntil?: Date
  calls: number
  invoices: number
  corrections: number
  targetedReads: number
  fullReadPages: number
  fullReadDone: boolean
  findCheck?: boolean
  findCheckCorr?: boolean
  otherWarehouses?: { warehouseId: string; wfirmaGoodId: string; count: number }[]
}

/** Zlecenie pełnego odczytu (noc, po awarii, ręcznie). Termin oczekiwania liczy się od pierwszego zlecenia. */
export async function requestFullRead(db: Db, ctx: { now?: Date } = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const s = await loadState(db)
  if (!s.fullReadDueSince) await db.wfirmaQueueState.update({ where: { organizationId: s.organizationId }, data: { fullReadDueSince: now, fullReadPage: 0 } })
}

/**
 * zlecenie pełnego odczytu w transakcji wywołującego (zmiana źródła stanu na lustro
 * wFirmy) — przełączenie i zlecenie wchodzą razem albo wcale. Firma podana jawnie, bo klient transakcji nie niesie firmy.
 */
export async function requestFullReadInTx(tx: Tx, organizationId: string, now: Date): Promise<void> {
  const s = await tx.wfirmaQueueState.upsert({ where: { organizationId }, create: { organizationId }, update: {} })
  if (!s.fullReadDueSince) await tx.wfirmaQueueState.update({ where: { organizationId }, data: { fullReadDueSince: now, fullReadPage: 0 } })
}

async function loadState(db: Db): Promise<WfirmaQueueState> {
  // upsert: dwa pierwsze przebiegi naraz nie dają P2002 na PK = organizationId
  const organizationId = organizationIdOf(db)
  return db.wfirmaQueueState.upsert({ where: { organizationId }, create: { organizationId }, update: {} })
}

class Budget implements CallBudget {
  constructor(public left: number) {}
  take(): boolean {
    if (this.left <= 0) return false
    this.left--
    return true
  }
}

/** Liczy wywołania adaptera (stat. przebiegu); limit wFirmy przechodzi dalej jako WfirmaLimitError. */
function counted<T extends object>(api: T, stats: QueueStats, beforeCall?: () => Promise<void>): T {
  return new Proxy(api, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (typeof v !== 'function') return v
      return async (...args: unknown[]) => {
        stats.calls++
        await beforeCall?.()
        return (v as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

/**
 * Jeden przebieg kolejki firmy. `maxCalls` — ile wywołań wFirmy najwyżej w przebiegu (etapy sprawdzają budżet
 * przed każdym wywołaniem, także `find` i odczytem WZ; czego nie objął, idzie w następnym przebiegu).
 * Worker woła `runWfirmaQueueExclusive`.
 */
/**
 * `tylkoPraca`: faktury tylko dla zamówień kont w PRACA. Worker z prawdziwym adapterem zapisu podaje je
 * zawsze: zamówienie konta w podglądzie prowadzi BaseLinker i to on wystawia jego fakturę (inaczej dwie faktury).
 */
export async function runWfirmaQueue(db: Db, api: WfirmaApi, ctx: { now?: Date; clock?: () => Date; maxCalls?: number; warehouseId?: string; beforeCall?: () => Promise<void>; tylkoPraca?: boolean } = {}): Promise<QueueStats> {
  const now = ctx.now ?? new Date()
  const clock = ctx.clock ?? (ctx.now ? () => now : () => new Date())
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const stats: QueueStats = { paused: false, calls: 0, invoices: 0, corrections: 0, targetedReads: 0, fullReadPages: 0, fullReadDone: false }
  let state = await loadState(db)
  if (state.pausedUntil && state.pausedUntil > now) return { ...stats, paused: true, pausedUntil: state.pausedUntil }
  if (state.pausedUntil) state = await db.wfirmaQueueState.update({ where: { organizationId: state.organizationId }, data: { pausedUntil: null, pauseReason: null } })
  const budget = new Budget(ctx.maxCalls ?? DEFAULT_CALLS_PER_RUN)
  const warehouse = await db.warehouse.findFirst({ where: { id: wh }, select: { wfirmaWarehouseId: true, stockSource: true } })
  // firma z kluczami wFirmy bez wiersza magazynu — alert zamiast cichego przebiegu
  if (!warehouse && (api.faktury || api.korekty || api.odczyt)) {
    await alert(db, 'WFIRMA_BRAK_MAGAZYNU', wh, `Firma nie ma magazynu „${wh}”: kolejka wFirmy nic nie robi (ani odczytów, ani faktur). Załóż magazyn w ustawieniach firmy.`, `wfirma-brak-wiersza-magazynu:${wh}`)
    return stats
  }
  // kolejka wFirmy tylko przy źródle WFIRMA — ta sama reguła co rdzeń (zrodloZMagazynu).
  const lustro = zrodloZMagazynu(warehouse) === 'WFIRMA'
  const faktury = api.faktury && lustro ? counted(api.faktury, stats, ctx.beforeCall) : null
  const korekty = api.korekty && lustro ? counted(api.korekty, stats, ctx.beforeCall) : null
  const odczyt = api.odczyt && lustro ? counted(api.odczyt, stats, ctx.beforeCall) : null
  const wfWh = warehouse?.wfirmaWarehouseId ?? null
  if (odczyt && !wfWh)
    await alert(db, 'WFIRMA_BRAK_MAGAZYNU', wh, `Magazyn „${wh}” bez wfirmaWarehouseId — odczyt stanów wstrzymany (8.1: tylko z jawnym warehouse_id)`, `wfirma-brak-magazynu:${wh}`)
  const reader = odczyt && wfWh ? odczyt : null
  const ctxNow = { now, clock }
  const konta = ctx.tylkoPraca ? await pracaAccounts(db) : null
  // prawdziwy zapis (worker, `tylkoPraca`) bierze tylko zamówienia spakowane po włączeniu
  // „Wystawiaj faktury z Kompletora”. Zaległe spakowane sprzed tej chwili biuro fakturuje jak dotąd (licznik na ekranie
  // Dokumenty sprzedaży). Bez chwili włączenia = żadnej nowej faktury. Atrapy w testach rdzenia: bez bramki.
  const fakturyOd = ctx.tylkoPraca ? await chwilaWlaczeniaFaktur(db) : undefined
  // magazyn prowadzony przez Kompletor + program wFirma z włączonym wystawianiem = dokument bez rozchodu
  // przy statusie z „wystawiaj przy” (i tylko na żądanie klienta, jeśli tak ustawiono). Ten sam adapter i ten sam tor
  // rozstrzygania timeoutów co faktura z rozchodem; bez WZ i bez odczytów stanu.
  const tor = !lustro && api.faktury ? await torDokumentow(db) : null
  const dokumenty = tor ? counted(api.faktury!, stats, ctx.beforeCall) : null

  // przy prawdziwym zapisie (`tylkoPraca`) korekty tylko dla zamówień kont w trybie Aktywny (jak faktury);
  // zwrot konta w podglądzie czeka w „W trakcie” bez wywołania wFirmy (korekta poza Kompletorem); żadnego konta
  // w trybie Aktywny = brak nowych korekt (null, bez zapytania)
  const korektyGdzie: Prisma.ReturnWhereInput | null =
    konta && !konta.length ? null : { status: 'KOREKTA', correctionState: null, ...(konta ? { order: { OR: konta.map((k) => ({ channel: k.channel, channelAccountId: k.channelAccountId })) } } : {}) }
  const urgentWork = async () =>
    (faktury ? await pendingInvoices(db, 1, konta, fakturyOd) : []).length > 0 || (korekty && korektyGdzie ? await db.return.count({ where: korektyGdzie }) : 0) > 0

  try {
    // 0. Pełny odczyt czekający ≥ 30 min: jedna strona przed fakturami, żeby ciągły strumień faktur go nie zagłodził.
    if (reader && state.fullReadDueSince && now.getTime() - state.fullReadDueSince.getTime() >= FULL_READ_MAX_DEFER_MS && budget.take())
      state = await fullReadPage(db, reader, wfWh!, state, stats, ctxNow)

    // 1. Faktury: rozstrzyganie timeoutów (po teście filtra find), potem nowe faktury spakowanych zamówień.
    if (faktury) {
      if (await db.invoiceAttempt.count({ where: { state: { in: ['UNKNOWN', 'SENDING'] } } })) {
        const c = await ensureFindCheck(db, state, 'FV', (p) => faktury.findByPrefix(p), () => knownInvoice(db), stats, now, budget)
        state = c.state
        if (c.ok) await resolveUnknownInvoices(db, faktury, { ...ctxNow, budget })
      }
      await packWithoutShipping(db, now)
      for (const orderId of await pendingInvoices(db, 100, konta, fakturyOd)) {
        if (!budget.take()) break
        let retryAfterMs: number | undefined
        const r = await issueInvoice(db, orderId, faktury, { ...ctxNow, onLimit: (ms) => (retryAfterMs = ms) })
        if (r === 'LIMIT') throw new WfirmaLimitError('limit wFirmy przy wystawianiu faktury', retryAfterMs)
        if (r === 'WYSTAWIONA' || r === 'TIMEOUT' || r === 'BLAD') stats.invoices++
      }
      await finishAfterInvoice(db, clock())
    }
    // 1a. Dokumenty bez rozchodu: rozstrzyganie timeoutów, potem nowe dokumenty zamówień po momencie.
    if (dokumenty && tor) {
      stats.documents = 0
      if (await db.invoiceAttempt.count({ where: { documentOnly: true, state: { in: ['UNKNOWN', 'SENDING'] } } })) {
        const c = await ensureFindCheck(db, state, 'FV', (p) => dokumenty.findByPrefix(p), () => knownInvoice(db), stats, now, budget)
        state = c.state
        if (c.ok) await resolveUnknownInvoices(db, dokumenty, { ...ctxNow, budget, dokumentStatusy: tor.statusy })
      }
      for (const orderId of await pendingDocuments(db, tor, 100, konta)) {
        if (!budget.take()) break
        let retryAfterMs: number | undefined
        const r = await issueDocument(db, orderId, dokumenty, { ...ctxNow, statusy: tor.statusy, onLimit: (ms) => (retryAfterMs = ms) })
        if (r === 'LIMIT') throw new WfirmaLimitError('limit wFirmy przy wystawianiu faktury', retryAfterMs)
        if (r === 'WYSTAWIONA' || r === 'TIMEOUT' || r === 'BLAD') stats.documents++
      }
    }
    // 1b. Korekty (zwroty, anulowanie po fakturze, brakujące pozycje).
    if (korekty) {
      if (await db.return.count({ where: { status: 'KOREKTA', correctionState: { in: ['UNKNOWN', 'SENDING'] } } })) {
        const c = await ensureFindCheck(db, state, 'KOR', (p) => korekty.findCorrectionsByPrefix(p), () => knownCorrection(db), stats, now, budget)
        state = c.state
        if (c.ok) await resolveUnknownCorrections(db, korekty, { ...ctxNow, budget })
      }
      const waiting = korektyGdzie ? await db.return.findMany({ where: korektyGdzie, orderBy: { updatedAt: 'asc' }, take: 100, select: { id: true } }) : []
      for (const r of waiting) {
        if (!budget.take()) break
        let retryAfterMs: number | undefined
        const out = await issueCorrection(db, r.id, korekty, { ...ctxNow, onLimit: (ms) => (retryAfterMs = ms) })
        if (out === 'LIMIT') throw new WfirmaLimitError('limit wFirmy przy wystawianiu korekty', retryAfterMs)
        if (out === 'WYSTAWIONA' || out === 'TIMEOUT' || out === 'BLAD') stats.corrections++
      }
    }
    // 2. Ponowienia odczytu WZ faktur (2.2 pkt 5 v1.5).
    if (faktury && budget.left > 0) await resolveWzReads(db, faktury, { ...ctxNow, budget })
    // 3. Odczyty celowane (po fakturze, korekcie, kliknięciu biura).
    if (reader) await targetedReads(db, reader, wfWh!, budget, stats, ctxNow)
    // 4. Pełny odczyt: gdy nic pilnego nie czeka (albo czekał już 30 min — wtedy strona poszła w kroku 0).
    if (reader && state.fullReadDueSince && !(await urgentWork()))
      while (state.fullReadDueSince && budget.take()) state = await fullReadPage(db, reader, wfWh!, state, stats, ctxNow)
    // 5. Raport dzienny stanów na pozostałych magazynach (8.1).
    if (reader?.readOtherWarehouses && (!state.otherWhReportAt || now.getTime() - state.otherWhReportAt.getTime() >= OTHER_WH_REPORT_EVERY_MS) && budget.take())
      state = await otherWarehousesReport(db, reader, wfWh!, state, stats, now)
  } catch (e) {
    if (!(e instanceof WfirmaLimitError)) throw e
    const until = new Date(now.getTime() + (e.retryAfterMs ?? LIMIT_PAUSE_MS))
    await db.wfirmaQueueState.update({ where: { organizationId: state.organizationId }, data: { pausedUntil: until, pauseReason: e.message.slice(0, 500) } })
    await alert(db, 'WFIRMA_LIMIT', 'wfirma', `Limit wFirmy: kolejka wywołań wstrzymana do ${until.toISOString()} (${e.message})`.slice(0, 1000), `wfirma-limit:${now.toISOString().slice(0, 10)}`)
    return { ...stats, paused: true, pausedUntil: until }
  }
  return stats
}

/**
 * Przebieg kolejki pod blokadą firmy (część 1): dwa równoległe przebiegi nie liczą budżetu podwójnie i nie dublują
 * `find`. Dzierżawa w `WfirmaQueueState`, nie blokada doradcza: ta żyje w transakcji, a przebieg czeka na wFirmę poza
 * transakcją. Padnięty worker oddaje firmę po `RUN_LEASE_MS`, żywy odnawia dzierżawę przed każdym wywołaniem wFirmy
 * (przebieg przy wolnej wFirmie trwa dłużej niż dzierżawa). Drugi przebieg kończy się od razu (`skipped`).
 */
export async function runWfirmaQueueExclusive(db: Db, api: WfirmaApi, ctx: Parameters<typeof runWfirmaQueue>[2] = {}): Promise<QueueStats & { skipped?: true }> {
  const now = ctx.now ?? new Date()
  const { organizationId } = await loadState(db)
  const runLockId = globalThis.crypto.randomUUID()
  const got = await db.wfirmaQueueState.updateMany({
    where: { organizationId, OR: [{ runLockUntil: null }, { runLockUntil: { lte: now } }] },
    data: { runLockId, runLockUntil: new Date(now.getTime() + RUN_LEASE_MS) },
  })
  if (!got.count) return { paused: false, calls: 0, invoices: 0, corrections: 0, targetedReads: 0, fullReadPages: 0, fullReadDone: false, skipped: true }
  const clock = ctx.clock ?? (ctx.now ? () => now : () => new Date())
  const renew = async () => {
    try {
      await db.wfirmaQueueState.updateMany({ where: { organizationId, runLockId }, data: { runLockUntil: new Date(clock().getTime() + RUN_LEASE_MS) } })
    } catch (e) {
      console.error(`[wfirma] odnowienie dzierżawy: ${(e as Error).message}`) // nie przerywa wywołania: dzierżawa jeszcze trwa
    }
  }
  try {
    return await runWfirmaQueue(db, api, { ...ctx, maxCalls: Math.max(MIN_CALLS_PER_RUN, ctx.maxCalls ?? DEFAULT_CALLS_PER_RUN), beforeCall: renew })
  } finally {
    await db.wfirmaQueueState.updateMany({ where: { organizationId, runLockId }, data: { runLockId: null, runLockUntil: null } })
  }
}

/**
 * Spakowane zamówienia bez faktury w toku ani wystawionej, bez flagi błędu (po błędzie decyduje obsługa). Bez
 * rezerwacji ACTIVE także zamówienie z pozycją bez stanu (e-book jako usługa, zamówienie bez wysyłki).
 */
async function pendingInvoices(db: Db, take: number, konta: { channel: Channel; channelAccountId: string }[] | null = null, od?: Date | null): Promise<string[]> {
  if (konta && !konta.length) return []
  if (od === null) return []
  const digital = (await db.product.findMany({ where: { kind: 'DIGITAL' }, select: { id: true } })).map((p) => p.id)
  const rows = await db.order.findMany({
    where: {
      status: 'SPAKOWANE',
      AND: [
        ...(konta ? [{ OR: konta }] : []),
        ...(od ? [{ events: { some: { kind: 'SPAKOWANE', createdAt: { gte: od } } } }] : []),
        // zamówienie z fakturą BL raz odrzucone przez rdzeń (faktura-bl.ts) nie zajmuje miejsca w kolejnych przebiegach
        { events: { none: { kind: FAKTURA_BL_POMINIETA } } },
      ],
      invoices: { none: { state: { in: ['SENDING', 'UNKNOWN', 'ISSUED'] } } },
      OR: [
        { reservations: { some: { state: 'ACTIVE' } } },
        ...(digital.length ? [{ lines: { some: { removed: false, productId: { in: digital } } } }] : []),
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: take + 50,
    select: { id: true, flags: true },
  })
  return rows.filter((r) => !flagsOf(r).fakturaBlad).slice(0, take).map((r) => r.id)
}

/** Chwila włączenia „Wystawiaj faktury z Kompletora”; null = wyłączone albo bez chwili. */
async function chwilaWlaczeniaFaktur(db: Db): Promise<Date | null> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const u = parseUstawieniaDokumentow(org?.settings ?? null, { maWfirme: false })
  // włączone bez chwili włączenia (ustawienia ze skryptu albo seeda) = żadnej faktury;
  // ślad w alertach zamiast ciszy. Formularz zawsze zapisuje chwilę.
  if (u.fakturyWlaczone && !u.fakturyWlaczoneOd)
    await alert(db, 'WFIRMA_KONFIGURACJA', 'faktury', '„Wystawiaj faktury z Kompletora” jest włączone bez daty włączenia: Kompletor nie wystawi żadnej faktury. Zapisz ekran Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży jeszcze raz.', 'faktury-bez-chwili-wlaczenia')
  return u.fakturyWlaczone && u.fakturyWlaczoneOd ? new Date(u.fakturyWlaczoneOd) : null
}

interface TorDokumentow {
  statusy: OrderStatus[]
  tylkoNaZadanie: boolean
  od: Date
}

/** Ustawienia toru dokumentów bez rozchodu albo null (program inny niż wFirma, wystawianie wyłączone, brak chwili włączenia). */
async function torDokumentow(db: Db): Promise<TorDokumentow | null> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const u = parseUstawieniaDokumentow(org?.settings ?? null, { maWfirme: false })
  if (u.program !== 'wfirma' || !u.fakturyWlaczone || !u.fakturyWlaczoneOd) return null
  return { statusy: statusyMomentu(u.wystawiajPrzy), tylkoNaZadanie: u.tylkoNaZadanie, od: new Date(u.fakturyWlaczoneOd) }
}

/**
 * Zamówienia do dokumentu bez rozchodu: status na drodze od momentu do klienta, który zamówienie osiągnęło po włączeniu
 * wystawiania (zdarzenie statusu po `od`, bez zaległości sprzed włączenia), bez dokumentu w toku ani wystawionego, bez
 * flagi błędu (po błędzie decyduje obsługa: „Ponów fakturę”). „Tylko na żądanie” = zamówienia z prośbą o fakturę.
 */
async function pendingDocuments(db: Db, t: TorDokumentow, take: number, konta: { channel: Channel; channelAccountId: string }[] | null): Promise<string[]> {
  if (konta && !konta.length) return []
  const rows = await db.order.findMany({
    where: {
      status: { in: t.statusy },
      AND: [
        ...(konta ? [{ OR: konta }] : []),
        { events: { none: { kind: FAKTURA_BL_POMINIETA } } },
        // paczka dodatkowa (podział, „dośle później”) nie ma własnej prośby o fakturę: liczy się zamówienie główne
        ...(t.tylkoNaZadanie ? [{ OR: [{ wantInvoiceNip: true }, { parentOrderId: { not: null } }] }] : []),
      ],
      invoices: { none: { state: { in: ['SENDING', 'UNKNOWN', 'ISSUED'] } } },
      events: { some: { kind: { in: t.statusy }, createdAt: { gte: t.od } } },
    },
    orderBy: { updatedAt: 'asc' },
    take: take + 50,
    select: { id: true, flags: true, wantInvoiceNip: true, parentOrderId: true },
  })
  const rodzice = t.tylkoNaZadanie ? rows.flatMap((r) => (r.parentOrderId && !r.wantInvoiceNip ? [r.parentOrderId] : [])) : []
  const chca = new Set(rodzice.length ? (await db.order.findMany({ where: { id: { in: rodzice }, wantInvoiceNip: true }, select: { id: true } })).map((x) => x.id) : [])
  return rows
    .filter((r) => !flagsOf(r).fakturaBlad && (!t.tylkoNaZadanie || r.wantInvoiceNip || (r.parentOrderId !== null && chca.has(r.parentOrderId))))
    .slice(0, take)
    .map((r) => r.id)
}

/**
 * Konta kanałów w PRACA (statusy prowadzi Kompletor). Automat bez wysyłki działa tylko tam: na koncie w cieniu
 * zamówienie prowadzi BaseLinker, a reszta kolejki na tryb konta nie patrzy.
 */
async function pracaAccounts(db: Db): Promise<{ channel: Channel; channelAccountId: string }[]> {
  return db.channelConfig.findMany({ where: { statusMode: 'PRACA' }, select: { channel: true, channelAccountId: true } })
}

/** Zamówienia z co najmniej jedną usługą do faktury: pozycja DIGITAL, nieusunięta, `qty > qtyRejected` (jak `serviceUnits` w rozchodzie). */
async function digitalProductIds(db: Db): Promise<string[]> {
  return (await db.product.findMany({ where: { kind: 'DIGITAL' }, select: { id: true } })).map((p) => p.id)
}

async function withServiceUnits(db: Db, ids: string[], digital: string[]): Promise<Set<string>> {
  if (!ids.length || !digital.length) return new Set()
  const lines = await db.orderLine.findMany({ where: { orderId: { in: ids }, removed: false, productId: { in: digital } }, select: { orderId: true, qty: true, qtyRejected: true } })
  return new Set(lines.filter((l) => l.qty > l.qtyRejected).map((l) => l.orderId))
}

/**
 * Zamówienie bez wysyłki: opłacone (DO_REALIZACJI) nie czeka na zbieranie ani pakowanie — spakowane od
 * razu, żeby faktura usługi poszła w tym samym przebiegu. Odmowa `packOrder` (np. otwarty brak) = zostaje bez zmian.
 * Wybór po towarze, nie po przewoźniku: sam e-book (BEZ_WYSYLKI) i zamówienie mieszane, w którym
 * cały towar odrzucono (przewoźnik paczki, np. PACZKOMATY). Bez rezerwacji ACTIVE: towar dołożony edycją w kanale ktoś
 * musi zebrać, automat go nie pakuje. Bez otwartych braków: towar ma jeszcze przyjść (Woo „dośle później” zostaje).
 * Tylko konta w PRACA.
 */
async function packWithoutShipping(db: Db, now: Date): Promise<number> {
  const konta = await pracaAccounts(db)
  if (!konta.length) return 0
  // pozycja usługi w `where` przed `take`, żeby setka starszych zamówień bez e-booka (np. Empik
  // z całym towarem odrzuconym) nie zasłoniła nowszych z e-bookiem. `qty > qtyRejected` (dwie kolumny) dalej w TS.
  const digital = await digitalProductIds(db)
  if (!digital.length) return 0
  const rows = await db.order.findMany({
    where: {
      status: 'DO_REALIZACJI',
      pendingAction: null,
      OR: konta,
      reservations: { none: { state: 'ACTIVE' } },
      shortages: { none: { state: { in: ['OPEN', 'SHIP_LATER'] } } },
      lines: { some: { removed: false, productId: { in: digital } } },
      events: { none: { kind: { in: ['FAKTURA_BL', FAKTURA_BL_POMINIETA] } } },
    },
    orderBy: { createdAtChannel: 'asc' },
    take: 100,
    select: { id: true, blOrderId: true, parentOrderId: true },
  })
  const uslugi = await withServiceUnits(db, rows.map((r) => r.id), digital)
  let spakowane = 0
  for (const row of rows) {
    const { id } = row
    if (!uslugi.has(id)) continue
    try {
      // Zamówienie z fakturą BL (np. sprzed przejścia z BaseLinkera): automat go nie pakuje, bo spakowanie otworzyłoby
      // drogę do drugiej faktury; ślad w historii wyklucza je z kolejnych przebiegów.
      const numer = await fakturaZBl(db, row)
      if (numer !== null) {
        await oznaczPominietaFaktureBl(db, id, numer, 'system:bez-wysylki')
        continue
      }
      await packOrder(db, id, { now, actorId: 'system:bez-wysylki' })
      spakowane++
    } catch (e) {
      if (!(e instanceof PackError)) await recordOrderError(db, id, e)
    }
  }
  return spakowane
}

/**
 * Zamówienie bez wysyłki po wystawionej fakturze → ODEBRANE (status końcowy bez kuriera). Bez warunku
 * przewoźnika: decyduje brak towaru w zamówieniu. Tylko konta w PRACA.
 */
async function finishAfterInvoice(db: Db, now: Date): Promise<void> {
  const konta = await pracaAccounts(db)
  if (!konta.length) return
  const rows = await db.order.findMany({
    where: {
      status: 'SPAKOWANE',
      pendingAction: null,
      OR: konta,
      invoices: { some: { state: 'ISSUED' } },
      // ten sam warunek co `goods` w powodOdmowy: zamówienia z towarem i tak czekają na „Do wysyłki”
      reservations: { none: { state: { in: ['ACTIVE', 'CONSUMING', 'CONSUMED'] } } },
    },
    orderBy: { updatedAt: 'asc' },
    take: 100,
    select: { id: true },
  })
  for (const { id } of rows) {
    try {
      await finishWithoutShipping(db, id, { now, actorId: 'system:bez-wysylki' })
    } catch (e) {
      if (!(e instanceof TransitionError)) await recordOrderError(db, id, e)
    }
  }
}

/**
 * (paczka, e-book w firmie bez programu do faktur): magazyn prowadzony przez Kompletor nie ma przebiegu
 * kolejki wFirmy z fakturą, więc automat zamówień bez wysyłki (jak w kolejce: `packWithoutShipping` i zamknięcie) chodzi
 * tutaj, w zadaniu workera `rdzen-wygasanie`. Spakowanie od razu po opłaceniu; „Odebrane”:
 * - firma, w której Kompletor nie wystawia dokumentów (bez programu, KSeF, wFirma z wyłączonym wystawianiem): od razu,
 *   bez dokumentu (biuro wystawia go jak dotąd, poza Kompletorem);
 * - wFirma z włączonym „Wystawiaj faktury z Kompletora” (tor dokumentów bez rozchodu): dopiero po wystawionym
 *   dokumencie, żeby zamknięcie nie zabrało go torowi.
 * „Dokument przed wysyłką” = bez automatu (zamknięcie i tak wymaga dokumentu). Lustro wFirmy = nic (robi to kolejka).
 * Tylko konta w PRACA; zamówienie po zamówieniu, błąd jednego nie zatrzymuje reszty.
 */
export async function bezWysylkiPrzyStanieKompletora(db: Db, ctx: { now?: Date } = {}): Promise<{ spakowane: number; odebrane: number } | null> {
  const now = ctx.now ?? new Date()
  const warehouse = await db.warehouse.findFirst({ where: { id: DEFAULT_WAREHOUSE }, select: { wfirmaWarehouseId: true, stockSource: true } })
  if (!warehouse || zrodloZMagazynu(warehouse) !== 'KOMPLETOR') return null
  const org = await db.organization.findFirst({ select: { settings: true } })
  const u = parseUstawieniaDokumentow(org?.settings ?? null, { maWfirme: false })
  if (u.przedWysylka) return null
  const zDokumentem = u.program === 'wfirma' && u.fakturyWlaczone
  const spakowane = await packWithoutShipping(db, now)
  const konta = await pracaAccounts(db)
  if (!konta.length) return { spakowane, odebrane: 0 }
  const rows = await db.order.findMany({
    where: {
      status: 'SPAKOWANE',
      pendingAction: null,
      OR: konta,
      ...(zDokumentem ? { invoices: { some: { state: 'ISSUED' } } } : {}),
      // ten sam warunek co `goods` w powodOdmowy: zamówienie z towarem idzie przez „Do wysyłki”
      reservations: { none: { state: { in: ['ACTIVE', 'CONSUMING', 'CONSUMED'] } } },
      shortages: { none: { state: { in: ['OPEN', 'SHIP_LATER'] } } },
    },
    orderBy: { updatedAt: 'asc' },
    take: 100,
    select: { id: true },
  })
  let odebrane = 0
  for (const { id } of rows) {
    try {
      await finishWithoutShipping(db, id, { now, actorId: 'system:bez-wysylki' })
      odebrane++
    } catch (e) {
      if (!(e instanceof TransitionError)) await recordOrderError(db, id, e)
    }
  }
  return { spakowane, odebrane }
}

/** Test kontrolny find osobno dla faktur (FV) i korekt (KOR) — inne endpointy wFirmy. */
type FindKind = 'FV' | 'KOR'

function checkTimes(s: WfirmaQueueState, kind: FindKind): { ok: Date | null; failed: Date | null } {
  return kind === 'FV' ? { ok: s.findCheckOkAt, failed: s.findCheckFailedAt } : { ok: s.findCheckCorrOkAt, failed: s.findCheckCorrFailedAt }
}

/** Sonda pozytywna faktur: ostatnia wystawiona faktura musi się znaleźć po swoim prefiksie `<orderId>/<n>/`. */
async function knownInvoice(db: Db): Promise<{ prefix: string; docId: string } | null> {
  const a = await db.invoiceAttempt.findFirst({ where: { state: 'ISSUED', wfirmaDocId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { idExternal: true, wfirmaDocId: true } })
  return a ? { prefix: a.idExternal.slice(0, a.idExternal.lastIndexOf('/') + 1), docId: a.wfirmaDocId! } : null
}

/** Sonda pozytywna korekt: ostatnia wystawiona korekta po prefiksie `zwrot/<id>/`. */
async function knownCorrection(db: Db): Promise<{ prefix: string; docId: string } | null> {
  const r = await db.return.findFirst({ where: { correctionState: 'ISSUED', correctionDocId: { not: null } }, orderBy: { closedAt: 'desc' }, select: { id: true, correctionDocId: true } })
  return r ? { prefix: correctionPrefix(r.id), docId: r.correctionDocId! } : null
}

/**
 * Test kontrolny `find` (3.4 v1.5 +): sonda negatywna (prefiks, którego nie ma → 0 wyników; inaczej wFirma pomija
 * filtr) i pozytywna (ostatni wystawiony dokument musi się znaleźć; inaczej `find` „nie widzi” dokumentów i po
 * timeoucie powstałby drugi). Bez wystawionych dokumentów — tylko negatywna (pierwszy timeout w historii firmy), wynik
 * ważny tylko w tym przebiegu: pierwsza faktura ma od razu dostać sondę pozytywną.
 * Pełny wynik ważny dobę, nieudany ponawiany po godzinie; do tego czasu timeouty zostają w toku. Sondy wchodzą
 * w budżet: bez budżetu test czeka na następny przebieg, `ok` = false. Tylko przy `ok` timeouty rozstrzyga `find`.
 */
async function ensureFindCheck(
  db: Db,
  s: WfirmaQueueState,
  kind: FindKind,
  find: (p: string) => Promise<{ idExternal: string; docId?: string }[]>,
  known: () => Promise<{ prefix: string; docId: string } | null>,
  stats: QueueStats,
  now: Date,
  budget: Budget,
): Promise<{ state: WfirmaQueueState; ok: boolean }> {
  const t = checkTimes(s, kind)
  const okFresh = t.ok && now.getTime() - t.ok.getTime() < FIND_CHECK_EVERY_MS && (!t.failed || t.failed < t.ok)
  const failFresh = t.failed && now.getTime() - t.failed.getTime() < FIND_CHECK_RETRY_MS && (!t.ok || t.failed > t.ok)
  if (okFresh) return { state: s, ok: true }
  if (failFresh) return { state: s, ok: false }
  const doc = await known()
  if (budget.left < (doc ? 2 : 1)) return { state: s, ok: false }
  budget.take()
  if (doc) budget.take()
  const ok = await checkFindFilter(find, doc)
  if (kind === 'FV') stats.findCheck = ok
  else stats.findCheckCorr = ok
  const what = kind === 'FV' ? 'faktur' : 'korekt'
  if (!ok)
    await alert(
      db,
      'WFIRMA_FIND_FILTR',
      'wfirma',
      `Test kontrolny find (${what}): wFirma zwraca dokumenty mimo filtra id_external albo nie znajduje wystawionego dokumentu — timeouty ${what} nie są rozstrzygane (dokumenty zostają w toku), sprawdź adapter`,
      `find-test:${kind}:${now.toISOString().slice(0, 13)}`,
    )
  if (ok && !doc) return { state: s, ok: true }
  const data = kind === 'FV' ? (ok ? { findCheckOkAt: now } : { findCheckFailedAt: now }) : ok ? { findCheckCorrOkAt: now } : { findCheckCorrFailedAt: now }
  return { state: await db.wfirmaQueueState.update({ where: { organizationId: s.organizationId }, data }), ok }
}

/** Przeliczenie count wFirmy na jednostkę bazową produktu (kg → g). */
function toBase(count: number, unit: 'SZT' | 'KG'): number {
  return unit === 'KG' ? Math.round(count * 1000) : Math.round(count)
}

async function productsByGood(db: Db, goodIds: string[]): Promise<Map<string, { id: string; unit: 'SZT' | 'KG' }>> {
  const rows = await db.product.findMany({ where: { wfirmaGoodId: { in: goodIds }, kind: 'STOCKED' }, select: { id: true, unit: true, wfirmaGoodId: true } })
  return new Map(rows.map((r) => [r.wfirmaGoodId!, { id: r.id, unit: r.unit }]))
}

/**
 * Zdarzenia WFIRMA_READ → goods/get partiami po 20. Zdarzenie jest zamykane tylko, gdy powstało przed wysłaniem
 * odczytu (przyczynowo, jak potwierdzanie ruchów): nowsze czeka na kolejny odczyt.
 */
async function targetedReads(db: Db, reader: OdczytStanowWfirma, wfWh: string, budget: Budget, stats: QueueStats, ctx: { now: Date; clock: () => Date }): Promise<void> {
  // także zdarzenia z faktur i korekt tego przebiegu (zapisane z chwilą odpowiedzi wFirmy, po `now`)
  const events = await db.outboxEvent.findMany({ where: { kind: 'WFIRMA_READ', processedAt: null, createdAt: { lte: ctx.clock() } }, orderBy: { createdAt: 'asc' }, take: 1000 })
  if (!events.length) return
  const productIds = [...new Set(events.map((e) => e.productId))]
  const products = await db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, unit: true, wfirmaGoodId: true, kind: true } })
  let readable = products.filter((p) => p.kind === 'STOCKED' && p.wfirmaGoodId)
  const unreadable = new Set(productIds.filter((id) => !readable.some((p) => p.id === id)))
  if (unreadable.size) await db.outboxEvent.updateMany({ where: { id: { in: events.filter((e) => unreadable.has(e.productId)).map((e) => e.id) } }, data: { processedAt: ctx.now, lastError: 'produkt bez towaru wFirmy' } })
  // towar, którego wFirma ostatnio nie zwracała (zamknięty po próbach < doba temu), nie zajmuje
  // miejsca w paczkach ani budżetu — nowe zdarzenia zamykane od razu, alert już wisi. Doba liczy się tylko od
  // zamknięcia po próbach (zamknięcia w ciszy mają osobny znacznik) i tylko dla tego samego towaru wFirmy
  const goodOf = new Map(readable.map((p) => [p.id, p.wfirmaGoodId!]))
  const quiet = new Set(
    (
      await db.outboxEvent.findMany({
        where: {
          kind: 'WFIRMA_READ',
          productId: { in: readable.map((p) => p.id) },
          lastError: { in: [...new Set(goodOf.values())].map(missingGoodGaveUp) },
          processedAt: { gte: new Date(ctx.now.getTime() - MISSING_GOOD_QUIET_MS) },
        },
        select: { productId: true, lastError: true },
      })
    )
      .filter((e) => e.lastError === missingGoodGaveUp(goodOf.get(e.productId)!))
      .map((e) => e.productId),
  )
  if (quiet.size) await db.outboxEvent.updateMany({ where: { id: { in: events.filter((e) => quiet.has(e.productId)).map((e) => e.id) } }, data: { processedAt: ctx.now, lastError: MISSING_GOOD_SKIPPED } })
  readable = readable.filter((p) => !quiet.has(p.id))
  for (let i = 0; i < readable.length; i += READ_BATCH) {
    if (!budget.take()) return
    const batch = readable.slice(i, i + READ_BATCH)
    const sentAt = ctx.clock()
    const got = await reader.readGoods(batch.map((p) => p.wfirmaGoodId!), wfWh)
    const byGood = new Map(got.map((g) => [g.wfirmaGoodId, g.count]))
    const readOk: string[] = []
    for (const p of batch) {
      const count = byGood.get(p.wfirmaGoodId!)
      const ids = events.filter((e) => e.productId === p.id && e.createdAt <= sentAt).map((e) => e.id)
      if (count === undefined) {
        const tries = Math.max(0, ...events.filter((e) => ids.includes(e.id)).map((e) => e.attempts)) + 1
        if (tries < MISSING_GOOD_MAX_TRIES) {
          await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, lastError: MISSING_GOOD_ERR } })
          continue
        }
        await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, processedAt: ctx.now, lastError: missingGoodGaveUp(p.wfirmaGoodId!) } })
        // klucz z dniem: kolejna seria po dobie, jeśli znów się nie uda, daje nowy alert; przy wciąż otwartym bez dubla
        if (!(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_TOWARU', ref: p.id, closedAt: null } })))
          await alert(
            db,
            'WFIRMA_BRAK_TOWARU',
            p.id,
            `Towar wFirmy ${p.wfirmaGoodId} (magazyn ${wfWh}) nie wraca w odczycie stanów od ${tries} prób — skasowany albo przeniesiony w wFirmie? Popraw powiązanie produktu; do tego czasu stan produktu nie jest odświeżany odczytem`,
            `brak-towaru:${p.id}:${ctx.now.toISOString().slice(0, 10)}`,
          )
        continue
      }
      try {
        await applyStockRead(db, { productId: p.id, countBase: toBase(count, p.unit), requestSentAt: sentAt }, { now: ctx.now })
        await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { processedAt: ctx.now } })
        stats.targetedReads++
        readOk.push(p.id)
      } catch (e) {
        const message = (e as Error).message.slice(0, 900)
        const tries = Math.max(0, ...events.filter((x) => ids.includes(x.id)).map((x) => x.attempts)) + 1
        // odczyt zużywa wywołanie co przebieg, więc bez limitu błąd po naszej stronie zjadałby budżet bez końca
        const gaveUp = tries >= READ_APPLY_MAX_TRIES
        await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, lastError: message, ...(gaveUp ? { processedAt: ctx.now } : {}) } })
        if (gaveUp) await alert(db, 'WFIRMA_ODCZYT_BLAD', p.id, `Odczyt stanu towaru ${p.wfirmaGoodId} nie zapisuje się od ${tries} prób: ${message}. Zdarzenie zamknięte, stan poprawi pełny odczyt`, `odczyt-blad:${p.id}:${ctx.now.toISOString().slice(0, 10)}`)
      }
    }
    // udany odczyt = towar znów wraca z wFirmy (poprawione powiązanie), alert sam się zamyka
    if (readOk.length) await db.alert.updateMany({ where: { kind: 'WFIRMA_BRAK_TOWARU', ref: { in: readOk }, closedAt: null }, data: { dedupeKey: null, closedAt: ctx.now } })
  }
}

async function fullReadPage(db: Db, reader: OdczytStanowWfirma, wfWh: string, s: WfirmaQueueState, stats: QueueStats, ctx: { now: Date; clock: () => Date }): Promise<WfirmaQueueState> {
  const page = s.fullReadPage + 1
  const sentAt = ctx.clock()
  const res = await reader.readGoodsPage(page, wfWh)
  const map = await productsByGood(db, res.items.map((i) => i.wfirmaGoodId))
  const reads = res.items.flatMap((i) => {
    const p = map.get(i.wfirmaGoodId)
    return p ? [{ productId: p.id, countBase: toBase(i.count, p.unit) }] : []
  })
  await applyStockPage(db, reads, sentAt, { now: ctx.now })
  stats.fullReadPages++
  if (res.last) {
    stats.fullReadDone = true
    return db.wfirmaQueueState.update({ where: { organizationId: s.organizationId }, data: { fullReadDueSince: null, fullReadPage: 0, fullReadSentAt: null, lastFullReadAt: ctx.now } })
  }
  return db.wfirmaQueueState.update({ where: { organizationId: s.organizationId }, data: { fullReadPage: page, fullReadSentAt: s.fullReadSentAt ?? sentAt } })
}

async function otherWarehousesReport(db: Db, reader: OdczytStanowWfirma, wfWh: string, s: WfirmaQueueState, stats: QueueStats, now: Date): Promise<WfirmaQueueState> {
  const rows = (await reader.readOtherWarehouses!(wfWh)).filter((r) => r.warehouseId !== wfWh && r.count !== 0)
  stats.otherWarehouses = rows
  if (rows.length) {
    const lines = rows.slice(0, 20).map((r) => `magazyn ${r.warehouseId}: towar ${r.wfirmaGoodId} = ${r.count}`)
    await alert(db, 'STAN_INNY_MAGAZYN', 'wfirma', `Stany na magazynach wFirmy innych niż ${wfWh} (nie wchodzą do sprzedaży): ${rows.length} pozycji. ${lines.join('; ')}`.slice(0, 2000), `inne-magazyny:${now.toISOString().slice(0, 10)}`)
  }
  return db.wfirmaQueueState.update({ where: { organizationId: s.organizationId }, data: { otherWhReportAt: now } })
}
