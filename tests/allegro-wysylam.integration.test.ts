// Wysyłam z Allegro na bazie, na atrapie HTTP (tests/allegro-wysylam-atrapa.ts). Jedna para tokenów dla
// `allegro.v1` i `allegro.wysylam.v1` na tym samym koncie (jedno odświeżenie pod blokadą hosta), integracja rodzaju
// „carrier” na koncie ALLEGRO, jawne błędy konfiguracji, komenda `allegro-wysylam-test` i `allegro-autoryzuj
// --z-przesylkami` (treść żądania bez flagi bez zmian). Zero prawdziwych wywołań; tokeny i dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { ALLEGRO_SECRETS as S } from '@/lib/adaptery/allegro'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { createAccountAdapter, loadChannelAccounts } from '@/lib/adaptery/konta'
import { hasOrderFeed } from '@/lib/adaptery/kontrakt'
import { AdapterConfigError } from '@/lib/adaptery/rejestr'
import { writeAccountSecrets } from '@/lib/adaptery/rotacja-sekretow'
import { resolveSecrets, setSecret } from '@/lib/sekrety'
import { createWysylamAdapter, wysylamAccount } from '@/lib/wysylka/allegro-konto'
import { authorizeAllegro } from '@/scripts/allegro-autoryzacja'
import { allegroWysylamTest } from '@/scripts/allegro-wysylam'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroWysylam, ORDERS_READ, UA } from './allegro-wysylam-atrapa'
import { testDb } from './db'
import { seedBase } from './rdzen-fixtures'

const db = testDb()
const db2 = testDb() // drugi „proces” (osobna pula połączeń)
afterAll(async () => {
  await db.$disconnect()
  await db2.$disconnect()
})

const T = new Date('2026-11-02T12:00:00.000Z')
const iso = (min: number) => new Date(T.getTime() + min * 60_000).toISOString()
const ENV = { APP_ENCRYPTION_KEY: '0'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const SCOPE = { channel: 'ALLEGRO' as const, channelAccountId: '71045' }

let fake: FakeAllegroWysylam

const account = async (d: PrismaClient = db) => (await loadChannelAccounts(d)).find((x) => x.channel === 'ALLEGRO' && x.channelAccountId === '71045')!

async function storeTokens(expiresAt: string) {
  const pair = fake.base.issuePair()
  await writeAccountSecrets(db, SCOPE, { [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: expiresAt }, ENV)
  return pair
}

beforeEach(async () => {
  const { truncateAll } = await import('./db')
  await truncateAll(db)
  await seedBase(db)
  // stare konto testowe „allegro” wyłączone, jak w tests/cien-allegro.integration.test.ts
  await db.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { active: false } })
  await db.channelConfig.create({ data: { channel: 'ALLEGRO', channelAccountId: '71045', name: 'Allegro', adapterKey: 'allegro.v1', config: { apiUrl: API, authUrl: AUTH, userAgent: UA, pollIntervalSec: 60 } } })
  await setSecret(db, S.clientId, FAKE_CLIENT_ID, ENV, SCOPE)
  await setSecret(db, S.clientSecret, FAKE_CLIENT_SECRET, ENV, SCOPE)
  fake = new FakeAllegroWysylam()
  fake.base.clock = () => T.getTime()
})

