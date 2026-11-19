# Automatyczne akcje BaseLinkera → Kompletor

> **Zasada „bez edytora reguł i makr” odwołana 08.11.2026** (decyzja właściciela: statusy i automaty to ustawienie
> firmy, nie kod). Przepływ firmy przechodzącej z BaseLinkera to **reguły presetu firmy**, edytor: **Ustawienia → Sprzedaż i kanały →
> Automatyczne akcje** ([Automatyczne akcje](automatyczne-akcje.md)). Przeniesienie 33 akcji.

Gdzie w Kompletorze jest każda automatyczna akcja BaseLinkera (zmiana statusu, mail, faktura, etykieta), dla firmy,
która je dziś ustawia w BaseLinkerze. Rozpoznanie akcji BL z 21.10.2026 i zrzuty z 08.11.2026: 33 akcje zamówień
w trzech grupach (Brak grupy 1–14, Zbieranie / Pakowanie 15–24, Przyciski 25–33) i 2 produktowe.

## Jak to działa

- **Każda akcja BL = jedna reguła presetu** z nazwą jak w BL i kluczem `<firma>-bl-NN` (NN = numer z tabel niżej), w tej
  samej grupie i kolejności. Preset firmy (`seed/presety/<firma>.json`, pola `automationGroups` i `automationRules`)
  to dane, nie kod: firma zmienia, wyłącza i usuwa reguły w Ustawienia → Sprzedaż i kanały → Automatyczne akcje.
- **Zakładanie reguł:** przy zakładaniu firmy z presetu (`npm run org:seed -- <firma>`, także start kontenera
  z `KOMPLETOR_SEED`) i osobno dla istniejącej firmy: `npm run org:automaty -- <firma> --sucho` (raport, nic nie
  zapisuje), potem bez `--sucho`. Zakładane są tylko brakujące klucze: drugi przebieg = 0 zmian, reguła zmieniona albo
  usunięta w panelu zostaje taka, jaka jest (usunięta reguła z presetu jest ukrywana, więc nie wraca), grupa powstaje
  tylko dla nowej reguły (usunięta w panelu nie wraca), statusy zamówień się nie zmieniają. Przy zakładaniu firmy
  i starcie kontenera preset dokłada reguły tylko firmie, która nie ma jeszcze żadnej. Format pliku jest wspólny
  z szablonami przepływów (`lib/automaty/szablon.ts`): klucze `[a-z0-9-]`, `groupKey`, `enabled` jawnie (brak =
  wyłączona), `description` = opis dla zespołu widoczny na liście reguł (każda wyłączona reguła presetu mówi, dlaczego).
- **Rdzeń dalej prowadzi etapy pracy** (`OrderStatus`: płatność, zbieranie, pakowanie, faktura, przesyłka, anulowanie)
  i wyznacza przewoźnika z reguł firmy (`CarrierRule`, Ustawienia → Wysyłka i druk → Przewoźnicy). **Nazwę statusu firmy** („Do
  realizacji DPD”, „Spakowane Allegro”) ustawiają reguły presetu. W kodzie rdzenia nie ma nazw statusów żadnej firmy.
- **Status domyślny etapu:** gdy żadna reguła nie nazwała statusu (konto sklepu w podglądzie, w którym krok „Ustaw
  status” nic nie zmienia; zamówienie, które weszło w etap drogą bez reguły, np. po „Do wyjaśnienia”), zamówienie
  pokazuje status firmy z tym etapem i przewoźnikiem (Ustawienia → Sprzedaż i kanały → Statusy zamówień, pole przewoźników), a bez
  przypisania przewoźnika pierwszy status tego etapu. Firma bez statusów własnych widzi nazwy etapów.
- **Reguły nazywają, nie cofają.** Reguły statusów mają warunek „Status” z etapu, który właśnie nastąpił (np. „Spakowano”
  → tylko gdy zamówienie jest jeszcze w którymś statusie „Spakowane …”). Reguła wykonuje się około minuty po zdarzeniu,
  a w tym czasie zamówienie mogło pójść dalej (np. „Do wysłania” po utworzeniu przesyłki): bez tego warunku krok
  „Ustaw status” mógłby je cofnąć. W BL ten sam bezpiecznik ma tylko część reguł („Status: nie Do wysłania”).
- **Przewoźnik zamiast frazy przesyłki.** BL sprawdza w każdej regule frazę metody dostawy („Paczkomaty”, „DPD,
  Kurier, Empik”). Kompletor wyznacza przewoźnika raz, przy przyjęciu zamówienia (fraza „paczkomat” łapie też
  „Paczkomat InPost”), więc reguła patrzy na przewoźnika: wynik jest ten sam co przy statusie wyznaczanym z przewoźnika.
