// Reaktywacja w kanale (krok 5): zamówienie anulowane przez kanał, które wraca
// w nowszej rewizji jako otwarte (Woo failed → processing po ponownej płatności, cancelled → processing), dostaje
// rezerwację od nowa jak „opłacone po anulowaniu”; czego nie ma → DO_WYJASNIENIA. Anulowanie przez obsługę i
// płatność z innego źródła zostają po staremu (alert „płatność po anulowaniu”). Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { issueInvoice, packOrder } from '@/lib/rdzen/rozchod'
import { cancelOrder, ingestOrder, type IncomingOrder } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const SOURCE = 'poll:WOO:sd'
let a: string

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  a = await product(db, 'A', 5)
})

/** Kolejne rewizje tego samego zamówienia z kanału. */
function revisions(qty: number, payment: IncomingOrder['paymentState'] = 'PAID') {
  const base = order([{ productId: a, qty }], { source: SOURCE, paymentState: payment })
  return (rev: number, over: Partial<IncomingOrder> = {}): IncomingOrder => ({ ...base, externalRevision: String(rev), eventKey: undefined, ...over })
}

describe('reaktywacja zamówienia anulowanego przez kanał', () => {
  it('cancelled → processing: rezerwacja od nowa, DO_REALIZACJI, zdarzenie; niezmienniki', async () => {
    const r = revisions(2)
    const { orderId } = await ingestOrder(db, r(1, { cancelled: false }), { now: T0 })
    await ingestOrder(db, r(2, { cancelled: true }), { now: T0 })
    expect(await db.order.findUniqueOrThrow({ where: { id: orderId! } })).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    expect((await stockOf(db, a)).reserved).toBe(0)
    const res = await ingestOrder(db, r(3, { cancelled: false }), { now: T0 })
    expect(res).toMatchObject({ outcome: 'ZMIANA', status: 'DO_REALIZACJI', reservedUnits: 2 })
    expect(await db.order.findUniqueOrThrow({ where: { id: orderId! } })).toMatchObject({ status: 'DO_REALIZACJI', cancelReason: null })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect(await db.orderEvent.count({ where: { orderId: orderId!, kind: 'PRZYWROCONE_W_KANALE' } })).toBe(1)
    await expectInvariants(db)
  })

  it('failed → processing po ponownej płatności (było nieopłacone): DO_REALIZACJI, opłacone; brak towaru → DO_WYJASNIENIA i braki', async () => {
    const r = revisions(4, 'UNPAID')
    const { orderId } = await ingestOrder(db, r(1, { cancelled: false }), { now: T0 })
    await ingestOrder(db, r(2, { cancelled: true }), { now: T0 })
    // w międzyczasie inne zamówienie zabiera 3 z 5 sztuk
    await ingestOrder(db, order([{ productId: a, qty: 3 }], { source: SOURCE }), { now: T0 })
    const res = await ingestOrder(db, r(3, { cancelled: false, paymentState: 'PAID' }), { now: T0 })
    expect(res.status).toBe('DO_WYJASNIENIA')
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId! } })
    expect(o).toMatchObject({ status: 'DO_WYJASNIENIA', statusBeforeClarify: 'DO_REALIZACJI', paymentState: 'PAID', cancelReason: null, reservationDeadline: null })
    expect((o.flags as { doWyjasnienia?: string; brakuje?: boolean }).brakuje).toBe(true)
    expect(await db.shortage.aggregate({ where: { orderId: orderId!, state: 'OPEN' }, _sum: { qtyBase: true } })).toMatchObject({ _sum: { qtyBase: 2 } })
    expect((await stockOf(db, a)).reserved).toBe(5)
    await expectInvariants(db)
  })

  it('przywrócone nieopłacone: NOWE z nowym terminem płatności liczonym od przywrócenia', async () => {
    const r = revisions(1, 'UNPAID')
    const { orderId } = await ingestOrder(db, r(1, { cancelled: false }), { now: T0 })
    await ingestOrder(db, r(2, { cancelled: true }), { now: T0 })
    const later = new Date(T0.getTime() + 10 * 24 * 3600_000)
    await ingestOrder(db, r(3, { cancelled: false }), { now: later })
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId! } })
    expect(o.status).toBe('NOWE')
    expect(o.reservationDeadline!.getTime()).toBeGreaterThan(later.getTime())
    await expectInvariants(db)
  })

  it('anulowane przez obsługę: kanał z opłaconą rewizją nie przywraca — alert „płatność po anulowaniu” (bez zmian)', async () => {
    const r = revisions(1, 'UNPAID')
    const { orderId } = await ingestOrder(db, r(1, { cancelled: false }), { now: T0 })
    await cancelOrder(db, orderId!, { actorId: 'panel:obsluga', now: T0 })
    const res = await ingestOrder(db, r(2, { cancelled: false, paymentState: 'PAID' }), { now: T0 })
    expect(res.status).toBe('ANULOWANE')
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await db.alert.count({ where: { kind: 'PLATNOSC_PO_ANULOWANIU' } })).toBe(1)
    await expectInvariants(db)
  })

  it('inny tor (np. webhook) nie przywraca anulowania z odczytu; bez informacji o anulowaniu (cancelled pominięte) też nie', async () => {
    const r = revisions(1)
    const { orderId } = await ingestOrder(db, r(1, { cancelled: false }), { now: T0 })
    await ingestOrder(db, r(2, { cancelled: true }), { now: T0 })
    await ingestOrder(db, r(3, { cancelled: false, source: 'woo-webhook' }), { now: T0 })
    await ingestOrder(db, r(4, { cancelled: undefined }), { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId! } })).status).toBe('ANULOWANE')
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('anulowane po fakturze: bez automatu, alert dla obsługi', async () => {
    const r = revisions(1)
    const { orderId } = await ingestOrder(db, r(1, { cancelled: false }), { now: T0 })
    await packOrder(db, orderId!, { now: T0 })
    expect(await issueInvoice(db, orderId!, new FakeWfirma(), { now: T0 })).toBe('WYSTAWIONA')
    await ingestOrder(db, r(2, { cancelled: true }), { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId! } })).status).toBe('ANULOWANE')
    await ingestOrder(db, r(3, { cancelled: false }), { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId! } })).status).toBe('ANULOWANE')
    expect(await db.alert.count({ where: { kind: 'REAKTYWACJA_PO_FAKTURZE' } })).toBe(1)
    await expectInvariants(db)
  })

  it('anulowane i niższy status kanału (bez reaktywacji): zostaje ANULOWANE, nie „Do wyjaśnienia” bez rezerwacji', async () => {
    const r = revisions(1)
    const { orderId } = await ingestOrder(db, r(1, { cancelled: false, channelStatusRank: 20 }), { now: T0 })
    await cancelOrder(db, orderId!, { actorId: 'panel:obsluga', now: T0 })
    await ingestOrder(db, r(2, { cancelled: false, channelStatusRank: 10 }), { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId! } })).status).toBe('ANULOWANE')
    await expectInvariants(db)
  })
})

