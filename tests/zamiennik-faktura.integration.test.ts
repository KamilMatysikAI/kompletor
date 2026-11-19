// „Zamień produkt” a faktura. Cały tor: zamówienie z kanału → brak →
// `swapProduct` → zbieranie i pakowanie → kolejka wFirmy → adapter zapisu (`zlozFakture`) → atrapa HTTP wFirmy (zero
// sieci, zero prawdziwych faktur). Zasada: klient dostaje fakturę na kwotę, którą zapłacił; zamiennik przejmuje ilość
// i cenę pozycji pierwotnej (także przelicznik oferty), ze swoją stawką VAT. Gdy kwoty nie da się ustalić, faktura
// staje z komunikatem dla biura, nigdy nie wychodzi po cichu z inną kwotą. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { swapProduct } from '@/lib/rdzen/brakuje'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { finishPicking, startPicking } from '@/lib/rdzen/przejscia'
import { beginDocument, beginInvoice, type InvoiceLine, packOrder } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { FakturyWfirmaZapis } from '@/lib/wfirma/adapter-zapis'
import { WfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { WfirmaZapis } from '@/lib/zrodla/wfirma-zapis'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, bundle, expectInvariants, offer, order, product, seedBase, T0 } from './rdzen-fixtures'
import { KLUCZE_TESTOWE, WfirmaHttpAtrapa } from './wfirma-http-atrapa'

const db = testDb()
afterAll(() => db.$disconnect())

const KODY_VAT = { '23': 222, '8': 223, '5': 224, '0': 234 }
const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: null, email: null },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}

const adapter = (w: WfirmaHttpAtrapa) => new FakturyWfirmaZapis(new WfirmaReadOnly(KLUCZE_TESTOWE, w.fetch, 0), db, { zapis: new WfirmaZapis(KLUCZE_TESTOWE, w.fetch, 0), odbiorca: async () => ODBIORCA })
const min = (m: number) => new Date(T0.getTime() + m * 60_000)
const wartosc = (l: InvoiceLine[]) => l.reduce((s, x) => s + x.qty * x.unitGrossGr, 0)
const groszeFaktury = (pozycje: { count: number; price: string }[]) => pozycje.reduce((s, p) => s + Math.round(p.count * Number(p.price) * 100), 0)

/** Zamówienie z kanału z brakiem na pozycji 1, zamiana całego braku na `zamiennik`, potem zbieranie i pakowanie. */
async function zZamiennikiem(lines: { offerExternalId: string; qty: number; unitPriceGross: number }[], totalGross: number, zamiennik: string, przed?: (orderId: string) => Promise<void>): Promise<string> {
  const r = await ingestOrder(db, order(lines, { totalGross }), { now: T0 })
  const id = r.orderId!
  const l1 = await db.orderLine.findFirstOrThrow({ where: { orderId: id, externalLineId: 'L1' } })
  expect(await db.shortage.count({ where: { orderLineId: l1.id, state: 'OPEN' } })).toBe(1)
  await swapProduct(db, l1.id, zamiennik, { now: T0 })
  if (przed) await przed(id)
  await startPicking(db, id, { now: T0 })
  await finishPicking(db, id, { now: T0 })
  await packOrder(db, id, { now: T0 })
  return id
}

async function linieWystawionej(orderId: string): Promise<InvoiceLine[]> {
  const a = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId, state: 'ISSUED' } })
  return a.payload as unknown as InvoiceLine[]
}

const wystaw = async () => {
  const w = new WfirmaHttpAtrapa()
  const st = await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
  return { st, faktury: w.faktury }
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.channelConfig.updateMany({ where: ACC.WOO_SD, data: { statusMode: 'PRACA' } })
  await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { kodyVat: KODY_VAT, program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() } } as never } })
})

