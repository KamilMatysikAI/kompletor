// Adapter WooCommerce z zapisem `woo.rest.zapis.v1`. To samo co `woo.rest.v1` (odczyt
// zamówień, odbiorca, oferty — tym samym kluczem odczytu) plus, ZA WYŁĄCZNIKIEM `zapisWlaczony`:
//   - stany ofert: `POST /products/batch` i `POST /products/<id>/variations/batch`, paczki po 100 (wynik per pozycja);
//   - status zamówienia: odczyt, potem `PUT /orders/<id>` tylko przy zmianie; statusów końcowych (anulowane, zwrócone,
//     nieudane, kosz) nie nadpisujemy; anulowanie nieopłaconego sprawdza płatność na świeżym odczycie;
//   - numer nadania: notatka zamówienia (prywatna albo dla klienta) i/lub pole meta wtyczki śledzenia, bez dubli.
// Zapis idzie OSOBNYM kluczem WC z prawem zapisu (sekrety WOO_WRITE_KEY / WOO_WRITE_SECRET); bez nich albo bez
// `zapisWlaczony: true` żadna metoda zapisu nie wysyła żądania (także GET) i zwraca TRWALY z powodem.
// Odszukanie po referencji: porównanie stanu zamówienia w sklepie z tym, co zapis miał ustawić (status, notatka, meta).
// Dane klienta: zapis ich nie czyta ani nie wysyła; notatka zawiera tylko numer nadania i przewoźnika.
import { type FetchLike, ReadOnlyViolation } from '../zrodla/http'
import { WooWriteNetworkError, WooWriter } from '../zrodla/woo-zapis'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type FailedWriteItem,
  type FailureKind,
  type OrderStatusWriter,
  type ReferenceFinder,
  type ReferenceLookup,
  type StatusWriteGuard,
  type StockWriteItem,
  type StockWriter,
  type TrackingInfo,
  type TrackingWriter,
  type WriteOutcome,
  POLE_WYSTAWIANIA_OFERT,
  WYSTAWIANIE_WYLACZONE,
  wystawianieOfertWlaczone,
} from './kontrakt'
import { META_KEY_RE, STATUS as WOO_STATUS, str, toAdapterError, WOO_BEHAVIOR, WOO_MANIFEST, WooAdapter } from './woo'

export const WOO_ZAPIS_KEY = 'woo.rest.zapis.v1'

export const WOO_ZAPIS_MANIFEST: AdapterManifest = {
  ...WOO_MANIFEST,
  adapterKey: WOO_ZAPIS_KEY,
  displayName: 'WooCommerce (REST v3, z zapisem za wyłącznikiem)',
  capabilities: [...WOO_MANIFEST.capabilities, 'stock.write', 'order.status.write', 'order.tracking.write', 'reference.find', 'offers.publish'],
  // zapis produktu do sklepu z osobnym limitem (jeden naraz)
  rateLimit: { ...WOO_MANIFEST.rateLimit, perCapability: { 'offers.publish': { requestsPerMinute: 30, maxConcurrent: 1 } } },
  config: [
    ...WOO_MANIFEST.config,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik zapisu do sklepu (stany, statusy, numery nadania); domyślnie wyłączony' },
    { key: 'nadanieNotatka', type: 'boolean', required: false, description: 'numer nadania jako notatka zamówienia (domyślnie tak)' },
    { key: 'nadanieDlaKlienta', type: 'boolean', required: false, description: 'notatka z numerem nadania widoczna dla klienta (Woo wyśle mu wtedy e-mail); domyślnie prywatna' },
    { key: 'nadanieMetaKlucz', type: 'string', required: false, description: 'pole meta zamówienia wtyczki śledzenia przesyłek (np. _tracking_number); puste = bez pola', pattern: META_KEY_RE },
    POLE_WYSTAWIANIA_OFERT, // osobny wyłącznik zakładania produktów w sklepie
  ],
  secrets: [
    ...WOO_MANIFEST.secrets,
    { name: 'WOO_WRITE_KEY', required: false, description: 'klucz WC REST z prawem zapisu (osobny od klucza odczytu)', envSuffix: 'WRITE_KEY' },
    { name: 'WOO_WRITE_SECRET', required: false, description: 'sekret klucza WC REST z prawem zapisu', envSuffix: 'WRITE_SECRET' },
  ],
  readOnly: false,
  channelBehavior: WOO_BEHAVIOR,
}

