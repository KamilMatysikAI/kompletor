// host zapisu na kanały na bazie, z fałszywym adapterem (kanał w pamięci, bez sieci). Stany przez
// runStockPush z adapterem od hosta, statusy i numery nadania przez ChannelWrite: raz na przejście (także przy dwóch
// przebiegach naraz), PRZEJSCIOWY = ponowienie z odstępem, NIEJEDNOZNACZNY = alert bez ponowienia, cień = „wysłałbym”,
// wyłącznik konta = zero wywołań kanału, „Wypchnij teraz”. Żadnych prawdziwych sklepów ani danych klientów.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import {
  adapterStanowKonta,
  przelaczNaWersjeZZapisem,
  wyslijStanyKonta,
  ekranZapisu,
  przebiegZapisuKanalow,
  wykonajZapisy,
  wypchnijTeraz,
  zaplanujZapisy,
  zapiszMapeStatusow,
  ZDARZENIE_NUMER_NADANIA,
} from '@/lib/kanaly/zapis-host'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { processAllocateEvents } from '@/lib/rdzen/przydzial'
import { recordOrderPoll, runFanout, runStockPush } from '@/lib/rdzen/propagacja'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY } from '@/lib/adaptery/allegro-wysylam-zapis'
import { DPD_ZAPIS_KEY } from '@/lib/adaptery/dpd'
import { zapiszAutomatyWysylki } from '@/lib/wysylka/automaty'
import { ORG_A, testDb, truncateAll } from './db'
import { ACC, offer, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const SRC = { env: {}, envFallback: false }
const S = 1000
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)
const SD = ACC.WOO_SD
const where = { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...SD } }

let state: FakeChannelState
let registry: AdapterRegistry

async function konto(data: { stockMode?: 'CIEN' | 'PRACA'; statusMode?: 'CIEN' | 'PRACA'; trackingMode?: 'CIEN' | 'PRACA'; config?: Record<string, unknown> }) {
  const { config, ...modes } = data
  await db.channelConfig.update({ where, data: { adapterKey: 'fake.v1', ...modes, ...(config ? { config: config as Prisma.InputJsonValue } : {}) } })
}

async function zamowienie(status: 'WYSLANE' | 'ANULOWANE' | 'DO_REALIZACJI', extra: { cancelReason?: string } = {}) {
  const a = await product(db, `P-${Math.random().toString(36).slice(2, 8)}`, 5)
  const r = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
  await db.order.update({ where: { id: r.orderId! }, data: { status, ...extra } })
  return db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
}

const ctx = (now: Date) => ({ registry, secrets: SRC, now })
/** Adapter stanów konta, które może zapisać (test oczekuje braku blokady konfiguracją). */
async function stanowy(c: ReturnType<typeof ctx>) {
  const a = await adapterStanowKonta(db, SD, c)
  if (a && 'zablokowane' in a) throw new Error(`konto zablokowane: ${a.zablokowane}`)
  return a
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
})

