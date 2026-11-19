// Allegro z zapisem ZA WYŁĄCZNIKIEM: stany ofert, status realizacji zamówienia i numer nadania.
// Klucz `allegro.zapis.v1` (host bierze go przez `kluczZZapisem` z `allegro.v1`); odczyt dziedziczony 1:1 z `allegro.v1`,
// ta sama para tokenów i ta sama rotacja. Zapis wymaga trzech niezależnych warunków: konto ma ten klucz, ma
// `zapisWlaczony: true` i host wywoła zapis (tryb PRACA danego rodzaju, lib/kanaly/zapis-host.ts). Bez wyłącznika każda
// metoda zapisu zwraca TRWALY i nie wysyła żadnego żądania.
//
// Stany: `PUT /sale/offer-quantity-change-commands/{commandId}` (stan bezwzględny FIXED). Jedna komenda = jedna wartość,
// więc paczka dzieli się na komendy po ilości (do 1000 ofert w komendzie). `commandId` jest deterministyczny z referencji
// hosta, ilości i numeru części: powtórka tej samej paczki nie zakłada drugiej komendy (Allegro odpowiada, że komenda
// istnieje, a adapter czyta jej wynik). Wynik komendy z `GET .../{commandId}` i `.../tasks`: oferty z błędem idą do
// `failedItems` (kontrakt), pozostałe są zapisane. Komenda jeszcze w toku po odpytywaniu = te oferty PRZEJSCIOWY.
//
// Status realizacji: świeży odczyt, potem `PUT /order/checkout-forms/{id}/fulfillment`; „już ustawione” = OK bez zapisu.
// Numer nadania: `POST /order/checkout-forms/{id}/shipments` dopiero po odczycie `GET .../shipments`: numer już w zamówieniu
// (także dopisany przez Wysyłam z Allegro) = OK bez drugiego wpisu. Brak odpowiedzi przy zapisie = świeży odczyt, nigdy
// ślepe ponowienie.
//
// Zakresy aplikacji (jedno źródło: lib/zrodla/allegro-zakresy.ts): „Stany ofert” (`sale:offers:write`),
// „Status i numer nadania” (`orders:write`). HTTP 403 = komunikat z nazwą funkcji do dodania w autoryzacji konta.
// Bez danych klientów: w wynikach, alertach i logach tylko numery formularzy, ofert, statusy i numery nadania.
import { deriveReference } from './rejestr'
import { ALLEGRO_API_URL, type AllegroResponse } from '../zrodla/allegro'
import { etykietaFunkcji } from '../zrodla/allegro-zakresy'
import { AllegroWriter, type AllegroWriteResult, kodyBledowAllegro, sciezkaBezId } from '../zrodla/allegro-zapis'
import { type FetchLike, ReadOnlyViolation, SourceError, Throttle } from '../zrodla/http'
import { ALLEGRO_MANIFEST, AllegroAccountError, AllegroAdapter, AllegroTokens } from './allegro'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelBehavior,
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

export const ALLEGRO_ZAPIS_KEY = 'allegro.zapis.v1'
export const ZAPIS_WYLACZONY = 'zapis wyłączony na tym koncie Allegro'
/** Nazwy funkcji z autoryzacji konta (FUNKCJE_ALLEGRO) do komunikatów o brakującym zakresie. */
export const FUNKCJA_STANY = etykietaFunkcji('zapisStanow')
export const FUNKCJA_ZAMOWIENIA = etykietaFunkcji('zapisZamowien')
const PONOW_AUTORYZACJE = 'połącz konto z Allegro ponownie z zaznaczoną funkcją'

