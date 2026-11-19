// Nieudana płatność online (bramka odrzuciła BLIK albo kartę, Woo `failed`): towar trzymany tylko przez krótki czas
// z zasad rezerwacji firmy (godziny zegarowe od złożenia, domyślnie 2), potem wraca do sprzedaży, a zamówienie zostaje
// „Nowe, nieopłacone” i czeka na płatność do zwykłego terminu (wtedy anulowanie jak każde nieopłacone). Po wpłacie albo
// po zmianie na przelew tradycyjny rezerwacja wraca na to, co jest. Przelew tradycyjny, pobranie i inne kanały: bez
// zmian. Przez prawdziwą mapę adaptera (`wooOrderFromApi`) i odczyt kanału (`handleChannelOrder`). Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelOrder } from '@/lib/adaptery/kontrakt'
import { loadChannelAccounts, type ChannelAccountSettings } from '@/lib/adaptery/konta'
import { wooOrderFromApi } from '@/lib/adaptery/woo'
import { WOO_ZAPIS_KEY } from '@/lib/adaptery/woo-zapis'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { handleChannelOrder } from '@/lib/cien/odczyt-zamowien'
import { zaplanujZapisy } from '@/lib/kanaly/zapis-host'
import { punktCiecia } from '@/lib/kanaly/punkt-ciecia'
import { INVOICES_JOB } from '@/lib/cien/faktury-bl'
import { zapiszUdanyPrzebieg } from '@/lib/cien/przebiegi'
import { changeLineQty, KOMUNIKAT_TOWAR_ZWOLNIONY, splitOrder } from '@/lib/rdzen/edycja'
import { getPolicy, savePolicy, termsFor } from '@/lib/rdzen/polityka'
import { checkInvariants } from '@/lib/rdzen/niezmienniki'
import { cancelOrder, ingestOrder, markPaid, przepnijPozycjeOferty, remapOrder, resolveClarification, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { ORG_B, testDb, truncateAll } from './db'
import { bundle, expectInvariants, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

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
/** T0 = czwartek 10:00 w Warszawie: pytanie o płatność po nieudanej płatności online w piątek o 9:00 (czas letni). */
const NASTEPNY_DZIEN_9 = '2026-10-16T07:00:00.000Z'
const min = (n: number) => new Date(T0.getTime() + n * 60_000)

/** Zamówienie WC REST v3 (fikcyjne, bez danych odbiorcy); `metoda` = identyfikator metody płatności Woo. */
function woo(id: string, status: string, modified: Date, opts: { metoda?: string; qty?: number; paid?: Date; extraLine?: string } = {}): ChannelOrder {
  const { metoda = 'payu', qty = 2, paid } = opts
  const line = (n: number, productId: number) => ({ id: n, product_id: productId, variation_id: 0, quantity: qty, total: (qty * 10).toFixed(2), total_tax: (qty * 2.3).toFixed(2), meta_data: [] })
  return wooOrderFromApi({
    id: Number(id),
    status,
    currency: 'PLN',
    date_created_gmt: iso19(T0),
    date_modified_gmt: iso19(modified),
    date_paid_gmt: paid ? iso19(paid) : null,
    total: (qty * 12.3).toFixed(2),
    payment_method: metoda,
    payment_method_title: metoda === 'bacs' ? 'Przelew tradycyjny' : 'Płatność online',
    shipping_lines: [{ method_title: 'Paczkomaty InPost' }],
    line_items: [line(1, 77), ...(opts.extraLine ? [line(2, Number(opts.extraLine))] : [])],
  })
}

const zamowienie = (externalId: string, d = db) => d.order.findFirstOrThrow({ where: { channel: 'WOO', channelAccountId: 'sd', externalId } })
const flags = (o: { flags: unknown }) => o.flags as Record<string, unknown>

describe('mapa adaptera Woo: nieudana płatność online po identyfikatorze metody', () => {
  it('failed przy bramce online = nieudana online; failed przy bacs/cheque/cod nie; pusta metoda = online; inne statusy nie', () => {
    expect(woo('1', 'failed', min(1))).toMatchObject({ paymentFailedOnline: true, paymentOffline: false })
    for (const m of ['bacs', 'cheque', 'cod']) expect(woo('1', 'failed', min(1), { metoda: m })).toMatchObject({ paymentFailedOnline: false, paymentOffline: true })
    expect(woo('1', 'failed', min(1), { metoda: '' })).toMatchObject({ paymentFailedOnline: true, paymentOffline: false })
    expect(woo('1', 'pending', min(1))).toMatchObject({ paymentFailedOnline: false, paymentOffline: false })
    expect(woo('1', 'on-hold', min(1), { metoda: 'bacs' })).toMatchObject({ paymentFailedOnline: false, paymentOffline: true })
  })
})

describe('zwolnienie towaru po nieudanej płatności online', () => {
  it('po 2 h z zasad firmy sam towar wraca: zamówienie Nowe, nieopłacone, zwykły termin anulowania, pytanie o płatność następnego dnia o 9:00; drugi przebieg nic nie robi', async () => {
    expect(await handleChannelOrder(db, acc, woo('101', 'failed', min(5)), min(6))).toBe('NOWE')
    const o = await zamowienie('101')
    const zwykle = termsFor(T0, await getPolicy(db))
    expect((await getPolicy(db)).failedOnlinePaymentHoldHours).toBe(2)
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleasedAt: null })
    expect(o.stockReleaseAt!.toISOString()).toBe(min(120).toISOString())
    expect(o.reservationDeadline!.toISOString()).toBe(zwykle.reservationDeadline.toISOString())
    expect(o.remindAt!.toISOString()).toBe(NASTEPNY_DZIEN_9)
    expect(flags(o).nieudanaPlatnoscOnline).toBe(true)
    expect((await stockOf(db, a)).reserved).toBe(2)

    expect(await runReservationExpiry(db, { now: min(119) })).toMatchObject({ released: 0, stockReleased: 0, reminders: 0 })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ released: 0, stockReleased: 1 })
    const po = await zamowienie('101')
    expect(po).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', cancelReason: null, stockReleaseAt: null, stockReleasedAt: min(121) })
    expect(po.reservationDeadline!.toISOString()).toBe(zwykle.reservationDeadline.toISOString())
    expect(po.remindAt!.toISOString()).toBe(NASTEPNY_DZIEN_9)
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await db.reservation.count({ where: { orderId: o.id, state: 'RELEASED', releasedReason: 'FAILED_ONLINE_PAYMENT' } })).toBe(1)
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, kind: 'TOWAR_ZWOLNIONY' } })
    expect(ev).toMatchObject({ actorId: 'system:reservation-expiry', data: { released: 2, godzin: 2 } })
    expect(await db.orderEvent.count({ where: { orderId: o.id, kind: 'ANULOWANE' } })).toBe(0)
    // wypchnięcie stanu do kanału jak przy każdym zwolnieniu
    expect(await db.outboxEvent.count({ where: { kind: 'FORCE_PUSH', productId: a } })).toBeGreaterThan(0)

    expect(await runReservationExpiry(db, { now: min(180) })).toMatchObject({ released: 0, stockReleased: 0 })
    expect(await db.orderEvent.count({ where: { orderId: o.id, kind: 'TOWAR_ZWOLNIONY' } })).toBe(1)
    await expectInvariants(db)
  })

  it('po zwykłym terminie zamówienie bez rezerwacji jest anulowane dotychczasową drogą (nieopłacone po terminie)', async () => {
    await handleChannelOrder(db, acc, woo('110', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    const o = await zamowienie('110')
    const poTerminie = new Date(o.reservationDeadline!.getTime() + 60_000)
    expect(await runReservationExpiry(db, { now: poTerminie })).toMatchObject({ released: 1, stockReleased: 0 })
    expect(await zamowienie('110')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'EXPIRED_UNPAID', reservationDeadline: null, stockReleasedAt: null })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('pending → failed: termin zwolnienia od złożenia (zdarzenie w historii), termin anulowania bez zmian, pytanie o płatność następnego dnia; ponowna próba tej samej bramki (pending) go zostawia', async () => {
    await handleChannelOrder(db, acc, woo('102', 'pending', min(1)), min(2))
    const przed = await zamowienie('102')
    expect(przed.stockReleaseAt).toBeNull()

    await handleChannelOrder(db, acc, woo('102', 'failed', min(30)), min(31))
    const po = await zamowienie('102')
    expect(po).toMatchObject({ status: 'NOWE', reservationDeadline: przed.reservationDeadline })
    expect(po.remindAt!.toISOString()).toBe(NASTEPNY_DZIEN_9)
    expect(po.stockReleaseAt!.toISOString()).toBe(min(120).toISOString())
    expect(await db.orderEvent.count({ where: { orderId: po.id, kind: 'NIEUDANA_PLATNOSC_ONLINE' } })).toBe(1)

    await handleChannelOrder(db, acc, woo('102', 'pending', min(60)), min(61))
    expect((await zamowienie('102')).stockReleaseAt!.toISOString()).toBe(min(120).toISOString())
    expect(await db.orderEvent.count({ where: { orderId: po.id, kind: 'NIEUDANA_PLATNOSC_ONLINE' } })).toBe(1)
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('pending przez 3 h, potem failed: termin od złożenia już minął, towar zwolniony od razu przy odczycie', async () => {
    await handleChannelOrder(db, acc, woo('111', 'pending', min(1)), min(2))
    await handleChannelOrder(db, acc, woo('111', 'failed', min(180)), min(181))
    expect(await zamowienie('111')).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleaseAt: null, stockReleasedAt: min(181) })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('failed → przelew tradycyjny przed zwolnieniem (on-hold, bacs): bez terminu zwolnienia, towar czeka do zwykłego terminu', async () => {
    await handleChannelOrder(db, acc, woo('103', 'failed', min(5)), min(6))
    await handleChannelOrder(db, acc, woo('103', 'on-hold', min(50), { metoda: 'bacs' }), min(51))
    const o = await zamowienie('103')
    const zwykle = termsFor(T0, await getPolicy(db))
    expect(o).toMatchObject({ stockReleaseAt: null, stockReleasedAt: null })
    expect(o.reservationDeadline!.toISOString()).toBe(zwykle.reservationDeadline.toISOString())
    expect(flags(o).nieudanaPlatnoscOnline).toBeUndefined()
    expect(await db.orderEvent.count({ where: { orderId: o.id, kind: 'PLATNOSC_OFFLINE' } })).toBe(1)
    expect(await runReservationExpiry(db, { now: min(180) })).toMatchObject({ released: 0, stockReleased: 0 })
    expect((await stockOf(db, a)).reserved).toBe(2)
  })

  it('przelew tradycyjny (failed przy bacs, on-hold), zwykłe nieopłacone online (pending) i pobranie: bez terminu zwolnienia', async () => {
    const b = await product(db, 'B', 5)
    await offer(db, 'WOO_SD', '88', b)
    const zB = (o: ChannelOrder): ChannelOrder => ({ ...o, lines: o.lines.map((l) => ({ ...l, offerExternalId: '88' })) })
    await handleChannelOrder(db, acc, woo('104', 'failed', min(5), { metoda: 'bacs' }), min(6))
    await handleChannelOrder(db, acc, woo('105', 'on-hold', min(5), { metoda: 'bacs' }), min(6))
    await handleChannelOrder(db, acc, zB(woo('106', 'pending', min(5))), min(6))
    await handleChannelOrder(db, acc, zB(woo('112', 'processing', min(5), { metoda: 'cod' })), min(6))
    const zwykle = termsFor(T0, await getPolicy(db))
    for (const id of ['104', '105', '106']) {
      const o = await zamowienie(id)
      expect(o.reservationDeadline!.toISOString()).toBe(zwykle.reservationDeadline.toISOString())
      expect(o.remindAt!.toISOString()).toBe(zwykle.remindAt.toISOString())
      expect(o.stockReleaseAt).toBeNull()
      expect(flags(o).nieudanaPlatnoscOnline).toBeUndefined()
    }
    expect(await zamowienie('112')).toMatchObject({ paymentState: 'COD', stockReleaseAt: null, reservationDeadline: null })
    expect(await runReservationExpiry(db, { now: min(24 * 60) })).toMatchObject({ released: 0, stockReleased: 0 })
    expect((await stockOf(db, a)).reserved).toBe(4)
    expect((await stockOf(db, b)).reserved).toBe(4)
  })

  it('inny kanał (Allegro) nieopłacony: bez znacznika i bez terminu zwolnienia, zwykłe terminy', async () => {
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }], { channel: 'ALLEGRO', paymentState: 'UNPAID', paymentMethod: 'online' }), { now: min(1) })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o).toMatchObject({ status: 'NOWE', stockReleaseAt: null, stockReleasedAt: null })
    expect(flags(o).nieudanaPlatnoscOnline).toBeUndefined()
    expect(o.reservationDeadline!.toISOString()).toBe(termsFor(T0, await getPolicy(db)).reservationDeadline.toISOString())
    expect(await runReservationExpiry(db, { now: min(24 * 60) })).toMatchObject({ released: 0, stockReleased: 0 })
    expect((await stockOf(db, a)).reserved).toBe(2)
  })

  it('anulowane w sklepie, potem otwarte z nieudaną płatnością online: rezerwacja od nowa, termin zwolnienia od chwili przywrócenia', async () => {
    await handleChannelOrder(db, acc, woo('109', 'pending', min(1)), min(2))
    await handleChannelOrder(db, acc, woo('109', 'cancelled', min(10)), min(11))
    expect((await stockOf(db, a)).reserved).toBe(0)
    await handleChannelOrder(db, acc, woo('109', 'failed', min(30)), min(31))
    const o = await zamowienie('109')
    expect(o).toMatchObject({ status: 'NOWE', stockReleasedAt: null })
    expect(o.stockReleaseAt!.toISOString()).toBe(min(151).toISOString())
    expect(o.reservationDeadline!.toISOString()).toBe(termsFor(min(31), await getPolicy(db)).reservationDeadline.toISOString())
    expect(flags(o).nieudanaPlatnoscOnline).toBe(true)
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect(await runReservationExpiry(db, { now: min(152) })).toMatchObject({ released: 0, stockReleased: 1 })
    expect(await zamowienie('109')).toMatchObject({ status: 'NOWE' })
    await expectInvariants(db)
  })

  it('ustawienie 0: towar zwolniony od razu przy przyjęciu, zamówienie Nowe i nieopłacone', async () => {
    await savePolicy(db, { failedOnlinePaymentHoldHours: 0 }, 'test')
    await handleChannelOrder(db, acc, woo('107', 'failed', min(5)), min(6))
    const o = await zamowienie('107')
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleaseAt: null, stockReleasedAt: min(6) })
    expect((await stockOf(db, a)).reserved).toBe(0)
    // zdarzenie przyjęcia pokazuje stan po zwolnieniu
    expect(await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, kind: 'PRZYJETE' } })).toMatchObject({ data: { reserved: 0, short: 0, towarZwolniony: true } })
    expect(await runReservationExpiry(db, { now: min(7) })).toMatchObject({ released: 0, stockReleased: 0 })
    await expectInvariants(db)
  })

  it('zakres ustawienia 0–72 godzin, liczby całkowite; zmiana trafia do historii', async () => {
    await expect(savePolicy(db, { failedOnlinePaymentHoldHours: 73 }, 'test')).rejects.toThrow(/0–72 godzin/)
    await expect(savePolicy(db, { failedOnlinePaymentHoldHours: -1 }, 'test')).rejects.toThrow(/failedOnlinePaymentHoldHours/)
    await expect(savePolicy(db, { failedOnlinePaymentHoldHours: 1.5 }, 'test')).rejects.toThrow(/failedOnlinePaymentHoldHours/)
    await savePolicy(db, { failedOnlinePaymentHoldHours: 72 }, 'test')
    expect((await getPolicy(db)).failedOnlinePaymentHoldHours).toBe(72)
    const log = await db.auditLog.findFirstOrThrow({ where: { entity: 'ReservationPolicy' }, orderBy: { createdAt: 'desc' } })
    expect(log.after).toMatchObject({ failedOnlinePaymentHoldHours: 72 })
    await handleChannelOrder(db, acc, woo('108', 'failed', min(5)), min(6))
    expect((await zamowienie('108')).stockReleaseAt!.toISOString()).toBe(min(72 * 60).toISOString())
  })

  it('tryb dużego ruchu z chwili przyjęcia: zwykły termin wg trybu przyjęcia, także po zmianie trybu i przejściu na przelew', async () => {
    await savePolicy(db, { seasonMode: true }, 'test')
    const sezon = termsFor(T0, await getPolicy(db))
    await handleChannelOrder(db, acc, woo('113', 'failed', min(5)), min(6))
    await savePolicy(db, { seasonMode: false }, 'test')
    await handleChannelOrder(db, acc, woo('113', 'on-hold', min(50), { metoda: 'bacs' }), min(51))
    const o = await zamowienie('113')
    expect(o).toMatchObject({ termsSeasonMode: true, stockReleaseAt: null })
    expect(o.reservationDeadline!.toISOString()).toBe(sezon.reservationDeadline.toISOString())
  })

  it('„Do wyjaśnienia” (niezmapowana oferta), pending → failed: termin zwolnienia ustawiony, bez zwolnienia do wyjaśnienia, potem zwolnienie', async () => {
    await handleChannelOrder(db, acc, woo('114', 'pending', min(1), { extraLine: '999' }), min(2))
    expect(await zamowienie('114')).toMatchObject({ status: 'DO_WYJASNIENIA' })
    await handleChannelOrder(db, acc, woo('114', 'failed', min(30), { extraLine: '999' }), min(31))
    const o = await zamowienie('114')
    expect(o.stockReleaseAt!.toISOString()).toBe(min(120).toISOString())
    expect(await runReservationExpiry(db, { now: min(200) })).toMatchObject({ stockReleased: 0 })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect(await resolveClarification(db, o.id, { now: min(210) })).toBe('NOWE')
    expect(await runReservationExpiry(db, { now: min(211) })).toMatchObject({ stockReleased: 1 })
    expect(await zamowienie('114')).toMatchObject({ status: 'NOWE', stockReleasedAt: min(211) })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })
})

