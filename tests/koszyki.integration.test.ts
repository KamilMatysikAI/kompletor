// koszyki do zbierania i pakowania (1 zamówienie = 1 koszyk).
//  1. dodawanie (A, B, … i własne nazwy), przypisanie, zajęty koszyk, przeniesienie, przydział wolnych koszyków;
//  2. stanowisko: skan koszyka przy otwartym zamówieniu wkłada je do koszyka, skan w polu otwiera zamówienie z koszyka,
//     „Spakowano” zwalnia koszyk, „Nie spakowano” zostawia; ustawienie „wymagaj skanu koszyka”;
//  3. izolacja dwóch firm (RLS): koszyk i zamówienie innej firmy są niewidoczne, nazwy unikalne w obrębie firmy;
//  4. lista zbierania z koszykami (dane jak na stanowisku);
//  5. koniec zamówienia zwalnia koszyk w rdzeniu: „Spakuj” z karty, anulowanie, anulowanie z kanału;
//     dwa stanowiska skanują to samo zamówienie do dwóch koszyków naraz.
// Dane wyłącznie testowe (zmyślone produkty i numery zamówień).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { packOrder } from '@/lib/rdzen/rozchod'
import { startPicking } from '@/lib/rdzen/przejscia'
import { dodajKoszyki, listaKoszykow, przypiszKoszyk, przypiszWolne, usunKoszyk, zwolnijKoszyk } from '@/lib/koszyki/koszyki'
import { listaZbierania } from '@/lib/koszyki/zbieranie'
import { otworzZSesji, zakonczCwiczenie, type WynikSkanu } from '@/lib/stanowisko/cwiczenie'
import { gabarytyDla } from '@/lib/stanowisko/gabaryty'
import { skanKoszyka } from '@/lib/stanowisko/koszyk'
import { nastepneDoSpakowania } from '@/lib/stanowisko/nastepne'
import { ustawieniaStanowiska, zapiszKoszykWymagany } from '@/lib/stanowisko/ustawienia'
import { wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { ORG_B, testDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const KTO = { userId: 'uzytkownik-testowy' }

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

function ok(w: WynikSkanu): Extract<WynikSkanu, { typ: 'ok' }> {
  if (w.typ !== 'ok') throw new Error(`oczekiwane ok, jest: ${w.blokada.rodzaj} — ${w.blokada.komunikat}`)
  return w
}

async function zamowienie(db: PrismaClient, externalId: string, lines: Parameters<typeof order>[0]) {
  const r = await ingestOrder(db, order(lines, { externalId, createdAtChannel: new Date() }))
  return r.orderId!
}

async function spakuj(db: PrismaClient, orderId: string) {
  const w = ok(await otworzZSesji(db, orderId, null, KTO))
  const zebrane = Object.fromEntries(w.zamowienie.pozycje.map((p) => [p.klucz, p.ilosc]))
  return zakonczCwiczenie(db, { drillId: w.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gabarytyDla(w.zamowienie.carrier)[0]!, zebrane, userId: KTO.userId })
}

describe('koszyki: dodawanie i przypisanie', () => {
  it('10 koszyków A–J, kolejne od K, własne nazwy, błędna nazwa odmawia, usuwanie tylko pustego', async () => {
    expect(await dodajKoszyki(a, { ile: 10 })).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
    expect(await dodajKoszyki(a, { ile: 2 })).toEqual(['K', 'L'])
    expect(await dodajKoszyki(a, { nazwy: ['w1', 'W1', 'a'] })).toEqual(['W1'])
    await expect(dodajKoszyki(a, { nazwy: ['zły-kod'] })).rejects.toThrow(/litery i cyfry/)
    await expect(dodajKoszyki(a, { ile: 0 })).rejects.toThrow(/od 1 do 50/)
    const lista = await listaKoszykow(a)
    expect(lista.map((k) => k.nazwa)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'W1'])
    expect(lista[0]!.kod).toBe('KOSZ-A')

    const p = await product(a, 'HERB-1', 10)
    const o = await zamowienie(a, '5001', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o, userId: KTO.userId })
    const kA = lista.find((k) => k.nazwa === 'A')!
    expect(await usunKoszyk(a, kA.id)).toBe(false)
    await zwolnijKoszyk(a, kA.id)
    expect(await usunKoszyk(a, kA.id)).toBe(true)
  })

  it('wolny → przypisany, drugi raz → „już”, inne zamówienie → zajęty, zmiana koszyka przenosi zamówienie', async () => {
    await dodajKoszyki(a, { ile: 3 })
    const p = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '5001', [{ productId: p, qty: 1 }])
    const o2 = await zamowienie(a, '5002', [{ productId: p, qty: 1 }])
    expect(await przypiszKoszyk(a, { nazwa: 'a', orderId: o1, userId: KTO.userId })).toEqual({ typ: 'przypisany', nazwa: 'A', przeniesionyZ: null })
    expect(await przypiszKoszyk(a, { nazwa: 'A', orderId: o1, userId: KTO.userId })).toEqual({ typ: 'juz', nazwa: 'A' })
    expect(await przypiszKoszyk(a, { nazwa: 'A', orderId: o2, userId: KTO.userId })).toEqual({ typ: 'zajety', nazwa: 'A', orderId: o1 })
    expect(await przypiszKoszyk(a, { nazwa: 'B', orderId: o1, userId: KTO.userId })).toEqual({ typ: 'przypisany', nazwa: 'B', przeniesionyZ: 'A' })
    const lista = await listaKoszykow(a)
    expect(lista.map((k) => [k.nazwa, k.orderId])).toEqual([
      ['A', null],
      ['B', o1],
      ['C', null],
    ])
    expect(await przypiszKoszyk(a, { nazwa: 'Z', orderId: o2, userId: KTO.userId })).toEqual({ typ: 'nieznany' })
  })

  it('przydział wolnych: w kolejności listy, zamówienie z koszykiem zostaje, brak koszyków = licznik bez koszyka', async () => {
    await dodajKoszyki(a, { ile: 2 })
    const p = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '5001', [{ productId: p, qty: 1 }])
    const o2 = await zamowienie(a, '5002', [{ productId: p, qty: 1 }])
    const o3 = await zamowienie(a, '5003', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'B', orderId: o2, userId: KTO.userId })
    const w = await przypiszWolne(a, [o3, o2, o1], KTO.userId)
    expect(w).toEqual({ przypisane: [{ orderId: o3, nazwa: 'A' }], bezKoszyka: 1 })
    // ponowienie nic nie psuje (idempotentnie)
    expect(await przypiszWolne(a, [o3, o2, o1], KTO.userId)).toEqual({ przypisane: [], bezKoszyka: 1 })
  })
})

