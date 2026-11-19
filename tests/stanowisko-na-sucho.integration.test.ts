// stanowisko pakowania „na sucho”.
//  1. ćwiczenie nie zmienia rdzenia: Order (status, flags), Reservation, Stock, Shortage, PendingMovement, InvoiceAttempt
//     (i pozostałe tabele rdzenia) identyczne przed i po; zapis tylko w PackDrill / PackDrillFix / OrderCardPrint;
//  2. karta nieaktualna po ponownym wydruku i po zmianie pozycji w kanale; anulowane, „Do wyjaśnienia”, brak, PRACA;
//  3. izolacja dwóch firm (RLS): kod karty firmy B w firmie A = nieznany kod, rejestry i listy osobno;
//  4. dostęp: POST /api/wydruki/karty bez sesji = 401, bez uprawnienia = 404, magazyn = PDF.
// Dane wyłącznie testowe (zmyślone produkty, numery zamówień i adresy e-mail w domenie .test).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createUser, grantMembership, login } from '@/lib/auth/sesje'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { gabarytyDla } from '@/lib/stanowisko/gabaryty'
import { drukujKarty } from '@/lib/stanowisko/karty'
import {
  cofnietePoPoprawie,
  cofnijBrak,
  doPoprawy,
  naPolceNieBylo,
  otworzZSesji,
  raportDnia,
  rozpoznajSkan,
  sesjaZamowien,
  sprawdzSkan,
  zakonczCwiczenie,
  zamknijDoPoprawy,
  type WynikSkanu,
} from '@/lib/stanowisko/cwiczenie'
import { nastepneWSesji, podsumowanieSesji } from '@/lib/stanowisko/sesja'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { bundle, order, product, seedBase } from './rdzen-fixtures'

// Trasa API bierze sesję z ciasteczka (next/headers) i klientów z lib/db (systemPrisma, prismaForOrg) — w teście
// ciasteczko podstawiamy, a klienci łączą się z bazą testów (zmienne ustawione przed pierwszym użyciem).
let ciasteczko: string | undefined
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (_n: string) => (ciasteczko ? { value: ciasteczko } : undefined) }),
  headers: async () => new Headers(),
}))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Magazyn Testowy' }
const PASS = 'haslo-testowe-0001'

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

/** Stan rdzenia firmy (wszystko, czego ćwiczenie NIE może zmienić), do porównania przed/po. */
async function stanRdzenia(db: PrismaClient) {
  const byId = { orderBy: { id: 'asc' as const } }
  return JSON.stringify({
    orders: await db.order.findMany(byId),
    lines: await db.orderLine.findMany(byId),
    reservations: await db.reservation.findMany(byId),
    stocks: await db.stock.findMany({ orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }] }),
    shortages: await db.shortage.findMany(byId),
    pending: await db.pendingMovement.findMany(byId),
    invoices: await db.invoiceAttempt.findMany(byId),
    movements: await db.stockMovement.findMany(byId),
    events: await db.orderEvent.findMany(byId),
    outbox: await db.outboxEvent.findMany(byId),
    syncJobs: await db.stockSyncJob.findMany({ orderBy: { offerId: 'asc' } }),
    alerts: await db.alert.findMany(byId),
    jobs: await db.job.findMany(byId),
    products: await db.product.findMany(byId),
    returns: await db.return.findMany(byId),
    returnLines: await db.returnLine.findMany(byId),
    wfirmaQueue: await db.wfirmaQueueState.findMany({ orderBy: { organizationId: 'asc' } }),
  })
}

function ok(w: WynikSkanu): Extract<WynikSkanu, { typ: 'ok' }> {
  if (w.typ !== 'ok') throw new Error(`oczekiwane ok, jest: ${w.blokada.rodzaj} — ${w.blokada.komunikat}`)
  return w
}

async function zamowienie(db: PrismaClient, externalId: string, lines: Parameters<typeof order>[0], over: Parameters<typeof order>[1] = {}) {
  const r = await ingestOrder(db, order(lines, { externalId, createdAtChannel: new Date(), ...over }))
  return r.orderId!
}

