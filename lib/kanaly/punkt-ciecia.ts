// Punkt cięcia przy przejściu z BaseLinkera (krok przed włączeniem trybu pracy kont). W podglądzie status zamówienia
// w Kompletorze zostaje na „Do realizacji” także po wysyłce w BaseLinkerze, więc bez tego kroku kolejka pakowania po
// przełączeniu pokazałaby zamówienia dawno wysłane (druga paczka), a automat „bez paczki” spakowałby stare zamówienia
// z e-bookiem. Polecenie dzieli otwarte zamówienia kont w podglądzie według kopii statusu z BaseLinkera (odczyt cienia,
// `BlOrderSnapshot`) i kopii faktur BL:
//   - obsłużone w BaseLinkerze (spakowane, do wysyłki, do odbioru, wysłane, odebrane; e-book z fakturą BL) → w trybie
//     wykonania zamknięte w Kompletorze: status „Wysłane”, „Odebrane” albo (odbiór osobisty czekający na klienta)
//     „Do odbioru”, i wpis w historii; bez maila do klienta,
//     bez zapisu do sklepu i kanałów, bez faktury, bez ruchu magazynowego;
//   - nieskończone w BaseLinkerze (nowe, do realizacji, zbieranie, zebrane, e-book bez faktury) → tylko lista,
//     osobno z fakturą BL i bez (decyzja wg planu przełączenia);
//   - czekające na rozliczenie stanu (obsłużone w BL, ale rezerwacja jeszcze aktywna: faktura BL czeka na WZ albo
//     odczyt „Wysłane bez faktury” jeszcze nie przeszedł) → lista, polecenie powtórzyć po kolejnym odczycie;
//   - do sprawdzenia (anulowane w BL, inny status BL, zamówienie z fakturą, przesyłką albo pracą w Kompletorze) i bez
//     pary w BL → lista.
// Zamknięte zamówienie nie trafia też do maili „Faktura”, „Gotowe do odbioru” i „Brak płatności” (lib/akcje/silnik.ts):
// tę obsługę zrobił BaseLinker. Zapis statusu do sklepu i reguły czasowe pomijają je tylko w stanie z chwili cięcia
// (lib/kanaly/zamkniete-przy-przejsciu.ts); późniejsze przejście w Kompletorze działa jak każde inne. Każde zamówienie w osobnej transakcji, błąd jednego nie zatrzymuje reszty. Powtórka niczego nie zmienia
// (zamknięte ma już status końcowy i wpis w historii).
// Kopia musi być świeża: BaseLinker mógł wysłać albo zafakturować po ostatnim odczycie, a takie zamówienie trafiłoby
// do kolejki pakowania (druga paczka). Wykonanie odmawia, gdy którykolwiek z trzech odczytów, na których stoi decyzja,
// jest starszy niż próg (domyślnie 15 min): lista zamówień z okna (świeże zamówienia), dziennik zmian statusów
// (starsze zamówienia: tylko on przenosi ich status) i faktury BL. Liczy się ostatni UDANY odczyt każdego z nich
// osobno, nigdy „nowszy z dwóch”; raport pokazuje każdy czas i oznacza te, które blokują. Przy zamknięciu status
// z kopii sprawdzany jest jeszcze raz pod blokadą zamówienia.
import type { Channel, OrderStatus, PrismaClient } from '@prisma/client'
import { blStatusFamily, type BlFamily } from '../cien/bl-porownanie'
import { INVOICES_JOB } from '../cien/faktury-bl'
import { ostatniUdanyPrzebieg } from '../cien/przebiegi'
import { lockOrder } from '../rdzen/przejscia'
import { runTx } from '../rdzen/stan'

import { ZAMKNIETE_PRZY_PRZEJSCIU } from './zamkniete-przy-przejsciu'

export { ZAMKNIETE_PRZY_PRZEJSCIU }

