// Stanowisko pakowania. Tryb wg konta kanału zamówienia (`ChannelConfig.statusMode`):
//
// CIEN = ćwiczenie „na sucho”: zapis WYŁĄCZNIE do PackDrill (kto, kiedy, wynik, gabaryt, pozycje) i PackDrillFix (lista
// „Do poprawy w wFirmie — z ćwiczenia”). Nie zmienia Order.status ani flags, rezerwacji, stanu, braków, ruchów, faktur
// ani przesyłek — pilnuje tego test porównujący bazę przed i po (tests/stanowisko-na-sucho.integration.test.ts).
//
// PRACA = naprawdę: „na półce nie było” to `markMissingInTx` rdzenia (rezerwacja → brak, ruch STOCK_MISSING), a „Spakowano”
// to `packOrderInTx` (T9: reszta wychodzi, braki idą do zwrotu albo mniejszego pobrania). PackDrill i PackDrillFix
// zostają rejestrem stanowiska; wpis PRACA od razu CLOSED, bo listę biura niesie ruch MANUAL rdzenia, nie to ćwiczenie.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { warsawRanges } from '@/lib/panel/dane'
import { brakJednakWPaczceInTx, cofnijBrakNaPolceInTx, markMissingInTx, ShortageActionError } from '@/lib/rdzen/brakuje'
import { moveOrderInTx } from '@/lib/rdzen/przejscia'
import { blokadaPakowaniaFakturaBl } from '@/lib/rdzen/faktura-bl'
import { PackError, packOrderInTx } from '@/lib/rdzen/rozchod'
import { advisoryLock, runTx, type Tx } from '@/lib/rdzen/stan'
import { TransitionError } from '@/lib/rdzen/statusy'
import { zwolnijKoszykZamowienia } from '@/lib/koszyki/koszyki'
import { odczytajSkan } from './kod'
import { kartaZKodu } from './rozpoznaj-kod'
import { ustawieniaStanowiska } from './ustawienia'
import { gabarytyDla, isGabaryt, type Gabaryt } from './gabaryty'
import type { PozycjaSesji } from './sesja'
import { MAX_ZAMOWIEN, takaSamaMigawka, tylkoSkutkiBraku, wczytajZamowienia, type ZamowienieStanowiska } from './zamowienia'

type Db = PrismaClient

/** Kto „zamknął” wpis stanowiska w PRACY: `cofnijBrak` odmawia, bo rezerwacja i stan już się zmieniły. */
export const ZAPIS_PRACA = 'system:praca'
/** Statusy, z których `packOrder` przyjmuje spakowanie (T9). */
const DO_PAKOWANIA_PRACA = new Set(['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE'])
/** Po tylu minutach cudze niezakończone okno w PRACY uznajemy za porzucone i można je przejąć. */
export const PRZEJECIE_OKNA_MS = 30 * 60_000

/** Błąd akcji stanowiska z komunikatem dla pakującego. */
export class BladStanowiska extends Error {}

export type RodzajBlokady =
  | 'nieznany' // nie karta albo karta innej firmy (nie zdradzamy, że istnieje)
  | 'nieaktualna' // jest nowszy wydruk tej karty
  | 'zmienione' // pozycje zmieniły się w kanale po wydruku
  | 'anulowane'
  | 'status' // PRACA: status zamówienia nie pozwala pakować (nieopłacone, już spakowane, wysłane)
  | 'spakowane' // już spakowane w tym ćwiczeniu
  | 'nie_pakuj' // „Do wyjaśnienia”, „czeka na towar” albo brakuje wszystkiego
  | 'zajete' // PRACA: to zamówienie pakuje teraz ktoś inny

export interface Blokada {
  rodzaj: RodzajBlokady
  komunikat: string
  /** Czerwona karta „nie pakuj” (odłóż koszyk). */
  czerwona: boolean
}

export interface OtwarteCwiczenie {
  drillId: string
  startedAt: Date
  printNo: number | null
  /** „Na półce nie było” zapisane już w tym ćwiczeniu (ponowne otwarcie okna): klucz pozycji → brak. */
  braki: { fixId: string; klucz: string; ilosc: number }[]
}

export type WynikSkanu =
  | { typ: 'blokada'; blokada: Blokada; zamowienie: { id: string; numer: string; tryb: 'CIEN' | 'PRACA' } | null }
  | { typ: 'ok'; zamowienie: ZamowienieStanowiska; cwiczenie: OtwarteCwiczenie }

/** Odmowa otwarcia wykryta pod blokadą pakowania: wycofuje transakcję, pakujący dostaje zwykłą blokadę. */
class OdmowaOtwarcia extends Error {
  constructor(
    readonly rodzaj: RodzajBlokady,
    komunikat: string,
  ) {
    super(komunikat)
  }
}

const NIEZNANY: Blokada = {
  rodzaj: 'nieznany',
  komunikat: 'Nieznany kod — to nie jest aktualna karta zamówienia. Zeskanuj jeszcze raz albo wpisz kod spod kreskowego.',
  czerwona: false,
}

/**
 * Ocena zamówienia przed otwarciem w oknie pakowania. `karta` = zeskanowany wydruk (null przy otwarciu z listy
 * sesji bez skanu). Kolejność: anulowane (najważniejsze: odłóż koszyk) → karta nieaktualna → już spakowane → zmiana w
 * kanale (po spakowaniu z brakiem migawka i tak się różni) → „Do wyjaśnienia” → status w PRACY → faktura z BaseLinkera (PRACA) → „czeka na towar” → nie ma czego pakować. Brak części pozycji NIE
 * blokuje (spec 4.2): okno pokazuje go na czerwono, reszta się pakuje. Dotyczy też ponownego otwarcia po zgłoszeniu braku:
 * karta różni się wtedy od zamówienia tylko skutkiem tego braku, więc nowego wydruku nie trzeba (`kartaPoBraku`).
 */
