// etap 1: archiwum zamówień Woo na bazie testowej (dane fikcyjne, sklep podstawiony, bez sieci).
//  - import: zapis, idempotencja (drugi przebieg = „bez zmian”), wznowienie od kursora, błąd jednego zamówienia
//    nie zatrzymuje reszty, na sucho zero zapisów;
//  - rozłączność z `Order`: granica `coverageFrom`, `--do` przycięte, zamówienie już w `Order` pominięte;
//  - raport sprzedaży: okres tylko z archiwum, okres mieszany, brak dubli na granicy przełączenia, anulowane
//    i zwroty archiwum, „poza Kompletorem” bez kopii z archiwum; izolacja firm (RLS);
//  - bieżące liczniki pulpitu bez archiwum.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { importujArchiwumWoo, type CzytajStroneWoo } from '@/lib/archiwum/import'
import { raportSprzedazy, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { dashboard } from '@/lib/panel/dane'
import { odswiezKursy } from '@/lib/kursy/nbp'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { ACC, product, seedBase } from './rdzen-fixtures'

const a = testDb()

/** Atrapa odpowiedzi NBP `tables/a/` (jak w tests/sumy-obca-waluta-a392.integration.test.ts), bez sieci. */
const atrapaNbp = (effectiveDate: string, kursy: Record<string, number>) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify([{ table: 'A', no: `TEST/A/NBP/${effectiveDate}`, effectiveDate, rates: Object.entries(kursy).map(([code, mid]) => ({ currency: 'waluta', code, mid })) }]),
})
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
const KONTO = ACC.WOO_SD.channelAccountId
const PRZELACZENIE = new Date('2026-11-19T12:00:00.000Z') // coverageFrom konta: od tej chwili czyta Kompletor

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) await seedBase(db)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
  await sys.$disconnect()
})

/** Zamówienie Woo w kształcie API (tylko pola z listy `_fields`), kwoty w groszach. */
function woo(id: number, kiedy: Date, o: { status?: string; pozycje?: { pid: number; qty: number; gr: number }[]; wysylkaGr?: number; zwrotGr?: number; rev?: string } = {}): Record<string, unknown> {
  const pozycje = o.pozycje ?? [{ pid: 501, qty: 2, gr: 3000 }]
  const wys = o.wysylkaGr ?? 1499
  const total = pozycje.reduce((s, p) => s + p.gr, 0) + wys
  const iso = kiedy.toISOString().slice(0, 19)
  return {
    id,
    number: String(100000 + id),
    status: o.status ?? 'completed',
    currency: 'PLN',
    date_created_gmt: iso,
    date_modified_gmt: o.rev ?? iso,
    date_paid_gmt: iso,
    date_completed_gmt: iso,
    total: (total / 100).toFixed(2),
    shipping_total: (wys / 100).toFixed(2),
    shipping_tax: '0.00',
    payment_method: 'przelewy24',
    line_items: pozycje.map((p, i) => ({ id: id * 10 + i, name: `Towar testowy ${p.pid}`, sku: `H-${p.pid}`, product_id: p.pid, variation_id: 0, quantity: p.qty, total: (p.gr / 100).toFixed(2), total_tax: '0.00' })),
    fee_lines: [],
    shipping_lines: [{ method_title: 'Kurier' }],
    refunds: o.zwrotGr ? [{ id: 1, total: (-o.zwrotGr / 100).toFixed(2) }] : [],
  }
}

/** Sklep podstawiony: lista posortowana po dacie, filtr [od, do) jak `after`/`before`, strony; licznik wywołań. */
function sklep(lista: Record<string, unknown>[], opts: { zepsujStrone?: number } = {}): CzytajStroneWoo & { wolan: number[] } {
  const wolan: number[] = []
  const f = (async (q) => {
    wolan.push(q.strona)
    if (opts.zepsujStrone === q.strona) {
      opts.zepsujStrone = undefined
      throw new Error('Woo /orders: HTTP 503')
    }
    const wZakresie = lista.filter((r) => {
      const t = new Date(`${String(r['date_created_gmt'])}Z`).getTime()
      return t > q.od.getTime() - 1000 && t < q.do.getTime() + 1000
    })
    const s = wZakresie.slice((q.strona - 1) * q.naStrone, q.strona * q.naStrone)
    return { zamowienia: s, razem: wZakresie.length, stron: Math.ceil(wZakresie.length / q.naStrone) }
  }) as CzytajStroneWoo & { wolan: number[] }
  f.wolan = wolan
  return f
}

