// edycja pozycji zamiennika
// z karty i dosłanie albo podział zamiennika. Cały tor jak w zamiennik-faktura: zamówienie → brak → `swapProduct`
// → (edycja z karty) → zbieranie i pakowanie → kolejka wFirmy → adapter zapisu → atrapa HTTP wFirmy (zero sieci).
// Zasada: faktura = kwota zapłacona; edycja, która by ją rozjechała, jest odmówiona z komunikatem dla osoby.
// Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { markMissingOnShelf, ShortageActionError, shipLater, swapProduct } from '@/lib/rdzen/brakuje'
import { changeLinePrice, changeLineQty, EdycjaError, removeOrderLine, splitOrder } from '@/lib/rdzen/edycja'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { finishPicking, startPicking } from '@/lib/rdzen/przejscia'
import { packOrder } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { FakturyWfirmaZapis } from '@/lib/wfirma/adapter-zapis'
import { WfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { WfirmaZapis } from '@/lib/zrodla/wfirma-zapis'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, expectInvariants, offer, order, product, seedBase, T0 } from './rdzen-fixtures'
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
const groszeFaktury = (pozycje: { count: number; price: string }[]) => pozycje.reduce((s, p) => s + Math.round(p.count * Number(p.price) * 100), 0)
const ZAMIANA = /pozycja z zamiany/

type Linia = { offerExternalId: string; qty: number; unitPriceGross: number }

/** Zamówienie z brakiem na L1, zamiana braku, `edycja` (z karty, przed zbieraniem), zbieranie, pakowanie, faktura. */
async function scenariusz(lines: Linia[], totalGross: number, zamiennik: string, edycja: (orderId: string, zamiennikId: string) => Promise<unknown>) {
  const r = await ingestOrder(db, order(lines, { totalGross }), { now: T0 })
  const id = r.orderId!
  const l1 = await db.orderLine.findFirstOrThrow({ where: { orderId: id, externalLineId: 'L1' } })
  const z = await swapProduct(db, l1.id, zamiennik, { now: T0 })
  const wynik = await edycja(id, z.lineId).then(
    () => 'edycja przeszła' as const,
    (e: unknown) => e,
  )
  await startPicking(db, id, { now: T0 })
  await finishPicking(db, id, { now: T0 })
  await packOrder(db, id, { now: T0 })
  const w = new WfirmaHttpAtrapa()
  await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
  const kwota = Math.round(Number((await db.order.findUniqueOrThrow({ where: { id } })).totalGross) * 100)
  return { id, wynik, kwota, faktury: w.faktury.map((f) => groszeFaktury(f.pozycje)) }
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.channelConfig.updateMany({ where: ACC.WOO_SD, data: { statusMode: 'PRACA' } })
  await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { kodyVat: KODY_VAT, program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() } } as never } })
})

