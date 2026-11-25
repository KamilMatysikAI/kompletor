// kolumna „Aktywny” z CSV i komunikat odmowy wyłączenia (czyste funkcje).
import { describe, expect, it } from 'vitest'
import { opisOdmow, opisUwag, parsujAktywny } from './aktywnosc'

describe('parsujAktywny', () => {
  it('„tak” / „nie” jak w eksporcie (wielkość liter i spacje bez znaczenia), 1/0; pusta = bez zmian', () => {
    expect(parsujAktywny('tak')).toEqual({ ok: true, value: true })
    expect(parsujAktywny(' NIE ')).toEqual({ ok: true, value: false })
    expect(parsujAktywny('1')).toEqual({ ok: true, value: true })
    expect(parsujAktywny('0')).toEqual({ ok: true, value: false })
    expect(parsujAktywny('')).toEqual({ ok: true, value: undefined })
    expect(parsujAktywny(undefined)).toEqual({ ok: true, value: undefined })
  })
  it('inna wartość = błąd wiersza z podpowiedzią', () => {
    const r = parsujAktywny('może')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('„tak” albo „nie”')
  })
})

describe('opisUwag', () => {
  it('pusto bez uwag; pierwsza z treścią, reszta policzona; najwyżej 300 znaków', () => {
    expect(opisUwag([])).toBe('')
    expect(opisUwag([{ productId: 'a', sku: 'Z-1', komunikat: 'zestaw ma wyłączone składniki (S-1)' }])).toBe('Uwaga, Z-1: zestaw ma wyłączone składniki (S-1).')
    const duzo = opisUwag(Array.from({ length: 40 }, (_, i) => ({ productId: String(i), sku: `S-${i}`, komunikat: 'y'.repeat(60) })))
    expect(duzo).toContain('Uwagi razem: 40')
    expect(duzo.length).toBeLessThanOrEqual(300)
  })
})

describe('opisOdmow', () => {
  it('pusto bez odmów; pierwsza z powodem, reszta policzona; najwyżej 300 znaków', () => {
    expect(opisOdmow([])).toBe('')
    const jedna = opisOdmow([{ productId: 'a', sku: 'S-1', powod: 'ma aktywną ofertę w kanale (WOO sklep)' }])
    expect(jedna).toBe('Nie wyłączono S-1: ma aktywną ofertę w kanale (WOO sklep).')
    const duzo = opisOdmow(Array.from({ length: 50 }, (_, i) => ({ productId: String(i), sku: `S-${i}`, powod: 'x'.repeat(40) })))
    expect(duzo).toContain('Pominięte razem: 50')
    expect(duzo.length).toBeLessThanOrEqual(300)
  })
})
