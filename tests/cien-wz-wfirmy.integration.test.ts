// na bazie: WZ z wFirmy w cieniu (faktura sprzed startu odczytu faktur BL, zamówienie bez pary z BL, brak
// zamieniony na wydanie), para zamówienia od strony faktury BL (WOO 900007 = BL 900000007 z raportu 04.11) i raport
// rozjazdów z WZ jako ruchem z dokumentem. WZ to nagrane odpowiedzi wFirmy (tests/nagrania/wfirma-wz, bez danych
// nabywcy); BL i kanał to atrapy, dane fikcyjne.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { runBlComparison, type BlOrderHeader } from '@/lib/cien/bl-porownanie'
import { syncBlInvoices, type WzLine, type WzOdczyt } from '@/lib/cien/faktury-bl'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { parseWz, syncWfirmaWz, type WzDokument, type WzZrodlo } from '@/lib/cien/wz-wfirmy'
import { wfirmaItems } from '@/lib/zrodla/wfirma'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { testDb, truncateAll } from './db'
import { FakeBl, sec } from './bl-atrapa'
import { expectInvariants, offer, product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const NAGRANIA = path.join(__dirname, 'nagrania', 'wfirma-wz')
const nagranie = (f: string) => JSON.parse(readFileSync(path.join(NAGRANIA, f), 'utf8')) as Record<string, unknown>
/** Wszystkie nagrane WZ (lista od 24.10, wybrane dokumenty z raportu 04.11). */
const NAGRANE_WZ: WzDokument[] = wfirmaItems<Record<string, unknown>>(nagranie('wz-lista-od-2026-10-24-wybrane.json')['warehouse_documents'], 'warehouse_document').map((d) => parseWz(d)!)
const wzNr = (n: string) => NAGRANE_WZ.find((d) => d.numer === n)!
/** Numery faktur nagranych WZ (id faktury wFirmy → pełny numer), z odpowiedzi `invoices/get`. */
const FAKTURY: Record<string, string> = {
  '900000091': 'SD 112/27/10/26',
  '900000098': 'SD 115/27/10/26',
  '900000252': 'SD 154/4/11/26',
  '900000189': 'SD 130/4/11/26',
  '900000217': 'SD 142/4/11/26',
}

class FakeWzZrodlo implements WzZrodlo {
  docs: WzDokument[] = []
  calls: string[] = []
  async wzOd(od: string, magazyn: string | null) {
    this.calls.push(`wzOd ${od} ${magazyn}`)
    return { docs: this.docs.filter((d) => d.data >= od && (!magazyn || !d.magazyn || d.magazyn === magazyn)), complete: true, errors: [] }
  }
  async numeryFaktur(od: string, doDnia: string) {
    this.calls.push(`numeryFaktur ${od} ${doDnia}`)
    return new Map(Object.entries(FAKTURY))
  }
  async numerFaktury(id: string) {
    this.calls.push(`numerFaktury ${id}`)
    return FAKTURY[id] ?? null
  }
}

class FakeWz implements WzOdczyt {
  docs = new Map<string, WzLine[]>()
  async wzForInvoice(n: string): Promise<WzLine[] | null> {
    return this.docs.get(n) ?? null
  }
}

const SRC = { env: {}, envFallback: false }
const MAP = { shopAccounts: ['sd'], empikAccountId: null }
let state: FakeChannelState
let registry: AdapterRegistry
let bl: FakeBl
let src: FakeWzZrodlo

async function sd() {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
  return (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
}

/** Zamówienie WOO z cienia: `qty` szt. oferty `offerId`, złożone `createdAt`, odczyt cienia o `seenAt`. */
async function shadowOrder(externalId: string, offerId: string, qty: number, createdAt: Date, seenAt: Date): Promise<string> {
  state.upsertOrder(fakeOrder({ externalId, createdAt, revision: createdAt.toISOString(), totalGross: 20 * qty, lines: [{ externalLineId: '1', offerExternalId: offerId, qty, unitPriceGross: 20, vatRate: '23' }] }))
  await pollAccount(db, await sd(), { registry, secrets: SRC, now: () => seenAt, initialLookbackMs: 10 * 24 * 3600_000 })
  return (await db.order.findFirstOrThrow({ where: { externalId } })).id
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  // magazyn lustra jak w nagraniach (warehouse.id WZ)
  await db.warehouse.updateMany({ where: { id: DEFAULT_WAREHOUSE }, data: { wfirmaWarehouseId: '900014' } })
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
  bl = new FakeBl()
  src = new FakeWzZrodlo()
})

describe('WZ z wFirmy: faktura sprzed startu odczytu faktur BL', () => {
  it('WZ 154/4/11/26 (90001 ×1): zamówienie bez faktury w kopii BL rozliczone po pozycjach — rezerwacja zużyta, ruch z numerem faktury, alert do sprawdzenia; powtórka bez dubli', async () => {
    const p = await product(db, '90001', 19, { wfirmaGoodId: '90000021' })
    await offer(db, 'WOO_SD', '10', p)
    const orderId = await shadowOrder('9001', '10', 1, new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T10:05:00Z'))
    expect(await stockOf(db, p)).toMatchObject({ physical: 19, reserved: 1 })
    src.docs = [wzNr('WZ 154/4/11/26')]
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z') })
    expect(s).toMatchObject({ read: 1, settled: 1, errors: [] })
    expect(await db.reservation.findMany({ where: { orderId } })).toEqual([expect.objectContaining({ state: 'CONSUMED', qtyBase: 1 })])
    expect(await db.pendingMovement.findMany({ where: { orderId } })).toEqual([expect.objectContaining({ type: 'BL_INVOICE', delta: -1, wzQty: 1, wfirmaDocId: 'SD 154/4/11/26' })])
    const snap = await db.wfirmaWzSnapshot.findFirstOrThrow()
    expect(snap).toMatchObject({ number: 'WZ 154/4/11/26', invoiceNumber: 'SD 154/4/11/26', outcome: 'ROZLICZONA', linkedBy: 'POZYCJE', orderId, docDate: '2026-11-04' })
    expect(snap.createdInWfirma.toISOString()).toBe('2026-11-04T12:29:32.000Z') // 13:29:32 w Warszawie
    expect(await db.alert.count({ where: { kind: 'WZ_PO_POZYCJACH' } })).toBe(1)
    expect(await db.orderEvent.count({ where: { orderId, kind: 'WZ_WFIRMY' } })).toBe(1)
    await expectInvariants(db)
    // kolejny przebieg: WZ rozliczony, nic nie dubluje
    const s2 = await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:30:00Z') })
    expect(s2.settled).toBe(0)
    expect(await db.pendingMovement.count()).toBe(1)
    // późniejsza faktura BL tego zamówienia nie zdejmuje drugi raz
    await db.order.update({ where: { id: orderId }, data: { blOrderId: 7101 } })
    bl.invoices = [{ invoice_id: 81, order_id: 7101, number: 'SD 154/4/11/26', type: 'normal', date_add: sec('2026-11-04T12:29:00Z') }]
    const wz = new FakeWz()
    wz.docs.set('SD 154/4/11/26', [{ wfirmaGoodId: '90000021', count: 1 }])
    const inv = await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-11-04T14:00:00Z') })
    expect(inv).toMatchObject({ nothingToConsume: 1, applied: 0 })
    expect(await db.pendingMovement.count()).toBe(1)
    await expectInvariants(db)
  })

  it('WZ z opłaconym brakiem (90004: stan 0, zamówienie 1 szt. w braku): brak dostaje rezerwację i rozliczenie, zamówienie bez flagi braku', async () => {
    const p = await product(db, '90004', 0, { wfirmaGoodId: '90000175' })
    await offer(db, 'WOO_SD', '11', p)
    const orderId = await shadowOrder('9002', '11', 1, new Date('2026-11-03T18:00:00Z'), new Date('2026-11-03T18:05:00Z'))
    expect(await db.shortage.count({ where: { orderId, state: 'OPEN' } })).toBe(1)
    // WZ 172/3/11/26 ma też inne towary spoza katalogu → po pozycjach nie wiążemy; tu WZ jednego towaru (ten sam kształt)
    const one: WzDokument = { ...wzNr('WZ 172/3/11/26'), pozycje: [{ wfirmaGoodId: '90000175', count: 1 }], invoiceId: null }
    src.docs = [one]
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-11-03T21:00:00Z') })
    expect(s).toMatchObject({ settled: 1, errors: [] })
    expect(await db.shortage.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'RESOLVED', resolvedBy: 'system:wz-wfirmy' })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONSUMED', qtyBase: 1 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).flags).not.toMatchObject({ brakuje: true })
    expect((await stockOf(db, p)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('magazyn prowadzony przez Kompletor: WZ z wFirmy nie są czytane', async () => {
    await db.warehouse.updateMany({ where: { id: DEFAULT_WAREHOUSE }, data: { stockSource: 'KOMPLETOR' } })
    src.docs = [wzNr('WZ 154/4/11/26')]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z') })).toMatchObject({ read: 0 })
    expect(src.calls).toEqual([])
  })

  it('WZ z towarem spoza katalogu nie wiąże się po pozycjach (POZA_KATALOGIEM), dwa identyczne zamówienia → NIEJEDNOZNACZNE; nic nie zużyte', async () => {
    const p = await product(db, '90004', 5, { wfirmaGoodId: '90000175' })
    await offer(db, 'WOO_SD', '11', p)
    await shadowOrder('9003', '11', 1, new Date('2026-11-03T10:00:00Z'), new Date('2026-11-03T10:05:00Z'))
    await shadowOrder('9004', '11', 1, new Date('2026-11-03T11:00:00Z'), new Date('2026-11-03T11:05:00Z'))
    // bez faktury (invoiceId null) — WZ z fakturą bez znanego numeru czekałby na numer, nie na pozycje
    src.docs = [{ ...wzNr('WZ 172/3/11/26'), invoiceId: null }, { ...wzNr('WZ 172/3/11/26'), docId: 'x-1', numer: 'WZ 187/3/11/26', invoiceId: null, pozycje: [{ wfirmaGoodId: '90000175', count: 1 }] }]
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-11-03T21:00:00Z') })
    expect(s).toMatchObject({ outsideCatalog: 1, ambiguous: 1, settled: 0 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow({ where: { number: 'WZ 187/3/11/26' } })).toMatchObject({ outcome: 'NIEJEDNOZNACZNE', candidates: 2, orderId: null })
    expect(await db.reservation.count({ where: { state: 'ACTIVE' } })).toBe(2)
  })

  it('WZ do faktury, która czeka w kopii faktur BL: bez drugiego rozliczenia; po rozliczeniu faktury BL → JUZ_ROZLICZONA', async () => {
    const p = await product(db, '90002', 17, { wfirmaGoodId: '90000077' })
    await offer(db, 'WOO_SD', '12', p)
    const orderId = await shadowOrder('9005', '12', 1, new Date('2026-11-04T09:00:00Z'), new Date('2026-11-04T09:05:00Z'))
    await db.order.update({ where: { id: orderId }, data: { blOrderId: 7105 } })
    bl.invoices = [{ invoice_id: 90, order_id: 7105, number: 'SD 142/4/11/26', type: 'normal', date_add: sec('2026-11-04T11:51:00Z') }]
    const wz = new FakeWz()
    await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-11-04T11:55:00Z') }) // WZ jeszcze nie ma: faktura czeka
    src.docs = [{ ...wzNr('WZ 142/4/11/26'), pozycje: [{ wfirmaGoodId: '90000077', count: 1 }] }]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T12:00:00Z') })).toMatchObject({ waitingForBlInvoice: 1, settled: 0 })
    wz.docs.set('SD 142/4/11/26', [{ wfirmaGoodId: '90000077', count: 1 }])
    expect(await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-11-04T12:02:00Z') })).toMatchObject({ applied: 1 })
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T12:30:00Z') })).toMatchObject({ alreadySettled: 1, settled: 0 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'JUZ_ROZLICZONA', orderId })
    expect(await db.pendingMovement.count()).toBe(1)
    await expectInvariants(db)
  })
})

describe('para zamówienia od strony faktury BL (WOO 900007 = BL 900000007)', () => {
  /** Zamówienie złożone przed oknem porównania z BL: porównanie go nie paruje (kształt z raportu 04.11). */
  async function oldUnpairedOrder(): Promise<{ orderId: string; p: string }> {
    const p = await product(db, '90003', 24, { wfirmaGoodId: '90000105' })
    await offer(db, 'WOO_SD', '13', p)
    const orderId = await shadowOrder('900007', '13', 15, new Date('2026-10-24T14:35:52Z'), new Date('2026-10-27T08:45:00Z'))
    bl.orders = [{ order_id: 900000007, order_source: 'shop', order_source_id: 'sd', shop_order_id: 900007, order_status_id: 2, date_add: sec('2026-10-24T14:40:00Z'), date_confirmed: sec('2026-10-24T14:40:00Z'), delivery_price: 0, products: [{ price_brutto: 3.6, quantity: 15 }] }]
    await runBlComparison(db, bl.client(), MAP, await accountsForComparison(db), { now: new Date('2026-10-27T09:00:00Z'), windowMs: 24 * 3600_000, graceMs: 0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBeNull()
    return { orderId, p }
  }
  const header = (): BlOrderHeader => ({ blOrderId: 900000007, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: '900007', statusId: 2, deliveryMethod: null, paymentDone: null, totalGross: 54, confirmed: true, dateAdd: new Date('2026-10-24T14:40:00Z'), dateConfirmed: null })

  it('faktura BL bez naszego zamówienia: para z odczytu zamówienia BL po numerze, faktura rozliczona z WZ (14 + 1 szt.)', async () => {
    const { orderId, p } = await oldUnpairedOrder()
    bl.invoices = [{ invoice_id: 70, order_id: 900000007, number: 'SD 112/27/10/26', type: 'normal', date_add: sec('2026-10-27T09:44:55Z') }]
    const wz = new FakeWz()
    wz.docs.set('SD 112/27/10/26', wzNr('WZ 112/27/10/26').pozycje)
    const fetched: number[] = []
    const s = await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-10-27T10:00:00Z'), initialLookbackMs: 24 * 3600_000, fetchBlOrder: async (id) => (fetched.push(id), header()) })
    expect(s).toMatchObject({ pairedFromInvoice: 1, applied: 1, errors: [] })
    expect(fetched).toEqual([900000007])
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(900000007)
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONSUMED', qtyBase: 15 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ type: 'BL_INVOICE', delta: -15, wzQty: 15, wfirmaDocId: 'SD 112/27/10/26' })
    expect((await stockOf(db, p)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('faktura już POZA_CIENIEM (po 3 dniach bez pary) wraca do rozliczenia, gdy para się znajdzie; bez odczytu BL drugi raz po nieudanej próbie', async () => {
    const { orderId } = await oldUnpairedOrder()
    bl.invoices = [{ invoice_id: 70, order_id: 900000007, number: 'SD 112/27/10/26', type: 'normal', date_add: sec('2026-10-27T09:44:55Z') }]
    const wz = new FakeWz()
    wz.docs.set('SD 112/27/10/26', wzNr('WZ 112/27/10/26').pozycje)
    await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-10-31T10:00:00Z'), initialLookbackMs: 5 * 24 * 3600_000 })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'POZA_CIENIEM' })
    // BL nie zna zamówienia w kanałach cienia: znacznik na fakturze, bez ponownego odczytu w kolejnym przebiegu
    let calls = 0
    await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-10-31T10:02:00Z'), fetchBlOrder: async () => (calls++, null) })
    await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-10-31T10:04:00Z'), fetchBlOrder: async () => (calls++, null) })
    expect(calls).toBe(1)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'POZA_CIENIEM' })
    // później kopia zamówienia BL się pojawia (np. odświeżenie porównania): para z niej, bez odczytu BL
    await db.blOrderSnapshot.create({ data: { blOrderId: 900000007, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: '900007', statusId: 2, dateAdd: new Date('2026-10-24T14:40:00Z'), fetchedAt: new Date('2026-10-31T10:05:00Z') } })
    const s = await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-10-31T10:06:00Z') })
    expect(s).toMatchObject({ pairedFromInvoice: 1, applied: 1 })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'ZASTOSOWANA', orderId })
    await expectInvariants(db)
  })

  it('WZ do faktury BL zamówienia bez pary: WZ czeka na parę (nic nie zużyte, bez pary z ilości); para po tożsamości rozlicza fakturę, WZ → JUZ_ROZLICZONA', async () => {
    const { orderId } = await oldUnpairedOrder()
    bl.invoices = [{ invoice_id: 70, order_id: 900000007, number: 'SD 112/27/10/26', type: 'normal', date_add: sec('2026-10-27T09:44:55Z') }]
    await syncBlInvoices(db, bl.client(), null, { now: new Date('2026-10-31T10:00:00Z'), initialLookbackMs: 5 * 24 * 3600_000 })
    src.docs = [wzNr('WZ 112/27/10/26')]
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-10-31T11:00:00Z'), od: '2026-10-24' })
    expect(s).toMatchObject({ settled: 0, waitingForPair: 1, errors: [] })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBeNull()
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'CZEKA_NA_PARE', orderId: null, linkedBy: null, invoiceNumber: 'SD 112/27/10/26' })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'ACTIVE', qtyBase: 15 })
    // para po tożsamości (numer w sklepie z zamówienia BL), faktura wraca z POZA_CIENIEM i rozlicza się z WZ
    const wz = new FakeWz()
    wz.docs.set('SD 112/27/10/26', wzNr('WZ 112/27/10/26').pozycje)
    expect(await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-10-31T11:10:00Z'), fetchBlOrder: async () => header() })).toMatchObject({ pairedFromInvoice: 1, applied: 1 })
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-10-31T11:30:00Z') })).toMatchObject({ alreadySettled: 1, settled: 0 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'JUZ_ROZLICZONA', orderId })
    expect(await db.pendingMovement.count({ where: { orderId } })).toBe(1)
    await expectInvariants(db)
  })
})

describe('faktura obcego zamówienia BL nie rozlicza naszego zamówienia po ilościach', () => {
  it('opłacone zamówienie SD 1 szt. X czeka (rezerwacja), drugie 1 szt. Y w braku; WZ do faktur BL obcych zamówień z tymi samymi ilościami → nic nie zużyte, brak OPEN, para nie zapisana; po nieudanej próbie pary → POZA_CIENIEM', async () => {
    const x = await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    const y = await product(db, '90004', 0, { wfirmaGoodId: '90000175' })
    await offer(db, 'WOO_SD', '20', x)
    await offer(db, 'WOO_SD', '21', y)
    const ox = await shadowOrder('9101', '20', 1, new Date('2026-11-04T08:00:00Z'), new Date('2026-11-04T08:05:00Z'))
    const oy = await shadowOrder('9102', '21', 1, new Date('2026-11-04T08:10:00Z'), new Date('2026-11-04T08:15:00Z'))
    expect(await db.shortage.count({ where: { orderId: oy, state: 'OPEN' } })).toBe(1)
    // faktury BL zamówień spoza cienia (np. inny sklep w BL): kopia jest, zamówienia BL u nas nie ma
    bl.invoices = [
      { invoice_id: 95, order_id: 8800001, number: 'SD 154/4/11/26', type: 'normal', date_add: sec('2026-11-04T12:29:00Z') },
      { invoice_id: 96, order_id: 8800002, number: 'SD 130/4/11/26', type: 'normal', date_add: sec('2026-11-04T12:30:00Z') },
    ]
    await syncBlInvoices(db, bl.client(), null, { now: new Date('2026-11-04T12:35:00Z'), initialLookbackMs: 24 * 3600_000 })
    src.docs = [wzNr('WZ 154/4/11/26'), { ...wzNr('WZ 130/4/11/26'), pozycje: [{ wfirmaGoodId: '90000175', count: 1 }] }]
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z') })
    expect(s).toMatchObject({ settled: 0, waitingForPair: 2, errors: [] })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: ox } })).toMatchObject({ state: 'ACTIVE', qtyBase: 1 })
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: oy } })).toMatchObject({ state: 'OPEN' })
    for (const id of [ox, oy]) expect((await db.order.findUniqueOrThrow({ where: { id } })).blOrderId).toBeNull()
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await db.alert.count({ where: { kind: 'WZ_PO_POZYCJACH' } })).toBe(0)
    // BL nie zna tych zamówień w kanałach cienia: znacznik na fakturach → WZ POZA_CIENIEM (bez alertu biura)
    await syncBlInvoices(db, bl.client(), null, { now: new Date('2026-11-04T13:05:00Z'), fetchBlOrder: async () => null })
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-06T13:00:00Z') })).toMatchObject({ outsideShadow: 2, settled: 0, unresolvedOld: 0 })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: ox } })).toMatchObject({ state: 'ACTIVE' })
    expect(await db.alert.count({ where: { kind: 'WZ_NIEROZSTRZYGNIETE' } })).toBe(0)
    await expectInvariants(db)
  })

  it('WZ bez kopii faktury: zamówienie nieopłacone albo do wyjaśnienia nie jest kandydatem po pozycjach (BEZ_ZAMOWIENIA)', async () => {
    const p = await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    await offer(db, 'WOO_SD', '22', p)
    const o = await shadowOrder('9103', '22', 1, new Date('2026-11-04T08:00:00Z'), new Date('2026-11-04T08:05:00Z'))
    await db.order.update({ where: { id: o }, data: { paymentState: 'UNPAID' } })
    src.docs = [wzNr('WZ 154/4/11/26')]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z') })).toMatchObject({ withoutOrder: 1, settled: 0 })
    await db.order.update({ where: { id: o }, data: { paymentState: 'PAID', status: 'DO_WYJASNIENIA' } })
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:30:00Z') })).toMatchObject({ withoutOrder: 1, settled: 0 })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: o } })).toMatchObject({ state: 'ACTIVE' })
  })
})

