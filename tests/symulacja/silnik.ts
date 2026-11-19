// Symulacja sezonu (spec 11, przypadki 48–50). Dane wyłącznie syntetyczne: katalog i zamówienia generowane
// ziarnem RNG, rozkład dzienny = zagregowane liczby zamówień prawdziwego sklepu z XII 2025
// (same liczby, bez danych klientów) przeskalowane × 1,337. Atrapy wFirmy i kanałów w pamięci, zero sieci.
import type { Channel, PaymentState, PrismaClient } from '@prisma/client'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { type GoodCount, type OdczytStanowWfirma, requestFullRead, runWfirmaQueueExclusive } from '@/lib/rdzen/kolejka-wfirmy'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { checkInvariants } from '@/lib/rdzen/niezmienniki'
import { type AdapterStanow, type PushItem, recordOrderPoll, runFanout, runStockPush } from '@/lib/rdzen/propagacja'
import { zRejestrem } from '@/lib/kanaly/rejestr-synchronizacji'
import { allocationGuard, processAllocateEvents } from '@/lib/rdzen/przydzial'
import { type FakturyWfirma, type FoundInvoice, type InvoiceLine, type IssueResult, issueInvoice, officeConfirmManual, packOrder } from '@/lib/rdzen/rozchod'
import { DEFAULT_WAREHOUSE, txStats } from '@/lib/rdzen/stan'
import { type IncomingOrder, ingestOrder, markPaid, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { isBusinessInstant, toWarsaw } from '@/lib/rdzen/kalendarz'

// ─── RNG i statystyka ────────────────────────────────────────────────────────

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
}

const round1 = (x: number) => Math.round(x * 10) / 10

// Zagregowany rozkład dzienny SD, XII 2025 (1 219 zamówień).
export const SD_GRUDZIEN_2025 = [46, 47, 48, 58, 40, 38, 49, 63, 64, 55, 77, 50, 60, 79, 84, 75, 51, 51, 55, 24, 23, 5, 5, 3, 4, 9, 17, 13, 13, 9, 4]

export function dailyCounts(total: number): number[] {
  const sum = SD_GRUDZIEN_2025.reduce((a, b) => a + b, 0)
  const raw = SD_GRUDZIEN_2025.map((d) => (d * total) / sum)
  const out = raw.map(Math.floor)
  let left = total - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    out[i]!++
    left--
  }
  return out
}

// ─── Katalog ─────────────────────────────────────────────────────────────────

// trzy sklepy Woo = trzy konta kanału WOO; `label` (nazwy sprzed zmiany) zostaje w id ofert i w raporcie,
// żeby wynik dało się porównać 1:1 z pierwszym przebiegiem (commit 6b298ee).
export const SIM_CHANNELS: { label: string; channel: Channel; account: string; share: number }[] = [
  { label: 'WOO_SD', channel: 'WOO', account: 'sd', share: 0.75 },
  { label: 'ALLEGRO', channel: 'ALLEGRO', account: 'allegro', share: 0.17 },
  { label: 'EMPIK', channel: 'EMPIK', account: 'empik', share: 0.04 },
  { label: 'WOO_LAMPY', channel: 'WOO', account: 'lampy', share: 0.02 },
  { label: 'WOO_KOLOROWYKUBEK', channel: 'WOO', account: 'km', share: 0.02 },
]

export function simLabelOf(o: { channel: Channel; channelAccountId: string }): string {
  return SIM_CHANNELS.find((c) => c.channel === o.channel && c.account === o.channelAccountId)?.label ?? `${o.channel}/${o.channelAccountId}`
}

const accOf = (c: (typeof SIM_CHANNELS)[number]) => ({ channel: c.channel, channelAccountId: c.account })

export interface SimItem {
  id: string
  kind: 'STOCKED' | 'BUNDLE'
  unit: 'SZT' | 'KG'
  group: 'KOMPLET' | 'KG' | 'TOWAR' | 'ZESTAW' | 'GORACY'
  weight: number
  perOffer: number
}

export interface Catalog {
  items: SimItem[]
  cumulative: number[]
  hot: SimItem[]
  stockIds: string[]
}