describe('reaktywacja w cieniu (fałszywy kanał Woo)', () => {
  it('processing → failed → processing: rezerwacja wraca, raport cienia nie pokaże już „ANULOWANE → Do realizacji”', async () => {
    const state = new FakeChannelState()
    const registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
    await offer(db, 'WOO_SD', '10', a)
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
    const acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    const secrets = { env: {}, envFallback: false }
    const lines = [{ externalLineId: '1', offerExternalId: '10', qty: 2, unitPriceGross: 10, vatRate: '23' }]
    state.upsertOrder(fakeOrder({ externalId: '700', revision: '2026-10-27T10:00:00.000Z', paymentState: 'UNPAID', channelStatus: 'pending', statusRank: 10, lines }))
    await pollAccount(db, acc, { registry, secrets, now: () => new Date('2026-10-27T10:01:00Z') })
    // dane sprzed zmiany znaczenia failed: dawna mapa Woo zapisywała failed jako anulowane (CANCELLED); zostają jako przypadek historyczny
    state.upsertOrder(fakeOrder({ externalId: '700', revision: '2026-10-27T10:05:00.000Z', paymentState: 'UNPAID', channelStatus: 'failed', statusRank: null, lifecycle: 'CANCELLED', lines }))
    await pollAccount(db, acc, { registry, secrets, now: () => new Date('2026-10-27T10:06:00Z') })
    expect((await db.order.findFirstOrThrow({ where: { externalId: '700' } })).status).toBe('ANULOWANE')
    state.upsertOrder(fakeOrder({ externalId: '700', revision: '2026-10-27T10:20:00.000Z', paymentState: 'PAID', channelStatus: 'processing', statusRank: 20, lines }))
    await pollAccount(db, acc, { registry, secrets, now: () => new Date('2026-10-27T10:21:00Z') })
    expect(await db.order.findFirstOrThrow({ where: { externalId: '700' } })).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID' })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })
})
