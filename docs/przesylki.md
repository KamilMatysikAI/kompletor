# Przesyłki: utworzenie, numer nadania i etykieta

Kompletor tworzy przesyłkę u przewoźnika jednym kliknięciem, zapisuje numer nadania, pobiera etykietę od przewoźnika i drukuje ją na stanowisku. To odpowiednik przycisków gabarytów z BaseLinkera („InPost Gabaryt A”, „Kurier DPD”) i automatu „utworzono przesyłkę: drukuj etykietę”.

## Gdzie to jest

- **Karta zamówienia** (Zamówienia → numer zamówienia), sekcja „Przesyłka”: przyciski „Utwórz przesyłkę: InPost A”, „…B”, „…C”, „Utwórz przesyłkę: Allegro A”, „…B”, „…C” (Wysyłam z Allegro) albo „Utwórz przesyłkę: Kurier DPD”, zależnie od przewoźnika zamówienia. Widzą je osoby z uprawnieniem do stanowiska pakowania.
- **Stanowisko pakowania** (Stanowisko), po kliknięciu „Spakowane” i wyborze gabarytu: przycisk „Utwórz przesyłkę” z tym gabarytem. Etykieta drukuje się od razu na stanowisku druku wybranym w tej przeglądarce. Kliknięcie dowolnego przycisku przesyłki zatrzymuje odliczanie powrotu do skanu, więc okno nie zamknie się w trakcie tworzenia przesyłki.
- **Zamówienia ręczne** (Zamówienia → „Dodaj zamówienie” albo API `POST /api/v1/zamowienia` z `kanal: RECZNE`): przesyłkę nadaje się tak samo, z karty zamówienia albo ze stanowiska. Przewoźnik to ten wybrany w formularzu; moduł wysyłki bierze się z reguły tego przewoźnika (Ustawienia → Wysyłka i druk → Przewoźnicy), także gdy wpisany sposób dostawy (np. „Wysyłka do klienta”) nie pasuje do żadnej reguły. Firma bez sklepów i bez BaseLinkera nadaje w ten sposób paczki od pierwszego dnia.
- **Droga paczki** (karta zamówienia, sekcja „Przesyłka”, blok „Przesyłki” pod przyciskami nadania): każda przesyłka utworzona u przewoźnika z numerem nadania, linkiem „Śledź na stronie …”, stanem paczki, datą, od kiedy paczka jest w tym stanie, i zwijaną „Historią paczki”. Widzi go każdy z dostępem do karty. Opis niżej, „Droga paczki na karcie”.
- **Lista przesyłek** (menu → „Przesyłki”, adres `/przesylki`): wszystkie przesyłki ze wszystkich przewoźników i kont na jednej liście, z filtrami, drukiem wielu etykiet, protokołem odbioru i anulowaniem. Listę widzi każdy z dostępem do panelu, akcje osoby z uprawnieniem do stanowiska pakowania. Opis niżej, „Lista przesyłek”.
- **Poprawka adresu**: karta zamówienia, sekcja „Przesyłka”, „Popraw adres albo punkt odbioru przed nadaniem”. Widzą ją osoby z dostępem do pełnych danych klientów. Na koncie w trybie „Tylko podgląd” przycisk jest nieaktywny z powodem (zmiany robisz tam, gdzie prowadzisz zamówienia dziś). Dane kupującego (imię i nazwisko, firma, telefon, e-mail) i dane do faktury zmienia się w kartach „Wysyłka” i „Dane do faktury” (opis w Pomocy „Karta zamówienia”). Pod polami jest wyszukiwarka paczkomatów InPost (opis niżej, „Wyszukiwarka punktów odbioru”).
- **Zmiana sposobu wysyłki** (np. Paczkomat → kurier DPD): karta zamówienia, sekcja „Przesyłka”, „Zmień sposób wysyłki przed nadaniem”. Widzą ją osoby z dostępem do pełnych danych klientów i do stanowiska pakowania (opis niżej, „Zmiana sposobu wysyłki”).
- **Anuluj przesyłkę** (Wysyłam z Allegro i Base Courier): karta zamówienia i stanowisko, sekcja „Przesyłka”, przy utworzonej przesyłce; system pyta przed anulowaniem. Widzą osoby z uprawnieniem do stanowiska pakowania. InPost i DPD bezpośrednio nie mają tego przycisku: anulowanie w ich panelu.
- **Rozstrzygnij ręcznie**: karta zamówienia, sekcja „Przesyłka”, przy przesyłce w stanie „Do sprawdzenia u przewoźnika”, pod przyciskiem „Sprawdź u przewoźnika”. Widzą ją osoby z uprawnieniem „Przesyłka niejasna u przewoźnika: ręczne rozstrzygnięcie” (domyślnie właściciel; innym nadaje się je w Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).

## Kiedy przycisk jest aktywny

