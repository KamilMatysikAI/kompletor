# Integracje

Z którymi systemami Kompletor się łączy, co z nimi dziś robi i skąd wziąć klucze z najmniejszymi uprawnieniami.

Kompletor łączy się tylko z systemami, które sam skonfigurujesz. Domyślnie każde połączenie ze sklepem jest **tylko do odczytu**. Zapis stanów, statusów i numerów nadania (WooCommerce, Shoper, PrestaShop, IdoSell) rusza dopiero, gdy konto ma wersję z zapisem, włączony zapis i tryb „praca”: [Zapis do sklepu WooCommerce](woocommerce.md). Klucze trzymamy w bazie w postaci zaszyfrowanej. Stan oferty, który sklep już ma z ostatniego udanego zapisu, nie idzie drugi raz: [Wysyłka stanów](../synchronizacja-stanow.md).

## Stan integracji

| Integracja | Co robi dziś | Czego nie robi |
|---|---|---|
| WooCommerce | Czyta zamówienia (nowe i zmienione). Z wersją z zapisem wysyła stany, statusy, numery nadania i anulowanie nieopłaconych: [opis](woocommerce.md). | Bez włączonego zapisu i trybu „praca” niczego nie wysyła. Sprawdzone tylko na symulowanym sklepie. |
| Allegro | Czyta zamówienia z dziennika zdarzeń Allegro. Z wersją z zapisem wysyła stany ofert, status realizacji i numery nadania; z modułem Wysyłam z Allegro „nadawanie” tworzy przesyłkę, pobiera etykietę i anuluje: [opis](allegro.md). | Bez włączonego zapisu, trybu „praca” i zgody właściciela konta na daną funkcję niczego nie wysyła. Sprawdzone tylko na symulowanym koncie Allegro. Nie zamawia kuriera. |
| Empik (Mirakl) | Czyta zamówienia. Przyjmuje zamówienia (w cieniu tylko zapisuje „zaakceptowałbym”), alert po czasie. Opis: [Empik](empik.md). | Przyjmowanie, stany, numer nadania i „wysłane” są napisane, ale stoją za wyłącznikiem konta; sprawdzone tylko na symulowanym koncie. |
| Base Courier (InPost, DPD) | Liczy paczkę na podgląd i sprawdza połączenie. Z modułem „z tworzeniem przesyłek” tworzy przesyłkę (InPost A/B/C, kurier DPD, salon Empik, pobranie), pobiera etykietę PDF i numer listu, anuluje: [opis](basecourier.md). | Bez włączonego nadawania i trybu „praca” niczego nie wysyła. Sprawdzone tylko na atrapie Base Courier, nie na sandboxie. Nie zamawia kuriera. |
| wFirma | Odczyt towarów i stanów przy imporcie katalogu, odczyt faktur i dokumentów WZ do porównania. | Nie wystawia faktur. Stany towarów czyta też na bieżąco (lustro stanów, co 2 minuty i co noc), tylko odczytem. |
| BaseLinker | Import katalogu i powiązań, porównanie zamówień i faktur (rozjazdy). | Niczego nie zapisuje w BaseLinkerze. |
| Shoper, PrestaShop | Czytają zamówienia, oferty i stany. Opis: [Shoper](shoper.md), [PrestaShop](prestashop.md). | Sprawdzone tylko na symulowanym sklepie. Zapis stanów i statusów stoi za wyłącznikiem konta; statusy wysyłają się dopiero po uzupełnieniu tabeli „Statusy w sklepie” na ekranie konta. |
| IdoSell | Czyta zamówienia (wyszukiwanie po dacie zmiany) i produkty z rozmiarami i stanem wybranego magazynu. Z wersją z zapisem ustawia stany i statusy zamówień: [opis](idosell.md). | Sprawdzone tylko na symulowanym sklepie. Bez włączonego zapisu i trybu „praca” niczego nie wysyła; statusy wysyłają się dopiero po uzupełnieniu tabeli „Statusy w sklepie”. Nie dopisuje numerów nadania do zamówień w IdoSell. |
| InPost, DPD bezpośrednio | Liczą przesyłkę na podgląd na karcie zamówienia i sprawdzają połączenie. Opis: [InPost](inpost.md), [DPD](dpd.md). | Nie tworzą przesyłek i etykiet (tworzenie stoi za wyłącznikiem, nikt go nie woła). |
| Orlen Paczka bezpośrednio | Liczy przesyłkę do punktu albo automatu (rozmiar S/M/L, do 20 kg), sprawdza połączenie. Z modułem „nadawanie za wyłącznikiem” nadaje paczkę, pobiera etykietę i anuluje: [opis](orlenpaczka.md). | Bez pobrania (Orlen Paczka je wycofała) i bez zamawiania kuriera. Bez włączonego nadawania i trybu „praca” niczego nie wysyła. Sprawdzone tylko na atrapie, nie na koncie testowym Orlen Paczki. |
| GLS bezpośrednio (ADE) | Liczy przesyłkę kurierem albo do punktu GLS (waga, pobranie), sprawdza połączenie. Z modułem „nadawanie za wyłącznikiem” nadaje przesyłkę i pobiera etykietę: [opis](gls.md). | Bez anulowania (ADE nie usuwa przesyłki po potwierdzeniu nadania), zamawiania kuriera i usług dodatkowych. Bez włączonego nadawania i trybu „praca” niczego nie wysyła. Sprawdzone tylko na atrapie, nie na koncie testowym ADE. |
| Poczta Polska (eNadawca) | Liczy przesyłkę Pocztex Kurier (format S…2XL z wymiarów), sprawdza połączenie i urząd nadania. Z modułem „nadawanie za wyłącznikiem” dodaje przesyłkę do partii dnia, pobiera etykietę PDF, usuwa przesyłkę z partii, wysyła partię i śledzi: [opis](pocztapolska.md). | Bez pobrania, ubezpieczenia i wysyłek za granicę; przycisku „Wyślij partię” na liście jeszcze nie ma. Sprawdzone tylko na atrapie, nie na koncie testowym eNadawcy. |
| KSeF (firma bez wFirmy) | Składa fakturę FA(3), sprawdza ją ze schematem i odkłada jako szkic. Opis: [KSeF bez wFirmy](ksef.md). | Niczego nie wysyła do KSeF. |

