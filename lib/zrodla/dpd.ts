// DPD Polska bezpośrednio — klient DPDServices REST TYLKO DO ODCZYTU. Specyfikacja: OpenAPI 3.0.1, wersja
// 5.27.0 (https://dpdservices.dpd.com.pl/api-docs, sprawdzone 02.11.2026). Basic Auth + nagłówek `x-dpd-fid` (numer
// płatnika; [NIEPEWNE]: nazwa nagłówka jest w opisie API, a schematy nie mają go wśród parametrów). Wszystko idzie
// POST-em, więc metoda HTTP niczego tu nie mówi: o odczycie decyduje lista ścieżek. Numery paczek (`generate*`),
// etykiety, protokoły, dopisywanie paczek i zamawianie kuriera kończą się wyjątkiem jeszcze przed wysyłką. Zapis ma
// osobny klient (lib/zrodla/dpd-zapis.ts) za wyłącznikiem. Login i hasło nie trafiają do komunikatów błędów.
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'

/** Tylko produkcja i demo DPD: nagłówek Basic Auth nie może pójść pod inny adres. */
export const DPD_URL_RE = /^https:\/\/dpdservices(demo)?\.dpd\.com\.pl\/?$/

// `courierOrderAvailability` to POST bez skutku (sprawdza dostępność odbioru) [NIEPEWNE: do potwierdzenia na demo].
const READ_ONLY_PATHS = new Set(['/public/routing/v1/postalCode', '/public/courierorder/v1/courierOrderAvailability'])

export function assertDpdReadOnly(path: string): void {
  if (!READ_ONLY_PATHS.has(path)) {
    throw new ReadOnlyViolation(`DPD: ścieżka „${path}” nie jest odczytem (tryb „przygotuj, nie wysyłaj”)`)
  }
}

/** Dane logowania DPDServices: login API (inny niż do aplikacji kurierskiej), hasło i FID w nagłówku. */
export interface DpdLogowanie {
  login: string
  password: string
  /** Numer klienta (FID) do nagłówka `x-dpd-fid`. */
  fid: string
}

/** Błąd HTTP DPD ze statusem (bez treści odpowiedzi: może zawierać dane z żądania). */
export class DpdHttpError extends SourceError {
  constructor(
    message: string,
    retryable: boolean,
    readonly status: number | null,
  ) {
    super(message, retryable)
    this.name = 'DpdHttpError'
  }
}

/** Wspólne dla odczytu i zapisu: adres, nagłówki i czyszczenie sekretów z komunikatów. */
export class DpdPolaczenie {
  constructor(
    readonly baseUrl: string,
    private readonly auth: DpdLogowanie,
    readonly fetchImpl: FetchLike,
  ) {
    if (!auth.login || !auth.password) throw new Error('Brak loginu albo hasła API DPD')
    if (!/^\d{1,10}$/.test(auth.fid)) throw new Error('Zły numer FID DPD (same cyfry)')
    if (!DPD_URL_RE.test(baseUrl)) throw new Error('Zły adres API DPD (tylko dpdservices.dpd.com.pl albo dpdservicesdemo.dpd.com.pl)')
  }

  private get basic(): string {
    return Buffer.from(`${this.auth.login}:${this.auth.password}`).toString('base64')
  }

  /** Bez wartości sekretów, nawet gdy trafią do komunikatu biblioteki sieciowej. */
  clean(message: string): string {
    return [this.basic, this.auth.password, this.auth.login].reduce((m, s) => m.split(s).join('***'), message)
  }

  url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  /** `redirect: 'error'`: przekierowanie zaniosłoby nagłówek z hasłem pod adres spoza listy. */
  init(body: unknown): RequestInit {
    return {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${this.basic}`, 'x-dpd-fid': this.auth.fid },
      body: JSON.stringify(body),
    }
  }
}

export class DpdReadOnly {
  private readonly throttle: Throttle
  private readonly conn: DpdPolaczenie

  constructor(
    baseUrl: string,
    auth: DpdLogowanie,
    fetchImpl: FetchLike = fetch,
    minIntervalMs = 1_000,
    private readonly retry: RetryOptions = { attempts: 4, baseDelayMs: 5_000 },
  ) {
    this.conn = new DpdPolaczenie(baseUrl, auth, fetchImpl)
    this.throttle = new Throttle(minIntervalMs)
  }

  /** Odpowiedź JSON; pusta treść = `null` (parser wołającego decyduje, czy to błąd). */
  async post<T = unknown>(path: string, body: unknown = {}): Promise<T | null> {
    assertDpdReadOnly(path)
    return withRetry(async () => {
      await this.throttle.wait()
      let res: Response
      try {
        res = await fetchWithTimeout(this.conn.fetchImpl, this.conn.url(path), this.conn.init(body), 60_000)
      } catch (e) {
        if (e instanceof SourceError) throw new DpdHttpError(`DPD ${path}: ${this.conn.clean(e.message)}`, e.retryable, null)
        throw e
      }
      if (res.status === 429 || res.status >= 500) throw new DpdHttpError(`DPD ${path}: HTTP ${res.status}`, true, res.status)
      if (!res.ok) throw new DpdHttpError(`DPD ${path}: HTTP ${res.status}`, false, res.status)
      const text = await res.text()
      if (!text.trim()) return null
      try {
        return JSON.parse(text) as T
      } catch {
        throw new DpdHttpError(`DPD ${path}: nieczytelna odpowiedź`, false, res.status)
      }
    }, this.retry)
  }
}
