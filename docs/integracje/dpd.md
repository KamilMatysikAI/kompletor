# DPD Polska bezpośrednio (DPDServices)

Dla sprzedawcy, który ma własną umowę z DPD Polska i chce nadawać paczki DPD z Kompletora bez pośrednika
(Base Courier): kurier, punkt DPD Pickup, salon Empik, także za pobraniem. Kompletor liczy przesyłkę zawsze, a tworzy ją
u DPD (numer listu, etykieta) dopiero po włączeniu nadawania ([Przesyłki](../przesylki.md)).

## Salony Empik

Specyfikacja API DPD (OpenAPI 3.0.1, wersja 5.27.0, sprawdzona 02.11.2026) **nie wspomina Empiku ani razu**.
Program Empik Marketplace ma osobny cennik i osobną umowę z DPD (w BaseLinkerze osobne konto „DPD Salony Empik”).
Co wiemy z BaseLinkera (7 paczek do salonów z 08–12.11.2026): BaseLinker nadawał je **modułem DPD z konta
„DPD Salony Empik”**, a kod salonu z zamówienia (format `PL49…`) szedł jako punkt odbioru. Kompletor robi to samo:
usługa `DPD_PICKUP` z atrybutem `PUDO` równym kodowi salonu, nadana z osobnego konta DPD salonów z własnym loginem API
(sekcja „Jak włączyć nadawanie”). Login konta głównego nie nadaje na FID salonów: DPD odpowiada `DISALLOWED_FID`.
Pierwsza paczka do salonu z Kompletora poszła 20.11.2026 właśnie tak (osobne konto przewoźnika „Salony Empik” i reguła
salonu na nim). Od 25.11.2026 salon nie wymaga już osobnego potwierdzenia przy nadaniu (ostrzeżenie
„empik_niepotwierdzone” zdjęte); program nie używa usługi `PARTNER_PICKUP` (w dokumentacji jest tylko jej kod, bez opisu).

**Base Courier nie nadaje do salonów Empik.** Odrzuca kod salonu komunikatem „Punkt odbioru DPD nie istnieje lub jest
obecnie niedostępny”, bo nadaje na własnej umowie DPD, a salony są punktami programu Empik. Salony nadaje się
bezpośrednio przez DPD (ten moduł) albo, do czasu jego włączenia, w BaseLinkerze z konta „DPD Salony Empik”.

## Co system robi

- Na karcie zamówienia, w bloku „Przesyłka”, liczy parametry paczki DPD: kurier albo punkt DPD Pickup (także
  salon Empik), wymiary, wagę i kwotę pobrania. Wynik pokazuje jako podgląd z listą problemów do sprawdzenia.
- Po włączeniu nadawania przycisk „Utwórz przesyłkę” na karcie zamówienia i na stanowisku pakowania tworzy paczkę
  u DPD (numer listu i etykieta), tak jak w pozostałych modułach: wartości robocze (waga wbudowana, wymiary wbudowane) trzeba
  potwierdzić przed nadaniem, a brak odpowiedzi DPD daje stan „Do sprawdzenia u przewoźnika” bez drugiej paczki.
  Punkt DPD Pickup i salon Empik biorą kod punktu z danych odbiorcy (poprawka: „Popraw adres albo punkt odbioru”).
- Pilnuje ograniczeń DPD: każdy bok paczki od 1 do 300 cm, waga od 0,01 kg, w punkcie do 20 kg i tylko jedna
  paczka w przesyłce, kurier do limitu z umowy (domyślnie 31,5 kg), pobranie do limitu (domyślnie 15 000 zł).
- Sprawdza połączenie z DPD jednym zapytaniem o zasięg kodu pocztowego (bez danych klientów).

## Zamawianie kuriera

