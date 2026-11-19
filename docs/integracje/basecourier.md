# Base Courier: przesyłki InPost i DPD

Base Courier (dawniej BL Paczka, operator BL Logistics sp. z o.o.) to pośrednik, przez którego firma nadaje paczki InPost (paczkomat), DPD (kurier i punkt) i DPD do salonu Empik bez osobnych umów z przewoźnikami. Kompletor tworzy w nim przesyłkę z przycisku na karcie zamówienia albo na stanowisku pakowania, tak jak przyciski gabarytów w BaseLinkerze.

## Gdzie to jest

- **Karta zamówienia** (Zamówienia → numer zamówienia), sekcja „Przesyłka”: „Utwórz przesyłkę: InPost A”, „…B”, „…C” dla paczkomatu, „Utwórz przesyłkę: DPD” dla kuriera DPD i salonu Empik. Widzą je osoby z uprawnieniem do stanowiska pakowania.
- **Stanowisko pakowania** (Stanowisko): po „Spakowane” i wyborze gabarytu przycisk „Utwórz przesyłkę” z tym gabarytem.
- **Anuluj przesyłkę**: karta zamówienia i stanowisko, sekcja „Przesyłka”, przy utworzonej przesyłce.
- **Rozstrzygnij ręcznie**: karta zamówienia, sekcja „Przesyłka”, przy przesyłce „Do sprawdzenia u przewoźnika” (uprawnienie „Przesyłka niejasna u przewoźnika: ręczne rozstrzygnięcie”).
- **Konto Base Courier i klucz**: e-mail konta (`BASE_COURIER_LOGIN`) i klucz API (`BASE_COURIER_API_KEY`) są sekretami firmy, zaszyfrowanymi w bazie. Dziś wpisuje się je poleceniem `kompletor sekret` ([Integracje](README.md), „Gdzie wpisujesz klucze”); ekran kont przewoźników w Ustawienia → Wysyłka i druk → Przewoźnicy jest w drodze. Moduł i jego ustawienia (wyłącznik nadawania, rachunek pobrań, płatność, rozmiar etykiety) są w regule przewoźnika. W instalacji na własnym serwerze klucze mogą przyjść ze zmiennych o tych samych nazwach (albo z przedrostkiem `envPrefix` reguły).

## Co system robi

- **InPost A, B, C**: Base Courier nie ma pola „gabaryt”, więc przycisk wysyła stałe wymiary gabarytu: A 8×38×64 cm, B 19×38×64 cm, C 41×38×64 cm, do 25 kg. Kod paczkomatu bierze z danych klienta (punkt wybrany w sklepie albo poprawiony na karcie).
- **Kurier DPD**: wymiary paczki z ustawień przewoźnika (`defaultSideXCm`, `defaultSideYCm`, `defaultSideZCm`), waga z produktów albo domyślna. Wartości robocze trzeba potwierdzić polem wyboru przed nadaniem.
- **DPD do salonu Empik**: ten sam kurier DPD z kodem salonu jako punktem odbioru (do 20 kg).
- **Pobranie**: kwota to brutto zamówienia z Kompletora, tylko gdy zamówienie jest „za pobraniem”. Kwota niepewna (braki, podział na paczki, częściowa płatność) zatrzymuje nadanie z opisem, nigdy nie idzie jako 0 zł. Pobranie wymaga rachunku firmy na zwrot pobrań (ustawienie `kontoPobran`, 26 cyfr); bez niego przesyłka z pobraniem nie powstaje. Dokumentacja API oznacza rachunek jako pole wymagane, więc gdy firma go ma, idzie przy każdej przesyłce, także bez pobrania.
- **Nadawca**: dane firmy z Ustawienia → Dokumenty i faktury → Dane firmy (nazwa, adres, telefon, e-mail); pola z nadpisania `nadawca` w ustawieniach firmy (np. inny adres nadania) mają pierwszeństwo. To samo dotyczy DPD. Adres musi mieć numer budynku (Base Courier chce ulicę i numer osobno). Gdy czegoś brakuje, komunikat wymienia tylko brakujące pola.
- **Ubezpieczenie**: domyślnie bez (ubezpieczenie może podnieść cenę przesyłki). Ustawienie `ubezpieczenie` przewoźnika: „pobranie” = ubezpieczenie na kwotę pobrania (tylko przesyłki za pobraniem), liczba = stała kwota w zł.
- **Płatność za przesyłki**: `platnosc` = „Skarbonka” (saldo przedpłacone, domyślnie) albo „Płatność odroczona” (według regulaminu Base Courier od 01.11.2026 tylko dla aktywnych użytkowników systemu Base).
- **Podjazd kuriera**: domyślnie bez zamawiania podjazdu (paczkomat, stały odbiór kuriera); `zamawiajPodjazd` = tak, gdy kurier ma przyjeżdżać na zamówienie.
- **Etykieta**: PDF, domyślnie A6 na drukarkę etykiet, `rozmiarEtykiety` = A4 na kartkę. API Base Courier zna też ZPL i EPL, ale Kompletor pobiera z niego tylko PDF: przy regule z `formatEtykiety: ZPL` zapisze się PDF. Etykieta leży w bazie zaszyfrowana, ponowny druk nie pyta Base Courier.
- **Numer listu** przychodzi zwykle w odpowiedzi na utworzenie; gdy go jeszcze nie ma, „Pobierz numer nadania” dociąga go później. Szczegóły zamówienia w Base Courier mają dla paczek InPost pusty numer listu, choć lista zamówień go ma, więc Kompletor szuka wtedy numeru na liście (najnowsze 60 zamówień konta). Gdy zamówienia tam nie ma (np. konto nadało od tego czasu dużo innych paczek), komunikat odsyła do panelu Base Courier.
- **Anulowanie**: „Anuluj przesyłkę” anuluje zamówienie w Base Courier. Paczki już nadanej Base Courier nie anuluje: wtedy pokazuje komunikat przewoźnika.

