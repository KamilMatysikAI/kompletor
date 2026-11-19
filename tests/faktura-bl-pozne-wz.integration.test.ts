// Faktura BL skopiowana, zanim BL dopisał numer wFirmy: ponowny odczyt numeru przed uznaniem „bez WZ”, naprawa wstecz
// ruchu „faktura z BL bez WZ”, gdy WZ znajdzie się później, i przycisk „Poprawione w wFirmie” na liście braków
// (uprawnienie, historia, dziennik, ponowne kliknięcie, konto w podglądzie). BL i wFirma wyłącznie atrapy, dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PrismaClient } from '@prisma/client'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { runBlComparison } from '@/lib/cien/bl-porownanie'
import { MAX_ODCZYTOW_NUMERU, POZNE_WZ_ODSTEPY_MS, syncBlInvoices, WZ_MAX_ATTEMPTS, type WzLine, type WzOdczyt } from '@/lib/cien/faktury-bl'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { kontoWPodgladzie } from '@/lib/rdzen/faktura-bl'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { automatWzObejmie, PackError, POWOD_AUTOMAT_WZ, potwierdzPoprawioneWWfirmie, rozliczPozneWzFakturyBl } from '@/lib/rdzen/rozchod'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { testDb, testSystemDb, truncateAll } from './db'
import { FakeBl, sec } from './bl-atrapa'
import { expectInvariants, offer, product, seedBase, stockOf } from './rdzen-fixtures'

const sesja: { db: PrismaClient | null; uprawnienia: Set<string>; userId: string } = { db: null, uprawnienia: new Set(), userId: '' }
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`PRZEKIEROWANIE ${url}`)
  },
}))
vi.mock('@/lib/panel/kontekst', () => ({
  requireSession: async () => ({ db: sesja.db, permissions: sesja.uprawnienia, user: { id: sesja.userId }, organization: { organizationId: 'org-a' } }),
  requirePermission: async (p: string) => {
    if (!sesja.uprawnienia.has(p)) throw new Error(`brak uprawnienia ${p}`)
    return { db: sesja.db, permissions: sesja.uprawnienia, user: { id: sesja.userId }, organization: { organizationId: 'org-a' } }
  },
}))
const { poprawioneWWfirmie, skutekPoprawionegoWWfirmie } = await import('@/app/(panel)/braki/akcje')
const { default: Braki } = await import('@/app/(panel)/braki/page')

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await sys.$disconnect()
})

const T = new Date('2026-10-28T09:00:00.000Z')
const min = (n: number) => new Date(T.getTime() + n * 60_000)
const SRC = { env: {}, envFallback: false }
const MAP = { shopAccounts: ['sd'], empikAccountId: null }
const NR_BL = 'FV 605/10/2026'
const NR_WF = 'FW 3/28/10/26'

class FakeWz implements WzOdczyt {
  docs = new Map<string, WzLine[]>()
  pytania: string[] = []
  async wzForInvoice(n: string): Promise<WzLine[] | null> {
    this.pytania.push(n)
    return this.docs.get(n) ?? null
  }
}

let state: FakeChannelState
let registry: AdapterRegistry
let bl: FakeBl
let a: string

/** Zamówienie z cienia (2 szt. produktu A) połączone z BL 7001 przez porównanie. */
async function zamowienieZBl(): Promise<string> {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
  const acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
  state.upsertOrder(fakeOrder({ externalId: '501', createdAt: min(-60), revision: min(-60).toISOString(), totalGross: 40, lines: [{ externalLineId: '1', offerExternalId: '10', qty: 2, unitPriceGross: 20, vatRate: '23' }] }))
  await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(-50), initialLookbackMs: 3 * 3600_000 })
  bl.orders = [{ order_id: 7001, order_source: 'shop', order_source_id: 'sd', shop_order_id: 501, order_status_id: 2, date_add: sec(min(-59)), date_confirmed: sec(min(-59)), delivery_price: 0, products: [{ price_brutto: 20, quantity: 2 }] }]
  await runBlComparison(db, bl.client(), MAP, await accountsForComparison(db), { now: min(-10), windowMs: 4 * 3600_000, graceMs: 0 })
  const o = await db.order.findFirstOrThrow({ where: { externalId: '501' } })
  expect(o.blOrderId).toBe(7001)
  return o.id
}

