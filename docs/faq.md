# Pytania i odpowiedzi

Krótkie odpowiedzi na pytania, które sprzedawcy zadają najczęściej przed instalacją.

## Czy Kompletor jest darmowy?

Kod jest udostępniony na licencji AGPL-3.0. Za samo korzystanie nie płacisz.

- **Firma, która używa Kompletora u siebie:** możesz go zainstalować, używać i zmieniać na własne potrzeby. Nie musisz nikomu pokazywać swoich ustawień ani danych.
- **Ktoś, kto udostępnia zmienioną wersję innym jako usługę przez sieć:** musi dać użytkownikom tej usługi dostęp do kodu źródłowego swojej zmienionej wersji, na tej samej licencji.

To skrót, a nie porada prawna. Wiążąca jest treść licencji w pliku `LICENSE`.

## Jak powiązać produkt z ofertą sklepu (jak „Powiąż z produktami ze sklepu” w BaseLinkerze)?

Na karcie produktu: zakładka **„Powiązania”** → „Powiąż z ofertą”, wyszukaj ofertę po SKU, nazwie, EAN albo numerze
i kliknij „Powiąż”. Tam też odłączysz ofertę albo przepniesz ją na inny produkt („Przepnij na inny produkt” → wyszukaj
produkt → „Przepnij na ten”). Zmiany robi osoba z uprawnieniem „Dodawanie i edycja produktów” (rola Biuro). Wiele ofert naraz (po SKU albo EAN,
z podglądem) łączysz w **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → konto → „Łączenie ofert z produktami”. Gdy SKU różni się
od kodu towaru w wFirmie, towar wskażesz w tej samej zakładce „Powiązania”. Szczegóły: [Produkty](produkty.md), sekcja „Powiązania”.

## Oferty Allegro bez SKU: skąd Kompletor bierze SKU i EAN i jak je połączyć?

SKU oferty Allegro to jej **sygnatura** (pole „Sygnatura” w ofercie). Oferty powiązane z towarem tylko w BaseLinkerze często jej nie mają i po „Pobierz oferty” stoją jako „oferta bez SKU w kanale”. EAN Kompletor bierze z produktu oferty w katalogu Allegro (parametr „EAN (GTIN)”): przy „Pobierz oferty” czyta szczegóły ofert bez powiązania, najwyżej 200 na jedno pobranie, reszta przy kolejnym. Potem w **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → konto Allegro → „Łączenie ofert z produktami” kliknij **„Podgląd: po EAN”**: oferty z EAN-em, który ma dokładnie jeden aktywny produkt, są w „Połączy”, a lista „Bez pasującego produktu” podaje przy każdej ofercie powód (brak SKU i EAN, brak produktu o tym SKU albo o tym EAN). Te przypiszesz ręcznie w „Do przypisania” na tym samym ekranie. Na stałe pomaga wpisanie sygnatury (SKU produktu) w ofercie w Allegro. Szczegóły: [Allegro](integracje/allegro.md), sekcja „Skąd Kompletor bierze SKU i EAN oferty Allegro”.

## Czy moje dane wychodzą na zewnątrz?

Kompletor łączy się tylko z systemami, które sam skonfigurujesz: sklepy, BaseLinker, wFirma, Base Courier, opcjonalnie Zulip (powiadomienia). Systemy zewnętrzne czytają dane tylko kluczem, który sam wydasz w Ustawienia → Integracje i agenci AI → Klucze API. Nie wysyła danych do nas ani do usług analitycznych. Wysyłanie danych telemetrycznych Next.js i Prismy jest wyłączone w obrazie. Panel nie ładuje skryptów ani czcionek z zewnętrznych serwerów.

## Gdzie są dane moich klientów?

Dane klienta zamówienia (imię i nazwisko, adres, telefon, e-mail, dane do faktury) Kompletor zapisuje w bazie zaszyfrowane osobnym kluczem, gdy administrator włączy zapis. Widzą je tylko osoby z uprawnieniem, każdy podgląd jest w dzienniku, a po terminie przechowywania dane można usuwać. Szczegóły: [Dane klienta w zamówieniu](dane-klienta.md).