describe('powrót rezerwacji po zwolnieniu towaru', () => {
  it('wpłata w sklepie po zwolnieniu, część towaru zajęta: Do realizacji, rezerwacja z tego, co jest, reszta na liście braków', async () => {
    await handleChannelOrder(db, acc, woo('201', 'failed', min(5), { qty: 4 }), min(6))
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ stockReleased: 1 })
    // w międzyczasie przelew tradycyjny zajmuje 3 z 5 sztuk
    await handleChannelOrder(db, acc, woo('202', 'on-hold', min(130), { metoda: 'bacs', qty: 3 }), min(131))
    expect((await stockOf(db, a)).reserved).toBe(3)
    const wplata = min(180)
    await handleChannelOrder(db, acc, woo('201', 'processing', wplata, { qty: 4, paid: wplata }), min(181))
    const o = await zamowienie('201')
    expect(o).toMatchObject({ paymentState: 'PAID', cancelReason: null, reservationDeadline: null, stockReleasedAt: null, stockReleaseAt: null, status: 'DO_REALIZACJI' })
    expect(flags(o)).toMatchObject({ brakuje: true })
    expect(flags(o).nieudanaPlatnoscOnline).toBeUndefined()
    expect((await stockOf(db, a)).reserved).toBe(5)
    const braki = await db.shortage.findMany({ where: { orderId: o.id, state: 'OPEN' } })
    expect(braki.reduce((n, x) => n + x.qtyBase, 0)).toBe(2)
    expect(await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, kind: 'TOWAR_ZAREZERWOWANY_PONOWNIE' } })).toMatchObject({ data: { reserved: 2, short: 2 } })
    await expectInvariants(db)
  })

  it('wpłata po zwolnieniu z panelu (markPaid), towar jest: Do realizacji z pełną rezerwacją', async () => {
    await handleChannelOrder(db, acc, woo('203', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    const o = await zamowienie('203')
    expect(await markPaid(db, o.id, 'PAID', { now: min(200), actorId: 'panel:obsluga' })).toBe('DO_REALIZACJI')
    expect(await zamowienie('203')).toMatchObject({ stockReleasedAt: null })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('wpłata przed terminem zwolnienia: znacznik zdjęty, terminy wyczyszczone, bez zdarzeń zwolnienia', async () => {
    await handleChannelOrder(db, acc, woo('204', 'failed', min(5)), min(6))
    await handleChannelOrder(db, acc, woo('204', 'processing', min(30), { paid: min(29) }), min(31))
    const o = await zamowienie('204')
    expect(o).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID', reservationDeadline: null, stockReleaseAt: null, stockReleasedAt: null })
    expect(flags(o).nieudanaPlatnoscOnline).toBeUndefined()
    expect(await db.orderEvent.count({ where: { orderId: o.id, kind: { in: ['TOWAR_ZWOLNIONY', 'PLATNOSC_OFFLINE', 'TOWAR_ZAREZERWOWANY_PONOWNIE'] } } })).toBe(0)
    expect(await runReservationExpiry(db, { now: min(200) })).toMatchObject({ stockReleased: 0 })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('klient wybiera przelew tradycyjny po zwolnieniu: rezerwacja wraca na to, co jest, Nowe do zwykłego terminu', async () => {
    await handleChannelOrder(db, acc, woo('205', 'failed', min(5), { qty: 4 }), min(6))
    await runReservationExpiry(db, { now: min(121) })
    await handleChannelOrder(db, acc, woo('206', 'on-hold', min(130), { metoda: 'bacs', qty: 3 }), min(131))
    await handleChannelOrder(db, acc, woo('205', 'on-hold', min(200), { metoda: 'bacs', qty: 4 }), min(201))
    const o = await zamowienie('205')
    const zwykle = termsFor(T0, await getPolicy(db))
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleasedAt: null, stockReleaseAt: null })
    expect(o.reservationDeadline!.toISOString()).toBe(zwykle.reservationDeadline.toISOString())
    expect(flags(o)).toMatchObject({ brakuje: true })
    expect((await stockOf(db, a)).reserved).toBe(5)
    expect(await db.orderEvent.count({ where: { orderId: o.id, kind: 'TOWAR_ZAREZERWOWANY_PONOWNIE' } })).toBe(1)
    await expectInvariants(db)
  })

  it('kolejna nieudana próba online po zwolnieniu: bez ponownej rezerwacji i bez przesuwania terminów', async () => {
    await handleChannelOrder(db, acc, woo('207', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    const przed = await zamowienie('207')
    await handleChannelOrder(db, acc, woo('207', 'pending', min(300)), min(301))
    await handleChannelOrder(db, acc, woo('207', 'failed', min(310)), min(311))
    const po = await zamowienie('207')
    expect(po).toMatchObject({ status: 'NOWE', stockReleaseAt: null, stockReleasedAt: przed.stockReleasedAt, reservationDeadline: przed.reservationDeadline, remindAt: przed.remindAt })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('zmiana pozycji w sklepie po zwolnieniu: pozycje jak w kanale bez rezerwacji; wpłata rezerwuje nową ilość', async () => {
    await handleChannelOrder(db, acc, woo('208', 'failed', min(5), { qty: 2 }), min(6))
    await runReservationExpiry(db, { now: min(121) })
    await handleChannelOrder(db, acc, woo('208', 'failed', min(150), { qty: 3 }), min(151))
    const o = await zamowienie('208')
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).qty).toBe(3)
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
    await handleChannelOrder(db, acc, woo('208', 'failed', min(160), { qty: 1 }), min(161))
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).qty).toBe(1)
    await handleChannelOrder(db, acc, woo('208', 'processing', min(200), { qty: 1, paid: min(199) }), min(201))
    expect((await stockOf(db, a)).reserved).toBe(1)
    await expectInvariants(db)
  })

  it('zmiana pozycji i podział z karty po zwolnieniu: odmowa z powodem po polsku', async () => {
    await handleChannelOrder(db, acc, woo('209', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    const o = await zamowienie('209')
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    await expect(changeLineQty(db, o.id, line.id, 1, { now: min(130) })).rejects.toThrow(KOMUNIKAT_TOWAR_ZWOLNIONY)
    await expect(splitOrder(db, o.id, { [line.id]: 1 }, { now: min(130) })).rejects.toThrow(KOMUNIKAT_TOWAR_ZWOLNIONY)
  })

  it('oferta zmapowana po zwolnieniu: pozycja dostaje produkt bez rezerwacji i bez braku; wpłata rezerwuje całość', async () => {
    const b = await product(db, 'B', 5)
    await handleChannelOrder(db, acc, woo('210', 'pending', min(1), { extraLine: '999' }), min(2))
    await handleChannelOrder(db, acc, woo('210', 'failed', min(30), { extraLine: '999' }), min(31))
    const o = await zamowienie('210')
    await resolveClarification(db, o.id, { now: min(100) })
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ stockReleased: 1 })
    await offer(db, 'WOO_SD', '999', b)
    expect(await remapOrder(db, o.id, { now: min(130) })).toEqual({ mapped: 1, stillUnmapped: 0 })
    const po = await zamowienie('210')
    expect(po).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleasedAt: min(121) })
    expect(flags(po).brakuje).toBeFalsy()
    expect(await db.orderLine.count({ where: { orderId: o.id, productId: b } })).toBe(1)
    expect(await db.reservation.count({ where: { orderId: o.id, state: 'ACTIVE' } })).toBe(0)
    expect(await db.shortage.count({ where: { orderId: o.id, state: 'OPEN' } })).toBe(0)
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect((await stockOf(db, b)).reserved).toBe(0)
    await expectInvariants(db)
    await markPaid(db, o.id, 'PAID', { now: min(200), actorId: 'panel:obsluga' })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect((await stockOf(db, b)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('oferta przepięta na inny produkt i zmiana przelicznika po zwolnieniu: same pozycje, bez rezerwacji; wpłata rezerwuje nowe', async () => {
    const b = await product(db, 'B', 10)
    await handleChannelOrder(db, acc, woo('211', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    const o = await zamowienie('211')
    await db.channelOffer.updateMany({ where: { channelAccountId: 'sd', externalId: '77' }, data: { productId: b } })
    expect(await przepnijPozycjeOferty(db, o.id, { offerId: '77', fromProductId: a, fromQtyBasePerOffer: 1, actorId: 'panel:obsluga' }, { now: min(130) })).toEqual({ przepiete: 1, pominiete: [] })
    let line = await db.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    expect(line).toMatchObject({ productId: b, qty: 2 })
    expect(await db.reservation.count({ where: { orderId: o.id, state: 'ACTIVE' } })).toBe(0)
    expect(await db.shortage.count({ where: { orderId: o.id, state: 'OPEN' } })).toBe(0)
    expect(await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, kind: 'PRZEPIECIE_OFERTY' } })).toMatchObject({ data: { bezRezerwacji: true } })
    await expectInvariants(db)
    // ten sam produkt, przelicznik 1 → 3: ilość przeliczona, dalej bez rezerwacji
    await db.channelOffer.updateMany({ where: { channelAccountId: 'sd', externalId: '77' }, data: { qtyBasePerOffer: 3 } })
    expect(await przepnijPozycjeOferty(db, o.id, { offerId: '77', fromProductId: b, fromQtyBasePerOffer: 1, actorId: 'panel:obsluga' }, { now: min(140) })).toEqual({ przepiete: 1, pominiete: [] })
    line = await db.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    expect(line).toMatchObject({ productId: b, qty: 6 })
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect((await stockOf(db, b)).reserved).toBe(0)
    expect(await zamowienie('211')).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleasedAt: min(121) })
    await expectInvariants(db)
    await markPaid(db, o.id, 'PAID', { now: min(200), actorId: 'panel:obsluga' })
    expect((await stockOf(db, b)).reserved).toBe(6)
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })
})

describe('tryb konta i firmy', () => {
  it('konto w „Tylko podgląd” z zapisem statusów: zwolnienie towaru nie planuje zapisu do sklepu', async () => {
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: WOO_ZAPIS_KEY } })
    acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    await handleChannelOrder(db, acc, woo('301', 'failed', min(5)), min(6))
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ stockReleased: 1 })
    const id = (await zamowienie('301')).id
    const teraz = new Date(Date.now()) // okno planowania liczy się od updatedAt (zegar bazy)
    await zaplanujZapisy(db, defaultRegistry(), { now: teraz })
    expect(await db.channelWrite.count({ where: { orderId: id, kind: 'STATUS' } })).toBe(0)
  })

  it('ustawienie per firma: zmiana w jednej firmie nie zmienia drugiej, zamówienia liczą się wg swojej firmy', async () => {
    await seedBase(dbB)
    const aB = await product(dbB, 'A', 5)
    await offer(dbB, 'WOO_SD', '77', aB)
    const accB = (await loadChannelAccounts(dbB)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    await savePolicy(dbB, { failedOnlinePaymentHoldHours: 10 }, 'test')
    expect((await getPolicy(db)).failedOnlinePaymentHoldHours).toBe(2)
    expect((await getPolicy(dbB)).failedOnlinePaymentHoldHours).toBe(10)
    await handleChannelOrder(db, acc, woo('401', 'failed', min(5)), min(6))
    await handleChannelOrder(dbB, accB, woo('401', 'failed', min(5)), min(6))
    expect((await zamowienie('401')).stockReleaseAt!.toISOString()).toBe(min(120).toISOString())
    expect((await zamowienie('401', dbB)).stockReleaseAt!.toISOString()).toBe(min(600).toISOString())
    // wygasanie w firmie A nie dotyka zamówień firmy B
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ stockReleased: 1 })
    expect(await zamowienie('401', dbB)).toMatchObject({ status: 'NOWE', stockReleasedAt: null })
    expect((await stockOf(dbB, aB)).reserved).toBe(2)
    expect(await runReservationExpiry(dbB, { now: min(601) })).toMatchObject({ stockReleased: 1 })
    expect(await zamowienie('401', dbB)).toMatchObject({ status: 'NOWE', stockReleasedAt: min(601) })
  })
})

