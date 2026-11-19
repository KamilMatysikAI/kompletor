// Czytnik kodów w oknie pakowania — czyste decyzje bez DOM i Reacta, żeby dało się je przetestować
// jednostkowo (testy działają w środowisku `node`, bez przeglądarki). Czytnik „pisze” jak klawiatura: szybkie znaki
// i Enter na końcu. Okno pakowania łapie je z całego dokumentu; pomija tylko pola, w które człowiek pisze tekst.

/** Typy `<input>`, które nie przyjmują tekstu (fokus po dotknięciu nie blokuje czytnika). */
const BEZ_TEKSTU = new Set(['checkbox', 'radio', 'button', 'submit', 'reset'])

/**
 * Czy fokus jest w polu tekstowym (wtedy znaki należą do pola, nie do czytnika). `typ` = `HTMLInputElement.type`
 * (przeglądarka zwraca go małymi literami, domyślnie „text”). Checkbox „Przeczytane i zrobione” i przyciski — nie.
 */
export function poleTekstowe(cel: { tagName: string; type?: string } | null): boolean {
  if (!cel) return false
  if (cel.tagName === 'TEXTAREA') return true
  return cel.tagName === 'INPUT' && !BEZ_TEKSTU.has((cel.type ?? 'text').toLowerCase())
}

export interface BuforCzytnika {
  t: string
  start: number
  last: number
}

/** Najdłuższa przerwa między znakami skanu (i między ostatnim znakiem a Enterem). */
const PRZERWA_MS = 120

export const PUSTY_BUFOR: BuforCzytnika = { t: '', start: 0, last: 0 }

export interface Klawisz {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  /** performance.now() w chwili naciśnięcia. */
  teraz: number
  /** Fokus w polu tekstowym (`poleTekstowe`). */
  wPoluTekstowym: boolean
}

/**
 * Krok bufora czytnika: nowy bufor i — przy Enterze po szybkim ciągu (≥ 4 znaki, średnio < 60 ms na znak) —
 * zeskanowany tekst. Przerwa > 120 ms zaczyna bufor od nowa (człowiek pisze wolniej niż czytnik). Enter po przerwie
 * > 120 ms od ostatniego znaku nie jest końcem skanu: stary bufor (czytnik bez Entera,
 * kilka szybkich klawiszy) przepada, a Enter działa normalnie (przycisk, wiersz z fokusem).
 */
export function krokCzytnika(b: BuforCzytnika, k: Klawisz): { bufor: BuforCzytnika; skan: string | null } {
  if (k.wPoluTekstowym) return { bufor: b, skan: null }
  if (k.key === 'Enter') {
    if (k.teraz - b.last > PRZERWA_MS) return { bufor: PUSTY_BUFOR, skan: null }
    const szybko = b.t.length >= 4 && (b.last - b.start) / Math.max(1, b.t.length - 1) < 60
    return { bufor: PUSTY_BUFOR, skan: szybko ? b.t : null }
  }
  if (k.key.length !== 1 || k.ctrlKey || k.metaKey || k.altKey) return { bufor: b, skan: null }
  if (k.teraz - b.last > PRZERWA_MS) return { bufor: { t: k.key, start: k.teraz, last: k.teraz }, skan: null }
  return { bufor: { t: b.t + k.key, start: b.start, last: k.teraz }, skan: null }
}

/**
 * Esc w oknie pakowania: najpierw okienko, potem cofnięcie samego przejścia do następnego zamówienia („Zostań przy…”),
 * potem krok gabarytu, na końcu zamknięcie okna. W nakładce nad kolejką Esc przy otwartym zamówieniu zamyka
 * tylko je (widok listy, zaznaczenie w kolejce zostaje); całą nakładkę drugi Esc z listy, Esc z podsumowania albo X.
 */
export function poEsc(o: { dialog: unknown; krok: string } | null, przejscieDoCofniecia = false, wNakladce = false): 'dialog' | 'zostan' | 'gabaryt' | 'lista' | 'zamknij' {
  if (o?.dialog) return 'dialog'
  if (przejscieDoCofniecia) return 'zostan'
  if (o?.krok === 'gabaryt') return 'gabaryt'
  if (wNakladce && o && o.krok !== 'podsumowanie') return 'lista'
  return 'zamknij'
}
