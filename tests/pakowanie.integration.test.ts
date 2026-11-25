// kolejka pakowania na bazie — dwie firmy bez przecieków, „Przyjechał” przesuwa grupę, filtr strefy,
// lista wysyłkowa tylko z zamówień własnej firmy, odmowa klienta systemowego, ustawienia z historią zmian.
// Dane wyłącznie zmyślone (produkty i zamówienia testowe, bez danych osobowych).
import type { Carrier, OrderStatus, PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyOrgPreset } from '@/lib/organizacje'
import { PRZYKLADOWE_ODBIORY as ACME_EXAMPLE_PICKUPS } from './pakowanie-fixtures'
import {
  markCarrierArrived,
  packingQueue,
  parseOrderIds,
  pickupSettings,
  productZoneInfo,
  saveCarrierPickup,
  setProductZone,
  shippingListData,
  SHIPPING_LIST_LIMIT,
} from '@/lib/pakowanie/dane'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { listaWysylkowa } from '@/lib/wydruki/lista-wysylkowa'
import { ACME_EXAMPLE_ZONE_RULES, ACME_PRESET } from '@/tests/preset-testowy'
import { LEGACY_ZONES } from '@/lib/pakowanie/strefy'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, seedBase, type TestChannel } from './rdzen-fixtures'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
// wtorek 27.10.2026, 11:00 w Warszawie (CET); DPD 13:00, InPost 14:30, Allegro 15:00 (przykładowe godziny ACME)
const NOW = new Date('2026-10-27T10:00:00Z')

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) {
    await seedBase(db)
    await db.carrierPickup.createMany({ data: ACME_EXAMPLE_PICKUPS })
    // strefy firmy (jak po migracji dla firm z regułami stref)
    await db.packingZoneDef.createMany({ data: LEGACY_ZONES.map((z) => ({ ...z })) })
    await db.productZoneRule.createMany({ data: ACME_EXAMPLE_ZONE_RULES })
  }
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function prod(db: PrismaClient, sku: string, title: string, zone: string | null = null): Promise<string> {
  const p = await db.product.create({ data: { sku, kind: 'STOCKED', unit: 'SZT', nameAccounting: title, title, packingZone: zone } })
  await db.stock.create({ data: { productId: p.id, warehouseId: DEFAULT_WAREHOUSE, wfirmaCount: 100, physical: 100, wfirmaReadAt: new Date('2026-01-01T00:00:00Z') } })
  return p.id
}

async function ord(db: PrismaClient, productIds: string[], o: { carrier: Carrier; status?: OrderStatus; channel?: TestChannel; packedAt?: Date; at?: Date }): Promise<string> {
  const r = await ingestOrder(db, order(productIds.map((productId) => ({ productId, qty: 1 })), { channel: o.channel ?? 'WOO_SD', createdAtChannel: o.at ?? new Date('2026-10-27T07:00:00Z') }))
  const id = r.orderId!
  await db.order.update({ where: { id }, data: { carrier: o.carrier, status: o.status ?? 'DO_REALIZACJI' } })
  if (o.packedAt) await db.orderEvent.create({ data: { orderId: id, kind: 'SPAKOWANE', actorId: 'test', createdAt: o.packedAt } })
  return id
}

const ids = (q: Awaited<ReturnType<typeof packingQueue>>) => q.groups.flatMap((g) => g.orders.map((o) => o.id))

