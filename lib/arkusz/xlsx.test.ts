// zapis XLSX — polskie znaki, liczby jako liczby (nie tekst), tekst nigdy jako formuła, nazwy arkuszy, ZIP.
import { describe, expect, it } from 'vitest'
import { crc32, dataSeryjna, kolumnaLitera, nazwaArkusza, STYL, zapiszXlsx } from './xlsx'
import { odczytajXlsx, rozpakujZip } from './xlsx-odczyt'

describe('zapiszXlsx', () => {
  it('polskie znaki, kwoty i ilości jako liczby, puste komórki, nagłówek pogrubiony', () => {
    const plik = zapiszXlsx([
      {
        nazwa: 'Produkty',
        kolumny: [
          { naglowek: 'Nazwa', typ: 'tekst' },
          { naglowek: 'Ilość', typ: 'calkowita' },
          { naglowek: 'Przychód brutto', typ: 'kwota' },
          { naglowek: 'Marża %', typ: 'procent' },
        ],
        wiersze: [
          ['Zażółć gęślą jaźń — przyprawa „Łąka”', 12, 1863.5, 32.5],
          ['Bez ceny zakupu', 3, 0.1, null],
        ],
      },
      { nazwa: 'Okresy', kolumny: [{ naglowek: 'Okres', typ: 'tekst' }], wiersze: [] },
    ])
    expect(plik.subarray(0, 2).toString('latin1')).toBe('PK')
    const a = odczytajXlsx(plik)
    expect([...a.keys()]).toEqual(['Produkty', 'Okresy'])
    const w = a.get('Produkty')!
    expect(w[0]!.map((c) => c?.wartosc)).toEqual(['Nazwa', 'Ilość', 'Przychód brutto', 'Marża %'])
    expect(w[0]![0]!.styl).toBe(1)
    expect(w[1]![0]).toEqual({ typ: 'tekst', wartosc: 'Zażółć gęślą jaźń — przyprawa „Łąka”', styl: 0 })
    expect(w[1]![1]).toEqual({ typ: 'liczba', wartosc: 12, styl: 4 })
    expect(w[1]![2]).toEqual({ typ: 'liczba', wartosc: 1863.5, styl: 2 })
    // procent natywny Excela: 32,5 % zapisane jako ułamek
    expect(w[1]![3]).toEqual({ typ: 'liczba', wartosc: 0.325, styl: 5 })
    expect(w[2]![3]).toBeUndefined()
    expect(a.get('Okresy')!.length).toBe(1)
  })

  it('format liczby per typ: bez wiszącego przecinka i bez utraty groszy', () => {
    const plik = zapiszXlsx([
      {
        nazwa: 'P',
        kolumny: [
          { naglowek: 'Miara', typ: 'tekst' },
          { naglowek: 'Wartość', typ: 'liczba' },
        ],
        wiersze: [
          ['Zamówienia', { v: 119, typ: 'calkowita' }],
          ['Wartość', { v: 729.9, typ: 'kwota' }],
          ['Marża %', { v: 54.2, typ: 'procent' }],
          ['Waga', { v: 5.1, typ: 'kg' }],
          ['Bez typu', 53],
          ['Puste', { v: null, typ: 'kwota' }],
        ],
      },
    ])
    const pliki = rozpakujZip(plik)
    const styles = pliki.get('xl/styles.xml')!.toString('utf8')
    // kod formatu każdego stylu z cellXfs (numFmtId → formatCode)
    const fmt = new Map([...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\/>/g)].map((m) => [Number(m[1]), m[2]!]))
    const xfs = [...styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)![1]!.matchAll(/numFmtId="(\d+)"/g)].map((m) => Number(m[1]))
    const kod = (styl: number) => (xfs[styl]! < 164 ? `wbudowany ${xfs[styl]}` : fmt.get(xfs[styl]!))
    expect(kod(STYL.calkowita)).toBe('wbudowany 3') // #,##0
    expect(kod(STYL.kwota)).toBe('#,##0.00')
    expect(kod(STYL.kg)).toBe('#,##0.000')
    expect(kod(STYL.procent)).toBe('0.0%')
    expect(kod(STYL.liczba)).toBe('wbudowany 0') // Ogólny
    for (const f of fmt.values()) expect(f).not.toMatch(/#\.#|0\.#/) // żadnych opcjonalnych miejsc po przecinku
    const w = odczytajXlsx(plik).get('P')!
    expect(w.slice(1).map((r) => r[1] && [r[1].wartosc, r[1].styl])).toEqual([
      [119, STYL.calkowita],
      [729.9, STYL.kwota],
      [0.542, STYL.procent],
      [5.1, STYL.kg],
      [53, STYL.liczba],
      undefined,
    ])
  })

  it('tekst z „=” zostaje tekstem (bez formuł), znaki sterujące wycięte, XML ucieczki', () => {
    const plik = zapiszXlsx([{ nazwa: 'A', kolumny: [{ naglowek: 'x', typ: 'tekst' }], wiersze: [['=HYPERLINK("http://zly")'], ['a\u0001b<&>"c']] }])
    const sheet = rozpakujZip(plik).get('xl/worksheets/sheet1.xml')!.toString('utf8')
    expect(sheet).not.toContain('<f>')
    const w = odczytajXlsx(plik).get('A')!
    expect(w[1]![0]!.wartosc).toBe('=HYPERLINK("http://zly")')
    expect(w[2]![0]!.wartosc).toBe('ab<&>"c')
  })

  it('data jako liczba seryjna w czasie polskim', () => {
    // 2026-11-09 00:30 w Warszawie = 2026-11-08 23:30 UTC
    expect(dataSeryjna(new Date('2026-11-08T23:30:00Z'))).toBeCloseTo(46335 + 0.5 / 24, 8)
    const w = odczytajXlsx(zapiszXlsx([{ nazwa: 'D', kolumny: [{ naglowek: 'kiedy', typ: 'data' }], wiersze: [[new Date('2026-11-08T23:30:00Z')]] }])).get('D')!
    expect(w[1]![0]).toMatchObject({ typ: 'liczba', styl: 6 })
  })

  it('nazwy arkuszy i kolumn, CRC-32', () => {
    const z = new Set<string>()
    expect(nazwaArkusza('Sprzedaż [wg] kanału: 2026/11', z)).toBe('Sprzedaż  wg  kanału  2026 11')
    expect(nazwaArkusza('Sprzedaż  wg  kanału  2026 11', z)).toBe('Sprzedaż  wg  kanału  2026 11 2')
    expect(nazwaArkusza('', z)).toBe('Arkusz')
    expect(nazwaArkusza('x'.repeat(40), z)).toHaveLength(31)
    expect(['A', 'Z', 'AA', 'AZ', 'BA'].map((_, i) => kolumnaLitera([0, 25, 26, 51, 52][i]!))).toEqual(['A', 'Z', 'AA', 'AZ', 'BA'])
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('bez arkuszy = błąd', () => {
    expect(() => zapiszXlsx([])).toThrow()
  })
})
