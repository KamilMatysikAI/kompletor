# Wysyłam z Allegro (`allegro.wysylam.v1`; nadawanie `allegro.wysylam.zapis.v1`)

> **:** obok trybu podglądu jest moduł z nadawaniem `allegro.wysylam.zapis.v1`
> (`lib/adaptery/allegro-wysylam-zapis.ts`, klient zapisu `lib/zrodla/allegro-zapis.ts`): `create-commands`
> asynchronicznie z odpytywaniem (`commandId` = `deriveReference([referencja, 'allegro-przesylka', n])`, n = 1…5; przed
> wysłaniem adapter czyta próby po kolei: SUCCESS = przesyłka już jest, IN_PROGRESS = czeka, ERROR = następne n,
> 404 = wolne n), `findByReference` po tych samych próbach, etykieta `POST /shipment-management/label`, numer z
> `GET shipments/{id}` (`packages[].waybill`), anulowanie `cancel-commands` (zdolność `shipment.cancel`). Host
> przesyłek (`lib/wysylka/nadanie.ts`, `adapterNadania`) tworzy go na koncie Allegro zamówienia (te same tokeny co
> `allegro.v1`) z ustawieniami reguły przewoźnika (`zapisWlaczony`, `formatEtykiety`). Opis dla sprzedawcy:
> [Allegro](integracje/allegro.md). Poniższy opis dotyczy trybu podglądu `allegro.wysylam.v1`, który działa bez zmian
> (strażnik odczytu nadal odrzuca ścieżki komend).
>
> **, śledzenie (`shipment.track`, `trackReportsDelivered`) w `allegro.wysylam.zapis.v1`:** przebieg
> śledzenia (`lib/pakowanie/wyslane-po-przyjezdzie.ts`, co 15 min) czyta `GET shipments/{id}` (`packages[].waybill`,
> `carrier`, `canceledDate`), a potem historię statusów `GET /order/carriers/{carrier}/tracking?waybill=<numer>`.
> `{carrierId}` = pole `carrier` przesyłki, tak każe poradnik Allegro („Jak pobrać historię statusów przesyłek”);
> `ALLEGRO` w dokumentacji to tylko przykład. Zasób nie wymaga osobnego zakresu OAuth (w specyfikacji
> `bearer-token-for-user: []`), więc autoryzacja konta się nie zmienia. Strażnik przepuszcza tę jedną ścieżkę
> z parametrem zapytania: wyłącznie `waybill`, 1–20 numerów (litery, cyfry, myślnik). Kody (`ParcelTrackingStatus`):
> PENDING → przed nadaniem; IN_TRANSIT, RELEASED_FOR_DELIVERY, AVAILABLE_FOR_PICKUP, NOTICE_LEFT → u przewoźnika
> (zamówienie z „Do wysłania” przechodzi do „Wysłane”); DELIVERED → doręczona (koniec śledzenia po „Wysłane”);
> ISSUE i RETURNED bez wcześniejszego „u przewoźnika” oraz kody spoza listy → nieznany (bez zmian). Pusta historia albo
> `trackingDetails: null` = przed nadaniem. Do historii zamówienia trafia sam kod i polski opis kodu; pola
> `description` z Allegro (wolny tekst) nie bierzemy. Śledzenie nie wymaga wyłącznika nadawania (sam odczyt paczek już
> nadanych). 403 przy historii to błąd tej paczki (przejściowy), nie konta: nie liczy się do wyłączenia konta Allegro.
> Przesyłka nieznana (404), anulowana w Allegro albo bez `carrier` = błąd w wyniku zadania śledzenia, bez zgadywania.

Faza F2, tryb „przygotuj, nie wysyłaj”. System liczy przesyłkę zamówienia z Allegro (gabaryt, wymiary, waga, pobranie,
problemy) i pokazuje ją na karcie zamówienia w bloku „Przesyłka (podgląd, nic nie zostało nadane)”. **Żadna przesyłka
nie powstaje.**

## Co robi

