// PrestaShop Webservice (1.7, 8, 9) — dwa klienty:
//   PrestaReadOnly — TYLKO GET, każdy z output_format=JSON (odczyt zamówień, statusów, stanów, produktów);
//   PrestaWriter   — tylko zapis stanu (PATCH/PUT stock_availables/<id>), GET potrzebny do PUT i POST order_histories.
// Uwierzytelnienie: klucz Webservice jako nazwa użytkownika Basic, hasło puste. Punkt wejścia `<sklep>/api`
// (sklep może być w podkatalogu). Bez logowania nagłówków, adresów z kluczem ani treści odpowiedzi.
// Wszystko, czego dokumentacja nie rozstrzyga, jest w bloku [NIEPEWNE] niżej — jedno miejsce do potwierdzenia na
// sklepie demo (docs/integracje/prestashop.md, „Lista przed ogłoszeniem integracji”).
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'

// ─── [NIEPEWNE] — rozstrzygnie tylko próba na żywo ───────────────────────────

/** Nagłówek z wersją Webservice (np. „8.1.7”, „1.7.8.11”). Nie wiadomo, czy jest w każdej wersji. [NIEPEWNE] */
export const PRESTA_VERSION_HEADER = 'PSWS-Version'

/** Domyślne id statusów „anulowane” (6 anulowane, 7 zwrot, 8 błąd płatności); sklep może mieć inne. [NIEPEWNE] */
export const PRESTA_DEFAULT_CANCELLED = '6,7,8'

/**
 * Filtr zakresu dat zmiany zamówień: `filter[date_upd]=[od,do]` z `date=1` (format „RRRR-MM-DD GG:MM:SS”, czas
 * serwera sklepu, bez strefy). Oficjalna strona podaje `date=1` tylko przy sortowaniu; zakres dat znamy z opisu
 * integratora. Adapter i tak odrzuca wiersze spoza zakresu (ochrona). [NIEPEWNE]
 */
export function prestaDateRangeQuery(fromLocal: string, toLocal: string): Record<string, string> {
  return { 'filter[date_upd]': `[${fromLocal},${toLocal}]`, date: '1' }
}

/**
 * Lista z odpowiedzi JSON: `{ "<zasób>": [...] }`; pusta lista bywa (wg opisów) zwracana jako `[]` albo pusty
 * obiekt/treść. Null = kształt nieznany (wołający rzuca błąd). [NIEPEWNE]
 */
export function prestaListOf(body: unknown, resource: string): Record<string, unknown>[] | null {
  if (body === '' || body === null) return []
  if (Array.isArray(body)) return body.length === 0 ? [] : null
  if (typeof body !== 'object') return null
  const v = (body as Record<string, unknown>)[resource]
  if (v === undefined && Object.keys(body as object).length === 0) return []
  if (!Array.isArray(v)) return null
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
}

/** Jeden obiekt: `{ "<pojedyncza>": {...} }` albo `{ "<zasób>": [{...}] }`. Null = brak. [NIEPEWNE] */
export function prestaOneOf(body: unknown, singular: string, resource: string): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const one = b[singular]
  if (one && typeof one === 'object' && !Array.isArray(one)) return one as Record<string, unknown>
  const list = b[resource]
  if (Array.isArray(list) && list[0] && typeof list[0] === 'object') return list[0] as Record<string, unknown>
  return null
}

/** Flaga 0/1 z JSON (liczby bywają tekstem: „1”, „0”). Nieczytelna = null. [NIEPEWNE] */
export function prestaFlag(v: unknown): boolean | null {
  if (v === true || v === 1 || v === '1') return true
  if (v === false || v === 0 || v === '0' || v === '') return false
  return null
}

/**
 * Pola wiersza `stock_availables`, których nie odsyłamy przy PUT w 1.7 (w zasobie od 1.7.x, liczone przez sklep).
 * Odesłane mogą dać 400 „parameter not writable” albo nadpisać licznik rezerwacji sklepu starą wartością. [NIEPEWNE]
 */
export const PRESTA_PUT_POMIJANE: readonly string[] = ['physical_quantity', 'reserved_quantity']

/** Wersja ≥ 8 (PATCH jest w dokumentacji 8 i 9; w 1.7 go nie ma). Nieznana wersja = false (bezpieczny PUT). */
export function prestaHasPatch(version: string | null): boolean {
  if (!version) return false
  const major = Number(/^\s*(\d+)/.exec(version)?.[1])
  return Number.isInteger(major) && major >= 8
}

// ─── Wspólne ─────────────────────────────────────────────────────────────────

