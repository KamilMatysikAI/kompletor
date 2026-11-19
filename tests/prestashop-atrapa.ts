// Atrapa PrestaShop Webservice: `FetchLike` z zamówieniami, pozycjami, statusami, stanami, produktami,
// wariantami, walutą i przewoźnikiem w pamięci. Dane zmyślone, domena example.invalid. „Osobowe” wartości to
// PII_SENTINELS — w note, gift_message i w zasobach customers i addresses, o które adapter nie może pytać.
// Parsuje filter[...], sort, limit=offset,N, display i id_shop; zapis przyjmuje XML (sprawdza poprawność i ucieczkę
// znaków) i odrzuca PATCH w wersji < 8. Kształt odpowiedzi to nasze założenia [NIEPEWNE] — patrz
// docs/integracje/prestashop.md; prawdziwy sklep rozstrzygnie je dopiero na próbie demo.
import type { FetchLike } from '@/lib/zrodla/http'
import { PII_SENTINELS, type SeedOrder } from '@/lib/adaptery/suita-kontraktowa'
import { utcToLocal } from '@/lib/adaptery/prestashop'

/** Pola wiersza stanu liczone przez sklep w 1.7.x (nie do zapisu); celowo osobna lista, nie stała adaptera. */
const TYLKO_ODCZYT_STANU = ['physical_quantity', 'reserved_quantity']

export const ATRAPA_URL = 'https://sklep.example.invalid/sklep'
export const ATRAPA_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'

type Row = Record<string, unknown>

export interface AtrapaOpts {
  /** Nagłówek PSWS-Version; null = sklep go nie wysyła. */
  wersja?: string | null
  strefa?: string
  /** Lista zamówień z display=full bez associations.order_rows (host woła getOrder). */
  listaBezPozycji?: boolean
  /** Pusta lista jako `[]` (domyślnie) albo `{ "zasób": [] }`. */
  pustaListaJakoTablica?: boolean
  /** Sklep bez przepisywania adresów: każda odpowiedź to strona HTML. */
  html?: boolean
  /** Sklep odrzuca filter[date_upd] kodem 400. */
  filtrDat400?: boolean
  /** Sklep ignoruje filter[date_upd] (zwraca wszystko). */
  ignorujFiltrDat?: boolean
  /** Pojedynczy zasób jako `{ "orders": [ {...} ] }` zamiast `{ "order": {...} }`. */
  pojedynczyJakoLista?: boolean
  /** Zasoby bez prawa odczytu (403). */
  bezPrawa?: string[]
}

export type AtrapaWriteFailure = 'PRZEJSCIOWY' | 'TRWALY' | 'TIMEOUT_PO_WYSLANIU' | '5XX_PO_WYSLANIU'

export interface AtrapaRequest {
  method: string
  path: string
  query: URLSearchParams
  body?: string
  contentType?: string
}

const json = (body: unknown, status = 200, version: string | null = null) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(version ? { 'PSWS-Version': version } : {}) } })

const SINGULAR: Record<string, string> = {
  orders: 'order',
  order_states: 'order_state',
  stock_availables: 'stock_available',
  products: 'product',
  combinations: 'combination',
  currencies: 'currency',
  carriers: 'carrier',
  customers: 'customer',
  addresses: 'address',
  order_histories: 'order_history',
}

/** Domyślne statusy PrestaShop (flagi jak w instalacji 1.7–9; nazwy uproszczone). */
const STATES: [number, string, { paid?: 1; shipped?: 1; delivery?: 1 }][] = [
  [1, 'Oczekiwanie na płatność czekiem', {}],
  [2, 'Płatność przyjęta', { paid: 1 }],
  [3, 'Przygotowanie w toku', { paid: 1 }],
  [4, 'Wysłane', { paid: 1, shipped: 1, delivery: 1 }],
  [5, 'Dostarczone', { paid: 1, shipped: 1, delivery: 1 }],
  [6, 'Anulowane', {}],
  [7, 'Zwrot', { paid: 1 }],
  [8, 'Błąd płatności', {}],
  [10, 'Oczekiwanie na przelew', {}],
  [13, 'Oczekiwanie na płatność przy odbiorze', {}],
]

/** Prosty parser dokumentu zapisu: `<prestashop><zasób><pole>tekst</pole>…</zasób></prestashop>`; null = zły XML. */
export function parseWriteXml(xml: string): { resource: string; fields: Record<string, string> } | null {
  const m = /^\s*(<\?xml[^>]*\?>)?\s*<prestashop(\s[^>]*)?>\s*<([a-z_]+)>([\s\S]*)<\/\3>\s*<\/prestashop>\s*$/.exec(xml)
  if (!m) return null
  const fields: Record<string, string> = {}
  let rest = m[4]!
  const re = /^<([a-z_]+)>([^<]*)<\/\1>/
  while (rest.length) {
    const f = re.exec(rest)
    if (!f) return null
    const text = f[2]!
    if (/&(?!(amp|lt|gt|quot|apos);)/.test(text) || />/.test(text)) return null
    fields[f[1]!] = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    rest = rest.slice(f[0].length)
  }
  return { resource: m[3]!, fields }
}