describe('WZ nierozstrzygnięte dłużej niż doba → alert biura raz na dobę', () => {
  it('WZ bez zamówienia po 24 h: jeden alert z numerem dokumentu; kolejny przebieg tego dnia bez drugiego alertu', async () => {
    await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    src.docs = [wzNr('WZ 154/4/11/26')]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z') })).toMatchObject({ withoutOrder: 1, unresolvedOld: 0 })
    expect(await db.alert.count({ where: { kind: 'WZ_NIEROZSTRZYGNIETE' } })).toBe(0)
    // dokładnie 24 h od pierwszego odczytu: jeszcze nie (próg „dłużej niż”)
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-05T13:00:00Z') })).toMatchObject({ unresolvedOld: 0 })
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-11-05T13:05:00Z') })
    expect(s).toMatchObject({ unresolvedOld: 1, errors: [] })
    const a = await db.alert.findMany({ where: { kind: 'WZ_NIEROZSTRZYGNIETE' } })
    expect(a).toHaveLength(1)
    expect(a[0]!.message).toContain('WZ 154/4/11/26')
    await syncWfirmaWz(db, src, { now: new Date('2026-11-05T13:30:00Z') })
    expect(await db.alert.count({ where: { kind: 'WZ_NIEROZSTRZYGNIETE' } })).toBe(1)
  })
})

