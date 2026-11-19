# Konfiguracja pierwszego dnia

W jakiej kolejności ustawić firmę po instalacji: sklepy, oferty, przypisania, przewoźnicy, godziny odbioru, zasady rezerwacji i użytkownicy.

Zacznij od konta właściciela założonego w kreatorze (opis w [Instalacji](instalacja.md)). Większość kroków wymaga uprawnienia „Ustawienia firmy”, które ma Właściciel.

Te same kroki prowadzi lista **Uruchomienie firmy** na **Pulpicie** (`/pulpit`): przy każdym kroku stan (zrobione,
do zrobienia, pominięte), przycisk do ekranu i „Pomiń”. Firma, która już działa (zamówienia ze sklepów starsze niż
7 dni albo podgląd obok BaseLinkera bez przeprowadzki), ma listę domyślnie schowaną: „Pokaż listę uruchomienia” na Pulpicie ją
przywraca. Nowe konto sklepu startuje w trybie „Tylko podgląd” także w firmie bez BaseLinkera; różnica jest taka, że
firma bez BaseLinkera przełącza je sama, bez administratora serwera: po sprawdzeniu połączenia na ekranie konta albo
wszystkie naraz na Pulpicie (karta „Stan kanałów”, uprawnienie „Zmiana trybu kanału”). Firma z BaseLinkerem ma na liście pierwszy krok „Przenieś dane z BaseLinkera” ([Migracja z
BaseLinkera](migracja-z-baselinkera.md)).

## Kolejność

### 1. Sklep (kanał sprzedaży)

Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → „Dodaj sklep”.

1. Wybierz rodzaj sklepu. Formularz pokaże pola dla tego rodzaju (adres, klucze).
2. Wpisz klucze. Skąd je wziąć i z jakimi uprawnieniami: [Integracje](integracje/README.md).
3. Kliknij „Sprawdź połączenie”.

Konto Allegro łączysz przyciskiem „Połącz z Allegro” na ekranie konta (opis: [Allegro: połączenie z panelu](integracje/allegro.md)).

Każdy sklep zaczyna w trybie „Tylko podgląd”: Kompletor czyta zamówienia i rezerwuje towar. Prowadzenie zamówień w Kompletorze włączasz przyciskiem „Włącz tryb pracy” (ekran konta, sekcja „Stan konta”, albo Pulpit → „Stan kanałów”).

### 2. Oferty

Na stronie sklepu kliknij „Pobierz oferty”. Kompletor pobierze listę ofert z kanału.

- Oferta, której SKU zgadza się z produktem w Kompletorze, zostaje przypięta do tego produktu.
- Oferta z nowym SKU tworzy nowy produkt ze stanem startowym z kanału, ale tylko w firmie bez BaseLinkera i bez wFirmy. Z nimi produkty zakłada import katalogu, a taka oferta czeka na liście „Do przypisania”.

Masz BaseLinkera i wFirmę? Katalog i powiązania możesz też przenieść importem. Opis w [Migracji z BaseLinkera](migracja-z-baselinkera.md).

### 3. Przypisania

Oferty, których system nie umie przypiąć sam, trafiają na listę „Do przypisania”. Przypisz każdą do produktu.

Zamówienie z ofertą bez przypisania trafia do „Do wyjaśnienia” z powodem „niezmapowana oferta”. Dlatego zrób ten krok przed włączeniem odczytu zamówień albo zaraz po nim.

Gdy oferta dostanie produkt później (przypisanie, „Pobierz oferty” albo import katalogu), takie zamówienia przeliczają się same: dostają produkt i rezerwację, a jeśli „niezmapowana oferta” była jedynym powodem, wracają do swojego statusu. Zaległe możesz też przeliczyć od razu poleceniem `docker compose exec web kompletor przelicz-zamowienia --firma <skrót firmy>` (bez `--zapisz` tylko liczy, z `--zapisz` przelicza).

### 4. Przewoźnicy

Ustawienia → Wysyłka i druk → Przewoźnicy (adres `/ustawienia/przewoznicy`, osoba z uprawnieniem do ustawień firmy). Cały ekran zapisuje jeden przycisk „Zapisz zmiany” na dole.

