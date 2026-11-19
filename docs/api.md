# API Kompletora dla systemów zewnętrznych

API pod `/api/v1/` jest dla systemów firmy, które czytają stany i zamówienia albo dodają zamówienia: na przykład sklep
hurtowy (odczyt stanów), platforma sprzedaży e-booków z fizycznym dodatkiem (dodawanie zamówień) i chatbot obsługi
klienta (statusy i numery nadania). Firma przechodząca z BaseLinkera przepina tu systemy, które dziś łączą się z BL. Każdy
klucz należy do jednej firmy i widzi wyłącznie jej dane (RLS w Postgresie).

**API nie udostępnia danych osobowych klientów** (adresów, e-maili, telefonów, imion). Kompletor przechowuje
je zaszyfrowane i pokazuje w panelu wg uprawnień (`docs/dane-klienta.md`), ale klucz API ich nie dostaje. Odpowiedzi ich
nie mają, a zapis je odrzuca. Jedyny wyjątek to osobny klucz obsługi klienta (zakres `obsluga:odczyt`, sekcja
„Obsługa klienta” na końcu): przyjmuje e-mail albo telefon klienta w treści zapytania i odpowiada listą jego zamówień,
ale też bez adresu, imienia, e-maila, telefonu i NIP-u w odpowiedzi; każde zapytanie trafia do dziennika podglądów.

Przykłady niżej mają fikcyjne dane: adres `https://kompletor.example.invalid`, klucz `kmp_PRZYKLADOWY_KLUCZ` (celowo w złym formacie, żeby skanery sekretów go nie zgłaszały), SKU `TEST-*`.

## Klucz API

1. Panel → **Ustawienia → Integracje i agenci AI → Klucze API** (`/ustawienia/klucze-api`, uprawnienie „Ustawienia firmy”).
2. Nazwa (np. „Chatbot sklepu”) i zakresy: tylko te, których system potrzebuje. Osobny klucz dla każdego systemu.
3. **Pełny klucz widać jeden raz**, zaraz po utworzeniu: skopiuj go i wpisz w konfiguracji systemu. W bazie zostaje
   wyłącznie skrót SHA-256 i początek (`kmp_` + 8 znaków) do rozpoznania na liście.
4. Klucz, który wyciekł albo nie jest potrzebny: **Odwołaj**. Od tej chwili każde żądanie z nim dostaje 401.

Klucz wysyła się w nagłówku:

```
Authorization: Bearer kmp_<43 znaki>
```

Bez sesji panelu i bez hasła Basic Auth stagingu: bramką `/api/v1/` jest wyłącznie klucz.

### Zakresy

| Zakres | Co daje |
|---|---|
| `stany:odczyt` | `GET /api/v1/stany` |
| `zamowienia:odczyt` | `GET /api/v1/zamowienia`, `GET /api/v1/zamowienia/<numer>` |
| `zamowienia:zapis` | `POST /api/v1/zamowienia`: kształt ogólny (pole `kanal`: zamówienia ręczne i hurtowe, EasyTools z klientem) albo dawny kształt EasyTools |
| `obsluga:odczyt` | wyłącznie `POST /api/v1/obsluga/zamowienia-klienta` i `POST /api/v1/obsluga/zamowienie` (chatbot obsługi klienta); klucz z tym zakresem nie może mieć innych zakresów i dostaje 403 na każdej innej trasie |

### Limity

- 120 żądań na minutę na klucz; powyżej `429` z nagłówkiem `Retry-After` (sekundy).
- 30 nieudanych prób (zły albo odwołany klucz) w 10 minut z jednego adresu IP = `429` dla kolejnych żądań BEZ ważnego
  klucza z tego adresu do końca okna. Żądania z ważnym kluczem z tego samego adresu przechodzą normalnie, więc kilka
  systemów za jednym adresem (biuro, serwer) nie odcina się nawzajem, gdy jeden z nich ma stary klucz po rotacji.
- Bez nagłówka `X-Forwarded-For` (instalacja bez odwrotnego proxy) adresu nie da się rozpoznać i blokady po nieudanych
  próbach nie ma; zostaje limit na klucz.
- Limity są w pamięci procesu: przy kilku instancjach panelu liczą się na instancję.

## Kody odpowiedzi

Każda odpowiedź to JSON z `Cache-Control: no-store`. Błąd: `{ "error": "<opis po polsku>", ... }`, czasem z polem
`pole` (miejsce błędu w treści albo parametrze) i listą (`nieznane`, `bezStanu`).

| Kod | Kiedy |
|---|---|
| 200 | odczyt; `POST` powtórzony z tą samą treścią (`outcome: DUPLIKAT`) |
| 201 | `POST`: nowe zamówienie (`outcome: NOWE`) |
| 400 | zły parametr, nieznane pole, pole adresowe lub kontaktowe, zły JSON |
| 401 | brak klucza, zły, odwołany albo firma nieaktywna (zawsze ta sama odpowiedź) |
| 403 | klucz bez potrzebnego zakresu |
| 404 | `GET /zamowienia/<numer>`: brak zamówienia o tym numerze |
| 409 | `POST`: zamówienie o tym `numer` już jest, a treść jest inna; nic się nie zmienia, w odpowiedzi `id` i `status` istniejącego |
| 413 | treść `POST` większa niż 64 KB |
| 422 | `POST`: rozjazd `sumaBrutto` z pozycjami (kształt ogólny), przewoźnik spoza reguł firmy, instalacja bez klucza danych klientów przy zamówieniu z klientem, nieznany SKU (lista w `nieznane`), produkt bez stanu (e-book, lista w `bezStanu`), firma bez aktywnego konta EasyTools, odmowa rdzenia |
| 429 | limit żądań albo nieudanych prób (`Retry-After`) |
| 500 | błąd serwera, bez szczegółów |

## GET /api/v1/stany

Zakres `stany:odczyt`. Jeden z dwóch sposobów:

- `?sku=TEST-A,TEST-B`: do 200 SKU; SKU spoza katalogu w `nieznaneSku`.
- `?kanal=WOO&konto=sklep2&strona=1`: produkty z aktywną ofertą konta kanału (np. drugi sklep Woo), po 200 na
  stronę, kolejność po SKU; `nastepnaStrona` = numer kolejnej albo `null`.

Pozycja:

| Pole | Opis |
|---|---|
| `sku`, `nazwa` | SKU i nazwa produktu w Kompletorze |
| `rodzaj` | `STOCKED` (towar), `BUNDLE` (zestaw), `DIGITAL` (bez stanu, np. e-book) |
| `jednostka` | `SZT` albo `KG` (ilości w gramach) |
| `fizycznie`, `zarezerwowane` | stan magazynu głównego; dla zestawu `null` (zestaw nie ma własnego stanu) |
| `dostepne` | fizycznie − zarezerwowane, nigdy poniżej 0; zestaw: minimum po składnikach (dostępne składnika / sztuk w zestawie) |
| `bezStanu` | `true` dla `DIGITAL`: wtedy bez `fizycznie`, `zarezerwowane`, `dostepne` |
| `oferty[]` | aktywne oferty produktu: `kanal`, `konto`, `externalId` (Woo: id produktu albo `<id>/<wariant>`), `sztukNaOferte` |