describe('stany przez host (pkt 1)', () => {
  it('PRACA + zapis włączony: spadek stanu trafia do adaptera w ≤ 5 min (jeden przebieg propagacji co 30 s)', async () => {
    await konto({ stockMode: 'PRACA', config: { zapisWlaczony: true } })
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'WOO_SD', '10', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: at(S) })
    await runFanout(db, { now: at(5 * S) })
    const ad = await stanowy(ctx(at(30 * S)))
    expect(ad).not.toBeNull()
    const st = await runStockPush(db, SD, ad, { now: at(30 * S) })
    expect(st.sent).toBe(1)
    expect(state.stock.get('10')).toBe(3)
    const log = await db.channelPushLog.findFirstOrThrow({ where: { offerId: of } })
    expect(log.mode).toBe('PRACA')
    expect(log.delayMs).toBeLessThanOrEqual(5 * M)
    expect((await db.channelOffer.findUniqueOrThrow({ where: { id: of } })).lastPushedQty).toBe(3)
  })

  it('wzrost czeka na odczyt zamówień kanału, potem idzie (kanał sam zdejmuje stan)', async () => {
    await konto({ stockMode: 'PRACA', config: { zapisWlaczony: true } })
    const a = await product(db, 'A', 2)
    const of = await offer(db, 'WOO_SD', '10', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 2, lastPushedAt: T0 } })
    await applyStockRead(db, { productId: a, countBase: 6, requestSentAt: at(S) }, { now: at(S) })
    await processAllocateEvents(db, { now: at(2 * S) })
    await runFanout(db, { now: at(3 * S) })
    const ad = await stanowy(ctx(at(10 * S)))
    expect((await runStockPush(db, SD, ad, { now: at(10 * S) })).waitingForPoll).toBe(1)
    expect(state.stock.has('10')).toBe(false)
    await recordOrderPoll(db, { ...SD, startedAt: at(20 * S), finishedAt: at(25 * S), ok: true })
    expect((await runStockPush(db, SD, ad, { now: at(60 * S) })).sent).toBe(1)
    expect(state.stock.get('10')).toBe(6)
  })

  it('zapis wyłączony w koncie (PRACA): zero wywołań kanału, job czeka z powodem, kanał nie jest „niedostępny”', async () => {
    await konto({ stockMode: 'PRACA', config: {} })
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'WOO_SD', '10', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(S) })
    await runFanout(db, { now: at(2 * S) })
    for (const m of [3, 20, 40]) expect(await wyslijStanyKonta(db, SD, ctx(at(m * M)))).toMatchObject({ zablokowane: expect.stringMatching(/zapis do sklepu wyłączony/) })
    expect(state.writeCalls).toEqual([])
    const job = await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })
    expect(job.lastError).toMatch(/zapis do sklepu wyłączony/)
    expect(job.attempts).toBe(0)
    expect(await db.channelHealth.count({ where: { failingSince: { not: null } } })).toBe(0)
    expect(await db.alert.count({ where: { kind: 'KANAL_NIEDOSTEPNY' } })).toBe(0)
  })

  it('konto w cieniu: host nie daje adaptera, rdzeń zapisuje „wysłałbym”', async () => {
    await konto({ config: { zapisWlaczony: true } })
    expect(await adapterStanowKonta(db, SD, ctx(at(0)))).toBeNull()
  })

  it('NIEJEDNOZNACZNY bez śladu w kanale po odszukaniu = PRZEJSCIOWY (ponowienie); z wykonaniem = OK', async () => {
    await konto({ stockMode: 'PRACA', config: { zapisWlaczony: true } })
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'WOO_SD', '10', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(S) })
    await runFanout(db, { now: at(2 * S) })
    state.writeFailures.push('NIEJEDNOZNACZNY_NIEWYKONANY')
    const ad = await stanowy(ctx(at(3 * S)))
    expect((await runStockPush(db, SD, ad, { now: at(3 * S) })).failed).toBe(1)
    const job = await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })
    expect(job.nextAttemptAt.getTime() - at(3 * S).getTime()).toBeLessThanOrEqual(30 * S)
    state.writeFailures.push('NIEJEDNOZNACZNY_WYKONANY')
    expect((await runStockPush(db, SD, ad, { now: at(40 * S) })).sent).toBe(1)
    expect(state.stock.get('10')).toBe(4)
  })

  it('NIEJEDNOZNACZNY, którego nie da się rozstrzygnąć: alert, job odstawiony (bez ponowienia); „Wypchnij teraz” go wznawia', async () => {
    await konto({ stockMode: 'PRACA', config: { zapisWlaczony: true } })
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'WOO_SD', '10', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(S) })
    await runFanout(db, { now: at(2 * S) })
    const niepewny = { push: async (items: { offerId: string }[]) => items.map((i) => ({ offerId: i.offerId, ok: false, kind: 'NIEJEDNOZNACZNY' as const, error: 'timeout po wysłaniu' })) }
    await runStockPush(db, SD, niepewny, { now: at(3 * S) })
    const job = await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })
    expect(job.nextAttemptAt.getTime()).toBeGreaterThan(at(24 * 3600 * S).getTime())
    expect(await db.alert.count({ where: { kind: 'KANAL_STAN_NIEJEDNOZNACZNY' } })).toBe(1)
    const ad = await stanowy(ctx(at(60 * S)))
    expect((await runStockPush(db, SD, ad, { now: at(60 * S) })).sent).toBe(0) // odstawiony
    await wypchnijTeraz(db, SD, { now: at(70 * S), actorId: 'test' })
    expect((await runStockPush(db, SD, ad, { now: at(70 * S) })).sent).toBe(1)
    expect(state.stock.get('10')).toBe(4)
  })
})

