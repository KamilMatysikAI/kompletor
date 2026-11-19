# Druk w magazynie: serwer druku i agent na stanowisku Windows

Kompletor drukuje karty zamówień, listy wysyłkowe i etykiety bez otwierania PDF-ów: osoba w panelu klika
**Drukuj**, a mały program na komputerze w magazynie („Kompletor Druk”, katalog `agent-druku/`) w ciągu kilku sekund
drukuje na właściwej drukarce i odsyła wynik.

**Stan:** kod gotowy, sprawdzony na atrapie agenta (testy automatyczne, bez Windows i bez drukarek) i na danych
fikcyjnych. Druk na prawdziwych drukarkach sprawdza się lokalnie po scaleniu: patrz „Krok po scaleniu” niżej.

---

## Część 1. Dla osoby, która instaluje i obsługuje

### Gdzie to jest

- **Panel → Ustawienia → Wysyłka i druk → Druk** (adres `/ustawienia/druk`), dla osób z uprawnieniem „Ustawienia firmy”
  (np. rola Właściciel). Bez nowej pozycji w menu: wejście z ekranu Ustawienia.
- Przyciski **Drukuj karty** / **Drukuj listę**: pasek „Zaznaczono N” w **Pakowanie** (`/pakowanie`) i na liście
  **Zamówienia** (`/zamowienia`). Karty: uprawnienie stanowiska pakowania (Magazyn, Właściciel); lista: każdy z
  podglądem panelu.
- **Drukuj etykietę próbną**: szczegóły zamówienia, blok „Przesyłka (podgląd)”, po „Przygotuj przesyłkę”.
- **Stan drukarek**: nagłówek ekranu **Pakowanie** i **Stanowisko pakowania** (`/stanowisko`), odświeżany co 30 s.

Firma bez stanowisk druku widzi panel jak dotąd: karty i listy pobiera się jako PDF.

### Instalacja na komputerze w magazynie (raz, ok. 5 minut)

1. W panelu: **Ustawienia → Wysyłka i druk → Druk → Nowe stanowisko**. Nazwa dla ludzi (np. „Pakowanie przy oknie”) i kod bez
   polskich znaków (np. `magazyn-1`). Jeden komputer = jedno stanowisko.
2. Przy stanowisku kliknij **Utwórz token i kod instalacyjny**. Pojawi się długi kod zaczynający się od `kmi_`.
   Kod widać **tylko raz**: skopiuj go (przycisk „Kopiuj kod instalacyjny”). Kod zawiera hasło stanowiska: nie
   wysyłaj go mailem ani czatem.
3. Na komputerze w magazynie pobierz paczkę `Kompletor-Druk-<wersja>-win-x64.zip`: przycisk **„Pobierz program
   (Windows)”** z wersją i rozmiarem jest u góry ekranu Ustawienia → Wysyłka i druk → Druk i w karcie każdego
   stanowiska, przy „Token i kod instalacyjny” (trzeba być zalogowanym w panelu na tym komputerze). Gdy przycisk jest
   wyszarzony, paczkę daje administrator („Paczka programu” niżej). Rozpakuj ją i kliknij dwa razy
   **`Zainstaluj.cmd`**. Instalator skopiuje program do `C:\Kompletor\agent-druku`, ustawi start przy logowaniu,
   doda skrót **„Kompletor Druk (ustawienia)”** (pulpit i menu Start) i otworzy tę stronę w przeglądarce.
4. Na stronie, w **„Podłącz do Kompletora”**, wklej kod (Ctrl+V) i kliknij **„Sprawdź i podłącz”**.
5. W **„Drukarki”** przy każdej drukarce wybierz **Kartki A4**, **Etykiety** albo **Nie używaj** (przy kilku tego
   samego rodzaju: **Główna** / **Zapasowa**). **„Wydruk próbny”** drukuje kartkę z numerem pozycji, żeby było
   wiadomo, która drukarka to która. Kliknij **„Zapisz”**: na górze pojawi się „Połączono z Kompletorem.”
6. W Windows wyłącz **„Zezwalaj systemowi Windows na zarządzanie drukarką domyślną”** (w ustawieniach Windows: Bluetooth i
   urządzenia → Drukarki i skanery); strona ostrzega, dopóki jest włączone.
