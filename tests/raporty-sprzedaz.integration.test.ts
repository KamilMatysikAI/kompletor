// raport sprzedaży na danych fikcyjnych (SKU TEST-*), bez sieci.
//  - 1 630 zamówień października 2026 z 4 kont kanałów (createMany, liczby z generatora): sumy raportu = sumy pozycji
//    policzone niezależnie w teście; anulowane poza sprzedażą; zwroty odjęte; marża tylko z ceną zakupu;
//  - okresy (dni, tygodnie, miesiące) sumują się do całości, granice dni w czasie polskim, poprzedni okres;
//  - izolacja firm (RLS), filtr konta, GET /api/v1/raporty/sprzedaz (zakres raporty:odczyt, 400 na złe parametry);
//  - GET /api/raporty/sprzedaz (plik z ekranu): uprawnienie `raporty.sprzedaz`, Magazyn domyślnie odmowa;
//  - XLSX raportu: polskie znaki, liczby jako liczby, „brak ceny zakupu”;
//  - pomiar czasu raportu miesiąca (log), firma bez wFirmy i bez BL (marża z ceny zakupu z karty produktu).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { MemberRole, OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import type { SessionContext } from '@/lib/auth/sesje'
import { createApiKey } from '@/lib/api/zarzadzanie'
import { raportSprzedazy, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { odczytajXlsx } from '@/lib/arkusz/xlsx-odczyt'
import { STYL, zapiszXlsx } from '@/lib/arkusz/xlsx'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { arkuszeRaportuSprzedazy, BRAK_CENY_ZAKUPU } from '@/lib/arkusz/raport-sprzedazy'
import { wartoscPozycjiGr } from '@/lib/rdzen/ceny'
import { przelicznikiPozycji, wartoscCzesciGr } from '@/lib/rdzen/zamiana'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { ACC, bundle, product, seedBase, type TestChannel } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
// sesja panelu podstawiona (bez cookies): rola i dodatkowe uprawnienia z testu, reszta (requirePermissionApi) prawdziwa
const sesja: { s: SessionContext | null } = { s: null }
vi.mock('@/lib/panel/kontekst', async (orig) => ({ ...(await orig<typeof import('@/lib/panel/kontekst')>()), currentSession: async () => sesja.s }))
function zaloguj(role: MemberRole, permissions: string[] = []): void {
  const organization = { organizationId: ORG_A, slug: 'firma-a', name: 'Firma A', role, permissions, deniedPermissions: [] }
  sesja.s = { sessionId: 's', user: { id: 'u', email: 'u@firma-a.test', name: 'U' }, organization, memberships: [organization], permissions: permissionsOf(organization), mustChangePassword: false }
}
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const { resetApiLimiters } = await import('@/lib/api/klucze')
const trasa = await import('@/app/api/v1/raporty/sprzedaz/route')
const trasaPanelu = await import('@/app/api/raporty/sprzedaz/route')

testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) await seedBase(db)
  resetApiLimiters()
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const KONTA: TestChannel[] = ['WOO_SD', 'WOO_LAMPY', 'ALLEGRO', 'EMPIK']
const NOW = new Date('2026-11-09T09:00:00Z')

/** Generator liczb (LCG): te same dane przy każdym uruchomieniu. */
function los(seed: number) {
  let s = seed >>> 0
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s % n
  }
}

interface Pozycja {
  product: string | null
  qty: number
  rejected: number
  removed: boolean
  price: number // grosze za sztukę oferty
  perOffer: number
  vat: string | null
  offerId: string | null
}

interface Katalog {
  przyprawa: string // SZT, cena zakupu 4,00, VAT 23
  lisciasta: string // KG, 80 zł/kg, VAT 5, oferta 100 g
  zestaw: string // 2 × przyprawa + 100 g liściastej: koszt 16,00
  kubek: string // bez ceny zakupu, bez stawki (23%)
  ebook: string // DIGITAL, VAT zw, bez ceny zakupu
}

