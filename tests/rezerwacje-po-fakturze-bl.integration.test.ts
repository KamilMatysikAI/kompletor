// Rezerwacje i braki zamówień z zastosowaną fakturą BL (praca w podglądzie obok BL). Faktura BL obejmuje całe zamówienie,
// a WZ do niej zdejmuje towar w programie magazynowym, więc zamówienie po fakturze nie może dostać przydziału dostawy,
// trzymać rezerwacji ani braku. Kształt z raportu dziennego: brak towaru przy przyjęciu, faktura BL, potem dostawa (+5)
// i przydział rezerwujący towar drugi raz → nadmiar rezerwacji. Dane fikcyjne, BL i WZ to atrapy.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDailyReport } from '@/lib/cien/raport-dzienny'
import { syncBlInvoices, type WzLine, type WzOdczyt } from '@/lib/cien/faktury-bl'
import { FAKTURA_BL_BEZ_PARY, NUMBER_FETCH_BUDGET, type WynikNumeru } from '@/lib/cien/parowanie-faktur'
import { runBlComparison, type BlOrderHeader } from '@/lib/cien/bl-porownanie'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { swiezoscKopii } from '@/lib/kanaly/punkt-ciecia'
import { FAKTURA_BL_I_KOMPLETORA, FAKTURA_BL_TOWAR_W_PRACY, PROCEDURA_FAKTURY_BL, ROZLICZENIE_PO_FAKTURZE_BL, samonaprawaPoFakturzeBl } from '@/lib/rdzen/faktura-bl'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { auditStale } from '@/lib/rdzen/niezmienniki'
import { processAllocateEvents } from '@/lib/rdzen/przydzial'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { issueInvoice, packOrder } from '@/lib/rdzen/rozchod'
import { ORG_A, testDb, truncateAll } from './db'
import { FakeBl, sec } from './bl-atrapa'
import { expectInvariants, FakeWfirma, order, product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

class FakeWz implements WzOdczyt {
  docs = new Map<string, WzLine[]>()
  async wzForInvoice(n: string): Promise<WzLine[] | null> {
    return this.docs.get(n) ?? null
  }
}

const D = (iso: string) => new Date(iso)
let bl: FakeBl

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  bl = new FakeBl()
})

async function przyjmij(lines: { productId: string; qty: number }[], blOrderId: number | null, at: Date): Promise<string> {
  const id = (await ingestOrder(db, order(lines, { createdAtChannel: at }), { now: at })).orderId!
  if (blOrderId !== null) await db.order.update({ where: { id }, data: { blOrderId } })
  return id
}

describe('faktura BL → dostawa: bez ponownej rezerwacji', () => {
  it('braki zamówień z fakturą BL rozliczone jako wydane; dostawa +5 idzie tylko do zamówienia bez faktury; raport bez nadmiaru', async () => {
    const x = await product(db, 'T-X', 0, { wfirmaGoodId: 'G-X' })
    const y = await product(db, 'T-Y', 10, { wfirmaGoodId: 'G-Y' })
    // A1: X×3 (brak) + Y×1 (rezerwacja); A2: same X×1 (w całości brak); A3: X×1 bez faktury (czeka naprawdę)
    const a1 = await przyjmij([{ productId: x, qty: 3 }, { productId: y, qty: 1 }], 5001, D('2026-10-27T08:00:00Z'))
    const a2 = await przyjmij([{ productId: x, qty: 1 }], 5002, D('2026-10-29T10:00:00Z'))
    const a3 = await przyjmij([{ productId: x, qty: 1 }], 5003, D('2026-11-02T10:00:00Z'))
    expect(await db.shortage.count({ where: { state: 'OPEN' } })).toBe(3)
    bl.invoices = [
      { invoice_id: 1, order_id: 5001, number: 'FV 1/10', type: 'normal', date_add: sec('2026-10-27T08:05:00Z') },
      { invoice_id: 2, order_id: 5002, number: 'FV 2/10', type: 'normal', date_add: sec('2026-10-29T10:05:00Z') },
    ]
    const wz = new FakeWz()
    wz.docs.set('FV 1/10', [{ wfirmaGoodId: 'G-X', count: 3 }, { wfirmaGoodId: 'G-Y', count: 1 }])
    wz.docs.set('FV 2/10', [{ wfirmaGoodId: 'G-X', count: 1 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-02T12:00:00Z'), initialLookbackMs: 10 * 24 * 3600_000 })
    expect(s).toMatchObject({ applied: 2, errors: [] })
    for (const id of [a1, a2]) {
      expect(await db.shortage.findMany({ where: { orderId: id, productId: x } })).toEqual([expect.objectContaining({ state: 'RESOLVED', resolvedBy: 'system:faktura-bl' })])
      expect((await db.order.findUniqueOrThrow({ where: { id } })).flags).not.toMatchObject({ brakuje: true })
      expect(await db.reservation.count({ where: { orderId: id, state: 'ACTIVE' } })).toBe(0)
    }
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: a3 } })).toMatchObject({ state: 'OPEN' })
    // dostawa: odczyt programu magazynowego +5 → przydział
    await applyStockRead(db, { productId: x, countBase: 5, requestSentAt: D('2026-11-03T17:53:00Z') }, { now: D('2026-11-03T17:53:30Z') })
    await processAllocateEvents(db, { now: D('2026-11-03T17:54:00Z') })
    expect(await db.reservation.count({ where: { orderId: { in: [a1, a2] }, state: 'ACTIVE' } })).toBe(0)
    expect(await db.orderEvent.count({ where: { orderId: { in: [a1, a2] }, kind: 'PRZYDZIAL_DOSTAWY' } })).toBe(0)
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: a3, state: 'ACTIVE' } })).toMatchObject({ qtyBase: 1 })
    expect(await stockOf(db, x)).toMatchObject({ physical: 5, reserved: 1, overcommitSince: null })
    await expectInvariants(db)
    const r = await buildDailyReport(db, '2026-11-03', D('2026-11-04T01:00:00Z'))
    expect(r.overcommit.count).toBe(0)
  })
})

/** Zamówienie z rezerwacją, bez numeru w sklepie; kopia zamówienia BL zna je tylko po numerze; faktura już POZA_CIENIEM. */
async function bezNumeru() {
  const p = await product(db, 'T-P', 24, { wfirmaGoodId: 'G-P' })
  const orderId = await przyjmij([{ productId: p, qty: 15 }], null, D('2026-10-24T14:35:52Z'))
  expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).channelNumber).toBeNull()
  await db.blOrderSnapshot.create({ data: { blOrderId: 7001, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: 'N-8396', statusId: 2, dateAdd: D('2026-10-24T14:35:52Z'), fetchedAt: D('2026-10-26T14:37:00Z') } })
  bl.invoices = [{ invoice_id: 90, order_id: 7001, number: 'FV 30/10', type: 'normal', date_add: sec('2026-10-27T08:44:52Z') }]
  const wz = new FakeWz()
  wz.docs.set('FV 30/10', [{ wfirmaGoodId: 'G-P', count: 14 }, { wfirmaGoodId: 'G-P', count: 1 }])
  await syncBlInvoices(db, bl.client(), wz, { now: D('2026-10-31T10:00:00Z'), initialLookbackMs: 5 * 24 * 3600_000 })
  expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'POZA_CIENIEM', lastError: null })
  return { p, orderId, wz }
}

