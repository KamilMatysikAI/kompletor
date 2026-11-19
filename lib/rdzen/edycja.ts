// Edycja pozycji zamówienia z karty: dodanie, usunięcie, zmiana ilości i podział na paczki. Każda zmiana
// w jednej transakcji, w kolejności blokad rdzenia (stan.ts): blokada doradcza zamówienia (`lockOrder`) → wiersze Stock
// rosnąco po productId (`StockBook`) → zapis. Rezerwacje i braki wyłącznie przez funkcje rdzenia (`reserveUnits`,
// `reduceUnits`, `addReservation`), bez obchodzenia księgi stanu. Podmiana produktu to istniejące `swapProduct`
// (brakuje.ts), dosłanie to `shipLater`.
//
// Zmiana jest tylko w Kompletorze: kanał (Allegro, Empik, sklep) jej nie dostanie. Dlatego zamówienie dostaje flagę
// `edytowaneLokalnie` i zdjęcie pozycji kanału sprzed pierwszej edycji (`pozycjeKanalu`): kolejna rewizja z kanału
// porównuje się z tym zdjęciem i przy zmianie w kanale idzie do „Do wyjaśnienia” zamiast nadpisać edycję
// (zamowienia.ts, `updateOrder`). Dziennik zmian (`AuditLog`) i historia (`OrderEvent`) bez danych klienta.
import type { Order, OrderLine, OrderStatus, Prisma } from '@prisma/client'
import { isLocalLine, kluczBlokadyPrzesylki, LINIA_KARTY, odmowaPodzialuPoEtykiecie, PRZESYLKA_AKTYWNA, przewoznicyAnulujaZKompletora } from './brakuje'
import { czyZamiennik, zrodloZamiany } from './zamiana'
import { dokumentSprzedazy } from './dokument-sprzedazy'
import { lockOrder } from './przejscia'
import { addReservation, type Flags, flagsOf, hasOpenShortage, hintAllocate, mergeFlags, reduceUnits, reserveUnits } from './rezerwacja'
import { advisoryLock, type CatalogEntry, type Db, DEFAULT_WAREHOUSE, loadCatalog, partsOf, qtyChannelPodzamowienia, runTx, StockBook, type Tx } from './stan'
import { BEFORE_PICKING, ON_CARD } from './statusy'
import { type Ctx, isPaid, refreshShortageWait } from './zamowienia'

/** Odmowa edycji z komunikatem dla karty (po polsku, bez nazw statusów z kodu). */
export class EdycjaError extends Error {}

/** Statusy, w których pozycje można zmieniać: przed wydrukiem karty i zbieraniem. */
export const STATUSY_EDYCJI: readonly OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'DO_WYJASNIENIA']

export const KOMUNIKAT_ZBIERANE = 'Zamówienie jest już zbierane, najpierw przerwij zbieranie'
export const POWOD_ZMIANY_W_KANALE = 'Zmiana w kanale po edycji w Kompletorze'
/** Wpis dziennika zmian (`AuditLog.entity`) dla pozycji zmienionej z karty; `entityId` = id pozycji. */
export const AUDIT_POZYCJA = 'ZAMOWIENIE_POZYCJA'
/** Wpis dziennika zmian dla podziału zamówienia; `entityId` = id zamówienia. */
export const AUDIT_PODZIAL = 'ZAMOWIENIE_PODZIAL'

/**
 * pozycja zamiennika („Zamień produkt”) ma ilość i cenę pozycji, którą zastępuje
 * (klient zapłacił za tamtą). Zmiana jej ceny, ilości, usunięcie albo przeniesienie do innej paczki dawałyby fakturę
 * na inną kwotę niż zapłacona, więc rdzeń ich odmawia. Cofnięcia zamiany w Kompletorze nie ma (sprawdzone: brak
 * takiej funkcji w lib/rdzen/brakuje.ts), komunikat mówi wprost, co zrobić zamiast.
 */
export const KOMUNIKAT_POZYCJA_ZAMIANY =
  'To pozycja z zamiany („Zamień produkt”): klient zapłacił za towar, który ona zastępuje, więc jej ilości ani ceny nie zmienisz, nie usuniesz jej i nie przeniesiesz do innej paczki. Zamiany nie da się cofnąć. Gdy klient chce inny towar albo inną cenę, różnicę rozlicz z nim poza zamówieniem. Gdy zamiennika zabraknie przy pakowaniu, przy braku wybierz jeszcze raz „Zamień produkt”.'
/** Pozycja pierwotna z zamiennikiem: bez niej kwoty zamiennika nie da się ustalić. */
export const KOMUNIKAT_POZYCJA_Z_ZAMIENNIKIEM =
  'Ta pozycja ma zamiennik („Zamień produkt”): bez niej nie da się ustalić kwoty faktury, więc jej nie usuniesz. Gdy klient rezygnuje z towaru, anuluj zamówienie albo rozlicz zwrot z klientem poza zamówieniem.'

/** Zamówienie po nieudanej płatności online, którego towar wrócił już do sprzedaży. */
export const KOMUNIKAT_TOWAR_ZWOLNIONY =
  'Towar tego zamówienia wrócił do sprzedaży, bo płatność online się nie udała. Pozycje zmienisz po wpłacie (wtedy towar zarezerwuje się od nowa) albo gdy klient wybierze przelew tradycyjny.'

