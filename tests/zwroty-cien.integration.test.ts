// ekran „Zwroty i reklamacje” w cieniu — tylko odczyt. Dwie firmy bez przecieku, reklamacje z kopii BL
// z kopią kanału i bez niej, limit listy, zero zapisów (liczba wierszy wszystkich tabel przed i po odczycie).
// Dane fikcyjne: same identyfikatory, statusy i kwoty; żadnych danych osobowych.
import type { Channel, PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ZWROTY_LIMIT, zwrotyPanel } from '@/lib/panel/zwroty'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { seedBase } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
const T = new Date('2026-11-02T10:00:00Z')
const ACC: Record<Channel, string> = { WOO: 'sd', ALLEGRO: 'allegro', EMPIK: 'empik', EASYTOOLS: 'et', BL_INNE: 'bl', RECZNE: 'panel', AI: 'ai', SHOPER: 'shoper', PRESTASHOP: 'presta', IDOSELL: 'idosell' }

afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})

async function order(db: PrismaClient, channel: Channel, externalId: string): Promise<string> {
  const o = await db.order.create({
    data: { channel, channelAccountId: ACC[channel], externalId, paymentState: 'PAID', paymentMethod: 'przelew', totalGross: '49.90', createdAtChannel: T },
  })
  return o.id
}

function snapData(channel: Channel, externalId: string, channelStatus: string, opts: { orderId?: string; blOrderId?: number; seenAt?: Date } = {}) {
  return {
    channel,
    channelAccountId: ACC[channel],
    externalId,
    revision: 'r1',
    channelStatus,
    lifecycle: 'FULFILLED',
    paymentState: 'PAID' as const,
    totalGross: '49.90',
    currency: 'PLN',
    lineCount: 1,
    warnings: [],
    createdAtChannel: T,
    firstSeenAt: T,
    lastSeenAt: T,
    revisionSeenAt: opts.seenAt ?? T,
    orderId: opts.orderId ?? null,
    blOrderId: opts.blOrderId ?? null,
  }
}

async function snap(db: PrismaClient, channel: Channel, externalId: string, channelStatus: string, opts: { orderId?: string; blOrderId?: number; seenAt?: Date } = {}) {
  await db.channelOrderSnapshot.create({ data: snapData(channel, externalId, channelStatus, opts) })
}

async function bl(db: PrismaClient, blOrderId: number, statusName: string | null, opts: { channel?: Channel; externalRef?: string } = {}) {
  const channel = opts.channel ?? 'EMPIK'
  await db.blOrderSnapshot.create({
    data: {
      blOrderId,
      orderSource: 'emp',
      orderSourceId: '1',
      channel,
      channelAccountId: ACC[channel],
      externalRef: opts.externalRef ?? null,
      statusId: 100 + (blOrderId % 10),
      statusName,
      totalGross: '79.00',
      dateAdd: T,
      fetchedAt: T,
    },
  })
}

/** Liczba wierszy każdej tabeli (klient systemowy, przez wszystkie firmy). */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = await sys.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  const out: Record<string, number> = {}
  for (const { tablename } of tables) {
    const [r] = await sys.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${tablename}"`)
    out[tablename] = Number(r!.n)
  }
  return out
}

