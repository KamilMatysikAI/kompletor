// adaptery `inpost.shipx.v1` i `inpost.shipx.zapis.v1` na atrapie HTTP (tests/inpost-atrapa.ts). Dane
// fikcyjne, zero połączeń, także z sandboxem InPost. Tryb „przygotuj, nie wysyłaj”: zapis tylko za wyłącznikiem.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INPOST_FAST, INPOST_ORG, INPOST_SANDBOX, INPOST_TOKEN, inpostAtrapa, json, ODBIORCA_ATRAPY, type InpostReply } from '@/tests/inpost-atrapa'
import { assertInpostZapis, InpostZapis } from '../zrodla/inpost-zapis'
import { assertInpostReadOnly, InpostApiError, InpostReadOnly } from '../zrodla/inpost'
import { ReadOnlyViolation } from '../zrodla/http'
import { sprawdzPunkt } from '../wysylka/punkt-inpost'
import { defaultRegistry } from './domyslne'
import { INPOST_SHIPX_DEFINITION, INPOST_SHIPX_KEY } from './inpost'
import { INPOST_SHIPX_ZAPIS_KEY, stanShipX } from './inpost-zapis'
import { hasReferenceFinder, hasShipmentCreator, hasShipmentPreparer, hasShipmentTracker, type ChannelAdapter, type PreparedParcel, type ShipmentInput } from './kontrakt'
import { PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'
import { executeWrite, mayRetry } from './zapis'

const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'inpost', name: 'InPost ShipX' }
const BAZA = { baseUrl: INPOST_SANDBOX, organizationId: INPOST_ORG }

function adapter(key: string, fetchImpl: ReturnType<typeof inpostAtrapa>['fetchImpl'], config: Record<string, unknown> = {}): ChannelAdapter {
  return defaultRegistry().create(key, { integration, rawConfig: { ...BAZA, ...config }, rawSecrets: { INPOST_TOKEN }, fetch: fetchImpl, http: INPOST_FAST })
}

for (const [key, config] of [
  [INPOST_SHIPX_KEY, {}],
  [INPOST_SHIPX_ZAPIS_KEY, {}],
  [INPOST_SHIPX_ZAPIS_KEY, { zapisWlaczony: true }],
] as const) {
  runAdapterContract({
    name: `${key}${'zapisWlaczony' in config ? ' (wyłącznik włączony)' : ''}`,
    now: new Date('2026-11-02T10:00:00Z'),
    setup() {
      const a = inpostAtrapa()
      return { adapter: adapter(key, a.fetchImpl, config), putOrder: () => {}, corruptOrder: () => {}, failNextList: () => {}, requests: () => a.calls.map((c) => c.method) }
    },
  })
}

// ─── Klient odczytu ──────────────────────────────────────────────────────────

describe('strażnik tylko-do-odczytu', () => {
  const zakazane: [string, string][] = [
    ['POST', `/v1/organizations/${INPOST_ORG}/shipments`],
    ['GET', `/v1/organizations/${INPOST_ORG}/shipments`],
    ['GET', '/v1/shipments/123'],
    ['GET', '/v1/shipments/123/label'],
    ['POST', '/v1/shipments/labels'],
    ['DELETE', '/v1/shipments/123'],
    ['PUT', `/v1/organizations/${INPOST_ORG}`],
    ['POST', `/v1/organizations/${INPOST_ORG}/dispatch_orders`],
    ['GET', `/v1/organizations/${INPOST_ORG}/dispatch_orders`],
    ['POST', `/v1/organizations/${INPOST_ORG}/webhooks`],
    ['GET', '/v1/webhooks'],
    ['POST', '/v1/points'],
    ['DELETE', '/v1/points/KRA010'],
    ['GET', '/v1/points/KRA010/../../shipments'],
    ['GET', '/v1/points/KRA%2F010'],
    ['GET', '/v1/organizations'],
    ['GET', '/v1/tracking'],
    ['GET', '/v2/points'],
    ['GET', ''],
  ]

  it.each(zakazane)('%s „%s” = wyjątek przed wysyłką', async (method, path) => {
    expect(() => assertInpostReadOnly(method, path)).toThrow(ReadOnlyViolation)
    if (method === 'GET') {
      const a = inpostAtrapa()
      await expect(new InpostReadOnly(INPOST_SANDBOX, INPOST_TOKEN, a.fetchImpl, 0, INPOST_FAST.retry).get(path)).rejects.toBeInstanceOf(ReadOnlyViolation)
      expect(a.calls).toHaveLength(0)
    }
  })

  it.each([`/v1/organizations/${INPOST_ORG}`, '/v1/points', '/v1/points?type=parcel_locker', '/v1/points/KRA010', '/v1/tracking/600000000000000000000000'])('GET „%s” przechodzi', (path) => {
    expect(() => assertInpostReadOnly('GET', path)).not.toThrow()
  })

  it('tylko dwa hosty ShipX', () => {
    for (const url of ['https://api-shipx-pl.easypack24.net', 'https://sandbox-api-shipx-pl.easypack24.net/']) expect(() => new InpostReadOnly(url, INPOST_TOKEN)).not.toThrow()
    for (const url of ['http://api-shipx-pl.easypack24.net', 'https://api-shipx-pl.easypack24.net.example.invalid', 'https://zly.example.invalid', 'https://api-shipx-pl.easypack24.net/v1']) expect(() => new InpostReadOnly(url, INPOST_TOKEN)).toThrow(/adres API/)
    expect(() => defaultRegistry().create(INPOST_SHIPX_KEY, { integration, rawConfig: { ...BAZA, baseUrl: 'https://zly.example.invalid' }, rawSecrets: { INPOST_TOKEN }, fetch: inpostAtrapa().fetchImpl })).toThrow()
  })
})