Kompletor wybiera przewoźnika po nazwie sposobu dostawy z zamówienia. W karcie „Który przewoźnik dla którego sposobu dostawy” każda reguła ma: kanał (albo „każdy kanał”), słowa, których szukamy w nazwie sposobu dostawy (rozdzielone przecinkami, wielkość liter bez znaczenia, puste = każdy sposób), przewoźnika i moduł wysyłki (czym Kompletor liczy albo nadaje przesyłkę; „bez modułu” = etykieta poza Kompletorem). Reguły sprawdzane są od góry, pierwsza pasująca wygrywa; kolejność zmienisz strzałkami, regułę dodasz przyciskiem „Dodaj regułę”, usuniesz przyciskiem „Usuń”. Reguła z presetu, która nie jest samą listą słów (np. `salon(u)? empik`), pokazuje się jako „wzorzec zaawansowany” i zostaje bez zmian, dopóki jej nie ruszysz. Taki wzorzec zmienia osoba techniczna: przycisk „Zamień na słowa” pojawia się tylko przy wzorcu złożonym z samych słów, bo zamiana nawiasów czy liter w nawiasach kwadratowych na zwykły tekst zmieniłaby, które zamówienia pasują. Reguła z ustawieniami technicznymi, których panel nie odtworzy (np. adres serwera przewoźnika ustawiony przez osobę techniczną), przy „Usuń” pyta o potwierdzenie: po zapisie te ustawienia przepadają, kopia zostaje w historii zmian. Konto przewoźnika (lista pod „Moduł wysyłki”), nadawanie i ustawienia konta odtworzysz sam, więc reguła tylko z nimi usuwa się bez pytania. Zapis zmienia reguły tylko wtedy, gdy coś się w nich zmieniło.

Nowa firma dostaje reguły startowe:

| Kiedy | Przewoźnik |
|---|---|
| zamówienie z Allegro | Allegro (Wysyłam z Allegro) |
| nazwa metody zawiera „paczkomat” | InPost Paczkomaty |
| nazwa zawiera „salon empik” albo „salonu empik” | DPD do salonu Empik |
| nazwa zawiera „dpd” | DPD |
| nazwa zawiera „osobist” | Odbiór osobisty |

Sam „kurier” bez nazwy przewoźnika nie wybiera nikogo: takie zamówienie trafia do „Do wyjaśnienia” z powodem „nieznana metoda dostawy”, dopóki nie dodasz reguły (np. słowo „kurier” → wybrany przewoźnik). Firmy z regułami sprzed tej zmiany mają swoje reguły bez zmian.

Pod formularzem jest „Sprawdzenie na ostatnich zamówieniach”: sposoby dostawy z ostatnich zamówień i numer reguły, która je dziś obsłuży (według zapisanych reguł). Zmiana reguł działa dla zamówień przyjmowanych od teraz; przewoźnika zamówienia już przyjętego zmienisz na karcie zamówienia.

**Konta przewoźników** (przycisk „Konta przewoźników” w nagłówku ekranu Przewoźnicy, adres `/ustawienia/przewoznicy/konta`): klucze kont u przewoźników (Base Courier, DPD, InPost, Orlen Paczka, GLS, Poczta Polska), ustawienia konta (np. FID płatnika DPD, format etykiety; rzadziej zmieniane pod „Zaawansowane”) i przełącznik „Nadawanie z Kompletora” przy regułach z modułem, który tworzy przesyłki. Sam przełącznik nie nadaje: Kompletor tworzy przesyłkę dopiero wtedy, gdy konto sprzedaży, z którego przyszło zamówienie, jest w trybie pracy (w trybie „Tylko podgląd” przesyłki nadaje dalej BaseLinker), a serwer ma włączone ekrany pracy (`EKRANY_PRACA`). Klucz po zapisie jest szyfrowany i nie wraca na ekran: widać tylko „ustawiony” albo „brak”, a puste pole przy zapisie znaczy „bez zmian”. „Sprawdź połączenie” zleca test w tle; wynik (działa / błąd z opisem i godziną) pojawia się przy koncie po odświeżeniu strony. Wysyłam z Allegro nie ma tu kluczy: korzysta z konta Allegro w Kanałach sprzedaży. Klucze ustawione przez administratora w konfiguracji serwera (własny serwer, jedna firma) ekran pokazuje jako „klucze z konfiguracji serwera”: „Sprawdź połączenie” działa z nimi, a klucz wpisany na ekranie ma pierwszeństwo.

