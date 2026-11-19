# Empik (Mirakl) w Kompletorze

Jak Kompletor przyjmuje zamówienia z Empiku, wysyła stany, numer nadania i informację „wysłane”, oraz jak to włączyć.

> **Stan na 06.11.2026: przygotowane, sprawdzone wyłącznie na symulowanym koncie Empiku.** Zapis do Empiku stoi za
> wyłącznikiem konta i domyślnie jest wyłączony. Zanim go włączysz, przeczytaj [„Zanim włączysz zapis”](#zanim-włączysz-zapis).

## Co Kompletor robi z kontem Empik

- **Czyta zamówienia** co minutę: numer, stan, kwotę, sposób dostawy i kupione produkty. Rezerwuje towar od chwili
  zamówienia.
- **Przyjmuje zamówienia** (w Empiku to „akceptacja”). Empik anuluje zamówienie, którego sprzedawca nie przyjmie w ciągu
  5 dni, więc Kompletor robi to sam, co minutę:
  - gdy każda pozycja ma zarezerwowany towar, przyjmuje całe zamówienie;
  - gdy na pozycji w ogóle brakuje towaru, robi to, co wybierzesz w ustawieniach konta: **zostawia zamówienie do Twojej
    decyzji i wysyła alert** (domyślnie) albo **odrzuca tę pozycję**, a resztę przyjmuje;
  - gdy brakuje tylko części sztuk, brak oznaczono „wyślij później” albo pozycja nie ma produktu w katalogu, zawsze
    zostawia decyzję Tobie (Empik pozwala odrzucić tylko całą pozycję);
  - gdy Empik zdążył już anulować zamówienie, zapisuje to w historii („już anulowane albo odrzucone w Empiku”) i nic nie
    wysyła.
- **Pilnuje czasu:** gdy zamówienie czeka na przyjęcie dłużej niż ustawiona liczba godzin (domyślnie 12), dostajesz alert.
- **Wysyła stany** produktów do Empiku (import samych stanów, najwyżej raz na minutę). Ceny i opisy ofert zostają
  nietknięte. Produkt, który nie ma w Empiku dokładnie jednej oferty, nie dostaje stanu: na liście stanów kanału jest
  oznaczony jako niewysłany z powodem „brak jednej oferty w Empiku”, a reszta paczki idzie normalnie.
- **Sprawdza wynik importu stanów.** Empik przyjmuje plik stanów od razu, a przetwarza go później, więc „przyjęte” nie
  znaczy jeszcze „stany weszły”. Kompletor sprawdza wynik po minucie, potem co 5 minut, i:
  - gdy Empik odrzucił część wierszy (np. oferta zniknęła albo zły kod magazynu), wysyła alert z liczbą odrzuconych
    wierszy i kodami ofert, jeśli Empik je podał. Treści błędów nie kopiuje: pełny raport jest w panelu Empiku;
  - gdy Empik odrzucił cały plik, wysyła alert „Empik nie przetworzył pliku stanów”;
  - gdy po dobie nadal nie ma wyniku, wysyła alert „brak wyniku importu stanów” i przestaje pytać;
  - gdy Empik nie udostępnia wyniku temu kontu (odmowa dostępu albo import już usunięty z historii), import dostaje
    stan „wynik niedostępny”: to nie znaczy „odrzucone”, stany mogły wejść, tylko Kompletor tego nie sprawdzi. Konto
    bez dostępu do wyniku importu dostaje jeden alert dziennie, a Kompletor przez dobę nie pyta Empiku o wynik
    kolejnych importów tego konta. Nieprzyjęty klucz API daje ten sam stan i alert z prośbą o sprawdzenie klucza.
  Alerty o tej samej przyczynie łączą się: odrzucenia z tymi samymi ofertami, odrzucone całe pliki i brak wyniku
  dają najwyżej jeden alert dziennie na konto (nowy kod oferty = nowy alert). Każdy import i tak widać w tabeli.
  Ostatnie importy z wynikiem widać na ekranie konta (sekcja „Zapis do sklepu” → „Stany” → „Wynik importów stanów w
  sklepie”).
- **Pilnuje limitu Empiku:** wszystkie odczyty i zapisy jednego konta (zamówienia, przyjmowanie, stany) idą razem
  najwyżej 30 żądań na minutę.
- **Wysyła numer nadania i przewoźnika** oraz informację **„wysłane”**, gdy zamówienie wyjedzie.

## Tryb podglądu i tryb pracy

Konto, które dopiero obserwujesz (tryb cienia, pasek „CIEŃ” na górze panelu), niczego w Empiku nie zmienia. Przy każdym
zamówieniu czekającym na przyjęcie Kompletor zapisuje w historii zamówienia, co by zrobił: „Empik: zaakceptowałbym
zamówienie (podgląd, nic nie wysłane)”. Tak porównasz jego decyzje z tym, co dziś robi Twój obecny system.

Zamówienia przyjmuje naprawdę dopiero konto w trybie pracy, z rodzajem „Empik Marketplace (Mirakl, z zapisem za
wyłącznikiem)” i z włączonym przełącznikiem „Zapis do sklepu” (sekcja „Zapis do sklepu” na ekranie konta).

## Gdzie to jest

- Ustawienia konta: **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto Empik**. Pola: „Przyjmowanie zamówień: gdy brakuje
  towaru”, „Alert, gdy zamówienie czeka na przyjęcie (godz.)”, „Kody przewoźników”, „Magazyn w
  Empiku”; przełącznik „Zapis do sklepu” w sekcji o tej samej nazwie. Ostatnie dwa pola i przełącznik są tylko przy
  rodzaju konta z zapisem.
- Nowe konto z zapisem: **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → „Dodaj sklep” → „Empik Marketplace (Mirakl, z zapisem za
  wyłącznikiem)”**.
- **Zmiana rodzaju istniejącego konta** (tylko odczyt ↔ z zapisem): **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto Empik →
  sekcja „Zapis do sklepu”**. Konto tylko do odczytu ma tam przycisk **„Przełącz na wersję z zapisem”**, a konto z
  zapisem, na dole sekcji, **„Przełącz na wersję tylko do odczytu”** (z potwierdzeniem). Widzi i klika osoba z
  uprawnieniem do ustawień. Po zmianie:
  - klucz API, wszystkie ustawienia konta i odczyt zamówień zostają bez zmian (Kompletor nie czyta zamówień od nowa);
  - zapis do sklepu jest wyłączony, dopóki nie włączysz go przełącznikiem „Zapis do sklepu”;
  - zmiana trafia do dziennika zmian konta.
  Administrator może to samo zrobić poleceniem `npm run konto -- rodzaj --firma <firma> --konto EMPIK/<konto> --na zapis`
  (albo `--na odczyt`).
- Wynik importów stanów: **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto Empik → „Zapis do sklepu” → „Stany”**.
- Decyzje przy zamówieniu: **Zamówienia → zamówienie z Empiku → „Historia zmian”** („Przyjęte w Empiku”, „Empik:
  przyjęcie czeka na decyzję: …”, „Empik: przyjęcie nie przeszło”).
- Alerty przyjmowania zamówień trafiają tam, gdzie pozostałe alerty kanału zamówień (grupa „Kanał nie czyta zamówień”
  w Ustawienia → Komunikacja i poczta → Powiadomienia), a alerty wyniku importu stanów do grupy „Kanał nie przyjmuje stanów”.

## Czego Kompletor nie robi

- Nie zmienia cen, opisów ani zdjęć ofert. Do stanów używa wyłącznie importu samych stanów; pełnej aktualizacji oferty
  nie używa, bo Empik zeruje wtedy każde pole, którego nie wysłano.
- Nie odrzuca całych zamówień „z braku decyzji”: jeśli zamówienie czeka na Ciebie, przyjmujesz je albo odrzucasz w panelu
  Empiku, a Kompletor odczyta wynik.
- Nie przyjmuje zamówienia, które sam u siebie anulował (wtedy dostajesz alert).
- Nie wysyła odrzuconych wierszy importu stanów ponownie sam z siebie: po poprawce (np. oferty w Empiku) kliknij
  „Wypchnij teraz” na ekranie konta. Powtarzające się odrzucenia tych samych ofert dają jeden alert dziennie, nie
  alert przy każdej wysyłce stanów.
- Po przełączeniu konta na wersję tylko do odczytu nie sprawdza już wyniku importów wysłanych wcześniej: otwarte
  importy dostają od razu stan „wynik niedostępny”, bez alertu.
- Gdy Empik kilka razy z rzędu odmówi przyjęcia zamówienia z tym samym błędem, kolejne próby idą coraz rzadziej (po
  30 min, 2 h, 6 h, potem co 12 h); alert dostajesz raz, przy pierwszej odmowie.

## Zanim włączysz zapis

1. Sprawdź, czy Twoje konto Empik ma włączony import samych stanów (w dokumentacji Mirakl nazywa się STO01). Jeśli nie,
   wysyłka stanów skończy się komunikatem „import stanów Empik (STO01) niedostępny na tym koncie” i trzeba poprosić
   opiekuna Empiku o włączenie `[do potwierdzenia]`.
2. Wyłącz przyjmowanie zamówień w obecnym systemie (np. w BaseLinkerze), żeby dwa systemy nie decydowały naraz.
3. Wpisz kody przewoźników z listy Empiku, np. `{"DPD":"dpd"}` `[do potwierdzenia: kody z panelu Empiku]`. Przewoźnik
   bez kodu idzie do Empiku z nazwą i adresem śledzenia.
4. Gdy podajesz „Magazyn w Empiku”, wpisz kod magazynu dokładnie jak w panelu Empiku. Zły kod nie blokuje wysyłki,
   ale Empik odrzuci te wiersze: zobaczysz to w wyniku importu stanów i w alercie. Puste pole = stan całej oferty
   `[do potwierdzenia na koncie Empiku: czy puste pole przechodzi bez błędu]`.
5. Gdy Empik ma wyłączoną częściową akceptację, odrzucenie pojedynczej pozycji nie przejdzie. Dostaniesz wtedy alert, a
   zamówienie rozstrzygasz w panelu Empiku.
