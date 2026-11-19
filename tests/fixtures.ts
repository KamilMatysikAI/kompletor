// Dane testowe: zmyślone produkty i zamówienia. Żadnych prawdziwych danych klientów ani sklepu.
import type { RawSources } from '@/lib/import/katalog'
import type { BlProd, ChannelMap, SaleLine, ShopOffer, WfGood } from '@/lib/import/normalizacja'

/** Kanały firmy testowej w imporcie z BL (te same konta co w seed/acme.ts — tylko identyfikatory, bez kluczy). */
/** Konta „<kanał>|<konto>” firmy testowej (walidacja tabeli nadpisań). */
export const testKnownAccounts = () => new Set(Object.keys(TEST_CHANNEL_MAP.names ?? {}))

export const TEST_CHANNEL_MAP: ChannelMap = {
  shopAccounts: ['7100001', '7100002', '7100003'],
  empikAccountId: '30193',
  names: { 'WOO|7100001': 'SklepDemo', 'WOO|7100002': 'HurtDemo', 'WOO|7100003': 'KolorowyKubek', 'ALLEGRO|71045': 'Allegro', 'EMPIK|30193': 'Empik' },
}

export function wf(over: Partial<WfGood> & { id: string }): WfGood {
  return {
    code: null,
    name: `Towar ${over.id}`,
    type: 'set',
    unit: 'SZT',
    unitRaw: 'szt.',
    vatCodeId: '222',
    vatRate: '23',
    priceNetRetail: 10,
    priceGrossRetail: 12.3,
    purchasePriceNet: 5,
    count: 10,
    countBase: 10,
    warehouseId: '900014',
    ean: null,
    visibility: 'visible',
    modified: '2026-10-01 10:00:00',
    ...over,
  }
}

export function bl(over: Partial<BlProd> & { id: string }): BlProd {
  return {
    parentId: null,
    hasVariants: false,
    sku: null,
    ean: null,
    eanRaw: null,
    eanValid: false,
    name: `Produkt ${over.id}`,
    isBundle: false,
    bundleProducts: null,
    taxRate: 23,
    priceGross: 12.3,
    stockAccounting: 10,
    stockBl: 0,
    links: {},
    wfirmaGoodIdLink: null,
    locations: null,
    ...over,
  }
}

export function shop(over: Partial<ShopOffer> & { productId: string }): ShopOffer {
  return {
    storageId: 'shop_7100001',
    externalId: over.variantId ? `${over.productId}/${over.variantId}` : over.productId,
    variantId: null,
    sku: null,
    ean: null,
    name: `Oferta ${over.productId}`,
    isParentWithVariants: false,
    ...over,
  }
}

let seq = 0
export function sale(over: Partial<SaleLine>): SaleLine {
  return {
    channel: 'ALLEGRO',
    accountId: '71045',
    orderId: String(++seq),
    soldAt: new Date('2026-10-01T10:00:00Z'),
    storage: 'db',
    storageId: '77701',
    productId: null,
    variantId: null,
    auctionId: null,
    sku: null,
    ean: null,
    name: 'pozycja',
    qty: 1,
    ...over,
  }
}

/** Mały, spójny zestaw: 3 towary wFirmy, 4 produkty BL (w tym zestaw), oferty Woo/Allegro/Empik. */
export function smallRaw(): RawSources {
  const goods = [
    wf({ id: '100', code: 'A1', name: 'Przyprawa A 100 g', count: 7, countBase: 7 }),
    wf({ id: '200', code: 'B1', name: 'Przyprawa B luz', unit: 'KG', unitRaw: 'kg', count: 2.5, countBase: 2500 }),
    wf({ id: '300', code: 'C1', name: 'Opakowanie C', type: 'good', count: 40, countBase: 40 }),
  ]
  const products = [
    bl({ id: '1', sku: 'A1', name: 'Przyprawa A 100g', wfirmaGoodIdLink: '100', links: { shop_7100001: { productId: '501', variantId: '0' }, accounting_1: { productId: '100', variantId: '0' } } }),
    bl({ id: '2', sku: 'B1', name: 'Przyprawa B', wfirmaGoodIdLink: '200', stockAccounting: 2 }),
    bl({ id: '3', sku: 'C1', name: 'Opakowanie C', wfirmaGoodIdLink: '300' }),
    bl({ id: '4', sku: 'A1-zestaw', name: 'Zestaw A + C', isBundle: true, bundleProducts: { '1': 1, '3': 2 } }),
  ]
  return {
    fetchedAt: '2026-10-22T10:00:00.000Z',
    salesDays: 90,
    channels: TEST_CHANNEL_MAP,
    bl: { inventoryId: '77701', priceGroupId: '51999', products, integrations: {} },
    shopOffers: [shop({ productId: '501', sku: 'A1' }), shop({ productId: '502', sku: 'X9', name: 'Bez powiązania' })],
    sales: {
      lines: [
        sale({ channel: 'WOO', accountId: '7100001', productId: '1', auctionId: '77' }),
        sale({ channel: 'ALLEGRO', productId: '2', auctionId: '9001', qty: 3 }),
        sale({ channel: 'ALLEGRO', productId: null, auctionId: '9002', qty: 5, name: 'Oferta bez powiązania' }),
        sale({ channel: 'EMPIK', accountId: '30193', productId: '3', auctionId: 'p777' }),
      ],
      orders: 4,
      oldestUnix: 1_790_000_000,
      sinceUnix: 1_789_000_000,
    },
    wfirma: { goods, total: 3 },
    empik: [{ externalId: '777', offerId: '1', shopSku: 'C1', ean: null, name: 'Opakowanie C', active: true, quantity: 1 }],
    issues: [],
  }
}
