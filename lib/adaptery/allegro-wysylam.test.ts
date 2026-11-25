// adapter `allegro.wysylam.v1` na atrapie HTTP (tests/allegro-wysylam-atrapa.ts): suita kontraktowa, strażnik
// każdej ścieżki, test zakresu przesyłek (404, 403, 401 po odświeżeniu, 429, 5xx), propozycje dostawy bez `suggestedInput`.
// Dane fikcyjne, zero połączeń: tryb „przygotuj, nie wysyłaj”.
import { describe, expect, it } from 'vitest'
import { API, AUTH, deliveryProposal, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroWysylam, SHIPMENTS_READ, SHIPMENTS_WRITE, UA } from '@/tests/allegro-wysylam-atrapa'
import { AllegroReadOnly } from '../zrodla/allegro'
import { ALLEGRO_SHIPMENTS_READ_SCOPE, assertAllegroWysylamReadOnly, getAllegroShipments } from '../zrodla/allegro-wysylam'
import { ReadOnlyViolation } from '../zrodla/http'
import { AllegroAccountError, ALLEGRO_MANIFEST, ALLEGRO_SECRETS as S } from './allegro'
import { ALLEGRO_WYSYLAM_DEFINITION, ALLEGRO_WYSYLAM_KEY, AllegroWysylamAdapter, PROBE_SHIPMENT_ID } from './allegro-wysylam'
import { defaultRegistry } from './domyslne'
import { AdapterError, hasShipmentPreparer, type SecretRotation, type ShipmentInput, UnreadableDataError } from './kontrakt'
import { PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'

const NOW = new Date('2026-11-02T10:00:00.000Z')
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
const ORDER = '29a8e3c0-7f1b-11ef-9d6f-0d1c5b7a1e01'
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO' as const, channelAccountId: '71045' }

interface Opts {
  expiresAt?: string
  config?: Record<string, unknown>
  rotate?: (r: SecretRotation) => Promise<Record<string, string>>
  persist?: (patch: Record<string, string>) => Promise<void>
}

function make(fake: FakeAllegroWysylam, o: Opts = {}): AllegroWysylamAdapter {
  const pair = fake.base.issuePair()
  const a = defaultRegistry().create(ALLEGRO_WYSYLAM_KEY, {
    integration,
    rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA, ...o.config },
    rawSecrets: { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: o.expiresAt ?? iso(600) },
    fetch: fake.fetch,
    now: () => NOW,
    http: { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 },
    persistSecrets: o.persist ?? (async () => {}),
    ...(o.rotate ? { rotateSecrets: o.rotate } : {}),
  })
  if (!(a instanceof AllegroWysylamAdapter)) throw new Error('zły adapter')
  return a
}

function fakeNow(): FakeAllegroWysylam {
  const f = new FakeAllegroWysylam()
  f.base.clock = () => NOW.getTime()
  return f
}

runAdapterContract({
  name: `${ALLEGRO_WYSYLAM_KEY} (atrapa HTTP)`,
  now: NOW,
  setup() {
    const fake = fakeNow()
    return { adapter: make(fake), putOrder: () => {}, corruptOrder: () => {}, failNextList: () => {}, requests: () =>
        fake.requests
          // pomijamy wyłącznie OAuth (wymiana tokenu, device flow); każdy inny POST suita ma zobaczyć
          .filter((r) => r !== 'POST /auth/oauth/token' && r !== 'POST /auth/oauth/device')
          .map((r) => r.split(' ')[0]!),
    }
  },
})