describe('klient odczytu: HTTP', () => {
  const api = (a: ReturnType<typeof inpostAtrapa>) => new InpostReadOnly(INPOST_SANDBOX, INPOST_TOKEN, a.fetchImpl, 0, INPOST_FAST.retry)

  it('GET z tokenem w nagłówku Bearer, bez przekierowań, z zapytaniem', async () => {
    const a = inpostAtrapa()
    await api(a).get('/v1/points', { type: 'parcel_locker' })
    expect(a.calls[0]).toMatchObject({ method: 'GET', url: `${INPOST_SANDBOX}/v1/points?type=parcel_locker`, redirect: 'error', body: null })
    expect(a.calls[0]!.headers['authorization']).toBe(`Bearer ${INPOST_TOKEN}`)
  })

  it('401 i 403 → trwały bez ponawiania; 429 i 5xx → przejściowy, ponawiany', async () => {
    for (const status of [401, 403]) {
      const a = inpostAtrapa()
      a.reply({ status, body: `{"error":"token_invalid","details":"${INPOST_TOKEN}"}` })
      const e = await api(a).get(`/v1/organizations/${INPOST_ORG}`).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(InpostApiError)
      expect((e as InpostApiError).kind).toBe('TRWALY')
      expect((e as Error).message).not.toContain(INPOST_TOKEN)
      expect(a.calls).toHaveLength(1)
    }
    for (const status of [429, 500, 503]) {
      const a = inpostAtrapa()
      a.reply({ status, body: '' }, { status, body: '' })
      const e = await api(a).get(`/v1/organizations/${INPOST_ORG}`).catch((x: unknown) => x)
      expect((e as InpostApiError).kind).toBe('PRZEJSCIOWY')
      expect(a.calls).toHaveLength(2)
    }
  })

  it('pusta albo nieczytelna treść to błąd, nigdy pusty obiekt', async () => {
    for (const body of ['', '   ', '<html>ups</html>']) {
      const a = inpostAtrapa()
      a.reply({ status: 200, body })
      await expect(api(a).get(`/v1/organizations/${INPOST_ORG}`)).rejects.toThrow(/pusta|nieczytelna/)
    }
  })

  it('token nie trafia do komunikatu błędu sieci (wartownik)', async () => {
    const a = inpostAtrapa()
    a.reply('network-error', 'network-error')
    const e = await api(a).get(`/v1/organizations/${INPOST_ORG}`).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(InpostApiError)
    expect((e as Error).message).toContain('***')
    expect((e as Error).message).not.toContain(INPOST_TOKEN)
  })
})

// ─── Adapter odczytu ─────────────────────────────────────────────────────────