describe('wiek alertu od pierwszego odczytu WZ, nie od założenia w wFirmie', () => {
  it('pierwszy odczyt 5 dni po założeniu WZ: bez alertu od razu; alert dopiero po dobie od odczytu', async () => {
    await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    src.docs = [wzNr('WZ 154/4/11/26')] // założony 04.11 12:29 UTC
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-09T13:00:00Z') })).toMatchObject({ withoutOrder: 1, unresolvedOld: 0 })
    expect(await db.alert.count({ where: { kind: 'WZ_NIEROZSTRZYGNIETE' } })).toBe(0)
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-09T20:00:00Z') })).toMatchObject({ unresolvedOld: 0 })
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-10T13:30:00Z') })).toMatchObject({ unresolvedOld: 1 })
    expect(await db.alert.count({ where: { kind: 'WZ_NIEROZSTRZYGNIETE' } })).toBe(1)
  })
})

describe('świeża faktura z wFirmy bez kopii faktur BL czeka, zanim zwiążemy po pozycjach', () => {
  it('WZ z fakturą, kopii BL brak, założony minutę temu → CZEKA_NA_FAKTURE_BL (rezerwacja ACTIVE); po 15 min ponowna próba z kopii wiąże po pozycjach', async () => {
    const p = await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    await offer(db, 'WOO_SD', '30', p)
    const orderId = await shadowOrder('9201', '30', 1, new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T10:05:00Z'))
    src.docs = [wzNr('WZ 154/4/11/26')] // założony 04.11 12:29:32 UTC, faktura SD 154/4/11/26
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-11-04T12:30:32Z') })
    expect(s).toMatchObject({ waitingForBlInvoice: 1, settled: 0, withoutOrder: 0, errors: [] })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'CZEKA_NA_FAKTURE_BL', orderId: null, linkedBy: null, invoiceNumber: 'SD 154/4/11/26' })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'ACTIVE' })
    expect(await db.pendingMovement.count()).toBe(0)
    // po oknie, bez kopii faktury BL: faktura ręczna biura → pozycje (ponowna próba z kopii WZ, bez wFirmy)
    src.docs = []
    const s2 = await syncWfirmaWz(db, src, { now: new Date('2026-11-04T12:50:00Z') })
    expect(s2).toMatchObject({ settled: 1, waitingForBlInvoice: 0 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'ROZLICZONA', linkedBy: 'POZYCJE', orderId })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONSUMED' })
    await expectInvariants(db)
  })

  it('WZ bez faktury (invoiceId null) świeży: bez czekania, od razu pozycje', async () => {
    const p = await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    await offer(db, 'WOO_SD', '31', p)
    const orderId = await shadowOrder('9202', '31', 1, new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T10:05:00Z'))
    src.docs = [{ ...wzNr('WZ 154/4/11/26'), invoiceId: null }]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T12:30:32Z') })).toMatchObject({ settled: 1, waitingForBlInvoice: 0 })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONSUMED' })
  })
})

