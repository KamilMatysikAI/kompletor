// po wysyłce przelicznik oferty wolno zmienić (`sprawdzZmianePrzelicznika`
// blokuje tylko przy otwartych zamówieniach), a pozycji wysłanych zamówień nikt nie przelicza. Korekta KSeF przy zwrocie
// i kwota na liście „Do zwrotu” liczą się z proporcji zapisanej w zamówieniu (`qty / qtyChannel`), nie z aktualnej oferty,
// więc zgadzają się z wystawioną fakturą i zapłaconą kwotą. Do tego testy „Do zwrotu” w stanie, jaki zostawia produkcja:
// brak z pakowania NIE zwiększa `qtyRejected` (`packOrderInTx`), `qtyRejected` pozycji pierwotnej = tylko sztuki zamienione.
// Dane fikcyjne (produkty TEST-*), bez sieci (szkice bez wysyłki do KSeF).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareKsefForOrder } from '@/lib/ksef/szkice'
import { shortagesData } from '@/lib/panel/dane'
import { szkicKorektyKsef } from '@/lib/zwroty/korekta-ksef'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { ACC, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const T = new Date('2026-11-09T09:00:00.000Z')
const USTAWIENIA = {
  faktury: { program: 'ksef', fakturyWlaczone: true, fakturyWlaczoneOd: '2026-11-01T00:00:00.000Z', wystawiajPrzy: 'SPAKOWANE' },
  ksef: { sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca Testowy sp. z o.o.', adres: { linia1: 'ul. Testowa 1', linia2: '00-001 Warszawa' } }, seriaKod: 'FV', seriaWzor: '%N/%M/%Y', seriaReset: 'MIESIAC', srodowisko: 'TEST' },
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: USTAWIENIA } })
})

const zmienPrzelicznik = (externalId: string, n: number) => db.channelOffer.updateMany({ where: { ...ACC.WOO_SD, externalId }, data: { qtyBasePerOffer: n } })

async function zamowienie(id: string, totalGross: string, status: 'WYSLANE' | 'SPAKOWANE' = 'WYSLANE') {
  await db.order.create({ data: { id, ...ACC.WOO_SD, externalId: `Z-${id}`, status, paymentState: 'PAID', paymentMethod: 'BLIK', totalGross, shippingCostGross: '12.99', wantInvoiceNip: true, createdAtChannel: T } })
}

/** Oferta 50 g za 12,50 zł, pozycja 1 szt. oferty (qty 50, qtyChannel 1), wysłana, szkic faktury KSeF wystawiony. */
async function wyslaneZFaktura(id: string) {
  const herb = await product(db, `TEST-SUSZ-${id}`, 1000, { unit: 'KG', vatRate: '5' })
  await db.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herb, qtyBasePerOffer: 50 } })
  await zamowienie(id, '25.49')
  await db.orderLine.create({ data: { id: `${id}l1`, orderId: id, externalLineId: 'L1', offerId: 'O-50', productId: herb, qty: 50, qtyChannel: 1, unitPriceGross: '12.50', vatRate: '5' } })
  const w = await prepareKsefForOrder(db, id, { now: T })
  expect(w).toMatchObject({ wynik: 'przygotowana' })
  expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id }, select: { bruttoGr: true } })).toEqual({ bruttoGr: 2549 })
  return herb
}

async function korekta(orderId: string, lines: { orderLineId: string; productId: string; qty: number }[]) {
  const r = await db.return.create({ data: { orderId, status: 'PRZYJETY', lines: { create: lines } } })
  const k = await szkicKorektyKsef(db, r.id, { now: T })
  if (!k.ok) throw new Error(`szkic korekty: ${k.powod} ${JSON.stringify(k.problemy)}`)
  return k.wejscie.wiersze
}

async function brak(orderId: string, orderLineId: string, productId: string, qtyBase: number) {
  return (await db.shortage.create({ data: { orderId, orderLineId, productId, qtyBase, state: 'REFUND_PENDING', resolvedAt: T } })).id
}
const kwota = async (id: string) => (await shortagesData(db)).refunds.find((r) => r.id === id)?.kwotaZwrotuGr

