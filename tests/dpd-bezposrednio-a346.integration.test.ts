// nadawanie DPD bezpośrednio przez host przesyłek (`lib/wysylka/nadanie.ts`, przycisk „Utwórz przesyłkę” na
// karcie i na stanowisku pakowania) na atrapie DPDServices: punkt DPD Pickup, salon Empik (FID konta Empik na koncie
// głównym albo drugie konto „Salony Empik” z własnymi kluczami), pobranie, odmowa DPD, przerwane połączenie (timeout =
// niejednoznaczna bez drugiej paczki), konto z panelu bez adresu API (środowisko). Dane fikcyjne, zero połączeń z DPD.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { bramkaNadania, POWOD_DO_POTWIERDZENIA, utworzPrzesylke, type DepsNadania } from '@/lib/wysylka/nadanie'
import { ostrzezeniaDoPotwierdzenia, podgladPrzesylki, prepareForOrder, PUNKT_DANE_NIEODCZYTANE, PUNKT_DANE_USUNIETE, PUNKT_PRZY_NADANIU } from '@/lib/wysylka/podglad'
import { DPD_PRODUKCJA } from '@/lib/adaptery/dpd'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, DPD_WAYBILL, dpdAtrapa, json } from './dpd-atrapa'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const NAZWISKO = 'Ewa Fikcyjna'
const ULICA = 'ul. Atrapowa'
const TELEFON = '+48 511 000 111'
const EMAIL = 'ewa@example.test'
const SALON = 'PL49999'
const PUNKT = 'PL11999'
const FID_EMPIK = '7777'
const LOGIN_EMPIK = 'login-api-salony'
const HASLO_EMPIK = 'haslo-salony-testowe'
const NADAWCA = { name: 'Firma Testowa', fullName: 'Firma Testowa sp. z o.o.', address: 'ul. Magazynowa 5', city: 'Testowo', postalCode: '00-002', phone: '500000000', email: 'magazyn@example.invalid' }

const DOSTAWA = { imieNazwisko: NAZWISKO, firma: null, ulica: ULICA, numerDomu: '9', numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL', telefon: TELEFON, email: EMAIL }
const zPunktem = (kod: string | null): OrderRecipient => ({ dostawa: DOSTAWA, punktOdbioru: kod ? { kod, nazwa: null } : null, faktura: null, problemy: [] })

const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64), DPD_LOGIN, DPD_PASSWORD, DPD_LOGIN_EMPIK: LOGIN_EMPIK, DPD_PASSWORD_EMPIK: HASLO_EMPIK }
const USTAWIENIA = { payerFid: DPD_FID, zapisWlaczony: true, defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 }
const POTWIERDZONE = ['waga_domyslna', 'gabaryt_podpowiedz']

let atrapa: ReturnType<typeof dpdAtrapa>
const deps = (): DepsNadania => ({ fetch: atrapa.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
const numery = () => atrapa.calls.filter((c) => c.path.endsWith('/generatePackagesNumbers'))
type Paczka = { reference: string; payerFID: number; services?: { code: string; attributes?: { code: string; value: string }[] }[]; receiver?: Record<string, unknown>; pudoReceiver?: Record<string, unknown> }
const paczka = (i = 0) => (numery()[i]!.body as { packages: Paczka[] }).packages[0]!
const usluga = (p: Paczka, code: string) => p.services?.find((s) => s.code === code)

/** Reguły DPD i salonu Empik na module DPD z zapisem; konto sklepu w PRACA; nadawca firmy. */
async function firma(o: { dpd?: Record<string, unknown>; empik?: Record<string, unknown> } = {}): Promise<void> {
  await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: { baseUrl: DPD_DEMO, ...USTAWIENIA, ...o.dpd } } })
  await db.carrierRule.updateMany({ where: { carrier: 'DPD_EMPIK' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: { baseUrl: DPD_DEMO, ...USTAWIENIA, ...o.empik } } })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA } } })
}

async function zamowienie(deliveryMethod: string, punkt: string | null, platnosc: { paymentState?: 'PAID' | 'COD'; paymentMethod?: string } = {}): Promise<string> {
  const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod, paymentState: platnosc.paymentState ?? 'PAID', paymentMethod: platnosc.paymentMethod ?? 'Przelew', totalGross: 30 }), { now: T0 })
  await zapiszRekordKlienta(db, r.orderId!, rekordZOdbiorcy(zPunktem(punkt)), { source: 'RECZNE', fetchedAt: T0, env: ENV })
  return r.orderId!
}