describe('zwolnione zamówienie zamknięte przy przejściu z BaseLinkera', () => {
  let blSeq = 7000
  /** Kopia zamówienia BL w statusie „Wysłane” i świeży przebieg odczytu BL (jak zostawia je worker cienia). */
  async function wyslaneWBl(orderId: string, kiedy: Date): Promise<void> {
    const blOrderId = ++blSeq
    const o = await db.order.update({ where: { id: orderId }, data: { blOrderId } })
    await db.blOrderSnapshot.create({
      data: { blOrderId, orderSource: 'test', orderSourceId: '1', channel: o.channel, channelAccountId: o.channelAccountId, externalRef: o.externalId, statusId: 1, statusName: 'Wysłane', dateAdd: T0, fetchedAt: kiedy },
    })
  }
  async function odczytBl(kiedy: Date): Promise<void> {
    await db.importRun.create({ data: { kind: 'cien-bl', status: 'OK', startedAt: kiedy, finishedAt: kiedy, stats: { journal: { complete: true, lastLogId: '1', events: 0 } } } })
    await zapiszUdanyPrzebieg(db, INVOICES_JOB, kiedy)
  }

  it('punkt cięcia czyści znaczniki zwolnienia; potem wpłata i osobno przelew tradycyjny ze sklepu nie zakładają rezerwacji', async () => {
    await handleChannelOrder(db, acc, woo('501', 'failed', min(5)), min(6))
    await handleChannelOrder(db, acc, woo('502', 'failed', min(5)), min(6))
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ stockReleased: 2 })
    const [o1, o2] = [await zamowienie('501'), await zamowienie('502')]
    await wyslaneWBl(o1.id, min(125))
    await wyslaneWBl(o2.id, min(125))
    await odczytBl(min(129))
    expect((await punktCiecia(db, { naSucho: false, now: min(130) })).zamkniete).toBe(2)
    for (const id of ['501', '502']) expect(await zamowienie(id)).toMatchObject({ status: 'WYSLANE', stockReleaseAt: null, stockReleasedAt: null })
    await expectInvariants(db)

    await handleChannelOrder(db, acc, woo('501', 'processing', min(200), { paid: min(199) }), min(201))
    await handleChannelOrder(db, acc, woo('502', 'on-hold', min(200), { metoda: 'bacs' }), min(201))
    for (const id of ['501', '502']) {
      const o = await zamowienie(id)
      expect(o).toMatchObject({ status: 'WYSLANE', stockReleaseAt: null, stockReleasedAt: null })
      expect(await db.reservation.count({ where: { orderId: o.id, state: { in: ['ACTIVE', 'CONSUMING'] } } })).toBe(0)
      expect(await db.orderEvent.count({ where: { orderId: o.id, kind: 'TOWAR_ZAREZERWOWANY_PONOWNIE' } })).toBe(0)
    }
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('zamówienie zwolnione, przeniesione poza Nowe ze starym znacznikiem: wpłata i przelew tylko zdejmują znaczniki', async () => {
    await handleChannelOrder(db, acc, woo('503', 'failed', min(5)), min(6))
    await handleChannelOrder(db, acc, woo('504', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    // stan sprzed poprawki punktu cięcia: zamknięte, a znacznik został
    await db.order.updateMany({ where: { externalId: { in: ['503', '504'] } }, data: { status: 'WYSLANE' } })
    await handleChannelOrder(db, acc, woo('503', 'processing', min(200), { paid: min(199) }), min(201))
    await handleChannelOrder(db, acc, woo('504', 'on-hold', min(200), { metoda: 'bacs' }), min(201))
    for (const id of ['503', '504']) {
      const o = await zamowienie(id)
      expect(o).toMatchObject({ status: 'WYSLANE', stockReleaseAt: null, stockReleasedAt: null })
      expect(await db.reservation.count({ where: { orderId: o.id, state: 'ACTIVE' } })).toBe(0)
    }
    // zmiana pozycji w sklepie na zamówieniu po zamknięciu nie zmienia pozycji bez wyjaśnienia
    await db.order.updateMany({ where: { externalId: '503' }, data: { stockReleasedAt: min(121) } })
    await handleChannelOrder(db, acc, woo('503', 'processing', min(300), { paid: min(199), qty: 3 }), min(301))
    const po = await zamowienie('503')
    expect(po.status).toBe('DO_WYJASNIENIA')
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: po.id } })).qty).toBe(2)
    expect((await stockOf(db, a)).reserved).toBe(0)
  })
})