/** Statusy realizacji Allegro, które Kompletor ustawia (RETURNED ustawia Allegro po zwrocie). */
export const ALLEGRO_FULFILLMENT_STATUSES = [
  { id: 'NEW', label: 'Nowe' },
  { id: 'PROCESSING', label: 'W realizacji' },
  { id: 'READY_FOR_SHIPMENT', label: 'Do wysłania' },
  { id: 'READY_FOR_PICKUP', label: 'Do odbioru' },
  { id: 'SENT', label: 'Wysłane' },
  { id: 'PICKED_UP', label: 'Odebrane' },
  { id: 'SUSPENDED', label: 'Wstrzymane' },
  { id: 'CANCELLED', label: 'Anulowane' },
] as const
const FULFILLMENT_IDS = new Set<string>(ALLEGRO_FULFILLMENT_STATUSES.map((s) => s.id))

export const ALLEGRO_BEHAVIOR: ChannelBehavior = {
  // Allegro zdejmuje stan oferty przy zakupie
  stockModel: 'self-decrementing',
  unpaidGuard: true,
  channelStatuses: ALLEGRO_FULFILLMENT_STATUSES,
  defaultStatusMap: {
    ZBIERANIE: 'PROCESSING',
    DO_WYSLANIA: 'READY_FOR_SHIPMENT',
    DO_ODBIORU: 'READY_FOR_PICKUP',
    WYSLANE: 'SENT',
    ODEBRANE: 'PICKED_UP',
    ANULOWANE: 'CANCELLED',
    ANULOWANE_NIEOPLACONE: 'CANCELLED',
  },
}

/**
 * Przewoźnik Kompletora → `carrierId` z listy Allegro (`GET /order/carriers`). ALLEGRO (Wysyłam z Allegro) nie ma
 * wpisu: numer takiej przesyłki dopisuje do zamówienia samo Allegro, adapter tylko to sprawdza.
 */
export const ALLEGRO_CARRIER_IDS: Readonly<Record<string, string>> = { PACZKOMATY: 'INPOST', INPOST_KURIER: 'INPOST', DPD: 'DPD', DPD_EMPIK: 'DPD' }

/** Id cennika dostaw, zwrotów i reklamacji w Allegro (UUID albo liczba). */
export const ID_WARUNKOW_RE = /^[0-9A-Za-z-]{1,64}$/

export const ALLEGRO_ZAPIS_MANIFEST: AdapterManifest = {
  ...ALLEGRO_MANIFEST,
  adapterKey: ALLEGRO_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'Allegro (REST, z zapisem stanów, statusów i numerów nadania za wyłącznikiem)',
  capabilities: ['orders.feed', 'orders.recipient', 'offers.read', 'returns.read', 'offers.prepare', 'stock.write', 'order.status.write', 'order.tracking.write', 'reference.find', 'offers.publish'],
  // wystawianie ofert z osobnym limitem (jedna oferta naraz), żeby masowe wystawienie nie zjadło limitu stanów
  rateLimit: { ...ALLEGRO_MANIFEST.rateLimit, perCapability: { 'offers.publish': { requestsPerMinute: 60, maxConcurrent: 1 } } },
  config: [
    ...ALLEGRO_MANIFEST.config,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik: tak = Kompletor wysyła do Allegro stany ofert, status realizacji i numery nadania; brak = nic nie wysyła' },
    {
      key: 'kodyPrzewoznikow',
      type: 'string',
      required: false,
      description: 'własne kody przewoźników z listy Allegro jako JSON, np. {"DPD":"DPD","INPOST_KURIER":"INPOST"}; przewoźnik bez kodu idzie jako „inny” z nazwą',
      pattern: /^\{[\s\S]{0,1000}\}$/,
    },
    // wystawianie ofert (osobny wyłącznik) i warunki konta wymagane przez Allegro przy nowej ofercie
    POLE_WYSTAWIANIA_OFERT,
    { key: 'cennikDostawId', type: 'string', required: false, description: 'cennik dostaw z konta Allegro (Moje Allegro → Sprzedaż → Cenniki dostawy), wymagany przy wystawianiu ofert', pattern: ID_WARUNKOW_RE },
    { key: 'zwrotyId', type: 'string', required: false, description: 'warunki zwrotów z konta Allegro (Warunki oferty → Zwroty)', pattern: ID_WARUNKOW_RE },
    { key: 'reklamacjeId', type: 'string', required: false, description: 'warunki reklamacji z konta Allegro (Warunki oferty → Reklamacje)', pattern: ID_WARUNKOW_RE },
  ],
  readOnly: false,
  channelBehavior: ALLEGRO_BEHAVIOR,
}

