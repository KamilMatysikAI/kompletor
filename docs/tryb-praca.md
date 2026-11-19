# Prowadzenie zamówienia z karty

Na koncie „Aktywny” zamówienie prowadzi Kompletor. Biuro przeprowadza je przez kolejne etapy przyciskami na karcie
zamówienia: opłacenie, zbieranie, spakowanie, wydanie, wysyłka i odbiór.

W ustawieniach serwera „Aktywny” to tryb PRACA, a „Tylko podgląd” to tryb CIEN. Przyciski
zmieniają status w Kompletorze; do sklepu status idzie tylko z kontem, które ma włączony zapis.

## Gdzie to jest

| Ekran | Droga z menu | Adres | Kto widzi |
| --- | --- | --- | --- |
| Przyciski „Co dalej” | **Zamówienia** → kliknij zamówienie → nagłówek karty (przyciski główne) i menu **Więcej** (reszta) | `/zamowienia/<id>` | uprawnienie `zamowienia.przejscia` (z roli: właściciel, biuro, magazyn) |

Od karty docelowej przyciski „Co dalej” stoją w nagłówku karty: najczęstsze (najwyżej trzy) obok kwoty,
pozostałe w menu „Więcej”. Lista jest ta sama co wcześniej. Pozostałe akcje karty (pozycje, płatność, notatki,
historia) opisuje [Karta zamówienia](karta-zamowienia.md).

Sekcja pojawia się wtedy, gdy konto kanału, z którego przyszło zamówienie, jest w trybie PRACA („Aktywny”, nie
„Tylko podgląd”). Firma bez BaseLinkera nie potrzebuje nic więcej: przełącza konta z panelu. Firma,
która przechodzi z BaseLinkera, potrzebuje dodatkowo instancji z `EKRANY_PRACA=1` (domyślnie wyłączone): to twarda
blokada administratora serwera, żeby dwa systemy nie prowadziły tych samych zamówień. Gdy blokada działa, panel mówi to
wprost przy przycisku „Włącz tryb pracy”.

„Przechodzi z BaseLinkera” liczy się ze śladu przejścia, nie z samego klucza: katalog BaseLinkera w ustawieniach firmy
(podgląd obok BL, porównania z BL, preset firmy), zapis przeprowadzki z BL (także zakończony ze sprawami do decyzji) albo token BL
w pliku konfiguracji serwera (self-host).

**Po przeprowadzce firma sama odchodzi od BaseLinkera**: **Ustawienia** → **Przejście z BaseLinkera** → **Przeprowadzka**
→ sekcja **5. Koniec przejścia** → **Przejście z BaseLinkera zakończone** (adres `/ustawienia/przeprowadzka#koniec`,
uprawnienia „Ustawienia firmy” i „Zmiana trybu kanału”). Od tej chwili firma liczy się jak firma bez BaseLinkera i
włącza tryb pracy kont z panelu bez `EKRANY_PRACA=1`. Samo oznaczenie niczego nie przełącza i wyłącza import z
BaseLinkera (tryb próbny działa dalej); cofnięcie tym samym ekranem, gdy żadne konto nie pracuje. Oznaczenia nie da się
ustawić bez zapisu przeprowadzki, w trakcie przebiegu, przy tokenie BL w konfiguracji serwera i przy pobieraniu katalogu
z BL co kilka godzin (`KATALOG_IMPORT_CO_GODZIN`). Firma z katalogiem BL z presetu albo z podglądu obok BL (np. pierwsza firma)
zostaje za wyłącznikiem `EKRANY_PRACA` w każdej kolejności: bez przeprowadzki, po pełnej przeprowadzce z panelu (zapis
pamięta, że katalog był ustawiony przed nim: `baselinker.przeprowadzka.katalogPrzed`) i po podmianie katalogu po
oznaczeniu (liczy się tylko katalog zapisany przez przeprowadzkę, `katalogZapisu`). Ręcznie wpisane oznaczenie tego
nie zmienia. Przebieg „w toku” starszy niż godzina (przerwany w połowie) nie blokuje oznaczenia.
Zapisany wybór katalogu, którego BaseLinker już nie zna (inne konto po zmianie klucza, katalog usunięty), tryb próbny
pomija z uwagą przy raporcie i bierze katalog domyślny; „Usuń klucz BaseLinkera” czyści wybór. Treść raportów do
pobrania zostaje w 5 ostatnich przebiegach oraz w ostatniej próbie i ostatnim imporcie.
Klucz API BaseLinkera zapisany na ekranie **Przeprowadzka z BaseLinkera** tego nie zmienia: otwiera tylko przeprowadzkę
i menu „Przejście z BaseLinkera”. Firma, której konta są już w trybie pracy, klucza BL nie zapisze (przeprowadzka i
tak przyjmuje tylko konta w podglądzie); ekran mówi, co zrobić. Klucz usuwa „Usuń klucz BaseLinkera” na tym samym ekranie.