Przycisk widać zawsze, gdy zamówienie ma przesyłkę. Jest nieaktywny, a pod nim stoi powód, gdy:

1. konto sklepu jest w trybie „Tylko podgląd” (przesyłki nadaje wtedy BaseLinker, a druga przesyłka z Kompletora byłaby podwójną, płatną etykietą). Firma przechodząca z BaseLinkera potrzebuje też włączonej pracy na serwerze Kompletora (robi to administrator); do tego czasu powód mówi o serwerze, także przy zamówieniach ręcznych;
2. moduł przewoźnika w Ustawienia → Wysyłka i druk → Przewoźnicy tylko liczy przesyłkę (wersja „podgląd”), a nie ją tworzy;
3. nadawanie u przewoźnika jest wyłączone w ustawieniach przewoźnika (`zapisWlaczony`). Włącza je właściciel firmy po teście na koncie testowym przewoźnika;
4. zamówienie czeka na płatność, jest anulowane, wysłane albo do wyjaśnienia;
5. firma nie ma reguły dla przewoźnika i modułu wysyłki zamówienia (np. reguła DPD przestawiona na inny moduł po przyjęciu zamówienia): powód każe sprawdzić Ustawienia → Wysyłka i druk → Przewoźnicy.

## Co się dzieje po kliknięciu

1. System liczy przesyłkę od nowa (gabaryt, wymiary, waga, pobranie, punkt odbioru z danych klienta).
2. Błąd (np. brak kodu paczkomatu, waga ponad limit) zatrzymuje nadanie z opisem. Wartości robocze (domyślne wymiary, waga bez danych z produktów) trzeba świadomie potwierdzić polami wyboru. Waga paczki to suma wag sztuk z kart produktów (Produkty → karta → „Waga”), bez kartonu i wypełnienia; zestaw liczy się wagami składników, a waga z karty zestawu jest pomijana. Szczegóły w dokumencie „Produkty”, sekcja „Waga i wymiary a przesyłka”.
3. Przesyłka powstaje u przewoźnika. Zapisuje się numer nadania i etykieta.
4. Gdy zamówienie jest spakowane i ma fakturę, status zmienia się na „Do wysłania”. Bez faktury status zostaje i ekran to mówi.
5. Numer nadania trafia do historii zamówienia. Po wdrożeniu zapisu na kanały trafia też do sklepu (status i numer w kanale); do tego czasu numer w sklepie wpisuje się jak dziś.

## Podwójne kliknięcie i zgubiona odpowiedź

- Jedno zamówienie (paczka) ma najwyżej jedną aktywną przesyłkę. Drugie kliknięcie, także w tej samej sekundzie, pokazuje istniejącą przesyłkę i nic nie wysyła drugi raz.
- Gdy przewoźnik nie odpowie (przerwane połączenie, błąd serwera), system pyta go o przesyłkę po referencji. Jeśli nie da się tego rozstrzygnąć, przesyłka ma stan „Do sprawdzenia u przewoźnika”, powstaje alert, a na karcie jest przycisk „Sprawdź u przewoźnika”. Systemu nie da się wtedy namówić na drugą przesyłkę, bo mogłaby to być druga płatna etykieta i drugie pobranie.
- Gdy przewoźnik odmówi (np. zły kod pocztowy), przesyłka ma stan „Nie utworzono” z powodem i można spróbować ponownie po poprawce.

## Rozstrzygnij ręcznie

Gdy „Sprawdź u przewoźnika” nie daje odpowiedzi (DPD nie pozwala pewnie odszukać przesyłki po referencji, więc u DPD to zwykła droga), przesyłkę rozstrzyga człowiek po sprawdzeniu w panelu przewoźnika. Szukaj po referencji z alertu albo po odbiorcy i dacie.

