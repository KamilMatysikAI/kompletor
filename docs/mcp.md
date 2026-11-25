# Serwer MCP Kompletora dla agentów AI

Kompletor wystawia serwer [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28) pod
`/api/mcp`. Agent AI klienta (Claude Code, Cursor, VS Code z Copilotem, Gemini CLI, Claude Desktop przez pomost) dostaje
narzędzia do **odczytu** danych jednej firmy: zamówień, stanów, produktów, braków, rezerwacji i liczb dnia.

Serwer **nie woła żadnego modelu AI** i nie zużywa `AiUsage`: modelem jest agent klienta, Kompletor podaje tylko narzędzia.

Opis dla sprzedawcy (krok po kroku): [docs/agenci-ai.md](agenci-ai.md). Przykłady: adres
`https://kompletor.example.invalid`, klucz `kmp_PRZYKLADOWY_KLUCZ` (celowo w złym formacie), SKU `TEST-*`.

## Wersja protokołu

- **Aktualna rewizja: `2026-07-28`** (sprawdzone 03.11.2026 w repozytorium specyfikacji
  `modelcontextprotocol/modelcontextprotocol`: katalogi `schema/` i `docs/specification/` mają `2026-07-28` i `draft`,
  nic nowszego nie wyszło). Stała w kodzie: `MCP_PROTOCOL_LATEST` w `lib/mcp/protokol.ts`.
- Serwer jest **dual-era** (spec `basic/versioning`, „Backward Compatibility”):
  - **2026-07-28** (bezstanowa): bez `initialize`; każde żądanie niesie wersję w
    `params._meta["io.modelcontextprotocol/protocolVersion"]`; nagłówki `MCP-Protocol-Version`, `Mcp-Method` i
    (dla `tools/call`) `Mcp-Name` muszą się zgadzać z treścią, inaczej `400` + `HeaderMismatch` (`-32020`);
    `server/discover`; wynik z `resultType: "complete"` i `_meta["io.modelcontextprotocol/serverInfo"]`;
    `tools/list` z `ttlMs` i `cacheScope`.
  - **2025-11-25** i **2025-06-18** (dzisiejsze klienty): `initialize` + `notifications/initialized` + nagłówek
    `MCP-Protocol-Version` w kolejnych żądaniach, `ping`. **Bez sesji**: serwer nie wydaje `Mcp-Session-Id`
    (te rewizje na to pozwalają), każde żądanie obsłużone osobno.
- Jawnie podana inna wersja = `400` + `UnsupportedProtocolVersion` (`-32022`)
  z `data.supported = ["2026-07-28", "2025-11-25", "2025-06-18"]`. `initialize` z nieznaną wersją (np. `2024-11-05`)
  dostaje w odpowiedzi `2025-11-25` (negocjacja z rewizji 2025-11-25).
- Żądanie bez nagłówka `MCP-Protocol-Version` (poza `initialize` i bez `_meta` z wersją) serwer traktuje jako
  `2025-11-25`: jest bezstanowy, więc nie pamięta negocjacji, a `tools/list` i `tools/call` są w obu starszych
  rewizjach takie same. Klient, który wysyła nagłówek tylko czasem, dalej działa.

## Dlaczego własna obsługa JSON-RPC, nie SDK

Sprawdzone 03.11.2026 na npm: `@modelcontextprotocol/sdk` 1.32.2 (MIT) i jego następca `@modelcontextprotocol/server`
2.4.0 (Apache-2.0, zależności `zod` ^4 i `@modelcontextprotocol/core`). Licencje są zgodne z AGPL-3.0, ale w 2.4.0
`LATEST_PROTOCOL_VERSION` to nadal `2025-11-25`, a 2026-07-28 jest tylko w typach (bez obsługi bezstanowej ścieżki
w transporcie). Narzędzi mamy kilka, wszystkie tylko czytają i odpowiadają jednym JSON-em, więc cienka obsługa na
typach ze `schema/2026-07-28/schema.ts` (`lib/mcp/protokol.ts`, ok. 150 linii) jest mniejsza niż SDK z zod i ajv
w bundlu Next, a dual-era bez sesji robimy wprost. Gdy SDK dostanie pełne 2026-07-28, można przejść na nie bez zmiany
rejestru narzędzi (`lib/mcp/narzedzia.ts`).

## Transport (Streamable HTTP)