describe('strażnik tylko-do-odczytu', () => {
  const U = '00000000-0000-4000-8000-000000000000'
  it.each([
    '/shipment-management/shipments/create-commands',
    `/shipment-management/shipments/create-commands/${U}`,
    '/shipment-management/shipments/cancel-commands',
    `/shipment-management/shipments/cancel-commands/${U}`,
    '/shipment-management/pickups/create-commands',
    `/shipment-management/pickups/create-commands/${U}`,
    '/shipment-management/pickup-proposals',
    '/shipment-management/label',
    '/shipment-management/protocol',
    '/shipment-management/delivery-services',
    '/shipment-management/delivery-proposals',
    '/shipment-management/delivery-proposals/123',
    `/shipment-management/delivery-proposals/${U}/..`,
    `/shipment-management/shipments/../label/${U}`,
    `/shipment-management/shipments/${U}?x=1`,
    `/shipment-management/shipments/${U}#x`,
    `/shipment-management/shipments/${U}/`,
    `/order/checkout-forms/${U}`,
    `shipment-management/shipments/${U}`,
    '',
  ])('„%s” = ReadOnlyViolation przed wysyłką', async (path) => {
    const fake = fakeNow()
    const api = new AllegroReadOnly(API, UA, fake.fetch, 0, { attempts: 1, baseDelayMs: 0 })
    expect(() => assertAllegroWysylamReadOnly(path)).toThrow(ReadOnlyViolation)
    await expect(getAllegroShipments(api, path, 'token')).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(fake.requests).toEqual([])
  })

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('metoda %s = ReadOnlyViolation także na dozwolonej ścieżce', (m) => {
    expect(() => assertAllegroWysylamReadOnly(`/shipment-management/shipments/${U}`, m)).toThrow(ReadOnlyViolation)
  })

  it.each([`/shipment-management/delivery-proposals/${ORDER}`, `/shipment-management/shipments/${U}`])('GET „%s” przechodzi', (path) => {
    expect(() => assertAllegroWysylamReadOnly(path)).not.toThrow()
  })

  it('historia statusów tylko z parametrem waybill (1–20 numerów, litery, cyfry, myślnik)', async () => {
    const T = '/order/carriers/ALLEGRO/tracking'
    expect(() => assertAllegroWysylamReadOnly(T, 'GET', [['waybill', 'AL000111222PL']])).not.toThrow()
    expect(() => assertAllegroWysylamReadOnly(T, 'GET', Array.from({ length: 20 }, (_, i) => ['waybill', `AL00011122${String(i).padStart(2, '0')}`] as [string, string]))).not.toThrow()
    const zle: [string, readonly [string, string][]][] = [
      [T, []],
      [T, Array.from({ length: 21 }, (_, i) => ['waybill', `AL00011122${String(i).padStart(2, '0')}`] as [string, string])],
      [T, [['waybill', 'AL0001&x=1']]],
      [T, [['waybill', 'AL000111222PL'], ['limit', '1']]],
      ['/order/carriers/ALL%2F/tracking', [['waybill', 'AL000111222PL']]],
      ['/order/carriers/ALLEGRO/points', [['waybill', 'AL000111222PL']]],
      ['/order/carriers', []],
      [`/shipment-management/shipments/${U}`, [['waybill', 'AL000111222PL']]],
    ]
    const fake = fakeNow()
    const api = new AllegroReadOnly(API, UA, fake.fetch, 0, { attempts: 1, baseDelayMs: 0 })
    for (const [path, q] of zle) {
      expect(() => assertAllegroWysylamReadOnly(path, 'GET', q), path).toThrow(ReadOnlyViolation)
      await expect(getAllegroShipments(api, path, 'token', q)).rejects.toBeInstanceOf(ReadOnlyViolation)
    }
    expect(fake.requests).toEqual([])
    expect(() => assertAllegroWysylamReadOnly(T, 'POST', [['waybill', 'AL000111222PL']])).toThrow(ReadOnlyViolation)
  })

  it('komunikat odmowy bez ścieżki (identyfikatory nie idą do logów)', () => {
    expect(() => assertAllegroWysylamReadOnly(`/shipment-management/label/${ORDER}`)).toThrow(expect.objectContaining({ message: expect.not.stringContaining(ORDER) }))
  })
})