describe('jedna para tokenów na koncie', () => {
  it('allegro.v1 i allegro.wysylam.v1 z wygasłym tokenem: jedno odświeżenie, obie strony na nowej parze', async () => {
    const old = await storeTokens(iso(-1))
    fake.base.putForm({ id: 'f1', updatedAt: iso(-5), lines: [{ id: 'l1', offerId: '9001', qty: 1 }] })
    fake.base.tokenDelayMs = 300
    const kanal = await createAccountAdapter(db, defaultRegistry(), await account(db), SRC, { fetch: fake.fetch, now: () => T })
    if (!hasOrderFeed(kanal)) throw new Error('bez orders.feed')
    const wysylam = await createWysylamAdapter(db2, defaultRegistry(), await account(db2), SRC, { fetch: fake.fetch, now: () => T })
    const [o, t] = await Promise.all([kanal.getOrder('f1'), wysylam.testConnection()])
    expect(o?.externalId).toBe('f1')
    expect(t).toEqual({ ok: true, message: 'zakres przesyłek działa (odczyt przesyłek)' })
    expect(fake.base.tokenCalls).toBe(1)
    const s = await resolveSecrets(db, [S.access, S.refresh], SRC, SCOPE)
    expect(s[S.refresh]).not.toBe(old.refresh)
    expect(fake.base.validAccess.has(s[S.access]!)).toBe(true)
    expect(fake.nonGet()).toEqual([])
  })

  it('401 w adapterze przesyłek: odświeżenie zapisane w sekretach konta (zakres ALLEGRO/71045)', async () => {
    const old = await storeTokens(iso(600))
    fake.base.validAccess.delete(old.access)
    const w = await createWysylamAdapter(db, defaultRegistry(), '71045', SRC, { fetch: fake.fetch, now: () => T })
    expect((await w.testConnection()).ok).toBe(true)
    const s = await resolveSecrets(db, [S.access], SRC, SCOPE)
    expect(s[S.access]).not.toBe(old.access)
    expect(fake.base.validAccess.has(s[S.access]!)).toBe(true)
  })
})

describe('host konta', () => {
  it('integracja przewoźnika na koncie ALLEGRO: kind carrier, id ALLEGRO/<konto>, z kanałem i kontem', async () => {
    await storeTokens(iso(600))
    const w = await createWysylamAdapter(db, defaultRegistry(), null, SRC, { fetch: fake.fetch, now: () => T })
    expect(w.manifest.adapterKey).toBe('allegro.wysylam.v1')
    expect((w as unknown as { tokens: { ctx: { integration: unknown } } }).tokens.ctx.integration).toEqual({ organizationId: (await account()).organizationId, kind: 'carrier', id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO', channelAccountId: '71045' })
  })

  it('brak konta, kilka kont bez wskazania, brak tokenów = jawny błąd konfiguracji', async () => {
    await expect(wysylamAccount(db, '999')).rejects.toBeInstanceOf(AdapterConfigError)
    await db.channelConfig.create({ data: { channel: 'ALLEGRO', channelAccountId: '50000', name: 'Allegro 2', adapterKey: 'allegro.v1', config: { userAgent: UA } } })
    await expect(wysylamAccount(db)).rejects.toThrow(/2 aktywne konta ALLEGRO/)
    await db.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { active: false } })
    await expect(wysylamAccount(db)).rejects.toThrow(/nie ma aktywnego konta ALLEGRO/)
    await expect(createWysylamAdapter(db, defaultRegistry(), '71045', SRC, { fetch: fake.fetch })).rejects.toThrow(/brak sekretu ALLEGRO_ACCESS_TOKEN/)
    const woo = (await loadChannelAccounts(db)).find((a) => a.channel === 'WOO')!
    await expect(createWysylamAdapter(db, defaultRegistry(), woo, SRC, { fetch: fake.fetch })).rejects.toThrow(/tylko na koncie ALLEGRO/)
  })

  it('createAccountAdapter z kluczem przewoźnika na koncie kanału nadal odmawia (dlatego osobny host)', async () => {
    await storeTokens(iso(600))
    await expect(createAccountAdapter(db, defaultRegistry(), { ...(await account()), adapterKey: 'allegro.wysylam.v1' }, SRC, { fetch: fake.fetch })).rejects.toThrow(/rodzaju carrier/)
  })
})

async function capture(fn: () => Promise<number>) {
  const printed: string[] = []
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => (printed.push(String(c)), true)),
    ...(['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...xs: unknown[]) => void printed.push(xs.map(String).join(' ') + '\n'))),
  ]
  try {
    return { code: await fn(), printed: printed.join('') }
  } finally {
    for (const s of spies) s.mockRestore()
  }
}