describe('ćwiczenie na sucho nie zmienia rdzenia', () => {
  it('druk, skan, „na półce nie było”, spakowano i nie spakowano: rdzeń bez zmian, zapis tylko ćwiczenia', async () => {
    const p1 = await product(a, 'HERB-1', 10)
    const p2 = await product(a, 'HERB-2', 5)
    const p3 = await product(a, 'KUBEK', 4)
    await a.stock.updateMany({ where: { productId: p1 }, data: { location: 'B-3-10' } })
    await a.stock.updateMany({ where: { productId: p3 }, data: { location: 'B-3-4' } })
    const zestaw = await bundle(a, 'ZESTAW', [{ id: p3, qty: 2 }])
    const o1 = await zamowienie(a, '48213', [
      { productId: p2, qty: 1 },
      { productId: p1, qty: 2 },
      { productId: zestaw, qty: 1 },
    ])
    const o2 = await zamowienie(a, '48214', [{ productId: p1, qty: 1 }])
    const przed = await stanRdzenia(a)

    const { pdf, wydruki } = await drukujKarty(a, [o2, o1], KTO)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(wydruki.map((w) => w.orderId)).toEqual([o2, o1]) // kolejność jak w `z`
    expect(wydruki.every((w) => w.naSucho && w.printNo === 1)).toBe(true)
    const kod1 = wydruki[1]!.kod
    expect(kod1).toMatch(/^[A-Z]+48213\/1$/)

    // skan z czytnika (AIM + Enter) otwiera zamówienie: pozycje po lokalizacji, zestaw rozbity, bez lokalizacji na końcu
    const w = ok(await rozpoznajSkan(a, `]C1${kod1}\r\n`, KTO))
    expect(w.zamowienie.id).toBe(o1)
    expect(w.zamowienie.tryb).toBe('CIEN')
    expect(w.zamowienie.komentarzKlienta).toBeNull()
    expect(w.zamowienie.pozycje.map((p) => [p.lokalizacja, p.sku, p.ilosc])).toEqual([
      ['B-3-4', 'KUBEK', 2],
      ['B-3-10', 'HERB-1', 2],
      [null, 'HERB-2', 1],
    ])
    const kubek = w.zamowienie.pozycje[0]!
    const herb2 = w.zamowienie.pozycje[2]!
    // ponowne otwarcie tego samego zamówienia przez tę samą osobę = to samo ćwiczenie
    expect(ok(await rozpoznajSkan(a, kod1, KTO)).cwiczenie.drillId).toBe(w.cwiczenie.drillId)

    // „na półce nie było”: od razu na liście „Do poprawy”, zmiana ilości nadpisuje, „Jednak jest” zdejmuje
    const f1 = await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: herb2.klucz, ilosc: 1, userId: KTO.userId })
    expect((await doPoprawy(a)).map((x) => [x.sku, x.ilosc])).toEqual([['HERB-2', 1]])
    const k1 = await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: kubek.klucz, ilosc: 1, userId: KTO.userId })
    await cofnijBrak(a, { drillId: w.cwiczenie.drillId, fixId: k1.fixId, userId: KTO.userId })
    expect((await doPoprawy(a)).map((x) => x.id)).toEqual([f1.fixId])
    // „Jednak jest” nie kasuje: wiersz zostaje w historii jako WITHDRAWN (kto, kiedy)
    expect(await a.packDrillFix.findUniqueOrThrow({ where: { id: k1.fixId } })).toMatchObject({ state: 'WITHDRAWN', withdrawnBy: KTO.userId, withdrawnAt: expect.any(Date), closedBy: null, closedAt: null })
    await expect(naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: herb2.klucz, ilosc: 2, userId: KTO.userId })).rejects.toThrow(/od 1 do 1/)
    // reopen wraca z zapisanym brakiem
    expect(ok(await otworzZSesji(a, o1, null, KTO)).cwiczenie.braki).toEqual([{ fixId: f1.fixId, klucz: herb2.klucz, ilosc: 1 }])

    // „Spakowano” wymaga wszystkiego zebranego (albo brak) i gabarytu przewoźnika
    const gab = gabarytyDla(w.zamowienie.carrier)[0]!
    const zebrane = { [kubek.klucz]: 2, [w.zamowienie.pozycje[1]!.klucz]: 2 }
    await expect(zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gab, zebrane: { [kubek.klucz]: 2 }, userId: KTO.userId })).rejects.toThrow(/Nie wszystko zebrane/)
    await expect(zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: 'NIE-MA', zebrane, userId: KTO.userId })).rejects.toThrow(/gabaryt/)
    await expect(zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gab, zebrane: { ...zebrane, [herb2.klucz]: 1 }, userId: KTO.userId })).rejects.toThrow(/razem więcej/)
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gab, zebrane, userId: KTO.userId })
    await expect(zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })).rejects.toThrow(/już zapisane/)

    // drugie zamówienie: „Nie spakowano” bez gabarytu
    const w2 = ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
    await zakonczCwiczenie(a, { drillId: w2.cwiczenie.drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })

    expect(await stanRdzenia(a)).toBe(przed)
    const drill = await a.packDrill.findUniqueOrThrow({ where: { id: w.cwiczenie.drillId } })
    expect(drill).toMatchObject({ outcome: 'SPAKOWANE', parcelSize: gab, actorId: KTO.userId })
    expect(drill.lines).toEqual(expect.arrayContaining([expect.objectContaining({ p: p2, q: 1, zebrane: 0, brak: 1 })]))

    // ponowny skan: już spakowane w ćwiczeniu; „nie spakowano” można spakować ponownie
    const znow = await rozpoznajSkan(a, kod1, KTO)
    expect(znow.typ === 'blokada' && znow.blokada.rodzaj).toBe('spakowane')
    expect((await rozpoznajSkan(a, wydruki[0]!.kod, KTO)).typ).toBe('ok')

    const r = await raportDnia(a)
    expect(r).toMatchObject({ spakowane: 1, nieSpakowano: 1, brakiPozycji: 1, niezakonczone: 1 })
    expect(r.sredniCzasMs).not.toBeNull()

    // biuro zamyka pozycję listy (zostaje w historii)
    expect(await zamknijDoPoprawy(a, f1.fixId, 'biuro-testowe')).toBe(true)
    expect(await zamknijDoPoprawy(a, f1.fixId, 'biuro-testowe')).toBe(false)
    expect(await doPoprawy(a)).toEqual([])
    expect(await a.packDrillFix.count({ where: { state: 'CLOSED' } })).toBe(1)
    expect(await stanRdzenia(a)).toBe(przed)
  })
})

