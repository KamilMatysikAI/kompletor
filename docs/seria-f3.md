# Seria F3: 7 dni z `ok = true` w raporcie rozjazdów

Ustalenie z 03.11.2026. Kod: `lib/cien/raport-dzienny.ts` (`buildDailyReport`), lustro stanów:
`lib/cien/odczyt-stanow-wfirmy.ts` + zadanie workera `rdzen-wfirma`.

## Co liczy seria

Seria F3 to liczba kolejnych dni (raport dzienny za dzień poprzedni, `ShadowDailyCheck` rodzaju `raport-rozjazdow`)
z `ok = true`, liczona **od pierwszego dnia z działającym lustrem wFirmy**, czyli od pierwszego raportu, w którym
`stocks.mirrorLastFullReadAt` nie jest puste. Kryterium przełączenia: 7 takich dni z rzędu.

## Definicja `ok`

```
ok = sprzedaż dnia zgodna (ShadowDailyCheck `sprzedaz-dnia`, ok)
  && stalePending.count == 0          // ruchy IN_FLIGHT i APPLIED starsze niż 24 h (zaległość systemu)
  && overcommit.count == 0            // nadmiar rezerwacji dłużej niż 30 min: reserved > max(0, physical)
  && invariants.count == 0            // naruszenia niezmienników 5.4
  && stocks.physicalVsBlForOk == 0    // rozjazdy stanu poza tolerancją (niżej)
```

`officeItems` (lista „Dla biura”) **nie** wchodzi do `ok`.

**Nadmiar.** Liczy się produkt z `overcommitSince` starszym niż 30 min, którego rezerwacje przekraczają stan
liczony od zera (`reserved > max(0, physical)`). Znacznik nadmiaru bez takiej nadwyżki, w praktyce ujemny fizyczny
z ruchów `MANUAL` przy rezerwacjach 0 (wydane bez faktury, stan wFirmy 0), trafia do `overcommit.noExcess` /
`noExcessSkus`: widoczny w raporcie, **nie** zeruje `ok` (to pozycja biura, nie zamówienie ponad stan). Fizyczny −1
przy rezerwacji 1 dalej jest nadmiarem.

**Stany z jednej chwili.** Po każdym udanym imporcie katalogu (kopia stanów BL) worker zleca pełny odczyt
lustra wFirmy, a raport z harmonogramu czeka na zlecony odczyt najwyżej 3 h po końcu dnia (przy wyłączonym lustrze
`CIEN_LUSTRO_WFIRMY=0` nie czeka). Gdy mimo to ostatni pełny odczyt jest starszy niż kopia BL, raport ma
`stocks.mirrorBeforeBl = true` i ostrzeżenie w sekcji 2: zmiany w wFirmie z tego okna (PZ, dokumenty spoza
Kompletora) wyglądają wtedy jak rozjazdy (przypadek 04.11: lustro 02:55, BL 21:03).

### Tolerancja stanów

Porównanie: stan fizyczny u nas (`Stock.physical`) kontra stan BL `accounting_1` (kopia z importu katalogu) dla
produktów `STOCKED`, aktywnych, z czytelnym stanem BL.

- Stan BL produktu to jedna wartość na towar wFirmy: rekordy BL wskazujące ten sam towar liczą się raz (przy różnych
  wartościach maksimum i pozycja `blConflicting`), rekordy nieobecne w ostatnim udanym imporcie katalogu (skasowane
  w BL) są pomijane (`blStaleRecords`). Rekordy przestemplowane przez import trwający w chwili raportu (`ImportRun`
  `RUNNING` nowszy niż ostatni udany) liczą się jako bieżące, także gdy trwający import przestemplował już wszystkie
  rekordy. Filtr wyłącza się tylko wtedy, gdy żaden rekord nie pochodzi z bieżących przebiegów (baza sprzed
  `importRunId`).
- Ilość: 0 szt. dla sztuk; dla kg pełne kilogramy w dół, jak BL (`compareStock`). Sztuki z ułamkiem w BL = stan
  nieczytelny (`blUnreadable`), poza porównaniem i poza `ok`.
