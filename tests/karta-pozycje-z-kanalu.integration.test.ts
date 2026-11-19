// opis pozycji z kanału (nazwa, SKU, EAN), numer i koszt wysyłki zapisane przy przyjęciu
// i uzupełniane bez zmiany statusu; „Powiąż z produktem” zdejmuje „Do wyjaśnienia”; zbiorcze uzupełnienie danych klienta
// planuje zadania idempotentnie. Dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterError } from '@/lib/adaptery/kontrakt'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { daneKarty } from '@/lib/karta/dane'
import { odswiezOpisZKanalu } from '@/lib/karta/opis-z-kanalu'
import { dedupeZapisu, KLIENT_ZAPIS_JOB } from '@/lib/klienci/kolejka'
import { uzupelnijDaneKlientow, ZapisKlientaWylaczony } from '@/lib/klienci/uzupelnij'
import { powiazPozycje } from '@/lib/karta/powiaz'
import { ingestOrder, zapiszOpisZKanalu } from '@/lib/rdzen/zamowienia'
import { runTx } from '@/lib/rdzen/stan'
import { testDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const ENV_ZAPIS = { DANE_KLIENTA_ZAPIS: '1' }

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

describe('opis pozycji z kanału', () => {
  it('przyjęcie zapisuje nazwę, SKU, EAN pozycji oraz numer i koszt wysyłki; pozycja bez oferty w katalogu → Do wyjaśnienia z nazwą', async () => {
    const o = order([{ offerExternalId: '1234567890', qty: 1, unitPriceGross: 19.7, name: 'Przyprawa testowa Fikcyjna 50 g', sku: 'SYG-1', ean: '5900000000001' }], {
      channel: 'ALLEGRO',
      channelNumber: 'NR-77',
      shippingCostGross: 10.49,
    })
    const r = await ingestOrder(db, o, { now: T0 })
    const z = await db.order.findUniqueOrThrow({ where: { id: r.orderId! }, include: { lines: true } })
    expect(z.status).toBe('DO_WYJASNIENIA')
    expect(z.channelNumber).toBe('NR-77')
    expect(z.shippingCostGross?.toFixed(2)).toBe('10.49')
    expect(z.lines[0]).toMatchObject({ productId: null, offerId: '1234567890', channelName: 'Przyprawa testowa Fikcyjna 50 g', channelSku: 'SYG-1', channelEan: '5900000000001' })
  })

  it('nowa rewizja uzupełnia brakujący opis bez zmiany statusu i rezerwacji; pusty opis nie kasuje zapisanego; zapis idempotentny', async () => {
    const a = await product(db, 'A', 5)
    await db.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'sd', externalId: '501', productId: a } })
    const o1 = order([{ offerExternalId: '501', qty: 2, unitPriceGross: 10, externalLineId: 'L1' }], { externalRevision: '1' })
    const { orderId } = await ingestOrder(db, o1, { now: T0 })
    const przed = await db.order.findUniqueOrThrow({ where: { id: orderId! }, include: { lines: true, reservations: true } })
    expect(przed.lines[0]!.channelName).toBeNull()
    await ingestOrder(db, { ...o1, externalRevision: '2', channelNumber: '158546', lines: [{ ...o1.lines[0]!, name: 'Towar w sklepie', sku: 'A' }] }, { now: T0 })
    const po = await db.order.findUniqueOrThrow({ where: { id: orderId! }, include: { lines: true, reservations: true } })
    expect(po.status).toBe(przed.status)
    expect(po.lines[0]).toMatchObject({ channelName: 'Towar w sklepie', channelSku: 'A', qty: 2 })
    expect(po.channelNumber).toBe('158546')
    expect(po.reservations.map((x) => x.qtyBase)).toEqual(przed.reservations.map((x) => x.qtyBase))
    // trzecia rewizja bez opisu: zapisany zostaje
    await ingestOrder(db, { ...o1, externalRevision: '3' }, { now: T0 })
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: orderId! } })).channelName).toBe('Towar w sklepie')
    // ten sam opis drugi raz = 0 zmian
    expect(await runTx(db, (tx) => zapiszOpisZKanalu(tx, orderId!, { channelNumber: '158546', lines: [{ externalLineId: 'L1', name: 'Towar w sklepie', sku: 'A' }] }))).toBe(0)
    await expectInvariants(db)
  })
})

