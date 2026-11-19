#!/bin/sh
# Start kontenera Kompletora. Jeden obraz, dwie role: KOMPLETOR_ROLA=web (panel + /api/health, domyślnie)
# albo worker (kolejka zadań). Obie role najpierw robią `prisma migrate deploy` (idempotentne, Prisma trzyma blokadę
# doradczą, więc dwa kontenery naraz nie zderzą się; zajęta blokada = do 3 prób, niżej). Migracja padła = kontener NIE startuje na niezgodnym schemacie:
# Coolify zostawia poprzednią wersję, a błąd jest w logach kontenera.
#
# (`docker compose up` z compose.yaml): z KOMPLETOR_SEKRETY_DIR adresy bazy i klucz szyfrowania są budowane
# z plików wolumenu sekretów, ale tylko gdy nie ma ich już w env (Coolify i inne instalacje z własnymi zmiennymi
# działają bez zmian). Wartości nie trafiają do logu.
set -eu

# Wartość pliku sekretu (bez końca linii); brak pliku = błąd startu.
sekret_z_pliku() {
  if [ ! -r "$1/$2" ]; then
    echo "[entrypoint] BŁĄD: brak pliku sekretu $1/$2 (usługa sekrety z compose.yaml)" >&2
    return 1
  fi
  tr -d '\r\n' < "$1/$2"
}

# DATABASE_URL, APP_DATABASE_URL, APP_ENCRYPTION_KEY z KOMPLETOR_SEKRETY_DIR — każda tylko, gdy pusta w env.
# Host, port, właściciel i nazwa bazy: KOMPLETOR_DB_HOST (db), KOMPLETOR_DB_PORT (5432), KOMPLETOR_DB_USER i
# KOMPLETOR_DB_NAME (kompletor). Sekrety są hex, więc adres nie wymaga kodowania znaków.
zbuduj_adresy() {
  [ -n "${KOMPLETOR_SEKRETY_DIR:-}" ] || return 0
  _dir="$KOMPLETOR_SEKRETY_DIR"
  _host="${KOMPLETOR_DB_HOST:-db}"
  _port="${KOMPLETOR_DB_PORT:-5432}"
  _baza="${KOMPLETOR_DB_NAME:-kompletor}"
  if [ -z "${DATABASE_URL:-}" ]; then
    _pg="$(sekret_z_pliku "$_dir" postgres_password)" || return 1
    DATABASE_URL="postgresql://${KOMPLETOR_DB_USER:-kompletor}:${_pg}@${_host}:${_port}/${_baza}"
    export DATABASE_URL
  fi
  if [ -z "${APP_DATABASE_URL:-}" ]; then
    _app="$(sekret_z_pliku "$_dir" app_db_password)" || return 1
    APP_DATABASE_URL="postgresql://logistyka_app:${_app}@${_host}:${_port}/${_baza}"
    export APP_DATABASE_URL
  fi
  if [ -z "${APP_ENCRYPTION_KEY:-}" ] && [ -z "${APP_ENCRYPTION_KEYS:-}" ]; then
    APP_ENCRYPTION_KEY="$(sekret_z_pliku "$_dir" app_encryption_key)" || return 1
    export APP_ENCRYPTION_KEY
  fi
  unset _dir _host _port _baza _pg _app
}

# Nazwa presetu z KOMPLETOR_SEED: [a-z0-9-], 1–40 znaków (plik seed/presety/<nazwa>.json albo wbudowane demo).
nazwa_seeda_ok() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9-]{1,40}$'
}

# CLI Prismy z /opt/migrate (osobna funkcja, żeby testy mogły ją podmienić).
prisma_cli() {
  node node_modules/prisma/build/index.js "$@"
}

