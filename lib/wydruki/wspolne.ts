// Wspólne elementy wydruków: dokument PDF z fontem z polskimi znakami, formatowanie, sortowanie
// lokalizacji, kod kreskowy Code 128 (rysowany wektorowo — ostry na laserowym Brotherze).
import fs from 'node:fs'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import bwipjs from 'bwip-js/node'
import type { Jednostka, NumerZamowienia, OdbiorcaSkrot } from './typy'

export type Dokument = PDFKit.PDFDocument

export const MM = 72 / 25.4
export const A4 = { szerokosc: 595.28, wysokosc: 841.89 }
export const MARGINES = 28 // ok. 10 mm — bezpieczny margines druku Brothera

// (26.10.2026): stopka podniesiona — linia bazowa 8 pt Noto Sans ok. 6,9 mm od dolnej krawędzi
// (wcześniej 4 mm, w strefie niedrukowalnej Brothera ok. 4,2 mm). Tekst stopki od GORA_TEKSTU_STOPKI,
// linia nad nim na LINIA_STOPKI, treść stron (wiersze tabel) kończy się najpóźniej na DOL_TRESCI.
export const GORA_TEKSTU_STOPKI = A4.wysokosc - MARGINES
export const LINIA_STOPKI = GORA_TEKSTU_STOPKI - 4
export const DOL_TRESCI = LINIA_STOPKI - 4

export const FONT = 'zwykly'
export const FONT_B = 'pogrubiony'

// 2026-10-25: Noto Sans (OFL 1.1) przycięty pyftsubset do łaciny + Latin-1 + Latin Extended-A
// (polskie znaki, ok. 73 KB zamiast 620 KB). Ścieżka od process.cwd(), bo moduł działa w vitest, tsx
// i w Next (standalone: katalog dołączany przez outputFileTracingIncludes w next.config.ts).
// (26.10.2026): katalog można nadpisać zmienną WYDRUKI_FONTY (worker/skrypt z innego katalogu roboczego).
let fonty: { zwykly: Buffer; pogrubiony: Buffer } | null = null

function wczytajFonty() {
  if (fonty) return fonty
  const katalog = process.env.WYDRUKI_FONTY?.trim() || path.join(/*turbopackIgnore: true*/ process.cwd(), 'lib', 'wydruki', 'fonty')
  const czytaj = (plik: string) => {
    // turbopackIgnore: fonty dołącza outputFileTracingIncludes (next.config.ts); bez tego build śledzi całe repo
    const sciezka = path.join(/*turbopackIgnore: true*/ katalog, plik)
    try {
      return fs.readFileSync(/*turbopackIgnore: true*/ sciezka)
    } catch (e) {
      throw new Error(`Brak fontu wydruków w ${sciezka} (ustaw WYDRUKI_FONTY albo uruchom z katalogu repo)`, {
        cause: e,
      })
    }
  }
  fonty = { zwykly: czytaj('NotoSans-Regular.ttf'), pogrubiony: czytaj('NotoSans-Bold.ttf') }
  return fonty
}

export interface OpcjeDokumentu {
  tytul: string
  /** Rozmiar strony w pt; domyślnie A4 pionowo. */
  rozmiar?: [number, number]
  /**
   * Data utworzenia w metadanych PDF (zwykle chwila wydruku). (26.10.2026): pdfkit liczy z niej też ID
   * pliku, więc te same dane dają te same bajty (przykłady w repo nie zmieniają się przy każdym przebiegu).
   * Brak = teraz.
   */
  utworzono?: Date
}

// --- znaki bez glifu ------------------------------------------------------------------------------

// (26.10.2026): subset Noto Sans ma łacinę z polskimi znakami, ale nie emoji, ™, strzałek, ≥ itd.
// Brak glifu dawał „tofu” na wydruku i U+0000 w warstwie tekstu. Przed rysowaniem i pomiarem: zamiana
// na odpowiednik z ZAMIENNIKI, potem rozkład NFKD (ș → s), a reszta znika. Białe znaki zostają.
const ZAMIENNIKI: Record<string, string> = {
  '™': '(TM)',
  '→': '->',
  '←': '<-',
  '⇒': '=>',
  '≥': '>=',
  '≤': '<=',
  '≠': '!=',
  '✓': 'v',
  '✔': 'v',
  '•': '·',
}

interface FontZGlifami {
  hasGlyphForCodePoint(kod: number): boolean
}

