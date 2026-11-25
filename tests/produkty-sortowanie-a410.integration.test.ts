// sortowanie listy produktów kliknięciem w nagłówek (kolejność całej listy w bazie, przed stronicowaniem).
//  1. „Dostępne” rosnąco i malejąco: kolejność zgodna z liczbą w kolumnie (max(0, fizycznie − zarezerwowane), suma
//     magazynów), rezerwacje większe niż stan dają 0, produkty bez liczby (zestaw, bez wiersza stanu) na końcu;
//  2. równe wartości na granicy stron: stała kolejność (nazwa, id), żaden produkt nie wypada ani nie powtarza się;
//  3. pozostałe kolumny (fizycznie, zarezerwowane, oferty, lokalizacja, kategoria, nazwa malejąco) i filtr razem z sortem;
//  4. izolacja firm: lista firmy A posortowana po „Dostępne” nie widzi produktów firmy B.
// Dane wyłącznie testowe (zmyślone produkty).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PAGE_SIZE, productsPage, type ProductRow } from '@/lib/panel/dane'
import type { SortTabeli } from '@/lib/panel/tabela'
import { ORG_B, testDb, truncateAll } from './db'
import { bundle, offer, product, seedBase } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })

afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const ROWNYCH = PAGE_SIZE + 2 // grupa równych „Dostępne” przechodzi przez granicę stron

type Ids = { low: string; over: string; high: string; dwa: string; zestaw: string; bezStanu: string; rowne: string[]; b: string[] }

async function seed(): Promise<Ids> {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  const rowne: string[] = []
  for (let i = 0; i < ROWNYCH; i++) rowne.push(await product(a, `R-${String(i).padStart(3, '0')}`, 5))
  const low = await product(a, 'LOW', 10)
  const over = await product(a, 'OVER', 2)
  const high = await product(a, 'HIGH', 100)
  const dwa = await product(a, 'DWA', 3)
  await a.stock.updateMany({ where: { productId: low }, data: { reserved: 9 } })
  await a.stock.updateMany({ where: { productId: over }, data: { reserved: 5 } }) // więcej rezerwacji niż na półce → dostępne 0
  await a.stock.updateMany({ where: { productId: high }, data: { reserved: 30 } })
  // drugi magazyn: kolumna pokazuje sumę (3 + 4 = 7)
  await a.warehouse.create({ data: { id: 'w2', name: 'Drugi (test)', wfirmaWarehouseId: '999002', stockSource: 'WFIRMA' } })
  await a.stock.create({ data: { productId: dwa, warehouseId: 'w2', wfirmaCount: 4, physical: 4, wfirmaReadAt: new Date('2026-01-01T00:00:00Z') } })
  const zestaw = await bundle(a, 'ZESTAW', [{ id: low, qty: 1 }])
  const bezStanu = (await a.product.create({ data: { sku: 'BEZ-STANU', kind: 'STOCKED', unit: 'SZT', nameAccounting: 'Bez stanu', title: 'Towar testowy BEZ-STANU' } })).id
  // firma B: skrajne wartości, które przy wycieku stanęłyby na początku listy A
  const b0 = await product(b, 'B-ZERO', 0)
  const b1 = await product(b, 'B-DUZO', 100_000)
  return { low, over, high, dwa, zestaw, bezStanu, rowne, b: [b0, b1] }
}

/** Cała lista w kolejności sortowania, strona po stronie (tak, jak klika użytkownik). */
async function wszystkieStrony(db: typeof a, sort: SortTabeli, filter: 'wszystkie' | 'zarezerwowane' = 'wszystkie'): Promise<{ rows: ProductRow[]; total: number; strony: number }> {
  const first = await productsPage(db, { filter, sort, page: 1 })
  const strony = Math.max(1, Math.ceil(first.total / PAGE_SIZE))
  const rows = [...first.rows]
  for (let s = 2; s <= strony; s++) rows.push(...(await productsPage(db, { filter, sort, page: s })).rows)
  return { rows, total: first.total, strony }
}

/** Liczba z kolumny (to, co widzi użytkownik); zestaw i produkt bez stanu nie mają liczby. */
const kolumna = (r: ProductRow, k: 'available' | 'physical' | 'reserved') => (r.kind === 'STOCKED' ? r[k] : null)