7. W panelu (Ustawienia → Wysyłka i druk → Druk) przy każdej drukarce kliknij **Wydruk testowy**. Na A4 wyjdzie kartka z ramką,
   na termicznej etykieta; na obu nazwa stanowiska, rola, data i zdanie `zażółć gęślą jaźń`.
8. W karcie stanowiska, w sekcji **„Co na jakiej drukarce”**, wybierz drukarkę dla każdego rodzaju wydruku (karty
   zamówień, lista wysyłkowa, spis produktów, etykiety) i kliknij **„Zapisz przypisanie”**. Lista zawiera drukarki
   **wszystkich włączonych stanowisk firmy** („Komputer w biurze: A4 (HP)”, „Pakowanie: Termiczna 1 (Zebra), ten
   komputer”), więc etykiety mogą iść na termiczną przy pakowaniu, a karty na A4 podpiętą do komputera w biurze.
   Domyślnie papiery idą na A4, a etykiety na pierwszą termiczną tego komputera. Lista drukarek pochodzi
   z programów druku, nie z panelu: dopóki żaden się nie zgłosi, zamiast list jest zdanie o instalacji programu.
   Stanowisko bez własnego programu (drugi stół, tablet) dodajesz bez tokenu i wybierasz mu drukarki innych komputerów.

Późniejsze zmiany (nowy kod, inna drukarka, ostatnie zdarzenia, ponowne uruchomienie programu) robi się tym samym
skrótem, bez edycji plików. Gdy strona się nie otworzy, instalator dokończy w czarnym oknie (`Zainstaluj.cmd /konsola`).

Node.js ani SumatraPDF nie trzeba instalować: są w paczce.

### Na co dzień

- Zaznacz zamówienia → **Drukuj karty** (albo **Drukuj listę**). Gdy firma ma kilka stanowisk, obok przycisku
  i w nagłówku pakowania jest wybór stanowiska (przeglądarka pamięta jeden wybór dla wszystkich przycisków, także
  nadania przesyłki). Po kliknięciu: „Wysłano na: Komputer w biurze, A4” (komputer i drukarka, na których wyjdzie
  wydruk), potem „wydrukowano” albo błąd.
- Drukarka innego komputera: gdy tamten komputer jest wyłączony, bez tokenu albo nie odpowiada od 3 minut, zlecenie
  nie powstaje, a komunikat nazywa komputer i drukarkę. Na własnym komputerze zlecenie czeka jak dotąd (do 8 godzin).
- **Pobierz PDF** zostaje jako droga awaryjna (np. gdy komputer w magazynie nie działa).
- Ponowny druk karty to zwykłe nowe kliknięcie: karta dostaje nowy numer, stara przestaje pasować na stanowisku.
- Podwójne kliknięcie tego samego przycisku nie drukuje dwa razy.
- Zlecenie, którego nikt nie wydrukował w **8 godzin** (komputer wyłączony), **wygasa**: rano nie wyjdą wczorajsze
  kartki. Stan „wygasło” widać na liście „Ostatnie zlecenia”.
- Gdy termiczna nie działa (offline, brak etykiet), Kompletor sam wyśle etykietę na kolejną termiczną albo na A4
  (jako PDF). Gdy nie wiadomo, czy wydruk wyszedł (drukarka nie odpowiedziała), Kompletor **nie** drukuje drugi raz
 : sprawdź drukarkę i w razie potrzeby kliknij Drukuj ponownie.

| W nagłówku pakowania                     | Co zrobić                                                                   |
|------------------------------------------|-----------------------------------------------------------------------------|
| „brak stanu od N min”                    | Komputer w magazynie wyłączony, bez internetu albo program nie działa. Wyloguj się i zaloguj do Windows; jeśli nie pomoże: `Zainstaluj.cmd` jeszcze raz. |
| drukarka „offline” / „błąd: …”          | Zasilanie, kabel, papier lub etykiety, pokrywa. Stan odświeża się co minutę. |
| „w kolejce Windows: N”                   | Drukarka stoi: otwórz jej kolejkę w Windows i anuluj stare zadania.          |
| „program druku jeszcze się nie zgłosił”   | Instalacja nie została dokończona na tym komputerze.                        |
| „karty → Komputer w biurze: A4: nie wydrukuje” | Wybrane stanowisko drukuje ten rodzaj na drukarce innego komputera, a tamten jest wyłączony albo nie odpowiada (powód w podpowiedzi po najechaniu). |

