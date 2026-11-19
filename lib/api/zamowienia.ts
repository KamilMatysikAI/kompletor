// GET /api/v1/zamowienia i /api/v1/zamowienia/<numer> (zakres `zamowienia:odczyt`). BotKlienta co 10 min
// pobiera zmienione zamówienia z ostatnich 14 dni: numer sklepu, numer BL, status, numer nadania, sposób dostawy,
// pozycje. Klient firmy klucza (RLS).
//
// Odpowiedź budowana pole po polu z jawnej listy (ORDER_FIELDS, LINE_FIELDS) — nigdy cały rekord. Bez `flags`,
// `cancelReason`, `pendingAction` i treści zdarzeń: mogą nieść dane z kanału. Danych osobowych Kompletor nie ma
// (wyszukiwanie po e-mailu i telefonie zostaje po stronie BotKlienta).
//
// Lista: `?zmienione_od=<ISO>&limit=<1–200>&po=<kursor>`, kolejność `updatedAt`, potem `id` (rosnąco). Kursor to
// para (updatedAt, id) ostatniej pozycji strony: stabilny przy równych `updatedAt` i przy nowych zmianach (zamówienie
// zmienione po odczycie przesuwa się na koniec i wraca w kolejnym pobraniu). Okno najwyżej 14 dni wstecz.
// opcjonalne filtry listy (`status`, `kanal`, `konto`, `platnosc`, `zlozone_od`, `zlozone_do`) tylko zawężają
// to samo okno i tę samą kolejność — z nich korzysta też narzędzie MCP `zamowienia_lista` (lib/mcp/narzedzia.ts).
// Kursor zakłada te same filtry w kolejnych stronach.
//
// `przesylki[]`: przesyłki zamówienia utworzone u przewoźnika (bez anulowanych, których paczka nie ruszyła): numer,
// stan drogi paczki (kod ze słownika lib/wysylka/stany-przesylki.ts i opis), od kiedy w tym stanie, kiedy ostatnio
// sprawdzony u przewoźnika, czy Kompletor go jeszcze odświeża, i link do strony śledzenia (tylko gdy paczkę nadał
// moduł samego przewoźnika, lib/wysylka/link-sledzenia.ts). Bez opisów zdarzeń przewoźnika: mogą nieść nazwisko
// odbierającego. Pole dodane obok `numerNadania`, które zostaje bez zmian.
import { statusyKuriera } from '../wysylka/status-kuriera'
import type { Carrier, Channel, OrderStatus, PaymentState, Prisma, PrismaClient, ShipmentTrackState } from '@prisma/client'
import { STATUS_LABEL } from '@/lib/panel/format'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import type { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { kluczeSledzenia } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { parseAutomatyWysylki, parseSledzeniePrzewoznikow } from '@/lib/wysylka/automaty'
import { anulowanaBezDrogi, paczkaSledzona, sledzenieZakonczone } from '@/lib/wysylka/droga-paczki'
import { linkSledzenia } from '@/lib/wysylka/link-sledzenia'
import { OPIS_STANU_DROGI } from '@/lib/wysylka/stany-przesylki'
import { ApiInputError } from './odpowiedzi'

export const MAX_LIMIT = 200
export const DEFAULT_LIMIT = 100
export const MAX_WINDOW_MS = 14 * 24 * 3600_000
export const MAX_HITS = 50
// Kanały zamówień i ofert = rodziny z DEFAULT_CHANNEL_ADAPTER bez AI (nowy kanał, np. SHOPER, PRESTASHOP,
// nie wymaga dopisywania tutaj)
export const CHANNELS: Channel[] = (Object.keys(DEFAULT_CHANNEL_ADAPTER) as Channel[]).filter((c) => c !== 'AI')
export const ORDER_STATUSES: OrderStatus[] = Object.keys(STATUS_LABEL) as OrderStatus[]
export const PAYMENT_STATES: PaymentState[] = ['PAID', 'UNPAID', 'COD', 'PARTIAL']

export const ORDER_FIELDS = [
  'kanal',
  'konto',
  'numer',
  'numerBl',
  'status',
  'statusNazwa',
  'przewoznik',
  'sposobDostawy',
  'platnosc',
  'platnoscMetoda',
  'sumaBrutto',
  'zlozono',
  'zmieniono',
  'numerNadania',
  'przesylkaStatus',
  'przesylkaStatusKod',
  'przesylkaStatusKiedy',
  'pozycje',
  'przesylki',
] as const
export const LINE_FIELDS = ['sku', 'nazwa', 'ilosc', 'cenaBrutto'] as const
export const SHIPMENT_FIELDS = ['przewoznik', 'numerNadania', 'stan', 'stanNazwa', 'stanOd', 'sprawdzono', 'sledzona', 'linkSledzenia', 'rodzaj'] as const
/** Rodzaj przesyłki w API: główna albo dodatkowa do tego samego zamówienia (bez powodu wpisanego przez pracownika). */
export const RODZAJE_PRZESYLKI_API = ['GLOWNA', 'DOSYLKA', 'ZASTEPCZA', 'DODATKOWA'] as const
export type RodzajPrzesylkiApi = (typeof RODZAJE_PRZESYLKI_API)[number]
/** Najwięcej przesyłek jednego zamówienia w odpowiedzi (od najstarszej). */
export const MAX_SHIPMENTS = 10

export interface ShipmentOut {
  przewoznik: Carrier
  numerNadania: string | null
  /** stan drogi paczki (np. `W_DRODZE`) albo null, gdy Kompletor nie ma jeszcze odczytu u przewoźnika */
  stan: ShipmentTrackState | null
  stanNazwa: string | null
  /** od kiedy paczka jest w tym stanie (ISO 8601 UTC) */
  stanOd: string | null
  /** ostatni odczyt u przewoźnika (ISO 8601 UTC) */
  sprawdzono: string | null
  /** Kompletor dalej odświeża stan tej paczki (firma śledzi paczki do doręczenia i pyta o paczki tego modułu) */
  sledzona: boolean
  /** strona śledzenia u przewoźnika albo null (wtedy sam numer) */
  linkSledzenia: string | null
  /** GLOWNA = przesyłka zamówienia; DOSYLKA, ZASTEPCZA, DODATKOWA = dodatkowa przesyłka (karta zamówienia „Dodaj przesyłkę”) */
  rodzaj: RodzajPrzesylkiApi
}

export interface OrderLineOut {
  sku: string | null
  nazwa: string | null
  ilosc: number
  cenaBrutto: number
}

export interface OrderOut {
  kanal: Channel
  konto: string
  numer: string
  numerBl: number | null
  status: OrderStatus
  statusNazwa: string
  przewoznik: Carrier | null
  sposobDostawy: string | null
  platnosc: PaymentState
  platnoscMetoda: string
  sumaBrutto: number
  zlozono: string
  zmieniono: string
  numerNadania: string | null
  /**
   * Ostatni stan paczki u przewoźnika stałym tekstem wyliczonym z `przesylkaStatusKod` (np. „U przewoźnika, w drodze”);
   * null = brak odczytu. Bez wolnego opisu przewoźnika (zostaje w panelu).
   */
  przesylkaStatus: string | null
  /** PRZED_NADANIEM | PRZEKAZANA | DORECZONA | NIEZNANY; null = brak odczytu. */
  przesylkaStatusKod: string | null
  przesylkaStatusKiedy: string | null
  pozycje: OrderLineOut[]
  przesylki: ShipmentOut[]
}

const ORDER_SELECT = {
  id: true,
  channel: true,
  channelAccountId: true,
  externalId: true,
  blOrderId: true,
  status: true,
  carrier: true,
  deliveryMethod: true,
  paymentState: true,
  paymentMethod: true,
  totalGross: true,
  createdAtChannel: true,
  updatedAt: true,
  lines: {
    where: { removed: false },
    select: { productId: true, qty: true, unitPriceGross: true, externalLineId: true },
    orderBy: [{ createdAt: 'asc' }, { externalLineId: 'asc' }],
  },
} satisfies Prisma.OrderSelect

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>

export const money = (d: Prisma.Decimal) => Math.round(d.toNumber() * 100) / 100

async function toOut(db: PrismaClient, rows: OrderRow[]): Promise<OrderOut[]> {
  if (!rows.length) return []
  const productIds = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.productId)).filter((x): x is string => !!x))]
  const products = new Map(
    productIds.length ? (await db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, title: true } })).map((p) => [p.id, p]) : [],
  )
  const tracking = await trackingNumbers(db, rows.map((r) => r.id))
  const shipments = await shipmentsOf(db, rows.map((r) => r.id))
  const uKuriera = await statusyKuriera(db, rows.map((r) => r.id))
  return rows.map((r) => {
    // allowlista: każde pole wypisane jawnie, kolejność jak w ORDER_FIELDS
    const out: OrderOut = {
      kanal: r.channel,
      konto: r.channelAccountId,
      numer: r.externalId,
      numerBl: r.blOrderId,
      status: r.status,
      statusNazwa: STATUS_LABEL[r.status],
      przewoznik: r.carrier,
      sposobDostawy: r.deliveryMethod,
      platnosc: r.paymentState,
      platnoscMetoda: r.paymentMethod,
      sumaBrutto: money(r.totalGross),
      zlozono: r.createdAtChannel.toISOString(),
      zmieniono: r.updatedAt.toISOString(),
      numerNadania: tracking.get(r.id) ?? null,
      przesylkaStatus: uKuriera.get(r.id)?.nazwaStanu ?? null,
      przesylkaStatusKod: uKuriera.get(r.id)?.stan ?? null,
      przesylkaStatusKiedy: uKuriera.get(r.id)?.kiedy.toISOString() ?? null,
      pozycje: r.lines.map((l) => {
        const p = l.productId ? products.get(l.productId) : undefined
        return { sku: p?.sku ?? null, nazwa: p?.title ?? null, ilosc: l.qty, cenaBrutto: money(l.unitPriceGross) }
      }),
      przesylki: shipments.get(r.id) ?? [],
    }
    return out
  })
}

