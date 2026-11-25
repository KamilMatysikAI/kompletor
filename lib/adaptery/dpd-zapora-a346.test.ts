// odczyt żywego konta DPD 20.11.2026: `postalCode` to GET z parametrami
// w adresie (specyfikacja DPDServices REST); POST z treścią JSON zapora DPD odrzuca stroną HTML „Request Rejected” przy
// HTTP 200. Adapter pyta GET-em, a stronę zapory (odczyt i zapis) zamienia w czytelny błąd zamiast „nieczytelna odpowiedź”.
import { describe, expect, it } from 'vitest'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, DPD_WAYBILL, dpdAtrapa, NADAWCA_TESTOWY, ODBIORCA_TESTOWY, type DpdReply } from '../../tests/dpd-atrapa'
import { DPD_KEY, DPD_ZAPIS_KEY } from './dpd'
import { defaultRegistry } from './domyslne'
import { hasShipmentCreator, type PreparedParcel } from './kontrakt'

const FAST = { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 }
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'dpd', name: 'DPD' }
const SECRETS = { DPD_LOGIN, DPD_PASSWORD }
const BASIC = Buffer.from(`${DPD_LOGIN}:${DPD_PASSWORD}`).toString('base64')

/** Strona zapory DPD w kształcie z żywego konta (20.11.2026); identyfikator fikcyjny. */
const ZAPORA: DpdReply = {
  status: 200,
  body: '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 1234567890123456789<br><br><a href=\'javascript:history.back();\'>[Go Back]</a></body></html>',
}

const adapter = (key: string, fetchImpl: ReturnType<typeof dpdAtrapa>['fetchImpl'], config: Record<string, unknown> = {}) =>
  defaultRegistry().create(key, { integration, rawConfig: { baseUrl: DPD_DEMO, payerFid: DPD_FID, ...config }, rawSecrets: SECRETS, fetch: fetchImpl, http: FAST })

const GOTOWA: PreparedParcel = { courierCode: 'DPD_CLASSIC', gabaryt: 'DPD', sideXCm: 40, sideYCm: 30, sideZCm: 20, weightKg: 1.5, codAmount: null, pickupPoint: null, problems: [] }

describe('Sprawdź połączenie DPD wg specyfikacji (GET postalCode)', () => {
  it('GET z countryCode i zipCode w adresie, bez treści, Basic Auth i x-dpd-fid, bez przekierowań', async () => {
    const a = dpdAtrapa()
    const r = await adapter(DPD_KEY, a.fetchImpl, { masterFid: '9999' }).testConnection()
    expect(r.ok).toBe(true)
    expect(a.calls).toHaveLength(1)
    const c = a.calls[0]!
    expect(c.method).toBe('GET')
    expect(c.body).toBeNull()
    expect(c.redirect).toBe('error')
    const u = new URL(c.url)
    expect(u.pathname).toBe('/public/routing/v1/postalCode')
    expect(Object.fromEntries(u.searchParams)).toEqual({ countryCode: 'PL', zipCode: '02274' })
    expect(c.headers).toMatchObject({ Authorization: `Basic ${BASIC}`, 'x-dpd-fid': '9999', Accept: 'application/json' })
    expect(c.headers['Content-Type']).toBeUndefined()
  })

  it('strona zapory „Request Rejected” przy HTTP 200 = czytelny błąd, trwały, bez ponawiania i bez treści strony', async () => {
    const a = dpdAtrapa([ZAPORA, ZAPORA])
    const r = await adapter(DPD_KEY, a.fetchImpl).testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/zapora DPD odrzuciła żądanie/)
    expect(r.message).not.toMatch(/nieczytelna/)
    expect(r.message).not.toContain('1234567890123456789')
    expect(r.details).toEqual({ rodzaj: 'TRWALY' })
    expect(a.calls).toHaveLength(1)
  })

  it('404 POSTAL_CODE_NOT_FOUND nie występuje dla stałego kodu; 401 dalej = trwały „HTTP 401”', async () => {
    const r = await adapter(DPD_KEY, dpdAtrapa([{ status: 401, body: '' }]).fetchImpl).testConnection()
    expect(r).toMatchObject({ ok: false, details: { rodzaj: 'TRWALY' } })
    expect(r.message).toMatch(/HTTP 401/)
  })
})

