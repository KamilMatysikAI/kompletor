// Rozdział dostawy na kolejkę „brakuje” (spec 4.4). Osobna transakcja, kolejność blokad z 5.1:
// zwykły SELECT kandydatów → blokady Stock (wszystkie składniki) → pg_try_advisory_xact_lock(zamówienie)
// (zajęte = pomijamy, zamówienie po commicie samo dopisze allocate) → Shortage FOR UPDATE SKIP LOCKED.
import type { OrderStatus } from '@prisma/client'
import { addReservation, hasOpenShortage, mergeFlags } from './rezerwacja'
import { kontoWPodgladzie } from './faktura-bl'
import { alert, type Db, DEFAULT_WAREHOUSE, loadCatalog, orderLockKey, outbox, partsOf, runTx, StockBook, tryAdvisoryLock } from './stan'
import { BEFORE_PICKING } from './statusy'

/** Zdarzenie zastosowanej faktury BL (lib/rdzen/rozchod.ts, `applyBlInvoice`). */
const FAKTURA_BL = 'FAKTURA_BL'

export interface AllocateResult {
  allocatedUnits: number
  skippedLocked: number
  flagCleared: boolean
}

interface Candidate {
  shortageId: string
  orderId: string
  orderLineId: string
  productId: string
  qtyBase: number
  state: 'OPEN' | 'SHIP_LATER'
  orderStatus: OrderStatus
  paymentState: string
  createdAtChannel: Date
  organizationId: string
  channel: string
  channelAccountId: string
  externalId: string
  lineProductId: string
}

export async function allocate(
  db: Db,
  productId: string,
  ctx: { now?: Date; startedAt?: Date; warehouseId?: string } = {},
): Promise<AllocateResult> {
  const now = ctx.now ?? new Date()
  const startedAt = ctx.startedAt ?? now
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    // (a) kandydaci: SHIP_LATER zawsze, OPEN tylko zamówienia przed zbieraniem; dla produktu i zestawów, które go zawierają
    const cands = await tx.$queryRaw<Candidate[]>`
      SELECT s.id AS "shortageId", s."orderId", s."orderLineId", s."productId", s."qtyBase", s.state,
             o.status AS "orderStatus", o."paymentState", o."createdAtChannel", o."organizationId", o.channel, o."channelAccountId", o."externalId",
             l."productId" AS "lineProductId"
      FROM "Shortage" s
      JOIN "Order" o ON o.id = s."orderId"
      JOIN "OrderLine" l ON l.id = s."orderLineId"
      WHERE s.state IN ('OPEN', 'SHIP_LATER') AND o.status <> 'ANULOWANE'
        AND o.status::text = ANY(${BEFORE_PICKING as string[]}::text[])
        AND s."productId" = ${productId}
        AND NOT (EXISTS (SELECT 1 FROM "OrderEvent" e WHERE e."orderId" = o.id AND e.kind = ${FAKTURA_BL})
          AND EXISTS (SELECT 1 FROM "ChannelConfig" k WHERE k."organizationId" = o."organizationId" AND k.channel = o.channel
            AND k."channelAccountId" = o."channelAccountId" AND k."statusMode" = 'CIEN'))`
    const lineProducts = [...new Set(cands.map((c) => c.lineProductId))]
    const cat = await loadCatalog(tx, lineProducts)
    const lockIds = new Set<string>([productId])
    for (const id of lineProducts) for (const p of partsOf(cat.get(id)!)) lockIds.add(p.productId)
    // (b) blokady Stock wszystkich potrzebnych produktów w kolejności productId
    const book = await StockBook.lock(tx, wh, lockIds)
    const stock = book.get(productId)
    // grupy = pozycje; priorytet: SHIP_LATER, OPEN opłacone/pobranie, OPEN nieopłacone; w grupie od najstarszego
    const groups = new Map<string, Candidate[]>()
    for (const c of cands) groups.set(c.orderLineId, [...(groups.get(c.orderLineId) ?? []), c])
    const prio = (c: Candidate) => (c.state === 'SHIP_LATER' ? 0 : c.paymentState === 'PAID' || c.paymentState === 'COD' ? 1 : 2)
    const ordered = [...groups.values()].sort((a, b) => prio(a[0]!) - prio(b[0]!) || a[0]!.createdAtChannel.getTime() - b[0]!.createdAtChannel.getTime())
    let allocatedUnits = 0
    let skippedLocked = 0
    const touchedOrders = new Set<string>()
    for (const g of ordered) {
      const c0 = g[0]!
      const entry = cat.get(c0.lineProductId)
      if (!entry) continue
      const parts = partsOf(entry)
      // czy jest choć jedna jednostka do przydziału — bez sensu brać blokady zamówień, gdy stanu nie ma
      let possible = Infinity
      for (const p of parts) possible = Math.min(possible, Math.floor(book.available(p.productId) / p.perUnit))
      if (possible <= 0) continue
      // (c) blokada doradcza zamówienia tylko „try”
      if (!(await tryAdvisoryLock(tx, orderLockKey(c0)))) {
        skippedLocked++
        continue
      }
      // (d) ponowne sprawdzenie pod blokadą
      const order = await tx.order.findUnique({ where: { id: c0.orderId } })
      if (!order || order.status === 'ANULOWANE') continue
      // zamówienie wydane z fakturą BL (konto w podglądzie obok BL): towar już zszedł ze stanu, dostawa nie jest dla
      // niego. W trybie pracy zamówienie kończy biuro w Kompletorze, więc brak dostaje przydział jak każdy inny.
      if ((await tx.orderEvent.findFirst({ where: { orderId: order.id, kind: FAKTURA_BL }, select: { id: true } })) && (await kontoWPodgladzie(tx, order))) continue
      const rows = await tx.$queryRaw<{ id: string; productId: string; qtyBase: number; state: 'OPEN' | 'SHIP_LATER' }[]>`
        SELECT id, "productId", "qtyBase", state FROM "Shortage"
        WHERE "orderLineId" = ${c0.orderLineId} AND state IN ('OPEN', 'SHIP_LATER')
        ORDER BY "createdAt", id FOR UPDATE SKIP LOCKED`
      // także SHIP_LATER tylko przed zbieraniem: po spakowaniu podzamówienia rezerwacja nie byłaby już skonsumowana
      const eligible = BEFORE_PICKING.includes(order.status) ? rows : []
      if (!eligible.length) continue
      // jednostki brakujące per składnik (dla zestawu każdy składnik ma (n−k)·q)
      let missing = Infinity
      for (const p of parts) {
        const sum = eligible.filter((r) => r.productId === p.productId).reduce((s, r) => s + r.qtyBase, 0)
        missing = Math.min(missing, Math.floor(sum / p.perUnit))
      }
      let units = Math.min(missing, possible)
      for (const p of parts) units = Math.min(units, Math.floor(book.available(p.productId) / p.perUnit))
      if (!Number.isFinite(units) || units <= 0) continue
      for (const p of parts) {
        const need = units * p.perUnit
        const resId = await addReservation(tx, book, { orderId: c0.orderId, orderLineId: c0.orderLineId, productId: p.productId, qty: need })
        let left = need
        for (const r of eligible.filter((x) => x.productId === p.productId)) {
          if (left <= 0) break
          const take = Math.min(left, r.qtyBase)
          if (take === r.qtyBase) {
            await tx.shortage.update({ where: { id: r.id }, data: { state: 'RESOLVED', reservationId: resId, resolvedAt: now, resolvedBy: 'system:allocate' } })
          } else {
            await tx.shortage.update({ where: { id: r.id }, data: { qtyBase: r.qtyBase - take } })
            await tx.shortage.create({
              data: { orderId: c0.orderId, orderLineId: c0.orderLineId, productId: p.productId, qtyBase: take, state: 'RESOLVED', reservationId: resId, resolvedAt: now, resolvedBy: 'system:allocate' },
            })
          }
          left -= take
        }
      }
      allocatedUnits += units
      touchedOrders.add(c0.orderId)
    }
    for (const orderId of touchedOrders) {
      const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
      const open = await hasOpenShortage(tx, orderId)
      await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { brakuje: open }), shortageWaitUntil: null } })
      await tx.orderEvent.create({ data: { orderId, kind: 'PRZYDZIAL_DOSTAWY', actorId: 'system:allocate', data: { productId, zostaloBrakow: open } } })
    }
    // (5) flaga zdjęta tylko, gdy nie nowsza niż start tego przebiegu (nowszy wzrost → kolejny allocate)
    let flagCleared = false
    if (stock?.allocationPendingSince && stock.allocationPendingSince.getTime() <= startedAt.getTime()) {
      book.set(productId, { allocationPendingSince: null })
      flagCleared = true
    }
    const changed = await book.flush(tx, now)
    // wstrzymany wzrost musi zostać przeliczony na kanały, także gdy `available` się nie zmieniło w tej transakcji
    if (flagCleared && !changed.includes(productId)) await outbox(tx, 'AVAILABLE_CHANGED', productId, now)
    return { allocatedUnits, skippedLocked, flagCleared }
  })
}