Ścieżki w panelach innych firm opisujemy według ich dokumentacji. Miejsca oznaczone `[do potwierdzenia]` sprawdź u siebie, bo nazwy menu się zmieniają.

## Ekran „Integracje”

**Ustawienia → Integracje i agenci AI → Integracje** (`/ustawienia/integracje`, osoba z uprawnieniem do ustawień firmy) pokazuje wszystkie połączenia firmy na jednej liście, w grupach Sprzedaż, Wysyłka, Dokumenty sprzedaży, Poczta i Agenci AI. Przy każdej pozycji jest logo albo ikona rodzaju, jedna linia szczegółu (konto, liczba reguł wysyłki, serwer poczty), stan i jeden przycisk:

- **Zarządzaj** otwiera dotychczasowy ekran (konto sklepu, Konta przewoźników, Dokumenty sprzedaży, Poczta, Agenci AI, Klucze API);
- **Podłącz** przy pozycji „Niepodłączony” prowadzi tam, gdzie wpisujesz klucze (przy sklepie od razu kreator „Dodaj sklep” z wybraną platformą).

Stany: „Ostatni udany odczyt: dziś 18:09” (sklep czyta zamówienia), „Odczyt zamówień z błędami”, „Zapis wyłączony” (Kompletor tylko czyta albo nadawanie i wystawianie są wyłączone), „Zapisuje stany i statusy”, „Połączenie działa (test …)” (ostatni test zapisany na ekranie kont przewoźników), „Brak tokenu KSeF”, „Niepodłączony”.

