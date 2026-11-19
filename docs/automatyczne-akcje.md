# Automatyczne akcje: co Kompletor robi sam

Automatyczna akcja to reguła „kiedy → jeśli → zrób”: gdy coś dzieje się z zamówieniem (przyszła płatność, zamówienie
zebrano, przesyłka powstała), a zamówienie spełnia warunki (sklep, sposób dostawy, kwota…), Kompletor wykonuje kroki
po kolei (ustawia status, planuje mail, tworzy przesyłkę). Tak samo jak „Automatyczne akcje” w BaseLinkerze. Każda
firma układa własne reguły pod własne statusy ([Statusy zamówień](statusy.md)).

## Gdzie to jest

Menu **Ustawienia → Sprzedaż i kanały → Automatyczne akcje** (sekcja „Sprzedaż”). Adres: `/ustawienia/automaty`. Ekran widzi osoba
z uprawnieniem `ustawienia` (właściciel i administrator). Zakładki: „Automatyczne akcje” (reguły) i „Grupy akcji”.

Przyciski reguł („Kliknięto przycisk”) są na **karcie zamówienia** (pod nagłówkiem, dla osób z uprawnieniem do zmian
etapu zamówienia) i na **stanowisku pakowania** po „Spakowane”, zależnie od ustawienia reguły.

Czego ten ekran nie robi: nie zmienia nazw ani kolorów statusów (to **Ustawienia → Sprzedaż i kanały → Statusy zamówień**), nie ustawia
kont przewoźników ani włączenia nadawania (**Ustawienia → Wysyłka i druk → Przewoźnicy**), nie włącza wysyłki maili (**Ustawienia →
Komunikacja i poczta → Poczta**) ani wystawiania faktur (**Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży**).

## Szablony

Nie musisz układać reguł od zera. Gotowy przepływ (statusy i automatyczne akcje) wczytasz przyciskiem **Wczytaj
szablon** w nagłówku ekranu **Ustawienia → Sprzedaż i kanały → Automatyczne akcje** (adres `/ustawienia/automaty/szablony`, uprawnienie
`ustawienia`). Ten sam ekran otwiera krok **Przepływ pracy** z listy uruchomienia na pulpicie, a nowa firma może wybrać
szablon już w kreatorze pierwszego uruchomienia (pole „Jak pracujesz z zamówieniami”).

| Szablon | Dla kogo | Statusy | Reguły |
| --- | --- | --- | --- |
| Kurier i paczkomaty | sklep wysyłający paczki kurierem albo do paczkomatów | Nowe → Do realizacji → Zbieranie → Spakowane → Do wysłania → Wysłane | opłacone i pobranie → Do realizacji; utworzono przesyłkę → Do wysłania + etykieta; kurier odebrał paczkę → Wysłane; bez płatności 2 dni robocze → e-mail „Brak płatności”, 5 dni → anuluj |
| Odbiór osobisty | sklep stacjonarny, punkt odbioru | Do realizacji → Spakowane → Do odbioru → Odebrane | opłacone → Do realizacji; spakowano odbiór osobisty → Do odbioru + e-mail „Gotowe do odbioru”; przycisk „Klient odebrał” → Odebrane; bez płatności 2 dni → e-mail |
| Allegro z Wysyłam z Allegro | sprzedaż na Allegro z przesyłkami Wysyłam z Allegro | jak kurier | jak kurier + przyciski „Gabaryt A/B/C” (zamówienia z Allegro) tworzą przesyłkę Wysyłam z Allegro |
| Minimalny, bez wysyłki | usługi, produkty cyfrowe | Nowe → Opłacone → Zrealizowane (etapy magazynu ukryte) | opłacone → Opłacone; zrealizowane zamówienie bez wysyłki → Zrealizowane; bez płatności 2 dni → e-mail |

Każdy szablon ma na ekranie opis „dla kogo”, tor statusów w ich kolorach i listę reguł. Kliknięcie nazwy pokazuje
**co się zmieni** w Twojej firmie, zanim cokolwiek zapiszesz:

- **Firma bez zamówień i bez reguł, ze statusami domyślnymi:** szablon wchodzi w całości. Statusy dostają nazwy
  z szablonu (te same etapy pracy), grupy i reguły szablonu powstają **włączone**.
