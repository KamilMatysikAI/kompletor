# Kompletor

Kompletor to system zamówień i wysyłek dla sklepu internetowego, który sprzedaje w kilku kanałach naraz
(własny sklep WooCommerce, Allegro, Empik). Zbiera zamówienia z kanałów w jednym panelu, rezerwuje towar od chwili
złożenia zamówienia, pilnuje braków, prowadzi kolejkę pakowania z godzinami odbiorów kurierów i drukuje karty
zamówień. Jest pisany jako własny zamiennik BaseLinkera dla małej firmy, którą obsługuje kilka osób: właściciel,
biuro i magazyn.

Kod jest otwarty na licencji GNU AGPL 3.0 (plik `LICENSE`), prawa autorskie: ETIN Group Sp. z o.o.
Nazwy BaseLinker, Allegro, Empik, WooCommerce, wFirma, nazwy przewoźników i inne znaki towarowe należą do ich
właścicieli. Używamy ich tylko do wskazania, z czym Kompletor się łączy albo skąd przenosi dane; Kompletor nie jest
z nimi powiązany ani przez nie wspierany.

**Do sklepów nic nie wychodzi, dopóki tego nie włączysz.** Nowe konto kanału tylko czyta zamówienia („Tylko podgląd”)
i może pracować obok obecnego systemu (np. BaseLinkera), pokazując różnice. Stany, statusy i numery nadania wysyła
dopiero konto przełączone na „Aktywny” z włączonym zapisem; faktury, przesyłki i wystawianie ofert mają osobne
włączniki. Klienty źródeł tylko do odczytu w `lib/zrodla/` mają blokadę zapisu w kodzie. Co działa, co po włączeniu,
co tylko pokazuje i czego nie ma: [`docs/co-jeszcze-nie-dziala.md`](docs/co-jeszcze-nie-dziala.md).
**Dane klienta** (adres, telefon, e-mail, NIP) od 03.11 przechowujemy w bazie zaszyfrowane osobnym kluczem (`CUSTOMER_DATA_KEYS`), z wglądem wg uprawnień, dziennikiem podglądów i retencją (`DANE_KLIENTA_ZAPIS=1`) — `docs/dane-klienta.md`; odczyt na żądanie z kanału (`docs/dane-odbiorcy.md`) został jako „Odśwież z kanału” i zapas przesyłki i faktury.
**Zwroty i reklamacje** (`/zwroty`: zgłoszenie, odbiór paczki, zwroty z Allegro tylko do odczytu, bez zwrotu pieniędzy): `docs/zwroty-i-reklamacje.md`.

## Szybki start

Potrzebny jest Docker z Compose. Trzy kroki:

```
git clone <adres-repozytorium> kompletor && cd kompletor
docker compose up
```

Po zbudowaniu obrazu (pierwszy raz kilka minut) log kontenera `web` wypisze adres:

```
 Kompletor gotowy. Otwórz: http://localhost:3000/start?kod=<kod instalacji>
```

Otwórz go w przeglądarce. Kreator załaduje kod sam (z adresu) i założy Twoją firmę oraz pierwsze konto właściciela.
Przycisk „Najpierw zobacz demo” zamiast tego zakłada firmę „Sklep Demo” z danymi fikcyjnymi, a Ty zostajesz
jej właścicielem. Po założeniu pierwszego konta adres `/start` przestaje działać, a kolejne osoby dodaje się w
Ustawienia → Użytkownicy.

Nie trzeba zakładać kont u nas, podawać kluczy ani tworzyć pliku `.env`: hasła bazy, klucz szyfrowania i kod
instalacji powstają przy pierwszym starcie w wolumenie `sekrety`. Kod chroni kreator przed kimś, kto trafiłby na
adres przed Tobą.

Demo bez klikania: `KOMPLETOR_SEED=demo docker compose up` (konto `demo@kompletor.test`, hasło raz w logu kontenera
`web`, przy pierwszym logowaniu panel wymusza jego zmianę). Na każdym ekranie firmy demo jest pasek „Dane fikcyjne,
demo Kompletora”. Hasło zostaje w logu kontenera do jego usunięcia, więc demo nie wystawiaj na świat; firmy demo nie da
się dziś usunąć poleceniem, najprościej postawić instalację od nowa (`docker compose down -v`).

## Wymagania

- Docker z Compose v2 (Docker Desktop albo Docker Engine z wtyczką `compose`).
- Co najmniej 4 GB RAM do budowy obrazu: budowa panelu (Next.js) potrzebuje do 4 GB pamięci. Sama praca zajmuje
  ok. 0,3–0,5 GB (pomiar w `docs/instalacja.md`, „Wymagania sprzętowe”); na serwerze z 1–2 GB RAM uruchamiaj z nakładką
  `compose.lekki.yaml` (tryb lekki: mniejszy bufor Postgresa, sterta Node 256 MB, limity kontenerów).
- Około 4 GB wolnego dysku na budowę: obraz ma ok. 0,8 GB, pamięć podręczna budowy Dockera ok. 3 GB (można ją
  potem zwolnić: `docker builder prune`). Do tego baza, która rośnie z liczbą zamówień.
- Pierwsza budowa pobiera zależności npm i fonty, więc potrzebuje internetu.

## Co uruchamia `docker compose up`

| Usługa | Co robi |
|---|---|
| `sekrety` | jednorazowo zakłada pliki w wolumenie `sekrety`: hasło bazy, hasło roli aplikacji, klucz szyfrowania sekretów firm, kod instalacji; istniejących plików nigdy nie zmienia |
| `db` | Postgres 16; port nie jest wystawiony na zewnątrz |
| `web` | migracje bazy, panel na `http://localhost:3000` (tylko na tym komputerze, `127.0.0.1`) |
| `worker` | kolejka zadań: odczyt zamówień z kanałów, rezerwacje, raporty |

Plik `compose.yaml` jest plikiem produktu. `docker-compose.dev.yml` to sama baza do developmentu i testów (niżej); goły
`docker compose` jej nie widzi, `npm run db:up` / `db:down` podają ją jawnie przez `-f`.

Zmienne (w powłoce albo w pliku `.env` obok `compose.yaml`, wszystkie opcjonalne):

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `KOMPLETOR_PORT` | `3000` | port panelu na `127.0.0.1` |
| `KOMPLETOR_SEED` | puste | przy starcie zakłada firmę z presetu `seed/presety/<nazwa>.json` albo `prywatne/presety/<nazwa>.json` (zamontowany), albo `demo` |
| `KOMPLETOR_PRESET_PLIK` | puste | własny plik presetu w kontenerze (zamontowany), wygrywa z nazwą |
| `KOMPLETOR_NADPISANIA_KATALOG` | puste | katalog plików nadpisań ofert firm (`<id firmy>.csv`) w kontenerze (zamontowany) |
| `KOMPLETOR_COOKIE_SECURE` | `false` | `true` za reverse proxy z HTTPS |
| `KOMPLETOR_OBRAZ` | `kompletor:lokalny` | nazwa obrazu |
| `COMPOSE_FILE` | puste | `compose.yaml:compose.lekki.yaml` (na Windows `;`) = tryb lekki na stałe, także dla `scripts/aktualizuj.sh` |

Obraz zawsze budowany jest z repo (usługa `web` ma `build`; `sekrety` i `worker` używają tego samego obrazu), więc
`docker compose pull` i `up --no-build` na świeżej maszynie nie zadziałają.

## Polecenia w działającym kontenerze

```
docker compose exec web kompletor uzytkownik lista
docker compose exec web kompletor uzytkownik dodaj --email osoba@example.com --imie "Anna" --firma <slug> --rola BIURO
docker compose exec web kompletor uzytkownik haslo --email osoba@example.com     # nowe hasło, tylko na terminal
docker compose exec web kompletor org list
docker compose exec web kompletor org create --slug druga-firma --name "Druga firma"
docker compose exec -T web kompletor sekret --firma <slug> --ustaw BASELINKER_TOKEN --ze-stdin < token.txt
```

`kompletor` buduje adresy bazy z wolumenu sekretów tak samo jak start kontenera i woła CLI z `dist/` (opis
poleceń niżej, w części dla developerów).

## Kopie zapasowe

Dane są w trzech wolumenach i wszystkie trzeba kopiować razem:

- `pg_data`: baza (firmy, zamówienia, produkty, konta, zaszyfrowane klucze integracji). Kopia na działającej
  instalacji: `docker compose exec db pg_dump -U kompletor kompletor > kopia.sql`.
- `sekrety`: hasła bazy i klucz szyfrowania. Bez klucza zaszyfrowane klucze integracji (BaseLinker, wFirma, sklepy,
  Allegro, Empik) z kopii bazy są nie do odczytania i trzeba je wpisać od nowa. Klucz trzymaj osobno od kopii bazy.

- Zdjęcia produktów są w bazie, więc kopia bazy obejmuje zdjęcia, razem z archiwum usuniętych.
  Wolumen `zdjecia` (w kontenerze `/dane/zdjecia`, zmienna `ZDJECIA_DIR`) trzyma tylko pliki ze starszych wersji:
  start kontenera przenosi je do bazy (sekcja niżej) i zostawia na dysku. Zachowaj go do pierwszego startu nowej wersji.
  Logo firmy (Ustawienia → Dane firmy) też jest w bazie, w wolumenie leży tylko archiwum poprzednich wersji logo
  (`<firma>/firma/old/`). Kopia wolumenu: `docker run --rm -v kompletor_zdjecia:/z -v "$PWD":/k alpine tar czf /k/zdjecia.tgz -C /z .`.

Nazwy wolumenów w Dockerze mają przedrostek projektu: `kompletor_pg_data`, `kompletor_sekrety`, `kompletor_zdjecia`.
`docker compose down` zostawia wolumeny, `docker compose down -v` je kasuje (razem z danymi).

## Zdjęcia produktów w bazie

Bajty zdjęć (pełne do 1600 px, miniatura, wersja do wydruku) leżą w bazie, w tabeli `ProductImageData`. Panel i worker
w osobnych kontenerach (Coolify, Kubernetes, dwa hosty) widzą te same zdjęcia bez wspólnego katalogu, a kopia bazy
obejmuje zdjęcia. Zdjęcie usunięte z produktu zostaje w bazie jako archiwum (`archivedAt`), nic nie jest kasowane.

Zdjęcia ze starszych wersji (pliki w `ZDJECIA_DIR`) przenosi do bazy:

1. start każdego kontenera (web i worker): `node dist/org.cjs zdjecia-do-bazy --limit-s 60` w entrypoincie, potem
   worker kończy resztę w tle;
2. pierwszy odczyt zdjęcia w panelu, gdy plik jest w katalogu tego kontenera;
3. ręcznie: `docker compose exec web node dist/org.cjs zdjecia-do-bazy` (i to samo w `worker`, gdy ma własny
   katalog), lokalnie `npm run zdjecia:do-bazy`; `--firma <slug>` zawęża do jednej firmy.