export async function seedCatalog(
  db: PrismaClient,
  r: () => number,
  opts: {
    komplety: number
    kg: number
    towary: number
    zestawy: number
    hot?: number
    expectedLines: number
    stockFactor?: [number, number]
    hotStock?: [number, number]
    /** Przedrostek id produktów (druga firma w tej samej bazie: id produktu jest globalne). Bez „-”. */
    idPrefix?: string
  },
): Promise<Catalog> {
  const prefix = opts.idPrefix ?? ''
  if (prefix.includes('-')) throw new Error('idPrefix bez „-” (id ofert dzielone po „-”)')
  await db.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (symulacja)', wfirmaWarehouseId: '999001', stockSource: 'WFIRMA' } })
  await db.channelConfig.createMany({
    data: [
      ...SIM_CHANNELS.map((c) => ({ channel: c.channel, channelAccountId: c.account, name: `${c.label} sym`, adapterKey: DEFAULT_CHANNEL_ADAPTER[c.channel] })),
      { channel: 'RECZNE' as Channel, channelAccountId: 'panel', name: 'panel', adapterKey: DEFAULT_CHANNEL_ADAPTER.RECZNE },
    ],
  })
  const items: SimItem[] = []
  let n = 0
  const add = (group: SimItem['group'], count: number) => {
    for (let i = 0; i < count; i++) {
      const id = `${prefix}sym-${String(n++).padStart(4, '0')}`
      items.push({ id, kind: group === 'ZESTAW' ? 'BUNDLE' : 'STOCKED', unit: group === 'KG' ? 'KG' : 'SZT', group, weight: 0, perOffer: group === 'KG' ? 100 : 1 })
    }
  }
  add('KOMPLET', opts.komplety)
  add('KG', opts.kg)
  add('TOWAR', opts.towary)
  add('ZESTAW', opts.zestawy)
  // popularność wg Zipfa po losowej permutacji (zestawy i kg nie są z góry na szczycie)
  const perm = items.map((_, i) => i).sort(() => r() - 0.5)
  perm.forEach((idx, rank) => (items[idx]!.weight = 1 / (rank + 1)))
  const hot: SimItem[] = []
  for (let i = 0; i < (opts.hot ?? 0); i++) {
    const it: SimItem = { id: `${prefix}hot-${i}`, kind: 'STOCKED', unit: 'SZT', group: 'GORACY', weight: 0, perOffer: 1 }
    hot.push(it)
    items.push(it)
  }
  const wSum = items.reduce((s, x) => s + x.weight, 0)
  const towary = items.filter((x) => x.group === 'TOWAR')
  const [fLo, fHi] = opts.stockFactor ?? [0.4, 1.6]
  await db.product.createMany({
    data: items.map((x) => ({ id: x.id, sku: x.id, wfirmaGoodId: x.kind === 'STOCKED' ? x.id : null, kind: x.kind, unit: x.unit, nameAccounting: `Towar symulacji ${x.id}`, title: `Towar symulacji ${x.id}`, priceGross: (5 + Math.floor(r() * 60)).toFixed(2), vatRate: r() < 0.3 ? '5' : '23' })),
  })
  const bundles = items.filter((x) => x.kind === 'BUNDLE')
  await db.bundleComponent.createMany({
    data: bundles.flatMap((b) => {
      const c1 = towary[Math.floor(r() * towary.length)]!
      let c2 = towary[Math.floor(r() * towary.length)]!
      while (c2.id === c1.id) c2 = towary[Math.floor(r() * towary.length)]!
      return [
        { bundleId: b.id, componentId: c1.id, qtyBase: 1 },
        { bundleId: b.id, componentId: c2.id, qtyBase: 1 + Math.floor(r() * 2) },
      ]
    }),
  })
  const stockIds = items.filter((x) => x.kind === 'STOCKED').map((x) => x.id)
  const readAt = new Date('2025-11-30T00:00:00Z')
  await db.stock.createMany({
    data: items
      .filter((x) => x.kind === 'STOCKED')
      .map((x) => {
        let count: number
        if (x.group === 'GORACY') count = opts.hotStock![0] + Math.floor(r() * (opts.hotStock![1] - opts.hotStock![0] + 1))
        else {
          const demand = (opts.expectedLines * x.weight) / wSum
          const factor = fLo + r() * (fHi - fLo)
          count = Math.max(0, Math.round(demand * factor * 1.2)) * (x.unit === 'KG' ? 150 : 1)
        }
        return { productId: x.id, warehouseId: DEFAULT_WAREHOUSE, wfirmaCount: count, physical: count, wfirmaReadAt: readAt }
      }),
  })
  await db.channelOffer.createMany({
    data: items.flatMap((x) => SIM_CHANNELS.map((c) => ({ channel: c.channel, channelAccountId: c.account, externalId: `${c.label}-${x.id}`, productId: x.id, qtyBasePerOffer: x.perOffer, lastPushedQty: 0, lastPushedAt: readAt }))),
  })
  const cumulative: number[] = []
  let acc = 0
  for (const x of items) cumulative.push((acc += x.weight / wSum))
  return { items, cumulative, hot, stockIds }
}

function pick(cat: Catalog, r: () => number): SimItem {
  const u = r()
  let lo = 0
  let hi = cat.cumulative.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cat.cumulative[mid]! < u) lo = mid + 1
    else hi = mid
  }
  return cat.items[lo]!
}

function linesCount(r: () => number): number {
  // średnio ~3,03, zakres 1–16: 1 + Poisson(2,03)
  const L = Math.exp(-2.03)
  let k = 0
  let p = 1
  do {
    k++
    p *= r()
  } while (p > L)
  return Math.min(16, Math.max(1, k))
}

function pickChannel(r: () => number) {
  const u = r()
  let acc = 0
  for (const c of SIM_CHANNELS) if (u < (acc += c.share)) return c
  return SIM_CHANNELS[0]!
}

const globalSeq = { n: 0 }
/** `seq`: licznik numerów zamówień (osobny per firma w symulacji dwóch firm — te same SYM-1… w obu). */
export function genOrder(cat: Catalog, r: () => number, at: Date, opts: { hotShare?: number; payment?: PaymentState; seq?: { n: number } } = {}): IncomingOrder {
  const seq = opts.seq ?? globalSeq
  const ch = pickChannel(r)
  const n = linesCount(r)
  const used = new Set<string>()
  const lines: IncomingOrder['lines'] = []
  const forceHot = opts.hotShare && r() < opts.hotShare && cat.hot.length
  for (let i = 0; i < n; i++) {
    let it = forceHot && i === 0 ? cat.hot[Math.floor(r() * cat.hot.length)]! : pick(cat, r)
    for (let g = 0; g < 5 && used.has(it.id); g++) it = pick(cat, r)
    if (used.has(it.id)) continue
    used.add(it.id)
    const u = r()
    const qty = it.unit === 'KG' ? 1 + Math.floor(r() * 3) : u < 0.85 ? 1 : u < 0.97 ? 2 : 3
    lines.push({ externalLineId: `L${i + 1}`, offerExternalId: `${ch.label}-${it.id}`, qty, unitPriceGross: 10 + Math.floor(r() * 50) })
  }
  const u = r()
  const payment: PaymentState = opts.payment ?? (u < 0.06 ? 'COD' : u < 0.14 ? 'UNPAID' : 'PAID')
  return {
    source: 'symulacja',
    channel: ch.channel,
    channelAccountId: ch.account,
    externalId: `SYM-${++seq.n}`,
    externalRevision: '1',
    createdAtChannel: at,
    paymentState: payment,
    paymentMethod: payment === 'COD' ? 'pobranie' : payment === 'UNPAID' ? 'przelew' : 'BLIK',
    totalGross: lines.reduce((s, l) => s + l.qty * l.unitPriceGross, 0),
    deliveryMethod: ch.channel === 'ALLEGRO' ? 'Allegro One Box' : ch.channel === 'EMPIK' ? 'Dostawa do Salonu Empik' : 'Paczkomaty InPost',
    lines,
  }
}

