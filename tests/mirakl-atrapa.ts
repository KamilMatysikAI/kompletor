// Atrapa Mirakl (Empik): `FetchLike` z kontem w pamięci — zamówienia (OR11 po `order_ids` i po dacie
// zmiany), oferty (OF21), akceptacja (OR21), numer nadania (OR23), wysłane (OR24) i import stanów (STO01, CSV w
// multipart). Kształt odpowiedzi i kody błędów wg dokumentacji Mirakl (developer.mirakl.com, odczyt 06.11.2026):
// sukces OR21/OR23/OR24 = 204 bez treści, STO01 = 201 z `import_id`, błąd = 400 z `{ status, message }`, gdzie
// komunikat niesie kod (ORDER_INVALID_STATE, ORDER_PARTIAL_ACCEPTANCE_DISABLED). Żadnych wywołań prawdziwego Empiku:
// adres `https://empik.example/api`. Dane zmyślone; pola osobowe niosą znaczniki PII_SENTINELS.
// wynik importu stanów STO02 (`GET /offers/stock/imports/{id}/status`: status WAITING/RUNNING/COMPLETE/FAILED,
// lines_in_success, lines_in_error, has_error_report wg developer.mirakl.com, odczyt 08.11.2026) i raport błędów STO03
// (`…/error_report`, CSV). Kształt raportu STO03 nie jest potwierdzony na koncie Empiku: atrapa oddaje wiersze pliku
// z kolumnami „error-line” i „error-message” (jak raporty importów ofert Mirakla). Wiersz odrzucony = shop_sku, którego
// nie ma w ofertach atrapy, albo kod magazynu spoza `magazyny` (pusta kolumna = stan całej oferty).
import type { FetchLike } from '@/lib/zrodla/http'
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'

export const MIRAKL_HOST = 'https://empik.example/api'
export const MIRAKL_KEY = 'klucz-test'

export type MiraklWriteFailure =
  | 'PRZEJSCIOWY' // 503, zapis się nie wykonał
  | 'TRWALY' // 400 VALIDATION_ERROR
  | 'LIMIT' // 429 z Retry-After
  | 'SIEC_PO_WYKONANIU' // zapis wykonany, odpowiedź zgubiona (wyjątek sieci)
  | 'SIEC' // wyjątek sieci, zapis się nie wykonał
  | 'CZESCIOWA_WYLACZONA' // OR21 z odrzuconą pozycją: ORDER_PARTIAL_ACCEPTANCE_DISABLED
  | 'BRAK_STO01' // STO01: 404 (konto bez importu stanów)

export interface ZapytanieMirakl {
  method: string
  path: string
  query: Record<string, string>
  /** JSON albo treść pliku CSV (STO01). */
  body: unknown
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const blad = (status: number, code: string) => json({ status, message: `${code}: zmyślony komunikat atrapy` }, status)

export interface ImportAtrapy {
  status: 'WAITING' | 'RUNNING' | 'COMPLETE' | 'FAILED'
  przyjete: number
  bledy: { line: number; row: string; reason: string }[]
}

export interface ZamowienieAtrapy {
  id: string
  state: string
  lines: { id: string; sku: string; qty: number; state?: string }[]
  createdAt?: string
  updatedAt?: string
}

export class MiraklAtrapa {
  readonly orders = new Map<string, Record<string, unknown>>()
  readonly offers = new Map<string, Record<string, unknown>>()
  /** Wszystkie żądania (bez nagłówków). */
  readonly zapytania: ZapytanieMirakl[] = []
  /** Zaimportowane stany: offer-sku → ilość (ostatni import). */
  readonly stany = new Map<string, number>()
  readonly tracking = new Map<string, Record<string, unknown>>()
  private readonly failures: MiraklWriteFailure[] = []
  private importId = 1000
  private nextGetStatus: number | null = null
  /** STO02: wyniki importów po `import_id`. */
  readonly importy = new Map<string, ImportAtrapy>()
  /** Ile kolejnych odczytów STO02 nowego importu zwraca jeszcze WAITING (domyślnie 0: od razu wynik). */
  odczytowWToku = 0
  private readonly wToku = new Map<string, number>()
  /** Następny import stanów kończy się FAILED (cały plik odrzucony). */
  nastepnyImportNieudany = false
  /** Kody magazynów konta w Empiku (STO01 `warehouse-code`); pusty kod zawsze dozwolony. */
  magazyny = new Set<string>()

