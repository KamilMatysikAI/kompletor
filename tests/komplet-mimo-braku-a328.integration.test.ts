// paczka wyszła w komplecie mimo braku w systemie (towar był na półce, ale jeszcze nieprzyjęty na stan).
//  (a) „Wyszedł komplet” przy wystarczającym stanie: brak zamknięty bez zwrotu, rezerwacja na pełną ilość, wpis w historii;
//  (b) odmowa przy niewystarczającym stanie (nic się nie zmienia);
//  (c) faktura po akcji na pełną ilość, jeden rozchód; bezpiecznik „faktura różna od paczki” dalej działa przed akcją;
//  (d) prawdziwy brak (inna pozycja, brak stanu) zostaje do zwrotu, a faktura dalej się nie wystawia.
// Plus: drugie kliknięcie nic nie dopisuje, faktura wystawiona albo w toku = odmowa, pobranie z etykietą = odmowa.
// Dane wyłącznie testowe (zmyślone produkty i osoby).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { shortagesData } from '@/lib/panel/dane'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { finishPicking, startPicking } from '@/lib/rdzen/przejscia'
import { packOrder, ponowFaktureRecznie } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { BladStanowiska, dolozBrakDoPaczki, otworzZSesji, rozpoznajSkan, sesjaZamowien, zakonczCwiczenie, type WynikSkanu } from '@/lib/stanowisko/cwiczenie'
import { drukujKarty } from '@/lib/stanowisko/karty'
import { gabarytyDla } from '@/lib/stanowisko/gabaryty'
import { wyszedlKomplet } from '@/lib/stanowisko/decyzje'
import { FakturyWfirmaZapis } from '@/lib/wfirma/adapter-zapis'
import { WfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { WfirmaZapis } from '@/lib/zrodla/wfirma-zapis'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, expectInvariants, offer, order, product, seedBase, T0 } from './rdzen-fixtures'
import { KLUCZE_TESTOWE, WfirmaHttpAtrapa } from './wfirma-http-atrapa'

const db = testDb()
afterAll(() => db.$disconnect())

const KODY_VAT = { '23': 222, '8': 223, '5': 224, '0': 234 }
const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: null, email: null },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}
const UZYTKOWNIK = 'biuro-testowe'
const adapter = (w: WfirmaHttpAtrapa) => new FakturyWfirmaZapis(new WfirmaReadOnly(KLUCZE_TESTOWE, w.fetch, 0), db, { zapis: new WfirmaZapis(KLUCZE_TESTOWE, w.fetch, 0), odbiorca: async () => ODBIORCA })
const min = (m: number) => new Date(T0.getTime() + m * 60_000)

async function wystaw(m: number, w = new WfirmaHttpAtrapa()) {
  await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(m), tylkoPraca: true })
  return w.faktury
}

/** Dostawa przyjęta w programie magazynowym i odczytana przez Kompletor (stan fizyczny rośnie). */
const dostawa = (productId: string, ile: number) => db.stock.updateMany({ where: { productId }, data: { physical: { increment: ile }, wfirmaCount: { increment: ile } } })

async function stanZamowienia(orderId: string) {
  const byId = { orderBy: { id: 'asc' as const } }
  return JSON.stringify({
    order: await db.order.findUniqueOrThrow({ where: { id: orderId } }),
    reservations: await db.reservation.findMany({ where: { orderId }, ...byId }),
    shortages: await db.shortage.findMany({ where: { orderId }, ...byId }),
    stocks: await db.stock.findMany({ orderBy: { productId: 'asc' } }),
    events: await db.orderEvent.findMany({ where: { orderId }, ...byId }),
    pending: await db.pendingMovement.findMany(byId),
  })
}

/** Zamówienie opłacone: pozycje z kanału, zebrane i spakowane mimo braku (jak przy pakowaniu z ramką „Brakuje, nie pakuj”). */
async function spakowaneZBrakiem(lines: { offerExternalId: string; qty: number; unitPriceGross: number }[], totalGross: number, over: Parameters<typeof order>[1] = {}): Promise<string> {
  const r = await ingestOrder(db, order(lines, { totalGross, ...over }), { now: T0 })
  const id = r.orderId!
  await startPicking(db, id, { now: T0 })
  await finishPicking(db, id, { now: T0 })
  await packOrder(db, id, { now: T0 })
  return id
}

const linia = (orderId: string, ext = 'L1') => db.orderLine.findFirstOrThrow({ where: { orderId, externalLineId: ext } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.channelConfig.updateMany({ where: ACC.WOO_SD, data: { statusMode: 'PRACA' } })
  await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { kodyVat: KODY_VAT, program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() } } as never } })
})

