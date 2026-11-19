// Odczyty panelu (tylko odczyt). Każda funkcja bierze klienta firmy z sesji (RLS) i odmawia klienta
// systemowego (`organizationIdOf` rzuca błąd), więc ekran nie może przez pomyłkę czytać przez wszystkie firmy.
// Danych osobowych klientów schemat nie trzyma (tylko produkt, ilość, kwota), panel też ich nie pokazuje.
import type { Channel, OrderStatus, PaymentState, Prisma, PrismaClient, Unit } from '@prisma/client'
import { loadShadowReading, shadowEnabled } from '@/lib/cien/stan-odczytu'
import { organizationIdOf } from '@/lib/db'
import { addDays, fromWarsaw, toWarsaw } from '@/lib/rdzen/kalendarz'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { kwotyZwrotuBrakow } from '@/lib/zwroty/kwota-braku'
import { accountDisplayName, SALES_COUNT_CANCELLED } from './format'

type Db = PrismaClient

function assertOrg(db: Db): void {
  organizationIdOf(db)
}

const num = (v: { toString(): string } | null | undefined): number => (v === null || v === undefined ? 0 : Number(v.toString()))

// ─── Konta kanałów ───────────────────────────────────────────────────────────

export interface AccountRef {
  channel: Channel
  channelAccountId: string
  name: string
  stockMode: 'CIEN' | 'PRACA'
  statusMode: 'CIEN' | 'PRACA'
  active: boolean
}

export function accountKey(channel: Channel, channelAccountId: string): string {
  return `${channel}:${channelAccountId}`
}

export async function accounts(db: Db): Promise<AccountRef[]> {
  assertOrg(db)
  // Konto AI to integracja, nie kanał sprzedaży — panel go nie pokazuje wśród kanałów.
  const rows = await db.channelConfig.findMany({ where: { channel: { not: 'AI' } }, orderBy: [{ channel: 'asc' }, { name: 'asc' }] })
  return rows.map((r) => ({ channel: r.channel, channelAccountId: r.channelAccountId, name: accountDisplayName(r.channel, r.channelAccountId, r.name, r.config), stockMode: r.stockMode, statusMode: r.statusMode, active: r.active }))
}

export function accountName(list: AccountRef[], channel: Channel, channelAccountId: string): string {
  return list.find((a) => a.channel === channel && a.channelAccountId === channelAccountId)?.name ?? accountDisplayName(channel, channelAccountId)
}

// ─── Widoki listy zamówień ───────────────────────────────────────────────────

/** Zakładki listy zamówień. */
export const ORDER_VIEWS = {
  wymaga: 'Wymaga działania',
  nowe: 'Nowe',
  do_realizacji: 'Do realizacji',
  w_pakowaniu: 'W pakowaniu',
  do_wyslania: 'Do wysłania',
  wyslane: 'Wysłane',
  wszystkie: 'Wszystkie',
} as const
/**
 * Widoki, do których prowadzą kafelki „Do zrobienia teraz” na pulpicie — licznik kafelka i lista po kliknięciu
 * liczą się z TEGO SAMEGO predykatu. Bez zakładki; lista pokazuje ich nazwę w nagłówku.
 */
export const CARD_VIEWS = {
  do_spakowania: 'Do spakowania',
  do_wyjasnienia: 'Do wyjaśnienia',
  nieoplacone: 'Nieopłacone z rezerwacją',
  blad_faktury: 'Faktura się nie wystawiła',
} as const
export type TabView = keyof typeof ORDER_VIEWS
export type CardView = keyof typeof CARD_VIEWS
export type OrderView = TabView | CardView

export function isOrderView(v: string | undefined): v is OrderView {
  return !!v && (Object.prototype.hasOwnProperty.call(ORDER_VIEWS, v) || Object.prototype.hasOwnProperty.call(CARD_VIEWS, v))
}

export function viewLabel(v: OrderView): string {
  return (ORDER_VIEWS as Record<string, string>)[v] ?? (CARD_VIEWS as Record<string, string>)[v] ?? v
}

/** Brak „otwarty” (także „do zwrotu” po wysyłce) — lista zamówień, karta produktu, API raportów. */
export const OPEN_SHORTAGE: Prisma.ShortageWhereInput = { state: { in: ['OPEN', 'SHIP_LATER', 'REFUND_PENDING'] } }
/**
 * brak do decyzji przy otwartym zamówieniu = zakładka „Brakuje” na ekranie Braki towaru
 * (lib/panel/braki.ts), plakietka w menu i kafelek na pulpicie. Braki „do zwrotu” mają własną zakładkę i licznik.
 */
export const BRAK_DO_DECYZJI_OTWARTY: Prisma.ShortageWhereInput = { state: { in: ['OPEN', 'SHIP_LATER'] }, order: { status: { notIn: ['WYSLANE', 'ODEBRANE', 'ANULOWANE'] } } }
/** Brak ze stanowiska w cieniu (PackDrillFix). Wpisy PRACA (`closedBy: system:praca`) pomijamy: niesie je Shortage rdzenia. */
export const ZGLOSZONY_W_CIENIU: Prisma.PackDrillFixWhereInput = { state: { not: 'WITHDRAWN' }, OR: [{ closedBy: null }, { closedBy: { not: 'system:praca' } }] }
const NOT_DONE: Prisma.OrderWhereInput = { status: { notIn: ['ANULOWANE', 'WYSLANE', 'ODEBRANE'] } }