export async function ocenZamowienie(db: Db, z: ZamowienieStanowiska, karta: { printNo: number } | null): Promise<Blokada | null> {
  const ostatni = await db.orderCardPrint.findFirst({ where: { orderId: z.id }, orderBy: { printNo: 'desc' }, select: { printNo: true, lines: true } })
  if (z.status === 'ANULOWANE') return { rodzaj: 'anulowane', komunikat: `${z.numer}: zamówienie anulowane po wydruku — nie pakuj, odłóż koszyk.`, czerwona: true }
  if (karta && ostatni && karta.printNo < ostatni.printNo) {
    return { rodzaj: 'nieaktualna', komunikat: `${z.numer}: karta nieaktualna (jest nowszy wydruk) — weź kartę nr ${ostatni.printNo}.`, czerwona: false }
  }
  const spakowane = await db.packDrill.findFirst({ where: { orderId: z.id, outcome: 'SPAKOWANE' }, select: { finishedAt: true } })
  if (spakowane) return { rodzaj: 'spakowane', komunikat: z.tryb === 'PRACA' ? `${z.numer}: już spakowane — odłóż kartę.` : `${z.numer}: już spakowane w tym ćwiczeniu — odłóż kartę.`, czerwona: false }
  if (z.kartaNieaktualna || (ostatni && !takaSamaMigawka(ostatni.lines, z.migawka) && !(await kartaPoBraku(db, z, ostatni.lines)))) {
    return { rodzaj: 'zmienione', komunikat: `${z.numer}: zamówienie zmieniło się w kanale po wydruku — wydrukuj kartę ponownie i zbierz według nowej.`, czerwona: false }
  }
  if (z.status === 'DO_WYJASNIENIA') {
    return { rodzaj: 'nie_pakuj', komunikat: `NIE PAKUJ — ${z.numer} jest w „Do wyjaśnienia”${z.doWyjasnienia ? `: ${z.doWyjasnienia}` : ''}. Odłóż koszyk.`, czerwona: true }
  }
  if (z.tryb === 'PRACA' && !DO_PAKOWANIA_PRACA.has(z.status)) return { rodzaj: 'status', komunikat: `${z.numer}: tego statusu nie pakujemy (${z.status === 'NOWE' ? 'czeka na płatność' : 'już po pakowaniu'}) — odłóż kartę.`, czerwona: false }
  if (z.tryb === 'PRACA') {
    // faktura z BaseLinkera: pakowanie i tak odmówi przy „Spakowano”; czerwona karta już przy skanie, zanim ktoś zbierze towar
    const o = await db.order.findUnique({ where: { id: z.id }, select: { id: true, blOrderId: true, parentOrderId: true, channel: true, channelAccountId: true, flags: true } })
    const numer = o ? await blokadaPakowaniaFakturaBl(db, o) : null
    if (numer) return { rodzaj: 'nie_pakuj', komunikat: `NIE PAKUJ — ${z.numer}: faktura ${numer} z BaseLinkera, zamówienie kończy BaseLinker. Odłóż koszyk i przekaż kartę biuru.`, czerwona: true }
  }
  if (z.czekaNaTowar) return { rodzaj: 'nie_pakuj', komunikat: `NIE PAKUJ — ${z.numer}: biuro czeka na towar. Odłóż koszyk.`, czerwona: true }
  if (!z.pozycje.length && z.brakujace.length) return { rodzaj: 'nie_pakuj', komunikat: `NIE PAKUJ — ${z.numer}: brakuje wszystkich pozycji, nie ma czego wysłać. Odłóż koszyk.`, czerwona: true }
  if (z.tylkoBezStanu) return { rodzaj: 'nie_pakuj', komunikat: `${z.numer}: same produkty bez stanu (np. e-book) — nie ma czego pakować.`, czerwona: false }
  return null
}

/** PRACA: czy karta rozjechała się z zamówieniem tylko przez brak zgłoszony na stanowisku. Edycję z kanału łapie flaga rdzenia. */
async function kartaPoBraku(db: Db, z: ZamowienieStanowiska, wydruk: unknown): Promise<boolean> {
  if (z.tryb !== 'PRACA') return false
  const fixes = await db.packDrillFix.findMany({ where: { orderId: z.id, closedBy: ZAPIS_PRACA, state: { not: 'WITHDRAWN' } }, select: { orderLineId: true } })
  // pozycje, których brak zamknął pakujący albo biuro („Jednak jest w paczce”): reszta wróciła do ilości z karty
  const dolozone = await db.orderEvent.findMany({ where: { orderId: z.id, kind: 'JEDNAK_W_PACZCE' }, select: { data: true } })
  const linie = new Set(dolozone.flatMap((e) => (e.data && typeof e.data === 'object' && 'pozycja' in e.data && typeof e.data.pozycja === 'string' ? [e.data.pozycja] : [])))
  return tylkoSkutkiBraku(wydruk, z.migawka, new Set(fixes.map((f) => f.orderLineId)), linie)
}

/**
 * Lista sesji ekranu: zamówienia o podanych id z oceną „co z nimi” (`?z=…` na stanowisku, nakładka na kolejce).
 * Wynik ostatniego zakończonego ćwiczenia przeżywa odświeżenie: „Nie spakowano” nie wraca jako „czeka” (ponowne
 * otwarcie tylko ręcznie z listy), a „na półce nie było” zostaje w podsumowaniu.
 */
