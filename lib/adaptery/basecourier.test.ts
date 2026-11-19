// adapter `basecourier.v1` na atrapie HTTP. Dane fikcyjne, zero połączeń: tryb „przygotuj, nie wysyłaj”.
import { describe, expect, it } from 'vitest'
import { BaseCourierReadOnly, assertBaseCourierReadOnly } from '../zrodla/basecourier'
import { ReadOnlyViolation, SourceError } from '../zrodla/http'
import { BASE_COURIER_DEFINITION, BASE_COURIER_KEY } from './basecourier'
import { defaultRegistry } from './domyslne'
import { hasShipmentPreparer, type ChannelAdapter, type ShipmentInput } from './kontrakt'
import { validateAccountConfig } from './rejestr'
import { runAdapterContract } from './suita-kontraktowa'

const BASE = 'https://sandbox.blpaczka.com/api'
const LOGIN = 'konto@example.invalid'
const KEY = 'klucz-testowy-abc123'
const FAST = { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 }
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'basecourier', name: 'Base Courier' }

type Reply = { status: number; body: string }
const json = (v: unknown, status = 200): Reply => ({ status, body: JSON.stringify(v) })

function atrapa(replies: Reply[] = []) {
  const calls: { url: string; method: string; body: Record<string, unknown>; redirect?: string }[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, redirect: init?.redirect })
    const r = replies.shift() ?? json({ login: 'x' })
    return new Response(r.body, { status: r.status })
  }
  return { calls, fetchImpl }
}

function adapter(fetchImpl: ReturnType<typeof atrapa>['fetchImpl'], config: Record<string, unknown> = {}): ChannelAdapter {
  return defaultRegistry().create(BASE_COURIER_KEY, {
    integration,
    rawConfig: { baseUrl: BASE, ...config },
    rawSecrets: { BASE_COURIER_LOGIN: LOGIN, BASE_COURIER_API_KEY: KEY },
    fetch: fetchImpl,
    http: FAST,
  })
}

runAdapterContract({
  name: BASE_COURIER_KEY,
  now: new Date('2026-11-02T10:00:00Z'),
  setup() {
    const a = atrapa()
    return {
      adapter: adapter(a.fetchImpl),
      putOrder: () => {},
      corruptOrder: () => {},
      failNextList: () => {},
      requests: () => a.calls.map((c) => c.method),
      readMethods: ['POST'],
    }
  },
})