- **Dowód równoważności:** test presetu firmy z nakładki prywatnej (biegnie tylko z plikiem presetu) przechodzi symulację grudnia dwa razy: statusy
  z przypisaniem przewoźników bez reguł i te same statusy bez przewoźników z regułami presetu. Po każdym kroku każdego
  zamówienia ten sam status firmy, na końcu te same maile w planie, faktury, przesyłki, wydruki i zapisy do sklepów.

## Bez grupy

| Nr | Akcja BL | Reguła presetu (Kompletor) |
|---|---|---|
| 1 | Opłacono, bez pobrania, źródło Allegro → „Do realizacji Allegro” | **włączona**: „Opłacone, Allegro → Do realizacji Allegro” (zdarzenie „opłacono”; pobranie: nie; źródło: Allegro; status: etap Do realizacji). Etap `DO_REALIZACJI` ustawia rdzeń (`ingestOrder` → `initialStatus`, płatność później: `markPaid`) |
| 2 | Pobrano zamówienie, pobranie, źródło Allegro → „Do realizacji Allegro” | **włączona**: „Pobrano, pobranie, Allegro → Do realizacji Allegro”. Pobranie (`PaymentState.COD`) rdzeń liczy jak opłacone |
| 3 | Opłacono, bez pobrania, nie Allegro, przesyłka zawiera „Paczkomaty” → „Do realizacji Paczkomaty” | **włączona**: „Opłacone, Paczkomaty → Do realizacji Paczkomaty” (przewoźnik: Paczkomaty, InPost kurier) |
| 3a | brak w BL | **włączona**, reguła Kompletora `<firma>-kompletor-01`: „Pobrano, pobranie, Paczkomaty → Do realizacji Paczkomaty”. Kompletor przyjmuje pobranie do paczkomatu jak opłacone zamówienie (BL nie ma na to reguły) |
| 4 | Opłacono, bez pobrania, nie Allegro, przesyłka „DPD, KURIER, Empik” → „Do realizacji DPD” | **włączona**: „Opłacone, DPD, Kurier, Empik → Do realizacji DPD” (przewoźnik: DPD, DPD Salony Empik; w Kompletorze salon Empik to osobny przewoźnik, konto DPD Salony Empik) |
| 5 | Pobrano, pobranie, nie Allegro, przesyłka „DPD, Kurier, Empik” → „Do realizacji DPD” | **włączona**: „Pobrano, pobranie, DPD, Kurier, Empik → Do realizacji DPD” |
| 6 | Opłacono, bez pobrania, źródło: jeden ze sklepów Woo, przesyłka „Osobisty” → „Do realizacji Osobisty” | **włączona**: „Opłacone, Osobisty → Do realizacji Osobisty” (przewoźnik: Odbiór osobisty, dla każdego sklepu, nie tylko jednego) |
| 6a | brak w BL | **włączona**, `<firma>-kompletor-02`: „Pobrano, pobranie, Osobisty → Do realizacji Osobisty” |
| 6b | brak w BL (status „E-book” w BL ustawiany ręcznie) | **włączona**, `<firma>-kompletor-03`: „Opłacone, bez wysyłki → E-book” (przewoźnik: bez wysyłki) |
| 7 | Ustawiono status „Do realizacji …” → utwórz fakturę (domyślna) | **wyłączona**: „Do realizacji → faktura”. W Kompletorze fakturę wystawia rdzeń **po spakowaniu** (`issueInvoice`, spec/: ruch IN_FLIGHT i rezerwacje CONSUMING przed żądaniem), gdy w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży jest włączone wystawianie; krok „Wystaw fakturę” ponawia tylko nieudaną. **W cieniu fakturę wystawia BL**; rdzeń ją odnotowuje (`applyBlInvoice`) |
| 8 | Status przesyłki u kuriera „Przekazano kurierowi…” → „Wysłane” | **włączona**: „Przekazano kurierowi → Wysłane” (zdarzenie „zmieniono status przesyłki u kuriera”; status: któryś „Spakowane …” albo „Do wysłania”, więc spóźniony albo powtórzony status przesyłki nie cofa „Odebrane”). Fraza musi odpowiadać tekstowi statusu od przewoźnika: dziś śledzi tylko InPost ShipX i podaje kody po angielsku, dlatego reguła ma obok „Przekazano kurierowi” kody `dispatched_by_sender`, `collected_from_sender`, `taken_by_courier` (teksty po polsku od innych przewoźników dopiero). „Wysłane” po odbiorze paczki robi też rdzeń, w tym samym przebiegu śledzenia (`shipment.track`, `wyslijPoOdbiorze` w `lib/pakowanie/wyslane-po-przyjezdzie.ts`), oraz przycisk „Przyjechał <przewoźnik>”, za wyłącznikami Ustawienia → Wysyłka i druk → Przewoźnicy → automaty wysyłki (`wysylkaAutomaty.wyslanePoPrzyjezdzie`, `.sledzenie`). Reguła wykonuje się około minuty po wpisie w dzienniku, więc zwykle zastaje zamówienie już „Wysłane” i nic nie robi; zmienia status tylko wtedy, gdy rdzeń go nie przeniósł |
| 9 | Anulowano zamówienie → „Anulowane” | **włączona**: „Anulowano zamówienie → Anulowane”. Anulowanie robi rdzeń (`cancelOrder`, anulowanie w kanale, po terminie), reguła nazywa status |
| 10 | Status „Wysłane, Odebrane” → e-mail „Faktura” | **włączona**: „Wysłane, Odebrane → e-mail Faktura”. Przy włączonym planie wbudowanym (niżej) mail planuje plan wbudowany: `mail.faktura`, a krok reguły go nie dubluje |
| 11 | Błąd przy FV → e-mail „Błąd przy wystawianiu faktury”, gwiazdka, anuluj fakturę | **włączona**: „Błąd przy FV → e-mail, anuluj fakturę”. **Bez gwiazdki**: Kompletor oznacza to zamówienie flagą `fakturaBlad`, alertem `FAKTURA_BLAD` i kafelkiem na pulpicie (gwiazdkę firma dopisze krokiem „Oznacz zamówienie”, jeśli chce). Nieudaną fakturę anuluje rdzeń (`failInvoice`), krok „Anuluj fakturę” niczego nie dokłada. Mail: plan wbudowany: `mail.blad-faktury` (krok reguły wysyła tylko przy limicie programu do faktur) |
| 12 | Status „Nowe zamówienia” 2 dni robocze → e-mail „Brak płatności” | **wyłączona**: „Nowe zamówienia 2 dni robocze → e-mail Brak płatności”. Termin przypomnienia liczy rdzeń z polityki rezerwacji (Ustawienia → Magazyn i strefy → Zasady rezerwacji: poza sezonem 2, w sezonie 1 dzień roboczy), mail planuje plan wbudowany: `mail.brak-platnosci`. Reguła ze stałymi 2 dniami różniłaby się w sezonie. Po nieudanej płatności online ten sam plan wysyła rano następnego dnia (ustawienie w tej samej karcie) mail „Nieudana płatność online” z danymi do przelewu zamiast „Brak płatności” |
| 13 | Status „Nowe zamówienia” 5 dni roboczych → „Anulowane” | **wyłączona**: „Nowe zamówienia 5 dni roboczych → Anulowane”. Anuluje rdzeń po `Order.reservationDeadline` (polityka rezerwacji: 5 albo w sezonie 3 dni robocze, powód `EXPIRED_UNPAID`, informacja do sklepu `ANULOWANE_NIEOPLACONE`, wyłącznik `wysylkaAutomaty.anulowanieWKanale`). Reguła anulowałaby inną drogą (bez powodu „po terminie”) |
| 14 | Status „Do odbioru” → e-mail „Gotowe do odbioru” | **włączona**: „Do odbioru → e-mail Gotowe do odbioru” (jak 10: plan wbudowany: `mail.gotowe-do-odbioru`, bez dubla) |

