# Karta zamówienia: co biuro robi z karty

Karta zamówienia to jedna strona, na której biuro prowadzi zamówienie od przyjęcia do odbioru.
**Każda informacja jest w jednym miejscu**: status tylko w nagłówku, adres i kontakt tylko w „Wysyłka”, dane do
faktury tylko w „Dane do faktury”, kanał, numery i daty tylko w „Szczegóły zamówienia”, rozliczenie płatności tylko
w „Płatność”, przesyłka tylko w „Przesyłka”, faktura tylko w „Dokument sprzedaży”.

Układ od góry (pozycje przed danymi klienta):

1. **Nagłówek**: numer, status, klient, kwota brutto, strzałki do sąsiednich zamówień, przyciski „Co dalej”, menu
   **Wydruki** i menu **Więcej**.
2. **Stany trwałe** (banery): konto w trybie „Tylko podgląd”, „Do wyjaśnienia” z powodem, „Brakuje towaru”, „Bez
   paczki”, a po nieudanym zapisie „Nie zapisano.” z treścią błędu (zostaje do następnego wejścia na kartę).
3. **Pozycje** na całą szerokość, z decyzjami o brakach i podsumowaniem netto, VAT i brutto: najpierw widać, co jest
   w paczce.
4. **Trzy równe karty danych**: **Wysyłka** (odbiorca, adres, punkt odbioru, telefon, e-mail, uwagi klienta, sposób
   wysyłki, przewoźnik, koszt wysyłki), **Dane do faktury**, **Szczegóły zamówienia** (kanał i konto, numer w sklepie
   albo w BaseLinkerze, paczki, data złożenia i ostatniej zmiany, źródło, stan i sposób płatności, pobranie).
5. Obok siebie **Przesyłka** i **Płatność**, pod nimi **Dokument sprzedaży** oraz **Zwroty i reklamacje** (tylko gdy
   zamówienie je ma) i **Notatki wewnętrzne**.
6. Na dole zwinięta **Historia zmian**.

Na telefonie wszystko w jednej kolumnie w tej kolejności. Każda sekcja ma nagłówek w szarym pasku, a po prawej
stronie paska jej przyciski i link **Edytuj**.

### Odczyt i „Edytuj”

Sekcje otwierają się w odczycie: wartości są tekstem, bez pól formularza. Zmieniasz je tak:

1. Kliknij **Edytuj** w pasku nagłówka sekcji (pozycje; dane klienta w zamówieniu ręcznym). Sekcja dostaje zieloną
   ramkę i pola, a link zmienia się na **Zakończ edycję**.
2. Zmień wartości. Po pierwszej zmianie pod sekcją pojawia się pasek z przyciskiem zapisu („Zapisz pozycje”, „Zapisz
   dane klienta”); przykleja się do dołu ekranu.
3. **Zapisz** wraca do odczytu z nowymi wartościami. **Anuluj** na pasku i **Zakończ edycję** wracają do odczytu bez
   zapisu; po **Anuluj** kursor wraca na nagłówek sekcji, a ekran przewija się do niej.

Decyzja o braku towaru jest wyjątkiem: lista decyzji stoi przy brakującej pozycji od razu, bez „Edytuj” (to codzienna
akcja magazynu), a po wyborze pojawia się „Zapisz decyzje”. Gdy edycja jest niedostępna (konto w trybie „Tylko
podgląd”, zamówienie już zbierane, anulowane), „Edytuj” jest szare, a powód stoi raz pod tabelą (po najechaniu na
„Edytuj” też go widać). Tryb edycji siedzi w adresie
strony (`?edytuj=pozycje`, `?edytuj=klient`), więc działa także bez JavaScriptu.

Wynik każdej akcji (zapisano, błąd) pokazuje się jako komunikat w rogu ekranu, który sam znika (błąd na górze,
dłużej; błąd zostaje też banerem nad sekcjami). W adresie strony po akcji jest tylko kod komunikatu, nigdy jego treść, więc podesłany link nie pokaże fałszywego „zapisano”.

## Gdzie to jest

**Zamówienia** → kliknij zamówienie. Adres: `/zamowienia/<id>`. Kartę widzi każdy, kto ma podgląd panelu. Przyciski
zależą od uprawnień osoby (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia) i od trybu konta kanału.

Przyciski zmieniające zamówienie działają tylko wtedy, gdy:

1. konto kanału, z którego przyszło zamówienie, jest w trybie PRACA,
2. firma z BaseLinkerem: instancja ma dodatkowo `EKRANY_PRACA=1` (firma bez BaseLinkera tego nie potrzebuje).

Konto w trybie „Tylko podgląd” (zamówienie prowadzi dotychczasowy system, np. BaseLinker) widzi status, pozycje,
klienta, podglądy i historię oraz baner „Konto sklepu w trybie »Tylko podgląd«…” ze wskazaniem, gdzie konto się
włącza (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży). Przyciski zmian są widoczne, ale nieaktywne, z jednym zdaniem powodu pod
grupą: przyciski statusu w nagłówku i w menu „Więcej” (z „Zmień status…”), „Oznacz jako opłacone”,
„Zapisz dopłatę” i „Zwrot różnicy” w sekcji „Płatność”, „Dodaj pozycję” i „Podziel zamówienie” pod pozycjami, „Zmień sposób wysyłki” i „Popraw adres albo punkt odbioru” w sekcji „Przesyłka”, „Edytuj kupującego” w karcie „Wysyłka” i „Edytuj” w karcie „Dane do faktury”. Dzięki
temu widać, co Kompletor potrafi, zanim konto przejdzie na pracę. Osoba bez uprawnienia widzi przy płatnościach powód
o uprawnieniu. Notatki wewnętrzne i decyzje o brakach (zapisuje się sama decyzja) działają zawsze, bo nie zmieniają
zamówienia.

## Nagłówek i menu „Więcej”

- **Numer**: numer zamówienia widoczny w kanale (np. numer Woo z wtyczki numeracji), a gdy kanał takiego nie ma
  (Allegro) i zamówienie przyszło z BaseLinkera, numer z BL. Numer, którego nie ma w tytule (pełny numer w sklepie
  z linkiem do panelu kanału albo numer w BaseLinkerze), jest w drugiej linii pod tytułem; numer z tytułu się nie
  powtarza. Gdy numer w tytule jest tym samym numerem co w sklepie, a kanał ma link do zamówienia, linkiem jest numer
  w tytule. Przy statusie w tytule nie ma przewoźnika: przewoźnik jest raz, w karcie „Wysyłka”. Numer, którego nie ma
  w tytule, jest w karcie „Szczegóły zamówienia”.
- **Kanał, daty**: konto kanału (i rodzaj kanału, gdy nazwa konta jest inna), źródło, data złożenia i ostatniej zmiany
  są w karcie „Szczegóły zamówienia”.
- **Klient obok numeru**: imię i nazwisko (uprawnienie „Dane klienta: pełny podgląd…”) albo skrót „Jan T., Poznań”
  („Dane klienta: imię, pierwsza litera nazwiska i miasto”). Bez uprawnień nic.
- **Strzałki ← →**: poprzednie (nowsze) i następne (starsze) zamówienie w kolejności listy zamówień. Strzałki nie
  pamiętają filtrów listy: idą po wszystkich zamówieniach firmy.

