// wybór okresu porównania w raporcie sprzedaży, na danych fikcyjnych bez sieci.
//  - rok wcześniej: zamówienia Kompletora i archiwum (także anulowane i w obcej walucie) liczą się tak samo jak w okresie
//    bieżącym; okresy, konta i produkty mają pole porównania;
//  - porównanie sprzed początku danych konta jest oznaczone (konto bez danych, cały okres przed danymi), zamiast
//    pokazywać fałszywy wzrost; filtr konta zawęża tę ocenę do konta;
//  - poprzedni okres (domyślnie), własny zakres, bez porównania; tryb niepasujący do zakresu = błąd z polem;
//  - API v1 przyjmuje te same parametry (biała lista), XLSX ma kolumny porównania z datami w nagłówku.
import { writeFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ApiInputError } from '@/lib/api/odpowiedzi'
import { OKNO_PIERWSZEGO_ODCZYTU_MS, parseZapytanieSprzedazy, porownanieSprzedazy, raportSprzedazy, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { DEFAULT_LOOKBACK_MS } from '@/lib/cien/odczyt-zamowien'
import { arkuszeRaportuSprzedazy } from '@/lib/arkusz/raport-sprzedazy'
import { zapiszXlsx } from '@/lib/arkusz/xlsx'
import { odczytajXlsx } from '@/lib/arkusz/xlsx-odczyt'
import { odswiezKursy } from '@/lib/kursy/nbp'
import { createApiKey } from '@/lib/api/zarzadzanie'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { ACC, product, seedBase, type TestChannel } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()
const { resetApiLimiters } = await import('@/lib/api/klucze')
const trasa = await import('@/app/api/v1/raporty/sprzedaz/route')

testSystemDb()
const a = testDb()
afterAll(async () => {
  await a.$disconnect()
})

const NOW = new Date('2026-11-25T09:00:00Z')
let sku: string
beforeEach(async () => {
  await truncateAll(a)
  await seedBase(a)
  resetApiLimiters()
  sku = await product(a, 'TEST-POROWNANIE', 1000)
  await a.product.update({ where: { id: sku }, data: { purchasePriceNet: '10.0000' } })
  // kurs jak po przebiegu workera (CZK 0,1712), atrapa NBP bez sieci
  const atrapa = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ table: 'A', no: 'TEST/A/NBP/2026-11-21', effectiveDate: '2026-11-21', rates: [{ currency: 'waluta', code: 'CZK', mid: 0.1712 }] }]) })
  await odswiezKursy(a, { fetch: atrapa, now: new Date('2026-11-21T12:30:00Z') })
})

async function zam(konto: TestChannel, id: string, dzien: string, brutto: string, status: 'WYSLANE' | 'ANULOWANE' = 'WYSLANE'): Promise<void> {
  await a.order.create({ data: { id, ...ACC[konto], externalId: `T-${id}`, status, paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: brutto, createdAtChannel: fromWarsaw(dzien, 12 * 3600_000) } })
  await a.orderLine.create({ data: { orderId: id, externalLineId: 'L0', productId: sku, qty: 1, unitPriceGross: brutto, vatRate: '23' } })
}
async function arch(konto: TestChannel, id: string, dzien: string, brutto: string, opts: { status?: 'WYSLANE' | 'ANULOWANE'; waluta?: string; run?: string } = {}): Promise<void> {
  const o = await a.archivedOrder.create({ data: { source: 'TEST', ...ACC[konto], externalId: `A-${id}`, channelStatus: 'x', status: opts.status ?? 'WYSLANE', createdAtChannel: fromWarsaw(dzien, 12 * 3600_000), paymentState: 'PAID', totalGross: brutto, currency: opts.waluta ?? 'PLN', trackingNumbers: [], invoiceNumbers: [], importRunId: opts.run ?? null } })
  await a.archivedOrderLine.create({ data: { orderId: o.id, externalLineId: 'L0', name: 'Pozycja testowa', productId: sku, qty: 1, lineGross: brutto, vatRate: '23' } })
}