/** Wartość filtra Webservice: `[a|b]`, `[od,do]`, `[a]`. */
function matchFilter(value: unknown, f: string): boolean {
  const m = /^\[(.*)\]$/.exec(f)
  if (!m) return String(value) === f
  const inner = m[1]!
  const v = String(value ?? '')
  if (inner.includes(',')) {
    const [lo, hi] = inner.split(',')
    const num = /^-?\d+(\.\d+)?$/
    if (num.test(lo!) && num.test(hi!) && num.test(v)) return Number(v) >= Number(lo) && Number(v) <= Number(hi)
    return v >= lo! && v <= hi!
  }
  return inner.split('|').includes(v)
}

export class PrestaAtrapa {
  readonly orders = new Map<string, Row>()
  readonly stock = new Map<string, Row>()
  readonly products = new Map<string, Row>()
  readonly combinations = new Map<string, Row>()
  readonly states = new Map<string, Row>()
  readonly currencies = new Map<string, Row>([['1', { id: 1, iso_code: 'PLN' }], ['2', { id: 2, iso_code: 'EUR' }]])
  readonly carriers = new Map<string, Row>([['3', { id: 3, name: 'Kurier testowy' }]])
  readonly customers = new Map<string, Row>([['7', { id: 7, firstname: PII_SENTINELS[0], email: PII_SENTINELS[1] }]])
  readonly addresses = new Map<string, Row>([['9', { id: 9, address1: PII_SENTINELS[3], phone: PII_SENTINELS[2], vat_number: PII_SENTINELS[4] }]])
  readonly histories: Row[] = []
  readonly log: AtrapaRequest[] = []
  private listFailure: number | null = null
  private writeFailures: AtrapaWriteFailure[] = []
  readonly strefa: string

  constructor(readonly opts: AtrapaOpts = {}) {
    this.strefa = opts.strefa ?? 'Europe/Warsaw'
    for (const [id, name, f] of STATES)
      this.states.set(String(id), {
        id,
        name,
        paid: String(f.paid ?? 0),
        shipped: String(f.shipped ?? 0),
        delivery: String(f.delivery ?? 0),
        logable: '1',
        invoice: '0',
        deleted: '0',
        hidden: '0',
        send_email: '1',
        template: 'x',
      })
    // oferty uprzęży kontraktu (10, 11, 12) — produkty proste
    for (const p of ['10', '11', '12']) this.putProduct(p, { reference: `SKU-${p}`, ean13: `59000000000${p}`, qty: 5 })
  }

  /** Lokalny czas sklepu („RRRR-MM-DD GG:MM:SS”) z chwili UTC. */
  local(d: Date): string {
    return utcToLocal(d, this.strefa)
  }

  putProduct(id: string, o: { reference?: string; ean13?: string; active?: boolean; qty?: number; idDefaultImage?: string; variants?: { id: string; reference?: string; ean13?: string; qty: number }[] }): void {
    this.products.set(id, { id: Number(id), reference: o.reference ?? '', ean13: o.ean13 ?? '', active: o.active === false ? '0' : '1', id_default_image: o.idDefaultImage ?? '', name: [{ id: '1', value: `Produkt ${id}` }] })
    const sum = (o.variants ?? []).reduce((s, v) => s + v.qty, 0)
    this.putStock(id, '0', o.variants?.length ? sum : (o.qty ?? 0))
    for (const v of o.variants ?? []) {
      this.combinations.set(v.id, { id: Number(v.id), id_product: Number(id), reference: v.reference ?? '', ean13: v.ean13 ?? '' })
      this.putStock(id, v.id, v.qty)
    }
  }

  private putStock(product: string, attr: string, qty: number): void {
    const id = String(this.stock.size + 100)
    this.stock.set(id, { id: Number(id), id_product: Number(product), id_product_attribute: Number(attr), id_shop: 1, id_shop_group: 0, quantity: String(qty), depends_on_stock: '0', out_of_stock: '2', location: '' })
  }

  stockOf(product: string, attr = '0'): Row | undefined {
    return [...this.stock.values()].find((s) => String(s['id_product']) === product && String(s['id_product_attribute']) === attr)
  }

  /** Zamówienie w formacie Webservice (pola, których adapter nie może czytać, z wartownikami PII). */
  putRaw(o: Row): void {
    this.orders.set(String(o['id']), o)
  }

