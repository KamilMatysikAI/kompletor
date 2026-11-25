// Klient zamówienia kuriera DPD: jedna ścieżka zapisu, jedno żądanie bez ponawiania, odmowa bez danych z żądania.
import { describe, expect, it } from 'vitest'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, json } from '../../tests/dpd-atrapa'
import { DPD_SCIEZKA_KURIER, DpdKurier } from './dpd-kurier'
import { ReadOnlyViolation } from './http'

const AUTH = { login: DPD_LOGIN, password: DPD_PASSWORD, fid: DPD_FID }
const klient = (a: ReturnType<typeof dpdAtrapa>) => new DpdKurier({ baseUrl: DPD_DEMO, auth: AUTH, fetchImpl: a.fetchImpl, wylacznik: true })
const TRESC = { pickupDate: '2026-11-23', packagesForCollection: { sender: { name: 'Magazyn Atrapowy', phone: '500600700' } } }

describe('klient zamówienia kuriera DPD', () => {
  it('bez jawnego wyłącznika klient nie powstaje', () => {
    expect(() => new DpdKurier({ baseUrl: DPD_DEMO, auth: AUTH, fetchImpl: dpdAtrapa().fetchImpl } as never)).toThrow(/wyłącznika/)
  })

  it('POST packagesPickupCall z Basic Auth i x-dpd-fid, bez przekierowań; odpowiedź JSON wraca do adaptera', async () => {
    const a = dpdAtrapa([json({ status: { status: 'OK' }, orderNumber: 'ZK-1', checkSum: 'abc' })])
    const r = await klient(a).zamow(TRESC)
    expect(r).toEqual({ ok: true, body: { status: { status: 'OK' }, orderNumber: 'ZK-1', checkSum: 'abc' } })
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]).toMatchObject({ path: DPD_SCIEZKA_KURIER, method: 'POST', redirect: 'error', body: TRESC })
    expect(a.calls[0]!.headers['x-dpd-fid']).toBe(DPD_FID)
  })

  it('przerwane połączenie i 5xx = NIEJEDNOZNACZNY po jednym żądaniu (bez ponawiania)', async () => {
    const a = dpdAtrapa([{ error: new Error('socket hang up') }])
    expect(await klient(a).zamow(TRESC)).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY', message: expect.stringContaining('nie wiadomo, czy DPD przyjął zamówienie kuriera') })
    expect(a.calls).toHaveLength(1)
    const b = dpdAtrapa([json({}, 503)])
    expect(await klient(b).zamow(TRESC)).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
    expect(b.calls).toHaveLength(1)
  })

  it('odmowa 400 pokazuje powód DPD bez wartości z żądania; login i hasło nie trafiają do komunikatu', async () => {
    const a = dpdAtrapa([json({ errors: [{ field: 'sender.phone', code: 'INVALID', userMessage: `zły numer 500600700 dla Magazyn Atrapowy (${DPD_LOGIN})` }] }, 400)])
    const r = await klient(a).zamow(TRESC)
    expect(r).toMatchObject({ ok: false, kind: 'TRWALY', message: expect.stringContaining('sender.phone: INVALID') })
    const m = (r as { message: string }).message
    for (const s of ['500600700', 'Magazyn Atrapowy', DPD_LOGIN, DPD_PASSWORD]) expect(m).not.toContain(s)
  })

  it('429 = PRZEJSCIOWY (DPD nie przyjął żądania)', async () => {
    expect(await klient(dpdAtrapa([json({}, 429)])).zamow(TRESC)).toMatchObject({ ok: false, kind: 'PRZEJSCIOWY' })
  })

  it('strona zapory albo nieczytelna odpowiedź po wysłaniu = NIEJEDNOZNACZNY', async () => {
    const a = dpdAtrapa([{ status: 200, body: '<html><title>Request Rejected</title>The requested URL was rejected</html>' }])
    expect(await klient(a).zamow(TRESC)).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
  })

  it('jedyna dozwolona ścieżka to zamówienie kuriera: inna = wyjątek przed wysyłką', async () => {
    const a = dpdAtrapa()
    await expect(klient(a).post('/public/shipment/v1/generatePackagesNumbers', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(a.calls).toEqual([])
  })
})