## Zbieranie / pakowanie

| Nr | Akcja BL | Reguła presetu (Kompletor) |
|---|---|---|
| 15 | Rozpoczęto zbieranie → „Rozpoczęto zbieranie” | **włączona**: „Rozpoczęto zbieranie → Rozpoczęto zbieranie”. Etap: `startPicking` (T7) → `ZBIERANIE` |
| 16 | Zebrano produkty → „Zebrane Allegro” | **włączona**: „Zebrano, Allegro → Zebrane Allegro”. Etap: `finishPicking` (T8) → `ZEBRANE` |
| 17 | Zebrano produkty → „Zebrane DPD” | **włączona**: „Zebrano, Kurier, DPD, Empik → Zebrane DPD” |
| 18 | Zebrano produkty → „Zebrane Paczkomaty” | **włączona**: „Zebrano, Paczkomaty → Zebrane Paczkomaty” |
| 19 | Zebrano produkty → „Zebrane Osobisty” | **włączona**: „Zebrano, Osobisty → Zebrane Osobisty” |
| 20 | Spakowano (status ≠ „Do wysłania”) → „Spakowane Allegro” | **włączona**: „Spakowano, Allegro → Spakowane Allegro”. Etap: `packOrder` (T9) → `SPAKOWANE` |
| 21 | Spakowano (status ≠ „Do wysłania”) → „Spakowane DPD” | **włączona**: „Spakowano, Kurier, DPD, Empik → Spakowane DPD” |
| 22 | Spakowano (status ≠ „Do wysłania”) → „Spakowane Paczkomaty” | **włączona**: „Spakowano, Paczkomaty → Spakowane Paczkomaty” |
| 23 | Spakowano (status ≠ „Do wysłania”) → „Spakowane Osobisty” | **włączona**: „Spakowano, Osobisty → Spakowane Osobisty” |
| 24 | Utworzono przesyłkę (dowolny przewoźnik) → „Do wysłania” + wydrukuj najnowszą etykietę | **wyłączona**: „Utworzono przesyłkę → Do wysłania, etykieta”. „Do wysłania” po utworzeniu przesyłki ustawia rdzeń (`lib/wysylka/nadanie.ts`, osobisty: `readyForDispatch` → `DO_ODBIORU`), etykietę drukuje stanowisko pakowania i agent druku (`agent-druku/`). Włączenie dołoży drugi wydruk etykiety na stanowisku druku |