/** Adres sklepu → punkt wejścia Webservice (`https://sklep.pl[/podkatalog]` albo z `/api` → `…/api`). */
export function prestaApiBase(url: string): string {
  const u = url.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s]+/i.test(u)) throw new Error('Adres sklepu PrestaShop musi zaczynać się od https://')
  if (/[?#]/.test(u)) throw new Error('Adres sklepu PrestaShop bez parametrów (?, #)')
  return `${u.replace(/\/api$/i, '')}/api`
}

export type PrestaErrorReason = 'http' | 'html' | 'json' | 'network'

/** Błąd Webservice z kodem HTTP (bez treści odpowiedzi). `retryable` wg SourceError. */
export class PrestaError extends SourceError {
  constructor(
    message: string,
    retryable: boolean,
    readonly status: number | null,
    readonly reason: PrestaErrorReason,
  ) {
    super(message, retryable)
    this.name = 'PrestaError'
  }
}

export interface PrestaResponse<T> {
  status: number
  body: T | null // null przy 404
  /** Wersja z nagłówka PSWS-Version; null = brak nagłówka. */
  version: string | null
}

export type PrestaQuery = Record<string, string | number>

const HTML_MSG = 'sklep zwrócił stronę HTML zamiast odpowiedzi Webservice — włącz przepisywanie adresów (Apache: mod_rewrite, AllowOverride All) i Webservice w panelu'

const looksLikeHtml = (res: Response, text: string) => /text\/html/i.test(res.headers.get('content-type') ?? '') || /^\s*<(!doctype|html|head|body)\b/i.test(text)

/** Ścieżka zasobu: tylko litery, cyfry, podkreślenia i ukośniki, bez „..”. */
function assertPath(path: string): void {
  if (!/^\/[a-z_]+(\/\d+)?$/.test(path)) throw new Error(`zła ścieżka PrestaShop „${path}”`)
}

abstract class PrestaBase {
  protected readonly base: string
  protected readonly auth: string
  /** Limiter tempa; klient zapisu dostaje ten sam co odczyt, więc jeden sklep = jeden odstęp. */
  readonly throttle: Throttle

  constructor(
    url: string,
    key: string,
    protected readonly fetchImpl: FetchLike,
    minIntervalMs: number | Throttle,
  ) {
    if (!key) throw new Error('Brak klucza Webservice PrestaShop')
    this.base = prestaApiBase(url)
    this.auth = `Basic ${Buffer.from(`${key}:`, 'utf8').toString('base64')}`
    this.throttle = typeof minIntervalMs === 'number' ? new Throttle(minIntervalMs) : minIntervalMs
  }

  protected url(path: string, query: PrestaQuery): string {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))
    return `${this.base}${path}${qs.size ? `?${qs}` : ''}`
  }

  /** Jeden GET z output_format=JSON, bez ponowień (ponawia wołający). */
  protected async getOnce<T>(path: string, query: PrestaQuery): Promise<PrestaResponse<T>> {
    await this.throttle.wait()
    const res = await fetchWithTimeout(
      this.fetchImpl,
      this.url(path, { ...query, output_format: 'JSON' }),
      { method: 'GET', headers: { Authorization: this.auth, Accept: 'application/json' } },
      60_000,
    )
    const version = res.headers.get(PRESTA_VERSION_HEADER)?.trim() || null
    if (res.status === 404) return { status: 404, body: null, version }
    if (res.status === 429 || res.status >= 500) throw new PrestaError(`PrestaShop ${path}: HTTP ${res.status}`, true, res.status, 'http')
    if (res.status === 401) throw new PrestaError(`PrestaShop ${path}: HTTP 401 (klucz Webservice odrzucony)`, false, 401, 'http')
    if (res.status === 403) throw new PrestaError(`PrestaShop ${path}: HTTP 403 (klucz bez prawa odczytu tego zasobu)`, false, 403, 'http')
    if (!res.ok) throw new PrestaError(`PrestaShop ${path}: HTTP ${res.status}`, false, res.status, 'http')
    const text = await res.text()
    if (looksLikeHtml(res, text)) throw new PrestaError(`PrestaShop ${path}: ${HTML_MSG}`, false, res.status, 'html')
    if (text.trim() === '') return { status: res.status, body: '' as T, version } // pusta treść: kształt [NIEPEWNE]
    try {
      return { status: res.status, body: JSON.parse(text) as T, version }
    } catch {
      // XML albo ucięta odpowiedź — chwilowe (cache, przerwa), bez treści w komunikacie
      throw new PrestaError(`PrestaShop ${path}: odpowiedź nie jest JSON`, true, res.status, 'json')
    }
  }
}

// ─── Odczyt ──────────────────────────────────────────────────────────────────

