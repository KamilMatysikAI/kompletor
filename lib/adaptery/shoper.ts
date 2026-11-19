// Adapter Shoper REST, dwa klucze:
//   `shoper.rest.v1`       — domyślny, tylko odczyt: dziennik zamówień (polling po `status_date`) i lista stanów;
//   `shoper.rest.zapis.v1` — to samo plus zapis stanu (`PUT product-stocks/<id>`) i statusu (`PUT orders/<id>`) za
//                            wyłącznikiem: zapis wymaga klucza zapisu, `zapisWlaczony: true` w koncie i hosta, który go
//                            wywoła (dziś żaden nie woła — kod zapisu uruchamiają wyłącznie testy).
// Kod sprawdzony tylko na atrapie HTTP (tests/shoper-atrapa.ts); pola oznaczone [NIEPEWNE] są zebrane w stałych
// TYP_STATUSU i NIEPEWNE niżej i czekają na próbę na sklepie demo (docs/integracje/shoper.md).
// Mapowanie: status z typu w słowniku `/statuses` (1 nowy, 2 w realizacji → OPEN; 3 wysłany → FULFILLED; 4 końcowy →
// CANCELLED; nieznany → OPEN + ostrzeżenie). Pozycje są osobnym zasobem (`/order-products`), więc dziennik zwraca
// same identyfikatory i rewizje, a pełne zamówienie składa getOrder. Oferta = `stock_id` (pozycja magazynowa).
// Dane klienta (email, adresy, IP, notatki, punkt odbioru) nie są czytane; z adresu tylko „czy jest NIP” (tak/nie).
import type { PaymentState } from '@prisma/client'
import { localToUtc } from '../zrodla/czas-lokalny'
import { SourceError, type FetchLike } from '../zrodla/http'
import { ShoperHttpError, ShoperReadOnly, ShoperSession, ShoperWriter, type ShoperAuth, type ShoperWriteResult } from '../zrodla/shoper'
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
  readNumber,
  type SecretField,
  type StockWriteItem,
  type StockWriter,
  UnreadableDataError,
  type WriteOutcome,
} from './kontrakt'
import { AdapterConfigError } from './rejestr'
import { parseWooCursor } from './woo'

// ─── Manifesty ───────────────────────────────────────────────────────────────

