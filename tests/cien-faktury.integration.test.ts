// na bazie: pętla błędów WZ daje alert, alert „bez WZ” z dniem, przeliczenie raportu za wczoraj
// po późniejszym zamknięciu sprzedaży dnia, e-book jako BEZ_STANU, WZ nieobowiązkowe.
// BL i wFirma wyłącznie atrapy, dane fikcyjne.
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { runBlComparison } from '@/lib/cien/bl-porownanie'
import { syncBlInvoices, WZ_MAX_ATTEMPTS, type WzLine, type WzOdczyt } from '@/lib/cien/faktury-bl'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { buildDailyReport, renderDailyReport, REPORT_CHECK, type DailyReport } from '@/lib/cien/raport-dzienny'
import { runDaySalesCheck, SALES_CHECK } from '@/lib/cien/sprzedaz-dnia'
import { handlers } from '@/lib/worker/zadania'
import { SourceError } from '@/lib/zrodla/http'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { FakeBl, sec } from './bl-atrapa'
import { expectInvariants, offer, product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await sys.$disconnect()
})

const T = new Date('2026-10-27T08:00:00.000Z') // wtorek 09:00 w Warszawie
const min = (n: number) => new Date(T.getTime() + n * 60_000)
const SRC = { env: {}, envFallback: false }
const MAP = { shopAccounts: ['sd'], empikAccountId: null }

class FakeWz implements WzOdczyt {
  docs = new Map<string, WzLine[]>()
  async wzForInvoice(n: string): Promise<WzLine[] | null> {
    return this.docs.get(n) ?? null
  }
}

/** wFirma odrzuca warunek (np. złe pole) przy każdym odczycie — błąd, nie „brak WZ”. */
class BrokenWz implements WzOdczyt {
  calls = 0
  async wzForInvoice(): Promise<WzLine[] | null> {
    this.calls++
    throw new SourceError('wFirma invoices/find: CONDITION_FIELD_UNKNOWN', false)
  }
}

let state: FakeChannelState
let registry: AdapterRegistry
let bl: FakeBl
let a: string

/** Zamówienie z cienia (2 szt. oferty `offerId`) połączone z BL 7001 przez porównanie. */
async function shadowOrderPairedWithBl(offerId = '10'): Promise<string> {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
  const acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
  state.upsertOrder(fakeOrder({ externalId: '501', createdAt: new Date('2026-10-27T07:00:00Z'), revision: '2026-10-27T07:00:00.000Z', totalGross: 40, lines: [{ externalLineId: '1', offerExternalId: offerId, qty: 2, unitPriceGross: 20, vatRate: '23' }] }))
  await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(-50), initialLookbackMs: 3 * 3600_000 })
  bl.orders = [
    { order_id: 7001, order_source: 'shop', order_source_id: 'sd', shop_order_id: 501, order_status_id: 2, date_add: sec('2026-10-27T07:01:00Z'), date_confirmed: sec('2026-10-27T07:01:00Z'), delivery_price: 0, products: [{ price_brutto: 20, quantity: 2 }] },
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
  a = await product(db, 'A', 20)
  await db.product.update({ where: { id: a }, data: { wfirmaGoodId: '100' } })
  await offer(db, 'WOO_SD', '10', a)
})

describe('pętla błędów WZ', () => {
  it('błąd odczytu WZ wraca: po WZ_MAX_ATTEMPTS jeden alert na fakturę (numery, bez nabywcy), faktura dalej czeka', async () => {
    const orderId = await shadowOrderPairedWithBl()
    bl.invoices = [invoice()]
    const wz = new BrokenWz()
    for (let i = 0; i < WZ_MAX_ATTEMPTS - 1; i++) await syncBlInvoices(db, bl.client(), wz, { now: min(2 * i) })
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BL_BLAD' } })).toBe(0)
    for (let i = WZ_MAX_ATTEMPTS - 1; i < WZ_MAX_ATTEMPTS + 3; i++) {
      const s = await syncBlInvoices(db, bl.client(), wz, { now: min(2 * i) })
      expect(s.errors.join(' ')).toMatch(/CONDITION_FIELD_UNKNOWN/)
    }
    expect(wz.calls).toBe(WZ_MAX_ATTEMPTS + 3)
    const alerts = await db.alert.findMany({ where: { kind: 'FAKTURA_BL_BLAD' } })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ dedupeKey: 'faktura-bl-blad:55' })
    expect(alerts[0]!.message).toContain('FV 1/10/2026')
    expect(alerts[0]!.message).toContain('7001')
    expect(alerts[0]!.message).not.toMatch(/Testowy|1234563218/)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ appliedAt: null, attempts: WZ_MAX_ATTEMPTS + 3, outcome: null })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'ACTIVE' })
  })
})

