# Orlen Paczka bezpośrednio

Dla sprzedawcy, który ma własną umowę z Orlen Paczką i chce nadawać paczki do punktów i automatów Orlen Paczki prosto z Kompletora, bez pośrednika. Orlen Paczka dowozi tylko do punktu albo automatu (stacje Orlen, automaty, kioski partnerskie), nie pod adres klienta.

Stan: moduł napisany i sprawdzony na atrapie usługi Orlen Paczki. Na koncie testowym Orlen Paczki jeszcze nie: lista rzeczy do sprawdzenia jest na końcu.

## Co system robi

- **Liczy przesyłkę** na karcie zamówienia (Zamówienia → numer zamówienia → sekcja „Przesyłka”): rozmiar S, M albo L, kod punktu odbioru, wagę. Pilnuje limitów Orlen Paczki: do 20 kg, rozmiar S (8×38×60 cm), M (19×38×60 cm), L (41×38×60 cm).
- **Sprawdza połączenie** z kontem (Ustawienia → Wysyłka i druk → Przewoźnicy → przycisk „Konta przewoźników” → konto „Orlen Paczka” → „Sprawdź połączenie”): pyta Orlen Paczkę o stan konta, bez danych klientów.
- **Nadaje paczkę** (moduł „Orlen Paczka (bezpośrednio, nadawanie za wyłącznikiem)”): przycisk „Utwórz przesyłkę: Orlen Paczka S / M / L” na karcie zamówienia. Kompletor zapisuje numer paczki (13 cyfr, zaczyna się od 21), pobiera etykietę (PDF albo ZPL dla drukarki termicznej) i ustawia „Do wysłania”. Orlen Paczka wydaje etykietę zwykle kilkadziesiąt sekund po nadaniu: gdy jej jeszcze nie ma, przesyłka jest utworzona, a „Pobierz etykietę” spróbuje ponownie.
- **Anuluje paczkę** u Orlen Paczki przyciskiem „Anuluj przesyłkę”, dopóki paczka nie trafiła do sieci Orlen Paczki.
- **Nie robi drugiej paczki**, gdy Orlen Paczka nie odpowie przy nadaniu. Na etykiecie każdej paczki z Kompletora, w danych referencyjnych nadawcy, jest odcisk referencji przesyłki (`KMP…`, 30 znaków). Kompletor przegląda etykiety paczek nadanych w ostatnich dniach i szuka tego odcisku. Gdy go nie znajdzie, przesyłka czeka na człowieka („Sprawdź u przewoźnika”, „Rozstrzygnij ręcznie”), a system nie nada jej drugi raz.
- **Pokazuje zmianę punktu odbioru.** Gdy Orlen Paczka zapisze paczkę z innym kodem punktu niż wybrany (kody 006–008: lista punktów w Kompletorze była nieaktualna), przesyłka powstaje normalnie, a karta zamówienia pokazuje w sekcji „Przesyłka” wiersz „Uwaga przewoźnika” z oboma kodami i to samo w historii zamówienia. Ten sam numer punktu z innym kodem (np. `XX-116263-00-00` → `WS-116263-C3-01`) to ten sam punkt; inny numer to inny punkt i warto uprzedzić klienta.

## Przesyłka „nie wiadomo, czy powstała”: co porównać

Paczek nadanych przez Kompletor (API Orlen Paczki, numery od 21) **nie widać w panelu Orlen Paczki** (WebTrucker, manager.orlenpaczka.pl), a paczek z WebTruckera nie widać przez API (pkt 3.2 dokumentacji Orlenu). Brak paczki w WebTruckerze niczego więc nie dowodzi; „Nie powstała” wybrane na tej podstawie może skończyć się drugą, płatną paczką.

Co zrobić (karta zamówienia → sekcja „Przesyłka”):

