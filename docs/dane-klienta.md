# Dane klienta w zamówieniu

Kompletor przechowuje dane klienta zamówienia (adres, telefon, e-mail, dane do faktury) w bazie, zaszyfrowane osobnym kluczem, widoczne tylko dla osób z uprawnieniem i z dziennikiem każdego podglądu.

Do 3 listopada 2026 obowiązywała zasada „Kompletor nie przechowuje adresów klientów”: odbiorca był czytany z kanału w chwili użycia i trzymany tylko w pamięci (dokument techniczny `docs/dane-odbiorcy.md`). Od tej zmiany dane klienta zapisujemy tak jak BaseLinker, bo bez nich biuro nie widzi klienta na karcie zamówienia, nie znajdzie zamówienia po kliencie, a przesyłka i faktura zależą od tego, czy kanał akurat odpowiada.

## Co przechowujemy

Jeden zaszyfrowany rekord na zamówienie:

| Część | Pola |
|---|---|
| Nabywca | imię i nazwisko, firma |
| Adres dostawy | imię i nazwisko, firma, ulica, numer domu i lokalu (gdy kanał podaje osobno), kod pocztowy, miasto, kraj |
| Punkt odbioru | kod i nazwa punktu (paczkomat, punkt DPD) |
| Dane do faktury | nazwa, NIP, ulica, kod pocztowy, miasto, kraj (tylko gdy klient chce faktury) |
| Kontakt | telefon, e-mail |
| Uwagi klienta | gdy kanał je podaje albo ktoś je wpisze |

Poza szyfrogramem baza trzyma tylko: skąd są dane (kanał, wpis ręczny, przeprowadzka), kiedy je odczytano, ile razy odświeżono, termin przechowywania i skróty do wyszukiwania (opis niżej). Imienia, nazwiska, miasta, ulicy, telefonu ani e-maila nie ma w żadnej jawnej kolumnie.

## Skąd

- **Kanał** (sklep Woo, Allegro, Empik): po przyjęciu nowego zamówienia Kompletor dodaje zadanie zapisu. Zadanie czyta odbiorcę z API kanału i zapisuje go zaszyfrowanego. To samo po zmianie zamówienia w kanale (klient mógł zmienić adres). Empik pozwala na jeden odczyt na minutę na konto: zadania czekają w kolejce.
- **Ręcznie**: w zamówieniu ręcznym dane wpisuje człowiek (karta zamówienia → „Wpisz dane klienta”). Automat nigdy nie nadpisuje danych wpisanych ręcznie.
- **„Odśwież z kanału”** na karcie zamówienia: ponowny odczyt i zapis (osoba z pełnym podglądem).

Kanały bez źródła danych klienta w Kompletorze (EasyTools, zamówienia z innych źródeł przez BaseLinkera, sklepy Shoper i PrestaShop do czasu odczytu odbiorcy w ich integracji) nie dostają danych automatycznie: karta pokazuje „Brak danych klienta” z powodem.

Zapis działa, gdy:

1. administrator instalacji włączył `DANE_KLIENTA_ZAPIS=1` (domyślnie wyłączone),
2. są klucze `CUSTOMER_DATA_KEYS` i `CUSTOMER_LOOKUP_KEY` (opis niżej),
3. konto kanału jest w trybie pracy albo firma włączyła „zapis w cieniu” (Ustawienia → Zespół i dostęp → Dane klientów; do testów przed przejściem z BaseLinkera).

## Gdzie i jak są chronione

- **Baza**, tabela danych klienta, szyfrowanie AES-256-GCM. Szyfrogram jest związany z firmą i zamówieniem: nie da się go przenieść do innego zamówienia ani innej firmy.
- **Osobny klucz** `CUSTOMER_DATA_KEYS`, inny niż klucz kluczy integracji (`APP_ENCRYPTION_KEYS`). Wyciek jednego nie odsłania drugiego. Klucz trzymaj poza bazą i osobno od kopii bazy: kopia bazy bez klucza nie pokazuje klientów.
- **Izolacja firm**: w hostingu każda firma widzi tylko swoje wiersze (blokada w bazie, nie tylko w aplikacji).
- **Brak klucza**: zapis odmawia, karta pokazuje „Dane klienta niedostępne: brak klucza szyfrowania”, reszta systemu (zamówienia, stany, pakowanie) działa.

## Kto widzi

| Uprawnienie | Co daje | Domyślnie |
|---|---|---|
| Dane klienta: pełny podgląd (`klienci.dane`) | pełny podgląd na karcie, „Kopiuj adres”, wydruk karty z pełnym adresem, wyszukiwanie po kliencie, „Odśwież z kanału”, wpis ręczny | Właściciel, Biuro |
| Dane klienta: imię, pierwsza litera nazwiska i miasto (`klienci.skrot`) | na karcie i na wydruku karty skrót „Jan T., Poznań” (pełne nazwisko i adres tylko z pełnym podglądem) | Właściciel, Biuro, Magazyn |