- **Przesyłka istnieje u przewoźnika**: wpisz numer listu przewozowego (DPD), id przesyłki (InPost, same cyfry) albo numer przesyłki z panelu Allegro (Wysyłam z Allegro). Base Courier: numer zamówienia albo numer listu z panelu Base Courier ([Base Courier](integracje/basecourier.md)). Zanim cokolwiek się zapisze, Kompletor sprawdza wpisany numer u przewoźnika:
  - InPost musi znać przesyłkę o tym id, z referencją tej przesyłki i z numerem nadania (bez numeru: „spróbuj za kilka minut”). Przesyłka bez referencji Kompletora (założona np. w Managerze Paczek) daje odmowę: Kompletor zawsze wysyła referencję, więc to nie jest ta paczka.
  - DPD musi wydać etykietę tego numeru listu, a odpowiedź nie może mieć błędu na żadnym poziomie (sesja, paczka, list). Potem Kompletor pyta DPD o paczkę po referencji tej przesyłki: inny numer listu pod tą referencją daje odmowę (numery DPD idą kolejno, więc pomyłka w ostatniej cyfrze trafia w sąsiednią paczkę tej samej firmy). Gdy DPD nie odpowie na to pytanie jednoznacznie, numer zostaje przyjęty z dopiskiem „nie dało się porównać numeru z referencją”.
  - Wysyłam z Allegro: przesyłka utworzona przez Kompletor dla tej referencji musi być dokładnie tą wpisaną. Inna przesyłka (np. numer z sąsiedniego wiersza panelu) albo brak przesyłki Kompletora dla tej referencji daje odmowę; przesyłka jeszcze w tworzeniu: „spróbuj za chwilę”.
  - Base Courier musi mieć przesyłkę z referencją tego zamówienia w „Zawartości przesyłki”.
  - U każdego przewoźnika: numer, który w Kompletorze ma już inna przesyłka tej firmy i tego przewoźnika (np. główna przesyłka z tej samej karty, przesyłka innego zamówienia, także anulowana), daje odmowę „Ten numer ma już w Kompletorze inna paczka” z podpowiedzią, której przesyłki i zamówienia dotyczy. Nic się nie zapisuje i Kompletor nie pyta przewoźnika. To ważne zwłaszcza przy DPD, który potwierdza tylko, że etykieta numeru istnieje.

  Literówka albo numer innej paczki dają odmowę i nic się nie zmienia, przesyłka zostaje „Do sprawdzenia u przewoźnika”. Gdy przewoźnik nie odpowiada, komunikat prosi o ponowienie za chwilę. Po potwierdzeniu system zapisuje przesyłkę jako utworzoną, numer nadania, historię zamówienia, ustawia „Do wysłania” (gdy jest faktura) i pobiera etykietę. Do przewoźnika nie idzie nowe zlecenie.
- **Przesyłka nie powstała**: system oznacza ją jako anulowaną. Następne „Utwórz przesyłkę” wysyła nowe zlecenie z nową referencją. Zaznacz to tylko po sprawdzeniu w panelu przewoźnika: jeśli przesyłka jednak istnieje, zamówienie będzie miało dwie płatne paczki. Gdyby przewoźnik później potwierdził tę pierwszą, system podniesie alert.

Każde rozstrzygnięcie zapisuje się w dzienniku zmian (kto, kiedy, który wariant, numer) i zamyka alert przesyłki. Dwie osoby naraz nie rozstrzygną jednej przesyłki dwa razy: druga dostanie komunikat, że stan się zmienił.

Po „nie powstała” (albo po anulowaniu u przewoźnika) karta i stanowisko pokazują nad przyciskiem „Utwórz przesyłkę” jedną linię: „Poprzednią przesyłkę tej paczki oznaczono ręcznie jako niepowstałą (kto, kiedy)”. Linia znika, gdy powstanie nowa przesyłka. Dzięki niej następna zmiana wie, że przed nadaniem warto zajrzeć do panelu przewoźnika.

## Etykieta i ponowny druk

- Etykieta przychodzi od przewoźnika (PDF albo ZPL, ustawienie `formatEtykiety` w regule przewoźnika). Ma adres odbiorcy, więc w bazie leży zaszyfrowana kluczem danych klientów, a plik wysłany do drukarki znika zaraz po wydruku.
- „Drukuj etykietę ponownie” drukuje zapisany plik. Przewoźnik nie dostaje drugiego zlecenia.
- Etykieta „PRÓBA, NIE NADAWAĆ” (bez kodu kreskowego) zostaje tylko do ćwiczeń, dopóki zamówienie nie ma prawdziwej przesyłki.
- InPost nadaje numer i etykietę chwilę po utworzeniu przesyłki. Gdy ich jeszcze nie ma, kliknij „Pobierz etykietę”.

## Poprawka adresu i punktu odbioru

Przed utworzeniem przesyłki osoba z dostępem do pełnych danych klientów poprawia imię, adres, telefon i kod punktu odbioru (paczkomat, punkt DPD, salon Empik). Otwarcie formularza i zapis są w dzienniku podglądów (Ustawienia → Zespół i dostęp → Dane klientów) z nazwami zmienionych pól, bez wartości. Poprawki ze sklepu już jej nie nadpiszą. Dane do faktury, e-mail i kupujący (np. przy prezencie, gdy kupuje ktoś inny niż odbiera) zostają bez zmian: poprawka zmienia odbiorcę paczki. Po utworzeniu przesyłki adres zmienia się w panelu przewoźnika. Gdy poprawka i „Utwórz przesyłkę” zbiegną się w czasie, przesyłka nie powstanie na stary adres: system poprosi o ponowne kliknięcie.

## Zmiana sposobu wysyłki