Nagłówek pokazuje stanowisko wybrane na tym urządzeniu (przy kilku: lista do zmiany) i drukarki, których ono używa
według przypisań, także na innych komputerach.

Szczegóły obsługi programu na komputerze: `agent-druku/README.md`, sekcje 1–2.

### Aktualizacja, nowy token, wiele komputerów

- **Aktualizacja programu:** rozpakuj nową paczkę, uruchom jej `Zainstaluj.cmd`, przy pytaniu naciśnij Enter.
  Konfiguracja i rejestr wydruków zostają, zadanie w Harmonogramie jest jedno. Rób to, gdy nic się nie drukuje.
- **Nowy token** (wyciek, nowy komputer): Ustawienia → Wysyłka i druk → Druk → „Nowy token”. Poprzedni przestaje działać **od razu**.
  Na komputerze: `Zainstaluj.cmd /nowy` i wklej nowy kod.
- **Unieważnij token / Wyłącz stanowisko:** komputer od razu dostaje odmowę; wyłączone stanowisko znika z wyboru.
  Gdy inne stanowiska drukują na drukarkach wyłączanego, okno potwierdzenia wymienia je z rodzajami wydruków.
- **Wiele komputerów:** każdy ma własne stanowisko i własny kod. **Dwa komputery z tym samym kodem to błąd
  konfiguracji**: oba pobierałyby te same zlecenia, a stan drukarek przeskakiwałby między nimi. Panel tego dziś nie
  wykrywa.

---

### Druk wielu etykiet z listy przesyłek

Menu → „Przesyłki” → zaznacz przesyłki → „Drukuj etykiety” → wybierz stanowisko. Każda etykieta to osobne zlecenie
druku (typ „Etykieta”, drukarka z przypisania stanowiska, zwykle termiczna) w kolejności z listy. Etykieta bierze się
z pliku zapisanego przy tworzeniu przesyłki, przewoźnik nie dostaje żadnego zapytania. Od 10 przesyłek druk idzie
w tle z paskiem postępu nad listą i raportem „wydrukowano N, pominięto M” (powód przy każdej pominiętej: brak
etykiety, przesyłka anulowana albo jeszcze tworzona, konto przewoźnika z wyłączonym nadawaniem). Pominięta przesyłka
nie zostawia zlecenia z błędem w kolejce stanowiska. Ponowienie tej samej akcji (wznowienie po awarii) nie drukuje
drugi raz; nowe kliknięcie drukuje ponownie. „Drukuj” w wierszu listy drukuje jedną etykietę na pierwszym stanowisku
firmy. Etykieta PDF na drukarce termicznej drukuje się 1:1 (bez skalowania), jak przy etykiecie z karty zamówienia.

## Część 2. Dla programisty

### Model danych (migracja `20261104230000_serwer_druku`)

| Tabela         | Co trzyma                                                                                                 |
|----------------|-----------------------------------------------------------------------------------------------------------|
| `PrintStation` | stanowisko: `code` (= `stanowisko` u agenta, unikalny w firmie), `name`, `tokenHash` (SHA-256, unikalny globalnie; null = brak tokenu), `tokenCreatedAt`, `routing` (typ → rola), `printers` (ostatni `RaportStanu.drukarki`), `agentVersion`, `lastReportAt` (czas serwera), `disabledAt` |
| `PrintJob`     | zlecenie: `type` (`karta`/`lista`/`spis`/`etykieta`), `source` (`PANEL`/`TEST`/`ZAPAS`), `role` (tekst), `format` (plik dla agenta), `copies`, `status` (`PRZYGOTOWANIE`/`OCZEKUJE`/`OK`/`BLAD`/`WYGASLO`), `idempotencyKey` (unikalny w firmie), `fallbackOfId` (unikalny), `summary` (opis bez danych klientów), `resultMessage`, `resultPrinter`, `reportedAt`, `requestedBy`, `orderIds`, `expiresAt`, `createdAt`; id = cuid (mieści się we wzorze id agenta) |
| `PrintJobFile` | bajty pliku zlecenia (`format` `pdf`/`zpl`, `data`); osobno, bo etykieta ma dwie wersje, a lista zleceń nie czyta bajtów |

