// adaptery `dpd.services.v1` i `dpd.services.zapis.v1` na atrapie HTTP. Dane fikcyjne, zero połączeń (także
// z demo DPD): tryb „przygotuj, nie wysyłaj”, zapis tylko za wyłącznikiem.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, DPD_WAYBILL, dpdAtrapa, json, NADAWCA_TESTOWY, ODBIORCA_TESTOWY, type DpdReply } from '../../tests/dpd-atrapa'
import { assertDpdReadOnly, DpdReadOnly } from '../zrodla/dpd'
import { DpdZapis } from '../zrodla/dpd-zapis'
import { ReadOnlyViolation, SourceError } from '../zrodla/http'
import { DPD_DEFINITION, DPD_KEY, DPD_ZAPIS_DEFINITION, DPD_ZAPIS_KEY } from './dpd'
import { defaultRegistry } from './domyslne'
import { hasShipmentCreator, hasShipmentPreparer, type ChannelAdapter, type PreparedParcel, type ShipmentCreator, type ShipmentInput } from './kontrakt'
import { validateAccountConfig } from './rejestr'
import { PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'

const FAST = { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 }
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'dpd', name: 'DPD' }
const AUTH = { login: DPD_LOGIN, password: DPD_PASSWORD, fid: DPD_FID }
const SECRETS = { DPD_LOGIN, DPD_PASSWORD }
const BASIC = Buffer.from(`${DPD_LOGIN}:${DPD_PASSWORD}`).toString('base64')

function adapter(key: string, fetchImpl: ReturnType<typeof dpdAtrapa>['fetchImpl'], config: Record<string, unknown> = {}): ChannelAdapter {
  return defaultRegistry().create(key, { integration, rawConfig: { baseUrl: DPD_DEMO, payerFid: DPD_FID, ...config }, rawSecrets: SECRETS, fetch: fetchImpl, http: FAST })
}

function zapisowy(fetchImpl: ReturnType<typeof dpdAtrapa>['fetchImpl'], config: Record<string, unknown> = {}): ChannelAdapter & ShipmentCreator {
  const a = adapter(DPD_ZAPIS_KEY, fetchImpl, { nadawca: JSON.stringify(NADAWCA_TESTOWY), ...config })
  if (!hasShipmentCreator(a)) throw new Error('bez shipment.create')
  return a
}

for (const key of [DPD_KEY, DPD_ZAPIS_KEY]) {
  runAdapterContract({
    name: key,
    now: new Date('2026-11-02T10:00:00Z'),
    setup() {
      const a = dpdAtrapa()
      return {
        adapter: adapter(key, a.fetchImpl),
        putOrder: () => {},
        corruptOrder: () => {},
        failNextList: () => {},
        requests: () => a.calls.map((c) => c.method),
        readMethods: ['GET'],
      }
    },
  })
}

// Każda ścieżka DPDServices, która coś tworzy, zmienia albo kosztuje, z sekcji „Fakty o API”.
const ZAPISY = [
  '/public/shipment/v1/generatePackagesNumbers',
  '/public/shipment/v1/generateSpedLabels',
  '/public/shipment/v1/generateProtocol',
  '/public/shipment/v1/appendParcelsToPackage',
  '/public/courierorder/v1/packagesPickupCall',
  '/public/routing/v1/postalCode/',
  '/public/routing/v1/postalcode',
  '/public/routing/v1/postalCode?x=1',
  '/nieznana',
  '',
]

describe('strażnik tylko-do-odczytu', () => {
  it.each(ZAPISY)('„%s” = ReadOnlyViolation przed wysyłką', async (path) => {
    const a = dpdAtrapa()
    expect(() => assertDpdReadOnly(path)).toThrow(ReadOnlyViolation)
    await expect(new DpdReadOnly(DPD_DEMO, AUTH, a.fetchImpl, 0, FAST.retry).get(path)).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(a.calls).toHaveLength(0)
  })

  it.each(['/public/routing/v1/postalCode', '/public/courierorder/v1/courierOrderAvailability'])('„%s” przechodzi', (path) => {
    expect(() => assertDpdReadOnly(path)).not.toThrow()
  })

  it('tylko dwa hosty DPD; zły FID i brak hasła odrzucone', () => {
    for (const url of ['https://dpdservices.dpd.com.pl', 'https://dpdservicesdemo.dpd.com.pl/']) expect(() => new DpdReadOnly(url, AUTH)).not.toThrow()
    for (const url of ['http://dpdservices.dpd.com.pl', 'https://dpdservices.dpd.com.pl.example.invalid', 'https://mypudo.dpd.com.pl', 'https://zly.example.invalid', 'https://dpdservices.dpd.com.pl/api']) {
      expect(() => new DpdReadOnly(url, AUTH)).toThrow(/adres API DPD/)
    }
    expect(() => new DpdReadOnly(DPD_DEMO, { ...AUTH, fid: 'abc' })).toThrow(/FID/)
    expect(() => new DpdReadOnly(DPD_DEMO, { ...AUTH, password: '' })).toThrow(/hasła/)
    expect(() => defaultRegistry().create(DPD_KEY, { integration, rawConfig: { baseUrl: 'https://zly.example.invalid', payerFid: DPD_FID }, rawSecrets: SECRETS, fetch: dpdAtrapa().fetchImpl })).toThrow()
  })
})

