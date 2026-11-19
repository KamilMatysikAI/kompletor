// Shoper REST (`https://<sklep>/webapi/rest/…`) — dwa osobne klienty na wspólnej sesji:
//   ShoperReadOnly — wyłącznie GET; jedyny wyjątek to POST na `/auth` (token z loginu i hasła administratora API),
//                    zablokowany dla każdej innej ścieżki;
//   ShoperWriter   — wyłącznie PUT na `product-stocks/<id>` i `orders/<id>`; inne ścieżki i metody = błąd.
// Uwierzytelnienie: token Bearer podany wprost (integracja w panelu sklepu) albo token z `POST /webapi/rest/auth`
// (Basic login:hasło), trzymany tylko w pamięci instancji — nie trafia do bazy ani do logów. Bez logowania nagłówków,
// adresów, sekretów i treści odpowiedzi. Limit Shopera to wiadro cieknące (X-Shop-Api-Limit 10, X-Shop-Api-Bandwidth
// 2/s): odstęp 500 ms między żądaniami jednej sesji; 429 niesie Retry-After.
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'

export interface ShoperResponse<T> {
  status: number
  body: T | null // null przy 404
}

/** Błąd HTTP Shopera z czasem z nagłówka Retry-After (429), gdy był. */
export class ShoperHttpError extends SourceError {
  constructor(
    message: string,
    retryable: boolean,
    readonly status: number | null,
    readonly retryAfterMs?: number,
  ) {
    super(message, retryable)
    this.name = 'ShoperHttpError'
  }
}

/** Adres sklepu → baza REST (`https://sklep.pl`, także z `/webapi/rest`). Tylko https, bez `..`. */
export function shoperApiBase(url: string): string {
  const u = url.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s]+/i.test(u)) throw new Error('Adres sklepu Shoper musi zaczynać się od https://')
  if (u.includes('..')) throw new Error('zły adres sklepu Shoper')
  return `${u.replace(/\/webapi\/rest$/i, '')}/webapi/rest`
}

/** Retry-After w sekundach albo jako data HTTP → milisekundy; brak albo nieczytelny = undefined. */
export function retryAfterMsOf(v: string | null, now = Date.now()): number | undefined {
  if (v === null || v.trim() === '') return undefined
  const s = Number(v)
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000)
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : Math.max(0, t - now)
}

export type ShoperAuth = { token: string } | { login: string; password: string }

const okPath = (p: string) => p.startsWith('/') && !p.includes('..') && !p.includes('?') && !p.includes('#')

/** Wspólna sesja obu klientów: jeden token, jeden odstęp między żądaniami (limit liczy sklep, nie klient). */
export class ShoperSession {
  readonly base: string
  private readonly throttle: Throttle
  private token: string | null
  private authorizing: Promise<string> | null = null

  constructor(
    url: string,
    private readonly auth: ShoperAuth,
    readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 500,
    readonly retry: RetryOptions = { attempts: 3, baseDelayMs: 2_000 },
  ) {
    if ('token' in auth ? !auth.token : !auth.login || !auth.password) throw new Error('Brak tokena albo loginu i hasła Shoper')
    this.base = shoperApiBase(url)
    this.token = 'token' in auth ? auth.token : null
    this.throttle = new Throttle(minIntervalMs)
  }

  /** Czy token pochodzi z logowania (wtedy 401 = jedna ponowna autoryzacja). */
  get fromLogin(): boolean {
    return !('token' in this.auth)
  }

  private async authorize(): Promise<string> {
    if (!('login' in this.auth)) throw new ShoperHttpError('Shoper: token odrzucony', false, 401)
    const { login, password } = this.auth
    const basic = `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`
    const token = await withRetry(async () => {
      await this.throttle.wait()
      // POST /auth to jedyny POST tej integracji: wymiana loginu i hasła na token, niczego nie zapisuje w sklepie
      const res = await fetchWithTimeout(this.fetchImpl, `${this.base}/auth`, { method: 'POST', headers: { Authorization: basic, Accept: 'application/json' } }, 60_000)
      if (res.status === 429 || res.status >= 500) throw new ShoperHttpError(`Shoper /auth: HTTP ${res.status}`, true, res.status, retryAfterMsOf(res.headers.get('retry-after')))
      if (!res.ok) throw new ShoperHttpError(`Shoper /auth: HTTP ${res.status} (login albo hasło administratora API odrzucone)`, false, res.status)
      let body: unknown
      try {
        body = await res.json()
      } catch {
        throw new ShoperHttpError('Shoper /auth: odpowiedź nie jest JSON', true, res.status)
      }
      const t = (body as { access_token?: unknown } | null)?.access_token
      if (typeof t !== 'string' || !t) throw new ShoperHttpError('Shoper /auth: brak access_token w odpowiedzi', false, res.status)
      return t
    }, this.retry)
    this.token = token
    return token
  }

  async currentToken(): Promise<string> {
    if (this.token) return this.token
    this.authorizing ??= this.authorize().finally(() => (this.authorizing = null))
    return this.authorizing
  }