/** Id formularza: w Allegro UUID; bezpieczny znakowo identyfikator dopuszczony (atrapy, sandbox). */
const FORM_RE = /^[A-Za-z0-9-]{1,64}$/
const OFFER_RE = /^\d{1,20}$/
const TRACKING_RE = /^[A-Za-z0-9-]{4,64}$/
/** Ofert w jednej komendzie stanów (limit Allegro). */
export const OFFERS_PER_COMMAND = 1000
/** Odpytań wyniku komendy stanów po jej wysłaniu (domyślnie co 2 s, `ctx.http.pollDelayMs`). */
export const STOCK_POLLS = 4
const CARRIER_NAME: Record<string, string> = { PACZKOMATY: 'InPost', INPOST_KURIER: 'InPost', DPD: 'DPD', DPD_EMPIK: 'DPD', ALLEGRO: 'Allegro', OSOBISTY: 'Odbiór osobisty' }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
export const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve())
const codes = (r: AllegroWriteResult) => {
  const c = kodyBledowAllegro(r.body)
  return c.length ? ` (${c.join(', ')})` : ''
}

/** Kody przewoźników z konfiguracji (JSON); zły JSON = brak własnych kodów. */
export function kodyPrzewoznikowAllegro(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string') return {}
  try {
    const v = JSON.parse(raw) as unknown
    const out: Record<string, string> = {}
    for (const [k, c] of Object.entries(obj(v))) if (typeof c === 'string' && /^[A-Z0-9_]{1,40}$/.test(c)) out[k] = c
    return out
  } catch {
    return {}
  }
}

/** Wynik zapisu z HTTP: 429 i 5xx PRZEJSCIOWY (adapter wcześniej sprawdził, czy powtórka jest bezpieczna), reszta TRWALY. */
export function allegroWriteFailure(r: AllegroWriteResult, reference: string, what: string, funkcja: string): WriteOutcome {
  if (r.status === 429) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP 429 (limit zapytań)`, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) }
  if (r.status >= 500) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP ${r.status}${codes(r)}` }
  if (r.status === 401) return { kind: 'TRWALY', reference, message: `${what}: HTTP 401 także po odświeżeniu tokena — ${PONOW_AUTORYZACJE}` }
  if (r.status === 403) return { kind: 'TRWALY', reference, message: `${what}: HTTP 403 — konto nie ma zgody na funkcję „${funkcja}”: ${PONOW_AUTORYZACJE}` }
  return { kind: 'TRWALY', reference, message: `${what}: HTTP ${r.status}${codes(r)}` }
}

/**
 * Zapis z tokenem konta: 401 → jedno odświeżenie i jedna powtórka (401 = Allegro nie przyjęło żądania, powtórka
 * bezpieczna). Brak odpowiedzi = SourceError do wołającego.
 */
export async function writeWithToken(
  writer: AllegroWriter,
  tokens: AllegroTokens,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body: unknown,
  o: { binary?: boolean; query?: Record<string, string>; timeoutMs?: number } = {},
): Promise<AllegroWriteResult> {
  const { token, refreshed } = await tokens.current()
  const r = await writer.send(method, path, body, token, o)
  if (r.status === 401 && !refreshed) return writer.send(method, path, body, await tokens.afterUnauthorized(token), o)
  return r
}

