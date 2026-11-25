# Pakowanie: kolejka, lista zbierania, koszyki i stanowisko

Magazyn pracuje w trzech krokach: z kolejki wybiera zamówienia, zbiera towar po półkach (każde zamówienie do swojego koszyka), a na stanowisku pakuje je po kolei. To odpowiednik asystenta zbierania i pakowania z BaseLinkera: lokalizacje przy pozycjach, zbieranie po kolei według półek, koszyki A–J z kodami i okno pakowania nad panelem.

## Gdzie to jest

- **Kolejka**: menu **Pakowanie** (adres `/pakowanie`). Zamówienia przed wysyłką pogrupowane po kurierach, od najbliższego odbioru. Widzi każdy z dostępem do panelu; przyciski pakowania widzą osoby z uprawnieniem do stanowiska pakowania (rola Magazyn i Właściciel).
- **Pakuj przy zamówieniu**: przycisk „Pakuj” w wierszu zamówienia otwiera okno pakowania nad kolejką. **Pakuj przy kurierze**: przycisk „Pakuj DPD (5)” w pasku kuriera otwiera wszystkie jego niespakowane zamówienia z tej strony, jedno po drugim. Krzyżyk w oknie wraca do kolejki.
- **Lista zbierania**: zaznacz zamówienia w kolejce i kliknij „Lista zbierania” w pasku nad listą (adres `/pakowanie/zbieranie`). Najwyżej 100 zamówień naraz.
- **Koszyki**: przycisk „Koszyki” w nagłówku Pakowania (adres `/pakowanie/koszyki`). Dodawanie, usuwanie i ustawienie skanu: osoba z uprawnieniem do ustawień firmy. Zwalnianie koszyka: każdy z uprawnieniem do stanowiska.
- **Stanowisko**: przycisk „Otwórz stanowisko” w nagłówku Pakowania (adres `/stanowisko`): osobny ekran bez menu, pod ekran dotykowy i czytnik kodów.

## Kolejka

- Zakładka **Do spakowania**: zamówienia z kont sprzedaży, w których Kompletor zapisuje statusy i stany.
- Zakładka **Pakowanie próbne** pokazuje się w czasie przejścia, gdy firma ma konto „Tylko podgląd”, a także wtedy, gdy w tej zakładce zostały jeszcze stare zamówienia z takiego konta (znika, gdy ich nie będzie). Pakowanie próbne nie zmienia statusu, stanu ani faktury: magazyn ćwiczy na prawdziwych zamówieniach, zanim konto stanie się aktywne.
- Przy każdym produkcie: zdjęcie, półka (np. C-4-2) i ilość. Przy zamówieniu: strefa magazynu i koszyk, jeśli zamówienie już w nim leży.
- „Przyjechał DPD” zamyka odbiór dnia: spakowane paczki znikają z kolejki, a spakowane zamówienia DPD z numerem nadania przechodzą do „Wysłane” (niżej).
- Gęstość widoku (Gęsto / Wygodnie) zmieniasz raz, w menu konta (Twoje imię w prawym górnym rogu). „Wygodnie” daje większe pola wyboru i przyciski (ekran dotykowy w magazynie).

## Czytnik kodów na kolejce i liście zbierania

Na kolejce (`/pakowanie`) i na liście zbierania nie trzeba klikać „Pakuj”: zeskanuj kartę zamówienia, a otworzy się okno pakowania tego zamówienia (to samo co po „Pakuj”). Skan koszyka otwiera zamówienie, które w nim leży. Numer zamówienia i numer nadania z etykiety też otwierają okno pakowania, gdy wskazują jedno zamówienie. Nie trzeba klikać w żadne pole: ekran łapie skan sam, gdy kursor nie stoi w polu tekstowym i nie jest otwarte inne okienko.

