// minimalny zapis arkusza XLSX (Office Open XML) bez zewnętrznej biblioteki: kilka arkuszy, tekst, liczby,
// kwoty, procenty i daty jako liczby z formatem (Excel i LibreOffice liczą na nich od razu), pogrubiony i zamrożony
// nagłówek, szerokości kolumn. Format liczby wynika z typu kolumny albo z typu podanego przy komórce (wiersze
// mieszane, np. Podsumowanie: liczba zamówień, kwota, procent w jednej kolumnie). ZIP składamy sami (deflate z `node:zlib`, CRC-32 z tablicy), więc nie dochodzi żadna
// zależność do sprawdzania licencji (AGPL-3.0) ani `npm audit`.
//
// Bezpieczeństwo: tekst idzie jako `inlineStr` (nigdy jako formuła, więc „=HYPERLINK(…)” w nazwie produktu zostaje
// tekstem), znaki niedozwolone w XML są usuwane, nazwy arkuszy oczyszczane. Czysta funkcja, test w xlsx.test.ts.
import { deflateRawSync } from 'node:zlib'

/**
 * Typ kolumny = format liczby w Excelu:
 * - `calkowita` `#,##0` (sztuki, liczba zamówień; ułamek zaokrągla się tylko w wyświetlaniu),
 * - `kwota` `#,##0.00` (zawsze dwa miejsca, bez utraty groszy),
 * - `kg` `#,##0.000` (waga z dokładnością do grama),
 * - `procent` natywny procent Excela `0.0%`: wartość podajesz w procentach (54,2), w pliku zapisuje się ułamek (0,542),
 *   więc formuła `=B2*C2` liczy poprawnie,
 * - `liczba` format Ogólny (bez wiszącego przecinka przy liczbach całkowitych),
 * - `data` `rrrr-mm-dd gg:mm` w czasie polskim.
 */
export type TypKolumny = 'tekst' | 'liczba' | 'calkowita' | 'kwota' | 'kg' | 'procent' | 'data'

export interface KolumnaArkusza {
  naglowek: string
  typ: TypKolumny
  /** szerokość w znakach (domyślnie z nagłówka i typu) */
  szerokosc?: number
}

/** Komórka; `{ v, typ }` nadpisuje typ kolumny dla tej jednej liczby (wiersze o różnych jednostkach). */
export type KomorkaProsta = string | number | Date | null | undefined
export type Komorka = KomorkaProsta | { v: number | null; typ: TypKolumny }

export interface Arkusz {
  nazwa: string
  kolumny: KolumnaArkusza[]
  wiersze: Komorka[][]
}

// Style (cellXfs): 0 zwykły, 1 nagłówek, 2 kwota, 3 liczba (Ogólny), 4 całkowita, 5 procent, 6 data, 7 kilogramy
export const STYL: Record<TypKolumny, number> = { tekst: 0, kwota: 2, liczba: 3, calkowita: 4, procent: 5, data: 6, kg: 7 }

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.000"/><numFmt numFmtId="166" formatCode="0.0%"/><numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

// eslint-disable-next-line no-control-regex
const ZLE_ZNAKI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