Przeniesienie jest idempotentne (zdjęcie już w bazie jest pomijane) i nie rusza plików na dysku. Log startu podaje
liczby: przeniesione, „bez pliku w tym kontenerze” (plik ma drugi kontener i przeniesie go jego start) i błędy.
Zdjęcie bez bajtów w bazie i bez pliku w kontenerze panelu odpowiada `503` z opisem, nie cichym „nie znaleziono”.
Gdy log obu kontenerów nie pokazuje już zdjęć „bez pliku”, wolumen `zdjecia` można odłączyć (pliki zostaw jako kopię).

Rozmiar: zdjęcie zajmuje w bazie zwykle 50–400 KB (webp), czyli ok. 1 GB na 3 000–5 000 zdjęć. Tyle więcej waży kopia
bazy (`pg_dump`).

## Aktualizacja

```
sh scripts/aktualizuj.sh
```

Kopia bazy (`pg_dump -Fc` do `kopie/`, sprawdzona `pg_restore -l`) → `git pull --ff-only` → `docker compose build web` (stara
wersja działa w tym czasie) → `docker compose up -d` (migracje robi start kontenera `web`) → czekanie na `/api/health` bez
zaległych migracji. Błąd = stop z instrukcją powrotu; bazy skrypt sam nie cofa. Ręcznie: kopia bazy, `git pull`,
`docker compose up -d --build`.

## Diagnostyka

`sh scripts/diagnostyka.sh > diagnostyka.txt`: wersja, `/api/health`, kontenery, pamięć, migracje, miejsce na dysku,
kolejka `Job` i ostatnie błędy z logów. Tylko odczyt, bez sekretów i zmiennych środowiska kontenerów, błędy przez filtr
zakrywający e-maile, telefony, tokeny i hasła w adresach.

## Zależności

Wersje w `package.json` (także `agent-druku/`) są przypięte dokładnie, bez `^` i `~`; `.npmrc` ma `save-exact=true`, a test
`lib/instalacja/lekka-instalacja.test.ts` pilnuje zgodności z `package-lock.json`. Nowe wersje przychodzą wyłącznie przez
PR Dependabota (`.github/dependabot.yml`, co tydzień; drobne aktualizacje w jednym PR, główne wersje osobno) i pełne CI.

## Wystawienie na świat

Domyślnie panel słucha tylko na `127.0.0.1`. Udostępnienie go innym komputerom to świadoma decyzja: postaw przed
nim reverse proxy z HTTPS (np. Caddy, Traefik, nginx) na tym samym serwerze, przekieruj ruch na
`127.0.0.1:${KOMPLETOR_PORT}` i ustaw `KOMPLETOR_COOKIE_SECURE=true` (ciasteczko sesji tylko po https). Bez HTTPS nie
wystawiaj panelu: pokazuje dane zamówień klientów. Proxy powinno dopisywać adres klienta na końcu `X-Forwarded-For`
(limit prób logowania liczy się per adres).

## Dokumentacja

Spis dokumentów dla użytkownika: [`docs/README.md`](docs/README.md). Zasady wkładu: [`CONTRIBUTING.md`](CONTRIBUTING.md),
zgłaszanie podatności: [`SECURITY.md`](SECURITY.md).

---

# Dla developerów

## Stack

Next.js 16 (panel, `app/`) + Prisma 7 / Postgres 16 + osobny proces worker (`worker/`, kolejka `Job`
w Postgresie z `FOR UPDATE SKIP LOCKED`) + vitest.

```
app/                 panel Kompletor (logowanie, ekrany tylko do odczytu) + /api/health (lib/zdrowie.ts); proxy.ts – Basic Auth (staging), potem bez sesji nic
lib/zrodla/          klienty tylko-do-odczytu: baselinker.ts, wfirma.ts, mirakl.ts (+ http.ts: limit tempa, ponawianie)
lib/import/          import katalogu: normalizacja → mapowanie (czyste) → zapis (baza) → raport (md + CSV)
lib/worker/          kolejka zadań, rejestr handlerów, pętla per firma (petla.ts)
lib/db.ts            klienci bazy: firmy (RLS, rola LOGIN) i systemowy; krok instalacji roli aplikacji
lib/organizacje.ts   firmy, preset konfiguracji, konfiguracja importu z bazy
lib/sekrety.ts       sekrety integracji per firma (AES-256-GCM)
lib/auth/            konta, sesje, role; lib/panel/ – odczyty i formatowanie ekranów
worker/index.ts      proces workera
scripts/             import-katalogu.ts, org.ts (firmy), sekret.ts (klucze firm) – CLI
seed/presety/        presety firm jako JSON (konta kanałów, magazyn, reguły przewoźników, odbiory, strefy) – bez sekretów
lib/instalacja/      sekrety pierwszego uruchomienia, kreator /start, firma demo
prisma/              schema.prisma + migracje
packages/*           miejsce na pakiety (np. packages/rdzen-stanow) – workspaces npm
tests/               testy integracyjne (baza *_test), fixtury bez danych prawdziwych klientów
```

## Uruchomienie lokalne

```
npm ci
cp .env.example .env          # uzupełnij lokalny URL bazy; klucze tylko jeśli potrzebne
npm run db:up                 # Postgres w Dockerze na 127.0.0.1:55433 (bazy: logistyka, _shadow, _test)
npx prisma migrate deploy
npm run rola:aplikacji        # rola LOGIN klienta firmy z hasłem z APP_DATABASE_URL
npm run org:seed -- przyklad   # albo: npm run org:create -- --slug moja-firma --name "Moja firma"
npm run demo:panel -- --tak    # opcjonalnie firma demo z danymi fikcyjnymi
npm run dev                   # panel: http://localhost:3100, zdrowie: /api/health
npm run worker                # osobny proces
```

Testy (przed każdym oddaniem pełny przebieg): `npm run test:all` = `tsc --noEmit --incremental false` +
testy jednostkowe + integracyjne na bazie `TEST_DATABASE_URL` (musi kończyć się na `_test`; schemat jest
zakładany od zera przy każdym przebiegu).

## Jedna firma (self-host) vs wiele firm (hosting) –

Ten sam kod, ta sama baza i te same migracje. Różni je tylko `APP_MODE` i to, gdzie leżą klucze integracji.

| | Self-host (`APP_MODE=self-host`, domyślnie) | Hosting (`APP_MODE=hosted`) |
|---|---|---|
| Firmy w bazie | jedna (albo kilka, wtedy `SELFHOST_ORG_SLUG` wskazuje tę z kluczami w env) | wiele |
| Klucze API (BL, wFirma, Empik…) | sekrety firmy w bazie **albo** `.env` (fallback tylko dla jedynej / wskazanej firmy) | wyłącznie sekrety firmy w bazie; env serwera nigdy nie jest używany jako klucz firmy |
| Panel | logowanie, jedna firma | logowanie, przełącznik firmy dla osób w kilku firmach |
| Worker | jeden proces, zadania wszystkich firm | to samo |

**Izolacja firm robi Postgres, nie kod aplikacji.** Każda tabela danych ma `organizationId` i politykę Row Level
Security. Klient firmy (`createOrgClient` w `lib/db.ts`) pracuje jako rola `logistyka_app` z ustawieniem sesji
`app.org_id` = id firmy, więc każde zapytanie – także surowe SQL i transakcje – widzi i zapisuje tylko jej wiersze, a
`organizationId` przy zapisie wypełnia baza. Zapytanie bez firmy nie widzi niczego, a zapis bez firmy się nie udaje.
Klient systemowy (`createSystemClient`, właściciel tabel, omija RLS) jest tylko dla kodu systemowego: worker (kolejka
wszystkich firm), zakładanie firm, CLI, health; lista dozwolonych plików jest w teście
`tests/organizacje-izolacja.integration.test.ts`. Unikalności (SKU, oferty, numery zamówień, klucze deduplikacji) są
w obrębie firmy. **Granica zaufania:** każde surowe SQL w kodzie aplikacji musi
być szablonem `$queryRaw` bez `set_config`, `SET [LOCAL] app.org_id`, `SET [LOCAL|SESSION] ROLE`, `RESET`,
`SET SESSION AUTHORIZATION` i `DISCARD` (pilnuje test-strażnik), kod spoza rdzenia (adaptery) nie dostaje `$executeRaw`,
a sterownik `pg` importuje tylko `lib/db.ts` (strażnik). Z rolą LOGIN (niżej) `SET app.org_id` / `set_config` to jedyna
droga obejścia: zmienia firmę, nie rolę – bez superusera, bez DDL i bez wyłączenia RLS.
**Poolery (PgBouncer, Supabase/Neon):** parametr `options` musi dojść do Postgresa – pooler, który go gubi
(`ignore_startup_parameters=options`, tryb transakcji), daje odmowę połączenia: każde nowe połączenie puli klienta firmy
jest sprawdzane (rola i `session_user`, firma w sesji) przed pierwszym zapytaniem (hak `onConnect` puli w `lib/db.ts`).
Rola `logistyka_app` powstaje w migracji `00000000000000_baza`; właściciel bazy musi mieć
prawo ją założyć (superuser albo CREATEROLE – tak jest w Postgresie z Coolify i z `docker-compose.dev.yml`). RLS jest
`ENABLE`, nie `FORCE`: właściciel (migracje) widzi wszystko, więc przyszłe migracje danych nie muszą ustawiać firmy.

### Rola aplikacji (LOGIN) –

Klient firmy loguje się własną rolą: `APP_DATABASE_URL=postgresql://logistyka_app:<hasło>@<host>:<port>/<baza>` (ta
sama baza co `DATABASE_URL`), z parametrem sesji tylko `app.org_id`. `SET ROLE NONE` zostawia wtedy `logistyka_app`, a
`SET SESSION AUTHORIZATION` / `SET ROLE <właściciel>` dają odmowę (test „W1: granica zaufania”). Połączenie, w którym
`session_user` nie jest `logistyka_app` (np. `APP_DATABASE_URL` z właścicielem), albo rola aplikacji należy do innej
roli, jest odrzucane przed pierwszym zapytaniem.

- **Hasło to sekret, nie migracja.** Wygeneruj je (`openssl rand -hex 32`; min. 16 znaków, tylko ASCII) i wpisz tylko w
  `APP_DATABASE_URL` (Coolify: zmienna web i workera, jak `DATABASE_URL`). Krok instalacji `npm run rola:aplikacji`
  (w obrazie: `node dist/org.cjs rola-aplikacji`, robi go sam `docker/entrypoint.sh` po `prisma migrate deploy`) jest
  idempotentny: gdy logowanie działa – nic; inaczej właściciel z `DATABASE_URL` robi `ALTER ROLE logistyka_app LOGIN
  PASSWORD` z weryfikatorem SCRAM-SHA-256 liczonym w Node (do bazy i logu poleceń nie trafia hasło). Przed tym sprawdza,
  że rola nie jest superuserem, nie ma BYPASSRLS i nie należy do innych ról, a po nim, że `APP_DATABASE_URL` i
  `DATABASE_URL` to ta sama baza na tym samym serwerze – inaczej kontener nie startuje.
- **Hasło ustawia tylko web.** Kontener workera robi `rola-aplikacji --sprawdz`: samo logowanie, bez zmiany hasła
  (czeka do 90 s na web przy pierwszym wdrożeniu). Inna wartość `APP_DATABASE_URL` w workerze niż w web = worker nie
  startuje z komunikatem, a `/api/health` web (logowanie rolą aplikacji) zwraca 503 przy haśle, które nie pasuje.
