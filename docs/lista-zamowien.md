# Lista zamówień: statusy, filtry i praca na wielu zamówieniach

Lista zamówień działa jak w BaseLinkerze: statusy z licznikami są w menu po lewej, pod pozycją „Zamówienia”, tabela
zajmuje całą szerokość ekranu, nad nią alerty, jedno pole szukania, jeden rząd filtrów i pasek akcji, który pojawia się po zaznaczeniu. Jeden klik w status, a potem w przewoźnika pod nim, daje
gotową kolejkę jednego kuriera, np. „Do realizacji → DPD”. Zaznaczone zamówienia zmieniasz naraz: status, przesyłki,
etykiety, karty, lista wysyłkowa, plik CSV albo Excel (XLSX). Układ jest taki sam jak w BaseLinkerze, więc biuro po przeprowadzce pracuje
jak dotąd.

## Gdzie to jest

Menu po lewej → grupa „Realizacja” → **Zamówienia**. Adres: `/zamowienia`. Listę widzi każdy, kto ma podgląd
panelu. Przyciski akcji zależą od
uprawnień osoby (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia): zmiana statusu wymaga uprawnienia „Zmiana statusu na dowolny dozwolony”,
przesyłki, etykiety i karty dostępu do stanowiska pakowania. Szukanie po kliencie (e-mail, telefon, NIP, nazwisko)
działa dla osoby z pełnym podglądem danych klientów.

## Statusy w menu „Zamówienia”

Gdy jesteś na liście albo na karcie zamówienia, pozycja „Zamówienia” w menu po lewej rozwija się na statusy. Z innego
ekranu rozwiniesz je strzałką obok „Zamówienia”. Każdy status ma kolorową kropkę (kolor etapu: niebieski nowe,
bursztynowy w realizacji, zielony gotowe do wysyłki, ciemnozielony wysłane, fioletowy problemowe, szary anulowane)
i licznik. Pod wybranym statusem z kolejką magazynu widać przewoźników z liczbą zamówień.

| Pozycja | Co pokazuje |
|---|---|
| Wszystkie | wszystkie zamówienia firmy; ten widok otwiera się po kliknięciu „Zamówienia” |
| Wymaga działania | zamówienia, przy których ktoś musi coś zrobić: do wyjaśnienia, braki towaru, nieopłacone z rezerwacją, faktura, która się nie wystawiła; licznik w kolorze ostrzeżenia, gdy jest ich więcej niż zero |
| Po terminie | zamówienia, których planowany dzień wysyłki minął, a paczka jeszcze nie pojechała (opis niżej, „Termin wysyłki”); licznik czerwony, gdy jest ich więcej niż zero. Pozycja jest tylko u firmy z ustawionymi odbiorami przewoźników |
| Nowe | czekają na płatność albo przyjęcie |
| Do realizacji | opłacone, do zebrania z półek; pod spodem liczba per przewoźnik |
| Zbierane i zebrane | w trakcie zbierania i zebrane; per przewoźnik |
| Spakowane | spakowane, przed wydaniem kurierowi; per przewoźnik |
| Do wysłania | czekają na kuriera albo na odbiór osobisty; per przewoźnik |
| Wysłane | wysłane i odebrane |
| Problemowe | do wyjaśnienia i reklamacje |
| Anulowane | jak w nazwie |

**Firma z własnymi statusami** (Ustawienia → Sprzedaż i kanały → Statusy zamówień, opis w [Statusach zamówień](statusy.md)) widzi w menu
„Zamówienia” swoje grupy i statusy z kolorami i licznikami, jak w BaseLinkerze: np. grupa „Do realizacji” z „Do
realizacji Paczkomaty”, „Do realizacji DPD”. Pod grupą menu skraca nazwę statusu o nazwę grupy („Paczkomaty”, „DPD”);
pełna nazwa jest w podpowiedzi po najechaniu, w kolumnie „Status” i w tytule nad tabelą. Kropka ma kolor statusu
z ustawień, status bez zamówień jest wyszarzony (nie znika, żeby lista była taka sama jak w ustawieniach). Klik w nazwę
grupy pokazuje wszystkie jej zamówienia, klik w status jedną kolejkę; pod wybranym statusem z kolejki magazynu, który
obejmuje kilku przewoźników, widać przewoźników z liczbą zamówień (jeden przewoźnik z tą samą liczbą co status się nie
powtarza). Grupy są zwinięte do jednej linii z sumą: rozwija się grupa, w której jest wybrany status, a resztę
rozwiniesz strzałką obok grupy. Przeglądarka pamięta grupy rozwinięte strzałką, poza grupami oznaczonymi jako
„zawsze zwinięta” w ustawieniach: te przy każdym wejściu startują zwinięte. „Wszystkie” i „Wymaga działania” zostają na
górze. Zamówienia, do których nie pasuje żaden status firmy,
stoją pod nagłówkiem „Bez statusu firmy” pod nazwą etapu. Na dole listy statusów osoba z dostępem do ustawień ma link
„Ustaw statusy”. Ta sama nazwa i kolor są w kolumnie „Status” i na karcie zamówienia. Tabela wyżej opisuje menu firmy
bez własnych statusów.