/**
 * Listopad 2025 (porównanie): sklep 100 zł + 50 zł anulowane (Kompletor), Allegro z archiwum 80 zł + 30 zł anulowane +
 * 584,11 CZK (= 100,00 zł po kursie). Listopad 2026: sklep 200 zł, Allegro 120 zł, Empik 60 zł.
 * Początki danych: sklep czytany przez Kompletora od 01.10.2025 (pierwszy udany odczyt = ChannelCursor.coverageFrom
 * + okno 24 h), Allegro z importu archiwum
 * od 01.11.2025 (ImportRun.stats.od), Empik bez takich granic, więc od pierwszego zamówienia 07.11.2026.
 */
async function dane(): Promise<void> {
  await a.channelCursor.create({ data: { ...ACC.WOO_SD, adapterKey: 'woo.rest.v1', coverageFrom: new Date(fromWarsaw('2025-10-01', 0).getTime() - OKNO_PIERWSZEGO_ODCZYTU_MS) } })
  const run = (await a.importRun.create({ data: { kind: 'archiwum-allegro', status: 'OK', stats: { konto: ACC.ALLEGRO.channelAccountId, od: fromWarsaw('2025-11-01', 0).toISOString(), do: '2026-11-19T00:00:00.000Z' } } })).id
  await zam('WOO_SD', 'w25a', '2025-11-03', '100.00')
  await zam('WOO_SD', 'w25b', '2025-11-04', '50.00', 'ANULOWANE')
  await arch('ALLEGRO', 'al25a', '2025-11-10', '80.00', { run })
  await arch('ALLEGRO', 'al25b', '2025-11-11', '30.00', { status: 'ANULOWANE', run })
  await arch('ALLEGRO', 'al25c', '2025-11-12', '584.11', { waluta: 'CZK', run })
  await zam('WOO_SD', 'w26a', '2026-11-03', '200.00')
  await zam('ALLEGRO', 'al26a', '2026-11-06', '120.00')
  await zam('EMPIK', 'em26a', '2026-11-07', '60.00')
}

/** Arkusz z pliku jako wiersze wartości (pusta komórka = null). */
function arkusz(plik: Buffer, nazwa: string): unknown[][] {
  return odczytajXlsx(plik).get(nazwa)!.map((w) => [...w].map((c) => c?.wartosc ?? null))
}

const q = (v: Parameters<typeof zapytanieSprzedazy>[0]) => zapytanieSprzedazy({ od: '2026-11-01', do: '2026-11-25', grupuj: 'dzien', ...v }, NOW)

