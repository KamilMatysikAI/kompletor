// Base Courier za hostem przesyłek (`lib/wysylka/nadanie.ts`) na atrapie (tests/basecourier-atrapa.ts) i bazie
// testowej. Gabaryty InPost A/B/C i Kurier DPD jak przyciski BL, pobranie z zamówienia, etykieta PDF zaszyfrowana,
// anulowanie, a przede wszystkim: zgubiona odpowiedź NIGDY nie daje drugiej płatnej przesyłki (Base Courier nie ma
// odszukania po referencji), tylko NIEJEDNOZNACZNA → „Rozstrzygnij ręcznie” z weryfikacją numeru w Base Courier.
// Dane wyłącznie fikcyjne, zero połączeń z Base Courier (także sandboxem).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { anulujPrzesylke, bramkaNadania, rozstrzygnijRecznie, sprawdzPrzesylke, utworzPrzesylke, widokPrzesylki, type DepsNadania } from '@/lib/wysylka/nadanie'
import { etykietaZamowienia } from '@/lib/wysylka/etykieta-przewoznika'
import { NUMER_NADANIA_GOTOWY } from '@/lib/wysylka/zdarzenia'
import { BC_ETYKIETA, BC_KEY, BC_LOGIN, BC_SANDBOX, bcAtrapa } from './basecourier-atrapa'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { NADAWCA_TESTOWY } from './dpd-atrapa'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const NAZWISKO = 'Anna Fikcyjna'
const ULICA = 'ul. Atrapowa'
const TELEFON = '+48 511 222 333'
const EMAIL = 'anna@example.test'
const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: NAZWISKO, firma: null, ulica: ULICA, numerDomu: '9', numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL', telefon: TELEFON, email: EMAIL },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}
const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64), BASE_COURIER_LOGIN: BC_LOGIN, BASE_COURIER_API_KEY: BC_KEY }
const KONFIG = { baseUrl: BC_SANDBOX, zapisWlaczony: true, kontoPobran: '11 1111 1111 1111 1111 1111 1111', defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 }
const POTWIERDZONE = ['waga_domyslna', 'gabaryt_podpowiedz']

let bc: ReturnType<typeof bcAtrapa>
const deps = (): DepsNadania => ({ fetch: bc.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
const zamowien = () => bc.ile('createOrderV2.json')

/** Firma: paczkomat, salon Empik i kurier DPD przez Base Courier z zapisem, konto WOO/sd w PRACA, nadawca firmy. */
async function firma(o: { config?: Record<string, unknown>; adapterKey?: string; praca?: boolean; settings?: Record<string, unknown> } = {}): Promise<void> {
  for (const carrier of ['PACZKOMATY', 'DPD_EMPIK', 'DPD'] as const)
    await db.carrierRule.updateMany({ where: { carrier }, data: { shippingModule: 'BASE_COURIER', adapterKey: o.adapterKey ?? 'basecourier.zapis.v1', config: (o.config ?? KONFIG) as object } })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: o.praca === false ? 'CIEN' : 'PRACA' } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: (o.settings ?? { nadawca: NADAWCA_TESTOWY }) as object } })
}

async function zamowienie(o: { dostawa?: string; punkt?: string | null; platnosc?: 'PAID' | 'COD'; brutto?: number } = {}): Promise<string> {
  const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: o.brutto ?? 30 }], { deliveryMethod: o.dostawa ?? 'Paczkomaty InPost', paymentState: o.platnosc ?? 'PAID', paymentMethod: o.platnosc === 'COD' ? 'Pobranie' : 'Przelew' }), { now: T0 })
  const punkt = o.punkt === undefined ? 'POZ08M' : o.punkt
  await zapiszRekordKlienta(db, r.orderId!, rekordZOdbiorcy({ ...ODBIORCA, punktOdbioru: punkt ? { kod: punkt, nazwa: null } : null }), { source: 'RECZNE', fetchedAt: T0, env: ENV })
  return r.orderId!
}

