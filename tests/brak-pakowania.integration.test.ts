// brak towaru przy pakowaniu. Reszta zamówienia wychodzi zamiast „NIE PAKUJ”, obsługa decyduje o braku.
//  - cień: stanowisko i decyzje nie dotykają rdzenia (porównanie bazy przed i po);
//  - PRACA: brak schodzi do rdzenia, spakowanie zamyka braki, dosłanie i zamiana trzymają niezmienniki i nie wyglądają
//    jak edycja przy kolejnej rewizji z kanału; podwójne zgłoszenie i podwójna decyzja nic nie dublują.
// Dane wyłącznie testowe (zmyślone produkty i numery zamówień).
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { orderListLines } from '@/lib/panel/lista-zamowien'
import { shortagesData } from '@/lib/panel/dane'
import { checkInvariants } from '@/lib/rdzen/niezmienniki'
import { markMissingOnShelf, markRefunded, shipLater, ShortageActionError } from '@/lib/rdzen/brakuje'
import { cancelPicking } from '@/lib/rdzen/przejscia'
import { allocate } from '@/lib/rdzen/przydzial'
import { beginInvoice, packOrder } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { BladStanowiska, doPoprawy, naPolceNieBylo, otworzZSesji, rozpoznajSkan, sesjaZamowien, zakonczCwiczenie, type WynikSkanu } from '@/lib/stanowisko/cwiczenie'
import { zdecydujOBraku } from '@/lib/stanowisko/decyzje'
import { drukujKarty, uwagiKarty } from '@/lib/stanowisko/karty'
import { gabarytyDla } from '@/lib/stanowisko/gabaryty'
import { wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { ORG_B, testDb, truncateAll } from './db'
import { ACC, bundle, order, product, seedBase } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Magazyn Testowy' }
const BIURO = 'biuro-testowe'

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterEach(async () => {
  expect(await checkInvariants(a)).toEqual([])
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function stanRdzenia(db: PrismaClient) {
  const byId = { orderBy: { id: 'asc' as const } }
  return JSON.stringify({
    orders: await db.order.findMany(byId),
    lines: await db.orderLine.findMany(byId),
    reservations: await db.reservation.findMany(byId),
    stocks: await db.stock.findMany({ orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }] }),
    shortages: await db.shortage.findMany(byId),
    pending: await db.pendingMovement.findMany(byId),
    events: await db.orderEvent.findMany(byId),
    alerts: await db.alert.findMany(byId),
  })
}

function ok(w: WynikSkanu): Extract<WynikSkanu, { typ: 'ok' }> {
  if (w.typ !== 'ok') throw new Error(`oczekiwane ok, jest: ${w.blokada.rodzaj} — ${w.blokada.komunikat}`)
  return w
}

type Linie = Parameters<typeof order>[0]
type Opcje = Parameters<typeof order>[1]
async function zamowienie(db: PrismaClient, externalId: string, lines: Linie, over: Opcje = {}) {
  const r = await ingestOrder(db, order(lines, { externalId, createdAtChannel: new Date(), ...over }))
  return r.orderId!
}

const praca = () => a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })
const gabaryt = gabarytyDla('ALLEGRO')[0]!
const linia = (orderId: string) => a.orderLine.findFirstOrThrow({ where: { orderId } })
const stan = (productId: string) => a.stock.findFirstOrThrow({ where: { productId } })

/** Zamówienie w PRACY: p1 × 2 i p2 × 1, po druku i zeskanowaniu karty. */
async function otwartePraca(over: Opcje = {}) {
  await praca()
  const p1 = await product(a, 'HERB-1', 5)
  const p2 = await product(a, 'KUBEK', 5)
  const id = await zamowienie(a, '7001', [{ productId: p1, qty: 2 }, { productId: p2, qty: 1 }], { channel: 'ALLEGRO', ...over })
  const { wydruki } = await drukujKarty(a, [id], KTO)
  const w = ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
  const kl = (p: string) => w.zamowienie.pozycje.find((x) => x.productId === p)!.klucz
  return { id, p1, p2, drillId: w.cwiczenie.drillId, kl1: kl(p1), kl2: kl(p2), kod: wydruki[0]!.kod }
}

