# PrestaShop: podłączenie sklepu do Kompletora

> **Stan: kod gotowy, sprawdzony na atrapie.** Integracja nie była jeszcze uruchomiona na prawdziwym sklepie
> PrestaShop. Zanim ją ogłosimy, przechodzi próbę na sklepie demo (sekcja
> [Lista przed ogłoszeniem integracji](#lista-przed-ogłoszeniem-integracji)).

Dotyczy PrestaShop w wersji 1.7, 8 i 9. Kompletor łączy się ze sklepem przez wbudowane w PrestaShop API o nazwie
**Webservice**.

## Co Kompletor robi, a czego nie robi

**Robi (tylko odczyt):**

- co minutę sprawdza nowe i zmienione zamówienia w sklepie i przepisuje je do Kompletora w **trybie cienia**:
  zamówienie trafia do listy, liczy rezerwację towaru, ale niczego nie zmienia w sklepie;
- odczytuje stany magazynowe produktów i wariantów ze sklepu (z kodem SKU i EAN);
- sprawdza, czy połączenie działa i jaką wersję PrestaShop ma sklep.

**Nie robi:**

- nie zmienia stanów ani statusów zamówień w sklepie. Kod do tego istnieje, ale jest wyłączony: wymaga osobnego
  rodzaju konta, osobnego przełącznika na koncie i decyzji, której dziś nikt nie podejmuje;
- nie czyta danych klientów: imion, adresów, e-maili, telefonów, notatek do zamówienia. Dlatego nie wie też, czy
  klient chce fakturę na firmę (NIP jest w adresie);
- nie wysyła maili do klientów.

## Krok po kroku: włączenie Webservice i klucz

Potrzebujesz dostępu administratora do panelu sklepu.

1. Sklep musi działać pod adresem **https://** (z kłódką). Bez szyfrowania klucz szedłby otwartym tekstem:
   Kompletor odmówi połączenia.
2. W panelu wejdź w **Parametry zaawansowane → Webservice** (ang. *Advanced Parameters → Webservice*).
3. Ustaw **„Włącz Webservice PrestaShop”** (*Enable PrestaShop's webservice*) na **TAK** i zapisz.
4. Kliknij **„Dodaj nowy klucz webservice”** (*Add new webservice key*).
5. Kliknij **„Generuj”**: powstanie klucz z 32 znaków. Wpisz opis, np. „Kompletor, tylko odczyt”.
6. Ustaw **Status** na włączony.
7. W tabeli uprawnień zaznacz **wyłącznie** pola z tabeli niżej (kolumna „Wyświetl (GET)”). Nic więcej.
8. Jeśli masz kilka sklepów w jednej instalacji (*multistore*), przypisz klucz tylko do sklepu, który podłączasz.
9. Zapisz klucz.

Szczegóły (po angielsku): <https://devdocs.prestashop-project.org/9/webservice/tutorials/creating-access/>.

### Uprawnienia do odczytu (wystarczą na start)

Zaznacz tylko kolumnę **GET** (w panelu: „Wyświetl”) przy tych zasobach:

| Zasób | Po co |
|---|---|
| `orders` | zamówienia i ich pozycje |
| `order_states` | nazwy i rodzaje statusów (opłacone, wysłane) |
| `stock_availables` | stany magazynowe |
| `products` | kod SKU (indeks), EAN, czy produkt jest aktywny |
| `combinations` | SKU i EAN wariantów (rozmiar, kolor) |
| `carriers` | nazwa przewoźnika w zamówieniu |
| `currencies` | waluta zamówienia |

**Nie zaznaczaj** `customers` (klienci) ani `addresses` (adresy). Kompletor ich nie potrzebuje i o nie nie pyta.

### Uprawnienia do zapisu (tylko gdy zdecydujemy o zapisie: dziś nie)

Zapis to osobny klucz albo dopisanie uprawnień do istniejącego, **dopiero po uzgodnieniu z nami**:

| Zasób | Metoda | Po co |
|---|---|---|
| `stock_availables` | PATCH (w panelu „Zmień częściowo”, wersje 8 i 9) i PUT („Zmień”) | ustawienie stanu produktu |
| `order_histories` | POST („Dodaj”) | zmiana statusu zamówienia |

### Ostrzeżenie o kluczu

**Klucz działa bez hasła.** Kto go zna, ma dostęp do sklepu w zakresie zaznaczonych uprawnień. Dlatego:

- **nigdy nie zaznaczaj „wszystkich” uprawnień** (pole na górze tabeli): taki klucz daje dostęp do danych
  wszystkich klientów i pozwala usuwać zamówienia;
- nie wysyłaj klucza mailem ani komunikatorem razem z adresem sklepu. Przekaż go administratorowi Kompletora
  w sposób, który z nim uzgodnisz (sekcja niżej);
- gdy klucz wycieknie albo kończysz współpracę: w panelu wyłącz klucz albo go usuń i wygeneruj nowy.

### Przepisywanie adresów (częsty problem)

Webservice działa tylko, gdy serwer przepisuje adresy (*URL rewriting*). Na Apache trzeba włączonego modułu
`mod_rewrite` i `AllowOverride All` dla katalogu sklepu; w panelu: **Parametry sklepu → Ruch → Przyjazne adresy URL**
włączone. Jeśli tego brakuje, Kompletor zobaczy zwykłą stronę sklepu zamiast odpowiedzi API i zgłosi błąd
„sklep zwrócił stronę HTML zamiast odpowiedzi Webservice: włącz przepisywanie adresów”. Przy hostingu
współdzielonym poproś o to obsługę hostingu.

## Ustawienia konta w Kompletorze

| Ustawienie | Co znaczy | Domyślnie |
|---|---|---|
| `baseUrl` | adres sklepu, np. `https://sklep.pl` albo `https://mojadomena.pl/sklep` (sklep w podkatalogu jest w porządku; `/api` dopisujemy sami) | (wymagane) |
| `statusyAnulowane` | numery statusów, które znaczą „zamówienie anulowane”, po przecinku | `6,7,8` |
| `idShop` | numer sklepu przy kilku sklepach w jednej instalacji (*multistore*) | brak |
| `strefa` | strefa czasowa serwera sklepu | `Europe/Warsaw` |
| `pageSize`, `pollIntervalSec`, `overlapMinutes` | szczegóły techniczne odczytu; zostaw domyślne | 100, 60, 5 |

**`statusyAnulowane`**: PrestaShop nie ma znacznika „anulowane”, więc podajemy numery statusów. W świeżej
instalacji to 6 (Anulowane), 7 (Zwrot) i 8 (Błąd płatności). Jeśli masz własne statusy anulowania albo zmieniłeś
domyślne: w panelu **Zamówienia → Statusy** odczytaj numer z kolumny „ID” i podaj listę, np. `6,7,8,15`. Zamówienie
w takim statusie zwalnia rezerwację. Pozostałe statusy Kompletor rozpoznaje sam z ich ustawień: „wysłane” albo
„dostarczone”: zrealizowane; „opłacone”: opłacone; reszta: otwarte, czekające.

**`idShop`**: tylko przy *multistore*: numer sklepu z **Parametry zaawansowane → Wiele sklepów**. Bez niego przy
kilku sklepach stany i zamówienia mogą się mieszać.

**`strefa`**: PrestaShop zapisuje daty bez strefy czasowej, w czasie serwera. Dla sklepów w Polsce zostaw
`Europe/Warsaw`. Inna strefa to nazwa z bazy IANA, np. `Europe/Berlin` albo `UTC`.

## Jak przekazać dane administratorowi Kompletora

Administrator zakłada konto kanału i zapisuje klucz zaszyfrowany w bazie. Potrzebuje od Ciebie: adresu sklepu,
nazwy, pod jaką sklep ma się wyświetlać, oraz (osobnym, uzgodnionym kanałem) klucza Webservice.

Polecenia administratora (`<slug>` to skrót firmy, `<id>`: dowolny krótki identyfikator konta, np. domena bez
kropek):

```
npm run konto -- dodaj --firma <slug> --kanal PRESTASHOP --konto <id> --nazwa "<nazwa>" --adapter prestashop.ws.v1 --config baseUrl=https://…
npm run sekret -- --firma <slug> --ustaw PRESTASHOP_WS_KEY --ze-stdin --konto PRESTASHOP/<id>
```

## Ograniczenia (obecne)

- **Brak ekranu w panelu** do podłączania sklepu: konto zakłada administrator poleceniami wyżej.
- **Oferty powstają dziś tylko z importu BaseLinkera.** Kompletor umie odczytać listę produktów i stanów ze sklepu,
  ale jeszcze nie zapisuje jej jako ofert. Bez importu z BL pozycje zamówień ze sklepu nie są powiązane z towarem
  w magazynie i zamówienie trafia do listy **„Do wyjaśnienia”**. Rezerwacje liczą się dopiero dla powiązanych pozycji.
- **Brak NIP**: Kompletor nie czyta adresów, więc nie wie, czy klient chce fakturę na firmę. Zmieni się, gdy
  powstanie osobna zdolność danych odbiorcy.
- **Tryb cienia**: zamówienia i stany są tylko odczytywane. Zmiana stanów i statusów w sklepie jest w kodzie, ale
  wyłączona (osobny rodzaj konta `prestashop.ws.zapis.v1`, przełącznik `zapisWlaczony`, a host dziś zapisu nie woła).
- **Porównanie z BaseLinkerem** pomija konta PrestaShop: BL nie rozpoznaje ich jako źródła, więc każde zamówienie
  wyglądałoby na „brak w BL”.

## Lista przed ogłoszeniem integracji

Osobny krok, lokalnie, **poza** zadaniem. Do tego czasu nie piszemy nigdzie, że integracja działa ani że
jest wspierana.

1. Sklep demo na oficjalnym obrazie Dockera (`prestashop/prestashop`) w trzech wersjach: **1.7**, **8** i **9**,
   każdy pod HTTPS (np. lokalny certyfikat), z włączonym przepisywaniem adresów.
2. Klucz **tylko do odczytu** z uprawnieniami z tabeli wyżej (bez `customers` i `addresses`).
3. **10 fikcyjnych zamówień** w różnych statusach: oczekujące na przelew, opłacone, w realizacji, wysłane,
   dostarczone, anulowane, zwrot, błąd płatności, za pobraniem; produkty proste i z wariantami; jedno zamówienie
   z usuniętym potem produktem; jedno w innej walucie.
4. Odczyt Kompletorem i **porównanie z panelem** sklepu: numer, data, status, kwota, płatność, przewoźnik, pozycje
   (produkt/wariant, ilość, cena), stany produktów i wariantów.
5. Potwierdzenie każdego punktu z listy **[NIEPEWNE]** niżej, z zapisem wyniku dla każdej wersji.
6. Zapis stanu i statusu **tylko na sklepie demo**, osobnym kluczem z uprawnieniami zapisu i
   `zapisWlaczony: true`: PATCH (8, 9), PUT (1.7), zmiana statusu i sprawdzenie, czy klient dostał maila.

### [NIEPEWNE]: do potwierdzenia na sklepie demo

Założenia trzymane w jednym miejscu: blok „[NIEPEWNE]” w `lib/zrodla/prestashop.ts`.

1. Filtr zakresu dat `filter[date_upd]=[od,do]` z `date=1` działa przy liście zamówień; format dat
   `RRRR-MM-DD GG:MM:SS`. (Oficjalna strona podaje `date=1` tylko przy sortowaniu; zakres znamy z opisu
   integratora.) Adapter i tak odrzuca zamówienia spoza zakresu i zgłasza ostrzeżenie; 400 = błąd trwały.
2. Postać JSON: pusta lista jako `[]` czy `{"orders": []}`; czy `display=full` przy liście niesie
   `associations.order_rows` (adapter obsługuje oba warianty: bez pozycji pobiera zamówienie osobno); liczby
   i flagi jako tekst (`"1"`, `"12.300000"`); pojedynczy zasób jako `{"order": {…}}` czy `{"orders": [{…}]}`.
3. Czy `POST /api/order_histories` bez `sendemail=1` nie wysyła maila do klienta i czy działa jak zmiana statusu
   w panelu (zdjęcie stanu, faktura, „valid”).
4. Czy nagłówek `PSWS-Version` jest w każdej wersji (bez niego adapter zakłada wersję starszą niż 8 i zapisuje
   przez GET + PUT).
5. Czy sklep zawsze sam zdejmuje stan przy zamówieniu (`PS_STOCK_MANAGEMENT`); co robią zestawy (`pack`)
   i `depends_on_stock` (zaawansowane zarządzanie magazynem w 1.7).
6. Numery statusów: domyślnie 6 anulowane, 7 zwrot, 8 błąd płatności; sklep może mieć inne (ustawienie
   `statusyAnulowane`).
7. Strefa czasowa dat: czas serwera sklepu, bez strefy (ustawienie `strefa`). Limitów zapytań dokumentacja nie
   podaje (adapter: najwyżej 2 zapytania na sekundę, jedno naraz; odczyt i zapis dzielą jeden limiter).
8. PATCH na `stock_availables` w 8 i 9 przyjmuje sam `id` i `quantity`; PUT w 1.7 przyjmuje pełny wiersz
   odczytany przez JSON i odesłany jako XML, **bez** `physical_quantity` i `reserved_quantity` (liczy je sklep;
   stała `PRESTA_PUT_POMIJANE`). Do sprawdzenia w 1.7: czy PUT bez tych pól przechodzi i nie zeruje rezerwacji.
9. Filtr `display=[…]` przy pojedynczym zamówieniu (`/orders/<id>?display=[id,current_state]`).