Liczniki pokazują stan całej firmy, niezależnie od filtrów listy. Klik w status zachowuje wpisaną wyszukiwarkę
i filtry. Na telefonie statusy są w tym samym menu: przycisk „Menu” w górnym pasku, potem „Zamówienia” (na liście są
już rozwinięte, z innego ekranu strzałka obok). Tytuł nad tabelą mówi, który status oglądasz, np. „Do realizacji: 12”.

Nazwy, kolory i grupy statusów zmieniasz w Ustawienia → Sprzedaż i kanały → Statusy zamówień, nie w menu.

## Termin wysyłki i „Po terminie”

Pod numerem zamówienia stoi termin wysyłki: „wysyłka: dziś” (bursztynem), „wysyłka: jutro”, „wysyłka: czw. 12.11”
albo „po terminie (od 06.11)” (czerwienią). Termin liczy się z odbiorów przewoźnika w Ustawienia → Wysyłka i druk → Przewoźnicy
(dni odbioru i godzina „wyślemy dziś do”): zamówienie złożone przed tą godziną w dniu odbioru jedzie tego dnia, złożone
później, w weekend albo w święto jedzie najbliższym kolejnym odbiorem. Gdy kurier już dziś przyjechał (przycisk
„Przyjechał” na ekranie pakowania), niewysłane dzisiejsze zamówienia są po terminie.

Termin mają tylko zamówienia przed wysyłką (od „Nowe” do „Do wysłania”), opłacone albo za pobraniem. Nieopłacone mają
w kolumnie „Status” termin zwolnienia towaru („zwolni towar …”). Przewoźnik bez ustawionych odbiorów i „bez wysyłki”
nie mają terminu: Kompletor nie zgaduje dat.

Konto w trybie „Tylko podgląd”: paczki pakuje i wysyła dotychczasowy system (BaseLinker albo sklep), a status
w Kompletorze zostaje na „Do realizacji”. Termin takiego zamówienia liczy się więc tylko wtedy, gdy w BaseLinkerze
nadal czeka na wysyłkę (status BL przed „Wysłane”, z ostatniego odczytu BL). Zamówienie, które BL już wysłał, i
zamówienie bez numeru z BaseLinkera nie mają terminu i nie wchodzą do „Po terminie”. Widok „Po terminie” mówi to
jednym zdaniem nad listą; firma bez BaseLinkera widzi zdanie bez niego („wysyłkę robi sklep, więc terminu nie liczymy”).

## Alerty nad listą

Nad listą stoją najwyżej trzy paski z tym, co wymaga uwagi, każdy z przyciskiem do rozwiązania i „Ignoruj”:

| Alert | Przycisk |
|---|---|
| N zamówień czeka na wysyłkę po terminie | „Pokaż” → lista „Po terminie” |
| N przesyłek jest w drodze dłużej niż 5 dni i nie ma odbioru (zamówienie „Wysłane”, przesyłka utworzona ponad 5 dni temu) | „Pokaż” → lista tych zamówień |
| N braków towaru czeka na decyzję | „Braki towaru” |
| N produktów sprzedanych ponad stan magazynu | „Sprawdź stany” → Braki towaru, zakładka stanów |

„Ignoruj” chowa alert tylko Tobie, w tej firmie, do czasu, aż zmieni się liczba: gdy dojdzie kolejne zamówienie po
terminie, alert wróci. Wybór zapisuje się na Twoim koncie (działa na każdym komputerze).

## Szukanie i filtry

