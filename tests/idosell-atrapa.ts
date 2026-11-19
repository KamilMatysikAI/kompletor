// Atrapa IdoSell Admin API: `FetchLike` ze sklepem w pamięci — zamówienia (`orders/orders/search`, zmiana
// statusu `PUT orders/orders`) i produkty z rozmiarami i stanami magazynów (`products/products/search`, zapis
// `PUT products/stocks`). Kształt odpowiedzi wg dokumentacji idosell.readme.io (v8): strony od 0, `resultsNumberPage`,
// lista zamówień jako `Results`, produktów jako `results`; daty lokalne „RRRR-MM-DD GG:MM:SS” bez strefy; „brak
// wyników” jako HTTP 404 z `errors.faultCode` 2 (tak odpowiadało starsze API; w v8 [NIEPEWNE]). Dane zmyślone, pola
// osobowe niosą PII_SENTINELS — testy sprawdzają, że nie wychodzą z adaptera. Żadnego połączenia z prawdziwym IdoSell.
import type { FetchLike } from '@/lib/zrodla/http'
import { PII_SENTINELS, type SeedOffer, type SeedOrder } from '@/lib/adaptery/suita-kontraktowa'
import { lokalnie } from './shoper-atrapa'

/**
 * `BRAK_ROZMIARU`: odpowiedź `products/stocks` bez wpisu pierwszego rozmiaru, z `isSizesErrors: true`;
 * `BRAK_ROZMIARU_BEZ_BLEDOW`: to samo z `isSizesErrors: false` (sklep zgłasza tylko rozmiary z błędami).
 */
export type IdoSellWriteFailure = 'PRZEJSCIOWY' | 'TRWALY' | 'LIMIT' | 'CZESCIOWY' | 'SIEC' | 'NIEJEDNOZNACZNY_WYKONANY' | 'NIEJEDNOZNACZNY_NIEWYKONANY' | 'WYJATEK' | 'BRAK_ROZMIARU' | 'BRAK_ROZMIARU_BEZ_BLEDOW'

export interface IdoSellAtrapaOpts {
  host?: string
  wersja?: string
  strefa?: string
  apiKey?: string
  /** false = pusty wynik jako 200 z pustą listą zamiast 404 z faultCode 2. */
  pustaJako404?: boolean
  /** true = odpowiedź wyszukiwania bez `resultsNumberPage` (adapter nie może zgubić dalszych stron). */
  bezLiczbyStron?: boolean
}

export const STATUS_DLA: Record<SeedOrder['state'], string> = { open: 'new', cancelled: 'canceled', fulfilled: 'finished' }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export interface ZapytanieIdo {
  method: string
  path: string
  body: Record<string, unknown> | null
}

interface Rozmiar {
  sizeId: string
  code: string | null
  ean: string | null
  /** stockId → ilość (tekst albo liczba, jak w API); brak mapy = sklep nie prowadzi stanu. */
  stocks: Map<number, unknown> | null
}

export class IdoSellAtrapa {
  readonly host: string
  readonly base: string
  readonly strefa: string
  readonly orders = new Map<string, Record<string, unknown>>()
  readonly products = new Map<number, { name: string; code: string | null; sizes: Rozmiar[]; visible: boolean }>()
  readonly log: ZapytanieIdo[] = []
  private readonly apiKey: string
  private readonly pustaJako404: boolean
  private readonly bezLiczbyStron: boolean
  private listFail: number | null = null
  private readonly queued: { path: string; status: number; headers: Record<string, string> }[] = []
  private readonly writeFailures: IdoSellWriteFailure[] = []

  constructor(opts: IdoSellAtrapaOpts = {}) {
    this.host = opts.host ?? 'https://client1.idosell.example.invalid'
    this.base = `/api/admin/${opts.wersja ?? 'v8'}/`
    this.strefa = opts.strefa ?? 'Europe/Warsaw'
    this.apiKey = opts.apiKey ?? 'klucz-ido-test'
    this.pustaJako404 = opts.pustaJako404 ?? true
    this.bezLiczbyStron = opts.bezLiczbyStron ?? false
  }

  requests(): string[] {
    return this.log.map((r) => r.method)
  }

  writes(): ZapytanieIdo[] {
    return this.log.filter((r) => r.method === 'PUT')
  }

  failNextList(kind: 'PRZEJSCIOWY' | 'TRWALY'): void {
    this.listFail = kind === 'PRZEJSCIOWY' ? 503 : 401
  }

  /** Następne żądanie na tę ścieżkę (względem /api/admin/vN/) dostaje podany status. */
  failNext(path: string, status: number, headers: Record<string, string> = {}): void {
    this.queued.push({ path, status, headers })
  }