- **Rotacja:** nowa wartość `APP_DATABASE_URL` w **obu** aplikacjach, potem wdrożenie web (ustawia hasło), potem
  worker. Otwarte połączenia ze starym hasłem dożywają, ale **nowe** połączenia starych kontenerów (jeszcze
  obsługujących ruch do przełączenia, sekundy–minuty w Coolify) padają – rotację rób w oknie niskiego ruchu.
  Gdy nowe wdrożenie web padnie **po** zmianie hasła (stary kontener zostaje z rolą, do której jego
  `APP_DATABASE_URL` już nie pasuje, `/api/health` pokazuje `appRole: error`): ponowny deploy web ze starą wartością
  `APP_DATABASE_URL` (przywraca stare hasło) albo szybki deploy poprawionego nowego.
- **Hosting (`APP_MODE=hosted`) wymaga `APP_DATABASE_URL`:** bez niej kontener nie startuje, a `createOrgClient` odmawia.
- **Self-host** może zostać przy starym trybie (pusta `APP_DATABASE_URL`): klient firmy łączy się adresem właściciela z
  `-c role=logistyka_app`, izolacja RLS jest ta sama, ale `SET ROLE NONE` w sesji wraca do właściciela – obrony pilnuje
  tylko strażnik kodu. Proces i kontener wypisują ostrzeżenie.
- **pg_hba / pooler:** rola musi móc się zalogować hasłem (domyślne `scram-sha-256` w obrazie `postgres:16`); pooler z
  własną listą użytkowników (PgBouncer `auth_file`) musi znać `logistyka_app`.
- Lokalnie (`docker-compose.dev.yml`) hasło `logistyka_app_local` jak w `.env.example`; testy integracyjne ustawiają je
  same (rola jest wspólna dla serwera: gdy lokalne `APP_DATABASE_URL` wskazuje ten sam host i port, testy biorą jego
  hasło; inne: `TEST_APP_DATABASE_URL`). To hasło z repo jest odrzucane poza 127.0.0.1/localhost, a testy na serwerze
  spoza loopback wymagają świadomie podanego `TEST_APP_DATABASE_URL` (zmieniają hasło roli na całym serwerze).

**Migracja istniejącej bazy:** przed `prisma migrate deploy` z `00000000000000_baza` zrób kopię (`pg_dump`) – zmiana
typu `Channel`, zdrowie kanału per konto i usunięcie `ReservationPolicy.id` są nieodwracalne. Historia wysyłek stanów
sprzed tej migracji, której oferty już nie ma, ma konto `?` (`ChannelPushLog`).

**Konfiguracja firmy jest w bazie, nie w kodzie:** konta kanałów (`ChannelConfig`: typ kanału + konto, np. trzy
sklepy Woo to trzy konta kanału `WOO`, z `blStorageId` dla importu z BL), magazyn (`Warehouse.wfirmaWarehouseId`),
reguły przewoźników (`CarrierRule`: metoda dostawy → przewoźnik i moduł wysyłki, pierwsza pasująca), sezon i okresy
rezerwacji (`ReservationPolicy`, jeden wiersz na firmę), ustawienia (`Organization.settings`, np. inventory BL).
Preset firmy to plik JSON (`seed/presety/<nazwa>.json` albo prywatna nakładka poza repo `prywatne/presety/<nazwa>.json`,
docs/instalacja.md „Własny preset firmy”; wzór: `seed/presety/przyklad.json`): `npm run org:seed --
<nazwa>` albo `--plik <ścieżka>`, w obrazie `KOMPLETOR_SEED=<nazwa>` (albo `KOMPLETOR_PRESET_PLIK`) – idempotentnie, niczego
nie nadpisuje; ustawienia kont dopisuje tylko do pustych kluczy `config`. Nowa firma: `npm run org:create`
dostaje magazyn „glowny”, domyślne okresy rezerwacji i startowe reguły przewoźników (rozpoznanie po nazwie metody
dostawy, moduł wysyłki do wybrania).

**Klucz adaptera jako tekst**: `ChannelConfig.adapterKey` (np. `woo.rest.v1`, `allegro.v1`, `mirakl.empik.v1`) i `CarrierRule.adapterKey`
(np. `basecourier.v1`), obok `config` (Json, ustawienia bez sekretów). Enumy `Channel`/`Carrier`/`ShippingModule` zostają
jako rodzina dla logiki rdzenia; nowy adapter = nowy klucz w konfiguracji, bez migracji rdzenia (`lib/adaptery.ts`:
format klucza i domyślne klucze rodzin). Sam kontrakt adaptera (port, zdolności, wyniki zapisu, manifest) – osobne zadanie.

**AI jako integracja**: konto rodziny `AI` w `ChannelConfig`
(`adapterKey` np. `ai.anthropic.v1`, `config`: model, limity), klucz `AI_API_KEY` jako sekret konta AI. Kolejność
(`lib/ai.ts`): klucz firmy → w hostingu nasz `PLATFORM_AI_API_KEY` z env, rozliczany z salda firmy → w self-hoście env
`AI_API_KEY`. Zużycie zapisuje tabela `AiUsage` (firma, funkcja, model, tokeny, koszt w groszach) – bez funkcji AI,
bez wywołań API i bez naliczania.

**Sekrety per firma:** `IntegrationSecret`, szyfrowane AES-256-GCM kluczem `APP_ENCRYPTION_KEY` z env (32 bajty,
`openssl rand -hex 32`), AAD = firma + konto + nazwa (szyfrogramu nie da się przenieść do innej firmy ani konta). Sekret jest całej firmy
(BL, wFirma) albo konta kanału (`--konto WOO/sklep1`: dwa sklepy Woo albo dwa konta Allegro mają osobne klucze;
sekret konta wskazuje `ChannelConfig`, fallback na env działa tylko dla sekretów firmy). Wartości nie
wychodzą w logach, błędach ani w liście (`listSecrets` zwraca nazwy i daty). Ustawianie bez wpisywania wartości w
wiersz poleceń: `npm run sekret -- --firma moja-firma --ustaw BASELINKER_TOKEN --z-env BASELINKER_TOKEN` (albo `--ze-stdin`),
lista: `--lista` (z wersją klucza każdego wpisu). Utrata klucza głównego = sekrety firm do wpisania od nowa (klucz trzymać
poza bazą i backupem bazy).

**Rotacja klucza głównego.** Klucze po wersjach: `APP_ENCRYPTION_KEYS=2:<hex>,1:<hex>` (najnowsza
pierwsza). Zapis zawsze najnowszą wersją (`IntegrationSecret.keyVersion`), odczyt kluczem wersji wpisu. Sam
`APP_ENCRYPTION_KEY` to wersja 1 (instalacje sprzed rotacji działają bez zmian); obok `APP_ENCRYPTION_KEYS` może zostać
tylko równy kluczowi `1:` – inny albo bez `1:` na liście = błąd startu sekretów. **Wyciek klucza ≠ utrata**: klucz
wciąż mamy, więc nikt nie wpisuje sekretów od nowa – przeszyfrowujemy je nowym kluczem i stary wyrzucamy:

1. Nowy klucz: `openssl rand -hex 32`. W Coolify (web **i** worker) `APP_ENCRYPTION_KEYS=2:<nowy>,1:<stary>`,
   `APP_ENCRYPTION_KEY` bez zmian (= stary); redeploy obu. Od teraz każdy zapis idzie kluczem v2, stare wpisy czytają się v1.
   Po redeployu `GET /api/health` → `secretsKey: ok` (zły zestaw kluczy = `error` i 503, a worker nie wstaje i wypisuje
   przyczynę w logu startu, bez materiału klucza).
2. `node dist/sekret.cjs --wszystkie-firmy --przeszyfruj` (lokalnie `npm run sekret -- --wszystkie-firmy --przeszyfruj`,
   jedna firma: `--firma <slug> --przeszyfruj`) z tym samym env. Firmy po kolei, każda swoim klientem (RLS); w firmie
   najpierw odszyfrowanie wszystkich starszych wpisów – jeden nieczytelny = błąd tej firmy i nic w niej nie zapisane.
   Kod 0 i „stare wersje można usunąć z env” dopiero, gdy w żadnej firmie nie został wpis starszym kluczem; inaczej
   poprawić przyczynę i uruchomić ponownie (przebieg jest powtarzalny). Kontrola: `--firma <slug> --lista` → same `v2`.
3. Z env znika stary klucz: `APP_ENCRYPTION_KEYS=2:<nowy>`, `APP_ENCRYPTION_KEY` usunięty; redeploy web i workera.
   Po redeployu znów `/api/health` → `secretsKey: ok` (zapomniany `APP_ENCRYPTION_KEY` obok `2:` = `error`; zostawiony
   **sam** stary `APP_ENCRYPTION_KEY` zamiast `APP_ENCRYPTION_KEYS` też `error`, bo health i start workera porównują
   wersje wpisów w bazie z kluczami z env; w obu przypadkach worker nie wstaje).
   Stary klucz usunąć też z menedżera haseł / kopii kluczy (nie z bazy – tam go nigdy nie było).
4. Kopie zapasowe bazy sprzed przeszyfrowania dalej otwiera stary klucz: kto ma kopię i stary klucz, ma sekrety. Po
   wycieku zatem także zmiana samych kluczy API u dostawców (BL, wFirma, Woo, Allegro…) i usunięcie starych kopii
   zgodnie z retencją – rotacja klucza głównego chroni bazę od teraz, nie przeszłe kopie.

Planowa rotacja (bez wycieku) to te same kroki 1–3. Kolejna: `3:<nowszy>,2:<obecny>`, potem `--przeszyfruj` i samo `3:`.
**Numer wersji nigdy nie wraca:** nowy klucz = kolejny numer, także po nieudanej rotacji (inny materiał pod starym
numerem = wpisy tej wersji nieczytelne, a gdy to wersja najnowsza, `--przeszyfruj` ich nie zobaczy i zgłosi 0).
`--przeszyfruj` uruchamia się osobno (z `--ustaw` / `--usun` / `--lista` = odmowa). Bez `APP_ENCRYPTION_KEY` i
`APP_ENCRYPTION_KEYS` self-host działa na kluczach źródeł z env (`secretsKey: none`) – tylko gdy w bazie nie ma żadnego
wpisu sekretu (inaczej `error`); w hostingu brak klucza = `error`.

**Worker:** jedna kolejka `Job` dla wszystkich firm (zadanie niesie `organizationId`), handler dostaje klienta swojej
firmy. Harmonogram zakłada zadania okresowe per firma; błąd jednej firmy (wyjątek, zła konfiguracja, brak klucza)
kończy się błędem jej zadania (`Job.lastError`), pozostałe firmy idą dalej. Firma wyłączona (`Organization.active`)
nie dostaje zadań. Kolejka nie ma jeszcze sprawiedliwego przydziału między firmami (kolejność po `runAfter`) –
do rozważenia przy hostingu z wieloma dużymi firmami.

**Kanały i wysyłka stanów** liczone per konto kanału (limity Empiku i paczek Woo/Allegro na konto, zdrowie kanału
i alert „kanał niedostępny” per konto).

