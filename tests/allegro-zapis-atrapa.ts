// Atrapa ZAPISU Allegro w pamięci: komendy stanów ofert, status realizacji, numery nadania w zamówieniu,
// Wysyłam z Allegro (komendy utworzenia i anulowania przesyłki, etykieta). Nad atrapami
// (tokeny, OAuth, zamówienia, propozycje dostawy) bez zmian w tamtych. Zero połączeń z prawdziwym Allegro; dane fikcyjne.
// Komendy przetwarzają się asynchronicznie: `pendingPolls` = ile odczytów wyniku zwróci jeszcze „w toku”.
import type { FakeWriteFailure } from '@/lib/adaptery/falszywy'
import type { FetchLike } from '@/lib/zrodla/http'
import { API, json } from './allegro-atrapa'
import { FakeAllegroWysylam, SHIPMENTS_WRITE } from './allegro-wysylam-atrapa'

export { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, UA } from './allegro-atrapa'
export { deliveryProposal, SHIPMENTS_READ, SHIPMENTS_WRITE } from './allegro-wysylam-atrapa'

export const ORDERS_WRITE = 'allegro:api:orders:write'
export const OFFERS_WRITE = 'allegro:api:sale:offers:write'

interface QtyCommand {
  qty: number
  offers: string[]
  polls: number
}
interface ShipCommand {
  polls: number
  outcome: 'SUCCESS' | 'ERROR'
  shipmentId: string | null
  input: Record<string, unknown>
}

const lost = () => {
  throw new TypeError('fetch failed (atrapa: połączenie zerwane po wysłaniu)')
}

export class FakeAllegroZapis {
  readonly wys = new FakeAllegroWysylam()
  readonly qtyCommands = new Map<string, QtyCommand>()
  /** Stan ofert po wykonanych komendach. */
  readonly stock = new Map<string, number>()
  /** Oferty, które Allegro odrzuci w komendzie stanów (zadanie FAIL). */
  readonly rejectOffers = new Set<string>()
  readonly orderShipments = new Map<string, { id: string; waybill: string; carrierId: string; carrierName?: string }[]>()
  readonly createCommands = new Map<string, ShipCommand>()
  readonly cancelCommands = new Map<string, { polls: number; outcome: 'SUCCESS' | 'ERROR'; shipmentId: string }>()
  /** Przesyłki faktycznie utworzone (płatne etykiety) i anulowane. */
  readonly created: string[] = []
  readonly cancelled: string[] = []
  /** Ile odczytów wyniku nowej komendy zwróci „w toku”. */
  pendingPolls = 1
  /** Wynik następnej komendy utworzenia przesyłki (potem SUCCESS). */
  nextCreateOutcome: ('SUCCESS' | 'ERROR')[] = []
  /** Następny zapis (nie-GET) do API: błąd HTTP albo zerwanie połączenia przed/po wykonaniu. */
  writeFailures: (FakeWriteFailure | { status: number })[] = []
  /** Numer nadania, który Wysyłam z Allegro nada przesyłce (null = jeszcze bez numeru). */
  waybillForNew: string | null = 'AL000111222PL'
  /** Allegro przyjmuje komendę utworzenia, ale jej odczyt zwraca 404 (opóźnienie po stronie Allegro). */
  hideCreateCommands = false
  /** ile pierwszych odczytów komendy stanów zwróci `taskCount.total = 0` (zadania jeszcze niepoliczone). */
  qtyZeroTotalReads = 0
  /** kod odpowiedzi na powtórny PUT istniejącej komendy stanów (domyślnie 409). */
  repeatPutStatus = 409
  private seq = 0

  constructor() {
    this.wys.scopes.add(ORDERS_WRITE).add(OFFERS_WRITE).add(SHIPMENTS_WRITE)
  }

  get base() {
    return this.wys.base
  }
  get requests(): string[] {
    return this.base.requests
  }
  get scopes(): Set<string> {
    return this.wys.scopes
  }

