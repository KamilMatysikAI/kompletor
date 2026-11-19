import { describe, expect, it } from 'vitest'
import type { PozycjaZbierania } from '@/lib/stanowisko/zamowienia'
import { listaZbierania } from './zbieranie'

const poz = (o: Partial<PozycjaZbierania> & { productId: string | null; ilosc: number }): PozycjaZbierania => ({
  klucz: `${o.orderLineId ?? 'l'}:${o.productId ?? ''}`,
  orderLineId: o.orderLineId ?? 'l',
  nazwa: o.nazwa ?? `Produkt ${o.productId}`,
  dopisek: null,
  sku: o.sku ?? null,
  lokalizacja: o.lokalizacja ?? null,
  jednostka: o.jednostka ?? 'szt',
  zdjecie: o.zdjecie ?? null,
  ...o,
})

describe('lista zbierania', () => {
  it('sumuje produkt z wielu zamówień, rozpisuje na koszyki i układa po półkach naturalnie', () => {
    const lista = listaZbierania([
      { id: 'o1', numer: 'SH 1', koszyk: 'A', pozycje: [poz({ productId: 'p1', ilosc: 2, lokalizacja: 'C-4-10' }), poz({ productId: 'p2', ilosc: 1, lokalizacja: 'C-4-2' })] },
      { id: 'o2', numer: 'SH 2', koszyk: null, pozycje: [poz({ productId: 'p1', ilosc: 3, lokalizacja: 'C-4-10' }), poz({ productId: 'p3', ilosc: 1 })] },
    ])
    expect(lista.map((p) => [p.productId, p.lokalizacja, p.razem])).toEqual([
      ['p2', 'C-4-2', 1],
      ['p1', 'C-4-10', 5],
      ['p3', null, 1],
    ])
    expect(lista[1]!.doKoszykow).toEqual([
      { orderId: 'o1', numer: 'SH 1', koszyk: 'A', ilosc: 2 },
      { orderId: 'o2', numer: 'SH 2', koszyk: null, ilosc: 3 },
    ])
  })

  it('ten sam produkt dwa razy w jednym zamówieniu (np. osobno i ze składnika zestawu) = jedna linia koszyka', () => {
    const [p] = listaZbierania([{ id: 'o1', numer: 'SH 1', koszyk: 'B', pozycje: [poz({ productId: 'p1', ilosc: 1, orderLineId: 'l1' }), poz({ productId: 'p1', ilosc: 2, orderLineId: 'l2' })] }])
    expect(p!.razem).toBe(3)
    expect(p!.doKoszykow).toEqual([{ orderId: 'o1', numer: 'SH 1', koszyk: 'B', ilosc: 3 }])
  })

  it('pozycje bez powiązania z produktem nie sklejają się ze sobą; gramy osobno od sztuk', () => {
    const lista = listaZbierania([
      { id: 'o1', numer: 'SH 1', koszyk: null, pozycje: [poz({ productId: null, ilosc: 1, orderLineId: 'a' }), poz({ productId: 'p1', ilosc: 100, jednostka: 'g' })] },
      { id: 'o2', numer: 'SH 2', koszyk: null, pozycje: [poz({ productId: null, ilosc: 1, orderLineId: 'b' }), poz({ productId: 'p1', ilosc: 1 })] },
    ])
    expect(lista).toHaveLength(4)
  })

  it('pusta lista dla zamówień bez pozycji do zebrania', () => {
    expect(listaZbierania([{ id: 'o1', numer: 'SH 1', koszyk: null, pozycje: [] }])).toEqual([])
  })
})
