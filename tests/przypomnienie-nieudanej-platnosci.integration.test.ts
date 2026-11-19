// Pytanie o płatność po nieudanej płatności online (Woo `failed` przy bramce online): przypomnienie rano następnego dnia
// (ustawienie firmy „Zapytaj o płatność po … dni”), ta sama reguła planu `mail.brak-platnosci` z wariantem „Nieudana
// płatność online” (dane do przelewu z Danych firmy). Zwykłe nieopłacone (przelew tradycyjny, pending) bez zmian.
// Do tego druga część przeliczenia `nieudane-platnosci-woo`: otwarte zamówienia z kopią `failed` bez znacznika.
// Przez prawdziwą mapę adaptera (`wooOrderFromApi`) i odczyt kanału (`handleChannelOrder`). Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelOrder } from '@/lib/adaptery/kontrakt'
import { loadChannelAccounts, type ChannelAccountSettings } from '@/lib/adaptery/konta'
import { wooOrderFromApi } from '@/lib/adaptery/woo'
import { podgladPlanu } from '@/lib/akcje/panel'
import { planujAkcje } from '@/lib/akcje/silnik'
import { DROGA_DANYCH_FIRMY } from '@/lib/akcje/wariant-platnosci'
import { handleChannelOrder } from '@/lib/cien/odczyt-zamowien'
import { opisNieudanychPlatnosciWoo, przeliczNieudanePlatnosciWoo } from '@/lib/kanaly/nieudane-platnosci-woo'
import { getPolicy, savePolicy, termsFor } from '@/lib/rdzen/polityka'
import { runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { expectInvariants, offer, product, seedBase, stockOf, T0, udanyOdczytKonta } from './rdzen-fixtures'

const db = testDb()
/** Przeliczenie zaraz po udanym odczycie sklepu (zapis wymaga świeżego odczytu konta). */
async function przelicz(d: typeof db, opts: Parameters<typeof przeliczNieudanePlatnosciWoo>[1] = {}) {
  await udanyOdczytKonta(d, 'WOO', 'sd', opts.now ?? new Date())
  return przeliczNieudanePlatnosciWoo(d, opts)
}
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
  await sys.$disconnect()
})

/** Fikcyjny, poprawny NRB (suma kontrolna) — wyłącznie do testów. */
const RACHUNEK = '61109010140000071219812874'

let a: string
let acc: ChannelAccountSettings

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  a = await product(db, 'A', 20)
  await offer(db, 'WOO_SD', '77', a)
  acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
  await rachunekFirmy(ORG_A, RACHUNEK)
})

async function rachunekFirmy(orgId: string, rachunek: string | null): Promise<void> {
  const firma = { nazwa: 'Pracownia Testowa sp. z o.o.', ...(rachunek ? { rachunek } : {}) }
  await sys.organization.update({ where: { id: orgId }, data: { settings: { firma } as never } })
}

const iso19 = (d: Date) => d.toISOString().slice(0, 19)
const min = (n: number) => new Date(T0.getTime() + n * 60_000)
/** T0 = czwartek 15.10 10:00 w Warszawie; piątek 9:00 (czas letni) = 07:00 UTC. */
const PIATEK_9 = new Date('2026-10-16T07:00:00.000Z')
const poMinucie = (d: Date) => new Date(d.getTime() + 60_000)

/** Zamówienie WC REST v3 (fikcyjne, bez danych odbiorcy). `metoda` = identyfikator metody płatności Woo. */
function woo(id: string, status: string, modified: Date, opts: { metoda?: string; paid?: Date } = {}): ChannelOrder {
  const { metoda = 'payu', paid } = opts
  return wooOrderFromApi({
    id: Number(id),
    status,
    currency: 'PLN',
    date_created_gmt: iso19(T0),
    date_modified_gmt: iso19(modified),
    date_paid_gmt: paid ? iso19(paid) : null,
    total: '24.60',
    payment_method: metoda,
    payment_method_title: metoda === 'bacs' ? 'Przelew tradycyjny' : 'Płatność online',
    shipping_lines: [{ method_title: 'Paczkomaty InPost' }],
    line_items: [{ id: 1, product_id: 77, variation_id: 0, quantity: 2, total: '20.00', total_tax: '4.60', meta_data: [] }],
  })
}

const zamowienie = (externalId: string, d = db) => d.order.findFirstOrThrow({ where: { channel: 'WOO', channelAccountId: 'sd', externalId } })
const flagi = (o: { flags: unknown }) => (o.flags ?? {}) as Record<string, unknown>
const planyMaila = (d = db) => d.plannedAction.findMany({ where: { rule: 'mail.brak-platnosci' } })