/** Font fontkit aktualnie ustawiony w dokumencie (pole wewnętrzne pdfkit); null, gdy niedostępny. */
function biezacyFont(doc: Dokument): FontZGlifami | null {
  const f = (doc as unknown as { _font?: { font?: Partial<FontZGlifami> } })._font?.font
  return typeof f?.hasGlyphForCodePoint === 'function' ? (f as FontZGlifami) : null
}

/** Tekst bez znaków, których font nie ma (zamienniki → NFKD → usunięcie). */
export function bezBrakujacychGlifow(font: FontZGlifami | null, tekst: string): string {
  if (!font) return tekst
  const ma = (z: string) => /\s/.test(z) || font.hasGlyphForCodePoint(z.codePointAt(0)!)
  let wynik = ''
  for (const z of tekst) {
    if (ma(z)) {
      wynik += z
      continue
    }
    const zam = ZAMIENNIKI[z]
    if (zam && [...zam].every(ma)) {
      wynik += zam
      continue
    }
    let rozklad = ''
    for (const c of z.normalize('NFKD')) if (c !== z && ma(c) && !/\p{M}/u.test(c)) rozklad += c
    // W-D2 (26.10.2026, drugi przegląd): cyrylica/greka/CJK znikały bez śladu, a magazyn nie
    // wiedział, że uwagi miały treść. Ciąg znaków bez glifu i bez zamiennika → jeden „?”.
    if (rozklad) wynik += rozklad
    else if (!wynik.endsWith('?')) wynik += '?'
  }
  return wynik
}

/**
 * Podpina oczyszczanie tekstu pod text/widthOfString/heightOfString dokumentu — jedno miejsce zamiast
 * pamiętania o tym przy każdym wywołaniu w szablonach.
 */
function oczyszczajTekst(doc: Dokument): void {
  type Metoda = (tekst: unknown, ...reszta: unknown[]) => unknown
  const d = doc as unknown as Record<'text' | 'widthOfString' | 'heightOfString', Metoda>
  for (const nazwa of ['text', 'widthOfString', 'heightOfString'] as const) {
    const oryginal = d[nazwa].bind(doc)
    d[nazwa] = (tekst, ...reszta) =>
      oryginal(typeof tekst === 'string' ? bezBrakujacychGlifow(biezacyFont(doc), tekst) : tekst, ...reszta)
  }
}

/**
 * Nowy dokument z marginesami 0 (pozycje liczymy sami, pdfkit nie dokłada stron sam z siebie)
 * i buforowanymi stronami (stopka „strona N/M” dopisywana na końcu).
 */
export function nowyDokument(opcje: OpcjeDokumentu): Dokument {
  const f = wczytajFonty()
  const doc = new PDFDocument({
    size: opcje.rozmiar ?? [A4.szerokosc, A4.wysokosc],
    margin: 0,
    bufferPages: true,
    autoFirstPage: true,
    // Domyślny font jako bufor: pdfkit nie czyta wtedy Helvetica.afm z dysku.
    font: f.zwykly as unknown as string,
    info: {
      Title: opcje.tytul,
      Creator: 'Kompletor',
      Producer: 'Kompletor (pdfkit)',
      CreationDate: opcje.utworzono ?? new Date(),
    },
    lang: 'pl-PL',
  } as PDFKit.PDFDocumentOptions)
  doc.registerFont(FONT, f.zwykly)
  doc.registerFont(FONT_B, f.pogrubiony)
  doc.font(FONT)
  oczyszczajTekst(doc)
  return doc
}

export function doBufora(doc: Dokument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const czesci: Buffer[] = []
    doc.on('data', (c: Buffer) => czesci.push(c))
    doc.on('end', () => resolve(Buffer.concat(czesci)))
    doc.on('error', reject)
    doc.end()
  })
}

// --- formatowanie ---------------------------------------------------------------------------------

const TZ = 'Europe/Warsaw'

function czesciDaty(d: Date): Record<string, string> {
  const wynik: Record<string, string> = {}
  for (const c of new Intl.DateTimeFormat('pl-PL', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)) {
    wynik[c.type] = c.value
  }
  return wynik
}

/** dd.mm.rrrr w strefie Europe/Warsaw. */
export function formatData(d: Date): string {
  const c = czesciDaty(d)
  return `${c.day}.${c.month}.${c.year}`
}

/** dd.mm.rrrr gg:mm w strefie Europe/Warsaw. */
export function formatDataGodzina(d: Date): string {
  const c = czesciDaty(d)
  return `${c.day}.${c.month}.${c.year} ${c.hour}:${c.minute}`
}

/** gg:mm w strefie Europe/Warsaw. */
export function formatGodzina(d: Date): string {
  const c = czesciDaty(d)
  return `${c.hour}:${c.minute}`
}