/** Statusy, które w podglądzie może mieć zamówienie prowadzone jeszcze przez BaseLinkera. */
export const OTWARTE: readonly OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'DO_WYJASNIENIA']

/** Rodziny statusu BL = zamówienie obsłużone w BaseLinkerze → status zamknięcia w Kompletorze. */
const OBSLUZONE: Partial<Record<BlFamily, OrderStatus>> = {
  SPAKOWANE: 'WYSLANE',
  DO_WYSLANIA: 'WYSLANE',
  // „Do odbioru” w BL: paczka w drodze albo w punkcie = wysłana; odbiór osobisty zamyka się niżej jako „Do odbioru”
  // (czeka na klienta: zostaje na liście do wydania, biuro oznacza „Odebrane” przy wydaniu)
  DO_ODBIORU: 'WYSLANE',
  WYSLANE: 'WYSLANE',
  ODEBRANE: 'ODEBRANE',
}
const NIESKONCZONE: readonly BlFamily[] = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE']

export type GrupaPunktuCiecia = 'DO_ZAMKNIECIA' | 'NIESKONCZONE_Z_FAKTURA_BL' | 'NIESKONCZONE_BEZ_FAKTURY' | 'CZEKA_NA_ROZLICZENIE' | 'DO_SPRAWDZENIA' | 'BEZ_PARY_W_BL'

export interface PozycjaPunktuCiecia {
  orderId: string
  channel: Channel
  channelAccountId: string
  /** Numer zamówienia w kanale (bez danych klienta). */
  externalId: string
  blOrderId: number | null
  status: OrderStatus
  /** Nazwa statusu w BaseLinkerze z kopii; null bez kopii. */
  statusBl: string | null
  fakturaBl: string | null
  grupa: GrupaPunktuCiecia
  /** Status po zamknięciu (tylko DO_ZAMKNIECIA). */
  na: OrderStatus | null
  powod: string
  /**
   * brak towaru tego zamówienia rozliczyła faktura BL (zdjęła flagę „brakuje”), a zamówienie jest
   * nieskończone w BL: w BaseLinkerze może nadal czekać na dostawę. Osobna lista „sprawdź, czy towar dojechał”.
   */
  towarCzekal: boolean
}

export interface WynikPunktuCiecia {
  naSucho: boolean
  konta: { channel: Channel; channelAccountId: string }[]
  /** Konta w trybie pracy pominięte (zamówienia prowadzi już Kompletor). */
  kontaWPracy: number
  pozycje: PozycjaPunktuCiecia[]
  liczby: Record<GrupaPunktuCiecia, number>
  zamkniete: number
  bledy: { orderId: string; blad: string }[]
  /** Kontrola po kroku: zamówienia tych kont w statusach kolejki pakowania (do porównania z BaseLinkerem). */
  wKolejcePakowania: number
  /**
   * Z tego: nieskończone w BL z fakturą BL. Kończy je BaseLinker; po włączeniu trybu pracy Kompletor zdejmuje je
   * z kolejki „do spakowania” i wstrzymuje ich pakowanie (`blokadaPakowaniaFakturaBl`).
   */
  wKolejceZFakturaBl: number
  /** nieskończone w BL, z brakiem rozliczonym fakturą BL (`towarCzekal`). */
  towarCzekal: number
  swiezosc: SwiezoscKopii
  /** Chwila oceny świeżości (raport oznacza źródła za stare względem niej). */
  sprawdzonoO: Date
  /** Powód odmowy wykonania (kopia za stara); null = wykonano albo na sucho. */
  odmowa: string | null
}

/** Źródła kopii z BaseLinkera, od których zależy decyzja o zamknięciu. */
export type ZrodloKopii = 'zamowienia' | 'dziennik' | 'faktury'