- Zamówienie spakowane, wysłane, anulowane, w „Do wyjaśnienia” albo z nieaktualną kartą się nie otwiera: w rogu ekranu pojawia się ten sam komunikat co na stanowisku. Nieznany kod (także karta innej firmy): „Nie znam kodu …”.
- Skan działa u osób z uprawnieniem do stanowiska pakowania (rola Magazyn i Właściciel).
- Gdy okno pakowania jest już otwarte, skan obsługuje samo okno (opis w części „Stanowisko”).
- Czytnik ma wysyłać Enter po kodzie. Tak jest ustawiona większość czytników fabrycznie; jeśli Twój tego nie robi, włącz w jego instrukcji „Enter” (CR) jako znak po kodzie. Ekran odróżnia czytnik od pisania na klawiaturze po tempie: czytnik wpisuje cały kod w ułamku sekundy, a zwykłe pisanie i skróty klawiszowe skanu nie uruchamiają.

## Zamów kuriera

Gdzie: menu **Pakowanie** → pasek kuriera DPD → przycisk **„Zamów kuriera DPD”** (pod paskiem). Pokazuje się tylko,
gdy konto przewoźnika ma włączone „Zamawianie kuriera z Kompletora” (Ustawienia → Wysyłka i druk → Przewoźnicy →
„Konta przewoźników” → konto → „Zaawansowane”), i tylko osobom z uprawnieniem „kurier”. Dziś umie to DPD bezpośrednio
i Wysyłam z Allegro (karta „Wysyłam z Allegro” → „Zaawansowane”, opis niżej); Base Courier zamawia podjazd razem z każdą
przesyłką (ustawienie „Zamawiaj podjazd kuriera”), więc przycisku nie ma.

- Okno: dzień odbioru, godziny od–do, liczba paczek i waga łączna. Podpowiedź z harmonogramu odbiorów i paczek z
  numerem nadania, które czekają na kuriera.
- Po zamówieniu pod paskiem: „DPD zamówiony na 2026-11-23 13:00–15:00, zlecenie nr …”. Drugie kliknięcie tego dnia nic
  nie zamawia; drugi podjazd tylko przez „Zamów drugi raz” z ostrzeżeniem.
- Odmowa przewoźnika pokazuje powód i nic nie zamawia. Gdy przewoźnik nie odpowie, pasek mówi „nie wiadomo, czy
  zamówienie dotarło”: sprawdź w panelu przewoźnika albo telefonicznie, zanim zamówisz drugi raz.
- Godziny wpisujesz w pola „od” i „do”; przedziały od przewoźnika to tylko podpowiedź (kliknięcie wpisuje godziny).
  Okno nie podpowiada dziś, gdy kurier już był („Przyjechał”) albo dziś nie ma odbiorów w harmonogramie.
- Kurier DPD może zamawiać się sam: w koncie przewoźnika „Zaawansowane” → „Zamawiaj kuriera automatycznie”. Wtedy
  Kompletor zamawia jeden podjazd na dzień odbioru kilka minut po pierwszej paczce, która czeka na kuriera, a pod
  paskiem pisze, co zrobił albo dlaczego nie. Nigdy nie zamawia drugiego podjazdu na ten sam dzień; przy odmowie albo
  niejasnym wyniku daje alert i trzeba zamówić przyciskiem. Automat ma sens, gdy podjazdy zamawia Kompletor albo
  magazyn klika „Przyjechał”: bez takiego śladu paczek sprzed dzisiejszego dnia nie liczy. Szczegóły:
  `docs/integracje/dpd.md`, „Kurier zamawia się sam”.
- Czego okno nie robi: nie odwołuje zamówionego kuriera (panel przewoźnika albo telefon; Allegro nie ma odwołania
  odbioru w API). Automat „Zamawiaj kuriera automatycznie” dotyczy tylko DPD; kuriera Allegro zamawiasz przyciskiem.

### Wysyłam z Allegro (Allegro One Kurier)