describe('klient HTTP odczytu', () => {
  it('GET z parametrami w adresie, Basic Auth i x-dpd-fid, bez przekierowań; hasło nie w adresie', async () => {
    const a = dpdAtrapa([json({ status: 'OK' })])
    await new DpdReadOnly(`${DPD_DEMO}/`, AUTH, a.fetchImpl, 0, FAST.retry).get('/public/routing/v1/postalCode', { zipCode: '02274' })
    expect(a.calls[0]).toMatchObject({ url: `${DPD_DEMO}/public/routing/v1/postalCode?zipCode=02274`, method: 'GET', redirect: 'error', body: null })
    expect(a.calls[0]!.headers).toMatchObject({ Authorization: `Basic ${BASIC}`, 'x-dpd-fid': DPD_FID })
    expect(a.calls[0]!.url).not.toContain(DPD_PASSWORD)
  })

  it('401 i 403 bez ponawiania; 429 i 5xx ponawiane, potem błąd przejściowy', async () => {
    for (const status of [401, 403]) {
      const a = dpdAtrapa([{ status, body: 'odmowa' }])
      const e = await new DpdReadOnly(DPD_DEMO, AUTH, a.fetchImpl, 0, FAST.retry).get('/public/routing/v1/postalCode').catch((x: unknown) => x)
      expect((e as SourceError).retryable).toBe(false)
      expect(a.calls).toHaveLength(1)
    }
    for (const status of [429, 503]) {
      const a = dpdAtrapa([{ status, body: '' }, { status, body: '' }])
      const e = await new DpdReadOnly(DPD_DEMO, AUTH, a.fetchImpl, 0, FAST.retry).get('/public/routing/v1/postalCode').catch((x: unknown) => x)
      expect((e as SourceError).retryable).toBe(true)
      expect(a.calls).toHaveLength(2)
    }
  })

  it('hasło, login i nagłówek Basic nie trafiają do komunikatu błędu (wartownik)', async () => {
    const a = dpdAtrapa([{ error: new Error(`socket hang up ${DPD_PASSWORD} ${DPD_LOGIN} ${BASIC}`) }])
    const e = await new DpdReadOnly(DPD_DEMO, AUTH, a.fetchImpl, 0, { attempts: 1, baseDelayMs: 0 }).get('/public/routing/v1/postalCode').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(SourceError)
    for (const s of [DPD_PASSWORD, DPD_LOGIN, BASIC]) expect((e as Error).message).not.toContain(s)
    const n = dpdAtrapa([{ status: 200, body: `<html>${DPD_PASSWORD}</html>` }])
    const e2 = await new DpdReadOnly(DPD_DEMO, AUTH, n.fetchImpl, 0, FAST.retry).get('/public/routing/v1/postalCode').catch((x: unknown) => x)
    expect((e2 as Error).message).toMatch(/nieczytelna odpowiedź/)
    expect((e2 as Error).message).not.toContain(DPD_PASSWORD)
  })
})

