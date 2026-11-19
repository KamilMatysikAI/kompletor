// na bazie: dzień z fakturą zgodną i z różnicą, idempotencja, izolacja dwóch firm, kopia BL z treścią faktury,
// strażnik braku zapisu w wFirmie. BL i wFirma wyłącznie atrapy, dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { syncBlInvoices, type WzOdczyt } from '@/lib/cien/faktury-bl'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { packOrder } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { FakturyPodglad, TRYB_PODGLADU } from '@/lib/wfirma/adapter-podglad'
import { runFakturyPodglad } from '@/lib/wfirma/podglad'
import { assertWfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { renderPodglad } from '@/scripts/faktury-podglad'
import { FakeBl, sec } from './bl-atrapa'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { expectInvariants, offer, order, product, seedBase } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
  await sys.$disconnect()
})

const DZIEN = '2026-10-27'
const T = new Date('2026-10-27T08:00:00.000Z')
const FAKTURY = { faktury: { seriaId: '77', kodyVat: { '23': 1001, '8': 1002, '5': 1003, '0': 1004 } } }

async function ustawFakture(c: typeof db, blInvoiceId: number, blOrderId: number, o: { totalGross?: string | null; totalNet?: string | null; paymentName?: string | null; lines?: unknown; kind?: string; dateAdd?: Date } = {}) {
  await c.blInvoiceSnapshot.create({
    data: {
      blInvoiceId,
      blOrderId,
      number: `FV ${blInvoiceId}/10/2026`,
      kind: o.kind ?? 'normal',
      dateAdd: o.dateAdd ?? T,
      fetchedAt: T,
      totalGross: o.totalGross === undefined ? '32.00' : o.totalGross,
      totalNet: o.totalNet === undefined ? '26.02' : o.totalNet,
      paymentName: o.paymentName === undefined ? 'BLIK' : o.paymentName,
      ...(o.lines === undefined ? {} : o.lines === null ? {} : { lines: o.lines as never }),
    },
  })
}

const POZYCJE = [
  { sku: 'A', qty: 2, priceGross: 10, taxRate: 23, shipment: false },
  { sku: null, qty: 1, priceGross: 12, taxRate: 23, shipment: true },
]

/** Zamówienie: 2 × 10 zł towaru A + 12 zł wysyłki, połączone z BL. */
async function zamowienie(c: typeof db, productId: string, blOrderId: number, over: Record<string, unknown> = {}) {
  const { orderId } = await ingestOrder(c, order([{ productId, qty: 2 }], { totalGross: 32, createdAtChannel: T, externalId: `Z-${blOrderId}`, ...over }), { now: T })
  await c.order.update({ where: { id: orderId! }, data: { blOrderId } })
  return orderId!
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: FAKTURY } })
})