export async function sesjaZamowien(db: Db, ids: string[]): Promise<PozycjaSesji[]> {
  const zam = await wczytajZamowienia(db, ids.slice(0, MAX_ZAMOWIEN))
  const zakonczone = await db.packDrill.findMany({
    where: { orderId: { in: zam.map((z) => z.id) }, outcome: { not: null } },
    orderBy: { finishedAt: 'desc' },
    select: { orderId: true, outcome: true, fixes: { where: { state: { not: 'WITHDRAWN' } }, select: { id: true } } },
  })
  const sesja: PozycjaSesji[] = []
  for (const z of zam) {
    const b = await ocenZamowienie(db, z, null)
    const wynik = b?.rodzaj === 'spakowane' ? zakonczone.find((d) => d.orderId === z.id && d.outcome === 'SPAKOWANE') : b ? undefined : zakonczone.find((d) => d.orderId === z.id)
    const stan = b ? (b.rodzaj === 'spakowane' ? 'spakowane' : 'blokada') : wynik?.outcome === 'NIE_SPAKOWANO' ? 'nie_spakowano' : 'czeka'
    sesja.push({ id: z.id, numer: z.numer, tryb: z.tryb, printId: null, stan, komunikat: b?.komunikat ?? null, czerwona: b?.czerwona ?? false, ...(wynik?.fixes.length ? { zBrakiem: true } : {}) })
  }
  return sesja
}

/**
 * Skan karty bez otwierania ćwiczenia (skan w trakcie pakowania innego zamówienia dokłada je do sesji): to samo
 * sprawdzenie co przy otwarciu, wynik z kartą do późniejszego `otworzZSesji`.
 */
export async function sprawdzSkan(
  db: Db,
  tekst: string,
): Promise<
  | Extract<WynikSkanu, { typ: 'blokada' }>
  | { typ: 'do_sesji'; zamowienie: ZamowienieStanowiska; karta: { printId: string; printNo: number } }
> {
  organizationIdOf(db)
  // RLS: wydruk innej firmy jest niewidoczny, więc wychodzi „nieznany kod” — bez zdradzania, że istnieje.
  // ten sam odczyt karty co Pakowanie i lista zamówień (lib/stanowisko/rozpoznaj-kod.ts)
  const wydruk = await kartaZKodu(db, { karta: odczytajSkan(tekst) })
  if (!wydruk) return { typ: 'blokada', blokada: NIEZNANY, zamowienie: null }
  const [z] = await wczytajZamowienia(db, [wydruk.orderId])
  if (!z) return { typ: 'blokada', blokada: NIEZNANY, zamowienie: null }
  const karta = { printId: wydruk.id, printNo: wydruk.printNo }
  const blokada = await ocenZamowienie(db, z, karta)
  if (blokada) return { typ: 'blokada', blokada, zamowienie: { id: z.id, numer: z.numer, tryb: z.tryb } }
  return { typ: 'do_sesji', zamowienie: z, karta }
}

/** Skan karty → zamówienie otwarte w ćwiczeniu albo komunikat dla paska pod polem skanu. */
export async function rozpoznajSkan(db: Db, tekst: string, kto: { userId: string }, now = new Date()): Promise<WynikSkanu> {
  const s = await sprawdzSkan(db, tekst)
  if (s.typ === 'blokada') return s
  return otworzZamowienie(db, s.zamowienie.id, kto, s.karta, now)
}

/** Otwarcie zamówienia z listy sesji; `printId` = karta zeskanowana wcześniej (sprawdzana ponownie). */
export async function otworzZSesji(db: Db, orderId: string, printId: string | null, kto: { userId: string }, now = new Date()): Promise<WynikSkanu> {
  organizationIdOf(db)
  if (typeof orderId !== 'string' || !/^[a-z0-9]{1,40}$/i.test(orderId)) return { typ: 'blokada', blokada: NIEZNANY, zamowienie: null }
  let karta: { printId: string; printNo: number } | null = null
  if (printId && /^[a-z0-9]{1,40}$/i.test(printId)) {
    const w = await db.orderCardPrint.findFirst({ where: { id: printId, orderId }, select: { id: true, printNo: true } })
    if (w) karta = { printId: w.id, printNo: w.printNo }
  }
  return otworzZamowienie(db, orderId, kto, karta, now)
}

/**
 * Otwarcie zamówienia w oknie pakowania (po skanie albo z listy sesji). Gdy nic nie blokuje: ćwiczenie tej osoby
 * dla zamówienia — niezakończone wraca (z brakami), inaczej nowe.
 *
 * PRACA: jedno otwarte okno na zamówienie, cudze świeże blokuje, porzucone (`PRZEJECIE_OKNA_MS`)
 * zamyka się jako „Nie spakowano”. T7 daje zwykle wydruk; gdy zamówienie jest jeszcze albo znów w DO_REALIZACJI
 * (T7 odmówione przy wydruku, „Nie spakowano” i powrót z tą samą kartą), robi je otwarcie okna, żeby przydział nie zmieniał
 * paczki pod ręką. Sam skan statusu nie zmienia. Status czytany pod blokadą, bo ocena `z` jest sprzed niej.
 */
