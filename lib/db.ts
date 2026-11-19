// Klienci bazy. Każdy klient jest związany z jedną firmą albo jawnie systemowy — innego nie ma.
//
// Izolacja firm robi Postgres (RLS, migracja 00000000000000_baza): klient firmy pracuje jako rola
// `logistyka_app` z ustawieniem sesji `app.org_id = <firma>`, więc każde jego zapytanie (także surowe SQL i transakcje
// interaktywne) widzi i zapisuje wyłącznie wiersze tej firmy, a `organizationId` przy INSERT wypełnia baza.
// Klient systemowy (właściciel tabel, RLS go nie dotyczy) jest tylko dla kodu systemowego: kolejka workera
// przez wszystkie firmy, zakładanie firm, seed, testy. Gdzie wolno go używać, pilnuje test
// tests/organizacje-izolacja.integration.test.ts (lista SYSTEM_CLIENT_ALLOWED).
//
// klient firmy loguje się własną rolą LOGIN (`APP_DATABASE_URL` = `logistyka_app` z hasłem), z parametrem
// `options = -c app.org_id=<firma>`. Sesja nie ma dokąd wrócić: `SET ROLE NONE` zostawia `logistyka_app`, a `SET SESSION
// AUTHORIZATION` i `SET ROLE <inna>` dają odmowę, więc jedyną drogą obejścia zostaje `set_config` / `SET app.org_id`
// (zmiana firmy, nie roli; bez DDL), pilnowana strażnikiem kodu SESSION_ESCAPE w teście izolacji. Hasło roli ustawia
// krok instalacji `ensureAppRoleLogin` (`npm run rola:aplikacji`, w obrazie przy starcie kontenera), nie migracja.
// Bez `APP_DATABASE_URL` zostaje stary tryb (tylko self-host, z ostrzeżeniem): właściciel bazy z `-c role=logistyka_app`,
// gdzie `SET ROLE NONE` wraca do właściciela. Hosting (`APP_MODE=hosted`) bez `APP_DATABASE_URL` = odmowa.
// Co zostaje „w roli” (klasa DoS, nie eskalacja, i tylko przy dowolnym SQL od najemcy):
// rola może zmienić własne hasło (`ALTER ROLE logistyka_app PASSWORD`) — instancja traci nowe połączenia do restartu
// web, który hasło przywraca — i własne ustawienia domyślne (`ALTER ROLE … SET`), które nic nie dają, bo parametry
// startowe mają pierwszeństwo, a hak sprawdza `app.org_id`. Kod aplikacji nie wykonuje `ALTER ROLE` poza krokiem
// instalacji w tym pliku (strażnik ROLE_DDL w teście izolacji).
//
// Każde nowe połączenie puli klienta firmy jest sprawdzane, zanim dostanie pierwsze zapytanie (hak `onConnect` puli):
// rola `logistyka_app` (w trybie LOGIN także `session_user`), bez superusera, BYPASSRLS i członkostwa w innych rolach,
// właściwa firma w `app.org_id`. Pośrednik (pooler), który zgubi parametr `options`, daje więc odmowę połączenia, a nie
// widok wszystkich firm. Kod aplikacji nie wykonuje `SET [LOCAL|SESSION] ROLE`,
// `SET [LOCAL] app.org_id`, `RESET`, `SET SESSION AUTHORIZATION`, `DISCARD` ani `set_config` (strażnik kodu), a
// `pg` importuje tylko ten plik (strażnik, P7).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

export const APP_ROLE = 'logistyka_app'
export const ORG_ID_RE = /^[a-z0-9_-]{1,64}$/

/** Tryb klienta firmy: `login` = własna rola LOGIN (APP_DATABASE_URL), `role` = właściciel z `-c role=` (stary self-host). */
export type OrgClientMode = 'login' | 'role'

// rejestr w globalThis, jak pamięć klientów w prismaForOrg niżej. Next ładuje ten moduł osobno dla warstwy
// tras API i warstwy stron; klient z pamięci globalnej utworzony w jednej warstwie był w drugiej „bez firmy”.
const orgOfClient = ((globalThis as unknown as { kompletorOrgOfClient?: WeakMap<object, { organizationId: string; mode: OrgClientMode }> }).kompletorOrgOfClient ??=
  new WeakMap<object, { organizationId: string; mode: OrgClientMode }>())

