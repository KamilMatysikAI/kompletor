# Zwroty i reklamacje

Jak przyjąć zwrot albo reklamację, co dzieje się ze stanem po odbiorze paczki i jak powstaje korekta faktury.

## Gdzie to jest

- **Menu → Zwroty i reklamacje** (adres `/zwroty`). Lista zwrotów z zakładkami statusów i licznikami nad listą
  (Wszystkie, Nowe, Odebrane, W trakcie, Zakończone, Odrzucone, potem podglądy). Na telefonie zakładki przewijasz w poziomie.
- **Stwórz zwrot**: przycisk w nagłówku listy zwrotów (adres `/zwroty/nowy`, najpierw wyszukujesz zamówienie po numerze)
  albo na karcie zamówienia: **Zamówienia → zamówienie → menu „Więcej” → „Stwórz zwrot”** (albo „Zgłoś reklamację”).
- **Karta zwrotu**: kliknij zwrot na liście (adres `/zwroty/<numer>`). Na karcie: odbiór paczki, korekta faktury,
  odrzucenie, zdjęcie i historia.
- Na karcie zamówienia sekcja „Zwroty i reklamacje” pokazuje zwroty tego zamówienia z linkiem do każdego.

Kto co widzi i robi (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia, grupa „Zwroty”):

| Uprawnienie | Co daje | Domyślnie |
|---|---|---|
| Zwroty i reklamacje: zgłoszenie, odbiór paczki, odrzucenie | „Stwórz zwrot”, „Odbierz paczkę”, „Odrzuć zwrot”, dodanie i oglądanie zdjęcia | właściciel, biuro, magazyn |
| Zwroty: zlecenie korekty faktury | „Zleć korektę faktury”, „Korekta wystawiona poza Kompletorem”, szkic korekty KSeF | właściciel, biuro |
| Zwroty pieniędzy | „Zwrot” w bloku „Płatność” na karcie zamówienia | właściciel |

Listę i kartę zwrotu widzi każdy z podglądem panelu. Zdjęcie zwrotu widzą tylko osoby z uprawnieniem do przyjmowania
zwrotów, bo zdjęcie paczki bywa z etykietą adresową klienta. Bez uprawnienia przycisk zostaje widoczny i nieaktywny,
z powodem.

## Statusy

Te same pięć statusów co w module zwrotów BaseLinkera:

| Status | Co znaczy | Co dalej |
|---|---|---|
| Nowe | Zwrot zgłoszony, paczka jeszcze nie dotarła | Gdy paczka przyjdzie: „Odbierz paczkę” |
| Odebrane | Paczka w magazynie, każda pozycja oznaczona | Korekta faktury (gdy stan prowadzi program do faktur) |
| W trakcie | Korekta faktury jest w kolejce programu do faktur | Status zmieni się sam po wystawieniu korekty |
| Zakończone | Stan i dokumenty są rozliczone | Nic |
| Odrzucone | Zwrot odrzucony albo wycofany (z powodem) | Nic; ilość wraca do puli „do zwrotu” |

Każda zmiana trafia do historii zwrotu: co, kto i kiedy.

## Zgłoszenie

Zwrot zawsze dotyczy zamówienia. Na formularzu widzisz pozycje, które wyszły z magazynu i jeszcze nie są w innym
zwrocie, i przy każdej wpisujesz ilość. Wybierasz rodzaj (zwrot albo reklamacja) i powód. Notatka i zdjęcie są
opcjonalne. Zdjęcie: JPEG, PNG albo webp do 10 MB; system zapisuje je od nowa jako JPEG bez danych z aparatu.
Fotografuj towar, nie etykietę z adresem klienta.
Reklamacja idzie tym samym przepływem co zwrot, ma tylko inny rodzaj i powody.

Zwrot da się założyć dopiero po wydaniu towaru (zamówienie spakowane albo wysłane). Więcej niż wydano się nie da.

## Odbiór paczki: na stan albo uszkodzone

Na karcie zwrotu w statusie „Nowe” przy każdej pozycji wybierasz:

- **Na stan**: towar jest sprawny i wraca do sprzedaży.
- **Uszkodzone**: towar nie wraca do sprzedaży; zostaje w historii ruchów magazynu.

Co dalej zależy od tego, kto prowadzi stan magazynu (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży, [Stan magazynu i dokumenty sprzedaży](dokumenty-sprzedazy.md)):

- **Stan prowadzi Kompletor**: zwrot kończy się od razu przy odbiorze. „Na stan” podnosi stan od razu (ruch „zwrot na
  stan”) i może od razu pokryć braki w innych zamówieniach. „Uszkodzone” zostaje w historii ruchów z opisem, bez zmiany stanu.
