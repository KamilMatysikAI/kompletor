# Stan magazynu i dokumenty sprzedaży

Kompletor działa z programem do faktur i bez niego. Firma bez wFirmy i bez żadnego programu przyjmuje zamówienie, pakuje je, wysyła i zamyka, a towar schodzi ze stanu sam.

## Gdzie to jest

- **Ustawienia → Dokumenty i faktury → Dane firmy** (`/ustawienia/firma`): nazwa, NIP, adres, e-mail kontaktowy, e-mail biura, telefon, rachunek bankowy. Widzi osoba z uprawnieniem „Ustawienia”.
- **Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży** (`/ustawienia/dokumenty`): kto prowadzi stan magazynu, program do faktur, wyłącznik „Wystawiaj faktury z Kompletora”, kiedy wystawiać dokument, seria numeracji dla KSeF, pozycja wysyłki. Ta sama rola.
- **Finanse → Faktury** (`/faktury`, menu boczne, grupa „Finanse”): lista faktur i korekt ze wszystkich programów (opis niżej, „Lista faktur i korekt”). Widzi osoba z uprawnieniem „Faktura na karcie zamówienia” (rola Biuro i Właściciel); PDF dodatkowo wymaga uprawnienia do danych klienta.
- **Zamówienia → karta zamówienia → sekcja „Dokument sprzedaży”** (`/zamowienia/<id>`): stan faktury, numer z wFirmy, przycisk **„PDF faktury”** (po wystawieniu) i **„Ponów fakturę”** (po błędzie). Przyciski widzi osoba z uprawnieniem „Faktura na karcie zamówienia” (rola Biuro i Właściciel ma je od razu); PDF dodatkowo wymaga uprawnienia do danych klienta, bo faktura niesie dane nabywcy. Firma bez programu widzi tu informację, że nie wystawia faktur z Kompletora.

## Kto prowadzi stan magazynu

Dwie możliwości:

| Ustawienie | Kiedy towar schodzi ze stanu | Jak poprawić stan |
|---|---|---|
| Kompletor prowadzi stan sam | Przy „Do wysyłki” albo „Do odbioru”, od razu po spakowaniu. Bez faktury i bez przycisku „Wyślij bez faktury”. | Korekta stanu na karcie produktu (stan po przeliczeniu półki i powód). |
| Lustro magazynu wFirmy | Fakturą z dokumentem WZ w wFirmie. Kompletor czyta stan z wFirmy i porównuje. | Dokumentem w wFirmie. |

Nowa firma z kreatora dostaje „Kompletor prowadzi stan sam”. Lustro wFirmy wymaga magazynu połączonego z magazynem wFirmy. Zmiany nie da się zapisać, gdy w magazynie jest faktura w drodze albo ruch do potwierdzenia w wFirmie: najpierw trzeba je rozliczyć.

Przy stanie prowadzonym przez Kompletor ponowne kliknięcie „Do wysyłki” nie zdejmuje towaru drugi raz. Zestaw schodzi składnikami. W historii produktu wydanie widać jako ruch „wydanie zamówienia”.

## Program do faktur

| Program | Co dziś robi |
|---|---|
| Bez programu do faktur | Kompletor nie wystawia dokumentów. Zamówienie zamyka się po wysyłce bez faktury, bez alertu „wydane bez dokumentu” i bez wpisu do ręcznego zamknięcia. E-book kończy się przyciskiem „Odebrane”. Fakturę, jeśli klient o nią prosi, wystawiasz poza systemem. |
| wFirma | Kompletor wystawia faktury w wFirmie, gdy włączysz „Wystawiaj faktury z Kompletora” (opis niżej). Bez tego czyta z wFirmy stany i faktury, a faktury wystawia BaseLinker albo biuro. |
| KSeF bezpośrednio | Kompletor nadaje numer z serii, wysyła fakturę FA(3) do KSeF i zapisuje numer KSeF i UPO, gdy włączysz „Wystawiaj faktury z Kompletora”. PDF z naszego generatora. Domyślnie środowisko testowe KSeF. Opis niżej („KSeF bezpośrednio”) i w [KSeF bez wFirmy](integracje/ksef.md). |

Nowa firma z kreatora dostaje „Bez programu do faktur”, a nie wFirmę. Firma założona wcześniej, która nie wybrała programu, ma wFirmę, jeśli jej magazyn jest połączony z wFirmą, a w przeciwnym razie „Bez programu”.

Kolejne programy (np. Fakturownia, inFakt, iFirma) dochodzą jako integracje. Jak dopisać taki program: [Integracje](integracje/README.md), sekcja „Jak dopisać program do faktur”.

## Kiedy wystawiać