describe('para dla zamówienia bez numeru w sklepie (przyjętego przed zapisem numeru)', () => {
  it('numer odczytem ze sklepu → para po numerze, faktura wraca z POZA_CIENIEM i zużywa rezerwację; kolejny przebieg bez odczytu', async () => {
    const { p, orderId, wz } = await bezNumeru()
    const odczyty: string[] = []
    const uzupelnijNumer = async (id: string) => {
      odczyty.push(id)
      await db.order.update({ where: { id }, data: { channelNumber: 'N-8396' } })
      return 'OK' as const
    }
    const s = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:00:00Z'), uzupelnijNumer })
    expect(s).toMatchObject({ pairedFromInvoice: 1, applied: 1, errors: [] })
    expect(odczyty).toEqual([orderId])
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(7001)
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONSUMED', qtyBase: 15 })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'ZASTOSOWANA', orderId })
    expect((await stockOf(db, p)).reserved).toBe(0)
    await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:05:00Z'), uzupelnijNumer })
    expect(odczyty).toHaveLength(1)
    await expectInvariants(db)
  })

  it('trafienie spoza odczytanych kandydatów (numer dotarł w trakcie odczytu): bez znacznika, para zwykłym torem w następnym przebiegu', async () => {
    const { wz } = await bezNumeru()
    // zamówienie spoza okna kandydatów (złożone dużo wcześniej), które w trakcie odczytu dostaje numer ze sklepu
    const p2 = await product(db, 'T-P2', 5, { wfirmaGoodId: 'G-P2' })
    const inne = await przyjmij([{ productId: p2, qty: 1 }], null, D('2026-08-01T10:00:00Z'))
    const fill = async () => {
      await db.order.update({ where: { id: inne }, data: { channelNumber: 'N-8396' } })
      return 'BRAK' as const
    }
    await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:00:00Z'), uzupelnijNumer: fill })
    expect((await db.order.findUniqueOrThrow({ where: { id: inne } })).blOrderId).toBeNull()
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: null })
    await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:02:00Z') })
    expect((await db.order.findUniqueOrThrow({ where: { id: inne } })).blOrderId).toBe(7001)
    await expectInvariants(db)
  })

  it('sklep nie podał numeru: znacznik na fakturze, bez kolejnych odczytów, rezerwacja bez zmian; inny numer w sklepie nie paruje', async () => {
    const { orderId, wz } = await bezNumeru()
    let odczyty = 0
    const inny = async (id: string) => (odczyty++, await db.order.update({ where: { id }, data: { channelNumber: 'N-1111' } }), 'OK' as const)
    await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:00:00Z'), uzupelnijNumer: inny })
    await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:05:00Z'), uzupelnijNumer: inny })
    expect(odczyty).toBe(1)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'POZA_CIENIEM', lastError: expect.stringContaining('numer ze sklepu sprawdzony') })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBeNull()
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'ACTIVE', qtyBase: 15 })
    await expectInvariants(db)
  })

  it('sklep nie odpowiada: bez znacznika, bez kolejnych odczytów w tym przebiegu; następny przebieg ponawia i paruje', async () => {
    const { p, orderId, wz } = await bezNumeru()
    // drugi kandydat w oknie (nowszy, czytany pierwszy): po błędzie sklepu drugiego odczytu już nie ma
    const drugi = await przyjmij([{ productId: p, qty: 1 }], null, D('2026-10-24T16:00:00Z'))
    const odczyty: string[] = []
    const lezy = async (id: string): Promise<WynikNumeru> => (odczyty.push(id), 'BLAD')
    const s1 = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:00:00Z'), uzupelnijNumer: lezy })
    expect(s1).toMatchObject({ numbersRead: 1, numbersFailed: 1, errors: [] })
    expect(odczyty).toEqual([drugi])
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: null })
    const dziala = async (id: string): Promise<WynikNumeru> => {
      odczyty.push(id)
      await db.order.update({ where: { id }, data: { channelNumber: id === orderId ? 'N-8396' : 'N-0002' } })
      return 'OK'
    }
    const s2 = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:02:00Z'), uzupelnijNumer: dziala })
    expect(s2).toMatchObject({ pairedFromInvoice: 1, applied: 1, errors: [] })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(7001)
    expect(await db.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'CONSUMED', qtyBase: 15 })
    await expectInvariants(db)
  })

  it('wyjątek przy odczycie liczy się jak błąd sklepu: bez znacznika', async () => {
    const { wz } = await bezNumeru()
    const rzuca = async (): Promise<WynikNumeru> => {
      throw new Error('przekroczony limit zapytań')
    }
    const s = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:00:00Z'), uzupelnijNumer: rzuca })
    expect(s).toMatchObject({ numbersFailed: 1 })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: null })
  })

  it('budżet odczytów wyczerpany: kandydaci ucięci czekają, bez znacznika; następny przebieg czyta resztę i paruje', async () => {
    const { p, orderId, wz } = await bezNumeru()
    // nowsze zamówienia bez numeru w oknie wypełniają budżet; właściwe (najstarsze) zostaje poza nim
    for (let i = 0; i < NUMBER_FETCH_BUDGET; i++) await przyjmij([{ productId: p, qty: 1 }], null, new Date(D('2026-10-24T15:00:00Z').getTime() + i * 60_000))
    const odczyty: string[] = []
    const fill = async (id: string): Promise<WynikNumeru> => {
      odczyty.push(id)
      await db.order.update({ where: { id }, data: { channelNumber: id === orderId ? 'N-8396' : `N-${odczyty.length}` } })
      return 'OK'
    }
    const s1 = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:00:00Z'), uzupelnijNumer: fill })
    expect(s1.numbersRead).toBe(NUMBER_FETCH_BUDGET)
    expect(odczyty).not.toContain(orderId)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: null, outcome: 'POZA_CIENIEM' })
    const s2 = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:02:00Z'), uzupelnijNumer: fill })
    expect(s2).toMatchObject({ numbersRead: 1, pairedFromInvoice: 1, applied: 1 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(7001)
    await expectInvariants(db)
  })

  it('świeża faktura (młodsza niż godzina): bez odczytu numeru i bez znacznika; po godzinie odczyt', async () => {
    const p = await product(db, 'T-P', 5, { wfirmaGoodId: 'G-P' })
    const orderId = await przyjmij([{ productId: p, qty: 2 }], null, D('2026-11-11T09:00:00Z'))
    await db.blOrderSnapshot.create({ data: { blOrderId: 7101, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: 'N-9100', statusId: 2, dateAdd: D('2026-11-11T09:00:00Z'), fetchedAt: D('2026-11-11T09:30:00Z') } })
    bl.invoices = [{ invoice_id: 91, order_id: 7101, number: 'FV 40/11', type: 'normal', date_add: sec('2026-11-11T09:40:00Z') }]
    const odczyty: string[] = []
    const fill = async (id: string): Promise<WynikNumeru> => {
      odczyty.push(id)
      await db.order.update({ where: { id }, data: { channelNumber: 'N-9100' } })
      return 'OK'
    }
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T10:00:00Z'), initialLookbackMs: 24 * 3600_000, uzupelnijNumer: fill })
    expect(odczyty).toEqual([])
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: null, appliedAt: null })
    const s = await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T10:45:00Z'), uzupelnijNumer: fill })
    expect(odczyty).toEqual([orderId])
    expect(s.pairedFromInvoice).toBe(1)
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(7101)
  })
})