Wszystkie trzy: `organizationId` z `current_setting('app.org_id')`, RLS `org_isolation`, GRANT dla `logistyka_app`.
Bajty plików zakończonych zleceń (karty i listy mają dane zamówień) usuwa zadanie workera **`druk-sprzatanie`**
(co godzinę, `lib/worker/zadania.ts`) po **7 dniach**; wiersz `PrintJob` zostaje jako historia. To samo zadanie
wygasza zlecenia bez agenta.

Kod: `lib/druk/`: `role.ts` (wzór ról, routing, zgodność), `tokeny.ts` (token, bramka, limity; jedyne miejsce
z klientem systemowym), `zlecenia.ts` (kolejka, wynik, zapas, wygasanie, sprzątanie), `agent-api.ts` (logika tras
agenta, walidacja), `panel.ts` (druk z panelu, stan, wydruk testowy), `stanowiska.ts` (Ustawienia → Wysyłka i druk → Druk),
`etykieta.ts` (źródło etykiety: atrapa), `wydruk-testowy.ts`, `zpl.ts`.

### Trasy

Agent: **wyłącznie** pod `/api/druk/*`, token stanowiska `Authorization: Bearer kmd_<43 znaki base64url>`. Ścieżka
otwarta w `OPEN_PATHS` (`lib/basic-auth.ts`) i `PUBLIC` (`proxy.ts`): agent nie ma ciasteczka, a na stagingu nagłówek
`Authorization` zajmuje Bearer, więc nie może podać hasła Basic. Bramką jest `requireStationToken` w każdej trasie
(strażnik w `tests/panel-dostep.integration.test.ts`).

| Trasa                                   | Co robi                                                                       |
|-----------------------------------------|-------------------------------------------------------------------------------|
| `GET /api/druk/zlecenia?stanowisko=`    | `OCZEKUJE`, niewygasłe, w kolejności tworzenia, najwyżej 50; tylko pola kontraktu; `plikUrl` = `/api/druk/pliki/<id>`; przy okazji oznacza przeterminowane `WYGASLO` |
| `GET /api/druk/pliki/<id>`              | plik zlecenia tego stanowiska w formacie zlecenia, póki czeka; `Cache-Control: no-store`, bez przekierowań; cudze/zakończone = 404 |
| `POST /api/druk/zlecenia/<id>/wynik`    | pierwszy wynik wygrywa, powtórzenie = 200 bez zmian; wygasłe też przyjmuje wynik; treść ≤ 16 KB; `komunikat` przycięty do 500 znaków; rola z raportu ignorowana (o awarii decyduje rola zlecenia) |
| `POST /api/druk/stan`                   | `printers`, `agentVersion`, `lastReportAt` = czas serwera; brak raportu 3 min = „agent nie działa” |

Token nieznany / unieważniony / zły format / stanowisko wyłączone / firma nieaktywna = ta sama odpowiedź 401.
`stanowisko` inne niż `code` tokenu = 403. Limity w pamięci procesu (`SlidingLimiter`): 30 nieudanych prób z IP
na 10 minut (potem 429 dla każdego **nieznanego** tokenu z tego adresu do końca okna; ważny token przechodzi, bo
stanowiska za jednym NAT-em dzielą adres i stary agent po „Nowy token” nie może odciąć pozostałych),
240 żądań na minutę na stanowisko. Agent 0.2.0+ po 401/403 pyta tylko co 5 min, po 429 czeka `Retry-After`.
Tokenu ani nagłówków nie logujemy.

Panel: sesja, pod `/api/wydruki/*`:

| Trasa                                | Uprawnienie                                         | Co robi |
|--------------------------------------|-----------------------------------------------------|---------|
| `POST /api/wydruki/zlecenia`         | `panel.podglad`; karta i etykieta + `pakowanie.stanowisko` | `{ typ, z, stanowisko, klucz, informacyjne? }`; `Sec-Fetch-Site` jak w trasie kart |
| `GET /api/wydruki/zlecenia/<id>`     | `panel.podglad`                                     | stan zlecenia (i zapasu) do odpytywania po kliknięciu |
| `GET /api/wydruki/stan`              | `panel.podglad`                                     | stanowiska i drukarki; bez sesji/uprawnienia 200 z pustą listą (bez błędu w konsoli) |
| `GET /api/wydruki/program`           | `panel.podglad` + `ustawienia` (jak ekran Druk)     | paczka programu z `AGENT_DRUKU_KATALOG` (niżej, „Paczka programu”); 401 bez sesji, 404 bez uprawnienia albo bez pliku |

### Karty jako PDF i błędy

`POST /api/wydruki/karty` (formularz, pole `z`; z listy zamówień i karty zamówienia także `informacyjne=1`) zwraca
PDF z nagłówkami `x-karty` (kody kart do zbierania), `x-karty-pominiete` (kolejka pakowania: pominięte) albo
`x-karty-informacyjne` (lista: wydruki informacyjne). Błąd (400, 401, 403, 404, 409, 422) dla przeglądarki, czyli
żądania z `Accept` zawierającym `text/html`, to strona HTML po polsku („Nie udało się wydrukować kart”, co zrobić,
„Wróć do zamówień”, „Zamknij kartę”); `fetch` bez `text/html` w `Accept` dostaje JSON `{ error }` jak dotąd. Tak
samo `GET /api/wydruki/lista-wysylkowa`. Kod: `lib/panel/blad-wydruku.ts`.

### Kolejność przy druku kart (efekt uboczny)

1. Rezerwacja `PrintJob` ze statusem `PRZYGOTOWANIE` i kluczem kliknięcia (unikalny w firmie). Istnieje = zwracamy
   istniejące zlecenie **bez drugiego `drukujKarty`**: nowy numer wydruku unieważniłby kartę w koszyku.
2. `drukujKarty` (`lib/stanowisko/karty.ts`): `OrderCardPrint`, NA SUCHO, pomijanie zamówień bez stanu i wysłanych.
   Pominięte wracają w odpowiedzi. Z listy zamówień i karty zamówienia (`informacyjne: true` w treści)
   nic nie jest pomijane: takie zamówienia (i bez numeru do kodu karty) dostają wydruk informacyjny bez kodu i bez
   wiersza w rejestrze, a ich numery wracają w polu `informacyjne`.
3. Bajty i `OCZEKUJE` w jednej transakcji, dopiero po narysowaniu. Błąd rysowania = `BLAD` z komunikatem, agent
   niczego nie dostaje.

### Zapas i wygasanie

- Zapas tylko przy `BLAD` z `rolaZapasowa` i tylko na rolę z **ostatniego raportu stanowiska**: nowe zlecenie
  `ZAPAS`, nowe id, `fallbackOfId` = oryginał, te same bajty, ta sama ważność. Na rolę nietermiczną idzie PDF.
  Podwójny raport nie tworzy drugiego zapasu (warunkowa zmiana statusu w transakcji + unikalny `fallbackOfId`).
  Zapas zapasu tylko na drukarkę nietermiczną (koniec łańcucha, bez krążenia T1 ↔ T2).
- Bez `rolaZapasowa` (przekroczony czas, „Druk przerwany…”) zapasu nie ma: mogłyby wyjść dwie etykiety; komunikat
  idzie do panelu, ponowny druk to świadomy klik.
- `expiresAt` = utworzenie + 8 h. Wygasłe = `WYGASLO`, agent ich nie dostaje; wynik dla wygasłego jest przyjmowany
  (stan fizyczny ma pierwszeństwo), ale bez zapasu.

### Role i zgodność wersji agenta

