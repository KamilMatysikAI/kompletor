// Adapter `basecourier.zapis.v1` na atrapie Base Courier (tests/basecourier-atrapa.ts, kształt z dokumentacji
// API, wtyczki BLPaczka i odczytu konta). Przesyłki są płatne: zero połączeń z API Base Courier i sandboxem. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { BC_ETYKIETA, BC_KEY, BC_LOGIN, BC_SANDBOX, bcAtrapa, bcJson } from '@/tests/basecourier-atrapa'
import { assertBaseCourierZapis, BASE_COURIER_LISTA_STRONY, BASE_COURIER_LISTA_TIMEOUT_MS, BaseCourierZapis, bezDanych, ODMOWA_BEZ_ZAMOWIENIA_PEWNA, polaWalidacji, sladZamowienia } from '../zrodla/basecourier-zapis'
import { parseUbezpieczenie, zawartoscMaReferencje, zawartoscPrzesylki } from '../wysylka/zlecenie'
import { ReadOnlyViolation } from '../zrodla/http'
import { BASE_COURIER_URL_RE } from '../zrodla/basecourier'
import { wyliczPrzesylke, ustawieniaPrzesylki } from '../wysylka/przesylka'
import { BASE_COURIER_ZAPIS_DEFINITION, BASE_COURIER_ZAPIS_KEY, OKNA_PODJAZDU_KURIEROW } from './basecourier-zapis'
import { defaultRegistry } from './domyslne'
import { hasReferenceFinder, hasShipmentCanceller, hasShipmentCreator, type ChannelAdapter, type RecipientAddress, type ShipmentCreator, type ShipmentInput } from './kontrakt'
import { PII_SENTINELS } from './suita-kontraktowa'
import { executeWrite } from './zapis'

const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'bc', name: 'Base Courier' }
const NADAWCA = JSON.stringify({ name: 'Firma Testowa', address: 'ul. Magazynowa 5', city: 'Poznań', postalCode: '60-001', phone: '611000000', email: 'sklep@example.invalid' })
const KONTO = '11 1111 1111 1111 1111 1111 1111'
const ODBIORCA: RecipientAddress = { imieNazwisko: PII_SENTINELS[0]!, firma: null, ulica: PII_SENTINELS[3]!, numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: PII_SENTINELS[2]!, email: PII_SENTINELS[1]! }
const BAZA: ShipmentInput = { carrier: 'PACZKOMATY', gabaryt: 'INPOST_B', weightG: 800, weightComplete: true, paymentState: 'PAID', paymentMethod: 'Przelewy24', totalGross: 89.9, codAmountUncertain: null, pickupPoint: 'POZ01A' }
const WYMIARY = { defaultSideXCm: 30, defaultSideYCm: 20, defaultSideZCm: 10 }
const paczka = (o: Partial<ShipmentInput> = {}, c: Record<string, unknown> = {}) => wyliczPrzesylke({ ...BAZA, ...o }, ustawieniaPrzesylki(c))

type Ad = ChannelAdapter & ShipmentCreator
function adapter(fetchImpl: ReturnType<typeof bcAtrapa>['fetchImpl'], config: Record<string, unknown> = {}, now?: () => Date): Ad {
  return defaultRegistry().create(BASE_COURIER_ZAPIS_KEY, {
    integration,
    rawConfig: { baseUrl: BC_SANDBOX, nadawca: NADAWCA, kontoPobran: KONTO, defaultSideXCm: 30, defaultSideYCm: 20, defaultSideZCm: 10, ...config },
    rawSecrets: { BASE_COURIER_LOGIN: BC_LOGIN, BASE_COURIER_API_KEY: BC_KEY },
    fetch: fetchImpl,
    ...(now ? { now } : {}),
  }) as Ad
}
const wlaczony = (a: ReturnType<typeof bcAtrapa>, c: Record<string, unknown> = {}, now?: () => Date) => adapter(a.fetchImpl, { zapisWlaczony: true, ...c }, now)
/** Treść żądania utworzenia (przy podjeździe pierwsze idzie odczytanie terminów). */
const utworzenie = (a: ReturnType<typeof bcAtrapa>) => a.calls.find((c) => c.endpoint === 'createOrderV2.json')!.body
const bezPii = (v: unknown) => {
  const t = JSON.stringify(v)
  for (const s of PII_SENTINELS) expect(t).not.toContain(s)
}

describe('manifest i rejestr', () => {
  it('przewoźnik z zapisem, bez odszukania po referencji, z anulowaniem; wyłącznik domyślnie wyłączony', () => {
    const m = BASE_COURIER_ZAPIS_DEFINITION.manifest
    expect(defaultRegistry().get(BASE_COURIER_ZAPIS_KEY)?.manifest).toBe(m)
    expect(m).toMatchObject({ kind: 'carrier', readOnly: false, capabilities: ['shipment.prepare', 'shipment.create', 'shipment.cancel', 'shipment.track'] })
    expect(m.config.find((f) => f.key === 'zapisWlaczony')).toMatchObject({ type: 'boolean', required: false })
    // klucz API jest sekretem konta (panel: Ustawienia → Przewoźnicy), nigdy polem konfiguracji
    expect(m.secrets.map((s) => s.name)).toEqual(['BASE_COURIER_LOGIN', 'BASE_COURIER_API_KEY'])
    expect(m.config.map((f) => f.key)).not.toContain('api_key')
    const a = adapter(bcAtrapa().fetchImpl)
    expect(hasShipmentCreator(a)).toBe(true)
    expect(hasShipmentCanceller(a)).toBe(true)
    expect(hasReferenceFinder(a)).toBe(false)
  })

  it('klient zapisu: tylko osiem endpointów, wyłącznik w konstruktorze, adres tylko Base Courier', () => {
    for (const e of ['createOrderV2.json', 'getWaybill.json', 'cancelOrder.json', 'getOrderDetails.json', 'getOrderDetailsByWaybillNo.json', 'getOrders.json', 'getWaybillTracking.json', 'getPickupDateOptions.json']) expect(() => assertBaseCourierZapis(e)).not.toThrow()
    for (const e of ['downloadWaybillsMerged', 'getValuation.json', 'x']) expect(() => assertBaseCourierZapis(e)).toThrow(ReadOnlyViolation)
    expect(() => new BaseCourierZapis({ baseUrl: BC_SANDBOX, login: BC_LOGIN, apiKey: BC_KEY } as never)).toThrow(/wyłącznika/)
    expect(() => new BaseCourierZapis({ baseUrl: 'https://zly.example.invalid/api', login: BC_LOGIN, apiKey: BC_KEY, wylacznik: true })).toThrow(/adres API/)
  })

  it('adres API: produkcja i sandbox w domenie basecourier.com i blpaczka.com; nic innego', () => {
    for (const u of ['https://api.blpaczka.com/api', 'https://sandbox.blpaczka.com/api/', 'https://api.basecourier.com/api', 'https://sandbox.basecourier.com/api']) expect(BASE_COURIER_URL_RE.test(u)).toBe(true)
    for (const u of ['http://sandbox.basecourier.com/api', 'https://sandbox.basecourier.com.example.invalid/api', 'https://x.basecourier.com/api', 'https://sandbox.basecourier.com', 'https://sandbox.basecourier.com/api/docs', 'https://basecourier.com/api'])
      expect(BASE_COURIER_URL_RE.test(u)).toBe(false)
  })
})

