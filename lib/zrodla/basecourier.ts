// Base Courier (dawna BL Paczka) — klient TYLKO DO ODCZYTU. Endpointy z oficjalnej dokumentacji API
// (OpenAPI, https://api.basecourier.com/api/docs) i wtyczki WooCommerce „BLPaczka” 1.3.6. Zawsze POST z JSON,
// uwierzytelnienie w treści żądania, więc metoda HTTP niczego tu nie mówi: o odczycie decyduje lista endpointów.
// Tworzenie przesyłki, anulowanie i pobranie etykiety kończą się wyjątkiem jeszcze przed wysyłką.
// Klucz i login nie trafiają do komunikatów błędów.
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'

/**
 * Tylko produkcja i sandbox: klucz leży w treści żądania, więc nie może pójść pod inny adres. Dwie domeny operatora:
 * `blpaczka.com` (dawna nazwa, produkcja odpowiada wprost) i `basecourier.com` (adresy z dokumentacji; sandbox jest już
 * tylko tam, `sandbox.blpaczka.com` przekierowuje 301, a za przekierowaniem klient nie idzie).
 */
export const BASE_COURIER_URL_RE = /^https:\/\/(api|sandbox)\.(blpaczka|basecourier)\.com\/api\/?$/
/** Komunikat złego adresu (bez wartości adresu: mógłby nieść cokolwiek). */
export const BASE_COURIER_ZLY_ADRES = 'Zły adres API Base Courier (tylko api albo sandbox w domenie basecourier.com lub blpaczka.com, ścieżka /api)'

// Bez `getOrderDetails*` i `getWaybillTracking`: zwracają dane odbiorcy. Dopisać razem z konsumentem i testem, że odpowiedź nie trafia do bazy ani logu.
const READ_ONLY_ENDPOINTS = new Set(['getValuation.json', 'getProfile.json', 'getPaymentOptions.json', 'couriers'])

export function assertBaseCourierReadOnly(endpoint: string): void {
  if (!READ_ONLY_ENDPOINTS.has(endpoint)) {
    throw new ReadOnlyViolation(`Base Courier: endpoint „${endpoint}” nie jest odczytem (tryb „przygotuj, nie wysyłaj”)`)
  }
}

export class BaseCourierReadOnly {
  private readonly throttle: Throttle

  constructor(
    private readonly baseUrl: string,
    private readonly login: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 1_000,
    private readonly retry: RetryOptions = { attempts: 4, baseDelayMs: 5_000 },
  ) {
    if (!login || !apiKey) throw new Error('Brak loginu albo klucza API Base Courier')
    if (!BASE_COURIER_URL_RE.test(baseUrl)) throw new Error(BASE_COURIER_ZLY_ADRES)
    this.throttle = new Throttle(minIntervalMs)
  }

  /** Bez wartości sekretów, nawet gdy trafią do komunikatu biblioteki sieciowej. */
  private clean(message: string): string {
    return message.split(this.apiKey).join('***').split(this.login).join('***')
  }

  async post<T = unknown>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    assertBaseCourierReadOnly(endpoint)
    return withRetry(async () => {
      await this.throttle.wait()
      let res: Response
      try {
        res = await fetchWithTimeout(
          this.fetchImpl,
          `${this.baseUrl.replace(/\/$/, '')}/${endpoint}`,
          // `redirect: 'error'`: przekierowanie zaniosłoby treść z kluczem pod adres spoza listy
          { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...body, auth: { login: this.login, api_key: this.apiKey } }) },
          60_000,
        )
      } catch (e) {
        if (e instanceof SourceError) throw new SourceError(`Base Courier ${endpoint}: ${this.clean(e.message)}`, e.retryable)
        throw e
      }
      if (res.status === 429 || res.status >= 500) throw new SourceError(`Base Courier ${endpoint}: HTTP ${res.status}`, true)
      if (!res.ok) throw new SourceError(`Base Courier ${endpoint}: HTTP ${res.status}`, false)
      try {
        return JSON.parse(await res.text()) as T
      } catch {
        throw new SourceError(`Base Courier ${endpoint}: nieczytelna odpowiedź`, false)
      }
    }, this.retry)
  }
}
