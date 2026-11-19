# Raporty sprzedaży: okres, kanał, produkt i marża

Ekran **Raporty** w menu panelu (grupa „Finanse”, pod „Fakturami”) pokazuje, ile sprzedajesz: w dniach, tygodniach albo miesiącach, w każdym kanale
sprzedaży i na każdym produkcie. Obok sprzedaży jest marża z ceny zakupu i porównanie z poprzednim okresem.
Ten sam raport pobierzesz jako plik Excela (XLSX).

## Gdzie to jest i kto widzi

Menu **Raporty** (adres `/raporty`). Ekran i plik Excela widzi osoba z uprawnieniem **„Raporty sprzedaży i marża”**:
domyślnie role Właściciel i Biuro. Rola Magazyn domyślnie go nie ma, więc nie widzi pozycji Raporty w menu, a adres
`/raporty` daje „nie znaleziono”. Właściciel nada je wybranej osobie w **Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia** (grupa „Podgląd”).

Eksport listy zamówień do Excela (Zamówienia → „Eksport Excel (XLSX)”) zostaje przy liście zamówień, tak jak eksport CSV:
nie ma w nim marży ani kosztu zakupu.

## Jak wybrać zakres

1. Wejdź w **Raporty** w menu.
2. Kliknij skrót („Ten miesiąc”, „Poprzedni miesiąc”, „Ostatnie 7 dni”, „Ostatnie 30 dni”, „Ten rok”) albo wpisz
   daty **Od** i **Do** i kliknij **Pokaż**.
3. **Podział**: „Samo dobierze” pokazuje dni przy zakresie do 62 dni, tygodnie do ok. pół roku, dalej miesiące.
   Możesz wybrać sam. Tydzień zaczyna się w poniedziałek.
4. **Kanał**: wszystkie albo jedno konto (np. jeden sklep). Nazwa konta w tabeli „Kanały” też zawęża raport.

Zakres to najwyżej 366 dni. Daty są w czasie polskim, a obie granice wchodzą do raportu.

## Co widać na ekranie

- **Kafle**: liczba zamówień, wartość zamówień brutto, średnia wartość zamówienia, sprzedaż produktów netto i marża.
  Pod każdą liczbą jest wynik poprzedniego okresu i zmiana w procentach.
- **Wykres**: wartość brutto (albo liczba zamówień) w każdym dniu, tygodniu albo miesiącu. Najedź na słupek, żeby
  zobaczyć liczby. Jaśniejszy słupek to okres niepełny (np. tydzień, który zaczął się przed wybranym zakresem).
  Pod wykresem rozwiniesz **Tabelę okresów**.
- **Kanały**: każde konto kanału z zamówieniami, wartością, sprzedażą produktów i marżą.
- **Produkty**: najlepiej sprzedające się produkty (50 na ekranie, do 1000 w pliku Excela).

Na telefonie część kolumn (średnia, marża w procentach, sprzedaż brutto) chowa się, a pełne liczby są w pliku Excela.

## Jak liczymy

- **Data**: dzień złożenia zamówienia w kanale (nie dzień wysyłki ani płatności), w czasie polskim.
- **Anulowane** zamówienia nie wchodzą do sprzedaży. Raport pokazuje je osobno: ile ich było i na jaką kwotę.
- **Zamówienie liczy się raz.** Gdy część zamówienia idzie później osobną paczką („dośle później”), to dalej jedno
  zamówienie. Pozycje liczą się tam, gdzie są: wysłane w paczce i dosłane później.
- **Wartość zamówień brutto** to kwota zamówienia z kanału, razem z dostawą, tak jak na pulpicie.
- **Sprzedaż produktów** to same pozycje, bez dostawy: ilość razy cena z kanału. Pozycje odrzucone, zamienione albo
  usunięte w kanale się nie liczą (liczy się produkt, który poszedł zamiast nich).
- **Netto** liczymy z brutto pozycji i stawki VAT pozycji (albo produktu). Stawki „zw”, „np” (też „np I”, „np II”),
  „oo” i „0” to netto równe brutto. Pozycja bez żadnej stawki liczy się z 23%. Stawka, której raport nie rozpoznaje
  (np. literówka wpisana na karcie zamówienia), liczy się ze stawki produktu, a bez niej z 23%. Nad kaflami pojawia się
  wtedy ostrzeżenie z liczbą takich pozycji, a w pliku Excela wiersz „Pozycje z nierozpoznaną stawką VAT”. Popraw stawkę
  na karcie zamówienia (sekcja „Pozycje”) albo produktu.