describe('wyłącznik', () => {
  it('bez zapisWlaczony: utworzenie, etykieta, numer i anulowanie bez żadnego żądania', async () => {
    const a = bcAtrapa()
    const ad = adapter(a.fetchImpl)
    expect(await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')).toEqual({ kind: 'TRWALY', reference: 'r', message: 'zapis wyłączony' })
    await expect(ad.getLabel('9100001', 'PDF')).rejects.toThrow(/zapis wyłączony/)
    await expect(ad.getTrackingNumber!('9100001')).rejects.toThrow(/zapis wyłączony/)
    expect(await ad.cancelShipment!('9100001', 'r')).toMatchObject({ kind: 'TRWALY' })
    expect(a.calls).toEqual([])
  })
})

describe('utworzenie przesyłki', () => {
  it('InPost A/B/C: wymiary gabarytu, paczkomat, referencja w „Zawartość przesyłki”, numer listu od razu; jedno żądanie', async () => {
    for (const [gabaryt, x] of [['INPOST_A', 8], ['INPOST_B', 19], ['INPOST_C', 41]] as const) {
      const a = bcAtrapa()
      const ad = wlaczony(a)
      const w = await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka({ gabaryt }), recipient: ODBIORCA, orderExternalId: 'SD-77' }, 'ref-a')
      expect(w).toEqual({ kind: 'OK', reference: 'ref-a', externalRef: '9100001' })
      expect(a.ile('createOrderV2.json')).toBe(1)
      const body = a.calls[0]!.body
      expect(body['CourierSearch']).toMatchObject({ courier_code: 'paczkomaty', side_x: x, side_y: 38, side_z: 64, weight: 0.8, no_pickup: true, origin: 'kompletor' })
      expect(body['CourierSearch']).not.toHaveProperty('uptake')
      expect((body['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order).toMatchObject({ taker_point: 'POZ01A', package_content: 'ref. ref-a; zam. SD-77', name: 'Firma Testowa', street: 'ul. Magazynowa', house_no: '5' })
      expect(body['CartOrder']).toEqual({ payment: 'bank' })
      expect(body['auth']).toEqual({ login: BC_LOGIN, api_key: BC_KEY })
      expect(a.calls[0]!.redirect).toBe('error')
      // numer listu z odpowiedzi utworzenia: bez drugiego żądania
      expect(await ad.getTrackingNumber!('9100001')).toMatch(/^6800\d{10}$/)
      expect(a.calls).toHaveLength(1)
      bezPii(w)
    }
  })

  it('Kurier DPD (wymiary firmy); płatność odroczona i podjazd z ustawień', async () => {
    const a = bcAtrapa()
    const ad = wlaczony(a, { platnosc: 'pay_later', zamawiajPodjazd: true })
    expect(await ad.createShipment({ carrier: 'DPD', parcel: paczka({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null }, WYMIARY), recipient: ODBIORCA }, 'ref-d')).toMatchObject({ kind: 'OK' })
    expect(utworzenie(a)['CourierSearch']).toMatchObject({ courier_code: 'dpd', side_x: 30, side_y: 20, side_z: 10, no_pickup: false, origin: 'kompletor' })
    // kurier DPD do drzwi: `taker_point` pusty (pole wymagane w dokumentacji), rachunek firmy także bez pobrania
    expect((utworzenie(a)['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order).toMatchObject({ taker_point: '', account: '11111111111111111111111111' })
    expect(utworzenie(a)['CartOrder']).toEqual({ payment: 'pay_later' })
  })

  // Base Courier sprawdza punkt na swojej umowie DPD i salonu Empik nie zna (20.11.2026, PL49077: „Punkt
  // odbioru DPD nie istnieje”); BL nadaje salony modułem DPD z konta „DPD Salony Empik”. Odmowa przed żądaniem, nie NIEJEDNOZNACZNA.
  it('salon Empik: odmowa TRWALY z czytelnym komunikatem, bez żądania do Base Courier', async () => {
    const a = bcAtrapa()
    const ad = wlaczony(a)
    const w = await ad.createShipment({ carrier: 'DPD_EMPIK', parcel: paczka({ carrier: 'DPD_EMPIK', gabaryt: 'DPD', pickupPoint: 'PL12345' }, WYMIARY), recipient: ODBIORCA }, 'ref-e')
    expect(w).toMatchObject({ kind: 'TRWALY', reference: 'ref-e' })
    expect('message' in w ? w.message : '').toMatch(/Base Courier nie nadaje paczek do salonów Empik/)
    expect(a.calls).toEqual([])
  })

  it('pobranie: kwota z zamówienia jako uptake, bez ubezpieczenia domyślnie; rachunek zwrotu z ustawień; bez rachunku = odmowa bez żądania', async () => {
    const a = bcAtrapa()
    const cod = paczka({ paymentState: 'COD', totalGross: 123.45 })
    expect(cod.codAmount).toBe(123.45)
    expect(await wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: cod, recipient: ODBIORCA }, 'ref-c')).toMatchObject({ kind: 'OK' })
    expect(a.calls[0]!.body['CourierSearch']).toMatchObject({ uptake: 123.45, foreign: '0' })
    // `cover` (ubezpieczenie, może podnieść cenę) tylko, gdy firma je włączy
    expect(a.calls[0]!.body['CourierSearch']).not.toHaveProperty('cover')
    expect((a.calls[0]!.body['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order).toMatchObject({ account: '11111111111111111111111111' })
    const b = bcAtrapa()
    expect(await wlaczony(b, { kontoPobran: undefined }).createShipment({ carrier: 'PACZKOMATY', parcel: cod, recipient: ODBIORCA }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/rachunku do zwrotu pobrań/) })
    // nieznana kwota pobrania (braki) to BLAD przesyłki: bez żądania
    const niepewna = paczka({ paymentState: 'COD', codAmountUncertain: 'BRAKI' })
    expect(await wlaczony(b).createShipment({ carrier: 'PACZKOMATY', parcel: niepewna, recipient: ODBIORCA }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/pobranie/) })
    expect(b.calls).toEqual([])
  })

  it('ubezpieczenie z reguły: „pobranie” = kwota pobrania (bez pobrania nic), kwota = cover; złe ustawienie = bez', async () => {
    const a = bcAtrapa()
    const cod = paczka({ paymentState: 'COD', totalGross: 50 })
    await wlaczony(a, { ubezpieczenie: 'pobranie' }).createShipment({ carrier: 'PACZKOMATY', parcel: cod, recipient: ODBIORCA }, 'u1')
    expect(a.calls[0]!.body['CourierSearch']).toMatchObject({ uptake: 50, cover: 50 })
    await wlaczony(a, { ubezpieczenie: 'pobranie' }).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'u2')
    expect(a.calls[1]!.body['CourierSearch']).not.toHaveProperty('cover')
    await wlaczony(a, { ubezpieczenie: '200' }).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'u3')
    expect(a.calls[2]!.body['CourierSearch']).toMatchObject({ cover: 200 })
    expect([parseUbezpieczenie(''), parseUbezpieczenie('x'), parseUbezpieczenie('12,50'), parseUbezpieczenie('Pobranie'), parseUbezpieczenie(-1)]).toEqual([null, null, 12.5, 'pobranie', null])
  })

  it('braki przed wysyłką: odbiorca, zagranica, nadawca bez numeru domu, paczkomat bez punktu, niepotwierdzone wartości robocze', async () => {
    const a = bcAtrapa()
    const ad = wlaczony(a)
    expect(await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: { ...ODBIORCA, telefon: null } }, 'r')).toMatchObject({ kind: 'TRWALY', message: 'brak danych odbiorcy: telefon' })
    expect(await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: { ...ODBIORCA, kraj: 'DE' } }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('(kraj)') })
    const zlyNadawca = wlaczony(a, { nadawca: JSON.stringify({ name: 'F', address: 'Bez numeru', city: 'P', postalCode: '60-001', phone: '1' }) })
    expect(await zlyNadawca.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('numer domu') })
    expect(await ad.createShipment({ carrier: 'PACZKOMATY', parcel: { ...paczka(), pickupPoint: null }, recipient: ODBIORCA }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('punktu') })
    const robocze = paczka({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null, weightG: null, weightComplete: false })
    expect(await ad.createShipment({ carrier: 'DPD', parcel: robocze, recipient: ODBIORCA }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('waga_domyslna') })
    expect(await ad.createShipment({ carrier: 'DPD', parcel: robocze, recipient: ODBIORCA, potwierdzoneOstrzezenia: ['waga_domyslna', 'wymiary_domyslne'] }, 'r')).toMatchObject({ kind: 'OK' })
    expect(a.ile('createOrderV2.json')).toBe(1)
  })

  // punkt odbioru (paczkomat, punkt DPD) nie wymaga adresu domowego; kurier dalej wymaga ulicy i numeru
  it('punkt odbioru bez numeru domu albo bez ulicy: żądanie idzie (linia adresu bez zmian, numer pusty); kurier bez numeru = odmowa bez żądania', async () => {
    const a = bcAtrapa()
    const ad = wlaczony(a)
    const niejednoznaczny = { ...ODBIORCA, ulica: 'Testowa 5-7', numerDomu: null }
    expect(await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: niejednoznaczny }, 'p1')).toMatchObject({ kind: 'OK' })
    expect((a.calls[0]!.body['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order).toMatchObject({ taker_point: 'POZ01A', taker_street: 'Testowa 5-7', taker_house_no: '' })
    expect(await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: { ...ODBIORCA, ulica: null, numerDomu: null } }, 'p2')).toMatchObject({ kind: 'OK' })
    const punktDpd = paczka({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: 'PL12345' }, WYMIARY)
    expect(await ad.createShipment({ carrier: 'DPD', parcel: punktDpd, recipient: niejednoznaczny, potwierdzoneOstrzezenia: punktDpd.problems.map((p) => p.kod) }, 'p3')).toMatchObject({ kind: 'OK' })
    expect(a.ile('createOrderV2.json')).toBe(3)
    // kurier do drzwi: numer domu i ulica wymagane jak dotąd
    const kurier = paczka({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null }, WYMIARY)
    expect(await ad.createShipment({ carrier: 'DPD', parcel: kurier, recipient: niejednoznaczny }, 'k1')).toMatchObject({ kind: 'TRWALY', message: 'brak danych odbiorcy: numerDomu' })
    expect(await ad.createShipment({ carrier: 'DPD', parcel: kurier, recipient: { ...ODBIORCA, ulica: null, numerDomu: null } }, 'k2')).toMatchObject({ kind: 'TRWALY', message: 'brak danych odbiorcy: ulica, numerDomu' })
    // punkt nie zwalnia z kodu pocztowego i miasta (pola wymagane przez API Base Courier)
    expect(await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: { ...niejednoznaczny, kodPocztowy: null } }, 'p4')).toMatchObject({ kind: 'TRWALY', message: 'brak danych odbiorcy: kodPocztowy' })
    expect(a.ile('createOrderV2.json')).toBe(3)
  })

  it('odrzucenie z walidacją: TRWALY z nazwami pól i komunikatem bez danych odbiorcy', async () => {
    const a = bcAtrapa()
    const w = await wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: { ...ODBIORCA, kodPocztowy: ' ' } }, 'r')
    // kod pocztowy pusty odpada już u nas; walidację API sprawdzamy na pustym punkcie z kodem paczkomatu
    expect(w).toMatchObject({ kind: 'TRWALY' })
    const b = bcAtrapa()
    b.awarie['createOrderV2.json'] = [bcJson({ success: false, message: `Błąd walidacji dla ${PII_SENTINELS[1]} tel. ${PII_SENTINELS[2]}`, data: { validationErrors: { Cart: [{ Order: { taker_postal: [`zły kod ${PII_SENTINELS[0]}`] } }] } } })]
    const w2 = await wlaczony(b).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r2')
    expect(w2).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('(pola: taker_postal)') })
    expect((w2 as { message: string }).message).toMatch(/^Base Courier odrzucił przesyłkę: Błąd walidacji dla … tel\. …/)
    bezPii(w2)
  })

  it('brak środków (success:false bez zamówienia i bez walidacji) = NIEJEDNOZNACZNY do testu na sandboxie; wariant pewny = TRWALY; odmowa logowania = TRWALY', async () => {
    expect(ODMOWA_BEZ_ZAMOWIENIA_PEWNA).toBe(false)
    const a = bcAtrapa()
    a.awarie['createOrderV2.json'] = [bcJson({ success: false, message: 'Brak wystarczających środków w skarbonce' })]
    const w0 = await executeWrite(wlaczony(a), 'r', () => wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r'))
    expect(w0).toMatchObject({ kind: 'NIEJEDNOZNACZNY', message: expect.stringContaining('Brak wystarczających środków w skarbonce') })
    expect((w0 as { message: string }).message).toContain('Zawartość przesyłki')
    expect(a.ile('createOrderV2.json')).toBe(1)
    // inny 4xx bez treści i bez walidacji: też niejasne; 400 z walidacją: pewny brak
    const c = bcAtrapa()
    c.awarie['createOrderV2.json'] = [{ status: 400, body: 'Bad Request' }, bcJson({ success: false, message: 'Błąd', data: { validationErrors: { Cart: [{ Order: { taker_phone: ['zły'] } }] } } }, 400)]
    expect(await wlaczony(c).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')).toMatchObject({ kind: 'NIEJEDNOZNACZNY', message: expect.stringContaining('HTTP 400') })
    expect(await wlaczony(c).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('(pola: taker_phone)') })
    // wariant po teście na sandboxie (stała na true): pewny brak
    const d = bcAtrapa()
    d.awarie['createOrderV2.json'] = [bcJson({ success: false, message: 'Brak wystarczających środków w skarbonce' })]
    const klient = new BaseCourierZapis({ baseUrl: BC_SANDBOX, login: BC_LOGIN, apiKey: BC_KEY, wylacznik: true, fetchImpl: d.fetchImpl, odmowaBezZamowieniaPewna: true })
    expect((await klient.createOrder({ CourierSearch: {}, Cart: [] }, 'r')).wynik).toEqual({ kind: 'TRWALY', reference: 'r', message: 'Base Courier odrzucił przesyłkę: Brak wystarczających środków w skarbonce' })
    const b = bcAtrapa()
    const zly = defaultRegistry().create(BASE_COURIER_ZAPIS_KEY, { integration, rawConfig: { baseUrl: BC_SANDBOX, nadawca: NADAWCA, zapisWlaczony: true }, rawSecrets: { BASE_COURIER_LOGIN: BC_LOGIN, BASE_COURIER_API_KEY: 'inny' }, fetch: b.fetchImpl }) as Ad
    const w = await zly.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    expect(w).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('odmowa logowania') })
    expect(JSON.stringify(w)).not.toContain('inny')
  })

  it('zgubiona odpowiedź, 5xx, nieczytelna treść, sukces bez id, sprzeczna odpowiedź = NIEJEDNOZNACZNY, zawsze jedno żądanie (bez ponawiania)', async () => {
    const przypadki: [string, Parameters<typeof bcJson>[0] | 'network-error' | 'zgubiona' | { status: number; body: string }][] = [
      ['zgubiona', 'zgubiona'],
      ['sieć', 'network-error'],
      ['502', { status: 502, body: 'Bad Gateway' }],
      ['nieczytelna', { status: 200, body: '<html>' }],
      ['pusta', { status: 200, body: '' }],
      ['bez id', { status: 200, body: JSON.stringify({ success: true, data: {} }) }],
      ['sprzeczna', { status: 200, body: JSON.stringify({ success: false, data: { Order: [{ id: '9100001' }] } }) }],
    ]
    for (const [nazwa, odp] of przypadki) {
      const a = bcAtrapa()
      a.awarie['createOrderV2.json'] = [odp as never]
      const ad = wlaczony(a)
      // przez executeWrite jak host: bez reference.find wynik zostaje NIEJEDNOZNACZNY (człowiek), nigdy PRZEJSCIOWY
      const w = await executeWrite(ad, 'ref-z', () => ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'ref-z'))
      expect(w.kind, nazwa).toBe('NIEJEDNOZNACZNY')
      expect(a.ile('createOrderV2.json'), nazwa).toBe(1)
      expect(JSON.stringify(w)).not.toContain(BC_KEY)
      bezPii(w)
    }
  })

  it('ślad zamówienia w treści (blpaczka_order_id, CartOrder.id, waybill_link, Order przy 4xx) przy niepowodzeniu = NIEJEDNOZNACZNY z numerem; jedno żądanie', async () => {
    const przypadki: [string, { status: number; body: string }, string | null][] = [
      ['success:false + blpaczka_order_id', { status: 200, body: JSON.stringify({ success: false, message: 'Płatność odrzucona', data: { blpaczka_order_id: 9100077, Order: null } }) }, '9100077'],
      ['success:false + CartOrder.id', { status: 200, body: JSON.stringify({ success: false, data: { CartOrder: { id: '9100078', payment: 'bank' } } }) }, '9100078'],
      ['success:false + waybill_link', { status: 200, body: JSON.stringify({ success: false, data: { waybill_link: `${BC_SANDBOX}/waybill/9100079` } }) }, '9100079'],
      ['400 + Order[0].id', { status: 400, body: JSON.stringify({ success: false, message: 'Błąd', data: { Order: [{ id: 9100080 }] } }) }, '9100080'],
      ['429 + blpaczka_order_id', { status: 429, body: JSON.stringify({ data: { blpaczka_order_id: '9100081' } }) }, '9100081'],
      ['503 + Order[0].id', { status: 503, body: JSON.stringify({ success: false, data: { Order: [{ id: '9100082' }] } }) }, '9100082'],
      ['success:true bez Order, z blpaczka_order_id', { status: 200, body: JSON.stringify({ success: true, data: { blpaczka_order_id: 9100083 } }) }, '9100083'],
      ['400 + walidacja + id', { status: 400, body: JSON.stringify({ success: false, data: { blpaczka_order_id: 9100084, validationErrors: { Cart: [{ Order: { taker_postal: ['x'] } }] } } }) }, '9100084'],
    ]
    for (const [nazwa, odp, numer] of przypadki) {
      const a = bcAtrapa()
      a.awarie['createOrderV2.json'] = [odp]
      const ad = wlaczony(a)
      const w = await executeWrite(ad, 'ref-s', () => ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'ref-s'))
      expect(w.kind, nazwa).toBe('NIEJEDNOZNACZNY')
      expect((w as { message: string }).message, nazwa).toContain(`Numer zamówienia w Base Courier: ${numer}`)
      expect(a.ile('createOrderV2.json'), nazwa).toBe(1)
      bezPii(w)
    }
    expect(sladZamowienia({ success: false, message: 'x' })).toBeNull()
    expect(sladZamowienia({ success: false, data: { validationErrors: {} } })).toBeNull()
  })

  it('treść bez `CourierSearch.origin` albo bez pola `taker_point`: odmowa z walidacją (TRWALY, nazwy pól), bez danych odbiorcy', async () => {
    const a = bcAtrapa()
    const k = new BaseCourierZapis({ baseUrl: BC_SANDBOX, login: BC_LOGIN, apiKey: BC_KEY, wylacznik: true, fetchImpl: a.fetchImpl })
    const order = { taker_name: PII_SENTINELS[0], taker_email: PII_SENTINELS[1], taker_postal: '00-001', taker_point: 'POZ01A', package_content: 'ref. r' }
    const bezOrigin = await k.createOrder({ CourierSearch: { courier_code: 'paczkomaty', type: 'package' }, Cart: [{ Order: order }], CartOrder: { payment: 'bank' } }, 'r', [PII_SENTINELS[0]!])
    expect(bezOrigin.wynik).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('pola: origin') })
    const { taker_point: _tp, ...bezPunktu } = order
    const bezPola = await k.createOrder({ CourierSearch: { courier_code: 'dpd', type: 'package', origin: 'kompletor' }, Cart: [{ Order: bezPunktu }], CartOrder: { payment: 'bank' } }, 'r', [PII_SENTINELS[0]!])
    expect(bezPola.wynik).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('pola: taker_point') })
    expect(a.zamowienia).toHaveLength(0)
    bezPii([bezOrigin, bezPola])
    expect(polaWalidacji({ validationErrors: { CourierSearch: { origin: ['x'] }, Cart: [{ Order: { taker_postal: ['y'] } }] } })).toEqual(['origin', 'taker_postal'])
  })

  it('429 = PRZEJSCIOWY z retry-after (zamówienie nie powstało, host może ponowić)', async () => {
    const a = bcAtrapa()
    const fetchImpl = async (url: string, init?: RequestInit) => (url.endsWith('createOrderV2.json') ? new Response('x', { status: 429, headers: { 'retry-after': '30' } }) : a.fetchImpl(url, init))
    const ad = adapter(fetchImpl, { zapisWlaczony: true })
    expect(await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')).toEqual({ kind: 'PRZEJSCIOWY', reference: 'r', message: 'Base Courier createOrderV2.json: HTTP 429', retryAfterMs: 30_000 })
  })
})