describe('Powiąż z produktem', () => {
  it('tworzy powiązanie oferty MANUAL, dopina produkt i rezerwację, zdejmuje „Do wyjaśnienia”; kolejne zamówienie z oferty przychodzi z produktem', async () => {
    const a = await product(db, 'HERB-1', 10)
    const o = order([{ offerExternalId: '999001', qty: 2, unitPriceGross: 19.7, name: 'Przyprawa fikcyjna' }], { channel: 'ALLEGRO' })
    const { orderId } = await ingestOrder(db, o, { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: orderId! } })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId! } })).status).toBe('DO_WYJASNIENIA')

    const zly = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'NIE-MA', sztuk: '1', actorId: 'u-test' })
    expect(zly.blad).toContain('Nie ma aktywnego produktu')
    const zlaIlosc = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'HERB-1', sztuk: '0', actorId: 'u-test' })
    expect(zlaIlosc.blad).toContain('od 1')

    const w = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'HERB-1', sztuk: '1', actorId: 'u-test' })
    expect(w).toMatchObject({ zmiana: true, blad: null })
    const po = await db.order.findUniqueOrThrow({ where: { id: orderId! }, include: { lines: true, reservations: true } })
    expect(po.status).toBe('DO_REALIZACJI')
    expect(po.lines[0]!.productId).toBe(a)
    expect(po.reservations.reduce((s, r) => s + r.qtyBase, 0)).toBe(2)
    expect(await db.channelOffer.findFirst({ where: { channel: 'ALLEGRO', externalId: '999001' } })).toMatchObject({ productId: a, mappingSource: 'MANUAL', active: true })
    expect(await db.auditLog.count({ where: { entity: 'ChannelOffer', actorId: 'u-test' } })).toBe(1)

    const drugi = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'HERB-1', sztuk: '1', actorId: 'u-test' })
    expect(drugi.blad).toContain('już powiązana')

    const kolejne = await ingestOrder(db, order([{ offerExternalId: '999001', qty: 1, unitPriceGross: 19.7 }], { channel: 'ALLEGRO' }), { now: T0 })
    expect(kolejne.status).toBe('DO_REALIZACJI')
    await expectInvariants(db)
  })

  it('pozycja bez numeru oferty: czytelna odmowa, nic się nie zmienia', async () => {
    await product(db, 'HERB-1', 10)
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: null, qty: 1, unitPriceGross: 5, name: 'Bez oferty' }], { channel: 'ALLEGRO' }), { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: orderId! } })
    const w = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'HERB-1', sztuk: '1', actorId: 'u-test' })
    expect(w.zmiana).toBe(false)
    expect(w.blad).toContain('nie podał numeru oferty')
    expect(await db.channelOffer.count()).toBe(0)
  })
})

describe('zbiorcze uzupełnienie danych klienta', () => {
  it('wyłączony zapis = jawny błąd; planuje zadania tylko dla otwartych zamówień z kanałów z API, bez danych; drugi przebieg nic nie dubluje; zadanie zakończone wraca do kolejki', async () => {
    const a = await product(db, 'A', 10)
    const allegro = await ingestOrder(db, order([{ productId: a, qty: 1 }], { channel: 'ALLEGRO' }), { now: T0 })
    const woo = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    const reczne = await ingestOrder(db, order([{ productId: a, qty: 1 }], { channel: 'RECZNE' }), { now: T0 })
    const anulowane = await ingestOrder(db, order([{ productId: a, qty: 1 }], { cancelled: true }), { now: T0 })
    expect(reczne.orderId && anulowane.orderId).toBeTruthy()

    await expect(uzupelnijDaneKlientow(db, { env: {} })).rejects.toBeInstanceOf(ZapisKlientaWylaczony)
    expect(await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, proba: true, now: T0 })).toMatchObject({ kandydaci: 2, zaplanowane: 0 })

    const r1 = await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0, odstepMs: 1000 })
    expect(r1).toMatchObject({ kandydaci: 2, zaplanowane: 2, wznowione: 0, wKolejce: 0 })
    const joby = await db.job.findMany({ where: { kind: KLIENT_ZAPIS_JOB }, orderBy: { runAfter: 'asc' } })
    expect(joby.map((j) => (j.payload as { orderId: string }).orderId).sort()).toEqual([allegro.orderId, woo.orderId].sort())
    expect(joby[1]!.runAfter.getTime() - joby[0]!.runAfter.getTime()).toBe(1000)

    const r2 = await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0 })
    expect(r2).toMatchObject({ zaplanowane: 0, wKolejce: 2 })
    expect(await db.job.count({ where: { kind: KLIENT_ZAPIS_JOB } })).toBe(2)

    await db.job.update({ where: { organizationId_dedupeKey: { organizationId: joby[0]!.organizationId, dedupeKey: dedupeZapisu(allegro.orderId!) } }, data: { status: 'FAILED', attempts: 8, lastError: 'test' } })
    const r3 = await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0 })
    expect(r3).toMatchObject({ wznowione: 1, wKolejce: 1 })
    expect(await db.job.findFirst({ where: { dedupeKey: dedupeZapisu(allegro.orderId!) } })).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null })
  })
})