Uprawnienie sprawdza serwer przy każdym odczycie, nie tylko ekran: osoba z samym skrótem nie dostanie pełnych danych także przez ręczne wywołanie akcji. Automaty (przesyłka, faktura, KSeF) czytają jako „system” bez sprawdzania członkostwa; taki odczyt wolno zrobić tylko z kodu `lib/klienci/*` i workera, czego pilnuje test strażnika `tests/klienci-straznik.test.ts`. Uprawnienia zmienia się w Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia.

Usunięcie danych jednego klienta wymaga obu: pełnego podglądu i ustawień firmy.

## Dziennik podglądów

Każdy odczyt danych klienta zostawia wpis: kto, kiedy, które zamówienie i po co (podgląd, kopiowanie adresu, wydruk, przesyłka, faktura, wyszukiwanie). Wpis nie zawiera danych klienta. Wyszukiwanie zostawia jeden wpis na zapytanie z liczbą trafień, bez szukanej frazy. Automaty (przesyłka, faktura) są w dzienniku jako „system”.

Dziennik: Ustawienia → Zespół i dostęp → Dane klientów → Dziennik podglądów, z filtrem po osobie i dacie.

## Wyszukiwanie po kliencie

Lista zamówień → jedno pole szukania (po klientach tylko z pełnym podglądem, fraza w adresie strony wyłącznie zaszyfrowana). Pełny e-mail, pełny numer telefonu albo NIP (10 cyfr, z „PL” i kreskami albo bez) szukamy po skrócie: `+48 500 000 000`, `0048500000000` i `500000000` to ten sam numer, wielkość liter w e-mailu nie ma znaczenia. Nazwisko albo firmę (od 3 liter, fragment, bez względu na polskie znaki) szukamy tylko po zaznaczeniu przy polu „także w danych klientów (nazwisko, firma)”, odszyfrowując w pamięci serwera dane z ostatnich 2 000 zamówień; w adresie strony jest wtedy tylko zaszyfrowany znacznik ważny 2 godziny dla tej osoby, a w dzienniku podglądów jeden wpis bez frazy. Ulicy nie przeszukujemy. Kraj dostawy (kod, np. `DE`) leży jawnie obok szyfrogramu, do filtra „Kraj”; usunięcie danych klienta czyści go razem ze skrótami. U zamówień zapisanych przed tą zmianą kraj uzupełnia administrator poleceniem `npm run klienci -- przeszyfruj --wszystkie-firmy --skroty`.

Technicznie: baza trzyma skrót (HMAC-SHA256) e-maila, telefonu i NIP-u liczony osobnym kluczem `CUSTOMER_LOOKUP_KEY` i identyfikatorem firmy. Bez klucza skrótu nie da się odwrócić nawet słownikiem wszystkich numerów telefonów, a ten sam klient w dwóch firmach ma różne skróty. Szukana fraza nie trafia do adresu strony ani do logów.

**Fragmentem w „Dodaj zamówienie”**. Formularz Zamówienia → Dodaj zamówienie → „Szukaj klienta” szuka po fragmencie nazwy, firmy, e-maila, telefonu albo NIP-u (polskie znaki bez znaczenia). Indeksu po fragmencie nie ma i nie będzie (dane są tylko w szyfrogramie), więc serwer odszyfrowuje w pamięci najnowsze 2000 rekordów klientów firmy, porównuje fragment i zwraca najwyżej 10 klientów (ten sam klient z kilku zamówień raz). Wynik idzie wyłącznie do przeglądarki osoby z pełnym podglądem, w dzienniku zostaje jeden wpis z liczbą trafień, bez frazy. Starszych klientów szukasz na liście zamówień po pełnym e-mailu albo telefonie.

**Zamówienia ręczne i z API**: dane wpisane w „Dodaj zamówienie” albo wysłane w `POST /api/v1/zamowienia` (obiekt `klient`) zapisują się jak wpis ręczny: zaszyfrowane, ze skrótami, automat kanału ich nie nadpisuje.

**API dla systemów zewnętrznych.** Klucz obsługi klienta (zakres `obsluga:odczyt`, opis w `docs/api.md`, sekcja „Obsługa klienta”) szuka zamówień po pełnym e-mailu albo telefonie tym samym skrótem, bez odszyfrowywania i bez fragmentów. Klucz widzi tylko zamówienia kont sprzedaży wybranych przy jego zakładaniu (albo jawnie wszystkich kont firmy). Odpowiedź nie zawiera danych klienta (adresu, imienia, e-maila, telefonu, NIP-u). Każde zapytanie zostawia w dzienniku podglądów jeden wpis z autorem „klucz API <nazwa>” i celem „obsługa klienta (API)”, bez szukanej wartości. Inne klucze API danych klienta nie czytają.