const CONFIG: readonly ConfigField[] = [
  { key: 'baseUrl', type: 'string', required: true, description: 'adres sklepu https://…', pattern: /^https:\/\/\S+$/i, envSuffix: 'URL' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env konta (np. SKLEP_SHOPER)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  { key: 'pollIntervalSec', type: 'number', required: false, description: 'co ile sekund czytać zamówienia (domyślnie 60)' },
  { key: 'overlapMinutes', type: 'number', required: false, description: 'zakładka czasowa odczytu (domyślnie 5)' },
  { key: 'pageSize', type: 'number', required: false, description: 'wierszy na stronę (1–50, domyślnie 50)' },
  { key: 'strefa', type: 'string', required: false, description: 'strefa czasowa dat sklepu (domyślnie Europe/Warsaw)' },
]

const SECRETS: readonly SecretField[] = [
  { name: 'SHOPER_ACCESS_TOKEN', required: false, description: 'token integracji z panelu sklepu (Bearer)', envSuffix: 'TOKEN' },
  { name: 'SHOPER_API_LOGIN', required: false, description: 'login administratora API (gdy bez tokena)', envSuffix: 'LOGIN' },
  { name: 'SHOPER_API_PASSWORD', required: false, description: 'hasło administratora API (gdy bez tokena)', envSuffix: 'PASSWORD' },
]

export const SHOPER_MANIFEST: AdapterManifest = {
  adapterKey: 'shoper.rest.v1',
  version: '1.0.0',
  displayName: 'Shoper (REST, odczyt)',
  kind: 'channel',
  channel: 'SHOPER',
  capabilities: ['orders.feed', 'offers.read'],
  rateLimit: { requestsPerMinute: 100, maxConcurrent: 1, minPollIntervalMs: 60_000 },
  config: CONFIG,
  secrets: SECRETS,
  readOnly: true,
}

export const SHOPER_ZAPIS_MANIFEST: AdapterManifest = {
  ...SHOPER_MANIFEST,
  adapterKey: 'shoper.rest.zapis.v1',
  displayName: 'Shoper (REST, odczyt i zapis za wyłącznikiem)',
  capabilities: ['orders.feed', 'offers.read', 'stock.write', 'order.status.write'],
  config: [...CONFIG, { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'zgoda na zapis stanów i statusów w sklepie (domyślnie nie)' }],
  readOnly: false,
}

// ─── [NIEPEWNE] — do potwierdzenia na sklepie demo, nigdzie indziej ──────────

/**
 * [NIEPEWNE] Typ statusu Shopera (`/statuses`, pole `type`) → cykl życia i kolejność. Wartości z próby OpenLinkera
 * (1 nowy, 2 w realizacji, 3 wysłany, 4 końcowy); niepewne, czy 4 to wyłącznie anulowane.
 */
export const TYP_STATUSU: Readonly<Record<number, { lifecycle: OrderLifecycle; rank: number | null }>> = {
  1: { lifecycle: 'OPEN', rank: 10 },
  2: { lifecycle: 'OPEN', rank: 20 },
  3: { lifecycle: 'FULFILLED', rank: 30 },
  4: { lifecycle: 'CANCELLED', rank: null },
}

/** [NIEPEWNE] Pozostałe założenia o API (lista w docs/integracje/shoper.md, sekcja przed ogłoszeniem). */
export const NIEPEWNE = {
  /** Filtr listy zamówień po dacie zmiany statusu (SDK go nie wymienia); adapter sprawdza, czy działa. */
  filtrZmian: 'filters[status_date][>=]',
  /**
   * `status_date` ustawione już przy złożeniu zamówienia (równe `date`), a nie dopiero przy pierwszej zmianie statusu.
   * Inaczej nowe zamówienie nie przejdzie przez `filtrZmian` i trafi do cienia dopiero po zmianie statusu.
   * Zapasowo drugi odczyt `filters[date][>=]`, osobna decyzja po sklepie demo.
   */
  statusDataPrzyZlozeniu: true,
  /** Filtr pozycji po zamówieniu (SDK go nie wymienia); wiersze innego zamówienia są odrzucane. */
  filtrPozycji: 'filters[order_id][=]',
  /** Kolejność listy bez sortowania: rosnąco po order_id (najnowsze na ostatniej stronie). */
  listaRosnaco: true,
  /** `price` pozycji to cena jednostkowa brutto. */
  cenaBrutto: true,
  /** Język nazw płatności (`translations.<język>.title`), potem dowolny, potem `name`. */
  jezykNazw: 'pl_PL',
  /** Kod waluty to `name` w słowniku `/currencies` (zamówienie ma tylko `currency_id`). */
  walutaZNazwy: true,
} as const

// ─── Pomocnicze ──────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Flaga Shopera („1”/„0”, 1/0, true/false); brak = nie; inna wartość = nieczytelna. */
function flag(v: unknown, what: string): boolean {
  if (v === undefined || v === null || v === '') return false
  if (v === true || v === 1 || v === '1') return true
  if (v === false || v === 0 || v === '0') return false
  throw new UnreadableDataError(`nieczytelna flaga: ${what}`)
}

const LOCAL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** Data lokalna Shopera w postaci porównywalnej jako napis („2026-11-03 12:34:56”) albo null. */
function localOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().replace('T', ' ')
  return LOCAL_RE.test(s) ? s : null
}

/** Chwila UTC → data lokalna sklepu „RRRR-MM-DD GG:MM:SS” (wartość filtra po stronie Shopera). */
export function utcToLocal(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  return `${p['year']}-${p['month']}-${p['day']} ${p['hour']}:${p['minute']}:${p['second']}`
}

/**
 * Wartość filtra „od” w czasie sklepu. W pierwszym wystąpieniu godziny powtarzanej jesienią (02:xx czasu letniego)
 * lokalny napis nie odróżni jej od drugiego (02:xx zimowego), a sklep porównuje napisy — filtr od pełnej godziny,
 * żeby nie zgubić zmian z drugiego wystąpienia (duble odsiewa host).
 */
export function sinceLocal(a: Date, tz: string): string {
  const local = utcToLocal(a, tz)
  return localToUtc(local, tz)?.getTime() === Math.floor(a.getTime() / 1000) * 1000 ? local : `${local.slice(0, 14)}00:00`
}

function utcOf(local: string, tz: string, what: string): Date {
  const d = localToUtc(local, tz)
  if (!d || Number.isNaN(d.getTime())) throw new UnreadableDataError(`nieczytelna data: ${what}`)
  return d
}

/** Późniejsza z dat `status_date` i `date` (lokalnie, jako napis); brak czytelnej `date` = błąd. */
function changedLocal(zam: Record<string, unknown>, id: string): string {
  const date = localOf(zam['date'])
  if (!date) throw new UnreadableDataError(`brak daty zamówienia ${id}`)
  const raw = zam['status_date']
  if (raw === undefined || raw === null || raw === '') return date
  const sd = localOf(raw)
  if (!sd) throw new UnreadableDataError(`nieczytelna data zmiany statusu ${id}`)
  return sd > date ? sd : date
}

/**
 * Rewizja: ISO UTC późniejszej z dat `status_date` i `date` + „#” + opłacone (0/1). Rdzeń porównuje napisy: nowsza
 * data zawsze wygrywa (stała długość ISO), a przy tej samej dacie opłacenie daje nowszą rewizję.
 */
