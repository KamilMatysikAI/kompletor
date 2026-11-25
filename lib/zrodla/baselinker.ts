// BaseLinker Connector API — klient TYLKO DO ODCZYTU (metody get*). Zapis do BL zablokowany w kodzie:
// BL zostaje źródłem prawdy do przełączenia (PROJEKT.md), a ten klient służy importowi i cieniowi.
// jedyny wyjątek to `BaseLinkerStatusZapis` niżej — odczyty get* plus `setOrderStatus` (status „Kompletor”
// w BL dla zamówień zrealizowanych w Kompletorze). Żadna inna metoda zapisu nie przejdzie przez żaden klient BL.
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

/** metody zapisu BL dozwolone w kliencie `BaseLinkerStatusZapis` (zamknięta lista). */
export const BL_ZAPIS_DOZWOLONY: ReadonlySet<string> = new Set(['setOrderStatus'])

export function assertBlStatusZapis(method: string): void {
  if (READ_ONLY_METHOD.test(method) || BL_ZAPIS_DOZWOLONY.has(method)) return
  throw new ReadOnlyViolation(`BaseLinker: metoda „${method}” spoza listy dozwolonych (get* i setOrderStatus)`)
}

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

  /** Strażnik metody; klient zapisu statusu nadpisuje go listą `BL_ZAPIS_DOZWOLONY`. */
  protected guard(method: string): void {
    assertBlReadOnly(method)
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.guard(method)
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

/**
 * klient BL do ustawiania statusu zamówienia (`setOrderStatus`) i odczytów get*. Każda inna metoda zapisu
 * kończy się `ReadOnlyViolation` przed jakimkolwiek żądaniem. Ponowienie `setOrderStatus` jest bezpieczne (ten sam
 * status drugi raz niczego nie zmienia).
 */
export class BaseLinkerStatusZapis extends BaseLinkerReadOnly {
  protected override guard(method: string): void {
    assertBlStatusZapis(method)
  }
}