- **Podgląd na karcie zamówienia** (`lib/wysylka/podglad.ts` → `lib/wysylka/allegro.ts`): reguła przewoźnika
  z modułem `WYSYLAM_Z_ALLEGRO` (adapter `allegro.wysylam.v1`) liczy przesyłkę czystą funkcją, bez sieci, bez kluczy i
  bez nowego zakresu OAuth. Wynik trafia do `PreparedShipment` z `adapterKey = allegro.wysylam.v1`.
  - gabaryt Allegro A/B/C → 8×38×64, 19×38×64, 41×38×64 cm (wartości robocze przyjęte za paczkomatami, zawsze
    z ostrzeżeniem `wymiary_domyslne`, panel dopisuje „(robocze, do potwierdzenia)”); inny gabaryt = błąd `gabaryt`;
  - waga ze składu albo domyślna (`defaultWeightKg` w konfiguracji **reguły przewoźnika**), limit 25 kg (do
    potwierdzenia). Pole `defaultWeightKg` w konfiguracji **konta Allegro** działa tylko w `prepareShipment` instancji
    adaptera (test i przyszłe nadanie); karta zamówienia go nie czyta, więc wagę domyślną dla podglądu wpisuje się
    w regule przewoźnika;
  - pobranie jak w Base Courier (`kwotaPobrania`), przy kwocie ostrzeżenie `pobranie_konto` (Allegro może wymagać
    właściciela i numeru konta do wypłaty);
  - kod kuriera i punkt odbioru puste bez problemu: metodę dostawy i punkt Allegro bierze z zamówienia.
- **Test zakresu przesyłek**: `npm run cien -- allegro-wysylam-test [--konto <id>]`: jedno
  `GET /shipment-management/shipments/00000000-0000-4000-8000-000000000000`; 404 albo 200 = zakres działa,
  403 = brak zakresu (komunikat podaje, którego). Wynik bez tokenów.
- **Odczyt propozycji dostawy** (`readDeliveryOptions`, `GET /shipment-management/delivery-proposals/{orderId}`):
  parser przepisuje polami tylko `deliveryType`, `packageType` i `limits` (kwoty, wymiary, waga); `suggestedInput`
  (nadawca i odbiorca, czyli dane osobowe) odrzuca w całości. Nic z tego nie idzie do bazy, logów ani alertów.
  Metoda **nie jest podpięta do panelu**: specyfikacja wymaga do niej zakresu `allegro:api:shipments:write`.
- **Treść komendy `create-commands`** (`lib/wysylka/zlecenie-allegro.ts`, `buildCreateCommandPayload`): nadpisuje
  w `suggestedInput` tylko `packages` i `cashOnDelivery`, pomija przestarzałe `deliveryMethodId` i `credentialsId`.
  Używają jej wyłącznie testy z danymi fikcyjnymi i przyszły tryb PRACA; nic jej wyniku nie zapisuje ani nie wysyła.
- **Wymiary do limitu metody dostawy** (`dopasujWymiaryDoLimitu`): przy nadaniu robocze wymiary gabarytu (tylko
  z ostrzeżeniem `wymiary_domyslne`) są przycinane do `limits.dimensions` opcji PACKAGE z `delivery-proposals`
  (metody zagraniczne mają mniejsze skrytki). Kilka opcji z różnymi skrytkami = bez przycięcia (opcja nie ma
  identyfikatora metody). Po przycięciu wynik nadania niesie informację „Wymiary przycięte … paczka musi się zmieścić
  w … cm”; potwierdzenia przed wysłaniem nie ma (ostrzeżenia zbiera host bez propozycji Allegro). Odmowa
  `DIMENSIONS_VALIDATION_ERROR` pokazuje wysłane wymiary i limit (albo: nie podało / nieczytelny / niejednoznaczny).