export async function otworzZamowienie(
  db: Db,
  orderId: string,
  kto: { userId: string },
  karta: { printId: string; printNo: number } | null = null,
  now = new Date(),
): Promise<WynikSkanu> {
  const [z] = await wczytajZamowienia(db, [orderId])
  if (!z) return { typ: 'blokada', blokada: NIEZNANY, zamowienie: null }
  const blokada = await ocenZamowienie(db, z, karta)
  if (blokada) return { typ: 'blokada', blokada, zamowienie: { id: z.id, numer: z.numer, tryb: z.tryb } }
  const cwiczenie = await runTx(db, async (tx) => {
    await advisoryLock(tx, `pakowanie:${organizationIdOf(db)}:${z.id}`)
    if (z.tryb === 'PRACA') await zajmijOkno(tx, z, kto, now)
    const otwarte = await tx.packDrill.findFirst({
      where: { orderId: z.id, actorId: kto.userId, outcome: null },
      orderBy: { startedAt: 'desc' },
      // braki tego ćwiczenia: otwarte i już zamknięte przez biuro („Poprawione w wFirmie”) — oba nadal są brakiem
      include: { fixes: { where: { state: { not: 'WITHDRAWN' } } } },
    })
    // PRACA: braki poprzedniego okna są już w rdzeniu (pozycje po ich odjęciu), więc okno zaczyna od zera, nowym wpisem
    if (otwarte && z.tryb === 'PRACA' && otwarte.fixes.length) {
      await tx.packDrill.update({ where: { id: otwarte.id }, data: { outcome: 'NIE_SPAKOWANO', finishedAt: now } })
      const d = await tx.packDrill.create({ data: { orderId: z.id, printId: karta?.printId ?? otwarte.printId, actorId: kto.userId, startedAt: now } })
      return { drillId: d.id, startedAt: d.startedAt, printNo: karta?.printNo ?? null, braki: [] }
    }
    if (otwarte) {
      if (karta && otwarte.printId !== karta.printId) await tx.packDrill.update({ where: { id: otwarte.id }, data: { printId: karta.printId } })
      return {
        drillId: otwarte.id,
        startedAt: otwarte.startedAt,
        printNo: karta?.printNo ?? null,
        braki: otwarte.fixes.map((f) => ({ fixId: f.id, klucz: `${f.orderLineId}:${f.productId}`, ilosc: f.qtyBase })),
      }
    }
    const d = await tx.packDrill.create({ data: { orderId: z.id, printId: karta?.printId ?? null, actorId: kto.userId, startedAt: now } })
    return { drillId: d.id, startedAt: d.startedAt, printNo: karta?.printNo ?? null, braki: [] }
  }).catch((e) => {
    if (e instanceof OdmowaOtwarcia) return e
    throw e
  })
  if (cwiczenie instanceof OdmowaOtwarcia) {
    return { typ: 'blokada', blokada: { rodzaj: cwiczenie.rodzaj, komunikat: cwiczenie.message, czerwona: false }, zamowienie: { id: z.id, numer: z.numer, tryb: z.tryb } }
  }
  return { typ: 'ok', zamowienie: z, cwiczenie }
}

/** PRACA, pod blokadą pakowania: czy wolno otworzyć okno, przejęcie porzuconego i rozpoczęcie zbierania. */
async function zajmijOkno(tx: Tx, z: ZamowienieStanowiska, kto: { userId: string }, now: Date): Promise<void> {
  const { status } = await tx.order.findUniqueOrThrow({ where: { id: z.id }, select: { status: true } })
  if (!DO_PAKOWANIA_PRACA.has(status)) throw new OdmowaOtwarcia('status', `${z.numer}: tego statusu nie pakujemy — odłóż kartę.`)
  const cudze = await tx.packDrill.findMany({ where: { orderId: z.id, outcome: null, actorId: { not: kto.userId } }, orderBy: { startedAt: 'desc' } })
  const zywe = cudze.find((c) => now.getTime() - c.startedAt.getTime() < PRZEJECIE_OKNA_MS)
  if (zywe) {
    const od = zywe.startedAt.toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' })
    throw new OdmowaOtwarcia('zajete', `${z.numer}: pakuje je inna osoba (od ${od}) — odłóż kartę; okno porzucone przejmiesz po 30 minutach.`)
  }
  if (cudze.length) await tx.packDrill.updateMany({ where: { id: { in: cudze.map((c) => c.id) } }, data: { outcome: 'NIE_SPAKOWANO', finishedAt: now } })
  if (status !== 'DO_REALIZACJI') return
  try {
    await moveOrderInTx(tx, z.id, 'ZBIERANIE', { now, actorId: `user:${kto.userId}` })
  } catch (e) {
    if (e instanceof TransitionError) throw new OdmowaOtwarcia('status', `${z.numer}: ${e.message}`)
    throw e
  }
}

async function otwarteCwiczenie(db: Db, drillId: string) {
  if (typeof drillId !== 'string' || !/^[a-z0-9]{1,40}$/i.test(drillId)) throw new BladStanowiska('Nieznane ćwiczenie — otwórz zamówienie jeszcze raz')
  const d = await db.packDrill.findUnique({ where: { id: drillId } })
  if (!d) throw new BladStanowiska('Nieznane ćwiczenie — otwórz zamówienie jeszcze raz')
  if (d.outcome) throw new BladStanowiska('To zamówienie jest już zapisane w ćwiczeniu')
  const [z] = await wczytajZamowienia(db, [d.orderId])
  if (!z) throw new BladStanowiska('Nieznane zamówienie')
  return { d, z }
}

/** Ilość w komunikacie jak na ekranie stanowiska: towar na wagę w gramach z „ g”, sztuki samą liczbą. */
export const iloscPozycji = (n: number, jednostka: 'szt' | 'g') => (jednostka === 'g' ? `${n} g` : String(n))

export interface WynikBraku {
  fixId: string
  ilosc: number
  /** PRACA: co zostało do zebrania po zgłoszeniu (brak składnika wyjmuje cały zestaw, ekran musi to pokazać). */
  doZebrania?: { klucz: string; ilosc: number }[]
  /** PRACA: zgłoszenie wyjęło z paczki zestaw; pozostałe jego składniki wracają na półkę. */
  zestawPoza?: boolean
}

/**
 * „Na półce nie było”: od razu pozycja na liście „Do poprawy w wFirmie — z ćwiczenia” (decyzja właściciela,
 * odpowiedź 20). Jedna pozycja listy na pozycję zamówienia w ćwiczeniu — ponowny zapis zmienia ilość.
 * Rezerwacji, stanu i braków NIE rusza. Konto w PRACY: `brakNaprawde`, brak trafia do rdzenia.
 */