describe('adapter dpd.services.v1', () => {
  it('w rejestrze jako przewoźnik tylko do odczytu, z sekretami i zdolnością przygotowania', () => {
    const { manifest } = DPD_DEFINITION
    expect(defaultRegistry().get(DPD_KEY)?.manifest).toBe(manifest)
    expect(manifest).toMatchObject({ kind: 'carrier', capabilities: ['shipment.prepare'], readOnly: true })
    // dane DPDInfoServices opcjonalne i w obu modułach DPD: jeden zestaw kluczy = jedno konto przewoźnika w panelu
    expect(manifest.secrets.map((s) => [s.name, s.required])).toEqual([['DPD_LOGIN', true], ['DPD_PASSWORD', true], ['DPD_MYPUDO_KEY', false], ['DPD_SLEDZENIE_LOGIN', false], ['DPD_SLEDZENIE_HASLO', false]])
    expect(DPD_ZAPIS_DEFINITION.manifest.secrets.map((s) => s.name)).toEqual(manifest.secrets.map((s) => s.name))
    expect(manifest.config.map((c) => c.key)).toEqual(expect.arrayContaining(['baseUrl', 'masterFid', 'payerFid', 'empikPayerFid', 'labelFormat', 'defaultSideXCm', 'defaultSideYCm', 'defaultSideZCm', 'defaultWeightKg', 'limitWagiKuriera', 'codLimit', 'envPrefix']))
    // martwe ustawienie labelOutput usunięte (format etykiety przychodzi w argumencie getLabel)
    expect(manifest.config.map((c) => c.key)).not.toContain('labelOutput')
    expect(manifest.config.map((c) => c.key)).not.toContain('zapisWlaczony')
    expect(() => defaultRegistry().create(DPD_KEY, { integration, rawConfig: { baseUrl: DPD_DEMO, payerFid: DPD_FID }, rawSecrets: {}, fetch: dpdAtrapa().fetchImpl })).toThrow()
    expect(validateAccountConfig(manifest, { baseUrl: DPD_DEMO, payerFid: 'FID-1' }).problems).toEqual([expect.stringContaining('payerFid')])
    expect(validateAccountConfig(manifest, { baseUrl: DPD_DEMO, payerFid: DPD_FID, labelFormat: 'A5' }).problems).toEqual([expect.stringContaining('labelFormat')])
    const a = adapter(DPD_KEY, dpdAtrapa().fetchImpl)
    expect(hasShipmentPreparer(a)).toBe(true)
    expect(hasShipmentCreator(a)).toBe(false)
  })

  it('testConnection przez kod pocztowy: OK bez przepisywania odpowiedzi, nagłówek z masterFid', async () => {
    const a = dpdAtrapa()
    const r = await adapter(DPD_KEY, a.fetchImpl, { masterFid: '9999' }).testConnection()
    expect(r).toEqual({ ok: true, message: 'zapytanie o kod pocztowy działa (środowisko demo)' })
    expect(a.calls.map((c) => c.path)).toEqual(['/public/routing/v1/postalCode'])
    expect(a.calls[0]!.headers['x-dpd-fid']).toBe('9999')
  })

  it.each([
    ['401', [{ status: 401, body: 'x' }], /HTTP 401/, 'TRWALY'],
    ['403', [{ status: 403, body: 'x' }], /HTTP 403/, 'TRWALY'],
    ['429', [{ status: 429, body: '' }, { status: 429, body: '' }], /HTTP 429/, 'PRZEJSCIOWY'],
    ['5xx', [{ status: 502, body: '' }, { status: 502, body: '' }], /HTTP 502/, 'PRZEJSCIOWY'],
    ['pusta treść', [{ status: 200, body: '' }], /pusta odpowiedź/, 'TRWALY'],
    ['pusty obiekt', [json({})], /nieczytelna/, 'TRWALY'],
    ['nie JSON', [{ status: 200, body: 'ups' }], /nieczytelna/, 'TRWALY'],
    ['odmowa w treści', [json({ status: 'ERROR', message: `zły login ${DPD_PASSWORD}` })], /odrzucił/, 'TRWALY'],
    ['błąd sieci', [{ error: new Error(`ECONNRESET ${DPD_PASSWORD}`) }, { error: new Error(`ECONNRESET ${DPD_PASSWORD}`) }], /błąd sieci/, 'PRZEJSCIOWY'],
  ] as [string, DpdReply[], RegExp, string][])('testConnection: %s = ok false, rodzaj, bez hasła', async (_n, replies, re, rodzaj) => {
    const r = await adapter(DPD_KEY, dpdAtrapa(replies).fetchImpl).testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(re)
    expect(r.details).toEqual({ rodzaj })
    expect(JSON.stringify(r)).not.toContain(DPD_PASSWORD)
    expect(JSON.stringify(r)).not.toContain(BASIC)
  })

  it('prepareShipment nie woła sieci i używa ustawień z konfiguracji', () => {
    const a = dpdAtrapa()
    const ad = adapter(DPD_KEY, a.fetchImpl, { defaultSideXCm: 50, defaultSideYCm: 40, defaultSideZCm: 30, defaultWeightKg: 2 })
    if (!hasShipmentPreparer(ad)) throw new Error('bez shipment.prepare')
    const input: ShipmentInput = { carrier: 'DPD', gabaryt: 'DPD', weightG: null, weightComplete: false, paymentState: 'PAID', paymentMethod: 'Przelew', totalGross: 100, codAmountUncertain: null, pickupPoint: null }
    expect(ad.prepareShipment(input)).toMatchObject({ courierCode: 'DPD_CLASSIC', sideXCm: 50, sideYCm: 40, sideZCm: 30, weightKg: 2, codAmount: null, pickupPoint: null })
    expect(a.calls).toHaveLength(0)
  })
})