Gdzie: menu **Pakowanie** → pasek kuriera DPD (np. „DPD · odbiór pon. 13:00”) → przycisk **„Zamów kuriera DPD”**.
Widzi go osoba z uprawnieniem „kurier” (domyślnie role Właściciel, Biuro i Magazyn), tylko gdy konto DPD ma włączone
**„Zamawianie kuriera z Kompletora”**: Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → DPD Polska
→ „Zaawansowane”. Domyślnie wyłączone: firma ze stałymi odbiorami DPD niczego nie zmienia, pasek wygląda jak dotąd.

- Okno podpowiada najbliższy dzień i godziny odbioru z harmonogramu przewoźnika (ta sama tabela co „odbiór dziś
  13:00”; po godzinie odbioru i po „Przyjechał DPD” już następny dzień odbioru) oraz liczbę i wagę paczek DPD z numerem
  listu, które czekają na kuriera. Wszystko da się poprawić przed wysłaniem.
- Po zamówieniu pasek pokazuje „DPD zamówiony na 2026-11-23 13:00–15:00, zlecenie nr …”. Drugie kliknięcie tego dnia
  nie zamawia drugi raz; drugi podjazd tylko przyciskiem „Zamów drugi raz” z osobnym ostrzeżeniem.
- Warunki: nadawanie DPD z Kompletora włączone na tym koncie, przynajmniej jedno konto sprzedaży w trybie pracy, dane
  nadawcy firmy (nazwa, adres, telefon) i domyślne wymiary paczki DPD w koncie (DPD pyta o największą paczkę).
  Płatnik zlecenia = FID płatnika konta.
- Odmowa DPD: komunikat z powodem od DPD (pole i kod błędu, opis tylko bez danych z naszego zgłoszenia); nic nie
  zamówiono, można poprawić i zamówić ponownie. Brak odpowiedzi DPD (przerwane połączenie, awaria po ich stronie),
  strona zapory DPD albo odmowa z numerem zlecenia w odpowiedzi: „nie wiadomo, czy DPD przyjął zamówienie” z alertem;
  Kompletor nie ponawia, sprawdź w panelu DPD albo telefonicznie.
- Konto salonów Empik z osobnymi danymi API zamawia kuriera swoimi danymi, gdy ma włączone to samo ustawienie; login
  konta głównego nie przyjmuje FID salonów.
- [NIEPEWNE] jednostki wag (kg) i wymiarów (cm) w zgłoszeniu oraz kształt odpowiedzi do sprawdzenia przy pierwszym
  zamówieniu na koncie demo DPD.
- Godziny wpisuje się zawsze w dwa pola „od” i „do”. Wolne przedziały od DPD (np. 09:00–17:00, 11:00–14:00,
  14:00–17:00) są tylko podpowiedzią: kliknięcie wpisuje godziny w pola, ale DPD przyjmuje też inne okno (24.11.2026
  przyjął 12:00–17:00 spoza listy). DPD podaje przy przedziale liczbę minut (np. 360 przy 09:00–17:00), najpewniej
  zapas przed końcem przedziału; okno pokazuje z niej tylko miękki dopisek „zwykle do HH:MM” na dziś, nic nie blokuje.
- Okno nie podpowiada dziś, gdy kurier już był (kliknięte „Przyjechał DPD”) albo dziś nie jest dniem odbioru z
  harmonogramu; wtedy proponuje następny dzień odbioru.

### Kurier zamawia się sam

Gdzie włączyć: Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → DPD Polska → „Zaawansowane” →
**„Zamawiaj kuriera automatycznie”** (domyślnie wyłączone; działa tylko razem z „Zamawianie kuriera z Kompletora”).

- Kompletor sam zamawia jeden podjazd na najbliższy dzień odbioru z harmonogramu, kilka minut po pierwszej paczce DPD
  z numerem listu. Przycisk „Zamów kuriera DPD” zostaje.
- Godziny: z wolnych przedziałów DPD, ten obejmujący godzinę odbioru z harmonogramu, a gdy takiego nie ma, najszerszy.
  Na dziś: 09:00–17:00 do ok. 10:45, potem 14:00–17:00 do ok. 13:45; później automat czeka na następny dzień odbioru.