  injectWriteFailure(f: IdoSellWriteFailure): void {
    this.writeFailures.push(f)
  }

  corruptOrder(externalId: string): void {
    const d = this.orders.get(externalId)!['orderDetails'] as Record<string, unknown>
    ;(d['productsResults'] as Record<string, unknown>[])[0]!['productQuantity'] = 'abc'
  }

  statusOf(externalId: string): string | undefined {
    const d = this.orders.get(externalId)?.['orderDetails'] as Record<string, unknown> | undefined
    return d ? String(d['orderStatus']) : undefined
  }

  /** Stan rozmiaru w magazynie (null = brak wpisu). */
  stockOf(productId: number, sizeId = 'uniw', stockId = 1): unknown {
    return this.products.get(productId)?.sizes.find((s) => s.sizeId === sizeId)?.stocks?.get(stockId) ?? null
  }

  putOrder(o: SeedOrder, over: { sizeId?: string; payment?: 'cash_on_delivery' | 'prepaid'; paid?: boolean } = {}): void {
    const offer = /^(\d+)(?:\/(.+))?$/.exec(o.offer)!
    const lines = Array.isArray((this.orders.get(o.externalId)?.['orderDetails'] as Record<string, unknown> | undefined)?.['productsResults'])
    const total = (o.qty * 12.3).toFixed(2)
    const paid = over.paid ?? o.state !== 'cancelled'
    const raw: Record<string, unknown> = {
      orderId: `sklep-1-${o.externalId}`,
      orderSerialNumber: Number(o.externalId),
      orderType: 'n',
      orderBridgeNote: PII_SENTINELS[4],
      clientResult: {
        clientAccount: { clientId: 55, clientEmail: PII_SENTINELS[1], clientLogin: PII_SENTINELS[0] },
        clientBillingAddress: { clientFirstName: PII_SENTINELS[0], clientStreet: PII_SENTINELS[3], clientPhone1: PII_SENTINELS[2], clientNip: '' },
        clientDeliveryAddress: { clientDeliveryAddressFirstName: PII_SENTINELS[0], clientDeliveryAddressStreet: PII_SENTINELS[3], clientDeliveryAddressPhone1: PII_SENTINELS[2] },
        clientPickupPointAddress: { pickupPointId: 'WAW01M', name: PII_SENTINELS[0] },
      },
      orderDetails: {
        orderStatus: STATUS_DLA[o.state],
        orderAddDate: lokalnie(o.createdAt, this.strefa),
        orderChangeDate: lokalnie(o.modifiedAt, this.strefa),
        orderNote: PII_SENTINELS[0],
        clientNoteToOrder: PII_SENTINELS[3],
        clientRequestInvoice: 'n',
        payments: {
          orderPaymentType: over.payment ?? 'prepaid',
          orderWorthCalculateType: 'gross',
          orderCurrency: { currencyId: 'PLN', orderProductsCost: Number(total), orderDeliveryCost: 12.99, orderPayformCost: 0 },
          orderBaseCurrency: { billingCurrency: 'PLN', orderProductsCost: Number(total), orderDeliveryCost: 12.99 },
        },
        prepaids: paid ? [{ prepaidId: 1, paymentStatus: 'y', paymentType: 'payment', payformName: 'Przelewy24', paymentValue: Number(total) + 12.99, currencyId: 'PLN' }] : [],
        dispatch: { courierId: 100, courierName: 'InPost Paczkomaty' },
        productsResults: [
          {
            productId: Number(offer[1]),
            sizeId: over.sizeId ?? offer[2] ?? 'uniw',
            productName: 'Przyprawa testowa',
            productCode: `SKU-${offer[1]}`,
            productQuantity: o.qty,
            productVat: 23,
            productOrderPrice: 12.3,
            productOrderPriceNet: 10,
            basketPosition: 1,
            remarksToProduct: PII_SENTINELS[0],
          },
        ],
      },
    }
    if (lines) {
      // ponowny zapis tego samego zamówienia: pozycja zostaje ta sama, zmienia się stan i data zmiany
      const d = raw['orderDetails'] as Record<string, unknown>
      d['productsResults'] = (this.orders.get(o.externalId)!['orderDetails'] as Record<string, unknown>)['productsResults']
      ;(d['productsResults'] as Record<string, unknown>[])[0]!['productQuantity'] = o.qty
    }
    this.orders.set(o.externalId, raw)
  }