- **Telefon z prefiksem kraju** (wymóg Allegro od 01.10.2026): przed wysłaniem komendy
  `create-commands` (tryb nadawania, `allegro.wysylam.zapis.v1`) telefon nadawcy i odbiorcy przechodzi przez wspólny
  odczyt `lib/wysylka/telefon.ts` do postaci „+48600100200”. Numer polski bez prefiksu (np. „600 100 200”) dostaje
  +48 tylko wtedy, gdy kraj tej osoby to PL albo kraju brak; przy innym kraju (np. CZ, SK, HU, też 9 cyfr) numer bez
  „+” albo „00” to błąd „dodaj prefiks kraju”, nie cichy +48. Numer zagraniczny z „+” albo „00” zostaje ze swoim
  prefiksem. Pusty telefon zostaje bez zmian (rozstrzyga Allegro), ale telefon złożony z samych separatorów
  (np. „-”) to błąd „nieczytelny”. Numer nieczytelny albo zagraniczny bez prefiksu
  kończy się błędem „telefon odbiorcy (nadawcy) nieczytelny albo bez prefiksu kraju” bez wysyłki do Allegro: popraw
  telefon w karcie zamówienia (odbiorca) albo w danych nadawcy na koncie Allegro, z których Allegro buduje
  propozycję dostawy (nadawca), i kliknij ponownie. Zamówienie odbioru
  przez kuriera (`pickups/create-commands`) używa tego samego odczytu dla telefonu nadawcy.
- **Zamawianie kuriera** (`allegro.wysylam.zapis.v1`, zdolność `shipment.pickup`, włącznik „Zamawianie kuriera
  z Kompletora” na karcie „Wysyłam z Allegro”, domyślnie wyłączony): przycisk „Zamów kuriera” w kolejce pakowania
  zamawia odbiór przesyłek z numerem nadania na koncie Allegro tych przesyłek. Adapter czyta przewoźnika każdej
  przesyłki (`GET /shipment-management/shipments/{id}`) i bierze tylko przesyłki przewoźnika z pola „Przewoźnik odbioru”
  (puste = `ALLEGRO`, Allegro One), potem terminy z `POST /shipment-management/pickup-proposals` (tylko podpowiedź),
  komendę `POST /shipment-management/pickups/create-commands` z deterministycznym `commandId` i odczyt wyniku
  `GET .../create-commands/{commandId}`. Brak wyniku po wysłaniu = „nie wiadomo, sprawdź w Allegro”, bez ponawiania.
  Adres odbioru z danych nadawcy firmy. Anulowania odbioru w API Allegro nie ma. Przesyłki na kilku kontach Allegro
  naraz: odmowa z powodem. Zakresy: te same co nadawanie (`shipments:read`, `shipments:write`).

## Czego nie robi

- nie tworzy, nie anuluje i nie odbiera przesyłek, nie pobiera etykiet ani protokołów: strażnik
  `assertAllegroWysylamReadOnly` (`lib/zrodla/allegro-wysylam.ts`) przepuszcza wyłącznie GET
  `/shipment-management/delivery-proposals/{uuid}`, `/shipment-management/shipments/{uuid}` i
  `/order/carriers/{carrier}/tracking` z samym parametrem `waybill`; `create-commands`,
  `cancel-commands`, `pickups`, `pickup-proposals`, `label`, `protocol`, `delivery-services` (przestarzałe, usunięcie
  w I kw. 2027), ścieżki z `..` albo z zapytaniem kończą się `ReadOnlyViolation` przed wysyłką;
- nie zna punktu odbioru ani adresu odbiorcy (system nie przechowuje adresów klientów);
- blok na karcie zamówienia nie czyta `delivery-proposals` i nie woła Allegro.

Śledzenie (wersja z nadawaniem, po włączeniu w Ustawienia → Wysyłka i druk → Przewoźnicy → „Automatyczne statusy wysyłki” → „Których
przewoźników pytać o paczki”): szczegóły przesyłki (`carrier`, `packages[].waybill`), potem
`GET /order/carriers/{carrierId}/tracking?waybill=…` (zakres odczytu zamówień). Statusy `IN_TRANSIT`,
`RELEASED_FOR_DELIVERY`, `AVAILABLE_FOR_PICKUP`, `NOTICE_LEFT`, `DELIVERED`, `RETURNED` = paczka u przewoźnika;
`PENDING` albo brak historii = przed nadaniem; przesyłki nie ma (404) = anulowana, koniec sprawdzania; historii nie ma
(404 przy śledzeniu, np. przewoźnik bez historii w Allegro) = stan nieznany, sprawdzanie trwa (niepotwierdzone na sandboksie).

