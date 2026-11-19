// Adapter PrestaShop Webservice, dwa klucze:
//   prestashop.ws.v1        — domyślny, tylko GET: dziennik zamówień (filtr date_upd), oferty i stany, test połączenia;
//   prestashop.ws.zapis.v1  — to samo plus zapis stanu (stock_availables) i statusu (order_histories) ZA WYŁĄCZNIKIEM.
// Zapis wymaga trzech niezależnych warunków: konto ma klucz `prestashop.ws.zapis.v1`, ma `zapisWlaczony: true`
// i host wywoła zapis (dziś nie woła: lib/worker/zadania.ts, runStockPush bez StockWriter). Bez `zapisWlaczony`
// pushStock i setOrderStatus zwracają TRWALY i nie wysyłają żadnego żądania.
// Stan: kod sprawdzony na atrapie HTTP (tests/prestashop-atrapa.ts), nie na prawdziwym sklepie — pola [NIEPEWNE]
// w lib/zrodla/prestashop.ts, lista do potwierdzenia w docs/integracje/prestashop.md.
// Dane klienta (id_customer, id_address_*, note, gift_message, secure_key, zasoby customers i addresses) nie są
// czytane ani zwracane.
import type { PaymentState } from '@prisma/client'
import { localToUtc } from '../zrodla/czas-lokalny'
import { SourceError, type FetchLike } from '../zrodla/http'
import {
  PRESTA_DEFAULT_CANCELLED,
  PRESTA_PUT_POMIJANE,
  PrestaError,
  prestaDateRangeQuery,
  prestaFlag,
  prestaHasPatch,
  prestaListOf,
  prestaOneOf,
  type PrestaQuery,
  PrestaReadOnly,
  PrestaWriter,
  prestaXml,
} from '../zrodla/prestashop'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ChannelOfferRow,
  type ChannelOrder,
  type ChannelOrderLine,
  type ConfigField,
  type ConnectionTest,
  type FailureKind,
  type OfferPage,
  type OfferReader,
  type OrderFeed,
  type OrderFeedItem,
  type OrderFeedOptions,
  type OrderFeedPage,
  type OrderLifecycle,
  type OrderStatusWriter,
  optAmount,
  opisLinii,
  optText,
  readInt,
  readNumber,
  type StockWriteItem,
  type StockWriter,
  UnreadableDataError,
  type WriteOutcome,
} from './kontrakt'
import { AdapterConfigError } from './rejestr'

// ─── Manifesty ───────────────────────────────────────────────────────────────

