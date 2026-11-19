// Atrapa BaseLinkera dla przeprowadzki: wszystkie metody z listy (lib/przeprowadzka/metody.ts), dane
// wyłącznie fikcyjne. Zamówienia niosą wartowników „danych osobowych” (PII_SENTINELS z suity kontraktowej adapterów)
// w polach klienta i w nieznanym polu — test sprawdza, że żaden nie wychodzi poza parser. Zero połączeń z prawdziwym BL.
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import { BlPrzeprowadzka } from '@/lib/przeprowadzka/metody'
import type { FetchLike } from '@/lib/zrodla/http'

export { PII_SENTINELS }

export const NOW = new Date('2026-11-02T10:00:00Z')
const T = (daysAgo: number) => Math.floor(NOW.getTime() / 1000) - daysAgo * 86_400

/** Pola klienta zamówienia BL z wartownikami (każdy wartownik co najmniej raz). */
export function polaKlienta(): Record<string, unknown> {
  const [name, email, phone, street, nip] = PII_SENTINELS
  return {
    email,
    phone,
    user_login: email,
    delivery_fullname: name,
    delivery_company: name,
    delivery_address: street,
    delivery_city: street,
    delivery_postcode: phone,
    delivery_point_name: street,
    delivery_point_address: street,
    invoice_fullname: name,
    invoice_company: name,
    invoice_nip: nip,
    invoice_address: street,
    comment: `${name} ${phone}`,
    user_comments: `Proszę dzwonić: ${phone}`,
    admin_comments: nip,
    extra_field_1: email,
    // pole, którego BL dziś nie ma — parser musi je odrzucić tak samo jak znane
    nowe_pole_bl: { osoba: name, kontakt: email },
  }
}

export interface AtrapaProdukt {
  id: number
  sku?: string
  ean?: string
  name: string
  stock: number
  links?: Record<string, { product_id: string; variant_id: string }>
  bundle?: Record<string, number>
}

export const PRODUKTY: AtrapaProdukt[] = [
  { id: 1001, sku: 'HER-001', ean: '5901234123457', name: 'Przyprawa czarna 100 g', stock: 12, links: { shop_9001: { product_id: '501', variant_id: '0' } } },
  { id: 1002, sku: 'HER-002', name: 'Przyprawa zielona 100 g', stock: 5 },
  { id: 1003, name: 'Produkt bez SKU', stock: 3 },
  { id: 1004, sku: 'DUP-1', name: 'Kubek A', stock: 1 },
  { id: 1005, sku: 'DUP-1', name: 'Kubek B', stock: 2 },
  { id: 1006, sku: 'ZEST-1', name: 'Zestaw dwóch czarnych', stock: 0, bundle: { '1001': 2 } },
]

export const STATUSY = [
  { id: 1, name: 'Nowe zamówienia' },
  { id: 2, name: 'Do wysłania' },
  { id: 3, name: 'Wysłane' },
  { id: 4, name: 'Anulowane' },
  { id: 5, name: 'Status Xyz' },
]

const pozycja = (id: number, p: Record<string, unknown>) => ({ order_product_id: id, ean: '', tax_rate: 23, variant_id: 0, auction_id: '', storage_id: 0, ...p })

