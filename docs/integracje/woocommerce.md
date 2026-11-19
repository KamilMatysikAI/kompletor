# Sklep WooCommerce: zapis stanów, statusów i numerów nadania

> **Stan na 06.11.2026: przygotowane, sprawdzone na symulowanym sklepie.** Zapis do prawdziwego sklepu włącza się dopiero po decyzji właściciela firmy. Domyślnie każde konto tylko czyta.

Ten opis jest dla osoby, która prowadzi sklep na WooCommerce i chce, żeby Kompletor sam aktualizował w nim stany, statusy zamówień i numery nadania (to samo, co robi BaseLinker albo inny system do zamówień). Odczyt zamówień opisuje [Integracje](README.md), sekcja „WooCommerce”.

## Co Kompletor wysyła do sklepu

| Co | Kiedy | Jak wygląda w sklepie |
|---|---|---|
| Stan oferty | Gdy zmieni się stan dostępny produktu (zamówienie, dostawa, korekta). Spadek idzie od razu, wzrost po najbliższym odczycie zamówień ze sklepu, żeby nie podnieść stanu, który sklep właśnie zdjął. W praktyce do minuty, najpóźniej kilka minut. Raz na dobę, w nocy, wszystkie oferty jeszcze raz. | „Stan magazynowy” produktu albo wariantu. Kompletor zmienia tylko liczbę sztuk: nie włącza zarządzania stanem, nie zmienia cen ani opisów. |
| Status zamówienia | Po zmianie statusu w Kompletorze, według tabeli „Statusy w sklepie” na ekranie konta. | Status zamówienia, na przykład „Zrealizowane”. Sklep sam wysyła wtedy klientowi swój mail o zmianie statusu, jeśli ma go włączonego. |
| Anulowanie nieopłaconego | Gdy rezerwacja nieopłaconego zamówienia wygaśnie po terminie. | Status „Anulowane”, ale tylko wtedy, gdy sklep nadal nie widzi płatności. Opłacone w międzyczasie zamówienie zostaje bez zmian, a w Kompletorze pojawia się błąd do sprawdzenia. |
| Numer nadania | Gdy przesyłka dostanie numer nadania albo gdy ktoś wpisze numer przy „Wysłane”. | Prywatna notatka zamówienia „Numer nadania: … (przewoźnik)”. Opcjonalnie: notatka dla klienta (sklep wyśle mu mail) albo pole wtyczki śledzenia przesyłek. |

Statusów zamkniętych w sklepie (anulowane, zwrócone, nieudane) Kompletor nie nadpisuje i nie cofa statusu na wcześniejszy (np. z „Zrealizowane” na „W trakcie realizacji”). Dopóki zapis jest wyłączony, Kompletor nie zbiera zaległych zmian statusów: po włączeniu idą tylko te z ostatnich 2 dób. Ten sam numer nadania nie trafia do zamówienia dwa razy.

## Czego Kompletor nie wysyła

- Cen, opisów, zdjęć i nowych produktów.
- Danych klientów: notatka zawiera tylko numer nadania i nazwę przewoźnika.
- Niczego, gdy konto jest w trybie podglądu albo ma wyłączony zapis.

## Jak włączyć zapis

Wszystko na ekranie: **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto sklepu → sekcja „Zapis do sklepu”**. Ekran widzi osoba z uprawnieniem do ustawień.