Zmiana kontraktu (tylko ta, §3): rola to tekst `^A4(_[0-9]{1,2})?$|^TERMICZNA_[0-9]{1,2}$` zamiast trzech
stałych. `A4`, `TERMICZNA_1`, `TERMICZNA_2` bez zmian. Agent 0.2.0: termiczna = prefiks `TERMICZNA_`, ZPL odrzucany
na każdej roli nietermicznej, `rolaZapasowa` = kolejna działająca termiczna z konfiguracji, na końcu `A4`.

**Serwer zleca tylko role z ostatniego raportu stanu tego stanowiska**: agent 0.1.0 nigdy nie dostanie roli, której
nie zna. Brak raportu albo roli = czytelny komunikat w panelu, zlecenie nie powstaje. Wydruk testowy używa typów
z istniejącego kontraktu (`lista` na zwykłej, `etykieta` na termicznej), więc przyjmie go także 0.1.0.

Routing domyślny: `karta`, `lista`, `spis` → `A4`; `etykieta` → `TERMICZNA_1`; zmiana w Ustawienia → Wysyłka i druk → Druk (lista ról
z raportu). Typ `spis` obsługuje kolejka i routing, ale przycisku w panelu nie ma (spis produktów nie ma dziś trasy).

### Drukarki innych komputerów

Bez migracji i bez zmian w programie druku. Wartość w `PrintStation.routing` na rodzaj wydruku:

- `"A4"` (sama rola, stary kształt): drukarka tego samego stanowiska, zasady jak wyżej;
- `{ "stanowisko": "<id PrintStation>", "rola": "A4" }`: drukarka innego stanowiska tej samej firmy. Wskazanie
  samego siebie zapisuje się jako sama rola. Niepoprawny wpis = rola domyślna na własnym komputerze.

Odczyt: `przypisaniaStanowiska` (lib/druk/role.ts); `routingStanowiska` zwraca dalej same role. Formularz wysyła
`rola` albo `<id>:<rola>` (`parsujWartoscPrzypisania`).

- **Zapis** (`ustawRouting`): inne stanowisko tylko z tej samej firmy (klient z RLS nie widzi cudzych, a
  `organizationId` porównujemy jeszcze raz jawnie), włączone i z tą rolą w ostatnim raporcie. Wpis bez zmiany przechodzi.
- **Zlecenie** (`utworzZlecenie`, wszystkie wejścia: panel, nadanie przesyłki, akcje masowe, automaty): wybrane
  stanowisko musi być włączone; dla wpisu z innym stanowiskiem serwer czyta je jeszcze raz (RLS + `organizationId`)
  i odmawia (409, komunikat z nazwą komputera i drukarki), gdy jest wyłączone, nie ma tokenu, nie raportuje od 3 minut
  albo nie ma tej roli w ostatnim raporcie. Zlecenie powstaje od razu z `stationId` komputera z drukarką: tylko jego
  program druku je widzi, pobiera i raportuje, a zapas po awarii działa w jego obrębie według zasad z „Zapas i
  wygasanie” (bez zmian). Wybrane stanowisko nie musi mieć programu druku, gdy wszystkie jego wydruki idą na inne komputery.
- **Idempotencja:** klucz kliknięcia jak dotąd; powtórzenie z tym samym kluczem jest zgodne, gdy `stationId`
  zlecenia = wybrane stanowisko albo stanowisko z jego przypisania.
- **Wydruk testowy** (`rola` jawna) zawsze na drukarkę tego komputera, bez przypisań.
- **Panel:** `stanowiskaDlaPanelu` zwraca `przypisania`, `uzywane` (drukarki faktycznie używane, ze stanem i powodem
  błędu) i `maProgram`; `StatusZlecenia.cel` = „Komputer w biurze, A4”.

### Kod instalacyjny i adres serwera

Kod = `kmi_` + base64url z `{ "serwer", "stanowisko", "token" }`, pokazany raz obok tokenu. Aplikacja nie ma dziś
zmiennej z własnym adresem, więc **adres serwera bierzemy z nagłówków żądania**, którym administrator otworzył panel:
`X-Forwarded-Host` / `X-Forwarded-Proto` (Traefik w Coolify), inaczej `Host` (https poza localhost). Konsekwencja:
kod utworzony z panelu otwartego pod innym adresem (np. wewnętrznym) wskaże ten adres: twórz kod z panelu otwartego
pod adresem, pod którym komputer w magazynie widzi serwer. Gdy instalator nie może połączyć się z serwerem, mówi to
przy wklejaniu kodu. Kod z adresem `http://` poza `localhost`/`127.0.0.1`/`[::1]` instalator odrzuca (token szedłby
siecią otwartym tekstem), a panel przy tworzeniu takiego kodu pokazuje ostrzeżenie.

