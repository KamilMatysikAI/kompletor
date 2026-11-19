// Port eksportu przelewów zwrotów do banku Erste: SAM INTERFEJS, bez implementacji, bez wywołań i bez
// przycisku w panelu. Decyzja właściciela: zwroty zostają w BaseLinkerze do jego wyłączenia, a formatu pliku Erste
// nikt jeszcze nie potwierdził — implementacja powstanie dopiero z potwierdzonym formatem (osobne zadanie).
//
// Luki (wypisane też w docs/zwroty-i-reklamacje.md):
//  1. Numer konta klienta: system go nie przechowuje (żadnych danych osobowych w bazie), więc przychodzi w argumencie
//     z zewnątrz w chwili eksportu i nigdzie nie jest zapisywany ani logowany.
//  2. Kwota: `Return` nie ma dziś kwoty zwrotu — trzeba ją wziąć z korekty faktury (wFirma, `Return.correctionDocId`).
//  3. Format Erste (CSV? Elixir? XML pain.001?): do potwierdzenia z bankiem; od niego zależy kodowanie, separator i
//     długość tytułu przelewu.

/** Jeden przelew zwrotu. Wiersz żyje tylko w pamięci na czas eksportu. */
export interface WierszPrzelewuZwrotu {
  /** `Return.id` — powiązanie przelewu ze zwrotem w systemie. */
  returnId: string
  /** Kwota brutto w złotych (z korekty faktury; `Return` jej dziś nie ma). */
  kwota: number
  /** Tytuł przelewu, np. numer zamówienia i korekty — bez danych osobowych. */
  tytul: string
  /** Numer konta klienta (NRB/IBAN) podany z zewnątrz; system go nie przechowuje. */
  kontoOdbiorcy: string
}

/** Eksport paczki przelewów do pliku banku Erste. Format do potwierdzenia; brak implementacji w tym zadaniu. */
export interface EksportPrzelewowZwrotow {
  /** Zawartość pliku do wgrania w bankowości Erste i jego proponowana nazwa. Nic nie wysyła i niczego nie zapisuje. */
  eksportuj(wiersze: readonly WierszPrzelewuZwrotu[]): Promise<{ nazwaPliku: string; zawartosc: Uint8Array }>
}
