// produkt uniwersalny — firma bez wFirmy i bez BL zakłada produkt ze stanem, bez stanu i zestaw; edycja
// karty (pola z wFirmy tylko do odczytu), skład zestawu, zdjęcia (wgranie, kolejność, usunięcie do archiwum w bazie, izolacja firm),
// zdjęcia z oferty sklepu w workerze, propozycja z oferty sklepu. Dane wyłącznie fikcyjne.
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { zalozProdukt } from '@/lib/kanaly/produkt'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { addProduct } from '@/lib/produkty/dodawanie'
import { edytujProdukt, edytujSklad, zalozProduktReczny } from '@/lib/produkty/karta'
import { dodajZdjecia, glowneZdjecia, miniaturyDoWydruku, plikZdjecia, usunZdjecie, zadanieZdjecZOferty, zdjeciaProduktu, zlecZdjeciaZOferty, zmienZdjecie, ZDJECIA_Z_OFERTY_JOB } from '@/lib/produkty/zdjecia'
import { dostepneZrodla, ofertaPoId, zOferty } from '@/lib/produkty/zrodla'
import { handlers } from '@/lib/worker/zadania'
import { ORG_B, seedImportConfig, testDb, truncateAll } from './db'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const USER = 'uzytkownik-testowy-a115'
const DIR = mkdtempSync(path.join(tmpdir(), 'kompletor-zdjecia-'))
const ENV = { ZDJECIA_DIR: DIR }
const prevDir = process.env['ZDJECIA_DIR']

beforeAll(() => {
  process.env['ZDJECIA_DIR'] = DIR
})
afterAll(async () => {
  if (prevDir === undefined) delete process.env['ZDJECIA_DIR']
  else process.env['ZDJECIA_DIR'] = prevDir
  await a.$disconnect()
  await b.$disconnect()
})

async function firma(wfirma = false) {
  if (wfirma) return seedImportConfig()
  await a.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)' } })
}

const png = (color: string, w = 300, h = 200) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer()

beforeEach(async () => {
  await truncateAll()
})