Gdzie: menu **Pakowanie** → pasek kuriera Allegro → przycisk **„Zamów kuriera Allegro”**. Włącznik: Ustawienia →
Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → karta „Wysyłam z Allegro” → „Zaawansowane” → „Zamawianie kuriera
z Kompletora” (domyślnie wyłączone).

- Okno ma tylko dzień i godziny. Liczby paczek i wagi nie ma: Allegro zamawia odbiór konkretnych przesyłek, więc okno
  pisze, ile przesyłek z numerem nadania zabierze kurier (także paczki do automatów Allegro One Box, bo jadą tym samym
  przewoźnikiem). Paczki innych przewoźników (InPost, DPD przez Allegro) zostają poza zamówieniem.
- Terminy proponowane przez Allegro są podpowiedzią przy polach godzin (kliknięcie wpisuje godziny), nie blokadą. Gdy termin Allegro obejmuje wpisane
  godziny, Kompletor zamawia termin Allegro i zapisuje przy pasku godziny, które Allegro przyjęło.
- Jedno zamówienie na dzień i konto Allegro. Przesyłki z już zamówionego odbioru nie wchodzą do kolejnego: „Zamów drugi
  raz” obejmuje tylko przesyłki nadane po pierwszym zamówieniu.
- Osobne odbiory: Allegro bywa, że odbiera przesyłki różnych przewoźników (np. One Kurier i Orlen Paczka) osobnymi
  podjazdami. Okno pisze wtedy jednym zdaniem, ile będzie odbiorów i ilu przesyłek dotyczy każdy. Po kliknięciu okno
  się zamyka, a nad przyciskiem zostaje jedno podsumowanie (do kliknięcia „Zamknij”): co zamówione (przewoźnik, termin,
  liczba przesyłek, numer zlecenia) i co się nie udało, z tym, co zrobić. Pod paskiem Allegro jest jedna linia na
  przewoźnika; przesyłki, które przewoźnik dopiął do tego samego zlecenia, są w jednej linii z sumą.
- Gdy Allegro odrzuci połączony odbiór przesyłek jednego przewoźnika („osobne odbiory”), Kompletor w tym samym kliknięciu
  dzieli je drobniej (tak, jak podaje Allegro przy terminach) i zamawia każdą część osobno. Inna odmowa niczego nie dzieli.
- Część odbiorów przyjęta, część odrzucona: przy pasku są dwa przyciski. „Ponów nieudany odbiór (N przesyłek)” zamawia
  tylko przesyłki z odrzuconego odbioru; przyjęte odbiory zostają bez zmian i nie są zamawiane drugi raz. Obok jest
  cichszy „Zamów drugi raz”: obejmuje nieudany odbiór i przesyłki nadane po ostatnim zamówieniu (okno ostrzega, że każdy
  nowy odbiór to osobny podjazd). Przesyłki nadane między odmową a udanym ponowieniem nie przepadają: po ponowieniu
  dalej liczą się na pasku jako czekające i wchodzą do „Zamów drugi raz”.
- „Ponów” działa na dzień nieudanego odbioru. Gdy w oknie wybierzesz inny dzień, okno zmienia się w zwykłe zamówienie
  na ten dzień (obejmie nieudaną przesyłkę i wszystkie inne czekające, każdego przewoźnika osobnym odbiorem).
  Powód odmowy jest w linii pod paskiem, kod przewoźnika w „szczegóły”. Przy odrzuceniu zapisany jest termin, który
  faktycznie poszedł do Allegro (nie godziny wpisane w oknie). „Nie zostało wysłane do przewoźnika” znaczy, że Kompletor
  nie wysłał zamówienia (przewoźnik nic nie dostał), a nie że przewoźnik je odrzucił.
- Przesyłki na kilku kontach Allegro naraz: przycisk jest wyłączony z powodem (Kompletor zamawia odbiór dla jednego konta,
  a okno nie ma wyboru konta); zamów wtedy odbiór w Allegro.

## Przyjechał kurier = „Wysłane”

