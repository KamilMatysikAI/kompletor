import { describe, expect, it } from 'vitest'
import { bl, sale, shop, smallRaw, TEST_CHANNEL_MAP, wf } from '@/tests/fixtures'
import { analyze } from './katalog'
import {
  aggregateSales,
  classifyEmpik,
  classifyFromSales,
  classifyShopOffers,
  compareWithWfirma,
  duplicates,
  planCatalog,
} from './mapowanie'

const SHOPS = TEST_CHANNEL_MAP.shopAccounts

describe('planCatalog', () => {
  it('link BL → wFirma wygrywa z SKU, konflikt jest raportowany', () => {
    const goods = [wf({ id: '1', code: 'X' }), wf({ id: '2', code: 'Y' })]
    const plan = planCatalog([bl({ id: 'a', sku: 'Y', wfirmaGoodIdLink: '1' })], goods)
    expect(plan.products).toHaveLength(1)
    expect(plan.products[0]!.wf!.id).toBe('1')
    expect(plan.blMatch.get('a')).toBe('LINK')
    expect(plan.linkSkuConflicts).toHaveLength(1)
  })

  it('bez linku: SKU, potem EAN; brak = lista „bez wFirmy”', () => {
    const goods = [wf({ id: '1', code: 'S' }), wf({ id: '2', code: 'T', ean: '5905515787796' })]
    const plan = planCatalog(
      [bl({ id: 'a', sku: 'S' }), bl({ id: 'b', sku: 'zzz', ean: '5905515787796' }), bl({ id: 'c', sku: 'nic' })],
      goods,
    )
    expect(plan.blMatch.get('a')).toBe('SKU')
    expect(plan.blMatch.get('b')).toBe('EAN')
    expect(plan.blWithoutWfirma.map((p) => p.id)).toEqual(['c'])
  })

  it('dwa rekordy BL na jeden towar → jeden produkt, oba wskazują go', () => {
    const plan = planCatalog(
      [bl({ id: 'a', sku: '3325', wfirmaGoodIdLink: '1' }), bl({ id: 'b', sku: '03325', wfirmaGoodIdLink: '1' })],
      [wf({ id: '1', code: '03325' })],
    )
    expect(plan.products).toHaveLength(1)
    expect(plan.blToKey.get('a')).toBe(plan.blToKey.get('b'))
    expect(plan.manyBlToOneWf).toHaveLength(1)
    expect(plan.products[0]!.sku).toBe('03325')
  })

  it('usługa w wFirmie nie jest produktem ze stanem', () => {
    const plan = planCatalog([bl({ id: 'a', sku: 'U' })], [wf({ id: '1', code: 'U', type: 'service' })])
    expect(plan.products).toHaveLength(0)
    expect(plan.serviceMatches).toHaveLength(1)
  })

  it('zestaw wirtualny: składniki w jednostce bazowej (kg → g); brak składnika = problem, zestaw nie powstaje', () => {
    const goods = [wf({ id: '1', code: 'K', unit: 'KG' }), wf({ id: '2', code: 'S' })]
    const plan = planCatalog(
      [
        bl({ id: 'k', sku: 'K', wfirmaGoodIdLink: '1' }),
        bl({ id: 's', sku: 'S', wfirmaGoodIdLink: '2' }),
        bl({ id: 'z1', sku: 'Z1', isBundle: true, bundleProducts: { k: 0.1, s: 2 } }),
        bl({ id: 'z2', sku: 'Z2', isBundle: true, bundleProducts: { k: 1, brak: 1 } }),
      ],
      goods,
    )
    const z1 = plan.products.find((p) => p.sku === 'Z1')!
    expect(z1.kind).toBe('BUNDLE')
    expect(z1.components).toEqual([
      { componentKey: 'wf:1', qtyBase: 100 },
      { componentKey: 'wf:2', qtyBase: 2 },
    ])
    expect(plan.products.find((p) => p.sku === 'Z2')).toBeUndefined()
    expect(plan.bundleProblems[0]!.problem).toContain('brak')
  })

  it('kolizja SKU (zestaw o SKU towaru) dostaje sufiks', () => {
    const plan = planCatalog(
      [bl({ id: 'a', sku: 'A', wfirmaGoodIdLink: '1' }), bl({ id: 'z', sku: 'A', isBundle: true, bundleProducts: { a: 1 } })],
      [wf({ id: '1', code: 'A' })],
    )
    expect(plan.products.map((p) => p.sku).sort()).toEqual(['A', 'A~bundle-z'])
    expect(plan.skuCollisions).toHaveLength(1)
  })

  it('rodzic z wariantami nie jest produktem, warianty tak (groupId)', () => {
    const plan = planCatalog(
      [bl({ id: 'r', sku: 'R', hasVariants: true }), bl({ id: 'v', parentId: 'r', sku: 'R-1', wfirmaGoodIdLink: '1' })],
      [wf({ id: '1', code: 'R-1' })],
    )
    expect(plan.products).toHaveLength(1)
    expect(plan.products[0]!.groupId).toBe('r')
  })
})