async function katalog(db: PrismaClient): Promise<Katalog> {
  const przyprawa = await product(db, 'TEST-PRZYPRAWA', 100000)
  const lisciasta = await product(db, 'TEST-LISCIASTA', 100000, { unit: 'KG', vatRate: '5' })
  const kubek = await product(db, 'TEST-KUBEK', 100000)
  await db.product.update({ where: { id: przyprawa }, data: { purchasePriceNet: '4.0000', title: 'Przyprawa „Łąka” zażółć' } })
  await db.product.update({ where: { id: lisciasta }, data: { purchasePriceNet: '80.0000' } })
  await db.product.update({ where: { id: kubek }, data: { vatRate: null } })
  const zestaw = await bundle(db, 'TEST-ZESTAW', [
    { id: przyprawa, qty: 2 },
    { id: lisciasta, qty: 100 },
  ])
  const ebook = (await db.product.create({ data: { sku: 'TEST-EBOOK', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book', title: 'E-book testowy', vatRate: 'zw' } })).id
  for (const k of KONTA) await db.channelOffer.create({ data: { ...ACC[k], externalId: 'L-100', productId: lisciasta, qtyBasePerOffer: 100 } })
  return { przyprawa, lisciasta, zestaw, kubek, ebook }
}

/** Koszt jednostki bazowej w groszach (null = brak ceny zakupu) — niezależnie od SQL raportu. */
function kosztJednostki(k: Katalog, p: string | null): number | null {
  if (p === k.przyprawa) return 400
  if (p === k.lisciasta) return 8 // 80 zł/kg = 8 gr/g
  if (p === k.zestaw) return 2 * 400 + 100 * 8
  return null
}
const stawka = (k: Katalog, l: Pozycja) => (l.vat ?? (l.product === k.lisciasta ? '5' : l.product === k.ebook ? 'zw' : '23'))
const vatProc = (s: string) => (/^\d+$/.test(s) ? Number(s) : 0)

interface Oczekiwane {
  zamowien: number
  brutto: number // grosze, totalGross
  anulowanych: number
  produktyBrutto: number
  produktyNetto: number
  koszt: number
  nettoZKosztem: number
  zwrotyBrutto: number
  poKoncie: Map<string, { zamowien: number; brutto: number }>
  poProdukcie: Map<string, { brutto: number; ilosc: number }>
}

/**
 * 1 630 zamówień w październiku (Warszawa), ok. 1/13 anulowanych, pozycje z odrzuconymi i usuniętymi, zwroty co 50.
 * zamówienie, jedno podzamówienie „dośle później”. Zwraca sumy policzone wprost z wygenerowanych danych.
 */
async function generuj(db: PrismaClient, k: Katalog, n = 1630, miesiac = '2026-10'): Promise<Oczekiwane> {
  const r = los(151)
  const exp: Oczekiwane = { zamowien: 0, brutto: 0, anulowanych: 0, produktyBrutto: 0, produktyNetto: 0, koszt: 0, nettoZKosztem: 0, zwrotyBrutto: 0, poKoncie: new Map(), poProdukcie: new Map() }
  const orders: Prisma.OrderCreateManyInput[] = []
  const lines: Prisma.OrderLineCreateManyInput[] = []
  const zwroty: { orderId: string; lineId: string; productId: string; qty: number; odrzucony: boolean }[] = []
  const dni = new Date(Date.UTC(Number(miesiac.slice(0, 4)), Number(miesiac.slice(5, 7)), 0)).getUTCDate()
  for (let i = 0; i < n; i++) {
    const konto = KONTA[i % 4]!
    const day = `${miesiac}-${String(1 + (i % dni)).padStart(2, '0')}`
    // godzina lokalna 0:00–23:59: także tuż po północy i tuż przed nią (granice dni w czasie polskim)
    const ms = i % 97 === 0 ? 5 * 60_000 : i % 89 === 0 ? 86_400_000 - 60_000 : r(86_400) * 1000
    const createdAtChannel = fromWarsaw(day, ms)
    const id = `zam${miesiac.replace('-', '')}x${String(i).padStart(5, '0')}`
    const status: OrderStatus = i % 13 === 5 ? 'ANULOWANE' : i % 3 === 0 ? 'WYSLANE' : 'NOWE'
    const poz: Pozycja[] = []
    const ile = 1 + r(3)
    for (let j = 0; j < ile; j++) {
      const t = r(10)
      const qty = 1 + r(3)
      const base = { rejected: qty > 1 && r(29) === 0 ? 1 : 0, removed: r(41) === 0 }
      if (t < 4) poz.push({ ...base, product: k.przyprawa, qty, price: 1990, perOffer: 1, vat: '23', offerId: `H-${konto}` })
      else if (t < 6) poz.push({ ...base, product: k.lisciasta, qty: qty * 100, rejected: 0, price: 1500, perOffer: 100, vat: null, offerId: 'L-100' })
      else if (t < 7) poz.push({ ...base, product: k.zestaw, qty, price: 4999, perOffer: 1, vat: '23', offerId: null })
      else if (t < 8) poz.push({ ...base, product: k.kubek, qty, price: 3500, perOffer: 1, vat: null, offerId: null })
      else if (t < 9) poz.push({ ...base, product: k.ebook, qty: 1, rejected: 0, price: 2900, perOffer: 1, vat: null, offerId: null })
      else poz.push({ ...base, product: null, qty, price: 500, perOffer: 1, vat: '8', offerId: `X-${i}` })
    }
    const pozBrutto = poz.filter((l) => !l.removed).reduce((s, l) => s + Math.round((l.price * (l.qty - l.rejected)) / l.perOffer), 0)
    const total = pozBrutto + 1299 // + dostawa
    orders.push({ id, ...ACC[konto], externalId: `T-${id}`, status, paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: (total / 100).toFixed(2), createdAtChannel })
    poz.forEach((l, j) => lines.push({ id: `${id}l${j}`, orderId: id, externalLineId: `L${j}`, productId: l.product, qty: l.qty, qtyRejected: l.rejected, removed: l.removed, unitPriceGross: (l.price / 100).toFixed(2), vatRate: l.vat, offerId: l.offerId, channelName: l.product ? null : 'Pozycja spoza katalogu' }))
    // zwrot pierwszej pozycji co 50. zamówienie (składnik przy zestawie), co 150. odrzucony (nie liczy się)
    if (i % 50 === 7 && !poz[0]!.removed && poz[0]!.product && poz[0]!.qty - poz[0]!.rejected > 0) {
      const l0 = poz[0]!
      const comp = l0.product === k.zestaw ? k.przyprawa : l0.product!
      zwroty.push({ orderId: id, lineId: `${id}l0`, productId: comp, qty: l0.product === k.zestaw ? 2 : l0.product === k.lisciasta ? 100 : 1, odrzucony: i % 150 === 7 })
    }
    const kk = `${ACC[konto].channel}:${ACC[konto].channelAccountId}`
    if (status === 'ANULOWANE') {
      exp.anulowanych++
      continue
    }
    exp.zamowien++
    exp.brutto += total
    const pk = exp.poKoncie.get(kk) ?? { zamowien: 0, brutto: 0 }
    pk.zamowien++
    pk.brutto += total
    exp.poKoncie.set(kk, pk)
    poz.forEach((l, j) => {
      if (l.removed || l.qty - l.rejected <= 0) return
      const q = l.qty - l.rejected
      const br = (l.price * q) / l.perOffer
      const z = zwroty.find((x) => x.lineId === `${id}l${j}` && !x.odrzucony)
      // zestaw: zwrot 2 szt. przyprawy (składnik 2 szt. na zestaw, jeden z dwóch składników) = pół zestawu
      const zwrocone = z ? (l.product === k.zestaw ? z.qty / 2 / 2 : z.qty) : 0
      const frac = Math.min(1, zwrocone / q)
      const ne = br / (1 + vatProc(stawka(k, l)) / 100)
      exp.produktyBrutto += br * (1 - frac)
      exp.produktyNetto += ne * (1 - frac)
      exp.zwrotyBrutto += br * frac
      const kj = kosztJednostki(k, l.product)
      if (kj !== null) {
        exp.koszt += q * kj * (1 - frac)
        exp.nettoZKosztem += ne * (1 - frac)
      }
      const key = l.product ?? 'brak'
      const pp = exp.poProdukcie.get(key) ?? { brutto: 0, ilosc: 0 }
      pp.brutto += br * (1 - frac)
      pp.ilosc += q * (1 - frac)
      exp.poProdukcie.set(key, pp)
    })
  }
  for (let i = 0; i < orders.length; i += 1000) await db.order.createMany({ data: orders.slice(i, i + 1000) })
  for (let i = 0; i < lines.length; i += 2000) await db.orderLine.createMany({ data: lines.slice(i, i + 2000) })
  for (const z of zwroty) {
    const ret = await db.return.create({ data: { orderId: z.orderId, status: z.odrzucony ? 'ODRZUCONY' : 'ZAKONCZONY' } })
    await db.returnLine.create({ data: { returnId: ret.id, orderLineId: z.lineId, productId: z.productId, qty: z.qty, disposition: 'NA_STAN' } })
  }
  return exp
}

const zl = (gr: number) => gr / 100
const blisko = (v: number, gr: number, tol = 2) => expect(Math.abs(v - zl(gr)), `${v} vs ${zl(gr)}`).toBeLessThanOrEqual(tol / 100)

describe('raport sprzedaży: sumy na 1 630 zamówieniach z 4 kont', () => {
  it('całość, konta, produkty i marża zgodne z niezależnym liczeniem; anulowane poza sprzedażą; okresy sumują się do całości', async () => {
    const k = await katalog(a)
    const exp = await generuj(a, k)
    // podzamówienie „dośle później”: nie jest osobnym zamówieniem, a jego pozycja liczy się do sprzedaży
    const rodzic = await a.order.findFirstOrThrow({ where: { status: 'NOWE' }, orderBy: { id: 'asc' } })
    await a.order.create({ data: { id: 'zampodzam', channel: rodzic.channel, channelAccountId: rodzic.channelAccountId, externalId: `${rodzic.externalId}#2`, status: 'NOWE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '0.00', createdAtChannel: rodzic.createdAtChannel, parentOrderId: rodzic.id, packageNo: 2 } })
    await a.orderLine.create({ data: { orderId: 'zampodzam', externalLineId: 'L0#dosle', productId: k.przyprawa, qty: 1, unitPriceGross: '19.90', vatRate: '23' } })
    exp.produktyBrutto += 1990
    exp.produktyNetto += 1990 / 1.23
    exp.koszt += 400
    exp.nettoZKosztem += 1990 / 1.23
    exp.poProdukcie.get(k.przyprawa)!.brutto += 1990
    // zamówienia spoza zakresu (30.09 23:59 i 1.11 00:01 w Warszawie) i drugiej firmy nie wchodzą
    await a.order.createMany({
      data: [
        { id: 'zamwrzesien', ...ACC.WOO_SD, externalId: 'T-wrz', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '777.00', createdAtChannel: fromWarsaw('2026-09-30', 86_400_000 - 60_000) },
        { id: 'zamlistopad', ...ACC.WOO_SD, externalId: 'T-lis', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '888.00', createdAtChannel: fromWarsaw('2026-11-01', 60_000) },
      ],
    })
    await b.order.create({ data: { id: 'zamfirmab', ...ACC.WOO_SD, externalId: 'T-b', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '999.00', createdAtChannel: fromWarsaw('2026-10-10', 3600_000) } })

    const t0 = performance.now()
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2026-10-01', do: '2026-10-31', produktow: 1000 }, NOW), NOW)
    const ms = Math.round(performance.now() - t0)
    console.log(`[raport sprzedaży] miesiąc: ${exp.zamowien + exp.anulowanych} zamówień, ${ms} ms`)

    expect(r.grupuj).toBe('dzien')
    expect(r.razem.zamowien).toBe(exp.zamowien)
    expect(r.razem.anulowanych).toBe(exp.anulowanych)
    expect(exp.anulowanych).toBeGreaterThan(100)
    blisko(r.razem.wartoscBrutto, exp.brutto, 0)
    blisko(r.razem.produktyBrutto, exp.produktyBrutto)
    blisko(r.razem.produktyNetto, exp.produktyNetto)
    blisko(r.razem.zwrotyBrutto, exp.zwrotyBrutto)
    expect(exp.zwrotyBrutto).toBeGreaterThan(0)
    blisko(r.razem.koszt, exp.koszt)
    blisko(r.razem.marza!, exp.nettoZKosztem - exp.koszt)
    blisko(r.razem.bezCenyZakupuNetto, exp.produktyNetto - exp.nettoZKosztem)
    expect(r.razem.sredniaWartosc).toBeCloseTo(zl(exp.brutto) / exp.zamowien, 1)
    // konta
    expect(r.konta.map((x) => x.konto).sort()).toEqual([...exp.poKoncie.keys()].sort())
    for (const kk of r.konta) {
      expect(kk.zamowien).toBe(exp.poKoncie.get(kk.konto)!.zamowien)
      blisko(kk.wartoscBrutto, exp.poKoncie.get(kk.konto)!.brutto, 0)
    }
    expect(r.konta.find((x) => x.konto === 'WOO:sd')!.nazwa).toBe('WOO_SD test')
    // produkty: pozycja bez produktu jako jeden wiersz, brak ceny zakupu ≠ marża 100%
    expect(r.produktowRazem).toBe(exp.poProdukcie.size)
    for (const p of r.produkty) {
      const id = p.sku === null ? 'brak' : ({ 'TEST-PRZYPRAWA': k.przyprawa, 'TEST-LISCIASTA': k.lisciasta, 'TEST-ZESTAW': k.zestaw, 'TEST-KUBEK': k.kubek, 'TEST-EBOOK': k.ebook } as Record<string, string>)[p.sku]!
      blisko(p.brutto, exp.poProdukcie.get(id)!.brutto)
    }
    const kubek = r.produkty.find((p) => p.sku === 'TEST-KUBEK')!
    expect(kubek).toMatchObject({ brakCenyZakupu: true, koszt: null, marza: null, marzaProcent: null })
    const ebook = r.produkty.find((p) => p.sku === 'TEST-EBOOK')!
    expect(ebook.netto).toBeCloseTo(ebook.brutto, 2) // VAT „zw”
    const lis = r.produkty.find((p) => p.sku === 'TEST-LISCIASTA')!
    expect(lis.jednostka).toBe('KG')
    expect(lis.brakCenyZakupu).toBe(false)
    blisko(lis.koszt!, exp.poProdukcie.get(k.lisciasta)!.ilosc * 8)
    expect(r.produkty.find((p) => p.sku === 'TEST-ZESTAW')!.marza).not.toBeNull()
    expect(r.produkty.find((p) => p.sku === null)!.nazwa).toBe('Pozycje bez produktu w katalogu')
    // okresy: 31 dni, suma = całość
    expect(r.okresy).toHaveLength(31)
    expect(r.okresy.reduce((s, o) => s + o.zamowien, 0)).toBe(r.razem.zamowien)
    blisko(r.okresy.reduce((s, o) => s + o.produktyNetto, 0), exp.produktyNetto, 40)
    // tygodnie i miesiące: te same sumy, okres niepełny oznaczony
    const tyg = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2026-10-01', do: '2026-10-31', grupuj: 'tydzien' }, NOW), NOW)
    expect(tyg.okresy[0]).toMatchObject({ okres: '2026-09-28', okresDo: '2026-10-04', niepelny: true })
    expect(tyg.okresy.reduce((s, o) => s + o.zamowien, 0)).toBe(r.razem.zamowien)
    blisko(tyg.okresy.reduce((s, o) => s + o.wartoscBrutto, 0), exp.brutto, 0)
    const mies = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2026-10-01', do: '2026-10-31', grupuj: 'miesiac' }, NOW), NOW)
    expect(mies.okresy).toEqual([expect.objectContaining({ okres: '2026-10-01', okresDo: '2026-10-31', niepelny: false, zamowien: exp.zamowien })])
    // poprzedni okres (31 dni przed): tylko zamówienie z 30.09 23:59
    expect(r.poprzedni).toMatchObject({ od: '2026-08-31', do: '2026-09-30', razem: { zamowien: 1, wartoscBrutto: 777 } })
    // filtr konta
    const sd = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2026-10-01', do: '2026-10-31', konto: 'WOO:sd' }, NOW), NOW)
    expect(sd.razem.zamowien).toBe(exp.poKoncie.get('WOO:sd')!.zamowien)
    expect(sd.konta.map((x) => x.konto)).toEqual(['WOO:sd'])
    // druga firma widzi tylko swoje
    const rb = await raportSprzedazy(b, zapytanieSprzedazy({ od: '2026-10-01', do: '2026-10-31' }, NOW), NOW)
    expect(rb.razem).toMatchObject({ zamowien: 1, wartoscBrutto: 999, produktyBrutto: 0, marza: null })
    expect(rb.produkty).toEqual([])

    // XLSX raportu: polskie znaki, liczby jako liczby, brak ceny zakupu opisany
    const x = odczytajXlsx(zapiszXlsx(arkuszeRaportuSprzedazy(r, 'wszystkie kanały')))
    expect([...x.keys()]).toEqual(['Podsumowanie', 'Okresy', 'Kanały', 'Produkty'])
    const pod = x.get('Podsumowanie')!
    expect(pod[1]![0]!.wartosc).toBe('Zamówienia')
    expect(pod[1]![1]).toMatchObject({ typ: 'liczba', wartosc: exp.zamowien, styl: STYL.calkowita })
    // kwoty w Podsumowaniu z formatem kwoty, procent marży natywnym procentem
    expect(pod.find((w) => w[0]?.wartosc === 'Wartość zamówień brutto (z dostawą)')![1]).toMatchObject({ styl: STYL.kwota })
    expect(pod.find((w) => w[0]?.wartosc === 'Marża %')![1]).toMatchObject({ styl: STYL.procent, wartosc: Number(((r.razem.marzaProcent ?? 0) / 100).toPrecision(12)) })
    expect(pod.find((w) => w[0]?.wartosc === 'Stan na')![1]).toMatchObject({ typ: 'liczba', styl: STYL.data })
    const prod = x.get('Produkty')!
    expect(prod[0]!.map((c) => c?.wartosc)).toContain('Marża netto')
    const wPrzyprawa = prod.find((w) => w[0]?.wartosc === 'TEST-PRZYPRAWA')!
    expect(wPrzyprawa[1]!.wartosc).toBe('Przyprawa „Łąka” zażółć')
    expect(wPrzyprawa[6]!.typ).toBe('liczba')
    const wKubek = prod.find((w) => w[0]?.wartosc === 'TEST-KUBEK')!
    expect(wKubek[9]).toBeUndefined() // marża pusta, nie 0 i nie 100%
    expect(wKubek[11]!.wartosc).toBe(BRAK_CENY_ZAKUPU)
    expect(x.get('Okresy')!.length).toBe(32)
  }, 120_000)

  it('firma bez wFirmy i bez BL: marża z ceny zakupu wpisanej w karcie produktu (RECZNE)', async () => {
    const p = (await a.product.create({ data: { sku: 'TEST-WLASNY', kind: 'STOCKED', unit: 'SZT', dataSource: 'RECZNE', nameAccounting: 'Własny', title: 'Własny produkt', vatRate: '23', purchasePriceNet: '10.0000' } })).id
    await a.order.create({ data: { id: 'zamreczne', ...ACC.RECZNE, externalId: 'R-1', paymentState: 'PAID', paymentMethod: 'gotówka', totalGross: '123.00', createdAtChannel: fromWarsaw('2026-11-05', 3600_000), sourceLabel: 'Telefon' } })
    await a.orderLine.create({ data: { orderId: 'zamreczne', externalLineId: 'L1', productId: p, qty: 4, unitPriceGross: '30.75', vatRate: '23' } })
    const r = await raportSprzedazy(a, zapytanieSprzedazy({}, NOW), NOW)
    expect(r.od).toBe('2026-11-01')
    expect(r.razem).toMatchObject({ zamowien: 1, wartoscBrutto: 123, produktyBrutto: 123, produktyNetto: 100, koszt: 40, marza: 60, marzaProcent: 60, bezCenyZakupuNetto: 0 })
    expect(r.produkty).toEqual([expect.objectContaining({ sku: 'TEST-WLASNY', ilosc: 4, brakCenyZakupu: false, marza: 60 })])
  })
})

describe('stawka VAT pozycji', () => {
  it('kody bez VAT = netto równe brutto, liczby z „%” i przecinkiem, nieznany tekst: stawka produktu (albo 23) i licznik', async () => {
    const p8 = (await a.product.create({ data: { sku: 'TEST-VAT8', kind: 'STOCKED', unit: 'SZT', dataSource: 'RECZNE', nameAccounting: 'V8', title: 'VAT 8', vatRate: '8' } })).id
    const pBez = (await a.product.create({ data: { sku: 'TEST-VATX', kind: 'STOCKED', unit: 'SZT', dataSource: 'RECZNE', nameAccounting: 'VX', title: 'Bez stawki' } })).id
    await a.order.create({ data: { id: 'zamvat', ...ACC.RECZNE, externalId: 'V-1', paymentState: 'PAID', paymentMethod: 'gotówka', totalGross: '1000.00', createdAtChannel: fromWarsaw('2026-11-05', 3600_000) } })
    const linie: [string, string, string][] = [
      ['L1', p8, 'zw'], // 100 netto
      ['L2', p8, 'np I'], // 100
      ['L3', p8, '5 %'], // 100/1,05
      ['L4', p8, '23,00'], // 100/1,23
      ['L5', p8, 'xx'], // nieznana: stawka produktu 8 → 100/1,08
      ['L6', pBez, 'bzdura'], // nieznana, produkt bez stawki → 23
    ]
    for (const [id, productId, vatRate] of linie) await a.orderLine.create({ data: { orderId: 'zamvat', externalLineId: id, productId, qty: 1, unitPriceGross: '100.00', vatRate } })
    const r = await raportSprzedazy(a, zapytanieSprzedazy({}, NOW), NOW)
    const oczek = 100 + 100 + 100 / 1.05 + 100 / 1.23 + 100 / 1.08 + 100 / 1.23
    expect(Math.abs(r.razem.produktyNetto - oczek)).toBeLessThanOrEqual(0.02)
    expect(r.razem.nieznanaStawkaPozycji).toBe(2)
    expect(r.konta[0]!.nieznanaStawkaPozycji).toBe(2)
  })
})

describe('zamiennik („Zamień produkt”)', () => {
  it('zamiennik towaru na wagę liczy się przelicznikiem oferty pozycji pierwotnej: 100 g za 8 zł, nie 100 × 8 zł', async () => {
    const herbA = await product(a, 'TEST-HERB-A', 0, { unit: 'KG', vatRate: '5' })
    const herbB = await product(a, 'TEST-HERB-B', 1000, { unit: 'KG', vatRate: '5' })
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'H-100', productId: herbA, qtyBasePerOffer: 100 } })
    await a.order.create({ data: { id: 'zamzam', ...ACC.WOO_SD, externalId: 'Z-1', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '20.99', createdAtChannel: fromWarsaw('2026-11-05', 3600_000) } })
    await a.orderLine.create({ data: { orderId: 'zamzam', externalLineId: 'L1', offerId: 'H-100', productId: herbA, qty: 100, qtyRejected: 100, unitPriceGross: '8.00', vatRate: '5' } })
    await a.orderLine.create({ data: { orderId: 'zamzam', externalLineId: 'L1#zamiana-1', productId: herbB, qty: 100, unitPriceGross: '8.00', vatRate: '5' } })
    const r = await raportSprzedazy(a, zapytanieSprzedazy({}, NOW), NOW)
    expect(r.razem.produktyBrutto).toBe(8)
    expect(r.produkty).toEqual([expect.objectContaining({ sku: 'TEST-HERB-B', ilosc: 100 })])
  })
})

describe('wartość pozycji jak na dokumencie', () => {
  async function zamowienieZ(id: string, linie: Omit<Prisma.OrderLineCreateManyInput, 'orderId'>[]) {
    await a.order.create({ data: { id, ...ACC.WOO_SD, externalId: `D3-${id}`, paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '99.99', createdAtChannel: fromWarsaw('2026-11-05', 3600_000) } })
    await a.orderLine.createMany({ data: linie.map((l) => ({ ...l, orderId: id })) })
  }

  it('3 pozycje po 29 g z oferty 50 g za 3,75 zł: 6,54 zł jak 3 × 2,18 zł na dokumencie (było 6,525 → 6,53 zł)', async () => {
    const herb = await product(a, 'TEST-D3-A', 0, { unit: 'KG', vatRate: '5' })
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herb, qtyBasePerOffer: 50 } })
    for (const n of [1, 2, 3]) await zamowienieZ(`d3z${n}`, [{ externalLineId: 'L1', offerId: 'O-50', productId: herb, qty: 50, qtyRejected: 21, unitPriceGross: '3.75', vatRate: '5' }])
    const r = await raportSprzedazy(a, zapytanieSprzedazy({}, NOW), NOW)
    expect(r.razem.produktyBrutto).toBe((3 * wartoscPozycjiGr(29, 50, 375)) / 100)
    expect(r.razem.produktyBrutto).toBe(6.54)
  })

  it('rodzina zamian: pozycja pierwotna 29 g + zamiennik 21 g = 3,75 zł (wartość części jako przyrost rodziny, nie 2,18 + 1,575)', async () => {
    const herbA = await product(a, 'TEST-D3-B', 0, { unit: 'KG', vatRate: '5' })
    const herbB = await product(a, 'TEST-D3-C', 0, { unit: 'KG', vatRate: '5' })
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herbA, qtyBasePerOffer: 50 } })
    await zamowienieZ('d3r', [
      { externalLineId: 'L1', offerId: 'O-50', productId: herbA, qty: 50, qtyRejected: 21, unitPriceGross: '3.75', vatRate: '5' },
      { externalLineId: 'L1#zamiana-1', productId: herbB, qty: 21, unitPriceGross: '3.75', vatRate: '5' },
    ])
    const r = await raportSprzedazy(a, zapytanieSprzedazy({}, NOW), NOW)
    expect(r.razem.produktyBrutto).toBe(3.75)
    expect(r.produkty.find((p) => p.sku === 'TEST-D3-C')!.brutto).toBe(1.57)
  })

  it('zamiennik usuniętej pozycji pierwotnej: bez przelicznika jej oferty (jak `przelicznikiPozycji`; dokument staje z błędem zamiany)', async () => {
    const herbA = await product(a, 'TEST-D3-D', 0, { unit: 'KG', vatRate: '5' })
    const herbB = await product(a, 'TEST-D3-E', 0, { unit: 'KG', vatRate: '5' })
    await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId: 'O-50', productId: herbA, qtyBasePerOffer: 50 } })
    await zamowienieZ('d3u', [
      { externalLineId: 'L1', offerId: 'O-50', productId: herbA, qty: 50, qtyRejected: 50, removed: true, unitPriceGross: '0.10', vatRate: '5' },
      { externalLineId: 'L1#zamiana-1', productId: herbB, qty: 50, unitPriceGross: '0.10', vatRate: '5' },
    ])
    const linie = await a.orderLine.findMany({ where: { orderId: 'd3u' } })
    expect(przelicznikiPozycji(linie, () => 50).zamienniki.get(linie.find((l) => l.externalLineId === 'L1#zamiana-1')!.id)).toBe('bez-pozycji-pierwotnej')
    const r = await raportSprzedazy(a, zapytanieSprzedazy({}, NOW), NOW)
    expect(r.razem.produktyBrutto).toBe(5) // 50 × 0,10 zł z przelicznikiem 1, jak `przelicznikiPozycji`
  })

  it('SQL raportu = wartoscCzesciGr z przelicznikiPozycji na tych samych 400 losowych zamówieniach (oferty wagowe i wielosztukowe, zamiany, łańcuchy, usunięte, odrzucone)', async () => {
    const r0 = los(238)
    const skus = ['TEST-D3-W1', 'TEST-D3-W2', 'TEST-D3-S1', 'TEST-D3-S2']
    const prod = [
      await product(a, skus[0]!, 0, { unit: 'KG', vatRate: '5' }),
      await product(a, skus[1]!, 0, { unit: 'KG', vatRate: '5' }),
      await product(a, skus[2]!, 0),
      await product(a, skus[3]!, 0),
    ]
    const oferty: [string, string, number][] = [
      ['O-W50', prod[0]!, 50],
      ['O-W100', prod[1]!, 100],
      ['O-S3', prod[2]!, 3],
      ['O-S1', prod[3]!, 1],
    ]
    for (const [externalId, productId, qtyBasePerOffer] of oferty) await a.channelOffer.create({ data: { ...ACC.WOO_SD, externalId, productId, qtyBasePerOffer } })
    const ceny = ['3.75', '12.50', '0.07', '19.99', '10.01', '1.33']
    for (let i = 0; i < 400; i++) {
      const linie: Omit<Prisma.OrderLineCreateManyInput, 'orderId'>[] = []
      const ile = 1 + r0(3)
      for (let j = 0; j < ile; j++) {
        const [offerId, productId, n] = oferty[r0(oferty.length)]!
        const qty = 1 + r0(3 * n)
        const odrz = r0(3) === 0 ? r0(qty + 1) : 0
        const cena = ceny[r0(ceny.length)]!
        linie.push({ externalLineId: `L${j}`, offerId: r0(9) === 0 ? null : offerId, productId, qty, qtyRejected: odrz, removed: r0(23) === 0, unitPriceGross: cena })
        // zamiany odrzuconych sztuk: czasem łańcuch (zamiana zamiennika), zamiennik częściowo odrzucony albo usunięty
        let zrodlo = `L${j}`
        let wolne = odrz
        for (let z = 1; wolne > 0 && z <= 2; z++) {
          const q = 1 + r0(wolne)
          const zOdrz = r0(3) === 0 ? r0(q + 1) : 0
          const ext = `${zrodlo}#zamiana-${z + j * 10}`
          linie.push({ externalLineId: ext, productId: prod[r0(prod.length)]!, qty: q, qtyRejected: zOdrz, removed: r0(31) === 0, unitPriceGross: cena })
          if (r0(2) === 0) {
            zrodlo = ext
            wolne = zOdrz
          } else wolne -= q
        }
      }
      await zamowienieZ(`d3l${i}`, linie)
    }
    // oczekiwane: funkcje dokumentu na liniach z bazy (pozycje nieusunięte z wydaną ilością > 0)
    const poOfercie = new Map(oferty.map(([id, , n]) => [id, n]))
    const wszystkie = await a.orderLine.findMany({ where: { orderId: { startsWith: 'd3l' } } })
    const poZam = new Map<string, typeof wszystkie>()
    for (const l of wszystkie) poZam.set(l.orderId, [...(poZam.get(l.orderId) ?? []), l])
    let oczek = 0
    let rodzin = 0
    const poProd = new Map<string, number>()
    for (const linie of poZam.values()) {
      const prz = przelicznikiPozycji(linie, (o) => poOfercie.get(o))
      rodzin += prz.pokryte.size
      for (const l of linie) {
        const q = l.qty - l.qtyRejected
        if (l.removed || q <= 0) continue
        const g = wartoscCzesciGr(q, prz.przesuniecie.get(l.id) ?? 0, prz.naOferte.get(l.id) ?? 1, Math.round(Number(l.unitPriceGross) * 100))
        oczek += g
        poProd.set(l.productId!, (poProd.get(l.productId!) ?? 0) + g)
      }
    }
    expect(rodzin).toBeGreaterThan(30)
    const r = await raportSprzedazy(a, zapytanieSprzedazy({}, NOW), NOW)
    expect(Math.round(r.razem.produktyBrutto * 100)).toBe(oczek)
    expect(r.produkty).toHaveLength(4)
    for (const p of r.produkty) expect(Math.round(p.brutto * 100), p.sku ?? '').toBe(poProd.get(prod[skus.indexOf(p.sku!)]!))
  })
})

