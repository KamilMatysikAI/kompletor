// Stany formularzy Ustawienia → Druk. Osobny plik, bo plik akcji ('use server') eksportuje tylko akcje.

/** Wynik „Nowy token”: pełny token i kod instalacyjny — tylko w stanie formularza, raz; nigdy w bazie, logu ani adresie. */
export interface StanTokenu {
  error: string | null
  /** `ostrzezenie`: adres serwera bez https poza localhost. */
  utworzony: { stationId: string; stanowisko: string; token: string; kod: string; ostrzezenie: string | null } | null
}

export interface StanAkcji {
  error: string | null
  ok: string | null
}

export const STAN_TOKENU: StanTokenu = { error: null, utworzony: null }
export const STAN_AKCJI: StanAkcji = { error: null, ok: null }
