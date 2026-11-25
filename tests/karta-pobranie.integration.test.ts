// Zmiana płatności z karty zamówienia: „Zmień na pobranie” i „Zmień na nieopłacone (przelew)”. Rdzeń płatności
// (status, terminy, rezerwacje), odczyt z kanału po zmianie, kwota pobrania w przesyłce po edycji pozycji, blokady
// z powodem, historia i dziennik zmian, widok karty. Dane fikcyjne, zero połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import { przebiegZapisuKanalow, zaplanujZapisy, zapiszMapeStatusow } from '@/lib/kanaly/zapis-host'
import { daneKarty } from '@/lib/karta/dane'
import { POWODY_ZMIANY_PLATNOSCI as P, zmienPlatnosc, type KierunekZmiany } from '@/lib/karta/pobranie'
import { AUDIT_PLATNOSC } from '@/lib/karta/platnosci'
import { addOrderLine } from '@/lib/rdzen/edycja'
import { getPolicy, termsFor } from '@/lib/rdzen/polityka'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { ingestOrder, markPaid, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { prepareForOrder } from '@/lib/wysylka/podglad'
import { testDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const ENV = { EKRANY_PRACA: '1' }
const WLASCICIEL = permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] })
const BIURO = permissionsOf({ role: 'BIURO', permissions: [], deniedPermissions: [] })
const DPD = 'Kurier DPD'
const T1 = new Date(T0.getTime() + 2 * 3600_000)

async function praca(): Promise<void> {
  await db.channelConfig.updateMany({ data: { statusMode: 'PRACA' } })
}

const zmien = (id: string, kierunek: KierunekZmiany, uprawnienia = WLASCICIEL, now = T1) => zmienPlatnosc(db, { orderId: id, kierunek, userId: 'u-test', uprawnienia }, ENV, now)

