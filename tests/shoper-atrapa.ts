// Atrapa Shoper REST: `FetchLike` ze sklepem w pamięci — zamówienia, pozycje (`order-products`), słowniki
// (statusy, płatności, dostawy, waluty) i stany (`product-stocks`). Kształt odpowiedzi wg SDK Shopera (lista:
// `count`, `pages`, `page`, `list`; daty lokalne „RRRR-MM-DD GG:MM:SS” bez strefy). Dane zmyślone; pola osobowe
// niosą znaczniki PII_SENTINELS — testy sprawdzają, że nie wychodzą z adaptera. Dwa tryby filtra `status_date`
// (działa / sklep go ignoruje) i filtra pozycji po `order_id`, bo żadnego z nich nie potwierdziliśmy na żywym sklepie.
import type { FetchLike } from '@/lib/zrodla/http'
import { PII_SENTINELS, type SeedOrder } from '@/lib/adaptery/suita-kontraktowa'

export type ShoperWriteFailure = 'PRZEJSCIOWY' | 'TRWALY' | 'MAGAZYNY' | 'SIEC' | 'NIEJEDNOZNACZNY_WYKONANY' | 'NIEJEDNOZNACZNY_NIEWYKONANY' | 'WYJATEK'

export interface ShoperAtrapaOpts {
  host?: string
  strefa?: string
  /** Stały token (Bearer). */
  token?: string
  /** Logowanie `POST /webapi/rest/auth` (Basic). */
  login?: { login: string; password: string }
  /** false = sklep ignoruje `filters[status_date][>=]` i zwraca całą listę. */
  filtrDatyDziala?: boolean
  /** false = sklep ignoruje `filters[order_id][=]` w `order-products`. */
  filtrPozycjiDziala?: boolean
}

/** Status sklepu: identyfikator → typ (1 nowy, 2 w realizacji, 3 wysłany, 4 końcowy; 7 — typ nieznany adapterowi). */
export const ATRAPA_STATUSY: Record<string, number> = { '1': 1, '2': 2, '4': 3, '5': 4, '9': 7 }
export const STATUS_DLA: Record<SeedOrder['state'], string> = { open: '1', cancelled: '5', fulfilled: '4' }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export function lokalnie(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  return `${p['year']}-${p['month']}-${p['day']} ${p['hour']}:${p['minute']}:${p['second']}`
}

export interface ZapytanieAtrapy {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
}

export class ShoperAtrapa {
  readonly host: string
  readonly strefa: string
  readonly orders = new Map<string, Record<string, unknown>>()
  readonly products = new Map<string, Record<string, unknown>[]>()
  readonly stocks = new Map<string, Record<string, unknown>>()
  statuses: Record<string, unknown>[] = Object.entries(ATRAPA_STATUSY).map(([status_id, type]) => ({ status_id, type: String(type), active: '1', email_change: status_id === '4' ? '1' : '0', translations: { pl_PL: { name: `status ${status_id}` } } }))
  payments: Record<string, unknown>[] = [{ payment_id: '3', name: 'przelewy24', translations: { pl_PL: { title: 'Przelewy24' }, en_GB: { title: 'Przelewy24 EN' } } }, { payment_id: '4', name: 'cod', translations: { pl_PL: { title: 'Za pobraniem' } } }]
  shippings: Record<string, unknown>[] = [{ shipping_id: '7', name: 'Paczkomaty InPost' }, { shipping_id: '8', name: 'Kurier DPD' }]
  currencies: Record<string, unknown>[] = [{ currency_id: '1', name: 'PLN', default: '1' }, { currency_id: '2', name: 'EUR', default: '0' }]
  filtrDatyDziala: boolean
  filtrPozycjiDziala: boolean
  /** Moduł magazynów: PUT stanu kończy się 400 z informacją o magazynach. */
  magazyny = false
  /** Wszystkie żądania (metoda, ścieżka względem /webapi/rest, parametry; bez nagłówków). */
  readonly log: ZapytanieAtrapy[] = []
  private readonly validTokens = new Set<string>()
  private readonly login?: { login: string; password: string }
  private issued = 0
  private listFail: number | null = null
  private readonly queued: { path: string; status: number; headers: Record<string, string> }[] = []
  private readonly writeFailures: ShoperWriteFailure[] = []
  private nextLineId = 1

