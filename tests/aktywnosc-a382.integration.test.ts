// (zlecenie): wyłączanie i włączanie produktu — przeszkody (oferta, rezerwacja, otwarte
// zamówienie, aktywny zestaw), masowo częściowo, idempotencja, historia, izolacja firm, CSV „Aktywny” w obie strony.
// Dane fikcyjne, bez nazw sklepów.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { zalozProduktReczny } from '@/lib/produkty/karta'
import { przeszkodyWylaczenia, ustawAktywnosc } from '@/lib/produkty/aktywnosc'
import type { ChannelAdapter, ChannelOfferRow } from '@/lib/adaptery/kontrakt'
import { pobierzOferty } from '@/lib/kanaly/oferty'
import { ORG_B, testDb, truncateAll } from './db'
import { ACC } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const USER = 'uzytkownik-testowy-a382-akt'
const T = new Date('2026-11-20T10:00:00Z')

afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await a.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)' } })
  await b.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny B (test)' } })
})

async function prod(db: typeof a, sku: string, stan?: string): Promise<string> {
  const r = await zalozProduktReczny(db, { rodzaj: 'zwykly', sku, ...(stan ? { stanPoczatkowy: stan } : {}), form: { nazwa: `Produkt ${sku}`, cena: '10,00', vat: '23' } }, USER, { hasWfirma: false })
  if (!r.ok) throw new Error(r.error)
  return r.productId
}
const aktywne = async (ids: string[]) => (await a.product.findMany({ where: { id: { in: ids } }, select: { sku: true, active: true }, orderBy: { sku: 'asc' } })).map((p) => `${p.sku}:${p.active}`)
const linia = (tekst: string, sku: string, z: string, na: string) => tekst.split('\r\n').map((l) => (l.startsWith(`${sku};`) && l.endsWith(`;${z}`) ? `${l.slice(0, -z.length)}${na}` : l)).join('\r\n')

