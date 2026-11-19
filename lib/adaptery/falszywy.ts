// Fałszywy adapter (kontrakt pkt 6): kanał w pamięci do testów hosta, demo self-hostu i suity kontraktowej.
// Zachowuje się jak prawdziwy kanał: kursor po rewizjach, strony, pełne zamówienie z getOrder, zapis stanu pod
// referencją z wstrzykiwanymi awariami (przejściowa, trwała, niejednoznaczna z wykonaniem albo bez).
// Z `recipient: true` ma też odbiorcę na żądanie (`orders.recipient`): dane wyłącznie fikcyjne z testu.
import type { Channel } from '@prisma/client'
import {
  AdapterError,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ChannelOrder,
  type ConnectionTest,
  type OrderFeed,
  type OrderFeedOptions,
  type OrderFeedPage,
  type OrderRecipient,
  type OrderStatusWriter,
  type RecipientReader,
  type ReferenceFinder,
  type ReferenceLookup,
  type StockWriteItem,
  type StatusWriteGuard,
  type StockWriter,
  type TrackingInfo,
  type TrackingWriter,
  UnreadableDataError,
  type WriteOutcome,
} from './kontrakt'

export type FakeWriteFailure = 'PRZEJSCIOWY' | 'TRWALY' | 'NIEJEDNOZNACZNY_WYKONANY' | 'NIEJEDNOZNACZNY_NIEWYKONANY' | 'WYJATEK'
/** `UWIERZYTELNIENIE` = TRWALY z klasą błędu uwierzytelnienia (klucz odrzucony), liczy się do wyłączenia konta. */
export type FakeWriteFailureZ = FakeWriteFailure | 'UWIERZYTELNIENIE'

/** Stan kanału w pamięci, współdzielony przez instancje adaptera (jak prawdziwe API). */
export class FakeChannelState {
  readonly orders = new Map<string, ChannelOrder>()
  /** Kolejność zmian: (seq, externalId) — kursor to ostatni widziany seq. */
  private log: { seq: number; externalId: string }[] = []
  private seq = 0
  readonly stock = new Map<string, number>()
  readonly appliedReferences = new Set<string>()
  /** Zamówienia „nieczytelne”: lista zwraca je bez treści, getOrder rzuca UnreadableDataError. */
  readonly corrupted = new Set<string>()
  writeFailures: FakeWriteFailureZ[] = []
  listFailures: AdapterError[] = []
  getFailures: AdapterError[] = []
  connectionOk = true
  pageSize = 2
  /** Odbiorcy zamówień (fikcyjni, wpisuje test); brak = AdapterError TRWALY jak w kanale. */
  readonly recipients = new Map<string, OrderRecipient>()
  /** Zamówienia z nieczytelnym odbiorcą: getOrderRecipient rzuca UnreadableDataError bez treści. */
  readonly corruptedRecipients = new Set<string>()
  recipientFailures: AdapterError[] = []
  /** Ile razy host zapytał o odbiorcę (test bramki: konto w cieniu = 0). */
  recipientCalls = 0
  /** status zamówień w kanale (setOrderStatus), numery nadania (setTracking), dziennik wywołań zapisu. */
  readonly statuses = new Map<string, string>()
  readonly trackings = new Map<string, TrackingInfo[]>()
  /** Zamówienia opłacone w kanale (anulowanie nieopłaconego ma odmówić). */
  readonly paid = new Set<string>()
  readonly writeCalls: { op: 'stock' | 'status' | 'tracking'; reference: string; target: string }[] = []

  /** Dodaje albo zmienia zamówienie (nowa rewizja trafia na koniec dziennika). */
  upsertOrder(o: ChannelOrder): void {
    this.orders.set(o.externalId, structuredClone(o))
    this.log = this.log.filter((x) => x.externalId !== o.externalId)
    this.log.push({ seq: ++this.seq, externalId: o.externalId })
  }

  changesAfter(seq: number): { seq: number; externalId: string }[] {
    return this.log.filter((x) => x.seq > seq)
  }
}

export interface FakeOptions {
  readOnly?: boolean
  /** Zdolność `orders.recipient` (odbiorca z `FakeChannelState.recipients`). */
  recipient?: boolean
  /** false = kanał bez bezpiecznego anulowania nieopłaconego (host daje alert zamiast zapisu). Domyślnie true. */
  unpaidGuard?: boolean
}

