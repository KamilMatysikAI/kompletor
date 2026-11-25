// API Kompletora dla systemów zewnętrznych (hurt-demo, EasyTools, BotKlienta).
//  1. klucze: w bazie tylko SHA-256, pełny klucz raz; brak, zły, odwołany klucz i firma nieaktywna = ten sam 401;
//     brak zakresu = 403; limit 120/min na klucz i nieudane próby per IP = 429 z Retry-After
//     (tylko dla żądań bez ważnego klucza); lastUsedAt raz na 5 min;
//  2. izolacja dwóch firm na każdym endpoincie (ten sam SKU i ten sam numer zamówienia w obu firmach);
//  3. GET /stany: STOCKED, zestaw (minimum składników), DIGITAL bez liczb, dostępne nigdy < 0, strony po ofertach konta;
//  4. GET /zamowienia: wyłącznie pola z listy (bez flags, cancelReason, treści zdarzeń), numer nadania z ostatniego
//     zdarzenia, numer sklepu albo BL, kilka kont, kursor stabilny przy równych updatedAt, okno 14 dni;
//  5. POST /zamowienia: nowe 201, powtórka 200 DUPLIKAT z tym samym id, ten sam numer z inną treścią 409 bez zmian,
//     dostawa bez reguły = DO_WYJASNIENIA, nieznany SKU / DIGITAL 422, pole adresowe
//     i nieznane pole 400, za duża treść 413, rezerwacja powstaje i dostępne w /stany spada;
//  6. rdzeń: EASYTOOLS tylko z produktem z katalogu; konto EasyTools ACME poza cieniem (withoutAdapter = 0).
// Dane wyłącznie fikcyjne (SKU TEST-*, numery ET-TEST-*), bez sieci.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { PrismaClient } from '@prisma/client'
import { createApiKey, listApiKeys, revokeApiKey } from '@/lib/api/zarzadzanie'
import { ALL_API_SCOPES, type ApiScope } from '@/lib/api/zakresy'
import { LINE_FIELDS, MAX_SHIPMENTS, ORDER_FIELDS, SHIPMENT_FIELDS } from '@/lib/api/zamowienia'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY } from '@/lib/adaptery/allegro-wysylam-zapis'
import { INPOST_SHIPX_ZAPIS_KEY } from '@/lib/adaptery/inpost-zapis'
import { zapiszAutomatyWysylki, zapiszSledzeniePrzewoznikow } from '@/lib/wysylka/automaty'
import { tokenHash } from '@/lib/auth/sesje'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { accountsForComparison, planOrderPolls } from '@/lib/cien/harmonogram'
import { loadShadowReading } from '@/lib/cien/stan-odczytu'
import { applyOrgPreset } from '@/lib/organizacje'
import { ingestOrder, ValidationError } from '@/lib/rdzen/zamowienia'
import { ACME_PRESET } from '@/tests/preset-testowy'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { bundle, expectInvariants, order, product, seedBase, stockOf } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
// trasy biorą klientów z lib/db (systemPrisma / prismaForOrg) — łączą się z bazą testów
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const { requireApiKey, resetApiLimiters, REQUESTS_PER_MINUTE, FAILED_PER_IP } = await import('@/lib/api/klucze')
const stany = await import('@/app/api/v1/stany/route')
const zamowienia = await import('@/app/api/v1/zamowienia/route')
const zamowienie = await import('@/app/api/v1/zamowienia/[numer]/route')

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) {
    await seedBase(db)
    await db.channelConfig.create({ data: { channel: 'EASYTOOLS', channelAccountId: 'et', name: 'EasyTools test', adapterKey: 'easytools.v1' } })
  }
  resetApiLimiters()
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const IP = '198.51.100.7' // adres z puli dokumentacyjnej
const key = async (db: PrismaClient, scopes: ApiScope[] = ALL_API_SCOPES, name = 'Klucz testowy') => (await createApiKey(db, { name, scopes }, 'uzytkownik-testowy')).token

function req(p: string, token?: string | null, init: { method?: string; body?: BodyInit; headers?: Record<string, string>; ip?: string } = {}): NextRequest {
  const headers: Record<string, string> = { 'x-forwarded-for': init.ip ?? IP, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
  return new NextRequest(`http://localhost:3100${p}`, { method: init.method ?? 'GET', headers, body: init.body, ...(init.body ? { duplex: 'half' } : {}) } as never)
}
const getStany = (q: string, token?: string | null) => stany.GET(req(`/api/v1/stany${q}`, token))
const getLista = (q: string, token?: string | null) => zamowienia.GET(req(`/api/v1/zamowienia${q}`, token))
const getNumer = (numer: string, token?: string | null, q = '') => zamowienie.GET(req(`/api/v1/zamowienia/${encodeURIComponent(numer)}${q}`, token), { params: Promise.resolve({ numer }) })
const post = (body: unknown, token?: string | null, headers: Record<string, string> = {}) =>
  zamowienia.POST(req('/api/v1/zamowienia', token, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }))

const etOrder = (over: Record<string, unknown> = {}) => ({
  numer: 'ET-TEST-1001',
  zlozono: '2026-11-02T09:00:00Z',
  platnosc: 'PAID',
  platnoscMetoda: 'Przelewy24',
  sumaBrutto: 59.9,
  sposobDostawy: 'Paczkomat InPost',
  chceFakture: false,
  pozycje: [{ sku: 'TEST-ZESTAW-START', ilosc: 1, cenaBrutto: 59.9, vat: '23' }],
  ...over,
})

