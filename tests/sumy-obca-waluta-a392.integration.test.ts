// sumy sprzedaży z zamówień w obcych walutach przeliczone na złote po kursie średnim NBP (informacyjnie).
// Pulpit („Dziś”, wykres miesiąca), API dnia i raport sprzedaży liczą kwotę w złotych = PLN + obce waluty × ostatni kurs
// zapisany przez worker (`kursy-walut`, lib/kursy/nbp.ts, atrapa NBP bez sieci). Waluta bez kursu nie wchodzi do sumy
// (osobno, nigdy 1:1). Paczka dodatkowa („dośle później”) dziedziczy walutę zamówienia głównego. Bez obcych walut wynik
// jak przed zmianą. Dane fikcyjne (SKU TEST-*), zero połączeń zewnętrznych.
import type { Order, Prisma } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { raportSprzedazy, rozbicieWalut, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { dayReport } from '@/lib/api/raporty'
import { organizationIdOf } from '@/lib/db'
import { czytajKursy, KLUCZ_USTAWIEN, odswiezKursy } from '@/lib/kursy/nbp'
import { dashboard } from '@/lib/panel/dane'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { testDb, truncateAll } from './db'
import { ACC, product, seedBase, type TestChannel } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const DZIEN = '2026-11-10'
const NOW = new Date('2026-11-10T15:00:00Z')
const godz = (h: number) => fromWarsaw(DZIEN, h * 3600_000)

let sku: string
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  sku = await product(db, 'TEST-TOWAR-A392', 100)
})

/** Atrapa odpowiedzi NBP `tables/a/`. */
const atrapa = (effectiveDate: string, kursy: Record<string, number>) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify([{ table: 'A', no: `TEST/A/NBP/${effectiveDate}`, effectiveDate, rates: Object.entries(kursy).map(([code, mid]) => ({ currency: 'waluta', code, mid })) }]),
})
const bladNbp = async () => ({ ok: false, status: 503, text: async () => '' })

/** Kursy jak po przebiegu zadania workera (CZK 0,1712 z 21.11). */
async function kursy(): Promise<void> {
  await odswiezKursy(db, { fetch: atrapa('2026-11-21', { CZK: 0.1712, EUR: 4.2311 }), now: new Date('2026-11-21T12:30:00Z') })
}

/** Kopia zamówienia z kanału z walutą (jak po odczycie kanału); bez `orderId` = zamówienie spoza Kompletora. */
async function kopia(konto: TestChannel, externalId: string, currency: string, totalGross: number, orderId: string | null): Promise<void> {
  await db.channelOrderSnapshot.create({
    data: {
      ...ACC[konto],
      externalId,
      revision: '1',
      channelStatus: 'READY_FOR_PROCESSING',
      lifecycle: 'OPEN',
      paymentState: 'PAID',
      totalGross,
      currency,
      lineCount: 1,
      warnings: [],
      createdAtChannel: godz(10),
      firstSeenAt: godz(10),
      lastSeenAt: godz(10),
      orderId,
    },
  })
}

/** Zamówienie z jedną pozycją za całą kwotę (bez dostawy), opcjonalnie z kopią kanału w walucie. */
async function zam(id: string, konto: TestChannel, externalId: string, kwota: number, waluta: string | null, over: Partial<Pick<Order, 'parentOrderId' | 'packageNo'>> = {}): Promise<void> {
  await db.order.create({ data: { id, ...ACC[konto], externalId, paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: kwota.toFixed(2), createdAtChannel: godz(9), ...over } })
  await db.orderLine.create({ data: { orderId: id, externalLineId: 'L1', productId: sku, qty: 1, unitPriceGross: kwota.toFixed(2), vatRate: '23' } })
  if (waluta) await kopia(konto, externalId, waluta, kwota, id)
}

/** Jak na zrzucie zgłoszenia: Allegro 3 zamówienia, w tym jedno w CZK; do tego sklep w PLN. */
async function mieszane(): Promise<void> {
  await zam('a1', 'ALLEGRO', 'TEST-A1', 100, 'PLN')
  await zam('a2', 'ALLEGRO', 'TEST-A2', 75.35, null) // bez kopii kanału = PLN
  await zam('a3', 'ALLEGRO', 'TEST-A3', 957, 'CZK')
  // paczka dodatkowa zamówienia w CZK: bez własnej kopii, waluta po numerze zamówienia głównego
  await zam('a3p', 'ALLEGRO', 'TEST-A3#dosle-1', 50, null, { parentOrderId: 'a3', packageNo: 2 })
  await zam('w1', 'WOO_SD', 'TEST-W1', 50, null)
  // kopia z kanału bez zamówienia w Kompletorze (nieprzyjęta) w CZK
  await kopia('ALLEGRO', 'TEST-S1', 'czk', 200, null)
}

const CZK = { waluta: 'CZK', kurs: 0.1712, dataKursu: '2026-11-21' }

