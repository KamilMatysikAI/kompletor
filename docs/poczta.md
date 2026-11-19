# Poczta: maile do klientów i biura

Kompletor wysyła maile z planu akcji (brak płatności, gotowe do odbioru, wysłane z fakturą, błąd faktury, niski stan) przez serwer poczty Twojej firmy, osobom z kontem w panelu link do ustawienia nowego hasła, a zaproszonym osobom link zaproszenia do firmy.

## Gdzie to jest

- **Ustawienia → Komunikacja i poczta → Poczta** (`/ustawienia/poczta`, uprawnienie „ustawienia”): serwer poczty, hasło, nadawca, adres biura, nadawca i wygląd maili każdego sklepu, przycisk „Wyślij mail próbny”, ostatnie maile.
- **Ustawienia → Komunikacja i poczta → Szablony maili** (`/ustawienia/poczta/szablony`): treść każdego maila, lista zmiennych, podgląd.
- **Menu → Przejście z BaseLinkera → „Maile do klientów: podgląd”** albo Pulpit → przycisk „Maile do klientów: podgląd” (`/akcje`; także przycisk „Plan akcji” w Ustawienia → Komunikacja i poczta → Poczta): każda akcja ma przy stanie informację o mailu (wysłany, czeka, nie wyszedł, mógł nie dojść, pominięty) z zamaskowanym adresem. Link „podgląd” w wierszu pokazuje treść maila z danymi Twojej firmy (nazwa sklepu, stopka, adres do odpowiedzi, pozycje zamówienia, numer faktury), bez imienia i adresu klienta. Gdy czegoś brakuje w ustawieniach, nad treścią stoi lista „Zanim ten mail wyjdzie z Kompletora” z miejscem, gdzie to uzupełnić. Podgląd w Szablonach maili zostaje na danych przykładowych (sklep „Żółwik”).
- **Strona logowania → „Nie pamiętam hasła”** (`/nie-pamietam-hasla`): prośba o link do nowego hasła.

## Kiedy mail wychodzi

Mail z planu akcji wychodzi, gdy spełnione są trzy warunki naraz:

1. administrator instancji ustawił `POCZTA_WYSYLKA=1` (panel i zadania w tle; puste albo `0` = żaden mail nie wyjdzie),
2. w Ustawienia → Komunikacja i poczta → Poczta zaznaczono „Wysyłaj maile z planu akcji” (do włączenia potrzebny serwer, port, adres nadawcy i hasło, jeśli jest login),
3. konto kanału, z którego jest zamówienie, jest aktywne („Aktywny”, Ustawienia → Sprzedaż i kanały → Kanały sprzedaży). Konto „Tylko podgląd” nigdy nie wysyła: maile wysyła wtedy BaseLinker, a plan zapisuje tylko „wysłałbym”.

Maile o niskim stanie idą, gdy akcje produktowe firmy są w trybie pracy.

Bez poczty albo z wyłączoną wysyłką maile czekają w planie akcji jako „zaplanowane”, a ekran Poczta pokazuje, czego brakuje. Po włączeniu wychodzą także maile z ostatniej doby przed włączeniem. Starsze niż doba przed włączeniem i starsze niż 7 dni nie wychodzą (akcja dostaje stan „pominięta” z powodem).

## Jeden mail na zdarzenie

Każda akcja planu wysyła najwyżej jeden mail. Wpis wysyłki powstaje przed połączeniem z serwerem, więc dwa przebiegi wysyłki naraz nie wyślą dwa razy.

Przed wysyłką system sprawdza warunek drugi raz:

