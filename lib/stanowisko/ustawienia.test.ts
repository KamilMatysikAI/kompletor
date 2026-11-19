import { describe, expect, it } from 'vitest'
import { parseUstawienia } from './ustawienia'
import { gabarytyDla, ocenaGabarytu, podpowiedzGabarytu } from './gabaryty'

describe('ustawienia stanowiska', () => {
  it('domyślnie: wróć sam do skanu po 3 s; złe wartości = domyślne', () => {
    expect(parseUstawienia({})).toEqual({ powrotDoSkanu: true, powrotPoSekundach: 3, koszykWymagany: false })
    expect(parseUstawienia(null)).toEqual({ powrotDoSkanu: true, powrotPoSekundach: 3, koszykWymagany: false })
    expect(parseUstawienia({ stanowisko: { powrotDoSkanu: false, powrotPoSekundach: 5 } })).toEqual({ powrotDoSkanu: false, powrotPoSekundach: 5, koszykWymagany: false })
    expect(parseUstawienia({ stanowisko: { powrotDoSkanu: 'tak', powrotPoSekundach: 0 } })).toEqual({ powrotDoSkanu: true, powrotPoSekundach: 3, koszykWymagany: false })
    expect(parseUstawienia({ stanowisko: { koszykWymagany: true } }).koszykWymagany).toBe(true)
    expect(parseUstawienia({ stanowisko: { koszykWymagany: 'tak' } }).koszykWymagany).toBe(false)
  })
})

describe('gabaryty', () => {
  it('wg przewoźnika zamówienia, nieustalony = wszystkie paczkowe', () => {
    expect(gabarytyDla('PACZKOMATY')).toEqual(['INPOST_A', 'INPOST_B', 'INPOST_C'])
    expect(gabarytyDla('ALLEGRO')).toEqual(['ALLEGRO_A', 'ALLEGRO_B', 'ALLEGRO_C'])
    expect(gabarytyDla('DPD_EMPIK')).toEqual(['DPD'])
    expect(gabarytyDla('INPOST_KURIER')).toEqual(['INPOST_KURIER'])
    expect(gabarytyDla(null)).toHaveLength(7)
  })

  it('podpowiedź z liczby rzeczy: do 3 A, do 8 B, więcej C; waga co 250 g', () => {
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 2, jednostka: 'szt' }])).toBe('INPOST_A')
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 2, jednostka: 'szt' }, { ilosc: 500, jednostka: 'g' }])).toBe('INPOST_B')
    expect(podpowiedzGabarytu('ALLEGRO', [{ ilosc: 12, jednostka: 'szt' }])).toBe('ALLEGRO_C')
    expect(podpowiedzGabarytu('DPD', [{ ilosc: 12, jednostka: 'szt' }])).toBe('DPD')
  })

  it('podpowiedź z wymiarów produktów, gdy każda pozycja je ma', () => {
    const kubek = [10, 10, 12] as const
    // 2 kubki 10×10×12 nie mieszczą się w A (wysokość skrytki 8 cm), w B tak
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 2, jednostka: 'szt', wymiaryCm: kubek }])).toBe('INPOST_B')
    // płaska koperta 30×20×2: A, nawet 5 sztuk (liczba rzeczy dałaby B)
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 5, jednostka: 'szt', wymiaryCm: [30, 20, 2] }])).toBe('INPOST_A')
    // objętość ponad 80% skrytki B → C
    expect(podpowiedzGabarytu('ALLEGRO', [{ ilosc: 12, jednostka: 'szt', wymiaryCm: [15, 15, 15] }])).toBe('ALLEGRO_C')
    // Orlen: S/M/L
    expect(podpowiedzGabarytu('ORLEN_PACZKA', [{ ilosc: 1, jednostka: 'szt', wymiaryCm: [30, 20, 2] }])).toBe('ORLEN_S')
    // jedna pozycja bez wymiarów (albo na wagę) = stara podpowiedź z liczby rzeczy
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 5, jednostka: 'szt', wymiaryCm: [30, 20, 2] }, { ilosc: 1, jednostka: 'szt' }])).toBe('INPOST_B')
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 100, jednostka: 'g', wymiaryCm: [5, 5, 5] }])).toBe('INPOST_A')
    // pozycje jeszcze niezebrane (0 szt.) nie liczą się
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 1, jednostka: 'szt', wymiaryCm: [30, 20, 2] }, { ilosc: 0, jednostka: 'szt' }])).toBe('INPOST_A')
  })
  it('kilka sztuk musi się dać ułożyć (stos albo ≤ 50% objętości), z zapasem 1 cm na karton', () => {
    // przykład z przeglądu: 2 szt. 6×25×40 nie leżą ani obok siebie, ani na sobie w A (8×38×64) → B
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 2, jednostka: 'szt', wymiaryCm: [6, 25, 40] }])).toBe('INPOST_B')
    // ta sama sztuka pojedynczo: A
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 1, jednostka: 'szt', wymiaryCm: [6, 25, 40] }])).toBe('INPOST_A')
    // stos 3 × 2 cm + karton ≤ 8 cm: A mimo objętości ponad 50%
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 3, jednostka: 'szt', wymiaryCm: [2, 36, 60] }])).toBe('INPOST_A')
    // sztuka grubości 8 cm = wysokość skrytki A, z kartonem się nie mieści → B
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 1, jednostka: 'szt', wymiaryCm: [8, 30, 50] }])).toBe('INPOST_B')
  })

  it('sztuka większa niż największa skrytka = brak podpowiedzi i ostrzeżenie, nie C', () => {
    const o = ocenaGabarytu('PACZKOMATY', [{ ilosc: 1, jednostka: 'szt', wymiaryCm: [70, 20, 10] }])
    expect(o.gabaryt).toBeNull()
    expect(o.ostrzezenie).toMatch(/nie mieści się w największej skrytce/)
    expect(o.ostrzezenie).toContain('10 × 20 × 70')
    expect(podpowiedzGabarytu('ORLEN_PACZKA', [{ ilosc: 1, jednostka: 'szt', wymiaryCm: [62, 10, 10] }])).toBeNull()
    // kurier (jeden gabaryt) bez zmian
    expect(ocenaGabarytu('DPD', [{ ilosc: 1, jednostka: 'szt', wymiaryCm: [70, 20, 10] }])).toEqual({ gabaryt: 'DPD', ostrzezenie: null })
    // każda sztuka się mieści, razem za dużo: C jak dotąd, bez ostrzeżenia
    expect(ocenaGabarytu('PACZKOMATY', [{ ilosc: 30, jednostka: 'szt', wymiaryCm: [15, 15, 15] }])).toEqual({ gabaryt: 'INPOST_C', ostrzezenie: null })
    // bez wymiarów: stara ścieżka z liczby rzeczy
    expect(ocenaGabarytu('PACZKOMATY', [{ ilosc: 12, jednostka: 'szt' }])).toEqual({ gabaryt: 'INPOST_C', ostrzezenie: null })
  })
})