  putOrder(s: SeedOrder): void {
    const state = s.state === 'open' ? 2 : s.state === 'cancelled' ? 6 : 4
    const id = Number(s.externalId)
    this.putRaw({
      id,
      id_address_delivery: 9,
      id_address_invoice: 9,
      id_cart: id,
      id_currency: 1,
      id_lang: 1,
      id_customer: 7,
      id_carrier: 3,
      current_state: String(state),
      module: 'ps_wirepayment',
      payment: 'Przelew bankowy',
      reference: `REF${s.externalId}`,
      secure_key: 'tajne-secure-key',
      note: PII_SENTINELS[4],
      gift_message: PII_SENTINELS[0],
      date_add: this.local(s.createdAt),
      date_upd: this.local(s.modifiedAt),
      valid: state === 6 ? '0' : '1',
      id_shop: 1,
      total_paid_tax_incl: (s.qty * 12.3).toFixed(6),
      total_paid_real: state === 2 || state === 4 ? (s.qty * 12.3).toFixed(6) : '0.000000',
      associations: {
        order_rows: [
          {
            id: String(id * 10),
            product_id: s.offer,
            product_attribute_id: '0',
            product_quantity: String(s.qty),
            product_name: `Produkt ${s.offer}`,
            product_reference: `SKU-${s.offer}`,
            product_ean13: '',
            unit_price_tax_incl: '12.300000',
          },
        ],
      },
    })
  }

  corruptOrder(id: string): void {
    const rows = (this.orders.get(id)!['associations'] as { order_rows: Row[] }).order_rows
    rows[0]!['product_quantity'] = 'abc'
  }

  failNextList(kind: 'PRZEJSCIOWY' | 'TRWALY'): void {
    this.listFailure = kind === 'PRZEJSCIOWY' ? 503 : 401
  }

  injectWriteFailure(f: AtrapaWriteFailure): void {
    this.writeFailures.push(f)
  }

  requests(): string[] {
    return this.log.map((r) => r.method)
  }

  paths(): string[] {
    return this.log.map((r) => `${r.method} ${r.path}`)
  }

  private table(res: string): Map<string, Row> | null {
    const t: Record<string, Map<string, Row>> = {
      orders: this.orders,
      order_states: this.states,
      stock_availables: this.stock,
      products: this.products,
      combinations: this.combinations,
      currencies: this.currencies,
      carriers: this.carriers,
      customers: this.customers,
      addresses: this.addresses,
    }
    return t[res] ?? null
  }