export function shoperRevision(zam: Record<string, unknown>, strefa: string): string {
  const id = str(zam['order_id']) ?? '?'
  const local = changedLocal(zam, id)
  return `${utcOf(local, strefa, `data zmiany ${id}`).toISOString()}#${flag(zam['is_paid'], `opłacone ${id}`) ? 1 : 0}`
}

// ─── Mapowanie zamówienia ────────────────────────────────────────────────────

export interface ShoperSlowniki {
  /** status_id → typ statusu (null = brak czytelnego typu). */
  statusy: ReadonlyMap<string, number | null>
  /** payment_id → nazwa; null = słownik nieodczytany. */
  platnosci: ReadonlyMap<string, string> | null
  /** shipping_id → nazwa; null = słownik nieodczytany. */
  dostawy: ReadonlyMap<string, string> | null
  /** currency_id → kod waluty; null = słownik nieodczytany. */
  waluty: ReadonlyMap<string, string> | null
}

function paymentOf(zam: Record<string, unknown>, id: string): PaymentState {
  if (flag(zam['is_cash_on_delivery'], `pobranie ${id}`)) return 'COD'
  if (flag(zam['is_paid'], `opłacone ${id}`)) return 'PAID'
  if (flag(zam['is_underpayment'], `niedopłata ${id}`)) return 'PARTIAL'
  return 'UNPAID'
}

function nameOf(dict: ReadonlyMap<string, string> | null, key: string | null, what: string, warnings: string[]): string | null {
  if (!key) return null
  if (!dict) {
    warnings.push(`słownik ${what} nieodczytany — w zamówieniu identyfikator ${key}`)
    return key
  }
  const n = dict.get(key)
  if (n) return n
  warnings.push(`nieznana ${what} o identyfikatorze ${key}`)
  return key
}

function lineOf(p: Record<string, unknown>, orderId: string, warnings: string[]): ChannelOrderLine {
  const id = str(p['id'])
  if (!id) throw new UnreadableDataError(`pozycja zamówienia ${orderId} bez id`)
  const qty = readNumber(p['quantity'], `ilość pozycji ${id}`)
  if (!Number.isInteger(qty)) throw new UnreadableDataError(`ilość pozycji ${id} nie jest liczbą całkowitą`)
  if (qty <= 0) throw new UnreadableDataError(`ilość pozycji ${id} ≤ 0`)
  const stock = str(p['stock_id'])
  if (!stock) warnings.push(`pozycja ${id}: bez stock_id (produkt usunięty albo spoza magazynu sklepu)`)
  return {
    externalLineId: id,
    offerExternalId: stock,
    qty,
    unitPriceGross: readNumber(p['price'], `cena pozycji ${id}`), // [NIEPEWNE] NIEPEWNE.cenaBrutto
    vatRate: str(p['tax_value']),
    ...opisLinii(optText(p['name']), optText(p['code'], 200), null),
  }
}

