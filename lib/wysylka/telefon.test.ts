// wspólny odczyt telefonu dla przewoźników (prefiks kraju dla Wysyłam z Allegro, 9 cyfr dla InPost ShipX).
import { describe, expect, it } from 'vitest'
import { odczytajTelefon, telefonBezPrefiksu, telefonZPrefiksem } from './telefon'

describe('telefonZPrefiksem', () => {
  it('numer polski w różnych zapisach → +48 i 9 cyfr', () => {
    for (const t of ['600 100 200', '600-100-200', '600100200', '+48600100200', '+48 600 100 200', '0048600100200', '0048 600-100-200', '48600100200', '(+48) 600.100.200', ' 600 100 200 '])
      expect(telefonZPrefiksem(t), t).toBe('+48600100200')
  })

  it('numer zagraniczny z „+” albo „00” zostaje ze swoim prefiksem', () => {
    expect(telefonZPrefiksem('+49 151 12345678')).toBe('+4915112345678')
    expect(telefonZPrefiksem('0049 151 12345678')).toBe('+4915112345678')
    expect(telefonZPrefiksem('+420 601 123 456')).toBe('+420601123456')
    expect(odczytajTelefon('+49 151 12345678')).toEqual({ prefiks: null, krajowyPL: null, miedzynarodowy: '+4915112345678' })
  })

  it('śmieci, pusty, za krótki, za długi, numer zagraniczny bez prefiksu = null (bez zgadywania)', () => {
    for (const t of ['', '   ', 'brak', 'tel. 600100200', '600 1OO 200', '60010020', '6001002001', '+48 600 100 20', '+48 600 100 2000', '0600100200', '015112345678', '4915112345678', '+0600100200', '+1234567', '+1234567890123456', '++48600100200', '600100200 wew. 12'])
      expect(telefonZPrefiksem(t), t).toBeNull()
    expect(telefonZPrefiksem(null)).toBeNull()
    expect(telefonZPrefiksem(undefined)).toBeNull()
  })

  it('numer polski: krajowy do ShipX', () => {
    expect(odczytajTelefon('+48 600 100 200')).toEqual({ prefiks: '48', krajowyPL: '600100200', miedzynarodowy: '+48600100200' })
    expect(odczytajTelefon('+48 060 010 020')).toBeNull()
  })

  it('+48 tylko dla kraju PL albo bez kraju; inny kraj bez prefiksu = null', () => {
    expect(odczytajTelefon('601123456', { krajDomyslny: 'CZ' })).toBeNull()
    expect(telefonZPrefiksem('601 123 456', { krajDomyslny: 'cz' })).toBeNull()
    expect(telefonZPrefiksem('48601123456', { krajDomyslny: 'DE' })).toBeNull()
    expect(telefonZPrefiksem('601123456', { krajDomyslny: 'PL' })).toBe('+48601123456')
    expect(telefonZPrefiksem('601123456', { krajDomyslny: ' pl ' })).toBe('+48601123456')
    expect(telefonZPrefiksem('601123456', { krajDomyslny: null })).toBe('+48601123456')
    expect(telefonZPrefiksem('601123456')).toBe('+48601123456')
    expect(telefonZPrefiksem('+420 601 123 456', { krajDomyslny: 'CZ' })).toBe('+420601123456')
    expect(telefonZPrefiksem('00420601123456', { krajDomyslny: 'CZ' })).toBe('+420601123456')
  })

  it('komunikat bez wartości numeru, z przykładem formatu', () => {
    const m = telefonBezPrefiksu('odbiorcy')
    expect(m).toContain('telefon odbiorcy')
    expect(m).toContain('+48')
  })
})