// ─── Atrapa wFirmy w symulacji ───────────────────────────────────────────────

export class SimWfirma implements FakturyWfirma, OdczytStanowWfirma {
  counts = new Map<string, number>()
  invoices: FoundInvoice[] = []
  oversold = 0 // faktura zdjęła więcej, niż było w magazynie wFirmy
  noWz: { productId: string; qty: number; docId: string }[] = []
  /** Produkty w kg: `counts` w gramach (jednostka bazowa), odczyt oddaje jak wFirma, w kg. */
  kg = new Set<string>()
  issues = 0
  timeouts = 0
  limits = 0
  private pageSize = 100
  constructor(private r: () => number, private noWzRate = 0.01, private fail: { timeoutRate?: number; limitEvery?: number } = {}) {}

  private toGood(id: string): GoodCount {
    const c = this.counts.get(id) ?? 0
    return { wfirmaGoodId: id, count: this.kg.has(id) ? c / 1000 : c }
  }

  async readGoods(goodIds: string[]): Promise<GoodCount[]> {
    return goodIds.map((g) => this.toGood(g))
  }

  async readGoodsPage(page: number): Promise<{ items: GoodCount[]; last: boolean }> {
    const ids = [...this.counts.keys()].sort()
    return { items: ids.slice((page - 1) * this.pageSize, page * this.pageSize).map((g) => this.toGood(g)), last: page * this.pageSize >= ids.length }
  }

  async issue(req: { idExternal: string; lines: InvoiceLine[] }): Promise<IssueResult> {
    this.issues++
    if (this.fail.limitEvery && this.issues % this.fail.limitEvery === 0) {
      this.limits++
      return { kind: 'LIMIT', message: 'symulacja: TOTAL REQUESTS LIMIT EXCEEDED' }
    }
    // timeout: połowa dokumentów powstaje w wFirmie (odpowiedź nie doszła), połowa nie
    const timeout = !!this.fail.timeoutRate && this.r() < this.fail.timeoutRate
    if (timeout) {
      this.timeouts++
      if (this.r() < 0.5) return { kind: 'TIMEOUT' }
    }
    const docId = `FV/SYM/${this.invoices.length + 1}`
    const wz: Record<string, number | null> = {}
    const per = new Map<string, number>()
    for (const l of req.lines) per.set(l.productId, (per.get(l.productId) ?? 0) + l.qty)
    for (const [p, q] of per) {
      const none = this.r() < this.noWzRate
      wz[p] = none ? 0 : q
      if (none) this.noWz.push({ productId: p, qty: q, docId })
      else {
        const c = (this.counts.get(p) ?? 0) - q
        if (c < 0) this.oversold++
        this.counts.set(p, c)
      }
    }
    this.invoices.push({ docId, idExternal: req.idExternal, wz })
    if (timeout) return { kind: 'TIMEOUT' }
    return { kind: 'OK', docId, wz }
  }

  async findByPrefix(prefix: string): Promise<FoundInvoice[]> {
    return this.invoices.filter((i) => i.idExternal.startsWith(prefix))
  }
}

// ─── 48: grudzień realny ─────────────────────────────────────────────────────

type Ev = { t: number; kind: 'ORDER' | 'PAY' | 'PACK' | 'READ' | 'FIX' | 'DELIVERY' | 'TICK' | 'HOURLY' | 'NIGHTLY' | 'DAYCHECK'; data?: unknown }

class Queue {
  private h: Ev[] = []
  push(e: Ev) {
    this.h.push(e)
    let i = this.h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.h[p]!.t <= this.h[i]!.t) break
      ;[this.h[p], this.h[i]] = [this.h[i]!, this.h[p]!]
      i = p
    }
  }
  pop(): Ev | undefined {
    const top = this.h[0]
    const last = this.h.pop()
    if (this.h.length && last) {
      this.h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const rr = l + 1
        let m = i
        if (l < this.h.length && this.h[l]!.t < this.h[m]!.t) m = l
        if (rr < this.h.length && this.h[rr]!.t < this.h[m]!.t) m = rr
        if (m === i) break
        ;[this.h[m], this.h[i]] = [this.h[i]!, this.h[m]!]
        i = m
      }
    }
    return top
  }
  get size() {
    return this.h.length
  }
}

function nextWorkSlot(t: number, r: () => number): number {
  // pakowanie: dni robocze 8–16 (Warszawa)
  let x = t
  for (let i = 0; i < 24 * 14; i++) {
    const d = new Date(x)
    const h = Math.floor(toWarsaw(d).msOfDay / 3600_000)
    if (isBusinessInstant(d) && h >= 8 && h < 16) return x + Math.floor(r() * 30 * 60_000)
    x += 3600_000
  }
  return x
}