Ekran tylko czyta to, co Kompletor już ma w bazie (ostatnie odczyty i testy). Wejście na niego nie łączy się ze sklepami ani przewoźnikami i niczego nie zmienia; test połączenia uruchamiasz na ekranie konta. BaseLinker i wFirma pokazują się tylko u firmy, która je ma; firma bez nich widzi program do faktur jako „Bez programu do faktur” i KSeF jako drogę bez programu księgowego. Logo marek pochodzą z plików Simple Icons (CC0), marki bez pliku mają ikonę rodzaju (sklep, paczka, dokument).

Czego ten ekran nie robi: nie zmienia kluczy ani trybów (to robią ekrany pod „Zarządzaj”), nie wyłącza integracji i nie pokazuje historii odczytów.

## Limity zapytań i automatyczne wyłączanie

**Limity.** Każda platforma ogranicza, ile zapytań na minutę przyjmie od jednego konta. Kompletor pilnuje tych limitów sam: dla całego konta (np. Allegro 300 na minutę, Empik 30) i dla pojedynczych czynności, gdy platforma ma osobny limit (Wysyłam z Allegro: tworzenie przesyłek 120 na minutę; InPost: tworzenie przesyłek 30 na minutę; Empik: wysyłka stanów raz na minutę). Gdy limit się wyczerpie, nic nie przepada: zapis (stan, status, przesyłka) czeka i idzie sam po kilku sekundach albo minucie, bez liczenia jako nieudana próba, a odczyt zamówień chwilę zwalnia. Gdy platforma odpowie „za dużo zapytań” i poda, ile czekać, Kompletor czeka co najmniej tyle. Wysyłam z Allegro liczy się do tego samego limitu co konto Allegro (ten sam token). Wyjątek: przesyłka utworzona przyciskiem „Utwórz przesyłkę” ponad limit nie powstaje i dostaje komunikat „Limit tempa przewoźnika … kliknij ponownie za N s”; ponowne kliknięcie nie utworzy drugiej paczki.

**Automatyczne wyłączanie.** Konto sklepu albo przewoźnika, które raz za razem odrzuca klucz, hasło albo token (albo ma złe ustawienia), Kompletor wyłącza samo po 5 takich błędach z rzędu (liczbę zmienisz w Ustawienia → Komunikacja i poczta → Powiadomienia → „Automatyczne wyłączanie integracji”, od 2 do 50). Liczą się tylko odrzucone dane logowania, złe ustawienia konta i nieudany test połączenia (także test, który nie przeszedł z powodu sieci: pięć nieudanych testów z rzędu też wyłącza konto). Brak klucza ZAPISU (np. osobnego klucza zapisu Woo przy włączonym zapisie) nie wyłącza odczytu: zapis dostaje błąd z alertem, a zamówienia dalej się czytają. Chwilowe przerwy w sieci przy zwykłej pracy, „za dużo zapytań” i błąd pojedynczego zamówienia czy przesyłki (np. zły kod pocztowy) się nie liczą, a każde udane połączenie zeruje licznik.

Co się dzieje po wyłączeniu:

- Kompletor przestaje wołać to konto: nie czyta zamówień i nie wysyła stanów, statusów ani przesyłek. Zamówienia, rezerwacje i stany w Kompletorze zostają bez zmian, a zapisy czekają w kolejce.
- Pojawia się jeden alert „Integracja wyłączona po błędach połączenia” (na liście alertów i na Zulipie, jeśli masz powiadomienia).
- Na liście Ustawienia → Sprzedaż i kanały → Kanały sprzedaży konto ma odznakę „wyłączone po błędach”, a na ekranie konta (i w Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników”) jest czerwony baner z powodem.

Jak włączyć: popraw klucze albo adres i kliknij **„Włącz ponownie”** na banerze. Zapis nowych kluczy albo ustawień konta i zakończone „Połącz z Allegro” / „Połącz z WooCommerce” same zlecają to sprawdzenie. Gdy sprawdzenie nie da wyniku w 5 minut (np. przerwa w pracy serwera), przycisk znowu jest aktywny. Kompletor najpierw sprawdza połączenie. Gdy działa, konto wraca do pracy dokładnie w tym trybie co przedtem (tryb, włączony zapis i ustawienia się nie zmieniają), a czekające zapisy idą same. Gdy test nie przejdzie, konto zostaje wyłączone, a baner mówi, na którym kroku padło (ustawienia konta albo test połączenia).