describe('korekta KSeF po zmianie przelicznika oferty po wysyłce', () => {
  it('przelicznik 50 → 100 po fakturze: zwrot całości = −12,50 zł jak na fakturze (było −6,25 zł)', async () => {
    const herb = await wyslaneZFaktura('k1')
    await zmienPrzelicznik('O-50', 100)
    const w = await korekta('k1', [{ orderLineId: 'k1l1', productId: herb, qty: 50 }])
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ bruttoGr: -1250, jednostka: 'kg', ilosc: -0.05 })
  })

  it('przelicznik 50 → 25 po fakturze: zwrot całości = −12,50 zł (było −25,00 zł, więcej niż faktura)', async () => {
    const herb = await wyslaneZFaktura('k2')
    await zmienPrzelicznik('O-50', 25)
    const w = await korekta('k2', [{ orderLineId: 'k2l1', productId: herb, qty: 50 }])
    expect(w[0]).toMatchObject({ bruttoGr: -1250 })
  })

  it('oferta wielosztukowa, przelicznik 3 → 6: zwrot 1 szt. z 3 szt. za 30,00 zł = −10,00 zł, ilość −1 szt.', async () => {
    const p = await product(db, 'TEST-SZT-3', 100)
    await db.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-3', productId: p, qtyBasePerOffer: 3 } })
    await zamowienie('k3', '42.99')
    await db.orderLine.create({ data: { id: 'k3l1', orderId: 'k3', externalLineId: 'L1', offerId: 'O-3', productId: p, qty: 3, qtyChannel: 1, unitPriceGross: '30.00', vatRate: '23' } })
    expect(await prepareKsefForOrder(db, 'k3', { now: T })).toMatchObject({ wynik: 'przygotowana' })
    await zmienPrzelicznik('O-3', 6)
    const w = await korekta('k3', [{ orderLineId: 'k3l1', productId: p, qty: 1 }])
    expect(w[0]).toMatchObject({ bruttoGr: -1000, jednostka: 'szt.', ilosc: -0.333 })
  })

  it('zamiennik (okablowanie): przelicznik i przesunięcie z pozycji pierwotnej zamówienia, nie z oferty po zmianie', async () => {
    // 2 × 50 g po 3,75 zł (qty 100, qtyChannel 2); 50 g zamienione na inny produkt; po wysyłce oferta 50 → 100
    const herbA = await product(db, 'TEST-SUSZ-ZA', 1000, { unit: 'KG', vatRate: '5' })
    const herbB = await product(db, 'TEST-SUSZ-ZB', 1000, { unit: 'KG', vatRate: '5' })
    await db.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herbA, qtyBasePerOffer: 50 } })
    await zamowienie('k4', '20.49')
    await db.orderLine.create({ data: { id: 'k4l1', orderId: 'k4', externalLineId: 'L1', offerId: 'O-50', productId: herbA, qty: 100, qtyChannel: 2, qtyRejected: 50, unitPriceGross: '3.75', vatRate: '5' } })
    await db.orderLine.create({ data: { id: 'k4l2', orderId: 'k4', externalLineId: 'L1#zamiana-1', productId: herbB, qty: 50, unitPriceGross: '3.75', vatRate: '5' } })
    expect(await prepareKsefForOrder(db, 'k4', { now: T })).toMatchObject({ wynik: 'przygotowana' })
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: 'k4' }, select: { bruttoGr: true } })).toEqual({ bruttoGr: 2049 })
    await zmienPrzelicznik('O-50', 100)
    const w = await korekta('k4', [{ orderLineId: 'k4l2', productId: herbB, qty: 50 }])
    // część 50..100 rodziny: w(100) − w(50) = 7,50 − 3,75 (po zmianie oferty byłoby 3,75 − 1,88 = 1,87)
    expect(w[0]).toMatchObject({ bruttoGr: -375, ilosc: -0.05 })
    // pozycja pierwotna: wydane 50 g (qty − qtyRejected), zwrot 21 g = round(21 × 3,75 / 50) = 1,58 zł
    const w2 = await korekta('k4', [{ orderLineId: 'k4l1', productId: herbA, qty: 21 }])
    expect(w2[0]).toMatchObject({ bruttoGr: -158 })
  })

  it('pozycja bez proporcji w zamówieniu (qtyChannel null, np. sprzed migracji): przelicznik z aktualnej oferty jak faktura', async () => {
    const herb = await product(db, 'TEST-SUSZ-NULL', 1000, { unit: 'KG', vatRate: '5' })
    await db.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herb, qtyBasePerOffer: 50 } })
    await zamowienie('k5', '25.49')
    await db.orderLine.create({ data: { id: 'k5l1', orderId: 'k5', externalLineId: 'L1', offerId: 'O-50', productId: herb, qty: 50, unitPriceGross: '12.50', vatRate: '5' } })
    expect(await prepareKsefForOrder(db, 'k5', { now: T })).toMatchObject({ wynik: 'przygotowana' })
    const w = await korekta('k5', [{ orderLineId: 'k5l1', productId: herb, qty: 50 }])
    expect(w[0]).toMatchObject({ bruttoGr: -1250 })
  })
})

