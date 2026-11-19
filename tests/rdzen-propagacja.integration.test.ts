// Rdzeń: propagacja stanu i tryb cienia (spec 11: 37, 40, 42, 43). Atrapy adapterów kanałów — bez sieci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { type AdapterStanow, type PushItem, recordOrderPoll, runFanout, runNightlyFullSync, runRecoveredFullSyncs, runStockPush } from '@/lib/rdzen/propagacja'
import { rejectShortagesAtAcceptance } from '@/lib/rdzen/brakuje'
import { processAllocateEvents } from '@/lib/rdzen/przydzial'
import { issueInvoice, packOrder } from '@/lib/rdzen/rozchod'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, testDb, truncateAll } from './db'
import { ACC, FakeWfirma, offer, order, product, seedBase, T0, type TestChannel } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const S = 1000
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

class FakeChannel implements AdapterStanow {
  pushed: PushItem[][] = []
  failing = false
  async push(items: PushItem[]) {
    if (this.failing) throw new Error('atrapa: kanał nie odpowiada (503)')
    this.pushed.push(items)
    return items.map((i) => ({ offerId: i.offerId, ok: true }))
  }
}

const praca = (label: TestChannel) =>
  db.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...ACC[label] } }, data: { stockMode: 'PRACA' } })

describe('propagacja', () => {
  it('40: 10 zmian stanu produktu w 2 s → jeden job na ofertę z ostatnim targetem', async () => {
    const a = await product(db, 'A', 20)
    const of = await offer(db, 'WOO_SD', 'wa', a)
    for (let i = 0; i < 10; i++) await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(i * 200) })
    const f = await runFanout(db, { now: at(2 * S) })
    expect(f.events).toBe(10)
    const jobs = await db.stockSyncJob.findMany()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ offerId: of, targetQty: 10, firstChangeAt: at(0) })
  })

  it('37: spadek wysłany od razu; wzrost dopiero po odczycie zamówień rozpoczętym po wyliczeniu targetu; zamówienie w oknie obniża target', async () => {
    await praca('WOO_SD')
    const ch = new FakeChannel()
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'WOO_SD', 'wa', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(S) })
    await runFanout(db, { now: at(2 * S) })
    expect((await runStockPush(db, ACC.WOO_SD, ch, { now: at(3 * S) })).sent).toBe(1) // spadek bez odczytu zamówień
    // dostawa +3 → wzrost do 7
    await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(10 * S) }, { now: at(10 * S) })
    await processAllocateEvents(db, { now: at(11 * S) })
    await runFanout(db, { now: at(12 * S) })
    expect((await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })).targetQty).toBe(7)
    expect((await runStockPush(db, ACC.WOO_SD, ch, { now: at(13 * S) })).waitingForPoll).toBe(1)
    // odczyt zamówień startuje po wyliczeniu targetu; w jego trakcie przychodzi zamówienie (2 szt.)
    await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: at(15 * S) })
    await recordOrderPoll(db, { channel: 'WOO', channelAccountId: 'sd', startedAt: at(14 * S), finishedAt: at(20 * S), ok: true })
    await runFanout(db, { now: at(16 * S) }) // target przeliczony: 5
    expect((await runStockPush(db, ACC.WOO_SD, ch, { now: at(21 * S) })).waitingForPoll).toBe(1) // odczyt zaczął się przed nowym targetem
    await recordOrderPoll(db, { channel: 'WOO', channelAccountId: 'sd', startedAt: at(75 * S), finishedAt: at(80 * S), ok: true })
    expect((await runStockPush(db, ACC.WOO_SD, ch, { now: at(81 * S) })).sent).toBe(1)
    expect(ch.pushed.flat().map((p) => p.targetQty)).toEqual([4, 5]) // 7 nigdy nie wyszło
  })

  it('42: kanał zwraca błędy 15 min → jeden alert, joby z odstępem; po powrocie wysłane + pełna synchronizacja', async () => {
    await praca('ALLEGRO')
    const ch = new FakeChannel()
    ch.failing = true
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 5)
    const oa = await offer(db, 'ALLEGRO', 'aa', a)
    const ob = await offer(db, 'ALLEGRO', 'ab', b)
    await db.channelOffer.updateMany({ data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 1 }], { channel: 'ALLEGRO' }), { now: at(0) })
    await runFanout(db, { now: at(0) })
    let attempts = 0
    for (let t = 0; t <= 16 * M; t += 15 * S) {
      const r = await runStockPush(db, ACC.ALLEGRO, ch, { now: at(t) })
      attempts += r.failed
    }
    expect(attempts).toBeLessThan(12) // odstępy 30 s, 1, 2, 5 min — nie co 15 s
    const job = await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: oa } })
    expect(job.lastError).toMatch(/503/)
    expect(await db.alert.count({ where: { kind: 'KANAL_NIEDOSTEPNY' } })).toBe(1)
    ch.failing = false
    await runStockPush(db, ACC.ALLEGRO, ch, { now: at(30 * M) })
    expect(ch.pushed.flat().map((p) => [p.offerId, p.targetQty])).toEqual([[oa, 4]])
    expect((await db.channelHealth.findUniqueOrThrow({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...ACC.ALLEGRO } } })).needsFullSync).toBe(true)
    expect(await runRecoveredFullSyncs(db, { now: at(31 * M) })).toEqual([ACC.ALLEGRO])
    await recordOrderPoll(db, { channel: 'ALLEGRO', channelAccountId: 'allegro', startedAt: at(32 * M), finishedAt: at(32 * M + S), ok: true })
    await runStockPush(db, ACC.ALLEGRO, ch, { now: at(33 * M) })
    expect(ch.pushed.at(-1)!.map((p) => p.offerId).sort()).toEqual([oa, ob].sort()) // pełna synchronizacja obu ofert
  })

  it('43: tryb CIEN → atrapy adapterów zapisu wywołane 0 razy, raport „wysłałbym” wypełniony', async () => {
    const ch = new FakeChannel()
    const a = await product(db, 'A', 5)
    await offer(db, 'WOO_SD', 'wa', a)
    await offer(db, 'EMPIK', 'ea', a)
    await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: at(0) })
    await runFanout(db, { now: at(0) })
    for (const c of ['WOO_SD', 'EMPIK'] as const) {
      await recordOrderPoll(db, { ...ACC[c], startedAt: at(S), finishedAt: at(2 * S), ok: true })
      await runStockPush(db, ACC[c], ch, { now: at(3 * S) })
    }
    expect(ch.pushed).toHaveLength(0)
    const log = await db.channelPushLog.findMany()
    expect(log.map((l) => `${l.channel}:${l.mode}:${l.targetQty}`).sort()).toEqual(['EMPIK:CIEN:3', 'WOO:CIEN:3'])
    // „wysłałbym” nie udaje wysyłki: lastPushedQty zostaje bez zmian (po przejściu w PRACA nic nie zostanie pominięte)
    expect((await db.channelOffer.findMany()).map((o) => o.lastPushedQty)).toEqual([null, null])
  })

  it('PRACA bez adaptera → nic nie wychodzi, błąd w jobie (zero zapisów na kanały w tym zadaniu)', async () => {
    await praca('WOO_SD')
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'WOO_SD', 'wa', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(0) })
    await runFanout(db, { now: at(0) })
    const r = await runStockPush(db, ACC.WOO_SD, null, { now: at(S) })
    expect(r).toMatchObject({ sent: 0, failed: 1 })
    expect((await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })).lastError).toMatch(/bez adaptera/)
  })

  it('Empik: paczka maks. raz na minutę', async () => {
    await praca('EMPIK')
    const ch = new FakeChannel()
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'EMPIK', 'ea', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(0) })
    await runFanout(db, { now: at(0) })
    expect((await runStockPush(db, ACC.EMPIK, ch, { now: at(S) })).sent).toBe(1)
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(2 * S) })
    await runFanout(db, { now: at(2 * S) })
    expect((await runStockPush(db, ACC.EMPIK, ch, { now: at(30 * S) })).throttled).toBe(true)
    expect((await runStockPush(db, ACC.EMPIK, ch, { now: at(62 * S) })).sent).toBe(1)
  })

  it('6.1 pkt 4 (v1.5): anulowanie po fakturze w kanale, który sam zmienia stan → job wymuszony, push mimo niezmienionego targetu', async () => {
    await praca('WOO_SD')
    const ch = new FakeChannel()
    const a = await product(db, 'A', 10)
    const of = await offer(db, 'WOO_SD', 'wa', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 10, lastPushedAt: T0 } })
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: 'wa', qty: 2 }]), { now: at(S) })
    await runFanout(db, { now: at(2 * S) })
    expect((await runStockPush(db, ACC.WOO_SD, ch, { now: at(3 * S) })).sent).toBe(1)
    await packOrder(db, orderId!, { now: at(4 * S) })
    await issueInvoice(db, orderId!, new FakeWfirma(), { now: at(4 * S) })
    // klient anulował w Woo: Woo oddało sobie 2 szt. (pokazuje 10), u nas available zostaje 8 (stan nie wraca sam po fakturze)
    await cancelOrder(db, orderId!, { now: at(5 * S) })
    expect(await db.outboxEvent.count({ where: { kind: 'AVAILABLE_CHANGED', createdAt: at(5 * S) } })).toBe(0)
    expect(await db.outboxEvent.count({ where: { kind: 'FORCE_PUSH', offerId: of } })).toBe(1)
    await runFanout(db, { now: at(6 * S) })
    expect(await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })).toMatchObject({ targetQty: 8, force: true })
    const st = await runStockPush(db, ACC.WOO_SD, ch, { now: at(7 * S) }) // < 1 h od wysłania tego samego targetu
    expect(st).toMatchObject({ sent: 1, skippedSame: 0 })
    expect(ch.pushed.flat().map((p) => p.targetQty)).toEqual([8, 8])
  })

  it('6.1 pkt 4: Empik odrzuca pozycję z brakiem przy akceptacji → job wymuszony tylko dla oferty tej pozycji; kanał ręczny bez wymuszenia', async () => {
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 0)
    const oa = await offer(db, 'EMPIK', 'ea', a)
    const ob = await offer(db, 'EMPIK', 'eb', b)
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: 'ea', qty: 1 }, { offerExternalId: 'eb', qty: 1 }], { channel: 'EMPIK', deliveryMethod: 'Dostawa do Salonu Empik' }), { now: at(S) })
    await rejectShortagesAtAcceptance(db, orderId!, { now: at(2 * S) })
    const ev = await db.outboxEvent.findMany({ where: { kind: 'FORCE_PUSH' } })
    expect(ev.map((e) => e.offerId)).toEqual([ob])
    await runFanout(db, { now: at(3 * S) })
    expect((await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: ob } })).force).toBe(true)
    expect((await db.stockSyncJob.findUnique({ where: { offerId: oa } }))?.force ?? false).toBe(false)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }], { channel: 'RECZNE' }), { now: at(4 * S) })
    await cancelOrder(db, r.orderId!, { now: at(5 * S) })
    expect(await db.outboxEvent.count({ where: { kind: 'FORCE_PUSH' } })).toBe(1)
  })

  it('nocna pełna synchronizacja od 3:00 (Warszawa): joby wymuszone dla aktywnych kont kanałów, które same zdejmują stan', async () => {
    const a = await product(db, 'A', 4)
    const woo = await offer(db, 'WOO_SD', 'wa', a)
    await offer(db, 'RECZNE', 'ra', a)
    await db.channelOffer.update({ where: { id: woo }, data: { lastPushedQty: 4, lastPushedAt: T0 } })
    expect(await runNightlyFullSync(db, { now: new Date('2026-10-16T00:30:00Z') })).toEqual([]) // 2:30 w Warszawie
    expect(await db.stockSyncJob.count()).toBe(0)
    const night = new Date('2026-10-16T01:30:00Z') // 3:30 w Warszawie (CEST)
    const accs = await runNightlyFullSync(db, { now: night })
    expect(accs.map((x) => `${x.channel}/${x.channelAccountId}`).sort()).toEqual(['ALLEGRO/allegro', 'EMPIK/empik', 'WOO/km', 'WOO/lampy', 'WOO/sd'])
    expect(await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: woo } })).toMatchObject({ targetQty: 4, force: true })
  })
})