export interface DecemberReport {
  orders: number
  perChannel: Record<string, number>
  lines: number
  ordersWithShortage: number
  shortageUnits: number
  ordersWithShortageWithoutRow: number
  ingestMs: { p50: number; p95: number; max: number }
  invoices: number
  invoicesWithoutWz: number
  oversoldInvoices: number
  deliveries: number
  paidLate: number
  expired: number
  refundPending: number
  codReduced: number
  invariantChecks: number
  invariantViolations: number
  txRetries: number
  alerts: Record<string, number>
  /** Tylko niezamknięte: to widzi biuro na koniec okresu. */
  alertsOpen: Record<string, number>
  reads: number
  wallSeconds: number
  queue?: QueueReport
}

/** Wynik toru `viaQueue`: faktury i odczyty jednym torem `runWfirmaQueueExclusive`, z timeoutami i limitem wFirmy. */
export interface QueueReport {
  runs: number
  maxCalls: number
  maxCallsInRun: number
  pausedRuns: number
  fullReads: number
  timeouts: number
  limits: number
  doubleInvoices: number
  notInvoicedAtEnd: number
  unknownAtEnd: number
  invoiceErrorFlags: number
}

export const SIM_QUEUE_MAX_CALLS = 20

export async function runDecember(
  db: PrismaClient,
  opts: {
    seed?: number
    total?: number
    log?: (s: string) => void
    idPrefix?: string
    seq?: { n: number }
    viaQueue?: boolean
    /** po każdym kroku zamówienia (przyjęcie, płatność, pakowanie) i po przebiegu co 5 min (orderId = null) */
    poKroku?: (kind: 'ORDER' | 'PAY' | 'PACK' | 'TICK', orderId: string | null, now: Date) => Promise<void>
    /** metoda dostawy zamiast domyślnej (deterministycznie, bez losowania: ciąg zamówień bez zmian) */
    metodaDostawy?: (o: IncomingOrder) => string | null
    /** odstęp przebiegów (rezerwacje, przydział, propagacja) w minutach; domyślnie 5 jak na produkcji */
    tickMin?: number
  } = {},
): Promise<DecemberReport> {
  const wall = Date.now()
  const r = rng(opts.seed ?? 20251201)
  const total = opts.total ?? 1630
  const cat = await seedCatalog(db, r, { komplety: 600, kg: 50, towary: 139, zestawy: 11, expectedLines: total * 3.03, idPrefix: opts.idPrefix })
  const wf = new SimWfirma(r, 0.01, opts.viaQueue ? { timeoutRate: 0.02, limitEvery: 300 } : {})
  for (const s of await db.stock.findMany()) wf.counts.set(s.productId, s.wfirmaCount)
  for (const it of cat.items) if (it.unit === 'KG') wf.kg.add(it.id)
  const qr: QueueReport = { runs: 0, maxCalls: SIM_QUEUE_MAX_CALLS, maxCallsInRun: 0, pausedRuns: 0, fullReads: 0, timeouts: 0, limits: 0, doubleInvoices: 0, notInvoicedAtEnd: 0, unknownAtEnd: 0, invoiceErrorFlags: 0 }
  const q = new Queue()
  const start = Date.UTC(2025, 11, 1, 0, 0, 0) - 3600_000 // 1.12 00:00 w Warszawie
  const days = dailyCounts(total)
  days.forEach((n, d) => {
    for (let i = 0; i < n; i++) {
      // godziny 7–23 z przewagą wieczoru
      const h = 7 + Math.floor(Math.pow(r(), 0.7) * 16)
      q.push({ t: start + d * 86_400_000 + h * 3600_000 + Math.floor(r() * 3600_000), kind: 'ORDER' })
    }
  })
  const end = start + 31 * 86_400_000 + 3 * 86_400_000 // + 3 dni na dokończenie
  for (let t = start; t < end; t += (opts.tickMin ?? 5) * 60_000) q.push({ t, kind: 'TICK' })
  for (let d = 0; d < 34; d++) {
    for (let h = 7; h <= 22; h++) q.push({ t: start + d * 86_400_000 + h * 3600_000 + 30 * 60_000, kind: 'HOURLY' })
    q.push({ t: start + d * 86_400_000 + 23 * 3600_000 + 45 * 60_000, kind: 'NIGHTLY' })
    q.push({ t: start + d * 86_400_000 + 23 * 3600_000 + 55 * 60_000, kind: 'DAYCHECK' })
    const dow = new Date(start + d * 86_400_000 + 12 * 3600_000).getUTCDay()
    if (dow === 2 || dow === 5) q.push({ t: start + d * 86_400_000 + 9 * 3600_000, kind: 'DELIVERY' })
  }
  const rep: DecemberReport = {
    orders: 0, perChannel: {}, lines: 0, ordersWithShortage: 0, shortageUnits: 0, ordersWithShortageWithoutRow: 0,
    ingestMs: { p50: 0, p95: 0, max: 0 }, invoices: 0, invoicesWithoutWz: 0, oversoldInvoices: 0, deliveries: 0, paidLate: 0,
    expired: 0, refundPending: 0, codReduced: 0, invariantChecks: 0, invariantViolations: 0, txRetries: 0, alerts: {}, alertsOpen: {}, reads: 0, wallSeconds: 0,
  }
  const lat: number[] = []
  const dirty = new Set<string>()
  const retries0 = txStats.retries
  const weeklyDemand = new Map<string, number>()
  const read = async (productId: string, t: number) => {
    await applyStockRead(db, { productId, countBase: wf.counts.get(productId) ?? 0, requestSentAt: new Date(t) }, { now: new Date(t) })
    rep.reads++
  }
  let ev: Ev | undefined
  while ((ev = q.pop())) {
    const now = new Date(ev.t)
    if (ev.kind === 'ORDER') {
      const o = genOrder(cat, r, now, { seq: opts.seq })
      if (opts.metodaDostawy) o.deliveryMethod = opts.metodaDostawy(o) ?? o.deliveryMethod
      const t0 = performance.now()
      const res = await ingestOrder(db, o, { now })
      lat.push(performance.now() - t0)
      if (opts.poKroku && res.orderId) await opts.poKroku('ORDER', res.orderId, now)
      rep.orders++
      rep.lines += o.lines.length
      const label = simLabelOf(o)
      rep.perChannel[label] = (rep.perChannel[label] ?? 0) + 1
      for (const l of o.lines) weeklyDemand.set(l.offerExternalId!.split('-').slice(1).join('-'), (weeklyDemand.get(l.offerExternalId!.split('-').slice(1).join('-')) ?? 0) + l.qty)
      if (res.shortUnits > 0) {
        rep.ordersWithShortage++
        rep.shortageUnits += res.shortUnits
        if (!(await db.shortage.count({ where: { orderId: res.orderId! } }))) rep.ordersWithShortageWithoutRow++
      }
      if (o.paymentState === 'UNPAID') {
        if (r() < 0.5) q.push({ t: ev.t + 2 * 3600_000 + Math.floor(r() * 40 * 3600_000), kind: 'PAY', data: res.orderId })
      } else q.push({ t: nextWorkSlot(ev.t + 3600_000, r), kind: 'PACK', data: res.orderId })
    } else if (ev.kind === 'PAY') {
      const st = await markPaid(db, ev.data as string, 'PAID', { now })
      rep.paidLate++
      if (opts.poKroku) await opts.poKroku('PAY', ev.data as string, now)
      if (st === 'DO_REALIZACJI') q.push({ t: nextWorkSlot(ev.t + 3600_000, r), kind: 'PACK', data: ev.data })
    } else if (ev.kind === 'PACK') {
      const id = ev.data as string
      const o = await db.order.findUniqueOrThrow({ where: { id } })
      if (o.status !== 'DO_REALIZACJI') continue
      const active = await db.reservation.count({ where: { orderId: id, state: 'ACTIVE' } })
      if (!active) {
        // brak wszystkiego: czeka na dostawę, próba jutro (po terminie trafi do „Do wyjaśnienia”)
        q.push({ t: nextWorkSlot(ev.t + 86_400_000, r), kind: 'PACK', data: id })
        continue
      }
      const p = await packOrder(db, id, { now })
      rep.refundPending += p.refund
      rep.codReduced += p.codReduced
      if (opts.poKroku) await opts.poKroku('PACK', id, now)
      if (opts.viaQueue) continue // fakturę wystawi kolejka w najbliższym przebiegu, razem z odczytami
      const before = wf.oversold
      const noWzBefore = wf.noWz.length
      const out = await issueInvoice(db, id, wf, { now })
      if (out === 'WYSTAWIONA') rep.invoices++
      if (wf.oversold > before) rep.oversoldInvoices++
      const inv = wf.invoices.at(-1)!
      for (const pid of Object.keys(inv.wz)) {
        dirty.add(pid)
        q.push({ t: ev.t + 2000, kind: 'READ', data: pid }) // odczyt celowany goods/get po fakturze
      }
      for (const nz of wf.noWz.slice(noWzBefore)) {
        rep.invoicesWithoutWz++
        q.push({ t: ev.t + 4 * 3600_000, kind: 'FIX', data: nz })
      }
    } else if (ev.kind === 'READ') {
      await read(ev.data as string, ev.t)
    } else if (ev.kind === 'FIX') {
      // biuro poprawia WZ w wFirmie i klika „poprawione”; odczyt wysłany po kliknięciu potwierdza
      const nz = ev.data as { productId: string; qty: number; docId: string }
      wf.counts.set(nz.productId, (wf.counts.get(nz.productId) ?? 0) - nz.qty)
      if ((wf.counts.get(nz.productId) ?? 0) < 0) rep.oversoldInvoices++
      const ms = await db.pendingMovement.findMany({ where: { productId: nz.productId, wfirmaDocId: nz.docId, state: 'MANUAL' } })
      for (const m of ms) await officeConfirmManual(db, m.id, { now })
      if (!opts.viaQueue) q.push({ t: ev.t + 2000, kind: 'READ', data: nz.productId }) // w kolejce: zdarzenie WFIRMA_READ
    } else if (ev.kind === 'DELIVERY') {
      rep.deliveries++
      // dostawa (PZ / kompletacja w wFirmie) dla produktów z niskim stanem względem popytu tygodnia
      const stocks = await db.stock.findMany({ orderBy: { productId: 'asc' } }) // kolejność deterministyczna (porównanie wyników)
      for (const s of stocks) {
        const dem = weeklyDemand.get(s.productId) ?? 0
        const avail = s.physical - s.reserved
        const it = cat.items.find((x) => x.id === s.productId)!
        const need = Math.max(dem * it.perOffer, it.unit === 'KG' ? 500 : 2)
        if (avail < need) {
          wf.counts.set(s.productId, (wf.counts.get(s.productId) ?? 0) + Math.round(need * (1 + r())))
          dirty.add(s.productId)
        }
      }
      weeklyDemand.clear()
      if (opts.viaQueue) await requestFullRead(db, { now })
    } else if (ev.kind === 'HOURLY') {
      if (opts.viaQueue) continue // odczyty celowane i pełne idą kolejką
      // pełny odczyt co godzinę: produkty bez zmian w wFirmie i bez ruchów w toku pomijane (wynik byłby identyczny)
      const withMoves = await db.pendingMovement.findMany({ where: { state: { in: ['APPLIED', 'IN_FLIGHT'] } }, select: { productId: true }, distinct: ['productId'] })
      const ids = [...new Set([...dirty, ...withMoves.map((m) => m.productId)])].sort()
      for (const id of ids) await read(id, ev.t + 1000)
      dirty.clear()
    } else if (ev.kind === 'NIGHTLY') {
      if (opts.viaQueue) {
        await requestFullRead(db, { now })
        continue
      }
      for (const id of cat.stockIds) await read(id, ev.t)
      dirty.clear()
    } else if (ev.kind === 'TICK') {
      if (opts.viaQueue) {
        // Jeden przebieg kolejki co 5 min: pakowanie i dostawy wchodzą między strony pełnego odczytu, a każde wywołanie
        // wFirmy trwa 1,5 s czasu wirtualnego, więc odczyty nakładają się na żądania faktur jak na produkcji.
        let vt = ev.t
        const noWzBefore = wf.noWz.length
        const st = await runWfirmaQueueExclusive(db, { faktury: wf, odczyt: wf }, { now, clock: () => new Date((vt += 1500)), maxCalls: SIM_QUEUE_MAX_CALLS })
        qr.runs++
        qr.maxCallsInRun = Math.max(qr.maxCallsInRun, st.calls)
        if (st.paused) qr.pausedRuns++
        if (st.fullReadDone) qr.fullReads++
        rep.reads += st.targetedReads + st.fullReadPages
        for (const nz of wf.noWz.slice(noWzBefore)) {
          rep.invoicesWithoutWz++
          q.push({ t: ev.t + 4 * 3600_000, kind: 'FIX', data: nz })
        }
      }
      const ex = await runReservationExpiry(db, { now })
      rep.expired += ex.released
      if (opts.poKroku) await opts.poKroku('TICK', null, now)
      await processAllocateEvents(db, { now })
      await allocationGuard(db, { now })
      await runFanout(db, { now })
      for (const c of SIM_CHANNELS) {
        await recordOrderPoll(db, { channel: c.channel, channelAccountId: c.account, startedAt: new Date(ev.t - 60_000), finishedAt: new Date(ev.t - 55_000), ok: true })
        await runStockPush(db, accOf(c), null, { now }) // tryb CIEN: tylko „wysłałbym”
      }
    } else if (ev.kind === 'DAYCHECK') {
      const v = await checkInvariants(db)
      rep.invariantChecks++
      rep.invariantViolations += v.length
      if (v.length && opts.log) opts.log(`[48] naruszenia ${now.toISOString()}: ${JSON.stringify(v.slice(0, 3))}`)
      if (opts.log) opts.log(`[48] ${now.toISOString().slice(0, 10)} zamówień ${rep.orders}, braków ${rep.ordersWithShortage}, faktur ${rep.invoices}, odczytów ${rep.reads}, ${Math.round((Date.now() - wall) / 1000)} s`)
    }
  }
  const v = await checkInvariants(db)
  rep.invariantChecks++
  rep.invariantViolations += v.length
  if (opts.viaQueue) {
    rep.invoices = wf.invoices.length
    rep.oversoldInvoices += wf.oversold
    const perPrefix = new Map<string, number>()
    for (const i of wf.invoices) {
      const p = i.idExternal.slice(0, i.idExternal.lastIndexOf('/'))
      perPrefix.set(p, (perPrefix.get(p) ?? 0) + 1)
    }
    qr.doubleInvoices = [...perPrefix.values()].filter((n) => n > 1).length
    qr.timeouts = wf.timeouts
    qr.limits = wf.limits
    qr.notInvoicedAtEnd = await db.order.count({ where: { status: 'SPAKOWANE', invoices: { none: { state: 'ISSUED' } } } })
    qr.unknownAtEnd = await db.invoiceAttempt.count({ where: { state: { in: ['UNKNOWN', 'SENDING'] } } })
    qr.invoiceErrorFlags = (await db.order.findMany({ where: { status: 'SPAKOWANE' }, select: { flags: true } })).filter((o) => (o.flags as { fakturaBlad?: boolean } | null)?.fakturaBlad).length
    rep.queue = qr
  }
  rep.ingestMs = { p50: round1(percentile(lat, 50)), p95: round1(percentile(lat, 95)), max: round1(Math.max(...lat)) }
  rep.txRetries = txStats.retries - retries0
  for (const a of await db.alert.groupBy({ by: ['kind'], _count: true })) rep.alerts[a.kind] = a._count
  for (const a of await db.alert.groupBy({ by: ['kind'], where: { closedAt: null }, _count: true })) rep.alertsOpen[a.kind] = a._count
  rep.wallSeconds = Math.round((Date.now() - wall) / 1000)
  return rep
}