## Panel: logowanie, role, ekrany

Panel nazywa się **Kompletor**. Bez sesji nie pokazuje nic (dane zamówień): `proxy.ts` odsyła żądanie bez ciasteczka
na `/logowanie` (API: 401), a każdy ekran i akcja zaczyna od `requireSession()` / `requirePermission()`
(`lib/panel/kontekst.ts`), które dają ekranowi wyłącznie klienta bazy firmy z sesji (RLS). Odczyty ekranów są
w `lib/panel/dane.ts` i odmawiają klienta systemowego. Strażnik: `tests/panel-dostep.integration.test.ts`.

**Konta i sesje** (`lib/auth/`): konto (`User`) jest wspólne dla instalacji, przynależność do firmy z rolą w
`Membership` (pod RLS firmy; rola aplikacji tylko czyta). `User` i `Session` są poza zasięgiem roli aplikacji
(REVOKE + polityka RLS „nikt”), obsługuje je tylko `lib/auth/sesje.ts` przez klienta systemowego. Hasła argon2id,
token sesji losowy (ciasteczko httpOnly, SameSite=Lax, Secure w produkcji; `COOKIE_SECURE=false` tylko do testu po
http), w bazie tylko jego SHA-256. Sesja wygasa po 12 h bezczynności albo 7 dniach; 5 błędnych haseł = blokada 15 min.
Limit prób logowania: 20 na 60 s per IP, IP z ostatniego wpisu `X-Forwarded-For` (dopisuje go Traefik w Coolify).
Za dodatkowym proxy (np. Cloudflare z pomarańczową chmurką) ostatni wpis to krawędź proxy, więc wszyscy wpadają do
jednego kubełka; bez proxy i bez nagłówków kubełek „nieznany”. W produkcji ciasteczko ma nazwę `__Host-kompletor_sesja`
i przeglądarka przyjmie je tylko po https (produkcja po samym http = pętla logowania); `COOKIE_SECURE=false` zmienia
też nazwę na `kompletor_sesja`.

**Role** (`lib/auth/uprawnienia.ts`): Właściciel (wszystko), Biuro (podgląd + rozjazdy), Magazyn (podgląd); osobie
można dołożyć pojedyncze uprawnienia (np. `zamowienia.anuluj_po_fakturze`). Hosting: jedna osoba w kilku firmach,
przełącznik firmy w menu (tylko na firmy, do których należy).

```
npm run uzytkownik -- dodaj --email wlasciciel@example.com --imie "Anna" --firma moja-firma --rola WLASCICIEL
npm run uzytkownik -- dodaj --email biuro@example.com --imie "Jan" --firma moja-firma --rola BIURO \
     --uprawnienia zamowienia.anuluj_po_fakturze,zamowienia.oznacz_oplacone,zwroty.pieniadze,produkty.zatwierdzanie
npm run uzytkownik -- haslo --email osoba@firma.pl     # nowe hasło (tylko na terminal), wylogowuje wszędzie
npm run uzytkownik -- lista | odbierz | dostep | sprzataj
npm run demo:panel -- --tak                             # firma „Sklep Demo” (zmyślone dane, nigdy w hostingu)
```

W panelu: `/ustawienia/uzytkownicy` (uprawnienie `uzytkownicy`: osoby tej firmy, rola, dodatkowe uprawnienia, dodanie
osoby z hasłem startowym pokazanym raz, wyłączenie dostępu) i `/ustawienia/haslo` (zmiana własnego hasła, kończy pozostałe sesje).
Zapomniane hasło: tylko CLI (`haslo`). Rolę właściciela nadaje i odbiera, a właściciela wyłącza i włącza, tylko właściciel; komplet
uprawnień tego nie daje. Ponowne włączenie dostępu liczy się jak nadanie zapisanych uprawnień: Biuro nie włączy z powrotem osoby z
uprawnieniem, którego samo nie ma (także Magazynu, bo ma `pakowanie.stanowisko`). Błędne obecne hasło przy zmianie liczy się do blokady
konta jak przy logowaniu, a zmiana hasła zostawia wpis w AuditLog. W hostingu `dodaj` z panelu nie dołącza konta związanego z inną firmą
(do czasu zaproszeń e-mailem); CLI i self-host bez tej bramki.

Ekrany (tylko odczyt): `/pulpit`, `/zamowienia` (+ szczegóły), `/produkty` (+ szczegóły z równaniem stanu),
`/braki`, `/rozjazdy` (przycisk na pulpicie; pusty stan do czasu). Wygląd 1:1 z makiet
(`app/panel.css`). Lokalizacja z importu BL (`Stock.location`). Brakuje jeszcze zdjęć produktów (F2b) – w panelu
zaślepka z inicjałami.

**Dodaj produkt i produkty bez stanu**: Produkty i stany → „Dodaj produkt” (`/produkty/nowy`: samo SKU, reszta
z wFirmy, odczyt w workerze) i „Produkty bez stanu” (`/produkty/bez-stanu`: lista `noStock` firmy). Uprawnienie
`produkty.dodawanie`. Opis dla użytkownika: [`docs/produkty.md`](docs/produkty.md).

## Obraz Dockera i deploy (Coolify) –

Jeden obraz (`Dockerfile`, multi-stage: zależności → `next build` standalone + bundel esbuild workera i CLI →
izolowany migrator Prismy → runtime `node:22-alpine` jako użytkownik `app`), dwie role wybierane zmienną
`KOMPLETOR_ROLA`:

| Rola | Co startuje | Healthcheck kontenera (`docker/healthcheck.sh`) |
|---|---|---|
| `web` (domyślnie) | `prisma migrate deploy`, opcjonalnie seed firmy (`KOMPLETOR_SEED=<preset>` albo `demo`, idempotentny), adres `/start` na świeżej instalacji, panel `node server.js` na porcie 3000 | `GET http://127.0.0.1:3000/api/health` = 200 |
| `worker` | `prisma migrate deploy`, `node dist/worker.cjs` (kolejka `Job`, harmonogram rdzenia) | plik życia `WORKER_HEARTBEAT_FILE` młodszy niż 180 s (worker pisze go co 30 s) |

Worker pisze plik życia tylko, gdy jego pętla zadań przeszła obrót w ciągu 2 h (`worker/zycie.ts`; zawieszona pętla =
kontener `unhealthy`); gdy platforma zastępuje healthcheck kontenera własnym, śladem pracy workera jest
`queue.lastActivity` w `/api/health` kontenera web.

Migracje robią obie role (Prisma trzyma blokadę doradczą, więc dwa kontenery naraz się nie zderzą; blokada czeka
tylko 10 s, więc przy jej limicie `docker/entrypoint.sh` ponawia `migrate deploy` do 3 razy co 10 s, a każdy inny błąd
kończy start od razu); nieudana migracja = kontener nie startuje na starym schemacie. Przy wdrożeniu kroczącym nowy
web migruje, a stary worker chwilę pracuje na nowym schemacie, więc migracje muszą być zgodne wstecz (expand/contract:
najpierw dodać, usuwać dopiero w kolejnym wdrożeniu).

**Po nieudanej migracji** (`migrations.failed: 1` w health, w logu kontenera błąd Prismy z nazwą migracji): `migrate
deploy` odmawia, dopóki migracja wisi jako rozpoczęta. Z logu ustal, co z niej zdążyło się wykonać, i cofnij to ręcznie
w bazie (albo dokończ), potem oznacz ją jako wycofaną: nowy kontener nie wstaje, więc w jednorazowym z tego samego obrazu
(`docker run --rm --network coolify -e DATABASE_URL='<adres bazy z Coolify>' --entrypoint sh <obraz> -c '…'`, tu entrypoint jest pominięty): `cd /opt/migrate && node
node_modules/prisma/build/index.js migrate resolve --rolled-back <nazwa_migracji>` (lokalnie `npx prisma migrate
resolve --rolled-back <nazwa_migracji>`). Następny start (redeploy) zastosuje ją od nowa; poprawioną migrację wdraża
się nowym commitem. Gdy zmiany z migracji są już w bazie w całości, zamiast tego `--applied <nazwa_migracji>`.

Po migracji, gdy jest `APP_DATABASE_URL`, obie role ustawiają
rolę aplikacji (`node dist/org.cjs rola-aplikacji`, idempotentnie; błąd = kontener nie startuje). Bundel buduje `scripts/build-cli.mjs` (CJS; `import.meta`
dozwolone tylko w `lib/import/nadpisania.ts`, każde inne = błąd builda), a `dane/` jedzie do obrazu. W obrazie są też CLI jako bundle: `node dist/org.cjs list`,
`node dist/sekret.cjs --firma <slug> --lista`, `node dist/import-katalogu.cjs …`, `node dist/uzytkownik.cjs lista` (konta panelu, opis
w `scripts/uzytkownik.ts`; hasło startowe tylko na terminal albo do pliku poza repo), `node dist/cien.cjs konfiguruj | test | raport …`
(narzędzia cienia). Seed przy starcie (`KOMPLETOR_SEED=<preset>`) uzupełnia też puste ustawienia kont kanałów
(`baseUrl`, `envPrefix`), więc konta nie wymagają ręcznego `konfiguruj`.

**Zmienne (bez wartości):** `DATABASE_URL`, `APP_DATABASE_URL` (rola LOGIN `logistyka_app`, web i worker; hosting:
obowiązkowa – „Rola aplikacji” wyżej), `APP_ENCRYPTION_KEY` albo po rotacji `APP_ENCRYPTION_KEYS` (te same na web i workerze, kopia poza bazą),
`APP_MODE`, `SELFHOST_ORG_SLUG`, `CIEN_ODCZYT` (ta sama wartość na web i workerze: web liczy z niej pole `cien` w health), `KOMPLETOR_ROLA`, `KOMPLETOR_SEED` i `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` (tylko web), `BUILD_SHA` (w Coolify
`$SOURCE_COMMIT`, build + runtime; widoczny w `/api/health`), klucze źródeł tylko na workerze (panel ich nie
potrzebuje). Import katalogu w workerze włącza `KATALOG_IMPORT_CO_GODZIN` (puste = wyłączony; pierwszy przebieg
zaraz po starcie), a `KATALOG_IMPORT_DNI_SPRZEDAZY` (puste = `0`) to **sufit** okna sprzedaży do raportu
mapowania: **`0` = bez odczytu zamówień BL, czyli bez danych klientów w procesie**. Sufit egzekwuje handler zadania
`import-katalogu` (każde zadanie, także ręczne `enqueue` bez payloadu, jest przycinane – `lib/import/okno-sprzedazy.ts`)
i CLI (`--dni` domyślnie = sufit, więcej = błąd). Tak ma zostać na serwerze do czasu logowania w panelu; lokalnie,
gdy raport ma liczyć sprzedaż, ustaw np. `KATALOG_IMPORT_DNI_SPRZEDAZY=90`. Pozostałe: `BASIC_AUTH_DISABLED`
(niżej), `RAPORTY_DIR` (w obrazie `/tmp/kompletor-raporty`, zapisywalny dla `app`), `WORKER_LOG_DONE=1` (worker
loguje też udane zadania rdzenia).

