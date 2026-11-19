// Rdzeń: rezerwacja i stan dostępny, terminy, edycja, kolejność zdarzeń (spec 11: 1–10, 15–19, 31, 32, 38, 39, 44a, 44b).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { updatePolicy } from '@/lib/rdzen/polityka'
import { runFanout } from '@/lib/rdzen/propagacja'
import { cancelOrder, ingestOrder, markPaid, remapOrder, resolveClarification, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { bundle, expectInvariants, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const H = 3600_000

describe('rezerwacja i stan dostępny', () => {
  it('1: zamówienie opłacone 2 szt. przy stanie 5 → rezerwacja 2, available 3, zdarzenie AvailableChanged', async () => {
    const a = await product(db, 'A', 5)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    expect(r).toMatchObject({ outcome: 'NOWE', reservedUnits: 2, shortUnits: 0, status: 'DO_REALIZACJI' })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2, physical: 5, available: 3, version: 1 })
    const ev = await db.outboxEvent.findMany({ where: { kind: 'AVAILABLE_CHANGED', productId: a } })
    expect(ev).toHaveLength(1)
    await expectInvariants(db)
  })

  it('2: nieopłacone (przelew) → rezerwacja jak opłacone, terminy ustawione', async () => {
    const a = await product(db, 'A', 5)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }], { paymentState: 'UNPAID', paymentMethod: 'przelew' }), { now: T0 })
    expect(r.status).toBe('NOWE')
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o.remindAt?.toISOString()).toBe('2026-10-19T08:00:00.000Z')
    expect(o.reservationDeadline?.toISOString()).toBe('2026-10-22T08:00:00.000Z')
    expect((await stockOf(db, a)).available).toBe(3)
    await expectInvariants(db)
  })

  it('3: za pobraniem → rezerwacja bez terminu', async () => {
    const a = await product(db, 'A', 5)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'COD', paymentMethod: 'pobranie' }), { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o).toMatchObject({ status: 'DO_REALIZACJI', reservationDeadline: null, remindAt: null })
    expect((await stockOf(db, a)).reserved).toBe(1)
  })

  it('4 i 5: 3 szt. przy stanie 2 → rezerwacja 2, Shortage 1, flaga brakuje; stan 0 → tylko Shortage', async () => {
    const a = await product(db, 'A', 2)
    const b = await product(db, 'B', 0)
    const r = await ingestOrder(db, order([{ productId: a, qty: 3 }, { productId: b, qty: 1 }]), { now: T0 })
    expect(r).toMatchObject({ reservedUnits: 2, shortUnits: 2 })
    const sh = await db.shortage.findMany({ where: { orderId: r.orderId! }, orderBy: { productId: 'asc' } })
    expect(sh.map((s) => [s.productId, s.qtyBase, s.state]).sort()).toEqual([[a, 1, 'OPEN'], [b, 1, 'OPEN']].sort())
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect((o.flags as { brakuje?: boolean }).brakuje).toBe(true)
    expect(o.shortageWaitUntil).toBeNull() // część jest — zamówienie idzie do realizacji
    expect(await stockOf(db, b)).toMatchObject({ reserved: 0, available: 0 })
    await expectInvariants(db)
  })

  it('6: pozycja niezmapowana → bez rezerwacji, DO_WYJASNIENIA; po zmapowaniu rezerwacja powstaje', async () => {
    const a = await product(db, 'A', 5)
    const r = await ingestOrder(db, order([{ offerExternalId: 'woo-555', qty: 2 }]), { now: T0 })
    expect(r.status).toBe('DO_WYJASNIENIA')
    expect(await db.reservation.count()).toBe(0)
    await offer(db, 'WOO_SD', 'woo-555', a)
    const m = await remapOrder(db, r.orderId!, { now: T0 })
    expect(m).toEqual({ mapped: 1, stillUnmapped: 0 })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o.status).toBe('DO_REALIZACJI')
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('7: zestaw (A×1 + B×2), A=3, B=3, zamówienie 2 zestawy → 1 komplet, Shortage dla 1 zestawu, available zestawu 0', async () => {
    const a = await product(db, 'A', 3)
    const b = await product(db, 'B', 3)
    const z = await bundle(db, 'Z', [{ id: a, qty: 1 }, { id: b, qty: 2 }])
    const r = await ingestOrder(db, order([{ productId: z, qty: 2 }]), { now: T0 })
    expect(r).toMatchObject({ reservedUnits: 1, shortUnits: 1 })
    expect((await stockOf(db, a)).reserved).toBe(1)
    expect((await stockOf(db, b)).reserved).toBe(2)
    const sh = await db.shortage.findMany({ where: { orderId: r.orderId! } })
    expect(sh.map((s) => (s.productId === a ? `A:${s.qtyBase}` : `B:${s.qtyBase}`)).sort()).toEqual(['A:1', 'B:2'])
    const availZ = Math.min((await stockOf(db, a)).available / 1, Math.floor((await stockOf(db, b)).available / 2))
    expect(availZ).toBe(0)
    await expectInvariants(db)
  })

  it('8: zmiana stanu składnika → job dla oferty zestawu i oferty składnika', async () => {
    const a = await product(db, 'A', 3)
    const b = await product(db, 'B', 4)
    const z = await bundle(db, 'Z', [{ id: a, qty: 1 }, { id: b, qty: 2 }])
    const oa = await offer(db, 'WOO_SD', 'wa', a)
    const oz = await offer(db, 'ALLEGRO', 'az', z)
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    await runFanout(db, { now: T0 })
    const jobs = await db.stockSyncJob.findMany({ orderBy: { offerId: 'asc' } })
    expect(Object.fromEntries(jobs.map((j) => [j.offerId, j.targetQty]))).toEqual({ [oa]: 2, [oz]: 2 })
  })

  it('9: 16 pozycji w jednym zamówieniu, braki na 3 pozycjach, jedna transakcja', async () => {
    const ids: string[] = []
    for (let i = 0; i < 16; i++) ids.push(await product(db, `P${i}`, i < 3 ? 0 : 5))
    const r = await ingestOrder(db, order(ids.map((id) => ({ productId: id, qty: 1 }))), { now: T0 })
    expect(r).toMatchObject({ reservedUnits: 13, shortUnits: 3 })
    expect(await db.shortage.count()).toBe(3)
    expect(await db.reservation.count()).toBe(13)
    await expectInvariants(db)
  })

  it('10: towar w kg: oferta 250 g, stan 11 860 g, zamówienie 3 × 250 g → 750 g, available 11 110 g, target 44', async () => {
    const h = await product(db, 'HERB', 11_860, { unit: 'KG' })
    const of = await offer(db, 'WOO_SD', 'przyprawa-250', h, { qtyBasePerOffer: 250 })
    await ingestOrder(db, order([{ offerExternalId: 'przyprawa-250', qty: 3 }]), { now: T0 })
    expect(await stockOf(db, h)).toMatchObject({ reserved: 750, available: 11_110 })
    await runFanout(db, { now: T0 })
    expect((await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })).targetQty).toBe(44)
  })
})