// ─── 49: szczyt × 10 ─────────────────────────────────────────────────────────

export interface PeakReport {
  orders: number
  hotOrders: number
  concurrency: number
  spreadSeconds: number
  ingestMs: { p50: number; p95: number; max: number }
  reads: number
  allocateRuns: number
  txRetries: number
  errors: number
  invariantViolations: number
  hotOverReserved: number
  /** faktury wystawiane w trakcie szczytu, równolegle z przyjmowaniem zamówień i odczytami. */
  invoices: number
  oversoldInvoices: number
  packMs: { p50: number; p95: number; max: number }
  wallSeconds: number
}

export async function runPeak(db: PrismaClient, opts: { seed?: number; orders?: number; concurrency?: number; spreadSeconds?: number } = {}): Promise<PeakReport> {
  const wall = Date.now()
  const r = rng(opts.seed ?? 49)
  const N = opts.orders ?? 1120
  const C = opts.concurrency ?? 50
  const spread = opts.spreadSeconds ?? 120
  const cat = await seedCatalog(db, r, { komplety: 600, kg: 50, towary: 139, zestawy: 11, hot: 10, expectedLines: 1630 * 3.03, hotStock: [5, 20] })
  const wf = new SimWfirma(rng((opts.seed ?? 49) + 1), 0)
  const counts = wf.counts // faktury zdejmują z tych samych stanów, które czytają równoległe odczyty
  for (const s of await db.stock.findMany()) counts.set(s.productId, s.wfirmaCount)
  const base = Date.UTC(2026, 11, 15, 17, 0, 0)
  const orders = Array.from({ length: N }, (_, i) => genOrder(cat, r, new Date(base + i * 3000), { hotShare: 0.2 }))
  const hotOrders = orders.filter((o) => o.lines.some((l) => l.offerExternalId!.includes('-hot-'))).length
  const lat: number[] = []
  let errors = 0
  let next = 0
  const retries0 = txStats.retries
  const t0 = Date.now()
  let done = false
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= N) return
      const due = t0 + (i / N) * spread * 1000
      const wait = due - Date.now()
      if (wait > 0) await new Promise((res) => setTimeout(res, wait))
      const s = performance.now()
      try {
        const res = await ingestOrder(db, orders[i]!, { now: orders[i]!.createdAtChannel })
        if (res.orderId && res.reservedUnits > 0 && res.status === 'DO_REALIZACJI') packable.push(res.orderId)
      } catch {
        errors++
      }
      lat.push(performance.now() - s)
    }
  }
  // dwa stanowiska pakowania w szczycie: spakowanie i faktura zaraz po sobie, ok. 5 zamówień na sekundę
  const packable: string[] = []
  const packLat: number[] = []
  let invoices = 0
  const packer = async () => {
    while (!done || packable.length) {
      const id = packable.shift()
      if (!id) {
        await new Promise((res) => setTimeout(res, 50))
        continue
      }
      const s = performance.now()
      const sent = new Date(base + (Date.now() - t0) * 30)
      try {
        await packOrder(db, id, { now: sent })
        if ((await issueInvoice(db, id, wf, { now: sent, clock: () => new Date(base + (Date.now() - t0) * 30) })) === 'WYSTAWIONA') invoices++
      } catch {
        errors++
      }
      packLat.push(performance.now() - s)
      await new Promise((res) => setTimeout(res, 400))
    }
  }
  let reads = 0
  let allocateRuns = 0
  const reader = async () => {
    let k = 0
    while (!done) {
      // równoległe odczyty wFirmy: gorące produkty + losowe; co 4. przebieg dostawa na gorący produkt
      const ids = [...cat.hot.map((h) => h.id), ...Array.from({ length: 20 }, () => cat.stockIds[Math.floor(r() * cat.stockIds.length)]!)]
      if (k % 4 === 3) {
        const h = cat.hot[k % cat.hot.length]!
        counts.set(h.id, (counts.get(h.id) ?? 0) + 3)
      }
      const sent = new Date(base + (Date.now() - t0) * 30)
      for (const id of ids) {
        try {
          await applyStockRead(db, { productId: id, countBase: counts.get(id) ?? 0, requestSentAt: sent }, { now: sent })
          reads++
        } catch {
          errors++
        }
      }
      await processAllocateEvents(db, { now: sent }).then(() => allocateRuns++).catch(() => errors++)
      k++
      await new Promise((res) => setTimeout(res, 250))
    }
  }
  const readers = [reader(), reader()]
  const packers = [packer(), packer()]
  await Promise.all(Array.from({ length: C }, worker))
  done = true
  await Promise.all([...readers, ...packers])
  const v = await checkInvariants(db)
  const hotStocks = await db.stock.findMany({ where: { productId: { in: cat.hot.map((h) => h.id) } } })
  return {
    orders: N,
    hotOrders,
    concurrency: C,
    spreadSeconds: spread,
    ingestMs: { p50: round1(percentile(lat, 50)), p95: round1(percentile(lat, 95)), max: round1(Math.max(...lat)) },
    reads,
    allocateRuns,
    txRetries: txStats.retries - retries0,
    errors,
    invariantViolations: v.length,
    hotOverReserved: hotStocks.filter((s) => s.reserved > s.physical && !s.overcommitSince).length,
    invoices,
    oversoldInvoices: wf.oversold,
    packMs: { p50: round1(percentile(packLat, 50)), p95: round1(percentile(packLat, 95)), max: round1(packLat.length ? Math.max(...packLat) : 0) },
    wallSeconds: Math.round((Date.now() - wall) / 1000),
  }
}