describe('samonaprawa: rezerwacja i brak zostawione po fakturze BL', () => {
  /** Stan sprzed poprawki: rezerwacja nadana zamówieniu po fakturze BL, stan po WZ niższy → nadmiar z alertami. */
  async function stanSprzedPoprawki() {
    const x = await product(db, 'T-X', 5, { wfirmaGoodId: 'G-X' })
    const z = await product(db, 'T-Z', 0, { wfirmaGoodId: 'G-Z' })
    const w = await product(db, 'T-W', 4, { wfirmaGoodId: 'G-W' })
    const b = await przyjmij([{ productId: x, qty: 3 }], 6001, D('2026-11-03T10:00:00Z'))
    const c = await przyjmij([{ productId: z, qty: 1 }], 6002, D('2026-11-03T11:00:00Z'))
    const bezFaktury = await przyjmij([{ productId: w, qty: 2 }], 6003, D('2026-11-03T12:00:00Z'))
    for (const [orderId, docId] of [[b, 'FV 10/11'], [c, 'FV 11/11']] as const)
      await db.orderEvent.create({ data: { orderId, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId }, createdAt: D('2026-11-03T13:00:00Z') } })
    // WZ do faktury zdjął 3 szt. w programie: stan 2 przy rezerwacji 3; drugi odczyt po 30 min wystawia alert
    await applyStockRead(db, { productId: x, countBase: 2, requestSentAt: D('2026-11-03T18:00:00Z') }, { now: D('2026-11-03T18:00:10Z') })
    await applyStockRead(db, { productId: x, countBase: 2, requestSentAt: D('2026-11-03T18:40:00Z') }, { now: D('2026-11-03T18:40:10Z') })
    await auditStale(db, D('2026-11-03T19:00:00Z'))
    expect(await stockOf(db, x)).toMatchObject({ physical: 2, reserved: 3 })
    expect(await db.alert.count({ where: { kind: { in: ['NADMIAR_REZERWACJI', 'NADMIAR_ZALEGLY'] }, ref: x, closedAt: null } })).toBe(2)
    return { x, z, w, b, c, bezFaktury }
  }

  it('rezerwacja zużyta bez ruchu stanu, brak wydany, znacznik nadmiaru zdjęty, alerty zamknięte, raport bez nadmiaru; powtórka bez zmian', async () => {
    const { x, w, b, c, bezFaktury } = await stanSprzedPoprawki()
    const ruchyPrzed = await db.pendingMovement.count()
    const s = await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-10T20:00:00Z') })
    expect(s.errors).toEqual([])
    expect(s.samonaprawa).toMatchObject({ zamowien: 2, rezerwacji: 3, brakow: 1, nadmiarowZamknietych: 1 })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: b } })).toMatchObject({ state: 'CONSUMED', qtyBase: 3 })
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: c } })).toMatchObject({ state: 'RESOLVED', resolvedBy: 'system:faktura-bl', note: 'wydane fakturą BL: FV 11/11' })
    expect(await stockOf(db, x)).toMatchObject({ physical: 2, reserved: 0, overcommitSince: null, overcommitListedAt: null })
    expect(await db.pendingMovement.count()).toBe(ruchyPrzed)
    expect(await db.alert.count({ where: { kind: { in: ['NADMIAR_REZERWACJI', 'NADMIAR_ZALEGLY'] }, closedAt: null } })).toBe(0)
    expect(await db.orderEvent.findFirstOrThrow({ where: { orderId: b, kind: ROZLICZENIE_PO_FAKTURZE_BL } })).toMatchObject({ data: { docId: 'FV 10/11', rezerwacje: [{ productId: x, qty: 3 }], brakiSztuk: 0 } })
    // zamówienie bez faktury BL nietknięte
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: bezFaktury } })).toMatchObject({ state: 'ACTIVE', qtyBase: 2 })
    expect((await stockOf(db, w)).reserved).toBe(2)
    await expectInvariants(db)
    const r = await buildDailyReport(db, '2026-11-10', D('2026-11-10T21:00:00Z'))
    expect(r.overcommit).toMatchObject({ count: 0 })
    expect(r.blInvoiceRepair).toMatchObject({ healedOrders: 2, numbersAlertOpen: false })
    // powtórka: nic do zrobienia, bez drugiego wpisu w historii
    expect(await samonaprawaPoFakturzeBl(db, { now: D('2026-11-10T20:05:00Z') })).toEqual({ zamowien: 0, rezerwacji: 0, brakow: 0, nadmiarowZamknietych: 0, zgloszonych: 0, alertowZamknietych: 0, bledy: [] })
    expect(await db.orderEvent.count({ where: { kind: ROZLICZENIE_PO_FAKTURZE_BL } })).toBe(2)
    // auditStale nie otwiera alertu nadmiaru drugi raz
    await auditStale(db, D('2026-11-10T21:00:00Z'))
    expect(await db.alert.count({ where: { kind: { in: ['NADMIAR_REZERWACJI', 'NADMIAR_ZALEGLY'] }, closedAt: null } })).toBe(0)
  })

  it('zwolniony stan trafia do braku zamówienia bez faktury (przydział dostawy)', async () => {
    const { x } = await stanSprzedPoprawki()
    const czeka = await przyjmij([{ productId: x, qty: 1 }], 6004, D('2026-11-04T09:00:00Z'))
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: czeka } })).toMatchObject({ state: 'OPEN' })
    await samonaprawaPoFakturzeBl(db, { now: D('2026-11-10T20:00:00Z') })
    await processAllocateEvents(db, { now: D('2026-11-10T20:01:00Z') })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: czeka, state: 'ACTIVE' } })).toMatchObject({ qtyBase: 1 })
    expect(await stockOf(db, x)).toMatchObject({ physical: 2, reserved: 1 })
    await expectInvariants(db)
  })

  it('stan 0 po WZ: rezerwacja zużyta, znacznik nadmiaru zdjęty (0 ≤ 0), alert zamknięty', async () => {
    const x = await product(db, 'T-X', 3, { wfirmaGoodId: 'G-X' })
    const b = await przyjmij([{ productId: x, qty: 3 }], 6101, D('2026-11-03T10:00:00Z'))
    await db.orderEvent.create({ data: { orderId: b, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 20/11' } } })
    await db.stock.update({ where: { productId_warehouseId: { productId: x, warehouseId: 'glowny' } }, data: { wfirmaCount: 0, physical: 0 } })
    await applyStockRead(db, { productId: x, countBase: 0, requestSentAt: D('2026-11-03T18:00:00Z') }, { now: D('2026-11-03T18:00:10Z') })
    await applyStockRead(db, { productId: x, countBase: 0, requestSentAt: D('2026-11-03T18:40:00Z') }, { now: D('2026-11-03T18:40:10Z') })
    expect(await db.alert.count({ where: { kind: 'NADMIAR_REZERWACJI', closedAt: null } })).toBe(1)
    const s = await samonaprawaPoFakturzeBl(db, { now: D('2026-11-10T20:00:00Z') })
    expect(s).toMatchObject({ zamowien: 1, rezerwacji: 3, nadmiarowZamknietych: 1 })
    expect(await stockOf(db, x)).toMatchObject({ physical: 0, reserved: 0, overcommitSince: null })
    await expectInvariants(db)
  })
})

describe('alert nadmiaru tylko przy rezerwacjach ponad stan', () => {
  it('ruch biura −1 przy stanie 0 bez rezerwacji: znacznik zostaje (niezmiennik 5), bez listy, bez alertów; rezerwacje 2 przy stanie 1: alert i lista', async () => {
    const x = await product(db, 'T-X', 0, { wfirmaGoodId: 'G-X' })
    await db.pendingMovement.create({ data: { productId: x, warehouseId: 'glowny', delta: -1, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL', sentAt: D('2026-11-03T09:00:00Z'), effectiveAt: D('2026-11-03T09:00:00Z'), wzQty: 0, idempotencyKey: 'test-bez-dokumentu-1' } })
    await db.stock.update({ where: { productId_warehouseId: { productId: x, warehouseId: 'glowny' } }, data: { pendingDelta: -1, physical: -1 } })
    await applyStockRead(db, { productId: x, countBase: 0, requestSentAt: D('2026-11-03T18:00:00Z') }, { now: D('2026-11-03T18:00:10Z') })
    await applyStockRead(db, { productId: x, countBase: 0, requestSentAt: D('2026-11-03T18:40:00Z') }, { now: D('2026-11-03T18:40:10Z') })
    expect(await stockOf(db, x)).toMatchObject({ physical: -1, reserved: 0, overcommitSince: D('2026-11-03T18:00:00Z'), overcommitListedAt: null })
    expect(await auditStale(db, D('2026-11-03T19:00:00Z'))).toBe(0)
    expect(await db.alert.count({ where: { kind: { in: ['NADMIAR_REZERWACJI', 'NADMIAR_ZALEGLY'] } } })).toBe(0)
    await expectInvariants(db)

    const y = await product(db, 'T-Y', 2, { wfirmaGoodId: 'G-Y' })
    await przyjmij([{ productId: y, qty: 2 }], null, D('2026-11-03T10:00:00Z'))
    await applyStockRead(db, { productId: y, countBase: 1, requestSentAt: D('2026-11-03T18:00:00Z') }, { now: D('2026-11-03T18:00:10Z') })
    await applyStockRead(db, { productId: y, countBase: 1, requestSentAt: D('2026-11-03T18:40:00Z') }, { now: D('2026-11-03T18:40:10Z') })
    expect((await stockOf(db, y)).overcommitListedAt).not.toBeNull()
    expect(await auditStale(db, D('2026-11-03T19:00:00Z'))).toBe(1)
    expect(await db.alert.findMany({ where: { ref: y }, select: { kind: true }, orderBy: { kind: 'asc' } })).toEqual([{ kind: 'NADMIAR_REZERWACJI' }, { kind: 'NADMIAR_ZALEGLY' }])
    expect(await db.alert.count({ where: { ref: x } })).toBe(0)
    await expectInvariants(db)
  })
})

describe('konto w trybie pracy: faktura BL nie zużywa rezerwacji ani braku po cichu', () => {
  const doPracy = () => db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })

  it('samonaprawa nie rusza zamówień, zgłasza je biuru raz; dostawa idzie do braku jak zwykle', async () => {
    const x = await product(db, 'T-X', 3, { wfirmaGoodId: 'G-X' })
    const z = await product(db, 'T-Z', 0, { wfirmaGoodId: 'G-Z' })
    const b = await przyjmij([{ productId: x, qty: 3 }], 6201, D('2026-11-20T10:00:00Z'))
    const c = await przyjmij([{ productId: z, qty: 1 }], 6202, D('2026-11-20T11:00:00Z'))
    for (const [orderId, docId] of [[b, 'FV 50/11'], [c, 'FV 51/11']] as const)
      await db.orderEvent.create({ data: { orderId, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId } } })
    await doPracy()
    const s = await samonaprawaPoFakturzeBl(db, { now: D('2026-11-20T12:00:00Z') })
    expect(s).toMatchObject({ zamowien: 0, rezerwacji: 0, brakow: 0, zgloszonych: 2, bledy: [] })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: b } })).toMatchObject({ state: 'ACTIVE', qtyBase: 3 })
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: c } })).toMatchObject({ state: 'OPEN' })
    expect((await stockOf(db, x)).reserved).toBe(3)
    const alerty = await db.alert.findMany({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY }, orderBy: { ref: 'asc' } })
    expect(alerty.map((a) => a.ref).sort()).toEqual([b, c].sort())
    for (const a of alerty) {
      expect(a.message).toContain('fakturę wystawioną w poprzednim systemie')
      // jedna procedura z drogą klikania, bez „zamknij zamówienie” i bez pakowania w Kompletorze
      expect(a.message).toContain('„Więcej” → „Zmień status…” → „Do wyjaśnienia”')
      expect(a.message).toContain('w Kompletorze go nie pakuj')
      expect(a.message).not.toMatch(/zamknij zamówienie|spakuj je jak zwykle/i)
    }
    expect(await db.orderEvent.count({ where: { kind: ROZLICZENIE_PO_FAKTURZE_BL } })).toBe(0)
    // powtórka: bez drugiego alertu
    await samonaprawaPoFakturzeBl(db, { now: D('2026-11-20T12:05:00Z') })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY } })).toBe(2)
    // dostawa: brak zamówienia z fakturą BL w trybie pracy dostaje przydział (zamówienie kończy biuro)
    await applyStockRead(db, { productId: z, countBase: 1, requestSentAt: D('2026-11-20T13:00:00Z') }, { now: D('2026-11-20T13:00:30Z') })
    await processAllocateEvents(db, { now: D('2026-11-20T13:01:00Z') })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: c, state: 'ACTIVE' } })).toMatchObject({ qtyBase: 1 })
    await expectInvariants(db)
  })

  it('rozliczenie faktury BL w trybie pracy: brak pokryty przez WZ rozliczony jako wydany, bez zgłoszenia', async () => {
    const x = await product(db, 'T-X', 0, { wfirmaGoodId: 'G-X' })
    const a = await przyjmij([{ productId: x, qty: 2 }], 6301, D('2026-11-20T08:00:00Z'))
    await doPracy()
    bl.invoices = [{ invoice_id: 301, order_id: 6301, number: 'FV 60/11', type: 'normal', date_add: sec('2026-11-20T08:05:00Z') }]
    const wz = new FakeWz()
    wz.docs.set('FV 60/11', [{ wfirmaGoodId: 'G-X', count: 2 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-20T12:00:00Z'), initialLookbackMs: 24 * 3600_000 })
    expect(s.errors).toEqual([])
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ state: 'RESOLVED', resolvedBy: 'system:faktura-bl' })
    expect((await db.order.findUniqueOrThrow({ where: { id: a } })).flags).not.toMatchObject({ brakuje: true })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY } })).toBe(0)
    await expectInvariants(db)
  })

  it('tryb pracy: rezerwacja i brak + faktura BL → rezerwacja zużyta, brak rozliczony; dostawa nie rezerwuje towaru dla tego zamówienia', async () => {
    const x = await product(db, 'T-X', 2, { wfirmaGoodId: 'G-X' })
    const a = await przyjmij([{ productId: x, qty: 3 }], 6401, D('2026-11-20T08:00:00Z'))
    const b = await przyjmij([{ productId: x, qty: 1 }], 6402, D('2026-11-20T09:00:00Z'))
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: a, state: 'ACTIVE' } })).toMatchObject({ qtyBase: 2 })
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ state: 'OPEN', qtyBase: 1 })
    await doPracy()
    bl.invoices = [{ invoice_id: 401, order_id: 6401, number: 'FV 70/11', type: 'normal', date_add: sec('2026-11-20T09:05:00Z') }]
    const wz = new FakeWz()
    wz.docs.set('FV 70/11', [{ wfirmaGoodId: 'G-X', count: 3 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-20T12:00:00Z'), initialLookbackMs: 24 * 3600_000 })
    expect(s.errors).toEqual([])
    expect(await db.reservation.count({ where: { orderId: a, state: 'ACTIVE' } })).toBe(0)
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ state: 'RESOLVED', resolvedBy: 'system:faktura-bl' })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY } })).toBe(0)
    // brak otwarty + faktura BL zastosowana w trybie pracy: takiego zamówienia nie ma
    expect(await db.order.count({ where: { events: { some: { kind: 'FAKTURA_BL' } }, shortages: { some: { state: 'OPEN' } } } })).toBe(0)
    // dostawa +3: towar idzie do zamówienia bez faktury, nie do zamówienia z fakturą BL
    await applyStockRead(db, { productId: x, countBase: 3, requestSentAt: D('2026-11-20T13:00:00Z') }, { now: D('2026-11-20T13:00:30Z') })
    await processAllocateEvents(db, { now: D('2026-11-20T13:01:00Z') })
    expect(await db.reservation.count({ where: { orderId: a, state: 'ACTIVE' } })).toBe(0)
    expect(await db.orderEvent.count({ where: { orderId: a, kind: 'PRZYDZIAL_DOSTAWY' } })).toBe(0)
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: b, state: 'ACTIVE' } })).toMatchObject({ qtyBase: 1 })
    await expectInvariants(db)
  })

  it('tryb pracy: WZ nie pokrywa braku (brak WZ) → rezerwacja zużyta, brak zostaje otwarty, od razu jeden alert dla biura', async () => {
    const x = await product(db, 'T-X', 1, { wfirmaGoodId: 'G-X' })
    const a = await przyjmij([{ productId: x, qty: 2 }], 6501, D('2026-11-20T08:00:00Z'))
    await doPracy()
    bl.invoices = [{ invoice_id: 501, order_id: 6501, number: 'FV 80/11', type: 'normal', date_add: sec('2026-11-20T08:05:00Z') }]
    // WZ zawiera tylko ilość zarezerwowaną: na brak nic nie zostaje
    const wz = new FakeWz()
    wz.docs.set('FV 80/11', [{ wfirmaGoodId: 'G-X', count: 1 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-20T12:00:00Z'), initialLookbackMs: 24 * 3600_000 })
    expect(s.errors).toEqual([])
    expect(await db.reservation.count({ where: { orderId: a, state: 'ACTIVE' } })).toBe(0)
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ state: 'OPEN' })
    const alerty = await db.alert.findMany({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY } })
    expect(alerty.map((x) => x.ref)).toEqual([a])
    expect(alerty[0]?.message).toContain(PROCEDURA_FAKTURY_BL)
    // samonaprawa w tym samym przebiegu nie dubluje alertu
    await samonaprawaPoFakturzeBl(db, { now: D('2026-11-20T12:05:00Z') })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY } })).toBe(1)
    await expectInvariants(db)
  })
})