export function zamowienia(): Record<string, unknown>[] {
  const pii = polaKlienta()
  return [
    {
      order_id: 5001, order_status_id: 1, date_add: T(2), date_confirmed: T(2), order_source: 'shop', order_source_id: 9001, shop_order_id: 7001,
      payment_done: 52, payment_method: 'Przelewy24', payment_method_cod: '0', delivery_method: 'Kurier DPD', delivery_price: 12, want_invoice: '0', ...pii,
      products: [pozycja(1, { storage: 'shop', storage_id: 9001, product_id: '501', sku: 'HER-001', name: 'Przyprawa czarna 100 g', quantity: 2, price_brutto: 20 })],
    },
    {
      order_id: 5002, order_status_id: 1, date_add: T(1), date_confirmed: T(1), order_source: 'allegro', order_source_id: 31, external_order_id: 'alg-1111',
      payment_done: 30, payment_method: 'PayU', delivery_method: 'Allegro Paczkomaty InPost', delivery_price: 0, ...pii,
      products: [pozycja(2, { storage: 'db', product_id: '1002', auction_id: 'A-77', sku: 'HER-002', name: 'Przyprawa zielona 100 g', quantity: 1, price_brutto: 30 })],
    },
    {
      order_id: 5003, order_status_id: 2, date_add: T(3), date_confirmed: T(3), order_source: 'shop', order_source_id: 9001, shop_order_id: 7002,
      payment_done: 0, payment_method: 'Pobranie', payment_method_cod: '1', delivery_method: 'Paczkomaty InPost', delivery_price: 10, ...pii,
      products: [pozycja(3, { storage: 'shop', product_id: '502', sku: 'ZZZ-9', name: 'Kubek sklepowy', quantity: 1, price_brutto: 15 })],
    },
    {
      order_id: 5004, order_status_id: 3, date_add: T(5), date_confirmed: T(5), order_source: 'shop', order_source_id: 9001, shop_order_id: 7003,
      payment_done: 40, payment_method: 'Przelewy24', delivery_method: 'Kurier DPD', delivery_price: 0, ...pii,
      products: [pozycja(4, { storage: 'shop', product_id: '501', sku: 'HER-001', name: 'Przyprawa czarna 100 g', quantity: 2, price_brutto: 20 })],
    },
    {
      order_id: 5005, order_status_id: 5, date_add: T(4), date_confirmed: T(4), order_source: 'shop', order_source_id: 9001, shop_order_id: 7004,
      payment_done: 0, payment_method: 'Przelew', delivery_method: 'Kurier DPD', delivery_price: 12, ...pii,
      products: [pozycja(5, { storage: 'shop', product_id: '501', sku: 'HER-001', name: 'Przyprawa czarna 100 g', quantity: 1, price_brutto: 20 })],
    },
    {
      order_id: 5006, order_status_id: 1, date_add: T(1), date_confirmed: T(1), order_source: 'tiktok', order_source_id: 5,
      payment_done: 40, payment_method: 'TikTok Pay', delivery_method: 'Poczta Polska', delivery_price: 0, ...pii,
      products: [
        pozycja(6, { storage: 'db', product_id: '1001', sku: 'HER-001', name: 'Przyprawa czarna 100 g', quantity: 1, price_brutto: 20 }),
        // pozycja dodana w BL z ręki: nazwa wpisana z ręki (tu: wartownik) — parser ją zastępuje
        pozycja(7, { storage: 'db', product_id: 0, sku: '', name: PII_SENTINELS[0], quantity: 1, price_brutto: 20 }),
      ],
    },
    {
      // zły rekord: ilość „abc” — odrzucony w parserze, reszta partii idzie dalej
      order_id: 5007, order_status_id: 1, date_add: T(1), order_source: 'shop', order_source_id: 9001, shop_order_id: 7005, ...pii,
      products: [pozycja(8, { storage: 'shop', product_id: '501', quantity: 'abc', price_brutto: 20 })],
    },
    {
      // zły rekord dla rdzenia: zdublowana pozycja — ingestOrder odmawia, reszta idzie dalej
      order_id: 5008, order_status_id: 1, date_add: T(1), date_confirmed: T(1), order_source: 'shop', order_source_id: 9001, shop_order_id: 7006,
      payment_done: 0, payment_method: 'Przelew', delivery_method: 'Kurier DPD', ...pii,
      products: [
        pozycja(9, { storage: 'shop', product_id: '501', sku: 'HER-001', name: 'Przyprawa czarna 100 g', quantity: 1, price_brutto: 20 }),
        pozycja(9, { storage: 'shop', product_id: '501', sku: 'HER-001', name: 'Przyprawa czarna 100 g', quantity: 1, price_brutto: 20 }),
      ],
    },
  ]
}

export class AtrapaBlPrzeprowadzki {
  calls: { method: string; params: Record<string, unknown> }[] = []
  produkty: AtrapaProdukt[] = PRODUKTY.map((p) => ({ ...p }))
  orders: Record<string, unknown>[] = zamowienia()
  /** statusy i grupy statusów BL (domyślnie kształt; testy statusów firmy podają kształt z dokumentacji) */
  statusy: Record<string, unknown>[] = STATUSY.map((x) => ({ ...x }))
  grupyStatusow: Record<string, unknown>[] = [{ name: 'Zakończone', statuses: [3, 4] }]
  katalogi = [{ inventory_id: 700, name: 'Katalog testowy', default_price_group: 10, default_warehouse: 'bl_501', warehouses: ['bl_501'] }]

