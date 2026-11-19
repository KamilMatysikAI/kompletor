# Rezerwacje

Jak Kompletor liczy dostępny towar, kiedy rezerwuje go dla zamówienia, kiedy rezerwację zwalnia i co robi, gdy towaru brakuje.

## Wzór

**Fizycznie − zarezerwowane = dostępne.**

- **Fizycznie:** tyle sztuk (albo gramów) jest na półce według Kompletora.
- **Zarezerwowane:** tyle jest odłożone dla zamówień, które jeszcze nie wyszły.
- **Dostępne:** tyle możesz jeszcze sprzedać. Nigdy mniej niż 0.

Ten wzór widzisz na karcie produktu: Produkty → produkt.

Skąd bierze się stan fizyczny:

- na starcie z magazynu wFirmy przy imporcie katalogu albo, bez wFirmy, ze stanu w kanale przy pobraniu ofert,
- spada, gdy zamówienie dostaje fakturę (w trybie „Tylko podgląd”: fakturę wystawioną w BaseLinkerze),
- bez wFirmy zmieniasz go ręcznie: „Korekta stanu” na karcie produktu.

Z wFirmą stan fizyczny to lustro magazynu wFirmy: system czyta stany towarów co 2 minuty (po fakturze tego towaru) i cały magazyn co noc, tylko odczytem. Dostawa przyjęta w wFirmie podnosi stan w Kompletorze przy najbliższym odczycie.

## Kiedy powstaje rezerwacja

Od razu, gdy Kompletor odczyta zamówienie ze sklepu. Także gdy zamówienie jest **nieopłacone**.

- Każda pozycja rezerwuje tyle, ile jest dostępne. Czego brakuje, trafia na listę braków.
- Zestaw rezerwuje się tylko w całości: z każdego składnika tyle, ile potrzeba na pełne zestawy.
- Produkt bez stanu (na przykład e-book) niczego nie rezerwuje.
- Zamówienie, które przy pierwszym odczycie jest już anulowane, niczego nie rezerwuje.

## Kiedy rezerwacja gaśnie

- **Zużyta:** zamówienie dostało fakturę. Towar schodzi ze stanu fizycznego, a rezerwacja znika z zarezerwowanych.
- **Zwolniona:** zamówienie anulowano w sklepie albo minął termin płatności (niżej). Towar wraca do dostępnych.
- **Zmniejszona:** klient albo obsługa zmniejszyła ilość w sklepie. Najpierw zamyka się brak, potem zwalnia rezerwacja.

## Płatność

| Płatność | Status w Kompletorze | Terminy |
|---|---|---|
| Opłacone | Do realizacji | brak |
| Za pobraniem | Do realizacji (pobranie liczy się jak opłacone) | brak |
| Nieopłacone albo opłacone częściowo | Nowe | przypomnienie i zwolnienie rezerwacji |

Terminy dla nieopłaconego zamówienia liczą się od chwili złożenia zamówienia w sklepie, w dniach roboczych. Dni robocze to poniedziałek do piątku bez polskich świąt.

| Ustawienie | Domyślnie |
|---|---|
| Tryb normalny: przypomnienie | po 2 dniach roboczych |
| Tryb normalny: zwolnienie rezerwacji | po 5 dniach roboczych |
| Tryb sezonowy: przypomnienie | po 1 dniu roboczym |
| Tryb sezonowy: zwolnienie rezerwacji | po 3 dniach roboczych |
| „Brakuje wszystkiego”: oczekiwanie | 3 dni robocze |

Co się dzieje:

- **Przypomnienie:** w trybie „Tylko podgląd” Kompletor tylko zapisuje „wysłałbym mail »Brak płatności«”. Maila nie wysyła.
- **Zwolnienie:** po terminie Kompletor zwalnia rezerwację i oznacza zamówienie u siebie jako anulowane. W sklepie zamówienie zostaje bez zmian.
- Płatność i anulowanie zawsze wygrywają z terminem: opłacone zamówienie terminów już nie ma.
- Klient zapłacił po zwolnieniu? Kompletor rezerwuje towar od nowa. Jeśli go nie ma, zamówienie trafia do „Do wyjaśnienia” z powodem „opłacone po anulowaniu”.

