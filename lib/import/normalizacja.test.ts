import { describe, expect, it } from 'vitest'
import {
  blProdFromApi,
  channelOfOrder,
  empikOfferFromApi,
  fromBlOrder,
  isValidGtin,
  normalizeEan,
  shopOffersFromApi,
  toBase,
  wfGoodFromApi,
  type ChannelMap,
} from './normalizacja'

const MAP: ChannelMap = { shopAccounts: ['7100001', '7100002'], empikAccountId: '30193' }

describe('jednostki', () => {
  it('kg → gramy bez obcinania ułamków (11,86 kg = 11 860 g)', () => {
    expect(toBase(11.86, 'KG')).toBe(11860)
    expect(toBase(0.001, 'KG')).toBe(1)
  })
  it('sztuki: całe, w dół; brak = 0', () => {
    expect(toBase(3, 'SZT')).toBe(3)
    expect(toBase(2.9999999999, 'SZT')).toBe(3)
    expect(toBase(2.5, 'SZT')).toBe(2)
    expect(toBase(null, 'SZT')).toBe(0)
  })
})

describe('EAN', () => {
  it('suma kontrolna GTIN', () => {
    expect(isValidGtin('5905515787796')).toBe(true)
    expect(isValidGtin('5905515787797')).toBe(false)
    expect(isValidGtin('96385074')).toBe(true)
    expect(isValidGtin('5905800551')).toBe(false)
  })
  it('obcina spacje i odrzuca błędny', () => {
    expect(normalizeEan('5905745683691 ')).toEqual({ ean: '5905745683691', raw: '5905745683691', valid: true })
    expect(normalizeEan('123')).toMatchObject({ ean: null, valid: false, raw: '123' })
    expect(normalizeEan('')).toMatchObject({ ean: null, raw: null })
  })
})

describe('wFirma: towar', () => {
  const vat = new Map([['223', '8']])
  const raw = {
    id: '9',
    code: ' 01148 ',
    name: 'Przyprawa okazjonalna',
    type: 'set',
    unit: 'kg',
    netto: '2.57',
    count: '1.5000',
    value: '30.00',
    vat_code: { id: 223 },
    warehouse: { id: 900014 },
    good_prices: {
      '0': { good_price: { netto: '19.27', brutto: '23.70', name: 'detaliczna' } },
      '1': { good_price: { netto: '0.00', brutto: '0.00', name: 'yms' } },
    },
  }
  it('cena sprzedaży z grupy „detaliczna”, nie z pola netto (to cena zakupu)', () => {
    const g = wfGoodFromApi(raw, vat)
    expect(g.priceNetRetail).toBe(19.27)
    expect(g.priceGrossRetail).toBe(23.7)
  })
  it('cena zakupu = wartość / ilość, stan w gramach, VAT ze słownika', () => {
    const g = wfGoodFromApi(raw, vat)
    expect(g.purchasePriceNet).toBe(20)
    expect(g.unit).toBe('KG')
    expect(g.countBase).toBe(1500)
    expect(g.vatRate).toBe('8')
    expect(g.code).toBe('01148')
    expect(g.warehouseId).toBe('900014')
  })
  it('zerowy stan → brak ceny zakupu (bez dzielenia przez 0)', () => {
    expect(wfGoodFromApi({ ...raw, count: '0.0000' }, vat).purchasePriceNet).toBeNull()
  })
})