describe('etykieta, numer, anulowanie', () => {
  it('etykieta PDF A6 domyślnie (LBL), A4 z ustawień; ZPL nie istnieje, więc PDF', async () => {
    const a = bcAtrapa()
    const ad = wlaczony(a)
    await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    const l = await ad.getLabel('9100001', 'ZPL')
    expect(l.contentType).toBe('application/pdf')
    expect(Buffer.from(l.base64, 'base64').toString()).toBe(BC_ETYKIETA)
    expect(a.calls.at(-1)!.body['Order']).toEqual({ id: 9100001, printer_type: 'LBL' })
    await wlaczony(a, { rozmiarEtykiety: 'A4' }).getLabel('9100001', 'PDF')
    expect(a.calls.at(-1)!.body['Order']).toMatchObject({ printer_type: 'A4' })
  })

  it('etykieta w kształcie z dokumentacji: `data` jako obiekt z kluczem "0" obok `labels` → PDF z "0"', async () => {
    const a = bcAtrapa({ etykietaJakDokumentacja: true })
    const ad = wlaczony(a)
    await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    const l = await ad.getLabel('9100001', 'PDF')
    expect(l.contentType).toBe('application/pdf')
    expect(Buffer.from(l.base64, 'base64').toString()).toBe(BC_ETYKIETA)
    // sam obiekt z plikiem (bez klucza "0") też przechodzi; obiekt bez pliku = jeszcze niedostępna
    a.awarie['getWaybill.json'] = [bcJson({ success: true, data: { file: Buffer.from(BC_ETYKIETA).toString('base64') } }), bcJson({ success: true, data: { labels: [] } })]
    expect(Buffer.from((await ad.getLabel('9100001', 'PDF')).base64, 'base64').toString()).toBe(BC_ETYKIETA)
    await expect(ad.getLabel('9100001', 'PDF')).rejects.toThrow(/niedostępna/)
  })

  it('etykieta nie-PDF albo pusta = błąd; zły numer = błąd bez żądania', async () => {
    const a = bcAtrapa()
    a.awarie['getWaybill.json'] = [bcJson({ success: true, data: [{ file: Buffer.from('<html>').toString('base64') }] }), bcJson({ success: true, data: [] })]
    const ad = wlaczony(a)
    await expect(ad.getLabel('1', 'PDF')).rejects.toThrow(/nie jest PDF/)
    await expect(ad.getLabel('1', 'PDF')).rejects.toThrow(/niedostępna/)
    const n = a.calls.length
    await expect(ad.getLabel('../x', 'PDF')).rejects.toThrow(/Zły numer/)
    expect(a.calls.length).toBe(n)
  })

  it('numer listu z getOrderDetails (inna instancja); jeszcze nienadany = null; szczegóły bez danych odbiorcy w wyniku', async () => {
    const a = bcAtrapa({ numerOdRazu: false })
    await wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    expect(await wlaczony(a).getTrackingNumber!('9100001')).toBeNull()
    const b = bcAtrapa()
    await wlaczony(b).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    const nowa = wlaczony(b)
    expect(await nowa.getTrackingNumber!('9100001')).toBe(b.zamowienia[0]!.waybill_no)
    expect(b.calls.at(-1)!.endpoint).toBe('getOrderDetails.json')
    await expect(nowa.getTrackingNumber!('9999999')).rejects.toThrow(/odmowa|brak zamówienia/)
  })

  it('numer listu pusty w szczegółach (paczki InPost): z listy zamówień, obie formy rekordu; bez danych odbiorcy w wyniku', async () => {
    for (const listaJakDokumentacja of [false, true]) {
      const a = bcAtrapa({ szczegolyBezNumeru: true, listaJakDokumentacja })
      await wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
      a.dopiszCudze(5)
      const nowa = wlaczony(a)
      const n = await nowa.getTrackingNumber!('9100001')
      expect(n).toBe(a.zamowienia[0]!.waybill_no)
      expect(a.calls.map((c) => c.endpoint).slice(1)).toEqual(['getOrderDetails.json', 'getOrders.json'])
      expect(a.calls.at(-1)!.body['Order']).toEqual({ page: 1 })
      // drugi raz z pamięci instancji, bez żądania
      expect(await nowa.getTrackingNumber!('9100001')).toBe(n)
      expect(a.ile('getOrders.json')).toBe(1)
      bezPii(n)
    }
  })

  it('numer z listy: kolejne strony najwyżej do limitu; dalej = błąd z opisem; na liście bez numeru = jeszcze nienadany', async () => {
    const a = bcAtrapa({ szczegolyBezNumeru: true })
    await wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    a.dopiszCudze(45)
    expect(await wlaczony(a).getTrackingNumber!('9100001')).toBe(a.zamowienia[0]!.waybill_no)
    expect(a.calls.filter((c) => c.endpoint === 'getOrders.json').map((c) => c.body['Order'])).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }])
    const b = bcAtrapa({ szczegolyBezNumeru: true })
    await wlaczony(b).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    b.dopiszCudze(BASE_COURIER_LISTA_STRONY * 20)
    const e = await wlaczony(b).getTrackingNumber!('9100001').catch((x: unknown) => x)
    expect(e).toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/nie ma wśród ostatnich na liście.*panelu Base Courier/) })
    expect(b.ile('getOrders.json')).toBe(BASE_COURIER_LISTA_STRONY)
    bezPii(e instanceof Error ? e.message : e)
    const c = bcAtrapa({ numerOdRazu: false })
    await wlaczony(c).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    expect(await wlaczony(c).getTrackingNumber!('9100001')).toBeNull()
    expect(c.ile('getOrders.json')).toBe(1)
    // odmowa listy (np. błąd po stronie API) = wyjątek, host pokaże „Numer nadania niedostępny”
    const d = bcAtrapa({ szczegolyBezNumeru: true })
    await wlaczony(d).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    d.awarie['getOrders.json'] = [{ status: 503, body: '' }]
    await expect(wlaczony(d).getTrackingNumber!('9100001')).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
  })

  it('anulowanie: OK, drugie = TRWALY z komunikatem, błąd sieci = PRZEJSCIOWY (ponowienie bezpieczne)', async () => {
    const a = bcAtrapa()
    const ad = wlaczony(a)
    await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'r')
    expect(await ad.cancelShipment!('9100001', 'r-an')).toEqual({ kind: 'OK', reference: 'r-an' })
    expect(a.zamowienia[0]!.status).toBe('cancelled')
    expect(await ad.cancelShipment!('9100001', 'r-an')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('już anulowane') })
    a.awarie['cancelOrder.json'] = ['network-error']
    expect(await ad.cancelShipment!('9100001', 'r-an')).toMatchObject({ kind: 'PRZEJSCIOWY' })
  })
})

