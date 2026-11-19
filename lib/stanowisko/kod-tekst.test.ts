// kandydaci kodu z czytnika i wklejonego tekstu (dane zmyślone).
import { describe, expect, it } from 'vitest'
import { bezOtoczki, kandydaciKodu, krotkiGolyNumer, trybWklejenia } from './kod-tekst'

describe('bezOtoczki: numer z maila i tytułu przelewu', () => {
  it.each([
    ['#48213', '48213'],
    ['Zamówienie nr 48213', '48213'],
    ['zamówienie nr #SD 48213.', 'SD 48213'],
    ['Nr. 48213', '48213'],
    ['nr48213', '48213'],
    ['  48213. ', '48213'],
    ['Zamowienie: 48213', '48213'],
    ['SD48213/1', 'SD48213/1'],
    [']C1SD48213/1', 'SD48213/1'],
  ])('%s → %s', (wej, wyj) => expect(bezOtoczki(wej)).toBe(wyj))
})

describe('kandydaciKodu: tryb kod', () => {
  it('kod karty rozstrzyga od razu (bez numerów i przesyłek)', () => {
    const k = kandydaciKodu('SD48213-2/3', 'kod')
    expect(k.karta).toMatchObject({ kodZamowienia: 'SD48213-2', numerWydruku: 3 })
    expect(k.numery).toEqual([])
    expect(k.przesylki).toEqual([])
  })
  it('kod koszyka', () => {
    expect(kandydaciKodu('kosz-b', 'kod').koszyk).toBe('B')
  })
  it('numer z przedrostkiem konta i bez, dosyłka, polskie litery przedrostka', () => {
    expect(kandydaciKodu('SD 48213', 'kod').numery).toEqual([{ przedrostek: 'SD', numer: '48213' }])
    expect(kandydaciKodu('48213', 'kod').numery).toEqual([{ przedrostek: null, numer: '48213' }])
    expect(kandydaciKodu('SD 48213-2', 'kod').numery).toEqual([{ przedrostek: 'SD', numer: '48213-2' }])
    expect(kandydaciKodu('RĘ 1200', 'kod').numery).toEqual([{ przedrostek: 'RE', numer: '1200' }])
    expect(kandydaciKodu('Zamówienie nr #48213.', 'kod').numery).toEqual([{ przedrostek: null, numer: '48213' }])
  })
  it('identyfikator Allegro (UUID) dokładnie, małymi literami', () => {
    const k = kandydaciKodu('A1B2C3D4-0000-4000-8000-00000000AB12', 'kod')
    expect(k.numery.map((n) => n.numer)).toContain('a1b2c3d4-0000-4000-8000-00000000ab12')
  })
  it('numer nadania InPost (24 cyfry) dokładnie, a fragmenty dla kodu z dodatkami', () => {
    const k = kandydaciKodu('602000000000000000000017', 'kod')
    expect(k.przesylki).toEqual(['602000000000000000000017'])
    expect(k.fragmentyPrzesylki.length).toBeGreaterThan(0)
    expect(k.fragmentyPrzesylki.every((f) => f.length >= 10 && f.length < 24)).toBe(true)
  })
  it('kod z etykiety z dodatkami: numer listu jest wśród fragmentów', () => {
    const k = kandydaciKodu('%0061000' + '1000000000017U' + '101616', 'kod')
    expect(k.fragmentyPrzesylki).toContain('1000000000017U')
  })
  it('adres śledzenia z kodu QR: numer jako ciąg dokładnie', () => {
    const k = kandydaciKodu('https://example.test/sledzenie?numer=602000000000000000000017', 'kod')
    expect(k.przesylki).toContain('602000000000000000000017')
  })
  it('śmieci i za długi tekst = brak kandydatów', () => {
    expect(kandydaciKodu('', 'kod')).toMatchObject({ karta: null, koszyk: null, numery: [], przesylki: [] })
    expect(kandydaciKodu('x'.repeat(3000), 'kod').numery).toEqual([])
    expect(kandydaciKodu(42 as unknown as string, 'kod').numery).toEqual([])
  })
})

describe('kandydaciKodu: tryb tekst (tytuł przelewu, fragment maila)', () => {
  it('numer z tytułu przelewu bez kwoty i daty', () => {
    const k = kandydaciKodu('Zapłata za zamówienie nr 48213, kwota 120,50 zł, 16.11.2026', 'tekst')
    expect(k.numery).toEqual([{ przedrostek: null, numer: '48213' }])
  })
  it('przedrostek liczy się tylko wielkimi literami', () => {
    expect(kandydaciKodu('Przelew SD 48213 od klienta', 'tekst').numery).toEqual([{ przedrostek: 'SD', numer: '48213' }])
    expect(kandydaciKodu('dla zamówienia 48213', 'tekst').numery).toEqual([{ przedrostek: null, numer: '48213' }])
  })
  it('kwota 12345,00 nie jest numerem', () => {
    expect(kandydaciKodu('kwota 12345,00 zł', 'tekst').numery).toEqual([])
  })
  it('kod karty i numer nadania w treści', () => {
    const k = kandydaciKodu('Paczka 602000000000000000000017 do karty SD48213/2', 'tekst')
    expect(k.karta?.kodZamowienia).toBe('SD48213')
    expect(k.przesylki).toContain('602000000000000000000017')
    expect(k.fragmentyPrzesylki).toEqual([])
  })
})

