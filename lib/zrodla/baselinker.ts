// BaseLinker Connector API — klient TYLKO DO ODCZYTU (metody get*). Zapis do BL zablokowany w kodzie:
// BL zostaje źródłem prawdy do przełączenia (PROJEKT.md), a ten klient służy importowi i cieniowi.
import { fetchWithTimeout, ReadOnlyViolation, SourceError, Throttle, withRetry, type FetchLike } from './http'

const ENDPOINT = 'https://api.baselinker.com/connector.php'
const READ_ONLY_METHOD = /^get[A-Z][A-Za-z]+$/

export function assertBlReadOnly(method: string): void {
  if (!READ_ONLY_METHOD.test(method)) {
    throw new ReadOnlyViolation(`BaseLinker: metoda „${method}” nie jest odczytem (dozwolone tylko get*)`)
  }
}

// Kody BL, po których warto spróbować ponownie (limit zapytań, chwilowa niedostępność).
const RETRYABLE_CODES = new Set(['ERROR_TOO_MANY_REQUESTS', 'ERROR_BLOCKED_TOO_MANY_REQUESTS', 'ERROR_INTERNAL'])

export class BaseLinkerReadOnly {
  private readonly throttle: Throttle

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 650, // limit BL: 100 zapytań/min na token
  ) {
    if (!token) throw new Error('BASELINKER_TOKEN jest pusty')
    this.throttle = new Throttle(minIntervalMs)
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    assertBlReadOnly(method)
    return withRetry(
      async () => {
        await this.throttle.wait()
        const body = new URLSearchParams({ method, parameters: JSON.stringify(params) })
        const res = await fetchWithTimeout(
          this.fetchImpl,
          ENDPOINT,
          {
            method: 'POST',
            headers: { 'X-BLToken': this.token, 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          },
          60_000,
        )
        if (res.status >= 500 || res.status === 429) throw new SourceError(`BL ${method}: HTTP ${res.status}`, true)
        if (!res.ok) throw new SourceError(`BL ${method}: HTTP ${res.status}`, false)
        const json = (await res.json()) as Record<string, unknown>
        if (json['status'] === 'ERROR') {
          const code = String(json['error_code'] ?? '')
          throw new SourceError(`BL ${method}: ${code} ${String(json['error_message'] ?? '')}`, RETRYABLE_CODES.has(code))
        }
        return json as T
      },
      { attempts: 4, baseDelayMs: 2_000 },
    )
  }
}