export function viewWhere(view: OrderView): Prisma.OrderWhereInput {
  switch (view) {
    case 'do_spakowania':
      return { status: { in: ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE'] } }
    case 'do_wyjasnienia':
      return { status: 'DO_WYJASNIENIA' }
    case 'nieoplacone':
      return { status: 'NOWE', paymentState: { in: ['UNPAID', 'PARTIAL'] } }
    case 'blad_faktury':
      return { ...NOT_DONE, invoices: { some: { state: 'FAILED' } } }
    case 'wymaga':
      return {
        OR: [
          { status: 'DO_WYJASNIENIA' },
          { shortages: { some: OPEN_SHORTAGE }, status: { notIn: ['ANULOWANE', 'WYSLANE', 'ODEBRANE'] } },
          { status: 'NOWE', paymentState: { in: ['UNPAID', 'PARTIAL'] } },
          { invoices: { some: { state: 'FAILED' } }, status: { notIn: ['ANULOWANE', 'WYSLANE', 'ODEBRANE'] } },
        ],
      }
    case 'nowe':
      return { status: 'NOWE' }
    case 'do_realizacji':
      return { status: 'DO_REALIZACJI' }
    case 'w_pakowaniu':
      return { status: { in: ['ZBIERANIE', 'ZEBRANE', 'SPAKOWANE'] } }
    case 'do_wyslania':
      return { status: { in: ['DO_WYSLANIA', 'DO_ODBIORU'] } }
    case 'wyslane':
      return { status: { in: ['WYSLANE', 'ODEBRANE'] } }
    case 'wszystkie':
      return {}
  }
}

export interface OrderFilters {
  view: OrderView
  q?: string
  account?: string // `${channel}:${channelAccountId}`
  carrier?: string
  payment?: string
  page?: number
  /** wynik wyszukiwania po kliencie (skróty e-maila / telefonu, lib/klienci/odczyt.ts) — tylko te zamówienia. */
  ids?: readonly string[]
}

export const PAGE_SIZE = 50
const CARRIERS = ['PACZKOMATY', 'DPD', 'DPD_EMPIK', 'INPOST_KURIER', 'ALLEGRO', 'OSOBISTY', 'BRAK'] as const
const PAYMENTS = ['PAID', 'UNPAID', 'COD', 'PARTIAL'] as const

// Pozycja zamówienia nie ma relacji do produktu w schemacie (tylko productId), więc szukanie po SKU i nazwie idzie
// w dwóch krokach: produkty pasujące do frazy (limit 500) → zamówienia z pozycją tych produktów.
async function ordersWhere(db: Db, f: OrderFilters, accs: AccountRef[]): Promise<Prisma.OrderWhereInput> {
  const and: Prisma.OrderWhereInput[] = [viewWhere(f.view)]
  const q = f.q?.trim().slice(0, 100)
  if (q) {
    const prods = await db.product.findMany({
      where: { OR: [{ sku: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }, { ean: q }] },
      select: { id: true },
      take: 500,
    })
    and.push({
      OR: [{ externalId: { contains: q, mode: 'insensitive' } }, ...(prods.length ? [{ lines: { some: { productId: { in: prods.map((p) => p.id) } } } }] : [])],
    })
  }
  if (f.account) {
    const a = accs.find((x) => accountKey(x.channel, x.channelAccountId) === f.account)
    and.push(a ? { channel: a.channel, channelAccountId: a.channelAccountId } : { id: '__brak__' })
  }
  if (f.carrier && (CARRIERS as readonly string[]).includes(f.carrier)) and.push({ carrier: f.carrier as (typeof CARRIERS)[number] })
  if (f.payment && (PAYMENTS as readonly string[]).includes(f.payment)) and.push({ paymentState: f.payment as PaymentState })
  if (f.ids) and.push({ id: { in: [...f.ids] } })
  return { AND: and }
}

export interface OrderRow {
  id: string
  channel: Channel
  channelAccountId: string
  externalId: string
  status: OrderStatus
  carrier: string | null
  paymentState: PaymentState
  paymentMethod: string
  totalGross: number
  createdAtChannel: Date
  reservationDeadline: Date | null
  remindAt: Date | null
  openShortages: number
  invoiceFailed: boolean
  clarify: string | null
}

export async function ordersPage(db: Db, f: OrderFilters): Promise<{ rows: OrderRow[]; total: number; counts: Record<TabView, number> }> {
  assertOrg(db)
  const accs = await accounts(db)
  const where = await ordersWhere(db, f, accs)
  const page = Math.max(1, Math.min(10_000, Math.floor(f.page ?? 1)))
  const [list, total, ...counts] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: [{ createdAtChannel: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        shortages: { where: OPEN_SHORTAGE, select: { qtyBase: true } },
        invoices: { where: { state: 'FAILED' }, select: { id: true }, take: 1 },
      },
    }),
    db.order.count({ where }),
    ...(Object.keys(ORDER_VIEWS) as TabView[]).map((v) => db.order.count({ where: viewWhere(v) })),
  ])
  const keys = Object.keys(ORDER_VIEWS) as TabView[]
  return {
    total,
    counts: Object.fromEntries(keys.map((k, i) => [k, counts[i] ?? 0])) as Record<TabView, number>,
    rows: list.map((o) => ({
      id: o.id,
      channel: o.channel,
      channelAccountId: o.channelAccountId,
      externalId: o.externalId,
      status: o.status,
      carrier: o.carrier,
      paymentState: o.paymentState,
      paymentMethod: o.paymentMethod,
      totalGross: num(o.totalGross),
      createdAtChannel: o.createdAtChannel,
      reservationDeadline: o.reservationDeadline,
      remindAt: o.remindAt,
      openShortages: o.shortages.length,
      invoiceFailed: o.invoices.length > 0,
      clarify: flagsOf(o).doWyjasnienia ?? null,
    })),
  }
}