const OFF = 'zapis wyłączony na tym koncie'
const NO_KEY = 'brak klucza zapisu Woo (WOO_WRITE_KEY i WOO_WRITE_SECRET)'
const BATCH = 100
/**
 * Statusy, z których nie przestawiamy zamówienia (klient albo sklep już je zamknął). Bez `failed`:
 * nieudana płatność to zamówienie otwarte i nieopłacone (ranga 10 jak `pending`), więc po wpłacie przelewem i wysyłce
 * idzie `completed`, a po terminie bez wpłaty `cancelled` (osłona `onlyIfUnpaid`); „Nowe” nie ma klucza w mapie statusów.
 */
const FINAL = new Set(['cancelled', 'refunded', 'trash'])
const STATUS_RE = /^[a-z0-9_-]{1,40}$/
const worse = (a: FailureKind, b: FailureKind): FailureKind => (a === 'TRWALY' || b === 'TRWALY' ? 'TRWALY' : a === 'NIEJEDNOZNACZNY' || b === 'NIEJEDNOZNACZNY' ? 'NIEJEDNOZNACZNY' : 'PRZEJSCIOWY')

type Expected = { orderId: string; status?: string; tracking?: string; metaKey?: string | null; note?: boolean }

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

function httpKind(status: number): FailureKind {
  return status === 429 ? 'PRZEJSCIOWY' : status >= 500 ? 'NIEJEDNOZNACZNY' : 'TRWALY'
}

/** Tekst notatki: tylko numer i przewoźnik (bez danych klienta); nieznany przewoźnik bez nawiasu. */
export function wooTrackingNote(t: TrackingInfo): string {
  return `Numer nadania: ${t.number}${t.carrier && t.carrier !== 'BRAK' ? ` (${t.carrier})` : ''}${t.url ? ` ${t.url}` : ''}`
}

export class WooZapisAdapter extends WooAdapter implements StockWriter, OrderStatusWriter, TrackingWriter, ReferenceFinder {
  private writerInstance: WooWriter | null = null
  /** Co zapis pod daną referencją miał ustawić (odszukanie po referencji w tym samym przebiegu hosta). */
  private readonly expected = new Map<string, Expected>()

  constructor(ctx: AdapterContext) {
    super(ctx, WOO_ZAPIS_MANIFEST)
  }

  /** Powód, dla którego zapis nie wyjdzie (null = może). Sprawdzany przed jakimkolwiek żądaniem. */
  private blocked(): string | null {
    if (this.ctx.config['zapisWlaczony'] !== true) return OFF
    if (!this.ctx.secrets['WOO_WRITE_KEY'] || !this.ctx.secrets['WOO_WRITE_SECRET']) return NO_KEY
    return null
  }

  /**
   * transport wystawiania (`POST /products/batch` z jednym `create`) dla lib/oferty/wystawianie.ts. Tylko przy
   * włączonym `wystawianieOfertWlaczone` (niezależnie od `zapisWlaczony`) i z kluczem zapisu. Brak odpowiedzi = wyjątek.
   */
  async zapisOfert(metoda: 'POST', sciezka: string, cialo: unknown, query?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null }> {
    if (!wystawianieOfertWlaczone(this.ctx.config)) throw new ReadOnlyViolation(WYSTAWIANIE_WYLACZONE)
    if (!this.ctx.secrets['WOO_WRITE_KEY'] || !this.ctx.secrets['WOO_WRITE_SECRET']) throw new ReadOnlyViolation(NO_KEY)
    const c = cialo && typeof cialo === 'object' ? (cialo as Record<string, unknown>) : null
    const tylkoCreate = !!c && Object.keys(c).length === 1 && Array.isArray(c['create']) && (c['create'] as unknown[]).length === 1
    if (metoda !== 'POST' || sciezka !== '/products/batch' || !tylkoCreate || (query && Object.keys(query).length)) throw new ReadOnlyViolation('Woo: wystawianie tylko jednym produktem w POST /products/batch')
    const r = await this.writer.send<Record<string, unknown>>('POST', sciezka, cialo)
    const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : null
    return { status: r.status, body }
  }

