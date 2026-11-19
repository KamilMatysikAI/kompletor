# InPost bezpośrednio (ShipX): paczkomat i kurier

Dla sprzedawcy, który ma **własną umowę z InPost** i chce obsługiwać przesyłki InPost w Kompletorze bez pośrednika
(np. bez Base Courier).

## Co system robi

- Dla zamówienia z paczkomatem albo kurierem InPost **liczy przesyłkę**: usługę ShipX (`inpost_locker_standard` albo
  `inpost_courier_standard`), gabaryt paczkomatu A/B/C (8×38×64, 19×38×64, 41×38×64 cm), wymiary i wagę paczki
  kurierskiej, kwotę pobrania, limit wagi 25 kg i limit pobrania z Twojej konfiguracji.
- Wynik widać na karcie zamówienia w bloku **„Przesyłka”** (przycisk „Przygotuj przesyłkę”). Wartości robocze (waga
  domyślna, wymiary domyślne, gabaryt z podpowiedzi) są oznaczone; problemy z poziomem „błąd” znaczą, że takiej
  przesyłki nie dałoby się nadać.
- **Sprawdza połączenie** z kontem ShipX jednym odczytem: `GET /v1/organizations/:id`. Wynik nie zawiera tokenu ani
  nazwy organizacji.
- Ma funkcję sprawdzenia punktu odbioru (`GET /v1/points/:name`: czy paczkomat istnieje, działa i przyjmuje
  pobranie) dla przyszłego trybu pracy i narzędzi; podgląd przesyłki jej nie woła (liczy się bez sieci).

## Czego system nie robi

- **Moduł do podglądu nie tworzy przesyłek, nie pobiera etykiet, nie zamawia kuriera** (zlecenie odbioru), nie zakłada webhooków.
- Przesyłki z etykietą i numerem nadania tworzy moduł „z tworzeniem przesyłek” z przycisku „Utwórz przesyłkę” ([Przesyłki](../przesylki.md)). Numer nadania InPost daje chwilę po utworzeniu; system dociąga go przy pobraniu etykiety.
  Domyślny adapter `inpost.shipx.v1` jest tylko do odczytu: klient HTTP odmawia każdej innej operacji, zanim cokolwiek
  wyśle. Każde utworzenie przesyłki w ShipX kosztuje, dlatego zapis jest osobno (niżej) i dziś nikt go nie woła.
- **Nie przechowuje adresów klientów.** Podgląd przesyłki ma tylko parametry paczki (wymiary, waga, usługa, kwota
  pobrania, problemy). Imię, adres, telefon i e-mail odbiorcy nie trafiają do bazy, logów ani alertów.
- Kodu paczkomatu wybranego przez klienta jeszcze nie zna: kanały nie dają go do cienia (osobne zadanie dokłada dane
  dostawy). Do tego czasu podgląd paczkomatu ma błąd „Brak punktu odbioru”.

## Skąd token i id organizacji [do potwierdzenia]

1. Zaloguj się do **Managera Paczek InPost** (manager.paczkomaty.pl) kontem firmy z umową.
2. Token API ShipX i id organizacji są w ustawieniach konta, w sekcji API [ścieżka menu do potwierdzenia]. Jeśli ich
   nie ma, poproś opiekuna handlowego InPost o dostęp do API ShipX dla Twojej organizacji.
3. Wklej token w panelu: Ustawienia → Wysyłka i druk → Przewoźnicy → przycisk „Konta przewoźników” → InPost ShipX → pole tokenu → „Zapisz zmiany”, potem „Sprawdź połączenie”. Z terminala (administrator) to samo robi:
   `npm run sekret -- --firma <twoja-firma> --ustaw INPOST_TOKEN --ze-stdin < plik-z-tokenem`
   (self-host: albo zmienna `<envPrefix>_TOKEN`, np. `INPOST_TOKEN`, gdy `envPrefix` = `INPOST`).

Konto testowe (**sandbox**, `https://sandbox-api-shipx-pl.easypack24.net`) zakłada się przez formularz InPost dla
integratorów albo przez opiekuna [do potwierdzenia]. Sandbox bywa niekompletny (brak śledzenia, pusta odpowiedź przy
sukcesie): system to znosi.

## Jak włączyć liczenie przesyłek InPost