describe('komunikaty skanu karty', () => {
  it('nieznany kod, karta nieaktualna (nowszy wydruk, zmiana w kanale), anulowane po wydruku', async () => {
    const p1 = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '1001', [{ productId: p1, qty: 2 }])
    for (const s of ['', 'śmieci', '5901234123457', 'SD999999/1']) {
      const w = await rozpoznajSkan(a, s, KTO)
      expect(w.typ === 'blokada' && w.blokada.rodzaj, s).toBe('nieznany')
    }
    const k1 = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    const k2 = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    expect(k2).toBe(k1.replace(/\/1$/, '/2'))
    const stara = await rozpoznajSkan(a, k1, KTO)
    expect(stara.typ === 'blokada' && stara.blokada).toMatchObject({ rodzaj: 'nieaktualna', komunikat: expect.stringContaining('weź kartę nr 2') })
    expect((await rozpoznajSkan(a, k1.replace(/\/1$/, '/3'), KTO)).typ).toBe('blokada') // wydruku 3 nie było
    expect(await a.packDrill.count()).toBe(0)
    expect(ok(await rozpoznajSkan(a, k2, KTO)).zamowienie.id).toBe(o1)

    // pozycje zmienione w kanale po wydruku → karta nieaktualna
    await a.orderLine.updateMany({ where: { orderId: o1 }, data: { qty: 3 } })
    const zm = await rozpoznajSkan(a, k2, KTO)
    expect(zm.typ === 'blokada' && zm.blokada.rodzaj).toBe('zmienione')
    const k3 = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    expect(ok(await rozpoznajSkan(a, k3, KTO)).zamowienie.pozycje[0]!.ilosc).toBe(3)

    // anulowane po wydruku → czerwona karta
    await a.order.update({ where: { id: o1 }, data: { status: 'ANULOWANE' } })
    const an = await rozpoznajSkan(a, k3, KTO)
    expect(an.typ === 'blokada' && an.blokada).toMatchObject({ rodzaj: 'anulowane', czerwona: true, komunikat: expect.stringContaining('odłóż koszyk') })
  })

  it('„Do wyjaśnienia” i brak wszystkiego = czerwona karta „nie pakuj”; konto w PRACY otwiera zamówienie; sprawdzenie bez ćwiczenia', async () => {
    const p1 = await product(a, 'HERB-1', 1)
    const reszta = await zamowienie(a, '2000', [{ productId: p1, qty: 1 }]) // bierze ostatnią sztukę
    const czesc = await zamowienie(a, '2001', [{ productId: p1, qty: 3 }]) // stan 0 → brakuje wszystkiego
    const wyj = await zamowienie(a, '2002', [{ qty: 1 }]) // pozycja bez produktu → Do wyjaśnienia
    expect((await a.order.findUniqueOrThrow({ where: { id: wyj } })).status).toBe('DO_WYJASNIENIA')
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })
    const p2 = await product(a, 'HERB-2', 5)
    const praca = await zamowienie(a, '3001', [{ productId: p2, qty: 1 }], { channel: 'ALLEGRO' })
    const { wydruki } = await drukujKarty(a, [reszta, wyj, praca], KTO)
    expect(wydruki.map((w) => w.naSucho)).toEqual([true, true, false])
    const przed = await stanRdzenia(a)
    expect((await sesjaZamowien(a, [czesc]))[0]).toMatchObject({ czerwona: true, komunikat: expect.stringMatching(/^NIE PAKUJ/) })

    for (const k of [wydruki[1]!.kod]) {
      const w = await rozpoznajSkan(a, k, KTO)
      expect(w.typ === 'blokada' && w.blokada).toMatchObject({ rodzaj: 'nie_pakuj', czerwona: true, komunikat: expect.stringMatching(/^NIE PAKUJ/) })
    }
    const wp = await rozpoznajSkan(a, wydruki[2]!.kod, KTO)
    expect(wp.typ === 'ok' && wp.zamowienie.tryb).toBe('PRACA')
    expect(await a.packDrill.count()).toBe(1)
    await a.packDrill.deleteMany()

    // skan w trakcie pakowania innego zamówienia: tylko sprawdzenie, ćwiczenie powstaje dopiero przy otwarciu
    const p3 = await product(a, 'HERB-3', 5)
    const o3 = await zamowienie(a, '2003', [{ productId: p3, qty: 1 }])
    const k3 = (await drukujKarty(a, [o3], KTO)).wydruki[0]!
    const s = await sprawdzSkan(a, k3.kod)
    expect(s.typ).toBe('do_sesji')
    expect(await a.packDrill.count()).toBe(0)
    const otw = ok(await otworzZSesji(a, o3, s.typ === 'do_sesji' ? s.karta.printId : null, KTO))
    expect((await a.packDrill.findUniqueOrThrow({ where: { id: otw.cwiczenie.drillId } })).printId).toBe(s.typ === 'do_sesji' ? s.karta.printId : 'x')
    // zamówienia sprzed (blokady) bez zmian; o3 doszło później, a zamówienie w PRACY otwarcie okna wprowadza w zbieranie
    const po = JSON.parse(await stanRdzenia(a)) as { orders: { id: string; status: string }[]; reservations: { orderId: string }[] }
    const bez = (l: { id: string }[]) => l.filter((o) => o.id !== o3 && o.id !== praca)
    expect(bez(po.orders)).toEqual(bez(JSON.parse(przed).orders))
    expect(po.orders.find((o) => o.id === praca)?.status).toBe('ZBIERANIE')
    expect(po.reservations.filter((r) => r.orderId !== o3)).toEqual(JSON.parse(przed).reservations)
  })

  it('zamówienie bez numeru liczbowego (UUID Allegro bez numeru BL) = karta odmówiona z komunikatem; numer BL wystarcza', async () => {
    const p1 = await product(a, 'HERB-1', 5)
    const uuid = '3f2c1a9e-7b4d-4e1a-9c0b-1d2e3f4a5b6c'
    const o = await zamowienie(a, uuid, [{ productId: p1, qty: 1 }], { channel: 'ALLEGRO' })
    await expect(drukujKarty(a, [o], KTO)).rejects.toMatchObject({ status: 422 })
    await a.order.update({ where: { id: o }, data: { blOrderId: 9123456 } })
    expect((await drukujKarty(a, [o], KTO)).wydruki[0]!.kod).toMatch(/9123456\/1$/)
    await expect(drukujKarty(a, Array.from({ length: 101 }, (_, i) => `x${i}`), KTO)).rejects.toMatchObject({ status: 400 })

    // dosyłka („dośle później”): numer zamówienia głównego + numer paczki, skan rozpoznaje podzamówienie
    const glowne = await zamowienie(a, '6001', [{ productId: p1, qty: 1 }])
    const g = await a.order.findUniqueOrThrow({ where: { id: glowne } })
    const dos = await a.order.create({
      data: { channel: g.channel, channelAccountId: g.channelAccountId, externalId: '6001/2', parentOrderId: glowne, packageNo: 2, status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: 0, createdAtChannel: new Date(), carrier: g.carrier },
    })
    await a.orderLine.create({ data: { orderId: dos.id, externalLineId: 'L1', productId: p1, qty: 1, unitPriceGross: 10 } })
    const kd = (await drukujKarty(a, [dos.id], KTO)).wydruki[0]!.kod
    expect(kd).toMatch(/6001-2\/1$/)
    const w = ok(await rozpoznajSkan(a, kd, KTO))
    expect(w.zamowienie).toMatchObject({ id: dos.id, numer: expect.stringMatching(/ 6001-2$/) })
  })

  it('wysłane, odebrane i anulowane nie dostają karty (serwer): pominięte z numerem, same takie = 422', async () => {
    const p1 = await product(a, 'HERB-1', 9)
    const dobre = await zamowienie(a, '7101', [{ productId: p1, qty: 1 }])
    const pominiete: string[] = []
    for (const [i, status] of (['WYSLANE', 'ODEBRANE', 'ANULOWANE'] as const).entries()) {
      const id = await zamowienie(a, `720${i}`, [{ productId: p1, qty: 1 }])
      await a.order.update({ where: { id }, data: { status } })
      pominiete.push(id)
    }
    const { wydruki, pominiete: bez } = await drukujKarty(a, [dobre, ...pominiete], KTO)
    expect(wydruki.map((w) => w.orderId)).toEqual([dobre])
    expect(bez.map((p) => p.orderId)).toEqual(pominiete)
    expect(await a.orderCardPrint.count({ where: { orderId: { in: pominiete } } })).toBe(0)
    await expect(drukujKarty(a, pominiete, KTO)).rejects.toMatchObject({ status: 422 })
  })

  it('numer Empik z sufiksem na ekranie w całości, UUID skrócony; sesja z kolejki: czeka, NIE PAKUJ, czeka', async () => {
    const p1 = await product(a, 'HERB-1', 9)
    const o1 = await zamowienie(a, '4010242836293-A', [{ productId: p1, qty: 1 }], { channel: 'EMPIK' })
    const o2 = await zamowienie(a, '7301', [{ productId: p1, qty: 1 }])
    const o3 = await zamowienie(a, '9b21a0c4-44e0-4b1a-9d1e-0123456789ab', [{ productId: p1, qty: 1 }], { channel: 'ALLEGRO' })
    await a.order.update({ where: { id: o2 }, data: { status: 'DO_WYJASNIENIA' } })
    const sesja = await sesjaZamowien(a, [o1, o2, o3])
    expect(sesja.map((s) => s.stan)).toEqual(['czeka', 'blokada', 'czeka'])
    expect(sesja[1]).toMatchObject({ czerwona: true, komunikat: expect.stringContaining('NIE PAKUJ') })
    expect(sesja[0]!.numer).toMatch(/4010242836293-A$/)
    expect(sesja[2]!.numer).toMatch(/9b21a0c4-…$/)
  })

  it('odświeżenie sesji: „Nie spakowano” nie wraca jako „czeka”, „na półce nie było” zostaje, cofnięty brak nie', async () => {
    const p1 = await product(a, 'HERB-1', 9)
    const nieSpak = await zamowienie(a, '7401', [{ productId: p1, qty: 1 }])
    const zBrakiem = await zamowienie(a, '7402', [{ productId: p1, qty: 2 }])
    const cofniety = await zamowienie(a, '7403', [{ productId: p1, qty: 1 }])
    const czeka = await zamowienie(a, '7404', [{ productId: p1, qty: 1 }])
    const zapisz = async (orderId: string, wynik: 'SPAKOWANE' | 'NIE_SPAKOWANO', brak: 'zostaje' | 'cofniety' | null) => {
      const w = ok(await otworzZSesji(a, orderId, null, KTO))
      const poz = w.zamowienie.pozycje[0]!
      const f = brak ? await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: poz.klucz, ilosc: 1, userId: KTO.userId }) : null
      if (f && brak === 'cofniety') await cofnijBrak(a, { drillId: w.cwiczenie.drillId, fixId: f.fixId, userId: KTO.userId })
      const zebrane = wynik === 'SPAKOWANE' ? { [poz.klucz]: poz.ilosc - (brak === 'zostaje' ? 1 : 0) } : {}
      await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik, gabaryt: wynik === 'SPAKOWANE' ? gabarytyDla(w.zamowienie.carrier)[0]! : null, zebrane, uwagiOdhaczone: true, userId: KTO.userId })
    }
    await zapisz(nieSpak, 'NIE_SPAKOWANO', 'zostaje')
    await zapisz(zBrakiem, 'SPAKOWANE', 'zostaje')
    await zapisz(cofniety, 'NIE_SPAKOWANO', 'cofniety')
    const sesja = await sesjaZamowien(a, [nieSpak, zBrakiem, cofniety, czeka])
    expect(sesja.map((s) => [s.stan, s.zBrakiem ?? false])).toEqual([
      ['nie_spakowano', true],
      ['spakowane', true],
      ['nie_spakowano', false],
      ['czeka', false],
    ])
    expect(nastepneWSesji(sesja, null)?.id).toBe(czeka)
    expect(podsumowanieSesji(sesja)).toEqual({ spakowane: 0, zBrakiem: 2, pominiete: 2 })
    // ręczne ponowne otwarcie „Nie spakowano” z listy nadal działa: nowe ćwiczenie
    expect(ok(await otworzZSesji(a, nieSpak, null, KTO)).zamowienie.id).toBe(nieSpak)
  })
})