/**
 * Numer nadania: z ostatniego zdarzenia zamówienia z polem `data.nadanie` (przejście statusu z numerem przesyłki,
 * lib/rdzen/przejscia.ts; puste przy anulowaniu przesyłki, lib/wysylka/nadanie.ts). Z bazy wychodzi wyłącznie ten tekst, nie cała treść zdarzenia.
 */
export async function trackingNumbers(db: PrismaClient, orderIds: string[]): Promise<Map<string, string>> {
  const rows = await db.$queryRaw<{ orderId: string; nadanie: string }[]>`
    SELECT DISTINCT ON ("orderId") "orderId", data->>'nadanie' AS nadanie
    FROM "OrderEvent"
    WHERE "orderId" = ANY(${orderIds}::text[]) AND data->>'nadanie' IS NOT NULL
    ORDER BY "orderId", "createdAt" DESC, id DESC`
  // puste `nadanie` = numer wyczyszczony (anulowana przesyłka): zamówienie bez numeru
  return new Map(rows.filter((r) => String(r.nadanie).trim() !== '').map((r) => [r.orderId, String(r.nadanie).slice(0, 100)]))
}

/**
 * Przesyłki zamówień (jedno zapytanie na stronę): utworzone u przewoźnika i anulowane z numerem, które przewoźnik
 * widział w drodze (jak blok „Przesyłki” na karcie zamówienia, lib/wysylka/droga-paczki.ts). Z bazy tylko pola z
 * listy SHIPMENT_FIELDS: bez historii i opisów zdarzeń przewoźnika.
 */
