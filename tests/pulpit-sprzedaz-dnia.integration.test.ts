// Pulpit „Dziś” i wykres miesiąca liczą każde zamówienie złożone danego dnia: także zamówienia, które cień
// świadomie pominął w rdzeniu (zrealizowane przed pierwszym odczytem konta), bez rezerwacji; granica doby w Europe/Warsaw.
// Dane wyłącznie fikcyjne (kwoty i liczby ułożone jak w zrzucie BL z 26.10: 3 w realizacji + 5 wysłanych).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { dashboard } from '@/lib/panel/dane'
import { outsideCoreNote, SALES_COUNT_CANCELLED } from '@/lib/panel/format'
import { shipLater } from '@/lib/rdzen/brakuje'
import { ORG_B, testDb, truncateAll } from './db'
import { expectInvariants, offer, product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

// 26.10.2026 to pierwszy dzień czasu zimowego (CET, UTC+1): doba w Warszawie = 25.10 23:00Z … 26.10 23:00Z.
const NOW = new Date('2026-10-26T18:00:00.000Z')
const SRC = { env: {}, envFallback: false }
const KEY = 'WOO:sd'

async function sd(d: PrismaClient, org: string) {
  await d.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: org, channel: 'WOO', channelAccountId: 'sd' } }, data: { adapterKey: 'fake.v1' } })
  return (await loadChannelAccounts(d)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
}

let state: FakeChannelState
let registry: AdapterRegistry
let a: string

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
  a = await product(db, 'A', 20)
  await offer(db, 'WOO_SD', '10', a)
})

const line = (qty: number) => [{ externalLineId: '1', offerExternalId: '10', qty, unitPriceGross: 10, vatRate: null }]
/** Kopia z kanału zapisana wprost (bez odczytu) — pola wspólne. */
const SNAP = {
    channel: 'WOO' as const,
    channelAccountId: 'sd',
    revision: 'r1',
    channelStatus: 'processing',
    lifecycle: 'OPEN' as const,
    paymentState: 'PAID' as const,
    currency: 'PLN',
    lineCount: 1,
    warnings: [],
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  }
const fulfilled = { lifecycle: 'FULFILLED' as const, channelStatus: 'completed', statusRank: 30 }

function seedLikeBl(): void {
  // 3 w realizacji (279,85 zł) — rdzeń je przyjmuje i rezerwuje
  state.upsertOrder(fakeOrder({ externalId: '101', createdAt: new Date('2026-10-26T07:10:00Z'), totalGross: 99.95, lines: line(1) }))
  state.upsertOrder(fakeOrder({ externalId: '102', createdAt: new Date('2026-10-26T09:20:00Z'), totalGross: 89.95, lines: line(1) }))
  state.upsertOrder(fakeOrder({ externalId: '103', createdAt: new Date('2026-10-26T15:45:00Z'), totalGross: 89.95, lines: line(1) }))
  // 5 wysłanych (562,76 zł) — widziane pierwszy raz jako zrealizowane: rdzeń pomija, sprzedaż dnia liczy
  state.upsertOrder(fakeOrder({ externalId: '201', ...fulfilled, createdAt: new Date('2026-10-25T23:00:00Z'), totalGross: 120.0, lines: line(1) })) // 26.10 00:00 w Warszawie
  state.upsertOrder(fakeOrder({ externalId: '202', ...fulfilled, createdAt: new Date('2026-10-26T06:00:00Z'), totalGross: 110.5, lines: line(2) }))
  state.upsertOrder(fakeOrder({ externalId: '203', ...fulfilled, createdAt: new Date('2026-10-26T06:30:00Z'), totalGross: 99.99, lines: line(1) }))
  state.upsertOrder(fakeOrder({ externalId: '204', ...fulfilled, createdAt: new Date('2026-10-26T08:00:00Z'), totalGross: 132.27, lines: line(3) }))
  state.upsertOrder(fakeOrder({ externalId: '205', ...fulfilled, createdAt: new Date('2026-10-26T10:00:00Z'), totalGross: 100.0, lines: line(1) }))
  // granica doby: 25.10 23:59:59 w Warszawie — dzień wcześniej (też zrealizowane przed startem cienia)
  state.upsertOrder(fakeOrder({ externalId: '199', ...fulfilled, createdAt: new Date('2026-10-25T22:59:59Z'), totalGross: 77.0, lines: line(1) }))
  // szkic złożony dziś — to nie sprzedaż
  state.upsertOrder(fakeOrder({ externalId: '301', lifecycle: 'DRAFT', channelStatus: 'checkout-draft', statusRank: null, createdAt: new Date('2026-10-26T11:00:00Z'), totalGross: 500, lines: line(1) }))
}