export async function orderDetail(db: Db, id: string) {
  assertOrg(db)
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return null
  const o = await db.order.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { createdAt: 'asc' } },
      reservations: { where: { state: { in: ['ACTIVE', 'CONSUMING', 'CONSUMED'] } } },
      shortages: { orderBy: { createdAt: 'asc' } },
      invoices: { orderBy: [{ packageNo: 'asc' }, { attemptNo: 'asc' }], select: { id: true, packageNo: true, attemptNo: true, state: true, wfirmaDocId: true, number: true, lastError: true, createdAt: true } },
      events: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, kind: true, actorId: true, createdAt: true } },
    },
  })
  if (!o) return null
  const [fixes, decisions, konto, ruchyBraku] = await Promise.all([
    db.packDrillFix.findMany({ where: { orderId: id, ...ZGLOSZONY_W_CIENIU }, orderBy: { createdAt: 'asc' } }),
    db.shortageDecision.findMany({ where: { orderId: id } }),
    db.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { statusMode: true } }),
    // „nie ma na półce” jeszcze niepoprawione w wFirmie = do cofnięcia przyciskiem „Jednak jest na półce”
    db.pendingMovement.findMany({ where: { orderId: id, type: 'STOCK_MISSING', state: 'MANUAL', idempotencyKey: { startsWith: 'brak-na-polce:' } }, select: { productId: true, delta: true, idempotencyKey: true } }),
  ])
  const doCofniecia = new Map<string, { orderLineId: string; productId: string; qty: number }>()
  for (const m of ruchyBraku) {
    const [, orderLineId, productId] = m.idempotencyKey.split(':')
    if (!orderLineId || productId !== m.productId) continue
    const k = `${orderLineId}:${productId}`
    const b = doCofniecia.get(k) ?? { orderLineId, productId, qty: 0 }
    b.qty -= m.delta
    doCofniecia.set(k, b)
  }
  const brakiNaPolce = [...doCofniecia.values()]
  const products = await productInfo(db, [
    ...o.lines.map((l) => l.productId).filter((x): x is string => !!x),
    ...o.reservations.map((r) => r.productId),
    ...o.shortages.map((s) => s.productId),
    ...fixes.map((f) => f.productId),
    ...brakiNaPolce.map((b) => b.productId),
    ...decisions.map((d) => d.replacementProductId).filter((x): x is string => !!x),
  ])
  return { ...o, products, fixes, decisions, brakiNaPolce, mode: konto?.statusMode === 'PRACA' ? ('PRACA' as const) : ('CIEN' as const) }
}

export interface ProductInfo {
  id: string
  title: string
  sku: string
  unit: Unit
  kind: 'STOCKED' | 'BUNDLE' | 'DIGITAL'
  location: string | null
  /** EAN i stawka VAT z katalogu (karta zamówienia). */
  ean?: string | null
  vatRate?: string | null
}

export async function productInfo(db: Db, ids: string[]): Promise<Map<string, ProductInfo>> {
  assertOrg(db)
  if (!ids.length) return new Map()
  const rows = await db.product.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, title: true, sku: true, unit: true, kind: true, ean: true, vatRate: true, stocks: { select: { location: true } } },
  })
  return new Map(rows.map(({ stocks, ...r }) => [r.id, { ...r, location: stocks.find((s) => s.location)?.location ?? null }]))
}


// ─── Produkty i stany ────────────────────────────────────────────────────────

export const PRODUCT_FILTERS = {
  wszystkie: 'Wszystkie',
  brak: 'Dostępne 0',
  zarezerwowane: 'Z rezerwacją',
  zestawy: 'Zestawy',
  bez_lokalizacji: 'Bez lokalizacji',
  nieaktywne: 'Wyłączone',
} as const
export type ProductFilter = keyof typeof PRODUCT_FILTERS