- `POST /api/mcp`, jedna wiadomość JSON-RPC na żądanie (paczki tablicą = `400`), odpowiedź zawsze jednym obiektem
  `application/json` (bez SSE). Powiadomienia = `202` bez treści. `GET` i `DELETE` = `405` (`Allow: POST`): nie ma
  strumienia GET ani sesji do zamknięcia. `Cache-Control: no-store`.
- **Bezstanowo**: między żądaniami w pamięci zostają tylko liczniki limitów.
- `Origin` (ochrona przed DNS rebinding): obecny i spoza listy = `403`. Lista: origin z `PANEL_URL` i z
  `MCP_DOZWOLONE_ORIGINY` (po przecinku). CLI i serwery `Origin` nie wysyłają: przechodzą. Origin jest sprawdzany
  przed kluczem.
- `Accept` musi dopuszczać `application/json` (`406`), `Content-Type: application/json` (`415`).
- Treść do **64 KB** (jak `POST /api/v1/zamowienia`), większa = `413`. Zły JSON = `400` + `-32700`.
- Nieznana metoda: w 2026-07-28 `404` + `-32601`, w 2025-11-25 `200` + `-32601` (tam `404` znaczy „sesja wygasła”).
- Staging: `/api/mcp` jest poza Basic Auth i poza sesją panelu (`proxy.ts`, `lib/basic-auth.ts`), jak `/api/v1`:
  bramką jest wyłącznie klucz. Wyjątek dotyczy dokładnie tej ścieżki (`/api/mcp/x`, `/api/mcpx` dalej za bramką).

## Uwierzytelnienie

- Nagłówek `Authorization: Bearer kmp_…`: ten sam klucz firmy co API v1 (`lib/api/klucze.ts`,
  `authenticateApiKey`: SHA-256 w bazie, RLS po firmie klucza, `lastUsedAt` raz na 5 min, 120 żądań/min na klucz,
  30 nieudanych prób z IP w 10 min).
- Brak, zły, odwołany klucz albo firma nieaktywna = `401` z `WWW-Authenticate: Bearer realm="Kompletor MCP"` i
  treścią JSON-RPC (`-32001`), ta sama bez względu na powód. **Bez `resource_metadata`**: serwer nie ma OAuth, więc nie
  wskazuje serwera autoryzacji (spec: autoryzacja jest opcjonalna). Klient z OAuth na tym kończy i prosi o klucz.
- Klucz bez zakresu MCP przechodzi bramkę (lista narzędzi działa), ale **każde wywołanie narzędzia** dostaje błąd
  narzędzia „brak dostępu” (`ODMOWA` w dzienniku).

### Klienty: klucz albo OAuth (stan 03.11.2026)

| Klient | Jak się łączy | Kluczem dziś? |
| --- | --- | --- |
| Claude Code | `claude mcp add --transport http … --header "Authorization: Bearer …"` | tak |
| Cursor | `mcp.json`: `url` + `headers` | tak |
| VS Code (GitHub Copilot) | `.vscode/mcp.json`: `type: http`, `headers`, klucz z `inputs` (`password: true`) | tak |
| Gemini CLI | `settings.json`: `httpUrl` + `headers` | tak |
| Claude Desktop | łącznik zdalny (Ustawienia → Łączniki) wymaga OAuth; **pomost stdio** `kompletor-mcp` w `claude_desktop_config.json` | przez pomost |
| claude.ai (web), ChatGPT (łączniki) | serwer bez logowania albo OAuth 2.1, bez własnego nagłówka | nie: czeka na OAuth |

OAuth 2.1 (serwer autoryzacji, `/.well-known/oauth-protected-resource`, Client ID Metadata Documents) to **osobne
zadanie**; do tego czasu claude.ai, łączniki Claude Desktop i ChatGPT nie połączą się z Kompletorem bez pomostu.
Uczciwie: dane klientów w tabeli to stan dokumentacji klientów, nie test z każdym z nich: test po wdrożeniu (niżej)
robimy z Claude Code.

## Zakresy

| Zakres | Co daje |
| --- | --- |
| `mcp:odczyt` | wszystkie narzędzia poniżej (tylko odczyt) |

