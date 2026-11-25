// faktura opłaconego zamówienia wychodzi do wFirmy jako opłacona. Cały tor jak: kolejka wFirmy →
// adapter zapisu (`zlozFaktureZamowienia`) → klient `WfirmaZapis` → atrapa HTTP wFirmy (zero sieci, zero prawdziwych
// faktur). PAID: `alreadypaid_initial` = brutto faktury i `paymentdate` = dzień wystawienia; COD: forma „pobranie”, bez
// zapłaty; UNPAID: bez zapłaty; PARTIAL: kwota wpłat zapisanych w Kompletorze; PAID po edycji karty bez dopłaty: kwota
// sprzed edycji. Empik „Płatność z góry”: przelew + opłacone. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PaymentState } from '@prisma/client'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { finishPicking, startPicking } from '@/lib/rdzen/przejscia'
import { packOrder } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { FakturyWfirmaZapis } from '@/lib/wfirma/adapter-zapis'
import { dzienWystawienia } from '@/lib/wfirma/platnosci'
import { WfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { WfirmaZapis } from '@/lib/zrodla/wfirma-zapis'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, order, product, seedBase, T0, type TestChannel } from './rdzen-fixtures'
import { KLUCZE_TESTOWE, WfirmaHttpAtrapa } from './wfirma-http-atrapa'

const db = testDb()
afterAll(() => db.$disconnect())

const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: null, email: null },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}
const adapter = (w: WfirmaHttpAtrapa) => new FakturyWfirmaZapis(new WfirmaReadOnly(KLUCZE_TESTOWE, w.fetch, 0), db, { zapis: new WfirmaZapis(KLUCZE_TESTOWE, w.fetch, 0), odbiorca: async () => ODBIORCA })
const min = (m: number) => new Date(T0.getTime() + m * 60_000)

async function spakowane(sku: string, over: Parameters<typeof order>[1]): Promise<string> {
  const tea = await product(db, sku, 5, { wfirmaGoodId: '7101' })
  const r = await ingestOrder(db, order([{ productId: tea, qty: 2 }], { totalGross: 32.99, ...over }), { now: T0 })
  expect(r.status).toBe('DO_REALIZACJI')
  await startPicking(db, r.orderId!, { now: T0 })
  await finishPicking(db, r.orderId!, { now: T0 })
  await packOrder(db, r.orderId!, { now: T0 })
  return r.orderId!
}

/** Wystawienie przez kolejkę wFirmy; zwraca fakturę z atrapy i dni, w których mógł wypaść „dziś” przebiegu. */
async function wystaw(): Promise<{ f: WfirmaHttpAtrapa['faktury'][number]; dni: string[] }> {
  const w = new WfirmaHttpAtrapa()
  const przed = dzienWystawienia(new Date())
  const st = await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
  const po = dzienWystawienia(new Date())
  expect(st.invoices).toBe(1)
  expect(w.faktury).toHaveLength(1)
  return { f: w.faktury[0]!, dni: [przed, po] }
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  for (const l of ['WOO_SD', 'EMPIK'] as TestChannel[]) await db.channelConfig.updateMany({ where: ACC[l], data: { statusMode: 'PRACA' } })
  await testSystemDb().organization.update({
    where: { id: 'test_a' },
    data: { settings: { faktury: { kodyVat: { '23': 222, '8': 223, '5': 224, '0': 234 }, program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() } } as never },
  })
})

describe('kwota zapłacona na fakturze z Kompletora', () => {
  it('PAID (BLIK): przelew, zapłacono = brutto faktury, termin płatności = dzień wystawienia', async () => {
    await spakowane('A344-PAID', { paymentState: 'PAID', paymentMethod: 'BLIK' })
    const { f, dni } = await wystaw()
    expect(f.paymentmethod).toBe('transfer')
    expect(f.alreadypaidInitial).toBe('32.99')
    expect(dni).toContain(f.paymentdate)
  })

  it('Empik „Płatność z góry” (opłacone w kanale): przelew i opłacone w całości', async () => {
    await spakowane('A344-EMPIK', { channel: 'EMPIK', paymentState: 'PAID', paymentMethod: 'Płatność z góry' })
    const { f, dni } = await wystaw()
    expect(f.paymentmethod).toBe('transfer')
    expect(f.alreadypaidInitial).toBe('32.99')
    expect(dni).toContain(f.paymentdate)
  })

  it('COD: forma „pobranie”, bez kwoty zapłaconej i bez terminu (do zapłaty kurierowi)', async () => {
    await spakowane('A344-COD', { paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    const { f } = await wystaw()
    expect(f.paymentmethod).toBe('cod')
    expect(f.alreadypaidInitial).toBeNull()
    expect(f.paymentdate).toBeNull()
  })

  it.each([['UNPAID'], ['PARTIAL']] as [PaymentState][])('%s bez wpłat w Kompletorze: bez kwoty zapłaconej (jak przed zmianą)', async (stan) => {
    const id = await spakowane(`A344-${stan}`, { paymentState: 'PAID', paymentMethod: 'Przelew bankowy' })
    await db.order.update({ where: { id }, data: { paymentState: stan } })
    const { f } = await wystaw()
    expect(f.paymentmethod).toBe('transfer')
    expect(f.alreadypaidInitial).toBeNull()
    expect(f.paymentdate).toBeNull()
  })

  it('PARTIAL z wpłatą 10 zł zapisaną w Kompletorze: zapłacono 10,00, termin domyślny wFirmy', async () => {
    const id = await spakowane('A344-PARTIAL-W', { paymentState: 'PAID', paymentMethod: 'Przelew bankowy' })
    await db.order.update({ where: { id }, data: { paymentState: 'PARTIAL' } })
    await db.orderPayment.create({ data: { orderId: id, kind: 'WPLATA', amount: 10, method: 'przelew', paidAt: T0, actorId: 'u-test' } })
    const { f } = await wystaw()
    expect(f.alreadypaidInitial).toBe('10.00')
    expect(f.paymentdate).toBeNull()
  })

  it('PAID po edycji karty (kwota sprzed edycji 20 zł, dopłaty brak): zapłacono 20,00, reszta do zapłaty', async () => {
    const id = await spakowane('A344-EDYCJA', { paymentState: 'PAID', paymentMethod: 'BLIK' })
    await db.order.update({ where: { id }, data: { flags: { kwotaZaplacona: '20.00' } } })
    const { f } = await wystaw()
    expect(f.alreadypaidInitial).toBe('20.00')
    expect(f.paymentdate).toBeNull()
  })
})