/** Faktura BL bez numeru wFirmy (BL jeszcze go nie dopisał). */
const faktura = () => ({ invoice_id: 89, order_id: 7001, number: NR_BL, type: 'normal', date_add: sec(min(-1)), invoice_fullname: 'Jan Testowy' })
const odczytyNumeru = () => bl.calls.filter((c) => c.method === 'getInvoices' && c.params['invoice_id'] !== undefined).length
/** Odczyt stanu z wFirmy po chwili `at` (stan wFirmy już po WZ). */
const odczytWfirmy = (count: number, at: Date) => applyStockRead(db, { productId: a, countBase: count, requestSentAt: at }, { now: at })

/** Faktura rozliczona bez WZ po wyczerpaniu prób: ruch MANUAL pod numerem BL. */
async function rozliczonaBezWz(wz: FakeWz): Promise<number> {
  let t = 0
  for (let i = 0; i < WZ_MAX_ATTEMPTS + 1; i++) await syncBlInvoices(db, bl.client(), wz, { now: min(2 * i) })
  t = 2 * (WZ_MAX_ATTEMPTS + 1)
  expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ outcome: 'BEZ_WZ', externalNumber: null })
  expect(await db.pendingMovement.findFirstOrThrow({ where: { type: 'BL_INVOICE' } })).toMatchObject({ state: 'MANUAL', wfirmaDocId: NR_BL, delta: -2, wzQty: 0 })
  return t
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
  bl = new FakeBl()
  a = await product(db, 'A', 20)
  await db.product.update({ where: { id: a }, data: { wfirmaGoodId: '100' } })
  await offer(db, 'WOO_SD', '10', a)
  sesja.db = db
  sesja.uprawnienia = new Set()
  sesja.userId = ''
})

describe('numer wFirmy dopisany w BL po skopiowaniu faktury', () => {
  it('kopia bez numeru, BL dopisuje go chwilę później: numer czytany z BL ponownie, WZ znalezione po nim, bez ruchu MANUAL', async () => {
    const orderId = await zamowienieZBl()
    const wz = new FakeWz()
    wz.docs.set(NR_WF, [{ wfirmaGoodId: '100', count: 2 }]) // WZ w wFirmie jest od razu, pod numerem wFirmy
    bl.invoices = [faktura()]
    const s1 = await syncBlInvoices(db, bl.client(), wz, { now: min(0) })
    expect(s1.waitingForWz).toBe(1)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ externalNumber: null, appliedAt: null })
    // BL dopisuje numer z wFirmy kilka sekund po fakturze; lista faktur od ostatniego id już jej nie zwraca
    bl.invoices = [{ ...faktura(), external_invoice_number: NR_WF }]
    const s2 = await syncBlInvoices(db, bl.client(), wz, { now: min(2) })
    expect(s2.applied).toBe(1)
    expect(s2.numeryWfirmyDoczytane).toBe(1)
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ externalNumber: NR_WF, outcome: 'ZASTOSOWANA', orderId })
    expect(await db.pendingMovement.count({ where: { state: 'MANUAL' } })).toBe(0)
    expect(await db.pendingMovement.findFirstOrThrow()).toMatchObject({ type: 'BL_INVOICE', state: 'APPLIED', wfirmaDocId: NR_WF, wzQty: 2, delta: -2 })
    // stan wFirmy już po WZ (20 − 2): odczyt potwierdza ruch, sztuki schodzą raz
    await odczytWfirmy(18, min(3))
    expect(await stockOf(db, a)).toMatchObject({ physical: 18, pendingDelta: 0, reserved: 0, available: 18 })
    await expectInvariants(db)
  })

  it('faktura z numerem wFirmy od razu: BL nie jest odpytywany o numer', async () => {
    await zamowienieZBl()
    const wz = new FakeWz()
    wz.docs.set(NR_WF, [{ wfirmaGoodId: '100', count: 2 }])
    bl.invoices = [{ ...faktura(), external_invoice_number: NR_WF }]
    await syncBlInvoices(db, bl.client(), wz, { now: min(0) })
    expect(odczytyNumeru()).toBe(0)
    expect(await db.pendingMovement.findFirstOrThrow()).toMatchObject({ state: 'APPLIED', wfirmaDocId: NR_WF })
  })

  it('odczytów numeru z BL najwyżej MAX_ODCZYTOW_NUMERU w przebiegu', async () => {
    // 25 zamówień BL z aktywną rezerwacją i fakturą bez numeru wFirmy
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
    const acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    for (let i = 0; i < 25; i++)
      state.upsertOrder(fakeOrder({ externalId: String(600 + i), createdAt: min(-60), revision: min(-60).toISOString(), totalGross: 20, lines: [{ externalLineId: '1', offerExternalId: '10', qty: 1, unitPriceGross: 20, vatRate: '23' }] }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(-50), initialLookbackMs: 3 * 3600_000 })
    bl.orders = Array.from({ length: 25 }, (_, i) => ({ order_id: 8000 + i, order_source: 'shop', order_source_id: 'sd', shop_order_id: 600 + i, order_status_id: 2, date_add: sec(min(-59)), date_confirmed: sec(min(-59)), delivery_price: 0, products: [{ price_brutto: 20, quantity: 1 }] }))
    await runBlComparison(db, bl.client(), MAP, await accountsForComparison(db), { now: min(-10), windowMs: 4 * 3600_000, graceMs: 0 })
    expect(await db.order.count({ where: { blOrderId: { not: null } } })).toBe(25)
    bl.invoices = Array.from({ length: 25 }, (_, i) => ({ invoice_id: 100 + i, order_id: 8000 + i, number: `FV ${i + 1}/10/2026`, type: 'normal', date_add: sec(min(-1)) }))
    await syncBlInvoices(db, bl.client(), new FakeWz(), { now: min(0) })
    expect(odczytyNumeru()).toBe(MAX_ODCZYTOW_NUMERU)
  })
})

