// Progi i nazwy akcji masowych listy przesyłek. Osobny plik bez importów bazy, bo czyta go też pasek
// akcji i pasek postępu w przeglądarce (jak lib/zamowienia/masowo-progi.ts).
export const RODZAJE_PRZESYLEK = ['PRZESYLKI_DRUK', 'PRZESYLKI_ANULUJ'] as const
export type RodzajPrzesylek = (typeof RODZAJE_PRZESYLEK)[number]

export const NAZWA_AKCJI_PRZESYLEK: Record<RodzajPrzesylek, string> = { PRZESYLKI_DRUK: 'Druk etykiet', PRZESYLKI_ANULUJ: 'Anulowanie przesyłek' }
/** Od tylu przesyłek akcja idzie w tle (druk i anulowanie to 1–5 s na przesyłkę). */
export const PROG_TLA_PRZESYLEK = 10
/** Najwięcej przesyłek w jednej akcji (grudzień: do 1 630 zamówień w miesiącu, jeden dzień to kilkaset). */
export const MAKS_PRZESYLEK = 500
/** Najwięcej etykiet w jednym pliku PDF i przesyłek w jednym protokole (pobranie w żądaniu, bez kolejki; lista wysyłkowa ma limit 200 zamówień). */
export const MAKS_PLIKU = 200
