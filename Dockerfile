# syntax=docker/dockerfile:1
# Kompletor: jeden obraz, dwie role (KOMPLETOR_ROLA=web | worker) — w Coolify dwie aplikacje z tego
# samego repo i Dockerfile'a, różnią się tylko env. Start kontenera: `prisma migrate deploy`, potem panel Next
# (standalone) albo worker (bundel esbuild). Wzorzec: system-najmu.

ARG NODE_IMAGE=node:22-alpine

# ── 1. Zależności ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# CLI Prismy bez łączenia z checkpoint.prisma.io i bez komunikatów o aktualizacji.
ENV CHECKPOINT_DISABLE=1     PRISMA_HIDE_UPDATE_MESSAGE=1
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall uruchamia `prisma generate` — potrzebuje schema.prisma, nie potrzebuje bazy
RUN npm ci --no-audit --no-fund

# ── 2. Build: panel (Next standalone) + bundel workera i CLI (esbuild z tsx) ──
FROM deps AS builder
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Sprawdzanie typów w `next build` bywa ciężkie; zapas sterty tylko w etapie builder (runtime go nie dziedziczy).
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build && npm run build:cli

# ── 3. CLI Prismy do migracji, izolowane od runtime'u aplikacji ──────────────
# Wersje przypięte do package-lock.json: migrator = ta sama Prisma co w developmencie.
FROM ${NODE_IMAGE} AS migrator
WORKDIR /opt/migrate
COPY package-lock.json /tmp/package-lock.json
RUN PRISMA_VERSION=$(node -p "require('/tmp/package-lock.json').packages['node_modules/prisma'].version") \
 && DOTENV_VERSION=$(node -p "require('/tmp/package-lock.json').packages['node_modules/dotenv'].version") \
 && echo '{"name":"migrate","private":true}' > package.json \
 && npm install --no-audit --no-fund "prisma@${PRISMA_VERSION}" "dotenv@${DOTENV_VERSION}"

# ── 4. Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    WORKER_HEARTBEAT_FILE=/tmp/kompletor-worker.alive     CHECKPOINT_DISABLE=1     PRISMA_HIDE_UPDATE_MESSAGE=1     RAPORTY_DIR=/tmp/kompletor-raporty     ZDJECIA_DIR=/dane/zdjecia
# RAPORTY_DIR: /app należy do roota, a raporty importu (raportDir w payloadzie) muszą dać się zapisać jako `app`.
# Katalog tymczasowy kontenera — raport to materiał roboczy, nie dane do trzymania.

RUN addgroup -S app && adduser -S app -G app
# katalog zdjęć produktów /dane/zdjecia. Zdjęcia są w bazie; katalog zostaje dla plików ze starszych
# wersji, które start kontenera przenosi do bazy (org.cjs zdjecia-do-bazy).
RUN mkdir -p /dane/zdjecia && chown -R app:app /dane

COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
# schematy FA(3) jawnie, nie tylko przez śledzenie plików Nexta — worker (bundel
# esbuild) czyta je z /app/lib/ksef/xsd, a bez nich wysyłka do KSeF odmawia (nic nie wychodzi bez sprawdzenia XSD).
COPY --from=builder --chown=app:app /app/lib/ksef/xsd ./lib/ksef/xsd
# Klient Prismy (wygenerowany + runtime z silnikiem zapytań) jawnie, żeby worker i CLI nie zależały od tego,
# co Next prześledził do standalone.
COPY --from=builder --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=app:app /app/node_modules/@prisma/client ./node_modules/@prisma/client
# Worker i CLI (org, sekret, import katalogu) jako bundle CJS (scripts/build-cli.mjs); zewnętrzny tylko @prisma/client.
COPY --from=builder --chown=app:app /app/dist ./dist
# Tabela nadpisań powiązań ofert (dane/nadpisania-ofert/<firma>.csv: id ofert i SKU, bez danych klientów);
# import katalogu w workerze czyta ją z /app/dane (scripts/build-cli.mjs ustawia ścieżkę jak w repo). W publicznym
# obrazie tylko pusty katalog: plik firmy montuje się do /app/prywatne/nadpisania-ofert/<firma>.csv
# albo wskazuje katalogiem KOMPLETOR_NADPISANIA_KATALOG.
COPY --chown=app:app dane ./dane
# Presety firm (seed/presety/<nazwa>.json, bez sekretów): seed przy starcie (KOMPLETOR_SEED=<nazwa>) i
# `node dist/cien.cjs konfiguruj` czytają je z /app/seed/presety. W obrazie tylko przyklad.json (.dockerignore);
# preset firmy montuje się do /app/prywatne/presety/<nazwa>.json albo wskazuje KOMPLETOR_PRESET_PLIK.
COPY --chown=app:app seed/presety ./seed/presety
# Lista migracji w obrazie: /api/health porównuje ją z bazą (pole migrations.pending).
COPY --chown=app:app prisma/migrations ./prisma/migrations

COPY --from=migrator --chown=app:app /opt/migrate /opt/migrate
COPY --chown=app:app prisma/schema.prisma /opt/migrate/prisma/schema.prisma
COPY --chown=app:app prisma/migrations /opt/migrate/prisma/migrations
COPY --chown=app:app prisma.config.ts /opt/migrate/prisma.config.ts
COPY --chown=app:app docker/kontrola-migracji-bazowej.sql /opt/migrate/kontrola-migracji-bazowej.sql
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=755 docker/healthcheck.sh /usr/local/bin/healthcheck.sh
# CLI w działającym kontenerze z adresami bazy z wolumenu sekretów: docker compose exec web kompletor …
COPY --chmod=755 docker/kompletor-cli.sh /usr/local/bin/kompletor

# Wersja i commit w /api/health. Coolify przekazuje SOURCE_COMMIT jako build arg (zmienna env aplikacji
# `SOURCE_COMMIT`), CI może podać BUILD_SHA/APP_VERSION wprost.
ARG APP_VERSION=""
ARG BUILD_SHA=""
ARG SOURCE_COMMIT=unknown
ENV APP_VERSION=${APP_VERSION} \
    BUILD_SHA=${BUILD_SHA:-$SOURCE_COMMIT}

USER app
EXPOSE 3000
# start-period 150 s: migracja + do 90 s czekania workera na hasło roli ustawiane przez web
# Coolify z włączonym healthcheckiem zastępuje ten wpis własnym: web ma tam retries 30 (staging_kompletor.py, krok aplikacje)
HEALTHCHECK --interval=30s --timeout=5s --start-period=150s --retries=3 CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
