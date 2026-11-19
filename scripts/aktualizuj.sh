#!/bin/sh
# Aktualizacja instalacji self-host: kopia bazy → pobranie kodu → budowa obrazu → restart z migracjami →
# sprawdzenie /api/health. Każdy krok musi się udać, zanim ruszy następny; błąd = stop z opisem, co dalej.
#
#   sh scripts/aktualizuj.sh               # pełna aktualizacja
#   sh scripts/aktualizuj.sh --bez-pobierania   # bez `git pull` (np. kod podmieniony ręcznie): kopia, budowa, restart
#   sh scripts/aktualizuj.sh --tylko-kopia      # sama kopia bazy, nic więcej
#
# Zmienne: KOMPLETOR_PORT (port panelu, domyślnie 3000), KOMPLETOR_PROJEKT (nazwa projektu compose, gdy inna niż
# domyślna), KOMPLETOR_KOPIE (katalog kopii, domyślnie ./kopie), KOMPLETOR_CZEKAJ_S (ile czekać na zdrowy panel,
# domyślnie 300).
#
# Kopia bazy: `pg_dump` w formacie custom z działającej bazy (system pracuje dalej), sprawdzona `pg_restore -l`.
# Skrypt niczego nie kasuje: stare kopie zostają w katalogu kopii, a przy błędzie baza nie jest cofana automatycznie
# (cofnięcie to świadoma decyzja, instrukcja na końcu wyjścia). Wolumen sekretów aktualizacja nie zmienia; jego kopię
# robisz raz, osobno (docs/instalacja.md, „Kopie zapasowe”).
set -eu
# pipefail tam, gdzie powłoka go zna (bash, nowsze dash, busybox); inaczej bez niego
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

# pełna ścieżka skryptu przed `cd` (`--help` czyta komentarz z tego pliku, także przy starcie z innego katalogu)
SKRYPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SKRYPT")/.."
export MSYS_NO_PATHCONV=1

PORT="${KOMPLETOR_PORT:-3000}"
DB_USER="${KOMPLETOR_DB_USER:-kompletor}"
DB_NAME="${KOMPLETOR_DB_NAME:-kompletor}"
KOPIE="${KOMPLETOR_KOPIE:-./kopie}"
CZEKAJ_S="${KOMPLETOR_CZEKAJ_S:-300}"
POBIERZ=1
TYLKO_KOPIA=0
for a in "$@"; do
  case "$a" in
    --bez-pobierania) POBIERZ=0 ;;
    --tylko-kopia) TYLKO_KOPIA=1 ;;
    -h|--help) sed -n '2,17p' "$SKRYPT"; exit 0 ;;
    *) echo "Nieznana opcja: $a (dozwolone: --bez-pobierania, --tylko-kopia)" >&2; exit 2 ;;
  esac
done

dc() {
  if [ -n "${KOMPLETOR_PROJEKT:-}" ]; then docker compose -p "$KOMPLETOR_PROJEKT" "$@"; else docker compose "$@"; fi
}
# to samo polecenie do wypisania w instrukcjach dla człowieka (z projektem i plikami compose, gdy ustawione)
DC_TXT="docker compose"
[ -z "${KOMPLETOR_PROJEKT:-}" ] || DC_TXT="docker compose -p \"$KOMPLETOR_PROJEKT\""
[ -z "${COMPOSE_FILE:-}" ] || DC_TXT="COMPOSE_FILE=\"$COMPOSE_FILE\" $DC_TXT"
krok() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$1"; }
stop() { printf '\nSTOP: %s\n' "$1" >&2; exit 1; }

zdrowie() {
  if command -v curl >/dev/null 2>&1; then curl -s --max-time 10 "http://127.0.0.1:${PORT}/api/health" || true
  else wget -qO- -T 10 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true; fi
}

# ── 0. Warunki wstępne ─────────────────────────────────────────────────────────
krok "Sprawdzam warunki"
command -v docker >/dev/null 2>&1 || stop "brak polecenia docker"
docker compose version >/dev/null 2>&1 || stop "brak docker compose (wersja 2)"
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || stop "brak curl i wget (potrzebne do sprawdzenia panelu)"
dc ps --status running --services 2>/dev/null | grep -qx db || stop "baza (usługa db) nie działa: uruchom system (docker compose up -d) i spróbuj ponownie"
STARY_COMMIT=""
if [ "$POBIERZ" = "1" ] && [ "$TYLKO_KOPIA" = "0" ]; then
  git rev-parse --git-dir >/dev/null 2>&1 || stop "to nie jest repozytorium git: pobierz nowy kod ręcznie i uruchom z --bez-pobierania"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || stop "masz lokalne zmiany w plikach repozytorium (git status). Zapisz je albo cofnij, potem uruchom ponownie"
