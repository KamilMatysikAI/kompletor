// odszukanie paczki DPD po referencji i numer nadania ShipX. Atrapy w pamięci, dane fikcyjne, zero
// połączeń z DPD i InPost. Kształt odpowiedzi DPD przy wyszukiwaniu po referencji jest [NIEPEWNE] (do demo DPD), więc
// testy pilnują przede wszystkim zasady: odszukanie DPD tylko potwierdza paczkę, nigdy jej nie wyklucza.
import { describe, expect, it } from 'vitest'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, DPD_WAYBILL, dpdAtrapa, json, NADAWCA_TESTOWY } from '../../tests/dpd-atrapa'
import { INPOST_ORG, INPOST_SANDBOX, INPOST_TOKEN, inpostAtrapa } from '../../tests/inpost-atrapa'
import { InpostZapis } from '../zrodla/inpost-zapis'
import { DPD_ZAPIS_KEY, numerListuDlaReferencji, statusyOdpowiedziOk } from './dpd'
import { defaultRegistry } from './domyslne'
import { AdapterError, hasReferenceFinder, type ChannelAdapter, type WriteOutcome } from './kontrakt'
import { executeWrite } from './zapis'

const REF = '6f1c2b3a-1d2e-5f60-8a1b-0c2d3e4f5a6b'
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'dpd', name: 'DPD' }

function dpd(fetchImpl: ReturnType<typeof dpdAtrapa>['fetchImpl'], config: Record<string, unknown> = { zapisWlaczony: true }): ChannelAdapter {
  return defaultRegistry().create(DPD_ZAPIS_KEY, {
    integration,
    rawConfig: { baseUrl: DPD_DEMO, payerFid: DPD_FID, nadawca: JSON.stringify(NADAWCA_TESTOWY), ...config },
    rawSecrets: { DPD_LOGIN, DPD_PASSWORD },
    fetch: fetchImpl,
    http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 },
  })
}

const odpowiedz = (packages: unknown[]) => json({ status: 'OK', documentData: Buffer.from('%PDF-x').toString('base64'), session: { statusInfo: { status: 'OK' }, packages } })