describe('BL: produkt', () => {
  it('linki, stan accounting_1, cena z domyślnej grupy', () => {
    const [p] = blProdFromApi(
      '212598263',
      {
        sku: '02857',
        ean: '5905515787796',
        text_fields: { name: 'Kolorowa Papryka' },
        tax_rate: 23,
        prices: { '51999': 47 },
        stock: { bl_70898: 0, accounting_1: 13 },
        links: {
          shop_7100003: { product_id: '2837', variant_id: '0' },
          accounting_1: { product_id: '32836677', variant_id: '0' },
          shop_x: { product_id: '0', variant_id: '0' },
        },
        is_bundle: false,
      },
      '51999',
    )
    expect(p).toMatchObject({ sku: '02857', priceGross: 47, stockAccounting: 13, stockBl: 0, wfirmaGoodIdLink: '32836677', name: 'Kolorowa Papryka' })
    expect(Object.keys(p!.links)).toEqual(['shop_7100003', 'accounting_1'])
  })
  it('warianty z pola variants rodzica → osobne produkty z parentId', () => {
    const out = blProdFromApi(
      '10',
      { sku: 'R', text_fields: { name: 'Rodzic' }, variants: { '11': { sku: 'R-50', name: '50g', stock: { accounting_1: 3 } } } },
      '1',
    )
    expect(out).toHaveLength(2)
    expect(out[0]!.hasVariants).toBe(true)
    expect(out[1]).toMatchObject({ id: '11', parentId: '10', sku: 'R-50', stockAccounting: 3, name: 'Rodzic 50g' })
  })
  it('zestaw: składniki z ilościami', () => {
    const [p] = blProdFromApi('5', { is_bundle: true, bundle_products: { '1': 1, '2': '2', '3': 0 } }, '1')
    expect(p!.bundleProducts).toEqual({ '1': 1, '2': 2 })
  })
})

describe('sklep i Empik', () => {
  it('warianty Woo → osobne oferty, rodzic oznaczony', () => {
    const out = shopOffersFromApi('shop_1', {
      product_id: 7,
      name: 'Przyprawa',
      sku: '',
      variants: [{ variant_id: '70', sku: '03293', name: '50g' }],
    })
    expect(out.map((o) => o.externalId)).toEqual(['7', '7/70'])
    expect(out[0]!.isParentWithVariants).toBe(true)
  })
  it('Empik: externalId = product_sku, EAN z referencji', () => {
    const o = empikOfferFromApi({
      offer_id: 1,
      shop_sku: '02856',
      product_sku: '1455788707',
      product_title: 'X',
      active: false,
      quantity: 0,
      product_references: [{ reference: '5905515787789', reference_type: 'EAN' }],
    })
    expect(o).toMatchObject({ externalId: '1455788707', shopSku: '02856', ean: '5905515787789', active: false })
  })
})

describe('zamówienia BL: bez danych osobowych', () => {
  const order = {
    order_id: 123,
    order_source: 'shop',
    order_source_id: 7100001,
    date_confirmed: 1_790_000_000,
    email: 'jan.testowy@example.test',
    phone: '+48 600 000 000',
    delivery_fullname: 'Jan Testowy',
    delivery_address: 'ul. Zmyślona 1',
    invoice_nip: '0000000000',
    user_comments: 'proszę zadzwonić',
    products: [
      { storage: 'db', storage_id: 77701, product_id: '358247351', variant_id: '0', auction_id: '50065', sku: '02482', ean: '', quantity: 2, name: 'Kardamon' },
      { storage: 'db', storage_id: 77701, product_id: '0', variant_id: '0', auction_id: '0', sku: '02897', ean: '', quantity: 1, name: 'Lizak' },
    ],
  }
  it('linia sprzedaży nie zawiera danych klienta', () => {
    const lines = fromBlOrder(order, MAP)
    const json = JSON.stringify(lines)
    for (const pd of ['jan.testowy', '600 000', 'Testowy', 'Zmyślona', '0000000000', 'zadzwonić']) expect(json).not.toContain(pd)
    expect(lines[0]).toMatchObject({ channel: 'WOO', accountId: '7100001', productId: '358247351', variantId: null, qty: 2, orderId: '123' })
  })
  it('auction_id „0” i product_id „0” → brak', () => {
    const [, l] = fromBlOrder(order, MAP)
    expect(l).toMatchObject({ auctionId: null, productId: null })
  })
  it('kanały', () => {
    expect(channelOfOrder('allegro', '71045', MAP)).toEqual({ channel: 'ALLEGRO', accountId: '71045' })
    expect(channelOfOrder('shop', '7100002', MAP)).toEqual({ channel: 'WOO', accountId: '7100002' })
    expect(channelOfOrder('shop', '999', MAP).channel).toBe('BL_INNE')
    expect(channelOfOrder('tiktokeu', '43635', MAP)).toEqual({ channel: 'BL_INNE', accountId: 'tiktokeu:43635' })
    expect(channelOfOrder('personal', '0', MAP).channel).toBe('RECZNE')
  })
})
