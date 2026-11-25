// etap 2: archiwum Allegro (API i zrzut), Empik i EasyTools na tym samym szkielecie importu, na bazie
// testowej (dane fikcyjne, źródła podstawione, bez sieci).
//  - Allegro: zapis z API, zrzut po API nie dubluje i nie cofa nowszej rewizji, zamówienie z `Order` pominięte,
//    granica `coverageFrom` konta Allegro, oferta → produkt;
//  - Empik: zapis, zwrot pozycji, numer z `commercial_id`, idempotencja;
//  - EasyTools: konto bez `coverageFrom` wymaga `--do`, zamówienie przyjęte przez API zapisu (`Order`) pominięte;
//  - raport sprzedaży liczy archiwum wszystkich kanałów (konta), bez danych klientów w wierszach archiwum.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importujArchiwum } from '@/lib/archiwum/import'
import { czytnikListy, zrodloAllegroApi, zrodloAllegroZrzut, zrodloEasyTools, zrodloEmpik } from '@/lib/archiwum/zrodla'
import { raportSprzedazy, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { testDb, truncateAll } from './db'
import { ACC, product, seedBase } from './rdzen-fixtures'

const a = testDb()
const OD = fromWarsaw('2025-01-01', 0)
const PRZELACZENIE = new Date('2026-11-20T12:00:00.000Z')

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
})
afterAll(async () => {
  await a.$disconnect()
})

function allegro(id: string, kiedy: string, o: { rev?: string; status?: string; f?: string; gr?: number; offer?: string } = {}): Record<string, unknown> {
  const gr = o.gr ?? 5000
  return {
    id,
    status: o.status ?? 'READY_FOR_PROCESSING',
    updatedAt: o.rev ?? kiedy,
    buyer: { email: 'kupujacy@example.test', login: 'k' },
    fulfillment: { status: o.f ?? 'SENT' },
    summary: { totalToPay: { amount: ((gr + 999) / 100).toFixed(2), currency: 'PLN' } },
    payment: { type: 'ONLINE', finishedAt: kiedy, paidAmount: { amount: ((gr + 999) / 100).toFixed(2), currency: 'PLN' } },
    delivery: { method: { name: 'Paczkomat' }, cost: { amount: '9.99', currency: 'PLN' }, address: { street: 'Testowa 1' } },
    lineItems: [{ id: `${id}-1`, quantity: 1, price: { amount: (gr / 100).toFixed(2), currency: 'PLN' }, boughtAt: kiedy, offer: { id: o.offer ?? '9001', name: 'Towar testowy A', external: { id: 'SKU-A' } } }],
  }
}

function empik(id: string, kiedy: string, o: { stan?: string; zwrot?: number } = {}): Record<string, unknown> {
  return {
    order_id: id,
    commercial_id: `C-${id}`,
    order_state: o.stan ?? 'RECEIVED',
    created_date: kiedy,
    last_updated_date: kiedy,
    total_price: 40,
    shipping_price: 10,
    currency_iso_code: 'PLN',
    customer: { firstname: 'Jan', lastname: 'Testowy' },
    order_additional_fields: [{ code: 'customer-email', value: 'klient@example.test' }],
    order_lines: [{ order_line_id: `${id}-1`, order_line_state: 'RECEIVED', quantity: 1, price_unit: 30, product_sku: 'P-1', product_title: 'Towar testowy B', offer_sku: 'SKU-B', ...(o.zwrot ? { refunds: [{ amount: o.zwrot }] } : {}) }],
  }
}

describe('archiwum Allegro', () => {
  it('API: zapis, oferta → produkt, zamówienie z Order pominięte, granica konta; dane kupującego nie trafiają do bazy', async () => {
    await a.channelCursor.create({ data: { ...ACC.ALLEGRO, adapterKey: 'allegro.v1', coverageFrom: PRZELACZENIE } })
    const p = await product(a, 'TEST-A9001', 0)
    await a.channelOffer.create({ data: { ...ACC.ALLEGRO, externalId: '9001', productId: p, qtyBasePerOffer: 1 } })
    await a.order.create({ data: { ...ACC.ALLEGRO, externalId: 'al-2', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'ONLINE', totalGross: '59.99', createdAtChannel: new Date('2025-12-05T10:00:00Z') } })
    const lista = [allegro('al-1', '2025-12-01T10:00:00.000Z'), allegro('al-2', '2025-12-05T10:00:00.000Z'), allegro('al-3', '2026-11-21T10:00:00.000Z'), allegro('al-4', '2025-12-06T10:00:00.000Z', { status: 'CANCELLED', f: 'CANCELLED' })]
    const w = await importujArchiwum(a, zrodloAllegroApi(czytnikListy(lista)), { konto: ACC.ALLEGRO.channelAccountId, od: OD, naSucho: false })
    expect(w).toMatchObject({ granica: 'konto', pobrane: 4, zapisane: 2, bledy: [], koniec: true })
    expect(w.pominiete).toMatchObject({ 'jest w Kompletorze': 1, 'poza zakresem dat': 1 })
    expect(w.sprzedaz).toEqual({ n: 1, bruttoGr: 5999 })
    expect(w.anulowane).toEqual({ n: 1, bruttoGr: 5999 })
    const wiersze = await a.archivedOrder.findMany({ include: { lines: true }, orderBy: { externalId: 'asc' } })
    expect(wiersze.map((x) => [x.externalId, x.source, x.status, x.paymentMethod])).toEqual([
      ['al-1', 'ALLEGRO_API', 'WYSLANE', null],
      ['al-4', 'ALLEGRO_API', 'ANULOWANE', null],
    ])
    expect(wiersze[0]!.lines[0]).toMatchObject({ productId: p, offerId: '9001', sku: 'SKU-A' })
    expect(JSON.stringify(wiersze)).not.toMatch(/@|Testowa/)
  })

  it('zrzut po API: ten sam klucz (bez dubla), starsza rewizja nie cofa danych z API, nowe zamówienie ze zrzutu dochodzi', async () => {
    const konto = ACC.ALLEGRO.channelAccountId
    const doDnia = fromWarsaw('2026-01-01', 0)
    const api = [allegro('al-1', '2025-12-01T10:00:00.000Z', { rev: '2025-12-10T10:00:00.000Z', f: 'PICKED_UP' })]
    await importujArchiwum(a, zrodloAllegroApi(czytnikListy(api)), { konto, od: OD, do: doDnia, naSucho: false })
    const zrzut = [allegro('al-1', '2025-12-01T10:00:00.000Z', { rev: '2025-12-02T10:00:00.000Z', f: 'SENT' }), allegro('al-5', '2025-11-22T10:00:00.000Z')]
    const w = await importujArchiwum(a, zrodloAllegroZrzut(zrzut), { konto, od: OD, do: doDnia, naSucho: false, naStrone: 500 })
    expect(w).toMatchObject({ zapisane: 1, bledy: [] })
    expect(w.pominiete['bez zmian']).toBe(1)
    const wiersze = await a.archivedOrder.findMany({ orderBy: { externalId: 'asc' }, select: { externalId: true, source: true, status: true } })
    expect(wiersze).toEqual([
      { externalId: 'al-1', source: 'ALLEGRO_API', status: 'ODEBRANE' },
      { externalId: 'al-5', source: 'ALLEGRO_ZRZUT', status: 'WYSLANE' },
    ])
  })
})