- **Dokument powstaje**: po spakowaniu, przy „Do wysyłki / Do odbioru” albo po nadaniu.
- **Tylko gdy klient prosi o fakturę**: dokument tylko dla zamówień z prośbą o fakturę (np. z NIP).
- **Dokument przed wysyłką**: towar nie wyjdzie z magazynu, dopóki dokument nie jest wystawiony. Wymaga programu do faktur. Przy stanie z wFirmy faktura jest zawsze przed wysyłką, bo to ona zdejmuje towar.
- **Rodzaj dokumentu**: faktura. Paragonu nie wystawia jeszcze żaden podłączony program.
- **Korekty faktur przy zwrotach z Kompletora** (tylko z programem wFirma i przy włączonym „Wystawiaj faktury z Kompletora”, domyślnie wyłączone): przycisk „Zleć korektę faktury” na karcie zwrotu wystawia korektę w wFirmie. Wyłączone = korektę wystawiasz w wFirmie sam i kończysz zwrot przyciskiem „Korekta wystawiona poza Kompletorem” ([Zwroty i reklamacje](zwroty-i-reklamacje.md)).
- **WZ przy wysyłce bez faktury** (tylko z programem wFirma i przy włączonym „Wystawiaj faktury z Kompletora”): wyjście awaryjne, gdy faktura z Kompletora nie wychodzi i zamówienie wysyłasz przyciskiem „Wyślij bez faktury”. Kompletor zakłada wtedy w wFirmie dokument WZ (najwyżej 10 wysyłek na przebieg, co 2 minuty), zamiast zostawiać pozycję „Wydane bez dokumentu” do ręcznego zamknięcia. Po założeniu WZ pozycja zamyka się sama, a stan potwierdza odczyt z wFirmy. Jeśli wFirma odmówi (np. towar bez powiązania z wFirmą), pozycja zostaje do ręcznego zamknięcia i pojawia się alert „WZ nie wystawione”; Kompletor nie wysyła tego WZ ponownie. Jeśli połączenie z wFirmą się przerwie i nie wiadomo, czy WZ powstało, pojawia się alert „Nie wiadomo, czy dokument WZ powstał w wFirmie”: Kompletor szuka dokumentu przy każdym przebiegu, ale drugiego nie wystawi. Sprawdź wtedy w wFirmie, czy WZ jest; jeśli nie ma, wystaw go ręcznie. W obu przypadkach zamknij pozycję przyciskiem „Dokument wystawiony”: Zamówienia → numer zamówienia → sekcja „Dokument sprzedaży” → przycisk „Dokument wystawiony” (osoby z uprawnieniem „Faktura na karcie zamówienia”, m.in. właściciel i biuro). Ten sam przycisk zamyka każdą pozycję „Wydane bez dokumentu” (także bez włączonego WZ), razem z alertami o niej. WZ dostają tylko wysyłki od chwili włączenia tej opcji (i wystawiania faktur z Kompletora): wcześniejsze wysyłki bez faktury Kompletor zostawia biuru, bo zwykle mają już dokument wystawiony ręcznie. Firma, która fakturuje poza Kompletorem (BaseLinker, ręcznie w wFirmie), tej opcji dziś nie użyje: wymaga ona włączonego wystawiania faktur z Kompletora.

### Dokumenty WZ z wFirmy

Przy stanie prowadzonym w wFirmie Kompletor co pół godziny czyta z wFirmy dokumenty WZ (tylko odczyt) i łączy je z zamówieniami: po numerze faktury, do której jest WZ (faktura z BaseLinkera wskazuje zamówienie), po numerze zamówienia w opisie albo, tylko gdy faktury nie ma w kopii z BaseLinkera (np. faktura wystawiona ręcznie w wFirmie), po pozycjach: dokładnie jedno opłacone albo pobraniowe zamówienie z tymi towarami i ilościami. Gdy faktura wskazuje zamówienie BaseLinkera, którego Kompletor jeszcze nie połączył ze swoim, WZ czeka na to połączenie (po numerze zamówienia w sklepie) i nigdy nie łączy się wtedy po samych ilościach. Gdy firma ma BaseLinkera, WZ do faktury, której Kompletor nie widzi w kopii faktur z BaseLinkera, łączy się po pozycjach dopiero wtedy, gdy odczyt faktur z BaseLinkera przeszedł w całości już po założeniu WZ (i gdy znany jest numer tej faktury); przy zatrzymanym odczycie faktur (np. nieważny token BaseLinkera albo błędy odczytu w BaseLinkerze) WZ czeka, zamiast trafić do cudzego zamówienia. WZ bez zamówienia albo czekający na fakturę z BaseLinkera dłużej niż dobę daje raz dziennie alert „Dokumenty WZ z wFirmy bez zamówienia” z numerami dokumentów. Dzięki temu zamówienie, którego faktura powstała, zanim Kompletor zaczął ją widzieć, przestaje trzymać rezerwację, a brak na towarze, który i tak wyszedł z magazynu, zamyka się. Zamówienie połączone po pozycjach dostaje alert do sprawdzenia, czy to właściwe zamówienie. W raporcie rozjazdów spadek stanu z takiego WZ jest opisany numerem dokumentu („dokument w wFirmie (WZ …)”), a nie jako różnica bez przyczyny.

### Pozycje „Do poprawy w wFirmie” i przycisk „Poprawione w wFirmie”

**Gdzie to jest:** Braki towaru → zakładka „Do poprawy w wFirmie” (`/braki?lista=wfirma`) → przycisk **„Poprawione w wFirmie”** w wierszu pozycji. Przycisk działa dla osób z uprawnieniem „Faktura na karcie zamówienia” (rola Biuro i Właściciel ma je od razu); pozostali widzą go nieaktywnego z powodem. Alerty, które każą kliknąć „Poprawione w wFirmie”, na Pulpicie mają link do tej listy.

Na liście są pozycje, które pomniejszają stan w Kompletorze, a których wFirma jeszcze nie pokazuje: faktura bez WZ (także faktura z BaseLinkera bez WZ), wydanie bez dokumentu, „nie ma na półce” z pakowania, uszkodzony zwrot do RW. Wiersz pokazuje produkt, ilość, rodzaj, numer dokumentu i link do zamówienia.