### Etykieta próbna

`lib/druk/etykieta.ts`: interfejs `ZrodloEtykiety` i jedna implementacja: **atrapa** z `PreparedShipment` (numer
zamówienia, paczka, przewoźnik, gabaryt, waga, pobranie), ZPL `^CI28` i PDF 100×150 mm, z napisem
„PRÓBA: NIE NADAWAĆ”, **bez kodu kreskowego**. Bez sieci i Base Courier, bez zmian w zamówieniu, rezerwacjach,
stanach i `PreparedShipment`. Prawdziwa etykieta w trybie PRACA = późniejsza implementacja tego interfejsu.

### Paczka programu (`AGENT_DRUKU_KATALOG`, `AGENT_DRUKU_URL`)

```
cd agent-druku && npm ci
npm run paczka                          # pobiera node.exe i SumatraPDF, sprawdza SHA-256 z skrypty/wersje-paczki.json
npm run paczka -- --runtime <katalog>   # bez pobierania: node.exe, SumatraPDF.exe, opcjonalnie LICENSE-node.txt, COPYING-sumatra.txt
```

Wynik: `agent-druku/wydanie/Kompletor-Druk-<wersja>-win-x64.zip` (Zainstaluj.cmd w korzeniu, runtime, SumatraPDF
portable, licencje Node i SumatraPDF (GPLv3) z adresem źródeł przypiętej wersji). Niezgodna suma = błąd. Binariów nie
ma w repo. Gotowy ZIP udostępnia się na jeden z dwóch sposobów (`.env.example`):

- **`AGENT_DRUKU_KATALOG`** (domyślna droga): katalog na serwerze aplikacji, najlepiej trwały wolumen kontenera web.
  Wgrywa się do niego ZIP bez zmiany nazwy. Aplikacja serwuje go pod `GET /api/wydruki/program`: tylko zalogowanym
  z uprawnieniem „Ustawienia firmy” (`ustawienia`, jak ekran Druk), strumieniem, z `Content-Type: application/zip`,
  `Content-Disposition: attachment`, `Content-Length` i `Cache-Control: no-store`. Liczą się wyłącznie zwykłe pliki
  o nazwie `Kompletor-Druk-<x.y.z>-win-x64.zip` (inne pliki, podkatalogi i dowiązania są pomijane), przy kilku
  wygrywa najwyższa wersja; nazwy pliku nie ma w żądaniu. Nowa wersja = wgranie nowego ZIP-a obok, bez restartu.
  Brak zmiennej, katalogu albo pliku = brak przycisku na ekranie i 404 trasy. Kod: `lib/druk/paczka.ts`.
- **`AGENT_DRUKU_URL`**: adres zewnętrzny (np. magazyn plików firmy). Ustawiony ma pierwszeństwo przed katalogiem;
  przycisk prowadzi wtedy wprost pod ten adres (bez wersji i rozmiaru na przycisku).

Bez obu ekran Ustawienia → Wysyłka i druk → Druk pokazuje wyszarzony przycisk z instrukcją.

Wybór: ZIP z gotowym runtime, nie pojedynczy exe (Node SEA): i tak trzeba rozpakować SumatraPDF i skrypty
PowerShell, a niepodpisany samorozpakowujący się exe częściej zatrzymuje antywirus.

### Testy

- `tests/druk.integration.test.ts`: trasy agenta (przez tę samą logikę co pliki tras), tokeny (401/403/429),
  idempotencja wyniku, zapas (także dwa raporty naraz), ZPL → A4 jako PDF, wygasanie, sprzątanie, druk z panelu
  (podwójny klik = jeden `OrderCardPrint`, błąd PDF nie wypuszcza zlecenia), etykieta próbna, izolacja dwóch firm.
