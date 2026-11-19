// sklep potrafi pokazać zamówienie, zanim policzy sumę (zamówienie złożone przez REST: najpierw wartość 0,
// potem właściwa). Wartość zamówienia (i zmiana kosztu wysyłki) idzie za kanałem, dopóki nic na niej nie stoi: bez
// faktury i próby faktury, bez edycji w Kompletorze, przed spakowaniem, nieopłacone (opłacone z zapisanym zerem też
// się poprawia). „Odśwież z kanału” na karcie poprawia ją tą samą drogą. Dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { odswiezOpisZKanalu } from '@/lib/karta/opis-z-kanalu'
import { type IncomingOrder, ingestOrder, markPaid, ZDARZENIE_KWOTY_Z_KANALU } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

/** Zamówienie sklepu odczytane w chwili, gdy suma była jeszcze 0 (pozycje już z cenami: 61,70 + 2 × 21,70). */
async function zamowienieZZerem(over: Parameters<typeof order>[1] = {}) {
  if (!(await db.channelOffer.count({ where: { externalId: '701' } }))) {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 10)
    await db.channelOffer.createMany({
      data: [
        { channel: 'WOO', channelAccountId: 'sd', externalId: '701', productId: a },
        { channel: 'WOO', channelAccountId: 'sd', externalId: '702', productId: b },
      ],
    })
  }
  const o1 = order(
    [
      { offerExternalId: '701', qty: 1, unitPriceGross: 61.7, externalLineId: 'L1' },
      { offerExternalId: '702', qty: 2, unitPriceGross: 21.7, externalLineId: 'L2' },
    ],
    { paymentState: 'UNPAID', paymentMethod: 'Przelew bankowy', totalGross: 0, shippingCostGross: 0, externalRevision: '2026-11-18T12:22:43.000Z', ...over },
  )
  const r = await ingestOrder(db, o1, { now: T0 })
  return { o1, orderId: r.orderId! }
}

const rewizja2 = (o1: IncomingOrder, over: Partial<IncomingOrder> = {}): IncomingOrder => ({ ...o1, externalRevision: '2026-11-18T12:22:58.000Z', totalGross: 105.1, ...over })

async function kanal(o1: IncomingOrder, totalGross: number, shippingCostGross = 0) {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
  const state = new FakeChannelState()
  state.upsertOrder(
    fakeOrder({
      externalId: o1.externalId,
      paymentState: 'UNPAID',
      totalGross,
      shippingCostGross,
      lines: [
        { externalLineId: 'L1', offerExternalId: '701', qty: 1, unitPriceGross: 61.7, vatRate: '23' },
        { externalLineId: 'L2', offerExternalId: '702', qty: 2, unitPriceGross: 21.7, vatRate: '23' },
      ],
    }),
  )
  return { registry: new AdapterRegistry([fakeDefinition(state, 'WOO', 'fake.v1')]), secrets: { env: {}, envFallback: false } }
}

const zamowienie = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true } })
const zdarzeniaKwoty = (id: string) => db.orderEvent.findMany({ where: { orderId: id, kind: ZDARZENIE_KWOTY_Z_KANALU } })