# Kontrola migracji bazowej przed `migrate deploy`; $1 = katalog migracji obrazu, $2 = plik SQL kontroli.
# Dwa osobne warunki:
#  1. obraz ma migrację bazową ($1/00000000000000_baza). Bez niej (repo z pełną historią migracji) kontrola nic
#     nie robi, więc w takim repo jest nieszkodliwa;
#  2. baza ma wiersze starszych migracji, a migracji bazowej nie ma jako wykonanej (docker/kontrola-migracji-bazowej.sql).
# Pusta baza przechodzi. Spełnione oba = start zatrzymany z poleceniem naprawy, zanim Prisma cokolwiek zapisze (kod 1).
# Inny błąd samej kontroli (np. baza jeszcze nie odpowiada) nie zatrzymuje startu tutaj: rozstrzyga go `migrate deploy`.
kontrola_migracji_bazowej() {
  [ -d "$1/00000000000000_baza" ] || return 0
  _log="${TMPDIR:-/tmp}/kompletor-kontrola-bazowej.log"
  if prisma_cli db execute --stdin <"$2" >"$_log" 2>&1; then
    return 0
  fi
  if grep -q 'KOMPLETOR_BRAK_MIGRACJI_BAZOWEJ' "$_log"; then
    echo "[entrypoint] BŁĄD: baza ma schemat ze starszej historii migracji, a migracja bazowa 00000000000000_baza nie jest oznaczona jako wykonana." >&2
    echo "[entrypoint] Nic nie zmieniono. Jednorazowo na tej bazie (najpierw kopia zapasowa): docker compose run --rm --entrypoint kompletor web migracja-bazowa-wykonana (oznacza migrate resolve --applied 00000000000000_baza), potem restart kontenera (docs/instalacja.md, „Start zatrzymany: brak migracji bazowej”)." >&2
    return 1
  fi
  echo "[entrypoint] kontrola migracji bazowej nieudana (szczegóły niżej), decyduje migrate deploy" >&2
  cat "$_log" >&2
  return 0
}

# Sam plik z funkcjami, bez startu: polecenie `kompletor` (docker/kompletor-cli.sh) i testy (lib/instalacja/sekrety.test.ts).
if [ "${KOMPLETOR_ENTRYPOINT_TYLKO_FUNKCJE:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

ROLA="${KOMPLETOR_ROLA:-web}"
echo "[entrypoint] Kompletor ${APP_VERSION:-?} (${BUILD_SHA:-?}), rola=${ROLA}, APP_MODE=${APP_MODE:-self-host}"

case "$ROLA" in
  web|worker) ;;
  *) echo "[entrypoint] BŁĄD: KOMPLETOR_ROLA musi być web albo worker (jest: ${ROLA})" >&2; exit 1 ;;
esac

# APP_MODE jak appModeOf w lib/db.ts: brak = self-host, wartość po obcięciu spacji musi
# być self-host albo hosted — inaczej kontener nie startuje (zamiast cichego trybu self-host przy „Hosted”).
if [ -n "${APP_MODE+x}" ]; then
  TRYB="$(printf '%s' "$APP_MODE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
else
  TRYB=self-host
fi
case "$TRYB" in
  self-host|hosted) ;;
  *) echo "[entrypoint] BŁĄD: APP_MODE musi być self-host albo hosted (jest: ${APP_MODE:-})" >&2; exit 1 ;;
esac

zbuduj_adresy

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] BŁĄD: brak DATABASE_URL" >&2
  exit 1
fi
# klient firmy loguje się własną rolą LOGIN (APP_DATABASE_URL). Hosting bez niej nie startuje; self-host
# może zostać przy starym trybie (właściciel bazy z -c role=), z ostrzeżeniem.
if [ -z "${APP_DATABASE_URL:-}" ]; then
  if [ "$TRYB" = "hosted" ]; then
    echo "[entrypoint] BŁĄD: APP_MODE=hosted wymaga APP_DATABASE_URL (rola LOGIN logistyka_app z hasłem)" >&2
    exit 1
  fi
  echo "[entrypoint] UWAGA: brak APP_DATABASE_URL — klient firmy łączy się jako właściciel bazy z rolą aplikacji (README „Rola aplikacji”)" >&2
fi

