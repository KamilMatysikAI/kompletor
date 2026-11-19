// dziennik zdarzeń BL odświeża kopie statusów BL poza oknem porównania, razem
// z chwilą zmiany statusu; odświeżanie zapasowe, gdy dziennik milczy; sygnał o wyłączonym dzienniku. Piątek →
// poniedziałek dla reguł 10 i 14 przez atrapę BL. Zero połączeń zewnętrznych, dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runBlComparison } from '@/lib/cien/bl-porownanie'
import { ALERT_JOURNAL_ERROR, ALERT_JOURNAL_GAP, ALERT_JOURNAL_SILENT } from '@/lib/cien/dziennik-bl'
import { planujAkcje } from '@/lib/akcje/silnik'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { BL_STATUSES, FakeBl, sec } from './bl-atrapa'
import { ORG_A, ORG_B, testDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const MAP = { shopAccounts: ['sd', 'lampy', 'km'], empikAccountId: null }

// statusy BL z mapy 7.1: Do realizacji Paczkomaty (2), Wysłane (3), Do odbioru (5), Do realizacji Osobisty (6), Odebrane (7)
const STATUSES = [...BL_STATUSES, { id: 5, name: 'Do odbioru' }, { id: 6, name: 'Do realizacji Osobisty' }, { id: 7, name: 'Odebrane' }]

const PT = new Date('2026-10-30T16:00:00Z') // piątek 17:00 czasu polskiego
const PT_RUN = new Date('2026-10-30T16:10:00Z')
const ND = new Date('2026-11-01T11:00:00Z') // niedziela
const PN_WYSLANE = new Date('2026-11-02T09:00:00Z') // poniedziałek 10:00
const PN_ODBIOR = new Date('2026-11-02T08:30:00Z')
const PN_RUN = new Date('2026-11-02T09:10:00Z')

let bl: FakeBl
beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  bl = new FakeBl()
  bl.statuses = STATUSES
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

/** Zamówienie konta w cieniu (Woo SD) sparowane z BL i jego nagłówek w atrapie BL (potwierdzone w piątek). */
async function sparowane(blOrderId: number, statusId: number, db = a) {
  const p = await product(db, `J-${blOrderId}`, 5)
  const r = await ingestOrder(db, order([{ productId: p, qty: 1 }], { deliveryMethod: 'Odbiór osobisty' }))
  const o = await db.order.update({ where: { id: r.orderId! }, data: { blOrderId } })
  bl.orders.push({ order_id: blOrderId, order_source: 'shop', order_source_id: 'sd', shop_order_id: o.externalId, order_status_id: statusId, date_add: sec(PT), date_confirmed: sec(PT) })
  return o.id
}

const run = (now: Date, db = a) => runBlComparison(db, bl.client(), MAP, [], { now, windowMs: 24 * 3600_000 })
let logSeq = 1000
const zmiana = (blOrderId: number, statusId: number, at: Date, idKey: 'log_id' | 'id' = 'log_id') => bl.journal.push({ [idKey]: ++logSeq, log_type: 18, order_id: blOrderId, object_id: statusId, date: sec(at) })
const setStatus = (blOrderId: number, statusId: number) => (bl.orders.find((o) => o.order_id === blOrderId)!.order_status_id = statusId)
const kopia = (blOrderId: number, db = a) => db.blOrderSnapshot.findFirstOrThrow({ where: { blOrderId } })

/** Faktura BL z piątku rozliczona przez cień (jak `syncBlInvoices`). */
async function fakturaBl(orderId: string, blOrderId: number, n: number) {
  await a.blInvoiceSnapshot.create({ data: { blInvoiceId: n, blOrderId, number: `BL/${n}`, externalNumber: `FV ${n}/10/2026`, kind: 'normal', dateAdd: PT, fetchedAt: PT_RUN, orderId, appliedAt: PT_RUN, outcome: 'ZASTOSOWANA' } })
}

describe('dziennik BL: piątek → poniedziałek', () => {
  it('kopia spoza okna 48 h dostaje status i chwilę z dziennika; reguła 10 z dniem wysyłki, reguła 14 z chwilą Do odbioru', async () => {
    const wysylka = await sparowane(9101, 2)
    const odbior = await sparowane(9102, 6)
    await fakturaBl(wysylka, 9101, 701)
    await run(PT_RUN)
    await run(ND) // niedziela: jeszcze w oknie, status bez zmian
    expect((await kopia(9101)).fetchedAt.toISOString()).toBe(ND.toISOString())
    // poniedziałek: zamówienia z piątku poza oknem getOrders (od soboty), zmiany tylko w dzienniku
    setStatus(9101, 3)
    setStatus(9102, 5)
    zmiana(9101, 2, new Date(PT.getTime() + 60_000)) // starsze zdarzenie tego samego zamówienia
    zmiana(9101, 3, PN_WYSLANE)
    zmiana(9102, 5, PN_ODBIOR, 'id') // identyfikator wpisu jako `id` (opis BL)
    const r = await run(PN_RUN)
    expect(bl.calls.filter((c) => c.method === 'getOrders' && c.params['order_id'] !== undefined)).toHaveLength(0) // kopie świeże: bez zapasu
    expect(r.journal).toMatchObject({ events: 4 - 1, applied: 2, withoutSnapshot: 0, complete: true, lastLogId: String(logSeq) })
    expect(r.blErrors).toEqual([])
    expect(await kopia(9101)).toMatchObject({ statusId: 3, statusName: 'Wysłane', statusChangedToId: 3, statusChangedAt: PN_WYSLANE, fetchedAt: PN_RUN })
    expect(await kopia(9102)).toMatchObject({ statusId: 5, statusName: 'Do odbioru', statusChangedAt: PN_ODBIOR })
    const plan = await planujAkcje(a, { now: new Date(PN_RUN.getTime() + 5 * 60_000) })
    expect(plan.nowe).toMatchObject({ 'mail.faktura': 1, 'mail.gotowe-do-odbioru': 1 })
    const all = await a.plannedAction.findMany()
    expect(all.find((x) => x.rule === 'mail.faktura')).toMatchObject({ targetId: wysylka, occasion: 'FV:FV 701/10/2026', dueAt: PN_WYSLANE }) // dzień wysyłki
    expect(all.find((x) => x.rule === 'mail.gotowe-do-odbioru')).toMatchObject({ targetId: odbior, dueAt: PN_ODBIOR })
    expect(JSON.stringify(r)).not.toMatch(/Odbiór osobisty/)
  })

  it('bez dziennika (stan) poniedziałek nie ma planu — kopia zamrożona na Do realizacji', async () => {
    const wysylka = await sparowane(9111, 2)
    await fakturaBl(wysylka, 9111, 711)
    bl.journalDisabled = true
    await run(PT_RUN)
    await run(ND)
    setStatus(9111, 3)
    const r = await run(PN_RUN)
    expect(r.journal).toMatchObject({ events: 0, applied: 0 })
    expect((await kopia(9111)).statusId).toBe(2) // niedzielny odczyt młodszy niż doba: zapas jeszcze nie rusza
    expect((await planujAkcje(a, { now: PN_RUN })).nowe['mail.faktura']).toBe(0)
  })

  it('powtórka przebiegu: ten sam stan (kursor, kopie); zdarzenie bez kopii = licznik', async () => {
    await sparowane(9121, 2)
    await run(PT_RUN)
    setStatus(9121, 3)
    zmiana(9121, 3, PN_WYSLANE)
    zmiana(4242, 3, PN_WYSLANE) // zamówienie BL, którego kopii nie mamy (np. źródło bez adaptera)
    const r1 = await run(PN_RUN)
    expect(r1.journal).toMatchObject({ events: 2, applied: 1, withoutSnapshot: 1 })
    const snap1 = await a.blOrderSnapshot.findMany({ orderBy: { blOrderId: 'asc' } })
    const cur1 = await a.blJournalCursor.findFirstOrThrow()
    const later = new Date(PN_RUN.getTime() + 10 * 60_000)
    const r2 = await run(later)
    expect(r2.journal).toMatchObject({ events: 0, applied: 0, withoutSnapshot: 0, lastLogId: r1.journal.lastLogId })
    const snap2 = await a.blOrderSnapshot.findMany({ orderBy: { blOrderId: 'asc' } })
    expect(snap2).toEqual(snap1)
    expect((await a.blJournalCursor.findFirstOrThrow()).lastLogId).toBe(cur1.lastLogId)
    // druga strona dziennika: zapytanie od kursora, nie od zera
    expect(bl.calls.filter((c) => c.method === 'getJournalList').at(-1)!.params).toEqual({ last_log_id: Number(cur1.lastLogId), logs_types: [18] })
  })

  it('kopia z getOrders nowsza od zdarzenia: status zostaje, chwila odnotowana przy swoim statusie i niezaufana', async () => {
    const z = await sparowane(9131, 7) // Odebrane już w odczycie getOrders z tego przebiegu
    await fakturaBl(z, 9131, 731)
    zmiana(9131, 3, new Date(PT_RUN.getTime() - 5 * 60_000)) // Wysłane 5 min przed odczytem
    const r = await run(PT_RUN)
    expect(r.journal).toMatchObject({ applied: 0, olderThanSnapshot: 1 })
    expect(await kopia(9131)).toMatchObject({ statusId: 7, statusName: 'Odebrane', statusChangedToId: 3 })
    await planujAkcje(a, { now: PT_RUN })
    // chwila Wysłane nie dotyczy bieżącego statusu: dzień planu = dzień faktury, jak bez dziennika
    expect((await a.plannedAction.findFirstOrThrow({ where: { rule: 'mail.faktura' } })).dueAt).toEqual(PT)
  })

  it('błąd dziennika nie psuje porównania: kopie zapisane, błąd w blErrors i w journal, kursor bez odczytu', async () => {
    await sparowane(9141, 2)
    bl.failNext = 'getJournalList'
    const r = await run(PT_RUN)
    expect(r.blComplete).toBe(true)
    expect(r.blErrors.join(' ')).toMatch(/dziennik BL: .*ERROR_INTERNAL_TEST/)
    expect(r.journal).toMatchObject({ complete: false, lastLogId: null, error: expect.stringMatching(/dziennik BL/) })
    expect(await a.blOrderSnapshot.count()).toBe(1)
    // kursor zakładany przed odczytem (od kiedy liczyć dobę błędów), ale bez udanego odczytu
    expect(await a.blJournalCursor.findFirstOrThrow()).toMatchObject({ lastLogId: 0n, lastReadAt: null, createdAt: PT_RUN })
    expect(await a.alert.count({ where: { kind: ALERT_JOURNAL_ERROR } })).toBe(0) // pojedynczy błąd nie alarmuje
    expect(JSON.parse(JSON.stringify(r)).journal.complete).toBe(false) // wynik idzie do ImportRun.stats (bez BigInt)
  })
})

describe('odświeżanie zapasowe i sygnał o wyłączonym dzienniku', () => {
  it('kopia z parowania od strony faktury (bez nazwy statusu) w statusie końcowym: jeden odczyt uzupełnia nazwę; zwykła kopia końcowa bez odczytu', async () => {
    await sparowane(9171, 3)
    await sparowane(9172, 3)
    const naglowek = { orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO' as const, channelAccountId: 'sd', statusId: 3, dateAdd: PT }
    await a.blOrderSnapshot.create({ data: { ...naglowek, blOrderId: 9171, externalRef: 'P-9171', statusName: null, fetchedAt: new Date(0) } })
    await a.blOrderSnapshot.create({ data: { ...naglowek, blOrderId: 9172, externalRef: 'P-9172', statusName: 'Wysłane', fetchedAt: PT_RUN } })
    bl.calls = []
    await run(PN_RUN)
    expect(bl.calls.filter((c) => c.method === 'getOrders' && c.params['order_id'] !== undefined).map((c) => c.params['order_id'])).toEqual([9171])
    expect(await kopia(9171)).toMatchObject({ statusId: 3, statusName: 'Wysłane', fetchedAt: PN_RUN })
    bl.calls = []
    await run(new Date(PN_RUN.getTime() + 10 * 60_000))
    expect(bl.calls.filter((c) => c.method === 'getOrders' && c.params['order_id'] !== undefined)).toEqual([])
  })

  it('pusty dziennik: kopie sparowane spoza rodzin końcowych starsze niż doba odświeżane getOrders po numerze; alert raz', async () => {
    const z = await sparowane(9151, 2)
    await fakturaBl(z, 9151, 751)
    await sparowane(9152, 3) // już Wysłane: rodzina końcowa, bez odświeżania
    await sparowane(9153, 2) // usunięte w BL przed poniedziałkiem
    bl.orders.push({ order_id: 9154, order_source: 'shop', order_source_id: 'obcy', shop_order_id: 1, order_status_id: 2, date_add: sec(PT), date_confirmed: sec(PT) }) // niesparowane
    bl.journalDisabled = true
    await run(PT_RUN)
    setStatus(9151, 3)
    bl.orders = bl.orders.filter((o) => o.order_id !== 9153)
    bl.calls = []
    const r = await run(PN_RUN)
    expect(bl.calls.filter((c) => c.method === 'getOrders' && c.params['order_id'] !== undefined).map((c) => c.params['order_id']).sort()).toEqual([9151, 9153])
    expect(r.refresh).toEqual({ checked: 2, statusChanged: 1, gone: 1, failed: 0 })
    expect(await kopia(9151)).toMatchObject({ statusId: 3, statusName: 'Wysłane', statusChangedAt: null, fetchedAt: PN_RUN })
    expect((await kopia(9153)).fetchedAt).toEqual(PN_RUN) // nie blokuje kolejki
    expect((await kopia(9154)).fetchedAt).toEqual(PT_RUN)
    // reguła 10 bez chwili statusu: dzień faktury (bez dziennika)
    await planujAkcje(a, { now: PN_RUN })
    expect((await a.plannedAction.findFirstOrThrow({ where: { rule: 'mail.faktura' } })).dueAt).toEqual(PT)
    const alerts = await a.alert.findMany({ where: { kind: ALERT_JOURNAL_SILENT } })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.message).toMatch(/getJournalList/)
    expect(alerts[0]!.message).not.toMatch(/9151|Odbiór|T-/)
    // drugi przebieg tego dnia ze zmianą: bez drugiego alertu
    setStatus(9151, 7)
    await a.blOrderSnapshot.updateMany({ where: { blOrderId: 9151 }, data: { fetchedAt: PT_RUN } })
    await run(new Date(PN_RUN.getTime() + 10 * 60_000))
    expect(await a.alert.count({ where: { kind: ALERT_JOURNAL_SILENT } })).toBe(1)
  })

  it('dziennik dał zdarzenie w ostatniej dobie: zmiana z getOrders bez alertu; kursor nieczytany > 72 h: alert o luce', async () => {
    await sparowane(9161, 2)
    zmiana(9161, 2, PT)
    await run(PT_RUN)
    setStatus(9161, 6)
    await run(new Date(PT_RUN.getTime() + 3600_000)) // getOrders widzi zmianę, dziennik godzinę temu działał
    expect(await a.alert.count({ where: { kind: ALERT_JOURNAL_SILENT } })).toBe(0)
    await a.blJournalCursor.updateMany({ data: { lastReadAt: new Date(PN_RUN.getTime() - 80 * 3600_000) } })
    await run(PN_RUN)
    await run(new Date(PN_RUN.getTime() + 600_000))
    const gap = await a.alert.findMany({ where: { kind: ALERT_JOURNAL_GAP } })
    expect(gap).toHaveLength(1)
    expect(gap[0]!.organizationId).toBe(ORG_A)
  })

  it('kursor i kopie per firma (RLS): dziennik firmy B nie rusza kopii firmy A o tym samym numerze BL', async () => {
    await sparowane(9171, 2, a)
    await sparowane(9171, 2, b) // to samo konto BL w atrapie, osobne firmy w bazie
    await run(PT_RUN, a)
    await run(PT_RUN, b)
    zmiana(9171, 5, PN_ODBIOR)
    await run(PN_RUN, b)
    expect((await kopia(9171, b)).statusId).toBe(5)
    expect((await kopia(9171, a)).statusId).toBe(2)
    expect((await a.blJournalCursor.findFirstOrThrow()).lastLogId).toBe(0n)
    expect((await b.blJournalCursor.findFirstOrThrow()).lastLogId).toBe(BigInt(logSeq))
  })
})

describe('poprawki z', () => {
  it('BL od doby odpowiada błędem na getJournalList — jeden alert na epizod, zamykany przy udanym odczycie', async () => {
    await sparowane(9181, 2)
    bl.failAlways = ['getJournalList']
    await run(PT_RUN)
    await run(new Date(PT_RUN.getTime() + 12 * 3600_000))
    expect(await a.alert.count({ where: { kind: ALERT_JOURNAL_ERROR } })).toBe(0) // mniej niż doba błędów
    const r = await run(new Date(PT_RUN.getTime() + 25 * 3600_000))
    expect(r.blErrors.join(' ')).toMatch(/dziennik BL: .*ERROR_INTERNAL_TEST/)
    await run(new Date(PT_RUN.getTime() + 49 * 3600_000)) // kolejny dzień tego samego epizodu: bez drugiego alertu
    const alerts = await a.alert.findMany({ where: { kind: ALERT_JOURNAL_ERROR } })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!).toMatchObject({ organizationId: ORG_A, closedAt: null })
    expect(alerts[0]!.message).toMatch(/getJournalList/)
    expect(alerts[0]!.message).not.toMatch(/9181|Odbiór|T-/)
    expect(await b.alert.count({ where: { kind: ALERT_JOURNAL_ERROR } })).toBe(0)
    bl.failAlways = []
    const ok = new Date(PT_RUN.getTime() + 50 * 3600_000)
    await run(ok)
    expect((await a.alert.findFirstOrThrow({ where: { kind: ALERT_JOURNAL_ERROR } })).closedAt).toEqual(ok)
  })

  it('zapas pomija kopie w „E-book” i w statusie spoza listy BL; odświeża tylko te, które mogą dać plan', async () => {
    bl.statuses = [...STATUSES, { id: 8, name: 'E-book' }]
    await sparowane(9191, 2) // Do realizacji: zapas
    await sparowane(9192, 8) // E-book: na stałe, bez planu
    await sparowane(9193, 99) // status spoza getOrderStatusList
    bl.journalDisabled = true
    await run(PT_RUN)
    bl.calls = []
    const r = await run(PN_RUN)
    expect(bl.calls.filter((c) => c.method === 'getOrders' && c.params['order_id'] !== undefined).map((c) => c.params['order_id'])).toEqual([9191])
    expect(r.refresh).toMatchObject({ checked: 1 })
    expect((await kopia(9192)).fetchedAt).toEqual(PT_RUN)
    expect((await kopia(9193)).fetchedAt).toEqual(PT_RUN)
  })

  it('alert o milczącym dzienniku raz na epizod (nie co dzień) i zamykany pierwszym zdarzeniem dziennika', async () => {
    await sparowane(9201, 2)
    bl.journalDisabled = true
    await run(PT_RUN)
    setStatus(9201, 6)
    await run(PN_RUN) // zapas widzi zmianę, dziennik milczy od założenia kursora > doba
    expect(await a.alert.count({ where: { kind: ALERT_JOURNAL_SILENT, closedAt: null } })).toBe(1)
    // kolejny dzień, kolejna zmiana: ten sam epizod, bez drugiego alertu
    const wt = new Date(PN_RUN.getTime() + 25 * 3600_000)
    setStatus(9201, 5)
    await run(wt)
    expect(await a.alert.count({ where: { kind: ALERT_JOURNAL_SILENT } })).toBe(1)
    // dziennik włączony: pierwsze zdarzenie zamyka epizod
    bl.journalDisabled = false
    zmiana(9201, 5, wt)
    const sr = new Date(wt.getTime() + 600_000)
    await run(sr)
    expect((await a.alert.findFirstOrThrow({ where: { kind: ALERT_JOURNAL_SILENT } })).closedAt).toEqual(sr)
  })
})