  /** Token z logowania odrzucony (401): zapominamy go, następne żądanie loguje się ponownie. */
  forget(token: string): void {
    if (this.token === token && this.fromLogin) this.token = null
  }

  async wait(): Promise<void> {
    await this.throttle.wait()
  }
}

/** Kody 403 Shopera z brakującym zakresem (`insufficient_scope`) — sam kod, bez treści odpowiedzi. */
async function scopeHint(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return /insufficient_scope/i.test(t) ? ' (token bez wymaganego zakresu uprawnień)' : ''
  } catch {
    return ''
  }
}

export class ShoperReadOnly {
  constructor(readonly session: ShoperSession) {}

  /**
   * GET ścieżki względem /webapi/rest. 404 → body null; 401 i 403 → błąd trwały (401 przy tokenie z logowania: jedna
   * ponowna autoryzacja); 429, 5xx, sieć → przejściowy, 429 z Retry-After.
   */
  async get<T>(path: string, query: Record<string, string | number> = {}, init: { method?: string } = {}): Promise<ShoperResponse<T>> {
    if ((init.method ?? 'GET') !== 'GET') throw new ReadOnlyViolation('Shoper: klient tylko do odczytu (GET)')
    if (!okPath(path) || path === '/auth') throw new Error('zła ścieżka Shoper')
    const s = this.session
    let reauth = s.fromLogin
    return withRetry(async () => {
      for (;;) {
        const token = await s.currentToken()
        await s.wait()
        const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))
        const res = await fetchWithTimeout(s.fetchImpl, `${s.base}${path}${qs.size ? `?${qs}` : ''}`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, 60_000)
        if (res.status === 401 && reauth) {
          reauth = false
          s.forget(token)
          continue
        }
        if (res.status === 404) return { status: 404, body: null }
        if (res.status === 429 || res.status >= 500) throw new ShoperHttpError(`Shoper ${path}: HTTP ${res.status}`, true, res.status, retryAfterMsOf(res.headers.get('retry-after')))
        if (res.status === 401) throw new ShoperHttpError(`Shoper ${path}: HTTP 401 (token odrzucony)`, false, 401)
        if (res.status === 403) throw new ShoperHttpError(`Shoper ${path}: HTTP 403 (brak prawa odczytu)${await scopeHint(res)}`, false, 403)
        if (!res.ok) throw new ShoperHttpError(`Shoper ${path}: HTTP ${res.status}`, false, res.status)
        try {
          return { status: res.status, body: (await res.json()) as T }
        } catch {
          // HTML zamiast JSON (przerwa techniczna, ochrona przed botami) — chwilowe, nie dane
          throw new ShoperHttpError(`Shoper ${path}: odpowiedź nie jest JSON`, true, res.status)
        }
      }
    }, s.retry)
  }
}

/** Ścieżki zapisu: stan jednej pozycji magazynowej i zamówienie (status). Nic poza tym. */
const WRITE_PATH = /^\/(product-stocks|orders)\/\d+$/

export interface ShoperWriteResult {
  status: number
  /** Odmowa z informacją o module magazynów (stan tylko do odczytu); sama flaga, bez treści odpowiedzi. */
  warehouses: boolean
  retryAfterMs?: number
}

export class ShoperWriter {
  constructor(readonly session: ShoperSession) {}

  /**
   * Jedno PUT bez ponawiania: wynik (także 4xx/5xx) wraca do adaptera, który decyduje o rodzaju błędu. Wyjątek tylko
   * przy błędzie sieci albo timeoucie (SourceError z fetchWithTimeout). 401 przy tokenie z logowania: jedna ponowna
   * autoryzacja (żądanie z odrzuconym tokenem nie zostało wykonane).
   */
  async put(path: string, body: Record<string, string | number>, init: { method?: string } = {}): Promise<ShoperWriteResult> {
    if ((init.method ?? 'PUT') !== 'PUT') throw new ReadOnlyViolation('Shoper: zapis tylko przez PUT')
    if (!okPath(path) || !WRITE_PATH.test(path)) throw new ReadOnlyViolation(`Shoper: zapis poza dozwolonymi ścieżkami (${path.slice(0, 60)})`)
    const s = this.session
    let reauth = s.fromLogin
    for (;;) {
      const token = await s.currentToken()
      await s.wait()
      const res = await fetchWithTimeout(
        s.fetchImpl,
        `${s.base}${path}`,
        { method: 'PUT', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        60_000,
      )
      if (res.status === 401 && reauth) {
        reauth = false
        s.forget(token)
        continue
      }
      let warehouses = false
      if (res.status === 400) {
        try {
          warehouses = /warehouse|magazyn/i.test(await res.text())
        } catch {
          // bez treści: zwykły 400
        }
      }
      const ra = res.status === 429 ? retryAfterMsOf(res.headers.get('retry-after')) : undefined
      return { status: res.status, warehouses, ...(ra !== undefined ? { retryAfterMs: ra } : {}) }
    }
  }
}
