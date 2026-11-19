// Poprawki rdzenia po przeglądzie kodu.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { markMissingOnShelf, shipLater } from '@/lib/rdzen/brakuje'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { auditStale, checkInvariants } from '@/lib/rdzen/niezmienniki'
import { processAllocateEvents } from '@/lib/rdzen/przydzial'
import {
  applyBlInvoice,
  beginInvoice,
  type FakturyWfirma,
  issueInvoice,
  MAX_INVOICE_ATTEMPTS,
  packOrder,
  reapStaleInvoices,
  resolveUnknownInvoices,
} from '@/lib/rdzen/rozchod'
import { cancelOrder, ingestOrder, markPaid, resolveClarification, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const S = 1000
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

describe('poprawki po przeglądzie', () => {
  it('odczyt wysłany w trakcie żądania faktury (stan sprzed faktury) nie potwierdza ruchu; potwierdza dopiero odczyt po odpowiedzi', async () => {
    const a = await product(db, 'A', 10)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]))
    await packOrder(db, r.orderId!)
    const wf = new FakeWfirma()
    const slow: FakturyWfirma = {
      issue: async (req) => {
        await new Promise((res) => setTimeout(res, 150))
        return wf.issue(req)
      },
      findByPrefix: (p) => wf.findByPrefix(p),
    }
    expect(await issueInvoice(db, r.orderId!, slow)).toBe('WYSTAWIONA') // zegar ścienny, bez wstrzykniętego now
    const m = await db.pendingMovement.findFirstOrThrow({ where: { productId: a } })
    expect(m.effectiveAt!.getTime() - m.sentAt.getTime()).toBeGreaterThanOrEqual(140)
    // odczyt wysłany 50 ms po sentAt dostał stan sprzed faktury (10), zapisany po odpowiedzi
    const r1 = await applyStockRead(db, { productId: a, countBase: 10, requestSentAt: new Date(m.sentAt.getTime() + 50) })
    expect(r1.confirmed).toBe(0)
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, available: 8 })
    const r2 = await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: new Date(m.effectiveAt!.getTime() + 1) })
    expect(r2.confirmed).toBe(1)
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, pendingDelta: 0 })
    await expectInvariants(db)
  })

  it('wyjątek adaptera przy każdej próbie → po limicie prób flaga fakturaBlad i alert zamiast pętli bez końca', async () => {
    const a = await product(db, 'A', 10)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    const broken: FakturyWfirma = { issue: async () => { throw new Error('atrapa: 400') }, findByPrefix: async () => [] }
    expect(await issueInvoice(db, r.orderId!, broken, { now: at(0) })).toBe('TIMEOUT')
    let t = 0
    for (let i = 0; i < 20; i++) {
      t += 6 * M
      await resolveUnknownInvoices(db, broken, { now: at(t) })
      await resolveUnknownInvoices(db, broken, { now: at(t + 2 * M) })
      await resolveUnknownInvoices(db, broken, { now: at(t + 5 * M) })
    }
    expect(await db.invoiceAttempt.count({ where: { orderId: r.orderId! } })).toBe(MAX_INVOICE_ATTEMPTS)
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect((o.flags as { fakturaBlad?: boolean }).fakturaBlad).toBe(true)
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD' } })).toBeGreaterThanOrEqual(1)
    expect(await db.reservation.count({ where: { orderId: r.orderId!, state: 'ACTIVE' } })).toBe(1)
    expect(await issueInvoice(db, r.orderId!, broken, { now: at(t + 10 * M) })).toBe('LIMIT_PROB')
    await expectInvariants(db)
  })

  it('próba SENDING porzucona przez worker → UNKNOWN po 2 min; ruchy w toku > 24 h → alert; „nie ma na półce” → alert', async () => {
    const a = await product(db, 'A', 10)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    const b = await beginInvoice(db, r.orderId!, { now: T0 }) // worker padł przed odpowiedzią
    expect(b.outcome).toBe('START')
    expect(await reapStaleInvoices(db, { now: new Date(Date.now() + 3 * M) })).toBe(1)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: r.orderId! } })).state).toBe('UNKNOWN')
    expect(await auditStale(db, new Date(T0.getTime() + 25 * 3600_000))).toBe(1)
    expect(await db.alert.count({ where: { kind: 'RUCH_ZALEGLY' } })).toBe(1)
    const c = await product(db, 'C', 1)
    const r2 = await ingestOrder(db, order([{ productId: c, qty: 1 }]), { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: r2.orderId! } })
    await markMissingOnShelf(db, line.id, c, 1, { now: at(M) })
    expect(await db.alert.count({ where: { kind: 'BRAK_NA_POLCE' } })).toBe(1)
  })

  it('podzamówienie „dośle” spakowane z resztą SHIP_LATER → reszta do zwrotu, późniejsza dostawa nie zakłada ACTIVE na wysłanym', async () => {
    const a = await product(db, 'A', 0)
    const r = await ingestOrder(db, order([{ productId: a, qty: 5 }]), { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId! } })
    const { childOrderId } = await shipLater(db, line.id, { now: T0 })
    await applyStockRead(db, { productId: a, countBase: 3, requestSentAt: at(M) }, { now: at(M) })
    await processAllocateEvents(db, { now: at(M) })
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: childOrderId, state: 'ACTIVE' } })).qtyBase).toBe(3)
    await packOrder(db, childOrderId, { now: at(2 * M) })
    expect(await db.shortage.count({ where: { orderId: childOrderId, state: 'REFUND_PENDING' } })).toBe(1)
    await issueInvoice(db, childOrderId, new FakeWfirma(), { now: at(2 * M) })
    await db.order.update({ where: { id: childOrderId }, data: { status: 'WYSLANE' } }) // ekran wysyłki (F2)
    await applyStockRead(db, { productId: a, countBase: 2, requestSentAt: at(10 * M) }, { now: at(10 * M) }) // 3 − 3 (WZ) + 2 dostawa
    await processAllocateEvents(db, { now: at(10 * M) })
    expect(await db.reservation.count({ where: { orderId: childOrderId, state: 'ACTIVE' } })).toBe(0)
    expect((await stockOf(db, a)).available).toBe(2)
    expect((await checkInvariants(db)).filter((v) => v.rule.startsWith('4d'))).toEqual([])
    await expectInvariants(db)
  })

  it('(31d): edycja z kanału po spakowaniu → DO_WYJASNIENIA, rezerwacje bez zmian (od ZBIERANIE: tests/karta-t7)', async () => {
    const a = await product(db, 'A', 10)
    const base = order([{ productId: a, qty: 2 }])
    const r = await ingestOrder(db, base, { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    const res = await ingestOrder(db, { ...base, externalRevision: '2', lines: [] }, { now: T0 })
    expect(res.status).toBe('DO_WYJASNIENIA')
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: r.orderId! } })).state).toBe('ACTIVE')
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId! } })).removed).toBe(false)
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('(25f): „dośle później”, gdy towar już leży na stanie → rezerwacja od razu po przebiegu przydziału', async () => {
    const a = await product(db, 'A', 0)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    await db.order.update({ where: { id: r.orderId! }, data: { status: 'ZBIERANIE' } })
    await applyStockRead(db, { productId: a, countBase: 1, requestSentAt: at(M) }, { now: at(M) })
    await processAllocateEvents(db, { now: at(M) }) // pominięte: zbieranie w toku (25c)
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId! } })
    const { childOrderId } = await shipLater(db, line.id, { now: at(2 * M) })
    expect(await db.outboxEvent.count({ where: { kind: 'ALLOCATE', processedAt: null } })).toBe(1)
    await processAllocateEvents(db, { now: at(3 * M) })
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: childOrderId, state: 'ACTIVE' } })).qtyBase).toBe(1)
    await expectInvariants(db)
  })

  it('(18b): opłacone po anulowaniu z brakiem → po „wyjaśnione” przydział z towaru, który przyszedł w międzyczasie', async () => {
    const a = await product(db, 'A', 1)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
    await runReservationExpiry(db, { now: new Date('2026-10-22T08:00:00Z') })
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: new Date('2026-10-22T08:30:00Z') })
    expect(await markPaid(db, r.orderId!, 'PAID', { now: new Date('2026-10-22T09:00:00Z') })).toBe('DO_WYJASNIENIA')
    await applyStockRead(db, { productId: a, countBase: 2, requestSentAt: new Date('2026-10-22T10:00:00Z') }, { now: new Date('2026-10-22T10:00:00Z') })
    await processAllocateEvents(db, { now: new Date('2026-10-22T10:00:00Z') })
    expect(await db.shortage.count({ where: { orderId: r.orderId!, state: 'OPEN' } })).toBe(1) // DO_WYJASNIENIA nie bierze dostawy
    expect(await resolveClarification(db, r.orderId!, { now: new Date('2026-10-22T11:00:00Z') })).toBe('DO_REALIZACJI')
    await processAllocateEvents(db, { now: new Date('2026-10-22T11:00:00Z') })
    expect(await db.shortage.count({ where: { orderId: r.orderId!, state: 'RESOLVED' } })).toBe(1)
    await expectInvariants(db)
  })

  it('płatność do zamówienia anulowanego w kanale → zostaje ANULOWANE, bez rezerwacji, flaga i alert', async () => {
    const a = await product(db, 'A', 5)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
    await cancelOrder(db, r.orderId!, { now: T0 })
    expect(await markPaid(db, r.orderId!, 'PAID', { now: at(M) })).toBe('ANULOWANE')
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await db.alert.count({ where: { kind: 'PLATNOSC_PO_ANULOWANIU' } })).toBe(1)
    await expectInvariants(db)
  })

  it('ta sama faktura BL przetworzona drugi raz po nowej rezerwacji → bez błędu i bez drugiego ruchu', async () => {
    const a = await product(db, 'A', 10)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await applyBlInvoice(db, r.orderId!, 'FV/BL/1', { [a]: 2 }, { now: at(M) })
    await db.reservation.create({ data: { orderId: r.orderId!, orderLineId: (await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId! } })).id, productId: a, warehouseId: 'glowny', qtyBase: 1 } })
    await db.stock.update({ where: { productId_warehouseId: { productId: a, warehouseId: 'glowny' } }, data: { reserved: { increment: 1 } } })
    await applyBlInvoice(db, r.orderId!, 'FV/BL/1', { [a]: 2 }, { now: at(2 * M) })
    expect(await db.pendingMovement.count({ where: { wfirmaDocId: 'FV/BL/1' } })).toBe(1)
  })

  it('zdarzenie bez rewizji i bez eventKey → odrzucone na wejściu', async () => {
    const a = await product(db, 'A', 5)
    await expect(ingestOrder(db, order([{ productId: a, qty: 1 }], { externalRevision: null }))).rejects.toThrow(/externalRevision/)
  })
})