## Przyciski

Wszystkie **wyłączone**: Kompletor ma te przyciski na karcie zamówienia i na stanowisku („Utwórz przesyłkę: DPD”,
„InPost A/B/C”, Wysyłam z Allegro, „Do wyjaśnienia” w „Zmień status”). Włączona reguła dokłada własny przycisk obok.
Moduł kroku „Utwórz przesyłkę” musi być tym, którym nadaje przewoźnik zamówienia (Ustawienia → Wysyłka i druk → Przewoźnicy).

| Nr | Akcja BL | Reguła presetu (Kompletor) |
|---|---|---|
| 25 | Kurier DPD (przesyłka „Kurier, DPD”) → przesyłka DPD PL | **wyłączona**: „Kurier DPD”: utwórz przesyłkę, moduł `basecourier.v1` (Base Courier, za wyłącznikiem) |
| 26 | Kurier DPD (przesyłka „Empik”) → przesyłka DPD PL (konto DPD Salony Empik) | **wyłączona**: „Kurier DPD (salon Empik)”: jak 25, kod salonu jako punkt ([NIEPEWNE] czy kod salonu w `taker_point` dociera do salonu Empik bez osobnego konta) |
| 27 | Allegro gabaryt A/S → przesyłka Allegro.pl | **wyłączona**: „Allegro Gabaryt A / S”: moduł `allegro.wysylam.v1`, gabaryt A (docs/wysylam-z-allegro.md) |
| 28 | Allegro gabaryt B/M → przesyłka Allegro.pl | **wyłączona**: „Allegro Gabaryt B / M”: jak 27, gabaryt B |
| 29 | Allegro gabaryt C/L → przesyłka Allegro.pl | **wyłączona**: „Allegro Gabaryt C / L”: jak 27, gabaryt C |
| 30 | InPost gabaryt A → przesyłka Base Courier (BL Paczka) | **wyłączona**: „InPost Gabaryt A”: moduł `basecourier.v1`, gabaryt A |
| 31 | InPost gabaryt B → przesyłka Base Courier (BL Paczka) | **wyłączona**: „InPost Gabaryt B” |
| 32 | InPost gabaryt C → przesyłka Base Courier (BL Paczka) | **wyłączona**: „InPost Gabaryt C” |
| 33 | Do wyjaśnienia → status „Do wyjaśnienia” | **wyłączona**: „Do wyjaśnienia”: ustaw status „Do wyjaśnienia” (`clarifyOrder`; wejścia automatyczne robi rdzeń: `setClarify`, wyjście: `resolveClarification`) |

## Maile: plan wbudowany i reguły

