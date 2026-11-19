// czyste funkcje listy przesyłek (bez bazy).
import { describe, expect, it } from 'vitest'
import { filtryPrzesylekZ, idPrzesylekZ, kluczKonta, nazwaModulu } from './lista'

describe('lista przesyłek: pomocnicze', () => {
  it('nazwa modułu bez opisu technicznego', () => {
    expect(nazwaModulu('DPD Polska (bezpośrednio, zapis za wyłącznikiem)')).toBe('DPD Polska')
    expect(nazwaModulu('InPost ShipX z tworzeniem przesyłek (za wyłącznikiem)')).toBe('InPost ShipX')
    expect(nazwaModulu('Base Courier')).toBe('Base Courier')
  })
  it('klucz konta i identyfikatory z adresu', () => {
    expect(kluczKonta('dpd.services.zapis.v1', 'EMPIK')).toBe('dpd.services.zapis.v1~EMPIK')
    expect(kluczKonta('dpd.services.zapis.v1', null)).toBe('dpd.services.zapis.v1')
    expect(idPrzesylekZ('a1,b2,a1,../x, c3 ', 10)).toEqual({ ids: ['a1', 'b2', 'c3'], zaDuzo: false })
    expect(idPrzesylekZ(['a1,b2', 'c3'], 2)).toEqual({ ids: ['a1', 'b2'], zaDuzo: true })
  })
  it('filtry: numer bez spacji, konto drugie', () => {
    expect(filtryPrzesylekZ({ numer: ' 0000 1234 ', konto: 'dpd.services.zapis.v1~EMPIK' })).toMatchObject({ numer: '00001234', konto: 'dpd.services.zapis.v1~EMPIK' })
  })
})