Przed utworzeniem przesyłki biuro zmienia przewoźnika i usługę na inną z reguł przewoźników firmy, np. z Paczkomatu na kuriera DPD. Przy usłudze z punktem trzeba podać punkt nowego przewoźnika, przy kurierze pełny adres (punkt odbioru znika), a zamówienie za pobraniem przechodzi tylko na usługę z pobraniem. Potem „Utwórz przesyłkę” nadaje nową usługą. Zmiana zostaje w Kompletorze: metoda dostawy w kanale się nie zmienia, kolejny odczyt z kanału jej nie cofa, koszt wysyłki zapłacony przez klienta też nie. Zamówienie z Allegro z dostawą Allegro przejdzie na przewoźnika z umowy firmy (koszt poza Allegro); samą usługę Allegro zmienia się w Allegro. Po utworzeniu przesyłki zmiana wymaga jej anulowania. Zmiana dotyczy jednej paczki: paczki wydzielone wcześniej zostają przy swoim przewoźniku, a anulowana przesyłka sprzed zmiany zostaje w historii ze starym przewoźnikiem. Pełny opis: [Karta zamówienia](karta-zamowienia.md), „Zmień sposób wysyłki”.

## Droga paczki na karcie

Karta zamówienia → sekcja „Przesyłka” → blok „Przesyłki” (pod przyciskami nadania i etykiety). Blok pojawia się, gdy zamówienie ma przesyłkę utworzoną u przewoźnika; przy kilku przesyłkach (np. po anulowaniu i nadaniu nowej) każda ma swój opis „Przesyłka 1 z 2”, od najstarszej, a anulowana ma dopisek „(anulowana)”.

- **Przewoźnik i numer nadania** z linkiem „Śledź na stronie InPost / DPD / GLS”, który otwiera stronę śledzenia przewoźnika w nowej karcie. Link jest tylko przy paczce nadanej modułem samego przewoźnika (InPost, DPD, GLS). Paczka nadana przez Wysyłam z Allegro albo Base Courier nie ma linku, nawet gdy przewoźnik zamówienia to InPost albo DPD: pośrednik sam dobiera przewoźnika, więc numer nie musi pasować do strony InPost ani DPD (link dodamy, gdy potwierdzimy to na prawdziwych paczkach). Dla Poczty Polskiej, Orlen Paczki i przesyłek Allegro linku też nie ma (ich strony nie przyjmują numeru w adresie albo adresu nie potwierdziliśmy). Bez linku numer wpisujesz na stronie przewoźnika.
- **Stan paczki** słowami: „Przekazana przewoźnikowi”, „W drodze”, „Wydana do doręczenia”, „Czeka na odbiór w punkcie”, „Doręczona”, „Nieudane doręczenie (awizo)”, „Zwrot do nadawcy”, „Problem z przesyłką”, „Anulowana u przewoźnika”, „Stan nieznany”. Obok data „W tym stanie od”: kiedy paczka weszła w obecny stan (kilka zdarzeń z tym samym stanem nie przesuwa tej daty). Przy „Stan nieznany” karta mówi, że przewoźnik podał stan, którego Kompletor nie rozpoznaje, i że paczkę sprawdzisz u przewoźnika.
- **Historia paczki** (rozwijana): każda zmiana stanu z datą od najnowszej, w nawiasie kod albo opis zdarzenia u przewoźnika, do porównania z jego panelem. Karta pokazuje 30 ostatnich zdarzeń, pełną historię ma strona przewoźnika.
- Stan i historia pojawiają się, gdy firma włączy „Śledź paczki aż do doręczenia” (Ustawienia → Wysyłka i druk → Przewoźnicy → „Automatyczne statusy wysyłki”) i moduł, który nadał paczkę, jest zaznaczony w „Których przewoźników pytać o paczki” ([Pakowanie](pakowanie.md)). Bez tego blok pokazuje numer, link i stan „Utworzona u przewoźnika” ze zdaniem, że drogę paczki sprawdzisz u przewoźnika. Gdy przełącznik jest włączony, ale Kompletor nie pyta o paczki danego modułu (nie jest zaznaczony albo, jak Base Courier, nie umie podać stanu), karta mówi wprost, że Kompletor nie sprawdza drogi paczek tego przewoźnika i stan się tu nie zmieni. To nie jest błąd.
- Gdy śledzenie paczki wyłączono, a zapisany stan nie jest końcowy (np. „W drodze”), karta dopisuje, że Kompletor nie odświeża już stanu tej paczki.
- Blok tylko czyta zapis w Kompletorze, nie pyta przewoźnika przy otwarciu karty. Stan odświeża sprawdzanie przesyłek w tle.
- **Link śledzenia w sklepie (domyślnie wyłączone):** przełącznik „Wysyłaj do sklepu link do śledzenia paczki” w Ustawienia → Wysyłka i druk → Przewoźnicy → „Automatyczne statusy wysyłki”. Włączony: zapis numeru nadania do sklepu niesie też ten sam link co karta (WooCommerce: w notatce zamówienia „Numer nadania: … (przewoźnik) <link>”, widocznej dla klienta, gdy konto sklepu ma włączone „Notatka z numerem widoczna dla klienta” (Woo wysyła mu wtedy e-mail); Empik: adres przewoźnika przy numerze, o ile przewoźnik nie ma kodu Empik w ustawieniach konta, bo wtedy Empik dostaje sam kod przewoźnika i numer; Allegro linku nie przyjmuje i dostaje sam numer). Dotyczy numerów zapisanych do sklepu po włączeniu i tylko paczek z linkiem (moduł samego przewoźnika); numer już wysłany nie jest wysyłany drugi raz. Wyłączony: sklep dostaje sam numer, jak dotąd. Sklep dostaje cokolwiek tylko przy koncie z włączonym zapisem do sklepu.
- **API i asystent:** to samo (przewoźnik, numer, stan, od kiedy, link) widać w polu `przesylki` odpowiedzi `GET /api/v1/zamowienia` i w narzędziach MCP (opis pól: dokumentacja API, `docs/api.md`).

