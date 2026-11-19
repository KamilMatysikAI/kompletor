# DPD Polska bezpośrednio (DPDServices)

Dla sprzedawcy, który ma własną umowę z DPD Polska i chce, żeby Kompletor liczył przesyłki DPD bez pośrednika
(Base Courier). Kompletor przygotowuje przesyłkę, a tworzy ją dopiero po włączeniu nadawania ([Przesyłki](../przesylki.md)).

## Pozycja nr 1 do potwierdzenia z DPD: salony Empik

Specyfikacja API DPD (OpenAPI 3.0.1, wersja 5.27.0, sprawdzona 02.11.2026) **nie wspomina Empiku ani razu**.
Program Empik Marketplace ma osobny cennik i osobną umowę z DPD. Robocza hipoteza systemu: dostawa do salonu
Empik to usługa `DPD_PICKUP` z atrybutem `PUDO` równym kodowi salonu, opłacana z osobnego numeru płatnika (FID).
Dopóki DPD tego nie potwierdzi, każda przesyłka do salonu Empik ma ostrzeżenie „empik_niepotwierdzone”, a system
nie użyje usługi `PARTNER_PICKUP` (w dokumentacji jest tylko jej kod, bez opisu).

## Co system robi

- Na karcie zamówienia, w bloku „Przesyłka”, liczy parametry paczki DPD: kurier albo punkt DPD Pickup (także
  salon Empik), wymiary, wagę i kwotę pobrania. Wynik pokazuje jako podgląd z listą problemów do sprawdzenia.
- Pilnuje ograniczeń DPD: każdy bok paczki od 1 do 300 cm, waga od 0,01 kg, w punkcie do 20 kg i tylko jedna
  paczka w przesyłce, kurier do limitu z umowy (domyślnie 31,5 kg), pobranie do limitu (domyślnie 15 000 zł).
- Sprawdza połączenie z DPD jednym zapytaniem o zasięg kodu pocztowego (bez danych klientów).

## Czego system nie robi

- **Moduł „DPD Polska (bezpośrednio)” nie tworzy przesyłek, numerów listów, etykiet ani protokołów i nie zamawia
  kuriera.** Klient API, którego używa, odmawia tych operacji, zanim cokolwiek wyśle. Przesyłki z etykietą tworzy
  moduł „zapis za wyłącznikiem” z przycisku „Utwórz przesyłkę” ([Przesyłki](../przesylki.md)). Ten moduł też nie
  zamawia kuriera.
- **Protokołu odbioru z systemu DPD jeszcze nie pobiera** (`generateProtocol`): lista przesyłek → „Pobierz protokół”
  drukuje własną listę przekazanych paczek z miejscem na podpis kuriera. Protokół od DPD wejdzie (z
  potwierdzeniem i zapisem pliku, po sprawdzeniu na koncie demo DPD).
- Odszukanie paczki po referencji (gdy DPD nie odpowie przy tworzeniu) tylko potwierdza paczkę: system pyta o
  etykietę paczki z tą referencją i bierze z odpowiedzi numer listu. Kształt tego zapytania jest do sprawdzenia
  na koncie demo DPD przed pierwszym włączeniem; bez potwierdzenia przesyłka czeka na człowieka, system nie tworzy
  drugiej.
- Nie przechowuje adresów, imion, telefonów ani e-maili klientów. Podgląd zawiera tylko parametry paczki.
- Śledzi przesyłki tylko w wersji z zapisem i tylko po włączeniu DPD w Ustawienia → Wysyłka i druk → Przewoźnicy → „Automatyczne
  statusy wysyłki” → „Których przewoźników pytać o paczki”. Pyta usługę DPDInfoServices (`getEventsForWaybillV1`)
  osobnym loginem i hasłem od DPD (`DPD_SLEDZENIE_LOGIN`, `DPD_SLEDZENIE_HASLO`, w env `<przedrostek>_SLEDZENIE_LOGIN` i `_HASLO`; adres `sledzenieUrl`, opcjonalnie kanał
  `sledzenieKanal`); login DPDServices tam nie idzie. Bez tych danych śledzenie jest wyłączone. Zdarzenie „odebrana
  przez kuriera”, hub, oddział, doręczenie albo zwrot = paczka u DPD (lista kodów w `lib/adaptery/dpd.ts`); kody
  niejednoznaczne (np. mail do odbiorcy 170310) nie rozstrzygają. Odmowa logowania usługi śledzenia nie wyłącza konta
  nadawania DPD i nie kończy śledzenia paczek (wracają po poprawie danych); awaria usługi (Fault serwera, pusta albo
  nieczytelna odpowiedź) = kolejna próba za pół godziny.
  Do potwierdzenia na danych od DPD przed włączeniem: adres usługi (nie ma go w specyfikacji 1.0.7) i odpowiedź
  przy nieznanym numerze listu.
