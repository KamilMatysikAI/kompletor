// Atrapa Allegro w pamięci: REST (event-stats, events, checkout-forms) i serwer autoryzacji (token,
// device). Zero połączeń z prawdziwym Allegro; dane, tokeny i Client ID wyłącznie fikcyjne. Rejestruje każdą metodę
// i ścieżkę (strażnik tylko-odczytu). Refresh token jednorazowy jak w Allegro: po użyciu działa jeszcze 60 s.
// Jedno źródło: atrapy Wysyłam (`allegro-wysylam-atrapa.ts`) i zapisu
// (`allegro-zapis-atrapa.ts`) nie mają własnych tokenów ani OAuth — opakowują tę klasę (`base`) i biorą stąd `json`
// oraz `authorized`. Dziedziczenie zamiast opakowania zmieniłoby `fake.base…` w kilkunastu testach bez zysku.
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import type { FetchLike } from '@/lib/zrodla/http'

export const FAKE_CLIENT_ID = 'atrapa-client-id'
export const FAKE_CLIENT_SECRET = 'atrapa-client-secret-NIE-WYPISYWAC'
export const API = 'https://api.allegro.pl'
export const AUTH = 'https://allegro.pl'
export const UA = 'Kompletor Test/1.0 (+https://example.invalid)'

export interface FormSpec {
  id: string
  status?: string
  fulfillment?: string | null
  lines?: { id: string; offerId: string; qty: number | string; price?: number | string }[]
  updatedAt: string
  boughtAt?: string
  paymentType?: string
  paid?: number | null
  total?: number
  invoice?: boolean
  /** Odbiorca: faktura na firmę (domyślnie), firmę bez NIP albo osobę; punkt odbioru; brak adresu dostawy. */
  invoiceKind?: 'firma' | 'firma_bez_nip' | 'osoba'
  pickupPoint?: { id: string; name: string }
  bezAdresuDostawy?: boolean
}

/** Formularz zakupu jak w API, z fikcyjnymi danymi kupującego (wartości-wartownicy z suity kontraktowej). */
export function checkoutForm(s: FormSpec): Record<string, unknown> {
  const lines = s.lines ?? [{ id: `${s.id}-l1`, offerId: '10', qty: 1, price: 10 }]
  const total = s.total ?? lines.reduce((x, l) => x + Number(l.price ?? 10) * Number(l.qty), 0)
  const [name, email, phone, street, nip] = PII_SENTINELS
  return {
    id: s.id,
    messageToSeller: `wiadomość od ${name}`,
    buyer: { id: 'b1', email, login: 'kupujacy_testowy', firstName: name, lastName: name, phoneNumber: phone, address: { street, city: 'Testowo' } },
    payment: {
      id: `p-${s.id}`,
      type: s.paymentType ?? 'ONLINE',
      provider: 'P24',
      ...(s.paid === null || s.paid === undefined ? {} : { finishedAt: s.updatedAt, paidAmount: { amount: String(s.paid), currency: 'PLN' } }),
    },
    status: s.status ?? 'READY_FOR_PROCESSING',
    fulfillment: s.fulfillment === null ? undefined : { status: s.fulfillment ?? 'NEW' },
    delivery: {
      ...(s.bezAdresuDostawy ? {} : { address: { firstName: 'Jan', lastName: 'Testowy', companyName: null, street, zipCode: '00-001', city: 'Testowo', countryCode: 'PL', phoneNumber: phone } }),
      method: { id: 'm1', name: 'Allegro Paczkomaty InPost' },
      ...(s.pickupPoint ? { pickupPoint: { id: s.pickupPoint.id, name: s.pickupPoint.name, description: 'opis', address: { street, zipCode: '00-001', city: 'Testowo', countryCode: 'PL' } } } : {}),
    },
    invoice: {
      required: !!s.invoice,
      address: {
        street,
        zipCode: '00-001',
        city: 'Testowo',
        countryCode: 'PL',
        ...(s.invoiceKind === 'osoba'
          ? { naturalPerson: { firstName: 'Jan', lastName: 'Testowy' } }
          : { company: { name: 'Firma Fikcyjna sp. z o.o.', taxId: s.invoiceKind === 'firma_bez_nip' ? null : nip } }),
      },
    },
    lineItems: lines.map((l) => ({
      id: l.id,
      offer: { id: l.offerId, name: 'Przyprawa testowa' },
      quantity: l.qty,
      price: { amount: String(l.price ?? 10), currency: 'PLN' },
      tax: { rate: '23.00' },
      boughtAt: s.boughtAt ?? s.updatedAt,
    })),
    summary: { totalToPay: { amount: total.toFixed(2), currency: 'PLN' } },
    updatedAt: s.updatedAt,
  }
}