async function przelew(over: Parameters<typeof order>[1] = {}) {
  const pid = await product(db, `PB-${Math.random().toString(36).slice(2, 8)}`, 20)
  const inc = order([{ productId: pid, qty: 2, unitPriceGross: 25 }], { deliveryMethod: DPD, paymentState: 'UNPAID', paymentMethod: 'Przelew bankowy', totalGross: 62.99, shippingCostGross: 12.99, ...over })
  const id = (await ingestOrder(db, inc, { now: T0 })).orderId!
  return { id, inc, pid }
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('Zmień na pobranie', () => {
  it('nieopłacone → pobranie: do realizacji, bez przypomnienia i terminów, historia z autorem, dziennik, karta „Do zapłaty przy odbiorze”', async () => {
    await praca()
    const { id } = await przelew()
    const przed = await db.order.findUniqueOrThrow({ where: { id } })
    expect(przed).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID' })
    expect(przed.remindAt).not.toBeNull()
    expect(przed.reservationDeadline).not.toBeNull()

    expect(await zmien(id, 'NA_POBRANIE')).toEqual({ blad: null, zmiana: true })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'COD', remindAt: null, reservationDeadline: null, stockReleaseAt: null })
    expect(flagsOf(o).platnoscZKarty).toBe('COD')
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'PLATNOSC_NA_POBRANIE' } })
    expect(ev.actorId).toBe('user:u-test')
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'OPLACONE' } })).toBe(0) // pobranie to nie wpłata (automaty bez „opłacono”)
    const audit = await db.auditLog.findFirstOrThrow({ where: { entity: AUDIT_PLATNOSC, entityId: id } })
    expect(audit).toMatchObject({ actorId: 'user:u-test', before: { platnosc: 'UNPAID', status: 'NOWE' }, after: { platnosc: 'COD', status: 'DO_REALIZACJI', kwota: '62.99' } })
    expect(await zmien(id, 'NA_POBRANIE')).toEqual({ blad: null, zmiana: false }) // podwójne kliknięcie

    const d = await daneKarty(db, id, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV })
    expect(d!.platnosc).toMatchObject({ pobranie: true, zaplaconoGr: 0, zamowienieGr: 6299, pokaz: false, zmiana: { kierunek: 'NA_NIEOPLACONE', powod: null } })
    await expectInvariants(db)
  })

  it('kolejny odczyt ze sklepu („przelew, nieopłacone”, potem opłacone) nie cofa pobrania i nie wraca przypomnień', async () => {
    await praca()
    const { id, inc } = await przelew()
    await zmien(id, 'NA_POBRANIE')
    await ingestOrder(db, { ...inc, externalRevision: '2' }, { now: T1 })
    let o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ paymentState: 'COD', status: 'DO_REALIZACJI', remindAt: null, reservationDeadline: null })
    await ingestOrder(db, { ...inc, externalRevision: '3', paymentState: 'PAID' }, { now: T1 })
    o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o.paymentState).toBe('COD')
    // termin anulowania nieopłaconego minął: pobranie nie wygasa
    await runReservationExpiry(db, { now: new Date(T0.getTime() + 60 * 86400_000) })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
  })

  it('kwota pobrania w przesyłce = bieżąca kwota zamówienia, także po edycji pozycji na karcie; bez ostrzeżenia „z nazwy metody”', async () => {
    await praca()
    const { id, pid } = await przelew()
    await zmien(id, 'NA_POBRANIE')
    let r = await prepareForOrder(db, id)
    expect(r.wynik).toBe('przygotowane')
    if (r.wynik !== 'przygotowane') return
    expect(r.parcel.codAmount).toBe(62.99)
    expect(r.parcel.problems.map((p) => p.kod)).not.toContain('pobranie_z_metody')
    await addOrderLine(db, id, { productId: pid, qty: 1, priceGrossGr: 1000 }, { actorId: 'user:u-test', now: T1 })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(Number(o.totalGross)).toBe(72.99)
    r = await prepareForOrder(db, id)
    expect(r.wynik === 'przygotowane' && r.parcel.codAmount).toBe(72.99)
  })

  it('blokady z powodem: opłacone, częściowo opłacone, anulowane, Allegro, odbiór osobisty, przesyłka, faktura, wpłaty; uprawnienie i tryb podglądu', async () => {
    const { id: cien } = await przelew()
    expect((await zmien(cien, 'NA_POBRANIE')).blad).toMatch(/tylko dla kont w trybie PRACA/)
    await praca()
    expect((await zmien(cien, 'NA_POBRANIE', BIURO)).blad).toMatch(/uprawnienia/)

    const { id: oplacone } = await przelew({ paymentState: 'PAID' })
    expect((await zmien(oplacone, 'NA_POBRANIE')).blad).toBe(P.oplacone)
    const { id: czesc } = await przelew({ paymentState: 'PARTIAL' })
    expect((await zmien(czesc, 'NA_POBRANIE')).blad).toBe(P.czesciowo)
    const { id: anul } = await przelew({ cancelled: true })
    expect((await zmien(anul, 'NA_POBRANIE')).blad).toBe(P.anulowane)
    const { id: allegro } = await przelew({ channel: 'ALLEGRO', deliveryMethod: 'Allegro One Box' })
    expect((await zmien(allegro, 'NA_POBRANIE')).blad).toBe(P.kanal)
    const { id: osobisty } = await przelew()
    await db.order.update({ where: { id: osobisty }, data: { carrier: 'OSOBISTY', shippingModule: 'BRAK' } })
    expect((await zmien(osobisty, 'NA_POBRANIE')).blad).toBe(P.osobisty)
    const { id: orlen } = await przelew()
    await db.order.update({ where: { id: orlen }, data: { carrier: 'ORLEN_PACZKA', shippingModule: 'ORLEN_PACZKA' } })
    expect((await zmien(orlen, 'NA_POBRANIE')).blad).toMatch(/nie obsługuje pobrania/)

    const { id: zPaczka } = await przelew()
    await db.shipment.create({ data: { orderId: zPaczka, packageNo: 1, reference: 'ref-pb-1', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', state: 'UTWORZONA' } })
    expect((await zmien(zPaczka, 'NA_POBRANIE')).blad).toBe(P.przesylka)
    const { id: zFaktura } = await przelew()
    await db.invoiceAttempt.create({ data: { orderId: zFaktura, packageNo: 1, attemptNo: 1, idExternal: `${zFaktura}/1/1`, state: 'ISSUED' } })
    expect((await zmien(zFaktura, 'NA_POBRANIE')).blad).toBe(P.dokument)
    const { id: zWplata } = await przelew()
    await db.orderPayment.create({ data: { orderId: zWplata, kind: 'DOPLATA', amount: '10.00', method: 'przelew', paidAt: T0, actorId: 'user:u-test' } })
    expect((await zmien(zWplata, 'NA_POBRANIE')).blad).toBe(P.wplaty)

    for (const id of [oplacone, czesc, allegro, osobisty, orlen, zPaczka, zFaktura, zWplata]) expect((await db.order.findUniqueOrThrow({ where: { id } })).paymentState).not.toBe('COD')
    // karta: przycisk nieaktywny z tym samym powodem
    const d = await daneKarty(db, oplacone, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV })
    expect(d!.platnosc.zmiana).toEqual({ kierunek: 'NA_POBRANIE', powod: P.oplacone })
  })
})

