// Pomocnicze ZPL. Pliki zawsze z `^CI28` (UTF-8, polskie znaki — README agenta, sekcja 4).
// Tekst pola idzie przez `^FH` (szesnastkowo): znaki sterujące ZPL `^`, `~` i znak ucieczki `_` nie mogą przerwać pola,
// nawet gdy nazwa stanowiska pochodzi od użytkownika.

/** 203 dpi = 8 punktów na mm (typowe drukarki etykiet Zebra). */
export const PUNKTY_NA_MM = 8

export function poleZpl(tekst: string): string {
  const bezpieczny = tekst
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[_^~]/g, (c) => `_${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  return `^FH_^FD${bezpieczny}^FS`
}

export interface TekstZpl {
  x: number
  y: number
  tekst: string
  /** Wysokość znaków w punktach. */
  wys: number
  /** Szerokość pola: tekst zawijany (`^FB`) i wyśrodkowany, gdy `srodek`. */
  szer?: number
  linii?: number
  srodek?: boolean
  odwrocony?: boolean
}

export function tekstZpl(t: TekstZpl): string {
  const fb = t.szer ? `^FB${t.szer},${t.linii ?? 1},0,${t.srodek ? 'C' : 'L'},0` : ''
  return `^FO${t.x},${t.y}${t.odwrocony ? '^FR' : ''}^A0N,${t.wys},${t.wys}${fb}${poleZpl(t.tekst)}`
}

/** Etykieta 100 × 150 mm: nagłówek ZPL z ^CI28, szerokością i długością. */
export function etykietaZpl(tresc: string[], szerMm = 100, wysMm = 150): Buffer {
  const linie = ['^XA', '^CI28', `^PW${szerMm * PUNKTY_NA_MM}`, `^LL${wysMm * PUNKTY_NA_MM}`, '^LH0,0', ...tresc, '^XZ']
  return Buffer.from(linie.join('\n') + '\n', 'utf8')
}