describe('sklepy Woo', () => {
  const blList = [
    bl({ id: '1', sku: 'A', links: { shop_7100001: { productId: '10', variantId: '0' } } }),
    bl({ id: '2', sku: 'B', links: { shop_7100001: { productId: '20', variantId: '21' } } }),
    bl({ id: '3', sku: 'C', links: { shop_7100001: { productId: '30', variantId: '0' } } }),
    bl({ id: '4', sku: 'C2', links: { shop_7100001: { productId: '30', variantId: '0' } } }),
    bl({ id: '5', sku: 'D' }),
  ]
  it('link, wariant, wieloznaczny, po SKU, brak; rodzic pominięty', () => {
    const offers = [
      shop({ productId: '10', sku: 'A' }),
      shop({ productId: '20', isParentWithVariants: true }),
      shop({ productId: '20', variantId: '21', sku: 'B' }),
      shop({ productId: '30', sku: 'C' }),
      shop({ productId: '40', sku: 'D' }),
      shop({ productId: '50', sku: 'nie-ma' }),
    ]
    const r = classifyShopOffers(offers, blList, new Map(), undefined, SHOPS)
    const by = Object.fromEntries(r.map((o) => [o.externalId, o]))
    expect(r).toHaveLength(5)
    expect(by['10']).toMatchObject({ state: 'MAPPED', source: 'BL_LINK', blProductIds: ['1'] })
    expect(by['20/21']).toMatchObject({ state: 'MAPPED', blProductIds: ['2'] })
    expect(by['30']).toMatchObject({ state: 'AMBIGUOUS' })
    expect(by['40']).toMatchObject({ state: 'MAPPED', source: 'SKU', blProductIds: ['5'] })
    expect(by['50']).toMatchObject({ state: 'UNMAPPED', source: 'NONE' })
  })

  it('sprzedaż z magazynu BL przypisana do oferty przez link; ze sklepu bez linku = brak powiązania', () => {
    const lines = [
      sale({ channel: 'WOO', accountId: '7100001', productId: '1', qty: 2 }),
      sale({ channel: 'WOO', accountId: '7100001', storage: 'shop', productId: '60', qty: 4 }),
    ]
    const sales = aggregateSales(lines, blList)
    const r = classifyShopOffers([shop({ productId: '10', sku: 'A' })], blList, sales, undefined, SHOPS)
    expect(r.find((o) => o.externalId === '10')).toMatchObject({ sales90dQty: 2, sales90dOrders: 1 })
    expect(r.find((o) => o.externalId === '60')).toMatchObject({ state: 'UNMAPPED', sales90dQty: 4 })
  })
})

describe('brak fałszywych MAPPED', () => {
  it('produkt BL spoza katalogu (usunięty / bez wFirmy) → UNMAPPED z notatką', () => {
    const r = classifyFromSales(aggregateSales([sale({ auctionId: 'o9', productId: '999' })], []), ['ALLEGRO'], new Set(['1']))
    expect(r[0]).toMatchObject({ state: 'UNMAPPED', blProductIds: ['999'] })
    expect(r[0]!.notes.join()).toContain('usunięty')
  })
  it('sprzedaż Woo z magazynu BL bez linku do sklepu (bl:<id>) → UNMAPPED', () => {
    const blList = [bl({ id: '7', sku: 'N' })]
    const sales = aggregateSales([sale({ channel: 'WOO', accountId: '7100001', productId: '7', qty: 5 })], blList)
    const r = classifyShopOffers([], blList, sales, new Set(['7']), SHOPS)
    expect(r[0]).toMatchObject({ externalId: 'bl:7', state: 'UNMAPPED', sales90dQty: 5 })
  })
  it('zestaw w zestawie jest odrzucany', () => {
    const plan = planCatalog(
      [
        bl({ id: 's', sku: 'S', wfirmaGoodIdLink: '1' }),
        bl({ id: 'z1', sku: 'Z1', isBundle: true, bundleProducts: { s: 1 } }),
        bl({ id: 'z2', sku: 'Z2', isBundle: true, bundleProducts: { z1: 1 } }),
      ],
      [wf({ id: '1', code: 'S' })],
    )
    expect(plan.products.map((p) => p.sku).sort()).toEqual(['S', 'Z1'])
    expect(plan.bundleProblems[0]!.problem).toContain('zestaw w zestawie')
  })
})

