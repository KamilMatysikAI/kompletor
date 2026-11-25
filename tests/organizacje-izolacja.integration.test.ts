// izolacja firm. Firma A nie czyta ani nie zmienia danych firmy B (produkty, zamówienia, rezerwacje,
// kolejka zadań, propagacja, sekrety, alerty); zapytanie bez firmy nie widzi niczego; strażnik schematu i kodu.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertAdapterKey } from '@/lib/adaptery'
import { resolveAiCredential } from '@/lib/ai'
import { APP_ROLE, appRoleLoginWorks, createOrgClient, ensureAppRoleLogin, organizationIdOf, orgClientModeOf, verifyOrgClient } from '@/lib/db'
import { runFanout, runStockPush } from '@/lib/rdzen/propagacja'
import { alert, orderLockKey } from '@/lib/rdzen/stan'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { listSecrets, resolveSecrets, setSecret } from '@/lib/sekrety'
import { claimNext, enqueue } from '@/lib/worker/kolejka'
import { OrgClients, planSchedule, runNextJob, type WorkerDeps } from '@/lib/worker/petla'
import type { Handler } from '@/lib/worker/zadania'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { dropStaleTestRoles, TEST_FOREIGN_ROLE, testAppDbUrl, testDbUrl } from './global-setup'
import { ACC, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const ENV = { APP_ENCRYPTION_KEY: 'c'.repeat(64) }

describe('strażnik schematu: każda tabela danych pod RLS', () => {
  it('każda tabela ma organizationId (poza Organization i _prisma_migrations), RLS włączone i politykę firmy', async () => {
    const tables = await sys.$queryRaw<{ name: string; rls: boolean; hasOrg: boolean; policies: number }[]>`
      SELECT c.relname AS name, c.relrowsecurity AS rls,
             EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'organizationId') AS "hasOrg",
             (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::int AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations' ORDER BY 1`
    expect(tables.length).toBeGreaterThan(30)
    // Bez organizationId tylko tabele wspólne instalacji: Organization (polityka po id) i konta panelu User (
    // polityka „nikt” + brak praw roli aplikacji — test w tests/panel-dostep.integration.test.ts).
    const GLOBAL = new Set(['Organization', 'User'])
    const bad = tables.filter((t) => !t.rls || t.policies < 1 || (!GLOBAL.has(t.name) && !t.hasOrg))
    expect(bad).toEqual([])
    // treść polityki: dla wszystkich poleceń, USING i WITH CHECK po firmie z sesji (USING (true) by przeszło wyżej)
    const pol = await sys.$queryRaw<{ name: string; cmd: string; qual: string | null; check: string | null }[]>`
      SELECT tablename AS name, cmd, qual, with_check AS check FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`
    // konta i sesje panelu — rola aplikacji nie ma tu żadnych praw; polityka „nikt” sprawdzana ostrzej, nie słabiej
    // zaproszenia czyta osoba bez sesji firmy — jak konta i sesje, tylko kod systemowy (lib/auth/zaproszenia.ts)
    // reset hasła mailem czyta osoba bez sesji — jak zaproszenia, tylko kod systemowy (lib/auth/reset-hasla.ts)
    const NO_APP = new Set(['User', 'Session', 'Invitation', 'PasswordReset'])
    const weak = pol.filter((x) =>
      NO_APP.has(x.name)
        ? !(x.cmd === 'ALL' && x.qual === 'false' && x.check === 'false')
        : x.cmd !== 'ALL' || !x.qual?.includes('app.org_id') || !x.check?.includes('app.org_id'),
    )
    expect(weak).toEqual([])
    expect(pol.filter((x) => NO_APP.has(x.name)).map((x) => x.name).sort()).toEqual(['Invitation', 'PasswordReset', 'Session', 'User'])
    const grants = await sys.$queryRaw<{ t: string; p: string }[]>`
      SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
      WHERE grantee = ${APP_ROLE} AND table_schema = 'public' AND table_name IN ('User', 'Session', 'Invitation', 'PasswordReset')`
    expect(grants).toEqual([])
    expect(new Set(pol.map((x) => x.name)).size).toBe(tables.length)
    // dane klienta (szyfrogram) i ustawienia danych klientów — tabele firmowe pod tą samą polityką
    for (const t of ['OrderCustomer', 'CustomerDataSettings']) expect(tables.find((x) => x.name === t), t).toMatchObject({ rls: true, hasOrg: true, policies: 1 })
    // notatki wewnętrzne i płatności zapisane z karty zamówienia — tabele firmowe pod tą samą polityką
    for (const t of ['OrderNote', 'OrderPayment']) expect(tables.find((x) => x.name === t), t).toMatchObject({ rls: true, hasOrg: true, policies: 1 })
    // poczta (ustawienia, szablony, wysyłki) — tabele firmowe pod tą samą polityką
    for (const t of ['MailSettings', 'MailTemplate', 'MailDelivery']) expect(tables.find((x) => x.name === t), t).toMatchObject({ rls: true, hasOrg: true, policies: 1 })
    // strefy magazynu firmy
    expect(tables.find((x) => x.name === 'PackingZoneDef')).toMatchObject({ rls: true, hasOrg: true, policies: 1 })
    // logo firmy w bazie
    expect(tables.find((x) => x.name === 'OrganizationLogo')).toMatchObject({ rls: true, hasOrg: true, policies: 1 })
    // archiwum zamówień (historia do raportów rok do roku) — tabele firmowe pod tą samą polityką
    for (const t of ['ArchivedOrder', 'ArchivedOrderLine']) expect(tables.find((x) => x.name === t), t).toMatchObject({ rls: true, hasOrg: true, policies: 1 })
    // drzewo kategorii produktów firmy
    expect(tables.find((x) => x.name === 'ProductCategory')).toMatchObject({ rls: true, hasOrg: true, policies: 1 })
  })

  it(`rola ${APP_ROLE} nie omija RLS; klient firmy łączy się z izolacją`, async () => {
    const [r] = await sys.$queryRaw<{ super: boolean; bypass: boolean }[]>`SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = ${APP_ROLE}`
    expect(r).toEqual({ super: false, bypass: false })
    await expect(verifyOrgClient(a)).resolves.toBeUndefined()
    expect(organizationIdOf(a)).toBe(ORG_A)
    expect(() => organizationIdOf(sys)).toThrow(/klienta firmy/)
  })

  it('klient firmy, którego połączenie zgubiło parametr options (pooler) albo ma inną firmę, dostaje odmowę, nie dane', async () => {
    await product(a, 'A1', 5)
    await product(b, 'B1', 5)
    const app = testAppDbUrl()
    const lost = createOrgClient(ORG_A, { appConnectionString: app, poolMax: 1, testStartupOptions: '' })
    const other = createOrgClient(ORG_A, { appConnectionString: app, poolMax: 1, testStartupOptions: `-c app.org_id=${ORG_B}` })
    try {
      await expect(lost.product.count()).rejects.toThrow(/bez izolacji/)
      await expect(other.product.count()).rejects.toThrow(/bez izolacji/)
    } finally {
      await lost.$disconnect().catch(() => {})
      await other.$disconnect().catch(() => {})
    }
    expect(await a.product.count()).toBe(1) // poprawny klient dalej działa
  })

  it('tryb LOGIN wymaga session_user = logistyka_app — adres właściciela z -c role= dostaje odmowę', async () => {
    expect(orgClientModeOf(a)).toBe('login')
    // APP_DATABASE_URL omyłkowo z właścicielem bazy: current_user się zgadza (role=), sesja nie
    const owner = createOrgClient(ORG_A, { appConnectionString: testDbUrl(), poolMax: 1, testStartupOptions: `-c role=${APP_ROLE} -c app.org_id=${ORG_A}` })
    const ownerPlain = createOrgClient(ORG_A, { appConnectionString: testDbUrl(), poolMax: 1 })
    try {
      await expect(owner.product.count()).rejects.toThrow(/bez izolacji \(rola logistyka_app, sesja/)
      await expect(ownerPlain.product.count()).rejects.toThrow(/bez izolacji/)
    } finally {
      await owner.$disconnect().catch(() => {})
      await ownerPlain.$disconnect().catch(() => {})
    }
    const [r] = await a.$queryRaw<{ u: string; s: string }[]>`SELECT current_user AS u, session_user AS s`
    expect(r).toEqual({ u: APP_ROLE, s: APP_ROLE })
  })

  it('rola aplikacji należąca do innej roli (SET ROLE miałby dokąd przejść) = odmowa połączenia i odmowa kroku instalacji', async () => {
    await sys.$executeRawUnsafe(`DROP ROLE IF EXISTS ${TEST_FOREIGN_ROLE}`)
    await sys.$executeRawUnsafe(`CREATE ROLE ${TEST_FOREIGN_ROLE} NOLOGIN`)
    await sys.$executeRawUnsafe(`GRANT ${TEST_FOREIGN_ROLE} TO ${APP_ROLE}`)
    const c = testDb({ poolMax: 1 })
    try {
      await expect(c.product.count()).rejects.toThrow(/bez izolacji/)
      // krok instalacji (start kontenera) odmawia od razu, nie dopiero przy pierwszym zapytaniu firmy
      await expect(ensureAppRoleLogin({ ownerUrl: testDbUrl(), appUrl: testAppDbUrl() })).rejects.toThrow(/należy do innych ról: 1/)
      await expect(ensureAppRoleLogin({ ownerUrl: testDbUrl(), appUrl: testAppDbUrl(), tylkoSprawdz: true })).rejects.toThrow(/bez izolacji/)
    } finally {
      await c.$disconnect().catch(() => {})
      await sys.$executeRawUnsafe(`DROP ROLE ${TEST_FOREIGN_ROLE}`)
    }
    expect(await a.product.count()).toBe(0) // pula poprawnego klienta: połączenie sprzed zmiany, dalej działa
  })

  it('granica zaufania — po `SET ROLE NONE` sesja klienta firmy zostaje logistyka_app; bez przejścia na właściciela i bez DDL', async () => {
    const c = testDb({ poolMax: 1 })
    const owner = new URL(testDbUrl()).username
    try {
      await c.$executeRaw`SET ROLE NONE`
      const [r] = await c.$queryRaw<{ u: string; s: string }[]>`SELECT current_user AS u, session_user AS s`
      expect(r).toEqual({ u: APP_ROLE, s: APP_ROLE })
      await expect(c.$executeRawUnsafe(`SET SESSION AUTHORIZATION "${owner}"`)).rejects.toThrow(/permission denied|odmowa/i)
      await expect(c.$executeRawUnsafe(`SET ROLE "${owner}"`)).rejects.toThrow(/permission denied|odmowa/i)
      await expect(c.$executeRawUnsafe('CREATE TABLE "Obejscie" (id int)')).rejects.toThrow(/permission denied|odmowa/i)
      await expect(c.$executeRawUnsafe('ALTER TABLE "Product" DISABLE ROW LEVEL SECURITY')).rejects.toThrow(/owner|właściciel/i)
      await expect(c.$executeRawUnsafe('DROP POLICY IF EXISTS org_isolation ON "Product"')).rejects.toThrow(/owner|właściciel/i)
      const [after] = await c.$queryRaw<{ u: string }[]>`SELECT current_user AS u`
      expect(after!.u).toBe(APP_ROLE)
    } finally {
      await c.$disconnect()
    }
  })

  it('jedyna droga obejścia to zmiana app.org_id w sesji (dlatego strażnik kodu SESSION_ESCAPE niżej)', async () => {
    await product(b, 'B1', 5)
    const c = testDb({ poolMax: 1 })
    try {
      expect(await c.product.count()).toBe(0)
      await c.$executeRawUnsafe(`SET app.org_id = '${ORG_B}'`) // stan dokumentowany: zmiana firmy, rola dalej bez obejścia RLS
      expect(await c.product.count()).toBe(1)
      const [r] = await c.$queryRaw<{ u: string }[]>`SELECT current_user AS u`
      expect(r!.u).toBe(APP_ROLE)
    } finally {
      await c.$disconnect()
    }
  })

  it('połączenie bez firmy (rola aplikacji, brak app.org_id) nie widzi żadnego wiersza i nie może zapisać', async () => {
    await product(a, 'A1', 5)
    const c = new pg.Client({ connectionString: testAppDbUrl() })
    await c.connect()
    try {
      const r = await c.query('SELECT (SELECT count(*) FROM "Product")::int AS p, (SELECT count(*) FROM "Organization")::int AS o')
      expect(r.rows[0]).toEqual({ p: 0, o: 0 })
      await expect(c.query(`INSERT INTO "AuditLog" (id, entity, "entityId", "actorId") VALUES ('x', 'e', '1', 'a')`)).rejects.toThrow()
    } finally {
      await c.end()
    }
  })
})

describe('stary tryb -c role= (self-host bez APP_DATABASE_URL) i krok instalacji roli LOGIN', () => {
  afterEach(() => {
    delete process.env.APP_MODE
    vi.restoreAllMocks()
  })

  it('self-host bez adresu roli: działa z ostrzeżeniem, izolacja ta sama, ale SET ROLE NONE wraca do właściciela (dlatego hosting wymaga LOGIN)', async () => {
    await product(a, 'A1', 5)
    await product(b, 'B1', 5)
    const legacy = createOrgClient(ORG_A, { connectionString: testDbUrl(), poolMax: 1 })
    try {
      expect(orgClientModeOf(legacy)).toBe('role')
      await expect(verifyOrgClient(legacy)).resolves.toBeUndefined()
      expect(await legacy.product.count()).toBe(1)
      await legacy.$executeRaw`SET ROLE NONE`
      const [r] = await legacy.$queryRaw<{ u: string }[]>`SELECT current_user AS u`
      expect(r!.u).not.toBe(APP_ROLE)
    } finally {
      await legacy.$disconnect()
    }
  })

  it('APP_MODE=hosted bez adresu roli aplikacji = odmowa przy tworzeniu klienta firmy', () => {
    process.env.APP_MODE = 'hosted'
    expect(() => createOrgClient(ORG_A, { connectionString: testDbUrl() })).toThrow(/APP_DATABASE_URL/)
    const ok = createOrgClient(ORG_A, { appConnectionString: testAppDbUrl() })
    void ok.$disconnect() // pula bez połączeń, zamknięta dla porządku
  })

  it('APP_MODE spoza self-host/hosted (np. „Hosted”) = błąd, nie cichy self-host (jedno źródło appModeOf)', () => {
    process.env.APP_MODE = 'Hosted'
    expect(() => createOrgClient(ORG_A, { connectionString: testDbUrl() })).toThrow(/APP_MODE musi być/)
  })

  it('ensureAppRoleLogin: idempotentny; zmiana hasła w adresie = rotacja; zły użytkownik i krótkie hasło odrzucone', async () => {
    const ownerUrl = testDbUrl()
    const app = testAppDbUrl()
    expect(await ensureAppRoleLogin({ ownerUrl, appUrl: app })).toBe('bez-zmian')
    const rotated = new URL(app)
    rotated.password = 'nowe-haslo-testowe-0123456789'
    let restored: unknown
    try {
      expect(await ensureAppRoleLogin({ ownerUrl, appUrl: rotated.toString() })).toBe('ustawiono')
      const c = createOrgClient(ORG_A, { appConnectionString: rotated.toString(), poolMax: 1 })
      try {
        await expect(verifyOrgClient(c)).resolves.toBeUndefined()
      } finally {
        await c.$disconnect()
      }
      expect(await ensureAppRoleLogin({ ownerUrl, appUrl: rotated.toString() })).toBe('bez-zmian')
    } finally {
      // przywrócenie bez asercji w finally (błąd przywracania nie przykryje pierwotnego), asercja niżej
      restored = await ensureAppRoleLogin({ ownerUrl, appUrl: app }).catch((e: unknown) => e)
    }
    expect(restored).toBe('ustawiono')
    // hasło w bazie to weryfikator SCRAM, nie tekst jawny
    const [r] = await sys.$queryRaw<{ login: boolean; pass: string | null }[]>`SELECT rolcanlogin AS login, rolpassword AS pass FROM pg_authid WHERE rolname = ${APP_ROLE}`
    expect(r!.login).toBe(true)
    expect(r!.pass).toMatch(/^SCRAM-SHA-256\$4096:/)
    expect(r!.pass).not.toContain(new URL(app).password)
    const wrongUser = new URL(app)
    wrongUser.username = new URL(ownerUrl).username
    await expect(ensureAppRoleLogin({ ownerUrl, appUrl: wrongUser.toString() })).rejects.toThrow(/musi logować rolę/)
    const short = new URL(app)
    short.password = 'krotkie'
    await expect(ensureAppRoleLogin({ ownerUrl, appUrl: short.toString() })).rejects.toThrow(/za krótkie/)
  })

  it('tryb tylko-sprawdź (worker) nie zmienia hasła — inne hasło = „haslo-nie-pasuje”, hasło web dalej działa; /api/health widzi rozjazd', async () => {
    const ownerUrl = testDbUrl()
    const app = testAppDbUrl()
    const other = new URL(app)
    other.password = 'haslo-workera-inne-0123456789'
    const [before] = await sys.$queryRaw<{ pass: string }[]>`SELECT rolpassword AS pass FROM pg_authid WHERE rolname = ${APP_ROLE}`
    expect(await ensureAppRoleLogin({ ownerUrl, appUrl: other.toString(), tylkoSprawdz: true })).toBe('haslo-nie-pasuje')
    const [after] = await sys.$queryRaw<{ pass: string }[]>`SELECT rolpassword AS pass FROM pg_authid WHERE rolname = ${APP_ROLE}`
    expect(after!.pass).toBe(before!.pass) // bez ALTER ROLE
    expect(await ensureAppRoleLogin({ ownerUrl, appUrl: app, tylkoSprawdz: true })).toBe('bez-zmian')
    // /api/health: logowanie rolą aplikacji
    expect(await appRoleLoginWorks(app)).toBe(true)
    expect(await appRoleLoginWorks(other.toString())).toBe(false)
    const down = new URL(app)
    down.port = '1'
    await expect(appRoleLoginWorks(down.toString(), 2000)).rejects.toThrow()
  })

  it('APP_DATABASE_URL na inną bazę tego samego serwera niż DATABASE_URL = odmowa kroku instalacji', async () => {
    // baza `postgres` jest na każdym serwerze i PUBLIC ma do niej CONNECT; bez CREATE/DROP DATABASE (DROP ~20 s na wolumenie Dockera)
    const wrong = new URL(testAppDbUrl())
    wrong.pathname = '/postgres'
    await expect(ensureAppRoleLogin({ ownerUrl: testDbUrl(), appUrl: wrong.toString() })).rejects.toThrow(/inną bazę albo inny serwer niż DATABASE_URL \(baza postgres zamiast/)
    await expect(ensureAppRoleLogin({ ownerUrl: testDbUrl(), appUrl: wrong.toString(), tylkoSprawdz: true })).rejects.toThrow(/inną bazę albo inny serwer/)
  })

  it('domyślny adres roli testów tylko dla serwera na loopback; setup sprząta rolę-wabik po przerwanym przebiegu', async () => {
    const saved = { t: process.env.TEST_DATABASE_URL, a: process.env.TEST_APP_DATABASE_URL }
    try {
      delete process.env.TEST_APP_DATABASE_URL
      const remote = new URL(testDbUrl())
      remote.hostname = 'db.example.com'
      process.env.TEST_DATABASE_URL = remote.toString()
      expect(() => testAppDbUrl()).toThrow(/TEST_APP_DATABASE_URL/)
    } finally {
      process.env.TEST_DATABASE_URL = saved.t
      if (saved.a === undefined) delete process.env.TEST_APP_DATABASE_URL
      else process.env.TEST_APP_DATABASE_URL = saved.a
    }
    // rola zostawiona z grantem przez przerwany test członkostwa
    await sys.$executeRawUnsafe(`DROP ROLE IF EXISTS ${TEST_FOREIGN_ROLE}`)
    await sys.$executeRawUnsafe(`CREATE ROLE ${TEST_FOREIGN_ROLE} NOLOGIN`)
    await sys.$executeRawUnsafe(`GRANT ${TEST_FOREIGN_ROLE} TO ${APP_ROLE}`)
    const c = new pg.Client({ connectionString: testDbUrl() })
    await c.connect()
    try {
      await dropStaleTestRoles(c)
    } finally {
      await c.end()
    }
    const [r] = await sys.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${TEST_FOREIGN_ROLE}`
    expect(r!.n).toBe(0)
    expect(await ensureAppRoleLogin({ ownerUrl: testDbUrl(), appUrl: testAppDbUrl() })).toBe('bez-zmian')
  })
})

describe('firma A nie widzi i nie zmienia danych firmy B', () => {
  it('produkty: ten sam SKU w obu firmach; odczyt, zmiana i kasowanie cudzego id nic nie robią; zapis z cudzą firmą odrzucony', async () => {
    const pa = await product(a, 'WSPOLNY', 5)
    const pb = await product(b, 'WSPOLNY', 9)
    expect(await a.product.count()).toBe(1)
    expect(await a.product.findUnique({ where: { id: pb } })).toBeNull()
    expect((await a.product.updateMany({ where: { id: pb }, data: { title: 'przejęty' } })).count).toBe(0)
    expect((await a.stock.updateMany({ where: { productId: pb }, data: { reserved: 1 } })).count).toBe(0)
    expect((await a.product.deleteMany({ where: { id: pb } })).count).toBe(0)
    await expect(a.product.update({ where: { id: pb }, data: { title: 'x' } })).rejects.toThrow()
    const raw = await a.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Product" WHERE sku = 'WSPOLNY'`
    expect(raw[0]!.n).toBe(1)
    await expect(
      a.product.create({ data: { organizationId: ORG_B, sku: 'PODRZUT', kind: 'STOCKED', unit: 'SZT', nameAccounting: 'x', title: 'x' } }),
    ).rejects.toThrow()
    expect((await b.product.findUniqueOrThrow({ where: { id: pb } })).title).toBe('Towar testowy WSPOLNY')
    expect((await stockOf(b, pb)).reserved).toBe(0)
    expect(pa).not.toBe(pb)
  })

  it('zamówienia i rezerwacje: to samo zamówienie (kanał, konto, numer) w obu firmach rezerwuje tylko własny stan', async () => {
    const pa = await product(a, 'OST', 1)
    const pb = await product(b, 'OST', 1)
    const o = order([{ productId: pa, qty: 1 }], { externalId: 'TO-SAMO-1' })
    const ra = await ingestOrder(a, o, { now: T0 })
    const rb = await ingestOrder(b, { ...o, lines: [{ ...o.lines[0]!, productId: pb }] }, { now: T0 })
    expect(ra).toMatchObject({ outcome: 'NOWE', reservedUnits: 1, shortUnits: 0 })
    expect(rb).toMatchObject({ outcome: 'NOWE', reservedUnits: 1, shortUnits: 0 }) // bez DUPLIKAT: zdarzenie i zamówienie per firma
    expect(await a.order.count()).toBe(1)
    expect(await a.reservation.count()).toBe(1)
    expect((await stockOf(a, pa)).available).toBe(0)
    expect((await stockOf(b, pb)).available).toBe(0)
    // zamówienie firmy A z produktem firmy B: produkt „nie istnieje” → do wyjaśnienia, stan B nietknięty
    const cross = await ingestOrder(a, order([{ productId: pb, qty: 1 }]), { now: T0 })
    expect(cross.status).toBe('DO_WYJASNIENIA')
    expect((await stockOf(b, pb)).reserved).toBe(1)
    // klucz blokady zamówienia zawiera firmę: to samo zamówienie w dwóch firmach nie czeka na siebie
    const ka = orderLockKey({ organizationId: ORG_A, ...ACC.WOO_SD, externalId: 'TO-SAMO-1' })
    expect(ka).not.toBe(orderLockKey({ organizationId: ORG_B, ...ACC.WOO_SD, externalId: 'TO-SAMO-1' }))
  })

  it('propagacja: fanout i wysyłka firmy A liczą tylko jej oferty', async () => {
    const pa = await product(a, 'P', 10)
    const pb = await product(b, 'P', 10)
    await offer(a, 'WOO_SD', 'wa', pa)
    await offer(b, 'WOO_SD', 'wa', pb)
    await ingestOrder(b, order([{ productId: pb, qty: 3 }]), { now: T0 })
    expect((await runFanout(a, { now: T0 })).jobs).toBe(0) // zdarzenie stanu firmy B nie jest zdarzeniem firmy A
    expect((await runFanout(b, { now: T0 })).jobs).toBe(1)
    expect(await a.stockSyncJob.count()).toBe(0)
    const push = await runStockPush(a, ACC.WOO_SD, null, { now: new Date(T0.getTime() + 1000) })
    expect(push).toMatchObject({ shadow: 0, sent: 0 })
    expect(await sys.channelPushLog.count({ where: { organizationId: ORG_A } })).toBe(0)
  })

  it('alerty: ten sam klucz deduplikacji w dwóch firmach to dwie sprawy', async () => {
    await alert(a, 'TEST', 'r', 'wiadomość', 'klucz-1')
    await alert(a, 'TEST', 'r', 'wiadomość', 'klucz-1')
    await alert(b, 'TEST', 'r', 'wiadomość', 'klucz-1')
    expect(await a.alert.count()).toBe(1)
    expect(await sys.alert.count()).toBe(2)
  })

  it('sekrety: firma B nie odczyta sekretu A; lista bez wartości; szyfrogram bez tekstu jawnego', async () => {
    await setSecret(a, 'BASELINKER_TOKEN', 'token-firmy-a', ENV)
    expect(await resolveSecrets(b, ['BASELINKER_TOKEN'], { env: ENV, envFallback: false })).toEqual({})
    expect(await resolveSecrets(a, ['BASELINKER_TOKEN'], { env: ENV, envFallback: false })).toEqual({ BASELINKER_TOKEN: 'token-firmy-a' })
    const list = await listSecrets(a)
    expect(list.map((s) => Object.keys(s).sort())).toEqual([['channel', 'channelAccountId', 'keyVersion', 'name', 'updatedAt']])
    const row = await sys.integrationSecret.findFirstOrThrow()
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('token-firmy-a')
    // przeniesienie szyfrogramu do firmy B (np. ręczna kopia w bazie) nie daje odczytu
    await sys.integrationSecret.create({ data: { organizationId: ORG_B, name: 'BASELINKER_TOKEN', ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag } })
    await expect(resolveSecrets(b, ['BASELINKER_TOKEN'], { env: ENV, envFallback: false })).rejects.toThrow(/Nie da się odszyfrować/)
    // fallback env tylko, gdy dozwolony (self-host jednofirmowy), i nigdy nie przykrywa sekretu z bazy
    expect(await resolveSecrets(b, ['WFIRMA_APP_KEY'], { env: { WFIRMA_APP_KEY: 'z-env' }, envFallback: false })).toEqual({})
    expect(await resolveSecrets(b, ['WFIRMA_APP_KEY'], { env: { WFIRMA_APP_KEY: 'z-env' }, envFallback: true })).toEqual({ WFIRMA_APP_KEY: 'z-env' })
    expect(await resolveSecrets(a, ['BASELINKER_TOKEN'], { env: { ...ENV, BASELINKER_TOKEN: 'z-env' }, envFallback: true })).toEqual({ BASELINKER_TOKEN: 'token-firmy-a' })
  })
})

describe('sekrety kont kanałów i klucze adapterów (porównanie z OpenLinkerem 25.10)', () => {
  it('dwa sklepy Woo jednej firmy mają osobne klucze; sekret konta nie myli się z firmowym ani z drugim kontem', async () => {
    await setSecret(a, 'WOO_CONSUMER_KEY', 'klucz-sd', ENV, ACC.WOO_SD)
    await setSecret(a, 'WOO_CONSUMER_KEY', 'klucz-lampy', ENV, ACC.WOO_LAMPY)
    await setSecret(a, 'WOO_CONSUMER_KEY', 'klucz-sd-2', ENV, ACC.WOO_SD) // nadpisanie, nie dubel
    const src = { env: { ...ENV, WOO_CONSUMER_KEY: 'z-env' }, envFallback: true }
    expect(await resolveSecrets(a, ['WOO_CONSUMER_KEY'], src, ACC.WOO_SD)).toEqual({ WOO_CONSUMER_KEY: 'klucz-sd-2' })
    expect(await resolveSecrets(a, ['WOO_CONSUMER_KEY'], src, ACC.WOO_LAMPY)).toEqual({ WOO_CONSUMER_KEY: 'klucz-lampy' })
    expect(await resolveSecrets(a, ['WOO_CONSUMER_KEY'], src, ACC.WOO_KOLOROWYKUBEK)).toEqual({}) // konto bez klucza: env nie zgaduje sklepu
    expect(await resolveSecrets(a, ['WOO_CONSUMER_KEY'], src)).toEqual({ WOO_CONSUMER_KEY: 'z-env' }) // firmowy z env
    expect(await sys.integrationSecret.count({ where: { organizationId: ORG_A } })).toBe(2)
    // szyfrogram konta SD przełożony na konto Lampy nie odszyfruje się (AAD z kontem)
    const sd = await sys.integrationSecret.findFirstOrThrow({ where: { channelAccountId: 'sd' } })
    await sys.integrationSecret.update({ where: { id: sd.id }, data: { channelAccountId: 'km' } })
    await expect(resolveSecrets(a, ['WOO_CONSUMER_KEY'], src, ACC.WOO_KOLOROWYKUBEK)).rejects.toThrow(/Nie da się odszyfrować/)
    // konto spoza konfiguracji firmy → odmowa; firmowy sekret o tej nazwie jeden (indeks częściowy)
    await expect(setSecret(a, 'WOO_CONSUMER_KEY', 'x', ENV, { channel: 'WOO', channelAccountId: 'nie-ma' })).rejects.toThrow(/Nie ma konta/)
    await setSecret(a, 'BASELINKER_TOKEN', 't1', ENV)
    await expect(sys.integrationSecret.create({ data: { organizationId: ORG_A, name: 'BASELINKER_TOKEN', ciphertext: sd.ciphertext, iv: sd.iv, authTag: sd.authTag } })).rejects.toThrow()
  })

  it('konto kanału i reguła przewoźnika niosą klucz adaptera jako tekst; zły klucz odrzucony', async () => {
    const cfg = await a.channelConfig.findMany({ orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }] })
    expect(cfg.every((c) => /\.v[0-9]+$/.test(c.adapterKey))).toBe(true)
    expect(cfg.find((c) => c.channelAccountId === 'sd')!.adapterKey).toBe('woo.rest.v1')
    const rules = await a.carrierRule.findMany({ orderBy: { priority: 'asc' } })
    expect(rules.map((r) => r.adapterKey)).toEqual(['allegro.wysylam.v1', 'basecourier.v1', 'basecourier.v1', 'basecourier.v1', null])
    expect(() => assertAdapterKey('WOO_SD')).toThrow()
    expect(() => assertAdapterKey('nowy.przewoznik.v2')).not.toThrow() // nowy adapter = tekst, bez migracji enuma
  })
})

describe('AI jako integracja (decyzja 25.10): klucz firmy, platformy albo env; zużycie per firma', () => {
  it('klucz konta AI firmy wygrywa; hosting bez klucza → klucz platformy rozliczany z salda; self-host → env', async () => {
    await a.channelConfig.create({ data: { channel: 'AI', channelAccountId: 'domyslny', name: 'AI', adapterKey: 'ai.anthropic.v1', config: { model: 'test-model', maxTokens: 1000 } } })
    await b.channelConfig.create({ data: { channel: 'AI', channelAccountId: 'domyslny', name: 'AI', adapterKey: 'ai.anthropic.v1' } })
    const hosted = { ...ENV, APP_MODE: 'hosted', PLATFORM_AI_API_KEY: 'klucz-platformy', AI_API_KEY: 'z-env' }
    expect(await resolveAiCredential(b, 'domyslny', { env: hosted, envFallback: false })).toEqual({ apiKey: 'klucz-platformy', source: 'platforma', billedToBalance: true })
    await setSecret(a, 'AI_API_KEY', 'klucz-klienta-a', ENV, { channel: 'AI', channelAccountId: 'domyslny' })
    expect(await resolveAiCredential(a, 'domyslny', { env: hosted, envFallback: false })).toEqual({ apiKey: 'klucz-klienta-a', source: 'firma', billedToBalance: false })
    expect(await resolveAiCredential(b, 'domyslny', { env: { ...ENV, AI_API_KEY: 'z-env' }, envFallback: true })).toEqual({ apiKey: 'z-env', source: 'env', billedToBalance: false })
    expect(await resolveAiCredential(b, 'domyslny', { env: { ...ENV, APP_MODE: 'hosted' }, envFallback: false })).toBeNull()
    await a.aiUsage.create({ data: { feature: 'test', model: 'test-model', inputTokens: 10, outputTokens: 5, costGrosze: 1 } })
    expect(await b.aiUsage.count()).toBe(0)
    expect(await sys.aiUsage.findFirstOrThrow()).toMatchObject({ organizationId: ORG_A })
  })
})

describe('kolejka i worker: zadania niosą firmę, awaria jednej firmy nie zatrzymuje drugiej', () => {
  it('dedupeKey w obrębie firmy; klient firmy pobiera tylko swoje zadania', async () => {
    expect(await enqueue(a, 'x', null, { dedupeKey: 'harmonogram:x' })).not.toBeNull()
    expect(await enqueue(b, 'x', null, { dedupeKey: 'harmonogram:x' })).not.toBeNull()
    expect(await enqueue(a, 'x', null, { dedupeKey: 'harmonogram:x' })).toBeNull()
    const ja = await claimNext(a, 'w')
    expect(ja).toMatchObject({ organizationId: ORG_A })
    expect(await claimNext(a, 'w')).toBeNull() // zadanie B niewidoczne dla A
    expect(await claimNext(sys, 'w')).toMatchObject({ organizationId: ORG_B })
  })

  it('handler dostaje klienta firmy zadania; błąd firmy A → FAILED tylko u A, B zrobione; harmonogram per firma', async () => {
    const seen: string[] = []
    const handlers: Record<string, Handler> = {
      licz: async (db, _p, ctx) => {
        seen.push(`${ctx.organizationId}:${await db.product.count()}`)
        if (ctx.organizationId === ORG_A) throw new Error('awaria firmy A')
      },
    }
    await product(b, 'B1', 1)
    const orgs = new OrgClients({ appConnectionString: testAppDbUrl() })
    const deps: WorkerDeps = { system: sys, orgs, handlers, env: {}, workerId: 'test' }
    const list = [
      { id: ORG_A, slug: 'test-a', name: 'A' },
      { id: ORG_B, slug: 'test-b', name: 'B' },
    ]
    try {
      const plan = await planSchedule(deps, list, [{ kind: 'licz', everyMs: 1000 }], new Map(), 10_000)
      expect(plan).toEqual({ planned: 2, errors: [] })
      const outs = [await runNextJob(deps, list), await runNextJob(deps, list), await runNextJob(deps, list)]
      expect(outs.map((o) => `${o.kind}${'organizationId' in o ? `:${o.organizationId}` : ''}`).sort()).toEqual(['FAILED:test_a', 'NONE', 'DONE:test_b'].sort())
      expect(seen.sort()).toEqual([`${ORG_A}:0`, `${ORG_B}:1`]) // każda firma widzi tylko swoje produkty
      const jobs = await sys.job.findMany({ orderBy: { organizationId: 'asc' } })
      expect(jobs.map((j) => [j.organizationId, j.status, j.lastError])).toEqual([
        [ORG_A, 'FAILED', 'awaria firmy A'],
        [ORG_B, 'DONE', null],
      ])
      // firma aktywna spoza listy workera (np. założona przed chwilą) → świeży odczyt listy i wykonanie
      await enqueue(a, 'licz', null, { maxAttempts: 1 })
      expect(await runNextJob(deps, list.filter((o) => o.id !== ORG_A))).toMatchObject({ kind: 'FAILED', organizationId: ORG_A, error: 'awaria firmy A' })
      expect(seen).toHaveLength(3)
      // zadanie firmy wyłączonej nie jest brane — czeka (PENDING, bez zużytej próby) na jej włączenie
      await sys.organization.update({ where: { id: ORG_B }, data: { active: false } })
      const idB = await enqueue(b, 'licz', null, { maxAttempts: 1 })
      expect(await runNextJob(deps, list)).toEqual({ kind: 'NONE' })
      expect(await sys.job.findUniqueOrThrow({ where: { id: idB! } })).toMatchObject({ status: 'PENDING', attempts: 0 })
      await sys.organization.update({ where: { id: ORG_B }, data: { active: true } })
    } finally {
      await orgs.closeAll()
    }
  })

  it('fallback kluczy z env liczy wszystkie aktywne firmy, nie te z listy workera', async () => {
    const fallback: boolean[] = []
    const orgs = new OrgClients({ appConnectionString: testAppDbUrl() })
    const deps: WorkerDeps = { system: sys, orgs, handlers: { env: async (_db, _p, ctx) => void fallback.push(ctx.secrets.envFallback) }, env: {}, workerId: 'test' }
    try {
      await enqueue(a, 'env', null, { maxAttempts: 1 })
      // lista workera ma jedną firmę (druga np. nie przeszła weryfikacji), w bazie aktywne są dwie → bez kluczy z env
      await runNextJob(deps, [{ id: ORG_A, slug: 'test-a', name: 'A' }])
      expect(fallback).toEqual([false])
      // jedyna aktywna firma w bazie (druga wyłączona) → self-host może brać klucze z env
      await sys.organization.update({ where: { id: ORG_B }, data: { active: false } })
      await enqueue(a, 'env', null, { maxAttempts: 1 })
      await runNextJob(deps, [{ id: ORG_A, slug: 'test-a', name: 'A' }])
      expect(fallback).toEqual([false, true])
    } finally {
      await sys.organization.update({ where: { id: ORG_B }, data: { active: true } })
      await orgs.closeAll()
    }
  })
})

describe('strażnik kodu: klient systemowy tylko w kodzie systemowym', () => {
  const ROOT = path.resolve(__dirname, '..')
  // Klient bez firmy (omija RLS) wolno tworzyć tylko tutaj. Nowe miejsce = świadoma decyzja i wpis na tę listę.
  const SYSTEM_CLIENT_ALLOWED = new Set([
    'lib/db.ts',
    'worker/index.ts',
    'scripts/org.ts',
    'scripts/sekret.ts',
    'scripts/konto-kanalu.ts', // konto kanału (CLI), jak sekret.ts — firma po slugu, dalej klient firmy
    'scripts/import-katalogu.ts',
    'scripts/przelicz-zamowienia.ts', // tylko wybór firmy (--firma); przeliczenie klientem firmy, jak import-katalogu.ts
    'scripts/przeprowadzka.ts', // wybór firmy po slugu (jak import katalogu); zapis klientem firmy
    'scripts/cien.ts',
    'scripts/ksef.ts', // tylko wybór firmy (--firma); szkice składa klient firmy
    'scripts/klienci.ts', // tylko wybór firmy (--firma / --wszystkie-firmy); dane klientów czyta klient firmy
    'scripts/smoke-worker.ts',
    'app/akcje.ts', // logowanie, wylogowanie, przełączenie firmy (tabele User/Session)
    'lib/panel/kontekst.ts', // odczyt sesji; ekranom oddaje tylko klienta firmy z sesji
    'scripts/uzytkownik.ts', // konta panelu (CLI)
    'scripts/demo-panel.ts', // firma demonstracyjna na lokalnej bazie
    'app/api/health/route.ts',
    'lib/panel/uzytkownicy.ts', // Ustawienia → Użytkownicy i zmiana hasła (tabele User/Session), zawsze z firmą sesji
    'lib/api/klucze.ts', // odnalezienie klucza API po skrócie (firma jeszcze nieznana); dalej klient firmy klucza
    'lib/druk/tokeny.ts', // odnalezienie stanowiska druku po skrócie tokenu (firma nieznana); dalej klient firmy tokenu
    'lib/instalacja/kreator.ts', // kreator /start (zero kont, kod instalacji), firma i pierwszy właściciel
    // reset hasła mailem (tabela PasswordReset z polityką „nikt”, jak Invitation): worker czyta prośbę po id
    // w firmie zadania, a strona /nowe-haslo sprawdza link po skrócie tokenu (osoba bez sesji)
    'lib/poczta/zadanie.ts',
    'app/nowe-haslo/page.tsx',
  ])
  const files: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)) files.push(path.relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  for (const d of ['lib', 'app', 'worker', 'scripts', 'seed']) walk(path.join(ROOT, d))

  it('createSystemClient / systemPrisma tylko w plikach z listy', () => {
    const offenders = files.filter((f) => !SYSTEM_CLIENT_ALLOWED.has(f) && /\b(createSystemClient|systemPrisma)\s*\(/.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  // P7: sterownik pg (połączenia z pominięciem weryfikacji izolacji) tylko w lib/db.ts
  it("import 'pg' tylko w lib/db.ts", () => {
    const PG_IMPORT = /\bfrom\s+['"]pg['"]|\brequire\(\s*['"]pg['"]\s*\)|\bimport\(\s*['"]pg['"]\s*\)/
    const offenders = files.filter((f) => f !== 'lib/db.ts' && PG_IMPORT.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
    expect(PG_IMPORT.test("import pg from 'pg'")).toBe(true)
    expect(PG_IMPORT.test('import { Client } from "pg"')).toBe(true)
    expect(PG_IMPORT.test("import pg from 'pg-boss'")).toBe(false)
  })

  it('bez $queryRawUnsafe / $executeRawUnsafe w kodzie aplikacji (surowe SQL tylko jako szablon z parametrami)', () => {
    const offenders = files.filter((f) => /\$(queryRawUnsafe|executeRawUnsafe)\b/.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  // sesja klienta firmy startuje jako właściciel i przechodzi na rolę aplikacji, więc
  // izolacja trzyma się na tym, że kod nie zmienia roli ani ustawienia firmy w sesji. Komentarze nie są kodem.
  // SET [LOCAL|SESSION] ROLE / SESSION AUTHORIZATION / app.org_id (zwykłe GUC — jedyna droga obejścia),
  // RESET tych samych i ALL, DISCARD, set_config, Prisma.raw/sql (P1)
  const SESSION_ESCAPE =
    /\b(set_config|SET\s+(LOCAL\s+|SESSION\s+)?(ROLE|SESSION\s+AUTHORIZATION|app\.org_id)|RESET\s+(ROLE|ALL|SESSION\s+AUTHORIZATION|app\.org_id)|DISCARD|Prisma\.raw|Prisma\.sql)\b/i
  // fragment SQL rozłączności archiwum (Prisma.raw ze stałych modułu i aliasu sprawdzanego regexem; bez
  // poleceń sesji, pilnuje tego lib/archiwum/rozlacznosc.test.ts)
  const SESSION_ESCAPE_ALLOWED = new Set<string>(['lib/archiwum/rozlacznosc.ts'])
  // ALTER / CREATE / DROP ROLE tylko w kroku instalacji w lib/db.ts
  const ROLE_DDL = /\b(ALTER|CREATE|DROP)\s+(ROLE|USER)\b/i
  const ROLE_DDL_ALLOWED = new Set<string>(['lib/db.ts'])
  it('ALTER / CREATE / DROP ROLE tylko w kroku instalacji (lib/db.ts)', () => {
    const offenders = files.filter((f) => !ROLE_DDL_ALLOWED.has(f) && ROLE_DDL.test(stripComments(readFileSync(path.join(ROOT, f), 'utf8'))))
    expect(offenders).toEqual([])
    expect(ROLE_DDL.test('await db.$executeRaw`ALTER ROLE logistyka_app PASSWORD ${x}`')).toBe(true)
    expect(ROLE_DDL.test('ALTER TABLE "Product"')).toBe(false)
  })
  // tylko komentarze blokowe i komentarze zaczynające linię (P2: `//` wewnątrz szablonu SQL nie może ukryć reszty linii)
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it('bez zmiany roli i firmy w sesji (set_config, SET ROLE, RESET, SET SESSION AUTHORIZATION, DISCARD, Prisma.raw/sql)', () => {
    const offenders = files.filter((f) => !SESSION_ESCAPE_ALLOWED.has(f) && SESSION_ESCAPE.test(stripComments(readFileSync(path.join(ROOT, f), 'utf8'))))
    expect(offenders).toEqual([])
    expect(SESSION_ESCAPE.test("await db.$executeRaw`SELECT set_config('app.org_id', 'x', false)`")).toBe(true)
    expect(SESSION_ESCAPE.test('await db.$executeRaw`RESET ALL`')).toBe(true)
    expect(SESSION_ESCAPE.test("await db.$executeRaw`SET app.org_id = 'x'`")).toBe(true)
    expect(SESSION_ESCAPE.test('await tx.$executeRaw`SET LOCAL ROLE NONE`')).toBe(true)
    expect(SESSION_ESCAPE.test('await db.$executeRaw`SET SESSION ROLE NONE`')).toBe(true)
    expect(SESSION_ESCAPE.test(stripComments("await db.$executeRaw`SELECT 'a//b'; SET ROLE NONE`"))).toBe(true)
  })
})