- Liczy tylko paczki, które naprawdę czekają: utworzone po ostatnim odbiorze („Przyjechał DPD” albo koniec okna
  zamówionego podjazdu), nieodebrane według śledzenia, bez anulowanych. Gdy dzisiejszy podjazd jeszcze trwa, automat
  czeka; jutrzejszy zamówi dla paczek, które zostaną po nim.
- **Założenie:** każdy podjazd jest zamawiany w Kompletorze albo potwierdzany kliknięciem „Przyjechał DPD”. Kuriera
  zamówionego telefonicznie albo w panelu DPD Kompletor nie widzi. Gdy nie ma żadnego śladu odbioru (ani
  „Przyjechał”, ani zlecenia z Kompletora z ostatnich 7 dni), paczki sprzed dzisiejszej północy są niepewne: automat ich
  nie liczy, a gdy czekają tylko takie, nic nie zamawia i daje alert raz na dzień.
- Nigdy drugi podjazd na ten sam dzień: każde zlecenie tego dnia (ręczne, w toku, „nie wiadomo”, zaznaczone „nie
  przyjął”) zatrzymuje automat. Odmowa godzin podjazdu (DPD nie przyjmuje tego przedziału) = alert i najwyżej jedna
  kolejna próba w innym przedziale. Każda inna odmowa tego dnia, także po kliknięciu przycisku (nieznany błąd DPD,
  usługa niedostępna, za dużo żądań, błąd danych), zatrzymuje automat na ten dzień z alertem. Gdy nie wiadomo,
  czy DPD przyjął, albo nie da się ustalić, które paczki czekają, automat nic nie zamawia i daje alert: zamów ręcznie.
- Pod paskiem kuriera widać, co automat zrobi albo dlaczego nie zamawia; zamówienie automatu ma dopisek „zamówiony
  automatycznie”.

## Śledzenie paczek (DPDInfoServices)

(20.11.2026) Kompletor pyta o paczki DPD prosto DPD, zamiast czekać na Base Courier, który podaje stan
paczek DPD z opóźnieniem nawet kilku godzin (20.11.2026: paczka odebrana przez kuriera o 14:32, w Base Courier o 19:30
nadal „przesyłka jeszcze nie nadana”).

- **Które paczki:** przewoźnik DPD albo DPD do salonu Empik, z numerem listu, niezależnie od modułu, którym powstała
  przesyłka (DPD bezpośrednio albo Base Courier). Co 15 minut, razem z resztą śledzenia ([Pakowanie](../pakowanie.md),
  „Siatka bezpieczeństwa”).
- **Warunek:** firma ma konto DPD z kompletem danych: login i hasło API DPDServices, FID (konta głównego, a bez niego
  FID płatnika) i środowisko „Produkcyjne”. Usługa śledzenia nie ma wersji demo, więc konto demo DPD nie jest pytane.
  Osobnych danych do śledzenia nie trzeba: DPD przyjmuje login API, a FID idzie jako kanał klienta (sprawdzone na
  produkcji 20.11.2026, także dla paczek nadanych przez Base Courier z innym płatnikiem). Najpierw konto z reguły
  przewoźnika paczki (gdy jej moduł to DPD bezpośrednio), potem konto główne DPD, potem pozostałe konta DPD.
- **Gdzie widać:** karta zamówienia i lista przesyłek (Przesyłki) pokazują status jak dotąd z Base Courier: opis
  zdarzenia DPD (np. „Przesyłka odebrana przez Kuriera”) i chwilę, w której Kompletor go zobaczył; w historii
  zamówienia wpis „Status przesyłki u przewoźnika”. Kod zdarzenia DPD zostaje w „statusie u kuriera” przesyłki.
