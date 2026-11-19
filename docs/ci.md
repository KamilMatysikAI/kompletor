# CI: automatyczne testy na GitHub Actions

Dokument dla developerów (nie trafia do Pomocy w panelu). Pliki: `.github/workflows/ci.yml`,
`.github/workflows/symulacja.yml`, `scripts/ci/srodowisko.sh`, `scripts/ci/baza.sh`.

## Co sprawdza CI

| Job | Kroki | Czas (pomiar 08.11.2026, runner 2-core) |
|---|---|---|
| **Typy i testy jednostkowe** (`szybki`) | `npm ci` (z `prisma generate`), `npm run typecheck` (bez pamięci podręcznej), `npm run test:unit` (149 plików, 2 170 testów) | 2 min 32 s |
| **Migracje, testy integracyjne, build** (`pelny`) | Postgres 16, `npm run db:check`, `prisma migrate deploy`, `npm run test:integration` bez symulacji grudnia, `npm run build` | 12 min 11 s (testy integracyjne 100 plików, 1 386 testów: 10 min 45 s; build 48 s) |
| **Symulacja grudnia** (osobny workflow) | `tests/rdzen-symulacja.integration.test.ts` (48, 48q, 49, 50) | lokalnie 75–90 min |

Dla porównania: lokalnie, przy kilku stosach testowych naraz, integracja bez symulacji trwa ok. 15 min. Przy zmianie zestawu testów sprawdź czasy w zakładce Actions.

## Kiedy co się uruchamia

| Zdarzenie | `szybki` | `pelny` |
|---|---|---|
| push do `main` | tak | nie (sprawdza go przebieg nocny) |
| pull request do `main` | tak | tak |
| push gałęzi `ci/<nazwa>` | tak | tak |
| noc, 02:30 UTC | nie | tak, ale tylko gdy `main` zmienił się w ostatniej dobie |
| ręcznie (Actions → CI → Run workflow) | tak | tak (pole „pelny”) |
| push innej gałęzi | nie | nie |

Harmonogram nocny i przycisk „Run workflow” działają dopiero, gdy workflow jest na `main` (zasada GitHuba).
Nowszy przebieg tego samego rodzaju na tej samej gałęzi anuluje starszy (`concurrency`, grupa = zdarzenie + gałąź),
więc seria pushy zużywa minuty jednego przebiegu, a push do `main` w nocy nie anuluje przebiegu nocnego.

GitHub wyłącza harmonogram (`schedule`) po 60 dniach bez aktywności w repo. Gdy nocny przebieg „zniknie”, włącz
workflow ponownie w Actions → CI → Enable workflow.

**Symulacja grudnia** tylko ręcznie: Actions → „Symulacja grudnia” → Run workflow albo
`gh workflow run symulacja.yml --ref <gałąź>` (przycisk pojawia się, gdy plik jest już na `main`). Raport JSON
symulacji jest na końcu logu jobu.

Rytm symulacji: integrator uruchamia ją ręcznie po scaleniu każdej fali i przed każdym tagiem wydania, a wynik
(zielony/czerwony, link) wpisuje do raportu fali. Po upublicznieniu repo: harmonogram tygodniowy (np. niedziela
02:30 UTC), nie nocny, bo 30 przebiegów po ok. 100 min to ok. 50 godzin runnera miesięcznie.

### Jak integrator fali sprawdza sumę gałęzi

```
git push origin <gałąź-integracyjna>:refs/heads/ci/<nazwa-fali>
gh run list --branch ci/<nazwa-fali> --limit 3
gh run view <id> --json conclusion,jobs --jq '{conclusion, jobs: [.jobs[] | {name, conclusion, startedAt, completedAt}]}'
```

Status (zielony/czerwony, link do przebiegu) wpisuje do raportu fali. Po scaleniu gałąź `ci/<nazwa-fali>` można
usunąć z GitHuba.

Z gałęzi `ci/<nazwa-fali>` nie otwieramy pull requesta do `main`: gałąź służy tylko do pomiaru, a PR z niej
uruchomiłby drugi komplet jobów (push i PR są w osobnych grupach, więc nic się nie anuluje, ok. 17 min podwójnie).

## Środowisko w jobie, bez sekretów

- Żadnych sekretów z ustawień repo ani z plików. `scripts/ci/srodowisko.sh` losuje przy każdym przebiegu
  `APP_ENCRYPTION_KEY`, `CUSTOMER_DATA_KEYS`, `CUSTOMER_LOOKUP_KEY` (`openssl rand -hex 32`) i maskuje je w logu.
  Klucze integracji (BaseLinker, wFirma, kanały, kurierzy) zostają puste: testy pracują na atrapach z `tests/`.