export interface ClientOpts {
  /** Adres właściciela bazy (klient systemowy; klient firmy tylko w starym trybie `-c role=`). Domyślnie DATABASE_URL. */
  connectionString?: string
  /**
   * Adres roli aplikacji (LOGIN `logistyka_app` z hasłem) dla klienta firmy. Domyślnie APP_DATABASE_URL — ale tylko gdy
   * nie podano jawnie `connectionString` (jawny adres innej bazy nie miesza się z adresem roli z env).
   */
  appConnectionString?: string
  poolMax?: number
  /** Tylko testy: podmiana parametru startowego (symulacja poolera, który gubi `options`). */
  testStartupOptions?: string
}

/** Adres bez parametru `options` i bez PGOPTIONS (pg łączy adres i env z konfiguracją — nadpisałyby rolę i firmę). */
function checkedUrl(url: string, name: string): string {
  if (!url) throw new Error(`Brak ${name}`)
  // Klucz sprawdzany po zdekodowaniu (`%6Fptions=` też jest `options`).
  let keys: string[] = []
  try {
    keys = [...new URL(url).searchParams.keys()].map((k) => k.toLowerCase())
  } catch {
    keys = /[?&]options=/i.test(decodeURIComponent(url)) ? ['options'] : []
  }
  if (keys.includes('options')) throw new Error(`${name} nie może zawierać parametru options (rola i firma ustawia lib/db.ts)`)
  if (process.env.PGOPTIONS) throw new Error('Zmienna PGOPTIONS jest niedozwolona (rola i firma ustawia lib/db.ts)')
  return url
}

function connectionStringOf(opts: ClientOpts): string {
  return checkedUrl(opts.connectionString ?? process.env.DATABASE_URL ?? '', 'DATABASE_URL')
}

function appConnectionStringOf(opts: ClientOpts): string | undefined {
  const url = opts.appConnectionString ?? (opts.connectionString === undefined ? process.env.APP_DATABASE_URL : undefined)
  return url ? checkedUrl(url, 'APP_DATABASE_URL') : undefined
}

export type AppMode = 'self-host' | 'hosted'

/** Tryb instalacji z env (jedno źródło dla db.ts, organizacje.ts, workera). Nieznana wartość = błąd. */
export function appModeOf(env: Record<string, string | undefined>): AppMode {
  const m = (env['APP_MODE'] ?? 'self-host').trim()
  if (m !== 'self-host' && m !== 'hosted') throw new Error(`APP_MODE musi być „self-host” albo „hosted”, jest „${m}”`)
  return m
}

const isHosted = () => appModeOf(process.env) === 'hosted'
let roleModeWarned = false

const VERIFY_SQL = `SELECT current_user AS role, session_user AS "sessionUser", current_setting('app.org_id', true) AS org,
  r.rolbypassrls AS bypass, r.rolsuper AS superuser,
  (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::int AS "memberOf"
  FROM pg_roles r WHERE r.rolname = current_user`

type VerifyRow = { role: string; sessionUser: string; org: string | null; bypass: boolean; superuser: boolean; memberOf: number }

// memberOf: rola aplikacji nie należy do żadnej innej (SET ROLE nie ma dokąd przejść); tryb LOGIN: sesja to sama rola
function isolationOk(r: VerifyRow | undefined, expected: string, mode: OrgClientMode): boolean {
  return (
    !!r && r.role === APP_ROLE && (mode === 'role' || r.sessionUser === APP_ROLE) && r.org === expected && !r.bypass && !r.superuser && r.memberOf === 0
  )
}

const describeRow = (r: VerifyRow | undefined) => `rola ${r?.role ?? '?'}, sesja ${r?.sessionUser ?? '?'}`

function build(connectionString: string, options: string | undefined, poolMax?: number, verify?: { org: string; mode: OrgClientMode }): PrismaClient {
  // Bez logów Prismy: przy błędzie wypisałaby argumenty zapytania (a także dane klientów).
  // Błędy łapią pętle i zapisują e.message do ImportIssue / Job.lastError / Order.flags.lastError / Alert.
  const config: pg.PoolConfig = { connectionString, ...(options ? { options } : {}), ...(poolMax ? { max: poolMax } : {}) }
  if (!verify) return new PrismaClient({ adapter: new PrismaPg(config), log: [], errorFormat: 'minimal' })
  // Hak puli po zestawieniu połączenia (P5): błąd = pula zamyka połączenie i oddaje błąd pytającemu
  const onConnect = async (client: pg.ClientBase): Promise<void> => {
    const res = await client.query<VerifyRow>(VERIFY_SQL)
    if (!isolationOk(res.rows[0], verify.org, verify.mode))
      throw new Error(`Połączenie firmy ${verify.org} bez izolacji (${describeRow(res.rows[0])}) — odmowa; sprawdź APP_DATABASE_URL i pooler (parametr options)`)
  }
  return new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ ...config, onConnect })), log: [], errorFormat: 'minimal' })
}