## Tokeny i zakresy

Adapter używa **tej samej pary tokenów co `allegro.v1`** na tym samym koncie (refresh token Allegro jest jednorazowy,
druga para by się gryzła). Odświeżenie idzie przez `AllegroTokens` i rotację pod blokadą konta
(`rotateAccountSecrets`): dwa adaptery z wygasłym tokenem robią jedno odświeżenie. Integracja ma rodzaj `carrier`,
id `ALLEGRO/<konto>` (`lib/wysylka/allegro-konto.ts`, `createWysylamAdapter`).

| Zakres | Po co | Kto prosi |
|---|---|---|
| `allegro:api:orders:read` | dziennik zamówień (`allegro.v1`) | `allegro-autoryzuj` (bez zmian) |
| `allegro:api:shipments:read` | `GET shipments/{id}`, test zakresu przesyłek | `allegro-autoryzuj --z-przesylkami` |
| `allegro:api:shipments:write` | `delivery-proposals`, tworzenie i anulowanie przesyłek, etykieta (`allegro.wysylam.zapis.v1`) | funkcja „Nadawanie Wysyłam z Allegro” w autoryzacji konta (`lib/zrodla/allegro-zakresy.ts`) |

## Kroki właściciela konta

1. Podgląd przesyłek Allegro działa od razu, bez nowej autoryzacji: Zamówienia → zamówienie z Allegro → sekcja
   „Przesyłka” → „Policz przesyłkę” (uprawnienie `pakowanie.stanowisko`).
2. (Opcjonalnie) odczyt przesyłek: `npm run cien -- allegro-autoryzuj --z-przesylkami [--konto <id>]`, otworzyć link,
   zatwierdzić „odczyt zamówień i odczyt przesyłek”. Komenda zapisuje nową parę (zastępuje dotychczasową, ta sama
   para dla obu adapterów) i od razu robi oba testy połączenia.
3. Sprawdzenie: `npm run cien -- allegro-wysylam-test [--konto <id>]` → `OK: zakres przesyłek działa`.
4. Zakres zapisu przesyłek (`shipments:write`) to osobna decyzja: bez niego `delivery-proposals` odpowiada 403, a tryb
   PRACA (tworzenie przesyłek) nie istnieje.

## Niepewne pola (do potwierdzenia na żywo po autoryzacji)

W kodzie oznaczone komentarzem „NIEPEWNE” albo „DO POTWIERDZENIA”.

- Czy `value` (wymiary, waga) i `amount` przychodzą liczbą czy tekstem: przykłady w specyfikacji są niespójne. Parser
  przyjmuje oba; komenda wysyła liczbę dla `value` i tekst `\d+.\d{2}` dla `cashOnDelivery.amount`.
- Dokładny kształt `additionalServices` (raz pole `sendingAtPoint`, raz tekst w tablicy; dotyczy InPost): parser go
  pomija, komenda przepisuje go z `suggestedInput` bez zmian.
- Czy `GET shipments/{id}` z nieistniejącym UUID daje 404 przy samym zakresie `shipments:read` (test zakłada 404 albo
  200 = zakres działa, 403 = brak zakresu).
- Wymiary gabarytów Allegro A/B/C dla naszych metod dostawy i limit wagi (dziś robocze 8/19/41×38×64 cm, 25 kg):
  potwierdzić z `limits.dimensions` i `limits.weight` z `delivery-proposals`.
- Czy `allegro:api:orders:read` nadal otwiera któryś z tych zasobów (wpis Allegro z 23.08.2023 nazywa zakresy
  przesyłek alternatywą, obecna specyfikacja wymienia tylko zakresy przesyłek).
- `cashOnDelivery.ownerName` i `iban`: przewodnik je wymienia, specyfikacja nie; komenda bierze je z `suggestedInput`.
- Jednostki inne niż `CENTIMETER` i `KILOGRAMS` (parser zna też `MILLIMETER`, `METER`, `GRAMS`; inna = błąd odczytu).