echo "[entrypoint] prisma migrate deploy"
cd /opt/migrate
kontrola_migracji_bazowej prisma/migrations kontrola-migracji-bazowej.sql || exit 1
# blokada doradcza Prismy czeka stałe 10 s, więc gdy drugi kontener migruje dłużej, ten kończy się
# błędem limitu blokady. Tylko ten błąd ponawiamy (3 próby, co 10 s); każdy inny kończy start od razu, jak wcześniej.
# Wyjście CLI idzie przez plik, żeby po błędzie sprawdzić jego treść (log kontenera dostaje je w całości).
MIGRATE_LOG="${TMPDIR:-/tmp}/kompletor-migrate.log"
PROBA=1
while :; do
  if node node_modules/prisma/build/index.js migrate deploy >"$MIGRATE_LOG" 2>&1; then
    cat "$MIGRATE_LOG"
    break
  fi
  cat "$MIGRATE_LOG" >&2
  if [ "$PROBA" -lt 3 ] && grep -q 'Timed out trying to acquire a postgres advisory lock' "$MIGRATE_LOG"; then
    echo "[entrypoint] blokada migracji zajęta (migruje inny kontener), próba ${PROBA}/3 — ponawiam za 10 s" >&2
    PROBA=$((PROBA + 1))
    sleep 10
    continue
  fi
  echo "[entrypoint] BŁĄD: prisma migrate deploy nieudane (próba ${PROBA}/3), kontener nie startuje" >&2
  exit 1
done

cd /app
# Rola aplikacji po migracji (rola powstaje w migracji). Jeden pisarz hasła: web ustawia
# LOGIN i hasło z APP_DATABASE_URL (idempotentnie), worker tylko sprawdza logowanie (czeka do 90 s na web) — inna
# wartość APP_DATABASE_URL w workerze = worker nie startuje, zamiast przestawiać hasło przy każdym restarcie.
# Błąd = kontener nie startuje (klient firmy i tak by się nie połączył).
if [ -n "${APP_DATABASE_URL:-}" ]; then
  if [ "$ROLA" = "web" ]; then
    echo "[entrypoint] rola aplikacji (APP_DATABASE_URL): ustawienie"
    node dist/org.cjs rola-aplikacji
  else
    echo "[entrypoint] rola aplikacji (APP_DATABASE_URL): sprawdzenie"
    node dist/org.cjs rola-aplikacji --sprawdz
  fi
fi

# Konfiguracja firmy z presetu (bez sekretów), idempotentnie: niczego nie nadpisuje — brakujące wiersze i puste klucze
# ustawień kont kanałów. KOMPLETOR_SEED=<nazwa> = seed/presety/<nazwa>.json albo zamontowany
# /app/prywatne/presety/<nazwa>.json (albo KOMPLETOR_PRESET_PLIK),
# `demo` = wbudowana firma z danymi fikcyjnymi. Tylko rola web, żeby nie robić tego dwa razy. Błąd seeda
# nie zatrzymuje panelu (worker bez firmy po prostu czeka), ale trafia do logu.
if [ "$ROLA" = "web" ] && [ -n "${KOMPLETOR_SEED:-}" ]; then
  if nazwa_seeda_ok "$KOMPLETOR_SEED"; then
    node dist/org.cjs seed "$KOMPLETOR_SEED" || echo "[entrypoint] BŁĄD: seed ${KOMPLETOR_SEED} nieudany (szczegóły wyżej), start bez niego" >&2
  else
    echo "[entrypoint] BŁĄD: zła nazwa KOMPLETOR_SEED (dozwolone małe litery, cyfry, myślnik, do 40 znaków), pomijam" >&2
  fi
fi

# świeża instalacja self-host bez kont = blok z adresem kreatora /start i kodem instalacji (kolejne starty:
# cisza). Błąd tego kroku nie zatrzymuje panelu.
if [ "$ROLA" = "web" ] && [ "$TRYB" = "self-host" ]; then
  node dist/org.cjs adres-startu || echo "[entrypoint] UWAGA: nie udało się sprawdzić kont (adres /start), start bez niego" >&2
fi

# zdjęcia produktów zapisane przed przeniesieniem do bazy leżą w katalogu ZDJECIA_DIR tego kontenera (web
# i worker mogą mieć osobne wolumeny). Przeniesienie do bazy, idempotentnie, pliki zostają; do 60 s, żeby nie opóźniać
# startu (worker kończy resztę w tle, panel przy pierwszym odczycie zdjęcia). Błąd nie zatrzymuje startu.
node dist/org.cjs zdjecia-do-bazy --limit-s 60 || echo "[entrypoint] UWAGA: przeniesienie zdjęć z dysku do bazy niepełne (szczegóły wyżej), start mimo to" >&2

if [ "$ROLA" = "worker" ]; then
  exec node dist/worker.cjs
fi
exec node server.js