describe('kursy NBP w ustawieniach firmy (zadanie kursy-walut)', () => {
  it('zapis bez ruszania reszty ustawień; starsza tabela (weekend) nie nadpisuje nowszej; błąd zostawia kursy i zapisuje ostatniBlad', async () => {
    const id = organizationIdOf(db)
    await db.organization.update({ where: { id }, data: { settings: { innyKlucz: { a: 1 } } as Prisma.InputJsonValue } })
    expect(await czytajKursy(db)).toBeNull()
    // pierwszy przebieg bez połączenia: nic do zapisania, wyjątek do Job.lastError
    await expect(odswiezKursy(db, { fetch: bladNbp })).rejects.toThrow('NBP: HTTP 503')
    expect(await czytajKursy(db)).toBeNull()

    await kursy()
    expect(await czytajKursy(db)).toEqual({ tabela: 'TEST/A/NBP/2026-11-21', data: '2026-11-21', kursy: { CZK: 0.1712, EUR: 4.2311 } })
    const s1 = (await db.organization.findUniqueOrThrow({ where: { id } })).settings as Record<string, unknown>
    expect(s1['innyKlucz']).toEqual({ a: 1 })

    await odswiezKursy(db, { fetch: atrapa('2026-11-20', { CZK: 0.1 }) })
    expect((await czytajKursy(db))!.kursy.CZK).toBe(0.1712)

    await expect(odswiezKursy(db, { fetch: bladNbp, now: new Date('2026-11-22T08:00:00Z') })).rejects.toThrow()
    expect((await czytajKursy(db))!.kursy.CZK).toBe(0.1712)
    const s2 = (await db.organization.findUniqueOrThrow({ where: { id } })).settings as Record<string, Record<string, unknown>>
    expect(s2[KLUCZ_USTAWIEN]!['ostatniBlad']).toEqual({ at: '2026-11-22T08:00:00.000Z', komunikat: 'NBP: HTTP 503' })

    // nowsza tabela: nowy kurs, ślad błędu znika
    await odswiezKursy(db, { fetch: atrapa('2026-11-23', { CZK: 0.1715 }) })
    expect(await czytajKursy(db)).toMatchObject({ data: '2026-11-23', kursy: { CZK: 0.1715 } })
    const s3 = (await db.organization.findUniqueOrThrow({ where: { id } })).settings as Record<string, Record<string, unknown>>
    expect(s3[KLUCZ_USTAWIEN]!['ostatniBlad']).toBeUndefined()
  })
})

describe('pulpit: suma w złotych z przeliczeniem', () => {
  it('same PLN (z kursami w ustawieniach): liczby i kwoty jak dotąd, bez obcych walut', async () => {
    await kursy()
    await zam('a1', 'ALLEGRO', 'TEST-A1', 100, 'PLN')
    await zam('a2', 'ALLEGRO', 'TEST-A2', 75.35, null)
    const d = await dashboard(db, NOW, { shadowEnabled: false })
    expect(d.today).toMatchObject({ count: 2, gross: 175.35, foreign: [] })
    expect(d.today.perAccount.find((x) => x.key === 'ALLEGRO:allegro')).toMatchObject({ count: 2, gross: 175.35, foreign: [] })
    expect(d.monthTotals).toMatchObject({ count: 2, gross: 175.35, foreign: [] })
    expect(d.month.every((x) => x.foreign.length === 0)).toBe(true)
  })

  it('mieszane waluty z kursem: jedna kwota w złotych (CZK × 0,1712), rozbicie z kursem; także kopia spoza Kompletora', async () => {
    await kursy()
    await mieszane()
    const d = await dashboard(db, NOW, { shadowEnabled: false })
    const czk = { ...CZK, grosze: 115700, zamowien: 2, groszePln: 19808 } // 1157 CZK × 0,1712 = 198,0784
    expect(d.today.count).toBe(5) // a1, a2, a3, w1 + kopia S1; paczka dodatkowa nie liczy się drugi raz
    expect(d.today.gross).toBe(423.43) // 225,35 + 198,08
    expect(d.today.foreign).toEqual([czk])
    const allegro = d.today.perAccount.find((x) => x.key === 'ALLEGRO:allegro')!
    expect(allegro).toMatchObject({ count: 4, gross: 373.43, foreign: [czk] })
    expect(d.today.perAccount.find((x) => x.key === 'WOO:sd')).toMatchObject({ count: 1, gross: 50, foreign: [] })
    expect(d.monthTotals).toMatchObject({ count: 5, gross: 423.43 })
    expect(d.month.find((x) => x.day === 10)).toMatchObject({ gross: 423.43, foreign: [czk] })

    const r = await dayReport(db, NOW)
    expect(r.sprzedaz).toMatchObject({ zamowien: 5, brutto: 423.43, inneWaluty: [{ ...CZK, zamowien: 2, brutto: 1157, bruttoPln: 198.08 }] })
    expect(r.sprzedaz.konta.find((k) => k.konto === 'WOO:sd')!.inneWaluty).toEqual([])
  })

  it('brak kursu (worker jeszcze nie pobrał): CZK poza sumą, osobno, nigdy 1:1', async () => {
    await mieszane()
    const d = await dashboard(db, NOW, { shadowEnabled: false })
    expect(d.today.count).toBe(5)
    expect(d.today.gross).toBe(225.35)
    expect(d.today.foreign).toEqual([{ waluta: 'CZK', grosze: 115700, zamowien: 2, kurs: null, dataKursu: null, groszePln: null }])
    const r = await dayReport(db, NOW)
    expect(r.sprzedaz).toMatchObject({ brutto: 225.35, inneWaluty: [{ waluta: 'CZK', zamowien: 2, brutto: 1157, kurs: null, dataKursu: null, bruttoPln: null }] })
  })
})

