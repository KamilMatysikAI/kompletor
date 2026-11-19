// Kartka próbna instalatora: przy wyborze drukarek osoba w magazynie wpisuje „P”
// i dostaje kartkę z dużym numerem pozycji z listy i nazwą drukarki z Windows, żeby wiedzieć, która pozycja jest którą
// drukarką. Bez serwera i bez roli (rola jeszcze nieznana): jeden prosty PDF 100×150 mm drukowany przez SumatraPDF
// ze skalowaniem „fit”, więc wychodzi i na A4, i na etykiecie termicznej (przez sterownik, nie ZPL).
// Funkcje są niezależne od konsoli: ten sam wydruk zleca strona ustawień (wariant „strona” zmienia tylko wskazówkę).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Drukarki } from './drukarki.js'

/** Polskie litery spoza WinAnsi → kody 128… przez /Differences (glify są w czcionkach standardowych Helvetica). */
const POLSKIE: [string, string][] = [
  ['ą', 'aogonek'], ['ć', 'cacute'], ['ę', 'eogonek'], ['ł', 'lslash'], ['ń', 'nacute'], ['ś', 'sacute'], ['ź', 'zacute'], ['ż', 'zdotaccent'],
  ['Ą', 'Aogonek'], ['Ć', 'Cacute'], ['Ę', 'Eogonek'], ['Ł', 'Lslash'], ['Ń', 'Nacute'], ['Ś', 'Sacute'], ['Ź', 'Zacute'], ['Ż', 'Zdotaccent'],
  ['ó', 'oacute'], ['Ó', 'Oacute'],
]
const KOD_POLSKI = new Map(POLSKIE.map(([z], i) => [z, 128 + i]))
const ROZNICE = `[128 ${POLSKIE.map(([, g]) => `/${g}`).join(' ')}]`

/** Tekst → bajty łańcucha PDF w kodowaniu czcionki (ASCII + polskie litery; inne znaki jako „?”). */
export function tekstPdf(t: string): string {
  let out = ''
  for (const z of t) {
    const kod = KOD_POLSKI.get(z) ?? z.codePointAt(0)!
    if (KOD_POLSKI.has(z)) out += `\\${kod.toString(8)}`
    else if (z === '(' || z === ')' || z === '\\') out += `\\${z}`
    else if (kod >= 32 && kod < 127) out += z
    else out += '?'
  }
  return out
}

/** Dzieli nazwę na wiersze do `szer` znaków (nazwy drukarek bywają długie). */
export function zawin(t: string, szer: number): string[] {
  const wiersze: string[] = []
  let biezacy = ''
  for (const slowo of t.split(/\s+/).filter(Boolean)) {
    for (let s = slowo; s.length; ) {
      const wolne = biezacy ? szer - biezacy.length - 1 : szer
      if (s.length <= wolne) {
        biezacy = biezacy ? `${biezacy} ${s}` : s
        s = ''
      } else if (biezacy) {
        wiersze.push(biezacy)
        biezacy = ''
      } else {
        wiersze.push(s.slice(0, szer))
        s = s.slice(szer)
      }
    }
  }
  if (biezacy) wiersze.push(biezacy)
  return wiersze.length ? wiersze : ['']
}

const MM = 72 / 25.4
export const SZEROKOSC_PT = Math.round(100 * MM * 100) / 100
export const WYSOKOSC_PT = Math.round(150 * MM * 100) / 100

/** PDF kartki próbnej: jedna strona 100×150 mm, Helvetica, bez zależności. */
export function pdfKartkiProbnej(d: { numer: number; nazwa: string; dla?: 'instalator' | 'strona' }): Buffer {
  const wskazowka =
    d.dla === 'strona'
      ? [
          { rozmiar: 11, tekst: 'Wróć do strony ustawień i przy drukarce', odstep: 30 },
          { rozmiar: 11, tekst: `${d.numer} wybierz, do czego służy: kartki A4`, odstep: 14 },
          { rozmiar: 11, tekst: 'albo etykiety.', odstep: 14 },
        ]
      : [
          { rozmiar: 11, tekst: 'Wróć do okna instalatora i przy pozycji', odstep: 30 },
          { rozmiar: 11, tekst: `${d.numer} wpisz: A = zwykła drukarka (kartki A4)`, odstep: 14 },
          { rozmiar: 11, tekst: 'albo T = termiczna (etykiety).', odstep: 14 },
        ]
  const linie: { rozmiar: number; gruba?: boolean; tekst: string; odstep: number }[] = [
    { rozmiar: 15, gruba: true, tekst: 'Kompletor Druk: kartka próbna', odstep: 0 },
    { rozmiar: 11, tekst: 'Ta drukarka jest na liście pod numerem:', odstep: 26 },
    { rozmiar: 120, gruba: true, tekst: String(d.numer), odstep: 112 },
    { rozmiar: 11, tekst: 'Nazwa drukarki w Windows:', odstep: 34 },
    ...zawin(d.nazwa, 30).map((t, i) => ({ rozmiar: 13, gruba: true, tekst: t, odstep: i === 0 ? 17 : 16 })),
    ...wskazowka,
    { rozmiar: 10, tekst: 'Tę kartkę możesz wyrzucić.', odstep: 26 },
  ]
  let y = WYSOKOSC_PT - 36
  const strumien = linie
    .map((l) => {
      y -= l.odstep
      return `BT /${l.gruba ? 'F2' : 'F1'} ${l.rozmiar} Tf 20 ${y.toFixed(2)} Td (${tekstPdf(l.tekst)}) Tj ET`
    })
    .join('\n')
  const czcionka = (nazwa: string) => `<< /Type /Font /Subtype /Type1 /BaseFont /${nazwa} /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences ${ROZNICE} >> >>`
  const obiekty = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SZEROKOSC_PT} ${WYSOKOSC_PT}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    czcionka('Helvetica'),
    czcionka('Helvetica-Bold'),
    `<< /Length ${Buffer.byteLength(strumien, 'latin1')} >>\nstream\n${strumien}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const przesuniecia: number[] = []
  obiekty.forEach((o, i) => {
    przesuniecia.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${obiekty.length + 1}\n0000000000 65535 f \n`
  for (const p of przesuniecia) pdf += `${String(p).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${obiekty.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/**
 * Drukuje kartkę próbną na wskazanej drukarce Windows (PDF, skalowanie „fit”). Plik tymczasowy znika po druku.
 * Błąd (brak SumatraPDF, drukarka odmówiła) wraca jako wyjątek — wywołujący pokazuje go człowiekowi.
 */
export async function wydrukujKartkeProbna(
  drukarki: Pick<Drukarki, 'drukujPdf'>,
  nazwa: string,
  numer: number,
  dla: 'instalator' | 'strona' = 'instalator',
): Promise<void> {
  const katalog = mkdtempSync(join(tmpdir(), 'kompletor-proba-'))
  try {
    const plik = join(katalog, `kartka-probna-${numer}.pdf`)
    writeFileSync(plik, pdfKartkiProbnej({ numer, nazwa, dla }))
    await drukarki.drukujPdf(nazwa, plik, 1, 'fit')
  } finally {
    rmSync(katalog, { recursive: true, force: true })
  }
}