  /** Następny odczyt (GET) kończy się tym kodem HTTP. */
  failNextGet(status: number): void {
    this.nextGetStatus = status
  }

  putOrder(o: ZamowienieAtrapy): void {
    const now = o.updatedAt ?? '2026-11-06T08:00:00Z'
    this.orders.set(o.id, {
      order_id: o.id,
      order_state: o.state,
      created_date: o.createdAt ?? '2026-11-06T07:00:00Z',
      last_updated_date: now,
      total_price: o.lines.reduce((a, l) => a + l.qty * 10, 0),
      currency_iso_code: 'PLN',
      payment_type: 'Empik',
      shipping_type_label: 'Kurier DPD',
      customer: { firstname: PII_SENTINELS[0], shipping_address: { street_1: PII_SENTINELS[3], phone: PII_SENTINELS[2] } },
      order_lines: o.lines.map((l) => ({ order_line_id: l.id, product_sku: l.sku, offer_sku: `S-${l.sku}`, quantity: l.qty, price_unit: 10, order_line_state: l.state ?? o.state })),
    })
  }

  putOffer(productSku: string, shopSku: string | null, qty: number | null = 5): void {
    this.offers.set(`${productSku}/${this.offers.size}`, { offer_id: 9000 + this.offers.size, product_sku: productSku, shop_sku: shopSku, product_title: `Produkt ${productSku}`, active: true, quantity: qty, product_references: [] })
  }

  stateOf(id: string): string | undefined {
    return this.orders.get(id)?.['order_state'] as string | undefined
  }

  injectWriteFailure(f: MiraklWriteFailure): void {
    this.failures.push(f)
  }

  /** Metody zapisu wysłane przez adapter (bez GET). */
  zapisy(): ZapytanieMirakl[] {
    return this.zapytania.filter((z) => z.method !== 'GET')
  }

  readonly fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const u = new URL(url)
    if (!url.startsWith(MIRAKL_HOST)) throw new Error(`atrapa Mirakl: obcy adres ${u.host}`)
    const path = u.pathname.replace(/^\/api/, '')
    const query = Object.fromEntries(u.searchParams.entries())
    let body: unknown = null
    if (init?.body instanceof FormData) {
      const f = init.body.get('file')
      body = f instanceof Blob ? await f.text() : null
    } else if (typeof init?.body === 'string') body = JSON.parse(init.body)
    this.zapytania.push({ method, path, query, body })
    if ((init?.headers as Record<string, string> | undefined)?.['Authorization'] !== MIRAKL_KEY) return blad(401, 'UNAUTHORIZED')
    if (method === 'GET') return this.get(path, query)
    const f = this.failures.shift()
    if (f === 'SIEC') throw new TypeError('fetch failed')
    if (f === 'PRZEJSCIOWY') return json({ status: 503 }, 503)
    if (f === 'LIMIT') return json({ status: 429 }, 429, { 'retry-after': '60' })
    if (f === 'TRWALY') return blad(400, 'VALIDATION_ERROR')
    const res = this.write(method, path, body, f)
    if (f === 'SIEC_PO_WYKONANIU') throw new TypeError('fetch failed')
    return res
  }