describe('oferta już powiązana', () => {
  it('inny produkt: odmowa, oferta i audyt bez zmian; ten sam produkt (SKU bez wielkości liter): tylko to zamówienie, bez zapisu oferty; inny przelicznik: odmowa', async () => {
    await product(db, 'HERB-A', 10)
    const b = await product(db, 'HERB-B', 10)
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: '777001', qty: 2, unitPriceGross: 10, name: 'Przyprawa fikcyjna B' }], { channel: 'ALLEGRO' }), { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: orderId! } })
    // oferta powiązana po przyjęciu zamówienia (bez przeliczenia): pozycja zostaje bez produktu
    const oferta = await db.channelOffer.create({ data: { channel: 'ALLEGRO', channelAccountId: 'allegro', externalId: '777001', productId: b } })
    const karta = await daneKarty(db, orderId!, { userId: 'u-test', uprawnienia: new Set() })
    expect(karta!.powiazaniaPozycji.get(line.id)).toMatchObject({ productId: b, sku: 'HERB-B', active: true, qtyBasePerOffer: 1 })

    const inny = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'HERB-A', sztuk: '1', actorId: 'u-test' })
    expect(inny.zmiana).toBe(false)
    expect(inny.blad).toContain('już powiązana z produktem SKU „HERB-B”')
    expect(await db.channelOffer.findUniqueOrThrow({ where: { id: oferta.id } })).toMatchObject({ productId: b, mappingSource: oferta.mappingSource })
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: line.id } })).productId).toBeNull()

    const przelicznik = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'HERB-B', sztuk: '3', actorId: 'u-test' })
    expect(przelicznik.blad).toContain('po 1 szt.')

    const ten = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'herb-b', sztuk: '1', actorId: 'u-test' })
    expect(ten).toMatchObject({ zmiana: true, blad: null })
    const po = await db.order.findUniqueOrThrow({ where: { id: orderId! }, include: { lines: true, reservations: true } })
    expect(po.status).toBe('DO_REALIZACJI')
    expect(po.lines[0]!.productId).toBe(b)
    expect(po.reservations.reduce((s, r) => s + r.qtyBase, 0)).toBe(2)
    expect(await db.channelOffer.findUniqueOrThrow({ where: { id: oferta.id } })).toMatchObject({ productId: b, mappingSource: oferta.mappingSource })
    expect(await db.auditLog.count({ where: { entity: 'ChannelOffer' } })).toBe(0)
    await expectInvariants(db)
  })

  it('ten sam produkt, zamówienie po zbieraniu: odmowa bez rezerwacji; dwa SKU różniące się wielkością liter: tylko dokładne', async () => {
    const b = await product(db, 'HERB-B', 10)
    await product(db, 'herb-b', 10)
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: '777002', qty: 1, unitPriceGross: 10 }], { channel: 'ALLEGRO' }), { now: T0 })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: orderId! } })
    await db.channelOffer.create({ data: { channel: 'ALLEGRO', channelAccountId: 'allegro', externalId: '777002', productId: b } })

    const wiele = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'Herb-B', sztuk: '1', actorId: 'u-test' })
    expect(wiele.blad).toContain('różniące się wielkością liter')

    await db.order.update({ where: { id: orderId! }, data: { status: 'SPAKOWANE' } })
    const w = await powiazPozycje(db, { orderId, lineId: line.id, sku: 'HERB-B', sztuk: '1', actorId: 'u-test' })
    expect(w.zmiana).toBe(false)
    expect(w.blad).toContain('dalej niż „Do realizacji”')
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: line.id } })).productId).toBeNull()
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId! }, include: { reservations: true } })).reservations).toHaveLength(0)
  })
})

