// na bazie: faktury BL w cieniu (krok 1), dzienny raport rozjazdów (krok 2), przegląd otwartych zamówień
// kontra kanał (krok 6), planowanie zadań BL tylko dla firm z BL (krok 7). BL i wFirma wyłącznie atrapy, dane fikcyjne.
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { AdapterError } from '@/lib/adaptery/kontrakt'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { runBlComparison } from '@/lib/cien/bl-porownanie'
import { syncBlInvoices, WZ_MAX_ATTEMPTS, type WzLine, type WzOdczyt } from '@/lib/cien/faktury-bl'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { shadowMetrics } from '@/lib/cien/metryki'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { GONE_REASON, reviewOpenOrders } from '@/lib/cien/przeglad-otwartych'
import { buildDailyReport, latestDailyReport, renderDailyReport, REPORT_CHECK } from '@/lib/cien/raport-dzienny'
import { runDaySalesCheck } from '@/lib/cien/sprzedaz-dnia'
import { HARMONOGRAM_RDZENIA } from '@/lib/worker/harmonogram'
import { OrgClients, planSchedule, type WorkerDeps } from '@/lib/worker/petla'
import { handlers } from '@/lib/worker/zadania'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { FakeBl, sec } from './bl-atrapa'
import { testDbUrl } from './global-setup'
import { expectInvariants, offer, product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const T = new Date('2026-10-27T08:00:00.000Z') // wtorek 09:00 w Warszawie
const min = (n: number) => new Date(T.getTime() + n * 60_000)
const SRC = { env: {}, envFallback: false }
const MAP = { shopAccounts: ['sd'], empikAccountId: null }

class FakeWz implements WzOdczyt {
  docs = new Map<string, WzLine[]>()
  calls: string[] = []
  async wzForInvoice(n: string): Promise<WzLine[] | null> {
    this.calls.push(n)
    return this.docs.get(n) ?? null
  }
}

let state: FakeChannelState
let registry: AdapterRegistry
let bl: FakeBl
let wz: FakeWz
let a: string

async function sd() {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
  return (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
}

/** Zamówienie z cienia (2 szt. A) połączone z BL 7001 przez porównanie (status BL `statusId`). */
async function shadowOrderPairedWithBl(statusId = 2): Promise<string> {
  state.upsertOrder(fakeOrder({ externalId: '501', createdAt: new Date('2026-10-27T07:00:00Z'), revision: '2026-10-27T07:00:00.000Z', totalGross: 40, lines: [{ externalLineId: '1', offerExternalId: '10', qty: 2, unitPriceGross: 20, vatRate: '23' }] }))
  await pollAccount(db, await sd(), { registry, secrets: SRC, now: () => min(-50), initialLookbackMs: 3 * 3600_000 })
  bl.orders = [
    { order_id: 7001, order_source: 'shop', order_source_id: 'sd', shop_order_id: 501, order_status_id: statusId, date_add: sec('2026-10-27T07:01:00Z'), date_confirmed: sec('2026-10-27T07:01:00Z'), delivery_price: 0, products: [{ price_brutto: 20, quantity: 2 }], email: 'klient.testowy@example.invalid' },
  ]
  await runBlComparison(db, bl.client(), MAP, await accountsForComparison(db), { now: min(-10), windowMs: 4 * 3600_000, graceMs: 0 })
  const o = await db.order.findFirstOrThrow({ where: { externalId: '501' } })
  expect(o.blOrderId).toBe(7001)
  return o.id
}

const invoice = (over: Record<string, unknown> = {}) => ({
  invoice_id: 55,
  order_id: 7001,
  number: 'FV 1/10/2026',
  external_invoice_number: 'FV/1/2026',
  type: 'normal',
  date_add: sec(min(-5)),
  invoice_fullname: 'Jan Testowy',
  invoice_nip: '1234563218',
  ...over,
})

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
  bl = new FakeBl()
  wz = new FakeWz()
  a = await product(db, 'A', 20)
  await db.product.update({ where: { id: a }, data: { wfirmaGoodId: '100' } })
  await offer(db, 'WOO_SD', '10', a)
})