## Dodatkowa przesyłka (dosyłka, paczka zastępcza, druga paczka)

Karta zamówienia → sekcja „Przesyłka” → blok „Przesyłki” → przycisk „Dodaj przesyłkę” pod opisem przesyłek. Przycisk widzi osoba z uprawnieniem do stanowiska pakowania (to samo co „Utwórz przesyłkę”), gdy zamówienie ma utworzoną główną przesyłkę.

Funkcja jest domyślnie wyłączona. Włącza ją osoba z dostępem do ustawień firmy: Ustawienia → Wysyłka i druk → Przewoźnicy → karta „Automatyczne statusy wysyłki” → przełącznik „Pozwalaj dodać kolejną przesyłkę do zamówienia” → „Zapisz”. Wyłączona = przycisku na karcie nie ma, a próba dodania (np. ze starej, otwartej karty) kończy się odmową bez wywołania przewoźnika. Już dodane przesyłki zostają na karcie i na liście „Przesyłki” także po wyłączeniu. Wyjątek: gdy dodatkowa przesyłka jeszcze powstaje albo nie wiadomo, czy powstała, przycisk „Dodaj przesyłkę” zostaje na karcie także po wyłączeniu, a okno pokazuje tylko „Sprawdź u przewoźnika” i „Rozstrzygnij ręcznie” dla tej przesyłki (nowej nie doda). Po wyjaśnieniu przycisk znika.

1. Kliknij „Dodaj przesyłkę”. Okno ma tytuł „Dodatkowa przesyłka nr 1” (kolejne: nr 2, nr 3).
2. Wybierz rodzaj: „Dosyłka (reklamacja, brakujący towar)”, „Paczka zastępcza (zgubiona albo uszkodzona)” albo „Druga paczka (towar nie zmieścił się w jednej)”.
3. Wybierz moduł przewoźnika (domyślnie ten sam co w zamówieniu; na liście są tylko moduły tego samego przewoźnika z włączonym nadawaniem, np. drugie konto) i gabaryt.
4. Wpisz powód (co najmniej 5 znaków, np. „reklamacja: brak jednego produktu”) i, jeśli znasz, koszt etykiety netto w złotych.
5. Zaznacz „Potwierdzam: ta przesyłka ma powstać” i kliknij „Utwórz przesyłkę”.

Kiedy wolno: zamówienie spakowane, do wysłania, wysłane, odebrane albo w reklamacji, z główną przesyłką utworzoną u przewoźnika, na koncie w trybie „praca”. Przy innym statusie okno mówi, czego brakuje.

Co się dzieje: przesyłka powstaje u przewoźnika i pojawia się w bloku „Przesyłki” pod główną, z tytułem np. „Dosyłka nr 1 (dodatkowa przesyłka)”, powodem i kosztem. Etykietę pobierzesz i wydrukujesz z listy „Przesyłki” (wiersz ma dopisek „· Dosyłka nr 1” przy numerze zamówienia). Historia zamówienia dostaje wpis „Dodatkowa przesyłka utworzona”.

Czego dodatkowa przesyłka NIE robi:

- nie zmienia statusu zamówienia i nie wraca go do pakowania ani do „Do wysłania”; jej odbiór przez kuriera nie daje „Wysłane”;
- nie tworzy faktury, korekty, rozchodu ani rezerwacji i nie zmienia stanu magazynu (towar do dosyłki wydajesz poza Kompletorem albo dokumentem ręcznym);
- nic nie idzie do sklepu ani kanału: numer nadania zamówienia (karta, API, sklep) zostaje numerem głównej przesyłki, także po anulowaniu dosyłki; klient nie dostaje maila, automatyczne akcje nie ruszają;
- nie pobiera pieniędzy (zawsze bez pobrania);
- do punktu DPD Pickup i salonu Empik idzie jako osobna przesyłka jednopaczkowa do tego samego punktu (jak każda pojedyncza paczka), więc ograniczenie „DPD Pickup przyjmuje tylko przesyłkę jednopaczkową” jej nie blokuje; przy salonie Empik zostaje to samo ostrzeżenie do potwierdzenia co przy głównej;
- „Doręczona paczka = Odebrane” liczy się tylko od głównej przesyłki: doręczona dosyłka nie daje „Odebrane”, a niedoręczona nie wstrzymuje go. Zwrot albo problem z dosyłką daje alert jak przy głównej, bez zmiany statusu.