describe('klucze API: uwierzytelnianie, zakresy, limity', () => {
  it('w bazie tylko SHA-256 i prefiks; AuditLog bez klucza; lista firmy pokazuje sam początek', async () => {
    const r = await createApiKey(a, { name: '  BotKlienta  test ', scopes: ['zamowienia:odczyt'] }, 'uzytkownik-testowy')
    expect(r.token).toMatch(/^kmp_[A-Za-z0-9_-]{43}$/)
    const row = await sys.apiKey.findUniqueOrThrow({ where: { id: r.id } })
    expect(row).toMatchObject({ organizationId: ORG_A, name: 'BotKlienta test', prefix: r.token.slice(0, 12), tokenHash: tokenHash(r.token), scopes: ['zamowienia:odczyt'], createdBy: 'uzytkownik-testowy' })
    const secret = r.token.slice(12)
    expect(JSON.stringify(row)).not.toContain(secret)
    const audit = await a.auditLog.findMany({ where: { entity: 'ApiKey' } })
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain(secret)
    expect(await listApiKeys(b)).toEqual([])
    expect((await listApiKeys(a)).map((k) => k.prefix)).toEqual([r.token.slice(0, 12)])
    await expect(createApiKey(a, { name: '', scopes: ['stany:odczyt'] }, 'x')).rejects.toThrow(/nazwę/)
    await expect(createApiKey(a, { name: 'x', scopes: [] }, 'x')).rejects.toThrow(/zakres/)
    await expect(createApiKey(a, { name: 'x', scopes: ['wszystko'] }, 'x')).rejects.toThrow(/Nieznany zakres/)
  })

  it('brak klucza, zły format, nieznany, odwołany i firma nieaktywna: ten sam 401 JSON', async () => {
    const ok = await key(a)
    const revoked = await createApiKey(a, { name: 'stary', scopes: ALL_API_SCOPES }, 'u')
    await revokeApiKey(a, revoked.id, 'u')
    const inactive = await key(b)
    await sys.organization.update({ where: { id: ORG_B }, data: { active: false } })
    const bodies = new Set<string>()
    for (const t of [null, 'kmp_krotki', 'zly', `kmp_${'A'.repeat(43)}`, revoked.token, inactive]) {
      const r = await getStany('?sku=TEST-A', t)
      expect(r.status, String(t)).toBe(401)
      expect(r.headers.get('content-type')).toMatch(/json/)
      expect(r.headers.get('cache-control')).toBe('no-store')
      bodies.add(await r.text())
    }
    expect(bodies.size).toBe(1)
    // Basic zamiast Bearer też 401 (hasło panelu nie jest kluczem)
    const basic = await stany.GET(req('/api/v1/stany?sku=TEST-A', null, { headers: { authorization: 'Basic ' + Buffer.from('kompletor:tajne').toString('base64') } }))
    expect(basic.status).toBe(401)
    expect((await getStany('?sku=TEST-A', ok)).status).toBe(200)
  })

  it('zakresy: brak zakresu = 403 na każdym endpoincie', async () => {
    const tylkoStany = await key(a, ['stany:odczyt'])
    const tylkoOdczyt = await key(a, ['zamowienia:odczyt'])
    expect((await getStany('?sku=TEST-A', tylkoOdczyt)).status).toBe(403)
    expect((await getLista('', tylkoStany)).status).toBe(403)
    expect((await getNumer('1', tylkoStany)).status).toBe(403)
    const r = await post(etOrder(), tylkoOdczyt)
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'Klucz nie ma zakresu zamowienia:zapis' })
    expect((await getLista('', tylkoOdczyt)).status).toBe(200)
  })

  it(`limit ${REQUESTS_PER_MINUTE} żądań na minutę na klucz: potem 429 z Retry-After`, async () => {
    const t = await key(a, ['stany:odczyt'])
    const r0 = req('/api/v1/stany?sku=X', t)
    let now = Date.now()
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) expect(await requireApiKey(r0, 'stany:odczyt', { now: () => now })).not.toBeInstanceOf(Response)
    const over = await requireApiKey(r0, 'stany:odczyt', { now: () => now })
    expect(over).toBeInstanceOf(Response)
    expect((over as Response).status).toBe(429)
    expect(Number((over as Response).headers.get('retry-after'))).toBeGreaterThan(0)
    // inny klucz tej samej firmy ma własny licznik
    expect(await requireApiKey(req('/api/v1/stany', await key(a, ['stany:odczyt'])), 'stany:odczyt', { now: () => now })).not.toBeInstanceOf(Response)
    now += 61_000
    expect(await requireApiKey(r0, 'stany:odczyt', { now: () => now })).not.toBeInstanceOf(Response)
  })

  it(`nieudane próby: po ${FAILED_PER_IP} z jednego IP zły klucz 429, dobry klucz z tego IP dalej 200, inne IP bez zmian`, async () => {
    const good = await key(a, ['stany:odczyt'])
    for (let i = 0; i < FAILED_PER_IP; i++) expect((await getStany('?sku=X', `kmp_${'B'.repeat(43)}`)).status).toBe(401)
    const blocked = await getStany('?sku=X', `kmp_${'B'.repeat(43)}`)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
    expect((await getStany('?sku=X', good)).status).toBe(200)
    expect((await stany.GET(req('/api/v1/stany?sku=X', good, { ip: '203.0.113.9' }))).status).toBe(200)
  })

  it('lastUsedAt: podbite przy pierwszym użyciu, potem najwyżej raz na 5 min', async () => {
    const k = await createApiKey(a, { name: 'x', scopes: ['stany:odczyt'] }, 'u')
    const at = (ms: number) => requireApiKey(req('/api/v1/stany', k.token), 'stany:odczyt', { now: () => ms })
    const t0 = Date.UTC(2026, 10, 2, 9, 0, 0)
    await at(t0)
    expect((await a.apiKey.findUniqueOrThrow({ where: { id: k.id } })).lastUsedAt?.getTime()).toBe(t0)
    await at(t0 + 60_000)
    expect((await a.apiKey.findUniqueOrThrow({ where: { id: k.id } })).lastUsedAt?.getTime()).toBe(t0)
    await at(t0 + 5 * 60_000 + 1)
    expect((await a.apiKey.findUniqueOrThrow({ where: { id: k.id } })).lastUsedAt?.getTime()).toBe(t0 + 5 * 60_000 + 1)
  })

  it('odwołanie: od razu 401; klucza innej firmy nie da się odwołać (RLS)', async () => {
    const k = await createApiKey(a, { name: 'x', scopes: ['stany:odczyt'] }, 'u')
    expect((await getStany('?sku=X', k.token)).status).toBe(200)
    await expect(revokeApiKey(b, k.id, 'obcy')).rejects.toThrow(/Nie znaleziono/)
    expect((await getStany('?sku=X', k.token)).status).toBe(200)
    expect(await revokeApiKey(a, k.id, 'u')).toBe(true)
    expect(await revokeApiKey(a, k.id, 'u')).toBe(false)
    expect((await getStany('?sku=X', k.token)).status).toBe(401)
  })
})

