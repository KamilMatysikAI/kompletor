// adaptery `pocztapolska.enadawca.v1` i `.zapis.v1` na atrapie SOAP. Dane fikcyjne, zero połączeń z Pocztą
// Polską (także ze środowiskiem testowym eNadawcy): zapis tylko za wyłącznikiem.
import { describe, expect, it } from 'vitest'
import { ADRESAT_PP, fault, GUID_OBCY, NADAWCA_PP, PP_HASLO, PP_LOGIN, PP_URZAD, ppAtrapa, type OpcjeAtrapy } from '../../tests/pocztapolska-atrapa'
import { guidZReferencji, formatPP, wyliczPrzesylkePP, ustawieniaPP } from '../wysylka/pocztapolska'
import { ReadOnlyViolation } from '../zrodla/http'
import { bledy, EnadawcaOdczyt, EnadawcaZapis, ENADAWCA_TEST, kopertaPP, METODY_ODCZYTU_PP, METODY_ZAPISU_PP, tekstZLimitem } from '../zrodla/pocztapolska'
import { defaultRegistry } from './domyslne'
import { AdapterError, hasShipmentCreator, hasShipmentTracker, type ChannelAdapter, type PreparedParcel, type ShipmentInput } from './kontrakt'
import { MAKS_BUFOROW_PRZESZUKANIA, opisPartii, PP_KEY, PP_ZAPIS_KEY, znacznikFirmy, type PocztaPolskaZapis } from './pocztapolska'
import { jestNieZnaleziono, klasyfikujBledy, type KlasaBleduPP } from './pocztapolska-kody'
import { PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'

const FAST = { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 }
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'pp', name: 'Poczta Polska' }
const SECRETS = { ENADAWCA_LOGIN: PP_LOGIN, ENADAWCA_HASLO: PP_HASLO }
const SLEDZENIE = { SLEDZENIE_LOGIN: 'sledzenie_test', SLEDZENIE_HASLO: 'haslo-sledzenia-1' }
const REF = 'a1b2c3d4-e5f6-5789-8abc-def012345678'
const REF2 = 'b1b2c3d4-e5f6-5789-8abc-def012345678'
const NOW = new Date('2026-11-10T10:00:00Z')
const DZIEN = '2026-11-10'
const PARTIA = opisPartii(znacznikFirmy('org'), DZIEN)

type Atrapa = ReturnType<typeof ppAtrapa>

interface Opcje {
  secrets?: Record<string, string>
  org?: string
}
function adapter(key: string, a: Atrapa, config: Record<string, unknown> = {}, o: Opcje = {}): ChannelAdapter {
  return defaultRegistry().create(key, { integration: { ...integration, organizationId: o.org ?? 'org' }, rawConfig: { urzadNadania: PP_URZAD, ...config }, rawSecrets: o.secrets ?? SECRETS, fetch: a.fetchImpl, http: FAST, now: () => NOW })
}
function zapisowy(a: Atrapa, config: Record<string, unknown> = { zapisWlaczony: true }, o: Opcje = {}): PocztaPolskaZapis {
  const ad = adapter(PP_ZAPIS_KEY, a, { nadawca: JSON.stringify(NADAWCA_PP), ...config }, o)
  if (!hasShipmentCreator(ad)) throw new Error('bez shipment.create')
  return ad as unknown as PocztaPolskaZapis
}

const WEJSCIE: ShipmentInput = { carrier: 'POCZTA_POLSKA', gabaryt: 'POCZTA_POLSKA', weightG: 1500, weightComplete: true, paymentState: 'PAID', paymentMethod: 'przelew', totalGross: 99, codAmountUncertain: null, pickupPoint: null }
const GOTOWA: PreparedParcel = { courierCode: 'M', gabaryt: 'POCZTA_POLSKA', sideXCm: 15, sideYCm: 30, sideZCm: 40, weightKg: 1.5, codAmount: null, pickupPoint: null, problems: [] }
const REQ = { parcel: GOTOWA, carrier: 'POCZTA_POLSKA' as const, recipient: ADRESAT_PP }
/** Ponowienie tej samej referencji (host: wiersz po BLAD), tylko wtedy kontrola przed dodaniem. */
const PON = { ...REQ, ponowienie: true }
const ZAPISY = new Set<string>(METODY_ZAPISU_PP)

for (const key of [PP_KEY, PP_ZAPIS_KEY]) {
  runAdapterContract({
    name: key,
    now: NOW,
    setup() {
      const a = ppAtrapa()
      return { adapter: adapter(key, a), putOrder: () => {}, corruptOrder: () => {}, failNextList: () => {}, requests: () => a.metody(), readMethods: ['getUrzedyNadania'] }
    },
  })
}

