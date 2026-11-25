// cena pozycji zmieniona w sklepie po przyjęciu zamówienia. Przy otwartych kwotach (bez faktury, wpłaty,
// edycji w Kompletorze, pakowania; jak wartość zamówienia) cena pozycji idzie za kanałem z wpisem w historii,
// a faktura ma właściwe ceny i nic nie ląduje w linii wysyłki. Przy zamkniętych kwotach Kompletor ceny nie zmienia:
// zamówienie idzie do „Do wyjaśnienia” z opisem (raz na zmianę w kanale). Dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { kluczOferty, pozycjeZamowienia, zlozPozycjeDokumentu } from '@/lib/dokumenty/pozycje'
import { odswiezOpisZKanalu } from '@/lib/karta/opis-z-kanalu'
import { changeLinePrice } from '@/lib/rdzen/edycja'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { type IncomingOrder, ingestOrder, resolveClarification, ZDARZENIE_CENY_W_KANALE_INNEJ, ZDARZENIE_CENY_Z_KANALU } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

type Linia = { externalLineId: string; offerExternalId: string; qty: number; unitPriceGross: number }
const linie = (c1: number, c2: number): Linia[] => [
  { externalLineId: 'L1', offerExternalId: '701', qty: 1, unitPriceGross: c1 },
  { externalLineId: 'L2', offerExternalId: '702', qty: 2, unitPriceGross: c2 },
]
// wartość = L1 + 2 × L2 + wysyłka 12,50
const wartosc = (c1: number, c2: number) => Math.round((c1 + 2 * c2 + 12.5) * 100) / 100

let rew = 0
async function przyjete(over: Parameters<typeof order>[1] = {}) {
  if (!(await db.channelOffer.count({ where: { externalId: '701' } }))) {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 10)
    await db.channelOffer.createMany({
      data: [
        { channel: 'WOO', channelAccountId: 'sd', externalId: '701', productId: a },
        { channel: 'WOO', channelAccountId: 'sd', externalId: '702', productId: b },
      ],
    })
  }
  rew = 0
  const o1 = order(linie(61.7, 21.7), { paymentState: 'UNPAID', paymentMethod: 'Przelew bankowy', totalGross: wartosc(61.7, 21.7), shippingCostGross: 12.5, externalRevision: '2026-11-20T10:00:00.000Z', ...over })
  const r = await ingestOrder(db, o1, { now: T0 })
  return { o1, orderId: r.orderId! }
}

/** Nowsza rewizja z kanału z cenami pozycji c1, c2 (wartość policzona przez sklep). */
const rewizja = (o1: IncomingOrder, c1: number, c2: number, over: Partial<IncomingOrder> = {}): IncomingOrder => ({
  ...o1,
  externalRevision: `2026-11-20T10:${String(++rew).padStart(2, '0')}:00.000Z`,
  lines: linie(c1, c2),
  totalGross: wartosc(c1, c2),
  ...over,
})

const ceny = async (orderId: string) =>
  Object.fromEntries((await db.orderLine.findMany({ where: { orderId }, orderBy: { externalLineId: 'asc' } })).map((l) => [l.externalLineId, l.unitPriceGross.toFixed(2)]))
const zamowienie = (id: string) => db.order.findUniqueOrThrow({ where: { id } })
const zdarzenia = (id: string, kind: string) => db.orderEvent.findMany({ where: { orderId: id, kind }, orderBy: { createdAt: 'asc' } })

/** Pozycje faktury z wierszy bazy, tą samą drogą co wFirma i KSeF (`pozycjeZamowienia` → `zlozPozycjeDokumentu`). */
async function dokument(orderId: string) {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } })
  const products = new Map((await db.product.findMany({ include: { bundleComponents: true } })).map((p) => [p.id, p]))
  const offers = new Map((await db.channelOffer.findMany()).map((x) => [kluczOferty(x.channel, x.channelAccountId, x.externalId), x.qtyBasePerOffer]))
  return zlozPozycjeDokumentu({ totalGross: Number(o.totalGross), pozycje: pozycjeZamowienia(o, products, offers), wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' }, towarBezPowiazania: true, kosztWysylki: o.shippingCostGross === null ? null : Number(o.shippingCostGross) })
}

async function kanal(o1: IncomingOrder, c1: number, c2: number) {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })
  const state = new FakeChannelState()
  state.upsertOrder(
    fakeOrder({
      externalId: o1.externalId,
      paymentState: 'UNPAID',
      totalGross: wartosc(c1, c2),
      shippingCostGross: 12.5,
      lines: linie(c1, c2).map((l) => ({ ...l, vatRate: '23' })),
    }),
  )
  return { registry: new AdapterRegistry([fakeDefinition(state, 'WOO', 'fake.v1')]), secrets: { env: {}, envFallback: false } }
}