**`/api/health`:** `status` (`ok` / `degraded` przy migracjach do zrobienia albo nieudanych albo gdy cień nie czyta /
`error` = brak bazy, rola aplikacji się nie loguje albo zły zestaw kluczy sekretów, wtedy HTTP 503), `ok` (= `status`
to `ok`), `version`, `sha`, `appMode`, `appRole` (`ok` / `error` / `off` bez `APP_DATABASE_URL`), `migrations` (`last`,
`pending`, `failed`), `secretsKey`, `queue` (`lastActivity` = ostatnia zmiana w kolejce zadań, czyli ślad pracy workera;
`failedLastHour`), `cien` (`enabled`, `status` `ok` / `degraded` / `off`, `accounts`, `notReading`,
`openAlerts`). Bez danych firm; lista kont (`cien.details`: firma, konto, powód, `lastOkAt`, `lastError`) tylko z poprawnym
hasłem Basic Auth włączonej bramki albo tokenem `HEALTH_TOKEN`. **W `APP_MODE=hosted` bez autoryzacji**
odpowiedź zawiera tylko `ok`, `status`, `sha`, `appMode`, `db`, `appRole`, `secretsKey`, `migrations` (`pending`,
`failed`) i `time`; pełną daje Basic Auth albo `Authorization: Bearer <HEALTH_TOKEN>` (bez zmiennej pełnej nie ma).
Self-host bez zmian. **`degraded` zostaje na HTTP 200** (wybór z 26.10): healthcheck kontenera web patrzy na
kod HTTP, a awaria kanału nie może restartować ani cofać panelu – monitoring i skrypt deployu czytają `status` / `ok`.
Konto „nie czyta” (`lib/cien/stan-odczytu.ts`): włączone konto z adapterem odczytu zamówień, gdy `CIEN_ODCZYT` ≠ 0, bez
pełnego udanego odczytu (`lastOkAt`) od ponad 15 min (konto jeszcze nieczytane: od pierwszej próby; bez żadnej próby –
od razu) albo z otwartym alertem `KANAL_ZAMOWIENIA_NIEDOSTEPNY`. Ten sam licznik pokazuje pulpit panelu. Zaraz po
deployu konta nie mają jeszcze kursora, więc przy włączonym cieniu health jest `degraded` od pierwszej sekundy: kto
sprawdza po deployu (skrypt deployu, monitoring), daje workerowi 5 min rozruchu i dopiero potem traktuje `degraded`
jako błąd. `cien.withoutAdapter` = aktywne konta sprzedaży bez adaptera odczytu zamówień (np. Allegro) – cień ich
nie czyta z założenia. Stan cienia w health jest liczony najwyżej raz na 10 s (otwarta ścieżka).

**Lokalnie (bez Coolify):** `docker build -t kompletor:lokalnie .`, potem dwa kontenery z tego obrazu na wspólnej
sieci z bazą (`KOMPLETOR_ROLA=web` z portem 3000 i `KOMPLETOR_ROLA=worker`). Kontenery łączą się z bazą po nazwie
usługi, nie po 127.0.0.1, więc `APP_DATABASE_URL` musi mieć własne hasło (`openssl rand -hex 32`) – hasło z
`.env.example` działa tylko na 127.0.0.1/localhost i poza nimi krok instalacji je odrzuca.

**Wdrożenie przez Coolify** (albo inną platformę z Dockerfile): dwie aplikacje z tego repo (build pack `dockerfile`),
`web` z domeną i healthcheckiem `/api/health` na `127.0.0.1:3000` oraz `worker` bez domeny, baza Postgres 16 bez
publicznego portu. Zmienne jak wyżej, ustawione w platformie (entrypoint niczego wtedy nie bierze z plików sekretów).
**Bramka Basic Auth** z `proxy.ts` + `lib/basic-auth.ts` działa przed logowaniem panelu: włączona, gdy
ustawione są OBA `BASIC_AUTH_USER` i `BASIC_AUTH_PASSWORD` (tylko jedno = 503 na wszystkim, fail-closed); otwarte zostaje
tylko `/api/health`. **W `NODE_ENV=production` (obraz, `next start`) brak obu zmiennych też daje 503**, więc zgubione
zmienne nie wystawią panelu. Instancja bez bramki (self-host za własnym proxy albo sam panel z logowaniem) ustawia jawnie
`BASIC_AUTH_DISABLED=1` (tak robi `compose.yaml`); bramkę wyłącza się tą zmienną, nie kasowaniem kodu. Bramka jest w
aplikacji, nie w proxy platformy, bo Coolify 4.1.2 odpowiada 500 na pola Basic Auth przy zakładaniu aplikacji.

## Import katalogu

```
npm run import:katalog -- [--firma <slug>] --raport <katalog> [--zapisz-zrzut plik.json] [--z-zrzutu plik.json] [--bez-bazy] [--dni 90]
```

Firma: `--firma`, inaczej `SELFHOST_ORG_SLUG` albo jedyna firma w bazie. Inventory BL, magazyn wFirmy, sklepy Woo
(`blStorageId`) i konto Empik bierze z konfiguracji firmy; klucze z jej sekretów (self-host: także z env).

Pobiera (tylko odczyt): katalog BL z powiązaniami (`getInventoryProductsData.links`), produkty sklepów
Woo widziane przez BL (`getExternalStorageProducts*`), pozycje zamówień BL z 90 dni (bez danych klientów –
`fromBlOrder` zostawia tylko produkt, ofertę, ilość), towary wFirmy (`goods/find`), oferty Empik (OF21).
Zapisuje produkty (`Product`, zestawy `BundleComponent`), stan startowy (`Stock` + `StockMovement`
INITIAL_IMPORT – tylko gdy wiersza nie ma; dalsze lustro wFirmy prowadzi rdzeń), oferty
(`ChannelOffer` dla jednoznacznych, `ChannelOfferImport` dla wszystkich z wynikiem mapowania), kopie
`BlProduct` i `WfirmaGood`, przebieg `ImportRun` + błędy per element `ImportIssue`. Import jest idempotentny.

Zasady ofert po drugim przeglądzie:
- Powiązanie pewne (link BL, sprzedaż BL, Empik `shop_sku`, tabela nadpisań) → `ChannelOffer` aktywna.
- Woo dopasowane po samym SKU (bez linku BL) → propozycja: `active = false`, `needsApproval = true`, do zatwierdzenia
  w panelu (F2; zatwierdzenie = `mappingSource = MANUAL`). Warianty jednego produktu sklepu o wspólnym SKU → wieloznaczne, bez oferty.
- `mappingSource = MANUAL` → import nie zmienia `productId`, `active` ani `qtyBasePerOffer`.
- Import włącza z powrotem tylko ofertę, którą sam wyłączył (`deactivatedByImportAt`); wyłączenie w panelu jest trwałe.
- Bezpiecznik masowej deaktywacji (> 20 % aktywnych ofert konta i > 5) można świadomie zdjąć na czas: `ChannelConfig.allowMassOffUntil`
  (data w przyszłości = zgoda; po terminie bezpiecznik wraca sam; drobna 3).
- Wyłączanie ofert tylko dla kanałów pobranych w całości. Bez towarów wFirmy import odmawia zapisu (`ImportRun FAILED`);
  CLI bez kluczy wFirmy i bez `--bez-bazy` kończy się kodem 1. Brak kluczy Empiku przy skonfigurowanym koncie Empik nie blokuje importu: Empik pominięty
  (`ImportIssue` brak-kluczy, przebieg `PARTIAL`), jego oferty nie są wyłączane. Firma bez konta Empik nie dostaje żadnego wpisu o Empiku.
- Link BL → towar wFirmy spoza pobranego magazynu: produkt nie powstaje (bez cichego dopasowania po SKU/EAN), lista w raporcie.
- `dane/nadpisania-ofert/<firma>.csv` albo prywatna nakładka `prywatne/nadpisania-ofert/<firma>.csv` (katalog można wskazać
  `KOMPLETOR_NADPISANIA_KATALOG`; `kanal;konto;id_oferty;sku;uwagi`): oferty powiązane w BL po fakcie, których historia
  `getOrders` ma `product_id = 0`; `<firma>` = id firmy (np. `moja_firma.csv`), konto sprawdzane z konfiguracją firmy.
  Brak domyślnego pliku firmy = brak nadpisań; plik wskazany w `NADPISANIA_OFERT`, którego nie ma = błąd importu.
  CSV nie zatwierdza propozycji Woo dopasowanych po SKU – robi to panel (`setOfferActiveManually`). Wiersze kanałów bez
  konta w konfiguracji firmy (`BL_INNE`, `RECZNE`, `EASYTOOLS`) są odrzucane jako nieznane konto.
- Miejsca na półce z BL (`locations`, np. B-3-4) → `Stock.location` (do sortowania kart zbierania); pusty kod w BL nie kasuje wpisu.
- Limit wFirmy (`… LIMIT …`, HTTP 429) nie jest ponawiany – tym kluczem BL wystawia faktury.
- `--zapisz-zrzut nazwa.json` (sama nazwa) zapisuje do `%LOCALAPPDATA%\logistyka\zrzuty`; ścieżka w repo jest odrzucana.
- Worker: `raportDir` z payloadu tylko jako ścieżka względna w `RAPORTY_DIR` (domyślnie `./raporty`).
- Oferty znikające z okna sprzedaży (Allegro, inne źródła BL, ręczne, EasyTools) nie są sprzątane – te kanały nie mają
  pełnej listy ofert (do adaptera Allegro, F2). Bezpiecznik: wyłączenie w jednym przebiegu > 20 % aktywnych ofert kanału
  (i > 5) albo pusta lista ofert kanału w źródle (Woo: magazyn sklepu w BL, Empik: OF21 – bez ofert ze sprzedaży) przy
  istniejących wierszach = odmowa dla kanału, `ImportIssue` (raz na kanał), przebieg `PARTIAL`.
- Nadpisanie z CSV nie wygrywa z bieżącym powiązaniem BL: konflikt idzie do `overrideProblems` (raport, `ImportIssue`).
- Zadanie workera bez kluczy wFirmy albo z odmową importu z braku kluczy kończy się `FAILED` od razu (`NonRetryableError`,
  `lib/bledy.ts`). Towary wFirmy niepobrane: 5xx i sieć → zwykły błąd, `ImportRun FAILED`, zadanie się ponawia z odstępem
  kolejki; limit i odmowa API wFirmy (LIMIT, HTTP 429, inne 4xx) → `ImportRefused`, bez ponawiania (następny przebieg
  z harmonogramu). Treść odpowiedzi wFirmy trafia do `ImportRun.error`.
- Reguły katalogu firmy (`lib/import/bez-stanu.ts`) w `Organization.settings.catalog`, nigdy z nazwy pozycji:
  `noStock.skus` / `noStock.shopCategories` (`"<konto sklepu>:<category_id>"`) → produkt `DIGITAL` (bez stanu: e-book,
  usługa) i aktywna oferta `mappingSource = CONFIG`, poza progiem braków; `nonOfferSkus` → pozycja z magazynu BL bez oferty
  kanału (dodatek, składnik zestawu rozbijanego przez BL, id `bl:<id>`) poza progiem, bez oferty. Reguła nie zmienia
  rodzaju istniejącego produktu ani nie wygrywa z produktem ze stanem o tym SKU (konflikt w raporcie). Preset firmy
  dokłada brakujący klucz `catalog` do istniejącej firmy.