describe('rozstrzygnięcie ręczne: confirmManual', () => {
  async function zPrzesylka() {
    const a = bcAtrapa()
    const ad = wlaczony(a)
    a.awarie['createOrderV2.json'] = ['zgubiona']
    expect((await ad.createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'ref-ok')).kind).toBe('NIEJEDNOZNACZNY')
    expect(a.zamowienia).toHaveLength(1)
    return { a, ad: wlaczony(a), z: a.zamowienia[0]! }
  }

  it('numer zamówienia albo numer listu z panelu → id zamówienia Base Courier, gdy referencja się zgadza', async () => {
    const { ad, z } = await zPrzesylka()
    expect(await ad.confirmManual!(String(z.id), 'ref-ok')).toEqual({ externalRef: String(z.id), referencjaSprawdzona: true })
    expect(await ad.confirmManual!(z.waybill_no, 'ref-ok')).toEqual({ externalRef: String(z.id), referencjaSprawdzona: true })
  })

  it('inna referencja, nieznany numer, zły format = odmowa z powodem; błąd sieci = wyjątek', async () => {
    const { a, ad, z } = await zPrzesylka()
    expect(await ad.confirmManual!(String(z.id), 'inna-ref')).toMatchObject({ odmowa: expect.stringContaining('inną referencję') })
    expect(await ad.confirmManual!('9999999', 'ref-ok')).toMatchObject({ odmowa: expect.stringContaining('nie potwierdził') })
    await expect(ad.confirmManual!('ABC-1', 'ref-ok')).resolves.toMatchObject({ odmowa: expect.stringContaining('Podaj numer') })
    a.awarie['getOrderDetails.json'] = ['network-error']
    await expect(ad.confirmManual!(String(z.id), 'ref-ok')).rejects.toThrow()
    // odmowa logowania przy sprawdzaniu ≠ „sprawdź numer”: wyjątek, host pokazuje powód
    a.awarie['getOrderDetails.json'] = [bcJson({ success: false, message: 'Nieprawidłowy login' }, 401)]
    await expect(ad.confirmManual!(String(z.id), 'ref-ok')).rejects.toThrow(/odmowa logowania/)
  })

  it('referencja na początku „Zawartości”; pole obcięte przez Base Courier (40 znaków) dalej potwierdza tę przesyłkę, inna referencja = odmowa', async () => {
    const ref = '3f6c1a2b-9d4e-5f60-8a7b-1c2d3e4f5a6b'
    expect(zawartoscPrzesylki(ref, 'SD-123456')).toBe(`ref. ${ref}; zam. SD-123456`)
    const a = bcAtrapa({ obetnijZawartosc: 16 })
    a.awarie['createOrderV2.json'] = ['zgubiona']
    expect((await wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA, orderExternalId: 'SD-123456' }, ref)).kind).toBe('NIEJEDNOZNACZNY')
    const z = a.zamowienia[0]!
    expect(z.package_content).toHaveLength(16)
    expect(z.package_content).not.toContain(ref)
    const b = bcAtrapa({ obetnijZawartosc: 40 })
    b.awarie['createOrderV2.json'] = ['zgubiona']
    await wlaczony(b).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA, orderExternalId: 'SD-123456' }, ref)
    const zb = b.zamowienia[0]!
    expect(zb.package_content).toHaveLength(40)
    expect(await wlaczony(b).confirmManual!(String(zb.id), ref)).toEqual({ externalRef: String(zb.id), referencjaSprawdzona: true })
    expect(await wlaczony(b).confirmManual!(String(zb.id), '7a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9')).toMatchObject({ odmowa: expect.stringContaining('inną referencję') })
    // 16 znaków („ref. ” + 11): za mało na początek UUID = odmowa (człowiek widzi powód, nie zgadujemy)
    expect(await wlaczony(a).confirmManual!(String(z.id), ref)).toMatchObject({ odmowa: expect.stringContaining('inną referencję') })
    expect(zawartoscMaReferencje(`ref. ${ref.slice(0, 13)}`, ref)).toBe(true)
    expect(zawartoscMaReferencje('ref. ref-o', 'ref-ok')).toBe(false)
    // pełny, inny UUID o tym samym początku = inna przesyłka (prefiks tylko przy obciętym polu)
    const inny = `${ref.slice(0, 13)}-ffff-ffff-ffffffffffff`
    expect(inny).not.toBe(ref)
    expect(zawartoscMaReferencje(`ref. ${inny}; zam. SD-1`, ref)).toBe(false)
    expect(zawartoscMaReferencje(`ref. ${ref}; zam. SD-1`, ref)).toBe(true)
  })

  it('Base Courier bez „Zawartości przesyłki” w szczegółach: potwierdzenie po samym istnieniu, z informacją', async () => {
    const a = bcAtrapa({ bezZawartosci: true })
    a.awarie['createOrderV2.json'] = ['zgubiona']
    await wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'ref-bz')
    const z = a.zamowienia[0]!
    expect(await wlaczony(a).confirmManual!(String(z.id), 'ref-bz')).toEqual({ externalRef: String(z.id), info: expect.stringContaining('sprawdzono tylko') })
  })

  it('same cyfry nieznane jako numer zamówienia: druga próba jako numer listu', async () => {
    const a = bcAtrapa()
    a.awarie['createOrderV2.json'] = ['zgubiona']
    await wlaczony(a).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA }, 'ref-l')
    const z = a.zamowienia[0]!
    z.waybill_no = '123456789012'
    expect(await wlaczony(a).confirmManual!('123456789012', 'ref-l')).toEqual({ externalRef: String(z.id), referencjaSprawdzona: true })
    expect(a.ile('getOrderDetails.json')).toBe(1)
    expect(a.ile('getOrderDetailsByWaybillNo.json')).toBe(1)
  })
})