  private get(path: string, q: Record<string, string>): Response {
    if (this.nextGetStatus) {
      const s = this.nextGetStatus
      this.nextGetStatus = null
      return json({ status: s }, s)
    }
    if (path === '/orders') {
      if (q['order_ids']) return json({ orders: q['order_ids'].split(',').map((i) => this.orders.get(i)).filter(Boolean), total_count: 1 })
      const from = q['start_update_date']
      const max = Number(q['max'] ?? 10)
      const offset = Number(q['offset'] ?? 0)
      const all = [...this.orders.values()].filter((o) => !from || String(o['last_updated_date']) >= from).sort((a, b) => String(a['created_date']).localeCompare(String(b['created_date'])))
      return json({ orders: all.slice(offset, offset + max), total_count: all.length })
    }
    const imp = /^\/offers\/stock\/imports\/([^/]+)\/(status|error_report)$/.exec(path)
    if (imp) {
      const r = this.importy.get(imp[1]!)
      if (!r) return blad(404, 'NOT_FOUND')
      if (imp[2] === 'status') {
        const left = this.wToku.get(imp[1]!) ?? 0
        if (left > 0) {
          this.wToku.set(imp[1]!, left - 1)
          return json({ import_id: imp[1], shop_id: 1, date_created: '2026-11-06T08:00:00Z', status: 'WAITING', has_error_report: false })
        }
        if (r.status === 'FAILED') return json({ import_id: imp[1], shop_id: 1, date_created: '2026-11-06T08:00:00Z', status: 'FAILED', has_error_report: false })
        return json({ import_id: imp[1], shop_id: 1, date_created: '2026-11-06T08:00:00Z', status: r.status, has_error_report: r.bledy.length > 0, lines_in_success: r.przyjete, lines_in_error: r.bledy.length })
      }
      if (!r.bledy.length) return blad(404, 'NOT_FOUND')
      const csv = ['"offer-sku";"quantity";"warehouse-code";"update-delete";"error-line";"error-message"', ...r.bledy.map((b) => `${b.row};"${b.line}";"${b.reason}"`)].join('\n')
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })
    }
    if (path === '/offers') {
      const max = Number(q['max'] ?? 10)
      const offset = Number(q['offset'] ?? 0)
      const all = [...this.offers.values()]
      return json({ offers: all.slice(offset, offset + max), total_count: all.length })
    }
    return blad(404, 'NOT_FOUND')
  }

  private write(method: string, path: string, body: unknown, f: MiraklWriteFailure | undefined): Response {
    if (method === 'POST' && path === '/offers/stock/imports') {
      if (f === 'BRAK_STO01') return blad(404, 'NOT_FOUND')
      const rows = String(body ?? '').trim().split('\n')
      if (rows[0] !== '"offer-sku";"quantity";"warehouse-code";"update-delete"') return blad(400, 'VALIDATION_ERROR')
      const id = String(++this.importId)
      if (this.nastepnyImportNieudany) {
        this.nastepnyImportNieudany = false
        this.importy.set(id, { status: 'FAILED', przyjete: 0, bledy: [] })
      } else {
        const shopSkus = new Set([...this.offers.values()].map((o) => o['shop_sku']).filter((x): x is string => typeof x === 'string'))
        const wynik: ImportAtrapy = { status: 'COMPLETE', przyjete: 0, bledy: [] }
        for (const [i, r] of rows.slice(1).entries()) {
          const [sku, qty, wh] = r.split(';').map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"'))
          const reason = !shopSkus.has(sku!) ? 'zmyślony błąd atrapy: brak oferty' : wh && !this.magazyny.has(wh) ? 'zmyślony błąd atrapy: nieznany magazyn' : null
          if (reason) wynik.bledy.push({ line: i + 2, row: r, reason })
          else {
            wynik.przyjete++
            this.stany.set(sku!, Number(qty))
          }
        }
        this.importy.set(id, wynik)
      }
      if (this.odczytowWToku) this.wToku.set(id, this.odczytowWToku)
      return json({ import_id: id }, 201)
    }
    const m = /^\/orders\/([^/]+)\/(accept|tracking|ship)$/.exec(path)
    if (method !== 'PUT' || !m) return blad(404, 'NOT_FOUND')
    const o = this.orders.get(m[1]!)
    if (!o) return blad(404, 'ORDER_NOT_FOUND')
    const lines = o['order_lines'] as Record<string, unknown>[]
    if (m[2] === 'accept') {
      if (o['order_state'] !== 'WAITING_ACCEPTANCE') return blad(400, 'ORDER_INVALID_STATE')
      const d = (body as { order_lines?: { id: string; accepted: boolean }[] }).order_lines ?? []
      if (lines.some((l) => !d.find((x) => x.id === l['order_line_id']))) return blad(400, 'ORDER_LINE_ACCEPTANCE_DECISION_MISSING')
      const refused = d.filter((x) => !x.accepted)
      if (refused.length && refused.length < lines.length && f === 'CZESCIOWA_WYLACZONA') return blad(400, 'ORDER_PARTIAL_ACCEPTANCE_DISABLED')
      for (const l of lines) l['order_line_state'] = d.find((x) => x.id === l['order_line_id'])!.accepted ? 'WAITING_DEBIT' : 'REFUSED'
      o['order_state'] = refused.length === lines.length ? 'REFUSED' : 'WAITING_DEBIT'
      return new Response(null, { status: 204 })
    }
    if (m[2] === 'tracking') {
      this.tracking.set(m[1]!, body as Record<string, unknown>)
      return new Response(null, { status: 204 })
    }
    if (o['order_state'] !== 'SHIPPING') return blad(400, 'ORDER_INVALID_STATE')
    o['order_state'] = 'SHIPPED'
    return new Response(null, { status: 204 })
  }
}
