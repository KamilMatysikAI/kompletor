# KSeF bez wFirmy

Dla sprzedawcy, który **nie** ma wFirmy, a chce wystawiać faktury przez Kompletor. Stan opisany na **02.11.2026**.
Prawo i API KSeF zmieniają się często: przed uruchomieniem wysyłki sprawdź daty i wersje jeszcze raz.

> **Co ważne w skrócie (09.11.2026):** Kompletor **nadaje numer z serii i wysyła** fakturę FA(3)
> i korektę do KSeF sesją interaktywną API 2.x (token firmy), zapisuje numer KSeF i UPO. Domyślnie środowisko TEST;
> produkcja wymaga jawnego wyboru firmy, włączonego „Wystawiaj faktury z Kompletora”, konta sklepu w trybie „Aktywny”
> i dwóch kluczy operatora serwera (`KSEF_PROD_ENABLED=1`, NIP firmy w `KSEF_PROD_NIPS`). W testach produkcja jest
> zamknięta zawsze, a sieć to atrapa z nagranymi odpowiedziami KSeF TEST (`tests/ksef-atrapa.ts`).
>
> Kod klienta (token RSA-OAEP, sesja, szyfrowanie AES-256-CBC, status, UPO, dubel 440) pochodzi z naszego klienta
> KSeF działającego produkcyjnie w systemie najmu i w DewFlow (`lib/ksef/api/`). Opis użytkownika: [Dokumenty
> sprzedaży](../dokumenty-sprzedazy.md), sekcja „KSeF bezpośrednio”. Rozdziały niżej opisują stan z etapu szkicu
> (02.11.2026); tam, gdzie mówią „nic nie jest wysyłane”, obowiązuje ten akapit.

## 1. Obowiązek KSeF: stan na 02.11.2026

Źródła: ksef.podatki.gov.pl, dokumentacja API (github.com/CIRFMF/ksef-docs), opracowanie KPMG z 17.09.2026.

| Kto | Od kiedy |
|---|---|
| Duzi podatnicy (sprzedaż ponad 200 mln zł w 2024 r.) | 01.02.2026 |
| Pozostali podatnicy | 01.04.2026 |
| Mikro (sprzedaż do 10 000 zł brutto miesięcznie) | wg dostępnych źródeł do końca 2026 r. [NIEPEWNE: był projekt przedłużenia do końca 2027 r.] |

- **Kary:** planowane od 01.01.2027. Ministerstwo Finansów zapowiedziało 16.09.2026 przesunięcie do 31.12.2027:
  to **projekt, nie obowiązujące prawo**. Nie zakładaj, że któraś z tych dat jest ostateczna.
- **Schemat FA(3)** obowiązuje od 01.02.2026. Od 16.07.2026 KSeF ostrzej sprawdza XML (zakaz niektórych znaków
  Unicode i instrukcji przetwarzania).
- **API KSeF 2.9.0** na produkcji od 15.10.2026 (poprzednia 2.8.1).

## 2. wFirma albo KSeF bezpośrednio

Wybór w ustawieniach firmy: `Organization.settings.faktury.program`.

| | `wfirma` (domyślnie, także gdy pola nie ma) | `ksef` |
|---|---|---|
| Kto nadaje numer faktury | wFirma | Kompletor (seria firmy, punkt 5) |
| Kto wysyła do KSeF | wFirma | Kompletor: **w przyszłym etapie** |
| Co robi Kompletor | składa treść faktury dla wFirmy | składa fakturę FA(3), sprawdza ją i odkłada (to zadanie) |
| Szkic KSeF w Kompletorze | nie ma: jawne „nie dotyczy” | tak, blok w ekranie zamówienia |

**Firma z wFirmą zostaje przy wFirmie** i to się nie zmienia: nie dostaje szkiców KSeF (sprawdza to test na
ustawieniach z `tests/preset-testowy.ts`).

