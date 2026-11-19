// zamówienia ręczne i API ogólne, zmiana statusu z listy z powodem, wyszukiwanie klienta fragmentem.
//  1. POST /api/v1/zamowienia z `kanal`: RECZNE z klientem (zaszyfrowany rekord RECZNE, w bazie bez jawnych danych),
//     konto „reczne” zakładane w trybie PRACA, źródło, przewoźnik wprost, koszt wysyłki; powtórka = DUPLIKAT z tym samym
//     id, inna treść = 409; UNPAID = Nowe z terminem, COD = do realizacji; brak kluczy = 422 bez zamówienia; dane klienta
//     poza `klient` = 400; rozjazd sumy = 422; przewoźnik spoza reguł = 422; izolacja firm;
//  2. formularz „Dodaj zamówienie” (zamowienieZFormularza + przyjmijZamowienie): rezerwacja i dalej „Co dalej”
//     (zbieranie) jak zamówienie z kanału; podwójne „Dodaj” = to samo zamówienie;
//  3. „Zmień status”: uprawnienie, powód, bramka trybu PRACA, cofnięcie pomyłki „Wysłane” → „Do wysłania” z wpisem
//     STATUS_RECZNIE, anulowanie zwalnia rezerwację, „Do wyjaśnienia” z powodem, status spoza listy odrzucony;
//  4. wyszukiwanie klienta fragmentem (bez polskich znaków, NIP fragmentem), uprawnienie, jeden wpis w dzienniku.
// Dane wyłącznie fikcyjne (SKU TEST-*, osoby i firmy testowe), bez sieci.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { MemberRole, PrismaClient } from '@prisma/client'
import { createApiKey } from '@/lib/api/zarzadzanie'
import { ALL_API_SCOPES } from '@/lib/api/zakresy'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { daneKlienta, PODGLAD_AUDIT } from '@/lib/klienci/odczyt'
import { szukajKlientaFragmentem } from '@/lib/klienci/szukaj-fragment'
import { opcjeStatusu, STATUS_RECZNIE, stanZmianyStatusu, zmienStatus } from '@/lib/praca/status-dowolny'
import { wykonajPrzejscie } from '@/lib/praca/wykonaj'
import { markShipped, readyForDispatch, startPicking } from '@/lib/rdzen/przejscia'
import { packOrder, shipWithoutInvoice } from '@/lib/rdzen/rozchod'
import { zamowienieZFormularza } from '@/lib/zamowienia/formularz'
import { przyjmijZamowienie } from '@/lib/zamowienia/ogolne'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { expectInvariants, product, seedBase, stockOf } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const K1 = '1'.repeat(64)
const ENV = { CUSTOMER_DATA_KEYS: `1:${K1}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64), EKRANY_PRACA: '1' }
for (const [k, v] of Object.entries(ENV)) process.env[k] = v

const { resetApiLimiters } = await import('@/lib/api/klucze')
const zamowienia = await import('@/app/api/v1/zamowienia/route')

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })

let kubek: string
let przyprawa: string

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v
  await truncateAll()
  for (const db of [a, b]) await seedBase(db)
  // seedBase zakłada konto RECZNE „panel” (cień); zamówienia z panelu prowadzi Kompletor: konto w PRACY
  await a.channelConfig.updateMany({ where: { channel: 'RECZNE' }, data: { statusMode: 'PRACA' } })
  kubek = await product(a, 'TEST-KUBEK', 5, { priceGross: 25 })
  przyprawa = await product(a, 'TEST-PRZYPRAWA', 100, { priceGross: 12.5 })
  await product(b, 'TEST-KUBEK', 5)
  resetApiLimiters()
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const IP = '198.51.100.9'
const token = async (db: PrismaClient = a) => (await createApiKey(db, { name: 'Hurt test', scopes: ALL_API_SCOPES }, 'uzytkownik-testowy')).token
function post(body: unknown, t: string): Promise<Response> {
  const req = new NextRequest('http://localhost:3100/api/v1/zamowienia', {
    method: 'POST',
    headers: { 'x-forwarded-for': IP, authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    duplex: 'half',
  } as never)
  return zamowienia.POST(req)
}

const KLIENT = {
  imieNazwisko: 'Jan Testowy',
  firma: 'Pracownia Testowa sp. z o.o.',
  email: 'jan.testowy@example.invalid',
  telefon: '600 100 200',
  adres: { ulica: 'Testowa', numerDomu: '1', kodPocztowy: '60-001', miasto: 'Poznań' },
  faktura: { nazwa: 'Pracownia Testowa sp. z o.o.', nip: '5260250995', ulica: 'Testowa 1', kodPocztowy: '60-001', miasto: 'Poznań' },
}
const hurt = (over: Record<string, unknown> = {}) => ({
  kanal: 'RECZNE',
  numer: 'BH-TEST-5761',
  zrodlo: 'Hurt HurtDemo',
  zlozono: '2026-11-05T09:00:00Z',
  platnosc: 'PAID',
  platnoscMetoda: 'Przelew',
  dostawa: { sposob: 'Kurier DPD', przewoznik: 'DPD', koszt: 15 },
  klient: KLIENT,
  pozycje: [
    { sku: 'TEST-KUBEK', ilosc: 2, cenaBrutto: 25, vat: '23' },
    { sku: 'TEST-PRZYPRAWA', ilosc: 10, cenaBrutto: 12.5 },
  ],
  ...over,
})

describe('POST /api/v1/zamowienia: kształt ogólny', () => {
  it('RECZNE z klientem: 201, rezerwacja, źródło, przewoźnik, koszt, klient zaszyfrowany; powtórka DUPLIKAT; inna treść 409', async () => {
    const t = await token()
    const r1 = await post(hurt(), t)
    expect(r1.status).toBe(201)
    const b1 = (await r1.json()) as Record<string, unknown>
    expect(b1).toMatchObject({ status: 'DO_REALIZACJI', outcome: 'NOWE', zarezerwowano: 12, brakuje: 0, klient: 'ZAPISANO' })
    const o = await a.order.findUniqueOrThrow({ where: { id: b1.id as string } })
    expect(o).toMatchObject({ channel: 'RECZNE', channelAccountId: 'panel', externalId: 'BH-TEST-5761', sourceLabel: 'Hurt HurtDemo', carrier: 'DPD', deliveryMethod: 'Kurier DPD', paymentState: 'PAID', wantInvoiceNip: true })
    expect(o.totalGross.toFixed(2)).toBe('190.00') // 2×25 + 10×12,50 + 15
    expect(o.shippingCostGross?.toFixed(2)).toBe('15.00')
    expect((await stockOf(a, kubek)).reserved).toBe(2)
    const row = await sys.orderCustomer.findUniqueOrThrow({ where: { orderId: o.id } })
    expect(row.source).toBe('RECZNE')
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('Testowy')
    const d = await daneKlienta(a, o.id, { actorId: 'system:wysylka', zakres: 'PELNY', cel: 'PRZESYLKA', env: ENV })
    expect(d.stan).toBe('PELNY')
    if (d.stan === 'PELNY') expect(d.rekord).toMatchObject({ telefon: '600 100 200', dostawa: { miasto: 'Poznań', kodPocztowy: '60-001' }, faktura: { nip: '5260250995' } })
    const ev = await sys.inboundEvent.findMany({ where: { source: 'api' } })
    expect(JSON.stringify(ev)).not.toContain('Testowy')

    const r2 = await post(hurt(), t)
    expect(r2.status).toBe(200)
    expect(await r2.json()).toMatchObject({ id: o.id, outcome: 'DUPLIKAT', klient: 'BYLY' })
    const r3 = await post(hurt({ pozycje: [{ sku: 'TEST-KUBEK', ilosc: 3, cenaBrutto: 25 }] }), t)
    expect(r3.status).toBe(409)
    expect(await r3.json()).toMatchObject({ pole: 'numer', id: o.id })
    expect((await stockOf(a, kubek)).reserved).toBe(2)
    await expectInvariants(a)
  })

  it('bez konta RECZNE: zakładane „reczne” w trybie PRACA; UNPAID = Nowe z terminem, COD = do realizacji; bez daty i sumy = liczone', async () => {
    await a.channelConfig.deleteMany({ where: { channel: 'RECZNE' } })
    const t = await token()
    const r = await post({ kanal: 'RECZNE', numer: 'R-TEST-1', platnosc: 'UNPAID', dostawa: { sposob: 'Paczkomat InPost' }, pozycje: [{ sku: 'TEST-PRZYPRAWA', ilosc: 1, cenaBrutto: 12.5 }] }, t)
    expect(r.status).toBe(201)
    const body = (await r.json()) as { id: string; status: string; klient: string }
    expect(body).toMatchObject({ status: 'NOWE', klient: 'BRAK' })
    expect(await a.channelConfig.findFirst({ where: { channel: 'RECZNE' } })).toMatchObject({ channelAccountId: 'reczne', statusMode: 'PRACA', active: true })
    const o = await a.order.findUniqueOrThrow({ where: { id: body.id } })
    expect(o).toMatchObject({ carrier: 'PACZKOMATY', paymentMethod: 'Przelew', wantInvoiceNip: false })
    expect(o.reservationDeadline).not.toBeNull()
    expect(o.totalGross.toFixed(2)).toBe('12.50')
    // ta sama treść bez daty po chwili: DUPLIKAT (data poza kluczem)
    const again = await post({ kanal: 'RECZNE', numer: 'R-TEST-1', platnosc: 'UNPAID', dostawa: { sposob: 'Paczkomat InPost' }, pozycje: [{ sku: 'TEST-PRZYPRAWA', ilosc: 1, cenaBrutto: 12.5 }] }, t)
    expect(await again.json()).toMatchObject({ id: body.id, outcome: 'DUPLIKAT' })
    const cod = await post({ kanal: 'RECZNE', numer: 'R-TEST-2', platnosc: 'COD', dostawa: { sposob: 'Kurier DPD' }, pozycje: [{ sku: 'TEST-PRZYPRAWA', ilosc: 1, cenaBrutto: 12.5 }] }, t)
    expect(await cod.json()).toMatchObject({ status: 'DO_REALIZACJI' })
  })

  it('odmowy: brak kluczy 422 bez zamówienia, dane klienta poza `klient` 400, zły NIP 400, rozjazd sumy 422, przewoźnik spoza reguł 422, nieznany kanał 400', async () => {
    const t = await token()
    delete process.env.CUSTOMER_DATA_KEYS
    const bezKlucza = await post(hurt(), t)
    expect(bezKlucza.status).toBe(422)
    expect(await a.order.count()).toBe(0)
    process.env.CUSTOMER_DATA_KEYS = ENV.CUSTOMER_DATA_KEYS
    const poza = await post({ ...hurt(), email: 'x@example.invalid' }, t)
    expect(poza.status).toBe(400)
    expect(((await poza.json()) as { error: string }).error).toMatch(/w obiekcie klient/)
    const nip = await post(hurt({ klient: { ...KLIENT, faktura: { ...KLIENT.faktura, nip: '1234567890' } } }), t)
    expect(nip.status).toBe(400)
    expect(JSON.stringify(await nip.json())).not.toContain('1234567890')
    const suma = await post(hurt({ sumaBrutto: 100 }), t)
    expect(suma.status).toBe(422)
    expect(await suma.json()).toMatchObject({ pole: 'sumaBrutto', policzona: 190 })
    expect((await post(hurt({ sumaBrutto: 190.02 }), t)).status).toBe(201) // zaokrąglenia: pół grosza na sztukę (12 szt. = 6 gr)
    await a.carrierRule.deleteMany({ where: { carrier: 'DPD_EMPIK' } })
    const prz = await post(hurt({ numer: 'BH-TEST-2', dostawa: { sposob: 'salon', przewoznik: 'DPD_EMPIK' } }), t)
    expect(prz.status).toBe(422)
    expect((await post(hurt({ kanal: 'WOO' }), t)).status).toBe(400)
  })

  it('izolacja: klucz firmy B zakłada zamówienie wyłącznie w B, katalog A dla niego nie istnieje', async () => {
    const tb = await token(b)
    const r = await post(hurt({ klient: undefined, pozycje: [{ sku: 'TEST-PRZYPRAWA', ilosc: 1, cenaBrutto: 12.5 }], dostawa: { sposob: 'Kurier DPD' } }), tb)
    expect(r.status).toBe(422) // TEST-PRZYPRAWA jest tylko w A
    const ok = await post(hurt({ klient: undefined, pozycje: [{ sku: 'TEST-KUBEK', ilosc: 1, cenaBrutto: 25 }], dostawa: { sposob: 'Kurier DPD' } }), tb)
    expect(ok.status).toBe(201)
    expect(await a.order.count()).toBe(0)
    expect(await b.order.count()).toBe(1)
  })
})

async function osoba(email: string, role: MemberRole, permissions: string[] = []): Promise<string> {
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: 'test_a', role, permissions })
  return u.id
}

function formularz(pola: Record<string, string | string[]>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(pola)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x)
  return f
}

describe('poprawki z przeglądu', () => {
  it('konto RECZNE w cieniu nie dostaje zamówień: formularz zakłada „reczne” w PRACY i zamówienie idzie przez „Co dalej”; wskazane konto w cieniu = 422', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'RECZNE' }, data: { statusMode: 'CIEN' } })
    const f = formularz({ numer: 'R-20261106-CIEN01', poz_id: [przyprawa], poz_ilosc: ['1'], poz_cena: ['12,50'], platnosc: 'oplacone', przewoznik: 'DPD' })
    const r = await przyjmijZamowienie(a, zamowienieZFormularza(f, ['DPD']), { source: 'panel', actorId: 'user:test', env: ENV, pierwszeKonto: true })
    const o = await a.order.findUniqueOrThrow({ where: { id: r.body.id } })
    expect(o.channelAccountId).toBe('reczne')
    expect(await a.channelConfig.findFirst({ where: { channel: 'RECZNE', channelAccountId: 'reczne' } })).toMatchObject({ statusMode: 'PRACA' })
    const u = await osoba('biuro-w1@example.invalid', 'BIURO')
    expect(await wykonajPrzejscie(a, { orderId: o.id, akcja: 'zbieranie', userId: u, uprawnienia: new Set(['zamowienia.przejscia']) }, ENV)).toEqual({ blad: null, zmiana: true })
    const t = await token()
    const cien = await post({ kanal: 'RECZNE', konto: 'panel', numer: 'R-CIEN-2', platnosc: 'PAID', dostawa: { sposob: 'Kurier DPD' }, pozycje: [{ sku: 'TEST-PRZYPRAWA', ilosc: 1, cenaBrutto: 12.5 }] }, t)
    expect(cien.status).toBe(422)
    expect(((await cien.json()) as { error: string }).error).toMatch(/trybie cienia/)
  })

  it('ta sama treść na dwóch kontach w PRACY = dwa zamówienia (konto w kluczu), bez konta przy dwóch kontach = 422; produkt nieaktywny = 422', async () => {
    await a.channelConfig.create({ data: { channel: 'RECZNE', channelAccountId: 'hurt', name: 'Hurt', adapterKey: 'manual.v1', statusMode: 'PRACA' } })
    const t = await token()
    const tresc = (konto?: string) => ({ kanal: 'RECZNE', ...(konto ? { konto } : {}), numer: 'R-DWA-1', platnosc: 'PAID', dostawa: { sposob: 'Kurier DPD' }, pozycje: [{ sku: 'TEST-PRZYPRAWA', ilosc: 1, cenaBrutto: 12.5 }] })
    const r1 = await post(tresc('panel'), t)
    const r2 = await post(tresc('hurt'), t)
    expect([r1.status, r2.status]).toEqual([201, 201])
    const [b1, b2] = (await Promise.all([r1.json(), r2.json()])) as { id: string }[]
    expect(b1!.id).not.toBe(b2!.id)
    expect((await post(tresc('hurt'), t)).status).toBe(200)
    const bez = await post({ ...tresc(), numer: 'R-DWA-2' }, t)
    expect(bez.status).toBe(422)
    expect(await bez.json()).toMatchObject({ pole: 'konto' })
    await a.product.update({ where: { id: przyprawa }, data: { active: false } })
    const nieakt = await post({ ...tresc('hurt'), numer: 'R-DWA-3' }, t)
    expect(nieakt.status).toBe(422)
    expect(await nieakt.json()).toMatchObject({ nieaktywne: ['TEST-PRZYPRAWA'] })
  })
})

describe('formularz „Dodaj zamówienie”', () => {
  it('rezerwuje, idzie przez „Co dalej” jak zamówienie z kanału; podwójne „Dodaj” = to samo zamówienie', async () => {
    const f = formularz({
      numer: 'R-20261106-ABC123',
      zrodlo: 'Telefon',
      poz_id: [kubek, przyprawa],
      poz_ilosc: ['7', '1'],
      poz_cena: ['25,00', '12,5'],
      platnosc: 'oplacone',
      przewoznik: 'OSOBISTY',
      imie: 'Anna Testowa',
      telefon: '+48 600 200 300',
    })
    const z = zamowienieZFormularza(f, ['DPD', 'PACZKOMATY', 'OSOBISTY'])
    expect(z).toMatchObject({ kanal: 'RECZNE', platnosc: 'PAID', sumaBrutto: 187.5, dostawa: { przewoznik: 'OSOBISTY', sposob: 'OSOBISTY' } })
    const r = await przyjmijZamowienie(a, z, { source: 'panel', actorId: 'user:test', env: ENV })
    expect(r.body).toMatchObject({ outcome: 'NOWE', zarezerwowano: 6, brakuje: 2, klient: 'ZAPISANO' }) // kubków na stanie 5
    const again = await przyjmijZamowienie(a, zamowienieZFormularza(f, ['DPD', 'PACZKOMATY', 'OSOBISTY']), { source: 'panel', actorId: 'user:test', env: ENV })
    expect(again.body).toMatchObject({ id: r.body.id, outcome: 'DUPLIKAT' })
    const u = await osoba('biuro@example.invalid', 'BIURO')
    const w = await wykonajPrzejscie(a, { orderId: r.body.id, akcja: 'zbieranie', userId: u, uprawnienia: new Set(['zamowienia.przejscia']) }, ENV)
    expect(w).toEqual({ blad: null, zmiana: true })
    expect((await a.order.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('ZBIERANIE')
    await expectInvariants(a)
  })

  it('walidacja: paczkomat bez punktu, faktura bez nazwy, zły kod pocztowy, brak produktów', () => {
    const baza = { numer: 'R-20261106-ABC123', poz_id: [kubek], poz_ilosc: ['1'], poz_cena: ['25'], platnosc: 'oplacone' }
    expect(() => zamowienieZFormularza(formularz({ ...baza, przewoznik: 'PACZKOMATY' }), ['PACZKOMATY'])).toThrow(/kod punktu/)
    expect(() => zamowienieZFormularza(formularz({ ...baza, przewoznik: 'DPD', imie: 'Jan', chce_fakture: 'tak' }), ['DPD'])).toThrow(/dane do faktury/)
    expect(() => zamowienieZFormularza(formularz({ ...baza, przewoznik: 'DPD', imie: 'Jan', ulica: 'X', kod: '600', miasto: 'Y' }), ['DPD'])).toThrow(/NN-NNN/)
    expect(() => zamowienieZFormularza(formularz({ numer: baza.numer, platnosc: 'oplacone', przewoznik: 'DPD' }), ['DPD'])).toThrow(/co najmniej jeden produkt/)
    expect(() => zamowienieZFormularza(formularz({ ...baza, przewoznik: 'ALLEGRO' }), ['DPD'])).toThrow(/regułach przewoźników/)
  })
})

describe('„Zmień status” z powodem', () => {
  const PRAWA = new Set(['zamowienia.status_dowolny', 'zamowienia.przejscia'])
  async function wyslane(): Promise<string> {
    const r = await przyjmijZamowienie(a, { kanal: 'RECZNE', numer: 'R-ST-1', zrodlo: null, zlozono: null, platnosc: 'PAID', platnoscMetoda: 'Opłacone', sumaBrutto: 25, dostawa: { sposob: 'Kurier DPD', przewoznik: 'DPD', koszt: null }, chceFakture: false, klient: null, pozycje: [{ produktId: kubek, ilosc: 1, cenaBrutto: 25 }] }, { source: 'api', actorId: 'api:test', env: ENV })
    const id = r.body.id
    await startPicking(a, id)
    await packOrder(a, id)
    await shipWithoutInvoice(a, id)
    if ((await a.order.findUniqueOrThrow({ where: { id } })).status !== 'DO_WYSLANIA') await readyForDispatch(a, id)
    await markShipped(a, id)
    return id
  }

  it('bez uprawnienia, bez powodu, status spoza listy = odmowa; cofnięcie „Wysłane” → „Do wysłania” z wpisem w historii', async () => {
    const id = await wyslane()
    const u = await osoba('wlasciciel@example.invalid', 'WLASCICIEL')
    expect((await zmienStatus(a, { orderId: id, status: 'DO_WYSLANIA', powod: 'pomyłka', userId: u, uprawnienia: new Set(['zamowienia.przejscia']) }, ENV)).blad).toMatch(/uprawnienia/)
    expect((await zmienStatus(a, { orderId: id, status: 'DO_WYSLANIA', powod: ' ', userId: u, uprawnienia: PRAWA }, ENV)).blad).toMatch(/powód/)
    expect((await zmienStatus(a, { orderId: id, status: 'NOWE', powod: 'test', userId: u, uprawnienia: PRAWA }, ENV)).blad).toMatch(/nie da się przejść/)
    expect((await zmienStatus(a, { orderId: id, status: 'DO_WYSLANIA', powod: 'test', userId: u, uprawnienia: PRAWA }, { EKRANY_PRACA: '0', BASELINKER_TOKEN: 'test-bl' })).blad).toMatch(/trybie PRACA/) // firma z BL
    const w = await zmienStatus(a, { orderId: id, status: 'DO_WYSLANIA', powod: 'Kliknięte „Wysłane” za wcześnie', userId: u, uprawnienia: PRAWA }, ENV)
    expect(w).toEqual({ blad: null, zmiana: true })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_WYSLANIA')
    const ev = await a.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: STATUS_RECZNIE } })
    expect(ev).toMatchObject({ actorId: `user:${u}`, data: { z: 'WYSLANE', na: 'DO_WYSLANIA', powod: 'Kliknięte „Wysłane” za wcześnie', cofniecie: true } })
    // reklamacja z tabeli rdzenia i powrót
    await markShipped(a, id)
    expect((await zmienStatus(a, { orderId: id, status: 'REKLAMACJA', powod: 'Klient zgłosił uszkodzenie', userId: u, uprawnienia: PRAWA }, ENV)).zmiana).toBe(true)
    expect((await zmienStatus(a, { orderId: id, status: 'WYSLANE', powod: 'Reklamacja wycofana', userId: u, uprawnienia: PRAWA }, ENV)).zmiana).toBe(true)
    await expectInvariants(a)
  })

  it('cofnięcie „Do wysłania” → „Spakowane” i ponowne „Do wysyłki” bez drugiego rozchodu', async () => {
    const id = await wyslane()
    const u = await osoba('wlasciciel-d9@example.invalid', 'WLASCICIEL')
    expect((await zmienStatus(a, { orderId: id, status: 'DO_WYSLANIA', powod: 'Wysłane za wcześnie', userId: u, uprawnienia: PRAWA }, ENV)).zmiana).toBe(true)
    const fizPrzed = (await stockOf(a, kubek)).physical
    expect((await zmienStatus(a, { orderId: id, status: 'SPAKOWANE', powod: 'Paczka do przepakowania', userId: u, uprawnienia: PRAWA }, ENV)).zmiana).toBe(true)
    expect(await readyForDispatch(a, id)).toBe('DO_WYSLANIA')
    expect((await stockOf(a, kubek)).physical).toBe(fizPrzed)
    expect(await a.reservation.count({ where: { orderId: id, state: { not: 'CONSUMED' } } })).toBe(0)
    await expectInvariants(a)
  })

  it('anulowanie z listy zwalnia rezerwację; „Do wyjaśnienia” z powodem; spakowanie i opłacenie mają własne przyciski', async () => {
    const u = await osoba('wlasciciel@example.invalid', 'WLASCICIEL')
    const r = await przyjmijZamowienie(a, { kanal: 'RECZNE', numer: 'R-ST-2', zrodlo: null, zlozono: null, platnosc: 'UNPAID', platnoscMetoda: 'Przelew', sumaBrutto: 50, dostawa: { sposob: 'Kurier DPD', przewoznik: 'DPD', koszt: null }, chceFakture: false, klient: null, pozycje: [{ produktId: kubek, ilosc: 2, cenaBrutto: 25 }] }, { source: 'api', actorId: 'api:test', env: ENV })
    const id = r.body.id
    const o = await a.order.findUniqueOrThrow({ where: { id } })
    const fakty = { aktywne: 2, wFakturze: 0, wydane: 0, uslugi: 0, otwarteBraki: 0, fakturaWystawiona: false, fakturaWToku: false, poFakturze: false }
    const opcje = opcjeStatusu(o, fakty, PRAWA)
    expect(opcje.find((x) => x.status === 'DO_REALIZACJI')?.powod).toMatch(/Oznacz jako opłacone/)
    expect(opcje.find((x) => x.status === 'ANULOWANE')).toMatchObject({ droga: 'ANULUJ', powod: null })
    expect(opcje.some((x) => x.status === 'WYSLANE')).toBe(false)
    expect((await zmienStatus(a, { orderId: id, status: 'DO_WYJASNIENIA', powod: 'Klient prosi o zmianę adresu', userId: u, uprawnienia: PRAWA }, ENV)).zmiana).toBe(true)
    const ow = await a.order.findUniqueOrThrow({ where: { id } })
    expect(ow.status).toBe('DO_WYJASNIENIA')
    expect(JSON.stringify(ow.flags)).toContain('ręcznie: Klient prosi o zmianę adresu')
    const r2 = await przyjmijZamowienie(a, { kanal: 'RECZNE', numer: 'R-ST-3', zrodlo: null, zlozono: null, platnosc: 'PAID', platnoscMetoda: 'Opłacone', sumaBrutto: 25, dostawa: { sposob: 'Kurier DPD', przewoznik: 'DPD', koszt: null }, chceFakture: false, klient: null, pozycje: [{ produktId: kubek, ilosc: 1, cenaBrutto: 25 }] }, { source: 'api', actorId: 'api:test', env: ENV })
    const przed = (await stockOf(a, kubek)).reserved
    expect((await zmienStatus(a, { orderId: r2.body.id, status: 'ANULOWANE', powod: 'Klient zrezygnował telefonicznie', userId: u, uprawnienia: PRAWA }, ENV)).zmiana).toBe(true)
    expect((await a.order.findUniqueOrThrow({ where: { id: r2.body.id } })).status).toBe('ANULOWANE')
    expect((await stockOf(a, kubek)).reserved).toBe(przed - 1)
    expect(await a.orderEvent.count({ where: { orderId: r2.body.id, kind: STATUS_RECZNIE } })).toBe(1)
    await expectInvariants(a)
  })

  it('lista ze statusami firmy; status firmy z innym etapem idzie drogą rdzenia, z tym samym etapem zmienia tylko nazwę', async () => {
    const id = await wyslane()
    const u = await osoba('wlasciciel-sf@example.invalid', 'WLASCICIEL')
    await a.orderStatusDef.create({ data: { key: 'DO_WYSLANIA_PILNE', name: 'Do wysłania pilnie', color: 'czerwony', sortOrder: 65, baseStatus: 'DO_WYSLANIA', carriers: [] } })
    const opcje = (await stanZmianyStatusu(a, id, PRAWA, ENV))!
    expect(opcje.filter((x) => !x.powod).map((x) => x.wartosc)).toEqual(expect.arrayContaining(['F:DO_WYSLANIA', 'F:DO_WYSLANIA_PILNE']))
    // inny etap (Wysłane → Do wysłania pilnie): cofnięcie rdzenia + przypisanie wprost
    expect(await zmienStatus(a, { orderId: id, status: 'F:DO_WYSLANIA_PILNE', powod: 'Wysłane za wcześnie', userId: u, uprawnienia: PRAWA }, ENV)).toEqual({ blad: null, zmiana: true })
    expect(await a.order.findUniqueOrThrow({ where: { id }, select: { status: true, companyStatus: true } })).toEqual({ status: 'DO_WYSLANIA', companyStatus: 'DO_WYSLANIA_PILNE' })
    // ten sam etap: tylko nazwa, rdzeń stoi; wpis w historii ze statusem firmy
    expect(await zmienStatus(a, { orderId: id, status: 'F:DO_WYSLANIA', powod: 'Już nie pilne', userId: u, uprawnienia: PRAWA }, ENV)).toEqual({ blad: null, zmiana: true })
    expect(await a.order.findUniqueOrThrow({ where: { id }, select: { status: true, companyStatus: true } })).toEqual({ status: 'DO_WYSLANIA', companyStatus: 'DO_WYSLANIA' })
    const ev = await a.orderEvent.findMany({ where: { orderId: id, kind: STATUS_RECZNIE }, orderBy: { createdAt: 'asc' } })
    expect(ev.map((e) => (e.data as { statusFirmy?: string }).statusFirmy)).toEqual(['DO_WYSLANIA_PILNE', 'DO_WYSLANIA'])
    // status firmy, którego nie ma albo ukryty: odmowa
    expect((await zmienStatus(a, { orderId: id, status: 'F:NIE_MA', powod: 'test', userId: u, uprawnienia: PRAWA }, ENV)).blad).toMatch(/już nie ma/)
    // status firmy innego przewoźnika (spreparowany formularz) — odmowa po stronie serwera, nic się nie zmienia
    await a.orderStatusDef.create({ data: { key: 'DO_WYSLANIA_ALLEGRO', name: 'Do wysłania Allegro', color: 'zielony', sortOrder: 66, baseStatus: 'DO_WYSLANIA', carriers: ['ALLEGRO'] } })
    expect((await zmienStatus(a, { orderId: id, status: 'F:DO_WYSLANIA_ALLEGRO', powod: 'test przewoźnika', userId: u, uprawnienia: PRAWA }, ENV)).blad).toMatch(/nie pasuje do przewoźnika/)
    expect(await a.order.findUniqueOrThrow({ where: { id }, select: { companyStatus: true } })).toEqual({ companyStatus: 'DO_WYSLANIA' })
    // rdzeń przenosi dalej sam: przypisanie nieaktualne, nazwa z etapu
    await markShipped(a, id)
    expect(await a.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).toEqual({ status: 'WYSLANE' })
    await expectInvariants(a)
  })
})

describe('wyszukiwanie klienta fragmentem', () => {
  it('nazwa bez polskich znaków, NIP i telefon fragmentem; ten sam klient raz; bez uprawnienia odmowa; jeden wpis w dzienniku', async () => {
    const t = await token()
    await post(hurt(), t)
    await post(hurt({ numer: 'BH-TEST-5762' }), t)
    await post(hurt({ numer: 'BH-TEST-5763', klient: { imieNazwisko: 'Zofia Łącka', telefon: '501 222 333' } }), t)
    const u = await osoba('biuro@example.invalid', 'BIURO')
    const m = await osoba('magazyn@example.invalid', 'MAGAZYN')
    const przed = await a.auditLog.count({ where: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie' } })
    const r = await szukajKlientaFragmentem(a, 'lacka', { actorId: u, env: ENV })
    expect(r.stan).toBe('OK')
    if (r.stan === 'OK') expect(r.klienci.map((k) => k.rekord.nabywca?.imieNazwisko)).toEqual(['Zofia Łącka'])
    const nip = await szukajKlientaFragmentem(a, '0250', { actorId: u, env: ENV })
    expect(nip.stan).toBe('OK')
    if (nip.stan === 'OK') expect(nip.klienci).toHaveLength(1) // dwa zamówienia tego samego klienta = jeden wynik
    const tel = await szukajKlientaFragmentem(a, '222 333', { actorId: u, env: ENV })
    expect(tel.stan).toBe('OK')
    if (tel.stan === 'OK') expect(tel.klienci.map((k) => k.rekord.telefon)).toEqual(['501 222 333'])
    expect(await a.auditLog.count({ where: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie' } })).toBe(przed + 3)
    // wpis mówi, czyje dane pokazano (id zamówień), bez frazy
    const wpisy = await a.auditLog.findMany({ where: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie' }, orderBy: { createdAt: 'asc' } })
    const pierwszy = wpisy.at(-3)!
    expect(pierwszy.after).toMatchObject({ cel: 'WYSZUKIWANIE', trafienia: 1 })
    if (r.stan === 'OK') expect((pierwszy.after as { zamowienia: string[] }).zamowienia).toEqual(r.klienci.map((k) => k.orderId))
    expect(JSON.stringify(wpisy)).not.toMatch(/lacka|222 333|0250/)
    expect((await szukajKlientaFragmentem(a, 'lacka', { actorId: m, env: ENV })).stan).toBe('BEZ_UPRAWNIEN')
    expect((await szukajKlientaFragmentem(a, 'ab', { actorId: u, env: ENV })).stan).toBe('ZA_KROTKA')
  })
})