describe('zwroty i reklamacje w cieniu', () => {
  it('sygnały z kanałów: tylko statusy zwrotu/reklamacji, bez przecieku między firmami; bez zamówienia = bez linku', async () => {
    const oid = await order(a, 'EMPIK', 'E-1')
    await snap(a, 'WOO', '101', 'refunded', { seenAt: new Date(T.getTime() - 3600_000) })
    await snap(a, 'WOO', '102', 'completed')
    await snap(a, 'EMPIK', 'E-1', 'INCIDENT_OPEN', { orderId: oid })
    await snap(a, 'EMPIK', 'E-2', 'WAITING_REFUND')
    await snap(a, 'EMPIK', 'E-3', 'INCIDENT_CLOSED')
    await snap(a, 'EMPIK', 'E-4', 'SHIPPED')
    await snap(a, 'ALLEGRO', 'A-1', 'READY_FOR_PROCESSING/RETURNED')
    await snap(a, 'ALLEGRO', 'A-2', 'READY_FOR_PROCESSING/SENT')
    await snap(b, 'WOO', '901', 'refunded')

    const da = await zwrotyPanel(a, 'sygnaly')
    expect(da.counts.sygnaly).toBe(5)
    expect(da.signals.map((s) => [s.externalId, s.signal]).sort()).toEqual([
      ['101', 'ZWROT_PIENIEDZY'],
      ['A-1', 'ZWROT'],
      ['E-1', 'REKLAMACJA'],
      ['E-2', 'ZWROT_PIENIEDZY'],
      ['E-3', 'REKLAMACJA_ZAMKNIETA'],
    ])
    expect(da.signals.at(-1)!.externalId).toBe('101') // od najnowszej revisionSeenAt
    expect(da.signals.find((s) => s.externalId === 'E-1')!.orderId).toBe(oid)
    expect(da.signals.find((s) => s.externalId === 'E-2')!.orderId).toBeNull()

    const db_ = await zwrotyPanel(b, 'sygnaly')
    expect(db_.counts.sygnaly).toBe(1)
    expect(db_.signals.map((s) => s.externalId)).toEqual(['901'])
    expect(db_.counts.wlasne).toBe(0)
  })

  it('reklamacje w BL: rodzina REKLAMACJA z kopią kanału (link) i bez niej; inne statusy i inna firma poza listą', async () => {
    const oid = await order(a, 'EMPIK', 'E-10')
    await snap(a, 'EMPIK', 'E-10', 'SHIPPED', { orderId: oid, blOrderId: 501 })
    await snap(a, 'EMPIK', 'E-11', 'SHIPPED', { blOrderId: 503 }) // kopia sprzed pierwszego odczytu: bez zamówienia
    await bl(a, 501, 'Reklamacja')
    await bl(a, 502, 'REKLAMACJE – w toku', { externalRef: 'E-12' })
    await bl(a, 503, 'reklamacja DPD')
    await bl(a, 504, 'Wysłane')
    await bl(a, 505, null)
    // firma B: ten sam numer BL (klucz jest per firma) z własną kopią kanału
    await snap(b, 'EMPIK', 'E-90', 'SHIPPED', { blOrderId: 501 })
    await bl(b, 501, 'Reklamacja')

    const da = await zwrotyPanel(a, 'reklamacje')
    expect(da.counts.reklamacje).toBe(3)
    const byId = new Map(da.complaints.map((c) => [c.blOrderId, c]))
    expect([...byId.keys()].sort()).toEqual([501, 502, 503])
    expect(byId.get(501)!.channelCopy).toEqual({ channel: 'EMPIK', channelAccountId: 'empik', externalId: 'E-10', orderId: oid })
    expect(byId.get(502)!.channelCopy).toBeNull()
    expect(byId.get(502)!.externalRef).toBe('E-12')
    expect(byId.get(503)!.channelCopy?.orderId).toBeNull()

    const dbB = await zwrotyPanel(b, 'reklamacje')
    expect(dbB.complaints.map((c) => [c.blOrderId, c.channelCopy?.externalId])).toEqual([[501, 'E-90']])
  })

  it(`limit ${ZWROTY_LIMIT} wierszy, licznik liczy wszystkie`, async () => {
    const n = ZWROTY_LIMIT + 5
    await a.channelOrderSnapshot.createMany({ data: Array.from({ length: n }, (_, i) => snapData('WOO', `${1000 + i}`, 'refunded', { seenAt: new Date(T.getTime() + i * 1000) })) })
    const d = await zwrotyPanel(a, 'sygnaly')
    expect(d.counts.sygnaly).toBe(n)
    expect(d.signals).toHaveLength(ZWROTY_LIMIT)
    expect(d.signals[0]!.externalId).toBe(`${1000 + n - 1}`)
  })

  it(`reklamacje: strona ${ZWROTY_LIMIT} wierszy z zapytania, licznik z count`, async () => {
    const n = ZWROTY_LIMIT + 3
    for (let i = 0; i < n; i++) await bl(a, 7000 + i, i % 2 ? 'Reklamacja' : 'reklamacja DPD')
    await bl(a, 9999, 'Wysłane')
    const d = await zwrotyPanel(a, 'reklamacje')
    expect(d.counts.reklamacje).toBe(n)
    expect(d.complaints).toHaveLength(ZWROTY_LIMIT)
    expect(d.complaints.every((c) => c.blOrderId !== 9999)).toBe(true)
  })

  it('zwroty własne: wiersze z numerem zamówienia i liczniki per stan; w drugiej firmie pusto', async () => {
    const oid = await order(a, 'WOO', '301')
    await a.return.create({ data: { orderId: oid, invoiceDocId: 'FV-TEST-1', status: 'PRZYJETY', lines: { create: [{ orderLineId: 'l1', productId: 'p1', qty: 1 }, { orderLineId: 'l2', productId: 'p2', qty: 250 }] } } })
    await a.return.create({ data: { orderId: oid, invoiceDocId: 'FV-TEST-2', kind: 'KOREKTA' } })
    const d = await zwrotyPanel(a, 'wlasne')
    expect(d.counts.wlasne).toBe(2)
    expect(d.ownByStatus).toEqual({ ZGLOSZONY: 1, PRZYJETY: 1, KOREKTA: 0, ZAKONCZONY: 0, ODRZUCONY: 0 })
    expect(d.own.map((r) => [r.order.externalId, r.status, r.lines]).sort()).toEqual([
      ['301', 'PRZYJETY', 2],
      ['301', 'ZGLOSZONY', 0],
    ])
    const dB = await zwrotyPanel(b, 'wlasne')
    expect(dB.counts.wlasne).toBe(0)
    expect(dB.own).toEqual([])
  })

  it('zero zapisów: liczba wierszy wszystkich tabel bez zmian po odczycie każdej listy', async () => {
    const oid = await order(a, 'EMPIK', 'E-20')
    await snap(a, 'EMPIK', 'E-20', 'INCIDENT_OPEN', { orderId: oid, blOrderId: 601 })
    await bl(a, 601, 'Reklamacja')
    await a.return.create({ data: { orderId: oid, invoiceDocId: 'FV-TEST-3' } })
    const before = await rowCounts()
    const maxUpdated = await a.return.findFirstOrThrow({ select: { updatedAt: true } })
    for (const l of ['sygnaly', 'reklamacje', 'wlasne'] as const) await zwrotyPanel(a, l)
    expect(await rowCounts()).toEqual(before)
    expect(await a.return.findFirstOrThrow({ select: { updatedAt: true } })).toEqual(maxUpdated)
  })

  it('klient systemowy odrzucony (ekran czyta tylko przez klienta firmy)', async () => {
    await expect(zwrotyPanel(sys, 'sygnaly')).rejects.toThrow(/klienta firmy/)
  })
})