Czego to nie robi: nie kasuje konta ani jego ustawień i nie zmienia trybu „Tylko podgląd” / „Aktywny”. Programy do faktur wFirma i KSeF mają własne zabezpieczenia (alert przy limicie i złej konfiguracji) i nie wyłączają się same.

## Gdzie wpisujesz klucze

- Sklepy (WooCommerce, Shoper, PrestaShop, IdoSell, Allegro, Empik): Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → „Dodaj sklep” (albo „Podłącz” na ekranie Integracje) → kafel platformy. Formularz pokazuje tylko adres i klucze, rzadkie ustawienia są w „Zaawansowane” z wartościami domyślnymi. Po zapisie Kompletor od razu sprawdza połączenie i pokazuje wynik na ekranie konta. Allegro zamiast kluczy konta ma przycisk „Połącz z Allegro”, a WooCommerce przycisk „Połącz z WooCommerce” (klucze zapisują się same, ręczne wklejenie zostaje jako druga droga).
- BaseLinker, wFirma i Base Courier: poleceniem w kontenerze. Wartość podajesz na wejściu polecenia, więc nie zostaje w historii powłoki:

  ```
  docker compose exec -T web kompletor sekret --firma <skrót firmy> --ustaw BASELINKER_TOKEN --ze-stdin < token.txt
  ```

  Skrót firmy pokaże `docker compose exec web kompletor org list`. Listę zapisanych kluczy (same nazwy, bez wartości) pokaże `--lista`. Po wpisaniu usuń plik z kluczem.

## WooCommerce

### Połącz z WooCommerce (bez kopiowania kluczy)

Najprościej: **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → Dodaj sklep → WooCommerce**, wpisz nazwę i adres sklepu i kliknij **Połącz z WooCommerce**.

1. Otworzy się strona Twojego sklepu „Kompletor chce połączyć się z Twoim sklepem”. Zaloguj się jako administrator sklepu.
2. Sprawdź, o jakie uprawnienia prosimy (przy zwykłym połączeniu: **Odczyt**) i kliknij **Zatwierdź**.
3. Sklep sam przekaże Kompletorowi klucz REST API (zapisujemy go zaszyfrowany) i wróci na ekran konta. Ekran od razu sprawdza połączenie.

Gdy konto już istnieje, ten sam przycisk jest na ekranie konta w sekcji **„Połączenie ze sklepem”** (tam też „Połącz ponownie”, gdy klucz został usunięty w WordPressie). Link do sklepu jest ważny 15 minut i działa raz; „Anuluj” przerywa łączenie, a zapisane wcześniej klucze działają dalej. Konto w wersji z zapisem ma drugi przycisk, **„Połącz z prawem zapisu”**: daje osobny klucz z prawem zapisu, a sam zapis do sklepu i tak rusza dopiero po włączeniu w sekcji „Zapis do sklepu”.

Czego ten przycisk nie robi: niczego nie zmienia w sklepie poza dodaniem klucza REST API, który widzisz potem w WooCommerce → Ustawienia → Zaawansowane → REST API (opis „Kompletor”) i możesz w każdej chwili usunąć.

**Kiedy przycisk jest wyszarzony:** sklep odsyła klucze na adres panelu, więc panel musi mieć publiczny adres `https://` (ustawienie `PANEL_URL` instalacji). Bez niego (np. Kompletor uruchomiony tylko na komputerze w biurze) ekran pokazuje powód, a klucze wklejasz ręcznie, jak niżej.

### Klucze ręcznie

Potrzebujesz adresu sklepu oraz klucza i sekretu REST API. W kreatorze kliknij „Mam już klucze REST API (wklejam ręcznie)”, a na ekranie konta wklej je w „Ustawienia i klucze”.

