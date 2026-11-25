# Allegro: połączenie, stany, statusy, numery nadania i Wysyłam z Allegro

> **Stan na 06.11.2026: przygotowane, sprawdzone na symulowanym koncie Allegro.** Zapis do prawdziwego konta włącza się dopiero po decyzji właściciela firmy. Nowe konto Allegro startuje w trybie „Tylko podgląd” i z wyłączonym zapisem: czyta zamówienia i niczego w Allegro nie zmienia.

Ten opis jest dla osoby, która sprzedaje na Allegro i chce podłączyć konto do Kompletora bez terminala, a potem, gdy będzie gotowa, pozwolić Kompletorowi aktualizować stany ofert, status realizacji, numery nadania i nadawać paczki Wysyłam z Allegro (to samo, co robi BaseLinker albo inny system do zamówień).

## Gdzie to jest

| Co | Droga z menu | Adres | Kto widzi |
| --- | --- | --- | --- |
| Dodanie konta Allegro | **Ustawienia** → **Sprzedaż i kanały** → **Kanały sprzedaży** → przycisk **Dodaj sklep** → kafel **Allegro** | `/ustawienia/kanaly/nowy?platforma=allegro` | uprawnienie „Ustawienia” (rola właściciel) |
| „Połącz z Allegro”, stan połączenia | **Ustawienia** → **Sprzedaż i kanały** → **Kanały sprzedaży** → kliknij konto Allegro → sekcja **Połączenie z Allegro** | `/ustawienia/kanaly/ALLEGRO.<identyfikator>#allegro` | jak wyżej |
| Tryb konta (Tylko podgląd / Aktywny) | to samo konto → sekcja **Stan konta** | `/ustawienia/kanaly/ALLEGRO.<identyfikator>#stan` | jak wyżej |
| Wyłącznik zapisu i tabela „Statusy w sklepie” | to samo konto → sekcja **Zapis do sklepu** | `/ustawienia/kanaly/ALLEGRO.<identyfikator>#zapis` | jak wyżej |
| Utwórz przesyłkę Wysyłam z Allegro | **Zamówienia** → zamówienie z Allegro → sekcja **Przesyłka** → „Utwórz przesyłkę: Allegro A”, „…B”, „…C”; albo **Stanowisko** → „Spakowane” → gabaryt → „Utwórz przesyłkę” | karta zamówienia, stanowisko pakowania | uprawnienie do stanowiska pakowania |
| Anuluj przesyłkę, etykieta | ta sama sekcja **Przesyłka** (karta zamówienia i stanowisko): „Anuluj przesyłkę”, „Pobierz etykietę”, „Drukuj etykietę ponownie” | jak wyżej | jak wyżej |

## Połączenie konta krok po kroku

1. Na stronie Allegro dla programistów (`apps.developer.allegro.pl`) zarejestruj aplikację **bez dostępu do przeglądarki** (logowanie kodem z urządzenia, „device flow”) `[do potwierdzenia]`. Skopiuj Client ID i Client Secret. Użyj **osobnej** aplikacji dla Kompletora, nie tej, z której korzysta BaseLinker albo inny program: Allegro unieważnia stary token po odświeżeniu, więc dwa programy na jednej parze tokenów psują sobie dostęp.
2. W Kompletorze: **Dodaj sklep** → **Allegro**, wklej Client ID i Client Secret, kliknij **Zapisz i połącz z Allegro**. Pola „Nazwa aplikacji (User-Agent)”, adresy API i autoryzacji są w „Zaawansowane” i mają wartości domyślne; sandbox Allegro wpisujesz tam (`https://api.allegro.pl.allegrosandbox.pl`, `https://allegro.pl.allegrosandbox.pl`). Kreator zakłada od razu wersję konta z zapisem, ale z **wyłączonym** zapisem i w trybie „Tylko podgląd”, więc później nie trzeba niczego przełączać, a do tego czasu nic nie wychodzi.
3. Ekran konta pokaże przycisk **Otwórz Allegro i zatwierdź** i kod (np. `ABC-123`). Właściciel konta Allegro loguje się, sprawdza, że kod się zgadza, i klika „Zezwól”. Na innym urządzeniu można wejść na podany adres i wpisać kod ręcznie. Link jest ważny ok. godziny.
4. Ekran sam sprawdza wynik co kilka sekund. Po zatwierdzeniu pokazuje „Połączone” i od razu zleca „Sprawdź połączenie”. Odmowa w Allegro albo wygaśnięcie linku niczego nie zapisuje; wtedy klikasz „Połącz z Allegro” jeszcze raz. „Anuluj” przerywa czekanie.