describe('faktury BL w cieniu (krok 1)', () => {
  it('faktura w BL: rezerwacja CONSUMED, ruch BL_INVOICE APPLIED z ilością WZ, available bez zmian, niezmienniki; powtórka bez dubli', async () => {
    const orderId = await shadowOrderPairedWithBl()
    expect(await stockOf(db, a)).toMatchObject({ physical: 20, reserved: 2, available: 18 })
    bl.invoices = [invoice()]
    wz.docs.set('FV/1/2026', [{ wfirmaGoodId: '100', count: 2 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: T })
    expect(s).toMatchObject({ fetched: 1, applied: 1, errors: [] })
    expect(await db.reservation.findMany({ where: { orderId } })).toEqual([expect.objectContaining({ state: 'CONSUMED', qtyBase: 2 })])
    const m = await db.pendingMovement.findMany({ where: { orderId } })
    expect(m).toEqual([expect.objectContaining({ type: 'BL_INVOICE', state: 'APPLIED', delta: -2, wzQty: 2, wfirmaDocId: 'FV/1/2026' })])
    expect(await stockOf(db, a)).toMatchObject({ physical: 18, reserved: 0, available: 18, pendingDelta: -2 })
    const snap = await db.blInvoiceSnapshot.findFirstOrThrow()
    expect(snap).toMatchObject({ outcome: 'ZASTOSOWANA', orderId, blOrderId: 7001 })
    expect(JSON.stringify(snap)).not.toMatch(/Testowy|1234563218/)
    await expectInvariants(db)
    // kolejny przebieg: od następnego numeru faktury, nic nowego
    const s2 = await syncBlInvoices(db, bl.client(), wz, { now: min(2) })
    expect(s2).toMatchObject({ fetched: 0, applied: 0 })
    expect(bl.calls.filter((c) => c.method === 'getInvoices').at(-1)!.params).toEqual({ id_from: 56 })
    expect(await db.pendingMovement.count()).toBe(1)
    expect(await db.orderEvent.count({ where: { orderId, kind: 'FAKTURA_BL' } })).toBe(1)
  })

  it('WZ jeszcze nie ma: faktura czeka; po limicie prób rozchód z ruchem MANUAL (biuro poprawia WZ)', async () => {
    const orderId = await shadowOrderPairedWithBl()
    bl.invoices = [invoice()]
    const s = await syncBlInvoices(db, bl.client(), wz, { now: T })
    expect(s).toMatchObject({ waitingForWz: 1, applied: 0 })
    expect((await stockOf(db, a)).reserved).toBe(2)
    for (let i = 1; i < WZ_MAX_ATTEMPTS; i++) await syncBlInvoices(db, bl.client(), wz, { now: min(2 * i) })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'BEZ_WZ' })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ type: 'BL_INVOICE', state: 'MANUAL', wzQty: 0 })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0, available: 18 })
    await expectInvariants(db)
  })

  it('BL „Wysłane” bez faktury → CONSUMED + ruch MANUAL i alert; faktura po fakcie zamienia ruch w BL_INVOICE', async () => {
    const orderId = await shadowOrderPairedWithBl(3)
    const s = await syncBlInvoices(db, bl.client(), wz, { now: T })
    expect(s.shippedWithoutInvoice).toBe(1)
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' })
    expect(await db.alert.count({ where: { kind: 'WYDANE_BEZ_DOKUMENTU' } })).toBe(1)
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0, available: 18 })
    // drugi przebieg nic nie dubluje
    expect((await syncBlInvoices(db, bl.client(), wz, { now: min(2) })).shippedWithoutInvoice).toBe(0)
    bl.invoices = [invoice({ date_add: sec(min(3)) })]
    wz.docs.set('FV/1/2026', [{ wfirmaGoodId: '100', count: 2 }])
    expect((await syncBlInvoices(db, bl.client(), wz, { now: min(4) })).applied).toBe(1)
    expect(await db.pendingMovement.findMany({ where: { orderId } })).toEqual([expect.objectContaining({ type: 'BL_INVOICE', state: 'APPLIED', wzQty: 2 })])
    await expectInvariants(db)
  })

  it('bez kluczy wFirmy faktura czeka; korekta bez ruchu; faktura spoza cienia po 3 dniach zamknięta; błąd BL → niepełny odczyt', async () => {
    const orderId = await shadowOrderPairedWithBl()
    bl.invoices = [invoice(), invoice({ invoice_id: 56, type: 'correcting', number: 'FK 1/10/2026' }), invoice({ invoice_id: 57, order_id: 9999, date_add: sec('2026-10-20T10:00:00Z') })]
    const s = await syncBlInvoices(db, bl.client(), null, { now: T, initialLookbackMs: 10 * 24 * 3600_000 })
    expect(s).toMatchObject({ waitingNoWfirma: 1, corrections: 1, outsideShadow: 1, applied: 0 })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect(await db.reservation.count({ where: { orderId, state: 'ACTIVE' } })).toBe(1)
    bl.failNext = 'getInvoices'
    const s2 = await syncBlInvoices(db, bl.client(), null, { now: min(2) })
    expect(s2.blComplete).toBe(false)
    expect(s2.errors.join(' ')).toMatch(/getInvoices/)
  })

  it('wFirma nie zna WZ żadnej z ≥ 3 faktur (zła konfiguracja) — po limicie prób faktury czekają, 1 alert, 0 ruchów MANUAL', async () => {
    const orderId = await shadowOrderPairedWithBl()
    bl.invoices = [invoice(), invoice({ invoice_id: 56, number: 'FV 2/10/2026', external_invoice_number: 'FV/2/2026' }), invoice({ invoice_id: 57, number: 'FV 3/10/2026', external_invoice_number: 'FV/3/2026' })]
    let last
    for (let i = 0; i < WZ_MAX_ATTEMPTS + 2; i++) last = await syncBlInvoices(db, bl.client(), wz, { now: min(2 * i) })
    expect(last!.errors.join(' ')).toMatch(/żadnej z 3 faktur/)
    expect(await db.blInvoiceSnapshot.count({ where: { appliedAt: null } })).toBe(3)
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await db.alert.count({ where: { kind: 'FAKTURY_BL_BEZ_WZ' } })).toBe(1)
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'ACTIVE' })
    // pierwsza faktura z WZ wyłącza bezpiecznik: kolejne bez WZ idą zwykłą drogą
    wz.docs.set('FV/1/2026', [{ wfirmaGoodId: '100', count: 2 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: min(60) })
    expect(s.applied).toBe(1)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow({ where: { blInvoiceId: 55 } })).toMatchObject({ outcome: 'ZASTOSOWANA' })
    await expectInvariants(db)
  })

  it('faktury BL bez naszego zamówienia (ponad limit przebiegu) nie blokują rozliczenia naszej faktury', async () => {
    const orderId = await shadowOrderPairedWithBl()
    // 600 świeżych faktur zamówień spoza cienia (np. kanał nieczytany) z niższymi numerami niż nasza
    await db.blInvoiceSnapshot.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({ blInvoiceId: 1 + i, blOrderId: 20_000 + i, number: `FV ${i + 1}/10/2026`, kind: 'normal', dateAdd: min(-30), fetchedAt: min(-30) })),
    })
    bl.invoices = [invoice({ invoice_id: 700 })]
    wz.docs.set('FV/1/2026', [{ wfirmaGoodId: '100', count: 2 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: T })
    expect(s).toMatchObject({ fetched: 1, applied: 1, waitingForOrder: 600, outsideShadow: 0, errors: [] })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONSUMED' })
    await expectInvariants(db)
  })
})

