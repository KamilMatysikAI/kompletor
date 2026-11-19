// skan karty albo koszyka innego zamówienia przy otwartym oknie pakowania przełącza na nie. Serwerowa część
// przełączenia to te same kroki, które woła ekran: `sprawdzSkan` (bez ćwiczenia) → `otworzZSesji` z kartą, a skan koszyka
// `skanKoszyka` z bieżącym zamówieniem. Sprawdzamy: odłożone zostaje niespakowane z zapisanymi brakami, ta sama karta to
// samo zamówienie, spakowane = blokada, koszyk zajęty przełącza bez przeniesienia, PRACA i drugie stanowisko bez zmian.
// Dane wyłącznie testowe (zmyślone produkty i numery zamówień).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { checkInvariants } from '@/lib/rdzen/niezmienniki'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { dodajKoszyki, listaKoszykow, przypiszKoszyk } from '@/lib/koszyki/koszyki'
import { naPolceNieBylo, otworzZSesji, rozpoznajSkan, sprawdzSkan, zakonczCwiczenie, type WynikSkanu } from '@/lib/stanowisko/cwiczenie'
import { drukujKarty } from '@/lib/stanowisko/karty'
import { gabarytyDla } from '@/lib/stanowisko/gabaryty'
import { skanKoszyka } from '@/lib/stanowisko/koszyk'
import { wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { testDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'

const a = testDb()
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Magazyn Testowy' }
const DRUGI = { userId: 'uzytkownik-drugi', nazwa: 'Magazyn Drugi' }

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
})
afterAll(async () => {
  await a.$disconnect()
})

function ok(w: WynikSkanu): Extract<WynikSkanu, { typ: 'ok' }> {
  if (w.typ !== 'ok') throw new Error(`oczekiwane ok, jest: ${w.blokada.rodzaj} — ${w.blokada.komunikat}`)
  return w
}
async function zamowienie(db: PrismaClient, externalId: string, lines: Parameters<typeof order>[0], over: Parameters<typeof order>[1] = {}) {
  return (await ingestOrder(db, order(lines, { externalId, createdAtChannel: new Date(), ...over }))).orderId!
}
const praca = () => a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })

/** Skan karty przy otwartym oknie, jak ekran: sprawdzenie, potem otwarcie z kartą. */
async function skanWTrakcie(kod: string, kto = KTO) {
  const s = await sprawdzSkan(a, kod)
  if (s.typ !== 'do_sesji') return s
  return otworzZSesji(a, s.zamowienie.id, s.karta.printId, kto)
}

describe('przełączenie skanem karty', () => {
  it('pakowanie próbne: druga karta otwiera drugie, pierwsze niespakowane z brakiem, ponowny skan wraca do tego samego ćwiczenia', async () => {
    const p1 = await product(a, 'HERB-1', 10)
    const p2 = await product(a, 'HERB-2', 10)
    const o1 = await zamowienie(a, '7001', [{ productId: p1, qty: 2 }, { productId: p2, qty: 1 }])
    const o2 = await zamowienie(a, '7002', [{ productId: p2, qty: 1 }])
    const { wydruki } = await drukujKarty(a, [o1, o2], KTO)
    const [k1, k2] = [wydruki[0]!.kod, wydruki[1]!.kod]

    const w1 = ok(await rozpoznajSkan(a, k1, KTO))
    const kl = w1.zamowienie.pozycje.find((p) => p.productId === p1)!.klucz
    await naPolceNieBylo(a, { drillId: w1.cwiczenie.drillId, klucz: kl, ilosc: 1, userId: KTO.userId })

    // ta sama karta: to samo zamówienie (ekran nic nie zmienia)
    const ta = await sprawdzSkan(a, k1)
    expect(ta.typ === 'do_sesji' && ta.zamowienie.id).toBe(o1)

    const w2 = ok(await skanWTrakcie(k2))
    expect(w2.zamowienie.id).toBe(o2)
    // pierwsze: nic nie zapisane jako spakowane, ćwiczenie otwarte, brak zostaje
    const d1 = await a.packDrill.findUniqueOrThrow({ where: { id: w1.cwiczenie.drillId }, include: { fixes: true } })
    expect(d1.outcome).toBeNull()
    expect(d1.fixes.filter((f) => f.state !== 'WITHDRAWN')).toHaveLength(1)
    expect(await a.packDrill.count({ where: { outcome: 'SPAKOWANE' } })).toBe(0)

    // spakowanie drugiego, potem powrót do pierwszego: to samo ćwiczenie z brakiem
    await zakonczCwiczenie(a, { drillId: w2.cwiczenie.drillId, wynik: 'SPAKOWANE', gabaryt: gabarytyDla(w2.zamowienie.carrier)[0]!, zebrane: { [w2.zamowienie.pozycje[0]!.klucz]: 1 }, userId: KTO.userId })
    const znow = ok(await skanWTrakcie(k1))
    expect(znow.cwiczenie.drillId).toBe(w1.cwiczenie.drillId)
    expect(znow.cwiczenie.braki).toMatchObject([{ klucz: kl, ilosc: 1 }])

    // spakowane: komunikat zamiast przełączenia
    const sp = await sprawdzSkan(a, k2)
    expect(sp.typ === 'blokada' && sp.blokada.rodzaj).toBe('spakowane')
    expect(await checkInvariants(a)).toEqual([])
  })

  it('PRACA: przełączenie nie pakuje pierwszego, brak zostaje w zamówieniu; drugie stanowisko nadal widzi „pakuje inna osoba”', async () => {
    await praca()
    const p1 = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '8001', [{ productId: p1, qty: 2 }], { channel: 'ALLEGRO' })
    const o2 = await zamowienie(a, '8002', [{ productId: p1, qty: 1 }], { channel: 'ALLEGRO' })
    const { wydruki } = await drukujKarty(a, [o1, o2], KTO)
    const w1 = ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
    expect(w1.zamowienie.tryb).toBe('PRACA')
    await naPolceNieBylo(a, { drillId: w1.cwiczenie.drillId, klucz: w1.zamowienie.pozycje[0]!.klucz, ilosc: 1, userId: KTO.userId })

    ok(await skanWTrakcie(wydruki[1]!.kod))
    const z1 = await a.order.findUniqueOrThrow({ where: { id: o1 }, select: { status: true } })
    expect(['ZBIERANIE', 'ZEBRANE', 'DO_REALIZACJI']).toContain(z1.status)
    expect((await a.packDrill.findUniqueOrThrow({ where: { id: w1.cwiczenie.drillId } })).outcome).toBeNull()

    // drugie stanowisko: odłożone okno wciąż należy do pierwszej osoby (zabezpieczenie jak po zamknięciu ✕)
    const inny = await skanWTrakcie(wydruki[0]!.kod, DRUGI)
    expect(inny.typ === 'blokada' && inny.blokada.rodzaj).toBe('zajete')

    // powrót pierwszej osoby: brak jest w zamówieniu, zostaje 1 szt. do zebrania
    const znow = ok(await skanWTrakcie(wydruki[0]!.kod))
    expect(znow.zamowienie.pozycje.reduce((s, p) => s + p.ilosc, 0)).toBe(1)
    expect(await checkInvariants(a)).toEqual([])
  })
})