Administrator może połączyć konto także poleceniem na serwerze (to samo co przycisk, przydatne bez dostępu do panelu):

```
docker compose exec web kompletor cien allegro-autoryzuj --konto <identyfikator konta> [--z-przesylkami] [--z-ofertami]
```

### Odnowienie dostępu

Dostęp (token) jest ważny ok. 12 godzin; Kompletor odnawia go sam przed końcem. Ekran konta pokazuje, kiedy ostatnio. Po wylogowaniu konta w Allegro albo po ok. 3 miesiącach bez użycia Allegro odrzuca dostęp: stan konta zmienia się na „Błąd”, sekcja Allegro pisze „Wymaga ponownego połączenia”, a Ty klikasz **Połącz ponownie z Allegro**.

## Zakresy uprawnień: do czego Kompletor ma dostęp

Przy „Połącz z Allegro” zaznaczasz funkcje. Kompletor prosi Allegro tylko o zakresy tych funkcji:

| Funkcja | Zakres Allegro | Domyślnie |
| --- | --- | --- |
| Odczyt zamówień | `allegro:api:orders:read` | zawsze |
| Odczyt przesyłek (Wysyłam z Allegro, podgląd) | `allegro:api:shipments:read` | tak |
| Odczyt ofert („Pobierz oferty”, przypisanie po SKU, EAN ze szczegółów oferty) | `allegro:api:sale:offers:read` | tak |
| Status i numer nadania w zamówieniu | `allegro:api:orders:write` | nie |
| Stany ofert | `allegro:api:sale:offers:read` + `allegro:api:sale:offers:write` | nie |
| Nadawanie Wysyłam z Allegro | `allegro:api:shipments:read` + `allegro:api:shipments:write` | nie |

Funkcje zapisu zaznaczasz świadomie. Nawet z takim zakresem Kompletor niczego w Allegro nie zmienia, dopóki konto ma tryb „Tylko podgląd” albo wyłączony zapis. Nowe połączenie **zastępuje** poprzednie, więc zaznacz komplet funkcji naraz; dotychczasowe połączenie działa, dopóki nie zatwierdzisz nowego. Ekran konta pokazuje, na co pozwala obecne połączenie („Kompletor może: …”). Zakres bierzemy z odpowiedzi Allegro, nie z prośby: przy połączeniu i przy każdym odświeżeniu tokena zapisujemy `scope`, który Allegro faktycznie przyznało (`ALLEGRO_TOKEN_SCOPE`, w tej samej rotacji co para tokenów), więc ekran pokazuje stan po stronie Allegro. Gdy Allegro nie zwróci zakresu, zostaje poprzedni.

Brak którejś zgody nie psuje reszty: przy tej jednej czynności Kompletor pokaże „konto nie ma zgody na funkcję …: połącz konto z Allegro ponownie z zaznaczoną funkcją”.

## Co Kompletor czyta i co zapisuje

Czyta zawsze (także w trybie „Tylko podgląd”): zamówienia z dziennika zdarzeń Allegro z danymi odbiorcy, oferty (gdy jest zgoda „Odczyt ofert”) i stan przesyłek Wysyłam z Allegro (gdy jest zgoda „Odczyt przesyłek”).