describe('DPD findByReference: tylko potwierdza', () => {
  it('paczka z tą referencją i jednym numerem listu = found z numerem; zapytanie to etykieta z packages[].reference', async () => {
    const a = dpdAtrapa([odpowiedz([{ reference: REF, parcels: [{ waybill: DPD_WAYBILL }] }])])
    const ad = dpd(a.fetchImpl)
    expect(hasReferenceFinder(ad)).toBe(true)
    if (!hasReferenceFinder(ad)) return
    await expect(ad.findByReference(REF)).resolves.toEqual({ found: true, externalRef: DPD_WAYBILL })
    expect(a.calls.map((c) => c.path)).toEqual(['/public/shipment/v1/generateSpedLabels'])
    expect(a.calls[0]!.body).toMatchObject({ labelSearchParams: { session: { packages: [{ reference: REF }] } } })
  })

  it.each([
    ['brak paczek (kształt odpowiedzi niepotwierdzony)', [], /bez paczek/],
    ['paczka z inną referencją (filtr nie zadziałał)', [{ reference: 'inna', parcels: [{ waybill: DPD_WAYBILL }] }], /inną referencją/],
    ['dwie paczki z tą samą referencją', [{ reference: REF, parcels: [{ waybill: DPD_WAYBILL }] }, { reference: REF, parcels: [{ waybill: '0000999999999U' }] }], /kilka paczek/],
    ['paczka bez numeru listu', [{ reference: REF, parcels: [] }], /bez jednego numeru/],
    // echo referencji z numerem, ale ze statusem błędu
    ['echo referencji ze statusem PACKAGE_NOT_FOUND', [{ reference: REF, status: 'PACKAGE_NOT_FOUND', parcels: [{ waybill: DPD_WAYBILL }] }], /status paczki/],
    ['list ze statusem błędu', [{ reference: REF, parcels: [{ waybill: DPD_WAYBILL, status: 'NOT_FOUND' }] }], /status paczki/],
    ['paczka ze statusInfo z kodem błędu', [{ reference: REF, statusInfo: { status: 'OK', errorCode: 'SESSION_EXPIRED' }, parcels: [{ waybill: DPD_WAYBILL }] }], /status paczki/],
  ])('%s = błąd TRWALY, nigdy found:false', async (_n, packages, re) => {
    const ad = dpd(dpdAtrapa([odpowiedz(packages)]).fetchImpl)
    if (!hasReferenceFinder(ad)) throw new Error('bez reference.find')
    const e = await ad.findByReference(REF).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AdapterError)
    expect((e as AdapterError).kind).toBe('TRWALY')
    expect((e as Error).message).toMatch(re)
  })

  it('5xx przy odszukaniu = PRZEJSCIOWY (etykieta nie tworzy paczki), wyłączony zapis = bez żądania', async () => {
    const ad = dpd(dpdAtrapa([{ status: 503, body: '' }]).fetchImpl)
    if (!hasReferenceFinder(ad)) throw new Error('bez reference.find')
    await expect(ad.findByReference(REF)).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    const a = dpdAtrapa()
    const off = dpd(a.fetchImpl, {})
    if (!hasReferenceFinder(off)) throw new Error('bez reference.find')
    await expect(off.findByReference(REF)).rejects.toThrow(/wyłączony/)
    expect(a.calls).toEqual([])
  })

  it('executeWrite: timeout przy tworzeniu + potwierdzenie po referencji = OK z numerem; brak potwierdzenia = zostaje NIEJEDNOZNACZNY', async () => {
    const ok = dpd(dpdAtrapa([odpowiedz([{ reference: REF, parcels: [{ waybill: DPD_WAYBILL }] }])]).fetchImpl)
    const niejasny = async (): Promise<WriteOutcome> => ({ kind: 'NIEJEDNOZNACZNY', reference: REF, message: 'timeout' })
    await expect(executeWrite(ok, REF, niejasny)).resolves.toEqual({ kind: 'OK', reference: REF, externalRef: DPD_WAYBILL })
    const brak = dpd(dpdAtrapa([odpowiedz([])]).fetchImpl)
    await expect(executeWrite(brak, REF, niejasny)).resolves.toMatchObject({ kind: 'NIEJEDNOZNACZNY' })
  })

  it('numerListuDlaReferencji czyta też odpowiedź bez „session” na wierzchu', () => {
    expect(numerListuDlaReferencji({ packages: [{ reference: REF, parcels: [{ waybill: DPD_WAYBILL }] }] }, REF)).toBe(DPD_WAYBILL)
  })

  it('statusy OK (paczka, list, statusInfo, puste errors) potwierdzają; status sesji inny niż OK nie', () => {
    const p = { reference: REF, status: 'OK', statusInfo: { status: 'OK', errors: [] }, parcels: [{ waybill: DPD_WAYBILL, status: 'ok' }] }
    expect(numerListuDlaReferencji({ session: { statusInfo: { status: 'OK' }, packages: [p] } }, REF)).toBe(DPD_WAYBILL)
    expect(() => numerListuDlaReferencji({ session: { statusInfo: { status: 'DISALLOWED_FID' }, packages: [p] } }, REF)).toThrow(/status paczki/)
  })
})

