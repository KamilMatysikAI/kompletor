# Konta, zaproszenia i sesje

Jak w Kompletorze powstaje dostęp osoby do firmy, czym różni się self-host od hostingu i co zostało świadomie na
później. Kod: `lib/auth/*` (konta, sesje, zaproszenia), `lib/panel/uzytkownicy.ts` (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia),
`lib/panel/kontekst.ts` (sprawdzanie sesji na ekranach).

## Konto, członkostwo, sesja

- **Konto** (`User`) jest wspólne dla całej instalacji: e-mail, imię i nazwisko, hasło (argon2id). Należy do osoby,
  nie do firmy: firma nie zmienia jej imienia ani hasła.
- **Członkostwo** (`Membership`) to dostęp osoby do jednej firmy: rola, dodatkowe uprawnienia (`permissions`),
  uprawnienia odebrane z zestawu roli (`deniedPermissions`), stan (włączony albo wyłączony) i `lastSeenAt`: ostatnia
  aktywność w tej firmie. Uprawnienia osoby = (zestaw roli ∪ dodatkowe) − odebrane, liczone tylko w `permissionsOf`
  (`lib/auth/uprawnienia.ts`); szczegóły niżej, „Dokładne uprawnienia osoby”.
- **Sesja** (`Session`) to zalogowana przeglądarka. W bazie jest tylko skrót SHA-256 tokenu z ciasteczka.

`User`, `Session` i `Invitation` mają RLS z polityką „nikt”: rola aplikacji ich nie czyta, obsługuje je tylko kod
systemowy z firmą w każdym zapytaniu.

## Self-host (`APP_MODE=self-host`, jedna firma): bez zmian

Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia → „Dodaj osobę”:

- nowy adres: konto z hasłem startowym pokazanym raz osobie dodającej;
- adres istniejącego konta: tylko dostęp do firmy; hasło, imię i nazwisko zostają takie, jak w koncie (komunikat to
  mówi);
- CLI `npm run uzytkownik -- dodaj | dostep | odbierz | haslo | lista | sprzataj` działa jak dotąd.

## Hosting (`APP_MODE=hosted`, wiele firm w jednej bazie): zaproszenia

Firma nie zakłada kont i nie dołącza cudzych. „Dodaj osobę” nazywa się tu **„Zaproś osobę”** i tworzy zaproszenie
po tych samych kontrolach co dotąd (rola właściciela tylko od właściciela, nikt nie nadaje uprawnienia, którego sam nie
ma). Dostęp powstaje dopiero wtedy, gdy zaproszona osoba sama je przyjmie.

- **Odpowiedź panelu dla dodającego jest taka sama** dla nowego adresu, konta z innej firmy i konta bez żadnej firmy
  (także te same zapytania do bazy, więc i czas). Inny komunikat dostają tylko osoby z listy tej firmy, bo i tak je
  widać: aktywna („ma już dostęp”) i wyłączona („Włącz dostęp ponownie” przy nazwisku: z kontrolą, nie
  zaproszeniem).
- **Granica trybu kopiowania linku.** Z dostawcą wysyłki (e-mail) firma nie sprawdzi, czy adres
  ma konto: link dostaje wyłącznie zaproszona osoba. W trybie kopiowania linku (`copyLinkSender`: firma bez poczty)
  zapraszający trzyma link, więc może przyjąć zaproszenie sam: dowie się wtedy, czy adres ma konto (droga „Nie mam
  konta” nie przejdzie), a gdy nie ma: założy je z hasłem, które zna. Dlatego konto założone z linku, którego nie
  doręczył dostawca (`Invitation.delivered = false`), dostaje `mustChangePassword`: prawdziwa osoba przy
  pierwszym logowaniu ustawia własne hasło. Wyroczni i zajęcia cudzego adresu to nie zamyka: **sprzedaż hostingu
  obcym firmom dopiero z transportem e-mail**. Transport już jest (niżej „Wysyłka”); firma bez ustawionej
  poczty dalej pracuje w trybie kopiowania linku, więc przed sprzedażą hostingu obcym firmom poczta firmy musi być
  ustawiona (albo hosting dostaje pocztę instancji).
