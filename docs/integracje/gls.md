# GLS bezpośrednio (ADE)

Dla sprzedawcy, który ma własną umowę z GLS Polska i dostęp do ADE (system nadawczy GLS), a chce nadawać paczki kurierem GLS prosto z Kompletora, bez pośrednika. Moduł obsługuje kuriera pod adres i doręczenie do punktu GLS (ParcelShop), także za pobraniem.

Stan: moduł napisany i sprawdzony na atrapie usługi ADE. Na koncie testowym GLS jeszcze nie: lista rzeczy do sprawdzenia jest na końcu.

## Co system robi

- **Liczy przesyłkę** na karcie zamówienia (Zamówienia → numer zamówienia → sekcja „Przesyłka”): waga paczki, pobranie, kurier albo punkt GLS. Pilnuje limitów: paczka od 0,01 do 31,5 kg, pobranie do 10 000 zł (limit zmienisz w ustawieniach konta, jeśli umowa z GLS mówi inaczej).
- **Sprawdza połączenie** z kontem (Ustawienia → Wysyłka i druk → Przewoźnicy → przycisk „Konta przewoźników” → konto „GLS” → „Sprawdź połączenie”): samo zalogowanie do ADE i wylogowanie, bez danych klientów.
- **Nadaje przesyłkę** (moduł „GLS (bezpośrednio, ADE, nadawanie za wyłącznikiem)”): przycisk „Utwórz przesyłkę” na karcie zamówienia. Kompletor wstawia przesyłkę do przygotowalni ADE i od razu ją potwierdza do nadania, w jednym połączeniu. Zapisuje identyfikator przesyłki z ADE, numer paczki (do śledzenia na gls-group.com) i etykietę PDF albo ZPL.
- **Drukuje etykiety przesyłek wielopaczkowych** jednym plikiem (przesyłka z kilkoma paczkami, np. założona w panelu ADE).
- **Nie robi drugiej przesyłki**, gdy ADE nie odpowie w trakcie nadania. W polu „Referencje” każdej przesyłki z Kompletora jest odcisk referencji (`KMP…`, 25 znaków). Zanim Kompletor wstawi przesyłkę, sprawdza przygotowalnię ADE: jeśli czeka tam przesyłka z tym odciskiem (poprzednia próba przerwała się przed potwierdzeniem), dokańcza ją zamiast wstawiać drugą, ale tylko gdy kod pocztowy i ulica odbiorcy, punkt GLS, kwota pobrania, waga i data nadania są takie same jak teraz. Gdy się różnią (np. po poprawce adresu, zmianie punktu albo następnego dnia), Kompletor zatrzymuje się z komunikatem „Usuń przygotowanie … w panelu ADE i ponów”. Przy ponowieniu (ta sama przesyłka po błędzie albo po tym, jak „Sprawdź u przewoźnika” jej nie znalazło) Kompletor najpierw przegląda też 100 ostatnich potwierdzeń nadania (jest tam przesyłka z tym odciskiem = zapisuje ją, nic nie wysyła). Pierwsza próba nowej przesyłki potwierdzeń nie przegląda: nie mogła być jeszcze nadana, a przegląd historii tylko by ją spowalniał. „Sprawdź u przewoźnika” szuka odcisku w przygotowalni i w 20 ostatnich potwierdzeniach. Gdy przegląd nie obejmie wszystkiego (bardzo długa lista w ADE, za dużo przesyłek w przeglądanych potwierdzeniach, ponad 5 minut), Kompletor mówi to wprost, zamiast uznać, że przesyłki nie ma.
- **Czas „Utwórz przesyłkę” w najgorszym razie**: ok. 24 minuty (przegląd przed wstawieniem i odszukanie po błędzie, każde do 5 minut z ponowieniami odczytu, dwa zapisy po minucie, logowania). Gdy proces Kompletora padnie w trakcie nadania, przycisk „Sprawdź u przewoźnika” przy tej przesyłce pojawia się po ok. 25 minutach. Zwykle nadanie trwa kilka sekund.