1. **Przełącz na wersję z zapisem.** Przycisk „Przełącz na wersję z zapisem” zmienia rodzaj konta na „WooCommerce (REST v3, z zapisem za wyłącznikiem)”. Odczyt zamówień działa dalej tym samym kluczem. Zapis zostaje wyłączony. Wrócić możesz w każdej chwili: na dole tej samej sekcji przycisk **„Przełącz na wersję tylko do odczytu”** (z potwierdzeniem) zostawia klucze, ustawienia i odczyt zamówień bez zmian, a zapis wyłącza. Obie zmiany trafiają do dziennika zmian konta.
2. **Dodaj osobny klucz z prawem zapisu.** Najprościej: w sekcji „Połączenie ze sklepem” kliknij **„Połącz z prawem zapisu”** i zatwierdź w sklepie uprawnienia **Odczyt/Zapis**; klucz zapisze się sam w polach klucza zapisu. Ręcznie: w panelu WordPressa: WooCommerce → Ustawienia → Zaawansowane → REST API → „Dodaj klucz”, opis na przykład „Kompletor zapis”, uprawnienia **Odczyt/Zapis**. Klucz (`ck_…`) i sekret (`cs_…`) wklej w sekcji „Ustawienia i klucze” konta, w polach klucza zapisu (w „Zaawansowane”), i kliknij „Zapisz zmiany”. Klucz tylko do odczytu zostaje bez zmian: jeśli zapis będzie trzeba szybko zatrzymać, wystarczy usunąć w sklepie klucz zapisu.
3. **Sprawdź tabelę „Statusy w sklepie”.** Domyślnie: „Wysłane” i „Odebrane” → Zrealizowane, „Anulowane” i „Anulowane: brak płatności w terminie” → Anulowane. Puste pole = tego przejścia nie wysyłamy. Sklep z wtyczką własnych statusów: wybierz go z listy, a jeśli go nie ma, poproś administratora o wpisanie identyfikatora statusu.
4. **Numer nadania.** W ustawieniach konta: „numer nadania jako notatka” (domyślnie tak), „notatka widoczna dla klienta” (domyślnie nie) i opcjonalnie nazwa pola wtyczki śledzenia (na przykład `_tracking_number`).
5. **Podgląd.** W trybie podglądu tabela „Ostatnie zapisy” pokazuje, co byśmy wysłali („wysłałbym”), a licznik „policzone w podglądzie” ile stanów. Porównaj to z tym, co robi obecny system.
6. **Włącz zapis.** W sekcji „Zapis do sklepu” kliknij **Włącz zapis do sklepu** (pyta o potwierdzenie; nieaktywny z powodem, dopóki nie ma klucza zapisu; uprawnienie „Zmiana trybu kanału”), a tryb pracy dla stanów, statusów i numerów nadania włączasz w sekcji „Stan konta” → **Włącz tryb pracy** (opis: [Tryb praca](../tryb-praca.md)). Zapis ustawień konta wyłącznika nie zmienia. Od tej chwili Kompletor pisze do sklepu, a obecny system (np. BaseLinker) trzeba w tym samym czasie wyłączyć dla tego sklepu, żeby dwa programy nie ustawiały stanów naraz.

## Co, gdy coś nie wyjdzie

- **Sklep nie odpowiada albo prosi o przerwę (błąd chwilowy):** Kompletor ponawia sam, z coraz dłuższą przerwą.
- **Błąd stały** (zły klucz, brak produktu w sklepie): zapis zatrzymuje się, w tabeli „Ostatnie zapisy” jest powód, a w alertach wpis. Popraw przyczynę i kliknij „Wypchnij teraz”.
- **Niepewne:** sklep przyjął żądanie, ale nie odpowiedział i nie da się sprawdzić, czy zmiana weszła. Kompletor nie ponawia sam, żeby nie zrobić czegoś dwa razy. Sprawdź zamówienie w sklepie i kliknij „Wypchnij teraz”: przed zmianą sklep zostanie najpierw odczytany, więc gotowa zmiana nie pójdzie drugi raz.
- **„Wypchnij teraz”** wysyła od nowa stany wszystkich ofert konta (także te, które sklep już ma) i ponawia zapisy z błędem albo niepewne z ostatnich 2 dób. Starsze zostają na liście do podglądu i nie idą już do sklepu.
- Kompletor nie cofa statusu w sklepie: jeśli zamówienie poszło dalej (np. już „Zrealizowane”), wcześniejszy status z kolejki zostaje pominięty.

## Dla administratora

