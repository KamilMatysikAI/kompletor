// Powrót rezerwacji zamówień ze zwolnionym towarem po nieudanej płatności online (przed powrotem do starszej wersji
// Kompletora): na sucho nic nie zmienia, wykonanie rezerwuje od nowa to, co jest (reszta na listę braków), zdejmuje
// terminy zwolnienia, zamówień już zamkniętych nie rezerwuje, powtórka nic nie zmienia, inna firma bez zmian.
// Przez prawdziwą mapę adaptera Woo i odczyt kanału. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelOrder } from '@/lib/adaptery/kontrakt'
import { loadChannelAccounts, type ChannelAccountSettings } from '@/lib/adaptery/konta'
import { wooOrderFromApi } from '@/lib/adaptery/woo'
import { handleChannelOrder } from '@/lib/cien/odczyt-zamowien'
import { getPolicy, savePolicy, termsFor } from '@/lib/rdzen/polityka'
import { checkInvariants } from '@/lib/rdzen/niezmienniki'
import { przywrocRezerwacjeZwolnionych } from '@/lib/rdzen/powrot-rezerwacji'
import { runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { ORG_B, testDb, truncateAll } from './db'
import { expectInvariants, offer, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

let a: string
let acc: ChannelAccountSettings

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  a = await product(db, 'A', 5)
  await offer(db, 'WOO_SD', '77', a)
  acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
})

const iso19 = (d: Date) => d.toISOString().slice(0, 19)
const min = (n: number) => new Date(T0.getTime() + n * 60_000)

function woo(id: string, status: string, modified: Date, opts: { metoda?: string; qty?: number } = {}): ChannelOrder {
  const { metoda = 'payu', qty = 2 } = opts
  return wooOrderFromApi({
    id: Number(id),
    status,
    currency: 'PLN',
    date_created_gmt: iso19(T0),
    date_modified_gmt: iso19(modified),
    date_paid_gmt: null,
    total: (qty * 12.3).toFixed(2),
    payment_method: metoda,
    payment_method_title: metoda === 'bacs' ? 'Przelew tradycyjny' : 'Płatność online',
    shipping_lines: [{ method_title: 'Paczkomaty InPost' }],
    line_items: [{ id: 1, product_id: 77, variation_id: 0, quantity: qty, total: (qty * 10).toFixed(2), total_tax: (qty * 2.3).toFixed(2), meta_data: [] }],
  })
}

const zamowienie = (externalId: string, d = db) => d.order.findFirstOrThrow({ where: { channel: 'WOO', channelAccountId: 'sd', externalId } })
const aktywne = async (orderId: string) => (await db.reservation.aggregate({ where: { orderId, state: 'ACTIVE' }, _sum: { qtyBase: true } }))._sum.qtyBase ?? 0
const braki = async (orderId: string) => (await db.shortage.aggregate({ where: { orderId, state: 'OPEN' }, _sum: { qtyBase: true } }))._sum.qtyBase ?? 0

