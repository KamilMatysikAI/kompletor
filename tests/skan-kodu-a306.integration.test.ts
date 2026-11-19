// jedno rozpoznanie kodu dla stanowiska, Pakowania i listy zamówień.
//  1. rozpoznajKod: karta, koszyk, numer zamówienia (z przedrostkiem i bez, numer w kanale, numer w BL, UUID),
//     numer nadania (dokładnie i jako fragment kodu z etykiety), nieznany, kilka trafień, cudza firma (RLS);
//  2. Pakowanie bez otwartego okna: karta i koszyk → zamówienie do okna; spakowane, anulowane, nieznane → komunikat;
//  3. lista zamówień: skan i wklejenie (numer z maila, tytuł przelewu), wieloznaczność → filtrowanie, Enter w „Szukaj”.
// Dane wyłącznie testowe (zmyślone produkty i numery).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { dodajKoszyki, przypiszKoszyk } from '@/lib/koszyki/koszyki'
import { otworzZSesji, rozpoznajSkan, zakonczCwiczenie } from '@/lib/stanowisko/cwiczenie'
import { gabarytyDla } from '@/lib/stanowisko/gabaryty'
import { drukujKarty } from '@/lib/stanowisko/karty'
import { rozpoznajKod } from '@/lib/stanowisko/rozpoznaj-kod'
import { kodNaLiscie, skanDoPakowania, zamowienieZFrazy } from '@/lib/stanowisko/skan-poza-oknem'
import { wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { ORG_B, testDb, truncateAll } from './db'
import { order, product, seedBase, type TestChannel } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Osoba testowa' }
const KOD = { tryb: 'kod', numery: true, koszyk: true, fragmenty: true } as const

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

let nrProduktu = 0
async function zamowienie(db: PrismaClient, externalId: string, o: { kanal?: TestChannel; channelNumber?: string; blOrderId?: number } = {}) {
  const p = await product(db, `SKU-${externalId}-${++nrProduktu}`, 10)
  const r = await ingestOrder(db, order([{ productId: p, qty: 1 }], { externalId, createdAtChannel: new Date(), channel: o.kanal ?? 'WOO_SD', totalGross: 100 + nrProduktu, eventKey: `a306-${nrProduktu}` }))
  const id = r.orderId!
  if (o.channelNumber || o.blOrderId) await db.order.update({ where: { id }, data: { channelNumber: o.channelNumber ?? null, blOrderId: o.blOrderId ?? null } })
  return id
}

async function przesylka(db: PrismaClient, orderId: string, numer: string) {
  await db.shipment.create({ data: { orderId, packageNo: 1, reference: `ref-a306-${numer}`, adapterKey: 'dpd', carrier: 'DPD', state: 'UTWORZONA', trackingNumber: numer } })
}

const numerNaLiscie = async (db: PrismaClient, id: string) => (await wczytajZamowienia(db, [id]))[0]!.numer

describe('rozpoznajKod: karta, koszyk, numer, przesyłka', () => {
  it('karta zamówienia (z otoczką czytnika) i rozpoznanie na stanowisku bez zmian', async () => {
    const o1 = await zamowienie(a, '48213')
    const kod = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    expect(await rozpoznajKod(a, `]C1${kod}\r\n`, KOD)).toMatchObject({ typ: 'zamowienie', orderId: o1, przez: 'karta', karta: { printNo: 1 } })
    expect((await rozpoznajSkan(a, kod, KTO)).typ).toBe('ok')
    // karta o numerze wydruku, którego nie było: nieznany (bez szukania po numerze zamówienia)
    expect(await rozpoznajKod(a, kod.replace(/\/1$/, '/9'), KOD)).toEqual({ typ: 'nieznany' })
  })

  it('koszyk z zamówieniem, pusty i nieistniejący', async () => {
    const o1 = await zamowienie(a, '48213')
    await dodajKoszyki(a, { nazwy: ['A', 'B'] })
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o1, userId: KTO.userId })
    expect(await rozpoznajKod(a, 'KOSZ-A', KOD)).toMatchObject({ typ: 'zamowienie', orderId: o1, przez: 'koszyk', koszyk: 'A' })
    expect(await rozpoznajKod(a, 'KOSZ-B', KOD)).toEqual({ typ: 'koszyk', nazwa: 'B', stan: 'pusty' })
    expect(await rozpoznajKod(a, 'KOSZ-Z', KOD)).toEqual({ typ: 'koszyk', nazwa: 'Z', stan: 'brak' })
  })

  it('numer zamówienia: id z kanału, numer w kanale, numer w BL, z przedrostkiem konta i bez, UUID Allegro', async () => {
    const sd = await zamowienie(a, '48213')
    const woo = await zamowienie(a, '9001', { channelNumber: 'WZ-2026-77', kanal: 'WOO_LAMPY' })
    const bl = await zamowienie(a, 'X-ab', { blOrderId: 7700123, kanal: 'WOO_LAMPY' })
    const alg = await zamowienie(a, 'a1b2c3d4-0000-4000-8000-00000000ab12', { kanal: 'ALLEGRO' })
    expect(await rozpoznajKod(a, '48213', KOD)).toMatchObject({ typ: 'zamowienie', orderId: sd, przez: 'numer' })
    expect(await rozpoznajKod(a, await numerNaLiscie(a, sd), KOD)).toMatchObject({ orderId: sd })
    expect(await rozpoznajKod(a, 'WZ-2026-77', KOD)).toMatchObject({ orderId: woo })
    expect(await rozpoznajKod(a, '7700123', KOD)).toMatchObject({ orderId: bl })
    expect(await rozpoznajKod(a, 'A1B2C3D4-0000-4000-8000-00000000AB12', KOD)).toMatchObject({ orderId: alg })
    // obcy przedrostek przy numerze tego zamówienia: nie pasuje
    expect(await rozpoznajKod(a, 'QQ 48213', KOD)).toEqual({ typ: 'nieznany' })
  })

  it('ten sam numer w dwóch sklepach: bez przedrostka „wiele”, z przedrostkiem jedno', async () => {
    const sd = await zamowienie(a, '50001', { kanal: 'WOO_SD' })
    const lampy = await zamowienie(a, '50001', { kanal: 'WOO_LAMPY' })
    expect(await rozpoznajKod(a, '50001', KOD)).toEqual({ typ: 'wiele', ile: 2 })
    expect(await rozpoznajKod(a, await numerNaLiscie(a, sd), KOD)).toMatchObject({ typ: 'zamowienie', orderId: sd })
    expect(await rozpoznajKod(a, await numerNaLiscie(a, lampy), KOD)).toMatchObject({ typ: 'zamowienie', orderId: lampy })
  })

  it('numer nadania: dokładnie, małe litery, fragment kodu z etykiety (najdłuższy wygrywa), bez fragmentów w szukaniu', async () => {
    const o1 = await zamowienie(a, '48213')
    const o2 = await zamowienie(a, '48214')
    await przesylka(a, o1, '602000000000000000000017')
    await przesylka(a, o2, '1000000000017U')
    expect(await rozpoznajKod(a, '602000000000000000000017', KOD)).toMatchObject({ typ: 'zamowienie', orderId: o1, przez: 'przesylka' })
    expect(await rozpoznajKod(a, '1000000000017u', KOD)).toMatchObject({ orderId: o2 })
    expect(await rozpoznajKod(a, '%0061000' + '1000000000017U' + '101616', KOD)).toMatchObject({ orderId: o2, przez: 'przesylka' })
    expect(await rozpoznajKod(a, '%0061000' + '1000000000017U' + '101616', { ...KOD, fragmenty: false })).toEqual({ typ: 'nieznany' })
    expect(await rozpoznajKod(a, '999999999999999999', KOD)).toEqual({ typ: 'nieznany' })
  })

  it('cudza firma (RLS): karta, koszyk, numer i przesyłka firmy B są w firmie A nieznane', async () => {
    const ob = await zamowienie(b, '48213')
    const kod = (await drukujKarty(b, [ob], KTO)).wydruki[0]!.kod
    await dodajKoszyki(b, { nazwy: ['C'] })
    await przypiszKoszyk(b, { nazwa: 'C', orderId: ob, userId: KTO.userId })
    await przesylka(b, ob, '602000000000000000000099')
    expect(await rozpoznajKod(b, kod, KOD)).toMatchObject({ orderId: ob })
    expect(await rozpoznajKod(a, kod, KOD)).toEqual({ typ: 'nieznany' })
    expect(await rozpoznajKod(a, 'KOSZ-C', KOD)).toEqual({ typ: 'koszyk', nazwa: 'C', stan: 'brak' })
    expect(await rozpoznajKod(a, '48213', KOD)).toEqual({ typ: 'nieznany' })
    expect(await rozpoznajKod(a, '602000000000000000000099', KOD)).toEqual({ typ: 'nieznany' })
    expect(await kodNaLiscie(a, '48213', 'skan')).toMatchObject({ typ: 'komunikat', tekst: expect.stringMatching(/^Nie znam kodu „48213”/) })
  })
})