  client(): BlPrzeprowadzka {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = new URLSearchParams(String(init?.body))
      const method = body.get('method')!
      const params = JSON.parse(body.get('parameters') ?? '{}') as Record<string, unknown>
      this.calls.push({ method, params })
      return new Response(JSON.stringify({ status: 'SUCCESS', ...this.answer(method, params) }))
    }
    return new BlPrzeprowadzka('token-test', fetchImpl, 0)
  }

  private answer(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const prodData = (p: AtrapaProdukt) => ({
      sku: p.sku ?? '',
      ean: p.ean ?? '',
      text_fields: { name: p.name },
      prices: { '10': 20 },
      stock: { bl_501: p.stock },
      links: p.links ?? {},
      is_bundle: !!p.bundle,
      bundle_products: p.bundle ?? [],
      tax_rate: 23,
    })
    switch (method) {
      case 'getInventories':
        return { inventories: this.katalogi }
      case 'getInventoryWarehouses':
        return { warehouses: [{ warehouse_type: 'bl', warehouse_id: 501, name: 'Magazyn główny', is_default: true }] }
      case 'getInventoryPriceGroups':
        return { price_groups: [{ price_group_id: 10, name: 'Domyślna', currency: 'PLN', is_default: true }] }
      case 'getInventoryCategories':
        return { categories: [{ category_id: 1, name: 'Przyprawy' }] }
      case 'getInventoryManufacturers':
        return { manufacturers: [{ manufacturer_id: 1, name: 'Producent testowy' }] }
      case 'getInventoryIntegrations':
        return { integrations: {} }
      case 'getInventoryProductsList':
        return Number(params['page']) > 1 ? { products: {} } : { products: Object.fromEntries(this.produkty.map((p) => [String(p.id), { id: p.id }])) }
      case 'getInventoryProductsData': {
        const ids = (params['products'] as number[]).map(String)
        return { products: Object.fromEntries(this.produkty.filter((p) => ids.includes(String(p.id))).map((p) => [String(p.id), prodData(p)])) }
      }
      case 'getInventoryProductsStock':
        return Number(params['page']) > 1 ? { products: {} } : { products: Object.fromEntries(this.produkty.map((p) => [String(p.id), { product_id: p.id, stock: { bl_501: p.stock } }])) }
      case 'getInventoryProductsPrices':
        return { products: {} }
      case 'getExternalStoragesList':
        return { storages: [{ storage_id: 'shop_9001', name: 'Sklep Testowy', methods: [] }] }
      case 'getExternalStorageProductsList':
        return Number(params['page']) > 1 ? { products: [] } : { products: [{ product_id: '501' }, { product_id: '502' }] }
      case 'getExternalStorageProductsData':
        return {
          products: [
            { product_id: '501', sku: 'HER-001', name: 'Przyprawa czarna 100 g', ean: '5901234123457' },
            { product_id: '502', sku: 'ZZZ-9', name: 'Kubek sklepowy' },
          ].filter((p) => (params['products'] as string[]).includes(p.product_id)),
        }
      case 'getOrderSources':
        return { sources: { personal: { '0': 'Osobiście / telefon' }, shop: { '9001': 'Sklep Testowy' }, allegro: { '31': 'Allegro testowe' }, tiktok: { '5': 'TikTok' } } }
      case 'getOrderStatusList':
        return { statuses: this.statusy }
      case 'getOrderStatusGroups':
        return { status_groups: this.grupyStatusow }
      case 'getOrderExtraFields':
        return { extra_fields: [{ extra_field_id: 1, name: 'Numer referencyjny' }] }
      case 'getOrders': {
        const idFrom = Number(params['id_from'] ?? 0)
        let list = this.orders.filter((o) => Number(o['order_id']) >= idFrom)
        if (params['status_id'] !== undefined) list = list.filter((o) => Number(o['order_status_id']) === Number(params['status_id']))
        if (params['date_from'] !== undefined) list = list.filter((o) => Number(o['date_add']) >= Number(params['date_from']))
        return { orders: [...list].sort((a, b) => Number(a['order_id']) - Number(b['order_id'])).slice(0, 100) }
      }
      case 'getCouriersList':
        return { couriers: [{ code: 'dpd', name: 'DPD' }, { code: 'inpost', name: 'InPost' }, { code: 'gls', name: 'GLS' }] }
      case 'getCourierAccounts':
        return { accounts: [{ id: 1, name: 'Konto firmowe' }] }
      case 'getSeries':
        return { series: [{ id: 1, type: 'INVOICE', name: 'FV' }] }
      default:
        return { status: 'ERROR', error_code: 'ERROR_UNKNOWN_METHOD', error_message: method }
    }
  }
}
