// etykieta odbioru osobistego — czyste reguły (kod, płatność, telefon) i oba pliki (PDF, ZPL) z danymi
// fikcyjnymi. Bez bazy.
import { describe, expect, it } from 'vitest'
import { kandydaciKodu } from '@/lib/stanowisko/kod-tekst'
import { kreskiKodu128 } from '@/lib/wydruki/wspolne'
import {
  etykietaOdbioruPdf,
  etykietaOdbioruZpl,
  kodNaEtykiete,
  NAPIS_ODBIORU,
  platnoscNaEtykiecie,
  platnoscTekst,
  telefonNaEtykiete,
  type DaneEtykietyOdbioru,
} from './etykieta-odbioru'

const DANE: DaneEtykietyOdbioru = {
  sklep: 'Sklep Testowy',
  numer: 'ST 48213',
  kod: 'ST48213/2',
  odbiorca: { kto: 'Jan Przykładowy', telefon: '600100200' },
  paczka: { nr: 1, z: 2 },
  platnosc: { stan: 'DO_ZAPLATY', kwotaGr: 12345 },
  spakowano: new Date('2026-11-21T13:05:00Z'),
  wydrukowano: new Date('2026-11-21T13:06:00Z'),
  proba: false,
}

describe('kod na etykiecie', () => {
  it('kod najnowszej karty, a bez karty numer z przedrostkiem; bez numeru brak kodu', () => {
    expect(kodNaEtykiete('ST48213', 3)).toBe('ST48213/3')
    expect(kodNaEtykiete('ST48213-2', 1)).toBe('ST48213-2/1')
    expect(kodNaEtykiete('ST48213', null)).toBe('ST48213')
    expect(kodNaEtykiete(null, 2)).toBeNull()
  })

  it('skan kodu rozpoznaje kartę albo numer zamówienia z przedrostkiem (ta sama droga co karta)', () => {
    expect(kandydaciKodu('ST48213/3', 'kod').karta).toMatchObject({ kodZamowienia: 'ST48213', numerWydruku: 3 })
    expect(kandydaciKodu('ST48213', 'kod').numery).toEqual([{ przedrostek: 'ST', numer: '48213' }])
  })
})

describe('płatność na etykiecie', () => {
  const o = (paymentState: 'PAID' | 'UNPAID' | 'COD' | 'PARTIAL', totalGross = 123.45, flags: unknown = {}) => ({ totalGross, paymentState, flags })
  it('opłacone = OPŁACONE; pobranie i nieopłacone = DO ZAPŁATY z kwotą', () => {
    expect(platnoscNaEtykiecie(o('PAID'), [], false)).toEqual({ stan: 'OPLACONE' })
    expect(platnoscNaEtykiecie(o('COD'), [], false)).toEqual({ stan: 'DO_ZAPLATY', kwotaGr: 12345 })
    expect(platnoscNaEtykiecie(o('UNPAID'), [], false)).toEqual({ stan: 'DO_ZAPLATY', kwotaGr: 12345 })
  })
  it('wpłaty z karty pomniejszają kwotę; dopłata do zera = OPŁACONE', () => {
    expect(platnoscNaEtykiecie(o('UNPAID'), [{ kind: 'WPLATA', amount: 23.45 }], false)).toEqual({ stan: 'DO_ZAPLATY', kwotaGr: 10000 })
    expect(platnoscNaEtykiecie(o('COD'), [{ kind: 'WPLATA', amount: 123.45 }], false)).toEqual({ stan: 'OPLACONE' })
    // opłacone, a potem kwota zamówienia podniesiona na karcie: różnica do dopłaty przy odbiorze
    expect(platnoscNaEtykiecie(o('PAID', 150, { kwotaZaplacona: 123.45 }), [], false)).toEqual({ stan: 'DO_ZAPLATY', kwotaGr: 2655 })
  })
  it('kilka paczek bez pełnej wpłaty: bez kwoty (karta zamówienia), opłacone dalej OPŁACONE', () => {
    expect(platnoscNaEtykiecie(o('COD'), [], true)).toEqual({ stan: 'DO_ZAPLATY_BEZ_KWOTY' })
    expect(platnoscNaEtykiecie(o('PAID'), [], true)).toEqual({ stan: 'OPLACONE' })
  })
  it('tekst dla ludzi', () => {
    expect(platnoscTekst({ stan: 'OPLACONE' })).toBe('OPŁACONE')
    expect(platnoscTekst({ stan: 'DO_ZAPLATY', kwotaGr: 1234567 }).replace(/\s/g, ' ')).toBe('DO ZAPŁATY: 12 345,67 zł')
  })
})

describe('telefon', () => {
  it('grupy cyfr dla numeru polskiego, inny zapis bez zmian', () => {
    expect(telefonNaEtykiete('600100200')).toBe('600 100 200')
    expect(telefonNaEtykiete('+48 600-100-200')).toBe('+48 600 100 200')
    expect(telefonNaEtykiete('+49 30 1234567')).toBe('+49 30 1234567')
    expect(telefonNaEtykiete('  ')).toBeNull()
    expect(telefonNaEtykiete(null)).toBeNull()
  })
})

