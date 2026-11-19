// Zakresy kluczy API. Czyste stałe i funkcje — bez bazy, używane przez trasy, ekran kluczy i testy.
// Nowy zakres = wpis tutaj + nowa migracja warunku "ApiKey_scopes" (lista dozwolonych wartości w bazie).
// `produkty:odczyt` i `raporty:odczyt` (nowe trasy /api/v1) oraz `mcp:odczyt` (serwer MCP /api/mcp dla
// agentów AI, migracja 20261106150000_mcp_a102). Klucz agenta ma osobny zakres: integracja z kluczem `stany:odczyt`
// nie dostaje narzędzi MCP, a klucz agenta nie dostaje tras REST.
// `obsluga:odczyt` (trasy /api/v1/obsluga/* dla chatbota obsługi klienta, migracja 20261116290000) jest zakresem
// osobnym: klucz z nim nie ma żadnego innego zakresu (walidacja przy tworzeniu, warunek w bazie i bramka
// requireApiKey), a założyć go może tylko osoba z uprawnieniem „Dane klienta”.

export const API_SCOPES = {
  'stany:odczyt': 'Odczyt stanów (GET /api/v1/stany)',
  'zamowienia:odczyt': 'Odczyt zamówień i słownika statusów (GET /api/v1/zamowienia, /api/v1/statusy)',
  'zamowienia:zapis': 'Dodawanie zamówień EasyTools (POST /api/v1/zamowienia)',
  'produkty:odczyt': 'Odczyt katalogu produktów (GET /api/v1/produkty)',
  'raporty:odczyt': 'Raporty: liczby dnia, braki, rezerwacje i sprzedaż z marżą (GET /api/v1/raporty/…)',
  'mcp:odczyt': 'Agent AI: narzędzia odczytu serwera MCP (POST /api/mcp)',
  'obsluga:odczyt': 'Obsługa klienta (chatbot): zamówienia klienta po e-mailu albo telefonie, bez danych osobowych w odpowiedzi (POST /api/v1/obsluga/…). Klucz tylko z tym zakresem',
} as const

export type ApiScope = keyof typeof API_SCOPES

/** Zakres obsługi klienta: klucz z nim nie ma innych zakresów. */
export const OBSLUGA_SCOPE = 'obsluga:odczyt' as const satisfies ApiScope

/** Kolejność wszystkich zakresów (zapis klucza, ekran). */
export const KOLEJNOSC_ZAKRESOW = Object.keys(API_SCOPES) as ApiScope[]

/** Zakresy ogólne, które wolno łączyć w jednym kluczu (wszystkie poza zakresem obsługi klienta). */
export const ALL_API_SCOPES = KOLEJNOSC_ZAKRESOW.filter((s) => s !== OBSLUGA_SCOPE)

/** Zakresy serwera MCP (ekran Ustawienia → Agenci AI). Zapis (`mcp:zapis`) dojdzie z narzędziami części B. */
export const MCP_SCOPES = ['mcp:odczyt'] as const satisfies readonly ApiScope[]
export type McpScope = (typeof MCP_SCOPES)[number]

export function isApiScope(v: string): v is ApiScope {
  return Object.prototype.hasOwnProperty.call(API_SCOPES, v)
}

/** Przedrostek klucza: rozpoznanie w logach serwera proxy i w skanerach wycieków, bez treści klucza. */
export const API_KEY_PREFIX = 'kmp_'
/** kmp_ + 32 losowe bajty w base64url (43 znaki). */
export const API_KEY_RE = /^kmp_[A-Za-z0-9_-]{43}$/
/** Ile znaków klucza pokazuje ekran (kmp_ + 8): dość, żeby rozpoznać klucz, za mało, żeby go odtworzyć. */
export const API_KEY_SHOWN = 12

export const API_KEY_NAME_MAX = 80