describe('pomocnicze', () => {
  it('bezDanych: wartości wrażliwe, e-maile i długie ciągi cyfr znikają; 200 znaków', () => {
    expect(bezDanych('Jan Kowalski, jan@x.pl, 600 100 200, konto 11111111111111111111111111', ['Jan Kowalski'])).toBe('…, …, …, konto …')
    expect(bezDanych('x'.repeat(300))).toHaveLength(200)
  })

  it('polaWalidacji: tylko nazwy pól, najwyżej 10', () => {
    expect(polaWalidacji({ validationErrors: { Cart: [{ Order: { taker_postal: ['x'], taker_phone: ['y'], 'Zła Nazwa': ['z'] } }] } })).toEqual(['taker_postal', 'taker_phone'])
    expect(polaWalidacji(null)).toEqual([])
  })
})

describe('czas utworzenia a „Sprawdź u przewoźnika”', () => {
  it('host czeka dłużej niż najgorszy żywy przebieg Base Courier (zamówienie i szczegóły do 60 s, lista do 3 stron po 20 s)', async () => {
    const { TWORZENIE_ZAWIESZONE_MS } = await import('../wysylka/nadanie')
    const { BASE_COURIER_TIMEOUT_MS } = await import('../zrodla/basecourier-zapis')
    expect(2 * BASE_COURIER_TIMEOUT_MS + BASE_COURIER_LISTA_STRONY * BASE_COURIER_LISTA_TIMEOUT_MS).toBeLessThan(TWORZENIE_ZAWIESZONE_MS)
  })
})