describe('koszyki na stanowisku', () => {
  it('skan koszyka przy otwartym zamówieniu, otwarcie z koszyka, „Spakowano” zwalnia, „Nie spakowano” zostawia', async () => {
    await dodajKoszyki(a, { ile: 2 })
    const p = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '5001', [{ productId: p, qty: 2 }])
    const o2 = await zamowienie(a, '5002', [{ productId: p, qty: 1 }])

    // pole skanu: pusty koszyk, nieznany koszyk
    expect(await skanKoszyka(a, 'A', null, KTO)).toMatchObject({ typ: 'koszyk', ton: 'info' })
    expect(await skanKoszyka(a, 'Q', null, KTO)).toMatchObject({ typ: 'koszyk', ton: 'blad' })

    // okno otwarte: zamówienie do koszyka A
    ok(await otworzZSesji(a, o1, null, KTO))
    expect(await skanKoszyka(a, 'A', o1, KTO)).toMatchObject({ typ: 'koszyk', ton: 'ok', orderId: o1, koszyk: 'A' })
    // koszyk zajęty przez inne zamówienie przełącza na nie, otwartego nie przenosi
    ok(await otworzZSesji(a, o2, null, KTO))
    const przel = await skanKoszyka(a, 'A', o2, KTO)
    expect(przel).toMatchObject({ typ: 'otworz', koszyk: 'A' })
    if (przel.typ === 'otworz') expect(ok(przel.wynik).zamowienie.id).toBe(o1)
    expect((await wczytajZamowienia(a, [o1]))[0]!.koszyk).toBe('A')
    expect((await wczytajZamowienia(a, [o2]))[0]!.koszyk).toBeNull()
    expect((await listaKoszykow(a)).map((k) => [k.nazwa, k.orderId])).toEqual([
      ['A', o1],
      ['B', null],
    ])
    // ani spakowane, ani zamknięte: o2 czeka z otwartym ćwiczeniem jak po zamknięciu okna ✕
    expect(await a.packDrill.count({ where: { orderId: o2, outcome: { not: null } } })).toBe(0)

    // pole skanu: koszyk A otwiera o1
    const otw = await skanKoszyka(a, 'A', null, KTO)
    expect(otw.typ).toBe('otworz')
    if (otw.typ === 'otworz') expect(ok(otw.wynik).zamowienie.id).toBe(o1)

    // „Nie spakowano” zostawia w koszyku, „Spakowano” zwalnia
    await przypiszKoszyk(a, { nazwa: 'B', orderId: o2, userId: KTO.userId })
    const w2 = ok(await otworzZSesji(a, o2, null, KTO))
    await zakonczCwiczenie(a, { drillId: w2.cwiczenie.drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    expect((await listaKoszykow(a)).find((k) => k.nazwa === 'B')!.orderId).toBe(o2)
    await spakuj(a, o1)
    expect((await listaKoszykow(a)).find((k) => k.nazwa === 'A')!.orderId).toBeNull()
  })

  it('„wymagaj skanu koszyka”: działa tylko przy koszykach, bez koszyka „Spakowano” odmawia, z koszykiem przechodzi', async () => {
    const p = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '5001', [{ productId: p, qty: 1 }])
    const o2 = await zamowienie(a, '5002', [{ productId: p, qty: 1 }])
    await zapiszKoszykWymagany(a, true, KTO.userId)
    // bez koszyków ustawienie nic nie zmienia
    expect((await ustawieniaStanowiska(a)).koszykWymagany).toBe(false)
    await spakuj(a, o1)

    await dodajKoszyki(a, { ile: 1 })
    expect((await ustawieniaStanowiska(a)).koszykWymagany).toBe(true)
    await expect(spakuj(a, o2)).rejects.toThrow(/zeskanuj koszyk/)
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o2, userId: KTO.userId })
    await expect(spakuj(a, o2)).resolves.toEqual({ wynik: 'SPAKOWANE' })
    // zapis ustawienia zostawia resztę ustawień stanowiska i zostawia ślad
    await zapiszKoszykWymagany(a, false, KTO.userId)
    expect((await ustawieniaStanowiska(a)).koszykWymagany).toBe(false)
    expect((await ustawieniaStanowiska(a)).powrotDoSkanu).toBe(true)
    expect(await a.auditLog.count({ where: { entity: 'Organization.stanowisko' } })).toBe(2)
  })

  it('„Następne do spakowania”: niespakowane z kolejki z koszykiem; przykład kodu z przedrostka konta', async () => {
    await dodajKoszyki(a, { ile: 1 })
    const p = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '5001', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o1, userId: KTO.userId })
    const { nastepne, przykladKodu } = await nastepneDoSpakowania(a)
    expect(nastepne.map((n) => [n.id, n.koszyk, n.pozycji])).toEqual([[o1, 'A', 1]])
    expect(przykladKodu).toMatch(/^[A-Z]+48213\/1$/)
  })
})