describe('Odśwież opis z kanału', () => {
  it('OK uzupełnia opis (powtórka = 0 zmian), BRAK_W_KANALE, BLAD bez treści wyjątku, BRAK_ZRODLA dla ręcznych i konta bez adaptera', async () => {
    const a = await product(db, 'A', 5)
    await db.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'sd', externalId: '601', productId: a } })
    const o = order([{ offerExternalId: '601', qty: 1, unitPriceGross: 10, externalLineId: 'L1' }])
    const { orderId } = await ingestOrder(db, o, { now: T0 })
    const state = new FakeChannelState()
    const registry = new AdapterRegistry([fakeDefinition(state, 'WOO', 'fake.v1')])
    const deps = { registry, secrets: { env: {}, envFallback: false } }

    // konto z adapterem, którego rejestr nie zna: bez odczytu, bez zmian
    expect((await odswiezOpisZKanalu(db, orderId!, deps)).wynik).not.toBe('OK')
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1' } })

    expect(await odswiezOpisZKanalu(db, orderId!, deps)).toEqual({ wynik: 'BRAK_W_KANALE' })

    state.upsertOrder(fakeOrder({ externalId: o.externalId, number: 'NR-601', shippingCostGross: 9.99, lines: [{ externalLineId: 'L1', offerExternalId: '601', qty: 1, unitPriceGross: 10, vatRate: '23', name: 'Nazwa z kanału', sku: 'A', ean: '5900000000002' }] }))
    expect(await odswiezOpisZKanalu(db, orderId!, deps)).toMatchObject({ wynik: 'OK' })
    const po = await db.order.findUniqueOrThrow({ where: { id: orderId! }, include: { lines: true } })
    expect(po.channelNumber).toBe('NR-601')
    expect(po.shippingCostGross?.toFixed(2)).toBe('9.99')
    expect(po.lines[0]).toMatchObject({ channelName: 'Nazwa z kanału', channelSku: 'A', channelEan: '5900000000002' })
    expect(await odswiezOpisZKanalu(db, orderId!, deps)).toEqual({ wynik: 'OK', zmian: 0 })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.getFailures.push(new AdapterError('odpowiedź z sekretem-XYZ', 'TRWALY'))
    expect(await odswiezOpisZKanalu(db, orderId!, deps)).toEqual({ wynik: 'BLAD', powod: 'Odczyt z kanału nie powiódł się (TRWALY).' })
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sekretem')
    warn.mockRestore()

    const reczne = await ingestOrder(db, order([{ productId: a, qty: 1 }], { channel: 'RECZNE' }), { now: T0 })
    expect((await odswiezOpisZKanalu(db, reczne.orderId!, deps)).wynik).toBe('BRAK_ZRODLA')
  })
})

describe('limit i ponowne przebiegi uzupełnienia', () => {
  it('zamówienia z zadaniem w kolejce nie liczą się do limitu (kolejny przebieg bierze następne); DONE bez zapisu wraca tylko z ponow', async () => {
    const a = await product(db, 'A', 10)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await ingestOrder(db, order([{ productId: a, qty: 1 }], { channel: 'ALLEGRO' }), { now: T0 })).orderId!)

    const r1 = await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0, limit: 1 })
    expect(r1).toMatchObject({ kandydaci: 1, zaplanowane: 1, wKolejce: 0 })
    const r2 = await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0, limit: 1 })
    expect(r2).toMatchObject({ kandydaci: 1, zaplanowane: 1, wKolejce: 1 })
    const r3 = await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0, limit: 5 })
    expect(r3).toMatchObject({ kandydaci: 1, zaplanowane: 1, wKolejce: 2 })
    expect(await db.job.count({ where: { kind: KLIENT_ZAPIS_JOB } })).toBe(3)

    // worker zakończył DONE bez zapisu (np. odmowa bramki): domyślnie nie wraca, z ponow wraca
    await db.job.updateMany({ where: { kind: KLIENT_ZAPIS_JOB, dedupeKey: dedupeZapisu(ids[0]!) }, data: { status: 'DONE' } })
    const r4 = await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0 })
    expect(r4).toMatchObject({ kandydaci: 0, wznowione: 0, pominieteWykonane: 1, wKolejce: 2 })
    expect(await db.job.findFirst({ where: { dedupeKey: dedupeZapisu(ids[0]!) } })).toMatchObject({ status: 'DONE' })
    expect(await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0, proba: true, ponow: true })).toMatchObject({ kandydaci: 1, wznowione: 0 })
    const r5 = await uzupelnijDaneKlientow(db, { env: ENV_ZAPIS, now: T0, ponow: true })
    expect(r5).toMatchObject({ kandydaci: 1, wznowione: 1, pominieteWykonane: 0 })
    expect(await db.job.findFirst({ where: { dedupeKey: dedupeZapisu(ids[0]!) } })).toMatchObject({ status: 'PENDING', attempts: 0 })
  })
})