**Kontrakt panelu (F2) z importem – ręczne zmiany oferty tylko przez `setOfferActiveManually` (`lib/oferty.ts`):**
1. Zatwierdzenie propozycji albo ręczne włączenie = `active = true`, `mappingSource = MANUAL` (import przestaje ruszać ofertę).
2. Odrzucenie propozycji albo ręczne wyłączenie = `active = false` na stałe (import jej nie włączy).
3. Każda ręczna zmiana zeruje `deactivatedByImportAt` i `needsApproval` – pole niepuste znaczy „wyłączył import”.
4. `Stock.location` przychodzi dziś z BL co przebieg; po przełączeniu edytuje je panel (wtedy flaga źródła).

Self-host na własnym komputerze: `--klucze-z <mapa.json>` (albo env `KLUCZE_LOKALNE`) czyta brakujące klucze
z plików `.env` innych projektów wg mapy trzymanej poza repo (`scripts/klucze-lokalne.ts`: lista
`{ file, keys: { NASZA_ZMIENNA: ZMIENNA_W_PLIKU } }`), bez kopiowania ich tutaj. Docelowo klucze w `.env`
tego repo albo w Coolify.

Ten sam import jako zadanie workera firmy: `Job.kind = 'import-katalogu'`, payload `{ "raportDir": "…" }` (raport
w podkatalogu z id firmy).

## Serwer MCP dla agentów AI

`POST /api/mcp` — serwer [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28) (rewizja
2026-07-28, zgodnie wstecz z 2025-11-25 bez sesji). Agent AI klienta (Claude Code, Cursor, VS Code, Gemini CLI;
Claude Desktop przez pomost `dist/kompletor-mcp.cjs`) dostaje narzędzia **tylko do odczytu**: zamówienia, stany,
produkty, braki, rezerwacje, liczby dnia — bez danych klientów. Klucz agenta (zakres `mcp:odczyt`) i gotowa
konfiguracja: Panel → Ustawienia → Agenci AI. Szczegóły: [docs/mcp.md](docs/mcp.md), dla sprzedawcy:
[docs/agenci-ai.md](docs/agenci-ai.md). Opcjonalnie `MCP_DOZWOLONE_ORIGINY` (lista originów przeglądarki poza
`PANEL_URL`).

## Zasady repo

- Sekrety tylko w `.env` (poza gitem) / Coolify; w repo `.env.example` z nazwami.
- Dane osobowe klientów nie trafiają do repo, seedów, testów ani raportów.
- Ilości w jednostce bazowej: sztuki albo gramy (towary wFirmy w kg).
- Pętle po rekordach: błąd elementu → `ImportIssue`/`Job.lastError`, reszta leci dalej.
- Panel ma logowanie; wystawienie na świat tylko za reverse proxy z HTTPS (sekcja „Wystawienie na świat”).

## Rdzeń stanów i rezerwacji

`lib/rdzen/` – wg specyfikacji modelu stanów v1.4. Działa tylko lokalnie i w testach:
**zero adapterów zapisu** (faktury wFirmy i stany kanałów idą przez interfejsy `FakturyWfirma` / `AdapterStanow`,
w testach atrapy; kanał w trybie `PRACA` bez adaptera kończy się błędem w jobie, nic nie wychodzi).

```
stan.ts          runTx (ponowienie 40P01/40001 do 3×), blokada doradcza zamówienia, StockBook (FOR UPDATE
                 w kolejności productId), outbox w tej samej transakcji
zamowienia.ts    przyjęcie z idempotencją (InboundEvent), edycja pozycji, płatność, anulowanie, wygasanie
                 nieopłaconych, „brak wszystkiego” po terminie, remap niezmapowanych
rezerwacja.ts    rezerwacja pozycji / zestawu (tylko pełne zestawy), zmniejszenie, zwolnienie
rozchod.ts       spakowanie, faktura: ruch IN_FLIGHT + CONSUMING przed żądaniem, WZ/MANUAL,
                 timeout → invoices/find 30 s / 2 / 5 min, „wyślij bez faktury”, „poprawione”, korekta, BL w cieniu
lustro.ts        odczyt wFirmy: potwierdzanie przyczynowe naszym zegarem, nadmiar rezerwacji, wzrost → allocate;
                 w cieniu karmi go zadanie rdzen-wfirma (niżej „Lustro stanów wFirmy”)
przydzial.ts     rozdział dostawy na „brakuje” (SHIP_LATER → opłacone → nieopłacone), strażnik 5 min
brakuje.ts       „nie ma na półce”, przycisk nadmiaru, „dośle później” (podzamówienie), odrzucenie przy akceptacji Empik
propagacja.ts    fanout (oferty + zestawy, bufor, wstrzymane wzrosty), joby per oferta, push CIEN/PRACA,
                 wzrost dopiero po odczycie zamówień rozpoczętym po wyliczeniu targetu, limit Empiku, alert 15 min
niezmienniki.ts  niezmienniki 5.4 (testy po każdym przypadku + nocny audyt → Alert)
kalendarz.ts     dni robocze z polskimi świętami, addBusinessDays w Europe/Warsaw
polityka.ts      ReservationPolicy: przełącznik sezonu i okresy (zmiany w AuditLog)
statusy.ts       przewoźnik (7.2) i dozwolone przejścia z panelu; ceny.ts – rozbicie ceny zestawu
```

Produkt bez stanu (`ProductKind.DIGITAL`): pozycja nie blokuje `Stock`, nie rezerwuje, nie trafia do „brakuje”
ani do bilansu niezmiennika 4, jego oferty nie dostają stanu z propagacji, a na fakturę paczki idzie jako usługa
(`InvoiceLine.service`, bez WZ i ruchu). Zamówienie `RECZNE` (panel) przyjmuje tylko pozycje z `productId` z katalogu firmy –
bez wolnego tekstu i bez oferty (`ValidationError`). Zwrot/korekta e-booka: ręcznie w wFirmie – `createReturn` odmawia
pozycji DIGITAL (`ReturnError`), także w zwrocie mieszanym, żeby korekta nie wyszła cicho bez tej pozycji.

Worker planuje sam (`worker/index.ts`, `HARMONOGRAM`, osobno dla każdej aktywnej firmy): fanout co 5 s, przydział
co 30 s, propagacja w cieniu co 30 s (konto po koncie), wygasanie co 5 min, audyt niezmienników raz na godzinę.

Testy rdzenia: `tests/rdzen-*.integration.test.ts` (przypadki z rozdz. 11 spec) i symulacja sezonu
`tests/rdzen-symulacja.integration.test.ts` (48 grudzień, 49 szczyt × 10, 50 propagacja; `SYM_RAPORT=plik.json`
zapisuje wynik, `SYM_LOG=1` drukuje postęp dni, `SYM_SZCZYT_SEKUNDY` rozkłada 1 120 zamówień szczytu w czasie);
48b = dwie firmy naraz w jednej bazie (sprawdza przecieki między firmami).

## Maile do klientów

`lib/maile/` – szablony i silnik, **bez wysyłki** i bez Prismy: `renderujMail(rodzaj, { firma, sklep }, dane, { nadpisania })`
zwraca temat (jedna linia), HTML, tekst, Reply-To, adresata (tylko maile do biura) i załączniki. Rodzaje: `brak-platnosci`,
`faktura` (PDF z danych jako załącznik), `gotowe-do-odbioru` (adres i godziny z danych sklepu), `blad-faktury` (wewnętrzny,
do `firma.emailBiura`). Treść to bloki z `{{zmienna}}`, `{{#x}}…{{/x}}`, `{{^x}}…{{/x}}`; brak użytej zmiennej = `BladSzablonu`.
Nadpisania treści per firma i per sklep (`NadpisanieSzablonu`, zapis w bazie: osobne zadanie) sprawdza `sprawdzNadpisanie`.
Silnik celowo nie ma pętli po listach: blok `lista` wypisuje gotowe elementy, a ich format (np. „2 × nazwa”) ustala
`lib/maile/mail.ts`, więc nadpisanie z panelu zmienia nagłówek listy i otoczenie, ale nie format elementu.
Przypomnienie o płatności: zadanie wysyłki podaje zawsze `terminAnulowania` (z `ReservationPolicy`), wtedy treść brzmi
„do <data>”; wariant „w ciągu N dni roboczych od złożenia” jest tylko awaryjny, gdy daty brak.
Podglądy z fikcyjnymi danymi: `lib/maile/podglady/*.html|txt`, odświeżanie `npm run maile:podglady`.

## Wydruki magazynowe

`lib/wydruki/` – czyste funkcje dane → PDF (`Buffer`), bez Prismy; typy wejściowe w `lib/wydruki/typy.ts`.
pdfkit + Code 128 z bwip-js rysowany wektorowo (ostry na laserowym Brotherze), font Noto Sans (OFL 1.1,
przycięty do łaciny z polskimi znakami, `lib/wydruki/fonty/`).

```
kartaZamowienia(dane, { jednaPozycjaNaKarte })  karta do koszyka: kod numerZamówienia/numerWydruku (SD48213/1,
                                                dosyłka SD48213-2/1), pozycje po lokalizacji B-3-4 (naturalnie,
                                                bez lokalizacji na końcu), nagłówek i kod na każdej stronie
listaWysylkowa(dane)                            zamówienia z odbioru, suma paczek per przewoźnik, podpis kuriera
spisProduktow(dane)                             stany per lokalizacja, filtr po strefie
etykietaProduktu(dane, { szerokoscMm, wysokoscMm, kopie })   etykieta „tył”, domyślnie 100 × 50 mm
kodKarty / odczytajKodKarty                     treść kodu karty i odczyt skanu na stanowisku pakowania
```

Karta nie idzie do paczki: z klienta tylko imię, nazwisko i miasto. Ponowny wydruk = kolejny `numerWydruku`;
odrzucanie starszych kodów przy pakowaniu należy do warstwy, która zapisuje numer wydruku (poza tym modułem).
Przykłady z fikcyjnymi danymi: `npm run wydruki:przyklady` → `lib/wydruki/przyklady/*.pdf`.

## Stanowisko pakowania „na sucho”

Ćwiczenie cienia: magazyn pakuje równolegle z BaseLinkerem, a system zapisuje WYŁĄCZNIE ćwiczenie – bez zmiany
`Order.status`/`flags`, rezerwacji, stanu, braków, ruchów, faktur i przesyłek (test porównuje bazę przed i po,
`tests/stanowisko-na-sucho.integration.test.ts`). Uprawnienie `pakowanie.stanowisko` (Właściciel, Magazyn);
zamykanie listy „Do poprawy” – `pakowanie.do_poprawy` (Właściciel, Biuro).

- `POST /api/wydruki/karty` (formularz, pole `z` = id po przecinku, najwyżej 100; GET → 405, żądanie spoza tej samej domeny → 403): jeden PDF z kartami w kolejności `z`, każda z kolejnym numerem
  wydruku w rejestrze `OrderCardPrint` (migawka pozycji, `dryRun` = konto kanału z `statusMode = CIEN` → plakietka
  NA SUCHO). Kod karty: przedrostek konta (jak w panelu, tylko A–Z) + numer liczbowy (id z kanału → numer w kanale z
  cienia → numer zamówienia BL); zamówienie bez numeru liczbowego (Allegro przed porównaniem z BL) = 422.