Przewoźnika i moduł wysyłki zamówienia wyznaczają **reguły przewoźnika** firmy (Ustawienia → Wysyłka i druk → Przewoźnicy, karta „Który przewoźnik dla którego sposobu dostawy”; tabela `CarrierRule`). Pierwsza pasująca reguła (rosnąco po priorytecie) wygrywa.

- **Paczkomat:** w regule z przewoźnikiem `PACZKOMATY` ustaw moduł `INPOST_SHIPX` (adapter domyślny modułu to
  `inpost.shipx.v1`, pole `adapterKey` może zostać puste).
- **Kurier InPost:** dodaj regułę z przewoźnikiem `INPOST_KURIER`, modułem `INPOST_SHIPX` i wzorcem metody dostawy
  (np. `kurier inpost`) z **niższym priorytetem niż reguła DPD**: domyślny wzorzec `dpd|kurier` łapie każde „kurier”
  i daje DPD.
- W polu `config` reguły (albo konfiguracji adaptera):

| Pole | Wymagane | Opis |
|---|---|---|
| `baseUrl` | tak | `https://api-shipx-pl.easypack24.net` albo sandbox `https://sandbox-api-shipx-pl.easypack24.net` (inne adresy są odrzucane) |
| `organizationId` | tak | id organizacji ShipX |
| `sendingMethod` | nie | sposób nadania, domyślnie `dispatch_order` (odbiór przez kuriera z magazynu); nadajesz w paczkomacie = `parcel_locker` [NIEPEWNE: czy wtedy potrzebny `dropoff_point`] |
| `defaultSideXCm`, `defaultSideYCm`, `defaultSideZCm` | nie | wymiary paczki kurierskiej w cm; bez nich 40×30×20 cm z ostrzeżeniem |
| `defaultWeightKg` | nie | waga, gdy produkty nie mają wagi; bez niej 1 kg z ostrzeżeniem |
| `codLimit` | nie | najwyższa kwota pobrania wg Twojej umowy; bez niej każde pobranie ma ostrzeżenie |
| `envPrefix` | nie | self-host: przedrostek zmiennych środowiska |

## Zapis (tworzenie przesyłki i etykieta): za wyłącznikiem

Osobny klucz adaptera `inpost.shipx.zapis.v1` umie utworzyć przesyłkę (`POST /v1/organizations/:id/shipments`),
odszukać ją po referencji i pobrać etykietę (PDF, ZPL, EPL). Przesyłka powstaje **tylko przy trzech warunkach naraz**:

1. reguła przewoźnika firmy wskazuje klucz `inpost.shipx.zapis.v1`,
2. konfiguracja ma `zapisWlaczony: true` (domyślnie brak = wyłączone; wtedy nie wychodzi żadne żądanie),
3. host (tryb PRACA) wywoła utworzenie przesyłki: **dziś żaden kod tego nie robi**, pilnuje tego test.

Wynik niejednoznaczny (timeout, 5xx, pusta odpowiedź po wysłaniu) nie jest ponawiany w ciemno: system szuka przesyłki
po referencji (`reference`). Znaleziona = OK. **Nieznaleziona też trafia do człowieka, nie do ponowienia**: ShipX nie
wymusza unikalności referencji i tworzy przesyłkę asynchronicznie, więc pusta lista tuż po błędzie nie dowodzi, że
przesyłki nie ma, a ponowienie mogłoby utworzyć drugą, płatną.

Inne zasady zapisu: kraj odbiorcy inny niż PL = odmowa (moduł jest krajowy); telefon idzie jako 9 cyfr bez +48
(nieczytelny numer = odmowa z kodem `telefon`; wspólny odczyt `lib/wysylka/telefon.ts`, więc 9 cyfr
zaczynających się od 0 też jest odmową, bo żaden polski numer krajowy nie zaczyna się od 0); ostrzeżenia przesyłki przechodzą tylko potwierdzone przez człowieka
(`potwierdzoneOstrzezenia`); odmowa ShipX 4xx podaje kod błędu i nazwy pól z `details`, bez wartości. Pobranie do
paczkomatu ma ostrzeżenie `pobranie_punkt`: przed potwierdzeniem sprawdź, czy paczkomat przyjmuje pobranie.

### Lista przed włączeniem zapisu