describe('kopia faktury BL bez typu (kind NULL) wiąże WZ po fakturze', () => {
  it('kopia z kind NULL czekająca w torze faktur BL: WZ → CZEKA_NA_FAKTURE_BL z naszym zamówieniem, nie pozycje', async () => {
    const p = await product(db, '90002', 17, { wfirmaGoodId: '90000077' })
    await offer(db, 'WOO_SD', '12', p)
    const orderId = await shadowOrder('9005', '12', 1, new Date('2026-11-04T09:00:00Z'), new Date('2026-11-04T09:05:00Z'))
    await db.order.update({ where: { id: orderId }, data: { blOrderId: 7105 } })
    bl.invoices = [{ invoice_id: 90, order_id: 7105, number: 'SD 142/4/11/26', type: 'normal', date_add: sec('2026-11-04T11:51:00Z') }]
    await syncBlInvoices(db, bl.client(), new FakeWz(), { now: new Date('2026-11-04T11:55:00Z') })
    await db.blInvoiceSnapshot.updateMany({ data: { kind: null } })
    src.docs = [{ ...wzNr('WZ 142/4/11/26'), pozycje: [{ wfirmaGoodId: '90000077', count: 1 }] }]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z') })).toMatchObject({ waitingForBlInvoice: 1, settled: 0 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'CZEKA_NA_FAKTURE_BL', orderId, linkedBy: 'FAKTURA' })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'ACTIVE' })
  })

  it('korekta (kind correcting) nadal nie wiąże', async () => {
    const p = await product(db, '90002', 17, { wfirmaGoodId: '90000077' })
    await offer(db, 'WOO_SD', '12', p)
    const orderId = await shadowOrder('9006', '12', 1, new Date('2026-11-04T09:00:00Z'), new Date('2026-11-04T09:05:00Z'))
    await db.order.update({ where: { id: orderId }, data: { blOrderId: 7106 } })
    bl.invoices = [{ invoice_id: 91, order_id: 7106, number: 'SD 142/4/11/26', type: 'correcting', date_add: sec('2026-11-04T11:51:00Z') }]
    await syncBlInvoices(db, bl.client(), new FakeWz(), { now: new Date('2026-11-04T11:55:00Z') })
    src.docs = [{ ...wzNr('WZ 142/4/11/26'), pozycje: [{ wfirmaGoodId: '90000077', count: 1 }] }]
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z') })
    expect(s.waitingForBlInvoice).toBe(0)
    expect((await db.wfirmaWzSnapshot.findFirstOrThrow()).linkedBy).not.toBe('FAKTURA')
  })
})

