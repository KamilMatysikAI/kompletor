// przeliczenie cen pozycji zamówień Woo zapisanych (ceny sprzed rabatu z ujemnych opłat) na bazie.
// Sklep zastępuje atrapa odczytu (ta sama funkcja adaptera `wooOrderZRabatem` na zmyślonej odpowiedzi WC REST), więc
// test nie łączy się z żadnym sklepem. Sprawdza: na sucho nic nie zapisuje, zapis zmienia tylko ceny, brakujący koszt
// wysyłki i historię (rezerwacje, stan, kwota i status bez zmian), paczka dodatkowa tym samym mnożnikiem, błąd odczytu
// jednego zamówienia nie zatrzymuje reszty, inne kanały nietknięte, drugi przebieg = 0 zmian. Dane zmyślone.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AdapterError } from '@/lib/adaptery/kontrakt'
import { wooOrderFromApi, wooOrderZRabatem } from '@/lib/adaptery/woo'
import { przeliczRabatyWoo, ZDARZENIE_KOSZTU, ZDARZENIE_RABATU } from '@/lib/kanaly/rabat-woo'
import { splitOrder } from '@/lib/rdzen/edycja'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { ACC, expectInvariants, offer, product, seedBase } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const T = new Date('2026-11-05T09:00:00Z')

function kwota(bruttoGr: number): { total: string; total_tax: string } {
  const netto = Math.round(bruttoGr / 1.23)
  return { total: (netto / 100).toFixed(2), total_tax: ((bruttoGr - netto) / 100).toFixed(2) }
}

/** Zmyślona odpowiedź WC REST v3; pozycje z ofertami 501/502 (produkty testowe). */
function woo(id: number, linie: { oferta: number; qty: number; wartoscGr: number }[], o: { wysylkaGr: number; oplatyGr?: number[]; pobranie?: boolean }): Record<string, unknown> {
  const oplaty = o.oplatyGr ?? []
  const totalGr = linie.reduce((s, l) => s + l.wartoscGr, 0) + o.wysylkaGr + oplaty.reduce((s, x) => s + x, 0)
  return {
    id,
    status: 'processing',
    currency: 'PLN',
    date_created_gmt: '2026-11-05T09:00:00',
    date_modified_gmt: '2026-11-05T09:05:00',
    ...(o.pobranie ? { payment_method: 'cod', payment_method_title: 'Za pobraniem' } : { date_paid_gmt: '2026-11-05T09:01:00', payment_method: 'blik', payment_method_title: 'Blik' }),
    total: (totalGr / 100).toFixed(2),
    shipping_total: kwota(o.wysylkaGr).total,
    shipping_tax: kwota(o.wysylkaGr).total_tax,
    line_items: linie.map((l, i) => ({ id: id * 10 + i, product_id: l.oferta, variation_id: 0, quantity: l.qty, ...kwota(l.wartoscGr), sku: `T${i}`, name: `Towar ${i}`, meta_data: [] })),
    fee_lines: oplaty.map((g, i) => ({ id: id * 100 + i, name: g < 0 ? 'Rabat' : 'Opłata', ...kwota(g) })),
    shipping_lines: [{ method_title: 'Kurier', ...kwota(o.wysylkaGr) }],
  }
}

/** Przyjęcie tak, jak robił to adapter: ceny pozycji bez rozkładu rabatu, kwota ze sklepu. */
async function przyjmijSprzed(raw: Record<string, unknown>, o: { bezKosztu?: boolean; konto?: 'WOO_SD' | 'WOO_LAMPY' } = {}) {
  const bez = wooOrderFromApi({ ...raw, fee_lines: [] })
  const z = wooOrderFromApi(raw)
  const { channel, channelAccountId } = ACC[o.konto ?? 'WOO_SD']
  await ingestOrder(
    db,
    {
      source: 'test',
      channel,
      channelAccountId,
      externalId: z.externalId,
      externalRevision: z.revision,
      createdAtChannel: z.createdAt,
      paymentState: z.paymentState,
      paymentMethod: z.paymentMethod,
      totalGross: z.totalGross,
      deliveryMethod: z.deliveryMethod,
      shippingCostGross: o.bezKosztu ? null : z.shippingCostGross,
      lines: bez.lines.map((l) => ({ externalLineId: l.externalLineId, offerExternalId: l.offerExternalId, qty: l.qty, unitPriceGross: l.unitPriceGross })),
    },
    { now: T },
  )
  return db.order.findFirstOrThrow({ where: { channel, externalId: z.externalId }, include: { lines: { orderBy: { externalLineId: 'asc' } } } })
}