describe('raport sprzedaży: kwoty z przeliczeniem, marża tym samym kursem', () => {
  it('same PLN (z kursami w ustawieniach): bez inneWaluty i bez tabeli walut', async () => {
    await kursy()
    await zam('a1', 'ALLEGRO', 'TEST-A1', 100, 'PLN')
    const r = await raportSprzedazy(db, zapytanieSprzedazy({ od: DZIEN, do: DZIEN }, NOW), NOW)
    expect(r.razem).toMatchObject({ zamowien: 1, wartoscBrutto: 100, sredniaWartosc: 100, produktyBrutto: 100, inneWaluty: [] })
    expect(r.pozaKompletorem).toEqual({ zamowien: 0, brutto: 0, inneWaluty: [] })
    expect(rozbicieWalut(r.razem)).toEqual([])
  })

  it('mieszane waluty z kursem: wartość, średnia, produkty i marża w złotych z CZK × kurs; rozbicie na waluty', async () => {
    await kursy()
    await mieszane()
    await db.product.update({ where: { id: sku }, data: { purchasePriceNet: '10.00' } })
    const r = await raportSprzedazy(db, zapytanieSprzedazy({ od: DZIEN, do: DZIEN }, NOW), NOW)
    // zamówienia: a1 100 + a2 75,35 + w1 50 (PLN) + a3 957 CZK = 163,84 zł
    expect(r.razem).toMatchObject({ zamowien: 4, wartoscBrutto: 389.19, sredniaWartosc: 97.3, inneWaluty: [{ ...CZK, zamowien: 1, brutto: 957, bruttoPln: 163.84 }] })
    // pozycje: PLN 225,35 + CZK (957 + paczka 50) × 0,1712 = 172,3984; netto ze stawki 23%; koszt 5 szt. × 10 zł
    expect(r.razem.produktyBrutto).toBe(397.75)
    expect(r.razem.produktyNetto).toBe(323.37)
    expect(r.razem.sztuk).toBe(5)
    expect(r.razem.koszt).toBe(50)
    expect(r.razem.marza).toBe(273.37)
    const allegro = r.konta.find((k) => k.konto === 'ALLEGRO:allegro')!
    expect(allegro).toMatchObject({ zamowien: 3, wartoscBrutto: 339.19, inneWaluty: [{ ...CZK, zamowien: 1, brutto: 957, bruttoPln: 163.84 }] })
    expect(r.konta.find((k) => k.konto === 'WOO:sd')).toMatchObject({ zamowien: 1, wartoscBrutto: 50, inneWaluty: [] })
    expect(r.okresy).toHaveLength(1)
    expect(r.okresy[0]).toMatchObject({ zamowien: 4, wartoscBrutto: 389.19 })
    expect(r.pozaKompletorem).toEqual({ zamowien: 1, brutto: 34.24, inneWaluty: [{ ...CZK, zamowien: 1, brutto: 200, bruttoPln: 34.24 }] })
    expect(r.produkty[0]).toMatchObject({ brutto: 397.75, ilosc: 5, brakCenyZakupu: false })
    expect(rozbicieWalut(r.razem)).toEqual([
      { waluta: 'PLN', zamowien: 3, brutto: 225.35, kurs: null, dataKursu: null, bruttoPln: 225.35, udzial: 57.9 },
      { waluta: 'CZK', zamowien: 1, brutto: 957, kurs: 0.1712, dataKursu: '2026-11-21', bruttoPln: 163.84, udzial: 42.1 },
    ])
  })

  it('brak kursu: kwoty tylko z PLN, sztuki z każdej waluty, CZK osobno bez kursu', async () => {
    await mieszane()
    await db.product.update({ where: { id: sku }, data: { purchasePriceNet: '10.00' } })
    const r = await raportSprzedazy(db, zapytanieSprzedazy({ od: DZIEN, do: DZIEN }, NOW), NOW)
    expect(r.razem).toMatchObject({ zamowien: 4, wartoscBrutto: 225.35, sredniaWartosc: 75.12, inneWaluty: [{ waluta: 'CZK', zamowien: 1, brutto: 957, kurs: null, bruttoPln: null }] })
    expect(r.razem.produktyBrutto).toBe(225.35)
    expect(r.razem.sztuk).toBe(5)
    expect(r.razem.koszt).toBe(30)
    expect(r.pozaKompletorem).toMatchObject({ zamowien: 1, brutto: 0 })
    expect(rozbicieWalut(r.razem)[1]).toMatchObject({ waluta: 'CZK', bruttoPln: null, udzial: null })
  })
})