export function isProductFilter(v: string | undefined): v is ProductFilter {
  return !!v && Object.prototype.hasOwnProperty.call(PRODUCT_FILTERS, v)
}

export interface ProductRow {
  id: string
  sku: string
  ean: string | null
  title: string
  kind: 'STOCKED' | 'BUNDLE' | 'DIGITAL'
  unit: Unit
  active: boolean
  physical: number | null
  reserved: number | null
  available: number | null
  offers: number
  location: string | null
  /** grupa wariantów produktu i liczba produktów w tej grupie (ten sam filtr aktywności); null = poza grupą. */
  groupId: string | null
  wariantow: number | null
}

/** id grupy wariantów z adresu listy (`?grupa=`); śmieci = brak filtra. */
export function grupaZAdresu(v: string | undefined): string | null {
  const s = v?.trim() ?? ''
  return s && s.length <= 100 && !/[\u0000-\u001f]/.test(s) ? s : null
}

function productWhere(filter: ProductFilter, q?: string): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = []
  const s = q?.trim().slice(0, 100)
  if (s) and.push({ OR: [{ sku: { contains: s, mode: 'insensitive' } }, { title: { contains: s, mode: 'insensitive' } }, { ean: { contains: s } }] })
  if (filter === 'nieaktywne') and.push({ active: false })
  else and.push({ active: true })
  if (filter === 'zestawy') and.push({ kind: 'BUNDLE' })
  if (filter === 'zarezerwowane') and.push({ stocks: { some: { reserved: { gt: 0 } } } })
  if (filter === 'bez_lokalizacji') and.push({ kind: 'STOCKED', stocks: { none: { location: { not: null } } } })
  return { AND: and }
}

/** „Dostępne 0” liczone w SQL: dostępne = max(0, fizycznie − zarezerwowane) ≤ 0. */
async function zeroAvailableIds(db: Db): Promise<string[]> {
  const rows = await db.$queryRaw<{ productId: string }[]>`
    SELECT s."productId" FROM "Stock" s JOIN "Product" p ON p.id = s."productId"
    WHERE p.active AND p.kind = 'STOCKED'
    GROUP BY s."productId" HAVING sum(s.physical) - sum(s.reserved) <= 0`
  return rows.map((r) => r.productId)
}

/**
 * Strona listy produktów. `tylkoId`: zawężenie do zbioru z kafla kompletności (`lib/produkty/kompletnosc.ts`),
 * ten sam zbiór co licznik kafla.
 */
export async function productsPage(db: Db, p: { filter: ProductFilter; q?: string; page?: number; tylkoId?: readonly string[]; grupa?: string | null }): Promise<{ rows: ProductRow[]; total: number }> {
  assertOrg(db)
  let where = productWhere(p.filter, p.q)
  if (p.grupa) where = { AND: [where, { groupId: p.grupa }] }
  if (p.filter === 'brak') where = { AND: [where, { id: { in: await zeroAvailableIds(db) } }] }
  if (p.tylkoId) where = { AND: [where, { id: { in: [...p.tylkoId] } }] }
  const page = Math.max(1, Math.min(10_000, Math.floor(p.page ?? 1)))
  const [list, total] = await Promise.all([
    db.product.findMany({
      where,
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { stocks: true, _count: { select: { offers: { where: { active: true } } } } },
    }),
    db.product.count({ where }),
  ])
  // ile produktów liczy każda grupa wariantów widoczna na stronie (aktywne albo wyłączone, jak zakładka)
  const grupy = [...new Set(list.map((x) => x.groupId).filter((g): g is string => !!g))]
  const ileWGrupie = new Map<string, number>()
  if (grupy.length) {
    const g = await db.product.groupBy({ by: ['groupId'], where: { groupId: { in: grupy }, active: p.filter !== 'nieaktywne' }, _count: { _all: true } })
    for (const r of g) if (r.groupId) ileWGrupie.set(r.groupId, r._count._all)
  }
  return {
    total,
    rows: list.map((x) => {
      const has = x.stocks.length > 0
      const physical = x.stocks.reduce((s, r) => s + r.physical, 0)
      const reserved = x.stocks.reduce((s, r) => s + r.reserved, 0)
      return {
        id: x.id,
        sku: x.sku,
        ean: x.ean,
        title: x.title,
        kind: x.kind,
        unit: x.unit,
        active: x.active,
        physical: has ? physical : null,
        reserved: has ? reserved : null,
        available: has ? Math.max(0, physical - reserved) : null,
        offers: x._count.offers,
        location: x.stocks.find((s) => s.location)?.location ?? null, // kod miejsca z BL, np. B-3-4
        groupId: x.groupId,
        wariantow: x.groupId ? (ileWGrupie.get(x.groupId) ?? 1) : null,
      }
    }),
  }
}