const CONFIG: ConfigField[] = [
  { key: 'baseUrl', type: 'string', required: true, description: 'adres sklepu https://… (także w podkatalogu)', pattern: /^https:\/\/\S+$/i, envSuffix: 'URL' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env konta (np. PS_SKLEP)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  { key: 'pollIntervalSec', type: 'number', required: false, description: 'co ile sekund czytać zamówienia (domyślnie 60)' },
  { key: 'overlapMinutes', type: 'number', required: false, description: 'zakładka czasowa odczytu (domyślnie 5)' },
  { key: 'pageSize', type: 'number', required: false, description: 'wierszy na stronę (1–100, domyślnie 100)' },
  { key: 'strefa', type: 'string', required: false, description: 'strefa czasowa serwera sklepu (domyślnie Europe/Warsaw)' },
  { key: 'idShop', type: 'number', required: false, description: 'multistore: id sklepu (id_shop)' },
  { key: 'statusyAnulowane', type: 'string', required: false, description: `id statusów „anulowane”, po przecinku (domyślnie ${PRESTA_DEFAULT_CANCELLED})`, pattern: /^\s*\d+(\s*,\s*\d+)*\s*$/ },
]

const BASE_MANIFEST = {
  version: '1.0.0',
  kind: 'channel',
  channel: 'PRESTASHOP',
  rateLimit: { requestsPerMinute: 120, maxConcurrent: 1, minPollIntervalMs: 60_000 },
  secrets: [{ name: 'PRESTASHOP_WS_KEY', required: true, description: 'klucz Webservice PrestaShop (32 znaki)', envSuffix: 'KEY' }],
} as const satisfies Partial<AdapterManifest>

export const PRESTA_MANIFEST: AdapterManifest = {
  ...BASE_MANIFEST,
  adapterKey: 'prestashop.ws.v1',
  displayName: 'PrestaShop (Webservice, odczyt)',
  capabilities: ['orders.feed', 'offers.read'],
  config: CONFIG,
  readOnly: true,
}

export const PRESTA_ZAPIS_MANIFEST: AdapterManifest = {
  ...BASE_MANIFEST,
  adapterKey: 'prestashop.ws.zapis.v1',
  displayName: 'PrestaShop (Webservice, z zapisem za wyłącznikiem)',
  capabilities: ['orders.feed', 'offers.read', 'stock.write', 'order.status.write'],
  config: [...CONFIG, { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik zapisu stanów i statusów w sklepie (domyślnie wyłączony)' }],
  readOnly: false,
}

// ─── Mapowanie zamówienia (funkcja czysta) ───────────────────────────────────

export interface PrestaStatusFlags {
  paid: boolean
  shipped: boolean
  delivery: boolean
}

/** Słowniki sklepu potrzebne do mapowania (statusy raz na instancję, waluty i przewoźnicy z pamięci instancji). */
export interface PrestaSlowniki {
  statusy: ReadonlyMap<string, PrestaStatusFlags>
  /** id waluty → kod ISO; null = odczyt nieudany. */
  waluty: ReadonlyMap<string, string | null>
  /** id przewoźnika → nazwa; null = odczyt nieudany. */
  przewoznicy: ReadonlyMap<string, string | null>
}

export interface PrestaMapCfg {
  strefa: string
  statusyAnulowane: readonly string[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const isId = (v: string | null): v is string => !!v && /^\d+$/.test(v)

/** Data sklepu (bez strefy) → UTC albo UnreadableDataError. */
function localDate(v: unknown, strefa: string, what: string): Date {
  const s = str(v)
  const d = s ? localToUtc(s, strefa) : null
  if (!d || Number.isNaN(d.getTime())) throw new UnreadableDataError(`nieczytelna data: ${what}`)
  return d
}

const COD_RE = /cashondelivery|cod|pobranie/i

function lineOf(l: Record<string, unknown>, i: number, warnings: string[]): ChannelOrderLine {
  const id = str(l['id'])
  if (!id) throw new UnreadableDataError(`pozycja ${i + 1} bez id`)
  const qty = readInt(l['product_quantity'], `ilość pozycji ${id}`)
  if (qty <= 0) throw new UnreadableDataError(`ilość pozycji ${id} ≤ 0`)
  const pid = readInt(l['product_id'], `produkt pozycji ${id}`)
  const attr = l['product_attribute_id'] === undefined || l['product_attribute_id'] === '' ? 0 : readInt(l['product_attribute_id'], `wariant pozycji ${id}`)
  if (pid < 0 || attr < 0) throw new UnreadableDataError(`ujemny produkt albo wariant pozycji ${id}`)
  if (pid === 0) warnings.push(`pozycja ${id}: produkt usunięty ze sklepu (product_id 0)`)
  return {
    externalLineId: id,
    offerExternalId: pid > 0 ? offerId(pid, attr) : null,
    qty,
    unitPriceGross: readNumber(l['unit_price_tax_incl'], `cena pozycji ${id}`),
    vatRate: null,
    ...opisLinii(optText(l['product_name']), optText(l['product_reference'], 200), optText(l['product_ean13'], 20)),
  }
}

/** Id oferty jak w Woo (lib/adaptery/woo.ts, lineOf): „<produkt>” albo „<produkt>/<wariant>”. */
export const offerId = (product: number | string, attr: number | string) => (Number(attr) > 0 ? `${product}/${attr}` : String(product))

/** Zamówienie Webservice → ChannelOrder. Nieczytelne pole = UnreadableDataError (nigdy 0). */
export function prestaOrderFromApi(zam: Record<string, unknown>, slowniki: PrestaSlowniki, cfg: PrestaMapCfg): ChannelOrder {
  const externalId = str(zam['id'])
  if (!isId(externalId)) throw new UnreadableDataError('zamówienie PrestaShop bez id')
  const state = str(zam['current_state'])
  if (!isId(state)) throw new UnreadableDataError(`zamówienie ${externalId} bez statusu`)
  const warnings: string[] = []

  let lifecycle: OrderLifecycle = 'OPEN'
  let statusRank: number | null = null
  const flags = slowniki.statusy.get(state)
  if (cfg.statusyAnulowane.includes(state)) lifecycle = 'CANCELLED'
  else if (!flags) warnings.push(`nieznany status PrestaShop „${state}” — traktowany jak otwarte, bez kolejności`)
  else if (flags.shipped || flags.delivery) [lifecycle, statusRank] = ['FULFILLED', 30]
  else statusRank = flags.paid ? 20 : 10

  const total = readNumber(zam['total_paid_tax_incl'], `kwota zamówienia ${externalId}`)
  const module = str(zam['module'])
  let paymentState: PaymentState = 'UNPAID'
  if (module && COD_RE.test(module)) paymentState = 'COD'
  else if (flags?.paid) paymentState = 'PAID'
  else if (zam['total_paid_real'] !== undefined && zam['total_paid_real'] !== '' && zam['total_paid_real'] !== null) {
    const real = readNumber(zam['total_paid_real'], `wpłata zamówienia ${externalId}`)
    if (real > 0 && real < total) paymentState = 'PARTIAL'
  }

  const assoc = zam['associations']
  const rows = assoc && typeof assoc === 'object' ? (assoc as Record<string, unknown>)['order_rows'] : undefined
  if (!Array.isArray(rows) || rows.length === 0) throw new UnreadableDataError(`zamówienie ${externalId} bez pozycji (order_rows)`)
  const lines = (rows as Record<string, unknown>[]).map((l, i) => lineOf(l ?? {}, i, warnings))

  const currencyId = str(zam['id_currency'])
  let currency = currencyId ? slowniki.waluty.get(currencyId) : null
  if (!currency) {
    warnings.push(`waluta zamówienia nieodczytana (id ${currencyId ?? '?'}) — przyjęto PLN`)
    currency = 'PLN'
  }
  const carrierId = str(zam['id_carrier'])
  let deliveryMethod: string | null = null
  if (carrierId && carrierId !== '0') {
    deliveryMethod = slowniki.przewoznicy.get(carrierId) ?? null
    if (!deliveryMethod) warnings.push(`przewoźnik zamówienia nieodczytany (id ${carrierId})`)
  }

  const reference = str(zam['reference'])
  return {
    externalId,
    number: reference && reference !== externalId ? reference : null,
    revision: localDate(zam['date_upd'] ?? zam['date_add'], cfg.strefa, `data zmiany ${externalId}`).toISOString(),
    createdAt: localDate(zam['date_add'], cfg.strefa, `data zamówienia ${externalId}`),
    channelStatus: state,
    statusRank: lifecycle === 'CANCELLED' ? null : statusRank,
    lifecycle,
    paymentState,
    paymentMethod: str(zam['payment']) ?? module ?? '(brak)',
    totalGross: total,
    currency,
    deliveryMethod,
    shippingCostGross: optAmount(zam['total_shipping_tax_incl']),
    // NIP leży w adresie, a adresu nie czytamy (do czasu zdolności orders.recipient)
    wantInvoiceNip: false,
    lines,
    warnings,
  }
}

// ─── Kursor i czas ───────────────────────────────────────────────────────────

interface PrestaCursor {
  a: string // od kiedy (ISO UTC)
  p: number // offset
  m: string // najpóźniej widziana zmiana
}

export function parsePrestaCursor(c: string): PrestaCursor {
  try {
    const x = JSON.parse(c) as PrestaCursor
    if (typeof x.a === 'string' && typeof x.m === 'string' && Number.isInteger(x.p) && x.p >= 0 && !Number.isNaN(Date.parse(x.a)) && !Number.isNaN(Date.parse(x.m))) return x
  } catch {
    // niżej
  }
  throw new AdapterError('zły kursor PrestaShop', 'TRWALY')
}

/** Chwila UTC → czas lokalny sklepu „RRRR-MM-DD GG:MM:SS” (format filtra Webservice). */
export function utcToLocal(d: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p['year']}-${p['month']}-${p['day']} ${p['hour']}:${p['minute']}:${p['second']}`
}

function toAdapterError(e: unknown): unknown {
  if (e instanceof SourceError) return new AdapterError(e.message, e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
  return e
}

const DAY_MS = 24 * 3600_000
const CHUNK = 50

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// ─── Adapter odczytu ─────────────────────────────────────────────────────────

class PrestaAdapter implements ChannelAdapter, OrderFeed, OfferReader {
  protected readonly api: PrestaReadOnly
  protected readonly perPage: number
  protected readonly overlapMs: number
  protected readonly cfg: PrestaMapCfg
  protected readonly idShop: number | null
  /** Ostatnia wersja z nagłówka PSWS-Version (null = nieznana). */
  protected version: string | null = null
  private statusy: Map<string, PrestaStatusFlags> | null = null
  private readonly waluty = new Map<string, string | null>()
  private readonly przewoznicy = new Map<string, string | null>()

  constructor(
    readonly manifest: AdapterManifest,
    protected readonly ctx: AdapterContext,
  ) {
    const c = ctx.config
    const ps = Number(c['pageSize'] ?? 100)
    this.perPage = Number.isInteger(ps) && ps >= 1 && ps <= 100 ? ps : 100
    const o = Number(c['overlapMinutes'] ?? 5)
    this.overlapMs = (Number.isFinite(o) && o >= 0 ? o : 5) * 60_000
    const strefa = String(c['strefa'] ?? 'Europe/Warsaw')
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: strefa })
    } catch {
      throw new AdapterConfigError(`Konto ${ctx.integration.id}: nieznana strefa czasowa „${strefa}”`, ['strefa'])
    }
    const shop = c['idShop']
    if (shop !== undefined && !(Number.isInteger(shop) && Number(shop) > 0)) throw new AdapterConfigError(`Konto ${ctx.integration.id}: idShop musi być liczbą całkowitą > 0`, ['idShop'])
    this.idShop = shop === undefined ? null : Number(shop)
    const cancelled = String(c['statusyAnulowane'] ?? PRESTA_DEFAULT_CANCELLED)
    this.cfg = { strefa, statusyAnulowane: cancelled.split(',').map((s) => s.trim()).filter(Boolean) }
    this.api = new PrestaReadOnly(String(c['baseUrl']), ctx.secrets['PRESTASHOP_WS_KEY']!, ctx.fetch as FetchLike, ctx.http?.minIntervalMs, ctx.http?.retry)
  }

  /** GET z id_shop (multistore) i zapamiętaniem wersji; błąd → AdapterError z rodzajem. */
  protected async read<T>(path: string, query: PrestaQuery = {}) {
    try {
      const r = await this.api.get<T>(path, this.idShop ? { ...query, id_shop: this.idShop } : query)
      if (r.version) this.version = r.version
      return r
    } catch (e) {
      throw toAdapterError(e)
    }
  }

  async testConnection(): Promise<ConnectionTest> {
    const checks: [string, string][] = [
      ['orders', 'zamówienia'],
      ['order_states', 'statusy zamówień'],
      ['stock_availables', 'stany'],
      // reszta tabeli uprawnień z docs; bez nich zamówienie w EUR dostałoby PLN bez błędu konta
      ['currencies', 'waluty'],
      ['carriers', 'przewoźnicy'],
      ['products', 'produkty'],
      ['combinations', 'warianty produktów'],
    ]
    for (const [res, label] of checks) {
      try {
        const r = await this.api.get<unknown>(`/${res}`, { display: '[id]', limit: 1, ...(this.idShop ? { id_shop: this.idShop } : {}) })
        if (r.version) this.version = r.version
        if (r.status === 404) return { ok: false, message: `brak zasobu ${res} (${label}) — sprawdź adres sklepu i czy Webservice jest włączony` }
      } catch (e) {
        if (e instanceof PrestaError && e.status === 401) return { ok: false, message: 'klucz Webservice odrzucony (401) — sprawdź klucz i czy Webservice jest włączony' }
        if (e instanceof PrestaError && e.status === 403) return { ok: false, message: `klucz nie ma prawa odczytu (GET) zasobu ${res} (${label})` }
        if (e instanceof PrestaError && e.reason === 'html') return { ok: false, message: 'sklep zwraca stronę HTML zamiast Webservice — włącz przepisywanie adresów (mod_rewrite) i Webservice' }
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    }
    return { ok: true, message: 'odczyt zamówień, statusów, stanów, walut, przewoźników i produktów działa', details: { wersja: this.version, patch: prestaHasPatch(this.version) } }
  }

  // ── słowniki ──

  private async loadStatusy(): Promise<Map<string, PrestaStatusFlags>> {
    if (this.statusy) return this.statusy
    const r = await this.read<unknown>('/order_states', { display: 'full' })
    const list = prestaListOf(r.body, 'order_states')
    if (!list) throw new AdapterError('PrestaShop /order_states: nieznany kształt odpowiedzi', 'PRZEJSCIOWY')
    const m = new Map<string, PrestaStatusFlags>()
    for (const s of list) {
      const id = str(s['id'])
      if (!isId(id)) continue
      m.set(id, { paid: prestaFlag(s['paid']) === true, shipped: prestaFlag(s['shipped']) === true, delivery: prestaFlag(s['delivery']) === true })
    }
    this.statusy = m
    return m
  }

  private async lookupName(cache: Map<string, string | null>, id: string | null, path: string, singular: string, resource: string, field: string): Promise<void> {
    if (!isId(id) || id === '0' || cache.has(id)) return
    try {
      const r = await this.read<unknown>(`${path}/${id}`)
      cache.set(id, str(prestaOneOf(r.body, singular, resource)?.[field]))
    } catch {
      cache.set(id, null) // błąd = ostrzeżenie w mapowaniu (PLN albo brak przewoźnika), bez przerywania odczytu
    }
  }

  protected async slownikiFor(orders: Record<string, unknown>[]): Promise<PrestaSlowniki> {
    const statusy = await this.loadStatusy()
    for (const o of orders) {
      await this.lookupName(this.waluty, str(o['id_currency']), '/currencies', 'currency', 'currencies', 'iso_code')
      await this.lookupName(this.przewoznicy, str(o['id_carrier']), '/carriers', 'carrier', 'carriers', 'name')
    }
    return { statusy, waluty: this.waluty, przewoznicy: this.przewoznicy }
  }

  // ── dziennik ──

  async listOrderChanges(cursor: string | null, opts: OrderFeedOptions): Promise<OrderFeedPage> {
    const now = this.ctx.now().getTime()
    const start = new Date(now - opts.initialLookbackMs).toISOString()
    const cur: PrestaCursor = cursor ? parsePrestaCursor(cursor) : { a: start, p: 0, m: start }
    // zakres domknięty; „do” = teraz + 1 dzień (zegar sklepu może się spieszyć), duble odsiewa host
    const upper = now + DAY_MS
    const fromSec = Math.floor(Date.parse(cur.a) / 1000) * 1000
    let r
    try {
      r = await this.api.get<unknown>('/orders', {
        display: 'full',
        ...prestaDateRangeQuery(utcToLocal(new Date(fromSec), this.cfg.strefa), utcToLocal(new Date(upper), this.cfg.strefa)),
        sort: '[date_upd_ASC,id_ASC]',
        limit: `${cur.p},${this.perPage}`,
        ...(this.idShop ? { id_shop: this.idShop } : {}),
      })
      if (r.version) this.version = r.version
    } catch (e) {
      if (e instanceof PrestaError && e.status === 400)
        throw new AdapterError('PrestaShop /orders: HTTP 400 — sklep nie obsługuje filtra dat (filter[date_upd]); odczyt zamówień niemożliwy bez zmiany adaptera', 'TRWALY')
      throw toAdapterError(e)
    }
    const list = prestaListOf(r.body, 'orders')
    if (!list) throw new AdapterError('PrestaShop /orders: odpowiedź nie jest listą zamówień', 'PRZEJSCIOWY')

    const warnings: string[] = []
    let outOfRange = 0
    const inRange: { raw: Record<string, unknown>; id: string; rev: string | null }[] = []
    for (const raw of list) {
      const id = str(raw['id'])
      if (!isId(id)) continue // bez id nie da się ani zapisać, ani ponowić
      let rev: string | null = null
      try {
        rev = localDate(raw['date_upd'] ?? raw['date_add'], this.cfg.strefa, `data zmiany ${id}`).toISOString()
      } catch {
        // nieczytelna data: element do pobrania osobno, klucz strony bez zmian
      }
      if (rev && (Date.parse(rev) < fromSec || Date.parse(rev) > upper)) {
        outOfRange++ // ochrona na [NIEPEWNE] filtr dat: sklep zwrócił wiersz spoza zakresu
        continue
      }
      inRange.push({ raw, id, rev })
    }
    if (outOfRange) warnings.push(`PrestaShop zwrócił ${outOfRange} zamówień spoza zakresu dat — filtr date_upd mógł nie zadziałać; odrzucone`)

    const withRows = inRange.filter((x) => x.rev && Array.isArray((x.raw['associations'] as Record<string, unknown> | undefined)?.['order_rows']))
    const slowniki = withRows.length ? await this.slownikiFor(withRows.map((x) => x.raw)) : null

    let maxSeen = cur.m
    let lastOnPage: string | null = null
    const items: OrderFeedItem[] = []
    for (const x of inRange) {
      if (x.rev) {
        lastOnPage = x.rev
        if (x.rev > maxSeen) maxSeen = x.rev
      }
      if (!x.rev) {
        items.push({ externalId: x.id, revision: '' })
        continue
      }
      if (!slowniki || !withRows.includes(x)) {
        items.push({ externalId: x.id, revision: x.rev }) // lista bez order_rows: host zawoła getOrder
        continue
      }
      try {
        const order = prestaOrderFromApi(x.raw, slowniki, this.cfg)
        items.push({ externalId: order.externalId, revision: order.revision, order })
      } catch {
        // jedno nieczytelne zamówienie nie psuje strony: host pobierze je osobno (getOrder) i zapisze błąd elementu
        items.push({ externalId: x.id, revision: '' })
      }
    }

    if (list.length >= this.perPage) {
      // Stronicowanie po kluczu: następna strona od daty ostatniego zamówienia (zakres domknięty, więc ta sama
      // sekunda wraca — duble odsiewa host). Gdy klucz nie posuwa się (cała strona w jednej sekundzie albo poza
      // zakresem) — kolejny offset.
      const next = lastOnPage && lastOnPage > cur.a ? { a: lastOnPage, p: 0, m: maxSeen } : { a: cur.a, p: cur.p + this.perPage, m: maxSeen }
      return { items, nextCursor: JSON.stringify(next), hasMore: true, ...(warnings.length ? { warnings } : {}) }
    }
    const back = new Date(Date.parse(maxSeen) - this.overlapMs).toISOString()
    const nextAfter = back > cur.a ? back : cur.a
    return { items, nextCursor: JSON.stringify({ a: nextAfter, p: 0, m: maxSeen }), hasMore: false, ...(warnings.length ? { warnings } : {}) }
  }

  async getOrder(externalId: string): Promise<ChannelOrder | null> {
    if (!/^\d+$/.test(externalId)) throw new AdapterError(`zły numer zamówienia PrestaShop „${externalId}”`, 'TRWALY')
    const r = await this.read<unknown>(`/orders/${externalId}`)
    if (r.status === 404 || r.body === null) return null
    const raw = prestaOneOf(r.body, 'order', 'orders')
    if (!raw) throw new UnreadableDataError(`zamówienie ${externalId}: nieznany kształt odpowiedzi`)
    return prestaOrderFromApi(raw, await this.slownikiFor([raw]), this.cfg)
  }

  // ── oferty i stany ──

  async listOffers(cursor: string | null): Promise<OfferPage> {
    const offset = cursor === null ? 0 : Number(cursor)
    if (!Number.isInteger(offset) || offset < 0) throw new AdapterError('zły kursor ofert PrestaShop', 'TRWALY')
    const r = await this.read<unknown>('/stock_availables', { display: '[id,id_product,id_product_attribute,quantity]', sort: '[id_ASC]', limit: `${offset},${this.perPage}` })
    const list = prestaListOf(r.body, 'stock_availables')
    if (!list) throw new AdapterError('PrestaShop /stock_availables: odpowiedź nie jest listą', 'PRZEJSCIOWY')
    const rows = list.map((s, i) => {
      const id = str(s['id']) ?? `#${offset + i + 1}`
      const product = readInt(s['id_product'], `produkt wiersza stanu ${id}`)
      const attr = s['id_product_attribute'] === undefined || s['id_product_attribute'] === '' ? 0 : readInt(s['id_product_attribute'], `wariant wiersza stanu ${id}`)
      return { product, attr, qty: readInt(s['quantity'], `stan wiersza ${id}`) }
    })

    // wiersz z atrybutem 0 produktu z wariantami to suma wariantów — pomijany
    const hasVariants = new Set(rows.filter((x) => x.attr > 0).map((x) => x.product))
    const unknown = [...new Set(rows.filter((x) => x.attr === 0 && !hasVariants.has(x.product)).map((x) => x.product))]
    for (const part of chunks(unknown, CHUNK)) {
      const v = await this.read<unknown>('/stock_availables', { display: '[id,id_product,id_product_attribute]', 'filter[id_product]': `[${part.join('|')}]` })
      for (const s of prestaListOf(v.body, 'stock_availables') ?? []) {
        if (Number(s['id_product_attribute']) > 0) hasVariants.add(Number(s['id_product']))
      }
    }
    const kept = rows.filter((x) => x.attr > 0 || !hasVariants.has(x.product))

    const products = new Map<number, Record<string, unknown>>()
    for (const part of chunks([...new Set(kept.map((x) => x.product))], CHUNK)) {
      const p = await this.read<unknown>('/products', { display: '[id,reference,ean13,active,id_default_image]', 'filter[id]': `[${part.join('|')}]` })
      for (const x of prestaListOf(p.body, 'products') ?? []) products.set(Number(x['id']), x)
    }
    const combos = new Map<number, Record<string, unknown>>()
    for (const part of chunks([...new Set(kept.filter((x) => x.attr > 0).map((x) => x.attr))], CHUNK)) {
      const c = await this.read<unknown>('/combinations', { display: '[id,id_product,reference,ean13]', 'filter[id]': `[${part.join('|')}]` })
      for (const x of prestaListOf(c.body, 'combinations') ?? []) combos.set(Number(x['id']), x)
    }

    const items: ChannelOfferRow[] = kept.map((x) => {
      const p = products.get(x.product)
      const c = x.attr > 0 ? combos.get(x.attr) : undefined
      const zdjecie = prestaZdjecie(String(this.ctx.config['baseUrl']), p?.['id_default_image'])
      return {
        externalId: offerId(x.product, x.attr),
        // SKU wariantu, gdy jest, inaczej produktu; EAN produktu tylko dla produktu prostego (wariant ma własny)
        sku: str(c?.['reference']) ?? str(p?.['reference']),
        ean: x.attr > 0 ? str(c?.['ean13']) : str(p?.['ean13']),
        name: null,
        qty: x.qty,
        active: prestaFlag(p?.['active']) === true,
        ...(zdjecie ? { imageUrls: [zdjecie] } : {}),
      }
    })
    return { items, nextCursor: list.length >= this.perPage ? String(offset + this.perPage) : null }
  }
}

/**
 * publiczny adres głównego zdjęcia produktu PrestaShop (`id_default_image`): oryginał w katalogu
 * `img/p/` z cyframi id rozłożonymi na podkatalogi (id 123 → `img/p/1/2/3/123.jpg`), bez klucza Webservice
 * i niezależnie od przyjaznych adresów. Tylko https; brak zdjęcia albo zły id = null. Ceny nie bierzemy:
 * PrestaShop podaje cenę netto, a stawka zależy od reguł podatkowych kraju (osobne zasoby i uprawnienia klucza).
 */
export function prestaZdjecie(baseUrl: string, idImage: unknown): string | null {
  const id = typeof idImage === 'number' ? String(idImage) : typeof idImage === 'string' ? idImage.trim() : ''
  if (!/^[1-9]\d{0,9}$/.test(id)) return null
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(base)) return null
  return `${base}/img/p/${id.split('').join('/')}/${id}.jpg`
}