describe('adapter inpost.shipx.v1', () => {
  it('w rejestrze jako przewoźnik tylko do odczytu, sekret INPOST_TOKEN, bez zapisu', () => {
    const { manifest } = INPOST_SHIPX_DEFINITION
    expect(defaultRegistry().get(INPOST_SHIPX_KEY)?.manifest).toBe(manifest)
    expect(manifest).toMatchObject({ kind: 'carrier', capabilities: ['shipment.prepare'], readOnly: true })
    expect(manifest.secrets).toEqual([expect.objectContaining({ name: 'INPOST_TOKEN', envSuffix: 'TOKEN' })])
    expect(manifest.config.map((f) => f.key)).toEqual(['baseUrl', 'organizationId', 'sendingMethod', 'defaultSideXCm', 'defaultSideYCm', 'defaultSideZCm', 'defaultWeightKg', 'codLimit', 'envPrefix'])
    expect(() => defaultRegistry().create(INPOST_SHIPX_KEY, { integration, rawConfig: BAZA, rawSecrets: {}, fetch: inpostAtrapa().fetchImpl })).toThrow(/INPOST_TOKEN/)
    expect(() => defaultRegistry().create(INPOST_SHIPX_KEY, { integration, rawConfig: { ...BAZA, organizationId: '../1' }, rawSecrets: { INPOST_TOKEN }, fetch: inpostAtrapa().fetchImpl })).toThrow(/organizationId/)
    const a = adapter(INPOST_SHIPX_KEY, inpostAtrapa().fetchImpl)
    expect(hasShipmentCreator(a)).toBe(false)
  })

  it('testConnection przez GET organizacji: OK bez nazwy organizacji i tokenu', async () => {
    const a = inpostAtrapa()
    const r = await adapter(INPOST_SHIPX_KEY, a.fetchImpl).testConnection()
    expect(r).toEqual({ ok: true, message: 'odczyt organizacji ShipX działa' })
    expect(a.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/organizations/${INPOST_ORG}`])
    expect(JSON.stringify(r)).not.toContain('Firma fikcyjna')
  })

  it.each([
    ['401', [{ status: 401, body: 'x' }], /HTTP 401/, 'TRWALY'],
    ['403', [{ status: 403, body: 'x' }], /HTTP 403/, 'TRWALY'],
    ['429', [{ status: 429, body: '' }, { status: 429, body: '' }], /HTTP 429/, 'PRZEJSCIOWY'],
    ['5xx', [{ status: 502, body: '' }, { status: 502, body: '' }], /HTTP 502/, 'PRZEJSCIOWY'],
    ['pusta treść', [{ status: 200, body: '' }], /pusta odpowiedź/, 'TRWALY'],
    ['nie JSON', [{ status: 200, body: 'ups' }], /nieczytelna/, 'TRWALY'],
  ] as [string, InpostReply[], RegExp, string][])('testConnection: %s = ok false z rodzajem, bez tokenu', async (_n, replies, re, rodzaj) => {
    const a = inpostAtrapa()
    a.reply(...replies)
    const r = await adapter(INPOST_SHIPX_KEY, a.fetchImpl).testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(re)
    expect(r.details?.['rodzaj']).toBe(rodzaj)
    expect(JSON.stringify(r)).not.toContain(INPOST_TOKEN)
  })

  it.each([
    ['pusty obiekt', json({}), /nieczytelna/],
    ['lista', json([1]), /nieczytelna/],
    ['bez id', json({ name: 'x' }), /bez id/],
    ['inna organizacja', json({ id: 1, name: 'Inna firma fikcyjna' }), /innej organizacji/],
  ] as [string, InpostReply, RegExp][])('testConnection: %s = ok false', async (_n, reply, re) => {
    const a = inpostAtrapa()
    a.reply(reply)
    const r = await adapter(INPOST_SHIPX_KEY, a.fetchImpl).testConnection()
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(re) })
    expect(JSON.stringify(r)).not.toContain('Inna firma')
  })

  it('prepareShipment nie woła sieci i używa ustawień z konfiguracji', () => {
    const a = inpostAtrapa()
    const ad = adapter(INPOST_SHIPX_KEY, a.fetchImpl, { defaultSideXCm: 50, defaultSideYCm: 40, defaultSideZCm: 30, defaultWeightKg: 2, codLimit: 5000 })
    if (!hasShipmentPreparer(ad)) throw new Error('bez shipment.prepare')
    const input: ShipmentInput = { carrier: 'INPOST_KURIER', gabaryt: 'INPOST_KURIER', weightG: null, weightComplete: false, paymentState: 'PAID', paymentMethod: 'Przelew', totalGross: 100, codAmountUncertain: null, pickupPoint: null }
    expect(ad.prepareShipment(input)).toMatchObject({ courierCode: 'inpost_courier_standard', sideXCm: 50, sideYCm: 40, sideZCm: 30, weightKg: 2, codAmount: null })
    expect(a.calls).toHaveLength(0)
  })
})

describe('sprawdzPunkt', () => {
  const api = (a: ReturnType<typeof inpostAtrapa>) => new InpostReadOnly(INPOST_SANDBOX, INPOST_TOKEN, a.fetchImpl, 0, INPOST_FAST.retry)

  it('stan punktu bez opisu lokalizacji i adresu', async () => {
    const a = inpostAtrapa()
    const s = await sprawdzPunkt(api(a), 'KRA010')
    expect(s).toEqual({ nazwa: 'KRA010', istnieje: true, dziala: true, status: 'Operating', typy: ['parcel_locker'], pobranie: true })
    expect(a.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/points/KRA010'])
  })

  it('404 = punkt nie istnieje; zła nazwa = błąd bez żądania; nieczytelna odpowiedź = błąd', async () => {
    const a = inpostAtrapa()
    expect(await sprawdzPunkt(api(a), 'NIEMA01')).toMatchObject({ istnieje: false, dziala: false })
    await expect(sprawdzPunkt(api(a), '../shipments')).rejects.toThrow(/Zła nazwa/)
    expect(a.calls).toHaveLength(1)
    a.reply(json({ name: 'KRA010', status: 7 }))
    await expect(sprawdzPunkt(api(a), 'KRA010')).rejects.toThrow(/nieczytelny stan/)
    a.reply(json({ name: 'INNY01', status: 'Operating' }))
    await expect(sprawdzPunkt(api(a), 'KRA010')).rejects.toThrow(/inną nazwą/)
    a.reply(json({ name: 'KRA010', status: 'Nowy' }))
    expect(await sprawdzPunkt(api(a), 'KRA010')).toMatchObject({ istnieje: true, dziala: null, status: 'Nowy' })
  })
})

// ─── Zapis za wyłącznikiem ───────────────────────────────────────────────────

const PARCEL: PreparedParcel = { courierCode: 'inpost_locker_standard', gabaryt: 'INPOST_A', sideXCm: 8, sideYCm: 38, sideZCm: 64, weightKg: 0.5, codAmount: null, pickupPoint: 'KRA010', problems: [] }
const REQ = { carrier: 'PACZKOMATY' as const, parcel: PARCEL, recipient: ODBIORCA_ATRAPY }

describe('wyłącznik zapisu', () => {
  it('bez zapisWlaczony: createShipment = TRWALY „zapis wyłączony”, getLabel i odszukanie rzucają, 0 żądań', async () => {
    for (const config of [{}, { zapisWlaczony: false }, { zapisWlaczony: 'nie' }]) {
      const a = inpostAtrapa()
      let ad: ChannelAdapter
      try {
        ad = adapter(INPOST_SHIPX_ZAPIS_KEY, a.fetchImpl, config)
      } catch {
        continue // zła wartość wyłącznika: konfiguracja odrzucona, adapter nie powstaje
      }
      if (!hasShipmentCreator(ad) || !hasReferenceFinder(ad)) throw new Error('bez shipment.create')
      expect(await ad.createShipment(REQ, 'ref-1')).toEqual({ kind: 'TRWALY', reference: 'ref-1', message: 'zapis wyłączony' })
      await expect(ad.getLabel('900001', 'PDF')).rejects.toThrow('zapis wyłączony')
      await expect(ad.findByReference('ref-1')).rejects.toThrow('zapis wyłączony')
      expect((await executeWrite(ad, 'ref-2', () => ad.createShipment(REQ, 'ref-2'))).kind).toBe('TRWALY')
      expect(a.calls).toHaveLength(0)
    }
  })

  it('klient zapisu nie powstaje bez jawnego wylacznik: true', () => {
    const o = { baseUrl: INPOST_SANDBOX, token: INPOST_TOKEN, organizationId: INPOST_ORG, fetchImpl: inpostAtrapa().fetchImpl }
    expect(() => new InpostZapis({ ...o } as never)).toThrow(/wyłącznika/)
    expect(() => new InpostZapis({ ...o, wylacznik: 'true' } as never)).toThrow(/wyłącznika/)
    expect(() => new InpostZapis({ ...o, wylacznik: true })).not.toThrow()
  })

  it('createShipment i getLabel woła tylko host przesyłek (lib/wysylka/nadanie.ts), adaptery i testy', () => {
    const root = join(__dirname, '..', '..')
    const pliki: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n)) pliki.push(p.slice(root.length + 1).replace(/\\/g, '/'))
      }
    }
    for (const d of ['lib', 'worker', 'app', 'scripts']) walk(join(root, d))
    // pliki adapterów przewoźników (lib/adaptery/<przewoźnik>*.ts, lib/zrodla/*) i kontrakt; reszta to host
    const adapterowe = (p: string) => /^lib\/zrodla\//.test(p) || /^lib\/adaptery\/(kontrakt|inpost[^/]*|dpd[^/]*)\.ts$/.test(p) || p === 'lib/wysylka/nadanie.ts'
    const wolajace = pliki.filter((p) => !adapterowe(p) && /\.(createShipment|getLabel)\s*\(/.test(readFileSync(join(root, p), 'utf8')))
    expect(wolajace).toEqual([])
  })
})

describe('zapis z włączonym wyłącznikiem (atrapa)', () => {
  const wlaczony = (a: ReturnType<typeof inpostAtrapa>) => {
    const ad = adapter(INPOST_SHIPX_ZAPIS_KEY, a.fetchImpl, { zapisWlaczony: true, sendingMethod: 'parcel_locker' })
    if (!hasShipmentCreator(ad) || !hasReferenceFinder(ad)) throw new Error('bez shipment.create')
    return ad
  }

  it('POST z referencją; OK z id przesyłki; wynik bez danych odbiorcy', async () => {
    const a = inpostAtrapa()
    const ad = wlaczony(a)
    const r = await ad.createShipment(REQ, 'ref-ok')
    expect(r).toEqual({ kind: 'OK', reference: 'ref-ok', externalRef: '900001' })
    expect(a.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /v1/organizations/${INPOST_ORG}/shipments`])
    expect(a.calls[0]!.body).toMatchObject({ reference: 'ref-ok', service: 'inpost_locker_standard', custom_attributes: { sending_method: 'parcel_locker', target_point: 'KRA010' } })
    for (const p of PII_SENTINELS.slice(0, 4)) expect(JSON.stringify(r)).not.toContain(p)
  })

  it('ostrzeżenie niepotwierdzone albo brak pola odbiorcy = TRWALY bez żądania i bez wartości w komunikacie', async () => {
    const a = inpostAtrapa()
    const ad = wlaczony(a)
    const zOstrzezeniem = { ...REQ, parcel: { ...PARCEL, problems: [{ kod: 'waga_domyslna', poziom: 'OSTRZEZENIE' as const, tekst: 'x' }] } }
    expect(await ad.createShipment(zOstrzezeniem, 'r1')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('waga_domyslna') })
    const bezTelefonu = { ...REQ, recipient: { ...ODBIORCA_ATRAPY, telefon: '' } }
    const r = await ad.createShipment(bezTelefonu, 'r2')
    expect(r).toMatchObject({ kind: 'TRWALY', message: 'brak danych odbiorcy: telefon' })
    for (const p of PII_SENTINELS) expect(JSON.stringify(r)).not.toContain(p)
    // numer domu null i ulica bez jednoznacznego numeru = brak pola, bez pustego stringa w zastępstwie
    // (hotfix 19.11.2026: „ulica numer” w jednej linii rozdziela się sama przy nadaniu)
    // kurier bez numeru domu dalej odmowa; paczkomat bez adresu domowego przechodzi (test niżej)
    const kurier = { ...REQ, carrier: 'INPOST_KURIER' as const, parcel: { ...PARCEL, courierCode: 'inpost_courier_standard', gabaryt: 'INPOST_KURIER', pickupPoint: null } }
    expect(await ad.createShipment({ ...kurier, recipient: { ...ODBIORCA_ATRAPY, ulica: 'Testowa 5-7', numerDomu: null } }, 'r3')).toMatchObject({ kind: 'TRWALY', message: 'brak danych odbiorcy: numerDomu' })
    expect(a.calls).toHaveLength(0)
  })

  it('paczkomat bez numeru domu, ulicy, kodu i miasta: żądanie bez adresu domowego (odbiorca = imię, e-mail, telefon)', async () => {
    const a = inpostAtrapa()
    const ad = wlaczony(a)
    const bezAdresu = { ...ODBIORCA_ATRAPY, ulica: 'Testowa 5-7', numerDomu: null }
    expect(await ad.createShipment({ ...REQ, recipient: bezAdresu }, 'p1')).toMatchObject({ kind: 'OK' })
    const receiver = (a.calls[0]!.body as Record<string, Record<string, unknown>>)['receiver']!
    expect(receiver).not.toHaveProperty('address')
    expect(receiver).toMatchObject({ email: ODBIORCA_ATRAPY.email })
    expect(await ad.createShipment({ ...REQ, recipient: { ...bezAdresu, ulica: null, kodPocztowy: null, miasto: null } }, 'p2')).toMatchObject({ kind: 'OK' })
    // e-mail i telefon zostają wymagane także przy paczkomacie
    expect(await ad.createShipment({ ...REQ, recipient: { ...bezAdresu, email: null } }, 'p3')).toMatchObject({ kind: 'TRWALY', message: 'brak danych odbiorcy: email' })
    expect(a.calls).toHaveLength(2)
  })

  it('odbiorca spoza Polski = TRWALY bez żądania i bez wartości kraju w komunikacie', async () => {
    const a = inpostAtrapa()
    const r = await wlaczony(a).createShipment({ ...REQ, recipient: { ...ODBIORCA_ATRAPY, kraj: 'DE' } }, 'r-de')
    expect(r).toEqual({ kind: 'TRWALY', reference: 'r-de', message: 'odbiorca spoza Polski: moduł InPost ShipX jest krajowy (kraj)' })
    expect(a.calls).toHaveLength(0)
  })

  it('ostrzeżenie potwierdzone w żądaniu (potwierdzoneOstrzezenia) przechodzi; telefon z +48 idzie jako 9 cyfr', async () => {
    const a = inpostAtrapa()
    const ad = wlaczony(a)
    const zOstrzezeniem = { ...REQ, parcel: { ...PARCEL, problems: [{ kod: 'waga_domyslna', poziom: 'OSTRZEZENIE' as const, tekst: 'x' }] }, recipient: { ...ODBIORCA_ATRAPY, telefon: '+48 600 100 200' } }
    expect(await ad.createShipment({ ...zOstrzezeniem, potwierdzoneOstrzezenia: ['waga_domyslna'] }, 'r-ok')).toMatchObject({ kind: 'OK', reference: 'r-ok' })
    expect((a.calls[0]!.body as { receiver: { phone: string } }).receiver.phone).toBe('600100200')
  })

  it('400 z nazwami pól w details → TRWALY z kodem i nazwami pól, bez wartości', async () => {
    const a = inpostAtrapa()
    a.reply(json({ error: 'validation_failed', message: PII_SENTINELS[0], details: { receiver: [PII_SENTINELS[2]], 'custom_attributes.target_point': ['invalid'], 'ZŁE POLE <x>': ['y'] } }, 400))
    const r = await wlaczony(a).createShipment(REQ, 'r-400')
    expect(r).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('(validation_failed: receiver, custom_attributes.target_point)') })
    const s = JSON.stringify(r)
    for (const p of PII_SENTINELS) expect(s).not.toContain(p)
    expect(s).not.toContain('ZŁE POLE')
  })

  it.each([
    ['5xx', { status: 503, body: '' }, 'NIEJEDNOZNACZNY'],
    ['timeout / sieć', 'network-error', 'NIEJEDNOZNACZNY'],
    ['sukces z pustą treścią (sandbox)', { status: 201, body: '' }, 'NIEJEDNOZNACZNY'],
    ['sukces bez id', json({ status: 'created' }, 201), 'NIEJEDNOZNACZNY'],
    ['429', { status: 429, body: '', headers: { 'retry-after': '7' } }, 'PRZEJSCIOWY'],
    ['400 z danymi odbiorcy w treści', json({ error: 'validation_failed', details: { receiver: PII_SENTINELS[1] } }, 400), 'TRWALY'],
    ['401', { status: 401, body: '' }, 'TRWALY'],
  ] as [string, InpostReply, string][])('createShipment: %s = %s, bez ponawiania, bez tokenu i danych odbiorcy', async (_n, reply, kind) => {
    const a = inpostAtrapa()
    a.reply(reply)
    const r = await wlaczony(a).createShipment(REQ, 'ref-x')
    expect(r.kind).toBe(kind)
    expect(a.calls).toHaveLength(1)
    const s = JSON.stringify(r)
    expect(s).not.toContain(INPOST_TOKEN)
    for (const p of PII_SENTINELS) expect(s).not.toContain(p)
    if (kind === 'PRZEJSCIOWY') expect(r).toMatchObject({ retryAfterMs: 7000 })
  })

  it('NIEJEDNOZNACZNY po 5xx: przesyłka powstała → odszukanie po referencji daje OK, bez drugiego POST', async () => {
    const a = inpostAtrapa()
    const ad = wlaczony(a)
    // atrapa tworzy przesyłkę, ale klient dostaje 504 (np. brama po wykonaniu)
    a.reply({ status: 504, body: '' })
    a.shipments.push({ id: 777, reference: 'ref-amb', body: {} })
    const r = await executeWrite(ad, 'ref-amb', () => ad.createShipment(REQ, 'ref-amb'))
    expect(r).toEqual({ kind: 'OK', reference: 'ref-amb', externalRef: '777' })
    expect(a.calls.map((c) => `${c.method} ${c.path} ${c.query['reference'] ?? ''}`.trim())).toEqual([`POST /v1/organizations/${INPOST_ORG}/shipments`, `GET /v1/organizations/${INPOST_ORG}/shipments ref-amb`])
  })

  it('NIEJEDNOZNACZNY, lista nie pokazuje przesyłki → zostaje NIEJEDNOZNACZNY (bez automatycznego ponowienia, druga płatna przesyłka niemożliwa)', async () => {
    const a = inpostAtrapa()
    const ad = wlaczony(a)
    a.reply('network-error')
    const r = await executeWrite(ad, 'ref-n', () => ad.createShipment(REQ, 'ref-n'))
    expect(r.kind).toBe('NIEJEDNOZNACZNY')
    expect(mayRetry(r)).toBe(false)
    expect(r).toMatchObject({ message: expect.stringContaining('rozstrzyga człowiek') })
    // jeden POST i jedno odszukanie: nikt nie ponowił utworzenia
    expect(a.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    await expect(ad.findByReference('ref-n')).rejects.toMatchObject({ kind: 'TRWALY' })
  })

  it('API ignoruje filtr referencji → zostaje NIEJEDNOZNACZNY (nie zgadujemy „nie ma”)', async () => {
    const a = inpostAtrapa()
    const ad = wlaczony(a)
    await ad.createShipment(REQ, 'ref-inna')
    a.ignoreReferenceFilter()
    a.reply({ status: 502, body: '' })
    const r = await executeWrite(ad, 'ref-q', () => ad.createShipment(REQ, 'ref-q'))
    expect(r.kind).toBe('NIEJEDNOZNACZNY')
    for (const p of PII_SENTINELS) expect(JSON.stringify(r)).not.toContain(p)
  })

  it('etykieta: PDF jako base64 z rodzajem treści; pusta = błąd', async () => {
    const a = inpostAtrapa()
    const ad = wlaczony(a)
    const l = await ad.getLabel('900001', 'PDF')
    expect(l.contentType).toBe('application/pdf')
    expect(Buffer.from(l.base64, 'base64').toString()).toMatch(/^%PDF/)
    expect(a.calls[0]).toMatchObject({ method: 'GET', path: '/v1/shipments/900001/label', query: { format: 'Pdf' } })
    a.reply({ status: 200, body: '' })
    await expect(ad.getLabel('900001', 'ZPL')).rejects.toThrow(/pusta etykieta/)
    await expect(ad.getLabel('../1', 'PDF')).rejects.toThrow(/Zły identyfikator/)
  })

  it('strażnik zapisu: poza czterema operacjami wyjątek przed wysyłką (odczyt jednej przesyłki dozwolony)', () => {
    for (const [m, p] of [
      ['POST', `/v1/organizations/${INPOST_ORG}/dispatch_orders`],
      ['DELETE', '/v1/shipments/1'],
      ['POST', `/v1/organizations/${INPOST_ORG}/webhooks`],
      ['PUT', `/v1/organizations/${INPOST_ORG}/shipments`],
      ['POST', '/v1/shipments/1/label'],
      ['POST', '/v1/shipments/1'],
      ['GET', '/v1/shipments/1/cancel'],
    ]) expect(() => assertInpostZapis(m!, p!)).toThrow(ReadOnlyViolation)
    expect(() => assertInpostZapis('POST', `/v1/organizations/${INPOST_ORG}/shipments`)).not.toThrow()
    expect(() => assertInpostZapis('GET', '/v1/shipments/1')).not.toThrow()
  })
})