Kolejność: najpierw popraw dokumenty w wFirmie (faktura z WZ, WZ do faktury, RW albo stan), dopiero potem kliknij. Po kliknięciu stan w Kompletorze wraca do stanu z wFirmy: pozycja przestaje pomniejszać stan, a Kompletor w ciągu kilku minut czyta stan towaru z wFirmy. Kliknięcie przed poprawką w wFirmie podbije stan o tę pozycję, choć towaru nie ma. Przycisk niczego nie wysyła do wFirmy, BaseLinkera ani sklepów i działa tak samo na kontach w trybie „Tylko podgląd”. Kliknięcie zapisuje się w historii zamówienia („Biuro potwierdziło poprawkę w wFirmie”) i w dzienniku zmian z osobą. Drugie kliknięcie nic nie zmienia.

**Faktura z BaseLinkera bez WZ, której WZ jednak jest w wFirmie.** BaseLinker dopisuje do faktury numer z wFirmy dopiero kilka sekund po jej wystawieniu. Gdy Kompletor skopiował fakturę wcześniej, przed każdą kolejną próbą i przed uznaniem „bez WZ” czyta ten numer z BaseLinkera jeszcze raz (najwyżej 20 faktur w przebiegu, tylko faktury bez numeru z wFirmy) i szuka WZ po nim. Faktura już rozliczona bez WZ jest sprawdzana jeszcze przez 60 dni, coraz rzadziej (po 10 minutach, 30 minutach, 2 godzinach, potem co 6 godzin): gdy BaseLinker poda numer z wFirmy, a w wFirmie jest WZ na całą pozycję, pozycja zamyka się sama, jak przy zwykłej fakturze z WZ, bez drugiego zdjęcia stanu (historia zamówienia: „Faktura z BaseLinkera rozliczona dokumentem WZ z wFirmy”). Gdy faktury z BaseLinkera nie ma w wFirmie wcale, pozycja zostaje do czasu, aż biuro przeniesie fakturę do wFirmy (wtedy zamknie się sama) albo kliknie „Poprawione w wFirmie” po poprawce.

**Czego ta lista nie robi:** nie wystawia dokumentów w wFirmie i nie poprawia stanu w wFirmie (to robi biuro w wFirmie); nie cofa „nie ma na półce” (to przycisk „Jednak jest na półce” na karcie zamówienia); zamknięcia „wydane bez dokumentu” całego zamówienia naraz służy przycisk „Dokument wystawiony” (Zamówienia → numer zamówienia → sekcja „Dokument sprzedaży”).

Te zasady stosuje dziś wystawianie w wFirmie przy stanie prowadzonym przez Kompletor. Przy stanie z wFirmy faktura zdejmuje towar, więc powstaje zawsze po spakowaniu, dla każdego zamówienia (ekran to pisze przy „Kiedy wystawiać”). KSeF i kolejne programy dostaną wystawianie razem ze swoją integracją.

## Wystawianie faktur w wFirmie

**Jak włączyć:** Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → program „wFirma” → zaznacz **„Wystawiaj faktury z Kompletora”** → „Zapisz zmiany” w pasku na dole ekranu (cały ekran, także „Kto prowadzi stan magazynu”, zapisuje się jednym przyciskiem; zmiana źródła stanu i programu do faktur naraz zapisuje się razem albo wcale). Potrzebne są klucze wFirmy w konfiguracji firmy. Wyłączone (domyślnie) = Kompletor niczego nie wystawia, nawet z kluczami.

**Co się dzieje po włączeniu:**

1. Co 2 minuty kolejka wFirmy bierze zamówienia, które doszły do momentu wystawienia, i wystawia fakturę w wFirmie. Na karcie zamówienia widać „W kolejce”, potem „Wystawiona” z numerem z wFirmy (np. „FV 15/11/2026”).
2. Przy stanie z wFirmy faktura idzie po spakowaniu i zdejmuje towar dokumentem WZ, jak dotąd w BaseLinkerze. Przy stanie prowadzonym przez Kompletor faktura idzie przy wybranym momencie i nie rusza stanu (stan zszedł przy „Do wysyłki”); towar bez powiązania z kartoteką wFirmy trafia na fakturę z nazwy.
3. Faktura bierze pozycje, ceny i wysyłkę z zamówienia, tą samą metodą, którą porównujemy z fakturami BaseLinkera (polecenie `faktury-podglad`). Gdy pozycje faktury różnią się od tego, co spakowano (np. brak przy pakowaniu), faktura nie wychodzi: zobaczysz błąd z listą różnic.
4. Nabywca: dane do faktury z zamówienia. Klient bez danych do faktury (konsument) dostaje fakturę na imię, nazwisko i adres z dostawy, bez NIP. Klient, który prosi o fakturę na firmę, a dane są niekompletne, dostaje błąd „Brak danych nabywcy” zamiast faktury bez NIP. Tak samo, gdy w adresie dostawy jest tylko nazwa firmy (bez imienia i nazwiska) i nie ma NIP-u: decyduje biuro. Druga paczka zamówienia (podział albo „dośle później”) dostaje własną fakturę na swoje pozycje, z nabywcą z zamówienia głównego. Wysyłka jest na fakturze pierwszej paczki.
5. Zamówienia sklepów w trybie „Tylko podgląd” zostają poza wystawianiem: ich fakturę wystawia BaseLinker.
6. Bez zaległości: faktura nie powstaje dla zamówień sprzed włączenia. Przy stanie z wFirmy liczy się spakowanie po włączeniu; ekran Dokumenty sprzedaży przy wyłączonym wystawianiu pokazuje, ile spakowanych zamówień czeka bez faktury (te wystaw jak dotąd i kliknij na karcie „Wyślij bez faktury”). Przy stanie prowadzonym przez Kompletor liczy się dojście do statusu z „wystawiaj przy” albo dalszego po włączeniu (np. spakowane wcześniej, a przeniesione na „Do wysyłki” po włączeniu, dostaje fakturę przy momencie „po spakowaniu”).
7. Anulowanie przy stanie prowadzonym przez Kompletor nie czeka na fakturę: towar wraca od razu. Jeśli faktura wejdzie już po anulowaniu, zamówienie trafia na listę „do korekty”, a w Alertach pojawia się „Faktura do korekty”.
8. Zamówienie spakowane przed włączeniem wystawiania: karta pisze „Bez faktury z Kompletora: spakowane przed włączeniem wystawiania” (nie „W kolejce”): wystaw fakturę jak dotąd i kliknij „Wyślij bez faktury”.