## Zgubiona odpowiedź: bez drugiej płatnej paczki

Base Courier nie ma w API wyszukiwania zamówień po referencji ani klucza, który odrzuciłby drugie takie samo zamówienie. Dlatego Kompletor:

1. wpisuje swoją referencję na początku pola „Zawartość przesyłki” (np. „ref. 3f2c…; zam. SD-123”), widoczną w panelu Base Courier. Pole trafia też na etykietę i do panelu kuriera, więc odbiorca może tę referencję zobaczyć. Referencja stoi na początku, bo limitu długości pola nie znamy: gdy Base Courier utnie koniec, „Rozstrzygnij ręcznie” rozpozna przesyłkę po pierwszych 13 znakach referencji. Pierwsze 13 znaków liczy się tylko przy obciętym polu: gdy „Zawartość przesyłki” ma pełną, inną referencję, to inna paczka, nawet jeśli początek się zgadza;
2. nigdy nie ponawia utworzenia sam: przerwane połączenie, błąd serwera Base Courier, nieczytelna odpowiedź, odpowiedź „niepowodzenie”, w której jest numer zamówienia albo link do etykiety (numer pokazuje w powodzie), oraz odmowa bez wskazania błędnych pól (np. brak środków w skarbonce, patrz niżej) dają stan „Do sprawdzenia u przewoźnika” i alert, a kolejne kliknięcia niczego nie wysyłają;
3. „Sprawdź u przewoźnika” mówi wprost, że Base Courier nie pozwala odszukać przesyłki po referencji, i podaje tę referencję;
4. w „Rozstrzygnij ręcznie” wpisujesz numer zamówienia albo numer listu z panelu Base Courier. Kompletor sprawdza go w Base Courier: przesyłka musi istnieć i mieć w „Zawartości przesyłki” referencję tego zamówienia. Numer innej paczki zostanie odrzucony. Po potwierdzeniu system zapisuje przesyłkę, numer listu i etykietę bez nowego zamówienia w Base Courier;
5. „Przesyłka nie powstała” zaznaczasz tylko wtedy, gdy w panelu Base Courier nie ma zamówienia z tą referencją. Następne „Utwórz przesyłkę” pójdzie z nową referencją.

Gdy Base Courier nie zwróci „Zawartości przesyłki” w szczegółach, rozstrzygnięcie sprawdza tylko, że przesyłka o wpisanym numerze istnieje, i mówi to w komunikacie (zapisane też w dzienniku zmian).