describe('produkt bez stanu (e-book) nie jest do zebrania', () => {
  it('pozycja DIGITAL poza kartą i oknem; zamówienie z samym e-bookiem = „nie ma czego pakować”, bez zapisu ćwiczenia', async () => {
    const herb = await product(a, 'HERB-E', 10)
    const ebook = (await a.product.create({ data: { sku: 'EBOOK-1', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book testowy', title: 'E-book testowy', vatRate: '5' } })).id
    const mieszane = await zamowienie(a, '48301', [
      { productId: ebook, qty: 1 },
      { productId: herb, qty: 2 },
    ])
    const sam = await zamowienie(a, '48302', [{ productId: ebook, qty: 1 }])
    // karta: zamówienie z samym e-bookiem pominięte (bez wpisu w rejestrze), samo w żądaniu = 422
    const { wydruki, pominiete } = await drukujKarty(a, [mieszane, sam], KTO)
    expect(wydruki.map((x) => x.orderId)).toEqual([mieszane])
    expect(pominiete).toEqual([{ orderId: sam, numer: expect.stringMatching(/48302$/) }])
    await expect(drukujKarty(a, [sam], KTO)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/nie ma czego drukować/) })
    expect(await a.orderCardPrint.count({ where: { orderId: sam } })).toBe(0)
    const w = ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
    expect(w.zamowienie.pozycje.map((p) => [p.sku, p.ilosc])).toEqual([['HERB-E', 2]])
    const tylko = await otworzZSesji(a, sam, null, KTO)
    expect(tylko.typ).toBe('blokada')
    if (tylko.typ === 'blokada') expect(tylko.blokada.komunikat).toMatch(/nie ma czego pakować/)
    expect(await a.packDrill.count({ where: { orderId: sam } })).toBe(0)
  })
})

describe('„Na półce nie było” zamknięte przez biuro w trakcie ćwiczenia', () => {
  it('„Spakowano” przechodzi, ponowne otwarcie widzi brak, zmiana ilości bez drugiego wiersza; „Jednak jest” zostawia wiersz', async () => {
    const p1 = await product(a, 'HERB-1', 10)
    const p2 = await product(a, 'HERB-2', 5)
    const o1 = await zamowienie(a, '48401', [
      { productId: p1, qty: 2 },
      { productId: p2, qty: 2 },
    ])
    const przed = await stanRdzenia(a)
    const kod = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    const w = ok(await rozpoznajSkan(a, kod, KTO))
    const [l1, l2] = [w.zamowienie.pozycje.find((p) => p.sku === 'HERB-1')!, w.zamowienie.pozycje.find((p) => p.sku === 'HERB-2')!]
    const f = await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: l2.klucz, ilosc: 1, userId: KTO.userId })

    // biuro poprawia stan w wFirmie, zanim magazyn skończy
    expect(await zamknijDoPoprawy(a, f.fixId, 'biuro-testowe')).toBe(true)
    expect(await doPoprawy(a)).toEqual([])
    // ponowne otwarcie okna nadal pokazuje brak
    expect(ok(await otworzZSesji(a, o1, null, KTO)).cwiczenie.braki).toEqual([{ fixId: f.fixId, klucz: l2.klucz, ilosc: 1 }])
    // ponowny zapis „na półce nie było” na tej pozycji nie zakłada drugiego wiersza obok zamkniętego
    expect((await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: l2.klucz, ilosc: 1, userId: KTO.userId })).fixId).toBe(f.fixId)
    // inna ilość na wierszu zamkniętym przez biuro: odmowa, wiersz biura bez zmian
    await expect(naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: l2.klucz, ilosc: 2, userId: KTO.userId })).rejects.toThrow(/zgłoś biuru/)
    expect(await a.packDrillFix.findUniqueOrThrow({ where: { id: f.fixId } })).toMatchObject({ state: 'CLOSED', qtyBase: 1, closedBy: 'biuro-testowe' })
    expect(await a.packDrillFix.count()).toBe(1)

    const gab = gabarytyDla(w.zamowienie.carrier)[0]!
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gab, zebrane: { [l1.klucz]: 2, [l2.klucz]: 1 }, userId: KTO.userId })
    const d = await a.packDrill.findUniqueOrThrow({ where: { id: w.cwiczenie.drillId } })
    expect(d.outcome).toBe('SPAKOWANE')
    expect(d.lines).toEqual(expect.arrayContaining([expect.objectContaining({ p: p2, q: 2, zebrane: 1, brak: 1 })]))
    expect((await raportDnia(a)).brakiPozycji).toBe(1)
    expect(await stanRdzenia(a)).toBe(przed)
  })

  it('„Jednak jest” na pozycji zamkniętej przez biuro: wiersz WITHDRAWN, brak przestaje się liczyć (ćwiczenie i raport)', async () => {
    const p1 = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '48402', [{ productId: p1, qty: 2 }])
    const kod = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    const w = ok(await rozpoznajSkan(a, kod, KTO))
    const l1 = w.zamowienie.pozycje[0]!
    const f = await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: l1.klucz, ilosc: 1, userId: KTO.userId })
    await zamknijDoPoprawy(a, f.fixId, 'biuro-testowe')
    await cofnijBrak(a, { drillId: w.cwiczenie.drillId, fixId: f.fixId, userId: KTO.userId })
    expect(await a.packDrillFix.findUniqueOrThrow({ where: { id: f.fixId } })).toMatchObject({ state: 'WITHDRAWN', closedBy: 'biuro-testowe', closedAt: expect.any(Date), withdrawnBy: KTO.userId, withdrawnAt: expect.any(Date) })
    expect(ok(await otworzZSesji(a, o1, null, KTO)).cwiczenie.braki).toEqual([])
    expect((await raportDnia(a)).brakiPozycji).toBe(0)
    // cofnięty brak nie zastępuje zbierania: 1 z 2 to dalej „nie wszystko zebrane”
    const gab = gabarytyDla(w.zamowienie.carrier)[0]!
    await expect(zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gab, zebrane: { [l1.klucz]: 1 }, userId: KTO.userId })).rejects.toThrow(/Nie wszystko zebrane/)
    // ponowne „na półce nie było” zakłada nowy wiersz (stary zostaje WITHDRAWN)
    const f2 = await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: l1.klucz, ilosc: 1, userId: KTO.userId })
    expect(f2.fixId).not.toBe(f.fixId)
    expect((await doPoprawy(a)).map((x) => x.id)).toEqual([f2.fixId])
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gab, zebrane: { [l1.klucz]: 1 }, userId: KTO.userId })
  })
})