describe('klient SOAP eNadawcy', () => {
  it('koperta: przestrzeń nazw, atrybuty, listy, znaki zakodowane, puste pominięte', () => {
    const k = kopertaPP('http://e-nadawca.poczta-polska.pl', 'clearEnvelopeByGuids', { guid: ['A1', 'B2'], idBufor: 7, opis: 'A&B <c>', brak: null, p: { '@guid': 'X', masa: 10 } })
    expect(k).toContain('<tns:clearEnvelopeByGuids><guid>A1</guid><guid>B2</guid><idBufor>7</idBufor><opis>A&amp;B &lt;c&gt;</opis><p guid="X"><masa>10</masa></p></tns:clearEnvelopeByGuids>')
    expect(k).not.toContain('brak')
    expect(() => kopertaPP('ns', 'zła metoda', {})).toThrow()
  })

  it('odczyt odmawia metod zapisu, zapis odmawia clearEnvelope (czyści cały bufor konta) i wymaga wyłącznika', async () => {
    const a = ppAtrapa()
    const o = new EnadawcaOdczyt({ url: ENADAWCA_TEST, auth: { login: PP_LOGIN, haslo: PP_HASLO }, fetchImpl: a.fetchImpl })
    for (const m of ['addShipment', 'sendEnvelope', 'clearEnvelope', 'createEnvelopeBufor']) await expect(o.wywolaj(m)).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(METODY_ODCZYTU_PP).not.toContain('clearEnvelope')
    expect(METODY_ZAPISU_PP).not.toContain('clearEnvelope' as never)
    const z = new EnadawcaZapis({ url: ENADAWCA_TEST, auth: { login: PP_LOGIN, haslo: PP_HASLO }, fetchImpl: a.fetchImpl, wylacznik: true })
    await expect(z.wywolaj('clearEnvelope' as never, {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(() => new EnadawcaZapis({ url: ENADAWCA_TEST, auth: { login: PP_LOGIN, haslo: PP_HASLO } } as never)).toThrow()
    expect(() => new EnadawcaOdczyt({ url: 'https://evil.example/websrv/en.php', auth: { login: PP_LOGIN, haslo: PP_HASLO } })).toThrow()
    expect(a.calls).toHaveLength(0)
  })

  it('Basic do eNadawcy, bez przekierowań; hasło nie wraca w komunikacie', async () => {
    const a = ppAtrapa({ awarie: { getUrzedyNadania: [{ po: 'przed', blad: new Error(`connect failed ${PP_HASLO}`) }, { po: 'przed', blad: new Error(`connect failed ${PP_HASLO}`) }] } })
    const t = await adapter(PP_KEY, a).testConnection()
    expect(t.ok).toBe(false)
    expect(t.details?.['rodzaj']).toBe('PRZEJSCIOWY')
    expect(JSON.stringify(t)).not.toContain(PP_HASLO)
    expect(a.calls[0]!.headers['Authorization']).toBe(`Basic ${Buffer.from(`${PP_LOGIN}:${PP_HASLO}`).toString('base64')}`)
  })
})

describe('pocztapolska.enadawca.v1: odczyt', () => {
  it('test połączenia pokazuje urzędy; urząd spoza listy = błąd konfiguracji', async () => {
    expect((await adapter(PP_KEY, ppAtrapa()).testConnection()).ok).toBe(true)
    const zly = await adapter(PP_KEY, ppAtrapa(), { urzadNadania: '999' }).testConnection()
    expect(zly.ok).toBe(false)
    expect(zly.message).toContain('999')
  })

  it('401 = TRWALY (zły login)', async () => {
    const a = ppAtrapa({ awarie: { getUrzedyNadania: [{ po: 'przed', status: 401 }] } })
    const t = await adapter(PP_KEY, a).testConnection()
    expect(t.details?.['rodzaj']).toBe('TRWALY')
  })

  it('przygotowanie: format z wymiarów, ponadgabaryt, pobranie blokuje, zły przewoźnik blokuje', () => {
    expect(formatPP([8, 30, 60], 1000)).toBe('S')
    expect(formatPP([15, 30, 40], 1000)).toBe('M')
    expect(formatPP([60, 60, 70], 1000)).toBe('XL')
    expect(formatPP([50, 80, 110], 25_000)).toBe('2XL')
    expect(formatPP([50, 80, 130], 1000)).toBeNull()
    const p = wyliczPrzesylkePP(WEJSCIE, ustawieniaPP({ defaultSideXCm: 15, defaultSideYCm: 30, defaultSideZCm: 40 }))
    expect(p.courierCode).toBe('M')
    expect(p.problems).toEqual([])
    const d = wyliczPrzesylkePP(WEJSCIE, ustawieniaPP({}))
    expect(d.problems.map((x) => x.kod)).toContain('wymiary_domyslne')
    const cod = wyliczPrzesylkePP({ ...WEJSCIE, paymentState: 'COD' }, ustawieniaPP({ defaultSideXCm: 15, defaultSideYCm: 30, defaultSideZCm: 40 }))
    expect(cod.problems.some((x) => x.kod === 'pobranie' && x.poziom === 'BLAD')).toBe(true)
    expect(wyliczPrzesylkePP({ ...WEJSCIE, carrier: 'DPD' }, ustawieniaPP({})).problems.some((x) => x.kod === 'kod_kuriera')).toBe(true)
  })

  it('GUID z referencji: stały, 32 znaki szesnastkowe, różny dla różnych referencji', () => {
    expect(guidZReferencji(REF)).toMatch(/^[0-9A-F]{32}$/)
    expect(guidZReferencji(REF)).toBe(guidZReferencji(REF))
    expect(guidZReferencji(REF)).not.toBe(guidZReferencji(REF2))
  })

  it('śledzenie z WSSE (bez Basic): zdarzenie = PRZEKAZANA, brak przesyłki = PRZED_NADANIEM, Fault WSSE = TRWALY', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a, { zapisWlaczony: true }, { secrets: { ...SECRETS, ...SLEDZENIE } })
    const o = await z.createShipment(REQ, REF)
    expect(o.kind).toBe('OK')
    const guid = (o as { externalRef: string }).externalRef
    expect(hasShipmentTracker(adapter(PP_KEY, a))).toBe(false)
    const ad = adapter(PP_ZAPIS_KEY, a, { zapisWlaczony: true }, { secrets: { ...SECRETS, ...SLEDZENIE } })
    if (!hasShipmentTracker(ad)) throw new Error('bez shipment.track')
    // świeży adapter: numer nadania z bufora partii, nie z pamięci
    expect(await ad.trackShipment(guid)).toMatchObject({ stan: 'PRZEKAZANA', status: 'P_NAD', stanDrogi: 'PRZEKAZANA', kod: 'P_NAD' })
    const wsse = a.calls.find((c) => c.url.includes('Sledzenie'))!
    expect(wsse.body).toContain('<wsse:Username>sledzenie_test</wsse:Username>')
    expect(wsse.body).not.toContain(PP_LOGIN)
    expect(wsse.headers['Authorization']).toBeUndefined()
    const brak = ppAtrapa({ sledzenie: { status: -1 } })
    const z2 = zapisowy(brak, { zapisWlaczony: true }, { secrets: { ...SECRETS, ...SLEDZENIE } })
    const g2 = ((await z2.createShipment(REQ, REF)) as { externalRef: string }).externalRef
    expect(await z2.trackShipment(g2)).toEqual({ stan: 'PRZED_NADANIEM', status: null, stanDrogi: 'UTWORZONA' })
    const zly = ppAtrapa({ sledzenie: { http: 500, body: fault('soap:Client', 'WSSE: nieprawidłowy token') } })
    const z3 = zapisowy(zly, { zapisWlaczony: true }, { secrets: { ...SECRETS, ...SLEDZENIE } })
    const g3 = ((await z3.createShipment(REQ, REF)) as { externalRef: string }).externalRef
    await expect(z3.trackShipment(g3)).rejects.toMatchObject({ kind: 'TRWALY' })
  })
})

describe('pocztapolska.enadawca.zapis.v1: wyłącznik', () => {
  it('bez zapisWlaczony zero żądań zapisu (utworzenie, etykieta, anulowanie, odszukanie, partia)', async () => {
    for (const config of [{}, { zapisWlaczony: false }]) {
      const a = ppAtrapa()
      const z = zapisowy(a, config)
      expect((await z.createShipment(REQ, REF)).kind).toBe('TRWALY')
      await expect(z.getLabel(guidZReferencji(REF), 'PDF')).rejects.toBeInstanceOf(AdapterError)
      expect((await z.cancelShipment(guidZReferencji(REF), REF)).kind).toBe('TRWALY')
      await expect(z.findByReference(REF)).rejects.toBeInstanceOf(AdapterError)
      await expect(z.wyslijPartie()).rejects.toBeInstanceOf(AdapterError)
      expect('odmowa' in (await z.confirmManual('00659007734000000001', REF))).toBe(true)
      expect(a.metody().filter((m) => ZAPISY.has(m))).toEqual([])
    }
  })
})

describe('pocztapolska.enadawca.zapis.v1: partia i bufor', () => {
  it('przesyłka trafia do bufora Kompletora z dnia (nowy bufor, potem ten sam); bufor ręczny nietknięty', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    const o1 = await z.createShipment(REQ, REF)
    const o2 = await z.createShipment(REQ, REF2)
    expect([o1.kind, o2.kind]).toEqual(['OK', 'OK'])
    expect(a.metody().filter((m) => m === 'createEnvelopeBufor')).toHaveLength(1)
    const partia = a.bufory.find((b) => b.opis === PARTIA)!
    expect(partia.przesylki.map((p) => p.guid)).toEqual([guidZReferencji(REF), guidZReferencji(REF2)])
    expect(a.bufory.find((b) => b.id === '7')!.przesylki).toHaveLength(1)
    const add = a.calls.find((c) => c.metoda === 'addShipment')!
    expect(add.body).toContain(`guid="${guidZReferencji(REF)}"`)
    expect(add.body).toContain('<masa>1500</masa><format>M</format>')
    expect(await z.getTrackingNumber(guidZReferencji(REF))).toMatch(/^\d{20}$/)
  })

  it('anulowanie = clearEnvelopeByGuids tylko z GUID tej przesyłki; inne paczki partii i bufor ręczny zostają; clearEnvelope nigdy', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    const g1 = ((await z.createShipment(REQ, REF)) as { externalRef: string }).externalRef
    await z.createShipment(REQ, REF2)
    const c = await z.cancelShipment(g1, REF)
    expect(c.kind).toBe('OK')
    const wyw = a.calls.filter((x) => x.metoda === 'clearEnvelopeByGuids')
    expect(wyw).toHaveLength(1)
    expect([...wyw[0]!.body.matchAll(/<guid>([^<]*)<\/guid>/g)].map((m) => m[1])).toEqual([g1])
    expect(a.metody()).not.toContain('clearEnvelope')
    const partia = a.bufory.find((b) => b.opis === PARTIA)!
    expect(partia.przesylki.map((p) => p.guid)).toEqual([guidZReferencji(REF2)])
    expect(a.bufory.find((b) => b.id === '7')!.przesylki).toHaveLength(1)
    // ponowienie: przesyłki już nie ma, bez drugiego żądania zapisu
    expect((await z.cancelShipment(g1, REF)).kind).toBe('OK')
    expect(a.calls.filter((x) => x.metoda === 'clearEnvelopeByGuids')).toHaveLength(1)
  })

  it('obca przesyłka (inna partia, inny GUID) nie daje się anulować przez Kompletor', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    await z.createShipment(REQ, REF)
    expect((await z.cancelShipment(GUID_OBCY, REF)).kind).toBe('OK') // eNadawca jej nie zna w buforach Kompletora
    expect(a.calls.filter((x) => x.metoda === 'clearEnvelopeByGuids')).toHaveLength(0)
    expect(a.bufory.find((b) => b.id === '7')!.przesylki).toHaveLength(1)
  })

  it('wyślij partię: tylko bufor Kompletora z dnia, opcjonalnie kurier; potem anulowanie odmawia', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a, { zapisWlaczony: true, zamowKuriera: true, godzinaOdbioru: '14:00' })
    const g = ((await z.createShipment(REQ, REF)) as { externalRef: string }).externalRef
    const w = await z.wyslijPartie()
    expect(w).toMatchObject({ dzien: DZIEN, przesylek: 1, idEnvelope: '555', status: 'WYSLANY', kurier: 'ZAMOWIONY', zalegle: [] })
    // kurier dopiero po wysłaniu partii
    expect(a.metody().indexOf('sendEnvelope')).toBeLessThan(a.metody().indexOf('zamowKuriera'))
    const send = a.calls.find((c) => c.metoda === 'sendEnvelope')!
    expect(send.body).toContain(`<urzadNadania>${PP_URZAD}</urzadNadania>`)
    expect(a.bufory.find((b) => b.id === '7')!.wyslany).toBe(false)
    expect((await z.cancelShipment(g, REF)).kind).toBe('TRWALY')
    expect((await z.findByReference(REF)).found).toBe(true) // po wysłaniu: dane przesyłki po GUID
    const pusta = await zapisowy(ppAtrapa()).wyslijPartie()
    expect(pusta.przesylek).toBe(0)
  })

  it('timeout po sendEnvelope = NIEJEDNOZNACZNY z prośbą o sprawdzenie w eNadawcy', async () => {
    const a = ppAtrapa({ awarie: { sendEnvelope: [{ po: 'po', blad: new Error('timeout') }] } })
    const z = zapisowy(a)
    await z.createShipment(REQ, REF)
    await expect(z.wyslijPartie()).rejects.toMatchObject({ kind: 'NIEJEDNOZNACZNY' })
  })
})