1. W panelu WordPressa: WooCommerce → Ustawienia → Zaawansowane → REST API → „Dodaj klucz”.
2. Opis: na przykład „Kompletor”. Użytkownik: administrator sklepu.
3. Uprawnienia: **Odczyt**. Do zapisu stanów i statusów dodajesz później osobny klucz z prawem zapisu ([Zapis do sklepu WooCommerce](woocommerce.md)).
4. Skopiuj klucz klienta (`ck_…`) i sekret (`cs_…`). Sekret WooCommerce pokazuje tylko raz.

Zamiast klucza REST możesz podać login użytkownika WordPressa i jego hasło aplikacji. Klucz REST z uprawnieniem „Odczyt” jest bezpieczniejszy.

### Pola zamówienia: NIP, punkt odbioru, „chcę fakturę”

Sklepy zapisują NIP, kod paczkomatu i zaznaczenie „chcę fakturę” w polach dodatkowych zamówienia, każda wtyczka pod własną nazwą (np. `_billing_nip`, `_paczkomat_id`). Przy **„Sprawdź połączenie”** Kompletor czyta same **nazwy** tych pól z 10 ostatnich zamówień (bez ich treści i bez danych klientów), a sekcja **„Pola zamówienia”** na ekranie konta podpowiada: „Wykryliśmy `_billing_nip` (w 7 z 10 zamówień) · Użyj”. Nic nie zapisuje się samo: ustawienie zmienia dopiero kliknięcie „Użyj”. Pełną listę wykrytych nazw pokazuje „Wszystkie pola z ostatnich zamówień”; inną nazwę wpiszesz w „Ustawienia i klucze” → „Zaawansowane”. Podpowiedź pomija pola, które wyglądają na numer wystawionej faktury albo numer przesyłki.

## Allegro

Konto Allegro łączysz z panelu, bez terminala: Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → Dodaj sklep → Allegro, potem „Połącz z Allegro”. Pełny opis z zakresami i odnowieniem dostępu: [Allegro: połączenie z panelu](allegro.md).

Kompletor używa **własnej** aplikacji Allegro i własnej pary tokenów. Nie kopiuj tokenów z BaseLinkera ani z innego programu: Allegro unieważnia stary token po odświeżeniu, więc dwa programy na jednej parze psują sobie nawzajem dostęp. Polecenie `allegro-autoryzuj` na serwerze zostaje jako alternatywa dla administratora.

## Empik (Mirakl)

Potrzebujesz adresu API Empiku i klucza API sklepu.

- Klucz znajdziesz w panelu sprzedawcy Mirakl, w ustawieniach swojego użytkownika, w części „Klucz API” `[do potwierdzenia]`.
- **Użyj istniejącego klucza. Nie generuj nowego.** Nowy klucz może unieważnić stary, a z niego korzysta Twój obecny system (na przykład BaseLinker) `[do potwierdzenia]`.
- Konto zwykłe („Empik Marketplace (Mirakl)”) wysyła do Empiku tylko zapytania odczytu. Konto „z zapisem za wyłącznikiem” przyjmuje zamówienia, wysyła stany, numer nadania i „wysłane”, ale dopiero w trybie pracy i z włączonym „Zapis do sklepu”. Szczegóły: [Empik](empik.md).

## Base Courier

Potrzebujesz e-maila konta Base Courier i klucza API. Klucz znajdziesz w panelu Base Courier, w części Konfiguracja API `[do potwierdzenia]`.

Moduł zwykły („Base Courier (InPost, DPD)”) sprawdza tylko połączenie i liczy parametry paczki. Moduł „z tworzeniem przesyłek” tworzy przesyłki, pobiera etykiety i anuluje, ale tylko z włączonym nadawaniem w regule przewoźnika i dla konta w trybie „praca”: [Base Courier](basecourier.md). **Użyj istniejącego klucza, nie generuj nowego** `[do potwierdzenia]`: nowy może odciąć BaseLinkera.

## wFirma

Potrzebujesz czterech wartości: klucz dostępu (`WFIRMA_ACCESS_KEY`), klucz tajny (`WFIRMA_SECRET_KEY`), klucz aplikacji (`WFIRMA_APP_KEY`) i numer firmy w wFirmie (`WFIRMA_COMPANY_ID`).