- **Zwroty** (zwrot towaru albo korekta, poza odrzuconymi) odejmujemy od sprzedaży produktów, kosztu i sztuk
  w okresie, w którym złożono zamówienie, nie w okresie zwrotu. Zwrot z października do zamówienia z września zmienia
  więc raport września, a raport za zamknięty miesiąc może się jeszcze zmienić. Zwrot liczy się od chwili zgłoszenia
  (także gdy paczka jest jeszcze w drodze), nie dopiero od przyjęcia na magazyn. Kwota zwrotów brutto jest pod kaflami.
- **Marża** = sprzedaż netto po zwrotach minus koszt zakupu netto. Koszt = ilość razy **cena zakupu netto** produktu:
  z wFirmy, gdy firma ją ma, albo z pola „Cena zakupu netto” w karcie produktu. Produkt na wagę ma cenę zakupu za kilogram.
  Zestaw bez własnej ceny zakupu liczy się z cen składników (gdy wszystkie je mają).
- **Brak ceny zakupu**: produkt bez ceny zakupu nie ma marży. Raport pisze „brak ceny zakupu” i nie liczy go jako
  marży 100%. Marża w kaflu i w procentach dotyczy tylko sprzedaży produktów, które mają cenę zakupu, a kwota sprzedaży
  bez ceny zakupu jest podana obok. Żeby ją objąć marżą, uzupełnij cenę zakupu w karcie produktu (Produkty → produkt).
- **Porównanie**: poprzedni okres ma tyle samo dni i kończy się dzień przed wybranym zakresem.
- **Zamówienia spoza Kompletora** (z kanału, ale nieprzyjęte do realizacji, np. sprzed uruchomienia systemu) nie wchodzą
  do raportu. Raport podaje tylko ich liczbę i kwotę.

## Eksport do Excela

- **Raporty → Pobierz Excel (XLSX)**: plik z czterema arkuszami: Podsumowanie (z porównaniem), Okresy, Kanały,
  Produkty (do 1000). Kwoty, ilości i procenty są liczbami, więc od razu je sumujesz i sortujesz. Kwoty mają zawsze
  dwa miejsca po przecinku, sztuki i liczba zamówień są całkowite, kilogramy mają trzy miejsca (dokładność do grama).
  Procenty są zwykłym procentem Excela (komórka „54,2%” ma wartość 0,542), więc formuła typu `=B2*C2` liczy poprawnie.
  „Stan na” to data i godzina w czasie polskim. Polskie znaki są zapisane poprawnie, bez ustawiania kodowania.
- **Zamówienia → Eksport Excel (XLSX)** obok „Eksport CSV”: lista zamówień z bieżącego widoku i filtrów (najwyżej 5 000),
  te same kolumny co CSV. Kwota jest liczbą, data złożenia datą. W pasku zaznaczonych zamówień są oba przyciski.

Raporty i ich pliki nie mają danych osobowych klientów: same liczby, kwoty, nazwy produktów i kanałów. Eksport listy
zamówień też ich nie ma (numer, kanał, data, status, przewoźnik, płatność, kwota, faktura, numer nadania, kraj,
pozycje).

Plik powstaje od razu, bez czekania: raport liczy baza danych, a zakres ma najwyżej 366 dni.

## Czego ten ekran nie robi

- Nie zmienia niczego w sklepach, kanałach, u przewoźników ani w programie do faktur. To sam odczyt.
- Nie pokazuje klientów (kto kupił). Zamówienia konkretnego klienta znajdziesz na liście zamówień (Zamówienia → szukaj).
- Nie liczy kosztu dostawy, prowizji kanałów ani kosztów reklamy: marża to sprzedaż netto minus cena zakupu towaru.
- Nie podsumowuje stanów magazynu: braki i rezerwacje są na ekranach Braki towaru i Produkty.

## Dla agentów AI i programistów

Ten sam raport daje `GET /api/v1/raporty/sprzedaz` (zakres klucza `raporty:odczyt`, opis w `docs/api.md`) i narzędzie
MCP `raport_sprzedazy` (rozdział „Agenci AI”).
