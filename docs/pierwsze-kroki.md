# Pierwsze kroki: pierwsze zamówienie bez BaseLinkera i wFirmy

Od pustej firmy do wysłanej paczki w pięciu krokach: produkt, zamówienie, pakowanie, przesyłka i dokument sprzedaży albo zamknięcie bez dokumentu. Nie potrzebujesz BaseLinkera, wFirmy ani sklepu internetowego.

Każdy krok ma drogę z menu. Zrobisz go jako właściciel firmy (konto z kreatora pierwszego uruchomienia). Lista **Uruchomienie firmy** na **Pulpicie** prowadzi przez te same kroki i odhacza zrobione.

## Zanim zaczniesz

Dwie rzeczy warto sprawdzić raz, na początku:

1. **Ustawienia → Dokumenty i faktury → Dane firmy**: nazwa, NIP, adres i e-mail. Trafiają do maili do klientów i na dokumenty.
2. **Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży**: kto prowadzi stan magazynu i czy masz program do faktur. Nowa firma ma ustawione „Kompletor prowadzi stan sam” i „Bez programu do faktur”. Jeśli to Ci pasuje, nic nie zmieniasz.

Przy „Kompletor prowadzi stan sam” towar schodzi ze stanu, gdy spakowane zamówienie przechodzi do wysyłki. Stan poprawiasz przyciskiem **Korekta stanu** na karcie produktu.

## 1. Produkt

**Produkty → Dodaj produkt**.

1. Wybierz rodzaj: **Towar ze stanem** (np. kubek), **Bez stanu** (e-book, usługa) albo **Zestaw z innych produktów**.
2. Wpisz nazwę i SKU, czyli Twój kod produktu, np. „Kubek ceramiczny 300 ml” i `KUB-300`. EAN jest opcjonalny.
3. Podaj cenę brutto i stawkę VAT. Cenę netto system policzy sam.
4. Przy towarze ze stanem wpisz stan początkowy, np. 20 sztuk, i półkę, na której leży (np. A-1-2). Półka pomaga magazynowi przy zbieraniu.
5. Kliknij **Utwórz produkt**.

Masz już katalog w pliku? **Produkty → Import i eksport CSV**. Szczegóły, zdjęcia i zestawy: [Produkty](produkty.md).

## 2. Zamówienie

Bez sklepu internetowego zamówienie dodajesz ręcznie: **Zamówienia → Dodaj zamówienie**. Tak samo wpiszesz zamówienie z telefonu albo hurtowe.

1. Wybierz produkty z katalogu i ilość. Formularz pokazuje, ile towaru jest dostępne.
2. Wpisz klienta i adres dostawy albo wyszukaj klienta z wcześniejszych zamówień.
3. Wybierz sposób dostawy i płatność: **Opłacone** i **Za pobraniem** od razu idą do realizacji, **Przelew do zapłaty** czeka na wpłatę z zarezerwowanym towarem.
4. Kliknij **Dodaj zamówienie**.

Towar jest od tej chwili zarezerwowany dla tego zamówienia, więc nikt go nie sprzeda drugi raz. Jak liczymy dostępny towar: [Rezerwacje](rezerwacje.md).

Sklep internetowy, Allegro albo Empik podłączysz później: **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → Dodaj sklep** ([Konfiguracja pierwszego dnia](konfiguracja.md)). Zamówienia z nich pójdą tą samą drogą.

## 3. Pakowanie

Otwórz zamówienie (**Zamówienia** → kliknij numer). Przyciski w nagłówku karty prowadzą je dalej: **Oznacz jako opłacone** (gdy klient zapłacił później), **Zacznij zbieranie**, **Spakuj**.

Przy większej liczbie zamówień pakuj z kolejki: menu **Pakowanie**. Zamówienia są tam pogrupowane po kurierach, a przycisk **Pakuj** otwiera okno pakowania. Lista zbierania po półkach, koszyki i stanowisko z czytnikiem kodów: [Pakowanie](pakowanie.md).

## 4. Przesyłka

Masz dwie drogi.

- **Z Kompletora**: podłącz konto przewoźnika w **Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników**, wpisz klucze, w **Ustawienia → Wysyłka i druk → Przewoźnicy** wybierz w regule moduł, który tworzy przesyłki, i włącz **Nadawanie z Kompletora**. Potem na karcie zamówienia, w sekcji „Przesyłka”, kliknij **Utwórz przesyłkę**. Numer nadania zapisze się sam, a etykieta będzie gotowa do druku. Opis: [Przesyłki](przesylki.md).
- **Poza Kompletorem**: nadaj paczkę w panelu przewoźnika, tak jak dziś, a numer nadania wpisz przy przycisku **Wysłane** na karcie zamówienia.

Odbiór osobisty nie potrzebuje przesyłki: spakowane zamówienie oznaczasz **Do odbioru**, a po wydaniu **Odebrane**.

## 5. Dokument sprzedaży albo zamknięcie bez dokumentu

Spakowane zamówienie przesuwasz przyciskiem **Do wysyłki**, a po nadaniu **Wysłane**. Dalej zależy od programu do faktur:

| Ustawienie | Co się dzieje |
|---|---|
| Bez programu do faktur | Kompletor nie wystawia dokumentu. Zamówienie zamyka się bez faktury i bez ostrzeżeń. Gdy klient prosi o fakturę, wystawiasz ją w swoim programie albo ręcznie. |
| wFirma | Po włączeniu **Wystawiaj faktury z Kompletora** faktura powstaje sama, a jej numer i PDF widać na karcie zamówienia. |
| KSeF bezpośrednio | Kompletor składa szkic faktury i sprawdza go. Wysyłki do KSeF jeszcze nie ma ([KSeF bez wFirmy](integracje/ksef.md)). |

Wszystkie ustawienia dokumentów: [Stan magazynu i dokumenty sprzedaży](dokumenty-sprzedazy.md).

## Co dalej

- Zaproś osoby z firmy: **Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia**. Rola Biuro prowadzi zamówienia, rola Magazyn pakuje.
- Ustaw pocztę firmy, żeby klienci dostawali maile o wysyłce: [Poczta](poczta.md).
- Przeczytaj, czego system jeszcze nie umie: [Co jeszcze nie działa](co-jeszcze-nie-dziala.md).
- Pracujesz dziś w BaseLinkerze? Dane przeniesiesz kreatorem: [Migracja z BaseLinkera](migracja-z-baselinkera.md).