interface RefreshState {
  usedAt: number | null
  /** Zakres pary: odświeżenie zwraca ten sam, jak w Allegro. */
  scope: string
}

/** Zakres domyślny pary wydanej bez device flow (`issuePair()` w testach). */
export const ATRAPA_DOMYSLNY_ZAKRES = 'allegro:api:orders:read'

export class FakeAllegro {
  readonly forms = new Map<string, Record<string, unknown>>()
  /** oferty konta (GET /sale/offers); `offersPageMax` = ile najwyżej odda jedna strona (stronicowanie). */
  readonly offers = new Map<string, Record<string, unknown>>()
  offersPageMax = 1000
  /** szczegóły ofert (GET /sale/product-offers/{id}); brak wpisu = 404. Liczba = ten status HTTP. */
  readonly productOffers = new Map<string, Record<string, unknown> | number>()
  events: { id: string; formId: string; type: string; occurredAt: string }[] = []
  private seq = 0
  private issued = 0
  /** Każde żądanie: „METODA ścieżka”. */
  readonly requests: string[] = []
  readonly validAccess = new Set<string>()
  readonly refreshTokens = new Map<string, RefreshState>()
  /** Refresh tokeny unieważnione (wylogowanie, 3 miesiące). */
  readonly revoked = new Set<string>()
  /** Kolejne odpowiedzi API (status, Retry-After) zamiast normalnej — po jednej na żądanie GET. */
  apiFailures: { status: number; retryAfter?: string }[] = []
  /** Zdarzenia o id mniejszym niż to = poza retencją (400 dla `from`). */
  eventsFromMin = 0
  tokenDelayMs = 0
  /** Host linku weryfikacji w odpowiedzi device flow (test odrzucenia obcego hosta). */
  verificationHost = 'https://allegro.pl'
  tokenCalls = 0
  /** Device flow: kolejne odpowiedzi odpytywania (`ok` = wydaj parę). */
  deviceScript: string[] = []
  deviceCalls: { scope: string | null }[] = []
  /** Hooki między żądaniami (np. zamówienie złożone między event-stats a listą). */
  afterStats: (() => void) | null = null
  afterList: (() => void) | null = null
  /** Wołane na początku każdego żądania API (np. awaria dopiero przy drugim zamówieniu na stronie). */
  beforeApi: ((path: string) => void) | null = null
  clock: () => number = () => Date.now()
  /**
   * zakres w odpowiedzi tokena. Domyślnie Allegro przyznaje to, o co prosił
   * device flow (bez `scope` = zakres domyślny), a odświeżenie zwraca zakres pary. `grantScope` = Allegro przyznało
   * inny zakres (np. właściciel cofnął zgodę w Allegro), `omitScope` = odpowiedź bez pola `scope`.
   */
  grantScope: string | null = null
  omitScope = false
  private deviceScope: string | null = null

  /** Para tokenów wydana „przez autoryzację” (fikcyjna). */
  issuePair(scope: string = ATRAPA_DOMYSLNY_ZAKRES): { access: string; refresh: string } {
    this.issued++
    const access = `atrapa-access-${this.issued}-${Math.random().toString(36).slice(2)}`
    const refresh = `atrapa-refresh-${this.issued}-${Math.random().toString(36).slice(2)}`
    this.validAccess.add(access)
    this.refreshTokens.set(refresh, { usedAt: null, scope })
    return { access, refresh }
  }