/** Zamówienie Shopera z pozycjami → ChannelOrder. Czysta funkcja; nieczytelne pole = UnreadableDataError (nigdy 0). */
export function shoperOrderFromApi(zam: Record<string, unknown>, pozycje: readonly Record<string, unknown>[], slowniki: ShoperSlowniki, strefa: string): ChannelOrder {
  const externalId = str(zam['order_id'])
  if (!externalId || !/^\d+$/.test(externalId)) throw new UnreadableDataError('zamówienie Shoper bez order_id')
  const warnings: string[] = []
  const statusId = str(zam['status_id'])
  if (!statusId) throw new UnreadableDataError(`zamówienie ${externalId} bez statusu`)
  const typ = slowniki.statusy.has(statusId) ? slowniki.statusy.get(statusId)! : undefined
  const known = typ !== undefined && typ !== null ? TYP_STATUSU[typ] : undefined
  if (typ === undefined) warnings.push(`nieznany status Shoper ${statusId} (brak w słowniku statusów) — traktowany jak otwarte, bez kolejności`)
  else if (!known) warnings.push(`nieznany typ statusu Shoper ${String(typ)} (status ${statusId}) — traktowany jak otwarte, bez kolejności`)
  if (zam['confirm'] !== undefined && zam['confirm'] !== null && !flag(zam['confirm'], `potwierdzenie ${externalId}`))
    warnings.push('zamówienie niepotwierdzone w sklepie (confirm 0) — rezerwujemy od chwili zamówienia')
  if (!pozycje.length) throw new UnreadableDataError(`zamówienie ${externalId} bez pozycji`)
  const lines = pozycje.map((p) => lineOf(p, externalId, warnings))
  const date = localOf(zam['date'])
  if (!date) throw new UnreadableDataError(`brak daty zamówienia ${externalId}`)
  let currency = nameOf(slowniki.waluty, str(zam['currency_id']), 'waluta', [])
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    warnings.push('nieczytelna waluta zamówienia — przyjęto PLN')
    currency = 'PLN'
  }
  return {
    externalId,
    number: null,
    revision: shoperRevision(zam, strefa),
    createdAt: utcOf(date, strefa, `data zamówienia ${externalId}`),
    channelStatus: statusId,
    statusRank: known?.rank ?? null,
    lifecycle: known?.lifecycle ?? 'OPEN',
    paymentState: paymentOf(zam, externalId),
    paymentMethod: nameOf(slowniki.platnosci, str(zam['payment_id']), 'płatność', warnings) ?? '(brak)',
    totalGross: readNumber(zam['sum'], `kwota zamówienia ${externalId}`),
    currency,
    deliveryMethod: nameOf(slowniki.dostawy, str(zam['shipping_id']), 'dostawa', warnings),
    shippingCostGross: optAmount(zam['shipping_cost']),
    // jedyny dozwolony odczyt z adresu: czy jest NIP (wartości nie zachowujemy)
    wantInvoiceNip: isObj(zam['billing_address']) && !!str(zam['billing_address']['tax_identification_number']),
    lines,
    warnings,
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

interface ListBody {
  count?: unknown
  pages?: unknown
  page?: unknown
  list?: unknown
}

const pageSizeOf = (v: unknown) => {
  const n = Number(v ?? 50)
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 50
}
const intOrNull = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

function toAdapterError(e: unknown): unknown {
  if (e instanceof ShoperHttpError) return new AdapterError(e.message, e.retryable ? 'PRZEJSCIOWY' : 'TRWALY', e.retryAfterMs)
  if (e instanceof SourceError) return new AdapterError(e.message, e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
  return e
}

/** Najwięcej stron jednego odczytu od końca listy, gdy filtr daty nie działa. */
const MAX_STRON_WSTECZ = 5
/** Najwięcej stron pozycji jednego zamówienia (zabezpieczenie, gdy filtr po order_id nie działa). */
const MAX_STRON_POZYCJI = 10
/** Najwięcej stron słownika (statusy, płatności, dostawy, waluty). */
const MAX_STRON_SLOWNIKA = 20

/** Ostrzeżenie zamówienia, gdy `/order-products` oddało wiersze innych zamówień (raz na zamówienie). */
export const FILTR_POZYCJI_NIE_DZIALA = 'filtr order_id w /order-products nie działa — pozycje odczytane z pełnej listy (wolno, najwyżej 10 stron)'

export const FILTR_NIE_DZIALA =
  'API sklepu zwraca zamówienia sprzed kursora (filtr status_date nie działa) — odczyt ostatnich stron listy od końca; zmiany starszych zamówień złapie dzienny przegląd otwartych'

const NIE_SHOPER = 'adres sklepu nie odpowiada jak API Shoper (sprawdź baseUrl)'

const DICT_NAMES: Record<'platnosci' | 'dostawy' | 'waluty', { path: string; id: string }> = {
  platnosci: { path: '/payments', id: 'payment_id' },
  dostawy: { path: '/shippings', id: 'shipping_id' },
  waluty: { path: '/currencies', id: 'currency_id' },
}

/** Nazwa z `translations.<język>.title`, potem z dowolnego tłumaczenia, potem `name`. [NIEPEWNE] NIEPEWNE.jezykNazw */
function dictName(row: Record<string, unknown>, kind: keyof typeof DICT_NAMES): string | null {
  if (kind === 'waluty') return str(row['name'])
  const tr = isObj(row['translations']) ? row['translations'] : {}
  const pref = isObj(tr[NIEPEWNE.jezykNazw]) ? str((tr[NIEPEWNE.jezykNazw] as Record<string, unknown>)['title']) : null
  const any = Object.values(tr)
    .map((t) => (isObj(t) ? str(t['title']) : null))
    .find((x) => !!x)
  return kind === 'dostawy' ? (str(row['name']) ?? pref ?? any ?? null) : (pref ?? any ?? str(row['name']))
}

class ShoperAdapter implements ChannelAdapter, OrderFeed, OfferReader {
  protected readonly api: ShoperReadOnly
  protected readonly session: ShoperSession
  protected readonly strefa: string
  private readonly overlapMs: number
  private readonly perPage: number
  private statusy: Promise<Map<string, number | null>> | null = null
  private readonly slowniki = new Map<string, Promise<Map<string, string> | null>>()

  constructor(
    readonly manifest: AdapterManifest,
    protected readonly ctx: AdapterContext,
  ) {
    this.perPage = pageSizeOf(ctx.config['pageSize'])
    this.strefa = typeof ctx.config['strefa'] === 'string' && ctx.config['strefa'] ? ctx.config['strefa'] : 'Europe/Warsaw'
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: this.strefa })
    } catch {
      throw new AdapterConfigError(`Konto ${ctx.integration.id}: nieznana strefa czasowa „${this.strefa}”`)
    }
    const token = ctx.secrets['SHOPER_ACCESS_TOKEN']
    const login = ctx.secrets['SHOPER_API_LOGIN']
    const password = ctx.secrets['SHOPER_API_PASSWORD']
    let auth: ShoperAuth
    if (token) auth = { token }
    else if (login && password) auth = { login, password }
    else throw new AdapterConfigError(`Konto ${ctx.integration.id}: brak sekretu SHOPER_ACCESS_TOKEN albo pary SHOPER_API_LOGIN i SHOPER_API_PASSWORD`)
    try {
      this.session = new ShoperSession(String(ctx.config['baseUrl']), auth, ctx.fetch as FetchLike, ctx.http?.minIntervalMs ?? 500, ctx.http?.retry)
    } catch (e) {
      throw new AdapterConfigError(`Konto ${ctx.integration.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.api = new ShoperReadOnly(this.session)
    const o = Number(ctx.config['overlapMinutes'] ?? 5)
    this.overlapMs = (Number.isFinite(o) && o >= 0 ? o : 5) * 60_000
  }

  protected async list(path: string, query: Record<string, string | number>): Promise<{ rows: Record<string, unknown>[]; pages: number; count: number | null }> {
    let r
    try {
      r = await this.api.get<ListBody>(path, query)
    } catch (e) {
      throw toAdapterError(e)
    }
    // 404 na ścieżce listy: pod tym adresem nie ma API Shopera (zły baseUrl, literówka w domenie) — trwały, bez ponowień
    if (r.status === 404) throw new AdapterError(`Shoper ${path}: HTTP 404 — ${NIE_SHOPER}`, 'TRWALY')
    if (r.body === null || !Array.isArray(r.body.list)) throw new AdapterError(`Shoper ${path}: odpowiedź nie jest listą`, 'PRZEJSCIOWY')
    return { rows: (r.body.list as unknown[]).filter(isObj), pages: Math.max(1, intOrNull(r.body.pages) ?? 1), count: intOrNull(r.body.count) }
  }

  private async readPages(path: string, maxPages: number, extra: Record<string, string | number> = {}): Promise<Record<string, unknown>[] | null> {
    const out: Record<string, unknown>[] = []
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.list(path, { ...extra, limit: 50, page })
      out.push(...r.rows)
      if (page >= r.pages) return out
    }
    return null // więcej stron niż limit
  }

  /** Słownik statusów raz na instancję (po stronach). Błąd odczytu nie jest zapamiętywany. */
  protected statusMap(): Promise<Map<string, number | null>> {
    this.statusy ??= (async () => {
      const rows = await this.readPages('/statuses', MAX_STRON_SLOWNIKA)
      if (!rows) throw new AdapterError('Shoper /statuses: za dużo stron słownika statusów', 'TRWALY')
      const m = new Map<string, number | null>()
      for (const r of rows) {
        const id = str(r['status_id'])
        if (id) m.set(id, intOrNull(r['type']))
      }
      return m
    })().catch((e: unknown) => {
      this.statusy = null
      throw e
    })
    return this.statusy
  }

  /** Słownik nazw raz na instancję; błąd = null (zamówienie dostaje identyfikator i ostrzeżenie). */
  private dict(kind: keyof typeof DICT_NAMES): Promise<Map<string, string> | null> {
    let p = this.slowniki.get(kind)
    if (!p) {
      const d = DICT_NAMES[kind]
      p = this.readPages(d.path, MAX_STRON_SLOWNIKA).then(
        (rows) => {
          if (!rows) return null
          const m = new Map<string, string>()
          for (const r of rows) {
            const id = str(r[d.id])
            const n = dictName(r, kind)
            if (id && n) m.set(id, n)
          }
          return m
        },
        () => null,
      )
      this.slowniki.set(kind, p)
    }
    return p
  }

  async testConnection(): Promise<ConnectionTest> {
    // 403 = brak zakresu uprawnień tokena: komunikat mówi którego, bez treści odpowiedzi sklepu
    const check = async (path: string, what: string) => {
      try {
        const r = await this.api.get<ListBody>(path, { limit: 1 })
        if (r.status === 404) return { ok: false as const, message: `${what}: HTTP 404 — ${NIE_SHOPER}` }
        return { ok: true as const, count: intOrNull(r.body?.count) }
      } catch (e) {
        const status = e instanceof ShoperHttpError ? e.status : null
        if (status === 403) return { ok: false as const, message: `token bez uprawnienia do odczytu: ${what}` }
        if (status === 401) return { ok: false as const, message: 'token albo login i hasło odrzucone przez sklep' }
        return { ok: false as const, message: `${what}: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    try {
      const orders = await check('/orders', 'zamówienia')
      if (!orders.ok) return { ok: false, message: orders.message }
      const statuses = await check('/statuses', 'statusy zamówień')
      if (!statuses.ok) return { ok: false, message: statuses.message, details: { orders: orders.count } }
      return { ok: true, message: 'odczyt zamówień i statusów działa', details: { orders: orders.count, statuses: statuses.count } }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  private feedItem(row: Record<string, unknown>): OrderFeedItem | null {
    const id = str(row['order_id'])
    if (!id) return null // bez id nie da się ani zapisać, ani ponowić
    try {
      return { externalId: id, revision: shoperRevision(row, this.strefa) }
    } catch {
      return { externalId: id, revision: '' } // host pobierze je osobno (getOrder) i zapisze błąd elementu
    }
  }

  async listOrderChanges(cursor: string | null, opts: OrderFeedOptions): Promise<OrderFeedPage> {
    const start = new Date(this.ctx.now().getTime() - opts.initialLookbackMs).toISOString()
    let cur
    try {
      cur = cursor ? parseWooCursor(cursor) : { a: start, p: 1, m: start }
    } catch {
      throw new AdapterError('zły kursor Shoper', 'TRWALY')
    }
    const since = sinceLocal(new Date(cur.a), this.strefa)
    // najpóźniej widziana zmiana nie dalej niż „teraz”: data z pierwszego wystąpienia godziny powtarzanej jesienią
    // wraca jako godzina później (localToUtc wybiera drugie wystąpienie) i przesunęłaby kursor w przyszłość
    const nowIso = this.ctx.now().toISOString()
    const query = (page: number) => ({ limit: this.perPage, page, [NIEPEWNE.filtrZmian]: since })
    let maxSeen = cur.m
    const items = new Map<string, OrderFeedItem>()
    /** Dokłada wiersze nie starsze niż kursor; zwraca, ile było starszych (= filtr nie działa) i ile nowych. */
    const take = (rows: Record<string, unknown>[]) => {
      let older = 0
      let fresh = 0
      for (const row of rows) {
        let local: string | null = null
        try {
          local = changedLocal(row, str(row['order_id']) ?? '?')
        } catch {
          // nieczytelna data: nie wiadomo, czy starszy — przepuszczamy (getOrder rozstrzygnie)
        }
        if (local !== null && local < since) {
          older++
          continue
        }
        const it = this.feedItem(row)
        if (!it) continue
        fresh++
        const prev = items.get(it.externalId)
        if (!prev || it.revision > prev.revision) items.set(it.externalId, it)
        const iso = it.revision.split('#')[0]!
        if (iso && iso > maxSeen) maxSeen = iso < nowIso ? iso : nowIso
      }
      return { older, fresh }
    }
    const first = await this.list('/orders', query(cur.p))
    const t = take(first.rows)
    const warnings: string[] = []
    if (t.older > 0) {
      // Filtr status_date nie działa ([NIEPEWNE] NIEPEWNE.filtrZmian): czytamy od ostatniej strony wstecz (lista
      // rosnąco po order_id — [NIEPEWNE] NIEPEWNE.listaRosnaco), najwyżej MAX_STRON_WSTECZ stron, do pierwszej strony
      // bez zmian po kursorze. Zmiany starszych zamówień (np. status po tygodniu) łapie dzienny przegląd otwartych.
      warnings.push(FILTR_NIE_DZIALA)
      let read = 1 // strona z kursora już przeczytana
      for (let page = first.pages; page >= 1 && read < MAX_STRON_WSTECZ; page--) {
        if (page === cur.p) continue
        read++
        if (take((await this.list('/orders', query(page))).rows).fresh === 0) break
      }
    } else if (cur.p < first.pages && first.rows.length > 0) {
      // Strony po numerze: lista jest stała względem filtra (data zmiany statusu tylko rośnie, więc zamówienie nie
      // wypada z wyniku), nowe zamówienia dochodzą na końcu. Duble odsiewa host (ta sama rewizja = bez zmian).
      return { items: [...items.values()], nextCursor: JSON.stringify({ a: cur.a, p: cur.p + 1, m: maxSeen }), hasMore: true }
    }
    const back = new Date(Date.parse(maxSeen) - this.overlapMs).toISOString()
    const nextAfter = back > cur.a ? back : cur.a
    return { items: [...items.values()], nextCursor: JSON.stringify({ a: nextAfter, p: 1, m: maxSeen }), hasMore: false, ...(warnings.length ? { warnings } : {}) }
  }

  async getOrder(externalId: string): Promise<ChannelOrder | null> {
    if (!/^\d+$/.test(externalId)) throw new AdapterError(`zły numer zamówienia Shoper „${externalId}”`, 'TRWALY')
    let r
    try {
      r = await this.api.get<Record<string, unknown>>(`/orders/${externalId}`)
    } catch (e) {
      throw toAdapterError(e)
    }
    if (r.status === 404 || r.body === null) return null
    if (!isObj(r.body)) throw new UnreadableDataError(`zamówienie ${externalId}: odpowiedź nie jest obiektem`)
    // Pozycje po stronach; gdy filtr po order_id nie działa ([NIEPEWNE] NIEPEWNE.filtrPozycji), wiersze innych
    // zamówień są odrzucane, a odczyt ograniczony do MAX_STRON_POZYCJI stron.
    const pozycje: Record<string, unknown>[] = []
    let obce = false
    for (let page = 1; ; page++) {
      if (page > MAX_STRON_POZYCJI) {
        const powod = obce ? 'filtr order_id w /order-products nie działa' : 'za dużo stron pozycji'
        throw new AdapterError(`Shoper /order-products: ${powod} — pozycje zamówienia ${externalId} poza ${MAX_STRON_POZYCJI} stronami`, 'TRWALY')
      }
      const p = await this.list('/order-products', { limit: this.perPage, page, [NIEPEWNE.filtrPozycji]: externalId })
      for (const row of p.rows) {
        if (str(row['order_id']) === externalId) pozycje.push(row)
        else obce = true
      }
      if (page >= p.pages) break
    }
    const [statusy, platnosci, dostawy, waluty] = await Promise.all([this.statusMap(), this.dict('platnosci'), this.dict('dostawy'), this.dict('waluty')])
    const order = shoperOrderFromApi(r.body, pozycje, { statusy, platnosci, dostawy, waluty }, this.strefa)
    if (obce) order.warnings.push(FILTR_POZYCJI_NIE_DZIALA)
    return order
  }

  async listOffers(cursor: string | null): Promise<OfferPage> {
    const page = cursor === null ? 1 : Number(cursor)
    if (!Number.isInteger(page) || page < 1) throw new AdapterError('zły kursor ofert Shoper', 'TRWALY')
    const r = await this.list('/product-stocks', { limit: this.perPage, page })
    const items: ChannelOfferRow[] = r.rows.map((row) => {
      const id = str(row['stock_id'])
      if (!id) throw new UnreadableDataError('pozycja magazynowa Shoper bez stock_id')
      return {
        externalId: id,
        sku: str(row['code']),
        ean: str(row['ean']),
        name: null,
        qty: readNumber(row['stock'], `stan pozycji magazynowej ${id}`),
        active: flag(row['active'], `aktywna pozycja ${id}`),
      }
    })
    return { items, nextCursor: page < r.pages ? String(page + 1) : null }
  }
}

// ─── Zapis za wyłącznikiem ───────────────────────────────────────────────────

export const ZAPIS_WYLACZONY = 'zapis wyłączony na tym koncie'

const RANK: Record<FailureKind, number> = { PRZEJSCIOWY: 1, NIEJEDNOZNACZNY: 2, TRWALY: 3 }

interface ItemFailure {
  kind: FailureKind
  why: string
  retryAfterMs?: number
}

/** Wynik jednego PUT → błąd pozycji albo null (OK). */
function writeFailure(r: ShoperWriteResult): ItemFailure | null {
  if (r.status >= 200 && r.status < 300) return null
  if (r.status === 400 && r.warehouses) return { kind: 'TRWALY', why: 'sklep ma włączony moduł magazynów — stan zmienia się tylko w magazynach Shopera' }
  if (r.status === 429) return { kind: 'PRZEJSCIOWY', why: 'HTTP 429 (limit zapytań)', ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) }
  // Zapis bezwzględny (ustaw stan/status na wartość) — powtórzony daje ten sam skutek, więc 5xx po wysłaniu to
  // PRZEJSCIOWY, nie NIEJEDNOZNACZNY: ponowienie tą samą wartością jest bezpieczne.
  if (r.status >= 500) return { kind: 'PRZEJSCIOWY', why: `HTTP ${r.status}` }
  if (r.status === 401 || r.status === 403) return { kind: 'TRWALY', why: `HTTP ${r.status} (token bez prawa zapisu)` }
  if (r.status === 404) return { kind: 'TRWALY', why: 'HTTP 404 (nie ma w sklepie)' }
  return { kind: 'TRWALY', why: `HTTP ${r.status}` }
}

async function putOnce(w: ShoperWriter, path: string, body: Record<string, string | number>): Promise<ItemFailure | null> {
  try {
    return writeFailure(await w.put(path, body))
  } catch (e) {
    // Timeout albo zerwane połączenie po wysłaniu: nie wiadomo, czy sklep zapisał, ale zapis jest bezwzględny,
    // więc powtórka tą samą wartością jest bezpieczna — PRZEJSCIOWY (bez reference.find, Shoper nie ma referencji).
    if (e instanceof SourceError) return { kind: 'PRZEJSCIOWY', why: e.message }
    throw e
  }
}

class ShoperZapisAdapter extends ShoperAdapter implements StockWriter, OrderStatusWriter {
  private readonly writer: ShoperWriter
  private readonly zapisWlaczony: boolean

  constructor(manifest: AdapterManifest, ctx: AdapterContext) {
    super(manifest, ctx)
    this.writer = new ShoperWriter(this.session)
    this.zapisWlaczony = ctx.config['zapisWlaczony'] === true
  }

  /** Test odczytu jak w `shoper.rest.v1` plus stan wyłącznika zapisu; żadnego żądania zapisu. */
  override async testConnection(): Promise<ConnectionTest> {
    const t = await super.testConnection()
    return { ...t, details: { ...(t.details ?? {}), zapisWlaczony: this.zapisWlaczony } }
  }

  /** Paczka stanów: każda pozycja osobnym PUT, po kolei; jedna nieudana nie przerywa reszty. */
  async pushStock(items: StockWriteItem[], reference: string): Promise<WriteOutcome> {
    if (!this.zapisWlaczony) return { kind: 'TRWALY', reference, message: ZAPIS_WYLACZONY }
    const failed: { offer: string; f: ItemFailure }[] = []
    for (const it of items) {
      let f: ItemFailure | null
      if (!/^\d+$/.test(it.offerExternalId)) f = { kind: 'TRWALY', why: 'zły identyfikator pozycji magazynowej' }
      else if (!Number.isInteger(it.qty) || it.qty < 0) f = { kind: 'TRWALY', why: 'zły stan (oczekiwana liczba całkowita ≥ 0)' }
      else f = await putOnce(this.writer, `/product-stocks/${it.offerExternalId}`, { stock: it.qty })
      if (f) failed.push({ offer: it.offerExternalId, f })
    }
    if (!failed.length) return { kind: 'OK', reference }
    const worst = failed.reduce((a, b) => (RANK[b.f.kind] > RANK[a.f.kind] ? b : a)).f.kind
    const retryAfter = Math.max(0, ...failed.map((x) => x.f.retryAfterMs ?? 0))
    const offers = failed.slice(0, 20).map((x) => `${x.offer} (${x.f.why})`).join(', ')
    return {
      kind: worst,
      reference,
      message: `zapis stanu nieudany dla ${failed.length} z ${items.length} ofert: ${offers}${failed.length > 20 ? ', …' : ''}`.slice(0, 1000),
      ...(retryAfter > 0 ? { retryAfterMs: retryAfter } : {}),
    }
  }

  /**
   * Status zamówienia: odczyt, ten sam status = OK bez zapisu, inaczej PUT z samym `status_id`. Uwaga: status z
   * włączonym `email_change` może wysłać klientowi e-mail ze sklepu ([NIEPEWNE], czy także po zmianie przez API).
   */
  async setOrderStatus(orderExternalId: string, channelStatus: string, reference: string): Promise<WriteOutcome> {
    if (!this.zapisWlaczony) return { kind: 'TRWALY', reference, message: ZAPIS_WYLACZONY }
    if (!/^\d+$/.test(orderExternalId) || !/^\d+$/.test(channelStatus)) return { kind: 'TRWALY', reference, message: 'zły numer zamówienia albo statusu Shoper' }
    try {
      const r = await this.api.get<Record<string, unknown>>(`/orders/${orderExternalId}`)
      if (r.body === null || !isObj(r.body)) return { kind: 'TRWALY', reference, message: `nie ma zamówienia ${orderExternalId} w sklepie` }
      if (str(r.body['status_id']) === channelStatus) return { kind: 'OK', reference }
      if (!(await this.statusMap()).has(channelStatus)) return { kind: 'TRWALY', reference, message: `sklep nie ma statusu ${channelStatus}` }
    } catch (e) {
      const a = toAdapterError(e)
      if (a instanceof AdapterError) return { kind: a.kind, reference, message: a.message, ...(a.retryAfterMs ? { retryAfterMs: a.retryAfterMs } : {}) }
      throw e
    }
    const f = await putOnce(this.writer, `/orders/${orderExternalId}`, { status_id: channelStatus })
    if (!f) return { kind: 'OK', reference }
    return { kind: f.kind, reference, message: `zmiana statusu zamówienia ${orderExternalId} nieudana: ${f.why}`, ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}) }
  }
}

export const SHOPER_DEFINITION: AdapterDefinition = { manifest: SHOPER_MANIFEST, create: (ctx) => new ShoperAdapter(SHOPER_MANIFEST, ctx) }
export const SHOPER_ZAPIS_DEFINITION: AdapterDefinition = { manifest: SHOPER_ZAPIS_MANIFEST, create: (ctx) => new ShoperZapisAdapter(SHOPER_ZAPIS_MANIFEST, ctx) }