export function fakeManifest(channel: Channel = 'WOO', adapterKey = 'fake.v1', opts: FakeOptions = {}): AdapterManifest {
  const readOnly = opts.readOnly ?? false
  return {
    adapterKey,
    version: '1.0.0',
    displayName: 'Fałszywy kanał (testy, demo)',
    kind: 'channel',
    channel,
    capabilities: [
      ...(readOnly ? (['orders.feed'] as const) : (['orders.feed', 'stock.write', 'reference.find', 'order.status.write', 'order.tracking.write'] as const)),
      ...(opts.recipient ? (['orders.recipient'] as const) : []),
    ],
    rateLimit: { requestsPerMinute: 6000, maxConcurrent: 4, minPollIntervalMs: 0 },
    config: [
      { key: 'label', type: 'string', required: false, description: 'nazwa do raportu' },
      ...(readOnly ? [] : [{ key: 'zapisWlaczony', type: 'boolean' as const, required: false, description: 'wyłącznik zapisu (host sprawdza)' }]),
    ],
    secrets: [{ name: 'FAKE_TOKEN', required: false, description: 'udawany klucz' }],
    readOnly,
    channelBehavior: {
      stockModel: 'self-decrementing',
      unpaidGuard: opts.unpaidGuard ?? true,
      channelStatuses: [
        { id: 'processing', label: 'W realizacji' },
        { id: 'completed', label: 'Zrealizowane' },
        { id: 'cancelled', label: 'Anulowane' },
      ],
      defaultStatusMap: { WYSLANE: 'completed', ANULOWANE: 'cancelled', ANULOWANE_NIEOPLACONE: 'cancelled' },
    },
  }
}

class FakeAdapter implements ChannelAdapter, OrderFeed, StockWriter, ReferenceFinder, RecipientReader, OrderStatusWriter, TrackingWriter {
  constructor(
    readonly manifest: AdapterManifest,
    private readonly state: FakeChannelState,
  ) {}

  async testConnection(): Promise<ConnectionTest> {
    return this.state.connectionOk
      ? { ok: true, message: 'połączenie OK', details: { orders: this.state.orders.size } }
      : { ok: false, message: 'kanał niedostępny' }
  }

  async listOrderChanges(cursor: string | null, _opts: OrderFeedOptions): Promise<OrderFeedPage> {
    const f = this.state.listFailures.shift()
    if (f) throw f
    const after = cursor === null ? 0 : Number(cursor)
    if (!Number.isInteger(after) || after < 0) throw new AdapterError(`zły kursor „${cursor}”`, 'TRWALY')
    const changes = this.state.changesAfter(after)
    const page = changes.slice(0, this.state.pageSize)
    const items = page.map((c) => {
      const o = this.state.orders.get(c.externalId)!
      if (this.state.corrupted.has(o.externalId)) return { externalId: o.externalId, revision: '' }
      return { externalId: o.externalId, revision: o.revision, order: structuredClone(o) }
    })
    const last = page[page.length - 1]
    return { items, nextCursor: String(last ? last.seq : after), hasMore: changes.length > page.length }
  }

  async getOrder(externalId: string): Promise<ChannelOrder | null> {
    const f = this.state.getFailures.shift()
    if (f) throw f
    if (this.state.corrupted.has(externalId)) throw new UnreadableDataError(`nieczytelne zamówienie ${externalId}`)
    const o = this.state.orders.get(externalId)
    return o ? structuredClone(o) : null
  }

  /** Wspólne wstrzykiwanie awarii zapisu (jak przy stanie). Zwraca wynik albo null = wykonaj normalnie. */
  private async failure(reference: string, apply: () => void): Promise<WriteOutcome | null> {
    const f = this.state.writeFailures.shift()
    if (f === 'PRZEJSCIOWY') throw new AdapterError('429 za dużo żądań', 'PRZEJSCIOWY', 1000)
    if (f === 'TRWALY') return { kind: 'TRWALY', reference, message: '400 zła oferta' }
    if (f === 'UWIERZYTELNIENIE') return { kind: 'TRWALY', reference, message: 'HTTP 401 (klucz zapisu odrzucony)', errorClass: 'UWIERZYTELNIENIE' }
    if (f === 'NIEJEDNOZNACZNY_WYKONANY') {
      apply()
      throw new AdapterError('timeout po wysłaniu', 'NIEJEDNOZNACZNY')
    }
    if (f === 'NIEJEDNOZNACZNY_NIEWYKONANY') throw new AdapterError('timeout po wysłaniu', 'NIEJEDNOZNACZNY')
    if (f === 'WYJATEK') throw new Error('gniazdo zamknięte')
    return null
  }