- „Brak płatności” tylko dla zamówienia wciąż nieopłaconego, z terminem anulowania w przyszłości; treść podaje datę anulowania. Po nieudanej płatności online (bramka odrzuciła BLIK albo kartę) w tym samym miejscu wychodzi mail „Nieudana płatność online”: pytanie o problem z płatnością i dane do zwykłego przelewu. Odbiorca (pełna nazwa firmy) i numer rachunku pochodzą z Ustawienia → Dokumenty i faktury → Dane firmy, tytuł przelewu to „Zamówienie <numer>” z numerem, który klient zna ze sklepu (bez przedrostka konta, który Kompletor dodaje w temacie). Który mail wyjdzie, system sprawdza w chwili wysyłki: zamówienie przełączone w międzyczasie na przelew tradycyjny dostaje zwykły „Brak płatności”, a częściowo opłacone też zwykły. Firma bez numeru rachunku albo bez pełnej nazwy w Danych firmy: klient dostaje w tym samym terminie zwykły „Brak płatności” (także gdy dane zniknęły po zaplanowaniu, bez błędu wysyłki). Biuro widzi, czego brakuje: w powodzie i podglądzie akcji (Przejście z BaseLinkera → Maile do klientów, z linkiem do Danych firmy) i w Ustawienia → Magazyn i strefy → Zasady rezerwacji, karta „Nieudana płatność online”. W historii wysyłki (Ustawienia → Komunikacja i poczta → Poczta) stoi rodzaj maila, który faktycznie wyszedł. Pytanie o płatność nigdy nie wychodzi od razu o dowolnej porze: gdy godzina 9:00 z zasad już minęła, czeka do najbliższego ranka. Kiedy wychodzi pytanie, opisuje [Rezerwacje](rezerwacje.md),
- „Gotowe do odbioru” tylko, gdy zamówienie dalej czeka na odbiór; wymaga adresu i godzin odbioru sklepu (Ustawienia → Komunikacja i poczta → Poczta, sekcja sklepu),
- „Wysłane z fakturą” tylko dla wysłanego zamówienia i tylko z plikiem PDF dokumentu w załączniku. Plik daje program do faktur firmy (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży). Dziś plik daje wFirma; inny program da go dopiero wtedy, gdy instalacja ma podłączony jego adapter z pobieraniem PDF (sam wybór programu w ustawieniach nie wystarcza, taki mail czeka). Plik jest pobierany w chwili wysyłki, tylko dla maila, który w tym przebiegu wychodzi (mieści się w limicie), z wpisem w dzienniku podglądów danych klienta, a numer faktury z programu trafia do tematu maila. Gdy program nie podał numeru, mail wychodzi bez niego: temat „Faktura do zamówienia <numer zamówienia>”, plik „Faktura-do-zamówienia-<numer zamówienia>.pdf” (numer jest w samym PDF); wewnętrzny identyfikator dokumentu nie trafia do maila nigdy. Podgląd akcji pokazuje ten sam wariant z informacją dla biura. Faktura spoza Kompletora, program bez pliku PDF albo chwilowy błąd pobrania = mail czeka (stan „mail czeka” w planie akcji), po 7 dniach jest pomijany. Firma bez programu do faktur („Bez programu do faktur”) nie dostaje planu maila „Wysłane z fakturą” wcale,
- „Błąd faktury” nie wychodzi, gdy kolejna próba wystawiła już fakturę,
- „Niski stan” nie wychodzi, gdy stan wrócił powyżej progu,
- „Zwrot dotarł”, „Reklamacja dotarła” i „Pieniądze zwrócone” (maile o zwrotach, [Zwroty i reklamacje](zwroty-i-reklamacje.md)) wychodzą tylko przy włączonym przełączniku „Maile do klienta o zwrotach i reklamacjach” (Ustawienia → Sprzedaż i kanały → Automatyczne akcje, domyślnie wyłączony); dotyczą tylko zwrotów odebranych od włączenia przełącznika; nie wychodzą, gdy zwrot odrzucono, a po wyłączeniu przełącznika zaplanowane wcześniej są pomijane. Ich szablony są widoczne w Szablonach maili także przy wyłączonym przełączniku (treść da się przygotować przed włączeniem).

Adres klienta pochodzi z zaszyfrowanych danych klienta zamówienia ([Dane klienta w zamówieniu](dane-klienta.md)). Gdy danych jeszcze nie ma, mail czeka do doby, potem biuro dostaje alert. Klient bez adresu e-mail: mail jest pomijany. W bazie poczty i w alertach jest tylko maska adresu (np. j***@example.com).

## Błędy i odbicia

