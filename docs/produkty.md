# Produkty: dodawanie, karta produktu, zdjęcia i zestawy

Kompletor prowadzi katalog produktów sam. Produkt zakładasz w panelu od zera albo pobierasz jego dane z miejsca,
w którym już jest: z wFirmy (po SKU), z oferty Twojego sklepu albo z kopii BaseLinkera. Żadna z tych integracji nie
jest potrzebna: firma bez wFirmy i bez BaseLinkera zakłada w panelu towar ze stanem, produkt bez stanu i zestaw.

## Gdzie to jest

| Ekran | Droga z menu | Adres | Kto widzi |
| --- | --- | --- | --- |
| Dodaj produkt | **Produkty** → przycisk **„Dodaj produkt”** (prawy górny róg) | `/produkty/nowy` | uprawnienie `produkty.dodawanie` |
| Karta produktu | **Produkty** → kliknięcie produktu na liście | `/produkty/<id>` | każdy zalogowany (podgląd); zmiany: `produkty.dodawanie` |
| Zdjęcia produktu | karta produktu → zakładka **„Zdjęcia”** | `/produkty/<id>#zdjecia` | jak karta produktu |
| Skład zestawu | karta zestawu → **„Składniki zestawu”** → przycisk **„Zmień skład”** | `/produkty/<id>#sklad` | `produkty.dodawanie` |
| Powiązania produktu (oferty, towar wFirmy) | karta produktu → zakładka **„Powiązania”** | `/produkty/<id>#powiazania` | podgląd: każdy zalogowany; zmiany: `produkty.dodawanie` (biuro) |
| Łączenie ofert z produktami (masowo) | **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → konto → sekcja **„Łączenie ofert z produktami”** | `/ustawienia/kanaly/<konto>#laczenie` | `ustawienia` |
| Produkty bez stanu | **Produkty** → przycisk **„Produkty bez stanu”** (także w menu pod „Produkty”) | `/produkty/bez-stanu` | `produkty.dodawanie` |
| Kafle kompletności (braki danych) | **Produkty** → rząd kafli nad listą; kafel filtruje listę ([opis](#kafle-kompletnosci)) | `/produkty?filtr=bez_ean` (i `bez_wagi`, `bez_oferty`, `bez_strefy`) | każdy zalogowany |
| Import i eksport CSV | **Produkty** → przycisk **„Import i eksport CSV”** (prawy górny róg) | `/produkty/csv` | `produkty.dodawanie` (także sam plik eksportu `/api/produkty/eksport`, bo zawiera ceny zakupu) |
| Warianty | karta produktu → **Produkt** → pole **„Grupa wariantów”**; lista wariantów w sekcji **„Warianty”** | `/produkty/<id>#warianty` | jak karta produktu |
| Zdjęcia z feedu | **Produkty** → przycisk **„Zdjęcia z feedu”** (prawy górny róg) | `/produkty/zdjecia-z-feedu` | `produkty.dodawanie` (także lista bez dopasowania `/api/produkty/feed-bez-dopasowania`) |
| Publikacja: podgląd ofert i „Wystaw” | karta produktu → zakładka **„Publikacja”** ([Oferty](oferty.md)) | `/produkty/<id>/publikacja` | każdy zalogowany; „Wystaw”: `produkty.dodawanie` |
| Przygotuj oferty (wiele produktów) | **Produkty** → pola wyboru przy produktach → **„Przygotuj oferty (N)”** na pasku nad listą; raporty: przycisk **„Przygotowane oferty”** (prawy górny róg) | `/produkty`, `/produkty/przygotowanie-ofert` | `produkty.dodawanie` |
| Packshot (AI) | karta produktu → **Zdjęcia** → przycisk **„Packshot (AI)”** przy zdjęciu; włączenie: **Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI** | `/produkty/<id>#zdjecia`, `/ustawienia/agenci-ai#dostawca-ai` | przycisk: `produkty.dodawanie`; włączenie: `ustawienia` |

Właściciel ma uprawnienie z roli. Biuru i magazynowi nadaje się je jako dodatkowe w **Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia**
(albo `npm run uzytkownik -- dodaj ... --uprawnienia produkty.dodawanie`). Bez uprawnienia przycisk „Dodaj produkt”
jest niewidoczny, adres daje 404, a karta produktu jest tylko do podglądu. W menu nie ma osobnych pozycji.

## Dodaj produkt

Ekran to jeden formularz, w kolejności jak karta produktu:

1. **Produkt**: rodzaj (**Towar ze stanem**, **Bez stanu (e-book, usługa)**, **Zestaw z innych produktów**), nazwa
   (z niej faktura i karta zbierania), SKU (unikalne w firmie), EAN (opcjonalnie, sprawdzana cyfra kontrolna).
2. **Ceny i podatek**: cena sprzedaży brutto, stawka VAT (23, 8, 5, 0, zw., np.), cena netto liczona sama, cena zakupu
   netto (opcjonalnie, do marży).
3. **Magazyn** (towar ze stanem): jednostka (sztuki albo kilogramy), stan początkowy.
4. **Skład zestawu** (zestaw): składniki z listy towarów ze stanem, ilość (sztuki, a przy towarze na wagę gramy)
   i opcjonalnie udział w cenie zestawu w procentach (wszystkie albo żaden, razem 100%; puste = podział
   proporcjonalnie do cen składników).
5. **Półka, wysyłka, opis i zdjęcia**: lokalizacja na półce, próg niskiego stanu, waga (g) i wymiary (cm), opis
   z przyciskiem **„Podpowiedz opis (AI)”**, zdjęcia (JPG, PNG, WEBP do 15 MB, najwyżej 16; pierwsze = główne).

Przycisk **„Utwórz produkt”** zapisuje produkt, stan startowy (ruch „stan startowy, produkt dodany w panelu”), skład,
zdjęcia i wpis w historii, potem otwiera kartę produktu. Ostrzeżenia (np. brak stawki VAT, ten sam EAN co inny
produkt) pokazuje baner na karcie. Zły plik zdjęcia (np. SVG albo dokument zamiast obrazu) zatrzymuje zapis, zanim
cokolwiek powstanie.

### Pobierz dane (opcjonalnie)

Nad formularzem jest pasek **„Pobierz dane”** z polem „SKU albo EAN”. Przyciski widać tylko wtedy, gdy firma ma daną
integrację, i tylko wypełniają pola; resztę wpisujesz sam. Błąd integracji nie blokuje formularza.

| Przycisk | Kiedy widoczny | Co robi |
| --- | --- | --- |
| **Pobierz z wFirmy** | firma prowadzi magazyn w wFirmie | dotychczasowa ścieżka: SKU → „Sprawdzam w wFirmie…” → dane z wFirmy (niżej) |
| **Pobierz z oferty sklepu** | firma ma pobrane oferty z co najmniej jednego sklepu | szuka oferty o tym SKU albo EAN w ostatnim pobraniu ofert; nazwa, SKU, EAN, cena, VAT (gdy sklep go podaje: WooCommerce ze stawki klasy podatkowej produktu), stan i zdjęcia (WooCommerce, Allegro, główne zdjęcie z PrestaShop) |
| **Pobierz z BaseLinkera** | firma ma kopię produktów BaseLinkera (import, przeprowadzka) | nazwa, SKU, EAN, cena, VAT, stan z magazynu BL |

Kilka dopasowań = lista do wyboru. Oferta albo produkt BL już powiązane z produktem prowadzą do jego karty. Zdjęcia
z oferty sklepu Kompletor pobiera w tle po zapisie (tylko adresy https, do 6 zdjęć). Produkty, które już są w katalogu (import
z wFirmy albo BaseLinkera) i nie mają żadnego zdjęcia, dostają zdjęcia z powiązanej oferty przy każdym „Pobierz oferty”
(dla wszystkich kont naraz może je pobrać administrator serwera). Jedno pobranie zleca najwyżej 200
produktów, reszta przy następnym. Pobieranie zdjęć (z ofert, z feedu i packshoty AI) ustępuje w kolejce fakturom, WZ,
etykietom i mailom: Kompletor bierze zdjęcie dopiero wtedy, gdy nic pilnego nie czeka, więc seria zdjęć
z wolnego sklepu nie opóźnia dokumentów.
Gdy ktoś wgra zdjęcie ręcznie, zanim Kompletor dojdzie do produktu, zdjęcia z oferty nie dochodzą. Produkt założony z oferty jest od
razu z nią powiązany (stan oferty schodzi z tego produktu), także gdy w formularzu poprawisz SKU: karta pokaże wtedy
uwagę, że SKU różni się od SKU w ofercie. Oferta już powiązana z innym produktem nie założy drugiego, tylko da link
do tamtego.

### Ścieżka wFirmy

Firma, która prowadzi stany w wFirmie, zakłada towar ze stanem najpierw w magazynie wFirmy, a w Kompletorze wpisuje
SKU i klika **„Pobierz z wFirmy”**:

1. Gdy towar jest w kopii towarów wFirmy (z ostatniego importu katalogu albo z wcześniejszego sprawdzenia), ekran od
   razu pokazuje dane z wFirmy. Gdy go nie ma, ekran zleca sprawdzenie i pokazuje „Sprawdzam w wFirmie…”; odświeża się
   sam co kilka sekund. Sprawdzenie idzie w tle (tylko odczyt z wFirmy), przycisk nie czeka na wFirmę.
2. Popraw ewentualnie nazwę w panelu i EAN, opcjonalnie uzupełnij półkę, wagę, wymiary, opis i zdjęcia, potem
   **„Dodaj produkt ze stanem”**.

Rodzaj produktu wynika z typu w wFirmie, nigdy z nazwy: **towar** albo **komplet** → produkt ze stanem (stan startowy
z wFirmy, dalej lustro magazynu wFirmy); **usługa** → produkt bez stanu. W firmie z wFirmą przycisk „Towar ze stanem”
w formularzu ręcznym jest wyłączony: towar bez kopii w wFirmie nie miałby stanu ani rozchodu w wFirmie. Bez stanu
i zestaw zakładasz ręcznie jak każda firma.

Komunikaty ścieżki wFirmy:

- **Produkt o tym SKU już jest**: link do karty; nic nie powstaje drugi raz (także przy dwóch kliknięciach naraz).
- **Kilka towarów o tym kodzie**: popraw kody w wFirmie, żeby SKU było jednoznaczne.
- **SKU jest w wFirmie towarem ze stanem** (przy dodawaniu bez stanu): dodaj go jako towar z magazynu.
- **wFirma chwilowo odmawia, spróbuj za kilka minut**: limit wFirmy; do końca blokady (zwykle 5 minut) ekran nie
  zleca kolejnego sprawdzenia. Ta sama pauza wstrzymuje lustro stanów wFirmy i odwrotnie.
- **Sprawdzenie w wFirmie nie ruszyło**: po minucie czekania ekran przestaje się odświeżać; spróbuj później.
- Towar w innym magazynie wFirmy niż magazyn firmy liczy się jak brak (tak samo robi import katalogu).

Kolejny import katalogu znajduje produkt po towarze wFirmy i nie dubluje produktu, stanu ani ruchu startowego.

## Karta produktu

Zakładki u góry: **Produkt**, **Zdjęcia**, **Stan i magazyn** (zestaw: **Skład zestawu**), **Powiązania**, **Historia zmian**.
Pod nazwą produktu widać jego źródło danych: „dodany w panelu”, „z oferty sklepu”, „z BaseLinkera”, „z wFirmy”.

**Dane produktu** to formularz z przyciskiem **„Zapisz zmiany”**: SKU, nazwa, EAN, cena brutto, VAT, cena zakupu,
lokalizacja na półce, próg niskiego stanu, waga, wymiary, opis.

- Produkt **z wFirmy**: cena, VAT, cena zakupu i nazwa na fakturze są tylko do odczytu z dopiskiem „z wFirmy,
  zmieniasz w wFirmie” (odświeża je import). Nazwę w panelu, EAN, półkę, wagę, wymiary i opis zmieniasz tutaj.
- Pozostałe produkty: wszystko edytowalne; nazwa na fakturze idzie za nazwą produktu.
- **SKU** poprawisz przy produkcie dodanym w panelu, z oferty sklepu albo z pliku CSV (literówka nie wymaga zakładania
  produktu od nowa). SKU zajęte przez inny produkt, także inną wielkością liter: „SKU zajęte” z linkiem do tamtego
  produktu. Zmiana trafia do historii. Przy produkcie z wFirmy albo z BaseLinkera SKU jest tylko do odczytu (zmieniasz
  je w tamtym programie). Oferty sklepów już powiązane z produktem zostają powiązane po zmianie SKU.
- Produkt założony z oferty sklepu bez stawki VAT: uzupełnij VAT tutaj, wtedy szkic faktury przestaje pokazywać
  „Produkt bez stawki VAT”.
- Jednostki (sztuki / kilogramy) i rodzaju produktu karta nie zmienia: przeliczyłoby to stan i rezerwacje.

Każdy zapis ze zmianą trafia do **Historii zmian danych** (pole: przed → po, kto, kiedy). Stan magazynowy zmienia
się osobno: „Korekta stanu” w sekcji Stan (firma bez wFirmy) albo w wFirmie.

### Zdjęcia

- **Wgraj**: kilka plików naraz (JPG, PNG, WEBP do 15 MB, do 16 zdjęć na produkt). System sprawdza typ po zawartości
  pliku, nie po nazwie, i odrzuca SVG, HTML, archiwa i dokumenty. Zdjęcie zapisuje się od nowa (do 1600 px, bez
  metadanych aparatu, np. położenia GPS).
- **Główne**, **←**, **→**: kolejność; pierwsze zdjęcie jest główne i widać je na liście produktów, karcie zamówienia,
  w kolejce pakowania, na stanowisku pakowania i na wydrukowanej karcie zbierania.
- **Usuń**: zdjęcie znika z produktu, a jego kopia zostaje w archiwum w bazie, nie jest kasowana.

Zdjęcia są zapisane w bazie danych, więc kopia bazy obejmuje też zdjęcia, a zdjęcia pobrane z ofert sklepu widać od razu
w panelu. Zdjęcia dodane we wcześniejszych wersjach (pliki na dysku serwera) system przenosi do bazy sam przy starcie;
pliki zostają na dysku (README, „Zdjęcia produktów w bazie”). Jeśli zamiast zdjęcia widzisz komunikat „Plik zdjęcia nie
jest jeszcze w bazie”, zgłoś to administratorowi albo wgraj to zdjęcie jeszcze raz.

### Packshot (AI)

Packshot to zdjęcie produktu na białym tle, które AI robi z Twojego zdjęcia (np. z telefonu). Przycisk
**„Packshot (AI)”** stoi przy każdym zdjęciu na karcie produktu → **Zdjęcia**, gdy właściciel firmy go włączył:
**Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI** → klucz Kie.ai i pole **„Packshot AI włączony”**. Bez tego karta mówi,
gdzie go włączyć.

- Robi się w tle i trwa do kilku minut; potem odśwież stronę. Gotowy packshot dochodzi jako **nowe** zdjęcie
  z dopiskiem „packshot AI”; Twoje zdjęcie zostaje. Ustaw go jako główne przyciskiem **„Główne”**.
- Z jednego zdjęcia powstaje jeden packshot (drugie kliknięcie nic nie dubluje). Nieudany packshot zostawia wpis
  w **Historii zmian** produktu z powodem (np. zły klucz, brak kredytów na koncie Kie.ai).
- Do dostawcy idzie tylko to jedno zdjęcie produktu, bez danych klientów. Koszt u Kie.ai: ok. 4 kredytów za packshot.
- Packshot nie robi zdjęć lifestyle i nie wysyła zdjęć do sklepu.

### Import i eksport CSV

**Produkty → „Import i eksport CSV”.** **„Pobierz plik CSV”** zapisuje cały katalog (SKU, nazwa, EAN, cena brutto, VAT,
cena zakupu, waga, wymiary, próg niskiego stanu, lokalizacja, grupa wariantów, stan, opis, a na końcu rodzaj, źródło
danych i czy aktywny). Plik otworzysz w Excelu (separator „;”, polskie znaki, przecinek w liczbach).

**Import** przyjmuje ten sam układ kolumn (pierwsza linia: nagłówki; kolejność dowolna, wielkość liter i polskie znaki
w nagłówkach bez znaczenia):

- wiersz z SKU, które jest w katalogu, zmienia pola z wypełnionych komórek (te same zasady co karta produktu: pola
  z wFirmy zostają z wFirmy); wiersz z nowym SKU zakłada produkt ze stanem (wymagana nazwa; „Stan” = stan początkowy),
- pusta komórka niczego nie zmienia ani nie kasuje; ten sam plik wgrany drugi raz nic nie zmienia,
- zły wiersz (np. zły EAN, SKU drugi raz w pliku) jest pominięty i opisany w raporcie pod formularzem z numerem linii;
  reszta się zapisuje,
- plik: CSV w UTF-8 do 5 MB, najwyżej 5 000 produktów na raz; inne pliki (Excel .xlsx, HTML) są odrzucane.

Firma prowadząca stany w wFirmie zakłada nowe towary ze stanem w wFirmie; import zmienia u niej tylko pola, które
nie przychodzą z wFirmy.

### Warianty

Warianty (rozmiary, kolory) to osobne produkty z tą samą **grupą wariantów**: wpisz ten sam tekst (np. „KUBEK-2026”)
w polu **„Grupa wariantów”** na karcie każdego z nich albo w kolumnie „Grupa wariantów” w pliku CSV. Karta produktu
pokazuje wtedy sekcję **„Warianty”** z linkami do pozostałych. Każdy wariant ma własne SKU, stan i oferty. Produkty
z BaseLinkera mają grupę z BaseLinkera (pole tylko do odczytu).

Na liście **Produkty** wariant z grupy ma pod nazwą znaczek **„wariant · N w grupie”**. Kliknięcie znaczka pokazuje na
liście tylko produkty tej grupy (adres `/produkty?grupa=…`); link **„Pokaż wszystkie produkty”** nad wyszukiwarką wraca
do pełnej listy. Zakładki i wyszukiwanie działają też w obrębie grupy.

### Waga i wymiary a przesyłka

Waga (g) i wymiary (cm) z karty produktu podpowiadają paczkę: waga przesyłki to suma wag sztuk z zamówienia (towar na
wagę liczy się gramaturą), a gabaryt na stanowisku pakowania wynika z wymiarów, gdy mają je wszystkie zebrane produkty
(najmniejsza skrytka A/B/C albo Orlen S/M/L, w której z zapasem 1 cm na karton mieści się każda sztuka, towar zajmuje
najwyżej 80% miejsca, a kilka sztuk da się ułożyć w stos najcieńszym bokiem albo zajmuje najwyżej połowę skrytki).
Sztuka większa niż największa skrytka przewoźnika nie dostaje podpowiedzi: stanowisko i podgląd przesyłki pokazują
ostrzeżenie (sprawdź wymiary na karcie albo wyślij kurierem).
Gdy choć jeden produkt nie ma wagi, przesyłka bierze domyślną wagę firmy z ostrzeżeniem; gdy brakuje wymiarów, gabaryt
podpowiada liczba rzeczy w paczce. To tylko podpowiedź: gabaryt wybiera pakujący.

Waga deklarowana to sam towar: karton i wypełnienie się nie doliczają, więc przy paczkach blisko limitu wagi
przewoźnika zostaw zapas. Zestaw liczy się wagami składników; waga wpisana na karcie samego zestawu jest pomijana.

### Podpowiedź opisu (AI)

Przycisk **„Podpowiedz opis (AI)”** (formularz „Dodaj produkt” i karta produktu) prosi dostawcę AI firmy o opis
z nazwy, SKU, EAN i dotychczasowego opisu. Propozycja wpada do pola opisu, zapisujesz ją sam. Do AI nie idą dane
klientów. Bez dostawcy AI przycisk jest wyłączony z dopiskiem, gdzie go ustawić: **Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI**
(klucz API Anthropic i model); przy instalacji na własnym serwerze wystarczy też zmienna `AI_API_KEY`
([Konfiguracja](konfiguracja.md)). Zużycie zapisuje się jako funkcja „opis-produktu”.

### Zestawy

Zestaw rezerwuje składniki: na liście i karcie widać, ile zestawów da się teraz zrobić z dostępnego stanu
składników. Skład zmienisz przyciskiem **„Zmień skład”**. Nie da się go zmienić, gdy:

- zestaw przyszedł z BaseLinkera (skład zmieniasz w BaseLinkerze),
- zestaw jest w otwartym zamówieniu (rezerwacje liczone są ze starego składu; zmień po wysłaniu albo anulowaniu).

Składnikiem może być tylko towar ze stanem (bez zestawów w zestawie i bez e-booków).

## Powiązania

Powiązanie mówi Kompletorowi, który produkt sprzedaje dana oferta sklepu albo platformy: z niego idzie rezerwacja
przy zamówieniu i na nią wychodzi stan. To odpowiednik „Powiąż z produktami ze sklepu” z BaseLinkera, tylko od strony
produktu i z podglądem skutku. **Powiązanie to stan Kompletora: w sklepie ani w wFirmie nic się nie zmienia.**

Większość powiązań powstaje sama: przy „Pobierz oferty” po SKU (oferta o SKU produktu), przy imporcie z BaseLinkera
albo z karty zamówienia („Powiąż z produktem” przy pozycji bez produktu). Karta produktu → **„Powiązania”** pokazuje
wszystkie oferty produktu: konto, numer i nazwę oferty, stan powiązania (Powiązana, Propozycja do zatwierdzenia,
Wyłączona przez import, Odłączona), przelicznik (ile sztuk produktu sprzedaje jedna sztuka oferty, np. paczka 3 szt.),
ostatnio wysłany stan i źródło (po SKU, z BaseLinkera, ręcznie, reguła firmy). Zmiany wymagają uprawnienia
`produkty.dodawanie` („Dodawanie i edycja produktów”, ma je rola Biuro), tego samego co edycja karty; bez niego karta
pokazuje listę i zdanie, czyje to uprawnienie. „Pobierz oferty” i masowe łączenie na koncie kanału zostają przy
`ustawienia`: gdy listy ofert jeszcze nie ma, karta mówi, kto ją pobiera.

- **Powiąż z ofertą**: wpisz SKU, nazwę, EAN albo numer oferty (domyślnie SKU produktu), opcjonalnie wybierz konto,
  „Szukaj”. Szukamy w zapisanej liście ofert z ostatniego „Pobierz oferty” każdego konta (bez łączenia ze sklepem).
  Przy ofercie widać, z czym jest dziś powiązana. Ustaw przelicznik i **„Powiąż”**: powiązanie zapisuje się jako
  ręczne (import i kolejne pobrania go nie zmienią), a zamówienia czekające na tę ofertę („Do wyjaśnienia”) od razu
  dostają produkt i rezerwację. Oferta, która sprzedaje już inny produkt, ma przycisk wyłączony z wyjaśnieniem: przepnij
  ją z karty tamtego produktu. Nie ma listy ofert? Na koncie kanału kliknij „Pobierz oferty” (tylko odczyt ze sklepu).
  Inny przelicznik przy ofercie już powiązanej z tym produktem przelicza zamówienia przed zbieraniem (ilość z kanału ×
  nowy przelicznik, rezerwacja dobrana albo zwolniona). Odmowa z wyjaśnieniem, gdy jakieś otwarte zamówienie z tą ofertą
  jest już zbierane, spakowane, zmieniane z karty, bez wysyłki, ma dosłane sztuki albo pozycję (sprzed zapisu ilości
  z kanału), której ilość nie dzieli się przez obecny przelicznik: jego faktura liczy sztuki oferty z obecnego
  przelicznika. Wtedy zostaw przelicznik albo poczekaj, aż te zamówienia zostaną wysłane.
- **Odłącz** (z pytaniem): oferta przestaje sprzedawać ten produkt i wraca na listę „Do przypisania” konta. Zamówienia
  już przyjęte zostają z produktem i rezerwacją; kolejne z tej oferty przyjdą bez produktu („Do wyjaśnienia”). Kompletor
  przestaje wysyłać stan na tę ofertę, więc w sklepie zostaje ostatnio wysłany stan: jeśli oferta nie ma sprzedawać,
  wyłącz ją w sklepie. Odłączenia nie cofa ani import, ani „Pobierz oferty” (po pobraniu oferta dalej jest na liście
  „Do przypisania” z notatką „odłączona w panelu”); wróci tylko przez „Powiąż ponownie”.
- **Przepnij na inny produkt**: przycisk przy powiązanej ofercie otwiera wyszukiwarkę produktu (SKU, nazwa albo EAN,
  „Szukaj”). Lista pokazuje włączone produkty z nazwą, SKU, jednostką i dostępnym stanem; przy wybranym ustaw przelicznik
  (domyślnie ten z oferty, a dla produktu w innej jednostce 1 szt. albo 1000 g) i **„Przepnij na ten”**. Pytanie przed
  zapisem podaje nazwę i SKU produktu docelowego, przelicznik i liczbę zamówień, których to dotyczy. Oferta zaczyna
  sprzedawać tamten produkt. Zamówienia przed zbieraniem z tą ofertą przechodzą na nowy produkt: rezerwacja starego jest
  zwalniana, nowego zakładana (czego nie ma na stanie, trafia do „brakuje”), ilość = ilość z kanału × przelicznik. Bez
  zmian zostają zamówienia już zbierane, spakowane albo w wysyłce, zmieniane ręcznie z karty zamówienia, bez wysyłki,
  z fakturą i pozycje z dosłanymi sztukami; komunikat po przepięciu mówi, ile ich jest. Inny przelicznik niż obecny:
  ta sama odmowa co przy „Powiąż z ofertą”, gdy któreś z tych zamówień jest otwarte. W historii zamówienia zostaje wpis.
  Zamówienie przyjęte w trakcie przepinania dostaje nowy produkt w drugim przebiegu; co i tak zostanie przy starym
  produkcie, trafia do alertu „przepięcie oferty: reszta” z numerami zamówień. Przerwane przepinanie (restart) zostawia
  otwarty alert „przepięcie oferty w toku”.
- **Propozycja do zatwierdzenia** (firma z BaseLinkerem, oferta znaleziona po SKU): „Zatwierdź” albo „Odłącz”
  (odrzucenie). Zbiorczo: niżej, „Łączenie ofert z produktami”.
- **Towar w wFirmie** (tylko firma z wFirmą): produkt zwykle łączy się z towarem sam, gdy SKU = kod towaru. Gdy kod
  jest inny, wyszukaj towar (kod, nazwa, EAN) w kopii towarów z importu katalogu i **„Powiąż z towarem”**. Od tej chwili
  ceny, VAT i nazwa na fakturze są z tego towaru, a stan produktu weźmie najbliższy odczyt stanów z niego (może się
  zmienić, a z nim to, co dostępne na kanałach). SKU w Kompletorze zostaje. Odmowa, gdy towar ma już inny produkt,
  jest w innej jednostce (sztuki / kilogramy), gdy to usługa dla produktu ze stanem albo gdy produkt jest zestawem.

Każda zmiana trafia do **Historii zmian danych** produktu (oba produkty przy przepięciu) i do historii oferty.

### Łączenie ofert z produktami (masowo)

**Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → konto → sekcja **„Łączenie ofert z produktami”** (pod „Do przypisania”).
**„Podgląd: po SKU”** albo **„Podgląd: po EAN”** dzieli oferty konta bez powiązania (z ostatniego „Pobierz oferty”)
na: **połączy** (dokładnie jeden aktywny produkt o tym SKU albo EAN), **kolidują** (oferta ma zapisany inny produkt:
odłączona, wyłączona albo propozycja), **do decyzji** (kilka produktów pasuje, SKU różni się tylko wielkością liter
albo ta sama wartość jest na kilku ofertach bez powiązania) i **bez pasującego produktu** (lista z powodem przy każdej
ofercie: brak SKU i EAN w ofercie, jest SKU, ale nie ma produktu o tym SKU, albo jest EAN, ale nie ma produktu o tym EAN;
te przypiszesz ręcznie w „Do przypisania”). SKU różniące się od produktu tylko zerami na początku (oferta „1505”,
produkt „01505”) jest w „Do decyzji” z proponowanym produktem: automat go nie łączy.
W **„Do decyzji”** przy każdej ofercie są produkty, które do niej pasują (po EAN, SKU, SKU innej wielkości liter
albo bez zer na początku; najwyżej 5, przy większej liczbie ekran podaje, ile jeszcze), z nazwą, SKU i odnośnikiem
do karty. Przy właściwym klikasz **„Powiąż”** (pole obok to przelicznik: 1, a dla towaru na wagę 1000 g): to ta sama
akcja co „Powiąż z ofertą” na karcie produktu, po niej oferta znika z listy, a toast potwierdza. Kilka ofert konta
z tym samym EAN albo SKU to zwykle kilka aukcji tego samego towaru: powiąż każdą z tym samym produktem (po
powiązaniu pierwszej druga przy kolejnym podglądzie trafia do „Połączy”). Kilka produktów z tym samym EAN albo SKU:
wybierz właściwy, a na pozostałych popraw EAN albo SKU na karcie produktu. „Powiąż” widzi osoba, która ma też
uprawnienie do dodawania i edycji produktów; bez niego ekran pokazuje pasujące produkty bez przycisku. Kolizje
(oferta z zapisanym innym produktem) rozstrzygasz dalej na karcie produktu.
Oferta, której pasujący produkt czeka już w „Propozycjach do zatwierdzenia”, nie powtarza się w „Połączy”: podgląd
podaje tylko, ile ich czeka. Na koncie Allegro EAN oferty pochodzi z jej szczegółów w Allegro (opis:
[Allegro](integracje/allegro.md), „Skąd Kompletor bierze SKU i EAN oferty Allegro”). Podgląd niczego nie zapisuje.
Zaznacz oferty z „Połączy” i **„Połącz zaznaczone”**: łączy tylko te, które w chwili kliknięcia dalej są na liście
(co zmieniło się od podglądu, pomija i liczy), każdą osobno, z przeliczeniem zamówień czekających. Przelicznik 1
(towar na wagę: 1000 g); inny ustawisz potem na karcie produktu. **Propozycje do zatwierdzenia** to powiązania już
zapisane przy pobraniu ofert albo imporcie z BaseLinkera, wyłączone do czasu potwierdzenia (stan na te oferty nie
wychodzi): zaznacz i **„Zatwierdź zaznaczone”**.

## Kafle kompletności

Nad listą produktów stoi rząd kafli z brakami danych w aktywnych produktach. Każdy kafel to link: lista pokazuje wtedy tylko te produkty, a liczba na kaflu i liczba wierszy listy liczą się z tego samego zbioru. Drugie kliknięcie w zaznaczony kafel wraca do pełnej listy; wyszukiwanie zawęża dalej w obrębie kafla.

| Kafel | Kiedy produkt tu trafia | Adres |
|---|---|---|
| bez SKU albo EAN | puste SKU albo brak kodu EAN | `/produkty?filtr=bez_ean` |
| bez wagi i wymiarów | brak wagi albo któregoś z wymiarów (długość, szerokość, wysokość); towar i zestaw | `/produkty?filtr=bez_wagi` |
| bez powiązania z ofertą | żadna aktywna oferta sklepu nie jest z nim połączona | `/produkty?filtr=bez_oferty` |
| bez strefy magazynu | towar bez strefy ustawionej ręcznie i bez reguły strefy, która do niego pasuje; tylko gdy firma ma strefy (inaczej kafel prowadzi do Ustawienia → Magazyn i strefy → Strefy magazynu) | `/produkty?filtr=bez_strefy` |
| bez stanu (e-booki, usługi) | produkty bez stanu; informacja, nie brak (przycisk prowadzi do ekranu „Produkty bez stanu”) | `/produkty/bez-stanu` |
| kompletnych kart produktów | towar i zestawy bez żadnego z braków powyżej, z paskiem postępu | `/produkty` |

Produkty bez stanu i wyłączone nie wliczają się do „kompletnych”. Kafle tylko liczą; braki poprawiasz na karcie produktu.

## Zdjęcia z feedu produktowego

Sklep, który wysyła produkty do Google (Merchant Center), ma feed produktowy: plik XML z listą produktów i adresami ich
zdjęć (w WooCommerce np. z wtyczki Product Feed PRO). Kompletor czyta ten plik i daje zdjęcia produktom, które nie mają
jeszcze ani jednego. Nic nie zapisuje w sklepie.

1. **Produkty** → **„Zdjęcia z feedu”** → wpisz adres feedu (zaczyna się od `https://`, kończy zwykle na `.xml`).
   Przy adresie wybierz sklep, z którego jest feed (opcjonalnie). Możesz podać do 5 feedów, np. po jednym na sklep.
2. **„Zapisz adresy”**, potem **„Pobierz zdjęcia z feedu”**. Przebieg robi się w tle; odśwież stronę po chwili.
3. Dalej automat sam sprawdza feed raz na dobę w nocy (między 2:00 a 6:00) i daje zdjęcia nowym produktom bez zdjęcia.

Jak pozycja feedu trafia do produktu (reguły, które wskazują jeden produkt, muszą wskazać ten sam):

| Kolejność | Pole feedu | Produkt w Kompletorze |
| --- | --- | --- |
| 1 | `g:mpn` (kod producenta, we wtyczkach sklepów zwykle SKU) | SKU |
| 2 | `g:id` (tylko pozycja bez `g:mpn`) | SKU |
| 3 | `g:gtin` | EAN |
| 4 | `g:id` (także `g:item_group_id`/`g:id` wariantu) | oferta wybranego sklepu powiązana z produktem |

- Zdjęcie główne z `g:image_link`, kolejne z `g:additional_image_link` (razem najwyżej 6). Wariant ma własne pozycje
  w feedzie, więc dostaje zdjęcie swojego wariantu.
- Produkt, który ma już choć jedno zdjęcie, zostaje bez zmian (także gdy zdjęcie wgrano, zanim Kompletor do niego doszedł).
- Gdy reguły wskazują różne produkty (np. `g:mpn` pasuje do SKU jednego, a oferta sklepu jest powiązana z innym),
  kilka produktów pasuje do jednej pozycji (np. ten sam EAN) albo dwie pozycje z różnymi zdjęciami wskazują jeden
  produkt, pomijamy je jako **niejednoznaczne**. Pozycje bez dopasowania i niejednoznaczne są na liście
  **„Pobierz listę bez dopasowania (CSV)”**: po niej poprawisz SKU albo EAN w sklepie lub w Kompletorze.
- Jeden przebieg zleca najwyżej 200 produktów (reszta przy następnym), tak jak zdjęcia z ofert sklepu; zdjęcia
  dochodzą przez kilkanaście minut i zawsze przepuszczają w kolejce faktury, WZ, etykiety i maile.
- Feed z błędem (zły adres, serwer nie odpowiada, strona sklepu zamiast pliku XML, adres z przekierowaniem, plik ponad 20 MB) nie zatrzymuje pracy:
  ekran pokaże komunikat przy ostatnim przebiegu, a inne feedy firmy i tak się przeczytają.
- Firma bez feedu działa jak dotąd: zdjęcia dodaje się na karcie produktu albo przychodzą z ofert sklepu.
- Adres feedu: tylko `https`, bez adresów IP i sieci wewnętrznej; plik czytamy bez rozwijania encji XML (deklaracja
  DOCTYPE w pliku = odmowa). Każda zmiana adresów zostaje w historii zmian.

## Oferty na kanały

Z karty produktu, zakładka **„Publikacja”**, widzisz gotową ofertę na Allegro, w Empiku i w sklepie internetowym: tytuł, kategorię, parametry, opis, zdjęcia, cenę, stan i listę braków. Przycisk „Wystaw” działa tylko na koncie z włączonym wystawianiem ofert. Wiele produktów naraz sprawdzisz z listy: zaznacz je i kliknij **„Przygotuj oferty”**; raport pokaże, które są gotowe, a które mają braki. Nic nie wystawia się samo. Pełny opis: [Oferty](oferty.md).

## Produkty bez stanu

Lista SKU i kategorii sklepu (`<konto sklepu>:<id kategorii>`, np. `sklep1:117`), po jednej pozycji w wierszu. Oferta
z takim SKU albo z produktem sklepu z takiej kategorii łączy się przy imporcie z produktem bez stanu zamiast z magazynem.
Produkt bez stanu dodany ekranem „Dodaj produkt” trafia na tę listę sam.

- Lista zapisana tutaj obowiązuje zawsze, także pusta: konfiguracja startowa firmy (preset) jej już nie uzupełnia.
- SKU, które w katalogu jest produktem ze stanem albo zestawem, zostanie odrzucone z wyjaśnieniem: zmiana rodzaju
  produktu to osobna decyzja.
- Usunięcie SKU z listy nie kasuje produktu i nie zmienia jego rodzaju.
- Każda zmiana zostaje w historii zmian.

## Czego te ekrany nie robią

- nie publikują produktu na kanałach same: ofertę wystawia tylko przycisk „Wystaw” na zakładce „Publikacja”, na koncie z włączonym wystawianiem ([Oferty](oferty.md)),
- nie zmieniają rodzaju ani jednostki istniejącego produktu,
- nie łączą wariantów w jedną ofertę w sklepie (warianty to grupa produktów w Kompletorze),
- niczego nie zapisują w wFirmie (towar ze stanem w firmie z wFirmą dodaje się w wFirmie ręcznie),
- nie usuwają produktu (produkt wyłącza import albo kanał),
- nie zapisują niczego w feedzie ani w sklepie i nie wymieniają zdjęć produktom, które już je mają („Zdjęcia z feedu”;
  zdjęcie zmienia się na karcie produktu → **Zdjęcia**),
- nie robią zdjęć lifestyle (packshot tak, za wyłącznikiem, sekcja „Packshot (AI)”),
- nie zmieniają powiązań w sklepie, w BaseLinkerze ani w wFirmie: powiązanie oferty i towaru jest tylko w Kompletorze.

Stan zmienia się korektą na karcie produktu (firma bez wFirmy) albo w wFirmie; zestawy BaseLinkera zmienia się w BL.