- `/stanowisko?z=<id,id…>` (bez menu panelu): pole skanu, sesja, okno pakowania. Skan karty rozpoznaje zamówienie po
  rejestrze wydruków (karta innej firmy = nieznany kod, RLS); karta nieaktualna (nowszy wydruk albo zmiana pozycji w
  kanale), anulowane, „Do wyjaśnienia”/brak (czerwona karta), konto w PRACY („Ścieżka »naprawdę« po scaleniu
  ”, bez zapisu), już spakowane. Logika: `lib/stanowisko/` (`cwiczenie.ts`, `zamowienia.ts`, `karty.ts`, `kod.ts`).
- „Na półce nie było” od razu zakłada pozycję listy „Do poprawy w wFirmie – z ćwiczenia” (`PackDrillFix`), nic więcej.
  Wynik ćwiczenia (`PackDrill`): spakowane z gabarytem albo „nie spakowano”, pozycje zebrane i braki.
- Raport dnia i lista „Do poprawy”: sekcja na końcu `/rozjazdy`. Ustawienie firmy `settings.stanowisko`
  (`powrotDoSkanu`, domyślnie `true`; `powrotPoSekundach`, domyślnie 3).
- Komentarza klienta i odbiorcy nie ma w danych cienia (Order nie trzyma danych osobowych) – ekran i karta mówią to wprost.

## Agent druku

`agent-druku/` – osobny pakiet (własny `package.json`, bez zależności uruchomieniowych) na komputer z Windows
w magazynie: odpytuje `GET /api/druk/zlecenia`, drukuje PDF przez SumatraPDF i ZPL surowo do kolejki Windows,
odsyła wynik i co minutę stan drukarek (A4, TERMICZNA_1, TERMICZNA_2). Kontrakt endpointów, instalacja krok po
kroku i uzasadnienie wyborów: `agent-druku/README.md`. Główne `tsc` i `vitest` go pomijają; testy:
`cd agent-druku && npm ci && npm run typecheck && npm test`.
Serwer druku (stanowiska, tokeny, kolejka `/api/druk/*`, Ustawienia → Druk, paczka `Zainstaluj.cmd`): `docs/druk.md`.
Przeprowadzka z BaseLinkera (`npm run przeprowadzka`, tryb próbny i `--zapisz`, Ustawienia → Przeprowadzka z BaseLinkera): `docs/przeprowadzka-z-baselinkera.md`.

## Kontrakt adaptera i cień zamówień

`lib/adaptery/` – kontrakt każdej integracji (wzorce z porównania z OpenLinkerem, kod własny):

```
kontrakt.ts          port bazowy (manifest + test połączenia) i opcjonalne zdolności ze strażnikami typu
                     (orders.feed, stock.write, reference.find); manifest: adapterKey (np. woo.rest.v1), wersja,
                     zdolności, limity tempa, pola konfiguracji i sekretów; błędy PRZEJSCIOWY / TRWALY /
                     NIEJEDNOZNACZNY; „nieczytelne dane to błąd, nigdy 0” (UnreadableDataError); ChannelOrder bez
                     danych osobowych
rejestr.ts           rejestr po adapterKey z walidacją manifestu, konfiguracji i sekretów; deriveReference = deterministyczny
                     klucz idempotencji zapisu (UUID)
zapis.ts             executeWrite: wynik OK / PRZEJSCIOWY / TRWALY / NIEJEDNOZNACZNY; niejednoznaczny → findByReference
konta.ts             konto kanału (ChannelConfig.adapterKey + config) → adapter; self-host: env z przedrostkiem konta
shoper.ts            shoper.rest.v1 – zamówienia, oferty i stany; zapis za wyłącznikiem (na atrapie)
woo.ts               woo.rest.v1 – zamówienia przez modified_after (tylko GET)
mirakl-empik.ts      mirakl.empik.v1 – OR11 po start_update_date (tylko GET, istniejący klucz)
prestashop.ts        prestashop.ws.v1 – zamówienia, oferty i stany; zapis za wyłącznikiem (na atrapie)
idosell.ts           idosell.admin.v1 – zamówienia, produkty z rozmiarami i stany; zapis za wyłącznikiem (na atrapie)
falszywy.ts          fałszywy kanał w pamięci (testy, demo)
suita-kontraktowa.ts wspólna suita, którą przechodzi każdy adapter (runAdapterContract)
```

Nowy adapter: definicja `{ manifest, create(ctx) }` w rejestrze (`lib/adaptery/domyslne.ts`), uprząż z kanałem
w pamięci i `runAdapterContract(uprząż)` w teście (wzór: `lib/adaptery/adaptery.test.ts`).

`lib/wfirma/` – faktura „przygotuj, nie wystawiaj”: `npm run cien -- faktury-podglad --dzien RRRR-MM-DD [--firma <slug>]`
(w obrazie `node dist/cien.cjs faktury-podglad …`, domyślnie wczoraj) dla każdej faktury BL z dnia składa fakturę, którą wystawiłby
system, porównuje ją z kopią `BlInvoiceSnapshot` i zapisuje wynik w `InvoiceDryRun` (jeden wiersz na fakturę BL, bez danych klientów);
wypisuje liczbę zgodnych, różnice per kategoria (brak powiązania, zaokrąglenie, wysyłka, VAT, inne) i numery zamówień. Nic nie
wystawia i nie woła BL ani wFirmy. Próg 99%: stała `PROG_ZGODNOSCI_PROCENT` w `lib/wfirma/porownanie.ts`. Ustawienia firmy:
`settings.faktury` (`seriaId`, `kodyVat`, `wysylka.stawkaVat`, `platnosci`; mapowanie płatności czeka na księgowość).
Kopia BL ma pozycje od tej wersji; starsze faktury porównują się samymi sumami. Adapter `lib/wfirma/adapter-podglad.ts` odmawia
`issue` bez sieci i nie jest podpięty do workera.

`lib/wfirma/faktura-robocza.ts` – faktura robocza VAT w wFirmie (`normal_draft`) dla jednego zamówienia przed przełączeniem:
`npm run cien -- faktura-robocza --zamowienie <id> [--wykonaj [--takze-z-nip]]`, `--usun <docId>` i `--sprawdz <docId>`
(`scripts/faktura-robocza.ts`). Treść z `zlozFaktureZamowienia` (lib/wfirma/adapter-zapis.ts, ta sama co
`FakturyWfirmaZapis.issue`), inne tylko `type` i `id_external` (`pr/<orderId>`, najwyżej 32 znaki jak w wFirmie); bez `InvoiceAttempt` i bez zmian
zamówienia. Nabywca prawdziwą drogą (`odbiorcaDoCelu`, moduł `faktura-robocza`): ślad odczytu danych klienta, a bez rekordu
klienta przy włączonym zapisie odczyt kanału i zapis zaszyfrowanego rekordu; konto w „Tylko podgląd” wymaga rekordu albo
„zapisu w cieniu” (inaczej odmowa, kod 2). `--wykonaj` tylko dla nabywcy bez NIP-u, chyba że `--takze-z-nip`. Usuwanie
wyłącznie `WfirmaZapis.usunFaktureRobocza` (świeży odczyt, roboczy typ, numer pusty albo „WRF n”, prefiks próby; stary
prefiks `proba-robocza/` tylko gdy wskazuje jedno zamówienie firmy). Opis:
docs/dokumenty-sprzedazy.md, „Faktura robocza przed przełączeniem”.

`lib/cien/` – cień zamówień (tylko odczyt kanałów i BL, zapis tylko w naszej bazie):

```
odczyt-zamowien.ts   odczyt konta: kursor → strony → kopia (ChannelOrderSnapshot) → rdzeń (ingestOrder, rezerwacje);
                     błąd elementu: trwały → alert i kopia, przejściowy → ponowienie (ChannelCursor.retryIds);
                     awaria listy → kursor stoi, po 15 min alert; błąd konfiguracji konta → alert od razu (
                     jeden na konto, zamyka go pierwszy pełny udany odczyt); zrealizowane widziane pierwszy raz nie rezerwuje
stan-odczytu.ts      czy konta czytają: pole `cien` w /api/health i licznik na pulpicie
harmonogram.ts       zadanie na konto (cien-zamowienia) z odstępem konta; konta bez adaptera pominięte
bl-porownanie.ts     getOrders (bez danych klientów) → BlOrderSnapshot, pary → Order.blOrderId, raport rozjazdów
metryki.ts           opóźnienie „zamówienie w kanale → rdzeń” (p50/p95/maks.) i odstępy odczytów
```

Worker planuje `cien-zamowienia-planuj` co 15 s i `cien-bl-porownanie` co 10 min (wynik w `ImportRun` kind
`cien-bl`). Okno pierwszego odczytu i porównania: env `CIEN_OKNO_GODZINY` (domyślnie 24). Wyłącznik: `CIEN_ODCZYT=0`
zdejmuje oba zadania z harmonogramu, a zadania cienia już w kolejce kończą się bez odczytu (handler sprawdza to samo);
`1` albo puste = włączony, inna wartość = błąd na starcie workera. Na serwerze trzymamy `0`, dopóki właściciel nie
zaloguje się w panelu (odczyt zamówień to dane osobowe klientów). Wyłącznik dotyczy tylko zadań cienia workera: okno
sprzedaży importu katalogu (`getOrders` z BL) to osobny wyłącznik `KATALOG_IMPORT_DNI_SPRZEDAZY`, a ręczne
`npm run cien -- test` i `raport --porownaj` czytają konta i BL bez względu na `CIEN_ODCZYT` (polecenie operatora).

```
npm run cien -- konfiguruj [--preset <nazwa>]  adapter i ustawienia kont z presetu firmy: tylko puste klucze
npm run cien -- test [--klucze-z <mapa.json>]  test połączenia kont (Woo: zapisuje hold_stock_minutes)
npm run cien -- worker [--minut 30] [--klucze-z <mapa.json>]  worker z łagodnym zatrzymaniem po N min
npm run cien -- raport --od <ISO> --porownaj --plik raport.md
```

**Faktury BL, sprzedaż dnia, raport rozjazdów, przegląd otwartych** – dalsze zadania cienia (wszystkie
pod wyłącznikiem `CIEN_ODCZYT`; zadania BL planowane tylko dla firm z tokenem i `baselinker.inventoryId`):

Ustawienie `cien.wzOptional` (domyślnie wyłączone) pomija czekanie na WZ, ale faktura idzie wtedy torem
BEZ_WZ: ruch MANUAL na każdej pozycji, po dobie alert `RUCH_ZALEGLY` per pozycja i stała pozycja na liście „Dla biura”
raportu (nie zeruje `ok`, ale lista nigdy nie zejdzie do zera). Nie włączać
drugiej firmie bez decyzji, co znaczy rozchód bez WZ.

