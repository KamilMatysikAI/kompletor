// Allegro REST: klient ZAPISU. Zamknięta lista metod i ścieżek; wszystko inne kończy się
// wyjątkiem przed wysłaniem. Odczyty zostają w `AllegroReadOnly` (lib/zrodla/allegro.ts) — tu są tylko GET-y stanu
// komend, które istnieją wyłącznie dla zapisu (wynik komendy stanów i przesyłek), żeby strażnik odczytu
// `allegro.wysylam.v1` dalej odrzucał ścieżki komend.
//
// Ścieżki:
//   PUT  /sale/offer-quantity-change-commands/{uuid}          stany ofert (komenda z deterministycznym commandId)
//   GET  /sale/offer-quantity-change-commands/{uuid}[/tasks]  wynik komendy stanów
//   PUT  /sale/offer-publication-commands/{uuid}              zakończenie (END) i wznowienie (ACTIVATE) ofert
//   GET  /sale/offer-publication-commands/{uuid}[/tasks]      wynik komendy publikacji
//   PUT  /order/checkout-forms/{uuid}/fulfillment             status realizacji
//   POST /order/checkout-forms/{uuid}/shipments               numer nadania w zamówieniu
//   POST /shipment-management/shipments/create-commands       Wysyłam z Allegro: utworzenie przesyłki
//   GET  /shipment-management/shipments/create-commands/{uuid}
//   POST /shipment-management/shipments/cancel-commands       Wysyłam z Allegro: anulowanie przesyłki
//   GET  /shipment-management/shipments/cancel-commands/{uuid}
//   POST /shipment-management/label                           etykieta (plik binarny)
//   POST /shipment-management/pickup-proposals                Wysyłam z Allegro: propozycje terminów odbioru przez kuriera
//   POST /shipment-management/pickups/create-commands         Wysyłam z Allegro: zamówienie odbioru przez kuriera
//   GET  /shipment-management/pickups/create-commands/{uuid}
//   POST /sale/product-offers                                 wystawienie oferty (za `wystawianieOfertWlaczone`)
//
// Zapis NIGDY nie jest ponawiany w tym kliencie: brak odpowiedzi (sieć, timeout) = SourceError, a o powtórce decyduje
// adapter (komendy z tym samym commandId są bezpieczne, reszta po świeżym odczycie). Bez logowania treści żądań
// i odpowiedzi (komenda przesyłki niesie adres odbiorcy); w błędach tylko ścieżka bez identyfikatorów i status.
import { ALLEGRO_ACCEPT, ALLEGRO_API_URL_RE, retryAfterMsOf } from './allegro'
import { fetchWithTimeout, type FetchLike, ReadOnlyViolation, SourceError, Throttle } from './http'

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
/** Id formularza zamówienia: w Allegro UUID; dopuszczamy bezpieczny znakowo identyfikator (atrapy, sandbox). */
const FORM = '[A-Za-z0-9-]{1,64}'

type Method = 'GET' | 'PUT' | 'POST'

const WRITE_PATHS: readonly { method: Method; re: RegExp }[] = [
  { method: 'PUT', re: new RegExp(`^/sale/offer-quantity-change-commands/${UUID}$`) },
  { method: 'GET', re: new RegExp(`^/sale/offer-quantity-change-commands/${UUID}(/tasks)?$`) },
  // zakończenie oferty przy stanie 0 i wznowienie oferty zakończonej przez Kompletor (END / ACTIVATE)
  { method: 'PUT', re: new RegExp(`^/sale/offer-publication-commands/${UUID}$`) },
  { method: 'GET', re: new RegExp(`^/sale/offer-publication-commands/${UUID}(/tasks)?$`) },
  { method: 'PUT', re: new RegExp(`^/order/checkout-forms/${FORM}/fulfillment$`) },
  { method: 'POST', re: new RegExp(`^/order/checkout-forms/${FORM}/shipments$`) },
  { method: 'POST', re: /^\/shipment-management\/shipments\/(create|cancel)-commands$/ },
  { method: 'GET', re: new RegExp(`^/shipment-management/shipments/(create|cancel)-commands/${UUID}$`) },
  { method: 'POST', re: /^\/shipment-management\/label$/ },
  // zamawianie kuriera (osobny wyłącznik konta „Zamawianie kuriera z Kompletora”); propozycje to POST, ale niczego nie zamawiają
  { method: 'POST', re: /^\/shipment-management\/pickup-proposals$/ },
  { method: 'POST', re: /^\/shipment-management\/pickups\/create-commands$/ },
  { method: 'GET', re: new RegExp(`^/shipment-management/pickups/create-commands/${UUID}$`) },
  // wystawienie oferty (osobny wyłącznik konta `wystawianieOfertWlaczone`, lib/oferty/wystawianie.ts)
  { method: 'POST', re: /^\/sale\/product-offers$/ },
]