describe('edycja pozycji zamiennika z karty jest odmówiona, faktura = kwota zapłacona', () => {
  it('1a. cena zamiennika 12,50 → 15,00 zł: odmowa; faktura 25,49 zł (przed rundą 2: 30,49 zł przy kwocie 27,99 zł)', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    await offer(db, 'WOO_SD', 'OA', a)
    const s = await scenariusz([{ offerExternalId: 'OA', qty: 1, unitPriceGross: 12.5 }], 25.49, b, (id, z) => changeLinePrice(db, id, z, { priceGrossGr: 1500 }))
    expect({ kwota: s.kwota, faktury: s.faktury }).toEqual({ kwota: 2549, faktury: [2549] })
    expect(s.wynik).toBeInstanceOf(EdycjaError)
    expect((s.wynik as Error).message).toMatch(ZAMIANA)
    await expectInvariants(db)
  })

  it('1b. cena w dół 12,50 → 10,00 zł: odmowa; faktura 25,49 zł (przed: 20,49 zł przy kwocie 22,99 zł)', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    await offer(db, 'WOO_SD', 'OA', a)
    const s = await scenariusz([{ offerExternalId: 'OA', qty: 1, unitPriceGross: 12.5 }], 25.49, b, (id, z) => changeLinePrice(db, id, z, { priceGrossGr: 1000 }))
    expect({ kwota: s.kwota, faktury: s.faktury }).toEqual({ kwota: 2549, faktury: [2549] })
    expect((s.wynik as Error).message).toMatch(ZAMIANA)
  })

  it('2. na wagę (oferta 50 g za 12,50 zł), cena zamiennika 15,00 zł: odmowa; faktura 25,49 zł (przed: 152,99 zł przy 150,49 zł)', async () => {
    const a = await product(db, 'HERB-WA', 0, { unit: 'KG', wfirmaGoodId: '9103', vatRate: '5' })
    const b = await product(db, 'HERB-WB', 1000, { unit: 'KG', wfirmaGoodId: '9104', vatRate: '5' })
    await offer(db, 'WOO_SD', 'W50', a, { qtyBasePerOffer: 50 })
    const s = await scenariusz([{ offerExternalId: 'W50', qty: 1, unitPriceGross: 12.5 }], 25.49, b, (id, z) => changeLinePrice(db, id, z, { priceGrossGr: 1500 }))
    expect({ kwota: s.kwota, faktury: s.faktury }).toEqual({ kwota: 2549, faktury: [2549] })
    expect((s.wynik as Error).message).toMatch(ZAMIANA)
  })

  it('3. ilość zamiennika 2 → 1: odmowa; faktura 32,99 zł (przed: 12,99 zł przy kwocie 22,99 zł)', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    await offer(db, 'WOO_SD', 'OA', a)
    const s = await scenariusz([{ offerExternalId: 'OA', qty: 2, unitPriceGross: 10 }], 32.99, b, (id, z) => changeLineQty(db, id, z, 1))
    expect({ kwota: s.kwota, faktury: s.faktury }).toEqual({ kwota: 3299, faktury: [3299] })
    expect((s.wynik as Error).message).toMatch(ZAMIANA)
    await expectInvariants(db)
  })

  it('4. usunięcie zamiennika: odmowa; faktura 37,99 zł (przed: 27,99 zł przy kwocie 32,99 zł)', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    const c = await product(db, 'HERB-C', 5, { wfirmaGoodId: '9105' })
    await offer(db, 'WOO_SD', 'OA', a)
    await offer(db, 'WOO_SD', 'OC', c)
    const s = await scenariusz(
      [
        { offerExternalId: 'OA', qty: 1, unitPriceGross: 5 },
        { offerExternalId: 'OC', qty: 1, unitPriceGross: 20 },
      ],
      37.99,
      b,
      (id, z) => removeOrderLine(db, id, z),
    )
    expect({ kwota: s.kwota, faktury: s.faktury }).toEqual({ kwota: 3799, faktury: [3799] })
    expect((s.wynik as Error).message).toMatch(ZAMIANA)
  })

  it('usunięcie pozycji pierwotnej, która ma zamiennik: odmowa (bez niej kwoty zamiennika nie da się ustalić)', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    const c = await product(db, 'HERB-C', 5, { wfirmaGoodId: '9105' })
    await offer(db, 'WOO_SD', 'OA', a)
    await offer(db, 'WOO_SD', 'OC', c)
    const s = await scenariusz(
      [
        { offerExternalId: 'OA', qty: 1, unitPriceGross: 5 },
        { offerExternalId: 'OC', qty: 1, unitPriceGross: 20 },
      ],
      37.99,
      b,
      async (id) => removeOrderLine(db, id, (await db.orderLine.findFirstOrThrow({ where: { orderId: id, externalLineId: 'L1' } })).id),
    )
    expect(s.faktury).toEqual([3799])
    expect(s.wynik).toBeInstanceOf(EdycjaError)
    expect((s.wynik as Error).message).toMatch(/ma zamiennik/)
  })

  it('podział zamówienia z zamiennikiem w nowej paczce: odmowa', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    const c = await product(db, 'HERB-C', 5, { wfirmaGoodId: '9105' })
    await offer(db, 'WOO_SD', 'OA', a)
    await offer(db, 'WOO_SD', 'OC', c)
    const s = await scenariusz(
      [
        { offerExternalId: 'OA', qty: 1, unitPriceGross: 5 },
        { offerExternalId: 'OC', qty: 1, unitPriceGross: 20 },
      ],
      37.99,
      b,
      (id, z) => splitOrder(db, id, { [z]: 1 }),
    )
    expect(s.faktury).toEqual([3799])
    expect((s.wynik as Error).message).toMatch(ZAMIANA)
  })
})