Gdzie: menu **Pakowanie** → pasek kuriera (np. „DPD · odbiór dziś 13:00”) → przycisk **„Przyjechał DPD”**. Widzi go osoba z uprawnieniem „kurier” (domyślnie role Właściciel, Biuro i Magazyn). Przełącznik: Ustawienia → Wysyłka i druk → Przewoźnicy → karta „Automatyczne statusy wysyłki” → „Po przyjeździe kuriera oznaczaj jako wysłane” (domyślnie włączony).

- Po kliknięciu Kompletor w tle przenosi do „Wysłane” wszystkie zamówienia tego przewoźnika spakowane przed przyjazdem, które mają przesyłkę z numerem nadania. Skutki są takie jak przy ręcznym „Wysłane” na karcie zamówienia: klient dostaje mail (z fakturą, gdy jest), a sklep z włączonym zapisem dostaje status i numer przesyłki.
- Przy pasku kuriera pojawia się raport: „Do „Wysłane”: 5 · pominięte: 2”. Kliknięcie w pominięte rozwija listę: numer zamówienia i powód. Gdy operacja nie skończy się (np. awaria serwera), raport mówi „Nie udało się przenieść spakowanych do „Wysłane”: oznacz je na karcie zamówienia”.
- Zostają (z powodem w raporcie): zamówienie bez numeru nadania (przesyłka nie powstała w Kompletorze; „Wysłane” klikasz na karcie), przesyłka do rozstrzygnięcia ręcznie, przesyłka, która właśnie powstaje u przewoźnika (przejdzie przy następnym odbiorze), przewoźnik bez numeru i zamówienie bez faktury, gdy firma wymaga faktury przed wysyłką.
- Zamówienia ze sklepów w trybie podglądu (statusy prowadzi tam BaseLinker) nie trafiają na listę pominiętych: raport pokazuje tylko ich liczbę jedną linią, np. „3 zamówienia ze sklepów w trybie podglądu pominięto”.
- Drugie kliknięcie tego dnia nic nie zmienia. Paczki spakowane po przyjeździe kuriera czekają na następny odbiór.
- Firma bez sklepów internetowych (zamówienia ręczne, przez API) działa tak samo, tylko bez zapisu do sklepu.

**Siatka bezpieczeństwa:** gdy nikt nie kliknie „Przyjechał”, Kompletor co 15 minut pyta przewoźnika o paczki spakowane ponad 30 minut temu. Paczka odebrana przez kuriera przechodzi do „Wysłane” sama. Umieją to InPost (paczkomaty i kurier InPost), Base Courier, DPD i Wysyłam z Allegro (historia statusów Allegro: „w drodze”, „wydana do doręczenia”, „czeka w punkcie” albo „awizo” = paczka u przewoźnika; samo „przygotowana, czeka na nadanie” nic nie zmienia). Paczki DPD (także nadane przez Base Courier) Kompletor sprawdza prosto w DPD, gdy firma ma konto DPD z loginem, hasłem i FID w środowisku produkcyjnym (Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → DPD Polska): Base Courier podaje stan paczek DPD z opóźnieniem nawet kilku godzin. Bez konta DPD albo gdy DPD nie odpowie, pyta jak dotąd Base Courier ([DPD](integracje/dpd.md), „Śledzenie paczek”). Przełącznik: „Sprawdzaj u przewoźnika, czy paczka pojechała” w tej samej karcie. Pod przełącznikiem lista „Których przewoźników pytać o paczki”: InPost, Poczta Polska, Base Courier i Wysyłam z Allegro są włączone od początku, przewoźnik dodany później (także moduł DPD z osobnym śledzeniem DPDInfoServices) jest wyłączony, dopóki go nie zaznaczysz; paczki DPD przy koncie DPD firmy Kompletor pyta niezależnie od listy.

