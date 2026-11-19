// /api/health bez hasła bierze wynik zapytań bazy z bufora 5 s (cachedCheck), z hasłem Basic Auth
// czyta na świeżo. Awaria bazy = 503 najpóźniej po 5 s; ciało odpowiedzi bez zmian.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetShadowHealthCache } from '@/lib/cien/stan-odczytu'
import { testSystemDb } from './db'

const sys = testSystemDb()
const g = globalThis as unknown as { prismaSystem?: unknown }
const T0 = Date.parse('2026-11-01T10:00:00Z')

/** Klient „po awarii bazy”: każde zapytanie odrzucone, a licznik pokazuje, ile razy health pytał. */
function deadDb() {
  const calls = { n: 0 }
  const fail = () => {
    calls.n++
    return Promise.reject(new Error('baza nie odpowiada'))
  }
  const client = { $queryRaw: fail, job: { aggregate: fail, count: fail } }
  return { client, calls }
}

describe('/api/health: bufor zapytań bazy dla żądań bez hasła', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    vi.stubEnv('APP_DATABASE_URL', '') // bez logowania rolą aplikacji: test dotyczy tylko bufora zapytań
    vi.stubEnv('CIEN_ODCZYT', '0')
    vi.stubEnv('BASIC_AUTH_USER', 'jan')
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'haslo-testowe')
    resetShadowHealthCache()
    g.prismaSystem = sys
  })
  afterEach(() => {
    delete g.prismaSystem
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('awaria bazy: bez hasła 200 z bufora do 5 s, potem 503; z hasłem 503 od razu; kształt pól bez zmian', async () => {
    vi.resetModules() // świeży moduł = pusty bufor, a cachedCheck bierze sztuczny zegar
    const { GET } = await import('@/app/api/health/route')
    const anon = () => GET(new Request('http://x/api/health'))
    const auth = () => GET(new Request('http://x/api/health', { headers: { authorization: 'Basic ' + Buffer.from('jan:haslo-testowe').toString('base64') } }))

    let res = await anon()
    expect(res.status).toBe(200)
    const body = await res.json()
    for (const k of ['status', 'ok', 'migrations', 'sha', 'cien', 'appRole', 'secretsKey']) expect(body, k).toHaveProperty(k)
    expect(body).toMatchObject({ db: 'ok', appRole: 'off', migrations: { pending: 0, failed: 0 } })

    const dead = deadDb()
    g.prismaSystem = dead.client
    vi.setSystemTime(T0 + 4_999)
    res = await anon()
    expect(res.status).toBe(200) // z bufora
    expect(dead.calls.n).toBe(0) // częste żądania bez hasła nie pytają bazy

    res = await auth()
    expect(res.status).toBe(503) // z hasłem: na świeżo
    expect(dead.calls.n).toBe(1)

    vi.setSystemTime(T0 + 5_000)
    res = await anon()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, status: 'error', db: 'error' })
    const after = dead.calls.n
    await anon()
    await anon()
    expect(dead.calls.n).toBe(after) // wynik nieudany też z bufora

    // baza wraca: najpóźniej po 5 s znów 200
    g.prismaSystem = sys
    vi.setSystemTime(T0 + 10_000)
    expect((await anon()).status).toBe(200)
  })
})