export async function productDetail(db: Db, id: string) {
  assertOrg(db)
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return null
  const p = await db.product.findUnique({
    where: { id },
    include: {
      stocks: { include: { warehouse: { select: { name: true } } } },
      offers: { orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }] },
      bundleComponents: { include: { component: { select: { id: true, title: true, sku: true, unit: true } } } },
      usedInBundles: { include: { bundle: { select: { id: true, title: true, sku: true } } } },
      movements: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  })
  if (!p) return null
  const [reservations, shortages] = await Promise.all([
    db.reservation.findMany({
      where: { productId: id, state: { in: ['ACTIVE', 'CONSUMING'] } },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { order: { select: { id: true, channel: true, channelAccountId: true, externalId: true, status: true, paymentState: true } } },
    }),
    db.shortage.findMany({
      where: { productId: id, ...OPEN_SHORTAGE },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { order: { select: { id: true, channel: true, channelAccountId: true, externalId: true } } },
    }),
  ])
  return { ...p, reservations, shortages }
}

// ─── Braki i listy biura ─────────────────────────────────────────────────────

export async function shortagesData(db: Db) {
  assertOrg(db)
  const zamowienie = { select: { id: true, channel: true, channelAccountId: true, externalId: true, status: true, paymentMethod: true } }
  const [open, manual, overcommit, refunds, reported, decisions] = await Promise.all([
    db.shortage.findMany({
      where: OPEN_SHORTAGE,
      orderBy: { createdAt: 'asc' },
      take: 500,
      include: { order: zamowienie },
    }),
    db.pendingMovement.findMany({ where: { state: 'MANUAL' }, orderBy: { createdAt: 'asc' }, take: 500 }),
    db.stock.findMany({ where: { overcommitListedAt: { not: null } }, include: { product: { select: { id: true, title: true, sku: true, unit: true } } } }),
    db.shortage.findMany({ where: { state: 'REFUND_PENDING' }, orderBy: { resolvedAt: 'asc' }, take: 500, include: { order: zamowienie, line: { select: { unitPriceGross: true, productId: true } } } }),
    db.packDrillFix.findMany({ where: ZGLOSZONY_W_CIENIU, orderBy: { createdAt: 'desc' }, take: 200 }),
    db.shortageDecision.findMany({ orderBy: { updatedAt: 'desc' }, take: 1000, select: { orderLineId: true, action: true, dryRun: true } }),
  ])
  const [reportedOrders, kwoty] = await Promise.all([
    db.order.findMany({ where: { id: { in: [...new Set(reported.map((f) => f.orderId))] } }, select: zamowienie.select }),
    // kwota do zwrotu regułą dokumentu (przelicznik oferty, rodzina zamian), nie cena × ilość bazowa
    kwotyZwrotuBrakow(db, refunds),
  ])
  const titles = await productInfo(db, [...open.map((s) => s.productId), ...manual.map((m) => m.productId), ...reported.map((f) => f.productId), ...refunds.map((s) => s.productId)])
  const byProduct = new Map<string, { productId: string; qty: number; orders: number }>()
  for (const s of open) {
    const r = byProduct.get(s.productId) ?? { productId: s.productId, qty: 0, orders: 0 }
    r.qty += s.qtyBase
    r.orders += 1
    byProduct.set(s.productId, r)
  }
  return {
    open,
    manual,
    overcommit,
    titles,
    byProduct: [...byProduct.values()].sort((a, b) => b.qty - a.qty),
    refunds: refunds.map((s) => ({ ...s, kwotaZwrotuGr: kwoty.get(s.id) ?? null })),
    reported,
    reportedOrders: new Map(reportedOrders.map((o) => [o.id, o])),
    decisions: new Map(decisions.map((d) => [d.orderLineId, d])),
  }
}

// ─── Pulpit ──────────────────────────────────────────────────────────────────

export interface DashboardData {
  now: Date
  /** `shortageLines`: braki do decyzji (zakładka „Brakuje”); `shortageLinesAll`: wszystkie otwarte, z „do zwrotu” (API raportów) */
  work: { toPack: number; shortageLines: number; shortageLinesAll: number; shortageOrders: number; shortageOrdersAll: number; clarify: number; unpaid: number; invoiceFailed: number; wfirmaFix: number; overcommit: number }
  today: { count: number; gross: number; outside: OutsideCore; perAccount: { key: string; name: string; count: number; gross: number; outside: OutsideCore }[] }
  month: { day: number; count: number; gross: number; future: boolean }[]
  monthTotals: { count: number; gross: number; outside: OutsideCore }
  channels: (AccountRef & { lastOkAt: Date | null; failingSince: Date | null; lastPollAt: Date | null; lastPollOk: boolean | null })[]
  alerts: { id: string; kind: string; message: string; createdAt: Date }[]
  /** konta cienia zamówień bez udanego odczytu (> 15 min albo otwarty alert); enabled = CIEN_ODCZYT. */
  shadow: { enabled: boolean; accounts: number; notReading: number; notReadingNames: string[] }
}