describe('faktura korygująca i zamówienie anulowane', () => {
  it('faktura korygująca BL nie zużywa rezerwacji, nie zamyka braku i nie daje zdarzenia faktury', async () => {
    const x = await product(db, 'T-X', 2, { wfirmaGoodId: 'G-X' })
    const a = await przyjmij([{ productId: x, qty: 3 }], 6401, D('2026-11-05T08:00:00Z'))
    expect(await db.shortage.count({ where: { orderId: a, state: 'OPEN' } })).toBe(1)
    bl.invoices = [{ invoice_id: 401, order_id: 6401, number: 'KOR 1/11', type: 'correction', date_add: sec('2026-11-05T09:00:00Z') }]
    const wz = new FakeWz()
    wz.docs.set('KOR 1/11', [{ wfirmaGoodId: 'G-X', count: 3 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-05T12:00:00Z'), initialLookbackMs: 24 * 3600_000 })
    expect(s).toMatchObject({ corrections: 1, applied: 0, errors: [] })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ state: 'ACTIVE', qtyBase: 2 })
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ state: 'OPEN' })
    expect(await db.orderEvent.count({ where: { orderId: a, kind: 'FAKTURA_BL' } })).toBe(0)
    expect(s.samonaprawa).toBeUndefined()
    await expectInvariants(db)
  })

  it('zamówienie anulowane ze zdarzeniem faktury BL: samonaprawa je pomija', async () => {
    const x = await product(db, 'T-X', 3, { wfirmaGoodId: 'G-X' })
    const a = await przyjmij([{ productId: x, qty: 3 }], 6501, D('2026-11-05T08:00:00Z'))
    await db.orderEvent.create({ data: { orderId: a, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 70/11' } } })
    await db.order.update({ where: { id: a }, data: { status: 'ANULOWANE' } })
    const s = await samonaprawaPoFakturzeBl(db, { now: D('2026-11-06T12:00:00Z') })
    expect(s).toMatchObject({ zamowien: 0, rezerwacji: 0, zgloszonych: 0, bledy: [] })
    expect(await db.reservation.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ state: 'ACTIVE', qtyBase: 3 })
    expect(await db.orderEvent.count({ where: { orderId: a, kind: ROZLICZENIE_PO_FAKTURZE_BL } })).toBe(0)
  })
})

describe('stare alerty nadmiaru', () => {
  it('zamknięte, gdy rezerwacje nie przekraczają max(0, stan); prawdziwy nadmiar zostaje; powtórka bez zmian', async () => {
    const x = await product(db, 'T-X', 0, { wfirmaGoodId: 'G-X' })
    const y = await product(db, 'T-Y', 2, { wfirmaGoodId: 'G-Y' })
    // x: stan −1 po ruchu biura, bez rezerwacji (alert sprzed poprawki); y: rezerwacje 2 przy stanie 1 (prawdziwy nadmiar)
    await db.stock.update({ where: { productId_warehouseId: { productId: x, warehouseId: 'glowny' } }, data: { physical: -1, pendingDelta: -1 } })
    await przyjmij([{ productId: y, qty: 2 }], null, D('2026-11-03T10:00:00Z'))
    await db.stock.update({ where: { productId_warehouseId: { productId: y, warehouseId: 'glowny' } }, data: { physical: 1, wfirmaCount: 1 } })
    for (const ref of [x, y])
      for (const kind of ['NADMIAR_REZERWACJI', 'NADMIAR_ZALEGLY']) await db.alert.create({ data: { kind, ref, message: 'test' } })
    const s = await samonaprawaPoFakturzeBl(db, { now: D('2026-11-10T20:00:00Z') })
    expect(s).toMatchObject({ zamowien: 0, nadmiarowZamknietych: 1, bledy: [] })
    expect(await db.alert.count({ where: { ref: x, closedAt: null } })).toBe(0)
    expect(await db.alert.count({ where: { ref: y, closedAt: null } })).toBe(2)
    expect(await samonaprawaPoFakturzeBl(db, { now: D('2026-11-10T20:05:00Z') })).toMatchObject({ nadmiarowZamknietych: 0 })
  })
})

describe('para od strony faktury: odczyty zamówień z BL i kandydaci bez numeru', () => {
  const naglowek = (blOrderId: number, externalRef: string, dateAdd: Date): BlOrderHeader => ({
    blOrderId,
    orderSource: 'shop',
    orderSourceId: 'sd',
    channel: 'WOO',
    channelAccountId: 'sd',
    externalRef,
    statusId: 2,
    deliveryMethod: null,
    paymentDone: null,
    totalGross: 30,
    confirmed: true,
    dateAdd,
    dateConfirmed: null,
  })

  it('nagłówek pobrany z BL trafia do kopii: drugi przebieg bez odczytu z BL, para po numerze ze sklepu po odłożeniu', async () => {
    const p = await product(db, 'T-K', 5, { wfirmaGoodId: 'G-K' })
    const orderId = await przyjmij([{ productId: p, qty: 1 }], null, D('2026-11-11T09:00:00Z'))
    // świeża faktura bez kopii zamówienia BL: odczyt numeru ze sklepu odłożony o godzinę
    bl.invoices = [{ invoice_id: 95, order_id: 7201, number: 'FV 50/11', type: 'normal', date_add: sec('2026-11-11T09:40:00Z') }]
    let pobran = 0
    const fetchBlOrder = async (id: number) => (pobran++, naglowek(id, 'N-7201', D('2026-11-11T09:00:00Z')))
    const odczyty: string[] = []
    const fill = async (id: string): Promise<WynikNumeru> => {
      odczyty.push(id)
      await db.order.update({ where: { id }, data: { channelNumber: 'N-7201' } })
      return 'OK'
    }
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T10:00:00Z'), initialLookbackMs: 24 * 3600_000, fetchBlOrder, uzupelnijNumer: fill })
    expect(pobran).toBe(1)
    expect(odczyty).toEqual([])
    // kopia bez nazwy statusu i z chwilą odczytu „nieznana”: nie udaje świeżego odczytu porównania
    expect(await db.blOrderSnapshot.findFirstOrThrow({ where: { blOrderId: 7201 } })).toMatchObject({ externalRef: 'N-7201', statusName: null, fetchedAt: new Date(0) })
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T10:02:00Z'), fetchBlOrder, uzupelnijNumer: fill })
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T10:04:00Z'), fetchBlOrder, uzupelnijNumer: fill })
    expect(pobran).toBe(1)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: null, appliedAt: null })
    const s = await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T10:45:00Z'), fetchBlOrder, uzupelnijNumer: fill })
    expect(pobran).toBe(1)
    expect(odczyty).toEqual([orderId])
    expect(s.pairedFromInvoice).toBe(1)
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(7201)
  })

  it('kopia zamówienia BL z porównania nie jest nadpisywana odczytem z parowania', async () => {
    await db.blOrderSnapshot.create({ data: { blOrderId: 7202, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: 'N-7202', statusId: 3, statusName: 'Nowe', dateAdd: D('2026-11-11T09:00:00Z'), fetchedAt: D('2026-11-11T09:30:00Z') } })
    bl.invoices = [{ invoice_id: 96, order_id: 7202, number: 'FV 51/11', type: 'normal', date_add: sec('2026-11-11T09:40:00Z') }]
    let pobran = 0
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T10:00:00Z'), initialLookbackMs: 24 * 3600_000, fetchBlOrder: async (id) => (pobran++, naglowek(id, 'INNY', D('2026-11-11T09:00:00Z'))) })
    expect(pobran).toBe(0)
    expect(await db.blOrderSnapshot.findFirstOrThrow({ where: { blOrderId: 7202 } })).toMatchObject({ externalRef: 'N-7202', statusName: 'Nowe' })
  })

  it('BL nie zna zamówienia: jeden odczyt z BL także przy odczycie numerów ze sklepu (znacznik końcowy)', async () => {
    bl.invoices = [{ invoice_id: 97, order_id: 7203, number: 'FV 52/11', type: 'normal', date_add: sec('2026-11-11T08:00:00Z') }]
    let pobran = 0
    const fill = async (): Promise<WynikNumeru> => 'OK'
    for (const t of ['2026-11-11T10:00:00Z', '2026-11-11T10:02:00Z', '2026-11-11T10:04:00Z'])
      await syncBlInvoices(db, bl.client(), null, { now: D(t), initialLookbackMs: 24 * 3600_000, fetchBlOrder: async () => (pobran++, null), uzupelnijNumer: fill })
    expect(pobran).toBe(1)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: expect.stringContaining('numer ze sklepu sprawdzony') })
  })

  it('21 kandydatów bez numeru w sklepie: odczytani wcześniej nie zajmują budżetu, właściwy odczytany w drugim przebiegu', async () => {
    const { p, orderId, wz } = await bezNumeru()
    const nowsze: string[] = []
    for (let i = 0; i < NUMBER_FETCH_BUDGET + 1; i++) nowsze.push(await przyjmij([{ productId: p, qty: 1 }], null, new Date(D('2026-10-24T15:00:00Z').getTime() + i * 60_000)))
    const odczyty: string[] = []
    const fill = async (id: string): Promise<WynikNumeru> => {
      odczyty.push(id)
      if (id !== orderId) return 'BRAK' // sklep nie zna zamówienia: numer się nie pojawi
      await db.order.update({ where: { id }, data: { channelNumber: 'N-8396' } })
      return 'OK'
    }
    const s1 = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:00:00Z'), uzupelnijNumer: fill })
    expect(s1.numbersRead).toBe(NUMBER_FETCH_BUDGET)
    expect(odczyty).not.toContain(orderId)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: null })
    const s2 = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:02:00Z'), uzupelnijNumer: fill })
    // drugi przebieg: tylko dwaj nieodczytani (ostatni z nowszych i właściwy), bez ponownego odczytu dwudziestu
    expect(s2).toMatchObject({ numbersRead: 2, pairedFromInvoice: 1, applied: 1 })
    expect(odczyty.slice(NUMBER_FETCH_BUDGET)).toEqual([nowsze[0], orderId])
    expect(new Set(odczyty).size).toBe(odczyty.length)
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(7001)
    // znacznik tylko na zamówieniach bez numeru; flagi rdzenia bez zmian
    const z = await db.order.findUniqueOrThrow({ where: { id: nowsze[3]! } })
    expect(z.flags).toMatchObject({ numerKanaluSprawdzony: '2026-11-11T10:00:00.000Z' })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).flags).not.toHaveProperty('numerKanaluSprawdzony')
    await expectInvariants(db)
  })

  it('wszyscy kandydaci odczytani wcześniej bez numeru: próba kompletna bez nowych odczytów; po dobie odczyt ponownie', async () => {
    const { p, wz } = await bezNumeru()
    for (let i = 0; i < NUMBER_FETCH_BUDGET + 1; i++) await przyjmij([{ productId: p, qty: 1 }], null, new Date(D('2026-10-24T15:00:00Z').getTime() + i * 60_000))
    let odczytow = 0
    const brak = async (): Promise<WynikNumeru> => (odczytow++, 'BRAK')
    await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:00:00Z'), uzupelnijNumer: brak })
    expect(odczytow).toBe(NUMBER_FETCH_BUDGET)
    await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:02:00Z'), uzupelnijNumer: brak })
    expect(odczytow).toBe(NUMBER_FETCH_BUDGET + 2) // ostatni z nowszych i właściwy (też bez numeru)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ lastError: expect.stringContaining('numer ze sklepu sprawdzony') })
    // nowa faktura do innego zamówienia BL z tym samym oknem: wszyscy kandydaci sprawdzeni w ostatniej dobie, bez odczytów
    await db.blOrderSnapshot.create({ data: { blOrderId: 7002, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: 'N-8397', statusId: 2, dateAdd: D('2026-10-24T15:30:00Z'), fetchedAt: D('2026-10-26T14:37:00Z') } })
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 98, blOrderId: 7002, number: 'FV 31/10', kind: 'normal', dateAdd: D('2026-11-10T08:00:00Z'), fetchedAt: D('2026-11-10T08:01:00Z') } })
    await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-11T10:04:00Z'), uzupelnijNumer: brak })
    expect(odczytow).toBe(NUMBER_FETCH_BUDGET + 2)
    expect(await db.blInvoiceSnapshot.findUniqueOrThrow({ where: { organizationId_blInvoiceId: { organizationId: ORG_A, blInvoiceId: 98 } } })).toMatchObject({ lastError: expect.stringContaining('numer ze sklepu sprawdzony') })
  })
})