describe('Pakowanie bez otwartego okna: skanDoPakowania', () => {
  it('karta i koszyk → zamówienie do okna; spakowane, anulowane, nieznane → komunikat bez otwierania', async () => {
    const o1 = await zamowienie(a, '48213')
    const o2 = await zamowienie(a, '48214')
    const o3 = await zamowienie(a, '48215')
    const { wydruki } = await drukujKarty(a, [o1, o2, o3], KTO)
    const kod = (id: string) => wydruki.find((w) => w.orderId === id)!.kod
    expect(await skanDoPakowania(a, kod(o1))).toMatchObject({ typ: 'otworz', orderId: o1 })
    await dodajKoszyki(a, { nazwy: ['A'] })
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o1, userId: KTO.userId })
    expect(await skanDoPakowania(a, 'KOSZ-A')).toMatchObject({ typ: 'otworz', orderId: o1 })

    const w = await otworzZSesji(a, o2, null, KTO)
    if (w.typ !== 'ok') throw new Error('oczekiwane ok')
    const zebrane = Object.fromEntries(w.zamowienie.pozycje.map((p) => [p.klucz, p.ilosc]))
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gabarytyDla(w.zamowienie.carrier)[0]!, zebrane, userId: KTO.userId })
    expect(await skanDoPakowania(a, kod(o2))).toMatchObject({ typ: 'komunikat', tekst: expect.stringMatching(/już spakowane/) })

    await cancelOrder(a, o3)
    expect(await skanDoPakowania(a, kod(o3))).toMatchObject({ typ: 'komunikat', ton: 'czerwona', tekst: expect.stringMatching(/anulowane/) })

    expect(await skanDoPakowania(a, 'ABCD-nieznane')).toEqual({ typ: 'komunikat', ton: 'blad', tekst: 'Nie znam kodu „ABCD-nieznane”. Zeskanuj kartę zamówienia albo koszyk.' })
    expect(await skanDoPakowania(a, 'KOSZ-Q')).toMatchObject({ typ: 'komunikat', ton: 'info', tekst: expect.stringMatching(/Nie ma koszyka Q/) })
  })
})

