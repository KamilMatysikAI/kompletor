// T7 od wydruku karty („Do spec”). Konto w PRACY: wydruk DO_REALIZACJI → ZBIERANIE, skan statusu nie
// zmienia; edycja w kanale między wydrukiem a SPAKOWANE = różnica rezerwacji + „karta nieaktualna”; po spakowaniu
// „Do wyjaśnienia”. Konto w CIENIU: wydruk niczego nie zmienia w zamówieniu. Dane wyłącznie testowe.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cancelPicking, finishPicking } from '@/lib/rdzen/przejscia'
import { PackError, packOrder } from '@/lib/rdzen/rozchod'
import { cancelOrder, ingestOrder, resolveClarification, type IncomingOrder } from '@/lib/rdzen/zamowienia'
import { sprawdzSkan } from '@/lib/stanowisko/cwiczenie'
import { drukujKarty } from '@/lib/stanowisko/karty'
import { testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'
import { issueInvoice } from '@/lib/rdzen/rozchod'

const db = testDb()
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Magazyn Testowy' }
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)
const get = (id: string) => db.order.findUniqueOrThrow({ where: { id } })
const flagi = async (id: string) => (await get(id)).flags as Record<string, unknown>

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.channelConfig.updateMany({ where: { channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
})
afterAll(() => db.$disconnect())

let nr = 7000
async function zamowienie(lines: Parameters<typeof order>[0], over: Parameters<typeof order>[1] = {}): Promise<{ id: string; o: IncomingOrder }> {
  const o = order(lines, { externalId: String(++nr), ...over })
  const { orderId } = await ingestOrder(db, o, { now: T0 })
  return { id: orderId!, o }
}

describe('T7: zbieranie od wydruku karty', () => {
  it('PRACA: pierwszy wydruk DO_REALIZACJI → ZBIERANIE z numerem wydruku w historii; drugi wydruk nie zmienia statusu ani historii; skan nie zmienia statusu', async () => {
    const a = await product(db, 'A', 5)
    const { id } = await zamowienie([{ productId: a, qty: 1 }])
    expect((await get(id)).status).toBe('DO_REALIZACJI')
    const w1 = (await drukujKarty(db, [id], KTO, at(M))).wydruki[0]!
    expect(w1).toMatchObject({ printNo: 1, naSucho: false, zbieranie: true })
    expect((await get(id)).status).toBe('ZBIERANIE')
    const ev = await db.orderEvent.findMany({ where: { orderId: id, kind: 'ZBIERANIE' } })
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actorId: KTO.userId, data: { z: 'DO_REALIZACJI', na: 'ZBIERANIE', wydruk: 1 } })
    const w2 = (await drukujKarty(db, [id], KTO, at(2 * M))).wydruki[0]!
    expect(w2).toMatchObject({ printNo: 2, zbieranie: false })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'ZBIERANIE' } })).toBe(1)
    await sprawdzSkan(db, w2.kod)
    expect((await get(id)).status).toBe('ZBIERANIE')
    await expectInvariants(db)
  })

  it('CIEŃ: wydruk niczego nie zmienia: status, flagi i historia jak przed wydrukiem', async () => {
    const a = await product(db, 'A', 5)
    const { id } = await zamowienie([{ productId: a, qty: 1 }], { channel: 'ALLEGRO', externalId: '7999' })
    const przed = await get(id)
    const ev = await db.orderEvent.count({ where: { orderId: id } })
    const w = (await drukujKarty(db, [id], KTO, at(M))).wydruki[0]!
    expect(w).toMatchObject({ naSucho: true, zbieranie: false })
    expect(await get(id)).toEqual(przed)
    expect(await db.orderEvent.count({ where: { orderId: id } })).toBe(ev)
  })

  it('brak wszystkiego: bez pustej karty, zostaje w DO_REALIZACJI, sąsiednie zamówienie rusza', async () => {
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 0)
    const bezTowaru = (await zamowienie([{ productId: b, qty: 1 }])).id
    const zTowarem = (await zamowienie([{ productId: a, qty: 1 }])).id
    const { wydruki, pominiete } = await drukujKarty(db, [bezTowaru, zTowarem], KTO, at(M))
    expect(wydruki.map((w) => [w.orderId, w.zbieranie])).toEqual([[zTowarem, true]])
    expect(pominiete.map((p) => p.orderId)).toEqual([bezTowaru])
    expect((await get(bezTowaru)).status).toBe('DO_REALIZACJI')
    expect((await get(zTowarem)).status).toBe('ZBIERANIE')
  })

  it('odmowa T7 (anulowanie w toku) nie blokuje wydruku: karta wychodzi, status zostaje', async () => {
    const a = await product(db, 'A', 5)
    const { id } = await zamowienie([{ productId: a, qty: 1 }])
    await db.order.update({ where: { id }, data: { pendingAction: 'CANCEL_CANCELLED' } })
    expect((await drukujKarty(db, [id], KTO, at(M))).wydruki[0]).toMatchObject({ printNo: 1, zbieranie: false })
    expect((await get(id)).status).toBe('DO_REALIZACJI')
  })

  it('nieopłacone (NOWE) i „Do wyjaśnienia”: karta wychodzi, statusu nie rusza', async () => {
    const a = await product(db, 'A', 5)
    const nowe = (await zamowienie([{ productId: a, qty: 1 }], { paymentState: 'UNPAID', paymentMethod: 'przelew' })).id
    const wyj = (await zamowienie([{ productId: a, qty: 1 }], { deliveryMethod: 'Gołąb pocztowy' })).id
    expect((await get(nowe)).status).toBe('NOWE')
    expect((await get(wyj)).status).toBe('DO_WYJASNIENIA')
    const { wydruki } = await drukujKarty(db, [nowe, wyj], KTO, at(M))
    expect(wydruki.every((w) => !w.zbieranie)).toBe(true)
    expect((await get(nowe)).status).toBe('NOWE')
    expect((await get(wyj)).status).toBe('DO_WYJASNIENIA')
  })

  it('cofnięcie zbierania i ponowny wydruk: kolejne ZBIERANIE, numer wydruku dalej rośnie', async () => {
    const a = await product(db, 'A', 5)
    const { id } = await zamowienie([{ productId: a, qty: 1 }])
    await drukujKarty(db, [id], KTO, at(M))
    await cancelPicking(db, id, { now: at(2 * M) })
    expect((await drukujKarty(db, [id], KTO, at(3 * M))).wydruki[0]).toMatchObject({ printNo: 2, zbieranie: true })
    expect((await get(id)).status).toBe('ZBIERANIE')
  })

  it('dosyłka: odrębny kod <numer>-2/<wydruk> i własne T7', async () => {
    const a = await product(db, 'A', 5)
    const { id } = await zamowienie([{ productId: a, qty: 1 }], { externalId: '6001' })
    const g = await get(id)
    const dos = await db.order.create({
      data: { channel: g.channel, channelAccountId: g.channelAccountId, externalId: '6001/2', parentOrderId: id, packageNo: 2, status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: 0, createdAtChannel: T0, carrier: g.carrier },
    })
    const l = await db.orderLine.create({ data: { orderId: dos.id, externalLineId: 'L1', productId: a, qty: 1, unitPriceGross: 10 } })
    await db.reservation.create({ data: { orderId: dos.id, orderLineId: l.id, productId: a, warehouseId: 'glowny', qtyBase: 1, state: 'ACTIVE' } })
    const w = (await drukujKarty(db, [dos.id], KTO, at(M))).wydruki[0]!
    expect(w.kod).toMatch(/6001-2\/1$/)
    expect(w.zbieranie).toBe(true)
    expect((await get(id)).status).toBe('DO_REALIZACJI') // zamówienie główne bez zmian
  })
})

