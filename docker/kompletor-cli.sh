#!/bin/sh
# Polecenia CLI w działającym kontenerze: `docker compose exec web kompletor <polecenie> …`.
# `docker compose exec` dostaje env kontenera, a nie ten zbudowany przez entrypoint, więc adresy bazy i klucz
# szyfrowania z KOMPLETOR_SEKRETY_DIR buduje tu ta sama funkcja co przy starcie (docker/entrypoint.sh). Zmienne
# ustawione w env (Coolify) wygrywają jak w entrypoincie. Wartości nie są wypisywane.
set -eu
KOMPLETOR_ENTRYPOINT_TYLKO_FUNKCJE=1 . /usr/local/bin/entrypoint.sh
zbuduj_adresy

CMD="${1:-}"
case "$CMD" in
  migracja-bazowa-wykonana)
    # jednorazowa naprawa bazy ze starszej historii migracji (docs/instalacja.md, „Start zatrzymany: brak migracji bazowej”)
    cd /opt/migrate
    exec node node_modules/prisma/build/index.js migrate resolve --applied 00000000000000_baza
    ;;
  org|sekret|uzytkownik|cien|import-katalogu|przelicz-zamowienia|klienci) shift ;;
  *)
    echo "Użycie: kompletor org | sekret | uzytkownik | cien | import-katalogu | przelicz-zamowienia | klienci | migracja-bazowa-wykonana [argumenty]" >&2
    echo "  np. kompletor uzytkownik lista, kompletor org list, kompletor sekret --firma <slug> --lista" >&2
    exit 2
    ;;
esac
cd /app
exec node "dist/${CMD}.cjs" "$@"