describe('terminy i wygasanie', () => {
  it('15 i 16: dwa przebiegi workera → jeden mail przypomnienia; termin minął → zwolnienie, ANULOWANE, propagacja', async () => {
    const a = await product(db, 'A', 5)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }], { paymentState: 'UNPAID' }), { now: T0 })
    const afterRemind = new Date('2026-10-19T09:00:00Z')
    expect((await runReservationExpiry(db, { now: afterRemind })).reminders).toBe(1)
    expect((await runReservationExpiry(db, { now: afterRemind })).reminders).toBe(0)
    expect(await db.orderEvent.count({ where: { orderId: r.orderId!, kind: 'PRZYPOMNIENIE_WYSLALBYM' } })).toBe(1)
    const before = await db.outboxEvent.count({ where: { kind: 'AVAILABLE_CHANGED' } })
    const st = await runReservationExpiry(db, { now: new Date('2026-10-22T08:00:00Z') })
    expect(st.released).toBe(1)
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o).toMatchObject({ status: 'ANULOWANE', cancelReason: 'EXPIRED_UNPAID' })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0, available: 5 })
    expect(await db.outboxEvent.count({ where: { kind: 'AVAILABLE_CHANGED' } })).toBe(before + 1)
    await expectInvariants(db)
  })

  it('17: płatność w tej samej chwili co wygasanie → obie kolejności dają spójny wynik pod blokadą (opłacone, rezerwacja jest)', async () => {
    const a = await product(db, 'A', 20)
    let paidWins = 0
    for (let i = 0; i < 10; i++) {
      const r = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
      const deadline = new Date('2026-10-22T08:00:00Z')
      await Promise.all([markPaid(db, r.orderId!, 'PAID', { now: deadline }), runReservationExpiry(db, { now: deadline })])
      const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
      // obie kolejności są poprawne pod blokadą; płatność po zwolnieniu przywraca rezerwację (3.3)
      expect(['DO_REALIZACJI']).toContain(o.status)
      if (o.paymentState === 'PAID') paidWins++
    }
    expect(paidWins).toBe(10)
    expect((await stockOf(db, a)).reserved).toBe(10)
    await expectInvariants(db)
  })

  it('18: płatność po anulowaniu: stan jest → rezerwacja wraca; brak → Shortage + DO_WYJASNIENIA', async () => {
    const a = await product(db, 'A', 1)
    const r1 = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
    await runReservationExpiry(db, { now: new Date('2026-10-22T08:00:00Z') })
    expect(await markPaid(db, r1.orderId!, 'PAID', { now: new Date('2026-10-22T09:00:00Z') })).toBe('DO_REALIZACJI')
    expect((await stockOf(db, a)).reserved).toBe(1)
    // drugi: po anulowaniu ktoś kupił ostatnią sztukę
    const b = await product(db, 'B', 1)
    const r2 = await ingestOrder(db, order([{ productId: b, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
    await runReservationExpiry(db, { now: new Date('2026-10-22T08:00:00Z') })
    await ingestOrder(db, order([{ productId: b, qty: 1 }]), { now: new Date('2026-10-22T08:30:00Z') })
    expect(await markPaid(db, r2.orderId!, 'PAID', { now: new Date('2026-10-22T09:00:00Z') })).toBe('DO_WYJASNIENIA')
    expect(await db.shortage.count({ where: { orderId: r2.orderId!, state: 'OPEN' } })).toBe(1)
    await expectInvariants(db)
  })

  it('19: przełączenie sezonu: stare zamówienie zachowuje 5 dni, nowe dostaje 3', async () => {
    const a = await product(db, 'A', 5)
    const r1 = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
    await updatePolicy(db, { seasonMode: true }, 'test')
    const r2 = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
    const [o1, o2] = await Promise.all([db.order.findUniqueOrThrow({ where: { id: r1.orderId! } }), db.order.findUniqueOrThrow({ where: { id: r2.orderId! } })])
    expect(o1.reservationDeadline?.toISOString()).toBe('2026-10-22T08:00:00.000Z')
    expect(o2.reservationDeadline?.toISOString()).toBe('2026-10-20T08:00:00.000Z')
    expect(o2.remindAt?.toISOString()).toBe('2026-10-16T08:00:00.000Z')
    expect([o1.termsSeasonMode, o2.termsSeasonMode]).toEqual([false, true])
    expect(await db.auditLog.count({ where: { entity: 'ReservationPolicy' } })).toBe(1)
    await expect(updatePolicy(db, { seasonReminderBusinessDays: 5, seasonReleaseBusinessDays: 3 }, 'test')).rejects.toThrow(/Przypomnienie/)
  })

  it('32: brak wszystkiego → czeka; po 3 dniach roboczych DO_WYJASNIENIA (dostawa w tym czasie: rdzen-przydzial, 32b)', async () => {
    const a = await product(db, 'A', 0)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o.status).toBe('DO_REALIZACJI')
    expect(o.shortageWaitUntil?.toISOString()).toBe('2026-10-20T08:00:00.000Z')
    expect((await runReservationExpiry(db, { now: new Date('2026-10-19T08:00:00Z') })).toClarify).toBe(0)
    expect((await runReservationExpiry(db, { now: new Date('2026-10-20T08:00:00Z') })).toClarify).toBe(1)
    expect((await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })).status).toBe('DO_WYJASNIENIA')
  })

  it('44b: przywrócenie z DO_WYJASNIENIA po płatności, która przyszła w międzyczasie → DO_REALIZACJI; wygasanie pomija DO_WYJASNIENIA', async () => {
    const a = await product(db, 'A', 5)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID', deliveryMethod: 'Gołąb pocztowy' }), { now: T0 })
    expect(r.status).toBe('DO_WYJASNIENIA')
    expect((await runReservationExpiry(db, { now: new Date('2026-11-30T08:00:00Z') })).released).toBe(0)
    await markPaid(db, r.orderId!, 'PAID', { now: T0 })
    expect(await resolveClarification(db, r.orderId!)).toBe('DO_REALIZACJI')
  })
})