describe('archiwum Empik', () => {
  it('zapis, numer z commercial_id, zwrot pozycji, drugi przebieg bez zmian', async () => {
    const konto = ACC.EMPIK.channelAccountId
    const doDnia = fromWarsaw('2026-01-01', 0)
    const lista = [empik('e-1', '2025-06-10T08:00:00Z', { zwrot: 5 }), empik('e-2', '2025-06-11T08:00:00Z', { stan: 'CANCELED' }), empik('e-3', '2025-06-12T08:00:00Z', { stan: 'STAGING' })]
    const w1 = await importujArchiwum(a, zrodloEmpik(czytnikListy(lista)), { konto, od: OD, do: doDnia, naSucho: false })
    expect(w1).toMatchObject({ zapisane: 2, bledy: [], zwrotyGr: 500 })
    expect(w1.pominiete.szkic).toBe(1)
    const w2 = await importujArchiwum(a, zrodloEmpik(czytnikListy(lista)), { konto, od: OD, do: doDnia, naSucho: false })
    expect(w2.pominiete['bez zmian']).toBe(2)
    const e1 = await a.archivedOrder.findFirstOrThrow({ where: { externalId: 'e-1' }, include: { lines: true } })
    expect(e1).toMatchObject({ source: 'MIRAKL_API', channelNumber: 'C-e-1', status: 'ODEBRANE' })
    expect(Number(e1.refundGross)).toBe(5)
    expect(Number(e1.lines[0]!.refundGross)).toBe(5)
    expect(JSON.stringify(e1)).not.toMatch(/@|Testowy/)
  })
})

describe('archiwum EasyTools', () => {
  const et = (id: string, kiedy: string, status = 'completed') => ({ id, status, amount: 8900, currency: 'pln', quantity: 1, product_name: 'Towar testowy e-book', customer_email: 'k@example.test', created_at: kiedy })

  it('konto bez coverageFrom wymaga --do; zamówienie przyjęte przez API zapisu pominięte; raport liczy archiwum kanału', async () => {
    const konto = ACC.EASYTOOLS.channelAccountId
    const lista = [et('et-1', '2026-03-02T10:00:00+01:00'), et('et-2', '2026-03-03T10:00:00+01:00', 'canceled'), et('et-3', '2026-03-04T10:00:00+01:00')]
    await expect(importujArchiwum(a, zrodloEasyTools(lista), { konto, od: OD, naSucho: true })).rejects.toThrow(/podaj --do/)
    await a.order.create({ data: { ...ACC.EASYTOOLS, externalId: 'et-3', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'EasyTools', totalGross: '89.00', createdAtChannel: new Date('2026-03-04T09:00:00Z') } })
    const w = await importujArchiwum(a, zrodloEasyTools(lista), { konto, od: OD, do: fromWarsaw('2026-11-20', 0), naSucho: false, naStrone: 500 })
    expect(w).toMatchObject({ zapisane: 2, bledy: [], sprzedaz: { n: 1, bruttoGr: 8900 }, anulowane: { n: 1, bruttoGr: 8900 } })
    expect(w.pominiete['jest w Kompletorze']).toBe(1)
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2026-03-01', do: '2026-03-31', grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z')))
    expect(r.razem).toMatchObject({ zamowien: 2, anulowanych: 1 })
    expect(r.zArchiwum).toEqual({ zamowien: 1, brutto: 89, inneWaluty: [] })
    expect(JSON.stringify(await a.archivedOrder.findMany())).not.toMatch(/@/)
  })
})
