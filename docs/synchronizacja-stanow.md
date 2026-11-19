# Wysyłka stanów do sklepów: kiedy stan nie idzie drugi raz

Kompletor pamięta, jaki stan każdej oferty sklep dostał przy ostatnim udanym zapisie. Gdy stan oferty się nie zmienił, nie wysyła go drugi raz. Oszczędza to limity zapytań sklepów (Allegro, Empik) i skraca kolejkę w szczycie sezonu. Dotyczy kont w trybie pracy z włączonym „Zapis do sklepu”; w podglądzie nic nie wychodzi i nic nie jest zapamiętywane.

## Gdzie to widać

Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto sklepu → sekcja „Zapis do sklepu” → część „Stany”:

- **Ostatni przebieg:** kiedy był, ile stanów wysłaliśmy i ile „pominięte bez zmian” (sklep miał już ten stan).
- **Zapamiętanych ofert:** dla ilu ofert Kompletor zna stan z ostatniego udanego zapisu.
- Przycisk **„Wyślij stany ponownie”**: Kompletor zapomina, co sklep już ma, i wysyła stany wszystkich ofert konta od nowa (także bez zmian). Statusów zamówień i numerów nadania to nie dotyczy. Ekran konta i oba elementy wymagają uprawnienia „Ustawienia”, tak samo jak „Wypchnij teraz”.
- Pole **„Wysyłaj wszystkie stany co (godzin)”**: siatka bezpieczeństwa, domyślnie 24 h (od 1 do 168). Po tym czasie stan oferty idzie do sklepu przy najbliższej zmianie, nawet jeśli jest taki sam. Nocna pełna synchronizacja i tak wysyła wszystkie stany raz na dobę, więc wartość powyżej 24 h nie wydłuża realnego okna, w którym sklep może mieć inny stan niż Kompletor; 1 h to praktycznie wyłączenie pomijania (powtórkę tego samego stanu w ciągu godziny Kompletor i tak pomija od dawna).

Na tym ekranie nie wyłączysz samego zapamiętywania. Wyłączenie zapisu do sklepu w ogóle: przełącznik „Zapis do sklepu” w tej samej sekcji.

## Kiedy stan idzie mimo braku zmian

Stan oferty zawsze idzie do sklepu, gdy:

- to pierwszy zapis tej oferty (po wdrożeniu funkcji pierwszy przebieg wysyła wszystko jak dotąd);
- poprzedni zapis tej oferty się nie udał (błąd przejściowy, błąd stały, niepewny wynik albo przerwany przebieg);
- sklep sam zmienił stan, np. po anulowaniu zamówienia oddał sobie sztuki;
- klikniesz „Wypchnij teraz” albo „Wyślij stany ponownie”; działa też nocna pełna synchronizacja i powrót sklepu po awarii;
- poprawisz stan produktu („Korekta stanu”), nawet bez zmiany ilości;
- zmienisz powiązanie oferty z produktem, liczbę sztuk na ofertę albo wyłączysz i włączysz ofertę;
- zmienisz cokolwiek w koncie sklepu: ustawienia, klucze, tryb (podgląd i praca), wyłącznik zapisu, wersję konta, ponowne połączenie z Allegro;
- „Pobierz oferty” pokaże w sklepie inną ilość niż ta, którą wysłaliśmy ostatnio (np. ktoś zmienił stan w panelu sklepu);
- Empik odrzuci wiersze importu stanów (cały plik albo część): stany z tego pliku idą jeszcze raz;
- minie czas z pola „Wysyłaj wszystkie stany co (godzin)”.

## Jak to działa (dla administratora)

Dla każdej oferty konta Kompletor trzyma skrót (SHA-256) treści ostatniego udanego zapisu: wersja konta, numer oferty, ilość, powiązany produkt i liczba sztuk na ofertę. Przed wysłaniem skrót jest kasowany, a po potwierdzeniu przez sklep zapisany od nowa; każdy inny wynik zostawia go pustym, więc następny przebieg wysyła. Błąd stały podbija licznik porażek oferty. Błąd samego rejestru nie blokuje zapisu: oferta idzie wtedy do sklepu jak dawniej. Wzorzec: Open Integration Platform (Pinquark.com, Apache-2.0), szczegóły w `THIRD_PARTY_NOTICES.md`.