describe('faktury-podglad: dzień', () => {
  it('faktura zgodna i z różnicą, kategorie, numery zamówień, bez danych klientów', async () => {
    const a = await product(db, 'A', 50, { wfirmaGoodId: '500' })
    await zamowienie(db, a, 7001)
    await zamowienie(db, a, 7002)
    await ustawFakture(db, 1, 7001, { lines: POZYCJE })
    await ustawFakture(db, 2, 7002, { lines: [{ ...POZYCJE[0], taxRate: 8 }, { ...POZYCJE[1], priceGross: 15 }], totalGross: '35.00', totalNet: '30.00' })

    const r = await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    expect(r).toMatchObject({ faktury: 2, zgodne: 1, roznice: 1, tylkoSumy: 0, procent: 50, bledy: [] })
    expect(r.perKategoria).toMatchObject({ VAT: 1, WYSYLKA: 1 })
    expect(r.lista).toEqual([expect.objectContaining({ numerZamowienia: 'Z-7002', blInvoiceId: 2 })])

    const wiersze = await db.invoiceDryRun.findMany({ orderBy: { blInvoiceId: 'asc' } })
    expect(wiersze.map((w) => [w.blInvoiceId, w.result, w.scope, w.day, w.oursGrossGr])).toEqual([
      [1, 'ZGODNA', 'PELNY', DZIEN, 3200],
      [2, 'ROZNICA', 'PELNY', DZIEN, 3200],
    ])
    expect(wiersze[1]!.diffs).toEqual(expect.arrayContaining([expect.objectContaining({ kategoria: 'VAT', kod: 'stawka', sku: 'A' })]))

    const tekst = renderPodglad(r)
    expect(tekst).toContain('zgodnych 1, z różnicą 1')
    expect(tekst).toContain('próg 99%: NIESPEŁNIONY')
    expect(tekst).toContain('Z-7002')
  })

  it('ponowne uruchomienie nie dubluje wierszy i aktualizuje wynik', async () => {
    const a = await product(db, 'A', 50, { wfirmaGoodId: '500' })
    await zamowienie(db, a, 7001)
    await ustawFakture(db, 1, 7001, { lines: POZYCJE })
    await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    await db.product.update({ where: { id: a }, data: { wfirmaGoodId: null } })
    const r = await runFakturyPodglad(db, { dzien: DZIEN, now: new Date(T.getTime() + 60_000) })
    expect(r).toMatchObject({ zgodne: 0, roznice: 1, perKategoria: { BRAK_POWIAZANIA: 1 } })
    const w = await db.invoiceDryRun.findMany()
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ result: 'ROZNICA', categories: ['BRAK_POWIAZANIA'] })
  })

  it('kopia bez pozycji: sumy; bez sum z kopii: suma zamówienia BL; bez niczego: BEZ_DANYCH poza mianownikiem', async () => {
    const a = await product(db, 'A', 50, { wfirmaGoodId: '500' })
    await zamowienie(db, a, 7001)
    await zamowienie(db, a, 7002)
    await zamowienie(db, a, 7003)
    await ustawFakture(db, 1, 7001)
    await ustawFakture(db, 2, 7002, { totalGross: null, totalNet: null, paymentName: null })
    await db.blOrderSnapshot.create({ data: { blOrderId: 7002, orderSource: 'shop', orderSourceId: '1', channel: 'WOO', channelAccountId: 'sd', statusId: 1, totalGross: '32.00', dateAdd: T, fetchedAt: T } })
    await ustawFakture(db, 3, 7003, { totalGross: null, totalNet: null, paymentName: null })
    const r = await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    expect(r).toMatchObject({ faktury: 3, zgodne: 2, tylkoSumy: 2, roznice: 0, bezDanych: 1, numeryBezDanych: ['Z-7003'], procent: null })
    expect(renderPodglad(r)).toMatch(/brak porównań pozycji/)
    expect(renderPodglad(r)).not.toMatch(/spełniony/)
  })

  it('zgodna z samych sum poza progiem, różnica z samych sum zostaje w mianowniku', async () => {
    const a = await product(db, 'A', 50, { wfirmaGoodId: '500' })
    await zamowienie(db, a, 7001)
    await zamowienie(db, a, 7002)
    await zamowienie(db, a, 7003)
    await ustawFakture(db, 1, 7001, { lines: POZYCJE })
    await ustawFakture(db, 2, 7002)
    await ustawFakture(db, 3, 7003, { totalGross: '99.00' })
    const r = await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    expect(r).toMatchObject({ faktury: 3, zgodne: 2, tylkoSumy: 1, roznice: 1, procent: 50 })
    expect(renderPodglad(r)).toMatch(/zgodne z samych sum \(kopia BL bez pozycji\), poza progiem: 1/)
  })

  it('pozycja z nieaktywnej oferty liczy się w sztukach kanału, nie dzieli przez qtyBasePerOffer', async () => {
    const a = await product(db, 'A', 500, { wfirmaGoodId: '500' })
    await offer(db, 'WOO_SD', '10', a, { qtyBasePerOffer: 50 })
    await db.channelOffer.updateMany({ where: { externalId: '10' }, data: { active: false } })
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: '10', qty: 2, unitPriceGross: 10 }], { totalGross: 32, createdAtChannel: T, externalId: 'Z-1' }), { now: T })
    await db.order.update({ where: { id: orderId! }, data: { blOrderId: 7001 } })
    await ustawFakture(db, 1, 7001, { lines: POZYCJE })
    const r = await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    expect(r.lista).toHaveLength(1)
    expect(r.lista[0]!.kody).toContain('pozycja-bez-produktu')
    expect(r.lista[0]!.kody).not.toContain('kwota-wysylki') // 2 × 10 zł + 12 zł wysyłki, nie zmyślone 0,40 zł towaru
  })

  it('korekty, faktury spoza cienia i z innego dnia nie wchodzą', async () => {
    const a = await product(db, 'A', 50, { wfirmaGoodId: '500' })
    await zamowienie(db, a, 7001)
    await ustawFakture(db, 1, 7001, { kind: 'correcting' })
    await ustawFakture(db, 2, 9999)
    await ustawFakture(db, 3, 7001, { dateAdd: new Date('2026-10-28T08:00:00Z') })
    const r = await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    expect(r).toMatchObject({ faktury: 1, korekty: 1, pozaCieniem: 1, zgodne: 0, roznice: 0, procent: null })
    expect(await db.invoiceDryRun.count()).toBe(0)
  })

  it('oferta na kilka jednostek bazowych: kwoty ze sztuk oferty, ilość porównana w sztukach oferty', async () => {
    const a = await product(db, 'A', 500, { wfirmaGoodId: '500' })
    await offer(db, 'WOO_SD', '10', a, { qtyBasePerOffer: 50 })
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: '10', qty: 2, unitPriceGross: 10 }], { totalGross: 32, createdAtChannel: T, externalId: 'Z-1' }), { now: T })
    await db.order.update({ where: { id: orderId! }, data: { blOrderId: 7001 } })
    await ustawFakture(db, 1, 7001, { lines: POZYCJE })
    const r = await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    expect(r).toMatchObject({ zgodne: 1, roznice: 0, bledy: [] })
    expect((await db.invoiceDryRun.findFirstOrThrow()).oursGrossGr).toBe(3200)
  })

  it('izolacja dwóch firm: każda widzi swoje faktury i wyniki, ten sam numer faktury BL nie koliduje', async () => {
    await sys.organization.update({ where: { id: ORG_B }, data: { settings: FAKTURY } })
    await seedBase(dbB)
    const a = await product(db, 'A', 50, { wfirmaGoodId: '500' })
    const b = await product(dbB, 'A', 50, { wfirmaGoodId: '500' })
    await zamowienie(db, a, 7001)
    await zamowienie(dbB, b, 7001, { totalGross: 20 })
    await ustawFakture(db, 1, 7001, { lines: POZYCJE })
    await ustawFakture(dbB, 1, 7001, { lines: POZYCJE })
    const ra = await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    const rb = await runFakturyPodglad(dbB, { dzien: DZIEN, now: T })
    expect(ra).toMatchObject({ zgodne: 1, roznice: 0 })
    expect(rb).toMatchObject({ zgodne: 0, roznice: 1 })
    expect(await db.invoiceDryRun.findMany({ select: { organizationId: true, result: true } })).toEqual([{ organizationId: ORG_A, result: 'ZGODNA' }])
    expect(await dbB.invoiceDryRun.findMany({ select: { organizationId: true, result: true } })).toEqual([{ organizationId: ORG_B, result: 'ROZNICA' }])
  })

  it('podgląd podaje koszt wysyłki (rabat na zamówienie jak w BL) i paczki dodatkowe (stop)', async () => {
    const a = await product(db, 'A', 50, { wfirmaGoodId: '500' })
    // cena pozycji sprzed rabatu 2 × 10,00, rabat 10% (2,00), wysyłka 12,00 z kanału, zapłacone 30,00
    const z1 = await zamowienie(db, a, 7001, { totalGross: 30 })
    const z2 = await zamowienie(db, a, 7002, { totalGross: 30 })
    await db.order.updateMany({ where: { id: { in: [z1, z2] } }, data: { shippingCostGross: '12.00' } })
    const z2Row = await db.order.findUniqueOrThrow({ where: { id: z2 } })
    await db.order.create({ data: { channel: z2Row.channel, channelAccountId: z2Row.channelAccountId, externalId: `${z2Row.externalId}#paczka-2`, status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '0.00', createdAtChannel: T, parentOrderId: z2, packageNo: 2, flags: {} } })
    const linie = [{ ...POZYCJE[0], priceGross: 9 }, POZYCJE[1]]
    await ustawFakture(db, 1, 7001, { lines: linie, totalGross: '30.00', totalNet: '24.39' })
    await ustawFakture(db, 2, 7002, { lines: linie, totalGross: '30.00', totalNet: '24.39' })
    await runFakturyPodglad(db, { dzien: DZIEN, now: T })
    const w = await db.invoiceDryRun.findMany({ orderBy: { blInvoiceId: 'asc' } })
    expect(w.map((x) => [x.blInvoiceId, x.result, x.oursGrossGr])).toEqual([
      [1, 'ZGODNA', 3000],
      [2, 'ROZNICA', 3000],
    ])
    expect(w[1]!.diffs).toEqual(expect.arrayContaining([expect.objectContaining({ kod: 'rabat-niepewny-podzial' })]))
  })
})