describe('zamiennik na fakturze wFirmy (przykłady)', () => {
  it('przykład 1: towar 12,50 zł + wysyłka 12,99 zł, zamiana 1 szt. → faktura na 25,49 zł', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    await offer(db, 'WOO_SD', 'OA', a)
    const id = await zZamiennikiem([{ offerExternalId: 'OA', qty: 1, unitPriceGross: 12.5 }], 25.49, b)

    const { faktury } = await wystaw()
    expect(faktury).toHaveLength(1)
    expect(faktury[0]!.pozycje).toEqual([
      { goodId: 9102, count: 1, price: '12.50', name: 'Towar testowy HERB-B', vat: 222 },
      { goodId: 0, count: 1, price: '12.99', name: 'Wysyłka', vat: 222 },
    ])
    expect(groszeFaktury(faktury[0]!.pozycje)).toBe(2549)
    expect(await linieWystawionej(id)).toEqual([{ productId: b, qty: 1, unitGrossGr: 1250, vatRate: '23' }])
    await expectInvariants(db)
  })

  it('przykład 2: towar 20 zł + wysyłka 10 zł → faktura na 30 zł, bez ręcznej obsługi', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    await offer(db, 'WOO_SD', 'OA', a)
    const id = await zZamiennikiem([{ offerExternalId: 'OA', qty: 1, unitPriceGross: 20 }], 30, b)

    const { faktury } = await wystaw()
    expect(faktury).toHaveLength(1)
    expect(faktury[0]!.pozycje).toEqual([
      { goodId: 9102, count: 1, price: '20.00', name: 'Towar testowy HERB-B', vat: 222 },
      { goodId: 0, count: 1, price: '10.00', name: 'Wysyłka', vat: 222 },
    ])
    expect(await db.alert.count({ where: { ref: id, kind: 'FAKTURA_BLAD', closedAt: null } })).toBe(0)
  })

  it('przykład 3: towar na wagę, oferta 50 g za 12,50 zł, zamiana 50 g → 0,05 kg za 12,50 zł, linia rdzenia 50 g = 12,50 zł', async () => {
    const a = await product(db, 'HERB-WA', 0, { unit: 'KG', wfirmaGoodId: '9103', vatRate: '5' })
    const b = await product(db, 'HERB-WB', 1000, { unit: 'KG', wfirmaGoodId: '9104', vatRate: '5' })
    await offer(db, 'WOO_SD', 'W50', a, { qtyBasePerOffer: 50 })
    const id = await zZamiennikiem([{ offerExternalId: 'W50', qty: 1, unitPriceGross: 12.5 }], 25.49, b)

    const { faktury } = await wystaw()
    expect(faktury).toHaveLength(1)
    expect(faktury[0]!.pozycje).toEqual([
      { goodId: 9104, count: 0.05, price: '250.00', name: 'Towar testowy HERB-WB', vat: 224 },
      { goodId: 0, count: 1, price: '12.99', name: 'Wysyłka', vat: 222 },
    ])
    const linie = await linieWystawionej(id)
    expect(linie).toEqual([{ productId: b, qty: 50, unitGrossGr: 25, vatRate: '5' }])
    expect(wartosc(linie)).toBe(1250)
    await expectInvariants(db)
  })
})

