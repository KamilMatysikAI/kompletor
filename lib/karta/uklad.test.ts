// tryb sekcji karty z adresu i podsumowanie pozycji netto / VAT / brutto.
import { describe, expect, it } from 'vitest'
import { nettoGr } from '@/lib/dokumenty/pozycje'
import { adresEdycji, adresOdczytu, nazwaWKanaleInna, podsumowaniePozycji, sekcjaEdycji } from './uklad'

describe('tryb sekcji z adresu', () => {
  it('znane sekcje włączają edycję, reszta to odczyt', () => {
    expect(sekcjaEdycji('pozycje')).toBe('pozycje')
    expect(sekcjaEdycji('klient')).toBe('klient')
    expect(sekcjaEdycji('platnosc')).toBeNull()
    expect(sekcjaEdycji(['pozycje'])).toBeNull()
    expect(sekcjaEdycji(undefined)).toBeNull()
  })
  it('adresy edycji i odczytu z kotwicą sekcji', () => {
    expect(adresEdycji('o1', 'pozycje')).toBe('/zamowienia/o1?edytuj=pozycje#pozycje')
    expect(adresOdczytu('o1', 'pozycje')).toBe('/zamowienia/o1#pozycje')
  })
  it('dane kupującego i do faktury: edycja w kartach „Wysyłka” i „Dane do faktury”', () => {
    expect(sekcjaEdycji('kupujacy')).toBe('kupujacy')
    expect(sekcjaEdycji('faktura')).toBe('faktura')
    expect(adresEdycji('o1', 'kupujacy')).toBe('/zamowienia/o1?edytuj=kupujacy#wysylka')
    expect(adresEdycji('o1', 'faktura')).toBe('/zamowienia/o1?edytuj=faktura#dane-faktury')
  })
})

describe('podsumowanie pozycji', () => {
  it('netto z każdej stawki, zw/np bez VAT, brutto jak suma pozycji karty', () => {
    const p = podsumowaniePozycji([
      { unitPriceGross: '12.30', qty: 2, qtyRejected: 0, naOferte: 1, stawka: '23' },
      { unitPriceGross: 10.8, qty: 1, qtyRejected: 0, naOferte: 1, stawka: '8.00' },
      { unitPriceGross: '5', qty: 3, qtyRejected: 1, naOferte: 1, stawka: 'zw' },
    ])
    expect(p).toEqual({ bruttoGr: 2460 + 1080 + 1000, nettoGr: 2000 + 1000 + 1000, vatGr: 460 + 80, bezStawki: 0 })
  })
  it('cena za opakowanie oferty: ilość w jednostce bazowej dzielona przez naOferte', () => {
    expect(podsumowaniePozycji([{ unitPriceGross: '24.60', qty: 200, qtyRejected: 0, naOferte: 100, stawka: '23' }])).toMatchObject({ bruttoGr: 4920, nettoGr: 4000 })
  })
  it('netto per stawka z sumy brutto, jak dokument sprzedaży (nie per pozycja)', () => {
    // per pozycja byłoby 80 + 80 = 160 gr netto; dokument liczy 198 / 1,23 = 161 gr
    const p = podsumowaniePozycji([
      { unitPriceGross: '0.99', qty: 1, qtyRejected: 0, naOferte: 1, stawka: '23' },
      { unitPriceGross: '0.99', qty: 1, qtyRejected: 0, naOferte: 1, stawka: '23.00' },
    ])
    expect(p).toEqual({ bruttoGr: 198, nettoGr: 161, vatGr: 37, bezStawki: 0 })
    expect(p.nettoGr).toBe(nettoGr([{ bruttoGr: 99, stawkaVat: '23' }, { bruttoGr: 99, stawkaVat: '23' }]))
  })
  it('pozycja bez znanej stawki (zestaw): sama kwota brutto, netto i VAT puste', () => {
    expect(podsumowaniePozycji([
      { unitPriceGross: '10', qty: 1, qtyRejected: 0, naOferte: 1, stawka: '23' },
      { unitPriceGross: '69', qty: 1, qtyRejected: 0, naOferte: 1, stawka: null },
    ])).toEqual({ bruttoGr: 7900, nettoGr: null, vatGr: null, bezStawki: 1 })
  })
})

describe('„w kanale” pod nazwą produktu', () => {
  it('ta sama nazwa bez dopisku, inna wielkość liter albo interpunkcja: bez linii', () => {
    expect(nazwaWKanaleInna('Japan Kurkuma Fukujyu 50g', 'Japan Kurkuma Fukujyu')).toBe(false)
    expect(nazwaWKanaleInna('Japan Kurkuma Uchiyama organic 50g', 'japan kurkuma uchiyama organic')).toBe(false)
    expect(nazwaWKanaleInna('Przyprawa zielona', 'Przyprawa zielona, 100 g')).toBe(false)
    expect(nazwaWKanaleInna('Zestaw', 'zestaw')).toBe(false)
    expect(nazwaWKanaleInna('Zestaw', null)).toBe(false)
    expect(nazwaWKanaleInna('Zestaw', '   ')).toBe(false)
  })
  it('inna nazwa: linia zostaje', () => {
    expect(nazwaWKanaleInna('Japan Kurkuma Fukujyu 50g', 'Lampa przyprawowa serce')).toBe(true)
    // sam początek słowa to nie ta sama nazwa
    expect(nazwaWKanaleInna('Przyprawa zielonawa', 'Przyprawa zielona')).toBe(true)
  })
})