  putForm(spec: FormSpec, type = 'BOUGHT'): void {
    this.forms.set(spec.id, checkoutForm(spec))
    this.addEvent(spec.id, type, spec.updatedAt)
  }

  addEvent(formId: string, type: string, occurredAt = new Date(this.clock()).toISOString()): void {
    this.events.push({ id: String(++this.seq).padStart(6, '0'), formId, type, occurredAt })
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    this.requests.push(`${method} ${u.pathname}`)
    const headers = new Headers(init?.headers)
    if (u.origin === AUTH) return this.oauth(u.pathname, method, headers, String(init?.body ?? ''))
    if (u.origin !== API) return json(404, { errors: [{ code: 'NOT_FOUND' }] })
    if (method !== 'GET') return json(405, {})
    if (headers.get('accept') !== 'application/vnd.allegro.public.v1+json') return json(406, {})
    this.beforeApi?.(u.pathname)
    const failure = this.apiFailures.shift()
    if (failure) return json(failure.status, { errors: [{ code: 'ATRAPA' }] }, failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {})
    if (!this.authorized(headers)) return json(401, { error: 'invalid_token' })
    return this.api(u)
  }

  private api(u: URL): Response {
    const p = u.pathname
    const q = u.searchParams
    if (p === '/sale/offers') {
      const limit = Math.min(Number(q.get('limit') ?? 20), this.offersPageMax)
      const offset = Number(q.get('offset') ?? 0)
      const all = [...this.offers.values()]
      const page = all.slice(offset, offset + limit)
      return json(200, { offers: page, count: page.length, totalCount: all.length })
    }
    if (p === '/order/event-stats') {
      const last = this.events[this.events.length - 1]
      const r = json(200, { latestEvent: last ? { id: last.id, occurredAt: last.occurredAt } : null })
      const h = this.afterStats
      this.afterStats = null
      h?.()
      return r
    }
    if (p === '/order/events') {
      const from = q.get('from')
      const limit = Math.min(Number(q.get('limit') ?? 100), 1000)
      let start = 0
      if (from) {
        if (Number(from) < this.eventsFromMin) return json(400, { errors: [{ code: 'EVENT_TOO_OLD' }] })
        const i = this.events.findIndex((e) => e.id === from)
        if (i < 0) return json(400, { errors: [{ code: 'UNKNOWN_EVENT' }] })
        start = i + 1
      }
      const events = this.events.slice(start, start + limit).map((e) => ({
        id: e.id,
        type: e.type,
        occurredAt: e.occurredAt,
        order: { checkoutForm: { id: e.formId }, buyer: { login: 'kupujacy_testowy', email: PII_SENTINELS[1] } },
      }))
      return json(200, { events })
    }
    if (p === '/order/checkout-forms') {
      const limit = Number(q.get('limit') ?? 100)
      const offset = Number(q.get('offset') ?? 0)
      if (limit > 100 || offset + limit > 10_000) return json(422, { errors: [{ code: 'VALIDATION' }] })
      const gte = q.get('updatedAt.gte')
      let list = [...this.forms.values()]
      if (gte) list = list.filter((f) => Date.parse(String(f['updatedAt'])) >= Date.parse(gte))
      list.sort((a, b) => Date.parse(String(a['updatedAt'])) - Date.parse(String(b['updatedAt'])) || String(a['id']).localeCompare(String(b['id'])))
      const r = json(200, { checkoutForms: list.slice(offset, offset + limit), count: Math.min(limit, Math.max(0, list.length - offset)), totalCount: list.length })
      const h = this.afterList
      this.afterList = null
      h?.()
      return r
    }
    const po = /^\/sale\/product-offers\/([^/]+)$/.exec(p)
    if (po) {
      const o = this.productOffers.get(decodeURIComponent(po[1]!))
      if (typeof o === 'number') return json(o, { errors: [{ code: 'ATRAPA' }] })
      return o ? json(200, o) : json(404, { errors: [{ code: 'NOT_FOUND' }] })
    }
    const m = /^\/order\/checkout-forms\/([^/]+)$/.exec(p)
    if (m) {
      const f = this.forms.get(decodeURIComponent(m[1]!))
      return f ? json(200, f) : json(404, { errors: [{ code: 'NOT_FOUND' }] })
    }
    return json(404, {})
  }