**Pewna odmowa** (stan „Nie utworzono”, ponowienie po poprawce idzie tą samą referencją) to tylko: odmowa logowania (zły e-mail konta albo klucz), odmowa ze wskazaniem błędnych pól (np. zły kod pocztowy; powód podaje nazwy pól, bez danych klienta) i „za dużo zapytań” (Kompletor spróbuje później).

**Odmowa bez wskazania pól** (np. „brak środków w skarbonce”, odrzucona płatność odroczona) daje na razie „Do sprawdzenia u przewoźnika”: nie wiemy, czy Base Courier nie zostawia wtedy nieopłaconego zamówienia, a ponowienie mogłoby dać drugą płatną paczkę. Po doładowaniu skarbonki sprawdź w panelu Base Courier, czy jest zamówienie z referencją; jeśli nie ma, wybierz „Rozstrzygnij ręcznie → nie powstała” i utwórz przesyłkę jeszcze raz. Zmieni się to po teście na sandboxie: gdy pusta skarbonka nie zostawia zamówienia w panelu, stała `ODMOWA_BEZ_ZAMOWIENIA_PEWNA` w `lib/zrodla/basecourier-zapis.ts` idzie na `true` i taka odmowa wróci do „Nie utworzono”.

## Jak włączyć nadawanie

1. Klucze Base Courier (e-mail konta i klucz API) poleceniem `kompletor sekret` jak wyżej. **Nie generuj nowego klucza**, skopiuj istniejący: czy nowy klucz unieważnia stary (używany przez BaseLinkera), nie wiadomo `[do potwierdzenia]` (pytanie do Base Courier otwarte).
2. Reguła przewoźnika (paczkomat, DPD, salon Empik): moduł „Base Courier z tworzeniem przesyłek”, adres API `https://api.blpaczka.com/api` (albo `https://api.basecourier.com/api`, ten sam klucz; na próbę `https://sandbox.basecourier.com/api`), rachunek na zwrot pobrań, płatność. Stary adres sandboxu `sandbox.blpaczka.com` przekierowuje na `sandbox.basecourier.com`, a Kompletor za przekierowaniem nie idzie (klucz jest w treści zapytania), więc wpisz od razu nowy.
3. Test na sandboxie z kontem testowym, potem `zapisWlaczony`: tak. Sandbox to osobne konto (zakłada się je na sandbox.basecourier.com, skarbonkę doładowuje testowa płatność bez pieniędzy); klucz produkcyjny tam nie działa. Konto sklepu musi być w trybie „praca”: w cieniu przesyłki nadaje BaseLinker.

## Czego nie robi

- Nie zamawia odbioru kuriera i nie pobiera protokołu przekazania z Base Courier (lista przesyłek drukuje własną listę przekazanych paczek), nie śledzi statusów przesyłki. Wiele etykiet naraz: lista przesyłek → „Pobierz etykiety” albo „Drukuj etykiety” ([Przesyłki](../przesylki.md)).
- Nie wycenia przesyłki przed nadaniem (koszt widać w panelu Base Courier).
- Nie wysyła paczek za granicę ani palet i kopert (tylko paczka krajowa).
- Nie zmienia adresu po utworzeniu przesyłki: to robi się w panelu Base Courier.

## Źródło i niepewności

Base Courier ma publiczną dokumentację API (OpenAPI 3.0): https://api.basecourier.com/api/docs, plik `https://api.blpaczka.com/output.json`. Kompletor bierze z niej nazwy i wymagalność pól, a z oficjalnej wtyczki WooCommerce „BLPaczka” (BL Logistics, wordpress.org) formę zapytań tam, gdzie dokumentacja różni się od tego, co API naprawdę przyjmuje. Kształt odpowiedzi sprawdzony 15.11.2026 odczytem istniejących zamówień konta (bez tworzenia przesyłek):

