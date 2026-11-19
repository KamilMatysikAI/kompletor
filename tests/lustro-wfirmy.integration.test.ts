// lustro stanów wFirmy w cieniu (adapter odczytu + handler kolejki + odczyt po fakturze BL) i raport rozjazdów
// (stan BL bez sumowania, nowe kryterium `ok`, lista „Dla biura”). wFirma: atrapa API2 na poziomie `call` (zero
// połączeń z prawdziwą wFirmą, BL i sklepami), towary i zamówienia zmyślone (T-001…, bez danych klientów).
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WfirmaStockReader } from '@/lib/cien/odczyt-stanow-wfirmy'
import { alertOfficeItems, buildDailyReport, type DailyReport, OFFICE_ALERT, renderDailyReport, REPORT_CHECK, reportWaitsForMirror } from '@/lib/cien/raport-dzienny'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { SALES_CHECK } from '@/lib/cien/sprzedaz-dnia'
import { applyBlInvoice, applyBlShippedWithoutInvoice } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { LUSTRO_WFIRMY_JOB } from '@/lib/worker/harmonogram'
import { handlers, requestMirrorAfterImport, runLustroWfirmy } from '@/lib/worker/zadania'
import { SourceError } from '@/lib/zrodla/http'
import { assertWfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { ORG_A, testDb, truncateAll } from './db'
import { bundle, expectInvariants, offer, order, product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const WH = '999001' // Warehouse.wfirmaWarehouseId z seedBase
const T = new Date('2026-10-27T08:00:00.000Z')
const min = (n: number) => new Date(T.getTime() + n * 60_000)

type Cond = { condition: { field: string; operator: string; value: string } }

/** Atrapa wFirmy API2 na poziomie `call`: tylko odczyt (strażnik jak w kliencie), goods/find z warunkami i stronami. */
class FakeApi2 {
  goods = new Map<string, { count: number; wh: string }>()
  paths: string[] = []
  /** tyle kolejnych żądań kończy się limitem wFirmy (HTTP 429) */
  limitNext = 0
  async call<T>(path: string, body: unknown): Promise<T> {
    assertWfirmaReadOnly(path)
    this.paths.push(path)
    if (this.limitNext > 0) {
      this.limitNext--
      throw new SourceError(`wFirma ${path}: HTTP 429 (limit) — bez ponawiania`, false)
    }
    if (path !== 'goods/find') throw new Error(`atrapa: nieobsługiwana ścieżka ${path}`)
    const p = (body as { api: { goods: { parameters: { page: number; limit: number; conditions?: Cond | { and: Cond[] } } } } }).api.goods.parameters
    const conds = !p.conditions ? [] : 'and' in p.conditions ? p.conditions.and : [p.conditions]
    let list = [...this.goods.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))
    for (const { condition: c } of conds) {
      if (c.field === 'warehouse_id') list = list.filter(([, g]) => g.wh === c.value)
      else if (c.field === 'id' && c.operator === 'in') list = list.filter(([id]) => c.value.split(',').includes(id))
      else throw new Error(`atrapa: nieznany warunek ${c.field}`)
    }
    const page = list.slice((p.page - 1) * p.limit, p.page * p.limit)
    return { goods: { ...Object.fromEntries(page.map(([id, g], i) => [String(i), { good: { id, code: `T-${id}`, name: `Towar testowy ${id}`, unit: 'szt.', count: g.count, warehouse: { id: g.wh } } }])), parameters: { total: list.length } } } as T
  }
}

async function setMirror(lastFullReadAt: Date | null) {
  await db.wfirmaQueueState.upsert({ where: { organizationId: ORG_A }, create: { organizationId: ORG_A, lastFullReadAt }, update: { lastFullReadAt } })
}

async function reservedOrder(productId: string, qty: number, when: Date): Promise<string> {
  const { orderId } = await ingestOrder(db, order([{ productId, qty }], { createdAtChannel: when }), { now: when })
  return orderId!
}

describe('lustro wFirmy: handler i kolejka z samym odczytem', () => {
  it('pierwszy przebieg sam zleca pełny odczyt; strony w budżecie 20 wywołań, reszta w następnym przebiegu; pozycja z innego magazynu pominięta', async () => {
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101' })
    const b = await product(db, 'T-002', 4, { wfirmaGoodId: '102' })
    const api = new FakeApi2()
    api.goods.set('101', { count: 7, wh: WH })
    api.goods.set('102', { count: 9, wh: '777' }) // inny magazyn: nigdy nie wchodzi do stanu
    for (let i = 0; i < 2500; i++) api.goods.set(String(10_000 + i), { count: 1, wh: WH }) // 25 stron (towary spoza katalogu)
    const reader = new WfirmaStockReader(api)
    const r1 = await runLustroWfirmy(db, reader, { now: min(0) })
    expect(r1).toMatchObject({ fullReadRequested: true, paused: false, calls: 20, fullReadPages: 20, fullReadDone: false, invoices: 0, corrections: 0 })
    expect(api.paths).toHaveLength(20)
    expect(new Set(api.paths)).toEqual(new Set(['goods/find']))
    expect(await stockOf(db, a)).toMatchObject({ wfirmaCount: 7, physical: 7 })
    expect(await stockOf(db, b)).toMatchObject({ wfirmaCount: 4, physical: 4 }) // 102 tylko w magazynie 777
    expect(await db.wfirmaQueueState.findFirstOrThrow()).toMatchObject({ fullReadPage: 20, lastFullReadAt: null, runLockId: null })
    const r2 = await runLustroWfirmy(db, reader, { now: min(2) })
    expect(r2.fullReadRequested).toBeUndefined() // zlecony już czeka, nie od nowa
    expect(r2).toMatchObject({ fullReadPages: 6, fullReadDone: true })
    expect(await db.wfirmaQueueState.findFirstOrThrow()).toMatchObject({ fullReadDueSince: null, lastFullReadAt: min(2) })
    // trzeci przebieg: pełny odczyt był, nic nie zleca i nic nie czyta (brak zdarzeń WFIRMA_READ)
    api.paths = []
    const r3 = await runLustroWfirmy(db, reader, { now: min(4) })
    expect(r3).toMatchObject({ calls: 0 })
    expect(r3.fullReadRequested).toBeUndefined()
    expect(api.paths).toEqual([])
    expect(await db.invoiceAttempt.count()).toBe(0) // zero zapisu w wFirmie
    await expectInvariants(db)
  })

  it('limit wFirmy (429) → kolejka wstrzymana (pausedUntil), zero kolejnych wywołań w tym przebiegu i do końca blokady, alert', async () => {
    await product(db, 'T-001', 10, { wfirmaGoodId: '101' })
    const api = new FakeApi2()
    api.goods.set('101', { count: 7, wh: WH })
    api.limitNext = 1
    const reader = new WfirmaStockReader(api)
    const r1 = await runLustroWfirmy(db, reader, { now: min(0) })
    expect(r1).toMatchObject({ paused: true, pausedUntil: min(5), calls: 1 })
    expect(api.paths).toHaveLength(1)
    expect((await db.wfirmaQueueState.findFirstOrThrow()).pausedUntil).toEqual(min(5))
    expect(await db.alert.count({ where: { kind: 'WFIRMA_LIMIT' } })).toBe(1)
    const r2 = await runLustroWfirmy(db, reader, { now: min(3) })
    expect(r2).toMatchObject({ paused: true, calls: 0 })
    expect(api.paths).toHaveLength(1)
    const r3 = await runLustroWfirmy(db, reader, { now: min(6) })
    expect(r3).toMatchObject({ paused: false, fullReadDone: true })
  })

  it('handler bez kluczy wFirmy: cichy koniec (bez błędu, bez stanu kolejki); wyłącznik 0 = nic', async () => {
    const env = { CIEN_LUSTRO_WFIRMY: '1' }
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(db, null, { organizationId: ORG_A, secrets: { env, envFallback: false } })).resolves.toBeUndefined()
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(db, null, { organizationId: ORG_A, secrets: { env, envFallback: false } })).resolves.toBeUndefined()
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(db, null, { organizationId: ORG_A, secrets: { env: { CIEN_LUSTRO_WFIRMY: '0' }, envFallback: false } })).resolves.toBeUndefined()
    expect(await db.wfirmaQueueState.count()).toBe(0)
  })
})

