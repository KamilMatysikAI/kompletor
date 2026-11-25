// E1: czyste funkcje kategorii (nazwa, ścieżka, slug). Drzewo w bazie (cykl, głębokość przy przenoszeniu,
// filtr gałęzi, idempotencja przypisania, CSV) sprawdza tests/kategorie-a382.integration.test.ts.
import { describe, expect, it } from 'vitest'
import { BEZ_KATEGORII, checkNazwaKategorii, MAX_GLEBOKOSC, NAZWA_KATEGORII_MAX, parsujSciezke, sciezka, SEPARATOR, slugKategorii } from './kategorie'

describe('checkNazwaKategorii', () => {
  it('przycina i składa spacje, przyjmuje polskie znaki', () => {
    expect(checkNazwaKategorii('  Napoje   zimne ')).toEqual({ ok: true, value: 'Napoje zimne' })
    expect(checkNazwaKategorii('Ogród i dom')).toEqual({ ok: true, value: 'Ogród i dom' })
  })
  it('odrzuca pustą, nie-tekst, za długą, z „>”, ze znakiem sterującym i „(brak)”', () => {
    for (const v of ['', '   ', null, undefined, 12, 'a'.repeat(NAZWA_KATEGORII_MAX + 1), 'Napoje > Soki', 'Zła\u0007nazwa', BEZ_KATEGORII, '(BRAK)']) {
      expect(checkNazwaKategorii(v).ok, String(v)).toBe(false)
    }
    expect(checkNazwaKategorii('a'.repeat(NAZWA_KATEGORII_MAX)).ok).toBe(true)
  })
  it('znaki „%” i „_” są dozwolone (filtr gałęzi nie używa LIKE)', () => {
    expect(checkNazwaKategorii('100% bawełna_eko').ok).toBe(true)
  })
})

describe('parsujSciezke', () => {
  it('pusta komórka = null (bez zmian)', () => {
    expect(parsujSciezke('')).toEqual({ ok: true, value: null })
    expect(parsujSciezke('   ')).toEqual({ ok: true, value: null })
  })
  it('dowolne spacje wokół „>”', () => {
    expect(parsujSciezke('Napoje>Soki >  Jabłkowe')).toEqual({ ok: true, value: ['Napoje', 'Soki', 'Jabłkowe'] })
  })
  it('pusty poziom = błąd', () => {
    for (const v of ['> A', 'A >', 'A >> B', 'A > > B']) expect(parsujSciezke(v).ok, v).toBe(false)
  })
  it(`najwyżej ${MAX_GLEBOKOSC} poziomów`, () => {
    const piec = Array.from({ length: MAX_GLEBOKOSC }, (_, i) => `P${i + 1}`)
    expect(parsujSciezke(piec.join(' > ')).ok).toBe(true)
    expect(parsujSciezke([...piec, 'P6'].join(' > ')).ok).toBe(false)
  })
  it('poziom z „(brak)” albo za długą nazwą = błąd', () => {
    expect(parsujSciezke(`A > ${BEZ_KATEGORII}`).ok).toBe(false)
    expect(parsujSciezke(`A > ${'x'.repeat(NAZWA_KATEGORII_MAX + 1)}`).ok).toBe(false)
  })
  it('sciezka() składa z tym samym separatorem, co parsuje', () => {
    const p = parsujSciezke('Słodycze >Ciastka')
    expect(p.ok && p.value && sciezka(p.value)).toBe(`Słodycze${SEPARATOR}Ciastka`)
  })
})

describe('slugKategorii', () => {
  it('bez polskich znaków, małe litery, myślniki', () => {
    expect(slugKategorii('Łóżka Ćwiczebne i Żółte')).toBe('lozka-cwiczebne-i-zolte')
    expect(slugKategorii('  Kubek   50 ml ')).toBe('kubek-50-ml')
  })
  it('najwyżej 60 znaków, bez myślnika na końcu', () => {
    const s = slugKategorii('a'.repeat(59) + ' bcd')
    expect(s.length).toBeLessThanOrEqual(60)
    expect(s.endsWith('-')).toBe(false)
  })
  it('nazwa bez liter i cyfr = „kategoria”', () => {
    expect(slugKategorii('%%%')).toBe('kategoria')
  })
})
