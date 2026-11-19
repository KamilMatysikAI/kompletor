# Instalacja

Jak postawić Kompletora na własnym komputerze albo serwerze, zrobić kopię zapasową i wystawić panel przez HTTPS.

## Zanim zaczniesz

Przeczytaj [Co jeszcze nie działa](co-jeszcze-nie-dziala.md). W skrócie:

- Kompletor czyta zamówienia i liczy rezerwacje. Niczego nie zmienia w Twoich sklepach.
- Twój obecny system (na przykład BaseLinker) dalej musi wysyłać stany, zmieniać statusy, tworzyć przesyłki i wystawiać faktury.
- Dane odbiorców (adresy, telefony, e-maile) system zapisuje dopiero po włączeniu `DANE_KLIENTA_ZAPIS=1` i dopisaniu kluczy, zaszyfrowane osobnym kluczem (`docs/dane-klienta.md`).

Twarde wymagania:

- Komputer albo serwer włączony cały czas. Zamówienia czyta proces w tle. Gdy maszyna śpi, odczyt stoi.
- Docker z poleceniem `docker compose` (Docker Compose w wersji 2).
- Pamięć: działający system zajmuje ok. 0,3–0,5 GB (pomiar: jedna mała firma, niżej), więc dla jednej małej firmy wystarczy 1 GB RAM z trybem lekkim, zalecamy 2 GB.
  Budowanie obrazu na miejscu potrzebuje więcej: do 4 GB pamięci dla Node. Szczegóły w „Wymagania sprzętowe”.
- Miejsce na dysku na bazę danych i kopie zapasowe.
- Dostęp do internetu do API Twoich sklepów.
- Do pracy z innego komputera: własna domena i HTTPS (opis niżej).

## Pierwsze uruchomienie

1. Pobierz kod do katalogu, na przykład `kompletor`:

   ```
   git clone <adres repozytorium> kompletor
   cd kompletor
   ```

2. Uruchom system. Plik `.env` nie jest potrzebny:

   ```
   docker compose up -d
   ```

3. Poczekaj, aż kontenery wstaną. Przy starcie system sam zakłada i aktualizuje bazę. Potem wyświetl log panelu:

   ```
   docker compose logs web
   ```

   W logu znajdziesz adres z jednorazowym kodem. Otwórz go w przeglądarce na tym samym komputerze.

4. Kreator `/start` pyta o nazwę firmy, Twoje imię, e-mail i hasło. To konto właściciela firmy.

Panel działa pod adresem `http://127.0.0.1:3000`. Port jest otwarty tylko na tym komputerze. Inny port ustawisz zmienną `KOMPLETOR_PORT`.

Stan systemu sprawdzisz tak:

```
curl http://127.0.0.1:3000/api/health
```

Pole `status` ma wartość `ok`, `degraded` (działa, ale coś wymaga uwagi, na przykład konto sklepu nie czyta zamówień) albo `error` (brak bazy albo zła konfiguracja kluczy).

## Demo

Chcesz najpierw obejrzeć panel na zmyślonych danych? W kreatorze kliknij „Najpierw zobacz demo”. Ze zmienną `KOMPLETOR_SEED=demo` przy starcie demo powstaje bez kreatora: konto `demo@kompletor.test`, hasło raz w `docker compose logs web`, przy pierwszym logowaniu panel poprosi o nowe. Dane demo są fikcyjne i nie łączą się z żadnym sklepem. Hasło zostaje w logu kontenera, więc demo nie wystawiaj na świat.