describe('przełączenie skanem koszyka', () => {
  it('koszyk innego zamówienia przełącza bez przeniesienia; pusty koszyk wkłada jak dotąd; ustawienie koszyków nietknięte', async () => {
    await dodajKoszyki(a, { ile: 3 })
    const p = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '9001', [{ productId: p, qty: 1 }])
    const o2 = await zamowienie(a, '9002', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o1, userId: KTO.userId })
    await przypiszKoszyk(a, { nazwa: 'B', orderId: o2, userId: KTO.userId })

    ok(await otworzZSesji(a, o2, null, KTO))
    const s = await skanKoszyka(a, 'A', o2, KTO)
    expect(s).toMatchObject({ typ: 'otworz', koszyk: 'A' })
    if (s.typ === 'otworz') expect(ok(s.wynik).zamowienie.id).toBe(o1)
    // oba zamówienia w swoich koszykach, nic nie przeniesione
    expect((await listaKoszykow(a)).map((k) => [k.nazwa, k.orderId])).toEqual([
      ['A', o1],
      ['B', o2],
      ['C', null],
    ])
    expect((await wczytajZamowienia(a, [o2]))[0]!.koszyk).toBe('B')

    // pusty koszyk przy otwartym o1: o1 przechodzi do C (zasada sprzed zmiany)
    expect(await skanKoszyka(a, 'C', o1, KTO)).toMatchObject({ typ: 'koszyk', ton: 'ok', orderId: o1, koszyk: 'C', tekst: expect.stringContaining('przeniesione z koszyka A') })
    // własny koszyk: „już”
    expect(await skanKoszyka(a, 'C', o1, KTO)).toMatchObject({ typ: 'koszyk', ton: 'info', koszyk: 'C' })
    expect(await checkInvariants(a)).toEqual([])
  })

  it('koszyk zamówienia, którego nie wolno pakować: blokada zamiast przełączenia, otwarte zostaje w swoim koszyku', async () => {
    await dodajKoszyki(a, { ile: 2 })
    const p = await product(a, 'HERB-1', 10)
    const o1 = await zamowienie(a, '9101', [{ productId: p, qty: 1 }])
    const o2 = await zamowienie(a, '9102', [{ productId: p, qty: 1 }])
    await przypiszKoszyk(a, { nazwa: 'A', orderId: o1, userId: KTO.userId })
    await a.order.update({ where: { id: o1 }, data: { status: 'ANULOWANE' } })
    ok(await otworzZSesji(a, o2, null, KTO))
    const s = await skanKoszyka(a, 'A', o2, KTO)
    expect(s.typ === 'otworz' && s.wynik.typ === 'blokada' && s.wynik.blokada.rodzaj).toBe('anulowane')
    expect((await wczytajZamowienia(a, [o2]))[0]!.koszyk).toBeNull()
  })
})