describe('jednorazowe douczytanie faktur BL sprzed pierwszego odczytu', () => {
  it('faktura z 27.10 sprzed kopii (start odczytu 01.11) dopisana raz; WOO 900007 rozlicza się po tożsamości; powtórka bez odczytu wstecz', async () => {
    const p = await product(db, '90003', 24, { wfirmaGoodId: '90000105' })
    await offer(db, 'WOO_SD', '13', p)
    const orderId = await shadowOrder('900007', '13', 15, new Date('2026-10-24T14:35:52Z'), new Date('2026-10-27T08:45:00Z'))
    const h: BlOrderHeader = { blOrderId: 900000007, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: '900007', statusId: 2, deliveryMethod: null, paymentDone: null, totalGross: 54, confirmed: true, dateAdd: new Date('2026-10-24T14:40:00Z'), dateConfirmed: null }
    const wz = new FakeWz()
    wz.docs.set('SD 112/27/10/26', wzNr('WZ 112/27/10/26').pozycje)
    // pierwszy odczyt faktur 01.11 z oknem doby: faktury z 27.10 nie widzi
    bl.invoices = [
      { invoice_id: 70, order_id: 900000007, number: 'SD 112/27/10/26', type: 'normal', date_add: sec('2026-10-27T09:44:55Z') },
      { invoice_id: 200, order_id: 8800003, number: 'SD 103/1/11/26', type: 'normal', date_add: sec('2026-11-01T09:00:00Z') },
    ]
    await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-11-01T10:00:00Z'), initialLookbackMs: 24 * 3600_000, backfillDays: 14 })
    expect(await db.blInvoiceSnapshot.count()).toBe(1)
    // drugi przebieg: douczytanie wstecz dopisuje 70, para po tożsamości, faktura rozliczona z WZ
    const fetchBlOrder = async (id: number) => (id === 900000007 ? h : null)
    const s = await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-11-01T10:02:00Z'), backfillDays: 14, fetchBlOrder })
    expect(s).toMatchObject({ backfilled: 1, pairedFromInvoice: 1, applied: 1, errors: [] })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONSUMED', qtyBase: 15 })
    expect(JSON.stringify((await db.organization.findFirstOrThrow()).settings)).toContain('fakturyBlWstecz')
    // znacznik: kolejny przebieg nie czyta wstecz (gdyby czytał, ta faktura zostałaby dopisana)
    bl.invoices.push({ invoice_id: 60, order_id: 8800004, number: 'SD 127/26/10/26', type: 'normal', date_add: sec('2026-10-26T16:18:00Z') })
    const s2 = await syncBlInvoices(db, bl.client(), wz, { now: new Date('2026-11-01T10:04:00Z'), backfillDays: 14, fetchBlOrder })
    expect(s2.backfilled).toBeUndefined()
    expect(await db.blInvoiceSnapshot.count({ where: { blInvoiceId: 60 } })).toBe(0)
    await expectInvariants(db)
  })

  it('wyłączone (backfillDays 0): bez odczytu wstecz', async () => {
    bl.invoices = [
      { invoice_id: 70, order_id: 8800005, number: 'SD 112/27/10/26', type: 'normal', date_add: sec('2026-10-27T09:44:55Z') },
      { invoice_id: 200, order_id: 8800003, number: 'SD 103/1/11/26', type: 'normal', date_add: sec('2026-11-01T09:00:00Z') },
    ]
    await syncBlInvoices(db, bl.client(), null, { now: new Date('2026-11-01T10:00:00Z'), initialLookbackMs: 24 * 3600_000 })
    await syncBlInvoices(db, bl.client(), null, { now: new Date('2026-11-01T10:02:00Z'), backfillDays: 0 })
    expect(await db.blInvoiceSnapshot.count()).toBe(1)
  })
})

