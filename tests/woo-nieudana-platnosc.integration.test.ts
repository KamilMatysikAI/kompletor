// Woo `failed` (nieudana płatność, np. BLIK): zamówienie otwarte i nieopłacone jak `pending` (tak prowadzi je też
// BaseLinker), nie anulowane. Przez prawdziwą mapę adaptera (`wooOrderFromApi`) i odczyt kanału (`handleChannelOrder`):
// rezerwacja do terminu (nieudana płatność online: sam towar wraca po krótkim terminie, zamówienie czeka), przypomnienie
// i mail „Brak płatności” w planie (bez wysyłki), po terminie „anulowane, nieopłacone”, wpłata po czasie otwiera realizację, anulowanie w sklepie zwalnia towar. Do tego jednorazowe
// przeliczenie zamówień zapisanych dawniej jako anulowane. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { planujAkcje } from '@/lib/akcje/silnik'
import type { ChannelOrder } from '@/lib/adaptery/kontrakt'
import { loadChannelAccounts, type ChannelAccountSettings } from '@/lib/adaptery/konta'
import { wooOrderFromApi } from '@/lib/adaptery/woo'
import { handleChannelOrder } from '@/lib/cien/odczyt-zamowien'
import { przeliczNieudanePlatnosciWoo } from '@/lib/kanaly/nieudane-platnosci-woo'
import { wykonajZapisy, zaplanujZapisy } from '@/lib/kanaly/zapis-host'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { WOO_ZAPIS_KEY } from '@/lib/adaptery/woo-zapis'
import { getPolicy, termsFor } from '@/lib/rdzen/polityka'
import { packOrder } from '@/lib/rdzen/rozchod'
import { cancelOrder, ingestOrder, przywrocNieudanaPlatnosc, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { testDb, testSystemDb, truncateAll } from './db'
import { expectInvariants, offer, product, seedBase, stockOf, T0, udanyOdczytKonta } from './rdzen-fixtures'

const db = testDb()
/** Przeliczenie zaraz po udanym odczycie sklepu (zapis wymaga świeżego odczytu konta). */
async function przelicz(d: typeof db, opts: Parameters<typeof przeliczNieudanePlatnosciWoo>[1] = {}) {
  await udanyOdczytKonta(d, 'WOO', 'sd', opts.now ?? new Date())
  return przeliczNieudanePlatnosciWoo(d, opts)
}
afterAll(async () => {
  await db.$disconnect()
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

/** Zamówienie WC REST v3 (fikcyjne, bez danych odbiorcy) w danym statusie i chwili zmiany. */
function woo(id: string, status: string, modified: Date, paid: Date | null = null, qty = 2, metoda = 'payublik'): ChannelOrder {
  return wooOrderFromApi({
    id: Number(id),
    status,
    currency: 'PLN',
    date_created_gmt: iso19(T0),
    date_modified_gmt: iso19(modified),
    date_paid_gmt: paid ? iso19(paid) : null,
    total: (qty * 12.3).toFixed(2),
    payment_method: metoda,
    payment_method_title: metoda === 'bacs' ? 'Przelew bankowy' : 'BLIK',
    shipping_lines: [{ method_title: 'Paczkomaty InPost' }],
    line_items: [{ id: 1, product_id: 77, variation_id: 0, quantity: qty, total: (qty * 10).toFixed(2), total_tax: (qty * 2.3).toFixed(2), meta_data: [] }],
  })
}

const zamowienie = (externalId: string) => db.order.findFirstOrThrow({ where: { channel: 'WOO', channelAccountId: 'sd', externalId } })

describe('Woo failed: otwarte, nieopłacone (jak pending)', () => {
  it('pierwszy odczyt w statusie failed: Nowe, nieopłacone, rezerwacja do terminu zwolnienia towaru (2 h od złożenia), zwykły termin anulowania, przypomnienie następnego dnia; pakowanie zablokowane', async () => {
    expect(await handleChannelOrder(db, acc, woo('901', 'failed', min(40)), min(41))).toBe('NOWE')
    const o = await zamowienie('901')
    const terms = termsFor(T0, await getPolicy(db))
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', cancelReason: null, stockReleasedAt: null })
    expect(o.stockReleaseAt!.toISOString()).toBe(min(120).toISOString())
    expect(o.reservationDeadline!.toISOString()).toBe(terms.reservationDeadline.toISOString())
    // pytanie o płatność z danymi do przelewu następnego dnia o 9:00 (T0 = czwartek 10:00 w Warszawie)
    expect(o.remindAt!.toISOString()).toBe('2026-10-16T07:00:00.000Z')
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expect(packOrder(db, o.id, { now: min(42) })).rejects.toThrow()
    await expectInvariants(db)
  })

  it('pending → failed → processing (wpłata po czasie): rezerwacja bez przerwy, potem Do realizacji, opłacone', async () => {
    await handleChannelOrder(db, acc, woo('902', 'pending', min(1)), min(2))
    await handleChannelOrder(db, acc, woo('902', 'failed', min(45)), min(46))
    expect(await zamowienie('902')).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID' })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await handleChannelOrder(db, acc, woo('902', 'processing', min(120), min(119)), min(121))
    expect(await zamowienie('902')).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID', reservationDeadline: null })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect(await db.orderEvent.count({ where: { kind: 'ANULOWANE' } })).toBe(0)
    await expectInvariants(db)
  })

  it('failed przelewem tradycyjnym (bacs): przypomnienie i mail „Brak płatności” w planie wg zwykłych terminów', async () => {
    await handleChannelOrder(db, acc, woo('930', 'failed', min(40), null, 2, 'bacs'), min(41))
    const o = await zamowienie('930')
    expect(o.remindAt!.toISOString()).toBe(termsFor(T0, await getPolicy(db)).remindAt.toISOString())
    const przyp = new Date(o.remindAt!.getTime() + 60_000)
    expect((await runReservationExpiry(db, { now: przyp })).reminders).toBe(1)
    expect((await planujAkcje(db, { now: przyp })).nowe['mail.brak-platnosci']).toBe(1)
    const plan = await db.plannedAction.findFirstOrThrow({ where: { rule: 'mail.brak-platnosci', targetId: o.id } })
    expect(plan).toMatchObject({ state: 'PLANNED', mode: 'SUCHO' })
    expect((plan.vars as Record<string, unknown>).terminAnulowania).toBe(o.reservationDeadline!.toISOString())
  })

  it('failed online: po krótkim terminie sam towar wraca, zamówienie Nowe i nieopłacone; po zwykłym terminie anulowane; wpłata potem otwiera realizację', async () => {
    await handleChannelOrder(db, acc, woo('903', 'failed', min(40)), min(41))
    const o = await zamowienie('903')
    expect(await runReservationExpiry(db, { now: min(119) })).toMatchObject({ reminders: 0, released: 0, stockReleased: 0 })
    expect(await runReservationExpiry(db, { now: min(121) })).toMatchObject({ released: 0, stockReleased: 1 })
    expect(await zamowienie('903')).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', cancelReason: null, stockReleaseAt: null, stockReleasedAt: min(121) })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
    const poTerminie = new Date(o.reservationDeadline!.getTime() + 60_000)
    expect((await runReservationExpiry(db, { now: poTerminie })).released).toBe(1)
    expect(await zamowienie('903')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'EXPIRED_UNPAID', stockReleasedAt: null })
    expect((await stockOf(db, a)).reserved).toBe(0)
    const wplata = new Date(poTerminie.getTime() + 3600_000)
    await handleChannelOrder(db, acc, woo('903', 'processing', wplata, wplata), new Date(wplata.getTime() + 60_000))
    expect(await zamowienie('903')).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID', cancelReason: null })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('konto w trybie pracy z zapisem statusów: zwolnienie towaru nic nie zapisuje do sklepu; wpłata po zwolnieniu rezerwuje od nowa', async () => {
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: WOO_ZAPIS_KEY, statusMode: 'PRACA' } })
    acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    await handleChannelOrder(db, acc, woo('907', 'failed', min(40)), min(41))
    const id = (await zamowienie('907')).id
    expect((await runReservationExpiry(db, { now: min(121) })).stockReleased).toBe(1)
    const teraz = new Date(Date.now()) // okno planowania liczy się od updatedAt (zegar bazy)
    await zaplanujZapisy(db, defaultRegistry(), { now: teraz })
    expect(await db.channelWrite.count({ where: { orderId: id, kind: 'STATUS' } })).toBe(0)
    expect(await zamowienie('907')).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID' })
    await handleChannelOrder(db, acc, woo('907', 'processing', min(300), min(299)), min(301))
    expect(await zamowienie('907')).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID', stockReleasedAt: null })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect(await db.channelWrite.count({ where: { orderId: id, key: 'ANULOWANE_NIEOPLACONE' } })).toBe(0)
    await expectInvariants(db)
  })

  it('failed → cancelled w sklepie: Anulowane, towar wraca', async () => {
    await handleChannelOrder(db, acc, woo('904', 'failed', min(40)), min(41))
    await handleChannelOrder(db, acc, woo('904', 'cancelled', min(300)), min(301))
    expect(await zamowienie('904')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })
})

