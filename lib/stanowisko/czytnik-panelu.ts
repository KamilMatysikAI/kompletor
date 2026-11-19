// Czytnik kodów i wklejanie na ekranach panelu bez otwartego okna pakowania: lista zamówień, Pakowanie,
// lista zbierania. Czyste decyzje bez DOM (testy w czytnik-panelu.test.ts); bufor czytnika ten sam co w oknie
// pakowania (`krokCzytnika`: ≥ 4 znaki, średnio < 60 ms na znak, przerwa > 120 ms zaczyna od nowa, Enter kończy).
import { poleTekstowe } from './czytnik'

/** Element z fokusem albo cel zdarzenia, opisany bez DOM. */
export interface CelZdarzenia {
  tagName: string
  type?: string
  /** contenteditable */
  edytowalny?: boolean
  /** element leży w oknie dialogowym (`<dialog>`, role="dialog", aria-modal) */
  wDialogu?: boolean
  /** to pole „Szukaj” listy zamówień */
  poleSzukania?: boolean
}

/** Pole, w które człowiek pisze tekst: input tekstowy, textarea, lista wyboru, contenteditable. */
export function wPolu(cel: CelZdarzenia | null): boolean {
  if (!cel) return false
  if (cel.edytowalny || cel.tagName === 'SELECT') return true
  return poleTekstowe(cel)
}

/**
 * Czy ekran przechwytuje klawisze czytnika: nie, gdy fokus jest w polu (znaki należą do pola, a Enter w polu „Szukaj”
 * obsługuje formularz) albo gdy otwarte jest okno dialogowe (`dialogOtwarty`: dowolne na stronie).
 */
export function przechwytujKlawisze(cel: CelZdarzenia | null, dialogOtwarty: boolean): boolean {
  if (dialogOtwarty || cel?.wDialogu) return false
  return !wPolu(cel)
}

/**
 * Wklejenie: `pole_szukania` = wklejone w pole „Szukaj” listy (tekst trafia do pola jak zwykle, a jedno trafienie
 * otwiera kartę), `poza` = fokus poza polami (ekran sam rozpoznaje numer), `pomin` = inne pole formularza (daty,
 * notatki) albo okno dialogowe: nic nie otwieramy.
 */
export function decyzjaWklejenia(cel: CelZdarzenia | null, dialogOtwarty: boolean): 'pole_szukania' | 'poza' | 'pomin' {
  if (dialogOtwarty || cel?.wDialogu) return 'pomin'
  if (cel?.poleSzukania) return 'pole_szukania'
  return wPolu(cel) ? 'pomin' : 'poza'
}

/** Najdłuższy wklejony poza polami tekst, który bez trafienia trafia do „Szukaj”. */
export const MAX_WKLEJENIA_DO_SZUKANIA = 40

/**
 * Wklejenie poza polami bez jednego trafienia: krótki tekst w jednej linii filtruje listę (zwraca frazę do „Szukaj”),
 * dłuższy albo wielolinijkowy (fragment maila, tytuł przelewu) NIE idzie do wyszukiwarki ani do adresu strony: null,
 * ekran mówi „Nie znalazłem numeru zamówienia we wklejonym tekście”.
 */
export function wklejenieDoSzukania(tekst: string): string | null {
  const t = String(tekst ?? '').trim()
  if (!t || /[\r\n]/.test(t)) return null
  const f = t.replace(/\s+/g, ' ')
  return f.length <= MAX_WKLEJENIA_DO_SZUKANIA ? f : null
}