- **Każda inna firma:** nic nie jest nadpisywane. Twoje statusy i reguły zostają bez zmian, a reguły szablonu trafiają
  do **nowej grupy „Szablon: <nazwa>”, wyłączone**. Status z reguły szablonu to Twój status tego samego etapu (ta
  sama nazwa klucza, inaczej pierwszy Twój aktywny status tego etapu). Podgląd pokazuje te dopasowania. Wczytanie
  drugi raz tworzy kolejną grupę z dopiskiem „(2)”.

Czego „Wczytaj szablon” nie robi: nie łączy szablonów z Twoimi regułami, nie usuwa niczego, nie włącza wysyłki maili,
nadawania przesyłek ani faktur (każdy krok działa dopiero, gdy odpowiednia rzecz jest włączona w Ustawieniach).
Reguły z szablonu sprawdzisz przed włączeniem przyciskiem „Sprawdź” (podgląd na sucho).

Szablony leżą w plikach instalacji (statusy jak w presecie firmy, reguły w formacie niżej). Preset firmy
(`seed/presety/<firma>.json`) może nieść własne reguły w kluczach `automationGroups` i `automationRules` (ten sam
format; zakładane tylko firmie bez żadnej reguły). Preset konkretnej firmy nie jest szablonem dla innych firm.

## Lista reguł

- Reguły są w grupach (zwijanych). Wykonują się od góry: najpierw „Bez grupy”, potem grupy w kolejności z zakładki
  „Grupy akcji”, w grupie od góry.
- Kolumna „Zdarzenie”: co uruchamia regułę i warunki w pigułkach („Przesyłka zawiera frazę | DPD, Kurier”;
  „nie:” = warunek odwrotny).
- Kolumna „Wykonywane akcje”: kroki ponumerowane w kolejności wykonania.
- Przełącznik włącza i wyłącza regułę. **Nowa reguła startuje wyłączona**: „Zapisz i włącz” w oknie albo przełącznik.
- „Sprawdź”: podgląd na sucho (niżej). „Duplikuj”: kopia pod spodem, wyłączona. „Usuń”: reguła, która już coś
  zrobiła albo pochodzi z ustawień startowych firmy (presetu), jest wyłączana i ukrywana, a jej wpisy zostają w historii
  zamówień; ponowne wczytanie presetu jej nie przywraca.
- Kolejność zmieniasz przeciągając wiersz (także do innej grupy) albo strzałkami ▲▼ (klawiatura, telefon).
- Pod regułą: ile razy zadziałała w ostatnich 7 dniach i ostrzeżenia.

## Zdarzenia

| Zdarzenie | Kiedy |
|---|---|
| Zamówienie zostało opłacone | Płatność przyszła; także zamówienie opłacone od razu przy przyjęciu (nie pobranie). |
| Pobrano zamówienie | Nowe zamówienie przyszło ze sklepu, z panelu albo przez API. |
| Ustawiono status | Status się zmienił (ręcznie, na stanowisku, przez Kompletor albo przez inną regułę). |
| Rozpoczęto zbieranie produktów zamówienia | Wydruk karty zbierania. |
| Zebrano produkty zamówienia | Wszystko zebrane. |
| Spakowano zamówienie | „Spakowane” na stanowisku. |
| Utworzono przesyłkę | Przesyłka powstała u przewoźnika. |
| Zmieniono status przesyłki u kuriera | Śledzenie przesyłek odczytało nowy status (co 15 min, przewoźnicy ze śledzeniem). |
| Zamówienie w statusie określoną liczbę dni | Sprawdzane co kwadrans; raz na jeden pobyt zamówienia w statusie. |
| Błąd przy wystawianiu faktury | Program do faktur odrzucił fakturę. |
| Anulowano zamówienie | Anulowanie w sklepie, w panelu albo po terminie płatności. |
| Kliknięto przycisk | Ktoś kliknął przycisk reguły na karcie albo na stanowisku. |

Zdarzenia czyta Kompletor z historii zamówień co 30 sekund (z około 30-sekundowym zapasem na zapis), więc reguła
działa najpóźniej około minuty po zdarzeniu. Gdy w tej chwili trwa dłuższy zapis (np. przyjęcie dużej paczki
zamówień), odczyt czeka, aż się skończy: zdarzenie z takiego zapisu nie przepada, reguła zadziała chwilę później.
„Opłacono” działa raz na zamówienie: zamówienie opłacone od razu przy przyjęciu daje je przy przyjęciu, a płatność,
która przyszła później, w chwili płatności.