// ─── 50: propagacja w szczycie (czas wirtualny) ──────────────────────────────

class LimitedChannel implements AdapterStanow {
  calls = 0
  items = 0
  /** stan ofert w atrapie kanału po wszystkich zapisach (porównanie przebiegu z rejestrem i bez). */
  stock = new Map<string, number>()
  constructor(public channel: Channel) {}
  async push(items: PushItem[]) {
    this.calls++
    this.items += items.length
    for (const i of items) this.stock.set(i.externalId, i.targetQty)
    return items.map((i) => ({ offerId: i.offerId, ok: true }))
  }
}

export interface PropagationReport {
  orders: number
  virtualMinutes: number
  pushes: number
  perChannel: Record<string, { calls: number; items: number; p95Sec: number; maxSec: number }>
  delaySec: { p50: number; p95: number; max: number }
  heldIncreases: number
  /** przebieg z rejestrem synchronizacji (pomija oferty bez zmiany od ostatniego udanego zapisu). */
  rejestr: boolean
  skippedUnchanged: number
  /** Końcowy stan ofert w atrapach kanałów: „kanał/oferta” → ilość. */
  finalStock: Record<string, number>
  /** wysyłki Empiku z opóźnieniem ponad 5 min: co to za oferty (uwagi w raporcie). */
  empikOver5min: { pushes: number; offers: number; hotOffers: number; waitingForPollTicks: number; worst: { offer: string; sec: number; targetQty: number }[] }
  wallSeconds: number
}

