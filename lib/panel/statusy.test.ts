import { describe, expect, it } from 'vitest'
import { STATUS_LABEL } from './format'
import { STAN_PLATNOSCI, STATUS_ZAMOWIENIA, statusZamowienia, trybKanalu } from './statusy'
import { maZakazaneSlowo } from './slownik'

describe('jedna mapa statusów', () => {
  it('etykiety statusów zamówień zgodne z dotychczasowymi (lista, pakowanie, karta, API panelu)', () => {
    for (const [s, l] of Object.entries(STATUS_LABEL)) expect(STATUS_ZAMOWIENIA[s as keyof typeof STATUS_ZAMOWIENIA].etykieta).toBe(l)
  })

  it('ton wg etapu: nowe info, w realizacji ostrzeżenie, gotowe sukces, problem uwaga, anulowane neutralny', () => {
    expect(statusZamowienia('NOWE').ton).toBe('info')
    expect(statusZamowienia('DO_REALIZACJI').ton).toBe('ostrzezenie')
    expect(statusZamowienia('ZEBRANE').ton).toBe('ostrzezenie')
    expect(statusZamowienia('SPAKOWANE').ton).toBe('sukces')
    expect(statusZamowienia('WYSLANE').ton).toBe('akcent')
    expect(statusZamowienia('DO_WYJASNIENIA').ton).toBe('uwaga')
    expect(statusZamowienia('ANULOWANE').ton).toBe('neutralny')
  })

  it('tryb kanału językiem użytkownika, bez „cień” i „praca”', () => {
    expect(trybKanalu('CIEN').etykieta).toBe('Tylko podgląd')
    expect(trybKanalu('PRACA').etykieta).toBe('Aktywny')
    expect(trybKanalu('PRACA', false).etykieta).toBe('Wyłączony')
    for (const t of ['CIEN', 'PRACA'] as const) {
      expect(maZakazaneSlowo(trybKanalu(t).etykieta)).toBeNull()
      expect(maZakazaneSlowo(trybKanalu(t).opis)).toBeNull()
    }
  })

  it('stan płatności ma etykietę i ton dla każdej wartości', () => {
    expect(Object.keys(STAN_PLATNOSCI).sort()).toEqual(['COD', 'PAID', 'PARTIAL', 'UNPAID'])
  })
})
