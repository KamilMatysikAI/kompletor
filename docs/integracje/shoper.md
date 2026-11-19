# Sklep Shoper w Kompletorze

> **Stan na 02.11.2026: przygotowane, sprawdzone wyłącznie na symulowanym sklepie.** Nie mieliśmy jeszcze dostępu do
> prawdziwego sklepu Shoper. Zanim podłączymy pierwszego sprzedawcę, zespół Kompletora przejdzie listę z sekcji
> [„Lista przed ogłoszeniem integracji”](#lista-przed-ogłoszeniem-integracji) na sklepie demo Shoper.

Ten opis jest dla sprzedawcy, który ma sklep na Shoperze i chce, żeby Kompletor widział jego zamówienia. Nie trzeba
znać się na programowaniu: Ty przygotowujesz dostęp w panelu sklepu, a resztę robi administrator Kompletora.

## Co Kompletor robi ze sklepem Shoper

- **Czyta zamówienia**: nowe i zmienione, mniej więcej co minutę. Widzi numer zamówienia, status, kwotę, sposób
  płatności i dostawy oraz kupione produkty z ilościami.
- **Rezerwuje towar** w Kompletorze dla zamówień otwartych (także nieopłaconych: od chwili złożenia zamówienia),
  a zwalnia rezerwację, gdy zamówienie zostanie anulowane.
- **Czyta stany magazynowe** produktów ze sklepu (kod produktu, EAN, liczba sztuk), żeby można je było porównać ze
  stanami w Kompletorze.

## Czego Kompletor nie robi

- **Nie zmienia niczego w Twoim sklepie.** Nie zmienia stanów, cen, statusów zamówień ani opisów. Kod zapisu istnieje,
  ale jest wyłączony i nic go nie uruchamia (patrz [„Zapis w sklepie”](#zapis-w-sklepie-dla-administratora)).
- **Nie wysyła maili ani SMS-ów do Twoich klientów.**
- **Nie czyta danych klientów:** imion i nazwisk, adresów, e-maili, telefonów, adresów IP, uwag do zamówienia ani
  danych punktu odbioru. Z adresu do faktury sprawdza tylko, *czy* klient podał NIP (tak/nie), bez zapisywania numeru.
- **Nie dodaje produktów ani ofert** na podstawie sklepu (szczegóły w „Ograniczeniach”).

## Krok 1. Dostęp w panelu sklepu

Kompletor potrzebuje **tokena dostępu tylko do odczytu**. Token to długi ciąg znaków, który działa jak hasło dla
programu: pozwala czytać wybrane dane sklepu, ale nie pozwala logować się do panelu.

1. Zaloguj się do panelu administracyjnego sklepu Shoper.
2. Wejdź w ustawienia integracji / API **[do potwierdzenia na sklepie demo: dokładna ścieżka menu, np.
   „Konfiguracja → Integracje → API” albo „Dodaj integrację”]**.
3. Dodaj nową integrację o nazwie np. „Kompletor (odczyt)”.
4. Zaznacz **wyłącznie uprawnienia do odczytu** **[do potwierdzenia na sklepie demo: nazwy uprawnień]**:
   - zamówienia (wraz z produktami zamówień),
   - statusy zamówień,
   - produkty i stany magazynowe,
   - sposoby płatności, sposoby dostawy i waluty (Kompletor potrzebuje ich nazw, np. „Paczkomaty InPost”).
   
   Nie zaznaczaj żadnych uprawnień do zapisu, edycji ani usuwania.
5. Zapisz i skopiuj token. Zwykle widać go tylko raz: jeśli zgubisz, wygeneruj nowy.

Jeśli Twój plan sklepu nie pozwala utworzyć tokena **[do potwierdzenia: dostępność na planach Shoper]**, można
zamiast niego założyć osobnego administratora API (login i hasło tylko dla Kompletora) z tymi samymi uprawnieniami do
odczytu. Nie podawaj swojego głównego hasła do panelu.

Jak długo token jest ważny, zależy od Shopera **[do potwierdzenia]**. Gdy przestanie działać, Kompletor pokaże
alert, a Ty wygenerujesz nowy i przekażesz go tak samo.

## Krok 2. Przekazanie danych administratorowi Kompletora

Przekaż administratorowi:

- **adres sklepu** zaczynający się od `https://` (np. `https://mojsklep.pl`),
- **nazwę**, pod jaką sklep ma być widoczny w Kompletorze (np. „Mój sklep”),
- **token**: osobnym, bezpiecznym kanałem (menedżer haseł, rozmowa), nie w treści zwykłego maila ani na czacie
  grupowym.

Administrator Kompletora wykonuje (ekranu do tego jeszcze nie ma, więc robi to z wiersza poleceń):

```
# 1. konto sklepu (tylko odczyt)
npm run konto -- dodaj --firma <firma> --kanal SHOPER --konto <id> --nazwa "Mój sklep" \
  --adapter shoper.rest.v1 --config baseUrl=https://mojsklep.pl

# 2. token jako zaszyfrowany sekret konta (wartość nie trafia do historii poleceń)
read -rs SHOPER_ACCESS_TOKEN && export SHOPER_ACCESS_TOKEN
npm run sekret -- --firma <firma> --ustaw SHOPER_ACCESS_TOKEN --z-env SHOPER_ACCESS_TOKEN --konto SHOPER/<id>

#    albo, bez tokena: login i hasło administratora API
#    npm run sekret -- … --ustaw SHOPER_API_LOGIN --z-env SHOPER_API_LOGIN --konto SHOPER/<id>
#    npm run sekret -- … --ustaw SHOPER_API_PASSWORD --z-env SHOPER_API_PASSWORD --konto SHOPER/<id>

# 3. test połączenia: liczba zamówień i statusów, bez tokena w wyniku
npm run konto -- test --firma <firma> --konto SHOPER/<id>
```

`<id>` to krótki identyfikator konta (litery, cyfry, `-`, `_`, `.`), np. `mojsklep`. Opcjonalne ustawienia konta
(`--config klucz=wartość`): `strefa` (strefa czasowa dat sklepu, domyślnie `Europe/Warsaw`), `pageSize` (1–50,
domyślnie 50), `overlapMinutes` (domyślnie 5), `pollIntervalSec`. Jeśli test pokaże „token bez uprawnienia do
odczytu: …”, w panelu sklepu brakuje wymienionego uprawnienia.

## Ograniczenia (stan obecny)

- **Brak ekranu w panelu Kompletora** dla kont sklepów: konto zakłada administrator poleceniem jak wyżej.
- **Produkty muszą być znane Kompletorowi z innego źródła.** Dziś oferty (powiązanie „produkt w sklepie ↔ produkt
  w Kompletorze”) powstają wyłącznie z importu z BaseLinkera. Zamówienie ze sklepu Shoper bez takiego importu trafi
  do Kompletora, ale jego pozycje nie będą powiązane z produktami: zamówienie ląduje w **„Do wyjaśnienia”**
  i nie rezerwuje towaru, dopóki ktoś go nie przypisze. Odczyt stanów ze sklepu jest gotowy, ale nie zakłada ofert.
- **Informacja o płatności może dojść z opóźnieniem do doby.** Kompletor szuka zmian po dacie zmiany statusu
  zamówienia. Gdy klient zapłaci, a status w sklepie się nie zmieni, Kompletor zobaczy płatność dopiero przy dziennym
  przeglądzie otwartych zamówień. Jeśli sklep zmienia status po opłaceniu (najczęstsze ustawienie), opóźnienia nie ma.
- **Tryb cienia.** Kompletor tylko obserwuje i liczy: nic w sklepie się nie zmienia, a stany w sklepie dalej
  prowadzi sklep (sam zdejmuje sztuki przy zamówieniu).
- **Sklep z modułem magazynów** (plan Premium Shopera): przy włączonych magazynach stan produktu w API jest tylko do
  odczytu. Odczyt działa, ale przyszły zapis stanów z Kompletora nie będzie możliwy: Kompletor zgłosi to jako błąd
  „sklep ma włączony moduł magazynów”.
- **Kurier wybierany po nazwie dostawy.** Reguły przewoźników Kompletora rozpoznają kuriera po nazwie sposobu dostawy
  ze sklepu (np. „Paczkomaty InPost”, „Kurier DPD”). Nietypowa nazwa = zamówienie „Do wyjaśnienia” z powodem
  „nieznana metoda dostawy”.
- **Bez porównania z BaseLinkerem.** Sklep Shoper nie przechodzi przez BL, więc nie pojawia się w porównaniach
  cienia z BL (nie jest tam pokazywany jako „brak w BL”).
- **Duży sklep bez działającego filtra daty.** Jeśli API sklepu nie filtruje zamówień po dacie zmiany statusu,
  Kompletor czyta tylko ostatnie strony listy (najnowsze zamówienia) i zgłasza alert konta. Zmiany starszych zamówień
  wychwyci wtedy dzienny przegląd otwartych zamówień.

## Zapis w sklepie (dla administratora)

Kod zapisu stanu (`PUT /webapi/rest/product-stocks/<id>`, pole `stock`) i statusu zamówienia
(`PUT /webapi/rest/orders/<id>`, pole `status_id`) jest gotowy w adapterze `shoper.rest.zapis.v1`, ale **zapis wymaga
trzech niezależnych warunków jednocześnie**:

1. konto ma adapter `shoper.rest.zapis.v1` (domyślny `shoper.rest.v1` w ogóle nie ma metod zapisu),
2. konto ma ustawienie `zapisWlaczony=true`,
3. Kompletor wywołuje zapis: **dziś nigdzie tego nie robi**; kod zapisu uruchamiają wyłącznie testy.

`npm run konto -- test` dla konta z kluczem zapisu pokazuje w szczegółach `zapisWlaczony: true/false` (bez żadnego
żądania zapisu). Bez `zapisWlaczony` adapter odmawia zapisu („zapis wyłączony na tym koncie”) i nie wysyła do sklepu żadnego żądania.
Zapis stanu jest bezwzględny (ustawia liczbę sztuk), więc powtórzenie po błędzie sieci jest bezpieczne. Uwaga na
statusy z włączonym powiadomieniem e-mail w Shoperze: zmiana statusu przez API **może wysłać mail do klienta**
**[do potwierdzenia]**.

## Lista przed ogłoszeniem integracji

Do wykonania przez zespół Kompletora, lokalnie, **poza** zadaniem. Do tego czasu nigdzie nie piszemy, że
integracja działa albo jest wspierana.

- [ ] **Sklep demo Shoper** (okres próbny). Jeśli próba jest płatna: decyzja właściciela.
- [ ] Token **tylko do odczytu** z uprawnieniami z Kroku 1; zapisać dokładną ścieżkę menu i nazwy uprawnień
      w tym dokumencie (usunąć oznaczenia „do potwierdzenia”).
- [ ] Sprawdzić logowanie loginem i hasłem administratora API (`POST /webapi/rest/auth`) oraz czas życia tokena.
- [ ] **10 fikcyjnych zamówień** w różnych statusach (nowe, w realizacji, wysłane, anulowane; opłacone, nieopłacone,
      za pobraniem, z niedopłatą; jedno z NIP-em; jedno z produktem z wariantem).
- [ ] `npm run konto -- dodaj` i `-- test` na sklepie demo; odczyt cienia; **porównanie z panelem sklepu**: liczby,
      statusy, kwoty, ilości, sposoby płatności i dostawy, daty (strefa czasowa).
- [ ] Filtr **`filters[status_date][>=]`** listy zamówień: czy działa (bez alertu „filtr status_date nie działa”).
- [ ] Czy **`status_date`** jest ustawione już przy złożeniu zamówienia (równe `date`): złożyć zamówienie i od razu
      sprawdzić, czy cień je widzi bez zmiany statusu. Jeśli nie, zapasowy odczyt `filters[date][>=]` (decyzja po demo).
- [ ] Filtr **`filters[order_id][=]`** w `order-products` (gdy nie działa: ostrzeżenie zamówienia „filtr order_id
      w /order-products nie działa”).
- [ ] Odczyt zamówienia z pozycją bez `stock_id` (produkt usunięty ze sklepu).
- [ ] **Kolejność listy** zamówień bez sortowania (zakładamy rosnąco po `order_id`).
- [ ] **Typy statusów** (`/statuses`, pole `type`): 1 nowy, 2 w realizacji, 3 wysłany, 4 końcowy: czy 4 to tylko
      anulowane (a np. „zwrócone”, „odrzucone”?).
- [ ] Pole **`price`** pozycji to cena jednostkowa **brutto**.
- [ ] Nazwy płatności z `translations.pl_PL.title`, nazwy dostaw z `name`, kod waluty z `name` w `/currencies`.
- [ ] Pola `is_paid`, `confirm`, `is_cash_on_delivery`, `is_underpayment` (kształt wartości: `1`/`0`, `true`/`false`).
- [ ] **Limit tempa**: nagłówki `X-Shop-Api-Limit`, `X-Shop-Api-Bandwidth`, `X-Shop-Api-Calls`, 429 z `Retry-After`
      przy odstępie 500 ms.
- [ ] **Zapis stanu i statusu: wyłącznie na sklepie demo**, nigdy na sklepie sprzedawcy: `PUT product-stocks/<id>`
      z `stock` (sprawdzić odczytem), sklep z modułem magazynów (komunikat błędu), `PUT orders/<id>` z `status_id`
      i to, czy status z powiadomieniem e-mail wysyła mail po zmianie przez API.
- [ ] Odpowiedź 403 przy brakującym uprawnieniu (`insufficient_scope`): czy test połączenia mówi, którego brakuje.

### Założenia do potwierdzenia (w kodzie: stałe `TYP_STATUSU` i `NIEPEWNE`, `lib/adaptery/shoper.ts`)

1. Filtr listy zamówień `filters[status_date][>=]` (SDK go nie wymienia). Ochrona: adapter wykrywa, że nie działa,
   i czyta najwyżej 5 ostatnich stron.
2. Filtr pozycji `filters[order_id][=]` (SDK go nie wymienia). Ochrona: wiersze innych zamówień są odrzucane,
   zamówienie dostaje ostrzeżenie, odczyt najwyżej 10 stron.
3. Kolejność listy zamówień rosnąco po `order_id`.
4. Typy statusów 1–4 i ich znaczenie (`TYP_STATUSU`).
5. `price` pozycji brutto.
6. Pola nazw: płatności `translations.<język>.title` (potem `name`), dostawy `name`, waluty `name` w `/currencies`
   (zamówienie ma tylko `currency_id`).
7. Czas życia tokena, ścieżka menu, nazwy uprawnień, dostępność tokena na planach.
8. Czy status z `email_change` wysyła mail klientowi po zmianie przez API.
9. Kształt wartości flag (`1`/`0` albo `true`/`false`) i dat (`RRRR-MM-DD GG:MM:SS`, czas lokalny sklepu).
10. Treść błędu 400 przy włączonych magazynach (adapter szuka słów „warehouse” albo „magazyn”).
11. `status_date` ustawione przy złożeniu zamówienia (`NIEPEWNE.statusDataPrzyZlozeniu`).