// ─── ───────────────────────────────────────────────────────────────

describe('po oknie wiązanie po pozycjach tylko przy sprawnym odczycie faktur BL', () => {
  // WZ 154/4/11/26: założony 04.11 12:29:32 UTC, faktura SD 154/4/11/26, kopii faktury BL brak
  const T_WZ = new Date('2026-11-04T12:29:32Z')
  async function zamowienie(id: string, oferta: string) {
    const p = await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    await offer(db, 'WOO_SD', oferta, p)
    return shadowOrder(id, oferta, 1, new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T10:05:00Z'))
  }

  it('BL skonfigurowany, odczyt faktur nigdy się nie udał: po 15 min dalej CZEKA_NA_FAKTURE_BL; po dobie alert z informacją o BaseLinkerze', async () => {
    const orderId = await zamowienie('9301', '40')
    src.docs = [wzNr('WZ 154/4/11/26')]
    const s = await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z'), fakturyBl: { ostatniOk: null } })
    expect(s).toMatchObject({ waitingForBlInvoice: 1, settled: 0 })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'ACTIVE' })
    const s2 = await syncWfirmaWz(db, src, { now: new Date('2026-11-05T13:30:00Z'), fakturyBl: { ostatniOk: null } })
    expect(s2).toMatchObject({ waitingForBlInvoice: 1, unresolvedOld: 1 })
    expect((await db.alert.findFirstOrThrow({ where: { kind: 'WZ_NIEROZSTRZYGNIETE' } })).message).toMatch(/czeka na fakturę z BaseLinkera/)
  })

  it('ostatni kompletny odczyt faktur BL przed założeniem WZ: czeka; odczyt po założeniu: pozycje', async () => {
    const orderId = await zamowienie('9302', '41')
    src.docs = [wzNr('WZ 154/4/11/26')]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z'), fakturyBl: { ostatniOk: new Date(T_WZ.getTime() - 60_000) } })).toMatchObject({ waitingForBlInvoice: 1, settled: 0 })
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:02:00Z'), fakturyBl: { ostatniOk: new Date(T_WZ.getTime() + 60_000) } })).toMatchObject({ settled: 1 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'ROZLICZONA', linkedBy: 'POZYCJE', orderId })
    await expectInvariants(db)
  })

  it('znacznik udanego przebiegu: zapis i odczyt, starszy przebieg nie cofa znacznika', async () => {
    const { ostatniUdanyPrzebieg, zapiszUdanyPrzebieg } = await import('@/lib/cien/przebiegi')
    expect(await ostatniUdanyPrzebieg(db, 'cien-bl-faktury')).toBeNull()
    await zapiszUdanyPrzebieg(db, 'cien-bl-faktury', new Date('2026-11-04T13:00:00Z'))
    await zapiszUdanyPrzebieg(db, 'cien-bl-faktury', new Date('2026-11-04T12:00:00Z'))
    expect(await ostatniUdanyPrzebieg(db, 'cien-bl-faktury')).toEqual(new Date('2026-11-04T13:00:00Z'))
    await zapiszUdanyPrzebieg(db, 'cien-bl-faktury', new Date('2026-11-04T13:02:00Z'))
    expect(await ostatniUdanyPrzebieg(db, 'cien-bl-faktury')).toEqual(new Date('2026-11-04T13:02:00Z'))
  })
})