describe('śledzenie przesyłki (shipment.track)', () => {
  it('stanShipX: paczka u InPost, przed nadaniem albo nieznany status (bez zmiany)', () => {
    for (const s of ['taken_by_courier', 'collected_from_sender', 'dispatched_by_sender', 'out_for_delivery']) expect(stanShipX(s)).toBe('PRZEKAZANA')
    // doręczenie z tego samego odczytu kończy śledzenie po „Wysłane”
    expect(stanShipX('delivered')).toBe('DORECZONA')
    for (const s of ['created', 'confirmed', 'offer_selected']) expect(stanShipX(s)).toBe('PRZED_NADANIEM')
    for (const s of ['cos_nowego', null]) expect(stanShipX(s)).toBe('NIEZNANY')
    // po przekazaniu (zwrot też był wysyłką) i anulowanie: koniec śledzenia bez zmiany statusu zamówienia
    expect(stanShipX('returned_to_sender')).toBe('PRZEKAZANA')
    expect(stanShipX('canceled')).toBe('ANULOWANA')
  })

  it('trackShipment: jeden GET przesyłki, status z odpowiedzi; bez wyłącznika zapisu odmowa bez żądania', async () => {
    const a = inpostAtrapa()
    a.ustawStatus(900123, 'taken_by_courier')
    const ad = adapter(INPOST_SHIPX_ZAPIS_KEY, a.fetchImpl, { zapisWlaczony: true })
    expect(hasShipmentTracker(ad)).toBe(true)
    if (!hasShipmentTracker(ad)) throw new Error('bez shipment.track')
    expect(await ad.trackShipment('900123')).toEqual({ stan: 'PRZEKAZANA', status: 'taken_by_courier', stanDrogi: 'PRZEKAZANA', kod: 'taken_by_courier' })
    expect(a.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/shipments/900123'])
    await expect(ad.trackShipment('../org')).rejects.toThrow(/Zły identyfikator/)
    const b = inpostAtrapa()
    const wyl = adapter(INPOST_SHIPX_ZAPIS_KEY, b.fetchImpl, {})
    if (!hasShipmentTracker(wyl)) throw new Error('bez shipment.track')
    await expect(wyl.trackShipment('900123')).rejects.toThrow('zapis wyłączony')
    expect(b.calls).toHaveLength(0)
  })

  it('503 = błąd przejściowy (worker spróbuje w następnym przebiegu)', async () => {
    const a = inpostAtrapa()
    a.reply({ status: 503, body: '' })
    const ad = adapter(INPOST_SHIPX_ZAPIS_KEY, a.fetchImpl, { zapisWlaczony: true })
    if (!hasShipmentTracker(ad)) throw new Error('bez shipment.track')
    await expect(ad.trackShipment('900123')).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
  })

  it('404 przesyłki = stan nieznany, nie koniec śledzenia (zły adres usługi albo token innej organizacji też dają 404)', async () => {
    const a = inpostAtrapa()
    a.reply({ status: 404, body: '{"error":"resource_not_found"}' })
    const ad = adapter(INPOST_SHIPX_ZAPIS_KEY, a.fetchImpl, { zapisWlaczony: true })
    if (!hasShipmentTracker(ad)) throw new Error('bez shipment.track')
    expect(await ad.trackShipment('900123')).toEqual({ stan: 'NIEZNANY', status: null, stanDrogi: 'NIEZNANY', kod: null })
  })
})