describe('pocztapolska.enadawca.zapis.v1: idempotencja', () => {
  it('timeout po addShipment: NIEJEDNOZNACZNY, odszukanie znajduje przesyłkę, ponowienie nie tworzy duplikatu', async () => {
    const a = ppAtrapa({ awarie: { addShipment: [{ po: 'po', blad: new Error('timeout') }] } })
    const z = zapisowy(a)
    const o = await z.createShipment(REQ, REF)
    expect(o.kind).toBe('NIEJEDNOZNACZNY')
    const f = await z.findByReference(REF)
    expect(f).toEqual({ found: true, externalRef: guidZReferencji(REF) })
    const again = await zapisowy(a).createShipment(PON, REF)
    expect(again.kind).toBe('OK')
    expect(a.bufory.flatMap((b) => b.przesylki).filter((p) => p.guid === guidZReferencji(REF))).toHaveLength(1)
  })

  it('odszukanie bez trafienia = błąd TRWALY, nigdy found: false', async () => {
    const z = zapisowy(ppAtrapa())
    await expect(z.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
  })

  it('błąd danych = TRWALY bez danych adresata w komunikacie; 5xx = NIEJEDNOZNACZNY', async () => {
    const z = zapisowy(ppAtrapa({ bladDodania: { numer: 3005, opis: 'Nieprawidłowy kod pocztowy adresata' } }))
    const o = await z.createShipment(REQ, REF)
    expect(o.kind).toBe('TRWALY')
    for (const s of PII_SENTINELS) expect(JSON.stringify(o)).not.toContain(s)
    const z5 = zapisowy(ppAtrapa({ awarie: { addShipment: [{ po: 'po', status: 502 }] } }))
    expect((await z5.createShipment(REQ, REF)).kind).toBe('NIEJEDNOZNACZNY')
  })

  it('rozstrzygnięcie ręczne: numer przesyłki tej referencji przyjęty, inny odrzucony', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    await z.createShipment(REQ, REF)
    const numer = a.bufory.flatMap((b) => b.przesylki).find((p) => p.guid === guidZReferencji(REF))!.numer
    expect(await z.confirmManual(numer, REF)).toMatchObject({ externalRef: guidZReferencji(REF), referencjaSprawdzona: true })
    expect('odmowa' in (await z.confirmManual('00659007734000000099', REF))).toBe(true)
  })

  it('brak urzędu nadania = TRWALY (konfiguracja) bez żądań zapisu', async () => {
    const a = ppAtrapa()
    const o = await zapisowy(a, { zapisWlaczony: true, urzadNadania: '' }).createShipment(REQ, REF)
    expect(o).toMatchObject({ kind: 'TRWALY', errorClass: 'KONFIGURACJA' })
    expect(a.metody().filter((m) => ZAPISY.has(m))).toEqual([])
  })
})

