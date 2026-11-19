// drobne z — budżet wywołań, retryAfterMs, flaga po ponowieniu na limicie
// czas korekty, noc, częściowe PZ, blokada przebiegu, dobowe luki i pętle.
// Atrapa wFirmy w pamięci, dane zmyślone.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestFullRead, READ_APPLY_MAX_TRIES, RUN_LEASE_MS, runWfirmaQueue, runWfirmaQueueExclusive, MISSING_GOOD_MAX_TRIES, type WfirmaApi } from '@/lib/rdzen/kolejka-wfirmy'
import * as lustro from '@/lib/rdzen/lustro'
import { isNightSyncDue, runNightlyFullSync } from '@/lib/rdzen/propagacja'
import { FIND_SCHEDULE_MS, issueInvoice, packOrder, WfirmaLimitError } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { completeCorrection, createReturn, issueCorrection, listCorrectionsWithoutPz, receiveReturn, requestCorrection, resolveUnknownCorrections } from '@/lib/rdzen/zwroty'
import { testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, offer, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const S = 1000
const M = 60_000
const H = 60 * M
const at = (ms: number) => new Date(T0.getTime() + ms)
const WH = '999001'
const api = (wf: FakeWfirma): WfirmaApi => ({ faktury: wf, korekty: wf, odczyt: wf })

async function packed(productId: string, qty = 1, when = T0) {
  const { orderId } = await ingestOrder(db, order([{ productId, qty }], { createdAtChannel: when }), { now: when })
  await packOrder(db, orderId!, { now: when })
  return orderId!
}

/** Timeouty faktur po pierwszej wystawionej (sonda pozytywna ma co znaleźć). */
async function timeouts(n: number, productId: string, wf: FakeWfirma, mode: 'TIMEOUT_AFTER_CREATE' | 'TIMEOUT_NO_CREATE' = 'TIMEOUT_NO_CREATE') {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = await packed(productId)
    wf.next = [mode]
    expect(await issueInvoice(db, id, wf, { now: T0 })).toBe('TIMEOUT')
    ids.push(id)
  }
  return ids
}

describe('budżet obejmuje find, sondy i odczyty WZ', () => {
  it('maxCalls trzyma się przy 5 zaległych timeoutach: sondy i find w budżecie, reszta w następnym przebiegu, bez utraty dokumentu', async () => {
    const a = await product(db, 'A', 20, { wfirmaGoodId: 'g-a' })
    const wf = new FakeWfirma()
    await issueInvoice(db, await packed(a), wf, { now: T0 })
    const ids = await timeouts(5, a, wf, 'TIMEOUT_AFTER_CREATE')
    wf.log = []
    const st1 = await runWfirmaQueue(db, { faktury: wf }, { now: at(M), maxCalls: 4 })
    expect(st1.calls).toBeLessThanOrEqual(4)
    expect(wf.log).toEqual(['find', 'find', 'find', 'find']) // dwie sondy + dwa rozstrzygnięcia
    expect(await db.invoiceAttempt.count({ where: { state: 'UNKNOWN' } })).toBe(3)
    wf.log = []
    await runWfirmaQueue(db, { faktury: wf }, { now: at(2 * M), maxCalls: 2 })
    expect(wf.log).toEqual(['find', 'find']) // sonda ważna dobę: nie powtarza się
    await runWfirmaQueue(db, { faktury: wf }, { now: at(3 * M), maxCalls: 10 })
    expect(await db.invoiceAttempt.count({ where: { state: 'UNKNOWN' } })).toBe(0)
    for (const id of ids) expect(wf.invoices.filter((i) => i.idExternal.startsWith(`${id}/`))).toHaveLength(1)
    await expectInvariants(db)
  })

  it('budżet 1 przy sondzie dwuwywołaniowej: bez sondy i bez find, timeout czeka', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    await issueInvoice(db, await packed(a), wf, { now: T0 })
    await timeouts(1, a, wf)
    wf.log = []
    expect((await runWfirmaQueue(db, { faktury: wf }, { now: at(M), maxCalls: 1 })).calls).toBe(0)
    expect(await db.invoiceAttempt.count({ where: { state: 'UNKNOWN' } })).toBe(1)
  })

  it('ostatnia próba find bez budżetu na ponowienie czeka na przebieg z budżetem: bez flagi błędu i bez porzuconego zamówienia', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    await issueInvoice(db, await packed(a), wf, { now: T0 })
    const [id] = await timeouts(1, a, wf)
    await runWfirmaQueue(db, { faktury: wf }, { now: at(M), maxCalls: 3 }) // sondy + find 1
    await runWfirmaQueue(db, { faktury: wf }, { now: at(3 * M), maxCalls: 1 }) // find 2
    wf.log = []
    await runWfirmaQueue(db, { faktury: wf }, { now: at(6 * M), maxCalls: 1 }) // find 3 wymaga 2 wywołań
    expect(wf.log).toEqual([])
    expect((await db.order.findUniqueOrThrow({ where: { id: id! } })).flags).not.toMatchObject({ fakturaBlad: true })
    await runWfirmaQueue(db, { faktury: wf }, { now: at(7 * M), maxCalls: 2 })
    expect(wf.log).toEqual(['find', 'issue'])
    expect(await db.invoiceAttempt.findFirst({ where: { orderId: id!, state: 'ISSUED' } })).not.toBeNull()
    await expectInvariants(db)
  })

  it('odczyty WZ: budżet na dokument, korekty: find w budżecie', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    wf.wzReadFailures = 2
    await issueInvoice(db, await packed(a), wf, { now: T0 })
    await issueInvoice(db, await packed(a), wf, { now: T0 })
    wf.log = []
    await runWfirmaQueue(db, { faktury: wf }, { now: at(M), maxCalls: 1 })
    expect(wf.log.filter((l) => l === 'readWz')).toHaveLength(1)
    expect(await db.pendingMovement.count({ where: { state: 'APPLIED', wzQty: null } })).toBe(1)
  })
})