describe('odczyt celowany po fakturze BL (1c) i scenariusz końcowy', () => {
  it('faktura BL z pełnym WZ → APPLIED + zdarzenie WFIRMA_READ → przebieg kolejki → CONFIRMED, fizyczny = stan z wFirmy; ponowne przetworzenie bez zdarzenia', async () => {
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101' })
    await setMirror(min(-5)) // lustro po pełnym odczycie sprzed 5 min (kolejny pełny dopiero po PELNY_ODCZYT_CO_MS): przebieg nie zleca nowego
    const orderId = await reservedOrder(a, 2, min(0))
    await applyBlInvoice(db, orderId, 'FV/T/1', { [a]: 2 }, { now: min(1) })
    const mv = await db.pendingMovement.findFirstOrThrow({ where: { orderId } })
    expect(mv).toMatchObject({ type: 'BL_INVOICE', state: 'APPLIED', wzQty: 2 })
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: a, processedAt: null } })).toBe(1)
    await applyBlInvoice(db, orderId, 'FV/T/1', { [a]: 2 }, { now: min(2) }) // ta sama faktura ponownie
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ' } })).toBe(1)
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, pendingDelta: -2 })

    const api = new FakeApi2()
    api.goods.set('101', { count: 8, wh: WH }) // wFirma po WZ
    const r = await runLustroWfirmy(db, new WfirmaStockReader(api), { now: min(3) })
    expect(r).toMatchObject({ targetedReads: 1, fullReadPages: 0, calls: 1 })
    expect(r.fullReadRequested).toBeUndefined()
    expect(await db.pendingMovement.findFirstOrThrow({ where: { id: mv.id } })).toMatchObject({ state: 'CONFIRMED' })
    expect(await stockOf(db, a)).toMatchObject({ wfirmaCount: 8, physical: 8, pendingDelta: 0 })
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', processedAt: null } })).toBe(0)
    await expectInvariants(db)
  })

  it('wysłane bez faktury, potem faktura BL: ruch zamieniony w BL_INVOICE też dostaje odczyt celowany', async () => {
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101' })
    const orderId = await reservedOrder(a, 1, min(0))
    await applyBlShippedWithoutInvoice(db, orderId, { now: min(1) })
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ' } })).toBe(0)
    await applyBlInvoice(db, orderId, 'FV/T/2', { [a]: 1 }, { now: min(2) })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ type: 'BL_INVOICE', state: 'APPLIED' })
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: a } })).toBe(1)
  })

  it('ruch sprzed zmiany (bez zdarzenia WFIRMA_READ) potwierdza pierwszy pełny odczyt zlecony przez handler', async () => {
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101' })
    const orderId = await reservedOrder(a, 3, min(0))
    await applyBlInvoice(db, orderId, 'FV/T/3', { [a]: 3 }, { now: min(1) })
    await db.outboxEvent.deleteMany({ where: { kind: 'WFIRMA_READ' } }) // stan jak na stagingu: ruch bez zdarzenia
    const api = new FakeApi2()
    api.goods.set('101', { count: 7, wh: WH })
    const r = await runLustroWfirmy(db, new WfirmaStockReader(api), { now: min(30 * 60) })
    expect(r).toMatchObject({ fullReadRequested: true, fullReadDone: true, targetedReads: 0 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONFIRMED' })
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, pendingDelta: 0 })
    await expectInvariants(db)
  })
})