## Warunki

Wszystkie warunki reguły muszą być spełnione naraz. Liczy się **stan zamówienia w chwili sprawdzania** (nie pamięć
o zdarzeniu). Warunki ze słowem „nie” działają odwrotnie.

| Warunek | Znaczenie |
|---|---|
| Źródło (z „nie”) | Kanał (dowolne konto, np. dowolne konto Allegro) albo jedno konto sklepu. |
| Pobranie | Płatność przy odbiorze: tak albo nie. |
| Opłacone | Opłacone (pobranie liczy się jak opłacone). |
| Przesyłka zawiera frazę (z „nie”) | Nazwa metody dostawy ze sklepu zawiera jedną z fraz; wielkość liter i polskie znaki bez znaczenia. |
| Przewoźnik (z „nie”) | Przewoźnik wyznaczony dla zamówienia (Ustawienia → Wysyłka i druk → Przewoźnicy). |
| Status (z „nie”) | Bieżący status firmy. |
| Kwota zamówienia | Brutto od–do. |
| Zamówienie w statusie | Liczba dni (roboczych albo wszystkich) w obecnym statusie; tylko ze zdarzeniem „w statusie określoną liczbę dni”. |
| Status przesyłki u kuriera (z „nie”) | Status od przewoźnika zawiera frazę; tylko ze zdarzeniem „Zmieniono status przesyłki u kuriera”. |

## Kroki

| Krok | Co robi | Kiedy zostaje pominięty |
|---|---|---|
| Ustaw status | Status firmy. Ten sam etap pracy = sama zmiana nazwy. Inny etap tylko tam, gdzie wolno przejść z obecnego. | Przejście niedozwolone (np. z „Wysłane” do „Do realizacji”, spakowanie bez stanowiska, „Nowe” → „Do realizacji” bez płatności); konto sklepu w trybie podglądu (także przy samej zmianie nazwy, jak „Zmień status” na karcie). |
| Wyślij e-mail | Mail z szablonu (Brak płatności, Faktura, Gotowe do odbioru, Błąd faktury do biura) przez pocztę firmy. | Konto sklepu w podglądzie = tylko zapis „wysłałbym”; „Brak płatności” bez terminu anulowania; „Faktura” bez faktury; ten sam mail planuje już wbudowany plan maili (przypomnienie o płatności już wysłane, zamówienie „Do odbioru”, „Faktura” dla wysłanego zamówienia albo tej samej faktury, „Błąd faktury” przy każdej nieudanej fakturze poza chwilowym limitem programu do faktur), żeby klient nie dostał dwóch. Krok „Błąd faktury” działa więc tylko dla błędów limitu programu do faktur (`LIMIT:`): zwykłe błędy faktury zgłasza biuru sam Kompletor. „Faktura” z reguły uruchomionej zdarzeniem (np. „Wysłane, Odebrane → Faktura”) nie wychodzi drugi raz dla tej samej faktury, gdy mail z nią jest już zaplanowany albo wysłany; inna faktura tego zamówienia dostaje swój mail. Ponowna wysyłka tej samej faktury idzie z reguły z przyciskiem: każde kliknięcie planuje mail. |
| Wystaw fakturę | Nieudaną fakturę oddaje do kolejki faktur ponownie. Nową wystawia Kompletor sam po spakowaniu, gdy wystawianie jest włączone. | Brak faktury do ponowienia. |
| Anuluj fakturę | Nieudana faktura jest już anulowana przez Kompletor (towar wraca do rezerwacji). | Wystawionej faktury reguła nie cofa (korekta z karty zamówienia). |
| Utwórz przesyłkę | Przesyłka u przewoźnika zamówienia, opcjonalnie z gabarytem. | Nadawanie wyłączone w ustawieniach przewoźnika, konto w podglądzie, status, w którym przesyłki się nie tworzy. |
| Wydrukuj etykietę | Najnowsza etykieta przesyłki na stanowisku druku. | Brak przesyłki albo stanowiska druku. |
| Oznacz zamówienie | Gwiazdka na liście zamówień. | Nigdy. |
| Anuluj zamówienie | Anulowanie przez Kompletor (zwolnienie rezerwacji, informacja do sklepu przez zwykły zapis do sklepu). | Po fakturze reguła nie anuluje; konto sklepu w trybie podglądu. |