export function assertOrgId(organizationId: string): void {
  if (!ORG_ID_RE.test(organizationId)) throw new Error(`Nieprawidłowe id organizacji (dozwolone [a-z0-9_-], 1–64 znaki)`)
}

/**
 * Klient jednej firmy: widzi wyłącznie jej dane (RLS). Rola LOGIN z `APP_DATABASE_URL` (albo `appConnectionString`);
 * bez niej stary tryb `-c role=` na adresie właściciela — tylko self-host, z ostrzeżeniem.
 */
export function createOrgClient(organizationId: string, opts: ClientOpts = {}): PrismaClient {
  assertOrgId(organizationId)
  const appUrl = appConnectionStringOf(opts)
  let db: PrismaClient
  let mode: OrgClientMode
  if (appUrl) {
    mode = 'login'
    db = build(appUrl, opts.testStartupOptions ?? `-c app.org_id=${organizationId}`, opts.poolMax, { org: organizationId, mode })
  } else {
    if (isHosted()) throw new Error('APP_MODE=hosted wymaga APP_DATABASE_URL (rola LOGIN logistyka_app z hasłem, README „Rola aplikacji”)')
    const ownerUrl = connectionStringOf(opts)
    if (!roleModeWarned) {
      roleModeWarned = true
      console.warn('[db] Brak APP_DATABASE_URL: klient firmy łączy się jako właściciel bazy z -c role=logistyka_app (sesja może wrócić do właściciela). Ustaw rolę LOGIN: npm run rola:aplikacji (README „Rola aplikacji”).')
    }
    mode = 'role'
    db = build(ownerUrl, opts.testStartupOptions ?? `-c role=${APP_ROLE} -c app.org_id=${organizationId}`, opts.poolMax, { org: organizationId, mode })
  }
  orgOfClient.set(db, { organizationId, mode })
  return db
}

/** Klient systemowy (bez firmy, omija RLS). Tylko kod systemowy z listy w teście-strażniku. */
export function createSystemClient(opts: ClientOpts = {}): PrismaClient {
  return build(connectionStringOf(opts), undefined, opts.poolMax)
}

/** Id firmy klienta z `createOrgClient`. Klient systemowy albo obcy obiekt → błąd (zapis bez firmy niemożliwy). */
export function organizationIdOf(db: object): string {
  return orgClientInfo(db).organizationId
}

/** Tryb połączenia klienta firmy (`login` / `role`). */
export function orgClientModeOf(db: object): OrgClientMode {
  return orgClientInfo(db).mode
}

function orgClientInfo(db: object): { organizationId: string; mode: OrgClientMode } {
  const info = orgOfClient.get(db)
  if (!info) throw new Error('Operacja wymaga klienta firmy (createOrgClient), a dostała klienta bez firmy')
  return info
}

/** Sprawdzenie połączenia klienta firmy: rola bez obejścia RLS (tryb LOGIN: także sesja), właściwa firma w sesji. */
export async function verifyOrgClient(db: PrismaClient): Promise<void> {
  const { organizationId: expected, mode } = orgClientInfo(db)
  const rows = await db.$queryRaw<VerifyRow[]>`
    SELECT current_user AS role, session_user AS "sessionUser", current_setting('app.org_id', true) AS org,
           r.rolbypassrls AS bypass, r.rolsuper AS superuser,
           (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::int AS "memberOf"
    FROM pg_roles r WHERE r.rolname = current_user`
  const r = rows[0]
  if (!isolationOk(r, expected, mode)) throw new Error(`Połączenie firmy ${expected} bez izolacji (${describeRow(r)}) — przerwano`)
}

// ─── Rola aplikacji LOGIN: krok instalacji, nie migracja ─────────────────────────────────

const APP_PASSWORD_MIN = 16
const SCRAM_ITERATIONS = 4096

