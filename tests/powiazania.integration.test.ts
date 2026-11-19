// powiązania produktu od strony produktu (karta → Powiązania) i masowe łączenie na koncie kanału.
// Powiązanie, odłączenie, przepięcie (rezerwacje i zamówienia przeliczone), kolizja, masowe łączenie po SKU/EAN
// z podglądem, zbiorcze zatwierdzanie propozycji, ręczne wskazanie towaru wFirmy i izolacja firm. Zero wywołań kanału:
// wszystko na bazie (adapterów tu nie ma). Dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { ChannelAdapter, ChannelOfferRow } from '@/lib/adaptery/kontrakt'
import { doPrzypisania, pobierzOferty } from '@/lib/kanaly/oferty'
import {
  odlaczOferte,
  planLaczenia,
  polaczMasowo,
  powiazaniaProduktu,
  powiazZOferta,
  PowiazaniaError,
  propozycjeKonta,
  przepnijOferte,
  szukajOfert,
  szukajProduktowDoPrzepiecia,
  szukajTowarowWfirmy,
  wskazTowarWfirmy,
  zatwierdzPropozycje,
} from '@/lib/produkty/powiazania'
import { shipLater } from '@/lib/rdzen/brakuje'
import { splitOrder } from '@/lib/rdzen/edycja'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_B, testDb, truncateAll } from './db'
import { ACC, expectInvariants, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
})

const SD = ACC.WOO_SD
const ALLEGRO = ACC.ALLEGRO

async function odczyt(d: PrismaClient, ref: { channel: 'WOO' | 'ALLEGRO'; channelAccountId: string }, externalId: string, o: { sku?: string | null; ean?: string | null; name?: string; state?: string } = {}) {
  await d.channelOfferRead.create({
    data: { ...ref, externalId, sku: o.sku ?? null, ean: o.ean ?? null, name: o.name ?? `Oferta testowa ${externalId}`, qty: 3, state: o.state ?? 'BEZ_PRODUKTU', runId: 'run-test', seenAt: T0 },
  })
}

describe('Powiąż z ofertą (karta produktu)', () => {
  it('wyszukuje ofertę po SKU, EAN, numerze i nazwie; powiązanie MANUAL przelicza zamówienie czekające i zapisuje historię produktu', async () => {
    const a = await product(db, 'HERB-1', 10)
    await odczyt(db, ALLEGRO, '777001', { sku: 'SYG-HERB', ean: '5901234123457', name: 'Przyprawa zielona fikcyjna' })
    await odczyt(db, SD, '501', { sku: 'INNA', name: 'Kawa fikcyjna' })
    expect((await szukajOfert(db, 'syg-herb')).map((x) => x.externalId)).toEqual(['777001'])
    expect((await szukajOfert(db, '5901234123457')).map((x) => x.externalId)).toEqual(['777001'])
    expect((await szukajOfert(db, '777001')).map((x) => x.externalId)).toEqual(['777001'])
    expect((await szukajOfert(db, 'zielona')).map((x) => x.externalId)).toEqual(['777001'])
    expect(await szukajOfert(db, 'x')).toEqual([])

    const { orderId } = await ingestOrder(db, order([{ offerExternalId: '777001', qty: 2, unitPriceGross: 19.7 }], { channel: 'ALLEGRO' }), { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId! } })).status).toBe('DO_WYJASNIENIA')

    const w = await powiazZOferta(db, { productId: a, konto: ALLEGRO, externalId: '777001', sztuk: '1', actorId: 'user:u1' })
    expect(w.remapped).toBe(1)
    const z = await db.order.findUniqueOrThrow({ where: { id: orderId! }, include: { lines: true, reservations: true } })
    expect(z.status).toBe('DO_REALIZACJI')
    expect(z.lines[0]!.productId).toBe(a)
    expect(z.reservations.reduce((s, r) => s + r.qtyBase, 0)).toBe(2)
    expect(await db.channelOffer.findFirst({ where: { externalId: '777001' } })).toMatchObject({ productId: a, mappingSource: 'MANUAL', active: true })
    expect(await db.channelOfferRead.findFirst({ where: { externalId: '777001' } })).toMatchObject({ state: 'POWIAZANA' })
    expect(await db.auditLog.count({ where: { entity: 'Product', entityId: a, actorId: 'user:u1' } })).toBe(1)

    const lista = await powiazaniaProduktu(db, a)
    expect(lista).toHaveLength(1)
    expect(lista[0]).toMatchObject({ externalId: '777001', stan: 'AKTYWNA', zrodlo: 'ręcznie', nazwa: 'Przyprawa zielona fikcyjna', skutek: { przedZbieraniem: 1, wToku: 0, zarezerwowane: 2 } })
    expect((await szukajOfert(db, 'SYG-HERB'))[0]!.powiazanie).toMatchObject({ productId: a, stan: 'AKTYWNA' })

    // powtórka: nic nowego
    expect((await powiazZOferta(db, { productId: a, konto: ALLEGRO, externalId: '777001', sztuk: '1', actorId: 'user:u1' })).info).toContain('już powiązana')
    expect(await db.auditLog.count({ where: { entity: 'ChannelOffer' } })).toBe(1)
    await expectInvariants(db)
  })

  it('kolizja: oferta aktywnie powiązana z innym produktem = odmowa z drogą „Przepnij”; zły przelicznik i produkt = czytelna odmowa', async () => {
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 5)
    await offer(db, 'WOO_SD', '501', b)
    await expect(powiazZOferta(db, { productId: a, konto: SD, externalId: '501', sztuk: '1', actorId: 'user:u1' })).rejects.toThrow(/Przepnij/)
    await expect(powiazZOferta(db, { productId: a, konto: SD, externalId: '502', sztuk: '0', actorId: 'user:u1' })).rejects.toBeInstanceOf(PowiazaniaError)
    await expect(powiazZOferta(db, { productId: 'nie-ma', konto: SD, externalId: '502', sztuk: '1', actorId: 'user:u1' })).rejects.toThrow('Nie ma takiego produktu')
    await expect(powiazZOferta(db, { productId: a, konto: { channel: 'WOO', channelAccountId: 'brak' }, externalId: '502', sztuk: '1', actorId: 'user:u1' })).rejects.toThrow('Nie ma takiego konta')
    expect(await db.channelOffer.findFirst({ where: { externalId: '501' } })).toMatchObject({ productId: b, active: true })
  })
})

