# Powiadomienia: alerty na Zulip

Ostrzeżenie systemu (np. błąd faktury albo brak towaru) może wyjść jako wiadomość na Zulipie, do strumienia i tematu
wybranego dla jego grupy. Domyślnie nic nie wychodzi.

Dla administratora: alert to wpis w tabeli `Alert` (jedyne wejście `alert()` w `lib/rdzen/stan.ts`). Wysyłka
wymaga obu bramek:

1. instancja: env `POWIADOMIENIA_WYSYLKA=1` (web i worker; puste/`0` = wyłączona, inna wartość = worker nie startuje),
2. firma: włącznik w **Ustawienia → Komunikacja i poczta → Powiadomienia** (`/ustawienia/powiadomienia`, uprawnienie `ustawienia`).

Wychodzą tylko alerty powstałe od chwili ostatniego włączenia firmy (`NotificationSettings.enabledAt`): włączenie nie
wysyła zaległych.

## Jak włączyć, krok po kroku

1. **Bot w Zulipie.** W Zulipie: Ustawienia osobiste → Boty → „Dodaj bota” typu *Generic*. Zapisz adres bota
   (np. `kompletor-bot@firma.zulipchat.com`) i jego klucz API. Dodaj bota do strumieni, do których ma pisać
   (domyślnie „Biuro” i „Magazyn”; strumienie muszą istnieć).
2. **Klucz bota jako sekret firmy** (nigdy w env, w panelu ani w repo):
   ```
   npm run sekret -- --firma <slug> --ustaw ZULIP_API_KEY --ze-stdin   # wklej klucz, Enter, Ctrl+D
   ```
   W obrazie: `docker compose exec -T web kompletor sekret --firma <skrót firmy> --ustaw ZULIP_API_KEY --ze-stdin < klucz.txt`. Ekran pokazuje tylko „Klucz bota ustawiony: tak/nie”.
3. **Env instancji** (Coolify, web i worker):
   - `POWIADOMIENIA_WYSYLKA=1`,
   - Zulip na własnym serwerze: `ZULIP_DOZWOLONE_HOSTY=zulip.firma.pl` (po przecinku, `nazwa` albo `*.domena`;
     puste = `*.zulipchat.com`),
   - opcjonalnie `APP_PUBLIC_URL=https://kompletor.firma.pl`: link „Otwórz panel” w wiadomości.
4. **Ekran** `/ustawienia/powiadomienia`: adres Zulipa (`https://firma.zulipchat.com`), adres bota, strumień i temat
   dla każdej grupy; „Zapisz”, potem **„Wyślij wiadomość próbną”** (działa także przed włączeniem; najwyżej jedna na minutę na firmę). Gdy próba doszła,
   zaznacz „Wysyłaj alerty tej firmy na Zulip” i zapisz.

Wyłączenie: odznaczyć włącznik (firma) albo `POWIADOMIENIA_WYSYLKA=0` (cała instancja, od następnego przebiegu).

## Grupy alertów

Stała mapa `kind` → grupa w `lib/powiadomienia/grupy.ts`. Rodzaj spoza mapy trafia do „Inne”, więc nowy alert nie ginie.