  constructor(opts: ShoperAtrapaOpts = {}) {
    this.host = opts.host ?? 'https://sklep-shoper.example.invalid'
    this.strefa = opts.strefa ?? 'Europe/Warsaw'
    if (opts.token) this.validTokens.add(opts.token)
    if (opts.login) this.login = opts.login
    this.filtrDatyDziala = opts.filtrDatyDziala ?? true
    this.filtrPozycjiDziala = opts.filtrPozycjiDziala ?? true
  }

  requests(): string[] {
    return this.log.map((r) => r.method)
  }

  /** Unieważnia wydane tokeny z logowania (sklep „zapomniał” sesję). */
  expireTokens(): void {
    for (const t of [...this.validTokens]) if (t.startsWith('tok-')) this.validTokens.delete(t)
  }

  get tokensIssued(): number {
    return this.issued
  }

  failNextList(kind: 'PRZEJSCIOWY' | 'TRWALY'): void {
    this.listFail = kind === 'PRZEJSCIOWY' ? 503 : 401
  }

  /** Następne żądanie na tę ścieżkę (dokładnie, względem /webapi/rest) dostaje podany status. */
  failNext(path: string, status: number, headers: Record<string, string> = {}): void {
    this.queued.push({ path, status, headers })
  }

  injectWriteFailure(f: ShoperWriteFailure): void {
    this.writeFailures.push(f)
  }

  corruptOrder(externalId: string): void {
    this.products.get(externalId)![0]!['quantity'] = 'abc'
  }

  putOrder(o: SeedOrder): void {
    const raw: Record<string, unknown> = {
      order_id: Number(o.externalId),
      user_id: '55',
      date: lokalnie(o.createdAt, this.strefa),
      status_date: lokalnie(o.modifiedAt, this.strefa),
      confirm: '1',
      confirm_date: lokalnie(o.createdAt, this.strefa),
      status_id: STATUS_DLA[o.state],
      sum: (o.qty * 12.3).toFixed(2),
      paid: o.state === 'cancelled' ? '0.00' : (o.qty * 12.3).toFixed(2),
      is_paid: o.state === 'cancelled' ? false : true,
      is_cash_on_delivery: false,
      is_underpayment: false,
      is_overpayment: false,
      currency_id: '1',
      currency_rate: '1.0000',
      payment_id: '3',
      shipping_id: '7',
      shipping_cost: '12.99',
      email: PII_SENTINELS[1],
      delivery_email: PII_SENTINELS[1],
      ip_address: '203.0.113.7',
      notes: PII_SENTINELS[4],
      notes_priv: PII_SENTINELS[0],
      notes_pub: PII_SENTINELS[3],
      pickup_point: 'WAW01M',
      pickup_point_data: { name: PII_SENTINELS[0], street: PII_SENTINELS[3] },
      billing_address: { firstname: PII_SENTINELS[0], street1: PII_SENTINELS[3], phone: PII_SENTINELS[2], tax_identification_number: PII_SENTINELS[4] },
      delivery_address: { firstname: PII_SENTINELS[0], street1: PII_SENTINELS[3], phone: PII_SENTINELS[2] },
    }
    this.orders.set(o.externalId, raw)
    const lines = this.products.get(o.externalId)
    if (lines) {
      lines[0]!['stock_id'] = o.offer
      lines[0]!['quantity'] = String(o.qty)
    } else
      this.products.set(o.externalId, [
        { id: String(this.nextLineId++), order_id: o.externalId, product_id: String(Number(o.offer) + 1000), stock_id: o.offer, code: `SKU-${o.offer}`, name: 'Przyprawa testowa', ean: '5901234123457', price: '12.30', quantity: String(o.qty), tax_value: '23', unit_fp: '0' },
      ])
  }

  putStock(stockId: string, over: Record<string, unknown> = {}): void {
    this.stocks.set(stockId, { stock_id: stockId, product_id: String(Number(stockId) + 1000), code: `SKU-${stockId}`, ean: '5901234123457', stock: '7', active: '1', ...over })
  }

  private page(rows: Record<string, unknown>[], q: Record<string, string>): Response {
    const limit = Math.min(50, Math.max(1, Number(q['limit'] ?? 10)))
    const page = Math.max(1, Number(q['page'] ?? 1))
    const pages = Math.max(1, Math.ceil(rows.length / limit))
    return json({ count: String(rows.length), pages, page, list: rows.slice((page - 1) * limit, page * limit) })
  }