describe('dzienny raport rozjazdów (krok 2)', () => {
  it('sekcje 1–5 i lista do wyjaśnienia: same liczby, numery i SKU; zapis w bazie i plik z handlera', async () => {
    await shadowOrderPairedWithBl()
    // porównanie statusów jak w handlerze cien-bl-porownanie (wynik w ImportRun)
    const cmp = await runBlComparison(db, bl.client(), MAP, await accountsForComparison(db), { now: min(5), windowMs: 4 * 3600_000, graceMs: 0 })
    await db.importRun.create({ data: { kind: 'cien-bl', status: 'OK', startedAt: min(5), finishedAt: min(5), stats: JSON.parse(JSON.stringify(cmp)) } })
    // sprzedaż dnia 27.10 (do 23:00 UTC), zamknięta 28.10 po północy
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: new Date('2026-10-27T23:40:00Z') })
    // stany: BL accounting_1 = 15 (u nas 20), „wysłałbym” 5 przy stanie BL 0 dla drugiego produktu → uratowana sprzedaż
    const b = await product(db, 'B', 3)
    const offB = await offer(db, 'WOO_SD', '11', b)
    await db.blProduct.createMany({
      data: [
        { id: 'bl-a', inventoryId: '1', name: 'Towar testowy A', stockAccounting: '15', productId: a, importRunId: 'run-test' },
        { id: 'bl-b', inventoryId: '1', name: 'Towar testowy B', stockAccounting: '0', productId: b, importRunId: 'run-test' },
      ],
    })
    await db.channelPushLog.create({ data: { offerId: offB, channel: 'WOO', channelAccountId: 'sd', mode: 'CIEN', targetQty: 3, delayMs: 100, createdAt: new Date('2026-10-27T12:00:00Z') } })
    // znacznik nadmiaru > 30 min bez rezerwacji ponad stan (nie nadmiar, osobna pozycja raportu)
    await db.stock.update({ where: { productId_warehouseId: { productId: b, warehouseId: 'glowny' } }, data: { overcommitSince: new Date('2026-10-27T10:00:00Z') } })
    const r = await buildDailyReport(db, '2026-10-27', new Date('2026-10-28T01:00:00Z'))
    expect(r.sales?.accounts.find((x) => x.channelAccountId === 'sd')).toMatchObject({ ok: true, ours: { count: 1, cents: 4000 }, bl: { count: 1, cents: 4000 } })
    expect(r.streaks['WOO|sd']).toBe(1)
    expect(r.orders.accounts.find((x) => x.channelAccountId === 'sd')).toMatchObject({ paired: 1, activeReservationsBlAhead: 0 })
    expect(r.stocks).toMatchObject({ products: 2, physicalVsBl: 2 })
    expect(r.stocks.physicalVsBlList.map((d) => d.sku).sort()).toEqual(['A', 'B'])
    expect(r.saved).toMatchObject({ offers: 1, list: [{ sku: 'B', account: 'WOO/sd', target: 3 }] })
    expect(r.overcommit).toMatchObject({ count: 0, skus: [], noExcess: 1, noExcessSkus: ['B'] })
    expect(r.invariants.count).toBe(0)
    expect(r.ok).toBe(false) // rozjazdy stanu bez ruchu (A 20 vs 15, B 3 vs 0)
    const md = renderDailyReport(r)
    expect(md).toContain('Raport rozjazdów cienia — 2026-10-27')
    expect(md).toContain('„Uratowane sprzedaże”')
    expect(md).not.toContain('example.invalid')

    // handler: plik w RAPORTY_DIR/rozjazdy/<firma>/ i wiersz w bazie; ekran czyta ostatni
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rozjazdy-'))
    await handlers['cien-raport-rozjazdow']!(db, { day: '2026-10-27' }, { organizationId: ORG_A, secrets: { env: { RAPORTY_DIR: dir }, envFallback: false } })
    const file = await readFile(path.join(dir, 'rozjazdy', ORG_A, 'rozjazdy-2026-10-27.md'), 'utf8')
    expect(file).toContain('## 5. Niezmienniki')
    expect(await db.shadowDailyCheck.count({ where: { kind: REPORT_CHECK } })).toBe(1)
    expect((await latestDailyReport(db))?.day).toBe('2026-10-27')
  })
})