**Śledzenie aż do doręczenia (domyślnie wyłączone):** przełącznik „Śledź paczki aż do doręczenia” w tej samej karcie (działa razem z „Sprawdzaj u przewoźnika, czy paczka pojechała” i listą przewoźników). Po „Wysłane” Kompletor dalej pyta przewoźnika o paczkę, aż dojdzie do stanu końcowego (doręczona, zwrot do nadawcy, anulowana), najdłużej 30 dni od utworzenia przesyłki. Pyta rzadziej niż przed odbiorem: wydana do doręczenia co godzinę, w drodze i po nieudanym doręczeniu co 3 godziny, w punkcie odbioru i przy problemie co 6 godzin, nieznany stan co 2 godziny. Każdy przewoźnik ma swoje kody, Kompletor sprowadza je do jednej osi: utworzona, przekazana przewoźnikowi, w drodze, wydana do doręczenia, czeka w punkcie, doręczona, nieudane doręczenie (awizo), zwrot do nadawcy, problem z przesyłką (zaginięcie, reklamacja), anulowana, nieznany. Każda zmiana trafia do historii przesyłki (kiedy u przewoźnika, kod przewoźnika, stan na osi; opis stanu po polsku Kompletor dopisuje przy wyświetlaniu). Kilka zasad chroni oś przed fałszywym stanem: nieznany kod przewoźnika nie zmienia znanego stanu (zmienia się tylko kod w historii); zwrot do nadawcy zostaje zwrotem, także gdy przewoźnik pokaże potem doręczenie (to doręczenie do nas); InPost „minął czas odbioru” i „odmowa odbiorcy” to już zwrot; po odbiorze przez kuriera paczka nie wraca do „utworzona” ani „anulowana”; doręczenie albo zwrot ze zdarzeń sprzed utworzenia przesyłki (numer listu użyty drugi raz) Kompletor pomija i zapisuje ostrzeżenie w dzienniku zadania. Data przekazania przewoźnikowi to pierwsze zdarzenie po odbiorze u przewoźnika (DPD, Wysyłam z Allegro, Poczta Polska), a u InPostu chwila pierwszego odczytu po odbiorze. Po „Wysłane” nieznany stan nie kończy śledzenia po 5 dniach (granicą jest 30 dni). Paczka, której odczyt się nie udaje (błąd tej paczki, nie konta), jest pytana coraz rzadziej: po pół godzinie, godzinie, dwóch, czterech, ośmiu, potem co 12 godzin, a po 20 nieudanych odczytach z rzędu śledzenie tej paczki się kończy; udany odczyt zeruje licznik. Pierwszy przebieg po włączeniu bierze tylko przesyłki utworzone w ostatnich 30 dniach, ale wszystkie naraz są zaległe, więc schodzą partiami po 100 na przebieg (co 15 minut, przy kilku tysiącach paczek to kilka godzin); paczki przed „Wysłane” mają w każdym przebiegu pierwszeństwo (do 50), więc przeniesienie do „Wysłane” nie czeka na zaległości. Sam ten przełącznik statusu zamówienia po „Wysłane” nie zmienia („Odebrane” i powiadomienia o zwrocie mają własne przełączniki, niżej), a automatyczne akcje „Zmieniono status przesyłki u kuriera” widzą paczkę jak dotąd, tylko do „Wysłane”. Poczta Polska: znane są tylko nadanie, doręczenie i awizo, reszta kodów to nieznany stan.

**Historia drogi paczki na karcie zamówienia:** przy włączonym „Śledź paczki aż do doręczenia” każda zmiana stanu paczki po „Wysłane” daje wpis w „Historii zmian” karty, np. „Przesyłka: Wydana do doręczenia (kod przewoźnika: out_for_delivery)”, autor „system”. Jeden wpis na zmianę stanu, sama zmiana kodu w tym samym stanie wpisu nie daje. Wpis nie uruchamia automatycznych akcji firmy (nie jest to zdarzenie „Zmieniono status przesyłki u kuriera”, które dalej działa tylko do „Wysłane”); podpięcie automatów pod stany przesyłki po „Wysłane” to osobna zmiana. Wpis powstaje też dla sklepów w trybie podglądu.

