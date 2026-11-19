// adaptery `gls.ade.v1` i `gls.ade.zapis.v1` na atrapie ADE. Dane fikcyjne, zero połączeń z GLS (także z ADE
// test): tryb „przygotuj, nie wysyłaj”, zapis tylko za wyłącznikiem.
import { describe, expect, it } from 'vitest'
import { GLS_HASLO, GLS_LOGIN, GLS_URL, glsAtrapa, NADAWCA_GLS, ODBIORCA_GLS } from '../../tests/gls-atrapa'
import { odciskGls, wyliczPrzesylkeGls, ustawieniaGls, zlecenieGls } from '../wysylka/gls'
import { ReadOnlyViolation } from '../zrodla/http'
import { GLS_PROD, GLS_TEST, GlsOdczyt, GlsZapis, kodFaultu, kopertaGls } from '../zrodla/gls'
import { defaultRegistry } from './domyslne'
import { adresGls, GLS_KEY, GLS_ZAPIS_KEY, malejacoIdGls, roznicePrzygotowaniaGls } from './gls'
import { KODY_GLS, klasaKoduGls } from './gls-kody'
import { hasReferenceFinder, hasShipmentCreator, type ChannelAdapter, type PreparedParcel, type ShipmentCreator, type ShipmentInput } from './kontrakt'
import { PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'
import { executeWrite } from './zapis'

const FAST = { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 }
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'gls', name: 'GLS' }
const SECRETS = { GLS_ADE_LOGIN: GLS_LOGIN, GLS_ADE_HASLO: GLS_HASLO }
const AUTH = { login: GLS_LOGIN, haslo: GLS_HASLO }
const REF = 'a1b2c3d4-e5f6-5789-8abc-def012345678'
const NOW = new Date('2026-11-09T10:00:00Z')

type Atrapa = ReturnType<typeof glsAtrapa>
type Zapisowy = ChannelAdapter &
  Omit<ShipmentCreator, 'confirmManual' | 'getTrackingNumber'> & { findByReference(r: string): Promise<{ found: boolean; externalRef?: string }>; confirmManual(n: string, r: string): Promise<{ externalRef?: string; odmowa?: string }>; getTrackingNumber(e: string): Promise<string | null> }

function adapter(key: string, a: Atrapa, config: Record<string, unknown> = {}, sekrety: Record<string, string> = SECRETS): ChannelAdapter {
  return defaultRegistry().create(key, { integration, rawConfig: { ...config }, rawSecrets: sekrety, fetch: a.fetchImpl, http: FAST, now: () => NOW })
}

function zapisowy(a: Atrapa, config: Record<string, unknown> = { zapisWlaczony: true }): Zapisowy {
  const ad = adapter(GLS_ZAPIS_KEY, a, { nadawca: JSON.stringify(NADAWCA_GLS), ...config })
  if (!hasShipmentCreator(ad)) throw new Error('bez shipment.create')
  return ad as Zapisowy
}

const WEJSCIE: ShipmentInput = { carrier: 'GLS', gabaryt: 'GLS', weightG: 1500, weightComplete: true, paymentState: 'PAID', paymentMethod: 'przelew', totalGross: 99, codAmountUncertain: null, pickupPoint: null }
const GOTOWA: PreparedParcel = { courierCode: 'GLS_KURIER', gabaryt: 'GLS', sideXCm: null, sideYCm: null, sideZCm: null, weightKg: 1.5, codAmount: null, pickupPoint: null, problems: [] }
const ZLECENIE = { parcel: GOTOWA, carrier: 'GLS' as const, recipient: ODBIORCA_GLS }
/** To samo zlecenie jako ponowienie (host: wiersz po BLAD). */
const PONOWIENIE = { ...ZLECENIE, ponowienie: true }

for (const key of [GLS_KEY, GLS_ZAPIS_KEY]) {
  runAdapterContract({
    name: key,
    now: NOW,
    setup() {
      const a = glsAtrapa()
      return { adapter: adapter(key, a), putOrder: () => {}, corruptOrder: () => {}, failNextList: () => {}, requests: () => a.metody(), readMethods: ['adeLogin', 'adeLogout'] }
    },
  })
}

