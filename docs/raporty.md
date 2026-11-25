# Raporty sprzedaży: okres, kanał, produkt i marża

Ekran **Raporty** w menu panelu (grupa „Finanse”, pod „Fakturami”) pokazuje, ile sprzedajesz: w dniach, tygodniach albo miesiącach, w każdym kanale
sprzedaży i na każdym produkcie. Obok sprzedaży jest marża z ceny zakupu i porównanie z wybranym okresem (np. rok do roku).
Ten sam raport pobierzesz jako plik Excela (XLSX).

## Gdzie to jest i kto widzi

Menu **Raporty** (adres `/raporty`). Ekran i plik Excela widzi osoba z uprawnieniem **„Raporty sprzedaży i marża”**:
domyślnie role Właściciel i Biuro. Rola Magazyn domyślnie go nie ma, więc nie widzi pozycji Raporty w menu, a adres
`/raporty` daje „nie znaleziono”. Właściciel nada je wybranej osobie w **Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia** (grupa „Podgląd”).

Eksport listy zamówień do Excela (Zamówienia → „Eksport Excel (XLSX)”) zostaje przy liście zamówień, tak jak eksport CSV:
nie ma w nim marży ani kosztu zakupu.

## Jak wybrać zakres

1. Wejdź w **Raporty** w menu.
2. Kliknij skrót („Ten miesiąc”, „Poprzedni miesiąc”, „Ostatnie 7 dni”, „Ostatnie 30 dni”, „Ten rok”) albo wpisz
   daty **Od** i **Do** i kliknij **Pokaż**.
3. **Podział**: „Samo dobierze” pokazuje dni przy zakresie do 62 dni, tygodnie do ok. pół roku, dalej miesiące.
   Możesz wybrać sam. Tydzień zaczyna się w poniedziałek.
4. **Kanał**: wszystkie albo jedno konto (np. jeden sklep). Nazwa konta w tabeli „Kanały” też zawęża raport.
5. **Porównaj z**: z czym porównać liczby (szczegóły niżej, w „Porównanie z innym okresem”).

Zakres to najwyżej 366 dni. Daty są w czasie polskim, a obie granice wchodzą do raportu.

## Porównanie z innym okresem

Pole **Porównaj z** w filtrach raportu (obok „Kanału”) wybiera okres, z którym raport porównuje liczby:

- **Poprzedni okres**: domyślnie. Tyle samo dni, ile ma zakres, kończące się dzień przed nim
  (zakres 1–31.10 porównuje się z 31.08–30.09).
- **Rok wcześniej**: te same daty rok wcześniej, np. 1–25.11.2026 z 1–25.11.2025, a „Ten rok” z tym samym
  kawałkiem poprzedniego roku. Luty do lutego to zawsze cały luty (także 29 dni w roku przestępnym); dzień 29.02 nie ma
  pary w roku bez tego dnia.
- **Miesiąc wcześniej**: np. 1–25.11 z 1–25.10, cały październik z całym wrześniem. Do wyboru, gdy zakres
  mieści się w jednym miesiącu.
- **Tydzień wcześniej**: zakres przesunięty o 7 dni. Do wyboru, gdy zakres mieści się w jednym tygodniu
  (od poniedziałku do niedzieli).
- **Własny zakres**: wpisz daty **Od** i **Do** w polu „Własny zakres porównania” (najwyżej 366 dni, może
  mieć inną liczbę dni niż zakres; zdanie nad kaflami podaje wtedy liczbę dni). Daty liczą się tylko przy tym wyborze.
- **Bez porównania**: kafle, tabele i plik Excela bez liczb porównania.

Wybór jest w adresie strony (`/raporty?od=2026-11-01&do=2026-11-25&porownaj=rok`, własny zakres:
`porownaj=wlasny&porownaj_od=…&porownaj_do=…`), więc link do raportu z porównaniem możesz komuś wysłać. Skróty zakresu
(„Ten miesiąc”, „Ten rok” itd.) zachowują wybór; gdy do nowego zakresu nie pasuje (np. „miesiąc wcześniej” przy
„Ten rok”), wraca porównanie z poprzednim okresem. Niepasujący wybór wpisany w adres pokazuje ostrzeżenie „Nie da się
tak porównać” i raport z poprzednim okresem.

Porównanie liczy się tymi samymi zasadami co zakres: anulowane poza sprzedażą (osobno), zamówienia w innych walutach
po tym samym kursie NBP, zwroty odjęte, archiwum zamówień wliczone.

