// adaptery `orlenpaczka.v1` i `orlenpaczka.zapis.v1` na atrapie SOAP. Dane fikcyjne, zero połączeń (także
// z sandboxem Orlen Paczki): tryb „przygotuj, nie wysyłaj”, zapis tylko za wyłącznikiem.
import { describe, expect, it } from 'vitest'
import {
  etykietaOdp,
  etykietaZpl,
  kodOdp,
  NADAWCA_ORLEN,
  ODBIORCA_ORLEN,
  odpowiedz,
  ORLEN_NUMER,
  ORLEN_PARTNER_ID,
  ORLEN_PARTNER_KEY,
  ORLEN_PUNKT,
  ORLEN_URL,
  orlenAtrapa,
} from '../../tests/orlenpaczka-atrapa'
import { ReadOnlyViolation } from '../zrodla/http'
import { koperta, METODY_ODCZYTU, ORLEN_PROD, ORLEN_TEST, OrlenOdczyt, OrlenZapis, pole, rekordWyniku, rekordy } from '../zrodla/orlenpaczka'
import { odciskReferencji } from '../wysylka/zlecenie-orlenpaczka'
import { defaultRegistry } from './domyslne'
import { hasReferenceFinder, hasShipmentCanceller, hasShipmentCreator, hasShipmentPreparer, type ChannelAdapter, type PreparedParcel, type ShipmentCreator, type ShipmentInput } from './kontrakt'
import { adresOrlen, ean13Poprawny, ORLEN_DEFINITION, ORLEN_KEY, ORLEN_ZAPIS_DEFINITION, ORLEN_ZAPIS_KEY, type PotwierdzenieOrlen } from './orlenpaczka'
import { KODY_ORLEN, kodLiczbowy, wynikKodu } from './orlenpaczka-kody'
import { validateAccountConfig } from './rejestr'
import { PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'
import { executeWrite } from './zapis'

const FAST = { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 }
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'orlen', name: 'Orlen Paczka' }
const SECRETS = { ORLEN_PARTNER_ID, ORLEN_PARTNER_KEY }
const AUTH = { partnerId: ORLEN_PARTNER_ID, partnerKey: ORLEN_PARTNER_KEY }
const REF = 'a1b2c3d4-e5f6-5789-8abc-def012345678'
const NOW = new Date('2026-11-08T10:00:00Z')

type Atrapa = ReturnType<typeof orlenAtrapa>

function adapter(key: string, a: Atrapa, config: Record<string, unknown> = {}): ChannelAdapter {
  return defaultRegistry().create(key, { integration, rawConfig: { ...config }, rawSecrets: SECRETS, fetch: a.fetchImpl, http: FAST, now: () => NOW })
}

type Zapisowy = ChannelAdapter & ShipmentCreator & { findByReference(r: string): Promise<{ found: boolean; externalRef?: string }>; confirmManual(n: string, r: string): Promise<PotwierdzenieOrlen> }

function zapisowy(a: Atrapa, config: Record<string, unknown> = {}): Zapisowy {
  const ad = adapter(ORLEN_ZAPIS_KEY, a, { nadawca: JSON.stringify(NADAWCA_ORLEN), ...config })
  if (!hasShipmentCreator(ad)) throw new Error('bez shipment.create')
  return ad as Zapisowy
}

const WEJSCIE: ShipmentInput = { carrier: 'ORLEN_PACZKA', gabaryt: 'ORLEN_M', weightG: 1500, weightComplete: true, paymentState: 'PAID', paymentMethod: 'przelew', totalGross: 99, codAmountUncertain: null, pickupPoint: ORLEN_PUNKT }
const GOTOWA: PreparedParcel = { courierCode: 'M', gabaryt: 'ORLEN_M', sideXCm: 19, sideYCm: 38, sideZCm: 60, weightKg: 1.5, codAmount: null, pickupPoint: ORLEN_PUNKT, problems: [] }

for (const key of [ORLEN_KEY, ORLEN_ZAPIS_KEY]) {
  runAdapterContract({
    name: key,
    now: NOW,
    setup() {
      const a = orlenAtrapa()
      return {
        adapter: adapter(key, a),
        putOrder: () => {},
        corruptOrder: () => {},
        failNextList: () => {},
        // metody SOAP zamiast metod HTTP (w SOAP wszystko jest POST): adapter odczytu woła wyłącznie metody odczytu
        requests: () => a.metody(),
        readMethods: ['GivePartnerStatus'],
      }
    },
  })
}