- Rodzaj konta: `woo.rest.zapis.v1`. Klucze zapisu: sekrety konta `WOO_WRITE_KEY` i `WOO_WRITE_SECRET` (self-host: `<przedrostek>_WRITE_KEY`, `<przedrostek>_WRITE_SECRET`). Ustawienia: `zapisWlaczony`, `nadanieNotatka`, `nadanieDlaKlienta`, `nadanieMetaKlucz`; mapa statusów w `config.statusy`.
- Zapis idzie wyłącznie ścieżkami `POST /products/batch`, `POST /products/<id>/variations/batch`, `PUT /orders/<id>`, `POST /orders/<id>/notes` (paczki po 100 pozycji). Bez `zapisWlaczony` i klucza zapisu adapter nie wysyła żadnego żądania zapisu.
- Tryby konta (`stockMode`, `statusMode`, `trackingMode`) przełącza sekcja „Stan konta” (uprawnienie „Zmiana trybu kanału”); nowe konto startuje w podglądzie (`domyslnyTryb()` w `lib/kanaly/tryb.ts`).
- „Połącz z WooCommerce”: protokół WooCommerce `/wc-auth/v1/authorize` (`scope` `read` albo `read_write`, `app_name` „Kompletor”). `callback_url` = `<APP_PUBLIC_URL albo PANEL_URL>/api/kanaly/woo/klucze` (tylko https, ścieżka otwarta w bramce Basic Auth i bez sesji, bo POST wysyła serwer sklepu), `return_url` = ekran konta z `?woo=powrot`. `user_id` to podpisany HMAC (klucz wyprowadzony HKDF z najnowszego klucza `APP_ENCRYPTION_KEYS`) znacznik `{firma, konto, losowy znacznik, termin 15 min}`; znacznik leży w zaszyfrowanym sekrecie konta `WOO_AUTORYZACJA` i jest kasowany przy przyjęciu kluczy (pod blokadą wiersza: drugi POST z tym samym `user_id` dostaje 409). Uprawnienia klucza muszą być równe zakresowi z prośby, a klucz i sekret mieć kształt `ck_…`/`cs_…`; odrzucony klucz od podpisanego sklepu kończy łączenie (znacznik skasowany, wynik w historii zmian konta, komunikat na ekranie konta). `read` → `WOO_CONSUMER_KEY`/`_SECRET`; `read_write` → `WOO_WRITE_KEY`/`_SECRET` (i klucz odczytu, gdy konto go nie ma). Ten klucz odczytu trafia do bazy niezależnie od `envPrefix`, a sekret konta w bazie ma pierwszeństwo przed env (`resolveSecrets`), więc konto, które dotąd czytało klucze z env, po „Połącz” z zapisem czyta kluczem z tego połączenia (ten sam sklep). POST przychodzi wyłącznie jako JSON (`WC_Auth::post_consumer_data`: `wp_json_encode`, `Content-Type: application/json`), inny format = 400. Kolejność sprawdzeń: typy pól, podpis `user_id` (403), kształt kluczy (400), termin (410). WooCommerce oddaje `user_id` w POST bez zmian, a w `return_url` po `wc_clean` (nasz format `[A-Za-z0-9._-]` przechodzi bez zmian); `return_url` dostaje `success=1&user_id=…`, odmowa w sklepie wraca z `success=0`. Odpowiedź inna niż 200 = WooCommerce kasuje klucz po swojej stronie. Wpisy w `AuditLog` (`wooAutoryzacja`: rozpoczęta, anulowana, zapisana, wygasl, zle-uprawnienia) bez wartości kluczy. Nasz serwer przy łączeniu nie wysyła żadnego zapytania do sklepu.
- Pola zamówienia: test połączenia czyta `GET /orders?per_page=10&orderby=date&order=desc&_fields=id,meta_data.key` i zapisuje same nazwy kluczy z liczbą wystąpień w `ChannelAccountStatus.testMetaKeys` (`{ sample, keys: [{ key, orders }], at }`); nieudany test ich nie kasuje. „Użyj” (`uzyjPolaMeta`) przyjmuje tylko nazwę z tej listy i tylko pola `nipMetaKey`, `pickupPointMetaKey`, `invoiceMetaKey`.
- Wynik każdego zapisu statusu i numeru nadania: tabela `ChannelWrite` (stan, błąd, liczba prób); stanów: `ChannelPushLog` i `StockSyncJob`.
- Zdarzenie „numer nadania gotowy” od przesyłek: wpis `AuditLog` z `entity = NUMER_NADANIA_GOTOWY` (pola `orderId`, `trackingNumber`, `carrier`).