  /** Zapisy (nie-GET) do API Allegro poza OAuth. */
  writes(): string[] {
    return this.base.nonGet()
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const p = u.pathname
    const mine =
      u.origin === API &&
      (p.startsWith('/sale/offer-quantity-change-commands') ||
        /^\/order\/checkout-forms\/[^/]+\/(fulfillment|shipments)$/.test(p) ||
        /^\/shipment-management\/shipments\/(create|cancel)-commands/.test(p) ||
        p === '/shipment-management/label')
    if (!mine) return this.wys.fetch(url, init)
    this.base.requests.push(`${method} ${p}`)
    const headers = new Headers(init?.headers)
    if (!this.base.authorized(headers)) return json(401, { error: 'invalid_token' })
    if (method !== 'GET' && headers.get('content-type') !== 'application/vnd.allegro.public.v1+json') return json(415, { errors: [{ code: 'UNSUPPORTED_MEDIA_TYPE' }] })
    let body: Record<string, unknown> = {}
    if (init?.body) body = JSON.parse(String(init.body)) as Record<string, unknown>
    let after: 'lost' | null = null
    if (method !== 'GET') {
      const f = this.writeFailures.shift()
      if (f !== undefined) {
        if (typeof f === 'object') return json(f.status, { errors: [{ code: 'ATRAPA' }] })
        if (f === 'PRZEJSCIOWY') return json(503, { errors: [{ code: 'ATRAPA' }] })
        if (f === 'TRWALY') return json(400, { errors: [{ code: 'VALIDATION_ERROR' }] })
        if (f === 'NIEJEDNOZNACZNY_NIEWYKONANY') lost()
        after = 'lost'
      }
    }
    const r = this.handle(method, p, u.searchParams, body)
    if (after === 'lost') lost()
    return r
  }