describe('naprawa wstecz: faktura rozliczona bez WZ, WZ znalezione później', () => {
  it('ruch MANUAL pod numerem BL: po dopisaniu numeru w BL rozliczony jak zwykle, stan schodzi raz, ponowny przebieg bez zmian', async () => {
    const orderId = await zamowienieZBl()
    const wz = new FakeWz()
    bl.invoices = [faktura()]
    const t = await rozliczonaBezWz(wz)
    // stan przed naprawą: wFirma 20 (WZ jeszcze nie ma), Kompletor 18 z ruchem MANUAL
    await odczytWfirmy(20, min(t))
    expect(await stockOf(db, a)).toMatchObject({ physical: 18, pendingDelta: -2 })
    // biuro przenosi fakturę do wFirmy z WZ: BL dopisuje numer, stan wFirmy spada do 18
    bl.invoices = [{ ...faktura(), external_invoice_number: NR_WF }]
    wz.docs.set(NR_WF, [{ wfirmaGoodId: '100', count: 2 }])
    const s = await syncBlInvoices(db, bl.client(), wz, { now: min(t + 60) })
    expect(s.pozneWz).toBe(1)
    expect(await db.pendingMovement.findFirstOrThrow({ where: { type: 'BL_INVOICE' } })).toMatchObject({ state: 'APPLIED', wfirmaDocId: NR_WF, wzQty: 2, delta: -2 })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ externalNumber: NR_WF, outcome: 'ZASTOSOWANA' })
    expect(await db.orderEvent.findFirstOrThrow({ where: { orderId, kind: 'WZ_PO_NUMERZE_WFIRMY' } })).toMatchObject({ actorId: 'system:cien-bl', data: { faktura: NR_BL, numerWfirmy: NR_WF, ruchy: 1 } })
    await odczytWfirmy(18, min(t + 61))
    expect(await stockOf(db, a)).toMatchObject({ physical: 18, pendingDelta: 0, available: 18 })
    // ponowny przebieg: nic do zrobienia, stan bez zmian
    const s2 = await syncBlInvoices(db, bl.client(), wz, { now: min(t + 600) })
    expect(s2.pozneWz).toBeUndefined()
    expect(await stockOf(db, a)).toMatchObject({ physical: 18, pendingDelta: 0 })
    await expectInvariants(db)
  })

  it('stan po WZ od dawna w wFirmie (przypadek z 28.10): po naprawie Kompletor = wFirma, bez podwójnego zdjęcia', async () => {
    await zamowienieZBl()
    const wz = new FakeWz()
    bl.invoices = [faktura()]
    const t = await rozliczonaBezWz(wz)
    // WZ było w wFirmie od początku (pod numerem wFirmy), więc wFirma pokazuje 18, a Kompletor odjął drugi raz: 16
    await odczytWfirmy(18, min(t))
    expect(await stockOf(db, a)).toMatchObject({ physical: 16, pendingDelta: -2 })
    bl.invoices = [{ ...faktura(), external_invoice_number: NR_WF }]
    wz.docs.set(NR_WF, [{ wfirmaGoodId: '100', count: 2 }])
    await syncBlInvoices(db, bl.client(), wz, { now: min(t + 60) })
    await odczytWfirmy(18, min(t + 61))
    expect(await stockOf(db, a)).toMatchObject({ physical: 18, pendingDelta: 0, available: 18 })
    await expectInvariants(db)
  })

  it('kolejne sprawdzenia w odstępach: przed terminem BL i wFirma nie są odpytywane o tę fakturę', async () => {
    await zamowienieZBl()
    const wz = new FakeWz()
    bl.invoices = [faktura()]
    const t = await rozliczonaBezWz(wz)
    const m = await db.pendingMovement.findFirstOrThrow({ where: { type: 'BL_INVOICE' } })
    expect(m.nextWzReadAt).not.toBeNull()
    const przed = odczytyNumeru()
    const pytania = wz.pytania.length
    await syncBlInvoices(db, bl.client(), wz, { now: new Date(m.nextWzReadAt!.getTime() - 60_000) })
    expect(odczytyNumeru()).toBe(przed)
    expect(wz.pytania.length).toBe(pytania)
    await syncBlInvoices(db, bl.client(), wz, { now: new Date(m.nextWzReadAt!.getTime() + 1) })
    expect(odczytyNumeru()).toBe(przed + 1)
    const m2 = await db.pendingMovement.findFirstOrThrow({ where: { id: m.id } })
    expect(m2.state).toBe('MANUAL')
    expect(m2.nextWzReadAt!.getTime()).toBeGreaterThanOrEqual(m.nextWzReadAt!.getTime() + POZNE_WZ_ODSTEPY_MS[1]!)
    expect(t).toBeGreaterThan(0)
  })

  /** Ruch faktury BL zamówienia wpisany wprost (dane fikcyjne). */
  const ruch = (orderId: string, id: string, delta: number, state: 'MANUAL' | 'APPLIED' | 'CONFIRMED', doc: string, wzQty: number) =>
    db.pendingMovement.create({ data: { id, productId: a, warehouseId: DEFAULT_WAREHOUSE, delta, type: 'BL_INVOICE', state, sentAt: min(0), effectiveAt: min(0), wfirmaDocId: doc, wzQty, orderId, idempotencyKey: `test:${id}` } })

  it('dwa ruchy jednego produktu, WZ na 2 szt., dwa przebiegi: zamknięty tylko ruch mieszczący się w WZ, z ruchów schodzą najwyżej 2 szt.', async () => {
    const orderId = await zamowienieZBl()
    await ruch(orderId, 'ruch-a1', -1, 'MANUAL', NR_BL, 0)
    await ruch(orderId, 'ruch-a2', -2, 'MANUAL', NR_BL, 0)
    await odczytWfirmy(20, min(1))
    expect(await stockOf(db, a)).toMatchObject({ pendingDelta: -3 })
    expect(await rozliczPozneWzFakturyBl(db, orderId, NR_BL, NR_WF, { [a]: 2 }, { now: min(10) })).toBe(1)
    expect(await rozliczPozneWzFakturyBl(db, orderId, NR_BL, NR_WF, { [a]: 2 }, { now: min(20) })).toBe(0)
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: 'ruch-a1' } })).toMatchObject({ state: 'APPLIED', wfirmaDocId: NR_WF })
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: 'ruch-a2' } })).toMatchObject({ state: 'MANUAL', wfirmaDocId: NR_BL })
    await odczytWfirmy(18, min(21))
    expect(await stockOf(db, a)).toMatchObject({ pendingDelta: -2, physical: 16 })
  })

  it('ruch tego zamówienia już rozliczony tym WZ: naprawa wstecz nie zamyka drugiego ruchu ponad ilość z WZ', async () => {
    const orderId = await zamowienieZBl()
    await ruch(orderId, 'ruch-b1', -2, 'APPLIED', NR_WF, 2) // nowa rezerwacja rozliczona tym WZ
    await ruch(orderId, 'ruch-b2', -2, 'MANUAL', NR_BL, 0)
    expect(await rozliczPozneWzFakturyBl(db, orderId, NR_BL, NR_WF, { [a]: 2 }, { now: min(10) })).toBe(0)
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: 'ruch-b2' } })).toMatchObject({ state: 'MANUAL' })
    // to samo przy ruchu już potwierdzonym odczytem pod starym numerem
    await db.pendingMovement.update({ where: { id: 'ruch-b1' }, data: { state: 'CONFIRMED', wfirmaDocId: NR_BL } })
    expect(await rozliczPozneWzFakturyBl(db, orderId, NR_BL, NR_WF, { [a]: 2 }, { now: min(20) })).toBe(0)
    // WZ pokrywa oba ruchy: drugi zamknięty
    expect(await rozliczPozneWzFakturyBl(db, orderId, NR_BL, NR_WF, { [a]: 4 }, { now: min(30) })).toBe(1)
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: 'ruch-b2' } })).toMatchObject({ state: 'APPLIED', wfirmaDocId: NR_WF })
  })

  it('WZ z tym numerem rozliczone już przy innym zamówieniu: ruch zostaje MANUAL', async () => {
    await zamowienieZBl()
    const wz = new FakeWz()
    bl.invoices = [faktura()]
    const t = await rozliczonaBezWz(wz)
    await db.pendingMovement.create({ data: { productId: a, warehouseId: DEFAULT_WAREHOUSE, delta: -1, type: 'BL_INVOICE', state: 'CONFIRMED', sentAt: min(0), wfirmaDocId: NR_WF, wzQty: 1, orderId: 'inne-zamowienie', idempotencyKey: 'inne' } })
    bl.invoices = [{ ...faktura(), external_invoice_number: NR_WF }]
    wz.docs.set(NR_WF, [{ wfirmaGoodId: '100', count: 2 }])
    await syncBlInvoices(db, bl.client(), wz, { now: min(t + 60) })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { wfirmaDocId: NR_BL } })).toMatchObject({ state: 'MANUAL' })
  })
})