describe('alert „faktury bez WZ” z dniem', () => {
  it('alert zamknięty, problem trwa następnego dnia → nowy alert; tego samego dnia bez dubla', async () => {
    await shadowOrderPairedWithBl()
    bl.invoices = [invoice(), invoice({ invoice_id: 56, number: 'FV 2/10/2026', external_invoice_number: 'FV/2/2026' }), invoice({ invoice_id: 57, number: 'FV 3/10/2026', external_invoice_number: 'FV/3/2026' })]
    const wz = new FakeWz()
    for (let i = 0; i < WZ_MAX_ATTEMPTS + 1; i++) await syncBlInvoices(db, bl.client(), wz, { now: min(2 * i) })
    expect(await db.alert.findMany({ where: { kind: 'FAKTURY_BL_BEZ_WZ' }, select: { dedupeKey: true } })).toEqual([{ dedupeKey: 'faktury-bl-bez-wz:2026-10-27' }])
    await db.alert.updateMany({ where: { kind: 'FAKTURY_BL_BEZ_WZ' }, data: { closedAt: min(40) } })
    await syncBlInvoices(db, bl.client(), wz, { now: min(60) })
    expect(await db.alert.count({ where: { kind: 'FAKTURY_BL_BEZ_WZ' } })).toBe(1)
    // następny dzień w Warszawie (00:30 28.10 = 23:30 UTC 27.10)
    await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-10-27T23:30:00Z') })
    const all = await db.alert.findMany({ where: { kind: 'FAKTURY_BL_BEZ_WZ' }, orderBy: { createdAt: 'asc' }, select: { dedupeKey: true, closedAt: true } })
    expect(all.map((x) => x.dedupeKey)).toEqual(['faktury-bl-bez-wz:2026-10-27', 'faktury-bl-bez-wz:2026-10-28'])
    expect(all[1]!.closedAt).toBeNull()
    expect(await db.pendingMovement.count()).toBe(0)
  })
})

describe('e-book jako BEZ_STANU', () => {
  it('faktura zamówienia z samym e-bookiem → BEZ_STANU i stats.digitalOnly, nie NIC_DO_ROZLICZENIA; raport pokazuje osobno', async () => {
    const ebook = (await db.product.create({ data: { sku: 'EBOOK-1', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book testowy', title: 'E-book testowy', vatRate: '5' } })).id
    await offer(db, 'WOO_SD', '20', ebook)
    const orderId = await shadowOrderPairedWithBl('20')
    expect(await db.reservation.count({ where: { orderId } })).toBe(0)
    bl.invoices = [invoice()]
    const s = await syncBlInvoices(db, bl.client(), new FakeWz(), { now: T })
    expect(s).toMatchObject({ digitalOnly: 1, nothingToConsume: 0, applied: 0, errors: [] })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'BEZ_STANU', orderId })
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await stockOf(db, a)).toMatchObject({ physical: 20, reserved: 0 })
    // anulowane zamówienie towaru ze stanem dalej idzie jako „nic do rozliczenia”
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 40, blOrderId: 7001, number: 'FV 0/10/2026', kind: 'normal', dateAdd: min(-30), fetchedAt: min(-30) } })
    await db.order.update({ where: { id: orderId }, data: { status: 'ANULOWANE' } })
    expect(await syncBlInvoices(db, bl.client(), new FakeWz(), { now: min(2) })).toMatchObject({ digitalOnly: 0, nothingToConsume: 1 })
    const r = await buildDailyReport(db, '2026-10-27', min(10))
    expect(r.invoices).toMatchObject({ digitalOnly: 1, nothingToConsume: 1 })
    expect(renderDailyReport(r)).toContain('bez stanu (same e-booki) 1, nic do zdjęcia ze stanu (anulowane, pominięte) 1')
    await expectInvariants(db)
  })
})

describe('WZ nieobowiązkowe (ustawienie firmy cien.wzOptional)', () => {
  it('flaga włączona: faktura bez WZ od razu BEZ_WZ (także bez kluczy wFirmy); wyłączona: czeka', async () => {
    const orderId = await shadowOrderPairedWithBl()
    bl.invoices = [invoice()]
    expect(await syncBlInvoices(db, bl.client(), null, { now: T })).toMatchObject({ waitingNoWfirma: 1, withoutWz: 0 })
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { cien: { wzOptional: true } } } })
    expect(await syncBlInvoices(db, bl.client(), null, { now: min(2) })).toMatchObject({ waitingNoWfirma: 0, withoutWz: 1, errors: [] })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'BEZ_WZ', attempts: 0 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ type: 'BL_INVOICE', state: 'MANUAL', wzQty: 0 })
    expect(await db.alert.count({ where: { kind: 'FAKTURY_BL_BEZ_WZ' } })).toBe(0)
    await expectInvariants(db)
  })

  it('flaga włączona i wFirma bez WZ: pierwszy przebieg BEZ_WZ, bez czekania i bez bezpiecznika', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { cien: { wzOptional: true } } } })
    await shadowOrderPairedWithBl()
    bl.invoices = [invoice()]
    expect(await syncBlInvoices(db, bl.client(), new FakeWz(), { now: T })).toMatchObject({ withoutWz: 1, waitingForWz: 0 })
  })
})

