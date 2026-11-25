// Odczyty zbiorcze (zakres `raporty:odczyt`): GET /api/v1/raporty/dzien, /braki, /rezerwacje oraz narzędzia
// MCP `raport_dnia`, `braki`, `rezerwacje`. Klient firmy klucza (RLS).
//
// Same liczby, SKU i numery zamówień — bez danych klientów, treści alertów, notatek braków i treści zdarzeń. Liczby dnia
// z tej samej funkcji co pulpit panelu (`dashboard`, lib/panel/dane.ts), więc agent widzi to samo co
// sprzedawca na ekranie „Dziś”. Braki: otwarte `Shortage` (ta sama definicja co menu i ekran braków, OPEN_SHORTAGE).
import type { Channel, OrderStatus, PaymentState, PrismaClient, Unit } from '@prisma/client'
import { dashboard, OPEN_SHORTAGE, warsawRanges } from '@/lib/panel/dane'
import { obceDoApi, type WalutaApi } from '@/lib/panel/sumy-walut'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { availableOf, DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { ApiInputError } from './odpowiedzi'
import { MAX_SKUS } from './stany'

export const REPORT_MAX_PRODUCTS = 100
export const REPORT_DEFAULT_PRODUCTS = 50
export const REPORT_ORDERS_PER_PRODUCT = 20

export interface DayReportOut {
  dzien: string
  stanNa: string
  sprzedaz: {
    zamowien: number
    /**
     * zamówienia w PLN plus obce waluty przeliczone po kursie średnim NBP (informacyjnie); `inneWaluty` =
     * rozbicie (kwota w walucie, kurs, data kursu, kwota w złotych; waluta bez kursu ma `bruttoPln: null` i nie wchodzi do `brutto`)
     */
    brutto: number
    inneWaluty: WalutaApi[]
    konta: { konto: string; nazwa: string; zamowien: number; brutto: number; inneWaluty: WalutaApi[] }[]
    pozaRealizacja: { przedStartem: number; nieprzyjete: number; pominiete: number; anulowane: number }
  }
  praca: {
    doSpakowania: number
    brakujePozycji: number
    zamowienZBrakami: number
    doWyjasnienia: number
    nieoplaconeZRezerwacja: number
    fakturaNieWystawiona: number
    ruchyDoPoprawyWfirmie: number
    nadmiaryRezerwacji: number
  }
  wyslaneDzis: number
}

/** Liczby dnia (Europe/Warsaw) jak pulpit „Dziś” + zamówienia oznaczone dziś jako wysłane. */
export async function dayReport(db: PrismaClient, now = new Date()): Promise<DayReportOut> {
  const d = await dashboard(db, now)
  const r = warsawRanges(now)
  const shipped = await db.orderEvent.findMany({
    where: { kind: 'WYSLANE', createdAt: { gte: r.dayStart, lt: r.dayEnd } },
    distinct: ['orderId'],
    select: { orderId: true },
  })
  // allowlista: alerty (treść), stan kanałów i cienia zostają na pulpicie
  return {
    dzien: toWarsaw(now).day,
    stanNa: now.toISOString(),
    sprzedaz: {
      zamowien: d.today.count,
      brutto: d.today.gross,
      inneWaluty: obceDoApi(d.today.foreign),
      konta: d.today.perAccount.map((a) => ({ konto: a.key, nazwa: a.name, zamowien: a.count, brutto: a.gross, inneWaluty: obceDoApi(a.foreign) })),
      pozaRealizacja: { przedStartem: d.today.outside.beforeStart, nieprzyjete: d.today.outside.notIngested, pominiete: d.today.outside.skipped, anulowane: d.today.outside.cancelled },
    },
    praca: {
      doSpakowania: d.work.toPack,
      brakujePozycji: d.work.shortageLinesAll, // dawna definicja (z „do zwrotu”), bez zmiany dla systemów zewnętrznych
      zamowienZBrakami: d.work.shortageOrdersAll,
      doWyjasnienia: d.work.clarify,
      nieoplaconeZRezerwacja: d.work.unpaid,
      fakturaNieWystawiona: d.work.invoiceFailed,
      ruchyDoPoprawyWfirmie: d.work.wfirmaFix,
      nadmiaryRezerwacji: d.work.overcommit,
    },
    wyslaneDzis: shipped.length,
  }
}

export interface ReportOrderRef {
  kanal: Channel
  konto: string
  numer: string
  numerBl: number | null
  status: OrderStatus
}

export interface ShortageItemOut {
  sku: string
  nazwa: string
  jednostka: Unit
  brakuje: number
  dostepne: number
  zamowien: number
  zamowienia: ReportOrderRef[]
}

export interface ReservationOrderOut extends ReportOrderRef {
  platnosc: PaymentState
  ilosc: number
  od: string
}

export interface ReservationItemOut {
  sku: string
  nazwa: string
  jednostka: Unit
  fizycznie: number
  zarezerwowane: number
  dostepne: number
  zamowien: number
  zamowienia: ReservationOrderOut[]
}

export interface ReportQuery {
  skus?: string[]
  limit: number
}

export function reportQuery(v: { sku?: string | string[] | null; limit?: number | null }): ReportQuery {
  const limit = v.limit === null || v.limit === undefined ? REPORT_DEFAULT_PRODUCTS : v.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > REPORT_MAX_PRODUCTS) throw new ApiInputError(`limit: liczba całkowita 1–${REPORT_MAX_PRODUCTS}`, 'limit')
  if (v.sku === null || v.sku === undefined) return { limit }
  const skus = [...new Set((Array.isArray(v.sku) ? v.sku : v.sku.split(',')).map((s) => s.trim()).filter(Boolean))]
  if (!skus.length) throw new ApiInputError('Pusta lista sku', 'sku')
  if (skus.length > MAX_SKUS) throw new ApiInputError(`Najwyżej ${MAX_SKUS} SKU w jednym żądaniu`, 'sku')
  if (skus.some((s) => s.length > 100)) throw new ApiInputError('SKU dłuższe niż 100 znaków', 'sku')
  return { skus, limit }
}