describe('dane sprzed poprawki albo inna droga zapisu — dokument staje z komunikatem, nie wychodzi', () => {
  it('zamiennik z ceną 15,00 zł zapisaną poza kartą (kwota 27,99 zł): próba FAILED, alert, wFirma nic nie dostaje', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    await offer(db, 'WOO_SD', 'OA', a)
    const s = await scenariusz([{ offerExternalId: 'OA', qty: 1, unitPriceGross: 12.5 }], 25.49, b, async (id, z) => {
      await db.orderLine.update({ where: { id: z }, data: { unitPriceGross: '15.00' } })
      await db.order.update({ where: { id }, data: { totalGross: '27.99' } })
    })
    expect(s.faktury).toEqual([]) // przed rundą 2: [3049]
    expect(await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: s.id } })).toMatchObject({ state: 'FAILED' })
    const al = await db.alert.findFirstOrThrow({ where: { ref: s.id, kind: 'FAKTURA_BLAD', closedAt: null } })
    expect(al.message).toContain('Zamień produkt')
    expect(al.message).toContain('Dokument wystawiony')
  })
})

describe('zamiana części pozycji na torze wFirmy', () => {
  it('oferta 2 szt. za 10,01 zł, 1 szt. na stanie, zamiana 1 szt. + wysyłka 12,99 zł → faktura 23,00 zł (przed: 23,01)', async () => {
    const a = await product(db, 'KUBEK-2A', 1, { wfirmaGoodId: '9107' })
    const b = await product(db, 'KUBEK-2B', 5, { wfirmaGoodId: '9108' })
    await offer(db, 'WOO_SD', 'K2', a, { qtyBasePerOffer: 2 })
    const s = await scenariusz([{ offerExternalId: 'K2', qty: 1, unitPriceGross: 10.01 }], 23, b, async () => undefined)
    expect(s.faktury).toEqual([2300])
    await expectInvariants(db)
  })
})

describe('dosłanie zamiennika osobną paczką jest odmówione', () => {
  it('brak na zamienniku przy zbieraniu → „Dośle później” odmawia z komunikatem', async () => {
    const a = await product(db, 'HERB-A', 0, { wfirmaGoodId: '9101' })
    const b = await product(db, 'HERB-B', 5, { wfirmaGoodId: '9102' })
    await offer(db, 'WOO_SD', 'OA', a)
    const r = await ingestOrder(db, order([{ offerExternalId: 'OA', qty: 1, unitPriceGross: 12.5 }], { totalGross: 25.49 }), { now: T0 })
    const l1 = await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId!, externalLineId: 'L1' } })
    const z = await swapProduct(db, l1.id, b, { now: T0 })
    await startPicking(db, r.orderId!, { now: T0 })
    await markMissingOnShelf(db, z.lineId, b, 1, { now: T0 })
    await expect(shipLater(db, z.lineId, { now: T0 })).rejects.toThrow(ShortageActionError)
    await expect(shipLater(db, z.lineId, { now: T0 })).rejects.toThrow(/nie da się dosłać/)
    expect(await db.order.count({ where: { parentOrderId: r.orderId! } })).toBe(0)
    await expectInvariants(db)
  })
})