const MAX_ILOSC = 1_000_000
const MAX_CENA_GR = 100_000_000 // 1 mln zł za sztukę: wyżej to pomyłka

export interface FaktyEdycji {
  /** Rezerwacje CONSUMING albo CONSUMED: faktura w drodze albo towar wydany. */
  poFakturze: number
}

/** Powód, dla którego pozycji zamówienia nie da się teraz zmienić; null = można. Czysta funkcja (karta i rdzeń). */
export function powodBlokadyEdycji(o: Pick<Order, 'status' | 'statusBeforeClarify' | 'pendingAction' | 'parentOrderId'> & Partial<Pick<Order, 'stockReleasedAt'>>, f: FaktyEdycji): string | null {
  if (o.status === 'ANULOWANE') return 'Zamówienie anulowane: pozycji nie da się zmienić'
  // nieudana płatność online: towar wrócił do sprzedaży, zamówienie nie ma rezerwacji do przeliczenia
  if (o.stockReleasedAt) return KOMUNIKAT_TOWAR_ZWOLNIONY
  const etap = o.status === 'DO_WYJASNIENIA' ? (o.statusBeforeClarify ?? 'NOWE') : o.status
  if (ON_CARD.includes(etap)) return KOMUNIKAT_ZBIERANE
  if (!STATUSY_EDYCJI.includes(o.status) || !BEFORE_PICKING.includes(etap)) return 'Zamówienie jest już spakowane albo zakończone: pozycji nie da się zmienić'
  if (o.pendingAction) return 'Anulowanie w toku: poczekaj na rozstrzygnięcie'
  if (f.poFakturze > 0) return 'Faktura w drodze albo wystawiona: pozycji nie da się zmienić'
  if (o.parentOrderId) return 'Pozycje zmienia się w pierwszej paczce zamówienia'
  return null
}

async function faktyEdycji(tx: Tx, orderId: string): Promise<FaktyEdycji> {
  return { poFakturze: await tx.reservation.count({ where: { orderId, state: { in: ['CONSUMING', 'CONSUMED'] } } }) }
}

/** Grosze z kwoty (`Decimal` z bazy albo liczba); bez błędów zmiennoprzecinkowych przy sumowaniu. */
export const grosze = (v: { toString(): string } | number): number => Math.round(Number(v.toString()) * 100)
const zl = (gr: number): string => (gr / 100).toFixed(2)

/** Cena brutto z formularza: liczba ≥ 0, najwyżej 2 miejsca po przecinku (przecinek albo kropka). */
export function cenaZTekstu(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null
  const gr = Math.round(Number(s) * 100)
  return gr <= MAX_CENA_GR ? gr : null
}

function ilosc(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
  if (!Number.isInteger(n) || n <= 0 || n > MAX_ILOSC) throw new EdycjaError('Ilość: liczba całkowita większa od zera')
  return n
}

/**
 * Zamówienie pod blokadą i gotowe do edycji: odmowa = `EdycjaError`. Przy pierwszej edycji zapamiętuje stan kanału
 * (`pozycjeKanalu`) i kwotę zapłaconą (`kwotaZaplacona`, zamówienie opłacone poza pobraniem).
 */
async function zamowienieDoEdycji(tx: Tx, orderId: string): Promise<Order & { lines: OrderLine[] }> {
  const o = await lockOrder(tx, orderId)
  const powod = powodBlokadyEdycji(o, await faktyEdycji(tx, orderId))
  if (powod) throw new EdycjaError(powod)
  return { ...o, lines: await tx.orderLine.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }) }
}


/**
 * zmiana pozycji po utworzeniu przesyłki. Twarda blokada tylko wtedy, gdy etykieta niesie
 * pieniądze: zamówienie za pobraniem albo aktywna przesyłka z kwotą pobrania (klient płaci kurierowi kwotę z etykiety).
 * Opłacone z góry: zmiana dozwolona, karta ostrzega o paczce i gabarycie. Ta sama reguła co podział
 * (`odmowaPodzialuPoEtykiecie`), komunikat zależy od tego, czy przewoźnik anuluje przesyłkę z Kompletora.
 */
export const KOMUNIKAT_PRZESYLKA_POZYCJE =
  'Zamówienie za pobraniem ma już przesyłkę u przewoźnika z kwotą pobrania z chwili utworzenia: pozycji nie zmienisz, bo klient zapłaciłby kurierowi starą kwotę. Anuluj przesyłkę („Anuluj przesyłkę” w sekcji „Przesyłka”), zmień pozycje i utwórz przesyłkę ponownie'
/** Przewoźnik bez anulowania z Kompletora (InPost ShipX, DPD, GLS): wyjście bez zmiany pozycji na karcie. */
export const KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA =
  'Zamówienie za pobraniem ma już przesyłkę u przewoźnika z kwotą pobrania z chwili utworzenia, a u tego przewoźnika przesyłkę anulujesz tylko w jego panelu: pozycji tu nie zmienisz. Dodatkowy towar wyślij osobnym zamówieniem (Zamówienia → Dodaj zamówienie), brak towaru rozstrzygnij decyzją o braku w tabeli pozycji, a kwotę pobrania zmień w panelu przewoźnika'