Zabezpieczenie przed dublem: każda dodatkowa przesyłka wymaga powodu i potwierdzenia, a okno pamięta swój numer. Drugie kliknięcie „Utwórz przesyłkę” w tym samym oknie nie tworzy drugiej etykiety, tylko pokazuje tę, która już powstała. Po błędzie przewoźnika okno wraca do tego samego numeru i ponawia tę samą przesyłkę (bez drugiej paczki). Gdy poprzednia dodatkowa przesyłka jeszcze powstaje albo nie wiadomo, czy powstała, okno nie pozwala dodać kolejnej i pokazuje jej referencję oraz „Sprawdź u przewoźnika”, a osobie z uprawnieniem do rozstrzygania przesyłek także „Rozstrzygnij ręcznie” (istnieje z numerem z panelu przewoźnika albo nie powstała). Karta zamówienia pokazuje przyciski tylko przy przesyłce głównej, więc niejasną dodatkową przesyłkę wyjaśnia się w tym oknie; alert na pulpicie odsyła właśnie tutaj. Po każdej odmowie okno czyta stan od nowa, a gdy nie uda się połączyć z Kompletorem, pokazuje komunikat zamiast cichego braku reakcji.

Koszt: Raporty → karta „Dodatkowe przesyłki” (ten sam zakres dni co raport sprzedaży, po dacie utworzenia przesyłki) pokazuje liczbę dosyłek, paczek zastępczych i drugich paczek, sumę wpisanego kosztu netto i ile z nich nie ma wpisanego kosztu. Kosztu głównych przesyłek Kompletor nie zna (przewoźnicy go nie podają).

API: w `przesylki[]` pole `rodzaj` (`GLOWNA`, `DOSYLKA`, `ZASTEPCZA`, `DODATKOWA`); powód i koszt nie wychodzą przez API.

Ograniczenia tego etapu: tylko ten sam przewoźnik co w zamówieniu (inny przewoźnik potrzebuje innego odbiorcy, np. adresu zamiast paczkomatu); bez dosyłanych pozycji (dosyłka nie ma własnej listy towarów ani rozchodu); waga liczona ze składu całego zamówienia; przycisku anulowania dosyłki na karcie jeszcze nie ma (lista „Przesyłki” → „Anuluj przesyłki” dla Wysyłam z Allegro i Base Courier, pozostałe w panelu przewoźnika).

Pobranie i zmiany zamówienia: dodatkowa przesyłka jest zawsze bez pobrania, więc nie liczy się jako etykieta paczki. Lista zamówień pokazuje stan i numer głównej przesyłki; kwota pobrania paczek zamówienia podzielonego, zmiana pozycji i podział zamówienia za pobraniem patrzą tylko na główne przesyłki paczek (sama dosyłka, np. po anulowaniu głównej, ich nie blokuje).

### Powrót do starszej wersji

Wersje Kompletora sprzed dodatkowej przesyłki biorą każdą aktywną przesyłkę zamówienia za główną (numer do sklepu, „Wysłane”, „Odebrane”, karta, etykieta). Przed cofnięciem wersji sprawdź w bazie:

```sql
SELECT count(*) FROM "Shipment" WHERE "extraNo" > 0;
```

Wynik 0: cofnięcie jest bezpieczne. Wynik większy od 0: nie cofaj poniżej wersji z dodatkową przesyłką, tylko napraw błąd do przodu (nowa wersja z poprawką). Do tego czasu możesz wyłączyć przełącznik „Pozwalaj dodać kolejną przesyłkę do zamówienia”, żeby nie przybywało nowych.

## Lista przesyłek

Menu → „Przesyłki” (pod „Pakowanie”). BaseLinker ma osobną stronę dla każdego kuriera, w Kompletorze jest jedna lista.