function oczekiwanaKolejnosc(rows: ProductRow[], val: (r: ProductRow) => number | string | null, malejaco: boolean): string[] {
  const porownaj = (x: ProductRow, y: ProductRow) => {
    const vx = val(x)
    const vy = val(y)
    if (vx === null && vy !== null) return 1
    if (vy === null && vx !== null) return -1
    if (vx !== null && vy !== null && vx !== vy) return (vx < vy ? -1 : 1) * (malejaco ? -1 : 1)
    if (x.title !== y.title) return x.title < y.title ? -1 : 1
    return x.id < y.id ? -1 : 1
  }
  return [...rows].sort(porownaj).map((r) => r.id)
}

let ids: Ids
beforeEach(async () => {
  ids = await seed()
})

describe('sortowanie listy produktów', () => {
  it('„Dostępne” rosnąco: kolejność = liczba w kolumnie, cała lista przez strony, bez liczby na końcu', async () => {
    const { rows, total, strony } = await wszystkieStrony(a, { klucz: 'dostepne', kierunek: 'rosnaco' })
    expect(strony).toBe(2)
    expect(total).toBe(ROWNYCH + 6)
    expect(rows).toHaveLength(total)
    expect(new Set(rows.map((r) => r.id)).size).toBe(total) // nic nie wypadło ani nie powtórzyło się na granicy stron
    expect(rows.map((r) => r.id)).toEqual(oczekiwanaKolejnosc(rows, (r) => kolumna(r, 'available'), false))
    // początek: OVER (0, bo 5 zarezerwowanych przy 2 na półce), LOW (1); koniec: HIGH (70), potem bez liczby
    expect(rows.slice(0, 2).map((r) => [r.id, r.available])).toEqual([
      [ids.over, 0],
      [ids.low, 1],
    ])
    const dwa = rows.find((r) => r.id === ids.dwa)!
    expect(dwa.available).toBe(7)
    expect(rows.slice(-3).map((r) => r.id)).toEqual([ids.high, ids.bezStanu, ids.zestaw]) // „Towar testowy BEZ-STANU” < „Zestaw ZESTAW”
    expect(rows.slice(-2).every((r) => kolumna(r, 'available') === null)).toBe(true)
    expect(rows.some((r) => ids.b.includes(r.id))).toBe(false)
  })

  it('„Dostępne” malejąco: największe na górze, bez liczby dalej na końcu', async () => {
    const { rows, total } = await wszystkieStrony(a, { klucz: 'dostepne', kierunek: 'malejaco' })
    expect(new Set(rows.map((r) => r.id)).size).toBe(total)
    expect(rows.map((r) => r.id)).toEqual(oczekiwanaKolejnosc(rows, (r) => kolumna(r, 'available'), true))
    expect(rows[0]!.id).toBe(ids.high)
    expect(rows[0]!.available).toBe(70)
    expect(rows[1]!.id).toBe(ids.dwa)
    expect(rows.slice(-2).every((r) => kolumna(r, 'available') === null)).toBe(true)
  })

  it('równe wartości na granicy stron: stała kolejność po nazwie, ten sam wynik przy powtórzeniu', async () => {
    const sort: SortTabeli = { klucz: 'dostepne', kierunek: 'rosnaco' }
    const s1 = await productsPage(a, { filter: 'wszystkie', sort, page: 1 })
    const s2 = await productsPage(a, { filter: 'wszystkie', sort, page: 2 })
    const rowneNa1 = s1.rows.filter((r) => ids.rowne.includes(r.id))
    const rowneNa2 = s2.rows.filter((r) => ids.rowne.includes(r.id))
    expect(rowneNa1.length).toBeGreaterThan(0)
    expect(rowneNa2.length).toBeGreaterThan(0) // grupa równych faktycznie przechodzi przez granicę
    expect([...rowneNa1, ...rowneNa2].map((r) => r.id)).toEqual(ids.rowne) // SKU R-000… w kolejności nazw
    expect((await productsPage(a, { filter: 'wszystkie', sort, page: 2 })).rows.map((r) => r.id)).toEqual(s2.rows.map((r) => r.id))
  })

  it('fizycznie, zarezerwowane, oferty, lokalizacja, kategoria i nazwa malejąco: kolejność zgodna z kolumną', async () => {
    await offer(a, 'WOO_SD', 'O-1', ids.low)
    await offer(a, 'ALLEGRO', 'O-2', ids.low)
    await offer(a, 'WOO_SD', 'O-3', ids.high)
    await a.stock.updateMany({ where: { productId: ids.high }, data: { location: 'A-1-1' } })
    await a.stock.updateMany({ where: { productId: ids.low }, data: { location: 'C-9-9' } })
    const kat = await a.productCategory.create({ data: { name: 'Napoje', slug: 'napoje', path: 'Napoje', depth: 1 } })
    const kat2 = await a.productCategory.create({ data: { name: 'Akcesoria', slug: 'akcesoria', path: 'Akcesoria', depth: 1 } })
    await a.product.update({ where: { id: ids.over }, data: { categoryId: kat.id } })
    await a.product.update({ where: { id: ids.dwa }, data: { categoryId: kat2.id } })

    for (const kierunek of ['rosnaco', 'malejaco'] as const) {
      const m = kierunek === 'malejaco'
      const fiz = (await wszystkieStrony(a, { klucz: 'fizycznie', kierunek })).rows
      expect(fiz.map((r) => r.id)).toEqual(oczekiwanaKolejnosc(fiz, (r) => kolumna(r, 'physical'), m))
      const rez = (await wszystkieStrony(a, { klucz: 'zarezerwowane', kierunek })).rows
      expect(rez.map((r) => r.id)).toEqual(oczekiwanaKolejnosc(rez, (r) => kolumna(r, 'reserved'), m))
      const of = (await wszystkieStrony(a, { klucz: 'oferty', kierunek })).rows
      expect(of.map((r) => r.id)).toEqual(oczekiwanaKolejnosc(of, (r) => r.offers, m))
      const lok = (await wszystkieStrony(a, { klucz: 'lokalizacja', kierunek })).rows
      expect(lok.map((r) => r.id)).toEqual(oczekiwanaKolejnosc(lok, (r) => r.location, m))
      const kt = (await wszystkieStrony(a, { klucz: 'kategoria', kierunek })).rows
      expect(kt.map((r) => r.id)).toEqual(oczekiwanaKolejnosc(kt, (r) => r.kategoria?.name ?? null, m))
    }
    expect((await productsPage(a, { filter: 'wszystkie', sort: { klucz: 'oferty', kierunek: 'malejaco' } })).rows[0]).toMatchObject({ id: ids.low, offers: 2 })
    expect((await productsPage(a, { filter: 'wszystkie', sort: { klucz: 'lokalizacja', kierunek: 'rosnaco' } })).rows[0]).toMatchObject({ id: ids.high, location: 'A-1-1' })
    expect((await productsPage(a, { filter: 'wszystkie', sort: { klucz: 'kategoria', kierunek: 'rosnaco' } })).rows[0]).toMatchObject({ id: ids.dwa })
    const nazwy = (await wszystkieStrony(a, { klucz: 'produkt', kierunek: 'malejaco' })).rows
    const domyslnie = (await wszystkieStrony(a, { klucz: 'produkt', kierunek: 'rosnaco' })).rows
    expect(nazwy.map((r) => r.title)).toEqual([...domyslnie.map((r) => r.title)].reverse())
  })

  it('nieznany klucz sortowania = kolejność domyślna (nazwa rosnąco), jak bez sortowania', async () => {
    const bez = await productsPage(a, { filter: 'wszystkie' })
    const zly = await productsPage(a, { filter: 'wszystkie', sort: { klucz: 'p.title; DROP TABLE "Product"', kierunek: 'malejaco' } })
    expect(zly.rows.map((r) => r.id)).toEqual(bez.rows.map((r) => r.id))
    expect(zly.total).toBe(bez.total)
  })

  it('filtr razem z sortem: „Z rezerwacją” po „Dostępne” malejąco liczy i sortuje tylko pasujące', async () => {
    const { rows, total } = await wszystkieStrony(a, { klucz: 'dostepne', kierunek: 'malejaco' }, 'zarezerwowane')
    expect(total).toBe(3)
    expect(rows.map((r) => r.id)).toEqual([ids.high, ids.low, ids.over])
  })

  it('izolacja firm: firma B posortowana po „Dostępne” widzi tylko swoje produkty', async () => {
    const rosnaco = await wszystkieStrony(b, { klucz: 'dostepne', kierunek: 'rosnaco' })
    expect(rosnaco.rows.map((r) => r.id)).toEqual(ids.b)
    expect(rosnaco.total).toBe(2)
    const malejaco = await wszystkieStrony(b, { klucz: 'dostepne', kierunek: 'malejaco' })
    expect(malejaco.rows.map((r) => r.id)).toEqual([...ids.b].reverse())
  })
})