/** Opłacone z góry z aktywną przesyłką: zmiana pozycji przechodzi, karta pokazuje to ostrzeżenie. */
export const OSTRZEZENIE_PRZESYLKA_POZYCJE = 'Przesyłka jest już utworzona: sprawdź, czy towar mieści się w paczce i czy gabaryt z etykiety pasuje'

/** Komunikat blokady zmiany pozycji przy przesyłce z pobraniem: zależy od tego, czy przesyłkę da się anulować w Kompletorze. */
export function komunikatPozycjiPoEtykiecie(anulowalna: boolean): string {
  return anulowalna ? KOMUNIKAT_PRZESYLKA_POZYCJE : KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA
}

/** dokument sprzedaży (wFirma, KSeF, BaseLinker) wystawiony albo w drodze przed rozchodem towaru. */
export const KOMUNIKAT_DOKUMENT_POZYCJE =
  'Dokument sprzedaży jest już wystawiony albo w drodze (wFirma, KSeF albo BaseLinker): pozycji nie zmienisz, bo dokument ma skład i kwotę z chwili wystawienia. Zmianę robi korekta w programie, w którym dokument powstał'
export const KOMUNIKAT_FAKTURA_NIEWIADOMA_POZYCJE =
  'Poprzednia próba wystawienia faktury nie dostała odpowiedzi z wFirmy, więc faktura mogła powstać: pozycji nie zmienisz. Sprawdź w wFirmie, czy faktura jest, i kliknij „Ponów fakturę” w bloku „Faktura”; gdy ponowienie skończy się błędem (faktury nie ma), pozycje znów da się zmienić'

/**
 * Powód odmowy zmiany pozycji z dokumentu sprzedaży (wszystkie zamówienia) albo aktywnej przesyłki paczki z pobraniem;
 * null = można. `podBlokada` = po `lockOrder`.
 */
export async function powodDokumentuLubPrzesylki(db: Db | Tx, o: Pick<Order, 'id' | 'packageNo' | 'paymentState'>, opt: { podBlokada?: boolean } = {}): Promise<string | null> {
  const dok = await dokumentSprzedazy(db, [o.id], opt)
  if (dok === 'WFIRMA_NIEWIADOMA') return KOMUNIKAT_FAKTURA_NIEWIADOMA_POZYCJE
  if (dok) return KOMUNIKAT_DOKUMENT_POZYCJE
  // dodatkowa przesyłka (dosyłka) jest zawsze bez pobrania: zmiana pozycji nie rozjeżdża jej etykiety
  const przesylki = await db.shipment.findMany({ where: { orderId: o.id, packageNo: o.packageNo, extraNo: 0, state: { in: [...PRZESYLKA_AKTYWNA] } }, select: { adapterKey: true, codAmount: true } })
  const zPobraniem = o.paymentState === 'COD' || przesylki.some((s) => s.codAmount !== null && Number(s.codAmount) > 0)
  if (!przesylki.length || !zPobraniem) return null
  return komunikatPozycjiPoEtykiecie(await przewoznicyAnulujaZKompletora([...new Set(przesylki.map((s) => s.adapterKey))]))
}

/**
 * Zamówienie do zmiany pozycji (dodanie, ilość, cena, usunięcie): bramka statusu i dodatkowo dokument albo przesyłka.
 * Najpierw blokada przesyłki (ta sama co rezerwacja wiersza przy „Utwórz przesyłkę”), potem zamówienia: zmiana i
 * utworzenie przesyłki się wykluczają, a nadanie porównuje jeszcze podpis pozycji z odczytu sprzed bramki.
 */
async function zamowienieDoZmianyPozycji(tx: Tx, orderId: string): Promise<Order & { lines: OrderLine[] }> {
  await advisoryLock(tx, kluczBlokadyPrzesylki(orderId))
  const o = await zamowienieDoEdycji(tx, orderId)
  const powod = await powodDokumentuLubPrzesylki(tx, o, { podBlokada: true })
  if (powod) throw new EdycjaError(powod)
  return o
}

function flagiPierwszejEdycji(o: Order & { lines: OrderLine[] }): Flags {
  const f = flagsOf(o)
  const patch: Flags = { edytowaneLokalnie: true }
  if (!f.pozycjeKanalu) {
    const zdjecie: Record<string, [string | null, number]> = {}
    for (const l of o.lines) if (!l.removed && !isLocalLine(l)) zdjecie[l.externalLineId] = [l.productId, l.qty]
    patch.pozycjeKanalu = zdjecie
  }
  if (f.kwotaZaplacona === undefined && isPaid(o.paymentState) && o.paymentState !== 'COD') patch.kwotaZaplacona = zl(grosze(o.totalGross))
  return patch
}