export class PrestaReadOnly extends PrestaBase {
  constructor(
    url: string,
    key: string,
    fetchImpl: FetchLike = fetch,
    minIntervalMs = 500,
    private readonly retry: RetryOptions = { attempts: 3, baseDelayMs: 2_000 },
  ) {
    super(url, key, fetchImpl, minIntervalMs)
  }

  /** GET zasobu względem /api. 404 → body null; 401, 403, inne 4xx, HTML → trwały; 429, 5xx, sieć → przejściowy. */
  async get<T>(path: string, query: PrestaQuery = {}, init: { method?: string } = {}): Promise<PrestaResponse<T>> {
    if ((init.method ?? 'GET') !== 'GET') throw new ReadOnlyViolation('PrestaShop: klient tylko do odczytu (GET)')
    assertPath(path)
    return withRetry(() => this.getOnce<T>(path, query), this.retry)
  }
}

// ─── Zapis (za wyłącznikiem w adapterze) ─────────────────────────────────────

/** Tekst do XML: ucieczka &, <, >, ", ' i odrzucenie znaków sterujących spoza XML 1.0. */
export function xmlEscape(v: string | number | boolean): string {
  return String(v)
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Dokument zapisu Webservice: `<prestashop><zasób><pole>wartość</pole>…</zasób></prestashop>`, w jednej linii
 * (dokumentacja: bez formatowania wewnątrz znaczników). Wartości wyłącznie przez xmlEscape; nazwy pól sprawdzone.
 */
export function prestaXml(resource: string, fields: ReadonlyArray<readonly [string, string | number | boolean]>): string {
  const name = /^[a-z_][a-z0-9_]*$/
  if (!name.test(resource)) throw new Error(`zła nazwa zasobu XML „${resource}”`)
  const inner = fields
    .map(([k, v]) => {
      if (!name.test(k)) throw new Error(`zła nazwa pola XML „${k}”`)
      return `<${k}>${xmlEscape(v)}</${k}>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><prestashop xmlns:xlink="http://www.w3.org/1999/xlink"><${resource}>${inner}</${resource}></prestashop>`
}

const WRITE_RULES: ReadonlyArray<{ method: string; re: RegExp }> = [
  { method: 'GET', re: /^\/stock_availables\/\d+$/ }, // pełny wiersz przed PUT
  { method: 'PATCH', re: /^\/stock_availables\/\d+$/ },
  { method: 'PUT', re: /^\/stock_availables\/\d+$/ },
  { method: 'POST', re: /^\/order_histories$/ },
]

export interface PrestaWriteResponse {
  status: number
  version: string | null
}

/**
 * Klient zapisu: wyłącznie ścieżki z WRITE_RULES, inne = błąd przed wysłaniem. Bez ponowień: o ponowieniu decyduje
 * adapter (zapis stanu jest bezwzględny, wpis historii statusu — nie). Treści odpowiedzi nie czytamy.
 */
export class PrestaWriter extends PrestaBase {
  constructor(url: string, key: string, fetchImpl: FetchLike = fetch, minIntervalMs: number | Throttle = 500) {
    super(url, key, fetchImpl, minIntervalMs)
  }

  private check(method: string, path: string): void {
    if (!WRITE_RULES.some((r) => r.method === method && r.re.test(path))) throw new ReadOnlyViolation(`PrestaShop: zapis ${method} ${path} niedozwolony`)
  }

  /** GET wiersza stanu (do PUT całości). Błędy jak w odczycie, bez ponowień. */
  async getForPut<T>(path: string): Promise<PrestaResponse<T>> {
    this.check('GET', path)
    return this.getOnce<T>(path, { display: 'full' })
  }

  /** PATCH, PUT albo POST z dokumentem XML. Zwraca kod HTTP; sieć/timeout = PrestaError(reason: network). */
  async send(method: 'PATCH' | 'PUT' | 'POST', path: string, xml: string): Promise<PrestaWriteResponse> {
    this.check(method, path)
    await this.throttle.wait()
    let res: Response
    try {
      res = await fetchWithTimeout(
        this.fetchImpl,
        this.url(path, { output_format: 'JSON' }),
        { method, headers: { Authorization: this.auth, 'Content-Type': 'text/xml', Accept: 'application/json' }, body: xml },
        60_000,
      )
    } catch (e) {
      throw new PrestaError(`PrestaShop ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`, true, null, 'network')
    }
    // treść odpowiedzi zapisu pomijamy (może zawierać dane sklepu); zwalniamy ją bez czytania
    await res.body?.cancel().catch(() => {})
    return { status: res.status, version: res.headers.get(PRESTA_VERSION_HEADER)?.trim() || null }
  }
}
