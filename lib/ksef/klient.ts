// KSeF API 2.x — klient TYLKO DO ODCZYTU. Tylko środowiska TEST i DEMO; host produkcyjny
// `api.ksef.mf.gov.pl` kończy się wyjątkiem w każdej ścieżce, także w odczycie. Dozwolone wyłącznie:
//   POST /auth/challenge                  (początek uwierzytelnienia; nic nie zapisuje, służy do testu połączenia)
//   GET  /security/public-key-certificates (klucze publiczne KSeF)
// Wszystko inne (`/sessions`, `/auth/ksef-token`, `/auth/xades-signature`, `/invoices`, `/tokens`…) to
// `ReadOnlyViolation` jeszcze przed wysyłką. Wysyłka faktur to osobne zadanie po decyzji właściciela
// (docs/integracje/ksef.md, „Plan wysyłki”). Token KSeF nie jest tu używany.
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from '../zrodla/http'

export const KSEF_SRODOWISKA = ['TEST', 'DEMO'] as const
export type SrodowiskoKsef = (typeof KSEF_SRODOWISKA)[number]

/** Bazy API (`/v2`, bez prefiksu `/api`). Produkcji celowo nie ma na tej liście. */
export const KSEF_BAZY: Readonly<Record<SrodowiskoKsef, string>> = {
  TEST: 'https://api-test.ksef.mf.gov.pl/v2',
  DEMO: 'https://api-demo.ksef.mf.gov.pl/v2',
}

export const KSEF_HOST_PRODUKCYJNY = 'api.ksef.mf.gov.pl'
const DOZWOLONE_HOSTY = new Set(Object.values(KSEF_BAZY).map((b) => new URL(b).host))
const DOZWOLONE = new Set(['POST /auth/challenge', 'GET /security/public-key-certificates'])

/** Strażnik: host TEST/DEMO, ścieżka pod `/v2`, para metoda + ścieżka z listy odczytów. Inaczej `ReadOnlyViolation`. */
export function assertKsefReadOnly(method: string, url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ReadOnlyViolation('KSeF: zły adres')
  }
  if (u.host === KSEF_HOST_PRODUKCYJNY || u.hostname === KSEF_HOST_PRODUKCYJNY)
    throw new ReadOnlyViolation('KSeF: środowisko produkcyjne jest zablokowane (tylko TEST i DEMO, tryb „przygotuj, nie wysyłaj”)')
  if (u.protocol !== 'https:' || !DOZWOLONE_HOSTY.has(u.host)) throw new ReadOnlyViolation(`KSeF: host „${u.host}” spoza środowisk TEST i DEMO`)
  if (u.username || u.password || u.search || u.hash) throw new ReadOnlyViolation('KSeF: adres z dodatkami (dane logowania, zapytanie, kotwica)')
  const sciezka = u.pathname.startsWith('/v2/') ? u.pathname.slice(3) : null
  const para = `${method.toUpperCase()} ${sciezka}`
  if (!sciezka || !DOZWOLONE.has(para)) throw new ReadOnlyViolation(`KSeF: „${method.toUpperCase()} ${u.pathname}” nie jest dozwolonym odczytem (tryb „przygotuj, nie wysyłaj”)`)
}

export interface Challenge {
  challenge: string
  timestamp: string | null
}

export class KsefReadOnly {
  private readonly baza: string
  private readonly throttle: Throttle

  constructor(
    srodowisko: string,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 1_000,
    private readonly retry: RetryOptions = { attempts: 3, baseDelayMs: 2_000 },
  ) {
    if (!(KSEF_SRODOWISKA as readonly string[]).includes(srodowisko)) throw new ReadOnlyViolation(`KSeF: środowisko „${srodowisko}” niedozwolone (tylko TEST i DEMO)`)
    this.baza = KSEF_BAZY[srodowisko as SrodowiskoKsef]
    this.throttle = new Throttle(minIntervalMs)
  }

  private async zadanie<T>(method: 'GET' | 'POST', sciezka: string, body?: unknown): Promise<T> {
    const url = `${this.baza}${sciezka}`
    assertKsefReadOnly(method, url)
    return withRetry(async () => {
      await this.throttle.wait()
      const res = await fetchWithTimeout(
        this.fetchImpl,
        url,
        // `redirect: 'error'`: przekierowanie mogłoby wyprowadzić żądanie poza TEST/DEMO
        { method, redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        30_000,
      )
      if (res.status === 429 || res.status >= 500) throw new SourceError(`KSeF ${sciezka}: HTTP ${res.status}`, true)
      if (!res.ok) throw new SourceError(`KSeF ${sciezka}: HTTP ${res.status}`, false)
      try {
        return JSON.parse(await res.text()) as T
      } catch {
        throw new SourceError(`KSeF ${sciezka}: nieczytelna odpowiedź`, false)
      }
    }, this.retry)
  }

  /**
   * `POST /auth/challenge`: wyzwanie ważne 10 minut. Nic nie tworzy po stronie KSeF poza wyzwaniem; tu tylko test
   * połączenia. [NIEPEWNE: czy API 2.9.0 wymaga treści żądania (kontekst NIP); bez niej spodziewamy się 200 albo 400.]
   */
  async challenge(): Promise<Challenge> {
    const r = await this.zadanie<Record<string, unknown>>('POST', '/auth/challenge')
    if (typeof r?.['challenge'] !== 'string' || !r['challenge']) throw new SourceError('KSeF /auth/challenge: odpowiedź bez wyzwania', false)
    return { challenge: r['challenge'], timestamp: typeof r['timestamp'] === 'string' ? r['timestamp'] : null }
  }

  async publicKeyCertificates(): Promise<unknown[]> {
    const r = await this.zadanie<unknown>('GET', '/security/public-key-certificates')
    if (!Array.isArray(r)) throw new SourceError('KSeF /security/public-key-certificates: odpowiedź nie jest listą', false)
    return r
  }
}