const OD = fromWarsaw('2025-01-01', 0)

async function pokrycie(db: PrismaClient, kiedy = PRZELACZENIE) {
  await db.channelCursor.create({ data: { channel: 'WOO', channelAccountId: KONTO, adapterKey: 'woo.rest.v1', coverageFrom: kiedy } })
}

describe('import archiwum Woo', () => {
  it('zapisuje, drugi przebieg nic nie zmienia, pozycje dostają produkt z oferty (także nieaktywnej)', async () => {
    await pokrycie(a)
    const p = await product(a, 'TEST-H501', 0)
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: '501', productId: p, qtyBasePerOffer: 50, active: false } })
    const lista = [woo(1, new Date('2025-03-02T10:00:00Z')), woo(2, new Date('2025-03-03T10:00:00Z'), { status: 'cancelled' }), woo(3, new Date('2025-03-04T10:00:00Z'), { status: 'checkout-draft' })]
    const w1 = await importujArchiwumWoo(a, sklep(lista), { konto: KONTO, od: OD, naSucho: false })
    expect(w1).toMatchObject({ granica: 'konto', zapisane: 2, pobrane: 3, koniec: true, razemWSklepie: 3, bledy: [] })
    expect(w1.pominiete.szkic).toBe(1)
    expect(w1.do.toISOString()).toBe(PRZELACZENIE.toISOString())
    const zam = await a.archivedOrder.findMany({ orderBy: { externalId: 'asc' }, include: { lines: true } })
    expect(zam.map((z) => [z.externalId, z.channelNumber, z.status, z.totalGross.toFixed(2), z.source, z.paymentMethod])).toEqual([
      ['1', '100001', 'WYSLANE', '44.99', 'WOO_API', null],
      ['2', '100002', 'ANULOWANE', '44.99', 'WOO_API', null],
    ])
    expect(zam[0]!.lines.map((l) => [l.productId, l.qty.toFixed(3), l.lineGross.toFixed(2), l.offerId])).toEqual([[p, '100.000', '30.00', '501']])
    const run = await a.importRun.findFirstOrThrow({ where: { id: w1.runId! } })
    expect(run).toMatchObject({ kind: 'archiwum-woo', status: 'OK' })
    expect(run.reportMarkdown).toContain('Zapisane: 2')

    const w2 = await importujArchiwumWoo(a, sklep(lista), { konto: KONTO, od: OD, naSucho: false })
    expect(w2.zapisane).toBe(0)
    expect(w2.pominiete['bez zmian']).toBe(2)
    expect(await a.archivedOrder.count()).toBe(2)
    expect(await a.archivedOrderLine.count()).toBe(2)

    // zmiana rewizji w sklepie: zamówienie nadpisane, pozycje zastąpione (bez dubli)
    lista[0] = woo(1, new Date('2025-03-02T10:00:00Z'), { rev: '2025-04-01T00:00:00', pozycje: [{ pid: 501, qty: 1, gr: 1500 }, { pid: 999, qty: 1, gr: 500 }] })
    const w3 = await importujArchiwumWoo(a, sklep(lista), { konto: KONTO, od: OD, naSucho: false })
    expect(w3.zapisane).toBe(1)
    const z1 = await a.archivedOrder.findFirstOrThrow({ where: { externalId: '1' }, include: { lines: { orderBy: { externalLineId: 'asc' } } } })
    expect(z1.lines.map((l) => [l.productId, l.qty.toFixed(3), l.lineGross.toFixed(2)])).toEqual([
      [p, '50.000', '15.00'],
      [null, '1.000', '5.00'],
    ])
  })

  it('na sucho: zero zapisów (także bez przebiegu w ImportRun)', async () => {
    await pokrycie(a)
    const w = await importujArchiwumWoo(a, sklep([woo(1, new Date('2025-05-01T10:00:00Z'))]), { konto: KONTO, od: OD, naSucho: true })
    expect(w).toMatchObject({ naSucho: true, zapisane: 1, runId: null })
    expect(await a.archivedOrder.count()).toBe(0)
    expect(await a.importRun.count()).toBe(0)
  })

  it('rozłączność: granica coverageFrom, --do przycięte, zamówienie już w Order pominięte', async () => {
    await pokrycie(a)
    await a.order.create({ data: { ...ACC.WOO_SD, externalId: '11', status: 'NOWE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '10.00', createdAtChannel: new Date('2026-11-18T10:00:00Z') } })
    const lista = [woo(10, new Date('2026-11-18T09:00:00Z')), woo(11, new Date('2026-11-18T10:00:00Z')), woo(12, new Date('2026-11-19T12:00:00Z')), woo(13, new Date('2026-11-20T08:00:00Z'))]
    const w = await importujArchiwumWoo(a, sklep(lista), { konto: KONTO, od: OD, do: fromWarsaw('2026-12-01', 0), naSucho: false })
    expect(w.granica).toBe('parametr przycięty do konta')
    expect(w.zapisane).toBe(1)
    expect(w.pominiete['jest w Kompletorze']).toBe(1)
    expect((await a.archivedOrder.findMany({ select: { externalId: true } })).map((x) => x.externalId)).toEqual(['10'])
    // zamówienie dokładnie w chwili przełączenia należy do Kompletora (koniec zakresu wyłącznie)
    expect(w.pominiete['poza zakresem dat']).toBe(1)
  })

  it('konto bez coverageFrom wymaga jawnego --do', async () => {
    await expect(importujArchiwumWoo(a, sklep([]), { konto: KONTO, od: OD, naSucho: true })).rejects.toThrow(/podaj --do/)
    const w = await importujArchiwumWoo(a, sklep([]), { konto: KONTO, od: OD, do: fromWarsaw('2026-01-01', 0), naSucho: true })
    expect(w.granica).toBe('parametr')
  })

  it('zły rekord trafia do ImportIssue, reszta zapisana; przerwany przebieg wznawia się od kursora bez dubli', async () => {
    await pokrycie(a)
    const lista = Array.from({ length: 5 }, (_, i) => woo(20 + i, new Date(Date.UTC(2025, 5, 1 + i, 10))))
    lista[1] = { ...lista[1]!, total: 'zepsute' }
    const s1 = sklep(lista)
    const w1 = await importujArchiwumWoo(a, s1, { konto: KONTO, od: OD, naSucho: false, naStrone: 2, maksStron: 2 })
    expect(w1).toMatchObject({ zapisane: 3, koniec: false, ostatniaStrona: 2 })
    expect(w1.bledy).toEqual([{ ref: '21', powod: expect.stringMatching(/^mapowanie: /) }])
    expect(await a.importRun.findFirstOrThrow({ where: { id: w1.runId! } })).toMatchObject({ status: 'PARTIAL' })
    expect(await a.importIssue.count({ where: { runId: w1.runId! } })).toBe(1)

    const s2 = sklep(lista)
    const w2 = await importujArchiwumWoo(a, s2, { konto: KONTO, od: OD, naSucho: false, naStrone: 2 })
    expect(w2).toMatchObject({ runId: w1.runId, wznowiony: true, odStrony: 2, koniec: true })
    // przegląd etapu 1 (W: wznowienie): strona 1 z otwartym problemem czytana ponownie, problem dalej otwarty
    expect(s2.wolan).toEqual([1, 2, 3])
    expect(w2).toMatchObject({ bledyOtwarte: 1, stronPonowionych: 1, poprzednio: { zapisane: 3 } })
    expect(await a.archivedOrder.count()).toBe(4)
    expect(await a.importRun.findFirstOrThrow({ where: { id: w1.runId! } })).toMatchObject({ status: 'PARTIAL' }) // błąd rekordu zostaje widoczny

    // awaria sklepu w trakcie: przebieg FAILED z kursorem, następny wznawia
    await truncateAll()
    for (const db of [a, b]) await seedBase(db)
    await pokrycie(a)
    const s3 = sklep(lista.filter((_, i) => i !== 1), { zepsujStrone: 2 })
    await expect(importujArchiwumWoo(a, s3, { konto: KONTO, od: OD, naSucho: false, naStrone: 2 })).rejects.toThrow(/import przerwany na stronie 2/)
    const run = await a.importRun.findFirstOrThrow({ where: { kind: 'archiwum-woo' } })
    expect(run).toMatchObject({ status: 'FAILED' })
    const w4 = await importujArchiwumWoo(a, s3, { konto: KONTO, od: OD, naSucho: false, naStrone: 2 })
    expect(w4).toMatchObject({ runId: run.id, wznowiony: true, koniec: true })
    expect(await a.archivedOrder.count()).toBe(4)
  })
})

describe('przegląd etapu 1: wznowienie i przeprowadzka', () => {
  it('wznowienie ponawia zamówienie z problemem z wcześniejszej części; po naprawie przebieg OK i bez otwartych błędów', async () => {
    await pokrycie(a)
    const lista = Array.from({ length: 5 }, (_, i) => woo(40 + i, new Date(Date.UTC(2025, 5, 1 + i, 10))))
    const zepsuta = [...lista]
    zepsuta[1] = { ...lista[1]!, total: 'zepsute' }
    const w1 = await importujArchiwumWoo(a, sklep(zepsuta), { konto: KONTO, od: OD, naSucho: false, naStrone: 2, maksStron: 2 })
    expect(w1).toMatchObject({ zapisane: 3, bledyOtwarte: 1, koniec: false })
    const s2 = sklep(lista) // sklep oddaje już poprawne zamówienie
    const w2 = await importujArchiwumWoo(a, s2, { konto: KONTO, od: OD, naSucho: false, naStrone: 2 })
    expect(s2.wolan).toEqual([1, 2, 3])
    expect(w2).toMatchObject({ wznowiony: true, koniec: true, bledyOtwarte: 0, bledy: [] })
    expect(await a.archivedOrder.count()).toBe(5)
    expect(await a.importRun.findFirstOrThrow({ where: { id: w1.runId! } })).toMatchObject({ status: 'OK' })
  })

  it('zamówienie z przeprowadzki (Order.externalId = numer sklepu, ta sama data) nie trafia do archiwum i liczy się raz; numer z inną datą nie wiąże', async () => {
    await pokrycie(a)
    const t = fromWarsaw('2025-11-03', 10 * 3600_000)
    // woo(id) ma numer 100000 + id; przeprowadzka zapisała zamówienie 51 pod numerem, z datą z poprzedniego systemu (+2 h)
    await a.order.create({ data: { ...ACC.WOO_SD, externalId: '100051', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '44.99', createdAtChannel: new Date(t.getTime() + 2 * 3600_000) } })
    // zamówienie z innym id, którego numer przypadkiem równa się numerowi zamówienia 52, ale z innego dnia: bez wiązania
    await a.order.create({ data: { ...ACC.WOO_SD, externalId: '100052', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '10.00', createdAtChannel: fromWarsaw('2025-11-20', 10 * 3600_000) } })
    const w = await importujArchiwumWoo(a, sklep([woo(51, t), woo(52, t)]), { konto: KONTO, od: OD, naSucho: false })
    expect(w).toMatchObject({ zapisane: 1, bledy: [] })
    expect(w.pominiete['jest w Kompletorze']).toBe(1)
    // podwójna osłona: wiersz archiwum dopisany mimo wszystko (np. przeprowadzka po imporcie) też liczy się raz
    await a.archivedOrder.create({ data: { source: 'WOO_API', channel: 'WOO', channelAccountId: KONTO, externalId: '51', channelNumber: '100051', status: 'WYSLANE', channelStatus: 'completed', createdAtChannel: t, paymentState: 'PAID', totalGross: '44.99', currency: 'PLN' } })
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-11-01', do: '2025-11-30', grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z')))
    expect(r.razem.zamowien).toBe(3) // 51 raz (z Order), 52 z archiwum, Order 100052 z 20.11
    expect(r.zArchiwum).toEqual({ zamowien: 1, brutto: 44.99, inneWaluty: [] })
  })

  it('zamówienie z przeprowadzki z numerem także w channelNumber (dopisanym przez odczyt kanału) wiąże się po numerze; ten sam numer miesiące wcześniej nie wiąże', async () => {
    await pokrycie(a)
    const t = fromWarsaw('2025-11-04', 10 * 3600_000)
    // przeprowadzka: externalId = numer sklepu; odczyt kanału dopisał ten sam numer w channelNumber
    await a.order.create({ data: { ...ACC.WOO_SD, externalId: '100061', channelNumber: '100061', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '44.99', createdAtChannel: new Date(t.getTime() + 3 * 3600_000) } })
    // inne zamówienie z tym samym numerem (numeracja po latach się powtórzyła), złożone w maju: bez wiązania
    await a.order.create({ data: { ...ACC.WOO_SD, externalId: '100062', channelNumber: '100062', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '10.00', createdAtChannel: fromWarsaw('2025-05-04', 10 * 3600_000) } })
    const w = await importujArchiwumWoo(a, sklep([woo(61, t), woo(62, t)]), { konto: KONTO, od: OD, naSucho: false })
    expect(w).toMatchObject({ zapisane: 1, bledy: [] })
    expect(w.pominiete['jest w Kompletorze']).toBe(1)
    expect((await a.archivedOrder.findMany({ select: { externalId: true } })).map((x) => x.externalId)).toEqual(['62'])
    // podwójna osłona w raporcie: wiersz archiwum 61 dopisany mimo wszystko liczy się raz (z Order)
    await a.archivedOrder.create({ data: { source: 'WOO_API', channel: 'WOO', channelAccountId: KONTO, externalId: '61', channelNumber: '100061', status: 'WYSLANE', channelStatus: 'completed', createdAtChannel: t, paymentState: 'PAID', totalGross: '44.99', currency: 'PLN' } })
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-11-01', do: '2025-11-30', grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z')))
    expect(r.razem.zamowien).toBe(2) // 61 raz (z Order), 62 z archiwum
    expect(r.zArchiwum).toEqual({ zamowien: 1, brutto: 44.99, inneWaluty: [] })
    const maj = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-05-01', do: '2025-05-31', grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z')))
    expect(maj.razem.zamowien).toBe(1) // majowy Order 100062 osobno
  })

  it('Empik: numer koszyka (commercial_id) wspólny dla dwóch zamówień nie skleja ich w raporcie', async () => {
    const t = fromWarsaw('2025-11-05', 10 * 3600_000)
    await a.order.create({ data: { ...ACC.EMPIK, externalId: '7001-A', channelNumber: '7001', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'karta', totalGross: '20.00', createdAtChannel: t } })
    await a.archivedOrder.create({ data: { source: 'MIRAKL_API', channel: 'EMPIK', channelAccountId: ACC.EMPIK.channelAccountId, externalId: '7001-B', channelNumber: '7001', status: 'WYSLANE', channelStatus: 'SHIPPED', createdAtChannel: t, paymentState: 'PAID', totalGross: '30.00', currency: 'PLN' } })
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-11-01', do: '2025-11-30', grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z')))
    expect(r.razem.zamowien).toBe(2)
    expect(r.zArchiwum).toEqual({ zamowien: 1, brutto: 30, inneWaluty: [] })
  })
})