fi
if git rev-parse --git-dir >/dev/null 2>&1; then STARY_COMMIT="$(git rev-parse HEAD)"; fi

# ── 1. Kopia bazy ──────────────────────────────────────────────────────────────
krok "Kopia bazy"
# kopia ma dane klientów: katalog tylko dla właściciela (700), pliki 600 (umask obejmuje też wersje-przed-aktualizacja.txt)
umask 077
mkdir -p "$KOPIE"
chmod 700 "$KOPIE"
ROZMIAR_B="$(dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" -X -A -t -c 'select pg_database_size(current_database())' | tr -d '\r\n ')"
WOLNE_KB="$(df -Pk "$KOPIE" | tail -1 | awk '{print $4}')"
case "$ROZMIAR_B" in ''|*[!0-9]*) stop "nie udało się odczytać rozmiaru bazy" ;; esac
# kopia custom jest zwykle kilka razy mniejsza od bazy; wymagamy wolnego miejsca co najmniej rozmiaru bazy
if [ "$WOLNE_KB" -le $((ROZMIAR_B / 1024)) ]; then
  STARE="$(find "$KOPIE" -maxdepth 1 -name '*.dump*' 2>/dev/null | wc -l | tr -d ' ')"
  stop "za mało miejsca na kopię w $KOPIE (baza ma $((ROZMIAR_B / 1048576)) MB, wolne $((WOLNE_KB / 1024)) MB). Miejsce zajmują m.in. stare kopie: $STARE plików, razem $(du -sh "$KOPIE" 2>/dev/null | cut -f1). Przenieś starsze pliki z $KOPIE w inne miejsce (skrypt ich nie kasuje) i uruchom ponownie"
fi
PLIK="$KOPIE/kompletor-$(date +%Y%m%d-%H%M%S).dump"
# zapis pod nazwą .niepelny, zmiana nazwy dopiero po sprawdzeniu: nieudana kopia nie leży jako .dump obok dobrych
dc exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$PLIK.niepelny" || stop "pg_dump nieudany, nic nie zmieniłem (niepełny plik: $PLIK.niepelny)"
[ -s "$PLIK.niepelny" ] || stop "kopia $PLIK.niepelny jest pusta, nic nie zmieniłem"
dc exec -T db pg_restore -l < "$PLIK.niepelny" >/dev/null 2>&1 || stop "kopia $PLIK.niepelny nie daje się odczytać (pg_restore -l), nic nie zmieniłem"
mv "$PLIK.niepelny" "$PLIK"
chmod 600 "$PLIK"
[ -n "$STARY_COMMIT" ] && printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$STARY_COMMIT" >> "$KOPIE/wersje-przed-aktualizacja.txt"
echo "kopia: $PLIK ($(du -h "$PLIK" | cut -f1)), sprawdzona"
if [ "$TYLKO_KOPIA" = "1" ]; then echo; echo "Gotowe (tylko kopia)."; exit 0; fi

# ── 2. Nowy kod ────────────────────────────────────────────────────────────────
if [ "$POBIERZ" = "1" ]; then
  krok "Pobieram nowy kod (git pull --ff-only)"
  git pull --ff-only || stop "git pull nieudany (gałąź rozjechana z serwerem?). System działa dalej na starej wersji"
  NOWY_COMMIT="$(git rev-parse HEAD)"
  if [ "$NOWY_COMMIT" = "$STARY_COMMIT" ]; then
    echo "Brak nowej wersji (commit $(git rev-parse --short HEAD)). Kopia zrobiona, system bez zmian."
    exit 0
  fi
  echo "zmiana: $(git rev-parse --short "$STARY_COMMIT") → $(git rev-parse --short HEAD)"
fi

# ── 3. Budowa obrazu (stary system pracuje w tym czasie) ───────────────────────
krok "Buduję obraz (kilka minut; stara wersja dalej działa)"
dc build web || stop "budowa obrazu nieudana. System działa dalej na starej wersji. Kod cofniesz (na tej samej gałęzi): git reset --hard ${STARY_COMMIT:-<commit z $KOPIE/wersje-przed-aktualizacja.txt>}"

# ── 4. Restart: migracje bazy robi start kontenera ─────────────────────────────
krok "Restart z nową wersją (migracje bazy przy starcie)"
UP_KOD=0
dc up -d || UP_KOD=$?
[ "$UP_KOD" = "0" ] || echo "UWAGA: docker compose up -d zakończył się kodem $UP_KOD (sprawdzam mimo to, czy panel wstaje)" >&2