describe('Allegro i Empik', () => {
  it('Allegro ze sprzedaży: zmapowane, bez powiązania, wieloznaczne', () => {
    const lines = [
      sale({ auctionId: 'o1', productId: '1' }),
      sale({ auctionId: 'o1', productId: '1' }),
      sale({ auctionId: 'o2', productId: null }),
      sale({ auctionId: 'o3', productId: '1' }),
      sale({ auctionId: 'o3', productId: '2' }),
      sale({ auctionId: 'o4', productId: '7', variantId: '8' }),
    ]
    const r = classifyFromSales(aggregateSales(lines, []), ['ALLEGRO'])
    const by = Object.fromEntries(r.map((o) => [o.externalId, o]))
    expect(by['o1']).toMatchObject({ state: 'MAPPED', sales90dQty: 2, sales90dOrders: 2 })
    expect(by['o2']).toMatchObject({ state: 'UNMAPPED' })
    expect(by['o3']).toMatchObject({ state: 'AMBIGUOUS' })
    expect(by['o4']!.blProductIds).toEqual(['8']) // wariant BL ma własne id produktu
  })

  it('pozycje ręczne bez oferty grupują się po SKU, nie w jedną „0”', () => {
    const lines = [
      sale({ channel: 'RECZNE', accountId: '0', auctionId: null, sku: 'L1' }),
      sale({ channel: 'RECZNE', accountId: '0', auctionId: null, sku: 'L2' }),
    ]
    const r = classifyFromSales(aggregateSales(lines, []), ['RECZNE'])
    expect(r.map((o) => o.externalId).sort()).toEqual(['sku:L1', 'sku:L2'])
  })

  it('Empik: po sprzedaży BL i po shop_sku; sprzedaż spoza OF21 dopisana', () => {
    const blList = [bl({ id: '1', sku: 'A' }), bl({ id: '2', sku: 'B' })]
    const sales = aggregateSales(
      [
        sale({ channel: 'EMPIK', accountId: '30193', auctionId: 'p100', productId: '1' }),
        sale({ channel: 'EMPIK', accountId: '30193', auctionId: 'p300', productId: '2' }),
      ],
      blList,
    )
    const r = classifyEmpik(
      [
        { externalId: '100', offerId: '1', shopSku: 'A', ean: null, name: 'a', active: true, quantity: 1 },
        { externalId: '200', offerId: '2', shopSku: 'B', ean: null, name: 'b', active: false, quantity: 0 },
      ],
      '30193',
      blList,
      sales,
    )
    const by = Object.fromEntries(r.map((o) => [o.externalId, o]))
    expect(by['100']).toMatchObject({ state: 'MAPPED', source: 'BL_ORDERS', sales90dQty: 1 })
    expect(by['200']).toMatchObject({ state: 'MAPPED', source: 'SKU' })
    expect(by['200']!.notes).toContain('oferta nieaktywna na Empiku')
    expect(by['300']!.notes).toContain('brak na liście ofert Empiku (OF21)')
  })
})

describe('zgodność z wFirmą i duplikaty', () => {
  it('VAT, cena; stan kg porównany po obcięciu jak w BL', () => {
    const goods = [
      wf({ id: '1', code: 'A', vatRate: '8', priceGrossRetail: 10 }),
      wf({ id: '2', code: 'K', unit: 'KG', count: 11.86, priceGrossRetail: 5 }),
    ]
    const blList = [
      bl({ id: 'a', sku: 'A', wfirmaGoodIdLink: '1', taxRate: 5, priceGross: 12, stockAccounting: 10 }),
      bl({ id: 'k', sku: 'K', wfirmaGoodIdLink: '2', taxRate: 23, priceGross: 5, stockAccounting: 11, name: 'Towar 2' }),
      bl({ id: 'x', sku: 'X' }),
    ]
    const plan = planCatalog(blList, goods)
    const c = compareWithWfirma(plan, blList)
    expect(c.checked).toBe(3)
    expect(c.withoutCounterpart.map((p) => p.id)).toEqual(['x'])
    const a = c.diffs.find((d) => d.bl.id === 'a')!
    expect(a.vatDiff).toEqual({ bl: 5, wf: '8' })
    expect(a.priceDiff).toEqual({ bl: 12, wf: 10 })
    expect(c.diffs.find((d) => d.bl.id === 'k')).toBeUndefined()
  })

  it('duplikaty po kluczu, puste pomijane', () => {
    const d = duplicates([{ k: 'a' }, { k: 'a' }, { k: null }, { k: null }, { k: 'b' }], (x) => x.k)
    expect([...d.keys()]).toEqual(['a'])
  })
})

describe('analyze na małym zestawie', () => {
  it('liczy produkty, zestaw i oferty wszystkich kanałów', () => {
    const a = analyze(smallRaw())
    expect(a.plan.products.filter((p) => p.kind === 'STOCKED')).toHaveLength(3)
    expect(a.plan.products.filter((p) => p.kind === 'BUNDLE')).toHaveLength(1)
    const states = a.offers.map((o) => `${o.channel}:${o.externalId}:${o.state}`).sort()
    expect(states).toEqual(['ALLEGRO:9001:MAPPED', 'ALLEGRO:9002:UNMAPPED', 'EMPIK:777:MAPPED', 'WOO:501:MAPPED', 'WOO:502:UNMAPPED'])
  })
})
