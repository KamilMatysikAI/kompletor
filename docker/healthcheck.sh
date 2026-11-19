#!/bin/sh
# Healthcheck kontenera, zależny od roli:
#   web    — GET http://127.0.0.1:${PORT}/api/health musi dać 200 (baza odpowiada, klucze główne sekretów poprawne),
#   worker — plik życia ${WORKER_HEARTBEAT_FILE} młodszy niż 180 s (worker zapisuje go co 30 s z timera).
set -eu
if [ "${KOMPLETOR_ROLA:-web}" = "worker" ]; then
  f="${WORKER_HEARTBEAT_FILE:-/tmp/kompletor-worker.alive}"
  [ -f "$f" ] || exit 1
  age=$(( $(date +%s) - $(stat -c %Y "$f") ))
  [ "$age" -lt 180 ] || exit 1
  exit 0
fi
wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null