/** Rodzaj przesyłki w API z kolumn bazy; nieznany rodzaj dodatkowej = DODATKOWA (nigdy GLOWNA). */
export function rodzajApi(extraNo: number, extraKind: string | null): RodzajPrzesylkiApi {
  if (extraNo === 0) return 'GLOWNA'
  return extraKind === 'DOSYLKA' || extraKind === 'ZASTEPCZA' ? extraKind : 'DODATKOWA'
}

export async function shipmentsOf(db: PrismaClient, orderIds: string[], registry: AdapterRegistry = defaultRegistry()): Promise<Map<string, ShipmentOut[]>> {
  const out = new Map<string, ShipmentOut[]>()
  if (!orderIds.length) return out
  const [rows, org] = await Promise.all([
    db.shipment.findMany({
      where: { orderId: { in: orderIds }, OR: [{ state: 'UTWORZONA' }, { state: 'ANULOWANA', trackingNumber: { not: null } }] },
      orderBy: [{ orderId: 'asc' }, { packageNo: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { orderId: true, carrier: true, adapterKey: true, trackingNumber: true, state: true, trackState: true, trackStateSince: true, trackedAt: true, trackingStoppedAt: true, createdAt: true, extraNo: true, extraKind: true },
    }),
    // jeden odczyt ustawień firmy dla obu przełączników
    db.organization.findFirst({ select: { settings: true } }),
  ])
  const automaty = parseAutomatyWysylki(org?.settings ?? null)
  const wybory = parseSledzeniePrzewoznikow(org?.settings ?? null)
  // te same warunki co karta zamówienia: przełączniki firmy i moduły, o które pyta sprawdzanie w tle
  const sledzone = new Set(kluczeSledzenia(registry, wybory))
  const doKonca = automaty.sledzenie && automaty.sledzenieDoDoreczenia
  const now = new Date()
  for (const s of rows) {
    if (anulowanaBezDrogi(s.state, s.trackState)) continue
    const lista = out.get(s.orderId) ?? []
    if (lista.length >= MAX_SHIPMENTS) continue
    const stanOd = s.trackState ? (s.trackStateSince ?? s.trackedAt) : null
    // allowlista: każde pole wypisane jawnie, kolejność jak w SHIPMENT_FIELDS
    lista.push({
      przewoznik: s.carrier,
      numerNadania: s.trackingNumber ? s.trackingNumber.slice(0, 100) : null,
      stan: s.trackState,
      stanNazwa: s.trackState ? OPIS_STANU_DROGI[s.trackState] : null,
      stanOd: stanOd ? stanOd.toISOString() : null,
      sprawdzono: s.trackedAt ? s.trackedAt.toISOString() : null,
      sledzona: paczkaSledzona({ doKonca, modulSledzony: sledzone.has(s.adapterKey), zakonczona: sledzenieZakonczone(s, now) }),
      linkSledzenia: linkSledzenia(s.carrier, s.trackingNumber, s.adapterKey),
      rodzaj: rodzajApi(s.extraNo, s.extraKind),
    })
    out.set(s.orderId, lista)
  }
  return out
}

// ─── Jedno zamówienie po numerze ────────────────────────────────────────────

export interface OrderNumberQuery {
  numer: string
  channel?: Channel
  channelAccountId?: string
}

export function parseOrderNumberQuery(numer: string, sp: URLSearchParams): OrderNumberQuery {
  const known = new Set(['kanal', 'konto'])
  for (const k of sp.keys()) if (!known.has(k)) throw new ApiInputError(`Nieznany parametr ${k}`, k)
  let n = numer.trim()
  if (/%[0-9A-Fa-f]{2}/.test(n)) {
    try {
      n = decodeURIComponent(n)
    } catch {
      throw new ApiInputError('Zły numer zamówienia', 'numer')
    }
  }
  if (!n || n.length > 100) throw new ApiInputError('Zły numer zamówienia', 'numer')
  const kanal = sp.get('kanal')
  const konto = sp.get('konto')
  if (kanal !== null && !CHANNELS.includes(kanal as Channel)) throw new ApiInputError(`Nieznany kanał ${kanal}`, 'kanal')
  if (konto !== null && (!konto || konto.length > 100)) throw new ApiInputError('Złe konto', 'konto')
  return { numer: n, channel: (kanal as Channel | null) ?? undefined, channelAccountId: konto ?? undefined }
}

/** Zamówienia o tym numerze sklepu (`externalId`) albo numerze BL; kilka kont = wszystkie trafienia. */
export async function ordersByNumber(db: PrismaClient, q: OrderNumberQuery): Promise<OrderOut[]> {
  const bl = /^\d{1,10}$/.test(q.numer) && Number(q.numer) <= 2_147_483_647 ? Number(q.numer) : null
  const rows = await db.order.findMany({
    where: {
      OR: [{ externalId: q.numer }, ...(bl !== null ? [{ blOrderId: bl }] : [])],
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.channelAccountId ? { channelAccountId: q.channelAccountId } : {}),
    },
    select: ORDER_SELECT,
    orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }, { id: 'asc' }],
    take: MAX_HITS,
  })
  return toOut(db, rows)
}