describe('Dodaj produkt bez wFirmy i bez BaseLinkera', () => {
  it('towar ze stanem: dane, netto, stan startowy, lokalizacja, waga, wymiary, źródło RECZNE i audyt', async () => {
    await firma()
    const z = await dostepneZrodla(a)
    expect(z).toEqual({ wfirma: false, oferta: false, bl: false })
    const r = await zalozProduktReczny(
      a,
      {
        rodzaj: 'zwykly',
        sku: ' KUB-001 ',
        unit: 'SZT',
        stanPoczatkowy: '12',
        form: { nazwa: 'Kubek testowy', ean: '5901234123457', cena: '24,60', vat: '23', cenaZakupu: '8,5', waga: '350', dlugosc: '10', szerokosc: '9,5', wysokosc: '12', lokalizacja: 'A-1-2', prog: '3', opis: 'Kubek do testów.' },
      },
      USER,
      { hasWfirma: false },
    )
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) return
    const p = await a.product.findUniqueOrThrow({ where: { id: r.productId }, include: { stocks: true, movements: true } })
    expect(p).toMatchObject({ sku: 'KUB-001', kind: 'STOCKED', unit: 'SZT', dataSource: 'RECZNE', title: 'Kubek testowy', nameAccounting: 'Kubek testowy', ean: '5901234123457', vatRate: '23', weightG: 350, lowStockThreshold: 3, description: 'Kubek do testów.' })
    expect(p.priceGross?.toString()).toBe('24.6')
    expect(p.priceNet?.toString()).toBe('20')
    expect(p.purchasePriceNet?.toString()).toBe('8.5')
    expect(p.widthCm?.toString()).toBe('9.5')
    expect(p.stocks[0]).toMatchObject({ physical: 12, wfirmaCount: 12, reserved: 0, location: 'A-1-2' })
    expect(p.movements[0]).toMatchObject({ source: 'INITIAL_IMPORT', deltaPhysical: 12, actorId: USER })
    expect(await a.auditLog.count({ where: { entity: 'Product', entityId: p.id } })).toBe(1)
  })

  it('towar na wagę: stan w kg zapisany w gramach', async () => {
    await firma()
    const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'HERB-KG', unit: 'KG', stanPoczatkowy: '1,25', form: { nazwa: 'Przyprawa na wagę' } }, USER, { hasWfirma: false })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(await a.stock.findFirstOrThrow({ where: { productId: r.productId } })).toMatchObject({ physical: 1250 })
  })

  it('bez stanu: produkt DIGITAL bez Stock i SKU na liście bez stanu; zestaw ze składnikami i udziałem w cenie', async () => {
    await firma()
    const e = await zalozProduktReczny(a, { rodzaj: 'bez-stanu', sku: 'EBOOK-T', form: { nazwa: 'E-book testowy', cena: '49', vat: '5' } }, USER, { hasWfirma: false })
    expect(e.ok).toBe(true)
    if (!e.ok) return
    expect(await a.stock.count({ where: { productId: e.productId } })).toBe(0)
    const org = await a.organization.findFirstOrThrow({ select: { settings: true } })
    expect(JSON.stringify(org.settings)).toContain('EBOOK-T')

    const k1 = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'S1', stanPoczatkowy: '10', form: { nazwa: 'Składnik 1' } }, USER, { hasWfirma: false })
    const k2 = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'S2', stanPoczatkowy: '3', form: { nazwa: 'Składnik 2' } }, USER, { hasWfirma: false })
    if (!k1.ok || !k2.ok) throw new Error('składniki')
    const zestaw = await zalozProduktReczny(
      a,
      { rodzaj: 'zestaw', sku: 'ZEST-1', form: { nazwa: 'Zestaw testowy', cena: '60', vat: '23' }, sklad: { ids: [k1.productId, k2.productId], ilosci: ['2', '1'], udzialy: ['60', '40'] } },
      USER,
      { hasWfirma: false },
    )
    expect(zestaw.ok).toBe(true)
    if (!zestaw.ok) return
    const bc = await a.bundleComponent.findMany({ where: { bundleId: zestaw.productId }, orderBy: { qtyBase: 'desc' } })
    expect(bc.map((c) => [c.componentId, c.qtyBase, c.priceShare?.toString()])).toEqual([
      [k1.productId, 2, '0.6'],
      [k2.productId, 1, '0.4'],
    ])
    // e-book nie może być składnikiem, udziały muszą sumować się do 100%, zestaw bez składnika
    const zly = await zalozProduktReczny(a, { rodzaj: 'zestaw', sku: 'ZEST-2', form: { nazwa: 'Zły' }, sklad: { ids: [e.productId], ilosci: ['1'], udzialy: [''] } }, USER, { hasWfirma: false })
    expect(zly).toMatchObject({ ok: false, field: 'sklad' })
    const zly2 = await zalozProduktReczny(a, { rodzaj: 'zestaw', sku: 'ZEST-3', form: { nazwa: 'Zły 2' }, sklad: { ids: [k1.productId, k2.productId], ilosci: ['1', '1'], udzialy: ['50', '20'] } }, USER, { hasWfirma: false })
    expect(zly2).toMatchObject({ ok: false, field: 'sklad' })
    const pusty = await zalozProduktReczny(a, { rodzaj: 'zestaw', sku: 'ZEST-4', form: { nazwa: 'Pusty' }, sklad: { ids: [], ilosci: [], udzialy: [] } }, USER, { hasWfirma: false })
    expect(pusty).toMatchObject({ ok: false, field: 'sklad' })
  })

  it('walidacja: SKU zajęte (link do produktu), zły EAN, zła stawka VAT, brak nazwy; nic nie powstaje', async () => {
    await firma()
    const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'DUP', form: { nazwa: 'Pierwszy' } }, USER, { hasWfirma: false })
    if (!r.ok) throw new Error('pierwszy')
    expect(await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'DUP', form: { nazwa: 'Drugi' } }, USER, { hasWfirma: false })).toMatchObject({ ok: false, field: 'sku', istniejacyId: r.productId })
    expect(await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'X1', form: { nazwa: 'X', ean: '5901234123450' } }, USER, { hasWfirma: false })).toMatchObject({ ok: false, field: 'ean' })
    expect(await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'X2', form: { nazwa: 'X', vat: '22' } }, USER, { hasWfirma: false })).toMatchObject({ ok: false, field: 'vat' })
    expect(await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'X3', form: { nazwa: '' } }, USER, { hasWfirma: false })).toMatchObject({ ok: false, field: 'nazwa' })
    expect(await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'X4', stanPoczatkowy: '-1', form: { nazwa: 'X' } }, USER, { hasWfirma: false })).toMatchObject({ ok: false, field: 'stan' })
    expect(await a.product.count()).toBe(1)
  })

  it('firma z wFirmą: towar ze stanem tylko przez „Pobierz z wFirmy”; ścieżka wFirmy daje produkt WFIRMA', async () => {
    await firma(true)
    expect(await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'W-1', form: { nazwa: 'Ręczny' } }, USER, { hasWfirma: true })).toMatchObject({ ok: false, field: 'rodzaj' })
    expect((await zalozProduktReczny(a, { rodzaj: 'bez-stanu', sku: 'USL-1', form: { nazwa: 'Usługa' } }, USER, { hasWfirma: true })).ok).toBe(true)
    const run = await a.importRun.create({ data: { kind: 'katalog-bl-wfirma', status: 'OK' } })
    await a.wfirmaGood.create({ data: { id: '900', code: 'WF-9', name: 'Towar wFirmy', type: 'good', unit: 'szt.', vatRate: '23', priceNetRetail: '10', priceGrossRetail: '12.3', count: '4', warehouseId: '900014', importRunId: run.id } })
    const w = await addProduct(a, { sku: 'WF-9', rodzaj: 'wfirma' }, USER)
    expect(w).toMatchObject({ ok: true, created: true })
    if (!w.ok) return
    expect(await a.product.findUniqueOrThrow({ where: { id: w.productId } })).toMatchObject({ dataSource: 'WFIRMA', wfirmaGoodId: '900' })
    expect((await a.product.findFirstOrThrow({ where: { sku: 'USL-1' } })).dataSource).toBe('RECZNE')
  })
})