**Drugie konto tego samego przewoźnika** (np. osobne DPD dla salonów Empik albo drugie InPost dla innej marki): na ekranie Konta przewoźników, karta „Drugie konto przewoźnika” na dole, wybierz przewoźnika, wpisz nazwę konta (np. „Salony Empik”) i kliknij **Dodaj konto**. Nowe konto dostaje własną kartę z kluczami: wpisz je i zapisz. Potem na ekranie Przewoźnicy w regule, która ma z niego korzystać, wybierz je pod „Moduł wysyłki” (lista „konto: …” pojawia się tylko wtedy, gdy przewoźnik ma więcej niż jedno konto) i zapisz. Reguła przeniesiona na inne konto traci ustawienia poprzedniego konta (np. FID płatnika) i ma wyłączone nadawanie, żeby nie nadawać kluczami nowego konta na płatnika starego: po zapisie uzupełnij ustawienia konta i włącz nadawanie na ekranie Konta przewoźników (komunikat po zapisie mówi, które reguły przeniesiono). Konto musi być na liście kont tego przewoźnika. Konta nie da się dziś usunąć z panelu; nieużywane po prostu nie ma reguł.

### 5. Godziny odbioru

Ustawienia → Wysyłka i druk → Przewoźnicy → karta „Odbiory”.

Dla każdego przewoźnika ustaw dni tygodnia, godzinę odbioru, „wyślemy dziś do” i czy w ogóle odbiera. Kolejka pakowania układa się od najbliższego odbioru. W polskie święta odbioru nie ma.

### 5a. Strefy magazynu

Ustawienia → Magazyn i strefy → Strefy magazynu (adres `/ustawienia/strefy`, grupa „Magazyn” na liście ustawień).

Strefa to część magazynu, z której zbiera się towar osobno (np. „regały z kawą”, „pomieszczenie obok”). Każda ma nazwę, kolor i miejsce na liście; ta kolejność to kolejność filtrów na ekranie Pakowanie. Pod strefami są reguły: słowa w nazwie albo SKU produktu → strefa, sprawdzane od góry. Strefa ustawiona ręcznie w karcie produktu (sekcja „Strefa magazynu”) wygrywa z regułą. Kompletor nie ma kategorii produktów, więc przypisanie idzie po słowach albo ręcznie. Zmiana działa od razu na kolejce pakowania. Strefy, którą ma ustawioną ręcznie choć jeden produkt, nie usuniesz, dopóki nie zmienisz strefy tych produktów. Firma bez stref nie widzi filtra stref na ekranie Pakowanie. Zapis: jeden przycisk „Zapisz zmiany” na dole.

### 6. Zasady rezerwacji

Ustawienia → Magazyn i strefy → Zasady rezerwacji.

Ustaw, po ilu dniach roboczych przypominamy o płatności i zwalniamy rezerwację nieopłaconego zamówienia, oraz ile czekamy, gdy brakuje wszystkiego. Przełącznik „Tryb sezonowy” skraca terminy. Szczegóły i przykład: [Rezerwacje](rezerwacje.md).

### 7. Użytkownicy

Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia (adres `/ustawienia/uzytkownicy`, osoba z uprawnieniem „Użytkownicy i uprawnienia”).

Ekran to tabela osób: imię i nazwisko z e-mailem, rola, kolumna „Inaczej niż w roli” (np. „+2 dołożone, −1 odebrane” względem zestawu roli), ostatnia aktywność w tej firmie i stan dostępu. Przycisk **Dodaj osobę** nad tabelą otwiera okno z polami imię i nazwisko, e-mail (login) i rola, a pod rolą z rozwijaną listą **Dokładne uprawnienia**: wstępnie zaznaczony jest zestaw wybranej roli, a każde uprawnienie możesz zaznaczyć albo odznaczyć, zanim osoba dostanie dostęp. Na własnym serwerze (self-host) nowa osoba dostaje hasło startowe, które okno pokazuje **jeden raz**; przekaż je osobie, a przy pierwszym logowaniu panel poprosi o nowe (po zmianie od razu otwiera się pulpit z pełnym menu). W hostingu okno nie ma pola imienia (osoba poda je sama), ma tę samą listę dokładnych uprawnień i tworzy zaproszenie ważne 7 dni z zaznaczonym zestawem: osoba sama ustawia hasło z linku, a otwarte zaproszenia widać pod tabelą z przyciskiem „Cofnij”.

