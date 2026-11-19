#!/bin/sh
# Diagnostyka instalacji self-host: jeden raport do wklejenia w zgłoszeniu albo do własnego sprawdzenia.
#
#   sh scripts/diagnostyka.sh                 # raport na ekran
#   sh scripts/diagnostyka.sh > diagnostyka.txt
#
# Uruchamiaj w katalogu z compose.yaml (albo z dowolnego miejsca, skrypt sam przechodzi do katalogu repozytorium).
# Zmienne: KOMPLETOR_PORT (port panelu, domyślnie 3000), KOMPLETOR_PROJEKT (nazwa projektu compose, gdy inna niż
# domyślna), KOMPLETOR_LOGI_OD (od kiedy błędy z logów, domyślnie 24h).
#
# Bez sekretów: nie czyta wolumenu sekretów ani zmiennych środowiska kontenerów (żadnego `env`, `docker inspect`,
# `docker compose config`). Treść błędów idzie przez filtr, który zakrywa adresy e-mail, adresy baz z hasłem,
# tokeny, długie ciągi znaków i numery telefonów. Skrypt niczego nie zmienia: tylko odczyt.
set -u

cd "$(dirname "$0")/.." || exit 1

PORT="${KOMPLETOR_PORT:-3000}"
OD="${KOMPLETOR_LOGI_OD:-24h}"
# MSYS_NO_PATHCONV: Git Bash na Windows nie przerabia ścieżek w poleceniach dla kontenera.
export MSYS_NO_PATHCONV=1

dc() {
  if [ -n "${KOMPLETOR_PROJEKT:-}" ]; then docker compose -p "$KOMPLETOR_PROJEKT" "$@"; else docker compose "$@"; fi
}

# Zakrywa dane, które nie powinny trafić do zgłoszenia (kolejność ma znaczenie: najpierw adresy z hasłem, potem
# schemat po `Authorization:` (Bearer/Basic), potem słowa-klucze w zapisach `klucz=…`, `klucz: …`, JSON `"klucz":"…"`,
# małymi, wielkimi i z wielkiej litery). Pola zdrowia `"secretsKey"`/`"adapterKey"` z krótką wartością (ok, error,
# woo.v1) zostają: to stan, nie sekret (znacznik ~~ na czas filtra). Wartość w cudzysłowie ("…" albo '…') po
# słowie-kluczu zakrywana w całości, także ze spacjami.
zakryj() {
  sed -E \
    -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^ /"@]*@#\1<dane-logowania>@#g' \
    -e 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<e-mail>#g' \
    -e 's#"(secretsKey|adapterKey)":"([a-z0-9.]{1,20})"#"\1"~~:"\2"#g' \
    -e 's#([Bb]earer|BEARER|[Bb]asic|BASIC)( +)[^ ,;"}]+#\1\2<ukryte>#g' \
    -e 's#([Aa]uthorization|AUTHORIZATION|[Tt]oken|TOKEN|[Kk]ey|KEY|[Kk]lucz|KLUCZ|[Hh]asło|HASŁO|[Hh]aslo|HASLO|[Pp]assword|PASSWORD|[Pp]asswd|PASSWD|[Pp]wd|PWD|[Ss]ecret|SECRET|[Ss]ekret|SEKRET)("?[=: ]+)"[^"]*"#\1\2"<ukryte>"#g' \
    -e 's#([Aa]uthorization|AUTHORIZATION|[Tt]oken|TOKEN|[Kk]ey|KEY|[Kk]lucz|KLUCZ|[Hh]asło|HASŁO|[Hh]aslo|HASLO|[Pp]assword|PASSWORD|[Pp]asswd|PASSWD|[Pp]wd|PWD|[Ss]ecret|SECRET|[Ss]ekret|SEKRET)("?[=: ]+)'"'"'[^'"'"']*'"'"'#\1\2'"'"'<ukryte>'"'"'#g' \
    -e 's#([Aa]uthorization|AUTHORIZATION|[Tt]oken|TOKEN|[Kk]ey|KEY|[Kk]lucz|KLUCZ|[Hh]asło|HASŁO|[Hh]aslo|HASLO|[Pp]assword|PASSWORD|[Pp]asswd|PASSWD|[Pp]wd|PWD|[Ss]ecret|SECRET|[Ss]ekret|SEKRET)("?[=: ]+"?)[^ ,;"}]+#\1\2<ukryte>#g' \
    -e 's#"~~:"#":"#g' \
    -e 's#kmp_[A-Za-z0-9_-]+#<klucz-api>#g' \
    -e 's#[A-Za-z0-9+/=-]{32,}#<długi-ciąg>#g' \
    -e 's#(^|[^0-9_])(\+?48[ -]?)?[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{3}([^0-9_]|$)#\1<telefon>\3#g'
}

naglowek() { printf '\n== %s ==\n' "$1"; }