Konto „Tylko podgląd” nie ma tych przycisków (karta pisze „Konto w trybie testowym: zamówienie prowadzi BaseLinker”), a
próba wywołania akcji z pominięciem ekranu kończy się odmową. W menu nie ma osobnej pozycji.

## Co pokazuje karta

Przyciski zależą od statusu, przewoźnika i uprawnień osoby:

| Status | Przyciski |
| --- | --- |
| Nowe | „Oznacz jako opłacone” (osobne uprawnienie), „Anuluj zamówienie” |
| Do realizacji | „Zacznij zbieranie”, „Spakuj”, „Anuluj zamówienie” |
| Zbieranie | „Zebrane”, „Spakuj”, „Przerwij zbieranie” |
| Zebrane | „Spakuj” |
| Spakowane | „Do wysyłki” albo „Do odbioru” (odbiór osobisty), „Wyślij bez faktury”; dla zamówienia bez paczki „Odebrane”; „Anuluj zamówienie” |
| Do wysłania | „Wysłane” z opcjonalnym numerem nadania, „Anuluj zamówienie” |
| Do odbioru, Wysłane | „Odebrane” |
| Do wyjaśnienia | „Wyjaśnione” |
| Anulowane (towar wydany z magazynu prowadzonego przez Kompletor) | „Przyjmij zwrot na stan” |

Przycisk, którego teraz nie da się użyć, jest wyszarzony, a pod nim stoi powód jednym zdaniem, np. „Najpierw faktura”.
Anulowanie i „Wyślij bez faktury” pytają o potwierdzenie. Anulowanie zamówienia, które ma już fakturę, wymaga
osobnego uprawnienia „Anulowanie zamówienia po wystawieniu faktury”.

Uprawnienie „Karta zamówienia w trybie PRACA” mają domyślnie Biuro i Magazyn, więc magazynier może też anulować
zamówienie przed fakturą i kliknąć „Wyjaśnione”. Komu to zabrać, ustawia się w **Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia**; osobne
uprawnienia do anulowania i „Wyjaśnione” to plan karty docelowej.

„Wysłane” nie trzeba klikać przy każdym zamówieniu: przycisk „Przyjechał kurier” w kolejce pakowania przenosi do
„Wysłane” wszystkie spakowane zamówienia tego przewoźnika z numerem nadania, tą samą drogą co przycisk na karcie (te
same warunki, mail i zapis do sklepu). Opis i przełącznik: [Pakowanie](pakowanie.md), sekcja „Przyjechał kurier”.
Nieopłacone po terminie Kompletor anuluje u siebie i, przy włączonym zapisie, w sklepie (WooCommerce, Allegro); sklep
z włączonym zapisem, ale bez tej możliwości (np. Empik), daje powiadomienie „anuluj ręcznie”. Konto z wyłączonym
zapisem albo w podglądzie powiadomienia nie daje: tym sklepem rządzi jeszcze BaseLinker i to on anuluje zamówienie.

Pakowanie na stanowisku i decyzje o brakach towaru zostają tam, gdzie były: karta linkuje do stanowiska pakowania, a
braki rozstrzyga kolumna „Decyzja o braku” w pozycjach tej samej karty.

### Zamówienie bez paczki

Zamówienie z samą usługą (np. e-book) nie idzie przez zbieranie ani kuriera. To samo dotyczy zamówienia mieszanego, w
którym cały towar został odrzucony i została sama usługa, nawet jeśli kanał podał przewoźnika paczki. Kompletor sam
pakuje takie zamówienie, wystawia fakturę za usługę i kończy je statusem „Odebrane”. Karta pisze wtedy „Bez paczki”.
Gdy brakujący towar ma jeszcze przyjść (otwarty brak albo „dośle później”), automat czeka. Przy stanie z wFirmy
automat pakuje i fakturuje tylko wtedy, gdy instancja ma podłączony zapis do wFirmy; bez niego takie zamówienie czeka
w „Do realizacji” na „Spakuj” z karty, a faktury nie ma.

Przy stanie prowadzonym przez Kompletor (firma bez wFirmy albo z wFirmą tylko do dokumentów) automat chodzi co kilka
minut niezależnie od wFirmy: pakuje takie zamówienie i kończy je statusem „Odebrane” od razu, gdy Kompletor nie wystawia
dokumentów (bez programu do faktur, KSeF, wFirma z wyłączonym „Wystawiaj faktury z Kompletora”). Fakturę, jeśli klient
jej chce, wystawiasz jak dotąd poza Kompletorem. Przy wFirmie z włączonym wystawianiem „Odebrane” przychodzi dopiero po
wystawionej fakturze. Zamówienia spakowane, zanim włączono wystawianie, Kompletor już nie fakturuje (karta pisze „Bez faktury z
Kompletora: spakowane przed włączeniem wystawiania”), więc automat ich nie zamknie: zostają w „Spakowane” i „Odebrane” klikasz na karcie
zamówienia. Przy „Dokument przed wysyłką” automat nie zamyka takich zamówień. Działa tylko dla sklepów w
trybie pracy.