- **Kolumny:** data utworzenia, przewoźnik i konto przewoźnika (np. „DPD Polska: Salony Empik” przy drugim koncie), zamówienie (kliknięcie otwiera kartę), numer nadania z linkiem „Śledź u przewoźnika” (InPost, DPD, GLS przy paczkach nadanych ich własnym modułem, jak na karcie), stan przesyłki i akcje w wierszu. Stan to „Utworzona”, „Powstaje u przewoźnika”, „Do sprawdzenia u przewoźnika”, „Nie powstała” albo „Anulowana”. Gdy firma śledzi paczki do doręczenia, przy utworzonej przesyłce zamiast „Utworzona” stoi stan drogi paczki z datą, od kiedy paczka jest w tym stanie (np. „W drodze”, „Doręczona”). Przy stanie nieznanym zostaje „Utworzona”, a pod nią ostatni status u przewoźnika; tak samo bez śledzenia do doręczenia, gdy przewoźnik podaje status ([Pakowanie](pakowanie.md)).
- **Szukanie i filtry:** pole „Szukaj po numerze nadania” (cały numer albo fragment), a pod przyciskiem „Filtry”: przewoźnik, konto przewoźnika, stan, droga paczki (stan u przewoźnika albo „Bez odczytu drogi paczki”, czyli utworzone przesyłki bez odczytu), numer zamówienia, data utworzenia od–do. Sortowanie po kliknięciu nagłówka (data, przewoźnik, numer nadania, stan), strony po 25, 50, 100 albo 250 przesyłek.
- **W wierszu:** „Etykieta” otwiera zapisaną etykietę (PDF; etykieta ZPL pobiera się jako plik dla drukarki termicznej), „Drukuj” wysyła ją na stanowisko druku. Przycisk jest szary z powodem, gdy przesyłka nie ma etykiety, nie jest utworzona albo konto przewoźnika ma wyłączone nadawanie.
- **Na zaznaczonych** (pole wyboru przy wierszach; „Zaznacz wszystkie pasujące” przenosi druk i anulowanie na wszystkie strony, najwyżej 500 przesyłek):
  - „Pobierz etykiety”: jeden plik PDF z etykietami w kolejności listy (najwyżej 200). Przesyłki bez etykiety, anulowane, z etykietą ZPL albo na koncie z wyłączonym nadawaniem są na ostatniej stronie pliku „Pominięte przesyłki” z powodem.
  - „Drukuj etykiety”: każda etykieta to osobne zlecenie na wybranym stanowisku druku, w kolejności listy. Od 10 przesyłek druk idzie w tle: nad listą jest pasek postępu, a po końcu raport „wydrukowano N, pominięto M” z powodem przy każdej pominiętej. Ponowienie tej samej akcji (np. po awarii serwera) nie drukuje drugi raz, nowe kliknięcie „Drukuj etykiety” drukuje ponownie.
  - „Pobierz protokół”: protokół odbioru dla kuriera (opis niżej).
  - „Anuluj przesyłki”: po potwierdzeniu Kompletor anuluje każdą przesyłkę u przewoźnika, który to umie (Wysyłam z Allegro, Base Courier). Pozostałe są pominięte z powodem. Od 10 przesyłek w tle, jak druk.
- Druk i anulowanie działają tylko na kontach przewoźników z włączonym nadawaniem (Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników”). Przy wyłączonym koncie przycisk jest widoczny, ale nieaktywny, z powodem.

## Protokół odbioru

„Pobierz protokół” na liście przesyłek daje dokument, który kurier podpisuje przy odbiorze paczek:

- Dla wszystkich przewoźników (DPD, InPost, Base Courier, Wysyłam z Allegro, kilku przewoźników naraz, firma bez integracji przewoźnika) Kompletor drukuje własną „Listę przekazanych paczek” (A4): zamówienie, przewoźnik, liczba paczek, numery nadania, podsumowanie na przewoźnika i pola „Data i godzina odbioru”, „Wydał (magazyn)”, „Podpis kuriera”.
- Do protokołu idą tylko przesyłki utworzone u przewoźnika. Anulowane i nieutworzone są pominięte.
- Pobranie listy niczego nie wysyła do przewoźnika: nie tworzy przesyłek, nie zamawia kuriera i nie zamyka dnia nadania. Można ją pobrać dowolnie wiele razy.
- Protokołu z systemu przewoźnika (DPD, Wysyłam z Allegro) jeszcze nie ma. Wejdzie w kolejnej wersji, z oknem potwierdzenia i zapisem pliku, po sprawdzeniu na kontach testowych przewoźników.

## Wyszukiwarka punktów odbioru

Karta zamówienia → „Przesyłka” → „Popraw adres albo punkt odbioru przed nadaniem” → „Znajdź paczkomat InPost”. Wpisz kod paczkomatu (np. POZ08M), kod pocztowy albo miasto i kliknij „Szukaj” (albo Enter). Lista pokazuje do 20 punktów z adresem, opisem miejsca, informacją „nie działa” i „bez pobrania”. „Wybierz” wpisuje kod do pola „Punkt odbioru”; zmiana zapisuje się dopiero po „Zapisz poprawkę”. Historia zamówienia dostaje wpis „Punkt odbioru zmieniony przed nadaniem” (kto i kiedy, bez kodów punktu: te zostają w zaszyfrowanych danych klienta).