describe('otwarte kwoty — cena pozycji za kanałem', () => {
  it('podwyżka ceny w sklepie: cena pozycji i wartość z kanału, wpis w historii, faktura bez nadwyżki w wysyłce', async () => {
    const { o1, orderId } = await przyjete()
    const przed = await zamowienie(orderId)
    await ingestOrder(db, rewizja(o1, 71.7, 21.7), { now: T0 })
    expect(await ceny(orderId)).toEqual({ L1: '71.70', L2: '21.70' })
    const po = await zamowienie(orderId)
    expect(po.totalGross.toFixed(2)).toBe('127.60')
    expect(po.status).toBe(przed.status)
    const ev = await zdarzenia(orderId, ZDARZENIE_CENY_Z_KANALU)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actorId: 'system:test', data: { pozycje: [{ pozycja: 'L1', z: '61.70', na: '71.70' }] } })

    const d = await dokument(orderId)
    expect(d.problemy).toEqual([])
    const wysylka = d.linie.filter((l) => l.wysylka)
    expect(wysylka.map((l) => l.bruttoGr)).toEqual([1250])
    expect(d.linie.filter((l) => !l.wysylka).map((l) => l.cenaBruttoGr)).toEqual([7170, 2170])

    // ta sama cena w kolejnej rewizji: bez drugiego wpisu
    await ingestOrder(db, rewizja(o1, 71.7, 21.7), { now: T0 })
    expect(await zdarzenia(orderId, ZDARZENIE_CENY_Z_KANALU)).toHaveLength(1)
    await expectInvariants(db)
  })

  it('obniżka ceny w sklepie: cena pozycji z kanału, faktura bez rabatu rozłożonego na pozycje', async () => {
    const { o1, orderId } = await przyjete()
    await ingestOrder(db, rewizja(o1, 61.7, 11.7), { now: T0 })
    expect(await ceny(orderId)).toEqual({ L1: '61.70', L2: '11.70' })
    const d = await dokument(orderId)
    expect(d.problemy).toEqual([])
    expect(d.linie.filter((l) => !l.wysylka).map((l) => l.cenaBruttoGr)).toEqual([6170, 1170])
    expect(d.linie.filter((l) => l.wysylka).map((l) => l.bruttoGr)).toEqual([1250])
  })

  it('Allegro i Empik: ta sama droga (cena pozycji za kanałem przy otwartych kwotach)', async () => {
    for (const ch of ['ALLEGRO', 'EMPIK'] as const) {
      await truncateAll(db)
      await seedBase(db)
      const a = await product(db, 'A', 10)
      const acc = (await db.channelConfig.findFirstOrThrow({ where: { channel: ch } })).channelAccountId
      await db.channelOffer.create({ data: { channel: ch, channelAccountId: acc, externalId: 'OF1', productId: a } })
      const l = (c: number) => [{ externalLineId: 'P1', offerExternalId: 'OF1', qty: 2, unitPriceGross: c }]
      const o1 = order(l(30), { channel: ch, paymentState: 'UNPAID', paymentMethod: 'przelew', totalGross: 60, shippingCostGross: 0, externalRevision: '1' })
      const { orderId } = await ingestOrder(db, o1, { now: T0 })
      await ingestOrder(db, { ...o1, externalRevision: '2', lines: l(35), totalGross: 70 }, { now: T0 })
      expect(await ceny(orderId!), ch).toEqual({ P1: '35.00' })
      expect((await zamowienie(orderId!)).totalGross.toFixed(2), ch).toBe('70.00')
    }
  })

  it('„Odśwież z kanału” na karcie: cena pozycji poprawiona ze sklepu', async () => {
    const { o1, orderId } = await przyjete()
    const deps = await kanal(o1, 61.7, 25)
    expect((await odswiezOpisZKanalu(db, orderId, { ...deps, actorId: 'user:u-test' })).wynik).toBe('OK')
    expect(await ceny(orderId)).toEqual({ L1: '61.70', L2: '25.00' })
    expect((await zdarzenia(orderId, ZDARZENIE_CENY_Z_KANALU))[0]).toMatchObject({ actorId: 'user:u-test' })
  })
})