describe('kopia faktury BL (syncBlInvoices)', () => {
  it('zapisuje sumy, płatność i pozycje z tej samej odpowiedzi; bez danych nabywcy i nazw pozycji', async () => {
    const bl = new FakeBl()
    bl.invoices.push({
      invoice_id: 11,
      order_id: 7001,
      number: 'FV 11/10/2026',
      type: 'normal',
      date_add: sec(T),
      total_price_brutto: 32,
      total_price_netto: 26.02,
      payment: 'BLIK',
      invoice_fullname: 'Jan Testowy',
      invoice_nip: '1234563218',
      invoice_address: 'ul. Fikcyjna 1',
      items: [{ name: 'Przyprawa Testowa', sku: 'A', price_brutto: 10, tax_rate: 23, quantity: 2, is_shipment: 0 }],
    } as never)
    await syncBlInvoices(db, bl.client(), null, { now: T })
    const s = await db.blInvoiceSnapshot.findFirstOrThrow()
    expect({ g: Number(s.totalGross), n: Number(s.totalNet), p: s.paymentName, l: s.lines }).toEqual({ g: 32, n: 26.02, p: 'BLIK', l: [{ sku: 'A', qty: 2, priceGross: 10, taxRate: 23, shipment: false }] })
    expect(JSON.stringify(s)).not.toMatch(/Testow|1234563218|Fikcyjna/)
  })

  it('stara kopia bez pól BL zapisuje się z null (faktura bez items)', async () => {
    const bl = new FakeBl()
    bl.invoices.push({ invoice_id: 12, order_id: 7002, number: 'FV 12/10/2026', type: 'normal', date_add: sec(T) } as never)
    await syncBlInvoices(db, bl.client(), null as WzOdczyt | null, { now: T })
    expect(await db.blInvoiceSnapshot.findFirstOrThrow()).toMatchObject({ totalGross: null, lines: null })
  })
})