const utworz = (orderId: string, gabaryt: string | null = 'INPOST_A') => utworzPrzesylke(db, { orderId, gabaryt, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u-test' }, deps())

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  bc = bcAtrapa()
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('bramki hosta: przycisk widoczny, z powodem, zero żądań do Base Courier', () => {
  it('moduł tylko do podglądu, wyłączony zapis, konto w cieniu', async () => {
    await firma({ adapterKey: 'basecourier.v1' })
    const id = await zamowienie()
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/tylko liczy przesyłkę/)
    await firma({ config: { ...KONFIG, zapisWlaczony: false } })
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/wyłączone w ustawieniach przewoźnika/)
    await firma({ praca: false })
    expect(await utworz(id)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/„Tylko podgląd”/) })
    await firma()
    expect((await bramkaNadania(db, id, deps()))!).toMatchObject({ powod: null, modul: expect.stringContaining('Base Courier'), gabaryty: [{ kod: 'INPOST_A' }, { kod: 'INPOST_B' }, { kod: 'INPOST_C' }] })
    expect(bc.calls).toEqual([])
  })
})

describe('utworzenie przesyłki', () => {
  it('InPost B: numer listu, etykieta PDF zaszyfrowana, zdarzenie raz, referencja w „Zawartość przesyłki”; bez danych klienta w jawnych kolumnach', async () => {
    await firma()
    const id = await zamowienie()
    const w = await utworz(id, 'INPOST_B')
    expect(w).toMatchObject({ wynik: 'UTWORZONA', istniala: false })
    expect(bc.calls.map((c) => c.endpoint)).toEqual(['createOrderV2.json', 'getWaybill.json'])
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    const z = bc.zamowienia[0]!
    expect(s).toMatchObject({ state: 'UTWORZONA', externalRef: String(z.id), trackingNumber: z.waybill_no, labelFormat: 'PDF', carrier: 'PACZKOMATY', adapterKey: 'basecourier.zapis.v1', parcelSize: 'INPOST_B' })
    expect(z.CourierSearch).toMatchObject({ courier_code: 'paczkomaty', side_x: 19, side_y: 38, side_z: 64 })
    expect(z.Order).toMatchObject({ taker_point: 'POZ08M', taker_name: NAZWISKO })
    expect(z.package_content).toContain(s.reference)
    expect(await db.auditLog.count({ where: { entity: NUMER_NADANIA_GOTOWY } })).toBe(1)
    const { labelCiphertext, labelIv: _iv, labelAuthTag: _tag, ...jawne } = s
    for (const x of [NAZWISKO, ULICA, TELEFON, EMAIL]) expect(JSON.stringify(jawne)).not.toContain(x)
    expect(Buffer.from(labelCiphertext!).toString('utf8')).not.toContain('fikcyjna etykieta')
    // druk bierze prawdziwą etykietę z bazy, bez pytania przewoźnika
    const e = await etykietaZamowienia.etykieta(db, id, T0)
    expect(Buffer.from((e as { pdf: Buffer }).pdf).toString()).toBe(BC_ETYKIETA)
    expect(bc.calls).toHaveLength(2)
  })

  it('drugie kliknięcie i dwa równoległe: jedna przesyłka w Base Courier', async () => {
    await firma()
    const id = await zamowienie()
    const [a, b] = await Promise.all([utworz(id), utworz(id)])
    expect([a.wynik, b.wynik].sort()).toEqual(expect.arrayContaining(['UTWORZONA']))
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA', istniala: true })
    expect(zamowien()).toBe(1)
    expect(await db.shipment.count({ where: { orderId: id } })).toBe(1)
  })

  it('Kurier DPD (wymiary firmy) i salon Empik (punkt) jak przyciski BL', async () => {
    await firma()
    const dpd = await zamowienie({ dostawa: 'Kurier DPD', punkt: null })
    expect((await bramkaNadania(db, dpd, deps()))!.gabaryty).toEqual([{ kod: 'DPD', nazwa: 'DPD' }])
    expect((await utworz(dpd, 'DPD')).wynik).toBe('UTWORZONA')
    expect(bc.zamowienia[0]!.CourierSearch).toMatchObject({ courier_code: 'dpd', side_x: 40, side_y: 30, side_z: 20 })
    // pole wymagane w dokumentacji API: bez punktu pusty tekst; `origin` w każdej przesyłce
    expect(bc.zamowienia[0]!.Order).toMatchObject({ taker_point: '' })
    expect(bc.zamowienia[0]!.CourierSearch).toMatchObject({ origin: 'kompletor' })
    const empik = await zamowienie({ dostawa: 'Dostawa do salonu Empik', punkt: 'PL12345' })
    expect((await utworz(empik, 'DPD')).wynik).toBe('UTWORZONA')
    expect(bc.zamowienia[1]!.Order).toMatchObject({ taker_point: 'PL12345' })
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: empik } })).carrier).toBe('DPD_EMPIK')
  })

  it('pobranie: kwota zamówienia jako uptake, zapisana w przesyłce; bez rachunku zwrotu = BLAD bez zamówienia w Base Courier', async () => {
    await firma()
    const id = await zamowienie({ platnosc: 'COD', brutto: 47.5 })
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    // kwota pobrania = brutto zamówienia z bazy (nie z kanału ani z ręki)
    const brutto = Number((await db.order.findUniqueOrThrow({ where: { id }, select: { totalGross: true } })).totalGross)
    expect(brutto).toBeGreaterThan(0)
    expect(bc.zamowienia[0]!.CourierSearch).toMatchObject({ uptake: brutto })
    expect(Number((await db.shipment.findFirstOrThrow({ where: { orderId: id } })).codAmount)).toBe(brutto)
    await firma({ config: { ...KONFIG, kontoPobran: undefined } })
    const bez = await zamowienie({ platnosc: 'COD', brutto: 10 })
    expect(await utworz(bez)).toMatchObject({ wynik: 'BLAD', powod: expect.stringMatching(/rachunku do zwrotu pobrań/) })
    expect(zamowien()).toBe(1)
  })

  it('odmowa bez walidacji (brak środków) = NIEJEDNOZNACZNA do testu na sandboxie: kolejne kliknięcie nic nie wysyła; „nie powstała” → nowa referencja, jedna przesyłka', async () => {
    await firma()
    const id = await zamowienie()
    bc.awarie['createOrderV2.json'] = [{ status: 200, body: JSON.stringify({ success: false, message: 'Brak wystarczających środków w skarbonce' }) }]
    expect((await utworz(id)).wynik).toBe('NIEJEDNOZNACZNA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s.lastError).toContain('Brak wystarczających środków')
    expect(await utworz(id)).toMatchObject({ wynik: 'NIEJEDNOZNACZNA', istniala: true })
    expect(zamowien()).toBe(1)
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u', deps: deps() })).wynik).toBe('ANULOWANA')
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const nowa = await db.shipment.findFirstOrThrow({ where: { orderId: id, state: 'UTWORZONA' } })
    expect(nowa.reference).not.toBe(s.reference)
    expect(zamowien()).toBe(2)
    expect(bc.zamowienia).toHaveLength(1)
  })

  it('ślad zamówienia w odpowiedzi „niepowodzenie” (blpaczka_order_id) = NIEJEDNOZNACZNA z numerem, bez ponowienia', async () => {
    await firma()
    const id = await zamowienie()
    bc.awarie['createOrderV2.json'] = [{ status: 200, body: JSON.stringify({ success: false, message: 'Płatność odrzucona', data: { blpaczka_order_id: 9100555, Order: null } }) }]
    expect((await utworz(id)).wynik).toBe('NIEJEDNOZNACZNA')
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: id } })).lastError).toContain('9100555')
    expect((await utworz(id)).wynik).toBe('NIEJEDNOZNACZNA')
    expect(zamowien()).toBe(1)
  })

  it('nadawca z samego profilu firmy (Ustawienia → Dane firmy, bez settings.nadawca): przesyłka powstaje z danymi profilu', async () => {
    await firma({ settings: { firma: { nazwa: 'Profil Sp. z o.o.', adres: { ulica: 'ul. Profilowa 12/3', kodPocztowy: '61-100', miasto: 'Poznań' }, telefon: '612000000', email: 'biuro@example.invalid' } } })
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const o = (bc.calls.find((c) => c.endpoint === 'createOrderV2.json')!.body['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order
    expect(o).toMatchObject({ name: 'Profil Sp. z o.o.', street: 'ul. Profilowa', house_no: '12', locum_no: '3', postal: '61-100', city: 'Poznań', phone: '612000000', email: 'biuro@example.invalid' })
    // profil bez telefonu: błąd wskazuje tylko brakujące pole
    await firma({ settings: { firma: { nazwa: 'Profil', adres: { ulica: 'ul. Profilowa 12', kodPocztowy: '61-100', miasto: 'Poznań' } } } })
    const bez = await zamowienie()
    expect(await utworz(bez)).toMatchObject({ wynik: 'BLAD', powod: expect.stringMatching(/Dane firmy\): phone$/) })
    expect(zamowien()).toBe(1)
  })
})