describe('cień: reszta się pakuje, rdzeń bez zmian', () => {
  it('część pozycji w „brakuje” nie blokuje: okno z resztą, brak osobno, spakowanie bez zmian w rdzeniu', async () => {
    const p1 = await product(a, 'HERB-1', 1)
    const p2 = await product(a, 'KUBEK', 5)
    const id = await zamowienie(a, '2001', [{ productId: p1, qty: 3 }, { productId: p2, qty: 1 }])
    const { wydruki } = await drukujKarty(a, [id], KTO)
    const przed = await stanRdzenia(a)
    const w = ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
    expect(w.zamowienie.pozycje.map((p) => [p.sku, p.ilosc]).sort()).toEqual([['HERB-1', 1], ['KUBEK', 1]])
    expect(w.zamowienie.brakujace.map((x) => [x.sku, x.ilosc])).toEqual([['HERB-1', 2]])
    const zebrane = Object.fromEntries(w.zamowienie.pozycje.map((p) => [p.klucz, p.ilosc]))
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gabarytyDla(w.zamowienie.carrier)[0], zebrane, userId: KTO.userId })
    expect(await stanRdzenia(a)).toBe(przed)
  })

  it('brakuje wszystkiego = NIE PAKUJ i bez pustej karty', async () => {
    const p1 = await product(a, 'HERB-1', 0)
    const p2 = await product(a, 'KUBEK', 5)
    const pusty = await zamowienie(a, '2002', [{ productId: p1, qty: 1 }])
    const inny = await zamowienie(a, '2003', [{ productId: p2, qty: 1 }])
    const { wydruki, pominiete } = await drukujKarty(a, [pusty, inny], KTO)
    expect(wydruki.map((w) => w.orderId)).toEqual([inny])
    expect(pominiete.map((x) => x.orderId)).toEqual([pusty])
    const [s] = await sesjaZamowien(a, [pusty])
    expect(s).toMatchObject({ czerwona: true, komunikat: expect.stringMatching(/^NIE PAKUJ.*brakuje wszystkich/) })
  })

  it('decyzja w cieniu: zapis bez rdzenia, drugi klik nic nie robi, „poczekaj” zatrzymuje stanowisko do zmiany decyzji', async () => {
    const p1 = await product(a, 'HERB-1', 1)
    const id = await zamowienie(a, '2004', [{ productId: p1, qty: 3 }])
    const l = await linia(id)
    const przed = await stanRdzenia(a)
    expect(await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'POCZEKAJ', userId: BIURO })).toEqual({ zmiana: true, dryRun: true })
    expect(await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'POCZEKAJ', userId: BIURO })).toEqual({ zmiana: false, dryRun: true })
    expect(await a.shortageDecision.count()).toBe(1)
    const [s] = await sesjaZamowien(a, [id])
    expect(s).toMatchObject({ czerwona: true, komunikat: expect.stringContaining('czeka na towar') })
    await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'WYSLIJ_RESZTE', userId: BIURO })
    expect((await sesjaZamowien(a, [id]))[0]).toMatchObject({ czerwona: false, stan: 'czeka' })
    expect(await stanRdzenia(a)).toBe(przed)
  })

  it('brak zgłoszony na stanowisku jest na liście zamówień i na /braki, obsługa może o nim zdecydować; bez braku odmowa', async () => {
    const p1 = await product(a, 'HERB-1', 5)
    const id = await zamowienie(a, '2005', [{ productId: p1, qty: 2 }])
    const l = await linia(id)
    await expect(zdecydujOBraku(a, { orderLineId: l.id, akcja: 'WYSLIJ_RESZTE', userId: BIURO })).rejects.toThrow('nie ma braku')
    const { wydruki } = await drukujKarty(a, [id], KTO)
    const w = ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
    await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: w.zamowienie.pozycje[0]!.klucz, ilosc: 1, userId: KTO.userId })
    const lista = await orderListLines(a, [id])
    expect(lista.get(id)![0]).toMatchObject({ missing: 1 })
    const d = await shortagesData(a)
    expect(d.reported.map((f) => f.orderId)).toEqual([id])
    expect(d.reportedOrders.get(id)?.id).toBe(id)
    await product(a, 'INNY', 5)
    await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'ZAMIEN', sku: 'INNY', userId: BIURO })
    expect((await a.shortageDecision.findFirstOrThrow()).dryRun).toBe(true)
  })

  it('RLS: pozycja innej firmy to „nieznana pozycja”', async () => {
    const p1 = await product(a, 'HERB-1', 1)
    const id = await zamowienie(a, '2006', [{ productId: p1, qty: 3 }])
    const l = await linia(id)
    await expect(zdecydujOBraku(b, { orderLineId: l.id, akcja: 'POCZEKAJ', userId: BIURO })).rejects.toThrow('Nieznana pozycja')
  })
})