describe('raport za wczoraj przeliczany po późniejszym zamknięciu sprzedaży dnia', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('raport z 3 h po północy bez sprzedaży → po zamknięciu sprzedaży przeliczony raz; potem bez zmian', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rozjazdy-'))
    const run = async (iso: string) => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) })
      try {
        await handlers['cien-raport-rozjazdow']!(db, null, { organizationId: ORG_A, secrets: { env: { RAPORTY_DIR: dir }, envFallback: false } })
      } finally {
        vi.useRealTimers()
      }
    }
    const report = async () => db.shadowDailyCheck.findFirst({ where: { kind: REPORT_CHECK, day: '2026-10-27' } })
    // 28.10 01:30 w Warszawie: sprzedaż niezamknięta, przed progiem 3 h — nic
    await run('2026-10-28T00:30:00Z')
    expect(await report()).toBeNull()
    // 03:30: bez sprzedaży dnia (np. błąd BL) — raport z `sales: null`
    await run('2026-10-28T02:30:00Z')
    const first = await report()
    expect((first!.stats as unknown as DailyReport).sales).toBeNull()
    expect(first!.ok).toBe(false)
    // kolejny termin przed zamknięciem sprzedaży: bez przeliczenia
    await run('2026-10-28T03:30:00Z')
    expect((await report())!.checkedAt).toEqual(first!.checkedAt)
    // sprzedaż dnia zamyka się później (ponowienie co godzinę)
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: new Date('2026-10-28T04:10:00Z') })
    expect(await db.shadowDailyCheck.count({ where: { kind: SALES_CHECK, day: '2026-10-27', final: true } })).toBe(1)
    await run('2026-10-28T04:30:00Z')
    const second = await report()
    expect((second!.stats as unknown as DailyReport).sales).not.toBeNull()
    expect(second!.checkedAt.getTime()).toBeGreaterThan(first!.checkedAt.getTime())
    expect(await readFile(path.join(dir, 'rozjazdy', ORG_A, 'rozjazdy-2026-10-27.md'), 'utf8')).not.toContain('Brak sprawdzenia sprzedaży dnia')
    // raport ze sprzedażą nie przelicza się w kolejnych terminach
    await run('2026-10-28T05:30:00Z')
    expect((await report())!.checkedAt).toEqual(second!.checkedAt)
    expect(await db.shadowDailyCheck.count({ where: { kind: REPORT_CHECK } })).toBe(1)
  })

  it('dzień z błędem BL: raport z niepełną sprzedażą (`final: false`) też przelicza się po zamknięciu', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rozjazdy-'))
    const run = async (iso: string) => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) })
      try {
        await handlers['cien-raport-rozjazdow']!(db, null, { organizationId: ORG_A, secrets: { env: { RAPORTY_DIR: dir }, envFallback: false } })
      } finally {
        vi.useRealTimers()
      }
    }
    const report = async () => db.shadowDailyCheck.findFirst({ where: { kind: REPORT_CHECK, day: '2026-10-27' } })
    // po północy BL nie odpowiada: wiersz sprzedaży jest, ale dzień zostaje otwarty
    bl.failNext = 'getOrders'
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: new Date('2026-10-27T23:40:00Z') })
    await run('2026-10-28T02:30:00Z')
    const first = await report()
    expect((first!.stats as unknown as DailyReport).sales).toMatchObject({ final: false, blComplete: false })
    await run('2026-10-28T03:30:00Z')
    expect((await report())!.checkedAt).toEqual(first!.checkedAt)
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: new Date('2026-10-28T04:10:00Z') })
    await run('2026-10-28T04:30:00Z')
    const second = await report()
    expect((second!.stats as unknown as DailyReport).sales).toMatchObject({ final: true, blComplete: true })
    expect(second!.checkedAt.getTime()).toBeGreaterThan(first!.checkedAt.getTime())
    await run('2026-10-28T05:30:00Z')
    expect((await report())!.checkedAt).toEqual(second!.checkedAt)
  })
})