/**
 * Weryfikator SCRAM-SHA-256 w formacie Postgresa: do bazy (i jej logu poleceń) trafia skrót, nie hasło.
 * Hasło tylko ASCII — Postgres normalizuje inne znaki (SASLprep), więc skrót liczony tutaj by się z nim nie zgodził.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = SCRAM_ITERATIONS): string {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error('Hasło roli aplikacji: tylko drukowalne znaki ASCII bez spacji (np. openssl rand -hex 32)')
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const hmac = (key: Buffer, s: string) => createHmac('sha256', key).update(s).digest()
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest()
  const serverKey = hmac(salted, 'Server Key')
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Adres na tej samej maszynie (127.0.0.1 / localhost / ::1). Niepoprawny adres = nie. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

// SHA-256 lokalnego hasła roli z `.env.example` / docker-compose (publiczne, w repo). Skrót zamiast wartości: kod
// rozpoznaje to hasło i nie wpuszcza go na serwer spoza loopback, nie powielając go.
const REPO_DEV_APP_PASSWORD_SHA256 = '754f8a04efe99f550eee904d0e1c23fa165183751cbcf371821108dec025a311'

/** Hasło roli z adresu APP_DATABASE_URL; adres musi wskazywać rolę `logistyka_app`. */
export function appRolePasswordOf(appUrl: string): string {
  let u: URL
  try {
    u = new URL(appUrl)
  } catch {
    throw new Error('APP_DATABASE_URL nie jest poprawnym adresem postgresql://')
  }
  if (decodeURIComponent(u.username) !== APP_ROLE) throw new Error(`APP_DATABASE_URL musi logować rolę ${APP_ROLE}`)
  const password = decodeURIComponent(u.password)
  if (password.length < APP_PASSWORD_MIN) throw new Error(`Hasło roli aplikacji w APP_DATABASE_URL za krótkie (min. ${APP_PASSWORD_MIN} znaków; openssl rand -hex 32)`)
  scramVerifier(password, Buffer.alloc(16), 1) // sam test znaków
  if (!isLoopbackUrl(appUrl) && createHash('sha256').update(password).digest('hex') === REPO_DEV_APP_PASSWORD_SHA256)
    throw new Error('APP_DATABASE_URL: hasło z .env.example (publiczne) tylko na 127.0.0.1/localhost — wygeneruj własne: openssl rand -hex 32')
  return password
}

// Tożsamość bazy i serwera: ta sama nazwa bazy i ten sam czas startu postmastera = ten sam serwer i baza
const SERVER_ID_SQL = `SELECT current_database() AS db, pg_postmaster_start_time()::text AS started`
const APP_SESSION_SQL = `SELECT session_user AS s, current_database() AS db, pg_postmaster_start_time()::text AS started`

type AppSession = { db: string; started: string }

/**
 * Logowanie rolą aplikacji: dane sesji (baza, start serwera) = się da i sesja to `logistyka_app`; null = hasło nie
 * pasuje albo rola bez LOGIN. Inne błędy (brak serwera, brak bazy) rzucają.
 */
async function appRoleSession(appUrl: string, timeoutMs?: number): Promise<AppSession | null> {
  const c = new pg.Client({ connectionString: appUrl, ...(timeoutMs ? { connectionTimeoutMillis: timeoutMs } : {}) })
  try {
    await c.connect()
  } catch (e) {
    await c.end().catch(() => {})
    // 28P01 złe hasło, 28000 rola bez LOGIN (albo odrzucona przez pg_hba — wtedy ALTER ROLE nie pomoże, potwierdzenie padnie)
    const code = (e as { code?: string }).code
    if (code === '28P01' || code === '28000') return null
    throw e
  }
  try {
    const r = await c.query<{ s: string; db: string; started: string }>(APP_SESSION_SQL)
    if (r.rows[0]?.s !== APP_ROLE) throw new Error(`APP_DATABASE_URL loguje ${r.rows[0]?.s ?? '?'}, a nie ${APP_ROLE}`)
    return { db: r.rows[0].db, started: r.rows[0].started }
  } finally {
    await c.end().catch(() => {})
  }
}

/**
 * Czy klient firmy może się teraz zalogować rolą aplikacji (`/api/health`). false = hasło
 * w APP_DATABASE_URL nie pasuje do roli (np. rozjazd web/worker); błąd połączenia rzuca.
 */
export async function appRoleLoginWorks(appUrl: string, timeoutMs = 5000): Promise<boolean> {
  return (await appRoleSession(checkedUrl(appUrl, 'APP_DATABASE_URL'), timeoutMs)) !== null
}