  private authorized(auth: string | null): boolean {
    const m = /^Bearer (.+)$/.exec(auth ?? '')
    return !!m && this.validTokens.has(m[1]!)
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    if (u.origin !== this.host) throw new Error(`atrapa Shoper: obcy adres ${u.origin}`)
    if (!u.pathname.startsWith('/webapi/rest/')) return json({ error: 'not_found' }, 404)
    const path = u.pathname.slice('/webapi/rest'.length)
    const method = init?.method ?? 'GET'
    const q = Object.fromEntries(u.searchParams.entries())
    const headers = (init?.headers ?? {}) as Record<string, string>
    let body: unknown = null
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    this.log.push({ method, path, query: q, body })

    if (path === '/auth' && method === 'POST') {
      const expect = this.login ? `Basic ${Buffer.from(`${this.login.login}:${this.login.password}`).toString('base64')}` : null
      if (!expect || headers['Authorization'] !== expect) return json({ error: 'unauthorized_client' }, 401)
      const t = `tok-${++this.issued}`
      this.validTokens.add(t)
      return json({ expires_in: 2592000, token_type: 'bearer', access_token: t })
    }
    const qi = this.queued.findIndex((x) => x.path === path)
    if (qi >= 0) {
      const x = this.queued.splice(qi, 1)[0]!
      return json({ error: 'awaria testowa', error_description: PII_SENTINELS[1] }, x.status, x.headers)
    }
    if (!this.authorized(headers['Authorization'] ?? null)) return json({ error: 'invalid_token' }, 401)

    if (method === 'PUT') return this.put(path, body)
    if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

    if (path === '/orders') {
      if (this.listFail) {
        const s = this.listFail
        this.listFail = null
        return json({ error: 'awaria' }, s)
      }
      const since = q['filters[status_date][>=]']
      const rows = [...this.orders.values()]
        .filter((o) => !this.filtrDatyDziala || !since || String(o['status_date']) >= since)
        .sort((a, b) => Number(a['order_id']) - Number(b['order_id']))
      return this.page(rows, q)
    }
    let m = /^\/orders\/(\d+)$/.exec(path)
    if (m) {
      const o = this.orders.get(m[1]!)
      return o ? json(o) : json({ error: 'not_found' }, 404)
    }
    if (path === '/order-products') {
      const id = q['filters[order_id][=]']
      const all = [...this.products.values()].flat().sort((a, b) => Number(a['id']) - Number(b['id']))
      return this.page(this.filtrPozycjiDziala && id ? all.filter((r) => r['order_id'] === id) : all, q)
    }
    if (path === '/statuses') return this.page(this.statuses, q)
    if (path === '/payments') return this.page(this.payments, q)
    if (path === '/shippings') return this.page(this.shippings, q)
    if (path === '/currencies') return this.page(this.currencies, q)
    if (path === '/product-stocks') return this.page([...this.stocks.values()].sort((a, b) => Number(a['stock_id']) - Number(b['stock_id'])), q)
    m = /^\/product-stocks\/(\d+)$/.exec(path)
    if (m) {
      const s = this.stocks.get(m[1]!)
      return s ? json(s) : json({ error: 'not_found' }, 404)
    }
    return json({ error: 'not_found' }, 404)
  }

  private put(path: string, body: unknown): Response {
    const f = this.writeFailures.shift()
    if (f === 'SIEC' || f === 'WYJATEK') throw new Error('połączenie zerwane (atrapa)')
    if (f === 'PRZEJSCIOWY' || f === 'NIEJEDNOZNACZNY_WYKONANY' || f === 'NIEJEDNOZNACZNY_NIEWYKONANY') return json({ error: 'temporarily_unavailable' }, 503)
    if (f === 'TRWALY') return json({ error: 'validation_error', error_description: PII_SENTINELS[1] }, 400)
    const b = (body ?? {}) as Record<string, unknown>
    let m = /^\/product-stocks\/(\d+)$/.exec(path)
    if (m) {
      if (f === 'MAGAZYNY' || this.magazyny) return json({ error: 'validation_error', error_description: 'Stock is read only when warehouses are enabled' }, 400)
      const s = this.stocks.get(m[1]!)
      if (!s) return json({ error: 'not_found' }, 404)
      s['stock'] = String(b['stock'])
      return json(1)
    }
    m = /^\/orders\/(\d+)$/.exec(path)
    if (m) {
      const o = this.orders.get(m[1]!)
      if (!o) return json({ error: 'not_found' }, 404)
      o['status_id'] = String(b['status_id'])
      return json(1)
    }
    return json({ error: 'not_found' }, 404)
  }
}