describe('klient SOAP ADE GLS', () => {
  it('koperta RPC: metoda w przestrzeni nazw, struktury zagnieżdżone, listy jako items, flagi 1/0, znaki zakodowane', () => {
    const k = kopertaGls('adePickup_Create', { session: 's1', consigns_ids: ['12', '13'], srv: { cod: true, sds: false }, desc: 'A&B <c>', brak: null })
    expect(k).toContain('<ns1:adePickup_Create><session>s1</session><consigns_ids><items>12</items><items>13</items></consigns_ids><srv><cod>1</cod><sds>0</sds></srv><desc>A&amp;B &lt;c&gt;</desc></ns1:adePickup_Create>')
    expect(k).not.toContain('brak')
    expect(() => kopertaGls('zła metoda', {})).toThrow()
    expect(kodFaultu('<x:Fault><faultcode>SOAP-ENV:err_sess_expired</faultcode></x:Fault>')).toBe('err_sess_expired')
    expect(kodFaultu('<return>1</return>')).toBeNull()
  })

  it('odczyt: metody tworzące odrzucone przed wysyłką; zapis wymaga jawnego wyłącznika i odrzuca resztę metod', async () => {
    const a = glsAtrapa()
    const o = new GlsOdczyt({ url: GLS_URL, auth: AUTH, fetchImpl: a.fetchImpl, retry: FAST.retry })
    for (const m of ['adePreparingBox_Insert', 'adePickup_Create', 'adePreparingBox_DeleteConsign', 'adeCourier_Order', 'adePickup_GetReceipt']) await expect(o.wywolaj(m, {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(() => new GlsZapis({ url: GLS_URL, auth: AUTH, fetchImpl: a.fetchImpl } as never)).toThrow(/wyłącznika/)
    const z = new GlsZapis({ url: GLS_URL, auth: AUTH, fetchImpl: a.fetchImpl, wylacznik: true })
    for (const m of ['adePreparingBox_DeleteConsign', 'adeCourier_Order', 'adeLogin']) await expect(z.wywolaj(m as never, {}, 's')).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(a.calls).toHaveLength(0)
  })

  it('tylko dwa adresy ADE; domyślnie testowy', () => {
    for (const url of [GLS_PROD, GLS_TEST]) expect(() => new GlsOdczyt({ url, auth: AUTH })).not.toThrow()
    for (const url of ['http://ade-test.gls-poland.com/adeplus/pm1/ade_webapi2.php', 'https://ade-test.gls-poland.com.example.invalid/adeplus/pm1/ade_webapi2.php', `${GLS_TEST}?wsdl`]) expect(() => new GlsOdczyt({ url, auth: AUTH })).toThrow(/adres API GLS/)
    expect(adresGls({})).toBe(GLS_TEST)
    expect(adresGls({ srodowisko: 'produkcja' })).toBe(GLS_PROD)
  })

  it('kody ADE → klasy Kompletora (tabela i rodziny po przedrostku; nieznany = TRWALY)', () => {
    const przypadki: [string, 'TRWALY' | 'PRZEJSCIOWY'][] = [
      ['err_user_webapi_auth_error', 'TRWALY'],
      ['err_sess_expired', 'PRZEJSCIOWY'],
      ['err_sess_not_found', 'PRZEJSCIOWY'],
      ['err_sess_cos_nowego', 'PRZEJSCIOWY'],
      ['err_cons_rzipcode_invalid', 'TRWALY'],
      ['err_cons_cos_nowego', 'TRWALY'],
      ['err_parcel_not_found', 'TRWALY'],
      ['err_pickup_problem', 'TRWALY'],
      ['zupelnie_nieznany', 'TRWALY'],
    ]
    for (const [kod, klasa] of przypadki) expect([kod, klasaKoduGls(kod).klasa]).toEqual([kod, klasa])
    for (const [kod, k] of Object.entries(KODY_GLS)) expect(klasaKoduGls(kod)).toEqual(k)
  })
})

describe('przygotowanie przesyłki GLS', () => {
  it('kurier i punkt, waga, pobranie z limitem, zły przewoźnik', () => {
    const u = ustawieniaGls({})
    expect(wyliczPrzesylkeGls(WEJSCIE, u)).toMatchObject({ courierCode: 'GLS_KURIER', weightKg: 1.5, codAmount: null, problems: [] })
    expect(wyliczPrzesylkeGls({ ...WEJSCIE, pickupPoint: 'PL12345' }, u)).toMatchObject({ courierCode: 'GLS_SDS', pickupPoint: 'PL12345' })
    expect(wyliczPrzesylkeGls({ ...WEJSCIE, weightG: 40_000 }, u).problems.map((p) => p.kod)).toContain('waga_limit')
    expect(wyliczPrzesylkeGls({ ...WEJSCIE, paymentState: 'COD', totalGross: 12_000 }, u).problems.map((p) => p.kod)).toContain('pobranie_limit')
    expect(wyliczPrzesylkeGls({ ...WEJSCIE, paymentState: 'COD', totalGross: 120 }, u)).toMatchObject({ codAmount: 120 })
    expect(wyliczPrzesylkeGls({ ...WEJSCIE, carrier: 'DPD' }, u).problems.map((p) => p.kod)).toContain('przewoznik')
  })

  it('zlecenie: odcisk referencji, wielopaczkowe, ostrzeżenia blokują bez potwierdzenia', () => {
    const odb = { rname1: 'X', rname2: null, rcountry: 'PL', rzipcode: '00001', rcity: 'T', rstreet: 'Testowa 1', rphone: null, rcontact: null }
    const z = zlecenieGls(GOTOWA, odb, NADAWCA_GLS as never, { reference: REF, teraz: NOW, wagiKg: [1, 2.5] })
    expect(z.odcisk).toBe(odciskGls(REF))
    expect(z.odcisk).toHaveLength(25)
    expect(z.dane).toMatchObject({ references: z.odcisk, quantity: 2, weight: '3.50', date: '2026-11-09', srv_bool: { cod: false, cod_amount: '0.00' }, parcels: [{ weight: '1.00' }, { weight: '2.50' }] })
    expect(z.kontrolne).toEqual({ kod: '00001', ulica: 'Testowa 1', punkt: null, pobranie: 0, waga: 3.5, data: '2026-11-09' })
    const ost = { ...GOTOWA, problems: [{ kod: 'waga_domyslna', poziom: 'OSTRZEZENIE' as const, tekst: 't' }] }
    expect(() => zlecenieGls(ost, odb, NADAWCA_GLS as never, { reference: REF, teraz: NOW })).toThrow(/waga_domyslna/)
    expect(() => zlecenieGls(ost, odb, NADAWCA_GLS as never, { reference: REF, teraz: NOW, potwierdzoneOstrzezenia: ['waga_domyslna'] })).not.toThrow()
    expect(() => zlecenieGls(GOTOWA, odb, NADAWCA_GLS as never, { reference: REF, teraz: NOW, wagiKg: [40] })).toThrow(/waga/)
  })
})

describe('adapter gls.ade.zapis.v1', () => {
  it('bez zapisWlaczony: zero żądań (nadanie, etykieta, odszukanie, numer, rozstrzygnięcie)', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a, {})
    expect((await z.createShipment(ZLECENIE, REF)).kind).toBe('TRWALY')
    await expect(z.getLabel('1001', 'PDF')).rejects.toMatchObject({ kind: 'TRWALY' })
    await expect(z.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
    await expect(z.getTrackingNumber('1001')).rejects.toMatchObject({ kind: 'TRWALY' })
    expect((await z.confirmManual('1001', REF)).odmowa).toBeTruthy()
    expect(a.calls).toHaveLength(0)
  })

  it('nadanie: jedna sesja insert → pickup → odczyt numeru, sesja zamknięta, odcisk w references, bez danych osobowych w wyniku', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a)
    const out = await z.createShipment(ZLECENIE, REF)
    expect(out).toMatchObject({ kind: 'OK', reference: REF })
    expect(a.metody()).toEqual(['adeLogin', 'adePreparingBox_GetConsignIDs', 'adePreparingBox_Insert', 'adePickup_Create', 'adePickup_GetConsignBinds', 'adePickup_GetConsign', 'adeLogout'])
    expect(a.calls.find((c) => c.metoda === 'adePreparingBox_Insert')!.body).toContain(`<references>${odciskGls(REF)}</references>`)
    expect(a.sesje.size).toBe(0)
    for (const p of PII_SENTINELS) expect(JSON.stringify(out)).not.toContain(p)
    const id = (out as { externalRef: string }).externalRef
    expect(await z.getTrackingNumber(id)).toMatch(/^\d+$/)
    const l = await z.getLabel(id, 'PDF')
    expect(l.contentType).toBe('application/pdf')
    expect(a.ile('adePickup_GetParcelLabel')).toBe(1)
    await expect(z.getLabel(id, 'EPL')).rejects.toMatchObject({ kind: 'TRWALY' })
  })

  it('etykieta przesyłki wielopaczkowej: jeden plik z adePickup_GetParcelsLabels', async () => {
    const a = glsAtrapa()
    const id = a.dodajNadana(odciskGls(REF), 3)
    await zapisowy(a).getLabel(id, 'PDF')
    expect(a.ile('adePickup_GetParcelsLabels')).toBe(1)
    expect(a.calls.find((c) => c.metoda === 'adePickup_GetParcelsLabels')!.body.match(/<items>/g)).toHaveLength(3)
  })

  it('timeout po insert: brak drugiego insert dla tej referencji, odszukanie zgłasza przygotowanie człowiekowi, ponowienie je dokańcza', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a)
    a.usterka({ metoda: 'adePreparingBox_Insert', rodzaj: 'po' })
    const pierwszy = await executeWrite(z, REF, () => z.createShipment(ZLECENIE, REF))
    // samo przygotowanie nie dowodzi braku nadania → zostaje NIEJEDNOZNACZNY (człowiek), bez cichego ponowienia
    expect(pierwszy.kind).toBe('NIEJEDNOZNACZNY')
    expect('message' in pierwszy && pierwszy.message).toMatch(/czeka w przygotowalni ADE/)
    expect(a.przygotowalnia.size).toBe(1)
    expect(a.sesje.size).toBe(0)
    const drugi = await executeWrite(z, REF, () => z.createShipment(PONOWIENIE, REF))
    expect(drugi.kind).toBe('OK')
    expect(a.ile('adePreparingBox_Insert')).toBe(1)
    expect(a.przygotowalnia.size).toBe(0)
    expect(a.nadane.size).toBe(1)
  })

  it('timeout po potwierdzeniu nadania: odszukanie po referencji znajduje nadaną przesyłkę, bez drugiego nadania', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a)
    a.usterka({ metoda: 'adePickup_Create', rodzaj: 'po' })
    const out = await executeWrite(z, REF, () => z.createShipment(ZLECENIE, REF))
    expect(out.kind).toBe('OK')
    expect((out as { externalRef: string }).externalRef).toBe([...a.nadane.keys()][0])
    expect(a.ile('adePreparingBox_Insert')).toBe(1)
    expect(a.ile('adePickup_Create')).toBe(1)
    expect(a.sesje.size).toBe(0)
  })

  it('timeout przed wykonaniem insert i brak przesyłki: odszukanie nie zgaduje (zostaje NIEJEDNOZNACZNY)', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a)
    a.usterka({ metoda: 'adePreparingBox_Insert', rodzaj: 'przed' })
    const out = await executeWrite(z, REF, () => z.createShipment(ZLECENIE, REF))
    expect(out.kind).toBe('NIEJEDNOZNACZNY')
    await expect(z.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
  })

  it('odmowa ADE: zły login = TRWALY bez zapisu; błąd danych przy insert = TRWALY; sesja zamknięta także po błędzie; hasło nigdy w komunikacie', async () => {
    const a = glsAtrapa()
    const zle = adapter(GLS_ZAPIS_KEY, a, { zapisWlaczony: true, nadawca: JSON.stringify(NADAWCA_GLS) }, { ...SECRETS, GLS_ADE_HASLO: 'zle-haslo-atrapy' }) as Zapisowy
    const r1 = await zle.createShipment(ZLECENIE, REF)
    expect(r1.kind).toBe('TRWALY')
    expect(a.ile('adePreparingBox_Insert')).toBe(0)
    const t = await zle.testConnection()
    expect(t.ok).toBe(false)
    expect(t.details).toMatchObject({ rodzaj: 'TRWALY' })
    const z = zapisowy(a)
    a.usterka({ metoda: 'adePreparingBox_Insert', rodzaj: 'fault', kod: 'err_cons_rzipcode_invalid' })
    const r2 = await z.createShipment(ZLECENIE, REF)
    expect(r2).toMatchObject({ kind: 'TRWALY' })
    expect('message' in r2 && r2.message).toContain('kod pocztowy')
    expect(a.sesje.size).toBe(0)
    a.usterka({ metoda: 'adePickup_Create', rodzaj: 'fault', kod: 'err_sess_expired' })
    const r3 = await z.createShipment(ZLECENIE, REF)
    expect(r3.kind).toBe('PRZEJSCIOWY')
    expect(a.sesje.size).toBe(0)
    for (const r of [r1, r2, r3]) {
      expect(JSON.stringify(r)).not.toContain(GLS_HASLO)
      for (const p of PII_SENTINELS) expect(JSON.stringify(r)).not.toContain(p)
    }
    expect(a.ile('adeLogin')).toBe(a.ile('adeLogout') + 2) // dwa logowania odrzucone, każda otwarta sesja zamknięta
  })

  it('rozstrzygnięcie ręczne: identyfikator z referencją tej przesyłki = przyjęty; inna referencja albo brak = odmowa', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a)
    const nasza = a.dodajNadana(odciskGls(REF), 1)
    const obca = a.dodajNadana(odciskGls('ffffffff-ffff-4fff-8fff-ffffffffffff'), 1)
    expect(await z.confirmManual(nasza, REF)).toMatchObject({ externalRef: nasza })
    expect((await z.confirmManual(obca, REF)).odmowa).toMatch(/inna przesyłka/)
    expect((await z.confirmManual('999999', REF)).odmowa).toMatch(/Nic nie zapisano/)
    expect((await z.confirmManual('abc', REF)).odmowa).toBeTruthy()
    expect(hasReferenceFinder(z)).toBe(true)
  })
})

