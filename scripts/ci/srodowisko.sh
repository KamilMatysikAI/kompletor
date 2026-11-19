#!/usr/bin/env bash
# CI: zmienne środowiska jobu bez żadnego sekretu z repo ani z ustawień GitHuba.
# Klucze szyfrowania są losowane przy każdym przebiegu i maskowane w logu; integracje (BL, wFirma, kanały, kurierzy)
# zostają puste, więc testy pracują wyłącznie na atrapach z tests/*-atrapa.ts.
# Użycie w kroku workflow: bash scripts/ci/srodowisko.sh (dopisuje do $GITHUB_ENV).
set -euo pipefail

: "${GITHUB_ENV:?uruchamiaj tylko w GitHub Actions}"

los() { openssl rand -hex 32; }

APP_KEY="$(los)"
CUST_KEY="$(los)"
LOOKUP_KEY="$(los)"
for v in "$APP_KEY" "$CUST_KEY" "$LOOKUP_KEY"; do echo "::add-mask::$v"; done

{
  echo "APP_MODE=self-host"
  echo "APP_ENCRYPTION_KEY=$APP_KEY"
  echo "CUSTOMER_DATA_KEYS=1:$CUST_KEY"
  echo "CUSTOMER_LOOKUP_KEY=$LOOKUP_KEY"
  # Te same wartości co w lokalnym stosie testowym agentów (.env z .env.example).
  echo "EMPIK_MIRAKL_BASE_URL=https://empik-prod.mirakl.net/api"
  echo "WORKER_POLL_MS=2000"
  echo "KOMPLETOR_ROLA=web"
  echo "KATALOG_IMPORT_DNI_SPRZEDAZY=0"
  echo "CIEN_OKNO_GODZINY=24"
  echo "NEXT_TELEMETRY_DISABLED=1"
} >> "$GITHUB_ENV"