describe('zamiennik — pozostałe przypadki', () => {
  it('zamiennik z inną stawką VAT: stawka zamiennika, kwota brutto bez zmian', async () => {
    const a = await product(db, 'HERB-5', 0, { wfirmaGoodId: '9105', vatRate: '5' })
    const b = await product(db, 'KUBEK-23', 5, { wfirmaGoodId: '9106', vatRate: '23' })
    await offer(db, 'WOO_SD', 'O5', a)
    const id = await zZamiennikiem([{ offerExternalId: 'O5', qty: 2, unitPriceGross: 12.5 }], 37.99, b)

    const { faktury } = await wystaw()
    expect(faktury[0]!.pozycje).toEqual([
      { goodId: 9106, count: 2, price: '12.50', name: 'Towar testowy KUBEK-23', vat: 222 },
      { goodId: 0, count: 1, price: '12.99', name: 'Wysyłka', vat: 222 },
    ])
    expect(await linieWystawionej(id)).toEqual([{ productId: b, qty: 2, unitGrossGr: 1250, vatRate: '23' }])
  })

  it('oferta wielosztukowa (3 szt. za 30 zł), na stanie 1 szt., zamiana 2 szt. → 1 + 2 szt. po 10 zł', async () => {
    const a = await product(db, 'KUBEK-3A', 1, { wfirmaGoodId: '9107' })
    const b = await product(db, 'KUBEK-3B', 5, { wfirmaGoodId: '9108' })
    await offer(db, 'WOO_SD', 'K3', a, { qtyBasePerOffer: 3 })
    const id = await zZamiennikiem([{ offerExternalId: 'K3', qty: 1, unitPriceGross: 30 }], 42.99, b)

    const { faktury } = await wystaw()
    expect(faktury[0]!.pozycje).toEqual([
      { goodId: 9107, count: 1, price: '10.00', name: 'Towar testowy KUBEK-3A', vat: 222 },
      { goodId: 9108, count: 2, price: '10.00', name: 'Towar testowy KUBEK-3B', vat: 222 },
      { goodId: 0, count: 1, price: '12.99', name: 'Wysyłka', vat: 222 },
    ])
    const linie = await linieWystawionej(id)
    expect(wartosc(linie)).toBe(3000)
    await expectInvariants(db)
  })

  it('pozycja pierwotna zamiennika usunięta: faktura staje z komunikatem dla biura, wFirma nic nie dostaje', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    await offer(db, 'WOO_SD', 'OA', a)
    const id = await zZamiennikiem([{ offerExternalId: 'OA', qty: 1, unitPriceGross: 12.5 }], 25.49, b, async (orderId) => {
      await db.orderLine.updateMany({ where: { orderId, externalLineId: 'L1' }, data: { removed: true } })
    })

    const { faktury } = await wystaw()
    expect(faktury).toHaveLength(0)
    expect(await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'FAILED' })
    const al = await db.alert.findFirstOrThrow({ where: { ref: id, kind: 'FAKTURA_BLAD', closedAt: null } })
    expect(al.message).toContain('Zamień produkt')
    expect(al.message).toContain('Ponów fakturę')
    expect(al.message).not.toMatch(/zamiennik-[a-z-]+/) // bez kodów technicznych
  })

  it('linie rdzenia przed wFirmą (beginInvoice) przy zamienniku na wagę: 50 g = 12,50 zł', async () => {
    const a = await product(db, 'HERB-WA', 0, { unit: 'KG', wfirmaGoodId: '9103', vatRate: '5' })
    const b = await product(db, 'HERB-WB', 1000, { unit: 'KG', wfirmaGoodId: '9104', vatRate: '5' })
    await offer(db, 'WOO_SD', 'W50', a, { qtyBasePerOffer: 50 })
    const id = await zZamiennikiem([{ offerExternalId: 'W50', qty: 2, unitPriceGross: 12.5 }], 37.99, b)
    const s = await beginInvoice(db, id, { now: min(1) })
    if (s.outcome !== 'START') throw new Error(`oczekiwany start faktury, jest ${s.outcome}`)
    expect(wartosc(s.lines)).toBe(2500)
    expect(s.lines).toEqual([{ productId: b, qty: 100, unitGrossGr: 25, vatRate: '5' }])
  })
})

/** Zamówienie z kanału po zbieraniu i pakowaniu (bez zamiany). */
async function spakowane(lines: { offerExternalId: string; qty: number; unitPriceGross: number }[], totalGross: number): Promise<string> {
  const r = await ingestOrder(db, order(lines, { totalGross }), { now: T0 })
  await startPicking(db, r.orderId!, { now: T0 })
  await finishPicking(db, r.orderId!, { now: T0 })
  await packOrder(db, r.orderId!, { now: T0 })
  return r.orderId!
}

async function linieStartu(orderId: string): Promise<InvoiceLine[]> {
  const s = await beginInvoice(db, orderId, { now: min(1) })
  if (s.outcome !== 'START') throw new Error(`oczekiwany start faktury, jest ${s.outcome}`)
  return s.lines
}

