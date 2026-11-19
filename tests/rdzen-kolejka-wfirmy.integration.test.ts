// Rdzeń: jedna kolejka wywołań wFirmy z priorytetem (spec 3.4, 8.1 — przypadek 44c) oraz zmiany v1.5:
// walidacja i test kontrolny `find` (3.4), WZ z osobnego odczytu z ponowieniami (2.2 pkt 5), odczyt z jawnym
// warehouse_id i raport innych magazynów (8.1). Atrapa wFirmy w pamięci — zero połączeń z prawdziwą wFirmą.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { requestFullRead, runWfirmaQueue, type WfirmaApi } from '@/lib/rdzen/kolejka-wfirmy'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { FindValidationError, issueInvoice, LIMIT_ERROR_PREFIX, packOrder, resolveUnknownInvoices, resolveWzReads, validateFound } from '@/lib/rdzen/rozchod'
import { outbox } from '@/lib/rdzen/stan'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
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
const WH = '999001' // Warehouse.wfirmaWarehouseId z seedBase

/** Zegar wirtualny przebiegu: każde wywołanie +1 s od `start` (odpowiedź wFirmy później niż wysłanie odczytu). */
function clockFrom(start: Date) {
  let t = start.getTime()
  return () => new Date((t += S))
}

const api = (wf: FakeWfirma): WfirmaApi => ({ faktury: wf, korekty: wf, odczyt: wf })

async function packed(productId: string, qty: number, when = T0) {
  const { orderId } = await ingestOrder(db, order([{ productId, qty }], { createdAtChannel: when }), { now: when })
  await packOrder(db, orderId!, { now: when })
  return orderId!
}