// ─── Lista zmienionych ──────────────────────────────────────────────────────

export interface OrderListFilter {
  statuses?: OrderStatus[]
  channel?: Channel
  channelAccountId?: string
  payments?: PaymentState[]
  placedFrom?: Date
  placedTo?: Date
}

export interface OrderListQuery extends OrderListFilter {
  changedFrom: Date
  limit: number
  after: { updatedAt: Date; id: string } | null
}

/** Lista wartości enuma z jednego pola (`a,b`) — nieznana wartość = błąd z nazwą pola. */
export function enumList<T extends string>(raw: string | string[], allowed: readonly T[], field: string): T[] {
  const parts = (Array.isArray(raw) ? raw : raw.split(',')).map((x) => x.trim()).filter(Boolean)
  const bad = parts.find((x) => !(allowed as readonly string[]).includes(x))
  if (bad !== undefined) throw new ApiInputError(`${field}: nieznana wartość ${bad.slice(0, 40)} (dozwolone: ${allowed.join(', ')})`, field)
  if (!parts.length) throw new ApiInputError(`${field}: pusta lista`, field)
  return [...new Set(parts)] as T[]
}

/** Data ISO 8601 (sam dzień albo z godziną i strefą) albo błąd z nazwą pola. */
export function isoDate(raw: string, field: string): Date {
  const d = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw) ? new Date(raw) : new Date(Number.NaN)
  if (Number.isNaN(d.getTime())) throw new ApiInputError(`${field}: data ISO 8601, np. 2026-11-01T00:00:00Z`, field)
  return d
}