Przykład: sklep hurtowy na WooCommerce (id produktu Woo → SKU, stan) czyta wszystkie strony swojego konta, np. `WOO/hurt`, i paruje `oferty[].externalId`
z id produktu sklepu. Stan na sklepie to `dostepne / sztukNaOferte` (zaokrąglone w dół).

```
curl -s https://kompletor.example.invalid/api/v1/stany?sku=TEST-PRZYPRAWA,TEST-ZESTAW \
  -H "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ"
```

```json
{
  "pozycje": [
    { "sku": "TEST-PRZYPRAWA", "nazwa": "Przyprawa testowa", "rodzaj": "STOCKED", "jednostka": "SZT",
      "fizycznie": 10, "zarezerwowane": 2, "dostepne": 8,
      "oferty": [{ "kanal": "WOO", "konto": "sklep2", "externalId": "501", "sztukNaOferte": 1 }] },
    { "sku": "TEST-ZESTAW", "nazwa": "Zestaw testowy", "rodzaj": "BUNDLE", "jednostka": "SZT",
      "fizycznie": null, "zarezerwowane": null, "dostepne": 3, "oferty": [] }
  ],
  "nieznaneSku": []
}
```

```
curl -s "https://kompletor.example.invalid/api/v1/stany?kanal=WOO&konto=sklep2&strona=2" \
  -H "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ"
```

## GET /api/v1/zamowienia

Zakres `zamowienia:odczyt`. Zamówienia zmienione od podanej chwili, rosnąco po czasie zmiany.

| Parametr | Opis |
|---|---|
| `zmienione_od` | data ISO 8601 (np. `2026-11-01T00:00:00Z`), najwyżej 14 dni wstecz; brak = 14 dni wstecz |
| `limit` | 1–200, domyślnie 100 |
| `po` | kursor `nastepny` z poprzedniej odpowiedzi |

Odpowiedź: `{ "zamowienia": [...], "nastepny": "<kursor>" | null }`. Kursor to (czas zmiany, id) ostatniej pozycji:
stabilny przy wielu zamówieniach zmienionych w tej samej chwili. Zamówienie zmienione w trakcie pobierania przesuwa się
na koniec i wraca w dalszej stronie albo w kolejnym pobraniu: odbiorca nadpisuje je po (`kanal`, `konto`, `numer`).

Przykład: chatbot obsługi klienta co 10 minut: pierwsze wywołanie z `zmienione_od` = teraz − 14 dni, potem kolejne strony po `po`, aż
`nastepny` = `null`; następny cykl od czasu `zmieniono` ostatniego odebranego zamówienia (z zapasem kilku sekund).

**Stan paczki bierz z odczytu po numerze, nie z listy.** `zmieniono` to chwila ostatniej zmiany samego zamówienia
(status, płatność, pozycje, dane z kanału). Zmiana na przesyłce jej nie przesuwa: nowy stan drogi paczki (np. „W drodze”,
„Doręczona”, „Zwrot do nadawcy”), nowy odczyt u przewoźnika ani utworzenie przesyłki czy pobranie numeru nadania, gdy
status zamówienia się przy tym nie zmienia. Lista oddaje więc `przesylki[]` z chwili ostatniej zmiany zamówienia, a
zamówienie wraca na listę dopiero przy zmianie statusu (np. „Do wysłania” po utworzeniu przesyłki spakowanego
zamówienia, „Wysłane”, „Odebrane”, gdy firma ma włączone „Doręczona paczka = Odebrane”). Aktualny stan paczki daje
`GET /api/v1/zamowienia/<numer>` (niżej) albo narzędzie MCP `zamowienie_szczegoly`: przy pytaniu klienta „gdzie jest
paczka” pytaj po numerze w tej chwili, a listę traktuj jako sygnał, które zamówienia się zmieniły.

Zamówienie: wyłącznie te pola (lista jawna, test pilnuje, że nie ma innych):

| Pole | Opis |
|---|---|
| `kanal`, `konto` | kanał (`WOO`, `ALLEGRO`, `EMPIK`, `EASYTOOLS`, `BL_INNE`, `RECZNE`) i konto kanału (np. `sklep1`) |
| `numer` | numer zamówienia w kanale (sklep, Allegro, EasyTools) |
| `numerBl` | numer zamówienia w BaseLinkerze albo `null` |
| `status`, `statusNazwa` | status Kompletora (np. `WYSLANE`) i jego nazwa („Wysłane”) |
| `przewoznik` | `PACZKOMATY`, `DPD`, `DPD_EMPIK`, `ALLEGRO`, `OSOBISTY`, `BRAK`, `BEZ_WYSYLKI` albo `null` |
| `sposobDostawy` | sposób dostawy z kanału (tekst) |
| `platnosc`, `platnoscMetoda` | `PAID` / `UNPAID` / `COD` / `PARTIAL` i metoda (tekst z kanału) |
| `sumaBrutto` | kwota zamówienia (liczba, 2 miejsca) |
| `zlozono`, `zmieniono` | ISO 8601 UTC |
| `numerNadania` | numer przesyłki z ostatniego przejścia statusu z numerem nadania albo `null` |
| `przesylkaStatusKod` | ostatni stan paczki u przewoźnika: `PRZED_NADANIEM` / `PRZEKAZANA` / `DORECZONA` / `NIEZNANY` albo `null` (brak odczytu) |
| `przesylkaStatus` | stały tekst do tego stanu: „Etykieta utworzona, paczka czeka na kuriera” / „U przewoźnika, w drodze” / „Doręczona” / „Status nierozpoznany” albo `null`; opis od przewoźnika (może zawierać dane odbiorcy) API nie oddaje, jest tylko na karcie zamówienia w panelu |
| `przesylkaStatusKiedy` | kiedy Kompletor odczytał ten stan (ISO 8601 UTC) albo `null` |
| `pozycje[]` | `sku`, `nazwa` (`null` dla pozycji niepowiązanej z katalogiem), `ilosc` (jednostka bazowa; zestaw = liczba zestawów), `cenaBrutto` (za sztukę) |
| `przesylki[]` | przesyłki zamówienia utworzone u przewoźnika, od najstarszej, najwyżej 10 (pola niżej); pusta lista = brak przesyłki w Kompletorze; na liście zmienionych zamówień stan z chwili ostatniej zmiany zamówienia (akapit wyżej), aktualny w odczycie po numerze |

Przesyłka (`przesylki[]`), wyłącznie te pola:

| Pole | Opis |
|---|---|
| `przewoznik` | przewoźnik przesyłki (jak `przewoznik` zamówienia) |
| `numerNadania` | numer przesyłki u przewoźnika albo `null` |
| `stan` | stan drogi paczki: `UTWORZONA`, `PRZEKAZANA`, `W_DRODZE`, `W_DORECZENIU`, `W_PUNKCIE`, `DORECZONA`, `NIEUDANE_DORECZENIE`, `ZWROT`, `PROBLEM`, `ANULOWANA`, `NIEZNANY` albo `null` (Kompletor nie ma jeszcze odczytu u przewoźnika) |
| `stanNazwa` | stan słownie, np. „Wydana do doręczenia” (`null` razem ze `stan`) |
| `stanOd` | od kiedy paczka jest w tym stanie (ISO 8601 UTC) albo `null` |
| `sprawdzono` | ostatni odczyt u przewoźnika (ISO 8601 UTC) albo `null` |
| `sledzona` | `true` = Kompletor dalej odświeża stan (firma ma włączone „Śledź paczki aż do doręczenia”, pyta o paczki tego modułu, a śledzenie tej paczki trwa: przesyłka nie jest anulowana, nie minęło 30 dni od jej utworzenia i Kompletor nie przestał o nią pytać po serii błędów albo po odpowiedzi przewoźnika, że takiej przesyłki nie ma); `false` = stan może być nieaktualny, pewny jest tylko numer. Przy stanie końcowym (`DORECZONA`, `ZWROT`, `ANULOWANA`) pole nie ma znaczenia: ten stan już się nie zmieni |
| `linkSledzenia` | strona śledzenia u przewoźnika albo `null` (przewoźnik bez potwierdzonego adresu albo paczkę nadał pośrednik, np. Wysyłam z Allegro, Base Courier): wtedy podaj klientowi numer i nazwę przewoźnika |
| `rodzaj` | `GLOWNA` = przesyłka zamówienia; `DOSYLKA` (reklamacja, brakujący towar), `ZASTEPCZA` (za zgubioną albo uszkodzoną), `DODATKOWA` (druga paczka) = dodatkowa przesyłka dodana na karcie zamówienia. Powód i koszt dodatkowej nie wychodzą przez API. `numerNadania` zamówienia i numer w sklepie zostają numerem głównej przesyłki |

Opisy zdarzeń przewoźnika (np. kto odebrał paczkę) i historia zdarzeń nie wychodzą przez API. Anulowana przesyłka, której
paczka nie ruszyła, nie jest na liście. `numerNadania` zamówienia zostaje bez zmian (ostatni numer z przejścia statusu).

```
curl -s "https://kompletor.example.invalid/api/v1/zamowienia?zmienione_od=2026-11-01T00:00:00Z&limit=100" \
  -H "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ"
```

```json
{
  "zamowienia": [
    { "kanal": "WOO", "konto": "sklep1", "numer": "900123", "numerBl": 81000001,
      "status": "WYSLANE", "statusNazwa": "Wysłane", "przewoznik": "PACZKOMATY",
      "sposobDostawy": "Paczkomaty InPost", "platnosc": "PAID", "platnoscMetoda": "BLIK",
      "sumaBrutto": 89.9, "zlozono": "2026-11-01T08:12:00.000Z", "zmieniono": "2026-11-01T14:03:11.250Z",
      "numerNadania": "TESTNADANIE0001",
      "pozycje": [{ "sku": "TEST-PRZYPRAWA", "nazwa": "Przyprawa testowa", "ilosc": 2, "cenaBrutto": 39.95 }],
      "przesylki": [{ "przewoznik": "PACZKOMATY", "numerNadania": "TESTNADANIE0001", "stan": "W_DRODZE",
        "stanNazwa": "W drodze", "stanOd": "2026-11-01T16:40:00.000Z", "sprawdzono": "2026-11-01T18:00:00.000Z",
        "sledzona": true, "linkSledzenia": "https://inpost.pl/sledzenie-przesylek?number=TESTNADANIE0001" }] }
  ],
  "nastepny": null
}
```

## GET /api/v1/zamowienia/&lt;numer&gt;

Zakres `zamowienia:odczyt`. `<numer>` = numer zamówienia w kanale albo numer BL. Ten sam numer w kilku kontach (np. dwa
sklepy Woo) = wszystkie trafienia; `?kanal=WOO&konto=sklep1` zawęża. Odpowiedź `{ "zamowienia": [...] }` z polami jak
w liście; brak = 404. Numer ze znakiem `/` trzeba zakodować (`%2F`).

```
curl -s "https://kompletor.example.invalid/api/v1/zamowienia/900123?kanal=WOO&konto=sklep1" \
  -H "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ"
```

## POST /api/v1/zamowienia (EasyTools)

Zakres `zamowienia:zapis`. Tylko kanał EasyTools (konto kanału `EASYTOOLS` firmy, np. `moja-firma`) i tylko produkty
z katalogu Kompletora: fizyczne dodatki (np. zestaw startowy, próbki). **E-book nigdy nie trafia do
logistyki**: pozycja z produktem bez stanu = 422. Treść JSON do 64 KB, schemat ścisły: nieznane pole = 400.

| Pole | Wymagane | Opis |
|---|---|---|
| `numer` | tak | numer zamówienia EasyTools (litery, cyfry, `.`, `_`, `/`, `-`, do 64 znaków) |
| `zlozono` | tak | ISO 8601 ze strefą, np. `2026-11-02T09:00:00Z` |
| `platnosc` | tak | `PAID`, `UNPAID` albo `COD` |
| `platnoscMetoda` | tak | tekst, np. `Przelewy24` |
| `sumaBrutto` | tak | liczba, do 2 miejsc |
| `sposobDostawy` | tak | tekst; przewoźnika wybierają reguły firmy (niżej), bez trafienia zamówienie idzie do „Do wyjaśnienia” |
| `chceFakture` | nie | `true` = faktura na firmę (domyślnie `false`) |
| `pozycje[]` | tak | 1–100: `sku` **albo** `produktId`, `ilosc` (liczba całkowita, jednostka bazowa), `cenaBrutto` (za sztukę), `vat` (opcjonalnie, np. `"23"`) |

Pola adresowe i kontaktowe (`email`, `telefon`, `phone`, `imie`, `nazwisko`, `adres`, `delivery_*`, `invoice_*` i
podobne) są odrzucane z komunikatem 400: API ich nie przyjmuje. Dane klienta (od 03.11.2026) Kompletor
bierze z kanału sprzedaży i trzyma zaszyfrowane (`docs/dane-klienta.md`), nie z API.

Zamówienie wchodzi do rdzenia tą samą drogą co zamówienia z kanałów (`ingestOrder`): rezerwacja stanu, „brakuje”,
przewoźnik z reguł firmy. **Idempotencja**: powtórzony `POST` z tą samą treścią (kolejność pól bez znaczenia) zwraca
to samo zamówienie z kodem 200 i `outcome: DUPLIKAT`; pierwszy zwraca 201 i `NOWE`. **API nie zmienia przyjętych
zamówień**: ten sam `numer` z inną treścią (inne pozycje, ilości, płatność `UNPAID` → `PAID`) = `409` z `id` i
`status` istniejącego zamówienia, bez żadnej zmiany. Zamówienie mogło już trafić do pakowania, więc zmiany robi obsługa
w panelu Kompletora. Wysyłaj zamówienie dopiero opłacone (albo za pobraniem, `COD`).