describe('Karta produktu: edycja i historia', () => {
  it('produkt bez wFirmy: wszystkie pola edytowalne, nazwa księgowa za nazwą, netto przeliczone, audyt przed i po', async () => {
    await firma()
    const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'ED-1', stanPoczatkowy: '1', form: { nazwa: 'Stara nazwa', cena: '10' } }, USER, { hasWfirma: false })
    if (!r.ok) throw new Error('produkt')
    const e = await edytujProdukt(a, r.productId, { nazwa: 'Nowa nazwa', vat: '8', cena: '10,80', waga: '120', lokalizacja: 'B-2-1', ean: '' }, USER)
    expect(e).toMatchObject({ ok: true })
    const p = await a.product.findUniqueOrThrow({ where: { id: r.productId }, include: { stocks: true } })
    expect(p).toMatchObject({ title: 'Nowa nazwa', nameAccounting: 'Nowa nazwa', vatRate: '8', weightG: 120 })
    expect(p.priceNet?.toString()).toBe('10')
    expect(p.stocks[0]!.location).toBe('B-2-1')
    const h = await a.auditLog.findFirstOrThrow({ where: { entity: 'Product', entityId: r.productId, before: { not: undefined } }, orderBy: { createdAt: 'desc' } })
    expect(h.before).toMatchObject({ title: 'Stara nazwa', vatRate: null, priceGross: 10 })
    expect(h.after).toMatchObject({ title: 'Nowa nazwa', vatRate: '8', priceGross: 10.8, location: 'B-2-1' })
    // drugi zapis bez zmian: bez nowego wpisu
    const n = await a.auditLog.count({ where: { entityId: r.productId } })
    expect(await edytujProdukt(a, r.productId, { nazwa: 'Nowa nazwa', vat: '8' }, USER)).toMatchObject({ ok: true, zmiany: [] })
    expect(await a.auditLog.count({ where: { entityId: r.productId } })).toBe(n)
  })

  it('produkt z wFirmy: ceny, VAT i nazwa księgowa zostają z wFirmy, nazwa w panelu i waga się zmieniają', async () => {
    await firma(true)
    const run = await a.importRun.create({ data: { kind: 'katalog-bl-wfirma', status: 'OK' } })
    await a.wfirmaGood.create({ data: { id: '901', code: 'WF-1', name: 'Nazwa księgowa', type: 'good', unit: 'szt.', vatRate: '23', priceNetRetail: '10', priceGrossRetail: '12.3', count: '2', warehouseId: '900014', importRunId: run.id } })
    const w = await addProduct(a, { sku: 'WF-1', rodzaj: 'wfirma' }, USER)
    if (!w.ok) throw new Error('wfirma')
    const e = await edytujProdukt(a, w.productId, { nazwa: 'Nazwa w sklepie', cena: '99', vat: '5', cenaZakupu: '1', waga: '80' }, USER)
    expect(e).toMatchObject({ ok: true, zmiany: ['title', 'weightG'] })
    const p = await a.product.findUniqueOrThrow({ where: { id: w.productId } })
    expect(p).toMatchObject({ title: 'Nazwa w sklepie', nameAccounting: 'Nazwa księgowa', vatRate: '23', weightG: 80 })
    expect(p.priceGross?.toString()).toBe('12.3')
  })

  it('produkt z oferty sklepu: cena i VAT z oferty, uzupełnienie VAT w karcie', async () => {
    await firma()
    const p = await a.$transaction((tx) => zalozProdukt(tx, { sku: 'OF-1', name: 'Z oferty', ean: null, priceGross: 21.5, vatRate: null }))
    const row = await a.product.findUniqueOrThrow({ where: { id: p.id } })
    expect(row).toMatchObject({ dataSource: 'KANAL', vatRate: null })
    expect(row.priceGross?.toString()).toBe('21.5')
    expect(await edytujProdukt(a, p.id, { vat: '23' }, USER)).toMatchObject({ ok: true, zmiany: ['vatRate'] })
    const after = await a.product.findUniqueOrThrow({ where: { id: p.id } })
    expect(after.vatRate).toBe('23')
    expect(after.priceNet?.toString()).toBe('17.48')
  })

  it('skład zestawu: zmiana w panelu, zestaw z BaseLinkera zablokowany', async () => {
    await firma()
    const k1 = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'K1', stanPoczatkowy: '5', form: { nazwa: 'K1' } }, USER, { hasWfirma: false })
    const k2 = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'K2', stanPoczatkowy: '5', form: { nazwa: 'K2' } }, USER, { hasWfirma: false })
    if (!k1.ok || !k2.ok) throw new Error('k')
    const z = await zalozProduktReczny(a, { rodzaj: 'zestaw', sku: 'Z1', form: { nazwa: 'Z1' }, sklad: { ids: [k1.productId], ilosci: ['1'], udzialy: [''] } }, USER, { hasWfirma: false })
    if (!z.ok) throw new Error('z')
    expect(await edytujSklad(a, z.productId, { ids: [k1.productId, k2.productId], ilosci: ['2', '3'], udzialy: ['', ''] }, USER)).toMatchObject({ ok: true })
    expect(await a.bundleComponent.count({ where: { bundleId: z.productId } })).toBe(2)
    expect(await edytujSklad(a, z.productId, { ids: [z.productId], ilosci: ['1'], udzialy: [''] }, USER)).toMatchObject({ ok: false })
    await a.product.update({ where: { id: z.productId }, data: { dataSource: 'BL' } })
    expect(await edytujSklad(a, z.productId, { ids: [k1.productId], ilosci: ['1'], udzialy: [''] }, USER)).toMatchObject({ ok: false })
  })
})

