// Atrapa ZAPISU Allegro w pamięci: komendy stanów ofert, status realizacji, numery nadania w zamówieniu,
// Wysyłam z Allegro (komendy utworzenia i anulowania przesyłki, etykieta). Nad atrapami
// (tokeny, OAuth, zamówienia, propozycje dostawy) bez zmian w tamtych. Zero połączeń z prawdziwym Allegro; dane fikcyjne.
// Komendy przetwarzają się asynchronicznie: `pendingPolls` = ile odczytów wyniku zwróci jeszcze „w toku”.
// Odbiór paczek przez kuriera (propozycje terminów i komenda zamówienia odbioru) jak w dokumentacji Wysyłam z Allegro.
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
  /** Kod błędu, którym Allegro odrzuca komendę utworzenia przy wyniku ERROR. */
  createErrorCode = 'INVALID_DIMENSIONS'
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
  /** komendy publikacji (END / ACTIVATE) i oferty, którym Allegro odmówi zmiany publikacji (zadanie FAIL). */
  readonly pubCommands = new Map<string, { action: string; offers: string[]; polls: number; failed: Map<string, string> }>()
  readonly rejectPublication = new Set<string>()
  /** Odbiór przez kuriera: terminy proponowane dla przesyłki (brak wpisu = `domyslneTerminy`). */
  readonly pickupTimes = new Map<string, { date: string; minTime?: string; maxTime?: string }[]>()
  domyslneTerminy: { date: string; minTime?: string; maxTime?: string }[] = [
    { date: '2026-11-23', minTime: '09:00', maxTime: '12:00' },
    { date: '2026-11-23', minTime: '12:00', maxTime: '16:00' },
    { date: '2026-11-24', minTime: '09:00', maxTime: '16:00' },
  ]
  readonly pickupCommands = new Map<string, { polls: number; outcome: 'SUCCESS' | 'ERROR'; pickupId: string | null; carrierPickupId: string | null; input: Record<string, unknown>; kod?: string }>()
  /**
   * Grupa odbioru przesyłki (brak wpisu = jedna wspólna grupa). Propozycje terminów zwracają jeden element tablicy na
   * grupę, a komenda odbioru z przesyłkami z dwóch grup kończy się ERROR `REQUIRES_SEPARATE_PICKUPS`.
   */
  readonly pickupGroup = new Map<string, string>()
  /** Odczyty szczegółów odbioru (`GET /shipment-management/pickups/{id}`): identyfikatory odbiorów. */
  readonly pickupReads: string[] = []
  /** Odbiory faktycznie zamówione (wejście komendy). */
  readonly pickups: Record<string, unknown>[] = []
  /** Wynik następnej komendy odbioru (potem SUCCESS). */
  nextPickupOutcome: ('SUCCESS' | 'ERROR')[] = []
  private seq = 0
  private readonly zeroRejected = new Set<string>()

  /** oferta konta w atrapie z publikacją (status, endedAt); `stock` = stan w atrapie zapisu. */
  putOffer(id: string, status: 'ACTIVE' | 'ENDED' | 'INACTIVE' | 'ACTIVATING', qty: number, endedAt?: string): void {
    this.base.offers.set(id, { id, name: `Oferta ${id}`, external: { id: `SKU-${id}` }, stock: { available: qty }, publication: { status, ...(endedAt ? { endedAt } : {}) } })
    this.stock.set(id, qty)
  }

  publicationOf(id: string): string | null {
    const of = this.base.offers.get(id)
    return of ? String(((of['publication'] ?? {}) as { status?: unknown }).status ?? '') : null
  }

  /** Komendy publikacji danej akcji (zapisy w Allegro). */
  pubActions(action: 'END' | 'ACTIVATE'): string[] {
    return [...this.pubCommands.values()].filter((c) => c.action === action).flatMap((c) => c.offers)
  }

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
        p.startsWith('/sale/offer-publication-commands') ||
        /^\/order\/checkout-forms\/[^/]+\/(fulfillment|shipments)$/.test(p) ||
        /^\/shipment-management\/shipments\/(create|cancel)-commands/.test(p) ||
        p.startsWith('/shipment-management/pickup') ||
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

  /** Adres odbioru wg `AddressDto`: wymagane ulica, miasto, kod, kraj, e-mail i telefon z prefiksem; null = poprawny. */
  private zlyAdres(a: unknown): string | null {
    const o = (a ?? {}) as Record<string, unknown>
    for (const k of ['street', 'city', 'postalCode', 'countryCode', 'email', 'phone']) if (!o[k]) return `address.${k}`
    if (!o['name'] && !o['company']) return 'address.name'
    if (!/^(\+|00)[1-9]\d{0,2}([ -]*\d){7,14}$/.test(String(o['phone']))) return 'address.phone'
    return null
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
        for (const o of offers) {
          // jak Allegro: aktywna oferta nie przyjmuje ilości 0 (INVALID_OFFER_QUANTITY)
          if (value === 0 && this.publicationOf(o) === 'ACTIVE') this.zeroRejected.add(`${id}:${o}`)
          else if (!this.rejectOffers.has(o)) {
            this.stock.set(o, value)
            const of = this.base.offers.get(o)
            if (of) of['stock'] = { available: value }
          }
        }
        return json(201, { id, taskCount: { total: offers.length, success: 0, failed: 0 } })
      }
      const c = this.qtyCommands.get(id)
      if (!c) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
      const failed = c.offers.filter((o) => this.rejectOffers.has(o) || this.zeroRejected.has(`${id}:${o}`))
      if (m[2]) {
        const all = c.offers.map((o) =>
          this.zeroRejected.has(`${id}:${o}`)
            ? { offer: { id: o }, status: 'FAIL', message: 'INVALID_OFFER_QUANTITY' }
            : { offer: { id: o }, status: failed.includes(o) ? 'FAIL' : 'SUCCESS', message: failed.includes(o) ? 'Oferta zakończona' : '' },
        )
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
    // ── publikacja ofert: END / ACTIVATE
    m = /^\/sale\/offer-publication-commands\/([^/]+)(\/tasks)?$/.exec(p)
    if (m) {
      const id = m[1]!
      if (method === 'PUT') {
        if (!scope(OFFERS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
        if (this.pubCommands.has(id)) return json(409, { errors: [{ code: 'CONFLICT' }] })
        const action = String((body['publication'] as { action?: unknown } | undefined)?.action ?? '')
        if (action !== 'END' && action !== 'ACTIVATE') return json(422, { errors: [{ code: 'VALIDATION_ERROR' }] })
        const offers = ((body['offerCriteria'] as { offers: { id: string }[] }[])[0]?.offers ?? []).map((o) => o.id)
        const failed = new Map<string, string>()
        for (const o of offers) {
          const of = this.base.offers.get(o)
          if (!of || this.rejectPublication.has(o)) failed.set(o, 'Odmowa zmiany publikacji (atrapa)')
          else if (action === 'ACTIVATE' && (this.stock.get(o) ?? Number(((of['stock'] ?? {}) as { available?: unknown }).available ?? 0)) <= 0) failed.set(o, 'Oferta bez liczby przedmiotów')
          else of['publication'] = action === 'END' ? { status: 'ENDED', endedAt: new Date(this.base.clock()).toISOString() } : { status: 'ACTIVE' }
        }
        this.pubCommands.set(id, { action, offers, polls: this.pendingPolls, failed })
        return json(201, { id, taskCount: { total: offers.length, success: 0, failed: 0 } })
      }
      const c = this.pubCommands.get(id)
      if (!c) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
      if (m[2]) return json(200, { tasks: c.offers.map((o) => ({ offer: { id: o }, status: c.failed.has(o) ? 'FAIL' : 'SUCCESS', message: c.failed.get(o) ?? '' })) })
      if (c.polls > 0) {
        c.polls--
        return json(200, { id, taskCount: { total: c.offers.length, success: 0, failed: 0 } })
      }
      return json(200, { id, taskCount: { total: c.offers.length, success: c.offers.length - c.failed.size, failed: c.failed.size } })
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
        // pola jak `ShipmentDto` Allegro: `carrier` = {carrierId} do historii statusów, `canceledDate` null
        this.wys.shipments.set(shipmentId, { id: shipmentId, carrier: 'ALLEGRO', canceledDate: null, packages: [{ waybill: this.waybillForNew }] })
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
      if (c.outcome === 'ERROR') return json(200, { commandId: m[2], status: 'ERROR', errors: [{ code: this.createErrorCode, message: 'atrapa' }] })
      return json(200, { commandId: m[2], status: 'SUCCESS', shipmentId: c.shipmentId })
    }
    if (p === '/shipment-management/shipments/cancel-commands' && method === 'POST') {
      if (!scope(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const id = String(body['commandId'] ?? '')
      if (this.cancelCommands.has(id)) return json(409, { errors: [{ code: 'COMMAND_ALREADY_EXISTS' }] })
      const shipmentId = String((body['input'] as Record<string, unknown> | undefined)?.['shipmentId'] ?? '')
      const ok = this.created.includes(shipmentId) && !this.cancelled.includes(shipmentId)
      if (ok) {
        this.cancelled.push(shipmentId)
        const s = this.wys.shipments.get(shipmentId)
        if (s) s['canceledDate'] = new Date(this.base.clock()).toISOString()
      }
      this.cancelCommands.set(id, { polls: this.pendingPolls, outcome: ok ? 'SUCCESS' : 'ERROR', shipmentId })
      return json(201, { commandId: id })
    }
    // ── odbiór przez kuriera
    if (p === '/shipment-management/pickup-proposals' && method === 'POST') {
      if (!scope(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const ids = Array.isArray(body['shipmentIds']) ? (body['shipmentIds'] as string[]) : []
      const blad = this.zlyAdres(body['address'])
      if (!ids.length || ids.length > 100 || blad) return json(400, { errors: [{ code: 'VALIDATION_ERROR', path: blad ?? 'shipmentIds' }] })
      const grupy = new Map<string, string[]>()
      for (const id of ids) grupy.set(this.pickupGroup.get(id) ?? '', [...(grupy.get(this.pickupGroup.get(id) ?? '') ?? []), id])
      return json(200, [...grupy.values()].map((g) => ({ proposals: g.map((id) => ({ shipmentId: id, pickupTimes: this.pickupTimes.get(id) ?? this.domyslneTerminy })), address: body['address'] })))
    }
    if (p === '/shipment-management/pickups/create-commands' && method === 'POST') {
      if (!scope(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const id = String(body['commandId'] ?? '')
      if (this.pickupCommands.has(id)) return json(409, { errors: [{ code: 'COMMAND_ALREADY_EXISTS' }] })
      const input = (body['input'] ?? {}) as Record<string, unknown>
      const pt = (input['pickupTime'] ?? {}) as Record<string, unknown>
      const blad = this.zlyAdres(input['address'])
      if (!Array.isArray(input['shipmentIds']) || !(input['shipmentIds'] as unknown[]).length || !pt['date'] || blad) return json(400, { errors: [{ code: 'VALIDATION_ERROR', path: blad ?? 'input' }] })
      const wGrupach = new Set((input['shipmentIds'] as string[]).map((x) => this.pickupGroup.get(x) ?? ''))
      const osobne = wGrupach.size > 1
      const outcome = osobne ? 'ERROR' : (this.nextPickupOutcome.shift() ?? 'SUCCESS')
      const n = ++this.seq
      if (outcome === 'SUCCESS') this.pickups.push(input)
      this.pickupCommands.set(id, { polls: this.pendingPolls, outcome, pickupId: outcome === 'SUCCESS' ? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` : null, carrierPickupId: outcome === 'SUCCESS' ? `CP${n}` : null, input, ...(osobne ? { kod: 'REQUIRES_SEPARATE_PICKUPS' } : {}) })
      return json(200, { commandId: id, input })
    }
    m = /^\/shipment-management\/pickups\/create-commands\/([^/]+)$/.exec(p)
    if (m && method === 'GET') {
      if (!scope(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const c = this.pickupCommands.get(m[1]!)
      if (!c) return new Response(null, { status: 404 })
      if (c.polls > 0) {
        c.polls--
        return json(200, { commandId: m[1], status: 'IN_PROGRESS' })
      }
      if (c.outcome === 'ERROR') return json(200, { commandId: m[1], status: 'ERROR', errors: [{ code: c.kod ?? 'PICKUP_TIME_NOT_AVAILABLE', message: 'atrapa' }] })
      return json(200, { commandId: m[1], status: 'SUCCESS', pickupId: c.pickupId, carrierPickupId: c.carrierPickupId, errors: [] })
    }
    m = /^\/shipment-management\/pickups\/([^/]+)$/.exec(p)
    if (m && method === 'GET' && m[1] !== 'create-commands') {
      if (!scope(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      this.pickupReads.push(m[1]!)
      const c = [...this.pickupCommands.values()].find((x) => x.pickupId === m![1] && x.outcome === 'SUCCESS')
      if (!c) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
      return json(200, { id: c.pickupId, carrierPickupId: c.carrierPickupId, carrier: 'ALLEGRO', shipmentIds: c.input['shipmentIds'] })
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