describe('błędy eNadawcy → klasy Kompletora (tabela)', () => {
  const xml = (nr: number, opis: string) => `<retval><error><errorNumber>${nr}</errorNumber><errorDesc>${opis}</errorDesc></error></retval>`
  const PRZYPADKI: [string, KlasaBleduPP][] = [
    ['Przesyłka o podanym guid już istnieje', 'DUPLIKAT'],
    ['Bufor nie istnieje', 'BUFOR'],
    ['Bufor został już wysłany', 'BUFOR'],
    ['Błąd autoryzacji: nieprawidłowy login', 'TRWALY'],
    ['Urząd nadania nie jest przypisany do umowy', 'TRWALY'],
    ['Usługa chwilowo niedostępna, spróbuj ponownie', 'PRZEJSCIOWY'],
    ['Nieprawidłowy kod pocztowy adresata', 'TRWALY'],
    ['', 'TRWALY'],
  ]
  for (const [opis, klasa] of PRZYPADKI) it(`„${opis || '(pusty)'}” → ${klasa}`, () => expect(klasyfikujBledy(bledy(xml(1, opis)))?.klasa).toBe(klasa))
  it('klasa konta: login = UWIERZYTELNIENIE, urząd = KONFIGURACJA; brak błędów = null; gorszy wygrywa', () => {
    expect(klasyfikujBledy(bledy(xml(1, 'Błąd autoryzacji')))?.errorClass).toBe('UWIERZYTELNIENIE')
    expect(klasyfikujBledy(bledy(xml(1, 'Urząd nadania nieznany')))?.errorClass).toBe('KONFIGURACJA')
    expect(klasyfikujBledy([])).toBeNull()
    expect(klasyfikujBledy([...bledy(xml(1, 'chwilowo niedostępna')), ...bledy(xml(2, 'Zła masa'))])?.klasa).toBe('TRWALY')
  })
})

