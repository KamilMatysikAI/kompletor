import { describe, expect, it } from 'vitest'
import { dniSprzedazyZEnv, dniZArgumentu, oknoSprzedazy } from './okno-sprzedazy'

describe('okno sprzedaży importu katalogu', () => {
  it('sufit z env: puste = 0, liczba = liczba, śmieci = błąd', () => {
    expect(dniSprzedazyZEnv({})).toBe(0)
    expect(dniSprzedazyZEnv({ KATALOG_IMPORT_DNI_SPRZEDAZY: ' ' })).toBe(0)
    expect(dniSprzedazyZEnv({ KATALOG_IMPORT_DNI_SPRZEDAZY: '90' })).toBe(90)
    for (const zle of ['-1', '1.5', 'abc', '366']) expect(() => dniSprzedazyZEnv({ KATALOG_IMPORT_DNI_SPRZEDAZY: zle })).toThrow(/KATALOG_IMPORT_DNI_SPRZEDAZY/)
  })
  it('payload przycięty do sufitu; brak albo śmieci = sufit', () => {
    expect(oknoSprzedazy(undefined, 0)).toBe(0)
    expect(oknoSprzedazy(90, 0)).toBe(0)
    expect(oknoSprzedazy(30, 90)).toBe(30)
    expect(oknoSprzedazy(120, 90)).toBe(90)
    expect(oknoSprzedazy('90', 0)).toBe(0)
    expect(oknoSprzedazy(-5, 7)).toBe(7)
    expect(oknoSprzedazy(Number.NaN, 7)).toBe(7)
  })
  it('CLI --dni: brak = sufit, ponad sufit = błąd', () => {
    expect(dniZArgumentu(undefined, 0)).toBe(0)
    expect(dniZArgumentu('30', 90)).toBe(30)
    expect(() => dniZArgumentu('90', 0)).toThrow(/ponad sufit/)
    expect(() => dniZArgumentu('x', 90)).toThrow(/--dni/)
  })
  it('tylko same cyfry — zapis wykładniczy, szesnastkowy i z kropką to błąd', () => {
    for (const zle of ['1e2', '0x10', '90.0', '+5', '0b11'])
      expect(() => dniSprzedazyZEnv({ KATALOG_IMPORT_DNI_SPRZEDAZY: zle }), zle).toThrow(/KATALOG_IMPORT_DNI_SPRZEDAZY/)
    expect(dniSprzedazyZEnv({ KATALOG_IMPORT_DNI_SPRZEDAZY: ' 007 ' })).toBe(7)
    for (const zle of ['1e1', '0x5', '5.0', '']) expect(() => dniZArgumentu(zle, 90), zle).toThrow(/--dni/)
    expect(dniZArgumentu('7', 90)).toBe(7)
  })
})
