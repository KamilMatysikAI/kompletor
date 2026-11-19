// Zdrowie instancji: wersja i commit obrazu, baza, migracje, ślad pracy workera.
// Czyste funkcje tutaj (testy w zdrowie.test.ts), odczyt z bazy i dysku w app/api/health/route.ts.
import { safeEqual } from './basic-auth'

export interface AppliedMigration {
  name: string
  finished: boolean
  rolledBack: boolean
}

export interface MigrationState {
  /** Ostatnia zastosowana migracja (po nazwie, czyli po dacie z prefiksu). */
  last: string | null
  /** Migracje z obrazu, których baza nie ma; null, gdy obraz nie niesie katalogu migracji. */
  pending: number | null
  /** Migracje rozpoczęte i nieukończone (Prisma zostawia je przy błędzie; `migrate deploy` wtedy odmawia). */
  failed: number
}

export function migrationState(bundled: string[] | null, applied: AppliedMigration[]): MigrationState {
  const ok = new Set(applied.filter((m) => m.finished && !m.rolledBack).map((m) => m.name))
  const failed = applied.filter((m) => !m.finished && !m.rolledBack).length
  const last = [...ok].sort().at(-1) ?? null
  const pending = bundled ? bundled.filter((n) => !ok.has(n)).length : null
  return { last, pending, failed }
}

export type HealthStatus = 'ok' | 'degraded' | 'error'

/** Logowanie klienta firmy rolą aplikacji: `off` = tryb bez APP_DATABASE_URL (stary self-host). */
export type AppRoleHealth = 'ok' | 'error' | 'off'

/**
 * `degraded` także, gdy cień zamówień jest włączony, a któreś konto nie czyta (lib/cien/stan-odczytu.ts).
 * HTTP przy `degraded` zostaje 200 (healthcheck kontenera web nie może restartować panelu przez awarię kanału) —
 * monitoring i deploy patrzą na `status` / `ok`.
 */
export function overallStatus(s: {
  db: boolean
  migrations: MigrationState | null
  appRole?: AppRoleHealth | null
  /** Stan kluczy głównych sekretów: `error` = zły zestaw w env albo wpisy w bazie bez klucza. */
  secretsKey?: 'ok' | 'none' | 'error' | null
  /** Odczyt cienia zamówień: `degraded` = któreś włączone konto nie czyta. */
  cien?: 'ok' | 'degraded' | 'off' | null
}): HealthStatus {
  // rola aplikacji nie loguje się (np. rozjazd hasła web/worker) = klient firmy nie działa;
  // zły zestaw kluczy sekretów = worker nie wystartuje. Jedno źródło statusu dla `ok` i kodu HTTP.
  if (!s.db || s.appRole === 'error' || s.secretsKey === 'error') return 'error'
  const m = s.migrations
  if (m && ((m.pending ?? 0) > 0 || m.failed > 0)) return 'degraded'
  if (s.cien === 'degraded') return 'degraded'
  return 'ok'
}

/**
 * Wynik sprawdzenia pamiętany `ttlMs` i jeden lot w locie: `/api/health` jest otwarte bez
 * hasła, więc bez tego każde żądanie z zewnątrz otwierałoby nowe połączenie do Postgresa. Baza widzi najwyżej jedno
 * sprawdzenie na `ttlMs` niezależnie od ruchu. Odrzucony lot nie jest pamiętany (następne żądanie próbuje od nowa).
 */
export function cachedCheck<T>(check: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let cached: { at: number; value: T } | null = null
  let inflight: Promise<T> | null = null
  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value)
    inflight ??= check()
      .then((value) => {
        cached = { at: now(), value }
        return value
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/i

/** Wersja i commit: `APP_VERSION`/`BUILD_SHA` z builda, w Coolify commit z `SOURCE_COMMIT`. */
export function buildInfo(env: Record<string, string | undefined>, pkgVersion: string): { version: string; sha: string | null } {
  const raw = [env.BUILD_SHA, env.SOURCE_COMMIT].find((v) => v && SHA_RE.test(v.trim()))
  return { version: env.APP_VERSION?.trim() || pkgVersion, sha: raw ? raw.trim().slice(0, 12) : null }
}

// w hostingu wielu firm (APP_MODE=hosted, publiczny adres) `/api/health` bez
// autoryzacji pokazuje tylko to, czego potrzebuje healthcheck kontenera, monitoring i skrypt wdrożenia: stan, commit,
// tryb, bazę, rolę aplikacji, klucze sekretów i liczby migracji. Bez wersji, nazwy ostatniej migracji, śladu kolejki
// i liczników cienia (metadane operacyjne całej instancji). Pełna odpowiedź: Basic Auth (staging) albo
// `Authorization: Bearer <HEALTH_TOKEN>`. Self-host bez zmian.

/** Czy żądanie niesie token operatora z `HEALTH_TOKEN` (porównanie w stałym czasie). Brak zmiennej = nigdy. */
export function hasValidHealthToken(authorization: string | null, env: Record<string, string | undefined>): boolean {
  const token = env.HEALTH_TOKEN?.trim()
  if (!token || !authorization) return false
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return m?.[1] ? safeEqual(m[1].trim(), token) : false
}

export interface HealthBody {
  ok: boolean
  status: HealthStatus
  version: string
  sha: string | null
  appMode: string
  db: 'ok' | 'error'
  appRole: AppRoleHealth | null
  migrations: MigrationState | null
  secretsKey: 'ok' | 'none' | 'error'
  queue: unknown
  cien: unknown
  time: string
}

export type PublicHealthBody = Pick<HealthBody, 'ok' | 'status' | 'sha' | 'appMode' | 'db' | 'appRole' | 'secretsKey' | 'time'> & {
  migrations: Pick<MigrationState, 'pending' | 'failed'> | null
}

/** Ciało odpowiedzi dla wołającego: hosted bez autoryzacji = okrojone, w pozostałych przypadkach pełne. */
export function healthBodyFor(body: HealthBody, o: { hosted: boolean; authorized: boolean }): HealthBody | PublicHealthBody {
  if (!o.hosted || o.authorized) return body
  return {
    ok: body.ok,
    status: body.status,
    sha: body.sha,
    appMode: body.appMode,
    db: body.db,
    appRole: body.appRole,
    secretsKey: body.secretsKey,
    migrations: body.migrations ? { pending: body.migrations.pending, failed: body.migrations.failed } : null,
    time: body.time,
  }
}