describe('adapter allegro.wysylam.v1', () => {
  it('w rejestrze jako przewoźnik tylko do odczytu, konfiguracja i sekrety jak allegro.v1', () => {
    const { manifest } = ALLEGRO_WYSYLAM_DEFINITION
    expect(defaultRegistry().get(ALLEGRO_WYSYLAM_KEY)?.manifest).toBe(manifest)
    expect(manifest).toMatchObject({ kind: 'carrier', capabilities: ['shipment.prepare'], readOnly: true })
    expect(manifest.secrets).toBe(ALLEGRO_MANIFEST.secrets)
    expect(manifest.config.map((f) => f.key)).toEqual(['apiUrl', 'authUrl', 'userAgent', 'envPrefix', 'defaultWeightKg'])
    const reg = defaultRegistry()
    expect(() => reg.create(ALLEGRO_WYSYLAM_KEY, { integration, rawConfig: { userAgent: UA }, rawSecrets: {}, fetch: fakeNow().fetch })).toThrow(/brak sekretu/)
    expect(() => reg.create(ALLEGRO_WYSYLAM_KEY, { integration: { ...integration, kind: 'channel' }, rawConfig: { userAgent: UA }, rawSecrets: {}, fetch: fakeNow().fetch })).toThrow(/rodzaju carrier/)
  })

  it('testConnection: 404 dla UUID spoza zakresu = zakres przesyłek działa; jedno GET, bez tokenów w wyniku', async () => {
    const fake = fakeNow()
    const r = await make(fake).testConnection()
    expect(r).toEqual({ ok: true, message: 'zakres przesyłek działa (odczyt przesyłek)' })
    expect(fake.requests).toEqual([`GET /shipment-management/shipments/${PROBE_SHIPMENT_ID}`])
  })

  it('testConnection: 200 też = działa', async () => {
    const fake = fakeNow()
    fake.shipments.set(PROBE_SHIPMENT_ID, { id: PROBE_SHIPMENT_ID })
    expect((await make(fake).testConnection()).ok).toBe(true)
  })

  it('testConnection: 403 = ok false z nazwą brakującego zakresu i komendą autoryzacji', async () => {
    const fake = fakeNow()
    fake.scopes = new Set(['allegro:api:orders:read'])
    const r = await make(fake).testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toContain(ALLEGRO_SHIPMENTS_READ_SCOPE)
    expect(r.message).toContain('Odczyt przesyłek')
    expect(r.message).not.toContain('npm run')
    expect(r.message).not.toMatch(/orders:read\)/)
  })

  it('testConnection: 401 → jedno odświeżenie (zapis przed użyciem) i powtórka z nowym tokenem', async () => {
    const fake = fakeNow()
    const zapisane: Record<string, string>[] = []
    const a = make(fake, { persist: async (p) => void zapisane.push(p) })
    fake.base.validAccess.clear() // access token unieważniony przed końcem ważności
    const r = await a.testConnection()
    expect(r.ok).toBe(true)
    expect(fake.base.tokenCalls).toBe(1)
    expect(zapisane).toHaveLength(1)
    expect(fake.requests.filter((x) => x.startsWith('GET'))).toHaveLength(2)
    expect(JSON.stringify(r)).not.toContain(zapisane[0]![S.access]!)
  })

  it('testConnection: 401 także po odświeżeniu = błąd konta, bez pętli', async () => {
    const fake = fakeNow()
    const a = make(fake)
    fake.base.validAccess.clear()
    fake.failures = [{ status: 401 }, { status: 401 }]
    const r = await a.testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/401 także po odświeżeniu/)
    expect(fake.base.tokenCalls).toBe(1)
  })

  it('testConnection: wygasły token odświeżony przez rotację hosta przed żądaniem', async () => {
    const fake = fakeNow()
    const rotacje: SecretRotation[] = []
    const a = make(fake, {
      expiresAt: iso(-1),
      rotate: async (rot) => {
        rotacje.push(rot)
        return rot.refresh({ [S.refresh]: [...fake.base.refreshTokens.keys()][0]! })
      },
    })
    expect((await a.testConnection()).ok).toBe(true)
    expect(rotacje).toHaveLength(1)
    expect(rotacje[0]!.names[0]).toBe(S.refresh)
    expect(fake.base.tokenCalls).toBe(1)
  })

  it('429 = ok false z limitem; rodzaj przejściowy z Retry-After w call', async () => {
    const fake = fakeNow()
    fake.failures = [{ status: 429, retryAfter: '7' }]
    const r = await make(fake).testConnection()
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 429') })
    fake.failures = [{ status: 429, retryAfter: '7' }]
    fake.scopes.add(SHIPMENTS_WRITE)
    const e = await make(fake).readDeliveryOptions(ORDER).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AdapterError)
    expect(e).toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 7000 })
  })

  it('5xx ponawiane, potem ok false; po jednej awarii przechodzi', async () => {
    const fake = fakeNow()
    fake.failures = [{ status: 503 }, { status: 503 }]
    expect(await make(fake).testConnection()).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 503') })
    fake.failures = [{ status: 502 }]
    expect((await make(fake).testConnection()).ok).toBe(true)
  })

  it('inny status (400) = ok false ze statusem', async () => {
    const fake = fakeNow()
    fake.failures = [{ status: 400 }]
    expect(await make(fake).testConnection()).toEqual({ ok: false, message: 'Allegro /shipment-management/shipments/{id}: HTTP 400' })
  })

  it('prepareShipment nie woła sieci, waga domyślna z konfiguracji', () => {
    const fake = fakeNow()
    const a = make(fake, { config: { defaultWeightKg: 2 } })
    if (!hasShipmentPreparer(a)) throw new Error('bez shipment.prepare')
    const input: ShipmentInput = { carrier: 'ALLEGRO', gabaryt: 'ALLEGRO_B', weightG: null, weightComplete: false, paymentState: 'PAID', paymentMethod: 'ONLINE', totalGross: 80, codAmountUncertain: null, pickupPoint: null }
    expect(a.prepareShipment(input)).toMatchObject({ courierCode: null, pickupPoint: null, sideXCm: 19, sideYCm: 38, sideZCm: 64, weightKg: 2, codAmount: null })
    expect(fake.requests).toEqual([])
  })
})