/** Filtry wspólne dla GET /api/v1/zamowienia i narzędzia MCP; wartości już jako tekst albo lista. */
export function parseOrderListFilter(v: { status?: string | string[] | null; kanal?: string | null; konto?: string | null; platnosc?: string | string[] | null; zlozone_od?: string | null; zlozone_do?: string | null }): OrderListFilter {
  const f: OrderListFilter = {}
  if (v.status !== null && v.status !== undefined) f.statuses = enumList(v.status, ORDER_STATUSES, 'status')
  if (v.platnosc !== null && v.platnosc !== undefined) f.payments = enumList(v.platnosc, PAYMENT_STATES, 'platnosc')
  if (v.kanal !== null && v.kanal !== undefined) {
    if (!CHANNELS.includes(v.kanal as Channel)) throw new ApiInputError(`Nieznany kanał ${v.kanal.slice(0, 40)}`, 'kanal')
    f.channel = v.kanal as Channel
  }
  if (v.konto !== null && v.konto !== undefined) {
    if (!v.konto || v.konto.length > 100) throw new ApiInputError('Złe konto', 'konto')
    f.channelAccountId = v.konto
  }
  if (v.zlozone_od !== null && v.zlozone_od !== undefined) f.placedFrom = isoDate(v.zlozone_od, 'zlozone_od')
  if (v.zlozone_do !== null && v.zlozone_do !== undefined) f.placedTo = isoDate(v.zlozone_do, 'zlozone_do')
  if (f.placedFrom && f.placedTo && f.placedFrom.getTime() >= f.placedTo.getTime()) throw new ApiInputError('zlozone_do musi być po zlozone_od', 'zlozone_do')
  return f
}

