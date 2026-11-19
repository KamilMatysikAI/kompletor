// zwrot przy źródle stanu KOMPLETOR. Towar zszedł przy „Do wysyłki”
// ruchem OWN_DISPATCH, więc zwrot nie ma faktury do korekty: przyjęcie „na stan” = ruch OWN_RETURN +qty od razu,
// „uszkodzone” = ruch 0, bez kolejki wFirmy. Anulowanie po wydaniu: przycisk „Przyjmij zwrot na stan” na karcie zdejmuje
// `doKorekty` bez wFirmy. Ścieżka wFirmy (lustro) bez zmian: tests/rdzen-zwroty.integration.test.ts. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { widokDokumentow, zmienZrodloStanu } from '@/lib/dokumenty/zapis'
import { faktyEkranu } from '@/lib/praca/dane'
import { dostepnePrzejscia } from '@/lib/praca/przejscia-ekran'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { markShipped, readyForDispatch } from '@/lib/rdzen/przejscia'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { packOrder } from '@/lib/rdzen/rozchod'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { createReturn, issueCorrection, pozostaloDoZwrotu, przyjmijZwrotPoAnulowaniu, receiveReturn, requestCorrection, ReturnError } from '@/lib/rdzen/zwroty'
import { zrodloStanu } from '@/lib/rdzen/zrodlo-stanu'
import { testDb, truncateAll } from './db'
import { bundle, expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  // firma bez wFirmy: stan prowadzi Kompletor
  await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
})
afterAll(() => db.$disconnect())

const PRAWA = new Set(['zamowienia.przejscia', 'zamowienia.anuluj_po_fakturze'])

async function wydane(lines: { productId: string; qty: number }[], wyslij = true) {
  const { orderId } = await ingestOrder(db, order(lines), { now: T0 })
  const id = orderId!
  await packOrder(db, id, { now: T0 })
  expect(await readyForDispatch(db, id, { now: T0 })).toBe('DO_WYSLANIA')
  if (wyslij) await markShipped(db, id, { now: T0 })
  const ol = await db.orderLine.findMany({ where: { orderId: id }, orderBy: { externalLineId: 'asc' } })
  return { id, lines: ol }
}

async function przyciskiKarty(id: string) {
  const o = await db.order.findUniqueOrThrow({ where: { id } })
  return dostepnePrzejscia({ status: o.status, carrier: o.carrier, pendingAction: o.pendingAction, paymentState: o.paymentState, kartaNieaktualna: false }, await faktyEkranu(db, o), PRAWA)
}