## Przesyłka „nie wiadomo, czy powstała”: co zrobić

1. Kliknij **„Sprawdź u przewoźnika”** (karta zamówienia → sekcja „Przesyłka”). Gdy przesyłka jest nadana, Kompletor ją zapisze.
2. Gdy Kompletor napisze, że przesyłka czeka w przygotowalni ADE bez potwierdzenia nadania: ADE mogło jeszcze kończyć potwierdzenie. Odczekaj kilka minut i kliknij „Sprawdź u przewoźnika” jeszcze raz. Gdy w panelu ADE ta przesyłka dalej leży tylko w przygotowalni, wybierz „Rozstrzygnij ręcznie” → „Nie powstała” i utwórz przesyłkę ponownie: Kompletor dokończy tę samą przesyłkę, nie zrobi drugiej.
3. Gdy Kompletor jej nie znajdzie, otwórz panel ADE, potwierdzenia nadania z danego dnia, i szukaj przesyłki z odciskiem `KMP…` w polu „Referencje” (odcisk pokazuje okno „Rozstrzygnij ręcznie”).
4. Znalazłeś? „Rozstrzygnij ręcznie” → „Istnieje” i wpisz identyfikator przesyłki z ADE (same cyfry). Kompletor sprawdzi w ADE, że ta przesyłka ma referencję tego zamówienia, zanim ją zapisze.
5. „Nie powstała” wybierz dopiero wtedy, gdy przesyłki z tym odciskiem nie ma w potwierdzeniach nadania (w przygotowalni może leżeć, patrz punkt 2).
6. Uwaga na okno przeglądu: „Sprawdź u przewoźnika” przegląda tylko 20 ostatnich potwierdzeń nadania (przy ok. 300 paczkach dziennie to ok. 30–40 minut pracy), a ponowne „Utwórz przesyłkę” po błędzie 100 ostatnich (ok. 2,5–3 godziny). Przesyłki nadanej wcześniej Kompletor już nie zobaczy i zrobi drugą. Gdy od nieudanej próby minęło więcej czasu, sprawdź potwierdzenia z całego dnia w panelu ADE ręcznie (punkt 3), zanim wybierzesz „Nie powstała”.
7. „Rozstrzygnij ręcznie” → „Nie powstała” zamyka starą próbę na Twoją odpowiedzialność: następne „Utwórz przesyłkę” dostaje nowy odcisk i Kompletor nie szuka już przesyłki ze starym. Jeśli stara jednak istnieje w ADE, powstanie druga.

## Czego system nie robi

- Nie anuluje przesyłki: ADE nie usuwa przesyłki po potwierdzeniu nadania, a Kompletor potwierdza ją od razu. Pomyłkę zgłoś w GLS. Przesyłkę z przygotowalni bez nadania usuniesz w panelu ADE.
- Nie zamawia kuriera po paczki i nie drukuje protokołu przekazania z ADE.
- Nie wycenia przesyłki (cena wynika z umowy z GLS).
- Nie dodaje usług dodatkowych poza pobraniem i punktem GLS (doręczenie do 10:00 albo 12:00, w sobotę, zwrot dokumentów, przesyłka zwrotna).
- Nie wysyła za granicę: moduł jest krajowy.
- Nie ma wyszukiwarki punktów GLS: kod punktu musi przyjść z zamówienia albo z poprawki odbiorcy na karcie zamówienia.
- Nie robi zbiorczego potwierdzenia nadania: każda przesyłka dostaje osobne potwierdzenie, więc kierowca dostaje ich kilka dziennie.
- Nie pobiera w innej walucie niż złoty. Zamówienie dziś nie niesie waluty, więc Kompletor liczy je jak w złotych; moduł GLS ma już blokadę pobrania dla innej waluty, która zadziała, gdy zamówienie zacznie ją przekazywać.

