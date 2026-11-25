// ustawienia konta przewoźnika (pola z manifestu: FID-y, środowisko, wymiary) żyją przy koncie
// (`settings.przewoznicy.ustawienia`), nie w regule: zapis działa bez reguły, reguła z modułem tego konta bierze je przy
// nadaniu, podglądzie i teście połączenia. Konta ustawione dawniej przez reguły (wartości w `CarrierRule.config`, bez
// wpisu konta) działają bez zmian. Zmiana modułu reguły nie gubi ustawień konta, a ustawienia ukryte przewoźnika
// (adres API, przedrostek env) nie przechodzą na moduł innego przewoźnika. Dane fikcyjne, zero połączeń z DPD.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { setSecret } from '@/lib/sekrety'
import { kontaPrzewoznikow, wykonajTestKonta, zapiszKontaPrzewoznikow } from '@/lib/wysylka/konta'
import { utworzPrzesylke, type DepsNadania } from '@/lib/wysylka/nadanie'
import { regulyPrzewoznikow, zapiszRegulyPrzewoznikow } from '@/lib/wysylka/reguly'
import { ustawieniaKont } from '@/lib/wysylka/ustawienia-konta'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa } from './dpd-atrapa'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
const registry = defaultRegistry()
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const KLUCZ = { APP_ENCRYPTION_KEY: 'b'.repeat(64), APP_MODE: 'self-host' }
const ENV = { ...KLUCZ, EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64), DPD_LOGIN, DPD_PASSWORD }
const NADAWCA = { name: 'Firma Testowa', fullName: 'Firma Testowa sp. z o.o.', address: 'ul. Magazynowa 5', city: 'Testowo', postalCode: '00-002', phone: '500000000', email: 'magazyn@example.invalid' }
const POTWIERDZONE = ['waga_domyslna', 'gabaryt_podpowiedz']
const WYMIARY = { defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 }
const DOSTAWA = { imieNazwisko: 'Ewa Fikcyjna', firma: null, ulica: 'ul. Atrapowa', numerDomu: '9', numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL', telefon: '+48 511 000 111', email: 'ewa@example.test' }
const odbiorca: OrderRecipient = { dostawa: DOSTAWA, punktOdbioru: null, faktura: null, problemy: [] }

let atrapa: ReturnType<typeof dpdAtrapa>
const deps = (): DepsNadania => ({ fetch: atrapa.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
const payerFid = () => (atrapa.calls.find((c) => c.path.endsWith('/generatePackagesNumbers'))!.body as { packages: { payerFID: number }[] }).packages[0]!.payerFID

const pole = async (konto: string, key: string, db = a) => (await kontaPrzewoznikow(db, registry)).find((k) => k.id === konto)?.pola.find((p) => p.key === key)?.wartosc
const zapiszPola = (id: string, pola: Record<string, string>, db = a) => zapiszKontaPrzewoznikow(db, registry, [{ id, sekrety: {}, pola, nadawanie: {} }], { actorId: 'u-a', env: KLUCZ })
const wej = (r: Awaited<ReturnType<typeof regulyPrzewoznikow>>[number]) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '', konto: r.konto ?? '' })
const config = async (id: string) => (await a.carrierRule.findUniqueOrThrow({ where: { id } })).config

/** Reguły DPD (kurier) na module DPD z zapisem, z adresem demo; `config` = dodatkowe ustawienia w regule. */
async function regulyDpd(dodatkowe: Record<string, unknown> = {}): Promise<void> {
  await a.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: { baseUrl: DPD_DEMO, zapisWlaczony: true, ...dodatkowe } } })
  await a.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  const s = (await sys.organization.findUniqueOrThrow({ where: { id: ORG_A }, select: { settings: true } })).settings as Record<string, unknown>
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...s, nadawca: NADAWCA } } })
}