/**
 * Zamówienia sprzedaży dnia, których nie ma w realizacji systemu: `beforeStart` — zrealizowane w kanale,
 * zanim cień pierwszy raz odczytał konto (rdzeń ich świadomie nie przyjmuje, bo towar już zszedł ze stanu w BL);
 * `notIngested` — kopie bez zamówienia w rdzeniu i bez powodu pominięcia (np. przyjęcie nie powiodło się i ponowi się
 * w odczycie); `skipped` — kopie pominięte z innego, nieznanego tu powodu. Do tego `cancelled` —
 * anulowane złożone tego dnia (z rdzenia i z kopii); przy `SALES_COUNT_CANCELLED = false` są poza liczbą i kwotą
 * sprzedaży (wtedy nie wchodzą też do trzech pól wyżej), przy `true` są w niej.
 */
export interface OutsideCore {
  beforeStart: number
  notIngested: number
  skipped: number
  cancelled: number
}

/** Wiersz sprzedaży: dzień miesiąca (Warszawa) × konto kanału. */
interface SalesRow {
  day: number
  channel: Channel
  channelAccountId: string
  count: bigint
  gross: string | null
  przed: bigint
  nieprzyjete: bigint
  pominiete: bigint
  anulowane: bigint
}

/**
 * Sprzedaż w oknie [from, to) liczona po dacie złożenia w kanale, per dzień (Europe/Warsaw) i konto: każde
 * zamówienie rdzenia (`Order` bez rodzica, więc podzamówienie „dośle później” nie liczy się drugi raz) plus każda kopia
 * z kanału (`ChannelOrderSnapshot`), której rdzeń nie ma (deduplikacja po koncie kanału + id zamówienia, klucz unikalny
 * `Order`). Dla przyjętych liczą się kwota i data z rdzenia, jak dotąd. Szkic (DRAFT) bez zamówienia w rdzeniu to nie
 * sprzedaż. Anulowane (rdzeń ANULOWANE, kopia CANCELLED) liczą się osobno, a do sprzedaży tylko przy
 * `SALES_COUNT_CANCELLED`. Rezerwacji to nie dotyka — sam odczyt; RLS ogranicza obie tabele do firmy
 * z sesji. Jedno zapytanie na miesiąc, „Dziś” to wiersze dzisiejszego dnia (bez składania fragmentów SQL — strażnik
 * sesji w testach izolacji; przełącznik anulowanych idzie jako parametr).
 */
async function salesRows(db: Db, from: Date, to: Date): Promise<SalesRow[]> {
  return db.$queryRaw<SalesRow[]>`
    SELECT extract(day FROM (s.at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw')::int AS day,
           s.channel, s."channelAccountId", count(*) FILTER (WHERE s.liczy) AS count, (sum(s.gross) FILTER (WHERE s.liczy))::text AS gross,
           count(*) FILTER (WHERE s.liczy AND s.poza = 'przed-startem') AS przed, count(*) FILTER (WHERE s.liczy AND s.poza = 'nieprzyjete') AS nieprzyjete,
           count(*) FILTER (WHERE s.liczy AND s.poza = 'pominiete') AS pominiete, count(*) FILTER (WHERE s.anulowane) AS anulowane
    FROM (
      SELECT o."channel"::text AS channel, o."channelAccountId" AS "channelAccountId", o."createdAtChannel" AS at, o."totalGross" AS gross, NULL::text AS poza,
             o."status" = 'ANULOWANE' AS anulowane, (o."status" <> 'ANULOWANE' OR ${SALES_COUNT_CANCELLED}::boolean) AS liczy
      FROM "Order" o
      WHERE o."createdAtChannel" >= ${from} AND o."createdAtChannel" < ${to} AND o."parentOrderId" IS NULL
      UNION ALL
      SELECT c."channel"::text, c."channelAccountId", c."createdAtChannel", c."totalGross",
             CASE WHEN c."skipReason" IS NULL THEN 'nieprzyjete' WHEN c."skipReason" = 'zrealizowane-przed-pierwszym-odczytem' THEN 'przed-startem' ELSE 'pominiete' END,
             c."lifecycle" = 'CANCELLED', (c."lifecycle" <> 'CANCELLED' OR ${SALES_COUNT_CANCELLED}::boolean)
      FROM "ChannelOrderSnapshot" c
      WHERE c."createdAtChannel" >= ${from} AND c."createdAtChannel" < ${to} AND c."lifecycle" <> 'DRAFT'
        AND NOT EXISTS (
          SELECT 1 FROM "Order" x
          WHERE x."organizationId" = c."organizationId" AND x."channel" = c."channel" AND x."channelAccountId" = c."channelAccountId" AND x."externalId" = c."externalId"
        )
    ) s
    GROUP BY 1, 2, 3`
}

/** Zamówienie sprzedaży dnia: to samo źródło co `salesRows`, ale per zamówienie (porównanie z BL). */
export interface SalesOrder {
  channel: Channel
  channelAccountId: string
  externalId: string
  /** Numer w kanale/BL, gdy inny niż id (Woo z numeracją wtyczki) — z kopii kanału. */
  channelNumber: string | null
  createdAtChannel: Date
  gross: string
  /** Jak w `salesRows`: bez powodu pominięcia → nieprzyjęte, inny nieznany powód → pominięte. */
  outside: 'przed-startem' | 'nieprzyjete' | 'pominiete' | null
  /** Do rozpoznania zamówień, których BL nie importuje: status rdzenia (null = kopia bez rdzenia),
   *  powód anulowania, płatność (rdzeń, inaczej kopia) oraz status i cykl życia z kopii kanału. */
  orderStatus: string | null
  cancelReason: string | null
  paymentState: string | null
  channelStatus: string | null
  lifecycle: string | null
}