### Faktura robocza przed przełączeniem

Polecenie dla administratora instancji (bez ekranu w panelu): faktura robocza VAT w wFirmie dla jednego zamówienia, żeby przed przełączeniem z BaseLinkera zobaczyć w wFirmie dokument, który Kompletor wystawi. Treść składa ta sama funkcja co prawdziwa faktura (pozycje, ceny, stawki i kody VAT, forma płatności, nabywca, seria). Różnią się dwa pola: typ dokumentu `normal_draft` (faktura robocza: bez numeru w serii faktur, nie idzie do KSeF; zatwierdzenie tylko w wFirmie) i `id_external` w postaci `pr/<id zamówienia>`, więc Kompletor nigdy nie uzna roboczej za fakturę paczki. wFirma nadaje roboczej numer we własnej numeracji roboczych, np. „WRF 15” (poza serią faktur), i zapisuje `id_external` najwyżej w 32 znakach (dłuższy obcina). `pr/<id zamówienia>` ma 28 znaków; gdyby się nie mieścił, polecenie odmawia przed wysłaniem (kod 2).

```
docker compose exec web kompletor cien faktura-robocza --zamowienie <id albo numer zamówienia>            # na sucho
docker compose exec web kompletor cien faktura-robocza --zamowienie <id albo numer zamówienia> --wykonaj  # zapis roboczej
docker compose exec web kompletor cien faktura-robocza --usun <id dokumentu w wFirmie>                    # usunięcie roboczej
docker compose exec web kompletor cien faktura-robocza --sprawdz <id dokumentu w wFirmie>                 # sam odczyt dokumentu
```

- **Na sucho** nic nie wysyła do wFirmy: wypisuje pola kontrolne (typ, `id_external`, seria, forma płatności, pozycje, sumy, czy nabywca ma NIP), bez nazwy, adresu i NIP-u nabywcy.
- **Co zapisuje w Kompletorze:** nie zapisuje próby faktury, nie zmienia zamówienia, rezerwacji, stanów ani WZ. Nabywcę bierze tą samą drogą co prawdziwa faktura, więc także na sucho zostawia ślad odczytu danych klienta w dzienniku odczytów (automat `system:faktura-robocza`). Gdy zamówienie nie ma jeszcze rekordu klienta, a zapis danych klientów jest włączony, czyta dane z kanału sprzedaży i zapisuje zaszyfrowany rekord klienta, tak samo jak automat po przyjęciu zamówienia.
- **Konto w „Tylko podgląd”:** polecenie potrzebuje rekordu klienta zamówienia w bazie albo włączonego „zapisu w cieniu” firmy. Bez nich kończy się odmową (kod 2) i nic nie idzie do wFirmy. Przełącznik „Wystawiaj faktury z Kompletora” nie jest potrzebny. Potrzebne są klucze wFirmy i kody VAT w ustawieniach firmy.
- **Tylko nabywca bez NIP-u:** `--wykonaj` dla nabywcy z NIP-em albo innym identyfikatorem podatkowym kończy się odmową (kod 2) bez żadnego żądania do wFirmy. Świadomie, dopiero po pierwszej potwierdzonej roboczej: `--takze-z-nip`.
- **Odmowa jak w prawdziwej drodze:** nieznana metoda płatności, brak kodu VAT, brak danych nabywcy = brak roboczej (kod 2).
- **Ponowne `--wykonaj`** dla tego samego zamówienia najpierw szuka roboczej po `id_external` (także w formacie pierwszej próby, `proba-robocza/…` obciętym przez wFirmę do 32 znaków) i nie wystawia drugiej. Zaraz po zapisie polecenie powtarza to wyszukiwanie: jeśli nie widzi nowej roboczej, wypisuje ostrzeżenie „ponowne --wykonaj wystawi drugą” z identyfikatorem dokumentu do usunięcia. Wtedy nie ponawiaj `--wykonaj`.
- **Kontrola po zapisie:** zaraz po zapisie polecenie czyta dokument z wFirmy. Jeśli ma typ inny niż roboczy albo numer spoza numeracji roboczych (numer „WRF n” jest w porządku; numer w serii faktur, np. „FV …” albo serii sklepu, już nie), kończy się komunikatem „ALARM” z identyfikatorem dokumentu i kodem 5: sprawdź dokument ręcznie w wFirmie (PRZYCHODY » SPRZEDAŻ) i nie ponawiaj `--wykonaj`. Polecenie niczego wtedy samo nie poprawia ani nie usuwa.
- **`--sprawdz`** tylko czyta dokument z wFirmy (typ, czy ma numer, `id_external`, czy to robocza próby), bez danych nabywcy i bez żadnego zapisu, np. po ALARMIE „nie udało się odczytać dokumentu po zapisie”.
- **`--usun`** usuwa wyłącznie dokument, który po świeżym odczycie ma typ roboczy, numer pusty albo z numeracji roboczych („WRF n”) i `id_external` `pr/<…>`. Robocza z pierwszej próby (`id_external` `proba-robocza/` plus początek identyfikatora zamówienia, obcięty przez wFirmę do 32 znaków) też, ale tylko gdy ten początek wskazuje dokładnie jedno zamówienie tej firmy. Każdy inny dokument: odmowa (kod 3), nic nie usunięto.
- Kody wyjścia: 0 zrobione, 1 błąd (nic nie zapisano), 2 odmowa, 3 odmowa usunięcia, 4 nie wiadomo, czy robocza powstała (odczekaj 5 minut, sprawdź w wFirmie listę roboczych i sprzedaży, dopiero potem ponów `--wykonaj`), 5 ALARM (nie ponawiaj).
- Robocze trzeba mieć włączone w koncie wFirmy (USTAWIENIA » FAKTURY » METODY FAKTUROWANIA » „Wersje robocze faktur sprzedaży”). Usuń wszystkie robocze przed przełączeniem.