- **Stan prowadzi wFirma**: po odbiorze zwrot czeka na korektę faktury (status „Odebrane”). Towar „na stan” wróci do
  sprzedaży po korekcie, gdy odczyt stanu z wFirmy pokaże wzrost. „Uszkodzone” po korekcie wychodzi ze sprzedaży od razu
  i trafia na listę do dokumentu rozchodu w wFirmie.

## Korekta faktury

Korektę wystawia program do faktur firmy:

| Program | Co robi Kompletor |
|---|---|
| wFirma, stan z wFirmy | „Zleć korektę faktury” wysyła korektę do wFirmy w kolejce (status „W trakcie”, potem „Zakończone”). Działa tylko przy włączonych „Wystawiaj faktury z Kompletora” i „Korekty faktur przy zwrotach z Kompletora” (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → „Wystawianie z Kompletora”) oraz koncie sklepu w trybie Aktywny. Inaczej przycisk jest nieaktywny z powodem, a zwrot kończysz przyciskiem „Korekta wystawiona poza Kompletorem” po wystawieniu korekty w wFirmie. |
| KSeF bezpośrednio | „Pobierz szkic korekty FA(3)”: plik XML korekty sprawdzony schematem, bez wysyłki do KSeF. |
| Bez programu do faktur | Korekta nie jest potrzebna. Zwrot kończy się przy odbiorze paczki. |
| wFirma, stan prowadzi Kompletor | Dokument sprzedaży korygujesz w wFirmie; Kompletor pokazuje alert „Faktura do korekty”. |

Korekta jest bezpieczna przy ponowieniu: gdy wFirma nie odpowie, system najpierw szuka korekty po jej numerze
referencyjnym i nie wystawia drugiej. Jeśli wFirma odrzuci korektę albo nie odda korygowanej faktury (np. faktura
usunięta), na karcie zwrotu jest komunikat i przycisk „Ponów korektę” (po poprawce danych). Gdy wFirma nie
odpowiedziała, a wyszukiwanie nie znalazło korekty, karta ostrzega: zanim klikniesz „Korekta wystawiona poza
Kompletorem”, sprawdź w wFirmie, czy korekta z numerem referencyjnym `zwrot/<numer zwrotu>/…` już nie istnieje.

**Jedna korekta z Kompletora na fakturę.** Gdy do tej samej faktury przychodzi drugi zwrot (np. klient odsyła resztę),
Kompletor nie wystawia drugiej korekty: liczyłaby się od faktury pierwotnej, a nie od stanu po pierwszej korekcie, i
w wFirmie podniosłaby ilość z powrotem. Przycisk „Zleć korektę faktury” jest wtedy nieaktywny z powodem. Kolejną
korektę wystawiasz w wFirmie (do ostatniej korekty) i kończysz zwrot przyciskiem „Korekta wystawiona poza Kompletorem”.
To samo, gdy korekta pierwszego zwrotu jest właśnie w drodze: poczekaj na jej wynik.

**Sprawdzenie po wystawieniu.** Po każdej korekcie Kompletor czyta ją z wFirmy i porównuje ilość każdej pozycji
z oczekiwaną (ilość z faktury minus zwrot). Zwrot kończy się zawsze (dokument już jest w wFirmie), ale przy innej
ilości dostajesz alert „Korekta z innymi ilościami niż zwrot” z listą pozycji („jest X, powinno być Y”), a na karcie
zwrotu ten sam opis: popraw korektę w wFirmie. Gdy samego odczytu nie da się zrobić, alert „Korekta niesprawdzona po
wystawieniu”: sprawdź ilości ręcznie.

Korekta wystawiona przez Kompletor nie podaje dokumentu przyjęcia na magazyn (PZ). Pozycje „na stan” trafiają więc na
listę „korekta bez PZ”: po wystawieniu PZ w wFirmie potwierdzasz je tam, a stan pokaże odczyt z wFirmy.

### Przed pierwszą korektą w wFirmie

Pierwszą prawdziwą korektę firmy uruchamia właściciel osobną decyzją, tak jak pierwszą fakturę: przełącznik „Korekty faktur
przy zwrotach z Kompletora” jest domyślnie wyłączony i nie włącza się razem z fakturami. Kształt korekty w API
wFirmy (rodzaj korekty, odwołanie do faktury i jej pozycji, ilość po korekcie) sprawdź najpierw na koncie testowym
wFirmy: jedna korekta testowa (faktura na co najmniej dwie pozycje towaru i wysyłkę, zwrot części jednej pozycji),
potem porównanie w wFirmie:

1. Korekta odwołuje się do właściwej faktury (numer faktury korygowanej na korekcie).
2. Ilość każdej pozycji po korekcie: pozycja zwracana = ilość z faktury minus zwrot (np. 3 − 2 = 1, nie 2 i nie −2);
   pozostałe pozycje bez zmian.
