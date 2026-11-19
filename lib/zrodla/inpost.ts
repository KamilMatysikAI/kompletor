// InPost ShipX — klient TYLKO DO ODCZYTU. Dokumentacja: dokumentacja-inpost.atlassian.net (API ShipX),
// ścieżki potwierdzone w SDK michalbiarda/shipx-php-sdk. Tylko GET i tylko cztery ścieżki: organizacja, lista punktów,
// punkt, śledzenie. Tworzenie przesyłki, etykieta, zlecenie odbioru i webhooki kończą się wyjątkiem jeszcze przed
// wysyłką; przesyłki (`shipments`) też, bo ich odczyt zwraca dane odbiorcy. Token nie trafia do komunikatów błędów.
// Zapis jest osobno (lib/zrodla/inpost-zapis.ts), za wyłącznikiem.
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'

/** Tylko produkcja i sandbox: token idzie w nagłówku, więc nie może pójść pod inny adres. */
export const INPOST_URL_RE = /^https:\/\/(sandbox-)?api-shipx-pl\.easypack24\.net\/?$/

/** Identyfikator w ścieżce (id organizacji, nazwa punktu, numer przesyłki): bez ukośników, kropek i kodowania. */
export const INPOST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const SEG = '[A-Za-z0-9_-]{1,64}'
const READ_ONLY_PATHS = [new RegExp(`^/v1/organizations/${SEG}$`), /^\/v1\/points$/, new RegExp(`^/v1/points/${SEG}$`), new RegExp(`^/v1/tracking/${SEG}$`)]

/** Odmowa wszystkiego poza GET na czterech ścieżkach odczytu (zapytanie po „?” nie liczy się do ścieżki). */
export function assertInpostReadOnly(method: string, path: string): void {
  const p = path.split('?')[0] ?? ''
  if (method.toUpperCase() !== 'GET' || !READ_ONLY_PATHS.some((re) => re.test(p))) {
    throw new ReadOnlyViolation(`InPost ShipX: ${method.toUpperCase()} „${p}” nie jest odczytem (tryb „przygotuj, nie wysyłaj”)`)
  }
}

/** Błąd API z kodem HTTP: 401 i 403 → trwały (zły token, brak uprawnień), 429 i 5xx → przejściowy. */
export class InpostApiError extends SourceError {
  constructor(
    message: string,
    retryable: boolean,
    readonly status: number | null,
  ) {
    super(message, retryable)
    this.name = 'InpostApiError'
  }

  get kind(): 'PRZEJSCIOWY' | 'TRWALY' {
    return this.retryable ? 'PRZEJSCIOWY' : 'TRWALY'
  }
}

/** Wspólne dla klienta odczytu i zapisu: adres, token, czyszczenie komunikatów. */
export function inpostBase(baseUrl: string, token: string): string {
  if (!token) throw new Error('Brak tokenu API InPost ShipX')
  if (!INPOST_URL_RE.test(baseUrl)) throw new Error('Zły adres API InPost ShipX (tylko api-shipx-pl.easypack24.net albo sandbox-api-shipx-pl.easypack24.net)')
  return baseUrl.replace(/\/$/, '')
}

export const cleanToken = (message: string, token: string): string => (token ? message.split(token).join('***') : message)

export class InpostReadOnly {
  private readonly throttle: Throttle
  private readonly base: string

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 500,
    private readonly retry: RetryOptions = { attempts: 4, baseDelayMs: 5_000 },
  ) {
    this.base = inpostBase(baseUrl, token)
    this.throttle = new Throttle(minIntervalMs)
  }

  /**
   * GET z listy odczytu. `notFound: 'null'` = 404 to „nie ma” (punkt), inaczej 404 to błąd trwały.
   * Pusta albo nieczytelna treść to błąd, nigdy cichy pusty obiekt.
   */
  async get<T = unknown>(path: string, query: Record<string, string> = {}, opts: { notFound?: 'null' | 'error' } = {}): Promise<T | null> {
    assertInpostReadOnly('GET', path)
    const qs = new URLSearchParams(query).toString()
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`
    return withRetry(async () => {
      await this.throttle.wait()
      let res: Response
      try {
        // `redirect: 'error'`: przekierowanie zaniosłoby nagłówek z tokenem pod adres spoza listy
        res = await fetchWithTimeout(this.fetchImpl, url, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } }, 30_000)
      } catch (e) {
        if (e instanceof SourceError) throw new InpostApiError(`InPost ShipX ${path}: ${cleanToken(e.message, this.token)}`, e.retryable, null)
        throw e
      }
      if (res.status === 404 && opts.notFound === 'null') return null
      if (res.status === 429 || res.status >= 500) throw new InpostApiError(`InPost ShipX ${path}: HTTP ${res.status}`, true, res.status)
      if (!res.ok) throw new InpostApiError(`InPost ShipX ${path}: HTTP ${res.status}`, false, res.status)
      const text = await res.text()
      if (!text.trim()) throw new InpostApiError(`InPost ShipX ${path}: pusta odpowiedź`, false, res.status)
      try {
        return JSON.parse(text) as T
      } catch {
        throw new InpostApiError(`InPost ShipX ${path}: nieczytelna odpowiedź`, false, res.status)
      }
    }, this.retry)
  }
}
