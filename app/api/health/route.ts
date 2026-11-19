// Zdrowie instancji. Healthcheck Coolify patrzy na kod HTTP (200 = baza odpowiada, 503 = nie albo zły
// zestaw kluczy głównych sekretów, `secretsKey: error`).
// z APP_DATABASE_URL także logowanie rolą aplikacji (klient firmy) — nie loguje się
// (np. inne hasło w web i workerze) = `appRole: error` i 503, żeby Coolify widział awarię klienta firmy, nie tylko bazy.
// Jedno źródło statusu: overallStatus({ db, migrations, appRole, secretsKey, cien }); `ok` i kod HTTP z niego.
// Treść: wersja i commit obrazu, stan migracji, tryb, ślad pracy workera (ostatnia zmiana w kolejce zadań) i czy cień
// zamówień czyta (`cien` — liczniki; lista kont tylko z poprawnym hasłem Basic Auth). Bez sekretów;
// bez hasła także bez danych firm. Ścieżka otwarta w obu bramkach proxy.ts (Basic Auth z lib/basic-auth.ts i sesja
// panelu), bo healthcheck kontenera woła ją bez hasła.
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { hasValidBasicAuth } from '@/lib/basic-auth'
import { shadowEnabled, shadowReadingForHealth, type ShadowReadingState } from '@/lib/cien/stan-odczytu'
import { appRoleLoginWorks, systemPrisma } from '@/lib/db'
import { encryptionKeysStatus, keyCoverage, secretKeyVersionsInDb } from '@/lib/sekrety'
import {
  buildInfo,
  cachedCheck,
  hasValidHealthToken,
  healthBodyFor,
  migrationState,
  overallStatus,
  type AppRoleHealth,
  type MigrationState,
} from '@/lib/zdrowie'
import pkg from '@/package.json'

export const dynamic = 'force-dynamic'

async function bundledMigrations(): Promise<string[] | null> {
  try {
    const dir = path.join(process.cwd(), 'prisma', 'migrations')
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return null
  }
}

let lastAppRoleLog: string | null = null

async function appRoleHealth(): Promise<AppRoleHealth> {
  const url = process.env.APP_DATABASE_URL
  if (!url) return 'off'
  let state: AppRoleHealth
  let why = ''
  try {
    state = (await appRoleLoginWorks(url, 3000)) ? 'ok' : 'error'
    if (state === 'error') why = 'hasło w APP_DATABASE_URL nie pasuje do roli logistyka_app (inna wartość w web i workerze?)'
  } catch (e) {
    state = 'error'
    why = e instanceof Error ? e.message : String(e)
  }
  // log tylko przy zmianie stanu (healthcheck co kilka sekund nie zasypuje logu); komunikat pg bez hasła
  const line = state === 'ok' ? 'ok' : why
  if (line !== lastAppRoleLog) {
    if (state !== 'ok') console.error(`[health] rola aplikacji: ${why}`)
    else if (lastAppRoleLog !== null) console.log('[health] rola aplikacji: logowanie znów działa')
    lastAppRoleLog = line
  }
  return state
}

// najwyżej jedno logowanie rolą aplikacji na 10 s, niezależnie od ruchu na otwartej ścieżce. connect-timeout
// 3 s (healthcheck Dockera ma --timeout=5s). appRoleHealth sam łapie błędy, więc lot nigdy nie jest odrzucony.
// Błąd połączenia rolą = `error` (klient firmy padnie tak samo) — świadomie inaczej niż „błąd zapytania nie udaje błędu”.
const appRoleHealthCached = cachedCheck(appRoleHealth, 10_000)

interface DbState {
  dbOk: boolean
  migrations: MigrationState | null
  queue: { lastActivity: string | null; failedLastHour: number } | null
  /** Wpisy sekretów w bazie, których klucze z env nie otworzą (null = nie sprawdzono: brak bazy, zły env, błąd zapytania). */
  keysCoverageError: boolean | null
}

/** Zapytania health do bazy poza cieniem (ten ma własny bufor 10 s). Sam łapie błędy, więc nigdy nie jest odrzucone. */
async function dbState(): Promise<DbState> {
  const db = systemPrisma()
  let dbOk = false
  let migrations: MigrationState | null = null
  let queue: DbState['queue'] = null
  let keysCoverageError: boolean | null = null
  try {
    // zawieszona baza nie trzyma wspólnego lotu bez końca
    await Promise.race([db.$queryRaw`SELECT 1`, new Promise((_, reject) => setTimeout(() => reject(new Error('SELECT 1: limit czasu')), 3000).unref())])
    dbOk = true
  } catch {
    dbOk = false
  }
  if (dbOk) {
    try {
      const rows = await db.$queryRaw<{ name: string; finished: boolean; rolledBack: boolean }[]>`
        SELECT migration_name AS name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
        FROM _prisma_migrations`
      migrations = migrationState(await bundledMigrations(), rows)
    } catch {
      migrations = null // baza bez tabeli migracji (przed pierwszym migrate deploy)
    }
    try {
      const [last, failed] = await Promise.all([
        db.job.aggregate({ _max: { updatedAt: true } }),
        db.job.count({ where: { status: 'FAILED', updatedAt: { gte: new Date(Date.now() - 3600_000) } } }),
      ])
      queue = { lastActivity: last._max.updatedAt?.toISOString() ?? null, failedLastHour: failed }
    } catch {
      queue = null
    }
    const keys = encryptionKeysStatus(process.env)
    if (keys.status !== 'error') {
      try {
        keysCoverageError = keyCoverage(keys.ring ?? null, await secretKeyVersionsInDb(db)).status === 'error'
      } catch {
        // baza bez tabeli sekretów (przed migracją) albo chwilowy błąd — zostaje stan z env
      }
    }
  }
  return { dbOk, migrations, queue, keysCoverageError }
}