describe('zapora DPD przy zapisie', () => {
  const zapisowy = (fetchImpl: ReturnType<typeof dpdAtrapa>['fetchImpl']) => {
    const a = adapter(DPD_ZAPIS_KEY, fetchImpl, { nadawca: JSON.stringify(NADAWCA_TESTOWY), zapisWlaczony: true })
    if (!hasShipmentCreator(a)) throw new Error('bez shipment.create')
    return a
  }

  it('createShipment: strona zapory = NIEJEDNOZNACZNY „zapora DPD odrzuciła żądanie” (do sprawdzenia w panelu DPD), jedno żądanie', async () => {
    const a = dpdAtrapa([ZAPORA])
    const r = await zapisowy(a.fetchImpl).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: ODBIORCA_TESTOWY }, 'ref-z1')
    expect(r.kind).toBe('NIEJEDNOZNACZNY')
    expect('message' in r ? r.message : '').toMatch(/zapora DPD odrzuciła żądanie/)
    expect(a.calls).toHaveLength(1)
  })

  it('createShipment: odmowa 403 pokazuje powód z odpowiedzi DPD (pole, kod, opis), bez surowej treści', async () => {
    const a = dpdAtrapa([{ status: 403, body: JSON.stringify({ errors: [{ field: 'packages[0].payerFID', code: 'DISALLOWED_FID', userMessage: 'Payer not allowed' }], traceId: 't-1' }) }])
    const r = await zapisowy(a.fetchImpl).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: ODBIORCA_TESTOWY }, 'ref-z403')
    expect(r.kind).toBe('TRWALY')
    expect('message' in r ? r.message : '').toMatch(/HTTP 403 \(packages\[0\]\.payerFID: DISALLOWED_FID: Payer not allowed\)/)
    expect('message' in r ? r.message : '').not.toMatch(/traceId|t-1/)
    expect(a.calls).toHaveLength(1)
  })

  it('createShipment: odmowa 403 z samym statusem DPD (DISALLOWED_FID) i 400 z listą validationInfo pokazują powód', async () => {
    const a = dpdAtrapa([{ status: 403, body: JSON.stringify({ status: 'DISALLOWED_FID', traceId: 't-2' }) }, { status: 400, body: JSON.stringify({ status: 'INCORRECT_DATA', packages: [{ validationInfo: [{ errorCode: 'INCORRECT_PUDO', info: 'Incorrect pudo identifier' }] }] }) }])
    const r1 = await zapisowy(a.fetchImpl).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: ODBIORCA_TESTOWY }, 'ref-z403c')
    expect('message' in r1 ? r1.message : '').toMatch(/HTTP 403 \(DISALLOWED_FID\)/)
    const r2 = await zapisowy(a.fetchImpl).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: ODBIORCA_TESTOWY }, 'ref-z400c')
    expect('message' in r2 ? r2.message : '').toMatch(/HTTP 400 \(INCORRECT_PUDO: Incorrect pudo identifier; INCORRECT_DATA\)/)
  })

  it('createShipment: opis błędu DPD z echem danych z żądania i JSON bez znanych pól nie niosą danych odbiorcy', async () => {
    const nazwa = ODBIORCA_TESTOWY.imieNazwisko ?? 'brak'
    const a = dpdAtrapa([
      { status: 400, body: JSON.stringify({ status: 'INCORRECT_DATA', packages: [{ validationInfo: [{ errorCode: 'INCORRECT_RECEIVER_NAME', info: `Niepoprawna nazwa odbiorcy ${nazwa}` }] }] }) },
      { status: 400, body: JSON.stringify({ receiver: { name: nazwa }, cos: 1 }) },
    ])
    const r1 = await zapisowy(a.fetchImpl).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: ODBIORCA_TESTOWY }, 'ref-zecho1')
    expect('message' in r1 ? r1.message : '').toMatch(/INCORRECT_RECEIVER_NAME: Niepoprawna nazwa odbiorcy \*\*\*/)
    expect('message' in r1 ? r1.message : '').not.toContain(nazwa)
    const r2 = await zapisowy(a.fetchImpl).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: ODBIORCA_TESTOWY }, 'ref-zecho2')
    expect('message' in r2 ? r2.message : '').toMatch(/pola odpowiedzi: receiver, cos/)
    expect('message' in r2 ? r2.message : '').not.toContain(nazwa)
  })

  it('createShipment: odmowa 403 bez JSON-u zostaje samym kodem HTTP', async () => {
    const a = dpdAtrapa([{ status: 403, body: '<html>Forbidden</html>' }])
    const r = await zapisowy(a.fetchImpl).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: ODBIORCA_TESTOWY }, 'ref-z403b')
    expect('message' in r ? r.message : '').toMatch(/HTTP 403 \(.*treść pominięta\)$/)
    expect('message' in r ? r.message : '').not.toMatch(/Forbidden/)
  })

  it('getLabel: strona zapory = błąd „zapora DPD odrzuciła żądanie”', async () => {
    const a = dpdAtrapa([ZAPORA])
    await expect(zapisowy(a.fetchImpl).getLabel(DPD_WAYBILL, 'PDF')).rejects.toThrow(/zapora DPD odrzuciła żądanie/)
  })

  it('zwykła treść nie-JSON po zapisie (bez znamion zapory) zostaje NIEJEDNOZNACZNA', async () => {
    const a = dpdAtrapa([{ status: 200, body: 'ups' }])
    const r = await zapisowy(a.fetchImpl).createShipment({ carrier: 'DPD', parcel: GOTOWA, recipient: ODBIORCA_TESTOWY }, 'ref-z2')
    expect(r.kind).toBe('NIEJEDNOZNACZNY')
  })
})