describe('Odłącz', () => {
  it('oferta nieaktywna i trwała (MANUAL), wraca do „Do przypisania”; przyjęte zamówienie bez zmian, kolejne przychodzi bez produktu', async () => {
    const a = await product(db, 'A', 10)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    await db.channelOffer.update({ where: { id: offerId }, data: { lastPushedQty: 7 } })
    await odczyt(db, SD, '501', { sku: 'A', state: 'POWIAZANA' })
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: '501', qty: 2 }]), { now: T0 })
    expect((await powiazaniaProduktu(db, a))[0]!.skutek).toMatchObject({ przedZbieraniem: 1, zarezerwowane: 2 })

    const w = await odlaczOferte(db, { productId: a, offerId, actorId: 'user:u1' })
    expect(w.info).toContain('ostatnio wysłany stan (7)')
    expect(await db.channelOffer.findUniqueOrThrow({ where: { id: offerId } })).toMatchObject({ active: false, needsApproval: false, mappingSource: 'MANUAL', deactivatedByImportAt: null })
    expect((await powiazaniaProduktu(db, a))[0]!.stan).toBe('ODLACZONA')
    expect((await doPrzypisania(db, SD)).map((x) => x.externalId)).toEqual(['501'])
    const z = await db.order.findUniqueOrThrow({ where: { id: orderId! }, include: { lines: true, reservations: true } })
    expect(z.lines[0]!.productId).toBe(a)
    expect(z.reservations.filter((r) => r.state === 'ACTIVE').reduce((s, r) => s + r.qtyBase, 0)).toBe(2)
    const kolejne = await ingestOrder(db, order([{ offerExternalId: '501', qty: 1 }]), { now: T0 })
    expect(kolejne.status).toBe('DO_WYJASNIENIA')
    // druga próba: bez zmian
    expect((await odlaczOferte(db, { productId: a, offerId, actorId: 'user:u1' })).info).toContain('już odłączona')
    // oferta innego produktu: odmowa
    const b = await product(db, 'B', 1)
    await expect(odlaczOferte(db, { productId: b, offerId, actorId: 'user:u1' })).rejects.toThrow('Nie ma takiego powiązania')
    await expectInvariants(db)
  })
})

