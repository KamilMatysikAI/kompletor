# Dokumentacja Kompletora

Spis dokumentów dla sprzedawcy: od instalacji, przez pierwsze zamówienie i konfigurację, po przejście z BaseLinkera.

Te same pliki czytasz w panelu: menu konta w prawym górnym rogu → „Pomoc”.

Zacznij od [Pierwszych kroków](pierwsze-kroki.md) i listy tego, czego system jeszcze nie umie. Wymagania i braki poznasz przed instalacją, a nie po niej.

| Dokument | O czym |
|---|---|
| [Pierwsze kroki](pierwsze-kroki.md) | Pierwsze zamówienie bez BaseLinkera i wFirmy: produkt, zamówienie, pakowanie, przesyłka, dokument. |
| [Co jeszcze nie działa](co-jeszcze-nie-dziala.md) | Co działa, co działa tylko na podgląd, czego nie ma. |
| [Instalacja](instalacja.md) | Wymagania, uruchomienie, kopie zapasowe, HTTPS, częste błędy. |
| [Konfiguracja pierwszego dnia](konfiguracja.md) | Sklep, oferty, przypisania, przewoźnicy, rezerwacje, użytkownicy. |
| [Integracje](integracje/README.md) | Stan każdej integracji i skąd wziąć klucze. |
| [Allegro](integracje/allegro.md) | „Połącz z Allegro” z panelu (zakresy, odnowienie dostępu), stany ofert, status realizacji, numery nadania i Wysyłam z Allegro (etykieta, anulowanie), zapis za wyłącznikiem konta. |
| [Empik](integracje/empik.md) | Przyjmowanie zamówień Empiku, stany, numer nadania i „wysłane”, zapis za wyłącznikiem. |
| [WooCommerce: zapis](integracje/woocommerce.md) | Stany, statusy, numery nadania i anulowanie nieopłaconych do sklepu WooCommerce, za wyłącznikiem konta. |
| [Shoper](integracje/shoper.md) | Podłączenie sklepu Shoper: zamówienia, oferty i stany, zapis za wyłącznikiem. |
| [PrestaShop](integracje/prestashop.md) | Podłączenie sklepu PrestaShop przez Webservice: zamówienia, oferty i stany. |
| [IdoSell](integracje/idosell.md) | Podłączenie sklepu IdoSell kluczem Admin API: zamówienia, produkty z rozmiarami i stany, zapis stanów i statusów za wyłącznikiem. |
| [Base Courier: InPost i DPD](integracje/basecourier.md) | Przesyłki InPost (A/B/C) i DPD przez Base Courier: tworzenie, etykieta PDF, pobranie, anulowanie, za wyłącznikiem. |
| [InPost bezpośrednio](integracje/inpost.md) | Przesyłki InPost (ShipX) na podgląd: paczkomat i kurier, bez nadawania. |
| [DPD bezpośrednio](integracje/dpd.md) | Przesyłki DPD (DPDServices) na podgląd: kurier, punkt, salon Empik, bez nadawania. |
| [Orlen Paczka bezpośrednio](integracje/orlenpaczka.md) | Paczki do punktów i automatów Orlen Paczki: rozmiar S/M/L, etykieta, anulowanie, nadawanie za wyłącznikiem, bez pobrania. |
| [GLS bezpośrednio (ADE)](integracje/gls.md) | Przesyłki GLS kurierem i do punktów: pobranie, etykieta PDF albo ZPL (także wielopaczkowa), nadawanie za wyłącznikiem, bez anulowania. |
| [Poczta Polska (eNadawca)](integracje/pocztapolska.md) | Pocztex Kurier pod adres: format S…2XL, partia dnia w buforze eNadawcy, etykieta PDF, usunięcie z partii, wysłanie partii, śledzenie; nadawanie za wyłącznikiem, bez pobrania. |
| [KSeF bez wFirmy](integracje/ksef.md) | Faktura FA(3) składana i sprawdzana w Kompletorze, bez wysyłki do KSeF. |
| [Źródła zmian w API integracji](integracje/zrodla-zmian.md) | Skąd wiemy o zmianach u dostawców (Allegro, przewoźnicy, KSeF i inni) i jak je sprawdzamy, zanim dotkną działających połączeń. |
| [Produkty: dodawanie, karta produktu, zdjęcia i zestawy](produkty.md) | Dodaj produkt bez wFirmy i BaseLinkera (albo pobierz dane z wFirmy, sklepu, BL), edycja karty, zdjęcia, zestawy, produkty bez stanu. |
| [Oferty: podgląd i wystawianie na Allegro, w Empiku i w sklepie](oferty.md) | Zakładka „Publikacja” na karcie produktu, „Przygotuj oferty” dla wielu produktów z raportem, czego wymaga Allegro i Empik, dlaczego „Wystaw” jest nieaktywny i gdzie to włączyć. |
| [Stan magazynu i dokumenty sprzedaży](dokumenty-sprzedazy.md) | Kto prowadzi stan, program do faktur albo praca bez niego, dane firmy. |
| [Rezerwacje](rezerwacje.md) | Jak liczymy dostępny towar, terminy płatności, braki, przykład. |
| [Wysyłka stanów: kiedy stan nie idzie drugi raz](synchronizacja-stanow.md) | Pomijanie stanów, które sklep już ma, licznik „pominięte bez zmian”, „Wyślij stany ponownie”, kiedy stan idzie mimo braku zmian. |
| [Prowadzenie zamówienia z karty](tryb-praca.md) | Sekcja „Co dalej” na karcie zamówienia: przyciski, włączenie, czego nie robi. |
| [Statusy zamówień firmy: nazwy, kolory i grupy](statusy.md) | Własne statusy firmy nad etapami Kompletora: nazwa, kolor, grupa panelu listy, przewoźnicy, status w sklepie, ukrywanie. |
| [Automatyczne akcje: co Kompletor robi sam](automatyczne-akcje.md) | Reguły „kiedy → jeśli → zrób” jak w BaseLinkerze: zdarzenia, warunki, kroki, grupy, przyciski na karcie i stanowisku, podgląd na sucho, bezpieczniki. |
| [Lista zamówień: statusy, filtry i praca na wielu zamówieniach](lista-zamowien.md) | Statusy z licznikami (także statusy firmy z kolorami) w menu „Zamówienia”, per przewoźnik, „Po terminie” i termin wysyłki, jedno pole szukania (numer, klient, e-mail, telefon, NIP, produkt, przesyłka), filtry, kolumna „Stan”, alerty z „Ignoruj”, stały pasek akcji masowych (status, przesyłki, etykiety, karty), eksport CSV i Excel (XLSX) zaznaczonych albo całego widoku. |
| [Raporty sprzedaży: okres, kanał, produkt i marża](raporty.md) | Sprzedaż w dniach, tygodniach i miesiącach, na kanał i produkt, marża z ceny zakupu, porównanie z poprzednim okresem, eksport do Excela (XLSX). |
| [Zwroty i reklamacje](zwroty-i-reklamacje.md) | Stwórz zwrot z karty albo z listy, pięć statusów jak w BL, odbiór na stan albo uszkodzone, korekta faktury, zwroty z Allegro. |
| [Karta zamówienia: co biuro robi z karty](karta-zamowienia.md) | Pozycje, płatność, wysyłka, faktura, zwroty, notatki i historia na karcie zamówienia; czego karta nie robi. |
| [Pakowanie: kolejka, lista zbierania, koszyki i stanowisko](pakowanie.md) | Kolejka po kurierach, „Pakuj” przy zamówieniu i kurierze, lista zbierania po półkach ze zdjęciami, koszyki A–J z kodami, skan koszyka na stanowisku. |
| [Przesyłki: utworzenie, numer nadania i etykieta](przesylki.md) | Przycisk „Utwórz przesyłkę” z gabarytem na karcie i stanowisku, etykieta od przewoźnika, druk, poprawka adresu, podwójne kliknięcie. |
| [Poczta: maile do klientów i biura](poczta.md) | Serwer poczty firmy, kiedy mail wychodzi, szablony, błędy i odbicia, reset hasła. |
| [Powiadomienia na Zulip](powiadomienia.md) | Alerty na Zulip: włączenie, strumienie i tematy, wiadomość próbna. |
| [Dane klienta w zamówieniu](dane-klienta.md) | Co przechowujemy, szyfrowanie, kto widzi, dziennik podglądów, retencja, usuwanie, klucze. |
| [Agenci AI: podłącz asystenta do Kompletora](agenci-ai.md) | Serwer MCP tylko do odczytu: klucz agenta, konfiguracja Claude Code, Cursora i innych, czego asystent nie widzi. |
| [Migracja z BaseLinkera](migracja-z-baselinkera.md) | Praca równoległa w trybie cienia, import katalogu, porównanie. |
| [Automaty BaseLinkera w Kompletorze](akcje-bl.md) | Dokument techniczny: gdzie w Kompletorze jest każda automatyczna akcja BaseLinkera. |
| [Pytania i odpowiedzi](faq.md) | Licencja, dane, awarie, limity, zgłaszanie błędów. |