- **Zaproszenie na właściciela zastępuje i cofa tylko właściciel**: nowe zaproszenie na ten sam adres cofa
  otwarte, więc osoba bez roli właściciela dostaje odmowę, gdy otwarte zaproszenie na ten adres jest na właściciela.
- **Link** `PANEL_URL/zaproszenie?t=<token>` jest ważny 7 dni, jednorazowy, do cofnięcia. Nowe zaproszenie na ten sam
  adres cofa poprzednie. W bazie jest tylko skrót tokenu; token nie trafia do logu ani do AuditLog.
- **Wysyłka:** panel podaje `zaproszeniaPoczta` (`lib/poczta/zaproszenia.ts`) jako `InvitationSender`.
  Gdy firma ma ustawiony serwer poczty (Ustawienia → Komunikacja i poczta → Poczta), serwer nie odrzucił logowania i instancja ma
  `POCZTA_WYSYLKA=1`, link idzie mailem „Zaproszenie do firmy” wyłącznie do zaproszonej osoby, a `delivered = true`
  dopiero, gdy serwer przyjął mail. Osoba dodająca widzi „Link wysłaliśmy na ten adres”, linku nie dostaje. Bez tych
  warunków, przy odmowie serwera albo wyniku niepewnym działa jak `copyLinkSender`: link pokazuje się raz osobie
  zapraszającej do skopiowania (jak hasło startowe: nie w adresie strony, nie w logu), konto z niego ma hasło do zmiany.
  Jedna wysyłka na zaproszenie (wpis „zaproszenie:<id>” w Ostatnich mailach, adres zamaskowany); ponowienie = nowe
  zaproszenie. Włącznik „Wysyłaj maile z planu akcji” zaproszeń nie dotyczy (jak reset hasła).
  Hamulce: limit godzinowy maili firmy (to samo zapytanie co wysyłka z planu, zaproszenia się
  do niego liczą), najwyżej 3 maile z zaproszeniem na godzinę na adres (po masce adresu) i 20 na godzinę w firmie;
  przekroczenie = link do skopiowania. Czas oczekiwania na serwer poczty w akcji panelu: 10 s na krok.
- **`PANEL_URL`** (`.env.example`) to adres panelu do linków, nigdy z nagłówka Host. Bez niej zaproszenia w hostingu
  dają czytelną odmowę.
- **Strona `/zaproszenie`** jest publiczna (`proxy.ts`), z `Referrer-Policy: no-referrer` i `noindex`. Pokazuje tylko
  nazwę firmy i rolę. Samo otwarcie linku (GET, np. skaner linków w poczcie) niczego nie przyjmuje: przyjęcie tylko
  przyciskiem (POST). Limit prób per IP liczą tylko przyciski (jedna próba = jedno odliczenie); samo wyświetlenie
  strony go nie zużywa.
- **Przyjęcie**: strona zawsze pokazuje obie drogi:
  - „Mam już konto”: e-mail i hasło (działa też dla konta bez żadnej firmy; złe hasło liczy się do blokady konta).
    Hasło sprawdzane dopiero przy ważnym zaproszeniu: bez niego strona nie jest drugim punktem logowania;
  - „Nie mam konta”: imię i nazwisko, e-mail, własne hasło. Bez wymuszonej zmiany tylko wtedy, gdy link doręczył
    dostawca wysyłki; link skopiowany przez zapraszającego daje konto z `mustChangePassword`.
  - Osoba już zalogowana widzi dodatkowo „Przyjmij zaproszenie”.
  - Każde niepowodzenie (zły token, złe hasło, zakładanie konta na adres, który ma konto, adres spoza zaproszenia)
    daje ten sam komunikat z prośbą o zalogowanie. Zalogowany na inny adres dostaje odmowę bez podania adresu
    z zaproszenia.
  - W transakcji: zaproszenie nadal ważne, zapraszający nadal aktywny, nadal ma `uzytkownicy` i wszystkie zapraszane
    uprawnienia, a dla roli właściciela nadal jest właścicielem: inaczej zaproszenie przepada. Dwa równoległe
    kliknięcia dają jedno członkostwo. Osoba wyłączona w tej firmie nie wraca przez stare zaproszenie.
  - Osoba, która w międzyczasie dostała dostęp inną drogą (np. CLI `dostep`), zamyka zaproszenie bez zmiany roli
    i uprawnień (rola z zaproszenia nie nadpisuje nadanej); AuditLog firmy dostaje wpis „przyjęte bez zmiany
    dostępu”. Wpis przyjęcia z nowym dostępem ma zapraszającego (`actorId`) i przyjmującego (`przyjalId`).
