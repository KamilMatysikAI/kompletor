// zamówienie odczytane z kanału w trakcie zapisu (bez linii wysyłki, pozycje po 0 zł) dostaje sposób dostawy
// i przewoźnika z reguł firmy przy kolejnym odczycie: z nowej rewizji, z kopii kanału (zamówienia sprzed poprawki) albo
// z ponownego odczytu świeżego zamówienia, i wychodzi z „Do wyjaśnienia”, gdy brak dostawy był jedynym powodem.
// Przewoźnik wybrany ręcznie, inne powody wstrzymania i zwykłe zamówienia zostają bez zmian. Dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import type { ChannelOrder } from '@/lib/adaptery/kontrakt'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { PONOWNY_ODCZYT_DOSTAWY_MIN, pollAccount, uzupelnijPusteDostawy } from '@/lib/cien/odczyt-zamowien'
import { opisZdarzenia } from '@/lib/karta/historia'
import { odswiezOpisZKanalu } from '@/lib/karta/opis-z-kanalu'
import { clarifyReasons, flagsOf } from '@/lib/rdzen/rezerwacja'
import { clarifyOrder, type IncomingOrder, ingestOrder, resolveClarification, ZDARZENIE_DOSTAWY_Z_KANALU } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, offer, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const zamowienie = (id: string) => db.order.findUniqueOrThrow({ where: { id } })
const zdarzenia = (id: string) => db.orderEvent.findMany({ where: { orderId: id, kind: ZDARZENIE_DOSTAWY_Z_KANALU } })

let rew = 0
/** Pierwszy odczyt w trakcie zapisu w sklepie: bez sposobu dostawy, pozycja po 0 zł, nieopłacone. */
async function wBudowie(over: Parameters<typeof order>[1] = {}, offerId = '801') {
  if (!(await db.channelOffer.count({ where: { externalId: '801' } }))) await offer(db, 'WOO_SD', '801', await product(db, 'A', 10))
  rew = 0
  const o1 = order([{ offerExternalId: offerId, qty: 1, unitPriceGross: 0, externalLineId: 'L1' }], {
    paymentState: 'UNPAID',
    paymentMethod: 'Przelew bankowy',
    totalGross: 11.3,
    deliveryMethod: null,
    shippingCostGross: null,
    externalRevision: '2026-11-23T19:02:08.000Z',
    ...over,
  })
  const r = await ingestOrder(db, o1, { now: T0 })
  return { o1, orderId: r.orderId! }
}

/** Kolejna rewizja: sklep dopisał wysyłkę i cenę, klient zapłacił. */
const rewizja = (o1: IncomingOrder, over: Partial<IncomingOrder> = {}): IncomingOrder => ({
  ...o1,
  externalRevision: `2026-11-23T19:03:${String(++rew).padStart(2, '0')}.000Z`,
  paymentState: 'PAID',
  deliveryMethod: 'Paczkomaty InPost (Darmowa wysyłka)',
  shippingCostGross: 0,
  lines: o1.lines.map((l) => ({ ...l, unitPriceGross: 11.3 })),
  ...over,
})