Maile do klientów 10, 11, 12, 14 planuje dziś **wbudowany plan maili** (`lib/akcje/`, tabela niżej), działający także
w cieniu na statusach z kopii BL. Reguły 10, 11 i 14 są włączone, ale krok „Wyślij e-mail” pomija mail, który plan
już ma, więc klient dostaje jeden. **Wyłącznik firmy:** Ustawienia → Sprzedaż i kanały → Automatyczne akcje → „Maile do zamówień planuje
też Kompletor” (`Organization.settings.akcje.planWbudowany`, domyślnie włączony, zmiana w AuditLog). Wyłączony = te
maile planują wyłącznie reguły (przy przejściu firmy na pracę bez BL: najpierw włączyć regułę 12, inaczej „Brak
płatności” nie wyjdzie). Mail „Niski stan” (P2) działa zawsze. Dwie reguły z tym samym szablonem maila wysyłają go
dwa razy (każda reguła ma własną okazję), tak jak w BL.

## Produkty

| Nr | Akcja BL | Przypisanie |
|---|---|---|
| P1 | Przycisk „Druk etykiety” → wydruk „Etykieta tył” (etykieta produktu) | jest: `lib/wydruki/etykieta-produktu.ts` `etykietaProduktu` (PDF 100 × 50 mm) + agent druku (`agent-druku/`); przycisk w panelu produktu i zlecenie druku - osobne zadanie (ekrany z akcjami / stanowisko) |
| P2 | Stan poniżej progu → e-mail | ta reguła: `mail.niski-stan` - dostępne (`physical − reserved`) < `Product.lowStockThreshold`, jeden plan na przejście poniżej progu (histereza: nowe przejście dopiero po powrocie powyżej progu), adresat biuro firmy; tryb wg `Organization.settings.akcje.trybProduktow` (domyślnie `SUCHO`) |

## Reguły planu akcji (`lib/akcje/`)

| Klucz | Akcje BL | Warunek (poziomowy, z bieżącego stanu) | Okazja (idempotencja) |
|---|---|---|---|
| `mail.brak-platnosci` | 12 | `Order.reminderSentAt` ustawione przez rdzeń; bez `reservationDeadline` → SKIPPED. Nieudana płatność online (znacznik z kanału, nic nie wpłacono): `vars.wariant = nieudana-platnosc`, szablon „Nieudana płatność online” z danymi do przelewu (rachunek i odbiorca z Ustawienia → Dokumenty i faktury → Dane firmy); firma bez rachunku albo bez pełnej nazwy → zwykły „Brak płatności” (plan bez `wariant`, powód z informacją dla biura); przypomnienie nigdy w przeszłości (najbliższe 9:00). Przypomnienie rdzeń ustawia wtedy rano po liczbie dni z Zasad rezerwacji (domyślnie następnego dnia). Wariant liczony drugi raz przy wysyłce i w podglądzie | `PRZYPOMNIENIE` |
| `mail.faktura` | 10 | `WYSLANE` / `ODEBRANE` (w cieniu z BL) + faktura wystawiona (nasza albo BL: ruch lub kopia faktury) | `FV:<numer dokumentu>` |
| `mail.blad-faktury` | 11 | `InvoiceAttempt` FAILED; późniejsza udana próba paczki → SKIPPED | `proba:<idExternal>` |
| `mail.gotowe-do-odbioru` | 14 | `DO_ODBIORU` (w cieniu z BL) | `DO_ODBIORU` |
| `mail.niski-stan` | P2 | dostępne < próg; zamknięcie przejścia, gdy dostępne > próg; produkt bez wiersza stanu pomijany | `ponizej:<n>` |
| `mail.zwrot-przyjety` | brak | zwrot (`Return.kind = ZWROT`) z `receivedAt`, status ≠ `ODRZUCONY` | `zwrot:<id zwrotu>` |
| `mail.reklamacja-przyjeta` | brak | reklamacja (`Return.kind = REKLAMACJA`) z `receivedAt`, status ≠ `ODRZUCONY` | `zwrot:<id zwrotu>` |
| `mail.zwrot-pieniedzy` | brak | zwrot albo reklamacja z `moneyRefundedAt` (zdarzenie `ZWROT_PIENIEDZY`), status ≠ `ODRZUCONY` | `pieniadze:<id zwrotu>` |