describe('zamknięte kwoty — bez cichej zmiany, „Do wyjaśnienia”', () => {
  it('po fakturze: cena bez zmian, zamówienie do wyjaśnienia z opisem, raz na zmianę w kanale', async () => {
    const { o1, orderId } = await przyjete()
    await db.invoiceAttempt.create({ data: { orderId, packageNo: 1, attemptNo: 1, idExternal: `${orderId}/1/1`, state: 'ISSUED', wfirmaDocId: 'FV-TEST-371' } })
    const przed = await zamowienie(orderId)

    await ingestOrder(db, rewizja(o1, 71.7, 21.7), { now: T0 })
    expect(await ceny(orderId)).toEqual({ L1: '61.70', L2: '21.70' })
    let po = await zamowienie(orderId)
    expect(po.totalGross.toFixed(2)).toBe(przed.totalGross.toFixed(2))
    expect(po.status).toBe('DO_WYJASNIENIA')
    expect(po.statusBeforeClarify).toBe(przed.status)
    expect(flagsOf(po).doWyjasnienia).toContain('L1 61,70 zł → 71,70 zł')
    expect(await zdarzenia(orderId, ZDARZENIE_CENY_W_KANALE_INNEJ)).toHaveLength(1)
    expect(await zdarzenia(orderId, ZDARZENIE_CENY_Z_KANALU)).toHaveLength(0)

    // obsługa wyjaśnia; kolejna rewizja z tą samą ceną nie wraca do wyjaśnienia
    await resolveClarification(db, orderId, { now: T0 })
    await ingestOrder(db, rewizja(o1, 71.7, 21.7), { now: T0 })
    po = await zamowienie(orderId)
    expect(po.status).not.toBe('DO_WYJASNIENIA')
    expect(await zdarzenia(orderId, ZDARZENIE_CENY_W_KANALE_INNEJ)).toHaveLength(1)

    // następna zmiana w sklepie: znowu sygnał (porównanie z zapamiętaną ceną kanału)
    await ingestOrder(db, rewizja(o1, 81.7, 21.7), { now: T0 })
    po = await zamowienie(orderId)
    expect(po.status).toBe('DO_WYJASNIENIA')
    expect(flagsOf(po).doWyjasnienia).toContain('L1 71,70 zł → 81,70 zł')
    expect(await ceny(orderId)).toEqual({ L1: '61.70', L2: '21.70' })
  })

  it('opłacone w kanale (kwota ≠ 0): zmiana ceny w sklepie → do wyjaśnienia, kwota i ceny bez zmian', async () => {
    const { o1, orderId } = await przyjete({ paymentState: 'PAID' })
    await ingestOrder(db, rewizja(o1, 61.7, 11.7, { paymentState: 'PAID' }), { now: T0 })
    const po = await zamowienie(orderId)
    expect(po.status).toBe('DO_WYJASNIENIA')
    expect(po.totalGross.toFixed(2)).toBe('117.60')
    expect(await ceny(orderId)).toEqual({ L1: '61.70', L2: '21.70' })
  })

  it('edycja ceny w Kompletorze: kanał bez zmian = edycja zostaje; zmiana ceny w kanale = do wyjaśnienia', async () => {
    const { o1, orderId } = await przyjete()
    const l1 = await db.orderLine.findFirstOrThrow({ where: { orderId, externalLineId: 'L1' } })
    await changeLinePrice(db, orderId, l1.id, { priceGrossGr: 5000 }, { now: T0, actorId: 'user:u-test' })
    expect(flagsOf(await zamowienie(orderId)).cenyKanalu).toEqual({ L1: '61.70', L2: '21.70' })

    await ingestOrder(db, rewizja(o1, 61.7, 21.7), { now: T0 })
    expect((await zamowienie(orderId)).status).toBe('NOWE')
    expect(await ceny(orderId)).toEqual({ L1: '50.00', L2: '21.70' })

    await ingestOrder(db, rewizja(o1, 61.7, 19.9), { now: T0 })
    const po = await zamowienie(orderId)
    expect(po.status).toBe('DO_WYJASNIENIA')
    expect(flagsOf(po).doWyjasnienia).toContain('L2 21,70 zł → 19,90 zł')
    expect(flagsOf(po).doWyjasnienia).not.toContain('L1')
    expect(await ceny(orderId)).toEqual({ L1: '50.00', L2: '21.70' })
  })

  it('zamówienie edytowane przed zapamiętywaniem cen kanału: odniesienie z historii zmiany ceny', async () => {
    const { o1, orderId } = await przyjete()
    const l1 = await db.orderLine.findFirstOrThrow({ where: { orderId, externalLineId: 'L1' } })
    await changeLinePrice(db, orderId, l1.id, { priceGrossGr: 5000 }, { now: T0, actorId: 'user:u-test' })
    // stan: flagi bez `cenyKanalu`
    const o = await zamowienie(orderId)
    const { cenyKanalu: _bez, ...reszta } = flagsOf(o)
    await db.order.update({ where: { id: orderId }, data: { flags: reszta } })

    await ingestOrder(db, rewizja(o1, 61.7, 21.7), { now: T0 })
    expect((await zamowienie(orderId)).status).toBe('NOWE')
    await ingestOrder(db, rewizja(o1, 65, 21.7), { now: T0 })
    const po = await zamowienie(orderId)
    expect(po.status).toBe('DO_WYJASNIENIA')
    expect(flagsOf(po).doWyjasnienia).toContain('L1 61,70 zł → 65,00 zł')
  })

  it('pozycja z zamiennikiem: bez automatu nawet przy otwartych kwotach', async () => {
    const { o1, orderId } = await przyjete()
    const c = await product(db, 'C', 10)
    await db.orderLine.create({ data: { orderId, externalLineId: 'L1#zamiana-1', productId: c, qty: 1, unitPriceGross: '61.70', vatRate: '23' } })
    await ingestOrder(db, rewizja(o1, 71.7, 21.7), { now: T0 })
    expect((await zamowienie(orderId)).status).toBe('DO_WYJASNIENIA')
    expect(await ceny(orderId)).toEqual({ L1: '61.70', 'L1#zamiana-1': '61.70', L2: '21.70' })
  })

  it('„Odśwież z kanału” przy zamkniętych kwotach: nic się nie zmienia, status też nie', async () => {
    const { o1, orderId } = await przyjete()
    await db.invoiceAttempt.create({ data: { orderId, packageNo: 1, attemptNo: 1, idExternal: `${orderId}/1/1`, state: 'ISSUED', wfirmaDocId: 'FV-TEST-372' } })
    const deps = await kanal(o1, 71.7, 21.7)
    expect(await odswiezOpisZKanalu(db, orderId, deps)).toEqual({ wynik: 'OK', zmian: 0 })
    expect((await zamowienie(orderId)).status).toBe('NOWE')
    expect(await ceny(orderId)).toEqual({ L1: '61.70', L2: '21.70' })
  })

  it('już wysłane: status bez zmian, tylko wpis w historii, raz na zmianę w kanale', async () => {
    const { o1, orderId } = await przyjete({ paymentState: 'PAID' })
    await db.order.update({ where: { id: orderId }, data: { status: 'WYSLANE' } })
    await ingestOrder(db, rewizja(o1, 71.7, 21.7, { paymentState: 'PAID' }), { now: T0 })
    await ingestOrder(db, rewizja(o1, 71.7, 21.7, { paymentState: 'PAID' }), { now: T0 })
    expect((await zamowienie(orderId)).status).toBe('WYSLANE')
    expect(await ceny(orderId)).toEqual({ L1: '61.70', L2: '21.70' })
    expect(await zdarzenia(orderId, 'CENA_W_KANALE_INNA')).toHaveLength(1)
  })

  it('anulowane: bez sygnału i bez zmiany cen', async () => {
    const { o1, orderId } = await przyjete()
    await db.order.update({ where: { id: orderId }, data: { status: 'ANULOWANE', cancelReason: 'CANCELLED' } })
    await ingestOrder(db, rewizja(o1, 71.7, 21.7), { now: T0 })
    expect((await zamowienie(orderId)).status).toBe('ANULOWANE')
    expect(await ceny(orderId)).toEqual({ L1: '61.70', L2: '21.70' })
  })
})
