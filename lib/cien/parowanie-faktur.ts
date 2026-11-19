// (WOO 900007 = BL 900000007): para zamówienie kanału ↔ zamówienie BL od strony faktury BL.
// Porównanie z BL (bl-porownanie.ts) łączy pary tylko w oknie ostatniej doby (`windowMs`, kopie kanału od `windowFrom`).
// Zamówienie złożone przed oknem w chwili pierwszego odczytu cienia (WOO 900007: złożone 24.10, cień od 27.10) nie
// dostawało pary nigdy, więc jego faktura BL szła po 3 dniach do POZA_CIENIEM, a rezerwacja wisiała. Tu: faktura BL bez
// naszego zamówienia → kopia zamówienia BL (`BlOrderSnapshot`, a gdy jej nie ma — `getOrders` po numerze, tylko odczyt,
// z limitem) → numer w kanale → nasze zamówienie bez pary w tym samym kanale i koncie → `Order.blOrderId`. Faktura
// POZA_CIENIEM z ostatnich 30 dni, która dostała parę, wraca do rozliczenia.
import type { PrismaClient } from '@prisma/client'
import type { BlOrderHeader } from './bl-porownanie'
import { organizationIdOf } from '../db'
import { PROCEDURA_FAKTURY_BL } from '../rdzen/faktura-bl'
import { flagsOf } from '../rdzen/rezerwacja'
import { alert } from '../rdzen/stan'

/** Odczyt jednego zamówienia BL po numerze (getOrders z `order_id`); null = BL go nie zna. */
export type PobierzZamowienieBl = (blOrderId: number) => Promise<BlOrderHeader | null>

/**
 * Uzupełnienie numeru zamówienia w kanale odczytem ze sklepu (tylko odczyt, `lib/karta/opis-z-kanalu.ts`). Zamówienia
 * przyjęte przed zapisem numeru przy przyjęciu nie mają `channelNumber`, a BL zna je po numerze w sklepie (nie po
 * identyfikatorze), więc para po tożsamości nie powstawała. Wynik: `OK` (odczyt udany), `BRAK` (sklep odpowiedział, ale
 * zamówienia nie zna albo konto nie ma odczytu: ponowienie nic nie zmieni), `BLAD` (sklep nie odpowiedział, 5xx, limit:
 * do ponowienia w następnym przebiegu).
 */
export type WynikNumeru = 'OK' | 'BRAK' | 'BLAD'
export type UzupelnijNumerKanalu = (orderId: string) => Promise<WynikNumeru>

export const PAIR_FETCH_BUDGET = 20
/** Najwyżej tyle odczytów numeru ze sklepu na przebieg. */
export const NUMBER_FETCH_BUDGET = 20
/** Okno kandydatów do uzupełnienia numeru wokół daty dodania zamówienia w BL (import do BL bywa opóźniony). */
const NUMBER_BEFORE_MS = 3 * 86400_000
const NUMBER_AFTER_MS = 86400_000
/** Najwyżej tylu kandydatów do numeru ze sklepu na fakturę (dłuższa lista = próba niekompletna, bez znacznika końcowego). */
export const NUMBER_CANDIDATES_MAX = 200
/**
 * Kandydat odczytany bez numeru wraca do odczytu po tym czasie (raz na dobę): „sklep nie zna” bywa skutkiem konta bez
 * odczytu albo złych kluczy, które ktoś potem poprawi.
 */
export const NUMBER_RECHECK_MS = 24 * 3600_000
/**
 * Próba numeru ze sklepu dopiero dla faktur starszych niż tyle: świeża faktura, której zamówienie jeszcze do nas nie
 * dotarło (opóźniony odczyt sklepu), nie dostaje znacznika końcowego, zanim zwykły tor zdąży ją sparować.
 */