/** Chwile ostatnich odczytów z BaseLinkera, na których stoi podział (odczyt BL obejmuje wszystkie konta firmy). */
export interface SwiezoscKopii {
  /** Start ostatniego porównania z kompletną listą zamówień BL z okna (status świeżych zamówień). */
  zamowienia: Date | null
  /**
   * Start ostatniego porównania, w którym dziennik zmian statusów BL przeczytał się do końca bez błędu (pusty dziennik
   * też). Tylko dziennik przenosi zmiany statusu zamówień spoza okna listy; odczyt z błędem albo urwany się nie liczy.
   */
  dziennik: Date | null
  /** Start ostatniego pełnego odczytu faktur BL. */
  faktury: Date | null
  /** Najnowszy wpis kopii zamówień BL per konto (informacyjnie: konto bez zmian w BL go nie odświeża). */
  perKonto: { channel: Channel; channelAccountId: string; ostatniaKopia: Date | null }[]
  maksWiekMs: number
}

export interface OpcjePunktuCiecia {
  naSucho: boolean
  channel?: Channel
  channelAccountId?: string
  now?: Date
  actorId?: string
  /** Najstarsza dopuszczalna kopia z BL przy wykonaniu (domyślnie 15 min). */
  maksWiekMs?: number
}

export const MAKS_WIEK_KOPII_MS = 15 * 60_000

const KOLEJKA: readonly OrderStatus[] = ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE']
const PACZKA = 500

const czas = (d: Date) => d.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'medium' })

/**
 * Chwile ostatnich UDANYCH odczytów z BaseLinkera (lista zamówień z okna, dziennik statusów, faktury) i najnowsza kopia
 * per konto. Kursor dziennika (`BlJournalCursor.lastReadAt`) się nie nadaje: przesuwa się także po odczycie urwanym
 * błędem, dlatego dziennik liczy się z wyniku przebiegu porównania (`ImportRun.stats.journal.complete`).
 */
