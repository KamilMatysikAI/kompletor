# Prawdziwy WooCommerce w Dockerze

Sprawdzenie „Połącz z WooCommerce” (wc-auth) i adaptera Woo na prawdziwym WordPressie z WooCommerce, bez dotykania
żadnego sklepu. Wszystko lokalnie, dane fikcyjne.

## Co jest w środku

- `compose.yml`: MariaDB, WordPress (najnowszy obraz `wordpress:php8.3-apache`), wp-cli (profil `cli`) i Caddy
  z certyfikatem `tls internal` dla dwóch nazw: `https://sklep.woo.test` (WordPress) i `https://panel.woo.test`
  (Kompletor uruchomiony na hoście, port `PANEL_PORT`). W sieci Compose obie nazwy wskazują Caddy, więc sklep
  wysyła klucze na panel tak jak w internecie.
- `mu-plugin-test.php`: tylko w tym kontenerze wyłącza w `wp_safe_remote_post` odmowę adresów prywatnych
  i sprawdzanie certyfikatu (Caddy ma własny), i zapisuje do `wp-content/kompletor-test.log` status, metodę,
  `Content-Type` i nazwy pól POST-a z kluczami (bez wartości kluczy).
- `sklep-init.sh`: instalacja WordPressa, WooCommerce, PLN, dwa produkty i jedno zamówienie (fikcyjne).
- `przebieg.ts`: logowanie do panelu (firma demo), „Połącz” z odmową, z odczytem i z zapisem w prawdziwej
  przeglądarce, test połączenia, zapis adapterem (numer nadania, stan, status) i odpowiedzi `_fields`.
  Każde żądanie serwera idzie przez `lokalnyFetch`, który odmawia hostów spoza `*.woo.test`.
- `fields-wp.test.ts` + `fields-wp.json`: atrapa `_fields` z suity kontraktowej porównana z zapisem odpowiedzi
  prawdziwego WordPressa (test jednostkowy, bez Dockera).

## Uruchomienie

1. Plik `.env.stos` poza repo: `WP_DB_HASLO`, `WP_ADMIN_HASLO` (losowe), `PANEL_PORT=3199`, `CADDY_PORT=443`.
2. Z katalogu repo (ścieżki w `compose.yml` są względem repo):
   `docker compose -p <projekt> --env-file <.env.stos> -f docker-compose.dev.yml -f <nadpisanie portu bazy> -f tests/woo-prawdziwy/compose.yml up -d`
   i `... --profile cli run --rm wpcli sh /sklep-init.sh` (w Git Bash z `MSYS_NO_PATHCONV=1`).
3. `.env` Kompletora: baza z kroku 2, `PANEL_URL=https://panel.woo.test`, `APP_MODE=self-host`, klucz szyfrowania;
   `npx prisma migrate deploy`, `npm run rola:aplikacji`, `npm run demo:panel -- --tak`.
4. Panel w trybie produkcyjnym: `npx next build` i `npx next start -p 3199` (`next dev` za Caddy blokuje skrypty
   z innego originu, więc przyciski działają bez JavaScriptu i wynik jest mylący).
5. `PLAYWRIGHT_CORE_DIR=<playwright-core poza repo> CHROMIUM_EXE=<chrome.exe> WP_ADMIN_HASLO=… WYNIKI_DIR=<katalog> npx tsx tests/woo-prawdziwy/przebieg.ts`
6. Sprzątanie: ten sam zestaw `-f` z `down -v`.
