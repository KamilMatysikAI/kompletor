// Device flow Allegro na atrapie: pending → slow_down → sukces, odmowa, wygaśnięcie; wyjście bez
// tokenów, `device_code` i Client Secret. Zapis do bazy: tests/cien-allegro.integration.test.ts.
import { describe, expect, it } from 'vitest'
import { AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegro, UA } from '@/tests/allegro-atrapa'
import { allegroScope, runDeviceFlow } from './allegro-autoryzacja'

function setup(script: string[]) {
  const fake = new FakeAllegro()
  fake.deviceScript = script
  const lines: string[] = []
  const waits: number[] = []
  let t = 0
  const deps = {
    oauth: { authUrl: AUTH, clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, userAgent: UA, fetch: fake.fetch },
    scope: 'allegro:api:orders:read',
    out: (l: string) => lines.push(l),
    wait: async (ms: number) => {
      waits.push(ms)
      t += ms + 1000
    },
    now: () => t,
  }
  return { fake, lines, waits, deps }
}

describe('zakres autoryzacji', () => {
  it('bez flag jak wcześniej; --z-przesylkami i --z-ofertami dokładają swoje zakresy', () => {
    expect(allegroScope()).toBe('allegro:api:orders:read')
    expect(allegroScope(true)).toBe('allegro:api:orders:read allegro:api:shipments:read')
    expect(allegroScope(false, true)).toBe('allegro:api:orders:read allegro:api:sale:offers:read')
    expect(allegroScope(true, true)).toBe('allegro:api:orders:read allegro:api:shipments:read allegro:api:sale:offers:read')
  })

  it('właściciel konta widzi, o co prosimy: odczyt zamówień, przesyłek i ofert', async () => {
    const x = setup(['ok'])
    x.deps.scope = allegroScope(true, true)
    expect((await runDeviceFlow(x.deps)).ok).toBe(true)
    expect(x.fake.deviceCalls).toEqual([{ scope: 'allegro:api:orders:read allegro:api:shipments:read allegro:api:sale:offers:read' }])
    expect(x.lines.join(' | ')).toContain('tylko odczyt zamówień, odczyt przesyłek i odczyt ofert')
  })
})

describe('device flow', () => {
  it('authorization_pending → slow_down (+5 s) → sukces; wypisany tylko link i czas ważności', async () => {
    const x = setup(['authorization_pending', 'slow_down', 'ok'])
    const r = await runDeviceFlow(x.deps)
    expect(r.ok).toBe(true)
    expect(x.waits).toEqual([5000, 5000, 10_000]) // interval 0 z atrapy = domyślne 5 s
    expect(x.fake.deviceCalls).toEqual([{ scope: 'allegro:api:orders:read' }])
    const out = x.lines.join('\n')
    expect(out).toContain('https://allegro.pl/skojarz-aplikacje?code=ABC-123')
    expect(out).toContain('ABC-123')
    expect(out).toMatch(/ważny ok\. 60 min/)
    const tokens = r.ok ? [r.tokens.accessToken, r.tokens.refreshToken] : []
    for (const s of [...tokens, 'atrapa-device-code-TAJNE', FAKE_CLIENT_SECRET]) expect(out).not.toContain(s)
    expect(x.fake.nonGet().every((q) => q.startsWith('POST /auth/oauth/'))).toBe(true)
  })

  it('access_denied i wygaśnięcie kodu kończą bez tokenów, komunikat bez sekretów', async () => {
    const d = setup(['authorization_pending', 'access_denied'])
    const r1 = await runDeviceFlow(d.deps)
    expect(r1).toMatchObject({ ok: false, reason: 'odmowa' })
    const e = setup(['expired_token'])
    expect(await runDeviceFlow(e.deps)).toMatchObject({ ok: false, reason: 'wygasl' })
    const never = setup([])
    never.deps.wait = async () => {}
    let t = 0
    never.deps.now = () => (t += 600_000)
    expect(await runDeviceFlow(never.deps)).toMatchObject({ ok: false, reason: 'wygasl' })
    for (const x of [d, e, never]) expect(x.lines.join('\n')).not.toMatch(/atrapa-device-code|NIE-WYPISYWAC/)
  })

  it('złe Client ID/Secret → błąd z kodem, bez wartości', async () => {
    const x = setup([])
    x.deps.oauth = { ...x.deps.oauth, clientSecret: 'zly-sekret-XYZ' }
    const r = await runDeviceFlow(x.deps)
    expect(r).toMatchObject({ ok: false, reason: 'blad' })
    expect(JSON.stringify(r)).toContain('invalid_client')
    expect(JSON.stringify(r)).not.toContain('zly-sekret-XYZ')
  })
})