async function zapiszPoEdycji(
  tx: Tx,
  book: StockBook,
  o: Order & { lines: OrderLine[] },
  zmiana: { roznicaGr: number; flagi?: Flags; kind: string; data: Prisma.InputJsonValue; audyt: { entityId: string; before: Prisma.InputJsonValue | null; after: Prisma.InputJsonValue } },
  ctx: Ctx,
  now: Date,
): Promise<void> {
  const total = grosze(o.totalGross) + zmiana.roznicaGr
  if (total < 0) throw new EdycjaError('Kwota zamówienia wyszłaby ujemna')
  const actorId = ctx.actorId ?? 'panel'
  const brakuje = await hasOpenShortage(tx, o.id)
  await tx.order.update({
    where: { id: o.id },
    data: { totalGross: zl(total), flags: mergeFlags(o, { ...flagiPierwszejEdycji(o), ...zmiana.flagi, brakuje }) },
  })
  await refreshShortageWait(tx, o.id, now)
  await book.flush(tx, now)
  await tx.orderEvent.create({ data: { orderId: o.id, kind: zmiana.kind, actorId, data: zmiana.data } })
  await tx.auditLog.create({
    data: {
      entity: AUDIT_POZYCJA,
      entityId: zmiana.audyt.entityId,
      actorId,
      before: zmiana.audyt.before === null ? undefined : { ...(zmiana.audyt.before as object), suma: zl(grosze(o.totalGross)) },
      after: { ...(zmiana.audyt.after as object), suma: zl(total), zamowienie: o.id },
    },
  })
  await hintAllocate(tx, o.id, now) // nowy brak może dostać towar już leżący na stanie
}

export interface NowaPozycja {
  /** Produkt z katalogu firmy (ilość w jednostce bazowej; zestaw = sztuki zestawu). */
  productId?: string | null
  /** Albo oferta kanału zamówienia (`ChannelOffer.externalId`): ilość w sztukach oferty. */
  offerId?: string | null
  qty: number
  /** Cena brutto za sztukę (pozycji, nie jednostki bazowej) w groszach. */
  priceGrossGr: number
}

/** Dodanie pozycji: rezerwacja w tej samej transakcji (czego nie ma na stanie → „brakuje”). */
export async function addOrderLine(db: Db, orderId: string, p: NowaPozycja, ctx: Ctx = {}): Promise<{ lineId: string; reserved: number; short: number }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const qty = ilosc(p.qty)
  if (!Number.isInteger(p.priceGrossGr) || p.priceGrossGr < 0 || p.priceGrossGr > MAX_CENA_GR) throw new EdycjaError('Cena: liczba nieujemna, najwyżej 2 miejsca po przecinku')
  return runTx(db, async (tx) => {
    const o = await zamowienieDoZmianyPozycji(tx, orderId)
    let productId: string
    let qtyBase = qty
    let offerId: string | null = null
    if (p.productId) productId = p.productId
    else if (p.offerId) {
      const off = await tx.channelOffer.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId, externalId: p.offerId, active: true }, select: { productId: true, qtyBasePerOffer: true, externalId: true } })
      if (!off) throw new EdycjaError('Nie ma takiej oferty na koncie tego zamówienia')
      productId = off.productId
      qtyBase = qty * off.qtyBasePerOffer
      offerId = off.externalId
    } else throw new EdycjaError('Wybierz produkt')
    const prod = await tx.product.findUnique({ where: { id: productId }, select: { id: true, active: true, vatRate: true } })
    if (!prod?.active) throw new EdycjaError('Nie ma takiego aktywnego produktu w katalogu')
    const entry = (await loadCatalog(tx, [productId])).get(productId)!
    const book = await StockBook.lock(tx, wh, partsOf(entry).map((x) => x.productId))
    const n = (await tx.orderLine.count({ where: { orderId, externalLineId: { contains: LINIA_KARTY } } })) + 1
    const line = await tx.orderLine.create({
      // cena za sztukę oferty (jak pozycje z kanału: `qty` w jednostce bazowej, cena za sztukę oferty, lib/wfirma/faktura.ts)
      data: { orderId, externalLineId: `kompletor${LINIA_KARTY}${n}`, offerId, productId, qty: qtyBase, qtyChannel: offerId ? qty : null, unitPriceGross: zl(p.priceGrossGr), vatRate: prod.vatRate },
    })
    const r = await reserveUnits(tx, book, orderId, line.id, entry, qtyBase)
    await zapiszPoEdycji(
      tx,
      book,
      o,
      {
        roznicaGr: p.priceGrossGr * qty,
        kind: 'POZYCJA_DODANA',
        data: { lineId: line.id, productId, qty: qtyBase, reserved: r.reservedUnits, short: r.shortUnits },
        audyt: { entityId: line.id, before: null, after: { productId, qty: qtyBase, cena: line.unitPriceGross.toString() } },
      },
      ctx,
      now,
    )
    return { lineId: line.id, reserved: r.reservedUnits, short: r.shortUnits }
  })
}

async function pozycjaZamowienia(tx: Tx, o: Order & { lines: OrderLine[] }, lineId: string): Promise<{ line: OrderLine; entry: CatalogEntry; naOferte: number }> {
  const line = o.lines.find((l) => l.id === lineId)
  if (!line || line.removed) throw new EdycjaError('Nie ma takiej pozycji w zamówieniu')
  if (!line.productId) throw new EdycjaError('Pozycja bez produktu: najpierw powiąż ofertę z produktem')
  return { line, entry: (await loadCatalog(tx, [line.productId])).get(line.productId)!, naOferte: await naOferte(tx, o, line) }
}