- **Jedno pole szukania**: wpisz numer zamówienia (także fragment numeru Allegro), numer przesyłki (od 4 znaków), SKU,
  nazwę albo EAN produktu, a także klienta: pełny e-mail, telefon albo NIP (z „PL”, kreskami albo bez). Rodzaj frazy
  rozpoznaje serwer i szuka naraz w zamówieniach i w klientach; wynik to suma, a nad tabelą widać, ile zamówień
  przyszło z klientów. Szukanie rusza po Enter albo „Szukaj”, „Wyczyść szukanie” wraca do listy bez frazy (filtry
  zostają).
- **Nazwisko albo firma klienta** (od 3 liter): zaznacz przy polu „także w danych klientów (nazwisko, firma)” i wyszukaj.
  Bez zaznaczenia fraza z literami szuka tylko w zamówieniach (numer, produkt, przesyłka), więc wpisanie nazwy
  produktu nie przegląda danych klientów. Zaznaczenie zostaje przy przechodzeniu między stronami i przy sortowaniu
  tego samego wyszukiwania. Gdy fraza z literami nic nie znalazła, lista podpowiada to pole.
- 9 cyfr to najpierw numer zamówienia: gdy pasuje do numeru, lista pokazuje to zamówienie i nie szuka telefonu
  klienta. Telefon w innym zapisie („+48 511 222 333”, „511-222-333”) szuka klienta jak zwykle.
- Dane klientów są zaszyfrowane, więc fraza nie trafia do adresu strony jawnie: zapisuje się w zaszyfrowanym znaczniku
  ważnym 2 godziny tylko dla Ciebie (po tym czasie lista prosi o wpisanie frazy jeszcze raz). E-mail, telefon i NIP
  szukamy po skrótach w całej historii, nazwisko (tylko z zaznaczonym „także w danych klientów”) w danych z ostatnich
  2 000 zamówień; z klientów najwyżej 200 zamówień. Każde wyszukiwanie po klientach zostaje w dzienniku podglądów
  danych klientów (bez wpisanej frazy). Link z wyszukiwaniem działa tylko u osoby, która szukała: u kogoś innego
  (albo po odebraniu dostępu do danych klientów) lista pokazuje komunikat i prosi o wpisanie frazy jeszcze raz.
- Osoba bez dostępu do danych klientów szuka tylko w zamówieniach (numer, produkt, przesyłka); e-maila ani telefonu
  w zapisie telefonicznym („+48 …”, ze spacjami albo kreskami) w tym polu nie przyjmujemy, bo trafiłby do adresu
  strony. Same cyfry (numer zamówienia, EAN, numer przesyłki) działają.
- **Filtry** w jednym rzędzie pod polem szukania, działają od razu po zmianie: data złożenia od–do (czas polski, oba dni
  włącznie), wysyłka (przewoźnik), płatność i kanał. Pod „Więcej filtrów” są status, faktura („Klient chce fakturę”,
  „Chce fakturę, a nie wystawiona”, „Faktura wystawiona”, „Faktura się nie wystawiła”) i kraj dostawy; liczba w nawiasie
  mówi, ile z nich jest ustawionych. Na telefonie filtry są pod przyciskiem „Filtry (n)”, jeden pod drugim.
- Sortowanie: kliknij nagłówek „Numer”, „Kwota” albo „Data” (drugi klik odwraca kolejność). Liczba zamówień na stronie
  25, 50, 100 albo 250 pod tabelą. Sortowanie, strona i filtry są w adresie, więc odświeżenie i link dają ten sam widok.

## Czytnik kodów i wklejony numer

