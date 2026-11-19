// Rdzeń: rozdział dostawy na „brakuje” (spec 11: 25, 25a–25e, 24m, 32 — dostawa w trakcie oczekiwania).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { shipLater } from '@/lib/rdzen/brakuje'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { runFanout } from '@/lib/rdzen/propagacja'
import { allocate, allocationGuard, processAllocateEvents } from '@/lib/rdzen/przydzial'
import { cancelOrder, ingestOrder, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { bundle, expectInvariants, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb({ poolMax: 20 })
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

const shortageStates = async (orderId: string) => (await db.shortage.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })).map((s) => `${s.state}:${s.qtyBase}`)

describe('przydział dostawy', () => {
  it('25: przyjęcie (+6) przy 3 brakach (SHIP_LATER, opłacone, nieopłacone) → przydział w tej kolejności, reszta do available, WFIRMA_SYNC', async () => {
    const a = await product(db, 'A', 0)
    const u = await ingestOrder(db, order([{ productId: a, qty: 2 }], { paymentState: 'UNPAID', createdAtChannel: at(0) }), { now: at(0) })
    const p = await ingestOrder(db, order([{ productId: a, qty: 2 }], { createdAtChannel: at(M) }), { now: at(M) })
    const s = await ingestOrder(db, order([{ productId: a, qty: 1 }], { createdAtChannel: at(2 * M) }), { now: at(2 * M) })
    const lineS = await db.orderLine.findFirstOrThrow({ where: { orderId: s.orderId! } })
    const { childOrderId } = await shipLater(db, lineS.id, { now: at(3 * M) })
    // dostawa tylko na 3 szt.: SHIP_LATER (1) → opłacone (2) → nieopłacone nic
    await applyStockRead(db, { productId: a, countBase: 3, requestSentAt: at(10 * M) }, { now: at(10 * M) })
    expect((await db.stockMovement.findFirstOrThrow({ where: { productId: a, source: 'WFIRMA_SYNC' } })).deltaPhysical).toBe(3)
    await processAllocateEvents(db, { now: at(10 * M) })
    expect(await shortageStates(childOrderId)).toEqual(['RESOLVED:1'])
    expect(await shortageStates(p.orderId!)).toEqual(['RESOLVED:2'])
    expect(await shortageStates(u.orderId!)).toEqual(['OPEN:2'])
    // druga dostawa: reszta do nieopłaconego, nadwyżka do available
    await applyStockRead(db, { productId: a, countBase: 6, requestSentAt: at(20 * M) }, { now: at(20 * M) })
    await processAllocateEvents(db, { now: at(20 * M) })
    expect(await shortageStates(u.orderId!)).toEqual(['RESOLVED:2'])
    expect(await stockOf(db, a)).toMatchObject({ physical: 6, reserved: 5, available: 1, allocationPendingSince: null })
    await expectInvariants(db)
  })

  it('25 (kanały): między odczytem a końcem przydziału wzrost nie wychodzi; nowe zamówienie w tym czasie wysyła spadek', async () => {
    const a = await product(db, 'A', 2)
    const of = await offer(db, 'WOO_SD', 'wa', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 2, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 3 }]), { now: at(0) }) // 2 zarezerwowane, 1 brak
    await runFanout(db, { now: at(0) })
    await db.stockSyncJob.deleteMany()
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 0 } })
    await applyStockRead(db, { productId: a, countBase: 10, requestSentAt: at(M) }, { now: at(M) }) // dostawa +8
    let f = await runFanout(db, { now: at(M) })
    expect(f.heldIncreases).toBe(1)
    expect(await db.stockSyncJob.count()).toBe(0)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 7 } }) // kanał pokazuje 7 (stan sprzed)
    await ingestOrder(db, order([{ productId: a, qty: 6 }]), { now: at(2 * M) }) // available 10−2−6 = 2 < 7 → spadek
    f = await runFanout(db, { now: at(2 * M) })
    expect((await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })).targetQty).toBe(2)
    await processAllocateEvents(db, { now: at(3 * M) })
    expect((await stockOf(db, a)).allocationPendingSince).toBeNull()
    await runFanout(db, { now: at(3 * M) })
    expect((await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })).targetQty).toBe(1) // po przydziale braku 1 szt.
    await expectInvariants(db)
  })

  it('25a: dostawa A przy braku zestawu (A+B), gdy B brak → zestaw nic, A do available; dostawa B → zestaw dostaje A i B naraz', async () => {
    const a = await product(db, 'A', 0)
    const b = await product(db, 'B', 0)
    const z = await bundle(db, 'Z', [{ id: a, qty: 1 }, { id: b, qty: 2 }])
    const r = await ingestOrder(db, order([{ productId: z, qty: 1 }]), { now: T0 })
    await applyStockRead(db, { productId: a, countBase: 1, requestSentAt: at(M) }, { now: at(M) })
    await processAllocateEvents(db, { now: at(M) })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0, available: 1 })
    await applyStockRead(db, { productId: b, countBase: 2, requestSentAt: at(2 * M) }, { now: at(2 * M) })
    await processAllocateEvents(db, { now: at(2 * M) })
    expect((await stockOf(db, a)).reserved).toBe(1)
    expect((await stockOf(db, b)).reserved).toBe(2)
    expect((await shortageStates(r.orderId!)).sort()).toEqual(['RESOLVED:1', 'RESOLVED:2'])
    await expectInvariants(db)
  })

  it('25b: anulowanie równolegle z przydziałem dostawy do jego braku (× 200) → nigdy ACTIVE na anulowanym', async () => {
    const a = await product(db, 'A', 0)
    let count = 0
    for (let i = 0; i < 200; i++) {
      const r = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(i * M) })
      await applyStockRead(db, { productId: a, countBase: count + 1, requestSentAt: at(i * M + 1000) }, { now: at(i * M + 1000) })
      count++
      await Promise.all([cancelOrder(db, r.orderId!, { now: at(i * M + 2000) }), allocate(db, a, { now: at(i * M + 2000) })])
      expect(await db.reservation.count({ where: { orderId: r.orderId!, state: 'ACTIVE' } })).toBe(0)
    }
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  }, 240_000)

  it('25c: dostawa w trakcie ZBIERANIE zamówienia z brakiem → jego Shortage pominięte', async () => {
    const a = await product(db, 'A', 0)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    await db.order.update({ where: { id: r.orderId! }, data: { status: 'ZBIERANIE' } }) // ekran zbierania (F2)
    await applyStockRead(db, { productId: a, countBase: 1, requestSentAt: at(M) }, { now: at(M) })
    await processAllocateEvents(db, { now: at(M) })
    expect(await shortageStates(r.orderId!)).toEqual(['OPEN:1'])
    expect((await stockOf(db, a)).available).toBe(1)
  })

  it('25d: allocate pada 3 razy → po 5 min strażnik ponawia i wysyła alert; spadki wychodzą przez cały czas', async () => {
    const a = await product(db, 'A', 1)
    const of = await offer(db, 'WOO_SD', 'wa', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 1 } })
    await applyStockRead(db, { productId: a, countBase: 5, requestSentAt: at(M) }, { now: at(M) })
    const boom = () => {
      throw new Error('atrapa: allocate padł')
    }
    for (let i = 0; i < 3; i++) expect((await processAllocateEvents(db, { now: at(M + i * 1000), failHook: boom })).errors).toBe(1)
    expect((await db.outboxEvent.findFirstOrThrow({ where: { kind: 'ALLOCATE' } })).attempts).toBe(3)
    expect(await allocationGuard(db, { now: at(3 * M) })).toBe(0) // < 5 min
    await ingestOrder(db, order([{ productId: a, qty: 5 }]), { now: at(4 * M) }) // spadek do 0
    await runFanout(db, { now: at(4 * M) })
    expect((await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })).targetQty).toBe(0)
    expect(await allocationGuard(db, { now: at(7 * M) })).toBe(1)
    expect(await db.alert.count({ where: { kind: 'ALLOCATE_ZALEGLE' } })).toBe(1)
    await processAllocateEvents(db, { now: at(7 * M) })
    expect((await stockOf(db, a)).allocationPendingSince).toBeNull()
  })

  it('25e: „dośle później” przenosi ilość na podzamówienie; przydział tworzy rezerwację na tej pozycji; niezmiennik 4 dla obu', async () => {
    const a = await product(db, 'A', 1)
    const r = await ingestOrder(db, order([{ productId: a, qty: 3 }]), { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId! } })
    const { childOrderId, units } = await shipLater(db, line.id, { now: T0 })
    expect(units).toBe(2)
    const matka = await db.orderLine.findUniqueOrThrow({ where: { id: line.id } })
    expect(matka.qty - matka.qtyRejected).toBe(1)
    await expectInvariants(db)
    await applyStockRead(db, { productId: a, countBase: 3, requestSentAt: at(M) }, { now: at(M) })
    await processAllocateEvents(db, { now: at(M) })
    const childLine = await db.orderLine.findFirstOrThrow({ where: { orderId: childOrderId } })
    expect((await db.reservation.findFirstOrThrow({ where: { orderLineId: childLine.id } })).qtyBase).toBe(2)
    await expectInvariants(db)
  })

  it('24m: dwa wzrosty w trakcie allocate → flaga zostaje po pierwszym allocate, drugi przydział przed wysłaniem wzrostu', async () => {
    const a = await product(db, 'A', 0)
    await ingestOrder(db, order([{ productId: a, qty: 4 }]), { now: T0 })
    await applyStockRead(db, { productId: a, countBase: 2, requestSentAt: at(M) }, { now: at(M) })
    const startedAt = at(M + 1000)
    await applyStockRead(db, { productId: a, countBase: 4, requestSentAt: at(M + 2000) }, { now: at(M + 2000) }) // drugi wzrost po starcie allocate
    const r1 = await allocate(db, a, { now: at(M + 3000), startedAt })
    expect(r1.flagCleared).toBe(false)
    expect((await stockOf(db, a)).allocationPendingSince).not.toBeNull()
    expect((await runFanout(db, { now: at(M + 3000) })).jobs).toBe(0)
    const r2 = await allocate(db, a, { now: at(M + 4000) })
    expect(r2.flagCleared).toBe(true)
    expect((await stockOf(db, a)).reserved).toBe(4)
    await expectInvariants(db)
  })

  it('24m (worker): wzrost nowszy niż start przebiegu → jego zdarzenie zostaje do kolejnego przebiegu, bez alertu strażnika', async () => {
    const a = await product(db, 'A', 0)
    await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await applyStockRead(db, { productId: a, countBase: 2, requestSentAt: at(M + 2000) }, { now: at(M + 2000) })
    await processAllocateEvents(db, { now: at(M + 1000) }) // przebieg wystartował przed wzrostem
    expect((await stockOf(db, a)).allocationPendingSince).not.toBeNull()
    expect(await db.outboxEvent.count({ where: { kind: 'ALLOCATE', processedAt: null } })).toBe(1)
    await processAllocateEvents(db, { now: at(M + 3000) })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2, allocationPendingSince: null })
    expect(await allocationGuard(db, { now: at(20 * M) })).toBe(0)
    await expectInvariants(db)
  })

  it('32 (dostawa): brak wszystkiego, dostawa przed terminem → normalna realizacja, bez DO_WYJASNIENIA', async () => {
    const a = await product(db, 'A', 0)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await applyStockRead(db, { productId: a, countBase: 2, requestSentAt: at(M) }, { now: at(M) })
    await processAllocateEvents(db, { now: at(M) })
    expect((await runReservationExpiry(db, { now: new Date('2026-10-21T08:00:00Z') })).toClarify).toBe(0)
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o).toMatchObject({ status: 'DO_REALIZACJI', shortageWaitUntil: null })
    expect((o.flags as { brakuje?: boolean }).brakuje).toBe(false)
  })
})