const GOTOWA: PreparedParcel = { courierCode: 'DPD_CLASSIC', gabaryt: 'DPD', sideXCm: 40, sideYCm: 30, sideZCm: 20, weightKg: 1.5, codAmount: null, pickupPoint: null, problems: [] }
const REKORD = ODBIORCA_TESTOWY

describe('adapter dpd.services.zapis.v1: wyłącznik', () => {
  it('manifest: przewoźnik z zapisem, zdolność shipment.create, wyłącznik w konfiguracji', () => {
    const { manifest } = DPD_ZAPIS_DEFINITION
    // reference.find (tylko potwierdza paczkę)
    expect(manifest).toMatchObject({ kind: 'carrier', capabilities: ['shipment.prepare', 'shipment.create', 'reference.find', 'shipment.track', 'shipment.pickup'], readOnly: false })
    expect(manifest.config.find((c) => c.key === 'zapisWlaczony')).toMatchObject({ type: 'boolean', required: false })
    expect(hasShipmentCreator(adapter(DPD_ZAPIS_KEY, dpdAtrapa().fetchImpl))).toBe(true)
  })

  it.each([[{}], [{ zapisWlaczony: false }], [{ zapisWlaczony: 'false' }]])('bez zapisWlaczony (%j): TRWALY „zapis wyłączony”, getLabel rzuca, 0 żądań', async (config) => {
    const a = dpdAtrapa()
    const ad = zapisowy(a.fetchImpl, config)
    expect(await ad.createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: REKORD }, 'ref-1')).toEqual({ kind: 'TRWALY', reference: 'ref-1', message: 'zapis wyłączony' })
    await expect(ad.getLabel(DPD_WAYBILL, 'PDF')).rejects.toThrow(/zapis wyłączony/)
    expect(a.calls).toHaveLength(0)
  })

  it('klient zapisu wymaga jawnego wyłącznika i odmawia protokołu, kuriera i dopisywania paczek', async () => {
    expect(() => new DpdZapis({ baseUrl: DPD_DEMO, auth: AUTH } as never)).toThrow(/wyłącznika/)
    expect(() => new DpdZapis({ baseUrl: DPD_DEMO, auth: AUTH, wylacznik: 'tak' } as never)).toThrow(/wyłącznika/)
    const a = dpdAtrapa()
    const k = new DpdZapis({ baseUrl: DPD_DEMO, auth: AUTH, fetchImpl: a.fetchImpl, wylacznik: true })
    for (const p of ['/public/shipment/v1/generateProtocol', '/public/courierorder/v1/packagesPickupCall', '/public/shipment/v1/appendParcelsToPackage', '/public/routing/v1/postalCode']) {
      await expect(k.post(p, {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    }
    expect(a.calls).toHaveLength(0)
  })

  it('włączony: jedno żądanie generatePackagesNumbers, OK z numerem listu, bez danych odbiorcy w wyniku', async () => {
    const a = dpdAtrapa()
    const ad = zapisowy(a.fetchImpl, { zapisWlaczony: true })
    const r = await ad.createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: REKORD }, 'ORD-1/1')
    expect(r).toEqual({ kind: 'OK', reference: 'ORD-1/1', externalRef: DPD_WAYBILL })
    expect(a.calls.map((c) => c.path)).toEqual(['/public/shipment/v1/generatePackagesNumbers'])
    expect(a.calls[0]!.body).toMatchObject({ generationPolicy: 'ALL_OR_NOTHING', packages: [{ reference: 'ORD-1/1', payerFID: Number(DPD_FID), receiver: { name: PII_SENTINELS[0] } }] })
    for (const p of PII_SENTINELS) expect(JSON.stringify(r)).not.toContain(p)
  })

  it.each([
    ['timeout / błąd sieci', [{ error: new Error('aborted') }], 'NIEJEDNOZNACZNY'],
    ['5xx', [{ status: 502, body: '' }], 'NIEJEDNOZNACZNY'],
    ['nieczytelna odpowiedź 200', [{ status: 200, body: 'ups' }], 'NIEJEDNOZNACZNY'],
    ['OK bez numeru listu', [json({ status: 'OK', packages: [] })], 'NIEJEDNOZNACZNY'],
    ['429', [{ status: 429, body: '' }], 'PRZEJSCIOWY'],
    ['401', [{ status: 401, body: '' }], 'TRWALY'],
    ['400', [{ status: 400, body: '' }], 'TRWALY'],
  ] as [string, DpdReply[], string][])('włączony, %s → %s, jedno żądanie (bez ślepego ponowienia)', async (_n, replies, kind) => {
    const a = dpdAtrapa([...replies, json({ status: 'OK' })])
    const r = await zapisowy(a.fetchImpl, { zapisWlaczony: true }).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: REKORD }, 'ref-2')
    expect(r.kind).toBe(kind)
    expect(a.calls).toHaveLength(1)
    if (kind === 'NIEJEDNOZNACZNY' && r.kind !== 'OK') expect(r.message).toMatch(/po referencji/)
    for (const s of [...PII_SENTINELS, DPD_PASSWORD]) expect(JSON.stringify(r)).not.toContain(s)
  })

  it('odmowa DPD: TRWALY z kodami błędów, bez tekstów z danymi', async () => {
    const odp = json({ status: 'INCORRECT_DATA', packages: [{ status: 'INCORRECT_DATA', validationDetails: [{ errorCode: 'INCORRECT_PUDO', info: `punkt ${PII_SENTINELS[0]}` }], parcels: [{ status: 'INCORRECT_DATA', validationDetails: [{ errorCode: 'SIZE_X_OUT_OF_RANGE', info: 'x' }] }] }] })
    const r = await zapisowy(dpdAtrapa([odp]).fetchImpl, { zapisWlaczony: true }).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: REKORD }, 'ref-3')
    expect(r).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('INCORRECT_PUDO') })
    if (r.kind !== 'OK') expect(r.message).toContain('SIZE_X_OUT_OF_RANGE')
    expect(JSON.stringify(r)).not.toContain(PII_SENTINELS[0])
  })

  it('niegotowa przesyłka, brak nadawcy, niepełny odbiorca: TRWALY bez żądania', async () => {
    const a = dpdAtrapa()
    const ad = zapisowy(a.fetchImpl, { zapisWlaczony: true })
    const ostrz = { ...GOTOWA, problems: [{ kod: 'waga_domyslna', poziom: 'OSTRZEZENIE' as const, tekst: 'x' }] }
    expect(await ad.createShipment({ carrier: 'DPD', parcel: ostrz, recipient: REKORD }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('waga_domyslna') })
    expect(await ad.createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: { ...REKORD, ulica: null } }, 'r')).toMatchObject({ kind: 'TRWALY', message: 'niepełne dane odbiorcy: ulica' })
    expect(await ad.createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: { ...REKORD, kraj: 'DE' } }, 'r')).toMatchObject({ kind: 'TRWALY', message: 'odbiorca spoza Polski: moduł DPD jest krajowy (kraj)' })
    const bezNadawcy = zapisowy(a.fetchImpl, { zapisWlaczony: true, nadawca: JSON.stringify({ name: 'Firma' }) })
    expect(await bezNadawcy.createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: REKORD }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('brak danych nadawcy') })
    expect(await ad.createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: REKORD }, 'x'.repeat(51))).toMatchObject({ kind: 'TRWALY' })
    expect(a.calls).toHaveLength(0)
  })

  it('salon Empik: FID płatnika Empik, gdy firma go ma', async () => {
    const a = dpdAtrapa()
    const empik: PreparedParcel = { ...GOTOWA, courierCode: 'DPD_PICKUP', pickupPoint: 'PL12345', problems: [{ kod: 'empik_niepotwierdzone', poziom: 'OSTRZEZENIE', tekst: 'x' }] }
    const ad = zapisowy(a.fetchImpl, { zapisWlaczony: true, empikPayerFid: '7777' })
    // ostrzeżenie Empik bez potwierdzenia blokuje zapis
    expect(await ad.createShipment({ carrier: 'DPD_EMPIK', parcel: empik, recipient: REKORD }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('empik_niepotwierdzone') })
    expect(a.calls).toHaveLength(0)
    // potwierdzenie przez kontrakt; FID Empik po przewoźniku, także gdy host zdjął ostrzeżenie z listy
    expect(await ad.createShipment({ carrier: 'DPD_EMPIK', parcel: empik, recipient: REKORD, potwierdzoneOstrzezenia: ['empik_niepotwierdzone'] }, 'r-e1')).toMatchObject({ kind: 'OK' })
    expect(a.calls[0]!.body).toMatchObject({ packages: [{ payerFID: 7777 }] })
    expect(await ad.createShipment({ carrier: 'DPD_EMPIK', parcel: { ...empik, problems: [] }, recipient: REKORD }, 'r-e2')).toMatchObject({ kind: 'OK' })
    expect(a.calls[1]!.body).toMatchObject({ packages: [{ payerFID: 7777 }] })
    // zwykły DPD bez FID Empik
    expect(await ad.createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: REKORD }, 'r-d')).toMatchObject({ kind: 'OK' })
    expect(a.calls[2]!.body).toMatchObject({ packages: [{ payerFID: Number(DPD_FID) }] })
  })

  it('Allegro/Woo bez numeru domu i bez telefonu i e-maila: paczka przechodzi, adres z samej ulicy', async () => {
    const a = dpdAtrapa()
    const ad = zapisowy(a.fetchImpl, { zapisWlaczony: true })
    const r = await ad.createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: { ...REKORD, numerDomu: null, telefon: null, email: null } }, 'r-a077')
    expect(r).toMatchObject({ kind: 'OK' })
    const rec = (a.calls[0]!.body as { packages: { receiver: Record<string, unknown> }[] }).packages[0]!.receiver
    expect(rec).toEqual({ name: PII_SENTINELS[0], address: PII_SENTINELS[3], city: 'Testowo', postalCode: '00001', countryCode: 'PL' })
  })

  it('getLabel przy włączonym zapisie: generateSpedLabels, PDF w base64', async () => {
    const a = dpdAtrapa()
    const l = await zapisowy(a.fetchImpl, { zapisWlaczony: true }).getLabel(DPD_WAYBILL, 'PDF')
    expect(l.contentType).toBe('application/pdf')
    expect(Buffer.from(l.base64, 'base64').toString()).toBe('%PDF-fikcyjna-etykieta')
    expect(a.calls.map((c) => c.path)).toEqual(['/public/shipment/v1/generateSpedLabels'])
    expect(a.calls[0]!.body).toMatchObject({ outputDocFormat: 'PDF', format: 'LBL_PRINTER' })
    await expect(zapisowy(a.fetchImpl, { zapisWlaczony: true }).getLabel('../x', 'PDF')).rejects.toThrow(/numer listu/)
  })
})