# ── 5. Sprawdzenie ─────────────────────────────────────────────────────────────
krok "Czekam na zdrowy panel (do ${CZEKAJ_S} s)"
KONIEC=$(( $(date +%s) + CZEKAJ_S ))
ODP=""
BEZ_STANU_MIGRACJI=0
while [ "$(date +%s)" -lt "$KONIEC" ]; do
  ODP="$(zdrowie)"
  # panel zdrowy i bez zaległych migracji, a worker (kolejka) ma zdrowy healthcheck (plik życia, docker/healthcheck.sh)
  if printf '%s' "$ODP" | grep -Eq '"status":"(ok|degraded)"' && printf '%s' "$ODP" | grep -q '"pending":0' \
    && dc ps worker --format '{{.Status}}' 2>/dev/null | grep -q '(healthy)'; then
    echo "panel działa: $(printf '%s' "$ODP" | grep -o '"status":"[a-z]*"'), $(printf '%s' "$ODP" | grep -o '"last":"[^"]*"'); worker zdrowy"
    [ "$UP_KOD" = "0" ] || echo "UWAGA: system działa, ale docker compose up -d zwrócił kod $UP_KOD: sprawdź $DC_TXT ps --all"
    dc ps --format '{{.Service}}: {{.Status}}'
    echo
    echo "Aktualizacja zakończona. Kopia sprzed aktualizacji: $PLIK"
    exit 0
  fi
  if [ "$BEZ_STANU_MIGRACJI" = "0" ] && printf '%s' "$ODP" | grep -q '"pending":null'; then
    BEZ_STANU_MIGRACJI=1
    echo "UWAGA: panel odpowiada, ale nie zgłasza stanu migracji (\"pending\":null: obraz bez katalogu migracji?). Skrypt nie potwierdzi aktualizacji bazy i skończy limitem czasu; sprawdź log: $DC_TXT logs --tail 80 web" >&2
  fi
  sleep 5
done

dc ps --all --format '{{.Service}}: {{.Status}}' || true
UWAGI=""
[ "$UP_KOD" = "0" ] || UWAGI="docker compose up -d zakończył się kodem $UP_KOD. "
[ "$BEZ_STANU_MIGRACJI" = "0" ] || UWAGI="${UWAGI}Panel nie zgłaszał stanu migracji (\"pending\":null), więc skrypt nie mógł potwierdzić aktualizacji bazy."
cat >&2 <<EOF

STOP: panel albo worker (kolejka) nie wstał w ${CZEKAJ_S} s. Ostatnia odpowiedź /api/health: ${ODP:-brak}
${UWAGI}

Co teraz:
  1. Przyczyna: $DC_TXT logs --tail 80 web   (albo: sh scripts/diagnostyka.sh)
  2. Nieudana migracja bazy (w logu web błąd Prismy z nazwą migracji): Prisma zapisuje ją jako nieudaną, każdy
     kolejny start odmawia (P3009), a web restartuje się w pętli. Najpierw zatrzymaj: $DC_TXT stop web worker
     Potem albo wróć do poprzedniej wersji (punkt 3; kopia sprzed aktualizacji usuwa też ślad nieudanej migracji),
     albo, gdy migracja nic w bazie nie zmieniła, a czekasz na poprawioną wersję, oznacz ją jako wycofaną:
     $DC_TXT run --rm --no-deps --entrypoint sh web -c 'KOMPLETOR_ENTRYPOINT_TYLKO_FUNKCJE=1 . /usr/local/bin/entrypoint.sh && zbuduj_adresy && cd /opt/migrate && node node_modules/prisma/build/index.js migrate resolve --rolled-back "\$1"' - <nazwa_migracji>
     (nazwa: $DC_TXT exec -T db psql -U "$DB_USER" -d "$DB_NAME" -c 'select migration_name from _prisma_migrations where finished_at is null and rolled_back_at is null')
  3. Powrót do poprzedniej wersji: kod i baza z kopii zrobionej przed aktualizacją (NADPISUJE bazę, zmiany od
     początku aktualizacji przepadają):
     $DC_TXT stop web worker
     $DC_TXT exec -T db pg_restore -U "$DB_USER" -d postgres --clean --if-exists --create < "$PLIK"
     git reset --hard ${STARY_COMMIT:-<commit z $KOPIE/wersje-przed-aktualizacja.txt>}
     $DC_TXT up -d --build
     Baza powstaje od nowa z kopii, więc tabele dodane przez nową wersję znikają. Gałąź zostaje ta sama, a następne
     uruchomienie tego skryptu znów pobierze nową wersję.
EOF
exit 1