describe('tor cienia faktur BL a raport rozjazdów i porównanie z BL (konto w podglądzie)', () => {
  const naglowek = (blOrderId: number, externalRef: string, dateAdd: Date): BlOrderHeader => ({
    blOrderId,
    orderSource: 'shop',
    orderSourceId: 'sd',
    channel: 'WOO',
    channelAccountId: 'sd',
    externalRef,
    statusId: 2,
    deliveryMethod: null,
    paymentDone: null,
    totalGross: 30,
    confirmed: true,
    dateAdd,
    dateConfirmed: null,
  })
  const MAP = { shopAccounts: ['sd'], empikAccountId: null }
  const KONTO = [{ channel: 'WOO' as const, channelAccountId: 'sd' }]

  it('kopia nagłówka z parowania (data 1970) i znacznik kandydatów nie zmieniają porównania z BL, raportu dziennego ani świeżości kopii konta', async () => {
    expect((await db.channelConfig.findFirstOrThrow({ where: { channel: 'WOO', channelAccountId: 'sd' } })).statusMode).toBe('CIEN')
    const { p, wz } = await bezNumeru()
    for (let i = 0; i < 3; i++) await przyjmij([{ productId: p, qty: 1 }], null, new Date(D('2026-11-10T15:00:00Z').getTime() + i * 60_000))
    // faktura do zamówienia BL bez kopii: nagłówek z odczytu po numerze, sklep nie zna żadnego kandydata
    bl.invoices = [...bl.invoices, { invoice_id: 91, order_id: 7210, number: 'FV 40/11', type: 'normal', date_add: sec('2026-11-11T08:00:00Z') }]
    const T = D('2026-11-11T10:00:00Z')
    await syncBlInvoices(db, bl.client(), wz, {
      now: T,
      fetchBlOrder: async (id) => (id === 7210 ? naglowek(7210, 'N-7210', D('2026-11-10T15:30:00Z')) : null),
      uzupelnijNumer: async (): Promise<WynikNumeru> => 'BRAK',
    })
    expect(await db.blOrderSnapshot.findFirstOrThrow({ where: { blOrderId: 7210 } })).toMatchObject({ statusName: null, fetchedAt: new Date(0) })
    const znaczniki = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Order" WHERE flags->>'numerKanaluSprawdzony' IS NOT NULL`
    expect(znaczniki[0]!.n).toBeGreaterThan(0)

    const T2 = D('2026-11-11T11:00:00Z')
    const porownaj = async () => (await runBlComparison(db, bl.client(), MAP, await accountsForComparison(db), { now: T2, windowMs: 48 * 3600_000, graceMs: 0 })).accounts
    const z1 = await porownaj()
    await db.importRun.create({ data: { kind: 'cien-bl', status: 'OK', startedAt: T2, finishedAt: T2, stats: JSON.parse(JSON.stringify({ accounts: z1 })) } })
    const r1 = await buildDailyReport(db, '2026-11-11', D('2026-11-11T12:00:00Z'))
    const s1 = await swiezoscKopii(db, KONTO, 3600_000)
    // kopia z parowania nie podnosi chwili ostatniej kopii konta (tylko kopia z porównania z 26.10)
    expect(s1.perKonto[0]!.ostatniaKopia).toEqual(D('2026-10-26T14:37:00Z'))

    // ten sam stan bez zapisów toru cienia
    await db.blOrderSnapshot.deleteMany({ where: { blOrderId: 7210 } })
    await db.$executeRaw`UPDATE "Order" SET flags = flags - 'numerKanaluSprawdzony' WHERE flags->>'numerKanaluSprawdzony' IS NOT NULL`
    const z2 = await porownaj()
    const r2 = await buildDailyReport(db, '2026-11-11', D('2026-11-11T12:00:00Z'))
    const s2 = await swiezoscKopii(db, KONTO, 3600_000)
    expect(z2).toEqual(z1)
    expect(r2).toEqual(r1)
    expect(s2).toEqual(s1)
  })

  it('konto, którego jedyną kopią jest kopia z parowania: ostatnia kopia z 1970, czyli nieświeża', async () => {
    bl.invoices = [{ invoice_id: 92, order_id: 7211, number: 'FV 41/11', type: 'normal', date_add: sec('2026-11-11T08:00:00Z') }]
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T10:00:00Z'), initialLookbackMs: 24 * 3600_000, fetchBlOrder: async (id) => naglowek(id, 'N-7211', D('2026-11-11T07:00:00Z')) })
    const s = await swiezoscKopii(db, KONTO, 3600_000)
    expect(s.perKonto[0]!.ostatniaKopia).toEqual(new Date(0))
  })
})

