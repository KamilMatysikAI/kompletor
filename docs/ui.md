# Wygląd panelu i komponenty

Przewodnik dla każdego, kto dokłada albo przebudowuje ekran panelu. Krótko: **kolory i odstępy tylko
z tokenów, elementy tylko z `app/ui`, nazwy ekranów tylko z drzewa nawigacji**. Wszystko, co niżej, wynika z tych
trzech zasad.

## Dla użytkownika: gęstość widoku

W menu konta (Twoje imię w prawym górnym rogu; na telefonie kółko z inicjałami) jest przełącznik **Widok: Gęsto / Wygodnie** (jeden dla całego panelu, także pakowania).
„Gęsto” mieści więcej wierszy na ekranie (biuro), „Wygodnie” daje większe przyciski, pola i wiersze (magazyn, ekran
dotykowy). Wybór zapisuje się na koncie osoby, więc działa na każdym komputerze po zalogowaniu. Na telefonie
i tablecie przyciski mają zawsze co najmniej 44 px, niezależnie od wyboru.

## Pliki

| Co | Gdzie |
|---|---|
| Tokeny (kolor, typografia, odstępy, promienie, cienie, warstwy, gęstość) | `app/ui/tokeny.css` |
| Style komponentów (`ui-*`) | `app/ui/komponenty.css` |
| Stare klasy (`.btn`, `.card`, `.tbl`, `.chip`, `.banner`…) | `app/panel.css`: zostają do przebudowy ekranów, stare zmienne (`--ink`, `--leaf`…) są aliasami tokenów |
| Komponenty React | `app/ui/*.tsx`, import zawsze z `@/app/ui` |
| Drzewo nawigacji: menu, okruszki, grupy ustawień | `lib/panel/nawigacja.ts` |
| Statusy: etykieta + ton (zamówienie, tryb kanału, płatność) | `lib/panel/statusy.ts` |
| Słownik nazw widocznych dla użytkownika | `lib/panel/slownik.ts` |
| Sortowanie i strony tabel w adresie | `lib/panel/tabela.ts` |
| Gęstość per osoba | `lib/panel/gestosc.ts`, kolumna `User.gestosc`, akcja `zmienGestosc` w `app/akcje.ts` |

Kolejność CSS ustala `app/layout.tsx`: tokeny → `panel.css` → `komponenty.css`.

## Tokeny

Komponent mówi o roli koloru, nie o kolorze: `var(--kolor-blad)`, a nie `#a8251b` ani `var(--red-ink)`.
Nowy kod używa wyłącznie tokenów `--kolor-*`, `--tekst-*`, `--odstep-*`, `--promien*`, `--cien-*`, `--z-*`.

Tony stanów (każdy ma trzy tokeny: tekst, `-tlo`, `-linia`): `sukces`, `ostrzezenie`, `blad`, `info`, `uwaga`
(do wyjaśnienia), `neutralny`. Dodatkowo `akcent` jako ton odznaki = pełna zieleń z białym tekstem (zamówienie
zakończone); to nie jest złoty akcent marki, patrz „Kolor i marka”.

Gęstość: atrybut `data-gestosc="gesto|wygodnie"` na `.shell` przełącza `--wys-kontrolki`, `--wys-kontrolki-sm`,
`--wys-wiersza`, `--pad-komorki-y/x`, `--tekst-bazowy` i `--wys-celu`. Element, który ma się zmieniać z gęstością,
bierze wysokość z tych tokenów zamiast z liczby. Selektor `[data-gestosc='wygodnie'] .moja-klasa` jest dozwolony,
gdy sam token nie wystarcza.

Mocny cień (`--cien-2`) tylko dla warstw nad treścią (menu rozwijane, modal, toast, pasek zapisu ze zmianami).
Karty mają ramkę i ledwo widoczny `--cien-1`; hierarchię dalej robi odstęp i nagłówek.

### Kolor i marka

