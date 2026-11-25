// Atrapa Wysyłam z Allegro w pamięci: `GET /shipment-management/...` nad atrapą Allegro
// (tests/allegro-atrapa.ts: tokeny, OAuth, zamówienia), bez zmian w tamtej. Zero połączeń z prawdziwym Allegro; dane
// fikcyjne. `suggestedInput` niesie wartości-wartowników PII_SENTINELS: nie mogą wyjść z adaptera ani trafić do bazy.
// Zakresy tokenów są wspólne dla atrapy (`scopes`), jak dla jednej autoryzacji konta.
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import type { FetchLike } from '@/lib/zrodla/http'
import { API, FakeAllegro, json } from './allegro-atrapa'

export { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, UA } from './allegro-atrapa'

export const ORDERS_READ = 'allegro:api:orders:read'
export const SHIPMENTS_READ = 'allegro:api:shipments:read'
export const SHIPMENTS_WRITE = 'allegro:api:shipments:write'

/** Propozycja dostawy jak w specyfikacji: `deliveryOptions` i `suggestedInput` z nadawcą i odbiorcą (wartownicy). */
export function deliveryProposal(orderId: string, options: unknown[] = [defaultOption()]): Record<string, unknown> {
  const [name, email, phone, street, nip] = PII_SENTINELS
  const osoba = { name, company: nip, street, postalCode: '00-001', city: 'Testowo', countryCode: 'PL', email, phone }
  return {
    orderId,
    suggestedInput: {
      deliveryMethodId: 'metoda-przestarzala',
      credentialsId: 'konto-przestarzale',
      sender: osoba,
      receiver: { ...osoba, point: 'WAW01A' },
      packages: [{ type: 'PACKAGE', length: { value: 1, unit: 'CENTIMETER' }, width: { value: 1, unit: 'CENTIMETER' }, height: { value: 1, unit: 'CENTIMETER' }, weight: { value: 1, unit: 'KILOGRAMS' }, textOnLabel: name }],
      cashOnDelivery: { amount: '1.00', currency: 'PLN', ownerName: 'Sprzedawca Fikcyjny', iban: 'PL00000000000000000000000000' },
      additionalServices: ['ADDITIONAL_HANDLING'],
      additionalProperties: { sendingAtPoint: 'true', komentarz: email },
    },
    deliveryOptions: options,
  }
}

export function defaultOption(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryType: 'Allegro Paczkomaty InPost',
    paymentType: 'PREPAID',
    packageType: 'PACKAGE',
    originCountry: 'PL',
    destinationCountry: 'PL',
    limits: {
      cashOnDelivery: { amount: '5000.00', currency: 'PLN' },
      insurance: { amount: 5000, currency: 'PLN' },
      dimensions: { length: { value: 64, unit: 'CENTIMETER' }, width: { value: '38', unit: 'CENTIMETER' }, height: { value: 41.0, unit: 'CENTIMETER' } },
      weight: { value: '25.00', unit: 'KILOGRAMS' },
    },
    additionalServices: [{ id: 'x', name: PII_SENTINELS[0] }],
    additionalProperties: { komentarz: PII_SENTINELS[1] },
    ...over,
  }
}

export class FakeAllegroWysylam {
  readonly base = new FakeAllegro()
  /** Zakresy wydanej autoryzacji (wspólne dla wszystkich tokenów atrapy). */
  scopes = new Set([ORDERS_READ, SHIPMENTS_READ])
  readonly shipments = new Map<string, Record<string, unknown>>()
  readonly proposals = new Map<string, Record<string, unknown>>()
  /** Kolejne odpowiedzi `/shipment-management` (status, Retry-After) zamiast normalnej, po jednej na żądanie. */
  failures: { status: number; retryAfter?: string; body?: string }[] = []

  get requests(): string[] {
    return this.base.requests
  }

  /**
   * historia statusów `GET /order/carriers/{carrierId}/tracking?waybill=…`, klucz `${carrierId}:${waybill}`.
   * Brak wpisu = `trackingDetails: null` (Allegro nie zna numeru); wartość = lista `statuses`.
   */
  readonly tracking = new Map<string, Record<string, unknown>[]>()
  /** Kolejne odpowiedzi śledzenia zamiast normalnej (status, treść), po jednej na żądanie. */
  trackingFailures: { status: number; body?: unknown }[] = []

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    const sledzenie = /^\/order\/carriers\/([^/]+)\/tracking$/.exec(u.pathname)
    if (u.origin === API && sledzenie) {
      const method = (init?.method ?? 'GET').toUpperCase()
      this.base.requests.push(`${method} ${u.pathname}${u.search}`)
      const headers = new Headers(init?.headers)
      if (method !== 'GET') return json(405, {})
      if (headers.get('accept') !== 'application/vnd.allegro.public.v1+json') return json(406, {})
      if (!this.base.authorized(headers)) return json(401, { error: 'invalid_token' })
      const f = this.trackingFailures.shift()
      if (f) return json(f.status, (f.body ?? { errors: [{ code: 'ATRAPA' }] }) as Record<string, unknown>)
      const carrierId = sledzenie[1]!
      const waybills = u.searchParams.getAll('waybill')
      if (!waybills.length || waybills.length > 20) return json(400, { errors: [{ code: 'VALIDATION_ERROR' }] })
      return json(200, {
        carrierId,
        waybills: waybills.map((waybill) => {
          const statuses = this.tracking.get(`${carrierId}:${waybill}`)
          return { waybill, trackingDetails: statuses ? { statuses, createdAt: '2026-11-20T08:00:00.000Z', updatedAt: '2026-11-21T08:00:00.000Z' } : null }
        }),
      })
    }
    if (u.origin !== API || !u.pathname.startsWith('/shipment-management')) return this.base.fetch(url, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    this.base.requests.push(`${method} ${u.pathname}${u.search}`)
    const headers = new Headers(init?.headers)
    if (method !== 'GET') return json(405, {})
    if (headers.get('accept') !== 'application/vnd.allegro.public.v1+json') return json(406, {})
    const f = this.failures.shift()
    if (f) return f.body !== undefined ? new Response(f.body, { status: f.status }) : json(f.status, { errors: [{ code: 'ATRAPA' }] }, f.retryAfter ? { 'Retry-After': f.retryAfter } : {})
    if (!this.base.authorized(headers)) return json(401, { error: 'invalid_token' })
    const ship = /^\/shipment-management\/shipments\/([^/]+)$/.exec(u.pathname)
    if (ship) {
      if (!this.scopes.has(SHIPMENTS_READ) && !this.scopes.has(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const s = this.shipments.get(ship[1]!)
      return s ? json(200, s) : json(404, { errors: [{ code: 'NOT_FOUND' }] })
    }
    const prop = /^\/shipment-management\/delivery-proposals\/([^/]+)$/.exec(u.pathname)
    if (prop) {
      if (!this.scopes.has(SHIPMENTS_WRITE)) return json(403, { errors: [{ code: 'ACCESS_DENIED' }] })
      const p = this.proposals.get(prop[1]!)
      return p ? json(200, p) : json(404, { errors: [{ code: 'NOT_FOUND' }] })
    }
    return json(404, {})
  }

  /** Żądania inne niż GET poza OAuth: strażnik tylko-odczytu, powinno być pusto. */
  nonGet(): string[] {
    return this.base.nonGet()
  }
}