describe('powrót rezerwacji zwolnionych po nieudanej płatności online', () => {
  it('towar jest: pełna rezerwacja od nowa, zamówienie Nowe ze zwykłymi terminami, potem anulowane po terminie jak każde', async () => {
    await handleChannelOrder(db, acc, woo('11', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    const o = await zamowienie('11')
    expect((await stockOf(db, a)).reserved).toBe(0)

    const w = await przywrocRezerwacjeZwolnionych(db, { naSucho: false, now: min(200), actorId: 'test' })
    expect(w).toMatchObject({ naSucho: false, kandydaci: 1, przywrocone: ['11'], znacznikiZdjete: [], terminZdjety: [], zarezerwowane: 2, braki: 0, bledy: [] })
    const po = await zamowienie('11')
    expect(po).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleaseAt: null, stockReleasedAt: null, reservationDeadline: o.reservationDeadline })
    expect(await aktywne(o.id)).toBe(2)
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)

    const zwykle = termsFor(T0, await getPolicy(db))
    expect(await runReservationExpiry(db, { now: new Date(zwykle.reservationDeadline.getTime() + 60_000) })).toMatchObject({ released: 1 })
    expect(await zamowienie('11')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'EXPIRED_UNPAID' })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('część towaru zajęta, zamówienie zamknięte i towar jeszcze trzymany: na sucho bez zmian, wykonanie z brakami, powtórka bez zmian', async () => {
    // stan 5: X 2 + Y 4 + C 1 z nieudaną płatnością, wszystkie zwolnione po 2 h
    await handleChannelOrder(db, acc, woo('21', 'failed', min(5), { qty: 2 }), min(6))
    await handleChannelOrder(db, acc, woo('22', 'failed', min(5), { qty: 4 }), min(6))
    await handleChannelOrder(db, acc, woo('23', 'failed', min(5), { qty: 1 }), min(6))
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ stockReleased: 3 })
    // w międzyczasie przelew tradycyjny zajmuje 3 sztuki, a C zamknięto poza Kompletorem ze starym znacznikiem
    await handleChannelOrder(db, acc, woo('24', 'on-hold', min(130), { metoda: 'bacs', qty: 3 }), min(131))
    await db.order.updateMany({ where: { externalId: '23' }, data: { status: 'WYSLANE' } })
    // W: nieudana płatność, towar jeszcze trzymany (dłuższe ustawienie)
    await savePolicy(db, { failedOnlinePaymentHoldHours: 10 }, 'test')
    await handleChannelOrder(db, acc, woo('25', 'failed', min(140), { qty: 1 }), min(141))
    expect((await zamowienie('25')).stockReleaseAt).not.toBeNull()
    expect((await stockOf(db, a)).reserved).toBe(4)
    // zamknięte ze starym znacznikiem audyt zgłasza, dopóki znacznik nie zejdzie
    const c0 = await zamowienie('23')
    expect((await checkInvariants(db)).filter((v) => v.rule === '4e zwolnione')).toEqual([{ rule: '4e zwolnione', ref: c0.id, detail: 'status WYSLANE' }])

    const sucho = await przywrocRezerwacjeZwolnionych(db, { now: min(200) })
    expect(sucho).toMatchObject({ naSucho: true, kandydaci: 4, znacznikiZdjete: ['23'], terminZdjety: ['25'], zarezerwowane: 0, braki: 0, bledy: [] })
    expect([...sucho.przywrocone].sort()).toEqual(['21', '22'])
    expect((await stockOf(db, a)).reserved).toBe(4)
    expect(await db.order.count({ where: { stockReleasedAt: { not: null } } })).toBe(3)

    const w = await przywrocRezerwacjeZwolnionych(db, { naSucho: false, now: min(201), actorId: 'test' })
    expect(w).toMatchObject({ naSucho: false, kandydaci: 4, znacznikiZdjete: ['23'], terminZdjety: ['25'], zarezerwowane: 1, braki: 5, bledy: [] })
    expect([...w.przywrocone].sort()).toEqual(['21', '22'])
    expect(await db.order.count({ where: { OR: [{ stockReleasedAt: { not: null } }, { stockReleaseAt: { not: null } }] } })).toBe(0)
    const [x, y, c, ww] = [await zamowienie('21'), await zamowienie('22'), await zamowienie('23'), await zamowienie('25')]
    expect((await aktywne(x.id)) + (await braki(x.id))).toBe(2)
    expect((await aktywne(y.id)) + (await braki(y.id))).toBe(4)
    expect(await aktywne(c.id)).toBe(0)
    expect(c.status).toBe('WYSLANE')
    expect(await aktywne(ww.id)).toBe(1)
    expect((await stockOf(db, a)).reserved).toBe(5)
    expect(await db.orderEvent.count({ where: { kind: 'TOWAR_ZAREZERWOWANY_PONOWNIE', actorId: 'test' } })).toBe(2)
    await expectInvariants(db)

    const znowu = await przywrocRezerwacjeZwolnionych(db, { naSucho: false, now: min(202), actorId: 'test' })
    expect(znowu).toMatchObject({ kandydaci: 0, przywrocone: [], znacznikiZdjete: [], terminZdjety: [], zarezerwowane: 0, braki: 0, bledy: [] })
    expect((await stockOf(db, a)).reserved).toBe(5)
    await expectInvariants(db)
  })

  it('tylko zamówienia swojej firmy', async () => {
    await seedBase(dbB)
    const aB = await product(dbB, 'A', 5)
    await offer(dbB, 'WOO_SD', '77', aB)
    const accB = (await loadChannelAccounts(dbB)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    await handleChannelOrder(db, acc, woo('31', 'failed', min(5)), min(6))
    await handleChannelOrder(dbB, accB, woo('31', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    await runReservationExpiry(dbB, { now: min(121) })
    expect(await przywrocRezerwacjeZwolnionych(db, { naSucho: false, now: min(200) })).toMatchObject({ kandydaci: 1, przywrocone: ['31'] })
    expect(await zamowienie('31', dbB)).toMatchObject({ stockReleasedAt: min(121) })
    expect((await stockOf(dbB, aB)).reserved).toBe(0)
  })
})