describe('raport rozjazdów', () => {
  const DAY = '2026-10-27'
  const NOW = new Date('2026-10-28T01:00:00Z')
  const BL_AT = new Date('2026-10-28T00:30:00Z')
  const READ_AT = new Date('2026-10-28T00:40:00Z')
  const RUN = 'run-katalog-2'

  async function salesOk(ok = true) {
    await db.shadowDailyCheck.create({ data: { kind: SALES_CHECK, day: DAY, final: true, ok, checkedAt: NOW, stats: { day: DAY, final: true, blComplete: true, blErrors: [], accounts: [], notCompared: [], ok } } })
  }
  async function catalogRun() {
    await db.importRun.create({ data: { id: RUN, kind: 'katalog-bl-wfirma', status: 'OK', startedAt: new Date('2026-10-28T00:20:00Z'), finishedAt: BL_AT } })
  }
  async function bl(id: string, productId: string, stock: number, opts: { link?: string | null; run?: string; sku?: string } = {}) {
    await db.blProduct.create({ data: { id, inventoryId: '1', name: `Towar testowy ${id}`, sku: opts.sku ?? id, stockAccounting: String(stock), productId, wfirmaGoodIdLink: opts.link ?? null, importRunId: opts.run ?? RUN, importedAt: BL_AT } })
  }
  async function base() {
    await salesOk()
    await catalogRun()
    await setMirror(new Date('2026-10-28T00:45:00Z'))
  }

  it('duplikat BL tego samego towaru wFirmy: stan 5, nie 10; rekord skasowany w BL pominięty; różne wartości = konflikt (maksimum)', async () => {
    await base()
    const a = await product(db, 'T-001', 5, { wfirmaGoodId: '101', readAt: READ_AT })
    const c = await product(db, 'T-003', 4, { wfirmaGoodId: '103', readAt: READ_AT })
    await bl('bl-1', a, 5, { link: '101' })
    await bl('bl-2', a, 5, { link: '101' })
    await bl('bl-old', a, 9, { link: '101', run: 'run-katalog-1' }) // nieobecny w ostatnim imporcie (skasowany w BL)
    await bl('bl-3', c, 3, { link: '103' })
    await bl('bl-4', c, 4, { link: '103' })
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ products: 2, physicalVsBl: 0, physicalVsBlForOk: 0, blStaleRecords: 1, blConflicting: 1, blSnapshotAt: BL_AT.toISOString() })
    expect(r.stocks.blConflictingList).toEqual([{ sku: 'T-003', blSkus: ['bl-3', 'bl-4'], values: [3, 4] }])
    expect(r.ok).toBe(true)
    expect(renderDailyReport(r)).toContain('Rekordy BL jednego towaru wFirmy z różnym stanem')
  })

  it('kilka różnych towarów wFirmy pod produktem: towar produktu wygrywa; bez niego suma; oba w blMultiGood', async () => {
    await base()
    const a = await product(db, 'T-001', 5, { wfirmaGoodId: '101', readAt: READ_AT })
    const b = await product(db, 'T-002', 6, { wfirmaGoodId: '102', readAt: READ_AT })
    await bl('bl-a1', a, 5, { link: '101' })
    await bl('bl-a2', a, 9, { link: '999' }) // rekord BL wskazuje inny towar wFirmy
    await bl('bl-b1', b, 2) // bez powiązania z wFirmą
    await bl('bl-b2', b, 4)
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ physicalVsBl: 0, blMultiGood: 2 })
    expect(r.stocks.blMultiGoodList?.sort()).toEqual(['T-001', 'T-002'])
  })

  it('„uratowane” bez zestawów: zestaw z BL 0 policzony osobno, towar STOCKED z BL 0 zostaje', async () => {
    await base()
    const a = await product(db, 'T-001', 3, { wfirmaGoodId: '101', readAt: READ_AT })
    const z = await bundle(db, 'T-001-Z2', [{ id: a, qty: 2 }])
    await bl('bl-a', a, 0, { link: '101' })
    await bl('bl-z', z, 0)
    for (const [id, productId] of [['21', a], ['22', z]] as const) {
      const off = await offer(db, 'WOO_SD', id, productId)
      await db.channelPushLog.create({ data: { offerId: off, channel: 'WOO', channelAccountId: 'sd', mode: 'CIEN', targetQty: 1, delayMs: 100, createdAt: new Date('2026-10-27T12:00:00Z') } })
    }
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.saved).toMatchObject({ offers: 1, list: [{ sku: 'T-001', account: 'WOO/sd', target: 1 }], savedSkippedBundles: 1 })
  })

  it('`ok` zielony przy samych pozycjach biura (MANUAL > 24 h); jeden alert dla biura na dzień', async () => {
    await base()
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 10, { link: '101' }) // wFirma (i BL) nie widzą wydania bez faktury
    const orderId = await reservedOrder(a, 2, new Date('2026-10-26T08:00:00Z'))
    await applyBlShippedWithoutInvoice(db, orderId, { now: new Date('2026-10-26T09:00:00Z') })
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stalePending.count).toBe(0)
    expect(r.officeItems).toMatchObject({ count: 1, shippedWithoutInvoice: 1, invoiceWithoutWz: 0, toClarify: 0, newSinceYesterday: 0, skus: ['T-001'] })
    expect(r.officeItems!.orders).toHaveLength(1)
    expect(r.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 0, office: 1 }) // 8 u nas, 10 w BL: wyjaśnia ruch biura
    expect(r.ok).toBe(true)
    const md = renderDailyReport(r)
    expect(md).toContain('## Dla biura (nie zeruje serii)')
    expect(md).toContain('T-001: u nas 8 (dostępne 8), BL 10 — ruch biura')
    expect(await alertOfficeItems(db, r)).toBe(true)
    await alertOfficeItems(db, r)
    const al = await db.alert.findMany({ where: { kind: OFFICE_ALERT } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('wysłane bez faktury 1')
    expect(al[0]!.message).toContain('SKU: T-001')
    expect(al[0]!.message).not.toMatch(/@|example/)
  })

  it('`ok` czerwony przy APPLIED > 24 h (zaległość systemu)', async () => {
    await base()
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 8, { link: '101' })
    const orderId = await reservedOrder(a, 2, new Date('2026-10-26T08:00:00Z'))
    await applyBlInvoice(db, orderId, 'FV/T/9', { [a]: 2 }, { now: new Date('2026-10-26T09:00:00Z') })
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stalePending).toEqual({ count: 1, byKind: { 'BL_INVOICE/APPLIED': 1 } })
    expect(r.stocks.physicalVsBlForOk).toBe(0)
    expect(r.officeItems?.count).toBe(0)
    expect(r.ok).toBe(false)
  })

  it('`ok` czerwony przy rozjeździe stanu bez ruchu; zielony przy rozjeździe „w drodze”; bez lustra „w drodze” nie chroni', async () => {
    await base()
    const a = await product(db, 'T-001', 5, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 7, { link: '101' })
    const red = await buildDailyReport(db, DAY, NOW)
    expect(red.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 1, inTransit: 0 })
    expect(red.ok).toBe(false)

    // ruch WFIRMA_SYNC między odczytem BL (00:30) a odczytem wFirmy (00:40): dwa odczyty z różnych chwil
    await db.stockMovement.create({ data: { productId: a, warehouseId: 'glowny', deltaPhysical: -2, source: 'WFIRMA_SYNC', reason: 'test', actorId: 'test', createdAt: new Date('2026-10-28T00:35:00Z') } })
    const green = await buildDailyReport(db, DAY, NOW)
    expect(green.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 0, inTransit: 1 })
    expect(green.stocks.physicalVsBlList[0]).toMatchObject({ sku: 'T-001', inTransit: true })
    expect(green.ok).toBe(true)
    expect(renderDailyReport(green)).toContain('— w drodze')

    // lustro bez pełnego odczytu: produkt nieodczytany, rozjazd liczy się mimo ruchu
    await setMirror(null)
    const noMirror = await buildDailyReport(db, DAY, NOW)
    expect(noMirror.stocks).toMatchObject({ physicalVsBlForOk: 1, inTransit: 0 })
    expect(noMirror.stocks.physicalVsBlList[0]).toMatchObject({ noMirrorRead: true })
    expect(noMirror.ok).toBe(false)
  })

  it('WZ z wFirmy założony między odczytami wyjaśnia rozjazd jako dokument (nie „bez przyczyny”); WZ z naszym ruchem nie liczy się drugi raz', async () => {
    await base()
    const a = await product(db, '90002', 5, { wfirmaGoodId: '90000077', readAt: READ_AT })
    await bl('bl-a', a, 6, { link: '90000077' })
    const red = await buildDailyReport(db, DAY, NOW)
    expect(red.stocks).toMatchObject({ physicalVsBlForOk: 1 })
    // WZ 142/4/11/26 (kształt z nagrania): 1 szt. 90002, założony o 00:35 UTC, między kopią BL (00:30) a odczytem wFirmy (00:40)
    await db.wfirmaWzSnapshot.create({ data: { wfirmaDocId: '900000070', number: 'WZ 142/4/11/26', docDate: '2026-10-28', createdInWfirma: new Date('2026-10-28T00:35:00Z'), invoiceId: '900000217', invoiceNumber: 'SD 142/4/11/26', lines: [{ wfirmaGoodId: '90000077', count: 1 }], outcome: 'BEZ_ZAMOWIENIA', fetchedAt: NOW } })
    const green = await buildDailyReport(db, DAY, NOW)
    expect(green.stocks).toMatchObject({ physicalVsBlForOk: 0, inTransit: 1 })
    expect(green.stocks.physicalVsBlList[0]).toMatchObject({ sku: '90002', inTransit: true, wzDocs: ['WZ 142/4/11/26'] })
    expect(renderDailyReport(green)).toContain('dokument w wFirmie (WZ 142/4/11/26)')
    // ten sam dokument ma już nasz ruch (faktura rozliczona): WZ nie dokłada drugiego wyjaśnienia
    await db.pendingMovement.create({ data: { productId: a, warehouseId: 'glowny', delta: -1, type: 'BL_INVOICE', state: 'CONFIRMED', sentAt: new Date('2026-10-28T00:20:00Z'), effectiveAt: new Date('2026-10-28T00:20:00Z'), wzQty: 1, wfirmaDocId: 'SD 142/4/11/26', idempotencyKey: 'test:a135' } })
    const again = await buildDailyReport(db, DAY, NOW)
    expect(again.stocks.physicalVsBlList[0]?.wzDocs).toBeUndefined()
    // WZ na 2 szt., nasz ruch z tym numerem na 1 szt. (druga wydana z braku bez ruchu) — reszta 1 szt. wyjaśnia
    await db.wfirmaWzSnapshot.updateMany({ data: { lines: [{ wfirmaGoodId: '90000077', count: 1 }, { wfirmaGoodId: '90000077', count: 1 }] } })
    const partial = await buildDailyReport(db, DAY, NOW)
    expect(partial.stocks.physicalVsBlList[0]).toMatchObject({ sku: '90002', wzDocs: ['WZ 142/4/11/26'] })
  })

  it('ruch APPLIED niepotwierdzony (< 24 h) = „w drodze”: BL może już widzieć WZ, lustro jeszcze nie', async () => {
    await base()
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 10, { link: '101' })
    const orderId = await reservedOrder(a, 2, new Date('2026-10-27T20:00:00Z'))
    await applyBlInvoice(db, orderId, 'FV/T/10', { [a]: 2 }, { now: new Date('2026-10-27T21:00:00Z') })
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 0, inTransit: 1 })
    expect(r.stalePending.count).toBe(0)
    expect(r.ok).toBe(true)
  })

  it('„w drodze” tylko gdy ruchy w oknie wyjaśniają różnicę — u nas 10, BL 50 przy codziennej sprzedaży = rozjazd', async () => {
    await base()
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 50, { link: '101' })
    // sprzedaż 1 szt. między odczytem BL (00:30) a odczytem wFirmy (00:40): ruch jest, ale nie tłumaczy 40 szt.
    await db.stockMovement.create({ data: { productId: a, warehouseId: 'glowny', deltaPhysical: -1, source: 'WFIRMA_SYNC', reason: 'test', actorId: 'test', createdAt: new Date('2026-10-28T00:35:00Z') } })
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 1, inTransit: 0 })
    expect(r.ok).toBe(false)

    // ruch poza oknem (przed odczytem BL) nie wyjaśnia niczego, nawet gdy jest duży
    const b = await product(db, 'T-002', 5, { wfirmaGoodId: '102', readAt: READ_AT })
    await bl('bl-b', b, 7, { link: '102' })
    await db.stockMovement.create({ data: { productId: b, warehouseId: 'glowny', deltaPhysical: -2, source: 'WFIRMA_SYNC', reason: 'test', actorId: 'test', createdAt: new Date('2026-10-28T00:10:00Z') } })
    const r2 = await buildDailyReport(db, DAY, NOW)
    expect(r2.stocks.physicalVsBlList.find((d) => d.sku === 'T-002')?.inTransit).toBeFalsy()
    expect(r2.stocks.physicalVsBlForOk).toBe(2)
  })

  it('niepotwierdzony APPLIED toleruje tylko swoją ilość — BL 50 przy wydaniu 2 szt. = rozjazd', async () => {
    await base()
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 50, { link: '101' })
    const orderId = await reservedOrder(a, 2, new Date('2026-10-27T20:00:00Z'))
    await applyBlInvoice(db, orderId, 'FV/T/11', { [a]: 2 }, { now: new Date('2026-10-27T21:00:00Z') })
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 1, inTransit: 0 })
    expect(r.ok).toBe(false)
  })

  it('rekordy przestemplowane przez trwający import (RUNNING, nowszy niż ostatni OK) nie wypadają z raportu', async () => {
    await base()
    await db.importRun.create({ data: { id: 'run-katalog-3', kind: 'katalog-bl-wfirma', status: 'RUNNING', startedAt: new Date('2026-10-28T00:50:00Z') } })
    const a = await product(db, 'T-001', 5, { wfirmaGoodId: '101', readAt: READ_AT })
    const b = await product(db, 'T-002', 6, { wfirmaGoodId: '102', readAt: READ_AT })
    await bl('bl-a', a, 5, { link: '101' }) // jeszcze z ostatniego udanego importu
    await bl('bl-b', b, 9, { link: '102', run: 'run-katalog-3' }) // już przestemplowany przez trwający import
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks.blStaleRecords).toBe(0)
    expect(r.stocks).toMatchObject({ products: 2, physicalVsBl: 1, physicalVsBlForOk: 1 })
    expect(r.stocks.physicalVsBlList[0]).toMatchObject({ sku: 'T-002', physical: 6, bl: 9 })
    expect(r.ok).toBe(false)

    // RUNNING starszy niż ostatni udany (przerwany import) nie przywraca swoich rekordów
    await db.importRun.create({ data: { id: 'run-katalog-0', kind: 'katalog-bl-wfirma', status: 'RUNNING', startedAt: new Date('2026-10-27T00:00:00Z') } })
    const c = await product(db, 'T-003', 4, { wfirmaGoodId: '103', readAt: READ_AT })
    await bl('bl-c', c, 1, { link: '103', run: 'run-katalog-0' })
    const r2 = await buildDailyReport(db, DAY, NOW)
    expect(r2.stocks.blStaleRecords).toBe(1)
    expect(r2.stocks.physicalVsBlList.map((d) => d.sku)).toEqual(['T-002'])
  })

  const sync = (productId: string, delta: number, at = new Date('2026-10-28T00:35:00Z')) =>
    db.stockMovement.create({ data: { productId, warehouseId: 'glowny', deltaPhysical: delta, source: 'WFIRMA_SYNC', reason: 'test', actorId: 'test', createdAt: at } })

  it('kg — sprzedaż na wagę przez granicę kilograma tolerowana do swojej ilości (przedział BL ucięty), nie pełne kg', async () => {
    await base()
    // wFirma 3,1 kg przy imporcie BL (BL: 3), w oknie sprzedaż 250 g → u nas 2850 g: 150 g od przedziału [3000, 3999]
    const a = await product(db, 'T-KG1', 2850, { unit: 'KG', wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 3, { link: '101' })
    await sync(a, -250)
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 0, inTransit: 1 })
    expect(r.ok).toBe(true)

    // ruch 100 g nie wyjaśnia 150 g różnicy → rozjazd
    const b = await product(db, 'T-KG2', 2850, { unit: 'KG', wfirmaGoodId: '102', readAt: READ_AT })
    await bl('bl-b', b, 3, { link: '102' })
    await sync(b, -100)
    const r2 = await buildDailyReport(db, DAY, NOW)
    expect(r2.stocks).toMatchObject({ physicalVsBl: 2, physicalVsBlForOk: 1, inTransit: 1 })
    expect(r2.stocks.physicalVsBlList[0]).toMatchObject({ sku: 'T-KG2' })
    expect(r2.ok).toBe(false)
  })

  it('ruch biura (MANUAL) i sprzedaż w oknie składają się — bez fałszywego czerwonego', async () => {
    await base()
    const a = await product(db, 'T-001', 10, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 10, { link: '101' }) // BL starszy: nie widzi ani wydania bez faktury, ani sprzedaży w oknie
    const orderId = await reservedOrder(a, 2, new Date('2026-10-26T08:00:00Z'))
    await applyBlShippedWithoutInvoice(db, orderId, { now: new Date('2026-10-26T09:00:00Z') }) // MANUAL −2 → 8
    // odczyt wFirmy 00:40 po sprzedaży 1 szt. w oknie: wFirma 9, u nas 9 − 2 = 7
    await db.stock.update({ where: { productId_warehouseId: { productId: a, warehouseId: 'glowny' } }, data: { wfirmaCount: 9, physical: 7 } })
    await sync(a, -1)
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 0, inTransit: 1 })
    expect(r.ok).toBe(true)
  })

  it('ruch CANCELLED w oknie nie poszerza tolerancji; CONFIRMED w oknie tak (BL starszy go nie widział)', async () => {
    await base()
    const a = await product(db, 'T-001', 5, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 7, { link: '101' })
    const at = new Date('2026-10-28T00:35:00Z')
    await db.pendingMovement.create({ data: { productId: a, warehouseId: 'glowny', delta: -2, type: 'OWN_INVOICE', state: 'CANCELLED', sentAt: at, idempotencyKey: 'u9-cancelled' } })
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 1, inTransit: 0 })
    expect(r.ok).toBe(false)

    await db.pendingMovement.create({ data: { productId: a, warehouseId: 'glowny', delta: -2, type: 'OWN_INVOICE', state: 'CONFIRMED', sentAt: at, confirmedAt: at, idempotencyKey: 'u9-confirmed' } })
    const r2 = await buildDailyReport(db, DAY, NOW)
    expect(r2.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 0, inTransit: 1 })
  })

  it('trwający import przestemplował wszystkie rekordy — filtr dalej działa, rekord skasowany w BL pominięty', async () => {
    await base()
    await db.importRun.create({ data: { id: 'run-katalog-3', kind: 'katalog-bl-wfirma', status: 'RUNNING', startedAt: new Date('2026-10-28T00:50:00Z') } })
    const a = await product(db, 'T-001', 5, { wfirmaGoodId: '101', readAt: READ_AT })
    await bl('bl-a', a, 5, { link: '101', run: 'run-katalog-3' })
    await bl('bl-old', a, 9, { link: '101', run: 'run-katalog-1' }) // skasowany w BL przed ostatnim importem
    const r = await buildDailyReport(db, DAY, NOW)
    expect(r.stocks).toMatchObject({ blStaleRecords: 1, blConflicting: 0, physicalVsBl: 0 })
    expect(r.ok).toBe(true)
  })

  it('raport zapisany (stats bez nowych pól) dalej się renderuje', async () => {
    const old = {
      day: DAY,
      generatedAt: NOW.toISOString(),
      sales: null,
      streaks: {},
      orders: { comparedAt: null, blComplete: null, accounts: [] },
      invoices: { pending: 0, waitingForWz: 0, withoutWz: 0, shippedWithoutInvoice: 0 },
      stocks: { products: 1, blSnapshotAt: null, physicalVsBl: 1, physicalVsBlList: [{ sku: 'T-001', physical: 1, available: 1, bl: 2, unit: 'SZT' }], offersWithChannelRead: 0, channelVsTarget: 0, channelVsTargetList: [] },
      saved: { offers: 0, list: [] },
      stalePending: { count: 2, byKind: { 'BL_INVOICE/MANUAL': 2 } },
      overcommit: { count: 0, skus: [] },
      invariants: { count: 0, byRule: {} },
      toClarify: { count: 1, byReason: { 'bez powodu': 1 } },
      ok: false,
    } as unknown as DailyReport
    const md = renderDailyReport(JSON.parse(JSON.stringify(old)) as DailyReport)
    expect(md).toContain('## Do wyjaśnienia')
    expect(md).toContain('T-001: u nas 1 (dostępne 1), BL 2')
    expect(md).not.toContain('Dla biura')
  })
})