Gdy obejrzysz demo, załóż własną firmę bez terminala: **Pulpit** firmy demo → karta „To jest firma demo z danymi
fikcyjnymi” → wpisz nazwę firmy → **Utwórz własną firmę**. Widzi to właściciel firmy demo, dopóki na instalacji nie
ma innej firmy. Twoje konto zostaje to samo, a panel przechodzi do nowej firmy. Firma demo domyślnie znika
z przełącznika firm (dane fikcyjne zostają w bazie); przełącznik „Zostaw firmę demo do podglądu” ją zostawia, ale
wtedy klucze z pliku `.env` nie działają dla nowej firmy (działają tylko przy jednej aktywnej firmie), więc klucze
wpisuj w panelu. Kolejne firmy na tej samej instalacji zakłada administrator poleceniem `org:create`. W hostingu
też `org:create`: publicznej rejestracji jeszcze nie ma ([Co jeszcze nie działa](co-jeszcze-nie-dziala.md)).

## Własny preset firmy

Firma, która przenosi się z innego systemu, może zamiast klikania w kreatorze podać gotowy plik ustawień (preset):
konta sklepów, magazyn, reguły przewoźników, strefy, statusy zamówień i automatyczne akcje. Wzór z opisem pól leży
w repo: `seed/presety/przyklad.json`. Plik firmy nie trafia do repozytorium ani do obrazu Dockera: trzymasz go
u siebie i podajesz przy starcie. Klucze API nie idą do presetu, tylko do sekretów firmy.

1. Skopiuj `seed/presety/przyklad.json` do katalogu `prywatne/presety/` w klonie (np. `prywatne/presety/moja-firma.json`)
   i uzupełnij. Katalog `prywatne/` jest pominięty przez git i przez budowę obrazu.
2. Zamontuj plik do kontenera i wskaż go zmienną. Najprościej plikiem `compose.override.yaml` obok `compose.yaml`:

   ```yaml
   services:
     web:
       volumes:
         - ./prywatne/presety/moja-firma.json:/app/prywatne/presety/moja-firma.json:ro
       environment:
         KOMPLETOR_SEED: moja-firma
   ```

   Zamiast nazwy możesz podać pełną ścieżkę pliku w kontenerze: `KOMPLETOR_PRESET_PLIK=/konfiguracja/firma.json`
   (wygrywa z nazwą). Bez Dockera: `npm run org:seed -- moja-firma` czyta `prywatne/presety/moja-firma.json`.
3. `docker compose up -d`. Seed jest idempotentny: przy kolejnych startach niczego nie nadpisuje, a ustawienia
   kont uzupełnia tylko w pustych polach. Zmiany robisz potem w panelu.

Tabela nadpisań powiązań ofert (oferty powiązane w starym systemie po fakcie, plik `<id firmy>.csv` w formacie
`kanal;konto;id_oferty;sku;uwagi`) działa tak samo: plik w `prywatne/nadpisania-ofert/<id firmy>.csv`, w kontenerze
montowany do `/app/prywatne/nadpisania-ofert/` (web i worker) albo do dowolnego katalogu wskazanego zmienną
`KOMPLETOR_NADPISANIA_KATALOG`. Bez pliku import katalogu działa, po prostu bez nadpisań.

## Zatrzymanie

```
docker compose stop
```

Ponowny start: `docker compose start`. Dane zostają w wolumenach Dockera.

`docker compose down` usuwa kontenery, ale zostawia dane. Nie używaj `docker compose down -v`: ta opcja kasuje wolumeny, czyli bazę i klucze.

## Aktualizacja

Jedno polecenie w katalogu z Kompletorem:

```
sh scripts/aktualizuj.sh
```

Skrypt robi po kolei i zatrzymuje się na pierwszym błędzie:

1. **Kopia bazy** do katalogu `kopie/` (plik `kompletor-RRRRMMDD-GGMMSS.dump`). System pracuje w tym czasie. Kopia jest od razu sprawdzana, czy daje się odczytać. Brak miejsca na dysku albo nieudana kopia = stop, nic nie zostaje zmienione.
2. **Nowy kod** (`git pull`). Gdy nie ma nowej wersji, skrypt kończy na kopii. Gdy masz lokalne zmiany w plikach repozytorium, skrypt prosi, żeby je najpierw zapisać albo cofnąć.
3. **Budowa obrazu**. Stara wersja działa do końca budowy, więc przerwa w pracy trwa tylko tyle, co restart.
4. **Restart**. Przy starcie system sam aktualizuje bazę. Gdy aktualizacja bazy się nie uda, kontener nie wstaje i nie pracuje na niezgodnej bazie.
5. **Sprawdzenie**: skrypt czeka do 5 minut, aż `/api/health` pokaże działający panel bez zaległych migracji, a kolejka (`worker`) będzie zdrowa.