Pozycje faktury są w obu programach te same: ta sama funkcja (`zlozFakture`) rozbija zestawy, dolicza wysyłkę jako
różnicę do kwoty zamówienia, traktuje e-booki (DIGITAL) jak usługę i pilnuje, żeby suma faktury była równa kwocie
zamówienia co do grosza.

## 3. Co system robi, a czego nie robi

**Robi:**

1. Składa fakturę FA(3) (`lib/ksef/fa3/builder.ts`): faktura VAT w PLN liczona od brutto (jak w sklepie), netto per
   stawka zaokrąglane do grosza. Stawki 23, 8, 5, 0, zw i np.
2. Zbiera **wszystkie** problemy danych naraz (zły NIP, nieznana stawka, znak niedozwolony w KSeF, brak danych
   sprzedawcy, różnica sumy…) i pokazuje je stałym tekstem, bez danych klientów. Znaku niedozwolonego nie usuwa po
   cichu: trzeba poprawić dane źródłowe (np. nazwę produktu).
3. Sprawdza XML schematem XSD FA(3) (`lib/ksef/fa3/xsd.ts`). Cztery schematy MF są w repo w `lib/ksef/xsd/`
   (kopia z DewFlow, sprawdzona tam na TEST); `KSEF_XSD_DIR` wskazuje inny katalog. Bez schematów albo przy błędzie
   samego walidatora mówi „nie sprawdzono”, nigdy „poprawne”. Builder sam pilnuje reguł schematu, które najczęściej
   psują dane: wzorzec NIP (`TNrNIP`, prefiks „PL” zdjęty), limit 240 znaków (numer, jednostka, podstawa zwolnienia,
   opisy) i 512 (nazwy, adresy, nazwa pozycji).
4. Odkłada szkic w bazie (`KsefInvoiceDraft`) ze statusem:

   | Status | Znaczenie |
   |---|---|
   | `ZLOZONA` | złożona bez problemów, ale bez sprawdzenia schematem (brak plików XSD) |
   | `ODLOZONA` | sprawdzona schematem; przy wysyłce składana ponownie z prawdziwym nabywcą, datą i numerem (XML szkicu ma nabywcę zastępczego i datę przygotowania) |
   | `BLAD_WALIDACJI` | problemy danych albo niezgodność ze schematem: nie pójdzie dalej |
   | `POZA_KSEF` | osoba prywatna bez NIP, a firma nie wysyła takich faktur do KSeF (punkt 6) |
   | `WYSLANA`, `PRZYJETA`, `ODRZUCONA` | na przyszły etap wysyłki, dziś nieustawiane |

   Zamówienie anulowane albo bez pozycji dostaje „nie dotyczy” (stary szkic bez numeru znika). Zamówienie bez
   wysyłki (np. sam e-book) fakturę dostaje, tylko bez wiersza „Wysyłka”.
5. Polecenie `npm run ksef -- podglad --dzien RRRR-MM-DD [--firma <slug>]`: szkice zamówień z danego dnia, liczby
   per status, numery zamówień i kody problemów.
6. Blok „Faktura KSeF: szkic, nic nie zostało wysłane” w sekcji „Dokument sprzedaży” karty zamówienia z przyciskiem „Przygotuj szkic faktury”
   (uprawnienie `zamowienia.anuluj_po_fakturze`). Widoczny tylko przy `program: ksef`.
7. Test połączenia adaptera `ksef.fa3.v1`: `POST /auth/challenge` do TEST albo DEMO.

**Nie robi:**

- nie wysyła faktur do KSeF i nie pobiera UPO; klient KSeF (`lib/ksef/klient.ts`) zna tylko `POST /auth/challenge`
  i `GET /security/public-key-certificates`, a host produkcyjny `api.ksef.mf.gov.pl` jest zablokowany w każdej ścieżce;