describe('wyłączanie produktu', () => {
  it('bez przeszkód: wyłączenie i włączenie z historią; ponowienie = 0 zmian; stan zostaje z uwagą', async () => {
    const p = await prod(a, 'A-1', '5')
    const r1 = await ustawAktywnosc(a, [p], false, USER)
    expect(r1).toMatchObject({ ok: true, value: { zmienione: 1, bezZmian: 0, odmowy: [], uwagi: [{ sku: 'A-1' }] } })
    expect(await aktywne([p])).toEqual(['A-1:false'])
    expect(await ustawAktywnosc(a, [p], false, USER)).toMatchObject({ ok: true, value: { zmienione: 0, bezZmian: 1 } })
    expect(await ustawAktywnosc(a, [p], true, USER)).toMatchObject({ ok: true, value: { zmienione: 1 } })
    const hist = (await a.auditLog.findMany({ where: { entity: 'Product', entityId: p }, orderBy: { createdAt: 'asc' }, select: { after: true } })).map((h) => h.after as Record<string, unknown>).filter((x) => 'active' in x)
    expect(hist).toEqual([{ active: false }, { active: true }])
    expect((await a.stock.findMany({ where: { productId: p } })).reduce((s, x) => s + x.physical, 0)).toBe(5)
  })

  it('odmowa per produkt: aktywna oferta, rezerwacja, otwarte zamówienie, składnik aktywnego zestawu; reszta się wyłącza', async () => {
    const ids: string[] = []
    for (const s of ['B-0', 'B-1', 'B-2', 'B-3', 'B-4', 'B-5']) ids.push(await prod(a, s))
    const [wolny, zOferta, zRez, zZam, skladnik] = ids as [string, string, string, string, string, string]
    const zZamZamk = ids[5]!
    await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'konto', externalId: 'X1', productId: zOferta, mappingSource: 'MANUAL' } })
    // oferta wyłączona nie blokuje
    await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'konto', externalId: 'X2', productId: wolny, mappingSource: 'MANUAL', active: false } })
    const o = await a.order.create({ data: { channel: 'WOO', channelAccountId: 'konto', externalId: 'Z-100', status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: 10, createdAtChannel: T } })
    const l = await a.orderLine.create({ data: { orderId: o.id, externalLineId: 'L1', productId: zRez, qty: 1, unitPriceGross: 10 } })
    await a.reservation.create({ data: { orderId: o.id, orderLineId: l.id, productId: zRez, warehouseId: DEFAULT_WAREHOUSE, qtyBase: 1, state: 'ACTIVE' } })
    await a.orderLine.create({ data: { orderId: o.id, externalLineId: 'L2', productId: zZam, qty: 1, unitPriceGross: 10 } })
    const zamk = await a.order.create({ data: { channel: 'WOO', channelAccountId: 'konto', externalId: 'Z-099', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: 10, createdAtChannel: T } })
    await a.orderLine.create({ data: { orderId: zamk.id, externalLineId: 'L1', productId: zZamZamk, qty: 1, unitPriceGross: 10 } })
    const zestaw = await a.product.create({ data: { sku: 'ZESTAW-1', title: 'Zestaw', kind: 'BUNDLE', unit: 'SZT', nameAccounting: 'Zestaw' } })
    await a.bundleComponent.create({ data: { bundleId: zestaw.id, componentId: skladnik, qtyBase: 2 } })

    const r = await ustawAktywnosc(a, ids, false, USER)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.zmienione).toBe(2)
    expect(Object.fromEntries(r.value.odmowy.map((x) => [x.sku, x.powod]))).toEqual({
      'B-1': expect.stringContaining('aktywną ofertę'),
      'B-2': expect.stringContaining('rezerwację'),
      'B-3': expect.stringContaining('Z-100'),
      'B-4': expect.stringContaining('ZESTAW-1'),
    })
    expect(await aktywne(ids)).toEqual(['B-0:false', 'B-1:true', 'B-2:true', 'B-3:true', 'B-4:true', 'B-5:false'])
    // zestaw wyłączany razem ze składnikiem: składnik nie jest blokowany
    expect((await przeszkodyWylaczenia(a, [skladnik], [skladnik, zestaw.id])).get(skladnik)).toBeUndefined()
    expect(await ustawAktywnosc(a, [zestaw.id, skladnik], false, USER)).toMatchObject({ ok: true, value: { zmienione: 2, odmowy: [] } })
    // włączenie zestawu z wyłączonym składnikiem: uwaga, bez odmowy
    expect(await ustawAktywnosc(a, [zestaw.id], true, USER)).toMatchObject({ ok: true, value: { zmienione: 1, uwagi: [{ sku: 'ZESTAW-1', komunikat: expect.stringContaining('B-4') }] } })
  })

  it('przegląd r2 B, ważna 2: zaznaczony zestaw z aktywną ofertą i jego składnik zostają aktywne, powód dla obu', async () => {
    const skladnik = await prod(a, 'G-1')
    const zestaw = await a.product.create({ data: { sku: 'ZESTAW-G', title: 'Zestaw G', kind: 'BUNDLE', unit: 'SZT', nameAccounting: 'Zestaw G' } })
    await a.bundleComponent.create({ data: { bundleId: zestaw.id, componentId: skladnik, qtyBase: 1 } })
    await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'konto', externalId: 'G1', productId: zestaw.id, mappingSource: 'MANUAL' } })
    const historia = () => a.auditLog.count({ where: { entity: 'Product', entityId: { in: [zestaw.id, skladnik] } } })
    const przed = await historia()
    const r = await ustawAktywnosc(a, [zestaw.id, skladnik], false, USER)
    expect(r).toMatchObject({ ok: true, value: { zmienione: 0 } })
    if (!r.ok) return
    expect(Object.fromEntries(r.value.odmowy.map((x) => [x.sku, x.powod]))).toEqual({ 'ZESTAW-G': expect.stringContaining('aktywną ofertę'), 'G-1': expect.stringContaining('ZESTAW-G') })
    expect(await aktywne([zestaw.id, skladnik])).toEqual(['G-1:true', 'ZESTAW-G:true'])
    expect(await historia()).toBe(przed) // bez wpisu „active” w historii
  })

  it('przegląd r2 B, drobna 4: pozycja zdjęta w kanale (removed) nie blokuje wyłączenia', async () => {
    const p = await prod(a, 'H-1')
    const o = await a.order.create({ data: { channel: 'WOO', channelAccountId: 'konto', externalId: 'Z-200', status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: 10, createdAtChannel: T } })
    await a.orderLine.create({ data: { orderId: o.id, externalLineId: 'L1', productId: p, qty: 1, unitPriceGross: 10, removed: true } })
    expect(await ustawAktywnosc(a, [p], false, USER)).toMatchObject({ ok: true, value: { zmienione: 1, odmowy: [] } })
  })

  it('walidacja i izolacja: puste, złe id; firma B nie zmieni produktu A', async () => {
    const p = await prod(a, 'C-1')
    expect(await ustawAktywnosc(a, [], false, USER)).toMatchObject({ ok: false })
    expect(await ustawAktywnosc(a, ['zly id!'], false, USER)).toMatchObject({ ok: false })
    expect(await ustawAktywnosc(b, [p], false, USER)).toMatchObject({ ok: false })
    expect(await aktywne([p])).toEqual(['C-1:true'])
  })
})