**Okres porównania przed początkiem danych.** Kompletor zna sprzedaż konta od najwcześniejszego z dni: pierwszego
pełnego dnia, w którym sam czyta konto (dzień po pierwszym odczycie, bo zamówienia zrealizowane przed nim zostają poza
raportem), albo początku wgranego archiwum zamówień tego konta (początek zakresu importu). Tylko gdy żadnej z tych
granic nie ma, liczy się pierwsze zamówienie konta; pojedyncze starsze zamówienie nie przesuwa początku danych. Gdy okres porównania zaczyna się wcześniej niż dane któregoś konta z raportu,
nad kaflami pojawia się ostrzeżenie „Porównanie niepełne” z nazwą konta i dniem, od którego są jego dane. Liczby
porównania mają wtedy dopisek „(dane niepełne)”, a zmian w procentach nie pokazujemy, żeby zaniżona baza nie dawała
fałszywego wzrostu. Gdy cały okres porównania jest przed danymi, ekran pisze „Brak danych za okres porównania” zamiast
zer. W tabeli „Kanały” dopisek dotyczy tylko konta, którego dane zaczynają się później; wybierz to konto w polu „Kanał”,
żeby porównać pozostałe bez niego.

## Co widać na ekranie

- **Kafle**: liczba zamówień, wartość zamówień brutto, średnia wartość zamówienia, sprzedaż produktów netto i marża.
  Nad kaflami jest zdanie „Porównanie z: …” z datami okresu porównania, a pod każdą liczbą wynik tego okresu z krótkimi
  datami (np. „1–25.11.2025: 38 450,00 zł”) i zmiana w procentach.
- **Wykres**: wartość brutto (albo liczba zamówień) w każdym dniu, tygodniu albo miesiącu. Najedź na słupek, żeby
  zobaczyć liczby. Jaśniejszy słupek to okres niepełny (np. tydzień, który zaczął się przed wybranym zakresem).
  Pod wykresem rozwiniesz **Tabelę okresów**: pod wartością brutto każdego dnia, tygodnia albo miesiąca jest wartość
  odpowiadającego mu okresu porównania i zmiana w procentach.
- **Kanały**: każde konto kanału z zamówieniami, wartością, sprzedażą produktów i marżą; pod wartością brutto jest
  wartość tego konta w okresie porównania. Konto, które sprzedawało tylko w okresie porównania, też ma swój wiersz.
- **Produkty**: najlepiej sprzedające się produkty (50 na ekranie, do 1000 w pliku Excela).

Na telefonie część kolumn (średnia, marża w procentach, sprzedaż brutto) chowa się, a pełne liczby są w pliku Excela.

## Jak liczymy

- **Data**: dzień złożenia zamówienia w kanale (nie dzień wysyłki ani płatności), w czasie polskim.
- **Anulowane** zamówienia nie wchodzą do sprzedaży. Raport pokazuje je osobno: ile ich było i na jaką kwotę.
- **Zamówienie liczy się raz.** Gdy część zamówienia idzie później osobną paczką („dośle później”), to dalej jedno
  zamówienie. Pozycje liczą się tam, gdzie są: wysłane w paczce i dosłane później.
- **Wartość zamówień brutto** to kwota zamówienia z kanału, razem z dostawą, tak jak na pulpicie.
- **Inne waluty.** Zamówienie w innej walucie (np. z czeskiego Allegro w CZK) wchodzi do kwot w złotych (wartość,
  średnia, sprzedaż produktów, zwroty, marża, anulowane) po przeliczeniu ostatnim kursem średnim NBP (tabela A). To
  wartość informacyjna, nie księgowa: jeden kurs na walutę dla całego zakresu (także porównania z poprzednim okresem),
  bez kursu z dnia zamówienia. Kurs pobiera worker przy starcie i potem raz na dobę; w weekend i święto obowiązuje
  ostatnia opublikowana tabela. Koszt zakupu jest w złotych, więc marża = sprzedaż netto po przeliczeniu − koszt.
  Kwota z przeliczeniem ma znak „≈”, a pod sumą jest jedno zdanie z kursem i jego datą. Rozbicie na waluty (waluta,
  zamówienia, wartość w walucie, kurs NBP z datą, wartość w złotych, udział) pokazuje tabela „Waluty” w Raportach i
  arkusz „Waluty” w pliku Excela, tylko gdy w zakresie jest więcej niż jedna waluta. Waluta, dla której nie ma kursu
  (kurs jeszcze nie pobrany albo NBP jej nie notuje), nie wchodzi do kwot w złotych: jej kwota jest obok sumy,
  np. „175,35 zł + 957,00 CZK”, z dopiskiem o braku kursu, nigdy 1:1. Walutę bierzemy z zamówienia w kanale;
  zamówienie dodane ręcznie jest w złotych. Tak samo liczy pulpit („Dziś” i wykres miesiąca) i API (`inneWaluty`).
  Karta zamówienia, lista zamówień, pakowanie i faktury zostają w walucie zamówienia.
