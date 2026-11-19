// /api/health w APP_MODE=hosted bez autoryzacji = okrojone ciało; z tokenem
// HEALTH_TOKEN (Bearer) albo Basic Auth = pełne; self-host bez zmian. Baza i cień podstawione (test jednostkowy).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeDb = {
  $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
    String(strings[0]).includes('_prisma_migrations') ? [{ name: '20260101000000_start', finished: true, rolledBack: false }] : [1],
  ),
  job: {
    aggregate: vi.fn(async () => ({ _max: { updatedAt: new Date('2026-11-10T10:00:00Z') } })),
    count: vi.fn(async () => 2),
  },
}

vi.mock('@/lib/db', () => ({
  systemPrisma: () => fakeDb,
  appRoleLoginWorks: vi.fn(async () => true),
}))

vi.mock('@/lib/cien/stan-odczytu', () => ({
  shadowEnabled: () => true,
  shadowReadingForHealth: vi.fn(async () => ({
    enabled: true,
    status: 'ok',
    accounts: 4,
    notReading: 0,
    openAlerts: 0,
    withoutAdapter: 0,
    details: [],
  })),
}))

vi.mock('@/lib/sekrety', () => ({
  encryptionKeysStatus: () => ({ status: 'ok', ring: null }),
  keyCoverage: () => ({ status: 'ok' }),
  secretKeyVersionsInDb: async () => [],
}))

const TOKEN = 'a'.repeat(64)
const PUBLIC_KEYS = ['ok', 'status', 'sha', 'appMode', 'db', 'appRole', 'secretsKey', 'migrations', 'time'].sort()

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import('./route')
  const res = await GET(new Request('http://x/api/health', { headers }))
  return { res, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('BUILD_SHA', '0123456789abcdef')
  vi.stubEnv('APP_DATABASE_URL', 'postgres://app@localhost/x')
  vi.stubEnv('BASIC_AUTH_USER', '')
  vi.stubEnv('BASIC_AUTH_PASSWORD', '')
  vi.stubEnv('HEALTH_TOKEN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('/api/health w hostingu (APP_MODE=hosted)', () => {
  beforeEach(() => vi.stubEnv('APP_MODE', 'hosted'))

  it('bez autoryzacji: tylko pola dla monitoringu i wdrożenia, bez wersji, kolejki, cienia i nazwy migracji', async () => {
    vi.stubEnv('HEALTH_TOKEN', TOKEN)
    const { res, body } = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS)
    // status `degraded`: migracje z katalogu repo, których podstawiona baza „nie ma” (pending > 0)
    expect(body).toMatchObject({ ok: false, status: 'degraded', sha: '0123456789ab', appMode: 'hosted', db: 'ok', appRole: 'ok', secretsKey: 'ok' })
    expect(body.migrations).toEqual({ pending: expect.any(Number), failed: 0 })
    for (const k of ['version', 'queue', 'cien']) expect(body).not.toHaveProperty(k)
    expect(JSON.stringify(body)).not.toContain('20260101000000_start')
  })

  it('zły token, inny schemat albo brak HEALTH_TOKEN w env: dalej okrojone', async () => {
    vi.stubEnv('HEALTH_TOKEN', TOKEN)
    for (const h of [`Bearer ${'b'.repeat(64)}`, `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN, 'Bearer ']) {
      const { body } = await call({ authorization: h })
      expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS)
    }
    vi.stubEnv('HEALTH_TOKEN', '')
    const { body } = await call({ authorization: 'Bearer ' })
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS)
  })

  it('z poprawnym tokenem (Bearer): pełna odpowiedź z wersją, kolejką, licznikami cienia i ostatnią migracją', async () => {
    vi.stubEnv('HEALTH_TOKEN', TOKEN)
    const { res, body } = await call({ authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
    expect(body).toHaveProperty('version')
    expect(body.queue).toEqual({ lastActivity: '2026-11-10T10:00:00.000Z', failedLastHour: 2 })
    expect(body.cien).toMatchObject({ enabled: true, status: 'ok', accounts: 4, notReading: 0, details: [] })
    expect(body.migrations).toMatchObject({ last: '20260101000000_start', failed: 0 })
  })
})

describe('/api/health: APP_MODE spoza self-host (literówka) traktowane jak hosting', () => {
  it('„Hosted” bez autoryzacji = okrojone ciało', async () => {
    vi.stubEnv('APP_MODE', 'Hosted')
    const { body } = await call()
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS)
  })
})

describe('/api/health w self-hoście: bez zmian', () => {
  it('bez autoryzacji: pełne ciało jak dotąd (wersja, kolejka, liczniki cienia, ostatnia migracja)', async () => {
    vi.stubEnv('APP_MODE', '')
    const { body } = await call()
    expect(body.appMode).toBe('self-host')
    for (const k of ['version', 'queue', 'cien']) expect(body).toHaveProperty(k)
    expect(body.migrations).toHaveProperty('last', '20260101000000_start')
    // szczegóły kont cienia nadal tylko z autoryzacją
    expect(body.cien).not.toHaveProperty('details')
  })
})
