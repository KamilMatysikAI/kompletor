// IdoSell Admin API (REST, `https://<panel>/api/admin/<wersja>/…`) — dwa klienty na wspólnej sesji:
//   IdoSellOdczyt — wyłącznie POST na ścieżki wyszukiwania (`orders/orders/search`, `products/products/search`): w tym
//                   API wyszukiwanie to odczyt, a inne metody i ścieżki są zablokowane przed wysłaniem;
//   IdoSellZapis  — wyłącznie PUT na `products/stocks` (stan) i `orders/orders` (status); inne = błąd przed wysłaniem.
// Uwierzytelnienie: klucz API z panelu w nagłówku `X-API-KEY` (tryb „legacy” z dziennym kluczem SHA-1 pomijamy).
// Bez logowania nagłówków, adresów, klucza i treści odpowiedzi.
// Wiedza o API: oficjalna dokumentacja idosell.readme.io (wersja v8; ma pierwszeństwo) i konektor Open Integration
// Platform (Apache-2.0, Pinquark.com: integrators/ecommerce/idosell/v1.0.0/src/idosell/client.py, auth.py, ae43d1e) —
// przepisane po naszemu i zmienione (THIRD_PARTY_NOTICES.md). Ich ponowienia przy 429 śpią w kliencie; u nas 429
// przy zapisie wraca do hosta jako PRZEJSCIOWY z czasem ponowienia, a odczyt ponawia `withRetry`.
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'
import { retryAfterMsOf } from './shoper'

// ─── [NIEPEWNE] — rozstrzygnie tylko próba na koncie testowym ────────────────

/**
 * Kod błędu „brak wyników” w odpowiedzi wyszukiwania (`errors.faultCode`). Starsze API IdoSell odpowiadało nim zamiast
 * pustej listy, także z HTTP 404. [NIEPEWNE] — w v8 dokumentacja tego nie opisuje.
 */
export const IDOSELL_BRAK_WYNIKOW = 2

/** Domyślna wersja API (dokumentacja: v8; konektor OIP: v6). Konto może wskazać inną. */
export const IDOSELL_WERSJA = 'v8'
export const IDOSELL_WERSJE = ['v8', 'v7', 'v6'] as const

// ─── Wspólne ─────────────────────────────────────────────────────────────────

/** Adres panelu (`https://client123.idosell.com` albo domena sklepu, także z `/api/admin/vN`) → baza API. */
export function idosellApiBase(url: string, wersja: string = IDOSELL_WERSJA): string {
  const u = url.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s?#]+$/i.test(u.replace(/\/api\/admin\/v\d+$/i, ''))) throw new Error('Adres panelu IdoSell: tylko https://domena (bez ścieżki i parametrów)')
  if (!(IDOSELL_WERSJE as readonly string[]).includes(wersja)) throw new Error(`nieznana wersja API IdoSell „${wersja}” (v6, v7 albo v8)`)
  return `${u.replace(/\/api\/admin\/v\d+$/i, '')}/api/admin/${wersja}`
}

/** Błąd HTTP IdoSell z kodem i czasem z nagłówka Retry-After (429), gdy był. Bez treści odpowiedzi. */
export class IdoSellHttpError extends SourceError {
  constructor(
    message: string,
    retryable: boolean,
    readonly status: number | null,
    readonly retryAfterMs?: number,
  ) {
    super(message, retryable, status ?? undefined)
    this.name = 'IdoSellHttpError'
  }
}

export interface IdoSellResponse<T> {
  status: number
  /** null = pusta treść albo nie-JSON przy odpowiedzi zapisu (wołający decyduje). */
  body: T | null
  retryAfterMs?: number
}

/** Sesja jednego konta: adres API, klucz, jeden odstęp między żądaniami (limit liczy sklep, nie klient). */
export class IdoSellSesja {
  readonly base: string
  readonly throttle: Throttle

  constructor(
    url: string,
    wersja: string,
    private readonly apiKey: string,
    readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 300,
    readonly retry: RetryOptions = { attempts: 3, baseDelayMs: 2_000 },
  ) {
    if (!apiKey) throw new Error('Brak klucza API IdoSell')
    this.base = idosellApiBase(url, wersja)
    this.throttle = new Throttle(minIntervalMs)
  }