- nie nadaje numerów faktur (szkic ma numer roboczy `SZKIC-<id>`), punkt 5;
- nie przechowuje danych nabywcy (punkt 7);
- nie obsługuje korekt, faktur zaliczkowych, walut obcych ani adresów poza Polską: takie przypadki to jawny problem.

## 4. Ustawienia firmy (bez sekretów)

```json
{
  "faktury": { "program": "ksef", "wysylka": { "nazwa": "Wysyłka", "stawkaVat": "23" } },
  "ksef": {
    "sprzedawca": { "nip": "1111111111", "nazwa": "Moja Firma sp. z o.o.", "adres": { "linia1": "ul. Przykładowa 1", "linia2": "00-001 Warszawa" } },
    "seriaKod": "FV",
    "konsumenciDoKsef": false,
    "podstawaZwolnienia": "art. 43 ust. 1 pkt … ustawy o VAT"
  }
}
```

- Brak NIP, nazwy, adresu sprzedawcy albo serii = problem na każdym szkicu.
- `podstawaZwolnienia` jest potrzebna tylko przy pozycjach ze stawką „zw” [do potwierdzenia przez księgową].
- Konto integracji `ksef.fa3.v1`: ustawienie `srodowisko` = `TEST` albo `DEMO` (wartość `PROD` jest odrzucana).
  Sekret `KSEF_TOKEN` jest przewidziany na przyszłość i dziś nieużywany.

## 5. Numeracja faktur

Firma bez wFirmy potrzebuje własnej numeracji. Art. 106e ust. 1 pkt 2 ustawy o VAT wymaga kolejnego numeru nadanego
w ramach jednej lub więcej serii, który jednoznacznie identyfikuje fakturę [do potwierdzenia przez księgową: czy
numeracja ma się zerować co rok, co miesiąc, czy wcale].

- Seria (`InvoiceNumberSeries`): kod (np. `FV`), wzorzec (np. `FV/{NR}/{MM}/{RRRR}`; znaczniki `{NR}`, `{DD}`, `{MM}`,
  `{RRRR}`, `{RR}`), okres zerowania (`ROK`, `MIESIAC`, `NIGDY`) i licznik per okres. Przy zerowaniu rocznym wzorzec
  musi mieć rok, przy miesięcznym miesiąc i rok: inaczej dwa okresy dałyby ten sam numer.
- Numer przydziela `przydzielNumer` (`lib/ksef/numeracja.ts`) **w transakcji zatwierdzenia do wysyłki**: równoległe
  zatwierdzenia nie dostaną tego samego numeru, a wycofane zatwierdzenie nie zostawi dziury (test na 20 równoległych).
- **Szkic nie dostaje numeru.** Podgląd i ponowne „Przygotuj” nie zużywają numerów, więc tryb próbny nie robi dziur.
  W tym etapie nic w aplikacji nie woła `przydzielNumer` (pilnuje tego test).
- Szkic z numerem jest nietykalny: ponowne przygotowanie go nie zmieni.
- **Korekty** (przyszły etap) dostaną własną serię (np. `KOR/{NR}/{RRRR}`) z tym samym mechanizmem; numer faktury
  korygowanej i jej numer KSeF trafią do treści korekty.

## 6. Faktury dla osób prywatnych (bez NIP)

Zasada właściciela z 28.09.2026: takie faktury **nie muszą** iść do KSeF i domyślnie nie idą: szkic dostaje status
`POZA_KSEF`. Firma może to zmienić ustawieniem `ksef.konsumenciDoKsef: true`.
Podstawa prawna i wyjątki (np. faktura do paragonu): [do potwierdzenia przez księgową].

## 7. Dane klientów

System nie przechowuje danych klientów. W szkicu nabywca to stała `Nabywca (uzupełniany przy wysyłce)` z `BrakID` = 1.
Prawdziwy nabywca (także NIP) jest wyłącznie argumentem funkcji budującej XML. Komunikaty problemów i walidacji nie
cytują wartości danych. **Gdzie trzymać XML z prawdziwym nabywcą po wysyłce (archiwum faktur, 10 lat?): decyzja
właściciela** przed etapem wysyłki.