- **Sprzedaż produktów** to same pozycje, bez dostawy: ilość razy cena z kanału. Pozycje odrzucone, zamienione albo
  usunięte w kanale się nie liczą (liczy się produkt, który poszedł zamiast nich).
- **Netto** liczymy z brutto pozycji i stawki VAT pozycji (albo produktu). Stawki „zw”, „np” (też „np I”, „np II”),
  „oo” i „0” to netto równe brutto. Pozycja bez żadnej stawki liczy się z 23%. Stawka, której raport nie rozpoznaje
  (np. literówka wpisana na karcie zamówienia), liczy się ze stawki produktu, a bez niej z 23%. Nad kaflami pojawia się
  wtedy ostrzeżenie z liczbą takich pozycji, a w pliku Excela wiersz „Pozycje z nierozpoznaną stawką VAT”. Popraw stawkę
  na karcie zamówienia (sekcja „Pozycje”) albo produktu.
- **Zwroty** (zwrot towaru albo korekta, poza odrzuconymi) odejmujemy od sprzedaży produktów, kosztu i sztuk
  w okresie, w którym złożono zamówienie, nie w okresie zwrotu. Zwrot z października do zamówienia z września zmienia
  więc raport września, a raport za zamknięty miesiąc może się jeszcze zmienić. Zwrot liczy się od chwili zgłoszenia
  (także gdy paczka jest jeszcze w drodze), nie dopiero od przyjęcia na magazyn. Kwota zwrotów brutto jest pod kaflami.
- **Marża** = sprzedaż netto po zwrotach minus koszt zakupu netto. Koszt = ilość razy **cena zakupu netto** produktu:
  z wFirmy, gdy firma ją ma, albo z pola „Cena zakupu netto” w karcie produktu. Produkt na wagę ma cenę zakupu za kilogram.
  Zestaw bez własnej ceny zakupu liczy się z cen składników (gdy wszystkie je mają).
- **Brak ceny zakupu**: produkt bez ceny zakupu nie ma marży. Raport pisze „brak ceny zakupu” i nie liczy go jako
  marży 100%. Marża w kaflu i w procentach dotyczy tylko sprzedaży produktów, które mają cenę zakupu, a kwota sprzedaży
  bez ceny zakupu jest podana obok. Żeby ją objąć marżą, uzupełnij cenę zakupu w karcie produktu (Produkty → produkt).
- **Porównanie**: domyślnie poprzedni okres ma tyle samo dni i kończy się dzień przed wybranym zakresem; inne wybory
  opisuje rozdział „Porównanie z innym okresem”.
- **Zamówienia spoza Kompletora** (z kanału, ale nieprzyjęte do realizacji, np. sprzed uruchomienia systemu) nie wchodzą
  do raportu. Raport podaje tylko ich liczbę i kwotę. Wyjątek: zamówienia przeniesione do archiwum (niżej) liczą się
  z archiwum, a nie jako „spoza Kompletora”.