- **Co zmienia stan:** sama rejestracja danych (030103) = paczka czeka na kuriera; odbiór przez kuriera (040101) i każde
  późniejsze zdarzenie fizyczne (oddział, hub, wydanie do doręczenia) = „Wysłane” (ta sama droga co „Przyjechał
  kurier”, w tym mail „Faktura” i zapis do sklepu); doręczenie tylko z kodów „przesyłka doręczona” (190101–190105,
  190201–190205, 410135, 501300, 501304, 501340); po zwrocie do nadawcy doręczenie nie liczy się jako doręczenie
  klientowi. **170310 „Powiadomienie mail” nic nie rozstrzyga** (DPD wysyła go m.in. zaraz po odbiorze przez kuriera) i
  nie jest doręczeniem. Nieznany kod bez zdarzeń „u DPD” niczego nie zmienia. Źródło nazw kodów: klient
  DPDInfoServices dbojdo/dpd-client (`BusinessCodes.php`, zgodny ze specyfikacją 1.0.7); oficjalnej listy kodów od DPD
  nie mamy, [NIEPEWNE] do potwierdzenia u opiekuna DPD.
- **Gdy DPD zawiedzie:** brak konta, pusta lista zdarzeń albo błąd DPD = paczka sprawdzana jak dotąd (Base Courier). Po
  odrzuconym logowaniu albo trzech błędach w jednym przebiegu DPD jest pomijany do końca przebiegu. Błąd trafia jedną
  linią do historii zadania „wysylka-sledzenie” (bez loginu i hasła) i do logu serwera.
- **Tylko odczyt:** jedna metoda `getEventsForWaybillV1` (adres
  `https://dpdinfoservices.dpd.com.pl/DPDInfoServicesObjEventsService/DPDInfoServicesObjEvents`); z odpowiedzi tylko
  kod, opis (bez e-maili i długich ciągów cyfr, do 120 znaków) i czas zdarzenia.

## Czego system nie robi

- **Moduł „DPD Polska (bezpośrednio)” nie tworzy przesyłek, numerów listów, etykiet ani protokołów i nie zamawia
  kuriera.** Klient API, którego używa, odmawia tych operacji, zanim cokolwiek wyśle. Przesyłki z etykietą tworzy
  moduł „DPD Polska (bezpośrednio, zapis za wyłącznikiem)” z przycisku „Utwórz przesyłkę”
  ([Przesyłki](../przesylki.md)). Ten moduł nie anuluje paczek (anulowanie w panelu DPD). Kuriera zamawia tylko po
  włączeniu „Zamawianie kuriera z Kompletora” w koncie DPD (niżej, „Zamawianie kuriera”); zamówionego kuriera
  odwołuje się w panelu DPD albo telefonicznie, Kompletor zlecenia nie anuluje.
- **Protokołu odbioru z systemu DPD jeszcze nie pobiera** (`generateProtocol`): lista przesyłek → „Pobierz protokół”
  drukuje własną listę przekazanych paczek z miejscem na podpis kuriera. Protokół od DPD wejdzie (z
  potwierdzeniem i zapisem pliku, po sprawdzeniu na koncie demo DPD).
- Odszukanie paczki po referencji (gdy DPD nie odpowie przy tworzeniu) tylko potwierdza paczkę: system pyta o
  etykietę paczki z tą referencją i bierze z odpowiedzi numer listu. Kształt tego zapytania jest do sprawdzenia
  na koncie demo DPD przed pierwszym włączeniem; bez potwierdzenia przesyłka czeka na człowieka, system nie tworzy
  drugiej.
- Nie przechowuje adresów, imion, telefonów ani e-maili klientów. Podgląd zawiera tylko parametry paczki.
- Nie pobiera zdarzeń zbiorczo dla całego konta (`getEventsForCustomer`): pyta o każdą paczkę osobno po numerze listu
  (niżej, „Śledzenie paczek”).
- Nie wyszukuje punktów na mapie: kod punktu albo salonu musi przyjść z zamówienia (Empik podaje kod salonu) albo
  trzeba go wpisać na karcie („Popraw adres albo punkt odbioru”). Bez kodu salon Empik ma błąd „Brak kodu salonu
  Empik” i przesyłka nie powstanie.