**Nieudana płatność online** (bramka odrzuciła BLIK albo kartę; dziś rozpoznaje to sklep WooCommerce): towar czeka tylko tyle godzin, ile ustawisz w Ustawienia → Magazyn i strefy → Zasady rezerwacji, karta „Nieudana płatność online” (domyślnie 2 godziny od złożenia zamówienia, także w weekend). Potem towar wraca do sprzedaży, ale zamówienie zostaje „Nowe, nieopłacone” i nie jest anulowane ani w Kompletorze, ani w sklepie. Czeka na płatność do zwykłego terminu z tabeli wyżej, a dopiero po nim jest anulowane jak każde nieopłacone. Gdy klient zapłaci, zamówienie idzie do realizacji i rezerwuje to, co jest na stanie, a resztę wpisuje na listę braków. Gdy klient wybierze przelew tradycyjny, towar wraca do zamówienia od razu. Termin liczy się od złożenia zamówienia, nie od chwili, w której płatność się nie udała. Wyjątek: zamówienie anulowane w sklepie, a potem przywrócone, liczy termin od chwili przywrócenia. Zamówienie opłacone częściowo trzyma towar do zwykłego terminu. Na karcie zamówienia w sekcji „Płatność” widać, kiedy towar wróci (albo wrócił) do sprzedaży. Pozycji takiego zamówienia nie zmienisz z karty, dopóki nie przyjdzie wpłata.

Co widać: na liście zamówień przy takim zamówieniu stoi „zwolni towar …” (do kiedy towar czeka), a po tym czasie „towar wrócił do sprzedaży, czeka na płatność do …”. Na karcie zamówienia sekcja „Płatność” pokazuje to samo, a w historii zamówienia jest wpis „Nieudana płatność online w sklepie” i „Towar zwolniony”.

**Pytanie o płatność następnego dnia.** Zamiast zwykłego przypomnienia po dniach roboczych klient dostaje rano (o 9:00) mail „Nieudana płatność online”: pytanie, czy był problem z płatnością, i dane do zwykłego przelewu (odbiorca, numer rachunku, kwota, tytuł „Zamówienie <numer ze sklepu>”). Liczbę dni ustawiasz w tej samej karcie „Nieudana płatność online”, pole „Zapytaj o płatność po … dni” (domyślnie 1, od 1 do 7; dni kalendarzowe od złożenia zamówienia). Gdy 9:00 tego dnia już minęła w chwili, w której Kompletor dowiaduje się o nieudanej płatności (bramka odrzuciła płatność dopiero po kilku dniach, przerwa w odczycie sklepu, polecenie przeliczenia starych zamówień), pytanie wychodzi najbliższego ranka o 9:00, nigdy od razu. Gdy to rano nie wypada przed terminem anulowania, zostaje zwykłe przypomnienie, a gdy i jego termin już minął, przypomnienia nie ma (do anulowania zostaje mniej niż do rana). Gdy towar już wrócił do sprzedaży, mail mówi, że towar nie jest zarezerwowany i zamówienie zostanie zrealizowane z tego, co będzie dostępne po wpłacie. Gdy klient zapłaci albo wybierze przelew tradycyjny przed tą godziną, pytanie nie wychodzi (przy przelewie tradycyjnym wraca zwykłe przypomnienie). Numer rachunku i pełna nazwa firmy biorą się z Ustawienia → Dokumenty i faktury → Dane firmy; bez któregokolwiek klient dostaje zamiast pytania zwykły „Brak płatności” w tym samym terminie, a biuro widzi informację w karcie „Nieudana płatność online” w Zasadach rezerwacji i w podglądzie akcji. Zamówienie opłacone częściowo dostaje zwykłe przypomnienie w zwykłym terminie. Treść maila zmienisz w Ustawienia → Komunikacja i poczta → Szablony maili, szablon „Nieudana płatność online”. Maile wychodzą tylko wtedy, gdy wysyłka poczty jest włączona ([Poczta](poczta.md)).

**Wpłata po zwolnieniu towaru.** Gdy klient zapłaci po tym, jak towar wrócił do sprzedaży (także po zwykłym terminie, gdy zamówienie było już anulowane jako nieopłacone), zamówienie idzie do realizacji i rezerwuje to, co jest na stanie; czego zabraknie, trafia na listę braków.

