# Przeprowadzka z BaseLinkera do Kompletora

Ta instrukcja jest dla sprzedawcy, który dziś pracuje w BaseLinkerze (BL) i chce mieć swoje dane w Kompletorze.
Nie trzeba znać się na programowaniu: wystarczy przepisać kilka poleceń. Jeśli Kompletor stawia Ci ktoś inny
(hosting), te polecenia wykonuje on, a Ty dostajesz raport do przeczytania.

## Co przenosimy, a czego nie

**Przenosimy** (jednym poleceniem):

- produkty z katalogu BL (z wariantami i zestawami) i ich stany magazynowe na start,
- oferty w sklepach, na Allegro i w innych kanałach oraz ich powiązania z produktami,
- konta kanałów sprzedaży (sklepy, Allegro, Empik i inne źródła zamówień),
- reguły przewoźników (która metoda dostawy to który kurier),
- statusy zamówień jako statusy firmy: nazwa, kolor (najbliższy z palety Kompletora), nazwa dla klienta i grupa;
  etap pracy każdego statusu dobiera Kompletor, a niepewne potwierdzasz w „Decyzjach” (niżej),
- otwarte zamówienia (te, które jeszcze nie wyszły z magazynu).

**Nie przenosimy:** historii zamówień, danych klientów (imion, adresów, e-maili, telefonów, danych do faktur,
komentarzy: także z otwartych zamówień), automatycznych akcji BL (API ich nie udostępnia; zamiast nich przychodzą
wyłączone reguły najbliższego szablonu, niżej), szablonów maili i wydruków, zwrotów, list wysłanych paczek, faktur
i paragonów.

**Najważniejsze:** w BaseLinkerze nic się nie zmienia. Kompletor tylko czyta z BL (i to tylko z wąskiej listy
odczytów). BL zostaje Twoim głównym systemem aż do chwili, w której świadomie przełączysz dany kanał. Do tego czasu
Kompletor stoi obok „w cieniu”: widzi to samo co BL, liczy stany i rezerwacje, ale niczego nie wysyła do sklepów,
na Allegro ani do kurierów.

## Statusy i automatyczne akcje

Co daje API BaseLinkera (sprawdzone w dokumentacji 09.11.2026, odczyt tylko na nagranych odpowiedziach w testach):

| Metoda | Co zwraca | Dokumentacja |
| --- | --- | --- |
| `getOrderStatusList` | statusy: `id`, `name`, `color` (hex), `group_id`, `is_primary`, `name_for_customer` | https://api.baselinker.com/index.php?method=getOrderStatusList |
| `getOrderStatusGroups` | grupy: `group_id`, `name`, `is_main_group` (status wskazuje grupę polem `group_id`) | https://api.baselinker.com/index.php?method=getOrderStatusGroups |
| automatyczne akcje | **brak metody odczytu**; są tylko `runOrderMacroTrigger`, `runOrderReturnMacroTrigger`, `runProductMacroTrigger` (uruchomienie własnego wyzwalacza, zapis, poza listą przeprowadzki) | https://api.baselinker.com/ |

Jak to przechodzi do Kompletora:

1. Każdy status BL staje się statusem firmy z kluczem `BL_<id>`: nazwa, kolor (hex BL → najbliższy kolor palety),
   nazwa dla klienta i grupa (grupa główna BL „Brak grupy” = status bez grupy, inne grupy jako `BL_G<id>`).
2. Etap pracy (Nowe, Do realizacji, Zbieranie, Spakowane, Do wysłania, Wysłane, Anulowane…) Kompletor dobiera po
   nazwie statusu, a gdy nazwa nic nie mówi, po nazwie grupy. Takie statusy raport oznacza **do potwierdzenia**:
   etap wybierasz w sekcji „Decyzje” przed importem (status do potwierdzenia z otwartymi zamówieniami blokuje import).
3. Statusy domyślne firmy, których nikt nie zmieniał, a których etap ma status z BL, zostają ukryte, żeby lista
   zamówień pokazywała nazwy z BL. Firma z własnymi statusami nic nie traci: statusy z BL dochodzą na koniec listy.
4. Mapa „status BL → status firmy” zapisuje się w ustawieniach firmy (`settings.baselinker.statusy[<id>].klucz`)
   obok etapu: korzysta z niej porównanie z BL i kopia statusów.
5. Automaty: Kompletor dobiera najbliższy szablon (bez etapów wysyłki: „Minimalny, bez wysyłki”; tylko odbiór:
   „Odbiór osobisty”; tylko Allegro: „Allegro z Wysyłam z Allegro”; inaczej „Kurier i paczkomaty”) i zakłada jego
   reguły w grupie **„Z BaseLinkera”**, **wyłączone**. Raport pokazuje, które reguły przejdą, a które nie i dlaczego.