describe('Zdjęcia produktu', () => {
  it('wgranie wielu, główne, kolejność, usunięcie do archiwum, miniatura do wydruku, izolacja firm', async () => {
    await firma()
    const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'ZDJ-1', form: { nazwa: 'Ze zdjęciami' } }, USER, { hasWfirma: false })
    if (!r.ok) throw new Error('p')
    const w = await dodajZdjecia(a, r.productId, [{ bytes: await png('#c00'), nazwa: 'a.png' }, { bytes: Buffer.from('<svg></svg>'), nazwa: 'zly.png' }, { bytes: await png('#00c'), nazwa: 'b.png' }], USER)
    expect(w.dodane).toHaveLength(2)
    expect(w.bledy).toEqual([{ plik: 'zly.png', komunikat: expect.stringContaining('SVG') }])
    const [first, second] = w.dodane
    // bajty w bazie, nic na dysku
    expect(readdirSync(DIR)).toEqual([])
    expect(await a.productImageData.count({ where: { productId: r.productId, archivedAt: null } })).toBe(2)
    expect((await glowneZdjecia(a, [r.productId])).get(r.productId)).toBe(first)
    const meta = await sharp((await plikZdjecia(a, first!, 'o', ENV))!.bytes).metadata()
    expect(meta).toMatchObject({ format: 'webp', width: 300, height: 200 })
    expect(meta.exif).toBeUndefined()
    const druk = (await miniaturyDoWydruku(a, [r.productId], ENV)).get(r.productId)!
    expect(druk.length).toBeLessThan(50 * 1024)
    expect(await sharp(druk).metadata()).toMatchObject({ format: 'jpeg', width: 96, height: 96 })

    expect(await zmienZdjecie(a, second!, 'glowne', USER)).toBe(r.productId)
    expect((await zdjeciaProduktu(a, r.productId)).map((z) => z.id)).toEqual([second, first])
    expect(await zmienZdjecie(a, second!, 'w-prawo', USER)).toBe(r.productId)
    expect((await zdjeciaProduktu(a, r.productId)).map((z) => z.id)).toEqual([first, second])

    // inna firma nie widzi zdjęcia (RLS) ani nie usunie
    expect(await plikZdjecia(b, first!, 'm', ENV)).toBeNull()
    expect(await usunZdjecie(b, first!, USER)).toBeNull()

    expect(await usunZdjecie(a, first!, USER)).toBe(r.productId)
    expect(await zdjeciaProduktu(a, r.productId)).toMatchObject([{ id: second, position: 0 }])
    // usunięte zdjęcie: poza produktem, bajty zostają w archiwum (nic nie jest kasowane)
    expect(await plikZdjecia(a, first!, 'o', ENV)).toBeNull()
    expect(await a.productImageData.findUniqueOrThrow({ where: { imageId: first! } })).toMatchObject({ archivedAt: expect.any(Date) })
  })

  it('zdjęcia z oferty sklepu: zadanie workera, adres wewnętrzny odrzucony, błąd jednego nie blokuje, bez dubli', async () => {
    await firma()
    const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'WOO-1', form: { nazwa: 'Z Woo' } }, USER, { hasWfirma: false })
    if (!r.ok) throw new Error('p')
    await zlecZdjeciaZOferty(a, r.productId, ['https://sklep.example/z1.png', 'http://sklep.example/z2.png', 'https://localhost/x.png'])
    const job = await a.job.findFirstOrThrow({ where: { kind: ZDJECIA_Z_OFERTY_JOB } })
    expect(job.payload).toEqual({ productId: r.productId, urls: ['https://sklep.example/z1.png'] })
    expect(handlers[ZDJECIA_Z_OFERTY_JOB]).toBeTypeOf('function')
    const img = await png('#0a0')
    const calls: string[] = []
    const fakeFetch = (async (u: URL | string) => {
      calls.push(String(u))
      if (String(u).endsWith('/z1.png')) return new Response(new Uint8Array(img), { status: 200, headers: { 'content-type': 'image/png' } })
      return new Response('nie ma', { status: 404 })
    }) as typeof fetch
    const lookup = async (h: string) => (h === 'wewnetrzny.example' ? ['192.168.1.10'] : ['93.184.216.34'])
    const payload = { productId: r.productId, urls: ['https://sklep.example/z1.png', 'https://sklep.example/brak.png', 'https://10.0.0.1/a.png', 'https://wewnetrzny.example/a.png'] }
    const w = await zadanieZdjecZOferty(a, payload, { fetch: fakeFetch, lookup })
    expect(w.dodane).toHaveLength(1)
    expect(w.bledy).toHaveLength(3)
    expect(calls).toEqual(['https://sklep.example/z1.png', 'https://sklep.example/brak.png'])
    expect(await a.auditLog.count({ where: { entityId: r.productId, actorId: 'system:zdjecia-z-oferty' } })).toBeGreaterThanOrEqual(2)
    // drugi przebieg nie dubluje zdjęcia
    const w2 = await zadanieZdjecZOferty(a, { productId: r.productId, urls: ['https://sklep.example/z1.png'] }, { fetch: fakeFetch, lookup })
    expect(w2.dodane).toHaveLength(0)
    expect(await a.productImage.count({ where: { productId: r.productId } })).toBe(1)
  })
})

