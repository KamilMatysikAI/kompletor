// Typy modułu maili. Moduł tylko renderuje: temat + HTML + tekst + załączniki. Wysyłkę i zapis
// nadpisań w bazie dołożą osobne zadania, dlatego wszystko tu jest zwykłymi danymi (JSON poza załącznikami).

// „niski-stan” (do biura, reguła P2) i „reset-hasla” (link do osoby z kontem w panelu).
// „zaproszenie” (link zaproszenia do firmy, wyłącznie do zaproszonej osoby).
// „nieudana-platnosc”: przypomnienie po nieudanej płatności online (pytanie o problem i dane do przelewu).
// Zwroty i reklamacje: potwierdzenie odbioru paczki i zwrotu pieniędzy (do klienta, za wyłącznikiem firmy).
export type RodzajMaila =
  | 'brak-platnosci'
  | 'nieudana-platnosc'
  | 'faktura'
  | 'gotowe-do-odbioru'
  | 'blad-faktury'
  | 'niski-stan'
  | 'reset-hasla'
  | 'zaproszenie'
  | 'zwrot-przyjety'
  | 'reklamacja-przyjeta'
  | 'zwrot-pieniedzy'

/** Do kogo idzie mail: klient sklepu albo biuro firmy (maile wewnętrzne). */
export type Odbiorca = 'klient' | 'biuro'

/** Dane firmy (najemcy systemu) do stopki. Jedna firma ma wiele sklepów i marek. */
export interface DaneFirmy {
  nazwa: string
  adres: string[] // linie adresu, np. ['ul. Przykładowa 1', '00-000 Testowo']
  nip?: string | null
  email?: string | null // kontakt w stopce
  telefon?: string | null
  www?: string | null
  emailBiura?: string | null // adresat maili wewnętrznych (np. błąd faktury)
  stopkaDodatkowa?: string | null // np. dane rejestrowe KRS, zwykły tekst
}

export interface OdbiorOsobisty {
  adres: string[]
  godziny: string[] // np. ['pon.-pt. 9:00-17:00'], tekst sklepu, bez interpretacji
  uwagi?: string | null
}

/** Wygląd i dane sklepu (marki). Szablon jest per firma (stopka) i per sklep (nagłówek, kolor, odpowiedzi). */
export interface DaneSklepu {
  nazwa: string
  logoUrl?: string | null // http(s); bez logo w nagłówku jest nazwa sklepu
  logoCiemneUrl?: string | null // wersja logo na ciemne tło (klienci z prefers-color-scheme)
  logoSzerokosc?: number | string | null // px, domyślnie 160; tekst z bazy („200”) zamieniany na liczbę
  kolorGlowny: string // #rrggbb
  odpowiedzDo: string // Reply-To
  www?: string | null
  odbiorOsobisty?: OdbiorOsobisty | null
}

export interface KontekstMarki {
  firma: DaneFirmy
  sklep: DaneSklepu
}

// ─── Treść szablonu ──────────────────────────────────────────────────────────
// Teksty w blokach to szablony: {{zmienna}}, {{#zmienna}}…{{/zmienna}} (gdy jest), {{^zmienna}}…{{/zmienna}}
// (gdy jej brak). Tekst jest zwykłym tekstem, nie HTML (ucieczka zawsze), \n to nowa linia.
// `jesli`: blok tylko gdy zmienna jest. Blok, który wyrenderował się do pustego tekstu, jest pomijany.

export type Blok =
  | { typ: 'akapit'; tekst: string; jesli?: string }
  | { typ: 'szczegoly'; wiersze: WierszSzczegolow[]; jesli?: string }
  | { typ: 'lista'; zmienna: string; naglowek?: string; jesli?: string }
  | { typ: 'przycisk'; etykieta: string; url: string; jesli?: string }
  | { typ: 'uwaga'; tekst: string; jesli?: string }
  | { typ: 'kod'; tekst: string; jesli?: string }

export interface WierszSzczegolow {
  etykieta: string
  wartosc: string
  jesli?: string
}

export interface OpisZmiennej {
  opis: string
  wymagana: boolean
  lista?: boolean // wartość to lista tekstów (blok `lista`)
}

export interface DefinicjaSzablonu {
  rodzaj: RodzajMaila
  odbiorca: Odbiorca
  zmienne: Record<string, OpisZmiennej>
  temat: string
  podglad: string // tekst podglądu w skrzynce (preheader)
  naglowek: string
  bloki: Blok[]
}

/** Nadpisanie treści per firma albo per sklep (zapis w bazie: osobne zadanie). Puste pole = treść domyślna. */
export interface NadpisanieSzablonu {
  temat?: string
  podglad?: string
  naglowek?: string
  bloki?: Blok[]
}

export type NadpisaniaSzablonow = Partial<Record<RodzajMaila, NadpisanieSzablonu>>

export interface OpcjeRenderowania {
  /** Kolejność: domyślny z kodu < firma < sklep (pole po polu). */
  nadpisania?: { firma?: NadpisaniaSzablonow | null; sklep?: NadpisaniaSzablonow | null }
}

export interface Zalacznik {
  nazwaPliku: string
  typMime: string
  tresc: Uint8Array
  /** obraz osadzony w treści (`<img src="cid:…">`, np. logo firmy), nie osobny załącznik do pobrania. */
  cid?: string
}

/** adres logo firmy osadzonego w mailu (logo bez publicznego adresu: obraz idzie w samym mailu). */
export const LOGO_FIRMY_CID = 'logo-firmy@kompletor'
export const LOGO_FIRMY_SRC = `cid:${LOGO_FIRMY_CID}`

export interface GotowyMail {
  rodzaj: RodzajMaila
  odbiorca: Odbiorca
  /** Adresat ustalony przez szablon (maile do biura); dla klienta null, adres zna wysyłka. */
  do: string | null
  odpowiedzDo: string
  temat: string // jedna linia, bez znaków nowej linii
  html: string
  tekst: string // linie rozdzielone \n (CRLF dołoży wysyłka)
  zalaczniki: Zalacznik[]
}