### Skąd Kompletor bierze SKU i EAN oferty Allegro

- **SKU** to **sygnatura oferty** (w Allegro: „Sygnatura” przy edycji oferty, w API pole `external.id`). Wpisuje ją sprzedawca. Oferty wystawione bez sygnatury (np. powiązane z towarem tylko w BaseLinkerze) przychodzą bez SKU.
- **EAN** to kod GTIN produktu, do którego oferta jest przypisana w katalogu Allegro (parametr „EAN (GTIN)”). Lista ofert Allegro go nie podaje, więc „Pobierz oferty” czyta szczegóły każdej oferty bez powiązania (jedno zapytanie na ofertę, tylko odczyt, ta sama zgoda „Odczyt ofert”). Na jedno pobranie najwyżej 200 ofert; resztę sprawdzi kolejne „Pobierz oferty”. Oferta, która ma już zapisany EAN albo powiązanie, nie jest odpytywana drugi raz. Gdy Allegro odpowie „za dużo zapytań”, sprawdzanie staje i wraca przy kolejnym pobraniu. Błąd jednej oferty jest w „Błędy pobrania” (sekcja „Oferty”).
- Oferta będąca zestawem kilku produktów albo z kilkoma różnymi EAN zostaje bez EAN: który towar to który, rozstrzygasz ręcznie.

**Oferta bez sygnatury:** po „Pobierz oferty” idź do **Łączenie ofert z produktami** → **„Podgląd: po EAN”**. Oferty z EAN-em, który ma dokładnie jeden aktywny produkt, są w „Połączy”. Oferty bez SKU i bez EAN są na liście „Bez pasującego produktu” z powodem; te przypisujesz ręcznie w „Do przypisania” albo z karty produktu (Powiązania → „Powiąż z ofertą”). Trwale pomaga też wpisanie sygnatury (SKU produktu) w ofercie w Allegro: przy kolejnym pobraniu oferta połączy się po SKU.

Zapisuje tylko przy włączonym zapisie, trybie „Aktywny” i zgodzie na daną funkcję:

| Co | Kiedy | Jak wygląda w Allegro |
|---|---|---|
| Stan oferty | Gdy zmieni się stan dostępny produktu. Spadek idzie od razu, wzrost po najbliższym odczycie zamówień (Allegro samo zdejmuje stan przy zakupie). Raz na dobę, w nocy, wszystkie oferty jeszcze raz. | Liczba sztuk w ofercie. Kompletor zmienia tylko liczbę sztuk i publikację: nie zmienia cen, opisów ani parametrów. Przy stanie 0 kończy ofertę, a gdy towar wróci, wznawia ofertę, którą sam zakończył (sekcja „Stan 0” niżej). |
| Status realizacji | Po zmianie statusu w Kompletorze, według tabeli „Statusy w sklepie” na ekranie konta. | Status w „Moja sprzedaż”: na przykład „W realizacji”, „Wysłane”, „Odebrane”. |
| Anulowanie nieopłaconego | Gdy rezerwacja nieopłaconego zamówienia wygaśnie po terminie. | Status realizacji „Anulowane”, ale tylko wtedy, gdy Allegro nadal nie widzi płatności. Opłacone w międzyczasie zamówienie zostaje bez zmian. |
| Numer nadania | Gdy przesyłka dostanie numer nadania albo gdy ktoś wpisze numer przy „Wysłane”. | Numer przesyłki w zamówieniu (kupujący widzi go w Allegro). Ten sam numer nie trafia do zamówienia dwa razy. Paczki Wysyłam z Allegro Allegro dopisuje samo, Kompletor tylko to sprawdza. |
| Przesyłka Wysyłam z Allegro | Po kliknięciu „Utwórz przesyłkę: Allegro A/B/C” (patrz niżej). | Przesyłka w „Wysyłam z Allegro” z etykietą. |

