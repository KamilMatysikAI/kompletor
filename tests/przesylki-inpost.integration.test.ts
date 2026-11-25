// podgląd przesyłki z modułem InPost ShipX (paczkomat i kurier). Idempotencja, izolacja dwóch firm, brak
// danych osobowych w PreparedShipment, prawdziwy adapterKey w wierszu. Bez sieci: podgląd liczy czysta funkcja
// (lib/wysylka/moduly.ts), a żaden klient HTTP nie powstaje. Dane fikcyjne.
import type { Prisma } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { podgladPrzesylki, prepareForOrder } from '@/lib/wysylka/podglad'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const PACZKOMAT = 'Paczkomaty InPost'
const KURIER = 'Kurier InPost'

/** Firma przełącza paczkomaty na ShipX (adapter z modułu) i dodaje regułę kuriera InPost przed regułą „dpd|kurier”. */
async function modulInpost(klient = db, config: Prisma.InputJsonObject = {}): Promise<void> {
  await klient.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'INPOST_SHIPX', adapterKey: null, config } })
  await klient.carrierRule.create({ data: { priority: 5, channel: null, pattern: 'kurier inpost', carrier: 'INPOST_KURIER', shippingModule: 'INPOST_SHIPX', adapterKey: 'inpost.shipx.v1', config } })
}

async function zamowienie(deliveryMethod: string, opts: { paymentState?: 'PAID' | 'COD'; paymentMethod?: string } = {}, klient = db): Promise<string> {
  const pid = await product(klient, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(klient, order([{ productId: pid, qty: 2, unitPriceGross: 25 }], { deliveryMethod, paymentState: opts.paymentState ?? 'PAID', paymentMethod: opts.paymentMethod ?? 'Przelew' }), { now: T0 })
  return r.orderId!
}

const kody = (v: unknown) => (v as { kod: string }[]).map((p) => p.kod)

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
})