describe('stanBaseCourier (śledzenie przesyłki)', () => {
  const h = (status: string, kod: number | null, doreczona = false, opis: string | null = null) => ({ status, kod, doreczona, opis })
  it('pusta historia albo sama etykieta = przed nadaniem', async () => {
    const { stanBaseCourier } = await import('./basecourier-zapis')
    expect(stanBaseCourier([])).toEqual({ stan: 'PRZED_NADANIEM', status: null, opis: null })
    expect(stanBaseCourier([h('030103', 1)])).toMatchObject({ stan: 'PRZED_NADANIEM', status: '030103' })
  })
  it('odebrana od nadawcy albo w drodze = przekazana; status i opis z najnowszego wpisu', async () => {
    const { stanBaseCourier } = await import('./basecourier-zapis')
    expect(stanBaseCourier([h('040101', 2, false, 'Odebrana przez kuriera'), h('030103', 1)])).toEqual({ stan: 'PRZEKAZANA', status: '040101', opis: 'Odebrana przez kuriera' })
    expect(stanBaseCourier([h('adopted_at_source_branch', 11), h('collected_from_sender', 2)]).stan).toBe('PRZEKAZANA')
  })
  it('doręczona (znacznik albo kod 5) = doręczona', async () => {
    const { stanBaseCourier } = await import('./basecourier-zapis')
    expect(stanBaseCourier([h('x', null, true)]).stan).toBe('DORECZONA')
    expect(stanBaseCourier([h('d', 5), h('c', 2)]).stan).toBe('DORECZONA')
  })
  it('anulowana, zwrot albo nieznany kod = bez zmiany', async () => {
    const { stanBaseCourier } = await import('./basecourier-zapis')
    expect(stanBaseCourier([h('c', 10), h('e', 1)]).stan).toBe('NIEZNANY')
    expect(stanBaseCourier([h('n', null)]).stan).toBe('NIEZNANY')
  })
  it('opis statusu: bez znaczników w nawiasach, bez e-maili i długich ciągów cyfr', async () => {
    const { opisStatusu } = await import('../zrodla/basecourier-zapis')
    expect(opisStatusu('Odebrana od nadawcy [#wh]')).toBe('Odebrana od nadawcy')
    expect(opisStatusu('Odebrał ktos@example.invalid')).toBeNull()
    expect(opisStatusu('Telefon 600700800')).toBeNull()
    expect(opisStatusu(null)).toBeNull()
  })
})