describe('PRACA: brak w rdzeniu, spakowanie reszty', () => {
  it('zgłoszenie: rezerwacja → brak, stan fizyczny spada, dostępny nie; podwójne zgłoszenie nic nie dubluje', async () => {
    const { id, p1, drillId, kl1 } = await otwartePraca()
    const przed = await stan(p1)
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId }) // powtórzone żądanie
    const po = await stan(p1)
    expect(po.physical).toBe(przed.physical - 1)
    expect(po.reserved).toBe(przed.reserved - 1)
    expect(po.physical - po.reserved).toBe(przed.physical - przed.reserved)
    expect(await a.shortage.findMany({ where: { orderId: id }, select: { state: true, qtyBase: true } })).toEqual([{ state: 'OPEN', qtyBase: 1 }])
    expect(await a.pendingMovement.count({ where: { orderId: id, type: 'STOCK_MISSING', state: 'MANUAL' } })).toBe(1)
    expect(await a.packDrillFix.count()).toBe(1)
    expect(await doPoprawy(a)).toEqual([]) // listę biura niesie ruch MANUAL, nie ćwiczenie

    await expect(naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 3, userId: KTO.userId })).rejects.toThrow('Do zebrania zostało')
    // „Jednak jest” w PRACY cofa brak w rdzeniu (tests/brak-cofniecie.integration.test.ts), już nie odmawia
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 2, userId: KTO.userId }) // większa ilość: dokłada różnicę
    expect((await stan(p1)).physical).toBe(przed.physical - 2)
    await expect(naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })).rejects.toThrow('mniejszą ilość')
  })

  it('„Spakowano” z brakiem: reszta wychodzi, brak do zwrotu z alertem, faktura tylko na spakowane', async () => {
    const { id, p1, p2, drillId, kl1, kl2 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('SPAKOWANE')
    const s = await a.shortage.findFirstOrThrow({ where: { orderId: id } })
    expect(s.state).toBe('REFUND_PENDING')
    expect(await a.alert.count({ where: { kind: 'BRAK_PRZY_PAKOWANIU', ref: id } })).toBe(1)
    const fv = await beginInvoice(a, id)
    expect(fv.outcome === 'START' && fv.lines.map((l) => [l.productId, l.qty]).sort()).toEqual([[p1, 1], [p2, 1]].sort())

    expect((await shortagesData(a)).refunds.map((r) => r.id)).toEqual([s.id])
    expect(await markRefunded(a, s.id, { actorId: BIURO })).toBe(true)
    expect(await markRefunded(a, s.id, { actorId: BIURO })).toBe(false)
    expect(await a.orderEvent.count({ where: { orderId: id, kind: 'ZWROCONE' } })).toBe(1)
    expect((await shortagesData(a)).refunds).toEqual([])
  })

  it('pobranie: brak = mniejsze pobranie, nic na liście „Do zwrotu”', async () => {
    const { id, drillId, kl1, kl2 } = await otwartePraca({ paymentState: 'COD' })
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    expect((await a.shortage.findFirstOrThrow({ where: { orderId: id } })).state).toBe('COD_REDUCED')
    expect((await shortagesData(a)).refunds).toEqual([])
  })

  it('cały brak pozycji + karta: stara karta nie blokuje, okno i nowa karta pokazują faktyczną zawartość', async () => {
    const { id, drillId, kl2, kod } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl2, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    const stara = ok(await rozpoznajSkan(a, kod, KTO))
    expect(stara.zamowienie.brakujace.map((x) => x.klucz)).toEqual([kl2])
    const [z] = await wczytajZamowienia(a, [id])
    expect(z!.pozycje.map((p) => p.sku)).toEqual(['HERB-1'])
    expect(uwagiKarty(z!)).toBe('BRAK, NIE PAKOWAĆ: Towar testowy KUBEK: 1 szt.')
    const nowa = await drukujKarty(a, [id], KTO)
    expect(ok(await rozpoznajSkan(a, nowa.wydruki[0]!.kod, KTO)).zamowienie.brakujace).toHaveLength(1)
  })

  it('okno otwarte ponownie po zgłoszeniu nie liczy braku dwa razy', async () => {
    const { id, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await drukujKarty(a, [id], KTO) // brak zmienił zawartość paczki: stara karta nieaktualna
    const w = ok(await otworzZSesji(a, id, null, KTO))
    expect(w.cwiczenie.drillId).not.toBe(drillId)
    expect(w.cwiczenie.braki).toEqual([])
    expect(w.zamowienie.pozycje.find((p) => p.klucz === kl1)!.ilosc).toBe(1)
  })

  it('„poczekaj”: stanowisko nie pakuje, po zmianie decyzji pakuje', async () => {
    const { id, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    const l = await a.orderLine.findFirstOrThrow({ where: { orderId: id, id: kl1.split(':')[0]! } })
    await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'POCZEKAJ', userId: BIURO })
    await drukujKarty(a, [id], KTO)
    await expect(zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: {}, userId: KTO.userId })).rejects.toThrow('czeka na towar')
    expect((await sesjaZamowien(a, [id]))[0]).toMatchObject({ czerwona: true })
    await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'WYSLIJ_RESZTE', userId: BIURO })
    expect((await sesjaZamowien(a, [id]))[0]).toMatchObject({ czerwona: false })
    expect(await a.orderEvent.count({ where: { orderId: id, kind: 'DECYZJA_BRAK' } })).toBe(2)
  })

  it('„dośle”: podzamówienie, a kolejna rewizja z kanału nie wygląda jak edycja ilości; drugi klik bez drugiego podzamówienia', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 1)
    const wej = order([{ productId: p1, qty: 3 }], { externalId: '7101', channel: 'ALLEGRO', createdAtChannel: new Date() })
    const id = (await ingestOrder(a, wej)).orderId!
    const l = await linia(id)
    await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'DOSLIJ', userId: BIURO })
    expect(await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'DOSLIJ', userId: BIURO })).toEqual({ zmiana: false, dryRun: false })
    expect(await a.order.count({ where: { parentOrderId: id } })).toBe(1)
    expect(await linia(id)).toMatchObject({ qty: 3, qtyRejected: 2 })
    await ingestOrder(a, { ...wej, externalRevision: '2' })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).not.toBe('DO_WYJASNIENIA')
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
  })

  it('po spakowaniu zwrot można zamienić na dosłanie; pobranie i pozostałe decyzje odpadają', async () => {
    const { id, drillId, kl1, kl2 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    const lineId = kl1.split(':')[0]!
    await expect(zdecydujOBraku(a, { orderLineId: lineId, akcja: 'POCZEKAJ', userId: BIURO })).rejects.toThrow('Paczka już wyszła')
    await zdecydujOBraku(a, { orderLineId: lineId, akcja: 'DOSLIJ', userId: BIURO })
    expect((await shortagesData(a)).refunds).toEqual([])
    expect(await a.shortage.count({ where: { state: 'SHIP_LATER' } })).toBe(1)
    expect(await a.order.count({ where: { parentOrderId: id } })).toBe(1)
  })

  it('„zamień”: nowa pozycja z rezerwacją po tej samej cenie, stara poza paczką, rewizja z kanału jej nie rusza; karta nieaktualna', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 1)
    const z1 = await product(a, 'ZAMIENNIK', 5)
    const wej = order([{ productId: p1, qty: 3, unitPriceGross: 12.5 }], { externalId: '7201', channel: 'ALLEGRO', createdAtChannel: new Date() })
    const id = (await ingestOrder(a, wej)).orderId!
    const { wydruki } = await drukujKarty(a, [id], KTO)
    const l = await linia(id)
    await expect(zdecydujOBraku(a, { orderLineId: l.id, akcja: 'ZAMIEN', sku: 'NIE-MA', userId: BIURO })).rejects.toThrow('Nie ma produktu')
    await expect(zdecydujOBraku(a, { orderLineId: l.id, akcja: 'ZAMIEN', sku: 'HERB-1', userId: BIURO })).rejects.toThrow('ten sam produkt')
    await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'ZAMIEN', sku: 'ZAMIENNIK', userId: BIURO })
    expect(await zdecydujOBraku(a, { orderLineId: l.id, akcja: 'ZAMIEN', sku: 'ZAMIENNIK', userId: BIURO })).toMatchObject({ zmiana: false })

    const linie = await a.orderLine.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } })
    expect(linie).toHaveLength(2)
    expect(linie[0]).toMatchObject({ qty: 3, qtyRejected: 2 })
    expect(linie[1]).toMatchObject({ productId: z1, qty: 2 })
    expect(Number(linie[1]!.unitPriceGross)).toBe(12.5)
    expect((await stan(z1)).reserved).toBe(2)
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
    const stara = await rozpoznajSkan(a, wydruki[0]!.kod, KTO)
    expect(stara.typ === 'blokada' && stara.blokada.rodzaj).toBe('zmienione')

    await ingestOrder(a, { ...wej, externalRevision: '2' })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).not.toBe('DO_WYJASNIENIA')
    expect(await a.orderLine.count({ where: { orderId: id, removed: true } })).toBe(0)
  })

  it('„zamień”: bez stanu zamiennika i dla zestawu odmowa, nic się nie zmienia', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 0)
    await product(a, 'PUSTY', 0)
    const p3 = await product(a, 'SKLADNIK', 0)
    const zestaw = await bundle(a, 'ZESTAW', [{ id: p3, qty: 2 }])
    await product(a, 'INNY', 5)
    const id = await zamowienie(a, '7301', [{ productId: p1, qty: 1 }], { channel: 'ALLEGRO' })
    const id2 = await zamowienie(a, '7302', [{ productId: zestaw, qty: 1 }], { channel: 'ALLEGRO' })
    await expect(zdecydujOBraku(a, { orderLineId: (await linia(id)).id, akcja: 'ZAMIEN', sku: 'PUSTY', userId: BIURO })).rejects.toThrow('nie ma na stanie')
    await expect(zdecydujOBraku(a, { orderLineId: (await linia(id2)).id, akcja: 'ZAMIEN', sku: 'INNY', userId: BIURO })).rejects.toThrow('nie dla zestawu')
    expect(await a.shortageDecision.count()).toBe(0)
    expect(await a.orderLine.count({ where: { externalLineId: { contains: '#zamiana' } } })).toBe(0)
  })

  it('dosłanie zwykłym wywołaniem rdzenia dalej działa dla braku z przyjęcia', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 1)
    const id = await zamowienie(a, '7401', [{ productId: p1, qty: 2 }], { channel: 'ALLEGRO' })
    const r = await shipLater(a, (await linia(id)).id)
    expect(r.units).toBe(1)
    expect(ACC.ALLEGRO.channel).toBe('ALLEGRO')
  })
})