describe('retryAfterMs z wyniku LIMIT', () => {
  it('faktura: pauza tyle, ile podała wFirma', async () => {
    const a = await product(db, 'A', 5)
    await packed(a)
    const wf = new FakeWfirma()
    wf.next = ['LIMIT']
    wf.limitRetryAfterMs = 90 * S
    const st = await runWfirmaQueue(db, { faktury: wf }, { now: at(M) })
    expect(st.pausedUntil).toEqual(at(M + 90 * S))
  })

  it('korekta: tak samo; bez podanego czasu 5 min', async () => {
    const a = await product(db, 'A', 5)
    const wf = new FakeWfirma()
    const id = await packed(a)
    await issueInvoice(db, id, wf, { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    const r = await createReturn(db, id, [{ orderLineId: line.id, qty: 1 }], { now: T0 })
    await receiveReturn(db, r, 'NA_STAN')
    await requestCorrection(db, r)
    wf.correctionNext = ['LIMIT']
    wf.limitRetryAfterMs = 2 * M
    expect((await runWfirmaQueue(db, { korekty: wf }, { now: at(M) })).pausedUntil).toEqual(at(3 * M))
    wf.correctionNext = ['LIMIT']
    wf.limitRetryAfterMs = undefined
    expect((await runWfirmaQueue(db, { korekty: wf }, { now: at(10 * M) })).pausedUntil).toEqual(at(15 * M))
  })
})

describe('ponowienie po 3 nieudanych find trafia na limit', () => {
  it('flaga z timeoutu zdjęta: zamówienie wraca do kolejki i dostaje fakturę po pauzie', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    await issueInvoice(db, await packed(a), wf, { now: T0 })
    const [id] = await timeouts(1, a, wf)
    await runWfirmaQueue(db, { faktury: wf }, { now: at(M) })
    await runWfirmaQueue(db, { faktury: wf }, { now: at(3 * M) })
    wf.next = ['LIMIT']
    wf.limitRetryAfterMs = 2 * M
    const st = await runWfirmaQueue(db, { faktury: wf }, { now: at(6 * M) })
    expect(st.pausedUntil).toEqual(at(8 * M)) // retryAfterMs dochodzi też z toru ponowienia
    expect(await db.order.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ status: 'SPAKOWANE' })
    expect((await db.order.findUniqueOrThrow({ where: { id: id! } })).flags).toMatchObject({ fakturaBlad: false })
    const alert = await db.alert.findFirstOrThrow({ where: { kind: 'FAKTURA_BLAD', ref: id! } })
    expect(alert.closedAt).toEqual(at(6 * M)) // flaga zdjęta, alert też
    await runWfirmaQueue(db, { faktury: wf }, { now: at(9 * M) })
    expect(await db.invoiceAttempt.findFirst({ where: { orderId: id!, state: 'ISSUED' } })).not.toBeNull()
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD', closedAt: null } })).toBe(0)
    await expectInvariants(db)
  })

  it('po wystawieniu w kolejnej próbie alert zamknięty', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    const id = await packed(a)
    wf.next = ['ERROR']
    expect(await issueInvoice(db, id, wf, { now: T0 })).toBe('BLAD')
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD', ref: id, closedAt: null } })).toBe(1)
    expect(await issueInvoice(db, id, wf, { now: at(M) })).toBe('WYSTAWIONA')
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD', ref: id, closedAt: null } })).toBe(0)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).flags).toMatchObject({ fakturaBlad: false })
  })

  it('alert zdjęty przez poprawkę, a ponowienie znów bez dokumentu: nowy alert mimo tego samego klucza', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    await issueInvoice(db, await packed(a), wf, { now: T0 })
    const [id] = await timeouts(1, a, wf)
    await runWfirmaQueue(db, { faktury: wf }, { now: at(M) })
    await runWfirmaQueue(db, { faktury: wf }, { now: at(3 * M) })
    wf.next = ['LIMIT']
    await runWfirmaQueue(db, { faktury: wf }, { now: at(6 * M) })
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD', ref: id!, closedAt: null } })).toBe(0)
    // ponowienie od razu po trzecim find kończy się błędem, żeby flaga została i było widać oba alerty
    wf.next = ['TIMEOUT_NO_CREATE', 'ERROR']
    for (const m of [12, 13, 15, 18]) await runWfirmaQueue(db, { faktury: wf }, { now: at(m * M) })
    expect((await db.order.findUniqueOrThrow({ where: { id: id! } })).flags).toMatchObject({ fakturaBlad: true })
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD', ref: id!, closedAt: null, dedupeKey: { startsWith: 'faktura-niejednoznaczna:' } } })).toBe(1)
  })

  it('błąd jednoznaczny zostaje: limit przy ręcznym ponowieniu nie zdejmuje flagi po ERROR', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    const id = await packed(a)
    wf.next = ['ERROR', 'LIMIT']
    expect(await issueInvoice(db, id, wf, { now: T0 })).toBe('BLAD')
    expect(await issueInvoice(db, id, wf, { now: at(M) })).toBe('LIMIT')
    expect((await db.order.findUniqueOrThrow({ where: { id } })).flags).toMatchObject({ fakturaBlad: true })
  })
})

