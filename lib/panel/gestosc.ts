// gęstość panelu per osoba. „Gęsto” dla biura (więcej wierszy na ekranie), „wygodnie” dla magazynu
// i ekranów dotykowych (większe pola i wiersze, cele ≥ 44 px). Wartość trzyma `User.gestosc`; tokeny w app/ui/tokeny.css.
export type Gestosc = 'gesto' | 'wygodnie'

export const GESTOSCI: readonly Gestosc[] = ['gesto', 'wygodnie']

export const GESTOSC_DOMYSLNA: Gestosc = 'gesto'

export const GESTOSC_ETYKIETA: Record<Gestosc, string> = { gesto: 'Gęsto', wygodnie: 'Wygodnie' }

/** Wartość z bazy albo formularza → znana gęstość; śmieci i brak = domyślna. */
export function gestoscZ(v: unknown): Gestosc {
  return v === 'gesto' || v === 'wygodnie' ? v : GESTOSC_DOMYSLNA
}
