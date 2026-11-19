// pozycje listy „Zamówienia” z brakiem przy konkretnej pozycji, przez klienta firmy.
//  1. firma A nie widzi pozycji ani braków firmy B, nawet gdy poda id jej zamówienia;
//  2. brak produktu i brak składnika zestawu trafiają do właściwej pozycji; pozycja usunięta w kanale znika.
// Dane wyłącznie testowe (zmyślone produkty i zamówienia).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { isMissing, orderListLines } from '@/lib/panel/lista-zamowien'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { bundle, order, product, seedBase } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb() // wspólny klient systemowy testów (nie rozłączać, używa go truncateAll)

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

describe('orderListLines (lista zamówień)', () => {
  it('firma A nie widzi pozycji firmy B; brak przypięty do pozycji i do składnika zestawu', async () => {
    const pa = await product(a, 'WSPOLNY', 5)
    await a.product.update({ where: { id: pa }, data: { title: 'Przyprawa firmy A' } })
    const pb = await product(b, 'WSPOLNY', 1)
    await b.product.update({ where: { id: pb }, data: { title: 'Kawa firmy B' } })
    const part = await product(b, 'SKLADNIK', 0)
    await b.product.update({ where: { id: part }, data: { title: 'Łyżeczka firmy B' } })
    const zb = await bundle(b, 'ZESTAW', [{ id: part, qty: 1 }])

    const oa = (await ingestOrder(a, order([{ productId: pa, qty: 2 }]))).orderId!
    // B: 3 szt. przy stanie 1 → brak 2 na pierwszej pozycji; zestaw bez składnika na drugiej
    const ob = (await ingestOrder(b, order([{ productId: pb, qty: 3 }, { productId: zb, qty: 1 }]))).orderId!

    const fromA = await orderListLines(a, [oa, ob])
    expect([...fromA.keys()]).toEqual([oa])
    expect(fromA.get(oa)!.map((l) => [l.title, l.qty, isMissing(l)])).toEqual([['Przyprawa firmy A', 2, false]])

    const fromB = await orderListLines(b, [oa, ob])
    expect([...fromB.keys()]).toEqual([ob])
    const [kawa, zestaw] = fromB.get(ob)!
    expect(kawa).toMatchObject({ title: 'Kawa firmy B', qty: 3, missing: 2, missingParts: [], bundle: false })
    expect(zestaw).toMatchObject({ title: 'Zestaw ZESTAW', bundle: true, missing: 0, missingParts: ['Łyżeczka firmy B'] })

    // pozycja usunięta w kanale nie pokazuje się na liście
    await sys.orderLine.updateMany({ where: { orderId: ob, productId: zb }, data: { removed: true } })
    expect((await orderListLines(b, [ob])).get(ob)!.map((l) => l.title)).toEqual(['Kawa firmy B'])
    expect(await orderListLines(b, [])).toEqual(new Map())
  })

  it('klient systemowy (bez firmy) jest odrzucany', async () => {
    await expect(orderListLines(sys, ['x'])).rejects.toThrow()
  })
})