// żądania bez hasła (healthcheck kontenera, monitoring, ktokolwiek z zewnątrz) dostają wynik zapytań
// bazy sprzed najwyżej 5 s — baza widzi najwyżej jeden komplet tych zapytań na 5 s niezależnie od ruchu (stan cienia
// i logowanie rolą aplikacji mają własne bufory, 10 s). Awaria bazy = 503 najpóźniej po 5 s od ostatniego udanego
// sprawdzenia (plus czas, w którym nowe sprawdzenie stwierdzi brak bazy); nieudane sprawdzenie też jest pamiętane 5 s.
// Żądania z poprawnym hasłem Basic Auth czytają bazę na świeżo. Ciało odpowiedzi bez zmian (skrypt wdrożenia czyta
// `status`, `ok`, `migrations`, `sha`, `cien`, `appRole`, `secretsKey`).
// (zamyka TODO): w APP_MODE=hosted ciało bez autoryzacji okrojone (lib/zdrowie.ts, healthBodyFor);
// autoryzacja = Basic Auth (staging) albo `Authorization: Bearer <HEALTH_TOKEN>` (hosting, porównanie w stałym czasie).
const dbStateCached = cachedCheck(dbState, 5_000)

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  const authorized = hasValidBasicAuth(authHeader, process.env) || hasValidHealthToken(authHeader, process.env)
  const { dbOk, migrations, queue, keysCoverageError } = authorized ? await dbState() : await dbStateCached()
  let cien: ShadowReadingState | null = null
  if (dbOk) {
    try {
      // najwyżej jedno liczenie na 10 s na otwartej ścieżce
      cien = await shadowReadingForHealth(systemPrisma, shadowEnabled(process.env))
    } catch {
      cien = null // baza przed migracją cienia
    }
  }
  // bez bazy i tak 503 — nie dokładamy do odpowiedzi czasu logowania rolą
  const appRole: AppRoleHealth | null = dbOk ? await appRoleHealthCached() : null
  // klucze główne sekretów: env, a przy działającej bazie też pokrycie wersji wpisów; sam stan,
  // bez treści błędu — ścieżka jest otwarta bez hasła. Błąd ZAPYTANIA o wersje nie udaje błędu kluczy (zostaje stan
  // z env), a błąd POŁĄCZENIA rolą aplikacji wyżej to `appRole: error` — świadomie inaczej: klient firmy właśnie tak
  // padnie (nie „ujednolicać”).
  const keys = encryptionKeysStatus(process.env)
  let secretsKey = keys.status
  if (secretsKey !== 'error' && keysCoverageError) secretsKey = 'error'
  // Brak odczytu stanu cienia przy włączonym cieniu też jest „degraded” — nie wiemy, czy czyta.
  const cienStatus = cien ? cien.status : dbOk && shadowEnabled(process.env) ? 'degraded' : null
  const status = overallStatus({ db: dbOk, migrations, appRole, secretsKey, cien: cienStatus })
  const details = cien && authorized
  const cienOut = cien
    ? {
        enabled: cien.enabled,
        status: cien.status,
        accounts: cien.accounts,
        notReading: cien.notReading,
        openAlerts: cien.openAlerts,
        withoutAdapter: cien.withoutAdapter,
        ...(details
          ? {
              details: cien.details.map((d) => ({
                organizationId: d.organizationId,
                account: `${d.channel}/${d.channelAccountId}`,
                name: d.name,
                adapterKey: d.adapterKey,
                reading: d.reading,
                reason: d.reason,
                lastOkAt: d.lastOkAt?.toISOString() ?? null,
                failingSince: d.failingSince?.toISOString() ?? null,
                lastError: d.lastError?.slice(0, 300) ?? null,
              })),
            }
          : {}),
      }
    : null
  const appMode = process.env.APP_MODE || 'self-host'
  const body = healthBodyFor(
    {
      // ok = status „ok” (monitoring); `degraded` zostaje na HTTP 200 (ok:false), 503 tylko przy `error`
      ok: status === 'ok',
      status,
      ...buildInfo(process.env, pkg.version),
      appMode,
      db: dbOk ? 'ok' : 'error',
      appRole,
      migrations,
      secretsKey,
      queue,
      cien: cienOut,
      time: new Date().toISOString(),
    },
    // wartość spoza self-host (np. literówka „Hosted”) = okrojone ciało: przy błędzie konfiguracji raczej mniej niż więcej
    { hosted: appMode.trim() !== 'self-host', authorized },
  )
  return Response.json(body, { status: status === 'error' ? 503 : 200, headers: { 'Cache-Control': 'no-store' } })
}