/** Błąd konta (token, ponowna autoryzacja) albo odczytu jako wynik zapisu; inne wyjątki dalej do `executeWrite`. */
export function asOutcome(e: unknown, reference: string, what: string): WriteOutcome {
  if (e instanceof AllegroAccountError) return { kind: 'TRWALY', reference, message: `${what}: ${e.message}` }
  if (e instanceof AdapterError) return { kind: e.kind, reference, message: `${what}: ${e.message}`, ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}) }
  if (e instanceof SourceError) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: ${e.message}` }
  throw e
}

const worse = (a: FailureKind, b: FailureKind): FailureKind => (a === 'TRWALY' || b === 'TRWALY' ? 'TRWALY' : a === 'NIEJEDNOZNACZNY' || b === 'NIEJEDNOZNACZNY' ? 'NIEJEDNOZNACZNY' : 'PRZEJSCIOWY')

interface StockCommand {
  commandId: string
  qty: number
  offers: string[]
}

/** Paczka stanów → komendy: po ilości, oferty posortowane, do 1000 w komendzie; `commandId` z referencji (deterministyczny). */
export function stockCommands(items: readonly StockWriteItem[], reference: string): StockCommand[] {
  const byQty = new Map<number, Set<string>>()
  for (const it of items) {
    const s = byQty.get(it.qty) ?? new Set<string>()
    s.add(it.offerExternalId)
    byQty.set(it.qty, s)
  }
  const out: StockCommand[] = []
  for (const qty of [...byQty.keys()].sort((a, b) => a - b)) {
    const offers = [...byQty.get(qty)!].sort()
    for (let i = 0; i * OFFERS_PER_COMMAND < offers.length; i++)
      out.push({ commandId: deriveReference([reference, 'allegro-stany', qty, i]), qty, offers: offers.slice(i * OFFERS_PER_COMMAND, (i + 1) * OFFERS_PER_COMMAND) })
  }
  return out
}

type CommandState = { kind: 'DONE'; failed: Map<string, string> } | { kind: 'PENDING' } | { kind: 'MISSING' }

export class AllegroZapisAdapter extends AllegroAdapter implements StockWriter, OrderStatusWriter, TrackingWriter, ReferenceFinder {
  private writerInstance: AllegroWriter | null = null
  /** Komendy stanów wysłane pod referencją (odszukanie po referencji tego samego przebiegu). */
  // pamięć jednego przebiegu (instancji adaptera). Wyjątek poza adapterem (`executeWrite` →
  // NIEJEDNOZNACZNY) w kolejnym przebiegu trafia na nową instancję, która tej referencji nie zna: odszukanie rzuca
  // NIEJEDNOZNACZNY i sprawa idzie do człowieka („Wypchnij teraz”). Świadomie bez odtwarzania commandId z treści paczki.
  private readonly sent = new Map<string, { commandId: string; offers: number }[]>()

  constructor(ctx: AdapterContext, manifest: AdapterManifest = ALLEGRO_ZAPIS_MANIFEST) {
    super(ctx, manifest)
  }

  private get enabled(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  private get pollDelayMs(): number {
    return this.ctx.http?.pollDelayMs ?? 2_000
  }

  /** Tworzony dopiero przy pierwszym zapisie i tylko przy włączonym wyłączniku. */
  private get writer(): AllegroWriter {
    this.writerInstance ??= new AllegroWriter(String(this.ctx.config['apiUrl'] ?? ALLEGRO_API_URL), String(this.ctx.config['userAgent']), this.ctx.fetch as FetchLike, new Throttle(this.ctx.http?.minIntervalMs ?? 100))
    return this.writerInstance
  }

  private off(reference: string): WriteOutcome {
    return { kind: 'TRWALY', reference, message: ZAPIS_WYLACZONY }
  }

  private write(method: 'GET' | 'PUT' | 'POST', path: string, body: unknown, query?: Record<string, string>): Promise<AllegroWriteResult> {
    return writeWithToken(this.writer, this.tokens, method, path, body, query ? { query } : {})
  }

  // ─── Wystawianie ofert ─────────────────────────────────────────

  /**
   * Jedno żądanie `POST /sale/product-offers` (transport `wyslij` dla lib/oferty/wystawianie.ts). Tylko przy włączonym
   * `wystawianieOfertWlaczone` (niezależnie od `zapisWlaczony`); bez niego wyjątek przed jakimkolwiek żądaniem.
   * Brak odpowiedzi = wyjątek (wołający traktuje to jak NIEJEDNOZNACZNY).
   */
  async zapisOfert(metoda: 'POST', sciezka: string, cialo: unknown, query?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null }> {
    if (!wystawianieOfertWlaczone(this.ctx.config)) throw new ReadOnlyViolation(WYSTAWIANIE_WYLACZONE)
    if (metoda !== 'POST' || sciezka !== '/sale/product-offers' || (query && Object.keys(query).length)) throw new ReadOnlyViolation('Allegro: wystawianie tylko przez POST /sale/product-offers')
    const r = await this.write('POST', sciezka, cialo)
    return { status: r.status, body: r.body }
  }

  // ─── Stany ───────────────────────────────────────────────────────────────

  async pushStock(items: StockWriteItem[], reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return this.off(reference)
    if (!items.length) return { kind: 'OK', reference }
    const bad = items.filter((it) => !OFFER_RE.test(it.offerExternalId) || !Number.isInteger(it.qty) || it.qty < 0)
    const good = items.filter((it) => !bad.includes(it))
    const failed: FailedWriteItem[] = bad.map((b) => ({ offerExternalId: b.offerExternalId, kind: 'TRWALY', message: 'zła pozycja stanu (numer oferty Allegro albo ilość)' }))
    const cmds = stockCommands(good, reference)
    this.sent.set(
      reference,
      cmds.map((c) => ({ commandId: c.commandId, offers: c.offers.length })),
    )
    const pending: StockCommand[] = []
    for (const c of cmds) {
      const what = `stany Allegro (komenda ${c.commandId.slice(0, 8)}, ${c.offers.length} ofert)`
      let r: AllegroWriteResult
      try {
        r = await this.write('PUT', `/sale/offer-quantity-change-commands/${c.commandId}`, {
          modification: { changeType: 'FIXED', value: c.qty },
          offerCriteria: [{ type: 'CONTAINS_OFFERS', offers: c.offers.map((id) => ({ id })) }],
        })
      } catch (e) {
        // brak odpowiedzi: ten sam commandId przy powtórce nie założy drugiej komendy (stan bezwzględny)
        const o = asOutcome(e, reference, what)
        if (o.kind === 'OK') continue
        for (const id of c.offers) failed.push({ offerExternalId: id, kind: o.kind, message: o.message })
        continue
      }
      // 409 = komenda o tym commandId już istnieje (powtórka): jej wynik czytamy jak nowej
      // NIEPEWNE: kod odpowiedzi Allegro przy powtórnym PUT tego samego commandId (409 albo 201) do potwierdzenia na sandboxie
      if ((r.status >= 200 && r.status < 300) || r.status === 409) {
        pending.push(c)
        continue
      }
      // powtórny PUT istniejącej komendy może wrócić 400/422 zamiast 409; komenda, którą Allegro zna,
      // już się wykonuje (ten sam commandId = ta sama treść), więc czytamy jej wynik zamiast oznaczać oferty jako TRWALY
      if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 429) {
        let znana = false
        try {
          znana = (await this.commandState(c.commandId, c.offers.length)).kind !== 'MISSING'
        } catch {
          znana = false
        }
        if (znana) {
          pending.push(c)
          continue
        }
      }
      const o = allegroWriteFailure(r, reference, what, FUNKCJA_STANY)
      if (o.kind !== 'OK') for (const id of c.offers) failed.push({ offerExternalId: id, kind: o.kind, message: o.message })
    }
    // odpytywanie wyniku komend (przetwarzanie asynchroniczne)
    let left = pending
    for (let i = 0; i < STOCK_POLLS && left.length; i++) {
      await sleep(this.pollDelayMs)
      const next: StockCommand[] = []
      for (const c of left) {
        let st: CommandState
        try {
          st = await this.commandState(c.commandId, c.offers.length)
        } catch {
          next.push(c) // błąd odczytu wyniku: spróbujemy przy kolejnym odpytaniu
          continue
        }
        if (st.kind === 'PENDING') next.push(c)
        else if (st.kind === 'MISSING') for (const id of c.offers) failed.push({ offerExternalId: id, kind: 'PRZEJSCIOWY', message: 'Allegro nie zna komendy stanów: do ponowienia' })
        else for (const [id, m] of st.failed) if (c.offers.includes(id)) failed.push({ offerExternalId: id, kind: 'TRWALY', message: `Allegro odrzuciło stan oferty${m ? `: ${m}` : ''}` })
      }
      left = next
    }
    for (const c of left) for (const id of c.offers) failed.push({ offerExternalId: id, kind: 'PRZEJSCIOWY', message: 'Allegro jeszcze przetwarza komendę stanów: wynik przy ponowieniu' })
    const ref = cmds.length ? `QTY:${cmds.length}` : undefined
    if (!failed.length) return { kind: 'OK', reference, ...(ref ? { externalRef: ref } : {}) }
    const kind = failed.reduce<FailureKind>((k, f) => worse(k, f.kind), 'PRZEJSCIOWY')
    return {
      kind,
      reference,
      message: `${failed.length} z ${items.length} pozycji nieudanych: ${[...new Set(failed.map((f) => f.message))].slice(0, 3).join('; ')}`,
      failedItems: failed,
    }
  }

  /**
   * Wynik komendy stanów: skończona (z ofertami z błędem), w toku albo nieznana Allegro (404). `expected` = liczba ofert
   * w komendzie: `taskCount.total` mniejsze (także 0 tuż po PUT, zanim Allegro policzy zadania) = w toku.
   */
  private async commandState(commandId: string, expected: number): Promise<CommandState> {
    const r = await this.write('GET', `/sale/offer-quantity-change-commands/${commandId}`, undefined)
    if (r.status === 404) return { kind: 'MISSING' }
    if (r.status < 200 || r.status >= 300 || !r.body) throw new AdapterError(`wynik komendy stanów Allegro: HTTP ${r.status}`, r.status === 429 || r.status >= 500 ? 'PRZEJSCIOWY' : 'TRWALY')
    const tc = obj(r.body['taskCount'])
    const total = num(tc['total'])
    const success = num(tc['success']) ?? 0
    const failedN = num(tc['failed']) ?? 0
    if (total === null || total < expected || total === 0 || success + failedN < total) return { kind: 'PENDING' }
    const failed = new Map<string, string>()
    if (failedN > 0) {
      for (let offset = 0; offset < total; offset += 1000) {
        const t = await this.write('GET', `/sale/offer-quantity-change-commands/${commandId}/tasks`, undefined, { limit: '1000', offset: String(offset) })
        if (t.status < 200 || t.status >= 300 || !t.body) throw new AdapterError(`zadania komendy stanów Allegro: HTTP ${t.status}`, 'PRZEJSCIOWY')
        const tasks = Array.isArray(t.body['tasks']) ? (t.body['tasks'] as unknown[]) : []
        for (const x of tasks) {
          const task = obj(x)
          const status = str(task['status'])
          const id = str(obj(task['offer'])['id'])
          // komunikat Allegro o ofercie (bez danych klientów), skrócony
          if (id && status && status !== 'SUCCESS' && status !== 'NEW') failed.set(id, (str(task['message']) ?? status).slice(0, 200))
        }
        if (tasks.length < 1000) break
      }
    }
    return { kind: 'DONE', failed }
  }

  /** Odszukanie po referencji: komendy stanów tej referencji istnieją w Allegro (wysłane w tym przebiegu). */
  async findByReference(reference: string): Promise<ReferenceLookup> {
    const ids = this.sent.get(reference)
    if (!ids) throw new AdapterError('Allegro: nieznana referencja zapisu (odszukanie działa dla komend stanów tego przebiegu)', 'NIEJEDNOZNACZNY')
    for (const c of ids) {
      const st = await this.commandState(c.commandId, c.offers)
      if (st.kind === 'MISSING') return { found: false }
    }
    return { found: true, externalRef: `QTY:${ids.length}` }
  }

  // ─── Status realizacji ───────────────────────────────────────────────────

  /** Świeży odczyt zamówienia: status realizacji i płatność; null = formularza nie ma w Allegro. */
  private async fresh(orderExternalId: string): Promise<{ fulfillment: string | null; paid: boolean; status: string } | null> {
    const o = await this.getOrder(orderExternalId)
    if (!o) return null
    const [status, fulfillment] = o.channelStatus.split('/')
    return { fulfillment: fulfillment ?? null, paid: o.paymentState === 'PAID', status: status ?? '' }
  }

  async setOrderStatus(orderExternalId: string, channelStatus: string, reference: string, guard?: StatusWriteGuard): Promise<WriteOutcome> {
    if (!this.enabled) return this.off(reference)
    if (!FORM_RE.test(orderExternalId)) return { kind: 'TRWALY', reference, message: 'zły numer formularza Allegro' }
    if (!FULFILLMENT_IDS.has(channelStatus)) return { kind: 'TRWALY', reference, message: `Allegro: status realizacji spoza listy („${channelStatus.slice(0, 40)}”)` }
    const what = `status realizacji ${channelStatus} zamówienia ${orderExternalId}`
    try {
      // świeży odczyt przed zapisem: „już ustawione” bez drugiego PUT, warunek płatności, formularz istnieje
      const f0 = await this.fresh(orderExternalId)
      if (!f0) return { kind: 'TRWALY', reference, message: `${what}: formularza nie ma w Allegro` }
      if (guard?.onlyIfUnpaid && f0.paid) return { kind: 'TRWALY', reference, message: `${what}: Allegro widzi płatność, status bez zmian` }
      if (f0.fulfillment === channelStatus) return { kind: 'OK', reference, externalRef: 'JUZ_USTAWIONE' }
      let r: AllegroWriteResult
      try {
        r = await this.write('PUT', `/order/checkout-forms/${orderExternalId}/fulfillment`, { status: channelStatus })
      } catch (e) {
        if (!(e instanceof SourceError)) throw e
        // brak odpowiedzi: świeży odczyt rozstrzyga; PUT tego samego statusu jest bezpieczny do powtórki
        const f = await this.fresh(orderExternalId)
        if (f?.fulfillment === channelStatus) return { kind: 'OK', reference }
        return { kind: 'PRZEJSCIOWY', reference, message: `${what}: brak odpowiedzi Allegro` }
      }
      if (r.status >= 200 && r.status < 300) return { kind: 'OK', reference }
      if (r.status === 404) return { kind: 'TRWALY', reference, message: `${what}: formularza nie ma w Allegro` }
      if (r.status === 409 || r.status === 422 || r.status === 400) {
        // już ustawione albo przejście, którego Allegro nie przyjmuje: rozstrzyga świeży odczyt
        const f = await this.fresh(orderExternalId)
        if (f?.fulfillment === channelStatus) return { kind: 'OK', reference, externalRef: 'JUZ_USTAWIONE' }
        return { kind: 'TRWALY', reference, message: `${what}: Allegro odmówiło (HTTP ${r.status}${codes(r)}), status w Allegro: ${f?.fulfillment ?? 'nieznany'}` }
      }
      return allegroWriteFailure(r, reference, what, FUNKCJA_ZAMOWIENIA)
    } catch (e) {
      return asOutcome(e, reference, what)
    }
  }

  // ─── Numer nadania ───────────────────────────────────────────────────────

  /** Numery nadania już w zamówieniu (wielkie litery, bez spacji). */
  private async waybills(orderExternalId: string): Promise<Set<string> | null> {
    const path = `/order/checkout-forms/${orderExternalId}/shipments`
    const r: AllegroResponse<{ shipments?: unknown }> = await this.call(path, [])
    if (r.status === 404) return null
    const b = this.expectBody(r, sciezkaBezId(path))
    const list = Array.isArray(b.shipments) ? (b.shipments as unknown[]) : []
    return new Set(list.map((s) => str(obj(s)['waybill'])?.replace(/\s+/g, '').toUpperCase()).filter((x): x is string => !!x))
  }

  async setTracking(orderExternalId: string, tracking: TrackingInfo, reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return this.off(reference)
    if (!FORM_RE.test(orderExternalId)) return { kind: 'TRWALY', reference, message: 'zły numer formularza Allegro' }
    const number = tracking.number?.trim() ?? ''
    if (!TRACKING_RE.test(number)) return { kind: 'TRWALY', reference, message: `zamówienie ${orderExternalId}: zły numer nadania` }
    const what = `numer nadania zamówienia ${orderExternalId}`
    const key = number.toUpperCase()
    try {
      const before = await this.waybills(orderExternalId)
      if (!before) return { kind: 'TRWALY', reference, message: `${what}: formularza nie ma w Allegro` }
      if (before.has(key)) return { kind: 'OK', reference, externalRef: 'JUZ_USTAWIONE' }
      if (tracking.carrier === 'ALLEGRO')
        // Wysyłam z Allegro: numer dopisuje Allegro samo po utworzeniu przesyłki; czekamy, zamiast dublować wpis
        return { kind: 'PRZEJSCIOWY', reference, message: `${what}: Allegro jeszcze nie dopisało numeru przesyłki Wysyłam z Allegro`, retryAfterMs: 120_000 }
      const own = kodyPrzewoznikowAllegro(this.ctx.config['kodyPrzewoznikow'])
      const carrierId = own[tracking.carrier] ?? ALLEGRO_CARRIER_IDS[tracking.carrier] ?? 'OTHER'
      const form = this.expectBody(await this.call<{ lineItems?: unknown }>(`/order/checkout-forms/${orderExternalId}`, []), '/order/checkout-forms/{id}')
      const lineItems = (Array.isArray(form.lineItems) ? (form.lineItems as unknown[]) : []).map((l) => str(obj(l)['id'])).filter((x): x is string => !!x)
      if (!lineItems.length) return { kind: 'TRWALY', reference, message: `${what}: formularz bez pozycji` }
      const body: Record<string, unknown> = {
        carrierId,
        waybill: number,
        lineItems: lineItems.map((id) => ({ id })),
        ...(carrierId === 'OTHER' ? { carrierName: CARRIER_NAME[tracking.carrier] ?? (tracking.carrier && tracking.carrier !== 'BRAK' ? tracking.carrier.slice(0, 30) : 'Przewoźnik') } : {}),
      }
      let r: AllegroWriteResult
      try {
        r = await this.write('POST', `/order/checkout-forms/${orderExternalId}/shipments`, body)
      } catch (e) {
        if (!(e instanceof SourceError)) throw e
        // brak odpowiedzi: numer w zamówieniu = zapisane; brak = bezpiecznie ponowić (przed POST znowu sprawdzimy)
        const after = await this.waybills(orderExternalId)
        if (after?.has(key)) return { kind: 'OK', reference }
        return { kind: 'PRZEJSCIOWY', reference, message: `${what}: brak odpowiedzi Allegro` }
      }
      if (r.status >= 200 && r.status < 300) {
        const id = str(r.body?.['id'])
        return { kind: 'OK', reference, ...(id ? { externalRef: id } : {}) }
      }
      if (r.status >= 500) {
        const after = await this.waybills(orderExternalId)
        if (after?.has(key)) return { kind: 'OK', reference }
      }
      return allegroWriteFailure(r, reference, what, FUNKCJA_ZAMOWIENIA)
    } catch (e) {
      return asOutcome(e, reference, what)
    }
  }
}

export const ALLEGRO_ZAPIS_DEFINITION: AdapterDefinition = { manifest: ALLEGRO_ZAPIS_MANIFEST, create: (ctx) => new AllegroZapisAdapter(ctx) }