describe('niezmiennik zamówienia ze zwolnionym towarem', () => {
  const naruszenia = async (orderId: string) => (await checkInvariants(db)).filter((v) => v.ref === orderId || v.ref.startsWith(`${orderId}/`) || v.rule.startsWith('4 '))
  const zwolnione = async (id: string, qty = 2) => {
    await handleChannelOrder(db, acc, woo(id, 'failed', min(5), { qty }), min(6))
    return zamowienie(id)
  }

  it('poprawny stan zwolnionego (Nowe i „Do wyjaśnienia”, nieopłacone, bez rezerwacji) bez naruszeń', async () => {
    await zwolnione('601')
    await runReservationExpiry(db, { now: min(121) })
    await expectInvariants(db)
    await db.order.updateMany({ where: { externalId: '601' }, data: { status: 'DO_WYJASNIENIA', statusBeforeClarify: 'NOWE', paymentState: 'PARTIAL' } })
    await expectInvariants(db)
  })

  it('łapie rezerwację ACTIVE, brak na liście braków, wpłatę, status po Nowych i termin zwolnienia przy zwolnionym towarze', async () => {
    // rezerwacja ACTIVE i otwarty brak przy znaczniku zwolnienia (stan po błędnej ścieżce rezerwującej)
    const o1 = await zwolnione('611', 7)
    await db.order.update({ where: { id: o1.id }, data: { stockReleaseAt: null, stockReleasedAt: min(121) } })
    expect(await naruszenia(o1.id)).toEqual([{ rule: '4e zwolnione', ref: o1.id, detail: 'ACTIVE/CONSUMING 1, OPEN/SHIP_LATER 1' }])
    await db.order.update({ where: { id: o1.id }, data: { stockReleasedAt: null } })

    const o2 = await zwolnione('612')
    await runReservationExpiry(db, { now: min(121) })
    await db.order.update({ where: { id: o2.id }, data: { paymentState: 'PAID' } })
    expect(await naruszenia(o2.id)).toEqual([{ rule: '4e zwolnione', ref: o2.id, detail: 'płatność PAID' }])

    await db.order.update({ where: { id: o2.id }, data: { paymentState: 'UNPAID', status: 'DO_REALIZACJI' } })
    const v = await naruszenia(o2.id)
    expect(v).toContainEqual({ rule: '4e zwolnione', ref: o2.id, detail: 'status DO_REALIZACJI' })
    // poza Nowymi i „Do wyjaśnienia” bilans pozycji już nie pomija zwolnionego
    expect(v.some((x) => x.rule === '4 bilans pozycji')).toBe(true)

    await db.order.update({ where: { id: o2.id }, data: { status: 'NOWE', stockReleaseAt: min(500) } })
    expect(await naruszenia(o2.id)).toEqual([{ rule: '4e zwolnione', ref: o2.id, detail: 'termin zwolnienia przy zwolnionym towarze' }])
    await db.order.update({ where: { id: o2.id }, data: { stockReleaseAt: null } })
    await expectInvariants(db)
  })
})