const utworz = (orderId: string, potwierdzone: string[] = POTWIERDZONE) => utworzPrzesylke(db, { orderId, potwierdzoneOstrzezenia: potwierdzone, userId: 'u-test' }, deps())
const odpowiedzSzukania = (packages: unknown[]) => json({ status: 'OK', documentData: Buffer.from('%PDF-x').toString('base64'), session: { packages } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  atrapa = dpdAtrapa()
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('punkt DPD Pickup', () => {
  it('kurier DPD z kodem punktu w danych klienta: usługa DPD_PICKUP z PUDO, odbiorca punktu, numer listu i etykieta', async () => {
    await firma()
    const id = await zamowienie('Kurier DPD', PUNKT)
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA' })
    const p = paczka()
    expect(usluga(p, 'DPD_PICKUP')).toEqual({ code: 'DPD_PICKUP', attributes: [{ code: 'PUDO', value: PUNKT }] })
    expect(p.pudoReceiver).toMatchObject({ name: NAZWISKO, countryCode: 'PL' })
    expect(p.payerFID).toBe(Number(DPD_FID))
    expect(await db.shipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'UTWORZONA', trackingNumber: DPD_WAYBILL, carrier: 'DPD' })
  })

  it('bez kodu punktu: zwykły kurier, bez DPD_PICKUP', async () => {
    await firma()
    const id = await zamowienie('Kurier DPD', null)
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA' })
    expect(usluga(paczka(), 'DPD_PICKUP')).toBeUndefined()
    expect(paczka().receiver).toMatchObject({ name: NAZWISKO, city: 'Poznań' })
  })
})

describe('salon Empik', () => {
  it('konto główne z FID Empik: salon bez osobnego potwierdzenia, PUDO = kod salonu i FID Empik', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK } })
    const id = await zamowienie('Dostawa do Salonu Empik', SALON)
    expect((await bramkaNadania(db, id, deps()))!.powod).toBeNull()
    // ostrzeżenie `empik_niepotwierdzone` zdjęte; waga domyślna z ustawień firmy (1 kg) też bez potwierdzania
    expect(await utworz(id, ['gabaryt_podpowiedz'])).toMatchObject({ wynik: 'UTWORZONA' })
    const p = paczka()
    expect(usluga(p, 'DPD_PICKUP')).toEqual({ code: 'DPD_PICKUP', attributes: [{ code: 'PUDO', value: SALON }] })
    expect(p.payerFID).toBe(Number(FID_EMPIK))
    // logowanie i nagłówek konta głównego (FID płatnika to jedyna różnica)
    expect(numery()[0]!.headers['Authorization']).toBe(`Basic ${Buffer.from(`${DPD_LOGIN}:${DPD_PASSWORD}`).toString('base64')}`)
    expect(await db.shipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'UTWORZONA', carrier: 'DPD_EMPIK', accountSuffix: null })
  })

  it('drugie konto „Salony Empik” (sekretyKonta EMPIK): klucze tego konta, jego FID w nagłówku i jako płatnik', async () => {
    await firma({ empik: { sekretyKonta: 'EMPIK', payerFid: FID_EMPIK } })
    const id = await zamowienie('Dostawa do Salonu Empik', SALON)
    expect(await utworz(id, POTWIERDZONE)).toMatchObject({ wynik: 'UTWORZONA' })
    const c = numery()[0]!
    expect(c.headers['Authorization']).toBe(`Basic ${Buffer.from(`${LOGIN_EMPIK}:${HASLO_EMPIK}`).toString('base64')}`)
    expect(c.headers['x-dpd-fid']).toBe(FID_EMPIK)
    expect(paczka().payerFID).toBe(Number(FID_EMPIK))
    expect(await db.shipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'UTWORZONA', accountSuffix: 'EMPIK' })
    // zwykła paczka DPD dalej z konta głównego
    const kurier = await zamowienie('Kurier DPD', null)
    expect(await utworz(kurier)).toMatchObject({ wynik: 'UTWORZONA' })
    expect(numery()[1]!.headers['Authorization']).toBe(`Basic ${Buffer.from(`${DPD_LOGIN}:${DPD_PASSWORD}`).toString('base64')}`)
    expect(paczka(1).payerFID).toBe(Number(DPD_FID))
  })

  it('brak kodu salonu: odmowa z powodem, bez żądania do DPD', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK } })
    const id = await zamowienie('Dostawa do Salonu Empik', null)
    expect(await utworz(id, POTWIERDZONE)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('Brak kodu salonu Empik') })
    expect(atrapa.calls).toEqual([])
  })

  it('podgląd salonu bierze kod z zapisanych danych klienta: bez fałszywego „Brak kodu salonu”, bez ostrzeżeń do potwierdzenia', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK, defaultWeightKg: 5 } })
    const id = await zamowienie('Dostawa do Salonu Empik', SALON)
    const w = await prepareForOrder(db, id, 'DPD')
    expect(w).toMatchObject({ wynik: 'przygotowane', parcel: { courierCode: 'DPD_PICKUP', pickupPoint: SALON, weightKg: 5 } })
    const r = await podgladPrzesylki(db, id)
    expect(r!.zapisana!.problemy.map((p) => `${p.poziom}:${p.kod}`)).toEqual(['INFO:waga_domyslna'])
    expect(r!.zapisana!.problemy[0]!.tekst).toBe('Paczka pójdzie z wagą 5 kg z ustawień przewoźnika (produkty nie mają wpisanej wagi). Zmienisz ją w: Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników.')
    expect(r!.zapisana).toMatchObject({ wagaKg: 5, wagaRobocza: false, wagaZUstawien: true })
    expect(await ostrzezeniaDoPotwierdzenia(db, id)).toEqual([])
    // kod punktu nie trafia do wiersza podglądu (tylko liczenie w pamięci); odczyt zostawia ślad automatu przesyłki
    expect(JSON.stringify(await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } }))).not.toContain(SALON)
    expect(await db.auditLog.count({ where: { entity: 'KLIENT_PODGLAD', entityId: id, actorId: 'system:wysylka' } })).toBe(1)
    // nadanie jednym kliknięciem z gabarytem (bez potwierdzeń), waga do DPD bez zmian
    expect(await utworzPrzesylke(db, { orderId: id, gabaryt: 'DPD', potwierdzoneOstrzezenia: [], userId: 'u-test' }, deps())).toMatchObject({ wynik: 'UTWORZONA' })
    expect((numery()[0]!.body as { packages: { parcels: { weight: number }[] }[] }).packages[0]!.parcels[0]!.weight).toBe(5)
  })

  it('podgląd bez danych klienta w bazie = informacja „punkt sprawdzi nadanie”, nie błąd; nadanie dalej odmawia bez danych', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK } })
    const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
    const id = (await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Dostawa do Salonu Empik', paymentState: 'PAID', paymentMethod: 'Przelew', totalGross: 30 }), { now: T0 })).orderId!
    const w = await prepareForOrder(db, id, 'DPD')
    expect(w.wynik === 'przygotowane' && w.parcel.problems.map((p) => `${p.poziom}:${p.kod}`)).toEqual(['INFO:punkt_przy_nadaniu', 'INFO:waga_domyslna'])
    expect(w.wynik === 'przygotowane' && w.parcel.problems[0]!.tekst).toBe(PUNKT_PRZY_NADANIU)
    expect(await utworz(id)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('Brak danych odbiorcy') })
    expect(atrapa.calls).toEqual([])
  })

  it('dane klienta bez kodu salonu = podgląd i nadanie mówią to samo (BLAD punkt)', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK } })
    const id = await zamowienie('Dostawa do Salonu Empik', null)
    const w = await prepareForOrder(db, id, 'DPD')
    expect(w.wynik === 'przygotowane' && w.parcel.problems.filter((p) => p.poziom === 'BLAD').map((p) => p.tekst)).toEqual(['Brak kodu salonu Empik w danych zamówienia.'])
    expect(await utworz(id)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('Brak kodu salonu Empik') })
  })

  it('waga wbudowana (firma nie ustawiła): ostrzeżenie do potwierdzenia z podglądu, nadanie bez potwierdzenia odmawia bez żądania', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK, defaultWeightKg: null } })
    const id = await zamowienie('Dostawa do Salonu Empik', SALON)
    await prepareForOrder(db, id, 'DPD')
    expect(await ostrzezeniaDoPotwierdzenia(db, id)).toEqual([{ kod: 'waga_domyslna', tekst: expect.stringContaining('firma nie ustawiła wagi domyślnej') }])
    expect(await utworzPrzesylke(db, { orderId: id, gabaryt: 'DPD', potwierdzoneOstrzezenia: [], userId: 'u-test' }, deps())).toMatchObject({ wynik: 'ODMOWA', powod: POWOD_DO_POTWIERDZENIA, doPotwierdzenia: [expect.objectContaining({ kod: 'waga_domyslna' })] })
    expect(atrapa.calls).toEqual([])
    expect(await utworzPrzesylke(db, { orderId: id, gabaryt: 'DPD', potwierdzoneOstrzezenia: ['waga_domyslna'], userId: 'u-test' }, deps())).toMatchObject({ wynik: 'UTWORZONA' })
  })

  it('podgląd nieaktualny = bez pól do zaznaczenia; potwierdzenie starego tekstu = odmowa bez żądania z nowym tekstem; zgodny tekst = utworzona', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK, defaultWeightKg: null } })
    const id = await zamowienie('Dostawa do Salonu Empik', SALON)
    await prepareForOrder(db, id, 'DPD')
    const [waga] = await ostrzezeniaDoPotwierdzenia(db, id)
    expect(waga).toMatchObject({ kod: 'waga_domyslna', tekst: expect.stringContaining('1 kg') })
    // zamówienie zmieniło się po policzeniu: podgląd już nie podsuwa tekstów do zaznaczenia
    await db.preparedShipment.updateMany({ where: { orderId: id }, data: { createdAt: new Date(0) } })
    expect(await ostrzezeniaDoPotwierdzenia(db, id)).toEqual([])
    const stary = { waga_domyslna: waga!.tekst.replace('1 kg', '3 kg') }
    expect(await utworzPrzesylke(db, { orderId: id, gabaryt: 'DPD', potwierdzoneOstrzezenia: ['waga_domyslna'], potwierdzoneTeksty: stary, userId: 'u-test' }, deps())).toMatchObject({
      wynik: 'ODMOWA',
      powod: POWOD_DO_POTWIERDZENIA,
      doPotwierdzenia: [{ kod: 'waga_domyslna', tekst: waga!.tekst }],
    })
    expect(atrapa.calls).toEqual([])
    // kod bez tekstu, gdy panel podaje teksty, też się nie liczy
    expect(await utworzPrzesylke(db, { orderId: id, gabaryt: 'DPD', potwierdzoneOstrzezenia: ['waga_domyslna'], potwierdzoneTeksty: {}, userId: 'u-test' }, deps())).toMatchObject({ wynik: 'ODMOWA', powod: POWOD_DO_POTWIERDZENIA })
    expect(atrapa.calls).toEqual([])
    expect(await utworzPrzesylke(db, { orderId: id, gabaryt: 'DPD', potwierdzoneOstrzezenia: ['waga_domyslna'], potwierdzoneTeksty: { waga_domyslna: waga!.tekst }, userId: 'u-test' }, deps())).toMatchObject({ wynik: 'UTWORZONA' })
  })

  it('dane klienta usunięte po okresie przechowywania albo nieodczytane (brak klucza) = osobny, prawdziwy tekst; bez danych w tekście', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK } })
    const usuniete = await zamowienie('Dostawa do Salonu Empik', SALON)
    await db.orderCustomer.update({ where: { orderId: usuniete }, data: { purgedAt: T0 } })
    const u = await prepareForOrder(db, usuniete, 'DPD')
    expect(u.wynik === 'przygotowane' && u.parcel.problems.filter((p) => p.kod === 'punkt_przy_nadaniu')).toEqual([{ kod: 'punkt_przy_nadaniu', poziom: 'INFO', tekst: PUNKT_DANE_USUNIETE }])
    const bezKlucza = await zamowienie('Dostawa do Salonu Empik', SALON)
    vi.stubEnv('CUSTOMER_DATA_KEYS', '')
    const k = await prepareForOrder(db, bezKlucza, 'DPD')
    expect(k.wynik === 'przygotowane' && k.parcel.problems.filter((p) => p.kod === 'punkt_przy_nadaniu')).toEqual([{ kod: 'punkt_przy_nadaniu', poziom: 'INFO', tekst: PUNKT_DANE_NIEODCZYTANE }])
    expect(JSON.stringify([u, k])).not.toContain(SALON)
  })

  it('DPD odrzuca salon (INCORRECT_PUDO): BLAD z kodem błędu, bez danych klienta, ponowienie tą samą referencją', async () => {
    await firma({ empik: { empikPayerFid: FID_EMPIK } })
    const id = await zamowienie('Dostawa do Salonu Empik', SALON)
    atrapa = dpdAtrapa([json({ status: 'INCORRECT_DATA', packages: [{ status: 'INCORRECT_DATA', validationDetails: [{ errorCode: 'INCORRECT_PUDO', info: NAZWISKO }] }] })])
    const w = await utworz(id, POTWIERDZONE)
    expect(w).toMatchObject({ wynik: 'BLAD', powod: expect.stringContaining('INCORRECT_PUDO') })
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s).toMatchObject({ state: 'BLAD', failureKind: 'TRWALY' })
    expect(JSON.stringify(s)).not.toContain(NAZWISKO)
    atrapa = dpdAtrapa()
    expect(await utworz(id, POTWIERDZONE)).toMatchObject({ wynik: 'UTWORZONA' })
    expect(paczka().reference).toBe(s.reference)
  })
})