Maile o zwrotach (trzy ostatnie wiersze) nie mają odpowiednika w automatach BL i działają tylko z wyłącznikiem firmy
`Organization.settings.akcje.maileZwrotow = true` (Ustawienia → Sprzedaż i kanały → Automatyczne akcje → „Maile do
klienta o zwrotach i reklamacjach”, domyślnie wyłączony, także po presecie firmy; zmiana w AuditLog). Wyłączony = plan
nie tworzy tych wierszy, a wysyłka pomija zaplanowane wcześniej. Włączenie zapisuje chwilę włączenia
(`akcje.maileZwrotowOd`, przy każdym przejściu wyłączony → włączony): maile dotyczą zwrotów odebranych (i pieniędzy
zwróconych) po włączeniu, okno planu = późniejsza z chwil „7 dni temu” i „włączenie”; wysyłka pomija zdarzenie sprzed
bieżącego włączenia. Zwrot z zapisanym zwrotem pieniędzy nie dostaje `mail.zwrot-przyjety` ani
`mail.reklamacja-przyjeta`. Korekta bez przesyłki (`KOREKTA`) nie dostaje maila.

Okno reguł zamówień: zmiany z ostatnich 7 dni (`OKNO_MS`) - pierwszy przebieg nie planuje maili do całej historii.
Zmienne planu (`PlannedAction.vars`) to tylko numery, kwoty, daty i SKU; treść maila renderuje się na żądanie w panelu
z danymi firmy (`lib/akcje/panel.ts`, `lib/akcje/podglad.ts`): nazwa sklepu i nadawca z Ustawienia → Komunikacja
i poczta → Poczta, stopka z Ustawienia → Dokumenty i faktury → Dane firmy, treść z szablonów firmy, pozycje zamówienia
i numer faktury z programu do faktur, tak jak w wysyłce. Bez imienia i adresu klienta; PDF faktury nie jest pobierany.
Brakujące ustawienia (np. adres firmy w stopce, adres do odpowiedzi, adres odbioru osobistego) podgląd wypisuje nad
treścią zdaniem z drogą do ekranu, a w treści stoi znacznik „[brak: …]”. Dane fikcyjne (sklep „Żółwik”) zostają
tylko w podglądzie edytora szablonów. Maile o zwrotach i reklamacjach pokazują zwrócone produkty tak, jak w wysyłce;
gdy maile o zwrotach są wyłączone albo zwrotu nie ma już przy zamówieniu, podgląd mówi, że mail nie wyjdzie.
Szablon „Niski stan” jest w `lib/maile`.

`dueAt` (dzień w panelu) to chwila zdarzenia, nie chwila przebiegu workera: „Faktura” = później z (faktura, ostatnia
zmiana zamówienia), w cieniu później z (faktura, chwila bieżącego statusu z dziennika BL), a bez tej chwili sama
chwila faktury; „Gotowe do odbioru” = ostatnia zmiana zamówienia, w cieniu chwila zmiany statusu z dziennika BL,
a bez niej odczyt kopii BL ze statusem „Do odbioru”; oba nie później niż teraz. Zaległość z okna
(pierwszy przebieg po deployu, przestój workera) trafia więc do swojego dnia, nie do „dziś”. Wiersz już zapisany
w `PlannedAction` się nie zmienia (`skipDuplicates`), także gdy chwila z dziennika przyjdzie później.

Wejście do ekranu: menu → Przejście z BaseLinkera → „Maile do klientów: podgląd” albo Pulpit → przycisk „Maile do klientów: podgląd” (adres `/akcje`, każda
rola z `panel.podglad`). Ekran nie ma własnej pozycji w menu (zasada: nowy ekran panelu wewnętrznego = przycisk
w istniejącym ekranie).

### Ograniczenia cienia i różnice wobec BL (przegląd 28.10.2026)

- **Reguły 10 („Faktura”) i 14 („Gotowe do odbioru”) w cieniu biorą status z BL.** W trybie `--cien`
  nic nie przesuwa `Order.status` do `WYSLANE` / `ODEBRANE` / `DO_ODBIORU` (robią to tylko ekrany,
  `lib/rdzen/przejscia.ts`), więc dla konta z `ChannelConfig.statusMode = CIEN` status zamówienia to rodzina statusu
  z kopii nagłówka BL (`BlOrderSnapshot.statusName` → `blStatusFamily`, para po `Order.blOrderId`). Kopia BL
  rozstrzyga także wtedy, gdy ekran przesunął `Order.status` inaczej. Zamówienie bez kopii BL (niesparowane, firma
  bez BL, kopia bez nazwy statusu) - jak dotąd z `Order.status`. Konto w pracy (`PRACA`) i konto bez konfiguracji: bez
  zmian.