describe('CSV: kolumna „Aktywny”', () => {
  it('eksport → „tak” na „nie” → import wyłącza; ponowny import = 0 zmian; pusta nic nie zmienia; zła wartość = błąd wiersza', async () => {
    const { importCsv, eksportCsv } = await import('@/lib/produkty/csv')
    const p1 = await prod(a, 'D-1')
    const p2 = await prod(a, 'D-2')
    await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'konto', externalId: 'Y1', productId: p2, mappingSource: 'MANUAL' } })
    const { tekst } = await eksportCsv(a)
    const zmieniony = linia(linia(tekst, 'D-1', 'tak', 'nie'), 'D-2', 'tak', 'nie')
    expect(zmieniony).not.toBe(tekst)
    const r = await importCsv(a, zmieniony, USER, { hasWfirma: false })
    expect(r).toMatchObject({ zmienione: 1, bezZmian: 1, bledy: [] })
    if ('blad' in r) return
    expect(r.uwagi.filter((u) => u.sku === 'D-2').map((u) => u.komunikat).join(' | ')).toContain('aktywną ofertę')
    expect(await aktywne([p1, p2])).toEqual(['D-1:false', 'D-2:true'])
    // eksport → import po zmianie nic nie zmienia
    expect(await importCsv(a, (await eksportCsv(a)).tekst, USER, { hasWfirma: false })).toMatchObject({ zmienione: 0, bezZmian: 2, bledy: [] })
    expect(await importCsv(a, 'SKU;Aktywny\nD-1;\nD-2;może', USER, { hasWfirma: false })).toMatchObject({ bezZmian: 1, bledy: [{ sku: 'D-2' }] })
    expect(await aktywne([p1, p2])).toEqual(['D-1:false', 'D-2:true'])
    // nowy produkt z „nie” powstaje wyłączony; włączenie przez CSV
    expect(await importCsv(a, 'SKU;Nazwa;Cena brutto;Aktywny\nD-3;Nowy;10,00;nie', USER, { hasWfirma: false })).toMatchObject({ nowe: 1, bledy: [] })
    expect((await a.product.findFirstOrThrow({ where: { sku: 'D-3' } })).active).toBe(false)
    expect(await importCsv(a, 'SKU;Aktywny\nD-1;tak', USER, { hasWfirma: false })).toMatchObject({ zmienione: 1 })
    expect(await aktywne([p1])).toEqual(['D-1:true'])
  })
})

describe('„Pobierz oferty” nie podpina oferty pod wyłączony produkt', () => {
  it('oferta z SKU wyłączonego produktu zostaje do przypisania; po włączeniu się łączy', async () => {
    const p = await prod(a, 'E-1')
    await ustawAktywnosc(a, [p], false, USER)
    const wiersze: ChannelOfferRow[] = [{ externalId: '701', sku: 'E-1', ean: null, name: 'Oferta testowa 701', qty: 1, active: true }]
    const atrapa = { manifest: { capabilities: ['offers.read'] }, listOffers: async () => ({ items: wiersze, nextCursor: null }) } as unknown as ChannelAdapter
    await pobierzOferty(a, ACC.WOO_SD, atrapa, { hasBl: false, hasWfirma: false, actorId: 'test', now: T })
    expect(await a.channelOffer.count({ where: { productId: p } })).toBe(0)
    expect(await a.channelOfferRead.findFirstOrThrow({ where: { externalId: '701' } })).toMatchObject({ state: 'BEZ_PRODUKTU', note: expect.stringContaining('wyłączony') })
    expect(await a.product.count({ where: { sku: { equals: 'E-1', mode: 'insensitive' } } })).toBe(1) // nie założył duplikatu
    await ustawAktywnosc(a, [p], true, USER)
    await pobierzOferty(a, ACC.WOO_SD, atrapa, { hasBl: false, hasWfirma: false, actorId: 'test', now: T })
    expect(await a.channelOffer.count({ where: { productId: p, active: true } })).toBe(1)
  })
})