  async setOrderStatus(orderExternalId: string, channelStatus: string, reference: string, guard: StatusWriteGuard = {}): Promise<WriteOutcome> {
    this.state.writeCalls.push({ op: 'status', reference, target: `${orderExternalId}:${channelStatus}` })
    if (guard.onlyIfUnpaid && this.state.paid.has(orderExternalId)) return { kind: 'TRWALY', reference, message: 'zamówienie opłacone w kanale' }
    const apply = () => {
      this.state.statuses.set(orderExternalId, channelStatus)
      this.state.appliedReferences.add(reference)
    }
    const f = await this.failure(reference, apply)
    if (f) return f
    apply()
    return { kind: 'OK', reference }
  }

  async setTracking(orderExternalId: string, tracking: TrackingInfo, reference: string): Promise<WriteOutcome> {
    this.state.writeCalls.push({ op: 'tracking', reference, target: `${orderExternalId}:${tracking.number}` })
    const apply = () => {
      const list = this.state.trackings.get(orderExternalId) ?? []
      if (!list.some((t) => t.number === tracking.number)) list.push({ ...tracking })
      this.state.trackings.set(orderExternalId, list)
      this.state.appliedReferences.add(reference)
    }
    const f = await this.failure(reference, apply)
    if (f) return f
    apply()
    return { kind: 'OK', reference }
  }

  async pushStock(items: StockWriteItem[], reference: string): Promise<WriteOutcome> {
    this.state.writeCalls.push({ op: 'stock', reference, target: items.map((i) => `${i.offerExternalId}=${i.qty}`).join(',') })
    const apply = () => {
      if (this.state.appliedReferences.has(reference)) return // idempotencja po referencji
      for (const i of items) this.state.stock.set(i.offerExternalId, i.qty)
      this.state.appliedReferences.add(reference)
    }
    const f = this.state.writeFailures.shift()
    if (f === 'PRZEJSCIOWY') throw new AdapterError('429 za dużo żądań', 'PRZEJSCIOWY', 1000)
    if (f === 'TRWALY') return { kind: 'TRWALY', reference, message: '400 zła oferta' }
    if (f === 'UWIERZYTELNIENIE') return { kind: 'TRWALY', reference, message: 'HTTP 401 (klucz zapisu odrzucony)', errorClass: 'UWIERZYTELNIENIE' }
    if (f === 'NIEJEDNOZNACZNY_WYKONANY') {
      apply()
      throw new AdapterError('timeout po wysłaniu', 'NIEJEDNOZNACZNY')
    }
    if (f === 'NIEJEDNOZNACZNY_NIEWYKONANY') throw new AdapterError('timeout po wysłaniu', 'NIEJEDNOZNACZNY')
    if (f === 'WYJATEK') throw new Error('gniazdo zamknięte')
    apply()
    return { kind: 'OK', reference }
  }

  async findByReference(reference: string): Promise<ReferenceLookup> {
    return this.state.appliedReferences.has(reference) ? { found: true } : { found: false }
  }

  async getOrderRecipient(externalId: string): Promise<OrderRecipient> {
    this.state.recipientCalls++
    const f = this.state.recipientFailures.shift()
    if (f) throw f
    if (this.state.corruptedRecipients.has(externalId)) throw new UnreadableDataError('nieczytelne pole odbiorcy: dostawa.telefon')
    const r = this.state.recipients.get(externalId)
    if (!r) throw new AdapterError(`zamówienia ${externalId} nie ma w kanale`, 'TRWALY')
    return structuredClone(r)
  }
}

/** Definicja fałszywego adaptera dla rejestru; `state` wspólny dla wszystkich kont (w testach osobny na test). */
export function fakeDefinition(state: FakeChannelState, channel: Channel = 'WOO', adapterKey = 'fake.v1', opts: FakeOptions = {}): AdapterDefinition {
  const manifest = fakeManifest(channel, adapterKey, opts)
  return { manifest, create: () => new FakeAdapter(manifest, state) }
}

/** Zamówienie testowe z rozsądnymi domyślnymi (bez danych osobowych). */
export function fakeOrder(p: Partial<ChannelOrder> & { externalId: string }): ChannelOrder {
  return {
    revision: '2026-10-25T10:00:00.000Z',
    createdAt: new Date('2026-10-25T10:00:00.000Z'),
    channelStatus: 'processing',
    statusRank: 20,
    lifecycle: 'OPEN',
    paymentState: 'PAID',
    paymentMethod: 'blik',
    totalGross: 50,
    currency: 'PLN',
    deliveryMethod: 'Paczkomaty InPost',
    wantInvoiceNip: false,
    lines: [{ externalLineId: '1', offerExternalId: '10', qty: 1, unitPriceGross: 50, vatRate: '23' }],
    warnings: [],
    ...p,
  }
}