- **Kopie statusów BL poza oknem porównania: dziennik zdarzeń BL.** Porównanie
  (`cien-bl-porownanie`, co 10 min) pobiera `getOrders` tylko dla zamówień potwierdzonych w oknie
  `CIEN_OKNO_GODZINY` + doba zapasu (domyślnie 48 h). Starsze zamówienia odświeża dziennik BL (`getJournalList`,
  tylko odczyt, `logs_types: [18]` = zmiana statusu; `lib/cien/dziennik-bl.ts`) wywoływany wewnątrz
  `runBlComparison` po zapisie kopii z okna: najnowsze zdarzenie zamówienia ustawia w istniejącej kopii status,
  nazwę statusu, `fetchedAt` = chwila przebiegu oraz `statusChangedAt` / `statusChangedToId` (chwila i status
  zdarzenia). Kursor per firma: `BlJournalCursor.lastLogId` (wpisy o id ≤ kursor pomijane), przesuwany po zapisaniu
  zdarzeń - powtórka przebiegu daje ten sam stan. Zdarzenie zamówienia bez kopii BL to licznik
  (`journal.withoutSnapshot` w wyniku porównania), nie błąd. Błąd dziennika nie psuje porównania (`blErrors`,
  `journal.error`). Chwili ufamy tylko, gdy `statusChangedToId = statusId`; gdy getOrders odczytał kopię później
  i z innym statusem, kopia jest nowsza, zdarzenie jej nie cofa, a chwili nie znamy.
  - **Warunek: metoda `getJournalList` musi być włączona w ustawieniach API konta BL.** Wyłączona może zwrócić pustą
    odpowiedź, więc pusty dziennik nie jest dowodem braku zmian. Alert `BL_DZIENNIK_MILCZY` (raz na epizod, nie co
    dzień): getOrders albo odświeżanie zapasowe widzą zmianę statusu, a dziennik od doby nie dał żadnego zdarzenia;
    zamyka go pierwsze zdarzenie dziennika. Alert `BL_DZIENNIK_BLAD` (raz na epizod): BL od doby odpowiada błędem na
    `getJournalList` (np. metoda niewłączona), licząc od ostatniego udanego odczytu albo od założenia kursora (kursor
    powstaje przed pierwszym odczytem); zamyka go pierwszy udany odczyt, pojedynczy błąd przejściowy nie alarmuje.
    Alert `BL_DZIENNIK_LUKA`: kursor bez udanego odczytu ponad 72 h - BL trzyma dziennik 3 dni, część zmian
    przepadła; zostaje otwarty, bo kolejny odczyt tych zdarzeń nie przywróci.
  - **Kolejność strony dziennika (do sprawdzenia na żywo przed włączeniem):** kursor po stronie
    to największe id wpisu, co jest szczelne tylko przy stronie posortowanej rosnąco od `last_log_id`. Jeśli BL
    zwraca N **najnowszych** wpisów, wpisy między kursorem a tą stroną przepadną. Sprawdzenie: jedno wywołanie
    `getJournalList` z `last_log_id: 0` i `logs_types: [18]` na koncie pierwszej firmy (kolejność id, liczba wpisów, nazwa pola
    id, czy `last_log_id` jest włączne); przy kolejności malejącej pętla musi iść po `min` i czytać aż do kursora.
  - **Zapas, gdy dziennik milczy albo ma lukę:** kopie sparowane z `Order.blOrderId`, tylko w statusach, które mogą
    jeszcze dać plan: bez rodzin końcowych (Wysłane, Odebrane, Anulowane), bez „E-book” i bez statusów spoza mapy
    albo spoza `getOrderStatusList` (reguły ich nie używają; zamówienie na stałe w „E-book” nie zjada odświeżeń),
    bez odczytu od ponad doby - `getOrders` z `order_id`, najstarsze najpierw, do 60
    na przebieg (`REFRESH_MAX_PER_RUN`; limit BL 100 zapytań/min). Ta ścieżka nie zna chwili zmiany statusu, więc
    plan dostaje dzień jak bez dziennika, a odświeżenie przychodzi z opóźnieniem do doby (plus kolejka). Zamówienie
    usunięte w BL: `fetchedAt` podbite, liczone w `refresh.gone`.
  - **Dzień planu bez chwili z dziennika:** „Faktura” dostaje dzień faktury (w BL faktura powstaje przy „Do
    realizacji”, akcja 7, a mail idzie przy „Wysłane”), więc rozkład na dni przesuwa się o czas realizacji. Porównanie
    z BL rób wtedy oknem 7 dni, nie dzień do dnia. Gdy kopia ma chwilę bieżącego statusu z dziennika: później z
    (faktura, ta chwila). Jeśli między dwoma przebiegami zamówienie przeszło Wysłane → Odebrane, chwila dotyczy
    „Odebrane” (późniejsza niż wysyłka) - rzadkie, w liczbach okna bez znaczenia.