- **Czytnik kodów**: na liście zamówień zeskanuj kartę zamówienia albo etykietę przewoźnika (numer nadania), a otworzy się karta tego zamówienia. Nie trzeba klikać w pole: lista łapie skan sama, gdy kursor nie stoi w polu tekstowym i nie jest otwarte okienko. Skan do pola „Szukaj” też działa: Enter otwiera kartę, gdy kod pasuje do jednego zamówienia. Nieznany kod (także zamówienie innej firmy): komunikat „Nie znam kodu …” w rogu ekranu.
- **Po czym otwarto**: karta otwarta skanem, wklejeniem albo z pola „Szukaj” ma na górze krótką informację, np. „Otwarte po numerze 45210.” albo „Otwarte po numerze przesyłki …”. Sprawdź ją, zanim coś zmienisz na karcie (np. oznaczysz płatność z tytułu przelewu).
- **Etykiety przewoźników**: obsługiwane są trzy rodzaje kodu: (1) kod z samym numerem nadania (np. InPost, DPD, GLS), (2) kod, w którym numer nadania stoi w środku razem z dodatkami (np. kod pocztowy i usługa przed i za numerem), (3) kod QR z adresem śledzenia, w którym jest numer nadania. Ograniczenia: otwiera się tylko przesyłka utworzona w Kompletorze (etykieta zrobiona np. w BaseLinkerze, bez przesyłki w Kompletorze, się nie otworzy), a kod musi zawierać cały numer nadania zapisany przy przesyłce (kod krótszy niż ten numer albo z numerem pociętym na części nie trafi). Pierwszą etykietę każdego przewoźnika warto sprawdzić czytnikiem.
- **Wklejony numer** (Ctrl+V, gdy kursor nie stoi w polu, albo wklejenie w pole „Szukaj”): numer zamówienia z przedrostkiem sklepu albo bez („SD 48213”, „48213”), numer ze sklepu z maila do klienta, numer nadania, kod karty. Otoczka z maila i tytułu przelewu nie przeszkadza („#48213”, „Zamówienie nr 48213.”). Z dłuższego tekstu (cały tytuł przelewu) lista bierze tylko numer z opisem tuż przed nim: przedrostek sklepu („SD 48213”), „zamówienie”, „zam.”, „nr”, „numer” albo „#”, a także kod karty i numer nadania. Sama liczba w środku tekstu („Faktura 45210”) karty nie otwiera. Kartę otwiera tylko wtedy, gdy wklejony tekst wskazuje dokładnie jedno zamówienie. Kilka trafień (np. ten sam numer w dwóch sklepach, wtedy dopisz przedrostek) albo żadne: krótki tekst (do 40 znaków, jedna linia) filtruje listę jak po wpisaniu w „Szukaj”, a dłuższy daje komunikat „Nie znalazłem numeru zamówienia we wklejonym tekście” i nie trafia do wyszukiwarki.
- **Enter w „Szukaj”**: wpisany albo wklejony numer jednego zamówienia otwiera jego kartę. Sama liczba bez przedrostka sklepu otwiera kartę dopiero od 5 cyfr (krótsza, np. „1234”, filtruje listę: to może być końcówka numeru albo SKU). Przy zaznaczonym „także w danych klientów” Enter zawsze filtruje. Chcesz zobaczyć listę zamiast karty: na karcie kliknij „Pokaż wyniki dla »…«” obok informacji, po czym otwarto; na tej liście kolejny Enter w „Szukaj” też filtruje.
- Wklejenie do innych pól (daty, notatki, okienka) niczego nie otwiera.
- Czytnik ma wysyłać Enter po kodzie (ustawienie fabryczne większości czytników). Zwykłe pisanie i skróty klawiszowe skanu nie uruchamiają: lista rozpoznaje czytnik po tempie wpisywania.

## Kolumny i gęstość

- „Kolumny” to ikona z kolumnami po prawej stronie ciemnego paska nad tabelą: włączasz i wyłączasz Produkty, Produkty
  (skrót), Wysyłkę, Stan, Datę i Kraj. Wybór zapisuje się na Twoim koncie i działa na każdym komputerze. Obok jest ikona
  pobierania „Eksport” (niżej). Na telefonie obie ikony stoją w tej samej linijce paska.
- **Produkty**: miniatura (główne zdjęcie produktu z karty produktu → Zdjęcia, bez zdjęcia inicjały nazwy) i pełna
  nazwa z ilością, do dwóch linii (całą nazwę widać po najechaniu). Widać dwie pozycje, „+N pozycji” rozwija resztę
  w miejscu. Pozycja, do której brakuje towaru, ma czerwoną odznakę „brak …”. W gęstości „Gęsto” miniatury są mniejsze.
  Gęstość (Gęsto / Wygodnie) przełączasz w menu konta (Twoje imię w prawym górnym rogu → „Widok”).
- **Produkty (skrót)**: dawny zwarty widok (miniatura i ilość w jednym rzędzie, nazwa po najechaniu), domyślnie
  wyłączony; włącz go w „Kolumny”, a „Produkty” wyłącz, jeśli wolisz krótszą listę.
- Numer zamówienia jest pokazany w całości, tak jak widzi go klient w kanale; „Kopiuj” obok kopiuje sam numer. Pod
  numerem kanał i termin wysyłki.
- Przy kwocie odznaka płatności.
- **Stan**: cztery ikony w stałej kolejności: płatność, przesyłka, dokument sprzedaży, zwrot. Zielona = zrobione
  (opłacone, przesyłka z etykietą albo wysłana, dokument wystawiony, zwrot rozliczony), szara = jeszcze nic albo nie
  dotyczy, czerwona = problem (niedopłata albo wysłane bez wpłaty, przesyłka się nie utworzyła, dokument się nie
  wystawił, klient chciał fakturę, a paczka pojechała bez niej, nieudana korekta zwrotu), bursztynowa = czeka na
  człowieka (klient chce fakturę, zwrot w toku), niebieska = w drodze (pobranie, etykieta, dokument albo korekta w
  przygotowaniu). Najedź na ikonę, żeby zobaczyć opis. Firma bez programu do faktur (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży:
  „bez programu”) ma ikonę dokumentu szarą z opisem „wystawiany poza Kompletorem”.

## Praca na wielu zamówieniach

Ciemny pasek akcji z licznikiem „Zaznaczone: N” pojawia się nad tabelą po zaznaczeniu pierwszego zamówienia. Bez
zaznaczenia w tym miejscu jest jedna linijka z podpowiedzią i ikonami eksportu i kolumn, tej samej wysokości co pasek,
więc tabela nie przesuwa się przy zaznaczaniu. Akcja, do której nie masz uprawnienia, jest na pasku wyszarzona
i po najechaniu mówi, jakiego uprawnienia brakuje. Zaznacz zamówienia (pole przy wierszu albo w nagłówku = cała strona). Gdy zaznaczona jest cała strona,
a pasujących zamówień jest więcej, przycisk „Zaznacz wszystkie pasujące: N” przenosi akcję na wszystkie strony (zmiana
statusu najwyżej 1 000 zamówień, przesyłki i etykiety najwyżej 200), także przy wyszukiwaniu: akcja i eksport liczą
te same zamówienia co ekran.

| Akcja | Co robi |
|---|---|
| Zmień status | nowy status z powodem; każde zamówienie przechodzi tylko wtedy, gdy ten status jest dla niego dozwolony (jak „Zmień status” na karcie), powód zostaje w historii każdego zamówienia |
| Utwórz przesyłki | przesyłka u przewoźnika dla każdego zamówienia; rozmiar A/B/C dobiera gabaryt do przewoźnika (paczkomat, Allegro), przy DPD i kurierze InPost jest jeden gabaryt |
| Drukuj etykiety | etykiety zamówień z utworzoną przesyłką na wybranym stanowisku druku |
| Drukuj listę, lista wysyłkowa | jak w kolejce pakowania, najwyżej 200 zamówień |
| Karty zamówień | dla każdego zaznaczonego zamówienia, najwyżej 100 (szczegóły niżej: „Karty zamówień z listy”) |
| Eksport | jedna ikona pobierania po prawej stronie paska. Wybierasz, co wyeksportować: „Zaznaczone (N)” (najwyżej 250; bez zaznaczenia ta opcja jest wyłączona) albo „Cały widok z filtrami (N)”, czyli to, co widać na liście razem z filtrami i wyszukiwaniem (najwyżej 5 000), i format: „Pobierz CSV” (plik dla Excela, separator „;”) albo „Pobierz Excel (XLSX)” (kwota jest liczbą, data złożenia datą, polskie znaki bez ustawiania kodowania). Kolumny: numer, kanał, data, status, przewoźnik, płatność, kwota, faktura, numer nadania, kraj, pozycje; bez danych osobowych klientów. Raporty sprzedaży wg okresu, kanału i produktu: [Raporty](raporty.md) |

### Karty zamówień z listy

Gdzie: menu **Zamówienia** → zaznacz zamówienia (pole przy numerze) → pasek akcji → **Drukuj karty** (na stanowisku
druku) albo **Pobierz PDF: karty zamówień** / **Drukuj karty zamówień** (PDF w nowej karcie przeglądarki). Widzi to
osoba z uprawnieniem „Stanowisko pakowania” (domyślnie Magazyn i Właściciel). Ta sama zasada działa na karcie
zamówienia: **Wydruki → Drukuj kartę / Pobierz PDF karty**.

Każde zaznaczone zamówienie dostaje swoją stronę, w kolejności zaznaczenia, niezależnie od statusu i stanu towaru:

- **Karta do zbierania** (jak dotąd) dla zamówień, w których jest co zebrać: numer wydruku, kod do skanowania na
  stanowisku pakowania, a dla zamówienia „Do realizacji” wydruk zaczyna zbieranie. Brakująca część zamówienia stoi
  w polu „Uwagi dla magazynu” jako „BRAK, NIE PAKOWAĆ”.
- **Wydruk informacyjny** dla zamówień wysłanych, odebranych, anulowanych, z samymi produktami bez wysyłki (np.
  e-book), z brakiem całego towaru i bez numeru, z którego powstaje kod karty. U góry ma szary pas „Wydruk
  informacyjny: <powód>”, pokazuje wszystkie pozycje zamówienia z oznaczeniem „BRAK NA STANIE” albo „BEZ STANU (bez
  wysyłki)”, nagłówek jak karta (numer, kanał, data, status, sposób wysyłki, odbiorca wg uprawnień). Nie ma kodu
  kreskowego ani numeru wydruku, więc stanowisko pakowania go nie przyjmie, i niczego nie zmienia w zamówieniu
  (status, flagi, historia zostają jak były). Służy jako dokument zamówienia: do teczki, reklamacji, rozmowy z klientem.

Gdy wydruk się nie uda (np. zamówienie zniknęło z listy po połączeniu), nowa karta przeglądarki pokazuje stronę „Nie
udało się wydrukować kart” z opisem, co zrobić, i przyciskami „Wróć do zamówień” i „Zamknij kartę”. To samo dla
„Drukuj listę wysyłkową”.

Kolejka pakowania (**Pakowanie** → zaznacz → karty zamówień) drukuje tylko karty do zbierania: zamówienia wysłane,
anulowane i bez towaru do zebrania pomija i wymienia na ostatniej stronie „Pominięto”. Wydruk informacyjny robisz
z listy zamówień.

Mała akcja wykonuje się od razu, a wynik widzisz w komunikacie; zamówienia, przy których się nie udało, są wypisane pod
paskiem z powodem. Większa idzie w tle: zmiana statusu od 50 zamówień, przesyłki i etykiety już od 10 (każda przesyłka to
zapytanie do przewoźnika, więc nie czekasz na wszystkie w jednym oknie). Nad listą pojawia się pasek postępu, a po końcu
komunikat i lista błędów. Pasek zostaje widoczny przez 15 minut, także po odświeżeniu strony. Jedno nieudane zamówienie
nie zatrzymuje pozostałych, a powtórzenie akcji jest bezpieczne (zamówienie już w danym statusie albo z przesyłką nie
zmienia się drugi raz).

Gdy akcja w tle stoi (np. restart serwera), pasek po 10 minutach bez postępu przestaje się odświeżać i prosi o
sprawdzenie później. Akcja bez ruchu przez godzinę dostaje stan „przerwana” z informacją, dla ilu zamówień są wyniki;
pozostałe zaznacz i uruchom akcję jeszcze raz (zrobione wcześniej nie zmienią się drugi raz). Raporty akcji znikają po
30 dniach.

## Czego lista nie robi

- Nie wysyła wiadomości do klientów z listy (szablony maili: osobny moduł).
- Nie wystawia faktur masowo: fakturę prowadzi karta zamówienia i ustawienia dokumentów sprzedaży.
- Nie łączy ani nie dzieli zamówień: podział jest na karcie zamówienia.
- Filtr „Status” wybiera etap pracy Kompletora; status firmy wybierasz w menu „Zamówienia” po lewej.
- Nazwisko klienta szuka tylko w danych ostatnich 2 000 zamówień (e-mail, telefon i NIP w całej historii).
- Nie śledzi przesyłek sama z siebie: alert „przesyłka bez ruchu” liczy dni od utworzenia przesyłki; postęp u przewoźnika
  widać na karcie zamówienia.
- Nie zmienia odbiorów przewoźników: dni i godziny, z których liczy się termin wysyłki, ustawiasz w Ustawienia →
  Wysyłka i druk → Przewoźnicy.
