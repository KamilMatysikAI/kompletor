// Rdzeń: współbieżność i idempotencja na prawdziwym Postgresie (spec 11: 33–36, 24l).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyStockPage, applyStockRead } from '@/lib/rdzen/lustro'
import { txStats } from '@/lib/rdzen/stan'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase, stockOf, T0, type TestChannel } from './rdzen-fixtures'

const db = testDb({ poolMax: 60 })
beforeAll(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const CHANNELS: TestChannel[] = ['WOO_SD', 'WOO_LAMPY', 'WOO_KOLOROWYKUBEK', 'ALLEGRO', 'EMPIK']

describe('współbieżność', () => {
  it('33: ostatnia sztuka, 5 kanałów × 10 równoległych zamówień, 100 powtórzeń → zawsze 1 rezerwacja i 49 Shortage', async () => {
    const results: { reserved: number; short: number }[] = []
    for (let rep = 0; rep < 100; rep++) {
      const a = await product(db, `LAST-${rep}`, 1)
      const all = await Promise.all(
        Array.from({ length: 50 }, (_, i) => ingestOrder(db, order([{ productId: a, qty: 1 }], { channel: CHANNELS[i % 5]!, deliveryMethod: 'Kurier DPD' }), { now: T0 })),
      )
      results.push({ reserved: all.reduce((s, r) => s + r.reservedUnits, 0), short: await db.shortage.count({ where: { productId: a } }) })
      const s = await stockOf(db, a)
      expect(s).toMatchObject({ reserved: 1, available: 0 })
    }
    expect(results.every((r) => r.reserved === 1 && r.short === 49)).toBe(true)
    await expectInvariants(db)
  }, 600_000)

  it('34: zamówienia A,B i B,A równolegle × 500 → brak nierozwiązanych zakleszczeń, ponowienia ≤ 3', async () => {
    const a = await product(db, 'PAIR-A', 100_000)
    const b = await product(db, 'PAIR-B', 100_000)
    const before = txStats.retries
    for (let i = 0; i < 500; i += 25) {
      await Promise.all(
        Array.from({ length: 25 }, (_, k) =>
          Promise.all([
            ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: b, qty: 1 }]), { now: T0 }),
            ingestOrder(db, order([{ productId: b, qty: 1 }, { productId: a, qty: 1 }]), { now: T0 }),
          ]).then(() => k),
        ),
      )
    }
    expect((await stockOf(db, a)).reserved).toBe(1000)
    expect((await stockOf(db, b)).reserved).toBe(1000)
    // runTx rzuca po 3 ponowieniach, więc brak wyjątku = każde zamówienie przeszło w ≤ 3 ponowieniach
    console.log(`[34] ponowienia transakcji: ${txStats.retries - before}`)
    await expectInvariants(db)
  }, 600_000)

  it('35: to samo zamówienie dwa razy równolegle (webhook + polling, różne klucze zdarzeń) → jedno Order, jedna rezerwacja', async () => {
    const a = await product(db, 'DUP', 10)
    for (let i = 0; i < 50; i++) {
      const o = order([{ productId: a, qty: 2 }])
      await Promise.all([ingestOrder(db, { ...o, source: 'woo-webhook', eventKey: `wh-${i}` }), ingestOrder(db, { ...o, source: 'woo-poll' })])
      expect(await db.order.count({ where: { externalId: o.externalId } })).toBe(1)
      expect(await db.reservation.count({ where: { order: { externalId: o.externalId } } })).toBe(1)
      await db.reservation.updateMany({ where: { order: { externalId: o.externalId } }, data: { state: 'RELEASED' } })
      await db.order.updateMany({ where: { externalId: o.externalId }, data: { status: 'ANULOWANE' } })
      await db.stock.updateMany({ where: { productId: a }, data: { reserved: 0 } })
    }
  }, 120_000)

  it('36: odczyt wFirmy i rezerwacja na tym samym produkcie równolegle × 200 → niezmienniki zachowane', async () => {
    const a = await product(db, 'RACE', 1000)
    let count = 1000
    const jobs: Promise<unknown>[] = []
    for (let i = 0; i < 200; i++) {
      count += i % 3 === 0 ? 5 : 0
      jobs.push(ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 }))
      jobs.push(applyStockRead(db, { productId: a, countBase: count, requestSentAt: new Date(T0.getTime() + i * 1000) }, { now: T0 }))
    }
    await Promise.all(jobs)
    const s = await stockOf(db, a)
    expect(s.reserved).toBe(200)
    expect(s.physical).toBe(s.wfirmaCount + s.pendingDelta)
    await expectInvariants(db)
  }, 120_000)

  it('24l: pełny odczyt strony 100 produktów równolegle z 50 zamówieniami wielopozycyjnymi → brak zakleszczeń', async () => {
    const ids: string[] = []
    for (let i = 0; i < 100; i++) ids.push(await product(db, `PAGE-${String(i).padStart(3, '0')}`, 50))
    const shuffled = [...ids].sort(() => Math.random() - 0.5)
    const orders = Array.from({ length: 50 }, (_, k) =>
      ingestOrder(db, order(Array.from({ length: 8 }, (_, j) => ({ productId: ids[(k * 7 + j * 13) % 100]!, qty: 1 }))), { now: T0 }),
    )
    const page = applyStockPage(db, shuffled.map((productId) => ({ productId, countBase: 60 })), new Date(T0.getTime() + 5000), { now: T0 })
    const [pageRes] = await Promise.all([page, ...orders])
    expect(pageRes).toMatchObject({ ok: 100, rejected: 0, errors: [] })
    await expectInvariants(db)
  }, 120_000)
})
