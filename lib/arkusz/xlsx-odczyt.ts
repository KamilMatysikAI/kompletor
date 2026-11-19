// odczyt arkusza XLSX do testów (i do ewentualnego sprawdzenia eksportu): ZIP z katalogu centralnego,
// inflate z `node:zlib`, komórki z XML arkusza z typem (liczba albo tekst). Obsługuje to, co pisze `zapiszXlsx`
// (inlineStr i liczby) oraz łańcuchy współdzielone (sharedStrings) z plików zapisanych ponownie w Excelu/LibreOffice.
import { inflateRawSync } from 'node:zlib'

export function rozpakujZip(b: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('To nie jest plik ZIP')
  const n = b.readUInt16LE(eocd + 10)
  let p = b.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let k = 0; k < n; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('Uszkodzony katalog ZIP')
    const metoda = b.readUInt16LE(p + 10)
    const rozmiar = b.readUInt32LE(p + 20)
    const ln = b.readUInt16LE(p + 28)
    const le = b.readUInt16LE(p + 30)
    const lk = b.readUInt16LE(p + 32)
    const off = b.readUInt32LE(p + 42)
    const nazwa = b.subarray(p + 46, p + 46 + ln).toString('utf8')
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28)
    const dane = b.subarray(start, start + rozmiar)
    out.set(nazwa, metoda === 8 ? inflateRawSync(dane) : Buffer.from(dane))
    p += 46 + ln + le + lk
  }
  return out
}

const odXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

export interface KomorkaOdczytana {
  typ: 'liczba' | 'tekst'
  wartosc: number | string
  styl: number
}

/** Arkusze: nazwa → wiersze (tablica komórek wg kolumny; brak komórki = undefined). */
export function odczytajXlsx(b: Buffer): Map<string, (KomorkaOdczytana | undefined)[][]> {
  const pliki = rozpakujZip(b)
  const wb = pliki.get('xl/workbook.xml')?.toString('utf8')
  if (!wb) throw new Error('Brak xl/workbook.xml')
  const shared = [...(pliki.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => odXml([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))
  const out = new Map<string, (KomorkaOdczytana | undefined)[][]>()
  const nazwy = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => odXml(m[1]!))
  nazwy.forEach((nazwa, i) => {
    const xml = pliki.get(`xl/worksheets/sheet${i + 1}.xml`)?.toString('utf8') ?? ''
    const wiersze: (KomorkaOdczytana | undefined)[][] = []
    for (const r of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const wiersz: (KomorkaOdczytana | undefined)[] = []
      for (const c of r[2]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = c[1]!.split('').reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1
        const attrs = c[2]!
        const body = c[3] ?? ''
        const t = /t="([^"]+)"/.exec(attrs)?.[1]
        const styl = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? 0)
        if (t === 'inlineStr') wiersz[col] = { typ: 'tekst', wartosc: odXml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')), styl }
        else if (t === 's') wiersz[col] = { typ: 'tekst', wartosc: shared[Number(/<v>([^<]*)<\/v>/.exec(body)?.[1])] ?? '', styl }
        else if (t === 'str') wiersz[col] = { typ: 'tekst', wartosc: odXml(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? ''), styl }
        else {
          const v = /<v>([^<]*)<\/v>/.exec(body)?.[1]
          if (v !== undefined) wiersz[col] = { typ: 'liczba', wartosc: Number(v), styl }
        }
      }
      wiersze[Number(r[1]) - 1] = wiersz
    }
    out.set(nazwa, wiersze)
  })
  return out
}