Każdy zapis do sklepu, przewoźnika i programu do faktur idzie tą samą drogą co z ekranów, za tymi samymi
wyłącznikami (konto w trybie pracy, „zapis włączony”, „nadawanie włączone”, „wystawiaj faktury”).

## Bezpieczniki

- **Kolejność pracy pilnuje Kompletor.** Reguła prosi o zmianę statusu, Kompletor wykonuje ją tylko, gdy przejście jest
  dozwolone. Pominięty krok zostaje w historii zamówienia z powodem („Reguła „X” pominięta: przejście niedozwolone…”).
  Okno edycji nie pozwala zapisać kroku, którego przy warunku statusu nigdy nie da się wykonać.
- **Pętle.** Reguły, które przestawiają status nawzajem, zatrzymują się po 5 zmianach z rzędu; biuro dostaje alert
  „reguły przestawiają status zamówienia w kółko”.
- **Raz na zdarzenie.** Ta sama reguła wykonuje się najwyżej raz na jedno zdarzenie jednego zamówienia (także przy
  podwójnym kliknięciu przycisku).
- **Konflikty.** Lista i zapis ostrzegają, gdy dwie włączone reguły tego samego zdarzenia mogą zadziałać na tym samym
  zamówieniu i ustawiają różne statusy: wykonają się obie, zostanie status z reguły niżej na liście. Ostrzeżenie
  jest przybliżone (różne frazy przesyłki traktujemy jako rozłączne). Druga uwaga: reguła bez warunków na częstym
  zdarzeniu działa dla każdego zamówienia.
- **Podgląd na sucho** („Sprawdź” na liście albo „Sprawdź na ostatnich 7 dniach” w oknie): reguła przechodzi po
  zamówieniach z ostatnich 7 dni i mówi, co by zrobiła („zadziałałaby na 12 zamówieniach: zmieniłaby status 12
  zamówień, wysłałaby 3 maile”). Nic nie jest zapisywane ani wysyłane. Warunek statusu jest sprawdzany na dzisiejszym
  statusie zamówienia, więc wynik to przybliżenie.
- **Historia.** Na karcie zamówienia w „Historii”: „Reguła „X” ustawiła status „Y””, „Reguła „X”: e-mail …”,
  „Reguła „X” pominięta: …”.
- **Przerwane wykonanie.** Gdy system zatrzyma się w połowie kroków reguły (np. restart), kroki nie są powtarzane
  (część mogła już pójść). Po 10 minutach wykonanie dostaje wynik „przerwane”, a biuro alert z listą kroków reguły do
  sprawdzenia na karcie zamówienia.
- **Przycisk tylko w swoim miejscu.** Przycisk działa tam, gdzie reguła go pokazuje (karta albo stanowisko). Klucz
  kliknięcia powstaje przy wyświetleniu strony: podwójne kliknięcie to jedno wykonanie, ale kliknięcie, odświeżenie
  strony i ponowne kliknięcie to dwa wykonania (przesyłki i status Kompletor i tak nie zdubluje).

## Przykłady

1. Opłacone + przesyłka zawiera „odbiór” → Ustaw status „Do odbioru w sklepie”.
2. Zamówienie w statusie „Nowe” 3 dni robocze → Wyślij e-mail „Brak płatności”.
3. Przycisk „Paczka mała” (karta i stanowisko) → Utwórz przesyłkę, gabaryt A.
4. Utworzono przesyłkę → 1. Ustaw status „Do wysłania”, 2. Wydrukuj etykietę.

## Firma przechodząca z BaseLinkera

Przeprowadzka z BaseLinkera przenosi statusy BL jako statusy firmy. Automatycznych akcji BL przenieść się nie da:
API BaseLinkera ich nie udostępnia. W ich miejsce przeprowadzka zakłada **wyłączone** reguły najbliższego szablonu
w grupie **„Z BaseLinkera”**, przepisane na zaimportowane statusy. Sprawdź je na podglądzie na sucho i włącz te,
które odpowiadają Twoim akcjom z BL; resztę dopisz sam ([Migracja z BaseLinkera](migracja-z-baselinkera.md)).

Przepływ firmy z BL (statusy po płatności, zbieraniu i pakowaniu, maile, przyciski kurierów) to reguły presetu firmy,
zakładane przy zakładaniu firmy albo poleceniem `npm run org:automaty -- <firma> [--sucho]` (tylko brakujące reguły,
drugi raz bez zmian). Każda akcja BL ma swoją regułę z tą samą nazwą, grupą i kolejnością; te, które Kompletor robi
dziś inną drogą (faktura po spakowaniu, terminy płatności z polityki rezerwacji, przyciski kurierów na karcie), są
wyłączone, żeby nie dublować pracy. Pełna tabela z różnicami: [Automatyczne akcje BL](akcje-bl.md).