  /** Produkt z rozmiarami; `qty` null = bez `productStocksData` (sklep nie prowadzi stanu). */
  putProduct(productId: number, sizes: { sizeId?: string; qty: number | string | null; code?: string | null; ean?: string | null }[] = [{ qty: 7 }], opts: { name?: string; visible?: boolean; code?: string | null } = {}): void {
    this.products.set(productId, {
      name: opts.name ?? `Przyprawa testowa ${productId}`,
      code: opts.code === undefined ? `P-${productId}` : opts.code,
      visible: opts.visible ?? true,
      sizes: sizes.map((s) => ({ sizeId: s.sizeId ?? 'uniw', code: s.code === undefined ? `SKU-${productId}` : s.code, ean: s.ean ?? null, stocks: s.qty === null ? null : new Map<number, unknown>([[1, s.qty]]) })),
    })
  }

  putOffer(o: SeedOffer): void {
    this.putProduct(Number(o.externalId), [{ qty: o.qty, code: o.sku }], { name: o.name, code: o.sku })
  }

  corruptOffer(externalId: string): void {
    this.products.get(Number(externalId))!.sizes[0]!.stocks!.set(1, 'abc')
  }

  private productRow(id: number): Record<string, unknown> {
    const p = this.products.get(id)!
    const withStocks = p.sizes.some((s) => s.stocks)
    const stockIds = [...new Set(p.sizes.flatMap((s) => [...(s.stocks?.keys() ?? [])]))]
    return {
      productId: id,
      productDisplayedCode: p.code,
      productIsDeleted: 'n',
      productIsVisible: p.visible ? 'y' : 'n',
      productRetailPrice: 19.9,
      productVat: 23,
      productDescriptionsLangData: [
        { langId: 'eng', productName: `${p.name} EN` },
        { langId: 'pol', productName: p.name },
      ],
      productImages: [{ productImageLargeUrl: `https://cdn.example.invalid/${id}.jpg` }],
      productSizes: p.sizes.map((s) => ({ sizeId: s.sizeId, sizePanelName: s.sizeId })),
      productSizesAttributes: p.sizes.map((s) => ({ sizeId: s.sizeId, productSizeCodeExternal: s.code, productSizeCodeProducer: s.ean ?? '', productRetailPrice: 19.9 })),
      ...(withStocks
        ? {
            productStocksData: {
              productStocksQuantities: stockIds.map((stockId) => ({
                stockId,
                productSizesData: p.sizes.filter((s) => s.stocks?.has(stockId)).map((s) => ({ sizeId: s.sizeId, productSizeCodeExternal: s.code, productSizeQuantity: s.stocks!.get(stockId) })),
              })),
            },
          }
        : {}),
    }
  }

  private page(rows: Record<string, unknown>[], params: Record<string, unknown>, key: 'Results' | 'results'): Response {
    const limit = Math.min(100, Math.max(1, Number(params['resultsLimit'] ?? 100)))
    const page = Math.max(0, Number(params['resultsPage'] ?? 0))
    const pages = Math.ceil(rows.length / limit)
    const slice = rows.slice(page * limit, (page + 1) * limit)
    if (!slice.length && this.pustaJako404) return json({ errors: { faultCode: 2, faultString: 'Brak wyników' } }, 404)
    if (this.bezLiczbyStron) return json({ resultsPage: page, resultsLimit: limit, [key]: slice })
    return json({ resultsNumberAll: rows.length, resultsNumberPage: pages, resultsPage: page, resultsLimit: limit, [key]: slice })
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    if (u.origin !== this.host) throw new Error(`atrapa IdoSell: obcy adres ${u.origin}`)
    if (!u.pathname.startsWith(this.base)) return new Response('<html>nie ma</html>', { status: 404, headers: { 'content-type': 'text/html' } })
    const path = u.pathname.slice(this.base.length)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    this.log.push({ method, path, body })
    const qi = this.queued.findIndex((x) => x.path === path)
    if (qi >= 0) {
      const x = this.queued.splice(qi, 1)[0]!
      return json({ errors: { faultCode: 99, faultString: PII_SENTINELS[1] } }, x.status, x.headers)
    }
    if (headers['X-API-KEY'] !== this.apiKey) return json({ errors: { faultCode: 1, faultString: 'Błąd logowania' } }, 401)
    const params = (body?.['params'] ?? {}) as Record<string, unknown>

    if (method === 'POST' && path === 'orders/orders/search') {
      if (this.listFail) {
        const s = this.listFail
        this.listFail = null
        return json({ errors: { faultCode: 99, faultString: 'awaria' } }, s)
      }
      const range = ((params['ordersRange'] as Record<string, unknown> | undefined)?.['ordersDateRange'] ?? null) as Record<string, unknown> | null
      const since = range && range['ordersDateType'] === 'modified' ? String(range['ordersDateBegin']) : null
      const serials = Array.isArray(params['ordersSerialNumbers']) ? (params['ordersSerialNumbers'] as number[]).map(String) : null
      const rows = [...this.orders.values()]
        .filter((o) => !serials || serials.includes(String(o['orderSerialNumber'])))
        .filter((o) => !since || String((o['orderDetails'] as Record<string, unknown>)['orderChangeDate']) >= since)
        .sort((a, b) => Number(a['orderSerialNumber']) - Number(b['orderSerialNumber']))
      return this.page(rows, params, 'Results')
    }
    if (method === 'POST' && path === 'products/products/search') {
      return this.page([...this.products.keys()].sort((a, b) => a - b).map((id) => this.productRow(id)), params, 'results')
    }
    if (method === 'PUT') return this.put(path, params)
    return json({ errors: { faultCode: 98, faultString: 'nieznana metoda' } }, 404)
  }