  private get writer(): WooWriter {
    this.writerInstance ??= new WooWriter(String(this.ctx.config['baseUrl']), this.ctx.secrets['WOO_WRITE_KEY']!, this.ctx.secrets['WOO_WRITE_SECRET']!, this.ctx.fetch as FetchLike, this.ctx.http?.minIntervalMs ?? 250)
    return this.writerInstance
  }

  // ─── Stany ─────────────────────────────────────────────────────────────────

  async pushStock(items: StockWriteItem[], reference: string): Promise<WriteOutcome> {
    const why = this.blocked()
    if (why) return { kind: 'TRWALY', reference, message: why }
    const failed: FailedWriteItem[] = []
    const groups = new Map<string, { id: number; stock_quantity: number; ext: string }[]>() // „” = produkty proste
    for (const it of items) {
      const m = /^(\d+)(?:\/(\d+))?$/.exec(it.offerExternalId)
      if (!m || !Number.isInteger(it.qty) || it.qty < 0) {
        failed.push({ offerExternalId: it.offerExternalId, kind: 'TRWALY', message: 'zły numer oferty albo ilość' })
        continue
      }
      const key = m[2] ? m[1]! : ''
      const g = groups.get(key) ?? []
      g.push({ id: Number(m[2] ?? m[1]), stock_quantity: it.qty, ext: it.offerExternalId })
      groups.set(key, g)
    }
    for (const [parent, rows] of groups) {
      const path = parent ? `/products/${parent}/variations/batch` : '/products/batch'
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH)
        failed.push(...(await this.pushChunk(path, chunk)))
      }
    }
    if (!failed.length) return { kind: 'OK', reference }
    const kind = failed.map((f) => f.kind).reduce(worse)
    const ids = failed.slice(0, 20).map((f) => f.offerExternalId).join(', ')
    return { kind, reference, message: `${failed.length} z ${items.length} pozycji nieudanych: ${ids}${failed.length > 20 ? ', …' : ''}`, failedItems: failed }
  }

  private async pushChunk(path: string, chunk: { id: number; stock_quantity: number; ext: string }[]): Promise<FailedWriteItem[]> {
    const all = (kind: FailureKind, message: string) => chunk.map((c) => ({ offerExternalId: c.ext, kind, message }))
    let res
    try {
      res = await this.writer.send<{ update?: unknown }>('POST', path, { update: chunk.map(({ id, stock_quantity }) => ({ id, stock_quantity })) })
    } catch (e) {
      // Stan ustawia się bezwzględnie (nie o deltę): po timeoucie powtórka tą samą ilością da ten sam wynik → PRZEJSCIOWY.
      if (e instanceof WooWriteNetworkError) return all('PRZEJSCIOWY', e.message)
      throw e
    }
    if (res.status === 429 || res.status >= 500) return all('PRZEJSCIOWY', `Woo ${path}: HTTP ${res.status}`)
    if (res.status === 401 || res.status === 403) return all('TRWALY', `Woo ${path}: HTTP ${res.status} (klucz zapisu odrzucony albo bez prawa zapisu)`)
    if (res.status < 200 || res.status >= 300) return all('TRWALY', `Woo ${path}: HTTP ${res.status}`)
    const upd = Array.isArray(asObj(res.body)?.['update']) ? (asObj(res.body)!['update'] as unknown[]) : null
    if (!upd) return all('PRZEJSCIOWY', `Woo ${path}: odpowiedź bez listy wyników`)
    const byId = new Map<number, Record<string, unknown>>()
    for (const r of upd) {
      const o = asObj(r)
      const id = Number(o?.['id'])
      if (o && Number.isInteger(id)) byId.set(id, o)
    }
    const out: FailedWriteItem[] = []
    for (const c of chunk) {
      const r = byId.get(c.id)
      const err = asObj(r?.['error'])
      // brak pozycji w wyniku: bezwzględny zapis wolno ponowić; błąd pozycji (np. nie ma produktu) — człowiek
      if (!r) out.push({ offerExternalId: c.ext, kind: 'PRZEJSCIOWY', message: 'brak pozycji w odpowiedzi sklepu' })
      else if (err) out.push({ offerExternalId: c.ext, kind: 'TRWALY', message: `sklep odrzucił: ${String(err['code'] ?? 'błąd').slice(0, 80)}` })
    }
    return out
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  private async readOrder(orderId: string): Promise<Record<string, unknown> | null> {
    let r
    try {
      r = await this.api.get<Record<string, unknown>>(`/orders/${orderId}`)
    } catch (e) {
      throw toAdapterError(e)
    }
    if (r.status === 404 || r.body === null) return null
    const o = asObj(r.body)
    if (!o) throw new AdapterError('Woo /orders/{id}: odpowiedź nie jest obiektem', 'PRZEJSCIOWY')
    return o
  }

  private failOf(e: unknown, reference: string): WriteOutcome {
    const ae = toAdapterError(e)
    return { kind: ae instanceof AdapterError ? ae.kind : 'PRZEJSCIOWY', reference, message: (ae instanceof Error ? ae.message : String(ae)).slice(0, 300) }
  }

  async setOrderStatus(orderExternalId: string, channelStatus: string, reference: string, guard: StatusWriteGuard = {}): Promise<WriteOutcome> {
    const why = this.blocked()
    if (why) return { kind: 'TRWALY', reference, message: why }
    if (!/^\d+$/.test(orderExternalId) || !STATUS_RE.test(channelStatus)) return { kind: 'TRWALY', reference, message: 'zły numer zamówienia albo statusu Woo' }
    let cur: Record<string, unknown> | null
    try {
      cur = await this.readOrder(orderExternalId)
    } catch (e) {
      return this.failOf(e, reference)
    }
    if (!cur) return { kind: 'TRWALY', reference, message: `brak zamówienia ${orderExternalId} w sklepie` }
    const now = str(cur['status'])
    if (now === channelStatus) return { kind: 'OK', reference, externalRef: `bez-zmian:${now}` }
    if (now && FINAL.has(now)) return { kind: 'OK', reference, externalRef: `bez-zmian:${now}` } // zamknięte w sklepie: nie nadpisujemy
    // nie cofamy statusu w sklepie (np. completed → processing); rdzeń wziąłby spadek rangi przy
    // odczycie za cofnięcie w kanale i przestawił zamówienie na „Do wyjaśnienia”
    const rankNow = now ? WOO_STATUS[now]?.rank : undefined
    const rankTarget = WOO_STATUS[channelStatus]?.rank
    if (rankNow != null && rankTarget != null && rankTarget < rankNow) return { kind: 'OK', reference, externalRef: `bez-zmian:${now}` }
    if (guard.onlyIfUnpaid && (str(cur['date_paid_gmt']) || now === 'processing' || now === 'completed'))
      return { kind: 'TRWALY', reference, message: `zamówienie ${orderExternalId} jest w sklepie opłacone — nie anuluję` }
    this.expected.set(reference, { orderId: orderExternalId, status: channelStatus })
    let res
    try {
      res = await this.writer.send('PUT', `/orders/${orderExternalId}`, { status: channelStatus })
    } catch (e) {
      if (e instanceof WooWriteNetworkError) return { kind: 'NIEJEDNOZNACZNY', reference, message: `zmiana statusu zamówienia ${orderExternalId}: brak odpowiedzi po wysłaniu` }
      throw e
    }
    if (res.status >= 200 && res.status < 300) return { kind: 'OK', reference }
    return { kind: httpKind(res.status), reference, message: `zmiana statusu zamówienia ${orderExternalId}: HTTP ${res.status}` }
  }

  // ─── Numer nadania ─────────────────────────────────────────────────────────

  private metaKey(): string | null {
    const v = this.ctx.config['nadanieMetaKlucz']
    return typeof v === 'string' && META_KEY_RE.test(v) ? v : null
  }

  private async hasNote(orderId: string, number: string): Promise<boolean> {
    let r
    try {
      r = await this.api.get<unknown[]>(`/orders/${orderId}/notes`, { type: 'any' })
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r.body)) return false
    // tylko nasza notatka („Numer nadania: <nr>”), nie dowolna notatka zawierająca ten ciąg
    return r.body.some((n) => {
      const note = String(asObj(n)?.['note'] ?? '')
      return note === `Numer nadania: ${number}` || note.startsWith(`Numer nadania: ${number} `)
    })
  }

  private static metaValue(order: Record<string, unknown>, key: string): string | null {
    const meta = Array.isArray(order['meta_data']) ? (order['meta_data'] as unknown[]) : []
    const hit = meta.map(asObj).find((m) => m?.['key'] === key)
    return hit ? str(hit['value']) : null
  }

  async setTracking(orderExternalId: string, t: TrackingInfo, reference: string): Promise<WriteOutcome> {
    const why = this.blocked()
    if (why) return { kind: 'TRWALY', reference, message: why }
    if (!/^\d+$/.test(orderExternalId) || !/^[A-Za-z0-9-]{4,64}$/.test(t.number)) return { kind: 'TRWALY', reference, message: 'zły numer zamówienia albo numer nadania' }
    const note = this.ctx.config['nadanieNotatka'] !== false
    const metaKey = this.metaKey()
    if (!note && !metaKey) return { kind: 'TRWALY', reference, message: 'konto nie ma miejsca na numer nadania (notatka wyłączona, brak pola meta)' }
    this.expected.set(reference, { orderId: orderExternalId, tracking: t.number, metaKey, note })
    try {
      const order = await this.readOrder(orderExternalId)
      if (!order) return { kind: 'TRWALY', reference, message: `brak zamówienia ${orderExternalId} w sklepie` }
      if (metaKey && WooZapisAdapter.metaValue(order, metaKey) !== t.number) {
        const r = await this.writer.send('PUT', `/orders/${orderExternalId}`, { meta_data: [{ key: metaKey, value: t.number }] })
        // PUT pola meta jest bezwzględny: 429 i 5xx wolno ponowić
        if (r.status < 200 || r.status >= 300) return { kind: r.status === 429 || r.status >= 500 ? 'PRZEJSCIOWY' : 'TRWALY', reference, message: `numer nadania w polu meta: HTTP ${r.status}` }
      }
      if (note && !(await this.hasNote(orderExternalId, t.number))) {
        const r = await this.writer.send('POST', `/orders/${orderExternalId}/notes`, { note: wooTrackingNote(t), customer_note: this.ctx.config['nadanieDlaKlienta'] === true })
        // dopisanie notatki nie jest idempotentne: 5xx = nie wiadomo, czy jest (rozstrzyga odszukanie)
        if (r.status < 200 || r.status >= 300) return { kind: httpKind(r.status), reference, message: `notatka z numerem nadania: HTTP ${r.status}` }
      }
    } catch (e) {
      if (e instanceof WooWriteNetworkError) return { kind: 'NIEJEDNOZNACZNY', reference, message: `numer nadania zamówienia ${orderExternalId}: brak odpowiedzi po wysłaniu` }
      return this.failOf(e, reference)
    }
    return { kind: 'OK', reference }
  }

  // ─── Odszukanie po referencji ──────────────────────────────────────────────

  // bez `blocked()` celowo — samo GET, a referencja trafia do `expected` wyłącznie po niezablokowanym zapisie.
  async findByReference(reference: string): Promise<ReferenceLookup> {
    const e = this.expected.get(reference)
    // stany ustawia się bezwzględnie (bez NIEJEDNOZNACZNEGO); nieznana referencja = nie umiemy rozstrzygnąć
    if (!e) throw new AdapterError('nieznana referencja zapisu Woo (inny przebieg)', 'NIEJEDNOZNACZNY')
    const order = await this.readOrder(e.orderId)
    if (!order) return { found: false }
    if (e.status) return str(order['status']) === e.status ? { found: true } : { found: false }
    if (e.tracking) {
      const metaOk = !e.metaKey || WooZapisAdapter.metaValue(order, e.metaKey) === e.tracking
      const noteOk = !e.note || (await this.hasNote(e.orderId, e.tracking))
      return metaOk && noteOk ? { found: true } : { found: false }
    }
    return { found: false }
  }
}

export const WOO_ZAPIS_DEFINITION: AdapterDefinition = { manifest: WOO_ZAPIS_MANIFEST, create: (ctx) => new WooZapisAdapter(ctx) }