Konto sklepu w podglądzie (zamówienia prowadzi jeszcze BaseLinker): krok „Ustaw status” nic nie zmienia, a zamówienie
pokazuje status domyślny etapu (Ustawienia → Sprzedaż i kanały → Statusy zamówień, przypisanie przewoźników). Takie pominięcie przy regule
uruchomionej zdarzeniem nie trafia do historii zamówienia (widać je tylko w wyniku wykonania), żeby historia była taka
sama jak bez reguł. Przycisk kliknięty w podglądzie zapisuje pominięcie w historii, jak dotąd.

## Maile do zamówień: plan wbudowany

Nad listą reguł jest przełącznik **„Maile do zamówień planuje też Kompletor (Brak płatności, Faktura, Błąd faktury,
Gotowe do odbioru)”**. Włączony (domyślnie): te maile wychodzą także bez reguł, a krok „Wyślij e-mail” pomija mail, który
Kompletor już zaplanował, i odwrotnie: plan nie dokłada maila zaplanowanego przez regułę. Ten sam mail wychodzi raz.
Wyłączony: te maile wychodzą tylko z reguł z krokiem „Wyślij e-mail”; bez takiej reguły klient ich nie dostanie. Zmiana
przełącznika trafia do dziennika zmian. Mail o niskim stanie produktu (do biura) działa zawsze. **Dwie reguły z tym
samym szablonem maila wyślą go dwa razy** (każda reguła to osobny mail), tak jak w BaseLinkerze.

## Maile o zwrotach i reklamacjach

Pod nim jest drugi przełącznik: **„Maile do klienta o zwrotach i reklamacjach (Zwrot dotarł, Reklamacja dotarła,
Pieniądze zwrócone)”**, domyślnie wyłączony (także po ustawieniach startowych firmy). Włączony: klient dostaje mail,
gdy magazyn odbierze paczkę ze zwrotem albo reklamacją i gdy przy zwrocie zapisany jest zwrot pieniędzy; zwrot
odrzucony maila nie dostaje. Maile dotyczą tylko zwrotów odebranych od chwili włączenia (włączenie nie wysyła maili
o wcześniejszych zwrotach). Krok „Wyślij e-mail” w regułach tych szablonów nie ma. Szczegóły: [Zwroty i
reklamacje](zwroty-i-reklamacje.md#maile-do-klienta). Zmiana przełącznika trafia do dziennika zmian.

## Opis reguły

W oknie reguły pole **„Opis dla zespołu (opcjonalnie)”** (do 300 znaków): krótko, po co reguła jest albo dlaczego
jest wyłączona. Opis widać na liście pod nazwą reguły. Reguły z ustawień startowych firmy, które są wyłączone, mają
w opisie powód (np. „fakturę wystawia Kompletor po spakowaniu”), żeby nikt nie włączył ich w ciemno.

## Widok zwarty

Przy dłuższej liście (od 20 reguł) lista startuje w **widoku zwartym**: jedna linia na regułę (zdarzenie, warunki,
kroki, przy wyłączonej napis „Wyłączona”), bez podpisu z nazwą reguły, opisu i licznika z 7 dni; nazwa i opis reguły
są w podpowiedzi po najechaniu na zdarzenie.
Przełącznik „Widok zwarty” obok „Dodaj automatyczną akcję”, wybór zapamiętuje przeglądarka. Na telefonie lista
wygląda tak samo w obu widokach.

## Dla integratora

Odczyt reguł i wykonań: `GET /api/v1/automaty` i narzędzie MCP `automaty` (dokumentacja API dla integratorów). Zapis reguł przez API
nie jest dostępny.

Reguły reagujące na zdarzenia czytają dziennik zamówień z opóźnieniem około 30 s i nie dalej niż do początku
najstarszej trwającej transakcji w bazie. Ten horyzont jest wspólny dla całej bazy: długa transakcja jednej firmy albo
nocny `pg_dump` opóźnia automaty wszystkich firm, najwyżej o 15 minut. Żadne zdarzenie nie przepada, wykona się
w następnym przebiegu.