### Kupony, rabaty na całe zamówienie i grosze

Faktura zawsze opiewa na kwotę, którą zapłacił klient, z cenami pozycji po rabacie.

- **Kupon WooCommerce** obniża ceny pozycji już w sklepie, więc Kompletor bierze z zamówienia ceny po kuponie.
- **Rabat na całe zamówienie spoza pozycji** (np. program lojalnościowy albo wtyczka rabatowa, która dodaje do zamówienia ujemną opłatę) Kompletor rozkłada na pozycje jedną regułą: cena za sztukę każdej pozycji razy (wartość towarów po rabacie / wartość przed rabatem), zaokrąglona do grosza, a grosze, których nie da się zmieścić w cenie za sztukę, idą na pierwszą pozycję faktury (pozycja z kilkoma sztukami dostaje wtedy dwie linie różniące się o grosz). Tę samą regułę stosuje BaseLinker, więc pozycje faktury wychodzą te same co do grosza, i to niezależnie od tego, czy rabat rozłożył już odczyt zamówienia ze sklepu (zamówienie zapisane z cenami po rabacie), czy dopiero faktura (zamówienie zapisane z cenami sprzed rabatu): faktura nie przelicza cen drugi raz, tylko dokłada grosze reszty na pierwszą pozycję. Granica „grosze reszty” to pół grosza na sztukę oferty: prawdziwy rabat albo dopłata w tej granicy (np. 200 szt. po 5,00 zł i rabat 1,00 zł) idzie w całości na pierwszą pozycję zamiast proporcjonalnie; kwota faktury się zgadza, różni się tylko podział między pozycje.
- **Ujemna opłata w WooCommerce to rabat na towar**, bez względu na nazwę opłaty (sklep rozkłada jej podatek na pozycje koszyka tak samo). Kompletor nie zgaduje po nazwie, czy to bon, saldo czy rabat na dostawę. Bezpiecznik: rabat większy niż **limit rabatu** (domyślnie 50% wartości pozycji) nie jest rozkładany. Odczyt zamówienia zostawia wtedy ceny bez rabatu, a faktura nie wychodzi z błędem „Pozycje są droższe niż kwota zamówienia”: sprawdź zamówienie i wystaw fakturę ręcznie. Limit jest jeden: ustawienie firmy `faktury.rabatMaksProcent` (0–100). Ten sam limit stosuje odczyt zamówienia ze sklepu i faktura, liczony od tej samej różnicy (wartość pozycji minus zapłacona kwota bez kosztu wysyłki), więc nie zdarzy się, że odczyt rabat odrzuci, a faktura go przyjmie, ani odwrotnie. Faktura nie wychodzi też, gdy rabat zrobiłby z płatnej pozycji pozycję za 0 zł (błąd „Pozycja wyszłaby za 0 zł po rozłożeniu rabatu”).
- **Gratis (pozycja za 0 zł)** zostaje na fakturze za 0 zł: rabat i grosze reszty trafiają na pierwszą płatną pozycję. Zamówienie z rabatem, w którym są same gratisy, nie dostaje faktury automatycznie (błąd „Rabat na całe zamówienie, a w zamówieniu nie ma płatnej pozycji”).
- **Wysyłka** na fakturze to koszt dostawy podany przez sklep albo platformę. Gdy pozycje i wysyłka razem są droższe niż zapłacona kwota, różnica jest rabatem na towar (wysyłka się nie zmienia), o ile mieści się w limicie rabatu. Gdy zapłacona kwota jest wyższa o więcej niż grosze z zaokrągleń (np. opłata za pobranie), nadwyżka idzie razem z wysyłką.
- Gdy kanał nie podał kosztu wysyłki, wysyłka to zapłacona kwota minus pozycje. Jeśli wtedy pozycje są droższe niż zapłacona kwota, faktura nie wychodzi i pojawia się błąd „Pozycje są droższe niż kwota zamówienia”: wystaw ją ręcznie.
- **Zamówienie zapisane z cenami sprzed rabatu** (przyjęte, zanim Kompletor zaczął rozkładać rabat przy odczycie) ma na karcie ceny sprzed rabatu, a rabat liczy dopiero faktura. Paczka wysłana osobno (podział zamówienia, „dośle później”), korekta i zwrot biorą jednak cenę z zamówienia, a opłata za pobranie siedzi w zapłaconej kwocie. Dlatego takie zamówienie **z paczką dodatkową albo za pobraniem** i z rabatem większym niż 1% wartości pozycji nie dostaje faktury automatycznie (mniejsza różnica to grosze, np. po usunięciu pozycji z zamówienia, i rozkłada się na pozycje bez zmiany sumy): pojawia się komunikat z instrukcją (faktura ręcznie na zapłaconą kwotę, potem „Wyślij bez faktury” i „Dokument wystawiony” na karcie zamówienia). Ceny takich zamówień przelicza jednorazowo przeliczenie przed przeniesieniem danych na produkcję; po nim ten komunikat dotyczy tylko kanałów, które podają rabat poza pozycjami.