// Trzeci warunek wyłącznika: zapis woła tylko host przesyłek. Jedynym hostem jest lib/wysylka/nadanie.ts
// (bramki trybu PRACA i `zapisWlaczony`, rezerwacja przed wywołaniem, executeWrite). Każde inne miejsce = nowy host,
// który wymaga osobnego zadania i GO.
describe('createShipment woła tylko host przesyłek', () => {
  const ROOT = join(__dirname, '..', '..')
  // pliki adapterów przewoźników z zapisem (DPD i InPost) i kontrakt
  const DOZWOLONE = new Set(['lib/adaptery/kontrakt.ts', 'lib/adaptery/dpd.ts', 'lib/adaptery/inpost.ts', 'lib/adaptery/inpost-zapis.ts', 'lib/adaptery/orlenpaczka.ts', 'lib/adaptery/gls.ts', 'lib/adaptery/pocztapolska.ts', 'lib/wysylka/nadanie.ts'])
  function pliki(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      if (n === 'node_modules' || n.startsWith('.')) return []
      return statSync(p).isDirectory() ? pliki(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
    })
  }

  it('w lib/, worker/, app/ i scripts/ poza adapterami i hostem (lib/wysylka/nadanie.ts) nie ma wywołania createShipment ani getLabel przewoźnika', () => {
    const naruszenia = ['lib', 'worker', 'app', 'scripts']
      .flatMap((d) => pliki(join(ROOT, d)))
      .map((p) => relative(ROOT, p).split('\\').join('/'))
      .filter((p) => !DOZWOLONE.has(p) && /\.(createShipment|getLabel)\s*\(/.test(readFileSync(join(ROOT, p), 'utf8')))
    expect(naruszenia).toEqual([])
  })
})