- **Złoto (`--kolor-akcent`, #f5b700) to marka i „tu jesteś / to kliknij”**: przycisk główny, aktywna pozycja menu,
  aktywna zakładka, postęp, słupki wykresów, znak „K”. Na złocie tekst jest zawsze atramentowy
  (`--kolor-na-akcencie`), nigdy biały. Złoty tekst na jasnym tle to `--kolor-akcent-tekst` (ciemny bursztyn),
  a ramka zaznaczenia to `--kolor-akcent-linia` razem z tłem `--kolor-akcent-tlo` (sama złota ramka na bieli to za
  mało kontrastu).
- **Zieleń znaczy wyłącznie „zrobione / dobrze”** (`--kolor-sukces*`, `--kolor-sukces-pelny`): spakowane, wysłane,
  krok zrobiony, przełącznik włączony. Stare aliasy `--leaf*` w `panel.css` wskazują na zieleń sukcesu, więc ekran
  pakowania i stanowisko wyglądają jak przed zmianą.
- **Ostrzeżenie jest pomarańczowe**, żeby nie mylić go ze złotem marki. Czerwony zostaje dla błędu i braku.
- **Linki** mają `--kolor-link` (granat), nie kolor akcentu.
- Wiersz tabeli pod kursorem ma cień złota (`--kolor-powierzchnia-hover`).
- Liczby (liczniki, kwoty, kafle raportów) składamy krojem treści albo nagłówka z cyframi tabelarycznymi. Krój
  maszynowy zostaje dla kodów: numer zamówienia z kanału, SKU, EAN, lokalizacja, numer nadania.
- Wykres: seria w złocie, jeden wyróżniony słupek (dziś) w atramencie.

### Kontrast (WCAG AA, tekst ≥ 4,5:1)

Wyliczone skryptem z wartości w `tokeny.css` (10.11.2026).

| Para | Kontrast |
|---|---|
| tekst / tło | 15,1 |
| tekst-2 / tło | 7,3 |
| tekst-3 / powierzchnia, / tło | 5,9 / 5,4 |
| atrament na złocie (przycisk główny), na złocie pod kursorem | 9,2 / 7,7 |
| akcent-tekst na akcent-tle, na bieli | 6,6 / 7,4 |
| link na bieli, na tle | 8,3 / 7,6 |
| sukces, ostrzeżenie, błąd, info, uwaga, neutralny (tekst na swoim tle) | 6,4 · 5,9 · 6,0 · 7,1 · 7,0 · 6,9 |
| biały na pełnej zieleni (odznaka „akcent”, znak „zrobione”) | 6,0 |
| tekst-2 menu na białym menu | 5,9 |
| tekst aktywnej pozycji menu na złotym tle | 15,0 |
| tekst, tekst-2 na wierszu pod kursorem | 15,6 / 7,6 |
| kropka statusu w menu (grafika, próg 3:1): pomarańcz, szara | 3,8 · 3,8 |
| tekst-2 pod kartą logowania i toast (ciemne tło `--kolor-ciemny`) | 8,5 |

Nowy kolor tekstu dopisujesz do tej tabeli z wyliczonym kontrastem.

### Motyw: jasny, ciemny, jak system

Dla użytkownika: w menu konta (Twoje imię w prawym górnym rogu) jest przełącznik **Motyw: Jasny / Ciemny / Jak system**.
„Jak system” bierze wygląd z ustawień komputera albo telefonu. Wybór zapisuje się w przeglądarce (ciasteczko
`kompletor_motyw`, rok), więc każde urządzenie ma swój; bez wyboru panel jest jasny.

Dla programisty: `<html data-motyw="jasny|ciemny|auto">` ustawia `app/layout.tsx` z ciasteczka (`lib/panel/motyw.ts`),
więc strona przychodzi z serwera od razu we właściwym motywie. Ciemne wartości tokenów są w `tokeny.css` w dwóch
blokach o tej samej treści (`[data-motyw='ciemny']` i `[data-motyw='auto']` w `prefers-color-scheme: dark`): zmiana
w jednym = zmiana w drugim. Zasady:

- Kolor zawsze z tokenu. Surowy `#fff` jako tło albo `var(--kolor-tekst)` jako tło w ciemnym motywie daje jasną plamę
  z jasnym tekstem. Ciemne tło z białym tekstem (pasek akcji, wciśnięty przełącznik, toast) to `--kolor-ciemny`.
- Tekst na złocie i na zawsze jasnych tłach (paski kreskowane, białe przyciski na czerwonym komunikacie) to
  `--kolor-na-akcencie`: ten token nie zmienia się z motywem.
- Zdjęcia produktów i loga integracji zostają na białym tle w obu motywach. Kolory statusów własnych firmy
  (`lib/panel/statusy.ts`) są jasnymi pigułkami w obu motywach.
- Wydruki, maile i podgląd dokumentu (`.paper`) są zawsze jasne.

Kontrast w ciemnym motywie (skrypt, 10.11.2026): tekst / tło 16,2; tekst-2 i tekst-3 na powierzchni 8,7 i 6,1;
atrament na złocie 9,2; akcent-tekst na akcent-tle 9,3; link 8,7; tony stanów na swoim tle 7,3–8,5; tekst-2 menu 6,4;
aktywna pozycja menu 10,4; biały na `--kolor-ciemny` 11,3; złoto jako grafika na powierzchni 9,2.

## Komponenty

Wszystkie z `@/app/ui`. Komponenty bez stanu działają w komponentach serwerowych; kliencie mają `'use client'`
w swoim pliku.

| Komponent | Kiedy | Uwagi |
|---|---|---|
| `Przycisk`, `PrzyciskLink` | każdy przycisk i link wyglądający jak przycisk | `wariant`: `glowny` (najwyżej jeden na sekcję), `drugorzedny`, `cichy`, `niebezpieczny`; `rozmiar`: `sm/md/lg/xl`; `ladowanie`; `powodWylaczenia` = przycisk widoczny, nieaktywny, z powodem (zasada fal: funkcja za wyłącznikiem nie znika) |
| `Odznaka` | krótki stan, etykieta | `ton`, `kropka`, `rozmiar="sm"` |
| `StatusZamowienia` | status zamówienia **wszędzie** | `status`, opcjonalnie `przewoznik`; nigdy własne klasy `.pill`/`.st`/`.chip` dla statusu |
| `TrybKanalu` | tryb konta kanału | „Tylko podgląd / Aktywny / Wyłączony”, nigdy „cień/praca” |
| `StanPlatnosci` | płatność zamówienia | |
| `NaglowekStrony` | nagłówek ekranu | `tytul`, `podtytul` (jedna linia; instrukcje do Pomocy albo `pomoc` pola), `akcje` |
| `Karta` | sekcja ekranu | `tytul`, `opis`, `akcje`, `stopka`, `zwijana` (`<details>`), `naglowekPoziom` |
| `Baner` | stan trwały (konto wyłączone, dane fikcyjne, błąd do poprawy) | **nie** dla wyniku akcji: od tego jest toast |
| `PustyStan` | lista bez pozycji | tytuł, jedno zdanie, jedna akcja („Dodaj sklep”), nie „Brak danych” |
| `ListaOpisowa` | pary etykieta–wartość | `kolumny={2}` na szerokim ekranie |
| `Ladowanie`, `Szkielet` | sekcja ładowana w tle, `loading.tsx` | przycisk ma własne `ladowanie` |
| `Zakladki` | zakładki-linki z licznikami | na telefonie przewijane z cieniem krawędzi |
| `Pole`, `PoleTekstowe`, `PoleLiczbowe`, `PoleWielowierszowe`, `Wybor`, `Przelacznik`, `PoleHasla` | pola formularzy | etykieta nad polem, `pomoc` pod polem, `blad` pod polem (aria-describedby, aria-invalid), `opcjonalne`; `PoleLiczbowe` ma `jednostka` w polu; własna kontrolka w `Pole` dostaje `{...atrybutyPola(p)}` |
| `Zaawansowane` | pola rzadko zmieniane | domyślnie zwinięte; w widoku domyślnym formularza najwyżej kilka pól |
| `PasekZapisu` | **jeden** zapis na formularz | wstaw na końcu `<form>`; bez zmian stoi na końcu formularza, po zmianie przykleja się do dołu ekranu (pole z fokusem nie chowa się pod nim: `scroll-padding-bottom`) i jest aktywny, „Anuluj” przywraca, ostrzeżenie przy wyjściu ze strony; przy `useActionState` podaj `oczekuje={pending}`. `ukryjBezZmian` (karta zamówienia): bez zmian paska nie ma wcale, pojawia się po pierwszej zmianie i znika po zapisie albo „Anuluj”; podpowiedź „co zmienić” daj wtedy w treści sekcji, bo `opis` paska się nie pokaże. Ostrzeżenie działa tylko przy odświeżeniu i zamknięciu karty (`beforeunload`), **nie** przy kliknięciu w menu (nawigacja kliencka Next) |
| `ToastZAdresuZapisu` | wynik akcji z przekierowaniem `?zapisano=<klucz>` / `?blad=<tekst>` |: toast zamiast banera „Zapisano.”, parametry znikają z adresu (`history.replaceState`); `komunikaty={{ '1': '…' }}` |
| `ToastProvider`, `useToast`, `ToastPoAkcji` | wynik akcji | provider jest w layoucie panelu; `ToastPoAkcji stan={state}` przy `useActionState` (`ok`, `komunikat`/`message`/`error`); `bledy={false}`, gdy błąd jest już przy polach |
| `Modal`, `Potwierdzenie`, `PrzyciskPotwierdz` | okno, pytanie przed nieodwracalnym | zamiast `window.confirm`; `PrzyciskPotwierdz` w formularzu wysyła go po „Tak” (`requestSubmit`), `pomin` = bez pytania. **Przycisk z pytaniem ma być pierwszym submitem w `<form>`**: Enter w polu formularza klika pierwszy submit, więc inny submit przed nim pozwala ominąć pytanie. Po otwarciu okna fokus dostaje element z `data-fokus` (nie `autoFocus`): w `Potwierdzenie` „Tak”, przy `wariant="niebezpieczny"` „Anuluj”, żeby Enter niczego nie skasował |
| `Tabela`, `Paginacja` | lista danych | patrz niżej |
| `ZaznaczoneUkryte`, `useZaznaczenie` | akcje masowe tabeli | `<ZaznaczoneUkryte />` w formularzu akcji masowej daje pola `zaznaczone` |
| `PasekFiltrow` | wyszukiwarka i filtry listy | formularz GET, filtry działają od razu po zmianie, wyszukiwarka po Enter; na ≤ 900 px reszta filtrów pod „Filtry (n)”; z `zwijane` tak samo na każdej szerokości (domyślnie zwinięte, stan w przeglądarce per lista) |
| `KlikalneWiersze` | cały wiersz otwiera kartę | wiersz z `data-href`; Ctrl/⌘ = nowa karta |
| okruszki | brak | rysuje je górny pasek panelu (`pasek-gorny.tsx`) z drzewa nawigacji; ekran **nie** wstawia własnych „← Wstecz” |
| `MenuAkcji`, `GrupaMenu`, `RozwinWMenu` | menu akcji z przycisku („Więcej”) | na `<details>`: działa bez JavaScriptu i przyjmuje formularze akcji serwera jako dzieci; z JavaScriptem zamyka się kliknięciem obok, Esc (fokus wraca na przycisk) i po wybraniu pozycji. Pozycja = `Przycisk`/`PrzyciskLink` z `className={POZYCJA_MENU}` (44 px, pełna szerokość), link spoza `app/ui` przez `klasyPrzycisku('cichy', 'md', POZYCJA_MENU)`. Pozycja otwierająca okno (`PrzyciskPotwierdz`) dostaje `data-zostaw-menu`. `RozwinWMenu` = formularz z polami w menu (np. „Zmień status…”). Na ≤ 760 px menu rozwija się w treści. Stała `POZYCJA_MENU` jest w `przycisk.tsx`, nie w pliku z `'use client'` (komponent serwerowy dostałby odwołanie do klienta zamiast tekstu) |
| `WyborJednej` | jedna z kilku opcji (radio) | legenda, opcje jedna pod drugą po 44 px, `opis` pod etykietą opcji |
| klasy `ui-akcje-lista`, `ui-akcja`, `ui-akcja-powod` | rząd przycisków akcji z powodem niedostępności | przycisk nieaktywny = `Przycisk powodWylaczenia`, powód widoczny pod nim w `p.ui-akcja-powod`; w menu lista układa się w kolumnę |

### Tabela

`Tabela` jest komponentem serwerowym i nie sortuje danych sama. Ekran czyta stan z adresu i pyta bazę:

```tsx
const sp = await searchParams
const sort = sortZ(sp, ['data', 'kwota'], { klucz: 'data', kierunek: 'malejaco' })
const { strona, ile, pomin } = stronaZ(sp)
const [wiersze, razem] = await Promise.all([lista(ctx.db, { sort, pomin, ile }), licz(ctx.db)])

<Tabela
  id="zamowienia"                       // stały: pod nim zapisuje się wybór kolumn
  etykieta="Zamówienia"
  kolumny={[{ klucz: 'nr', etykieta: 'Numer', sortowalna: true }, { klucz: 'kwota', etykieta: 'Kwota', wyrownanie: 'prawo', ukrywalna: true }]}
  wiersze={wiersze.map((z) => ({ id: z.id, href: `/zamowienia/${z.id}`, etykieta: z.number, komorki: { nr: z.number, kwota: money(z.total) } }))}
  adres={{ sciezka: '/zamowienia', parametry: sp }}
  sort={sort}
  zaznaczanie
  akcjeMasowe={<form action={zmienStatus}><ZaznaczoneUkryte /><Przycisk type="submit">Zmień status</Przycisk></form>}
  paginacja={{ strona, ile, razem }}
  pustyStan={<PustyStan tytul="Nie ma zamówień" akcja={<PrzyciskLink href="/ustawienia/kanaly/nowy">Dodaj sklep</PrzyciskLink>}>Zamówienia pojawią się po podłączeniu sklepu.</PustyStan>}
/>
```

Wybór kolumn domyślnie zapisuje się w przeglądarce. Z `kolumnyOsoby={{ ukryte: ukryteKolumny(ctx.kolumnyTabel, '<id>'), zapisz: zapiszKolumny }}`
(`lib/panel/kolumny.ts`, akcja w `app/akcje.ts`) zapisuje się na koncie osoby (`User.kolumnyTabel`) i działa na każdym
komputerze (lista zamówień). `narzedzia` to elementy paska nad tabelą (np. eksport); z `narzedziaWMenu` na
≤ 760 px pasek zwija się pod jeden przycisk „Więcej” (`MenuWiecej`), na szerokim ekranie stoi jak dotąd.

Komórki to gotowe węzły (`ReactNode`), nie funkcje: komponent serwerowy nie może przekazać funkcji wyspie
klienckiej. Na telefonie tabela zamienia się w karty z etykietą kolumny przy wartości (`data-label`).

Tabela pisana ręcznie (np. lista produktów) bierze te same klocki nagłówka: `NaglowekSortu` (`<th>` z
`aria-sort`, linkiem i strzałką ▲/▼/↕, jak w `Tabela`) i `SortNaTelefonie` (te same linki jako przyciski nad listą, widoczne
tylko ≤ 760 px, bo karty chowają wiersz nagłówków). Adres linku liczy ekran, bo zna swoje parametry filtrów.

## Nawigacja

Każdy ekran ma węzeł w `NAWIGACJA` (`lib/panel/nawigacja.ts`). Test `nawigacja.test.ts` sprawdza, że każdy
`page.tsx` panelu ma swój węzeł, więc nowy ekran bez wpisu w drzewie nie przejdzie testów.

- Ekran codziennej pracy: węzeł w grupie menu (`zamowienia` „Realizacja”, `magazyn` „Towar”, `finanse` „Finanse”; układ) z `ikona` (klucz z `ikony-menu.tsx`). Nazwy grup w słowniku.
- Ekran pomocniczy (ustawienie, dodawanie): węzeł-dziecko istniejącej sekcji; `bezMenu: true`, gdy ma być tylko
  w okruszkach (np. „Dodaj produkt” otwierany przyciskiem). Zasada: nowa pozycja w menu tylko dla samodzielnego
  modułu codziennej pracy.
- Ekran ustawień: dziecko „Ustawienia” z `grupa` (Sprzedaż, Magazyn, Firma, Integracje, Konto). Z tych grup
  zbuduje się lista ustawień.
- Ekran dla firm przechodzących z BaseLinkera: sekcja `bl` z `tylkoZBl: true`: firma bez BaseLinkera go nie widzi.
- `uprawnienie` w węźle chowa pozycję w menu; ekran i tak sprawdza uprawnienie sam (`requirePermission`).

Okruszki powstają z drzewa: przodkowie węzła, a dla adresu głębiej niż węzeł (karta zamówienia, konto kanału) także
sam węzeł. Okruszki stoją w górnym pasku każdego ekranu (`_komponenty/pasek-gorny.tsx`, `okruszkiPaska`): przodkowie jako linki i nazwa bieżącego ekranu na końcu; na karcie rekordu ostatni okruszek to link powrotu (nazwę rekordu niesie `h1`). Na telefonie pasek pokazuje tylko ostatni okruszek.

### Rama panelu

- Menu boczne białe (`--kolor-menu-*`), u góry znak marki z linkiem na pulpit, grupy z nagłówkiem zwykłą pisownią w rytmie dnia: Realizacja (Zamówienia, Pakowanie, Przesyłki, Zwroty i reklamacje), Towar (Produkty, Braki towaru), Finanse (Faktury, Raporty); na dole Ustawienia i Pomoc. Ikony 18 px, aktywna pozycja jako złota etykieta z paskiem po lewej. Liczniki szare; ton ostrzeżenia tylko „Wymaga działania”, czerwony zarezerwowany dla rzeczy po terminie.
- Statusy zamówień: węzeł „Zamówienia” ma `podmenu: 'statusy'`; pozycje buduje `lib/panel/menu-statusy.ts` z `licznikiPanelu` (te same liczniki co dawny panel listy). Kropka: ton etapu statusu; pole `kolor` to punkt podpięcia statusów własnych firmy.
- Górny pasek: okruszki, zębatka „Ustawienia”, menu konta (firma i przełączanie, „Widok: Gęsto / Wygodnie”, „Motyw: Jasny / Ciemny / Jak system”, „Zmiana hasła”, „Pomoc”, „Wyloguj”). Na dół menu bocznego wróciła tylko „Pomoc”, reszta zostaje w menu konta.
- Ciemne tło dawnego menu zostało pod nazwą `--kolor-ciemny` (toast, ekran logowania).

## Język

Nazwy widoczne dla użytkownika bierzesz ze słownika (`lib/panel/slownik.ts`). Nie piszemy w panelu: „cień”,
„praca” (jako tryb), „na sucho”, „naprawdę”, „rozjazdy”, „worker”, nazw zmiennych środowiska, poleceń `npm run`,
ścieżek repozytorium ani numerów zadań `LOG-A-*`. Te słowa zostają w kodzie, enumach i dokumentacji
administratora. Test `nawigacja.test.ts` pilnuje menu i okruszków; pełny przegląd tekstów ekranów to paczka.

## Czego nie robić

- Nie składaj przycisku, odznaki ani pola z klas ręcznie, gdy jest komponent (`<button className="btn primary">`
  w nowym kodzie = do poprawy w przeglądzie).
- Nie dodawaj `style={{…}}` z kolorem albo odstępem: brakuje tokenu albo wariantu komponentu: dopisz go.
- Nie pokazuj statusu zamówienia inaczej niż `StatusZamowienia`.
- Nie dawaj kilku „Zapisz” w jednym formularzu; jeden `PasekZapisu`.
- Nie używaj `window.confirm` ani `alert`: `PrzyciskPotwierdz` / `Potwierdzenie`, wynik przez toast.
- Nie wstawiaj okruszków ani „← Wstecz” na ekranie; popraw drzewo nawigacji.
- Nie dodawaj wersalików z rozstrzelonymi literami nad nagłówkami i w nagłówkach tabel; etykieta zdaniem.
- Nie zmieniaj tokenu, żeby poprawić jeden ekran: dodaj klasę albo wariant.

## Stan przepięcia

Przepięte: statusy zamówień (lista, pakowanie, karta: nagłówek i informacje), tryb kanału (pulpit, kanały,
porównanie z BL, maile do klientów), wszystkie potwierdzenia (`window.confirm` → `PrzyciskPotwierdz`), zmiana
hasła (pola, toast), gęstość w pakowaniu (jeden przełącznik, w menu), okruszki wszystkich ekranów, nagłówki wg słownika.
Lista zamówień stoi na `Tabela` i `PasekFiltrow`, style ekranu w `app/(panel)/zamowienia/_lista/lista.css` (tylko tokeny). Reszta ekranów działa na starych klasach do swoich paczek.

**Karta zamówienia:** sekcje na `Karta`/`card ui-karta`, odznaki `Odznaka`/`StatusZamowienia`/
`StanPlatnosci`, pola z `app/ui`, jeden `PasekZapisu` na sekcję (Pozycje: ilości, usunięcie i decyzje o brakach;
dane klienta zamówienia ręcznego; poprawka notatki), wynik akcji serwera jako toast (`toast-z-adresu.tsx` czyta
`?ok=<klucz>`/`?info=<klucz>`/`?blad=<kod>` z przekierowania, klucze i kody w `lib/karta/komunikaty.ts`; treść błędu z zapisu
przychodzi z krótkotrwałego ciasteczka httpOnly `kz_szczegoly`, które ustawia akcja przez `naKarte` z `lib/karta/komunikaty-serwer.ts`
i czyści adres przez
`history.replaceState`, nie `router.replace`, który pobrałby kartę drugi raz), usunięcie pozycji przez `Potwierdzenie`
(`potwierdz-usuniecie.tsx`), stany trwałe jako `Baner`. Style karty w
`app/(panel)/zamowienia/[id]/karta.css` (tylko tokeny). Także menu „Więcej” (`MenuAkcji`), przyciski
„Co dalej” (`praca.tsx`: `ui-akcje-lista`, `PrzyciskPotwierdz` zamiast rozwijanego pytania) i blok nadania przesyłki
(`_komponenty/nadanie-przesylki.tsx`, wspólny ze stanowiskiem: `Przycisk`, `Odznaka`, `ListaOpisowa`, `Baner`,
`Zaawansowane`, `WyborJednej`, `Przelacznik`) są na komponentach; klasy `kz-menu*`, `kz-wiecej` i `cd-*` zniknęły z
`panel.css`. Na starych klasach zostały formularze „Dodaj pozycję”, „Podziel zamówienie” i „Powiąż z produktem”
(`kz-zmien`, `kz-dodaj` w `<details>`) oraz wybór stanowiska druku (`_komponenty/druk.tsx`).