describe('„Wyszedł komplet” po spakowaniu', () => {
  it('(a)+(c) stan pozwala: brak zamknięty bez zwrotu, „Ponów fakturę” wystawia fakturę na całość z jednym rozchodem', async () => {
    const lizak = await product(db, 'LIZAK-T', 4, { wfirmaGoodId: '9201' })
    await offer(db, 'WOO_SD', 'OL', lizak)
    const id = await spakowaneZBrakiem([{ offerExternalId: 'OL', qty: 6, unitPriceGross: 10 }], 70)
    const l1 = await linia(id)
    expect(await db.shortage.findMany({ where: { orderId: id }, select: { state: true, qtyBase: true } })).toEqual([{ state: 'REFUND_PENDING', qtyBase: 2 }])

    // bezpiecznik zostaje (pkt 4): przed akcją faktura 6 ≠ paczka 4, nic nie idzie do programu do faktur
    const przed = await wystaw(2)
    expect(przed).toHaveLength(0)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).flags).toMatchObject({ fakturaBlad: true })
    const blad = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id, state: 'FAILED' } })
    expect(blad.lastError).toMatch(/różni się od spakowanego towaru \(LIZAK-T: faktura 6, paczka 4\)/)

    await dostawa(lizak, 250)
    const r = await wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(3))
    expect(r).toEqual({ units: 2, poSpakowaniu: true })
    expect(await db.shortage.count({ where: { orderId: id, state: { in: ['OPEN', 'REFUND_PENDING', 'COD_REDUCED'] } } })).toBe(0)
    const zamkniety = await db.shortage.findFirstOrThrow({ where: { orderId: id } })
    expect(zamkniety).toMatchObject({ state: 'RESOLVED', resolvedBy: `user:${UZYTKOWNIK}` })
    expect(zamkniety.reservationId).not.toBeNull()
    expect((await db.reservation.findMany({ where: { orderId: id, state: 'ACTIVE' } })).reduce((s, x) => s + x.qtyBase, 0)).toBe(6)
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'JEDNAK_W_PACZCE' } })
    expect(ev).toMatchObject({ actorId: `user:${UZYTKOWNIK}`, data: { pozycja: l1.id, sztuk: 2, poSpakowaniu: true } })
    expect(await db.alert.count({ where: { kind: 'BRAK_PRZY_PAKOWANIU', ref: id, closedAt: null } })).toBe(0)
    // lista „Do zwrotu” już tego nie pokazuje
    expect((await shortagesData(db)).refunds.filter((z) => z.orderId === id)).toHaveLength(0)
    await expectInvariants(db)

    // drugie kliknięcie: nic nie dopisuje
    const stan = await stanZamowienia(id)
    expect(await wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(4))).toEqual({ units: 0, poSpakowaniu: true })
    expect(await stanZamowienia(id)).toBe(stan)

    await ponowFaktureRecznie(db, id, { now: min(5) })
    const faktury = await wystaw(6)
    expect(faktury).toHaveLength(1)
    expect(faktury[0]!.pozycje.find((p) => p.goodId === 9201)).toMatchObject({ count: 6, price: '10.00' })
    const fv = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id, state: 'ISSUED' } })
    // jeden rozchód na 6 sztuk: ruch faktury z rezerwacji, bez drugiego ruchu z akcji
    const ruchy = await db.pendingMovement.findMany({ where: { orderId: id, state: { not: 'CANCELLED' } } })
    expect(ruchy.map((m) => [m.type, m.delta, m.invoiceId])).toEqual([['OWN_INVOICE', -6, fv.id]])
    expect((await db.reservation.findMany({ where: { orderId: id, state: 'CONSUMED' } })).reduce((s, x) => s + x.qtyBase, 0)).toBe(6)
    await expectInvariants(db)

    // po fakturze akcja odmawia (druga faktura gorsza niż ręczna korekta)
    expect((await wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(7))).units).toBe(0)
  })

  it('(b) stan nie pozwala: czytelna odmowa „najpierw przyjmij towar na stan”, nic się nie zmienia', async () => {
    const lizak = await product(db, 'LIZAK-T', 4, { wfirmaGoodId: '9201' })
    await offer(db, 'WOO_SD', 'OL', lizak)
    const id = await spakowaneZBrakiem([{ offerExternalId: 'OL', qty: 6, unitPriceGross: 10 }], 70)
    const l1 = await linia(id)
    await dostawa(lizak, 1) // przyjęta tylko 1 sztuka z 2
    const stan = await stanZamowienia(id)
    await expect(wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(3))).rejects.toThrow(BladStanowiska)
    await expect(wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(3))).rejects.toThrow(/LIZAK-T: potrzeba 2, dostępne 1.*przyjmij towar na stan.*Synchronizuj stany/)
    expect(await stanZamowienia(id)).toBe(stan)
    await expectInvariants(db)
  })

  it('(d) prawdziwy brak na innej pozycji zostaje do zwrotu, a faktura dalej się nie wystawia', async () => {
    const lizak = await product(db, 'LIZAK-T', 4, { wfirmaGoodId: '9201' })
    const kubek = await product(db, 'KUBEK-T', 1, { wfirmaGoodId: '9202' })
    await offer(db, 'WOO_SD', 'OL', lizak)
    await offer(db, 'WOO_SD', 'OK', kubek)
    const id = await spakowaneZBrakiem(
      [
        { offerExternalId: 'OL', qty: 6, unitPriceGross: 10 },
        { offerExternalId: 'OK', qty: 2, unitPriceGross: 20 },
      ],
      110,
    )
    await dostawa(lizak, 10)
    const lizakL = await linia(id, 'L1')
    const kubekL = await linia(id, 'L2')
    expect((await wyszedlKomplet(db, { orderLineId: lizakL.id, userId: UZYTKOWNIK }, min(3))).units).toBe(2)
    await expect(wyszedlKomplet(db, { orderLineId: kubekL.id, userId: UZYTKOWNIK }, min(3))).rejects.toThrow(/KUBEK-T: potrzeba 1, dostępne 0/)
    expect(await db.shortage.findMany({ where: { orderId: id, state: 'REFUND_PENDING' }, select: { orderLineId: true, qtyBase: true } })).toEqual([{ orderLineId: kubekL.id, qtyBase: 1 }])
    // alert „zwróć pieniądze” zostaje, bo kubek nadal czeka na zwrot
    expect(await db.alert.count({ where: { kind: 'BRAK_PRZY_PAKOWANIU', ref: id, closedAt: null } })).toBe(1)
    expect((await shortagesData(db)).refunds.filter((z) => z.orderId === id)).toHaveLength(1)
    expect(await wystaw(4)).toHaveLength(0) // faktura 2 kubki ≠ paczka 1: bezpiecznik
    await expectInvariants(db)
  })

  it('faktura w toku albo wystawiona: odmowa bez zmian', async () => {
    const lizak = await product(db, 'LIZAK-T', 4, { wfirmaGoodId: '9201' })
    await offer(db, 'WOO_SD', 'OL', lizak)
    const id = await spakowaneZBrakiem([{ offerExternalId: 'OL', qty: 6, unitPriceGross: 10 }], 70)
    const l1 = await linia(id)
    await dostawa(lizak, 10)
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'SENDING', payload: [] } })
    await expect(wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(3))).rejects.toThrow(/Faktura jest w toku/)
    await db.invoiceAttempt.updateMany({ where: { orderId: id }, data: { state: 'ISSUED' } })
    await expect(wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(3))).rejects.toThrow(/już wystawiona na mniejszą ilość/)
    expect(await db.shortage.count({ where: { orderId: id, state: 'REFUND_PENDING' } })).toBe(1)
  })

  it('pobranie: bez etykiety zamyka pomniejszenie pobrania, z etykietą odmawia', async () => {
    const lizak = await product(db, 'LIZAK-T', 4, { wfirmaGoodId: '9201' })
    await offer(db, 'WOO_SD', 'OL', lizak)
    const id = await spakowaneZBrakiem([{ offerExternalId: 'OL', qty: 6, unitPriceGross: 10 }], 70, { paymentState: 'COD', paymentMethod: 'Pobranie' })
    const l1 = await linia(id)
    expect(await db.shortage.count({ where: { orderId: id, state: 'COD_REDUCED' } })).toBe(1)
    await dostawa(lizak, 10)
    await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: 'ref-test-1', adapterKey: 'test-przewoznik', carrier: (await db.order.findUniqueOrThrow({ where: { id } })).carrier ?? 'PACZKOMATY', state: 'UTWORZONA' } })
    await expect(wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(3))).rejects.toThrow(/etykietę z pomniejszoną kwotą pobrania/)
    await db.shipment.updateMany({ where: { orderId: id }, data: { state: 'ANULOWANA' } })
    expect((await wyszedlKomplet(db, { orderLineId: l1.id, userId: UZYTKOWNIK }, min(4))).units).toBe(2)
    await expectInvariants(db)
  })

  it('konto w podglądzie: odmowa', async () => {
    const lizak = await product(db, 'LIZAK-T', 4, { wfirmaGoodId: '9201' })
    await offer(db, 'WOO_SD', 'OL', lizak)
    const id = await spakowaneZBrakiem([{ offerExternalId: 'OL', qty: 6, unitPriceGross: 10 }], 70)
    await db.channelConfig.updateMany({ where: ACC.WOO_SD, data: { statusMode: 'CIEN' } })
    await expect(wyszedlKomplet(db, { orderLineId: (await linia(id)).id, userId: UZYTKOWNIK }, min(3))).rejects.toThrow(/podglądzie/)
  })
})