describe('kolejka wywołań wFirmy (44c)', () => {
  it('44c: priorytet — faktura przed odczytem celowanym i pełnym; odczyt z warehouse_id z konfiguracji (kg → g); raport innych magazynów', async () => {
    const a = await product(db, 'A', 10, { wfirmaGoodId: 'g-a' })
    const b = await product(db, 'B', 5, { wfirmaGoodId: 'g-b' })
    const k = await product(db, 'K', 2000, { wfirmaGoodId: 'g-k', unit: 'KG' })
    const wf = new FakeWfirma()
    wf.counts.set(`${WH}:g-a`, 8) // po WZ faktury
    wf.counts.set(`${WH}:g-b`, 6) // przyszła dostawa
    wf.counts.set(`${WH}:g-k`, 1.25)
    wf.counts.set('777:g-a', 3) // inny magazyn wFirmy: nie wchodzi do sprzedaży, tylko raport
    await db.outboxEvent.create({ data: { kind: 'WFIRMA_READ', productId: b, createdAt: T0 } }) // kliknięcie biura wcześniej
    await requestFullRead(db, { now: T0 })
    const id = await packed(a, 2)
    const st = await runWfirmaQueue(db, api(wf), { now: at(M), clock: clockFrom(at(M)) })
    expect(wf.log).toEqual(['issue', 'readGoods', 'page', 'page', 'otherWh'])
    expect([...wf.warehousesSeen]).toEqual([WH])
    expect(st).toMatchObject({ paused: false, invoices: 1, targetedReads: 2, fullReadPages: 2, fullReadDone: true })
    expect(st.otherWarehouses).toEqual([{ warehouseId: '777', wfirmaGoodId: 'g-a', count: 3 }])
    expect(await db.alert.count({ where: { kind: 'STAN_INNY_MAGAZYN' } })).toBe(1)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('ISSUED')
    // odczyt celowany wysłany po odpowiedzi faktury potwierdza ruch: bez podwójnego odjęcia
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, pendingDelta: 0 })
    expect(await stockOf(db, b)).toMatchObject({ physical: 6 })
    expect(await stockOf(db, k)).toMatchObject({ physical: 1250 })
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', processedAt: null } })).toBe(0)
    expect(await db.wfirmaQueueState.findFirstOrThrow()).toMatchObject({ fullReadDueSince: null, lastFullReadAt: at(M) })
    // raport magazynów raz na dobę
    wf.log = []
    await runWfirmaQueue(db, api(wf), { now: at(2 * M) })
    expect(wf.log).toEqual([])
    await expectInvariants(db)
  })

  it('44c: błąd limitu wstrzymuje całą kolejkę na 5 min (zero wywołań w tym czasie, także odczytów), potem wznawia; próba z limitem nie jest błędem faktury', async () => {
    const a = await product(db, 'A', 10, { wfirmaGoodId: 'g-a' })
    const wf = new FakeWfirma()
    wf.counts.set(`${WH}:g-a`, 10)
    const id1 = await packed(a, 1)
    const id2 = await packed(a, 1, at(S))
    wf.next = ['OK', 'LIMIT']
    const st = await runWfirmaQueue(db, api(wf), { now: at(M), clock: clockFrom(at(M)) })
    expect(st).toMatchObject({ paused: true, pausedUntil: at(6 * M) })
    expect(wf.log).toEqual(['issue', 'issue']) // odczyt celowany po pierwszej fakturze już nie poszedł
    const a2 = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id2 } })
    expect(a2.state).toBe('FAILED')
    expect(a2.lastError?.startsWith(LIMIT_ERROR_PREFIX)).toBe(true)
    const o2 = await db.order.findUniqueOrThrow({ where: { id: id2 } })
    expect((o2.flags as { fakturaBlad?: boolean }).fakturaBlad).toBeUndefined()
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD' } })).toBe(0)
    expect(await db.alert.count({ where: { kind: 'WFIRMA_LIMIT' } })).toBe(1)
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: id2 } })).state).toBe('ACTIVE')
    // w trakcie wstrzymania: nic
    expect(await runWfirmaQueue(db, api(wf), { now: at(3 * M) })).toMatchObject({ paused: true, calls: 0 })
    expect(wf.log).toHaveLength(2)
    // po 5 min: druga faktura z kolejnym numerem próby, potem odczyt
    const st2 = await runWfirmaQueue(db, api(wf), { now: at(6 * M), clock: clockFrom(at(6 * M)) })
    expect(st2.paused).toBe(false)
    expect(wf.log.slice(2)).toEqual(['issue', 'readGoods', 'otherWh']) // raport magazynów: pierwszy przebieg doby
    expect(wf.invoices.map((i) => i.idExternal)).toEqual([`${id1}/1/1`, `${id2}/1/2`])
    // limit przy odczycie też wstrzymuje wszystko
    await db.outboxEvent.create({ data: { kind: 'WFIRMA_READ', productId: a, createdAt: at(7 * M) } })
    await packed(a, 1, at(7 * M))
    wf.readNext = ['LIMIT']
    const st3 = await runWfirmaQueue(db, api(wf), { now: at(8 * M), clock: clockFrom(at(8 * M)) })
    expect(st3).toMatchObject({ paused: true, pausedUntil: at(13 * M) })
    expect(wf.log.slice(5)).toEqual(['issue', 'readGoods'])
    await expectInvariants(db)
  })

  it('44c: pełny odczyt wstrzymywany przez ciągły strumień faktur najwyżej 30 min — potem jego strona idzie przed fakturą', async () => {
    const a = await product(db, 'A', 1000, { wfirmaGoodId: 'g-a' })
    const wf = new FakeWfirma()
    wf.counts.set(`${WH}:g-a`, 1000)
    await requestFullRead(db, { now: T0 })
    const passes: string[][] = []
    for (const min of [0, 10, 20, 30, 31]) {
      await packed(a, 1, at(min * M))
      const before = wf.log.length
      await runWfirmaQueue(db, { faktury: wf, odczyt: wf }, { now: at(min * M), clock: clockFrom(at(min * M)), maxCalls: 1 })
      passes.push(wf.log.slice(before))
    }
    expect(passes).toEqual([['issue'], ['issue'], ['issue'], ['page'], ['issue']])
    expect((await db.wfirmaQueueState.findFirstOrThrow()).fullReadDueSince).toBeNull()
  })

  it('8.1: magazyn bez wfirmaWarehouseId → odczyty wstrzymane z alertem, faktury idą dalej', async () => {
    const a = await product(db, 'A', 10, { wfirmaGoodId: 'g-a' })
    await db.warehouse.updateMany({ data: { wfirmaWarehouseId: null, stockSource: 'WFIRMA' } })
    const wf = new FakeWfirma()
    await packed(a, 1)
    await runWfirmaQueue(db, api(wf), { now: at(M), clock: clockFrom(at(M)) })
    expect(wf.log).toEqual(['issue'])
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_MAGAZYNU' } })).toBe(1)
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', processedAt: null } })).toBe(1)
  })

  it('magazyn jak z przeprowadzki (KOMPLETOR, bez magazynu wFirmy) — kolejka nie fakturuje, nie czyta, bez alertu', async () => {
    const a = await product(db, 'A', 10, { wfirmaGoodId: 'g-a' })
    await db.warehouse.updateMany({ data: { wfirmaWarehouseId: null, stockSource: 'KOMPLETOR' } })
    const wf = new FakeWfirma()
    await packed(a, 1)
    const st = await runWfirmaQueue(db, api(wf), { now: at(M), clock: clockFrom(at(M)) })
    expect(wf.log).toEqual([])
    expect(st).toMatchObject({ invoices: 0, corrections: 0, targetedReads: 0, fullReadPages: 0 })
    expect(await db.invoiceAttempt.count()).toBe(0)
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_MAGAZYNU' } })).toBe(0)
  })

  it('bez adaptera zapisu (przed GO) kolejka tylko czyta: spakowane czekają, zero wystawionych dokumentów', async () => {
    const a = await product(db, 'A', 10, { wfirmaGoodId: 'g-a' })
    const wf = new FakeWfirma()
    wf.counts.set(`${WH}:g-a`, 10)
    await db.outboxEvent.create({ data: { kind: 'WFIRMA_READ', productId: a, createdAt: T0 } })
    await packed(a, 1)
    await runWfirmaQueue(db, { odczyt: wf }, { now: at(M) })
    expect(wf.log).toEqual(['readGoods', 'otherWh'])
    expect(wf.invoices).toHaveLength(0)
  })
})