Gdy coś pójdzie nie tak, skrypt wypisze, co dalej: gdzie szukać przyczyny, co zrobić po nieudanej aktualizacji bazy i jak wrócić do poprzedniej wersji (kod i baza z kopii zrobionej w kroku 1). Bazy sam nie cofa: to Twoja decyzja.

Powrót do poprzedniej wersji (ręcznie, także po udanej aktualizacji; NADPISUJE bazę kopią, zmiany od aktualizacji przepadają). Plik kopii i poprzedni commit są w `kopie/` (`wersje-przed-aktualizacja.txt`):

```
docker compose stop web worker
docker compose exec -T db pg_restore -U kompletor -d postgres --clean --if-exists --create < "kopie/kompletor-RRRRMMDD-GGMMSS.dump"
git reset --hard <poprzedni commit>
docker compose up -d --build
```

Baza powstaje od nowa z kopii, więc znikają też tabele dodane przez nową wersję. Inna nazwa projektu albo tryb lekki: dodaj `-p <projekt>` albo ustaw `COMPOSE_FILE` jak przy aktualizacji.

Opcje: `--tylko-kopia` (sama kopia bazy, na przykład przed ręczną zmianą), `--bez-pobierania` (kod podmieniony inaczej niż `git pull`). Inny port panelu: `KOMPLETOR_PORT=3001 sh scripts/aktualizuj.sh`. Katalog `kopie/` nie trafia do repozytorium ani do obrazu i jest dostępny tylko dla Twojego konta na serwerze (kopie mają dane klientów). Stare kopie skrypt zostawia: przenieś je w inne miejsce, gdy zajmują za dużo (przy braku miejsca skrypt pokaże, ile ich jest). Nieudana kopia zostaje jako `*.dump.niepelny`.

Ręcznie, bez skryptu: zrób kopię zapasową (niżej), `git pull`, potem `docker compose up -d --build`. Obraz zawsze powstaje z repozytorium (`docker compose pull` nie ma czego pobrać).

Na Windows uruchom skrypt w Git Bash albo WSL.

## Diagnostyka

Coś nie działa albo chcesz wysłać zgłoszenie? Uruchom:

```
sh scripts/diagnostyka.sh > diagnostyka.txt
```

Raport pokazuje: wersję kodu, odpowiedź `/api/health`, stan kontenerów, zużycie pamięci i procesora, migracje bazy, miejsce na dysku (dysk, baza, wolumen), kolejkę zadań (ile czeka, ile się nie udało, najstarsze czekające), ostatnie nieudane zadania i błędy z logów panelu i workera z ostatniej doby (`KOMPLETOR_LOGI_OD=7d` zmienia okres).

Skrypt tylko czyta i nie zbiera sekretów: nie zagląda do wolumenu sekretów ani do zmiennych środowiska kontenerów. Treść błędów przechodzi przez filtr, który zakrywa adresy e-mail, hasła w adresach baz, tokeny, klucze API i numery telefonów. Mimo to przejrzyj plik przed wysłaniem (raport przypomina o tym w pierwszej linii): filtr zakrywa typowe zapisy, także JSON i wielkie litery, ale nie zna nazw Twoich klientów ani nietypowych formatów.

## Wymagania sprzętowe

Pomiar z 9 listopada 2026 na czystej instalacji z firmą demo (Docker na WSL 2, procesor 4 rdzenie, `docker stats`):