describe('status DPD na wszystkich poziomach odpowiedzi', () => {
  const doc = Buffer.from('%PDF-x').toString('base64')

  it('statusyOdpowiedziOk: wierzch, sesja, paczki i listy (także bez sesji na wierzchu); brak pól = bez sprzeciwu', () => {
    expect(statusyOdpowiedziOk({ documentData: doc })).toBe(true)
    expect(statusyOdpowiedziOk({ status: 'OK', session: { statusInfo: { status: 'OK' }, packages: [{ status: 'OK', parcels: [{ status: 'OK' }] }] } })).toBe(true)
    expect(statusyOdpowiedziOk({ status: 'ERROR' })).toBe(false)
    expect(statusyOdpowiedziOk({ session: { status: 'DISALLOWED_FID' } })).toBe(false)
    expect(statusyOdpowiedziOk({ session: { packages: [{ status: 'OK' }, { errorCode: 'PACKAGE_NOT_FOUND' }] } })).toBe(false)
    expect(statusyOdpowiedziOk({ session: { packages: [{ parcels: [{ waybill: DPD_WAYBILL }, { status: 'ERROR' }] }] } })).toBe(false)
    expect(statusyOdpowiedziOk({ packages: [{ parcels: [{ statusInfo: { status: 'OK', errorCode: 'PARCEL_NOT_FOUND' } }] }] })).toBe(false)
  })

  it.each([
    ['list z błędem w sesji', { documentData: doc, session: { packages: [{ parcels: [{ waybill: DPD_WAYBILL, status: 'ERROR' }] }] } }],
    ['paczka z kodem błędu bez sesji', { documentData: doc, packages: [{ errorCode: 'PARCEL_NOT_FOUND' }] }],
    ['sesja ze statusem innym niż OK', { status: 'OK', documentData: doc, session: { statusInfo: { status: 'NOT_FOUND' } } }],
  ])('getLabel: %s = TRWALY mimo niepustego documentData (nic nie trafi do druku)', async (_n, body) => {
    const ad = dpd(dpdAtrapa([json(body)]).fetchImpl) as ChannelAdapter & { getLabel(r: string, f: 'PDF'): Promise<unknown> }
    await expect(ad.getLabel(DPD_WAYBILL, 'PDF')).rejects.toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/odrzucił pobranie etykiety/) })
  })

  it('getLabel: zagnieżdżone statusy OK = etykieta', async () => {
    const ad = dpd(dpdAtrapa([json({ documentData: doc, session: { statusInfo: { status: 'OK' }, packages: [{ status: 'OK', parcels: [{ waybill: DPD_WAYBILL, status: 'OK' }] }] } })]).fetchImpl) as ChannelAdapter & { getLabel(r: string, f: 'PDF'): Promise<{ base64: string }> }
    await expect(ad.getLabel(DPD_WAYBILL, 'PDF')).resolves.toMatchObject({ base64: doc })
  })
})

describe('ShipX getTrackingNumber', () => {
  const klient = (fetchImpl: ReturnType<typeof inpostAtrapa>['fetchImpl']) => new InpostZapis({ baseUrl: INPOST_SANDBOX, token: INPOST_TOKEN, organizationId: INPOST_ORG, wylacznik: true, fetchImpl })

  it('numer z tracking_number; brak numeru = null; GET /v1/shipments/<id>', async () => {
    const a = inpostAtrapa()
    a.reply({ status: 200, body: JSON.stringify({ id: 900001, status: 'confirmed', tracking_number: '520000011395200025754311' }) })
    await expect(klient(a.fetchImpl).getTrackingNumber('900001')).resolves.toBe('520000011395200025754311')
    expect(a.calls[0]).toMatchObject({ method: 'GET', path: '/v1/shipments/900001' })
    a.reply({ status: 200, body: JSON.stringify({ id: 900001, status: 'created', tracking_number: null }) })
    await expect(klient(a.fetchImpl).getTrackingNumber('900001')).resolves.toBeNull()
  })

  it('5xx = PRZEJSCIOWY, 404 = TRWALY, zły id = bez żądania', async () => {
    const a = inpostAtrapa()
    a.reply({ status: 502, body: '' })
    await expect(klient(a.fetchImpl).getTrackingNumber('900001')).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    a.reply({ status: 404, body: '' })
    await expect(klient(a.fetchImpl).getTrackingNumber('900001')).rejects.toMatchObject({ kind: 'TRWALY' })
    const n = a.calls.length
    await expect(klient(a.fetchImpl).getTrackingNumber('../1')).rejects.toThrow(/Zły identyfikator/)
    expect(a.calls.length).toBe(n)
  })
})
