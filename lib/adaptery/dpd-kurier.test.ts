// Zamówienie kuriera DPD w module `dpd.services.zapis.v1` (zdolność shipment.pickup): wyłącznik konta, treść żądania z
// danych firmy i paczek dnia, odpowiedź DPD (numer zlecenia, odmowa bez danych z żądania). Atrapa DPD, zero połączeń.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, json, NADAWCA_TESTOWY } from '../../tests/dpd-atrapa'
import { DPD_SCIEZKA_KURIER } from '../zrodla/dpd-kurier'
import { DPD_KEY, DPD_MANIFEST, DPD_ZAPIS_KEY, DPD_ZAPIS_MANIFEST } from './dpd'
import { defaultRegistry } from './domyslne'
import { hasPickupAvailability, hasPickupOrderer, type PickupOrderRequest } from './kontrakt'

const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'dpd', name: 'DPD' }
const WLACZONE = { zapisWlaczony: true, zamawianieKuriera: true, nadawca: JSON.stringify(NADAWCA_TESTOWY) }
const adapter = (fetchImpl: ReturnType<typeof dpdAtrapa>['fetchImpl'], config: Record<string, unknown> = WLACZONE, key = DPD_ZAPIS_KEY) =>
  defaultRegistry().create(key, { integration, rawConfig: { baseUrl: DPD_DEMO, payerFid: DPD_FID, ...config }, rawSecrets: { DPD_LOGIN, DPD_PASSWORD }, fetch: fetchImpl, http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 } })

const ZLECENIE: PickupOrderRequest = { data: '2026-11-23', odMin: 13 * 60, doMin: 15 * 60, paczki: [{ wagaKg: 1.5, wymiaryCm: [40, 30, 20] }, { wagaKg: 2.25, wymiaryCm: [20, 50, 10] }] }
const OK = json({ status: { status: 'OK' }, orderNumber: 'ZK-123', checkSum: 'cs-9' })

