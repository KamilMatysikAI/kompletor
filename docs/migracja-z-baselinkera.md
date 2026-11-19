# Migracja z BaseLinkera

Jak bezpiecznie sprawdzić Kompletora obok BaseLinkera, co się przenosi, a co nie, i czego jeszcze brakuje do pełnego przejścia.

## Przeprowadzka z panelu

| Ekran | Droga z menu | Adres | Kto widzi |
| --- | --- | --- | --- |
| Przeprowadzka z BaseLinkera | **Pulpit** → lista **Uruchomienie firmy** → „Przenieś z BaseLinkera”; po zapisaniu klucza także menu **Przejście z BaseLinkera** → **Przeprowadzka z BaseLinkera** | `/ustawienia/przeprowadzka` | uprawnienie „Ustawienia firmy” (Właściciel) |

1. **Klucz API.** W BaseLinkerze: Moje konto → API → token. Wklej go w polu „Klucz API” i kliknij „Zapisz klucz”.
   Klucz jest szyfrowany w bazie, w panelu nie da się go odczytać. Sam klucz nie przełącza firmy w tryb „przechodzi
   z BaseLinkera” (to robi dopiero import). Firma z kontami w trybie pracy klucza nie zapisze: ekran prosi najpierw
   o przełączenie tych kont na „Tylko podgląd”. **Usuń klucz BaseLinkera** kasuje klucz (wpis w historii zmian, bez
   wartości klucza); dane już przeniesione zostają. Zmiana klucza po trybie próbnym wymaga nowego trybu próbnego.
2. **Tryb próbny.** „Uruchom tryb próbny”. Kompletor czyta BaseLinkera w tle (przy dużym katalogu kilka minut, ekran
   odświeża się sam) i pokazuje raport: co przyjdzie (produkty, zestawy, stany startowe, oferty, konta sklepów, statusy,
   reguły przewoźników, otwarte zamówienia) i co wymaga decyzji. Nic nie zapisuje.
3. **Decyzje.** Przy kilku katalogach produktów w BaseLinkerze wybierasz katalog („Z którego katalogu przenieść
   produkty”). Źródła zamówień, których nie przenosisz (np. stary sklep), zaznaczasz „Pomiń”: ich konta i otwarte
   zamówienia nie trafią do Kompletora. Statusy BaseLinkera i metody dostawy, których Kompletor nie rozpoznał, wybierasz
   z list. Po „Zapisz decyzje” uruchom tryb próbny jeszcze raz (zmiana decyzji albo katalogu unieważnia poprzednią próbę).
4. **Import.** Przycisk jest aktywny, gdy ostatni tryb próbny przeszedł bez spraw blokujących i po nim decyzje się nie
   zmieniły. Import zapisuje to, co pokazał raport; powtórny import niczego nie dubluje. Konta sklepów przychodzą
   w trybie „Tylko podgląd”.
5. **Koniec przejścia.** Gdy dane są przeniesione i odchodzisz od BaseLinkera: wyłącz w BaseLinkerze zmiany stanów
   i statusów dla tych sklepów, potem **Przejście z BaseLinkera zakończone**. Od tej chwili tryb pracy kont włączasz
   z panelu (**Pulpit** → **Stan kanałów** → **Włącz tryb pracy** albo ekran konta), bez administratora serwera. Import
   z BaseLinkera jest wtedy wyłączony; **Cofnij zakończenie przejścia** przywraca go, gdy żadne konto nie pracuje.
   Szczegóły i wyjątki: [Tryb pracy](tryb-praca.md).

Raport każdego trybu próbnego i importu pobierzesz z ekranu („Pobierz pełny raport (Markdown)”): to ten sam raport co
z polecenia administratora, bez danych klientów. Pod liczbami raport pokazuje zwinięte listy spraw: oferty bez
powiązania, produkty, które nie przejdą (bez SKU, SKU powtórzone), zestawy z problemem, zamówienia z pozycją bez
powiązania, źródła bez obsługi (pierwsze 200 pozycji każdej listy; wszystkie są w raporcie do pobrania).

Powody blokady importu ekran pisze językiem właściciela, z odesłaniem do miejsca, gdzie to naprawić (sekcja
„Decyzje”, Kanały sprzedaży, klucz API).

Czego ekran nie robi: nie zmienia niczego w BaseLinkerze, nie przełącza kont na tryb pracy (to **Pulpit** → **Stan
kanałów** albo ekran konta) i nie zapisuje raportu na dysk serwera (raport pobierasz w przeglądarce; zapis na dysk
robi polecenie niżej). Ekran i polecenie przeprowadzki (administrator serwera) korzystają z tej samej logiki, więc tryb
próbny daje ten sam raport.