async function nadajKurierem(): Promise<void> {
  const pid = await product(a, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(a, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Kurier DPD', paymentState: 'PAID', paymentMethod: 'Przelew', totalGross: 30 }), { now: T0 })
  await zapiszRekordKlienta(a, r.orderId!, rekordZOdbiorcy(odbiorca), { source: 'RECZNE', fetchedAt: T0, env: ENV })
  expect(await utworzPrzesylke(a, { orderId: r.orderId!, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u-test' }, deps())).toMatchObject({ wynik: 'UTWORZONA' })
}

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) await seedBase(db)
  atrapa = dpdAtrapa()
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('konto przewoźnika bez reguły', () => {
  it('zapis ustawień konta bez żadnej reguły: wartości zostają i wracają w karcie; druga firma ich nie widzi', async () => {
    expect((await kontaPrzewoznikow(a, registry)).find((k) => k.id === 'dpd')!.reguly).toEqual([])
    const r = await zapiszPola('dpd', { payerFid: '1495', masterFid: '2222', srodowisko: 'produkcja', defaultSideXCm: '40' })
    expect(r).toEqual({ klucze: 0, reguly: 0, konta: 1 })
    expect(await pole('dpd', 'payerFid')).toBe('1495')
    expect(await pole('dpd', 'masterFid')).toBe('2222')
    expect(await pole('dpd', 'srodowisko')).toBe('produkcja')
    expect(await pole('dpd', 'defaultSideXCm')).toBe('40')
    // ślad w historii zmian
    const log = await a.auditLog.findFirstOrThrow({ where: { entity: 'CarrierRule.config' }, orderBy: { createdAt: 'desc' } })
    expect(log.after).toMatchObject({ konta: [{ id: 'dpd', ustawienia: { payerFid: '1495', masterFid: '2222', srodowisko: 'produkcja', defaultSideXCm: 40 } }] })
    // ten sam zapis drugi raz: nic się nie zmieniło
    expect(await zapiszPola('dpd', { payerFid: '1495', masterFid: '2222', srodowisko: 'produkcja', defaultSideXCm: '40' })).toEqual({ klucze: 0, reguly: 0, konta: 0 })
    // wyczyszczenie pola = usunięcie z ustawień konta
    await zapiszPola('dpd', { masterFid: '' })
    expect(await pole('dpd', 'masterFid')).toBe('')
    expect(await pole('dpd', 'payerFid')).toBe('1495')
    // zły format: odmowa, nic nie zapisane
    await expect(zapiszPola('dpd', { payerFid: 'zly fid' })).rejects.toThrow(/zły format/)
    expect(await pole('dpd', 'payerFid')).toBe('1495')
    // izolacja firm
    expect(await pole('dpd', 'payerFid', b)).toBe('')
  })

  it('drugie konto tego samego przewoźnika ma własne ustawienia', async () => {
    await setSecret(a, 'DPD_LOGIN_EMPIK', 'login-empik', KLUCZ)
    await zapiszPola('dpd', { payerFid: '1111' })
    await zapiszPola('dpd~EMPIK', { payerFid: '7777' })
    expect(await pole('dpd', 'payerFid')).toBe('1111')
    expect(await pole('dpd~EMPIK', 'payerFid')).toBe('7777')
    expect(Object.keys(ustawieniaKont((await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings)).sort()).toEqual(['dpd', 'dpd~EMPIK'])
  })

  it('reguła wybrana po zapisie konta bierze ustawienia konta przy nadaniu (FID płatnika z konta, nie z reguły)', async () => {
    await zapiszPola('dpd', { payerFid: '3333', defaultSideXCm: '40', defaultSideYCm: '30', defaultSideZCm: '20', defaultWeightKg: '1' })
    await regulyDpd()
    // karta konta: reguła i ustawienia konta
    const k = (await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'dpd')!
    expect(k.reguly.length).toBeGreaterThan(0)
    expect(k.pola.find((p) => p.key === 'payerFid')!.wartosc).toBe('3333')
    await nadajKurierem()
    expect(payerFid()).toBe(3333)
  })

  it('ustawienie zapisane przy koncie wygrywa ze starą wartością w regule', async () => {
    await regulyDpd({ payerFid: DPD_FID, ...WYMIARY })
    expect(await pole('dpd', 'payerFid')).toBe(DPD_FID)
    await zapiszPola('dpd', { payerFid: '4444' })
    expect(await pole('dpd', 'payerFid')).toBe('4444')
    // stara wartość w regule zostaje (odwracalnie), ale nie działa
    const r = await a.carrierRule.findFirstOrThrow({ where: { carrier: 'DPD' } })
    expect(r.config).toMatchObject({ payerFid: DPD_FID })
    await nadajKurierem()
    expect(payerFid()).toBe(4444)
  })
})

describe('zgodność wstecz: konto ustawione przez reguły', () => {
  it('bez wpisu konta: karta i nadanie biorą wartości z reguły; zapis ekranu bez zmian niczego nie przenosi', async () => {
    await regulyDpd({ payerFid: DPD_FID, defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 })
    const przed = await a.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { id: true, config: true } })
    const k = (await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'dpd')!
    expect(k.pola.find((p) => p.key === 'payerFid')!.wartosc).toBe(DPD_FID)
    // panel wysyła wszystkie pola karty z wartościami, które pokazał
    const r = await zapiszPola('dpd', Object.fromEntries(k.pola.map((p) => [p.key, p.wartosc])))
    expect(r).toEqual({ klucze: 0, reguly: 0, konta: 0 })
    expect(ustawieniaKont((await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings)).toEqual({})
    expect(await a.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { id: true, config: true } })).toEqual(przed)
    await nadajKurierem()
    expect(payerFid()).toBe(Number(DPD_FID))
  })

  it('Base Courier z dwiema regułami o różnych wartościach: karta pokazuje pierwszą, zapis karty ustawia ją kontu dla obu reguł', async () => {
    const bc = await a.carrierRule.findMany({ where: { shippingModule: 'BASE_COURIER' }, orderBy: { priority: 'asc' } })
    expect(bc.length).toBeGreaterThan(1)
    await a.carrierRule.update({ where: { id: bc[0]!.id }, data: { config: { baseUrl: 'https://sandbox.basecourier.com/api', defaultWeightKg: 2 } } })
    await a.carrierRule.update({ where: { id: bc[1]!.id }, data: { config: { baseUrl: 'https://sandbox.basecourier.com/api', defaultWeightKg: 3 } } })
    expect(await pole('basecourier', 'defaultWeightKg')).toBe('2')
    // zapis bez zmian: pole, w którym reguły się rozjeżdżają, trafia do konta z wartością z karty (jak dawniej zapis
    // do wszystkich reguł konta); pola zgodne zostają w regułach, configi reguł nietknięte
    const k = (await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'basecourier')!
    expect(await zapiszPola('basecourier', Object.fromEntries(k.pola.map((p) => [p.key, p.wartosc])))).toEqual({ klucze: 0, reguly: 0, konta: 1 })
    expect(await config(bc[0]!.id)).toEqual({ baseUrl: 'https://sandbox.basecourier.com/api', defaultWeightKg: 2 })
    expect(await config(bc[1]!.id)).toEqual({ baseUrl: 'https://sandbox.basecourier.com/api', defaultWeightKg: 3 })
    expect(ustawieniaKont((await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings)).toEqual({ basecourier: { defaultWeightKg: 2 } })
    // drugi zapis bez zmian: nic
    expect(await zapiszPola('basecourier', Object.fromEntries(k.pola.map((p) => [p.key, p.wartosc])))).toEqual({ klucze: 0, reguly: 0, konta: 0 })
  })

  it('reguła dołącza do konta, którego ustawienia są tylko w innej regule: nadaje na tych samych ustawieniach', async () => {
    // reguła A (DPD_EMPIK) na DPD z ustawieniami w configu; reguła B (DPD kurier) na Base Courier
    const empik = await a.carrierRule.findFirstOrThrow({ where: { carrier: 'DPD_EMPIK' } })
    await a.carrierRule.update({ where: { id: empik.id }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: { baseUrl: DPD_DEMO, payerFid: '5555', masterFid: '2222', srodowisko: 'demo', zapisWlaczony: true, ...WYMIARY } } })
    const kurier = (await a.carrierRule.findMany({ where: { carrier: 'DPD' }, orderBy: { priority: 'asc' } }))[0]!
    await a.carrierRule.update({ where: { id: kurier.id }, data: { shippingModule: 'BASE_COURIER', adapterKey: 'basecourier.zapis.v1', config: { baseUrl: 'https://api.blpaczka.com/api', courierCode: 'dpd' } } })
    expect(ustawieniaKont((await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings)).toEqual({})
    // przełączenie reguły B na DPD
    const lista = await regulyPrzewoznikow(a, registry)
    await zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === kurier.id ? { ...wej(x), adapterKey: 'dpd.services.zapis.v1' } : wej(x))), 'u-a')
    // ustawienia konta DPD z reguły A są teraz przy koncie; reguła A nietknięta
    expect(ustawieniaKont((await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings)['dpd']).toMatchObject({ payerFid: '5555', masterFid: '2222', srodowisko: 'demo' })
    expect(await config(empik.id)).toMatchObject({ payerFid: '5555', zapisWlaczony: true })
    // reguła B nadaje na ustawieniach konta (adres demo i nadawanie ustawia osoba techniczna / panel)
    await a.carrierRule.update({ where: { id: kurier.id }, data: { config: { ...((await config(kurier.id)) as Record<string, unknown>), baseUrl: DPD_DEMO, zapisWlaczony: true } } })
    await a.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const s = (await sys.organization.findUniqueOrThrow({ where: { id: ORG_A }, select: { settings: true } })).settings as Record<string, unknown>
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...s, nadawca: NADAWCA } } })
    await nadajKurierem()
    expect(payerFid()).toBe(5555)
    // karta konta zapisana bez zmian niczego nie psuje
    const k = (await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'dpd')!
    expect(k.pola.find((p) => p.key === 'payerFid')!.wartosc).toBe('5555')
    expect((await zapiszPola('dpd', Object.fromEntries(k.pola.map((p) => [p.key, p.wartosc])))).konta).toBe(0)
  })

  it('stan zastany (dwie reguły konta, ustawienia tylko w jednej): zapis karty bez zmian ustawia je kontu', async () => {
    const empik = await a.carrierRule.findFirstOrThrow({ where: { carrier: 'DPD_EMPIK' } })
    await a.carrierRule.update({ where: { id: empik.id }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: { payerFid: '5555', srodowisko: 'demo' } } })
    const kurier = (await a.carrierRule.findMany({ where: { carrier: 'DPD' }, orderBy: { priority: 'asc' } }))[0]!
    // stan po starym kodzie albo ręcznej zmianie: druga reguła konta bez ustawień
    await a.carrierRule.update({ where: { id: kurier.id }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: {} } })
    const k = (await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'dpd')!
    const pierwsza = k.reguly[0]!.id === empik.id
    const pokazane = k.pola.find((p) => p.key === 'payerFid')!.wartosc
    expect(pokazane).toBe(pierwsza ? '5555' : '')
    await zapiszPola('dpd', Object.fromEntries(k.pola.map((p) => [p.key, p.wartosc])))
    const u = ustawieniaKont((await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings)['dpd'] ?? {}
    // wartość pokazana w karcie obowiązuje teraz obie reguły (konto ma wpis dla pola)
    expect(Object.hasOwn(u, 'payerFid')).toBe(true)
    expect(u['payerFid'] ?? '').toBe(pokazane)
  })
})