describe('GET /api/v1/raporty/sprzedaz', () => {
  const req = (p: string, token?: string) => new NextRequest(`http://localhost:3100${p}`, { headers: { 'x-forwarded-for': '198.51.100.51', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
  it('zakres raporty:odczyt, ten sam wynik co funkcja, 400 na złe parametry, bez danych klientów', async () => {
    await a.order.create({ data: { id: 'zamapi', ...ACC.WOO_SD, externalId: 'T-api', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '50.00', createdAtChannel: fromWarsaw('2026-10-10', 3600_000) } })
    expect((await trasa.GET(req('/api/v1/raporty/sprzedaz'))).status).toBe(401)
    const zly = (await createApiKey(a, { name: 't', scopes: ['stany:odczyt'] }, 'u')).token
    expect((await trasa.GET(req('/api/v1/raporty/sprzedaz', zly))).status).toBe(403)
    const t = (await createApiKey(a, { name: 't', scopes: ['raporty:odczyt'] }, 'u')).token
    const res = await trasa.GET(req('/api/v1/raporty/sprzedaz?od=2026-10-01&do=2026-10-31&grupuj=tydzien', t))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ od: '2026-10-01', do: '2026-10-31', grupuj: 'tydzien', razem: { zamowien: 1, wartoscBrutto: 50 } })
    expect(JSON.stringify(j)).not.toMatch(/email|telefon|adres|nazwisko/i)
    for (const q of ['od=2026-13-01', 'od=2026-10-10&do=2026-10-01', 'od=2025-01-01&do=2026-10-01', 'grupuj=rok', 'konto=zle konto', 'produktow=0', 'cos=1', 'od=2026-01-01&do=2026-10-31&grupuj=dzien']) {
      const r = await trasa.GET(req(`/api/v1/raporty/sprzedaz?${q}`, t))
      expect(r.status, q).toBe(400)
    }
  })
})

describe('dostęp do raportu z panelu: uprawnienie „Raporty sprzedaży i marża”', () => {
  const req = (p: string) => new NextRequest(`http://localhost:3100${p}`)
  it('Magazyn bez uprawnienia: 404 na pliku; Biuro, Właściciel i Magazyn z nadanym uprawnieniem: plik XLSX', async () => {
    sesja.s = null
    expect((await trasaPanelu.GET(req('/api/raporty/sprzedaz'))).status).toBe(401)
    zaloguj('MAGAZYN')
    const odmowa = await trasaPanelu.GET(req('/api/raporty/sprzedaz?od=2026-10-01&do=2026-10-31'))
    expect(odmowa.status).toBe(404)
    expect(odmowa.headers.get('content-type')).not.toContain('spreadsheetml')
    for (const [role, extra] of [['BIURO', []], ['WLASCICIEL', []], ['MAGAZYN', ['raporty.sprzedaz']]] as [MemberRole, string[]][]) {
      zaloguj(role, extra)
      const r = await trasaPanelu.GET(req('/api/raporty/sprzedaz?od=2026-10-01&do=2026-10-31'))
      expect(r.status, role).toBe(200)
      expect(r.headers.get('content-type')).toContain('spreadsheetml')
      expect([...odczytajXlsx(Buffer.from(await r.arrayBuffer())).keys()]).toEqual(['Podsumowanie', 'Okresy', 'Kanały', 'Produkty'])
    }
    sesja.s = null
  })

  it('ekran /raporty i menu wymagają `raporty.sprzedaz`; eksport listy zamówień zostaje przy podglądzie panelu', () => {
    const src = (f: string) => readFileSync(path.join(process.cwd(), f), 'utf8')
    expect(src('app/(panel)/raporty/page.tsx')).toMatch(/const ctx = await requirePermission\('raporty\.sprzedaz'\)/)
    expect(src('app/api/raporty/sprzedaz/route.ts')).toMatch(/requirePermissionApi\('raporty\.sprzedaz'\)/)
    expect(src('lib/panel/nawigacja.ts')).toMatch(/href: '\/raporty', etykieta: 'Raporty', uprawnienie: 'raporty\.sprzedaz'/)
    expect(src('app/api/zamowienia/eksport/route.ts')).not.toContain('raporty.sprzedaz')
  })
})

describe('wydajność (RAPORT_WYDAJNOSC=1): grudniowy wolumen', () => {
  it.runIf(process.env.RAPORT_WYDAJNOSC === '1')('12 000 zamówień w miesiącu: raport miesiąca i roku', async () => {
    const k = await katalog(a)
    await generuj(a, k, 12_000, '2026-12')
    for (const [od, doD] of [
      ['2026-12-01', '2026-12-31'],
      ['2026-01-01', '2026-12-31'],
    ] as const) {
      const t0 = performance.now()
      const r = await raportSprzedazy(a, zapytanieSprzedazy({ od, do: doD }, new Date('2027-01-02T09:00:00Z')), new Date('2027-01-02T09:00:00Z'))
      console.log(`[raport sprzedaży] wydajność ${od}–${doD}: ${r.razem.zamowien + r.razem.anulowanych} zamówień, ${Math.round(performance.now() - t0)} ms`)
    }
  }, 600_000)
})