- **Panel:** Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia, sekcja „Zaproszenia” (tylko w hostingu): otwarte zaproszenia i „Cofnij”.
  Zaproszenie na właściciela cofa tylko właściciel. Bez nowej pozycji w menu.
- **Sprzątanie:** `npm run uzytkownik -- sprzataj` usuwa wygasłe sesje oraz wygasłe i cofnięte zaproszenia
  (`purgeInvitations`). Harmonogramu w workerze nie ma: tak jak dla sesji.

### CLI w hostingu

`dodaj` i `dostep` dołączają konto do firmy bez zgody osoby. W hostingu to narzędzia obsługi instalacji (np. pierwszy
właściciel nowej firmy), nie droga dla firm: firmy zapraszają z panelu. `haslo` nadaje hasło startowe (do zmiany przy
pierwszym logowaniu) i wylogowuje wszystkie sesje osoby: w hostingu tylko na prośbę tej osoby, po sprawdzeniu
tożsamości poza panelem.

## Lista osób

Lista w Ustawieniach → Zespół i dostęp → Użytkownicy i uprawnienia pokazuje „ostatnio aktywny” z `Membership.lastSeenAt` (aktywność w tej firmie,
dotykana razem z sesją co 5 minut), w obu trybach. Globalne `User.lastLoginAt` zostaje tylko dla CLI `lista`. Chip
„konto zablokowane” (konto wyłączone dla całej instalacji) w hostingu pojawia się tylko, gdy konto należy wyłącznie do
tej firmy: stan konta w innej firmie to nie jej sprawa.

## Hasło startowe

Hasło startowe zna osoba, która je nadała (panel w self-hoście, CLI `dodaj` i `haslo`), więc konto dostaje
`mustChangePassword`. Do czasu zmiany `requireSession` przekierowuje każdy ekran na `/ustawienia/haslo`, trasy API
odpowiadają 403, a wylogowanie działa. Pętli nie ma: proxy podaje ścieżkę żądania w nagłówku (nadpisując wartość od
klienta), a ekran hasła i jego akcje rozpoznają swój adres. Udana zmiana hasła czyści flagę. Istniejące konta mają
`false` i nic nie odczuwają. Konto założone z zaproszenia ma `false` tylko z linku doręczonego przez dostawcę wysyłki;
z linku skopiowanego przez zapraszającego ma `true` (sekcja „Hosting”).

## Zakończ pozostałe sesje

`/ustawienia/haslo` → „Inne urządzenia” → „Zakończ pozostałe sesje”. Bez hasła i bez sprawdzania blokady konta, więc
działa także wtedy, gdy ktoś znający tylko e-mail podtrzymuje blokadę złymi logowaniami (wtedy zmiana hasła z panelu
stoi). Kończy wszystkie sesje tej osoby we wszystkich firmach poza bieżącą, tylko z żywej sesji tej osoby, z wpisem
w AuditLog firmy w tej samej transakcji (z przeglądarką sesji, która została: `zostalaPrzegladarka`). Wynik:
„Zakończono N sesji”.

**Granica.** Akcja nie rozstrzyga, kto jest właścicielem konta: kliknąć może każdy, kto ma żywą
sesję tej osoby, także ktoś, kto ją ukradł. Taki ktoś wyloguje właściciela, a złymi logowaniami podtrzyma blokadę,
więc właściciel nie wejdzie do panelu. Przy podejrzeniu, że ktoś inny wylogował Ciebie: zgłoszenie do obsługi, która
po sprawdzeniu tożsamości poza panelem nadaje hasło startowe CLI `haslo` (kończy wszystkie sesje osoby); wpis w
AuditLog pokazuje, z jakiej przeglądarki kliknięto. Na później: osobny licznik błędów dla „obecnego hasła” przy
zmianie hasła z żywej sesji, tak by blokada z logowania nie zatrzymywała zmiany hasła: wtedy hasło daje przewagę
właścicielowi i problem znika.