| Sytuacja | Panel (`web`) | Kolejka (`worker`) | Baza (`db`) | Razem |
|---|---|---|---|---|
| Pierwszy start w trybie lekkim (migracje bazy, firma demo) | do 100 MB, procesor do 1,7 rdzenia | 120 MB | do 50 MB | ok. 0,27 GB |
| Spoczynek po starcie | 100–170 MB | 120–145 MB | 30–50 MB | ok. 0,3 GB |
| Import 8 000 zamówień (8 naraz) | 105 MB | 125 MB | do 80 MB, procesor ok. 1 rdzeń | ok. 0,3 GB |
| Tryb lekki: import 8 000 zamówień i 4 000 odsłon panelu (20 naraz) | do 145 MB, procesor do 1,7 rdzenia | do 120 MB | do 90 MB | ok. 0,35 GB, bez restartów |
| Budowanie obrazu (`docker compose build`) | sterta Node do 4 GB (ustawienie w `Dockerfile`, nie mierzone) | | | do ok. 4 GB |

Wnioski:

- **Dla jednej małej firmy wystarczy 1 GB RAM** z trybem lekkim (niżej), wygodnie 2 GB. To wniosek z pomiaru wyżej: jedna firma demo, import 8 000 zamówień, odsłony panelu. Nie mierzyliśmy wysyłki do KSeF, generowania PDF (etykiety, faktury) ani importu dużego katalogu produktów; te prace mogą potrzebować więcej. Limity trybu lekkiego sumują się do ok. 1,4 GB (baza 384 MB, panel i worker po 512 MB), więc przy 1 GB system zwykle mieści się w pamięci tylko dlatego, że faktycznie zużywa mniej. Najwięcej pamięci zajmuje Node panelu i workera (po ok. 100–150 MB), sama baza mało.
- **Budowanie obrazu jest najcięższe.** Na serwerze z 1–2 GB RAM zbuduj obraz na innym komputerze albo dodaj plik wymiany (swap) na czas budowy.
- Procesor: 1 rdzeń wystarcza, import korzysta z drugiego.
- Dla porównania: programy z jednym procesem Node i bazą SQLite w pliku (na przykład TwojOMS) nie mają osobnej bazy ani drugiego procesu, więc potrzebują mniej pamięci (ich zużycia nie mierzyliśmy). Kompletor ma osobny proces kolejki (praca w tle nie spowalnia panelu) i Postgresa (wiele firm, wiele osób naraz, kopie bez zatrzymywania systemu). Połączenie workera z panelem w jednym kontenerze nie zmniejsza pamięci, bo to nadal dwa procesy Node, więc tego nie robimy.

### Tryb lekki

Na małym serwerze (1–2 GB RAM) uruchom system z nakładką `compose.lekki.yaml`:

```
docker compose -f compose.yaml -f compose.lekki.yaml up -d
```

Nakładka zmniejsza bufor bazy (64 MB zamiast 128 MB) i liczbę połączeń (50 zamiast 100), ogranicza pamięć Node panelu i workera (256 MB) i ustawia limity kontenerów: baza 384 MB, panel i worker po 512 MB. Niczego nie zmienia w danych: start bez nakładki wraca do ustawień domyślnych. Używasz trybu lekkiego, to `aktualizuj.sh` też uruchamiaj z nim: `COMPOSE_FILE=compose.yaml:compose.lekki.yaml sh scripts/aktualizuj.sh` (na Windows separator `;`).

Nie używaj trybu lekkiego przy kilku firmach na jednej instalacji i przy bardzo dużych katalogach (dziesiątki tysięcy produktów). Gdy w `docker compose ps` widzisz kod wyjścia 137, kontener przekroczył limit: uruchom bez nakładki albo zwiększ limity we własnej kopii pliku.

## Kopie zapasowe

Dane są w dwóch wolumenach Dockera:

- `pg_data`: baza danych (zamówienia, produkty, stany, ustawienia, zaszyfrowane klucze sklepów),
- `sekrety`: klucz, którym zaszyfrowane są klucze sklepów w bazie.