describe('readDeliveryOptions', () => {
  it('zwraca tylko typ dostawy, typ paczki i limity; suggestedInput i dane osobowe nie wychodzą', async () => {
    const fake = fakeNow()
    fake.scopes.add(SHIPMENTS_WRITE)
    fake.proposals.set(ORDER, deliveryProposal(ORDER))
    const r = await make(fake).readDeliveryOptions(ORDER)
    expect(r).toEqual([
      {
        deliveryType: 'Allegro Paczkomaty InPost',
        packageType: 'PACKAGE',
        limits: { cashOnDelivery: { amount: 5000, currency: 'PLN' }, insurance: { amount: 5000, currency: 'PLN' }, dimensions: { lengthCm: 64, widthCm: 38, heightCm: 41 }, weightKg: 25 },
      },
    ])
    const json = JSON.stringify(r)
    for (const p of [...PII_SENTINELS, 'WAW01A', 'Sprzedawca Fikcyjny', 'suggestedInput', 'metoda-przestarzala']) expect(json).not.toContain(p)
    expect(fake.requests).toEqual([`GET /shipment-management/delivery-proposals/${ORDER}`])
    expect(fake.nonGet()).toEqual([])
  })

  it('bez zakresu zapisu przesyłek: błąd konta 403, z jasnym komunikatem', async () => {
    const fake = fakeNow()
    const e = await make(fake).readDeliveryOptions(ORDER).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AllegroAccountError)
    expect((e as Error).message).toMatch(/403.*zapis przesyłek/)
    expect((e as Error).message).not.toContain(ORDER)
  })

  it('404 = null; zły numer = błąd przed wysyłką; nieczytelna odpowiedź = UnreadableDataError', async () => {
    const fake = fakeNow()
    fake.scopes.add(SHIPMENTS_WRITE)
    const a = make(fake)
    expect(await a.readDeliveryOptions(ORDER)).toBeNull()
    await expect(a.readDeliveryOptions('../label')).rejects.toBeInstanceOf(AdapterError)
    fake.proposals.set(ORDER, { orderId: ORDER, suggestedInput: {}, deliveryOptions: 'nie-lista' })
    await expect(a.readDeliveryOptions(ORDER)).rejects.toBeInstanceOf(UnreadableDataError)
    expect(fake.requests.filter((x) => x.includes('label'))).toEqual([])
  })

  it('zakres odczytu w atrapie wystarcza na shipments, nie na delivery-proposals (zgodnie ze specyfikacją)', () => {
    expect(SHIPMENTS_READ).toBe(ALLEGRO_SHIPMENTS_READ_SCOPE)
  })
})