- **Archiwum zamówień** (zamówienia ze sklepów i marketplace'ów sprzed przejścia na Kompletora, np. od 01.01.2025):
  liczą się w tych samych kaflach, okresach, kanałach i produktach co bieżące, więc raport za listopad 2025 da się
  postawić obok listopada 2026. Pod kaflami jest dopisek „W tym z archiwum: N zamówień za X zł”. Zasady:
  - zamówienie liczy się raz: jeśli jest już w Kompletorze, archiwum go nie dubluje;
  - zrealizowane i w realizacji to sprzedaż; anulowane, zwrócone w całości i nieopłacone (oczekujące na płatność,
    wstrzymane, nieudana płatność, poza pobraniem) to anulowane, poza sprzedażą; szkice koszyka się nie liczą;
  - zwrot części kwoty w sklepie odejmuje się od pozycji proporcjonalnie do ich wartości (sklep nie mówi, której
    pozycji dotyczył); w Empiku zwrot jest przy konkretnej pozycji; Allegro zwrotów w zamówieniu nie podaje, więc
    archiwum Allegro ich nie odejmuje;
  - kanały: sklepy WooCommerce, Allegro (z API za ostatnie 12 miesięcy, starsze dni z zapisanego wcześniej zrzutu),
    Empik i EasyTools, każdy jako osobne konto kanału (filtr konta w raporcie pozwala je wyłączyć); zamówienie
    EasyTools ma jedną pozycję bez produktu z katalogu (kanał nie podaje SKU), więc wchodzi do sprzedaży, a nie do marży;
  - Allegro sprzed okna API (starsze niż 12 miesięcy) pochodzi z faktur poprzedniego systemu obsługi zamówień. Faktura
    nie podaje kanału, więc kanał jest odtworzony: faktura, która ma parę w zamówieniu innego źródła (archiwum sklepu,
    Empiku, EasyTools, Allegro z API albo zamówienie w Kompletorze; ta sama waluta, kwota brutto różna najwyżej o 1 gr,
    data sprzedaży od dnia przed złożeniem do 21 dni po nim), należy do tamtego zamówienia i nie jest liczona drugi raz;
    faktura bez pary liczy się jako Allegro. Każdy kolejny import faktur liczy pary od nowa na całym zakresie i usuwa
    z archiwum faktury zapisane wcześniej, które teraz mają parę albo wypadły za koniec zakresu. Takie zamówienia liczą się normalnie,
    a pod kaflami jest osobne zdanie „Z tego N zamówień za X zł to faktury z poprzedniego systemu (…), liczone jako
    Allegro”. Mogą tam trafić też drobne źródła spoza tych kanałów (np. sprzedaż telefoniczna) i nie ma dat złożenia,
    tylko daty sprzedaży z faktury. Pozycje łączą się z produktem po SKU, potem po EAN; zwrot to faktura korygująca;
    gdy do importu dołączony jest plik źródeł zamówień z archiwum poprzedniego systemu (numer zamówienia i nazwa konta
    źródła), kanał faktury bierze się z pliku, bez parowania: faktura z konta Allegro to zamówienie Allegro bez zdania
    „liczone jako Allegro”, faktura z konta sklepu albo Empiku się nie importuje, bo ta sprzedaż przychodzi z archiwum
    swojego kanału (gdy w bazie nie ma jej zamówienia, raport przebiegu ją liczy jako „bez odpowiednika w bazie”
    z numerem faktury, a przebieg kończy się błędem; przebieg z zapisem zatrzymuje się wtedy przed zapisem i niczego
    nie usuwa), a źródło oznaczone jako świadomie pominięte (np. sprzedaż telefoniczna) nie wchodzi
    do raportu, z liczbą i kwotą w raporcie przebiegu; parowanie zostaje tylko dla faktur spoza pliku; faktury
    zapisane wcześniej jako Allegro, które plik przypisuje innemu źródłu, schodzą z archiwum tylko w zakresie dat
    danego importu, czyli tam, gdzie sprawdzany jest brak odpowiednika;
  - marża archiwum liczy się z dzisiejszej ceny zakupu produktu, więc jest szacunkiem; pozycja, której nie da się
    przypisać do produktu z katalogu (np. produkt usunięty ze sklepu), idzie jako „Pozycje bez produktu w katalogu”;
  - waluta: zamówienie z archiwum w innej walucie (np. faktura w CZK albo zamówienie z czeskiego Allegro) liczy się
    tak samo jak bieżące, czyli po przeliczeniu kursem NBP (punkt „Inne waluty” wyżej), z rozbiciem w tabeli „Waluty”;
  - archiwum nie ma danych klientów, nie ma go na liście zamówień, w kolejce pakowania, na pulpicie ani w API zamówień.
  Archiwum wgrywa obsługa techniczna poleceniem `npm run cien -- archiwum --kanal <WOO|ALLEGRO|EMPIK|EASYTOOLS>`
  (Allegro z faktur: `--kanal ALLEGRO --z-faktur-bl <plik>`, po imporcie pozostałych kanałów; z plikiem źródeł dodatkowo
  `--zrodla-bl <csv> --mapa-zrodel "<nazwa konta>=ALLEGRO;<nazwa konta>=WOO;<nazwa konta>=POMIN;…"`: CSV ze średnikiem
  w UTF-8 tylko z kolumnami `order_id;pochodzenie;status;data;waluta` (inna kolumna, np. z danymi klienta, inne kodowanie
  albo nazwa konta spoza mapy zatrzymuje import przed zapisem); w mapie tylko kanały z archiwum albo `POMIN`, co najmniej
  jedno konto Allegro, nazwy bez rozróżniania wielkości liter; wiersz z inną liczbą pól niż nagłówek zatrzymuje import;
  faktury sklepu albo Empiku bez zamówienia w bazie dają błąd przebiegu (na sucho pełny raport, z `--wykonaj` przebieg
  kończy się przed zapisem i przed usunięciem czegokolwiek), chyba że podano `--prog-bez-odpowiednika <zł>` albo
  `--pozwol-bez-odpowiednika`; domyślnie na sucho,
  opis w `lib/archiwum/import.ts` i `lib/archiwum/zrodla-bl.ts`); sam ekran raportu niczego nie importuje.

## Eksport do Excela

- **Raporty → Pobierz Excel (XLSX)**: plik z czterema arkuszami: Podsumowanie (z porównaniem), Okresy, Kanały,
  Produkty (do 1000). Porównanie jest takie jak na ekranie: w Podsumowaniu kolumna z datami i rodzajem porównania
  w nagłówku (np. „Porównanie 2025-11-01 – 2025-11-25 (ten sam okres rok wcześniej)”) i „Zmiana %”; w Okresach daty
  okresu porównania każdego wiersza i jego liczby; w Kanałach i Produktach liczby okresu porównania i zmiana w
  procentach. Przy niepełnym porównaniu zmiana jest pusta, a w Podsumowaniu jest wiersz „Uwaga do porównania”. Przy
  „Bez porównania” kolumn porównania nie ma. Kwoty, ilości i procenty są liczbami, więc od razu je sumujesz i sortujesz. Kwoty mają zawsze
  dwa miejsca po przecinku, sztuki i liczba zamówień są całkowite, kilogramy mają trzy miejsca (dokładność do grama).
  Procenty są zwykłym procentem Excela (komórka „54,2%” ma wartość 0,542), więc formuła typu `=B2*C2` liczy poprawnie.
  „Stan na” to data i godzina w czasie polskim. Polskie znaki są zapisane poprawnie, bez ustawiania kodowania.
- **Zamówienia → Eksport Excel (XLSX)** obok „Eksport CSV”: lista zamówień z bieżącego widoku i filtrów (najwyżej 5 000),
  te same kolumny co CSV. Kwota jest liczbą, data złożenia datą. W pasku zaznaczonych zamówień są oba przyciski.

Raporty i ich pliki nie mają danych osobowych klientów: same liczby, kwoty, nazwy produktów i kanałów. Eksport listy
zamówień też ich nie ma (numer, kanał, data, status, przewoźnik, płatność, kwota, faktura, numer nadania, kraj,
pozycje).

Plik powstaje od razu, bez czekania: raport liczy baza danych, a zakres ma najwyżej 366 dni.

## Czego ten ekran nie robi

- Nie zmienia niczego w sklepach, kanałach, u przewoźników ani w programie do faktur. To sam odczyt.
- Nie pokazuje klientów (kto kupił). Zamówienia konkretnego klienta znajdziesz na liście zamówień (Zamówienia → szukaj).
- Nie liczy kosztu dostawy, prowizji kanałów ani kosztów reklamy: marża to sprzedaż netto minus cena zakupu towaru.
- Nie podsumowuje stanów magazynu: braki i rezerwacje są na ekranach Braki towaru i Produkty.

## Dla agentów AI i programistów

Ten sam raport daje `GET /api/v1/raporty/sprzedaz` (zakres klucza `raporty:odczyt`, opis w `docs/api.md`) i narzędzie
MCP `raport_sprzedazy` (rozdział „Agenci AI”), oba z tymi samymi parametrami porównania (`porownaj`, `porownaj_od`,
`porownaj_do`). W kodzie porównanie dwóch dowolnych zakresów liczy `porownanieSprzedazy` w `lib/api/raporty-sprzedaz.ts`
(zakresy podane wprost, bez parametrów adresu), a okresy porównania `lib/api/raporty-porownanie.ts`.