**Sposób dostawy a przewoźnik.** `sposobDostawy` dopasowują reguły przewoźników firmy (tabela reguł w konfiguracji firmy, bez ekranu w panelu),
pierwsza pasująca wygrywa, wielkość liter bez znaczenia. Przykładowe reguły (wzorce to wyrażenia regularne):

| Wzorzec w `sposobDostawy` | Przewoźnik |
|---|---|
| `paczkomat` | Paczkomaty InPost |
| `salon empik` / `salonu empik` | DPD do salonu Empik |
| `dpd` albo `kurier` | DPD |
| `osobist` | odbiór osobisty |

Bez trafienia zamówienie i tak powstaje (201), ale ze `status: DO_WYJASNIENIA` (powód „nieznana metoda dostawy: …”)
i nie pójdzie do pakowania, dopóki obsługa go nie wyjaśni. Integrator sprawdza `status` w odpowiedzi i wysyła tekst,
który pasuje do reguł (np. „Paczkomat InPost”, „Kurier DPD”).

Odpowiedź: `id` (id zamówienia w Kompletorze), `status`, `outcome`, `zarezerwowano` i `brakuje` (sztuki w jednostce
bazowej, zestaw liczony w składnikach).

```
curl -s -X POST https://kompletor.example.invalid/api/v1/zamowienia \
  -H "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ" \
  -H "Content-Type: application/json" \
  -d '{
    "numer": "ET-TEST-1001",
    "zlozono": "2026-11-02T09:00:00Z",
    "platnosc": "PAID",
    "platnoscMetoda": "Przelewy24",
    "sumaBrutto": 59.90,
    "sposobDostawy": "Paczkomat InPost",
    "chceFakture": false,
    "pozycje": [{ "sku": "TEST-ZESTAW-START", "ilosc": 1, "cenaBrutto": 59.90, "vat": "23" }]
  }'
```

```json
{ "id": "cmh0testowe0000000000000", "status": "DO_REALIZACJI", "outcome": "NOWE", "zarezerwowano": 1, "brakuje": 0 }
```

Błędy:

```json
{ "error": "Nieznane produkty (spoza katalogu firmy)", "pole": "pozycje", "nieznane": ["TEST-NIEMA"] }
{ "error": "Produkty bez stanu (e-book) nie trafiają do logistyki — usuń je z zamówienia", "pole": "pozycje", "bezStanu": ["TEST-EBOOK"] }
{ "error": "Pole email odrzucone: API nie przyjmuje adresów ani danych kontaktowych klientów (…). …", "pole": "email" }
```

## POST /api/v1/zamowienia (kształt ogólny)

Zakres `zamowienia:zapis`. Treść z polem `kanal` to zamówienie w kształcie ogólnym; bez `kanal` trasa przyjmuje
kształt EasyTools opisany wyżej (bez zmian). Ta sama funkcja zapisuje zamówienia z formularza **Zamówienia → Dodaj
zamówienie** w panelu. Treść JSON do 64 KB, schemat ścisły: nieznane pole = 400.

| Pole | Wymagane | Opis |
|---|---|---|
| `kanal` | tak | `RECZNE` (zamówienie ręczne, hurtowe, telefoniczne) albo `EASYTOOLS` |
| `konto` | nie | konto kanału. `RECZNE`: konto musi być w trybie PRACA (zamówień ręcznych nie prowadzi BaseLinker; konto w cieniu = 422); bez wskazania `reczne`, gdy jest w PRACY, inaczej jedyne konto RECZNE w PRACY, a przy braku Kompletor zakłada `reczne` („Zamówienia ręczne”, tryb PRACA). Kilka kont w PRACY bez `reczne` i bez wskazania = 422 z listą `konta`. `EASYTOOLS`: jedyne aktywne konto albo wskazane |
| `numer` | tak | numer zamówienia w systemie wysyłającym (litery, cyfry, `.`, `_`, `/`, `-`, do 64 znaków); klucz idempotencji |
| `zrodlo` | nie | źródło słowami, do 80 znaków (np. `Hurt`, `Telefon`); widać je w nagłówku karty |
| `zlozono` | nie | ISO 8601 ze strefą; brak = chwila przyjęcia (poza kluczem idempotencji, więc powtórka bez daty to dalej DUPLIKAT). Termin zwolnienia nieopłaconego (`UNPAID`) liczy się od tej daty: zamówienie z odległą przeszłością może zostać zwolnione przy najbliższym przebiegu |
| `platnosc` | tak | `PAID` (opłacone), `UNPAID` (do zapłaty, np. przelewem: rezerwacja z terminem jak w sklepie), `COD` (za pobraniem) |
| `platnoscMetoda` | nie | tekst; domyślnie „Opłacone”, „Przelew” albo „Za pobraniem” |
| `sumaBrutto` | nie | brak = suma pozycji i kosztu dostawy; podana może się różnić od policzonej najwyżej o zaokrąglenia ceny za sztukę (pół grosza na sztukę, co najmniej 1 grosz na pozycję, ale nie więcej niż 0,5% sumy, najmniej 1 zł), inaczej 422 z polem `policzona` |
| `dostawa.sposob` | tak | sposób dostawy słowami; przewoźnika dopasowują reguły firmy jak w kształcie EasyTools |
| `dostawa.przewoznik` | nie | przewoźnik wprost zamiast dopasowania: `PACZKOMATY`, `DPD`, `DPD_EMPIK`, `ALLEGRO`, `OSOBISTY`; musi być w regułach przewoźników firmy (inaczej 422) |
| `dostawa.punkt` | nie | punkt odbioru `{ kod, nazwa? }` (np. paczkomat); zapisuje się z danymi klienta, więc wymaga `klient` |
| `dostawa.koszt` | nie | koszt wysyłki brutto |
| `klient` | nie | `imieNazwisko` albo `firma` (co najmniej jedno), `email`, `telefon`, `adres` `{ ulica, numerDomu?, numerLokalu?, kodPocztowy, miasto, kraj? }`, `faktura` `{ nazwa, nip?, ulica?, kodPocztowy?, miasto? }` |
| `uwagi` | nie | uwagi klienta (do 1000 znaków), zapisują się z danymi klienta |
| `chceFakture` | nie | faktura na firmę; domyślnie `true`, gdy `klient.faktura.nip` jest podany; `true` bez `klient.faktura` = 400 |
| `pozycje[]` | tak | 1–100, tylko aktywne produkty z katalogu (wycofany = 422 z listą `nieaktywne`): `sku` **albo** `produktId`, `ilosc`, `cenaBrutto` (za sztukę), `vat` (opcjonalnie), jak w kształcie EasyTools |

**Dane klienta** sprawdzane są tymi samymi regułami co formularz „Wpisz dane klienta” na karcie: kod pocztowy PL
`NN-NNN`, e-mail, telefon co najmniej 9 cyfr, NIP z sumą kontrolną; komunikat błędu podaje pole, nigdy wartość.
Zapisują się zaszyfrowane (`OrderCustomer`, źródło „wpisane ręcznie”, automat kanału ich nie nadpisuje). Pole z
danymi klienta poza obiektem `klient` (np. `email` na wierzchu) = 400 z podpowiedzią. Instalacja bez kluczy
`CUSTOMER_DATA_KEYS` i `CUSTOMER_LOOKUP_KEY` odrzuca zamówienie z klientem (422) **przed** jego utworzeniem; bez
`klient` zamówienie przechodzi.