  private handle(method: string, p: string, q: URLSearchParams, body: Record<string, unknown>): Response {
    const scope = (s: string) => this.scopes.has(s)
    // ── stany
    let m = /^\/sale\/offer-quantity-change-commands\/([^/]+)(\/tasks)?$/.exec(p)
    if (m) {
      const id = m[1]!
      if (method === 'PUT') {
        if (!scope(OFFERS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
        if (this.qtyCommands.has(id)) return json(this.repeatPutStatus, { errors: [{ code: this.repeatPutStatus === 409 ? 'CONFLICT' : 'VALIDATION_ERROR' }] })
        const value = (body['modification'] as { value: number }).value
        const offers = ((body['offerCriteria'] as { offers: { id: string }[] }[])[0]?.offers ?? []).map((o) => o.id)
        if (offers.length > 1000) return json(422, { errors: [{ code: 'TOO_MANY_OFFERS' }] })
        this.qtyCommands.set(id, { qty: value, offers, polls: this.pendingPolls })
        for (const o of offers) if (!this.rejectOffers.has(o)) this.stock.set(o, value)
        return json(201, { id, taskCount: { total: offers.length, success: 0, failed: 0 } })
      }
      const c = this.qtyCommands.get(id)
      if (!c) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
      const failed = c.offers.filter((o) => this.rejectOffers.has(o))
      if (m[2]) {
        const all = c.offers.map((o) => ({ offer: { id: o }, status: failed.includes(o) ? 'FAIL' : 'SUCCESS', message: failed.includes(o) ? 'Oferta zakończona' : '' }))
        const off = Number(q.get('offset') ?? 0)
        const lim = Number(q.get('limit') ?? 100)
        return json(200, { tasks: all.slice(off, off + lim) })
      }
      if (this.qtyZeroTotalReads > 0) {
        this.qtyZeroTotalReads--
        return json(200, { id, taskCount: { total: 0, success: 0, failed: 0 } })
      }
      if (c.polls > 0) {
        c.polls--
        return json(200, { id, taskCount: { total: c.offers.length, success: 0, failed: 0 } })
      }
      return json(200, { id, taskCount: { total: c.offers.length, success: c.offers.length - failed.length, failed: failed.length } })
    }
    // ── status realizacji
    m = /^\/order\/checkout-forms\/([^/]+)\/fulfillment$/.exec(p)
    if (m && method === 'PUT') {
      if (!scope(ORDERS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const f = this.base.forms.get(m[1]!)
      if (!f) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
      f['fulfillment'] = { status: String(body['status']) }
      f['updatedAt'] = new Date(this.base.clock()).toISOString()
      return new Response(null, { status: 204 })
    }
    // ── numery nadania w zamówieniu
    m = /^\/order\/checkout-forms\/([^/]+)\/shipments$/.exec(p)
    if (m) {
      const id = m[1]!
      if (!this.base.forms.has(id)) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
      const list = this.orderShipments.get(id) ?? []
      if (method === 'GET') return json(200, { shipments: list })
      if (!scope(ORDERS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      if (!body['waybill'] || !body['carrierId'] || !Array.isArray(body['lineItems'])) return json(422, { errors: [{ code: 'VALIDATION_ERROR' }] })
      const s = { id: `sh-${++this.seq}`, waybill: String(body['waybill']), carrierId: String(body['carrierId']), ...(body['carrierName'] ? { carrierName: String(body['carrierName']) } : {}) }
      this.orderShipments.set(id, [...list, s])
      return json(201, s)
    }
    // ── Wysyłam z Allegro
    if (p === '/shipment-management/shipments/create-commands' && method === 'POST') {
      if (!scope(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const id = String(body['commandId'] ?? '')
      if (this.createCommands.has(id)) return json(409, { errors: [{ code: 'COMMAND_ALREADY_EXISTS' }] })
      const input = (body['input'] ?? {}) as Record<string, unknown>
      if (!input['receiver'] || !Array.isArray(input['packages'])) return json(422, { errors: [{ code: 'VALIDATION_ERROR' }] })
      // Allegro od 01.10.2026 odrzuca obecny telefon nadawcy albo odbiorcy bez prefiksu
      // kraju; brak pola przepuszczamy (to rozstrzyga prawdziwe Allegro)
      for (const k of ['sender', 'receiver']) {
        const tel = ((input[k] ?? {}) as Record<string, unknown>)['phone']
        if (tel !== undefined && tel !== null && tel !== '' && !/^\+\d{8,15}$/.test(String(tel))) return json(422, { errors: [{ code: 'VALIDATION_ERROR', path: `input.${k}.phone` }] })
      }
      const outcome = this.nextCreateOutcome.shift() ?? 'SUCCESS'
      let shipmentId: string | null = null
      if (outcome === 'SUCCESS') {
        shipmentId = `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`
        this.created.push(shipmentId)
        this.wys.shipments.set(shipmentId, { id: shipmentId, packages: [{ waybill: this.waybillForNew }] })
      }
      this.createCommands.set(id, { polls: this.pendingPolls, outcome, shipmentId, input })
      return json(201, { commandId: id })
    }
    m = /^\/shipment-management\/shipments\/(create|cancel)-commands\/([^/]+)$/.exec(p)
    if (m && method === 'GET') {
      const c = m[1] === 'create' ? (this.hideCreateCommands ? undefined : this.createCommands.get(m[2]!)) : this.cancelCommands.get(m[2]!)
      if (!c) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
      if (c.polls > 0) {
        c.polls--
        return json(200, { commandId: m[2], status: 'IN_PROGRESS' })
      }
      if (c.outcome === 'ERROR') return json(200, { commandId: m[2], status: 'ERROR', errors: [{ code: 'INVALID_DIMENSIONS', message: 'atrapa' }] })
      return json(200, { commandId: m[2], status: 'SUCCESS', shipmentId: c.shipmentId })
    }
    if (p === '/shipment-management/shipments/cancel-commands' && method === 'POST') {
      if (!scope(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const id = String(body['commandId'] ?? '')
      if (this.cancelCommands.has(id)) return json(409, { errors: [{ code: 'COMMAND_ALREADY_EXISTS' }] })
      const shipmentId = String((body['input'] as Record<string, unknown> | undefined)?.['shipmentId'] ?? '')
      const ok = this.created.includes(shipmentId) && !this.cancelled.includes(shipmentId)
      if (ok) this.cancelled.push(shipmentId)
      this.cancelCommands.set(id, { polls: this.pendingPolls, outcome: ok ? 'SUCCESS' : 'ERROR', shipmentId })
      return json(201, { commandId: id })
    }
    if (p === '/shipment-management/label' && method === 'POST') {
      if (!scope(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const ids = Array.isArray(body['shipmentIds']) ? (body['shipmentIds'] as string[]) : []
      if (!ids.length || ids.some((i) => !this.created.includes(i))) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
      return new Response(Buffer.from('%PDF-1.4 atrapa etykiety'), { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    }
    return json(404, {})
  }
}