1. Kliknij **„Sprawdź u przewoźnika”**. Kompletor pobiera z Orlen Paczki listę paczek nadanych przez API konta firmy od przedwczoraj do jutra i czyta etykiety 10 najnowszych. Jeśli na którejś jest odcisk referencji tej przesyłki, zapisuje paczkę sam.
2. Jeśli nie znajdzie, komunikat pokazuje okno dni i wykaz sprawdzonych paczek: numer i godzinę nadania (np. `2100000000012 08.11 10:59`), bez danych odbiorców, oraz liczbę starszych, których nie sprawdzał.
3. Porównaj ten wykaz z przesyłkami w Kompletorze (Zamówienia → pole wyszukiwania: wpisz numer paczki, lista pokaże zamówienie z tą przesyłką). Paczka z wykazu, która nie ma zamówienia w Kompletorze, nadana mniej więcej o godzinie, o której kliknięto „Utwórz przesyłkę”, może być tą paczką: **nie wybieraj wtedy „Nie powstała”**.
4. Masz numer paczki (np. z etykiety, którą ktoś wydrukował)? „Rozstrzygnij ręcznie” → „Istnieje” i wpisz 13 cyfr. Kompletor sprawdzi cyfrę kontrolną numeru (literówka odpada od razu) i odcisk referencji na etykiecie tej paczki. Paczka już w drodze (Orlen nie wydaje wtedy duplikatu etykiety) przejdzie tylko wtedy, gdy jest na liście paczek nadanych przez API tego konta w tym samym oknie dni, z dopiskiem, że referencji nie porównano.
5. „Nie powstała” wybierz dopiero wtedy, gdy każda paczka z wykazu ma swoje zamówienie w Kompletorze. W razie wątpliwości (np. więcej niż 10 paczek w oknie albo przesyłka sprzed kilku dni) poproś opiekuna handlowego Orlen Paczki o wykaz paczek nadanych przez API w danym dniu.

## Czego system nie robi

- Nie wysyła paczek za pobraniem: Orlen Paczka wycofała pobranie 2 stycznia 2025. Zamówienie za pobraniem pokazuje błąd „pobranie” i trzeba wybrać innego przewoźnika.
- Nie dokupuje ubezpieczenia: usługa wycofana 4 grudnia 2024, paczka ma domyślną odpowiedzialność Orlen Paczki do 5000 zł.
- Nie zamawia kuriera po paczki i nie drukuje protokołu przekazania (w planie: lista przesyłek i protokoły).
- Nie robi zwrotów konsumenckich (metody zwrotów Orlen Paczki).
- Nie ma wyszukiwarki punktów na mapie: kod punktu (np. `WS-116263-C3-01`) musi przyjść z zamówienia albo z poprawki odbiorcy na karcie zamówienia.
- Nie śledzi paczek w panelu (status paczki moduł umie odczytać, ekran śledzenia to osobne zadanie).
- Paczki nadane w WebTruckerze (manager.orlenpaczka.pl, numery od 26) nie są widoczne przez API i odwrotnie (tak działa Orlen Paczka).

## Jak podłączyć

1. Poproś opiekuna handlowego Orlen Paczki o dostęp do API: login (PartnerID) i hasło (PartnerKey). **Dane do środowiska testowego i produkcyjnego są różne**; zacznij od testowego.
2. Ustawienia → Wysyłka i druk → Przewoźnicy → przycisk „Konta przewoźników” → konto „Orlen Paczka”: wpisz PartnerID i PartnerKey, w „Zaawansowane” wybierz środowisko (domyślnie testowe), zapisz i kliknij „Sprawdź połączenie”.
3. Ustawienia → Wysyłka i druk → Przewoźnicy → karta reguł: „Dodaj regułę”, słowa z nazwy sposobu dostawy w Twoim sklepie (np. „orlen”), przewoźnik „Orlen Paczka”, moduł „Orlen Paczka (bezpośrednio)” (tylko liczy) albo „… nadawanie za wyłącznikiem” (nadaje).
4. W tej samej karcie „Odbiory” ustaw dzień i godzinę odbioru Orlen Paczki (kolejka pakowania układa się od najbliższego odbioru). Wiersz „Orlen Paczka” widać dopiero po zapisaniu kluczy konta albo reguły z przewoźnikiem Orlen Paczka; firma, która z Orlenu nie korzysta, go nie widzi.
5. Uzupełnij Ustawienia → Dokumenty i faktury → Dane firmy: nazwa, adres z numerem budynku (np. „Magazynowa 5/2”), kod pocztowy, telefon i e-mail. Orlen Paczka wymaga ulicy i numeru budynku osobno: Kompletor dzieli adres sam i odmawia, gdy numeru nie ma.
6. Nadawanie włącza właściciel firmy po próbie na koncie testowym: Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → konto „Orlen Paczka” → przełącznik „Nadawanie z Kompletora: Orlen Paczka” (widać go, gdy reguła ma moduł z nadawaniem). Paczki nadaje tylko konto sprzedaży w trybie pracy.