describe('ZPL 100 × 150 mm', () => {
  const zpl = etykietaOdbioruZpl(DANE).toString('utf8')
  it('nagłówek ^CI28, rozmiar 800 × 1200 punktów, polskie znaki w polach ^FH', () => {
    expect(zpl.startsWith('^XA\n^CI28\n^PW800\n^LL1200\n')).toBe(true)
    expect(zpl).toContain(NAPIS_ODBIORU)
    expect(zpl).toContain('ST 48213')
    expect(zpl).toContain('Sklep Testowy')
    expect(zpl).toContain('Jan Przykładowy')
    expect(zpl).toContain('tel. 600 100 200')
    expect(zpl).toContain('PACZKA 1 z 2')
    expect(zpl).toMatch(/DO ZAPŁATY: 123,45\szł/)
  })
  it('kod kreskowy z kresek tych samych szerokości co karta, moduł w całych punktach, w ramach etykiety', () => {
    const kreski = [...zpl.matchAll(/\^FO(\d+),(\d+)\^GB(\d+),150,\d+\^FS/g)].map((m) => ({ x: Number(m[1]), w: Number(m[3]) }))
    const sbs = kreskiKodu128(DANE.kod).filter((_, i) => i % 2 === 0)
    expect(kreski.length).toBe(sbs.length)
    const modul = kreski[0]!.w / sbs[0]!
    expect(Number.isInteger(modul) && modul >= 2).toBe(true)
    expect(kreski.map((k) => k.w)).toEqual(sbs.map((s) => s * modul))
    // strefa ciszy 10 modułów od krawędzi pola drukowania (marginesy 3 mm = 24 punkty)
    expect(kreski[0]!.x - 24).toBeGreaterThanOrEqual(10 * modul)
    const koniec = kreski.at(-1)!.x + kreski.at(-1)!.w
    expect(800 - 24 - koniec).toBeGreaterThanOrEqual(10 * modul)
  })
  it('bez szarości: tylko ramki i pola tekstu, żadnych grafik ani wypełnień odcieniem', () => {
    expect(zpl).not.toMatch(/\^GF|\^GS|\^XG/)
  })
  it('OPŁACONE w ramce, DO ZAPŁATY na czarnym polu (odwrócony tekst); PRÓBA tylko w podglądzie', () => {
    const op = etykietaOdbioruZpl({ ...DANE, platnosc: { stan: 'OPLACONE' } }).toString('utf8')
    expect(op).toMatch(/\^GB752,120,8\^FS/)
    expect(op).toContain('OPŁACONE')
    expect(zpl).toMatch(/\^GB752,120,120\^FS/)
    expect(zpl).not.toContain('PRÓBA')
    expect(etykietaOdbioruZpl({ ...DANE, proba: true }).toString('utf8')).toContain('PRÓBA')
  })
  it('bez danych odbiorcy i bez numeru do kodu: napis zastępczy, bez kresek', () => {
    const z = etykietaOdbioruZpl({ ...DANE, odbiorca: null, kod: '' }).toString('utf8')
    expect(z).toContain('brak danych odbiorcy')
    expect(z).not.toContain('tel.')
    expect(z).not.toMatch(/\^GB\d+,150,/)
  })
  it('długa nazwa i długi kod mieszczą się w szerokości etykiety', () => {
    const z = etykietaOdbioruZpl({ ...DANE, sklep: 'Bardzo długa nazwa sklepu internetowego z artykułami dla domu', kod: 'ABCD123456789012-12/123', odbiorca: { kto: 'Anna Maria Długonazwiskowska-Przykładowa z Domu Testowego', telefon: null } }).toString('utf8')
    const kreski = [...z.matchAll(/\^FO(\d+),\d+\^GB(\d+),150,\d+\^FS/g)].map((m) => Number(m[1]) + Number(m[2]))
    expect(Math.max(...kreski)).toBeLessThanOrEqual(776)
    expect(z).toContain('…')
  })
})

describe('PDF 100 × 150 mm', () => {
  it('jedna strona w rozmiarze etykiety, ten sam wynik dla tych samych danych', async () => {
    const a = await etykietaOdbioruPdf(DANE)
    const b = await etykietaOdbioruPdf(DANE)
    expect(a.subarray(0, 5).toString()).toBe('%PDF-')
    expect(a.equals(b)).toBe(true)
    const tekst = a.toString('latin1')
    expect(tekst).toMatch(/\/MediaBox \[0 0 283\.46\d* 425\.19\d*\]/)
    expect((tekst.match(/\/Type \/Page\b/g) ?? []).length).toBe(1)
  })
  it('bez danych odbiorcy, bez kodu, opłacone i próba: rysuje się bez błędu', async () => {
    const pdf = await etykietaOdbioruPdf({ ...DANE, odbiorca: null, kod: '', platnosc: { stan: 'OPLACONE' }, proba: true, spakowano: null })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
