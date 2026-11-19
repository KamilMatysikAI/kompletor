// InPost ShipX — klient ZAPISU, za wyłącznikiem. Każde utworzenie przesyłki kosztuje pieniądze, więc ten
// plik jest osobno od klienta odczytu, a konstruktor wymaga jawnego `wylacznik: true`. Tworzy go wyłącznie adapter
// `inpost.shipx.zapis.v1`, i tylko przy `zapisWlaczony: true` w konfiguracji firmy; dziś żaden host go nie woła.
// Dozwolone są trzy operacje: utworzenie przesyłki, odszukanie po referencji i etykieta. Zlecenie odbioru, anulowanie,
// webhooki i reszta API kończą się wyjątkiem przed wysyłką. Bez ponawiania: niejednoznaczny wynik rozstrzyga
// `findByReference` (lib/adaptery/zapis.ts). Treść żądań i odpowiedzi (dane odbiorcy) nie trafia do komunikatów.
import { AdapterError, type LabelFormat, type ReferenceLookup, type WriteOutcome } from '../adaptery/kontrakt'
import { fetchWithTimeout, ReadOnlyViolation, SourceError, type FetchLike } from './http'
import { cleanToken, INPOST_ID_RE, inpostBase } from './inpost'

const SEG = '[A-Za-z0-9_-]{1,64}'
const ZAPIS: { method: string; re: RegExp }[] = [
  { method: 'POST', re: new RegExp(`^/v1/organizations/${SEG}/shipments$`) },
  { method: 'GET', re: new RegExp(`^/v1/organizations/${SEG}/shipments$`) },
  { method: 'GET', re: new RegExp(`^/v1/shipments/${SEG}/label$`) },
  // odczyt jednej przesyłki (numer nadania przychodzi po utworzeniu, asynchronicznie)
  { method: 'GET', re: new RegExp(`^/v1/shipments/${SEG}$`) },
]

export function assertInpostZapis(method: string, path: string): void {
  const p = path.split('?')[0] ?? ''
  if (!ZAPIS.some((z) => z.method === method.toUpperCase() && z.re.test(p))) throw new ReadOnlyViolation(`InPost ShipX (zapis): ${method.toUpperCase()} „${p}” poza listą operacji zapisu`)
}

/** Wartości `format` etykiety [NIEPEWNE: wielkość liter]. */
const FORMAT: Record<LabelFormat, { query: string; contentType: string }> = {
  PDF: { query: 'Pdf', contentType: 'application/pdf' },
  ZPL: { query: 'Zpl', contentType: 'text/plain' },
  EPL: { query: 'Epl', contentType: 'text/plain' },
}

export interface InpostZapisOptions {
  baseUrl: string
  token: string
  organizationId: string
  /** Jawna zgoda w kodzie wywołującym: bez `true` klient nie powstaje. */
  wylacznik: true
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** `type` etykiety, np. normal albo A6 [NIEPEWNE]; brak = domyślny API. */
  labelType?: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const POLE_RE = /^[a-z_.]{1,40}$/
/**
 * Kod błędu z odpowiedzi ShipX (np. validation_failed) i NAZWY pól z `details`, żeby człowiek po TRWALYM
 * wiedział, co poprawić. Nigdy treść ani wartości (mogą mieć dane odbiorcy): tylko identyfikatory pasujące do wzorca,
 * najwyżej 10 nazw pól.
 */
const kodBledu = (v: unknown): string => {
  if (!isRecord(v) || typeof v['error'] !== 'string' || !/^[a-z_]{1,60}$/.test(v['error'])) return ''
  const d = v['details']
  const pola = isRecord(d) ? Object.keys(d).filter((k) => POLE_RE.test(k)).slice(0, 10) : []
  return ` (${v['error']}${pola.length ? `: ${pola.join(', ')}` : ''})`
}

export class InpostZapis {
  private readonly base: string
  private readonly token: string
  private readonly organizationId: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly labelType: string | null

  constructor(o: InpostZapisOptions) {
    if ((o as { wylacznik?: unknown }).wylacznik !== true) throw new Error('Klient zapisu InPost ShipX wymaga jawnego wyłącznika (wylacznik: true)')
    this.base = inpostBase(o.baseUrl, o.token)
    if (!INPOST_ID_RE.test(o.organizationId)) throw new Error('Zły identyfikator organizacji InPost ShipX')
    this.token = o.token
    this.organizationId = o.organizationId
    this.fetchImpl = o.fetchImpl ?? fetch
    this.timeoutMs = o.timeoutMs ?? 60_000
    this.labelType = o.labelType ?? null
  }