describe('faktury nie ma w wFirmie (przypadek Herbolady): ruch zostaje, zamyka biuro przyciskiem', () => {
  it('BL nigdy nie dopisuje numeru: ruch MANUAL zostaje; „Poprawione w wFirmie” zamyka go raz, z historią i dziennikiem; konto w podglądzie, nic do sklepu', async () => {
    const orderId = await zamowienieZBl()
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(await kontoWPodgladzie(db, o)).toBe(true)
    const wz = new FakeWz()
    bl.invoices = [faktura()]
    const t = await rozliczonaBezWz(wz)
    for (let i = 1; i <= 6; i++) await syncBlInvoices(db, bl.client(), wz, { now: min(t + i * 7 * 60) })
    const m = await db.pendingMovement.findFirstOrThrow({ where: { type: 'BL_INVOICE' } })
    expect(m.state).toBe('MANUAL')
    await odczytWfirmy(20, min(t + 100))
    expect(await stockOf(db, a)).toMatchObject({ physical: 18, pendingDelta: -2 })

    // bez uprawnienia: odmowa po stronie serwera, ruch bez zmian
    sesja.uprawnienia = new Set(['panel.podglad', 'braki.decyzje'])
    sesja.userId = 'u-biuro'
    await expect(poprawioneWWfirmie(m.id)).rejects.toThrow(/brak uprawnienia zamowienia\.faktury/)
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ state: 'MANUAL' })

    sesja.uprawnienia = new Set(['panel.podglad', 'zamowienia.faktury'])
    const outboxPrzed = await db.outboxEvent.count()
    const idsPrzed = (await db.outboxEvent.findMany({ select: { id: true } })).map((x) => x.id)
    expect(await poprawioneWWfirmie(m.id)).toEqual({ blad: null, juzZamkniete: false })
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ state: 'APPLIED', wzQty: 2, wfirmaDocId: NR_BL })
    const nowe = await db.outboxEvent.findMany({ where: { id: { notIn: idsPrzed } } })
    expect(nowe.map((x) => x.kind)).toEqual(['WFIRMA_READ'])
    expect(await db.orderEvent.findMany({ where: { orderId, kind: 'POPRAWIONE_W_WFIRMIE' }, select: { actorId: true, data: true } })).toEqual([{ actorId: 'u-biuro', data: { ruch: m.id, rodzaj: 'BL_INVOICE', ilosc: 2, dokument: NR_BL } }])
    expect(await db.auditLog.findFirstOrThrow({ where: { entity: 'PendingMovement', entityId: m.id } })).toMatchObject({ actorId: 'u-biuro' })

    // drugie kliknięcie: nic się nie zmienia
    expect(await poprawioneWWfirmie(m.id)).toEqual({ blad: null, juzZamkniete: true })
    expect(await db.orderEvent.count({ where: { orderId, kind: 'POPRAWIONE_W_WFIRMIE' } })).toBe(1)
    expect(await db.auditLog.count({ where: { entity: 'PendingMovement', entityId: m.id } })).toBe(1)
    expect(await db.outboxEvent.count()).toBe(outboxPrzed + 1)

    // odczyt wFirmy po kliknięciu (akcja panelu ma zegar bieżący): Kompletor = wFirma
    await odczytWfirmy(20, new Date(Date.now() + 1000))
    expect(await stockOf(db, a)).toMatchObject({ physical: 20, pendingDelta: 0 })
    // późniejsze przebiegi nie ruszają zamkniętego (potwierdzonego odczytem) ruchu
    await syncBlInvoices(db, bl.client(), wz, { now: min(t + 2000) })
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ state: 'CONFIRMED' })
    await expectInvariants(db)
  })

  it('nieznana albo zła pozycja: czytelna odmowa, bez zmian', async () => {
    sesja.uprawnienia = new Set(['zamowienia.faktury'])
    sesja.userId = 'u-biuro'
    expect(await poprawioneWWfirmie('nieistniejacy1')).toEqual({ blad: 'Nie ma takiej pozycji do poprawy.' })
    expect(await poprawioneWWfirmie('../x')).toEqual({ blad: 'Nie ma takiej pozycji do poprawy.' })
    await expect(potwierdzPoprawioneWWfirmie(db, 'nieistniejacy2')).rejects.toBeInstanceOf(PackError)
  })

  it('ostatnia pozycja faktury bez WZ zamknięta przyciskiem: alert „faktura bez WZ” tej faktury zamknięty', async () => {
    await zamowienieZBl()
    const wz = new FakeWz()
    bl.invoices = [faktura()]
    await rozliczonaBezWz(wz)
    const m = await db.pendingMovement.findFirstOrThrow({ where: { type: 'BL_INVOICE' } })
    await db.alert.create({ data: { kind: 'FAKTURA_BEZ_WZ', ref: m.orderId!, message: 'test', dedupeKey: `faktura-bez-wz:${NR_BL}` } })
    await potwierdzPoprawioneWWfirmie(db, m.id, { actorId: 'u-biuro' })
    expect(await db.alert.findFirstOrThrow({ where: { kind: 'FAKTURA_BEZ_WZ' } })).toMatchObject({ dedupeKey: null })
    expect((await db.alert.findFirstOrThrow({ where: { kind: 'FAKTURA_BEZ_WZ' } })).closedAt).not.toBeNull()
  })
})