- Nie wyszukuje punktów na mapie: kod punktu albo salonu musi przyjść z zamówienia. Dziś kanały go nie dają,
  więc podgląd salonu Empik pokazuje błąd „brak kodu salonu” (to poprawne w trybie cienia, dane dostawy dołoży
  osobne zadanie).
- Tworzenie przesyłki i etykiety jest napisane, ale stoi za wyłącznikiem i nikt go nie woła (sekcja niżej).

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
- Czy zapytanie o kod pocztowy (`/public/routing/v1/postalCode`) wymaga logowania i jak wygląda jego treść?

## Ustawienia w systemie

Reguła przewoźnika DPD (i salonu Empik) z modułem **DPD_BEZPOSREDNIO** (adapter `dpd.services.v1`). Konfiguracja:
`baseUrl`, `payerFid` (wymagane), `masterFid`, `empikPayerFid`, `labelFormat` (`LBL_PRINTER` albo `A4`),
`defaultSideXCm`, `defaultSideYCm`, `defaultSideZCm`, `defaultWeightKg`, `limitWagiKuriera`, `codLimit`,
`envPrefix`. Plik etykiety (`PDF`, `ZPL`, `EPL`) wybiera wywołujący przy pobraniu etykiety, nie konfiguracja.
Sekrety (w panelu: Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → DPD Polska; tam też FID płatnika i „Nadawanie z Kompletora”): `DPD_LOGIN`, `DPD_PASSWORD`, opcjonalnie `DPD_MYPUDO_KEY` (zadeklarowany na przyszłe sprawdzanie punktów;
dziś system go nie używa).
Dane nadawcy to dane firmy: `Organization.settings.nadawca` (`name`, `fullName`, `address`, `city`, `postalCode`,
`countryCode`, `phone`, `email`).

## Niepewne (do potwierdzenia na demo DPD)

- [NIEPEWNE] Nagłówek `x-dpd-fid`: jest w opisie API, a schematy nie mają go wśród parametrów.
- [NIEPEWNE] `/public/courierorder/v1/courierOrderAvailability` to POST bez skutku (system traktuje go jako odczyt).
- [NIEPEWNE] Czy `/public/routing/v1/postalCode` wymaga logowania i jaka jest treść zapytania (system wysyła
  `{ countryCode, zipCode }`) i odpowiedzi.
- [NIEPEWNE] Salon Empik = `DPD_PICKUP` + kod salonu + osobny FID (pozycja nr 1 wyżej).
- [NIEPEWNE] Limit pobrania 15 000 zł i limit punktu 20 kg (dane Base Courier, nie z umowy bezpośredniej);
  limit kuriera 31,5 kg (schemat API pozwala do 700 kg w kraju).
- [NIEPEWNE] Kształt atrybutów usług `{ code, value }`, kod pocztowy bez kreski, `payerFID` jako liczba.
- [NIEPEWNE] Czy przy punkcie potrzebny jest też `receiver` obok `pudoReceiver`.
- [NIEPEWNE] Odbiorca: system wymaga tylko pól obowiązkowych w API (`receiver`: nazwa, adres, miasto, kod;
  `pudoReceiver`: nazwa), kraj zawsze PL (adres zagraniczny = odmowa). Numer domu, telefon i e-mail idą, gdy kanał je
  podał; Allegro i Woo dają ulicę z numerem w jednej linii i ta linia idzie jako `address`. Do sprawdzenia, czy DPD
  bez telefonu albo e-maila powiadomi odbiorcę o paczce w punkcie.
- Ostrzeżenia przesyłki (wartości robocze, niepotwierdzony salon Empik) przechodzą tylko potwierdzone przez człowieka
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
5. Osobne zadanie na program, który woła zapis i przekazuje potwierdzone ostrzeżenia oraz dane odbiorcy tylko
   w pamięci, i osobna zgoda właściciela na włączenie.