describe('zamówienie kuriera DPD (shipment.pickup)', () => {
  it('manifest: zdolność tylko w module z zapisem, pole konta „Zamawianie kuriera z Kompletora” (tak/nie, domyślnie brak)', () => {
    expect(DPD_ZAPIS_MANIFEST.capabilities).toContain('shipment.pickup')
    expect(DPD_MANIFEST.capabilities).not.toContain('shipment.pickup')
    expect(DPD_ZAPIS_MANIFEST.config.find((f) => f.key === 'zamawianieKuriera')).toMatchObject({ type: 'boolean', required: false, description: expect.stringContaining('Zamawianie kuriera z Kompletora') })
    expect(hasPickupOrderer(adapter(dpdAtrapa().fetchImpl, {}, DPD_KEY))).toBe(false)
    expect(hasPickupOrderer(adapter(dpdAtrapa().fetchImpl))).toBe(true)
  })

  it('wyłączone zamawianie kuriera albo wyłączony zapis = odmowa bez żadnego żądania', async () => {
    for (const config of [{ ...WLACZONE, zamawianieKuriera: undefined }, { ...WLACZONE, zapisWlaczony: false }]) {
      const a = dpdAtrapa()
      const ad = adapter(a.fetchImpl, config)
      if (!hasPickupOrderer(ad)) throw new Error('brak zdolności')
      expect(await ad.zamowOdbior(ZLECENIE, 'ref-k')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('wyłączone') })
      expect(a.calls).toEqual([])
    }
  })

  it('treść packagesPickupCall: dzień i okno, FID płatnika, nadawca firmy, suma wag i największe wymiary; wynik = numer zlecenia', async () => {
    const a = dpdAtrapa([OK])
    const ad = adapter(a.fetchImpl)
    if (!hasPickupOrderer(ad)) throw new Error('brak zdolności')
    expect(await ad.zamowOdbior(ZLECENIE, 'ref-k')).toEqual({ kind: 'OK', reference: 'ref-k', externalRef: 'ZK-123', sumaKontrolna: 'cs-9' })
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]).toMatchObject({ path: DPD_SCIEZKA_KURIER, method: 'POST' })
    expect(a.calls[0]!.body).toMatchObject({
      orderType: 'DOMESTIC',
      pickupDate: '2026-11-23',
      pickupTimeFrom: '13:00',
      pickupTimeTo: '15:00',
      packagesForCollection: {
        payer: { number: Number(DPD_FID) },
        sender: { name: NADAWCA_TESTOWY.name, city: NADAWCA_TESTOWY.city, postalCode: '00002', phone: NADAWCA_TESTOWY.phone },
        packagesParams: { parcel: { count: 2, weight: 3.75, maxWeight: 2.25, maxDepth: 50, maxWidth: 30, maxHeight: 20 } },
      },
    })
  })

  it('odmowa DPD w treści (VALIDATION_ERROR) = TRWALY z opisem DPD, bez danych nadawcy z żądania', async () => {
    const a = dpdAtrapa([json({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'E1', description: `zły telefon ${NADAWCA_TESTOWY.phone}`, fields: ['sender.phone'] }] } })])
    const ad = adapter(a.fetchImpl)
    if (!hasPickupOrderer(ad)) throw new Error('brak zdolności')
    const r = await ad.zamowOdbior(ZLECENIE, 'ref-k')
    expect(r).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('VALIDATION_ERROR') })
    expect((r as { message: string }).message).toContain('sender.phone')
    expect((r as { message: string }).message).not.toContain(NADAWCA_TESTOWY.phone)
  })

  it('HTTP 200 ze statusem spoza pewnych odmów i numerem zlecenia = NIEJEDNOZNACZNY; pewna odmowa z numerem i nieznany błąd bez numeru = TRWALY', async () => {
    const wynik = async (odp: unknown) => {
      const ad = adapter(dpdAtrapa([json(odp)]).fetchImpl)
      if (!hasPickupOrderer(ad)) throw new Error('brak zdolności')
      return ad.zamowOdbior(ZLECENIE, 'ref-k')
    }
    for (const status of ['UNKNOWN_ERROR', 'SERVICE_UNAVAILABLE']) expect(await wynik({ orderNumber: 'ZK-7', status: { status } })).toMatchObject({ kind: 'NIEJEDNOZNACZNY', message: expect.stringContaining('nie zamawiaj drugi raz') })
    expect(await wynik({ orderNumber: 'ZK-7', status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'INCORRECT_PICKUP_TIME', fields: 'pickupTimeFrom' }] } })).toMatchObject({ kind: 'TRWALY' })
    expect(await wynik({ orderNumber: '0', status: { status: 'UNKNOWN_ERROR' } })).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('UNKNOWN_ERROR') })
  })

  it('przerwane połączenie = NIEJEDNOZNACZNY po jednym żądaniu; OK bez numeru zlecenia też NIEJEDNOZNACZNY', async () => {
    const a = dpdAtrapa([{ error: new Error('ECONNRESET') }])
    const ad = adapter(a.fetchImpl)
    if (!hasPickupOrderer(ad)) throw new Error('brak zdolności')
    expect(await ad.zamowOdbior(ZLECENIE, 'ref-k')).toMatchObject({ kind: 'NIEJEDNOZNACZNY' })
    expect(a.calls).toHaveLength(1)
    const b = dpdAtrapa([json({ status: { status: 'OK' } })])
    const bd = adapter(b.fetchImpl)
    if (!hasPickupOrderer(bd)) throw new Error('brak zdolności')
    expect(await bd.zamowOdbior(ZLECENIE, 'ref-k')).toMatchObject({ kind: 'NIEJEDNOZNACZNY' })
  })

  it('braki przed żądaniem (bez paczek, bez nadawcy, złe okno) = TRWALY bez żądania', async () => {
    const a = dpdAtrapa()
    const ad = adapter(a.fetchImpl)
    const bez = adapter(a.fetchImpl, { ...WLACZONE, nadawca: undefined })
    if (!hasPickupOrderer(ad) || !hasPickupOrderer(bez)) throw new Error('brak zdolności')
    expect(await ad.zamowOdbior({ ...ZLECENIE, paczki: [] }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('brak paczek') })
    expect(await ad.zamowOdbior({ ...ZLECENIE, odMin: 900, doMin: 800 }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('okno godzin') })
    expect(await bez.zamowOdbior(ZLECENIE, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('nadawcy') })
    expect(a.calls).toEqual([])
  })
})

describe('zamówienie kuriera DPD: wymiary paczek', () => {
  it('paczki bez wymiarów biorą domyślne wymiary z konta; bez domyślnych = odmowa bez żądania', async () => {
    const a = dpdAtrapa([OK])
    const ad = adapter(a.fetchImpl, { ...WLACZONE, defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20 })
    if (!hasPickupOrderer(ad)) throw new Error('brak zdolności')
    expect(await ad.zamowOdbior({ ...ZLECENIE, paczki: [{ wagaKg: 1 }, { wagaKg: 2 }] }, 'r')).toMatchObject({ kind: 'OK' })
    expect(a.calls[0]!.body).toMatchObject({ packagesForCollection: { packagesParams: { parcel: { count: 2, weight: 3, maxDepth: 40, maxWidth: 30, maxHeight: 20 } } } })
    const b = dpdAtrapa()
    const bd = adapter(b.fetchImpl)
    if (!hasPickupOrderer(bd)) throw new Error('brak zdolności')
    expect(await bd.zamowOdbior({ ...ZLECENIE, paczki: [{ wagaKg: 1 }] }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('domyślnych wymiarów') })
    expect(b.calls).toEqual([])
  })
})