// przypadki z raportu stagingu za 04.11 (towary i liczby zmyślone, układ czasu jak na stagingu).
describe('raport rozjazdów: stany z jednej chwili i ujemny stan', () => {
  const DAY = '2026-11-04'
  const MIRROR_AT = new Date('2026-11-04T02:55:00Z') // nocny pełny odczyt
  const BL_AT = new Date('2026-11-04T21:03:00Z') // import katalogu wieczorem
  const NOW = new Date('2026-11-05T00:02:00Z') // raport tuż po północy (01:02 w Warszawie)
  const RUN = 'run-katalog-a106'

  async function base() {
    await db.shadowDailyCheck.create({ data: { kind: SALES_CHECK, day: DAY, final: true, ok: true, checkedAt: NOW, stats: { day: DAY, final: true, blComplete: true, blErrors: [], accounts: [], notCompared: [], ok: true } } })
    await db.importRun.create({ data: { id: RUN, kind: 'katalog-bl-wfirma', status: 'OK', startedAt: new Date(BL_AT.getTime() - 60_000), finishedAt: BL_AT } })
    await setMirror(MIRROR_AT)
  }
  async function bl(id: string, productId: string, stock: number, link: string) {
    await db.blProduct.create({ data: { id, inventoryId: '1', name: `Towar testowy ${id}`, sku: id, stockAccounting: String(stock), productId, wfirmaGoodIdLink: link, importRunId: RUN, importedAt: BL_AT } })
  }

  it('PZ w wFirmie w ciągu dnia: lustro z nocy 0, BL wieczorem 10 → czerwony z ostrzeżeniem; pełny odczyt zlecony po imporcie wyrównuje chwile → zielony', async () => {
    await base()
    const a = await product(db, 'T-010', 0, { wfirmaGoodId: '110', readAt: MIRROR_AT })
    await bl('bl-10', a, 10, '110')
    const red = await buildDailyReport(db, DAY, NOW)
    expect(red.stocks).toMatchObject({ physicalVsBl: 1, physicalVsBlForOk: 1, inTransit: 0, mirrorBeforeBl: true })
    expect(red.ok).toBe(false)
    expect(renderDailyReport(red)).toContain('jest starszy niż kopia stanów BL')

    // import katalogu zleca pełny odczyt; raport z harmonogramu na niego czeka (najwyżej 3 h po końcu dnia)
    expect(await requestMirrorAfterImport(db, { CIEN_LUSTRO_WFIRMY: '1' }, { now: new Date(BL_AT.getTime() + 60_000) })).toBe(true)
    const pending = await db.wfirmaQueueState.findFirst({ select: { fullReadDueSince: true } })
    expect(pending?.fullReadDueSince).not.toBeNull()
    expect(reportWaitsForMirror(pending, DAY, NOW)).toBe(true)
    expect(reportWaitsForMirror(pending, DAY, new Date('2026-11-05T02:01:00Z'))).toBe(false) // 3 h po północy: bez czekania

    const api = new FakeApi2()
    api.goods.set('110', { count: 10, wh: WH })
    const r = await runLustroWfirmy(db, new WfirmaStockReader(api), { now: new Date(BL_AT.getTime() + 2 * 60_000) })
    expect(r.fullReadDone).toBe(true)
    expect(await stockOf(db, a)).toMatchObject({ wfirmaCount: 10, physical: 10 })
    expect(reportWaitsForMirror(await db.wfirmaQueueState.findFirst({ select: { fullReadDueSince: true } }), DAY, NOW)).toBe(false)

    const green = await buildDailyReport(db, DAY, NOW)
    expect(green.stocks).toMatchObject({ physicalVsBl: 0, physicalVsBlForOk: 0, mirrorBeforeBl: false })
    expect(green.ok).toBe(true)
    await expectInvariants(db)
  })

  it('zlecenie po imporcie: wyłączone lustro albo zła wartość wyłącznika = nic; drugie zlecenie nie przesuwa terminu', async () => {
    expect(await requestMirrorAfterImport(db, { CIEN_LUSTRO_WFIRMY: '0' })).toBe(false)
    expect(await requestMirrorAfterImport(db, { CIEN_LUSTRO_WFIRMY: 'tak' })).toBe(false)
    expect(await db.wfirmaQueueState.count()).toBe(0)
    expect(await requestMirrorAfterImport(db, { CIEN_LUSTRO_WFIRMY: '1' }, { now: min(0) })).toBe(true)
    expect(await requestMirrorAfterImport(db, { CIEN_LUSTRO_WFIRMY: '1' }, { now: min(30) })).toBe(true)
    expect((await db.wfirmaQueueState.findFirst())?.fullReadDueSince).toEqual(min(0))
    expect(reportWaitsForMirror(null, DAY, NOW)).toBe(false)
  })

  it('ujemny fizyczny z ruchu biura przy rezerwacjach 0 nie jest nadmiarem (nie zeruje `ok`); rezerwacje ponad stan dalej są', async () => {
    await base()
    // wydane bez faktury przy stanie 1, potem wFirma 0: fizyczny −1, rezerwacje 0 (jak 02897, 03057, 03049, 03160)
    const a = await product(db, 'T-020', 1, { wfirmaGoodId: '120', readAt: new Date('2026-11-03T07:00:00Z') })
    await bl('bl-20', a, 0, '120')
    const o1 = await reservedOrder(a, 1, new Date('2026-11-03T08:00:00Z'))
    await applyBlShippedWithoutInvoice(db, o1, { now: new Date('2026-11-03T09:00:00Z') })
    await applyStockRead(db, { productId: a, countBase: 0, requestSentAt: MIRROR_AT }, { now: MIRROR_AT })
    expect(await stockOf(db, a)).toMatchObject({ physical: -1, reserved: 0 })
    expect((await stockOf(db, a)).overcommitSince).not.toBeNull()

    const only = await buildDailyReport(db, DAY, NOW)
    expect(only.overcommit).toEqual({ count: 0, skus: [], noExcess: 1, noExcessSkus: ['T-020'] })
    expect(only.stocks).toMatchObject({ physicalVsBlForOk: 0, office: 1 })
    expect(only.ok).toBe(true)
    expect(renderDailyReport(only)).toContain('Znacznik nadmiaru bez rezerwacji ponad stan (zwykle stan ujemny z ruchów biura; nie nadmiar, nie zeruje wyniku): 1 (T-020)')

    // prawdziwy nadmiar (jak 90003: zarezerwowane 3, wFirma zeszła do 1)
    const b = await product(db, 'T-021', 3, { wfirmaGoodId: '121', readAt: new Date('2026-11-03T07:00:00Z') })
    await bl('bl-21', b, 1, '121')
    await reservedOrder(b, 3, new Date('2026-11-03T08:00:00Z'))
    await applyStockRead(db, { productId: b, countBase: 1, requestSentAt: MIRROR_AT }, { now: MIRROR_AT })
    const both = await buildDailyReport(db, DAY, NOW)
    expect(both.overcommit).toMatchObject({ count: 1, skus: ['T-021'], noExcess: 1 })
    expect(both.ok).toBe(false)
    await expectInvariants(db)
  })

  describe('handler cien-raport-rozjazdow czeka na zlecony pełny odczyt', () => {
    afterEach(() => {
      vi.useRealTimers()
    })
    async function runHandlerAt(iso: string, env: Record<string, string>) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(iso))
      const dir = await mkdtemp(path.join(os.tmpdir(), 'rozjazdy-a106-'))
      await handlers['cien-raport-rozjazdow']!(db, null, { organizationId: ORG_A, secrets: { env: { RAPORTY_DIR: dir, ...env }, envFallback: false } })
      vi.useRealTimers()
      return db.shadowDailyCheck.count({ where: { kind: REPORT_CHECK, day: DAY } })
    }

    it('znacznik pełnego odczytu stoi: 01:00 w Warszawie brak raportu, 03:30 raport jest (granica 3 h)', async () => {
      await base()
      await requestMirrorAfterImport(db, { CIEN_LUSTRO_WFIRMY: '1' }, { now: BL_AT })
      expect(await runHandlerAt('2026-11-05T00:00:00Z', { CIEN_LUSTRO_WFIRMY: '1' })).toBe(0)
      expect(await runHandlerAt('2026-11-05T02:30:00Z', { CIEN_LUSTRO_WFIRMY: '1' })).toBe(1)
    })

    it('lustro wyłączone: stary znacznik nie wstrzymuje raportu — wiersz o 00:02 UTC (01:02 w Warszawie)', async () => {
      await base()
      await requestMirrorAfterImport(db, { CIEN_LUSTRO_WFIRMY: '1' }, { now: BL_AT }) // zlecenie sprzed wyłączenia lustra
      expect((await db.wfirmaQueueState.findFirst())?.fullReadDueSince).not.toBeNull()
      expect(await runHandlerAt('2026-11-05T00:02:00Z', { CIEN_LUSTRO_WFIRMY: '0' })).toBe(1)
    })
  })
})