describe('poprawki po przeglądzie', () => {
  const ODB = { rname1: 'X', rname2: null, rcountry: 'PL', rzipcode: '00001', rcity: 'T', rstreet: 'Testowa 1', rphone: null, rcontact: null }

  it('timeout po adePickup_Create, ADE kończy potwierdzenie później, ponowienie = jeden Insert i jedno nadanie', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a)
    a.usterka({ metoda: 'adePickup_Create', rodzaj: 'po_odlozone' })
    const pierwszy = await executeWrite(z, REF, () => z.createShipment(ZLECENIE, REF))
    // potwierdzenie w toku: przygotowanie dalej leży, odszukanie nie może powiedzieć „nie powstała”
    expect(pierwszy.kind).toBe('NIEJEDNOZNACZNY')
    expect(a.przygotowalnia.size).toBe(1)
    a.dokoncz()
    expect(a.przygotowalnia.size).toBe(0)
    // człowiek klika „ponów” (Rozstrzygnij ręcznie → Nie powstała): adapter widzi nadaną przesyłkę i jej nie dubluje
    const drugi = await z.createShipment(PONOWIENIE, REF)
    expect(drugi).toMatchObject({ kind: 'OK', externalRef: [...a.nadane.keys()][0] })
    expect(a.ile('adePreparingBox_Insert')).toBe(1)
    expect(a.ile('adePickup_Create')).toBe(1)
    expect(a.nadane.size).toBe(1)
    expect(await z.findByReference(REF)).toEqual({ found: true, externalRef: [...a.nadane.keys()][0] })
    expect(a.sesje.size).toBe(0)
  })

  it('przesyłka z tą referencją już nadana (np. ręcznie w panelu) = OK bez wstawiania; dwie nadane = TRWALY', async () => {
    const a = glsAtrapa()
    const id = a.dodajNadana(odciskGls(REF), 1)
    const z = zapisowy(a)
    expect(await z.createShipment(PONOWIENIE, REF)).toMatchObject({ kind: 'OK', externalRef: id })
    a.dodajNadana(odciskGls(REF), 1)
    expect(await z.createShipment(PONOWIENIE, REF)).toMatchObject({ kind: 'TRWALY' })
    expect(a.ile('adePreparingBox_Insert')).toBe(0)
    expect(a.ile('adePickup_Create')).toBe(0)
  })

  it('Fault bez kodu ADE przy zapisie = NIEJEDNOZNACZNY; kod err_* = TRWALY', async () => {
    const a = glsAtrapa()
    const k = new GlsZapis({ url: GLS_URL, auth: AUTH, fetchImpl: a.fetchImpl, wylacznik: true })
    for (const kod of ['SOAP-ENV:Server', 'Receiver', '???']) {
      a.usterka({ metoda: 'adePickup_Create', rodzaj: 'fault', kod })
      const r = await k.wywolaj('adePickup_Create', { session: 's' }, 's')
      expect(r).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
      expect('kod' in r && r.kod).toBeFalsy()
    }
    a.usterka({ metoda: 'adePickup_Create', rodzaj: 'fault', kod: 'err_cons_not_found' })
    expect(await k.wywolaj('adePickup_Create', { session: 's' }, 's')).toMatchObject({ ok: false, kind: 'TRWALY', kod: 'err_cons_not_found' })
    // przez adapter: błąd serwera SOAP po potwierdzeniu nadania nie jest odmową
    const z = zapisowy(a)
    a.usterka({ metoda: 'adePickup_Create', rodzaj: 'fault', kod: 'SOAP-ENV:Server' })
    expect((await z.createShipment(ZLECENIE, REF)).kind).toBe('NIEJEDNOZNACZNY')
  })

  it('listy stronami do końca; nadana przesyłka znaleziona po kolejnych nadaniach i za setką potwierdzeń', async () => {
    const a = glsAtrapa({ strona: 5 })
    for (let i = 0; i < 30; i++) a.dodajPotwierdzenie(1)
    for (let i = 0; i < 12; i++) a.dodajPrzygotowanie()
    const z = zapisowy(a)
    const out = await z.createShipment(ZLECENIE, REF)
    expect(out.kind).toBe('OK')
    // cztery kolejne nadania z innych stanowisk (dawne okno 3 potwierdzeń by je zgubiło)
    for (let i = 0; i < 4; i++) a.dodajPotwierdzenie(1)
    expect(await z.findByReference(REF)).toEqual({ found: true, externalRef: (out as { externalRef: string }).externalRef })
    expect(a.calls.filter((c) => c.metoda === 'adePickup_GetIDs').some((c) => !c.body.includes('<id_start>0</id_start>'))).toBe(true)
  })

  it('przekroczenie okna, limitu przesyłek albo stron = wyjątek, nigdy found: false', async () => {
    const a = glsAtrapa()
    a.dodajNadana(odciskGls(REF), 1)
    for (let i = 0; i < 20; i++) a.dodajPotwierdzenie(1)
    const z = zapisowy(a)
    await expect(z.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
    const b = glsAtrapa()
    b.dodajPotwierdzenie(101)
    await expect(zapisowy(b).findByReference(REF)).rejects.toThrow(/ponad 100 przesyłek/)
    expect(b.ile('adePickup_GetConsign')).toBe(0)
    const c = glsAtrapa({ strona: 1 })
    for (let i = 0; i < 201; i++) c.dodajPotwierdzenie(1)
    await expect(zapisowy(c).findByReference(REF)).rejects.toThrow(/więcej niż 200 stron/)
    // przed wstawieniem: limit = TRWALY bez zapisu
    expect((await zapisowy(c).createShipment(PONOWIENIE, REF)).kind).toBe('TRWALY')
    expect(c.ile('adePreparingBox_Insert')).toBe(0)
  })

  it('stare przygotowanie dokańczane tylko z tymi samymi danymi; inne pobranie, kod albo data = TRWALY bez zapisu', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a)
    a.usterka({ metoda: 'adePickup_Create', rodzaj: 'fault', kod: 'err_pickup_problem' })
    expect((await z.createShipment(ZLECENIE, REF)).kind).toBe('TRWALY')
    expect(a.przygotowalnia.size).toBe(1)
    const id = [...a.przygotowalnia.keys()][0]!
    const zPobraniem = { ...ZLECENIE, parcel: { ...GOTOWA, codAmount: 120 } }
    const r1 = await z.createShipment({ ...zPobraniem, ponowienie: true }, REF)
    expect(r1).toMatchObject({ kind: 'TRWALY' })
    expect('message' in r1 && r1.message).toContain(`Usuń przygotowanie ${id} w panelu ADE i ponów`)
    expect('message' in r1 && r1.message).toContain('kwota pobrania')
    const r2 = await z.createShipment({ ...PONOWIENIE, recipient: { ...ODBIORCA_GLS, kodPocztowy: '61-001' } }, REF)
    expect('message' in r2 && r2.message).toContain('kod pocztowy odbiorcy')
    const jutro = defaultRegistry().create(GLS_ZAPIS_KEY, { integration, rawConfig: { zapisWlaczony: true, nadawca: JSON.stringify(NADAWCA_GLS) }, rawSecrets: SECRETS, fetch: a.fetchImpl, http: FAST, now: () => new Date('2026-11-10T10:00:00Z') }) as Zapisowy
    const r3 = await jutro.createShipment(PONOWIENIE, REF)
    expect('message' in r3 && r3.message).toContain('data nadania')
    expect(a.ile('adePreparingBox_Insert')).toBe(1)
    expect(a.ile('adePickup_Create')).toBe(1)
    // te same dane: dokończenie tego samego przygotowania
    expect((await z.createShipment(PONOWIENIE, REF)).kind).toBe('OK')
    expect(a.ile('adePreparingBox_Insert')).toBe(1)
    expect(a.nadane.size).toBe(1)
  })

  it('pobranie ≤ 0, nieskończone albo ponad limit odrzucone; kwoty z dwoma miejscami', () => {
    for (const codAmount of [0, -5, Number.POSITIVE_INFINITY, Number.NaN, 10_000.01]) expect(() => zlecenieGls({ ...GOTOWA, codAmount }, ODB, NADAWCA_GLS as never, { reference: REF, teraz: NOW })).toThrow(/pobrania/)
    expect(() => zlecenieGls({ ...GOTOWA, codAmount: 600 }, ODB, NADAWCA_GLS as never, { reference: REF, teraz: NOW, codLimit: 500 })).toThrow(/500/)
    const z = zlecenieGls({ ...GOTOWA, codAmount: 120.5 }, ODB, NADAWCA_GLS as never, { reference: REF, teraz: NOW })
    expect(z.dane['srv_bool']).toEqual({ cod: true, cod_amount: '120.50', sds: false })
    expect(z.dane['weight']).toBe('1.50')
  })

  it('pobranie przy zamówieniu nie w PLN = BLAD; bez pobrania albo w PLN bez problemu', () => {
    const u = ustawieniaGls({})
    const cod = { ...WEJSCIE, paymentState: 'COD' as const, totalGross: 120 }
    expect(wyliczPrzesylkeGls({ ...cod, currency: 'EUR' }, u).problems).toEqual(expect.arrayContaining([expect.objectContaining({ kod: 'pobranie_waluta', poziom: 'BLAD' })]))
    expect(wyliczPrzesylkeGls({ ...cod, currency: 'pln' }, u).problems).toEqual([])
    expect(wyliczPrzesylkeGls({ ...WEJSCIE, currency: 'EUR' }, u).problems).toEqual([])
  })

  it('identyfikatory 20 cyfr porządkowane bez utraty dokładności', () => {
    const ids = ['99999999999999999998', '99999999999999999999', '100', '99999999999999999990']
    expect([...ids].sort(malejacoIdGls)).toEqual(['99999999999999999999', '99999999999999999998', '99999999999999999990', '100'])
  })

  it('odpowiedź ponad sufit: odczyt = błąd bez ponawiania, zapis = NIEJEDNOZNACZNY', async () => {
    const duza = 'x'.repeat(2_000)
    const fetchImpl = async () => new Response(duza, { status: 200 })
    const o = new GlsOdczyt({ url: GLS_URL, auth: AUTH, fetchImpl, retry: FAST.retry, maxOdpowiedziB: 1_000 })
    await expect(o.wywolaj('adeLogin', {})).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/większa niż/) })
    const k = new GlsZapis({ url: GLS_URL, auth: AUTH, fetchImpl, wylacznik: true, maxOdpowiedziB: 1_000 })
    expect(await k.wywolaj('adePickup_Create', {}, 's')).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
  })
})