describe('Przepnij na inny produkt', () => {
  it('pozycje przed zbieraniem przechodzą na nowy produkt z nowym przelicznikiem (rezerwacje przeliczone), zamówienie edytowane z karty zostaje', async () => {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 10)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    const z1 = await ingestOrder(db, order([{ offerExternalId: '501', qty: 2 }]), { now: T0 })
    const z2 = await ingestOrder(db, order([{ offerExternalId: '501', qty: 1 }]), { now: T0 })
    await db.order.update({ where: { id: z2.orderId! }, data: { flags: { edytowaneLokalnie: true } } })
    expect((await stockOf(db, a)).reserved).toBe(3)

    await expect(przepnijOferte(db, { productId: a, offerId, cel: a, sztuk: '1', actorId: 'user:u1' })).rejects.toThrow('ten sam produkt')
    await expect(przepnijOferte(db, { productId: a, offerId, cel: 'niema', sztuk: '1', actorId: 'user:u1' })).rejects.toThrow('Nie ma takiego aktywnego produktu')
    // inny przelicznik przy zamówieniu, którego nie da się przeliczyć (zmieniane z karty): odmowa, nic nie zmienione
    await expect(przepnijOferte(db, { productId: a, offerId, cel: b, sztuk: '2', actorId: 'user:u1' })).rejects.toThrow(/Przelicznika tej oferty \(1\)/)
    expect(await db.channelOffer.findUniqueOrThrow({ where: { id: offerId } })).toMatchObject({ productId: a, qtyBasePerOffer: 1 })

    const w = await przepnijOferte(db, { productId: a, offerId, cel: b, sztuk: '1', actorId: 'user:u1' })
    expect(w).toMatchObject({ przepiete: 1, pominiete: 1 })
    expect(w.info).toContain('zmieniane z karty')
    expect(w.info).toContain('SKU B')
    expect(await db.channelOffer.findUniqueOrThrow({ where: { id: offerId } })).toMatchObject({ productId: b, qtyBasePerOffer: 1, mappingSource: 'MANUAL', active: true })
    const l1 = await db.orderLine.findFirstOrThrow({ where: { orderId: z1.orderId! } })
    expect(l1).toMatchObject({ productId: b, qty: 2, qtyChannel: 2 })
    const l2 = await db.orderLine.findFirstOrThrow({ where: { orderId: z2.orderId! } })
    expect(l2).toMatchObject({ productId: a, qty: 1 })
    expect((await stockOf(db, a)).reserved).toBe(1)
    expect((await stockOf(db, b)).reserved).toBe(2)
    expect(await db.orderEvent.count({ where: { orderId: z1.orderId!, kind: 'PRZEPIECIE_OFERTY' } })).toBe(1)
    expect(await db.auditLog.count({ where: { entity: 'Product', entityId: { in: [a, b] } } })).toBe(2)
    // alert „w toku” zamknięty po końcu, reszty nie ma
    expect(await db.alert.count({ where: { kind: 'PRZEPIECIE_OFERTY_W_TOKU', closedAt: null } })).toBe(0)
    expect(await db.alert.count({ where: { kind: 'PRZEPIECIE_OFERTY_RESZTA' } })).toBe(0)
    // nowe zamówienie z oferty: od razu nowy produkt
    const z3 = await ingestOrder(db, order([{ offerExternalId: '501', qty: 1 }]), { now: T0 })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: z3.orderId! } })).toMatchObject({ productId: b, qty: 1 })
    await expectInvariants(db)
  })

  it('przepięcie przy braku stanu nowego produktu: pozycja dostaje „brakuje”, stary produkt zwolniony', async () => {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 1)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    const z = await ingestOrder(db, order([{ offerExternalId: '501', qty: 3 }]), { now: T0 })
    await przepnijOferte(db, { productId: a, offerId, cel: b, sztuk: '1', actorId: 'user:u1' })
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect((await stockOf(db, b)).reserved).toBe(1)
    expect(await db.shortage.findMany({ where: { orderId: z.orderId!, state: 'OPEN' }, select: { productId: true, qtyBase: true } })).toEqual([{ productId: b, qtyBase: 2 }])
    const o = await db.order.findUniqueOrThrow({ where: { id: z.orderId! } })
    expect((o.flags as { brakuje?: boolean }).brakuje).toBe(true)
    await expectInvariants(db)
  })
})