3. Pozycja wysyłki bez zmian (ilość i kwota).
4. Kwota brutto korekty = minus wartość zwróconych sztuk (cena brutto z faktury razy liczba zwróconych).
5. Brak alertu „Korekta z innymi ilościami niż zwrot” w Kompletorze. Jeśli się pojawił, a w wFirmie ilości są dobre,
   wFirma oddaje korektę w innym kształcie niż zakładamy: nie włączaj korekt na stałe, zgłoś to do poprawki.
6. Produkt na wagę (jeśli firma takie ma): ilość w kg do trzech miejsc po przecinku.

## Zwroty z Allegro

Zwroty, które klient zgłosi w Allegro (moduł zwrotów Allegro), pojawiają się same w statusie „Nowe”, co 15 minut, z
zamówieniem, pozycjami i powodem. Kompletor tylko czyta Allegro: nic nie zapisuje w Allegro i nie przyjmuje zwrotu w
Allegro za Ciebie. Tego samego zwrotu nie założy drugi raz. Danych kupującego (login, e-mail, komentarz, numer paczki)
nie zapisuje.

Zwrot, którego nie da się założyć (zamówienia nie ma w Kompletorze, oferta bez pozycji w zamówieniu, towar jeszcze nie
wydany), daje alert z prośbą o ręczne założenie. Na koncie w trybie „Tylko podgląd” zwroty z zamówieniem się zakładają,
a alertów o pominiętych nie ma.

## Czego tu nie ma

- **Zwrotu pieniędzy klientowi.** Kwotę zwrotu zapisujesz na karcie zamówienia w bloku „Płatność” („Zwrot”,
  uprawnienie „Zwroty pieniędzy”). Przelew robisz w banku.
- **Eksportu przelewów do banku.** Plik przelewów dla banku jeszcze nie działa ([Co jeszcze nie działa](co-jeszcze-nie-dziala.md)).
- **Zapisu zwrotu w Allegro** (przyjęcie, odrzucenie, zwrot prowizji) i zwrotów z innych kanałów. Zakładasz je ręcznie.
- **Wysyłki korekty do KSeF.** Jest tylko szkic do pobrania.
- **Maila o zgłoszeniu zwrotu, zanim paczka dotrze, i maila z decyzją w sprawie reklamacji.** Te odpisujesz klientowi
  jak dotąd.

## Maile do klienta

Kompletor może wysłać klientowi trzy maile (domyślnie **wyłączone**; włączasz w Ustawienia → Sprzedaż i kanały →
Automatyczne akcje → „Maile do klienta o zwrotach i reklamacjach”):

- **„Zwrot dotarł”**, gdy magazyn odbierze paczkę ze zwrotem (zwrot przechodzi do „Odebrane”),
- **„Reklamacja dotarła”**, gdy magazyn odbierze paczkę z reklamacją,
- **„Pieniądze zwrócone”**, gdy przy zwrocie zapisany jest zwrot pieniędzy. Dziś panel tego nie zapisuje (kwotę zwrotu
  wpisujesz w bloku „Płatność” zamówienia, a to maila nie wysyła); mail zacznie wychodzić, gdy dojdzie zwrot pieniędzy
  z systemu.

Maile dotyczą tylko zwrotów odebranych (i pieniędzy zwróconych) od chwili włączenia przełącznika: włączenie nie wysyła
maili o wcześniejszych zwrotach, także po wyłączeniu i ponownym włączeniu. Każdy mail wychodzi raz na zwrot. Zwrot
odrzucony nie dostaje maila „dotarł”, także gdy odrzucisz go już po odbiorze, a przed wysyłką. Gdy pieniądze są już
zwrócone, „dotarł” nie wychodzi, klient dostaje od razu „Pieniądze zwrócone”. Korekta bez przesyłki nie dostaje maila.
Mail wychodzi pocztą firmy, tylko z konta w trybie pracy („Aktywny”); konto „Tylko podgląd” zapisuje w planie akcji, że
mail by wyszedł. W mailu są numer zamówienia i zwrócone produkty pod nazwą z zamówienia (cały zestaw jako jedna
pozycja, część zestawu jako jego składniki), bez kwot. Treść zmienisz w Ustawienia → Komunikacja i poczta → Szablony
maili ([Poczta](poczta.md)); szablony są tam widoczne także przy wyłączonym przełączniku, żeby treść dało się
przygotować przed włączeniem.

## Podgląd sygnałów z kanałów i reklamacji z BaseLinkera

W zakładkach za statusami są dwie listy tylko do podglądu:

- **Sygnały z kanałów**: zamówienia, którym sklep nadał status zwrotu albo reklamacji (np. zwrot pieniędzy w sklepie,
  reklamacja w Empiku, przesyłka Allegro, która wróciła). Zwrot z nich zakładasz przyciskiem „Stwórz zwrot”.
- **Reklamacje w BaseLinkerze**: zamówienia z kopii BaseLinkera ze statusem z rodziny „Reklamacja” (tylko firmy, które
  przechodzą z BaseLinkera).