  /** Jedno żądanie JSON. Sieć i timeout = IdoSellHttpError(przejściowy, status null). */
  async send(method: 'POST' | 'PUT', path: string, body: unknown): Promise<Response> {
    await this.throttle.wait()
    try {
      return await fetchWithTimeout(
        this.fetchImpl,
        `${this.base}/${path}`,
        { method, headers: { 'X-API-KEY': this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        60_000,
      )
    } catch (e) {
      throw new IdoSellHttpError(`IdoSell ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`, true, null)
    }
  }
}

async function jsonOf<T>(res: Response): Promise<T | null> {
  const text = await res.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** `errors.faultCode` z odpowiedzi (obiekt albo brak); null = brak błędu bramki. */
export function faultCodeOf(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const e = (body as Record<string, unknown>)['errors']
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null
  const c = Number((e as Record<string, unknown>)['faultCode'])
  return Number.isFinite(c) ? c : null
}

// ─── Odczyt ──────────────────────────────────────────────────────────────────

const SCIEZKI_ODCZYTU = new Set(['orders/orders/search', 'products/products/search'])

export interface WynikWyszukiwania {
  /** Wiersze wyniku (`results`, w części odpowiedzi `Results`). */
  rows: Record<string, unknown>[]
  /** Liczba stron (`resultsNumberPage`); null = brak w odpowiedzi. */
  pages: number | null
  /** Liczba wszystkich wyników (`resultsNumberAll`); null = brak. */
  all: number | null
}

const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

export class IdoSellOdczyt {
  constructor(private readonly s: IdoSellSesja) {}

  /**
   * Wyszukiwanie (`POST <ścieżka>` z `{ params }`). 401 i 403 = trwały; 429, 5xx, sieć = przejściowy (ponawiany);
   * „brak wyników” (faultCode 2, także z HTTP 404) = pusta lista; inny 404 = trwały (pod adresem nie ma API IdoSell).
   */
  async search(path: string, params: Record<string, unknown>, init: { method?: string } = {}): Promise<WynikWyszukiwania> {
    if ((init.method ?? 'POST') !== 'POST' || !SCIEZKI_ODCZYTU.has(path)) throw new ReadOnlyViolation(`IdoSell: odczyt tylko przez wyszukiwanie, nie ${init.method ?? 'POST'} ${path}`)
    return withRetry(async () => {
      const res = await this.s.send('POST', path, { params })
      const st = res.status
      if (st === 429) throw new IdoSellHttpError(`IdoSell ${path}: HTTP 429 (limit zapytań)`, true, 429, retryAfterMsOf(res.headers.get('retry-after')))
      if (st >= 500) throw new IdoSellHttpError(`IdoSell ${path}: HTTP ${st}`, true, st)
      if (st === 401) throw new IdoSellHttpError(`IdoSell ${path}: HTTP 401 (klucz API odrzucony)`, false, 401)
      if (st === 403) throw new IdoSellHttpError(`IdoSell ${path}: HTTP 403 (klucz API bez uprawnienia do tego zasobu)`, false, 403)
      const body = await jsonOf<Record<string, unknown>>(res)
      if (faultCodeOf(body) === IDOSELL_BRAK_WYNIKOW && (st === 404 || st === 200 || st === 207)) return { rows: [], pages: 0, all: 0 }
      if (st === 404) throw new IdoSellHttpError(`IdoSell ${path}: HTTP 404 — adres nie odpowiada jak API IdoSell (sprawdź adres panelu i wersję API)`, false, 404)
      if (st !== 200 && st !== 207) throw new IdoSellHttpError(`IdoSell ${path}: HTTP ${st}`, false, st)
      if (!body) throw new IdoSellHttpError(`IdoSell ${path}: odpowiedź nie jest JSON`, true, st)
      const list = body['results'] ?? body['Results']
      if (!Array.isArray(list)) {
        const fc = faultCodeOf(body)
        throw new IdoSellHttpError(`IdoSell ${path}: odpowiedź bez listy wyników${fc ? ` (kod błędu ${fc})` : ''}`, false, st)
      }
      return {
        rows: list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)),
        pages: intOrNull(body['resultsNumberPage']),
        all: intOrNull(body['resultsNumberAll']),
      }
    }, this.s.retry)
  }
}

// ─── Zapis (za wyłącznikiem w adapterze) ─────────────────────────────────────

const SCIEZKI_ZAPISU = new Set(['products/stocks', 'orders/orders'])

/**
 * Klient zapisu: wyłącznie PUT na SCIEZKI_ZAPISU, inne = błąd przed wysłaniem. Bez ponowień: decyduje adapter (zapis
 * stanu i statusu jest bezwzględny, więc ponowienie tą samą wartością jest bezpieczne). Treść odpowiedzi czytamy tylko
 * po wynik per pozycja (kody błędów), bez przekazywania jej dalej.
 */
export class IdoSellZapis {
  constructor(private readonly s: IdoSellSesja) {}

  async put<T>(path: string, body: Record<string, unknown>): Promise<IdoSellResponse<T>> {
    if (!SCIEZKI_ZAPISU.has(path)) throw new ReadOnlyViolation(`IdoSell: zapis PUT ${path} niedozwolony`)
    const res = await this.s.send('PUT', path, body)
    const ra = res.status === 429 ? retryAfterMsOf(res.headers.get('retry-after')) : undefined
    return { status: res.status, body: await jsonOf<T>(res), ...(ra !== undefined ? { retryAfterMs: ra } : {}) }
  }
}