Wyszukiwarka czyta publiczną listę punktów InPost (ta sama, z której korzysta mapa „Znajdź paczkomat”), bez kluczy firmy. Nic nie tworzy i nic nie kosztuje. Gdy InPost nie odpowiada, wpisz kod punktu ręcznie. Punkty DPD Pickup i salony Empik wpisuje się ręcznie (wyszukiwarka tylko InPost).

## Czego to nie robi

- Nie anuluje przesyłek InPost i DPD bezpośrednio u przewoźnika (anuluje Wysyłam z Allegro i Base Courier) i nie zamawia kuriera. Protokołu z systemu przewoźnika jeszcze nie ma: „Pobierz protokół” daje dla każdego przewoźnika własną listę przekazanych paczek (protokół od DPD i Wysyłam z Allegro: w kolejnej wersji). „Rozstrzygnij ręcznie → nie powstała” zmienia tylko zapis w Kompletorze, u przewoźnika nic nie anuluje.
- Base Courier i Wysyłam z Allegro tworzą przesyłki tylko z modułem „z tworzeniem przesyłek” / „nadawanie” (`basecourier.zapis.v1`, `allegro.wysylam.zapis.v1`); moduły „podgląd” tylko liczą. Wysyłam z Allegro tworzy przesyłki tylko z modułem „nadawanie” (`allegro.wysylam.zapis.v1`) i dla zamówień z Allegro ([Allegro](integracje/allegro.md)).
- Anulowanie przesyłki nie zmienia statusu zamówienia. Zamówienie traci numer nadania (stary zostaje w historii), numer jeszcze niewysłany do sklepu jest wstrzymany, a numer, który już poszedł do sklepu, zastąpi numer nowej przesyłki. Anulowanie działa tylko na koncie w trybie „praca”.
- „Sprawdź u przewoźnika” przy przesyłce, która utknęła w tworzeniu (np. serwer padł w połowie kliknięcia), pojawia się po czasie zależnym od przewoźnika: InPost, DPD i Base Courier po 4 minutach, Wysyłam z Allegro po ok. 13,5 minuty (najdłuższy możliwy czas jego żywego wywołania i minuta zapasu). Wcześniej przycisk mógłby ścigać się z kliknięciem, które jeszcze trwa. Przy zwykłym braku odpowiedzi przewoźnika przesyłka od razu ma stan „Do sprawdzenia u przewoźnika” z tym przyciskiem.
- Samo utworzenie przesyłki nie ustawia „Wysłane”. Robi to przycisk „Przyjechał kurier” w kolejce pakowania (wszystkie spakowane z numerem nadania tego przewoźnika naraz), „Wysłane” na karcie albo, dla InPost, sprawdzenie u przewoźnika co 15 minut, gdy paczka pojechała bez kliknięcia ([Pakowanie](pakowanie.md)). Przesyłka do rozstrzygnięcia ręcznie albo bez numeru nadania zostaje w „Do wysłania”.

## Przewoźnicy

| Przewoźnik | Tworzenie przesyłki | Odszukanie po referencji |
|---|---|---|
| InPost ShipX (moduł „z tworzeniem przesyłek”) | tak, za wyłącznikiem | tak; pusta odpowiedź nie wyklucza przesyłki, wtedy rozstrzyga człowiek |
| DPD Polska bezpośrednio (moduł „zapis za wyłącznikiem”) | tak, za wyłącznikiem | tylko potwierdza przesyłkę (i tylko przy statusie paczki „OK”); brak potwierdzenia rozstrzyga człowiek („Rozstrzygnij ręcznie”) |
| Wysyłam z Allegro (moduł „nadawanie, etykieta i anulowanie”) | tak, za wyłącznikiem; anulowanie z karty | tak; Kompletor czyta wszystkie pięć prób przesyłki, a brak udanej i trwającej jest dowodem, że przesyłki nie ma |
| Base Courier (moduł „z tworzeniem przesyłek”) | tak, za wyłącznikiem; anulowanie z karty | nie (API go nie ma): referencja w polu „Zawartość przesyłki”, zgubioną odpowiedź rozstrzyga człowiek, a Kompletor sprawdza wpisany numer w Base Courier |
| Base Courier, Wysyłam z Allegro (moduł „podgląd”) | nie (podgląd) | nie |

Drugie konto DPD (np. osobna umowa na dostawy do salonów Empik) to osobna reguła przewoźnika z ustawieniem `sekretyKonta` (np. `EMPIK`): wtedy system bierze klucze `DPD_LOGIN_EMPIK` i `DPD_PASSWORD_EMPIK` zamiast `DPD_LOGIN` i `DPD_PASSWORD`. W instalacji na własnym serwerze to samo daje `envPrefix` reguły (np. `DPD_EMPIK`).