| Grupa | Rodzaje | Domyślnie |
|---|---|---|
| Kanał nie przyjmuje stanów | `KANAL_NIEDOSTEPNY`, `NOC_SYNC_BLAD` | Biuro |
| Kanał nie czyta zamówień | `KANAL_ZAMOWIENIA_NIEDOSTEPNY` | Biuro |
| Faktury | `FAKTURA_BLAD`, `FAKTURA_BL_BLAD`, `FAKTURA_BEZ_WZ`, `DUBLET_FAKTURY`, `WFIRMA_LIMIT`, `WFIRMA_ODCZYT_BLAD`, `KOREKTA_BLAD`, `DUBLET_KOREKTY`, `FAKTURA_BL_TOWAR_W_PRACY`, `FAKTURA_BL_W_KOLEJCE`, `FAKTURY_BL_NUMERY_SKLEPU`, `FAKTURA_BL_I_KOMPLETORA`, `FAKTURA_BL_BEZ_PARY` | Biuro |
| Magazyn | `BRAK_NA_POLCE`, `NADMIAR_REZERWACJI`, `BRAK_PRZY_PAKOWANIU`, `DOSLANIE_ZAMIAST_ZWROTU`, `WFIRMA_BRAK_TOWARU` | Magazyn |
| Inne | wszystko inne, m.in. `INTEGRACJA_WYLACZONA` (konto sklepu albo przewoźnika wyłączone po serii błędów połączenia: [Integracje](integracje/README.md#limity-zapytań-i-automatyczne-wyłączanie)) | Biuro |

Alerty o fakturach z BaseLinkera po przełączeniu konta w tryb pracy (procedura: [Migracja z BaseLinkera](migracja-z-baselinkera.md#zamówienie-z-fakturą-z-baselinkera-po-przełączeniu)):

- `FAKTURA_BL_TOWAR_W_PRACY`: faktura z BaseLinkera zobaczona przy zamówieniu, które w Kompletorze ma odłożony towar albo brak czekający na dostawę.
- `FAKTURA_BL_W_KOLEJCE`: faktura z BaseLinkera przy zamówieniu, które stoi w kolejce pakowania (do realizacji, zbieranie, zebrane). Kompletor wstrzymuje jego pakowanie. Ten sam rodzaj z osobną treścią, gdy zamówienie było już spakowane: paczka wychodzi z Kompletora („Do wysyłki” na karcie), dokumentem sprzedaży jest faktura z BaseLinkera.
- `FAKTURA_BL_I_KOMPLETORA`: faktura z BaseLinkera przy zamówieniu, do którego Kompletor wystawił już (albo wystawia) własny dokument sprzedaży, także gdy faktura z BaseLinkera przyszła dopiero po połączeniu zamówienia z BaseLinkerem i nie ma już czego rozliczać. Zostaw jeden dokument, drugi skoryguj; nie zamyka się sam. Gdy faktura z BaseLinkera nic nie zdjęła ze stanu (rezerwacje zużył już dokument Kompletora), treść mówi, że towar zszedł raz, a do wyjaśnienia są dwa dokumenty sprzedaży; błąd przy zgłaszaniu tego alertu trafia do błędów przebiegu i nie wstrzymuje zakończenia faktury.
- `FAKTURA_BL_BEZ_PARY`: faktura z BaseLinkera na koncie w trybie pracy, której Kompletor po 15 minutach nie połączył z żadnym swoim zamówieniem. Odnośnik: „<numer ze sklepu> (BL <numer w BaseLinkerze>)”; treść mówi, jak znaleźć zamówienie i co zrobić, gdy w Kompletorze go nie ma. Zamyka się sam po połączeniu (którąkolwiek drogą). Powyżej 5 takich faktur na koncie w jednym przebiegu: jeden alert zbiorczy na konto (ten sam rodzaj, odnośnik „<konto>: N faktur bez zamówienia: <pierwsze numery ze sklepu>…”, do 120 znaków) z listą do 30 numerów ze sklepu i „i N kolejnych” (przy długich numerach lista jest krótsza, instrukcja zawsze cała). Gdy na liście pojawi się zamówienie, którego nie było w poprzedniej liście, stare zgłoszenie zamyka się i powstaje nowe (nowa wiadomość, wraca na górę pulpitu); gdy lista tylko maleje, odświeża się w tym samym zgłoszeniu bez nowej wiadomości. Zgłoszenie zamyka się przy 5 lub mniej (wtedy pojedyncze) albo przy pustej liście. Lista zamówień zgłoszenia jest zapisana w polu danych alertu (`data.blOrderIds`), nie odczytywana z treści.
- `FAKTURY_BL_NUMERY_SKLEPU`: odczyt numerów zamówień ze sklepu nie działa, a najstarsza faktura z BaseLinkera bez pary czeka ponad 24 h; najwyżej jeden na dobę od poprzedniego zgłoszenia (nowe zamyka poprzednie, więc przy trwałej awarii otwarty jest jeden), liczby w treści alertu. Raport dzienny porównania z BaseLinkerem (część o fakturach BL) podaje co dzień liczbę faktur BL bez zamówienia w Kompletorze, wiek najstarszej, czy ten alert jest otwarty i ile zamówień rozliczyła tego dnia samonaprawa po fakturze BL.

Zamykają się same, gdy przestają być aktualne. `FAKTURA_BL_W_KOLEJCE` i `FAKTURA_BL_TOWAR_W_PRACY`: zamówienie wyszło z kolejki pakowania (np. „Do wyjaśnienia”, wysłane), zostało anulowane, nie trzyma już towaru albo dostało „Pakuj mimo faktury z BaseLinkera” (ten przycisk zamyka alert od razu). Sprawdza to przebieg odczytu faktur z BaseLinkera (`cien-bl-faktury`, co 2 minuty) i niezależnie od klucza BaseLinkera przebieg rdzenia `rdzen-wygasanie` (co 5 minut). `FAKTURY_BL_NUMERY_SKLEPU` zamyka się po pierwszym udanym odczycie numerów ze sklepu.

Pusty strumień grupy = jej alerty nie wychodzą (wiersz dostarczenia `FAILED` „grupa bez trasy”, bez ponawiania).

## Co jest w wiadomości

Etykieta rodzaju, nazwa firmy, `ref` alertu (id techniczne, numer zamówienia albo konto kanału; `ref` z „@” jest
ukrywany), godzina (Europe/Warsaw) i link do panelu, gdy jest `APP_PUBLIC_URL`. **`Alert.message` nie jest używany ani
czytany**: komunikaty błędów z zewnątrz (`FAKTURA_BLAD`, `KOREKTA_BLAD`, `BLAD_ZAMOWIENIA`, `ZAMOWIENIE_KANALU_BLAD`)
mogą nieść dane nabywcy.

## Jak działa wysyłka

Zadanie workera `powiadomienia-zulip` co 60 s dla każdej firmy (`lib/powiadomienia/wysylka.ts`):

- najwyżej 20 alertów na przebieg i 100 wywołań na godzinę na firmę, najstarsze pierwsze; nadmiar czeka na kolejny
  przebieg (licznik „czeka” w logu workera);
- **jeden alert = najwyżej jedna wiadomość**: wiersz `AlertDelivery` w stanie `SENDING` powstaje przed wywołaniem
  (unikalny `alertId` w firmie chroni przed równoległym przebiegiem), `SENT` po odpowiedzi 200;
- 429, 5xx (bez 504) i brak połączenia: ponowienie z odstępem 1, 2, 5, 15 min (albo `Retry-After`), najwyżej 5 prób,
  potem `FAILED`;
- timeout po wysłaniu żądania, zerwane połączenie, 504 i `SENDING` starszy niż 10 min (przerwany worker):
  `UNCERTAIN` **bez ponowienia**, bo Zulip nie ma klucza idempotencji, a spam jest gorszy niż brak wiadomości;
- 401/403: wysyłka firmy wyłączona, powód na ekranie; po naprawie klucza albo bota włączyć ponownie. Gdy przerwa
  trwała najwyżej 3 dni, alerty z przerwy wychodzą po włączeniu (dawkowane limitem); dłuższa przerwa = od chwili włączenia;
- alert zamknięty w panelu, zanim przyszła jego kolej (limit, ponowienie), nie wychodzi;
- inne 4xx (np. strumień nie istnieje, bot bez dostępu): `FAILED` bez ponawiania, kod błędu widać w „Ostatnich
  dostarczeniach”;
- błąd jednego alertu nie zatrzymuje reszty.

Adres Zulipa: tylko `https`, host z listy (`*.zulipchat.com` albo `ZULIP_DOZWOLONE_HOSTY`), bez IP, `localhost`, portu
i ścieżki; sprawdzany przy zapisie i drugi raz przed każdą wysyłką. Przekierowania odpowiedzi są odrzucane.
Klucz nie trafia do `routes`, odpowiedzi, logów ani `lastError`.

## Transport

`POST <adres>/api/v1/messages`, Basic Auth `adres-bota:klucz`, formularz `application/x-www-form-urlencoded`:
`type=stream`, `to=<strumień>`, `topic=<temat>`, `content=<Markdown>`, timeout 15 s. Sukces: HTTP 200 i JSON
`{"result":"success","id":…}`; błąd: `{"result":"error","msg":…,"code":…}`. Kształt według dokumentacji Zulipa
(`zulip.com/api/send-message`), do potwierdzenia na żywo przy pierwszej wiadomości próbnej.