- **Czego nadal nie widać:**
  - **pierwsza doba po wdrożeniu.** „Gotowe do odbioru”: pierwszy przebieg wpisze wszystkie bieżące „Do odbioru”
    z kopii odczytanych w ostatnich 7 dniach - dzień wdrożenia będzie zawyżony (kopie bez chwili z dziennika dostają
    dzień odczytu). „Faktura”: zaległość rozłoży się na dni faktur do 7 dni wstecz i zmieni liczby wcześniejszych dni.
    Dotyczy to też wdrożenia dziennika: odświeżone kopie dołożą zaległe plany. **Liczby dnia brać od
    drugiej pełnej doby po wdrożeniu;**
  - **status BL spoza mapy 7.1** (`NIEZNANY`, np. własny „Gotowe do odbioru”, który nie zaczyna się od „Do
    odbioru”) = brak planu, bez ostrzeżenia w planie. Sprawdź `BL_NIEZNANY` w raporcie rozjazdów (porównanie z BL);
  - zmiany sprzed pierwszego odczytu dziennika starsze niż 3 dni i zmiany w czasie luki > 72 h - nadrabia je tylko
    zapas (bez chwili zmiany).
- **Źródło faktury w cieniu: kopia faktury BL.** Dla konta w cieniu faktura to także
  `BlInvoiceSnapshot` z `kind = 'normal'`, ustawionym `orderId` i wynikiem z `WYNIKI_FAKTURY_BL` (`ZASTOSOWANA`,
  `BEZ_WZ`, `NIC_DO_ROZLICZENIA`, `BEZ_STANU` - sam e-book), obok ruchu `BL_INVOICE` i naszej
  `InvoiceAttempt`. Faktura BL z `outcome NIC_DO_ROZLICZENIA` (zamówienie bez rezerwacji: pozycje niezmapowane,
  cyfrowe, przyjęte jako FULFILLED) ruchu `BL_INVOICE` nie tworzy, a plan już ją liczy. Numer dokumentu jak w ruchu
  (`externalNumber ?? number`), więc ruch i kopia tej samej faktury to jedna okazja `FV:<numer>`. Okno po dacie
  faktury (`BlInvoiceSnapshot.dateAdd`, 7 dni), nie po `Order.updatedAt` - faktura dołożona po tygodniu bez zmian
  zamówienia też daje plan. Bezpiecznik: kopia faktury jest w oknie także po chwili rozliczenia przez
  cień (`appliedAt` w ostatnich 7 dniach) - faktura z 1.11 rozliczona 9.11 dalej daje plan. Nadal nie łapie faktury,
  której data i rozliczenie są starsze niż 7 dni, a wysyłka w BL przychodzi później (np. faktura 1.11 rozliczona
  1.11, wysyłka 9.11): BL mail wyśle, plan go nie zobaczy. `dueAt` = chwila faktury w BL (przy ruchu i kopii - data
  z kopii), a z chwilą statusu z dziennika - później z obu, nie później niż teraz.
  Warunek statusu (Wysłane / Odebrane w BL) zostaje. Czego nadal nie widać: faktury jeszcze nierozliczonej przez cień
  (`outcome` puste: czeka na zamówienie albo WZ), korekt i faktur `POZA_CIENIEM` (nie dają maila); bez chwili statusu
  z dziennika dzień planu to dzień faktury, nie dzień wysyłki (wyżej). Zamówienie z samym
  e-bookiem, które w BL zostaje w statusie „E-book” (nie Wysłane), planu nie dostaje - tak samo jak w BL.
- **„Błąd faktury” w cieniu 0** - faktur w cieniu nie wystawiamy.
- **„Gotowe do odbioru” raz na zamówienie** (okazja stała `DO_ODBIORU`): zamówienie, które z Do odbioru poszło do
  wyjaśnienia i wróciło, nie dostaje drugiego planu, a BL wysłałby ponownie. Świadoma różnica.
- **„Brak płatności” SKIPPED** dla zamówień opłaconych w ciągu ~5 min między przypomnieniem rdzenia a przebiegiem
  workera: BL by wysłał, my liczymy jako pominięte (mail bez daty anulowania jest niedozwolony). Przy porównaniu liczb
  z BL kolumnę `pominiete` tej reguły zaliczać po stronie „wysłałbym”.