Klucz agenta ma osobny zakres (nie `stany:odczyt` itd.): klucz integracji nie dostaje narzędzi MCP, a klucz agenta
nie dostaje tras REST. Zakres `mcp:zapis` dojdzie z narzędziami zapisu (część B, niżej). Lista: `lib/api/zakresy.ts`
(`MCP_SCOPES`), w bazie warunek `ApiKey_scopes` (migracja `20261106150000_mcp_a102`).

Asystent w panelu użyje tego samego rejestru z kontekstem z sesji: `contextFromPanel` w
`lib/mcp/kontekst.ts` zamienia uprawnienie `panel.podglad` na `mcp:odczyt`.

## Narzędzia

Nazwy po polsku w `snake_case` bez znaków diakrytycznych (część klientów MCP nie przyjmuje innych). Wszystkie mają
adnotacje `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`, schemat wejścia z
`additionalProperties: false` i schemat wyjścia (`structuredContent` + ten sam JSON w bloku tekstowym). Kolejność
w `tools/list` stała. Firma **zawsze z klucza**: żadne narzędzie nie ma argumentu firmy.

| Narzędzie | Wejście | Wyjście | Funkcja (ta sama co REST) |
| --- | --- | --- | --- |
| `zamowienia_lista` | `status[]`, `platnosc[]`, `kanal`, `konto`, `zlozone_od`, `zlozone_do`, `zmienione_od` (≤ 14 dni), `limit` 1–50 (20), `kursor` | `{ zamowienia: Zamowienie[], nastepny }` | `listChangedOrders` (`GET /api/v1/zamowienia`) |
| `zamowienie_szczegoly` | `numer` (sklep albo BL), `kanal`, `konto` | `{ zamowienia: Zamowienie[] }` (pusta = brak) | `ordersByNumber` (`GET /api/v1/zamowienia/<numer>`) |
| `stany` | `sku[]` (≤ 50) albo `kanal` + `konto` + `strona` | `{ pozycje, nieznaneSku?, strona?, nastepnaStrona? }` | `readStock` (`GET /api/v1/stany`) |
| `produkty_szukaj` | `fraza` (SKU, nazwa, EAN), `rodzaj[]`, `aktywne` (`tak`/`nie`/`wszystkie`), `kategoria` (id, ścieżka „A > B” z podkategoriami albo `brak`), `limit` 1–50, `kursor` | `{ produkty: Produkt[], nastepny }` | `searchProducts` (`GET /api/v1/produkty`) |
| `produkt_szczegoly` | `sku` | `{ produkt: ProduktSzczegoly \| null }` | `productBySku` (`GET /api/v1/produkty/<sku>`) |
| `statusy` | brak | `{ statusy[], platnosci[] }` (`symbol`, `nazwa`, `opis`) | `statusDictionary` (`GET /api/v1/statusy`) |
| `raport_dnia` | brak | `{ dzien, stanNa, sprzedaz, praca, wyslaneDzis }` | `dayReport` = pulpit „Dziś” (`GET /api/v1/raporty/dzien`) |
| `braki` | `sku[]`, `limit` 1–50 | `{ pozycje: [{ sku, nazwa, brakuje, dostepne, zamowien, zamowienia[] }], wiecej }` | `shortagesReport` (`GET /api/v1/raporty/braki`) |
| `rezerwacje` | `sku[]`, `limit` 1–50 | `{ pozycje: [{ sku, fizycznie, zarezerwowane, dostepne, zamowienia[] }], wiecej }` | `reservationsReport` (`GET /api/v1/raporty/rezerwacje`) |

`Zamowienie` = pola z `ORDER_FIELDS` (`lib/api/zamowienia.ts`): kanał, konto, numer, numer BL, status, przewoźnik,
sposób dostawy, płatność, metoda płatności, suma brutto, daty, numer nadania, pozycje (SKU, nazwa, ilość, cena) i
przesyłki (`SHIPMENT_FIELDS`: przewoźnik, numer, stan drogi paczki kodem i słownie, od kiedy, ostatni odczyt, czy stan
jest odświeżany, link śledzenia, rodzaj: główna albo dodatkowa przesyłka do tego samego zamówienia; bez opisów zdarzeń
przewoźnika i bez powodu dodatkowej przesyłki, szczegóły w `docs/api.md`). Zmiana stanu paczki nie
zmienia `zmieniono` zamówienia, więc `zamowienia_lista` oddaje przesyłki z chwili ostatniej zmiany zamówienia; aktualny
stan paczki daje `zamowienie_szczegoly` (tak mówi też opis tego narzędzia).
`Produkt` = `PRODUCT_FIELDS`, `ProduktSzczegoly` = `PRODUCT_DETAIL_FIELDS` (`lib/api/produkty.ts`). Numery zamówień
w `braki` i `rezerwacje`: najwyżej 20 na produkt.