- Serwer chwilowo odmawia albo nie odpowiada przed wysłaniem treści: ponowienie po 2, 5, 15 i 60 minutach, najwyżej 5 prób, potem alert.
- Serwer odrzuca adresata albo mail (kod 5xx): koniec, alert „Serwer poczty odrzucił mail”.
- Połączenie zerwane po wysłaniu treści: mail mógł dojść, więc bez ponowienia (lepszy brak maila niż dwa), alert „Mail mógł nie dojść”.
- Serwer odmawia z powodu ustawień, zanim w ogóle dojdzie do adresata (np. „Authentication required”, „Must issue a STARTTLS command first”, adres nadawcy nie należy do konta) albo odmawia przekazania maila dalej („Relay access denied”, „Unable to relay”: zwykle brak logowania albo nadawca spoza konta): to nie wina klienta, więc bez alertu o adresacie. Wysyłka firmy wyłącza się, komunikat „Serwer poczty nie przyjmuje maili przy tych ustawieniach” pojawia się w Ustawienia → Komunikacja i poczta → Poczta, alert „Poczta: serwer nie przyjmuje maili przy tych ustawieniach”. Mail wraca do kolejki bez zużytej próby; po poprawce (zwykle szyfrowanie, port, login albo adres nadawcy) i ponownym włączeniu wysyłki wychodzi.
- Serwer odrzuca samo połączenie (kod 5xx na powitaniu): to prawie zawsze odmowa dla adresu IP serwera Kompletora (lista dozwolonych adresów u dostawcy poczty albo czarna lista). Zachowanie jak wyżej (wysyłka wyłączona, mail wraca do kolejki), a komunikat mówi, żeby zapytać dostawcę poczty o listę dozwolonych adresów.
- Login albo hasło odrzucone: wysyłka firmy wyłącza się, a poczta dostaje blokadę „serwer odrzucił logowanie”: czerwony komunikat w Ustawienia → Komunikacja i poczta → Poczta i alert. Do czasu poprawy nie wychodzą też linki do ustawienia hasła. Blokada znika, gdy zapiszesz nowe dane serwera (adres, port, szyfrowanie, login albo hasło), ponownie zaznaczysz wysyłkę albo wyślesz udany mail próbny; maile, które nie wyszły, wracają do kolejki po ponownym włączeniu wysyłki.

Alerty widać na pulpicie i, gdy włączone, na Zulipie (grupa „Inne”, [Powiadomienia na Zulip](powiadomienia.md)).

Limit: najwyżej 300 maili na godzinę na firmę (liczony z bazy przed każdym mailem, więc dwa przebiegi wysyłki naraz go nie przekroczą więcej niż o jeden mail) i 20 na jeden przebieg co minutę; reszta czeka na kolejny przebieg. Do limitu godzinowego liczą się wszystkie maile firmy: z planu akcji, próbne, linki do ustawienia hasła i zaproszenia.

### Odbicia po wysłaniu

Część odbić przychodzi później, jako raport „Mail niedoręczony” na skrzynkę adresu nadawcy (np. „skrzynka pełna”, „nie ma takiego adresata” po kilku godzinach). Kompletor rozpoznaje taki raport (standardowy raport doręczenia, który wysyłają wszystkie popularne serwery, także Amazon SES), dopasowuje go do wysłanego maila po ukrytym nagłówku `X-Kompletor-Id` (raport z innym adresatem niż ten, do którego mail wyszedł, jest pomijany) i zapisuje: mail dostaje stan „wrócił (niedoręczony)” w Ustawienia → Komunikacja i poczta → Poczta → Ostatnie maile i w planie akcji, z kodem i powodem (adres zamaskowany, adresy stron wycięte), a biuro dostaje alert „Mail wrócił jako niedoręczony”. Raport „opóźnione” (serwer jeszcze próbuje) niczego nie zmienia.

Raporty czyta karta **Odbicia** w Ustawienia → Komunikacja i poczta → Poczta (na dole ekranu, nad „Ostatnie maile”). Wpisujesz tam skrzynkę, na którą wracają odbicia: serwer IMAP, port (zwykle 993 z SSL/TLS albo 143 ze STARTTLS), login, hasło i folder (zwykle INBOX). Hasło jest zapisane jak hasło SMTP: ekran pokazuje tylko, czy jest ustawione. Po włączeniu „Sprawdzaj skrzynkę odbić co 5 minut” Kompletor co 5 minut przegląda nieprzeczytane maile w tym folderze (najwyżej 50 na raz, każdy do 2 MB):

