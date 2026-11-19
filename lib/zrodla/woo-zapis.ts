// WooCommerce REST v3 — klient ZAPISU. Osobny klucz WC z prawem zapisu (sekret konta), klucz odczytu
// zostaje bez zmian. Wyłącznie ścieżki z WRITE_RULES; inne = błąd przed wysłaniem. Bez ponowień: o ponowieniu decyduje
// adapter (stan i status ustawia się bezwzględnie, notatka z numerem nadania — nie). Treści odpowiedzi zapisu czytamy
// tylko tam, gdzie niesie wynik pozycji (`products/batch`); bez logowania nagłówków, adresów ani treści.
import { fetchWithTimeout, ReadOnlyViolation, SourceError, Throttle, type FetchLike } from './http'
import { wooApiBase } from './woo'

const WRITE_RULES: ReadonlyArray<{ method: string; re: RegExp }> = [
  { method: 'POST', re: /^\/products\/batch$/ },
  { method: 'POST', re: /^\/products\/\d+\/variations\/batch$/ },
  { method: 'PUT', re: /^\/orders\/\d+$/ },
  { method: 'POST', re: /^\/orders\/\d+\/notes$/ },
]

export interface WooWriteResponse<T> {
  status: number
  /** Treść JSON (null, gdy nie JSON albo pusta). */
  body: T | null
}

/** Błąd sieci albo timeout PO wysłaniu żądania zapisu: nie wiadomo, czy sklep go wykonał. */
export class WooWriteNetworkError extends SourceError {
  constructor(message: string) {
    super(message, true)
    this.name = 'WooWriteNetworkError'
  }
}

export class WooWriter {
  private readonly base: string
  private readonly auth: string
  private readonly throttle: Throttle

  constructor(
    url: string,
    key: string,
    secret: string,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs: number | Throttle = 250,
  ) {
    if (!key || !secret) throw new Error('Brak klucza albo sekretu zapisu Woo')
    this.base = wooApiBase(url)
    this.auth = `Basic ${Buffer.from(`${key}:${secret}`, 'utf8').toString('base64')}`
    this.throttle = typeof minIntervalMs === 'number' ? new Throttle(minIntervalMs) : minIntervalMs
  }

  /** Czy ścieżka i metoda są dozwolone (test i strażnik przed wysłaniem). */
  static allowed(method: string, path: string): boolean {
    return WRITE_RULES.some((r) => r.method === method && r.re.test(path))
  }

  async send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<WooWriteResponse<T>> {
    if (!WooWriter.allowed(method, path)) throw new ReadOnlyViolation(`Woo: zapis ${method} ${path} niedozwolony`)
    await this.throttle.wait()
    let res: Response
    try {
      res = await fetchWithTimeout(
        this.fetchImpl,
        `${this.base}${path}`,
        { method, headers: { Authorization: this.auth, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
        60_000,
      )
    } catch (e) {
      throw new WooWriteNetworkError(`Woo ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
    let parsed: T | null = null
    try {
      parsed = (await res.json()) as T
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  }
}