export async function naPolceNieBylo(
  db: Db,
  a: { drillId: string; klucz: string; ilosc: number; userId: string },
  now = new Date(),
): Promise<WynikBraku> {
  const { d, z } = await otwarteCwiczenie(db, a.drillId)
  if (z.tryb === 'PRACA') return brakNaprawde(db, d, z, a, now)
  const p = z.pozycje.find((x) => x.klucz === a.klucz)
  if (!p) throw new BladStanowiska('Tej pozycji nie ma w zamówieniu — zamówienie mogło się zmienić; zeskanuj kartę jeszcze raz')
  if (!p.productId) throw new BladStanowiska('Pozycja bez produktu — zamówienie do wyjaśnienia przez biuro')
  if (!Number.isInteger(a.ilosc) || a.ilosc < 1 || a.ilosc > p.ilosc) throw new BladStanowiska(`Ilość od 1 do ${iloscPozycji(p.ilosc, p.jednostka)}`)
  return runTx(db, async (tx) => {
    await advisoryLock(tx, `pakowanie:${organizationIdOf(db)}:${d.orderId}`)
    const jest = await tx.packDrillFix.findFirst({ where: { drillId: d.id, orderLineId: p.orderLineId, productId: p.productId!, state: { not: 'WITHDRAWN' } } })
    if (jest) {
      // CLOSED = biuro już poprawiło wFirmę o tę ilość; stanowisko tego faktu nie edytuje
      if (jest.state === 'CLOSED') {
        if (jest.qtyBase === a.ilosc) return { fixId: jest.id, ilosc: jest.qtyBase }
        throw new BladStanowiska(`Biuro już poprawiło tę pozycję w wFirmie (${iloscPozycji(jest.qtyBase, p.jednostka)}) — inną ilość zgłoś biuru`)
      }
      await tx.packDrillFix.update({ where: { id: jest.id }, data: { qtyBase: a.ilosc } })
      return { fixId: jest.id, ilosc: a.ilosc }
    }
    const f = await tx.packDrillFix.create({
      data: { drillId: d.id, orderId: d.orderId, orderLineId: p.orderLineId, productId: p.productId!, qtyBase: a.ilosc, actorId: a.userId, createdAt: now },
    })
    return { fixId: f.id, ilosc: a.ilosc }
  })
}

/**
 * „Na półce nie było” na koncie w PRACY. Ilość to stan docelowy dla tego okna, jak w ćwiczeniu: ponowiony zapis tej samej
 * ilości nic nie zmienia, większa dokłada różnicę do rdzenia, mniejszej stanowisko nie cofa (rezerwacja już zwolniona).
 * Górną granicę pilnuje blokada pakowania i rezerwacja pozycji: więcej, niż jest zarezerwowane, nie przejdzie.
 * Pod blokadą jeszcze raz wynik okna i cudze „Spakowano”; status sprawdza `markMissingInTx`.
 */
async function brakNaprawde(db: Db, d: { id: string; orderId: string }, z: ZamowienieStanowiska, a: { klucz: string; ilosc: number; userId: string }, now: Date): Promise<WynikBraku> {
  const [orderLineId, productId] = String(a.klucz).split(':')
  if (!orderLineId || !productId) throw new BladStanowiska('Pozycja bez produktu — zamówienie do wyjaśnienia przez biuro')
  if (!Number.isInteger(a.ilosc) || a.ilosc < 1) throw new BladStanowiska('Ilość od 1')
  const wynik = await runTx(db, async (tx): Promise<WynikBraku> => {
    await advisoryLock(tx, `pakowanie:${organizationIdOf(db)}:${d.orderId}`)
    const okno = await tx.packDrill.findUniqueOrThrow({ where: { id: d.id }, select: { outcome: true } })
    if (okno.outcome) throw new BladStanowiska('To zamówienie jest już zapisane w ćwiczeniu')
    if (await tx.packDrill.findFirst({ where: { orderId: d.orderId, outcome: 'SPAKOWANE' }, select: { id: true } })) throw new BladStanowiska(`${z.numer}: już spakowane — brak zgłoś biuru`)
    const jest = await tx.packDrillFix.findFirst({ where: { drillId: d.id, orderLineId, productId, state: { not: 'WITHDRAWN' } } })
    const dotad = jest?.qtyBase ?? 0
    if (a.ilosc === dotad) return { fixId: jest!.id, ilosc: dotad }
    if (a.ilosc < dotad) throw new BladStanowiska(`Zgłoszone już ${dotad} — mniejszą ilość poprawia biuro`)
    const roznica = a.ilosc - dotad
    // składnik jedynego, już wyjętego zestawu nie ma pozycji do zebrania, a jego kolejną sztukę wciąż trzeba zgłosić
    // górną granicę ilości pilnuje `markMissingInTx` (rezerwacja + niezgłoszone sztuki wyjętych zestawów)
    if (!dotad && !z.pozycje.some((p) => p.klucz === a.klucz)) throw new BladStanowiska('Do zebrania zostało 0 — zamówienie mogło się zmienić')
    let rdzen: Awaited<ReturnType<typeof markMissingInTx>>
    try {
      rdzen = await markMissingInTx(tx, orderLineId, productId, roznica, { now, actorId: `user:${a.userId}`, juzZgloszone: dotad })
    } catch (e) {
      if (e instanceof ShortageActionError) throw new BladStanowiska(e.message)
      throw e
    }
    const zestawPoza = rdzen.zestaw && rdzen.units > 0
    if (jest) {
      await tx.packDrillFix.update({ where: { id: jest.id }, data: { qtyBase: a.ilosc } })
      return { fixId: jest.id, ilosc: a.ilosc, zestawPoza }
    }
    const f = await tx.packDrillFix.create({
      data: { drillId: d.id, orderId: d.orderId, orderLineId, productId, qtyBase: a.ilosc, actorId: a.userId, createdAt: now, state: 'CLOSED', closedAt: now, closedBy: ZAPIS_PRACA },
    })
    return { fixId: f.id, ilosc: a.ilosc, zestawPoza }
  })
  const [po] = await wczytajZamowienia(db, [d.orderId]) // po commicie: ekran dostaje stan z rdzenia
  return { ...wynik, doZebrania: (po?.pozycje ?? []).map((p) => ({ klucz: p.klucz, ilosc: p.ilosc })) }
}