describe('3.7: edycja w kanale po wydruku karty', () => {
  it('ZBIERANIE: różnica rezerwacji + „karta nieaktualna”, bez „Do wyjaśnienia”; spakować dopiero po nowym wydruku, który zdejmuje flagę', async () => {
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 5)
    const { id, o } = await zamowienie([{ productId: a, qty: 2 }])
    const k1 = (await drukujKarty(db, [id], KTO, at(M))).wydruki[0]!
    await ingestOrder(db, { ...o, externalRevision: '2', lines: [{ ...o.lines[0]!, qty: 1 }, { externalLineId: 'L9', productId: b, qty: 1, unitPriceGross: 10 }] }, { now: at(2 * M) })
    expect((await get(id)).status).toBe('ZBIERANIE')
    expect(await flagi(id)).toMatchObject({ kartaNieaktualna: true })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 1 })
    expect(await stockOf(db, b)).toMatchObject({ reserved: 1 })
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'EDYCJA' } })).data).toMatchObject({ kartaNieaktualna: true })
    await expect(packOrder(db, id, { now: at(3 * M) })).rejects.toThrow(PackError)
    expect(await sprawdzSkan(db, k1.kod)).toMatchObject({ typ: 'blokada', blokada: { rodzaj: 'zmienione' } })
    const k2 = (await drukujKarty(db, [id], KTO, at(4 * M))).wydruki[0]!
    expect(k2).toMatchObject({ printNo: 2, zbieranie: false })
    expect((await flagi(id)).kartaNieaktualna).toBeUndefined()
    expect((await packOrder(db, id, { now: at(5 * M) })).status).toBe('SPAKOWANE')
    await expectInvariants(db)
  })

  it('ZEBRANE tak samo; zwiększenie ponad stan: brak w „brakuje”, status bez zmian', async () => {
    const a = await product(db, 'A', 2)
    const { id, o } = await zamowienie([{ productId: a, qty: 2 }])
    await drukujKarty(db, [id], KTO, at(M))
    await finishPicking(db, id, { now: at(2 * M) })
    const r = await ingestOrder(db, { ...o, externalRevision: '2', lines: [{ ...o.lines[0]!, qty: 3 }] }, { now: at(3 * M) })
    expect(r).toMatchObject({ shortUnits: 1, status: 'ZEBRANE' })
    expect(await flagi(id)).toMatchObject({ kartaNieaktualna: true, brakuje: true })
    await expectInvariants(db)
  })

  it('zmiana produktu w pozycji i po spakowaniu: dalej „Do wyjaśnienia” bez automatu', async () => {
    const a = await product(db, 'A', 5)
    const { id, o } = await zamowienie([{ productId: a, qty: 1 }])
    await drukujKarty(db, [id], KTO, at(M))
    await packOrder(db, id, { now: at(2 * M) })
    await ingestOrder(db, { ...o, externalRevision: '2', lines: [{ ...o.lines[0]!, qty: 2 }] }, { now: at(3 * M) })
    const g = await get(id)
    expect(g).toMatchObject({ status: 'DO_WYJASNIENIA', statusBeforeClarify: 'SPAKOWANE' })
    expect(((g.flags as { doWyjasnienia: string }).doWyjasnienia)).toMatch(/po spakowaniu/)
    expect(await stockOf(db, a)).toMatchObject({ reserved: 1 })
    await expectInvariants(db)
  })

  it('po fakturze (CONSUMING/CONSUMED) edycja nigdy nie liczy różnicy rezerwacji', async () => {
    const a = await product(db, 'A', 5)
    const { id, o } = await zamowienie([{ productId: a, qty: 1 }])
    await drukujKarty(db, [id], KTO, at(M))
    await packOrder(db, id, { now: at(2 * M) })
    await issueInvoice(db, id, new FakeWfirma(), { now: at(3 * M) })
    await ingestOrder(db, { ...o, externalRevision: '2', lines: [{ ...o.lines[0]!, qty: 2 }] }, { now: at(4 * M) })
    expect((await get(id)).status).toBe('DO_WYJASNIENIA')
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ qty: 1 })
    await expectInvariants(db)
  })

  it('cofnięcie zbierania zdejmuje flagę; edycja przed wydrukiem i w cieniu nie ustawia flagi', async () => {
    const a = await product(db, 'A', 5)
    const { id, o } = await zamowienie([{ productId: a, qty: 1 }])
    await ingestOrder(db, { ...o, externalRevision: '2', lines: [{ ...o.lines[0]!, qty: 2 }] }, { now: at(M) })
    expect((await flagi(id)).kartaNieaktualna).toBeUndefined()
    await drukujKarty(db, [id], KTO, at(2 * M))
    await ingestOrder(db, { ...o, externalRevision: '3', lines: [{ ...o.lines[0]!, qty: 3 }] }, { now: at(3 * M) })
    expect((await flagi(id)).kartaNieaktualna).toBe(true)
    await cancelPicking(db, id, { now: at(4 * M) })
    expect((await flagi(id)).kartaNieaktualna).toBeUndefined()
    expect((await packOrder(db, id, { now: at(5 * M) })).status).toBe('SPAKOWANE')

    const c = await zamowienie([{ productId: a, qty: 1 }], { channel: 'ALLEGRO', externalId: '7998' })
    await drukujKarty(db, [c.id], KTO, at(6 * M))
    await ingestOrder(db, { ...c.o, externalRevision: '2', lines: [{ ...c.o.lines[0]!, qty: 2 }] }, { now: at(7 * M) })
    expect(await get(c.id)).toMatchObject({ status: 'DO_REALIZACJI' })
    expect((await flagi(c.id)).kartaNieaktualna).toBeUndefined()
  })

  it('ZEBRANE, klient usuwa jedyny towar, zostaje e-book: „Do wyjaśnienia” bez flagi, po wyjaśnieniu da się spakować', async () => {
    const a = await product(db, 'A', 5)
    const p = await db.product.create({ data: { sku: 'EBOOK-T7', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book T7', title: 'E-book T7', vatRate: '5' } })
    const { id, o } = await zamowienie([{ productId: a, qty: 1 }, { productId: p.id, qty: 1 }])
    await drukujKarty(db, [id], KTO, at(M))
    await finishPicking(db, id, { now: at(2 * M) })
    const r = await ingestOrder(db, { ...o, externalRevision: '2', lines: [o.lines[1]!] }, { now: at(3 * M) })
    expect(r).toMatchObject({ status: 'DO_WYJASNIENIA' })
    expect(await get(id)).toMatchObject({ statusBeforeClarify: 'ZEBRANE' })
    expect((await flagi(id)).kartaNieaktualna).toBeUndefined()
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0 })
    expect(await resolveClarification(db, id, { now: at(4 * M) })).toBe('ZEBRANE')
    expect(await packOrder(db, id, { now: at(5 * M) })).toMatchObject({ status: 'SPAKOWANE' })
    await expectInvariants(db)
  })

  it('wszystkie pozycje usunięte po wcześniejszej edycji: flaga zdjęta, zamówienie u obsługi, da się anulować', async () => {
    const a = await product(db, 'A', 5)
    const { id, o } = await zamowienie([{ productId: a, qty: 1 }])
    await drukujKarty(db, [id], KTO, at(M))
    await ingestOrder(db, { ...o, externalRevision: '2', lines: [{ ...o.lines[0]!, qty: 2 }] }, { now: at(2 * M) })
    expect((await flagi(id)).kartaNieaktualna).toBe(true)
    const r = await ingestOrder(db, { ...o, externalRevision: '3', lines: [] }, { now: at(3 * M) })
    expect(r).toMatchObject({ status: 'DO_WYJASNIENIA' })
    expect((await flagi(id)).kartaNieaktualna).toBeUndefined()
    await cancelOrder(db, id, { now: at(4 * M) })
    expect((await get(id)).status).toBe('ANULOWANE')
    await expectInvariants(db)
  })

  it('towar zamieniony na nowy bez stanu: bez rezerwacji też do obsługi, a nie ZEBRANE z flagą', async () => {
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 0)
    const { id, o } = await zamowienie([{ productId: a, qty: 1 }])
    await drukujKarty(db, [id], KTO, at(M))
    await finishPicking(db, id, { now: at(2 * M) })
    const r = await ingestOrder(db, { ...o, externalRevision: '2', lines: [{ externalLineId: 'L2', unitPriceGross: 10, productId: b, qty: 1 }] }, { now: at(3 * M) })
    expect(r).toMatchObject({ status: 'DO_WYJASNIENIA', shortUnits: 1 })
    await expectInvariants(db)
  })

  it('anulowanie w trakcie zbierania po edycji: rezerwacje zwolnione, inwarianty całe', async () => {
    const a = await product(db, 'A', 5)
    const { id, o } = await zamowienie([{ productId: a, qty: 1 }])
    await drukujKarty(db, [id], KTO, at(M))
    await ingestOrder(db, { ...o, externalRevision: '2', lines: [{ ...o.lines[0]!, qty: 2 }] }, { now: at(2 * M) })
    await cancelOrder(db, id, { now: at(3 * M) })
    expect((await get(id)).status).toBe('ANULOWANE')
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0 })
    await expectInvariants(db)
  })
})