describe('rewizja z kanału uzupełnia pusty sposób dostawy', () => {
  it('przyjęte bez dostawy, rewizja z dostawą i wpłatą: sposób, przewoźnik z reguł, status do realizacji, wpis w historii', async () => {
    const { o1, orderId } = await wBudowie()
    const przed = await zamowienie(orderId)
    expect(przed).toMatchObject({ status: 'DO_WYJASNIENIA', carrier: 'BRAK', deliveryMethod: null })
    expect(clarifyReasons(flagsOf(przed))).toEqual(['nieznana metoda dostawy: (brak)'])

    const r = await ingestOrder(db, rewizja(o1), { now: T0 })
    expect(r.status).toBe('DO_REALIZACJI')
    const po = await zamowienie(orderId)
    expect(po).toMatchObject({ status: 'DO_REALIZACJI', statusBeforeClarify: null, carrier: 'PACZKOMATY', shippingModule: 'BASE_COURIER', deliveryMethod: 'Paczkomaty InPost (Darmowa wysyłka)', paymentState: 'PAID' })
    expect(po.shippingCostGross?.toFixed(2)).toBe('0.00')
    expect(clarifyReasons(flagsOf(po))).toEqual([])
    expect(flagsOf(po).doWyjasnienia).toBeNull()
    const ev = await zdarzenia(orderId)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actorId: 'system:test', data: { sposob: 'Paczkomaty InPost (Darmowa wysyłka)', przewoznik: 'PACZKOMATY', modul: 'BASE_COURIER', zStatusu: 'DO_WYJASNIENIA', status: 'DO_REALIZACJI' } })
    expect(opisZdarzenia(ev[0]!.kind, ev[0]!.data)).toMatch(/^Sposób dostawy uzupełniony ze sklepu: Paczkomaty InPost \(Darmowa wysyłka\), przewoźnik .+, status /)

    // kolejna rewizja z tym samym sposobem: bez drugiego wpisu i bez zmian
    await ingestOrder(db, rewizja(o1), { now: T0 })
    expect(await zdarzenia(orderId)).toHaveLength(1)
    expect((await zamowienie(orderId)).status).toBe('DO_REALIZACJI')
    await expectInvariants(db)
  })

  it('nieopłacone: wychodzi do Nowych', async () => {
    const { o1, orderId } = await wBudowie()
    await ingestOrder(db, rewizja(o1, { paymentState: 'UNPAID', deliveryMethod: 'Kurier DPD' }), { now: T0 })
    expect(await zamowienie(orderId)).toMatchObject({ status: 'NOWE', carrier: 'DPD', deliveryMethod: 'Kurier DPD' })
    await expectInvariants(db)
  })

  it('sposób nieznany regułom firmy: zapisany, powód z nazwą sposobu, dalej „Do wyjaśnienia”', async () => {
    const { o1, orderId } = await wBudowie()
    await ingestOrder(db, rewizja(o1, { deliveryMethod: 'Transport własny sprzedawcy' }), { now: T0 })
    const po = await zamowienie(orderId)
    expect(po).toMatchObject({ status: 'DO_WYJASNIENIA', carrier: 'BRAK', deliveryMethod: 'Transport własny sprzedawcy', statusBeforeClarify: 'DO_REALIZACJI' })
    expect(clarifyReasons(flagsOf(po))).toEqual(['nieznana metoda dostawy: Transport własny sprzedawcy'])
    // zmiana z niepustej na inną (także znaną regułom): bez zmian, jak
    await ingestOrder(db, rewizja(o1, { deliveryMethod: 'Kurier DPD' }), { now: T0 })
    expect(await zamowienie(orderId)).toMatchObject({ carrier: 'BRAK', deliveryMethod: 'Transport własny sprzedawcy' })
    expect(await zdarzenia(orderId)).toHaveLength(1)
  })

  it('wstrzymane także z innego powodu (niezmapowana oferta, ręcznie): dostawa uzupełniona, zamówienie zostaje w „Do wyjaśnienia”', async () => {
    const a = await wBudowie({}, '899') // oferta bez powiązania z produktem
    expect(clarifyReasons(flagsOf(await zamowienie(a.orderId)))).toEqual(['niezmapowana oferta', 'nieznana metoda dostawy: (brak)'])
    await ingestOrder(db, rewizja(a.o1), { now: T0 })
    const pa = await zamowienie(a.orderId)
    expect(pa).toMatchObject({ status: 'DO_WYJASNIENIA', carrier: 'PACZKOMATY', deliveryMethod: 'Paczkomaty InPost (Darmowa wysyłka)' })
    expect(clarifyReasons(flagsOf(pa))).toEqual(['niezmapowana oferta'])

    const b = await wBudowie()
    expect(await clarifyOrder(db, b.orderId, 'ręcznie: klient prosi o wstrzymanie', { allowed: ['DO_WYJASNIENIA'], actorId: 'user:test' })).toBe(true)
    await ingestOrder(db, rewizja(b.o1), { now: T0 })
    const pb = await zamowienie(b.orderId)
    expect(pb).toMatchObject({ status: 'DO_WYJASNIENIA', carrier: 'PACZKOMATY' })
    expect(clarifyReasons(flagsOf(pb))).toEqual(['ręcznie: klient prosi o wstrzymanie'])
    await expectInvariants(db)
  })

  it('przewoźnik wybrany ręcznie przy wyjaśnieniu: rewizja z kanału go nie nadpisuje', async () => {
    const { o1, orderId } = await wBudowie()
    await resolveClarification(db, orderId, { carrier: 'DPD', actorId: 'user:test' })
    expect(await zamowienie(orderId)).toMatchObject({ status: 'NOWE', carrier: 'DPD', deliveryMethod: null })
    await ingestOrder(db, rewizja(o1), { now: T0 })
    const po = await zamowienie(orderId)
    expect(po).toMatchObject({ status: 'DO_REALIZACJI', carrier: 'DPD', deliveryMethod: null })
    expect(await zdarzenia(orderId)).toHaveLength(0)
    await expectInvariants(db)
  })

  it('regresja: zwykłe zamówienie z dostawą — rewizja z innym sposobem nic nie zmienia w dostawie', async () => {
    await offer(db, 'WOO_SD', '801', await product(db, 'A', 10))
    const o1 = order([{ offerExternalId: '801', qty: 1, unitPriceGross: 20, externalLineId: 'L1' }], { paymentState: 'PAID', totalGross: 20, externalRevision: '2026-11-23T19:00:00.000Z' })
    const r = await ingestOrder(db, o1, { now: T0 })
    expect(r.status).toBe('DO_REALIZACJI')
    await ingestOrder(db, { ...o1, externalRevision: '2026-11-23T19:05:00.000Z', deliveryMethod: 'Kurier DPD' }, { now: T0 })
    expect(await zamowienie(r.orderId!)).toMatchObject({ status: 'DO_REALIZACJI', carrier: 'PACZKOMATY', deliveryMethod: 'Paczkomaty InPost' })
    expect(await zdarzenia(r.orderId!)).toHaveLength(0)
    await expectInvariants(db)
  })
})