describe('podgląd przesyłki InPost ShipX', () => {
  it('paczkomat: usługa ShipX, wymiary gabarytu, bez danych klienta punkt sprawdza nadanie (INFO), adapterKey z modułu', async () => {
    await modulInpost()
    const id = await zamowienie(PACZKOMAT)
    const przed = await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, events: true, lines: true } })
    expect(await prepareForOrder(db, id, 'INPOST_C')).toMatchObject({ wynik: 'przygotowane', parcel: { courierCode: 'inpost_locker_standard' } })
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(w).toMatchObject({ organizationId: ORG_A, adapterKey: 'inpost.shipx.v1', carrier: 'PACZKOMATY', courierCode: 'inpost_locker_standard', parcelSize: 'INPOST_C', sideXCm: 41, sideYCm: 38, sideZCm: 64 })
    expect(kody(w.problems)).toEqual(expect.arrayContaining(['punkt_przy_nadaniu', 'waga_domyslna']))
    expect(kody(w.problems)).not.toContain('punkt')
    expect(await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, events: true, lines: true } })).toEqual(przed)
  })

  it('kurier InPost: przewoźnik INPOST_KURIER z reguły, wymiary z konfiguracji reguły, bez punktu', async () => {
    await modulInpost(db, { defaultSideXCm: 60, defaultSideYCm: 40, defaultSideZCm: 30, defaultWeightKg: 2 })
    const id = await zamowienie(KURIER)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('INPOST_KURIER')
    await prepareForOrder(db, id)
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(w).toMatchObject({ adapterKey: 'inpost.shipx.v1', carrier: 'INPOST_KURIER', courierCode: 'inpost_courier_standard', parcelSize: 'INPOST_KURIER', sideXCm: 60, sideYCm: 40, sideZCm: 30 })
    expect(Number(w.weightKg)).toBe(2)
    expect(kody(w.problems)).not.toContain('punkt')
    const p = await podgladPrzesylki(db, id)
    expect(p).toMatchObject({ nieDotyczy: null, gabaryty: [{ kod: 'INPOST_KURIER', nazwa: 'InPost kurier' }], zapisana: { przewoznik: 'INPOST_KURIER', wymiary: '60 × 40 × 30 cm', wymiaryRobocze: false } })
  })

  it('pobranie: kwota z zamówienia, ponad limit z konfiguracji = BLAD', async () => {
    await modulInpost(db, { codLimit: 10 })
    const id = await zamowienie(PACZKOMAT, { paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    await prepareForOrder(db, id, 'INPOST_A')
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(Number(w.codAmount)).toBe(Number((await db.order.findUniqueOrThrow({ where: { id } })).totalGross))
    expect(kody(w.problems)).toEqual(expect.arrayContaining(['pobranie_limit', 'pobranie_ubezpieczenie']))
  })

  it('idempotentne: ponowne i równoległe przygotowanie = jeden wiersz; zmiana modułu nadpisuje adapterKey', async () => {
    await modulInpost()
    const id = await zamowienie(PACZKOMAT)
    await prepareForOrder(db, id, 'INPOST_A')
    const pierwszy = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    await Promise.all([prepareForOrder(db, id, 'INPOST_B'), prepareForOrder(db, id, 'INPOST_C'), prepareForOrder(db, id, 'INPOST_A')])
    expect(await db.preparedShipment.count({ where: { orderId: id } })).toBe(1)
    await prepareForOrder(db, id, 'INPOST_B')
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ id: pierwszy.id, parcelSize: 'INPOST_B', sideXCm: 19 })
    await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'BASE_COURIER' } })
    await prepareForOrder(db, id, 'INPOST_B')
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ id: pierwszy.id, adapterKey: 'basecourier.v1', courierCode: 'paczkomaty' })
  })

  it('klucz zapisu w regule też liczy podgląd (bez sieci i bez zapisu)', async () => {
    await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'INPOST_SHIPX', adapterKey: 'inpost.shipx.zapis.v1', config: { zapisWlaczony: true } } })
    const id = await zamowienie(PACZKOMAT)
    await prepareForOrder(db, id, 'INPOST_A')
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ adapterKey: 'inpost.shipx.zapis.v1', courierCode: 'inpost_locker_standard' })
  })

  it('izolacja: firma B z Base Courier, firma A z ShipX; B nie widzi podglądu A', async () => {
    await modulInpost()
    const a = await zamowienie(PACZKOMAT)
    const b = await zamowienie(PACZKOMAT, {}, dbB)
    await prepareForOrder(db, a, 'INPOST_A')
    await prepareForOrder(dbB, b, 'INPOST_A')
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ adapterKey: 'inpost.shipx.v1' })
    expect(await dbB.preparedShipment.findFirstOrThrow({ where: { orderId: b } })).toMatchObject({ adapterKey: 'basecourier.v1' })
    expect(await podgladPrzesylki(dbB, a)).toBeNull()
    expect(await dbB.preparedShipment.count()).toBe(1)
    await expect(dbB.preparedShipment.updateMany({ where: { orderId: a }, data: { parcelSize: 'x' } })).resolves.toEqual({ count: 0 })
    const all = await sys.preparedShipment.findMany({ select: { organizationId: true, adapterKey: true } })
    expect(all.map((x) => `${x.organizationId}:${x.adapterKey}`).sort()).toEqual([`${ORG_A}:inpost.shipx.v1`, `${ORG_B}:basecourier.v1`].sort())
  })

  it('wiersz bez danych osobowych', async () => {
    await modulInpost()
    const id = await zamowienie(`${KURIER} ${PII_SENTINELS[0]}`, { paymentMethod: `Za pobraniem ${PII_SENTINELS[1]}` })
    await prepareForOrder(db, id)
    const w = await sys.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    const json = JSON.stringify(w)
    for (const p of PII_SENTINELS) expect(json).not.toContain(p)
    expect(Object.keys(w).sort()).toEqual(['adapterKey', 'carrier', 'codAmount', 'courierCode', 'createdAt', 'id', 'orderId', 'organizationId', 'packageNo', 'parcelSize', 'problems', 'sideXCm', 'sideYCm', 'sideZCm', 'weightKg'].sort())
  })

  it('moduł bez wpisu liczenia = „nie dotyczy” z nazwą modułu, bez „Base Courier”', async () => {
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'nieznany.modul.v1' } })
    const id = await zamowienie('Kurier DPD')
    const w = await prepareForOrder(db, id)
    expect(w).toMatchObject({ wynik: 'nie_dotyczy', powod: 'Moduł wysyłki „nieznany.modul.v1” nie liczy jeszcze przesyłek dla tego przewoźnika.' })
    expect(JSON.stringify(w)).not.toContain('Base Courier')
  })
})