describe('masowe łączenie i propozycje', () => {
  it('podgląd po SKU dzieli oferty na połączy / koliduje / do decyzji; wykonanie łączy tylko świeże „połączy” z wybranych', async () => {
    const a = await product(db, 'SKU-A', 5)
    const b = await product(db, 'SKU-B', 5)
    await product(db, 'SKU-C', 5)
    await product(db, 'sku-c', 5) // różni się wielkością liter
    const kg = await product(db, 'SKU-KG', 5000, { unit: 'KG' })
    await odczyt(db, SD, '1', { sku: 'SKU-A' }) // połączy
    await odczyt(db, SD, '2', { sku: 'SKU-B' }) // koliduje: zapisany inny produkt (odłączona)
    await db.channelOffer.create({ data: { ...SD, externalId: '2', productId: a, active: false, mappingSource: 'MANUAL' } })
    await odczyt(db, SD, '3', { sku: 'SKU-C' }) // połączy: dokładnie jeden produkt SKU-C (drugi różni się wielkością liter)
    await odczyt(db, SD, '4', { sku: 'Sku-c' }) // decyzja: tylko wielkość liter
    await odczyt(db, SD, '5', { sku: 'DUBEL' })
    await odczyt(db, SD, '6', { sku: 'DUBEL' })
    await product(db, 'DUBEL', 1) // decyzja: dwie oferty z tym SKU
    await odczyt(db, SD, '7', { sku: null }) // bez SKU
    await odczyt(db, SD, '8', { sku: 'SKU-KG' }) // połączy, 1000 g
    await odczyt(db, SD, '9', { sku: 'SKU-A', state: 'POWIAZANA' })
    await offer(db, 'WOO_SD', '9', a) // aktywnie powiązana: poza planem

    const plan = await planLaczenia(db, SD, 'SKU')
    expect(plan.sprawdzone).toBe(8)
    expect(plan.polaczy.map((x) => x.externalId).sort()).toEqual(['1', '3', '8'])
    expect(plan.koliduje.map((x) => x.externalId)).toEqual(['2'])
    expect(plan.decyzja.map((x) => x.externalId).sort()).toEqual(['4', '5', '6'])
    expect(plan.bezTrafienia).toBe(1)
    expect(await db.channelOffer.count()).toBe(2) // podgląd nic nie zapisuje

    const w = await polaczMasowo(db, SD, 'SKU', ['1', '2', '8', 'zły numer z spacją'], 'user:u1')
    expect(w).toMatchObject({ polaczone: 2, pominiete: 1, bledy: 0 })
    expect(await db.channelOffer.findFirst({ where: { externalId: '1' } })).toMatchObject({ productId: a, active: true, mappingSource: 'MANUAL' })
    expect(await db.channelOffer.findFirst({ where: { externalId: '8' } })).toMatchObject({ productId: kg, qtyBasePerOffer: 1000 })
    expect(await db.channelOffer.findFirst({ where: { externalId: '2' } })).toMatchObject({ productId: a, active: false })
    expect(b).toBeTruthy()
    // powtórka: nic do połączenia
    expect((await polaczMasowo(db, SD, 'SKU', ['1', '8'], 'user:u1')).polaczone).toBe(0)
  })

  it('podgląd po EAN; zbiorcze zatwierdzenie propozycji ustawia MANUAL i przelicza zamówienia', async () => {
    const a = await product(db, 'A', 5)
    await db.product.update({ where: { id: a }, data: { ean: '5901234123457' } })
    await odczyt(db, ALLEGRO, '100', { ean: '5901234123457' })
    const plan = await planLaczenia(db, ALLEGRO, 'EAN')
    expect(plan.polaczy.map((x) => x.produkt?.id)).toEqual([a])

    const p = await db.channelOffer.create({ data: { ...SD, externalId: '600', productId: a, active: false, needsApproval: true, mappingSource: 'SKU', deactivatedByImportAt: T0 } })
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: '600', qty: 1 }]), { now: T0 })
    expect((await propozycjeKonta(db, SD)).map((x) => x.offerId)).toEqual([p.id])
    const w = await zatwierdzPropozycje(db, SD, [p.id, 'cudze'], 'user:u1')
    expect(w).toMatchObject({ polaczone: 1, pominiete: 1, remapped: 1 })
    expect(await db.channelOffer.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ active: true, needsApproval: false, mappingSource: 'MANUAL' })
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId! } })).status).toBe('DO_REALIZACJI')
    expect(await propozycjeKonta(db, SD)).toEqual([])
    await expectInvariants(db)
  })
})