Przycisk **Szczegóły** w wierszu otwiera okno osoby: rola z krótkim opisem i uprawnienia w grupach (Podgląd, Zamówienia, Dane klientów, Magazyn i pakowanie, Produkty, Zwroty, Administracja). Rola jest punktem startu: wybór roli zaznacza jej zestaw, a potem każde uprawnienie (także z roli) możesz zaznaczyć albo odznaczyć, pojedynczo albo całą grupą („Zaznacz grupę”, „Odznacz grupę”). Przy uprawnieniu widać, czy jest „dołożone”, czy „odebrane” względem roli, a **Przywróć zestaw roli** wraca do zestawu domyślnego. Bez „Podgląd panelu” zapis jest odrzucany, bo osoba nie otworzyłaby panelu; żeby odciąć osobę, użyj „Wyłącz dostęp do firmy”. „Zapisz” w oknie zapisuje rolę i uprawnienia, wynik pokazuje się w rogu ekranu, a błąd (np. „to ostatni właściciel firmy”) pod polem roli. W tym samym oknie jest „Wyłącz dostęp do firmy” (pyta o potwierdzenie i wylogowuje osobę z tej firmy) albo „Włącz dostęp ponownie”.

| Rola | Co może |
|---|---|
| Właściciel | Wszystko, w tym ustawienia firmy i użytkownicy. |
| Biuro | Podgląd panelu, porównanie z BaseLinkerem, zamówienia (statusy, pozycje, podział, notatki, zamówienia ręczne, faktura na karcie), pełne dane klientów, „Przyjechał kurier”, zamykanie listy „Do poprawy”, decyzje o brakach (wyślij resztę, dośle, poczekaj, zamień). |
| Magazyn | Podgląd panelu, „Przyjechał kurier”, stanowisko pakowania i druk kart, statusy i notatki na karcie zamówienia, skrót danych klienta (imię, pierwsza litera nazwiska, miasto). |

Rolę właściciela nadaje i odbiera tylko właściciel. Nie nadasz uprawnienia, którego sam nie masz. Dostęp możesz osobie wyłączyć bez usuwania konta i historii. Własne hasło zmieniasz w Ustawienia → Zespół i dostęp → Zmiana hasła, nie na tym ekranie.

### 7a. Druk w magazynie

Ustawienia → Wysyłka i druk → Druk (adres `/ustawienia/druk`).

Stanowisko druku to komputer w magazynie z programem „Kompletor Druk”: karty, listy i etykiety drukują się na nim bez otwierania PDF-ów. Przycisk **Pobierz program** w nagłówku ekranu pobiera paczkę programu (gdy administrator instalacji jej nie udostępnił, przycisk jest wyłączony z tym opisem). W „Nowe stanowisko” wpisz nazwę (np. „Pakowanie przy oknie”) i kliknij **Dodaj stanowisko**: kod stanowiska tworzy się z nazwy (`pakowanie-przy-oknie`, przy powtórzonej nazwie z końcówką `-2`), a własny kod wpiszesz w „Własny kod stanowiska”. Potem przy stanowisku „Utwórz token i kod instalacyjny”: kod widać tylko raz, wklejasz go w instalatorze na komputerze. Na końcu „Wydruk testowy” na każdą drukarkę i „Co na jakiej drukarce”. Wyniki pokazują się w rogu ekranu.

**Na komputerze w magazynie: strona „Kompletor Druk (ustawienia)”.** Po rozpakowaniu paczki i dwukliku w `Zainstaluj.cmd` program startuje sam i otwiera w przeglądarce stronę ustawień; później otwiera ją skrót **„Kompletor Druk (ustawienia)”** na pulpicie albo w menu Start. Strona działa tylko na tym komputerze (adres `http://127.0.0.1:…`, nie da się jej otworzyć z innego komputera). Na niej:

- **stan** zwykłym zdaniem: „Połączono z Kompletorem” albo „Brak połączenia z Kompletorem od 10:42” z podpowiedzią, co sprawdzić; ostatni wydruk i ostatni błąd;
- **Drukarki**: lista drukarek z Windows z numerami. Przy każdej wybierz „Kartki A4”, „Etykiety” albo „Nie używaj”. Gdy do jednego rodzaju wybierzesz kilka drukarek, w polu obok ustawisz, która jest główna, a która zapasowa. „Wydruk próbny” drukuje kartkę z numerem z listy, żeby wiedzieć, która drukarka to która. Po zmianach kliknij **Zapisz** na pasku na dole: program używa nowych ustawień od razu, bez wylogowania z Windows;
- **Podłącz do Kompletora**: wklej kod połączenia `kmi_…` z tego ekranu (Ustawienia → Wysyłka i druk → Druk) i kliknij „Sprawdź i podłącz”. Kod nie wraca na ekran; nowy kod wklejasz tylko po utworzeniu nowego w Kompletorze;
- **Ostatnie zdarzenia**: 20 ostatnich wpisów (wydruki, błędy, utrata i powrót połączenia) prostymi zdaniami;
- przycisk **Uruchom ponownie program** w prawym górnym rogu;
- ostrzeżenie, gdy Windows sam zmienia drukarkę domyślną, z instrukcją wyłączenia.

Strona nie dodaje stanowisk, nie tworzy kodów i nie pokazuje zleceń: to robi się tutaj, w Kompletorze. Gdy przeglądarka się nie otworzy, `Zainstaluj.cmd /konsola` prowadzi przez to samo w czarnym oknie.

#### Drukarki na różnych komputerach: etykiety przy pakowaniu, karty na drukarce w biurze

W karcie każdego stanowiska, w „Co na jakiej drukarce”, każdy rodzaj wydruku (karty zamówień, lista wysyłkowa, spis produktów, etykiety) wybiera drukarkę z listy drukarek **wszystkich włączonych stanowisk firmy**, np. „Komputer w biurze: A4 (HP LaserJet)” albo „Pakowanie przy oknie: Termiczna 1 (Zebra), ten komputer”. Wydruk wychodzi na komputerze, przy którym stoi wybrana drukarka. Pakujący wybiera swoje stanowisko raz (w nagłówku Pakowania albo obok przycisku „Drukuj”; przeglądarka je pamięta), a każdy przycisk drukuje według przypisań tego stanowiska. Po kliknięciu widać, gdzie wyszło, np. „Wysłano na: Komputer w biurze, A4”.

Przykład z dwoma stanowiskami pakowania:

- „Pakowanie 1” ma własną drukarkę termiczną: etykiety → „Pakowanie 1: Termiczna 1, ten komputer”, karty, lista i spis → „Komputer w biurze: A4”.
- „Pakowanie 2” to drugi stół z tabletem, bez programu druku: etykiety → „Pakowanie 1: Termiczna 2”, karty, lista i spis → „Komputer w biurze: A4”. Stanowisko bez programu druku dodajesz tak samo („Dodaj stanowisko”), tylko bez tokenu; wybierasz mu drukarki innych komputerów.

Gdy komputer z wybraną drukarką jest wyłączony, nie ma tokenu albo nie odpowiada od 3 minut, wydruk na nim nie powstaje, a komunikat nazywa komputer i drukarkę (wtedy „Pobierz PDF” działa jak zawsze). Pod przypisaniami stanowisko pokazuje, których wydruków teraz nie da się zlecić i dlaczego. Nagłówek Pakowania i stanowiska pakowania pokazuje stan drukarek, których wybrane stanowisko naprawdę używa, także na innych komputerach. Przy „Wyłącz stanowisko” okno potwierdzenia wymienia stanowiska, które drukują na jego drukarkach. Zapasowa drukarka po awarii termicznej działa jak dotąd, wyłącznie na komputerze, przy którym stoi ta termiczna.

### 7b. Klucze API

Ustawienia → Integracje i agenci AI → Klucze API (adres `/ustawienia/klucze-api`).

Klucz API daje innemu systemowi (np. chatbotowi obsługi klienta, sklepowi hurtowemu albo platformie sprzedaży e-booków) dostęp do stanów i zamówień tej firmy. Utwórz osobny klucz dla każdego systemu, tylko z potrzebnymi zakresami: `stany:odczyt` (stany produktów), `zamowienia:odczyt` (statusy i numery nadania), `zamowienia:zapis` (dodawanie zamówień z produktami z katalogu). Pełny klucz widać tylko raz, zaraz po utworzeniu; potem na liście zostaje sam początek. System wysyła klucz w nagłówku `Authorization: Bearer …` na adresy `/api/v1/…`. Odpowiedzi nie zawierają danych osobowych klientów. Klucz, który wyciekł albo nie jest już potrzebny, odwołaj: od tej chwili system dostaje odmowę. Limit: 120 żądań na minutę na klucz. Opis adresów i pól dla programisty systemu, który się łączy, ma administrator instalacji (dokument techniczny API w repozytorium). Klucz dla asystenta AI: [Agenci AI](agenci-ai.md).