/**
 * Ile jednostek bazowych to sztuka oferty pozycji (`qtyBasePerOffer`); pozycja wprost z produktem = 1. Cena pozycji
 * jest za sztukę oferty, więc kwota pozycji = `qty / naOferte × cena` (ta sama reguła co faktura, lib/wfirma/podglad.ts).
 */
async function naOferte(tx: Tx, o: Pick<Order, 'channel' | 'channelAccountId'>, line: Pick<OrderLine, 'productId' | 'offerId'>): Promise<number> {
  if (!line.productId || !line.offerId) return 1
  const off = await tx.channelOffer.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId, externalId: line.offerId }, select: { qtyBasePerOffer: true } })
  return off?.qtyBasePerOffer && off.qtyBasePerOffer > 0 ? off.qtyBasePerOffer : 1
}

/** Zmiana ilości pozycji (jednostka bazowa; zestaw = sztuki zestawu). Więcej = rezerwacja, mniej = najpierw braki, potem rezerwacja. */
export async function changeLineQty(db: Db, orderId: string, lineId: string, nowaIlosc: number, ctx: Ctx = {}): Promise<{ reserved: number; short: number }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const qty = ilosc(nowaIlosc)
  return runTx(db, async (tx) => {
    const o = await zamowienieDoZmianyPozycji(tx, orderId)
    const { line, entry, naOferte: per } = await pozycjaZamowienia(tx, o, lineId)
    if (czyZamiennik(line.externalLineId)) throw new EdycjaError(KOMUNIKAT_POZYCJA_ZAMIANY)
    if (qty === line.qty) return { reserved: 0, short: 0 }
    if (qty <= line.qtyRejected) throw new EdycjaError('Część tej pozycji jest już dosłana albo zamieniona: nowa ilość musi być większa')
    if ((qty - line.qty) % per !== 0) throw new EdycjaError(`Ilość tej pozycji zmienia się o całe sztuki oferty (po ${per})`)
    const book = await StockBook.lock(tx, wh, partsOf(entry).map((x) => x.productId))
    let r = { reservedUnits: 0, shortUnits: 0 }
    if (qty > line.qty) r = await reserveUnits(tx, book, orderId, line.id, entry, qty - line.qty)
    else await reduceUnits(tx, book, line.id, entry, line.qty - qty, 'LINE_CHANGED', now)
    // ilość w sztukach oferty idzie za zmianą (zmiana jest o całe sztuki oferty, sprawdzone wyżej)
    const qtyChannel = !line.offerId ? line.qtyChannel : line.qtyChannel !== null ? line.qtyChannel + (qty - line.qty) / per : qty % per === 0 ? qty / per : null
    await tx.orderLine.update({ where: { id: line.id }, data: { qty, qtyChannel } })
    await zapiszPoEdycji(
      tx,
      book,
      o,
      {
        roznicaGr: (grosze(line.unitPriceGross) * (qty - line.qty)) / per,
        kind: 'ZMIANA_ILOSCI',
        data: { lineId: line.id, productId: line.productId, z: line.qty, na: qty, reserved: r.reservedUnits, short: r.shortUnits },
        audyt: { entityId: line.id, before: { productId: line.productId, qty: line.qty }, after: { productId: line.productId, qty } },
      },
      ctx,
      now,
    )
    return { reserved: r.reservedUnits, short: r.shortUnits }
  })
}

/** Stawki VAT pozycji (te same co karta produktu, lib/produkty/karta.ts). */
export const STAWKI_VAT_POZYCJI = ['23', '8', '5', '0', 'zw', 'np'] as const

/**
 * stawka z kanału bywa zapisana jako „23.00” (Allegro `tax.rate`, Shoper `tax_value`) albo „23,0”.
 * Zwraca postać z listy („23”), gdy liczba jest całkowita; „zw”, „np” i inne teksty bez zmian (bez spacji na brzegach);
 * pusta albo `null` → `null`. Porównania stawek (formularz, zapis sekcji, rdzeń) idą zawsze po tej postaci, inaczej każdy
 * zapis karty zmieniałby „23.00” na „23” i oznaczał zamówienie jako edytowane.
 */
export function normalizujStawke(v: string | null | undefined): string | null {
  const t = String(v ?? '').trim()
  if (!t) return null
  const m = /^(\d{1,3})(?:[.,]0+)?$/.exec(t)
  if (m) return String(Number(m[1]))
  return t.toLowerCase() === 'zw' || t.toLowerCase() === 'np' ? t.toLowerCase() : t
}

export { PRZESYLKA_AKTYWNA }
export const KOMUNIKAT_KONFLIKT_POZYCJI = 'Ktoś zmienił tę pozycję w międzyczasie: odśwież kartę i wpisz zmianę ponownie'

export interface NowaCena {
  /** Nowa cena brutto za sztukę pozycji (sztukę oferty) w groszach; brak = bez zmiany ceny. */
  priceGrossGr?: number
  /** Nowa stawka VAT pozycji; brak = bez zmiany stawki. */
  vatRate?: string
  /**
   * cena i stawka, które osoba widziała na karcie (z renderu). Gdy pozycja pod blokadą ma inną
   * wartość, ktoś zmienił ją w międzyczasie: odmowa zamiast cichego cofnięcia cudzej zmiany. Brak = bez sprawdzenia.
   */
  bylo?: { priceGrossGr?: number; vatRate?: string | null }
}

