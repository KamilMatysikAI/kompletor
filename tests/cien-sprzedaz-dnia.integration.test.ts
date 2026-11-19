// Sprzedaż dnia kontra BL (krok 0): Kompletor liczy z tego samego źródła co pulpit, BL z getOrders
// (atrapa). Dane fikcyjne ułożone jak zrzut 26.10: BL SklepDemo 8 zam. / 842,61 zł (3 w realizacji + 5 wysłanych).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { cleanDayStreaks, type DaySalesResult, runDaySalesCheck, SALES_CHECK } from '@/lib/cien/sprzedaz-dnia'
import { dashboard, salesOrders } from '@/lib/panel/dane'
import { ORG_B, testDb, truncateAll } from './db'
import { type BlFakeOrder, FakeBl, sec } from './bl-atrapa'
import { offer, product, seedBase } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const NOW = new Date('2026-10-26T18:00:00.000Z')
const AFTER_MIDNIGHT = new Date('2026-10-26T23:40:00.000Z') // 27.10 00:40 w Warszawie
const SRC = { env: {}, envFallback: false }
const MAP = { shopAccounts: ['sd'], empikAccountId: null }
const line = (qty: number) => [{ externalLineId: '1', offerExternalId: '10', qty, unitPriceGross: 10, vatRate: null }]
const fulfilled = { lifecycle: 'FULFILLED' as const, channelStatus: 'completed', statusRank: 30 }

// 3 w realizacji (279,85 zł) + 5 wysłanych przed startem cienia (562,76 zł) = 8 / 842,61 zł
const ORDERS: { id: string; at: string; total: number; done?: boolean }[] = [
  { id: '101', at: '2026-10-26T07:10:00Z', total: 99.95 },
  { id: '102', at: '2026-10-26T09:20:00Z', total: 89.95 },
  { id: '103', at: '2026-10-26T15:45:00Z', total: 89.95 },
  { id: '201', at: '2026-10-25T23:00:00Z', total: 120.0, done: true },
  { id: '202', at: '2026-10-26T06:00:00Z', total: 110.5, done: true },
  { id: '203', at: '2026-10-26T06:30:00Z', total: 99.99, done: true },
  { id: '204', at: '2026-10-26T08:00:00Z', total: 132.27, done: true },
  { id: '205', at: '2026-10-26T10:00:00Z', total: 100.0, done: true },
]

function blOrder(i: number, o: (typeof ORDERS)[number]): BlFakeOrder {
  // kwota BL = pozycje + wysyłka (rozbicie fikcyjne, suma jak w kanale)
  const delivery = 12.99
  return {
    order_id: 7000 + i,
    order_source: 'shop',
    order_source_id: 'sd',
    shop_order_id: Number(o.id),
    order_status_id: o.done ? 3 : 2,
    date_add: sec(o.at),
    date_confirmed: sec(o.at),
    delivery_price: delivery,
    products: [{ price_brutto: Math.round((o.total - delivery) * 100) / 100, quantity: 1 }],
    email: 'klient.testowy@example.invalid',
  }
}

let state: FakeChannelState
let registry: AdapterRegistry
let bl: FakeBl

async function shadowRead(orders = ORDERS): Promise<void> {
  for (const o of orders) state.upsertOrder(fakeOrder({ externalId: o.id, createdAt: new Date(o.at), totalGross: o.total, lines: line(1), ...(o.done ? fulfilled : {}) }))
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
  const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
  await pollAccount(db, acc, { registry, secrets: SRC, now: () => NOW })
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
  bl = new FakeBl()
  bl.orders = ORDERS.map((o, i) => blOrder(i, o))
  const a = await product(db, 'A', 20)
  await offer(db, 'WOO_SD', '10', a)
})