/**
 * Zamówienia sprzedaży w oknie [from, to) — te same warunki co `salesRows` (pulpit „Dziś”), bez grupowania: rdzeń
 * bez podzamówień plus kopie kanału bez zamówienia w rdzeniu, bez szkiców. Zmiana warunków tu = zmiana w `salesRows`
 * (test `tests/cien-sprzedaz-dnia.integration.test.ts` sprawdza, że sumy się zgadzają z pulpitem). W odróżnieniu od
 * `salesRows` zwraca też anulowane niezależnie od `SALES_COUNT_CANCELLED` (porównanie z BL ich potrzebuje: BL importuje
 * opłacone i potem anulowane) — rozpoznawane po `orderStatus` = ANULOWANE (rdzeń) albo `lifecycle` = CANCELLED (kopia bez
 * rdzenia); wtedy liczba = „Dziś” + `outside.cancelled`.
 */
export async function salesOrders(db: Db, from: Date, to: Date): Promise<SalesOrder[]> {
  assertOrg(db)
  return db.$queryRaw<SalesOrder[]>`
    SELECT o."channel"::text AS channel, o."channelAccountId", o."externalId", c."channelNumber", o."createdAtChannel", o."totalGross"::text AS gross, NULL::text AS outside,
           o."status"::text AS "orderStatus", o."cancelReason", o."paymentState"::text AS "paymentState", c."channelStatus", c."lifecycle"
    FROM "Order" o
    LEFT JOIN "ChannelOrderSnapshot" c
      ON c."organizationId" = o."organizationId" AND c."channel" = o."channel" AND c."channelAccountId" = o."channelAccountId" AND c."externalId" = o."externalId"
    WHERE o."createdAtChannel" >= ${from} AND o."createdAtChannel" < ${to} AND o."parentOrderId" IS NULL
    UNION ALL
    SELECT c."channel"::text, c."channelAccountId", c."externalId", c."channelNumber", c."createdAtChannel", c."totalGross"::text,
           CASE WHEN c."skipReason" IS NULL THEN 'nieprzyjete' WHEN c."skipReason" = 'zrealizowane-przed-pierwszym-odczytem' THEN 'przed-startem' ELSE 'pominiete' END,
           NULL::text, NULL::text, c."paymentState"::text, c."channelStatus", c."lifecycle"
    FROM "ChannelOrderSnapshot" c
    WHERE c."createdAtChannel" >= ${from} AND c."createdAtChannel" < ${to} AND c."lifecycle" <> 'DRAFT'
      AND NOT EXISTS (
        SELECT 1 FROM "Order" x
        WHERE x."organizationId" = c."organizationId" AND x."channel" = c."channel" AND x."channelAccountId" = c."channelAccountId" AND x."externalId" = c."externalId"
      )`
}

/** Suma wierszy w groszach (kwoty z bazy jako tekst Decimal — bez błędów zaokrągleń przy dodawaniu). */
interface SalesSum {
  count: number
  cents: number
  outside: OutsideCore
}

function sumRows(rows: SalesRow[]): SalesSum {
  return rows.reduce<SalesSum>(
    (acc, r) => ({
      count: acc.count + Number(r.count),
      cents: acc.cents + Math.round(Number(r.gross ?? 0) * 100),
      outside: {
        beforeStart: acc.outside.beforeStart + Number(r.przed),
        notIngested: acc.outside.notIngested + Number(r.nieprzyjete),
        skipped: acc.outside.skipped + Number(r.pominiete),
        cancelled: acc.outside.cancelled + Number(r.anulowane),
      },
    }),
    { count: 0, cents: 0, outside: { beforeStart: 0, notIngested: 0, skipped: 0, cancelled: 0 } },
  )
}

/** Granice dnia i miesiąca w strefie Warszawy dla chwili `now`. */
export function warsawRanges(now: Date): { dayStart: Date; dayEnd: Date; monthStart: Date; monthEnd: Date; daysInMonth: number; today: number } {
  const { day } = toWarsaw(now)
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const first = `${y}-${String(m).padStart(2, '0')}-01`
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return {
    dayStart: fromWarsaw(day, 0),
    dayEnd: fromWarsaw(addDays(day, 1), 0),
    monthStart: fromWarsaw(first, 0),
    monthEnd: fromWarsaw(addDays(first, daysInMonth), 0),
    daysInMonth,
    today: d,
  }
}