describe('Pobierz z oferty sklepu', () => {
  it('propozycja z odczytu oferty: nazwa, SKU, EAN, cena, VAT, stan, zdjęcia; oferta powiązana ma link do produktu', async () => {
    await firma()
    const run = 'run-a115'
    const read = await a.channelOfferRead.create({
      data: { channel: 'WOO', channelAccountId: 'sklep1', externalId: '501', sku: 'HERB-5', ean: '5901234123457', name: 'Przyprawa z oferty', qty: 7, priceGross: '19.90', vatRate: '5', imageUrls: ['https://sklep.example/h5.jpg'], state: 'BEZ_PRODUKTU', runId: run, seenAt: new Date() },
    })
    expect((await dostepneZrodla(a)).oferta).toBe(true)
    const po = await zOferty(a, '5901234123457')
    expect(po).toMatchObject([{ typ: 'KANAL', ref: read.id, sku: 'HERB-5', title: 'Przyprawa z oferty', priceGross: 19.9, vatRate: '5', stan: 7, imageUrls: ['https://sklep.example/h5.jpg'], productId: null }])
    const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'HERB-5', stanPoczatkowy: '7', form: { nazwa: 'Przyprawa z oferty', cena: '19,90', vat: '5' }, zrodlo: { typ: 'KANAL', ref: read.id } }, USER, { hasWfirma: false })
    if (!r.ok) throw new Error('p')
    expect((await a.product.findUniqueOrThrow({ where: { id: r.productId } })).dataSource).toBe('KANAL')
    // powiązanie z ofertą powstaje razem z produktem
    expect(await a.channelOffer.findFirstOrThrow({ where: { channel: 'WOO', channelAccountId: 'sklep1', externalId: '501' } })).toMatchObject({ productId: r.productId, active: true, mappingSource: 'MANUAL' })
    expect(await ofertaPoId(a, read.id)).toMatchObject({ productId: r.productId })
  })
})
