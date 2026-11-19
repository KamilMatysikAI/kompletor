// reguły katalogu firmy — produkt bez stanu (e-book) i dodatki z magazynu bez oferty. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { bl, sale, shop, smallRaw } from '@/tests/fixtures'
import { EMPTY_RULES, parseCatalogRules, type CatalogRules } from './bez-stanu'
import { analyze } from './katalog'
import { shopOffersFromApi } from './normalizacja'
import { renderReport } from './raport'

const rules = (over: Partial<CatalogRules>): CatalogRules => ({ ...EMPTY_RULES, ...over })
const threshold = (md: string) => Number(/bez jednoznacznego powiązania = (\d+)/.exec(md)![1])
const report = (raw: ReturnType<typeof smallRaw>, a: ReturnType<typeof analyze>) => renderReport(raw, a, { generatedAt: new Date('2026-10-22T12:00:00Z') }).markdown

/** smallRaw + e-book w sklepie SD (bez produktu w BL i wFirmie) sprzedany w oknie. */
function withEbook() {
  const raw = smallRaw()
  raw.shopOffers.push(shop({ productId: '9100', sku: 'ebook-test', name: 'Poradnik przyprawowy (e-book)', categoryId: '77' }))
  raw.sales.lines.push(
    sale({ channel: 'WOO', accountId: '7100001', storage: 'shop', storageId: 'shop_7100001', productId: '9100', sku: 'ebook-test', qty: 2 }),
    sale({ channel: 'WOO', accountId: '7100001', storage: 'shop', storageId: 'shop_7100001', productId: '9100', sku: 'ebook-test', qty: 1 }),
  )
  return raw
}

describe('parseCatalogRules', () => {
  it('czyta listy z settings.catalog, śmieci i puste pomija', () => {
    expect(parseCatalogRules({ noStock: { skus: [' ebook1 ', '', 5, 'ebook1'], shopCategories: ['7100001:12'] }, nonOfferSkus: ['naklejka'] })).toEqual({
      noStockSkus: ['ebook1'],
      noStockShopCategories: ['7100001:12'],
      nonOfferSkus: ['naklejka'],
    })
    expect(parseCatalogRules(undefined)).toEqual(EMPTY_RULES)
    expect(parseCatalogRules({ noStock: 'ebook1' })).toEqual(EMPTY_RULES)
  })
})

describe('kategoria produktu sklepu z BL', () => {
  it('category_id trafia do oferty i wariantów; 0 albo brak = bez kategorii', () => {
    const offers = shopOffersFromApi('shop_7100001', { product_id: 10, name: 'E', category_id: 77, variants: [{ variant_id: 11, name: 'PDF' }] })
    expect(offers.map((o) => o.categoryId)).toEqual(['77', '77'])
    expect(shopOffersFromApi('shop_7100001', { product_id: 12, name: 'X', category_id: 0 })[0]).not.toHaveProperty('categoryId')
  })
})