export function parseReportQuery(sp: URLSearchParams): ReportQuery {
  for (const k of sp.keys()) if (k !== 'sku' && k !== 'limit') throw new ApiInputError(`Nieznany parametr ${k}`, k)
  const limitRaw = sp.get('limit')
  return reportQuery({ sku: sp.getAll('sku').length ? sp.getAll('sku').join(',') : null, limit: limitRaw === null ? null : Number(limitRaw) })
}

const ORDER_REF = { id: true, channel: true, channelAccountId: true, externalId: true, blOrderId: true, status: true, paymentState: true } as const
const ref = (o: { channel: Channel; channelAccountId: string; externalId: string; blOrderId: number | null; status: OrderStatus }): ReportOrderRef => ({
  kanal: o.channel,
  konto: o.channelAccountId,
  numer: o.externalId,
  numerBl: o.blOrderId,
  status: o.status,
})

async function productsOf(db: PrismaClient, q: ReportQuery): Promise<string[] | null> {
  if (!q.skus) return null
  return (await db.product.findMany({ where: { sku: { in: q.skus } }, select: { id: true } })).map((p) => p.id)
}

/**
 * Górna granica wierszy braków/rezerwacji czytanych do jednego raportu. Ponad nią ranking liczy
 * się na najstarszych wierszach, więc raport mówi `wiecej: true`, a opis narzędzia każe zawęzić listą sku.
 */
export const REPORT_MAX_ROWS = 5000