Wszystko, co Kompletor zapisuje, leży w bazie na Twoim serwerze.

## Co jeśli padnie serwer?

- Zamówienia w sklepach się nie gubią. Po powrocie Kompletor doczytuje zmiany od miejsca, w którym skończył.
- Kompletor nie steruje dziś sklepami, więc awaria nie zatrzymuje sprzedaży ani wysyłek. Te robi dalej Twój obecny system.
- Dane odzyskasz z kopii zapasowej. Jak ją robić: [Instalacja](instalacja.md), sekcja „Kopie zapasowe”.

## Czy mogę wrócić do BaseLinkera?

Tak. Kompletor niczego w BaseLinkerze nie zmienia, więc BaseLinker cały czas pracuje jak dotąd. Wystarczy zatrzymać Kompletora. Opis w [Migracji z BaseLinkera](migracja-z-baselinkera.md).

## Czy działa bez wFirmy?

Częściowo. Odczyt zamówień i rezerwacje działają. Stan startowy bierzesz z kanału przy pobraniu ofert, a zmiany stanu wpisujesz ręcznie („Korekta stanu” na karcie produktu). Zwykły import katalogu z BaseLinkera wymaga wFirmy; przeprowadzka z BaseLinkera (`npm run przeprowadzka`, opis w `docs/przeprowadzka-z-baselinkera.md`) przenosi produkty i stany także bez niej. Faktur Kompletor dziś nie wystawia w żadnym wariancie; bez wFirmy składa tylko szkic faktury FA(3) na podgląd ([KSeF bez wFirmy](integracje/ksef.md)).

## Ile sklepów mogę podłączyć?

Kod nie ma limitu liczby sklepów. Każdy sklep to osobne konto kanału z własnymi kluczami. Kilka sklepów WooCommerce albo kilka kont Allegro to kilka kont.

## Muszę kopiować klucze z WooCommerce?

Nie. Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → Dodaj sklep → WooCommerce: wpisz adres sklepu i kliknij „Połącz z WooCommerce”, zaloguj się w WordPressie i kliknij „Zatwierdź”. Klucze zapiszą się same. Działa, gdy panel ma publiczny adres `https://`; bez niego przycisk jest wyszarzony i klucze wklejasz ręcznie. Opis: [Integracje](integracje/README.md), sekcja „WooCommerce”. Nazwy pól z NIP-em, paczkomatem i „chcę fakturę” Kompletor podpowiada sam po „Sprawdź połączenie” (sekcja „Pola zamówienia” na ekranie konta).

## Ile zamówień obsłuży?

Kod nie ma limitu liczby zamówień. Ograniczeniem są moc serwera i limity zapytań po stronie sklepów, które Kompletor szanuje. Dla dużych firm sprawdź wydajność na swoim serwerze w trybie „Tylko podgląd”, zanim cokolwiek zmienisz.

## Czy Kompletor ma funkcje AI?

Nie. W tej wersji panel nie ma żadnych funkcji AI.

## Ile osób może pracować w panelu?

Bez limitu w kodzie. Każda osoba ma własne konto, rolę i uprawnienia. Opis ról w [Konfiguracji](konfiguracja.md).

## Jak zgłosić błąd?

Zgłoś go w repozytorium projektu jako zgłoszenie (issue). Napisz, co zrobiłeś, czego oczekiwałeś i co się stało. Dołącz wynik `curl http://127.0.0.1:3000/api/health` i fragment logu (`docker compose logs web` albo `docker compose logs worker`).

Nie wklejaj kluczy, haseł ani danych klientów. Lukę bezpieczeństwa zgłoś zgodnie z plikiem `SECURITY.md`, a nie w publicznym zgłoszeniu.

## Czego jeszcze nie ma?

Pełna lista: [Co jeszcze nie działa](co-jeszcze-nie-dziala.md).