  private async oauth(path: string, method: string, headers: Headers, body: string): Promise<Response> {
    if (method !== 'POST') return json(405, {})
    const basic = Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')
    if (headers.get('authorization') !== `Basic ${basic}`) return json(401, { error: 'invalid_client' })
    const form = new URLSearchParams(body)
    if (path === '/auth/oauth/device') {
      this.deviceCalls.push({ scope: form.get('scope') })
      this.deviceScope = form.get('scope')
      return json(200, {
        device_code: 'atrapa-device-code-TAJNE',
        user_code: 'ABC-123',
        verification_uri: `${this.verificationHost}/skojarz-aplikacje`,
        verification_uri_complete: `${this.verificationHost}/skojarz-aplikacje?code=ABC-123`,
        expires_in: 3600,
        interval: 0,
      })
    }
    if (path !== '/auth/oauth/token') return json(404, {})
    this.tokenCalls++
    if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs))
    const grant = form.get('grant_type')
    if (grant === 'refresh_token') {
      const rt = form.get('refresh_token') ?? ''
      const st = this.refreshTokens.get(rt)
      const now = this.clock()
      if (!st || this.revoked.has(rt) || (st.usedAt !== null && now - st.usedAt > 60_000)) return json(400, { error: 'invalid_grant' })
      st.usedAt ??= now
      return this.tokenResponse(st.scope)
    }
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (form.get('device_code') !== 'atrapa-device-code-TAJNE') return json(400, { error: 'invalid_grant' })
      const next = this.deviceScript.shift() ?? 'authorization_pending'
      if (next === 'ok') return this.tokenResponse(this.deviceScope ?? ATRAPA_DOMYSLNY_ZAKRES)
      return json(400, { error: next })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  private tokenResponse(requested: string): Response {
    const scope = this.grantScope ?? requested
    const p = this.issuePair(scope)
    return json(200, { access_token: p.access, token_type: 'bearer', refresh_token: p.refresh, expires_in: 43_199, ...(this.omitScope ? {} : { scope }), jti: 'x' })
  }

  /** jedno sprawdzenie nagłówka `Bearer` dla wszystkich atrap Allegro (zapis, Wysyłam). */
  authorized(headers: Headers): boolean {
    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1]
    return !!bearer && this.validAccess.has(bearer)
  }

  /** Metody i ścieżki poza dozwolonymi zapisami OAuth (strażnik tylko-odczytu): powinno być tylko GET. */
  nonGet(): string[] {
    return this.requests.filter((r) => !r.startsWith('GET ') && r !== 'POST /auth/oauth/token' && r !== 'POST /auth/oauth/device')
  }
}

/** szczegóły oferty w kształcie `GET /sale/product-offers/{id}`: produkty zestawu z EAN-ami (id 225693). */
export function productOffer(id: string, eany: (string | null)[]): Record<string, unknown> {
  return {
    id,
    name: `Oferta testowa ${id}`,
    productSet: eany.map((ean, i) => ({
      quantity: { value: 1 },
      product: { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, parameters: ean ? [{ id: '225693', name: 'EAN (GTIN)', values: [ean] }, { id: '248811', name: 'Marka', values: ['Pracownia Testowa'] }] : [{ id: '248811', name: 'Marka', values: ['Pracownia Testowa'] }] },
    })),
    external: null,
  }
}

/** Odpowiedź JSON atrapy; wspólna dla atrap zapisu i Wysyłam z Allegro. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
