// Atrapa HTTP API InPost ShipX: organizacja, punkty, śledzenie, przesyłki i etykieta w pamięci. Dane
// fikcyjne; odpowiedzi z przesyłkami niosą PII_SENTINELS (jak prawdziwe API, które zwraca odbiorcę), żeby testy
// sprawdziły, że nic z nich nie wychodzi do wyniku. Zero połączeń: fetch to funkcja w pamięci.
import { PII_SENTINELS } from '../lib/adaptery/suita-kontraktowa'

export const INPOST_SANDBOX = 'https://sandbox-api-shipx-pl.easypack24.net'
export const INPOST_TOKEN = 'token-testowy-shipx-0123456789'
export const INPOST_ORG = '4242'
export const INPOST_FAST = { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 }

export interface InpostCall {
  method: string
  url: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: Record<string, unknown> | null
  redirect?: string
}

export type InpostReply = { status: number; body: string | Uint8Array; headers?: Record<string, string> } | 'network-error'

export const json = (v: unknown, status = 200): InpostReply => ({ status, body: JSON.stringify(v), headers: { 'content-type': 'application/json' } })

/** Odbiorca z PII_SENTINELS (imię, e-mail, telefon, ulica). */
export const ODBIORCA_ATRAPY = {
  imieNazwisko: PII_SENTINELS[0]!,
  ulica: PII_SENTINELS[3]!,
  numerDomu: '1',
  kodPocztowy: '00-001',
  miasto: 'Testowo',
  telefon: PII_SENTINELS[2]!,
  email: PII_SENTINELS[1]!,
  // kształt RecipientAddress (kontrakt ShipmentCreateRequest)
  firma: null as string | null,
  numerLokalu: null as string | null,
  kraj: 'PL' as string | null,
}

export function inpostAtrapa() {
  const calls: InpostCall[] = []
  const queue: InpostReply[] = []
  const shipments: { id: number; reference: string; body: Record<string, unknown> }[] = []
  let nextId = 900_001
  let ignoreReferenceFilter = false
  const trackingReads = new Map<number, number>()
  /** status przesyłki ustawiony przez test (śledzenie); wygrywa z domyślnym „created/confirmed”. */
  const statusy = new Map<number, string>()

  const route = (c: InpostCall): InpostReply => {
    if (c.method === 'GET' && c.path === `/v1/organizations/${INPOST_ORG}`) return json({ id: Number(INPOST_ORG), name: 'Firma fikcyjna sp. z o.o.', tax_id: '0000000000', status: 'confirmed' })
    if (c.method === 'GET' && c.path === '/v1/points') return json({ items: [{ name: 'KRA010', type: ['parcel_locker'], status: 'Operating' }], count: 1, page: 1 })
    const point = /^\/v1\/points\/([^/]+)$/.exec(c.path)
    if (c.method === 'GET' && point) {
      if (point[1] === 'NIEMA01') return { status: 404, body: '{"error":"resource_not_found"}' }
      return json({ name: point[1], type: ['parcel_locker'], status: 'Operating', payment_available: true, location_description: 'przy sklepie', address: { line1: 'ul. Punktowa 1' } })
    }
    if (c.method === 'POST' && c.path === `/v1/organizations/${INPOST_ORG}/shipments`) {
      const id = nextId++
      shipments.push({ id, reference: String(c.body?.['reference']), body: c.body ?? {} })
      return json({ id, status: 'created', tracking_number: null, receiver: c.body?.['receiver'], reference: c.body?.['reference'] }, 201)
    }
    if (c.method === 'GET' && c.path === `/v1/organizations/${INPOST_ORG}/shipments`) {
      const ref = c.query['reference']
      const items = shipments.filter((s) => ignoreReferenceFilter || s.reference === ref).map((s) => ({ id: s.id, reference: s.reference, receiver: s.body['receiver'], status: 'confirmed' }))
      return json({ items, count: items.length })
    }
    // odczyt jednej przesyłki; numer nadania pojawia się od drugiego odczytu (ShipX nadaje go asynchronicznie)
    const jedna = /^\/v1\/shipments\/(\d+)$/.exec(c.path)
    if (c.method === 'GET' && jedna && statusy.has(Number(jedna[1]))) return json({ id: Number(jedna[1]), status: statusy.get(Number(jedna[1])), tracking_number: `6200000${jedna[1]}` })
    if (c.method === 'GET' && jedna) {
      const s = shipments.find((x) => x.id === Number(jedna[1]))
      if (!s) return { status: 404, body: '{"error":"resource_not_found"}' }
      const odczyty = (trackingReads.get(s.id) ?? 0) + 1
      trackingReads.set(s.id, odczyty)
      return json({ id: s.id, reference: s.reference, status: odczyty > 1 ? 'confirmed' : 'created', tracking_number: odczyty > 1 ? `6200000${s.id}` : null })
    }
    const label = /^\/v1\/shipments\/([^/]+)\/label$/.exec(c.path)
    if (c.method === 'GET' && label) return { status: 200, body: new TextEncoder().encode('%PDF-1.4 etykieta fikcyjna'), headers: { 'content-type': 'application/pdf' } }
    return { status: 404, body: '{"error":"resource_not_found"}' }
  }

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const c: InpostCall = {
      method: init?.method ?? 'GET',
      url,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      redirect: init?.redirect,
    }
    calls.push(c)
    const r = queue.shift() ?? route(c)
    if (r === 'network-error') throw new Error(`socket hang up (Authorization: Bearer ${INPOST_TOKEN})`)
    return new Response(r.body as BodyInit, { status: r.status, headers: r.headers })
  }

  return {
    calls,
    shipments,
    fetchImpl,
    /** Następne odpowiedzi po kolei, przed trasami atrapy. */
    reply: (...r: InpostReply[]) => queue.push(...r),
    /** Atrapa API, które ignoruje filtr `reference` listy przesyłek. */
    ignoreReferenceFilter: () => (ignoreReferenceFilter = true),
    /** status przesyłki w ShipX (np. `taken_by_courier`) zwracany przez GET /v1/shipments/{id}. */
    ustawStatus: (id: number, status: string) => statusy.set(id, status),
  }
}