describe('statusy i numery nadania (pkt 2–4)', () => {
  it('„Wysłane” trafia do setOrderStatus raz, także przy dwóch przebiegach naraz i powtórce', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    const o = await zamowienie('WYSLANE')
    await Promise.all([przebiegZapisuKanalow(db, ctx(at(M))), przebiegZapisuKanalow(db, ctx(at(M)))])
    await przebiegZapisuKanalow(db, ctx(at(2 * M)))
    const calls = state.writeCalls.filter((c) => c.op === 'status')
    expect(calls).toEqual([{ op: 'status', reference: expect.any(String), target: `${o.externalId}:completed` }])
    expect(state.statuses.get(o.externalId)).toBe('completed')
    const w = await db.channelWrite.findMany()
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: 'STATUS', key: 'WYSLANE', channelStatus: 'completed', state: 'WYSLANE', mode: 'PRACA', attempts: 1 })
  })

  it('PRZEJSCIOWY = ponowienie z odstępem; TRWALY = błąd i alert bez ponowienia', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    const o1 = await zamowienie('WYSLANE')
    state.writeFailures.push('PRZEJSCIOWY')
    let r: { ponowienia: number; wyslane: number; bledy: number } = await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(r.ponowienia).toBe(1)
    const w1 = await db.channelWrite.findFirstOrThrow({ where: { orderId: o1.id } })
    expect(w1.state).toBe('OCZEKUJE')
    expect(w1.nextAttemptAt.getTime()).toBeGreaterThan(at(M).getTime())
    r = await wykonajZapisy(db, ctx(at(M + 5 * S))) // za wcześnie
    expect(r.wyslane).toBe(0)
    r = await wykonajZapisy(db, ctx(at(3 * M)))
    expect(r.wyslane).toBe(1)
    const o2 = await zamowienie('WYSLANE')
    state.writeFailures.push('TRWALY')
    r = await przebiegZapisuKanalow(db, ctx(at(4 * M)))
    expect(r.bledy).toBe(1)
    expect(await db.channelWrite.findFirstOrThrow({ where: { orderId: o2.id } })).toMatchObject({ state: 'BLAD' })
    expect(await db.alert.count({ where: { kind: 'KANAL_ZAPIS_BLAD' } })).toBe(1)
    await wykonajZapisy(db, ctx(at(60 * M)))
    expect(state.writeCalls.filter((c) => c.target.startsWith(o2.externalId))).toHaveLength(1)
  })

  it('NIEJEDNOZNACZNY nierozstrzygnięty: alert, bez ponowienia; „Wypchnij teraz” wznawia; rozstrzygnięty odszukaniem = OK', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    const o = await zamowienie('WYSLANE')
    state.writeFailures.push('NIEJEDNOZNACZNY_WYKONANY')
    expect((await przebiegZapisuKanalow(db, ctx(at(M)))).wyslane).toBe(1) // odszukanie po referencji znalazło
    const o2 = await zamowienie('WYSLANE')
    // fałszywy kanał bez odszukania nie istnieje — symulacja: wiersz porzucony w trakcie zapisu (przebieg padł)
    await zaplanujZapisy(db, registry, { now: at(2 * M) })
    await db.channelWrite.updateMany({ where: { orderId: o2.id }, data: { state: 'WYSYLANIE', lockedAt: at(2 * M) } })
    const r = await wykonajZapisy(db, ctx(at(20 * M)))
    expect(r.porzucone).toBe(1)
    expect(await db.channelWrite.findFirstOrThrow({ where: { orderId: o2.id } })).toMatchObject({ state: 'NIEJEDNOZNACZNY' })
    expect(await db.alert.count({ where: { kind: 'KANAL_ZAPIS_NIEJEDNOZNACZNY' } })).toBe(1)
    await wykonajZapisy(db, ctx(at(60 * M)))
    expect(state.writeCalls.filter((c) => c.target.startsWith(o2.externalId))).toHaveLength(0)
    expect((await wypchnijTeraz(db, SD, { now: at(61 * M), actorId: 'test' })).zapisy).toBe(1)
    expect((await wykonajZapisy(db, ctx(at(61 * M)))).wyslane).toBe(1)
    expect(state.statuses.get(o2.externalId)).toBe('completed')
    expect(state.statuses.get(o.externalId)).toBe('completed')
  })

  it('cień: wiersz „wysłałbym”, zero wywołań kanału; zapis wyłączony w PRACA: bez wierszy, zero wywołań', async () => {
    await konto({ config: { zapisWlaczony: true } })
    await zamowienie('WYSLANE')
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(await db.channelWrite.findFirstOrThrow()).toMatchObject({ state: 'CIEN', mode: 'CIEN' })
    expect(state.writeCalls).toEqual([])
    await truncateAll(db)
    await seedBase(db)
    await konto({ statusMode: 'PRACA', config: {} })
    await zamowienie('WYSLANE')
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(await db.channelWrite.count()).toBe(0) // konto, które nie zapisze, nie zbiera zaległości
    expect(state.writeCalls).toEqual([])
  })

  it('anulowanie nieopłaconego po terminie idzie z warunkiem „tylko nieopłacone”; opłacone w kanale = błąd, status bez zmian', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    const o1 = await zamowienie('ANULOWANE', { cancelReason: 'EXPIRED_UNPAID' })
    const o2 = await zamowienie('ANULOWANE', { cancelReason: 'EXPIRED_UNPAID' })
    state.paid.add(o2.externalId)
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(state.statuses.get(o1.externalId)).toBe('cancelled')
    expect(state.statuses.has(o2.externalId)).toBe(false)
    expect(await db.channelWrite.findFirstOrThrow({ where: { orderId: o1.id } })).toMatchObject({ key: 'ANULOWANE_NIEOPLACONE', state: 'WYSLANE' })
    expect(await db.channelWrite.findFirstOrThrow({ where: { orderId: o2.id } })).toMatchObject({ state: 'BLAD' })
  })

  it('mapa statusów konta z panelu: pusty = nie wysyłamy, własny status kanału wysyłany', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    await zapiszMapeStatusow(db, SD, { status_WYSLANE: 'processing', status_ANULOWANE: '' }, { registry, actorId: 'test' })
    const cfg = await db.channelConfig.findUniqueOrThrow({ where })
    expect((cfg.config as Record<string, unknown>)['statusy']).toEqual({ WYSLANE: 'processing' })
    expect((cfg.config as Record<string, unknown>)['zapisWlaczony']).toBe(true) // reszta konfiguracji zostaje
    const o = await zamowienie('WYSLANE')
    const c = await zamowienie('ANULOWANE', { cancelReason: 'CANCELLED' })
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(state.statuses.get(o.externalId)).toBe('processing')
    expect(state.statuses.has(c.externalId)).toBe(false)
    await expect(zapiszMapeStatusow(db, SD, { status_WYSLANE: 'zły status!' }, { registry, actorId: 'test' })).rejects.toThrow(/Zły status/)
  })

  it('numer nadania: zdarzenie NUMER_NADANIA_GOTOWY (przesyłka) i numer przy „Wysłane” → setTracking raz na numer', async () => {
    await konto({ trackingMode: 'PRACA', config: { zapisWlaczony: true } })
    const o = await zamowienie('DO_REALIZACJI')
    const after = { shipmentId: 'sh1', orderId: o.id, packageNo: 1, carrier: 'DPD', trackingNumber: '1000123456789U', adapterKey: 'dpd.services.zapis.v1' }
    await db.auditLog.create({ data: { entity: ZDARZENIE_NUMER_NADANIA, entityId: 'sh1', actorId: 'system', after } })
    await db.auditLog.create({ data: { entity: ZDARZENIE_NUMER_NADANIA, entityId: 'sh1', actorId: 'system', after } }) // dubel zdarzenia
    await db.orderEvent.create({ data: { orderId: o.id, kind: 'WYSLANE', actorId: 'panel', data: { z: 'DO_WYSLANIA', na: 'WYSLANE', nadanie: '1000123456789U' } } })
    await Promise.all([przebiegZapisuKanalow(db, ctx(at(M))), przebiegZapisuKanalow(db, ctx(at(M)))])
    expect(state.writeCalls.filter((c) => c.op === 'tracking')).toHaveLength(1)
    expect(state.trackings.get(o.externalId)).toEqual([{ number: '1000123456789U', carrier: 'DPD', url: null }])
    // zły numer (np. z literówką spacji) nie wychodzi
    await db.orderEvent.create({ data: { orderId: o.id, kind: 'WYSLANE', actorId: 'panel', data: { nadanie: 'zły numer' } } })
    expect((await zaplanujZapisy(db, registry, { now: at(2 * M) })).nadania).toBe(0)
  })

  it('link śledzenia do sklepu: wyłączony = sam numer; włączony = adres strony przewoźnika tylko dla paczki z modułu przewoźnika', async () => {
    await konto({ trackingMode: 'PRACA', config: { zapisWlaczony: true } })
    const nadaj = async (o: { id: string }, numer: string, adapterKey: string, carrier: 'DPD' | 'PACZKOMATY') => {
      const sh = await db.shipment.create({ data: { orderId: o.id, packageNo: 1, reference: `link-${numer}`, state: 'UTWORZONA', adapterKey, carrier, trackingNumber: numer } })
      await db.auditLog.create({ data: { entity: ZDARZENIE_NUMER_NADANIA, entityId: sh.id, actorId: 'system', after: { shipmentId: sh.id, orderId: o.id, packageNo: 1, carrier, trackingNumber: numer, adapterKey } } })
    }
    const wylaczony = await zamowienie('DO_REALIZACJI')
    await nadaj(wylaczony, '1000123456781U', DPD_ZAPIS_KEY, 'DPD')
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(state.trackings.get(wylaczony.externalId)).toEqual([{ number: '1000123456781U', carrier: 'DPD', url: null }])
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, linkSledzeniaDoSklepu: true }, 'u-admin')
    const dpd = await zamowienie('DO_REALIZACJI')
    await nadaj(dpd, '1000123456782U', DPD_ZAPIS_KEY, 'DPD')
    // Wysyłam z Allegro dobiera przewoźnika sam: numer nie musi być numerem InPost, więc bez linku
    const allegro = await zamowienie('DO_REALIZACJI')
    await nadaj(allegro, 'A000TESTALLEGRO2', ALLEGRO_WYSYLAM_ZAPIS_KEY, 'PACZKOMATY')
    await przebiegZapisuKanalow(db, ctx(at(2 * M)))
    expect(state.trackings.get(dpd.externalId)).toEqual([{ number: '1000123456782U', carrier: 'DPD', url: 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=1000123456782U' }])
    expect(state.trackings.get(allegro.externalId)).toEqual([{ number: 'A000TESTALLEGRO2', carrier: 'PACZKOMATY', url: null }])
    // zapis już zaplanowany nie zmienia się po włączeniu (bez drugiego zapisu tego samego numeru)
    expect(state.writeCalls.filter((c) => c.op === 'tracking' && c.target.startsWith(wylaczony.externalId))).toHaveLength(1)
    expect(await db.channelWrite.findFirstOrThrow({ where: { orderId: dpd.id, kind: 'NADANIE' } })).toMatchObject({ trackingUrl: 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=1000123456782U' })
  })

  it('trwały błąd stanu po 8 próbach: alert i job odstawiony', async () => {
    await konto({ stockMode: 'PRACA', config: { zapisWlaczony: true } })
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'WOO_SD', '10', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(S) })
    await runFanout(db, { now: at(2 * S) })
    const ad = await stanowy(ctx(at(3 * S)))
    for (let i = 0; i < 8; i++) {
      state.writeFailures.push('TRWALY')
      await db.stockSyncJob.updateMany({ data: { nextAttemptAt: at(0) } })
      await runStockPush(db, SD, ad, { now: at((10 + i) * M) })
    }
    const job = await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: of } })
    expect(job.attempts).toBe(8)
    expect(job.nextAttemptAt.getTime()).toBeGreaterThan(at(24 * 60 * M).getTime())
    expect(await db.alert.count({ where: { kind: 'KANAL_STAN_BLAD' } })).toBe(1)
  })

  it('małe paczki zajęcia — jeden przebieg wysyła więcej niż jedną paczkę, każdy wiersz z odświeżonym zajęciem', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    for (let i = 0; i < 12; i++) await zamowienie('WYSLANE')
    const r = await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(r.wyslane).toBe(12)
    expect(await db.channelWrite.count({ where: { state: 'WYSLANE', lockedAt: null } })).toBe(12)
  })

  it('stary wiersz po ponowieniu nie cofa statusu, gdy zamówienie poszło dalej', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    await zapiszMapeStatusow(db, SD, { status_DO_REALIZACJI: 'processing', status_WYSLANE: 'completed' }, { registry, actorId: 'test' })
    const o = await zamowienie('DO_REALIZACJI')
    state.writeFailures.push('PRZEJSCIOWY')
    expect((await przebiegZapisuKanalow(db, ctx(at(M)))).ponowienia).toBe(1)
    await db.order.update({ where: { id: o.id }, data: { status: 'WYSLANE' } })
    await przebiegZapisuKanalow(db, ctx(at(M + 10 * S))) // wiersz WYSLANE idzie, DO_REALIZACJI jeszcze czeka (odstęp 30 s)
    const r = await przebiegZapisuKanalow(db, ctx(at(10 * M)))
    expect(r.pominiete).toBe(1)
    expect(state.statuses.get(o.externalId)).toBe('completed')
    expect(state.writeCalls.filter((c) => c.op === 'status').map((c) => c.target.split(':')[1])).toEqual(['processing', 'completed'])
    expect(await db.channelWrite.findFirstOrThrow({ where: { orderId: o.id, key: 'DO_REALIZACJI' } })).toMatchObject({ state: 'WYSLANE', result: 'pominięte: zamówienie poszło dalej' })
  })

  it('konto w PRACA z wyłączonym zapisem nie zbiera wierszy; „Wypchnij teraz” ponawia tylko 2 doby', async () => {
    await konto({ statusMode: 'PRACA', config: {} })
    await zamowienie('WYSLANE')
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(await db.channelWrite.count()).toBe(0)
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    const o = await zamowienie('WYSLANE')
    state.writeFailures.push('TRWALY', 'TRWALY')
    await przebiegZapisuKanalow(db, ctx(at(2 * M)))
    expect(await db.channelWrite.count({ where: { state: 'BLAD' } })).toBe(2)
    await db.channelWrite.updateMany({ where: { orderId: { not: o.id } }, data: { createdAt: at(-3 * 24 * 60 * M) } }) // stary
    expect((await wypchnijTeraz(db, SD, { now: at(3 * M), actorId: 'test' })).zapisy).toBe(1)
  })

  it('przełączenie na wersję z zapisem zawsze zostawia zapis wyłączony', async () => {
    const zapisowy = fakeDefinition(state, 'WOO', 'fake.zapis.v1')
    const ro = fakeDefinition(state, 'WOO', 'fake.v1', { readOnly: true })
    registry = new AdapterRegistry([ro, zapisowy])
    await konto({ config: { zapisWlaczony: true, label: 'x' } })
    expect(await przelaczNaWersjeZZapisem(db, SD, { registry, actorId: 'test' })).toBe('fake.zapis.v1')
    const cfg = await db.channelConfig.findUniqueOrThrow({ where })
    expect(cfg.adapterKey).toBe('fake.zapis.v1')
    expect(cfg.config).toMatchObject({ zapisWlaczony: false, label: 'x' })
  })

  it('ekran konta: tryby, powody, mapa domyślna z manifestu, ostatnie zapisy', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    await zamowienie('WYSLANE')
    await przebiegZapisuKanalow(db, ctx(at(M)))
    const e = (await ekranZapisu(db, registry, SD, at(2 * M)))!
    expect(e.powody.statusy).toBeNull()
    expect(e.powody.stany).toMatch(/podglądu/)
    expect(e.mapaWlasna).toBe(false)
    expect(e.mapa).toMatchObject({ WYSLANE: 'completed' })
    expect(e.zapisy.ostatnie[0]).toMatchObject({ rodzaj: 'STATUS', stan: 'wysłane', co: 'Wysłane → Zrealizowane' })
  })
})