describe('faktura BL bez pary na koncie w trybie pracy', () => {
  async function fakturaBezPary(fakturaOd: string) {
    await db.blOrderSnapshot.create({ data: { blOrderId: 7301, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: 'N-7301', statusId: 2, dateAdd: D('2026-11-19T07:00:00Z'), fetchedAt: D('2026-11-19T07:30:00Z') } })
    bl.invoices = [{ invoice_id: 99, order_id: 7301, number: 'FV 60/11', type: 'normal', date_add: sec(fakturaOd) }]
  }
  const doPracy = () => db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })

  it('po 15 min alert z numerem zamówienia i procedurą; jeden na zamówienie BL; para go zamyka', async () => {
    await doPracy()
    await fakturaBezPary('2026-11-19T08:00:00Z')
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:10:00Z'), initialLookbackMs: 24 * 3600_000 })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_BEZ_PARY } })).toBe(0)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:16:00Z') })
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:18:00Z') })
    const al = await db.alert.findMany({ where: { kind: FAKTURA_BL_BEZ_PARY } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('FV 60/11')
    expect(al[0]!.message).toContain('N-7301')
    expect(al[0]!.message).toContain('„Do wyjaśnienia”')
    // zamówienie dotarło z numerem: para, alert zamknięty
    const p = await product(db, 'T-BP', 5, { wfirmaGoodId: 'G-BP' })
    const orderId = await przyjmij([{ productId: p, qty: 1 }], null, D('2026-11-19T07:00:00Z'))
    await db.order.update({ where: { id: orderId }, data: { channelNumber: 'N-7301' } })
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:20:00Z') })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(7301)
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_BEZ_PARY, closedAt: null } })).toBe(0)
  })

  it('konto w podglądzie: bez alertu', async () => {
    await fakturaBezPary('2026-11-19T08:00:00Z')
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T09:00:00Z'), initialLookbackMs: 24 * 3600_000 })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_BEZ_PARY } })).toBe(0)
  })
})