## Na później (opis, bez zmian w kodzie)

### Limiter trwały dla wielu instancji

`SlidingLimiter` (`lib/auth/limiter.ts`) liczy próby w pamięci procesu: przy kilku instancjach panelu limit per IP
liczy się per instancja (logowanie, zmiana hasła, strona zaproszenia). Blokada konta po 5 złych
hasłach jest w bazie i działa między instancjami, więc na start to wystarcza. Gdy hosting dostanie kilka instancji
za balanserem: limiter w bazie (tabela liczników z oknem czasu, `INSERT … ON CONFLICT` i sprzątanie razem z sesjami)
albo we wspólnym magazynie, z tym samym interfejsem `hit(key, now)`.

### Zmiana hasła dla osoby bez `panel.podglad`

`app/(panel)/ustawienia/haslo/page.tsx` i jej akcje używają `requireSession`, które wymaga podglądu panelu, a layout
dla osoby bez podglądu pokazuje tylko „Brak dostępu” i „Wyloguj”. Dziś to nieosiągalne: każda rola ma `panel.podglad`,
a odebrać go osobie się nie da (serwer odrzuca każdy zestaw bez podglądu, `brakujaceZaleznosci`; odcięcie osoby to
„Wyłącz dostęp do firmy”).
Gdy pojawi się rola bez podglądu: `requireLogin` zamiast `requireSession` na stronie hasła i w jej akcjach (z tym samym
wyjątkiem dla `mustChangePassword`), link „Zmień hasło” na ekranie „Brak dostępu” i wyjątek w layoucie panelu, który
dla `/ustawienia/haslo` renderuje `children`.

## Decyzja właściciela firmy: Biuro i stanowisko pakowania

Osoba z rolą Biuro i uprawnieniem `uzytkownicy` może wyłączyć dostęp magazyniera, ale nie włączy go z powrotem:
ponowne włączenie przywraca uprawnienia osoby, więc liczy się jak ich nadanie, a Biuro nie ma `pakowanie.stanowisko`
(opis w `switchRefusal`, `lib/panel/uzytkownicy.ts`). Asymetria jest celowa: odebranie dostępu nie jest
eskalacją, przywrócenie cudzych uprawnień już tak.

Jeśli w firmie Biuro ma zarządzać magazynierami w obie strony, właściciel nadaje tej osobie z Biura dodatkowe
uprawnienie „Stanowisko pakowania” (`pakowanie.stanowisko`) jednym kliknięciem w Ustawieniach → Zespół i dostęp → Użytkownicy i uprawnienia. To
decyzja właściciela konkretnej firmy, nie zmiana ról: domyślne uprawnienia ról w `lib/auth/uprawnienia.ts` zostają bez
zmian.

## Dokładne uprawnienia osoby (rola jako punkt startu)

Gdzie: Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia (`/ustawienia/uzytkownicy`, widzi osoba
z uprawnieniem „Użytkownicy i uprawnienia”, domyślnie rola Właściciel):

- przycisk **„Zaproś osobę”** (hosting) albo **„Dodaj osobę”** (instalacja własna) nad tabelą: imię i nazwisko (tylko
  instalacja własna), e-mail, rola, a pod rolą rozwijana sekcja **„Dokładne uprawnienia: N z 31”**. Wybór roli
  zaznacza jej zestaw; każde uprawnienie da się zaznaczyć albo odznaczyć, także całą grupę („Zaznacz grupę”,
  „Odznacz grupę”). Zaproszenie niesie ten zestaw i osoba dostaje go przy przyjęciu; w instalacji własnej konto
  dostaje go od razu;
- przycisk **„Szczegóły”** w wierszu osoby: te same pola. Przy uprawnieniu widać „dołożone” albo „odebrane” względem
  roli, nad listą licznik („Inaczej niż w roli: 2 dołożone, 1 odebrane”) i przycisk **„Przywróć zestaw roli”**;
