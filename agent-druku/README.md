# Agent druku Kompletora

Mały program na komputer z Windows w magazynie. Co kilka sekund pyta serwer Kompletora, czy jest coś do
wydrukowania, drukuje to na właściwej drukarce i odsyła wynik. Co minutę zgłasza też stan drukarek; serwer
pokazuje go w nagłówku ekranu pakowania.

Drukarki na stanowisku są opisane **rolami**, a nie nazwami Windows. Od wersji 0.2.0 drukarek może
być dowolnie wiele — rola to tekst według wzoru `A4`, `A4_<1–2 cyfry>` albo `TERMICZNA_<1–2 cyfry>`:

| Rola                         | Typowa drukarka     | Co drukuje                                                                  |
|------------------------------|---------------------|-----------------------------------------------------------------------------|
| `A4`                         | Brother A4          | karty zamówień, listy wysyłkowe, spisy produktów, awaryjnie etykiety (PDF)   |
| `A4_2`, `A4_3`…              | kolejne zwykłe      | to, co przypisze im panel (Ustawienia → Wysyłka i druk → Druk); PDF, nigdy ZPL               |
| `TERMICZNA_1`                | Termiczna 1         | etykiety kurierskie (ZPL albo PDF)                                          |
| `TERMICZNA_2`, `TERMICZNA_3`… | kolejne termiczne   | etykiety; zapas dla poprzedniej termicznej                                  |

Serwer wie tylko o rolach. To, że `TERMICZNA_1` to w Windows „ZDesigner GK420d (kopia 1)”, wie wyłącznie
plik konfiguracyjny na tym jednym komputerze.

Program jest osobnym pakietem (własny `package.json`), napisany w TypeScript, **bez zależności uruchomieniowych**.
Na komputer w magazynie trafia paczka ZIP z gotowym Node.js (`runtime\node.exe`) i SumatraPDF
(`sumatra\SumatraPDF.exe`) oraz jednym plikiem `Zainstaluj.cmd`. Stary folder bez paczki (Node z PATH,
SumatraPDF w Program Files) dalej działa. Serwer: [`docs/druk.md`](../docs/druk.md) w repozytorium Kompletora.

---

## Spis treści