# SQL w kontenerze bazy przez gniazdo lokalne (bez hasła, bez publikowania portu). Pusta odpowiedź = brak bazy.
sql() {
  dc exec -T db psql -U "${KOMPLETOR_DB_USER:-kompletor}" -d "${KOMPLETOR_DB_NAME:-kompletor}" -X -A -t -F ' | ' -c "$1" 2>/dev/null
}

echo "Diagnostyka Kompletora, $(date '+%Y-%m-%d %H:%M:%S %z')"
echo "PRZED WYSŁANIEM przejrzyj cały raport: filtr zakrywa typowe hasła, tokeny, e-maile i telefony, ale nie wszystko"
echo "(nie zna nazw Twoich klientów ani nietypowych zapisów). Raport może trafić do publicznego zgłoszenia."

naglowek "Wersja kodu"
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  echo "commit: $(git rev-parse --short HEAD 2>/dev/null) ($(git log -1 --format=%cd --date=short 2>/dev/null)), gałąź: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  zmiany=$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')
  [ "$zmiany" = "0" ] || echo "UWAGA: $zmiany zmienionych plików względem commita (lokalne poprawki?)"
else
  echo "brak repozytorium git w tym katalogu"
fi
docker compose version 2>/dev/null | head -1

naglowek "Stan panelu (/api/health)"
if command -v curl >/dev/null 2>&1; then
  zdrowie=$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/api/health" || true)
elif command -v wget >/dev/null 2>&1; then
  zdrowie=$(wget -qO- -T 10 "http://127.0.0.1:${PORT}/api/health" || true)
else
  zdrowie=""
  echo "brak curl i wget: pomijam"
fi
if [ -n "$zdrowie" ]; then
  # Odpowiedź bez hasła nie zawiera sekretów ani danych firm (app/api/health/route.ts); i tak przez filtr.
  printf '%s\n' "$zdrowie" | zakryj
else
  echo "panel nie odpowiada na http://127.0.0.1:${PORT}/api/health (inny port? ustaw KOMPLETOR_PORT)"
fi

naglowek "Kontenery"
dc ps --all --format '{{.Service}}: {{.Status}}' 2>/dev/null || echo "docker compose ps nie działa (Docker uruchomiony? właściwy katalog?)"

naglowek "Pamięć i procesor (chwila obecna)"
ids=$(dc ps -q 2>/dev/null)
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  docker stats --no-stream --format '{{.Name}}: pamięć {{.MemUsage}} ({{.MemPerc}}), procesor {{.CPUPerc}}' $ids 2>/dev/null
else
  echo "brak działających kontenerów"
fi

naglowek "Migracje bazy"
sql "select count(*) || ' wykonanych, ostatnia: ' || coalesce(max(migration_name) filter (where finished_at is not null), '-') || ', nieudanych: ' || count(*) filter (where finished_at is null and rolled_back_at is null) from _prisma_migrations" || echo "brak odpowiedzi bazy"

naglowek "Miejsce na dysku"
df -h . 2>/dev/null | tail -1 | awk '{print "dysk z repozytorium: wolne " $4 " z " $2 " (zajęte " $5 ")"}'
sql "select 'baza danych: ' || pg_size_pretty(pg_database_size(current_database()))"
dc exec -T db df -h /var/lib/postgresql/data 2>/dev/null | tail -1 | awk '{print "wolumen bazy: wolne " $4 " z " $2 " (zajęte " $5 ")"}'
docker system df 2>/dev/null

naglowek "Kolejka zadań"
sql "select status, count(*) from \"Job\" group by status order by status"
sql "select 'najstarsze czekające: ' || coalesce(to_char(min(\"runAfter\"), 'YYYY-MM-DD HH24:MI'), 'brak') from \"Job\" where status = 'PENDING' and \"runAfter\" <= now()"
sql "select 'nieudane w ostatniej dobie: ' || count(*) from \"Job\" where status = 'FAILED' and \"updatedAt\" > now() - interval '24 hours'"

naglowek "Ostatnie nieudane zadania (do 10)"
sql "select to_char(\"updatedAt\", 'YYYY-MM-DD HH24:MI') as kiedy, kind, attempts, left(regexp_replace(coalesce(\"lastError\", ''), '\s+', ' ', 'g'), 400) from \"Job\" where status = 'FAILED' order by \"updatedAt\" desc limit 10" \
  | zakryj | cut -c 1-300
# najpierw filtr na dłuższym tekście, dopiero potem przycięcie: ucięty token bez słowa-klucza nie przejdzie jawnie

naglowek "Błędy w logach panelu i workera (ostatnie ${OD}, do 30 linii)"
dc logs --no-color --since "$OD" web worker 2>/dev/null \
  | grep -E 'BŁĄD|UWAGA|[Ee]rror|ERROR|FATAL|[Ee]xception|exited|OOM' \
  | tail -n 30 | zakryj
echo
echo "Koniec raportu. Przed wysłaniem przejrzyj go: filtr zakrywa typowe dane, ale nie zna Twoich nazw własnych."