/** Produkty z otwartym brakiem (najwięcej brakujących sztuk pierwsze) i zamówienia, które na nie czekają. */
export async function shortagesReport(db: PrismaClient, q: ReportQuery): Promise<{ pozycje: ShortageItemOut[]; wiecej: boolean }> {
  const only = await productsOf(db, q)
  const rows = await db.shortage.findMany({
    where: { AND: [OPEN_SHORTAGE, ...(only ? [{ productId: { in: only } }] : [])] },
    select: { productId: true, qtyBase: true, createdAt: true, order: { select: ORDER_REF } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: REPORT_MAX_ROWS + 1,
  })
  const przyciete = rows.length > REPORT_MAX_ROWS
  if (przyciete) rows.length = REPORT_MAX_ROWS
  const byProduct = new Map<string, { qty: number; orders: Map<string, ReportOrderRef> }>()
  for (const s of rows) {
    const e = byProduct.get(s.productId) ?? { qty: 0, orders: new Map() }
    e.qty += s.qtyBase
    e.orders.set(s.order.id, ref(s.order))
    byProduct.set(s.productId, e)
  }
  const sorted = [...byProduct.entries()].sort((a, b) => b[1].qty - a[1].qty || a[0].localeCompare(b[0]))
  const page = sorted.slice(0, q.limit)
  const info = await productInfo(db, page.map(([id]) => id))
  return {
    pozycje: page.map(([id, e]) => {
      const p = info.get(id)
      return {
        sku: p?.sku ?? '?',
        nazwa: p?.title ?? '?',
        jednostka: p?.unit ?? 'SZT',
        brakuje: e.qty,
        dostepne: p?.available ?? 0,
        zamowien: e.orders.size,
        zamowienia: [...e.orders.values()].slice(0, REPORT_ORDERS_PER_PRODUCT),
      }
    }),
    wiecej: przyciete || sorted.length > q.limit,
  }
}

/** Aktywne rezerwacje po produkcie (najwięcej zarezerwowanych pierwsze) z zamówieniami, które je trzymają. */
export async function reservationsReport(db: PrismaClient, q: ReportQuery): Promise<{ pozycje: ReservationItemOut[]; wiecej: boolean }> {
  const only = await productsOf(db, q)
  const rows = await db.reservation.findMany({
    where: { state: { in: ['ACTIVE', 'CONSUMING'] }, warehouseId: DEFAULT_WAREHOUSE, ...(only ? { productId: { in: only } } : {}) },
    select: { productId: true, qtyBase: true, createdAt: true, order: { select: ORDER_REF } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: REPORT_MAX_ROWS + 1,
  })
  const przyciete = rows.length > REPORT_MAX_ROWS
  if (przyciete) rows.length = REPORT_MAX_ROWS
  const byProduct = new Map<string, { qty: number; orders: Map<string, ReservationOrderOut> }>()
  for (const r of rows) {
    const e = byProduct.get(r.productId) ?? { qty: 0, orders: new Map() }
    e.qty += r.qtyBase
    const prev = e.orders.get(r.order.id)
    if (prev) prev.ilosc += r.qtyBase
    else e.orders.set(r.order.id, { ...ref(r.order), platnosc: r.order.paymentState, ilosc: r.qtyBase, od: r.createdAt.toISOString() })
    byProduct.set(r.productId, e)
  }
  const sorted = [...byProduct.entries()].sort((a, b) => b[1].qty - a[1].qty || a[0].localeCompare(b[0]))
  const page = sorted.slice(0, q.limit)
  const info = await productInfo(db, page.map(([id]) => id))
  return {
    pozycje: page.map(([id, e]) => {
      const p = info.get(id)
      return {
        sku: p?.sku ?? '?',
        nazwa: p?.title ?? '?',
        jednostka: p?.unit ?? 'SZT',
        fizycznie: p?.physical ?? 0,
        zarezerwowane: p?.reserved ?? 0,
        dostepne: p?.available ?? 0,
        zamowien: e.orders.size,
        zamowienia: [...e.orders.values()].slice(0, REPORT_ORDERS_PER_PRODUCT),
      }
    }),
    wiecej: przyciete || sorted.length > q.limit,
  }
}

async function productInfo(db: PrismaClient, ids: string[]) {
  if (!ids.length) return new Map<string, { sku: string; title: string; unit: Unit; physical: number; reserved: number; available: number }>()
  const [products, stocks] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, title: true, unit: true } }),
    db.stock.findMany({ where: { warehouseId: DEFAULT_WAREHOUSE, productId: { in: ids } }, select: { productId: true, physical: true, reserved: true } }),
  ])
  const st = new Map(stocks.map((s) => [s.productId, s]))
  return new Map(
    products.map((p) => {
      const s = st.get(p.id)
      return [p.id, { sku: p.sku, title: p.title, unit: p.unit, physical: s?.physical ?? 0, reserved: s?.reserved ?? 0, available: s ? availableOf(s) : 0 }]
    }),
  )
}