describe('ręczne wskazanie towaru wFirmy', () => {
  async function towar(id: string, code: string | null, o: { unit?: string; type?: string } = {}) {
    await db.wfirmaGood.create({ data: { organizationId: 'test_a', id, code, name: `Towar wFirmy ${id}`, type: o.type ?? 'good', unit: o.unit ?? 'szt.', vatRate: '23', priceGrossRetail: '12.30', priceNetRetail: '10.00', importRunId: 'run-test' } })
  }

  it('produkt z SKU innym niż kod towaru dostaje towar; zajęty towar, inna jednostka i usługa = odmowa', async () => {
    const a = await product(db, 'HERB-A', 5)
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: 'g2' })
    const k = await product(db, 'HERB-KG', 5000, { unit: 'KG' })
    await towar('g1', 'HERB-A-50G')
    await towar('g2', 'HERB-B')
    await towar('g3', 'USLUGA', { type: 'service' })
    expect((await szukajTowarowWfirmy(db, 'herb-a')).map((x) => x.id)).toEqual(['g1'])
    expect((await szukajTowarowWfirmy(db, 'HERB-B'))[0]!.produkt).toMatchObject({ id: b })

    await expect(wskazTowarWfirmy(db, { productId: a, goodId: 'g2', actorId: 'user:u1' })).rejects.toThrow('HERB-B')
    await expect(wskazTowarWfirmy(db, { productId: a, goodId: 'g3', actorId: 'user:u1' })).rejects.toThrow('usług')
    await expect(wskazTowarWfirmy(db, { productId: k, goodId: 'g1', actorId: 'user:u1' })).rejects.toThrow('kilogramach')
    const w = await wskazTowarWfirmy(db, { productId: a, goodId: 'g1', actorId: 'user:u1' })
    expect(w.info).toContain('HERB-A-50G')
    expect(await db.product.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ sku: 'HERB-A', wfirmaGoodId: 'g1', dataSource: 'WFIRMA', nameAccounting: 'Towar wFirmy g1', vatRate: '23' })
    expect((await wskazTowarWfirmy(db, { productId: a, goodId: 'g1', actorId: 'user:u1' })).info).toContain('już powiązany')
    expect(await db.auditLog.count({ where: { entity: 'Product', entityId: a } })).toBe(1)
  })
})

describe('izolacja firm', () => {
  it('firma B nie widzi ofert ani powiązań firmy A i nie zmieni jej produktu', async () => {
    const a = await product(db, 'A', 5)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    await odczyt(db, SD, '501', { sku: 'A' })
    expect(await szukajOfert(dbB, 'A')).toEqual([])
    expect(await powiazaniaProduktu(dbB, a)).toEqual([])
    await expect(powiazZOferta(dbB, { productId: a, konto: SD, externalId: '502', sztuk: '1', actorId: 'user:b' })).rejects.toThrow('Nie ma takiego produktu')
    await expect(odlaczOferte(dbB, { productId: a, offerId, actorId: 'user:b' })).rejects.toThrow('Nie ma takiego powiązania')
    expect((await planLaczenia(dbB, SD, 'SKU')).sprawdzone).toBe(0)
    expect(await db.channelOffer.findUniqueOrThrow({ where: { id: offerId } })).toMatchObject({ active: true, productId: a })
  })
})