Nazwa wolumenu na dysku ma przedrostek z nazwy katalogu projektu, na przykład `kompletor_pg_data`. Sprawdzisz ją poleceniem `docker volume ls`.

Kopia (system stoi kilkanaście sekund):

```
docker compose stop
docker run --rm -v kompletor_pg_data:/dane:ro -v "$PWD":/kopia alpine tar czf /kopia/pg_data-$(date +%F).tgz -C /dane .
docker run --rm -v kompletor_sekrety:/dane:ro -v "$PWD":/kopia alpine tar czf /kopia/sekrety-$(date +%F).tgz -C /dane .
docker compose start
```

Trzymaj obie kopie w **różnych** miejscach. Kto ma kopię bazy i kopię sekretów, ma klucze do Twoich sklepów. Bez kopii sekretów klucze sklepów z kopii bazy są nie do odczytania i trzeba je wpisać od nowa.

Przywrócenie (przykład dla kopii z 2 listopada 2026):

```
docker compose down
docker run --rm -v kompletor_pg_data:/dane -v "$PWD":/kopia alpine sh -c "rm -rf /dane/* && tar xzf /kopia/pg_data-2026-11-02.tgz -C /dane"
docker run --rm -v kompletor_sekrety:/dane -v "$PWD":/kopia alpine sh -c "rm -rf /dane/* && tar xzf /kopia/sekrety-2026-11-02.tgz -C /dane"
docker compose up -d
```

Przywracaj zawsze parę z tego samego dnia.

## Wystawienie za HTTPS

Panel słucha tylko na `127.0.0.1`. Żeby pracować z innego komputera, postaw przed nim serwer z HTTPS. Przykład z Caddy, który sam pobiera certyfikat:

```
kompletor.twojafirma.pl {
    reverse_proxy 127.0.0.1:3000
}
```

Zasady:

- Panel wymaga HTTPS. Po samym `http://` z innego komputera przeglądarka nie zapisze sesji i logowanie wraca do ekranu logowania.
- Serwer przed panelem musi dopisywać nagłówek `X-Forwarded-For`. Caddy i typowa konfiguracja nginx robią to same. Na tej podstawie system liczy próby logowania z jednego adresu.
- Nie otwieraj portu 3000 na świat bez HTTPS.
- Panel przyjmuje zapisy (przyciski, formularze, wydruki) tylko z własnych ekranów. Przeglądarka sama podaje, skąd przychodzi żądanie; żądanie z innej strony dostaje odmowę „Żądanie spoza panelu zostało odrzucone”. Za serwerem przed panelem system porównuje adres z nagłówkiem `X-Forwarded-Host` (Caddy, nginx i Traefik w Coolify przekazują go albo zostawiają oryginalny `Host`) i z adresem w `PANEL_URL`. Jeśli po wystawieniu za HTTPS każdy zapis kończy się tą odmową, a przeglądarka jest stara, ustaw `PANEL_URL` na adres, pod którym otwierasz panel. Programy z kluczem API, agent druku, serwer MCP i łączenie sklepu WooCommerce tej odmowy nie dostają, bo logują się kluczem albo podpisem, nie sesją przeglądarki.

### Hosting wielu firm (`APP_MODE=hosted`)

Instalacja dla wielu firm (np. w Coolify) używa tego samego obrazu co self-host, ale różni się w kilku miejscach:

- **Dwie aplikacje z jednego obrazu:** panel (`KOMPLETOR_ROLA=web`, domena i sprawdzanie zdrowia `/api/health`) i worker (`KOMPLETOR_ROLA=worker`, bez domeny). Przy wdrożeniu najpierw panel, potem worker: panel ustawia hasło roli aplikacji, worker je tylko sprawdza.
- **`APP_DATABASE_URL` jest obowiązkowa.** Rola `logistyka_app` dostaje własne, losowe hasło (`openssl rand -hex 32`), ta sama wartość w panelu i workerze. Bez niej kontener nie startuje.
- **Klucze od pierwszego startu w formacie pierścienia:** `APP_ENCRYPTION_KEYS=<wersja>:<klucz>`, `CUSTOMER_DATA_KEYS=<wersja>:<klucz>` i `CUSTOMER_LOOKUP_KEY` (po 32 bajty). Kopię kluczy trzymaj poza bazą i poza kopiami bazy ([Dane klienta](dane-klienta.md)). Klucze firm (sklepy, kurierzy, program do faktur) wpisuje się w panelu, bo hosting nie czyta ich z env.
- **Bez Basic Auth, ale jawnie:** `BASIC_AUTH_DISABLED=1`. Bez tej zmiennej panel w trybie produkcyjnym odpowiada 503, żeby nikt przez pomyłkę nie wystawił go bez żadnej bramki. Logowanie chronią konta, limit prób i blokada konta.
- **`PANEL_URL` i `APP_PUBLIC_URL`** = publiczny adres panelu. Bez nich nie działają linki zaproszeń, reset hasła i „Połącz z WooCommerce”.
- **Poczta serwera do resetu hasła (`RESET_SMTP_*`)**: linki „Nie pamiętam hasła” idą tylko tym serwerem, nigdy pocztą firmy (opis w [Poczcie](poczta.md), „Reset hasła”). Bez tych zmiennych reset mailem nie działa: hasło startowe nadaje właściciel firmy albo administrator poleceniem niżej.
- **Nie ustawiaj `KOMPLETOR_SEED`.** W hostingu firmy zakłada administrator poleceniem `org:create`. Start panelu uruchamia seed w każdym trybie, gdy ta zmienna jest ustawiona, więc założyłby firmę z presetu (przy `demo` z hasłem konta demo w logu kontenera).
- **Stan instalacji pod `/api/health`:** bez autoryzacji tylko `ok`, `status`, `sha`, `appMode`, `db`, `appRole`, `secretsKey`, liczby migracji (`pending`, `failed`) i `time`. Pełną odpowiedź (wersja, kolejka zadań, liczniki kanałów) daje nagłówek `Authorization: Bearer <HEALTH_TOKEN>`; token ustaw w panelu jako zmienną `HEALTH_TOKEN` (np. `openssl rand -hex 32`). Bez tej zmiennej pełnej odpowiedzi nie ma. Sprawdzanie zdrowia kontenera patrzy na kod HTTP, więc działa bez tokenu.
- **HSTS:** obraz wysyła `Strict-Transport-Security: max-age=31536000` (bez subdomen). Przeglądarka po pierwszym wejściu przez https przez rok otwiera panel tylko po https.
- **DNS bez proxy CDN.** Limit prób logowania liczy adres z ostatniego wpisu `X-Forwarded-For`. Za dodatkowym proxy (np. Cloudflare z pomarańczową chmurką) wszyscy użytkownicy mieliby adres krawędzi proxy i wspólny limit, więc rekord domeny panelu wskazuje wprost na serwer.
- **Wydania z osobnej gałęzi** (np. `produkcja`, przesuwanej tylko do przodu po zielonych testach), z wyłączonym automatycznym wdrożeniem po każdym pushu.

## Częste błędy

### Zajęty port

Komunikat `port is already allocated` znaczy, że port 3000 zajmuje inny program. Uruchom panel na innym porcie:

```
KOMPLETOR_PORT=3001 docker compose up -d
```

### Za mało pamięci

Kontener znika albo restartuje się, a w `docker compose ps` widzisz kod wyjścia 137. To brak pamięci. Sprawdź zużycie: `docker stats`. Dodaj pamięci albo zamknij inne programy. Budowanie obrazu potrzebuje więcej pamięci niż sama praca.

### Baza nie wstaje

Zobacz log bazy: `docker compose logs db`. Najczęstsze przyczyny:

- brak miejsca na dysku (sprawdź `df -h`),
- uszkodzony wolumen po twardym wyłączeniu maszyny: przywróć kopię zapasową.