  private put(path: string, params: Record<string, unknown>): Response {
    const f = this.writeFailures.shift()
    if (f === 'SIEC' || f === 'WYJATEK') throw new Error('połączenie zerwane (atrapa)')
    if (f === 'PRZEJSCIOWY' || f === 'NIEJEDNOZNACZNY_WYKONANY' || f === 'NIEJEDNOZNACZNY_NIEWYKONANY') return json({ errors: { faultCode: 500, faultString: 'chwilowa awaria' } }, 503)
    if (f === 'TRWALY') return json({ errors: { faultCode: 4, faultString: PII_SENTINELS[1] } }, 422)
    if (f === 'LIMIT') return json({ errors: { faultCode: 429, faultString: 'Too many requests' } }, 429, { 'Retry-After': '30' })
    if (path === 'products/stocks') {
      let first = true
      const results = ((params['products'] ?? []) as Record<string, unknown>[]).map((p) => {
        const ident = p['ident'] as Record<string, unknown>
        const prod = ident['identType'] === 'id' ? this.products.get(Number(ident['identValue'])) : undefined
        if (!prod) return { ident, error: { faultCode: 7, faultString: 'Nie znaleziono produktu' }, sizes: [] }
        const sizes = ((p['sizes'] ?? []) as Record<string, unknown>[]).map((s) => {
          const si = s['ident'] as Record<string, unknown>
          const size = prod.sizes.find((x) => si['identType'] === 'id' && x.sizeId === si['identValue'])
          if (!size || (f === 'CZESCIOWY' && first)) {
            first = false
            return { ident: si, error: { faultCode: 8, faultString: 'Błędny rozmiar' } }
          }
          for (const st of ((s['quantity'] as Record<string, unknown>)['stocks'] ?? []) as Record<string, unknown>[]) {
            const op = st['quantity_operation'] as Record<string, unknown>
            if (op['operation'] !== 'set') return { ident: si, error: { faultCode: 9, faultString: 'atrapa: tylko set' } }
            size.stocks ??= new Map()
            size.stocks.set(Number(st['stock_id']), Number(op['quantity']))
          }
          return { ident: si, error: { faultCode: 0, faultString: '' } }
        })
        if (f === 'BRAK_ROZMIARU' || f === 'BRAK_ROZMIARU_BEZ_BLEDOW') return { ident, error: { faultCode: 0, faultString: '' }, sizes: sizes.slice(1), isSizesErrors: f === 'BRAK_ROZMIARU' }
        return { ident, error: { faultCode: 0, faultString: '' }, sizes, isSizesErrors: sizes.some((s) => s.error.faultCode !== 0) }
      })
      const anyErr = results.some((r) => r.error.faultCode !== 0 || r.isSizesErrors)
      return json({ results, isErrors: anyErr }, anyErr ? 207 : 200)
    }
    if (path === 'orders/orders') {
      const ordersResults = ((params['orders'] ?? []) as Record<string, unknown>[]).map((o) => {
        const raw = this.orders.get(String(o['orderSerialNumber']))
        if (!raw) return { orderSerialNumber: o['orderSerialNumber'], faultCode: 3, faultString: 'Brak zamówienia' }
        ;(raw['orderDetails'] as Record<string, unknown>)['orderStatus'] = String(o['orderStatus'])
        return { orderSerialNumber: o['orderSerialNumber'], orderStatus: o['orderStatus'], faultCode: 0, faultString: '' }
      })
      return json({ results: { ordersResults } }, ordersResults.some((r) => r.faultCode !== 0) ? 207 : 200)
    }
    return json({ errors: { faultCode: 98, faultString: 'nieznana ścieżka' } }, 404)
  }
}
