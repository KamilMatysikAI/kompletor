import { describe, expect, it } from 'vitest'
import { odczytajSkan } from '@/lib/stanowisko/kod'
import { kodKoszyka, kolejneNazwy, nazwaKoszyka, odczytajKodKoszyka, porownajNazwy } from './kod'

describe('koszyki: nazwa i kod', () => {
  it('nazwa: wielkie litery i cyfry, 1–8 znaków, polskie litery bez ogonków', () => {
    expect(nazwaKoszyka(' a ')).toBe('A')
    expect(nazwaKoszyka('w12')).toBe('W12')
    expect(nazwaKoszyka('Łąka')).toBe('LAKA')
    expect(nazwaKoszyka('')).toBeNull()
    expect(nazwaKoszyka('ABCDEFGHI')).toBeNull()
    expect(nazwaKoszyka('A-1')).toBeNull()
    expect(nazwaKoszyka('../x')).toBeNull()
    expect(nazwaKoszyka(12)).toBeNull()
  })

  it('kod koszyka czyta się z tolerancją na czytnik, a nie myli z kartą zamówienia', () => {
    expect(odczytajKodKoszyka(kodKoszyka('B'))).toBe('B')
    expect(odczytajKodKoszyka(']C1KOSZ-B\r\n')).toBe('B')
    expect(odczytajKodKoszyka(' kosz-w12 ')).toBe('W12')
    expect(odczytajKodKoszyka('KOSZ-')).toBeNull()
    expect(odczytajKodKoszyka('SD48213/1')).toBeNull()
    expect(odczytajKodKoszyka('B')).toBeNull()
    // kod koszyka nie jest kodem karty i odwrotnie
    expect(odczytajSkan('KOSZ-B')).toBeNull()
    expect(odczytajKodKoszyka('KOSZ-B/1')).toBeNull()
  })

  it('kolejne nazwy: A…J dla pustej firmy, pomija zajęte, po Z idzie AA', () => {
    expect(kolejneNazwy([], 10)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
    expect(kolejneNazwy(['A', 'C'], 3)).toEqual(['B', 'D', 'E'])
    expect(kolejneNazwy([], 28).slice(-2)).toEqual(['AA', 'AB'])
    expect(kolejneNazwy([], 0)).toEqual([])
  })

  it('porządek: A, B, Z, AA; W2 przed W10', () => {
    expect(['AA', 'B', 'A', 'Z'].sort(porownajNazwy)).toEqual(['A', 'B', 'Z', 'AA'])
    expect(['W10', 'W2'].sort(porownajNazwy)).toEqual(['W2', 'W10'])
  })
})