| Operacja | Zapytanie | Odpowiedź |
|---|---|---|
| Utworzenie | `createOrderV2.json`: `CourierSearch` (courier_code, type, side_x/y/z, weight, `origin` = `kompletor`, uptake, cover tylko z ustawienia `ubezpieczenie`, no_pickup, country_code, foreign `'0'`), `Cart[0].Order` (nadawca, `taker_*`, `taker_point` zawsze, pusty bez punktu, `package_content`, `account`, gdy firma ma rachunek), `CartOrder.payment` | `success`, `message`, `data.Order[0].id`, `data.waybill_link`, `data.validationErrors` |
| Etykieta | `getWaybill.json`: `Order.id`, `Order.printer_type` (A4, LBL) | `data["0"].file` obok `data.labels` (dokumentacja) albo `data[0].file` (wtyczka) |
| Anulowanie | `cancelOrder.json`: `Order.id` (tekst, jak wtyczka) | `success`, `message` |
| Szczegóły | `getOrderDetails.json`: `Order.id` (tekst, obiekt jak wtyczka; tablica z dokumentacji daje odmowę); `getOrderDetailsByWaybillNo.json`: `Order.waybill_no` | `data.Order` (`waybill_no` puste dla paczek InPost) |
| Lista zamówień | `getOrders.json`: `Order.page` (po 20, najnowsze pierwsze) | `data[].Order` (`id`, `waybill_no`, `package_content`), `pagination.next` |

Pola wymagane w dokumentacji: `CourierSearch.origin` (bez niego API odrzuca zapytanie: „Wprowadź źródło pochodzenia (origin)”, sprawdzone wyceną), a w `Cart[].Order` między innymi `taker_point` i `account`. Pole numeru listu to `waybill_no`. Zły klucz daje HTTP 403 z `success: false`. Sandbox: `https://sandbox.basecourier.com`, osobne konto.

Jak Kompletor czyta odpowiedź utworzenia: najpierw treść, potem status HTTP. Id zamówienia może wrócić w `data.Order[0].id`, `data.blpaczka_order_id` albo `data.CartOrder.id`, a `data.waybill_link` też dowodzi zamówienia. Pełny sukces = `success: true` i `data.Order[0].id`. Każdy inny ślad zamówienia (także przy `success: false`, 4xx i 5xx) = „Do sprawdzenia u przewoźnika” z numerem. Bez śladu: 401/403 i `data.validationErrors` (nazwy pól z `CourierSearch` i `Cart`) = pewna odmowa, 429 = później, a reszta (5xx, pusta treść, `success: false` bez walidacji, inny 4xx) = „Do sprawdzenia”, dopóki sandbox nie pokaże inaczej (`ODMOWA_BEZ_ZAMOWIENIA_PEWNA`).

Do potwierdzenia pierwszą przesyłką na sandboxie przed włączeniem nadawania: czy udane utworzenie zawsze zwraca `success: true` (Kompletor wymaga go do pełnego sukcesu; gdyby API tego pola nie zwracało, każde nadanie kończyłoby się „Do sprawdzenia u przewoźnika” z numerem, bez drugiej paczki, i warunek trzeba poluzować do `success !== false` przy 2xx, `Order[0].id` i pustych `validationErrors`), czy przesyłka bez pobrania przechodzi bez `account`, gdy firma nie wpisała rachunku (dokumentacja oznacza pole jako wymagane i nie mówi, co wysłać bez rachunku; konto ma rachunek w profilu), czy pusty `taker_point` przy kurierze DPD do drzwi przechodzi (tak wysyła formularz wtyczki), czy `file` etykiety to base64 PDF w kształcie z dokumentacji, jaki jest limit długości `package_content` (dokumentacja go nie podaje), czy odmowa bez walidacji (pusta skarbonka) zostawia zamówienie w panelu (`ODMOWA_BEZ_ZAMOWIENIA_PEWNA`), czy `foreign: '0'` przechodzi przy tworzeniu tak jak w wycenie (dokumentacja ma `local`/`foreign`), czy przy `zamawiajPodjazd` API wymaga `pickup_date` i godzin odbioru (w dokumentacji opcjonalne), czy `printer_type: 'LBL'` daje A6 i czy przesyłka DPD z kodem salonu w `taker_point` dociera do salonu Empik (w BaseLinkerze salon szedł z osobnego konta DPD Salony Empik). Testy Kompletora chodzą na atrapie z tym kształtem odpowiedzi (`tests/basecourier-atrapa.ts`), bez połączeń z Base Courier.