  private display(row: Row, res: string, display: string | null, list: boolean): Row {
    if (display === 'full' || (!list && !display)) {
      if (res === 'orders' && list && this.opts.listaBezPozycji) {
        const { associations: _, ...rest } = row
        return structuredClone(rest)
      }
      return structuredClone(row)
    }
    if (!display) return { id: row['id'] }
    const fields = /^\[(.*)\]$/.exec(display)?.[1]?.split(',') ?? ['id']
    return Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, structuredClone(row[f])]))
  }

  readonly fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const u = new URL(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const req: AtrapaRequest = { method, path: u.pathname, query: u.searchParams, ...(typeof init?.body === 'string' ? { body: init.body } : {}), ...(headers['Content-Type'] ? { contentType: headers['Content-Type'] } : {}) }
    this.log.push(req)
    const v = this.opts.wersja === undefined ? '8.1.7' : this.opts.wersja
    if (u.origin !== 'https://sklep.example.invalid' || !u.pathname.startsWith('/sklep/api')) return new Response('nie ma', { status: 404 })
    if (this.opts.html) return new Response('<!DOCTYPE html><html><body>Strona sklepu</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    if (headers['Authorization'] !== `Basic ${Buffer.from(`${ATRAPA_KEY}:`).toString('base64')}`) return json({ errors: [{ code: 17 }] }, 401, v)
    const parts = u.pathname.replace(/^\/sklep\/api\/?/, '').split('/').filter(Boolean)
    const [res, id] = [parts[0] ?? '', parts[1]]
    if (this.opts.bezPrawa?.includes(res)) return json({ errors: [{ code: 18 }] }, 403, v)

    if (method === 'GET') {
      // awaria listy dotyczy listy zamówień
      if (res === 'orders' && id === undefined && this.listFailure) {
        const s = this.listFailure
        this.listFailure = null
        return new Response('awaria', { status: s })
      }
      if (u.searchParams.get('output_format') !== 'JSON') return new Response('<?xml version="1.0"?><prestashop/>', { status: 200, headers: { 'content-type': 'text/xml' } })
      const t = this.table(res)
      if (!t) return json({ errors: [{ code: 22 }] }, 404, v)
      if (id !== undefined) {
        const row = t.get(id)
        if (!row) return json({ errors: [{ code: 87 }] }, 404, v)
        const one = this.display(row, res, u.searchParams.get('display'), false)
        return json(this.opts.pojedynczyJakoLista ? { [res]: [one] } : { [SINGULAR[res]!]: one }, 200, v)
      }
      let rows = [...t.values()]
      for (const [k, f] of u.searchParams) {
        const m = /^filter\[([a-z_]+)\]$/.exec(k)
        if (!m) continue
        if (m[1] === 'date_upd') {
          if (this.opts.filtrDat400) return json({ errors: [{ code: 32 }] }, 400, v)
          if (this.opts.ignorujFiltrDat) continue
        }
        rows = rows.filter((r) => matchFilter(r[m[1]!], f))
      }
      const shop = u.searchParams.get('id_shop')
      if (shop) rows = rows.filter((r) => !('id_shop' in r) || String(r['id_shop']) === shop)
      const sort = /^\[(.*)\]$/.exec(u.searchParams.get('sort') ?? '')?.[1]
      if (sort) {
        const keys = sort.split(',').map((s) => /^(.*)_(ASC|DESC)$/.exec(s)!).map((m) => ({ f: m[1]!, dir: m[2] === 'ASC' ? 1 : -1 }))
        rows.sort((a, b) => {
          for (const k of keys) {
            const [x, y] = [a[k.f], b[k.f]]
            const c = typeof x === 'number' || /^\d+$/.test(String(x)) ? Number(x) - Number(y) : String(x).localeCompare(String(y))
            if (c) return c * k.dir
          }
          return 0
        })
      }
      const limit = u.searchParams.get('limit')
      if (limit) {
        const [a, b] = limit.split(',').map(Number)
        rows = b === undefined ? rows.slice(0, a) : rows.slice(a, a! + b)
      }
      const out = rows.map((r) => this.display(r, res, u.searchParams.get('display'), true))
      if (!out.length && this.opts.pustaListaJakoTablica !== false) return json([], 200, v)
      return json({ [res]: out }, 200, v)
    }

    // ─── zapis ───
    if (req.contentType !== 'text/xml') return json({ errors: [{ code: 1 }] }, 400, v)
    const doc = parseWriteXml(req.body ?? '')
    if (!doc) return json({ errors: [{ code: 2, message: 'zły XML' }] }, 400, v)
    const fail = this.writeFailures.shift()
    if (fail === 'PRZEJSCIOWY') return json({}, 503, v)
    if (fail === 'TRWALY') return json({ errors: [{ code: 3 }] }, 400, v)
    const apply = (): Response | null => {
      if (res === 'stock_availables' && id && (method === 'PATCH' || method === 'PUT')) {
        const row = this.stock.get(id)
        if (!row) return json({ errors: [{ code: 87 }] }, 404, v)
        if (doc.resource !== 'stock_available' || doc.fields['id'] !== id) return json({ errors: [{ code: 4 }] }, 400, v)
        if (method === 'PATCH' && !(v && Number(v.split('.')[0]) >= 8)) return json({ errors: [{ code: 5, message: 'PATCH niedostępny' }] }, 405, v)
        // pola liczone przez sklep (1.7.x): odesłane = 400 „parameter not writable”, a przy PUT nie są wymagane
        for (const k of TYLKO_ODCZYT_STANU) if (k in doc.fields) return json({ errors: [{ code: 10, message: `parameter ${k} not writable` }] }, 400, v)
        if (method === 'PUT') for (const k of Object.keys(row)) if (!(k in doc.fields) && !TYLKO_ODCZYT_STANU.includes(k)) return json({ errors: [{ code: 6, message: `brak ${k}` }] }, 400, v)
        for (const [k, val] of Object.entries(doc.fields)) if (k !== 'id') row[k] = val
        return json({ stock_available: { id: Number(id) } }, 200, v)
      }
      if (res === 'order_histories' && !id && method === 'POST') {
        if (u.searchParams.has('sendemail')) return json({ errors: [{ code: 7 }] }, 400, v)
        const o = this.orders.get(doc.fields['id_order'] ?? '')
        if (!o || !this.states.has(doc.fields['id_order_state'] ?? '')) return json({ errors: [{ code: 8 }] }, 400, v)
        this.histories.push({ ...doc.fields })
        o['current_state'] = doc.fields['id_order_state']
        o['date_upd'] = this.local(new Date())
        return json({ order_history: { id: this.histories.length } }, 201, v)
      }
      return json({ errors: [{ code: 9 }] }, 405, v)
    }
    const r = apply()
    if (fail === 'TIMEOUT_PO_WYSLANIU') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    if (fail === '5XX_PO_WYSLANIU') return json({}, 502, v)
    return r!
  }
}