describe('korekta i sprzątacz SENDING', () => {
  it('updatedAt z czasu rzeczywistego, nie z `now` przebiegu', async () => {
    const a = await product(db, 'A', 5)
    const wf = new FakeWfirma()
    const id = await packed(a)
    await issueInvoice(db, id, wf, { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    const r = await createReturn(db, id, [{ orderLineId: line.id, qty: 1 }], { now: T0 })
    await receiveReturn(db, r, 'NA_STAN')
    await requestCorrection(db, r)
    const old = new Date('2020-01-01T00:00:00Z')
    wf.correctionNext = ['TIMEOUT_NO_CREATE']
    const t0 = Date.now()
    await issueCorrection(db, r, wf, { now: old })
    expect((await db.return.findUniqueOrThrow({ where: { id: r } })).updatedAt.getTime()).toBeGreaterThanOrEqual(t0 - 5000)
    await resolveUnknownCorrections(db, wf, { now: old })
  })
})

describe('noc odporna na dryf i restart', () => {
  const noc = new Date('2026-10-16T01:30:00Z') // 3:30 w Warszawie (CEST)

  it('02:59 → 04:10: noc nie przepada; drugi przebieg tego samego dnia nic nie robi; następnego dnia znowu', async () => {
    const a = await product(db, 'A', 4)
    const woo = await offer(db, 'WOO_SD', 'wa', a)
    await db.channelOffer.update({ where: { id: woo }, data: { lastPushedQty: 4, lastPushedAt: T0 } })
    expect(await isNightSyncDue(db, new Date('2026-10-16T00:59:00Z'))).toBe(false)
    const cztery = new Date('2026-10-16T02:10:00Z')
    expect(await isNightSyncDue(db, cztery)).toBe(true)
    expect(await runNightlyFullSync(db, { now: cztery })).toHaveLength(5)
    expect(await isNightSyncDue(db, new Date('2026-10-16T03:10:00Z'))).toBe(false)
    expect(await runNightlyFullSync(db, { now: new Date('2026-10-16T03:10:00Z') })).toEqual([])
    expect(await isNightSyncDue(db, new Date('2026-10-16T21:00:00Z'))).toBe(false) // 23:00 tego samego dnia
    expect(await isNightSyncDue(db, new Date('2026-10-16T23:30:00Z'))).toBe(false) // 1:30 następnego: przed 3:00
    expect(await isNightSyncDue(db, noc.getTime() ? new Date('2026-10-17T01:30:00Z') : noc)).toBe(true)
  })

  it('błąd jednego konta: reszta dostaje joby, alert, noc odhaczona', async () => {
    const a = await product(db, 'A', 4)
    await offer(db, 'WOO_SD', 'wa', a)
    await offer(db, 'ALLEGRO', 'al', a)
    const orig = db.channelOffer.findMany.bind(db.channelOffer)
    const spy = vi.spyOn(db.channelOffer, 'findMany').mockImplementation(((args: { where?: { channelAccountId?: string } }) => {
      if (args?.where?.channelAccountId === 'allegro') throw new Error('atrapa: awaria konta')
      return orig(args as never)
    }) as never)
    try {
      const done = await runNightlyFullSync(db, { now: noc })
      expect(done.map((x) => x.channelAccountId)).not.toContain('allegro')
      expect(done).toHaveLength(4)
    } finally {
      spy.mockImplementation(orig as never) // mockRestore na delegacie Prismy zostawia `findMany` niezdefiniowane
    }
    expect(await db.alert.findFirstOrThrow({ where: { kind: 'NOC_SYNC_BLAD' } })).toMatchObject({ ref: 'ALLEGRO/allegro' })
    expect(await isNightSyncDue(db, new Date(noc.getTime() + H))).toBe(false)
  })

  it('awaria wspólna, żadne konto nie dostało jobów: noc nie odhaczona, ponowienie za godzinę, alert jeden na konto i dzień', async () => {
    await offer(db, 'WOO_SD', 'wa', await product(db, 'A', 4))
    const orig = db.channelOffer.findMany.bind(db.channelOffer)
    let awaria = true
    const spy = vi.spyOn(db.channelOffer, 'findMany').mockImplementation(((args: never) => {
      if (awaria) throw new Error('atrapa: awaria bazy')
      return orig(args)
    }) as never)
    let alerty = 0
    try {
      expect(await runNightlyFullSync(db, { now: noc })).toEqual([])
      alerty = await db.alert.count({ where: { kind: 'NOC_SYNC_BLAD' } })
      expect(alerty).toBeGreaterThan(0)
      expect(await isNightSyncDue(db, new Date(noc.getTime() + H))).toBe(true)
      await runNightlyFullSync(db, { now: new Date(noc.getTime() + H) })
      expect(await db.alert.count({ where: { kind: 'NOC_SYNC_BLAD' } })).toBe(alerty)
      awaria = false
      expect((await runNightlyFullSync(db, { now: new Date(noc.getTime() + 2 * H) })).length).toBeGreaterThan(0)
    } finally {
      spy.mockImplementation(orig as never)
    }
    expect(await isNightSyncDue(db, new Date(noc.getTime() + 3 * H))).toBe(false)
  })
})

describe('częściowe PZ najpierw na uszkodzone i brak', () => {
  it('PZ na 1 z 3 sztuk: uszkodzona z ruchem MANUAL, „na stan” na liście bez PZ, kolejność pozycji bez znaczenia', async () => {
    const a = await product(db, 'A', 10)
    const wf = new FakeWfirma()
    const { orderId } = await ingestOrder(db, order([{ productId: a, qty: 2 }, { productId: a, qty: 1 }]), { now: T0 })
    await packOrder(db, orderId!, { now: T0 })
    await issueInvoice(db, orderId!, wf, { now: T0 })
    const lines = await db.orderLine.findMany({ where: { orderId: orderId! }, orderBy: { qty: 'desc' } })
    const r = await createReturn(db, orderId!, lines.map((l) => ({ orderLineId: l.id, qty: l.qty })), { now: T0 })
    const rl = await db.returnLine.findMany({ where: { returnId: r } })
    await receiveReturn(db, r, Object.fromEntries(rl.map((l) => [l.id, l.qty === 1 ? 'USZKODZONE' : 'NA_STAN'])) as never)
    await requestCorrection(db, r)
    await completeCorrection(db, r, 'KOR/1', { [a]: 1 }, { now: at(M) })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { type: 'DAMAGED_RETURN' } })).toMatchObject({ delta: -1, state: 'MANUAL' })
    const bez = await listCorrectionsWithoutPz(db)
    expect(bez).toHaveLength(1)
    expect(bez[0]).toMatchObject({ disposition: 'NA_STAN', pzQty: 0, qty: 2 })
    await expectInvariants(db)
  })
})