describe('zmiana modułu reguły', () => {
  it('reguła DPD przełączona na Base Courier i z powrotem: ustawienia konta DPD zostają', async () => {
    await regulyDpd({ payerFid: DPD_FID, masterFid: '2222', ...WYMIARY })
    const reguly = await regulyPrzewoznikow(a, registry)
    const dpd = reguly.filter((r) => r.adapterKey === 'dpd.services.zapis.v1').map((r) => r.id)
    expect(dpd.length).toBeGreaterThan(0)
    await zapiszRegulyPrzewoznikow(a, registry, reguly.map((r) => (dpd.includes(r.id) ? { ...wej(r), adapterKey: 'basecourier.zapis.v1' } : wej(r))), 'u-a')
    // konto DPD bez reguł: ustawienia dalej w karcie
    expect((await kontaPrzewoznikow(a, registry)).find((k) => k.id === 'dpd')!.reguly).toEqual([])
    expect(await pole('dpd', 'payerFid')).toBe(DPD_FID)
    expect(await pole('dpd', 'masterFid')).toBe('2222')
    // z powrotem na DPD: ustawienia konta są, reguła nadaje z nimi
    const po = await regulyPrzewoznikow(a, registry)
    await zapiszRegulyPrzewoznikow(a, registry, po.map((r) => (dpd.includes(r.id) ? { ...wej(r), adapterKey: 'dpd.services.zapis.v1' } : wej(r))), 'u-a')
    expect(await pole('dpd', 'payerFid')).toBe(DPD_FID)
    // adres demo wrócił do reguły ręcznie (ustawienie ukryte przewoźnika nie przechodzi między przewoźnikami)
    for (const id of dpd) await a.carrierRule.update({ where: { id }, data: { config: { ...((await config(id)) as Record<string, unknown>), baseUrl: DPD_DEMO, zapisWlaczony: true } } })
    await nadajKurierem()
    expect(payerFid()).toBe(Number(DPD_FID))
  })

  it('Base Courier → DPD: adres API, przedrostek env i nadawanie nie przechodzą; Base Courier v1 ↔ z zapisem: zostają', async () => {
    const r = (await a.carrierRule.findMany({ where: { shippingModule: 'BASE_COURIER' }, orderBy: { priority: 'asc' } }))[0]!
    await a.carrierRule.update({ where: { id: r.id }, data: { adapterKey: 'basecourier.zapis.v1', config: { baseUrl: 'https://api.blpaczka.com/api', envPrefix: 'BASE_COURIER', courierCode: 'dpd', zapisWlaczony: true } } })
    // ta sama rodzina: zostaje wszystko
    let lista = await regulyPrzewoznikow(a, registry)
    await zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === r.id ? { ...wej(x), adapterKey: 'basecourier.v1' } : wej(x))), 'u-a')
    expect(await config(r.id)).toEqual({ baseUrl: 'https://api.blpaczka.com/api', envPrefix: 'BASE_COURIER', courierCode: 'dpd', zapisWlaczony: true })
    lista = await regulyPrzewoznikow(a, registry)
    await zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === r.id ? { ...wej(x), adapterKey: 'basecourier.zapis.v1' } : wej(x))), 'u-a')
    expect(await config(r.id)).toEqual({ baseUrl: 'https://api.blpaczka.com/api', envPrefix: 'BASE_COURIER', courierCode: 'dpd', zapisWlaczony: true })
    // inny przewoźnik: ustawienia ukryte Base Couriera i wyłącznik nadawania znikają, wynik mówi o przeniesieniu
    lista = await regulyPrzewoznikow(a, registry)
    const nr = lista.findIndex((x) => x.id === r.id)
    const w = await zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === r.id ? { ...wej(x), carrier: 'DPD', adapterKey: 'dpd.services.zapis.v1' } : wej(x))), 'u-a')
    expect(w.przeniesione).toEqual([{ nr: nr + 1, konto: null, adapterKey: 'dpd.services.zapis.v1', nadawanieWylaczone: true, przeniesionePola: [], doUzupelnienia: [] }])
    expect(await config(r.id)).toEqual({})
  })

  it('reguła z drugim kontem przełączona na innego przewoźnika: konto wskazane w kolumnie „Konto” musi istnieć u nowego przewoźnika', async () => {
    await setSecret(a, 'DPD_LOGIN_EMPIK', 'login-empik', KLUCZ)
    const r = (await a.carrierRule.findMany({ where: { carrier: 'DPD' }, orderBy: { priority: 'asc' } }))[0]!
    await a.carrierRule.update({ where: { id: r.id }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: { sekretyKonta: 'EMPIK', payerFid: '7777' } } })
    const lista = await regulyPrzewoznikow(a, registry)
    await expect(zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === r.id ? { ...wej(x), adapterKey: 'basecourier.zapis.v1' } : wej(x))), 'u-a')).rejects.toThrow(/Tego konta nie ma/)
    // bez konta (główne): reguła przechodzi, ustawienia konta DPD Empik zostają przy koncie
    await zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === r.id ? { ...wej(x), adapterKey: 'basecourier.zapis.v1', konto: '' } : wej(x))), 'u-a')
    expect(await config(r.id)).toEqual({})
    expect(await pole('dpd~EMPIK', 'payerFid')).toBe('7777')
  })
})

