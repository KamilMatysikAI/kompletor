// faktura przy ofercie na kilka jednostek bazowych (qtyBasePerOffer > 1) i towarze na wagę.
// Dwa poziomy: (1) linie rdzenia (`beginInvoice`, zapis próby `InvoiceAttempt.payload`): ilość w jednostce bazowej,
// kwota z ceny za sztukę oferty; (2) cały tor zapisu do wFirmy: kolejka → adapter zapisu (`zlozFakture`) → atrapa HTTP
// wFirmy (zero sieci, zero prawdziwych faktur). Przykład z zadania: oferta 50 g za 12,50 zł, 2 sztuki oferty → 25 zł,
// ilość 0,1 kg. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { finishPicking, startPicking } from '@/lib/rdzen/przejscia'
import { beginInvoice, type InvoiceLine, packOrder } from '@/lib/rdzen/rozchod'
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
const ilosc = (l: InvoiceLine[], p: string) => l.filter((x) => x.productId === p).reduce((s, x) => s + x.qty, 0)

async function spakowane(lines: { offerExternalId: string; qty: number; unitPriceGross: number }[], totalGross: number): Promise<string> {
  const r = await ingestOrder(db, order(lines, { totalGross }), { now: T0 })
  expect(r.status).toBe('DO_REALIZACJI')
  await startPicking(db, r.orderId!, { now: T0 })
  await finishPicking(db, r.orderId!, { now: T0 })
  await packOrder(db, r.orderId!, { now: T0 })
  return r.orderId!
}

/** Linie rdzenia z samego startu próby (bez wywołania wFirmy). */
async function linieRdzenia(orderId: string): Promise<InvoiceLine[]> {
  const b = await beginInvoice(db, orderId, { now: min(1) })
  if (b.outcome !== 'START') throw new Error(`oczekiwany start faktury, jest ${b.outcome}`)
  return b.lines
}

/** Linie rdzenia, z którymi kolejka wystawiła fakturę (zapis próby). */
async function linieWystawionej(orderId: string): Promise<InvoiceLine[]> {
  const a = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId, state: 'ISSUED' } })
  expect(a.idExternal).toBe(`${orderId}/1/1`)
  return a.payload as unknown as InvoiceLine[]
}

const wystaw = async () => {
  const w = new WfirmaHttpAtrapa()
  const st = await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
  expect(st.invoices).toBe(1)
  expect(w.faktury).toHaveLength(1)
  return w.faktury[0]!
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.channelConfig.updateMany({ where: ACC.WOO_SD, data: { statusMode: 'PRACA' } })
  await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { kodyVat: KODY_VAT, program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() } } as never } })
})

describe('kwota i ilość faktury przy qtyBasePerOffer > 1', () => {
  it('towar na wagę: oferta 50 g za 12,50 zł × 2 → linie rdzenia 100 g za 25 zł; wFirma: 0,1 kg, 25 zł', async () => {
    const herb = await product(db, 'HERB-WAGA', 1000, { unit: 'KG', wfirmaGoodId: '8101', vatRate: '5' })
    await offer(db, 'WOO_SD', 'W50', herb, { qtyBasePerOffer: 50 })
    const id = await spakowane([{ offerExternalId: 'W50', qty: 2, unitPriceGross: 12.5 }], 37.99)

    const f = await wystaw()
    const linie = await linieWystawionej(id)
    expect(ilosc(linie, herb)).toBe(100) // gramy: tyle zeszło ze stanu
    expect(wartosc(linie)).toBe(2500) // 25 zł, nie 100 × 12,50 zł = 1250 zł
    expect(linie).toEqual([{ productId: herb, qty: 100, unitGrossGr: 25, vatRate: '5' }])
    expect(f.pozycje).toEqual([
      { goodId: 8101, count: 0.1, price: '250.00', name: 'Towar testowy HERB-WAGA', vat: 224 }, // 0,1 kg × 250 zł/kg = 25 zł
      { goodId: 0, count: 1, price: '12.99', name: 'Wysyłka', vat: 222 },
    ])
    await expectInvariants(db)
  })

  it('oferta wielosztukowa: 3 szt. za 30 zł × 2 → 6 szt. po 10 zł, 60 zł; wFirma: 6 szt. po 10 zł', async () => {
    const kubek = await product(db, 'KUBEK-3P', 20, { wfirmaGoodId: '8102' })
    await offer(db, 'WOO_SD', 'K3', kubek, { qtyBasePerOffer: 3 })
    const id = await spakowane([{ offerExternalId: 'K3', qty: 2, unitPriceGross: 30 }], 72.99)

    const f = await wystaw()
    expect(await linieWystawionej(id)).toEqual([{ productId: kubek, qty: 6, unitGrossGr: 1000, vatRate: '23' }])
    expect(f.pozycje).toEqual([
      { goodId: 8102, count: 6, price: '10.00', name: 'Towar testowy KUBEK-3P', vat: 222 },
      { goodId: 0, count: 1, price: '12.99', name: 'Wysyłka', vat: 222 },
    ])
    await expectInvariants(db)
  })

  it('cena niepodzielna przez gramy (50 g za 12,99 zł): linie rdzenia sumują się co do grosza', async () => {
    const herb = await product(db, 'HERB-1299', 1000, { unit: 'KG', wfirmaGoodId: '8103', vatRate: '5' })
    await offer(db, 'WOO_SD', 'W1299', herb, { qtyBasePerOffer: 50 })
    const id = await spakowane([{ offerExternalId: 'W1299', qty: 1, unitPriceGross: 12.99 }], 25.98)
    const linie = await linieRdzenia(id)
    expect(ilosc(linie, herb)).toBe(50)
    expect(wartosc(linie)).toBe(1299)
  })

  it('zestaw w ofercie na 2 zestawy: składniki w jednostce bazowej, suma = cena oferty', async () => {
    const a = await product(db, 'ZS-A', 20, { wfirmaGoodId: '8104', priceGross: 20 })
    const b = await product(db, 'ZS-B', 20, { wfirmaGoodId: '8105', priceGross: 10, vatRate: '8' })
    const z = await bundle(db, 'ZESTAW-AB', [{ id: a, qty: 1 }, { id: b, qty: 2 }])
    await offer(db, 'WOO_SD', 'Z2', z, { qtyBasePerOffer: 2 })
    const id = await spakowane([{ offerExternalId: 'Z2', qty: 1, unitPriceGross: 60 }], 72.99)

    const f = await wystaw()
    const linie = await linieWystawionej(id)
    expect([ilosc(linie, a), ilosc(linie, b)]).toEqual([2, 4])
    expect(wartosc(linie)).toBe(6000) // nie 2 zestawy × 60 zł
    const towar = f.pozycje.filter((p) => p.goodId > 0)
    expect(towar.reduce((s, p) => s + Math.round(p.count * Number(p.price) * 100), 0)).toBe(6000)
    await expectInvariants(db)
  })
})