/**
 * „Jednak jest” po zapisie, „Cofnij” albo „Wyczyść”: zdejmuje pozycję z listy „Do poprawy” tego ćwiczenia.
 * Wiersz zostaje jako WITHDRAWN (`withdrawnAt`/`withdrawnBy`) — także gdy biuro zdążyło go zamknąć; wtedy
 * `closedAt`/`closedBy` biura zostają nietknięte (ślad, że wFirma już poprawiona). Nie liczy się już jako brak
 * ani w ćwiczeniu, ani w raporcie dnia.
 */
export async function cofnijBrak(db: Db, a: { drillId: string; fixId: string; userId: string }, now = new Date()): Promise<WynikCofniecia> {
  const { d } = await otwarteCwiczenie(db, a.drillId)
  if (typeof a.fixId !== 'string') return {}
  const naprawde = await db.packDrillFix.findFirst({ where: { id: a.fixId, drillId: d.id, closedBy: ZAPIS_PRACA }, select: { id: true } })
  if (naprawde) return cofnijBrakNaprawde(db, d, a, now)
  await db.packDrillFix.updateMany({
    where: { id: a.fixId, drillId: d.id, state: { in: ['OPEN', 'CLOSED'] } },
    data: { state: 'WITHDRAWN', withdrawnAt: now, withdrawnBy: a.userId },
  })
  return {}
}

export interface WynikCofniecia {
  /** PRACA: pozycje zamówienia z rdzenia po cofnięciu (zestaw wraca do paczki cały, więc ekran bierze listę z serwera). */
  pozycje?: ZamowienieStanowiska['pozycje']
  /** PRACA: ile zestawów albo sztuk wróciło do paczki (0 = towar wrócił na stan, ale paczka czeka na przydział). */
  wrocilo?: number
}

/**
 * „Jednak jest” w PRACY: cofa brak pozycji w rdzeniu (`cofnijBrakNaPolceInTx`), póki okno
 * jest otwarte, zamówienie nie jest spakowane, a biuro nie poprawiło jeszcze stanu w wFirmie. Cofa cały brak tej pozycji i
 * produktu w zamówieniu (także z wcześniejszych okien), bo rdzeń trzyma go per pozycja; wpisy stanowiska → WITHDRAWN.
 */
async function cofnijBrakNaprawde(db: Db, d: { id: string; orderId: string }, a: { fixId: string; userId: string }, now: Date): Promise<WynikCofniecia> {
  const wrocilo = await runTx(db, async (tx) => {
    await advisoryLock(tx, `pakowanie:${organizationIdOf(db)}:${d.orderId}`)
    const okno = await tx.packDrill.findUniqueOrThrow({ where: { id: d.id }, select: { outcome: true } })
    if (okno.outcome) throw new BladStanowiska('To zamówienie jest już zapisane w ćwiczeniu')
    const fix = await tx.packDrillFix.findFirst({ where: { id: a.fixId, drillId: d.id, closedBy: ZAPIS_PRACA, state: { not: 'WITHDRAWN' } } })
    if (!fix) return 0 // drugi klik: już cofnięte
    let r: { units: number }
    try {
      r = await cofnijBrakNaPolceInTx(tx, fix.orderLineId, fix.productId, { now, actorId: `user:${a.userId}` })
    } catch (e) {
      if (e instanceof ShortageActionError) throw new BladStanowiska(e.message)
      throw e
    }
    await tx.packDrillFix.updateMany({
      where: { orderId: d.orderId, orderLineId: fix.orderLineId, productId: fix.productId, closedBy: ZAPIS_PRACA, state: { not: 'WITHDRAWN' } },
      data: { state: 'WITHDRAWN', withdrawnAt: now, withdrawnBy: a.userId },
    })
    return r.units
  })
  const [po] = await wczytajZamowienia(db, [d.orderId])
  return { pozycje: po?.pozycje ?? [], wrocilo }
}

export interface WynikDolozenia {
  /** Sztuki (zestawy) dołożone do paczki; 0 = brak był już zamknięty (drugie kliknięcie albo przydział dostawy). */
  units: number
  /** Pozycje i ramka „Brakuje” po zmianie, z rdzenia (zestaw wraca cały). */
  pozycje: ZamowienieStanowiska['pozycje']
  brakujace: ZamowienieStanowiska['brakujace']
}

/**
 * „Jednak jest w paczce” przy ramce „Brakuje, nie pakuj” (pkt 2 i 3): pakujący ma towar w ręku, a system go nie
 * przydzielił (brak z przydziału, także zamówienie w zbieraniu, którego dostawa już nie dostaje). Zanim padnie „Spakowano”,
 * rdzeń (`brakJednakWPaczceInTx`) zamyka brak pozycji i dopisuje rezerwację, tylko gdy stan pozwala; inaczej odmowa
 * „najpierw przyjmij towar na stan”. Tylko konto w PRACY i otwarte okno; pod blokadą pakowania jak „Jednak jest”.
 */
export async function dolozBrakDoPaczki(db: Db, a: { drillId: string; orderLineId: string; userId: string }, now = new Date()): Promise<WynikDolozenia> {
  const { d, z } = await otwarteCwiczenie(db, a.drillId)
  if (z.tryb !== 'PRACA') throw new BladStanowiska('Konto sklepu jest w podglądzie: braki prowadzi BaseLinker')
  if (typeof a.orderLineId !== 'string' || !z.brakujace.some((b) => b.orderLineId === a.orderLineId)) throw new BladStanowiska('Tej pozycji nie ma w ramce „Brakuje” — odśwież okno')
  const units = await runTx(db, async (tx) => {
    await advisoryLock(tx, `pakowanie:${organizationIdOf(db)}:${d.orderId}`)
    const okno = await tx.packDrill.findUniqueOrThrow({ where: { id: d.id }, select: { outcome: true } })
    if (okno.outcome) throw new BladStanowiska('To zamówienie jest już zapisane w ćwiczeniu')
    try {
      return (await brakJednakWPaczceInTx(tx, a.orderLineId, { now, actorId: `user:${a.userId}` })).units
    } catch (e) {
      if (e instanceof ShortageActionError) throw new BladStanowiska(e.message)
      throw e
    }
  })
  const [po] = await wczytajZamowienia(db, [d.orderId])
  return { units, pozycje: po?.pozycje ?? [], brakujace: po?.brakujace ?? [] }
}