describe('poprawki i drobne', () => {
  const guid = guidZReferencji(REF)
  const wBuforach = (a: Atrapa, g: string) => a.bufory.flatMap((b) => b.przesylki).filter((p) => p.guid === g)
  const ile = (a: Atrapa, m: string) => a.metody().filter((x) => x === m).length
  const awaria503 = () => ({ po: 'przed' as const, status: 503 })

  it('nierozpoznana odpowiedź odczytu po GUID przy anulowaniu = TRWALY „sprawdź i usuń”, nigdy OK', async () => {
    const a = ppAtrapa({ bladOdczytuGuid: { numer: 9999, opis: 'Błąd wewnętrzny usługi' } })
    const c = await zapisowy(a).cancelShipment(guid, REF)
    expect(c.kind).toBe('TRWALY')
    expect((c as { message: string }).message).toContain('sprawdź i usuń przesyłkę w eNadawcy')
    expect(ile(a, 'clearEnvelopeByGuids')).toBe(0)
  })

  it('błąd odczytu bufora przy anulowaniu nie zwraca OK (to nie dowód braku przesyłki)', async () => {
    const a = ppAtrapa()
    await zapisowy(a).createShipment(REQ, REF)
    const b = ppAtrapa({ awarie: { getEnvelopeBufor: [awaria503(), awaria503()] } })
    // ten sam stan: przesyłka w buforze Kompletora, odczyt bufora pada
    b.bufory.push(...a.bufory.filter((x) => x.opis === PARTIA))
    const c = await zapisowy(b).cancelShipment(guid, REF)
    expect(c.kind).not.toBe('OK')
    expect(ile(b, 'clearEnvelopeByGuids')).toBe(0)
    expect(wBuforach(b, guid)).toHaveLength(1)
  })

  it('anulowanie szuka we wszystkich buforach Kompletora, także starszych niż 5 dni', async () => {
    const a = ppAtrapa()
    const zn = znacznikFirmy('org')
    for (let d = 1; d <= 6; d++) a.bufory.push({ id: String(200 + d), opis: opisPartii(zn, `2026-11-0${d}`), urzad: PP_URZAD, przesylki: d === 1 ? [{ guid, numer: '00659007734000000500' }] : [{ guid: 'C'.repeat(31) + d, numer: `0065900773400000060${d}` }], wyslany: false })
    const c = await zapisowy(a).cancelShipment(guid, REF)
    expect(c.kind).toBe('OK')
    expect(wBuforach(a, guid)).toHaveLength(0)
    expect(a.bufory.find((b) => b.id === '202')!.przesylki).toHaveLength(1)
  })

  it('ponowienie po niepewnym addShipment przy innym opisie duplikatu = dokładnie jedna przesyłka, bez drugiego dodania', async () => {
    const a = ppAtrapa({ opisDuplikatu: 'Przesyłka o podanym identyfikatorze już istnieje', awarie: { addShipment: [{ po: 'po', blad: new Error('timeout') }] } })
    expect((await zapisowy(a).createShipment(REQ, REF)).kind).toBe('NIEJEDNOZNACZNY')
    const again = await zapisowy(a).createShipment(PON, REF)
    expect(again).toMatchObject({ kind: 'OK', externalRef: guid })
    expect(ile(a, 'addShipment')).toBe(1)
    expect(wBuforach(a, guid)).toHaveLength(1)
  })

  it('nieznany błąd po wykonanym addShipment = sprawdzenie w eNadawcy i potwierdzenie (nie TRWALY)', async () => {
    const a = ppAtrapa({ bladPoDodaniu: { numer: 4711, opis: 'Operacja zakończona z uwagami' } })
    const z = zapisowy(a)
    const o = await z.createShipment(REQ, REF)
    expect(o).toMatchObject({ kind: 'OK', externalRef: guid })
    expect(wBuforach(a, guid)).toHaveLength(1)
    // bufor z pamięci wyzerowany po nieznanym błędzie
    expect((z as unknown as { partia: unknown }).partia).toBeNull()
  })

  it('nieznany błąd zapisu i błąd odczytu przy sprawdzeniu = NIEJEDNOZNACZNY', async () => {
    const a = ppAtrapa({ bladPoDodaniu: { numer: 4711, opis: 'Operacja zakończona z uwagami' }, awarie: { getEnvelopeBufor: [awaria503(), awaria503()] } })
    expect((await zapisowy(a).createShipment(REQ, REF)).kind).toBe('NIEJEDNOZNACZNY')
  })

  it('nieznany błąd danych bez przesyłki = TRWALY ze stałym tekstem i kodem, bez opisu eNadawcy', async () => {
    const [imie] = PII_SENTINELS
    const a = ppAtrapa({ bladDodania: { numer: 3005, opis: `Nieprawidłowy adres: ${imie}` } })
    const o = await zapisowy(a).createShipment(REQ, REF)
    expect(o.kind).toBe('TRWALY')
    expect((o as { message: string }).message).toContain('kod 3005')
    expect(JSON.stringify(o)).not.toContain('Nieprawidłowy adres')
    for (const s of PII_SENTINELS) expect(JSON.stringify(o)).not.toContain(s)
  })

  it('błąd odczytu przed dodaniem = nic nie wysłano', async () => {
    const a = ppAtrapa({ awarie: { getAddresLabelByGuidCompact: [awaria503(), awaria503()] } })
    const o = await zapisowy(a).createShipment(PON, REF)
    expect(o.kind).toBe('PRZEJSCIOWY')
    expect(a.metody().filter((m) => ZAPISY.has(m))).toEqual([])
  })

  it('poprawione zamówienie w niewysłanym buforze = usunięcie tej jednej przesyłki i dodanie z nowymi danymi', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    await z.createShipment(REQ, REF)
    await z.createShipment(REQ, REF2)
    // ta sama referencja, bez zmian: potwierdzenie bez zapisu
    expect((await zapisowy(a).createShipment(PON, REF)).kind).toBe('OK')
    expect(ile(a, 'clearEnvelopeByGuids')).toBe(0)
    expect(ile(a, 'addShipment')).toBe(2)
    const nowy = { ...REQ, recipient: { ...ADRESAT_PP, kodPocztowy: '60-123', ulica: 'Nowa' }, parcel: { ...GOTOWA, weightKg: 2 } }
    const o = await zapisowy(a).createShipment({ ...nowy, ponowienie: true }, REF)
    expect(o.kind).toBe('OK')
    expect((o as { info?: string }).info).toContain('Wydrukuj nową etykietę')
    const clear = a.calls.filter((c) => c.metoda === 'clearEnvelopeByGuids')
    expect(clear).toHaveLength(1)
    expect([...clear[0]!.body.matchAll(/<guid>([^<]*)<\/guid>/g)].map((m) => m[1])).toEqual([guid])
    const p = wBuforach(a, guid)
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ kod: '60123', ulica: 'Nowa', masa: '2000' })
    expect(wBuforach(a, guidZReferencji(REF2))).toHaveLength(1)
  })

  it('poprawione zamówienie po wysłaniu partii = TRWALY, bez drugiej przesyłki', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    await z.createShipment(REQ, REF)
    await z.wyslijPartie()
    const o = await zapisowy(a).createShipment({ ...PON, parcel: { ...GOTOWA, weightKg: 3 } }, REF)
    expect(o.kind).toBe('TRWALY')
    expect((o as { message: string }).message).toContain('wysłanej partii')
    expect(ile(a, 'addShipment')).toBe(1)
    // bez zmian po wysłaniu: zwykłe potwierdzenie
    expect((await zapisowy(a).createShipment(PON, REF)).kind).toBe('OK')
  })

  it('wysłanie pada = kurier niezamawiany; niepewny kurier = NIEPEWNY, ponowienie nie zamawia drugi raz', async () => {
    const a = ppAtrapa({ awarie: { sendEnvelope: [{ po: 'przed', status: 401 }] } })
    const z = zapisowy(a, { zapisWlaczony: true, zamowKuriera: true })
    await z.createShipment(REQ, REF)
    await expect(z.wyslijPartie()).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(ile(a, 'zamowKuriera')).toBe(0)
    const b = ppAtrapa({ awarie: { zamowKuriera: [{ po: 'po', blad: new Error('timeout') }] } })
    const zb = zapisowy(b, { zapisWlaczony: true, zamowKuriera: true })
    await zb.createShipment(REQ, REF)
    const w = await zb.wyslijPartie()
    expect(w.kurier).toBe('NIEPEWNY')
    expect(w.uwaga).toContain('nie zamawiaj drugi raz')
    const w2 = await zb.wyslijPartie()
    expect(w2.przesylek).toBe(0)
    expect(ile(b, 'zamowKuriera')).toBe(1)
  })

  it('dwa bufory dnia wysłane oba; zaległy z wczoraj zgłoszony; bufor innej firmy nietknięty', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    await z.createShipment(REQ, REF)
    const zn = znacznikFirmy('org')
    a.bufory.push({ id: '300', opis: opisPartii(zn, DZIEN), urzad: PP_URZAD, przesylki: [{ guid: 'D'.repeat(32), numer: '00659007734000000700' }], wyslany: false })
    a.bufory.push({ id: '301', opis: opisPartii(zn, '2026-11-09'), urzad: PP_URZAD, przesylki: [{ guid: 'E'.repeat(32), numer: '00659007734000000701' }], wyslany: false })
    a.bufory.push({ id: '302', opis: opisPartii(znacznikFirmy('inna-firma'), DZIEN), urzad: PP_URZAD, przesylki: [{ guid: 'F'.repeat(32), numer: '00659007734000000702' }], wyslany: false })
    const w = await z.wyslijPartie()
    expect(w.partie.map((p) => p.idBufor).sort()).toEqual(['100', '300'])
    expect(w.przesylek).toBe(2)
    expect(w.zalegle).toEqual(['2026-11-09'])
    expect(w.uwaga).toContain('2026-11-09')
    expect(a.bufory.find((b) => b.id === '301')!.wyslany).toBe(false)
    expect(a.bufory.find((b) => b.id === '302')!.wyslany).toBe(false)
    expect(a.bufory.find((b) => b.id === '7')!.wyslany).toBe(false)
    expect(znacznikFirmy('org')).not.toBe(znacznikFirmy('inna-firma'))
  })

  it('guid jako atrybut elementu przesyłki też jest odczytany', async () => {
    const a = ppAtrapa({ guidJakoAtrybut: true, awarie: { addShipment: [{ po: 'po', blad: new Error('timeout') }] } })
    expect((await zapisowy(a).createShipment(REQ, REF)).kind).toBe('NIEJEDNOZNACZNY')
    expect(await zapisowy(a).findByReference(REF)).toEqual({ found: true, externalRef: guid })
    expect(ile(a, 'addShipment')).toBe(1)
  })

  it('bez danych usługi Śledzenie śledzenie wyłączone, login eNadawcy nie idzie do Śledzenia', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    await z.createShipment(REQ, REF)
    await expect(z.trackShipment(guid)).rejects.toThrow(/śledzenie Poczty Polskiej wyłączone/)
    // błąd konta (host nie kończy śledzenia przesyłek), osobne dane: nie liczy się do wyłączenia konta eNadawcy
    await expect(z.trackShipment(guid)).rejects.toMatchObject({ name: 'BladKontaSledzenia', osobneDane: true })
    expect(a.calls.filter((c) => c.url.includes('Sledzenie'))).toHaveLength(0)
  })

  it.each([401, 403])('odmowa usługi Śledzenie (HTTP %i) = błąd konta śledzenia z osobnymi danymi, bez treści HTTP w komunikacie', async (http) => {
    const a = ppAtrapa({ sledzenie: { http, body: '' } })
    const z = zapisowy(a, { zapisWlaczony: true }, { secrets: { ...SECRETS, ...SLEDZENIE } })
    const g = ((await z.createShipment(REQ, REF)) as { externalRef: string }).externalRef
    const e = await z.trackShipment(g).then(() => null, (x: unknown) => x)
    expect(e).toMatchObject({ name: 'BladKontaSledzenia', osobneDane: true })
    expect(String((e as Error).message)).toMatch(/odmowa dostępu, sprawdź dane usługi Śledzenie/)
    expect(String((e as Error).message)).not.toMatch(/HTTP \d{3}/)
    expect(a.calls.filter((c) => c.url.includes('Sledzenie'))).toHaveLength(1) // bez ponawiania odmowy
  })

  it('etykieta bez nagłówka PDF odrzucona; odpowiedź ponad limit = null', async () => {
    const a = ppAtrapa({ awarie: { getPrintForParcel: [{ po: 'przed', status: 200, body: '<printResult><print>QUJDREVG</print></printResult>' }] } })
    await expect(zapisowy(a).getLabel(guid, 'PDF')).rejects.toThrow(/nie jest plikiem PDF/)
    expect(await tekstZLimitem(new Response('x'.repeat(20)), 10)).toBeNull()
    expect(await tekstZLimitem(new Response('abc', { headers: { 'content-length': '999999999' } }))).toBeNull()
    expect(await tekstZLimitem(new Response('abc'), 10)).toBe('abc')
  })
})