describe('zwrot przy stanie Kompletora', () => {
  it('zwrot paczki: „na stan” wraca od razu ruchem OWN_RETURN, „uszkodzone” ruch 0, bez faktury i bez kolejki wFirmy', async () => {
    const a = await product(db, 'A121-A', 10)
    const b = await product(db, 'A121-B', 5)
    const { id, lines } = await wydane([{ productId: a, qty: 3 }, { productId: b, qty: 2 }])
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, reserved: 0, available: 7 })

    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 2 }, { orderLineId: lines[1]!.id, qty: 1 }], { now: T0 })
    const r = await db.return.findUniqueOrThrow({ where: { id: rid } })
    expect(r).toMatchObject({ status: 'ZGLOSZONY', invoiceDocId: null })

    const rl = await db.returnLine.findMany({ where: { returnId: rid }, orderBy: { productId: 'asc' } })
    const disp = Object.fromEntries(rl.map((l) => [l.id, l.productId === a ? ('NA_STAN' as const) : ('USZKODZONE' as const)]))
    await receiveReturn(db, rid, disp, { now: T0, actorId: 'test' })

    expect(await db.return.findUniqueOrThrow({ where: { id: rid } })).toMatchObject({ status: 'ZAKONCZONY', correctionState: null })
    expect(await stockOf(db, a)).toMatchObject({ physical: 9, available: 9, wfirmaCount: 9, pendingDelta: 0 })
    expect(await stockOf(db, b)).toMatchObject({ physical: 3, available: 3 })
    const ruchy = await db.stockMovement.findMany({ where: { orderId: id, source: 'OWN_RETURN' }, orderBy: { deltaPhysical: 'desc' }, select: { productId: true, deltaPhysical: true, actorId: true } })
    expect(ruchy).toEqual([
      { productId: a, deltaPhysical: 2, actorId: 'test' },
      { productId: b, deltaPhysical: 0, actorId: 'test' },
    ])
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ' } })).toBe(0)
    expect(await db.outboxEvent.count({ where: { kind: 'ALLOCATE', productId: a } })).toBeGreaterThan(0)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'ZWROT_NA_STAN' } })).toBe(1)

    // kolejka wFirmy (gdyby firma miała klucze) tego zwrotu nie dotyka: korekta w wFirmie nie dotyczy
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf, korekty: wf, odczyt: null }, { now: T0 })
    expect(await issueCorrection(db, rid, wf, { now: T0 })).toBe('NIC')
    expect(wf.calls).toBe(0)
    // drugie przyjęcie: odmowa, stan bez zmian
    await expect(receiveReturn(db, rid, 'NA_STAN', { now: T0 })).rejects.toThrow(ReturnError)
    expect((await stockOf(db, a)).physical).toBe(9)
    // limit: zwrócić można tylko to, co wydane i jeszcze niezwrócone
    await expect(createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 2 }], { now: T0 })).rejects.toThrow('wydane z magazynu i jeszcze nie zwrócone 1')
    await expectInvariants(db)
  })

  it('korekta bez przesyłki (KOREKTA): „zleć korektę” kończy zwrot lokalnie, bez stanu KOREKTA', async () => {
    const a = await product(db, 'A121-K', 4)
    const { id, lines } = await wydane([{ productId: a, qty: 2 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1, disposition: 'NA_STAN' }], { now: T0, kind: 'KOREKTA' })
    expect((await db.return.findUniqueOrThrow({ where: { id: rid } })).status).toBe('PRZYJETY')
    await requestCorrection(db, rid, { now: T0 })
    expect(await db.return.findUniqueOrThrow({ where: { id: rid } })).toMatchObject({ status: 'ZAKONCZONY', invoiceDocId: null })
    expect((await stockOf(db, a)).physical).toBe(3)
    await expectInvariants(db)
  })

  it('zestaw: zwrot całej pozycji wraca składnikami', async () => {
    const x = await product(db, 'A121-X', 10)
    const y = await product(db, 'A121-Y', 10)
    const z = await bundle(db, 'A121-Z', [{ id: x, qty: 1 }, { id: y, qty: 2 }])
    const { id, lines } = await wydane([{ productId: z, qty: 2 }])
    expect(await stockOf(db, y)).toMatchObject({ physical: 6 })
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { now: T0 })
    await receiveReturn(db, rid, 'NA_STAN', { now: T0 })
    expect((await stockOf(db, x)).physical).toBe(9)
    expect((await stockOf(db, y)).physical).toBe(8)
    await expectInvariants(db)
  })

  it('anulowanie po wydaniu: flaga do korekty, przycisk „Przyjmij zwrot na stan” przywraca stan i zdejmuje flagę; drugi raz nic', async () => {
    const a = await product(db, 'A121-C', 5)
    const { id } = await wydane([{ productId: a, qty: 2 }], false)
    expect(await cancelOrder(db, id, { now: T0 })).toBe('ANULOWANE')
    let o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(flagsOf(o).doKorekty).toBe(true)
    expect((await stockOf(db, a)).physical).toBe(3)

    const przed = await przyciskiKarty(id)
    expect(przed.find((p) => p.akcja === 'zwrot_na_stan')).toMatchObject({ etykieta: 'Przyjmij zwrot na stan', powod: null })
    expect(await pozostaloDoZwrotu(db, id)).toEqual([expect.objectContaining({ productId: a, qty: 2 })])

    const rid = await przyjmijZwrotPoAnulowaniu(db, id, { now: T0, actorId: 'user:t' })
    expect(rid).toBeTruthy()
    o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(flagsOf(o).doKorekty).toBe(false)
    expect(await stockOf(db, a)).toMatchObject({ physical: 5, available: 5 })
    expect(await przyjmijZwrotPoAnulowaniu(db, id, { now: T0 })).toBeNull()
    expect((await stockOf(db, a)).physical).toBe(5)
    expect((await przyciskiKarty(id)).find((p) => p.akcja === 'zwrot_na_stan')).toBeUndefined()
    expect(await db.alert.count({ where: { kind: 'FAKTURA_DO_KOREKTY' } })).toBe(0)
    await expectInvariants(db)
  })

  it('zamówienie z wystawionym dokumentem sprzedaży: stan wraca, flaga do korekty zostaje z alertem „Faktura do korekty”', async () => {
    const a = await product(db, 'A121-D', 5)
    const { id } = await wydane([{ productId: a, qty: 1 }], false)
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', documentOnly: true, wfirmaDocId: 'D-1', number: 'FV 1/11/2026' } })
    await cancelOrder(db, id, { now: T0 })
    await przyjmijZwrotPoAnulowaniu(db, id, { now: T0 })
    expect((await stockOf(db, a)).physical).toBe(5)
    expect(flagsOf(await db.order.findUniqueOrThrow({ where: { id } })).doKorekty).toBe(true)
    expect((await db.alert.findFirstOrThrow({ where: { kind: 'FAKTURA_DO_KOREKTY' } })).message).toContain('FV 1/11/2026')
    await expectInvariants(db)
  })

  it('zwrot całości jednym krokiem tylko dla anulowanego', async () => {
    const a = await product(db, 'A121-E', 5)
    const { id } = await wydane([{ productId: a, qty: 1 }])
    await expect(przyjmijZwrotPoAnulowaniu(db, id, { now: T0 })).rejects.toThrow(ReturnError)
  })
})

