// zamówienia Allegro z pozycją „bez powiązania z produktem” po imporcie katalogu. Oferta Allegro powstaje
// dopiero z okna sprzedaży BL (import z KATALOG_IMPORT_DNI_SPRZEDAZY > 0), a zamówienia z natywnego odczytu przyszły
// wcześniej: import ma je sam przeliczyć (produkt, rezerwacja, powrót z „Do wyjaśnienia”), każde osobno i idempotentnie.
// Dane zmyślone (tests/fixtures.ts).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { analyze } from '@/lib/import/katalog'
import { persistImport } from '@/lib/import/zapis'
import { przeliczZalegle } from '@/lib/kanaly/przeliczenie'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { smallRaw } from './fixtures'
import { ORG_B, seedImportConfig, testDb, truncateAll } from './db'
import { expectInvariants } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const T = new Date('2026-11-04T10:00:00.000Z')
const ALLEGRO = { channel: 'ALLEGRO' as const, channelAccountId: '71045' }

beforeEach(async () => {
  await truncateAll(db)
  await seedImportConfig()
})

async function allegroOrder(d = db, externalId: string, offer: string, qty = 1, account = ALLEGRO.channelAccountId) {
  return ingestOrder(
    d,
    {
      source: 'test',
      channel: 'ALLEGRO',
      channelAccountId: account,
      externalId,
      externalRevision: '2026-11-04T09:00:00.000Z',
      createdAtChannel: new Date('2026-11-04T09:00:00.000Z'),
      paymentState: 'PAID',
      paymentMethod: 'allegro',
      totalGross: 30,
      lines: [{ externalLineId: `${externalId}-1`, offerExternalId: offer, qty, unitPriceGross: 30 }],
    },
    { now: T },
  )
}

const b1Stock = async () => (await db.stock.findFirstOrThrow({ where: { product: { sku: 'B1' } } }))

describe('import katalogu przelicza zamówienia czekające na ofertę', () => {
  it('oferta Allegro założona importem: zaległe zamówienie dostaje produkt i rezerwację, wraca z „Do wyjaśnienia”; powtórka nic nie zmienia', async () => {
    const r = await allegroOrder(db, 'aaaa-1', '9001', 1)
    expect(r.status).toBe('DO_WYJASNIENIA')
    const raw = smallRaw()
    const s = await persistImport(db, raw, analyze(raw), { now: T })
    expect(s).toMatchObject({ status: 'OK', ordersRemapped: 1, ordersRemapFailed: 0 })
    const o = await db.order.findFirstOrThrow({ where: { externalId: 'aaaa-1' }, include: { lines: true } })
    expect(o.status).not.toBe('DO_WYJASNIENIA')
    const b1 = await db.product.findFirstOrThrow({ where: { sku: 'B1' } })
    expect(o.lines[0]).toMatchObject({ productId: b1.id, qty: 1000 }) // 1 szt. oferty = 1000 g (towar w kg)
    expect((await b1Stock()).reserved).toBe(1000)
    await expectInvariants(db)

    const raw2 = smallRaw()
    const s2 = await persistImport(db, raw2, analyze(raw2), { now: new Date(T.getTime() + 600_000) })
    expect(s2).toMatchObject({ status: 'OK', ordersRemapped: 0, ordersRemapFailed: 0 })
    expect((await b1Stock()).reserved).toBe(1000)
    expect(await db.reservation.count()).toBe(1)
    await expectInvariants(db)
  })

  it('oferta bez powiązania w BL zostaje „Do wyjaśnienia”, bez błędu importu; inne konto i inna firma nietknięte', async () => {
    await allegroOrder(db, 'bbbb-1', '9002', 1) // 9002: sprzedaż BL bez produktu (UNMAPPED)
    await allegroOrder(db, 'cccc-1', '9001', 1, '99999') // ta sama oferta pod innym kontem Allegro
    await seedImportConfig(ORG_B)
    await allegroOrder(dbB, 'dddd-1', '9001', 1)
    const raw = smallRaw()
    const s = await persistImport(db, raw, analyze(raw), { now: T })
    expect(s).toMatchObject({ status: 'OK', ordersRemapped: 0, ordersRemapFailed: 0 })
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'bbbb-1' } })).status).toBe('DO_WYJASNIENIA')
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'cccc-1' } })).status).toBe('DO_WYJASNIENIA')
    const b = await dbB.order.findFirstOrThrow({ where: { externalId: 'dddd-1' }, include: { lines: true } })
    expect(b.status).toBe('DO_WYJASNIENIA')
    expect(b.lines[0]!.productId).toBeNull()
  })

  it('oferta wyłączona w panelu: import jej nie włącza i nie przelicza; po włączeniu przeliczenie zaległych (skrypt) robi to raz', async () => {
    const raw = smallRaw()
    await persistImport(db, raw, analyze(raw), { now: T })
    await db.channelOffer.updateMany({ where: { ...ALLEGRO, externalId: '9001' }, data: { active: false } })
    expect((await allegroOrder(db, 'eeee-1', '9001', 2)).status).toBe('DO_WYJASNIENIA')
    const raw2 = smallRaw()
    const s2 = await persistImport(db, raw2, analyze(raw2), { now: T })
    expect(s2.ordersRemapped).toBe(0)
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'eeee-1' } })).status).toBe('DO_WYJASNIENIA')

    const przed = await przeliczZalegle(db, { now: T })
    expect(przed).toEqual({ remapped: 0, failed: 0, accounts: 0, offers: 0, orders: 0, stillWithoutOffer: 1 })
    await db.channelOffer.updateMany({ where: { ...ALLEGRO, externalId: '9001' }, data: { active: true } })
    const sucho = await przeliczZalegle(db, { now: T, naSucho: true })
    expect(sucho).toEqual({ remapped: 0, failed: 0, accounts: 1, offers: 1, orders: 1, stillWithoutOffer: 0 })
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'eeee-1' } })).status).toBe('DO_WYJASNIENIA') // na sucho nic nie zapisane
    const w = await przeliczZalegle(db, { now: T, channel: 'ALLEGRO' })
    expect(w).toEqual({ remapped: 1, failed: 0, accounts: 1, offers: 1, orders: 1, stillWithoutOffer: 0 })
    const o = await db.order.findFirstOrThrow({ where: { externalId: 'eeee-1' }, include: { lines: true } })
    expect(o.status).not.toBe('DO_WYJASNIENIA')
    expect(o.lines[0]!.qty).toBe(2000)
    expect((await b1Stock()).reserved).toBe(2000)
    expect(await przeliczZalegle(db, { now: T })).toEqual({ remapped: 0, failed: 0, accounts: 0, offers: 0, orders: 0, stillWithoutOffer: 0 })
    await expectInvariants(db)
  })
})