### 7c. Automatyczne wyłączanie integracji

Ustawienia → Komunikacja i poczta → Powiadomienia → karta „Automatyczne wyłączanie integracji” (adres `/ustawienia/powiadomienia`).

Pole „Wyłącz po tylu błędach z rzędu” (domyślnie 5, od 2 do 50): po tylu kolejnych odrzuceniach klucza, hasła albo złych ustawieniach jednego konta sklepu albo przewoźnika Kompletor przestaje to konto wołać i daje alert. Włączasz je przyciskiem „Włącz ponownie” w szczegółach konta. Więcej: [Integracje](integracje/README.md#limity-zapytań-i-automatyczne-wyłączanie).

### 8. Dostawca AI (opcjonalnie)

Podpowiedź opisu produktu (przycisk „Podpowiedz opis (AI)” na karcie produktu i w „Dodaj produkt”, [Produkty](produkty.md)) działa, gdy instalacja ma klucz dostawcy AI. Na własnym serwerze wystarczy zmienna `AI_API_KEY` przy instalacji. Klucz firmy, model i packshot (zdjęcie na białym tle z AI, klucz Kie.ai) ustawia właściciel w **Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI**; klucze zapisują się zaszyfrowane w sekretach firmy (`AI_API_KEY` i `KIE_API_KEY` konta „AI”, to samo co `npm run konto` i `npm run sekret`). Na własnym serwerze działa też zmienna `KIE_API_KEY`, w hostingu klucze platformy `PLATFORM_AI_API_KEY` i `PLATFORM_KIE_API_KEY` (koszt z salda firmy, cennik i narzut w `lib/ai.ts`; dobowy limit na firmę `PLATFORM_AI_LIMIT_DZIENNY_GROSZE`, domyślnie 2000 gr, 0 = wyłączone). Bez klucza przycisk jest wyłączony z tym samym opisem. Tam też włącza się asystenta „Zapytaj” (odpowiedzi z Pomocy na każdym ekranie panelu, domyślnie wyłączony; [Agenci AI](agenci-ai.md)).

## Ustawienia w działach

**Ustawienia** (zębatka w górnym pasku albo pozycja „Ustawienia” w menu po lewej) otwierają drugą kolumnę z działami, a w dziale zakładki. Samo „Ustawienia” prowadzi do pierwszego działu, który widzisz; osoba bez uprawnienia do ustawień firmy widzi tylko dział „Zespół i dostęp” z własnym hasłem. Adresy ekranów się nie zmieniły (linki z maili i z tej dokumentacji działają), zmieniło się tylko miejsce w nawigacji. Każdy dział ma też własny adres, który prowadzi do jego pierwszej zakładki, np. `/ustawienia/dzial/wysylka`.

| Dział | Zakładki | Adres działu |
|---|---|---|
| Sprzedaż i kanały | Kanały sprzedaży, Statusy zamówień, Automatyczne akcje | `/ustawienia/dzial/sprzedaz` |
| Magazyn i strefy | Strefy magazynu, Zasady rezerwacji | `/ustawienia/dzial/magazyn` |
| Wysyłka i druk | Przewoźnicy (w nim przycisk „Konta przewoźników”), Druk | `/ustawienia/dzial/wysylka` |
| Dokumenty i faktury | Dane firmy, Dokumenty sprzedaży (program do faktur albo „bez programu”, numeracja i KSeF) | `/ustawienia/dzial/dokumenty` |
| Komunikacja i poczta | Poczta, Szablony maili, Powiadomienia | `/ustawienia/dzial/komunikacja` |
| Zespół i dostęp | Użytkownicy i uprawnienia, Dane klientów, Zmiana hasła | `/ustawienia/dzial/zespol` |
| Integracje i agenci AI | Integracje (wszystkie połączenia na jednej liście), Klucze API, Agenci AI | `/ustawienia/dzial/integracje` |
| Przejście z BaseLinkera | Przeprowadzka (tylko firma z BaseLinkerem) | `/ustawienia/dzial/bl` |

Zakładkę widzisz tylko z uprawnieniem, którego ekran wymaga (np. „Użytkownicy i uprawnienia” z uprawnieniem do zarządzania osobami). Na telefonie działy chowają się pod przyciskiem „Dział: …” nad treścią, a zakładki przewijają się w poziomie. Co jest podłączone (sklepy, przewoźnicy, program do faktur, poczta, AI), widać na jednym ekranie: **Ustawienia → Integracje i agenci AI → Integracje** ([Integracje](integracje/README.md#ekran-integracje)).

## Drogi z menu

| Co | Gdzie |
|---|---|
| Co jest podłączone (stan wszystkich integracji) | Ustawienia → Integracje i agenci AI → Integracje |
| Sklepy i oferty | Ustawienia → Sprzedaż i kanały → Kanały sprzedaży |
| Przewoźnicy, godziny odbioru, reguły przewoźników | Ustawienia → Wysyłka i druk → Przewoźnicy |
| Klucze i ustawienia kont przewoźników, test połączenia | Ustawienia → Wysyłka i druk → Przewoźnicy → przycisk „Konta przewoźników” |
| Strefy magazynu i reguły stref | Ustawienia → Magazyn i strefy → Strefy magazynu |
| Zasady rezerwacji, bufor (podgląd) | Ustawienia → Magazyn i strefy → Zasady rezerwacji |
| Stanowiska druku w magazynie, „Pobierz program” | Ustawienia → Wysyłka i druk → Druk |
| Drugie konto przewoźnika | Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → karta „Drugie konto przewoźnika” |
| Dostęp innych systemów (API) | Ustawienia → Integracje i agenci AI → Klucze API |
| Alerty na Zulip | Ustawienia → Komunikacja i poczta → Powiadomienia |
| Osoby w firmie, rola i uprawnienia osoby | Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia → „Szczegóły” w wierszu osoby; nowa osoba: „Dodaj osobę” nad tabelą |
| Własne hasło | menu konta (prawy górny róg) → „Zmiana hasła” albo Ustawienia → Zespół i dostęp → Zmiana hasła |
| Próg automatycznego wyłączania integracji | Ustawienia → Komunikacja i poczta → Powiadomienia → „Automatyczne wyłączanie integracji” |
| „Włącz ponownie” konta wyłączonego po błędach | Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto (baner na górze) albo Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” |
| Produkty, stany, strefa produktu | Produkty → produkt |
| Braki danych produktów (bez EAN, wagi, oferty, strefy), kompletne karty | Produkty → kafle nad listą (kafel = filtr listy) |
| Nowy produkt, produkty bez stanu | Produkty → „Dodaj produkt”; menu → Produkty → „Produkty bez stanu” |
| Zwroty i reklamacje (podgląd) | menu → Zwroty i reklamacje |
| Braki (po produkcie albo po zamówieniu, decyzja dla zaznaczonych), nadmiar rezerwacji, „Do poprawy w wFirmie” | Braki towaru |
| Porównanie z BaseLinkerem | menu → Przejście z BaseLinkera → „Porównanie z BaseLinkerem” (tylko firma z BaseLinkerem) |
| Plan maili (podgląd) | menu → Przejście z BaseLinkera → „Maile do klientów: podgląd” |
| Ta dokumentacja | menu konta (prawy górny róg) → „Pomoc” |
| Firma (gdy masz dostęp do kilku), wylogowanie | menu konta (prawy górny róg): „Firma” + „Przełącz”, „Wyloguj” |
| Statusy zamówień z licznikami, kolejka jednego kuriera | menu po lewej → Zamówienia → status (np. „Do realizacji”) → przewoźnik pod nim |
| Gęstość widoku (więcej wierszy albo większe przyciski) | menu konta (prawy górny róg, na telefonie kółko z inicjałami) → „Widok: Gęsto / Wygodnie” (zapisuje się na koncie osoby i działa też w pakowaniu) |
| Motyw: jasny, ciemny albo jak system | menu konta (prawy górny róg, na telefonie kółko z inicjałami) → „Motyw” (zapisuje się w przeglądarce, osobno na każdym urządzeniu; bez wyboru panel jest jasny) |