describe('Zmień na nieopłacone (przelew)', () => {
  it('pobranie ze sklepu → nieopłacone: „Nowe”, terminy od chwili zmiany; kolejny odczyt „pobranie” nie przywraca, wpłata z kanału przechodzi', async () => {
    await praca()
    const { id, inc } = await przelew({ paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
    expect(await zmien(id, 'NA_NIEOPLACONE')).toEqual({ blad: null, zmiana: true })
    let o = await db.order.findUniqueOrThrow({ where: { id } })
    const terms = termsFor(T1, await getPolicy(db))
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID', remindAt: terms.remindAt, reservationDeadline: terms.reservationDeadline, reminderSentAt: null })
    expect(flagsOf(o).platnoscZKarty).toBe('UNPAID')
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'PLATNOSC_POBRANIE_COFNIETE', actorId: 'user:u-test' } })).toBe(1)
    expect(await db.auditLog.count({ where: { entity: AUDIT_PLATNOSC, entityId: id } })).toBe(1)
    expect(await zmien(id, 'NA_NIEOPLACONE')).toEqual({ blad: null, zmiana: false })

    await ingestOrder(db, { ...inc, externalRevision: '2' }, { now: T1 })
    o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ paymentState: 'UNPAID', status: 'NOWE' })
    await ingestOrder(db, { ...inc, externalRevision: '3', paymentState: 'PAID' }, { now: T1 })
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ paymentState: 'PAID', status: 'DO_REALIZACJI' })
    await expectInvariants(db)
  })

  it('w drugą stronę i z powrotem: pobranie ustawione na karcie da się cofnąć, karta pokazuje właściwy kierunek', async () => {
    await praca()
    const { id } = await przelew()
    await zmien(id, 'NA_POBRANIE')
    await zmien(id, 'NA_NIEOPLACONE')
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ paymentState: 'UNPAID', status: 'NOWE' })
    const d = await daneKarty(db, id, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV })
    expect(d!.platnosc.zmiana).toEqual({ kierunek: 'NA_POBRANIE', powod: null })
    expect(d!.platnosc.pobranie).toBe(false)
  })

  it('blokady: zbierane albo dalej, przesyłka utworzona', async () => {
    await praca()
    const { id } = await przelew({ paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: 'ref-pb-2', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', state: 'TWORZENIE', codAmount: 62.99 } })
    expect((await zmien(id, 'NA_NIEOPLACONE')).blad).toBe(P.przesylka)
    const { id: zbierane } = await przelew({ paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    await db.order.update({ where: { id: zbierane }, data: { status: 'ZBIERANIE' } })
    expect((await zmien(zbierane, 'NA_NIEOPLACONE')).blad).toBe(P.etapNaNieoplacone)
    expect((await db.order.findUniqueOrThrow({ where: { id: zbierane } })).paymentState).toBe('COD')
  })
})

describe('rezerwacja i braki przy cofnięciu pobrania', () => {
  it('„Nowe” z rezerwacją i brakiem: po pobraniu i cofnięciu stan jak przy zwykłym nieopłaconym (rezerwacje, braki, znacznik braku)', async () => {
    await praca()
    const stan = async (id: string) => {
      const o = await db.order.findUniqueOrThrow({ where: { id } })
      const rez = await db.reservation.findMany({ where: { orderId: id }, select: { state: true, qtyBase: true } })
      const braki = await db.shortage.findMany({ where: { orderId: id }, select: { state: true, qtyBase: true } })
      return { status: o.status, paymentState: o.paymentState, brakuje: flagsOf(o).brakuje === true, shortageWaitUntil: o.shortageWaitUntil, stockReleaseAt: o.stockReleaseAt, rez, braki }
    }
    // 3 sztuki, na stanie 2: rezerwacja 2 i brak 1
    const nowe = async () => {
      const pid = await product(db, `PB-${Math.random().toString(36).slice(2, 8)}`, 2)
      return (await ingestOrder(db, order([{ productId: pid, qty: 3, unitPriceGross: 25 }], { deliveryMethod: DPD, paymentState: 'UNPAID', paymentMethod: 'Przelew bankowy', totalGross: 87.99, shippingCostGross: 12.99 }), { now: T0 })).orderId!
    }
    // wzorzec: zwykłe nieopłacone zamówienie z tym samym brakiem
    const wzorzec = await stan(await nowe())
    expect(wzorzec).toMatchObject({ status: 'NOWE', brakuje: true })
    expect(wzorzec.braki).toEqual([{ state: 'OPEN', qtyBase: 1 }])

    const id = await nowe()
    expect(await zmien(id, 'NA_POBRANIE')).toEqual({ blad: null, zmiana: true })
    expect(await stan(id)).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'COD', rez: wzorzec.rez, braki: wzorzec.braki, brakuje: true })
    expect(await zmien(id, 'NA_NIEOPLACONE')).toEqual({ blad: null, zmiana: true })
    expect(await stan(id)).toEqual(wzorzec)
    await expectInvariants(db)
  })
})