// ─── Adapter z zapisem (za wyłącznikiem) ─────────────────────────────────────

const OFF = 'zapis wyłączony na tym koncie'
const worse = (a: FailureKind, b: FailureKind): FailureKind => (a === 'TRWALY' || b === 'TRWALY' ? 'TRWALY' : a === 'NIEJEDNOZNACZNY' || b === 'NIEJEDNOZNACZNY' ? 'NIEJEDNOZNACZNY' : 'PRZEJSCIOWY')

class PrestaZapisAdapter extends PrestaAdapter implements StockWriter, OrderStatusWriter {
  /** Tworzony dopiero przy pierwszym zapisie i tylko przy włączonym wyłączniku. */
  private writerInstance: PrestaWriter | null = null

  private get enabled(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  private get writer(): PrestaWriter {
    // ten sam limiter co odczyt: odczyt wiersza i zapis idą w odstępie z manifestu (docs: najwyżej 2 zapytania na sekundę)
    this.writerInstance ??= new PrestaWriter(String(this.ctx.config['baseUrl']), this.ctx.secrets['PRESTASHOP_WS_KEY']!, this.ctx.fetch as FetchLike, this.api.throttle)
    return this.writerInstance
  }

  async pushStock(items: StockWriteItem[], reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return { kind: 'TRWALY', reference, message: OFF }
    const failed: { id: string; kind: FailureKind }[] = []
    // paczka nie przerywa się na jednym błędzie: każda pozycja idzie osobno
    for (const it of items) {
      const kind = await this.pushOne(it).catch((e: unknown) => (e instanceof AdapterError ? e.kind : 'TRWALY'))
      if (kind !== 'OK') failed.push({ id: it.offerExternalId, kind })
    }
    if (!failed.length) return { kind: 'OK', reference }
    const kind = failed.map((f) => f.kind).reduce(worse)
    const ids = failed.slice(0, 20).map((f) => f.id).join(', ')
    return { kind, reference, message: `${failed.length} z ${items.length} pozycji nieudanych: ${ids}${failed.length > 20 ? ', …' : ''}` }
  }

  private async pushOne(it: StockWriteItem): Promise<'OK' | FailureKind> {
    const m = /^(\d+)(?:\/(\d+))?$/.exec(it.offerExternalId)
    if (!m || !Number.isInteger(it.qty)) return 'TRWALY'
    const [product, attr] = [m[1]!, m[2] ?? '0']
    const r = await this.read<unknown>('/stock_availables', { display: '[id]', 'filter[id_product]': `[${product}]`, 'filter[id_product_attribute]': `[${attr}]` })
    const rows = prestaListOf(r.body, 'stock_availables') ?? []
    const id = rows.length === 1 ? str(rows[0]!['id']) : null
    if (!isId(id)) return 'TRWALY' // brak wiersza albo więcej niż jeden (multistore bez idShop)
    const path = `/stock_availables/${id}`
    let xml: string
    let method: 'PATCH' | 'PUT'
    if (prestaHasPatch(this.version)) {
      method = 'PATCH'
      xml = prestaXml('stock_available', [
        ['id', id],
        ['quantity', it.qty],
      ])
    } else {
      // 1.7 albo wersja nieznana: PUT całego wiersza po GET z display=full, ze zmienionym quantity
      method = 'PUT'
      let full
      try {
        full = await this.writer.getForPut<unknown>(path)
      } catch (e) {
        throw toAdapterError(e)
      }
      const row = prestaOneOf(full.body, 'stock_available', 'stock_availables')
      if (!row) return full.status === 404 ? 'TRWALY' : 'PRZEJSCIOWY'
      const fields = Object.entries(row)
        .filter(([k, v]) => !PRESTA_PUT_POMIJANE.includes(k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v)))
        .map(([k, v]) => [k, k === 'quantity' ? it.qty : (v ?? '')] as const)
      if (!fields.some(([k]) => k === 'quantity')) fields.push(['quantity', it.qty])
      xml = prestaXml('stock_available', fields as [string, string | number | boolean][])
    }
    let res
    try {
      res = await this.writer.send(method, path, xml)
    } catch {
      // Zapis bezwzględny (ustawia ilość, nie zmienia o deltę): po timeoucie powtórzenie tą samą ilością da ten sam
      // wynik, więc to PRZEJSCIOWY, nie NIEJEDNOZNACZNY. Dlatego bez reference.find.
      return 'PRZEJSCIOWY'
    }
    if (res.status >= 200 && res.status < 300) return 'OK'
    // 429 i 5xx: jak wyżej — ponowienie bezwzględnego zapisu jest bezpieczne
    if (res.status === 429 || res.status >= 500) return 'PRZEJSCIOWY'
    return 'TRWALY'
  }