describe('find i WZ (spec v1.5)', () => {
  it('find zawsze puste → sonda pozytywna nie przechodzi, timeout zostaje UNKNOWN, zero drugiej faktury; po naprawie znaleziona', async () => {
    const a = await product(db, 'A', 10, { wfirmaGoodId: 'g-a' })
    const wf = new FakeWfirma()
    await issueInvoice(db, await packed(a, 1), wf, { now: at(S) }) // wystawiona faktura = sonda pozytywna
    const id = await packed(a, 2)
    wf.next = ['TIMEOUT_AFTER_CREATE'] // dokument w wFirmie powstał, odpowiedź nie doszła
    expect(await issueInvoice(db, id, wf, { now: at(2 * S) })).toBe('TIMEOUT')
    wf.findInvoicesEmpty = true
    for (const t of [M, 3 * M, 9 * M, 20 * M, 62 * M, 130 * M]) {
      const st = await runWfirmaQueue(db, { faktury: wf }, { now: at(t) })
      expect(st.paused).toBe(false)
    }
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('UNKNOWN')
    expect(await db.invoiceAttempt.count({ where: { orderId: id } })).toBe(1)
    expect(wf.invoices.filter((i) => i.idExternal.startsWith(`${id}/`))).toHaveLength(1)
    expect(await db.alert.count({ where: { kind: 'WFIRMA_FIND_FILTR' } })).toBeGreaterThanOrEqual(1)
    expect((await db.wfirmaQueueState.findFirstOrThrow()).findCheckOkAt).toBeNull()
    expect((await db.pendingMovement.findFirstOrThrow({ where: { orderId: id } })).state).toBe('IN_FLIGHT')
    // find naprawiony: sonda po godzinie od nieudanej przechodzi, dokument znaleziony — nadal jedna faktura
    wf.findInvoicesEmpty = false
    await runWfirmaQueue(db, { faktury: wf }, { now: at(200 * M) })
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('ISSUED')
    expect(wf.invoices.filter((i) => i.idExternal.startsWith(`${id}/`))).toHaveLength(1)
    await expectInvariants(db)
  })

  it('towar nieobecny w odpowiedzi goods/get → po 5 przebiegach zdarzenia zamknięte, 1 alert; potem readGoods go nie woła', async () => {
    const a = await product(db, 'A', 10, { wfirmaGoodId: 'g-a' })
    const b = await product(db, 'B', 10, { wfirmaGoodId: 'g-zniknal' })
    const wf = new FakeWfirma()
    wf.counts.set(`${WH}:g-a`, 10)
    const asked: string[][] = []
    const odczyt = {
      readGoods: async (ids: string[], w: string) => {
        asked.push(ids)
        return wf.readGoods(ids, w)
      },
      readGoodsPage: wf.readGoodsPage.bind(wf),
    }
    for (let i = 1; i <= 6; i++) {
      await outbox(db as never, 'WFIRMA_READ', a, at(i * M))
      await outbox(db as never, 'WFIRMA_READ', b, at(i * M))
      await runWfirmaQueue(db, { odczyt }, { now: at(i * M + S) })
      if (i < 5) expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_TOWARU' } })).toBe(0)
    }
    expect(asked.slice(0, 5).every((ids) => ids.includes('g-zniknal'))).toBe(true)
    expect(asked[5]).toEqual(['g-a']) // 6. przebieg: zamknięty towar nie zajmuje paczki ani wywołania
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: b, processedAt: null } })).toBe(0)
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: a, processedAt: null } })).toBe(0)
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_TOWARU', ref: b } })).toBe(1)
    // doba ciszy liczy się od zamknięcia po próbach (5. przebieg), zamknięcia w ciszy jej nie odnawiają
    const gaveUp = at(5 * M + S).getTime()
    await outbox(db as never, 'WFIRMA_READ', b, new Date(gaveUp + 23 * 3600_000))
    await runWfirmaQueue(db, { odczyt }, { now: new Date(gaveUp + 23 * 3600_000 + S) })
    expect(asked.flat().filter((g) => g === 'g-zniknal')).toHaveLength(5) // 23. godzina: dalej pominięty
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: b, processedAt: null } })).toBe(0)
    await outbox(db as never, 'WFIRMA_READ', b, new Date(gaveUp + 24 * 3600_000 + M))
    await runWfirmaQueue(db, { odczyt }, { now: new Date(gaveUp + 24 * 3600_000 + M + S) })
    expect(asked[asked.length - 1]).toEqual(['g-zniknal']) // po dobie nowa seria prób
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: b, processedAt: null } })).toBe(1)
  })

  it('poprawione powiązanie towaru kończy ciszę po alercie od razu', async () => {
    const b = await product(db, 'B', 10, { wfirmaGoodId: 'g-zniknal' })
    const wf = new FakeWfirma()
    wf.counts.set(`${WH}:g-nowy`, 7)
    const asked: string[][] = []
    const odczyt = {
      readGoods: async (ids: string[], w: string) => {
        asked.push(ids)
        return wf.readGoods(ids, w)
      },
      readGoodsPage: wf.readGoodsPage.bind(wf),
    }
    for (let i = 1; i <= 5; i++) {
      await outbox(db as never, 'WFIRMA_READ', b, at(i * M))
      await runWfirmaQueue(db, { odczyt }, { now: at(i * M + S) })
    }
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_TOWARU', ref: b } })).toBe(1)
    await db.product.update({ where: { id: b }, data: { wfirmaGoodId: 'g-nowy' } }) // biuro poprawia powiązanie
    await outbox(db as never, 'WFIRMA_READ', b, at(6 * M))
    await runWfirmaQueue(db, { odczyt }, { now: at(6 * M + S) })
    expect(asked[asked.length - 1]).toEqual(['g-nowy'])
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: b, processedAt: null } })).toBe(0)
    expect(await stockOf(db, b)).toMatchObject({ physical: 7 })
  })

  it('3.4: walidacja odpowiedzi find (> 20 albo spoza prefiksu = błąd); atrapa ignorująca filtr → test kontrolny nie przechodzi, timeout zostaje IN_FLIGHT', async () => {
    expect(() => validateFound('o1/1/', Array.from({ length: 21 }, (_, i) => ({ idExternal: `o1/1/${i}` })))).toThrow(FindValidationError)
    expect(() => validateFound('o1/1/', [{ idExternal: 'o2/1/1' }])).toThrow(/spoza prefiksu/)
    expect(validateFound('o1/1/', [{ idExternal: 'o1/1/1' }])).toHaveLength(1)
    const a = await product(db, 'A', 10, { wfirmaGoodId: 'g-a' })
    const wf = new FakeWfirma()
    await issueInvoice(db, await packed(a, 1), wf, { now: at(S) }) // inna faktura w wFirmie
    const id = await packed(a, 2)
    wf.next = ['TIMEOUT_NO_CREATE']
    expect(await issueInvoice(db, id, wf, { now: at(2 * S) })).toBe('TIMEOUT')
    wf.ignoreFindFilter = true
    const st = await runWfirmaQueue(db, { faktury: wf }, { now: at(M) })
    expect(st.findCheck).toBe(false)
    expect(await db.alert.count({ where: { kind: 'WFIRMA_FIND_FILTR' } })).toBe(1)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('UNKNOWN')
    expect((await db.pendingMovement.findFirstOrThrow({ where: { orderId: id } })).state).toBe('IN_FLIGHT')
    // bezpośrednie rozstrzyganie z atrapą bez filtra: walidacja zatrzymuje „znaleziono cudzą fakturę”
    const r = await resolveUnknownInvoices(db, wf, { now: at(M) })
    expect(r).toMatchObject({ found: 0, errors: 1 })
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('UNKNOWN')
    // filtr naprawiony: po godzinie test przechodzi, timeout się rozstrzyga (faktury nie ma → kolejna próba)
    wf.ignoreFindFilter = false
    await runWfirmaQueue(db, { faktury: wf }, { now: at(62 * M) })
    expect((await db.wfirmaQueueState.findFirstOrThrow()).findCheckOkAt).toEqual(at(62 * M))
    await expectInvariants(db)
  })

  it('2.2 pkt 5: WZ z osobnego odczytu — błąd odczytu (null) → ponowienia po 30 s / 2 min / 5 min, potem jak 0; faktura simple → 0', async () => {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 10)
    const c = await product(db, 'C', 10)
    const wf = new FakeWfirma()
    // A: odczyt WZ pada 2 razy (przy fakturze i w 1. ponowieniu), w 2. ponowieniu się udaje
    const ida = await packed(a, 2)
    wf.wzReadFailures = 2
    await issueInvoice(db, ida, wf, { now: at(S) })
    const ma = () => db.pendingMovement.findFirstOrThrow({ where: { orderId: ida } })
    expect(await ma()).toMatchObject({ state: 'APPLIED', wzQty: null, nextWzReadAt: at(S + 30 * S) })
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BEZ_WZ' } })).toBe(0)
    // odczyt stanu w tym czasie nie potwierdza ruchu bez WZ (bezpiecznie niżej)
    await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(10 * S) }, { now: at(10 * S) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 6, pendingDelta: -2 })
    expect(await resolveWzReads(db, wf, { now: at(31 * S) })).toMatchObject({ waiting: 1 })
    expect(await ma()).toMatchObject({ wzTries: 1, nextWzReadAt: at(31 * S + 2 * M) })
    expect(await resolveWzReads(db, wf, { now: at(31 * S + 2 * M) })).toMatchObject({ settled: 1, asZero: 0 })
    expect(await ma()).toMatchObject({ state: 'APPLIED', wzQty: 2 })
    await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(4 * M) }, { now: at(4 * M) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, pendingDelta: 0 })
    // B: odczyt WZ pada za każdym razem → po 3. ponowieniu jak 0: MANUAL + alert
    const idb = await packed(b, 3)
    wf.wzReadFailures = 4
    await issueInvoice(db, idb, wf, { now: at(10 * M) })
    const t1 = at(10 * M + 30 * S)
    await resolveWzReads(db, wf, { now: t1 })
    await resolveWzReads(db, wf, { now: new Date(t1.getTime() + 2 * M) })
    const last = await resolveWzReads(db, wf, { now: new Date(t1.getTime() + 7 * M) })
    expect(last).toMatchObject({ settled: 1, asZero: 1 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId: idb } })).toMatchObject({ state: 'MANUAL', wzQty: 0, wzTries: 3 })
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BEZ_WZ' } })).toBe(1)
    // C: faktura simple (bez WZ) → od razu jak 0
    const idc = await packed(c, 1)
    wf.invoiceType = 'simple'
    await issueInvoice(db, idc, wf, { now: at(30 * M) })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId: idc } })).toMatchObject({ state: 'MANUAL', wzQty: 0 })
    await expectInvariants(db)
  })

  it('2.2 pkt 5: adapter bez readWz (nie ponowi odczytu) → nieudany odczyt WZ przy fakturze od razu jak 0 w pierwszym przebiegu, bez wiszącego APPLIED', async () => {
    const a = await product(db, 'A', 10)
    const wf = new FakeWfirma()
    const bezReadWz = { issue: wf.issue.bind(wf), findByPrefix: wf.findByPrefix.bind(wf) }
    const id = await packed(a, 2)
    wf.wzReadFailures = 1
    await issueInvoice(db, id, bezReadWz, { now: at(S) })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'APPLIED', wzQty: null })
    expect(await resolveWzReads(db, bezReadWz, { now: at(31 * S) })).toMatchObject({ settled: 1, asZero: 1, errors: 0 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'MANUAL', wzQty: 0, wzTries: 1 })
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BEZ_WZ' } })).toBe(1)
    await expectInvariants(db)
  })
})