describe('przywrócenie w kanale po anulowaniu', () => {
  it('pobranie ustawione na karcie zostaje, gdy sklep anuluje i przywraca zamówienie („przelew, nieopłacone”)', async () => {
    await praca()
    const { id, inc } = await przelew({ source: 'poll:WOO:sd' })
    await zmien(id, 'NA_POBRANIE')
    await ingestOrder(db, { ...inc, externalRevision: '2', eventKey: undefined, cancelled: true }, { now: T1 })
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ANULOWANE', cancelReason: 'CANCELLED' })
    await ingestOrder(db, { ...inc, externalRevision: '3', eventKey: undefined, cancelled: false }, { now: T1 })
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'COD', remindAt: null, reservationDeadline: null })
    await expectInvariants(db)
  })

  it('pobranie cofnięte na karcie zostaje nieopłacone, gdy sklep anuluje i przywraca zamówienie („pobranie”); wpłata dalej przechodzi', async () => {
    await praca()
    const { id, inc } = await przelew({ source: 'poll:WOO:sd', paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    await zmien(id, 'NA_NIEOPLACONE')
    await ingestOrder(db, { ...inc, externalRevision: '2', eventKey: undefined, cancelled: true }, { now: T1 })
    await ingestOrder(db, { ...inc, externalRevision: '3', eventKey: undefined, cancelled: false }, { now: T1 })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ status: 'NOWE', paymentState: 'UNPAID' })
    expect(o.reservationDeadline).not.toBeNull()
    await ingestOrder(db, { ...inc, externalRevision: '4', eventKey: undefined, paymentState: 'PAID' }, { now: T1 })
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID' })
    await expectInvariants(db)
  })
})

