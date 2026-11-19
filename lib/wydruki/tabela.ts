// Prosta tabela A4 z zawijaniem w kolumnach i powtórzeniem nagłówka strony i tabeli po przejściu
// na kolejną stronę — wspólna dla listy wysyłkowej i spisu produktów.
import { obrazDoWydruku } from './obraz'
import { A4, DOL_TRESCI, FONT, FONT_B, MARGINES, tekstJednaLinia, wysokoscTekstu, type Dokument } from './wspolne'

export const SZER_TABELI = A4.szerokosc - 2 * MARGINES
const DOL = DOL_TRESCI // (26.10.2026): granica nad podniesioną stopką, wspólna z kartą zamówienia

export interface Kolumna {
  tytul: string
  /** Szerokość w pt; suma szerokości = SZER_TABELI. */
  szerokosc: number
  align?: 'left' | 'right' | 'center'
  /** Zawijanie (np. nazwy); bez zawijania tekst jest ucinany z „…”. */
  zawijaj?: boolean
  pogrubiona?: boolean
}

export interface KomorkaTabeli {
  tekst: string
  pogrubiona?: boolean
}

export type Wiersz = (string | KomorkaTabeli)[]

const ROZMIAR = 9.5
const ODSTEP = 4
// (26.10.2026): limit wysokości zawijanej komórki (≈ 10 linii) z „…” — wiersz nie może być wyższy niż strona.
const MAX_KOMORKI = 120

function komorka(k: string | KomorkaTabeli): KomorkaTabeli {
  return typeof k === 'string' ? { tekst: k } : k
}

/**
 * Rysuje tabelę od `y`. `naglowekStrony` rysuje nagłówek dokumentu na nowej stronie i zwraca y,
 * od którego ma iść tabela. Zwraca y pod tabelą.
 */
export function rysujTabele(
  doc: Dokument,
  kolumny: Kolumna[],
  wiersze: Wiersz[],
  y0: number,
  naglowekStrony: () => number,
): number {
  const naglowek = (y: number) => {
    doc.save().rect(MARGINES, y, SZER_TABELI, 16).fill('#e6e6e6').restore()
    let x = MARGINES
    for (const k of kolumny) {
      tekstJednaLinia(doc, k.tytul, x + ODSTEP, y + 4, k.szerokosc - 2 * ODSTEP, {
        font: FONT_B,
        rozmiar: 8,
        align: k.align,
      })
      x += k.szerokosc
    }
    return y + 16
  }

  let y = naglowek(y0)
  wiersze.forEach((w, nr) => {
    const komorki = w.map(komorka)
    const h =
      Math.max(
        ...kolumny.map((k, i) => {
          const c = komorki[i]
          if (!c || !k.zawijaj) return ROZMIAR + 3
          const font = c.pogrubiona || k.pogrubiona ? FONT_B : FONT
          return Math.min(wysokoscTekstu(doc, c.tekst, font, ROZMIAR, k.szerokosc - 2 * ODSTEP), MAX_KOMORKI)
        }),
      ) + 2 * ODSTEP
    if (y + h > DOL) {
      doc.addPage()
      y = naglowek(naglowekStrony())
    }
    if (nr % 2 === 1) doc.save().rect(MARGINES, y, SZER_TABELI, h).fill('#f4f4f4').restore()
    let x = MARGINES
    kolumny.forEach((k, i) => {
      const c = komorki[i]
      if (c) {
        const font = c.pogrubiona || k.pogrubiona ? FONT_B : FONT
        const w = k.szerokosc - 2 * ODSTEP
        if (k.zawijaj) {
          doc.font(font).fontSize(ROZMIAR).text(c.tekst, x + ODSTEP, y + ODSTEP, {
            width: w,
            align: k.align,
            lineGap: 0,
            height: h - 2 * ODSTEP,
            ellipsis: '…',
          })
        } else {
          tekstJednaLinia(doc, c.tekst, x + ODSTEP, y + ODSTEP, w, { font, rozmiar: ROZMIAR, align: k.align })
        }
      }
      x += k.szerokosc
    })
    doc.save().moveTo(MARGINES, y + h).lineTo(MARGINES + SZER_TABELI, y + h).lineWidth(0.3).strokeColor('#999').stroke().restore()
    y += h
  })
  return y
}

/** Czy od `y` zmieści się blok o wysokości `h` (inaczej trzeba dodać stronę). */
export function miesciSie(y: number, h: number): boolean {
  return y + h <= DOL
}

/** Nagłówek list: tytuł, podtytuł, linia. Zwraca y pod nim. */
export function naglowekListy(doc: Dokument, tytul: string, podtytul: string, logoFirmy?: Buffer | null): number {
  const y = MARGINES
  // logo firmy w prawym górnym rogu (po bramce miniatur); zły plik = nagłówek bez logo
  const logo = obrazDoWydruku(logoFirmy)
  const LOGO_W = 120
  let szer = SZER_TABELI
  if (logo) {
    try {
      doc.image(logo, MARGINES + SZER_TABELI - LOGO_W, y - 4, { fit: [LOGO_W, 40], align: 'right', valign: 'center' })
      szer = SZER_TABELI - LOGO_W - 10
    } catch {
      // uszkodzony JPEG: bez logo
    }
  }
  tekstJednaLinia(doc, tytul, MARGINES, y - 2, szer, { font: FONT_B, rozmiar: 18 })
  tekstJednaLinia(doc, podtytul, MARGINES, y + 22, szer, { rozmiar: 10 })
  doc.save().moveTo(MARGINES, y + 40).lineTo(MARGINES + SZER_TABELI, y + 40).lineWidth(1).stroke().restore()
  return y + 48
}