export function xmlTekst(s: string): string {
  return s.replace(ZLE_ZNAKI, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Nazwa arkusza: bez znaków []:*?/\, najwyżej 31 znaków, niepusta, unikalna. */
export function nazwaArkusza(n: string, zajete: Set<string>): string {
  const base = (n.replace(/[[\]:*?/\\]/g, ' ').replace(ZLE_ZNAKI, '').trim() || 'Arkusz').slice(0, 31)
  let out = base
  for (let i = 2; zajete.has(out.toLowerCase()); i++) out = `${base.slice(0, 31 - String(i).length - 1)} ${i}`
  zajete.add(out.toLowerCase())
  return out
}

export function kolumnaLitera(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Data → liczba seryjna Excela (dni od 1899-12-30) w czasie polskim, bez strefy (Excel jej nie zna). */
export function dataSeryjna(d: Date, timeZone = 'Europe/Warsaw'): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  const local = Date.UTC(+p['year']!, +p['month']! - 1, +p['day']!, +p['hour']!, +p['minute']!, +p['second']!)
  return (local - Date.UTC(1899, 11, 30)) / 86_400_000
}

/** Wartość zapisana w pliku: procent jako ułamek (54,2 → 0,542), bez szumu zmiennoprzecinkowego. */
function wartoscLiczby(v: number, typ: TypKolumny): number {
  return typ === 'procent' ? Number((v / 100).toPrecision(12)) : v
}

function komorka(ref: string, k: Komorka, typKolumny: TypKolumny): string {
  let v = k
  let typ = typKolumny
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    typ = v.typ
    v = v.v
  }
  if (v === null || v === undefined || v === '') return ''
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : `<c r="${ref}" s="${STYL.data}"><v>${dataSeryjna(v)}</v></c>`
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ''
    const t = typ === 'tekst' || typ === 'data' ? 'liczba' : typ
    return `<c r="${ref}" s="${STYL[t]}"><v>${wartoscLiczby(v, t)}</v></c>`
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlTekst(v)}</t></is></c>`
}

function arkuszXml(a: Arkusz): string {
  const szer = a.kolumny.map((k) => k.szerokosc ?? Math.max(10, Math.min(50, k.naglowek.length + 2, k.typ === 'tekst' ? 50 : 16)))
  const cols = szer.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')
  const head = `<row r="1">${a.kolumny.map((k, i) => `<c r="${kolumnaLitera(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${xmlTekst(k.naglowek)}</t></is></c>`).join('')}</row>`
  const rows = a.wiersze.map((w, r) => `<row r="${r + 2}">${a.kolumny.map((k, i) => komorka(`${kolumnaLitera(i)}${r + 2}`, w[i], k.typ)).join('')}</row>`).join('')
  const dim = `A1:${kolumnaLitera(Math.max(0, a.kolumny.length - 1))}${a.wiersze.length + 1}`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${head}${rows}</sheetData>${a.wiersze.length ? `<autoFilter ref="${dim}"/>` : ''}</worksheet>`
}

/** Plik XLSX z arkuszy (kolejność = kolejność zakładek). */
export function zapiszXlsx(arkusze: Arkusz[]): Buffer {
  if (!arkusze.length) throw new Error('XLSX bez arkuszy')
  const zajete = new Set<string>()
  const nazwy = arkusze.map((a) => nazwaArkusza(a.nazwa, zajete))
  const pliki: [string, string][] = [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${arkusze.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${nazwy.map((n, i) => `<sheet name="${xmlTekst(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${arkusze.some((a) => a.wiersze.length) ? `<definedNames>${arkusze.map((a, i) => (a.wiersze.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlTekst(nazwy[i]!.replace(/'/g, "''"))}'!$A$1:$${kolumnaLitera(Math.max(0, a.kolumny.length - 1))}$${a.wiersze.length + 1}</definedName>` : '')).join('')}</definedNames>` : ''}</workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${arkusze.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${arkusze.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ['xl/styles.xml', STYLES],
    ...arkusze.map((a, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, arkuszXml(a)]),
  ]
  return zip(pliki.map(([n, t]) => [n, Buffer.from(t, 'utf8')]))
}

// ─── ZIP (deflate, bez szyfrowania, bez ZIP64: arkusz raportu ma najwyżej kilka MB) ──────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zip(pliki: [string, Buffer][]): Buffer {
  const lokalne: Buffer[] = []
  const centralne: Buffer[] = []
  let offset = 0
  const DOS_CZAS = 0 // 00:00:00
  const DOS_DATA = ((2026 - 1980) << 9) | (1 << 5) | 1 // stała data: plik deterministyczny dla tych samych danych
  for (const [nazwa, dane] of pliki) {
    const n = Buffer.from(nazwa, 'utf8')
    const spak = deflateRawSync(dane)
    const crc = crc32(dane)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // nazwy w UTF-8
    lh.writeUInt16LE(8, 8) // deflate
    lh.writeUInt16LE(DOS_CZAS, 10)
    lh.writeUInt16LE(DOS_DATA, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(spak.length, 18)
    lh.writeUInt32LE(dane.length, 22)
    lh.writeUInt16LE(n.length, 26)
    lh.writeUInt16LE(0, 28)
    lokalne.push(lh, n, spak)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt16LE(DOS_CZAS, 12)
    ch.writeUInt16LE(DOS_DATA, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(spak.length, 20)
    ch.writeUInt32LE(dane.length, 24)
    ch.writeUInt16LE(n.length, 28)
    ch.writeUInt32LE(offset, 42)
    centralne.push(ch, n)
    offset += 30 + n.length + spak.length
  }
  const cd = Buffer.concat(centralne)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(pliki.length, 8)
  end.writeUInt16LE(pliki.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...lokalne, cd, end])
}

export const XLSX_TYP = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