export const NUMBER_MIN_AGE_MS = 3600_000
const REOPEN_DAYS = 30
export const NO_PAIR = 'bez pary: zamówienie BL spoza kanałów czytanych w cieniu'
/** Jak NO_PAIR, ale po próbie z numerem ze sklepu: więcej prób nie będzie. */
export const NO_PAIR_NUMBER = 'bez pary: zamówienie BL spoza kanałów czytanych w cieniu (numer ze sklepu sprawdzony)'
/** Znacznik nieudanej próby pary w kopii faktury BL (którykolwiek). */
export const bezParyPoProbie = (lastError: string | null): boolean => lastError === NO_PAIR || lastError === NO_PAIR_NUMBER

export interface PairStats {
  paired: number
  reopened: number
  fetched: number
  /** Odczyty numeru zamówienia ze sklepu (zamówienia bez `channelNumber`). */
  numbersRead?: number
  /** Odczyty numeru przerwane błędem sklepu (sklep nie odpowiada): reszta faktur czeka na następny przebieg. */
  numbersFailed?: number
  errors: string[]
}

type Naglowek = Pick<BlOrderHeader, 'channel' | 'channelAccountId' | 'externalRef' | 'dateAdd'>

/** Budżet odczytów numeru na przebieg; `stop` po pierwszym błędzie sklepu (sklep leży: bez kolejnych zapytań). */
interface BudzetNumerow {
  left: number
  stop: boolean
}

/**
 * Nasze zamówienia bez pary i bez numeru w kanale, tego samego kanału i konta, złożone w oknie wokół daty BL: numer
 * ze sklepu (odczyt), potem ponowna próba pary po tożsamości. Para tylko wśród odczytanych kandydatów (numer = numer w
 * BL, jedno trafienie), bez dopasowania po czasie ani kwocie. `kompletne` = wszyscy kandydaci odczytani z wynikiem
 * OK albo BRAK i lista nieucięta budżetem; tylko wtedy wolno uznać, że pary po numerze nie będzie.
 */
async function paraPoNumerzeZeSklepu(
  db: PrismaClient,
  h: Naglowek,
  fill: UzupelnijNumerKanalu,
  budget: BudzetNumerow,
  stats: PairStats,
  now: Date,
): Promise<{ orderId: string | null; kompletne: boolean }> {
  if (!h.externalRef) return { orderId: null, kompletne: true }
  if (budget.stop || budget.left <= 0) return { orderId: null, kompletne: false }
  const cands = await db.order.findMany({
    where: {
      channel: h.channel,
      channelAccountId: h.channelAccountId,
      blOrderId: null,
      channelNumber: null,
      NOT: { externalId: { contains: '#' } },
      createdAtChannel: { gte: new Date(h.dateAdd.getTime() - NUMBER_BEFORE_MS), lte: new Date(h.dateAdd.getTime() + NUMBER_AFTER_MS) },
    },
    select: { id: true, flags: true },
    orderBy: [{ createdAtChannel: 'desc' }, { id: 'asc' }],
    // jeden ponad limit listy: wiadomo, czy lista została ucięta
    take: NUMBER_CANDIDATES_MAX + 1,
  })
  // odczytani w ostatniej dobie bez numeru (sklep nie zna zamówienia albo nie ma ono numeru) nie zajmują budżetu: ich wynik
  // się nie zmieni, a bez tego ponad 20 takich wracałoby na czoło listy w każdym przebiegu i okno nigdy nie byłoby kompletne.
  // Pomijany tylko odczyt po chwili, w której BL dodał to zamówienie z numerem: wcześniejszy mógł być sprzed nadania numeru.
  const doOdczytu = cands.slice(0, NUMBER_CANDIDATES_MAX).filter((c) => {
    const kiedy = flagsOf(c).numerKanaluSprawdzony
    if (!kiedy) return true
    const t = new Date(kiedy).getTime()
    return !(t >= h.dateAdd.getTime() && now.getTime() - t < NUMBER_RECHECK_MS)
  })
  let kompletne = cands.length <= NUMBER_CANDIDATES_MAX && doOdczytu.length <= budget.left
  const odczytane = new Set<string>()
  for (const c of doOdczytu.slice(0, budget.left)) {
    budget.left--
    stats.numbersRead = (stats.numbersRead ?? 0) + 1
    let wynik: WynikNumeru
    try {
      wynik = await fill(c.id)
    } catch {
      wynik = 'BLAD'
    }
    if (wynik === 'BLAD') {
      // sklep nie odpowiada: koniec odczytów numerów w tym przebiegu, faktury zostają do ponowienia
      stats.numbersFailed = (stats.numbersFailed ?? 0) + 1
      budget.stop = true
      budget.left = 0
      kompletne = false
      break
    }
    odczytane.add(c.id)
  }
  // znacznik na odczytanych, które nadal nie mają numeru (atomowo, inne flagi i `updatedAt` bez zmian)
  if (odczytane.size) {
    const bez = await db.order.findMany({ where: { id: { in: [...odczytane] }, channelNumber: null }, select: { id: true } })
    const kiedy = now.toISOString()
    for (const b of bez) await db.$executeRaw`UPDATE "Order" SET flags = (CASE WHEN jsonb_typeof(flags) = 'object' THEN flags ELSE '{}'::jsonb END) || jsonb_build_object('numerKanaluSprawdzony', ${kiedy}::text) WHERE id = ${b.id}`
  }
  if (!odczytane.size) return { orderId: null, kompletne }
  const found = await orderForBlHeader(db, h)
  if (found && odczytane.has(found)) return { orderId: found, kompletne: true }
  // trafienie spoza odczytanych (zamówienie dotarło w międzyczasie): zwykły tor sparuje je w następnym przebiegu
  return { orderId: null, kompletne: kompletne && !found }
}