6. Drugi import niczego nie dubluje: statusy i grupy z tym samym kluczem zostają (także zmienione potem w panelu),
   a grupa „Z BaseLinkera”, która już jest, nie dostaje nowych reguł.

## Z panelu

To samo bez terminala robi ekran **Ustawienia → Przejście z BaseLinkera → Przeprowadzka** (`/ustawienia/przeprowadzka`), opis: [Migracja z BaseLinkera](migracja-z-baselinkera.md), sekcja „Przeprowadzka z panelu”. Dalej: polecenia na serwerze (dla administratora).

## Krok 1. Weź token API z BaseLinkera

Token to długi ciąg znaków, który pozwala Kompletorowi czytać Twoje dane z BL.

1. Zaloguj się do BaseLinkera.
2. Wejdź w **Moje konto → API** [do potwierdzenia: dokładna nazwa i miejsce w menu BL].
3. Wygeneruj token (albo skopiuj istniejący) i zapisz go na chwilę w bezpiecznym miejscu.

Token traktuj jak hasło: nie wysyłaj go mailem, nie wklejaj na czacie.

## Krok 2. Zapisz token w Kompletorze

Na serwerze Kompletora, w katalogu programu (`<twoja-firma>` to krótka nazwa firmy w Kompletorze; listę pokaże
`npm run org:list`):

```
npm run sekret -- --firma <twoja-firma> --ustaw BASELINKER_TOKEN --ze-stdin
```

Polecenie poczeka, aż wkleisz token i naciśniesz Enter, a potem Ctrl+D (Windows: Ctrl+Z i Enter). Token zostaje
zaszyfrowany w bazie Kompletora; nie pojawia się w żadnym logu.

Masz wFirmę? Zapisz też jej klucze (`WFIRMA_ACCESS_KEY`, `WFIRMA_SECRET_KEY`, `WFIRMA_APP_KEY`, `WFIRMA_COMPANY_ID`)
tym samym poleceniem: wtedy stany startowe weźmiemy z magazynu wFirmy. Bez wFirmy bierzemy je z magazynu BL.

## Krok 3. Tryb próbny (nic się nie zapisuje)

```
npm run przeprowadzka -- --firma <twoja-firma>
```

Kompletor czyta BL, układa plan i pisze **raport** na dysk. W bazie Kompletora nic się nie zmienia. Na końcu
polecenie wypisze, gdzie leży raport (plik `raport-przeprowadzki.md`, obok niego to samo w JSON). Własny katalog na
raport: `--raport <katalog>` (poza katalogiem programu).

Masz w BL kilka katalogów produktów? Polecenie poprosi o wybór: dodaj `--katalog <numer>` (numery są w raporcie).

## Krok 4. Przeczytaj raport

Raport ma pięć części:

1. **Co przejdzie**: ile kont, produktów, zestawów, stanów, ofert, reguł i otwartych zamówień trafi do Kompletora.
2. **Co wymaga Twojej decyzji**: tu jest praca dla Ciebie:
   - **statusy BL**, których nazwa nic nam nie mówi (np. Twój własny status „Czeka na grawer”). Taki status nigdy nie
     jest uznawany za „zakończony”: na razie zamówienie trafia do „Do wyjaśnienia”. Dopóki taki status ma otwarte
     zamówienia, zapis jest zablokowany;
   - **metody dostawy**, przy których nie wiemy na pewno, jaki to kurier (np. „Kurier” bez nazwy firmy, „Poczta Polska”);
   - **źródła zamówień**, dla których Kompletor nie ma jeszcze własnej obsługi (np. TikTok): zamówienia przejdą, ale
     kanał dalej obsługuje BL;
   - **oferty bez powiązania** z produktem i **produkty bez SKU** albo z powtórzonym SKU: nie sklejamy ich po samej
     nazwie, żeby nie pomylić towarów. Najprościej poprawić SKU w BL i uruchomić tryb próbny jeszcze raz;
   - **zestawy**, których składników nie znamy, i **zamówienia do wyjaśnienia**.
3. **Czego nie przenosimy**: lista jak wyżej.
4. **Co dalej**: co zrobić po zapisie (klucze sklepów, Allegro, kurierów).
5. **Tabela zgodności**: ile produktów, ofert i otwartych zamówień jest w BL, a ile w planie. Różnice są opisane.

## Krok 5. Wpisz decyzje w pliku mapy

Utwórz plik `mapa.json` (np. w Notatniku) według przykładu z raportu. Plik zawiera tylko numery statusów BL, nazwy
metod dostawy i źródeł: żadnych danych klientów.

```json
{
  "statusy": { "12345": "DO_REALIZACJI", "12346": "ANULOWANE" },
  "przewoznicy": { "Poczta Polska": "BRAK", "Kurier": "DPD" },
  "zrodla": { "tiktok:5": "POMIN" }
}
```