- Moduł DPD z zapisem ma też własne śledzenie przez DPDInfoServices z osobnymi danymi (`DPD_SLEDZENIE_LOGIN`,
  `DPD_SLEDZENIE_HASLO`, adres `sledzenieUrl`), domyślnie wyłączone na liście „Których przewoźników pytać o paczki”
  (Ustawienia → Wysyłka i druk → Przewoźnicy → „Automatyczne statusy wysyłki”). Paczki DPD firmy z kontem DPD pyta
  niezależnie od tej listy droga opisana niżej w „Śledzenie paczek” (dane konta DPDServices); moduł jest pytany tylko,
  gdy ta droga nie dała wyniku.

## Jak dostać login API

1. Napisz do swojego opiekuna handlowego DPD, w kopii do **itcustomer@dpd.com.pl**, z prośbą o dostęp do
   **DPDServices (REST)** dla Twojego numeru klienta.
2. Login API to **inne dane** niż logowanie do aplikacji kurierskiej i **inne niż numer FID**. Dostaniesz login,
   hasło i numer FID (albo kilka numerów FID).
3. Najpierw poproś o dostęp do środowiska demo (`https://dpdservicesdemo.dpd.com.pl`), produkcja to
   `https://dpdservices.dpd.com.pl`. System nie łączy się z żadnym innym adresem.

## Jakie pytania zadać DPD

- Czy na naszej umowie są aktywne usługi **COD** (pobranie) i **DPD_PICKUP** (dostawa do punktu)? Jaki jest limit
  pobrania i limit wagi paczki kurierskiej?
- **Salony Empik:** czy dostawa do salonu Empik to `DPD_PICKUP` z kodem salonu jako `PUDO`? Skąd brać kody salonów?
  Czy potrzebny jest osobny FID płatnika dla przesyłek Empik i czy `PARTNER_PICKUP` ma tu jakieś znaczenie?
- **Który FID** wpisać jako płatnika (`payerFID`), a który w nagłówku `x-dpd-fid` (FID konta głównego)?
- **MyPudo** (`https://mypudo.dpd.com.pl/api/v2/` i widget mapy punktów): czy dostaniemy klucz?

## Jak włączyć nadawanie (panel)

1. **Ustawienia → Wysyłka i druk → Przewoźnicy**: w regułach „DPD” i „salon Empik” ustaw moduł wysyłki
   „DPD Polska (bezpośrednio, zapis za wyłącznikiem)”. Jeśli salony Empik mają osobne konto DPD z własnym loginem,
   najpierw dodaj je (krok 3), a w regule salonu wybierz to konto w polu konta pod modułem wysyłki.
2. Ten sam ekran → **Konta przewoźników** → karta „DPD Polska”: wpisz login i hasło API DPDServices oraz FID płatnika;
   w „Zaawansowane” wybierz środowisko (demo albo produkcja; domyślnie demo, czyli testowe dane od DPD i żadnych
   prawdziwych paczek), FID konta głównego (nagłówek), domyślne wymiary i wagę paczki. Pole „FID płatnika dla salonów
   Empik” zostaw puste, gdy salony mają osobne konto DPD z własnym loginem (krok 3): login konta głównego nie nadaje
   na FID salonów (`DISALLOWED_FID`). „Zapisz”, potem „Sprawdź połączenie”: wynik mówi, które
   środowisko odpowiedziało. Kolejność kroków 1 i 2 jest dowolna: ustawienia konta zapisują się także wtedy, gdy
   żadna reguła jeszcze nie używa modułu DPD.
3. Salony Empik na osobnym koncie DPD (osobny login): na dole ekranu Konta przewoźników „Drugie konto przewoźnika” →
   przewoźnik DPD Polska, nazwa „Salony Empik” → „Dodaj konto”; w nowej karcie login, hasło i FID tego konta.
