// lista „Do zwrotu” (Braki → Do zwrotu) liczy kwotę braku tą samą regułą co
// dokument sprzedaży: ilość bazowa przeliczona na sztuki oferty (`qtyBasePerOffer`), zamiennik z przelicznikiem pozycji
// pierwotnej (`przelicznikiPozycji`), część rodziny zamian przez `wartoscCzesciGr`. Kwota do zwrotu = zapłacone za pozycję
// minus to, co zostało na dokumencie, więc dokument + zwrot = kwota pozycji co do grosza.
// Dane fikcyjne: produkty TEST-*, zamówienia wstawione wprost (bez sieci, bez kanałów).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { shortagesData } from '@/lib/panel/dane'
import { wartoscCzesciGr } from '@/lib/rdzen/zamiana'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { testDb, truncateAll } from './db'
import { ACC, product, seedBase } from './rdzen-fixtures'

const a = testDb()

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
})
afterAll(async () => {
  await a.$disconnect()
})

const T = fromWarsaw('2026-11-10', 3600_000)

async function zamowienie(id: string, totalGross: string) {
  await a.order.create({ data: { id, ...ACC.WOO_SD, externalId: `Z-${id}`, status: 'SPAKOWANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross, createdAtChannel: T } })
}

async function brak(orderId: string, orderLineId: string, productId: string, qtyBase: number) {
  return (await a.shortage.create({ data: { orderId, orderLineId, productId, qtyBase, state: 'REFUND_PENDING', resolvedAt: T } })).id
}

const kwota = async (id: string) => (await shortagesData(a)).refunds.find((r) => r.id === id)?.kwotaZwrotuGr

describe('Do zwrotu: kwota braku z przelicznikiem oferty', () => {
  it('brak 50 g z oferty 50 g za 12,50 zł → 12,50 zł do zwrotu (było 625,00 zł)', async () => {
    const herb = await product(a, 'TEST-SUSZ-A', 0, { unit: 'KG', vatRate: '5' })
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herb, qtyBasePerOffer: 50 } })
    await zamowienie('zw1', '25.99')
    await a.orderLine.create({ data: { id: 'zw1l1', orderId: 'zw1', externalLineId: 'L1', offerId: 'O-50', productId: herb, qty: 50, qtyChannel: 1, qtyRejected: 50, unitPriceGross: '12.50', vatRate: '5' } })
    const s = await brak('zw1', 'zw1l1', herb, 50)
    expect(await kwota(s)).toBe(1250)
  })

  it('oferta wielosztukowa: 2 szt. brakuje z oferty 3 szt. za 30,00 zł → 20,00 zł', async () => {
    const p = await product(a, 'TEST-SZT-3', 0)
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-3', productId: p, qtyBasePerOffer: 3 } })
    await zamowienie('zw2', '42.99')
    await a.orderLine.create({ data: { id: 'zw2l1', orderId: 'zw2', externalLineId: 'L1', offerId: 'O-3', productId: p, qty: 3, qtyChannel: 1, qtyRejected: 2, unitPriceGross: '30.00' } })
    const s = await brak('zw2', 'zw2l1', p, 2)
    expect(await kwota(s)).toBe(2000)
  })

  it('część oferty: brak 21 g z 50 g za 3,75 zł → 1,57 zł; dokument (29 g = 2,18 zł) + zwrot = 3,75 zł', async () => {
    const herb = await product(a, 'TEST-SUSZ-B', 0, { unit: 'KG', vatRate: '5' })
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herb, qtyBasePerOffer: 50 } })
    await zamowienie('zw3', '16.74')
    await a.orderLine.create({ data: { id: 'zw3l1', orderId: 'zw3', externalLineId: 'L1', offerId: 'O-50', productId: herb, qty: 50, qtyChannel: 1, qtyRejected: 21, unitPriceGross: '3.75', vatRate: '5' } })
    const s = await brak('zw3', 'zw3l1', herb, 21)
    expect(await kwota(s)).toBe(157)
    expect(wartoscCzesciGr(29, 0, 50, 375) + 157).toBe(375)
  })

  it('zamiennik bez oferty: przelicznik pozycji pierwotnej (brak 50 g zamiennika z oferty 50 g za 12,50 zł → 12,50 zł)', async () => {
    const herbA = await product(a, 'TEST-SUSZ-C', 0, { unit: 'KG', vatRate: '5' })
    const herbB = await product(a, 'TEST-SUSZ-D', 0, { unit: 'KG', vatRate: '5' })
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herbA, qtyBasePerOffer: 50 } })
    await zamowienie('zw4', '25.99')
    await a.orderLine.create({ data: { id: 'zw4l1', orderId: 'zw4', externalLineId: 'L1', offerId: 'O-50', productId: herbA, qty: 50, qtyChannel: 1, qtyRejected: 50, unitPriceGross: '12.50', vatRate: '5' } })
    await a.orderLine.create({ data: { id: 'zw4l2', orderId: 'zw4', externalLineId: 'L1#zamiana-1', productId: herbB, qty: 50, qtyRejected: 50, unitPriceGross: '12.50', vatRate: '5' } })
    const s = await brak('zw4', 'zw4l2', herbB, 50)
    expect(await kwota(s)).toBe(1250)
  })

  it('zwykła pozycja bez oferty (przelicznik 1): 2 szt. po 19,90 zł → 39,80 zł jak dotąd; składnik zestawu bez kwoty', async () => {
    const p = await product(a, 'TEST-ZWYKLY', 0)
    await zamowienie('zw5', '52.69')
    await a.orderLine.create({ data: { id: 'zw5l1', orderId: 'zw5', externalLineId: 'L1', productId: p, qty: 2, qtyRejected: 2, unitPriceGross: '19.90' } })
    const s = await brak('zw5', 'zw5l1', p, 2)
    expect(await kwota(s)).toBe(3980)
    const skladnik = await product(a, 'TEST-SKLADNIK', 0)
    const s2 = await brak('zw5', 'zw5l1', skladnik, 1)
    expect(await kwota(s2)).toBeNull()
  })
})