Panel bez bazy odpowiada w `/api/health` statusem `error`.

### Start zatrzymany: brak migracji bazowej

W logu kontenera: „baza ma schemat ze starszej historii migracji, a migracja bazowa 00000000000000_baza nie jest oznaczona jako wykonana”. Dotyczy bazy założonej obrazem sprzed publicznego wydania, który miał pełną historię migracji. Publiczne repozytorium zaczyna od jednej migracji bazowej z tym samym schematem, więc bez tego sprawdzenia `prisma migrate deploy` próbowałby założyć cały schemat drugi raz na istniejących tabelach.

Kontrola działa przed aktualizacją bazy i niczego nie zmienia. Naprawa jednorazowa, na tej bazie (najpierw kopia zapasowa):

```
docker compose run --rm --entrypoint kompletor web migracja-bazowa-wykonana
docker compose up -d
```

Polecenie `kompletor migracja-bazowa-wykonana` buduje adres bazy z wolumenu sekretów tak jak start kontenera i wykonuje `prisma migrate resolve --applied 00000000000000_baza`. Instalacja z własnymi zmiennymi (`DATABASE_URL` w env, np. Coolify) uruchamia to samo polecenie w kontenerze z obrazu Kompletora: `kompletor migracja-bazowa-wykonana`.

Warunek: kod, z którego zbudowano nowy obraz, ma ten sam schemat co baza (ta sama wersja albo nowsza o migracje dodane po migracji bazowej). Pusta baza i baza założona już na migracji bazowej przechodzą bez zatrzymania. Repozytorium z pełną historią migracji (bez katalogu `prisma/migrations/00000000000000_baza`) tej kontroli nie wykonuje wcale, więc jego bazy działają jak wcześniej.

### Zapomniane hasło właściciela

Nowe hasło ustawisz poleceniem w kontenerze panelu. Wpisz e-mail swojego konta:

```
docker compose exec web kompletor uzytkownik haslo --email jan@example.com
```

Polecenie wypisze nowe hasło tylko na ekran. Wszystkie sesje tej osoby zostają wylogowane. Po zalogowaniu zmień hasło w Ustawienia → Zespół i dostęp → Zmiana hasła.

Hasło innej osoby w firmie zmienisz tym samym poleceniem. Listę kont pokaże `docker compose exec web kompletor uzytkownik lista`.

## Co dalej

Po instalacji na **Pulpicie** czeka lista **Uruchomienie firmy**: dane firmy, magazyn, kanał sprzedaży, produkty,
przewoźnik, dokumenty sprzedaży, poczta i pierwsze zamówienie testowe. Każdy krok ma link do ekranu, stan liczony
z danych firmy i „Pomiń”. Listę widzi osoba z uprawnieniem „Ustawienia firmy”; „Ukryj listę” chowa ją, a „Pokaż listę
uruchomienia” przywraca. Szczegóły kroków: [Konfiguracja pierwszego dnia](konfiguracja.md).

## Dla programistów: baza do developmentu i testów

`compose.yaml` to produkt (baza, panel, worker). Sama baza do pracy nad kodem i do testów jest w osobnym pliku
`docker-compose.dev.yml`, więc goły `docker compose up` jej nie uruchamia:

```
npm run db:up      # Postgres na 127.0.0.1:55433 (bazy: logistyka, _shadow, _test)
npm run db:down    # zatrzymanie
```

Kilka baz testowych obok siebie (na przykład osobna na każdą gałąź) postawisz własną nazwą projektu i plikiem
nadpisującym port:

```
docker compose -p moja-galaz -f docker-compose.dev.yml -f moj-port.yml up -d --wait db
docker compose -p moja-galaz -f docker-compose.dev.yml -f moj-port.yml down -v
```

Przy `down` podaj te same pliki co przy `up`. Bez `-f` Compose sięgnie po `compose.yaml`, czyli produkt.
Więcej w pliku `CONTRIBUTING.md` w katalogu głównym repozytorium.