- Klucze API tworzysz w wFirmie w ustawieniach bezpieczeństwa, w części aplikacji i kluczy API `[do potwierdzenia]`.
- Klucz aplikacji wydaje wFirma `[do potwierdzenia]`.
- Kompletor wysyła do wFirmy tylko zapytania odczytu (wyszukanie i pobranie). Gdy wFirma odpowie, że przekroczono limit zapytań, Kompletor nie ponawia od razu, żeby nie zabrać limitu programowi, który wystawia u Ciebie faktury.

Magazyn wFirmy, z którego Kompletor bierze stany, wskazujesz w konfiguracji firmy. Program do faktur i to, kto prowadzi stan magazynu, wybierasz w **Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży** ([Stan magazynu i dokumenty sprzedaży](../dokumenty-sprzedazy.md)). wFirma jest opcjonalna: firma bez niej wysyła i zamyka zamówienia bez faktury.

## Jak dopisać program do faktur

Program do faktur (Fakturownia, inFakt, iFirma i inne) to integracja rodzaju `invoicing`. Dopisujesz go jednym plikiem adaptera w `lib/adaptery/` i wpisem w rejestrze (`lib/adaptery/domyslne.ts`), bez zmian w rdzeniu:

1. Manifest: `kind: 'invoicing'`, klucz w formacie `<dostawca>.v<wersja>` (np. `fakturownia.v1`), pola konfiguracji i sekrety (klucz API programu).
2. Zdolności, które program umie, każda opcjonalna: `invoice.prepare` (treść bez wystawiania), `invoice.issue` (wystawienie), `invoice.find` (odszukanie po referencji Kompletora, obowiązkowe przy `invoice.issue`), `invoice.correct` (korekta), `invoice.pdf` (PDF). Do każdej zdolności metoda z `lib/adaptery/kontrakt.ts` (`issueInvoice`, `findInvoices`, `correctInvoice`, `getInvoicePdf`).
3. Wynik wystawienia: `OK` (numer dokumentu), `ERROR` (program odmówił, dokument nie powstał), `TIMEOUT` (nie wiadomo; Kompletor odszuka dokument po referencji zamiast wystawiać drugi), `LIMIT` (limit zapytań programu).
4. Adapter tylko do odczytu (`readOnly: true`) nie może deklarować wystawiania ani korekty: rejestr go odrzuci.

Kompletor owija adapter w „dostawcę dokumentów sprzedaży” (`lib/dokumenty/kontrakt.ts`), a program pojawia się na liście w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży. Wzór testu: `lib/dokumenty/dokumenty.test.ts` (atrapa programu z wystawianiem, odszukaniem i PDF).

## BaseLinker

Potrzebujesz tokena API BaseLinkera i numeru katalogu produktów (inventory).

- Token tworzysz w BaseLinkerze w ustawieniach konta, w części API `[do potwierdzenia]`.
- Kompletor wywołuje tylko metody odczytu (`get…`). Wywołania zapisu są zablokowane w kodzie.
- BaseLinker jest potrzebny tylko przy przejściu: import katalogu i porównanie. Opis w [Migracji z BaseLinkera](../migracja-z-baselinkera.md).

## Co działa tylko na podgląd

Shoper, PrestaShop i IdoSell są sprawdzone tylko na symulowanym sklepie; przed pierwszym prawdziwym sklepem przechodzą listę z ich opisów. KSeF bez wFirmy składa fakturę na podgląd i niczego nie wysyła. Bezpośredni InPost i DPD oraz Wysyłam z Allegro nadają przesyłki dopiero z modułem „z nadawaniem” i włączonym wyłącznikiem w regule przewoźnika ([Przesyłki](../przesylki.md), [Allegro](allegro.md)); bez tego tylko liczą przesyłkę. Gdy to się zmieni, ten dokument i [Co jeszcze nie działa](../co-jeszcze-nie-dziala.md) powiedzą to wprost.