describe('lista zamówień: skan, wklejenie i Enter w „Szukaj”', () => {
  it('skan etykiety i karty otwiera kartę zamówienia; nieznany = komunikat', async () => {
    const o1 = await zamowienie(a, '48213')
    await przesylka(a, o1, '602000000000000000000017')
    const kod = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    expect(await kodNaLiscie(a, '602000000000000000000017', 'skan')).toEqual({ typ: 'otworz', orderId: o1, adres: `/zamowienia/${o1}?po=p.602000000000000000000017` })
    expect(await kodNaLiscie(a, kod, 'skan')).toEqual({ typ: 'otworz', orderId: o1, adres: `/zamowienia/${o1}?po=k.${encodeURIComponent(kod)}` })
    expect(await kodNaLiscie(a, 'NIEZNANE-1', 'skan')).toMatchObject({ typ: 'komunikat', ton: 'blad' })
  })

  it.each([
    ['#48213'],
    ['Zamówienie nr 48213.'],
    ['nr 48213'],
    [' 48213 '],
    ['Zapłata za zamówienie nr 48213, kwota 120,50 zł, 16.11.2026'],
    ['WZ-2026-77'],
    ['Przelew za zamówienie WZ-2026-77 sklep'],
  ])('wklejenie „%s” otwiera jedno zamówienie', async (tekst) => {
    const o1 = await zamowienie(a, '48213')
    const woo = await zamowienie(a, '9001', { channelNumber: 'WZ-2026-77', kanal: 'WOO_LAMPY' })
    const w = await kodNaLiscie(a, tekst, 'wklej')
    expect(w).toEqual(tekst.includes('WZ') ? { typ: 'otworz', orderId: woo, adres: `/zamowienia/${woo}?po=n.WZ-2026-77` } : { typ: 'otworz', orderId: o1, adres: `/zamowienia/${o1}?po=n.48213` })
  })

  it('wklejenie numeru z przedrostkiem z listy i numeru nadania', async () => {
    const o1 = await zamowienie(a, '48213')
    await przesylka(a, o1, '602000000000000000000017')
    expect(await kodNaLiscie(a, await numerNaLiscie(a, o1), 'wklej')).toMatchObject({ typ: 'otworz', orderId: o1 })
    expect(await kodNaLiscie(a, 'Numer przesyłki: 602000000000000000000017', 'wklej')).toMatchObject({ typ: 'otworz', orderId: o1, adres: expect.stringContaining('po=p.602000000000000000000017') })
  })

  it('wieloznaczne albo brak trafienia = zwykłe filtrowanie (bez otwierania)', async () => {
    await zamowienie(a, '50001', { kanal: 'WOO_SD' })
    await zamowienie(a, '50001', { kanal: 'WOO_LAMPY' })
    await zamowienie(a, '50002')
    expect(await kodNaLiscie(a, '50001', 'wklej')).toEqual({ typ: 'filtruj' })
    expect(await kodNaLiscie(a, 'Przelew za zamówienia 50001 i 50002', 'wklej')).toEqual({ typ: 'filtruj' })
    expect(await kodNaLiscie(a, 'Kowalski', 'wklej')).toEqual({ typ: 'filtruj' })
    expect(await kodNaLiscie(a, '50001', 'skan')).toMatchObject({ typ: 'komunikat', tekst: expect.stringMatching(/pasuje do 2 zamówień/) })
  })

  it('„Faktura 45210, zamówienie 990017, Kowalski” nie otwiera 45210, gdy 990017 nie ma w bazie', async () => {
    const inne = await zamowienie(a, '45210')
    const tekst = 'Faktura 45210, zamówienie 990017, Kowalski'
    expect(await kodNaLiscie(a, tekst, 'wklej')).toEqual({ typ: 'filtruj' })
    expect(await kodNaLiscie(a, 'Przelew od Jana 45210 za towar', 'wklej')).toEqual({ typ: 'filtruj' })
    // ten sam numer z kontekstem albo wklejony sam dalej otwiera
    expect(await kodNaLiscie(a, 'Faktura 1/11, zamówienie 45210, Kowalski', 'wklej')).toMatchObject({ typ: 'otworz', orderId: inne, adres: `/zamowienia/${inne}?po=n.45210` })
    expect(await kodNaLiscie(a, '45210', 'wklej')).toMatchObject({ typ: 'otworz', orderId: inne })
  })

  it('Enter w „Szukaj”: dokładny numer albo numer nadania jednego zamówienia otwiera kartę, reszta filtruje', async () => {
    const o1 = await zamowienie(a, '48213')
    await zamowienie(a, '50001', { kanal: 'WOO_SD' })
    await zamowienie(a, '50001', { kanal: 'WOO_LAMPY' })
    await przesylka(a, o1, '1000000000017U')
    expect(await zamowienieZFrazy(a, '48213')).toMatchObject({ orderId: o1, przez: 'numer', trafienie: '48213' })
    expect(await zamowienieZFrazy(a, '1000000000017U')).toMatchObject({ orderId: o1, przez: 'przesylka', trafienie: '1000000000017U' })
    expect(await zamowienieZFrazy(a, '50001')).toBeNull()
    expect(await zamowienieZFrazy(a, '4821')).toBeNull() // fragment numeru: filtrowanie
    expect(await zamowienieZFrazy(a, 'SKU-48213')).toBeNull()
    expect(await zamowienieZFrazy(a, '%0061000' + '1000000000017U' + '101616')).toBeNull() // bez fragmentów w szukaniu
  })

  it('goły numer od 5 cyfr, a przy szukaniu w danych klientów bez skoku', async () => {
    const krotki = await zamowienie(a, '1234')
    const o1 = await zamowienie(a, '48213')
    expect(await zamowienieZFrazy(a, '1234')).toBeNull()
    expect(await zamowienieZFrazy(a, 'nr 1234')).toBeNull()
    expect(await zamowienieZFrazy(a, `${(await numerNaLiscie(a, krotki)).replace(/\d+$/, '')}1234`)).toMatchObject({ orderId: krotki })
    expect(await zamowienieZFrazy(a, '48213', { klienci: true })).toBeNull()
    expect(await zamowienieZFrazy(a, '48213', { klienci: false })).toMatchObject({ orderId: o1 })
  })
})