**Statusy zamówień z drogi paczki (domyślnie wyłączone):** dwa przełączniki w tej samej karcie „Automatyczne statusy wysyłki”. Działają tylko z włączonym „Śledź paczki aż do doręczenia”, tylko dla sklepów w trybie pracy (w trybie podglądu nic nie zmieniają, jak „Wysłane” ze śledzenia) i tylko dla przewoźników zaznaczonych na liście „Dla których przewoźników doręczenie i zwrot zmieniają status albo dają powiadomienie”.
- „Doręczona paczka = Odebrane”: gdy każda paczka zamówienia jest doręczona, zamówienie w statusie „Wysłane” przechodzi w „Odebrane” tak samo jak po ręcznym kliknięciu „Odebrane” na karcie: sklep dostaje status „Odebrane” (ta sama droga zapisu co przy ręcznym kliknięciu), automatyczne akcje firmy reagujące na status „Odebrane” działają jak zwykle. Mail „Faktura” nie wychodzi drugi raz: plan maili Kompletora wysyła go raz na fakturę, a krok „wyślij e-mail Faktura” w regule firmy (np. „Wysłane, Odebrane → e-mail Faktura”) pomija fakturę, która ma już mail w planie albo wysłany, także po ręcznym „Odebrane”. Zamówienie w innym statusie (reklamacja, anulowane, cofnięte do pakowania) zostaje bez zmian.
- „Powiadamiaj o zwrocie i problemie z paczką”: paczka wraca do nadawcy albo przewoźnik zgłasza problem (zaginięcie, reklamacja u przewoźnika, w Wysyłam z Allegro także odmowa odbioru) = powiadomienie dla biura (Powiadomienia; zwrot w grupie „Magazyn”, problem w grupie „Inne”), jedno na paczkę. Status zamówienia się nie zmienia, Kompletor nie zakłada zwrotu, nie robi korekty faktury ani ruchu w magazynie: decyzję podejmuje człowiek. Powiadomienie o zwrocie zamyka się, gdy przyjmiesz paczkę zwrotu tego zamówienia w „Zwroty i reklamacje”; powiadomienie o problemie zamyka się, gdy przewoźnik poda doręczenie. InPost „minął czas odbioru” i „odbiorca odmówił”: powiadomienie mówi, że paczka może jeszcze zostać odebrana przez klienta, zanim wyruszy w drogę powrotną.
- Lista przewoźników: domyślnie zaznaczone tylko InPost, Poczta Polska i Wysyłam z Allegro. DPD i każdy moduł przewoźnika dodany później są domyślnie odznaczone. Kody DPD oznaczające doręczenie, zwrot i czekanie w punkcie odbioru (także w salonie Empik) nie są jeszcze potwierdzone u DPD, więc DPD nie zmienia statusu zamówienia ani nie daje powiadomień, dopóki firma sama go nie zaznaczy; drogę paczki DPD widać w historii zamówienia także bez zaznaczenia.
- Zaległe: reguły działają dla zmian stanu zapisanych w historii przesyłki, gdy śledzenie aż do doręczenia jest włączone. Pierwsze włączenie śledzenia aż do doręczenia sięga po paczki z ostatnich 30 dni (partiami przy kolejnych przebiegach), więc jeśli „Doręczona paczka = Odebrane” i powiadomienia są już włączone, zamówienia „Wysłane” z paczką doręczoną w tych 30 dniach przejdą w „Odebrane” (z zapisem statusu do sklepu i automatami firmy na „Odebrane”), a zwroty z tego okresu dadzą powiadomienia. Gdy reguła się nie wykona (awaria w trakcie), następny przebieg śledzenia ją ponawia, raz na wpis historii przesyłki; po 8 nieudanych próbach z rzędu (ok. 2 godziny) reguły tej paczki czekają na jej następną zmianę stanu, a w wyniku przebiegu zostaje jedna linia „pominięte”. Zamówienie przeniesione do „Wysłane” po tym, jak paczka była już doręczona (np. ręcznie, gdy wcześniej „Wysłane” nie przeszło), dostaje reguły przy najbliższym przebiegu.
- Zalecana kolejność włączania: najpierw samo „Śledź paczki aż do doręczenia”; gdy zaległe paczki z 30 dni zostaną odczytane (po ok. 100 paczek na 15 minut; historia zamówień dostaje wpisy „Przesyłka: …”), włącz „Doręczona paczka = Odebrane” i „Powiadamiaj o zwrocie i problemie z paczką”. Wtedy reguły zadziałają tylko dla nowych zmian stanu, bez przenoszenia starych zamówień do „Odebrane” i bez powiadomień o dawno załatwionych zwrotach.
- Powiadomienie o zwrocie nie powstaje, gdy zwrot tego zamówienia jest już przyjęty w magazynie.

