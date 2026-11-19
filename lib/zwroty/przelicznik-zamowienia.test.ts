// przelicznik z proporcji zamówienia przed aktualną ofertą.
import { describe, expect, it } from 'vitest'
import { proporcjaZamowienia, przelicznikiZZamowienia, type LiniaZamowienia } from './przelicznik-zamowienia'

const linia = (o: Partial<LiniaZamowienia> & { id: string; externalLineId: string }): LiniaZamowienia => ({ productId: 'p', offerId: 'O', qty: 50, qtyChannel: 1, qtyRejected: 0, removed: false, ...o })

describe('proporcjaZamowienia', () => {
  it('qty / qtyChannel; brak przy qtyChannel null, 0 albo qty 0', () => {
    expect(proporcjaZamowienia({ qty: 100, qtyChannel: 2 })).toBe(50)
    expect(proporcjaZamowienia({ qty: 50, qtyChannel: null })).toBeUndefined()
    expect(proporcjaZamowienia({ qty: 50, qtyChannel: 0 })).toBeUndefined()
    expect(proporcjaZamowienia({ qty: 0, qtyChannel: 1 })).toBeUndefined()
  })
})

describe('przelicznikiZZamowienia', () => {
  it('pozycja z kanału: proporcja zamówienia wygrywa z aktualną ofertą (oferta zmieniona po wysyłce)', () => {
    const r = przelicznikiZZamowienia([linia({ id: 'a', externalLineId: 'L1' })], () => 100)
    expect(r.naOferte.get('a')).toBe(50)
  })

  it('qtyChannel null: aktualna oferta; bez oferty: brak w mapie (= 1)', () => {
    const r = przelicznikiZZamowienia([linia({ id: 'a', externalLineId: 'L1', qtyChannel: null }), linia({ id: 'b', externalLineId: 'L2', qtyChannel: null, offerId: null })], () => 100)
    expect(r.naOferte.get('a')).toBe(100)
    expect(r.naOferte.has('b')).toBe(false)
  })

  it('zamiennik: proporcja pozycji pierwotnej; przesunięcie bez zmian', () => {
    const r = przelicznikiZZamowienia(
      [linia({ id: 'a', externalLineId: 'L1', qty: 100, qtyChannel: 2, qtyRejected: 30 }), linia({ id: 'b', externalLineId: 'L1#zamiana-1', qty: 30, qtyChannel: null, offerId: null, productId: 'q' })],
      () => 100,
    )
    expect(r.naOferte.get('b')).toBe(50)
    expect(r.przesuniecie.get('b')).toBe(70)
    expect(r.zamienniki.get('b')).toBeNull()
  })

  it('zamiennik bez pozycji pierwotnej w zamówieniu: bez przelicznika (jak przelicznikiPozycji)', () => {
    const r = przelicznikiZZamowienia([linia({ id: 'b', externalLineId: 'L1#zamiana-1#dosle', qtyChannel: null, offerId: null })], () => 100)
    expect(r.naOferte.has('b')).toBe(false)
    expect(r.zamienniki.get('b')).toBe('bez-pozycji-pierwotnej')
  })
})