export interface ZakonczenieCwiczenia {
  drillId: string
  wynik: 'SPAKOWANE' | 'NIE_SPAKOWANO'
  gabaryt?: string | null
  /** Zebrane sztuki (gramy) per klucz pozycji; braki bierze z listy „Do poprawy” tego ćwiczenia. */
  zebrane: Record<string, number>
  /** Komentarz klienta / uwagi biura odhaczone na ekranie (obowiązkowe przed „Spakowano”, jeśli są). */
  uwagiOdhaczone?: boolean
  userId: string
}

/** Zapis wyniku ćwiczenia. „Spakowano” wymaga każdej pozycji zebranej albo z „na półce nie było” i gabarytu. */
export async function zakonczCwiczenie(db: Db, a: ZakonczenieCwiczenia, now = new Date()): Promise<{ wynik: 'SPAKOWANE' | 'NIE_SPAKOWANO' }> {
  const { d, z } = await otwarteCwiczenie(db, a.drillId)
  if (a.wynik !== 'SPAKOWANE' && a.wynik !== 'NIE_SPAKOWANO') throw new BladStanowiska('Nieznany wynik')
  // edycja z kanału przy otwartym oknie: czytelny powód zamiast bilansu „nie wszystko zebrane”; twardo pilnuje `packOrderInTx`
  if (a.wynik === 'SPAKOWANE' && z.tryb === 'PRACA' && z.kartaNieaktualna) throw new BladStanowiska(`${z.numer}: zamówienie zmieniło się w kanale po wydruku — wydrukuj kartę ponownie i zbierz według nowej.`)
  return runTx(db, async (tx) => {
    await advisoryLock(tx, `pakowanie:${organizationIdOf(db)}:${d.orderId}`)
    // brak zamknięty przez biuro w trakcie ćwiczenia nadal jest brakiem tej paczki; cofnięty — nie
    const teraz = await tx.packDrill.findUniqueOrThrow({ where: { id: d.id }, include: { fixes: { where: { state: { not: 'WITHDRAWN' } } } } })
    if (teraz.outcome) throw new BladStanowiska('To zamówienie jest już zapisane w ćwiczeniu')
    // PRACA: `z.pozycje` są już po odjęciu zgłoszonych braków (trafiły do rdzenia), więc do bilansu pozycji nie wchodzą
    const brak = new Map(z.tryb === 'PRACA' ? [] : teraz.fixes.map((f) => [`${f.orderLineId}:${f.productId}`, f.qtyBase]))
    const linie = z.pozycje.map((p) => {
      const zeb = Number(a.zebrane?.[p.klucz] ?? 0)
      if (!Number.isInteger(zeb) || zeb < 0 || zeb > p.ilosc) throw new BladStanowiska(`${p.nazwa}: zebrane od 0 do ${p.ilosc}`)
      const b = brak.get(p.klucz) ?? 0
      if (zeb + b > p.ilosc) throw new BladStanowiska(`${p.nazwa}: zebrane i „na półce nie było” razem więcej niż ${p.ilosc}`)
      return { l: p.orderLineId, p: p.productId, q: p.ilosc, zebrane: zeb, brak: b }
    })
    let gabaryt: Gabaryt | null = null
    if (a.wynik === 'SPAKOWANE') {
      if (await tx.packDrill.findFirst({ where: { orderId: d.orderId, outcome: 'SPAKOWANE' }, select: { id: true } })) {
        throw new BladStanowiska(`${z.numer}: już spakowane w tym ćwiczeniu`)
      }
      if (z.czekaNaTowar) throw new BladStanowiska(`${z.numer}: biuro czeka na towar — odłóż koszyk („Nie spakowano”)`)
      const niezebrane = linie.filter((l) => l.zebrane + l.brak < l.q)
      if (niezebrane.length) throw new BladStanowiska(`Nie wszystko zebrane (${niezebrane.length} poz.) — dozbieraj albo „Nie ma w koszyku”`)
      if (!linie.some((l) => l.zebrane > 0)) throw new BladStanowiska('Nic nie zebrane — to „Nie spakowano”')
      if ((z.komentarzKlienta || z.uwagiBiura) && !a.uwagiOdhaczone) throw new BladStanowiska('Najpierw odhacz komentarz klienta i uwagi biura')
      if (!isGabaryt(a.gabaryt) || !gabarytyDla(z.carrier).includes(a.gabaryt)) throw new BladStanowiska('Wybierz gabaryt paczki')
      // firma z koszykami może wymagać skanu koszyka (zamówienie zebrane do koszyka, nie z ręki)
      if (!z.koszyk && (await ustawieniaStanowiska(tx, organizationIdOf(db))).koszykWymagany) throw new BladStanowiska(`${z.numer}: zeskanuj koszyk, w którym jest to zamówienie`)
      gabaryt = a.gabaryt
    }
    await tx.packDrill.update({
      where: { id: d.id },
      data: { outcome: a.wynik, finishedAt: now, parcelSize: gabaryt, lines: linie as unknown as object },
    })
    // spakowane wychodzi z koszyka, koszyk wraca do puli (także przy pakowaniu próbnym: fizycznie jest pusty);
    // „Nie spakowano” zostawia zamówienie w koszyku, żeby skan koszyka je znowu otworzył
    if (a.wynik === 'SPAKOWANE') await zwolnijKoszykZamowienia(tx, d.orderId)
    if (a.wynik === 'SPAKOWANE' && z.tryb === 'PRACA') {
      try {
        await packOrderInTx(tx, d.orderId, { now, actorId: `user:${a.userId}` })
      } catch (e) {
        if (e instanceof PackError) throw new BladStanowiska(e.message)
        throw e
      }
    }
    // koszyk wraca: zamówienie znowu czeka na dostawę i można je zebrać od nowa; gdy nie jest w zbieraniu, zostaje
    if (a.wynik === 'NIE_SPAKOWANO' && z.tryb === 'PRACA') {
      const { status } = await tx.order.findUniqueOrThrow({ where: { id: d.orderId }, select: { status: true } })
      if (status === 'ZBIERANIE') await moveOrderInTx(tx, d.orderId, 'DO_REALIZACJI', { now, actorId: `user:${a.userId}` })
    }
    return { wynik: a.wynik }
  })
}