describe('dzierżawa i minimalny budżet przebiegu', () => {
  it('przebieg dłuższy niż dzierżawa odnawia ją przed każdym wywołaniem, drugi nie wchodzi', async () => {
    const a = await product(db, 'A', 5)
    await packed(a)
    await packed(a)
    const wf = new FakeWfirma()
    let t = M // zegar przebiegu: każde wywołanie trwa 9 min
    let n = 0
    let second: Awaited<ReturnType<typeof runWfirmaQueueExclusive>> | undefined
    const orig = wf.issue.bind(wf)
    wf.issue = async (req) => {
      t += 9 * M
      if (++n === 2) second = await runWfirmaQueueExclusive(db, { faktury: wf }, { now: at(t) }) // 19 min: bez odnowienia dzierżawa z 1. min już wygasła
      return orig(req)
    }
    const first = await runWfirmaQueueExclusive(db, { faktury: wf }, { now: at(M), clock: () => at(t) })
    expect(n).toBe(2)
    expect(second).toMatchObject({ skipped: true, calls: 0 })
    expect(first.invoices).toBe(2)
    expect(await db.wfirmaQueueState.findFirstOrThrow()).toMatchObject({ runLockId: null, runLockUntil: null })
  })

  it('przebieg workera z budżetem 1 i tak mieści sondę z dokumentem, więc timeouty nie stoją bez końca', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    await issueInvoice(db, await packed(a), wf, { now: T0 })
    await timeouts(1, a, wf)
    const st = await runWfirmaQueueExclusive(db, { faktury: wf }, { now: at(M), maxCalls: 1 })
    expect(st.findCheck).toBe(true)
    expect(st.calls).toBe(2)
  })
})