describe('sprzedaż dnia kontra BL (krok 0)', () => {
  it('jak zrzut 26.10: 8 / 842,61 zł po obu stronach → zgodne, bez alertu; wpis dnia zamkniętego', async () => {
    await shadowRead()
    const ours = await salesOrders(db, new Date('2026-10-25T23:00:00Z'), new Date('2026-10-26T23:00:00Z'))
    const d = await dashboard(db, NOW)
    // to samo źródło co pulpit: liczba i suma zgodne z „Dziś”
    // anulowane `salesOrders` zwraca zawsze, pulpit (SALES_COUNT_CANCELLED = false) liczy je osobno
    expect(ours).toHaveLength(d.today.count + d.today.outside.cancelled)
    expect(Math.round(ours.reduce((s, o) => s + Number(o.gross) * 100, 0))).toBe(Math.round(d.today.gross * 100))

    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    const k = r.accounts.find((a) => a.channelAccountId === 'sd')!
    expect(k).toMatchObject({ ok: true, ours: { count: 8, cents: 84261, beforeStart: 5 }, bl: { count: 8, cents: 84261 } })
    expect(r).toMatchObject({ final: true, ok: true, blComplete: true })
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD' } })).toBe(0)
    const row = await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK, day: '2026-10-26' } })
    expect(row).toMatchObject({ final: true, ok: true })
    expect(JSON.stringify(row.stats)).not.toContain('example.invalid')
    // getOrders po dacie złożenia, z niepotwierdzonymi (tylko get*)
    expect(bl.calls.map((c) => c.method)).toEqual(['getOrders'])
    // okno parowania doba ± 2 h: od 21:00 UTC dnia poprzedniego
    expect(bl.calls[0]!.params).toMatchObject({ date_from: sec('2026-10-25T21:00:00Z'), get_unconfirmed_orders: true })
    expect((await cleanDayStreaks(db, '2026-10-26'))['WOO|sd']).toBe(1)
  })

  it('jak zrzut 26.10 (Kompletor widzi 3 / 279,85): rozjazd → alert z numerami tylko w BL, bez danych klientów', async () => {
    await shadowRead(ORDERS.filter((o) => !o.done))
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    const k = r.accounts.find((a) => a.channelAccountId === 'sd')!
    expect(k).toMatchObject({ ok: false, ours: { count: 3, cents: 27985 }, bl: { count: 8, cents: 84261 }, onlyBl: ['201', '202', '203', '204', '205'], onlyHere: [] })
    const al = await db.alert.findMany({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD' } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('Kompletor 3 zam. / 279,85 zł, BL 8 zam. / 842,61 zł')
    expect(al[0]!.message).toContain('Tylko w BL: 201, 202, 203, 204, 205')
    expect(al[0]!.message).not.toContain('example.invalid')
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK } })).toMatchObject({ ok: false, final: true })
    // powtórka tego samego wyniku nie dubluje alertu
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD' } })).toBe(1)
    expect((await cleanDayStreaks(db, '2026-10-26'))['WOO|sd']).toBe(0)
  })

  it('różna kwota jednego zamówienia i zamówienie tylko u nas; niepotwierdzone w BL się nie liczy', async () => {
    await shadowRead()
    bl.orders[0]!.products = [{ price_brutto: 80, quantity: 1 }] // 101: BL 92,99 zamiast 99,95
    bl.orders.splice(7, 1) // 205 nie doszło do BL
    bl.orders.push({ ...blOrder(20, { id: '999', at: '2026-10-26T12:00:00Z', total: 10 }), confirmed: false })
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    const k = r.accounts.find((a) => a.channelAccountId === 'sd')!
    expect(k).toMatchObject({ ok: false, onlyHere: ['205'], onlyBl: [], bl: { count: 7, unconfirmed: 1 } })
    expect(k.amountDiffs).toEqual([{ ref: '101', oursCents: 9995, blCents: 9299 }])
  })

  it('na żądanie za dziś: dzień otwarty, ostatnie 20 min pominięte; zamknięty dzień nie wraca do otwartego; seria 7 dni', async () => {
    await shadowRead()
    // dziś o 15:55 UTC — 103 (15:45) mieści się w karencji 20 min, więc pominięte po obu stronach
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: new Date('2026-10-26T15:55:00Z') })
    expect(r.final).toBe(false)
    expect(r.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: true, ours: { count: 7 }, bl: { count: 7 } })
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK } })).toMatchObject({ final: false })
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: new Date('2026-10-26T20:00:00Z') }) // wcześniejszy zegar: nic nie nadpisuje
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK } })).toMatchObject({ final: true, ok: true })
    // seria: 6 kolejnych zgodnych dni wcześniej (wpisy fikcyjne) = 7 dni z rzędu; dziura przerywa
    const stats = (await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK } })).stats as object
    for (let d = 20; d <= 25; d++) await db.shadowDailyCheck.create({ data: { kind: SALES_CHECK, day: `2026-10-${d}`, final: true, ok: true, checkedAt: NOW, stats } })
    expect(await cleanDayStreaks(db, '2026-10-26')).toMatchObject({ '*': 7, 'WOO|sd': 7 })
    await db.shadowDailyCheck.deleteMany({ where: { day: '2026-10-23' } })
    expect((await cleanDayStreaks(db, '2026-10-26'))['*']).toBe(3)
  })

  it('Woo failed i pending (nieopłacone, BL ich nie importuje) — osobna lista, dzień zgodny', async () => {
    await shadowRead()
    // dane sprzed zmiany znaczenia failed: dawna mapa Woo zapisywała failed jako anulowane (CANCELLED); zostają jako przypadek historyczny
    state.upsertOrder(fakeOrder({ externalId: '301', createdAt: new Date('2026-10-26T11:00:00Z'), totalGross: 55, lines: line(1), channelStatus: 'failed', lifecycle: 'CANCELLED', statusRank: null, paymentState: 'UNPAID' }))
    state.upsertOrder(fakeOrder({ externalId: '302', createdAt: new Date('2026-10-26T12:00:00Z'), totalGross: 66, lines: line(1), channelStatus: 'pending', statusRank: 10, paymentState: 'UNPAID' }))
    const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date('2026-10-26T18:05:00Z') })
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    const k = r.accounts.find((a) => a.channelAccountId === 'sd')!
    expect(k).toMatchObject({ ok: true, onlyHere: [], notImportedByBl: ['301', '302'], ours: { count: 10 }, bl: { count: 8, cents: 84261 } })
    expect(r.ok).toBe(true)
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD' } })).toBe(0)
  })

  it('Woo failed jako otwarte nieopłacone (jak pending): bez pary w BL nieimportowane, z parą w BL zwykła para; nie liczy się do anulowanych, dzień zgodny', async () => {
    await shadowRead()
    const nieudane = [
      { id: '311', at: '2026-10-26T11:00:00Z', total: 55 },
      { id: '312', at: '2026-10-26T13:00:00Z', total: 77 },
    ]
    for (const o of nieudane)
      state.upsertOrder(fakeOrder({ externalId: o.id, createdAt: new Date(o.at), totalGross: o.total, lines: line(1), channelStatus: 'failed', lifecycle: 'OPEN', statusRank: 10, paymentState: 'UNPAID' }))
    // 312 BL zaimportował jako nowe nieopłacone (tak jak w sklepie po nieudanym BLIK-u), 311 nie
    bl.orders.push({ ...blOrder(40, nieudane[1]!), order_status_id: 1 })
    const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date('2026-10-26T18:05:00Z') })
    expect(await db.order.count({ where: { externalId: { in: ['311', '312'] }, status: 'NOWE', paymentState: 'UNPAID' } })).toBe(2)
    // pulpit: „poza tym N anulowane” nie liczy nieudanych płatności
    expect((await dashboard(db, new Date('2026-10-26T18:10:00Z'))).today.outside.cancelled).toBe(0)
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    const k = r.accounts.find((a) => a.channelAccountId === 'sd')!
    expect(k).toMatchObject({ ok: true, onlyHere: [], onlyBl: [], amountDiffs: [], notImportedByBl: ['311'], ours: { count: 10, cancelled: 0 }, bl: { count: 9 } })
    expect(r.ok).toBe(true)
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD' } })).toBe(0)
  })

  it('błąd BL przy zamknięciu dnia — dzień zostaje otwarty, następny przebieg zamyka go jako zgodny', async () => {
    await shadowRead()
    bl.failNext = 'getOrders'
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    expect(r).toMatchObject({ blComplete: false, final: false, ok: false })
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK } })).toMatchObject({ final: false, ok: false })
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD', ref: 'BL/2026-10-26' } })).toBe(1)
    const r2 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: new Date(AFTER_MIDNIGHT.getTime() + 3600_000) })
    expect(r2).toMatchObject({ blComplete: true, final: true, ok: true })
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK } })).toMatchObject({ final: true, ok: true })
    expect((await cleanDayStreaks(db, '2026-10-26'))['WOO|sd']).toBe(1)
  })

  it('zamówienie z 25.10 23:58 w BL z datą importu 26.10 00:03 — liczy się do 25.10, 26.10 zgodny', async () => {
    const late = { id: '160', at: '2026-10-25T22:58:00Z', total: 45 } // 25.10 23:58 w Warszawie (CET po zmianie czasu)
    await shadowRead([...ORDERS, late])
    bl.orders.push({ ...blOrder(30, late), date_add: sec('2026-10-25T23:03:00Z') }) // import do BL 26.10 00:03
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    expect(r.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: true, ours: { count: 8, cents: 84261 }, bl: { count: 8, cents: 84261 }, onlyBl: [], onlyHere: [] })
    const r2 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-25', now: AFTER_MIDNIGHT })
    expect(r2.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: true, ours: { count: 1, cents: 4500 }, bl: { count: 1, cents: 4500 }, onlyBl: [], onlyHere: [] })
  })

  it('anulowane w danych — `salesOrders` = „Dziś” + anulowane, w `ours` osobno, bez wliczania do „przed startem”', async () => {
    const cancelled = { id: '401', at: '2026-10-26T12:00:00Z', total: 30 }
    await shadowRead()
    state.upsertOrder(fakeOrder({ externalId: cancelled.id, createdAt: new Date(cancelled.at), totalGross: cancelled.total, lines: line(1), lifecycle: 'CANCELLED', channelStatus: 'cancelled', statusRank: null }))
    const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date('2026-10-26T18:05:00Z') })
    bl.orders.push(blOrder(40, cancelled)) // opłacone i potem anulowane: BL je ma
    const ours = await salesOrders(db, new Date('2026-10-25T23:00:00Z'), new Date('2026-10-26T23:00:00Z'))
    const d = await dashboard(db, NOW)
    expect(d.today.outside.cancelled).toBe(1)
    expect(ours.length).toBe(d.today.count + d.today.outside.cancelled)
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    const k = r.accounts.find((a) => a.channelAccountId === 'sd')!
    expect(k).toMatchObject({ ok: true, ours: { count: 9, beforeStart: 5, notIngested: 0, skipped: 0, cancelled: 1 }, bl: { count: 9 } })
  })

  it('Woo pending z 26.10 10:00, opłacone i zaimportowane do BL 27.10 13:00 — oba dni zgodne, numer na liście informacyjnej', async () => {
    const late = { id: '500', at: '2026-10-26T09:00:00Z', total: 40 } // 26.10 10:00 w Warszawie
    await shadowRead()
    state.upsertOrder(fakeOrder({ externalId: late.id, createdAt: new Date(late.at), totalGross: late.total, lines: line(1), channelStatus: 'pending', statusRank: 10, paymentState: 'UNPAID' }))
    const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date('2026-10-26T18:05:00Z') })
    bl.orders.push({ ...blOrder(50, late), date_add: sec('2026-10-27T12:00:00Z'), date_confirmed: sec('2026-10-27T12:00:00Z') }) // 27.10 13:00
    // zamknięcie 26.10 (00:40): BL jeszcze go nie ma, u nas nieopłacone → BL go nie importuje, dzień zgodny
    const d26 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    expect(d26.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: true, notImportedByBl: ['500'], blLaterImport: [], onlyHere: [], ours: { count: 9 } })
    // 27.10: klient płaci, BL importuje o 13:00 — zamknięcie 27.10: w oknie nie ma naszej pary, ale nasze zamówienie jest z 26.10
    state.upsertOrder(fakeOrder({ externalId: late.id, createdAt: new Date(late.at), totalGross: late.total, lines: line(1), channelStatus: 'processing', statusRank: 20, paymentState: 'PAID' }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date('2026-10-27T11:50:00Z') })
    const close27 = new Date('2026-10-27T23:40:00Z')
    const d27 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: close27 })
    const k27 = d27.accounts.find((a) => a.channelAccountId === 'sd')!
    expect(k27).toMatchObject({ ok: true, onlyBl: [], blDelayedImport: [{ ref: '500', ourDay: '2026-10-26' }], bl: { count: 1, cents: 4000 }, ours: { count: 0 } })
    expect(d27.ok).toBe(true)
    // ponowne sprawdzenie 26.10 później: para w BL z innym dniem — informacja, nie rozjazd (już opłacone)
    const again = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: close27 })
    expect(again.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: true, onlyHere: [], notImportedByBl: [], blLaterImport: [{ ref: '500', blDay: '2026-10-27' }] })
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD' } })).toBe(0)
    // zamówienie BL bez żadnego naszego odpowiednika dalej jest rozjazdem
    bl.orders.push({ ...blOrder(51, { id: '777', at: '2026-10-27T10:00:00Z', total: 10 }) })
    const d27b = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: close27 })
    expect(d27b.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: false, onlyBl: ['777'], blDelayedImport: [{ ref: '500' }] })
    const al = await db.alert.findFirstOrThrow({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD' } })
    expect(al.message).toContain('BL 2 (1 import z opóźnieniem, u nas z innego dnia) zam.')
    expect(al.message).toContain('500 (2026-10-26)')
  })

  it('inna kwota pary z opóźnionym importem = rozjazd, także gdy BL podaje numer wtyczki (kwota z rdzenia)', async () => {
    const late = { id: '500', at: '2026-10-26T09:00:00Z', total: 40 }
    await shadowRead()
    state.upsertOrder(fakeOrder({ externalId: late.id, number: '158500', createdAt: new Date(late.at), totalGross: late.total, lines: line(1) }))
    const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date('2026-10-26T18:05:00Z') })
    bl.orders.push({ ...blOrder(50, { ...late, id: '158500' }), delivery_price: 13.99, date_add: sec('2026-10-27T12:00:00Z'), date_confirmed: sec('2026-10-27T12:00:00Z') }) // BL 41,00
    const d27 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: new Date('2026-10-27T23:40:00Z') })
    expect(d27.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: false, onlyBl: [], blDelayedImport: [{ ref: '158500', ourDay: '2026-10-26' }], amountDiffs: [{ ref: '158500', oursCents: 4000, blCents: 4100 }] })
  })

  it('zamówienie opłacone w D, BL dociąga je po zamknięciu D — zamknięcie D+1 przelicza D raz, seria = 2', async () => {
    const paid = { id: '500', at: '2026-10-26T09:00:00Z', total: 40 } // 26.10 10:00 w Warszawie, opłacone
    await shadowRead([...ORDERS, paid])
    const d26 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    expect(d26.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: false, onlyHere: ['500'] })
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK, day: '2026-10-26' } })).toMatchObject({ final: true, ok: false })
    expect((await cleanDayStreaks(db, '2026-10-26'))['*']).toBe(0)

    bl.orders.push({ ...blOrder(50, paid), date_add: sec('2026-10-27T12:00:00Z'), date_confirmed: sec('2026-10-27T12:00:00Z') }) // 27.10 13:00
    const close27 = new Date('2026-10-27T23:40:00Z')
    bl.calls = []
    const d27 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: close27 })
    expect(d27.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: true, blDelayedImport: [{ ref: '500', ourDay: '2026-10-26' }] })
    expect(bl.calls.filter((c) => c.method === 'getOrders')).toHaveLength(2) // dzień 27.10 + jednorazowe przeliczenie 26.10

    const row = await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK, day: '2026-10-26' } })
    expect(row).toMatchObject({ final: true, ok: true })
    const stats = row.stats as unknown as DaySalesResult
    expect(stats.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: true, onlyHere: [], blLaterImport: [{ ref: '500', blDay: '2026-10-27' }] })
    expect(await cleanDayStreaks(db, '2026-10-27')).toMatchObject({ '*': 2, 'WOO|sd': 2 })
    // stary alert dnia zostaje otwarty (`alert()` tylko wstawia, zamyka człowiek), nowego nie ma
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD' } })).toBe(1)

    // powtórka 27.10: dzień 26.10 już zgodny, nic do przeliczenia
    bl.calls = []
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: close27 })
    expect(bl.calls.filter((c) => c.method === 'getOrders')).toHaveLength(1)
  })

  it('zamówienie z 23:50, BL 00:50 po zamknięciu o 00:40 — para z okna ± 2 h (bez `blDelayedImport`) też przelicza D', async () => {
    await shadowRead()
    const late = { id: '510', at: '2026-10-26T22:50:00Z', total: 40 } // 26.10 23:50 w Warszawie
    state.upsertOrder(fakeOrder({ externalId: late.id, createdAt: new Date(late.at), totalGross: late.total, lines: line(1) }))
    const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date('2026-10-26T23:00:00Z') })
    const d26 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    expect(d26.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: false, onlyHere: ['510'] })

    bl.orders.push({ ...blOrder(51, late), date_add: sec('2026-10-26T23:50:00Z'), date_confirmed: sec('2026-10-26T23:50:00Z') }) // 27.10 00:50
    const d27 = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: new Date('2026-10-27T23:40:00Z') })
    expect(d27.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ ok: true, blDelayedImport: [], bl: { count: 0 } })
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK, day: '2026-10-26' } })).toMatchObject({ final: true, ok: true })
    expect((await cleanDayStreaks(db, '2026-10-27'))['*']).toBe(2)
  })

  it('przeliczenie nie kaskaduje — przeliczany dzień nie przelicza kolejnego wstecz', async () => {
    const paid = { id: '500', at: '2026-10-26T09:00:00Z', total: 40 }
    const prev = { id: '160', at: '2026-10-25T22:58:00Z', total: 45 } // 25.10 23:58 w Warszawie
    await shadowRead([...ORDERS, paid, prev])
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: AFTER_MIDNIGHT })
    const stats = { accounts: [{ channel: 'WOO', channelAccountId: 'sd', onlyHere: ['160'] }] }
    await db.shadowDailyCheck.create({ data: { kind: SALES_CHECK, day: '2026-10-25', final: true, ok: false, checkedAt: NOW, stats } })
    bl.orders.push({ ...blOrder(50, paid), date_add: sec('2026-10-27T12:00:00Z'), date_confirmed: sec('2026-10-27T12:00:00Z') })
    bl.orders.push({ ...blOrder(52, prev), date_add: sec('2026-10-26T12:00:00Z'), date_confirmed: sec('2026-10-26T12:00:00Z') }) // numer 160 w BL w dniu 26.10
    bl.calls = []
    await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-27', now: new Date('2026-10-27T23:40:00Z') })
    expect(bl.calls.filter((c) => c.method === 'getOrders')).toHaveLength(2)
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK, day: '2026-10-26' } })).toMatchObject({ ok: true })
    expect(await db.shadowDailyCheck.findFirstOrThrow({ where: { kind: SALES_CHECK, day: '2026-10-25' } })).toMatchObject({ ok: false })
  })

  it('dwa przebiegi z niepełnym odczytem BL — tylko alert `bl-niepelne`, bez alertów kont; potem pełny odczyt jak zwykle', async () => {
    await shadowRead()
    bl.orders.splice(7, 1) // 205 nie doszło do BL: po pełnym odczycie rozjazd
    for (const now of [AFTER_MIDNIGHT, new Date(AFTER_MIDNIGHT.getTime() + 3600_000)]) {
      bl.failNext = 'getOrders'
      const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now })
      expect(r).toMatchObject({ blComplete: false, ok: false })
    }
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD', ref: 'BL/2026-10-26' } })).toBe(1)
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD', NOT: { ref: 'BL/2026-10-26' } } })).toBe(0)
    const r = await runDaySalesCheck(db, bl.client(), MAP, await accountsForComparison(db), { day: '2026-10-26', now: new Date(AFTER_MIDNIGHT.getTime() + 2 * 3600_000) })
    expect(r).toMatchObject({ blComplete: true, final: true, ok: false })
    expect(r.accounts.find((a) => a.channelAccountId === 'sd')).toMatchObject({ onlyHere: ['205'] })
    expect(await db.alert.count({ where: { kind: 'SPRZEDAZ_DNIA_ROZJAZD', ref: 'WOO/sd/2026-10-26' } })).toBe(1)
  })

  it('druga firma: bez kopii pierwszej (RLS) — po stronie Kompletora 0', async () => {
    await shadowRead()
    await seedBase(dbB)
    expect(await salesOrders(dbB, new Date('2026-10-25T23:00:00Z'), new Date('2026-10-26T23:00:00Z'))).toEqual([])
  })
})