describe('„Sprawdź połączenie” konta bez reguły', () => {
  it('działa na zapisanych ustawieniach konta; bez wymaganego pola mówi, czego brakuje i gdzie to wpisać', async () => {
    await setSecret(a, 'DPD_LOGIN', DPD_LOGIN, KLUCZ)
    await setSecret(a, 'DPD_PASSWORD', DPD_PASSWORD, KLUCZ)
    const zrodlo = { env: KLUCZ, envFallback: false }
    const brak = await wykonajTestKonta(a, { konto: 'dpd' }, { registry, secrets: zrodlo, fetch: atrapa.fetchImpl })
    expect(brak!.ok).toBe(false)
    expect(brak!.message).toMatch(/FID płatnika/)
    expect(brak!.message).toMatch(/Zapisz zmiany/)
    expect(atrapa.calls).toEqual([])

    await zapiszPola('dpd', { payerFid: '1495', srodowisko: 'demo' })
    const ok = await wykonajTestKonta(a, { konto: 'dpd' }, { registry, secrets: zrodlo, fetch: atrapa.fetchImpl })
    expect(ok).toEqual({ ok: true, message: 'Połączenie działa.' })
    expect(atrapa.calls.length).toBe(1)
    expect(atrapa.calls[0]!.url.startsWith(DPD_DEMO)).toBe(true)
    expect(atrapa.calls[0]!.headers['x-dpd-fid']).toBe('1495')
  })
})