4. Włącz „Nadawanie z Kompletora” przy regułach DPD i salonu Empik dopiero po próbie z sekcji „Lista przed włączeniem
   zapisu”. Wyłączone: przycisk „Utwórz przesyłkę” widać, ale nic nie wysyła.
5. Automaty z akcją „Utwórz przesyłkę” przypiętą do modułu Base Courier (np. przyciski „Kurier DPD” i „Kurier DPD
   Empik” przeniesione z BaseLinkera) po zmianie reguły na DPD nic nie nadają i zapisują w historii zamówienia powód
   „przewoźnik zamówienia nadaje modułem …, a reguła wskazuje inny”. Edytor w Ustawienia → Sprzedaż i kanały → Automatyczne akcje zmienia w tej akcji
   tylko gabaryt, więc moduł przypięty w takim automacie zmienia osoba techniczna (pusty moduł = moduł z reguły
   przewoźnika). Zwykły przycisk „Utwórz przesyłkę” na karcie i na stanowisku zawsze używa modułu z reguły.

Klucze są szyfrowane w bazie, panel pokazuje tylko „ustawiony / brak”, wartości nie trafiają do logów ani historii
zmian.

## Ustawienia w systemie

Reguła przewoźnika DPD (i salonu Empik) z modułem **DPD_BEZPOSREDNIO** (adapter `dpd.services.v1` do podglądu albo
`dpd.services.zapis.v1` do nadawania). Konfiguracja: `srodowisko` (`demo` domyślnie albo `produkcja`), `baseUrl`
(tylko instalacja na własnym serwerze, wygrywa ze środowiskiem), `payerFid` (wymagane), `masterFid`, `empikPayerFid`, `labelFormat` (`LBL_PRINTER` albo `A4`),
`defaultSideXCm`, `defaultSideYCm`, `defaultSideZCm`, `defaultWeightKg`, `limitWagiKuriera`, `codLimit`,
`zamawianieKuriera` (tak/nie, domyślnie nie), `envPrefix`. Plik etykiety (`PDF`, `ZPL`, `EPL`) wybiera wywołujący przy pobraniu etykiety, nie konfiguracja.
Sekrety (w panelu: Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → DPD Polska; tam też FID płatnika i „Nadawanie z Kompletora”): `DPD_LOGIN`, `DPD_PASSWORD`, opcjonalnie `DPD_MYPUDO_KEY` (zadeklarowany na przyszłe sprawdzanie punktów;
dziś system go nie używa).
Dane nadawcy to dane firmy: `Organization.settings.nadawca` (`name`, `fullName`, `address`, `city`, `postalCode`,
`countryCode`, `phone`, `email`).

## Niepewne (do potwierdzenia na demo DPD)

- Sprawdzone na żywym koncie 20.11.2026 (sam odczyt): zapytanie o kod pocztowy to **GET**
  `/public/routing/v1/postalCode?countryCode=PL&zipCode=02274` z Basic Auth i nagłówkiem `x-dpd-fid`; odpowiedź
  `{"status":"OK","traceId":…}`, złe hasło HTTP 401, nieistniejący kod HTTP 404 `POSTAL_CODE_NOT_FOUND`. Przechodzi
  z każdym z trzech FID konta (główny, zwykły, salonów) na tym samym loginie. To samo zapytanie wysłane POST-em z treścią
  JSON zapora DPD odrzuca stroną HTML „Request Rejected” z kodem HTTP 200; system pokazuje wtedy błąd „zapora DPD
  odrzuciła żądanie” (przy zapisie przesyłka trafia do „Do sprawdzenia u przewoźnika”: sprawdź w panelu DPD, czy paczka nie powstała; tak samo, gdy ta strona przyjdzie z kodem 4xx albo gdy odmowa 4xx niesie numer listu, bo specyfikacja dla 400 podaje ten sam kształt odpowiedzi co dla udanego zapisu). Zapis (`generatePackagesNumbers`,
  `generateSpedLabels`) jest w specyfikacji POST-em z JSON. `courierOrderAvailability` to w specyfikacji też GET.