const liczba = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 3 })

/** „2 szt.”, „250 g”. */
export function formatIlosc(ilosc: number, jednostka: Jednostka): string {
  return `${liczba.format(ilosc)} ${jednostka === 'szt' ? 'szt.' : 'g'}`
}

/** Numer do wyświetlenia: „SD 48213”, dosyłka „SD 48213-2”. */
export function numerZamowieniaTekst(z: NumerZamowienia): string {
  return `${z.przedrostek} ${z.numer}${z.podzamowienie ? `-${z.podzamowienie}` : ''}`
}

export function odbiorcaTekst(o: OdbiorcaSkrot | null | undefined): string {
  // zamówienie w cieniu nie trzyma danych osobowych — karta mówi to wprost zamiast pustego pola
  if (!o) return 'brak danych odbiorcy w zamówieniu'
  // puste pola dają „—”, nie samotny przecinek
  const kto = [o.imie, o.nazwisko].map((x) => x.trim()).filter(Boolean).join(' ')
  return [kto, o.miasto.trim()].filter(Boolean).join(', ') || '—'
}

// --- kod karty zamówienia -------------------------------------------------------------------------

const WZOR_KODU = /^([A-Z]+)(\d+)(?:-(\d+))?\/(\d+)$/

/**
 * Treść kodu kreskowego karty: numerZamówienia/numerWydruku, bez spacji, np. SD48213/1;
 * dosyłka: SD48213-2/1. Stanowisko pakowania przyjmuje tylko najnowszy numer wydruku.
 */
export function kodKarty(z: NumerZamowienia, numerWydruku: number): string {
  if (!Number.isInteger(numerWydruku) || numerWydruku < 1) {
    throw new Error(`Numer wydruku musi być liczbą całkowitą ≥ 1, jest ${numerWydruku}`)
  }
  // (26.10.2026): przedrostek i numer sprawdzane osobno. Sklejony tekst nie wystarcza: przedrostek „E1”
  // z numerem 5 dawał E15/1, czytany potem jako E + 15, czyli cudze zamówienie bez błędu na stanowisku.
  const przedrostek = z.przedrostek.toUpperCase()
  if (!/^[A-Z]+$/.test(przedrostek)) throw new Error(`Przedrostek kanału musi mieć same litery A–Z, jest „${z.przedrostek}”`)
  if (!/^\d+$/.test(z.numer)) throw new Error(`Numer zamówienia do kodu musi mieć same cyfry, jest „${z.numer}”`)
  if (z.podzamowienie != null && (!Number.isInteger(z.podzamowienie) || z.podzamowienie < 1)) {
    throw new Error(`Numer podzamówienia musi być liczbą całkowitą ≥ 1, jest ${z.podzamowienie}`)
  }
  const tekst = `${przedrostek}${z.numer}${z.podzamowienie ? `-${z.podzamowienie}` : ''}/${numerWydruku}`
  if (!WZOR_KODU.test(tekst)) throw new Error(`Nieprawidłowy numer zamówienia do kodu: ${tekst}`)
  return tekst
}

/** Odczyt zeskanowanego kodu karty; null, gdy to nie jest kod karty. */
export function odczytajKodKarty(
  tekst: string,
): { zamowienie: NumerZamowienia; numerWydruku: number } | null {
  // (26.10.2026): skaner z włączonym identyfikatorem AIM dokleja „]C<cyfra>” przed treścią Code 128.
  const m = WZOR_KODU.exec(tekst.trim().replace(/^\]C\d/i, '').toUpperCase())
  if (!m) return null
  const [, przedrostek, numer, pod, wydruk] = m
  return {
    zamowienie: { przedrostek: przedrostek!, numer: numer!, podzamowienie: pod ? Number(pod) : null },
    numerWydruku: Number(wydruk),
  }
}

/**
 * Szerokości Code 128 w modułach, na przemian kreska/przerwa (bwip-js `raw`), bez strefy ciszy. Wspólne
 * dla PDF i ZPL etykiety odbioru, żeby oba pliki miały ten sam kod co karta zamówienia.
 */
export function kreskiKodu128(tekst: string): number[] {
  const [wynik] = bwipjs.raw({ bcid: 'code128', text: tekst }) as unknown as { sbs: number[] }[]
  if (!wynik) throw new Error(`Nie udało się zakodować: ${tekst}`)
  return wynik.sbs
}

/**
 * Code 128 jako prostokąty. bwip-js `raw` zwraca szerokości na przemian kreska/przerwa (w modułach).
 * Strefa ciszy 10 modułów po obu stronach mieści się w podanej szerokości.
 */