  private async send(method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: Record<string, unknown>): Promise<Response> {
    assertInpostZapis(method, path)
    const qs = new URLSearchParams(query).toString()
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: method === 'GET' && path.endsWith('/label') ? '*/*' : 'application/json' }
    if (body) headers['Content-Type'] = 'application/json'
    try {
      return await fetchWithTimeout(this.fetchImpl, `${this.base}${path}${qs ? `?${qs}` : ''}`, { method, redirect: 'error', headers, ...(body ? { body: JSON.stringify(body) } : {}) }, this.timeoutMs)
    } catch (e) {
      throw new SourceError(`InPost ShipX ${path}: ${cleanToken(e instanceof Error ? e.message : String(e), this.token)}`, true)
    }
  }

  /**
   * Utworzenie przesyłki z `reference` = klucz idempotencji hosta. Przesyłka powstaje asynchronicznie (status
   * `created`, numer później): OK niesie id przesyłki ShipX. 5xx, timeout albo błąd sieci po wysłaniu = NIEJEDNOZNACZNY;
   * sukces z pustą albo nieczytelną treścią (sandbox) też, bo przesyłka mogła powstać — rozstrzyga odszukanie.
   */
  async createShipment(payload: Record<string, unknown>, reference: string): Promise<WriteOutcome> {
    const path = `/v1/organizations/${this.organizationId}/shipments`
    let res: Response
    try {
      res = await this.send('POST', path, {}, { ...payload, reference })
    } catch (e) {
      if (e instanceof ReadOnlyViolation) throw e
      return { kind: 'NIEJEDNOZNACZNY', reference, message: e instanceof Error ? e.message : String(e) }
    }
    const text = await res.text().catch(() => '')
    let json: unknown = null
    try {
      json = text.trim() ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (res.status >= 500) return { kind: 'NIEJEDNOZNACZNY', reference, message: `InPost ShipX ${path}: HTTP ${res.status}` }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      return { kind: 'PRZEJSCIOWY', reference, message: `InPost ShipX ${path}: HTTP 429`, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}) }
    }
    if (!res.ok) return { kind: 'TRWALY', reference, message: `InPost ShipX ${path}: HTTP ${res.status}${kodBledu(json)}` }
    const id = isRecord(json) ? json['id'] : undefined
    if ((typeof id === 'number' && Number.isInteger(id)) || (typeof id === 'string' && INPOST_ID_RE.test(id))) return { kind: 'OK', reference, externalRef: String(id) }
    return { kind: 'NIEJEDNOZNACZNY', reference, message: `InPost ShipX ${path}: HTTP ${res.status}, pusta albo nieczytelna odpowiedź` }
  }

  /**
   * Przesyłka z tą referencją [NIEPEWNE: filtr `reference` listy przesyłek]. Gdy lista zawiera przesyłkę z inną
   * referencją, filtr nie zadziałał i „nie znaleziono” byłoby zgadywaniem (ponowienie = druga płatna przesyłka): błąd.
   *
   * Pusta lista też NIE jest dowodem braku: ShipX nie wymusza unikalności `reference`, a przesyłkę
   * tworzy asynchronicznie, więc lista może jeszcze nie widzieć świeżej. `{found:false}` zamieniłoby NIEJEDNOZNACZNY
   * w PRZEJSCIOWY i host ponowiłby POST = druga płatna przesyłka. Dlatego pusta lista = błąd TRWALY, wynik zapisu
   * zostaje NIEJEDNOZNACZNY i rozstrzyga człowiek (bez automatycznego ponowienia). Zmiana tylko po potwierdzeniu na
   * sandboxie, że lista widzi przesyłkę natychmiast po POST (docs/integracje/inpost.md, lista przed włączeniem zapisu).
   */
  async findByReference(reference: string): Promise<ReferenceLookup> {
    const path = `/v1/organizations/${this.organizationId}/shipments`
    let res: Response
    try {
      res = await this.send('GET', path, { reference })
    } catch (e) {
      if (e instanceof SourceError) throw new AdapterError(e.message, 'PRZEJSCIOWY')
      throw e
    }
    if (res.status === 429 || res.status >= 500) throw new AdapterError(`InPost ShipX ${path}: HTTP ${res.status}`, 'PRZEJSCIOWY')
    if (!res.ok) throw new AdapterError(`InPost ShipX ${path}: HTTP ${res.status}`, 'TRWALY')
    let json: unknown
    try {
      json = JSON.parse(await res.text())
    } catch {
      throw new AdapterError(`InPost ShipX ${path}: nieczytelna odpowiedź listy przesyłek`, 'TRWALY')
    }
    const items = isRecord(json) ? json['items'] : undefined
    if (!Array.isArray(items) || !items.every(isRecord)) throw new AdapterError(`InPost ShipX ${path}: nieczytelna odpowiedź listy przesyłek`, 'TRWALY')
    if (items.some((i) => i['reference'] !== reference)) throw new AdapterError(`InPost ShipX ${path}: filtr po referencji nie zadziałał, wynik nierozstrzygnięty`, 'TRWALY')
    if (items.length === 0) throw new AdapterError(`InPost ShipX ${path}: brak przesyłki na liście nie wyklucza jej utworzenia (tworzenie asynchroniczne), rozstrzyga człowiek`, 'TRWALY')
    if (items.length > 1) throw new AdapterError(`InPost ShipX ${path}: kilka przesyłek z tą samą referencją, potrzebny człowiek`, 'TRWALY')
    const id = items[0]!['id']
    return typeof id === 'number' || typeof id === 'string' ? { found: true, externalRef: String(id) } : { found: true }
  }

  /**
   * numer nadania przesyłki (`tracking_number`); null = ShipX jeszcze go nie nadał (przesyłka w stanie
   * `created`). Błąd sieci, 429 i 5xx = PRZEJSCIOWY, odmowa = TRWALY. Treść odpowiedzi (dane odbiorcy) nie trafia do błędów.
   */
  async getTrackingNumber(shipmentId: string): Promise<string | null> {
    return (await this.getShipment(shipmentId)).trackingNumber
  }

  /**
   * jedna przesyłka: referencja (klucz idempotencji hosta, null = API jej nie zwróciło) i numer nadania
   * (null = jeszcze nienadany). W tym samym odczycie status przesyłki (`status`, np.
   * `confirmed`, `taken_by_courier`; null = brak albo nieczytelny), jeden GET dla potwierdzenia i śledzenia.
   * 404 i inne odmowy = TRWALY, sieć, 429 i 5xx = PRZEJSCIOWY. Bez treści odpowiedzi w błędach.
   */
  async getShipment(shipmentId: string): Promise<{ reference: string | null; trackingNumber: string | null; status: string | null }> {
    if (!INPOST_ID_RE.test(shipmentId)) throw new AdapterError('Zły identyfikator przesyłki InPost ShipX', 'TRWALY')
    const path = `/v1/shipments/${shipmentId}`
    let res: Response
    try {
      res = await this.send('GET', path, {})
    } catch (e) {
      if (e instanceof SourceError) throw new AdapterError(e.message, 'PRZEJSCIOWY')
      throw e
    }
    if (res.status === 429 || res.status >= 500) throw new AdapterError(`InPost ShipX ${path}: HTTP ${res.status}`, 'PRZEJSCIOWY')
    if (!res.ok) throw new AdapterError(`InPost ShipX ${path}: HTTP ${res.status}`, 'TRWALY')
    let json: unknown
    try {
      json = JSON.parse(await res.text())
    } catch {
      throw new AdapterError(`InPost ShipX ${path}: nieczytelna odpowiedź przesyłki`, 'TRWALY')
    }
    const r = isRecord(json) ? json['reference'] : undefined
    const reference = typeof r === 'string' && r.trim() ? r.trim() : null
    const st = isRecord(json) ? json['status'] : undefined
    const status = typeof st === 'string' && /^[a-z_]{1,60}$/.test(st) ? st : null
    const t = isRecord(json) ? json['tracking_number'] : undefined
    if (t === null || t === undefined || t === '') return { reference, trackingNumber: null, status }
    if (typeof t !== 'string' || !/^[0-9A-Za-z]{6,40}$/.test(t)) throw new AdapterError(`InPost ShipX ${path}: nieczytelny numer nadania`, 'TRWALY')
    return { reference, trackingNumber: t, status }
  }

  /** Etykieta jako base64. Pusta treść albo zły rodzaj odpowiedzi = błąd. */
  async getLabel(shipmentId: string, format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!INPOST_ID_RE.test(shipmentId)) throw new AdapterError('Zły identyfikator przesyłki InPost ShipX', 'TRWALY')
    const f = FORMAT[format]
    if (!f) throw new AdapterError(`Nieznany format etykiety ${String(format)}`, 'TRWALY')
    const path = `/v1/shipments/${shipmentId}/label`
    let res: Response
    try {
      res = await this.send('GET', path, { format: f.query, ...(this.labelType ? { type: this.labelType } : {}) })
    } catch (e) {
      if (e instanceof SourceError) throw new AdapterError(e.message, 'PRZEJSCIOWY')
      throw e
    }
    if (res.status === 429 || res.status >= 500) throw new AdapterError(`InPost ShipX ${path}: HTTP ${res.status}`, 'PRZEJSCIOWY')
    if (!res.ok) throw new AdapterError(`InPost ShipX ${path}: HTTP ${res.status}`, 'TRWALY')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) throw new AdapterError(`InPost ShipX ${path}: pusta etykieta`, 'TRWALY')
    const contentType = (res.headers.get('content-type') ?? f.contentType).split(';')[0]!.trim()
    if (contentType === 'application/json') throw new AdapterError(`InPost ShipX ${path}: zamiast etykiety odpowiedź JSON`, 'TRWALY')
    return { contentType, base64: buf.toString('base64') }
  }
}