describe('izolacja firm i lista zbierania', () => {
  it('koszyk firmy A jest niewidoczny dla B, nazwy powtarzają się między firmami, zamówienie A nie trafi do koszyka B', async () => {
    await dodajKoszyki(a, { ile: 2 })
    expect(await dodajKoszyki(b, { ile: 1 })).toEqual(['A'])
    const p = await product(a, 'HERB-1', 10)
    const oA = await zamowienie(a, '5001', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'A', orderId: oA, userId: KTO.userId })
    expect((await listaKoszykow(b)).map((k) => [k.nazwa, k.orderId])).toEqual([['A', null]])
    expect(await przypiszKoszyk(b, { nazwa: 'A', orderId: oA, userId: KTO.userId })).toEqual({ typ: 'nieznany' })
    expect(await przypiszWolne(b, [oA], KTO.userId)).toEqual({ przypisane: [], bezKoszyka: 0 })
    expect(await skanKoszyka(b, 'B', null, KTO)).toMatchObject({ typ: 'koszyk', ton: 'blad' })
    // zwolnienie i usunięcie cudzego koszyka nic nie robi
    const kA = (await listaKoszykow(a)).find((k) => k.nazwa === 'A')!
    await zwolnijKoszyk(b, kA.id)
    expect(await usunKoszyk(b, kA.id)).toBe(false)
    expect((await listaKoszykow(a)).find((k) => k.nazwa === 'A')!.orderId).toBe(oA)
  })

  it('lista zbierania: suma po produkcie po półkach, rozpisanie na koszyki', async () => {
    await dodajKoszyki(a, { ile: 2 })
    const p1 = await product(a, 'HERB-1', 10)
    const p2 = await product(a, 'HERB-2', 10)
    await a.stock.updateMany({ where: { productId: p1 }, data: { location: 'C-4-10' } })
    await a.stock.updateMany({ where: { productId: p2 }, data: { location: 'C-4-2' } })
    const o1 = await zamowienie(a, '5001', [{ productId: p1, qty: 2 }, { productId: p2, qty: 1 }])
    const o2 = await zamowienie(a, '5002', [{ productId: p1, qty: 1 }])
    await przypiszWolne(a, [o1, o2], KTO.userId)
    const lista = listaZbierania(await wczytajZamowienia(a, [o1, o2]))
    expect(lista.map((p) => [p.lokalizacja, p.razem, p.doKoszykow.map((d) => `${d.koszyk}×${d.ilosc}`).join(' ')])).toEqual([
      ['C-4-2', 1, 'A×1'],
      ['C-4-10', 3, 'A×2 B×1'],
    ])
  })
})