**Idempotencja** jak w kształcie EasyTools (klucz obejmuje konto, więc ta sama treść na innym koncie to osobne zamówienie): ta sama treść = 200 `DUPLIKAT` z tym samym `id`, ten sam `numer` z inną
treścią = 409 bez zmian. Gdy zamówienie powstało, a zapis klienta się nie udał (np. chwilowy błąd bazy), powtórka tego
samego żądania dopisuje brakujące dane klienta.

Odpowiedź: `id`, `status`, `outcome`, `zarezerwowano`, `brakuje` i `klient` (`ZAPISANO`, `BYLY` przy powtórce, `BRAK`
bez klienta). Zamówienie idzie dalej jak zamówienie z kanału: rezerwacja, „Brakuje”, przyciski „Co dalej” na karcie,
pakowanie, wysyłka.

```
curl -s -X POST https://kompletor.example.invalid/api/v1/zamowienia \
  -H "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ" \
  -H "Content-Type: application/json" \
  -d '{
    "kanal": "RECZNE",
    "numer": "HURT-TEST-5761",
    "zrodlo": "Hurt (sklep hurtowy)",
    "platnosc": "UNPAID",
    "platnoscMetoda": "Przelew 14 dni",
    "dostawa": { "sposob": "Kurier DPD", "przewoznik": "DPD", "koszt": 15.00 },
    "klient": {
      "firma": "Pracownia Testowa sp. z o.o.",
      "email": "zamowienia@example.invalid",
      "telefon": "600 100 200",
      "adres": { "ulica": "Testowa", "numerDomu": "1", "kodPocztowy": "60-001", "miasto": "Poznań" },
      "faktura": { "nazwa": "Pracownia Testowa sp. z o.o.", "nip": "5260250995", "ulica": "Testowa 1", "kodPocztowy": "60-001", "miasto": "Poznań" }
    },
    "pozycje": [{ "sku": "TEST-PRODUKT", "ilosc": 30, "cenaBrutto": 12.30, "vat": "23" }]
  }'
```

```json
{ "id": "cmh0testowe0000000000001", "status": "NOWE", "outcome": "NOWE", "zarezerwowano": 30, "brakuje": 0, "klient": "ZAPISANO" }
```

Kod: `lib/api/zapis-ogolny.ts` (walidacja), `lib/zamowienia/ogolne.ts` (przyjęcie, konto, zapis klienta),
`lib/zamowienia/formularz.ts` (formularz panelu). Testy: `tests/zamowienia-reczne.integration.test.ts`.

### Przepięcie integracji, która dziś woła `addOrder` BaseLinkera

Skrypt albo sklep hurtowy, który dziś zakłada zamówienie w BaseLinkerze przez `addOrder`, po przejściu na Kompletor
wysyła ten sam zestaw danych do `POST /api/v1/zamowienia` w kształcie ogólnym. Odpowiedniki pól:

| BaseLinker `addOrder` | Kompletor (kształt ogólny) |
|---|---|
| `order_status_id` | brak: status liczy Kompletor z płatności i przewoźnika |
| numer zamówienia w systemie źródłowym (np. Woo) | `numer` (np. `HURT-<id Woo>`): powtórka nie zdubluje zamówienia, więc własny plik stanu „co już wysłane” przestaje być potrzebny do ochrony przed dublem |
| źródło „Osobiście/tel.” (domyślne w BL) | `kanal: "RECZNE"`, `zrodlo: "Hurt"` |
| `payment_method`, `paid` (`processing` / `completed` = 1) | `platnoscMetoda`, `platnosc`: `PAID` albo `UNPAID` (`payment_method_cod` = 1 → `COD`) |
| `products[]`: `sku`, `quantity`, `price_brutto`, `tax_rate`, `storage_id` | `pozycje[]`: `sku`, `ilosc`, `cenaBrutto` (2 miejsca), `vat` jako tekst (`"23"`); `storage_id` znika, bo produkty biorą się z katalogu firmy po SKU |
| `delivery_price` | `dostawa.koszt` |
| sposób wysyłki z Woo | `dostawa.sposob` (i opcjonalnie `dostawa.przewoznik`) |
| `delivery_fullname`, `delivery_company`, `delivery_address`, `delivery_postcode`, `delivery_city`, `delivery_country_code` | `klient.imieNazwisko`, `klient.firma`, `klient.adres` (`ulica`, `numerDomu`, `kodPocztowy`, `miasto`, `kraj`) |
| `phone`, `email` | `klient.telefon`, `klient.email` |
| `want_invoice`, `invoice_company`, `invoice_nip`, `invoice_address`, `invoice_postcode`, `invoice_city` | `chceFakture`, `klient.faktura` (`nazwa`, `nip`, `ulica`, `kodPocztowy`, `miasto`) |
| `admin_comments` | brak: notatka wewnętrzna na karcie zamówienia |
| `user_comments` | `uwagi` |
| suma zamówienia w systemie źródłowym (np. `total` z Woo) | `sumaBrutto`: Kompletor sprawdza zgodność z pozycjami i kosztem dostawy (tolerancja zaokrągleń: pół grosza na sztukę) |

Uwagi do przepięcia: (1) ceny brutto za sztukę z 4 miejscami po przecinku trzeba zaokrąglić do 2, a `sumaBrutto`
podać z Woo, wtedy grosze z zaokrągleń mieszczą się w tolerancji (72 sztuki po 8,5609 zł = 616,38 zł w Woo, po zaokrągleniu 72 × 8,56 = 616,32 zł: różnica 6 gr przy tolerancji 36 gr) (przy dużej różnicy 422 pokaże obie liczby);
(2) Woo podaje adres w jednym polu `address_1`, a Kompletor przyjmuje go w `ulica` (numer może zostać w tym samym
tekście, `numerDomu` jest opcjonalny); (3) klucz API z zakresem `zamowienia:zapis` zakłada się w Ustawienia → Integracje i agenci AI →
Klucze API; (4) przed przepięciem jedno zamówienie testowe na stagingu i sprawdzenie karty (pozycje, klient, przewoźnik,
rezerwacja).

### Przepięcie EasyTools: stan i warunek

- Do przepięcia cron EasyTools dalej wpisuje zamówienia do BL i nic się nie zmienia; konto `EASYTOOLS/<firma>` w Kompletorze
  nie jest czytane w trybie „Tylko podgląd” (bez adaptera, poza `withoutAdapter` w `/api/health` i poza porównaniem z BL).
- **Warunek przepięcia (otwarte):** adres wysyłki zamówienia EasyTools: dziś cron bierze go z maila i wpisuje do BL,
  API EasyTools go nie zwraca, a konto EASYTOOLS nie ma odczytu odbiorcy (dane klienta zapisują się tylko
  z kanałów, które go czytają), więc przed przepięciem trzeba ustalić, skąd etykieta przesyłki dostanie adres odbiorcy
  (np. wpis ręczny na karcie zamówienia albo odczyt z EasyTools). Cron może wysłać adres sam: kształt
  ogólny z `kanal: "EASYTOOLS"` i obiektem `klient` (adres z maila), wtedy etykieta bierze dane z zapisanego rekordu.