## Lista zbierania

Jedna trasa po magazynie dla wielu zamówień: każdy produkt raz, z sumą sztuk, ułożony według półek (C-4-2 przed C-4-10, produkty bez półki na końcu). Przy produkcie zdjęcie, a obok rozpisanie: „Koszyk A × 2, Koszyk B × 1” (zamówienia bez koszyka pokazują numer). Ilości są te same co na stanowisku: bez braków, zestaw rozbity na składniki, bez e-booków.

- „Przypisz wolne koszyki” daje każdemu zamówieniu z listy bez koszyka kolejny wolny koszyk (A, B, C…), w kolejności listy. Gdy koszyków zabraknie, reszta zostaje bez koszyka.
- „Drukuj listę” drukuje z przeglądarki (bez menu i przycisków).
- „Pakuj te zamówienia” otwiera okno pakowania dla całej listy.

Półkę produktu ustawiasz na karcie produktu (Produkty → produkt → pole „Lokalizacja na półce”). Przy przejściu z BaseLinkera półki przychodzą z jego magazynu.

## Koszyki

Jedno zamówienie = jeden koszyk. Firma sama nazywa koszyki: „Dodaj koszyki” z liczbą (kolejne litery A, B, C…) albo własne nazwy (litery i cyfry, do 8 znaków, np. W1 W2). Kod koszyka do skanera to `KOSZ-` i nazwa (np. `KOSZ-B`). „Drukuj kody koszyków” daje PDF A4 z naklejkami: duża litera, kod kreskowy i kod do wpisania ręcznie.

- **Do koszyka**: przy otwartym zamówieniu na stanowisku zeskanuj pusty koszyk. Zamówienie z innego koszyka przechodzi do nowego. Koszyk zajęty przez inne zamówienie nie przyjmuje otwartego, tylko przełącza okno na zamówienie z tego koszyka (otwarte zostaje w swoim koszyku, niespakowane).
- **Z koszyka**: skan koszyka w polu skanu stanowiska otwiera jego zamówienie, jak skan karty.
- **Zwolnienie**: koszyk zwalnia się sam, gdy zamówienie kończy pobyt w koszyku: „Spakowano” na stanowisku, „Spakuj” na karcie zamówienia, wysłane albo odebrane, anulowane (przez biuro albo w sklepie), reklamacja. „Nie spakowano” i „Do wyjaśnienia” zostawiają zamówienie w koszyku. Ręcznie: Koszyki → „Zwolnij”.
- **Dwa stanowiska naraz**: gdy to samo zamówienie trafi w tej samej chwili do dwóch koszyków, zostaje w pierwszym, a drugie stanowisko widzi komunikat, w którym koszyku jest.
- **Czytnik kodów** nie potrzebuje żadnej konfiguracji (przedrostka ani przyrostka): Kompletor sam rozpoznaje, czy zeskanowano kartę zamówienia (`SH48083/1`), koszyk (`KOSZ-A`) czy kod produktu (EAN).
- **Nazwy koszyków**: litery i cyfry bez spacji, do 8 znaków (np. `A`, `W12`).
- **Wymagaj skanu koszyka przed „Spakowano”** (Koszyki → „Na stanowisku”): przycisk „Spakowano” czeka, aż pakujący zeskanuje koszyk zamówienia. Bez koszyków to ustawienie nic nie zmienia.