/**
 * zmiana ceny brutto i stawki VAT pozycji (BL „Operacje na produktach”). Ta sama bramka co zmiana ilości
 * (status przed zbieraniem, bez faktury, pierwsza paczka) i dodatkowo: bez wystawionego albo wysyłanego dokumentu
 * sprzedaży (wFirma, KSeF, BaseLinker: `powodDokumentuLubPrzesylki`) i bez aktywnej przesyłki, bez części pozycji już dosłanej albo zamienionej (`qtyRejected`: zwrot za
 * te sztuki liczył się po starej cenie). Zestaw zmienia tylko cenę: VAT zestawu na fakturze wynika ze składników
 * (lib/wfirma/faktura.ts). Kwota zamówienia zmienia się o różnicę × ilość / sztuki oferty; dokument sprzedaży, który
 * powstanie później, bierze nową cenę i stawkę z pozycji. W kanale cena zostaje bez zmian (jak każda edycja z karty).
 */
export async function changeLinePrice(db: Db, orderId: string, lineId: string, nowa: NowaCena, ctx: Ctx = {}): Promise<{ zmiana: boolean }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  if (nowa.priceGrossGr !== undefined && (!Number.isInteger(nowa.priceGrossGr) || nowa.priceGrossGr < 0 || nowa.priceGrossGr > MAX_CENA_GR)) throw new EdycjaError('Cena: liczba nieujemna, najwyżej 2 miejsca po przecinku')
  if (nowa.vatRate !== undefined && !(STAWKI_VAT_POZYCJI as readonly string[]).includes(nowa.vatRate)) throw new EdycjaError('Stawka VAT: wybierz jedną z listy')
  return runTx(db, async (tx) => {
    const o = await zamowienieDoZmianyPozycji(tx, orderId)
    const line = o.lines.find((l) => l.id === lineId)
    if (!line || line.removed) throw new EdycjaError('Nie ma takiej pozycji w zamówieniu')
    if (czyZamiennik(line.externalLineId)) throw new EdycjaError(KOMUNIKAT_POZYCJA_ZAMIANY)
    if (line.qtyRejected > 0) throw new EdycjaError('Część tej pozycji jest już dosłana albo zamieniona: ceny nie zmienisz')
    // dokument sprzedaży i aktywna przesyłka: wspólna bramka zmian pozycji (zamowienieDoZmianyPozycji)
    if (nowa.bylo) {
      const { priceGrossGr: cenaBylo, vatRate: vatBylo } = nowa.bylo
      if ((cenaBylo !== undefined && cenaBylo !== grosze(line.unitPriceGross)) || (vatBylo !== undefined && normalizujStawke(vatBylo) !== normalizujStawke(line.vatRate))) throw new EdycjaError(KOMUNIKAT_KONFLIKT_POZYCJI)
    }
    const entry = line.productId ? (await loadCatalog(tx, [line.productId])).get(line.productId) : undefined
    const staraCena = grosze(line.unitPriceGross)
    const nowaCena = nowa.priceGrossGr ?? staraCena
    const staryVat = line.vatRate
    // „23” z listy przy zapisanym „23.00” z kanału to ta sama stawka (zostaje zapis z kanału)
    const vatInny = nowa.vatRate !== undefined && nowa.vatRate !== normalizujStawke(staryVat)
    if (entry?.kind === 'BUNDLE' && vatInny) throw new EdycjaError('Zestaw: stawki VAT wynikają ze składników, zmienia się tylko cenę')
    const nowyVat = vatInny ? nowa.vatRate! : staryVat
    if (nowaCena === staraCena && nowyVat === staryVat) return { zmiana: false }
    const per = await naOferte(tx, o, line)
    const book = await StockBook.lock(tx, wh, []) // bez ruchu stanu: pusta księga dla wspólnego zapisu po edycji
    await tx.orderLine.update({ where: { id: line.id }, data: { unitPriceGross: zl(nowaCena), vatRate: nowyVat } })
    await zapiszPoEdycji(
      tx,
      book,
      o,
      {
        // zaokrąglenie kwot pozycji tak jak suma pozycji na karcie (dane.ts), nie samej różnicy
        roznicaGr: Math.round((nowaCena * line.qty) / per) - Math.round((staraCena * line.qty) / per),
        kind: 'ZMIANA_CENY',
        data: { lineId: line.id, productId: line.productId, cenaZ: zl(staraCena), cenaNa: zl(nowaCena), vatZ: staryVat, vatNa: nowyVat },
        audyt: { entityId: line.id, before: { productId: line.productId, cena: zl(staraCena), vat: staryVat }, after: { productId: line.productId, cena: zl(nowaCena), vat: nowyVat } },
      },
      ctx,
      now,
    )
    return { zmiana: true }
  })
}

/**
 * Usunięcie pozycji: braki zamknięte, rezerwacja zwolniona (`reduceUnits`), pozycja `removed` i na liście
 * `usunieteLokalnie` (karta pisze „usunięta w Kompletorze”, nie „w kanale”). Ostatniej pozycji nie usuwa: wtedy anulowanie.
 */
