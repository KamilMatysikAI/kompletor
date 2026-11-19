#!/usr/bin/env bash
# CI: Postgres 16 dla testów integracyjnych, jak lokalny stos z docker-compose.dev.yml.
# Kontener zamiast `services:`, bo usługa GitHuba nie przyjmuje argumentów startu (fsync=off) ani pliku z checkoutu
# (docker/init-db.sql zakłada bazy logistyka_test i logistyka_shadow). Hasła losowe na przebieg, maskowane w logu.
# Tylko baza jednorazowa na runnerze: fsync=off nigdy na stagingu ani produkcji.
set -euo pipefail

: "${GITHUB_ENV:?uruchamiaj tylko w GitHub Actions}"
OBRAZ="${PG_OBRAZ:?brak PG_OBRAZ}"

# Port poza standardem: obraz runnera ma zainstalowany (zatrzymany) PostgreSQL na 5432.
PG_PORT="${PG_PORT:-55432}"
PGPW="$(openssl rand -hex 24)"
APPPW="$(openssl rand -hex 24)"
echo "::add-mask::$PGPW"
echo "::add-mask::$APPPW"

docker run -d --name kompletor-pg \
  -e POSTGRES_USER=logistyka -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_DB=logistyka \
  -p "127.0.0.1:${PG_PORT}:5432" \
  -v "$PWD/docker/init-db.sql:/docker-entrypoint-initdb.d/10-init.sql:ro" \
  "$OBRAZ" \
  postgres -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null

# Serwer tymczasowy skryptu startowego nie słucha na TCP, więc gotowość po TCP = właściwy serwer po init-db.sql.
for _ in $(seq 1 90); do
  if docker exec kompletor-pg pg_isready -q -h 127.0.0.1 -U logistyka -d logistyka_test; then break; fi
  sleep 1
done
docker exec kompletor-pg pg_isready -h 127.0.0.1 -U logistyka -d logistyka_test

BASE="postgresql://logistyka:${PGPW}@127.0.0.1:${PG_PORT}"
{
  echo "DATABASE_URL=${BASE}/logistyka"
  echo "SHADOW_DATABASE_URL=${BASE}/logistyka_shadow"
  echo "TEST_DATABASE_URL=${BASE}/logistyka_test"
  # Rola aplikacji: testy biorą hasło z APP_DATABASE_URL na tym samym hoście i porcie
  # (tests/global-setup.ts, testAppDbUrl) i same je ustawiają przez ensureAppRoleLogin.
  echo "APP_DATABASE_URL=postgresql://logistyka_app:${APPPW}@127.0.0.1:${PG_PORT}/logistyka"
} >> "$GITHUB_ENV"