## Stanowisko

Pole skanu przyjmuje kod z karty zamówienia (np. `SH48083/1`, przykład w polu ma przedrostek Twojego sklepu) albo kod koszyka. „Otwórz” jest zawsze aktywne: puste pole podpowiada, co wpisać. Bez czytnika lista **Następne do spakowania** pod polem pokazuje pierwsze zamówienia z kolejki; dotknięcie otwiera zamówienie.

Skan karty innego zamówienia (albo jego koszyka) przy otwartym oknie przełącza okno na to zamówienie, także w oknie pakowania nad kolejką; poprzednie zostaje niespakowane na liście z lewej, jego odhaczenia się zerują (jak po zamknięciu okna ✕), a zapisane braki „Na półce nie było” zostają. Po zapisaniu przełączonego okno wraca do odłożonego, potem dalej po kolei; skan tej samej karty nic nie zmienia.

W oknie zamówienia przy każdej pozycji: zdjęcie, półka, nazwa i SKU, przyciski −, +, ✓ i „Nie ma w koszyku”. W nagłówku numer zamówienia, koszyk (jeśli jest) i plakietka „PRÓBNE” przy pakowaniu próbnym.

„Na półce nie było” na koncie w trybie PRACA zapisuje brak w zamówieniu od razu. Przycisk „Jednak jest” przy tej pozycji cofa go, dopóki okno jest otwarte: towar wraca do paczki i trzeba go zebrać. „Cofnij” i „Wyczyść” braku nie cofają. Brak z wcześniejszego okna cofa biuro na karcie zamówienia (Pozycje → „Jednak jest na półce”).

**Towar w ręku, a ramka mówi „Brakuje, nie pakuj”** (konto w trybie PRACA): tak bywa, gdy towar leży na półce, ale nie jest jeszcze przyjęty na stan (np. bieżąca produkcja) albo przyjęto go, gdy zamówienie było już w zbieraniu. Przy pozycji w ramce kliknij „Jednak jest w paczce”. Gdy stan w systemie na to pozwala, towar wraca do listy do zebrania (pełna ilość), zbierasz go i klikasz „Spakowano” jak zwykle. Gdy system odpowie, że towaru nie ma na stanie, najpierw przyjmij go w programie magazynowym, potem w panelu Produkty → „Synchronizuj stany”, i kliknij jeszcze raz. Nie pakuj całości bez tego kliknięcia: paczka zapisze się z brakiem, a biuro będzie musiało to prostować („Wyszedł komplet” na karcie zamówienia).

## Czego ten ekran nie robi

- Nie przypisuje półek: półka jest polem produktu (Produkty → karta produktu).
- Nie pilnuje kartonów ani zdjęcia paczki po spakowaniu (w BaseLinkerze są w ustawieniach asystenta pakowania).
- Produkty nie mają kodów kreskowych do skanowania pozycji: pozycje potwierdzasz dotykiem.
- Nie ustawia „Wysłane” zamówieniom kont w trybie podglądu (status prowadzi tam BaseLinker albo sklep).
- Nie zmienia statusu zamówienia po zwrocie ani po nieudanym doręczeniu (tylko powiadomienie przy włączonym przełączniku); nie powiadamia o paczce, która długo czeka w punkcie albo po awizo (stan widać w historii zamówienia).
- Zakładka „Czekają na etykietę” nie ma jeszcze listy; etykietę tworzy „Utwórz przesyłkę” po spakowaniu (zobacz [Przesyłki](przesylki.md)).