describe('podjazd kuriera', () => {
  // pt. 20.11.2026 15:00 (Warszawa) = 14:00 UTC
  const PT = () => new Date('2026-11-20T14:00:00Z')
  const PROP = { dni: ['2026-11-23', '2026-11-24'], odMin: 13 * 60, doMin: 15 * 60 }
  const dpd = () => paczka({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null }, WYMIARY)
  const order = (a: ReturnType<typeof bcAtrapa>) => (utworzenie(a)['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order

  it('wyłączony (domyślnie): bez podjazdu, bez pól pickup_* i bez odczytu terminów, jak dotąd', async () => {
    const a = bcAtrapa({ terminyPodjazdu: ['2026-11-23'] })
    expect(await wlaczony(a, {}, PT).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA, podjazd: PROP }, 'r0')).toMatchObject({ kind: 'OK' })
    expect(a.calls.map((c) => c.endpoint)).toEqual(['createOrderV2.json'])
    expect(utworzenie(a)['CourierSearch']).toMatchObject({ no_pickup: true })
    expect(Object.keys(order(a)).filter((k) => k.startsWith('pickup'))).toEqual([])
  })

  it('włączony: dzień z harmonogramu potwierdzony terminami Base Courier, okno godzin w polach pickup_*', async () => {
    const a = bcAtrapa({ terminyPodjazdu: ['2026-11-23', '2026-11-24'] })
    const w = await wlaczony(a, { zamawiajPodjazd: true }, PT).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA, podjazd: PROP }, 'r1')
    expect(w).toEqual({ kind: 'OK', reference: 'r1', externalRef: '9100001' })
    expect(a.calls.map((c) => c.endpoint)).toEqual(['getPickupDateOptions.json', 'createOrderV2.json'])
    expect(utworzenie(a)['CourierSearch']).toMatchObject({ no_pickup: false })
    expect(order(a)).toMatchObject({ pickup_date: '2026-11-23', pickup_ready_time: '13', pickup_ready_time_minute: '00', pickup_close_time: '15', pickup_close_time_minute: '00' })
    expect(order(a)).not.toHaveProperty('custom_pickup')
  })

  it('paczkomat InPost też dostaje podjazd (ustawienie konta dotyczy wszystkich przesyłek konta)', async () => {
    const a = bcAtrapa({ terminyPodjazdu: ['2026-11-23'] })
    await wlaczony(a, { zamawiajPodjazd: true }, PT).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA, podjazd: PROP }, 'r2')
    expect(utworzenie(a)['CourierSearch']).toMatchObject({ courier_code: 'paczkomaty', no_pickup: false })
    expect(order(a)).toMatchObject({ pickup_date: '2026-11-23', taker_point: 'POZ01A' })
  })

  it('okno z ustawienia konta zastępuje godziny; Base Courier nie przyjmuje pierwszego dnia = drugi dzień harmonogramu', async () => {
    const a = bcAtrapa({ terminyPodjazdu: ['2026-11-24'] })
    await wlaczony(a, { zamawiajPodjazd: true, oknoPodjazdu: '10:30-16:00' }, PT).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA, podjazd: PROP }, 'r3')
    expect(order(a)).toMatchObject({ pickup_date: '2026-11-24', pickup_ready_time: '10', pickup_ready_time_minute: '30', pickup_close_time: '16', pickup_close_time_minute: '00' })
  })

  it('okno podjazdu DPD: tylko dla DPD, cały przedział także dziś; Paczkomaty zostają przy oknie konta', async () => {
    const dzis = () => new Date('2026-11-23T08:55:00Z') // 09:55 w Warszawie
    const cfg = { zamawiajPodjazd: true, oknoPodjazduDpd: '09:00-17:00' }
    const a = bcAtrapa({ terminyPodjazdu: ['2026-11-23', '2026-11-24'] })
    await wlaczony(a, cfg, dzis).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA, podjazd: PROP }, 'r3a')
    expect(order(a)).toMatchObject({ pickup_date: '2026-11-23', pickup_ready_time: '09', pickup_ready_time_minute: '00', pickup_close_time: '17', pickup_close_time_minute: '00' })
    const b = bcAtrapa({ terminyPodjazdu: ['2026-11-23', '2026-11-24'] })
    await wlaczony(b, cfg, dzis).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA, podjazd: PROP }, 'r3b')
    expect(order(b)).toMatchObject({ pickup_date: '2026-11-23', pickup_ready_time: '13', pickup_ready_time_minute: '00', pickup_close_time: '15', pickup_close_time_minute: '00' })
    const okno = BASE_COURIER_ZAPIS_DEFINITION.manifest.config.find((f) => f.key === 'oknoPodjazduDpd')!
    expect(okno.pattern!.test('09:00-17:00')).toBe(true)
    expect(okno.pattern!.test('')).toBe(true)
  })

  it('okno podjazdu per kurier: każdy kurier ma swoje pole, okno idzie w całości także dziś, inni zostają przy oknie konta', async () => {
    const dzis = () => new Date('2026-11-23T08:55:00Z') // 09:55 w Warszawie
    const cfg = { zamawiajPodjazd: true, oknoPodjazdu: '10:00-16:00', oknoPodjazduPaczkomaty: '08:00-15:00' }
    const a = bcAtrapa({ terminyPodjazdu: ['2026-11-23', '2026-11-24'] })
    await wlaczony(a, cfg, dzis).createShipment({ carrier: 'PACZKOMATY', parcel: paczka(), recipient: ODBIORCA, podjazd: PROP }, 'r3c')
    expect(order(a)).toMatchObject({ pickup_date: '2026-11-23', pickup_ready_time: '08', pickup_ready_time_minute: '00', pickup_close_time: '15', pickup_close_time_minute: '00' })
    // DPD bez własnego pola: okno konta, dziś przycięte do bieżącego kwadransa
    const b = bcAtrapa({ terminyPodjazdu: ['2026-11-23', '2026-11-24'] })
    await wlaczony(b, cfg, dzis).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA, podjazd: PROP }, 'r3d')
    expect(order(b)).toMatchObject({ pickup_date: '2026-11-23', pickup_ready_time: '10', pickup_ready_time_minute: '00', pickup_close_time: '16', pickup_close_time_minute: '00' })
    const pola = BASE_COURIER_ZAPIS_DEFINITION.manifest.config.filter((f) => f.key.startsWith('oknoPodjazdu')).map((f) => f.key)
    expect(pola).toEqual(['oknoPodjazdu', ...OKNA_PODJAZDU_KURIEROW.map((k) => k.key)])
    expect(new Set(OKNA_PODJAZDU_KURIEROW.flatMap((k) => k.carriers)).size).toBe(OKNA_PODJAZDU_KURIEROW.flatMap((k) => k.carriers).length)
    for (const k of OKNA_PODJAZDU_KURIEROW) expect(BASE_COURIER_ZAPIS_DEFINITION.manifest.config.find((f) => f.key === k.key)!.pattern!.test('9:00-17:00')).toBe(true)
  })

  it('terminy nieosiągalne (błąd sieci): przesyłka powstaje z pierwszym dniem harmonogramu', async () => {
    const a = bcAtrapa()
    a.awarie['getPickupDateOptions.json'] = ['network-error']
    expect(await wlaczony(a, { zamawiajPodjazd: true }, PT).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA, podjazd: PROP }, 'r4')).toMatchObject({ kind: 'OK' })
    expect(order(a)).toMatchObject({ pickup_date: '2026-11-23' })
    expect(a.ile('createOrderV2.json')).toBe(1)
  })

  it('bez harmonogramu firmy: najbliższy termin i godziny domyślne Base Courier', async () => {
    const a = bcAtrapa({ terminyPodjazdu: ['2026-11-20', '2026-11-23'] })
    await wlaczony(a, { zamawiajPodjazd: true }, PT).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA, podjazd: null }, 'r5')
    expect(order(a)).toMatchObject({ pickup_date: '2026-11-20', pickup_ready_time: '15', pickup_ready_time_minute: '00', pickup_close_time: '16', pickup_close_time_minute: '00' })
  })

  it('ani harmonogramu, ani terminów: przesyłka powstaje z podjazdem bez daty, magazyn dostaje uwagę', async () => {
    const a = bcAtrapa()
    const w = await wlaczony(a, { zamawiajPodjazd: true }, PT).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA }, 'r6')
    expect(w).toMatchObject({ kind: 'OK', externalRef: '9100001' })
    expect('info' in w ? w.info : '').toMatch(/bez daty podjazdu/)
    expect(utworzenie(a)['CourierSearch']).toMatchObject({ no_pickup: false })
    expect(order(a)).not.toHaveProperty('pickup_date')
  })

  it('Base Courier odrzuca termin podjazdu: TRWALY z drogą obejścia, jedno utworzenie, żadnego drugiego', async () => {
    const a = bcAtrapa({ terminyPodjazdu: ['2026-11-23'], odrzucPodjazdNa: '2026-11-23' })
    const w = await wlaczony(a, { zamawiajPodjazd: true }, PT).createShipment({ carrier: 'DPD', parcel: dpd(), recipient: ODBIORCA, podjazd: PROP }, 'r7')
    expect(w).toMatchObject({ kind: 'TRWALY', reference: 'r7' })
    expect('message' in w ? w.message : '').toMatch(/pickup_date.*nie przyjął terminu podjazdu.*Zamawiaj podjazd kuriera/)
    expect(a.ile('createOrderV2.json')).toBe(1)
    expect(a.zamowienia).toHaveLength(0)
    bezPii(w)
  })

  it('manifest: przełącznik i okno w karcie konta, domyślnie wyłączone', () => {
    const m = BASE_COURIER_ZAPIS_DEFINITION.manifest
    expect(m.config.find((f) => f.key === 'zamawiajPodjazd')).toMatchObject({ type: 'boolean', required: false })
    expect(m.config.find((f) => f.key === 'zamawiajPodjazd')!.description).toMatch(/^Zamawiaj podjazd kuriera/)
    const okno = m.config.find((f) => f.key === 'oknoPodjazdu')!
    expect(okno.pattern!.test('10:00-15:00')).toBe(true)
    expect(okno.pattern!.test('')).toBe(true)
    expect(okno.pattern!.test('rano')).toBe(false)
  })
})