describe('poprawki po przeglądzie', () => {
  const DRUGI = { userId: 'drugi-pakujacy' }
  const MIN = 60_000

  it('drugi pakujący nie otworzy zajętego zamówienia; okno porzucone można przejąć, a stare okno już nic nie zapisze', async () => {
    const { id, p1, drillId, kl1, kod } = await otwartePraca()
    const b1 = await rozpoznajSkan(a, kod, DRUGI)
    expect(b1.typ === 'blokada' && b1.blokada.rodzaj).toBe('zajete')
    expect(await a.packDrill.count({ where: { orderId: id } })).toBe(1)

    const po = new Date(Date.now() + 31 * MIN)
    const w = ok(await rozpoznajSkan(a, kod, DRUGI, po))
    expect(w.cwiczenie.drillId).not.toBe(drillId)
    expect((await a.packDrill.findUniqueOrThrow({ where: { id: drillId } })).outcome).toBe('NIE_SPAKOWANO')
    const przed = await stan(p1)
    await expect(naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })).rejects.toThrow('już zapisane')
    expect((await stan(p1)).physical).toBe(przed.physical)
    expect(await a.shortage.count({ where: { orderId: id } })).toBe(0)
  })

  it('„nie ma na półce” po spakowaniu odmawia w rdzeniu i na stanowisku: rezerwacja i faktura nietknięte', async () => {
    const { id, p1, drillId, kl1, kl2 } = await otwartePraca()
    await packOrder(a, id) // spakowane poza tym oknem (np. okno sprzed przejęcia)
    const l = await a.orderLine.findFirstOrThrow({ where: { orderId: id, productId: p1 } })
    await expect(markMissingOnShelf(a, l.id, p1, 1)).rejects.toBeInstanceOf(ShortageActionError)
    await expect(naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })).rejects.toBeInstanceOf(BladStanowiska)
    expect(await a.shortage.count({ where: { orderId: id } })).toBe(0)
    expect((await stan(p1)).reserved).toBe(2)
    const fv = await beginInvoice(a, id)
    expect(fv.outcome === 'START' && fv.lines.find((x) => x.productId === p1)?.qty).toBe(2)
    await expect(zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 2, [kl2]: 1 }, userId: KTO.userId })).rejects.toBeInstanceOf(BladStanowiska)
  })

  /** Zestaw A + 2×B (`ile` szt.) i osobny kubek, otwarte na stanowisku. */
  async function zestawPraca(ile: number) {
    await praca()
    const pa = await product(a, 'SKL-A', 5, { priceGross: 10 })
    const pb = await product(a, 'SKL-B', 5, { priceGross: 10 })
    const kubek = await product(a, 'KUBEK', 5)
    const zestaw = await bundle(a, 'ZESTAW', [{ id: pa, qty: 1 }, { id: pb, qty: 2 }])
    const id = await zamowienie(a, '7501', [{ productId: zestaw, qty: ile, unitPriceGross: 30 }, { productId: kubek, qty: 1 }], { channel: 'ALLEGRO' })
    const { wydruki } = await drukujKarty(a, [id], KTO)
    const w = ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
    const kl = (p: string) => w.zamowienie.pozycje.find((x) => x.productId === p)!.klucz
    return { id, pa, pb, kubek, drillId: w.cwiczenie.drillId, klA: kl(pa), klB: kl(pb), klK: kl(kubek), kod: wydruki[0]!.kod }
  }
  const poKluczu = <T extends { klucz: string }>(l: T[] | undefined) => [...(l ?? [])].sort((x, y) => x.klucz.localeCompare(y.klucz))

  it('brak składnika = brak całego zestawu: faktura bez zestawu, reszta wychodzi, stan schodzi tylko o zgłoszoną sztukę', async () => {
    const { id, pa, pb, kubek, drillId, klB, klK } = await zestawPraca(1)
    const wynik = await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 1, userId: KTO.userId })
    expect(wynik.doZebrania).toEqual([{ klucz: klK, ilosc: 1 }])
    expect(wynik.zestawPoza).toBe(true)
    expect(await a.shortage.findMany({ where: { orderId: id }, orderBy: { qtyBase: 'asc' }, select: { productId: true, qtyBase: true, state: true } })).toEqual([
      { productId: pa, qtyBase: 1, state: 'OPEN' },
      { productId: pb, qtyBase: 2, state: 'OPEN' },
    ])
    expect(await stan(pb)).toMatchObject({ physical: 4, reserved: 0 }) // jedna sztuka naprawdę zniknęła, druga wraca na półkę
    expect(await stan(pa)).toMatchObject({ physical: 5, reserved: 0 })
    expect(await a.pendingMovement.count({ where: { orderId: id, type: 'STOCK_MISSING', productId: pa } })).toBe(0)

    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [klK]: 1 }, userId: KTO.userId })
    const fv = await beginInvoice(a, id)
    expect(fv.outcome === 'START' && fv.lines.map((l) => [l.productId, l.qty])).toEqual([[kubek, 1]])
  })

  it('dwa zestawy, brak składnika: druga sztuka tego samego zestawu nie zabiera kolejnego, przydział po dostawie wraca cały zestaw', async () => {
    const { id, pa, pb, drillId, klA, klB, klK } = await zestawPraca(2)
    const wynik = await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 1, userId: KTO.userId })
    expect(poKluczu(wynik.doZebrania)).toEqual(poKluczu([{ klucz: klA, ilosc: 1 }, { klucz: klB, ilosc: 2 }, { klucz: klK, ilosc: 1 }]))
    await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 2, userId: KTO.userId })
    expect(await stan(pb)).toMatchObject({ physical: 3, reserved: 2 })
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(2)
    expect(await a.pendingMovement.count({ where: { orderId: id, type: 'STOCK_MISSING', productId: pb } })).toBe(2)

    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
    await allocate(a, pb) // wolna 1 sztuka B przy 2 na zestaw: pełnego zestawu nie ma, nic się nie rezerwuje
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(2)
    await a.stock.updateMany({ where: { productId: pb }, data: { physical: { increment: 2 }, wfirmaCount: { increment: 2 } } }) // dostawa
    await allocate(a, pb)
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
    expect((await a.reservation.findMany({ where: { orderId: id, state: 'ACTIVE', productId: { in: [pa, pb] } }, orderBy: { qtyBase: 'asc' } })).map((r) => r.qtyBase)).toEqual([2, 4])
  })

  it('spakowany jeden z dwóch zestawów: faktura zgodna z rezerwacjami, „dośle” bierze cały zestaw', async () => {
    const { id, pa, pb, kubek, drillId, klA, klB, klK } = await zestawPraca(2)
    await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [klA]: 1, [klB]: 2, [klK]: 1 }, userId: KTO.userId })
    await zdecydujOBraku(a, { orderLineId: klB.split(':')[0]!, akcja: 'DOSLIJ', userId: BIURO })
    const dziecko = await a.order.findFirstOrThrow({ where: { parentOrderId: id } })
    expect(await a.orderLine.findFirstOrThrow({ where: { orderId: dziecko.id } })).toMatchObject({ qty: 1 })
    const fv = await beginInvoice(a, id)
    if (fv.outcome !== 'START') throw new Error('oczekiwana faktura')
    const ile = (p: string) => fv.lines.filter((l) => l.productId === p).reduce((s, l) => s + l.qty, 0)
    expect([ile(pa), ile(pb), ile(kubek)]).toEqual([1, 2, 1])
    const consuming = await a.reservation.findMany({ where: { orderId: id, state: 'CONSUMING' } })
    expect(consuming.filter((r) => r.productId === pb).reduce((s, r) => s + r.qtyBase, 0)).toBe(2)
  })

  it('zamiennik ma własną stawkę VAT na fakturze, cena brutto bez zmian', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 1, { vatRate: '8' })
    const z1 = await product(a, 'ZAMIENNIK', 5, { vatRate: '23' })
    const id = await zamowienie(a, '7601', [{ productId: p1, qty: 2, unitPriceGross: 12.5, vatRate: '8' }], { channel: 'ALLEGRO' })
    await zdecydujOBraku(a, { orderLineId: (await linia(id)).id, akcja: 'ZAMIEN', sku: 'ZAMIENNIK', userId: BIURO })
    await packOrder(a, id)
    const fv = await beginInvoice(a, id)
    if (fv.outcome !== 'START') throw new Error('oczekiwana faktura')
    expect(fv.lines.find((l) => l.productId === z1)).toMatchObject({ vatRate: '23', unitGrossGr: 1250 })
    expect(fv.lines.find((l) => l.productId === p1)).toMatchObject({ vatRate: '8' })
  })

  it('zmniejszenie w kanale poniżej dosłanej ilości idzie do wyjaśnienia zamiast wywracać rewizję', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 1)
    const wej = order([{ productId: p1, qty: 3 }], { externalId: '7701', channel: 'ALLEGRO', createdAtChannel: new Date() })
    const id = (await ingestOrder(a, wej)).orderId!
    await zdecydujOBraku(a, { orderLineId: (await linia(id)).id, akcja: 'DOSLIJ', userId: BIURO })
    await ingestOrder(a, { ...wej, externalRevision: '2', lines: [{ ...wej.lines[0]!, qty: 1 }] })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_WYJASNIENIA')
    expect(await linia(id)).toMatchObject({ qty: 3, qtyRejected: 2 })
    expect(await a.shortage.count({ where: { state: 'SHIP_LATER' } })).toBe(1)
  })

  it('zmniejszenie, które nie wchodzi w dosłane sztuki, działa jak dotąd', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 2)
    const wej = order([{ productId: p1, qty: 3 }], { externalId: '7702', channel: 'ALLEGRO', createdAtChannel: new Date() })
    const id = (await ingestOrder(a, wej)).orderId!
    await zdecydujOBraku(a, { orderLineId: (await linia(id)).id, akcja: 'DOSLIJ', userId: BIURO })
    await ingestOrder(a, { ...wej, externalRevision: '2', lines: [{ ...wej.lines[0]!, qty: 2 }] })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).not.toBe('DO_WYJASNIENIA')
    expect(await linia(id)).toMatchObject({ qty: 2, qtyRejected: 1 })
  })

  it('okno w PRACY = zbieranie (T7 z wydruku): przydział nie zmienia paczki pod ręką, „Nie spakowano” oddaje zamówienie przydziałowi', async () => {
    const { id, p1, drillId, kl1 } = await otwartePraca()
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('ZBIERANIE')
    expect(await a.orderEvent.count({ where: { orderId: id, kind: 'ZBIERANIE' } })).toBe(1) // wydruk, otwarcie okna nie dubluje
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await allocate(a, p1)
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(1)
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
    await allocate(a, p1)
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
  })

  it('„poczekaj” w trakcie zbierania wraca do przydziału, inaczej dostawa nigdy by nie przyszła na to zamówienie', async () => {
    const { id, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zdecydujOBraku(a, { orderLineId: kl1.split(':')[0]!, akcja: 'POCZEKAJ', userId: BIURO })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
  })

  it('anulowanie w toku blokuje otwarcie okna, nic nie zmienia statusu', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 5)
    const id = await zamowienie(a, '7801', [{ productId: p1, qty: 1 }], { channel: 'ALLEGRO' })
    await a.order.update({ where: { id }, data: { pendingAction: 'CANCEL_CANCELLED' } })
    const { wydruki } = await drukujKarty(a, [id], KTO) // T7 odmówione: karta wychodzi, status zostaje
    const w = await rozpoznajSkan(a, wydruki[0]!.kod, KTO)
    expect(w.typ === 'blokada' && w.blokada.rodzaj).toBe('status')
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
    expect(await a.packDrill.count()).toBe(0)
  })

  it('dosłanie zamiast zwrotu zostawia alert, że nie zwracać pieniędzy', async () => {
    const { drillId, kl1, kl2 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    await zdecydujOBraku(a, { orderLineId: kl1.split(':')[0]!, akcja: 'DOSLIJ', userId: BIURO })
    expect(await a.alert.count({ where: { kind: 'DOSLANIE_ZAMIAST_ZWROTU' } })).toBe(1)
  })

  it('skan karty spakowanego zamówienia z brakiem mówi „już spakowane”, nie „wydrukuj ponownie”', async () => {
    const { id, drillId, kl1, kl2 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    const { wydruki } = await drukujKarty(a, [id], KTO) // karta z brakiem: po spakowaniu jej migawka różni się od zamówienia
    const w = ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    expect((await sesjaZamowien(a, [id]))[0]).toMatchObject({ stan: 'spakowane' })
  })
})