// ─── Raport dnia ćwiczenia i lista „Do poprawy w wFirmie” ────────────────────────────────────────────────────

export interface RaportCwiczenia {
  /** Zamówienia spakowane na sucho (różne zamówienia). */
  spakowane: number
  /** Zapisy „Nie spakowano”. */
  nieSpakowano: number
  /** Pozycje „na półce nie było” (wpisy listy „Do poprawy”) i łączna ilość. */
  brakiPozycji: number
  /** Średni czas od otwarcia okna do zapisu wyniku, ms; null = brak zakończonych. */
  sredniCzasMs: number | null
  /** Okna otwarte i niezakończone (porzucone albo w toku). */
  niezakonczone: number
}

export async function raportDnia(db: Db, now = new Date()): Promise<RaportCwiczenia> {
  organizationIdOf(db)
  const { dayStart, dayEnd } = warsawRanges(now)
  const [koncowe, fixes, otwarte] = await Promise.all([
    db.packDrill.findMany({ where: { finishedAt: { gte: dayStart, lt: dayEnd }, outcome: { not: null } }, select: { orderId: true, outcome: true, startedAt: true, finishedAt: true } }),
    db.packDrillFix.count({ where: { createdAt: { gte: dayStart, lt: dayEnd }, state: { not: 'WITHDRAWN' } } }),
    db.packDrill.count({ where: { startedAt: { gte: dayStart, lt: dayEnd }, outcome: null } }),
  ])
  const czasy = koncowe.map((d) => d.finishedAt!.getTime() - d.startedAt.getTime()).filter((ms) => ms >= 0)
  return {
    spakowane: new Set(koncowe.filter((d) => d.outcome === 'SPAKOWANE').map((d) => d.orderId)).size,
    nieSpakowano: koncowe.filter((d) => d.outcome === 'NIE_SPAKOWANO').length,
    brakiPozycji: fixes,
    sredniCzasMs: czasy.length ? Math.round(czasy.reduce((s, x) => s + x, 0) / czasy.length) : null,
    niezakonczone: otwarte,
  }
}

export interface PozycjaDoPoprawy {
  id: string
  productId: string
  tytul: string
  sku: string
  unit: 'SZT' | 'KG'
  ilosc: number
  orderId: string
  createdAt: Date
}

/** Otwarte pozycje listy „Do poprawy w wFirmie — z ćwiczenia”, najstarsze pierwsze (limit 200). */
export async function doPoprawy(db: Db): Promise<PozycjaDoPoprawy[]> {
  organizationIdOf(db)
  const rows = await db.packDrillFix.findMany({
    where: { state: 'OPEN' },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: { product: { select: { title: true, sku: true, unit: true } } },
  })
  return rows.map((r) => ({ id: r.id, productId: r.productId, tytul: r.product.title, sku: r.product.sku, unit: r.product.unit, ilosc: r.qtyBase, orderId: r.orderId, createdAt: r.createdAt }))
}

/** Biuro poprawiło stan w wFirmie: pozycja zamknięta (zostaje w historii). */
export async function zamknijDoPoprawy(db: Db, id: string, userId: string, now = new Date()): Promise<boolean> {
  organizationIdOf(db)
  if (typeof id !== 'string' || !/^[a-z0-9]{1,40}$/i.test(id)) return false
  const r = await db.packDrillFix.updateMany({ where: { id, state: 'OPEN' }, data: { state: 'CLOSED', closedAt: now, closedBy: userId } })
  return r.count === 1
}

export interface CofnietePoPoprawie {
  id: string
  productId: string
  tytul: string
  sku: string
  unit: 'SZT' | 'KG'
  ilosc: number
  orderId: string
  closedAt: Date
  withdrawnAt: Date
}

/**
 * „Cofnięte na stanowisku po poprawie”: biuro zamknęło pozycję („Poprawione w wFirmie”), a potem
 * stanowisko ją cofnęło („Jednak jest”, „Cofnij”, „Wyczyść”) — wFirma mogła zostać poprawiona niepotrzebnie.
 * Cofnięte w ostatnich 7 dniach, najnowsze pierwsze (limit 200).
 */
export async function cofnietePoPoprawie(db: Db, now = new Date()): Promise<CofnietePoPoprawie[]> {
  organizationIdOf(db)
  const od = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
  const rows = await db.packDrillFix.findMany({
    // PRACA: wpis zamknięty przez system (nie przez biuro) i cofnięty „Jednak jest” to nie poprawka wFirmy;
    // `not` w SQL odcina też NULL, więc wiersze bez `closedBy` wprost
    where: { state: 'WITHDRAWN', closedAt: { not: null }, OR: [{ closedBy: null }, { closedBy: { not: ZAPIS_PRACA } }], withdrawnAt: { gte: od } },
    orderBy: { withdrawnAt: 'desc' },
    take: 200,
    include: { product: { select: { title: true, sku: true, unit: true } } },
  })
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    tytul: r.product.title,
    sku: r.product.sku,
    unit: r.product.unit,
    ilosc: r.qtyBase,
    orderId: r.orderId,
    closedAt: r.closedAt!,
    withdrawnAt: r.withdrawnAt!,
  }))
}