describe('komenda allegro-wysylam-test', () => {
  it('OK: drukuje wynik testu, bez tokenów i sekretów', async () => {
    const pair = await storeTokens(iso(600))
    const { code, printed } = await capture(() => allegroWysylamTest(db, { channelAccountId: '71045', registry: defaultRegistry(), src: SRC, fetch: fake.fetch }))
    expect(code).toBe(0)
    expect(printed).toMatch(/allegro\.wysylam\.v1 \(ALLEGRO\/71045\): OK — zakres przesyłek działa/)
    for (const x of [pair.access, pair.refresh, FAKE_CLIENT_SECRET]) expect(printed).not.toContain(x)
  })

  it('brak zakresu: kod 1 i nazwa zakresu; brak konta: kod 2', async () => {
    await storeTokens(iso(600))
    fake.scopes = new Set([ORDERS_READ])
    const r = await capture(() => allegroWysylamTest(db, { registry: defaultRegistry(), src: SRC, fetch: fake.fetch }))
    expect(r.code).toBe(1)
    expect(r.printed).toMatch(/BŁĄD — .*allegro:api:shipments:read/)
    expect((await capture(() => allegroWysylamTest(db, { channelAccountId: '1', registry: defaultRegistry(), src: SRC, fetch: fake.fetch }))).code).toBe(2)
  })
})

describe('allegro-autoryzuj --z-przesylkami', () => {
  const run = (zPrzesylkami?: boolean, bodies: string[] = []) =>
    capture(() =>
      authorizeAllegro(db, {
        registry: defaultRegistry(),
        src: SRC,
        fetch: async (url, init) => {
          if (String(url).endsWith('/auth/oauth/device')) bodies.push(String(init?.body ?? ''))
          return fake.fetch(url, init)
        },
        wait: async () => {},
        ...(zPrzesylkami === undefined ? {} : { zPrzesylkami }),
      }),
    )

  it('bez flagi: treść żądania device dokładnie jak, tekst „tylko odczyt zamówień”', async () => {
    fake.base.deviceScript = ['ok']
    const bodies: string[] = []
    const { code, printed } = await run(undefined, bodies)
    expect(code).toBe(0)
    expect(bodies).toEqual([`client_id=${FAKE_CLIENT_ID}&scope=allegro%3Aapi%3Aorders%3Aread`])
    expect(printed).toContain('(tylko odczyt zamówień):')
    expect(printed).not.toMatch(/przesyłek|allegro-wysylam/)
  })

  it('z flagą: zakres orders:read + shipments:read (spacją), tekst o przesyłkach, test przesyłek; bez shipments:write', async () => {
    fake.base.deviceScript = ['ok']
    const bodies: string[] = []
    const { code, printed } = await run(true, bodies)
    expect(code).toBe(0)
    expect(fake.base.deviceCalls).toEqual([{ scope: 'allegro:api:orders:read allegro:api:shipments:read' }])
    expect(bodies.join('')).not.toContain('write')
    expect(printed).toContain('(tylko odczyt zamówień i odczyt przesyłek):')
    expect(printed).toMatch(/test połączenia: OK/)
    expect(printed).toMatch(/allegro-wysylam\].*OK — zakres przesyłek działa/)
    const s = await resolveSecrets(db, [S.access, S.refresh], SRC, SCOPE)
    for (const x of [s[S.access]!, s[S.refresh]!, 'atrapa-device-code-TAJNE', FAKE_CLIENT_SECRET]) expect(printed).not.toContain(x)
  })

  it('z flagą, ale bez zakresu przesyłek po stronie Allegro: kod 1', async () => {
    fake.base.deviceScript = ['ok']
    fake.scopes = new Set([ORDERS_READ])
    const { code, printed } = await run(true)
    expect(code).toBe(1)
    expect(printed).toMatch(/allegro-wysylam\].*BŁĄD/)
  })
})