- Sprawdzone 20.11.2026: salon Empik = `DPD_PICKUP` + kod salonu jako `PUDO`, nadane z osobnego konta DPD salonów
  (własny login API, w Kompletorze osobne konto przewoźnika i reguła salonu na nim). DPD przyjął taką paczkę bez
  dodatkowej usługi. Login konta głównego z FID salonów dostaje `DISALLOWED_FID`, więc jeden login z osobnym FID salonów
  nie działa.
- [NIEPEWNE] Limit pobrania 15 000 zł i limit punktu 20 kg (dane Base Courier, nie z umowy bezpośredniej);
  limit kuriera 31,5 kg (schemat API pozwala do 700 kg w kraju).
- [NIEPEWNE] Kształt atrybutów usług `{ code, value }`, kod pocztowy bez kreski, `payerFID` jako liczba.
- [NIEPEWNE] Czy przy punkcie potrzebny jest też `receiver` obok `pudoReceiver`.
- [NIEPEWNE] Odbiorca: system wymaga tylko pól obowiązkowych w API (`receiver`: nazwa, adres, miasto, kod;
  `pudoReceiver`: nazwa), kraj zawsze PL (adres zagraniczny = odmowa). Numer domu, telefon i e-mail idą, gdy kanał je
  podał; Allegro i Woo dają ulicę z numerem w jednej linii i ta linia idzie jako `address`. Do sprawdzenia, czy DPD
  bez telefonu albo e-maila powiadomi odbiorcę o paczce w punkcie.
- Ostrzeżenia przesyłki (wartości robocze) przechodzą tylko potwierdzone przez człowieka; informacje (np. waga domyślna z ustawień konta) host dopisuje do potwierdzonych sam
  (`potwierdzoneOstrzezenia` w żądaniu); FID Empik system wybiera po przewoźniku zamówienia `DPD_EMPIK`.
- [NIEPEWNE] Pola odpowiedzi `generatePackagesNumbers` (`status`, `packages[].parcels[].waybill`) i
  `generateSpedLabels` (`documentData` w base64), treść zapytania o etykietę (wzorowana na SOAP).
- [NIEPEWNE] DPD nie ma odczytu paczki po referencji: niepewny wynik zapisu (timeout, 5xx) zostaje dla człowieka,
  bez ponawiania.

## Lista przed włączeniem zapisu

Zapis (numery listów kosztują, etykieta) ma osobny adapter `dpd.services.zapis.v1`. Działa tylko wtedy, gdy
spełnione są **wszystkie trzy** warunki: firma ma ten klucz w regule przewoźnika, ma w jego konfiguracji
`zapisWlaczony: true` i program wywoła zapis (dziś żaden nie woła: pilnuje tego test). Przed włączeniem:

1. Wszystkie pozycje z listy „Niepewne” sprawdzone na demo DPD, zwłaszcza salon Empik i FID.
2. Konto demo: utworzona testowa paczka kurierska, paczka do punktu i paczka z pobraniem; etykieta wydrukowana
   na drukarce magazynu w wybranym formacie.
3. Ustawione dane nadawcy firmy (`Organization.settings.nadawca`) i domyślne wymiary paczki.
4. Ustalone, kto rozwiązuje przesyłki z wynikiem „niejednoznaczny” (sprawdzenie w panelu DPD po referencji).
5. Program, który woła zapis, jest gotowy: host przesyłek (przycisk „Utwórz przesyłkę” na karcie i na stanowisku,
   automaty z akcją „Utwórz przesyłkę”) przekazuje potwierdzone ostrzeżenia, a dane odbiorcy tylko w pamięci.
   Włączenie na produkcji to osobna zgoda właściciela po próbie z punktów 1–2 (plan próby).
