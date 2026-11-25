# Dziennik zmian

Każde publiczne wydanie Kompletora: co się zmieniło i co zrobić przy aktualizacji. Wersje mają postać RRRR.MM.DD (data wydania).

## 2026.11.25

Zmiany od pierwszego publicznego wydania (2026.11.20).

### Aktualizacja

- 6 nowych migracji bazy. Kontener wykonuje je sam przy starcie (`prisma migrate deploy`), bez ręcznych kroków.
- Bez nowych zmiennych środowiskowych i bez zmian w `compose.yaml`.
- Next.js 16.4.3 → 16.4.5 (poprawki bezpieczeństwa).

### Nowe

- **Zamów kuriera** w Pakowaniu: okno z dniem, godzinami, liczbą paczek i wagą. Działa dla DPD (bezpośrednio i przez Base Courier) oraz Wysyłam z Allegro, z numerem zlecenia przy pasku przewoźnika. Opcjonalny automat zamawia podjazd sam, liczy tylko paczki czekające na odbiór i zatrzymuje się z alertem, gdy czegoś nie jest pewien.
- **Wysyłam z Allegro**: osobne odbiory dla przesyłek, których Allegro nie łączy (podział, wynik częściowy, ponowienie nieudanej części), śledzenie przesyłek i link do Allegro przy numerze nadania, wymiary paczki dopasowane do limitu metody dostawy, wyłącznik nadawania na karcie konta.
- **Śledzenie paczek DPD** bezpośrednio z DPD, także dla paczek nadanych przez Base Courier.
- **Raporty**: wybór okresu porównania (rok do roku, miesiąc, tydzień, własny albo bez porównania). Do raportu sprzedaży można zaimportować archiwum zamówień ze sklepu WooCommerce i z faktur BaseLinkera (`npm run archiwum`, opis w `docs/raporty.md`).
- **Obce waluty**: sumy sprzedaży liczą złotówki osobno, a obce waluty przeliczają średnim kursem NBP (odświeżanym co 6 godzin). Waluta jest widoczna na karcie, na liście i w Pakowaniu. Wyłącznik firmy pozwala wystawiać faktury w wFirmie w walucie zamówienia.
- **Kategorie produktów**: drzewo kategorii, ekran Kategorie, pole na karcie i na liście, kolumna w CSV, filtr w API v1 i w MCP.
- **Produkty**: wyłączanie i włączanie produktu (przycisk na karcie, akcja masowa, kolumna „Aktywny” w CSV) oraz sortowanie listy kliknięciem w nagłówek kolumny.
- **API obsługi klienta** (zakres `obsluga:odczyt`): zamówienia klienta po e-mailu albo telefonie, zamówienie po numerze ze stanem przesyłek, dziennik podglądów.
- **Asystent AI adresu**: „Podpowiedz podział adresu” dla niejednoznacznej linii adresu, na karcie i na stanowisku.
- **Karta zamówienia**: zmiana płatności na pobranie i z powrotem, etykieta odbioru osobistego do naklejenia na paczkę, „Odśwież z kanału”, gdy brakuje sposobu dostawy.
- **Empik**: punkt odbioru, odbiorca i dane do faktury przy dostawie do paczkomatu i salonu.
- **Allegro**: stan 0 kończy ofertę, a stan dodatni wznawia ofertę zakończoną przez Kompletor.
- **BaseLinker**: status „Kompletor” dla zamówień wysłanych w Kompletorze.
- **Konto tylko przez API** (bez sklepu do odczytu stanów): praca bez testu połączenia, Pulpit włącza pracę bez stanów.

### Poprawki

- DPD: czytelny powód odmowy (pole, kod, opis) zamiast samego kodu HTTP, bez danych odbiorcy w powodzie. Środowisko konta (demo albo produkcja) do wyboru w panelu. Waga paczki zaokrąglana w górę do 10 g.
- Punkt odbioru (paczkomat, punkt DPD) nie wymaga adresu domowego.
- Faktura opłaconego zamówienia trafia do wFirmy jako opłacona.
- Ceny pozycji aktualizują się po zmianie w sklepie. Zamówienie już wysłane nie wraca do „Do wyjaśnienia”.
- Konta przewoźników: ustawienia zapisują się bez reguły, a po zapisie pola pokazują zapisane wartości. Przeniesienie reguły nie gubi wymiarów.
- Pakowanie: zwijane sekcje kurierów i zaznaczanie per kurier. Lista zamówień ma numer z kanału i kolumnę Klient.
- Menu statusów bez licznika przy „Wszystkie”. Blok Przesyłka nie pokazuje mylących komunikatów przed nadaniem.
- Limit tempa zapytań: zapis z panelu czeka krótko na wolne miejsce, a odczyty w tle zostawiają rezerwę konta.