describe('„Jednak jest w paczce” na stanowisku, zanim padnie „Spakowano”', () => {
  const KTO = { userId: 'magazyn-testowy', nazwa: 'Magazyn Testowy' }
  const ok = (w: WynikSkanu) => {
    if (w.typ !== 'ok') throw new Error(`oczekiwane ok, jest: ${w.blokada.rodzaj} — ${w.blokada.komunikat}`)
    return w
  }
  /** Zamówienie z brakiem z przydziału (stan 4 z 6), karta wydrukowana i zeskanowana: okno w „Zbieranie”. */
  async function okno() {
    await db.channelConfig.updateMany({ where: ACC.ALLEGRO, data: { statusMode: 'PRACA' } })
    const lizak = await product(db, 'LIZAK-T', 4)
    const r = await ingestOrder(db, order([{ productId: lizak, qty: 6 }], { channel: 'ALLEGRO', externalId: '7328', createdAtChannel: new Date() }))
    const id = r.orderId!
    const { wydruki } = await drukujKarty(db, [id], KTO)
    const w = ok(await rozpoznajSkan(db, wydruki[0]!.kod, KTO))
    expect(w.zamowienie.brakujace.map((b) => [b.sku, b.ilosc])).toEqual([['LIZAK-T', 2]])
    expect(w.zamowienie.pozycje.map((p) => p.ilosc)).toEqual([4])
    return { id, lizak, w, l1: (await linia(id)).id }
  }

  it('stan pozwala (towar przyjęty po wydruku, zamówienie już w zbieraniu): pozycja do zebrania 6, spakowane bez zwrotu', async () => {
    const { id, lizak, w, l1 } = await okno()
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('ZBIERANIE')
    await dostawa(lizak, 250)
    const r = await dolozBrakDoPaczki(db, { drillId: w.cwiczenie.drillId, orderLineId: l1, userId: KTO.userId })
    expect(r.units).toBe(2)
    expect(r.brakujace).toEqual([])
    expect(r.pozycje.map((p) => p.ilosc)).toEqual([6])
    // drugie kliknięcie: nic nie dopisuje
    await expect(dolozBrakDoPaczki(db, { drillId: w.cwiczenie.drillId, orderLineId: l1, userId: KTO.userId })).rejects.toThrow(/nie ma w ramce/)
    // ponowne otwarcie tej samej karty: bez „wydrukuj kartę ponownie” (karta ma pełną ilość zamówioną)
    const [s] = await sesjaZamowien(db, [id])
    expect(s!.komunikat ?? '').not.toMatch(/zmieniło się/)
    await zakonczCwiczenie(db, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gabarytyDla('ALLEGRO')[0]!, zebrane: { [r.pozycje[0]!.klucz]: 6 }, userId: KTO.userId })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('SPAKOWANE')
    expect(await db.shortage.count({ where: { orderId: id, state: { in: ['OPEN', 'REFUND_PENDING'] } } })).toBe(0)
    expect((await db.reservation.findMany({ where: { orderId: id, state: 'ACTIVE' } })).reduce((a, x) => a + x.qtyBase, 0)).toBe(6)
    await expectInvariants(db)
  })

  it('stan nie pozwala: odmowa z instrukcją, okno bez zmian, „Spakowano” na 4 daje zwrot jak dotąd', async () => {
    const { id, w, l1 } = await okno()
    await expect(dolozBrakDoPaczki(db, { drillId: w.cwiczenie.drillId, orderLineId: l1, userId: KTO.userId })).rejects.toThrow(/przyjmij towar na stan.*Synchronizuj stany/)
    await zakonczCwiczenie(db, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gabarytyDla('ALLEGRO')[0]!, zebrane: { [w.zamowienie.pozycje[0]!.klucz]: 4 }, userId: KTO.userId })
    expect(await db.shortage.findMany({ where: { orderId: id }, select: { state: true, qtyBase: true } })).toEqual([{ state: 'REFUND_PENDING', qtyBase: 2 }])
    await expectInvariants(db)
  })

  it('ponowne otwarcie z listy sesji po dołożeniu: okno otwiera się bez nowej karty', async () => {
    const { id, lizak, w, l1 } = await okno()
    await dostawa(lizak, 10)
    await dolozBrakDoPaczki(db, { drillId: w.cwiczenie.drillId, orderLineId: l1, userId: KTO.userId })
    await zakonczCwiczenie(db, { drillId: w.cwiczenie.drillId, wynik: 'NIE_SPAKOWANO', gabaryt: null, zebrane: {}, userId: KTO.userId })
    const druga = ok(await otworzZSesji(db, id, null, KTO))
    expect(druga.zamowienie.pozycje.map((p) => p.ilosc)).toEqual([6])
    expect(druga.zamowienie.brakujace).toEqual([])
    await expectInvariants(db)
  })
})