describe('raport sprzedaży z archiwum', () => {
  async function zaimportuj(db: PrismaClient, lista: Record<string, unknown>[]) {
    await pokrycie(db)
    const w = await importujArchiwumWoo(db, sklep(lista), { konto: KONTO, od: OD, naSucho: false })
    expect(w.bledy).toEqual([])
    return w
  }
  const zapytanie = (od: string, doDnia: string) => zapytanieSprzedazy({ od, do: doDnia, grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z'))

  it('okres tylko z archiwum: liczba, wartość, anulowane, zwroty, produkty; filtr konta', async () => {
    const p = await product(a, 'TEST-H501', 0, { vatRate: '23' })
    await a.product.update({ where: { id: p }, data: { purchasePriceNet: '5.0000' } })
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: '501', productId: p, qtyBasePerOffer: 1 } })
    await zaimportuj(a, [
      woo(1, fromWarsaw('2025-11-03', 10 * 3600_000), { pozycje: [{ pid: 501, qty: 2, gr: 2460 }] }),
      woo(2, fromWarsaw('2025-11-15', 10 * 3600_000), { pozycje: [{ pid: 501, qty: 4, gr: 4920 }], zwrotGr: 1230 + 1499 }), // zwrot towaru 12,30 + wysyłki 14,99
      woo(3, fromWarsaw('2025-11-20', 10 * 3600_000), { status: 'cancelled' }),
      woo(4, fromWarsaw('2025-11-21', 10 * 3600_000), { status: 'processing', pozycje: [{ pid: 777, qty: 1, gr: 1000 }] }),
    ])
    const r = await raportSprzedazy(a, zapytanie('2025-11-01', '2025-11-30'))
    // zamówienia 1, 2, 4 (anulowane 3 osobno); wartość z dostawą 14,99 zł każde
    expect(r.razem).toMatchObject({ zamowien: 3, wartoscBrutto: 128.77, anulowanych: 1, anulowaneBrutto: 44.99, zwrotyBrutto: 12.3 })
    expect(r.razem.produktyBrutto).toBeCloseTo(24.6 + 49.2 + 10 - 12.3, 2)
    // 6 szt. − 1 zwrócona = 5 szt. towaru + 1 pozycja bez produktu
    expect(r.razem.sztuk).toBe(6)
    expect(r.razem.koszt).toBe(25)
    expect(r.zArchiwum).toEqual({ zamowien: 3, brutto: r.razem.wartoscBrutto, inneWaluty: [] })
    expect(r.produkty.find((x) => x.sku === 'TEST-H501')).toMatchObject({ ilosc: 5, brutto: 61.5, zamowien: 2 })
    expect(r.pozaKompletorem.zamowien).toBe(0)
    expect((await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-11-01', do: '2025-11-30', konto: 'WOO:lampy' }))).razem.zamowien).toBe(0)
    expect(r.konta.map((k) => [k.konto, k.zamowien])).toEqual([['WOO:sd', 3]])
  })

  it('okres mieszany i granica przełączenia: archiwum + Order, każde zamówienie raz; kopia kanału z archiwum nie jest „poza Kompletorem”', async () => {
    await zaimportuj(a, [woo(31, new Date('2026-11-18T09:00:00Z')), woo(32, new Date('2026-11-19T11:59:59Z'))])
    // po imporcie odczyt kanału przyjął zamówienie 32 do Kompletora (np. edycja w sklepie po przełączeniu): liczy się z Order
    await a.order.create({ data: { ...ACC.WOO_SD, externalId: '32', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '44.99', createdAtChannel: new Date('2026-11-19T11:59:59Z') } })
    await a.order.create({ data: { ...ACC.WOO_SD, externalId: '33', status: 'NOWE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '20.00', createdAtChannel: new Date('2026-11-20T10:00:00Z') } })
    // kopie kanału z cienia sprzed przełączenia: 31 ma wiersz archiwum (nie jest „poza”), 34 nie ma nigdzie (jest „poza”)
    const snap = { ...ACC.WOO_SD, revision: '1', channelStatus: 'completed', lifecycle: 'FULFILLED' as const, paymentState: 'PAID' as const, currency: 'PLN', lineCount: 1, warnings: [] }
    for (const [id, t] of [['31', '2026-11-18T09:00:00Z'], ['34', '2026-11-18T09:30:00Z']] as const)
      await a.channelOrderSnapshot.create({ data: { ...snap, externalId: id, totalGross: '44.99', createdAtChannel: new Date(t), firstSeenAt: new Date(t), lastSeenAt: new Date(t) } })
    const r = await raportSprzedazy(a, zapytanie('2026-11-01', '2026-11-30'))
    expect(r.razem.zamowien).toBe(3) // 31 z archiwum, 32 i 33 z Order
    expect(r.razem.wartoscBrutto).toBeCloseTo(44.99 + 44.99 + 20, 2)
    expect(r.zArchiwum).toEqual({ zamowien: 1, brutto: 44.99, inneWaluty: [] })
    expect(r.pozaKompletorem).toEqual({ zamowien: 1, brutto: 44.99, inneWaluty: [] })
    // pozycje: tylko 31 z archiwum (Order bez pozycji w tym teście); 32 z archiwum nie wchodzi drugi raz
    expect(r.razem.produktyBrutto).toBe(30)
  })

  it('archiwum w obcej walucie: ta sama reguła co zamówienia, bez kursu poza kwotami, z kursem NBP przeliczone', async () => {
    const t = fromWarsaw('2025-11-05', 10 * 3600_000)
    const arch = { source: 'ALLEGRO_API' as const, channel: 'ALLEGRO' as const, channelAccountId: ACC.ALLEGRO.channelAccountId, channelStatus: 'READY_FOR_PROCESSING', createdAtChannel: t, paymentState: 'PAID' as const, status: 'WYSLANE' as const }
    for (const [id, kwota, waluta, status] of [['pl-1', '100.00', 'PLN', 'WYSLANE'], ['pl-2', '50.00', 'PLN', 'WYSLANE'], ['cz-1', '500.00', 'CZK', 'WYSLANE'], ['cz-anul', '900.00', 'czk ', 'ANULOWANE']] as const) {
      const o = await a.archivedOrder.create({ data: { ...arch, externalId: id, totalGross: kwota, currency: waluta, status } })
      await a.archivedOrderLine.create({ data: { orderId: o.id, externalLineId: `${id}-1`, name: 'Pozycja', qty: 1, lineGross: kwota } })
    }
    const snap = { ...ACC.WOO_SD, revision: '1', channelStatus: 'completed', lifecycle: 'FULFILLED' as const, paymentState: 'PAID' as const, lineCount: 1, warnings: [], createdAtChannel: t, firstSeenAt: t, lastSeenAt: t }
    await a.channelOrderSnapshot.create({ data: { ...snap, externalId: 'poza-pl', totalGross: '20.00', currency: 'PLN' } })
    await a.channelOrderSnapshot.create({ data: { ...snap, externalId: 'poza-cz', totalGross: '250.00', currency: 'czk' } })

    // bez kursu: CZK liczy się w liczbie zamówień, ale nie w kwotach (nigdy 1:1), osobno w inneWaluty z bruttoPln null
    const bez = await raportSprzedazy(a, zapytanie('2025-11-01', '2025-11-30'))
    expect(bez.razem).toMatchObject({ zamowien: 3, wartoscBrutto: 150, produktyBrutto: 150, anulowanych: 1, anulowaneBrutto: 0 })
    expect(bez.razem.inneWaluty).toEqual([{ waluta: 'CZK', zamowien: 1, brutto: 500, kurs: null, dataKursu: null, bruttoPln: null }])
    expect(bez.zArchiwum).toMatchObject({ zamowien: 3, brutto: 150 })
    expect(bez.zArchiwum.inneWaluty).toEqual([{ waluta: 'CZK', zamowien: 1, brutto: 500, kurs: null, dataKursu: null, bruttoPln: null }])
    expect(bez.pozaKompletorem).toMatchObject({ zamowien: 2, brutto: 20 })
    expect(bez).not.toHaveProperty('wInnejWalucie')

    // z kursem z workera (atrapa NBP, bez sieci): CZK 0,1712 → 500 CZK = 85,60 zł w sumach, pozycjach i archiwum
    await odswiezKursy(a, { fetch: atrapaNbp('2025-11-28', { CZK: 0.1712 }), now: new Date('2025-11-28T12:30:00Z') })
    const r = await raportSprzedazy(a, zapytanie('2025-11-01', '2025-11-30'))
    expect(r.razem).toMatchObject({ zamowien: 3, wartoscBrutto: 235.6, produktyBrutto: 235.6, anulowanych: 1, anulowaneBrutto: 154.08 })
    expect(r.razem.inneWaluty).toEqual([{ waluta: 'CZK', zamowien: 1, brutto: 500, kurs: 0.1712, dataKursu: '2025-11-28', bruttoPln: 85.6 }])
    expect(r.zArchiwum).toMatchObject({ zamowien: 3, brutto: 235.6 })
    expect(r.konta.map((k) => [k.konto, k.zamowien, k.wartoscBrutto])).toEqual([[`ALLEGRO:${ACC.ALLEGRO.channelAccountId}`, 3, 235.6]])
    expect(Math.round(r.produkty.reduce((s, p) => s + p.brutto, 0) * 100) / 100).toBe(235.6)
    // „poza Kompletorem” ta sama reguła: 20 zł + 250 CZK × 0,1712 = 62,80 zł
    expect(r.pozaKompletorem).toMatchObject({ zamowien: 2, brutto: 62.8 })
    // filtr konta: konto sklepu ma tylko kopie „poza”, archiwum Allegro poza filtrem
    const tylkoWoo = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-11-01', do: '2025-11-30', grupuj: 'miesiac', konto: `WOO:${KONTO}` }, new Date('2026-11-22T12:00:00Z')))
    expect(tylkoWoo.razem.zamowien).toBe(0)
    expect(tylkoWoo.zArchiwum).toEqual({ zamowien: 0, brutto: 0, inneWaluty: [] })
    expect(tylkoWoo.pozaKompletorem).toMatchObject({ zamowien: 2, brutto: 62.8 })
  })

  it('izolacja firm: archiwum firmy B niewidoczne w raporcie i bazie firmy A (RLS)', async () => {
    await zaimportuj(b, [woo(41, new Date('2025-11-05T10:00:00Z'))])
    expect(await b.archivedOrder.count()).toBe(1)
    expect(await a.archivedOrder.count()).toBe(0)
    expect(await a.archivedOrderLine.count()).toBe(0)
    expect((await raportSprzedazy(a, zapytanie('2025-11-01', '2025-11-30'))).razem.zamowien).toBe(0)
    expect((await raportSprzedazy(b, zapytanie('2025-11-01', '2025-11-30'))).razem.zamowien).toBe(1)
    // zapis z firmy A do wiersza B niemożliwy (polityka WITH CHECK)
    const wB = await sys.archivedOrder.findFirstOrThrow()
    await expect(a.archivedOrderLine.create({ data: { orderId: wB.id, externalLineId: 'x', name: 'x', qty: 1, lineGross: 1, organizationId: ORG_B } })).rejects.toThrow()
  })

  it('bieżące liczniki pulpitu nie widzą archiwum', async () => {
    const dzis = new Date('2026-11-18T12:00:00Z')
    const przed = await dashboard(a, dzis)
    await zaimportuj(a, [woo(51, new Date('2026-11-18T09:00:00Z')), woo(52, new Date('2026-11-18T10:00:00Z'))])
    const po = await dashboard(a, dzis)
    expect(po.today.count).toBe(przed.today.count)
    expect(po.today.gross).toBe(przed.today.gross)
  })
})