describe(',', () => {
  const guid = guidZReferencji(REF)
  const wBuforach = (a: Atrapa, g: string) => a.bufory.flatMap((b) => b.przesylki).filter((p) => p.guid === g)
  const ile = (a: Atrapa, m: string) => a.metody().filter((x) => x === m).length
  /** Odpowiedź bufora bez masy (pole nieczytelne); opcjonalnie drugie usunięcie pada przed wykonaniem. */
  const bezMasy = (a: Atrapa, psujDrugieUsuniecie = false): Atrapa => {
    let usuniec = 0
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const metoda = /<tns:(\w+)[\s>]/.exec(String(init?.body ?? ''))?.[1]
      if (metoda === 'clearEnvelopeByGuids' && psujDrugieUsuniecie && ++usuniec === 2) return new Response('', { status: 503 })
      const r = await a.fetchImpl(url, init)
      if (metoda !== 'getEnvelopeBufor') return r
      return new Response((await r.text()).replace(/<masa>[^<]*<\/masa>/g, ''), { status: r.status })
    }
    return { ...a, fetchImpl }
  }

  it('pierwsze nadanie bez kontroli przed dodaniem (nierozpoznany odczyt po GUID nie blokuje zwykłej ścieżki)', async () => {
    const a = ppAtrapa({ bladOdczytuGuid: { numer: 9999, opis: 'Błąd wewnętrzny usługi' } })
    const o = await zapisowy(a).createShipment(REQ, REF)
    expect(o).toMatchObject({ kind: 'OK', externalRef: guid })
    expect(a.metody()).toEqual(['getEnvelopeBuforList', 'createEnvelopeBufor', 'addShipment'])
  })

  it('ponowienie z nierozpoznanym odczytem po GUID = nic nie wysłano; po nieznanym błędzie zapisu = NIEJEDNOZNACZNY', async () => {
    const a = ppAtrapa({ bladOdczytuGuid: { numer: 9999, opis: 'Błąd wewnętrzny usługi' } })
    const p = await zapisowy(a).createShipment(PON, REF)
    expect(p).toMatchObject({ kind: 'TRWALY' })
    expect((p as { message: string }).message).toContain('nic nie wysłano')
    expect(a.metody().filter((m) => ZAPISY.has(m))).toEqual([])
    const b = ppAtrapa({ bladDodania: { numer: 3005, opis: 'Błąd spoza wzorców' }, bladOdczytuGuid: { numer: 9999, opis: 'Błąd wewnętrzny usługi' } })
    const o = await zapisowy(b).createShipment(REQ, REF)
    expect(o.kind).toBe('NIEJEDNOZNACZNY')
    // sprawdzenie po błędzie zapisu: tylko bufor, do którego dodawaliśmy, i odczyt po GUID (bez drugiej listy buforów)
    expect(ile(b, 'getEnvelopeBuforList')).toBe(1)
    expect(ile(b, 'getEnvelopeBufor')).toBe(1)
    expect(ile(b, 'getAddresLabelByGuidCompact')).toBe(1)
  })

  it('„nie znaleziono” po numerze błędu albo po tekście', () => {
    const numery = new Set([1501])
    expect(jestNieZnaleziono({ numer: 1501, opis: 'Inny tekst', guid: null }, numery)).toBe(true)
    expect(jestNieZnaleziono({ numer: 1502, opis: 'Inny tekst', guid: null }, numery)).toBe(false)
    expect(jestNieZnaleziono({ numer: null, opis: 'Nie znaleziono przesyłki', guid: null })).toBe(true)
    expect(jestNieZnaleziono({ numer: 1501, opis: 'Inny tekst', guid: null })).toBe(false)
  })

  it('nieczytelne dane w niewysłanym buforze = usunięcie i jedno dodanie z bieżącymi danymi', async () => {
    const a = ppAtrapa()
    a.bufory.push({ id: '400', opis: PARTIA, urzad: PP_URZAD, przesylki: [{ guid, numer: '00659007734000000800' }], wyslany: false })
    const o = await zapisowy(a).createShipment(PON, REF)
    expect(o.kind).toBe('OK')
    expect((o as { info?: string }).info).toContain('Wydrukuj nową etykietę')
    expect(ile(a, 'clearEnvelopeByGuids')).toBe(1)
    expect(ile(a, 'addShipment')).toBe(1)
    const p = wBuforach(a, guid)
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ kod: '00001', ulica: 'Testowa' })
  })

  it('nieczytelne dane w wysłanej partii = NIEJEDNOZNACZNY bez dodania; odszukanie nie potwierdza', async () => {
    const a = ppAtrapa()
    a.wyslane.push({ guid, numer: '00659007734000000801' })
    const o = await zapisowy(a).createShipment(PON, REF)
    expect(o.kind).toBe('NIEJEDNOZNACZNY')
    expect((o as { message: string }).message).toContain('sprawdź w eNadawcy adres, masę i format')
    expect(ile(a, 'addShipment')).toBe(0)
    await expect(zapisowy(a).findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
  })

  it('różnica także po ponownym dodaniu = drugie usunięcie; udane = TRWALY „nic nie zostało”, nieudane = NIEJEDNOZNACZNY', async () => {
    const a = ppAtrapa({ bladPoDodaniu: { numer: 4711, opis: 'Operacja zakończona z uwagami' } })
    const o = await zapisowy(bezMasy(a)).createShipment(REQ, REF)
    expect(o.kind).toBe('TRWALY')
    expect((o as { message: string }).message).toContain('nic nie zostało')
    expect(ile(a, 'addShipment')).toBe(2)
    expect(ile(a, 'clearEnvelopeByGuids')).toBe(2)
    expect(wBuforach(a, guid)).toHaveLength(0)
    const b = ppAtrapa({ bladPoDodaniu: { numer: 4711, opis: 'Operacja zakończona z uwagami' } })
    const n = await zapisowy(bezMasy(b, true)).createShipment(REQ, REF)
    expect(n.kind).toBe('NIEJEDNOZNACZNY')
    expect((n as { message: string }).message).toContain('usuń ją w eNadawcy')
    expect(wBuforach(b, guid)).toHaveLength(1)
  })

  it('anulowanie przy ponad 30 partiach Kompletora bez trafienia = jasny błąd, nie „już usunięta”', async () => {
    const a = ppAtrapa()
    const zn = znacznikFirmy('org')
    for (let d = 1; d <= MAKS_BUFOROW_PRZESZUKANIA + 1; d++) a.bufory.push({ id: String(500 + d), opis: opisPartii(zn, `2026-${d > 30 ? '09' : '10'}-${String(((d - 1) % 30) + 1).padStart(2, '0')}`), urzad: PP_URZAD, przesylki: [], wyslany: false })
    const c = await zapisowy(a).cancelShipment(guid, REF)
    expect(c.kind).toBe('TRWALY')
    expect((c as { message: string }).message).toContain(`ponad ${MAKS_BUFOROW_PRZESZUKANIA}`)
    expect(ile(a, 'getEnvelopeBufor')).toBe(MAKS_BUFOROW_PRZESZUKANIA)
  })

  it('błąd w połowie wysyłki = ponów „Wyślij partię”, kuriera nie zamawiaj ręcznie; niepewne wysłanie = sprawdź i zamów ręcznie', async () => {
    const a = ppAtrapa({ awarie: { sendEnvelope: [{ po: 'przed', status: 401 }] } })
    const z = zapisowy(a, { zapisWlaczony: true, zamowKuriera: true })
    await z.createShipment(REQ, REF)
    await expect(z.wyslijPartie()).rejects.toThrow(/kuriera nie zamawiaj ręcznie/)
    const b = ppAtrapa({ awarie: { sendEnvelope: [{ po: 'po', blad: new Error('timeout') }] } })
    const zb = zapisowy(b, { zapisWlaczony: true, zamowKuriera: true })
    await zb.createShipment(REQ, REF)
    await expect(zb.wyslijPartie()).rejects.toThrow(/jeśli w eNadawcy partia jest wysłana, zamów odbiór w eNadawcy/)
  })

  it('partia firmy na inny urząd nadania nie wychodzi, ale trafia do zaległych i uwagi', async () => {
    const a = ppAtrapa()
    const z = zapisowy(a)
    await z.createShipment(REQ, REF)
    a.bufory.push({ id: '450', opis: PARTIA, urzad: '999', przesylki: [{ guid: 'D'.repeat(32), numer: '00659007734000000900' }], wyslany: false })
    const w = await z.wyslijPartie()
    expect(w.partie.map((p) => p.idBufor)).toEqual(['100'])
    expect(w.zalegle).toEqual([`${DZIEN} (urząd 999)`])
    expect(w.uwaga).toContain('inny urząd nadania')
    expect(a.bufory.find((b) => b.id === '450')!.wyslany).toBe(false)
  })
})