describe('GET /api/v1/stany', () => {
  it('STOCKED, zestaw (minimum składników), DIGITAL bez liczb, dostępne nigdy poniżej 0, oferty', async () => {
    const przyprawa = await product(a, 'TEST-PRZYPRAWA', 10)
    const kubek = await product(a, 'TEST-KUBEK', 3)
    const minus = await product(a, 'TEST-MINUS', 2)
    await a.stock.update({ where: { productId_warehouseId: { productId: minus, warehouseId: 'glowny' } }, data: { reserved: 5 } })
    await bundle(a, 'TEST-ZESTAW', [
      { id: przyprawa, qty: 2 },
      { id: kubek, qty: 1 },
    ])
    await a.product.create({ data: { sku: 'TEST-EBOOK', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book testowy', title: 'E-book testowy' } })
    await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'lampy', externalId: '501', productId: przyprawa, qtyBasePerOffer: 2 } })
    await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'sd', externalId: '777', productId: przyprawa, active: false } })
    const t = await key(a, ['stany:odczyt'])
    const r = await getStany('?sku=TEST-ZESTAW,TEST-PRZYPRAWA,TEST-EBOOK,TEST-MINUS,TEST-NIEMA', t)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.nieznaneSku).toEqual(['TEST-NIEMA'])
    expect(body.pozycje.map((p: { sku: string }) => p.sku)).toEqual(['TEST-ZESTAW', 'TEST-PRZYPRAWA', 'TEST-EBOOK', 'TEST-MINUS'])
    const [zestaw, h, ebook, m] = body.pozycje
    expect(zestaw).toEqual({ sku: 'TEST-ZESTAW', nazwa: 'Zestaw TEST-ZESTAW', rodzaj: 'BUNDLE', jednostka: 'SZT', oferty: [], fizycznie: null, zarezerwowane: null, dostepne: 3 })
    expect(h).toEqual({
      sku: 'TEST-PRZYPRAWA',
      nazwa: 'Towar testowy TEST-PRZYPRAWA',
      rodzaj: 'STOCKED',
      jednostka: 'SZT',
      fizycznie: 10,
      zarezerwowane: 0,
      dostepne: 10,
      oferty: [{ kanal: 'WOO', konto: 'lampy', externalId: '501', sztukNaOferte: 2 }],
    })
    expect(ebook).toEqual({ sku: 'TEST-EBOOK', nazwa: 'E-book testowy', rodzaj: 'DIGITAL', jednostka: 'SZT', oferty: [], bezStanu: true })
    expect(m).toMatchObject({ fizycznie: 2, zarezerwowane: 5, dostepne: 0 })
    // przyprawa 10 / 2 = 5, kubek 3 / 1 = 3 → 3 zestawy; po rezerwacji 2 kubków zostaje 1
    await ingestOrder(a, order([{ productId: kubek, qty: 2 }]))
    const po = await (await getStany('?sku=TEST-ZESTAW', t)).json()
    expect(po.pozycje[0].dostepne).toBe(1)
  })

  it('po ofertach konta: strony po 200 produktów, kolejność po SKU', async () => {
    const ids: string[] = []
    for (let i = 0; i < 203; i++) ids.push((await a.product.create({ data: { sku: `TEST-P${String(i).padStart(3, '0')}`, kind: 'STOCKED', unit: 'SZT', nameAccounting: 'x', title: `Produkt ${i}` } })).id)
    await a.channelOffer.createMany({ data: ids.map((productId, i) => ({ channel: 'WOO' as const, channelAccountId: 'lampy', externalId: String(1000 + i), productId })) })
    const other = await product(a, 'TEST-INNY', 1)
    await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'sd', externalId: '1', productId: other } })
    const t = await key(a, ['stany:odczyt'])
    const p1 = await (await getStany('?kanal=WOO&konto=lampy', t)).json()
    expect(p1.pozycje).toHaveLength(200)
    expect(p1).toMatchObject({ strona: 1, nastepnaStrona: 2 })
    expect(p1.pozycje[0]).toMatchObject({ sku: 'TEST-P000', fizycznie: 0, dostepne: 0, oferty: [{ kanal: 'WOO', konto: 'lampy', externalId: '1000', sztukNaOferte: 1 }] })
    const p2 = await (await getStany('?kanal=WOO&konto=lampy&strona=2', t)).json()
    expect(p2.pozycje.map((x: { sku: string }) => x.sku)).toEqual(['TEST-P200', 'TEST-P201', 'TEST-P202'])
    expect(p2.nastepnaStrona).toBeNull()
    expect((await getStany('', t)).status).toBe(400)
    expect((await getStany('?kanal=WOO', t)).status).toBe(400)
    expect((await getStany('?sku=A&kanal=WOO&konto=lampy', t)).status).toBe(400)
    expect((await getStany('?kanal=NIEZNANY&konto=x', t)).status).toBe(400)
    // kanały sklepów Shoper i PrestaShop są znane API (konto bez ofert = pusta lista, nie 400)
    for (const k of ['SHOPER', 'PRESTASHOP']) expect((await getStany(`?kanal=${k}&konto=demo`, t)).status, k).toBe(200)
    expect((await getStany('?sku=A&cos=1', t)).status).toBe(400)
    expect((await getStany(`?sku=${Array.from({ length: 201 }, (_, i) => `S${i}`).join(',')}`, t)).status).toBe(400)
  })

  it('izolacja: ten sam SKU i ta sama oferta w dwóch firmach — klucz widzi tylko swoją', async () => {
    await product(a, 'TEST-WSPOLNY', 7)
    const pb = await product(b, 'TEST-WSPOLNY', 99)
    await product(b, 'TEST-TYLKO-B', 5)
    await b.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'lampy', externalId: '501', productId: pb } })
    const ta = await key(a, ['stany:odczyt'])
    const ra = await (await getStany('?sku=TEST-WSPOLNY,TEST-TYLKO-B', ta)).json()
    expect(ra.pozycje).toHaveLength(1)
    expect(ra.pozycje[0]).toMatchObject({ fizycznie: 7, oferty: [] })
    expect(ra.nieznaneSku).toEqual(['TEST-TYLKO-B'])
    expect((await (await getStany('?kanal=WOO&konto=lampy', ta)).json()).pozycje).toEqual([])
    const rb = await (await getStany('?kanal=WOO&konto=lampy', await key(b, ['stany:odczyt']))).json()
    expect(rb.pozycje.map((x: { fizycznie: number }) => x.fizycznie)).toEqual([99])
  })
})