describe('blokada przebiegu na firmę', () => {
  it('równoległy przebieg kończy się bez wywołań; po zakończeniu dzierżawa zwolniona; padnięty przebieg oddaje firmę po czasie', async () => {
    const a = await product(db, 'A', 5, { wfirmaGoodId: 'g-a' })
    await packed(a)
    const wf = new FakeWfirma()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const orig = wf.issue.bind(wf)
    wf.issue = async (req) => {
      await gate
      return orig(req)
    }
    const first = runWfirmaQueueExclusive(db, { faktury: wf }, { now: at(M) })
    await vi.waitFor(async () => expect((await db.wfirmaQueueState.findFirstOrThrow()).runLockId).not.toBeNull())
    await vi.waitFor(async () => expect(await db.invoiceAttempt.count({ where: { state: 'SENDING' } })).toBe(1))
    const second = await runWfirmaQueueExclusive(db, { faktury: wf }, { now: at(M + S) })
    expect(second).toMatchObject({ skipped: true, calls: 0 })
    release()
    expect((await first).invoices).toBe(1)
    expect(await db.wfirmaQueueState.findFirstOrThrow()).toMatchObject({ runLockId: null, runLockUntil: null })
    await db.wfirmaQueueState.updateMany({ data: { runLockId: 'martwy', runLockUntil: at(2 * M + RUN_LEASE_MS) } })
    expect((await runWfirmaQueueExclusive(db, { faktury: wf }, { now: at(2 * M) })).skipped).toBe(true)
    expect((await runWfirmaQueueExclusive(db, { faktury: wf }, { now: at(2 * M + RUN_LEASE_MS) })).skipped).toBeUndefined()
  })

  it('wyjątek w przebiegu zwalnia dzierżawę', async () => {
    const a = await product(db, 'A', 5, { wfirmaGoodId: 'g-a' })
    await db.outboxEvent.create({ data: { kind: 'WFIRMA_READ', productId: a, createdAt: T0 } })
    const wf = new FakeWfirma()
    wf.readGoods = async () => {
      throw new Error('atrapa: awaria sieci')
    }
    await expect(runWfirmaQueueExclusive(db, { odczyt: wf }, { now: at(M) })).rejects.toThrow('atrapa')
    expect((await db.wfirmaQueueState.findFirstOrThrow()).runLockId).toBeNull()
  })
})