## Gdzie to jest w kodzie

- `lib/api/klucze.ts`: `requireApiKey` (nagłówek, SHA-256, zakresy, limity, `lastUsedAt`), jedyne miejsce z klientem
  systemowym; `lib/api/zakresy.ts`: lista zakresów.
- `lib/api/zarzadzanie.ts`: tworzenie, lista i odwołanie kluczy (klient firmy, AuditLog bez klucza).
- `lib/api/stany.ts`, `lib/api/zamowienia.ts`, `lib/api/zapis.ts`, `lib/api/zapis-ogolny.ts`: logika endpointów; `app/api/v1/**/route.ts`: trasy.
- `app/(panel)/ustawienia/klucze-api/`: ekran kluczy.
- `proxy.ts`, `lib/basic-auth.ts`: `/api/v1` poza sesją panelu i Basic Auth.
- Testy: `tests/api-v1.integration.test.ts`, `tests/klucze-api-panel.integration.test.ts`, `proxy.test.ts`.

## Rozszerzenie: produkty, statusy, raporty, filtry listy zamówień

Nowe odczyty dla systemów firmy: te same funkcje, z których korzysta serwer MCP dla agentów AI
([docs/mcp.md](mcp.md)). Wszystkie: klucz w `Authorization: Bearer`, dane wyłącznie firmy klucza, `Cache-Control:
no-store`, nieznany parametr = 400 z polem `pole`, bez danych osobowych (odpowiedzi z jawnych list pól).

### Nowe zakresy

| Zakres | Co daje |
| --- | --- |
| `produkty:odczyt` | `GET /api/v1/produkty`, `GET /api/v1/produkty/<sku>` |
| `raporty:odczyt` | `GET /api/v1/raporty/dzien`, `/raporty/braki`, `/raporty/rezerwacje`, `/raporty/sprzedaz` |
| `mcp:odczyt` | serwer MCP `POST /api/mcp` (klucz agenta AI, nie dla tras REST): Ustawienia → Integracje i agenci AI → Agenci AI |

`GET /api/v1/statusy` wymaga istniejącego zakresu `zamowienia:odczyt`.

### `GET /api/v1/produkty`

Katalog po SKU (rosnąco). Parametry: `fraza` (fragment SKU lub nazwy albo pełny EAN), `rodzaj` (`STOCKED`, `BUNDLE`,
`DIGITAL`, po przecinku), `aktywne` (`1` domyślnie, `0`, `wszystkie`), `limit` 1–100 (domyślnie 50), `po` (kursor).

```bash
curl -s -H "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ" "https://kompletor.example.invalid/api/v1/produkty?fraza=herb&limit=2"
```

```json
{ "produkty": [{ "sku": "TEST-PRZYPRAWA", "nazwa": "Przyprawa testowa", "rodzaj": "STOCKED", "jednostka": "SZT", "ean": null, "aktywny": true }], "nastepny": null }
```

Kolejna strona: `?po=<nastepny>` z tymi samymi filtrami.

### `GET /api/v1/produkty/<sku>`

Produkt po dokładnym SKU (zakodowanym w adresie): pola listy + `cenaBrutto` (detaliczna), `progNiskiegoStanu`, `stan`
(`fizycznie`, `zarezerwowane`, `dostepne` jak w `/stany`; zestaw: `fizycznie` i `zarezerwowane` = null; e-book:
`{ "bezStanu": true }`), `oferty` (także wyłączone, z polem `aktywna`), `skladniki` (zestaw), `wZestawach`. Brak = 404.

```json
{ "produkt": { "sku": "TEST-ZESTAW", "nazwa": "Zestaw testowy", "rodzaj": "BUNDLE", "jednostka": "SZT", "ean": null, "aktywny": true, "cenaBrutto": null, "progNiskiegoStanu": null, "stan": { "fizycznie": null, "zarezerwowane": null, "dostepne": 3 }, "oferty": [], "skladniki": [{ "sku": "TEST-PRZYPRAWA", "nazwa": "Przyprawa testowa", "ilosc": 2 }], "wZestawach": [] } }
```

### `GET /api/v1/statusy`

Słownik statusów zamówień i stanów płatności: `{ "statusy": [{ "symbol": "DO_WYJASNIENIA", "nazwa": "Do wyjaśnienia", "opis": "…" }], "platnosci": [{ "symbol": "PAID", "nazwa": "opłacone", "opis": "Opłacone." }] }`.

obok tych pól (bez zmian, zgodnie wstecz) statusy własne firmy i ich grupy, w kolejności panelu:

```json
{
  "statusyFirmy": [
    { "klucz": "DO_REALIZACJI_DPD", "nazwa": "Do realizacji DPD", "nazwaDlaKlienta": null, "kolor": "pomaranczowy", "kolorHex": "#8a4b06",
      "grupa": "DO_REALIZACJI", "bazowy": "DO_REALIZACJI", "przewoznicy": ["DPD", "DPD_EMPIK"], "aktywny": true }
  ],
  "grupyStatusow": [{ "klucz": "DO_REALIZACJI", "nazwa": "Do realizacji" }]
}
```

`bazowy` to `statusy[].symbol`, na którym liczy rdzeń i po którym działa filtr `status` listy zamówień. Status firmy
zamówienia: pierwszy aktywny status z jego `bazowy` i przewoźnikiem z `przewoznicy` (pusta lista = każdy), inaczej
pierwszy aktywny bez przewoźników, inaczej nazwa etapu (`statusy[].nazwa`). Pusta lista `statusyFirmy` = firma używa
nazw etapów. To samo zwraca narzędzie MCP `statusy`. Opis dla użytkownika: `docs/statusy.md`.

### `GET /api/v1/raporty/dzien`

Liczby dzisiejszego dnia (Europe/Warsaw) jak pulpit „Dziś” w panelu, bez parametrów:

```json
{
  "dzien": "2026-11-03",
  "stanNa": "2026-11-03T21:00:00.000Z",
  "sprzedaz": { "zamowien": 12, "brutto": 1234.5, "konta": [{ "konto": "WOO:sd", "nazwa": "Sklep Demo", "zamowien": 8, "brutto": 900 }], "pozaRealizacja": { "przedStartem": 0, "nieprzyjete": 0, "pominiete": 0, "anulowane": 1 } },
  "praca": { "doSpakowania": 5, "brakujePozycji": 1, "zamowienZBrakami": 1, "doWyjasnienia": 0, "nieoplaconeZRezerwacja": 2, "fakturaNieWystawiona": 0, "ruchyDoPoprawyWfirmie": 0, "nadmiaryRezerwacji": 0 },
  "wyslaneDzis": 7
}
```

`wyslaneDzis` = zamówienia z przejściem do „Wysłane” dzisiaj.

### `GET /api/v1/raporty/braki` i `/raporty/rezerwacje`

