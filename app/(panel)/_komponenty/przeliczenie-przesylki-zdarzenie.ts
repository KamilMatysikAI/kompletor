// zdarzenie okna po świeżym policzeniu przesyłki. Blok nadania trzyma stan z chwili
// montażu, więc po „Policz przesyłkę” (karta) albo po odmowie automatu nadania (stanowisko) pokazywał stare ostrzeżenia
// do potwierdzenia albo nie pokazywał żadnych. Po tym zdarzeniu blok czyści zaznaczenia i bierze świeży stan z serwera.
const ZDARZENIE_PRZESYLKA_PRZELICZONA = 'kompletor-przesylka-przeliczona'

export interface Przeliczenie {
  orderId: string
  /** Ostrzeżenia z odmowy nadania (świeże teksty); brak = tylko odświeżenie stanu z serwera. */
  doPotwierdzenia?: { kod: string; tekst: string }[]
}

/** Daje znać blokom tego zamówienia, że przesyłka policzyła się od nowa. */
export function ogloszPrzeliczeniePrzesylki(p: Przeliczenie): void {
  window.dispatchEvent(new CustomEvent<Przeliczenie>(ZDARZENIE_PRZESYLKA_PRZELICZONA, { detail: p }))
}

/** Subskrypcja zdarzenia dla jednego zamówienia; zwraca funkcję wypisania (do sprzątania w `useEffect`). */
export function naPrzeliczeniePrzesylki(orderId: string, f: (p: Przeliczenie) => void): () => void {
  const sluchacz = (e: Event) => {
    const d = (e as CustomEvent<Przeliczenie>).detail
    if (d?.orderId === orderId) f(d)
  }
  window.addEventListener(ZDARZENIE_PRZESYLKA_PRZELICZONA, sluchacz)
  return () => window.removeEventListener(ZDARZENIE_PRZESYLKA_PRZELICZONA, sluchacz)
}