describe('przeliczenie zamówień zapisanych jako anulowane z powodu failed', () => {
  /** Tak zapisywała je dawna mapa adaptera: failed → cykl życia CANCELLED. */
  const dawniej = (o: ChannelOrder): ChannelOrder => ({ ...o, lifecycle: 'CANCELLED', statusRank: null })

  it('na sucho nic nie zmienia; zapis w terminie: otwarte (anulowane po przyjęciu i przyjęte od razu jako anulowane), towar od razu zwolniony, bo krótki termin minął; powtórka bez zmian', async () => {
    const b = await product(db, 'B', 5)
    await offer(db, 'WOO_SD', '88', b)
    // 905: w terminie (pending → failed); 906: failed od pierwszego odczytu, termin minie
    await handleChannelOrder(db, acc, woo('905', 'pending', min(1)), min(2))
    await handleChannelOrder(db, acc, dawniej(woo('905', 'failed', min(45))), min(46))
    const stary = woo('906', 'failed', min(40))
    await handleChannelOrder(db, acc, dawniej({ ...stary, lines: stary.lines.map((l) => ({ ...l, offerExternalId: '88' })) }), min(41))
    expect(await zamowienie('905')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    expect(((await zamowienie('905')).flags as Record<string, unknown>).nieudanaPlatnoscOnline).toBeUndefined()
    // pierwszy odczyt już w failed: przyjęte od razu jako anulowane, bez powodu i bez anulowania w dzienniku
    expect(await zamowienie('906')).toMatchObject({ status: 'ANULOWANE', cancelReason: null })
    expect((await stockOf(db, a)).reserved).toBe(0)

    const teraz = min(24 * 60) // dzień później: termin 5 dni roboczych od złożenia trwa
    const sucho = await przelicz(db, { now: teraz })
    expect(sucho).toMatchObject({ naSucho: true, kandydaci: 2, kopie: 2, bledy: [], otwarte: [] })
    expect(sucho.otwarteZwolnione).toHaveLength(2)
    expect(await zamowienie('905')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await db.channelOrderSnapshot.count({ where: { channelStatus: 'failed', lifecycle: 'CANCELLED' } })).toBe(2)

    const r = await przelicz(db, { now: teraz, naSucho: false })
    expect(r).toMatchObject({ naSucho: false, kandydaci: 2, kopie: 2, bledy: [], pominiete: [], otwarte: [] })
    expect(r.otwarteZwolnione).toHaveLength(2)
    const o = await zamowienie('905')
    // 905 bez znacznika nieudanej płatności online (zapisane przed jego wprowadzeniem): przeliczenie i tak liczy je jako
    // nieudaną płatność online, krótki termin od złożenia minął, więc towar wraca do sprzedaży od razu
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', cancelReason: null, stockReleasedAt: teraz, stockReleaseAt: null })
    expect((o.flags as Record<string, unknown>).nieudanaPlatnoscOnline).toBe(true)
    expect(o.reservationDeadline!.toISOString()).toBe(termsFor(T0, await getPolicy(db)).reservationDeadline.toISOString())
    expect((await stockOf(db, a)).reserved).toBe(0)
    // 906 ma znacznik nieudanej płatności online z przyjęcia: termin zwolnienia towaru (2 h od złożenia) już minął,
    // więc po przywróceniu zostaje otwarte bez rezerwacji i czeka na płatność
    expect((await stockOf(db, b)).reserved).toBe(0)
    expect(await zamowienie('906')).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleasedAt: teraz })
    expect(await db.orderEvent.count({ where: { orderId: o.id, kind: 'NIEUDANA_PLATNOSC_OTWARTE' } })).toBe(1)
    expect(await db.channelOrderSnapshot.count({ where: { channelStatus: 'failed', lifecycle: 'CANCELLED' } })).toBe(0)
    await expectInvariants(db)

    const znowu = await przelicz(db, { now: teraz, naSucho: false })
    expect(znowu).toMatchObject({ kandydaci: 0, otwarte: [], otwarteZwolnione: [], poTerminie: [], kopie: 0 })
  })

  it('termin minął: „anulowane, nieopłacone” (EXPIRED_UNPAID), stany bez zmian; wpłata potem otwiera realizację', async () => {
    await handleChannelOrder(db, acc, dawniej(woo('907', 'failed', min(40))), min(41))
    const teraz = min(20 * 24 * 60)
    const r = await przelicz(db, { now: teraz, naSucho: false })
    expect(r.poTerminie).toHaveLength(1)
    expect(await zamowienie('907')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'EXPIRED_UNPAID' })
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await db.orderEvent.count({ where: { kind: 'NIEUDANA_PLATNOSC_PO_TERMINIE' } })).toBe(1)
    const wplata = new Date(teraz.getTime() + 60_000)
    await handleChannelOrder(db, acc, woo('907', 'processing', wplata, wplata), new Date(wplata.getTime() + 60_000))
    expect(await zamowienie('907')).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID' })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('pomija anulowane przez obsługę i zamówienia spoza failed', async () => {
    await handleChannelOrder(db, acc, woo('908', 'pending', min(1)), min(2))
    await cancelOrder(db, (await zamowienie('908')).id, { actorId: 'panel:obsluga', now: min(3) })
    await handleChannelOrder(db, acc, dawniej(woo('908', 'failed', min(45))), min(46))
    await handleChannelOrder(db, acc, woo('909', 'cancelled', min(40)), min(41))
    await ingestOrder(db, { source: 'test', channel: 'WOO', channelAccountId: 'sd', externalId: '910', externalRevision: '1', createdAtChannel: T0, paymentState: 'UNPAID', paymentMethod: 'BLIK', totalGross: 10, cancelled: true, lines: [] }, { now: min(5) })
    const r = await przelicz(db, { now: min(60), naSucho: false })
    expect(r).toMatchObject({ kandydaci: 1, otwarte: [], poTerminie: [], bledy: [] })
    expect(r.pominiete).toHaveLength(1)
    expect(await zamowienie('908')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    expect(await zamowienie('909')).toMatchObject({ status: 'ANULOWANE', cancelReason: null })
    expect((await stockOf(db, a)).reserved).toBe(0)
  })

  it('konto w trybie pracy odkładane na osobną listę bez zmian; z jawną flagą przeliczane', async () => {
    await handleChannelOrder(db, acc, woo('914', 'pending', min(1)), min(2))
    await handleChannelOrder(db, acc, dawniej(woo('914', 'failed', min(45))), min(46))
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const teraz = min(24 * 60)
    const r = await przelicz(db, { now: teraz, naSucho: false })
    expect(r).toMatchObject({ kandydaci: 1, otwarte: [], otwarteZwolnione: [], poTerminie: [], pominiete: [], kopie: 0, bledy: [] })
    expect(r.wPracy).toEqual(['914'])
    expect(await zamowienie('914')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    expect(await db.channelOrderSnapshot.count({ where: { channelStatus: 'failed', lifecycle: 'CANCELLED' } })).toBe(1)
    expect((await stockOf(db, a)).reserved).toBe(0)

    const z = await przelicz(db, { now: teraz, naSucho: false, takzeWPracy: true })
    // krótki termin nieudanej płatności online od złożenia minął: otwarte, towar od razu w sprzedaży
    expect(z).toMatchObject({ kandydaci: 1, wPracy: [], otwarte: [], otwarteZwolnione: ['914'], kopie: 1, bledy: [] })
    expect(await zamowienie('914')).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleasedAt: teraz })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })

  it('konto w podglądzie przeliczane bez flagi (lista „w trybie pracy” pusta)', async () => {
    await handleChannelOrder(db, acc, dawniej(woo('915', 'failed', min(40))), min(41))
    const r = await przelicz(db, { now: min(24 * 60), naSucho: false })
    expect(r).toMatchObject({ kandydaci: 1, wPracy: [], otwarteZwolnione: ['915'], kopie: 1 })
  })

  it('brak towaru przy przywróceniu: Do wyjaśnienia, rezerwacja tylko z dostępnego, stan nie schodzi poniżej zera', async () => {
    await handleChannelOrder(db, acc, dawniej(woo('920', 'failed', min(40), null, 2)), min(41))
    await handleChannelOrder(db, acc, woo('921', 'pending', min(50), null, 4), min(51)) // zajmuje 4 z 5 sztuk
    expect((await stockOf(db, a)).reserved).toBe(4)
    const r = await przelicz(db, { now: min(24 * 60), naSucho: false })
    expect(r).toMatchObject({ kandydaci: 1, otwarte: ['920'], bledy: [] })
    const o = await zamowienie('920')
    expect(o).toMatchObject({ status: 'DO_WYJASNIENIA', statusBeforeClarify: 'NOWE', paymentState: 'UNPAID' })
    const s = await stockOf(db, a)
    expect(s.reserved).toBe(5)
    expect(s.physical - s.reserved).toBe(0)
    await expectInvariants(db)
  })

  it('gałąź „po terminie” w podglądzie: jeden wiersz zapisu do sklepu CIEN (anulowanie nieopłaconego), nic nie wychodzi', async () => {
    await handleChannelOrder(db, acc, dawniej(woo('922', 'failed', min(40))), min(41))
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: WOO_ZAPIS_KEY } }) // zapis statusów, konto w podglądzie (CIEN)
    const r = await przelicz(db, { now: min(20 * 24 * 60), naSucho: false })
    expect(r.poTerminie).toEqual(['922'])
    const id = (await zamowienie('922')).id
    const teraz = new Date(Date.now()) // okno planowania liczy się od updatedAt (zegar bazy)
    await zaplanujZapisy(db, defaultRegistry(), { now: teraz })
    await zaplanujZapisy(db, defaultRegistry(), { now: teraz })
    const w = await db.channelWrite.findMany({ where: { orderId: id } })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: 'STATUS', key: 'ANULOWANE_NIEOPLACONE', channelStatus: 'cancelled', mode: 'CIEN', state: 'CIEN' })
    await wykonajZapisy(db, { registry: defaultRegistry(), secrets: { env: {}, envFallback: false }, now: new Date(Date.now()) })
    expect(await db.channelWrite.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'CIEN', attempts: 0 })
  })

  it('przyjęte od razu jako anulowane, potem opłacone w sklepie: lista do ręcznej decyzji, bez zmian', async () => {
    await handleChannelOrder(db, acc, dawniej(woo('916', 'failed', min(40))), min(41))
    await handleChannelOrder(db, acc, woo('916', 'processing', min(90), min(89)), min(91))
    const przed = await zamowienie('916')
    expect(przed).toMatchObject({ status: 'ANULOWANE', paymentState: 'PAID' })
    const r = await przelicz(db, { now: min(120), naSucho: false })
    expect(r).toMatchObject({ kandydaci: 0, otwarte: [], doRecznejDecyzji: ['916'] })
    expect(await zamowienie('916')).toMatchObject({ status: przed.status, paymentState: 'PAID', cancelReason: przed.cancelReason })
  })

  it('tylko klient firmy (klient systemowy = błąd, nic nie czyta)', async () => {
    await expect(przeliczNieudanePlatnosciWoo(testSystemDb())).rejects.toThrow(/klienta firmy/)
  })

  it('wołane wprost na zamówieniu anulowanym w sklepie (cancelled, refunded) zostaje Anulowane', async () => {
    await handleChannelOrder(db, acc, woo('911', 'cancelled', min(40)), min(41))
    await handleChannelOrder(db, acc, woo('912', 'pending', min(1)), min(2))
    await handleChannelOrder(db, acc, woo('912', 'refunded', min(45)), min(46))
    for (const nr of ['911', '912']) {
      expect(await przywrocNieudanaPlatnosc(db, (await zamowienie(nr)).id, { now: min(60), statusKanalu: 'failed' })).toBe('pominiete')
      expect(await zamowienie(nr)).toMatchObject({ status: 'ANULOWANE' })
    }
    expect(await db.orderEvent.count({ where: { kind: { in: ['NIEUDANA_PLATNOSC_OTWARTE', 'NIEUDANA_PLATNOSC_PO_TERMINIE'] } } })).toBe(0)
    expect((await stockOf(db, a)).reserved).toBe(0)
  })

  it('(wyścig): sklep zmienia failed → cancelled po wyborze kandydatów, przed blokadą: zamówienie zostaje Anulowane', async () => {
    const dawniej = (o: ChannelOrder): ChannelOrder => ({ ...o, lifecycle: 'CANCELLED', statusRank: null })
    await handleChannelOrder(db, acc, woo('913', 'pending', min(1)), min(2))
    await handleChannelOrder(db, acc, dawniej(woo('913', 'failed', min(45))), min(46))
    const id = (await zamowienie('913')).id // kandydat wybrany przy statusie failed
    await handleChannelOrder(db, acc, woo('913', 'cancelled', min(300)), min(301)) // odczyt w międzyczasie
    expect(await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: '913' } })).toMatchObject({ channelStatus: 'cancelled' })
    expect(await przywrocNieudanaPlatnosc(db, id, { now: min(302), statusKanalu: 'failed' })).toBe('pominiete')
    expect(await zamowienie('913')).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
  })
})