  async setOrderStatus(orderExternalId: string, channelStatus: string, reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return { kind: 'TRWALY', reference, message: OFF }
    if (!/^\d+$/.test(orderExternalId) || !/^\d+$/.test(channelStatus)) return { kind: 'TRWALY', reference, message: 'zły numer zamówienia albo statusu PrestaShop' }
    try {
      const r = await this.read<unknown>(`/orders/${orderExternalId}`, { display: '[id,current_state]' })
      if (r.status === 404 || r.body === null) return { kind: 'TRWALY', reference, message: `brak zamówienia ${orderExternalId} w sklepie` }
      const cur = str(prestaOneOf(r.body, 'order', 'orders')?.['current_state'])
      if (!cur) return { kind: 'PRZEJSCIOWY', reference, message: `zamówienie ${orderExternalId}: nieczytelny status` }
      if (cur === channelStatus) return { kind: 'OK', reference } // już ustawiony — bez zapisu
    } catch (e) {
      const ae = toAdapterError(e)
      return { kind: ae instanceof AdapterError ? ae.kind : 'PRZEJSCIOWY', reference, message: ae instanceof Error ? ae.message : String(ae) }
    }
    // Zmiana statusu = nowy wpis w order_histories (current_state nie zapisujemy przez orders). Bez sendemail.
    const xml = prestaXml('order_history', [
      ['id_order', orderExternalId],
      ['id_order_state', channelStatus],
    ])
    let res
    try {
      res = await this.writer.send('POST', '/order_histories', xml)
    } catch {
      // POST nie jest idempotentny: po timeoucie nie wiadomo, czy wpis powstał, a ślepe ponowienie dodałoby drugi wpis
      // historii (i drugi mail/skutki statusu). Kolejne wywołanie jest bezpieczne, bo zaczyna od odczytu stanu.
      return { kind: 'NIEJEDNOZNACZNY', reference, message: `zmiana statusu zamówienia ${orderExternalId}: brak odpowiedzi po wysłaniu` }
    }
    if (res.status >= 200 && res.status < 300) return { kind: 'OK', reference }
    if (res.status >= 500) return { kind: 'NIEJEDNOZNACZNY', reference, message: `zmiana statusu zamówienia ${orderExternalId}: HTTP ${res.status} po wysłaniu` }
    if (res.status === 429) return { kind: 'PRZEJSCIOWY', reference, message: `zmiana statusu zamówienia ${orderExternalId}: HTTP 429` }
    return { kind: 'TRWALY', reference, message: `zmiana statusu zamówienia ${orderExternalId}: HTTP ${res.status}` }
  }
}

export const PRESTA_DEFINITION: AdapterDefinition = { manifest: PRESTA_MANIFEST, create: (ctx) => new PrestaAdapter(PRESTA_MANIFEST, ctx) }
export const PRESTA_ZAPIS_DEFINITION: AdapterDefinition = { manifest: PRESTA_ZAPIS_MANIFEST, create: (ctx) => new PrestaZapisAdapter(PRESTA_ZAPIS_MANIFEST, ctx) }