describe('zgubiona odpowiedź: bez drugiej płatnej przesyłki', () => {
  async function niejednoznaczna() {
    await firma()
    const id = await zamowienie()
    bc.awarie['createOrderV2.json'] = ['zgubiona']
    const w = await utworz(id)
    expect(w.wynik).toBe('NIEJEDNOZNACZNA')
    expect(bc.zamowienia).toHaveLength(1)
    return { id, s: await db.shipment.findFirstOrThrow({ where: { orderId: id } }) }
  }

  it('NIEJEDNOZNACZNA z alertem; kolejne kliknięcia i „Sprawdź u przewoźnika” nie wysyłają drugiego zamówienia', async () => {
    const { id, s } = await niejednoznaczna()
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', closedAt: null } })).toBe(1)
    expect(await utworz(id)).toMatchObject({ wynik: 'NIEJEDNOZNACZNA', istniala: true })
    expect(await sprawdzPrzesylke(db, s.id, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'NADAL_NIEJASNE', komunikat: expect.stringContaining(s.reference) })
    expect(zamowien()).toBe(1)
    const v = (await widokPrzesylki(db, id))!
    expect(v).toMatchObject({ stan: 'NIEJEDNOZNACZNA', doSprawdzenia: true, referencja: s.reference, rozstrzygniecie: { etykietaNumeru: expect.stringContaining('Base Courier') } })
    expect(v.rozstrzygniecie.wskazowka).toContain('Zawartość przesyłki')
  })

  it('„Rozstrzygnij ręcznie”: numer innej przesyłki = odmowa; numer listu tej przesyłki = UTWORZONA z id Base Courier i etykietą, zdarzenie raz', async () => {
    const { id, s } = await niejednoznaczna()
    // inna przesyłka w tym samym koncie Base Courier (np. innego zamówienia)
    const inne = await zamowienie()
    expect((await utworz(inne)).wynik).toBe('UTWORZONA')
    const obca = bc.zamowienia[1]!
    // numer, który w Kompletorze ma już przesyłka innego zamówienia: odmowa, zanim zapytamy Base Courier
    const zapytan = bc.calls.length
    expect(await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: obca.waybill_no }, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('Ten numer ma już w Kompletorze inna paczka') })
    expect(bc.calls.length).toBe(zapytan)
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('NIEJEDNOZNACZNA')
    const nasza = bc.zamowienia[0]!
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: nasza.waybill_no }, { userId: 'u-biuro', deps: deps() })
    expect(r.wynik).toBe('UTWORZONA')
    const po = await db.shipment.findUniqueOrThrow({ where: { id: s.id } })
    expect(po).toMatchObject({ state: 'UTWORZONA', externalRef: String(nasza.id), trackingNumber: nasza.waybill_no })
    expect(po.labelCiphertext).not.toBeNull()
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'PRZESYLKA_UTWORZONA' } })).toBe(1)
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', closedAt: null } })).toBe(0)
    expect(zamowien()).toBe(2)
  })
})

describe('anulowanie', () => {
  it('„Anuluj przesyłkę”: Base Courier anuluje, przesyłka ANULOWANA, następna z nową referencją', async () => {
    await firma()
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect((await widokPrzesylki(db, id))!.moznaAnulowac).toBe(true)
    expect(await anulujPrzesylke(db, s.id, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ANULOWANA' })
    expect(bc.zamowienia[0]!.status).toBe('cancelled')
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const nowa = await db.shipment.findFirstOrThrow({ where: { orderId: id, state: 'UTWORZONA' } })
    expect(nowa.reference).not.toBe(s.reference)
    expect(zamowien()).toBe(2)
  })
})