describe('faktura BL przy zamówieniu zafakturowanym już w Kompletorze (pełny przebieg odczytu faktur)', () => {
  const tryb = (statusMode: 'PRACA' | 'CIEN') => db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode } })

  /** Zamówienie bez pary spakowane i zafakturowane w Kompletorze, potem para i faktura z BaseLinkera. */
  async function zafakturowaneBezPary(blOrderId: number, numer: string, statusMode: 'PRACA' | 'CIEN' = 'PRACA', przedPrzebiegiem?: () => void): Promise<string> {
    const x = await product(db, `T-${blOrderId}`, 5, { wfirmaGoodId: `G-${blOrderId}` })
    const o = await przyjmij([{ productId: x, qty: 1 }], null, D('2026-11-20T08:00:00Z'))
    await tryb('PRACA')
    expect(await packOrder(db, o, { now: D('2026-11-20T08:10:00Z') })).toMatchObject({ status: 'SPAKOWANE' })
    expect(await issueInvoice(db, o, new FakeWfirma(), { now: D('2026-11-20T08:11:00Z') })).toBe('WYSTAWIONA')
    // stan po fakturze z Kompletora: rezerwacje zużyte, nic do rozliczenia fakturą BL
    expect(await db.reservation.count({ where: { orderId: o, state: 'ACTIVE' } })).toBe(0)
    expect(await db.reservation.count({ where: { orderId: o, state: 'CONSUMED' } })).toBe(1)
    await tryb(statusMode)
    await db.order.update({ where: { id: o }, data: { blOrderId } })
    bl.invoices = [{ invoice_id: blOrderId, order_id: blOrderId, number: numer, type: 'normal', date_add: sec('2026-11-20T08:30:00Z') }]
    const wz = new FakeWz()
    wz.docs.set(numer, [{ wfirmaGoodId: `G-${blOrderId}`, count: 1 }])
    przedPrzebiegiem?.()
    const s = await syncBlInvoices(db, bl.client(), wz, { now: D('2026-11-20T09:00:00Z'), initialLookbackMs: 24 * 3600_000 })
    bledyPrzebiegu = s.errors
    if (!przedPrzebiegiem) expect(s.errors).toEqual([])
    return o
  }
  let bledyPrzebiegu: string[] = []

  it('tryb pracy: alert o dwóch fakturach z numerem faktury BL, bez drugiego zdjęcia towaru; powtórka bez drugiego alertu', async () => {
    const o = await zafakturowaneBezPary(6601, 'FV 90/11')
    const al = await db.alert.findMany({ where: { kind: FAKTURA_BL_I_KOMPLETORA, ref: o } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('FV 90/11')
    expect(al[0]!.message).toContain('Towar zszedł ze stanu raz')
    expect(al[0]!.message).not.toContain('dwa razy')
    expect(await db.blInvoiceSnapshot.findFirstOrThrow({ where: { blOrderId: 6601 } })).toMatchObject({ outcome: 'NIC_DO_ROZLICZENIA', orderId: o })
    expect(await db.pendingMovement.count({ where: { orderId: o, type: 'BL_INVOICE' } })).toBe(0)
    await syncBlInvoices(db, bl.client(), new FakeWz(), { now: D('2026-11-20T09:05:00Z') })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_I_KOMPLETORA } })).toBe(1)
    await expectInvariants(db)
  })

  it('błąd przy zgłaszaniu alertu: faktura zakończona, błąd w błędach przebiegu', async () => {
    // w przebiegu odczyt prób faktury (część zgłoszenia alertu) kończy się wyjątkiem
    const spy = vi.spyOn(db.invoiceAttempt, 'count')
    const awaria = () => spy.mockRejectedValueOnce(new Error('awaria bazy przy alercie'))
    const o = await zafakturowaneBezPary(6604, 'FV 93/11', 'PRACA', awaria)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow({ where: { blOrderId: 6604 } })).toMatchObject({ outcome: 'NIC_DO_ROZLICZENIA', orderId: o, attempts: 0 })
    expect(bledyPrzebiegu).toEqual([expect.stringContaining('awaria bazy przy alercie')])
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_I_KOMPLETORA } })).toBe(0)
  })

  it('konto w podglądzie: bez alertu (bez zmian)', async () => {
    await zafakturowaneBezPary(6602, 'FV 91/11', 'CIEN')
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_I_KOMPLETORA } })).toBe(0)
  })

  it('zamówienie anulowane bez faktury z Kompletora: bez alertu', async () => {
    const x = await product(db, 'T-AN', 5, { wfirmaGoodId: 'G-AN' })
    const o = await przyjmij([{ productId: x, qty: 1 }], 6603, D('2026-11-20T08:00:00Z'))
    await tryb('PRACA')
    await cancelOrder(db, o, { now: D('2026-11-20T08:05:00Z') })
    bl.invoices = [{ invoice_id: 6603, order_id: 6603, number: 'FV 92/11', type: 'normal', date_add: sec('2026-11-20T08:30:00Z') }]
    await syncBlInvoices(db, bl.client(), new FakeWz(), { now: D('2026-11-20T09:00:00Z'), initialLookbackMs: 24 * 3600_000 })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow({ where: { blOrderId: 6603 } })).toMatchObject({ outcome: 'NIC_DO_ROZLICZENIA' })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_I_KOMPLETORA } })).toBe(0)
  })
})