describe('strażnik tylko-do-odczytu', () => {
  it.each(['createOrderV2.json', 'cancelOrder.json', 'getWaybill.json', 'downloadWaybillsMerged', 'getOrderDetails.json', 'getOrderDetailsByWaybillNo.json', 'getWaybillTracking.json', 'nieznany.json', ''])('„%s” = wyjątek przed wysyłką', async (endpoint) => {
    const a = atrapa()
    const api = new BaseCourierReadOnly(BASE, LOGIN, KEY, a.fetchImpl, 0, FAST.retry)
    expect(() => assertBaseCourierReadOnly(endpoint)).toThrow(ReadOnlyViolation)
    await expect(api.post(endpoint, {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(a.calls).toHaveLength(0)
  })

  it.each(['getValuation.json', 'getProfile.json', 'getPaymentOptions.json', 'couriers'])('„%s” przechodzi', (endpoint) => {
    expect(() => assertBaseCourierReadOnly(endpoint)).not.toThrow()
  })

  it('odmawia adresu spoza API Base Courier', () => {
    expect(() => new BaseCourierReadOnly('https://zly.example.invalid/api', LOGIN, KEY)).toThrow(/adres API/)
    expect(() => defaultRegistry().create(BASE_COURIER_KEY, { integration, rawConfig: { baseUrl: 'https://zly.example.invalid/api' }, rawSecrets: { BASE_COURIER_LOGIN: LOGIN, BASE_COURIER_API_KEY: KEY }, fetch: atrapa().fetchImpl })).toThrow()
  })
})

describe('klient HTTP', () => {
  it('POST z uwierzytelnieniem w treści, adres z endpointem, bez przekierowań', async () => {
    const a = atrapa([json({ ok: 1 })])
    const api = new BaseCourierReadOnly(`${BASE}/`, LOGIN, KEY, a.fetchImpl, 0, FAST.retry)
    await api.post('getValuation.json', { auth: 'nadpisanie', CourierSearch: { weight: 1 } })
    expect(a.calls[0]).toMatchObject({ url: `${BASE}/getValuation.json`, method: 'POST', redirect: 'error' })
    expect(a.calls[0]!.body).toEqual({ CourierSearch: { weight: 1 }, auth: { login: LOGIN, api_key: KEY } })
  })

  it('401 bez ponawiania; 429 i 5xx ponawiane, potem błąd przejściowy', async () => {
    const a401 = atrapa([{ status: 401, body: 'odmowa' }])
    const e401 = await new BaseCourierReadOnly(BASE, LOGIN, KEY, a401.fetchImpl, 0, FAST.retry).post('getProfile.json').catch((e: unknown) => e)
    expect(e401).toBeInstanceOf(SourceError)
    expect((e401 as SourceError).retryable).toBe(false)
    expect(a401.calls).toHaveLength(1)
    for (const status of [429, 503]) {
      const a = atrapa([{ status, body: '' }, { status, body: '' }])
      const e = await new BaseCourierReadOnly(BASE, LOGIN, KEY, a.fetchImpl, 0, FAST.retry).post('getProfile.json').catch((x: unknown) => x)
      expect((e as SourceError).retryable).toBe(true)
      expect(a.calls).toHaveLength(2)
    }
    const a = atrapa([{ status: 500, body: '' }, json({ ok: 1 })])
    await expect(new BaseCourierReadOnly(BASE, LOGIN, KEY, a.fetchImpl, 0, FAST.retry).post('getProfile.json')).resolves.toEqual({ ok: 1 })
  })

  it('nieczytelna odpowiedź to błąd, bez treści odpowiedzi w komunikacie', async () => {
    const a = atrapa([{ status: 200, body: `<html>${KEY}</html>` }])
    const e = await new BaseCourierReadOnly(BASE, LOGIN, KEY, a.fetchImpl, 0, FAST.retry).post('getProfile.json').catch((x: unknown) => x)
    expect((e as Error).message).toMatch(/nieczytelna odpowiedź/)
    expect((e as Error).message).not.toContain(KEY)
  })

  it('klucz i login nie trafiają do komunikatu błędu sieci', async () => {
    const zly = async () => {
      throw new Error(`socket hang up ${KEY} ${LOGIN}`)
    }
    const e = await new BaseCourierReadOnly(BASE, LOGIN, KEY, zly, 0, { attempts: 1, baseDelayMs: 0 }).post('getProfile.json').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(SourceError)
    expect((e as Error).message).not.toContain(KEY)
    expect((e as Error).message).not.toContain(LOGIN)
  })
})

describe('adapter basecourier.v1', () => {
  it('w rejestrze jako przewoźnik tylko do odczytu, z sekretami i zdolnością przygotowania', () => {
    const { manifest } = BASE_COURIER_DEFINITION
    expect(defaultRegistry().get(BASE_COURIER_KEY)?.manifest).toBe(manifest)
    expect(manifest).toMatchObject({ kind: 'carrier', capabilities: ['shipment.prepare'], readOnly: true })
    expect(manifest.secrets.map((s) => s.envSuffix)).toEqual(['LOGIN', 'API_KEY'])
    expect(() => defaultRegistry().create(BASE_COURIER_KEY, { integration, rawConfig: { baseUrl: BASE }, rawSecrets: {}, fetch: atrapa().fetchImpl })).toThrow()
  })

  it('testConnection przez getProfile.json: OK bez przepisywania profilu', async () => {
    const a = atrapa([json({ email: LOGIN, company: 'Firma fikcyjna' })])
    const r = await adapter(a.fetchImpl).testConnection()
    expect(r).toEqual({ ok: true, message: 'odczyt profilu konta działa' })
    expect(a.calls.map((c) => c.url)).toEqual([`${BASE}/getProfile.json`])
  })

  it.each([
    ['401', [{ status: 401, body: 'x' }], /HTTP 401/],
    ['429', [{ status: 429, body: '' }, { status: 429, body: '' }], /HTTP 429/],
    ['5xx', [{ status: 502, body: '' }, { status: 502, body: '' }], /HTTP 502/],
    ['nie JSON', [{ status: 200, body: 'ups' }], /nieczytelna/],
    ['pusta', [json({})], /nieczytelna/],
    ['lista', [json([1])], /nieczytelna/],
    ['odmowa w treści', [json({ success: false, message: `zły klucz ${KEY}` })], /odrzucił/],
  ] as [string, Reply[], RegExp][])('testConnection: %s = ok false, bez klucza', async (_n, replies, re) => {
    const r = await adapter(atrapa(replies).fetchImpl).testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(re)
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('courierCode w manifeście: konfiguracja go zachowuje, nieznany kod odpada', () => {
    const def = defaultRegistry().get(BASE_COURIER_KEY)!
    expect(validateAccountConfig(def.manifest, { baseUrl: BASE, courierCode: 'paczkomaty_eco' })).toMatchObject({ config: { courierCode: 'paczkomaty_eco' }, problems: [] })
    expect(validateAccountConfig(def.manifest, { baseUrl: BASE, courierCode: 'wymyslony' }).problems).toEqual([expect.stringContaining('courierCode')])
  })

  it('prepareShipment nie woła sieci i używa ustawień z konfiguracji', () => {
    const a = atrapa()
    const ad = adapter(a.fetchImpl, { defaultSideXCm: 50, defaultSideYCm: 40, defaultSideZCm: 30, defaultWeightKg: 2 })
    if (!hasShipmentPreparer(ad)) throw new Error('bez shipment.prepare')
    const input: ShipmentInput = { carrier: 'DPD', gabaryt: 'DPD', weightG: null, weightComplete: false, paymentState: 'PAID', paymentMethod: 'Przelew', totalGross: 100, codAmountUncertain: null, pickupPoint: null }
    const p = ad.prepareShipment(input)
    expect(p).toMatchObject({ courierCode: 'dpd', sideXCm: 50, sideYCm: 40, sideZCm: 30, weightKg: 2, codAmount: null })
    expect(p.problems.map((x) => x.kod)).toEqual(['waga_domyslna'])
    expect(a.calls).toHaveLength(0)
  })
})
