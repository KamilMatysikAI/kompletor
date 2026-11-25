// ×: statusy firmy w menu „Zamówienia” mają te same liczniki co dawny lewy panel listy
// (`licznikiPanelu().firmy.ile` = `licznikiStatusowFirmy`, ten sam odczyt co ekran ustawień) i każdy licznik w menu
// (status, grupa, przewoźnik pod statusem, „Bez statusu firmy”) = liczba zamówień, które pokaże lista po kliknięciu
// (`stronaListy` z filtrami `sf`/`sg`/`przewoznik` z adresu pozycji). Trzy firmy: preset ACME (22 statusy), neutralny
// zestaw nowej firmy i firma bez statusów własnych (stare grupy rdzenia). Bez kanałów i danych klientów.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Carrier, OrderStatus, Prisma } from '@prisma/client'
import { pozycjeStatusow } from '@/lib/panel/menu-statusy'
import type { PozycjaMenu } from '@/lib/panel/nawigacja'
import { licznikiStatusowFirmy, statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { filtryZ, GRUPY_PANELU, licznikiPanelu, stronaListy } from '@/lib/panel/zamowienia-lista'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ACME_PRESET } from '@/tests/preset-testowy'
import { ORG_A, ORG_B, TEST_ORGS, testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const ORGS = TEST_ORGS.map((o) => (o.id === ORG_A ? { ...o, statuses: ACME_PRESET.statuses, statusGroups: ACME_PRESET.statusGroups } : o))

beforeEach(async () => {
  await truncateAll(undefined, ORGS)
  for (const db of [a, b]) await seedBase(db)
})

let nr = 0
async function zam(db: typeof a, status: OrderStatus, carrier: Carrier | null, extra: Partial<Prisma.OrderUncheckedUpdateInput> = {}) {
  const p = await product(db, `M-${++nr}`, 5)
  const r = await ingestOrder(db, order([{ productId: p, qty: 1 }]), { now: T0 })
  await db.order.update({ where: { id: r.orderId! }, data: { status, carrier, ...extra } })
  return r.orderId!
}

const PLAN: [OrderStatus, Carrier | null, number][] = [
  ['NOWE', null, 3],
  ['DO_REALIZACJI', 'BEZ_WYSYLKI', 1],
  ['DO_REALIZACJI', 'PACZKOMATY', 2],
  ['DO_REALIZACJI', 'INPOST_KURIER', 1],
  ['DO_REALIZACJI', 'DPD', 2],
  ['DO_REALIZACJI', null, 1],
  ['ZEBRANE', 'ALLEGRO', 1],
  ['ZEBRANE', 'BEZ_WYSYLKI', 1],
  ['SPAKOWANE', 'DPD', 1],
  ['DO_WYSLANIA', 'DPD', 2],
  ['WYSLANE', 'DPD', 2],
  ['ANULOWANE', null, 1],
  ['DO_WYJASNIENIA', 'PACZKOMATY', 1],
]

async function zasiej(db: typeof a) {
  for (const [s, c, n] of PLAN) for (let i = 0; i < n; i++) await zam(db, s, c)
}

const plaskie = (x: PozycjaMenu): PozycjaMenu[] => [x, ...x.dzieci.flatMap(plaskie)]
const opcje = { sort: { klucz: 'data', kierunek: 'malejaco' } as const, pomin: 0, ile: 250 }

/** Każda pozycja-widok menu: licznik = liczba zamówień na liście po kliknięciu (parametry z adresu pozycji). */
async function sprawdzKlikniecia(db: typeof a, pozycje: PozycjaMenu[]) {
  let sprawdzone = 0
  for (const x of pozycje.flatMap(plaskie)) {
    if (!x.widok || x.licznik === undefined || x.widok.widok === 'wymaga') continue
    const sp = Object.fromEntries(new URL(x.href, 'http://x').searchParams)
    expect((await stronaListy(db, filtryZ(sp), opcje)).razem, `${x.etykieta} ${x.href}`).toBe(x.licznik)
    sprawdzone++
  }
  return sprawdzone
}

describe('statusy firmy w menu „Zamówienia” (×)', () => {
  it('ACME (22 statusy): liczniki menu = dawny panel = ekran ustawień; każdy klik daje tyle zamówień, ile licznik', async () => {
    await zasiej(a)
    // przypisanie wprost do innego statusu tego samego etapu (Więcej → Zmień status…) przenosi zamówienie w menu
    await zam(a, 'DO_REALIZACJI', 'DPD', { companyStatus: 'DO_REALIZACJI_ALLEGRO' })
    const l = await licznikiPanelu(a)
    const sf = await statusyFirmy(a)
    expect(sf.statusy).toHaveLength(22)
    // źródło liczników: ta sama funkcja co dawny panel i ekran Ustawienia → Statusy zamówień
    expect(l.firmy!.ile).toEqual(Object.fromEntries(await licznikiStatusowFirmy(a, sf.statusy)))
    const p = pozycjeStatusow(l, { ustawienia: true })
    const wszystkie = p.flatMap(plaskie)
    for (const [k, n] of Object.entries(l.firmy!.ile)) expect(wszystkie.find((x) => x.widok?.sf === k && !x.widok.przewoznik)?.licznik, k).toBe(n)
    // suma statusów firmy = „Wszystkie”; przewoźnicy pod statusem sumują się do licznika statusu
    expect(Object.values(l.firmy!.ile).reduce((x, y) => x + y, 0)).toBe(l.grupy.wszystkie)
    for (const x of wszystkie.filter((y) => y.widok?.sf && y.dzieci.length)) expect(x.dzieci.reduce((n, d) => n + (d.licznik ?? 0), 0), x.etykieta).toBe(x.licznik)
    // kolor kropki = kolor statusu z ustawień
    const dpd = wszystkie.find((x) => x.widok?.sf === 'DO_REALIZACJI_DPD')!
    expect(dpd.kolor).toMatch(/^#[0-9a-f]{6}$/)
    expect(dpd.licznik).toBe(2)
    expect(wszystkie.find((x) => x.widok?.sf === 'DO_REALIZACJI_ALLEGRO')!.licznik).toBe(1)
    // zamówienie bez pasującego statusu firmy stoi pod „Bez statusu firmy”
    expect(p.find((x) => x.naglowek)!.dzieci.map((d) => [d.widok?.sf, d.licznik])).toContainEqual(['RDZEN:ZEBRANE', 1])
    expect(await sprawdzKlikniecia(a, p)).toBeGreaterThan(10)
  })

  it('nowa firma (neutralny zestaw): statusy po jednym na etap, przewoźnicy pod „Do realizacji” jak kolejka', async () => {
    await zasiej(b)
    const l = await licznikiPanelu(b)
    expect(l.firmy!.statusy).toHaveLength(12)
    const p = pozycjeStatusow(l)
    const dr = p.flatMap(plaskie).find((x) => x.widok?.sf === 'DO_REALIZACJI')!
    // te same liczby co panel (grupa rdzenia × przewoźnik)
    expect(dr.licznik).toBe(l.grupy.do_realizacji)
    expect(Object.fromEntries(dr.dzieci.map((d) => [d.widok!.przewoznik, d.licznik]))).toEqual(l.przewoznicy.do_realizacji)
    expect(p.some((x) => x.naglowek)).toBe(false)
    expect(await sprawdzKlikniecia(b, p)).toBeGreaterThan(10)
  })

  it('firma bez statusów własnych: menu z grupami rdzenia, liczniki = dawny panel, kliknięcia zgodne', async () => {
    await b.orderStatusDef.deleteMany({})
    await b.orderStatusGroup.deleteMany({})
    await zasiej(b)
    const l = await licznikiPanelu(b)
    expect(l.firmy).toBeUndefined()
    const p = pozycjeStatusow(l)
    // „Wszystkie” bez licznika; reszta grup = dawny panel
    for (const g of GRUPY_PANELU) expect(p.find((x) => x.widok?.widok === g.klucz && !x.widok.przewoznik)?.licznik, g.klucz).toBe(g.klucz === 'wszystkie' ? undefined : l.grupy[g.klucz])
    expect(await sprawdzKlikniecia(b, p)).toBeGreaterThan(8)
  })

  it('izolacja firm: menu firmy A nie liczy zamówień firmy B', async () => {
    await zasiej(b)
    const l = await licznikiPanelu(a)
    expect(l.grupy.wszystkie).toBe(0)
    expect(Object.values(l.firmy!.ile).reduce((x, y) => x + y, 0)).toBe(0)
  })
})