## Najpierw bezpieczeństwo

Przez cały okres porównania (kroki 1–6 niżej) **BaseLinker pracuje jak dotąd**. Konta w trybie „Tylko podgląd” tylko czytają: zamówienia ze sklepów, katalog z BaseLinkera, towary i faktury z wFirmy. Kompletor niczego nie zapisuje w sklepach, w BaseLinkerze ani w wFirmie.

Kompletor umie już prowadzić zamówienia sam: zapis stanów, statusów i numerów nadania do sklepów, nadawanie przesyłek i faktury w wFirmie. Każda z tych rzeczy ma własny wyłącznik i domyślnie jest wyłączona; część dróg zapisu sprawdzono dotąd tylko na atrapach i kontach testowych (stan każdej: [Co jeszcze nie działa](co-jeszcze-nie-dziala.md)). Przełączenie opisuje sekcja [Przełączenie na pracę w Kompletorze](#przełączenie-na-pracę-w-kompletorze).

Do dnia przełączenia nie wyłączaj w BaseLinkerze żadnej integracji ani automatu. Nie generuj nowych kluczy w sklepach, jeśli z obecnych korzysta BaseLinker (szczegóły w [Integracjach](integracje/README.md)).

## Dwa tory

| Tor | Kto pracuje | Co robi Kompletor |
|---|---|---|
| Tor 1: BaseLinker | Ty i zespół, jak co dzień | Nic. |
| Tor 2: Kompletor w trybie „Tylko podgląd” | Proces w tle | Czyta te same zamówienia, liczy rezerwacje, porównuje wynik z BaseLinkerem i pokazuje różnice. |

## Co się przenosi

| Co | Jak | Wymaga |
|---|---|---|
| Katalog produktów i zestawy | Import katalogu z BaseLinkera | Token BaseLinkera, numer katalogu, klucze wFirmy |
| Powiązania ofert z produktami | Ten sam import: powiązania z BaseLinkera, oferty Empiku, propozycje dopasowane po SKU do zatwierdzenia | jak wyżej |
| Stan startowy | Z towarów magazynu wFirmy przy pierwszym imporcie | Klucze wFirmy i numer magazynu |
| Miejsca na półce (na przykład B-3-4) | Z katalogu BaseLinkera | jak wyżej |

## Co się nie przenosi

- **Historia zamówień.** Kompletor czyta zamówienia od chwili uruchomienia odczytu, z krótkim oknem wstecz (domyślnie 24 godziny).
- **Automatyczne akcje BaseLinkera.** W Kompletorze nie ma edytora reguł. Każdą akcję trzeba rozpisać na funkcje Kompletora. Przykład takiego rozpisania jest w [Automatach BaseLinkera w Kompletorze](akcje-bl.md).
- **Własne statusy BaseLinkera.** Przeprowadzka przenosi je jako statusy firmy (nazwa, kolor, nazwa dla klienta, grupa); automatycznych akcji BL API nie udostępnia, więc w ich miejsce przychodzą wyłączone reguły najbliższego szablonu w grupie „Z BaseLinkera” ([Automatyczne akcje → Szablony](automatyczne-akcje.md)).
- **Szablony maili, faktury, przesyłki.** Dane klientów Kompletor przechowuje zaszyfrowane ([Dane klienta w zamówieniu](dane-klienta.md)); przeniesienie danych klientów historycznych zamówień z BaseLinkera jeszcze nie działa.

## Kroki

Polecenia uruchamiasz na komputerze z Kompletorem, w katalogu projektu.

### 1. Instalacja i firma

Zainstaluj system według [Instalacji](instalacja.md) i załóż firmę w kreatorze. Skrót firmy pokaże:

```
docker compose exec web kompletor org list
```

### 2. Klucze

Wpisz token BaseLinkera i klucze wFirmy (opis w [Integracjach](integracje/README.md)):

```
docker compose exec -T web kompletor sekret --firma <skrót firmy> --ustaw BASELINKER_TOKEN --ze-stdin < token.txt
docker compose exec -T web kompletor sekret --firma <skrót firmy> --ustaw WFIRMA_ACCESS_KEY --ze-stdin < klucz.txt
```

To samo dla `WFIRMA_SECRET_KEY`, `WFIRMA_APP_KEY` i `WFIRMA_COMPANY_ID`. Numer katalogu BaseLinkera i numer magazynu wFirmy są w ustawieniach firmy. Sklepy WooCommerce import rozpoznaje przez powiązanie konta sklepu z jego magazynem w BaseLinkerze (pole `blStorageId` konta sklepu). Panel tego pola nie ustawia: to krok dla osoby technicznej.

### 3. Import katalogu

```
docker compose exec web kompletor import-katalogu --firma <skrót firmy> --raport /tmp/kompletor-raporty/import
docker compose cp web:/tmp/kompletor-raporty/import ./raport-importu
```

Import tylko czyta BaseLinkera, sklepy widziane przez BaseLinkera, Empik i wFirmę. Domyślnie nie czyta zamówień, więc nie pobiera danych klientów. W katalogu `raport-importu` znajdziesz raport mapowania i pliki CSV.

Ważne zasady importu:

- Import można powtarzać. Nie dubluje produktów.
- Stan startowy powstaje tylko raz, gdy produktu jeszcze nie ma w Kompletorze.
- Bez kluczy wFirmy import odmawia zapisu.
- Oferty dopasowane tylko po SKU są propozycjami do zatwierdzenia, a nie gotowymi powiązaniami.
- Gdy jeden przebieg wyłączyłby ponad 20% aktywnych ofert kanału, import tego kanału odmawia. To bezpiecznik przed pomyłką.

### 4. Sklepy i odczyt zamówień

Dodaj sklepy w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży (opis w [Konfiguracji](konfiguracja.md)). Allegro połącz przyciskiem „Połącz z Allegro” na ekranie konta. Od tej chwili proces w tle czyta zamówienia i rezerwuje towar.

### 5. Porównanie

- **Rozjazdy:** Pulpit → „Zobacz rozjazdy z BL” (adres `/rozjazdy`, widzi Właściciel i Biuro). Raport za dzień poprzedni powstaje po północy. Pokazuje różnice w zamówieniach, statusach i stanach, osobno dla każdego kanału.
- **Maile do klientów: podgląd:** menu → Przejście z BaseLinkera. Maile, które Kompletor wysłałby zamiast BaseLinkera. Konto „Tylko podgląd” nic nie wysyła; konto aktywne wysyła pocztą firmy, za bramkami ([Poczta](poczta.md)).
- **Faktury:** porównanie faktur, które wystawiłby Kompletor, z fakturami z BaseLinkera za wybrany dzień:

  ```
  docker compose exec web kompletor cien faktury-podglad --dzien 2026-11-01
  ```

- **Faktura robocza w wFirmie:** przed przełączeniem możesz wystawić w wFirmie fakturę roboczą (bez numeru w serii, bez KSeF) dla wybranego zamówienia, złożoną dokładnie tak jak prawdziwa faktura z Kompletora, porównać ją z fakturą BaseLinkera i usunąć. Opis: [Faktura robocza przed przełączeniem](dokumenty-sprzedazy.md#faktura-robocza-przed-przełączeniem).

Ekran rozjazdów liczy dni z rzędu bez różnic. To miara gotowości: przełączaj dopiero po serii dni bez różnic (proponujemy 7) i po jednym dniu, w którym magazyn przeszedł pakowanie w Kompletorze obok BaseLinkera.

### 6. Rozjazdy: co z nimi zrobić

Każdy rozjazd to pytanie: kto ma rację, BaseLinker czy Kompletor? Najczęstsze przyczyny:

- oferta bez powiązania z produktem (zamówienie trafia do „Do wyjaśnienia”),
- metoda dostawy, której reguły przewoźników nie rozpoznają,
- dostawa przyjęta w wFirmie: Kompletor odczyta ją przy najbliższym odczycie stanów z wFirmy (co 2 minuty po fakturze, cały magazyn co noc), więc przez chwilę jego stan może być niższy niż w BaseLinkerze.

Źródłem prawdy pozostaje BaseLinker.

### 7. Punkt cięcia przed włączeniem trybu pracy

W podglądzie zamówienie w Kompletorze zostaje w „Do realizacji” także wtedy, gdy BaseLinker dawno je spakował i wysłał. Gdyby od razu włączyć tryb pracy konta, takie zamówienia stanęłyby w kolejce pakowania (druga paczka), a zamówienia z e-bookiem spakowałby automat zamówień bez wysyłki. Dlatego tuż przed „Włącz tryb pracy” zamykasz w Kompletorze to, co BaseLinker już obsłużył:

```
docker compose exec web kompletor cien punkt-ciecia --firma <skrót firmy>            # na sucho: tylko lista i liczby
docker compose exec web kompletor cien punkt-ciecia --firma <skrót firmy> --zapisz   # wykonanie
```

Opcje: `--kanal EMPIK` i `--konto <id>` zawężają do jednego konta, `--plik <ścieżka.md>` zapisuje raport do pliku, `--maks-wiek-minuty N` zmienia próg świeżości kopii (domyślnie 15). Polecenie bierze tylko konta w podglądzie (konto w trybie pracy pomija) i tylko zamówienia w statusach „Nowe”, „Do realizacji” i „Do wyjaśnienia”. O grupie decyduje ostatnia kopia statusu z BaseLinkera i jego faktury, które odczyt w tle już pobrał; samo polecenie BaseLinkera nie pyta.

**Świeżość kopii:** raport podaje osobno chwilę ostatniego udanego odczytu trzech źródeł z BaseLinkera: listy zamówień z okna (świeże zamówienia), dziennika statusów (status starszych zamówień niesie tylko on; odczyt z błędem albo urwany się nie liczy, pusty udany tak) i faktur BL, oraz najnowszy wpis kopii każdego konta. Źródło starsze niż próg jest oznaczone „za stare: blokuje zapis”. Wykonanie (`--zapisz`) odmawia i niczego nie zamyka, gdy którekolwiek z trzech jest starsze niż próg (świeża lista nie zastępuje starego dziennika ani odwrotnie): zamówienie wysłane albo zafakturowane w BaseLinkerze po ostatnim odczycie trafiłoby do kolejki pakowania jako nieskończone. Kolejność w dniu przełączenia: zatrzymaj pracę w BaseLinkerze, poczekaj na kolejny odczyt zamówień i faktur (kilka minut, czasy widać w raporcie na sucho), uruchom wykonanie, dopiero potem „Włącz tryb pracy”. Przy zamknięciu status z kopii BL jest sprawdzany jeszcze raz: zamówienie, któremu odczyt w międzyczasie zmienił status, zostaje do kolejnego przebiegu.

| Grupa w raporcie | Co znaczy | Co robi wykonanie |
|---|---|---|
| Obsłużone w BaseLinkerze: do zamknięcia | w BL spakowane, do wysłania, do odbioru, wysłane albo odebrane; e-book z fakturą BL | status „Wysłane” (albo „Odebrane”, gdy BL ma „Odebrane” lub to e-book; „Do odbioru”, gdy to odbiór osobisty, który w BL czeka na klienta: zostaje na liście do wydania, a przy wydaniu biuro oznacza „Odebrane”) i wpis w historii „Zamknięte przy przejściu z BaseLinkera” |
| Obsłużone, stan jeszcze nierozliczony | BL wysłał, ale rezerwacja jest aktywna (faktura BL czeka na WZ albo odczyt „wysłane bez faktury” jeszcze nie przeszedł) | nic; powtórz polecenie po kolejnym odczycie (kilka minut) |
| Nieskończone w BaseLinkerze, z fakturą BL | opłacone, niespakowane, BL już wystawił fakturę | nic; takie zamówienie kończy BaseLinker ([procedura niżej](#zamówienie-z-fakturą-z-baselinkera-po-przełączeniu)). Kompletor nigdy nie wystawi do niego drugiej faktury, a po włączeniu trybu pracy konta wstrzymuje jego pakowanie i nie pokazuje go w „Do spakowania”. Raport wypisuje osobno te, którym faktura BL rozliczyła brak (towar czekał na dostawę): „Do sprawdzenia: zafakturowane w BaseLinkerze, a towar czekał na dostawę” |
| Nieskończone w BaseLinkerze, bez faktury | do spakowania | nic; po przełączeniu pakuje je Kompletor |
| Do sprawdzenia ręcznie | anulowane albo inny status w BL, zamówienie z fakturą, przesyłką albo pakowaniem w Kompletorze, odłożona operacja | nic |
| Bez pary w BaseLinkerze | brak kopii zamówienia z BL | nic |

Zamknięcie to sama zmiana statusu w Kompletorze: bez maila do klienta (maile „Faktura” i „Gotowe do odbioru” pomijają takie zamówienia także po włączeniu trybu pracy), bez zapisu do sklepu i kanałów (po włączeniu trybu pracy zapis statusów do sklepu też ich nie bierze: status w sklepie ustawił BaseLinker), bez faktury i bez ruchu magazynowego. Automaty firmy uruchamiane czasem („zamówienie w statusie określoną liczbę dni”) pomijają zamknięte zamówienia. Każde zamówienie zamyka się osobno; błąd jednego trafia do raportu i nie zatrzymuje reszty. Powtórzone polecenie niczego nie zmienia.

**Kontrola:** raport podaje liczbę zamówień kont w kolejce pakowania (do realizacji, zbieranie, zebrane), a osobno ile z nich ma już fakturę z BaseLinkera (te kończy BaseLinker; po włączeniu trybu pracy konta znikają z „Do spakowania”, więc kontrola w Pakowaniu liczy już bez nich). Po wykonaniu porównaj ją z liczbą zamówień w BaseLinkerze w statusach „Do realizacji …” (różnica to grupy „do sprawdzenia”, „bez pary” i „nierozliczone”). Na karcie zamówienia (Zamówienia → zamówienie → sekcja „Historia zmian”) zostaje wpis z poprzednim statusem, statusem z BL i numerem faktury BL.

**Druga faktura:** niezależnie od punktu cięcia Kompletor nie wystawia faktury ani dokumentu sprzedaży do zamówienia, które ma fakturę z BaseLinkera (także do paczki dodatkowej takiego zamówienia). W historii zamówienia pojawia się wtedy wpis „Bez faktury z Kompletora: zamówienie ma już fakturę z BaseLinkera”, a automat zamówień bez wysyłki takiego zamówienia nie pakuje.

## Firma bez wFirmy

Import katalogu z BaseLinkera wymaga wFirmy: bez jej kluczy import odmawia zapisu. Dla firmy bez wFirmy są dwie drogi: przeprowadzka z BaseLinkera (`npm run przeprowadzka`, opis w `docs/przeprowadzka-z-baselinkera.md`) przenosi produkty, oferty i stany z magazynu BL, a bez BL zostaje Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → „Pobierz oferty”. Oferty przypinają się do produktów po SKU, a nowe produkty dostają stan startowy z kanału. Później stan zmieniasz ręcznie: „Korekta stanu” na karcie produktu. Bez wFirmy nie ma porównania faktur z BaseLinkerem (`faktury-podglad`); dokumenty po przełączeniu wystawia wybrany program albo „KSeF bezpośrednio”, a firma bez programu wysyła bez faktury ([Stan magazynu i dokumenty sprzedaży](dokumenty-sprzedazy.md)).

## Przełączenie na pracę w Kompletorze

Przełączaj wszystkie sklepy, które dzielą towar, naraz i w jednym oknie przed pakowaniem (np. rano, zanim magazyn zacznie). Przy przełączaniu po jednym sklepie przez pewien czas dwa systemy zapisywałyby stany tego samego towaru.

**Zanim zaczniesz:** seria dni bez różnic, dzień pakowania na próbę, kopia bazy, sprawdzone połączenia z prawem zapisu (sklepy, Allegro, przewoźnicy, program do faktur), poczta firmy z udanym mailem testowym, zespół z kontami w panelu.

**Kolejność:**

1. **W BaseLinkerze automat faktur wyłączasz dzień wcześniej**, zaraz po zabraniu do pakowania ostatniej partii zamówień. Wszystko, co ma fakturę z BaseLinkera, wyjeżdża tego dnia, a zamówienia opłacone później czekają na Kompletora bez faktury z BaseLinkera.
2. **Zatrzymaj pracę w BaseLinkerze (rano):** nikt nie pakuje ani nie zmienia statusów. Wyłącz automatyczne akcje, które zmieniają statusy, wystawiają faktury i wysyłają maile, a w ustawieniach integracji każdego sklepu wysyłanie stanów, cen, statusów i numerów nadania. **Pobieranie zamówień zostaw:** BaseLinker ma wtedy komplet zamówień na wypadek powrotu, a Kompletor dalej widzi jego faktury. Nie usuwaj klucza BaseLinkera w Kompletorze. Automaty wyłączasz dla całego BaseLinkera, więc zamówienia ze sklepów, których Kompletor nie prowadzi, zostają w BaseLinkerze bez statusu i faktury: zaplanuj, kto je obsłuży (np. zamówienie ręczne w Kompletorze, Zamówienia → „Dodaj zamówienie”).
3. **Punkt cięcia** (sekcja „7. Punkt cięcia przed włączeniem trybu pracy” wyżej): poczekaj na świeży odczyt z BaseLinkera, uruchom polecenie na sucho, porównaj liczby z BaseLinkerem, potem wykonanie (`--zapisz`) i kontrola kolejki pakowania. Zamówienia z grup, których polecenie nie zamyka, rozdziel przed startem pakowania: nieskończone z fakturą BaseLinkera kończy BaseLinker według [procedury niżej](#zamówienie-z-fakturą-z-baselinkera-po-przełączeniu) (Kompletor ich nie spakuje ani nie zafakturuje; status i numer nadania wpisz w panelu kanału, bo BaseLinker już ich nie wyśle), resztę rozstrzygnij ręcznie.
4. **Administrator serwera:** `EKRANY_PRACA=1` (firma przechodząca z BaseLinkera, [Tryb pracy](tryb-praca.md)), wysyłka poczty i alertów (`POCZTA_WYSYLKA=1`, `POWIADOMIENIA_WYSYLKA=1`), wyłączony import katalogu z BaseLinkera (`KATALOG_IMPORT_CO_GODZIN` puste). Same zmienne niczego nie przełączają.
5. **Faktury przed trybem pracy:** Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → „Wystawiaj faktury z Kompletora” (i ewentualnie „WZ przy wysyłce bez faktury”). Faktura powstaje tylko dla zamówień spakowanych po włączeniu, więc włącz ją, zanim ktokolwiek spakuje zamówienie w Kompletorze.
6. **Nadawanie:** Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → „Nadawanie z Kompletora” przy każdej regule.
7. **Tryb pracy kont:** Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → „Stan konta” → „Włącz tryb pracy”, konto po koncie. Na tym etapie zapis do sklepu jest jeszcze wyłączony. Kontrola: w Pakowaniu (zakładka „Do spakowania”) tyle zamówień, ile podał punkt cięcia w kolejce pakowania minus te z fakturą z BaseLinkera (są wypisane w ramce nad listą), i ani jednej faktury z Kompletora przed startem pakowania.
   **Tryb pracy bez stanów** (ten sam ekran, przycisk „Włącz tryb pracy bez stanów”): Kompletor prowadzi zamówienia konta (statusy, numery nadania, pakowanie, wysyłka, faktury), a stany ofert wysyła dalej BaseLinker. Dla kont, na których oferty nie są jeszcze uporządkowane (oferty bez SKU, ilości w kanale różne od stanu w Kompletorze), np. marketplace w sezonie. W BaseLinkerze wyłączasz wtedy dla tego konta statusy, numery nadania i automatyczne akcje, a wysyłanie stanów zostawiasz. Stany dołączasz później przyciskiem „Dołącz stany ofert” (najpierw wyłącz stany w BaseLinkerze); „Wyłącz tylko stany ofert” cofa to bez wychodzenia z trybu pracy. „Włącz tryb pracy” na Pulpicie (wszystkie konta naraz) konta pracującego bez stanów nie zmienia.
8. **Zapis do sklepu**, konto po koncie, od najmniejszego: ekran konta → „Zapis do sklepu” → „Włącz zapis do sklepu”. Jeden przełącznik włącza stany ofert, statusy, numery nadania i anulowanie nieopłaconych po terminie. Przed każdym kontem sprawdź, że sklep odpowiada; po każdym sprawdź w sklepie stan kilku produktów.
9. **Poczta:** Ustawienia → Komunikacja i poczta → Poczta → „Wysyłaj maile z planu akcji”. Ustal, które maile wysyła dalej sklep, a które Kompletor, żeby klient nie dostał dwóch.
10. **Decyzje o brakach podjęte w podglądzie** (na liście braków z dopiskiem „(próbnie)”) nie wykonują się po przełączeniu: podejmij je jeszcze raz.

### Zamówienie z fakturą z BaseLinkera po przełączeniu

Dotyczy kont w trybie pracy. Konto w podglądzie i firma bez BaseLinkera działają bez zmian.

Zamówienie, które ma fakturę wystawioną w BaseLinkerze (także spóźnioną albo wystawioną ręcznie już po przełączeniu), **kończy BaseLinker**: spakuj je i wyślij w BaseLinkerze, w Kompletorze go nie pakuj. Towar zdjął już dokument WZ do tej faktury, a Kompletor nie wystawi drugiej faktury. Co robi Kompletor:

- **Wstrzymuje pakowanie** każdą drogą (karta zamówienia, stanowisko pakowania, automat zamówień bez wysyłki): przy próbie pokazuje numer faktury i tę procedurę. Na stanowisku pakowania skan karty takiego zamówienia daje czerwoną kartę „NIE PAKUJ” z numerem faktury (odłóż koszyk), a gdy faktura przyjdzie już po otwarciu okna, odmowa przychodzi przy „Spakowano”.
- **Paczka dodatkowa** („Dośle później” albo podział na paczki) zamówienia z fakturą z BaseLinkera też kończy BaseLinker: jej towar pochodzi z pozycji zamówienia, które objęła faktura i WZ do niej, więc Kompletor jej nie pakuje, a „Pakuj mimo…” przy paczce dodatkowej odmawia.
- **Pakowanie** → zakładka „Do spakowania”: takie zamówienia są poza listą, a ramka nad nią wypisuje je z numerem faktury i linkiem do karty.
- **Zamówienia** → kolumna „Status”: znacznik „faktura z BaseLinkera …: kończy BaseLinker, nie pakuj”. Zamówienie, któremu faktura z BaseLinkera rozliczyła brak (towar czekał na dostawę), ma drugi znacznik „zafakturowane w BaseLinkerze przy braku towaru: sprawdź, czy towar dojechał”: zanim BaseLinker je spakuje, magazyn sprawdza, czy towar jest na półce.
- **Alert** `FAKTURA_BL_W_KOLEJCE` (grupa Faktury), gdy faktura z BaseLinkera pojawi się przy zamówieniu, które już stoi w kolejce pakowania; `FAKTURA_BL_TOWAR_W_PRACY`, gdy zamówienie ma jeszcze odłożony towar albo brak. Treść alertu podaje tę samą procedurę. Oba zamykają się same, gdy zamówienie wyjdzie z kolejki ([Powiadomienia](powiadomienia.md)). Po powrocie z „Do wyjaśnienia” („Wyjaśnione”) alert nie powstaje drugi raz: takie zamówienie pokazuje ramka nad listą „Do spakowania” i znacznik na liście zamówień.
- **Zamówienie już spakowane w Kompletorze**, gdy faktura z BaseLinkera przyszła po spakowaniu (odczyt faktur co 2 minuty albo spóźnione połączenie): ten sam alert „Faktura z BaseLinkera po przełączeniu: zamówienie w kolejce pakowania albo już spakowane” (`FAKTURA_BL_W_KOLEJCE`) z osobną treścią. Paczka wychodzi z Kompletora, dokumentem sprzedaży jest faktura z BaseLinkera, więc Kompletor nie wystawi swojej faktury. Na karcie zamówienia kliknij „Do wysyłki” (odbiór osobisty: „Do odbioru”) i dalej jak zwykle; w BaseLinkerze tego zamówienia nie pakuj. Alert zamyka się sam po „Do wysyłki”.
- **Dwie faktury** (alert „Dwie faktury na jedno zamówienie: z BaseLinkera i z Kompletora”, `FAKTURA_BL_I_KOMPLETORA`): faktura z BaseLinkera przy zamówieniu, do którego Kompletor wystawił już albo właśnie wystawia własny dokument sprzedaży. Także wtedy, gdy Kompletor spakował i zafakturował zamówienie, zanim połączył je z zamówieniem w BaseLinkerze, a faktura z BaseLinkera przyszła po połączeniu (towar zszedł wtedy raz, z faktury Kompletora). Zostaw jeden dokument, drugi skoryguj w programie do faktur. Ten alert nie zamyka się sam.
- **Faktura bez zamówienia w Kompletorze** (alert „Faktura z BaseLinkera bez zamówienia w Kompletorze: sprawdź, czy go nie pakujesz”, `FAKTURA_BL_BEZ_PARY`): faktura z BaseLinkera na koncie w trybie pracy, której Kompletor po 15 minutach nadal nie połączył z żadnym swoim zamówieniem Kompletor nie wie wtedy, które zamówienie wstrzymać, więc alert podaje numer zamówienia ze sklepu (w odnośniku alertu: „<numer ze sklepu> (BL <numer w BaseLinkerze>)”): znajdź je w Kompletorze (Zamówienia → pole wyszukiwania) i postąp jak wyżej. Jeśli Kompletor już je spakował albo zafakturował, nie wysyłaj go drugi raz z BaseLinkera i sprawdź, czy klient nie dostanie dwóch faktur. Jeśli takiego zamówienia w Kompletorze nie ma, nie dotarło ono ze sklepu: obsłuż je w BaseLinkerze jak dotąd i przekaż numer osobie, która opiekuje się Kompletorem. Alert zamyka się sam, gdy Kompletor połączy fakturę z zamówieniem (którąkolwiek drogą; wtedy pakowanie jest wstrzymane jak przy każdej fakturze z BaseLinkera). **Więcej niż 5 takich faktur na jednym koncie** w jednym przebiegu (np. tuż po przełączeniu): zamiast pojedynczych alertów jeden zbiorczy na konto z listą numerów ze sklepu (do 30, dalej „i N kolejnych”); odnośnik zgłoszenia (to, co przychodzi na Zulipa i w mailu) zaczyna tę listę. Gdy dojdzie nowe zamówienie bez pary, przychodzi nowe zgłoszenie z całą listą (stare się zamyka), więc każda nowa taka faktura daje wiadomość. Gdy lista tylko maleje, odświeża się w tym samym zgłoszeniu. Zgłoszenie zamyka się, gdy zostanie 5 lub mniej (wtedy znowu pojedyncze) albo żadne.

Co robi biuro:

1. Karta zamówienia → „Więcej” → „Zmień status…” → „Do wyjaśnienia”, w polu „Powód (zostanie w historii zamówienia)” wpisz „kończy BL”. Status i numer nadania wpisz potem w panelu sklepu, bo BaseLinker ich już nie wyśle.
2. Wyjątek: do zamówienia dodano towar po fakturze i tylko ten towar ma wyjść z Kompletora. Karta zamówienia → „Więcej” → „Pakuj mimo faktury z BaseLinkera” (z potwierdzeniem; wpis w historii zamówienia), spakuj go, potem „Więcej” → „Wyślij bez faktury” (Kompletor założy do niego dokument WZ). Gdy faktura z BaseLinkera nie jest jeszcze rozliczona w Kompletorze (czeka na dokument WZ do niej w programie do faktur), „Pakuj mimo…” odmawia: odłożony towar to wtedy towar z faktury, a nie dodany po niej. Spróbuj po rozliczeniu faktury.

„Zmień status…” i „Pakuj mimo faktury z BaseLinkera” wymagają uprawnienia „Zmiana statusu na dowolny dozwolony” (`zamowienia.status_dowolny`; Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia). Bez niego „Zmień status…” nie pojawia się w menu „Więcej” wcale, a „Pakuj mimo faktury z BaseLinkera” jest wyszarzony z wyjaśnieniem; takie zamówienie przekaż osobie z tym uprawnieniem (domyślnie właściciel). Ramka i znaczniki nie zmieniają statusu zamówienia ani nie oznaczają go jako wysłanego.

**Sklep nie odpowiada** (błąd 5xx, przekroczony czas): Kompletor traktuje to jako błąd przejściowy. Stany wysyła ponownie z odstępem do kilku minut, statusy i numery nadania do kilku prób, potem zostawia powiadomienie i czeka na „Wypchnij teraz” na ekranie konta. Zamówienia odczyta po powrocie sklepu. Włączenie zapisu do takiego sklepu odłóż, aż znowu odpowiada.

## Powrót do BaseLinkera

**Przed przełączeniem** w BaseLinkerze nic się nie zmienia, więc nie ma do czego wracać. Wystarczy zatrzymać Kompletora (`docker compose stop`). Dla porządku możesz usunąć klucz REST, który utworzyłeś dla Kompletora w WooCommerce, i aplikację Allegro.

**W dniu przełączenia, przed trybem pracy kont** (Kompletor jeszcze nic nie prowadzi): włącz w BaseLinkerze z powrotem wysyłanie danych w integracjach, przekazywanie faktur do programu księgowego i automaty. Automat faktur działa od zmiany statusu, więc zamówienia, które w nocy przeszły do statusu realizacji bez faktury, oraz opłacone zamówienia, które od rana stoją w statusie „Nowe”, trzeba ręcznie zafakturować albo przestawić. Zamknięcia z punktu cięcia zostają w Kompletorze i niczego w BaseLinkerze nie zmieniają.

**Po przełączeniu** (Kompletor wystawił już faktury i nadał przesyłki):

1. W Kompletorze na każdym koncie „Wyłącz zapis do sklepu” i „Wróć do trybu »Tylko podgląd«”, potem wyłącz faktury, nadawanie i wysyłkę maili. Nie przełączaj kont poleceniem ani w bazie: tylko panel przywraca wszystkie tryby konta.
2. Spisz z ekranów **Faktury**, **Przesyłki** i z listy zamówień: wysłane z fakturą Kompletora, zafakturowane i niewysłane, **spakowane bez faktury** (po powrocie do podglądu Kompletor ich już nie zafakturuje), w toku bez faktury oraz zamówienia ręczne, które Kompletor obsłużył za sklepy prowadzone w BaseLinkerze.
3. W BaseLinkerze, **zanim włączysz automaty:** wyłącz automat maila z fakturą, zamówienia wysłane przez Kompletora przestaw na status końcowy, a zafakturowane i niewysłane na status po spakowaniu (nigdy na status, od którego automat BaseLinkera wystawia fakturę). Zamówienia ręczne obsłużone w Kompletorze też na status końcowy, bez faktury.
4. Włącz przekazywanie faktur do programu księgowego, a spakowanym bez faktury wystaw fakturę w BaseLinkerze ręcznie, zanim wyjadą.
5. Włącz wysyłanie stanów, cen, statusów i numerów nadania oraz automatyczne akcje.
6. Zamówienia w toku bez faktury i opłacone zamówienia przyjęte w czasie pracy Kompletora (w BaseLinkerze stoją w „Nowe”, bo automaty działają od zdarzenia płatności) przestaw ręcznie na status realizacji: automat wystawi im fakturę. Na końcu włącz z powrotem automat maila z fakturą.

Faktury wystawione przez Kompletora zostają w programie do faktur (to prawdziwe dokumenty). Przy stanie magazynu z wFirmy oba systemy biorą stan z tego samego miejsca, więc po powrocie BaseLinker od razu pokazuje stan po wysyłkach z Kompletora.