- [ ] Wszystkie pozycje [NIEPEWNE] niżej potwierdzone na sandboxie i poprawione w kodzie.
- [ ] Na sandboxie: utworzona przesyłka paczkomatowa i kurierska, z pobraniem i bez; numer śledzenia dochodzi po
      przetworzeniu (przesyłka powstaje asynchronicznie: najpierw `status: created`, `tracking_number: null`).
- [ ] Odszukanie po referencji działa (filtr listy przesyłek): bez tego niejednoznaczny wynik zawsze trafia do człowieka.
- [ ] Sprawdzone, czy `GET …/shipments?reference=` widzi przesyłkę natychmiast po `POST` (także w stanie `created`).
      Dopiero wtedy wolno zmienić „nie znaleziono” z odmowy na bezpieczne ponowienie (`lib/zrodla/inpost-zapis.ts`,
      `findByReference`); do tego czasu każdy niejednoznaczny wynik rozstrzyga człowiek.
- [ ] Format telefonu `receiver.phone` (system wysyła 9 cyfr bez +48).
- [ ] Etykieta PDF i ZPL wydrukowana na drukarce magazynu (143×100 mm; ZPL 203/300 dpi).
- [ ] Ustalony `codLimit` z umowy i potwierdzone, czy pobranie wymaga ubezpieczenia.
- [ ] Gotowy host trybu PRACA: dane odbiorcy pobierane z kanału w chwili użycia, tylko w pamięci; ostrzeżenia
      (wartości robocze) potwierdza człowiek; referencja deterministyczna (`deriveReference`).
- [ ] Osobne GO właściciela na zapis u przewoźnika dla tej firmy.

## [NIEPEWNE]: do potwierdzenia na sandboxie

Dokumentacja ShipX renderuje się w JS i nie dało się jej odczytać w całości automatycznie (sprawdzone 02.11.2026).

1. Autoryzacja: `Authorization: Bearer <token>` (dokumentacja mówi „OAuth 2.0”, SDK podaje klucz API).
2. Adres sandboxu `https://sandbox-api-shipx-pl.easypack24.net` (z SDK michalbiarda/shipx-php-sdk).
3. Kształt odpowiedzi `GET /v1/organizations/:id` (pole `id` porównywane z ustawionym).
4. Kształt odpowiedzi `GET /v1/points/:name`: `name`, `status` (`Operating` i inne), `type` (tekst albo lista),
   `payment_available`.
5. `sender` opcjonalny, domyślnie z organizacji (system go nie wysyła).
6. `parcels`: paczkomat `{ template: small|medium|large }`, kurier `{ dimensions: { length, width, height, unit: 'mm' },
   weight: { amount, unit: 'kg' } }`.
7. `receiver`: `first_name` / `last_name` z podziału „imię nazwisko” po pierwszej spacji, `phone` jako 9 cyfr bez
   +48 (zdjęty prefiks, inny wynik = odmowa), `address.building_number` jako „dom/lokal”.
8. `custom_attributes.sending_method`: pełna lista wartości (`dispatch_order`, `parcel_locker`, `pop`, …); czy
   `parcel_locker` / `pop` wymaga `dropoff_point` (system go dziś nie wysyła).
9. Czy pobranie wymaga ubezpieczenia co najmniej na tę kwotę (system przygotowuje `insurance` = kwota pobrania
   z ostrzeżeniem `pobranie_ubezpieczenie`).
10. Limit kwoty pobrania (w konfiguracji `codLimit`, bez stałej w kodzie).
11. Odpowiedź utworzenia przesyłki: pole `id` (sandbox bywa pusty przy sukcesie → wynik niejednoznaczny i odszukanie).
12. Filtr `reference` listy przesyłek `GET /v1/organizations/:id/shipments?reference=…`, kształt `{ items: [...] }`
    i natychmiastowość (czy świeżo utworzona przesyłka jest od razu na liście).
13. Etykieta `GET /v1/shipments/:id/label`: wartości `format` (`Pdf`, `Zpl`, `Epl`) i `type` (`normal`, `A6`).
14. Limity tempa API (manifest zakłada ostrożnie 60 żądań na minutę, jedno naraz).
15. Ścieżka menu tokenu i id organizacji w Managerze Paczek; sposób założenia konta sandbox.