Zamówienia przyjęte przed wprowadzeniem tych zasad (otwarte, nieopłacone, w sklepie w statusie „Nieudane”) poprawia jednorazowo polecenie `cien nieudane-platnosci-woo --firma <firma>`: dostają krótki termin liczony od złożenia (gdy już minął, towar wraca do sprzedaży od razu) i pytanie o płatność. Bez `--wykonaj` niczego nie zapisuje, powtórzone niczego nie zmienia. Założenie polecenia: status „Nieudane” w sklepie WooCommerce nadaje tylko bramka płatności online (przelew tradycyjny czeka w statusie „Wstrzymane”). Kompletor nie przechowuje identyfikatora metody płatności, więc wynik podaje przy każdym numerze metodę według tytułu z zamówienia, datę złożenia i wiek w dniach: przelewy i pobrania z ręcznie ustawionym „Nieudane” odsiej przed `--wykonaj`. Zapis wymaga świeżego odczytu sklepu: gdy ostatni udany odczyt zamówień konta jest starszy niż 15 minut (`--maks-wiek-minuty`), wynik ostrzega, a `--wykonaj` niczego nie zapisuje. Uruchom je, gdy konto sklepu jest jeszcze w trybie „Tylko podgląd”, co najmniej dobę przed włączeniem wysyłki poczty: przypomnienia starych zamówień zapiszą się wtedy jako „wysłałbym” i nie wyjdą.

## Tryb sezonowy

Krótsze terminy na czas dużego ruchu, na przykład przed świętami. Włączasz go w Ustawienia → Magazyn i strefy → Zasady rezerwacji.

Tryb obowiązuje zamówienia przyjęte **po** przełączeniu. Zamówienia przyjęte wcześniej zachowują swoje terminy.

Każde ustawienie przyjmuje od 0 do 30 dni roboczych. Przypomnienie nie może być później niż zwolnienie. Każda zmiana trafia do historii zmian na tym samym ekranie.

## Brak towaru

Gdy pozycji nie da się zarezerwować w całości, brakująca część trafia na listę Braki towaru → „Brakuje”.

Lista „Brakuje” (menu → Braki towaru, adres `/braki`) pokazuje braki, o których da się jeszcze zdecydować, i domyślnie tylko przy zamówieniach otwartych (filtr „Zamówienia: także wysłane i anulowane” pokaże resztę). Braki paczek, które już wyszły, są na liście „Do zwrotu”. Domyślny widok to „po produkcie”: jeden wiersz na produkt z sumą braków, liczbą zamówień i podsumowaniem decyzji; kliknięcie wiersza otwiera ten produkt w widoku „po zamówieniu”. Wyszukiwarka szuka po nazwie produktu, SKU i numerze zamówienia. Osoba z uprawnieniem do decyzji o brakach zaznacza wiersze i wybiera decyzję („wyślij resztę”, „dośle później”, „poczekaj na towar”): w widoku po produkcie decyzja zapisuje się dla wszystkich zamówień z zaznaczonymi produktami, w widoku po zamówieniu dla zaznaczonych pozycji albo w samym wierszu. Każda pozycja zapisuje się osobno: gdy któraś odmówi (np. paczka już wyszła), reszta i tak się zapisze, a komunikat nad listą powie, ile się udało. „Zamień produkt” wymaga SKU zamiennika, więc jest tylko na karcie zamówienia. Licznik przy „Braki towaru” w menu liczy też braki „Do zwrotu”.

Zwolniony towar (na przykład po anulowaniu innego zamówienia) Kompletor sam przydziela czekającym brakom w tej kolejności:

1. pozycje oznaczone „dośle później”,
2. zamówienia opłacone i za pobraniem,
3. zamówienia nieopłacone.

W każdej grupie od najstarszego zamówienia. Przydział dotyczy zamówień przed zbieraniem (Nowe, Do realizacji).

**„Brakuje wszystkiego”:** gdy zamówienie nie ma żadnej rezerwacji, Kompletor czeka na dostawę tyle dni roboczych, ile ustawisz (domyślnie 3). Potem zamówienie trafia do „Do wyjaśnienia”. Wartość 0 oznacza „od razu”.

## „Do wyjaśnienia”

Tu trafiają zamówienia, których Kompletor nie rozstrzyga sam. Każde ma zapisany powód, na przykład:

- oferta bez powiązania z produktem,
- nieznana metoda dostawy (żadna reguła przewoźnika jej nie rozpoznała),
- status w sklepie cofnął się (na przykład z wysłanego na nowe),
- brak wszystkich pozycji po terminie oczekiwania,
- opłacone po anulowaniu, a towaru już nie ma,
- sklep nie zna już zamówienia.