describe('firma bez wystawionego dokumentu', () => {
  it('sonda negatywna nie zapisuje wyniku na dobę: pierwsza faktura dostaje od razu sondę pozytywną', async () => {
    const a = await product(db, 'A', 20)
    const wf = new FakeWfirma()
    const id = await packed(a)
    wf.next = ['TIMEOUT_AFTER_CREATE']
    expect(await issueInvoice(db, id, wf, { now: T0 })).toBe('TIMEOUT')
    wf.log = []
    const st = await runWfirmaQueue(db, { faktury: wf }, { now: at(M) })
    expect(st.findCheck).toBe(true)
    expect(wf.log).toEqual(['find', 'find']) // sonda + rozstrzygnięcie: pierwszy timeout w historii firmy działa
    expect((await db.wfirmaQueueState.findFirstOrThrow()).findCheckOkAt).toBeNull()
    expect(await db.invoiceAttempt.findFirst({ where: { orderId: id, state: 'ISSUED' } })).not.toBeNull()
    // kolejny timeout: dokument już jest, `find` „nie widzi” dokumentów → sonda pozytywna zatrzymuje rozstrzyganie
    const [id2] = await timeouts(1, a, wf)
    wf.findInvoicesEmpty = true
    const st2 = await runWfirmaQueue(db, { faktury: wf }, { now: at(2 * M) })
    expect(st2.findCheck).toBe(false)
    expect(await db.invoiceAttempt.count({ where: { orderId: id2!, state: 'UNKNOWN' } })).toBe(1)
  })
})

describe('odczyty celowane', () => {
  it('odczyt, który nie zapisuje się 5 razy, zamyka zdarzenie z alertem i przestaje zużywać wywołania', async () => {
    const a = await product(db, 'A', 5, { wfirmaGoodId: 'g-a' })
    await db.outboxEvent.create({ data: { kind: 'WFIRMA_READ', productId: a, createdAt: T0 } })
    const wf = new FakeWfirma()
    wf.counts.set(`${WH}:g-a`, 5)
    const spy = vi.spyOn(lustro, 'applyStockRead').mockRejectedValue(new Error('atrapa: błąd zapisu'))
    try {
      for (let i = 1; i <= READ_APPLY_MAX_TRIES; i++) await runWfirmaQueue(db, { odczyt: wf }, { now: at(i * M) })
      expect(await db.alert.count({ where: { kind: 'WFIRMA_ODCZYT_BLAD', ref: a } })).toBe(1)
      expect(await db.outboxEvent.findFirstOrThrow({ where: { kind: 'WFIRMA_READ' } })).toMatchObject({ attempts: READ_APPLY_MAX_TRIES, processedAt: at(READ_APPLY_MAX_TRIES * M) })
      wf.log = []
      await runWfirmaQueue(db, { odczyt: wf }, { now: at(20 * M) })
      expect(wf.log.filter((l) => l === 'readGoods')).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('i zamknięcie: druga seria następnego dnia daje nowy alert; udany odczyt nowego powiązania zamyka alerty', async () => {
    const a = await product(db, 'A', 5, { wfirmaGoodId: 'g-a' })
    const wf = new FakeWfirma()
    const seria = async (start: number) => {
      await db.outboxEvent.create({ data: { kind: 'WFIRMA_READ', productId: a, createdAt: at(start) } })
      for (let i = 0; i < MISSING_GOOD_MAX_TRIES; i++) await runWfirmaQueue(db, { odczyt: wf }, { now: at(start + (i + 1) * M) })
    }
    await seria(0)
    await seria(26 * H)
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_TOWARU', ref: a, closedAt: null } })).toBe(1) // otwarty = bez dubla
    await db.alert.updateMany({ where: { kind: 'WFIRMA_BRAK_TOWARU', ref: a }, data: { closedAt: at(27 * H) } })
    await seria(52 * H)
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_TOWARU', ref: a, closedAt: null } })).toBe(1) // poprzedni zamknięty = nowy
    await db.product.update({ where: { id: a }, data: { wfirmaGoodId: 'g-nowy' } })
    wf.counts.set(`${WH}:g-nowy`, 5)
    await db.outboxEvent.create({ data: { kind: 'WFIRMA_READ', productId: a, createdAt: at(53 * H) } })
    await runWfirmaQueue(db, { odczyt: wf }, { now: at(53 * H + M) })
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_TOWARU', ref: a, closedAt: null } })).toBe(0)
  })
})

it('stałe harmonogramu find bez zmian (test kontrolny opiera się na 3 próbach)', () => {
  expect(FIND_SCHEDULE_MS).toHaveLength(3)
  expect(new WfirmaLimitError('x', 5).retryAfterMs).toBe(5)
  void requestFullRead
  void api
})