describe('trybWklejenia', () => {
  it('krótki numer = kod, cały tytuł przelewu = tekst', () => {
    expect(trybWklejenia('#48213')).toBe('kod')
    expect(trybWklejenia('Zamówienie nr SD 48213.')).toBe('kod')
    expect(trybWklejenia('Zapłata za zamówienie 48213 z dnia 16.11.2026')).toBe('tekst')
  })
})

describe('przedrostek konta „NR” i „NO” to nie słowo „nr”', () => {
  it('karta sklepu z przedrostkiem NR albo NO', () => {
    expect(kandydaciKodu('NR48213/1', 'kod').karta).toMatchObject({ kodZamowienia: 'NR48213', numerWydruku: 1 })
    expect(kandydaciKodu('NO48213/1', 'kod').karta).toMatchObject({ kodZamowienia: 'NO48213', numerWydruku: 1 })
    expect(kandydaciKodu(']C1NR48213-2/3\r\n', 'kod').karta).toMatchObject({ kodZamowienia: 'NR48213-2', numerWydruku: 3 })
  })
  it('otoczka przed kodem karty dalej zdejmowana', () => {
    expect(kandydaciKodu('nr SD48213/1', 'kod').karta).toMatchObject({ kodZamowienia: 'SD48213', numerWydruku: 1 })
    expect(kandydaciKodu('Zamówienie: SD48213/1', 'kod').karta).toMatchObject({ kodZamowienia: 'SD48213', numerWydruku: 1 })
    expect(kandydaciKodu('NR 48213 / 1', 'kod').karta).toMatchObject({ kodZamowienia: 'NR48213', numerWydruku: 1 })
  })
  it('„nr 48213” dalej działa jako numer zamówienia', () => {
    expect(kandydaciKodu('nr 48213', 'kod').numery).toEqual([{ przedrostek: null, numer: '48213' }])
    expect(kandydaciKodu('Nr. 48213', 'kod').numery).toEqual([{ przedrostek: null, numer: '48213' }])
  })
})

describe('w dłuższym tekście tylko numer z kontekstem', () => {
  it('„Faktura 45210, zamówienie 990017, Kowalski”: kandydatem jest tylko 990017', () => {
    expect(kandydaciKodu('Faktura 45210, zamówienie 990017, Kowalski', 'tekst').numery).toEqual([{ przedrostek: null, numer: '990017' }])
  })
  it('gołe liczby z treści nie są kandydatami', () => {
    expect(kandydaciKodu('Przelew od Jana 45210 dziękuję', 'tekst').numery).toEqual([])
    expect(kandydaciKodu('Faktura 45210 z dnia 16.11.2026', 'tekst').numery).toEqual([])
  })
  it('kontekst: przedrostek konta, „zam.”, „nr”, „numer”, „#”', () => {
    const numery = (t: string) => kandydaciKodu(t, 'tekst').numery
    expect(numery('Wpłata za SD 48213 od klienta')).toEqual([{ przedrostek: 'SD', numer: '48213' }])
    expect(numery('Wpłata za zam. 48213 od klienta')).toEqual([{ przedrostek: null, numer: '48213' }])
    expect(numery('Wpłata, nr: 48213, od klienta')).toEqual([{ przedrostek: null, numer: '48213' }])
    expect(numery('Wpłata za numer 48213 od klienta')).toEqual([{ przedrostek: null, numer: '48213' }])
    expect(numery('Wpłata za #48213 od klienta')).toEqual([{ przedrostek: null, numer: '48213' }])
    expect(numery('Zamówienie nr #48213 opłacone przelewem')).toEqual([{ przedrostek: null, numer: '48213' }])
  })
  it('„NR 48213” w tekście to słowo, nie przedrostek konta', () => {
    expect(kandydaciKodu('Zapłata NR 48213 przelewem', 'tekst').numery).toEqual([{ przedrostek: null, numer: '48213' }])
  })
  it('sam numer z otoczką wklejony osobno idzie trybem kodu', () => {
    expect(trybWklejenia('45210')).toBe('kod')
    expect(trybWklejenia('nr 45210')).toBe('kod')
    expect(kandydaciKodu('45210', trybWklejenia('45210')).numery).toEqual([{ przedrostek: null, numer: '45210' }])
  })
})

describe('krótki goły numer w „Szukaj” filtruje', () => {
  it.each([
    ['12', true],
    ['1234', true],
    ['nr 1234', true],
    ['#12-2', true],
    ['12345', false],
    ['SD 1234', false],
    ['SD48213/1', false],
    ['Produkt', false],
  ])('%s → %s', (f, wyj) => expect(krotkiGolyNumer(f)).toBe(wyj))
})