describe('okno potwierdzenia: skutek liczbami z bieżącego stanu, blokada przy automacie WZ', () => {
  it('faktura bez WZ: liczby z aktualnego odczytu wFirmy i znacznik braku WZ; po zamknięciu pozycja nie ma skutku', async () => {
    await zamowienieZBl()
    const wz = new FakeWz()
    bl.invoices = [faktura()]
    const t = await rozliczonaBezWz(wz)
    await odczytWfirmy(20, min(t))
    const m = await db.pendingMovement.findFirstOrThrow({ where: { type: 'BL_INVOICE' } })
    sesja.uprawnienia = new Set(['panel.podglad'])
    await expect(skutekPoprawionegoWWfirmie(m.id)).rejects.toThrow(/brak uprawnienia zamowienia\.faktury/)
    sesja.uprawnienia = new Set(['panel.podglad', 'zamowienia.faktury'])
    sesja.userId = 'u-biuro'
    expect(await skutekPoprawionegoWWfirmie(m.id)).toEqual({ blad: null, skutek: { rodzaj: 'BL_INVOICE', ilosc: 2, jednostka: 'SZT', wfirma: 20, dostepnyPrzed: 18, dostepnyPo: 20, fakturaBezWz: NR_BL, blokada: null } })
    // nowszy odczyt wFirmy: okno liczy z niego, nie z danych strony
    await odczytWfirmy(15, min(t + 1))
    expect((await skutekPoprawionegoWWfirmie(m.id)).skutek).toMatchObject({ wfirma: 15, dostepnyPrzed: 13, dostepnyPo: 15 })
    // samo okno niczego nie zapisuje
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ state: 'MANUAL' })
    await poprawioneWWfirmie(m.id)
    expect(await skutekPoprawionegoWWfirmie(m.id)).toEqual({ blad: 'Ta pozycja jest już zamknięta albo jej nie ma: odśwież stronę.' })
    expect(await skutekPoprawionegoWWfirmie('../x')).toEqual({ blad: 'Nie ma takiej pozycji do poprawy.' })
  })

  const OD = new Date('2026-10-20T00:00:00.000Z')
  const automatWz = (on: boolean) => db.organization.updateMany({ data: { settings: { faktury: { program: 'wfirma', wzBezFaktury: on, wzBezFakturyOd: OD.toISOString(), fakturyWlaczone: true, fakturyWlaczoneOd: OD.toISOString() } } } })
  const wydaneBezDokumentu = (orderId: string, sentAt: Date) =>
    db.pendingMovement.create({ data: { productId: a, warehouseId: DEFAULT_WAREHOUSE, delta: -2, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL', sentAt, effectiveAt: sentAt, wzQty: 0, orderId, idempotencyKey: `bez-dokumentu:${orderId}:1:${a}` } })
  const html = async () => renderToStaticMarkup(await Braki({ searchParams: Promise.resolve({ lista: 'wfirma' }) }))

  it('„wydane bez dokumentu” przy włączonym automacie WZ: przycisk nieaktywny z powodem, serwer odmawia; z błędem WZ albo bez automatu biuro zamyka', async () => {
    const orderId = await zamowienieZBl()
    const m = await wydaneBezDokumentu(orderId, min(0))
    sesja.uprawnienia = new Set(['panel.podglad', 'zamowienia.faktury'])
    sesja.userId = 'u-biuro'
    await automatWz(true)
    expect(automatWzObejmie(m, OD)).toBe(true)
    expect(await html()).toContain(`data-powod="${POWOD_AUTOMAT_WZ}"`)
    expect((await skutekPoprawionegoWWfirmie(m.id)).skutek).toMatchObject({ rodzaj: 'ISSUED_WITHOUT_DOCUMENT', fakturaBezWz: null, blokada: POWOD_AUTOMAT_WZ })
    expect((await poprawioneWWfirmie(m.id)).blad).toMatch(new RegExp(`^${POWOD_AUTOMAT_WZ}`))
    await expect(potwierdzPoprawioneWWfirmie(db, m.id)).rejects.toBeInstanceOf(PackError)
    expect(await db.pendingMovement.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ state: 'MANUAL' })
    expect(await db.orderEvent.count({ where: { kind: 'POPRAWIONE_W_WFIRMIE' } })).toBe(0)

    // błąd WZ zamówienia otwarty: biuro wystawia dokument samo, przycisk działa
    await db.alert.create({ data: { kind: 'WZ_BLAD', ref: orderId, message: 'test', dedupeKey: 'wz-blad:test' } })
    expect(await html()).not.toContain(`data-powod="${POWOD_AUTOMAT_WZ}"`)
    expect((await skutekPoprawionegoWWfirmie(m.id)).skutek).toMatchObject({ blokada: null })
    expect(await poprawioneWWfirmie(m.id)).toEqual({ blad: null, juzZamkniete: false })
  })

  it('automat WZ wyłączony albo wysyłka sprzed jego włączenia: przycisk aktywny, zamknięcie działa', async () => {
    const orderId = await zamowienieZBl()
    sesja.uprawnienia = new Set(['panel.podglad', 'zamowienia.faktury'])
    sesja.userId = 'u-biuro'
    const przed = await wydaneBezDokumentu(orderId, new Date(OD.getTime() - 60_000))
    await automatWz(true)
    expect(automatWzObejmie(przed, OD)).toBe(false)
    expect(await html()).not.toContain(`data-powod="${POWOD_AUTOMAT_WZ}"`)
    await db.pendingMovement.update({ where: { id: przed.id }, data: { sentAt: min(0) } })
    await automatWz(false)
    expect(await html()).not.toContain(`data-powod="${POWOD_AUTOMAT_WZ}"`)
    expect((await skutekPoprawionegoWWfirmie(przed.id)).skutek).toMatchObject({ blokada: null })
    expect(await poprawioneWWfirmie(przed.id)).toEqual({ blad: null, juzZamkniete: false })
  })
})