**API dla systemów zewnętrznych.** Klucz obsługi klienta (zakres `obsluga:odczyt`, opis w `docs/api.md`, sekcja „Obsługa klienta”) szuka zamówień po pełnym e-mailu albo telefonie tym samym skrótem, bez odszyfrowywania i bez fragmentów. Klucz widzi tylko zamówienia kont sprzedaży wybranych przy jego zakładaniu (albo jawnie wszystkich kont firmy). Odpowiedź nie zawiera danych klienta (adresu, imienia, e-maila, telefonu, NIP-u). Każde zapytanie zostawia w dzienniku podglądów jeden wpis z autorem „klucz API <nazwa>” i celem „obsługa klienta (API)”, bez szukanej wartości. Inne klucze API danych klienta nie czytają.

**E-mail z Allegro.** Allegro podaje sprzedawcy adres maskowany (`…@allegromail.pl`), a nie prawdziwy adres kupującego. Zapisujemy go tak, jak podał kanał, i on też dostaje skrót. Wyszukiwanie po prawdziwym adresie klienta nie znajdzie zamówień z Allegro: szukaj po telefonie albo po adresie maskowanym z zamówienia.

## Jak długo przechowujemy

| Zamówienie | Termin | Domyślnie |
|---|---|---|
| z fakturą | od końca roku, w którym wystawiono fakturę | 5 lat |
| bez faktury | od dostarczenia albo anulowania | 36 miesięcy (rękojmia, reklamacje) |
| otwarte, z otwartym zwrotem albo reklamacją | bez terminu, dopóki sprawa trwa | |

Obie wartości domyślne są **do potwierdzenia przez księgową** i można je zmienić w Ustawienia → Zespół i dostęp → Dane klientów.

Raz na dobę Kompletor przelicza terminy i liczy rekordy po terminie (nie w chwili faktury, zwrotu czy anulowania). Termin zamówienia bez faktury liczy się od ostatniej zmiany zamówienia w stanie końcowym (odebrane, anulowane), więc późniejsza zmiana tego zamówienia, np. flaga albo uwaga, przesuwa termin.

- tryb **raport** (domyślny): tylko licznik na ekranie Ustawienia → Zespół i dostęp → Dane klientów, nic nie jest usuwane;
- tryb **usuwanie** (włącza osoba z uprawnieniem ustawień): dane po terminie są usuwane partiami. Zostaje pusty rekord z datą usunięcia, skróty do wyszukiwania są czyszczone, w dzienniku jest jeden wpis z liczbą usuniętych (bez danych).

## Jak usunąć dane jednego klienta

Żądanie klienta (RODO art. 17): karta zamówienia → „Klient i dostawa” → „Usuń dane klienta (żądanie z RODO art. 17)”, zaznacz potwierdzenie i kliknij „Usuń dane klienta”. Potrzebne uprawnienia: pełny podgląd danych klienta i ustawienia firmy.

Usunięte dane nie wracają z kanału (zadanie zapisu i „Odśwież z kanału” je pomijają). Jeśli zamówienie ma fakturę w okresie przechowywania, Kompletor odmawia i pokazuje, do kiedy dane do faktury trzeba przechowywać. Klient ma kilka zamówień: usuń dane w każdym (znajdziesz je wyszukiwaniem po e-mailu albo telefonie).

## Czego nie wysyłamy i nie zapisujemy

- **AI**: dane klienta nie trafiają do wywołań AI, z jednym wyjątkiem uruchamianym przez człowieka. „Podpowiedz podział adresu (asystent AI)” na karcie zamówienia i na stanowisku pakowania wysyła do dostawcy modelu firmy (Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI) **samą linię ulicy z numerem domu** jednego zamówienia, gdy przesyłka idzie kurierem do drzwi, a linii nie da się rozdzielić automatycznie. Bez imienia, nazwiska, telefonu, e-maila, kodu pocztowego, miasta i numeru zamówienia. Zapytanie wychodzi tylko po kliknięciu, raz na linię adresu; odczyt linii jest w dzienniku podglądów (cel „poprawka”). Wynik zapisuje człowiek przyciskiem „Zatwierdź”, a w zamówieniu zostaje tylko skrót linii i pozycje znaków, bez treści adresu ([Przesyłki](przesylki.md), „Podział adresu przez asystenta AI”).
- **Logi**: w logach jest numer zamówienia i rodzaj błędu, nigdy dane klienta ani treść odpowiedzi kanału.
- **Powiadomienia** (Zulip) i alerty: bez danych klienta.
- **Kolejka zadań**: zadanie zapisu niesie tylko numer zamówienia.
- **Historia zamówienia, kopia zamówienia z kanału, flagi zamówienia**: bez danych klienta.
- **API dla systemów zewnętrznych** (klucze API): bez danych klienta.
- **Szkic faktury KSeF**: Kompletor sprawdza nabywcę z bazy (NIP, nazwa, adres), ale zapisany szkic ma nabywcę zastępczego.
- **Wydruk karty**: plik z pełnym adresem jest usuwany z bazy zaraz po wydrukowaniu (inne pliki druku po 7 dniach).