Self-host: wiersz „GLS” w karcie „Odbiory” pojawia się po zapisaniu kluczy GLS w bazie firmy (konto przewoźnika). Instalacja z kluczami tylko w zmiennych środowiska (`envPrefix`) tego wiersza nie zobaczy; godziny odbioru GLS ustawisz wtedy dopiero po zapisaniu konta w panelu.

## Jak podłączyć

1. Poproś opiekuna GLS o dostęp do API ADE: login i hasło użytkownika ADE. **Dane do ADE testowego i produkcyjnego są różne**; zacznij od testowego.
2. Ustawienia → Wysyłka i druk → Przewoźnicy → przycisk „Konta przewoźników” → konto „GLS”: wpisz login i hasło ADE, w „Zaawansowane” wybierz środowisko (domyślnie testowe), zapisz i kliknij „Sprawdź połączenie”.
3. Ustawienia → Wysyłka i druk → Przewoźnicy → karta reguł: „Dodaj regułę”, słowa z nazwy sposobu dostawy w Twoim sklepie (np. „gls”), przewoźnik „GLS”, moduł „GLS (bezpośrednio, ADE)” (tylko liczy) albo „… nadawanie za wyłącznikiem” (nadaje).
4. W tej samej karcie „Odbiory” ustaw dni i godzinę przyjazdu kuriera GLS (kolejka pakowania układa się od najbliższego odbioru). Wiersz „GLS” widać dopiero po zapisaniu kluczy konta albo reguły z przewoźnikiem GLS.
5. Uzupełnij Ustawienia → Dokumenty i faktury → Dane firmy: nazwa, adres, kod pocztowy, miasto i telefon (to nadawca na etykiecie).
6. Nadawanie włącza właściciel firmy po próbie na koncie testowym: Ustawienia → Wysyłka i druk → Przewoźnicy → „Konta przewoźników” → konto „GLS” → przełącznik „Nadawanie z Kompletora”. Przesyłki nadaje tylko konto sprzedaży w trybie pracy.

Self-host: klucze mogą przyjść z env (`GLS_ADE_LOGIN`, `GLS_ADE_HASLO` z przedrostkiem `envPrefix` reguły), a adres usługi z `baseUrl` (tylko adres produkcyjny albo testowy ADE).

## Pola

| Pole | Gdzie | Co znaczy |
|---|---|---|
| Login ADE | konto przewoźnika (klucz) | użytkownik ADE z dostępem do API |
| Hasło ADE | konto przewoźnika (klucz) | szyfrowane, nie wraca na ekran |
| Środowisko | konto przewoźnika, „Zaawansowane” | testowe (domyślnie) albo produkcyjne |
| Waga domyślna | konto przewoźnika | waga paczki, gdy produkty nie mają wagi (wtedy niebieska informacja „Paczka pójdzie z wagą …”, bez potwierdzania; bez tego ustawienia paczka idzie z wbudowanym 1 kg i to trzeba zaznaczyć przed nadaniem) |
| Limit pobrania | konto przewoźnika | najwyższa kwota pobrania wg umowy (domyślnie 10 000 zł) |
| Nadawanie z Kompletora | Konta przewoźników, przełącznik przy koncie | bez niego moduł nie wysyła do ADE żadnego żądania nadania, etykiety ani odszukania |
| Format etykiety | reguła przewoźnika (`formatEtykiety`) | PDF (domyślnie) albo ZPL |

## Do sprawdzenia na koncie testowym ADE

Zanim właściciel włączy nadawanie na produkcji, osoba techniczna sprawdza na ADE testowym:

1. Przestrzeń nazw i `SOAPAction` z WSDL (`…/ade_webapi2.php?wsdl`); Kompletor zakłada `urn:ade_webapi2`.
2. Adres produkcyjny ADE (`adeplus.gls-poland.com/adeplus/pm1/ade_webapi2.php`).
3. Kształt odpowiedzi `adeLogin` (`session`), `adePreparingBox_Insert` i `adePickup_Create` (`id`), `adePickup_GetConsignBinds` (lista z `id`).
4. Kody błędów w `faultcode` (tabela w `lib/adaptery/gls-kody.ts`): zły login, wygasła sesja, zły kod pocztowy, za dużo sesji. Fault `Client`, `VersionMismatch` i `MustUnderstand` Kompletor przy nadaniu traktuje jak odmowę przed wykonaniem (np. zła przestrzeń nazw), a inny Fault bez kodu `err_*` (np. `SOAP-ENV:Server`) jak „nie wiadomo, czy powstała”.
5. Długość pola `references` (Kompletor wpisuje 25 znaków) i czy wraca w `adePreparingBox_GetConsign` i `adePickup_GetConsign`; czy te metody zwracają też `rzipcode`, `rstreet`, `srv_sds.id`, `weight` (przesyłki, poza listą paczek), `srv_bool.cod_amount` i `date` (na nich stoi porównanie przed dokończeniem starego przygotowania; brak kodu, ulicy albo wagi = Kompletor nie dokończy, brak daty = data nieporównywana, data z godziną porównywana po dniu).
6. Metody listy: `adePreparingBox_GetConsignIDs`, `adePickup_GetIDs` (przesyłki potwierdzenia Kompletor czyta jednym `adePickup_GetConsignBinds`, pola `id`): **kierunek sortowania** (rosnąco czy od najnowszych), ile identyfikatorów na stronę i co znaczy `id_start` (Kompletor podaje ostatni identyfikator poprzedniej strony i czyta do pustej strony, najwyżej 200 stron; pierwsza strona malejąca i pełna = najnowsze już są). Przy sortowaniu rosnąco przegląd czyta całą listę potwierdzeń: przy kilkunastu tysiącach potwierdzeń dojdzie do limitu stron i zatrzyma się z komunikatem. Jeśli `id_start` okaże się przesunięciem (numerem pozycji), a nie identyfikatorem, druga strona wróci pusta i przegląd po cichu obejmie tylko pierwszą. **Nie włączać nadawania (przełącznik „Nadawanie z Kompletora”), dopóki na ADE testowym nie potwierdzono znaczenia `id_start` i kierunku sortowania** (lista z ponad 100 pozycjami, dwie strony).
7. Tryby etykiet: `roll_160x100_vertical_pdf` (PDF) i tryb ZPL (Kompletor zakłada `roll_160x100_zebra`).
8. Punkt GLS: usługa `sds` z kodem punktu z zamówień (format kodu ParcelShop).
9. Limit wagi paczki i pobrania wg umowy firmy.
10. Że `adePickup_Create` na przygotowaniu już nadanym ADE odrzuca, i jak długo przygotowanie leży w przygotowalni po przyjęciu potwierdzenia (Kompletor w tym czasie nie rozstrzyga sam, tylko odsyła do człowieka).
11. Że ADE przyjmuje kwoty i wagi jako tekst z kropką i dwoma miejscami (`120.50`).
12. Czas przeglądu przy ponownym „Utwórz przesyłkę” po błędzie: 100 ostatnich potwierdzeń nadania to ok. 200 żądań do ADE (`adePickup_GetConsignBinds` i `adePickup_GetConsign` dla każdego potwierdzenia). Muszą zmieścić się w 5 minutach budżetu przeglądu; gdy się nie mieszczą, przegląd kończy się błędem (nie „brak”), a okno trzeba zmniejszyć w `lib/adaptery/gls.ts` (`ODSZUKANIE_PONOWIENIE`).

Wynik sprawdzenia wpisz w [Co jeszcze nie działa](../co-jeszcze-nie-dziala.md).

## Skąd wiedza o API

Konektor Open Integration Platform (Apache 2.0, informacja w `THIRD_PARTY_NOTICES.md` w repozytorium): kolejność wywołań sesji i nadania, nazwy pól przesyłki, etykiety jedno- i wielopaczkowe, adres testowy. Odszukanie po referencji, klasy błędów i idempotencja są własne Kompletora.