/** Ścieżka do komunikatu: identyfikatory zamienione na {id}. */
export const sciezkaBezId = (path: string) => path.replace(new RegExp(UUID, 'g'), '{id}')

export function assertAllegroWritePath(method: string, path: string): void {
  if (typeof path !== 'string' || path.includes('..') || path.includes('#') || path.includes('?') || !WRITE_PATHS.some((p) => p.method === method && p.re.test(path)))
    throw new ReadOnlyViolation(`Allegro: zapis poza dozwolonymi ścieżkami (${String(method)} ${sciezkaBezId(String(path)).slice(0, 80)})`)
}

export interface AllegroWriteResult {
  status: number
  /** JSON odpowiedzi (obiekt), także dla błędów 4xx (kody błędów Allegro); null = brak albo nie JSON. */
  body: Record<string, unknown> | null
  /** JSON odpowiedzi, gdy jest tablicą (propozycje terminów odbioru); null = brak, obiekt albo nie JSON. */
  lista?: unknown[] | null
  /** Plik (etykieta), gdy żądanie prosiło o odpowiedź binarną i status 2xx. */
  bytes: Buffer | null
  contentType: string | null
  retryAfterMs: number | null
}

/** Kody błędów Allegro z odpowiedzi (`errors[].code`), bez treści komunikatów (mogą powtarzać dane z żądania). */
export function kodyBledowAllegro(body: Record<string, unknown> | null): string[] {
  const e = body?.['errors']
  if (!Array.isArray(e)) return []
  return e
    .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>)['code'] : null))
    .filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(c))
    .slice(0, 10)
}

/** Limit czasu jednego żądania (bez `timeoutMs` w opcjach); odczyty stanu komend przesyłek mają krótszy. */
export const WRITE_TIMEOUT_MS = 60_000

export class AllegroWriter {
  private readonly base: string

  constructor(
    apiUrl: string,
    private readonly userAgent: string,
    private readonly fetchImpl: FetchLike,
    private readonly throttle: Throttle = new Throttle(100),
  ) {
    if (!ALLEGRO_API_URL_RE.test(apiUrl)) throw new Error('Adres API Allegro spoza listy (api.allegro.pl albo sandbox)')
    this.base = apiUrl.replace(/\/+$/, '')
  }

  /**
   * Jedno żądanie, bez ponowień. Sieć/timeout = SourceError (retryable: dla GET bezpieczny, dla zapisu decyduje adapter).
   * `binary` = oczekiwana odpowiedź w pliku (etykieta): Accept `application/octet-stream`.
   */
  async send(method: Method, path: string, body: unknown, accessToken: string, o: { binary?: boolean; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<AllegroWriteResult> {
    assertAllegroWritePath(method, path)
    await this.throttle.wait()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: o.binary ? 'application/octet-stream' : ALLEGRO_ACCEPT,
      'User-Agent': this.userAgent,
    }
    if (method !== 'GET') headers['Content-Type'] = ALLEGRO_ACCEPT
    const qs = o.query ? new URLSearchParams(o.query) : null
    let res: Response
    try {
      res = await fetchWithTimeout(
        this.fetchImpl,
        `${this.base}${path}${qs && qs.size ? `?${qs}` : ''}`,
        { method, headers, ...(method !== 'GET' && body !== undefined ? { body: JSON.stringify(body) } : {}) },
        o.timeoutMs ?? WRITE_TIMEOUT_MS,
      )
    } catch {
      throw new SourceError(`Allegro ${method} ${sciezkaBezId(path)}: brak odpowiedzi`, true)
    }
    const contentType = res.headers.get('content-type')
    const retryAfterMs = res.status === 429 ? retryAfterMsOf(res.headers.get('retry-after')) : null
    if (o.binary && res.ok) {
      let bytes: Buffer
      try {
        bytes = Buffer.from(await res.arrayBuffer())
      } catch {
        throw new SourceError(`Allegro ${method} ${sciezkaBezId(path)}: przerwany plik`, true)
      }
      return { status: res.status, body: null, bytes, contentType, retryAfterMs }
    }
    let text = ''
    try {
      text = await res.text()
    } catch {
      // bez treści
    }
    let json: Record<string, unknown> | null = null
    let lista: unknown[] | null = null
    if (text) {
      try {
        const v = JSON.parse(text) as unknown
        json = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
        lista = Array.isArray(v) ? v : null
      } catch {
        json = null
      }
    }
    return { status: res.status, body: json, lista, bytes: null, contentType, retryAfterMs }
  }
}