describe('braki testów z', () => {
  it('częściowe wydanie, ilość niepodzielna przez przelicznik: 29 g z oferty 50 g za 3,75 zł → 2,18 zł', async () => {
    const a = await product(db, 'HERB-375', 29, { unit: 'KG', wfirmaGoodId: '9110', vatRate: '5' })
    await offer(db, 'WOO_SD', 'W375', a, { qtyBasePerOffer: 50 })
    const id = await spakowane([{ offerExternalId: 'W375', qty: 1, unitPriceGross: 3.75 }], 16.74)
    const linie = await linieStartu(id)
    expect(linie.reduce((s, l) => s + l.qty, 0)).toBe(29)
    expect(wartosc(linie)).toBe(218) // 217,5 gr, nie 217
  })

  it('e-book w ofercie na 2 licencje (qtyBasePerOffer 2) obok towaru: linia usługi 2 szt. za cenę oferty', async () => {
    const t = await product(db, 'KUBEK-E', 5, { wfirmaGoodId: '9111' })
    const e = await db.product.create({ data: { sku: 'EBOOK-2', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book testowy', title: 'E-book testowy', vatRate: '5' } })
    await offer(db, 'WOO_SD', 'KE', t)
    await offer(db, 'WOO_SD', 'E2', e.id, { qtyBasePerOffer: 2 })
    const id = await spakowane([{ offerExternalId: 'KE', qty: 1, unitPriceGross: 20 }, { offerExternalId: 'E2', qty: 1, unitPriceGross: 30 }], 62.99)
    const linie = await linieStartu(id)
    expect(linie.filter((l) => l.service)).toEqual([{ productId: e.id, qty: 2, unitGrossGr: 1500, vatRate: '5', service: true }])
    expect(wartosc(linie)).toBe(5000)
  })

  it('spakowany 1 z 2 zestawów oferty wielozestawowej: składniki zbiorczo, suma = połowa ceny oferty', async () => {
    const a = await product(db, 'ZS-A', 1, { wfirmaGoodId: '9112', priceGross: 20 })
    const b = await product(db, 'ZS-B', 20, { wfirmaGoodId: '9113', priceGross: 10, vatRate: '8' })
    const z = await bundle(db, 'ZESTAW-AB', [{ id: a, qty: 1 }, { id: b, qty: 2 }])
    await offer(db, 'WOO_SD', 'Z2', z, { qtyBasePerOffer: 2 })
    const id = await spakowane([{ offerExternalId: 'Z2', qty: 1, unitPriceGross: 60 }], 72.99)
    const linie = await linieStartu(id)
    const ile = (p: string) => linie.filter((l) => l.productId === p).reduce((s, l) => s + l.qty, 0)
    expect([ile(a), ile(b)]).toEqual([1, 2])
    expect(wartosc(linie)).toBe(3000)
  })

  it('dokument bez rozchodu, zestaw bez rezerwacji pierwszego składnika → próba z ilością 0 (potem jawny błąd), nie ciche NIC_DO_FAKTURY', async () => {
    await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR' } })
    const a = await product(db, 'ZS-A', 5, { priceGross: 20 })
    const b = await product(db, 'ZS-B', 5, { priceGross: 10 })
    const z = await bundle(db, 'ZESTAW-AB', [{ id: a, qty: 1 }, { id: b, qty: 2 }])
    await offer(db, 'WOO_SD', 'Z1', z)
    const r = await ingestOrder(db, order([{ offerExternalId: 'Z1', qty: 1, unitPriceGross: 40 }], { totalGross: 52.99 }), { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(await db.reservation.count({ where: { orderId: o.id, productId: a } })).toBe(1)
    // stan sztuczny (np. rezerwacja pierwszego składnika zdjęta ręcznie): tylko drugi składnik ma rezerwację
    await db.reservation.updateMany({ where: { orderId: o.id, productId: a }, data: { state: 'RELEASED', releasedReason: 'MOVED_TO_SHORTAGE', releasedAt: T0 } })
    const s = await beginDocument(db, o.id, { now: min(1), statusy: [o.status] })
    expect(s.outcome).toBe('START')
    if (s.outcome !== 'START') return
    expect(s.lines.every((l) => l.qty === 0)).toBe(true)
  })
})