export async function swiezoscKopii(db: PrismaClient, konta: readonly { channel: Channel; channelAccountId: string }[], maksWiekMs: number): Promise<SwiezoscKopii> {
  const [lista, dziennik, faktury, kopie] = await Promise.all([
    // OK = kompletna lista zamówień z okna (PARTIAL = lista urwana)
    db.importRun.findFirst({ where: { kind: 'cien-bl', status: 'OK' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    // dziennik niezależnie od kompletności listy: przebieg OK albo PARTIAL, w którym dziennik doczytał się do końca
    db.importRun.findFirst({
      where: { kind: 'cien-bl', status: { in: ['OK', 'PARTIAL'] }, stats: { path: ['journal', 'complete'], equals: true } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
    ostatniUdanyPrzebieg(db, INVOICES_JOB),
    konta.length ? db.blOrderSnapshot.groupBy({ by: ['channel', 'channelAccountId'], where: { OR: [...konta] }, _max: { fetchedAt: true } }) : [],
  ])
  const perKonto = konta.map((k) => ({ ...k, ostatniaKopia: kopie.find((x) => x.channel === k.channel && x.channelAccountId === k.channelAccountId)?._max.fetchedAt ?? null }))
  return { zamowienia: lista?.startedAt ?? null, dziennik: dziennik?.startedAt ?? null, faktury, perKonto, maksWiekMs }
}

const NAZWY_ZRODEL: Record<ZrodloKopii, string> = { zamowienia: 'lista zamówień z okna', dziennik: 'dziennik statusów', faktury: 'faktury' }
const ZRODLA = Object.keys(NAZWY_ZRODEL) as ZrodloKopii[]

/** Źródła starsze niż próg albo nigdy nieodczytane; każde z nich osobno blokuje wykonanie. */
export function stareZrodla(s: SwiezoscKopii, now: Date): ZrodloKopii[] {
  return ZRODLA.filter((z) => {
    const d = s[z]
    return !d || now.getTime() - d.getTime() > s.maksWiekMs
  })
}

/** Powód odmowy wykonania przy zbyt starej kopii (null = wszystkie źródła świeże). */
export function powodStarejKopii(s: SwiezoscKopii, now: Date): string | null {
  const braki = stareZrodla(s, now).map((z) => {
    const d = s[z]
    return `${NAZWY_ZRODEL[z]} ${d ? `odczytane ${czas(d)}` : 'nigdy nieodczytane'}`
  })
  if (!braki.length) return null
  return `Kopia z BaseLinkera starsza niż ${Math.round(s.maksWiekMs / 60_000)} min (${braki.join(', ')}): najpierw odśwież odczyt (porównanie zamówień z BaseLinkerem razem z dziennikiem statusów i odczyt faktur BL), potem powtórz polecenie. Nic nie zamknięto.`
}

/** Klasyfikacja jednego zamówienia (czysta funkcja, testy jednostkowe). */
export function klasyfikuj(z: {
  statusBl: string | null
  fakturaBl: string | null
  aktywneRezerwacje: number
  pracaKompletora: string | null
  pendingAction: string | null
  /** Odbiór osobisty (przewoźnik OSOBISTY): BL „Do odbioru” = czeka na klienta. */
  odbiorOsobisty?: boolean
  /**
   * konto już w trybie pracy. Zamykamy tylko to, co BL ma jako wysłane albo odebrane; „Spakowane” czy
   * „Do wysłania” w BL bywa samą zmianą statusu (np. automat BL po fakturze), a paczki nikt nie spakował.
   */
  kontoWPracy?: boolean
}): { grupa: GrupaPunktuCiecia; na: OrderStatus | null; powod: string } {
  if (z.statusBl === null) return { grupa: 'BEZ_PARY_W_BL', na: null, powod: 'brak kopii zamówienia z BaseLinkera' }
  const family = blStatusFamily(z.statusBl).family
  const na = family === 'DO_ODBIORU' && z.odbiorOsobisty ? 'DO_ODBIORU' : (OBSLUZONE[family] ?? (family === 'EBOOK' && z.fakturaBl ? 'ODEBRANE' : null))
  if (na && z.kontoWPracy && family !== 'WYSLANE' && family !== 'ODEBRANE')
    return { grupa: 'DO_SPRAWDZENIA', na: null, powod: `konto w trybie pracy: w BaseLinkerze „${z.statusBl}”, nie „Wysłane” ani „Odebrane”; sprawdź, czy paczka wyszła` }
  if (na) {
    if (z.pracaKompletora) return { grupa: 'DO_SPRAWDZENIA', na: null, powod: `obsłużone w BaseLinkerze, ale ${z.pracaKompletora}` }
    if (z.pendingAction) return { grupa: 'DO_SPRAWDZENIA', na: null, powod: 'obsłużone w BaseLinkerze, ale czeka odłożona operacja (np. anulowanie)' }
    if (z.aktywneRezerwacje > 0)
      return { grupa: 'CZEKA_NA_ROZLICZENIE', na: null, powod: z.fakturaBl ? 'faktura BL czeka na rozliczenie stanu (WZ)' : 'wysłane w BaseLinkerze, stan rozliczy kolejny odczyt' }
    return { grupa: 'DO_ZAMKNIECIA', na, powod: `w BaseLinkerze: ${z.statusBl}` }
  }
  if (NIESKONCZONE.includes(family) || family === 'EBOOK')
    return z.fakturaBl ? { grupa: 'NIESKONCZONE_Z_FAKTURA_BL', na: null, powod: `w BaseLinkerze: ${z.statusBl}, z fakturą` } : { grupa: 'NIESKONCZONE_BEZ_FAKTURY', na: null, powod: `w BaseLinkerze: ${z.statusBl}, bez faktury` }
  return { grupa: 'DO_SPRAWDZENIA', na: null, powod: `w BaseLinkerze: ${z.statusBl}` }
}

/**
 * Punkt cięcia: na sucho (`naSucho: true`) tylko lista i liczby, nic nie zapisuje; wykonanie zamyka grupę
 * DO_ZAMKNIECIA. Konta w podglądzie w całości; z kont w trybie pracy tylko zamówienia z rozliczoną fakturą BaseLinkera (19.11.2026), a zamykane z nich tylko te,
 * które BL ma jako „Wysłane” albo „Odebrane” (reszta do sprawdzenia).
 */
export async function punktCiecia(db: PrismaClient, opts: OpcjePunktuCiecia): Promise<WynikPunktuCiecia> {
  const now = opts.now ?? new Date()
  const actorId = opts.actorId ?? 'system:punkt-ciecia'
  const wszystkie = await db.channelConfig.findMany({
    where: { ...(opts.channel ? { channel: opts.channel } : {}), ...(opts.channelAccountId ? { channelAccountId: opts.channelAccountId } : {}) },
    select: { channel: true, channelAccountId: true, statusMode: true },
    orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }],
  })
  const konta = wszystkie.filter((k) => k.statusMode === 'CIEN').map(({ channel, channelAccountId }) => ({ channel, channelAccountId }))
  const liczby: Record<GrupaPunktuCiecia, number> = { DO_ZAMKNIECIA: 0, NIESKONCZONE_Z_FAKTURA_BL: 0, NIESKONCZONE_BEZ_FAKTURY: 0, CZEKA_NA_ROZLICZENIE: 0, DO_SPRAWDZENIA: 0, BEZ_PARY_W_BL: 0 }
  const swiezosc = await swiezoscKopii(db, konta, opts.maksWiekMs ?? MAKS_WIEK_KOPII_MS)
  const wynik: WynikPunktuCiecia = { naSucho: opts.naSucho, konta, kontaWPracy: wszystkie.length - konta.length, pozycje: [], liczby, zamkniete: 0, bledy: [], wKolejcePakowania: 0, wKolejceZFakturaBl: 0, towarCzekal: 0, swiezosc, sprawdzonoO: now, odmowa: null }
  // 19.11.2026: konto przełączone na tryb pracy przed punktem cięcia. Bierzemy z niego wyłącznie zamówienia z rozliczoną
  // fakturą BaseLinkera (zdarzenie FAKTURA_BL): te skończył BaseLinker, Kompletor ich nie pakuje. Reszta zamówień
  // konta w pracy należy do Kompletora i tu nie trafia. Klasyfikacja i bezpieczniki zamknięcia bez zmian.
  const kontaPracy = wszystkie.filter((k) => k.statusMode !== 'CIEN').map(({ channel, channelAccountId }) => ({ channel, channelAccountId, events: { some: { kind: 'FAKTURA_BL' } } }))
  if (!konta.length && !kontaPracy.length) return wynik

  const zamowienia = await db.order.findMany({
    where: { status: { in: [...OTWARTE] }, OR: [...konta, ...kontaPracy] },
    orderBy: [{ createdAtChannel: 'asc' }, { id: 'asc' }],
    select: { id: true, channel: true, channelAccountId: true, externalId: true, blOrderId: true, status: true, pendingAction: true, carrier: true },
  })
  for (let i = 0; i < zamowienia.length; i += PACZKA) {
    const czesc = zamowienia.slice(i, i + PACZKA)
    const ids = czesc.map((o) => o.id)
    const blIds = czesc.flatMap((o) => (o.blOrderId !== null ? [o.blOrderId] : []))
    const [kopie, faktury, zdarzenia, rezerwacje, proby, przesylki, brakiPoFakturze] = await Promise.all([
      blIds.length ? db.blOrderSnapshot.findMany({ where: { blOrderId: { in: blIds } }, select: { blOrderId: true, statusName: true } }) : [],
      blIds.length ? db.blInvoiceSnapshot.findMany({ where: { blOrderId: { in: blIds }, OR: [{ kind: null }, { kind: 'normal' }] }, orderBy: { blInvoiceId: 'asc' }, select: { blOrderId: true, number: true, externalNumber: true } }) : [],
      db.orderEvent.findMany({ where: { orderId: { in: ids }, kind: { in: ['FAKTURA_BL', 'SPAKOWANE'] } }, select: { orderId: true, kind: true, data: true } }),
      db.reservation.groupBy({ by: ['orderId'], where: { orderId: { in: ids }, state: { in: ['ACTIVE', 'CONSUMING'] } }, _count: { _all: true } }),
      db.invoiceAttempt.findMany({ where: { orderId: { in: ids } }, select: { orderId: true } }),
      db.shipment.findMany({ where: { orderId: { in: ids } }, select: { orderId: true } }),
      db.shortage.findMany({ where: { orderId: { in: ids }, resolvedBy: 'system:faktura-bl' }, select: { orderId: true }, distinct: ['orderId'] }),
    ])
    const czekal = new Set(brakiPoFakturze.map((s) => s.orderId))
    const statusBl = new Map(kopie.map((k) => [k.blOrderId, k.statusName]))
    const fakturaBlPo = new Map<number, string>()
    for (const f of faktury) if (!fakturaBlPo.has(f.blOrderId)) fakturaBlPo.set(f.blOrderId, f.externalNumber ?? f.number)
    const fakturaZdarzenie = new Map<string, string>()
    const spakowane = new Set<string>()
    for (const e of zdarzenia) {
      if (e.kind === 'SPAKOWANE') spakowane.add(e.orderId)
      else if (!fakturaZdarzenie.has(e.orderId)) {
        const doc = (e.data as { docId?: unknown } | null)?.docId
        fakturaZdarzenie.set(e.orderId, typeof doc === 'string' && doc ? doc : 'faktura BL')
      }
    }
    const aktywne = new Map(rezerwacje.map((r) => [r.orderId, r._count._all]))
    const zFaktura = new Set(proby.map((p) => p.orderId))
    const zPrzesylka = new Set(przesylki.map((p) => p.orderId))
    for (const o of czesc) {
      const fakturaBl = fakturaZdarzenie.get(o.id) ?? (o.blOrderId !== null ? (fakturaBlPo.get(o.blOrderId) ?? null) : null)
      const pracaKompletora = zFaktura.has(o.id) ? 'ma fakturę z Kompletora' : zPrzesylka.has(o.id) ? 'ma przesyłkę z Kompletora' : spakowane.has(o.id) ? 'było pakowane w Kompletorze' : null
      const sb = o.blOrderId !== null ? (statusBl.get(o.blOrderId) ?? null) : null
      const kontoWPracy = !konta.some((k) => k.channel === o.channel && k.channelAccountId === o.channelAccountId)
      const k = klasyfikuj({ statusBl: sb, fakturaBl, aktywneRezerwacje: aktywne.get(o.id) ?? 0, pracaKompletora, pendingAction: o.pendingAction, odbiorOsobisty: o.carrier === 'OSOBISTY', kontoWPracy })
      liczby[k.grupa]++
      const towarCzekal = czekal.has(o.id) && k.grupa === 'NIESKONCZONE_Z_FAKTURA_BL'
      if (towarCzekal) wynik.towarCzekal++
      wynik.pozycje.push({ orderId: o.id, channel: o.channel, channelAccountId: o.channelAccountId, externalId: o.externalId, blOrderId: o.blOrderId, status: o.status, statusBl: sb, fakturaBl, ...k, towarCzekal })
    }
  }

  if (!opts.naSucho) wynik.odmowa = powodStarejKopii(swiezosc, now)
  if (!opts.naSucho && !wynik.odmowa) {
    for (const p of wynik.pozycje) {
      if (p.grupa !== 'DO_ZAMKNIECIA' || !p.na) continue
      try {
        if (await zamknij(db, p, actorId, now)) wynik.zamkniete++
      } catch (e) {
        wynik.bledy.push({ orderId: p.orderId, blad: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
      }
    }
  }
  wynik.wKolejcePakowania = konta.length ? await db.order.count({ where: { status: { in: [...KOLEJKA] }, OR: konta } }) : 0
  wynik.wKolejceZFakturaBl = wynik.pozycje.filter((p) => p.grupa === 'NIESKONCZONE_Z_FAKTURA_BL' && KOLEJKA.includes(p.status)).length
  return wynik
}

/**
 * Zamknięcie jednego zamówienia pod blokadą: warunki sprawdzone jeszcze raz na świeżym wierszu (status otwarty, bez
 * aktywnej rezerwacji, bez odłożonej operacji, bez faktury i przesyłki z Kompletora). Sama zmiana statusu i wpis
 * w historii; żadnej kolejki zapisu do kanału, maila, faktury ani ruchu stanu. false = warunki już niespełnione.
 */
async function zamknij(db: PrismaClient, p: PozycjaPunktuCiecia, actorId: string, now: Date): Promise<boolean> {
  return runTx(db, async (tx) => {
    const o = await lockOrder(tx, p.orderId)
    if (!OTWARTE.includes(o.status) || o.pendingAction || o.blOrderId === null) return false
    const [aktywne, proby, przesylki, pakowanie, kopia] = await Promise.all([
      tx.reservation.count({ where: { orderId: o.id, state: { in: ['ACTIVE', 'CONSUMING'] } } }),
      tx.invoiceAttempt.count({ where: { orderId: o.id } }),
      tx.shipment.count({ where: { orderId: o.id } }),
      tx.orderEvent.count({ where: { orderId: o.id, kind: 'SPAKOWANE' } }),
      tx.blOrderSnapshot.findFirst({ where: { blOrderId: o.blOrderId }, select: { statusName: true } }),
    ])
    if (aktywne || proby || przesylki || pakowanie) return false
    // status w BL zmienił się od listy (odczyt w międzyczasie): zamówienie zostaje do kolejnego przebiegu
    if ((kopia?.statusName ?? null) !== p.statusBl) return false
    // zamknięte nie czeka już na towar: znaczniki zwolnienia po nieudanej płatności online schodzą razem ze statusem
    await tx.order.update({ where: { id: o.id }, data: { status: p.na!, companyStatus: null, stockReleaseAt: null, stockReleasedAt: null } })
    await tx.orderEvent.create({
      data: { orderId: o.id, kind: ZAMKNIETE_PRZY_PRZEJSCIU, actorId, createdAt: now, data: { z: o.status, na: p.na!, statusBl: p.statusBl, fakturaBl: p.fakturaBl } },
    })
    return true
  })
}

const NAZWY_ZAMKNIECIA: Partial<Record<OrderStatus, string>> = { WYSLANE: 'Wysłane', ODEBRANE: 'Odebrane', DO_ODBIORU: 'Do odbioru' }

const NAZWY_GRUP: Record<GrupaPunktuCiecia, string> = {
  DO_ZAMKNIECIA: 'Obsłużone w BaseLinkerze: do zamknięcia w Kompletorze',
  CZEKA_NA_ROZLICZENIE: 'Obsłużone w BaseLinkerze, stan jeszcze nierozliczony: powtórz polecenie po kolejnym odczycie',
  NIESKONCZONE_Z_FAKTURA_BL: 'Nieskończone w BaseLinkerze, z fakturą BL: decyzja według planu przełączenia',
  NIESKONCZONE_BEZ_FAKTURY: 'Nieskończone w BaseLinkerze, bez faktury: zostają do spakowania w Kompletorze',
  DO_SPRAWDZENIA: 'Do sprawdzenia ręcznie',
  BEZ_PARY_W_BL: 'Bez pary w BaseLinkerze (brak kopii zamówienia)',
}

/** Raport do terminala albo pliku: liczby per grupa i konto, potem numery zamówień (bez danych klientów). */
export function opisPunktuCiecia(w: WynikPunktuCiecia): string {
  const out: string[] = []
  out.push(`# Punkt cięcia zamówień ${w.naSucho ? '(na sucho: nic nie zapisano; zapis: --zapisz)' : '(wykonanie)'}`)
  out.push('')
  out.push(`Konta w podglądzie: ${w.konta.map((k) => `${k.channel}/${k.channelAccountId}`).join(', ') || 'brak'}${w.kontaWPracy ? `; konta w trybie pracy: ${w.kontaWPracy} (tylko zamówienia z rozliczoną fakturą BaseLinkera)` : ''}`)
  const s = w.swiezosc
  const kiedy = (d: Date | null) => (d ? czas(d) : 'nigdy')
  const stare = new Set(stareZrodla(s, w.sprawdzonoO))
  const zrodla = ZRODLA.map((z) => `${NAZWY_ZRODEL[z]} ${kiedy(s[z])}${stare.has(z) ? ' (za stare: blokuje zapis)' : ''}`).join(', ')
  out.push(`Ostatni udany odczyt z BaseLinkera (wszystkie konta firmy): ${zrodla}; zapis wymaga każdego z nich nie starszego niż ${Math.round(s.maksWiekMs / 60_000)} min`)
  if (s.perKonto.length) out.push(`Najnowszy wpis kopii zamówień BL per konto: ${s.perKonto.map((k) => `${k.channel}/${k.channelAccountId} ${kiedy(k.ostatniaKopia)}`).join(', ')}`)
  if (w.odmowa) out.push(`ODMOWA: ${w.odmowa}`)
  if (!w.naSucho && !w.odmowa) out.push(`Zamknięte teraz: ${w.zamkniete}${w.bledy.length ? `, błędy: ${w.bledy.length}` : ''}`)
  out.push(`Kontrola: zamówienia tych kont w kolejce pakowania (do realizacji, zbieranie, zebrane): ${w.wKolejcePakowania}`)
  if (w.wKolejceZFakturaBl)
    out.push(
      `W tym z fakturą BL (kończy je BaseLinker; po włączeniu trybu pracy Kompletor zdejmie je z kolejki „do spakowania” i wstrzyma ich pakowanie): ${w.wKolejceZFakturaBl}; pozostałe do spakowania w Kompletorze: ${w.wKolejcePakowania - w.wKolejceZFakturaBl}`,
    )
  out.push('')
  for (const g of Object.keys(NAZWY_GRUP) as GrupaPunktuCiecia[]) {
    const lista = w.pozycje.filter((p) => p.grupa === g)
    out.push(`## ${NAZWY_GRUP[g]}: ${lista.length}`)
    const perKonto = new Map<string, number>()
    for (const p of lista) perKonto.set(`${p.channel}/${p.channelAccountId}`, (perKonto.get(`${p.channel}/${p.channelAccountId}`) ?? 0) + 1)
    if (perKonto.size) out.push(`Konta: ${[...perKonto].map(([k, n]) => `${k} ${n}`).join(', ')}`)
    for (const p of lista)
      out.push(`- ${p.channel}/${p.channelAccountId} ${p.externalId} (BL ${p.blOrderId ?? '—'}): ${p.powod}${p.fakturaBl ? `, faktura ${p.fakturaBl}` : ''}${p.na ? ` → ${NAZWY_ZAMKNIECIA[p.na] ?? p.na}` : ''}`)
    out.push('')
  }
  // osobna lista do sprawdzenia, poza grupami (te same zamówienia są też w grupie „z fakturą BL”)
  const czekaly = w.pozycje.filter((p) => p.towarCzekal)
  out.push(`## Do sprawdzenia: zafakturowane w BaseLinkerze, a towar czekał na dostawę (sprawdź, czy dojechał, zanim BaseLinker je spakuje): ${czekaly.length}`)
  for (const p of czekaly) out.push(`- ${p.channel}/${p.channelAccountId} ${p.externalId} (BL ${p.blOrderId ?? '—'})${p.fakturaBl ? `, faktura ${p.fakturaBl}` : ''}`)
  out.push('')
  for (const b of w.bledy) out.push(`Błąd ${b.orderId}: ${b.blad}`)
  return out.join('\n')
}