describe('pobranie', () => {
  it('zamówienie za pobraniem: usługa COD z kwotą zamówienia w PLN', async () => {
    await firma()
    const id = await zamowienie('Kurier DPD', null, { paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA' })
    expect(usluga(paczka(), 'COD')).toEqual({ code: 'COD', attributes: [{ code: 'AMOUNT', value: '30.00' }, { code: 'CURRENCY', value: 'PLN' }] })
    expect(Number((await db.shipment.findFirstOrThrow({ where: { orderId: id } })).codAmount)).toBe(30)
  })

  it('pobranie do punktu: DPD_PICKUP i COD w jednej paczce', async () => {
    await firma()
    const id = await zamowienie('Kurier DPD', PUNKT, { paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA' })
    expect(paczka().services!.map((s) => s.code).sort()).toEqual(['COD', 'DPD_PICKUP'])
  })
})

describe('przerwane połączenie (timeout)', () => {
  it('przerwanie po wysłaniu: NIEJEDNOZNACZNA z alertem, bez drugiej paczki przy kolejnych kliknięciach', async () => {
    await firma()
    const id = await zamowienie('Kurier DPD', null)
    const przerwane = new DOMException('The operation was aborted.', 'AbortError')
    atrapa = dpdAtrapa([{ error: przerwane }, odpowiedzSzukania([])])
    expect(await utworz(id)).toMatchObject({ wynik: 'NIEJEDNOZNACZNA' })
    expect(numery()).toHaveLength(1)
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', closedAt: null } })).toBe(1)
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s.state).toBe('NIEJEDNOZNACZNA')
    expect(s.lastError).toMatch(/po referencji/)
    for (let i = 0; i < 2; i++) expect((await utworz(id)).wynik).toBe('NIEJEDNOZNACZNA')
    expect(numery()).toHaveLength(1)
    expect(await db.shipment.count({ where: { orderId: id } })).toBe(1)
  })
})

describe('konto DPD wpisane w panelu (bez adresu API)', () => {
  it('środowisko produkcja bez baseUrl: żądanie na adres produkcyjny DPD', async () => {
    await firma()
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { config: { ...USTAWIENIA, srodowisko: 'produkcja' } } })
    const id = await zamowienie('Kurier DPD', null)
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA' })
    expect(numery()[0]!.url).toBe(`${DPD_PRODUKCJA}/public/shipment/v1/generatePackagesNumbers`)
  })

  it('bez środowiska i bez baseUrl: demo (pomyłka w ustawieniach nie tworzy prawdziwej paczki)', async () => {
    await firma()
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { config: USTAWIENIA } })
    const id = await zamowienie('Kurier DPD', null)
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA' })
    expect(numery()[0]!.url.startsWith(DPD_DEMO)).toBe(true)
  })
})