- raport o mailu wysłanym przez Kompletor: zapis jak wyżej, mail dostaje znacznik „przeczytany” i trafia do folderu „Kompletor/odbicia” w tej skrzynce;
- zwykły mail (np. odpowiedź klienta), raport „opóźnione” i raport o mailu, którego nie wysłał Kompletor (np. wysłanego ręcznie z tej skrzynki): zostaje nieprzeczytany w folderze, nic się z nim nie dzieje;
- mail przejrzany raz nie jest czytany drugi raz; błąd jednego maila nie zatrzymuje reszty (Kompletor spróbuje go ponownie, a po trzech nieudanych próbach zostawi go w skrzynce i pokaże błąd na karcie). Zerwane połączenie w trakcie przeglądania nie liczy się jako nieudana próba maila: Kompletor kończy przebieg i wraca do tego samego miejsca za 5 minut.
- najlepiej wskazać skrzynkę albo folder tylko na odbicia: Kompletor przy każdym przebiegu pyta serwer o numery wszystkich nieprzeczytanych maili nowszych od ostatnio przejrzanego (same numery, bez treści). Przy skrzynce z dziesiątkami tysięcy nieprzeczytanych to zbędny ruch co 5 minut, choć treść i tak pobiera najwyżej 50 maili na raz.

Gdy serwer odrzuci login albo hasło, karta pokazuje komunikat, biuro dostaje alert, a czytnik czeka na poprawione dane (nie próbuje co 5 minut, żeby serwer nie zablokował konta). Wysyłka maili działa wtedy normalnie. Po zapisaniu poprawionych danych czytnik rusza przy następnym przebiegu. Gdy serwer odmawia logowania z powodu chwilowego (np. limit połączeń, serwer niedostępny), czytnik nie staje, tylko próbuje znowu za 5 minut. Brak połączenia z serwerem: komunikat na karcie i ponowna próba za 5 minut. Zapisanie nowej skrzynki w trakcie przebiegu jest bezpieczne: wynik przebiegu na starej skrzynce nie nadpisze nowych ustawień.

**Adres odbić (opcjonalnie)**: gdy go wpiszesz, maile wychodzą z nim jako nadawcą koperty (Return-Path), więc odbicia wracają na ten adres, a nie na adres nadawcy widoczny dla klienta. Adres musi należeć do konta SMTP (inaczej serwer odrzuci wysyłkę i Kompletor pokaże błąd ustawień), a w polach IMAP wpisz skrzynkę właśnie tego adresu. Puste pole = odbicia wracają na adres nadawcy maila. Amazon SES też odsyła raporty na adres nadawcy koperty, więc wystarczy skrzynka IMAP tego adresu, bez dodatkowej konfiguracji w AWS.

W hostingu serwer IMAP musi być dostępny z internetu, port 993 albo 143, połączenie szyfrowane.

## Szablony

Każdy mail ma treść domyślną. W Szablonach zmienisz temat, tekst podglądu w skrzynce, nagłówek, akapity, etykiety przycisków i wierszy. Zmienne w podwójnych nawiasach, np. `{{numerZamowienia}}`, wstawia system; nieznana zmienna nie da się zapisać. Zmienna nieobowiązkowa (np. imię, numer faktury) tylko w sekcji `{{#imie}}…{{/imie}}`. Własna treść „Wysłane z fakturą”, która wstawia numer faktury poza sekcją, przy fakturze bez numeru zostaje dla tego maila zastąpiona treścią domyślną, żeby faktura doszła. Pusty akapit znika z maila. Układ maila, adresy przycisków i warunki są stałe. „Przywróć treść domyślną” usuwa zmiany.

Maile z linkiem do nowego hasła i z zaproszeniem do firmy mają treść stałą.

## Zaproszenia mailem

W hostingu „Dodaj osobę” w Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia tworzy zaproszenie. Gdy firma ma ustawiony serwer poczty (i nie odrzucił on logowania) oraz instancja ma `POCZTA_WYSYLKA=1`, link idzie mailem wyłącznie na adres zaproszonej osoby: osoba dodająca widzi „Link wysłaliśmy na ten adres” i nie dostaje linku do ręki. Włącznik „Wysyłaj maile z planu akcji” zaproszeń nie dotyczy. Bez poczty, przy błędzie serwera albo wyniku niepewnym link wraca do skopiowania jak dotąd, a konto założone z takiego linku ma hasło do zmiany przy pierwszym logowaniu. Mail z zaproszeniem widać w Ostatnich mailach (adres zamaskowany). Ponowne wysłanie = nowe zaproszenie na ten sam adres (stary link przestaje działać).