describe('porównanie raportu sprzedaży', () => {
  it('rok wcześniej: archiwum, anulowane i obca waluta jak w okresie bieżącym; okresy, konta, produkty; konto bez danych oznaczone', async () => {
    await dane()
    const r = await raportSprzedazy(a, q({ porownaj: 'rok' }), NOW)
    expect(r.razem).toMatchObject({ zamowien: 3, wartoscBrutto: 380 })
    const P = r.poprzedni!
    expect(P).toMatchObject({ od: '2025-11-01', do: '2025-11-25', tryb: 'rok', dni: 25, bezDanych: false, poczatekDanych: '2025-10-01' })
    expect(P.razem.zamowien).toBe(3)
    expect(P.razem.wartoscBrutto).toBeCloseTo(280, 1) // 100 + 80 + 584,11 CZK × 0,1712
    expect(P.razem.inneWaluty.map((w) => w.waluta)).toEqual(['CZK'])
    expect(P.razem).toMatchObject({ anulowanych: 2, anulowaneBrutto: 80 })
    // sklep i Allegro mają dane od początku porównania (granice odczytu i importu, nie pierwsze zamówienie 03.11 i 10.11);
    // Empik dopiero od 07.11.2026: porównanie niepełne, nazwane z kontem
    expect(P.kontaBezDanych).toEqual([{ konto: 'EMPIK:empik', nazwa: expect.any(String), daneOd: '2026-11-07' }])
    // okresy: dzień do tego samego dnia rok wcześniej
    const d3 = r.okresy.find((o) => o.okres === '2026-11-03')!
    expect(d3.porownanie).toMatchObject({ od: '2025-11-03', do: '2025-11-03', wartoscBrutto: 100, daneNiepelne: true }) // Empik dalej bez danych
    expect(r.okresy.find((o) => o.okres === '2026-11-12')!.porownanie!.wartoscBrutto).toBeCloseTo(100, 1)
    // konta: wartość z porównania i ocena danych per konto
    const woo = r.konta.find((k) => k.konto === 'WOO:sd')!
    expect(woo.porownanie).toMatchObject({ zamowien: 1, wartoscBrutto: 100, daneOd: '2025-10-01', daneNiepelne: false })
    expect(r.konta.find((k) => k.konto === 'ALLEGRO:allegro')!.porownanie).toMatchObject({ daneOd: '2025-11-01', daneNiepelne: false })
    expect(r.konta.find((k) => k.konto === 'EMPIK:empik')!.porownanie).toMatchObject({ zamowien: 0, daneNiepelne: true, daneOd: '2026-11-07' })
    // produkty: sztuki i netto okresu porównania
    expect(r.produkty[0]!.porownanie).toMatchObject({ ilosc: 3, zamowien: 3 })
    // filtr konta: porównanie pełne, bez kont spoza filtra
    const sd = await raportSprzedazy(a, q({ porownaj: 'rok', konto: 'WOO:sd' }), NOW)
    expect(sd.poprzedni).toMatchObject({ kontaBezDanych: [], bezDanych: false, razem: { zamowien: 1, wartoscBrutto: 100 } })
    expect(sd.okresy.find((o) => o.okres === '2026-11-03')!.porownanie!.daneNiepelne).toBe(false)

    // XLSX: kolumny porównania z datami w nagłówku; przy niepełnym porównaniu bez zmiany %, z uwagą
    const pods = arkusz(zapiszXlsx(arkuszeRaportuSprzedazy(r, 'wszystkie kanały')), 'Podsumowanie')
    expect(pods[0]).toEqual(['Miara', '2026-11-01 – 2026-11-25', 'Porównanie 2025-11-01 – 2025-11-25 (ten sam okres rok wcześniej)', 'Zmiana %'])
    expect(pods[1]).toEqual(['Zamówienia', 3, 3]) // zmiana % pusta: porównanie niepełne (pusta komórka na końcu wiersza)
    expect(pods.find((w) => w[0] === 'Uwaga do porównania')![1]).toMatch(/Porównanie niepełne: Kompletor ma dane konta .* od 7\.11\.2026/)
    const plikSd = zapiszXlsx(arkuszeRaportuSprzedazy(sd, 'Sklep'))
    expect(arkusz(plikSd, 'Podsumowanie')[2]).toEqual(['Wartość zamówień brutto (z dostawą)', 200, 100, 1]) // +100% (procent Excela)
    const okr = arkusz(plikSd, 'Okresy')
    expect(okr[0]).toEqual(expect.arrayContaining(['Porównanie od', 'Porównanie do', 'Porównanie: wartość zamówień brutto']))
    // przykładowy plik do dowodu zamknięcia (tylko na żądanie)
    if (process.env.A285_XLSX) writeFileSync(process.env.A285_XLSX, zapiszXlsx(arkuszeRaportuSprzedazy(r, 'wszystkie kanały')))
  })

  it('poprzedni okres (domyślnie), okres w całości przed danymi, własny zakres, bez porównania', async () => {
    await dane()
    const dom = await raportSprzedazy(a, q({}), NOW)
    expect(dom.poprzedni).toMatchObject({ od: '2026-10-07', do: '2026-10-31', tryb: 'poprzedni', razem: { zamowien: 0 }, bezDanych: false })
    expect(dom.poprzedni!.kontaBezDanych.map((k) => k.konto)).toEqual(['EMPIK:empik'])

    const przed = await raportSprzedazy(a, q({ porownaj: 'wlasny', porownajOd: '2024-11-01', porownajDo: '2024-11-30' }), NOW)
    expect(przed.poprzedni).toMatchObject({ od: '2024-11-01', do: '2024-11-30', dni: 30, tryb: 'wlasny', bezDanych: true, poczatekDanych: '2025-10-01' })

    const wl = await raportSprzedazy(a, q({ porownaj: 'wlasny', porownajOd: '2025-11-10', porownajDo: '2025-11-12', konto: 'ALLEGRO:allegro' }), NOW)
    expect(wl.poprzedni).toMatchObject({ dni: 3, bezDanych: false, kontaBezDanych: [], razem: { zamowien: 2, anulowanych: 1 } })

    const bez = await raportSprzedazy(a, q({ porownaj: 'brak' }), NOW)
    expect(bez.poprzedni).toBeNull()
    expect(bez.okresy.every((o) => o.porownanie === null) && bez.konta.every((k) => k.porownanie === null) && bez.produkty.every((p) => p.porownanie === null)).toBe(true)
    expect(arkusz(zapiszXlsx(arkuszeRaportuSprzedazy(bez, 'wszystkie kanały')), 'Podsumowanie')[0]).toEqual(['Miara', '2026-11-01 – 2026-11-25'])

    // miesiąc wcześniej tylko dla zakresu w jednym miesiącu: błąd z polem
    expect(() => zapytanieSprzedazy({ od: '2026-10-15', do: '2026-11-14', porownaj: 'miesiac' }, NOW)).toThrow(ApiInputError)
    const mies = await raportSprzedazy(a, q({ porownaj: 'miesiac' }), NOW)
    expect(mies.poprzedni).toMatchObject({ od: '2026-10-01', do: '2026-10-25' })
  })

  it('początek danych: granice odczytu i importu wygrywają z pojedynczym starym zamówieniem; pierwszy pełny dzień odczytu; zła data importu', async () => {
    await dane()
    // przegląd r1: stare zamówienie sprzed odczytu (np. przeniesione przeprowadzką) i wiersz archiwum bez przebiegu
    // nie przesuwają początku danych kont, które mają granicę
    await zam('WOO_SD', 'wstary', '2024-06-03', '10.00')
    await arch('ALLEGRO', 'alstary', '2024-05-06', '5.00')
    const wl = (v: Partial<Parameters<typeof zapytanieSprzedazy>[0]> = {}) => q({ porownaj: 'wlasny', porownajOd: '2025-10-01', porownajDo: '2025-10-31', ...v })
    const r = await raportSprzedazy(a, wl(), NOW)
    expect(r.konta.find((k) => k.konto === 'WOO:sd')!.porownanie).toMatchObject({ daneOd: '2025-10-01', daneNiepelne: false })
    expect(r.konta.find((k) => k.konto === 'ALLEGRO:allegro')!.porownanie).toMatchObject({ daneOd: '2025-11-01', daneNiepelne: true })
    expect(r.poprzedni!.poczatekDanych).toBe('2025-10-01')
    // konto bez granic: dalej od pierwszego zamówienia (Kompletor albo archiwum)
    expect(r.konta.find((k) => k.konto === 'EMPIK:empik')!.porownanie!.daneOd).toBe('2026-11-07')

    // przegląd r1: odczyt zaczyna się oknem wstecz (coverageFrom = pierwszy udany odczyt − 24 h), zamówienia
    // zrealizowane w oknie zostają kopią kanału; granicą jest pierwszy pełny dzień po pierwszym odczycie (8.11, nie 6.11)
    expect(OKNO_PIERWSZEGO_ODCZYTU_MS).toBe(DEFAULT_LOOKBACK_MS)
    await a.channelCursor.create({ data: { ...ACC.EMPIK, adapterKey: 'mirakl.v1', coverageFrom: fromWarsaw('2026-11-06', 14 * 3600_000), firstPollAt: fromWarsaw('2026-11-07', 14 * 3600_000) } })
    // przegląd r1: nieistniejąca data w zakresie importu (30.02) nie wywraca raportu, przebieg nie jest granicą
    const zly = (await a.importRun.create({ data: { kind: 'archiwum-empik', status: 'OK', stats: { konto: 'empik', od: '2025-02-30T00:00:00.000Z', do: '2026-11-06T00:00:00.000Z' } } })).id
    await arch('EMPIK', 'emzly', '2025-03-03', '7.00', { run: zly })
    const r2 = await raportSprzedazy(a, wl(), NOW)
    expect(r2.konta.find((k) => k.konto === 'EMPIK:empik')!.porownanie).toMatchObject({ daneOd: '2026-11-08', daneNiepelne: true })

    // nowy przebieg importu archiwum zmienia granicę od razu (pamięć podręczna granic archiwum unieważniona podpisem)
    const run = (await a.importRun.create({ data: { kind: 'archiwum-empik', status: 'OK', stats: { konto: 'empik', od: fromWarsaw('2025-09-01', 0).toISOString(), do: '2026-11-06T00:00:00.000Z' } } })).id
    await arch('EMPIK', 'em25', '2025-10-10', '9.00', { run })
    const r3 = await raportSprzedazy(a, wl(), NOW)
    expect(r3.konta.find((k) => k.konto === 'EMPIK:empik')!.porownanie).toMatchObject({ daneOd: '2025-09-01', daneNiepelne: false })
    // bez zamówień w zakresie i bez filtra: ocena po wszystkich znanych kontach
    const pusty = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2026-11-20', do: '2026-11-25', porownaj: 'rok' }, NOW), NOW)
    expect(pusty.poprzedni).toMatchObject({ poczatekDanych: '2025-09-01', bezDanych: false })
  })

  it('funkcja z jawnymi zakresami (bez parametrów adresu) daje to samo co raport z wyborem', async () => {
    await dane()
    const z = await porownanieSprzedazy(a, { od: '2026-11-01', do: '2026-11-25', grupuj: 'miesiac', konto: null, produktow: 10, porownanie: { od: '2025-11-01', do: '2025-11-25', tryb: 'rok' } }, NOW)
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2026-11-01', do: '2026-11-25', grupuj: 'miesiac', produktow: 10, porownaj: 'rok' }, NOW), NOW)
    expect({ ...z, stanNa: '' }).toEqual({ ...r, stanNa: '' })
    expect(z.okresy[0]!.porownanie).toMatchObject({ od: '2025-11-01', do: '2025-11-25', zamowien: 3 })
  })

  it('API v1: te same parametry z białej listy; zły tryb = 400 z polem', async () => {
    await dane()
    expect(parseZapytanieSprzedazy(new URLSearchParams('od=2026-11-01&do=2026-11-25&porownaj=wlasny&porownaj_od=2025-11-01&porownaj_do=2025-11-30'), NOW)).toMatchObject({ porownaj: 'wlasny', porownajOd: '2025-11-01', porownajDo: '2025-11-30' })
    const key = (await createApiKey(a, { name: 't', scopes: ['raporty:odczyt'] }, 'u')).token
    const get = (qs: string) => trasa.GET(new NextRequest(`http://localhost/api/v1/raporty/sprzedaz?${qs}`, { headers: { 'x-forwarded-for': '198.51.100.52', authorization: `Bearer ${key}` } }))
    const ok = await get('od=2026-11-01&do=2026-11-25&porownaj=rok')
    expect(ok.status).toBe(200)
    expect((await ok.json()).poprzedni).toMatchObject({ od: '2025-11-01', do: '2025-11-25', tryb: 'rok' })
    const zly = await get('od=2026-11-01&do=2026-11-25&porownaj=kwartal')
    expect(zly.status).toBe(400)
    expect(await zly.json()).toMatchObject({ pole: 'porownaj' })
  })
})