describe('koszyki: koniec zamówienia zwalnia koszyk', () => {
  const koszykZ = async (orderId: string) => (await listaKoszykow(a)).find((k) => k.orderId === orderId)?.nazwa ?? null

  it('„Spakuj” z karty zamówienia zwalnia koszyk; zbieranie go nie zwalnia', async () => {
    await dodajKoszyki(a, { ile: 2 })
    const p = await product(a, 'HERB-1', 10)
    const o = await zamowienie(a, '5101', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o, userId: KTO.userId })
    await startPicking(a, o)
    expect(await koszykZ(o)).toBe('A')
    await packOrder(a, o)
    expect(await koszykZ(o)).toBeNull()
    expect((await listaKoszykow(a)).every((k) => k.orderId === null)).toBe(true)
  })

  it('anulowanie przez biuro zwalnia koszyk', async () => {
    await dodajKoszyki(a, { ile: 1 })
    const p = await product(a, 'HERB-1', 10)
    const o = await zamowienie(a, '5102', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o, userId: KTO.userId })
    expect(await cancelOrder(a, o)).toBe('ANULOWANE')
    expect(await koszykZ(o)).toBeNull()
  })

  it('anulowanie z kanału (nowa rewizja zamówienia) zwalnia koszyk', async () => {
    await dodajKoszyki(a, { ile: 1 })
    const p = await product(a, 'HERB-1', 10)
    const o = await zamowienie(a, '5103', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o, userId: KTO.userId })
    await ingestOrder(a, order([{ productId: p, qty: 1 }], { externalId: '5103', externalRevision: '2', cancelled: true }))
    expect((await a.order.findUniqueOrThrow({ where: { id: o }, select: { status: true } })).status).toBe('ANULOWANE')
    expect(await koszykZ(o)).toBeNull()
  })

  it('dwa stanowiska naraz: to samo zamówienie do koszyków A i B — bez błędu, na końcu w dokładnie jednym koszyku', async () => {
    await dodajKoszyki(a, { ile: 10 })
    const p = await product(a, 'HERB-1', 50)
    for (let i = 0; i < 4; i++) {
      const o = await zamowienie(a, `52${i}`, [{ productId: p, qty: 1 }])
      const [x, y] = [String.fromCharCode(65 + 2 * i), String.fromCharCode(66 + 2 * i)]
      const wyniki = await Promise.all([przypiszKoszyk(a, { nazwa: x, orderId: o, userId: KTO.userId }), przypiszKoszyk(a, { nazwa: y, orderId: o, userId: KTO.userId })])
      for (const w of wyniki) expect(['przypisany', 'wInnym', 'juz']).toContain(w.typ)
      expect((await listaKoszykow(a)).filter((k) => k.orderId === o)).toHaveLength(1)
    }
  })

  it('wyścig na stanowisku: skan koszyka po przypisaniu zamówienia do innego koszyka nie rzuca', async () => {
    await dodajKoszyki(a, { ile: 2 })
    const p = await product(a, 'HERB-1', 10)
    const o = await zamowienie(a, '5301', [{ productId: p, qty: 1 }])
    const [s1, s2] = await Promise.all([skanKoszyka(a, 'A', o, KTO), skanKoszyka(a, 'B', o, KTO)])
    for (const s of [s1, s2]) expect(s).toMatchObject({ typ: 'koszyk', orderId: o })
    expect((await listaKoszykow(a)).filter((k) => k.orderId === o)).toHaveLength(1)
  })
})