const ROLE_STATE_SQL = `SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypass,
  (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::int AS "memberOf"
  FROM pg_roles r WHERE r.rolname = $1`

export type AppRoleResult = 'bez-zmian' | 'ustawiono' | 'haslo-nie-pasuje'

/**
 * Krok instalacji (idempotentny): rola `logistyka_app` z migracji dostaje LOGIN i hasło z `APP_DATABASE_URL`.
 * Najpierw (właściciel z `DATABASE_URL`) sprawdza, że rola nie jest superuserem, nie ma BYPASSRLS i nie należy do
 * żadnej innej roli — inaczej odmowa od razu, a nie przy pierwszym zapytaniu firmy. Gdy logowanie działa — nic
 * nie zmienia. Inaczej robi `ALTER ROLE … LOGIN PASSWORD '<weryfikator SCRAM>'` i sprawdza logowanie jeszcze raz.
 * Na końcu porównuje bazę i serwer obu adresów.
 *
 * Jeden pisarz hasła: `tylkoSprawdz` (kontener workera) nigdy nie robi ALTER — przy niepasującym haśle zwraca
 * `haslo-nie-pasuje`, a wywołujący kończy start błędem. Hasło ustawia tylko web, więc rozjazd wartości web/worker
 * wychodzi przy wdrożeniu, zamiast przestawiać hasło przy każdym restarcie.
 */
export async function ensureAppRoleLogin(opts: { ownerUrl?: string; appUrl?: string; tylkoSprawdz?: boolean } = {}): Promise<AppRoleResult> {
  const appUrl = checkedUrl(opts.appUrl ?? process.env.APP_DATABASE_URL ?? '', 'APP_DATABASE_URL')
  const password = appRolePasswordOf(appUrl)
  const owner = new pg.Client({ connectionString: checkedUrl(opts.ownerUrl ?? process.env.DATABASE_URL ?? '', 'DATABASE_URL') })
  await owner.connect()
  try {
    const [role] = (await owner.query<{ superuser: boolean; bypass: boolean; memberOf: number }>(ROLE_STATE_SQL, [APP_ROLE])).rows
    if (!role) throw new Error(`Brak roli ${APP_ROLE} — najpierw prisma migrate deploy`)
    if (role.superuser || role.bypass || role.memberOf !== 0)
      throw new Error(`Rola ${APP_ROLE} bez izolacji (superuser: ${role.superuser}, BYPASSRLS: ${role.bypass}, należy do innych ról: ${role.memberOf}) — popraw rolę w bazie, start przerwany`)
    let result: AppRoleResult = 'bez-zmian'
    let session = await appRoleSession(appUrl)
    if (!session) {
      if (opts.tylkoSprawdz) return 'haslo-nie-pasuje'
      // ALTER ROLE nie przyjmuje parametrów $1; weryfikator to base64, `$` i `:` — literał i tak przez escapeLiteral
      await owner.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${owner.escapeLiteral(scramVerifier(password))}`)
      session = await appRoleSession(appUrl)
      if (!session) throw new Error(`Hasło roli ${APP_ROLE} ustawione, ale logowanie dalej odrzucone — sprawdź pg_hba.conf i adres w APP_DATABASE_URL`)
      result = 'ustawiono'
    }
    const [own] = (await owner.query<AppSession>(SERVER_ID_SQL)).rows
    if (own?.db !== session.db || own?.started !== session.started)
      throw new Error(`APP_DATABASE_URL wskazuje inną bazę albo inny serwer niż DATABASE_URL (baza ${session.db} zamiast ${own?.db ?? '?'}) — ustaw ten sam host, port i bazę`)
    return result
  } finally {
    await owner.end().catch(() => {})
  }
}

// ─── Klienci współdzieleni przez aplikację Next (lazy, żeby build nie wymagał bazy) ─────────────────

const globalForPrisma = globalThis as unknown as { prismaSystem?: PrismaClient; prismaOrgs?: Map<string, PrismaClient> }

export function systemPrisma(): PrismaClient {
  if (!globalForPrisma.prismaSystem) globalForPrisma.prismaSystem = createSystemClient({ poolMax: 3 })
  return globalForPrisma.prismaSystem
}

export function prismaForOrg(organizationId: string): PrismaClient {
  const map = (globalForPrisma.prismaOrgs ??= new Map())
  let db = map.get(organizationId)
  if (!db) {
    db = createOrgClient(organizationId, { poolMax: 5 })
    map.set(organizationId, db)
  }
  return db
}