## 8. Plan wysyłki (przyszły etap, nie w tym zadaniu)

Bazy API (`/v2`, bez prefiksu `/api`): TEST `https://api-test.ksef.mf.gov.pl/v2`, DEMO
`https://api-demo.ksef.mf.gov.pl/v2`, PROD `https://api.ksef.mf.gov.pl/v2`. OpenAPI:
`https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json`. TEST i DEMO: tylko dane fikcyjne (losowy NIP), na TEST
samopodpisane certyfikaty, prace serwisowe 16:00–18:00. TEST przyjmuje też FA(2), DEMO i PROD tylko FA(3).

**Uwierzytelnienie:** `POST /auth/challenge` (wyzwanie ważne 10 minut), potem:

- token KSeF: `{token}|{timestampMs}` szyfrowane RSA-OAEP SHA-256 kluczem publicznym KSeF
  (`GET /security/public-key-certificates`, wybór klucza `publicKeyId` od 2.5.0) → `POST /auth/ksef-token`;
- albo podpis: `POST /auth/xades-signature`;
- następnie `GET /auth/{referenceNumber}` z Bearer do skutku → `POST /auth/token/redeem` (jednorazowo) daje
  `accessToken` i `refreshToken` → `POST /auth/token/refresh`.
- Pole `authenticationMethod` jest wycofywane 16.11.2026: nie opierać się na nim.