Domyślna tabela statusów: „Zbieranie” → W realizacji, „Do wysłania” → Do wysłania, „Do odbioru” → Do odbioru, „Wysłane” → Wysłane, „Odebrane” → Odebrane, „Anulowane” i „Anulowane: brak płatności w terminie” → Anulowane. Puste pole = tego przejścia nie wysyłamy.

### Stan 0: zakończenie i wznowienie oferty

Allegro nie przyjmuje liczby 0 na aktywnej ofercie (odrzuca ją kodem `INVALID_OFFER_QUANTITY`). Dlatego przy stanie 0 Kompletor robi to samo, co BaseLinker z ustawieniem „Stan zerowy: Zakończ ofertę”:

- **Stan 0 na aktywnej ofercie:** Kompletor kończy ofertę. Liczba sztuk w zakończonej ofercie zostaje stara, ale oferty nikt nie kupi.
- **Stan 0 na ofercie już zakończonej:** nic nie wysyła, wynik bez błędu.
- **Stan większy niż 0 na ofercie, którą zakończył Kompletor:** najpierw ustawia nową liczbę sztuk, potem wznawia ofertę pod tym samym numerem (Allegro wznawia oferty „Kup teraz”).
- **Oferty zakończonej ręcznie albo przez Allegro Kompletor nie wznawia.** Zmienia w niej tylko liczbę sztuk. Gdy ofertę zakończoną przez Kompletor ktoś wznowi i zakończy sam, Kompletor też jej nie wznawia i zapisuje to w dzienniku („oferta zakończona poza Kompletorem: nie wznawiam”).
- **Bezpiecznik:** najwyżej 100 zakończonych ofert w ciągu 24 h na konto. Kolejne oferty ze stanem 0 zostają aktywne, Kompletor ich nie ponawia i wysyła alert. Chroni to przed masowym zamknięciem ofert po złym odczycie stanów z magazynu. Po sprawdzeniu stanów podnieś limit (albo poczekaj dobę) i kliknij „Wyślij stany ponownie”.
- **Odmowa Allegro** przy kończeniu albo wznawianiu (np. oferta w formacie licytacji) to błąd tej jednej oferty z treścią od Allegro, bez ponawiania co kilka minut i z jednym alertem dziennie. Po wyjaśnieniu: „Wypchnij teraz”.

| Funkcja | Gdzie | Kto widzi |
|---|---|---|
| Ile ofert Kompletor zakończył, limit, ostatnie zakończenia i wznowienia | **Ustawienia** → **Sprzedaż i kanały** → **Kanały sprzedaży** → konto Allegro → sekcja **Zapis do sklepu** → **Stany** → „Stan 0: zakończone oferty” | uprawnienie „Ustawienia” |
| Zachowanie przy stanie 0 („Zakończ ofertę” albo „Wyślij liczbę 0”) i limit zakończeń na dobę | to samo konto → karta **Ustawienia i klucze** → **Zaawansowane** → pola „Przy stanie 0” i „Limit zakończeń ofert na dobę” | jak wyżej |

Ekran nie pokazuje listy wszystkich zakończonych ofert z nazwami; numery ofert są w „Ostatnie zakończenia i wznowienia” (10 ostatnich). Zakończenie i wznowienie używa tej samej zgody co stany („Stany ofert”), więc po wdrożeniu nie trzeba łączyć konta ponownie.

### Jedna zmiana, nawet przy podwójnym kliknięciu

- Stany idą do Allegro „komendą” z numerem wyliczonym z treści paczki. Powtórka tej samej paczki nie tworzy drugiej komendy: Kompletor czyta wynik tej pierwszej. Oferta, którą Allegro odrzuci (np. zakończona), trafia do błędów tej jednej oferty, reszta paczki jest zapisana.
- Status i numer nadania Kompletor najpierw odczytuje z zamówienia. „Już ustawione” = gotowe, bez drugiego zapisu.

## Wyłącznik zapisu: jak włączyć zapis