describe('przypadki brzegowe zwolnienia towaru', () => {
  it('opłacone częściowo: towar trzymany do zwykłego terminu, bez zwolnienia po krótkim terminie', async () => {
    await handleChannelOrder(db, acc, woo('701', 'failed', min(5)), min(6))
    await db.order.updateMany({ where: { externalId: '701' }, data: { paymentState: 'PARTIAL' } })
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ stockReleased: 0 })
    expect(await zamowienie('701')).toMatchObject({ status: 'NOWE', stockReleasedAt: null })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('zamówienie bez wysyłki (e-book), po zwolnieniu doszedł towar fizyczny: po wpłacie „Do wyjaśnienia” z powodem po polsku', async () => {
    const ebook = (await db.product.create({ data: { sku: 'EB', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book EB', title: 'E-book EB', vatRate: '5' } })).id
    await offer(db, 'WOO_SD', '78', ebook)
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    const zam = (modified: Date, linie: [number, number][], paid?: Date): ChannelOrder =>
      wooOrderFromApi({
        id: 702,
        status: paid ? 'processing' : 'failed',
        currency: 'PLN',
        date_created_gmt: iso19(T0),
        date_modified_gmt: iso19(modified),
        date_paid_gmt: paid ? iso19(paid) : null,
        total: '24.60',
        payment_method: 'payu',
        payment_method_title: 'Płatność online',
        shipping_lines: [],
        line_items: linie.map(([n, pid]) => ({ id: n, product_id: pid, variation_id: 0, quantity: 1, total: '10.00', total_tax: '2.30', meta_data: [] })),
      })
    await handleChannelOrder(db, acc, zam(min(5), [[1, 78]]), min(6))
    expect(await zamowienie('702')).toMatchObject({ carrier: 'BEZ_WYSYLKI', status: 'NOWE' })
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ stockReleased: 1 })
    // klientka dodała w sklepie towar fizyczny, obsługa wyjaśniła zamówienie bez wyboru przewoźnika
    await handleChannelOrder(db, acc, zam(min(130), [[1, 78], [2, 77]]), min(131))
    const o = await zamowienie('702')
    expect(o.status).toBe('DO_WYJASNIENIA')
    expect(await resolveClarification(db, o.id, { now: min(140) })).toBe('NOWE')
    await handleChannelOrder(db, acc, zam(min(200), [[1, 78], [2, 77]], min(199)), min(201))
    const po = await zamowienie('702')
    expect(po).toMatchObject({ status: 'DO_WYJASNIENIA', statusBeforeClarify: 'DO_REALIZACJI', paymentState: 'PAID', stockReleasedAt: null })
    expect(JSON.stringify(flags(po).doWyjasnienia)).toContain('towar w zamówieniu bez wysyłki')
    expect((await stockOf(db, a)).reserved).toBe(1)
    await expectInvariants(db)
  })
})

describe('zwolniony towar: anulowanie, ostatnia sztuka, wyjaśnienie, zestaw, równoległe przebiegi', () => {
  it('zwolnione anulowane w sklepie (failed → cancelled) i przez obsługę: nic do zwolnienia, znaczniki puste', async () => {
    await handleChannelOrder(db, acc, woo('801', 'failed', min(5)), min(6))
    await handleChannelOrder(db, acc, woo('802', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    const zwolnione = await db.reservation.count({ where: { state: 'RELEASED' } })
    await handleChannelOrder(db, acc, woo('801', 'cancelled', min(200)), min(201))
    expect(await cancelOrder(db, (await zamowienie('802')).id, { now: min(202), actorId: 'panel:obsluga' })).toBe('ANULOWANE')
    for (const id of ['801', '802']) expect(await zamowienie(id)).toMatchObject({ status: 'ANULOWANE', stockReleaseAt: null, stockReleasedAt: null })
    expect(await db.reservation.count({ where: { state: 'RELEASED' } })).toBe(zwolnione)
    expect(await db.reservation.count({ where: { state: { in: ['ACTIVE', 'CONSUMING'] } } })).toBe(0)
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('ostatnie sztuki: pierwsze zwolnione, drugie rezerwuje, wpłata pierwszego → cała ilość na liście braków, bez nadmiaru rezerwacji', async () => {
    await handleChannelOrder(db, acc, woo('811', 'failed', min(5), { qty: 5 }), min(6))
    await runReservationExpiry(db, { now: min(121) })
    await handleChannelOrder(db, acc, woo('812', 'on-hold', min(130), { metoda: 'bacs', qty: 5 }), min(131))
    await handleChannelOrder(db, acc, woo('811', 'processing', min(200), { qty: 5, paid: min(199) }), min(201))
    const o = await zamowienie('811')
    expect(o.paymentState).toBe('PAID')
    expect(await db.reservation.count({ where: { orderId: o.id, state: 'ACTIVE' } })).toBe(0)
    expect((await db.shortage.aggregate({ where: { orderId: o.id, state: 'OPEN' }, _sum: { qtyBase: true } }))._sum.qtyBase).toBe(5)
    const st = await stockOf(db, a)
    expect(st.reserved).toBe(5)
    expect(st.reserved).toBeLessThanOrEqual(st.physical)
    await expectInvariants(db)
  })

  it('wpłata po zwolnieniu w „Do wyjaśnienia” (niezmapowana oferta dodana w sklepie): rezerwacja zmapowanych pozycji, zostaje do wyjaśnienia', async () => {
    await handleChannelOrder(db, acc, woo('821', 'failed', min(5)), min(6))
    await runReservationExpiry(db, { now: min(121) })
    await handleChannelOrder(db, acc, woo('821', 'failed', min(130), { extraLine: '999' }), min(131))
    expect(await zamowienie('821')).toMatchObject({ status: 'DO_WYJASNIENIA', statusBeforeClarify: 'NOWE' })
    await handleChannelOrder(db, acc, woo('821', 'processing', min(200), { extraLine: '999', paid: min(199) }), min(201))
    const o = await zamowienie('821')
    expect(o).toMatchObject({ status: 'DO_WYJASNIENIA', statusBeforeClarify: 'DO_REALIZACJI', paymentState: 'PAID', stockReleasedAt: null, stockReleaseAt: null })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('zestaw: zwolnienie oddaje składniki, wpłata rezerwuje je od nowa (z brakiem)', async () => {
    const z = await bundle(db, 'ZEST', [{ id: a, qty: 2 }])
    await offer(db, 'WOO_SD', '80', z)
    // 2 × produkt + 2 zestawy po 2 sztuki = 6 sztuk przy stanie 5: zestaw rezerwuje się kompletami (2 + 2, brak 1 zestawu)
    await handleChannelOrder(db, acc, woo('831', 'failed', min(5), { extraLine: '80' }), min(6))
    const o = await zamowienie('831')
    const brak = async () => (await db.shortage.aggregate({ where: { orderId: o.id, state: 'OPEN' }, _sum: { qtyBase: true } }))._sum.qtyBase ?? 0
    const [przedRez, przedBrak] = [(await stockOf(db, a)).reserved, await brak()]
    expect(przedRez).toBe(4)
    expect(przedBrak).toBeGreaterThan(0)
    await runReservationExpiry(db, { now: min(121) })
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await db.shortage.count({ where: { orderId: o.id, state: 'OPEN' } })).toBe(0)
    await expectInvariants(db)
    await handleChannelOrder(db, acc, woo('831', 'processing', min(200), { extraLine: '80', paid: min(199) }), min(201))
    expect((await stockOf(db, a)).reserved).toBe(przedRez)
    expect(await brak()).toBe(przedBrak)
    await expectInvariants(db)
  })

  it('dwa równoległe przebiegi wygasania: jedno zwolnienie; wpłata równoległa ze zwolnieniem: opłacone z pełną rezerwacją', async () => {
    await handleChannelOrder(db, acc, woo('841', 'failed', min(5)), min(6))
    const [r1, r2] = await Promise.all([runReservationExpiry(db, { now: min(121) }), runReservationExpiry(db, { now: min(121) })])
    expect(r1.stockReleased + r2.stockReleased).toBe(1)
    const o = await zamowienie('841')
    expect(await db.orderEvent.count({ where: { orderId: o.id, kind: 'TOWAR_ZWOLNIONY' } })).toBe(1)
    await expectInvariants(db)

    await handleChannelOrder(db, acc, woo('842', 'failed', min(5)), min(6))
    const o2 = await zamowienie('842')
    await Promise.all([runReservationExpiry(db, { now: min(122) }), markPaid(db, o2.id, 'PAID', { now: min(122), actorId: 'panel:obsluga' })])
    expect(await zamowienie('842')).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID', stockReleaseAt: null, stockReleasedAt: null })
    expect(await db.reservation.aggregate({ where: { orderId: o2.id, state: 'ACTIVE' }, _sum: { qtyBase: true } })).toMatchObject({ _sum: { qtyBase: 2 } })
    await expectInvariants(db)
  })
})