export function encodeCursor(c: { updatedAt: Date; id: string }): string {
  return Buffer.from(`${c.updatedAt.toISOString()}|${c.id}`, 'utf8').toString('base64url')
}

export function decodeCursor(s: string): { updatedAt: Date; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) return null
  const raw = Buffer.from(s, 'base64url').toString('utf8')
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([A-Za-z0-9_-]{1,64})$/.exec(raw)
  if (!m) return null
  const d = new Date(m[1]!)
  return Number.isNaN(d.getTime()) ? null : { updatedAt: d, id: m[2]! }
}

export function parseOrderListQuery(sp: URLSearchParams, now: Date): OrderListQuery {
  const known = new Set(['zmienione_od', 'limit', 'po', 'status', 'kanal', 'konto', 'platnosc', 'zlozone_od', 'zlozone_do'])
  for (const k of sp.keys()) if (!known.has(k)) throw new ApiInputError(`Nieznany parametr ${k}`, k)
  const fromRaw = sp.get('zmienione_od')
  const changedFrom = changedFromOf(fromRaw, now)
  const limitRaw = sp.get('limit')
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ApiInputError(`limit: liczba całkowita 1–${MAX_LIMIT}`, 'limit')
  const poRaw = sp.get('po')
  const after = poRaw === null ? null : decodeCursor(poRaw)
  if (poRaw !== null && !after) throw new ApiInputError('po: zły kursor (użyj wartości nastepny z poprzedniej odpowiedzi)', 'po')
  const list = (k: string) => (sp.getAll(k).length ? sp.getAll(k).join(',') : null)
  const filter = parseOrderListFilter({
    status: list('status'),
    platnosc: list('platnosc'),
    kanal: sp.get('kanal'),
    konto: sp.get('konto'),
    zlozone_od: sp.get('zlozone_od'),
    zlozone_do: sp.get('zlozone_do'),
  })
  return { changedFrom, limit, after, ...filter }
}

/** Początek okna „zmienione od”: domyślnie 14 dni wstecz, nigdy dalej. */
export function changedFromOf(fromRaw: string | null | undefined, now: Date): Date {
  const earliest = now.getTime() - MAX_WINDOW_MS
  if (fromRaw === null || fromRaw === undefined) return new Date(earliest)
  const d = isoDate(fromRaw, 'zmienione_od')
  if (d.getTime() < earliest) throw new ApiInputError('zmienione_od: najwyżej 14 dni wstecz', 'zmienione_od')
  return d
}

export async function listChangedOrders(db: PrismaClient, q: OrderListQuery): Promise<{ zamowienia: OrderOut[]; nastepny: string | null }> {
  const rows: OrderRow[] = await db.order.findMany({
    where: {
      AND: [
        { updatedAt: { gte: q.changedFrom } },
        ...(q.after ? [{ OR: [{ updatedAt: { gt: q.after.updatedAt } }, { updatedAt: q.after.updatedAt, id: { gt: q.after.id } }] }] : []),
        ...(q.statuses ? [{ status: { in: q.statuses } }] : []),
        ...(q.payments ? [{ paymentState: { in: q.payments } }] : []),
        ...(q.channel ? [{ channel: q.channel }] : []),
        ...(q.channelAccountId ? [{ channelAccountId: q.channelAccountId }] : []),
        ...(q.placedFrom ? [{ createdAtChannel: { gte: q.placedFrom } }] : []),
        ...(q.placedTo ? [{ createdAtChannel: { lt: q.placedTo } }] : []),
      ],
    },
    select: ORDER_SELECT,
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: q.limit + 1,
  })
  const page = rows.slice(0, q.limit)
  const last = page.at(-1)
  return { zamowienia: await toOut(db, page), nastepny: rows.length > q.limit && last ? encodeCursor(last) : null }
}