describe('wartość zamówienia z kanału', () => {
  it('pierwszy odczyt z kwotą 0, drugi z właściwą: kwota poprawiona, status i rezerwacje bez zmian, ślad w historii', async () => {
    const { o1, orderId } = await zamowienieZZerem()
    const przed = await zamowienie(orderId)
    expect(przed.totalGross.toFixed(2)).toBe('0.00')

    await ingestOrder(db, rewizja2(o1), { now: T0 })
    const po = await zamowienie(orderId)
    expect(po.totalGross.toFixed(2)).toBe('105.10')
    expect(po.status).toBe(przed.status)
    expect(po.paymentState).toBe('UNPAID')
    expect(po.reservations.map((r) => r.qtyBase).sort()).toEqual(przed.reservations.map((r) => r.qtyBase).sort())
    const ev = await zdarzeniaKwoty(orderId)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actorId: 'system:test', data: { z: '0.00', na: '105.10' } })

    // kolejna rewizja z tą samą kwotą: bez zmian i bez drugiego wpisu
    await ingestOrder(db, rewizja2(o1, { externalRevision: '2026-11-18T12:30:00.000Z' }), { now: T0 })
    expect(await zdarzeniaKwoty(orderId)).toHaveLength(1)
    await expectInvariants(db)
  })

  it('wpłata w kanale przychodzi razem z poprawioną kwotą: kwota z kanału (stan płatności sprzed odczytu)', async () => {
    const { o1, orderId } = await zamowienieZZerem()
    await ingestOrder(db, rewizja2(o1, { paymentState: 'PAID' }), { now: T0 })
    const po = await zamowienie(orderId)
    expect(po.paymentState).toBe('PAID')
    expect(po.totalGross.toFixed(2)).toBe('105.10')
  })

  it('opłacone w kanale z kwotą inną niż zero: późniejsza zmiana kwoty w kanale nie przechodzi', async () => {
    const { o1, orderId } = await zamowienieZZerem({ paymentState: 'PAID', totalGross: 90 })
    await ingestOrder(db, rewizja2(o1, { paymentState: 'PAID' }), { now: T0 })
    expect((await zamowienie(orderId)).totalGross.toFixed(2)).toBe('90.00')
    expect(await zdarzeniaKwoty(orderId)).toHaveLength(0)
  })

  it('po fakturze kwota i koszt wysyłki się nie zmieniają (odczyt z kanału i „Odśwież z kanału”)', async () => {
    const { o1, orderId } = await zamowienieZZerem()
    await db.invoiceAttempt.create({ data: { orderId, packageNo: 1, attemptNo: 1, idExternal: `${orderId}/1/1`, state: 'ISSUED', wfirmaDocId: 'FV-TEST-1' } })

    await ingestOrder(db, rewizja2(o1, { shippingCostGross: 12.5 }), { now: T0 })
    let po = await zamowienie(orderId)
    expect(po.totalGross.toFixed(2)).toBe('0.00')
    expect(po.shippingCostGross?.toFixed(2)).toBe('0.00')

    const deps = await kanal(o1, 105.1, 12.5)
    expect(await odswiezOpisZKanalu(db, orderId, deps)).toEqual({ wynik: 'OK', zmian: 0 })
    po = await zamowienie(orderId)
    expect(po.totalGross.toFixed(2)).toBe('0.00')
    expect(po.shippingCostGross?.toFixed(2)).toBe('0.00')
    expect(await zdarzeniaKwoty(orderId)).toHaveLength(0)
  })

  it('próba faktury w drodze (bez numeru) też zamyka kwotę', async () => {
    const { o1, orderId } = await zamowienieZZerem()
    await db.invoiceAttempt.create({ data: { orderId, packageNo: 1, attemptNo: 1, idExternal: `${orderId}/1/1`, state: 'SENDING' } })
    await ingestOrder(db, rewizja2(o1), { now: T0 })
    expect((await zamowienie(orderId)).totalGross.toFixed(2)).toBe('0.00')
  })

  it('„Odśwież z kanału”: poprawia zero także po „Oznacz jako opłacone” w Kompletorze; historia z osobą', async () => {
    const { o1, orderId } = await zamowienieZZerem()
    await markPaid(db, orderId, 'PAID', { now: T0, actorId: 'user:u-test' })
    const deps = await kanal(o1, 105.1, 0)
    expect(await odswiezOpisZKanalu(db, orderId, { ...deps, actorId: 'user:u-test' })).toEqual({ wynik: 'OK', zmian: 1 })
    expect((await zamowienie(orderId)).totalGross.toFixed(2)).toBe('105.10')
    const ev = await zdarzeniaKwoty(orderId)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actorId: 'user:u-test', data: { z: '0.00', na: '105.10' } })
    // powtórka: bez zmian
    expect(await odswiezOpisZKanalu(db, orderId, deps)).toEqual({ wynik: 'OK', zmian: 0 })
    // opłacone z kwotą różną od zera: kolejna zmiana w kanale już nie przechodzi
    const deps2 = await kanal(o1, 120, 0)
    expect(await odswiezOpisZKanalu(db, orderId, deps2)).toEqual({ wynik: 'OK', zmian: 0 })
    expect((await zamowienie(orderId)).totalGross.toFixed(2)).toBe('105.10')
    await expectInvariants(db)
  })

  it('nieopłacone: zmiana kosztu wysyłki w kanale przechodzi razem z kwotą', async () => {
    const { o1, orderId } = await zamowienieZZerem()
    const deps = await kanal(o1, 117.6, 12.5)
    expect((await odswiezOpisZKanalu(db, orderId, deps)).wynik).toBe('OK')
    const po = await zamowienie(orderId)
    expect(po.totalGross.toFixed(2)).toBe('117.60')
    expect(po.shippingCostGross?.toFixed(2)).toBe('12.50')
    expect((await zdarzeniaKwoty(orderId))[0]).toMatchObject({ data: { z: '0.00', na: '117.60', kosztZ: '0.00', kosztNa: '12.50' } })
  })

  it('bezpieczniki: edytowane w Kompletorze, spakowane, anulowane, paczka dodatkowa — kwota bez zmian', async () => {
    for (const [nazwa, zmiana] of [
      ['edytowane', { flags: { edytowaneLokalnie: true } }],
      ['spakowane', { status: 'SPAKOWANE' }],
      ['anulowane', { status: 'ANULOWANE', cancelReason: 'CANCELLED' }],
      ['do wyjaśnienia po spakowaniu', { status: 'DO_WYJASNIENIA', statusBeforeClarify: 'SPAKOWANE' }],
    ] as const) {
      await truncateAll(db)
      await seedBase(db)
      const { o1, orderId } = await zamowienieZZerem()
      await db.order.update({ where: { id: orderId }, data: zmiana as never })
      const deps = await kanal(o1, 105.1, 0)
      expect((await odswiezOpisZKanalu(db, orderId, deps)).wynik, nazwa).toBe('OK')
      expect((await zamowienie(orderId)).totalGross.toFixed(2), nazwa).toBe('0.00')
    }
    // paczka dodatkowa (dosłanie): kwota z jej pozycji, nie z kanału
    await truncateAll(db)
    await seedBase(db)
    const glowne = await zamowienieZZerem()
    const dodatkowa = await zamowienieZZerem({ externalId: `${glowne.o1.externalId}#2` })
    await db.order.update({ where: { id: dodatkowa.orderId }, data: { parentOrderId: glowne.orderId } })
    await ingestOrder(db, rewizja2(dodatkowa.o1), { now: T0 })
    expect((await zamowienie(dodatkowa.orderId)).totalGross.toFixed(2)).toBe('0.00')
    // zamówienie główne z paczką dodatkową: też zamknięte
    await ingestOrder(db, rewizja2(glowne.o1), { now: T0 })
    expect((await zamowienie(glowne.orderId)).totalGross.toFixed(2)).toBe('0.00')
  })

  it('brakujący koszt wysyłki uzupełnia się jak dotąd także po fakturze (opis), kwota zostaje', async () => {
    const { o1, orderId } = await zamowienieZZerem({ shippingCostGross: null })
    await db.invoiceAttempt.create({ data: { orderId, packageNo: 1, attemptNo: 1, idExternal: `${orderId}/1/1`, state: 'ISSUED', wfirmaDocId: 'FV-TEST-2' } })
    await ingestOrder(db, rewizja2(o1, { shippingCostGross: 9.99 }), { now: T0 })
    const po = await zamowienie(orderId)
    expect(po.shippingCostGross?.toFixed(2)).toBe('9.99')
    expect(po.totalGross.toFixed(2)).toBe('0.00')
  })
})