- kolumna **„Inaczej niż w roli”** w tabeli osób i dopisek przy otwartych zaproszeniach (`+2 dołożone, −1 odebrane`).

Czego ten ekran nie robi: nie dzieli uprawnienia „Ustawienia firmy” na działy (kanały, faktury, poczta, druk…): to
jedno pole. Wyłączenie osoby to przycisk „Wyłącz dostęp do firmy” w jej szczegółach, nie odznaczanie wszystkiego.

### Zapis i bezpieczniki (serwer, `lib/panel/uzytkownicy.ts`)

Formularz wysyła pełny zaznaczony zestaw (`zestaw=pelny`), a serwer wylicza z niego dołożone (`permissions`) i odebrane
z roli (`deniedPermissions`, tylko te, które rola daje). Formularz bez znacznika (strona otwarta przed wdrożeniem)
działa jak dawniej: same dodatkowe, nic nie odebrane. Sprawdzenia pod blokadą członkostw firmy:

1. nikt nie nada uprawnienia, którego sam nie ma, i nie odbierze uprawnienia, którego sam nie ma (ono zostaje
   u osoby bez zmian; na ekranie pole jest wyłączone);
2. nikt nie odbierze sobie „Użytkownicy i uprawnienia” (ani odznaczeniem, ani zmianą własnej roli); robi to inna osoba
   z tym uprawnieniem;
3. rola Właściciel ma zawsze komplet: zapis odebranych dla właściciela jest odrzucany, a `permissionsOf` i tak ich nie
   odejmuje. Dlatego ostatni właściciel firmy zawsze ma „Użytkownicy i uprawnienia” (dawny bezpiecznik ostatniego
   właściciela dalej pilnuje, żeby nie stracił roli);
4. zależność: bez „Podgląd panelu” osoba nie otworzy panelu, więc każdy zestaw bez niego jest odrzucany;
5. nieznane nazwy odpadają przy zapisie (nie trafiają do bazy) i są pomijane przy odczycie;
6. dziennik zmian (`AuditLog`, encja `Membership`, przy zaproszeniu `Invitation`): kto (`actorId`), komu (`entityId`),
   stan przed i po (`role`, `permissions`, `deniedPermissions`, `active`) oraz `zmiana: { nadane, odebrane }` liczone na
   wynikowym zestawie. Zapis bez zmian nie zostawia wpisu.

Zmiana działa od następnego żądania osoby: sesja liczy uprawnienia z bazy przy każdym żądaniu (`resolveSession`),
odczyt danych klienta też (`uprawnieniaOsoby`, `lib/klienci/odczyt.ts`). Strażnik
`lib/auth/uprawnienia-odebrane.test.ts` pilnuje, że każdy odczyt członkostwa z bazy przynosi kolumnę odebranych.
CLI `npm run uzytkownik -- dostep` bez `--uprawnienia` nie rusza odebranych (zmiana roli z terminala niczego osobie
nie przywraca); `lista` pokazuje je po minusie (`BIURO+zwroty.pieniadze-klienci.dane`).

### Powrót do starszej wersji aplikacji (uwaga: poszerza uprawnienia)

Migracja `20261116297000_odebrane_uprawnienia_osoby` tylko dodaje kolumny `deniedPermissions` (pusta lista) w
`Membership` i `Invitation`; starsza wersja aplikacji działa na nowej bazie. **Starsza wersja nie zna odebranych:**
po powrocie każda osoba z odebranymi uprawnieniami ma znowu pełny zestaw swojej roli (plus dołożone), a otwarte
zaproszenia dają przy przyjęciu pełny zestaw roli. Dane w kolumnie zostają, więc ponowne wdrożenie nowej wersji
przywraca odebrane bez żadnej akcji. Przed powrotem sprawdź, kto ma odebrane (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia, kolumna
„Inaczej niż w roli”, albo CLI `lista`), i na czas starszej wersji nadaj takim osobom rolę o węższym zestawie albo
wyłącz im dostęp.

W praktyce: osobie, której ma zostać mało, lepiej dać węższą rolę (np. Magazyn) i dołożyć brakujące uprawnienia, niż
dać szerszą rolę i odbierać. Dołożone uprawnienia przetrwają powrót do starszej wersji, a odebrane nie.