describe('jednostki w komunikatach i „Cofnięte na stanowisku po poprawie”', () => {
  it('towar na wagę: „Ilość od 1 do N g” i „Biuro już poprawiło… (N g)”; sztuki bez jednostki', async () => {
    const przyprawa = await product(a, 'SYPANA-1', 5000, { unit: 'KG' })
    const kubek = await product(a, 'KUBEK-1', 10)
    const o1 = await zamowienie(a, '48501', [
      { productId: przyprawa, qty: 250 },
      { productId: kubek, qty: 2 },
    ])
    const kod = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    const w = ok(await rozpoznajSkan(a, kod, KTO))
    const h = w.zamowienie.pozycje.find((p) => p.sku === 'SYPANA-1')!
    const k = w.zamowienie.pozycje.find((p) => p.sku === 'KUBEK-1')!
    expect(h.jednostka).toBe('g')
    await expect(naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: h.klucz, ilosc: 251, userId: KTO.userId })).rejects.toThrow('Ilość od 1 do 250 g')
    await expect(naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: k.klucz, ilosc: 3, userId: KTO.userId })).rejects.toThrow(/^Ilość od 1 do 2$/)
    const f = await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: h.klucz, ilosc: 100, userId: KTO.userId })
    await zamknijDoPoprawy(a, f.fixId, 'biuro-testowe')
    await expect(naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: h.klucz, ilosc: 50, userId: KTO.userId })).rejects.toThrow('Biuro już poprawiło tę pozycję w wFirmie (100 g)')
  })

  it('sekcja: tylko WITHDRAWN zamknięte wcześniej przez biuro, z ostatnich 7 dni, najnowsze pierwsze; firma B nie widzi', async () => {
    const p1 = await product(a, 'HERB-1', 10)
    const p2 = await product(a, 'HERB-2', 10)
    const p3 = await product(a, 'HERB-3', 10)
    const o1 = await zamowienie(a, '48502', [
      { productId: p1, qty: 2 },
      { productId: p2, qty: 2 },
      { productId: p3, qty: 2 },
    ])
    const kod = (await drukujKarty(a, [o1], KTO)).wydruki[0]!.kod
    const w = ok(await rozpoznajSkan(a, kod, KTO))
    const poz = (sku: string) => w.zamowienie.pozycje.find((p) => p.sku === sku)!.klucz
    const drillId = w.cwiczenie.drillId
    const teraz = new Date()
    const godzinePrzed = new Date(teraz.getTime() - 3600_000)

    // HERB-1: biuro zamyka, stanowisko cofa → w sekcji
    const f1 = await naPolceNieBylo(a, { drillId, klucz: poz('HERB-1'), ilosc: 1, userId: KTO.userId })
    await zamknijDoPoprawy(a, f1.fixId, 'biuro-testowe', godzinePrzed)
    await cofnijBrak(a, { drillId, fixId: f1.fixId, userId: KTO.userId }, godzinePrzed)
    // HERB-2: cofnięte bez poprawy biura → nie w sekcji (wFirma nietknięta)
    const f2 = await naPolceNieBylo(a, { drillId, klucz: poz('HERB-2'), ilosc: 1, userId: KTO.userId })
    await cofnijBrak(a, { drillId, fixId: f2.fixId, userId: KTO.userId })
    // HERB-3: zamknięte przez biuro, nie cofnięte → nie w sekcji
    const f3 = await naPolceNieBylo(a, { drillId, klucz: poz('HERB-3'), ilosc: 2, userId: KTO.userId })
    await zamknijDoPoprawy(a, f3.fixId, 'biuro-testowe')
    // HERB-1 drugi raz: nowy wiersz, zamknięty i cofnięty teraz → w sekcji, przed starszym
    const f4 = await naPolceNieBylo(a, { drillId, klucz: poz('HERB-1'), ilosc: 2, userId: KTO.userId })
    await zamknijDoPoprawy(a, f4.fixId, 'biuro-testowe', teraz)
    await cofnijBrak(a, { drillId, fixId: f4.fixId, userId: KTO.userId }, teraz)

    const lista = await cofnietePoPoprawie(a, teraz)
    expect(lista.map((x) => [x.id, x.sku, x.ilosc, x.unit])).toEqual([
      [f4.fixId, 'HERB-1', 2, 'SZT'],
      [f1.fixId, 'HERB-1', 1, 'SZT'],
    ])
    expect(lista[0]).toMatchObject({ orderId: o1, productId: p1, closedAt: teraz, withdrawnAt: teraz })
    // po 7 dniach od cofnięcia wypada z sekcji
    const za7dni = new Date(godzinePrzed.getTime() + 7 * 24 * 3600_000 + 1000)
    expect((await cofnietePoPoprawie(a, za7dni)).map((x) => x.id)).toEqual([f4.fixId])
    // RLS: firma B nie widzi wierszy firmy A
    expect(await cofnietePoPoprawie(b, teraz)).toEqual([])
  })
})

