// podgląd przesyłki DPD bezpośrednio (moduł DPD_BEZPOSREDNIO, `dpd.services.v1`). Idempotencja, izolacja
// dwóch firm (B zostaje przy Base Courier), salon Empik bez punktu, podział paczki, brak danych osobowych w wierszu.
// Dane fikcyjne, zero połączeń zewnętrznych: podgląd nie woła sieci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import { shipLater } from '@/lib/rdzen/brakuje'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { podgladPrzesylki, prepareForOrder } from '@/lib/wysylka/podglad'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const DPD = 'Kurier DPD'
const EMPIK = 'Dostawa do salonu Empik'
const USTAWIENIA = { defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 }

async function zamowienie(deliveryMethod: string, opts: { qty?: number; paymentState?: 'PAID' | 'COD'; paymentMethod?: string } = {}, klient = db): Promise<string> {
  const pid = await product(klient, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(klient, order([{ productId: pid, qty: opts.qty ?? 2, unitPriceGross: 25 }], { deliveryMethod, paymentState: opts.paymentState ?? 'PAID', paymentMethod: opts.paymentMethod ?? 'Przelew' }), { now: T0 })
  return r.orderId!
}

const kody = (w: { problems: unknown }) => (w.problems as { kod: string; poziom: string }[]).map((p) => `${p.poziom}:${p.kod}`)

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
  // Firma A: DPD i salon Empik bezpośrednio przez DPD (klucz z modułu, bez adapterKey w regule); firma B bez zmian.
  await db.carrierRule.updateMany({ where: { carrier: { in: ['DPD', 'DPD_EMPIK'] } }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: null, config: USTAWIENIA } })
})

describe('prepareForOrder z modułem DPD bezpośrednio', () => {
  it('kurier: wiersz z kluczem dpd.services.v1, kodem DPD_CLASSIC i wymiarami z reguły; idempotentne, także równolegle', async () => {
    const id = await zamowienie(DPD)
    const r = await prepareForOrder(db, id)
    expect(r).toMatchObject({ wynik: 'przygotowane', parcel: { courierCode: 'DPD_CLASSIC', pickupPoint: null } })
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(w).toMatchObject({ organizationId: ORG_A, adapterKey: 'dpd.services.v1', carrier: 'DPD', courierCode: 'DPD_CLASSIC', parcelSize: 'DPD', sideXCm: 40, sideYCm: 30, sideZCm: 20, codAmount: null })
    expect(kody(w)).toEqual(['OSTRZEZENIE:waga_domyslna', 'OSTRZEZENIE:gabaryt_podpowiedz'])
    await prepareForOrder(db, id)
    await Promise.all([prepareForOrder(db, id), prepareForOrder(db, id)])
    expect(await db.preparedShipment.count({ where: { orderId: id } })).toBe(1)
    expect((await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })).id).toBe(w.id)
  })

  it('pobranie: kwota zamówienia jako COD', async () => {
    const id = await zamowienie(DPD, { paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    await prepareForOrder(db, id)
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(Number((await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })).codAmount)).toBe(Number(o.totalGross))
  })

  it('salon Empik: Pickup bez kodu salonu = BLAD punkt i ostrzeżenie empik_niepotwierdzone', async () => {
    const id = await zamowienie(EMPIK)
    await prepareForOrder(db, id)
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(w).toMatchObject({ adapterKey: 'dpd.services.v1', carrier: 'DPD_EMPIK', courierCode: 'DPD_PICKUP' })
    expect(kody(w)).toEqual(expect.arrayContaining(['OSTRZEZENIE:empik_niepotwierdzone', 'BLAD:punkt']))
    expect((await podgladPrzesylki(db, id))!.zapisana!.problemy.map((p) => p.kod)).toContain('empik_niepotwierdzone')
  })

  it('podział paczki („dośle później”): salon Empik dostaje BLAD pickup_jedna_paczka, kurier nie', async () => {
    const id = await zamowienie(EMPIK, { qty: 3 })
    const l = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    await db.shortage.create({ data: { orderId: id, orderLineId: l.id, productId: l.productId!, qtyBase: 1, state: 'OPEN' } })
    await shipLater(db, l.id, { now: T0 })
    await prepareForOrder(db, id)
    expect(kody(await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } }))).toContain('BLAD:pickup_jedna_paczka')

    const k = await zamowienie(DPD, { qty: 3 })
    const lk = await db.orderLine.findFirstOrThrow({ where: { orderId: k } })
    await db.shortage.create({ data: { orderId: k, orderLineId: lk.id, productId: lk.productId!, qtyBase: 1, state: 'OPEN' } })
    await shipLater(db, lk.id, { now: T0 })
    await prepareForOrder(db, k)
    expect(kody(await db.preparedShipment.findFirstOrThrow({ where: { orderId: k } }))).not.toContain('BLAD:pickup_jedna_paczka')
  })

  it('reguła z kluczem spoza listy liczenia = nie dotyczy, bez wiersza', async () => {
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { adapterKey: 'inny.przewoznik.v1' } })
    const id = await zamowienie(DPD)
    // powód nazywa moduł, nie podsuwa Base Courier
    expect(await prepareForOrder(db, id)).toMatchObject({ wynik: 'nie_dotyczy', powod: 'Moduł wysyłki „inny.przewoznik.v1” nie liczy jeszcze przesyłek dla tego przewoźnika.' })
    expect(await db.preparedShipment.count()).toBe(0)
  })
})

describe('izolacja i dane osobowe', () => {
  it('firma A liczy DPD bezpośrednio, firma B to samo zamówienie przez Base Courier; B nie widzi wiersza A', async () => {
    const a = await zamowienie(DPD)
    const b = await zamowienie(DPD, {}, dbB)
    await prepareForOrder(db, a)
    await prepareForOrder(dbB, b)
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: a } })).toMatchObject({ adapterKey: 'dpd.services.v1', courierCode: 'DPD_CLASSIC' })
    expect(await dbB.preparedShipment.findFirstOrThrow({ where: { orderId: b } })).toMatchObject({ adapterKey: 'basecourier.v1', courierCode: 'dpd' })
    expect(await dbB.preparedShipment.count({ where: { orderId: a } })).toBe(0)
    expect(await podgladPrzesylki(dbB, a)).toBeNull()
    const all = await sys.preparedShipment.findMany({ select: { organizationId: true, adapterKey: true } })
    expect(all.map((x) => `${x.organizationId}:${x.adapterKey}`).sort()).toEqual([`${ORG_A}:dpd.services.v1`, `${ORG_B}:basecourier.v1`].sort())
  })

  it('wiersz bez danych osobowych: tylko parametry przesyłki', async () => {
    const id = await zamowienie(`${DPD} ${PII_SENTINELS[0]}`, { paymentState: 'COD', paymentMethod: `Za pobraniem ${PII_SENTINELS[1]}` })
    const e = await zamowienie(`${EMPIK} ${PII_SENTINELS[3]}`)
    await prepareForOrder(db, id)
    await prepareForOrder(db, e)
    for (const w of await sys.preparedShipment.findMany()) {
      const json = JSON.stringify(w)
      for (const p of PII_SENTINELS) expect(json).not.toContain(p)
      expect(Object.keys(w).sort()).toEqual(['adapterKey', 'carrier', 'codAmount', 'courierCode', 'createdAt', 'id', 'orderId', 'organizationId', 'packageNo', 'parcelSize', 'problems', 'sideXCm', 'sideYCm', 'sideZCm', 'weightKg'].sort())
    }
  })
})