describe('faktury BL bez pary: zamykanie po parze z innego toru, kandydaci sprawdzeni przed numerem, alert zbiorczy', () => {
  const doPracy = () => db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  const kopia = (blOrderId: number, dateAdd: Date) =>
    db.blOrderSnapshot.create({ data: { blOrderId, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: `N-${blOrderId}`, statusId: 2, dateAdd, fetchedAt: dateAdd } })
  /** Faktury BL bez pary do zamówień BL z kopią nagłówka (numer ze sklepu N-<id>), wystawione o 8:00. */
  async function fakturyBezPary(blOrderIds: number[]) {
    for (const id of blOrderIds) await kopia(id, D('2026-11-19T07:00:00Z'))
    bl.invoices = blOrderIds.map((id) => ({ invoice_id: id, order_id: id, number: `FV ${id}/11`, type: 'normal', date_add: sec('2026-11-19T08:00:00Z') }))
  }
  const otwarte = () => db.alert.findMany({ where: { kind: FAKTURA_BL_BEZ_PARY, closedAt: null }, orderBy: { ref: 'asc' } })
  async function sparuj(blOrderId: number) {
    const p = await product(db, `T-${blOrderId}`, 5, { wfirmaGoodId: `G-${blOrderId}` })
    await przyjmij([{ productId: p, qty: 1 }], blOrderId, D('2026-11-19T07:00:00Z'))
  }

  it('para zrobiona porównaniem z BL zamyka alert przy następnym odczycie faktur; numer ze sklepu i numer BL w odnośniku', async () => {
    await doPracy()
    await fakturyBezPary([7311])
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:16:00Z'), initialLookbackMs: 24 * 3600_000 })
    const al = await otwarte()
    expect(al.map((a) => a.ref)).toEqual(['N-7311 (BL 7311)'])
    expect(al[0]!.message).toContain('Jeśli takiego zamówienia w Kompletorze nie ma')
    expect(al[0]!.message).not.toContain('sklep nie podał numeru')
    // zamówienie dotarło ze sklepu, parę robi porównanie z BL (nie tor faktur)
    const p = await product(db, 'T-PR', 5, { wfirmaGoodId: 'G-PR' })
    const orderId = (await ingestOrder(db, order([{ productId: p, qty: 1 }], { externalId: 'N-7311', createdAtChannel: D('2026-11-19T07:00:00Z') }), { now: D('2026-11-19T08:17:00Z') })).orderId!
    const t = D('2026-11-19T07:00:00Z')
    await db.channelOrderSnapshot.create({
      data: { channel: 'WOO', channelAccountId: 'sd', externalId: 'N-7311', revision: '1', channelStatus: 'processing', lifecycle: 'OPEN', paymentState: 'PAID', totalGross: 30, currency: 'PLN', lineCount: 1, warnings: [], createdAtChannel: t, firstSeenAt: t, lastSeenAt: t, orderId },
    })
    bl.orders = [{ order_id: 7311, order_source: 'shop', order_source_id: 'sd', shop_order_id: 'N-7311', order_status_id: 2, date_add: sec('2026-11-19T07:00:00Z'), date_confirmed: sec('2026-11-19T07:00:00Z') }]
    await runBlComparison(db, bl.client(), { shopAccounts: ['sd'], empikAccountId: null }, await accountsForComparison(db), { now: D('2026-11-19T08:20:00Z'), windowMs: 48 * 3600_000, graceMs: 0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).blOrderId).toBe(7311)
    expect(await otwarte()).toHaveLength(1)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:22:00Z') })
    expect(await otwarte()).toHaveLength(0)
    // powtórka bez nowego alertu
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:24:00Z') })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_BEZ_PARY } })).toBe(1)
  })

  it('kandydat sprawdzony przed dodaniem zamówienia do BL jest czytany ponownie; sprawdzony później nie', async () => {
    const p = await product(db, 'T-W3', 5, { wfirmaGoodId: 'G-W3' })
    const przed = await przyjmij([{ productId: p, qty: 1 }], null, D('2026-11-11T09:00:00Z'))
    await db.order.update({ where: { id: przed }, data: { flags: { numerKanaluSprawdzony: '2026-11-11T09:10:00.000Z' } } })
    await kopia(7321, D('2026-11-11T09:30:00Z'))
    bl.invoices = [{ invoice_id: 7321, order_id: 7321, number: 'FV 7321/11', type: 'normal', date_add: sec('2026-11-11T09:35:00Z') }]
    const odczyty: string[] = []
    const fill = async (id: string): Promise<WynikNumeru> => {
      odczyty.push(id)
      await db.order.update({ where: { id }, data: { channelNumber: 'N-7321' } })
      return 'OK'
    }
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T11:00:00Z'), initialLookbackMs: 24 * 3600_000, uzupelnijNumer: fill })
    expect(odczyty).toEqual([przed])
    expect((await db.order.findUniqueOrThrow({ where: { id: przed } })).blOrderId).toBe(7321)

    // ten sam układ, ale odczyt po dodaniu zamówienia do BL: w ciągu doby bez ponownego odczytu
    const po = await przyjmij([{ productId: p, qty: 1 }], null, D('2026-11-11T09:00:00Z'))
    await db.order.update({ where: { id: po }, data: { flags: { numerKanaluSprawdzony: '2026-11-11T09:40:00.000Z' } } })
    await kopia(7322, D('2026-11-11T09:30:00Z'))
    bl.invoices = [...bl.invoices, { invoice_id: 7322, order_id: 7322, number: 'FV 7322/11', type: 'normal', date_add: sec('2026-11-11T09:35:00Z') }]
    odczyty.length = 0
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T11:05:00Z'), uzupelnijNumer: fill })
    expect(odczyty).toEqual([])
  })

  it('flagi zapisane jako JSON null: znacznik sprawdzenia trafia do obiektu flag', async () => {
    const p = await product(db, 'T-JN', 5, { wfirmaGoodId: 'G-JN' })
    const o = await przyjmij([{ productId: p, qty: 1 }], null, D('2026-11-11T09:00:00Z'))
    await db.$executeRaw`UPDATE "Order" SET flags = 'null'::jsonb WHERE id = ${o}`
    await kopia(7323, D('2026-11-11T09:30:00Z'))
    bl.invoices = [{ invoice_id: 7323, order_id: 7323, number: 'FV 7323/11', type: 'normal', date_add: sec('2026-11-11T09:35:00Z') }]
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-11T11:00:00Z'), initialLookbackMs: 24 * 3600_000, uzupelnijNumer: async (): Promise<WynikNumeru> => 'BRAK' })
    const t = await db.$queryRaw<{ t: string }[]>`SELECT jsonb_typeof(flags) AS t FROM "Order" WHERE id = ${o}`
    expect(t[0]!.t).toBe('object')
    expect((await db.order.findUniqueOrThrow({ where: { id: o } })).flags).toMatchObject({ numerKanaluSprawdzony: '2026-11-11T11:00:00.000Z' })
  })

  it('6 faktur bez pary konta: jeden alert zbiorczy z numerami; przy 5 pojedyncze; po parze wszystkich nic otwartego', async () => {
    await doPracy()
    const ids = [7331, 7332, 7333, 7334, 7335, 7336]
    await fakturyBezPary(ids)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:16:00Z'), initialLookbackMs: 24 * 3600_000 })
    let al = await otwarte()
    expect(al).toHaveLength(1)
    expect(al[0]!.dedupeKey).toBe('faktura-bl-bez-pary-konto:WOO:sd')
    for (const id of ids) expect(al[0]!.message).toContain(`N-${id}`)
    expect(al[0]!.message).toMatch(/^6 zamówień /)
    // powtórka: ten sam alert, bez nowych
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:18:00Z') })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_BEZ_PARY } })).toBe(1)
    // jedno sparowane: zostaje 5, zbiorczy zamknięty, pięć pojedynczych
    await sparuj(7331)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:20:00Z') })
    al = await otwarte()
    expect(al.map((a) => a.ref)).toEqual(ids.slice(1).map((id) => `N-${id} (BL ${id})`))
    // znowu 6 (nowa faktura): pojedyncze zamknięte, jeden nowy zbiorczy
    await kopia(7337, D('2026-11-19T07:00:00Z'))
    bl.invoices = [...bl.invoices, { invoice_id: 7337, order_id: 7337, number: 'FV 7337/11', type: 'normal', date_add: sec('2026-11-19T08:00:00Z') }]
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:22:00Z') })
    al = await otwarte()
    expect(al).toHaveLength(1)
    expect(al[0]!.dedupeKey).toBe('faktura-bl-bez-pary-konto:WOO:sd')
    expect(al[0]!.message).not.toContain('N-7331')
    expect(al[0]!.message).toContain('N-7337')
    // wszystkie sparowane: nic otwartego
    for (const id of [...ids.slice(1), 7337]) await sparuj(id)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:24:00Z') })
    expect(await otwarte()).toHaveLength(0)
  })

  it('zbiorczy przy 6: siódma faktura zamyka stary i daje nowy (z numerami w odnośniku); sparowanie jednej odświeża w miejscu', async () => {
    await doPracy()
    const ids = [7341, 7342, 7343, 7344, 7345, 7346]
    await fakturyBezPary(ids)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:16:00Z'), initialLookbackMs: 24 * 3600_000 })
    const [pierwszy] = await otwarte()
    expect(pierwszy!.ref).toBe('WOO_SD test: 6 faktur bez zamówienia: N-7341, N-7342, N-7343, N-7344, N-7345, N-7346')
    expect(pierwszy!.data).toEqual({ blOrderIds: ids })
    // siódma: stary zamknięty, nowy wiersz (nowa wiadomość, góra pulpitu)
    await kopia(7347, D('2026-11-19T07:00:00Z'))
    bl.invoices = [...bl.invoices, { invoice_id: 7347, order_id: 7347, number: 'FV 7347/11', type: 'normal', date_add: sec('2026-11-19T08:00:00Z') }]
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:18:00Z') })
    let al = await otwarte()
    expect(al).toHaveLength(1)
    expect(al[0]!.id).not.toBe(pierwszy!.id)
    expect(al[0]!.message).toMatch(/^7 zamówień /)
    expect(al[0]!.message).toContain('N-7347')
    expect((await db.alert.findUniqueOrThrow({ where: { id: pierwszy!.id } })).closedAt).not.toBeNull()
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_BEZ_PARY } })).toBe(2)
    // sparowanie jednej: lista maleje, ten sam wiersz z nową treścią
    const drugi = al[0]!
    await sparuj(7341)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:20:00Z') })
    al = await otwarte()
    expect(al.map((a) => a.id)).toEqual([drugi.id])
    expect(al[0]!.message).toMatch(/^6 zamówień /)
    expect(al[0]!.message).not.toContain('N-7341')
    expect(al[0]!.ref).toContain('6 faktur bez zamówienia: N-7342')
    expect(al[0]!.data).toEqual({ blOrderIds: [7342, 7343, 7344, 7345, 7346, 7347] })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_BEZ_PARY } })).toBe(2)
  })

  it('długie numery ze sklepu: treść w limicie, skrócona lista, instrukcja na końcu cała; odnośnik do 120 znaków', async () => {
    await doPracy()
    const ids = Array.from({ length: 30 }, (_, i) => 7500 + i)
    for (const id of ids)
      await db.blOrderSnapshot.create({ data: { blOrderId: id, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: `MARKETPLACE-${id}-${'X'.repeat(60)}`, statusId: 2, dateAdd: D('2026-11-19T07:00:00Z'), fetchedAt: D('2026-11-19T07:00:00Z') } })
    bl.invoices = ids.map((id) => ({ invoice_id: id, order_id: id, number: `FV ${id}/11`, type: 'normal', date_add: sec('2026-11-19T08:00:00Z') }))
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:16:00Z'), initialLookbackMs: 24 * 3600_000 })
    const al = await otwarte()
    expect(al).toHaveLength(1)
    expect(al[0]!.message.length).toBeLessThanOrEqual(2000)
    expect(al[0]!.message).toMatch(/kolejnych\. /)
    expect(al[0]!.message).toMatch(/to zgłoszenie się zamknie, a każde z nich dostanie własne\.$/)
    expect(al[0]!.ref.length).toBeLessThanOrEqual(120)
    expect(al[0]!.ref).toMatch(/^WOO_SD test: 30 faktur bez zamówienia/)
  })

  it('35 faktur bez pary: w treści 30 numerów i „5 kolejnych”; lista odświeża się w tym samym zgłoszeniu', async () => {
    await doPracy()
    const ids = Array.from({ length: 35 }, (_, i) => 7400 + i)
    await fakturyBezPary(ids)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:16:00Z'), initialLookbackMs: 24 * 3600_000 })
    let al = await otwarte()
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('N-7429 i 5 kolejnych')
    expect(al[0]!.message).not.toContain('N-7430')
    await sparuj(7400)
    await syncBlInvoices(db, bl.client(), null, { now: D('2026-11-19T08:18:00Z') })
    al = await otwarte()
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toMatch(/^34 zamówień /)
    expect(al[0]!.message).toContain('N-7430 i 4 kolejnych')
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_BEZ_PARY } })).toBe(1)
  })
})