describe('zapis statusu do sklepu', () => {
  const SD = { channel: 'WOO' as const, channelAccountId: 'sd' }
  let stanKanalu: FakeChannelState
  let registry: AdapterRegistry
  const ctx = () => ({ registry, secrets: { env: {}, envFallback: false }, now: T1 })
  async function kontoZZapisem() {
    stanKanalu = new FakeChannelState()
    registry = new AdapterRegistry([fakeDefinition(stanKanalu, 'WOO')])
    await db.channelConfig.updateMany({ where: SD, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', config: { zapisWlaczony: true } } })
    await zapiszMapeStatusow(db, SD, { status_DO_REALIZACJI: 'processing' }, { registry, actorId: 'test' })
  }
  const wiersze = (orderId: string) => db.channelWrite.findMany({ where: { orderId }, select: { kind: true, key: true, channelStatus: true, mode: true, state: true } })

  it('„Nowe” → „Do realizacji” po zmianie na pobranie planuje ten sam zapis statusu co po wpłacie', async () => {
    await praca()
    await kontoZZapisem()
    const { id: pobranie } = await przelew()
    const { id: wplata } = await przelew()
    await zmien(pobranie, 'NA_POBRANIE')
    await markPaid(db, wplata, 'PAID', { now: T1 })
    await zaplanujZapisy(db, registry, { now: T1 })
    const w = await wiersze(wplata)
    expect(w).toEqual([{ kind: 'STATUS', key: 'DO_REALIZACJI', channelStatus: 'processing', mode: 'PRACA', state: 'OCZEKUJE' }])
    expect(await wiersze(pobranie)).toEqual(w)
  })

  it('cofnięcie pobrania z karty: przed wysłaniem statusu wolno (wiersz pominięty), po wysłaniu nie (sklep podałby zamówienie jako opłacone)', async () => {
    await praca()
    await kontoZZapisem()
    const { id: przed } = await przelew()
    const { id: po } = await przelew()
    await zmien(przed, 'NA_POBRANIE')
    await zaplanujZapisy(db, registry, { now: T1 })
    expect(await zmien(przed, 'NA_NIEOPLACONE')).toEqual({ blad: null, zmiana: true })
    await zmien(po, 'NA_POBRANIE')
    expect(await przebiegZapisuKanalow(db, ctx())).toMatchObject({ pominiete: 1, wyslane: 1 })
    expect(await db.channelWrite.findFirstOrThrow({ where: { orderId: przed } })).toMatchObject({ state: 'WYSLANE', result: 'pominięte: zamówienie poszło dalej' })
    expect(await zmien(po, 'NA_NIEOPLACONE')).toEqual({ blad: P.statusWSklepie, zmiana: false })
    expect((await db.order.findUniqueOrThrow({ where: { id: po } })).paymentState).toBe('COD')
    const d = await daneKarty(db, po, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV })
    expect(d!.platnosc.zmiana).toEqual({ kierunek: 'NA_NIEOPLACONE', powod: P.statusWSklepie })
  })

  it('pobranie ze sklepu (nie z karty): wysłany status nie blokuje cofnięcia, sklep dalej mówi „pobranie”', async () => {
    await praca()
    await kontoZZapisem()
    const { id } = await przelew({ paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    expect((await przebiegZapisuKanalow(db, ctx())).wyslane).toBe(1)
    expect(await zmien(id, 'NA_NIEOPLACONE')).toEqual({ blad: null, zmiana: true })
  })
})