export function rysujKod128(
  doc: Dokument,
  tekst: string,
  x: number,
  y: number,
  szerokosc: number,
  wysokosc: number,
): void {
  const sbs = kreskiKodu128(tekst)
  const moduly = sbs.reduce((a, b) => a + b, 0)
  const modul = szerokosc / (moduly + 20)
  let kx = x + 10 * modul
  doc.save().fillColor('black')
  sbs.forEach((w, i) => {
    if (i % 2 === 0) doc.rect(kx, y, w * modul, wysokosc)
    kx += w * modul
  })
  doc.fill().restore()
}

// --- lokalizacje ----------------------------------------------------------------------------------

const porownanieNaturalne = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' })

/**
 * Porównanie lokalizacji regał-półka-miejsce (B-3-4): naturalnie po członach, więc B-3-10 po B-3-9,
 * a B-10-1 po B-9-1. Brak lokalizacji (null/pusta) zawsze na końcu.
 */
export function porownajLokalizacje(a?: string | null, b?: string | null): number {
  const pa = a?.trim() ?? ''
  const pb = b?.trim() ?? ''
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0
  const ca = pa.split(/[-\s/.]+/)
  const cb = pb.split(/[-\s/.]+/)
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const x = ca[i]
    const y = cb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const r = porownanieNaturalne.compare(x, y)
    if (r !== 0) return r
  }
  return 0
}

/** Stabilne sortowanie po lokalizacji (pozycje o tej samej lokalizacji zostają w kolejności wejścia). */
export function sortujPoLokalizacji<T extends { lokalizacja?: string | null }>(pozycje: readonly T[]): T[] {
  return pozycje
    .map((p, i) => ({ p, i }))
    .sort((a, b) => porownajLokalizacje(a.p.lokalizacja, b.p.lokalizacja) || a.i - b.i)
    .map((x) => x.p)
}

// --- tekst ----------------------------------------------------------------------------------------

/** Wysokość tekstu zawijanego do szerokości w danym foncie i rozmiarze. */
export function wysokoscTekstu(doc: Dokument, tekst: string, font: string, rozmiar: number, szerokosc: number): number {
  return doc.font(font).fontSize(rozmiar).heightOfString(tekst, { width: szerokosc, lineGap: 0 })
}

/** Tekst bez zawijania, ucięty z „…”, gdy się nie mieści. */
export function tekstJednaLinia(
  doc: Dokument,
  tekst: string,
  x: number,
  y: number,
  szerokosc: number,
  opcje: { font?: string; rozmiar?: number; align?: 'left' | 'right' | 'center' } = {},
): void {
  doc.font(opcje.font ?? FONT).fontSize(opcje.rozmiar ?? 10)
  let t = tekst
  if (doc.widthOfString(t) > szerokosc) {
    // (26.10.2026): bisekcja po punktach kodowych zamiast ucinania znak po znaku (tekst 4000 znaków
    // = 4000 pomiarów) i bez rozcinania par zastępczych.
    const znaki = Array.from(tekst)
    let lo = 1
    let hi = znaki.length
    while (lo < hi) {
      const s = Math.ceil((lo + hi) / 2)
      if (doc.widthOfString(`${znaki.slice(0, s).join('')}…`) <= szerokosc) lo = s
      else hi = s - 1
    }
    t = `${znaki.slice(0, lo).join('').trimEnd()}…`
  }
  doc.text(t, x, y, { width: szerokosc, align: opcje.align ?? 'left', lineBreak: false })
}

/**
 * Stopka „strona N/M” i opis na każdej stronie — wywołać po narysowaniu całości. `zakres`: tylko te
 * strony, numerowane od 1 — kilka kart zamówień w jednym PDF, każda ze swoją numeracją.
 */
export function stopki(doc: Dokument, opis: string, zakres: { start: number; count: number } = doc.bufferedPageRange()): void {
  for (let i = zakres.start; i < zakres.start + zakres.count; i++) {
    doc.switchToPage(i)
    const y = doc.page.height - MARGINES // = GORA_TEKSTU_STOPKI dla A4
    const w = doc.page.width - 2 * MARGINES
    doc.save().moveTo(MARGINES, y - 4).lineTo(MARGINES + w, y - 4).lineWidth(0.5).strokeColor('#888').stroke().restore()
    tekstJednaLinia(doc, opis, MARGINES, y, w - 80, { rozmiar: 8 })
    tekstJednaLinia(doc, `strona ${i - zakres.start + 1}/${zakres.count}`, MARGINES + w - 80, y, 80, {
      rozmiar: 8,
      align: 'right',
    })
  }
}