describe('sprzedaż dnia z kopii kanału', () => {
  it('jak w BL: 8 zamówień / 842,61 zł; 5 pominiętych przez rdzeń liczy się bez rezerwacji; szkic nie; granica doby w Warszawie', async () => {
    seedLikeBl()
    const acc = await sd(db, 'test_a')
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => NOW })

    // rdzeń: tylko 3 otwarte, rezerwacje tylko dla nich (bez zmian względem cienia)
    expect(await db.order.count()).toBe(3)
    const skipped = await db.channelOrderSnapshot.count({ where: { skipReason: 'zrealizowane-przed-pierwszym-odczytem' } })
    expect(skipped).toBe(6)
    const res = await db.reservation.findMany({ where: { state: 'ACTIVE' }, include: { order: { select: { externalId: true } } } })
    expect(res.map((r) => r.order.externalId).sort()).toEqual(['101', '102', '103'])
    expect((await stockOf(db, a)).reserved).toBe(3)
    await expectInvariants(db)

    const d = await dashboard(db, NOW)
    expect(d.today.count).toBe(8)
    expect(d.today.gross).toBe(842.61)
    expect(d.today.outside).toEqual({ beforeStart: 5, notIngested: 0, skipped: 0, cancelled: 0 })
    const k = d.today.perAccount.find((p) => p.key === KEY)!
    expect(k).toMatchObject({ count: 8, gross: 842.61, outside: { beforeStart: 5, notIngested: 0, skipped: 0, cancelled: 0 } })

    // wykres miesiąca: 25.10 = 1 (23:59:59 w Warszawie), 26.10 = 8; dalsze dni puste
    expect(d.month.find((m) => m.day === 25)).toMatchObject({ count: 1, gross: 77 })
    expect(d.month.find((m) => m.day === 26)).toMatchObject({ count: 8, gross: 842.61 })
    expect(d.monthTotals).toEqual({ count: 9, gross: 919.61, outside: { beforeStart: 6, notIngested: 0, skipped: 0, cancelled: 0 } })

    // powtórny odczyt bez zmian nie dubluje (deduplikacja po koncie + id zamówienia)
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date(NOW.getTime() + 60_000) })
    const d2 = await dashboard(db, NOW)
    expect(d2.today).toMatchObject({ count: 8, gross: 842.61 })
    expect(await db.reservation.count({ where: { state: 'ACTIVE' } })).toBe(3)
  })

  it('kopia bez zamówienia w rdzeniu i bez powodu pominięcia (przyjęcie się nie udało) liczy się jako „nieprzyjęte”; zamówienie w rdzeniu ma pierwszeństwo przed kopią', async () => {
    state.upsertOrder(fakeOrder({ externalId: '101', createdAt: new Date('2026-10-26T07:10:00Z'), totalGross: 40, lines: line(1) }))
    const acc = await sd(db, 'test_a')
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => NOW })
    // kwota w kopii rozjechana z rdzeniem — liczy się rdzeń (jak dotąd), kopia nie dubluje
    await db.channelOrderSnapshot.updateMany({ where: { externalId: '101' }, data: { totalGross: '999.00' } })
    // kopia po nieudanym przyjęciu: brak zamówienia w rdzeniu, błąd zapisany w kopii
    await db.channelOrderSnapshot.create({
      data: {
        channel: 'WOO',
        channelAccountId: 'sd',
        externalId: '102',
        revision: 'r1',
        channelStatus: 'processing',
        lifecycle: 'OPEN',
        paymentState: 'PAID',
        totalGross: '60.50',
        currency: 'PLN',
        lineCount: 1,
        warnings: [],
        createdAtChannel: new Date('2026-10-26T08:00:00Z'),
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        lastError: 'przejściowy błąd (test)',
        errorCount: 1,
      },
    })
    const d = await dashboard(db, NOW)
    expect(d.today).toMatchObject({ count: 2, gross: 100.5, outside: { beforeStart: 0, notIngested: 1, skipped: 0, cancelled: 0 } })
    expect(await db.order.count()).toBe(1)
  })

  it('anulowane poza liczbą i kwotą sprzedaży (rdzeń ANULOWANE i kopia CANCELLED), liczone osobno — „poza tym N anulowanych”', async () => {
    // domyślny wariant; stałą można przełączyć, jeśli BL liczy anulowane w „dziś”
    // bezpiecznik: przełączenie stałej na true wymaga zmiany oczekiwań w tym teście na 10 / 917,61 i `outside.cancelled: 2`
    // oraz asercji `ours` kontra pulpit w tests/cien-sprzedaz-dnia.integration.test.ts (dwa miejsca) na `d.today.count` bez `outside.cancelled`
    expect(SALES_COUNT_CANCELLED).toBe(false)
    seedLikeBl()
    state.upsertOrder(fakeOrder({ externalId: '401', lifecycle: 'CANCELLED', channelStatus: 'cancelled', statusRank: null, createdAt: new Date('2026-10-26T12:00:00Z'), totalGross: 30, lines: line(1) }))
    const acc = await sd(db, 'test_a')
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => NOW })
    expect(await db.order.count({ where: { status: 'ANULOWANE' } })).toBe(1)
    expect(await db.reservation.count({ where: { state: 'ACTIVE' } })).toBe(3)
    // anulowana kopia bez zamówienia w rdzeniu (np. przyjęcie się nie udało) — też poza sprzedażą, też w „anulowanych”
    await db.channelOrderSnapshot.create({ data: { ...SNAP, externalId: '402', lifecycle: 'CANCELLED', channelStatus: 'cancelled', totalGross: '45.00', createdAtChannel: new Date('2026-10-26T13:00:00Z') } })
    const d = await dashboard(db, NOW)
    // jak w BL: 8 / 842,61 — pierwsze anulowane w dniu nie daje 9
    expect(d.today).toMatchObject({ count: 8, gross: 842.61, outside: { beforeStart: 5, notIngested: 0, skipped: 0, cancelled: 2 } })
    expect(d.today.perAccount.find((p) => p.key === KEY)).toMatchObject({ count: 8, gross: 842.61, outside: { cancelled: 2 } })
    expect(d.month.find((m) => m.day === 26)).toMatchObject({ count: 8, gross: 842.61 })
    expect(d.monthTotals).toMatchObject({ count: 9, gross: 919.61, outside: { cancelled: 2 } })
    expect(outsideCoreNote(d.today.outside)).toBe('w tym 5 zrealizowanych, zanim system zaczął czytać konto (nie ma ich w realizacji systemu) · poza tym 2 anulowane')
  })

  it('same anulowane w dniu → 0 zamówień / 0 zł, adnotacja tylko o anulowanych', async () => {
    state.upsertOrder(fakeOrder({ externalId: '401', lifecycle: 'CANCELLED', channelStatus: 'cancelled', statusRank: null, createdAt: new Date('2026-10-26T12:00:00Z'), totalGross: 30, lines: line(1) }))
    const acc = await sd(db, 'test_a')
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => NOW })
    const d = await dashboard(db, NOW)
    expect(d.today).toMatchObject({ count: 0, gross: 0, outside: { beforeStart: 0, notIngested: 0, skipped: 0, cancelled: 1 } })
    expect(outsideCoreNote(d.today.outside)).toBe('poza tym 1 anulowane')
  })

  it('kopia bez zamówienia w rdzeniu z nieznanym powodem pominięcia → „pominięte”, nie „nieprzyjęte”', async () => {
    await db.channelOrderSnapshot.create({ data: { ...SNAP, externalId: '501', totalGross: '25.00', createdAtChannel: new Date('2026-10-26T08:00:00Z'), skipReason: 'powod-z-przyszlosci' } })
    await db.channelOrderSnapshot.create({ data: { ...SNAP, externalId: '502', totalGross: '15.00', createdAtChannel: new Date('2026-10-26T09:00:00Z') } })
    const d = await dashboard(db, NOW)
    expect(d.today).toMatchObject({ count: 2, gross: 40, outside: { beforeStart: 0, notIngested: 1, skipped: 1, cancelled: 0 } })
    expect(outsideCoreNote(d.today.outside)).toBe('w tym 1 jeszcze nieprzyjęte do realizacji i 1 pominięte przy przyjmowaniu (nie ma ich w realizacji systemu)')
  })

  it('podzamówienie „dośle później” (#dosle-N z rodzicem) nie liczy się drugi raz', async () => {
    const b = await product(db, 'B', 0)
    await offer(db, 'WOO_SD', '20', b)
    state.upsertOrder(fakeOrder({ externalId: '601', createdAt: new Date('2026-10-26T09:00:00Z'), totalGross: 70, lines: [{ externalLineId: '1', offerExternalId: '20', qty: 2, unitPriceGross: 35, vatRate: null }] }))
    const acc = await sd(db, 'test_a')
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => NOW })
    const ln = await db.orderLine.findFirstOrThrow({ where: { order: { externalId: '601' } } })
    const { childOrderId } = await shipLater(db, ln.id, { now: NOW })
    const child = await db.order.findUniqueOrThrow({ where: { id: childOrderId } })
    expect(child.externalId).toBe('601#dosle-2')
    expect(child.parentOrderId).not.toBeNull()
    const d = await dashboard(db, NOW)
    expect(d.today).toMatchObject({ count: 1, gross: 70, outside: { beforeStart: 0, notIngested: 0, skipped: 0, cancelled: 0 } })
  })

  it('kopia „cofnięte po wysyłce” (z orderId) liczy się raz, z rdzenia', async () => {
    state.upsertOrder(fakeOrder({ externalId: '701', createdAt: new Date('2026-10-26T09:00:00Z'), totalGross: 55, lines: line(1) }))
    const acc = await sd(db, 'test_a')
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => NOW })
    const o = await db.order.findFirstOrThrow({ where: { externalId: '701' } })
    await db.order.update({ where: { id: o.id }, data: { status: 'WYSLANE' } })
    state.upsertOrder(fakeOrder({ externalId: '701', revision: '2026-10-26T10:00:00.000Z', lifecycle: 'DRAFT', channelStatus: 'trash', statusRank: null, createdAt: new Date('2026-10-26T09:00:00Z'), totalGross: 55, lines: line(1) }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date(NOW.getTime() + 60_000) })
    const snap = await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: '701' } })
    expect(snap).toMatchObject({ skipReason: 'cofniete-po-wysylce', orderId: o.id })
    const d = await dashboard(db, NOW)
    expect(d.today).toMatchObject({ count: 1, gross: 55, outside: { beforeStart: 0, notIngested: 0, skipped: 0, cancelled: 0 } })
  })

  it('druga firma nie widzi kopii pierwszej (RLS), pulpit B pusty', async () => {
    seedLikeBl()
    const acc = await sd(db, 'test_a')
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => NOW })
    await seedBase(dbB)
    const dB = await dashboard(dbB, NOW)
    expect(dB.today).toMatchObject({ count: 0, gross: 0, outside: { beforeStart: 0, notIngested: 0, skipped: 0, cancelled: 0 } })
    expect(dB.monthTotals.count).toBe(0)
  })
})
