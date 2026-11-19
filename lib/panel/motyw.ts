// motyw panelu — jasny, ciemny albo zgodny z ustawieniem systemu. Wybór trzyma ciasteczko przeglądarki
// (motyw jest sprawą urządzenia: ten sam człowiek może chcieć ciemny w biurze wieczorem i jasny na tablecie w magazynie),
// więc działa też na ekranie logowania i nie wymaga zmian w bazie. Wartości kolorów: app/ui/tokeny.css.
export type Motyw = 'jasny' | 'ciemny' | 'auto'

export const MOTYWY: readonly Motyw[] = ['jasny', 'ciemny', 'auto']

/** Bez ciasteczka panel jest jasny: ciemny motyw to świadomy wybór, nie niespodzianka na komputerze w magazynie. */
export const MOTYW_DOMYSLNY: Motyw = 'jasny'

export const MOTYW_ETYKIETA: Record<Motyw, string> = { jasny: 'Jasny', ciemny: 'Ciemny', auto: 'Jak system' }

export const MOTYW_CIASTECZKO = 'kompletor_motyw'

/** Wartość z ciasteczka albo formularza → znany motyw; śmieci i brak = domyślny. */
export function motywZ(v: unknown): Motyw {
  return v === 'jasny' || v === 'ciemny' || v === 'auto' ? v : MOTYW_DOMYSLNY
}