- `tests/druk-obieg.integration.test.ts`: **cały obieg na prawdziwym kodzie agenta**: klasy `Agent`, `KlientSerwera`,
  `RejestrWydrukow` z `agent-druku/src` i `AtrapaDrukarek` z `agent-druku/test/atrapy.ts` kontra prawdziwe funkcje
  serwera. Pakiety dało się połączyć bez odwzorowania: źródła agenta nie mają zależności, więc vitest głównego repo
  importuje je wprost, a `KlientSerwera` dostaje `fetch` kierujący na logikę tras (`tests/druk-pomocnicze.ts`).
  Poza testem zostają warstwa HTTP Next i Windows.
- `proxy.test.ts`: `/api/druk` przechodzi bramkę Basic na stagingu, panel i `/api/wydruki` dalej nie.
- `agent-druku/test/`: 4 termiczne, `A4_2`, wzór ról, kod instalacyjny, przydział ról, ZIP paczki.

---

## Krok po scaleniu (administrator, lokalnie, na komputerze w magazynie)

1. Zbudować paczkę: `cd agent-druku && npm ci && npm run paczka` (gdy suma SumatraPDF jest jeszcze `[NIEPEWNE]`:
   sprawdzić ją i wpisać do `skrypty/wersje-paczki.json` albo `npm run paczka -- --runtime <katalog>`).
2. W panelu: Ustawienia → Wysyłka i druk → Druk → dodać stanowisko, „Utwórz token i kod instalacyjny”.
3. Na komputerze w magazynie uruchomić `Zainstaluj.cmd` z rozpakowanej paczki, wkleić kod, przypisać drukarki.
4. Wydruk testowy na A4 i na **każdej** termicznej (polskie znaki na etykiecie ZPL).
5. Wydrukować kartę testowego zamówienia (Pakowanie → zaznacz → Drukuj karty) i etykietę próbną.
6. Przejść listę z `agent-druku/README.md`, sekcja 8 (m.in. odłączenie termicznej → „offline” i zapas, ponowne
   `Zainstaluj.cmd` = aktualizacja bez zmiany konfiguracji, jedno zadanie w Harmonogramie).

## [NIEPEWNE]: do sprawdzenia lokalnie

1. ~~SumatraPDF 3.5.2~~ **sprawdzone (10.11.2026)**: adres i nazwa pliku w ZIP poprawne; autor nie publikuje
   sum, więc suma ZIP potwierdzona manifestem winget, suma `.exe` pakietem Chocolatey i podpisem Authenticode autora
   (szczegóły w `wersje-paczki.json`, pole `zrodloSumy`). Nowsza wersja: 3.6.1 (przypięcie w tym samym pliku).
2. **Skrypty PowerShell — sprawdzone na Windows 11**: paczka z ZIP-a ze znacznikiem „z internetu”,
   kopia do folderu programu, `Unblock-File`, Node z paczki, `--instaluj` (kod, lista drukarek, „P” = kartka próbna,
   zapis), `--sprawdz-konfig`, zadanie Harmonogramu (bez limitu czasu), start w tle i pierwszy raport stanu,
   ponowne `Zainstaluj.cmd` = aktualizacja, `odinstaluj.cmd`. Wydruk testowy A4, karta zamówienia i etykieta próbna
   100×150 mm (`noscale`, 1:1) wyszły na wirtualne drukarki PDF. Nie sprawdzone: pierwsza instalacja wklejaniem kodu
   w prawdziwym oknie konsoli (próba szła przez potok) i ostrzeżenie SmartScreen przy dwukliku w Eksploratorze.
3. **Polskie znaki na termicznej** (ZPL `^CI28` z czcionką `^A0`): czy drukarka pokazuje `ąęłńóśźżĄĘŁŃÓŚŹŻ`.
4. **Adres serwera w kodzie instalacyjnym** z nagłówków `X-Forwarded-*` za Coolify/Traefik.
5. **Kopiowanie do `C:\Kompletor`** bez uprawnień administratora na komputerze w magazynie (domyślnie Windows na to
   pozwala; zasady firmowe mogą to blokować).