export async function dashboard(db: Db, now = new Date(), opts: { shadowEnabled?: boolean } = {}): Promise<DashboardData> {
  assertOrg(db)
  const r = warsawRanges(now)
  const accs = await accounts(db)
  const shadow = await loadShadowReading(db, { enabled: opts.shadowEnabled ?? shadowEnabled(process.env), now })
  const [toPack, shortageAgg, shortageAll, shortageOrders, shortageOrdersAll, clarify, unpaid, invoiceFailed, wfirmaFix, overcommit, monthRows, health, polls, alerts] = await Promise.all([
    db.order.count({ where: viewWhere('do_spakowania') }),
    db.shortage.count({ where: BRAK_DO_DECYZJI_OTWARTY }), // = zakładka „Brakuje” na /braki i plakietka w menu
    db.shortage.count({ where: OPEN_SHORTAGE }),
    db.order.count({ where: { shortages: { some: { state: { in: ['OPEN', 'SHIP_LATER'] } } }, status: { notIn: ['WYSLANE', 'ODEBRANE', 'ANULOWANE'] } } }),
    db.order.count({ where: { shortages: { some: OPEN_SHORTAGE } } }),
    db.order.count({ where: viewWhere('do_wyjasnienia') }),
    db.order.count({ where: viewWhere('nieoplacone') }),
    db.order.count({ where: viewWhere('blad_faktury') }),
    db.pendingMovement.count({ where: { state: 'MANUAL' } }),
    db.stock.count({ where: { overcommitListedAt: { not: null } } }),
    salesRows(db, r.monthStart, r.monthEnd),
    db.channelHealth.findMany(),
    db.channelOrderPoll.findMany({ orderBy: { startedAt: 'desc' }, take: 200, select: { channel: true, channelAccountId: true, finishedAt: true, ok: true, startedAt: true } }),
    db.alert.findMany({ where: { closedAt: null }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, kind: true, message: true, createdAt: true } }),
  ])
  const todayRows = monthRows.filter((m) => Number(m.day) === r.today)
  const ofAccount = (channel: Channel, channelAccountId: string) => sumRows(todayRows.filter((t) => t.channel === channel && t.channelAccountId === channelAccountId))
  const perAccount = accs
    .filter((a) => a.channel !== 'RECZNE' || todayRows.some((t) => t.channel === a.channel && t.channelAccountId === a.channelAccountId))
    .map((a) => {
      const t = ofAccount(a.channel, a.channelAccountId)
      return { key: accountKey(a.channel, a.channelAccountId), name: a.name, count: t.count, gross: t.cents / 100, outside: t.outside }
    })
  const unknown = new Set(todayRows.filter((t) => !accs.some((a) => a.channel === t.channel && a.channelAccountId === t.channelAccountId)).map((t) => accountKey(t.channel, t.channelAccountId)))
  for (const key of unknown) {
    const t0 = todayRows.find((t) => accountKey(t.channel, t.channelAccountId) === key)!
    const t = ofAccount(t0.channel, t0.channelAccountId)
    perAccount.push({ key, name: accountDisplayName(t0.channel, t0.channelAccountId), count: t.count, gross: t.cents / 100, outside: t.outside })
  }
  perAccount.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pl'))
  const month = Array.from({ length: r.daysInMonth }, (_, i) => {
    const t = sumRows(monthRows.filter((m) => Number(m.day) === i + 1))
    return { day: i + 1, count: t.count, gross: t.cents / 100, future: i + 1 > r.today }
  })
  const todaySum = sumRows(todayRows)
  const monthSum = sumRows(monthRows)
  return {
    now,
    work: { toPack, shortageLines: shortageAgg, shortageLinesAll: shortageAll, shortageOrders, shortageOrdersAll, clarify, unpaid, invoiceFailed, wfirmaFix, overcommit },
    today: { count: todaySum.count, gross: todaySum.cents / 100, outside: todaySum.outside, perAccount },
    month,
    monthTotals: { count: monthSum.count, gross: monthSum.cents / 100, outside: monthSum.outside },
    channels: accs.map((a) => {
      const h = health.find((x) => x.channel === a.channel && x.channelAccountId === a.channelAccountId)
      const p = polls.find((x) => x.channel === a.channel && x.channelAccountId === a.channelAccountId)
      return { ...a, lastOkAt: h?.lastOkAt ?? null, failingSince: h?.failingSince ?? null, lastPollAt: p?.finishedAt ?? p?.startedAt ?? null, lastPollOk: p ? p.ok : null }
    }),
    alerts,
    shadow: {
      enabled: shadow.enabled,
      accounts: shadow.accounts,
      notReading: shadow.notReading,
      notReadingNames: shadow.details.filter((x) => !x.reading).map((x) => x.name),
    },
  }
}

/**
 * Licznik braków do menu. Licznik „Zamówienia” (wymaga działania) bierze layout z `licznikiPanelu(db).grupy.wymaga`
 * (jedno zapytanie „wymaga” na żądanie zamiast dwóch-trzech).
 */
export async function navCounts(db: Db): Promise<{ shortages: number }> {
  assertOrg(db)
  return { shortages: await db.shortage.count({ where: BRAK_DO_DECYZJI_OTWARTY }) }
}