Rezerwacje zamówienia „Do wyjaśnienia” zostają bez zmian. W tej wersji panel nie ma przycisku zamknięcia sprawy.

## Stan wysyłany do sklepu

Do sklepu poszłoby: dostępne minus bufor bezpieczeństwa, podzielone przez liczbę sztuk w ofercie (na przykład oferta „2 sztuki”). Bufor widzisz w Ustawienia → Magazyn i strefy → Zasady rezerwacji. W tej wersji Kompletor ten stan tylko liczy i niczego do sklepu nie wysyła.

## Przykład

Dane fikcyjne. Sklep Przykładowy sprzedaje „Przyprawę Przykładową 100 g”. Tryb normalny, ustawienia domyślne. Na półce jest 10 sztuk.

| Krok | Fizycznie | Zarezerwowane | Dostępne | Braki |
|---|---|---|---|---|
| Start | 10 | 0 | 10 | 0 |
| Zamówienie A, opłacone, 3 szt. | 10 | 3 | 7 | 0 |
| Zamówienie B, nieopłacone, 5 szt., złożone w poniedziałek 16.11.2026 | 10 | 8 | 2 | 0 |
| Zamówienie C, opłacone, 4 szt.: rezerwuje 2, brakuje 2 | 10 | 10 | 0 | 2 |
| Środa 18.11: przypomnienie dla B („wysłałbym”) | 10 | 10 | 0 | 2 |
| Poniedziałek 23.11: B nadal nieopłacone, rezerwacja zwolniona | 10 | 5 | 5 | 2 |
| Przydział: brak C dostaje 2 szt. | 10 | 7 | 3 | 0 |
| Faktura dla A | 7 | 4 | 3 | 0 |

## Powrót do starszej wersji

Dotyczy tylko powrotu do wersji Kompletora sprzed zwalniania samego towaru przy nieudanej płatności online. Starsza wersja nie wie, że towar zamówienia był zwolniony: zamówienie „Nowe” bez rezerwacji poszłoby po wpłacie do realizacji bez towaru, a zmiana ilości w sklepie kończyłaby się błędem przy każdym odczycie. Dlatego przed powrotem przywróć rezerwacje poleceniem `przywroc-rezerwacje`. Polecenie działa dla jednej firmy, bez `--wykonaj` niczego nie zapisuje, a powtórzone niczego nie zmienia.

1. Na obecnej wersji zatrzymaj worker (wygasanie rezerwacji i odczyt zamówień ze sklepu). Jeśli to niemożliwe, zrób kroki 2–4 w jednym krótkim oknie.
2. Sprawdź listę: `npm run cien -- przywroc-rezerwacje --firma <slug>` (w obrazie Dockera: `node dist/cien.cjs przywroc-rezerwacje --firma <slug>`). Polecenie pokazuje numery zamówień, które dostaną rezerwację od nowa, zamówienia już zamknięte (zejdą im same znaczniki) i zamówienia, którym zejdzie tylko termin zwolnienia.
3. Wykonaj: to samo polecenie z `--wykonaj`. Każde zamówienie ze zwolnionym towarem w „Nowe” albo „Do wyjaśnienia” rezerwuje to, co jest na stanie, a resztę wpisuje na listę braków. Terminy zwolnienia znikają ze wszystkich zamówień. Błąd przy jednym zamówieniu nie zatrzymuje reszty; numer i powód zobaczysz w wyniku (kod wyjścia 1).
4. Sprawdź: ponowne polecenie bez `--wykonaj` pokazuje 0 zamówień, nocny audyt (niezmienniki) nie zgłasza naruszeń, a lista braków zawiera nowe pozycje.
5. Dopiero wtedy wdróż starszą wersję i włącz worker.
6. Jeśli wróciłeś do starszej wersji bez kroku 3: wdróż z powrotem obecną wersję, wykonaj krok 3 i wróć jeszcze raz.
7. Przed pierwszym takim powrotem sprawdź na stagingu, że starsza wersja startuje (`prisma migrate deploy`) przy bazie z migracją dodającą terminy zwolnienia, której starsza wersja nie ma w katalogu migracji. Kolumn i wpisu migracji nie usuwaj: starsza wersja ich nie czyta.