export async function removeOrderLine(db: Db, orderId: string, lineId: string, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  await runTx(db, async (tx) => {
    const o = await zamowienieDoZmianyPozycji(tx, orderId)
    const line = o.lines.find((l) => l.id === lineId)
    if (!line || line.removed) throw new EdycjaError('Nie ma takiej pozycji w zamówieniu')
    if (czyZamiennik(line.externalLineId)) throw new EdycjaError(KOMUNIKAT_POZYCJA_ZAMIANY)
    if (o.lines.some((l) => !l.removed && zrodloZamiany(l.externalLineId) === line.externalLineId)) throw new EdycjaError(KOMUNIKAT_POZYCJA_Z_ZAMIENNIKIEM)
    if (o.lines.filter((l) => !l.removed).length <= 1) throw new EdycjaError('Zamówienie musi mieć pozycję: anuluj je zamiast usuwać ostatnią')
    const entry = line.productId ? (await loadCatalog(tx, [line.productId])).get(line.productId) : undefined
    const book = await StockBook.lock(tx, wh, entry ? partsOf(entry).map((x) => x.productId) : [])
    const units = line.qty - line.qtyRejected
    const per = await naOferte(tx, o, line)
    if (entry && units > 0) await reduceUnits(tx, book, line.id, entry, units, 'LINE_CHANGED', now)
    await tx.orderLine.update({ where: { id: line.id }, data: { removed: true } })
    await zapiszPoEdycji(
      tx,
      book,
      o,
      {
        roznicaGr: -Math.round((grosze(line.unitPriceGross) * units) / per),
        flagi: { usunieteLokalnie: [...(flagsOf(o).usunieteLokalnie ?? []), line.id] },
        kind: 'POZYCJA_USUNIETA',
        data: { lineId: line.id, productId: line.productId, qty: units },
        audyt: { entityId: line.id, before: { productId: line.productId, qty: line.qty }, after: { productId: line.productId, qty: 0, usunieta: true } },
      },
      ctx,
      now,
    )
  })
}

/**
 * Podział zamówienia: wybrane sztuki pozycji przechodzą na nową paczkę — ta sama mechanika co „dośle
 * później” (`shipLater`, brakuje.ts): podzamówienie z `parentOrderId` i kolejnym `packageNo`, pozycja matki ma
 * `qtyRejected` większe (ilość zostaje równa kanałowi), pieniądze zostają na pierwszej paczce (kwota podzamówienia 0).
 * Rezerwacje i braki przenoszone w tej samej transakcji: suma `reserved` w Stock bez zmian. Tylko zamówienie opłacone
 * albo za pobraniem, „Do realizacji”, w pierwszej paczce zostaje co najmniej jedna sztuka.
 */
