// wybór reguły przewoźnika dla zamówienia (podgląd i nadanie przesyłki). Bez bazy.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CARRIER_RULES, POWOD_BRAK_REGULY, POWOD_REGULY_ZMIENIONE, powodInnegoModulu, regulaDlaZamowienia } from './przewoznicy'

const REGULY = DEFAULT_CARRIER_RULES.map((r) => (r.carrier === 'DPD' ? { ...r, shippingModule: 'DPD_BEZPOSREDNIO' as const } : r))

describe('regulaDlaZamowienia', () => {
  it('metoda dostawy wskazuje regułę tego przewoźnika: ta reguła (jak przy przyjęciu z kanału)', () => {
    const w = regulaDlaZamowienia(REGULY, { channel: 'WOO', carrier: 'DPD', metodaDostawy: 'Kurier DPD', shippingModule: 'DPD_BEZPOSREDNIO' })
    expect(w.regula).toMatchObject({ priority: 40, carrier: 'DPD' })
  })

  it('zamówienie ręczne: metoda bez reguły, przewoźnik wybrany wprost = reguła tego przewoźnika i modułu', () => {
    const w = regulaDlaZamowienia(REGULY, { channel: 'RECZNE', carrier: 'DPD', metodaDostawy: 'Wysyłka do klienta', shippingModule: 'DPD_BEZPOSREDNIO' })
    expect(w).toMatchObject({ powod: null, regula: { carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO' } })
  })

  it('metoda wskazuje innego przewoźnika niż wybrany: reguła wybranego przewoźnika, gdy moduł się zgadza', () => {
    const w = regulaDlaZamowienia(REGULY, { channel: 'RECZNE', carrier: 'DPD', metodaDostawy: 'paczkomat', shippingModule: 'DPD_BEZPOSREDNIO' })
    expect(w.regula).toMatchObject({ carrier: 'DPD' })
  })

  it('moduł zamówienia inny niż w regule: osobny powód z obiema nazwami modułów, bez zgadywania', () => {
    const w = regulaDlaZamowienia(REGULY, { channel: 'RECZNE', carrier: 'DPD', metodaDostawy: 'Wysyłka do klienta', shippingModule: 'BASE_COURIER' })
    expect(w).toEqual({ regula: null, powod: powodInnegoModulu('BASE_COURIER', 'DPD_BEZPOSREDNIO') })
    expect(w.powod).toMatch(/„Base Courier”.*„DPD”/)
    expect(regulaDlaZamowienia(REGULY, { channel: 'WOO', carrier: 'DPD', metodaDostawy: 'paczkomat', shippingModule: 'BASE_COURIER' })).toEqual({ regula: null, powod: POWOD_REGULY_ZMIENIONE })
  })

  it('zamówienie ręczne przyjęte bez modułu (BRAK albo puste), właściciel ustawił potem moduł: reguła przewoźnika z tym modułem', () => {
    for (const shippingModule of ['BRAK', null] as const)
      expect(regulaDlaZamowienia(REGULY, { channel: 'RECZNE', carrier: 'DPD', metodaDostawy: 'Wysyłka do klienta', shippingModule })).toMatchObject({ powod: null, regula: { carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO' } })
  })

  it('wybór wprost bez reguły przewoźnika, choć metoda wskazuje inną regułę: „brak reguły”, nie „reguły zmieniły się”', () => {
    const bezDpd = REGULY.filter((r) => r.carrier !== 'DPD')
    expect(regulaDlaZamowienia(bezDpd, { channel: 'RECZNE', carrier: 'DPD', metodaDostawy: 'paczkomat', shippingModule: 'DPD_BEZPOSREDNIO' })).toEqual({ regula: null, powod: POWOD_BRAK_REGULY })
  })

  it('zamówienie z kanału, którego metoda wskazuje dziś innego przewoźnika: powód, nawet gdy reguła przewoźnika i modułu istnieje', () => {
    expect(regulaDlaZamowienia(REGULY, { channel: 'WOO', carrier: 'DPD', metodaDostawy: 'paczkomat', shippingModule: 'DPD_BEZPOSREDNIO' })).toEqual({ regula: null, powod: POWOD_REGULY_ZMIENIONE })
    // metoda bez żadnej reguły (przewoźnik ustawiony przy wyjaśnieniu): reguła przewoźnika i modułu
    expect(regulaDlaZamowienia(REGULY, { channel: 'WOO', carrier: 'DPD', metodaDostawy: 'Wysyłka', shippingModule: 'DPD_BEZPOSREDNIO' }).regula).toMatchObject({ carrier: 'DPD' })
  })

  it('reguła innego kanału nie pasuje (Allegro tylko dla Allegro)', () => {
    expect(regulaDlaZamowienia(REGULY, { channel: 'RECZNE', carrier: 'ALLEGRO', metodaDostawy: 'x', shippingModule: 'WYSYLAM_Z_ALLEGRO' }).regula).toBeNull()
    expect(regulaDlaZamowienia(REGULY, { channel: 'ALLEGRO', carrier: 'ALLEGRO', metodaDostawy: 'x', shippingModule: 'WYSYLAM_Z_ALLEGRO' }).regula).toMatchObject({ carrier: 'ALLEGRO' })
  })

  it('kilka reguł tego przewoźnika i modułu: pierwsza wg priorytetu, także gdy lista nieposortowana', () => {
    const r = [{ priority: 90, channel: null, pattern: 'x', carrier: 'DPD' as const, shippingModule: 'DPD_BEZPOSREDNIO' as const }, { priority: 60, channel: null, pattern: 'y', carrier: 'DPD' as const, shippingModule: 'DPD_BEZPOSREDNIO' as const }]
    expect(regulaDlaZamowienia(r, { channel: 'RECZNE', carrier: 'DPD', metodaDostawy: 'z', shippingModule: 'DPD_BEZPOSREDNIO' }).regula!.priority).toBe(60)
  })
})

describe('regulaDlaZamowienia: sposób wysyłki zmieniony na karcie zamówienia', () => {
  it('zamówienie ze sklepu z metodą „Paczkomaty”, przewoźnik zmieniony na DPD: reguła DPD, nie „reguły zmieniły się”', () => {
    const w = regulaDlaZamowienia(REGULY, { channel: 'WOO', carrier: 'DPD', metodaDostawy: 'Paczkomaty InPost', shippingModule: 'DPD_BEZPOSREDNIO', przewoznikRecznie: true })
    expect(w).toMatchObject({ powod: null, regula: { carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO' } })
  })

  it('ten sam przewoźnik, inny moduł niż reguła z metody dostawy: wybór ręczny bierze regułę z modułem zamówienia', () => {
    const reguly = [...REGULY, { priority: 60, channel: null, pattern: 'paczkomat eco', carrier: 'PACZKOMATY' as const, shippingModule: 'INPOST_SHIPX' as const }]
    const w = regulaDlaZamowienia(reguly, { channel: 'WOO', carrier: 'PACZKOMATY', metodaDostawy: 'Paczkomaty InPost', shippingModule: 'INPOST_SHIPX', przewoznikRecznie: true })
    expect(w.regula).toMatchObject({ priority: 60, shippingModule: 'INPOST_SHIPX' })
  })

  it('bez znacznika wyboru ręcznego zachowanie bez zmian: zamówienie z kanału z innym przewoźnikiem dostaje powód', () => {
    const w = regulaDlaZamowienia(REGULY, { channel: 'WOO', carrier: 'DPD', metodaDostawy: 'Paczkomaty InPost', shippingModule: 'DPD_BEZPOSREDNIO' })
    expect(w).toEqual({ regula: null, powod: POWOD_REGULY_ZMIENIONE })
  })
})