- Rozjazd **nie** liczy się do `ok`, gdy:
  - **„w drodze”**: różnica **mieści się w sumie |delta| ruchów**, które mogły ją spowodować: niepotwierdzonych
    `IN_FLIGHT`/`APPLIED` (BL może już widzieć WZ, lustro jeszcze nie) oraz ruchów (nowy `PendingMovement` po
    `sentAt`, poza `MANUAL` i `CANCELLED`; `StockMovement` `WFIRMA_SYNC`) między starszym a nowszym z odczytów
    `BlProduct.importedAt` i `Stock.wfirmaReadAt`. `CONFIRMED` w oknie się liczy (starszy odczyt BL go nie widział),
    `CANCELLED` nie (nieudana faktura cofa ruch, nie dotknął ani wFirmy, ani naszego stanu). Sam fakt ruchu nie
    wystarcza: przy codziennej sprzedaży okno prawie zawsze ma ruch, więc u nas 10, BL 50 przy sprzedaży 1 szt.
    w oknie to rozjazd liczony do `ok` (u nas 5, BL 7 przy ruchu −2 w oknie: tolerowany).
    Różnica w szt. to zwykła różnica; **dla kg** to odległość w gramach od przedziału, który BL ucięty reprezentuje
    (BL 3 = wFirma miała 3000–3999 g): u nas 2850 g, BL 3 → 150 g, tolerowane przy sprzedaży 250 g w oknie,
    rozjazd przy 100 g. Przy otwartych ruchach `MANUAL` różnica to mniejsza z dwóch: ze stanem z nimi i bez nich,
    więc wydanie bez faktury i sprzedaż w oknie się składają (u nas 10 − 1 − 2 = 7, BL 10, sprzedaż 1 w oknie:
    tolerowane);
  - **ruch biura**: różnicę w całości wyjaśniają ruchy `MANUAL` (stan bez nich równa się BL): to pozycja „Dla biura”.
  - **dokument w wFirmie**: do sumy ruchów „w drodze” dochodzą pozycje dokumentów WZ z wFirmy
    (`WfirmaWzSnapshot`, zadanie `cien-wz-wfirmy`) założonych w tym samym oknie między odczytami. WZ, którego numer
    (albo numer jego faktury) ma już nasz ruch na tym produkcie, liczy się tylko w części, której ten ruch nie obejmuje. Rozjazd dostaje `wzDocs`
    z numerami dokumentów i oznaczenie „dokument w wFirmie (WZ …)”.
- Wyjątek: produkt **bez odczytu lustra** (w firmie nie było jeszcze pełnego odczytu albo `wfirmaReadAt` jest starszy
  niż ostatni pełny odczyt o ponad 26 h, czyli towar nie wrócił w pełnym odczycie) nie dostaje żadnej tolerancji.

Tolerowane rozjazdy zostają na liście z oznaczeniem („w drodze”, „ruch biura”), żeby było widać, że istnieją.

## Lista „Dla biura” (`officeItems`)

- ruchy `ISSUED_WITHOUT_DOCUMENT/MANUAL` > 24 h: wysłane bez faktury;
- ruchy `BL_INVOICE/MANUAL` > 24 h: faktura bez WZ albo z niepełnym WZ;
- inne ruchy `MANUAL` > 24 h;
- zamówienia „Do wyjaśnienia” z kanałów czytanych w cieniu;
- `newSinceYesterday`: ile pozycji powstało w dniu raportu (ruchy `MANUAL` po `sentAt`, zamówienia „Do wyjaśnienia”
  założone tego dnia: zamówienie, które przeszło do „Do wyjaśnienia” później, nie jest liczone jako nowe).

Dlaczego nie zerują serii: w cieniu nikt nie klika „poprawione” / „dokument wystawiony”, więc te pozycje nie schodzą
same i seria zerowałaby się na zawsze. To praca biura w wFirmie, nie błąd Kompletora. Gdy lista nie jest pusta, raport
zakłada jeden alert dziennie `BIURO_DO_WYJASNIENIA` (liczby, numery zamówień BL i SKU, bez danych klientów); alert widać
na pulpicie w „Sytuacje do obsługi”. Nowego kanału wysyłki (mail) nie ma.

## Kiedy seria zaczyna się od zera

- dzień z `ok = false` (dowolny składnik wyżej);
- po naprawie błędu, który zmienia sposób liczenia (nowa wersja raportu): liczymy od pierwszego dnia po wdrożeniu;
- po przerwie lustra dłuższej niż doba (wyłącznik `CIEN_LUSTRO_WFIRMY=0`, brak kluczy, kolejka wstrzymana limitem):
  produkty wypadają z tolerancji („bez odczytu lustra”), a ruchy `APPLIED` przekraczają 24 h: raport sam zrobi się
  czerwony; seria liczy się od pierwszego zielonego dnia po powrocie lustra;
- brak raportu za dzień (worker stał) przerywa serię.
