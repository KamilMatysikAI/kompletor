# Statusy zamówień firmy: nazwy, kolory i grupy

Każda firma nazywa statusy zamówień po swojemu: „Do realizacji DPD”, „Zebrane Paczkomaty”, „Spakowane Allegro”.
Kompletor dalej sam przenosi zamówienie między etapami pracy (płatność, zbieranie, pakowanie, wysyłka, odbiór), a status
firmy to nazwa, którą zespół widzi na liście, na karcie zamówienia i w menu po lewej, pod pozycją „Zamówienia”.

## Gdzie to jest

Menu **Ustawienia → Sprzedaż i kanały → Statusy zamówień** (sekcja „Sprzedaż”). Adres: `/ustawienia/statusy`. Ekran widzi osoba
z uprawnieniem `ustawienia` (właściciel i administrator). Ta sama osoba ma na dole listy statusów w menu „Zamówienia”
link „Ustaw statusy”.

Status w sklepie dla statusu firmy ustawia się gdzie indziej: **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto sklepu →
sekcja „Zapis do sklepu” → „Statusy w sklepie” → rozwijane „Statusy firmy: inny status w sklepie niż wyżej”**.

## Co ma status

| Pole | Co znaczy |
|---|---|
| Nazwa | to, co widzi zespół (do 40 znaków) |
| Nazwa dla klienta | opcjonalna, gdy klient ma zobaczyć coś innego (np. „W przygotowaniu”) |
| Kolor | kropka przy statusie w menu „Zamówienia” i pigułka na liście i karcie zamówienia |
| Grupa | grupa statusów w menu „Zamówienia” (np. „Do realizacji”, „Zakończone”); bez grupy = na górze, zaraz pod „Wszystkie” |
| Etap pracy w Kompletorze | który etap ten status nazywa (Nowe, Do realizacji, Zbieranie, Zebrane, Spakowane, Do wysłania, Do odbioru, Wysłane, Odebrane, Anulowane, Do wyjaśnienia, Reklamacja) |
| Tylko dla przewoźników | status tylko dla zamówień tych przewoźników; nic nie zaznaczone = dla każdego |

## Jak zamówienie dostaje status firmy

1. Kompletor patrzy na etap pracy zamówienia i jego przewoźnika.
2. Bierze pierwszy widoczny status tego etapu, który jest dla tego przewoźnika (kolejność z ekranu).
3. Gdy takiego nie ma, bierze pierwszy widoczny status tego etapu bez przewoźników.
4. Gdy i takiego nie ma, zamówienie ma nazwę etapu Kompletora i w panelu stoi w sekcji „Bez statusu firmy”.

Status ustawiony wprost (ręcznie albo krokiem „Ustaw status” w regule z Ustawienia → Sprzedaż i kanały → Automatyczne akcje) ma
pierwszeństwo, dopóki zamówienie jest w tym samym etapie. Punkty 1–3 to **status domyślny etapu**: działa, gdy żadna
reguła nie nazwała statusu (np. konto sklepu w podglądzie). Firma przechodząca z BaseLinkera dostaje reguły z presetu
([Automatyczne akcje BL](akcje-bl.md)), które nazywają statusy tak samo jak przypisanie przewoźników.

Na karcie zamówienia **Więcej → Zmień status…** lista pokazuje statusy firmy. Status z tym samym etapem co obecny
zmienia tylko nazwę (dopisek „ten sam etap”), status z innym etapem przenosi zamówienie tą samą drogą co przyciski
„Co dalej”. Kiedy Kompletor sam przeniesie zamówienie dalej (np. po spakowaniu), status firmy liczy się od nowa.

## Edycja

- **Edytuj** przy statusie otwiera okno z polami i podglądem pigułki. **Gotowe** zamyka okno, a zmiany zapisuje
  **Zapisz** na dole ekranu (jeden zapis na cały ekran).
- Strzałki ↑ ↓ zmieniają kolejność. Kolejność decyduje o miejscu w panelu i o tym, który status wygrywa przy tym samym
  etapie i przewoźniku.
- **Dodaj status**, **Dodaj grupę**; grupę można zwinąć na start (w panelu widać wtedy samą sumę).
- Status bez zamówień można usunąć. Status, który ma zamówienia, można tylko ukryć: nie przypisuje się nowym zamówieniom.
- Każdy etap pracy musi mieć co najmniej jeden widoczny status. Bez tego zapis się nie uda.

## Status firmy w sklepie

Domyślnie sklep dostaje status jak dla etapu (tabela „Statusy w sklepie” na koncie kanału). W rozwijanej części
„Statusy firmy: inny status w sklepie niż wyżej” wpisujesz albo wybierasz status sklepu dla wybranego statusu firmy, np.
osobny status sklepu dla „Spakowane Allegro”. Puste pole = jak etap. Statusy idą do sklepu tylko na koncie w trybie
pracy z włączonym zapisem do sklepu; w trybie podglądu Kompletor tylko liczy, co by wysłał. Anulowanie
nieopłaconego po terminie zawsze idzie jako status z tabeli etapów (sklep najpierw sprawdza, czy płatności dalej nie ma).

Statusy firmy z etapów „Nowe”, „Do wyjaśnienia” i „Reklamacja” nigdy nie idą do sklepu: „Nowe” to zamówienie
nieopłacone (sklep nie może dostać „w realizacji” ani „zrealizowane”), a „Do wyjaśnienia” i „Reklamacja” to sprawy
biura. Na koncie kanału takie statusy są na liście bez pola, z dopiskiem „nie idzie do sklepu”, a próba zapisania dla
nich statusu sklepu (np. przez API) kończy się odmową. Z etapów spoza tabeli wyżej do sklepu może iść tylko „Zebrane”,
i to wyłącznie przez status firmy z wpisanym statusem sklepu. Lista etapów jest jedna dla całego Kompletora.

W alertach i w „Ostatnie zapisy statusów” zapis statusu firmy ma nazwę statusu firmy (np. „Spakowane Allegro”).

## Nowa firma i przeprowadzka

Nowa firma dostaje statusy neutralne: po jednym na etap („Nowe”, „Do realizacji”, „Zbieranie”, …) w czterech grupach.
Firma z gotowym presetem (plik w `seed/presety/<nazwa>.json`, listy `statusGroups` i `statuses`) dostaje swoje. Preset
zakłada statusy tylko firmie, która ich jeszcze nie ma: zmiany z panelu zostają.

## Czego ten ekran nie robi

- Nie zmienia etapów pracy Kompletora ani przejść między nimi (płatność, rezerwacja, pakowanie liczą się jak dotąd).
- Nie wysyła maili do klientów przy zmianie statusu (szablony maili: Ustawienia → Komunikacja i poczta → Poczta).
- Nie ustawia statusu w sklepie: to konto kanału (opis wyżej).
- Filtr „Status” w filtrach listy dalej wybiera etap pracy; status firmy wybiera się w menu „Zamówienia” po lewej.
- Ekran pakowania pokazuje nazwę etapu, nie status firmy.
- Eksport CSV listy i wydruk listy dalej podają nazwę etapu; odznaka „Filtry (N)” nie liczy wyboru statusu firmy
  z menu „Zamówienia”.

## Dla systemów zewnętrznych

`GET /api/v1/statusy` i narzędzie MCP `statusy` zwracają obok etapów listę `statusyFirmy` (klucz, nazwa, nazwa dla
klienta, kolor, grupa, etap, przewoźnicy, widoczność) i `grupyStatusow`. Opis: `docs/api.md`.