describe('numer faktury dobierany w ponownej próbie z kopii', () => {
  it('WZ z fakturą bez znanego numeru: po oknie czeka (nie pozycje); numer dobrany w ponownej próbie → pozycje', async () => {
    const p = await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    await offer(db, 'WOO_SD', '42', p)
    const orderId = await shadowOrder('9303', '42', 1, new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T10:05:00Z'))
    src.docs = [{ ...wzNr('WZ 154/4/11/26'), invoiceId: '999000111' }]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:30:00Z') })).toMatchObject({ waitingForBlInvoice: 1, settled: 0 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'CZEKA_NA_FAKTURE_BL', invoiceNumber: null })
    // WZ wypadł z okna nakładki (src bez niego); numer faktury odpowiada teraz `invoices/get`
    src.docs = []
    src.numerFaktury = async (id: string) => (src.calls.push(`numerFaktury ${id}`), id === '999000111' ? 'SD 184/4/11/26' : null)
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T14:00:00Z') })).toMatchObject({ settled: 1 })
    expect(src.calls).toContain('numerFaktury 999000111')
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'ROZLICZONA', invoiceNumber: 'SD 184/4/11/26', linkedBy: 'POZYCJE', orderId })
  })
})

describe('opis WZ w kopii — ponowna próba wiąże po numerze zamówienia BL w opisie', () => {
  it('pierwszy odczyt: świeży WZ, zamówienie bez pary BL → czeka; po parze ponowna próba z kopii (poza oknem) wiąże po opisie, nie po pozycjach', async () => {
    const p = await product(db, '90001', 5, { wfirmaGoodId: '90000021' })
    await offer(db, 'WOO_SD', '43', p)
    const orderId = await shadowOrder('9304', '43', 1, new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T10:05:00Z'))
    src.docs = [{ ...wzNr('WZ 154/4/11/26'), opis: 'Zamówienie BL 900000007' }]
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T12:31:00Z') })).toMatchObject({ waitingForBlInvoice: 1 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ description: 'Zamówienie BL 900000007', createdRaw: wzNr('WZ 154/4/11/26').utworzono })
    await db.order.update({ where: { id: orderId }, data: { blOrderId: 900000007 } })
    src.docs = []
    expect(await syncWfirmaWz(db, src, { now: new Date('2026-11-04T13:00:00Z') })).toMatchObject({ settled: 1 })
    expect(await db.wfirmaWzSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'ROZLICZONA', linkedBy: 'OPIS', orderId })
    expect(await db.alert.count({ where: { kind: 'WZ_PO_POZYCJACH' } })).toBe(0)
  })
})