describe('ilość z kanału i zmiana przelicznika', () => {
  it('4 szt. przy przeliczniku 1 → zmiana na 2 (pozycja 8, rezerwacja 8) → przepięcie na B z przelicznikiem 1 → B 4 szt., A 0', async () => {
    const a = await product(db, 'A', 20)
    const b = await product(db, 'B', 20)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    const z = await ingestOrder(db, order([{ offerExternalId: '501', qty: 4 }]), { now: T0 })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: z.orderId! } })).toMatchObject({ qty: 4, qtyChannel: 4 })

    const w = await powiazZOferta(db, { productId: a, konto: SD, externalId: '501', sztuk: '2', actorId: 'user:u1' })
    expect(w.info).toContain('Przelicznik zmieniony z 1 na 2')
    expect(w.info).toContain('Przeliczone zamówienia: 1')
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: z.orderId! } })).toMatchObject({ productId: a, qty: 8, qtyChannel: 4 })
    expect((await stockOf(db, a)).reserved).toBe(8)
    expect(await db.orderEvent.count({ where: { orderId: z.orderId!, kind: 'ZMIANA_PRZELICZNIKA_OFERTY' } })).toBe(1)
    // powtórka tej samej zmiany: nic nowego
    expect((await powiazZOferta(db, { productId: a, konto: SD, externalId: '501', sztuk: '2', actorId: 'user:u1' })).info).toContain('już powiązana')

    await przepnijOferte(db, { productId: a, offerId, cel: b, sztuk: '1', actorId: 'user:u1' })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: z.orderId! } })).toMatchObject({ productId: b, qty: 4, qtyChannel: 4 })
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect((await stockOf(db, b)).reserved).toBe(4)
    await expectInvariants(db)
  })

  it('zmiana przelicznika w dół zwalnia różnicę; zamówienie zbierane blokuje zmianę z czytelnym komunikatem', async () => {
    const a = await product(db, 'A', 20)
    await offer(db, 'WOO_SD', '501', a, { qtyBasePerOffer: 3 })
    const z1 = await ingestOrder(db, order([{ offerExternalId: '501', qty: 2 }]), { now: T0 })
    expect((await stockOf(db, a)).reserved).toBe(6)
    await powiazZOferta(db, { productId: a, konto: SD, externalId: '501', sztuk: '1', actorId: 'user:u1' })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: z1.orderId! } })).toMatchObject({ qty: 2, qtyChannel: 2 })
    expect((await stockOf(db, a)).reserved).toBe(2)

    await db.order.update({ where: { id: z1.orderId! }, data: { status: 'ZBIERANIE' } })
    await expect(powiazZOferta(db, { productId: a, konto: SD, externalId: '501', sztuk: '5', actorId: 'user:u1' })).rejects.toThrow(/1 otwartych zamówień/)
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '501' } })).toMatchObject({ qtyBasePerOffer: 1 })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: z1.orderId! } })).toMatchObject({ qty: 2 })
  })

  it('pozycja sprzed migracji (bez ilości z kanału): przepięcie dzieli przez przelicznik z chwili przepięcia', async () => {
    const a = await product(db, 'A', 20)
    const b = await product(db, 'B', 20)
    const offerId = await offer(db, 'WOO_SD', '501', a, { qtyBasePerOffer: 2 })
    const z = await ingestOrder(db, order([{ offerExternalId: '501', qty: 3 }]), { now: T0 })
    await db.orderLine.updateMany({ where: { orderId: z.orderId! }, data: { qtyChannel: null } })
    await przepnijOferte(db, { productId: a, offerId, cel: b, sztuk: '2', actorId: 'user:u1' })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: z.orderId! } })).toMatchObject({ productId: b, qty: 6, qtyChannel: 3 })
    await expectInvariants(db)
  })
})

describe('„Pobierz oferty” po odłączeniu', () => {
  it('odłączona oferta zostaje na liście „Do przypisania” i nieaktywna po kolejnym pobraniu (atrapa adaptera, tylko odczyt)', async () => {
    const a = await product(db, 'A', 10)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    await odczyt(db, SD, '501', { sku: 'A', state: 'POWIAZANA' })
    await odlaczOferte(db, { productId: a, offerId, actorId: 'user:u1' })
    const wiersze: ChannelOfferRow[] = [{ externalId: '501', sku: 'A', ean: null, name: 'Oferta testowa 501', qty: 4, active: true }]
    let odczyty = 0
    const atrapa = {
      manifest: { capabilities: ['offers.read'] },
      listOffers: async () => {
        odczyty++
        return { items: wiersze, nextCursor: null }
      },
    } as unknown as ChannelAdapter
    const wynik = await pobierzOferty(db, SD, atrapa, { hasBl: false, hasWfirma: false, actorId: 'test', now: T0 })
    expect(odczyty).toBe(1)
    expect(wynik.rozjazdy).toEqual([])
    expect((await doPrzypisania(db, SD)).map((x) => x.externalId)).toEqual(['501'])
    expect(await db.channelOfferRead.findFirstOrThrow({ where: { externalId: '501' } })).toMatchObject({ state: 'BEZ_PRODUKTU', note: 'odłączona w panelu' })
    expect(await db.channelOffer.findUniqueOrThrow({ where: { id: offerId } })).toMatchObject({ active: false, productId: a, mappingSource: 'MANUAL' })
  })
})