/** Nasze zamówienie dla nagłówka BL: ten sam kanał i konto, numer = id albo numer w kanale, jeszcze bez pary. */
export async function orderForBlHeader(db: PrismaClient, h: Pick<BlOrderHeader, 'channel' | 'channelAccountId' | 'externalRef'>): Promise<string | null> {
  if (!h.externalRef) return null
  const found = await db.order.findMany({
    where: { channel: h.channel, channelAccountId: h.channelAccountId, blOrderId: null, OR: [{ externalId: h.externalRef }, { channelNumber: h.externalRef }] },
    select: { id: true },
    take: 2,
  })
  return found.length === 1 ? found[0]!.id : null
}

export async function pairOrdersFromBlInvoices(db: PrismaClient, opts: { now: Date; fetchOrder?: PobierzZamowienieBl | null; uzupelnijNumer?: UzupelnijNumerKanalu | null }): Promise<PairStats> {
  const stats: PairStats = { paired: 0, reopened: 0, fetched: 0, errors: [] }
  const since = new Date(opts.now.getTime() - REOPEN_DAYS * 86400_000)
  // otwarte alerty „bez pary”: zamówienie BL sparowane dowolnym torem (np. porównaniem z BL) zamyka swój alert, zanim
  // wczesne wyjścia niżej pominą pętlę; resztę (lista po przebiegu, alert zbiorczy) rozlicza zglosBezPary
  const otwarte = new Set<number>()
  const zgloszenia: ZgloszenieBezPary[] = []
  try {
    for (const id of await zamknijSparowaneBezPary(db, opts.now)) otwarte.add(id)
  } catch (e) {
    stats.errors.push(`zamykanie alertów faktur BL bez pary: ${e instanceof Error ? e.message : String(e)}`)
  }
  const zakoncz = async (): Promise<PairStats> => {
    try {
      await zglosBezPary(db, zgloszenia, otwarte, opts.now)
    } catch (e) {
      stats.errors.push(`alert faktur BL bez pary: ${e instanceof Error ? e.message : String(e)}`)
    }
    return stats
  }
  const invs = await db.blInvoiceSnapshot.findMany({
    where: { dateAdd: { gte: since }, OR: [{ appliedAt: null }, { outcome: 'POZA_CIENIEM' }] },
    select: { organizationId: true, blInvoiceId: true, blOrderId: true, outcome: true, lastError: true, dateAdd: true, kind: true, number: true, externalNumber: true },
  })
  if (!invs.length) return zakoncz()
  const ids = [...new Set(invs.map((i) => i.blOrderId))]
  const have = new Set((await db.order.findMany({ where: { blOrderId: { in: ids } }, select: { blOrderId: true } })).map((o) => o.blOrderId!))
  const missing = ids.filter((id) => !have.has(id))
  if (!missing.length) return zakoncz()
  const snaps = new Map((await db.blOrderSnapshot.findMany({ where: { blOrderId: { in: missing } } })).map((s) => [s.blOrderId, s as Naglowek]))
  let budget = PAIR_FETCH_BUDGET
  const numberBudget: BudzetNumerow = { left: NUMBER_FETCH_BUDGET, stop: false }
  const praca = await kontaWPracy(db)
  for (const blOrderId of missing) {
    const mine = invs.filter((i) => i.blOrderId === blOrderId)
    try {
      let h: Naglowek | null = snaps.get(blOrderId) ?? null
      let fetchedNow = false
      const triedBefore = mine.every((i) => bezParyPoProbie(i.lastError))
      // próba z numerem ze sklepu raz na fakturę, także dla faktur oznaczonych przed nią (stary znacznik NO_PAIR)
      const numberPossible = !!opts.uzupelnijNumer && !mine.every((i) => i.lastError === NO_PAIR_NUMBER)
      // świeża faktura: numer ze sklepu dopiero po godzinie (zamówienie mogło jeszcze do nas nie dotrzeć)
      const fresh = mine.some((i) => opts.now.getTime() - i.dateAdd.getTime() < NUMBER_MIN_AGE_MS)
      // odczyt z BL tylko raz na fakturę: po nieudanej próbie faktura niesie znacznik i czeka na zwykły tor (drugi raz
      // tylko, gdy po pierwszej próbie zostaje jeszcze numer ze sklepu)
      if (!h && opts.fetchOrder && budget > 0 && (!triedBefore || numberPossible)) {
        budget--
        stats.fetched++
        fetchedNow = true
        const pobrany = await opts.fetchOrder(blOrderId)
        h = pobrany
        // nagłówek do kopii: kolejny przebieg weźmie go z niej zamiast z BL (próba numeru ze sklepu bywa odkładana)
        if (pobrany && pobrany.blOrderId === blOrderId) {
          try {
            await zapiszKopieNaglowka(db, pobrany)
          } catch (e) {
            stats.errors.push(`kopia zamówienia BL ${blOrderId}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      let orderId = h ? await orderForBlHeader(db, h) : null
      // numer w sklepie z BL, a nasze zamówienie bez numeru (przyjęte przed jego zapisem): numer ze sklepu, raz na fakturę
      // po kompletnym odczycie wszystkich kandydatów; błąd sklepu, budżet albo świeża faktura = ponowienie później
      let numberTried = false
      let numberComplete = false
      const numberOwed = !orderId && !!h && numberPossible
      if (numberOwed && !fresh && !numberBudget.stop && numberBudget.left > 0) {
        numberTried = true
        const r = await paraPoNumerzeZeSklepu(db, h!, opts.uzupelnijNumer!, numberBudget, stats, opts.now)
        orderId = r.orderId
        numberComplete = r.kompletne
      }
      if (!orderId) {
        // znacznik końcowy tylko po kompletnej próbie numeru; próba niekompletna albo odłożona = bez znacznika, faktura
        // czeka na parę (WZ w CZEKA_NA_PARE, nie POZA_CIENIEM)
        // BL nie zna zamówienia: bez nagłówka próby numeru nie będzie, więc znacznik końcowy (bez odczytu w każdym przebiegu)
        const mark = numberTried ? (numberComplete ? NO_PAIR_NUMBER : null) : numberOwed ? null : fetchedNow ? (!h && numberPossible ? NO_PAIR_NUMBER : NO_PAIR) : null
        if (mark) await db.blInvoiceSnapshot.updateMany({ where: { blOrderId, OR: [{ appliedAt: null }, { outcome: 'POZA_CIENIEM' }] }, data: { lastError: mark } })
        const z = doZgloszeniaBezPary(blOrderId, h, mine, praca, opts.now)
        if (z) zgloszenia.push(z)
        continue
      }
      const upd = await db.order.updateMany({ where: { id: orderId, blOrderId: null }, data: { blOrderId } })
      if (!upd.count) continue
      await db.channelOrderSnapshot.updateMany({ where: { orderId, blOrderId: null }, data: { blOrderId } })
      await db.orderEvent.create({ data: { orderId, kind: 'PARA_BL', actorId: 'system:cien-bl', data: { blOrderId, zrodlo: 'faktura BL' } } })
      stats.paired++
      for (const i of mine.filter((x) => x.outcome === 'POZA_CIENIEM')) {
        await db.blInvoiceSnapshot.update({ where: { organizationId_blInvoiceId: { organizationId: i.organizationId, blInvoiceId: i.blInvoiceId } }, data: { appliedAt: null, outcome: null, orderId: null, lastError: null } })
        stats.reopened++
      }
      await db.blInvoiceSnapshot.updateMany({ where: { blOrderId, appliedAt: null, lastError: { in: [NO_PAIR, NO_PAIR_NUMBER] } }, data: { lastError: null } })
      // para jest: dalej pilnuje blokada pakowania i alerty zamówienia (alert „bez pary” zamyka zglosBezPary)
    } catch (e) {
      stats.errors.push(`para BL ${blOrderId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return zakoncz()
}

/** Pola kopii nagłówka BL zapisywanej przy parowaniu od strony faktury (jak w porównaniu z BL, bez nazwy statusu). */
function daneKopii(h: BlOrderHeader) {
  return {
    orderSource: h.orderSource,
    orderSourceId: h.orderSourceId,
    channel: h.channel,
    channelAccountId: h.channelAccountId,
    externalRef: h.externalRef,
    statusId: h.statusId,
    deliveryMethod: h.deliveryMethod,
    paymentDone: h.paymentDone === null ? null : h.paymentDone.toFixed(2),
    totalGross: h.totalGross === null ? null : h.totalGross.toFixed(2),
    confirmed: h.confirmed,
    dateAdd: h.dateAdd,
    dateConfirmed: h.dateConfirmed,
  }
}

/** Chwila odczytu kopii z parowania: początek epoki, czyli „nie wiadomo, jak świeża”. */
export const KOPIA_Z_PAROWANIA_FETCHED_AT = new Date(0)

/**
 * Kopia nagłówka zamówienia BL odczytanego po numerze (`getOrders`), tylko gdy kopii jeszcze nie ma (zapisu porównania
 * i dziennika nie nadpisujemy). Bez nazwy statusu (ten odczyt nie zna listy statusów BL), więc reguły statusowe, zwroty
 * i raporty statusów jej nie używają. `fetchedAt` = początek epoki: kopia nie udaje świeżego odczytu porównania
 * (świeżość kopii konta przed punktem cięcia), a dziennik BL i odświeżanie zapasowe nadpiszą ją pełnym odczytem.
 */
async function zapiszKopieNaglowka(db: PrismaClient, h: BlOrderHeader): Promise<void> {
  const organizationId = organizationIdOf(db)
  await db.blOrderSnapshot.upsert({
    where: { organizationId_blOrderId: { organizationId, blOrderId: h.blOrderId } },
    create: { blOrderId: h.blOrderId, ...daneKopii(h), statusName: null, fetchedAt: KOPIA_Z_PAROWANIA_FETCHED_AT },
    update: {},
  })
}

// ─── Faktura BL bez pary na koncie w trybie pracy ─────────────────────────────

/** Alert: faktura BL po przełączeniu, której Kompletor nie umie połączyć ze swoim zamówieniem (pakowanie niewstrzymane). */
export const FAKTURA_BL_BEZ_PARY = 'FAKTURA_BL_BEZ_PARY'
/** Alert dopiero po tym czasie od faktury: zwykła para (porównanie z BL co 10 min) zwykle zdąży wcześniej. */
export const BEZ_PARY_ALERT_MS = 15 * 60_000
/** Powyżej tylu faktur bez pary na konto w jednym przebiegu: jeden alert zbiorczy zamiast pojedynczych. */
export const BEZ_PARY_POJEDYNCZE_MAX = 5
/** Najwyżej tyle numerów ze sklepu w treści alertu zbiorczego. */
export const BEZ_PARY_LISTA_MAX = 30
const PREFIKS_BEZ_PARY = 'faktura-bl-bez-pary:'
const PREFIKS_ZBIORCZY = 'faktura-bl-bez-pary-konto:'
const kluczBezPary = (blOrderId: number) => `${PREFIKS_BEZ_PARY}${blOrderId}`
const kluczZbiorczy = (k: Pick<KontoPracy, 'channel' | 'channelAccountId'>) => `${PREFIKS_ZBIORCZY}${k.channel}:${k.channelAccountId}`

interface KontoPracy {
  channel: BlOrderHeader['channel']
  channelAccountId: string
  name: string
}

async function kontaWPracy(db: PrismaClient): Promise<KontoPracy[]> {
  return db.channelConfig.findMany({ where: { statusMode: 'PRACA' }, select: { channel: true, channelAccountId: true, name: true } })
}

type FakturaPary = { outcome: string | null; dateAdd: Date; kind: string | null; number: string; externalNumber: string | null }

interface ZgloszenieBezPary {
  blOrderId: number
  konto: KontoPracy
  numerSklepu: string
  faktura: string
}

/**
 * Zamyka otwarte pojedyncze alerty „bez pary”, których zamówienie BL ma już parę w Kompletorze (z dowolnego toru).
 * Zwraca zamówienia BL z alertem nadal otwartym (zamykanie w przebiegu nie woła bazy na ślepo).
 */
async function zamknijSparowaneBezPary(db: PrismaClient, now: Date): Promise<number[]> {
  const al = await db.alert.findMany({ where: { kind: FAKTURA_BL_BEZ_PARY, closedAt: null, dedupeKey: { startsWith: PREFIKS_BEZ_PARY } }, select: { id: true, dedupeKey: true } })
  if (!al.length) return []
  const po = al.map((a) => ({ id: a.id, blOrderId: Number(a.dedupeKey!.slice(PREFIKS_BEZ_PARY.length)) })).filter((a) => Number.isSafeInteger(a.blOrderId))
  const sparowane = new Set((await db.order.findMany({ where: { blOrderId: { in: po.map((a) => a.blOrderId) } }, select: { blOrderId: true } })).map((o) => o.blOrderId!))
  const doZamkniecia = po.filter((a) => sparowane.has(a.blOrderId))
  if (doZamkniecia.length) await db.alert.updateMany({ where: { id: { in: doZamkniecia.map((a) => a.id) }, closedAt: null }, data: { closedAt: now, dedupeKey: null } })
  return po.filter((a) => !sparowane.has(a.blOrderId)).map((a) => a.blOrderId)
}

/**
 * Faktura BL czekająca na parę (jeszcze nie POZA_CIENIEM) do zamówienia konta w trybie pracy: Kompletor nie wie, które
 * jego zamówienie objęła, więc nie wstrzyma pakowania ani faktury. Bez alertu wyszłoby to dopiero przy dwóch fakturach
 * albo po dobie (alert numerów ze sklepu). Konto w podglądzie i firma bez BL: nic. Wynik: zgłoszenie albo null.
 */
function doZgloszeniaBezPary(blOrderId: number, h: Naglowek | null, mine: FakturaPary[], praca: KontoPracy[], now: Date): ZgloszenieBezPary | null {
  const czeka = mine.filter((i) => i.outcome !== 'POZA_CIENIEM' && (!i.kind || i.kind === 'normal'))
  if (!czeka.length || !h?.externalRef) return null
  const konto = praca.find((k) => k.channel === h.channel && k.channelAccountId === h.channelAccountId)
  if (!konto) return null
  const f = czeka.reduce((a, b) => (b.dateAdd < a.dateAdd ? b : a))
  if (now.getTime() - f.dateAdd.getTime() < BEZ_PARY_ALERT_MS) return null
  return { blOrderId, konto, numerSklepu: h.externalRef, faktura: f.externalNumber ?? f.number }
}

const BEZ_PARY_SPAKOWANE =
  'Jeśli Kompletor już je spakował albo wystawił do niego fakturę, nie wysyłaj go drugi raz z BaseLinkera i sprawdź, czy klient nie dostanie dwóch faktur. ' +
  'Jeśli takiego zamówienia w Kompletorze nie ma, nie dotarło ono ze sklepu: obsłuż je w BaseLinkerze jak dotąd i przekaż numer osobie, która opiekuje się Kompletorem. ' +
  'Gdy zamówienie dotrze później, Kompletor połączy je z fakturą i wstrzyma jego pakowanie.'

/** Lista zamówień BL zapisana przy alercie zbiorczym (pole danych alertu); brak albo zły kształt = pusta. */
function zamowieniaZbiorczego(data: unknown): Set<number> {
  const ids = (data as { blOrderIds?: unknown } | null)?.blOrderIds
  return new Set(Array.isArray(ids) ? ids.filter((x): x is number => Number.isSafeInteger(x)) : [])
}

const REF_MAX = 120
const TRESC_MAX = 2000

/** `ref` zbiorczego: liczba i początek listy numerów ze sklepu (wiadomość na Zulipie i w mailu niesie numery). */
function refZbiorczego(konto: string, lista: ZgloszenieBezPary[]): string {
  let ref = `${konto}: ${lista.length} faktur bez zamówienia`
  for (let i = 0; i < lista.length; i++) {
    const dalej = `${ref}${i === 0 ? ': ' : ', '}${lista[i]!.numerSklepu}`
    const koniec = i < lista.length - 1 ? '…' : ''
    if ((dalej + koniec).length > REF_MAX) return i === 0 ? ref.slice(0, REF_MAX) : `${ref}…`
    ref = dalej
  }
  return ref
}

/** Treść zbiorczego mieszcząca się w limicie: skracana jest lista numerów, instrukcja zostaje cała. */
function trescZbiorczego(konto: string, lista: ZgloszenieBezPary[]): string {
  const zLista = (numery: string) =>
    `${lista.length} zamówień ${konto} ma fakturę z BaseLinkera, a Kompletor nie połączył ich z żadnym swoim zamówieniem, więc nie wstrzymał ich pakowania. ` +
    `Numery ze sklepu: ${numery}. Każde znajdź w Kompletorze: Zamówienia → pole wyszukiwania → numer. Jeśli czeka na spakowanie: ${PROCEDURA_FAKTURY_BL} ` +
    BEZ_PARY_SPAKOWANE +
    ` Lista w tym zgłoszeniu odświeża się sama, a gdy dojdzie nowe zamówienie, przyjdzie nowe zgłoszenie z całą listą. Gdy na liście zostanie ${BEZ_PARY_POJEDYNCZE_MAX} zamówień albo mniej, to zgłoszenie się zamknie, a każde z nich dostanie własne.`
  const numery = lista.slice(0, BEZ_PARY_LISTA_MAX).map((z) => z.numerSklepu)
  for (let n = numery.length; n >= 1; n--) {
    const reszta = lista.length - n
    const t = zLista(numery.slice(0, n).join(', ') + (reszta > 0 ? ` i ${reszta} kolejnych` : ''))
    if (t.length <= TRESC_MAX) return t
  }
  return zLista(`${lista.length} numerów, lista za długa do tego zgłoszenia`).slice(0, TRESC_MAX)
}

/**
 * Alerty „bez pary” po przebiegu: do 5 faktur konta pojedynczo (jeden na zamówienie BL), powyżej jeden zbiorczy na konto
 * z listą numerów ze sklepu (pojedyncze z tej listy zamknięte). Pojedynczy zamyka się, gdy zamówienie BL wypadnie z listy
 * (para, faktura POZA_CIENIEM, konto w podglądzie); zbiorczy, gdy lista konta spadnie do 5 albo jest pusta (wtedy znowu
 * pojedyncze). Gdy na liście zbiorczego pojawi się zamówienie BL spoza poprzedniej listy (pole danych alertu), stary
 * zbiorczy jest zamykany i powstaje nowy: nowa wiadomość i powrót na górę pulpitu. Gdy lista tylko maleje, treść
 * odświeża się w miejscu. Klucz deduplikacji zdjęty przy zamknięciu: nowy epizod daje nowy alert.
 */
async function zglosBezPary(db: PrismaClient, zgloszenia: ZgloszenieBezPary[], otwarte: Set<number>, now: Date): Promise<void> {
  const zamknijKlucze = async (klucze: string[]) => {
    if (klucze.length) await db.alert.updateMany({ where: { kind: FAKTURA_BL_BEZ_PARY, closedAt: null, dedupeKey: { in: klucze } }, data: { closedAt: now, dedupeKey: null } })
  }
  const naLiscie = new Set(zgloszenia.map((z) => z.blOrderId))
  await zamknijKlucze([...otwarte].filter((id) => !naLiscie.has(id)).map(kluczBezPary))
  const poKoncie = new Map<string, ZgloszenieBezPary[]>()
  for (const z of zgloszenia) {
    const k = kluczZbiorczy(z.konto)
    poKoncie.set(k, [...(poKoncie.get(k) ?? []), z])
  }
  const zbiorcze = await db.alert.findMany({ where: { kind: FAKTURA_BL_BEZ_PARY, closedAt: null, dedupeKey: { startsWith: PREFIKS_ZBIORCZY } }, select: { id: true, dedupeKey: true, message: true, ref: true, data: true } })
  await zamknijKlucze(zbiorcze.map((a) => a.dedupeKey!).filter((k) => (poKoncie.get(k)?.length ?? 0) <= BEZ_PARY_POJEDYNCZE_MAX))
  for (const [klucz, lista] of poKoncie) {
    lista.sort((a, b) => a.blOrderId - b.blOrderId)
    if (lista.length <= BEZ_PARY_POJEDYNCZE_MAX) {
      for (const z of lista) {
        if (otwarte.has(z.blOrderId)) continue
        await alert(
          db,
          FAKTURA_BL_BEZ_PARY,
          `${z.numerSklepu} (BL ${z.blOrderId})`,
          `Faktura ${z.faktura} z BaseLinkera dotyczy zamówienia ${z.konto.name} ${z.numerSklepu}, a Kompletor nie połączył jej z żadnym swoim zamówieniem, więc nie wstrzymał jego pakowania. ` +
            `Znajdź to zamówienie w Kompletorze: Zamówienia → pole wyszukiwania → ${z.numerSklepu}. Jeśli czeka na spakowanie: ${PROCEDURA_FAKTURY_BL} ` +
            BEZ_PARY_SPAKOWANE,
          kluczBezPary(z.blOrderId),
        )
      }
      continue
    }
    await zamknijKlucze(lista.filter((z) => otwarte.has(z.blOrderId)).map((z) => kluczBezPary(z.blOrderId)))
    const konto = lista[0]!.konto.name
    const tresc = trescZbiorczego(konto, lista)
    const ref = refZbiorczego(konto, lista)
    const dane = { blOrderIds: lista.map((z) => z.blOrderId) }
    const jest = zbiorcze.find((a) => a.dedupeKey === klucz)
    const poprzednie = jest ? zamowieniaZbiorczego(jest.data) : null
    if (!jest || lista.some((z) => !poprzednie!.has(z.blOrderId))) {
      if (jest) await zamknijKlucze([klucz])
      if (await alert(db, FAKTURA_BL_BEZ_PARY, ref, tresc, klucz)) await db.alert.updateMany({ where: { dedupeKey: klucz, closedAt: null }, data: { data: dane } })
    } else if (jest.message !== tresc || jest.ref !== ref || poprzednie!.size !== lista.length) {
      await db.alert.updateMany({ where: { id: jest.id, closedAt: null }, data: { message: tresc, ref, data: dane } })
    }
  }
}
