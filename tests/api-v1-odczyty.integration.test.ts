// nowe odczyty API v1 (te same funkcje co narzędzia MCP), dane fikcyjne (SKU TEST-*), bez sieci.
//  - GET /api/v1/produkty, /produkty/<sku>: zakres produkty:odczyt, fraza, rodzaj, aktywne, kursor po SKU, 404;
//  - GET /api/v1/statusy: zakres zamowienia:odczyt, słownik bez bazy;
//  - GET /api/v1/raporty/dzien, /braki, /rezerwacje: zakres raporty:odczyt, same liczby, SKU i numery;
//  - GET /api/v1/zamowienia: nowe filtry (status, platnosc, kanal, konto, zlozone_od/do) zawężają tę samą listę;
//  - izolacja firm i zakresy: 401 / 403, nieznany parametr 400.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { PrismaClient } from '@prisma/client'
import { createApiKey } from '@/lib/api/zarzadzanie'
import { ALL_API_SCOPES, type ApiScope } from '@/lib/api/zakresy'
import { PRODUCT_DETAIL_FIELDS, PRODUCT_FIELDS } from '@/lib/api/produkty'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { warsawRanges } from '@/lib/panel/dane'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { bundle, order, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const { resetApiLimiters } = await import('@/lib/api/klucze')
const produkty = await import('@/app/api/v1/produkty/route')
const produkt = await import('@/app/api/v1/produkty/[sku]/route')
const statusy = await import('@/app/api/v1/statusy/route')
const dzien = await import('@/app/api/v1/raporty/dzien/route')
const braki = await import('@/app/api/v1/raporty/braki/route')
const rezerwacje = await import('@/app/api/v1/raporty/rezerwacje/route')
const zamowienia = await import('@/app/api/v1/zamowienia/route')

testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) await seedBase(db)
  resetApiLimiters()
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const key = async (db: PrismaClient, scopes: ApiScope[] = ALL_API_SCOPES) => (await createApiKey(db, { name: 'test', scopes }, 'u')).token
const req = (p: string, token?: string | null) => new NextRequest(`http://localhost:3100${p}`, { headers: { 'x-forwarded-for': '198.51.100.31', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
const getSku = (sku: string, token: string, q = '') => produkt.GET(req(`/api/v1/produkty/${encodeURIComponent(sku)}${q}`, token), { params: Promise.resolve({ sku }) })

async function seed() {
  const przyprawa = await product(a, 'TEST-PRZYPRAWA', 10)
  const kubek = await product(a, 'TEST-KUBEK', 1)
  await a.product.update({ where: { id: kubek }, data: { ean: '5900000000017' } })
  await bundle(a, 'TEST-ZESTAW', [
    { id: przyprawa, qty: 2 },
    { id: kubek, qty: 1 },
  ])
  await a.product.create({ data: { sku: 'TEST-EBOOK', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book', title: 'E-book testowy' } })
  await a.product.create({ data: { sku: 'TEST-STARY', kind: 'STOCKED', unit: 'SZT', nameAccounting: 'Stary', title: 'Stary towar', active: false } })
  await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'sd', externalId: '501', productId: przyprawa } })
  await a.channelOffer.create({ data: { channel: 'ALLEGRO', channelAccountId: 'allegro', externalId: 'A-1', productId: przyprawa, active: false } })
  await ingestOrder(a, order([{ productId: przyprawa, qty: 2 }, { productId: kubek, qty: 3 }], { externalId: 'TEST-0001', paymentState: 'UNPAID', createdAtChannel: new Date(Date.now() - 3600_000) }))
  await ingestOrder(a, order([{ productId: przyprawa, qty: 1 }], { externalId: 'TEST-0002', channel: 'ALLEGRO', createdAtChannel: new Date(Date.now() - 600_000) }))
  // firma B: ten sam SKU, inny stan — nie może przeciekać
  await product(b, 'TEST-PRZYPRAWA', 99)
}

describe('GET /api/v1/produkty', () => {
  it('zakres produkty:odczyt; lista po SKU, domyślnie aktywne, fraza po SKU/nazwie/EAN, rodzaj, kursor', async () => {
    await seed()
    expect((await produkty.GET(req('/api/v1/produkty', await key(a, ['stany:odczyt'])))).status).toBe(403)
    expect((await produkty.GET(req('/api/v1/produkty'))).status).toBe(401)
    const t = await key(a, ['produkty:odczyt'])
    const all = await (await produkty.GET(req('/api/v1/produkty', t))).json()
    expect(all.produkty.map((p: { sku: string }) => p.sku)).toEqual(['TEST-EBOOK', 'TEST-KUBEK', 'TEST-PRZYPRAWA', 'TEST-ZESTAW'])
    expect(Object.keys(all.produkty[0])).toEqual([...PRODUCT_FIELDS])
    expect(all.nastepny).toBeNull()
    const p1 = await (await produkty.GET(req('/api/v1/produkty?limit=2', t))).json()
    expect(p1.produkty.map((p: { sku: string }) => p.sku)).toEqual(['TEST-EBOOK', 'TEST-KUBEK'])
    const p2 = await (await produkty.GET(req(`/api/v1/produkty?limit=2&po=${p1.nastepny}`, t))).json()
    expect(p2.produkty.map((p: { sku: string }) => p.sku)).toEqual(['TEST-PRZYPRAWA', 'TEST-ZESTAW'])
    expect(p2.nastepny).toBeNull()
    const ean = await (await produkty.GET(req('/api/v1/produkty?fraza=5900000000017', t))).json()
    expect(ean.produkty.map((p: { sku: string }) => p.sku)).toEqual(['TEST-KUBEK'])
    const fr = await (await produkty.GET(req('/api/v1/produkty?fraza=przyp', t))).json()
    expect(fr.produkty.map((p: { sku: string }) => p.sku)).toEqual(['TEST-PRZYPRAWA'])
    const kinds = await (await produkty.GET(req('/api/v1/produkty?rodzaj=BUNDLE,DIGITAL', t))).json()
    expect(kinds.produkty.map((p: { sku: string }) => p.sku)).toEqual(['TEST-EBOOK', 'TEST-ZESTAW'])
    const off = await (await produkty.GET(req('/api/v1/produkty?aktywne=0', t))).json()
    expect(off.produkty.map((p: { sku: string }) => p.sku)).toEqual(['TEST-STARY'])
    for (const q of ['?limit=0', '?limit=101', '?rodzaj=INNY', '?aktywne=moze', '?po=%%%', '?nieznany=1']) expect((await produkty.GET(req(`/api/v1/produkty${q}`, t))).status, q).toBe(400)
    // firma B widzi tylko swoje
    const tb = await key(b, ['produkty:odczyt'])
    expect((await (await produkty.GET(req('/api/v1/produkty', tb))).json()).produkty.map((p: { sku: string }) => p.sku)).toEqual(['TEST-PRZYPRAWA'])
  })

  it('/produkty/<sku>: stan, oferty (z wyłączonymi), składniki, zestawy; 404 i izolacja', async () => {
    await seed()
    const t = await key(a, ['produkty:odczyt'])
    const r = await getSku('TEST-PRZYPRAWA', t)
    expect(r.status).toBe(200)
    const { produkt: p } = await r.json()
    expect(Object.keys(p)).toEqual([...PRODUCT_DETAIL_FIELDS])
    expect(p).toMatchObject({ sku: 'TEST-PRZYPRAWA', rodzaj: 'STOCKED', cenaBrutto: 10, stan: { fizycznie: 10, zarezerwowane: 3, dostepne: 7 }, skladniki: [], wZestawach: [{ sku: 'TEST-ZESTAW', ilosc: 2 }] })
    expect(p.oferty).toEqual([
      { kanal: 'WOO', konto: 'sd', externalId: '501', sztukNaOferte: 1, aktywna: true },
      { kanal: 'ALLEGRO', konto: 'allegro', externalId: 'A-1', sztukNaOferte: 1, aktywna: false },
    ])
    const z = await (await getSku('TEST-ZESTAW', t)).json()
    expect(z.produkt).toMatchObject({ rodzaj: 'BUNDLE', stan: { fizycznie: null, zarezerwowane: null, dostepne: 0 }, skladniki: [{ sku: 'TEST-KUBEK', ilosc: 1 }, { sku: 'TEST-PRZYPRAWA', ilosc: 2 }] })
    const e = await (await getSku('TEST-EBOOK', t)).json()
    expect(e.produkt.stan).toEqual({ bezStanu: true })
    expect((await getSku('TEST-NIEMA', t)).status).toBe(404)
    expect((await getSku('TEST-PRZYPRAWA', t, '?x=1')).status).toBe(400)
    const tb = await key(b, ['produkty:odczyt'])
    const pb = await (await getSku('TEST-PRZYPRAWA', tb)).json()
    expect(pb.produkt.stan).toMatchObject({ fizycznie: 99, zarezerwowane: 0 })
    expect((await getSku('TEST-KUBEK', tb)).status).toBe(404)
  })
})

describe('GET /api/v1/statusy i /raporty/*', () => {
  it('statusy: zamowienia:odczyt, 12 statusów i 4 płatności z nazwami z panelu', async () => {
    expect((await statusy.GET(req('/api/v1/statusy', await key(a, ['produkty:odczyt'])))).status).toBe(403)
    const t = await key(a, ['zamowienia:odczyt'])
    const r = await (await statusy.GET(req('/api/v1/statusy', t))).json()
    expect(r.statusy).toHaveLength(12)
    expect(r.platnosci.map((p: { symbol: string }) => p.symbol)).toEqual(['PAID', 'UNPAID', 'COD', 'PARTIAL'])
    expect(r.statusy.find((s: { symbol: string }) => s.symbol === 'WYSLANE')).toMatchObject({ nazwa: 'Wysłane' })
    expect((await statusy.GET(req('/api/v1/statusy?x=1', t))).status).toBe(400)
  })

  it('raporty: raporty:odczyt; dzień, braki (z numerami zamówień), rezerwacje po produkcie, filtr sku', async () => {
    await seed()
    expect((await dzien.GET(req('/api/v1/raporty/dzien', await key(a, ['stany:odczyt'])))).status).toBe(403)
    const t = await key(a, ['raporty:odczyt'])
    const d = await (await dzien.GET(req('/api/v1/raporty/dzien', t))).json()
    // „dziś” = doba w Warszawie: przy przebiegu tuż po północy zamówienie sprzed godziny jest wczorajsze
    const { dayStart } = warsawRanges(new Date(d.stanNa))
    const today = await a.order.count({ where: { createdAtChannel: { gte: dayStart } } })
    expect(d).toMatchObject({ sprzedaz: { zamowien: today }, praca: { zamowienZBrakami: 1, brakujePozycji: 1 }, wyslaneDzis: 0 })
    expect(d.dzien).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const br = await (await braki.GET(req('/api/v1/raporty/braki', t))).json()
    expect(br).toEqual({ pozycje: [{ sku: 'TEST-KUBEK', nazwa: 'Towar testowy TEST-KUBEK', jednostka: 'SZT', brakuje: 2, dostepne: 0, zamowien: 1, zamowienia: [{ kanal: 'WOO', konto: 'sd', numer: 'TEST-0001', numerBl: null, status: expect.any(String) }] }], wiecej: false })
    const rz = await (await rezerwacje.GET(req('/api/v1/raporty/rezerwacje', t))).json()
    expect(rz.pozycje.map((p: { sku: string; zarezerwowane: number }) => [p.sku, p.zarezerwowane])).toEqual([
      ['TEST-PRZYPRAWA', 3],
      ['TEST-KUBEK', 1],
    ])
    expect(rz.pozycje[0].zamowienia.map((o: { numer: string; ilosc: number; platnosc: string }) => [o.numer, o.ilosc, o.platnosc])).toEqual([
      ['TEST-0001', 2, 'UNPAID'],
      ['TEST-0002', 1, 'PAID'],
    ])
    const one = await (await rezerwacje.GET(req('/api/v1/raporty/rezerwacje?sku=TEST-KUBEK&limit=1', t))).json()
    expect(one.pozycje.map((p: { sku: string }) => p.sku)).toEqual(['TEST-KUBEK'])
    for (const q of ['?limit=0', '?limit=101', '?x=1', '?sku=']) expect((await braki.GET(req(`/api/v1/raporty/braki${q}`, t))).status, q).toBe(400)
    // firma B: brak braków i rezerwacji
    const tb = await key(b, ['raporty:odczyt'])
    expect(await (await braki.GET(req('/api/v1/raporty/braki', tb))).json()).toEqual({ pozycje: [], wiecej: false })
    expect(await (await rezerwacje.GET(req('/api/v1/raporty/rezerwacje', tb))).json()).toEqual({ pozycje: [], wiecej: false })
  })
})

describe('GET /api/v1/zamowienia: filtry', () => {
  it('status, platnosc, kanal, konto, zlozone_od/do zawężają listę; zła wartość = 400 z polem', async () => {
    await seed()
    const t = await key(a, ['zamowienia:odczyt'])
    const nums = async (q: string) => ((await (await zamowienia.GET(req(`/api/v1/zamowienia${q}`, t))).json()).zamowienia as { numer: string }[]).map((o) => o.numer)
    expect(await nums('')).toEqual(['TEST-0001', 'TEST-0002'])
    expect(await nums('?platnosc=UNPAID')).toEqual(['TEST-0001'])
    expect(await nums('?platnosc=PAID,COD')).toEqual(['TEST-0002'])
    expect(await nums('?kanal=ALLEGRO')).toEqual(['TEST-0002'])
    expect(await nums('?kanal=WOO&konto=sd')).toEqual(['TEST-0001'])
    expect(await nums(`?zlozone_od=${encodeURIComponent(new Date(Date.now() - 1200_000).toISOString())}`)).toEqual(['TEST-0002'])
    expect(await nums(`?zlozone_do=${encodeURIComponent(new Date(Date.now() - 1200_000).toISOString())}`)).toEqual(['TEST-0001'])
    const st = (await (await zamowienia.GET(req('/api/v1/zamowienia', t))).json()).zamowienia[1].status
    expect(await nums(`?status=${st}`)).toContain('TEST-0002')
    for (const [q, pole] of [
      ['?status=ZLY', 'status'],
      ['?platnosc=GOTOWKA', 'platnosc'],
      ['?kanal=AI', 'kanal'],
      ['?zlozone_od=wczoraj', 'zlozone_od'],
      ['?zlozone_od=2026-11-03&zlozone_do=2026-11-02', 'zlozone_do'],
    ]) {
      const r = await zamowienia.GET(req(`/api/v1/zamowienia${q}`, t))
      expect(r.status, q).toBe(400)
      expect((await r.json()).pole, q).toBe(pole)
    }
  })
})