describe('produkt bez stanu (e-book)', () => {
  it('bez reguły e-book jest brakiem ze sprzedażą; z regułą po SKU — powiązany z produktem DIGITAL i poza progiem', () => {
    const raw = withEbook()
    const before = analyze(raw)
    expect(before.offers.find((o) => o.externalId === '9100')).toMatchObject({ state: 'UNMAPPED', sales90dQty: 3 })
    const base = threshold(report(raw, before))

    const a = analyze(raw, [], rules({ noStockSkus: ['ebook-test'] }))
    const o = a.offers.find((x) => x.externalId === '9100')!
    expect(o).toMatchObject({ state: 'MAPPED', source: 'CONFIG', productKey: 'digital:ebook-test', sales90dQty: 3, sales90dOrders: 2 })
    const p = a.plan.products.find((x) => x.key === 'digital:ebook-test')!
    expect(p).toMatchObject({ kind: 'DIGITAL', sku: 'ebook-test', unit: 'SZT', wf: null, blIds: [], location: null })
    expect(a.catalogRules.noStock).toHaveLength(1)
    const md = report(raw, a)
    expect(threshold(md)).toBe(base - 1)
    expect(md).toContain('## Produkty bez stanu i dodatki bez oferty (reguły firmy)')
  })

  it('reguła po kategorii sklepu (konto:kategoria); ta sama kategoria w innym sklepie nie wchodzi', () => {
    const raw = withEbook()
    raw.shopOffers.push(shop({ productId: '9200', storageId: 'shop_7100002', sku: null, name: 'E-book w innym sklepie', categoryId: '77' }))
    const a = analyze(raw, [], rules({ noStockShopCategories: ['7100001:77'] }))
    expect(a.offers.find((x) => x.externalId === '9100')).toMatchObject({ state: 'MAPPED', source: 'CONFIG' })
    expect(a.offers.find((x) => x.externalId === '9200')).toMatchObject({ state: 'UNMAPPED', source: 'NONE' })
  })

  it('nazwa „e-book” bez SKU ani kategorii z konfiguracji nie wystarcza', () => {
    const raw = smallRaw()
    raw.shopOffers.push(shop({ productId: '9300', sku: null, name: 'E-book: przyprawa od podstaw' }))
    const a = analyze(raw, [], rules({ noStockSkus: ['ebook-test'] }))
    expect(a.offers.find((x) => x.externalId === '9300')).toMatchObject({ state: 'UNMAPPED' })
    expect(a.plan.products.some((p) => p.kind === 'DIGITAL')).toBe(false)
  })

  it('SKU ze spacjami: normalizacja przycina, a oferta spoza niej i tak trafia po trim', () => {
    expect(shopOffersFromApi('shop_7100001', { product_id: 9400, name: 'E', sku: ' ebook-test ' })[0]!.sku).toBe('ebook-test')
    const raw = smallRaw()
    raw.shopOffers.push(shop({ productId: '9400', sku: ' ebook-test ', name: 'Poradnik (e-book)' }))
    const a = analyze(raw, [], rules({ noStockSkus: ['ebook-test'] }))
    expect(a.offers.find((x) => x.externalId === '9400')).toMatchObject({ state: 'MAPPED', source: 'CONFIG', productKey: 'digital:ebook-test' })
    expect(a.plan.products.find((p) => p.kind === 'DIGITAL')).toMatchObject({ sku: 'ebook-test' })
  })

  it('usługa wFirmy o kodzie = SKU daje nazwę księgową i VAT; towar (good) o tym kodzie nie', () => {
    const raw = withEbook()
    raw.wfirma!.goods.push({ ...raw.wfirma!.goods[0]!, id: '900', code: 'ebook-test', name: 'E-book usługa', type: 'service', vatRate: '5' })
    const a = analyze(raw, [], rules({ noStockSkus: ['ebook-test'] }))
    expect(a.plan.products.find((p) => p.kind === 'DIGITAL')!.wf).toMatchObject({ id: '900', type: 'service' })
  })

  it('SKU z reguły jest w katalogu produktem ze stanem → konflikt, oferta zostaje w progu', () => {
    const raw = smallRaw()
    raw.shopOffers.push(shop({ productId: '9400', sku: 'A1', name: 'Oferta bez linku' }))
    raw.shopOffers[0]!.sku = 'A1'
    raw.bl.products.push(bl({ id: '5', sku: 'A1', name: 'Duplikat A1', wfirmaGoodIdLink: '100' })) // SKU wieloznaczne → nie MAPPED
    const a = analyze(raw, [], rules({ noStockSkus: ['A1'] }))
    expect(a.offers.find((x) => x.externalId === '501')!.state).toBe('MAPPED') // oferta z linkiem BL nietknięta
    const o = a.offers.find((x) => x.externalId === '9400')!
    expect(o.state).toBe('AMBIGUOUS')
    expect(a.catalogRules.conflicts.map((c) => c.offer.externalId)).toEqual(['9400'])
    expect(a.plan.products.some((p) => p.kind === 'DIGITAL')).toBe(false)
  })
})

describe('dodatek z magazynu bez oferty (naklejka, banderola)', () => {
  it('pozycja „bl:<id>” w sklepie z SKU z reguły jest poza progiem; prawdziwa oferta z tym SKU dalej się liczy', () => {
    const raw = smallRaw()
    raw.bl.products.push(bl({ id: '60', sku: 'naklejka-test', name: 'Naklejka', wfirmaGoodIdLink: '300' }))
    raw.sales.lines.push(
      sale({ channel: 'WOO', accountId: '7100001', storage: 'db', productId: '60', sku: 'naklejka-test', qty: 9 }),
      sale({ channel: 'ALLEGRO', productId: null, auctionId: '9555', sku: 'naklejka-test', qty: 1 }),
    )
    const before = analyze(raw)
    expect(before.offers.find((o) => o.externalId === 'bl:60')).toMatchObject({ state: 'UNMAPPED', sales90dQty: 9 })
    const base = threshold(report(raw, before))

    const a = analyze(raw, [], rules({ nonOfferSkus: ['naklejka-test'] }))
    expect(a.offers.find((o) => o.externalId === 'bl:60')).toMatchObject({ state: 'UNMAPPED', nonOffer: true })
    expect(a.offers.find((o) => o.externalId === '9555')).toMatchObject({ state: 'UNMAPPED' })
    expect(a.offers.find((o) => o.externalId === '9555')!.nonOffer).toBeUndefined()
    expect(threshold(report(raw, a))).toBe(base - 1)
  })
})