- **statusy**: numer statusu BL → status w Kompletorze: `NOWE`, `DO_REALIZACJI`, `ZBIERANIE`, `ZEBRANE`,
  `SPAKOWANE`, `DO_WYSLANIA`, `DO_ODBIORU`, `WYSLANE`, `ODEBRANE`, `ANULOWANE`, `DO_WYJASNIENIA`, `REKLAMACJA`.
  Zamówienia w statusach `WYSLANE`, `ODEBRANE`, `ANULOWANE` i `REKLAMACJA` uznajemy za zakończone i ich nie przenosimy.
- **przewoznicy**: nazwa metody dostawy (tak jak w raporcie) → `PACZKOMATY`, `DPD`, `DPD_EMPIK`, `ALLEGRO`,
  `OSOBISTY` albo `BRAK` (nieznany: zamówienie trafi do „Do wyjaśnienia”).
- **zrodla**: źródło zamówień, którego nie chcesz przenosić → `POMIN`.

Potem tryb próbny jeszcze raz, z mapą:

```
npm run przeprowadzka -- --firma <twoja-firma> --mapa mapa.json
```

Powtarzaj, aż w raporcie zniknie sekcja „Zapis zostałby teraz odrzucony”.

## Krok 6. Zapis

```
npm run przeprowadzka -- --firma <twoja-firma> --mapa mapa.json --zapisz
```

Zapis idzie wyłącznie do bazy Kompletora, po kolei: konfiguracja → produkty i stany → oferty → reguły przewoźników
→ otwarte zamówienia. Wszystkie konta kanałów powstają w trybie **cienia**.

- **Można powtórzyć.** Drugi zapis niczego nie dubluje: zamówienia już przeniesione zostają, produkty i oferty się
  aktualizują. Gdy zapis przerwie się w połowie (np. brak prądu), po prostu uruchom go jeszcze raz.
- **Stany, które już są w Kompletorze, zostają.** Jeśli stan w BL jest inny, raport pokazuje różnicę: decyzja należy
  do Ciebie (np. inwentaryzacja w panelu).
- **Firma bez wFirmy:** stan startowy z magazynu BL zapisuje się w tych samych polach co odczyt wFirmy, więc na ekranie
  produktu w polu „wFirma” zobaczysz stan startowy z BL i datę przeprowadzki. To nie jest odczyt z wFirmy.
- **Decyzja dopisana w mapie po zapisie** (np. przewoźnik dla metody, która była „do decyzji”) wchodzi przy kolejnym
  `--zapisz`: reguły przewoźników zapisane przez przeprowadzkę są zastępowane nowym planem. Reguły zmienione ręcznie
  w panelu zostają, raport to mówi. Zamówienia już przeniesione nie zmieniają przewoźnika ani statusu (tryb próbny
  pokazuje je jako „DUPLIKAT” ze statusem z Kompletora).
- **Zapis odmawia, gdy nie wszystkie otwarte zamówienia udało się pobrać** (limit stron albo błąd BL): zbierz dane od
  nowa. Obcięte okno „ostatnich zamówień” (używane tylko do rozpoznania metod dostawy) zapisu nie blokuje.
- **Firma, która już pracuje w Kompletorze** (ma zamówienia z własnych kanałów albo kanał przełączony z cienia na
  pracę), nie może dostać zapisu przeprowadzki: polecenie odmówi z wyjaśnieniem. Tryb próbny działa zawsze.

Wynik ostatniego zapisu i sprawy do decyzji zobaczysz w panelu: **Ustawienia → Przejście z BaseLinkera → Przeprowadzka**
(potrzebne uprawnienie do ustawień firmy).

## Krok 7. Co dalej

1. **Sklepy**: każdy sklep potrzebuje własnych kluczy API sklepu (dla dwóch sklepów: dwa komplety), np.
   `npm run sekret -- --firma <twoja-firma> --konto WOO/<numer sklepu> --ustaw …`.
2. **Allegro**: autoryzacja konta Allegro w Kompletorze (osobny krok, raz na konto).
3. **Kurierzy**: klucze API kurierów. Do tego czasu reguły przewoźników mają moduł wysyłki „brak”, a etykiety
   robisz jak dotąd w BL.
4. **Przełączenie**: każdy kanał przełączasz osobno i świadomie. Do tej chwili BL jest źródłem prawdy, a Kompletor
   porównuje w cieniu i pokazuje rozjazdy.

## Gdy coś nie działa

- „brak tokenu BL”: wróć do kroku 2.
- „statusy BL do decyzji z otwartymi zamówieniami”: wpisz decyzje w `mapa.json` (krok 5).
- „firma ma już zamówienia z własnych kanałów”: ta firma pracuje w Kompletorze; przeprowadzka jest dla nowej firmy.
- Raport i zrzuty zawsze zapisuj poza katalogiem programu (polecenie odmówi ścieżki w środku).