| Na ekranie | Co robi | Uprawnienie |
| --- | --- | --- |
| Przyciski główne (np. „Zacznij zbieranie”, „Spakuj”, „Wysłane”) | zmiana statusu, opis w [Tryb PRACA](tryb-praca.md) | „Karta zamówienia w trybie PRACA” |
| Więcej → pozostałe przyciski statusu („Anuluj zamówienie”, „Przerwij zbieranie”, „Wyślij bez faktury”) | jak wyżej, z potwierdzeniem | jak wyżej |
| „Przyjmij zwrot na stan” (anulowane zamówienie, którego towar zszedł już ze stanu prowadzonego przez Kompletor) | cała wydana ilość wraca na stan i do sprzedaży, zamówienie schodzi z listy „do korekty” ([Dokumenty sprzedaży](dokumenty-sprzedazy.md#zwrot-towaru-przy-stanie-prowadzonym-przez-kompletor)) | „Karta zamówienia w trybie PRACA” |
| Więcej → Kopiuj adres dostawy, Kopiuj e-mail, Kopiuj telefon | dane klienta do schowka; każde kopiowanie trafia do dziennika podglądów | „Dane klienta: pełny podgląd…” |
| Więcej → Kopiuj numer zamówienia | numer do schowka | podgląd panelu |
| Więcej → Otwórz w kanale | panel zamówienia w sklepie, na Allegro albo w Empiku (nowa karta przeglądarki) | podgląd panelu |
| Wydruki → Drukuj kartę, Pobierz PDF karty | karta zbierania na stanowisku druku albo jako PDF; zamówienie wysłane, anulowane albo bez towaru do zebrania dostaje wydruk informacyjny bez kodu (szczegóły: [Lista zamówień](lista-zamowien.md), „Karty zamówień z listy”) | „Stanowisko pakowania” |
| Faktura → PDF faktury | plik faktury z wFirmy (nowa karta przeglądarki), po wystawieniu | „Faktura na karcie zamówienia” i „Dane klienta: pełny podgląd…” |
| Faktura → Ponów fakturę | po błędzie faktury: nowa próba w najbliższym przebiegu kolejki, bez drugiej faktury | „Faktura na karcie zamówienia” |
| Więcej → Podziel zamówienie | przejście do formularza podziału pod pozycjami | „Karta zamówienia: podział zamówienia na paczki” |
| Więcej → Stwórz zwrot, Zgłoś reklamację, Zwroty tego zamówienia | formularz zwrotu z pozycjami tego zamówienia ([Zwroty i reklamacje](zwroty-i-reklamacje.md)); lista zwrotów zamówienia | „Zwroty i reklamacje: zgłoszenie” (lista: podgląd panelu) |
| Więcej → Zmień status… | wybór dowolnego dozwolonego statusu z listy i powód (rozwija się w menu), opis niżej | „Zmiana statusu na dowolny dozwolony” |

Menu „Więcej” zamyka się kliknięciem obok, klawiszem Esc albo po wybraniu pozycji. Przycisk, którego teraz nie da się
użyć, jest widoczny i nieaktywny, a pod nim stoi powód (np. „Firma nie ma reguł przewoźników”). „Anuluj zamówienie”
i „Wyślij bez faktury” pytają w oknie, zanim cokolwiek się zmieni.

„Otwórz w kanale” pojawia się tylko, gdy znamy adres panelu: sklep WooCommerce i Shoper z adresu sklepu w koncie,
PrestaShop z adresu panelu (`adminUrl` w ustawieniach konta), Allegro i Empik zawsze.

## Zmień status (ratowanie pomyłek)

**Zamówienia** → zamówienie → **Więcej** → **Zmień status…**: lista statusów, na które wolno przejść z obecnego, i
pole „Powód”. Powód jest obowiązkowy (3–300 znaków) i zostaje w historii zamówienia razem z poprzednim i nowym
statusem oraz osobą („Zmiana statusu ręcznie: Wysłane → Do wysłania, powód: …”). Opcja jest tylko na koncie w trybie
PRACA i tylko dla osoby z uprawnieniem „Zmiana statusu na dowolny dozwolony” (właściciel ma je domyślnie, biuru nadaje
się je w Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).

Na liście są dwa rodzaje statusów:

- **zwykłe przejścia**, te same co przyciski (zbieranie, zebrane, do wysyłki albo do odbioru, wysłane, odebrane,
  reklamacja, anulowanie, do wyjaśnienia), z tymi samymi warunkami: np. „Do wysyłki” dopiero po fakturze albo „Wyślij
  bez faktury”, anulowanie po fakturze tylko z osobnym uprawnieniem;
- **cofnięcie pomyłki** (oznaczone na liście), które nie rusza towaru ani faktury: „Wysłane” → „Do wysłania”,
  „Odebrane” → „Wysłane” albo „Do odbioru”, „Do wysłania” / „Do odbioru” → „Spakowane”, „Zebrane” → „Do realizacji”
  (jak przerwane zbieranie), „Reklamacja” → „Wysłane” albo „Odebrane”.

Statusy, które wymagają własnego przycisku, są pod formularzem z powodem: spakowanie („Spakuj” albo stanowisko
pakowania, bo zamyka braki), opłacenie („Oznacz jako opłacone”) i wyjście z „Do wyjaśnienia” („Wyjaśnione”).
Zmiana statusu działa tylko w Kompletorze: nic nie idzie do kanału sprzedaży, wFirmy ani kuriera.

## Dodaj zamówienie (zamówienie ręczne)

**Zamówienia** → przycisk **Dodaj zamówienie** (prawy górny róg listy). Adres: `/zamowienia/nowe`. Przycisk widzi
osoba z uprawnieniem „Dodawanie zamówień ręcznych” (właściciel i biuro domyślnie). Służy do zamówień telefonicznych,
osobistych i hurtowych oraz do pierwszego zamówienia testowego bez sklepu.

1. **Produkty**: wpisz część SKU, nazwy albo EAN i kliknij „Szukaj”. Lista pokazuje, ile sztuk jest dostępnych
   (na stanie minus zarezerwowane) i cenę z katalogu. „Dodaj” wstawia produkt do zamówienia; ilość i cenę brutto
   możesz zmienić. Gdy zamawiasz więcej, niż jest, formularz mówi, ile zabraknie: ta część trafi do „Brakuje”.
2. **Klient** (opcjonalnie, dla osoby z uprawnieniem do danych klienta): „Szukaj klienta” znajduje klienta
   z wcześniejszych zamówień po fragmencie nazwy, firmy, e-maila, telefonu albo NIP-u (polskie znaki bez znaczenia),
   „Wybierz” wpisuje jego dane. Albo wpisz nowego: imię i nazwisko albo firma, kontakt, adres, dane do faktury.
   Dane zapisują się zaszyfrowane jak przy zamówieniach ze sklepu ([Dane klienta](dane-klienta.md)).
3. **Dostawa i płatność**: sposób dostawy z reguł przewoźników firmy (ustawia je instalacja albo przeprowadzka z BaseLinkera; ekranu edycji w panelu jeszcze nie ma), dla paczkomatu kod
   punktu, koszt wysyłki, źródło (np. „Telefon”, „Hurt”); płatność: **opłacone** (od razu do realizacji),
   **za pobraniem** (do realizacji, klient płaci kurierowi) albo **przelew do zapłaty** (towar zarezerwowany, czeka
   na wpłatę jak nieopłacone zamówienie ze sklepu, z przypomnieniem i terminem zwolnienia).
4. **Dodaj zamówienie**: zamówienie od razu rezerwuje towar i otwiera się jego karta. Dalej idzie zwykłą ścieżką:
   przyciski „Co dalej”, zbieranie, pakowanie, wysyłka. Podwójne kliknięcie nie tworzy drugiego zamówienia.

Zamówienia ręczne trafiają na konto kanału „Zamówienia ręczne” (zakładane samo przy pierwszym zamówieniu, w trybie
PRACA). Na liście zamówień mają przedrostek kanału ręcznego, a w nagłówku karty źródło. To samo zamówienie można
dodać z innego systemu przez API (`POST /api/v1/zamowienia` z polem `kanal`, opis w dokumentacji API repozytorium, `docs/api.md`).

Formularz nie robi: wyszukiwania firmy w GUS po NIP-ie (dane wpisujesz sam albo bierzesz z wcześniejszego
zamówienia), rabatów na całe zamówienie (cenę zmieniasz w pozycji), zamówień na produkty spoza katalogu (najpierw
Produkty → Dodaj produkt), wysyłki potwierdzenia do klienta.

## Pozycje

Tabela jak w BL, jeden zwarty wiersz na pozycję: miniatura 40 px, na telefonie 32 px (główne zdjęcie produktu, bez zdjęcia
inicjały nazwy), nazwa (z katalogu, a gdy pozycja nie jest powiązana z produktem, nazwa z kanału), a pod nią jedna szara
linia: SKU · EAN · **półka** (np. „półka B-3-4”) · numer oferty w kanale z linkiem do oferty (Allegro, sklep
WooCommerce, PrestaShop). „w kanale: …” pojawia się tylko wtedy, gdy kanał nazywa produkt inaczej (sama gramatura na
końcu albo inna wielkość liter się nie liczy). W kolumnie ilości **stan produktu** („półka 12 / dost. 9”, suma
magazynów, dostępne = na półce minus rezerwacje; pełny opis po najechaniu), dalej cena brutto za sztukę, VAT (z kanału
albo „z katalogu”) i stan pozycji (zarezerwowane, brakuje, dośle później, zgłoszone na stanowisku). Kolumny z liczbami
są wąskie i bez zawijania, nazwa produktu bierze resztę szerokości. Odznaki pod nazwą tylko, gdy jest co powiedzieć:
pozycja dodana w Kompletorze (z datą), bez powiązania z produktem, usunięta, e-book albo usługa. Na telefonie pozycje
są kartami.

Zdjęcia produktów pobiera Kompletor z ofert sklepu (adresy z ostatniego **„Pobierz oferty”** w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży,
tylko odczyt sklepu): produkt bez żadnego zdjęcia, powiązany z ofertą, dostaje zdjęcia przy każdym pobraniu
ofert tego konta, najwyżej 200 produktów na jedno pobranie (reszta przy następnym; liczba w wierszu
„Zdjęcia produktów do pobrania” w Ustawieniach konta). Produkt, który ma choć jedno zdjęcie, zostaje bez zmian.

Pod tabelą jest podsumowanie: **Razem netto**, **VAT** i **Razem brutto** pozycji (bez wysyłki i opłat z kanału).
Netto liczy się z sumy brutto każdej stawki, tak jak na dokumencie sprzedaży (zw. i np. bez VAT), więc kwoty zgadzają
się z fakturą co do grosza. Gdy któraś pozycja nie ma jednej stawki (np. zestaw ze składnikami w różnych stawkach), karta pokazuje samo brutto i pisze, że netto i VAT policzy dokument sprzedaży.

### Edycja pozycji („Edytuj”), jeden zapis

Na koncie w trybie PRACA, przed zbieraniem, kliknij **Edytuj** w pasku nagłówka „Pozycje”: ilość każdej pozycji staje
się polem w tabeli, a pod nim jest pole „usuń”. Zmieniasz
ilości, zaznaczasz pozycje do usunięcia i klikasz **Zapisz pozycje** na pasku pod tabelą (pasek pojawia się dopiero po pierwszej zmianie i przykleja się do dołu
ekranu, „Anuluj” przywraca wartości, przeglądarka pyta przed zamknięciem karty z niezapisanymi zmianami). Każda zmiana
zapisuje się osobno: gdy jednej nie da się zapisać (np. ilość 0), reszta i tak się zapisuje, a komunikat mówi, co
odrzucono i nazywa pozycję tak jak w tabeli („Zapisano 1 zmianę, nie zapisano: SKU D-007: …”).

- Więcej sztuk = rezerwacja od razu (czego nie ma na stanie, to „brakuje”), mniej = najpierw zamyka brak, potem
  zwalnia rezerwację.
- „usuń”: rezerwacja wraca na stan. Gdy zaznaczysz „usuń”, „Zapisz pozycje” najpierw otwiera okno z listą usuwanych
  pozycji („Tak, usuń pozycję” albo „Anuluj”, po którym zaznaczenie zostaje do poprawy). Usuniętej pozycji nie da się
  przywrócić: dodajesz ją od nowa przez „Dodaj pozycję”. Ostatniej pozycji nie da się usunąć: wtedy „Anuluj zamówienie”.

Uprawnienie: „Karta zamówienia: dodawanie, usuwanie i zmiana ilości pozycji” (domyślnie Właściciel i Biuro).

### Cena i VAT pozycji

Osoba z uprawnieniem **„Karta zamówienia: zmiana ceny i stawki VAT pozycji”** (domyślnie tylko Właściciel; Biuru
nadajesz je w Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia) widzi w tabeli cenę brutto jako pole (np. „24,90”) i listę stawek VAT (23%,
8%, 5%, 0%, zw., np.). Zmiana zapisuje się tym samym „Zapisz pozycje” co ilości (wzór: BL „Operacje na produktach”).
Puste pole ceny znaczy „bez zmiany”.

- **Za co jest cena**: podpis pod polem mówi, za co płaci klient: „za sztukę”, „za opakowanie 100 g” (oferta sklepu
  sprzedaje opakowanie produktu na wagę) albo „za 1 g” z dopiskiem „cena za gram, nie za opakowanie” (produkt na wagę
  bez oferty, np. w zamówieniu ręcznym: ilość jest w gramach, więc cena też). Wpisanie przy takiej pozycji ceny
  opakowania (np. 24,90 zł za 100 g) mnoży kwotę zamówienia sto razy.
- **Stawka z kanału**: Allegro i Shoper podają stawkę jako „23.00”. Karta pokazuje ją jako 23% z listy i nie zapisuje jej
  jako zmiany, dopóki nie wybierzesz innej stawki; stawka spoza listy ma na liście osobną pozycję „(z kanału)”.
- **Dwie osoby na jednej karcie**: zapis liczy zmianę względem tego, co widziałeś na karcie. Gdy ktoś w międzyczasie
  zmienił cenę, VAT albo ilość tej pozycji, a Ty też ją zmieniasz, zapis tej pozycji jest odrzucany z komunikatem
  „Ktoś zmienił tę pozycję w międzyczasie: odśwież kartę i wpisz zmianę ponownie”. Pozycja, której nie ruszałeś, zostaje
  z cudzą zmianą.

- **Kwota zamówienia** zmienia się o różnicę ceny razy ilość (np. 3 szt. z 10,00 na 12,50 zł = +7,50 zł). Przy
  zamówieniu już opłaconym sekcja „Płatność” pokaże dopłatę albo zwrot różnicy (podstawą jest kwota zapłacona sprzed
  pierwszej zmiany z karty).
- **Historia** zamówienia ma wpis „Zmiana ceny albo VAT w Kompletorze: cena 10,00 → 12,50 zł, VAT 23 → 8” z osobą,
  a dziennik zmian zapisuje cenę, stawkę i kwotę zamówienia przed i po.
- **Dokument sprzedaży** (faktura albo paragon z programu do faktur), który powstanie później, bierze nową cenę i stawkę
  z pozycji. Po wystawieniu albo w trakcie wystawiania dokumentu ceny już nie zmienisz: karta pokazuje cenę zwykłym
  tekstem, a zmianę robi się korektą w programie do faktur.
- **Zestaw**: zmienia się tylko cenę; stawki VAT zestawu na fakturze wynikają z jego składników.
- **Przesyłka u przewoźnika**: przy zamówieniu za pobraniem (albo przesyłce z kwotą pobrania) po utworzeniu przesyłki
  ceny nie zmienisz, bo etykieta ma kwotę pobrania z chwili utworzenia. Zamówienie opłacone z góry z przesyłką: cenę
  zmienisz. Ta sama reguła dotyczy ilości, dodania i usunięcia pozycji (opis niżej, „Kiedy pozycji nie zmienisz”).
- Ceny nie zmienisz, gdy część pozycji jest już dosłana albo zamieniona (zwrot za te sztuki liczył się po starej cenie),
  po rozpoczęciu zbierania, w drugiej paczce i na koncie w trybie „Tylko podgląd”.

**Kanał zostaje bez zmian, także po włączeniu zapisu na kanał.** Włączony zapis na kanał (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży
→ konto → sekcja „Zapis do sklepu”) wysyła do sklepu, Allegro i Empiku tylko stany magazynowe, statusy i numery
nadania. Pozycji, ilości ani cen zamówienia Kompletor do kanału nie wysyła, więc po zmianie ceny kwota w Kompletorze
różni się od kwoty w kanale. Rozliczenie z klientem (dopłata albo zwrot różnicy) prowadzisz w sekcji „Płatność”, a gdy
kanał sam zmieni zamówienie później, Kompletor nie nadpisuje zmiany z karty (zamówienie idzie do „Do wyjaśnienia”, opis
niżej). Zmiana ceny z kanału po edycji z karty nie nadpisuje ceny w Kompletorze; Kompletor porównuje z kanałem tylko
produkt i ilość, więc sama zmiana ceny w kanale nie wysyła zamówienia do „Do wyjaśnienia”.

### Decyzja o braku

Gdy czegoś brakuje (brak z przyjęcia, ze zmiany ilości albo zgłoszony na stanowisku), tabela ma kolumnę **Decyzja
o braku** przy brakujących pozycjach: „Wyślij resztę” (domyślnie), „Dośle później”, „Poczekaj na towar”, „Zamień
produkt”. Po wybraniu „Zamień produkt” otwiera się okno **Zamień produkt** z wyszukiwarką: wpisz co najmniej 2 znaki
SKU albo nazwy, albo pełny EAN, i kliknij „Szukaj” (albo Enter). Lista pokazuje nazwę, SKU, EAN i stan dostępny
(na półce minus rezerwacje); przycisk „Wybierz” mają tylko produkty, które nadają się na zamiennik, a przy reszcie
stoi powód: „to ten sam produkt”, „inna jednostka (sztuki i gramy)”, „za mało na stanie (potrzeba 2)”. Szukamy wśród
aktywnych produktów magazynowych (bez zestawów). Wybrany zamiennik widać w kolumnie („zamiennik: … SKU …”, przycisk
„Zmień zamiennik…”); zapisuje się dopiero przyciskiem pod tabelą, a „Anuluj” na pasku zapisu cofa wybór. Inny zamiennik
przy tej samej decyzji też jest zmianą. Decyzję wybierasz bez „Edytuj” i zapisujesz przyciskiem „Zapisz decyzje”;
w trybie edycji pozycji decyzje zapisuje ten sam przycisk co ilości („Zapisz pozycje”). Po spakowaniu zostaje tylko „Dośle później”. Na koncie w trybie „Tylko
podgląd” zapisuje się sama decyzja („na sucho” przy decyzji), zamówienie, rezerwacje i stan zostają bez zmian. Uprawnienie: „Braki: decyzje”.
Zwrot pieniędzy i korekta faktury za brak to zadania obsługi (lista Braki towaru → „Do zwrotu”).

„Dośle później”: reszta wychodzi od razu, brak idzie drugą paczką; na obu kartach widać „paczka 1 z 2” z linkiem do
drugiej. „Dośle później” działa dla zamówień opłaconych albo za pobraniem.

Pobranie przy kilku paczkach („Dośle później”, „Podziel zamówienie”): każda paczka pobiera swoją część. Paczka dodatkowa
pobiera wartość swoich pozycji, a pierwsza paczka resztę kwoty zamówienia razem z kosztem wysyłki; razem wychodzi kwota
zamówienia co do grosza. Anulowana paczka dodatkowa nie pobiera nic (jej pozycje zostają zdjęte z pierwszej paczki). Gdy kwoty
nie da się policzyć pewnie (rabat na całe zamówienie, zamieniony produkt, brak kosztu wysyłki z kanału, pozycje odrzucone
przy akceptacji), podgląd przesyłki pisze „Nieznana kwota pobrania” z powodem, a przesyłki za pobraniem nie da się nadać.
Zamówienia za pobraniem nie da się podzielić ani dosłać jego części, gdy któraś jego paczka ma już przesyłkę u przewoźnika: etykieta
ma kwotę sprzed podziału, więc najpierw „Anuluj przesyłkę”. Jeśli taka etykieta już istnieje, wszystkie paczki
zamówienia dostają „Nieznana kwota pobrania” z podpowiedzią, którą przesyłkę anulować.
„Anuluj przesyłkę” działa tylko u przewoźników, którzy anulują przesyłki z Kompletora (Base Courier, Wysyłam z Allegro,
Orlen Paczka, Poczta Polska). Przesyłki DPD, InPost ShipX i GLS nie da się anulować w Kompletorze (także po anulowaniu
w panelu przewoźnika zostaje w Kompletorze utworzona), więc przy pobraniu z gotową etykietą tych przewoźników podziału
ani „Dośle później” nie zrobisz, a komunikat mówi to wprost. Wtedy ręcznie: wyślij to, co jest („Wyślij resztę”), zmień
kwotę pobrania na tej przesyłce w panelu przewoźnika, a brakujący towar wyślij później osobnym zamówieniem
(Zamówienia → Dodaj zamówienie).

„Jednak jest na półce” (konto w trybie PRACA): brak zgłoszony na stanowisku („Nie ma w koszyku” → „Na półce nie było”)
albo „nie ma na półce” widać pod tabelą w ramce **Zgłoszone „nie ma na półce”** z produktem i ilością. Gdy towar się
znalazł, przycisk „Jednak jest na półce” (z potwierdzeniem) cofa brak: stan magazynu wraca, a towar wraca do tej paczki
(zestaw cały). Działa, dopóki zamówienie jest „Do realizacji”, „Zbieranie” albo „Zebrane” i dopóki ruch braku nie jest
oznaczony jako poprawiony w programie magazynowym (wtedy towar przyjmij dokumentem w tym programie). Gdy towar w
międzyczasie wziął przydział innego zamówienia albo brak był już przeniesiony („Dośle później”, zamiana), sztuki dostaje
najpierw przydział zamówień czekających na towar (np. druga paczka), a brak tej paczki zostaje do decyzji; karta to pisze.
Na koncie w trybie „Tylko podgląd” biuro braku nie cofa (cofa go pakujący na stanowisku). Uprawnienie: „Braki: decyzje”.

**Spakowaliśmy komplet mimo komunikatu o braku** („Wyszedł komplet”, konto w trybie PRACA): magazyn spakował całość mimo
ramki „Brakuje, nie pakuj”, bo towar leżał na półce, choć nie był jeszcze przyjęty na stan. Paczka zapisała się wtedy z
brakiem („do zwrotu pieniędzy” albo pomniejszone pobranie), a faktura stoi z błędem „Treść faktury różni się od
spakowanego towaru”. Zrób tak: (1) przyjmij towar w programie magazynowym i kliknij Produkty → „Synchronizuj stany”;
(2) na karcie zamówienia pod tabelą pozycji, w ramce **Spakowane z brakiem**, kliknij „Wyszedł komplet” przy pozycji (ten
sam przycisk jest na liście Braki towaru → „Do zwrotu”, prowadzi na kartę); (3) kliknij „Ponów fakturę”: wyjdzie na
całość. Brak zamyka się bez zwrotu pieniędzy, paczka obejmuje pełną ilość, a historia zamówienia zapisuje, kto i ile
potwierdził. System odmówi, gdy towaru nadal nie ma na stanie, gdy faktura tej paczki jest już wystawiona (wtedy
dofakturuj albo popraw ręcznie w programie do faktur), gdy faktura jest w toku, gdy zamówienie ma fakturę z BaseLinkera,
albo gdy paczka za pobraniem ma już etykietę z pomniejszoną kwotą (najpierw anuluj przesyłkę). Kontrola „faktura różna od
paczki” zostaje: faktura nie wyjdzie, dopóki paczka i zamówienie się nie zgadzają. Uprawnienie: „Braki: decyzje”.

### Pod tabelą

- **Pozycje bez produktu → Powiąż z produktem**: wpisz SKU produktu z katalogu i ile sztuk produktu jest w jednej
  sztuce oferty (zwykle 1). Oferta zostaje powiązana na stałe, tak jak w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → „Do
  przypisania”: kolejne zamówienia z niej przyjdą już z produktem. Zamówienie dostaje rezerwację i wychodzi z „Do
  wyjaśnienia”, gdy to był jedyny powód. Działa też na koncie w trybie „Tylko podgląd” (nic nie idzie do kanału).
  Uprawnienie: „Ustawienia”. Gdy kanał nie podał numeru oferty, karta to pisze: wtedy usuń pozycję i dodaj produkt.
  Oferty już powiązanej z innym produktem karta nie przepina (zmieniłoby to wszystkie kolejne zamówienia z niej):
  pokazuje SKU powiązanego produktu, a gdy w zamówieniu jest inny towar, usuń pozycję i dodaj produkt. Gdy oferta jest
  powiązana z tym samym produktem (zamówienie przyszło przed powiązaniem albo się nie przeliczyło), przycisk „Dopnij
  produkt …” dopina produkt i rezerwację tylko w tym zamówieniu, i tylko przed zbieraniem.
- **Pobierz nazwy z kanału** (nad tabelą, gdy część pozycji nie ma nazwy z kanału, np. zamówienia sprzed 7.11.2026):
  czyta zamówienie z kanału i dopisuje nazwę, SKU i EAN pozycji, numer zamówienia i koszt wysyłki. Nie zmienia statusu
  ani rezerwacji. Uprawnienie jak przy edycji pozycji.
- **Dodaj pozycję**: w okienku wpisz co najmniej 2 znaki SKU, nazwy albo pełny EAN i kliknij **Szukaj** (albo Enter).
  Lista pokazuje aktywne produkty z katalogu z nazwą, SKU, stanem dostępnym (na półce minus rezerwacje) i ceną
  z katalogu. **Wybierz** wpisuje SKU i cenę do formularza (cenę możesz zmienić, puste pole = cena z katalogu), potem
  ilość i **Dodaj pozycję**. SKU możesz też wpisać ręcznie. Pozycja dostaje rezerwację od razu (czego nie ma na stanie,
  to „brakuje”), kwota zamówienia rośnie o cenę razy ilość.
- **Podziel zamówienie**: wpisz, ile sztuk przenieść do nowej paczki, „Podziel” pyta o potwierdzenie. Rezerwacje
  przechodzą razem ze sztukami, pieniądze zostają na pierwszej paczce. Działa dla zamówienia „Do realizacji”,
  opłaconego albo za pobraniem.

Pozycje zmienia się tylko przed zbieraniem: w statusach „Nowe”, „Do realizacji” i „Do wyjaśnienia”. Później karta
pisze „Zamówienie jest już zbierane, najpierw przerwij zbieranie”.

### Kiedy pozycji nie zmienisz (dodanie, ilość, cena, usunięcie)

Przycisk **Edytuj** w nagłówku „Pozycje” i „Dodaj pozycję” są wtedy niedostępne, a powód stoi tekstem pod tabelą
(widać go też na telefonie). Zapis, który mimo to dojdzie (np. z karty otwartej wcześniej), Kompletor odrzuca z tym
samym zdaniem.

- **Zamówienie za pobraniem z utworzoną przesyłką** (także w trakcie tworzenia albo gdy stan przesyłki jest niepewny;
  to samo przy przesyłce z kwotą pobrania): etykieta ma kwotę pobrania z chwili utworzenia, a klient płaci kurierowi
  tę kwotę. Co zrobić, zależy od przewoźnika:
  - przewoźnik, którego przesyłkę anulujesz z Kompletora (Wysyłam z Allegro, Orlen Paczka, Poczta Polska, Base
    Courier): kliknij „Anuluj przesyłkę” w sekcji „Przesyłka”, zmień pozycje i utwórz przesyłkę ponownie;
  - przewoźnik, u którego przesyłkę anulujesz tylko w jego panelu (InPost, DPD, GLS): pozycji na karcie nie zmienisz.
    Dodatkowy towar wyślij osobnym zamówieniem (Zamówienia → Dodaj zamówienie), brak towaru rozstrzygnij decyzją o
    braku w tabeli pozycji, a kwotę pobrania zmień w panelu przewoźnika.

  Karta pisze, który z tych przypadków dotyczy zamówienia. Ta sama reguła obowiązuje **Podziel zamówienie** i „Dośle
  później”: przy pobraniu z gotową etykietą ich nie zrobisz.
- **Zamówienie opłacone z góry z utworzoną przesyłką**: pozycje zmienisz (etykieta nie ma kwoty ani listy towaru), a pod
  tabelą stoi ostrzeżenie „Przesyłka jest już utworzona: sprawdź, czy towar mieści się w paczce i czy gabaryt z etykiety
  pasuje”. Gdy paczka się zmienia (inny gabaryt, druga paczka), anuluj przesyłkę i utwórz ją ponownie albo dodatkowy
  towar wyślij osobnym zamówieniem.
- Zmiana pozycji w chwili, gdy ktoś (albo automat) tworzy przesyłkę: Kompletor nie dopuści do etykiety ze starą
  zawartością. Albo „Utwórz przesyłkę” odmówi z prośbą o ponowne kliknięcie, albo zmiana pozycji trafi na już
  utworzoną przesyłkę i obowiązuje reguła wyżej.
- **Dokument sprzedaży wystawiony albo w drodze**: faktura albo paragon w wFirmie (także wystawiany przed pakowaniem,
  gdy firma wystawia dokumenty przy wcześniejszym statusie), faktura wysłana do KSeF albo faktura w BaseLinkerze.
  Dokument ma skład i kwotę z chwili wystawienia, więc zmianę robi korekta w programie, w którym powstał. Gdy
  poprzednia próba w wFirmie nie dostała odpowiedzi, karta prosi o sprawdzenie w wFirmie i „Ponów fakturę”; po
  ponowieniu z błędem (faktury nie ma) pozycje znów da się zmienić. Faktura KSeF odrzucona albo niewysłana (bez śladu
  wysyłki) nie blokuje: „Ponów” składa ją od nowa z pozycji w Kompletorze.
- Konto w trybie **„Tylko podgląd”**: przyciski są nieaktywne z powodem trybu, a zapis jest odrzucany.
- Brak uprawnienia „Karta zamówienia: dodawanie, usuwanie i zmiana ilości pozycji”: przycisków nie ma.

**Pieniądze po zmianie pozycji.** Kwota zamówienia i kwota pobrania przeliczają się od razu. Przy zamówieniu już
opłaconym sekcja „Płatność” pokazuje „Do dopłaty” albo „Do zwrotu” (względem kwoty zapłaconej sprzed pierwszej zmiany
z karty). Samą dopłatę albo zwrot ustalasz z klientem poza kartą (przelew, panel kanału), a na karcie zapisujesz ją
w „Płatność”.

**Zmiana tylko w Kompletorze, w kanale zamówienie zostaje bez zmian.** Allegro, Empik ani sklep nie dostaną nowych
pozycji. Gdy klient zmieni zamówienie w kanale już po zmianie z karty, Kompletor nie nadpisuje zmiany: zamówienie idzie
do „Do wyjaśnienia” z powodem „Zmiana w kanale po edycji w Kompletorze”.

## Wysyłka, Dane do faktury, Szczegóły zamówienia

Trzy równe karty na górze (na telefonie jedna pod drugą):

- **Wysyłka**: odbiorca (imię i nazwisko, firma), adres, kod i miasto (kraj tylko spoza Polski), punkt odbioru z kodem
  i adresem punktu, telefon i e-mail (klikalne), kupujący (gdy jest kimś innym niż odbiorca), login w kanale (Allegro),
  uwagi klienta (Allegro: wiadomość do sprzedającego, sklep: uwagi do zamówienia), a pod kreską sposób wysyłki z kanału,
  przewoźnik i koszt wysyłki. Przewoźnik zmieniony na karcie („Zmień sposób wysyłki”) ma przy sobie odznakę
  „zmieniony na karcie”; sposób wysyłki z kanału zostaje taki, jak wybrał klient. Na dole: skąd są dane (z kanału, wpisane ręcznie, z przeprowadzki z BaseLinkera) i kiedy je
  odczytano oraz przyciski **Kopiuj adres** i **Odśwież z kanału**.
- **Dane do faktury**: nazwa, NIP, adres; przy fakturze imiennej (bez NIP-u) dopisek „Rodzaj: faktura imienna”.
- **Szczegóły zamówienia**: kanał i konto, numer w sklepie albo w BaseLinkerze (gdy nie ma go w tytule), paczki, data
  złożenia i ostatniej zmiany, źródło, stan płatności, sposób płatności słowami i pobranie tak/nie.

W zamówieniu ręcznym karty „Wysyłka” i „Dane do faktury” mają **Edytuj** (bez danych: **Wpisz dane**): zamiast obu
kart pojawia się formularz z trzema grupami pól (Kupujący, Adres dostawy, Dane do faktury) i jednym przyciskiem
„Zapisz dane klienta”; na komputerze zajmuje dwie kolumny, a „Szczegóły zamówienia” zostają obok. Po wystawieniu
faktury zapis zmienionych danych do faktury w tym formularzu odmawia (kontakt i adres dalej zapiszesz). Osoba ze skrótem widzi samo
„Jan T., Poznań”. Gdy danych nie ma, sekcja mówi dlaczego (zapis wyłączony na instalacji, konto w trybie „Tylko
podgląd” bez zgody firmy, czeka w kolejce). Każde wyświetlenie karty to jeden wpis w dzienniku podglądów (Ustawienia →
Zespół i dostęp → Dane klientów), wspólny dla nagłówka i tej sekcji. „Usuń dane klienta (żądanie z RODO art. 17)” pyta o potwierdzenie.

### Edytuj kupującego i dane do faktury (zamówienie ze sklepu, Allegro, Empiku)

Droga: **Zamówienia** → kliknij zamówienie → karta „Wysyłka” → **Edytuj kupującego** (w pasku nagłówka karty) albo
karta „Dane do faktury” → **Edytuj**. Przyciski widzi osoba z uprawnieniem „Dane klienta” (Ustawienia → Zespół i dostęp →
Użytkownicy i uprawnienia).

- **Edytuj kupującego**: imię i nazwisko, firma, telefon i e-mail kupującego. Wystarczy imię i nazwisko albo sama firma;
  e-mail i telefon są sprawdzane (format adresu, co najmniej 9 cyfr). Adres dostawy i punkt odbioru zmienia się dalej
  w sekcji „Przesyłka” („Popraw adres albo punkt odbioru przed nadaniem”). Kupującego poprawisz także po nadaniu, ale
  telefon i e-mail zmienione po utworzeniu przesyłki nie trafiają już do przewoźnika. Adres Allegro w postaci
  …@allegromail.pl to adres zastępczy: wiadomości do klienta przekazuje Allegro.
- **Nazwisko na etykiecie i na fakturze osoby prywatnej** pochodzi z adresu dostawy, nie z „Edytuj kupującego”: zmienisz
  je w „Popraw adres albo punkt odbioru” przed nadaniem. „Edytuj kupującego” zmienia kupującego i kontakt do maili.
- **Edytuj** danych do faktury: najpierw rodzaj, jeden z trzech:
  - **Bez danych do faktury**: paragon albo faktura na dane z adresu dostawy; pola danych do faktury są czyszczone.
    Gdy zamówienie ma dziś dane do faktury albo prośbę klienta o fakturę, zapis wymaga zaznaczenia **Tak, usuń dane do
    faktury** (kanał ich już nie odtworzy, a przy ustawieniu „faktura tylko na żądanie” zamówienie wypadnie z kolejki
    faktur).
  - **Faktura imienna (bez NIP-u)**: osoba prywatna z własnymi danymi do faktury, np. z Allegro albo ze sklepu
    z zaznaczonym „chcę fakturę”. Imię i nazwisko oraz pełny adres są wymagane, pole NIP zostaje puste.
  - **Faktura na firmę (NIP)**: nazwa firmy, NIP, ulica z numerem, kod pocztowy i miasto. NIP musi mieć 10 cyfr
    i poprawną sumę kontrolną („PL”, spacje i myślniki Kompletor zdejmie sam), a adres trzeba podać w całości.
  Formularz otwiera się z rodzajem z danych zamówienia: z NIP-em „na firmę”, z danymi bez NIP-u „imienna”, bez danych
  „bez danych do faktury” (albo „na firmę”, gdy klient zaznaczył w kanale fakturę na firmę, a kanał nie podał danych;
  karta mówi wtedy „uzupełnij je przyciskiem »Edytuj«”). NIP zagraniczny (np. „DE…”, numer VAT UE) i nabywcę z kraju
  innego niż Polska poprawiasz w programie do faktur: karta odmawia z takim zdaniem. Kraj nabywcy zostaje z kanału.
  Poprawka bez zmiany rodzaju (np. literówka w ulicy) nie zmienia tego, czy klient prosił o fakturę: Empik podaje
  czasem firmę w adresie rozliczeniowym bez prośby o fakturę i takie zamówienie po poprawce dalej nie trafia do faktur
  „tylko na żądanie”. Prośba zmienia się dopiero ze zmianą rodzaju.
- **Zamówienie bez danych klienta** (kanał podaje dane, ale Kompletor ich jeszcze nie odczytał, np. tuż po przełączeniu):
  oba przyciski są nieaktywne, a powód stoi tekstem pod danymi w obu kartach (widać go też na telefonie, bez
  najeżdżania): „Najpierw »Odśwież z kanału«”. Kliknij **Odśwież z kanału** w stopce karty „Wysyłka”, a po odczycie
  popraw dane. Gdy zapis danych klientów jest wyłączony albo odczyt z kanału kończy się błędem, odświeżenie nie pomoże:
  karta podpowiada wtedy wpisanie adresu w **Popraw adres albo punkt odbioru** (sekcja „Przesyłka”), po którym oba
  „Edytuj” działają. Przy kanale, który danych klienta nie podaje (np. EasyTools), dane wpiszesz od zera.
  To samo dotyczy trybu „Tylko podgląd”: przyciski są nieaktywne, a powód trybu stoi tekstem w obu kartach.
- **Paczka dodatkowa** (podział zamówienia, dosłanie): oba przyciski są nieaktywne, a karta ma odsyłacz **przejdź do
  zamówienia głównego**. Faktura i maile paczki biorą dane klienta z zamówienia głównego, więc tam je zmieniasz.
- Zapis: „Zapisz dane kupującego” albo „Zapisz dane do faktury” (pasek zapisu pokazuje się po pierwszej zmianie),
  „Anuluj” albo „Zakończ edycję” wraca do odczytu bez zapisu. Po zapisie karta pokazuje nowe dane i komunikat „Zapisano…
  Kolejny odczyt z kanału ich nie nadpisze”: dane poprawione ręcznie mają pierwszeństwo przed kanałem, także przy
  „Odśwież z kanału”.
- Gdy ktoś inny zmienił dane klienta w tym samym czasie (np. poprawka adresu obok), zapis odmawia z prośbą o ponowne
  otwarcie formularza, zamiast nadpisać cudzą zmianę.
- **Po wystawieniu faktury** (wFirma, KSeF albo faktura z BaseLinkera, także dla paczki wydzielonej z tego zamówienia)
  „Edytuj” danych do faktury jest nieaktywne, a pod danymi stoi zdanie, dlaczego: dane do faktury zostają takie, jak na
  dokumencie. Błędne dane nabywcy poprawia faktura korygująca w programie, w którym faktura powstała (wFirma, BaseLinker;
  w Kompletorze korekta KSeF powstaje dziś tylko przy zwrocie). Kupującego i kontakt dalej poprawisz.
  - **wFirma**: próba z jednoznacznym błędem nie blokuje (ponowienie weźmie nowe dane). Próba bez odpowiedzi z wFirmy
    (faktura mogła powstać) blokuje: sprawdź w wFirmie, czy faktura jest, i kliknij **Ponów fakturę** w bloku „Faktura”;
    gdy ponowienie skończy się jednoznacznym błędem, edycja wraca.
  - **KSeF**: faktura wysłana, w trakcie wysyłki albo przyjęta blokuje. Faktura **odrzucona** przez KSeF albo z **błędem
    wysyłki**, która do KSeF na pewno nie doszła, nie blokuje: po zapisie komunikat prosi o **Ponów** w bloku „Faktura
    KSeF” (wyjdzie z poprawionymi danymi i tym samym numerem). Gdy wcześniejsza wersja mogła dojść do KSeF, edycja jest
    zablokowana, a zdanie prosi najpierw o „Ponów”: Kompletor sprawdzi w KSeF, czy ją przyjął. Gdy szkic faktury KSeF
    powstał przed zmianą, komunikat po zapisie prosi o „Przygotuj szkic ponownie”.
- **Tryb „Tylko podgląd”**: oba przyciski są widoczne, ale nieaktywne, z tym samym zdaniem co reszta karty (zmiany
  robisz tam, gdzie prowadzisz zamówienia dziś; konto włączysz w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży).
- Historia zmian zapisuje, kto i kiedy zmienił dane i które pola (np. „Dane klienta zmienione na karcie, kupujący:
  telefon, e-mail”), bez wartości. Wartości są tylko w zaszyfrowanych danych klienta, a odczyt w dzienniku podglądów.
- Zmiana zostaje w Kompletorze: w sklepie, na Allegro i w Empiku dane klienta się nie zmieniają.

## Płatność

Jedyne miejsce rozliczenia płatności na karcie: stan (odznaka w nagłówku sekcji), „Zapłacono X z Y” jak w BL, różnica „Do dopłaty X zł” albo „Do
zwrotu X zł” (na przykład po dodaniu albo usunięciu pozycji), termin zwolnienia towaru i przypomnienie o płatności przy
nieopłaconych oraz wpisy płatności.

- **Oznacz jako opłacone**: zamówienie nieopłacone (uprawnienie „Ręczne «Oznacz jako opłacone»”).
- **Zapisz dopłatę**: kwota, data i metoda dopłaty klienta (to samo uprawnienie).
- **Zwrot różnicy**: kwota, data i metoda zwrotu, z potwierdzeniem (uprawnienie „Zwroty pieniędzy”). Zwrot czeka na
  eksport przelewów; sam przelew robisz w banku.

To tylko zapis w Kompletorze: karta nie łączy się z bankiem i nie wysyła linków do płatności.

### Jak zarejestrować wpłatę przelewem

Klient zapłacił przelewem, a zamówienie ma status płatności „Nieopłacone”:

1. **Zamówienia** → kliknij zamówienie → sekcja **Płatność** (obok „Przesyłki”, pod pozycjami).
2. Konto sklepu w trybie pracy: kliknij **Oznacz jako opłacone** (cała kwota) albo **Zapisz dopłatę** (część kwoty
   albo dopłata po zmianie pozycji: wpisz kwotę, datę i metodę „przelew”). Potrzebne uprawnienie „Ręczne «Oznacz jako
   opłacone»” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia, domyślnie właściciel).
3. Konto sklepu w trybie „Tylko podgląd”: przyciski są widoczne, ale nieaktywne. Wpłatę zapisujesz tam, gdzie
   prowadzisz zamówienia dziś (np. w BaseLinkerze); Kompletor pobierze nowy stan płatności przy najbliższym odczycie
   z kanału. Żeby zapisywać wpłaty w Kompletorze, włącz konto w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży.

Kompletor nie łączy się z bankiem: przelewu nie wykrywa sam, wpłatę zawsze ktoś zapisuje.

## Przesyłka

Sposób wysyłki, przewoźnik i koszt z kanału są w karcie „Wysyłka”, pobranie w „Szczegółach zamówienia”. Sekcja
„Przesyłka” (obok „Płatności”) to sama przesyłka: **Policz przesyłkę** (gabaryt, wymiary, waga, kwota pobrania, uwagi przed nadaniem), nadanie u przewoźnika z gabarytem,
numer nadania, etykieta, poprawka adresu przed nadaniem i **Anuluj przesyłkę** u przewoźnika, który to umie (dziś
Wysyłam z Allegro, z pytaniem przed kliknięciem; opis w [Przesyłki](przesylki.md)). Przycisk **Pakuj na
stanowisku** w nagłówku sekcji otwiera stanowisko pakowania z tym zamówieniem (uprawnienie „Stanowisko pakowania”).

### Zmień sposób wysyłki

Klient wybrał Paczkomat, a chce kuriera DPD (albo odwrotnie, albo odbiór osobisty): **Przesyłka** → „Zmień sposób
wysyłki przed nadaniem” → wybierz przewoźnika i usługę z listy → uzupełnij, czego potrzebuje → **Zmień sposób
wysyłki** → **Utwórz przesyłkę** jak zwykle, już nową usługą.

- Lista to usługi z reguł przewoźników firmy (Ustawienia → Wysyłka i druk → Przewoźnicy), np. „Paczkomaty (InPost)”,
  „DPD”, „Odbiór osobisty”. Obecna usługa jest na liście z dopiskiem „(obecny)”.
- Paczkomat i inne punkty: wymagany punkt nowego przewoźnika (dla InPost jest wyszukiwarka paczkomatów). Kurier pod
  adres: wymagane ulica, kod pocztowy i miasto; punkt odbioru znika. DPD i GLS: adres wymagany zawsze, a do punktu
  tego przewoźnika dopisujesz jego kod (puste pole = kurier pod adres). Punkt poprzedniego przewoźnika (np. kod
  paczkomatu przy zmianie na DPD) i kod, który wygląda na punkt innej sieci (paczkomat InPost, punkt Orlen Paczki),
  nie przechodzą: karta odmówi z wyjaśnieniem.
- Odbiór osobisty i powrót na Wysyłam z Allegro nie zmieniają danych odbiorcy. Przy pobraniu i odbiorze osobistym
  kwotę pobierasz od klienta przy wydaniu paczki. Wysyłam z Allegro nada paczkę na dane odbiorcy z zamówienia
  w Allegro: adres poprawiony w Kompletorze do Allegro nie przechodzi.
- Zamówienie za pobraniem przechodzi tylko na usługę z pobraniem (Orlen Paczka i Poczta Polska go nie mają): inne
  są na liście z dopiskiem „(bez pobrania)”, a przycisk zapisu jest wtedy nieaktywny.
- Zamówienie z Allegro z dostawą Allegro: usługę Allegro (paczkomat, One Box, kurier) zmienia się w Allegro. Z karty
  przejdziesz na przewoźnika z umowy firmy (np. DPD) i z powrotem; koszt takiej przesyłki rozliczasz z przewoźnikiem,
  poza Allegro. Numer nadania tej przesyłki idzie do Allegro jak każdy numer, gdy konto Allegro ma włączony zapis
  numerów nadania.
- Tylko przed utworzeniem przesyłki. Gdy przesyłka już jest, przycisk jest nieaktywny z powodem: najpierw anuluj
  przesyłkę (u przewoźnika, który to umie, albo w jego panelu i „Rozstrzygnij ręcznie → nie powstała”).
- Koszt wysyłki zapłacony przez klienta się nie zmienia: dopłatę albo zwrot różnicy ustalasz z klientem.
- Zmiana dotyczy tej paczki. Paczki wydzielone wcześniej (podział, dosłanie) zostają przy swoim przewoźniku i karta to
  mówi; paczka wydzielona po zmianie dziedziczy nową usługę.
- Kolejny odczyt zamówienia z kanału zmiany nie cofa.
- Status firmy przypisany ręcznie albo automatem dla konkretnych przewoźników (np. „Do realizacji Paczkomaty”) po zmianie
  na przewoźnika spoza jego listy przestaje obowiązywać: zamówienie dostaje status firmy pasujący do nowego przewoźnika
  (np. „Do realizacji DPD”). Automaty z warunkiem przewoźnika same się po zmianie nie uruchamiają.
- Lista pokazuje jedną pozycję na parę przewoźnik i moduł wysyłki (pierwszą wg kolejności reguł), także gdy firma ma
  kilka reguł tego przewoźnika z różnymi ustawieniami.
- Gdy ktoś zmieni sposób wysyłki w chwili, gdy druga osoba klika „Utwórz przesyłkę”, nadanie odmówi („Sposób wysyłki
  zmienił się w trakcie tworzenia przesyłki”) i wystarczy kliknąć ponownie.
- Ślad: historia zamówienia „Sposób wysyłki zmieniony na karcie: Paczkomaty (InPost) → DPD” (kto, kiedy; bez adresu),
  a zmieniony adres albo punkt w dzienniku podglądów danych klientów (nazwy pól, bez wartości).
- Kto: osoba z uprawnieniami „Dane klienta: pełny podgląd” i „Stanowisko pakowania”, konto kanału w trybie pracy.
  W trybie „Tylko podgląd” przycisk jest widoczny i nieaktywny z powodem. Zamówienie wysłane, anulowane, bez wysyłki
  albo do wyjaśnienia nie ma tego bloku (przy wyjaśnieniu przewoźnika wybierasz w wyjaśnieniu).

## Dokument sprzedaży

Stan faktury słowem („W kolejce”, „Wystawiona”, „Błąd: …” z powodem z programu do faktur), numer dokumentu (gdy jest),
czy klient chce faktury na firmę i kiedy faktura powstaje. Przy wystawionej fakturze z wFirmy przycisk **PDF faktury**
(uprawnienia „Faktura na karcie zamówienia” i dane klienta), po błędzie **Ponów fakturę** (nową próbę wystawia kolejka
w najbliższym przebiegu, bez drugiej faktury tej samej paczki). Przy wyłączonym „Wystawiaj faktury z Kompletora”
sekcja mówi, że fakturę wystawia BaseLinker albo biuro ręcznie. Dla firm z fakturami KSeF w tej samej sekcji szkic faktury KSeF z przyciskiem **Przygotuj szkic faktury** (nic
nie wysyła). Firma bez programu do faktur widzi zdanie, że zamówienie zamyka się bez dokumentu, i link do Ustawienia →
Dokumenty i faktury → Dokumenty sprzedaży ([Dokumenty sprzedaży](dokumenty-sprzedazy.md)).

## Zwroty i reklamacje

Sekcja jest tylko wtedy, gdy zamówienie ma zwroty: lista zwrotów ze statusem słowem i link „Otwórz w zwrotach”.
Zgłoszenie robisz z menu **Więcej → Zgłoś zwrot / Zgłoś reklamację** (ekran Zwroty i reklamacje z tym zamówieniem).
Zwroty prowadzi tamten ekran: na karcie nie ma drugiego formularza.

## Notatki wewnętrzne

Notatka dla biura i magazynu, do 2000 znaków. Widać autora i czas. Poprawić ją może tylko autor, przez 15 minut od
dodania („Popraw notatkę”, jeden zapis); nikt jej nie kasuje. Notatka nie trafia na wydruk karty zamówienia. Treść notatki nie trafia do asystenta
AI, powiadomień ani dziennika. Uprawnienie „Karta zamówienia: notatki wewnętrzne” mają wszystkie role.

## Historia zmian

Na dole karty, domyślnie zwinięta (kliknij „Historia zmian”, obok liczba zdarzeń). Zdarzenia zamówienia i zmiany
z karty na jednej osi czasu, nowsze wyżej, z autorem (imię osoby albo „system”).
Przełącznik „Tylko ludzie” chowa wpisy automatów. Historia nie pokazuje danych klienta ani dziennika podglądów danych
klienta (ten jest w **Ustawienia → Zespół i dostęp → Dane klientów**).

## Czego karta nie robi

- Nie zmienia zamówienia w kanale: status, pozycje i kwota w sklepie, na Allegro i w Empiku zostają bez zmian.
- Nie łączy się z bankiem i nie wysyła linków do płatności.
- Nie wystawia faktury przyciskiem: fakturę w wFirmie wystawia kolejka (co 2 minuty, po włączeniu „Wystawiaj faktury
  z Kompletora” w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży). Sekcja „Dokument sprzedaży” pokazuje stan, numer, „PDF faktury” i „Ponów
  fakturę” po błędzie. Korekty i anulowanie faktury są w wFirmie. Do KSeF nic nie wysyła.
- Nie wysyła maili, SMS-ów ani wiadomości do klienta (BL ma „Wymiana wiadomości”, Kompletor jeszcze nie).
- Nie pokazuje wagi produktów, prowizji i opłat kanału, rabatów, pól dodatkowych BL, paragonów ani strony zamówienia dla klienta.
- Nie wysyła zmienionych pozycji, ilości ani cen do kanału, także po włączeniu zapisu na kanał (zapis na kanał to stany,
  statusy i numery nadania).
- Nie zamienia produktu w pozycji bez braku: „Zamień produkt” jest decyzją o brakującym towarze. Inny towar w pozycji
  bez braku = usuń pozycję i „Dodaj pozycję”.
- Nie zmienia pozycji z zamiany: zamiennik ma ilość i cenę towaru, który zastępuje (klient zapłacił za tamten), więc
  jego ilości i ceny nie zmienisz, nie usuniesz go, nie przeniesiesz do innej paczki ani nie dośle się go osobno. Nie
  usuniesz też pozycji, która ma zamiennik. Zamiany nie da się cofnąć: różnicę w cenie rozlicz z klientem poza
  zamówieniem, a gdy zamiennika zabraknie przy pakowaniu, wybierz przy braku jeszcze raz „Zamień produkt” albo
  „Wyślij resztę”. Gdy faktura zamówienia z zamianą stanie (komunikat w sekcji „Dokument sprzedaży”), wystaw ją ręcznie
  na kwotę zapłaconą, kliknij „Wyślij bez faktury”, a potem „Dokument wystawiony”.
- Nie dodaje pozycji spoza katalogu: „Dodaj pozycję” szuka tylko aktywnych produktów firmy (nowy produkt zakładasz
  najpierw w Produkty). Rabatu procentowego na pozycji nie ma: obniżkę wpisujesz jako nową cenę brutto.
- Nie ma przycisku „zamień na inny produkt” bez braku: zamianę robisz dwoma krokami, najpierw **Dodaj pozycję** z nowym
  produktem, potem usuń starą pozycję (ostatniej pozycji zamówienia usunąć się nie da, więc kolejność odwrotna przy
  zamówieniu z jedną pozycją się nie uda). Przy braku towaru jest „Zamień produkt” w decyzji o braku.
- Nie zmienia sposobu wysyłki w kanale: w sklepie i na Allegro zostaje metoda wybrana przez klienta, zmiana jest w Kompletorze
  (i w przesyłce, którą utworzysz).
- Adresu dostawy z kanału nie edytuje się kliknięciem w wartość (jak w BL): przed nadaniem jest „Popraw adres albo
  punkt odbioru” w sekcji Przesyłka, kupującego i dane do faktury zmienia „Edytuj kupującego” i „Edytuj” w kartach
  „Wysyłka” i „Dane do faktury”.
- Nie poprawia danych nabywcy na wystawionej fakturze: po fakturze potrzebna jest faktura korygująca w programie, w którym
  faktura powstała.
- Nie wysyła poprawionych danych klienta do kanału (sklep, Allegro, Empik).