Parametry: `sku` (lista po przecinku, do 200), `limit` 1–100 produktów (domyślnie 50). Kolejność: najwięcej sztuk
pierwsze. Numery zamówień najwyżej 20 na produkt (`zamowien` = ile wszystkich); `wiecej: true` = są dalsze produkty.

```json
{ "pozycje": [{ "sku": "TEST-KUBEK", "nazwa": "Kubek testowy", "jednostka": "SZT", "brakuje": 2, "dostepne": 0, "zamowien": 1, "zamowienia": [{ "kanal": "WOO", "konto": "sd", "numer": "TEST-0001", "numerBl": null, "status": "NOWE" }] }], "wiecej": false }
```

Rezerwacje: `fizycznie`, `zarezerwowane`, `dostepne` i `zamowienia` z `platnosc`, `ilosc` (sztuki tego produktu) i
`od` (kiedy powstała rezerwacja).

### `GET /api/v1/raporty/sprzedaz`

Sprzedaż w zakresie dat, ten sam kształt co ekran „Raporty” w panelu i narzędzie MCP `raport_sprzedazy`. Parametry
(wszystkie opcjonalne): `od`, `do` (RRRR-MM-DD, czas polski, obie granice włącznie; domyślnie od 1. dnia bieżącego
miesiąca do dziś; najwyżej 366 dni), `grupuj` (`dzien`, `tydzien` od poniedziałku, `miesiac`; domyślnie wg długości
zakresu, najwyżej 120 okresów), `konto` (klucz konta kanału `KANAL:konto`, np. `WOO:sd`, z `konta[].konto`),
`produktow` 1–1000 (domyślnie 50). Nieznany parametr albo zła wartość = 400 z polem `pole`.

```json
{
  "od": "2026-10-01", "do": "2026-10-31", "grupuj": "dzien", "konto": null, "stanNa": "2026-11-09T00:00:00.000Z",
  "razem": { "zamowien": 1500, "wartoscBrutto": 123456.78, "sredniaWartosc": 82.3, "produktyBrutto": 110000, "produktyNetto": 91000.5, "sztuk": 4200, "kg": 12.5, "zwrotyBrutto": 350, "koszt": 40000, "marza": 38000.5, "marzaProcent": 48.7, "bezCenyZakupuNetto": 13000, "nieznanaStawkaPozycji": 0, "anulowanych": 40, "anulowaneBrutto": 3200 },
  "poprzedni": { "od": "2026-08-31", "do": "2026-09-30", "razem": { "zamowien": 1300 } },
  "okresy": [{ "okres": "2026-10-01", "okresDo": "2026-10-01", "niepelny": false, "zamowien": 50, "wartoscBrutto": 4100 }],
  "konta": [{ "konto": "WOO:sd", "nazwa": "Sklep Demo", "zamowien": 900, "wartoscBrutto": 80000 }],
  "produkty": [{ "sku": "TEST-PRZYPRAWA", "nazwa": "Przyprawa testowa", "jednostka": "SZT", "ilosc": 320, "brutto": 6368, "netto": 5177.24, "zwrotyBrutto": 19.9, "zamowien": 300, "koszt": 1280, "marza": 3897.24, "marzaProcent": 75.3, "brakCenyZakupu": false }],
  "produktowRazem": 120, "wiecejProduktow": true,
  "pozaKompletorem": { "zamowien": 0, "brutto": 0 }
}
```

(Przykład skrócony: każdy wiersz `okresy` i `konta` ma wszystkie pola `razem`.) Reguły: anulowane poza sprzedażą
(osobno `anulowanych`, `anulowaneBrutto`), zwroty odjęte w okresie złożenia zamówienia, netto ze stawki VAT pozycji,
`produkty*` bez dostawy, `wartoscBrutto` z dostawą jak pulpit, `ilosc` w jednostce bazowej (sztuki albo gramy), marża
tylko z ceną zakupu produktu: produkt bez niej ma `koszt`, `marza` = null i `brakCenyZakupu: true`, a `razem.marza`
liczy się tylko ze sprzedaży z ceną zakupu (`bezCenyZakupuNetto` = reszta). `nieznanaStawkaPozycji`: pozycje ze stawką
VAT, której raport nie rozpoznaje (netto ze stawki produktu, bez niej z 23 %). Pełny opis: `docs/raporty.md`. Same agregaty,
bez danych klientów. Kod: `lib/api/raporty-sprzedaz.ts`, test `tests/raporty-sprzedaz.integration.test.ts`.

### `GET /api/v1/zamowienia`: nowe filtry

Opcjonalne `status` i `platnosc` (listy po przecinku), `kanal`, `konto`, `zlozone_od`, `zlozone_do` (ISO 8601, data
złożenia w kanale; `zlozone_do` bez tej chwili) zawężają tę samą listę (okno 14 dni po `zmienione_od`, kolejność
i kursor bez zmian). Kursor zakłada te same filtry w kolejnych stronach. Bez nowych parametrów odpowiedź jest taka jak
dotąd (integracje bez nowych parametrów działają bez zmian).

```bash
curl -s -H "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ" "https://kompletor.example.invalid/api/v1/zamowienia?platnosc=UNPAID&zlozone_od=2026-11-02T00:00:00%2B01:00&zlozone_do=2026-11-03T00:00:00%2B01:00"
```

Kod: `lib/api/produkty.ts`, `lib/api/raporty.ts`, `lib/api/statusy.ts`, filtry w `lib/api/zamowienia.ts`
(`parseOrderListFilter`); trasy `app/api/v1/produkty/**`, `app/api/v1/statusy`, `app/api/v1/raporty/**`. Testy:
`tests/api-v1-odczyty.integration.test.ts`.

## Automatyczne akcje: odczyt

### `GET /api/v1/automaty`

Zakres `zamowienia:odczyt`. Automatyczne akcje firmy (Ustawienia → Sprzedaż i kanały → Automatyczne akcje) i ostatnie wykonania reguł.
Parametry (opcjonalne): `zamowienie=<id zamówienia>` (tylko wykonania tego zamówienia), `limit=1..100` (domyślnie 50).
Inny parametr = 400.

Odpowiedź: `{ "grupy": [{ "id", "nazwa", "kolejnosc" }], "reguly": [{ "id", "nazwa", "opis", "wlaczona", "grupa", "zdarzenie",
"zdarzenieNazwa", "warunki": [...], "kroki": [...], "przycisk": { "napis", "miejsca" } | null }], "wykonania": [{ "regula",
"zamowienie", "zdarzenie", "wynik", "lancuch", "kroki": [{ "krok", "wynik", "opis" }], "kiedy" }] }`. Warunki i kroki
w schemacie z `lib/automaty/schemat.ts` (np. `{ "typ": "przesylka", "frazy": ["DPD"], "nie": false }`,
`{ "typ": "ustawStatus", "status": "DO_REALIZACJI_DPD" }`). `wynik` wykonania: `WYKONANA`, `CZESCIOWO`, `POMINIETA`,
`BLAD`, `PRZERWANY_LANCUCH` (bezpiecznik pętli), `PRZERWANA` (wykonanie przerwane w trakcie, np. restart; kroki nie są powtarzane). Bez danych klientów.