describe('przegląd otwartych zamówień kontra kanał (krok 6)', () => {
  async function openOrders(): Promise<void> {
    for (const id of ['601', '602', '603']) state.upsertOrder(fakeOrder({ externalId: id, lines: [{ externalLineId: '1', offerExternalId: '10', qty: 1, unitPriceGross: 10, vatRate: '23' }] }))
    await pollAccount(db, await sd(), { registry, secrets: SRC, now: () => T })
  }

  it('kopia starsza niż X h: kanał „nie ma” → DO_WYJASNIENIA + alert, rezerwacja zostaje; jest → odświeżona kopia; błąd → bez zmian', async () => {
    await openOrders()
    state.orders.delete('601') // usunięte w kanale na stałe
    const later = new Date(T.getTime() + 30 * 3600_000)
    const r = await reviewOpenOrders(db, { registry, secrets: SRC, now: later, staleMs: 24 * 3600_000 })
    expect(r).toMatchObject({ accounts: 1, checked: 3, gone: 1, refreshed: 2, errors: [] })
    const gone = await db.order.findFirstOrThrow({ where: { externalId: '601' } })
    expect(gone.status).toBe('DO_WYJASNIENIA')
    expect((gone.flags as { doWyjasnienia?: string }).doWyjasnienia).toContain(GONE_REASON)
    expect(await db.reservation.count({ where: { orderId: gone.id, state: 'ACTIVE' } })).toBe(1) // bez automatycznego anulowania
    expect(await db.alert.count({ where: { kind: 'ZAMOWIENIE_ZNIKNELO_Z_KANALU' } })).toBe(1)
    for (const id of ['602', '603']) expect((await db.order.findFirstOrThrow({ where: { externalId: id } })).status).toBe('DO_REALIZACJI')
    expect((await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: '602' } })).lastSeenAt.toISOString()).toBe(later.toISOString())
    // kopie świeże → kolejny przegląd nikogo nie pobiera; 601 już nie jest otwarte
    expect((await reviewOpenOrders(db, { registry, secrets: SRC, now: new Date(later.getTime() + 60_000), staleMs: 24 * 3600_000 })).checked).toBe(0)
    // błąd odczytu ≠ „nie ma”: zamówienie bez zmian
    const muchLater = new Date(later.getTime() + 30 * 3600_000)
    state.getFailures.push(new AdapterError('atrapa: kanał chwilowo niedostępny', 'PRZEJSCIOWY'), new AdapterError('atrapa: kanał chwilowo niedostępny', 'PRZEJSCIOWY'))
    const r3 = await reviewOpenOrders(db, { registry, secrets: SRC, now: muchLater, staleMs: 24 * 3600_000 })
    expect(r3).toMatchObject({ checked: 2, gone: 0 })
    expect(r3.errors).toHaveLength(2)
    for (const id of ['602', '603']) expect((await db.order.findFirstOrThrow({ where: { externalId: id } })).status).toBe('DO_REALIZACJI')
    await expectInvariants(db)
  })

  it('kanał „nie zna” żadnego z 3+ zamówień (zła konfiguracja, 404 na wszystko) → bez zmian i błąd zadania', async () => {
    await openOrders()
    for (const id of ['601', '602', '603']) state.orders.delete(id)
    const r = await reviewOpenOrders(db, { registry, secrets: SRC, now: new Date(T.getTime() + 30 * 3600_000), staleMs: 24 * 3600_000 })
    expect(r).toMatchObject({ checked: 3, gone: 0, refreshed: 0 })
    expect(r.errors.join(' ')).toMatch(/żadnego z 3/)
    expect(await db.order.count({ where: { status: 'DO_WYJASNIENIA' } })).toBe(0)
    expect(await db.alert.count({ where: { kind: 'ZAMOWIENIE_ZNIKNELO_Z_KANALU' } })).toBe(0)
  })

  it('świeże kopie (młodsze niż X h) nie są pobierane', async () => {
    await openOrders()
    const r = await reviewOpenOrders(db, { registry, secrets: SRC, now: new Date(T.getTime() + 3600_000), staleMs: 24 * 3600_000 })
    expect(r.checked).toBe(0)
  })
})