## Lista faktur i korekt

**Finanse → Faktury** (`/faktury`), jak „Faktury i paragony” w BaseLinkerze.

- **Zakładki** „Faktury” i „Korekty”. Domyślnie bieżący miesiąc; „Rok: Wszystkie” pokazuje całość (najnowsze 100, dalej zawęź filtry).
- **Filtry:** seria (początek numeru, np. `FV`), numer (faktury, zamówienia albo numer KSeF), miesiąc, rok, nabywca po e-mailu albo telefonie (nazwisk nie przeszukujemy, bo są zaszyfrowane), „Błąd wystawienia”.
- **Kolumny:** numer z programu (pod spodem identyfikator w Kompletorze), zamówienie (link do karty), nabywca (firma albo osoba prywatna), brutto, data, stan (wystawiona, w kolejce, błąd, wysłana do KSeF z numerem KSeF) z programem i powodem błędu.
- **Akcje w wierszu:** „PDF” (z wFirmy albo z generatora Kompletora przy KSeF), „Ponów” po błędzie (wFirma: faktura wraca do kolejki, wystawi ją ten sam mechanizm co „Ponów fakturę” na karcie, bez drugiej faktury; KSeF: wysyłka od razu z tym samym numerem), „Wyślij do KSeF” dla szkicu, „Korekta” przy wystawionej fakturze (otwiera formularz zwrotu albo reklamacji tego zamówienia: korekta powstaje ze zwrotu), w zakładce Korekty „Zwrot” (karta zwrotu, z którego powstała).
- **PDF z tej strony** (przycisk nad listą): jeden plik z dokumentami z bieżącej strony, najwyżej 50 naraz. Dokument bez PDF-u (np. szkic) jest pomijany.
- Przy wyłączonym „Wystawiaj faktury z Kompletora” lista działa, a „Ponów” i „Wyślij do KSeF” są widoczne i nieaktywne z powodem.

## KSeF bezpośrednio (firma bez wFirmy)

Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → program „KSeF bezpośrednio”, karta „Numeracja i KSeF”:

- **Seria faktur:** kod (np. `FV`), wzór numeru, numeracja od nowa co miesiąc, co rok albo nigdy. Wzór jak w BaseLinkerze: `%N` numer, `%M` miesiąc, `%Y` rok, `%D` dzień (np. `%N/%M/%Y` daje `7/11/2026`); działa też zapis `{NR}/{MM}/{RRRR}`.
- **Seria korekt:** osobny kod i wzór (domyślnie `%N/%M/%Y/K`), własny licznik. Wzór musi różnić się od wzoru faktur.
- **Numer nadaje się raz,** przy pierwszej wysyłce, w jednej transakcji z licznikiem serii: dwie faktury wysyłane w tej samej chwili dostają kolejne numery bez dziur i dubli. Ponowienie wysyła ten sam numer.
- **Środowisko KSeF:** testowe (domyślne, bez skutków podatkowych), przedprodukcyjne albo produkcyjne. Produkcyjne działa dopiero, gdy operator serwera je otworzy (zmienne `KSEF_PROD_ENABLED=1` i NIP firmy w `KSEF_PROD_NIPS`); bez tego ekran pisze, dlaczego nic nie wyjdzie.
- **Token KSeF firmy:** wklejasz go raz (generujesz w Aplikacji Podatnika KSeF dla NIP-u firmy). Zapisujemy go zaszyfrowany i nigdy nie pokazujemy.
- **Kiedy wysyła:** w momencie z „Kiedy wystawiać” (np. po spakowaniu), dla zamówień, które doszły do niego po włączeniu wystawiania; automat sprawdza co 2 minuty. Z karty zamówienia (sekcja „Dokument sprzedaży” → „Faktura KSeF”) i z listy faktur wyślesz ją od razu przyciskiem „Wyślij do KSeF”.
- **Po wysyłce:** KSeF przetwarza fakturę chwilę; numer KSeF i UPO zapisują się same (lista pokazuje „Wysłana do KSeF: <numer KSeF>”). Odrzucenie przez KSeF albo brak odpowiedzi = „Błąd” z powodem i „Ponów”. Gdy odpowiedź zginęła, a KSeF fakturę przyjął, ponowienie nie robi drugiej faktury: KSeF rozpoznaje ten sam numer i podaje numer KSeF pierwszej wysyłki.
- **Wysłana, stan do sprawdzenia:** gdy KSeF przyjął fakturę do przetwarzania, a odczyt jej stanu się nie udał (przerwa w sieci, limit żądań KSeF), faktura nie dostaje „Błędu”: lista pokazuje „W kolejce” z opisem, a automat co 2 minuty pyta KSeF o jej stan, bez drugiej wysyłki. Po około godzinie nieudanych prób pojawia się „Błąd” z „Ponów”, które też najpierw pyta KSeF o stan. Brakujący numer KSeF albo UPO przyjętej faktury automat dociąga sam przez 7 dni.
- **Bez schematów FA(3) na serwerze** faktury nie wychodzą do KSeF (powód widać przy „Wyślij do KSeF”) i nie zużywają numeru z serii.
- **Automatyczne ponowienie:** gdy faktura nie wyszła z przyczyny technicznej (przerwa w sieci, KSeF chwilowo niedostępny albo ograniczył liczbę żądań, nieudane logowanie, przerwana wysyłka), system ponawia ją sam do 6 razy w rosnących odstępach (od 2 minut do 2 godzin), zawsze z tym samym numerem; lista pokazuje, o której będzie kolejna próba. Odrzucenie przez KSeF i błędy danych czekają na „Ponów” po poprawce. Po zapisaniu nowego tokenu KSeF (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → Numeracja i KSeF) faktury, które nie wyszły przez nieudane logowanie albo brak tokenu, wracają do automatu same, z pełną pulą ponowień: nie trzeba klikać „Ponów” przy każdej. Gdy KSeF odrzuci już samo otwarcie sesji, lista pokazuje „KSeF odrzucił otwarcie sesji”: faktura nie została wysłana i czeka na „Ponów”.
- **Numer KSeF albo UPO do sprawdzenia:** gdy po przyjęciu faktury system przez 10 prób nie zdoła pobrać numeru KSeF albo UPO, lista pokazuje komunikat, żeby sprawdzić je ręcznie w Aplikacji Podatnika KSeF.
- **Wydruk po zmianie danych:** PDF faktury KSeF powstaje z danych w Kompletorze. Gdy ktoś zmienił dane zamówienia albo nabywcy po wysyłce, PDF ma czerwone ostrzeżenie, że wiążąca jest faktura w KSeF.
- **Seria tylko dla Kompletora:** numerów z serii KSeF nie używaj w innym programie do faktur na tym samym NIP-ie.
- **Data wystawienia przy ponowieniu:** faktura zachowuje datę wystawienia i numer z pierwszej próby, także gdy „Ponów” po odrzuceniu idzie następnego dnia albo w następnym miesiącu. [do ustalenia z księgową: czy przy ponowieniu po odrzuceniu w innym dniu albo miesiącu datą wystawienia ma być data przesłania do KSeF, art. 106na] Drugi wariant (data przesłania, numer bez zmian) jest gotowy i włącza go operator serwera ustawieniem firmy `ksef.dataPrzyPonowieniu = DZIEN_WYSYLKI`.
- **Korekta:** na karcie zwrotu („Korekta faktury” → „Wyślij korektę do KSeF”), gdy faktura jest przyjęta w KSeF. Korekta dostaje numer z serii korekt i wskazuje numer KSeF faktury korygowanej.
- Faktura dla osoby prywatnej bez NIP-u nie idzie do KSeF, chyba że zaznaczysz „Faktury dla osób prywatnych (bez NIP) też do KSeF”.
- Pierwszą fakturę po włączeniu produkcji sprawdź w Aplikacji Podatnika KSeF.

## Zwrot towaru przy stanie prowadzonym przez Kompletor

Towar zszedł ze stanu przy „Do wysyłki” bez faktury z WZ, więc zwrot nie koryguje niczego w programie do faktur:

- **Zwrot paczki:** przyjęcie zwrotu z oznaczeniem pozycji kończy zwrot od razu. „Na stan” wraca do stanu i do sprzedaży (ruch „zwrot na stan” w historii produktu, a czekające braki dostają towar). „Uszkodzone” zostaje poza stanem (wpis w historii bez zmiany ilości).
- **Anulowanie po wydaniu** (zamówienie w „Do wysłania” albo „Do odbioru”, towar już zdjęty ze stanu): zamówienie trafia na listę „do korekty”, a karta zamówienia pokazuje przycisk **„Przyjmij zwrot na stan”** (sekcja „Co dalej”, uprawnienie „Karta zamówienia w trybie PRACA”). Jedno kliknięcie przyjmuje całą wydaną ilość z powrotem i zdejmuje zamówienie z listy „do korekty”. Uszkodzony towar przyjmij potem korektą stanu na karcie produktu.
- **Dokument sprzedaży już wystawiony** (np. faktura z wFirmy przy stanie Kompletora): stan wraca tak samo, ale zamówienie zostaje na liście „do korekty”, a w Alertach pojawia się „Faktura do korekty” z numerem dokumentu. Korektę faktury wystawiasz w programie do faktur (Kompletor jej jeszcze nie wystawia).

Przy stanie z wFirmy zwrot idzie jak dotąd: korekta faktury w wFirmie, a stan pokaże odczyt wFirmy.