**Sesja interaktywna:** faktura szyfrowana AES-256-CBC (PKCS#7), klucz AES szyfrowany RSA-OAEP SHA-256;
`POST /sessions/online` (`formCode`: `systemCode`, `schemaVersion`, `value`) → `POST /sessions/online/{ref}/invoices`
→ `POST /sessions/online/{ref}/close`. Status faktury: `GET /sessions/{ref}/invoices/{invoiceRef}`, UPO:
`GET /sessions/{ref}/invoices/{invoiceRef}/upo`. Błąd 21184 „Sesja tymczasowo niedostępna” = nowa sesja i ponowienie.

**Statusy po wysyłce:** `WYSLANA` (przyjęta do sesji) → `PRZYJETA` (numer KSeF i UPO) albo `ODRZUCONA` (kod błędu
KSeF, faktura do poprawy z **tym samym** numerem z serii albo anulowanie wg decyzji księgowej).

**Odporność (poprawki po przeglądzie):** limity czekania (uwierzytelnienie 30 s, wynik przetwarzania 60 s)
liczy prawdziwy zegar; zadanie workera `ksef-wysylka` ma twardy limit 4 min (sygnał przerywa żądania i czekania).
GET ponawiany przy błędzie sieci i 5xx (1/3/9 s), przy 429 czeka `Retry-After` / „po N sekundach” (bez podpowiedzi
45 s, najwyżej 60 s); POST bez ponowień. Błąd odczytu stanu po 202 nie czyści referencji: faktura zostaje `WYSLANA`
z opisem, worker pyta o stan (do 30 prób w sumie, potem `BLAD_WYSYLKI` z referencjami). Dubel 440 bez numeru
oryginału: referencja sesji oryginału, numer KSeF z `GET /sessions/{ref}/invoices` po numerze faktury, UPO po numerze
KSeF (worker, 7 dni). Brak schematów XSD = odmowa przed nadaniem numeru; Dockerfile kopiuje `lib/ksef/xsd` jawnie.

**Utwardzenie przed pierwszą produkcyjną fakturą:**

- **Hash dokumentu.** Data wytworzenia XML (`DataWytworzeniaFa`) zamraża się razem z numerem (`wytworzonaAt`),
  więc ponowienie przy niezmienionych danych wysyła bajt w bajt ten sam XML. SHA-256 (base64) każdej wysyłanej wersji
  trafia do `hasheWyslane` **przed** wysłaniem (zgubiona odpowiedź nie gubi hashu), hash przyjętego dokumentu do
  `invoiceHash`. Pewne odrzucenie (4xx przed przyjęciem, 450) zdejmuje hash tej wersji. PDF składa XML ponownie
  i przy rozjeździe z `invoiceHash` drukuje ostrzeżenie, że wiążąca jest faktura w KSeF.
- **Zapis tylko przez próbę, która ma wiersz.** Każdy zapis stanu próby (także zapis
  błędu) to `updateMany({ id, status: 'WYSYLANA', wysylkaOd: <start tej próby>, proby: <numer tej próby> })`; status
  zostaje `WYSYLANA` do końca próby (także po 202). Sprzątacz zeruje `wysylkaOd`, a każda nowa próba ustawia własne
  `wysylkaOd` i `proby` (rośnie pod blokadą), więc spóźniona próba nie nadpisze stanu nowszej, nawet gdy ta znów ma
  status `WYSYLANA`: kończy się po cichu i niczego już nie wysyła.
- **Próba ręczna z limitem czasu.** „Ponów” i korekta z panelu mają limit 2 min (`zLimitemProbyRecznej`,
  krótszy niż 5 min sprzątacza): po nim sygnał przerywa żądania KSeF, przed 202 próba kończy się `PRZERWANA` (automat
  dokończy tym samym numerem), po 202 stanem do sprawdzenia.
- **Dopasowanie w sesji oryginału.** Numer KSeF dubla bez `originalKsefNumber` przypisujemy tylko fakturze
  sesji o naszym numerze **i** hashu z `hasheWyslane`/`invoiceHash`. Numer zgodny, hash obcy = nie przypisujemy,
  wiersz dostaje komunikat do sprawdzenia w Aplikacji Podatnika. `invoicingDate` w odpowiedzi KSeF to chwila przyjęcia
  w KSeF, nie data wystawienia P_1 (nagranie TEST: oryginał i dubel różnią się `invoicingDate` o 2 s), więc dla
  wierszy bez hashy warunkiem jest tylko „przyjęta nie wcześniej niż dzień wystawienia u nas”.
  **Założenie: seria numeracji KSeF jest wyłączna dla Kompletora.** Wystawienie tego samego numeru innym programem na
  tym samym NIP-ie kończy się dublem 440, a bez hashu groziłoby podpięciem cudzego numeru KSeF; dlatego firma nie
  może używać tego samego wzoru serii w innym programie.
- **Jedno połączenie na przebieg.** Przebieg workera loguje się do KSeF raz, leniwie, i to połączenie
  (z odświeżaniem tokenu przy 401) obsługuje wszystkie dokumenty przebiegu. Nieudane logowanie kończy przebieg bez
  zaczynania kolejnych dokumentów (bez zużywania ich numerów). W przebiegu czekanie na wynik to 20 s, a nowy dokument
  nie zaczyna się, gdy do limitu 4 min zostało mniej niż 90 s. Przed nadaniem numeru pierwszemu nowemu
  dokumentowi przebieg najpierw się loguje; przy nieudanym logowaniu nowe dokumenty nie dostają numerów, o ile błąd
  logowania już widać na liście faktur (wiersz z `LOGOWANIE`/`KONFIGURACJA`). Bez takiego wiersza jeden dokument
  dostaje numer i błąd, żeby problem nie był cichy. Ten jeden dokument omija tylko pamiętany błąd
  logowania, nie limit zadania ani budżet czasu; logowanie przerwane limitem kończy przebieg bez nadania numeru.
- **Automatyczne ponowienia.** Przyczyna błędu jest kodem (`przyczyna`, `lib/ksef/przyczyny.ts`). Worker sam
  ponawia `SIEC`, `PRZERWANA`, `LIMIT_ZADAN` (429 przed przyjęciem), `SERWER` (5xx przed przyjęciem), `LOGOWANIE`
  i `PORZUCONA`, do 6 razy z odstępem 2, 5, 15, 30, 60, 120 min, zawsze tym samym numerem (dubel = 440). `KSEF_ODMOWA`
  (inne 4xx, 450), `DANE`, `SCHEMAT`, `KONFIGURACJA` i `ODCZYT_STANU` tylko „Ponów”; „Ponów” człowieka zeruje licznik.
  401/403 na żądaniu (token dostępowy odrzucony, odświeżenie nie pomogło) to `LOGOWANIE`, nie `KSEF_ODMOWA`.
  Porzucona próba po wyczerpanych ponowieniach dostaje komunikat „kliknij Ponów” zamiast obietnicy automatu;
  licznika przy porzuceniu nie zerujemy. Zapis nowego tokenu w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży
  (`poZapisieTokenuKsef`) wraca do automatu wszystkie faktury `BLAD_WYSYLKI` z przyczyną `LOGOWANIE` albo
  `KONFIGURACJA` (brak tokenu): przyczyna `LOGOWANIE`, `ponowieniaAuto = 0`, próba od razu; to samo co „Ponów” przy
  każdej (ten sam numer, dubel = 440). Zapytania automatu mają indeks `(organizationId, status, nastepnaProbaOd)`.
- **Odmowa przy wysyłce.** 4xx/429/401/403 na `POST …/invoices` zdejmuje referencje i hash TEJ
  próby, ale referencję sesji sprzed niej przywraca. Wiersz sprzed utwardzenia (bez hashy, z samym `sesjaRef`) dalej
  blokuje zmianę daty w wariancie `DZIEN_WYSYLKI`, a następna próba wysyła ten sam numer. Odmowa już przy otwarciu
  sesji ma własny komunikat „KSeF odrzucił otwarcie sesji” (faktura nie wyszła).
- **Liczniki.** `proby` liczy wszystkie próby, `probyOdczytu` tylko nieudane odczyty stanu po wysłaniu
  (limit 30), `probyUzupelnienia` nieudane dociągnięcia numeru KSeF/UPO (po 10 komunikat na liście i koniec prób).
  Numer KSeF znaleziony w sesji oryginału zapisuje się przed pobraniem UPO, więc błąd UPO go nie gubi.
- **Data wystawienia przy ponowieniu.** Ustawienie operatora `settings.ksef.dataPrzyPonowieniu` (bez ekranu):
  `PIERWSZA_PROBA` (domyślnie, data i numer z pierwszej próby) albo `DZIEN_WYSYLKI` (data faktycznego przesłania, ale
  tylko gdy żadna wcześniejsza wersja nie może być w KSeF, czyli `hasheWyslane` jest puste i wiersz nie ma referencji
  sesji; numer zostaje).
  Rozstrzyga księgowa firmy.

**Przed GO na pierwszą produkcyjną fakturę KSeF (warunki):**

1. **Test na środowisku TEST KSeF formatu `invoiceHash` w liście faktur sesji.** Nagrania mają `invoiceHash` tylko dla
   statusu pojedynczej faktury (`GET /sessions/{ref}/invoices/{ref}`). Trzeba na żywo na TEST potwierdzić, że
   `GET /sessions/{ref}/invoices` zwraca `invoiceHash` w tym samym formacie (base64 SHA-256 XML-a). Bez tego rozpoznanie dubla po hashu
   działa w stronę bezpieczną (własna faktura = `inna_tresc`, numer KSeF nieprzypisany, komunikat do sprawdzenia
   ręcznego), ale dociąganie numeru KSeF po dublu bez `originalKsefNumber` nie zadziała wcale. W rundzie utwardzenia
   połączenia z KSeF były zakazane, więc ten test nie był robiony.
2. Odpowiedź księgowej na pytanie o datę wystawienia przy ponowieniu i decyzja o `dataPrzyPonowieniu` (wyżej). Przed włączeniem `DZIEN_WYSYLKI`
   musi być w kodzie poprawka (odmowa wysyłki wiersza sprzed utwardzenia nie odblokowuje zmiany daty): zrobione
   (test `tests/ksef-przed-produkcja.integration.test.ts`).
3. Osobne GO właściciela na pierwszą produkcyjną fakturę (bramka produkcji niżej).
4. Zamknięte w kodzie przed GO: zapis tokenu wraca faktury z błędem logowania do automatu; poprawka z pkt 2;
   dokument „mimo błędu logowania” nie startuje po limicie czasu; test dwóch żywych prób (wysyłka starej
   dociera, nowa dostaje 440 i zapisuje referencje oryginału); osobny komunikat przy odmowie otwarcia sesji.

**Tryb offline** (awaria KSeF albo brak łączności): faktura wystawiona offline z kodem QR, dosłana w ustawowym
terminie [NIEPEWNE: terminy i oznaczenia offline24/awaria do sprawdzenia w dokumentacji i przez księgową].

**Bramka produkcji** (wzór, do zatwierdzenia przez właściciela): wysyłka do produkcji tylko gdy jednocześnie
(1) dwa klucze operatora (dwie osoby potwierdzają włączenie), (2) włączona instancja (zmienna środowiska serwera,
nie ustawienie firmy) i (3) NIP sprzedawcy jest na liście dozwolonych NIP-ów tej instancji. Brak któregokolwiek =
wyjątek przed wysyłką, tak jak dziś strażnik `assertKsefReadOnly`.

## 9. Lista [NIEPEWNE] do sprawdzenia na TEST i z księgową

1. ~~Nazwa pliku schematu FA(3)~~ zamknięte: `schemat_FA(3)_v1-0E.xsd` z importami `StrukturyDanych_v10-0E.xsd`,
   `ElementarneTypyDanych_v10-0E.xsd`, `KodyKrajow_v10-0E.xsd` (w repo, test zgodności buildera ze schematem).
2. ~~Miejsce `Platnosc`~~ zamknięte ze schematu: w `Fa` po `FaWiersz`, przed `WarunkiTransakcji` i `Zamowienie`
   (dziś builder go nie wstawia).
3. ~~Kod P_12~~ zamknięte ze schematu: `0 KR` i `np I` są w enumeracji `TStawkaPodatku`; `np II` to usługi z art. 100
   ust. 1 pkt 4, sklepu krajowego nie dotyczy.
4. Pełna lista znaków odrzucanych przez KSeF od 16.07.2026 (builder odrzuca sterujące, niewidoczne, sterowanie
   kierunkiem tekstu i nieznaki Unicode).
5. `P_18A` (mechanizm podzielonej płatności) zawsze `2`: przy fakturach powyżej 15 000 zł z towarami z załącznika 15
   musi być `1` [księgowa].
6. Czy `POST /auth/challenge` w API 2.9.0 wymaga treści żądania (kontekst NIP).
7. Mikroprzedsiębiorcy: koniec zwolnienia 2026 czy 2027.
8. Kary: 01.01.2027 czy 31.12.2027 (projekt MF z 16.09.2026).
9. Faktury dla osób prywatnych poza KSeF: podstawa prawna i wyjątki (faktura do paragonu) [księgowa].
10. Zerowanie numeracji: rocznie, miesięcznie czy wcale [księgowa].
11. Podstawa prawna zwolnienia (P_19A) dla produktów „zw” [księgowa].
12. Tryb offline: terminy dosłania i oznaczenia [dokumentacja + księgowa].
13. `P_6` (data dostawy albo sprzedaży) nie jest ustawiana; dla sklepu to zwykle dzień wydania albo wysyłki, inny niż
    data wystawienia [księgowa].