describe('kolejka pakowania na bazie', () => {
  it('dwie firmy: każda widzi tylko swoje zamówienia, harmonogram i kliknięcia „Przyjechał”', async () => {
    const ha = await prod(a, 'H1', 'Przyprawa zielona testowa')
    const hb = await prod(b, 'H1', 'Kawa firmy B')
    const oa = await ord(a, [ha], { carrier: 'DPD' })
    const ob = await ord(b, [hb], { carrier: 'DPD' })
    const ob2 = await ord(b, [hb], { carrier: 'PACZKOMATY', status: 'ZEBRANE' })

    const qa = await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)
    expect(ids(qa)).toEqual([oa])
    expect(qa.groups.flatMap((g) => g.orders.flatMap((o) => o.lines.map((l) => l.title)))).toEqual(['Przyprawa zielona testowa'])
    const qb = await packingQueue(b, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)
    expect(ids(qb).sort()).toEqual([ob, ob2].sort())

    // „Przyjechał DPD” w firmie A nie zamyka odbioru DPD firmy B
    await markCarrierArrived(a, { carrier: 'DPD', actorId: 'u-a', actorName: 'Magazyn A', now: NOW })
    expect(await b.carrierPickupEvent.count()).toBe(0)
    const dpdB = (await packingQueue(b, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)).groups.find((g) => g.carrier === 'DPD')!
    expect(dpdB.pickup!.day).toBe('2026-10-27')
    expect(dpdB.lastArrival).toBeNull()
    expect((await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)).groups.find((g) => g.carrier === 'DPD')!.pickup!.day).toBe('2026-10-28')

    // zmiana harmonogramu A nie rusza B
    await saveCarrierPickup(a, { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 11 * 60, promiseUntilMinute: 10 * 60, active: true }, 'u-a')
    expect((await pickupSettings(b)).find((s) => s.carrier === 'DPD')!.pickupMinute).toBe(13 * 60)
    // statusy przed wysyłką: wysłane i nowe nie wchodzą
    await a.order.update({ where: { id: oa }, data: { status: 'WYSLANE' } })
    expect(ids(await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW))).toEqual([])
  })

  it('zakładki: konta w pracy (statusMode PRACA) = „Naprawdę”, w cieniu = „Na sucho”; „Czekają na etykietę” pusta', async () => {
    const p = await prod(a, 'H1', 'Przyprawa czarna')
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })
    const naprawde = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    const sucho = await ord(a, [p], { carrier: 'DPD' })
    const q = await packingQueue(a, { tab: 'naprawde', zone: 'wszystkie' }, NOW)
    expect(ids(q)).toEqual([naprawde])
    expect(q.groups.find((g) => g.carrier === 'ALLEGRO')!.orders[0]!.mode).toBe('PRACA')
    expect(q.tabCounts).toEqual({ naprawde: 1, na_sucho: 1, etykiety: 0 })
    expect(ids(await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW))).toEqual([sucho])
    expect(ids(await packingQueue(a, { tab: 'etykiety', zone: 'wszystkie' }, NOW))).toEqual([])
  })

  it('spakowane sprzed okna 14 dni nie zajmują limitu kolejki — nowe zamówienie widoczne, nadmiar policzony', async () => {
    const p = await prod(a, 'H1', 'Przyprawa zielona')
    const old = new Date('2026-09-20T08:00:00Z')
    for (let i = 0; i < 3; i++) {
      const id = await ord(a, [p], { carrier: 'DPD', status: 'SPAKOWANE', packedAt: old, at: new Date(old.getTime() + i * 60_000) })
      await a.order.update({ where: { id }, data: { updatedAt: old } })
    }
    const fresh = await ord(a, [p], { carrier: 'DPD' })
    const q = await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie', limit: 3 }, NOW)
    expect(ids(q)).toEqual([fresh])
    expect(q).toMatchObject({ truncated: false, hidden: 0 })

    // w oknie: spakowane się liczą, a to, co nie weszło w limit, ma liczbę na banerze
    const fresh2 = await ord(a, [p], { carrier: 'DPD', at: new Date('2026-10-27T08:00:00Z') })
    const cut = await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie', limit: 1 }, NOW)
    expect(ids(cut)).toEqual([fresh])
    expect(cut).toMatchObject({ truncated: true, hidden: 1 })
    expect(ids(await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW))).toEqual([fresh, fresh2])
  })

  it('numer na kolejce taki sam jak na liście Zamówień (UUID Allegro w całości)', async () => {
    const p = await prod(a, 'H1', 'Przyprawa czerwona')
    const id = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    const uuid = '9b21a0c4-44e0-4b1a-9d1e-0123456789ab'
    await a.order.update({ where: { id }, data: { externalId: uuid } })
    const row = (await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)).groups.flatMap((g) => g.orders).find((o) => o.id === id)!
    expect(row.externalId).toBe(uuid)
    expect(row.number).toBe(`ALG ${uuid}`)
  })

  it('„Przyjechał” przesuwa grupę: spakowane przed kliknięciem pojechały, spakowane później czekają na jutro; drugie kliknięcie nic nie zmienia', async () => {
    const p = await prod(a, 'H1', 'Przyprawa biała')
    const packedBefore = await ord(a, [p], { carrier: 'DPD', status: 'SPAKOWANE', packedAt: new Date('2026-10-27T09:30:00Z') })
    const open = await ord(a, [p], { carrier: 'DPD' })
    const inpost = await ord(a, [p], { carrier: 'PACZKOMATY' })

    const before = await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)
    expect(before.groups.map((g) => g.carrier)).toEqual(['DPD', 'DPD_EMPIK', 'PACZKOMATY', 'ALLEGRO']) // DPD do salonu Empik też o 13:00
    expect(before.groups[0]).toMatchObject({ toPack: 1, packed: 1, handedOver: 0, minutesLeft: 120 })

    const arrivedAt = new Date('2026-10-27T11:42:00Z') // 12:42
    const r = await markCarrierArrived(a, { carrier: 'DPD', actorId: 'u-mag', actorName: 'Magazyn testowy', now: arrivedAt })
    expect(r.created).toBe(true)
    expect(r.arrival).toMatchObject({ carrier: 'DPD', pickupDay: '2026-10-27', actorName: 'Magazyn testowy' })
    expect(r.next!.day).toBe('2026-10-28')

    // po odbiorze ktoś pakuje kolejne — liczy się do następnego odbioru
    const packedAfter = await ord(a, [p], { carrier: 'DPD', status: 'SPAKOWANE', packedAt: new Date('2026-10-27T11:50:00Z') })
    const later = new Date('2026-10-27T12:00:00Z')
    const q = await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, later)
    expect(q.groups.map((g) => g.carrier)).toEqual(['DPD_EMPIK', 'PACZKOMATY', 'ALLEGRO', 'DPD'])
    const dpd = q.groups.find((g) => g.carrier === 'DPD')!
    expect(dpd.pickup!.day).toBe('2026-10-28')
    expect(dpd.orders.map((o) => o.id)).toEqual([open, packedAfter])
    expect(dpd).toMatchObject({ toPack: 1, packed: 1, handedOver: 1 })
    expect(ids(q)).not.toContain(packedBefore)
    expect(q.groups.find((g) => g.carrier === 'PACZKOMATY')!.orders.map((o) => o.id)).toEqual([inpost])

    // podwójne kliknięcie tego dnia: bez nowego wpisu, jutrzejszy odbiór zostaje otwarty
    const again = await markCarrierArrived(a, { carrier: 'DPD', actorId: 'u-mag', actorName: 'Magazyn testowy', now: later })
    expect(again.created).toBe(false)
    expect(again.arrival.arrivedAt.toISOString()).toBe(arrivedAt.toISOString())
    expect(await a.carrierPickupEvent.count()).toBe(1)
    expect(again.next!.day).toBe('2026-10-28')
    await expect(markCarrierArrived(a, { carrier: 'BRAK', actorId: 'x', actorName: 'x', now: later })).rejects.toThrow(/przewoźnik/)
  })

  it('zdarzenia odbioru tylko dopisywane: rola aplikacji nie zmieni ani nie usunie kliknięcia', async () => {
    await markCarrierArrived(a, { carrier: 'ALLEGRO', actorId: 'u', actorName: 'Magazyn', now: NOW })
    await expect(a.carrierPickupEvent.updateMany({ data: { actorName: 'ktoś inny' } })).rejects.toThrow()
    await expect(a.carrierPickupEvent.deleteMany({})).rejects.toThrow()
    expect(await a.carrierPickupEvent.count()).toBe(1)
  })

  it('filtr strefy: liczby i lista z reguł firmy i ręcznego ustawienia na produkcie', async () => {
    const przyprawa = await prod(a, 'H1', 'Przyprawa czarna Assam')
    const kawa = await prod(a, 'K1', 'Kawa ziarnista')
    const lampa = await prod(a, 'B1', 'Lampa przyprawowa malinowa')
    const inny = await prod(a, 'X1', 'Karta podarunkowa')
    const reczna = await prod(a, 'X2', 'Puszka na przyprawę', 'HERBATY_KAWY') // reguła dałaby akcesoria
    const oH = await ord(a, [przyprawa, kawa], { carrier: 'DPD' })
    const oH2 = await ord(a, [reczna], { carrier: 'PACZKOMATY' })
    const oB = await ord(a, [lampa], { carrier: 'DPD' })
    const oM = await ord(a, [przyprawa, lampa], { carrier: 'ALLEGRO' })
    const oM2 = await ord(a, [kawa, inny], { carrier: 'DPD' })
    const oX = await ord(a, [inny], { carrier: 'DPD' })

    const q = await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)
    expect(q.zoneCounts).toEqual({ wszystkie: 6, mieszane: 2, bez: 1, strefy: { HERBATY_KAWY: 2, BOMBY_AKCESORIA: 1 } })
    expect(q.zones.map((z) => z.name)).toEqual(['produkty spożywcze', 'akcesoria'])
    // klucz strefy w adresie i stare adresy sprzed stref firmy (herbaty, bomby) dają ten sam filtr
    expect(ids(await packingQueue(a, { tab: 'na_sucho', zone: 'HERBATY_KAWY' }, NOW)).sort()).toEqual([oH, oH2].sort())
    expect(ids(await packingQueue(a, { tab: 'na_sucho', zone: 'herbaty' }, NOW)).sort()).toEqual([oH, oH2].sort())
    expect(ids(await packingQueue(a, { tab: 'na_sucho', zone: 'bomby' }, NOW))).toEqual([oB])
    expect(ids(await packingQueue(a, { tab: 'na_sucho', zone: 'mieszane' }, NOW)).sort()).toEqual([oM, oM2].sort())
    expect(ids(q)).toContain(oX)
    // pasek kuriera liczy całą zakładkę, nie filtr: DPD ma 4 do spakowania także przy filtrze „lampy”
    const dpd = (await packingQueue(a, { tab: 'na_sucho', zone: 'bomby' }, NOW)).groups.find((g) => g.carrier === 'DPD')!
    expect(dpd.toPack).toBe(4)
    expect(dpd.orders.map((o) => o.id)).toEqual([oB])

    // ręczna zmiana strefy w karcie produktu przesuwa zamówienie między filtrami; powrót do reguły też
    expect(await productZoneInfo(a, reczna)).toMatchObject({ zone: 'HERBATY_KAWY', source: 'RECZNIE', manual: 'HERBATY_KAWY', byRule: 'BOMBY_AKCESORIA' })
    // strefa spoza listy firmy odrzucona
    await expect(setProductZone(a, reczna, 'INNA', 'u-a')).rejects.toThrow(/Nieznana strefa/)
    expect(await setProductZone(a, reczna, null, 'u-a')).toBe(true)
    expect((await packingQueue(a, { tab: 'na_sucho', zone: 'bomby' }, NOW)).zoneCounts.strefy).toEqual({ HERBATY_KAWY: 1, BOMBY_AKCESORIA: 2 })
    expect(await a.auditLog.count({ where: { entity: 'Product.packingZone', entityId: reczna } })).toBe(1)
    // cudzy produkt: niewidoczny, bez zmiany
    expect(await setProductZone(b, przyprawa, 'BOMBY_AKCESORIA', 'u-b')).toBe(false)
    expect(await productZoneInfo(b, przyprawa)).toBeNull()
    expect((await a.product.findUniqueOrThrow({ where: { id: przyprawa } })).packingZone).toBeNull()
  })

  it('e-book (DIGITAL) nie jest do spakowania — poza wierszem i strefą; zamówienie z samym e-bookiem poza kolejką', async () => {
    const przyprawa = await prod(a, 'H9', 'Kurkuma mielona')
    const ebook = (await a.product.create({ data: { sku: 'EBOOK-9', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book testowy', title: 'E-book testowy', vatRate: '5' } })).id
    const oMix = await ord(a, [przyprawa, ebook], { carrier: 'DPD' })
    const oSam = await ord(a, [ebook], { carrier: 'DPD' })
    const q = await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)
    expect(ids(q)).toContain(oMix)
    expect(ids(q)).not.toContain(oSam)
    const row = q.groups.flatMap((g) => g.orders).find((o) => o.id === oMix)!
    expect(row.zone).toBe('HERBATY_KAWY')
    expect(row.lines.map((l) => l.sku)).toEqual(['H9'])
  })

  it('lista wysyłkowa: tylko zamówienia własnej firmy, PDF się składa, limit 200', async () => {
    const pa = await prod(a, 'H1', 'Przyprawa A')
    const pb = await prod(b, 'H1', 'Przyprawa B')
    const oa1 = await ord(a, [pa], { carrier: 'DPD', status: 'SPAKOWANE' })
    const oa2 = await ord(a, [pa], { carrier: 'DPD', status: 'SPAKOWANE' })
    const ob = await ord(b, [pb], { carrier: 'DPD', status: 'SPAKOWANE' })

    const d = (await shippingListData(a, [oa1, ob, oa2], { now: NOW, drukujacy: 'Magazyn A' }))!
    expect(d.zamowienia).toHaveLength(2)
    expect(d.zamowienia.every((z) => z.przewoznik === 'DPD')).toBe(true)
    expect(d.dataOdbioru.toISOString()).toBe('2026-10-27T12:00:00.000Z') // najbliższy odbiór DPD
    expect(d.opisOdbioru).toBe('DPD — odbiór dziś 13:00')
    // dane odbiorcy nie istnieją w rdzeniu — puste, bez danych osobowych
    expect(d.zamowienia.every((z) => !z.odbiorca.imie && !z.odbiorca.nazwisko && !z.odbiorca.miasto)).toBe(true)
    expect(await shippingListData(a, [ob], { now: NOW, drukujacy: 'Magazyn A' })).toBeNull()
    expect(await shippingListData(b, [oa1, oa2], { now: NOW, drukujacy: 'Biuro B' })).toBeNull()
    const pdf = await listaWysylkowa(d)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')

    const many = Array.from({ length: SHIPPING_LIST_LIMIT + 1 }, (_, i) => `id${i}`).join(',')
    expect(parseOrderIds(many)).toMatchObject({ tooMany: true })
    expect(parseOrderIds(many).ids).toHaveLength(SHIPPING_LIST_LIMIT)
    expect(parseOrderIds(`${oa1},${oa1}, x' OR 1=1 --,`).ids).toEqual([oa1])
  })

  it('wiersz kolejki pokazuje wynik ćwiczenia na sucho po zamknięciu okna', async () => {
    const p = await prod(a, 'H1', 'Przyprawa biała')
    const o1 = await ord(a, [p], { carrier: 'DPD' })
    const o2 = await ord(a, [p], { carrier: 'DPD' })
    const o3 = await ord(a, [p], { carrier: 'DPD' })
    const d = { actorId: 'u', startedAt: NOW, finishedAt: NOW }
    await a.packDrill.createMany({ data: [{ orderId: o1, outcome: 'NIE_SPAKOWANO', ...d }, { orderId: o1, outcome: 'SPAKOWANE', ...d }, { orderId: o2, outcome: 'NIE_SPAKOWANO', ...d }] })
    const q = await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)
    const wiersz = new Map(q.groups.flatMap((g) => g.orders).map((r) => [r.id, r.cwiczenie]))
    expect([wiersz.get(o1), wiersz.get(o2), wiersz.get(o3)]).toEqual(['SPAKOWANE', 'NIE_SPAKOWANO', null])
  })

  it('lista wysyłkowa i karta liczą numer jedną funkcją: Woo z numerem wtyczki i dosyłka', async () => {
    const p = await prod(a, 'H1', 'Przyprawa biała')
    const woo = await ord(a, [p], { carrier: 'DPD' })
    const g = await a.order.update({ where: { id: woo }, data: { externalId: 'wc-abc' } })
    const t = new Date()
    await a.channelOrderSnapshot.create({
      data: { channel: g.channel, channelAccountId: g.channelAccountId, externalId: 'wc-abc', channelNumber: '48213', revision: '1', channelStatus: 'processing', lifecycle: 'OPEN', paymentState: 'PAID', totalGross: 10, currency: 'PLN', lineCount: 1, warnings: [], createdAtChannel: t, firstSeenAt: t, lastSeenAt: t },
    })
    const dos = await a.order.create({
      data: { channel: g.channel, channelAccountId: g.channelAccountId, externalId: 'wc-abc/2', parentOrderId: woo, packageNo: 2, status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: 0, createdAtChannel: t, carrier: 'DPD' },
    })
    await a.orderLine.create({ data: { orderId: dos.id, externalLineId: 'L1', productId: p, qty: 1, unitPriceGross: 10 } })
    const d = (await shippingListData(a, [woo, dos.id], { now: NOW, drukujacy: 'Magazyn A' }))!
    const karty = await wczytajZamowienia(a, [woo, dos.id])
    expect(karty.map((k) => k.numerKarty)).toEqual([expect.objectContaining({ numer: '48213', podzamowienie: null }), expect.objectContaining({ numer: '48213', podzamowienie: 2 })])
    for (const k of karty) expect(d.zamowienia.map((z) => z.zamowienie)).toContainEqual(k.numerKarty)
  })

  it('numer na liście wysyłkowej jak kod karty (Allegro UUID → numer z BaseLinkera); bez numeru pełny id', async () => {
    const p = await prod(a, 'H1', 'Przyprawa biała')
    const zBl = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    const bezNr = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    await a.order.update({ where: { id: zBl }, data: { externalId: '9b21a0c4-44e0-4b1a-9d1e-0123456789ab', blOrderId: 7712345 } })
    await a.order.update({ where: { id: bezNr }, data: { externalId: '1c2d3e4f-0000-4b1a-9d1e-0123456789ab', blOrderId: null } })
    const d = (await shippingListData(a, [zBl, bezNr], { now: NOW, drukujacy: 'Magazyn A' }))!
    const karta = (await wczytajZamowienia(a, [zBl]))[0]!
    expect(karta.numerKarty).not.toBeNull()
    // pozycja listy nie niesie id zamówienia — rozpoznajemy po numerze
    const numery = d.zamowienia.map((z) => z.zamowienie)
    expect(numery).toHaveLength(2)
    expect(numery).toContainEqual({ przedrostek: karta.numerKarty!.przedrostek, numer: '7712345', podzamowienie: null })
    expect(numery.map((n) => n.numer)).toContain('1c2d3e4f-0000-4b1a-9d1e-0123456789ab')
    expect(numery.map((n) => n.numer)).not.toContain('9b21a0c4-44e0-4b1a-9d1e-0123456789ab')
    expect((await listaWysylkowa(d)).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('odczyty i zapisy kolejki odmawiają klienta systemowego (przez wszystkie firmy)', async () => {
    await expect(packingQueue(sys, { tab: 'na_sucho', zone: 'wszystkie' })).rejects.toThrow(/klienta firmy/)
    await expect(markCarrierArrived(sys, { carrier: 'DPD', actorId: 'x', actorName: 'x' })).rejects.toThrow(/klienta firmy/)
    await expect(shippingListData(sys, ['x'], { drukujacy: 'x' })).rejects.toThrow(/klienta firmy/)
    await expect(pickupSettings(sys)).rejects.toThrow(/klienta firmy/)
    await expect(setProductZone(sys, 'x', null, 'x')).rejects.toThrow(/klienta firmy/)
  })

  it('ustawienia odbiorów: walidacja, zapis zdejmuje „przykładowe”, zmiana w historii; przewoźnik bez wiersza = wyłączony', async () => {
    await a.carrierPickup.deleteMany({ where: { carrier: 'OSOBISTY' } })
    const before = await pickupSettings(a)
    expect(before.map((s) => s.carrier)).toEqual(['DPD', 'PACZKOMATY', 'ALLEGRO', 'DPD_EMPIK', 'OSOBISTY', 'INPOST_KURIER'])
    expect(before.find((s) => s.carrier === 'DPD')!.example).toBe(true)
    expect(before.find((s) => s.carrier === 'OSOBISTY')!.active).toBe(false)
    await expect(saveCarrierPickup(a, { carrier: 'DPD', weekdays: [1], pickupMinute: 600, promiseUntilMinute: 700, active: true }, 'u')).rejects.toThrow(/później niż odbiór/)
    await saveCarrierPickup(a, { carrier: 'DPD', weekdays: [5, 1, 1], pickupMinute: 12 * 60 + 15, promiseUntilMinute: 11 * 60, active: true }, 'u-a')
    const dpd = (await pickupSettings(a)).find((s) => s.carrier === 'DPD')!
    expect(dpd).toMatchObject({ weekdays: [1, 5], pickupMinute: 735, promiseUntilMinute: 660, example: false })
    expect(await a.auditLog.count({ where: { entity: 'CarrierPickup', entityId: 'DPD' } })).toBe(1)
    await saveCarrierPickup(a, { carrier: 'OSOBISTY', weekdays: [1, 2, 3, 4, 5], pickupMinute: 16 * 60, promiseUntilMinute: 15 * 60, active: true }, 'u-a')
    expect((await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW)).groups.map((g) => g.carrier)).toContain('OSOBISTY')
  })

  it('wiersz odbioru „Orlen Paczka” tylko u firmy, która go używa (reguła, klucz konta albo zapisany harmonogram)', async () => {
    const lista = async (db: PrismaClient) => (await pickupSettings(db)).map((s) => s.carrier)
    // firma bez Orlenu (jak ACME): bez wiersza
    expect(await lista(a)).not.toContain('ORLEN_PACZKA')
    expect(await lista(b)).not.toContain('ORLEN_PACZKA')
    // reguła przewoźnika Orlen w firmie A → wiersz u A (wyłączony, godziny domyślne), B dalej bez
    await a.carrierRule.create({ data: { priority: 900, carrier: 'ORLEN_PACZKA', shippingModule: 'ORLEN_PACZKA', adapterKey: 'orlenpaczka.v1' } })
    expect((await pickupSettings(a)).find((s) => s.carrier === 'ORLEN_PACZKA')).toMatchObject({ active: false, example: false, pickupMinute: 14 * 60 })
    expect(await lista(b)).not.toContain('ORLEN_PACZKA')
    // klucz konta Orlenu (także drugie konto z sufiksem) w firmie B → wiersz u B
    await b.integrationSecret.create({ data: { name: 'ORLEN_PARTNER_ID_MAG2', ciphertext: Buffer.from('x'), iv: Buffer.alloc(12), authTag: Buffer.alloc(16) } })
    expect(await lista(b)).toContain('ORLEN_PACZKA')
    // po usunięciu reguły zapisany harmonogram trzyma wiersz (nie znika po cichu)
    await saveCarrierPickup(a, { carrier: 'ORLEN_PACZKA', weekdays: [1, 2, 3, 4, 5], pickupMinute: 15 * 60, promiseUntilMinute: 14 * 60, active: true }, 'u-a')
    await a.carrierRule.deleteMany({ where: { carrier: 'ORLEN_PACZKA' } })
    expect((await pickupSettings(a)).find((s) => s.carrier === 'ORLEN_PACZKA')).toMatchObject({ active: true, pickupMinute: 15 * 60 })
    // przewoźnicy podstawowi zawsze na liście, w tej samej kolejności
    expect((await lista(a)).slice(0, 6)).toEqual(['DPD', 'PACZKOMATY', 'ALLEGRO', 'DPD_EMPIK', 'OSOBISTY', 'INPOST_KURIER'])
  })

  it('seed ACME zakłada godziny właściciela (DPD 12:00, InPost 15:30, Allegro 14:00) i przykładowe reguły stref tylko firmie, która nie ma żadnych', async () => {
    await applyOrgPreset(sys, ACME_PRESET)
    const rows = await sys.carrierPickup.findMany({ where: { organizationId: 'acme' }, orderBy: { carrier: 'asc' } })
    expect(rows.map((r) => [r.carrier, r.pickupMinute, r.example])).toEqual([
      ['PACZKOMATY', 930, false],
      ['DPD', 720, false],
      ['DPD_EMPIK', 720, false],
      ['ALLEGRO', 840, false],
    ])
    expect(await sys.productZoneRule.count({ where: { organizationId: 'acme', example: true } })).toBe(2)
    // preset ACME zakłada dawne strefy z kluczami jak w enum (nazwy neutralne)
    expect((await sys.packingZoneDef.findMany({ where: { organizationId: 'acme' }, orderBy: { sortOrder: 'asc' } })).map((z) => [z.key, z.name])).toEqual([
      ['HERBATY_KAWY', 'produkty spożywcze'],
      ['BOMBY_AKCESORIA', 'akcesoria'],
    ])
    await sys.carrierPickup.update({ where: { organizationId_carrier: { organizationId: 'acme', carrier: 'DPD' } }, data: { pickupMinute: 600, example: false } })
    await applyOrgPreset(sys, ACME_PRESET)
    expect((await sys.carrierPickup.findUniqueOrThrow({ where: { organizationId_carrier: { organizationId: 'acme', carrier: 'DPD' } } })).pickupMinute).toBe(600)
    expect(await sys.carrierPickup.count({ where: { organizationId: { in: [ORG_A] } } })).toBe(ACME_EXAMPLE_PICKUPS.length) // firmy testowe z beforeEach
  })
})

describe('zamówienia z fakturą z BaseLinkera po przełączeniu', () => {
  it('konto w pracy: z fakturą BL poza kolejką „do spakowania”, w ramce „kończy BaseLinker”; po „Pakuj mimo” wraca; podgląd bez zmian', async () => {
    const p = await prod(a, 'H1', 'Przyprawa czarna')
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })
    const zwykle = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    const zFaktura = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    const zKopii = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    const podglad = await ord(a, [p], { carrier: 'DPD' })
    await a.orderEvent.create({ data: { orderId: zFaktura, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 7/11' } } })
    await a.order.update({ where: { id: zKopii }, data: { blOrderId: 9101 } })
    await a.blInvoiceSnapshot.create({ data: { blInvoiceId: 9101, blOrderId: 9101, number: 'FV 8/11', kind: 'normal', dateAdd: NOW, fetchedAt: NOW } })
    // podgląd: faktura BL nie zdejmuje z pakowania próbnego
    await a.orderEvent.create({ data: { orderId: podglad, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 9/11' } } })
    const q = await packingQueue(a, { tab: 'naprawde', zone: 'wszystkie' }, NOW)
    expect(ids(q)).toEqual([zwykle])
    expect(q.konczyBl.map((z) => [z.id, z.faktura]).sort()).toEqual(
      [
        [zFaktura, 'FV 7/11'],
        [zKopii, 'FV 8/11'],
      ].sort(),
    )
    expect(q.tabCounts.naprawde).toBe(1)
    expect(ids(await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW))).toEqual([podglad])
    // świadoma decyzja z karty: zamówienie wraca do kolejki
    await a.order.update({ where: { id: zFaktura }, data: { flags: { pakujMimoFakturyBl: true } } })
    const q2 = await packingQueue(a, { tab: 'naprawde', zone: 'wszystkie' }, NOW)
    expect(ids(q2).sort()).toEqual([zwykle, zFaktura].sort())
    expect(q2.konczyBl.map((z) => z.id)).toEqual([zKopii])
  })

  it('firma bez BaseLinkera w trybie pracy: kolejka bez zmian, ramka pusta', async () => {
    const p = await prod(a, 'H1', 'Przyprawa czarna')
    await a.channelConfig.updateMany({ data: { statusMode: 'PRACA' } })
    const o1 = await ord(a, [p], { carrier: 'DPD' })
    const q = await packingQueue(a, { tab: 'naprawde', zone: 'wszystkie' }, NOW)
    expect(ids(q)).toEqual([o1])
    expect(q.konczyBl).toEqual([])
  })

  it('konto bez konfiguracji (rdzeń traktuje je jak tryb pracy i odmówi pakowania): z fakturą BL w ramce, poza kolejką', async () => {
    const p = await prod(a, 'H1', 'Przyprawa czarna')
    const zwykle = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    const zFaktura = await ord(a, [p], { carrier: 'ALLEGRO', channel: 'ALLEGRO' })
    await a.orderEvent.create({ data: { orderId: zFaktura, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 10/11' } } })
    await a.channelConfig.deleteMany({ where: { channel: 'ALLEGRO' } })
    const wszystkie = [...ids(await packingQueue(a, { tab: 'naprawde', zone: 'wszystkie' }, NOW)), ...ids(await packingQueue(a, { tab: 'na_sucho', zone: 'wszystkie' }, NOW))]
    expect(wszystkie).toContain(zwykle)
    expect(wszystkie).not.toContain(zFaktura)
    expect((await packingQueue(a, { tab: 'naprawde', zone: 'wszystkie' }, NOW)).konczyBl.map((z) => [z.id, z.faktura])).toEqual([[zFaktura, 'FV 10/11']])
  })
})