describe('izolacja dwóch firm (RLS)', () => {
  it('kod karty firmy B w firmie A = nieznany; rejestry, ćwiczenia i lista „Do poprawy” osobno', async () => {
    const pa = await product(a, 'WSPOLNY', 5)
    const pb = await product(b, 'WSPOLNY', 5)
    const oa = await zamowienie(a, '48213', [{ productId: pa, qty: 1 }])
    const ob = await zamowienie(b, '48213', [{ productId: pb, qty: 1 }]) // ten sam numer i konto w obu firmach
    const ob2 = await zamowienie(b, '77777', [{ productId: pb, qty: 1 }])
    const ka = (await drukujKarty(a, [oa], KTO)).wydruki[0]!.kod
    const [kb, kb2] = (await drukujKarty(b, [ob, ob2], KTO)).wydruki.map((w) => w.kod)
    expect(kb).toBe(ka) // te same kody w dwóch firmach to dwie różne karty
    expect(ok(await rozpoznajSkan(a, kb!, KTO)).zamowienie.id).toBe(oa)
    const obca = await rozpoznajSkan(a, kb2!, KTO)
    expect(obca.typ === 'blokada' && obca.blokada.rodzaj).toBe('nieznany')
    expect(obca.typ === 'blokada' && obca.zamowienie).toBeNull()
    // id zamówienia innej firmy: jak nieistniejące
    await expect(drukujKarty(a, [ob2], KTO)).rejects.toMatchObject({ status: 404 })
    expect((await otworzZSesji(a, ob2, null, KTO)).typ).toBe('blokada')

    const wb = ok(await rozpoznajSkan(b, kb2!, KTO))
    await naPolceNieBylo(b, { drillId: wb.cwiczenie.drillId, klucz: wb.zamowienie.pozycje[0]!.klucz, ilosc: 1, userId: 'b' })
    // drillId firmy B w firmie A nie istnieje
    await expect(naPolceNieBylo(a, { drillId: wb.cwiczenie.drillId, klucz: wb.zamowienie.pozycje[0]!.klucz, ilosc: 1, userId: 'a' })).rejects.toThrow(/Nieznane ćwiczenie/)
    expect(await doPoprawy(a)).toEqual([])
    expect(await doPoprawy(b)).toHaveLength(1)
    expect(await a.orderCardPrint.count()).toBe(1)
    expect(await b.orderCardPrint.count()).toBe(2)
    expect(await a.packDrill.count()).toBe(1)
    expect(await b.packDrill.count()).toBe(1)
    // zapis z cudzą firmą odrzucony przez politykę
    await expect(a.orderCardPrint.create({ data: { organizationId: ORG_B, orderId: ob, orderCode: 'X1', printNo: 9, printedBy: 'a', dryRun: true, lines: [] } })).rejects.toThrow()
    // przez wszystkie firmy (klient systemowy): wiersze nie wskazują zamówień innej firmy
    const przecieki = await sys.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM (
        SELECT x."organizationId" AS a, o."organizationId" AS b FROM "OrderCardPrint" x JOIN "Order" o ON o.id = x."orderId"
        UNION ALL SELECT x."organizationId", o."organizationId" FROM "PackDrill" x JOIN "Order" o ON o.id = x."orderId"
        UNION ALL SELECT x."organizationId", p."organizationId" FROM "PackDrillFix" x JOIN "Product" p ON p.id = x."productId"
      ) t WHERE a <> b`
    expect(Number(przecieki[0]!.n)).toBe(0)
  })
})

describe('POST /api/wydruki/karty: sesja i uprawnienie', () => {
  it('bez sesji 401, bez uprawnienia 404, magazyn dostaje PDF z rejestrem; za dużo zamówień 400', async () => {
    const trasa = await import('@/app/api/wydruki/karty/route')
    const { POST } = trasa
    // tylko POST z formularza: F5 albo przywrócona karta nie drukuje ponownie
    expect('GET' in trasa).toBe(false)
    const p1 = await product(a, 'HERB-1', 5)
    const o1 = await zamowienie(a, '5001', [{ productId: p1, qty: 1 }])
    const form = (q: string) => new URLSearchParams({ z: q })
    const req = (q: string, headers: Record<string, string> = {}) =>
      new NextRequest('http://localhost/api/wydruki/karty', { method: 'POST', body: form(q), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } })

    ciasteczko = undefined
    expect((await POST(req(o1))).status).toBe(401)
    ciasteczko = 'zmyslony-token-sesji'
    expect((await POST(req(o1))).status).toBe(401)

    await createUser(sys, { email: 'biuro@firma-a.test', name: 'Biuro A', password: PASS })
    await grantMembership(sys, { email: 'biuro@firma-a.test', organizationId: ORG_A, role: 'BIURO' })
    await createUser(sys, { email: 'magazyn@firma-a.test', name: 'Magazyn A', password: PASS })
    await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_A, role: 'MAGAZYN' })
    const token = async (email: string) => {
      const r = await login(sys, email, PASS)
      if (!r.ok) throw new Error(r.reason)
      return r.token
    }
    ciasteczko = await token('biuro@firma-a.test')
    expect((await POST(req(o1))).status).toBe(404)
    expect(await a.orderCardPrint.count()).toBe(0)

    ciasteczko = await token('magazyn@firma-a.test')
    const r = await POST(req(`${o1},${o1}`))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(r.headers.get('x-karty')).toMatch(/5001\/1$/)
    const wpis = await a.orderCardPrint.findFirstOrThrow({ where: { orderId: o1 } })
    expect(wpis.dryRun).toBe(true)
    const u = await sys.user.findUniqueOrThrow({ where: { email: 'magazyn@firma-a.test' } })
    expect(wpis.printedBy).toBe(u.id)
    expect((await POST(req(''))).status).toBe(400)
    // żądanie z obcej strony: 403, bez nowego numeru wydruku
    const obca = req(o1, { 'sec-fetch-site': 'cross-site' })
    const r403 = await POST(obca)
    expect(r403.status).toBe(403)
    expect(await a.orderCardPrint.count({ where: { orderId: o1 } })).toBe(1)
    // inna subdomena tej samej witryny (np. strona produktu): też 403
    expect((await POST(req(o1, { 'sec-fetch-site': 'same-site' }))).status).toBe(403)
    expect(await a.orderCardPrint.count({ where: { orderId: o1 } })).toBe(1)
    const tenSam = req(o1, { 'sec-fetch-site': 'same-origin' })
    expect((await POST(tenSam)).status).toBe(200)
    expect((await POST(req(Array.from({ length: 101 }, (_, i) => `id${i}`).join(',')))).status).toBe(400)
    ciasteczko = undefined
  })
})

describe('stanowisko w trybie pracy, zamówienie z fakturą z BaseLinkera', () => {
  it('skan karty: czerwona karta „NIE PAKUJ” z numerem faktury, bez otwarcia ćwiczenia', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })
    const p = await product(a, 'HERB-FBS', 5)
    const id = await zamowienie(a, '3102', [{ productId: p, qty: 1 }], { channel: 'ALLEGRO' })
    await a.order.update({ where: { id }, data: { blOrderId: 3102 } })
    await a.orderEvent.create({ data: { orderId: id, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 32/11' } } })
    const kod = (await drukujKarty(a, [id], KTO)).wydruki[0]!.kod
    const w = await rozpoznajSkan(a, kod, KTO)
    expect(w).toMatchObject({ typ: 'blokada', blokada: { rodzaj: 'nie_pakuj', czerwona: true } })
    expect(w.typ === 'blokada' && w.blokada.komunikat).toContain('FV 32/11 z BaseLinkera')
    expect(await a.packDrill.count({ where: { orderId: id } })).toBe(0)
  })

  it('„Spakowano” odmawia z procedurą (faktura po otwarciu okna); zapis ćwiczenia wycofany, zamówienie nie jest spakowane', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })
    const p = await product(a, 'HERB-FBL', 5)
    const id = await zamowienie(a, '3101', [{ productId: p, qty: 1 }], { channel: 'ALLEGRO' })
    await a.order.update({ where: { id }, data: { blOrderId: 3101 } })
    const kod = (await drukujKarty(a, [id], KTO)).wydruki[0]!.kod
    const w = ok(await rozpoznajSkan(a, kod, KTO))
    expect(w.zamowienie.tryb).toBe('PRACA')
    await a.orderEvent.create({ data: { orderId: id, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 31/11' } } })
    const gab = gabarytyDla(w.zamowienie.carrier)[0]!
    const zebrane = Object.fromEntries(w.zamowienie.pozycje.map((l) => [l.klucz, l.ilosc]))
    await expect(zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gab, zebrane, userId: KTO.userId })).rejects.toThrow(/FV 31\/11 wystawioną w BaseLinkerze/)
    expect((await a.packDrill.findUniqueOrThrow({ where: { id: w.cwiczenie.drillId } })).outcome).toBeNull()
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).not.toBe('SPAKOWANE')
    expect(await a.reservation.count({ where: { orderId: id, state: 'ACTIVE' } })).toBe(1)
  })
})