describe('lista „Do zwrotu” po zmianie przelicznika oferty', () => {
  it('brak 50 g z pakowania (qtyRejected 0, jak produkcja), przelicznik 50 → 100: 12,50 zł (było 6,25 zł)', async () => {
    const herb = await product(db, 'TEST-SUSZ-B1', 0, { unit: 'KG', vatRate: '5' })
    await db.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herb, qtyBasePerOffer: 50 } })
    await zamowienie('b1', '25.49', 'SPAKOWANE')
    await db.orderLine.create({ data: { id: 'b1l1', orderId: 'b1', externalLineId: 'L1', offerId: 'O-50', productId: herb, qty: 50, qtyChannel: 1, unitPriceGross: '12.50', vatRate: '5' } })
    const s = await brak('b1', 'b1l1', herb, 50)
    expect(await kwota(s)).toBe(1250)
    await zmienPrzelicznik('O-50', 100)
    expect(await kwota(s)).toBe(1250)
    await zmienPrzelicznik('O-50', 25)
    expect(await kwota(s)).toBe(1250)
  })

  it('brak z pakowania 21 g z 50 g za 3,75 zł (qtyRejected 0): 1,57 zł, a po zmianie oferty nadal 1,57 zł', async () => {
    const herb = await product(db, 'TEST-SUSZ-B2', 0, { unit: 'KG', vatRate: '5' })
    await db.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herb, qtyBasePerOffer: 50 } })
    await zamowienie('b2', '16.74', 'SPAKOWANE')
    await db.orderLine.create({ data: { id: 'b2l1', orderId: 'b2', externalLineId: 'L1', offerId: 'O-50', productId: herb, qty: 50, qtyChannel: 1, unitPriceGross: '3.75', vatRate: '5' } })
    const s = await brak('b2', 'b2l1', herb, 21)
    expect(await kwota(s)).toBe(157)
    await zmienPrzelicznik('O-50', 100)
    expect(await kwota(s)).toBe(157)
  })

  it('ta sama oferta na dwóch kontach z różnym przelicznikiem (pozycje bez qtyChannel): każde zamówienie z oferty swojego konta', async () => {
    const herb = await product(db, 'TEST-SUSZ-KONTA', 0, { unit: 'KG', vatRate: '5' })
    await db.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-X', productId: herb, qtyBasePerOffer: 50 } })
    await db.channelOffer.create({ data: { ...ACC.WOO_LAMPY, externalId: 'O-X', productId: herb, qtyBasePerOffer: 100 } })
    await zamowienie('b4', '25.49', 'SPAKOWANE')
    await db.order.create({ data: { id: 'b5', ...ACC.WOO_LAMPY, externalId: 'Z-b5', status: 'SPAKOWANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '25.49', shippingCostGross: '12.99', createdAtChannel: T } })
    await db.orderLine.create({ data: { id: 'b4l1', orderId: 'b4', externalLineId: 'L1', offerId: 'O-X', productId: herb, qty: 50, unitPriceGross: '12.50', vatRate: '5' } })
    await db.orderLine.create({ data: { id: 'b5l1', orderId: 'b5', externalLineId: 'L1', offerId: 'O-X', productId: herb, qty: 100, unitPriceGross: '12.50', vatRate: '5' } })
    const s4 = await brak('b4', 'b4l1', herb, 50)
    const s5 = await brak('b5', 'b5l1', herb, 50)
    expect(await kwota(s4)).toBe(1250)
    expect(await kwota(s5)).toBe(625)
  })

  it('rodzina zamian z brakiem z pakowania: 100 g (2 × 50 g po 3,75), 30 g zamienione, brak 30 g pozycji pierwotnej = 2,25 zł; brak 30 g zamiennika = 2,25 zł', async () => {
    // stan produkcji: qtyRejected pierwotnej = tylko sztuki zamienione (30), brak z pakowania go nie zwiększa
    const herbA = await product(db, 'TEST-SUSZ-RA', 0, { unit: 'KG', vatRate: '5' })
    const herbB = await product(db, 'TEST-SUSZ-RB', 0, { unit: 'KG', vatRate: '5' })
    await db.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herbA, qtyBasePerOffer: 50 } })
    await zamowienie('b3', '20.49', 'SPAKOWANE')
    await db.orderLine.create({ data: { id: 'b3l1', orderId: 'b3', externalLineId: 'L1', offerId: 'O-50', productId: herbA, qty: 100, qtyChannel: 2, qtyRejected: 30, unitPriceGross: '3.75', vatRate: '5' } })
    await db.orderLine.create({ data: { id: 'b3l2', orderId: 'b3', externalLineId: 'L1#zamiana-1', productId: herbB, qty: 30, unitPriceGross: '3.75', vatRate: '5' } })
    const sP = await brak('b3', 'b3l1', herbA, 30)
    const sZ = await brak('b3', 'b3l2', herbB, 30)
    // pierwotna: w(100) − w(70) = 7,50 − 5,25; zamiennik (przesunięcie 70): w(100) − w(70) = 2,25
    expect(await kwota(sP)).toBe(225)
    expect(await kwota(sZ)).toBe(225)
    await zmienPrzelicznik('O-50', 100)
    expect(await kwota(sP)).toBe(225)
    expect(await kwota(sZ)).toBe(225)
  })
})