describe('wyścig z przyjęciem zamówienia i reszta', () => {
  // Atrapa wyścigu bez zgadywania czasu: po odczycie listy zamówień do przepięcia (n-ty raz) przychodzi zamówienie,
  // które przyjęcie policzyło jeszcze ze starym produktem (oferta czytana przed zapisem przepięcia).
  function zWyscigiem(d: PrismaClient, a: string, poOdczycie: (n: number) => Promise<void>): PrismaClient {
    let n = 0
    const order = new Proxy(d.order, {
      get(t, k) {
        const v = Reflect.get(t, k)
        if (k !== 'findMany') return typeof v === 'function' ? v.bind(t) : v
        return async (args: { where?: { lines?: { some?: { productId?: unknown } } } }) => {
          const r = await (v as (x: unknown) => Promise<unknown>).call(t, args)
          if (args?.where?.lines?.some?.productId === a) await poOdczycie(++n)
          return r
        }
      },
    })
    return new Proxy(d, {
      get(t, k) {
        if (k === 'order') return order
        const v = Reflect.get(t, k)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  }

  async function staryOdczyt(a: string, offerId: string) {
    const teraz = await db.channelOffer.findUniqueOrThrow({ where: { id: offerId } })
    await db.channelOffer.update({ where: { id: offerId }, data: { productId: a } })
    await ingestOrder(db, order([{ offerExternalId: '501', qty: 1 }]), { now: T0 })
    await db.channelOffer.update({ where: { id: offerId }, data: { productId: teraz.productId } })
  }

  it('zamówienie przyjęte w trakcie (po pierwszej liście) dostaje nowy produkt w drugim przebiegu, bez alertu reszty', async () => {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 10)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    await ingestOrder(db, order([{ offerExternalId: '501', qty: 2 }]), { now: T0 })
    const d = zWyscigiem(db, a, async (n) => {
      if (n === 1) await staryOdczyt(a, offerId)
    })
    const w = await przepnijOferte(d, { productId: a, offerId, cel: b, sztuk: '1', actorId: 'user:u1' })
    expect(w.przepiete).toBe(2)
    expect(await db.orderLine.count({ where: { offerId: '501', productId: a } })).toBe(0)
    expect((await stockOf(db, b)).reserved).toBe(3)
    expect(await db.alert.count({ where: { kind: 'PRZEPIECIE_OFERTY_RESZTA' } })).toBe(0)
    await expectInvariants(db)
  })

  it('zamówienie przyjęte po drugim przebiegu: alert PRZEPIECIE_OFERTY_RESZTA z numerem i informacja w wyniku', async () => {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 10)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    const d = zWyscigiem(db, a, async (n) => {
      if (n === 2) await staryOdczyt(a, offerId)
    })
    const w = await przepnijOferte(d, { productId: a, offerId, cel: b, sztuk: '1', actorId: 'user:u1' })
    expect(w.info).toContain('Nie udało się przeliczyć 1')
    const reszta = await db.alert.findMany({ where: { kind: 'PRZEPIECIE_OFERTY_RESZTA' } })
    expect(reszta).toHaveLength(1)
    const zostalo = await db.orderLine.findFirstOrThrow({ where: { offerId: '501', productId: a } })
    expect(reszta[0]!.message).toContain(zostalo.orderId)
    expect(await db.alert.count({ where: { kind: 'PRZEPIECIE_OFERTY_W_TOKU', closedAt: null } })).toBe(0)
  })

  it('zbierane i „Do wyjaśnienia” ze zbierania zostają przy starym produkcie (powód: etap), bez alertu reszty', async () => {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 10)
    const offerId = await offer(db, 'WOO_SD', '501', a)
    const z1 = await ingestOrder(db, order([{ offerExternalId: '501', qty: 1 }]), { now: T0 })
    const z2 = await ingestOrder(db, order([{ offerExternalId: '501', qty: 1 }]), { now: T0 })
    await db.order.update({ where: { id: z1.orderId! }, data: { status: 'ZBIERANIE' } })
    await db.order.update({ where: { id: z2.orderId! }, data: { status: 'DO_WYJASNIENIA', statusBeforeClarify: 'ZBIERANIE' } })
    const w = await przepnijOferte(db, { productId: a, offerId, cel: b, sztuk: '1', actorId: 'user:u1' })
    expect(w).toMatchObject({ przepiete: 0, pominiete: 2 })
    expect(w.info).toContain('już zbierane')
    expect(await db.orderLine.count({ where: { offerId: '501', productId: a } })).toBe(2)
    expect(await db.alert.count({ where: { kind: 'PRZEPIECIE_OFERTY_RESZTA' } })).toBe(0)
  })
})