export async function splitOrder(db: Db, orderId: string, wybor: Record<string, number>, ctx: Ctx = {}): Promise<{ childOrderId: string; packageNo: number }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const o = await zamowienieDoEdycji(tx, orderId)
    if (o.status !== 'DO_REALIZACJI') throw new EdycjaError('Podzielić można zamówienie „Do realizacji” (opłacone albo za pobraniem)')
    if (o.paymentState !== 'PAID' && o.paymentState !== 'COD') throw new EdycjaError('Podzielić można tylko zamówienie opłacone albo za pobraniem')
    // etykieta paczki ma kwotę pobrania sprzed podziału
    const odmowaEtykiety = await odmowaPodzialuPoEtykiecie(tx, o)
    if (odmowaEtykiety) throw new EdycjaError(odmowaEtykiety)
    const ruch = Object.entries(wybor).filter(([, n]) => n > 0)
    if (!ruch.length) throw new EdycjaError('Zaznacz pozycje do nowej paczki')
    const aktywne = o.lines.filter((l) => !l.removed)
    const zostaje = new Map(aktywne.map((l) => [l.id, l.qty - l.qtyRejected]))
    const pozycje: { line: OrderLine; entry: CatalogEntry; units: number; per: number }[] = []
    for (const [lineId, n] of ruch) {
      const { line, entry, naOferte: per } = await pozycjaZamowienia(tx, o, lineId)
      if (czyZamiennik(line.externalLineId)) throw new EdycjaError(KOMUNIKAT_POZYCJA_ZAMIANY)
      const units = ilosc(n)
      if (units > (zostaje.get(line.id) ?? 0)) throw new EdycjaError('Do nowej paczki można przenieść najwyżej tyle, ile jest w pozycji')
      if (entry.kind === 'DIGITAL') throw new EdycjaError('Usługa (np. e-book) nie idzie w paczce: zostaje w pierwszej')
      zostaje.set(line.id, (zostaje.get(line.id) ?? 0) - units)
      pozycje.push({ line, entry, units, per })
    }
    if ([...zostaje.values()].every((n) => n <= 0)) throw new EdycjaError('W pierwszej paczce musi zostać co najmniej jedna pozycja')
    const book = await StockBook.lock(tx, wh, pozycje.flatMap((p) => partsOf(p.entry).map((x) => x.productId)))
    const n = (await tx.order.count({ where: { parentOrderId: o.id } })) + 2
    const child = await tx.order.create({
      data: {
        channel: o.channel,
        channelAccountId: o.channelAccountId,
        externalId: `${o.externalId}#paczka-${n}`,
        status: 'DO_REALIZACJI',
        carrier: o.carrier,
        shippingModule: o.shippingModule,
        deliveryMethod: o.deliveryMethod,
        paymentState: o.paymentState,
        paymentMethod: o.paymentMethod,
        totalGross: '0.00',
        createdAtChannel: o.createdAtChannel,
        parentOrderId: o.id,
        packageNo: n,
        // przewoźnik wybrany na karcie (zmiana sposobu wysyłki) idzie do paczki razem z przewoźnikiem
        flags: flagsOf(o).przewoznikRecznie ? { przewoznikRecznie: true } : {},
      },
    })
    for (const p of pozycje) {
      const childLine = await tx.orderLine.create({
        data: { orderId: child.id, externalLineId: `${p.line.externalLineId}#paczka`, offerId: p.line.offerId, productId: p.line.productId, qty: p.units, qtyChannel: qtyChannelPodzamowienia(p.line.offerId, p.units, p.per), unitPriceGross: p.line.unitPriceGross, vatRate: p.line.vatRate },
      })
      for (const part of partsOf(p.entry)) {
        let left = p.units * part.perUnit
        // najpierw braki (towar, który i tak ma przyjść), potem rezerwacja: kolejność jak `reduceUnits`
        const braki = await tx.shortage.findMany({ where: { orderLineId: p.line.id, productId: part.productId, state: 'OPEN' }, orderBy: { createdAt: 'desc' } })
        for (const s of braki) {
          if (left <= 0) break
          const take = Math.min(left, s.qtyBase)
          if (take === s.qtyBase) await tx.shortage.update({ where: { id: s.id }, data: { orderId: child.id, orderLineId: childLine.id, note: 'przeniesione przy podziale' } })
          else {
            await tx.shortage.update({ where: { id: s.id }, data: { qtyBase: s.qtyBase - take } })
            await tx.shortage.create({ data: { orderId: child.id, orderLineId: childLine.id, productId: part.productId, qtyBase: take, state: 'OPEN', note: 'przeniesione przy podziale' } })
          }
          left -= take
        }
        if (left <= 0) continue
        const res = await tx.reservation.findFirst({ where: { orderLineId: p.line.id, productId: part.productId, warehouseId: wh, state: 'ACTIVE' } })
        if (!res || res.qtyBase < left) throw new EdycjaError('Za mała rezerwacja na tej pozycji: odśwież kartę')
        if (res.qtyBase === left) await tx.reservation.update({ where: { id: res.id }, data: { state: 'RELEASED', releasedReason: 'MOVED_TO_SHORTAGE', releasedAt: now } })
        else await tx.reservation.update({ where: { id: res.id }, data: { qtyBase: res.qtyBase - left } })
        book.change(part.productId, { reserved: -left })
        await addReservation(tx, book, { orderId: child.id, orderLineId: childLine.id, productId: part.productId, qty: left })
      }
      await tx.orderLine.update({ where: { id: p.line.id }, data: { qtyRejected: { increment: p.units } } })
    }
    const actorId = ctx.actorId ?? 'panel'
    await tx.order.update({ where: { id: child.id }, data: { flags: mergeFlags(child, { brakuje: await hasOpenShortage(tx, child.id) }) } })
    await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(o, { brakuje: await hasOpenShortage(tx, o.id) }) } })
    await refreshShortageWait(tx, o.id, now)
    await refreshShortageWait(tx, child.id, now)
    await book.flush(tx, now)
    const przeniesione = pozycje.map((p) => ({ lineId: p.line.id, productId: p.line.productId, units: p.units }))
    await tx.orderEvent.create({ data: { orderId: o.id, kind: 'PODZIAL', actorId, data: { childOrderId: child.id, packageNo: n, pozycje: przeniesione } } })
    await tx.orderEvent.create({ data: { orderId: child.id, kind: 'PODZIAL_NOWA_PACZKA', actorId, data: { parentOrderId: o.id, packageNo: n } } })
    await tx.auditLog.create({ data: { entity: AUDIT_PODZIAL, entityId: o.id, actorId, after: { childOrderId: child.id, packageNo: n, pozycje: przeniesione } } })
    return { childOrderId: child.id, packageNo: n }
  })
}

/**
 * Rewizja z kanału po edycji z karty (wołane z `updateOrder`, zamowienia.ts): różnice między pozycjami kanału teraz
 * a zdjęciem sprzed pierwszej edycji. Pusta lista = kanał pozycji nie zmienił, edycja z karty zostaje.
 */
export function zmianyWKanale(zdjecie: Record<string, [string | null, number]>, przychodzace: { externalLineId: string; productId: string | null; qtyBase: number }[]): string[] {
  const out: string[] = []
  const teraz = new Map(przychodzace.map((l) => [l.externalLineId, l]))
  for (const [ext, [productId, qty]] of Object.entries(zdjecie)) {
    const inc = teraz.get(ext)
    if (!inc) out.push(`usunięta ${ext}`)
    else if ((inc.productId ?? null) !== productId) out.push(`zmiana produktu ${ext}`)
    else if (inc.qtyBase !== qty) out.push(`ilość ${ext}`)
  }
  for (const inc of przychodzace) if (!Object.hasOwn(zdjecie, inc.externalLineId)) out.push(`nowa ${inc.externalLineId}`)
  return out
}