describe('zamówienia już w tym stanie (bez nowej rewizji)', () => {
  const T = new Date('2026-11-23T19:30:00.000Z')
  const at = (minuty: number) => new Date(T.getTime() + minuty * 60_000)

  async function kanalWBudowie(createdAt: Date) {
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
    await offer(db, 'WOO_SD', '801', await product(db, 'A', 10))
    const state = new FakeChannelState()
    const wBud: ChannelOrder = fakeOrder({
      externalId: '9001',
      createdAt,
      revision: createdAt.toISOString(),
      channelStatus: 'on-hold',
      statusRank: 10,
      paymentState: 'UNPAID',
      totalGross: 11.3,
      deliveryMethod: null,
      shippingCostGross: null,
      lines: [{ externalLineId: 'L1', offerExternalId: '801', qty: 1, unitPriceGross: 0, vatRate: '23' }],
    })
    state.upsertOrder(wBud)
    const registry = new AdapterRegistry([fakeDefinition(state, 'WOO', 'fake.v1')])
    const acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    const deps = { registry, secrets: { env: {}, envFallback: false } }
    /** Sklep dokończył zapis z tą samą datą zmiany: dziennik zmian zamówienia drugi raz nie zwróci. */
    const dokonczZapis = () => state.orders.set('9001', { ...wBud, deliveryMethod: 'DPD Pickup', shippingCostGross: 0, lines: [{ ...wBud.lines[0]!, unitPriceGross: 11.3 }] })
    return { state, acc, deps, dokonczZapis }
  }
  const orderId9001 = async () => (await db.order.findFirstOrThrow({ where: { externalId: '9001' } })).id

  it('świeże zamówienie: następny zwykły odczyt czyta je z kanału ponownie i uzupełnia dostawę oraz cenę', async () => {
    const { acc, deps, dokonczZapis } = await kanalWBudowie(at(0))
    await pollAccount(db, acc, { ...deps, now: () => at(0) })
    const id = await orderId9001()
    expect(await zamowienie(id)).toMatchObject({ status: 'DO_WYJASNIENIA', carrier: 'BRAK', deliveryMethod: null })
    dokonczZapis()
    const stats = await pollAccount(db, acc, { ...deps, now: () => at(1) })
    expect(stats.items).toBe(0) // dziennik zmian pusty: naprawa idzie ponownym odczytem
    const po = await zamowienie(id)
    expect(po).toMatchObject({ status: 'NOWE', carrier: 'DPD', deliveryMethod: 'DPD Pickup' })
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).unitPriceGross.toFixed(2)).toBe('11.30')
    expect(await zdarzenia(id)).toHaveLength(1)
    expect((await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: '9001' } })).deliveryMethod).toBe('DPD Pickup')
    await expectInvariants(db)
  })

  it('starsze niż okno ponownego odczytu: bez odczytu z kanału; „Odśwież z kanału” na karcie naprawia', async () => {
    const { acc, deps, dokonczZapis } = await kanalWBudowie(at(0))
    await pollAccount(db, acc, { ...deps, now: () => at(0) })
    const id = await orderId9001()
    dokonczZapis()
    let odczyty = 0
    const n = await uzupelnijPusteDostawy(db, acc, () => at(PONOWNY_ODCZYT_DOSTAWY_MIN + 1), async () => {
      odczyty++
      return null
    })
    expect(n).toBe(0)
    expect(odczyty).toBe(0)
    expect((await zamowienie(id)).carrier).toBe('BRAK')

    const w = await odswiezOpisZKanalu(db, id, { ...deps, actorId: 'user:test' })
    expect(w).toMatchObject({ wynik: 'OK' })
    expect(await zamowienie(id)).toMatchObject({ status: 'NOWE', carrier: 'DPD', deliveryMethod: 'DPD Pickup' })
    expect((await zdarzenia(id))[0]).toMatchObject({ actorId: 'user:test' })
    await expectInvariants(db)
  })

  it('kopia z kanału ma już dostawę (rewizja przyjęta przed poprawką): zwykły odczyt uzupełnia z kopii, bez odczytu kanału', async () => {
    const { acc, deps } = await kanalWBudowie(at(-120))
    await pollAccount(db, acc, { ...deps, now: () => at(0) })
    const id = await orderId9001()
    await db.channelOrderSnapshot.updateMany({ where: { externalId: '9001' }, data: { deliveryMethod: 'Paczkomaty InPost' } })
    let odczyty = 0
    const n = await uzupelnijPusteDostawy(db, acc, () => at(5), async () => {
      odczyty++
      return null
    })
    expect(n).toBe(1)
    expect(odczyty).toBe(0)
    expect(await zamowienie(id)).toMatchObject({ status: 'NOWE', carrier: 'PACZKOMATY', deliveryMethod: 'Paczkomaty InPost' })
    // drugi przebieg: nic do zrobienia
    expect(await uzupelnijPusteDostawy(db, acc, () => at(6), async () => null)).toBe(0)
    expect(await zdarzenia(id)).toHaveLength(1)
    await expectInvariants(db)
  })
})