describe('strażnik: runWfirmaQueue z adapterem podglądu nigdy nie woła zapisu', () => {
  it('spakowane zamówienie: odmowa bez sieci, same odczyty, rezerwacja wraca, faktura nie powstaje', async () => {
    const a = await product(db, 'A', 50, { wfirmaGoodId: '500' })
    const { orderId } = await ingestOrder(db, order([{ productId: a, qty: 2 }], { createdAtChannel: T }), { now: T })
    await packOrder(db, orderId!, { now: T })

    const sciezki: string[] = []
    const wf = {
      call: async <R,>(p: string): Promise<R> => {
        assertWfirmaReadOnly(p) // ten sam strażnik co w kliencie: zapis wysypałby test
        sciezki.push(p)
        return { invoices: { parameters: {} } } as R
      },
    }
    await runWfirmaQueue(db, { faktury: new FakturyPodglad(wf, db) }, { now: T })

    expect(sciezki.every((p) => /\/find$/.test(p))).toBe(true)
    const proby = await db.invoiceAttempt.findMany({ where: { orderId: orderId! } })
    expect(proby.map((x) => [x.state, x.lastError, x.wfirmaDocId])).toEqual([['FAILED', TRYB_PODGLADU, null]])
    expect(await db.reservation.count({ where: { orderId: orderId!, state: 'ACTIVE' } })).toBe(1)
    await expectInvariants(db)
  })
})