describe('wybór celu i zapis warunkowy', () => {
  it('wyszukiwarka celu: dokładne SKU pierwsze, bez produktu źródłowego, z dostępnym stanem', async () => {
    const a = await product(db, 'D-001', 10)
    await product(db, 'D-0011', 7)
    const c = await product(db, 'D-001X', 3)
    await db.product.update({ where: { id: c }, data: { title: 'Przyprawa docelowa fikcyjna' } })
    const wyn = await szukajProduktowDoPrzepiecia(db, 'd-001', 'nikt')
    expect(wyn[0]!.sku).toBe('D-001')
    expect((await szukajProduktowDoPrzepiecia(db, 'D-001', a)).map((x) => x.sku).sort()).toEqual(['D-0011', 'D-001X'])
    expect((await szukajProduktowDoPrzepiecia(db, 'docelowa', a)).map((x) => ({ sku: x.sku, dostepne: x.dostepne }))).toEqual([{ sku: 'D-001X', dostepne: 3 }])
    expect(await szukajProduktowDoPrzepiecia(db, 'x', a)).toEqual([])
  })

  it('masowe łączenie: oferta powiązana aktywnie między podglądem a wykonaniem = pominięta, nie nadpisana', async () => {
    const a = await product(db, 'SKU-A', 5)
    const b = await product(db, 'SKU-B', 5)
    await odczyt(db, SD, '1', { sku: 'SKU-A' })
    const plan = await planLaczenia(db, SD, 'SKU')
    expect(plan.polaczy.map((x) => x.externalId)).toEqual(['1'])
    // ktoś inny w międzyczasie: oferta 1 → produkt B (aktywnie)
    await offer(db, 'WOO_SD', '1', b)
    const w = await polaczMasowo(db, SD, 'SKU', ['1'], 'user:u1')
    expect(w).toMatchObject({ polaczone: 0, bledy: 0 })
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '1' } })).toMatchObject({ productId: b, active: true })
    expect(a).toBeTruthy()
  })
})

describe('pozycje bez ilości z kanału i podzamówienia', () => {
  it('pozycja bez ilości z kanału, której ilość nie dzieli się przez obecny przelicznik: zmiana przelicznika odmówiona, oferta zostaje z 3', async () => {
    const a = await product(db, 'A', 20)
    await offer(db, 'WOO_SD', '501', a, { qtyBasePerOffer: 3 })
    const z = await ingestOrder(db, order([{ offerExternalId: '501', qty: 1 }]), { now: T0 })
    await db.orderLine.updateMany({ where: { orderId: z.orderId! }, data: { qty: 4, qtyChannel: null } })
    await expect(powiazZOferta(db, { productId: a, konto: SD, externalId: '501', sztuk: '1', actorId: 'user:u1' })).rejects.toThrow(/nie dzieli się przez przelicznik/)
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '501' } })).toMatchObject({ qtyBasePerOffer: 3 })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: z.orderId! } })).toMatchObject({ qty: 4, qtyChannel: null })
    // ta sama pozycja z ilością podzielną (6 = 2 × 3) nie blokuje
    await db.orderLine.updateMany({ where: { orderId: z.orderId! }, data: { qty: 6 } })
    await expect(powiazZOferta(db, { productId: a, konto: SD, externalId: '501', sztuk: '1', actorId: 'user:u1' })).resolves.toMatchObject({ remapped: 0 })
  })

  it('podział zamówienia (#paczka) i dosłanie (#dosle) kopiują ilość z kanału pozycji z ofertą', async () => {
    const a = await product(db, 'A', 20)
    await offer(db, 'WOO_SD', '501', a, { qtyBasePerOffer: 3 })
    const z = await ingestOrder(db, order([{ offerExternalId: '501', qty: 2 }]), { now: T0 })
    const l = await db.orderLine.findFirstOrThrow({ where: { orderId: z.orderId! } })
    expect(l).toMatchObject({ qty: 6, qtyChannel: 2 })
    const { childOrderId } = await splitOrder(db, z.orderId!, { [l.id]: 3 }, { now: T0 })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: childOrderId } })).toMatchObject({ offerId: '501', qty: 3, qtyChannel: 1 })

    const brak = await product(db, 'BRAK', 0)
    await offer(db, 'WOO_SD', '502', brak, { qtyBasePerOffer: 3 })
    const z2 = await ingestOrder(db, order([{ offerExternalId: '502', qty: 1 }], { externalId: 'W5-DOSLE' }), { now: T0 })
    const l2 = await db.orderLine.findFirstOrThrow({ where: { orderId: z2.orderId! } })
    const { childOrderId: dosle } = await shipLater(db, l2.id, { now: T0 })
    expect(await db.orderLine.findFirstOrThrow({ where: { orderId: dosle } })).toMatchObject({ offerId: '502', qty: 3, qtyChannel: 1 })
    await expectInvariants(db)
  })
})