describe('metryka „zmiana w kanale → u nas” (krok 3, część w kodzie)', () => {
  it('revisionSeenAt = pierwszy odczyt danej rewizji; p50/p95 z różnicy względem daty zmiany w kanale', async () => {
    const acc = await sd()
    state.upsertOrder(fakeOrder({ externalId: '801', createdAt: min(0), revision: min(0).toISOString(), lines: [] }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    state.upsertOrder(fakeOrder({ externalId: '801', createdAt: min(0), revision: min(5).toISOString(), channelStatus: 'on-hold', statusRank: 10, lines: [] }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(5.5) })
    await db.channelCursor.updateMany({ data: { cursor: '0' } })
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(7) }) // ta sama rewizja jeszcze raz: czas zobaczenia bez zmian
    const snap = await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: '801' } })
    expect(snap.revisionSeenAt?.toISOString()).toBe(min(5.5).toISOString())
    const [m] = await shadowMetrics(db, { since: min(-1), until: min(10) })
    expect(m!.changeLatencyMs).toEqual({ n: 1, p50: 30_000, p95: 30_000, max: 30_000 })
  })
})

describe('planowanie zadań BL tylko dla firm z BL (krok 7)', () => {
  it('firma bez tokena albo bez inventory BL nie dostaje wierszy Job dla porównania, faktur, sprzedaży dnia i raportu', async () => {
    const sys = testSystemDb()
    const orgs = new OrgClients({ connectionString: testDbUrl() })
    try {
      await sys.organization.update({ where: { id: ORG_A }, data: { settings: { baselinker: { inventoryId: '777' } } } })
      const deps: WorkerDeps = { system: sys, orgs, handlers, env: { SELFHOST_ORG_SLUG: 'test-a', BASELINKER_TOKEN: 'token-test' }, workerId: 'test' }
      const list = [
        { id: ORG_A, slug: 'test-a', name: 'A' },
        { id: ORG_B, slug: 'test-b', name: 'B' },
      ]
      await planSchedule(deps, list, HARMONOGRAM_RDZENIA, new Map(), Date.now())
      const kinds = async (org: string) => (await sys.job.findMany({ where: { organizationId: org }, select: { kind: true } })).map((j) => j.kind).sort()
      const bl = HARMONOGRAM_RDZENIA.filter((h) => h.requires === 'baselinker').map((h) => h.kind)
      expect(bl.sort()).toEqual(['cien-bl-faktury', 'cien-bl-porownanie', 'cien-raport-rozjazdow', 'cien-sprzedaz-dnia'])
      const a = await kinds(ORG_A)
      const b = await kinds(ORG_B)
      for (const k of bl) {
        expect(a).toContain(k)
        expect(b).not.toContain(k)
      }
      expect(b).toContain('rdzen-fanout')
      expect(b).toContain('cien-przeglad-otwartych')
      // firma A bez inventory BL: token sam nie wystarcza
      await sys.job.deleteMany({})
      await sys.organization.update({ where: { id: ORG_A }, data: { settings: {} } })
      await planSchedule(deps, list, HARMONOGRAM_RDZENIA, new Map(), Date.now())
      for (const k of bl) expect(await kinds(ORG_A)).not.toContain(k)
    } finally {
      await orgs.closeAll()
    }
  })
})