describe('GET /api/v1/zamowienia', () => {
  async function seedOrders(db: PrismaClient, n: number, prefix = 'WC-TEST-') {
    const p = await product(db, `${prefix}SKU`, 100)
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const r = await ingestOrder(db, order([{ productId: p, qty: 1 }], { externalId: `${prefix}${1000 + i}` }))
      ids.push(r.orderId!)
    }
    return { p, ids }
  }

  it('odpowiedź zawiera wyłącznie pola z listy; bez flags, cancelReason, pendingAction i treści zdarzeń', async () => {
    const { ids } = await seedOrders(a, 1)
    await a.order.update({ where: { id: ids[0] }, data: { blOrderId: 8000123, flags: { zKanalu: 'Testowa Uwaga Klienta ul. Zmyślona 1' }, cancelReason: 'POWOD-TESTOWY', pendingAction: 'AKCJA-TESTOWA' } })
    await a.orderEvent.create({ data: { orderId: ids[0]!, kind: 'WYSLANE', actorId: 'test', data: { nadanie: 'TESTNADANIE-STARE' }, createdAt: new Date(Date.now() - 60_000) } })
    await a.orderEvent.create({ data: { orderId: ids[0]!, kind: 'WYSLANE', actorId: 'test', data: { z: 'SPAKOWANE', na: 'WYSLANE', nadanie: 'TESTNADANIE-0001', uwaga: 'TRESC-ZDARZENIA' } } })
    const t = await key(a, ['zamowienia:odczyt'])
    const body = await (await getLista('', t)).json()
    expect(Object.keys(body).sort()).toEqual(['nastepny', 'zamowienia'])
    const [z] = body.zamowienia
    expect(Object.keys(z).sort()).toEqual([...ORDER_FIELDS].sort())
    for (const l of z.pozycje) expect(Object.keys(l).sort()).toEqual([...LINE_FIELDS].sort())
    expect(z).toMatchObject({
      kanal: 'WOO',
      konto: 'sd',
      numer: 'WC-TEST-1000',
      numerBl: 8000123,
      status: 'DO_REALIZACJI',
      statusNazwa: 'Do realizacji',
      przewoznik: 'PACZKOMATY',
      sposobDostawy: 'Paczkomaty InPost',
      platnosc: 'PAID',
      platnoscMetoda: 'BLIK',
      sumaBrutto: 100,
      zlozono: '2026-10-15T08:00:00.000Z',
      numerNadania: 'TESTNADANIE-0001',
      pozycje: [{ sku: 'WC-TEST-SKU', nazwa: 'Towar testowy WC-TEST-SKU', ilosc: 1, cenaBrutto: 10 }],
      przesylki: [],
    })
    const text = JSON.stringify(body)
    for (const s of ['Zmyślona', 'POWOD-TESTOWY', 'AKCJA-TESTOWA', 'TRESC-ZDARZENIA', 'TESTNADANIE-STARE', ids[0]!]) expect(text).not.toContain(s)
    // ten sam zestaw pól przy odczycie po numerze
    const one = await (await getNumer('WC-TEST-1000', t)).json()
    expect(Object.keys(one.zamowienia[0]).sort()).toEqual([...ORDER_FIELDS].sort())
    expect(one.zamowienia[0]).toEqual(z)
  })

  it('przesyłki: stan drogi kodem i słownie, data zmiany, ostatni odczyt, link tylko z modułu przewoźnika; bez opisów zdarzeń', async () => {
    const { ids } = await seedOrders(a, 1)
    const id = ids[0]!
    const zmiana = new Date('2026-11-10T09:30:00.000Z')
    const odczyt = new Date('2026-11-10T11:00:00.000Z')
    const s1 = await a.shipment.create({
      data: { orderId: id, packageNo: 1, reference: 'api-p-1', state: 'UTWORZONA', adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY', trackingNumber: '600000000000000000000001', trackState: 'W_DORECZENIU', trackStateSince: zmiana, trackedAt: odczyt, carrierStatus: 'out_for_delivery' },
    })
    // opis zdarzenia u przewoźnika może nieść nazwisko odbierającego: nie wychodzi z API
    await a.shipmentTrackEvent.create({ data: { shipmentId: s1.id, state: 'W_DORECZENIU', occurredAt: zmiana, carrierCode: 'out_for_delivery', carrierStatus: 'Wydana kurierowi Testowy Odbiorca Zmyślony' } })
    // Wysyłam z Allegro: przewoźnika dobiera pośrednik, link niepotwierdzony = null; bez odczytu = stan null
    await a.shipment.create({ data: { orderId: id, packageNo: 2, reference: 'api-p-2', state: 'UTWORZONA', adapterKey: ALLEGRO_WYSYLAM_ZAPIS_KEY, carrier: 'PACZKOMATY', trackingNumber: 'A000TESTALLEGRO1' } })
    // anulowana, której paczka nie ruszyła: pominięta; nieudana próba (BLAD) bez numeru: pominięta
    await a.shipment.create({ data: { orderId: id, packageNo: 3, reference: 'api-p-3', state: 'ANULOWANA', adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY', trackingNumber: '600000000000000000000003', trackState: 'UTWORZONA', trackStateSince: zmiana } })
    await a.shipment.create({ data: { orderId: id, packageNo: 4, reference: 'api-p-4', state: 'BLAD', adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY' } })
    const t = await key(a, ['zamowienia:odczyt'])
    const [z] = (await (await getLista('', t)).json()).zamowienia
    expect(Object.keys(z).sort()).toEqual([...ORDER_FIELDS].sort())
    for (const p of z.przesylki) expect(Object.keys(p).sort()).toEqual([...SHIPMENT_FIELDS].sort())
    expect(z.przesylki).toEqual([
      { przewoznik: 'PACZKOMATY', numerNadania: '600000000000000000000001', stan: 'W_DORECZENIU', stanNazwa: 'Wydana do doręczenia', stanOd: zmiana.toISOString(), sprawdzono: odczyt.toISOString(), sledzona: false, linkSledzenia: 'https://inpost.pl/sledzenie-przesylek?number=600000000000000000000001', rodzaj: 'GLOWNA' },
      { przewoznik: 'PACZKOMATY', numerNadania: 'A000TESTALLEGRO1', stan: null, stanNazwa: null, stanOd: null, sprawdzono: null, sledzona: false, linkSledzenia: null, rodzaj: 'GLOWNA' },
    ])
    const text = JSON.stringify(z)
    for (const x of ['Zmyślony', 'out_for_delivery', s1.id, 'api-p-1', INPOST_SHIPX_ZAPIS_KEY]) expect(text).not.toContain(x)
    // śledzenie do doręczenia włączone: InPost ShipX i Wysyłam z Allegro odświeżane (oba domyślnie śledzone;
    // Allegro jak na produkcji od 22.11.2026, SLEDZENIE_DOMYSLNIE_WLACZONE)
    await zapiszAutomatyWysylki(a, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, sledzenieDoDoreczenia: true }, 'u-admin')
    const [po] = (await (await getNumer('WC-TEST-1000', t)).json()).zamowienia
    expect(po.przesylki.map((p: { sledzona: boolean }) => p.sledzona)).toEqual([true, true])
    // moduł wyłączony w ustawieniach firmy (Przewoźnicy → „Których przewoźników pytać”): jego paczka nie jest śledzona
    await zapiszSledzeniePrzewoznikow(a, { [ALLEGRO_WYSYLAM_ZAPIS_KEY]: false }, [ALLEGRO_WYSYLAM_ZAPIS_KEY], 'u-admin')
    const [poWylaczeniu] = (await (await getNumer('WC-TEST-1000', t)).json()).zamowienia
    expect(poWylaczeniu.przesylki.map((p: { sledzona: boolean }) => p.sledzona)).toEqual([true, false])
    // Kompletor przestał pytać o paczkę (seria błędów, brak przesyłki u przewoźnika) albo minęło okno 30 dni: false, jak na karcie
    await a.shipment.update({ where: { id: s1.id }, data: { trackingStoppedAt: odczyt } })
    expect((await (await getNumer('WC-TEST-1000', t)).json()).zamowienia[0].przesylki[0].sledzona).toBe(false)
    await a.shipment.update({ where: { id: s1.id }, data: { trackingStoppedAt: null, createdAt: new Date(Date.now() - 31 * 86_400_000) } })
    expect((await (await getNumer('WC-TEST-1000', t)).json()).zamowienia[0].przesylki[0].sledzona).toBe(false)
    // izolacja: klucz firmy B nie widzi przesyłek firmy A (ani zamówienia)
    const tb = await key(b, ['zamowienia:odczyt'])
    expect((await getNumer('WC-TEST-1000', tb)).status).toBe(404)
    // ten sam numer zamówienia w firmie B, przesyłki tylko w A: B dostaje swoje zamówienie bez przesyłek A
    await seedOrders(b, 1)
    const zB = (await (await getNumer('WC-TEST-1000', tb)).json()).zamowienia
    expect(zB).toHaveLength(1)
    expect(zB[0].przesylki).toEqual([])
    expect((await (await getLista('', tb)).json()).zamowienia.map((z: { przesylki: unknown[] }) => z.przesylki)).toEqual([[]])
    expect((await (await getNumer('WC-TEST-1000', t)).json()).zamowienia[0].przesylki).toHaveLength(2)
  })

  it('przesyłki: dodatkowa ma rodzaj (dosyłka, zastępcza, druga paczka), bez powodu i kosztu; numerNadania zamówienia zostaje z głównej', async () => {
    const { ids } = await seedOrders(a, 1)
    const id = ids[0]!
    await a.shipment.create({ data: { orderId: id, packageNo: 1, reference: 'api-d-0', state: 'UTWORZONA', adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY', trackingNumber: '600000000000000000000100' } })
    await a.shipment.create({
      data: { orderId: id, packageNo: 1, extraNo: 1, extraKind: 'DOSYLKA', extraReason: 'POWOD-DOSYLKI-reklamacja', extraCostNet: '14.50', reference: 'api-d-1', state: 'UTWORZONA', adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY', trackingNumber: '600000000000000000000101' },
    })
    await a.shipment.create({ data: { orderId: id, packageNo: 1, extraNo: 2, extraKind: 'ZASTEPCZA', extraReason: 'zgubiona paczka', reference: 'api-d-2', state: 'UTWORZONA', adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY', trackingNumber: '600000000000000000000102' } })
    const t = await key(a, ['zamowienia:odczyt'])
    const [z] = (await (await getNumer('WC-TEST-1000', t)).json()).zamowienia
    expect(z.przesylki.map((p: { numerNadania: string; rodzaj: string }) => [p.numerNadania, p.rodzaj])).toEqual([
      ['600000000000000000000100', 'GLOWNA'],
      ['600000000000000000000101', 'DOSYLKA'],
      ['600000000000000000000102', 'ZASTEPCZA'],
    ])
    for (const p of z.przesylki) expect(Object.keys(p).sort()).toEqual([...SHIPMENT_FIELDS].sort())
    const text = JSON.stringify(z)
    for (const x of ['POWOD-DOSYLKI', 'zgubiona', '14.5']) expect(text).not.toContain(x)
    // numer zamówienia z przejścia statusu (seed), nie z przesyłki dodatkowej
    expect(z.numerNadania).not.toBe('600000000000000000000101')
  })

  it('przesyłki: najwyżej ' + MAX_SHIPMENTS + ' na zamówienie, od najstarszej', async () => {
    const { ids } = await seedOrders(a, 1)
    for (let i = 0; i < MAX_SHIPMENTS + 2; i++)
      await a.shipment.create({ data: { orderId: ids[0]!, packageNo: i + 1, reference: `api-limit-${i}`, state: 'UTWORZONA', adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY', trackingNumber: `6000000000000000000${10000 + i}` } })
    const t = await key(a, ['zamowienia:odczyt'])
    const [z] = (await (await getLista('', t)).json()).zamowienia
    expect(z.przesylki).toHaveLength(MAX_SHIPMENTS)
    expect(z.przesylki[0].numerNadania).toBe('600000000000000000010000')
  })

  it('stan przesyłki stałym tekstem ze stanu, bez opisu przewoźnika (nazwisko, adres, telefon)', async () => {
    const { ids } = await seedOrders(a, 2)
    const opis = 'Doręczono, odebrał: KOWALSKI, ul. Kwiatowa 5, tel. 600 100 200'
    await a.orderEvent.create({ data: { orderId: ids[0]!, kind: 'PRZESYLKA_STATUS', actorId: 'test', data: { przesylka: 'x', status: '5', stan: 'DORECZONA', opis } } })
    await a.orderEvent.create({ data: { orderId: ids[1]!, kind: 'PRZESYLKA_STATUS', actorId: 'test', data: { przesylka: 'y', status: 'cos', stan: 'DZIWNY', opis: 'Awizo, tel. 600 100 200' } } })
    const t = await key(a, ['zamowienia:odczyt'])
    const body = await (await getLista('', t)).json()
    const po = new Map<string, { przesylkaStatus: string; przesylkaStatusKod: string }>(body.zamowienia.map((z: { numer: string; przesylkaStatus: string; przesylkaStatusKod: string }) => [z.numer, z]))
    expect(po.get('WC-TEST-1000')).toMatchObject({ przesylkaStatus: 'Doręczona', przesylkaStatusKod: 'DORECZONA' })
    expect(po.get('WC-TEST-1001')).toMatchObject({ przesylkaStatus: 'Status nierozpoznany', przesylkaStatusKod: 'NIEZNANY' })
    const text = JSON.stringify(body)
    for (const s of ['KOWALSKI', 'Kwiatowa', '600 100 200', 'Awizo']) expect(text).not.toContain(s)
  })

  it('po numerze: numer sklepu albo numer BL, kilka kont = wszystkie, kanal/konto zawęża, brak = 404', async () => {
    const p = await product(a, 'TEST-N', 10)
    await ingestOrder(a, order([{ productId: p, qty: 1 }], { externalId: '5005' }))
    await ingestOrder(a, order([{ productId: p, qty: 1 }], { externalId: '5005', channel: 'WOO_LAMPY', eventKey: 'lampy-5005' }))
    const third = await ingestOrder(a, order([{ productId: p, qty: 1 }], { externalId: 'ALLEGRO-TEST-1', channel: 'ALLEGRO' }))
    await a.order.update({ where: { id: third.orderId! }, data: { blOrderId: 5005 } })
    const t = await key(a, ['zamowienia:odczyt'])
    const all = await (await getNumer('5005', t)).json()
    expect(all.zamowienia.map((z: { kanal: string; konto: string }) => `${z.kanal}/${z.konto}`)).toEqual(['WOO/lampy', 'WOO/sd', 'ALLEGRO/allegro'])
    const narrow = await (await getNumer('5005', t, '?kanal=WOO&konto=lampy')).json()
    expect(narrow.zamowienia.map((z: { konto: string }) => z.konto)).toEqual(['lampy'])
    expect((await getNumer('9999', t)).status).toBe(404)
    expect((await getNumer('5005', t, '?kanal=XYZ')).status).toBe(400)
    expect((await getNumer('5005', t, '?kanal=PRESTASHOP&konto=demo')).status).toBe(404) // znany kanał, brak zamówienia
    // izolacja: firma B nie widzi zamówień A, a jej własne o tym numerze są osobne
    const pb = await product(b, 'TEST-N', 10)
    await ingestOrder(b, order([{ productId: pb, qty: 2 }], { externalId: '5005' }))
    const fromB = await (await getNumer('5005', await key(b, ['zamowienia:odczyt']))).json()
    expect(fromB.zamowienia).toHaveLength(1)
    expect(fromB.zamowienia[0].pozycje[0].ilosc).toBe(2)
  })

  it('lista: kursor stabilny przy równych updatedAt, zmiana w trakcie przesuwa zamówienie na koniec; izolacja', async () => {
    const { ids } = await seedOrders(a, 5)
    await seedOrders(b, 3, 'WC-B-')
    const same = new Date(Date.now() - 3600_000)
    await a.$executeRaw`UPDATE "Order" SET "updatedAt" = ${same}`
    const t = await key(a, ['zamowienia:odczyt'])
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    let changed = false
    do {
      const body: { zamowienia: { numer: string }[]; nastepny: string | null } = await (await getLista(`?limit=2${cursor ? `&po=${cursor}` : ''}`, t)).json()
      seen.push(...body.zamowienia.map((z) => z.numer))
      cursor = body.nastepny
      pages++
      if (!changed) {
        // zamówienie z pierwszej strony zmienia się w trakcie pobierania: wraca na końcu
        await a.order.update({ where: { id: ids[0] }, data: { remindAt: new Date() } })
        changed = true
      }
    } while (cursor && pages < 10)
    const sorted = (await a.order.findMany({ where: { id: { in: ids } }, select: { externalId: true, id: true }, orderBy: { id: 'asc' } })).map((o) => o.externalId)
    const first = (await a.order.findUniqueOrThrow({ where: { id: ids[0] } })).externalId
    expect(seen.slice(0, 5)).toEqual(sorted)
    expect(seen.slice(5)).toEqual([first])
    expect(seen.every((n) => n.startsWith('WC-TEST-'))).toBe(true)
    // powtórka od tego samego kursora daje to samo
    const c1 = (await (await getLista('?limit=2', t)).json()).nastepny
    const again1 = await (await getLista(`?limit=2&po=${c1}`, t)).json()
    const again2 = await (await getLista(`?limit=2&po=${c1}`, t)).json()
    expect(again1).toEqual(again2)
    // okno i parametry
    expect((await getLista(`?zmienione_od=${new Date(Date.now() - 15 * 86400_000).toISOString()}`, t)).status).toBe(400)
    expect((await getLista(`?zmienione_od=${new Date(Date.now() - 600_000).toISOString()}`, t)).status).toBe(200)
    expect((await (await getLista(`?zmienione_od=${new Date(Date.now() - 600_000).toISOString()}`, t)).json()).zamowienia.map((z: { numer: string }) => z.numer)).toEqual([first])
    expect((await getLista('?limit=201', t)).status).toBe(400)
    expect((await getLista('?limit=0', t)).status).toBe(400)
    expect((await getLista('?po=zly-kursor!', t)).status).toBe(400)
    expect((await getLista('?zmienione_od=wczoraj', t)).status).toBe(400)
    const fromB = await (await getLista('', await key(b, ['zamowienia:odczyt']))).json()
    expect(fromB.zamowienia.map((z: { numer: string }) => z.numer).sort()).toEqual(['WC-B-1000', 'WC-B-1001', 'WC-B-1002'])
  })
})

describe('POST /api/v1/zamowienia (EasyTools)', () => {
  it('nowe 201 z rezerwacją, dostępne w /stany spada; powtórka 200 DUPLIKAT z tym samym id', async () => {
    const p = await product(a, 'TEST-ZESTAW-START', 5)
    const t = await key(a, ['zamowienia:zapis', 'stany:odczyt'])
    const r1 = await post(etOrder(), t)
    expect(r1.status).toBe(201)
    const b1 = await r1.json()
    expect(Object.keys(b1).sort()).toEqual(['brakuje', 'id', 'outcome', 'status', 'zarezerwowano'])
    expect(b1).toMatchObject({ status: 'DO_REALIZACJI', outcome: 'NOWE', zarezerwowano: 1, brakuje: 0 })
    const o = await a.order.findUniqueOrThrow({ where: { id: b1.id }, include: { lines: true, reservations: true } })
    expect(o).toMatchObject({ channel: 'EASYTOOLS', channelAccountId: 'et', externalId: 'ET-TEST-1001', paymentState: 'PAID', paymentMethod: 'Przelewy24', deliveryMethod: 'Paczkomat InPost', carrier: 'PACZKOMATY', wantInvoiceNip: false })
    expect(o.lines).toMatchObject([{ externalLineId: 'ET-TEST-1001:1', productId: p, qty: 1, vatRate: '23' }])
    expect(o.reservations).toMatchObject([{ productId: p, qtyBase: 1, state: 'ACTIVE' }])
    expect(await stockOf(a, p)).toMatchObject({ reserved: 1, available: 4 })
    expect((await (await getStany('?sku=TEST-ZESTAW-START', t)).json()).pozycje[0]).toMatchObject({ zarezerwowane: 1, dostepne: 4 })
    const r2 = await post(etOrder(), t)
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ ...b1, outcome: 'DUPLIKAT' })
    expect(await a.order.count()).toBe(1)
    expect(await stockOf(a, p)).toMatchObject({ reserved: 1 })
    // kolejność pól w JSON bez znaczenia dla idempotencji
    const reordered = Object.fromEntries(Object.entries(etOrder()).reverse())
    expect((await (await post(reordered, t)).json()).outcome).toBe('DUPLIKAT')
    // ten sam numer z inną treścią (pozycje, płatność) = 409 z id i statusem, zamówienie bez zmian, bez śladu zdarzenia
    const events = await a.inboundEvent.count()
    for (const other of [etOrder({ pozycje: [{ produktId: p, ilosc: 2, cenaBrutto: 29.95 }] }), etOrder({ platnosc: 'UNPAID' })]) {
      const r3 = await post(other, t)
      expect(r3.status).toBe(409)
      expect(await r3.json()).toMatchObject({ pole: 'numer', id: b1.id, status: 'DO_REALIZACJI', error: expect.stringMatching(/już istnieje/) })
    }
    expect(await a.inboundEvent.count()).toBe(events)
    expect(await a.order.findUniqueOrThrow({ where: { id: b1.id } })).toMatchObject({ paymentState: 'PAID', status: 'DO_REALIZACJI' })
    expect(await stockOf(a, p)).toMatchObject({ reserved: 1, available: 4 })
    // powtórka pierwotnej treści po odrzuconej zmianie dalej DUPLIKAT
    expect((await (await post(etOrder(), t)).json()).outcome).toBe('DUPLIKAT')
    await expectInvariants(a)
    // firma B: brak zamówienia i brak rezerwacji
    expect(await b.order.count()).toBe(0)
  })

  it('sposób dostawy bez reguły przewoźnika = 201, zamówienie DO_WYJASNIENIA z powodem', async () => {
    await product(a, 'TEST-ZESTAW-START', 5)
    const t = await key(a, ['zamowienia:zapis'])
    const r = await post(etOrder({ numer: 'ET-TEST-DRON', sposobDostawy: 'Dron' }), t)
    expect(r.status).toBe(201)
    const body = await r.json()
    expect(body).toMatchObject({ outcome: 'NOWE', status: 'DO_WYJASNIENIA' })
    const o = await a.order.findUniqueOrThrow({ where: { id: body.id } })
    expect(o.carrier).toBe('BRAK')
    expect(JSON.stringify(o.flags)).toMatch(/nieznana metoda dostawy: Dron/)
  })

  it('nieznany SKU = 422 z listą, DIGITAL = 422, nic nie powstaje', async () => {
    await product(a, 'TEST-ZESTAW-START', 5)
    await a.product.create({ data: { sku: 'TEST-EBOOK', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book', title: 'E-book' } })
    await product(b, 'TEST-TYLKO-B', 5)
    const t = await key(a, ['zamowienia:zapis'])
    const r = await post(etOrder({ pozycje: [{ sku: 'TEST-ZESTAW-START', ilosc: 1, cenaBrutto: 1 }, { sku: 'TEST-NIEMA', ilosc: 1, cenaBrutto: 1 }, { sku: 'TEST-TYLKO-B', ilosc: 1, cenaBrutto: 1 }] }), t)
    expect(r.status).toBe(422)
    expect((await r.json()).nieznane).toEqual(['TEST-NIEMA', 'TEST-TYLKO-B'])
    const d = await post(etOrder({ pozycje: [{ sku: 'TEST-ZESTAW-START', ilosc: 1, cenaBrutto: 1 }, { sku: 'TEST-EBOOK', ilosc: 1, cenaBrutto: 1 }] }), t)
    expect(d.status).toBe(422)
    expect(await d.json()).toMatchObject({ bezStanu: ['TEST-EBOOK'], error: expect.stringMatching(/e-book/) })
    expect(await a.order.count()).toBe(0)
    expect(await a.inboundEvent.count()).toBe(0)
  })

  it('pola adresowe i kontaktowe = 400 z komunikatem o adresach; nieznane pole i zły typ = 400', async () => {
    await product(a, 'TEST-ZESTAW-START', 5)
    const t = await key(a, ['zamowienia:zapis'])
    for (const extra of [{ email: 'kupujacy@example.invalid' }, { telefon: '000000000' }, { imie: 'Jan' }, { nazwisko: 'Testowy' }, { adres: 'ul. Zmyślona 1' }, { delivery_city: 'Testowo' }, { invoice_nip: '0000000000' }, { phone: '0' }]) {
      const r = await post(etOrder(extra), t)
      expect(r.status, JSON.stringify(extra)).toBe(400)
      expect((await r.json()).error).toMatch(/nie przyjmuje adresów/)
    }
    const inLine = await post(etOrder({ pozycje: [{ sku: 'TEST-ZESTAW-START', ilosc: 1, cenaBrutto: 1, delivery_address: 'x' }] }), t)
    expect(inLine.status).toBe(400)
    expect(await inLine.json()).toMatchObject({ pole: 'pozycje[0].delivery_address', error: expect.stringMatching(/nie przyjmuje adresów/) })
    const unknown = await post(etOrder({ kupon: 'X' }), t)
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ pole: 'kupon', error: 'Nieznane pole kupon' })
    for (const bad of [{ platnosc: 'PARTIAL' }, { sumaBrutto: '59.90' }, { pozycje: [] }, { pozycje: [{ ilosc: 1, cenaBrutto: 1 }] }, { pozycje: [{ sku: 'TEST-ZESTAW-START', produktId: 'x', ilosc: 1, cenaBrutto: 1 }] }, { pozycje: [{ sku: 'TEST-ZESTAW-START', ilosc: 1.5, cenaBrutto: 1 }] }, { zlozono: '2026-11-02' }, { numer: '' }])
      expect((await post(etOrder(bad), t)).status, JSON.stringify(bad)).toBe(400)
    expect((await post('{nie json', t)).status).toBe(400)
    expect((await post('[]', t)).status).toBe(400)
    expect(await a.order.count()).toBe(0)
  })

  it('za duża treść: 413 po Content-Length przed odczytem i po odczycie bez nagłówka', async () => {
    const t = await key(a, ['zamowienia:zapis'])
    const r = await post(etOrder(), t, { 'content-length': String(64 * 1024 + 1) })
    expect(r.status).toBe(413)
    const big = JSON.stringify(etOrder({ platnoscMetoda: 'x'.repeat(70 * 1024) }))
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(big)
        for (let i = 0; i < bytes.length; i += 8192) c.enqueue(bytes.slice(i, i + 8192))
        c.close()
      },
    })
    const r2 = await zamowienia.POST(req('/api/v1/zamowienia', t, { method: 'POST', body: stream, headers: { 'content-type': 'application/json' } }))
    expect(r2.status).toBe(413)
    expect(await a.order.count()).toBe(0)
  })

  it('firma bez konta EasyTools = 422; klucz firmy A zapisuje wyłącznie w A', async () => {
    await product(a, 'TEST-ZESTAW-START', 5)
    await product(b, 'TEST-ZESTAW-START', 5)
    await b.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_B, channel: 'EASYTOOLS', channelAccountId: 'et' } }, data: { active: false } })
    const rb = await post(etOrder(), await key(b, ['zamowienia:zapis']))
    expect(rb.status).toBe(422)
    expect((await rb.json()).error).toMatch(/konta kanału EasyTools/)
    expect((await post(etOrder(), await key(a, ['zamowienia:zapis']))).status).toBe(201)
    expect(await sys.order.groupBy({ by: ['organizationId'], _count: true })).toEqual([{ organizationId: ORG_A, _count: 1 }])
  })
})

describe('rdzeń i cień: EASYTOOLS', () => {
  it('EASYTOOLS bez produktu z katalogu = ValidationError (jak RECZNE)', async () => {
    const p = await product(a, 'TEST-ET', 5)
    await expect(ingestOrder(a, order([{ offerExternalId: 'oferta-1', qty: 1 }], { channel: 'EASYTOOLS' }))).rejects.toBeInstanceOf(ValidationError)
    await expect(ingestOrder(a, order([{ productId: 'nieistniejacy-produkt', qty: 1 }], { channel: 'EASYTOOLS' }))).rejects.toThrow(/spoza katalogu/)
    const ok = await ingestOrder(a, order([{ productId: p, qty: 1 }], { channel: 'EASYTOOLS' }))
    expect(ok.outcome).toBe('NOWE')
  })

  it('preset ACME: konto EasyTools „acme” bez adaptera nie psuje cienia (withoutAdapter = 0) ani porównania z BL', async () => {
    const acc = ACME_PRESET.channels!.find((c) => c.channel === 'EASYTOOLS')
    expect(acc).toMatchObject({ channelAccountId: 'acme', name: 'EasyTools' })
    await truncateAll()
    await applyOrgPreset(sys, { ...ACME_PRESET, id: ORG_A, slug: 'test-a', name: 'Firma testowa A' })
    expect(await a.channelConfig.findFirst({ where: { channel: 'EASYTOOLS' } })).toMatchObject({ channelAccountId: 'acme', active: true })
    const plan = await planOrderPolls(a, defaultRegistry(), new Date())
    expect(plan.withoutAdapter).toEqual([])
    const st = await loadShadowReading(a, { enabled: true })
    expect(st.withoutAdapter).toBe(0)
    expect(st.details.some((d) => d.channel === 'EASYTOOLS')).toBe(false)
    expect((await accountsForComparison(a)).some((x) => x.channel === 'EASYTOOLS')).toBe(false)
  })
})