- `scripts/ci/baza.sh` stawia Postgres 16 (`postgres:16-alpine` przypięty do skrótu obrazu) z losowym hasłem
  właściciela i roli `logistyka_app`, z `docker/init-db.sql` (bazy `logistyka_test` i `logistyka_shadow`), bez
  synchronizacji z dyskiem (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`). To jednorazowa baza
  runnera, nigdy staging ani produkcja. Rolę `logistyka_app` zakłada migracja, a jej hasło ustawia
  `tests/global-setup.ts` (`ensureAppRoleLogin`) z `APP_DATABASE_URL`, tak jak lokalnie.
- Kontener zamiast `services:`, bo usługa GitHuba nie przyjmuje argumentów startu Postgresa ani pliku z repo.
- `permissions: contents: read`, checkout bez zapisanego tokenu (`persist-credentials: false`), akcje przypięte do
  pełnego SHA commita (komentarz z wersją obok). Aktualizacja akcji: nowy SHA z
  `gh api repos/actions/checkout/git/ref/tags/<wersja>`.
- Node 22, jak w obrazie Dockera (`Dockerfile`, `NODE_IMAGE`).

## Koszt minut (repo prywatne)

Konto GitHub Free daje prywatnym repo 12 USD miesięcznie na Actions, czyli ok. 2 000 minut runnera Linux
2-core (0,006 USD za minutę, każda zaczęta minuta jobu liczy się w górę, osobno dla każdego jobu). Bez metody płatności przebiegi ponad limit
po prostu nie ruszą do końca miesiąca; płatnego planu nie włączamy bez decyzji właściciela.

Szacunek na ruch z tygodnia 02–08.11.2026 (ok. 150 pushy do `main` miesięcznie):

| Pozycja | Minuty miesięcznie |
|---|---|
| `szybki` przy pushach do `main` (ok. 150 × 3 min liczone, mniej przy anulowaniu serii) | do ok. 450 |
| `pelny` nocą (dni ze zmianami, do 30 × 14 min liczone; 13 min 04 s zaokrąglone w górę) | do ok. 420 |
| `zmiany` (strażnik nocy, 30 × 1 min) | ok. 30 |
| `ci/<fala>` od integratora (ok. 8 × (3 + 14) min) | ok. 140 |
| symulacja ręcznie (każdy przebieg ok. 90–120 min) | 0 bez uruchomień, ok. 100 za przebieg |
| **razem** | **ok. 1 030 z 2 000** |

Po pierwszym miesiącu sprawdź faktyczne zużycie w Settings → Billing and plans i wpisz je tutaj.

Pełny poziom na każdy push wszystkich gałęzi (ok. 900 pushy miesięcznie) to ok. 14 000 minut, a sam `pelny` na każdy push do `main` dokłada ok. 1 950 minut (razem ponad limit), dlatego tego nie ma.
Po upublicznieniu repo minuty na standardowych runnerach są darmowe: wtedy `pelny` można dopisać do
pushy do `main` i tygodniową symulację do harmonogramu.

## Ochrona `main` (wymagany zielony CI)

Stan na 08.11.2026: **wyłączona i na tym koncie niedostępna**. API GitHuba dla prywatnego repo na koncie Free
odpowiada „Upgrade to GitHub Pro or make this repository public to enable this feature” (ochrona gałęzi i zestawy
reguł wymagają GitHub Pro dla repo prywatnych). Dwie drogi:

1. Po upublicznieniu repo reguła jest darmowa. Wtedy w nowym repo: Settings → Rules → Rulesets →
   New branch ruleset dla `main` z „Require status checks to pass” (checki `Typy i testy jednostkowe` oraz
   `Migracje, testy integracyjne, build`), „Block force pushes” i „Require a pull request before merging”. To samo
   jedną komendą (właściciel repo, w nowym publicznym repo):

   ```
   gh api -X PUT repos/<właściciel>/<repo>/branches/main/protection --input scripts/ci/ochrona-main.json
   ```

2. Przed upublicznieniem: GitHub Pro (płatny, decyzja właściciela), potem ta sama komenda w obecnym repo.

Uwaga: wymagany check `pelny` przy pushu do `main` się nie uruchamia, więc przy ochronie gałęzi zmiany wchodzą
przez pull request (PR uruchamia oba joby). Bez tego scalanie lokalne i `git push` do `main` zostałyby zablokowane.

`enforce_admins: false` w `scripts/ci/ochrona-main.json` to świadomy wybór: przy jednym właścicielu repo zostaje
mu droga awaryjna (push do `main` z pominięciem checków, np. pilna poprawka przy niedziałającym GitHub Actions).
`required_approving_review_count: 0`, bo w repo jednoosobowym nie ma drugiego recenzenta na GitHubie.

Koszt po włączeniu ochrony (wariant do decyzji: GitHub Pro albo upublicznienie):

| Tryb pracy | Minuty miesięcznie |
|---|---|
| PR na każde scalenie (ok. 150 PR × (3 + 14) min) + `szybki` po scaleniu (150 × 3) + noc (450) | ok. 3 450, ponad limit Free (2 000) i Pro (18 USD, ok. 3 000) |
| jeden PR na falę (ok. 8 × 17 min) + `szybki` po scaleniu + noc | ok. 1 040 |
| repo publiczne | 0 zł, minuty na standardowych runnerach bez limitu |

W repo prywatnym z ochroną `main` praktyczny jest więc tylko tryb „jeden PR na falę”.

## Po upublicznieniu: pull requesty z forków

- PR z forka uruchamia `szybki` i `pelny` na kodzie z forka, z `GITHUB_TOKEN` tylko do odczytu i bez sekretów
  (workflow żadnych nie ma). Najgorszy skutek to zepsuty własny przebieg.
- **Nigdy** nie zmieniamy wyzwalacza na `pull_request_target` i nie dodajemy sekretów do workflow uruchamianego przez
  PR: kod z forka dostałby wtedy zapis do repo albo sekret.
- Settings → Actions → General: „Require approval for all external contributors” (przebieg z forka rusza dopiero po
  kliknięciu właściciela) oraz „Workflow permissions: Read repository contents and packages permissions” jako drugi
  bezpiecznik, niezależny od `permissions:` w pliku.
- `workflow_dispatch` i `schedule` uruchamiają tylko osoby z prawem zapisu (bez zmian).
- Minuty na standardowych runnerach w repo publicznym są darmowe.