const ceny = async (orderId: string) => (await db.orderLine.findMany({ where: { orderId }, orderBy: { externalLineId: 'asc' } })).map((l) => l.unitPriceGross.toFixed(2))

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  const a = await product(db, 'RB-A', 50)
  const b = await product(db, 'RB-B', 50)
  await offer(db, 'WOO_SD', '501', a)
  await offer(db, 'WOO_SD', '502', b)
})

describe('przeliczenie rabatu Woo na bazie', () => {
  it('na sucho nic nie zapisuje; zapis zmienia ceny, koszt wysyłki i historię; rezerwacje, stan, kwota i status bez zmian; drugi przebieg 0 zmian', async () => {
    const r1 = woo(9101, [{ oferta: 501, qty: 1, wartoscGr: 4000 }, { oferta: 502, qty: 2, wartoscGr: 6000 }], { wysylkaGr: 1299, oplatyGr: [-1000] })
    const r2 = woo(9102, [{ oferta: 501, qty: 1, wartoscGr: 2500 }], { wysylkaGr: 999 }) // bez rabatu, bez kosztu w bazie
    const r3 = woo(9103, [{ oferta: 502, qty: 1, wartoscGr: 3000 }], { wysylkaGr: 1299, oplatyGr: [-180, 500], pobranie: true })
    const r4 = woo(9104, [{ oferta: 501, qty: 1, wartoscGr: 5000 }], { wysylkaGr: 1299, oplatyGr: [-500] }) // błąd odczytu
    const o1 = await przyjmijSprzed(r1)
    const o2 = await przyjmijSprzed(r2, { bezKosztu: true })
    const o3 = await przyjmijSprzed(r3, { bezKosztu: true })
    const o4 = await przyjmijSprzed(r4)
    // inny kanał z tym samym numerem: nietknięty, sklep o niego nie pytany
    await ingestOrder(db, { source: 'test', ...ACC.ALLEGRO, externalId: '9101', externalRevision: '1', createdAtChannel: T, paymentState: 'PAID', paymentMethod: 'allegro', totalGross: 40, lines: [{ externalLineId: 'a1', qty: 1, unitPriceGross: 40 }] }, { now: T })
    // paczka dodatkowa zamówienia 1 (podział w Kompletorze): 1 z 2 sztuk drugiej pozycji, pozycja `<id>#paczka` po cenie matki
    const { childOrderId } = await splitOrder(db, o1.id, { [o1.lines[1]!.id]: 1 }, { now: T })
    const dziecko = await db.order.findUniqueOrThrow({ where: { id: childOrderId } })

    const sklep = new Map([r1, r2, r3, r4].map((r) => [String(r['id']), r]))
    const pytania: string[] = []
    const czytaj = async (konto: string, ext: string) => {
      pytania.push(`${konto}/${ext}`)
      if (ext === '9104') throw new AdapterError('Woo: przekroczony czas odpowiedzi', 'PRZEJSCIOWY')
      const r = sklep.get(ext)
      return r ? wooOrderZRabatem(r) : null
    }
    const rezerwacje = async () => (await db.reservation.findMany({ orderBy: { id: 'asc' } })).map((r) => [r.id, r.qtyBase, r.state])
    const stan = async () => (await db.stock.findMany({ orderBy: { productId: 'asc' } })).map((s) => [s.productId, s.physical, s.reserved])
    const zamowienia = async () => (await db.order.findMany({ orderBy: { id: 'asc' } })).map((o) => [o.id, o.status, o.totalGross.toFixed(2), o.externalRevision])
    const przed = { rez: await rezerwacje(), stan: await stan(), zam: await zamowienia(), c1: await ceny(o1.id) }

    const od = new Date('2026-11-01T00:00:00Z')
    const sucho = await przeliczRabatyWoo(db, czytaj, { naSucho: true, od })
    expect(sucho).toMatchObject({ zamowien: 4, odczytanych: 3, zRabatem: 2, doPrzeliczenia: 2, przeliczone: 0, pozycjiKanalu: 3, pozycjiPaczek: 1, pobranie: 1, kosztWysylkiDoUzupelnienia: 2, kosztWysylkiUzupelniony: 0, zFakturaKompletora: [] })
    expect(sucho.doZmiany.map((z) => z.orderId).sort()).toEqual([o1.id, o2.id, o3.id].sort())
    expect(sucho.doZmiany.find((z) => z.orderId === o2.id)).toEqual({ orderId: o2.id, towaryPrzedGr: 2500, towaryPoGr: 2500, kosztWysylkiGr: 999, pozycji: 0 })
    expect(sucho.bledy).toEqual([{ orderId: o4.id, powod: 'odczyt sklepu nie powiódł się (PRZEJSCIOWY)' }])
    expect(pytania.every((p) => p.startsWith('sd/'))).toBe(true)
    expect(await ceny(o1.id)).toEqual(przed.c1)
    expect(await db.orderEvent.count({ where: { kind: ZDARZENIE_RABATU } })).toBe(0)
    expect((await db.order.findUniqueOrThrow({ where: { id: o2.id } })).shippingCostGross).toBeNull()

    const w = await przeliczRabatyWoo(db, czytaj, { naSucho: false, od })
    expect(w).toMatchObject({ doPrzeliczenia: 2, przeliczone: 2, pozycjiKanalu: 3, pozycjiPaczek: 1, kosztWysylkiUzupelniony: 2 })
    expect(w.bledy).toHaveLength(1)
    // ceny = reguła adaptera
    expect(await ceny(o1.id)).toEqual(wooOrderFromApi(r1).lines.map((l) => l.unitPriceGross.toFixed(2)))
    expect(await ceny(o3.id)).toEqual(wooOrderFromApi(r3).lines.map((l) => l.unitPriceGross.toFixed(2)))
    expect(await ceny(dziecko.id)).toEqual([(await ceny(o1.id))[1]])
    expect(await ceny(o4.id)).toEqual(o4.lines.map((l) => l.unitPriceGross.toFixed(2))) // błąd odczytu: bez zmian
    expect((await db.order.findUniqueOrThrow({ where: { id: o2.id } })).shippingCostGross?.toFixed(2)).toBe('9.99')
    expect((await db.order.findUniqueOrThrow({ where: { id: o3.id } })).shippingCostGross?.toFixed(2)).toBe('12.99')
    expect(await ceny(o2.id)).toEqual(['25.00'])
    const ev = await db.orderEvent.findMany({ where: { kind: ZDARZENIE_RABATU }, orderBy: { orderId: 'asc' } })
    expect(ev.map((e) => e.orderId).sort()).toEqual([o1.id, o3.id, dziecko.id].sort())
    expect(ev.every((e) => e.actorId === 'system:przeliczenie-rabatu')).toBe(true)
    // samo uzupełnienie kosztu (zamówienie bez rabatu) też ma wpis w historii
    const koszt = await db.orderEvent.findMany({ where: { kind: ZDARZENIE_KOSZTU } })
    expect(koszt.map((e) => [e.orderId, e.data])).toEqual([[o2.id, { kosztWysylki: '9.99' }]])
    // nic poza cenami i kosztem wysyłki
    expect(await rezerwacje()).toEqual(przed.rez)
    expect(await stan()).toEqual(przed.stan)
    expect(await zamowienia()).toEqual(przed.zam)
    expect((await db.orderLine.findFirstOrThrow({ where: { order: { channel: 'ALLEGRO' } } })).unitPriceGross.toFixed(2)).toBe('40.00')
    await expectInvariants(db)

    const drugi = await przeliczRabatyWoo(db, czytaj, { naSucho: false, od })
    expect(drugi).toMatchObject({ doPrzeliczenia: 0, przeliczone: 0, juzPrzeliczone: 2, kosztWysylkiUzupelniony: 0, zRabatem: 2 })
    expect(await db.orderEvent.count({ where: { kind: ZDARZENIE_RABATU } })).toBe(3)
  })

  it('zakres: data od/do i konto; zamówienie zmienione w Kompletorze pominięte z powodem', async () => {
    const r1 = woo(9201, [{ oferta: 501, qty: 1, wartoscGr: 4000 }], { wysylkaGr: 1299, oplatyGr: [-400] })
    const r2 = woo(9202, [{ oferta: 501, qty: 1, wartoscGr: 4000 }], { wysylkaGr: 1299, oplatyGr: [-400] })
    const o1 = await przyjmijSprzed(r1)
    const o2 = await przyjmijSprzed(r2)
    await db.order.update({ where: { id: o2.id }, data: { flags: { edytowaneLokalnie: true } } })
    const czytaj = async (_k: string, ext: string) => wooOrderZRabatem(ext === '9201' ? r1 : r2)
    expect((await przeliczRabatyWoo(db, czytaj, { naSucho: true, od: new Date('2026-11-06T00:00:00Z') })).zamowien).toBe(0)
    expect((await przeliczRabatyWoo(db, czytaj, { naSucho: true, od: new Date('2026-11-01T00:00:00Z'), do: new Date('2026-11-05T00:00:00Z') })).zamowien).toBe(0)
    expect((await przeliczRabatyWoo(db, czytaj, { naSucho: true, od: new Date('2026-11-01T00:00:00Z'), channelAccountId: 'lampy' })).zamowien).toBe(0)
    const w = await przeliczRabatyWoo(db, czytaj, { naSucho: false, od: new Date('2026-11-01T00:00:00Z'), channelAccountId: 'sd' })
    expect(w).toMatchObject({ zamowien: 2, przeliczone: 1, pominiete: { 'edytowane-w-kompletorze': [o2.id] } })
    expect(await ceny(o1.id)).toEqual(['36.00'])
    expect(await ceny(o2.id)).toEqual(['40.00'])
  })

  it('runda 2: dokument Kompletora (wFirma albo szkic KSeF) = lista ręczna, --wykonaj odmawia i nic nie zapisuje; BL przeliczane', async () => {
    const r1 = woo(9301, [{ oferta: 501, qty: 1, wartoscGr: 4000 }], { wysylkaGr: 1299, oplatyGr: [-400] })
    const r2 = woo(9302, [{ oferta: 501, qty: 1, wartoscGr: 4000 }], { wysylkaGr: 1299, oplatyGr: [-400] })
    const r3 = woo(9303, [{ oferta: 502, qty: 1, wartoscGr: 3000 }], { wysylkaGr: 1299, oplatyGr: [-300] })
    const o1 = await przyjmijSprzed(r1)
    const o2 = await przyjmijSprzed(r2)
    const o3 = await przyjmijSprzed(r3)
    const sklep = new Map([r1, r2, r3].map((r) => [String(r['id']), r]))
    const czytaj = async (_k: string, ext: string) => wooOrderZRabatem(sklep.get(ext)!)
    const od = new Date('2026-11-01T00:00:00Z')
    await db.invoiceAttempt.create({ data: { organizationId: o1.organizationId, orderId: o1.id, packageNo: 1, attemptNo: 1, idExternal: `${o1.id}/1/1`, state: 'ISSUED' } })
    await db.ksefInvoiceDraft.create({ data: { organizationId: o2.organizationId, id: 'ksef-szkic-1', orderId: o2.id, packageNo: 1, status: 'SZKIC', wersjaSchemy: 'FA(3)', bruttoGr: 4899, nettoGr: 3983 } })
    await db.orderEvent.create({ data: { orderId: o3.id, kind: 'FAKTURA_BL', actorId: 'test', data: {} } })
    // bez rabatu, bez kosztu wysyłki, z fakturą Kompletora: kosztu nie wpisujemy, ale przebiegu to nie blokuje
    const r4 = woo(9304, [{ oferta: 502, qty: 1, wartoscGr: 2000 }], { wysylkaGr: 999 })
    const o4 = await przyjmijSprzed(r4, { bezKosztu: true })
    sklep.set('9304', r4)
    await db.invoiceAttempt.create({ data: { organizationId: o4.organizationId, orderId: o4.id, packageNo: 1, attemptNo: 1, idExternal: `${o4.id}/1/1`, state: 'ISSUED' } })

    const sucho = await przeliczRabatyWoo(db, czytaj, { naSucho: true, od })
    expect(sucho.kosztWysylkiNieuzupelniony).toEqual({ 'z-dokumentem-kompletora': [o4.id] })
    expect(sucho.zFakturaKompletora.sort()).toEqual([o1.id, o2.id].sort())
    expect(sucho.pominiete['z-dokumentem-kompletora']?.sort()).toEqual([o1.id, o2.id].sort())
    expect(sucho).toMatchObject({ doPrzeliczenia: 1, zFakturaBl: 1, odmowa: null })
    const przed = { c1: await ceny(o1.id), c2: await ceny(o2.id), c3: await ceny(o3.id) }

    const w = await przeliczRabatyWoo(db, czytaj, { naSucho: false, od })
    expect(w.odmowa).toMatch(/dokumentem wystawionym przez Kompletor/)
    expect(w.przeliczone).toBe(0)
    expect({ c1: await ceny(o1.id), c2: await ceny(o2.id), c3: await ceny(o3.id) }).toEqual(przed)
    expect(await db.orderEvent.count({ where: { kind: { in: [ZDARZENIE_RABATU, ZDARZENIE_KOSZTU] } } })).toBe(0)

    // węższy zakres (bez zamówień z dokumentem Kompletora): zamówienie z fakturą BL przeliczone
    await db.order.updateMany({ where: { id: { in: [o1.id, o2.id] } }, data: { createdAtChannel: new Date('2026-10-01T00:00:00Z') } })
    const w2 = await przeliczRabatyWoo(db, czytaj, { naSucho: false, od })
    expect(w2).toMatchObject({ odmowa: null, przeliczone: 1, zFakturaBl: 1, zFakturaKompletora: [] })
    expect(await ceny(o3.id)).toEqual(['27.00'])
    expect((await db.order.findUniqueOrThrow({ where: { id: o4.id } })).shippingCostGross).toBeNull()
  })

  it('runda 2: zmiana zamówienia między odczytem sklepu a blokadą = nic nie zapisane, powód w podsumowaniu', async () => {
    const r1 = woo(9401, [{ oferta: 501, qty: 1, wartoscGr: 4000 }], { wysylkaGr: 1299, oplatyGr: [-400] })
    const o1 = await przyjmijSprzed(r1, { bezKosztu: true })
    const w = await przeliczRabatyWoo(db, async () => wooOrderZRabatem(r1), {
      naSucho: false,
      przedZapisem: async () => {
        await db.order.update({ where: { id: o1.id }, data: { flags: { edytowaneLokalnie: true } } })
      },
    })
    expect(w).toMatchObject({ doPrzeliczenia: 1, przeliczone: 0, kosztWysylkiUzupelniony: 0, zmienioneWTrakcie: [{ orderId: o1.id, powod: 'edytowane-w-kompletorze' }] })
    expect(await ceny(o1.id)).toEqual(['40.00'])
    expect((await db.order.findUniqueOrThrow({ where: { id: o1.id } })).shippingCostGross).toBeNull()
    expect(await db.orderEvent.count({ where: { kind: { in: [ZDARZENIE_RABATU, ZDARZENIE_KOSZTU] } } })).toBe(0)
  })

  it('runda 2: bez daty = wszystkie zamówienia Woo; tempo odczytu i limit czasu jednego zamówienia (pominięcie, reszta leci)', async () => {
    const r1 = woo(9501, [{ oferta: 501, qty: 1, wartoscGr: 4000 }], { wysylkaGr: 1299, oplatyGr: [-400] })
    const r2 = woo(9502, [{ oferta: 501, qty: 1, wartoscGr: 4000 }], { wysylkaGr: 1299, oplatyGr: [-400] })
    const r3 = woo(9503, [{ oferta: 502, qty: 1, wartoscGr: 3000 }], { wysylkaGr: 1299, oplatyGr: [-300] })
    const o1 = await przyjmijSprzed(r1)
    const o2 = await przyjmijSprzed(r2)
    const o3 = await przyjmijSprzed(r3)
    await db.order.update({ where: { id: o3.id }, data: { createdAtChannel: new Date('2020-01-01T00:00:00Z') } })
    const sklep = new Map([r1, r2, r3].map((r) => [String(r['id']), r]))
    const czekania: number[] = []
    const w = await przeliczRabatyWoo(db, (_k, ext) => (ext === '9502' ? new Promise(() => undefined) : Promise.resolve(wooOrderZRabatem(sklep.get(ext)!))), {
      naSucho: false,
      limitNaMinute: 600,
      limitCzasuMs: 50,
      czekaj: async (ms) => {
        czekania.push(ms)
      },
    })
    expect(w).toMatchObject({ zamowien: 3, odczytanych: 2, przeliczone: 2, limitCzasu: [o2.id], bledy: [] })
    expect(czekania.length).toBeGreaterThanOrEqual(1)
    expect(czekania.every((ms) => ms > 0 && ms <= 100)).toBe(true)
    expect(await ceny(o1.id)).toEqual(['36.00'])
    expect(await ceny(o2.id)).toEqual(['40.00'])
    expect(await ceny(o3.id)).toEqual(['27.00'])
  })
})