```
faktury-bl.ts        cien-bl-faktury co 2 min: getInvoices od ostatniego numeru → BlInvoiceSnapshot (bez danych nabywcy)
                     → Order.blOrderId → WZ z wFirmy (invoices/find + warehouse_documents/find) → applyBlInvoice
                     (rezerwacja CONSUMED, ruch BL_INVOICE); bez WZ po 15 przebiegach ruch MANUAL; bez kluczy wFirmy
                     faktury czekają; BL „Wysłane” bez faktury → applyBlShippedWithoutInvoice; zamówienie z samymi
                     e-bookami (DIGITAL) → outcome BEZ_STANU (anulowane: NIC_DO_ROZLICZENIA); błąd faktury po 15
                     próbach → alert FAKTURA_BL_BLAD (raz na fakturę); „WZ dla żadnej” → FAKTURY_BL_BEZ_WZ raz na dzień
sprzedaz-dnia.ts     cien-sprzedaz-dnia: po północy (+30 min) za wczoraj, liczba i kwota brutto per konto ze źródła
                     pulpitu (lib/panel/dane.ts salesOrders) kontra BL getOrders po date_add; rozjazd → Alert
                     SPRZEDAZ_DNIA_ROZJAZD z numerami zamówień; ShadowDailyCheck = seria dni do kryterium 7 dni
raport-dzienny.ts    cien-raport-rozjazdow: raport za wczoraj (spec 9.2 pkt 1–5) → ShadowDailyCheck + plik
                     RAPORTY_DIR/rozjazdy/<firma>/rozjazdy-<dzień>.md; ekran /rozjazdy pokazuje ostatni; raport
                     z 3 h po północy bez sprzedaży dnia przelicza się po jej późniejszym zamknięciu. Stan
                     BL = jedna wartość na towar wFirmy (bez sumowania dubli i rekordów skasowanych w BL), „uratowane”
                     bez zestawów, `ok` = sprzedaż zgodna + zero IN_FLIGHT/APPLIED > 24 h, nadmiarów, naruszeń
                     i rozjazdów stanu poza tolerancją („w drodze”, ruch biura); lista „Dla biura” (MANUAL > 24 h,
                     „Do wyjaśnienia”) nie zeruje `ok`, daje jeden alert BIURO_DO_WYJASNIENIA dziennie (pulpit,
                     „Sytuacje do obsługi”). Definicja serii: docs/seria-f3.md
przeglad-otwartych.ts cien-przeglad-otwartych raz na dobę: NOWE/DO_REALIZACJI z kopią starszą niż CIEN_PRZEGLAD_GODZIN
                     (domyślnie 24) → getOrder; kanał „nie ma” → DO_WYJASNIENIA + alert, bez anulowania
```

WZ nieobowiązkowe (`Organization.settings.cien.wzOptional = true`, domyślnie brak = wyłączone, WZ
obowiązkowe): dla firmy, która nie wystawia WZ w wFirmie, faktura BL bez WZ idzie od razu torem `BEZ_WZ` (rozchód
z ruchem MANUAL na każdej pozycji), także bez kluczy wFirmy – bez czekania 15 przebiegów i bez bezpiecznika.
Flaga czytana z surowego JSON ustawień w `faktury-bl.ts`; ustawia się ją ręcznie w bazie (nie ma jej w `parseOrgSettings`).

**Lustro stanów wFirmy w cieniu** — zadanie `rdzen-wfirma` co 2 min: kolejka wywołań wFirmy
(`runWfirmaQueueExclusive`, dzierżawa i budżet 20 wywołań) wyłącznie z odczytem stanów
(`lib/cien/odczyt-stanow-wfirmy.ts`, `goods/find` z warunkiem magazynu przez `WfirmaReadOnly`; faktury i korekty = brak
adaptera, zero zapisu w wFirmie). Odczyt celowany po każdej fakturze BL (`applyBlInvoice` → zdarzenie `WFIRMA_READ`),
pełny odczyt stronami co noc (`rdzen-noc`) i po każdym udanym imporcie katalogu (stany z tej samej chwili co
kopia BL; raport rozjazdów czeka na zlecony odczyt najwyżej 3 h po końcu dnia), a pierwszy zleca sam przebieg, gdy firma
nie miała żadnego. Limit wFirmy
(HTTP 429, kod z LIMIT) wstrzymuje całą kolejkę firmy (`WfirmaQueueState.pausedUntil`, alert `WFIRMA_LIMIT`). Bez kluczy
wFirmy zadanie kończy się cicho (jeden wpis w logu). Wyłącznik `CIEN_LUSTRO_WFIRMY`: `1` włączone, `0` wyłączone
(handler i harmonogram), puste = jak `CIEN_ODCZYT`. Nazwy warunków API2 (`warehouse_id`, operator `in` dla id) do
potwierdzenia przy pierwszym przebiegu (adapter odrzuca też po stronie klienta pozycje z innego magazynu, a odpowiedź
z towarami spoza zapytania kończy się błędem).

```
npm run cien -- sprzedaz-dnia [--dzien dzis|RRRR-MM-DD]      porównanie sprzedaży dnia na żądanie (dziś: bez ostatnich 20 min)
npm run cien -- rozjazdy [--dzien RRRR-MM-DD] [--plik <md>]  raport rozjazdów z bazy (domyślnie wczoraj)
npm run cien -- allegro-autoryzuj [--konto <id>]              device flow Allegro: własna para tokenów konta
```

Rdzeń: zamówienie anulowane przez kanał (ostatnie zdarzenie ANULOWANE od tego samego źródła odczytu), które wraca
w nowszej rewizji jako otwarte, dostaje rezerwację od nowa (braki → DO_WYJASNIENIA); anulowanie przez obsługę
i płatność z innego źródła zostają po staremu. Metryka „zmiana w kanale → u nas” (`ChannelOrderSnapshot.revisionSeenAt`)
w `npm run cien -- raport` (ostatnia rewizja każdej kopii).

Ustawienia konta (`ChannelConfig.config`, bez sekretów): Woo `baseUrl`, `envPrefix`, `pollIntervalSec`,
`overlapMinutes`, `pageSize`; Empik `baseUrl`, `envPrefix`, `pollIntervalSec` (≥ 60). Sekrety konta: Woo
`WOO_CONSUMER_KEY` / `WOO_CONSUMER_SECRET` (albo login i hasło aplikacji WP), Empik `MIRAKL_API_KEY`; self-host
z env: `<envPrefix>_URL|KEY|SECRET` (Woo), `<envPrefix>_BASE_URL|API_KEY` (Empik).

**Allegro (`allegro.v1`)**: dziennik zdarzeń `GET /order/events` (pierwszy odczyt: `event-stats`, potem lista
`checkout-forms`; kursor poza 60-dniową retencją → lista zapasowa i alert `KANAL_ZAMOWIENIA_OSTRZEZENIE`), tylko GET
poza OAuth. Ustawienia: `apiUrl`, `authUrl` (produkcja albo sandbox), `userAgent` („Nazwa/Wersja (+URL)”), `envPrefix`,
`pollIntervalSec`. Sekrety konta: `ALLEGRO_CLIENT_ID` / `ALLEGRO_CLIENT_SECRET` (self-host także
`<envPrefix>_CLIENT_ID|CLIENT_SECRET`) oraz własna para tokenów Kompletora – **nigdy z env**, nigdy cudza (refresh token
Allegro jest jednorazowy). Parę zakłada `npm run cien -- allegro-autoryzuj [--konto <id>]` (w obrazie; `--konto` wymagane, gdy firma ma kilka kont Allegro;
`node dist/cien.cjs allegro-autoryzuj`): wypisuje link dla właściciela konta, prosi tylko o zakres
`allegro:api:orders:read`, zapisuje parę zaszyfrowaną i robi test połączenia. Adapter odświeża ją przy 401 albo < 5 min
do końca ważności, pod blokadą wiersza sekretu (jeden proces naraz; nowa para w bazie przed pierwszym użyciem).
Odrzucony refresh token (3 miesiące, wylogowanie) = alert konta „uruchom allegro-autoryzuj” i odczyt w trybie awarii
bez kolejnych prób. Scalona płatność (nowy formularz z tymi samymi pozycjami): rezerwuje tylko nowszy.

## Kolejka pakowania

`/pakowanie` – zamówienia przed wysyłką (`DO_REALIZACJI`, `ZBIERANIE`, `ZEBRANE`, `SPAKOWANE`) pogrupowane po
przewoźniku od najbliższego odbioru („od rana najpierw DPD, potem InPost”). Zakładki: „Naprawdę” (konta z
`ChannelConfig.statusMode = PRACA`), „Na sucho” (`CIEN`), „Czekają na etykietę” (pusta do adapterów przewoźników).
Pasek kuriera: godzina odbioru, „do odjazdu H:MM”, „zostało N”, przycisk „Przyjechał DPD/InPost/Allegro”
(uprawnienie `pakowanie.kurier`, domyślnie każda rola). Kliknięcie zamyka **dzisiejszy** odbiór (`CarrierPickupEvent`,
jedno na przewoźnika i dzień, tylko dopisywane): zamówienia spakowane przed kliknięciem pojechały i znikają z kolejki,
spakowane później liczą się do następnego odbioru. Filtr strefy (produkty spożywcze / akcesoria / mieszane)
z liczbami; zaznaczanie i praca masowa: „Pakuj zaznaczone” → `/stanowisko?z=…`, „Drukuj karty zamówień” →
formularz `POST /api/wydruki/karty` z polem `z` (oba przyciski tylko z uprawnieniem `pakowanie.stanowisko`), „Drukuj listę wysyłkową” → `/api/wydruki/lista-wysylkowa?z=…`
(PDF z `lib/wydruki/lista-wysylkowa.ts`, najwyżej 200 zamówień, tylko zamówienia firmy z sesji). Zmian statusów
z akcji masowych jeszcze nie ma.

```
lib/pakowanie/harmonogram.ts  najbliższy odbiór (Europe/Warsaw, dni tygodnia z harmonogramu, bez świąt z
                              lib/rdzen/kalendarz.ts), „do odjazdu”, „wyślemy dziś do” (canPromiseToday)
lib/pakowanie/strefy.ts       strefa produktu (ręcznie w karcie produktu > reguła firmy po nazwie/SKU), strefa
                              zamówienia (jedna albo „mieszane”), filtr i liczby
lib/pakowanie/kolejka.ts      grupy przewoźników, „pojechało z kurierem”, strony
lib/pakowanie/dane.ts         odczyty i zapisy przez klienta firmy (odmawia klienta systemowego)
```

Harmonogram (`CarrierPickup`: dni tygodnia ISO, godzina odbioru, „wyślemy dziś do”) i reguły stref
(`ProductZoneRule`) są per firma; edycja godzin w **Ustawienia → Przewoźnicy** (`/ustawienia/przewoznicy`, uprawnienie
`ustawienia`, zmiany w `AuditLog`), strefa produktu w jego karcie. Godziny odbiorów i reguły stref może założyć preset
firmy (`carrierPickups`, `zoneRules` w `seed/presety/<nazwa>.json`); reguły stref z presetu są oznaczone jako przykładowe
(`example = true`, panel pokazuje to w ustawieniach). Preset zakłada godziny i reguły tylko firmie, która nie ma żadnych;
inna firma ustawia swoje godziny w Ustawienia → Przewoźnicy.