describe('poprawki po drugim przeglądzie', () => {
  it('pierwsze nadanie nie czyta historii potwierdzeń: potwierdzenie ze 101 przesyłkami nie blokuje, 7 żądań', async () => {
    const a = glsAtrapa()
    a.dodajPotwierdzenie(101)
    for (let i = 0; i < 25; i++) a.dodajPotwierdzenie(1)
    const out = await zapisowy(a).createShipment(ZLECENIE, REF)
    expect(out.kind).toBe('OK')
    expect(a.ile('adePickup_GetIDs')).toBe(0)
    expect(a.ile('adePickup_GetConsignIDs')).toBe(0)
    expect(a.calls).toHaveLength(7)
  })

  it('ponowienie po niepewnym adePickup_Create = dokładnie 1 Insert i 1 nadanie; przesyłki potwierdzenia jednym Binds', async () => {
    const a = glsAtrapa()
    const z = zapisowy(a)
    a.usterka({ metoda: 'adePickup_Create', rodzaj: 'po_odlozone' })
    expect((await executeWrite(z, REF, () => z.createShipment(ZLECENIE, REF))).kind).toBe('NIEJEDNOZNACZNY')
    a.dokoncz()
    for (let i = 0; i < 3; i++) a.dodajPotwierdzenie(2)
    const przed = a.calls.length
    const drugi = await z.createShipment(PONOWIENIE, REF)
    const nasza = [...a.nadane.keys()].find((id) => a.nadane.get(id)!.references === odciskGls(REF))
    expect(drugi).toMatchObject({ kind: 'OK', externalRef: nasza })
    expect(a.ile('adePreparingBox_Insert')).toBe(1)
    expect(a.ile('adePickup_Create')).toBe(1)
    const ponowienie = a.calls.slice(przed).map((c) => c.metoda)
    expect(ponowienie.filter((m) => m === 'adePickup_GetConsignBinds')).toHaveLength(a.potwierdzenia.size)
    expect(ponowienie).not.toContain('adePickup_GetConsignIDs')
  })

  it('ponowienie widzi nadaną przesyłkę za 20 potwierdzeniami (okno 100), zwykłe odszukanie nie', async () => {
    const a = glsAtrapa()
    const id = a.dodajNadana(odciskGls(REF), 1)
    for (let i = 0; i < 40; i++) a.dodajPotwierdzenie(1)
    const z = zapisowy(a)
    await expect(z.findByReference(REF)).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(await z.createShipment(PONOWIENIE, REF)).toMatchObject({ kind: 'OK', externalRef: id })
    expect(a.ile('adePreparingBox_Insert')).toBe(0)
  })

  it('zmiana punktu GLS albo ulicy blokuje dokończenie; data z godziną porównywana po dniu', async () => {
    const k = { kod: '00001', ulica: 'Testowa 1', punkt: 'PL12345', pobranie: 0, waga: 1.5, data: '2026-11-09' }
    const p = { kod: '00001', ulica: 'testowa  1', punkt: 'PL12345', pobranie: 0, waga: 1.5, data: '2026-11-09 10:15:00' }
    expect(roznicePrzygotowaniaGls(p, k)).toEqual([])
    expect(roznicePrzygotowaniaGls({ ...p, punkt: 'PL99999' }, k)).toEqual(['punkt GLS'])
    expect(roznicePrzygotowaniaGls({ ...p, punkt: null }, k)).toEqual(['punkt GLS'])
    expect(roznicePrzygotowaniaGls({ ...p, ulica: 'Inna 2' }, k)).toEqual(['ulica odbiorcy'])
    expect(roznicePrzygotowaniaGls({ ...p, ulica: null }, k)).toEqual(['ulica odbiorcy'])
    expect(roznicePrzygotowaniaGls({ ...p, data: '2026-11-10T08:00:00' }, k)).toEqual(['data nadania'])
    // przez adapter: stare przygotowanie do punktu, ponowienie do innego punktu przy tym samym kodzie = TRWALY bez zapisu
    const a = glsAtrapa()
    const z = zapisowy(a)
    const doPunktu = { ...ZLECENIE, parcel: { ...GOTOWA, courierCode: 'GLS_SDS', pickupPoint: 'PL12345' } }
    a.usterka({ metoda: 'adePickup_Create', rodzaj: 'fault', kod: 'err_pickup_problem' })
    expect((await z.createShipment(doPunktu, REF)).kind).toBe('TRWALY')
    const r = await z.createShipment({ ...doPunktu, parcel: { ...doPunktu.parcel, pickupPoint: 'PL54321' }, ponowienie: true }, REF)
    expect(r).toMatchObject({ kind: 'TRWALY' })
    expect('message' in r && r.message).toContain('punkt GLS')
    expect((await z.createShipment({ ...doPunktu, ponowienie: true }, REF)).kind).toBe('OK')
    expect(a.ile('adePreparingBox_Insert')).toBe(1)
  })

  it('Fault Client, VersionMismatch, MustUnderstand przy zapisie = TRWALY; Server i nieznane = NIEJEDNOZNACZNY', async () => {
    const a = glsAtrapa()
    const k = new GlsZapis({ url: GLS_URL, auth: AUTH, fetchImpl: a.fetchImpl, wylacznik: true })
    for (const kod of ['SOAP-ENV:Client', 'Client.Auth', 'SOAP-ENV:VersionMismatch', 'MustUnderstand']) {
      a.usterka({ metoda: 'adePreparingBox_Insert', rodzaj: 'fault', kod })
      expect([kod, ((await k.wywolaj('adePreparingBox_Insert', { session: 's' }, 's')) as { kind?: string }).kind]).toEqual([kod, 'TRWALY'])
    }
    for (const kod of ['SOAP-ENV:Server', 'ClientX', 'fault']) {
      a.usterka({ metoda: 'adePreparingBox_Insert', rodzaj: 'fault', kod })
      expect([kod, ((await k.wywolaj('adePreparingBox_Insert', { session: 's' }, 's')) as { kind?: string }).kind]).toEqual([kod, 'NIEJEDNOZNACZNY'])
    }
    // przez adapter: zła przestrzeń nazw przy wstawieniu = odmowa bez „Sprawdź u przewoźnika”
    a.usterka({ metoda: 'adePreparingBox_Insert', rodzaj: 'fault', kod: 'SOAP-ENV:Client' })
    expect((await zapisowy(a).createShipment(ZLECENIE, REF)).kind).toBe('TRWALY')
  })
})