1. [Instalacja (dla osoby w magazynie)](#1-instalacja-krok-po-kroku)
2. [Codzienna obsługa i co robić, gdy coś nie działa](#2-codzienna-obsługa)
3. [Konfiguracja `agent-druku.json`](#3-konfiguracja-agent-drukujson)
4. [Kontrakt z serwerem (dla programisty serwera)](#4-kontrakt-z-serwerem)
5. [Jak agent działa: kolejka, idempotencja, awarie](#5-jak-agent-działa)
6. [Dlaczego SumatraPDF i surowy ZPL](#6-dlaczego-sumatrapdf-i-surowy-zpl)
7. [Dla programisty: budowanie, testy, paczka](#7-dla-programisty)
8. [Ograniczenia i rzeczy do sprawdzenia na miejscu](#8-ograniczenia)

---

## 1. Instalacja krok po kroku

Potrzebne: komputer w magazynie z Windows 10 lub 11, internet, zainstalowane drukarki (strona testowa z Windows
wychodzi), paczka **`Kompletor-Druk-<wersja>-win-x64.zip`** (link w panelu: **Ustawienia → Wysyłka i druk → Druk**) oraz **kod
instalacyjny** stanowiska (długi tekst zaczynający się od `kmi_`, z tego samego ekranu: „Utwórz token i kod
instalacyjny”). Node.js i SumatraPDF są w paczce — niczego więcej nie instalujesz.

1. Rozpakuj ZIP (prawy przycisk → **Wyodrębnij wszystkie**) i w rozpakowanym folderze kliknij dwa razy
   **`Zainstaluj.cmd`**.
2. Instalator skopiuje program do `C:\Kompletor\agent-druku`, założy start przy logowaniu, doda skrót
   **„Kompletor Druk (ustawienia)”** na pulpicie i w menu Start, uruchomi program (pierwszy start może potrwać
   do 2 minut) i otworzy w przeglądarce stronę **„Kompletor Druk (ustawienia)”**.
3. Na stronie, w ramce **„Podłącz do Kompletora”**, wklej kod instalacyjny (Ctrl+V) i kliknij **„Sprawdź i
   podłącz”**. Program sprawdzi kod na serwerze.
4. W ramce **„Drukarki”** przy każdej drukarce z Windows wybierz **Kartki A4**, **Etykiety** albo **Nie używaj**.
   Gdy kilka drukarek ma ten sam rodzaj, przy każdej wybierz **Główna** albo **Zapasowa** (role `A4`, `A4_2`…,
   `TERMICZNA_1`, `TERMICZNA_2`…). Nie wiesz, która pozycja to która drukarka? Kliknij **„Wydruk próbny”**: wyjdzie
   kartka z dużym numerem pozycji i nazwą z Windows (bez połączenia z serwerem).
5. Kliknij **„Zapisz”** na dolnym pasku. Program od razu używa nowych ustawień, bez wylogowania z Windows.
   Na górze strony pojawi się „Połączono z Kompletorem.”
6. W panelu (**Ustawienia → Wysyłka i druk → Druk**) zrób **Wydruk testowy** na każdej drukarce.
7. W Windows wyłącz **„Zezwalaj systemowi Windows na zarządzanie drukarką domyślną”** (w ustawieniach Windows: Bluetooth i
   urządzenia → Drukarki i skanery). Strona ustawień pokazuje ostrzeżenie, dopóki to ustawienie jest włączone.

Gdy strona się nie otworzy, instalator dokończy w czarnym oknie. Tę drogę można też wybrać od razu:
`Zainstaluj.cmd /konsola`. **Instalacja w oknie:** wklej kod (prawy przycisk myszy w oknie, Enter); przy każdej
drukarce wpisz **A** (kartki A4), **T** (etykiety), **P** (kartka próbna, pytanie wraca) albo Enter (pomiń);
potwierdź podsumowanie. Instalator uruchomi program i poczeka na pierwszy raport stanu drukarek („Gotowe: agent
druku działa…”).

**Strona ustawień** działa tylko na tym komputerze (adres `http://127.0.0.1:<port>/u/<klucz>/`, port 47631 albo
47632, klucz w `dane\ustawienia-klucz.txt`); bez klucza w adresie strona nic nie pokazuje. Zawiera: stan programu
jednym zdaniem (połączenie, ostatni wydruk, ostatni błąd z podpowiedzią), drukarki z wyborem i wydrukiem próbnym,
podłączenie kodem, **„Ostatnie zdarzenia”** (log przełożony na zdania) i przycisk **„Uruchom ponownie program”**.
Kod połączenia ani token stanowiska nie wracają na stronę i nie trafiają do logu. Klucz jest nowy przy każdym starcie
programu (stary adres z historii przeglądarki przestaje działać; wyjątek: „Uruchom ponownie program” zostawia otwartą
kartę działającą), dlatego stronę otwieraj zawsze skrótem. Instalator zawęża uprawnienia folderu programu do konta,
które go instaluje, SYSTEM i Administratorów, żeby inne konto Windows na tym komputerze nie mogło podmienić programu.

Od teraz program uruchamia się sam po zalogowaniu do Windows, działa w tle i sam wstaje po awarii.

- **Aktualizacja:** rozpakuj nową paczkę i uruchom jej `Zainstaluj.cmd`. Konfiguracja (`agent-druku.json`) i rejestr
  wydruków (`dane\`) zostają, zadanie Harmonogramu jest jedno. Instalator zatrzymuje agenta na czas podmiany plików —
  rób to, gdy nic się nie drukuje.
- **Nowy kod albo inne drukarki:** skrót „Kompletor Druk (ustawienia)” (wklej nowy kod albo zmień drukarki,
  „Zapisz”). W oknie: `Zainstaluj.cmd /nowy`.
- **Każdy komputer ma własne stanowisko i token.** Dwa komputery z tym samym kodem to błąd konfiguracji: drukowałyby
  na zmianę i mieszały stan drukarek.
- **Ręczna konfiguracja** (dla zaawansowanych): `agent-druku.json` można edytować w Notatniku (sekcja 3), potem
  `Zainstaluj.cmd` (Enter = bez zmian konfiguracji) sprawdzi plik i uruchomi agenta.
- **Odinstalowanie:** `odinstaluj.cmd` w `C:\Kompletor\agent-druku`. Folder z konfiguracją i logami zostaje.

> Kod instalacyjny zawiera token stanowiska (hasło). Nie wysyłaj go mailem ani czatem. Jeśli wyciekł — w panelu
> „Nowy token” (stary przestaje działać od razu) i ponownie `Zainstaluj.cmd /nowy`.

---

## 2. Codzienna obsługa

Program nie wymaga obsługi. Komputer musi być włączony, a użytkownik zalogowany.

| Co widać                                                        | Co zrobić                                                                                           |
|-----------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| Ekran pakowania: termiczna „offline”                            | Sprawdź zasilanie i kabel USB drukarki. Etykiety w tym czasie Kompletor skieruje na kolejną termiczną albo A4. |
| Ekran pakowania: „brak papieru lub etykiet”, „otwarta pokrywa”  | Załóż rolkę / zamknij pokrywę. Stan odświeża się co minutę.                                          |
| Cokolwiek nie działa                                            | Najpierw otwórz skrót **„Kompletor Druk (ustawienia)”**: na górze stan jednym zdaniem i „Co zrobić”, niżej „Ostatnie zdarzenia”. Przycisk „Uruchom ponownie program” zastępuje wylogowanie z Windows. |
| Ekran pakowania: brak stanu drukarek od kilku minut             | Program nie działa albo nie ma internetu. Najpierw otwórz `logi\start.log` i sprawdź dwa wiersze niżej. Jeśli żaden nie pasuje: wyloguj się i zaloguj ponownie do Windows; jeśli nie pomoże — zajrzyj do `logi\agent-druku.log`. |
| W `start.log` albo `agent-druku.log`: „Błędna konfiguracja” / „kodem 2” | Program nie wystartuje, dopóki plik się nie zmieni (ponowne logowanie nic nie da). Uruchom `Zainstaluj.cmd /nowy` (nowy kod i drukarki) albo popraw `agent-druku.json` według listy błędów i uruchom `Zainstaluj.cmd`. |
| W logu „Agent druku już działa”, a ekran pakowania nie pokazuje stanu drukarek | Zamknij okno `uruchom.cmd`, jeśli jest otwarte, i odczekaj minutę. Jeśli nadal nic: usuń plik `C:\Kompletor\agent-druku\dane\agent.lock` i uruchom `Zainstaluj.cmd`. |
| Komunikat „Druk przerwany… sprawdź, czy wydruk wyszedł”         | Program był zamykany w trakcie druku. Jeśli wydruk nie wyszedł, zleć go ponownie z ekranu.           |
| Komunikat „Nie wiadomo, czy wydruk wyszedł: drukarka … nie odpowiedziała” | Drukarka (albo jej sterownik) nie odpowiedziała w limicie czasu. Sprawdź, czy wydruk wyszedł i czy drukarka działa; jeśli nie wyszedł — zleć go ponownie z ekranu. Kompletor nie przekieruje go sam na zapasową drukarkę, żeby nie wyszły dwie etykiety. |
| Komunikat „ma N niewydrukowanych zadań w kolejce Windows”       | Drukarka stoi. Otwórz jej kolejkę (Drukarki i skanery → drukarka → Otwórz kolejkę), anuluj stare zadania, sprawdź drukarkę. |
| Chcę zobaczyć, co program robi                                  | Otwórz `C:\Kompletor\agent-druku\logi\agent-druku.log` w Notatniku. Najnowsze wpisy są na końcu.     |
| Chcę uruchomić program „na widoku”                               | Najpierw `odinstaluj.cmd`, potem dwa razy `uruchom.cmd` (okno z logiem; zamknięcie okna zatrzymuje program). Na koniec znów `Zainstaluj.cmd`. |

Log ma rotację: plik `agent-druku.log` rośnie do 5 MB, potem staje się `agent-druku.log.1`, a najstarszy
(`.5`) jest usuwany. W logu nigdy nie ma tokenu ani treści drukowanych dokumentów. Plik `logi\start.log`
zbiera tylko awarie samego uruchamiania (np. brak `runtime\node.exe`, błędna konfiguracja, druga kopia programu);
jest w UTF-8 i otwiera się poprawnie w Notatniku.

---

## 3. Konfiguracja `agent-druku.json`

Plik leży obok programu (`C:\Kompletor\agent-druku\agent-druku.json`), poza repozytorium (`.gitignore`). Zwykle
zapisuje go instalator (kod instalacyjny + przypisanie drukarek); ręczna edycja jest dla zaawansowanych.
Można wskazać inny: `runtime\node.exe dist\main.js --konfig D:\ścieżka\plik.json`. Wzór: `agent-druku.przyklad.json`.
Instalator przy zmianie kodu podmienia tylko `serwer`, `token`, `stanowisko` i `drukarki`; pozostałe pola zostają.

| Pole                       | Wymagane | Domyślnie                                       | Znaczenie                                                          |
|----------------------------|----------|-------------------------------------------------|--------------------------------------------------------------------|
| `serwer`                   | tak      | —                                               | Adres Kompletora (https; http tylko w zaufanej sieci lokalnej — w logu pojawi się ostrzeżenie). Może zawierać ścieżkę, np. `https://firma.pl/kompletor`. |
| `token`                    | tak      | —                                               | Token stanowiska (min. 16 znaków), wysyłany jako `Authorization: Bearer`. |
| `stanowisko`               | tak      | —                                               | Id stanowiska: litery bez polskich znaków, cyfry, `-`, `_`.         |
| `drukarki`                 | tak      | —                                               | Mapa rola → nazwa drukarki Windows; co najmniej jedna rola. Rola: `A4`, `A4_2`…, `TERMICZNA_1`, `TERMICZNA_2`… (wzór `^A4(_[0-9]{1,2})?$\|^TERMICZNA_[0-9]{1,2}$`); inna = błąd konfiguracji. |
| `sumatraPdf`               | nie      | `sumatra\SumatraPDF.exe` obok programu, gdy jest; inaczej `C:\Program Files\SumatraPDF\SumatraPDF.exe` | Ścieżka do SumatraPDF.                                              |
| `powershell`               | nie      | `powershell.exe`                                | PowerShell do druku ZPL i odczytu stanu drukarek.                   |
| `odpytywanieSekundy`       | nie      | 5                                               | Co ile sekund pytać o zlecenia (2–300).                             |
| `stanSekundy`              | nie      | 60                                              | Co ile sekund wysyłać stan drukarek (10–3600).                      |
| `maksKolejkaTermicznej`    | nie      | 5                                               | Tyle zadań w kolejce Windows termicznej = traktujemy ją jak awarię. |
| `limitCzasuDrukuSekundy`   | nie      | 60                                              | Limit na jedno wywołanie SumatraPDF / PowerShella.                  |
| `limitCzasuSerweraSekundy` | nie      | 20                                              | Limit na jedno żądanie HTTP.                                        |
| `maksRozmiarPlikuMb`       | nie      | 20                                              | Większy plik do druku jest odrzucany (sprawdzane w trakcie pobierania). |
| `dozwoloneHostyPlikow`     | nie      | `[]`                                            | Obce hosty, z których wolno pobierać pliki do druku, np. `["pliki.kompletor.pl"]` (podpisane linki do magazynu plików). Sama nazwa hosta, opcjonalnie z portem (`"cdn.firma.pl:8443"`), bez `https://` i bez ścieżki. Wpis bez portu pasuje tylko do portu domyślnego. Pusta lista = pliki tylko z adresu `serwer`. |
| `katalogDanych`            | nie      | `dane`                                          | Rejestr wydruków, blokada, pliki tymczasowe (względne = od folderu programu). |
| `katalogLogow`             | nie      | `logi`                                          | Logi.                                                               |
| `log.maksMb`, `log.plikow` | nie      | 5, 5                                            | Rotacja logu: rozmiar jednego pliku i liczba starych plików.        |

Błędy konfiguracji program wypisuje wszystkie naraz, po polsku, do logu. Samo sprawdzenie pliku, bez
uruchamiania agenta: `runtime\node.exe dist\main.js --sprawdz-konfig` (kod wyjścia 0 = poprawna, 2 = błędy; robi to też
`Zainstaluj.cmd` przed założeniem zadania).

---

## 4. Kontrakt z serwerem

Typy TypeScript: [`src/kontrakt.ts`](src/kontrakt.ts) — serwer powinien użyć tych samych nazw pól.
Wszystkie żądania mają nagłówek `Authorization: Bearer <token stanowiska>`; serwer sprawdza, czy token należy
do stanowiska z parametru/treści. Odpowiedź 401/403 agent zapisuje w logu raz, z podpowiedzią „Zainstaluj.cmd /nowy”,
i od tej chwili pyta serwer tylko co 5 min (bez zleceń i stanu w przerwie). Po 429 czeka tyle, ile mówi `Retry-After`
(bez nagłówka 60 s, najwyżej godzinę).

```ts
// 0.2.0: rola to tekst według wzoru, zgodnie wstecz z trzema rolami 0.1.0
type RolaDrukarki = string // ^A4(_[0-9]{1,2})?$ | ^TERMICZNA_[0-9]{1,2}$ ; termiczna = prefiks TERMICZNA_
type TypZlecenia = 'karta' | 'lista' | 'spis' | 'etykieta'
type FormatZlecenia = 'pdf' | 'zpl'

interface ZlecenieDruku {
  id: string            // [A-Za-z0-9_-]{1,100}; unikalne; ponowny druk = NOWE id
  typ: TypZlecenia
  format: FormatZlecenia // 'zpl' tylko na rolę termiczną (TERMICZNA_…); każda inna rola = PDF
  rola: RolaDrukarki
  plikUrl: string       // bezwzględny albo względny wobec adresu serwera
  kopie: number         // liczba całkowita 1–20
  utworzono?: string    // ISO 8601, informacyjnie
}
```

### `GET /api/druk/zlecenia?stanowisko=<id>`

Odpowiedź `200`:

```json
{ "zlecenia": [
  { "id": "Z-1001", "typ": "etykieta", "format": "zpl", "rola": "TERMICZNA_1",
    "plikUrl": "/api/druk/pliki/Z-1001", "kopie": 1, "utworzono": "2026-10-25T08:00:00Z" }
] }
```

- Serwer zwraca zlecenia **oczekujące na wynik** w kolejności, w jakiej mają się wydrukować. Agent drukuje je
  po kolei, jedno po drugim.
- Po otrzymaniu wyniku (OK albo BLAD) serwer **przestaje** zwracać to zlecenie. Dopóki wyniku nie dostał —
  zwraca je dalej; agent nie wydrukuje go drugi raz, tylko ponowi raport (patrz niżej).
- Zlecenie z błędnymi polami (rola spoza wzoru, `zpl` na roli nietermicznej, kopie poza 1–20…) agent odrzuca
  i odsyła BLAD z opisem. Zlecenie bez poprawnego `id` agent tylko loguje.
- **Zgodność wersji:** serwer zleca wyłącznie role z **ostatniego raportu stanu** tego stanowiska
  (`POST /api/druk/stan`). Agent 0.1.0 zgłasza najwyżej `A4`, `TERMICZNA_1`, `TERMICZNA_2`, więc nigdy nie dostanie
  roli, której nie zna. Brak roli w raporcie = komunikat w panelu, zlecenie nie powstaje.
- Plik: `plikUrl` względny jest liczony od adresu serwera i pobierany **z tokenem**. Adres na innym hoście
  (np. podpisany link do magazynu plików) agent pobierze **tylko wtedy, gdy host jest wpisany w
  `dozwoloneHostyPlikow`** w konfiguracji stanowiska, i to **bez tokenu**; inny host = BLAD „Niedozwolony host
  pliku” (żeby zlecenie nie mogło kazać agentowi odpytywać urządzeń w sieci magazynu). PDF musi zaczynać się od
  `%PDF-`, ZPL musi zawierać `^XA`. Polskie znaki w ZPL: serwer generuje etykietę z `^CI28` (UTF-8).
- **Przekierowania (3xx) nie są wykonywane** — ani dla API, ani dla plików. Odpowiedź 3xx agent traktuje jak
  błąd z podpowiedzią „sprawdź adres serwera” (np. `http` zamiast `https`). Serwer i magazyn plików muszą
  odpowiadać od razu pod podanym adresem.

### `POST /api/druk/zlecenia/{id}/wynik`

```ts
interface RaportWyniku {
  stanowisko: string
  wynik: 'OK' | 'BLAD'
  komunikat?: string          // po polsku, dla człowieka; przy BLAD zawsze
  rola: RolaDrukarki
  drukarka?: string           // nazwa drukarki Windows
  rolaZapasowa?: RolaDrukarki // tylko przy awarii drukarki termicznej
  ponowienieRaportu: boolean  // true = raport o zleceniu obsłużonym wcześniej, bez ponownego druku
  czas: string                // ISO 8601
}
```

```json
{ "stanowisko": "magazyn-1", "wynik": "BLAD", "rola": "TERMICZNA_1", "drukarka": "Termiczna 1",
  "komunikat": "Drukarka „Termiczna 1” (TERMICZNA_1): brak papieru lub etykiet",
  "rolaZapasowa": "TERMICZNA_2", "ponowienieRaportu": false, "czas": "2026-10-25T08:00:03.120Z" }
```

- Endpoint musi być **idempotentny**: ten sam wynik może przyjść dwa razy (np. po restarcie agenta).
- `OK` oznacza, że zadanie trafiło do kolejki wydruku Windows (SumatraPDF / spooler je przyjął), a nie, że
  kartka fizycznie wyszła — tego Windows nie potwierdza.
- **Awaria termicznej**: agent nie drukuje sam na innej drukarce. Odsyła BLAD z `rolaZapasowa` (kolejna termiczna
  z konfiguracji po numerze, za tą, która zawiodła, potem od początku — jeśli nie wiadomo, że leży; inaczej `A4`,
  a bez `A4` pierwsza inna zwykła). Serwer decyduje: tworzy **nowe zlecenie** (nowe id) na rolę zapasową tylko
  wtedy, gdy jest ona w ostatnim raporcie stanowiska — dla roli nietermicznej z etykietą w PDF, bo ZPL na A4 nie
  wydrukuje się. Zapas zapasu tylko na drukarkę nietermiczną (koniec łańcucha). Przy dwóch termicznych wynik
  jest taki sam jak w 0.1.0.
- **Przekroczony czas druku** (SumatraPDF / PowerShell nie skończył w `limitCzasuDrukuSekundy`): agent nie wie,
  czy zadanie zdążyło trafić do kolejki Windows. Odsyła BLAD z komunikatem „Nie wiadomo, czy wydruk wyszedł…”
  **bez `rolaZapasowa`** — serwer nie tworzy wtedy zlecenia na zapasie, tylko pokazuje komunikat pakującemu
  (inaczej mogłyby wyjść dwie etykiety kurierskie). Gdy to samo id przyjdzie ponownie, agent odpowie „Druk
  przerwany…” bez druku. Kolejne zlecenia na tę rolę w tym samym cyklu nie trafiają już do drukarki: dostają
  BLAD „zawiodła wcześniej w tym cyklu” z `rolaZapasowa` (nie dotarły do drukarki, więc zapas jest bezpieczny).
- BLAD z `ponowienieRaportu: true` i komunikatem „Druk przerwany…” znaczy: program padł w trakcie druku tego
  zlecenia i nie wiadomo, czy wyszło. Serwer pokazuje to pakującemu; ponowny druk = nowe zlecenie.
- **Ponowne użycie id.** Serwer nigdy nie zleca drugi raz tego samego id (ponowny druk = nowe id). To samo id
  może jednak wrócić, dopóki serwer nie dostał raportu: wtedy agent odsyła zapamiętany wynik (OK albo „Druk
  przerwany”), a po pewnej odmowie drukarki (nic nie wyszło) próbuje wydrukować jeszcze raz.
- Zlecenie odrzucone z powodu **nieznanej roli** ma w raporcie `rola: "A4"` jako wartość zastępczą (pole jest
  wymagane); prawdziwy powód jest w `komunikat`. Serwer nie powinien traktować tego jak odmowy drukarki A4.
- `OK` może przyjść także wtedy, gdy wydruk wyszedł, ale agent nie zdołał zapisać tego w swoim rejestrze
  (np. pełny dysk) — stan fizyczny ma pierwszeństwo; błąd zapisu trafia do logu agenta.

### `POST /api/druk/stan`

Wysyłane co `stanSekundy` (domyślnie co minutę). Brak raportu przez ~3 minuty = agent nie działa.

```ts
interface RaportStanu {
  stanowisko: string
  czas: string
  wersjaAgenta: string
  drukarki: {
    rola: RolaDrukarki
    nazwa: string
    stan: 'DOSTEPNA' | 'OFFLINE' | 'BLAD'
    komunikat?: string             // np. „brak papieru lub etykiet”, „otwarta pokrywa”, „kończy się toner”
    zleceniaWKolejce: number | null // zadania w kolejce Windows; null = nie udało się odczytać
  }[]
}
```

Odpowiedzi: agent oczekuje `2xx`; treść odpowiedzi na POST jest ignorowana.

---

## 5. Jak agent działa

```
co 5 s:   GET zlecenia ─► (są?) stan drukarek z Windows ─► dla każdego zlecenia po kolei:
            rejestr? ── WYDRUKOWANE ──► raport OK (ponowienieRaportu), bez druku
                     └─ W_TOKU ──────► raport BLAD „sprawdź, czy wyszło”, bez druku
            drukarka roli offline / błąd / zapchana kolejka ─► BLAD + rolaZapasowa
            pobierz plik ─► sprawdź PDF/ZPL ─► rejestr W_TOKU ─► drukuj ─► rejestr WYDRUKOWANE ─► raport OK
            drukarka odrzuciła ─► usuń z rejestru, kolejne zlecenia na tę rolę w tym cyklu od razu BLAD
                                  ─► raport BLAD + rolaZapasowa
            przekroczony czas ─► wpis W_TOKU zostaje ─► raport BLAD „nie wiadomo, czy wyszło”, bez rolaZapasowa
co 60 s:  stan drukarek ─► POST stan
co 1 h:   sprzątanie rejestru (wpisy starsze niż 7 dni)
```

- **Idempotencja.** Plik `dane\wydrukowane.json` trzyma id obsłużonych zleceń (zapis atomowy: plik
  tymczasowy + zamiana). Wpis `W_TOKU` powstaje tuż przed wysłaniem do drukarki, `WYDRUKOWANE` zaraz po.
  Wolimy, żeby po zaniku prądu w trakcie druku jedna etykieta nie wyszła (pakujący to widzi i zleca ponownie),
  niż żeby wyszły dwie identyczne etykiety kurierskie (dwa nadania). Wpisy starsze niż 7 dni są usuwane.
- **Jedna kopia programu.** Plik `dane\agent.lock` z numerem procesu i czasem startu (zakładany atomowo);
  druga kopia kończy pracę od razu kodem 3 (dwie kopie drukowałyby to samo), a `start.ps1` próbuje ponownie co
  60 s. Blokada jest przejmowana, gdy procesu już nie ma **albo gdy ten numer ma teraz inny program niż Node**
  (po zaniku prądu Windows rozdaje numery procesów od nowa). Gdy nie da się sprawdzić procesu (`tasklist`
  nie działa), blokada zostaje — lepiej poczekać niż drukować dwiema kopiami. Zostaje drobne ryzyko: numer
  przejął akurat inny program Node na tym komputerze; wtedy pomaga wiersz z tabeli w sekcji 2.
- **Stan drukarki nieznany agentowi** (nazwa spoza listy stanów Windows, np. własna nazwa sterownika) = drukarka
  traktowana jako dostępna, z komunikatem „nieznany stan drukarki: … — drukujemy mimo to”. Druk blokują tylko
  stany na pewno złe (offline, brak papieru, zacięcie, pokrywa, wstrzymana, błąd…). Decyzja 2026-10-26.
- **Błąd jednego zlecenia nie zatrzymuje kolejnych** — każde kończy się raportem OK albo BLAD.
- **Serwer niedostępny** — agent próbuje dalej co 5 s, w logu jest jeden wpis o awarii i jeden o powrocie.
  Wynik, którego nie udało się wysłać, wraca przy następnym pobraniu tego zlecenia (z rejestru, bez druku).
- **Stan drukarek** czyta `skrypty\stan-drukarek.ps1` (`Get-Printer` + `Win32_Printer.WorkOffline`). Gdy
  odczyt się nie uda, agent mimo to drukuje — ewentualny błąd wyjdzie przy samym druku.
- **Uruchamianie.** Harmonogram zadań Windows uruchamia przy logowaniu `skrypty\start.ps1` w ukrytym oknie;
  ten pilnuje procesu Node według kodu wyjścia: 0 = koniec, 1 = awaria (ponowny start po 30 s), 2 = błędna
  konfiguracja (koniec z wpisem w `logi\start.log`), 3 = działa inna kopia (ponowna próba co 60 s).

Decyzja 2026-10-25: **zadanie Harmonogramu przy logowaniu, a nie usługa Windows.** Usługa działa jako konto
systemowe w sesji 0: nie widzi drukarek dodanych tylko dla użytkownika, a SumatraPDF i część sterowników
(Brother) bywają tam kapryśne. Komputer w magazynie i tak jest zalogowany przez cały dzień pracy, a zadanie
przy logowaniu da się założyć bez dodatkowych programów (np. NSSM) i bez przechowywania hasła.

---

## 6. Dlaczego SumatraPDF i surowy ZPL

**PDF → SumatraPDF wywoływany bezpośrednio** (`SumatraPDF.exe -print-to "<drukarka>" -print-settings
"<n>x,fit|noscale" -silent plik.pdf`). Decyzja 2026-10-25:

- Windows nie ma wbudowanego cichego druku PDF; Adobe Reader otwiera okno i zostaje w pamięci, a „Drukuj”
  z menu kontekstowego zależy od domyślnej przeglądarki PDF.
- SumatraPDF jest darmowy (GPLv3, osobny program — nie łączymy go z kodem agenta), mały, drukuje bez okna,
  przyjmuje nazwę drukarki, liczbę kopii i skalowanie z linii poleceń i kończy działanie po wysłaniu zadania.
- Pakiet npm `pdf-to-printer` (MIT) to tylko opakowanie na ten sam SumatraPDF z dołączoną, przypiętą wersją
  `.exe`. Bezpośrednie wywołanie daje to samo bez zależności, pozwala aktualizować SumatraPDF niezależnie
  od agenta i nie wnosi pliku `.exe` do repozytorium AGPL.
- Skalowanie: na A4 `fit` (dopasuj do strony), na termicznych `noscale` — etykieta 100×150 mm z PDF-u kuriera
  musi wyjść 1:1, inaczej kod kreskowy może być nieczytelny dla skanera.

**ZPL → surowo (RAW) do kolejki wydruku Windows** przez `skrypty\druk-raw.ps1`, który woła `OpenPrinter /
StartDocPrinter(„RAW”) / WritePrinter` z `winspool.drv` (standardowy sposób z dokumentacji Microsoftu).
Decyzja 2026-10-25:

- ZPL to język drukarki: sterownik nie może go „renderować”, tylko przekazać bajt w bajt. Druk przez
  sterownik (jak PDF) wydrukowałby tekst poleceń.
- Kolejka Windows zamiast gniazda TCP 9100 / portu USB: działa z każdą termiczną podłączoną jak zwykła
  drukarka (USB, sieć, udostępniona), Windows pilnuje kolejności zadań, a agent widzi stan i liczbę zadań.
- PowerShell + `Add-Type` jest w każdym Windows 10/11 — bez natywnych modułów Node (np. `printer`,
  nierozwijany, wymaga kompilacji) i bez dodatkowych programów. Parametry idą w zmiennych środowiskowych,
  więc nazwy drukarek ze spacjami, nawiasami i polskimi znakami nie psują się przy cytowaniu.
- Kopie idą w jednym zadaniu wydruku (dane powtórzone N razy), żeby etykiety z dwóch zleceń się nie przeplotły.

---

## 7. Dla programisty

```
cd agent-druku
npm ci
npm run typecheck      # tsc --noEmit (src + test)
npm test               # vitest: atrapa drukarek i serwera, nic się nie drukuje
npm run build          # dist/
npm run paczka         # build + wydanie/Kompletor-Druk-<wersja>-win-x64.zip (pobiera node.exe i SumatraPDF, sprawdza SHA-256)
npm run paczka -- --runtime <katalog>   # bez pobierania: node.exe i SumatraPDF.exe (i licencje) z katalogu
```

Paczka: `Zainstaluj.cmd` w korzeniu, `dist/`, `skrypty/`, `runtime/node.exe` + licencja Node, `sumatra/SumatraPDF.exe`
(wersja portable) + licencja GPLv3 i adres źródeł przypiętej wersji, `LICENCJE.txt`. Wersje i sumy:
`skrypty/wersje-paczki.json` (niezgodna suma = błąd; `[NIEPEWNE]` = sprawdzić lokalnie, opis w `docs/druk.md`).
Binariów nie ma w repozytorium.

Decyzja: **ZIP z gotowym runtime zamiast jednego pliku exe** (Node SEA). Pojedynczy exe i tak musiałby
rozpakować SumatraPDF i skrypty PowerShell, a niepodpisany samorozpakowujący się exe częściej zatrzymuje antywirus.

```
src/kontrakt.ts      typy kontraktu + parsujZlecenia (walidacja odpowiedzi serwera)
src/kolejka.ts       Agent: cykl zleceń, obsługa jednego zlecenia, raport stanu
src/rejestr.ts       rejestr wydrukowanych (idempotencja, sprzątanie po 7 dniach)
src/mapowanie.ts     rola → nazwa Windows, stan Windows → stan dla serwera, rola zapasowa
src/drukarki.ts      DrukarkiWindows: SumatraPDF, druk-raw.ps1, stan-drukarek.ps1
src/serwer.ts        KlientSerwera (fetch; token tylko do własnego hosta, pliki z dozwolonych hostów, bez przekierowań)
src/konfiguracja.ts  wczytanie i walidacja agent-druku.json
src/log.ts           log do pliku z rotacją
src/blokada.ts       jedna kopia programu
src/main.ts          start, pętle, sygnały; --sprawdz-konfig, --instaluj
src/instalacja.ts    logika instalatora: kod instalacyjny kmi_, przydział ról (A4, A4_2…, TERMICZNA_1…), scalanie konfiguracji
src/instalator.ts    rozmowa instalatora w konsoli (kod, lista drukarek z Windows, podsumowanie, zapis)
skrypty/             PowerShell (druk RAW, stan, instalacja, start) + paczka.mjs + wersje-paczki.json
test/                testy Vitest; test/atrapy.ts = atrapa drukarek i serwera
```

Główne repo pomija ten katalog w `tsc` i `vitest` (osobny pakiet). Pliki `.ps1` są zapisane w UTF-8 z BOM —
PowerShell 5.1 czyta pliki bez BOM jako ANSI i psuje polskie znaki. Pliki `.cmd`/`.ps1` mają końce linii CRLF
(`.gitattributes`).

---

## 8. Ograniczenia

- Testy automatyczne nie dotykają Windows: polecenia SumatraPDF i PowerShella są sprawdzane na atrapie
  uruchamiania procesów. Skrypty `.ps1` i `Zainstaluj.cmd` trzeba **sprawdzić raz na prawdziwym komputerze w magazynie**:
  - instalacja z ZIP-a: kod instalacyjny, lista drukarek, podsumowanie, „Gotowe: agent druku działa…”;
  - ponowne `Zainstaluj.cmd` = aktualizacja (konfiguracja i `dane\` bez zmian, jedno zadanie w Harmonogramie);
  - wydruk testowy z panelu na A4 i na każdej termicznej (ZPL z polskimi znakami `zażółć gęślą jaźń`);
  - karta testowego zamówienia i etykieta próbna („PRÓBA — NIE NADAWAĆ”) z panelu;
  - odłączenie termicznej → stan „offline” w nagłówku pakowania i zapas na drugiej termicznej albo A4.
- Odłączona drukarka USB nie zawsze od razu ma w Windows stan „offline” (zależy od sterownika). Wtedy agent
  wykryje problem dopiero, gdy w kolejce Windows zbierze się `maksKolejkaTermicznej` zadań.
- `OK` = zadanie przyjęte przez kolejkę Windows, nie fizyczny wydruk. Próba (10.11.2026): ZPL wysłany
  surowo na wirtualną drukarkę PDF dostał `OK`, a plik wyszedł pusty — ZPL sprawdza się tylko na prawdziwej termicznej.
- Windows 10/11 domyślnie „zarządza drukarką domyślną” i ustawia ją na ostatnio użytą — po pierwszej etykiecie
  domyślną może zostać termiczna (próba). Na komputerze w magazynie wyłącz w ustawieniach Windows: Bluetooth
  i urządzenia → Drukarki i skanery → „Pozwalaj systemowi Windows zarządzać moją drukarką domyślną”.
- Zadanie Harmonogramu ma ustawione „bez limitu czasu” (`ExecutionTimeLimit` = 0, w XML `PT0S`). Na miejscu
  sprawdź raz: **Harmonogram zadań → Biblioteka → „Kompletor - agent druku” → Właściwości → Ustawienia** —
  pole **„Zatrzymaj zadanie, jeśli działa dłużej niż”** ma być **odznaczone**. Jeśli jest zaznaczone (np. 3 dni),
  odznacz je; inaczej Windows zatrzyma agenta po tym czasie, jeśli komputer nie był wylogowany.
- Token stanowiska leży w pliku tekstowym na komputerze magazynowym — chroni go konto Windows tego komputera.
  Unieważnienie tokenu robi się po stronie serwera.