describe('integracja: karta, T7 i brak przy pakowaniu', () => {
  const status = async (id: string) => (await a.order.findUniqueOrThrow({ where: { id } })).status
  const flagi = async (id: string) => (await a.order.findUniqueOrThrow({ where: { id } })).flags as Record<string, unknown>
  const blokada = (w: WynikSkanu) => (w.typ === 'blokada' ? w.blokada.rodzaj : null)
  const skan = (kod: string) => rozpoznajSkan(a, kod, KTO)

  it('brak i ponowne otwarcie okna tą samą kartą: bez „wydrukuj ponownie”, reszta wychodzi', async () => {
    const { id, drillId, kl1, kl2, kod } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    const w = ok(await skan(kod))
    expect(Object.fromEntries(w.zamowienie.pozycje.map((p) => [p.klucz, p.ilosc]))).toEqual({ [kl1]: 1, [kl2]: 1 })
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    expect(await status(id)).toBe('SPAKOWANE')
  })

  it('wydruk po zgłoszonym braku nie ustawia „karta nieaktualna” (migawka z brakiem), spakowanie przechodzi', async () => {
    const { id, drillId, kl1, kl2 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    const { wydruki } = await drukujKarty(a, [id], KTO)
    expect((await flagi(id)).kartaNieaktualna).toBeUndefined()
    const w = ok(await skan(wydruki[0]!.kod))
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    expect(await status(id)).toBe('SPAKOWANE')
  })

  it('„dośle” po zgłoszonym braku: ta sama karta zostaje ważna, reszta wychodzi', async () => {
    const { id, drillId, kl1, kl2, kod } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zdecydujOBraku(a, { orderLineId: kl1.split(':')[0]!, akcja: 'DOSLIJ', userId: BIURO })
    const w = ok(await skan(kod))
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    expect(await status(id)).toBe('SPAKOWANE')
  })

  it('zamiana: w paczce jest nowa pozycja, więc stara karta odpada; nowy wydruk bez flagi i spakowanie z zamiennikiem', async () => {
    const { id, drillId, kl1, kod } = await otwartePraca()
    const z = await product(a, 'ZAMIENNIK', 5)
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zdecydujOBraku(a, { orderLineId: kl1.split(':')[0]!, akcja: 'ZAMIEN', sku: 'ZAMIENNIK', userId: BIURO })
    expect(blokada(await skan(kod))).toBe('zmienione')
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    const { wydruki } = await drukujKarty(a, [id], KTO)
    expect((await flagi(id)).kartaNieaktualna).toBeUndefined()
    const w = ok(await skan(wydruki[0]!.kod))
    expect(w.zamowienie.pozycje.some((p) => p.productId === z)).toBe(true)
    const zebrane = Object.fromEntries(w.zamowienie.pozycje.map((p) => [p.klucz, p.ilosc]))
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt, zebrane, userId: KTO.userId })
    expect(await status(id)).toBe('SPAKOWANE')
  })

  it('ochrona zostaje: edycja z kanału po zgłoszonym braku (ta sama pozycja) blokuje skan i pakowanie do nowego wydruku', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 5)
    const p2 = await product(a, 'KUBEK', 5)
    const wej = order([{ productId: p1, qty: 3 }, { productId: p2, qty: 1 }], { externalId: '7901', channel: 'ALLEGRO', createdAtChannel: new Date() })
    const id = (await ingestOrder(a, wej)).orderId!
    const k1 = (await drukujKarty(a, [id], KTO)).wydruki[0]!
    const w = ok(await skan(k1.kod))
    const kl = (p: string) => w.zamowienie.pozycje.find((x) => x.productId === p)!.klucz
    await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: kl(p1), ilosc: 1, userId: KTO.userId })
    await ingestOrder(a, { ...wej, externalRevision: '2', lines: [{ ...wej.lines[0]!, qty: 2 }, wej.lines[1]!] })
    expect(await flagi(id)).toMatchObject({ kartaNieaktualna: true })
    expect(blokada(await skan(k1.kod))).toBe('zmienione')
    await expect(zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl(p1)]: 1, [kl(p2)]: 1 }, userId: KTO.userId })).rejects.toThrow(/zmieniło się w kanale/)
    await expect(packOrder(a, id)).rejects.toThrow(/Karta nieaktualna/)
    const k2 = (await drukujKarty(a, [id], KTO)).wydruki[0]!
    expect((await flagi(id)).kartaNieaktualna).toBeUndefined()
    const w2 = ok(await skan(k2.kod))
    const zebrane = Object.fromEntries(w2.zamowienie.pozycje.map((p) => [p.klucz, p.ilosc]))
    await zakonczCwiczenie(a, { drillId: w2.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt, zebrane, userId: KTO.userId })
    expect(await status(id)).toBe('SPAKOWANE')
  })

  it('dostawa po wydruku z brakiem: do zebrania przybyło, więc karta nieaktualna mimo zgłoszonego braku', async () => {
    const { id, p1, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    const { wydruki } = await drukujKarty(a, [id], KTO) // karta z brakiem
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    await allocate(a, p1)
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
    expect(blokada(await skan(wydruki[0]!.kod))).toBe('zmienione')
  })

  it('T7 z wydruku i okno: jedno przejście; „Nie spakowano” cofa raz; powrót tą samą kartą bez błędu, znów zbieranie', async () => {
    const { id, drillId, kod } = await otwartePraca()
    expect(await a.orderEvent.count({ where: { orderId: id, kind: 'ZBIERANIE' } })).toBe(1)
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    expect(await status(id)).toBe('DO_REALIZACJI')
    expect(await a.orderEvent.count({ where: { orderId: id, kind: 'ZBIERANIE_COFNIETE' } })).toBe(1)
    ok(await skan(kod))
    expect(await status(id)).toBe('ZBIERANIE')
    expect(await a.orderEvent.count({ where: { orderId: id, kind: 'ZBIERANIE' } })).toBe(2)
  })

  it('cofnięcie zbierania (`cancelPicking`) przy otwartym oknie: „Spakowano” kończy się bez błędu', async () => {
    const { id, drillId, kl1, kl2 } = await otwartePraca()
    await cancelPicking(a, id)
    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 2, [kl2]: 1 }, userId: KTO.userId })
    expect(await status(id)).toBe('SPAKOWANE')
  })

  it('alerty: jeden BRAK_NA_POLCE i jeden BRAK_PRZY_PAKOWANIU na paczkę; drugiego spakowania nie ma, więc klucz się nie powtórzy', async () => {
    const { id, drillId, kl1, kl2 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    await expect(packOrder(a, id)).rejects.toThrow(/statusie SPAKOWANE/)
    const al = await a.alert.findMany({ where: { kind: 'BRAK_PRZY_PAKOWANIU' } })
    expect(al).toHaveLength(1)
    expect(al[0]).toMatchObject({ ref: id, closedAt: null, dedupeKey: `brak-przy-pakowaniu:${id}:1` })
    expect(await a.alert.count({ where: { kind: 'BRAK_NA_POLCE' } })).toBe(1)
  })
})
