// wartość pozycji rdzenia z ceny za sztukę oferty i ilości w jednostce bazowej. Dane fikcyjne, bez bazy.
import { describe, expect, it } from 'vitest'
import { rozpiszNaJednostkiBazowe, wartoscPozycjiGr } from './ceny'

const suma = (x: { qty: number; unitGrossGr: number }[]) => x.reduce((s, l) => s + l.qty * l.unitGrossGr, 0)

describe('wartość pozycji przy qtyBasePerOffer', () => {
  it('oferta 50 g za 12,50 zł, 2 sztuki oferty = 100 g → 25 zł, nie 1250 zł', () => {
    expect(wartoscPozycjiGr(100, 50, 1250)).toBe(2500)
    const linie = rozpiszNaJednostkiBazowe(100, 2500)
    expect(linie).toEqual([{ qty: 100, unitGrossGr: 25 }])
    expect(suma(linie)).toBe(2500)
  })

  it('oferta wielosztukowa: 3 szt. za 30 zł, 2 oferty = 6 szt. → 60 zł, 10 zł za sztukę', () => {
    expect(wartoscPozycjiGr(6, 3, 3000)).toBe(6000)
    expect(rozpiszNaJednostkiBazowe(6, 6000)).toEqual([{ qty: 6, unitGrossGr: 1000 }])
  })

  it('bez oferty (naOferte 1): bez zmian względem ceny pozycji', () => {
    expect(wartoscPozycjiGr(2, 1, 1599)).toBe(3198)
    expect(rozpiszNaJednostkiBazowe(2, 3198)).toEqual([{ qty: 2, unitGrossGr: 1599 }])
  })

  it('wartość niepodzielna przez gramy: dwie części, suma co do grosza', () => {
    const linie = rozpiszNaJednostkiBazowe(50, 1299)
    expect(linie).toEqual([{ qty: 1, unitGrossGr: 25 }, { qty: 49, unitGrossGr: 26 }])
    expect(suma(linie)).toBe(1299)
  })

  it('część oferty (spakowane 25 g z oferty 50 g za 12,99 zł): wartość zaokrąglona do grosza', () => {
    expect(wartoscPozycjiGr(25, 50, 1299)).toBe(650)
    expect(suma(rozpiszNaJednostkiBazowe(25, 650))).toBe(650)
  })

  it('cena poniżej 1 gr za gram: suma nadal równa wartości', () => {
    const linie = rozpiszNaJednostkiBazowe(1000, 900)
    expect(suma(linie)).toBe(900)
    expect(linie.reduce((s, l) => s + l.qty, 0)).toBe(1000)
  })

  it('zła liczba sztuk na ofertę (0, ujemna) liczy jak 1 zamiast dzielić przez zero', () => {
    expect(wartoscPozycjiGr(2, 0, 1000)).toBe(2000)
    expect(wartoscPozycjiGr(2, -5, 1000)).toBe(2000)
  })
})