### „Wyjaśnione” z wyborem przewoźnika

Gdy zamówienie bez wysyłki dostało w kanale towar (klient dopisał produkt), po „Wyjaśnione” wychodzi już jak paczka.
Karta pokazuje wtedy listę przewoźników z reguł firmy i bez wyboru przewoźnika nie przepuści zamówienia dalej. Tak
samo zamówienie z towarem i nieznaną metodą dostawy (przewoźnik „brak”): bez wyboru nie wyjdzie z „Do wyjaśnienia”.

## Jak włączyć

1. Tylko firma z BaseLinkerem: na instancji ustaw `EKRANY_PRACA=1` i uruchom panel ponownie (albo, po przeprowadzce,
   „Przejście z BaseLinkera zakończone” na ekranie przeprowadzki, opis wyżej). Puste albo `0` zostawia
   firmy z BaseLinkerem w trybie podglądu, inna wartość to błąd (wtedy trybu pracy nie ma dla nikogo).
2. Wszystkie konta naraz: **Pulpit** → karta **Stan kanałów** → **Włącz tryb pracy** (uprawnienie „Zmiana trybu kanału”;
   bez niego przycisk jest widoczny, ale nieaktywny z powodem). Każde konto przechodzi przez te same warunki co
   pojedynczo; konto, które ich nie spełnia, zostaje w podglądzie, a powód pokazuje komunikat.
3. Albo jedno konto: **Ustawienia** → **Sprzedaż i kanały** → **Kanały sprzedaży** → kliknij konto → sekcja **Stan konta** →
   **Włącz tryb pracy** (adres `/ustawienia/kanaly/<kod konta>#stan`, uprawnienia „Ustawienia” i „Zmiana trybu kanału”;
   bez drugiego przycisk jest widoczny, ale nieaktywny z powodem). Przycisk pyta o
   potwierdzenie i jest nieaktywny z powodem, dopóki konto nie spełnia warunków: konto włączone, połączenie sprawdzone,
   przy włączonym zapisie do sklepu uzupełniona mapa statusów. Ostrzega (bez blokady), gdy konto nie ma przypisanych
   ofert, zapis do sklepu jest wyłączony albo firma ma podłączony BaseLinker. Firma z BaseLinkerem przełączy konto tylko
   na instancji z `EKRANY_PRACA=1`. Zmiana trafia do historii zmian (kto, kiedy). **Wróć do trybu „Tylko podgląd”**
   działa zawsze.
4. **Tryb pracy bez stanów** (ten sam ekran, przycisk **Włącz tryb pracy bez stanów**, odznaka „Aktywny bez stanów”):
   karta, pakowanie, przesyłki, faktury, statusy i numery nadania działają jak w trybie pracy, a stanów ofert Kompletor
   do sklepu nie wysyła (wysyła je dotychczasowy system, np. BaseLinker). Te same warunki co „Włącz tryb pracy”.
   **Dołącz stany ofert** przełącza konto na pełny tryb pracy (najpierw wyłącz stany w dotychczasowym systemie),
   **Wyłącz tylko stany ofert** wraca z pełnego trybu do pracy bez stanów (bez warunków). „Włącz tryb pracy” na Pulpicie
   konta pracującego bez stanów nie zmienia.

Do tej chwili nic się nie zmienia: konta „Tylko podgląd” prowadzi BaseLinker.

## Czego nie robi

- Sam tryb nie zapisuje niczego w kanale sprzedaży. Status i numer nadania trafiają do sklepu dopiero, gdy konto ma
  wersję z zapisem i włączony zapis (dziś WooCommerce; Shoper i PrestaShop mają zapis napisany, sprawdzony tylko na symulowanym sklepie, statusy dopiero po uzupełnieniu tabeli „Statusy w sklepie”): [Zapis do sklepu WooCommerce](integracje/woocommerce.md).
  Allegro i Empik: tak samo, wersja z zapisem za wyłącznikiem ([Allegro](integracje/allegro.md), [Empik](integracje/empik.md)).
- Nie wystawia prawdziwych faktur: faktury wystawia kolejka wFirmy, a bez podłączonego zapisu do wFirmy nic nie
  wychodzi. Firma bez wFirmy i bez programu do faktur wysyła i zamyka zamówienia bez faktury, a towar schodzi ze stanu
  przy „Do wysyłki” ([Stan magazynu i dokumenty sprzedaży](dokumenty-sprzedazy.md)).
- Nie tworzy przesyłek ani etykiet: numer nadania przy „Wysłane” trafia do historii zamówienia, a do sklepu tylko
  przy włączonym zapisie numerów nadania (jak wyżej). Podgląd
  przesyłki na karcie pokazuje „Podgląd nieaktualny”, gdy zamówienie zmieniło się po jego policzeniu.
- Nie wysyła maili ani powiadomień do klienta.
- Nie pokazuje danych klienta: zmiana statusu ich nie potrzebuje.
- Zmiana pozycji, dopłata i podział z karty też są tylko w Kompletorze: kanał ich nie dostaje.