Narzędzie MCP `automaty` (zakres `mcp:odczyt`, argument opcjonalny `zamowienie`) zwraca to samo. Zapisu reguł przez
API nie ma (dopiero po ocenie bezpieczeństwa).

## Obsługa klienta

Dla chatbota obsługi klienta: „gdzie jest moje zamówienie” po e-mailu albo telefonie, który klient podał w rozmowie.
Osobny klucz z zakresem `obsluga:odczyt`.

### Klucz obsługi

- Zakłada go tylko osoba z uprawnieniem „Dane klienta” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia),
  w tym samym miejscu co inne klucze: Ustawienia → Integracje i agenci AI → Klucze API, zakres „obsługa klienta”.
- Klucz obsługi ma **tylko ten jeden zakres**. Formularz odrzuca połączenie z innymi zakresami, a baza ma warunek, który
  nie pozwala zapisać klucza mieszanego. Klucz obsługi dostaje 403 na każdej innej trasie `/api/v1/` i na serwerze MCP
  (`/api/mcp`, już przy wejściu, bez listy narzędzi); klucz bez zakresu obsługi dostaje 403 na trasach obsługi.
- **Konta sprzedaży klucza.** Przy zakładaniu klucza obsługi zaznacza się konta (np. sklep detaliczny bez konta hurtowego), których
  zamówienia klucz ma widzieć: co najmniej jedno albo, jako osobny świadomy wybór, „Wszystkie konta firmy” (także konta
  dodane później). Obie trasy szukają wyłącznie w kontach klucza, niezależnie od treści zapytania. Parametr `konta`
  może ten zbiór tylko zawęzić: konto spoza klucza daje pustą listę albo 404, tak samo jak brak danych. Konta klucza
  widać na liście kluczy w kolumnie „Zakresy”; zmiana kont = nowy klucz i odwołanie starego.

### `POST /api/v1/obsluga/zamowienia-klienta`

Zamówienia klienta o tym e-mailu albo telefonie, najnowsze pierwsze.

```json
{ "email": "klient@example.invalid", "konta": [{ "kanal": "WOO", "konto": "moja-firma" }], "limit": 5 }
```

- Dokładnie jedno z pól `email` albo `telefon`. Telefon w dowolnym zapisie: `+48 500 000 000`, `0048500000000`
  i `500000000` to ten sam numer; wielkość liter w e-mailu bez znaczenia.
- `konta` (opcjonalne, 1–20 obiektów `{ kanal?, konto }`): zawęża wynik w granicach kont klucza, np. do jednego
  z kilku sklepów przypisanych do klucza. Nie poszerza: konto spoza klucza = pusty wynik.
- `limit` (opcjonalny): 1–20, domyślnie 10.
- Odpowiedź `200 { "zamowienia": [...] }`; brak zamówień = pusta lista.

### `POST /api/v1/obsluga/zamowienie`

Jedno zamówienie po numerze, jeśli e-mail albo telefon zamówienia pasuje do podanego.

```json
{ "numer": "TEST-1001", "telefon": "500000000" }
```

- `numer`: numer zamówienia w sklepie, numer widoczny w kanale (np. na Allegro) albo numer BL.
- Dokładnie jedno z pól `email` albo `telefon`; `konta` jak wyżej.
- Odpowiedź `200 { "zamowienia": [...] }` (zwykle jedno, kilka, gdy ten sam numer jest w kilku kontach) albo
  `404 { "error": "Nie znaleziono zamówienia" }`. Brak takiego numeru i niezgodny kontakt dają tę samą odpowiedź, więc
  nie da się sprawdzać, które numery istnieją.

### Pola zamówienia

`kanal`, `konto`, `numer`, `numerWidoczny`, `numerBl`, `zlozono`, `zmieniono`, `status`, `statusNazwa`,
`statusDlaKlienta` (nazwa dla klienta ze statusów firmy, `null`, gdy firma jej nie ustawiła), `historia[]` (`status`,
`statusNazwa`, `kiedy`; same zmiany statusu, najwyżej 30 ostatnich), `platnosc`, `platnoscMetoda`, `sumaBrutto`,
`przewoznik`, `sposobDostawy`, `numerNadania`, `pozycje[]` (`nazwa`, `ilosc`), `przesylki[]` (ten sam kształt co
w `GET /api/v1/zamowienia`), `faktury[]` (`numer`, `wystawiono`, najwyżej 5).

Odpowiedź **nie zawiera** adresu, imienia i nazwiska, e-maila, telefonu, NIP-u, notatek ani flag zamówienia.

### Dane osobowe i dziennik

- E-mail i telefon idą w treści `POST`, nie w adresie, więc nie trafiają do logów serwera pośredniczącego ani historii.
- Dopasowanie jest dokładne, po skrócie (HMAC) wartości liczonym kluczem instalacji i identyfikatorem firmy, bez
  odszyfrowywania danych klientów; ten sam e-mail w innej firmie ma inny skrót. Fragmentem nie da się szukać.
- Każde zapytanie, także bez trafień, zostawia jeden wpis w dzienniku podglądów
  (Ustawienia → Zespół i dostęp → Dane klientów → Dziennik podglądów): autor „klucz API <nazwa>”, cel „obsługa klienta (API)”, trasa, rodzaj kontaktu
  i liczba trafień, bez wartości kontaktu i numeru. Bez zapisanego wpisu dane nie wychodzą. Filtr „Osoba” ma pozycje
  „Tylko osoby (bez kluczy API)” i „Tylko klucze API”, żeby zapytania chatbota nie zasłaniały podglądów ludzi.
- Błędy wejścia (400) nie powtarzają podanych wartości.

### Kody i limity

| Kod | Kiedy |
|---|---|
| 200 | odczyt (na liście także pusty wynik) |
| 400 | zły JSON, nieznane pole, brak albo oba pola `email` i `telefon`, zły `limit` albo `konta` |
| 401 | brak klucza, zły albo odwołany |
| 403 | klucz bez zakresu `obsluga:odczyt` (konto spoza kont klucza to nie 403, tylko pusty wynik albo 404) |
| 404 | `/zamowienie`: brak zamówienia o tym numerze z tym kontaktem |
| 413 | treść większa niż 4 KB |
| 429 | limit (`Retry-After`) |
| 503 | instalacja bez klucza skrótów klientów: wyszukiwanie po kliencie niedostępne |
| 500 | błąd serwera, bez szczegółów |

Poza wspólnym limitem 120 żądań na minutę trasy obsługi mają własny: 30 zapytań na minutę i 600 na godzinę na klucz
(429 z `Retry-After` 60 albo 600 sekund). Klucz, który wyciekł, nie wystarczy do masowego sprawdzania listy adresów.

W kodzie: `lib/api/obsluga.ts` (wejście, limity, pola odpowiedzi), `lib/klienci/obsluga.ts` (dopasowanie po skrócie
i wpis w dzienniku), `app/api/v1/obsluga/**/route.ts`; testy `tests/api-v1-obsluga.integration.test.ts`.