describe('dostępność kuriera DPD (courierOrderAvailability)', () => {
  const DOSTEPNOSC = '/public/courierorder/v1/courierOrderAvailability'
  it('tylko moduł z zapisem; jedno żądanie GET (odczyt) z kodem pocztowym nadawcy bez kreski, bez treści', async () => {
    expect(hasPickupAvailability(adapter(dpdAtrapa().fetchImpl, {}, DPD_KEY))).toBe(false)
    const a = dpdAtrapa([json({ status: 'OK', ranges: [{ offset: 360, range: '09:00-17:00' }, { offset: 180, range: '14:00-17:00' }], traceId: 't' })])
    const ad = adapter(a.fetchImpl)
    if (!hasPickupAvailability(ad)) throw new Error('brak zdolności')
    expect(await ad.dostepnoscOdbioru({ timeoutMs: 8000 })).toEqual({ stan: 'OK', przedzialy: [{ odMin: 540, doMin: 1020, offsetMin: 360 }, { odMin: 840, doMin: 1020, offsetMin: 180 }] })
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]).toMatchObject({ path: DOSTEPNOSC, method: 'GET', body: null })
    expect(new URL(a.calls[0]!.url).searchParams.get('zipCode')).toBe('00002')
    expect(new URL(a.calls[0]!.url).searchParams.get('countryCode')).toBe('PL')
  })
  it('odczyt nie wymaga włączonego zamawiania (nic nie zamawia); RANGE_NOT_FOUND = BRAK', async () => {
    const a = dpdAtrapa([json({ status: 'RANGE_NOT_FOUND', traceId: 't' })])
    const ad = adapter(a.fetchImpl, { ...WLACZONE, zamawianieKuriera: undefined })
    if (!hasPickupAvailability(ad)) throw new Error('brak zdolności')
    expect(await ad.dostepnoscOdbioru({ timeoutMs: 8000 })).toEqual({ stan: 'BRAK' })
  })
  it('błąd HTTP (także 5xx) albo zły status = wyjątek po jednej próbie, bez kodu pocztowego w komunikacie', async () => {
    for (const odp of [json({ errors: [] }, 400), json({}, 503), json({ status: 'POSTAL_CODE_NOT_FOUND' })]) {
      const a = dpdAtrapa([odp, odp, odp])
      const ad = adapter(a.fetchImpl, WLACZONE)
      if (!hasPickupAvailability(ad)) throw new Error('brak zdolności')
      const e = await ad.dostepnoscOdbioru({ timeoutMs: 8000 }).then(() => null, (x: unknown) => x as Error)
      expect(e?.message).toMatch(/DPD/)
      expect(e?.message).not.toContain('00002')
      expect(a.calls).toHaveLength(1)
    }
  })
  it('limit czasu: zawieszone żądanie przerwane po `timeoutMs`', async () => {
    const wisi = (_u: string, init?: RequestInit) => new Promise<Response>((_, blad) => init?.signal?.addEventListener('abort', () => blad(new Error('aborted'))))
    const ad = adapter(wisi as never, WLACZONE)
    if (!hasPickupAvailability(ad)) throw new Error('brak zdolności')
    await expect(ad.dostepnoscOdbioru({ timeoutMs: 30 })).rejects.toThrow()
  })
  it('bez kodu pocztowego nadawcy = wyjątek bez żądania', async () => {
    const a = dpdAtrapa()
    const ad = adapter(a.fetchImpl, { ...WLACZONE, nadawca: JSON.stringify({ ...NADAWCA_TESTOWY, postalCode: '' }) })
    if (!hasPickupAvailability(ad)) throw new Error('brak zdolności')
    await expect(ad.dostepnoscOdbioru({ timeoutMs: 8000 })).rejects.toThrow(/kodu pocztowego/)
    expect(a.calls).toEqual([])
  })
})

// Zamówienie kuriera woła wyłącznie host z bramkami i rezerwacją wiersza (lib/wysylka/zamowienie-kuriera.ts).
describe('zamowOdbior woła tylko host zamawiania kuriera', () => {
  const ROOT = join(__dirname, '..', '..')
  const DOZWOLONE = new Set(['lib/adaptery/kontrakt.ts', 'lib/adaptery/dpd.ts', 'lib/wysylka/zamowienie-kuriera.ts'])
  function pliki(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      if (n === 'node_modules' || n.startsWith('.')) return []
      return statSync(p).isDirectory() ? pliki(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
    })
  }
  it('w lib/, worker/, app/ i scripts/ nikt poza hostem nie woła zamowOdbior ani klienta DpdKurier', () => {
    const naruszenia = ['lib', 'worker', 'app', 'scripts']
      .flatMap((d) => pliki(join(ROOT, d)))
      .map((p) => relative(ROOT, p).split('\\').join('/'))
      .filter((p) => !DOZWOLONE.has(p) && p !== 'lib/zrodla/dpd-kurier.ts' && /\.zamowOdbior\s*\(|new DpdKurier\s*\(/.test(readFileSync(join(ROOT, p), 'utf8')))
    expect(naruszenia).toEqual([])
  })
})