describe('edycja i kolejność zdarzeń', () => {
  it('31: edycja w kanale: +1 szt., usunięcie pozycji; zmiana po fakturze → DO_WYJASNIENIA', async () => {
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 5)
    const base = order([{ productId: a, qty: 1 }, { productId: b, qty: 2 }], { externalRevision: '1' })
    const r = await ingestOrder(db, base, { now: T0 })
    await ingestOrder(db, { ...base, externalRevision: '2', lines: [{ externalLineId: 'L1', productId: a, qty: 2, unitPriceGross: 10 }] }, { now: T0 })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect((await stockOf(db, b)).reserved).toBe(0)
    await expectInvariants(db)
    await db.reservation.updateMany({ where: { orderId: r.orderId! }, data: { state: 'CONSUMED' } }) // jak po fakturze
    await db.stock.update({ where: { productId_warehouseId: { productId: a, warehouseId: 'glowny' } }, data: { reserved: 0 } })
    const r3 = await ingestOrder(db, { ...base, externalRevision: '3', lines: [{ externalLineId: 'L1', productId: a, qty: 4, unitPriceGross: 10 }] }, { now: T0 })
    expect(r3.status).toBe('DO_WYJASNIENIA')
  })

  it('31c: edycja w kanale zamówienia anulowanego → zostaje ANULOWANE, bez rezerwacji, wpis w historii', async () => {
    const a = await product(db, 'A', 5)
    const base = order([{ productId: a, qty: 1 }])
    const r = await ingestOrder(db, base, { now: T0 })
    await cancelOrder(db, r.orderId!, { now: T0 })
    await ingestOrder(db, { ...base, externalRevision: '2', lines: [{ externalLineId: 'L1', productId: a, qty: 3, unitPriceGross: 10 }] }, { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })).status).toBe('ANULOWANE')
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await db.orderEvent.count({ where: { orderId: r.orderId!, kind: 'EDYCJA_PO_ANULOWANIU' } })).toBe(1)
    await expectInvariants(db)
  })

  it('3.1: zamówienie widziane pierwszy raz już anulowane (Woo cancelled; failed tylko w danych historycznych) → bez rezerwacji', async () => {
    const a = await product(db, 'A', 5)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }], { cancelled: true, paymentState: 'UNPAID' }), { now: T0 })
    expect(r.status).toBe('ANULOWANE')
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0, available: 5 })
    expect((await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })).reservationDeadline).toBeNull()
    await expectInvariants(db)
  })

  it('31b: zmniejszenie ilości zamyka najpierw „brakuje”, potem zwalnia rezerwację', async () => {
    const a = await product(db, 'A', 2)
    const base = order([{ productId: a, qty: 4 }])
    const r = await ingestOrder(db, base, { now: T0 })
    await ingestOrder(db, { ...base, externalRevision: '2', lines: [{ externalLineId: 'L1', productId: a, qty: 1, unitPriceGross: 10 }] }, { now: T0 })
    expect((await stockOf(db, a)).reserved).toBe(1)
    expect(await db.shortage.count({ where: { orderId: r.orderId!, state: 'OPEN' } })).toBe(0)
    await expectInvariants(db)
  })

  it('35a i 38: to samo zdarzenie dwa razy → DUPLIKAT; starsza rewizja po nowszej → przestarzałe', async () => {
    const a = await product(db, 'A', 5)
    const o = order([{ productId: a, qty: 1 }], { externalRevision: '5' })
    expect((await ingestOrder(db, o, { now: T0 })).outcome).toBe('NOWE')
    expect((await ingestOrder(db, o, { now: T0 })).outcome).toBe('DUPLIKAT')
    expect((await ingestOrder(db, { ...o, externalRevision: '4', lines: [{ externalLineId: 'L1', productId: a, qty: 3, unitPriceGross: 1 }] }, { now: T0 })).outcome).toBe('PRZESTARZALE')
    expect((await stockOf(db, a)).reserved).toBe(1)
  })

  it('39: cofnięcie statusu przez kanał → DO_WYJASNIENIA, stan bez zmian', async () => {
    const a = await product(db, 'A', 5)
    const o = order([{ productId: a, qty: 1 }], { channelStatusRank: 3 })
    await ingestOrder(db, o, { now: T0 })
    const r = await ingestOrder(db, { ...o, externalRevision: '2', channelStatusRank: 1 }, { now: T0 })
    expect(r.status).toBe('DO_WYJASNIENIA')
    expect((await stockOf(db, a)).reserved).toBe(1)
  })

  it('44a: Woo anuluje pending po 60 min → zwolnienie z `cancelled`, nie z naszego terminu', async () => {
    const a = await product(db, 'A', 5)
    const o = order([{ productId: a, qty: 2 }], { paymentState: 'UNPAID', paymentMethod: 'PayU' })
    const r = await ingestOrder(db, o, { now: T0 })
    await ingestOrder(db, { ...o, externalRevision: '2', cancelled: true }, { now: new Date(T0.getTime() + H) })
    const ord = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(ord).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await cancelOrder(db, r.orderId!)).toBe('ANULOWANE') // idempotentnie
    await expectInvariants(db)
  })

  it('walidacja na wejściu: ilość 0, zdublowana pozycja, brak externalId → odrzucone przed transakcją', async () => {
    const a = await product(db, 'A', 5)
    await expect(ingestOrder(db, order([{ productId: a, qty: 0 }]))).rejects.toThrow(/zła ilość/)
    await expect(ingestOrder(db, order([{ productId: a, qty: 1, externalLineId: 'X' }, { productId: a, qty: 1, externalLineId: 'X' }]))).rejects.toThrow(/zdublowana/)
    await expect(ingestOrder(db, order([{ productId: a, qty: 1 }], { externalId: ' ' }))).rejects.toThrow(/externalId/)
    expect(await db.order.count()).toBe(0)
  })
})