export async function runPropagation(db: PrismaClient, opts: { seed?: number; orders?: number; rejestr?: boolean } = {}): Promise<PropagationReport> {
  const wall = Date.now()
  const r = rng(opts.seed ?? 50)
  const N = opts.orders ?? 1120
  const cat = await seedCatalog(db, r, { komplety: 600, kg: 50, towary: 139, zestawy: 11, hot: 10, expectedLines: 1630 * 3.03, hotStock: [5, 20] })
  await db.channelConfig.updateMany({ data: { stockMode: 'PRACA' } }) // atrapy kanałów, zero sieci
  const adapters = new Map(SIM_CHANNELS.map((c) => [c.label, new LimitedChannel(c.channel)]))
  let clock = new Date(0)
  const pushers = new Map<string, AdapterStanow>(
    SIM_CHANNELS.map((c) => [c.label, opts.rejestr ? zRejestrem(db, accOf(c), adapters.get(c.label)!, { adapterKey: `sym.${c.channel.toLowerCase()}.v1`, now: () => clock }) : adapters.get(c.label)!]),
  )
  let skippedUnchanged = 0
  const counts = new Map((await db.stock.findMany()).map((s) => [s.productId, s.wfirmaCount]))
  const base = Date.UTC(2026, 11, 15, 17, 0, 0)
  const step = 3600_000 / N
  const pollEvery: Partial<Record<Channel, number>> = { EMPIK: 90_000 }
  const lastPoll = new Map<string, number>()
  let held = 0
  let nextOrder = 0
  let empikWaiting = 0
  for (let t = 0; t <= 3600_000 + 10 * 60_000; t += 5000) {
    const now = new Date(base + t)
    clock = now
    while (nextOrder < N && nextOrder * step <= t) {
      await ingestOrder(db, genOrder(cat, r, new Date(base + nextOrder * step), { hotShare: 0.2 }), { now })
      nextOrder++
    }
    if (t % (15 * 60_000) === 0 && t > 0) {
      // dostawa gorących produktów co 15 min (wzrosty → allocate → wstrzymane wzrosty)
      for (const h of cat.hot) {
        counts.set(h.id, (counts.get(h.id) ?? 0) + 5)
        await applyStockRead(db, { productId: h.id, countBase: counts.get(h.id)!, requestSentAt: now }, { now })
      }
    }
    // przydział 5 s po dostawie (osobny przebieg workera), jak na produkcji: fanout widzi wtedy `allocationPendingSince`.
    // Wcześniej przydział szedł przed fanoutem w tym samym kroku, więc wstrzymany wzrost nie mógł się wydarzyć (0 w raporcie).
    if (t % 10_000 === 5000) await processAllocateEvents(db, { now })
    held += (await runFanout(db, { now })).heldIncreases
    for (const c of SIM_CHANNELS) {
      const every = pollEvery[c.channel] ?? 60_000
      if ((lastPoll.get(c.label) ?? -Infinity) + every <= t) {
        await recordOrderPoll(db, { channel: c.channel, channelAccountId: c.account, startedAt: new Date(base + t - 5000), finishedAt: now, ok: true })
        lastPoll.set(c.label, t)
      }
      if (t % 10_000 === 0) {
        const st = await runStockPush(db, accOf(c), pushers.get(c.label)!, { now })
        if (c.channel === 'EMPIK') empikWaiting += st.waitingForPoll
        skippedUnchanged += st.skippedUnchanged
      }
    }
  }
  const logs = await db.channelPushLog.findMany({ where: { mode: 'PRACA' } })
  const perChannel: PropagationReport['perChannel'] = {}
  for (const c of SIM_CHANNELS) {
    const d = logs.filter((l) => l.channel === c.channel && l.channelAccountId === c.account).map((l) => l.delayMs / 1000)
    const a = adapters.get(c.label)!
    perChannel[c.label] = { calls: a.calls, items: a.items, p95Sec: round1(percentile(d, 95)), maxSec: round1(d.length ? Math.max(...d) : 0) }
  }
  const all = logs.map((l) => l.delayMs / 1000)
  const late = logs.filter((l) => l.channel === 'EMPIK' && l.delayMs > 300_000).sort((a, b) => b.delayMs - a.delayMs)
  const lateOffers = await db.channelOffer.findMany({ where: { id: { in: [...new Set(late.map((l) => l.offerId))] } }, select: { id: true, externalId: true } })
  const offerName = new Map(lateOffers.map((o) => [o.id, o.externalId]))
  const empikOver5min = {
    pushes: late.length,
    offers: lateOffers.length,
    hotOffers: lateOffers.filter((o) => o.externalId.includes('-hot-')).length,
    waitingForPollTicks: empikWaiting,
    worst: late.slice(0, 10).map((l) => ({ offer: offerName.get(l.offerId) ?? l.offerId, sec: round1(l.delayMs / 1000), targetQty: l.targetQty })),
  }
  return {
    orders: N,
    virtualMinutes: 70,
    pushes: logs.length,
    perChannel,
    delaySec: { p50: round1(percentile(all, 50)), p95: round1(percentile(all, 95)), max: round1(all.length ? Math.max(...all) : 0) },
    heldIncreases: held,
    rejestr: !!opts.rejestr,
    skippedUnchanged,
    finalStock: Object.fromEntries(SIM_CHANNELS.flatMap((c) => [...adapters.get(c.label)!.stock].map(([k, v]) => [`${c.label}/${k}`, v])).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1))),
    empikOver5min,
    wallSeconds: Math.round((Date.now() - wall) / 1000),
  }
}
