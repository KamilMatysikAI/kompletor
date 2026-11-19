// poprawki po przeglądzie (06.11.2026):
//  zdjęcie z telefonu (≥ 2 MB) przez akcję serwera `akcjaZdjec` (stan akcji zamiast parametrów adresu), nie przez dodajZdjecia wprost;
//  produkt założony z oferty sklepu dostaje powiązanie z ofertą w tej samej transakcji (także po zmianie SKU);
//  edycja SKU (RECZNE/KANAL/CSV) z walidacją, „SKU zajęte” i historią; WFIRMA/BL tylko do odczytu.
// Dane wyłącznie fikcyjne.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { edytujProdukt, zalozProduktReczny } from '@/lib/produkty/karta'
import { plikZdjecia, zdjeciaProduktu } from '@/lib/produkty/zdjecia'
import { testDb, truncateAll } from './db'

const a = testDb()
const USER = 'uzytkownik-testowy-a115p'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`)
  },
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
}))
vi.mock('@/lib/panel/kontekst', () => ({
  requirePermission: async () => ({ db: a, user: { id: USER }, permissions: new Set(['produkty.dodawanie']) }),
  requireSession: async () => ({ db: a, user: { id: USER }, permissions: new Set(['produkty.dodawanie']) }),
}))

const DIR = mkdtempSync(path.join(tmpdir(), 'kompletor-zdjecia-p-'))
const prevDir = process.env['ZDJECIA_DIR']
beforeAll(() => {
  process.env['ZDJECIA_DIR'] = DIR
})
afterAll(async () => {
  if (prevDir === undefined) delete process.env['ZDJECIA_DIR']
  else process.env['ZDJECIA_DIR'] = prevDir
  await a.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await a.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)' } })
})

async function produkt(sku = 'ZDJ-1') {
  const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku, stanPoczatkowy: '1', form: { nazwa: `Produkt ${sku}` } }, USER, { hasWfirma: false })
  if (!r.ok) throw new Error(r.error)
  return r.productId
}

/** JPEG jak z telefonu: szum, wysoka jakość, kilka MB. */
const zdjecieZTelefonu = () => sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 70 } } }).jpeg({ quality: 97 }).toBuffer()

describe('zdjęcie ≥ 2 MB przez akcję serwera', () => {
  it('akcjaZdjec przyjmuje plik z telefonu, zapisuje go od nowa i wraca z komunikatem „dodane”', async () => {
    const { akcjaZdjec } = await import('@/app/(panel)/produkty/[id]/produkt-akcje')
    const id = await produkt()
    const bytes = await zdjecieZTelefonu()
    expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024)
    const form = new FormData()
    form.set('produkt', id)
    form.set('co', 'wgraj')
    form.append('zdjecia', new File([new Uint8Array(bytes)], 'IMG_2041.jpg', { type: 'image/jpeg' }))
    expect(await akcjaZdjec({ ok: false, komunikat: null }, form)).toEqual({ ok: true, komunikat: 'Zdjęcie dodane.' })
    const z = await zdjeciaProduktu(a, id)
    expect(z).toHaveLength(1)
    const plik = await plikZdjecia(a, z[0]!.id, 'm')
    expect(plik).not.toBeNull()
  })

  it('pliki razem ponad limit żądania: komunikat osłony, nic nie zapisane', async () => {
    const { akcjaZdjec } = await import('@/app/(panel)/produkty/[id]/produkt-akcje')
    const id = await produkt()
    const form = new FormData()
    form.set('produkt', id)
    form.set('co', 'wgraj')
    const duzy = Buffer.alloc(14 * 1024 * 1024)
    for (let i = 0; i < 5; i++) form.append('zdjecia', new File([new Uint8Array(duzy)], `d${i}.jpg`))
    expect(await akcjaZdjec({ ok: false, komunikat: null }, form)).toMatchObject({ ok: false, komunikat: expect.stringContaining('kilku turach') })
    expect(await zdjeciaProduktu(a, id)).toHaveLength(0)
  })

  it('usunięcie i zmiana kolejności wracają komunikatem w stanie akcji, bez przekierowania', async () => {
    const { akcjaZdjec } = await import('@/app/(panel)/produkty/[id]/produkt-akcje')
    const { dodajZdjecia } = await import('@/lib/produkty/zdjecia')
    const id = await produkt()
    const png = (c: string) => sharp({ create: { width: 200, height: 200, channels: 3, background: c } }).png().toBuffer()
    const r = await dodajZdjecia(a, id, [{ bytes: await png('#111'), nazwa: '1.png' }, { bytes: await png('#eee'), nazwa: '2.png' }], USER)
    const f = (co: string, zdjecie: string) => {
      const form = new FormData()
      form.set('co', co)
      form.set('zdjecie', zdjecie)
      return form
    }
    const start = { ok: false, komunikat: null }
    expect(await akcjaZdjec(start, f('glowne', r.dodane[1]!))).toEqual({ ok: true, komunikat: 'Ustawione jako główne.' })
    expect((await zdjeciaProduktu(a, id)).map((z) => z.id)).toEqual([r.dodane[1], r.dodane[0]])
    expect(await akcjaZdjec(start, f('usun', r.dodane[0]!))).toEqual({ ok: true, komunikat: 'Zdjęcie usunięte z produktu (kopia zostaje w archiwum).' })
    expect(await akcjaZdjec(start, f('usun', r.dodane[0]!))).toMatchObject({ ok: false, komunikat: expect.stringContaining('odśwież') })
    expect(await akcjaZdjec(start, f('cos-innego', r.dodane[1]!))).toMatchObject({ ok: false })
    expect(await zdjeciaProduktu(a, id)).toHaveLength(1)
  })
})

describe('produkt z oferty sklepu dostaje powiązanie z ofertą', () => {
  const oferta = (externalId: string, sku: string | null) =>
    a.channelOfferRead.create({
      data: { channel: 'WOO', channelAccountId: 'sklep1', externalId, sku, name: 'Przyprawa z oferty', qty: 4, priceGross: '19.90', vatRate: '5', imageUrls: ['https://sklep.example/h.jpg'], state: 'BEZ_PRODUKTU', runId: 'run-a115p', seenAt: new Date() },
    })

  it('poprawione SKU: oferta i tak powiązana (MANUAL), odczyt POWIAZANA, zdjęcia zlecone w tej samej transakcji, ostrzeżenie o SKU', async () => {
    const read = await oferta('601', 'HERB-6')
    const r = await zalozProduktReczny(
      a,
      { rodzaj: 'zwykly', sku: 'HERB-6-POPR', stanPoczatkowy: '4', form: { nazwa: 'Przyprawa z oferty', cena: '19,90', vat: '5' }, zrodlo: { typ: 'KANAL', ref: read.id }, zdjeciaZOferty: ['https://sklep.example/h.jpg'] },
      USER,
      { hasWfirma: false },
    )
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) return
    expect(r.warnings.join(' ')).toContain('SKU różni się od SKU w ofercie (HERB-6)')
    expect(await a.channelOffer.findFirstOrThrow({ where: { externalId: '601' } })).toMatchObject({ productId: r.productId, active: true, mappingSource: 'MANUAL', qtyBasePerOffer: 1 })
    expect((await a.channelOfferRead.findUniqueOrThrow({ where: { id: read.id } })).state).toBe('POWIAZANA')
    expect(await a.job.count({ where: { kind: 'produkt-zdjecia-z-oferty' } })).toBe(1)
    expect(await a.auditLog.count({ where: { entity: 'ChannelOffer' } })).toBe(1)
  })

  it('oferta już powiązana: odmowa z linkiem do produktu, nic nie powstaje', async () => {
    const read = await oferta('602', 'HERB-7')
    const first = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'HERB-7', form: { nazwa: 'H7' }, zrodlo: { typ: 'KANAL', ref: read.id } }, USER, { hasWfirma: false })
    if (!first.ok) throw new Error(first.error)
    const again = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'HERB-7-B', form: { nazwa: 'H7 b' }, zrodlo: { typ: 'KANAL', ref: read.id } }, USER, { hasWfirma: false })
    expect(again).toMatchObject({ ok: false, field: 'zrodlo', istniejacyId: first.productId })
    expect(await a.product.count({ where: { sku: 'HERB-7-B' } })).toBe(0)
  })
})

describe('edycja SKU', () => {
  it('RECZNE: zmiana SKU zapisana z historią; SKU zajęte (także inną wielkością liter) = odmowa z id; puste = błąd pola', async () => {
    const id = await produkt('LITER-1')
    const other = await produkt('ZAJETE-1')
    expect(await edytujProdukt(a, id, { sku: ' POPR-1 ' }, USER)).toMatchObject({ ok: true, zmiany: ['sku'] })
    expect((await a.product.findUniqueOrThrow({ where: { id } })).sku).toBe('POPR-1')
    const h = await a.auditLog.findFirstOrThrow({ where: { entity: 'Product', entityId: id }, orderBy: { createdAt: 'desc' } })
    expect(h).toMatchObject({ before: { sku: 'LITER-1' }, after: { sku: 'POPR-1' } })
    expect(await edytujProdukt(a, id, { sku: 'zajete-1' }, USER)).toMatchObject({ ok: false, field: 'sku', istniejacyId: other })
    expect(await edytujProdukt(a, id, { sku: '' }, USER)).toMatchObject({ ok: false, field: 'sku' })
    expect((await a.product.findUniqueOrThrow({ where: { id } })).sku).toBe('POPR-1')
  })

  it('bez stanu: lista SKU bez stanu idzie za nowym SKU', async () => {
    const r = await zalozProduktReczny(a, { rodzaj: 'bez-stanu', sku: 'EBOOK-1', form: { nazwa: 'E-book' } }, USER, { hasWfirma: false })
    if (!r.ok) throw new Error(r.error)
    expect(await edytujProdukt(a, r.productId, { sku: 'EBOOK-PL' }, USER)).toMatchObject({ ok: true })
    const { readNoStock } = await import('@/lib/produkty/bez-stanu')
    const ns = await readNoStock(a)
    expect(ns.skus).toContain('EBOOK-PL')
    expect(ns.skus).not.toContain('EBOOK-1')
  })

  it('WFIRMA i BL: SKU tylko do odczytu (ignorowane jak ceny z wFirmy)', async () => {
    const id = await produkt('WF-SKU')
    for (const ds of ['WFIRMA', 'BL'] as const) {
      await a.product.update({ where: { id }, data: { dataSource: ds } })
      expect(await edytujProdukt(a, id, { sku: 'INNE-SKU' }, USER)).toMatchObject({ ok: true, zmiany: [] })
      expect((await a.product.findUniqueOrThrow({ where: { id } })).sku).toBe('WF-SKU')
    }
  })
})

// (katalog zdjęć wspólny dla panelu i workera) zastąpione zdjęciami w bazie: tests/zdjecia-w-bazie.integration.test.ts