## Klucze i ich zmiana

Dla instalacji z plikiem `.env` (self-host):

```
CUSTOMER_DATA_KEYS=1:<64 znaki hex>      # openssl rand -hex 32
CUSTOMER_LOOKUP_KEY=<64 znaki hex>       # openssl rand -hex 32
DANE_KLIENTA_ZAPIS=1
```

Ten sam zestaw musi mieć panel i worker. Klucze trzymaj razem z innymi sekretami instalacji, poza bazą i jej kopią.

**Zmiana klucza szyfrowania** (np. po odejściu osoby z dostępem do serwera):

1. dopisz nową wersję na początku: `CUSTOMER_DATA_KEYS=2:<nowy>,1:<stary>`, uruchom ponownie panel i worker (nowe zapisy idą kluczem 2, stare dalej się czytają);
2. przepisz istniejące dane nowym kluczem: `npm run klienci -- przeszyfruj --wszystkie-firmy` (w kontenerze: `docker compose exec web kompletor klienci przeszyfruj --wszystkie-firmy`; obraz nie ma `tsx` ani katalogu `scripts/`);
3. gdy polecenie potwierdzi, że starszym kluczem nie zostało nic, usuń starą wersję: `CUSTOMER_DATA_KEYS=2:<nowy>`.

Stan: `npm run klienci -- stan --firma <slug>` (liczba rekordów per wersja klucza).

**Zmiana klucza skrótów**: ustaw nowy `CUSTOMER_LOOKUP_KEY` i uruchom `npm run klienci -- przeszyfruj --wszystkie-firmy --skroty` (skróty liczone od nowa z odszyfrowanych danych). Do końca przeliczenia wyszukiwanie nie znajduje części zamówień.

**Przebieg retencji teraz** (zamiast czekać do doby): `npm run klienci -- retencja --firma <slug>`.

## Czego jeszcze nie ma

- Zamówienia sprzed włączenia zapisu i zamówienia przyjęte, zanim administrator dopisał `CUSTOMER_DATA_KEYS` (zadanie zapisu kończy się wtedy błędem), nie dostają danych same: „Odśwież z kanału” na karcie albo zbiorczo poleceniem `npm run klienci -- uzupelnij --firma <slug>`: planuje
  zadania odczytu klienta dla otwartych zamówień bez danych (`--wszystkie` także odebranych i anulowanych), rozłożone
  co 3 s (`--odstep-ms`), najwyżej 500 nowych albo wznowionych na przebieg (`--limit`); `--proba` tylko liczy.
  Zadania wykonuje worker z limitem tempa konta. Zamówienia z zadaniem czekającym nie wliczają się do limitu, więc
  kolejny przebieg bierze następne zamówienia i nic nie dubluje. Zadanie zakończone błędem wraca do kolejki; zadanie
  wykonane bez zapisu (konto w cieniu bez zgody firmy, konto nieaktywne, sklep bez odczytu odbiorcy) wraca tylko
  z `--ponow`, np. po zmianie zgody, żeby kolejne przebiegi nie dokładały tych samych odmów do dziennika.
- Przesyłka i faktura: funkcje `lib/klienci/wejscia.ts` (`odbiorcaPrzesylki`, `kontrahentFaktury`) dają dane z bazy z zapasem z kanału, ale dziś woła je tylko szkic KSeF. Zlecenie przesyłki u kuriera z danymi odbiorcy i faktura wFirma z kontrahentem to osobne zadania, które te przepływy budują; wpięcie danych klienta w `lib/wysylka` i `lib/wfirma` należy do nich.
- Shoper i PrestaShop: integracje nie czytają jeszcze odbiorcy, więc dane klienta z tych sklepów się nie zapisują.
- Eksportu danych klienta (np. odpowiedź na żądanie dostępu z RODO art. 15) jeszcze nie ma.
- Instalacja z `docker compose up` nie zakłada jeszcze kluczy danych klientów sama: trzeba je dopisać do `.env` obok `compose.yaml`.
