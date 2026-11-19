import { describe, expect, it } from 'vitest'
import { buildListLines, isMissing } from './lista-zamowien-linie'

const prods = new Map([
  ['p1', { title: 'Curry 100 g', unit: 'SZT' as const, kind: 'STOCKED' as const }],
  ['p2', { title: 'Kurkuma', unit: 'KG' as const, kind: 'STOCKED' as const }],
  ['z1', { title: 'Zestaw Papryka', unit: 'SZT' as const, kind: 'BUNDLE' as const }],
  ['c1', { title: 'Papryka 30 g', unit: 'SZT' as const, kind: 'STOCKED' as const }],
  ['c2', { title: 'Łyżeczka', unit: 'SZT' as const, kind: 'STOCKED' as const }],
  ['d1', { title: 'E-book', unit: 'SZT' as const, kind: 'DIGITAL' as const }],
])

describe('pozycje listy zamówień', () => {
  it('brak przypięty do pozycji, nie do zamówienia; kolejność pozycji zostaje', () => {
    const m = buildListLines(
      [
        { orderId: 'o1', productId: 'p1', qty: 2, shortages: [] },
        { orderId: 'o1', productId: 'p2', qty: 300, shortages: [{ productId: 'p2', qtyBase: 100 }, { productId: 'p2', qtyBase: 50 }] },
        { orderId: 'o2', productId: null, qty: 1, shortages: [] },
      ],
      prods,
    )
    const o1 = m.get('o1')!
    expect(o1.map((l) => l.title)).toEqual(['Curry 100 g', 'Kurkuma'])
    expect(o1.map(isMissing)).toEqual([false, true])
    expect(o1[1]).toMatchObject({ unit: 'KG', missing: 150, missingParts: [] })
    expect(m.get('o2')![0]).toMatchObject({ title: 'pozycja bez powiązania z produktem', unit: 'SZT', missing: 0 })
  })

  it('zestaw: brakujące składniki z nazwy, bez dubli', () => {
    const m = buildListLines(
      [{ orderId: 'o1', productId: 'z1', qty: 1, shortages: [{ productId: 'c1', qtyBase: 1 }, { productId: 'c1', qtyBase: 1 }, { productId: 'c2', qtyBase: 1 }] }],
      prods,
    )
    const l = m.get('o1')![0]!
    expect(l).toMatchObject({ bundle: true, missing: 0, missingParts: ['Papryka 30 g', 'Łyżeczka'] })
    expect(isMissing(l)).toBe(true)
  })

  it('produkt cyfrowy oznaczony jako bez stanu', () => {
    const m = buildListLines([{ orderId: 'o1', productId: 'd1', qty: 1, shortages: [] }], prods)
    expect(m.get('o1')![0]).toMatchObject({ digital: true, bundle: false, missing: 0 })
    expect(buildListLines([{ orderId: 'o1', productId: 'p1', qty: 1, shortages: [] }], prods).get('o1')![0]!.digital).toBe(false)
  })

  it('brak składnika nie znika, gdy produktu zestawu nie ma w katalogu', () => {
    const m = buildListLines([{ orderId: 'o1', productId: 'zniknal', qty: 1, shortages: [{ productId: 'c1', qtyBase: 1 }] }], prods)
    const l = m.get('o1')![0]!
    expect(l.missingParts).toEqual(['Papryka 30 g'])
    expect(isMissing(l)).toBe(true)
  })

  it('miniatura: główne zdjęcie produktu pozycji, bez zdjęcia albo bez produktu brak', () => {
    const m = buildListLines(
      [
        { orderId: 'o1', productId: 'p1', qty: 1, shortages: [] },
        { orderId: 'o1', productId: 'p2', qty: 1, shortages: [] },
        { orderId: 'o1', productId: null, channelName: 'Coś z kanału', qty: 1, shortages: [] },
      ],
      prods,
      new Map([['p1', 'img1']]),
    )
    expect(m.get('o1')!.map((l) => l.zdjecie)).toEqual(['img1', null, null])
    expect(buildListLines([{ orderId: 'o1', productId: 'p1', qty: 1, shortages: [] }], prods).get('o1')![0]!.zdjecie).toBeNull()
  })
})
