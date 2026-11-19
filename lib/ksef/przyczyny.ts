// Przyczyny błędów wysyłki do KSeF: kod w kolumnie
// `KsefInvoiceDraft.przyczyna` zamiast dopasowania tekstu `lastError`. Automat workera ponawia sam tylko przyczyny
// „nasze” (sieć, limit czasu zadania, 429/5xx przed przyjęciem do przetwarzania, nieudane logowanie, porzucona próba),
// do `PONOWIENIA_AUTO_MAX` razy z rosnącym odstępem. Odrzucenia przez KSeF (4xx, 450), błędy danych i konfiguracji
// zostają dla człowieka („Ponów” na liście faktur). Każde ponowienie wysyła TEN SAM numer, więc dubel KSeF odrzuca
// kodem 440 z numerem oryginału (lib/ksef/wysylka.ts).
import { BladKsefApi } from './api/polaczenie'
import { KsefHttpError } from './api/sesja'

export const PRZYCZYNY = [
  /** Błąd sieci przed przyjęciem do przetwarzania (stan nieznany: ponowienie wyśle ten sam numer). */
  'SIEC',
  /** Próba przerwana twardym limitem czasu zadania `ksef-wysylka`. */
  'PRZERWANA',
  /** HTTP 429 przy otwarciu sesji albo wysyłce (KSeF ograniczył liczbę żądań). */
  'LIMIT_ZADAN',
  /** HTTP 5xx przy otwarciu sesji albo wysyłce. */
  'SERWER',
  /** Logowanie do KSeF tokenem firmy się nie udało. */
  'LOGOWANIE',
  /** Próba porzucona (serwer zatrzymał się w trakcie; sprzątacz po `PROBA_PORZUCONA_MS`). */
  'PORZUCONA',
  /** KSeF odrzucił żądanie (4xx inne niż 429) przy otwarciu sesji albo wysyłce. */
  'KSEF_ODMOWA',
  /** Dane faktury (nabywca, pozycje, schemat FA(3), faktura korygowana nieprzyjęta). */
  'DANE',
  /** Walidator schematu niedostępny (problem serwera, do administratora). */
  'SCHEMAT',
  /** Brak tokenu, serii albo inne ustawienia firmy. */
  'KONFIGURACJA',
  /** Faktura poszła do KSeF, ale od wielu prób nie da się odczytać jej stanu (dalej „Ponów” = sam odczyt). */
  'ODCZYT_STANU',
] as const
export type Przyczyna = (typeof PRZYCZYNY)[number]

/** Przyczyny, które automat ponawia sam. */
export const PRZYCZYNY_AUTO: readonly Przyczyna[] = ['SIEC', 'PRZERWANA', 'LIMIT_ZADAN', 'SERWER', 'LOGOWANIE', 'PORZUCONA']

/** Ile automatycznych ponowień jednej faktury (potem już tylko „Ponów” człowieka). */
export const PONOWIENIA_AUTO_MAX = 6
/** Odstęp przed kolejnym automatycznym ponowieniem, po `n` dotychczasowych (2, 5, 15, 30, 60, 120 min). */
export const ODSTEPY_AUTO_MS = [2, 5, 15, 30, 60, 120].map((m) => m * 60_000)

export function odstepPonowienia(dotychczas: number): number {
  return ODSTEPY_AUTO_MS[Math.min(Math.max(dotychczas, 0), ODSTEPY_AUTO_MS.length - 1)]!
}

export const automatPonawia = (p: string | null | undefined): boolean => !!p && (PRZYCZYNY_AUTO as readonly string[]).includes(p)

/**
 * Przyczyna błędu przy otwarciu sesji albo wysyłce faktury, PRZED odpowiedzią 202 (po 202 nie ma błędu wysyłki, jest
 * „stan do sprawdzenia”). `przerwano` = sygnał limitu zadania był już ustawiony.
 */
export function przyczynaWysylki(e: unknown, przerwano: boolean): Przyczyna {
  if (przerwano) return 'PRZERWANA'
  const status = e instanceof KsefHttpError || e instanceof BladKsefApi ? e.status : undefined
  if (!status) return 'SIEC'
  if (status === 429) return 'LIMIT_ZADAN'
  // token dostępowy odrzucony (odświeżenie nie pomogło) albo bez uprawnień: problem logowania, nie faktury
  if (status === 401 || status === 403) return 'LOGOWANIE'
  if (status >= 500) return 'SERWER'
  if (status >= 400) return 'KSEF_ODMOWA'
  return 'SIEC'
}

/**
 * Komunikat dla człowieka do błędu wysyłki przed 202 (bez danych nabywcy; `szczegol` = kod HTTP i opis KSeF).
 * `otwarcieSesji` = błąd przy otwarciu sesji, faktura w ogóle nie wyszła (osobny tekst przy odmowie KSeF).
 */
export function komunikatWysylki(p: Przyczyna, szczegol: string, o: { otwarcieSesji?: boolean } = {}): string {
  if (p === 'KSEF_ODMOWA' && o.otwarcieSesji) return `KSeF odrzucił otwarcie sesji: ${szczegol}. Faktura nie została wysłana; kliknij „Ponów” (ten sam numer), a gdy błąd wraca, zgłoś go administratorowi.`
  if (p === 'LIMIT_ZADAN') return `KSeF ograniczył liczbę żądań (${szczegol}). Faktura nie została przyjęta; system wyśle ją ponownie z tym samym numerem.`
  if (p === 'KSEF_ODMOWA') return `KSeF nie przyjął faktury: ${szczegol}`
  if (p === 'LOGOWANIE') return `KSeF odrzucił logowanie (${szczegol}). Faktura nie została przyjęta; system spróbuje ponownie z tym samym numerem. Jeśli błąd wraca, sprawdź token KSeF w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → Numeracja i KSeF.`
  if (p === 'PRZERWANA') return `Wysyłka przerwana limitem czasu (${szczegol}). System wyśle ją ponownie z tym samym numerem: jeśli KSeF ją już ma, odrzuci dubel i poda jej numer KSeF.`
  return `Brak odpowiedzi KSeF (${szczegol}). System wyśle tę samą fakturę z tym samym numerem: jeśli KSeF ją już ma, odrzuci dubel i poda jej numer KSeF.`
}