Hamulce: najwyżej 3 maile z zaproszeniem na godzinę na jeden adres i 20 na godzinę w firmie; zaproszenia liczą się też do limitu 300 maili firmy na godzinę i go sprawdzają. Po przekroczeniu zaproszenie powstaje, a link wraca do skopiowania. Panel czeka na serwer poczty najwyżej ok. 10 sekund; gdy serwer nie odpowiada, link też wraca do skopiowania.

## Dane firmy w mailach

Stopka maili (nazwa firmy, NIP, adres, e-mail i telefon) pochodzi z Ustawienia → Dokumenty i faktury → Dane firmy. Maile do biura (błąd faktury, niski stan) idą na „E-mail biura” z Danych firmy; gdy go tam nie ma, na „Adres biura” z Ustawienia → Komunikacja i poczta → Poczta (ekran Poczta podpowiada przy polu, który adres działa).

## Reset hasła

„Nie pamiętam hasła” na stronie logowania wysyła link ważny 60 minut, jeden raz. Odpowiedź na stronie jest zawsze ta sama, także dla adresu bez konta. **Link idzie wyłącznie pocztą serwera Kompletora (poczta instalacji), nigdy serwerem poczty firmy z Ustawień → Poczta.** Konto jest wspólne dla całej instalacji, a serwer poczty firmy może zmienić każdy z uprawnieniem do ustawień, więc link wysłany tym serwerem dałby tej osobie dostęp do cudzego konta (także właściciela). Pocztę instalacji ustawia administrator serwera zmiennymi `RESET_SMTP_HOST`, `RESET_SMTP_PORT` (domyślnie 587), `RESET_SMTP_SZYFROWANIE` (`STARTTLS` domyślnie, `TLS` albo `BRAK`; w hostingu tylko szyfrowane), `RESET_SMTP_LOGIN`, `RESET_SMTP_PASSWORD`, `RESET_SMTP_NADAWCA` (adres nadawcy) i `RESET_SMTP_NAZWA` (nazwa nadawcy, domyślnie „Kompletor”); potrzebny jest też `PANEL_URL` instancji i `POCZTA_WYSYLKA=1`. Mail ma stopkę z danych firmy, ale nadawcę i adres odpowiedzi z poczty instalacji. Ustawienia poczty firmy i jej włączniki nie mają na reset wpływu; odrzucony login serwera instalacji trafia tylko do logu workera. Bez poczty instalacji link nie powstaje. Linki wygasłe raz na dobę tracą zaszyfrowany token, a po dobie znikają z bazy. Po ustawieniu hasła konto wylogowuje się na wszystkich urządzeniach. Bez poczty hasło startowe nadaje właściciel firmy (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia) albo administrator poleceniem z [Instalacji](instalacja.md).

## Dostawcy poczty

- Amazon SES: serwer `email-smtp.<region>.amazonaws.com`, port 587, STARTTLS, login i hasło SMTP z konsoli SES (to nie są klucze dostępu AWS).
- Google Workspace i Gmail: `smtp.gmail.com`, port 587, STARTTLS, hasło aplikacji.
- Poczta w hostingu (home.pl, dhosting, OVH i inne): serwer i port z panelu hostingu, zwykle 587 ze STARTTLS albo 465 z SSL/TLS.

W hostingu Kompletora serwer poczty musi być dostępny z internetu (bez adresów lokalnych), port 25, 465, 587 albo 2525, połączenie szyfrowane. Hasło zapisuje się zaszyfrowane jako sekret firmy; ekran pokazuje tylko, czy jest ustawione.

## Czego ekran Poczta nie robi

- Nie wysyła mailingów do listy klientów (od tego jest program do newslettera).
- Nie wysyła SMS-ów.
- Nie zmienia trybu konta kanału: przełącznik „Tylko podgląd” / „Aktywny” jest w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży.
- Nie pokazuje pełnych adresów klientów: adres widać na karcie zamówienia z uprawnieniem do danych klientów.
- Nie zmienia danych firmy w stopce: te są w Ustawienia → Dokumenty i faktury → Dane firmy.
- Nie wysyła zaproszeń: zaprasza się w Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia („Dodaj osobę”).