1. **Połącz konto z potrzebnymi funkcjami** (sekcja „Zakresy uprawnień” wyżej): do zapisu „Stany ofert”, „Status i numer nadania” i, do nadawania, „Nadawanie Wysyłam z Allegro”.
2. **Włącz zapis** w sekcji **Zapis do sklepu** przełącznikiem „Zapis do sklepu” i sprawdź tabelę „Statusy w sklepie”. Przełącznik pokazuje warunki i pyta o potwierdzenie; wyłączyć wolno zawsze. Konto dodane przed kreatorem, które ma jeszcze wersję tylko do odczytu, dostaje w tej sekcji przycisk **Przełącz na wersję z zapisem**: odczyt działa jak dotąd, a zapis zostaje wyłączony, dopóki go nie włączysz.
3. **Przełącz konto na „Aktywny”** w sekcji **Stan konta** (opis: [Tryb praca](../tryb-praca.md)). W trybie „Tylko podgląd” Kompletor liczy, co by wysłał, ale nic nie wychodzi.

Przed pierwszym prawdziwym kontem: test na koncie sandbox Allegro (adres `https://api.allegro.pl.allegrosandbox.pl` w ustawieniach konta).

## Wysyłam z Allegro

- **Włączenie nadawania:** w regule przewoźnika Allegro moduł „Wysyłam z Allegro (nadawanie, etykieta i anulowanie za wyłącznikiem)” (`allegro.wysylam.zapis.v1`) i wyłącznik nadawania (`zapisWlaczony`). Do czasu ekranu edycji reguł ustawia to administrator instancji. Bez tego blok „Przesyłka” dalej tylko liczy paczkę i mówi, czego brakuje. Format etykiety (`formatEtykiety`: PDF albo ZPL dla drukarki termicznej) ustala się w tej samej regule, bo Allegro wybiera go przy tworzeniu przesyłki. Potrzebna jest też zgoda „Nadawanie Wysyłam z Allegro” na połączeniu konta.
- **Tworzenie:** metodę dostawy, punkt odbioru i nadawcę Allegro bierze z zamówienia, Kompletor podaje gabaryt, wagę, pobranie i adres z karty zamówienia. Przesyłka powstaje komendą, którą Allegro przetwarza chwilę; Kompletor czeka na wynik (kilkanaście sekund). Zgubiona odpowiedź albo podwójne kliknięcie nie tworzą drugiej płatnej etykiety: Kompletor pyta Allegro o tę samą komendę. Gdy Allegro wciąż tworzy przesyłkę, karta pokazuje „Do sprawdzenia u przewoźnika” i przycisk „Sprawdź u przewoźnika”.
- **Odrzucenie:** gdy Allegro odrzuci przesyłkę (np. złe wymiary), przesyłka ma stan „Nie utworzono” z kodem błędu Allegro. Po poprawce można kliknąć ponownie.
- **Anulowanie:** „Anuluj przesyłkę” z pytaniem przed wykonaniem. Działa tylko, gdy konto Allegro jest w trybie „Aktywny” (jak tworzenie przesyłki). Po anulowaniu zamówienie nie ma numeru nadania, numer anulowanej przesyłki nie idzie już do Allegro (zostaje w historii zamówienia), a nową przesyłkę można utworzyć od razu.
- **Etykieta:** drukuje się sama na stanowisku po utworzeniu; „Pobierz etykietę” i „Drukuj etykietę ponownie” w sekcji „Przesyłka”.
- **Śledzenie:** co 15 minut Kompletor czyta w Allegro historię statusów paczki (sam odczyt, bez nowej zgody przy połączeniu konta). Gdy Allegro pokazuje paczkę „w drodze”, „wydaną do doręczenia”, „czekającą w punkcie” albo „awizo”, zamówienie z „Do wysłania” przechodzi samo do „Wysłane” (bez kliknięcia „Przyjechał”). Doręczenie zapisuje się w historii zamówienia. Status u przewoźnika widać pod stanem przesyłki na liście przesyłek ([Przesyłki](../przesylki.md)) i w historii zamówienia. Szczegóły techniczne: „Wysyłam z Allegro” (`docs/wysylam-z-allegro.md`).
- **Link do śledzenia:** numer nadania paczki Wysyłam z Allegro jest linkiem do strony śledzenia Allegro (`allegro.pl/allegrodelivery/sledzenie-paczki`, nowa karta) na liście przesyłek (menu → „Przesyłki”), na liście zamówień i na karcie zamówienia w sekcji „Przesyłka”; ten sam link dostaje klient w mailu „Faktura”, gdy zamówienie ma jedną paczkę.

