// Progi akcji masowych listy zamówień. Osobny plik bez importów bazy, bo czyta go też
// pasek akcji w przeglądarce (komunikat „pójdzie w tle” i limit przed wysłaniem).
// Przesyłki i etykiety to żądania do przewoźnika albo stanowiska druku (1–5 s każde), więc idą w tle już od 10
// zamówień (interfejs z limitem czasu żądania kolejkuje dłuższą pracę) i mają twardszy limit: 200 przesyłek × 5 s
// mieści się w godzinie, po której kolejka uznaje zadanie za porzucone.
export const RODZAJE = ['STATUS', 'PRZESYLKI', 'ETYKIETY'] as const
export type RodzajAkcji = (typeof RODZAJE)[number]

export const NAZWA_AKCJI: Record<RodzajAkcji, string> = {
  STATUS: 'Zmiana statusu',
  PRZESYLKI: 'Utworzenie przesyłek',
  ETYKIETY: 'Druk etykiet',
}

/** Od tylu zamówień akcja idzie w tle (wiersz z postępem + zadanie kolejki), poniżej od razu w żądaniu. */
export const PROG_TLA: Record<RodzajAkcji, number> = { STATUS: 50, PRZESYLKI: 10, ETYKIETY: 10 }

/** Najwięcej zamówień w jednej akcji danego rodzaju. */
export const MAKS_AKCJI: Record<RodzajAkcji, number> = { STATUS: 1000, PRZESYLKI: 200, ETYKIETY: 200 }

/** Najwięcej identyfikatorów przyjmowanych z formularza (największy z limitów). */
export const MAKS_ZAMOWIEN = Math.max(...Object.values(MAKS_AKCJI))