describe('klient SOAP Orlen Paczki', () => {
  it('koperta SOAP 1.1: przestrzeń nazw, kolejność pól, listy jako <string>, znaki specjalne zakodowane, puste pominięte', () => {
    const k = koperta('LabelPrintDuplicateListTwo', { PartnerID: 'P1', Format: 'ZPL', PackCodeList: ['2100000000017'], Opis: 'A&B <c>', Brak: null })
    expect(k).toContain('<LabelPrintDuplicateListTwo xmlns="https://91.242.220.103/WebServicePwR"><PartnerID>P1</PartnerID><Format>ZPL</Format><PackCodeList><string>2100000000017</string></PackCodeList><Opis>A&amp;B &lt;c&gt;</Opis></LabelPrintDuplicateListTwo>')
    expect(k).not.toContain('Brak')
    expect(() => koperta('Zła metoda', {})).toThrow()
    expect(() => koperta('Ping', { 'zle pole': 'x' })).toThrow()
  })

  it('odczyt DataSet: schemat pomijany, wiersze diffgram jako płaskie rekordy, encje zdekodowane', () => {
    const r = odpowiedz('GenerateBusinessPack', 'GenerateBusinessPack', [{ Err: '006', ErrDes: 'zapisano &amp; zmieniono', PackCode_RUCH: ORLEN_NUMER }], { LabelData: 'QUJD' })
    expect('body' in r).toBe(true)
    const xml = (r as { body: string }).body
    expect(rekordWyniku(xml)).toEqual({ Err: '006', ErrDes: 'zapisano &amp; zmieniono', PackCode_RUCH: ORLEN_NUMER })
    expect(pole(xml, 'LabelData')).toBe('QUJD')
    expect(pole(xml, 'Nieistnieje')).toBeNull()
    expect(rekordy('<a><b>1</b><c/></a>')).toEqual([{ b: '1', c: '' }])
    expect(kodLiczbowy('000')).toBe(0)
    expect(kodLiczbowy('abc')).toBeNull()
  })

  it('odczyt: tylko trzy metody; każda inna = ReadOnlyViolation przed wysyłką', async () => {
    const a = orlenAtrapa()
    const k = new OrlenOdczyt({ url: ORLEN_URL, auth: AUTH, fetchImpl: a.fetchImpl, retry: FAST.retry })
    expect([...METODY_ODCZYTU]).toEqual(['GivePartnerStatus', 'GetGeneratedParcels', 'GiveMePackStatus'])
    for (const m of ['GenerateBusinessPack', 'GenerateLabelBusinessPackListTwo', 'PutCustomerPackCanceled', 'PutCustomerPack', 'GenerateNumberWaybills', 'CallPickup', 'CallPickupNew', 'GenerateProtocol', 'CreateCustomer', 'LabelPrintDuplicateListTwo', 'GenerateCustomerReturn', 'Ping', '']) {
      await expect(k.wywolaj(m)).rejects.toBeInstanceOf(ReadOnlyViolation)
    }
    expect(a.calls).toHaveLength(0)
  })

  it('zapis: wymaga jawnego wyłącznika; metody spoza listy (kurier, protokół, zwroty, klient) odrzucone przed wysyłką', async () => {
    const a = orlenAtrapa()
    expect(() => new OrlenZapis({ url: ORLEN_URL, auth: AUTH, fetchImpl: a.fetchImpl } as never)).toThrow(/wyłącznika/)
    const z = new OrlenZapis({ url: ORLEN_URL, auth: AUTH, fetchImpl: a.fetchImpl, wylacznik: true })
    for (const m of ['CallPickup', 'CallPickupNew', 'GenerateProtocol', 'CreateCustomer', 'GenerateNumberWaybills', 'PutCustomerPack', 'GenerateCustomerReturn']) {
      await expect(z.wywolaj(m as never, {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    }
    expect(a.calls).toHaveLength(0)
  })

  it('tylko dwa adresy z dokumentacji; domyślnie środowisko testowe', () => {
    for (const url of [ORLEN_PROD, ORLEN_TEST]) expect(() => new OrlenOdczyt({ url, auth: AUTH })).not.toThrow()
    for (const url of ['http://api.orlenpaczka.pl/WebServicePwRProd/WebServicePwR.asmx', 'https://api.orlenpaczka.pl.example.invalid/WebServicePwRProd/WebServicePwR.asmx', 'https://zly.example.invalid/WebServicePwR.asmx', `${ORLEN_PROD}?wsdl`]) {
      expect(() => new OrlenOdczyt({ url, auth: AUTH })).toThrow(/adres API Orlen/)
    }
    expect(() => new OrlenOdczyt({ url: ORLEN_TEST, auth: { ...AUTH, partnerKey: '' } })).toThrow(/PartnerKey/)
    expect(adresOrlen({})).toBe(ORLEN_TEST)
    expect(adresOrlen({ srodowisko: 'produkcja' })).toBe(ORLEN_PROD)
    expect(adresOrlen({ srodowisko: 'test', baseUrl: ORLEN_PROD })).toBe(ORLEN_PROD)
    expect(validateAccountConfig(ORLEN_DEFINITION.manifest, { baseUrl: 'https://zly.example.invalid/x.asmx' }).problems).toEqual([expect.stringContaining('baseUrl')])
    expect(validateAccountConfig(ORLEN_DEFINITION.manifest, { srodowisko: 'demo' }).problems).toEqual([expect.stringContaining('srodowisko')])
  })

  it('nagłówki SOAP, bez przekierowań; klucz w treści koperty, nie w komunikatach błędów (wartownik)', async () => {
    const a = orlenAtrapa()
    await new OrlenOdczyt({ url: ORLEN_URL, auth: AUTH, fetchImpl: a.fetchImpl, retry: FAST.retry }).wywolaj('GivePartnerStatus')
    expect(a.calls[0]).toMatchObject({ url: ORLEN_URL, metoda: 'GivePartnerStatus', soapAction: '"https://91.242.220.103/WebServicePwR/GivePartnerStatus"', redirect: 'error', pola: { PartnerID: ORLEN_PARTNER_ID, PartnerKey: ORLEN_PARTNER_KEY } })
    expect(a.calls[0]!.headers['Content-Type']).toBe('text/xml; charset=utf-8')
    const b = orlenAtrapa([{ error: new Error(`socket hang up ${ORLEN_PARTNER_KEY} ${ORLEN_PARTNER_ID}`) }, { error: new Error(`znowu ${ORLEN_PARTNER_KEY}`) }])
    const e = await new OrlenOdczyt({ url: ORLEN_URL, auth: AUTH, fetchImpl: b.fetchImpl, retry: FAST.retry }).wywolaj('GivePartnerStatus').catch((x: unknown) => x)
    for (const s of [ORLEN_PARTNER_KEY, ORLEN_PARTNER_ID]) expect((e as Error).message).not.toContain(s)
    const z = orlenAtrapa([{ error: new Error(`timeout ${ORLEN_PARTNER_KEY}`) }])
    const w = await new OrlenZapis({ url: ORLEN_URL, auth: AUTH, fetchImpl: z.fetchImpl, wylacznik: true }).wywolaj('GenerateBusinessPack', {})
    expect(w).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
    expect(JSON.stringify(w)).not.toContain(ORLEN_PARTNER_KEY)
  })

  it('odczyt ponawia sieć i 5xx bez Fault; Fault (zła koperta) bez ponawiania', async () => {
    const a = orlenAtrapa([{ status: 503, body: '' }])
    await new OrlenOdczyt({ url: ORLEN_URL, auth: AUTH, fetchImpl: a.fetchImpl, retry: FAST.retry }).wywolaj('GivePartnerStatus')
    expect(a.calls).toHaveLength(2)
    const fault = { status: 500, body: '<soap:Envelope xmlns:soap="x"><soap:Body><soap:Fault><faultstring>Server was unable to read request</faultstring></soap:Fault></soap:Body></soap:Envelope>' }
    const b = orlenAtrapa([fault, fault])
    const e = await new OrlenOdczyt({ url: ORLEN_URL, auth: AUTH, fetchImpl: b.fetchImpl, retry: FAST.retry }).wywolaj('GivePartnerStatus').catch((x: unknown) => x)
    expect((e as { retryable: boolean }).retryable).toBe(false)
    expect(b.calls).toHaveLength(1)
  })

  it('zapis z Faultem klienta (soap:Client, SOAP 1.2 Sender) = TRWALY; Fault serwera i 5xx bez Faultu = NIEJEDNOZNACZNY', async () => {
    const f = (kod: string) => ({ status: 500, body: `<soap:Envelope xmlns:soap="x"><soap:Body><soap:Fault><faultcode>${kod}</faultcode><faultstring>Server did not recognize the value of HTTP Header SOAPAction</faultstring></soap:Fault></soap:Body></soap:Envelope>` })
    const zapisz = async (r: { status: number; body: string }) => new OrlenZapis({ url: ORLEN_URL, auth: AUTH, fetchImpl: orlenAtrapa([r]).fetchImpl, wylacznik: true }).wywolaj('GenerateBusinessPack', {})
    expect(await zapisz(f('soap:Client'))).toMatchObject({ ok: false, kind: 'TRWALY', message: expect.stringContaining('przed wykonaniem') })
    expect(await zapisz(f('soap:Client.Deserialization'))).toMatchObject({ ok: false, kind: 'TRWALY' })
    const v12 = { status: 500, body: '<soap:Envelope xmlns:soap="x"><soap:Body><soap:Fault><soap:Code><soap:Value>soap:Sender</soap:Value></soap:Code><soap:Reason><soap:Text>zła koperta</soap:Text></soap:Reason></soap:Fault></soap:Body></soap:Envelope>' }
    expect(await zapisz(v12)).toMatchObject({ ok: false, kind: 'TRWALY' })
    expect(await zapisz(f('soap:Server'))).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
    expect(await zapisz({ status: 500, body: '' })).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
  })

  it('ponowienia odczytu najwyżej tyle, ile zakłada próg „Sprawdź u przewoźnika”', async () => {
    const siec = Array.from({ length: 10 }, () => ({ error: new Error('reset') }))
    const at = orlenAtrapa([], { GetGeneratedParcels: siec })
    const a = defaultRegistry().create(ORLEN_ZAPIS_KEY, { integration, rawConfig: { zapisWlaczony: true }, rawSecrets: SECRETS, fetch: at.fetchImpl, http: { retry: { attempts: 10, baseDelayMs: 0 }, minIntervalMs: 0 }, now: () => NOW }) as unknown as Zapisowy
    await expect(a.findByReference(REF)).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    expect(at.metody().filter((m) => m === 'GetGeneratedParcels')).toHaveLength(3)
  })
})

describe('numer paczki Orlen Paczki', () => {
  it('cyfra kontrolna EAN-13: numery z dokumentacji (prawdziwe paczki) przechodzą, literówka w jednej cyfrze nie', () => {
    for (const n of ['2101142967553', '2101142968208', ORLEN_NUMER]) expect(ean13Poprawny(n)).toBe(true)
    for (const n of ['2101142967554', '2101142967583', '2100000000017', '210114296755', 'ABCDEFGHIJKLM']) expect(ean13Poprawny(n)).toBe(false)
  })
})

describe('kody zwrotne Orlen Paczki', () => {
  // Pełna tabela kodów z konektora OIP (integration.py, OrlenPaczkaReturnCodes) i rozdziały 5–6 dokumentacji 1.26.004
  const KODY_OIP = [100, 101, 103, 104, 105, 106, 107, 111, 112, 113, 114, 115, 116, 117, 120, 121, 123, 124, 125, 126, 127, 128, 129, 130, 131, 133, 134, 135, 136, 137, 138, 140, 141, 150, 163, 200, 201, 202, 205, 206, 207, 208, 209, 211, 212, 213, 222, 223, 310, 311, 312, 318, 6, 7, 8, 0]
  const KODY_DOK = [0, 6, 7, 8, 100, 101, 103, 104, 105, 106, 107, 108, 111, 112, 113, 114, 115, 116, 117, 120, 121, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 150, 161, 162, 163, 164, 191, 201, 202, 205, 206, 207, 208, 209, 211, 212, 213, 214, 222, 223, 240, 243, 250, 251, 252, 253, 254, 300, 308, 309, 310, 311, 312, 314, 318, 330, 336, 350, 399, 400, 401, 801, 802, 901, 999, 1038, 1039, 1040, 1041, 1043, 1052, 1053, 1054, 1055, 1067, 1077, 1084]

  it('każdy kod z obu tabel ma opis po polsku i klasę; źródło zgodne z tabelą', () => {
    for (const kod of new Set([...KODY_OIP, ...KODY_DOK])) {
      const d = KODY_ORLEN[kod]
      expect(d, `kod ${kod}`).toBeDefined()
      expect(d!.opis.length).toBeGreaterThan(3)
      const oip = KODY_OIP.includes(kod)
      const dok = KODY_DOK.includes(kod)
      expect(d!.zrodlo, `źródło kodu ${kod}`).toBe(oip && dok ? 'oba' : oip ? 'oip' : 'dok')
    }
    expect(Object.keys(KODY_ORLEN).map(Number).sort((a, b) => a - b)).toEqual([...new Set([...KODY_OIP, ...KODY_DOK])].sort((a, b) => a - b))
  })

  // Tabela oczekiwań: kod → wynik przy nadaniu, anulowaniu i odczycie
  const OCZEKIWANE: [number, string, string, string][] = [
    [0, 'OK', 'OK', 'OK'],
    [6, 'OK', 'OK', 'OK'],
    [8, 'OK', 'OK', 'OK'],
    [104, 'TRWALY', 'TRWALY', 'TRWALY'],
    [133, 'TRWALY', 'TRWALY', 'TRWALY'],
    [141, 'TRWALY', 'TRWALY', 'TRWALY'],
    [200, 'TRWALY', 'TRWALY', 'TRWALY'],
    [401, 'TRWALY', 'TRWALY', 'TRWALY'],
    [201, 'TRWALY', 'OK', 'TRWALY'],
    [202, 'TRWALY', 'TRWALY', 'TRWALY'],
    [211, 'PRZEJSCIOWY', 'PRZEJSCIOWY', 'PRZEJSCIOWY'],
    [213, 'TRWALY', 'TRWALY', 'TRWALY'],
    [223, 'TRWALY', 'TRWALY', 'TRWALY'],
    [300, 'NIEJEDNOZNACZNY', 'PRZEJSCIOWY', 'PRZEJSCIOWY'],
    [310, 'TRWALY', 'TRWALY', 'TRWALY'],
    [330, 'NIEJEDNOZNACZNY', 'PRZEJSCIOWY', 'PRZEJSCIOWY'],
    [901, 'NIEJEDNOZNACZNY', 'PRZEJSCIOWY', 'PRZEJSCIOWY'],
    [999, 'PRZEJSCIOWY', 'PRZEJSCIOWY', 'PRZEJSCIOWY'],
    [77777, 'NIEJEDNOZNACZNY', 'TRWALY', 'TRWALY'],
  ]
  it.each(OCZEKIWANE)('kod %i: nadanie %s, anulowanie %s, odczyt %s', (kod, nadanie, anulowanie, odczyt) => {
    expect(wynikKodu(kod, 'nadanie').kind).toBe(nadanie)
    expect(wynikKodu(kod, 'anulowanie').kind).toBe(anulowanie)
    expect(wynikKodu(kod, 'odczyt').kind).toBe(odczyt)
  })

  it('wszystkie kody: nadanie nigdy nie daje PRZEJSCIOWY dla błędu w trakcie wykonania; komunikat z kodem', () => {
    for (const [kod, d] of Object.entries(KODY_ORLEN)) {
      const w = wynikKodu(Number(kod), 'nadanie')
      if (d.klasa === 'NIEPEWNY') expect(w.kind).toBe('NIEJEDNOZNACZNY')
      if (w.kind !== 'OK') expect(w.message).toContain(`kod ${kod}`)
    }
  })
})

describe('adapter orlenpaczka.v1', () => {
  it('w rejestrze jako przewoźnik tylko do odczytu, z sekretami i przygotowaniem przesyłki', () => {
    const { manifest } = ORLEN_DEFINITION
    expect(defaultRegistry().get(ORLEN_KEY)?.manifest).toBe(manifest)
    expect(manifest).toMatchObject({ kind: 'carrier', capabilities: ['shipment.prepare'], readOnly: true })
    expect(manifest.secrets.map((s) => [s.name, s.required])).toEqual([['ORLEN_PARTNER_ID', true], ['ORLEN_PARTNER_KEY', true]])
    expect(manifest.config.map((c) => c.key)).not.toContain('zapisWlaczony')
    expect(() => defaultRegistry().create(ORLEN_KEY, { integration, rawConfig: {}, rawSecrets: {}, fetch: orlenAtrapa().fetchImpl })).toThrow()
    const a = adapter(ORLEN_KEY, orlenAtrapa())
    expect(hasShipmentPreparer(a)).toBe(true)
    expect(hasShipmentCreator(a)).toBe(false)
  })

  it('test połączenia: konto odpowiada; zły PartnerID/klucz = TRWALY; sieć = PRZEJSCIOWY', async () => {
    const ok = await adapter(ORLEN_KEY, orlenAtrapa()).testConnection()
    expect(ok).toMatchObject({ ok: true, details: { srodowisko: 'test', platnosc: 'POSTPAID' } })
    for (const err of ['200', '401']) {
      const r = await adapter(ORLEN_KEY, orlenAtrapa([kodOdp('GivePartnerStatus', 'PartnerStatus', err)])).testConnection()
      expect(r).toMatchObject({ ok: false, details: { rodzaj: 'TRWALY' } })
      expect(r.message).toMatch(/PartnerID albo PartnerKey/)
    }
    const s = await adapter(ORLEN_KEY, orlenAtrapa([{ error: new Error('ECONNRESET') }, { error: new Error('ECONNRESET') }])).testConnection()
    expect(s).toMatchObject({ ok: false, details: { rodzaj: 'PRZEJSCIOWY' } })
    expect((await adapter(ORLEN_KEY, orlenAtrapa([{ status: 200, body: '<x/>' }])).testConnection()).ok).toBe(false)
  })

  it('przygotowanie: rozmiar S/M/L, punkt Orlenu, waga do 20 kg, bez pobrania', () => {
    const a = adapter(ORLEN_KEY, orlenAtrapa())
    if (!hasShipmentPreparer(a)) throw new Error('bez prepare')
    expect(a.prepareShipment(WEJSCIE)).toEqual(GOTOWA)
    const kody = (i: Partial<ShipmentInput>) => a.prepareShipment({ ...WEJSCIE, ...i }).problems.map((p) => `${p.poziom}:${p.kod}`)
    expect(kody({ gabaryt: 'INPOST_A' })).toEqual(['BLAD:gabaryt'])
    expect(kody({ gabaryt: null })).toEqual(['BLAD:gabaryt'])
    expect(kody({ pickupPoint: null })).toEqual(['BLAD:punkt'])
    expect(kody({ pickupPoint: 'KRA010' })).toEqual(['BLAD:punkt_format'])
    expect(a.prepareShipment({ ...WEJSCIE, pickupPoint: ' xx-116263-00-00 ' }).pickupPoint).toBe('XX-116263-00-00')
    expect(kody({ weightG: 21_000 })).toEqual(['BLAD:waga_limit'])
    expect(kody({ weightG: null, weightComplete: false })).toEqual(['OSTRZEZENIE:waga_domyslna'])
    expect(kody({ paymentState: 'COD' })).toEqual(['BLAD:pobranie'])
    expect(kody({ paymentState: 'UNPAID', paymentMethod: 'Za pobraniem' })).toEqual(['BLAD:pobranie'])
    expect(kody({ paymentState: 'UNPAID', paymentMethod: 'przelew' })).toEqual(['OSTRZEZENIE:nieoplacone'])
    expect(kody({ carrier: 'DPD' })).toEqual(['BLAD:kod_kuriera'])
    expect(a.prepareShipment({ ...WEJSCIE, gabaryt: 'ORLEN_L' })).toMatchObject({ courierCode: 'L', sideXCm: 41 })
  })

  it('status paczki: odczyt GiveMePackStatus; zły numer bez żądania', async () => {
    const at = orlenAtrapa()
    const a = adapter(ORLEN_KEY, at) as ChannelAdapter & { statusPaczki(n: string): Promise<unknown> }
    expect(await a.statusPaczki(ORLEN_NUMER)).toEqual({ numer: ORLEN_NUMER, kod: 200, opis: 'Zaawizowana do PwR', od: '2026-11-08T10:00:00Z', punkt: ORLEN_PUNKT })
    await expect(a.statusPaczki('123')).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(at.metody()).toEqual(['GiveMePackStatus'])
  })
})

describe('adapter orlenpaczka.zapis.v1', () => {
  it('manifest: nadanie, anulowanie i odszukanie; strażniki typu', () => {
    const { manifest } = ORLEN_ZAPIS_DEFINITION
    expect(manifest).toMatchObject({ kind: 'carrier', readOnly: false, capabilities: ['shipment.prepare', 'shipment.create', 'shipment.cancel', 'reference.find'] })
    expect(manifest.config.map((c) => c.key)).toEqual(expect.arrayContaining(['zapisWlaczony', 'nadawca', 'srodowisko']))
    const a = zapisowy(orlenAtrapa())
    expect(hasShipmentCanceller(a)).toBe(true)
    expect(hasReferenceFinder(a)).toBe(true)
  })

  it('bez zapisWlaczony: nadanie, etykieta, anulowanie, odszukanie i sprawdzenie numeru bez żadnego żądania', async () => {
    for (const config of [{}, { zapisWlaczony: false }]) {
      const at = orlenAtrapa()
      const a = zapisowy(at, config)
      expect(await a.createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF)).toEqual({ kind: 'TRWALY', reference: REF, message: 'zapis wyłączony' })
      await expect(a.getLabel(ORLEN_NUMER, 'PDF')).rejects.toMatchObject({ kind: 'TRWALY', message: 'zapis wyłączony' })
      expect(await a.cancelShipment!(ORLEN_NUMER, REF)).toMatchObject({ kind: 'TRWALY' })
      await expect(a.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
      expect(await a.confirmManual(ORLEN_NUMER, REF)).toMatchObject({ odmowa: expect.stringContaining('wyłączone') })
      expect(await executeWrite(a, REF, () => a.createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF))).toMatchObject({ kind: 'TRWALY' })
      expect(at.calls).toHaveLength(0)
    }
  })

  it('nadanie: GenerateBusinessPack z punktem, rozmiarem, odciskiem referencji; bez pobrania i ubezpieczenia; wynik bez danych odbiorcy', async () => {
    const at = orlenAtrapa()
    const r = await zapisowy(at, { zapisWlaczony: true }).createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF)
    expect(r).toEqual({ kind: 'OK', reference: REF, externalRef: ORLEN_NUMER })
    expect(at.metody()).toEqual(['GenerateBusinessPack'])
    const p = at.calls[0]!.pola
    expect(p).toMatchObject({
      PartnerID: ORLEN_PARTNER_ID,
      DestinationCode: ORLEN_PUNKT,
      BoxSize: 'M',
      FirstName: 'Jan',
      LastName: 'Testowy',
      PhoneNumber: '600100200',
      EMail: PII_SENTINELS[1],
      SenderCompanyName: 'Firma Testowa',
      SenderStreetName: 'Magazynowa',
      SenderBuildingNumber: '5',
      SenderFlatNumber: '2',
      SenderCity: 'Testowo',
      SenderPostCode: '00-002',
      SenderPhoneNumber: '500000000',
      SenderEMail: 'magazyn@example.invalid',
      SenderOrders: odciskReferencji(REF),
      PrintAdress: '1',
    })
    expect(odciskReferencji(REF)).toHaveLength(30)
    for (const k of ['CashOnDelivery', 'AmountCashOnDelivery', 'Insurance', 'PackValue', 'TransferDescription', 'ReturnPack']) expect(p).not.toHaveProperty(k)
    for (const s of PII_SENTINELS) expect(JSON.stringify(r)).not.toContain(s)
  })

  it('nadanie: braki odbiorcy, nadawcy, ostrzeżenia i zły przewoźnik = TRWALY bez żądania', async () => {
    const at = orlenAtrapa()
    const a = zapisowy(at, { zapisWlaczony: true })
    const send = (o: Partial<Parameters<typeof a.createShipment>[0]>) => a.createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN, ...o }, REF)
    expect(await send({ recipient: { ...ODBIORCA_ORLEN, telefon: null } })).toMatchObject({ kind: 'TRWALY', message: 'niepełne dane odbiorcy: telefon' })
    expect(await send({ recipient: { ...ODBIORCA_ORLEN, telefon: '123' } })).toMatchObject({ kind: 'TRWALY', message: 'niepełne dane odbiorcy: telefon (format)' })
    expect(await send({ recipient: { ...ODBIORCA_ORLEN, imieNazwisko: 'Jan' } })).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('imie_nazwisko') })
    expect(await send({ recipient: { ...ODBIORCA_ORLEN, kraj: 'DE' } })).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('krajowa') })
    expect(await send({ carrier: 'DPD' })).toMatchObject({ kind: 'TRWALY' })
    expect(await send({ parcel: { ...GOTOWA, problems: [{ kod: 'waga_domyslna', poziom: 'OSTRZEZENIE', tekst: 'x' }] } })).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('waga_domyslna') })
    expect(await send({ parcel: { ...GOTOWA, problems: [{ kod: 'waga_domyslna', poziom: 'OSTRZEZENIE', tekst: 'x' }] }, potwierdzoneOstrzezenia: ['waga_domyslna'] })).toMatchObject({ kind: 'OK' })
    const bezAdresu = zapisowy(orlenAtrapa(), { zapisWlaczony: true, nadawca: JSON.stringify({ ...NADAWCA_ORLEN, address: 'Magazynowa' }) })
    expect(await bezAdresu.createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('adres') })
    const bezMaila = zapisowy(orlenAtrapa(), { zapisWlaczony: true, nadawca: JSON.stringify({ ...NADAWCA_ORLEN, email: null }) })
    expect(await bezMaila.createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('email') })
    expect(at.metody()).toEqual(['GenerateBusinessPack']) // tylko potwierdzone ostrzeżenie poszło
  })

  it('nadanie: kody Orlenu na wynik; kod 6 = OK; błąd w trakcie i brak numeru = NIEJEDNOZNACZNY', async () => {
    const wynik = async (reply: Parameters<typeof orlenAtrapa>[0]) => zapisowy(orlenAtrapa(reply), { zapisWlaczony: true }).createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF)
    expect(await wynik([kodOdp('GenerateBusinessPack', 'GenerateBusinessPack', '006', { PackCode_RUCH: ORLEN_NUMER })])).toEqual({ kind: 'OK', reference: REF, externalRef: ORLEN_NUMER, info: expect.stringContaining('kod punktu odbioru') })
    expect(await wynik([kodOdp('GenerateBusinessPack', 'GenerateBusinessPack', '206')])).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('kod 206') })
    expect(await wynik([kodOdp('GenerateBusinessPack', 'GenerateBusinessPack', '300')])).toMatchObject({ kind: 'NIEJEDNOZNACZNY' })
    expect(await wynik([kodOdp('GenerateBusinessPack', 'GenerateBusinessPack', '000')])).toMatchObject({ kind: 'NIEJEDNOZNACZNY', message: expect.stringContaining('bez numeru') })
    expect(await wynik([{ status: 200, body: `<html>${PII_SENTINELS[0]}</html>` }])).toMatchObject({ kind: 'NIEJEDNOZNACZNY' })
    expect(await wynik([{ status: 503, body: '' }])).toMatchObject({ kind: 'NIEJEDNOZNACZNY' })
    expect(await wynik([{ status: 429, body: '' }])).toMatchObject({ kind: 'PRZEJSCIOWY' })
    expect(await wynik([{ status: 403, body: '' }])).toMatchObject({ kind: 'TRWALY' })
  })

  it('kod 006 i inny punkt w odpowiedzi = OK z informacją (oba kody punktu); ten sam punkt z nowym kodem; bez zmiany bez informacji', async () => {
    const wynik = async (reply: Parameters<typeof orlenAtrapa>[0]) => zapisowy(orlenAtrapa(reply), { zapisWlaczony: true }).createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF)
    const inny = await wynik([kodOdp('GenerateBusinessPack', 'GenerateBusinessPack', '006', { PackCode_RUCH: ORLEN_NUMER, DestinationCode: 'WS-222333-C1-01' })])
    expect(inny).toMatchObject({ kind: 'OK', externalRef: ORLEN_NUMER })
    expect((inny as { info?: string }).info).toContain('WS-222333-C1-01')
    expect((inny as { info?: string }).info).toContain(ORLEN_PUNKT)
    expect((inny as { info?: string }).info).toContain('zmienił punkt odbioru')
    const tenSam = await wynik([kodOdp('GenerateBusinessPack', 'GenerateBusinessPack', '006', { PackCode_RUCH: ORLEN_NUMER, DestinationCode: 'XX-116263-00-00' })])
    expect((tenSam as { info?: string }).info).toContain('ten sam punkt')
    // kod 000, ale Orlen zwrócił inny punkt: też informacja
    expect(await wynik([kodOdp('GenerateBusinessPack', 'GenerateBusinessPack', '000', { PackCode_RUCH: ORLEN_NUMER, DestinationCode: 'WS-999999-C1-01' })])).toMatchObject({ kind: 'OK', info: expect.stringContaining('WS-999999-C1-01') })
    // domyślna atrapa: ten sam punkt, kod 000 = bez informacji
    expect(await wynik([])).toEqual({ kind: 'OK', reference: REF, externalRef: ORLEN_NUMER })
    for (const r of [inny, tenSam]) for (const pii of PII_SENTINELS) expect(JSON.stringify(r)).not.toContain(pii)
  })

  it('timeout po wysłaniu → NIEJEDNOZNACZNY → odszukanie po referencji znajduje paczkę na etykiecie; brak duplikatu', async () => {
    const odcisk = odciskReferencji(REF)
    const at = orlenAtrapa([], {
      GenerateBusinessPack: [{ error: new Error('The operation was aborted') }],
      GetGeneratedParcels: [odpowiedz('GetGeneratedParcels', 'GetGeneratedParcels', [
        { Err: '000', ErrDes: 'saved', PackCode_RUCH: '2100000000024', Data: '2026-11-08T09:59:00+01:00' },
        { Err: '000', ErrDes: 'saved', PackCode_RUCH: ORLEN_NUMER, Data: '2026-11-08T10:59:00+01:00' },
      ])],
      LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl(odcisk)), etykietaOdp(etykietaZpl('KMPINNA'))],
    })
    const a = zapisowy(at, { zapisWlaczony: true })
    const out = await executeWrite(a, REF, () => a.createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF))
    expect(out).toEqual({ kind: 'OK', reference: REF, externalRef: ORLEN_NUMER })
    expect(at.metody()).toEqual(['GenerateBusinessPack', 'GetGeneratedParcels', 'LabelPrintDuplicateListTwo', 'LabelPrintDuplicateListTwo'])
    expect(at.metody().filter((m) => m === 'GenerateBusinessPack')).toHaveLength(1)
    // najnowsza paczka sprawdzana pierwsza, etykieta w ZPL (tekst odcisku), okno dat w czasie polskim
    expect(at.calls[1]!.pola).toMatchObject({ dateFrom: '2026-11-06', dateTo: '2026-11-09' })
    expect(at.calls[2]!.pola).toMatchObject({ Format: 'ZPL', PackCodeList: [ORLEN_NUMER] })
  })

  it('odszukanie nigdy nie zwraca „nie ma”: brak trafienia = błąd, etykiety niegotowe = PRZEJSCIOWY, dwa trafienia = TRWALY', async () => {
    const lista = (n: string[]) => odpowiedz('GetGeneratedParcels', 'GetGeneratedParcels', n.map((x, i) => ({ Err: '000', ErrDes: 'saved', PackCode_RUCH: x, Data: `2026-11-08T0${i}:00:00` })))
    const odcisk = odciskReferencji(REF)
    const brak = zapisowy(orlenAtrapa([], { GetGeneratedParcels: [lista([ORLEN_NUMER])], LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl('KMPINNA'))] }), { zapisWlaczony: true })
    const e = await brak.findByReference(REF).then(() => ({ kind: 'BEZ_BLEDU', message: '' }), (x: unknown) => x as { kind: string; message: string })
    expect(e).toMatchObject({ kind: 'TRWALY' })
    // okno, numery i godziny nadania; bez odsyłania do panelu, w którym paczek z API nie widać; bez danych odbiorcy
    expect(e.message).toContain('06.11–09.11')
    expect(e.message).toContain(`${ORLEN_NUMER} 08.11 00:00`)
    expect(e.message).not.toMatch(/sprawdź w panelu/i)
    for (const pii of PII_SENTINELS) expect(e.message).not.toContain(pii)
    const pusta = zapisowy(orlenAtrapa([], { GetGeneratedParcels: [lista([])] }), { zapisWlaczony: true })
    await expect(pusta.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
    const niegotowe = zapisowy(orlenAtrapa([], { GetGeneratedParcels: [lista([ORLEN_NUMER])], LabelPrintDuplicateListTwo: [etykietaOdp('', '211')] }), { zapisWlaczony: true })
    await expect(niegotowe.findByReference(REF)).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    const dwa = zapisowy(orlenAtrapa([], { GetGeneratedParcels: [lista([ORLEN_NUMER, '2100000000024'])], LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl(odcisk)), etykietaOdp(etykietaZpl(odcisk))] }), { zapisWlaczony: true })
    await expect(dwa.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('kilka') })
    const odmowa = zapisowy(orlenAtrapa([], { GetGeneratedParcels: [kodOdp('GetGeneratedParcels', 'GetGeneratedParcels', '401')] }), { zapisWlaczony: true })
    await expect(odmowa.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
    // NIEJEDNOZNACZNY bez potwierdzenia zostaje NIEJEDNOZNACZNY (nie PRZEJSCIOWY: host nie ponowi nadania)
    const at = orlenAtrapa([], { GenerateBusinessPack: [{ status: 502, body: '' }], GetGeneratedParcels: [lista([ORLEN_NUMER])], LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl('KMPINNA'))] })
    const a = zapisowy(at, { zapisWlaczony: true })
    expect((await executeWrite(a, REF, () => a.createShipment({ carrier: 'ORLEN_PACZKA', parcel: GOTOWA, recipient: ODBIORCA_ORLEN }, REF))).kind).toBe('NIEJEDNOZNACZNY')
  })

  it('odszukanie sprawdza najwyżej 10 najnowszych paczek', async () => {
    const numery = Array.from({ length: 14 }, (_, i) => `21000000001${String(i).padStart(2, '0')}`)
    const at = orlenAtrapa([], { GetGeneratedParcels: [odpowiedz('GetGeneratedParcels', 'GetGeneratedParcels', numery.map((n, i) => ({ Err: '000', PackCode_RUCH: n, Data: `2026-11-08T${String(i).padStart(2, '0')}:00:00` })))] })
    const e = await zapisowy(at, { zapisWlaczony: true }).findByReference(REF).then(() => ({ kind: 'BEZ_BLEDU', message: '' }), (x: unknown) => x as { kind: string; message: string })
    expect(e).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('starszych niesprawdzonych: 4') })
    // wykaz 10 paczek mieści się w komunikacie hosta (krotko: 1000 znaków)
    expect(e.message.length).toBeLessThan(1000)
    expect(e.message).toContain(`${numery[13]} 08.11 13:00`)
    const etykiety = at.calls.filter((c) => c.metoda === 'LabelPrintDuplicateListTwo')
    expect(etykiety).toHaveLength(10)
    expect(etykiety[0]!.pola['PackCodeList']).toEqual([numery[13]])
  })

  it('etykieta: duplikat w formacie hosta; 211 = PRZEJSCIOWY; zły numer bez żądania', async () => {
    const at = orlenAtrapa()
    const l = await zapisowy(at, { zapisWlaczony: true }).getLabel(ORLEN_NUMER, 'PDF')
    expect(l.contentType).toBe('application/pdf')
    expect(at.calls[0]!.pola).toMatchObject({ Format: 'PDF', PackCodeList: [ORLEN_NUMER] })
    await expect(zapisowy(orlenAtrapa([etykietaOdp('', '211')]), { zapisWlaczony: true }).getLabel(ORLEN_NUMER, 'ZPL')).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    await expect(zapisowy(orlenAtrapa([etykietaOdp('', '212')]), { zapisWlaczony: true }).getLabel(ORLEN_NUMER, 'ZPL')).rejects.toMatchObject({ kind: 'TRWALY' })
    const z = orlenAtrapa()
    await expect(zapisowy(z, { zapisWlaczony: true }).getLabel('123', 'PDF')).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(z.calls).toHaveLength(0)
  })

  it('anulowanie: OK, „już anulowana” = OK, „nie można” = TRWALY, sieć = PRZEJSCIOWY (ponowienie bezpieczne)', async () => {
    const an = async (reply: Parameters<typeof orlenAtrapa>[0]) => zapisowy(orlenAtrapa(reply), { zapisWlaczony: true }).cancelShipment!(ORLEN_NUMER, 'anul-1')
    expect(await an([])).toEqual({ kind: 'OK', reference: 'anul-1', externalRef: ORLEN_NUMER })
    expect(await an([kodOdp('PutCustomerPackCanceled', 'CustomerPackCanceled', '201')])).toMatchObject({ kind: 'OK' })
    expect(await an([kodOdp('PutCustomerPackCanceled', 'CustomerPackCanceled', '202')])).toMatchObject({ kind: 'TRWALY' })
    expect(await an([{ error: new Error('reset') }])).toMatchObject({ kind: 'PRZEJSCIOWY' })
    expect(await an([kodOdp('PutCustomerPackCanceled', 'CustomerPackCanceled', '901')])).toMatchObject({ kind: 'PRZEJSCIOWY' })
  })

  it('„Rozstrzygnij ręcznie”: etykieta z odciskiem = potwierdzone; inna referencja, obca paczka = odmowa; paczka w drodze tylko z listy paczek konta', async () => {
    const odcisk = odciskReferencji(REF)
    const potw = (replies: Parameters<typeof orlenAtrapa>[1], numer = ORLEN_NUMER) => zapisowy(orlenAtrapa([], replies), { zapisWlaczony: true }).confirmManual(numer, REF)
    expect(await potw({ LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl(odcisk))] })).toEqual({ externalRef: ORLEN_NUMER, info: expect.stringContaining('referencję'), referencjaSprawdzona: true })
    expect(await potw({ LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl('KMPINNA'))] })).toMatchObject({ odmowa: expect.stringContaining('inna paczka') })
    expect(await potw({ LabelPrintDuplicateListTwo: [etykietaOdp('', '223')] })).toMatchObject({ odmowa: expect.stringContaining('nie potwierdził') })
    for (const w of [await potw({ LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl('KMPINNA'))] }), await potw({ LabelPrintDuplicateListTwo: [etykietaOdp('', '223')] })])
      expect(JSON.stringify(w)).not.toMatch(/w panelu Orlen/i)
    const lista = (n: string[]) => odpowiedz('GetGeneratedParcels', 'GetGeneratedParcels', n.map((x) => ({ Err: '000', ErrDes: 'saved', PackCode_RUCH: x, Data: '2026-11-08T10:59:00+01:00' })))
    // 213 + numer na liście paczek API tego konta = przyjęty, z prawdziwą informacją (referencji nie porównano)
    const wDrodze = await potw({ LabelPrintDuplicateListTwo: [etykietaOdp('', '213')], GetGeneratedParcels: [lista(['2100000000029', ORLEN_NUMER])] })
    expect(wDrodze).toMatchObject({ externalRef: ORLEN_NUMER, info: expect.stringContaining('nie porównano') })
    expect((wDrodze as { info: string }).info).toContain('08.11 10:59')
    expect((wDrodze as { info: string }).info).not.toContain('należy do konta')
    expect(wDrodze).not.toHaveProperty('referencjaSprawdzona')
    // 213 + numer spoza listy (sąsiedni seryjny numer tej firmy, poprawna cyfra kontrolna) = odmowa, bez statusu z publicznego śledzenia
    const obcy = orlenAtrapa([], { LabelPrintDuplicateListTwo: [etykietaOdp('', '213')], GetGeneratedParcels: [lista(['2100000000029'])] })
    expect(await zapisowy(obcy, { zapisWlaczony: true }).confirmManual(ORLEN_NUMER, REF)).toMatchObject({ odmowa: expect.stringContaining('nie ma') })
    expect(obcy.metody()).toEqual(['LabelPrintDuplicateListTwo', 'GetGeneratedParcels'])
    // 213 + pusta lista = odmowa
    expect(await potw({ LabelPrintDuplicateListTwo: [etykietaOdp('', '213')], GetGeneratedParcels: [lista([])] })).toMatchObject({ odmowa: expect.stringContaining('w drodze') })
    // 213 + lista niedostępna = wyjątek (host: odmowa albo „spróbuj ponownie”), nic nie przyjęte
    await expect(potw({ LabelPrintDuplicateListTwo: [etykietaOdp('', '213')], GetGeneratedParcels: [kodOdp('GetGeneratedParcels', 'GetGeneratedParcels', '401')] })).rejects.toMatchObject({ kind: 'TRWALY' })
    // literówka w EAN-13 (zła cyfra kontrolna) = odmowa bez żadnego żądania, także gdy Orlen dałby 213
    const literowka = orlenAtrapa([], { LabelPrintDuplicateListTwo: [etykietaOdp('', '213')], GetGeneratedParcels: [lista(['2100000000013'])] })
    expect(await zapisowy(literowka, { zapisWlaczony: true }).confirmManual('2100000000013', REF)).toMatchObject({ odmowa: expect.stringContaining('cyfrę kontrolną') })
    expect(literowka.calls).toHaveLength(0)
    await expect(potw({ LabelPrintDuplicateListTwo: [etykietaOdp('', '211')] })).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    const z = orlenAtrapa()
    expect(await zapisowy(z, { zapisWlaczony: true }).confirmManual('ABC', REF)).toMatchObject({ odmowa: expect.stringContaining('13-cyfrowy') })
    expect(z.calls).toHaveLength(0)
  })
})