## Czego Kompletor nie robi w Allegro

- Nie zakłada aplikacji w Allegro i nie wypełnia Client ID za Ciebie (krok 1 połączenia robisz na stronie Allegro).
- Nie przełącza trybu konta przy połączeniu ani przy włączeniu zapisu: tryb to osobna sekcja **Stan konta**.
- Nie pokazuje tokenów ani kodu urządzenia: są tylko zaszyfrowane w bazie.
- Nie używa logowania z przekierowaniem na adres panelu (authorization code): device flow działa także, gdy panel nie ma publicznego adresu.
- Nie zmienia cen, opisów, zdjęć i nie wystawia nowych ofert.
- Nie zamawia kuriera po paczki. Protokołu odbioru z Allegro jeszcze nie pobiera: lista przesyłek (menu → „Przesyłki”) drukuje własną listę przekazanych paczek z miejscem na podpis kuriera ([Przesyłki](../przesylki.md)).
- Nie anuluje paczki, którą kurier już odebrał: wtedy tylko w Allegro.
- Nie zmienia statusu zamówienia w Kompletorze po anulowaniu przesyłki. Numer nadania, który już zdążył pójść do Allegro, zostaje tam do czasu nowej przesyłki (jej numer go zastępuje); numer jeszcze niewysłany do Allegro Kompletor wstrzymuje.
- Gdy Allegro długo tworzy przesyłkę (ponad 30 s), przycisk wraca z komunikatem „Allegro jeszcze tworzy przesyłkę”; przesyłka ma wtedy od razu stan „Do sprawdzenia u przewoźnika” i wynik pobiera przycisk „Sprawdź u przewoźnika”. Dopiero przesyłka, która utknęła w tworzeniu po awarii serwera, czeka na ten przycisk ok. 13,5 minuty (najgorszy czas żywego wywołania Wysyłam z Allegro z minutą zapasu; wcześniej mogłoby się z nim ścigać).
- Nie wysyła niczego, gdy konto jest w trybie „Tylko podgląd”, ma wyłączony zapis albo nie ma zgody na daną funkcję.

## Do potwierdzenia na koncie sandbox

- Rodzaj aplikacji w Allegro dla device flow (krok 1 połączenia).
- Treść odpowiedzi Allegro przy zakończeniu i wznowieniu oferty (komenda publikacji END / ACTIVATE): sprawdzone na atrapie według dokumentacji Allegro, nie na koncie.
- Odpowiedź Allegro na powtórne wysłanie tej samej komendy stanów (Kompletor przyjmuje „komenda istnieje”, a przy innej odmowie sprawdza, czy Allegro zna komendę, i czyta jej wynik).
- Jak długo Allegro pamięta komendy utworzenia przesyłki (Kompletor przy każdym tworzeniu czyta wszystkie pięć prób tej samej przesyłki, więc zapomniana stara próba nie prowadzi do drugiej płatnej etykiety).
- Wymiary gabarytów Allegro A/B/C i limit wagi (dziś wartości robocze jak paczkomat, z ostrzeżeniem do potwierdzenia).
- Lista kodów przewoźników Allegro dla numerów nadania (InPost, DPD; inny przewoźnik idzie jako „inny” z nazwą, własne kody w ustawieniu `kodyPrzewoznikow` konta).