Self-host: zamiast panelu klucze mogą przyjść z env (`ORLEN_PARTNER_ID`, `ORLEN_PARTNER_KEY` z przedrostkiem `envPrefix` reguły), a adres usługi z `baseUrl` (tylko adres produkcyjny albo testowy z dokumentacji Orlen Paczki).

## Pola

| Pole | Gdzie | Co znaczy |
|---|---|---|
| PartnerID | konto przewoźnika (klucz) | login API Orlen Paczki |
| PartnerKey | konto przewoźnika (klucz) | hasło API, szyfrowane, nie wraca na ekran |
| Środowisko | konto przewoźnika, „Zaawansowane” | testowe (domyślnie) albo produkcyjne |
| Waga domyślna | konto przewoźnika | waga paczki, gdy produkty nie mają wagi (wtedy ostrzeżenie do potwierdzenia) |
| Nadawanie z Kompletora | Konta przewoźników, przełącznik przy koncie dla reguły z modułem nadawania | bez niego moduł nie wysyła do Orlen Paczki żadnego żądania nadania, etykiety ani anulowania |
| Format etykiety | reguła przewoźnika (`formatEtykiety`, ustawia osoba techniczna) | PDF (domyślnie) albo ZPL |

## Do sprawdzenia na koncie testowym Orlen Paczki

Zanim właściciel włączy nadawanie na produkcji, osoba techniczna sprawdza na środowisku testowym (osobne dane od opiekuna):

1. Nagłówek `SOAPAction` (`"https://91.242.220.103/WebServicePwR/<metoda>"`) i kształt koperty SOAP 1.1 z WSDL usługi testowej.
2. `GivePartnerStatus`: kod `000` przy dobrych danych, kod błędu przy złych (Kompletor zakłada 200 albo 401).
3. `GenerateBusinessPack`: nadanie do punktu `XX-…-00-00` i do pełnego kodu, rozmiary S, M, L, numer w `PackCode_RUCH`.
4. Długości pól (imię, nazwisko, firma, ulica, e-mail): tabela w dokumentacji PDF ma przesunięte kolumny, Kompletor przyjął 30 znaków na imię, nazwisko, ulicę i miasto, 70 na firmę, 60 na e-mail.
5. `SenderOrders` (30 znaków) drukuje się na etykiecie i jest czytelnym tekstem w etykiecie ZPL z `LabelPrintDuplicateListTwo` (na tym stoi odszukanie po referencji).
6. `GetGeneratedParcels` z zakresem dat od przedwczoraj do jutra zwraca świeżo nadaną paczkę (z jakim opóźnieniem).
7. `LabelPrintDuplicateListTwo`: formaty PDF i ZPL, kod 211 tuż po nadaniu, kod 213 po nadaniu paczki w punkcie; czy pobranie duplikatu niczego nie zmienia w paczce.
8. `PutCustomerPackCanceled`: kod `000`, potem `201` przy drugim anulowaniu.
9. Kod punktu z zamówień Allegro i sklepów (czy przychodzi w formacie Orlen Paczki, np. `WS-116263-C3-01`).
10. Numery paczek z API mają poprawną cyfrę kontrolną EAN-13 (Kompletor odrzuca ręcznie wpisany numer ze złą cyfrą kontrolną).
11. Odpowiedź usługi na złą kopertę albo zły `SOAPAction`: HTTP 500 z Faultem `soap:Client` (Kompletor traktuje go jako odmowę przed wykonaniem, bez „nie wiadomo, czy paczka powstała”).
12. Kod 006 przy nadaniu do punktu `XX-…-00-00`: `DestinationCode` w odpowiedzi z pełnym kodem punktu (na nim stoi wiersz „Uwaga przewoźnika”).

Wynik sprawdzenia wpisz w [Co jeszcze nie działa](../co-jeszcze-nie-dziala.md).

## Skąd wiedza o API

Dokumentacja Orlen Paczki „API ORLEN Paczka v1.26.004” (orlenpaczka.pl, sierpień 2026) i konektor Open Integration Platform (Apache 2.0, informacja w `THIRD_PARTY_NOTICES.md` w repozytorium). Dokumentacja jest nowsza i ma pierwszeństwo: rozmiary S/M/L zamiast A, bez pobrania i ubezpieczenia, kody błędów 401 i 999.