describe('zmiana źródła stanu przy nierozliczonych zwrotach', () => {
  it('Kompletor → lustro wFirmy: zwrot bez faktury (zgłoszony) blokuje zmianę; po przyjęciu przechodzi', async () => {
    await db.warehouse.updateMany({ data: { wfirmaWarehouseId: '999001' } }) // magazyn wFirmy podłączony, stan dalej Kompletor
    const a = await product(db, 'A121-W2', 5)
    const { id, lines } = await wydane([{ productId: a, qty: 2 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { now: T0 })
    await expect(zmienZrodloStanu(db, 'WFIRMA', 'u1')).rejects.toThrow('W magazynie są nierozliczone zwroty (1). Zmiana źródła stanu dopiero po ich przyjęciu albo odrzuceniu')
    expect(await zrodloStanu(db)).toBe('KOMPLETOR')
    expect((await widokDokumentow(db)).zmianaZrodlaZablokowana).toContain('nierozliczone zwroty (1)')

    await receiveReturn(db, rid, 'NA_STAN', { now: T0 })
    expect((await db.return.findUniqueOrThrow({ where: { id: rid } })).status).toBe('ZAKONCZONY')
    expect((await widokDokumentow(db)).zmianaZrodlaZablokowana).toBeNull()
    await zmienZrodloStanu(db, 'WFIRMA', 'u1')
    expect(await zrodloStanu(db)).toBe('WFIRMA')
    await expectInvariants(db)
  })

  it('lustro wFirmy → Kompletor: zwrot w korekcie (KOREKTA) blokuje zmianę; po zakończeniu korekty przechodzi', async () => {
    await db.warehouse.updateMany({ data: { stockSource: 'WFIRMA', wfirmaWarehouseId: '999001' } })
    const { orderId } = await ingestOrder(db, order([{ productId: await product(db, 'A121-W2K', 3), qty: 1 }]), { now: T0 })
    const r = await db.return.create({ data: { orderId: orderId!, status: 'KOREKTA', invoiceDocId: 'FV-W2', correctionState: 'SENDING' } })
    await expect(zmienZrodloStanu(db, 'KOMPLETOR', 'u1')).rejects.toThrow('nierozliczone zwroty (1)')
    expect(await zrodloStanu(db)).toBe('WFIRMA')
    await db.return.update({ where: { id: r.id }, data: { status: 'ZAKONCZONY', correctionState: 'ISSUED' } })
    await zmienZrodloStanu(db, 'KOMPLETOR', 'u1')
    expect(await zrodloStanu(db)).toBe('KOMPLETOR')
  })
})