describe('pytanie o płatność następnego dnia', () => {
  it('tylko nieudana płatność online nieopłacona: przypomnienie w piątek 9:00 i plan z wariantem; przelew tradycyjny i pending wg zwykłych terminów, bez wariantu', async () => {
    await handleChannelOrder(db, acc, woo('501', 'failed', min(10)), min(11))
    await handleChannelOrder(db, acc, woo('502', 'on-hold', min(10), { metoda: 'bacs' }), min(11))
    await handleChannelOrder(db, acc, woo('503', 'pending', min(10)), min(11))
    const zwykle = termsFor(T0, await getPolicy(db)).remindAt
    expect((await zamowienie('501')).remindAt!.toISOString()).toBe(PIATEK_9.toISOString())
    expect((await zamowienie('502')).remindAt!.toISOString()).toBe(zwykle.toISOString())
    expect((await zamowienie('503')).remindAt!.toISOString()).toBe(zwykle.toISOString())
    expect(zwykle.getTime()).toBeGreaterThan(PIATEK_9.getTime())

    expect((await runReservationExpiry(db, { now: poMinucie(PIATEK_9) })).reminders).toBe(1)
    await planujAkcje(db, { now: poMinucie(PIATEK_9) })
    const [p1] = await planyMaila()
    const o1 = await zamowienie('501')
    expect(p1).toMatchObject({ targetId: o1.id, state: 'PLANNED' })
    expect(p1!.vars).toMatchObject({ wariant: 'nieudana-platnosc', terminAnulowania: o1.reservationDeadline!.toISOString() })

    // zwykłe nieopłacone: „Brak płatności” jak dotąd, bez wariantu
    expect((await runReservationExpiry(db, { now: poMinucie(zwykle) })).reminders).toBe(2)
    await planujAkcje(db, { now: poMinucie(zwykle) })
    const plany = await planyMaila()
    expect(plany).toHaveLength(3)
    const idsZwyklych = [(await zamowienie('502')).id, (await zamowienie('503')).id].sort()
    const zwyklePlany = plany.filter((x) => x.targetId !== o1.id)
    expect(zwyklePlany.map((x) => x.targetId).sort()).toEqual(idsZwyklych)
    expect(zwyklePlany.map((x) => (x.vars as Record<string, unknown>).wariant)).toEqual([undefined, undefined])
    expect(zwyklePlany.every((x) => x.state === 'PLANNED')).toBe(true)
    await expectInvariants(db)
  })

  it('znacznik przychodzi po 2 dniach (piątek 9:00 minęła): pytanie o płatność najbliższego ranka, nie od razu', async () => {
    await handleChannelOrder(db, acc, woo('505', 'pending', min(10)), min(11))
    // sobota 17.10 14:00 w Warszawie: bramka znów odrzuciła płatność
    const sobota = new Date('2026-10-17T12:00:00.000Z')
    await handleChannelOrder(db, acc, woo('505', 'failed', sobota), poMinucie(sobota))
    const o = await zamowienie('505')
    expect(flagi(o).nieudanaPlatnoscOnline).toBe(true)
    const niedziela9 = new Date('2026-10-18T07:00:00.000Z')
    expect(o.remindAt!.toISOString()).toBe(niedziela9.toISOString())
    expect(o.remindAt!.getTime()).toBeLessThan(o.reservationDeadline!.getTime())
    expect((await runReservationExpiry(db, { now: new Date(sobota.getTime() + 5 * 60_000) })).reminders).toBe(0)
    expect((await runReservationExpiry(db, { now: poMinucie(niedziela9) })).reminders).toBe(1)
  })

  it('wpłata przed przypomnieniem: bez przypomnienia i bez planu maila', async () => {
    await handleChannelOrder(db, acc, woo('511', 'failed', min(10)), min(11))
    await handleChannelOrder(db, acc, woo('511', 'processing', min(300), { paid: min(299) }), min(301))
    expect(await zamowienie('511')).toMatchObject({ paymentState: 'PAID', remindAt: null })
    expect((await runReservationExpiry(db, { now: poMinucie(PIATEK_9) })).reminders).toBe(0)
    await planujAkcje(db, { now: poMinucie(PIATEK_9) })
    expect(await planyMaila()).toHaveLength(0)
  })

  it('zmiana na przelew tradycyjny przed przypomnieniem: zwykły termin przypomnienia i zwykły mail', async () => {
    await handleChannelOrder(db, acc, woo('512', 'failed', min(10)), min(11))
    await handleChannelOrder(db, acc, woo('512', 'on-hold', min(60), { metoda: 'bacs' }), min(61))
    const o = await zamowienie('512')
    const zwykle = termsFor(T0, await getPolicy(db)).remindAt
    expect(flagi(o).nieudanaPlatnoscOnline).not.toBe(true)
    expect(o.remindAt!.toISOString()).toBe(zwykle.toISOString())
    expect((await runReservationExpiry(db, { now: poMinucie(PIATEK_9) })).reminders).toBe(0)
    expect((await runReservationExpiry(db, { now: poMinucie(zwykle) })).reminders).toBe(1)
    await planujAkcje(db, { now: poMinucie(zwykle) })
    const [p] = await planyMaila()
    expect(p).toMatchObject({ targetId: o.id, state: 'PLANNED' })
    expect((p!.vars as Record<string, unknown>).wariant).toBeUndefined()
  })

  it('anulowane w sklepie przed przypomnieniem: bez przypomnienia i bez planu maila', async () => {
    await handleChannelOrder(db, acc, woo('513', 'failed', min(10)), min(11))
    await handleChannelOrder(db, acc, woo('513', 'cancelled', min(60)), min(61))
    expect(await zamowienie('513')).toMatchObject({ status: 'ANULOWANE' })
    expect((await runReservationExpiry(db, { now: poMinucie(PIATEK_9) })).reminders).toBe(0)
    await planujAkcje(db, { now: poMinucie(PIATEK_9) })
    expect(await planyMaila()).toHaveLength(0)
  })

  it('firma bez numeru rachunku: plan zwykłego „Brak płatności” w tym samym terminie, z informacją dla biura w powodzie i podglądzie', async () => {
    await rachunekFirmy(ORG_A, null)
    await handleChannelOrder(db, acc, woo('521', 'failed', min(10)), min(11))
    await runReservationExpiry(db, { now: poMinucie(PIATEK_9) })
    await planujAkcje(db, { now: poMinucie(PIATEK_9) })
    const [p] = await planyMaila()
    expect(p).toMatchObject({ state: 'PLANNED' })
    expect((p!.vars as Record<string, unknown>).wariant).toBeUndefined()
    expect(p!.reason).toContain('brakuje numeru rachunku')
    expect(p!.reason).toContain(DROGA_DANYCH_FIRMY)
    const podglad = await podgladPlanu(db, p!.id, {})
    expect(podglad!.temat).not.toContain('Czy był problem z płatnością')
    expect(podglad!.informacje!.join(' ')).toContain(DROGA_DANYCH_FIRMY)
    expect(JSON.stringify(podglad)).not.toContain('Mail nie wyjdzie')
  })

  it('dwie firmy: liczba dni i rachunek każdej firmy osobno', async () => {
    await seedBase(dbB)
    const aB = await product(dbB, 'A', 20)
    await offer(dbB, 'WOO_SD', '77', aB)
    const accB = (await loadChannelAccounts(dbB)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    await savePolicy(dbB, { failedOnlinePaymentReminderDays: 3 }, 'test')
    expect((await getPolicy(db)).failedOnlinePaymentReminderDays).toBe(1)
    await handleChannelOrder(db, acc, woo('531', 'failed', min(10)), min(11))
    await handleChannelOrder(dbB, accB, woo('531', 'failed', min(10)), min(11))
    expect((await zamowienie('531')).remindAt!.toISOString()).toBe(PIATEK_9.toISOString())
    // B: niedziela 18.10 9:00 (czas letni)
    const niedziela9 = new Date('2026-10-18T07:00:00.000Z')
    expect((await zamowienie('531', dbB)).remindAt!.toISOString()).toBe(niedziela9.toISOString())

    // A ma rachunek, B nie: plan A z wariantem, plan B zwykły (rachunek A nie przecieka do B)
    await runReservationExpiry(db, { now: poMinucie(niedziela9) })
    await runReservationExpiry(dbB, { now: poMinucie(niedziela9) })
    await planujAkcje(db, { now: poMinucie(niedziela9) })
    await planujAkcje(dbB, { now: poMinucie(niedziela9) })
    expect((await planyMaila()).map((p) => [p.state, (p.vars as Record<string, unknown>).wariant])).toEqual([['PLANNED', 'nieudana-platnosc']])
    const planyB = await planyMaila(dbB)
    expect(planyB.map((p) => [p.state, (p.vars as Record<string, unknown>).wariant])).toEqual([['PLANNED', undefined]])
    expect(planyB[0]!.reason).toContain('brakuje numeru rachunku')
    expect(JSON.stringify(await podgladPlanu(dbB, planyB[0]!.id, {}))).not.toContain(RACHUNEK)
  })
})

describe('przeliczenie otwartych zamówień z kopią failed bez znacznika', () => {
  /** Tak zostawił je odczyt sprzed rozpoznawania nieudanej płatności online: otwarte, bez znacznika, kopia `failed`. */
  async function otwarteBezZnacznika(id: string, opts: { status?: string; metoda?: string; paid?: Date } = {}): Promise<string> {
    await handleChannelOrder(db, acc, woo(id, opts.status ?? 'pending', min(10), opts), min(11))
    const o = await zamowienie(id)
    await db.channelOrderSnapshot.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd', externalId: id }, data: { channelStatus: 'failed' } })
    expect(flagi(o).nieudanaPlatnoscOnline).not.toBe(true)
    return o.id
  }

  it('krótki termin trwa: na sucho nic, zapis = znacznik, termin zwolnienia od złożenia, pytanie o płatność następnego dnia; towar trzymany; powtórka nic', async () => {
    await otwarteBezZnacznika('541')
    const teraz = min(60)
    const sucho = await przelicz(db, { now: teraz })
    expect(sucho).toMatchObject({ naSucho: true, kandydaciOtwarte: 1, oznaczone: ['541'], oznaczoneZwolnione: [], bledy: [] })
    const przed = await zamowienie('541')
    expect(flagi(przed).nieudanaPlatnoscOnline).not.toBe(true)
    expect(przed.stockReleaseAt).toBeNull()

    const r = await przelicz(db, { now: teraz, naSucho: false })
    expect(r).toMatchObject({ naSucho: false, kandydaciOtwarte: 1, oznaczone: ['541'], oznaczoneZwolnione: [], bledy: [] })
    const o = await zamowienie('541')
    expect(flagi(o).nieudanaPlatnoscOnline).toBe(true)
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleasedAt: null })
    expect(o.stockReleaseAt!.toISOString()).toBe(min(120).toISOString())
    expect(o.remindAt!.toISOString()).toBe(PIATEK_9.toISOString())
    expect(o.reservationDeadline!.toISOString()).toBe(przed.reservationDeadline!.toISOString())
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)

    const znowu = await przelicz(db, { now: teraz, naSucho: false })
    expect(znowu).toMatchObject({ kandydaciOtwarte: 0, oznaczone: [], oznaczoneZwolnione: [] })
  })

  it('krótki termin minął: zwolnienie towaru od razu; na sucho stan bez zmian', async () => {
    await otwarteBezZnacznika('542')
    const teraz = min(24 * 60)
    const sucho = await przelicz(db, { now: teraz })
    expect(sucho).toMatchObject({ kandydaciOtwarte: 1, oznaczone: [], oznaczoneZwolnione: ['542'] })
    expect((await stockOf(db, a)).reserved).toBe(2)

    const r = await przelicz(db, { now: teraz, naSucho: false })
    expect(r).toMatchObject({ oznaczone: [], oznaczoneZwolnione: ['542'], bledy: [] })
    const o = await zamowienie('542')
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', stockReleasedAt: teraz })
    expect(flagi(o).nieudanaPlatnoscOnline).toBe(true)
    expect((await stockOf(db, a)).reserved).toBe(0)
    await expectInvariants(db)
    expect(await przelicz(db, { now: teraz, naSucho: false })).toMatchObject({ kandydaciOtwarte: 0 })
  })

  it('przeliczenie starego zamówienia wieczorem: mail następnego ranka o 9:00, nie w ciągu kilku minut', async () => {
    await otwarteBezZnacznika('561')
    const wieczorem = new Date('2026-10-17T19:40:00.000Z') // sobota 21:40 w Warszawie
    const r = await przelicz(db, { now: wieczorem, naSucho: false })
    expect(r).toMatchObject({ oznaczoneZwolnione: ['561'], bledy: [] })
    const o = await zamowienie('561')
    const niedziela9 = new Date('2026-10-18T07:00:00.000Z')
    expect(o.remindAt!.toISOString()).toBe(niedziela9.toISOString())
    expect((await runReservationExpiry(db, { now: new Date(wieczorem.getTime() + 5 * 60_000) })).reminders).toBe(0)
    await planujAkcje(db, { now: new Date(wieczorem.getTime() + 6 * 60_000) })
    expect(await planyMaila()).toHaveLength(0)
    expect((await runReservationExpiry(db, { now: poMinucie(niedziela9) })).reminders).toBe(1)
    await planujAkcje(db, { now: poMinucie(niedziela9) })
    expect(await planyMaila()).toMatchObject([{ targetId: o.id, state: 'PLANNED' }])
  })

  it('częściowo opłacone z kopią failed: znacznik bez wcześniejszego przypomnienia (zwykły mail w zwykłym terminie)', async () => {
    const id = await otwarteBezZnacznika('562')
    await db.order.update({ where: { id }, data: { paymentState: 'PARTIAL' } })
    const przed = await zamowienie('562')
    await przelicz(db, { now: min(60), naSucho: false })
    const o = await zamowienie('562')
    expect(flagi(o).nieudanaPlatnoscOnline).toBe(true)
    expect(o.remindAt!.toISOString()).toBe(przed.remindAt!.toISOString())
  })

  it('raport: przy każdym numerze metoda wg tytułu (bez potwierdzonego identyfikatora), data złożenia i wiek w dniach', async () => {
    await otwarteBezZnacznika('571')
    const teraz = min(3 * 24 * 60 + 30)
    const w = await przelicz(db, { now: teraz })
    expect(w.zamowienia['571']).toEqual({ metoda: 'Płatność online', zlozone: T0 })
    const opis = opisNieudanychPlatnosciWoo(w, teraz)
    expect(opis).toContain('571 (metoda wg tytułu: „Płatność online”, nie potwierdzono identyfikatora; złożone 15.10.2026, 10:00, 3 dn.)')
    expect(opis).toContain('identyfikatora metody kopia nie przechowuje')
    expect(opis).toContain('NA SUCHO')
    expect(opis).not.toContain('UWAGA')
  })

  it('odczyt sklepu starszy niż 15 min: na sucho ostrzeżenie, zapis odmówiony (wynik jak na sucho, nic nie zmienione)', async () => {
    await otwarteBezZnacznika('572')
    const teraz = min(60)
    await udanyOdczytKonta(db, 'WOO', 'sd', new Date(teraz.getTime() - 16 * 60_000))
    const sucho = await przeliczNieudanePlatnosciWoo(db, { now: teraz })
    expect(sucho.odmowa).toBeNull()
    expect(sucho.swiezosc).toEqual([{ konto: 'sd', ostatniOdczyt: new Date(teraz.getTime() - 16 * 60_000), stary: true }])
    expect(opisNieudanychPlatnosciWoo(sucho, teraz)).toContain('UWAGA: ostatni udany odczyt zamówień konta sd')

    const r = await przeliczNieudanePlatnosciWoo(db, { now: teraz, naSucho: false })
    expect(r).toMatchObject({ naSucho: true, oznaczone: ['572'] })
    expect(r.odmowa).toContain('starszy niż 15 min')
    expect(opisNieudanychPlatnosciWoo(r, teraz)).toContain('ODMOWA ZAPISU')
    expect(flagi(await zamowienie('572')).nieudanaPlatnoscOnline).not.toBe(true)

    // konto bez żadnego udanego odczytu: też odmowa
    await db.channelCursor.deleteMany({})
    expect((await przeliczNieudanePlatnosciWoo(db, { now: teraz, naSucho: false })).odmowa).toContain('konto sd')
    // świeży odczyt: zapis idzie
    const ok = await przelicz(db, { now: teraz, naSucho: false })
    expect(ok).toMatchObject({ naSucho: false, odmowa: null, oznaczone: ['572'] })
  })

  it('opłacone i przelew tradycyjny (on-hold) pominięte, zamówienie z kopią failed już ze znacznikiem też', async () => {
    await otwarteBezZnacznika('551', { status: 'processing', paid: min(9) })
    // przelew tradycyjny: kopia on-hold, nie failed
    await handleChannelOrder(db, acc, woo('552', 'on-hold', min(10), { metoda: 'bacs' }), min(11))
    // przyjęte już ze znacznikiem
    await handleChannelOrder(db, acc, woo('553', 'failed', min(10)), min(11))
    const przed = await db.order.findMany({ orderBy: { externalId: 'asc' } })
    const r = await przelicz(db, { now: min(24 * 60), naSucho: false })
    expect(r).toMatchObject({ kandydaciOtwarte: 0, oznaczone: [], oznaczoneZwolnione: [], bledy: [] })
    const po = await db.order.findMany({ orderBy: { externalId: 'asc' } })
    expect(po.map((o) => [o.externalId, o.status, o.paymentState, o.stockReleaseAt, o.flags])).toEqual(przed.map((o) => [o.externalId, o.status, o.paymentState, o.stockReleaseAt, o.flags]))
  })
})