/** Worker: zdarzenia ALLOCATE z outboxa, per produkt osobno (błąd jednego nie zatrzymuje reszty). */
export async function processAllocateEvents(db: Db, ctx: { now?: Date; failHook?: (productId: string) => void } = {}): Promise<{ products: number; errors: number }> {
  const now = ctx.now ?? new Date()
  const events = await db.outboxEvent.findMany({ where: { kind: 'ALLOCATE', processedAt: null }, orderBy: { createdAt: 'asc' }, take: 1000 })
  const byProduct = new Map<string, string[]>()
  for (const e of events) byProduct.set(e.productId, [...(byProduct.get(e.productId) ?? []), e.id])
  let errors = 0
  for (const [productId, ids] of byProduct) {
    try {
      ctx.failHook?.(productId)
      await allocate(db, productId, { now, startedAt: now })
      // tylko zdarzenia nie nowsze niż start tego przebiegu (jak flaga, 4.4 pkt 5): nowszy wzrost dostaje kolejny allocate
      await db.outboxEvent.updateMany({ where: { id: { in: ids }, createdAt: { lte: now } }, data: { processedAt: now } })
    } catch (e) {
      errors++
      await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, lastError: (e as Error).message.slice(0, 1000) } })
    }
  }
  return { products: byProduct.size, errors }
}

/**
 * Strażnik (4.4 pkt 2): `allocationPendingSince` starsze niż 5 min → ponowienie allocate + alert (dedup).
 */
export async function allocationGuard(db: Db, ctx: { now?: Date; warehouseId?: string } = {}): Promise<number> {
  const now = ctx.now ?? new Date()
  const stale = await db.stock.findMany({
    where: { allocationPendingSince: { lt: new Date(now.getTime() - 5 * 60_000) } },
    select: { productId: true, allocationPendingSince: true },
  })
  for (const s of stale) {
    await db.outboxEvent.create({ data: { kind: 'ALLOCATE', productId: s.productId, createdAt: now } })
    await alert(db, 'ALLOCATE_ZALEGLE', s.productId, `Przydział dostawy zaległy od ${s.allocationPendingSince!.toISOString()} — wzrosty na kanały wstrzymane`, `allocate:${s.productId}:${s.allocationPendingSince!.toISOString()}`)
  }
  return stale.length
}