Każdy opis narzędzia mówi, kiedy go użyć, i ma przykładowe pytanie użytkownika. Opisy i instrukcje serwera
(`SERVER_INSTRUCTIONS` w `lib/mcp/serwer.ts`) mówią modelowi wprost, że danych klientów nie ma.

### Błędy narzędzi

Błąd w wywołaniu narzędzia wraca jako wynik z `isError: true` i tekstem po polsku (model widzi powód i może poprawić
argumenty), nie jako błąd protokołu: zły argument (schemat albo walidacja `lib/api/*`), brak zakresu, limit. Błąd
protokołu tylko dla nieznanego narzędzia (`-32602`, `Unknown tool: …`) i złej postaci `params`. Wyjątek po stronie
serwera = „Błąd serwera Kompletora” bez szczegółów (w logu sama nazwa klasy błędu).

### Przycinanie wyników

Każda lista ma limit pozycji i kursor (`nastepny`). Wynik większy niż **40 000 znaków** JSON: narzędzie z argumentem
`limit` jest powtarzane z połową strony (kursor zostaje poprawny), a bez niego: błąd „Zawęź zapytanie”.

## Limity

- Wspólne z API v1: 120 żądań/min na klucz (`ApiLimiters`): przekroczenie = `429` z `Retry-After` i treścią JSON-RPC.
- **60 wywołań narzędzi na minutę na klucz** i **300 wywołań raportów** (`raport_dnia`, `braki`, `rezerwacje`) **na
  dobę na klucz** (`lib/mcp/limity.ts`). Przekroczenie = błąd narzędzia „Spróbuj ponownie za N s”, wpis `LIMIT`
  w dzienniku, nie `500`.
- Liczniki w pamięci procesu (jak API v1): przy kilku instancjach liczą się per instancja.

## Dziennik wywołań

Tabela `McpCall` (RLS po firmie): firma, źródło (`KLUCZ` / `PANEL`), `apiKeyId` albo `userId`, narzędzie, wynik
(`OK` / `ODMOWA` / `BLAD` / `LIMIT`), czas trwania, liczba pozycji, **nazwy** użytych parametrów, `createdAt`. **Bez
treści argumentów i wyników**: mogą nieść numery zamówień, SKU, frazy wpisane przez model. Indeks
`(organizationId, createdAt)`. Retencja **90 dni**: zadanie workera `mcp-sprzatanie` raz na dobę
(`lib/worker/harmonogram.ts`, handler w `lib/worker/zadania.ts`, `cleanupMcpCalls` w `lib/mcp/dziennik.ts`). Wywołania
poza narzędziami (`tools/list`, `initialize`) i nieznane narzędzia nie trafiają do dziennika. Ekran: Ustawienia →
Integracje i agenci AI → Agenci AI, „Ostatnie wywołania”.

## Czego serwer nie robi

- **Nie podaje danych osobowych** (decyzja z 03.11.2026: dane odbiorcy nie trafiają do AI bez osobnej decyzji):
  imion, nazwisk, adresów, telefonów, e-maili, NIP-u osoby fizycznej ani treści wiadomości od klientów. Wyniki są
  budowane pole po polu z jawnych list; bez `flags`, `cancelReason`, `pendingAction`, treści zdarzeń zamówienia
  (poza numerem nadania), treści alertów i notatek braków. Test: `tests/mcp.integration.test.ts` („brak danych
  osobowych”) wstawia fikcyjne dane do tych pól i sprawdza wynik każdego narzędzia.
- **Niczego nie zmienia** i nie wysyła do kanałów sprzedaży, przewoźników, wFirmy ani KSeF.
- Nie ma zasobów (`resources/*`), promptów, subskrypcji (`subscriptions/listen`), SSE ani zadań (`tasks`).

## Część B: narzędzia zapisu: kontrakt (osobne zadanie)

Przesyłki InPost/DPD i KSeF w trybie „przygotuj, nie wysyłaj” są już na `main` (68abbb9). Narzędzia zapisu
to osobne zadanie z tym kontraktem:

- Zakres **`mcp:zapis`** (nowy wpis w `lib/api/zakresy.ts` + migracja `ApiKey_scopes`), na ekranie osobnym polem,
  nigdy domyślnie zaznaczony, z ostrzeżeniem.
- `przesylka_przygotuj` (`zamowienia: numer[]`, `przewoznik?`): wyłącznie ścieżka „przygotuj, nie wysyłaj”
  (`lib/wysylka/*`, przygotowana przesyłka InPost/DPD), bez wywołania API przewoźnika.
- `faktura_przygotuj` (`zamowienie: numer`): FA(3) do KSeF w trybie „przygotuj” (`lib/ksef/*`, jak
  `app/(panel)/zamowienia/[id]/akcje-ksef.ts`) albo podgląd wFirmy; bez wysyłki do KSeF. Wyłączniki przesyłek i KSeF bez zmian.
- **Potwierdzenie dwukrokowe**: pierwsze wywołanie zwraca podgląd (co powstanie, dla jakich zamówień) i jednorazowy
  token (ważny 5 min, związany z kluczem i skrótem SHA-256 argumentów, w bazie tylko skrót tokenu); wykonanie dopiero
  narzędziem `potwierdz` z tym tokenem. Elicitation (MRTR, `InputRequiredResult`) może dojść, token zostaje główną
  drogą. `destructiveHint: true` dla `potwierdz`, `readOnlyHint: false` dla wszystkich trzech.
- Każde wykonanie: wpis `McpCall` i zdarzenie w historii zamówienia (ten sam zapis co panel) z oznaczeniem
  „agent AI, klucz <nazwa>”.
- Testy: bez tokenu nic się nie dzieje; token jednorazowy, wygasa, związany z kluczem; wymagany `mcp:zapis`;
  szpieg na adapterach przewoźników i KSeF = zero wywołań.

## Pomost stdio (self-host)

`npm run build:cli` buduje `dist/kompletor-mcp.cjs` (w obrazie Dockera razem z resztą `dist/`). Konfiguracja tylko
z env, argumenty linii komend są odrzucane (klucz nie trafia do listy procesów ani historii powłoki):

```bash
KOMPLETOR_URL=https://kompletor.example.invalid KOMPLETOR_API_KEY=kmp_PRZYKLADOWY_KLUCZ node dist/kompletor-mcp.cjs
```

Czyta wiadomości JSON-RPC z stdin (jedna na linię), każdą wysyła osobnym `POST` do `/api/mcp` z kluczem i właściwymi
nagłówkami (wersja z `_meta` albo zapamiętana z `initialize` na czas procesu) i wypisuje odpowiedź na stdout.
Bez dostępu do bazy: jedna ścieżka uwierzytelnienia, te same limity i dziennik. Na stderr same statusy, bez klucza.
Logika: `lib/mcp/pomost.ts`, komenda: `scripts/kompletor-mcp.ts`.

## Gdzie to jest w kodzie

- `lib/mcp/protokol.ts`: wersje, JSON-RPC, kody błędów, nagłówki (`=?base64?…?=`).
- `lib/mcp/http.ts`: transport: Origin, Accept, klucz, rozmiar, wersja i nagłówki; `app/api/mcp/route.ts`: trasa.
- `lib/mcp/serwer.ts`: metody (`tools/list`, `tools/call`, `server/discover`, `initialize`, `ping`), `callTool`.
- `lib/mcp/narzedzia.ts`: rejestr narzędzi; `lib/mcp/schemat.ts`: walidator JSON Schema narzędzi.
- `lib/mcp/kontekst.ts`: kontekst z klucza i z sesji panelu; `lib/mcp/limity.ts`; `lib/mcp/dziennik.ts`.
- `lib/mcp/konfiguracje.ts`: fragmenty konfiguracji klientów; `app/(panel)/ustawienia/agenci-ai/`: ekran.
- `lib/api/produkty.ts`, `lib/api/raporty.ts`, `lib/api/statusy.ts`: nowe odczyty (REST + MCP).
- Testy: `tests/mcp.integration.test.ts`, `tests/api-v1-odczyty.integration.test.ts`, `lib/mcp/mcp.test.ts`,
  `proxy.test.ts`, strażnik tras w `tests/panel-dostep.integration.test.ts`.