**Brak odpowiedzi wFirmy:** gdy wFirma nie odpowie (timeout, przerwa, błąd serwera), Kompletor nie wystawia drugiej faktury. Po 30 sekundach, 2 i 5 minutach szuka faktury w wFirmie po numerze referencyjnym zamówienia; znaleziona = „Wystawiona” z numerem, nieznaleziona po trzech próbach = nowa próba. Przed każdą nową próbą po takiej niewiadomej (także po „Ponów fakturę”) Kompletor jeszcze raz szuka faktury w wFirmie: jeśli się pojawiła, przyjmuje ją zamiast wystawiać drugą. Limit wywołań wFirmy wstrzymuje kolejkę na 5 minut (albo tyle, ile poda wFirma).

**Błąd faktury:** wFirma odrzuciła fakturę (np. brak kodu VAT, zły kontrahent) albo brakuje danych nabywcy. Wtedy:

- karta zamówienia pokazuje „Błąd: faktura się nie wystawiła” i powód,
- w Alertach pojawia się „Błąd faktury”,
- plan akcji przygotowuje mail „Błąd przy wystawianiu faktury” do biura (wysyła go poczta, gdy jest włączona),
- kolejka nie próbuje sama drugi raz.

Popraw przyczynę (dane klienta, kod VAT w konfiguracji, towar w wFirmie), sprawdź w wFirmie, czy faktury nie ma, i kliknij **„Ponów fakturę”** na karcie. Nowa próba idzie w ciągu kilku minut. Po trzech nieudanych próbach z rzędu system też zatrzymuje się i czeka na „Ponów fakturę”.

**PDF:** przycisk „PDF faktury” na karcie pobiera plik z wFirmy w chwili kliknięcia (Kompletor go nie przechowuje). Każde pobranie zostaje w dzienniku podglądów danych klienta (Ustawienia → Zespół i dostęp → Dane klientów, cel „PDF faktury”), bo faktura niesie dane nabywcy. Ten sam PDF dołącza mail „Faktura” do klienta, gdy wysyłka maili jest włączona.

**Przed pierwszą fakturą:** sprawdź kody VAT i pozycję wysyłki w konfiguracji firmy, a pierwszą wystawioną fakturę obejrzyj w wFirmie (kontrahent, pozycje, kwota, forma płatności).

## Dane firmy

Profil firmy czytają: szkic faktury KSeF (sprzedawca), dane nadawcy przesyłek, stopki maili (nazwa, adres, NIP, telefon, e-mail kontaktowy) i wydruki. Jeśli konfiguracja firmy ma już osobne dane sprzedawcy dla KSeF albo osobny adres nadania przesyłek, te wartości wygrywają z profilem. NIP i numer rachunku są sprawdzane sumą kontrolną. Strefa czasowa (Europe/Warsaw) i waluta (PLN) są na razie stałe.

Każda zmiana w obu ekranach trafia do dziennika zmian firmy (kto, kiedy, wartość przed i po).

### Logo firmy

**Gdzie to jest:** Ustawienia → Dokumenty i faktury → Dane firmy → sekcja **„Logo”** (adres `/ustawienia/firma`), widzą osoby z uprawnieniem „Ustawienia” (domyślnie właściciel). Pole pliku „Wgraj logo” i przycisk „Zapisz logo”; przy wgranym logo podgląd, „Zmień logo” i „Usuń logo”.

- Plik: PNG albo JPG, do 2 MB. SVG, PDF, GIF i pliki udające obraz są odrzucane (Kompletor sprawdza zawartość pliku, nie nazwę). Kompletor zmniejsza logo sam i zapisuje je od nowa, bez danych z aparatu.
- Gdzie się pokazuje: karta zamówienia (kompletacja) i lista wysyłkowa (wydruki), maile do klientów. W mailach logo sklepu z Ustawienia → Komunikacja i poczta → Poczta (jeśli je podano) ma pierwszeństwo przed logo firmy; logo firmy idzie w samym mailu, bez linku do panelu.
- Logo jest zapisane w bazie, więc panel, wydruki i wysyłka maili widzą to samo logo także wtedy, gdy panel i zadania w tle działają w osobnych kontenerach z osobnymi wolumenami. Logo wgrane przed tą zmianą (plik w wolumenie zdjęć panelu) przenosi się do bazy samo przy pierwszym wyświetleniu w panelu.
- Zmiana i usunięcie nie kasują plików: poprzednie logo trafia do archiwum firmy (katalog `old/` z datą w wolumenie zdjęć).

## Czego te ekrany nie robią

- Same nie wystawiają faktur: wystawia kolejka wFirmy albo wysyłka do KSeF po włączeniu „Wystawiaj faktury z Kompletora”. Listę faktur i korekt masz w Obsługa zamówień → Faktury; anulowania faktury w Kompletorze nie ma (w wFirmie anulujesz w wFirmie, w KSeF faktury się nie anuluje, tylko koryguje).
- Nie wystawiają paragonów ani faktur w innych programach niż wFirma i KSeF.
- Nie zmieniają stanu towarów. Stan poprawiasz korektą na karcie produktu (przy stanie prowadzonym przez Kompletor).
- Logo wgrywasz w Ustawienia → Dokumenty i faktury → Dane firmy (sekcja „Logo”), nie na ekranie Dokumenty sprzedaży.
- Nie przyjmują zwrotów: zwrot po anulowaniu przyjmujesz przyciskiem „Przyjmij zwrot na stan” na karcie zamówienia (opis wyżej).
- Nie pokazują listy dokumentów WZ z wFirmy. Zamówienie rozliczone dokumentem WZ ma wpis w historii na karcie zamówienia, a niepołączone WZ widać w raporcie rozjazdów.
