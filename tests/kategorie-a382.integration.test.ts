// E1: drzewo kategorii produktów w bazie (RLS, przeniesienie, usunięcie z przeniesieniem produktów, CSV,
// filtr gałęzi). Dane fikcyjne, bez nazw sklepów.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { zalozProduktReczny } from '@/lib/produkty/karta'
import {
  dodajKategorie,
  drzewoKategorii,
  checkNazwaKategorii,
  kategoriaZeSciezki,
  MAX_GLEBOKOSC,
  MAX_KATEGORII,
  przeniesKategorie,
  przesunKategorie,
  przypiszKategorie,
  usunKategorie,
  warunekKategorii,
  zmienNazweKategorii,
  znajdzKategorie,
} from '@/lib/produkty/kategorie'
import { crossOrgLeaks, ORG_B, testDb, testSystemDb, truncateAll } from './db'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const USER = 'uzytkownik-testowy-a382'

afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await a.warehouse.create({
    data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)' },
  })
  await b.warehouse.create({
    data: { id: DEFAULT_WAREHOUSE, name: 'Główny B (test)' },
  })
})

async function kat(db: typeof a, nazwa: string, parentId: string | null = null): Promise<string> {
  const r = await dodajKategorie(db, { nazwa, parentId }, USER)
  if (!r.ok) throw new Error(r.error)
  return r.value.id
}
async function prod(db: typeof a, sku: string): Promise<string> {
  const r = await zalozProduktReczny(
    db,
    {
      rodzaj: 'zwykly',
      sku,
      form: { nazwa: `Produkt ${sku}`, cena: '10,00', vat: '23' },
    },
    USER,
    { hasWfirma: false },
  )
  if (!r.ok) throw new Error(r.error)
  return r.productId
}
const sciezki = async (db: typeof a) => (await drzewoKategorii(db)).map((k) => `${k.depth}:${k.path}`)

describe('drzewo: dodawanie, nazwa, kolejność, głębokość', () => {
  it('ścieżki i głębokość, unikalna nazwa wśród rodzeństwa (bez wielkości liter), limit 5 poziomów', async () => {
    const napoje = await kat(a, 'Napoje')
    const soki = await kat(a, 'Soki', napoje)
    await kat(a, 'Wody', napoje)
    expect(await sciezki(a)).toEqual(['1:Napoje', '2:Napoje > Soki', '2:Napoje > Wody'])
    expect(await dodajKategorie(a, { nazwa: 'soki', parentId: napoje }, USER)).toMatchObject({ ok: false, error: expect.stringContaining('już jest') })
    expect(await dodajKategorie(a, { nazwa: 'NAPOJE' }, USER)).toMatchObject({
      ok: false,
    })
    // ta sama nazwa pod innym rodzicem jest dozwolona
    expect((await dodajKategorie(a, { nazwa: 'Soki' }, USER)).ok).toBe(true)
    let rodzic = soki
    for (let d = 3; d <= MAX_GLEBOKOSC; d++) rodzic = await kat(a, `P${d}`, rodzic)
    expect(await dodajKategorie(a, { nazwa: 'Za głęboko', parentId: rodzic }, USER)).toMatchObject({
      ok: false,
      error: expect.stringContaining(`${MAX_GLEBOKOSC} poziomów`),
    })
  })

  it('zmiana nazwy przelicza ścieżki poddrzewa; kolejność rodzeństwa w górę i w dół', async () => {
    const n = await kat(a, 'Napoje')
    const s = await kat(a, 'Soki', n)
    await kat(a, 'Jabłkowe', s)
    const w = await kat(a, 'Wody', n)
    expect(await zmienNazweKategorii(a, n, 'Napoje zimne', USER)).toEqual({
      ok: true,
      value: { zmieniona: true },
    })
    expect(await zmienNazweKategorii(a, n, 'Napoje zimne', USER)).toEqual({
      ok: true,
      value: { zmieniona: false },
    })
    expect(await sciezki(a)).toEqual(['1:Napoje zimne', '2:Napoje zimne > Soki', '3:Napoje zimne > Soki > Jabłkowe', '2:Napoje zimne > Wody'])
    expect((await przesunKategorie(a, w, 'gora')).ok).toBe(true)
    expect(await sciezki(a)).toEqual(['1:Napoje zimne', '2:Napoje zimne > Wody', '2:Napoje zimne > Soki', '3:Napoje zimne > Soki > Jabłkowe'])
    expect(await przesunKategorie(a, w, 'gora')).toEqual({
      ok: true,
      value: { zmieniona: false },
    })
  })
})

describe('przeniesienie poddrzewa', () => {
  it('ścieżki i głębokości całego poddrzewa; cykl i przekroczenie 5 poziomów odrzucone bez zmian', async () => {
    const x = await kat(a, 'X')
    const y = await kat(a, 'Y')
    const y1 = await kat(a, 'Y1', y)
    const y2 = await kat(a, 'Y2', y1)
    expect(await przeniesKategorie(a, y, x, USER)).toEqual({
      ok: true,
      value: { zmieniona: true },
    })
    expect(await sciezki(a)).toEqual(['1:X', '2:X > Y', '3:X > Y > Y1', '4:X > Y > Y1 > Y2'])
    // cykl: do własnej podkategorii i do siebie
    expect(await przeniesKategorie(a, y, y2, USER)).toMatchObject({
      ok: false,
      error: expect.stringContaining('własnej podkategorii'),
    })
    expect(await przeniesKategorie(a, y, y, USER)).toMatchObject({ ok: false })
    // głębokość: Y z poddrzewem ma 3 poziomy (Y > Y1 > Y2). Pod Z2 (poziom 2) Y2 ląduje na 5 (OK), pod Z3 (poziom 3) na 6 (odmowa)
    const z = await kat(a, 'Z')
    const z2 = await kat(a, 'Z2', z)
    const z3 = await kat(a, 'Z3', z2)
    const przed = await sciezki(a)
    expect(await przeniesKategorie(a, y, z3, USER)).toMatchObject({
      ok: false,
      error: expect.stringContaining('więcej niż'),
    })
    expect(await sciezki(a)).toEqual(przed)
    expect((await przeniesKategorie(a, y, z2, USER)).ok).toBe(true)
    expect((await drzewoKategorii(a)).find((k) => k.id === y2)).toMatchObject({ path: 'Z > Z2 > Y > Y1 > Y2', depth: 5 })
    // na najwyższy poziom
    expect((await przeniesKategorie(a, y, null, USER)).ok).toBe(true)
    expect((await drzewoKategorii(a)).find((k) => k.id === y2)).toMatchObject({
      path: 'Y > Y1 > Y2',
      depth: 3,
    })
    const audyt = await a.auditLog.findMany({
      where: { entity: 'ProductCategory', entityId: y },
      orderBy: { createdAt: 'asc' },
    })
    expect(audyt.filter((r) => (r.after as { przeniesiona?: boolean }).przeniesiona)).toHaveLength(3)
  })
})

describe('przypisanie, filtr gałęzi, usunięcie z przeniesieniem', () => {
  it('przypisanie idempotentne (ponowienie = 0 zmian, źródło zostaje); filtr gałęzi po prefiksie, nie po LIKE', async () => {
    const h = await kat(a, 'Kubki 100%')
    const hz = await kat(a, 'Zielone_1', h)
    const inna = await kat(a, 'Kubki 1000') // prefiks tekstowy „Kubki 100” bez separatora: nie jest gałęzią
    const [p1, p2, p3, p4] = [await prod(a, 'K-1'), await prod(a, 'K-2'), await prod(a, 'K-3'), await prod(a, 'K-4')]
    expect(await przypiszKategorie(a, [p1, p2], hz, 'RECZNE', USER)).toEqual({
      ok: true,
      value: { zmienione: 2, bezZmian: 0 },
    })
    expect(await przypiszKategorie(a, [p1, p2], hz, 'CSV', USER)).toEqual({
      ok: true,
      value: { zmienione: 0, bezZmian: 2 },
    })
    expect((await a.product.findUniqueOrThrow({ where: { id: p1 } })).categorySource).toBe('RECZNE')
    await przypiszKategorie(a, [p3], h, 'RECZNE', USER)
    await przypiszKategorie(a, [p4], inna, 'RECZNE', USER)
    expect(await a.auditLog.count({ where: { entity: 'Product', entityId: p1 } })).toBeGreaterThanOrEqual(1)
    const ids = async (f: string | null) =>
      (
        await a.product.findMany({
          where: (await warunekKategorii(a, f)) ?? {},
          select: { sku: true },
          orderBy: { sku: 'asc' },
        })
      ).map((p) => p.sku)
    expect(await ids(h)).toEqual(['K-1', 'K-2', 'K-3'])
    expect(await ids(hz)).toEqual(['K-1', 'K-2'])
    expect(await ids(inna)).toEqual(['K-4'])
    expect(await ids('nieznanaKategoria1')).toEqual([])
    await przypiszKategorie(a, [p4], null, 'RECZNE', USER)
    expect(await ids('brak')).toEqual(['K-4'])
    expect((await a.product.findUniqueOrThrow({ where: { id: p4 } })).categorySource).toBeNull()
    expect(await znajdzKategorie(a, 'kubki 100% > ZIELONE_1')).toEqual({
      id: hz,
      path: 'Kubki 100% > Zielone_1',
    })
    expect(await znajdzKategorie(a, hz)).toMatchObject({ id: hz })
  })

  it('usunięcie: produkty do rodzica w jednej transakcji, źródło „USUNIECIE”, wpisy w historii; z podkategoriami odmowa', async () => {
    const r = await kat(a, 'Rodzic')
    const d = await kat(a, 'Dziecko', r)
    const w = await kat(a, 'Wnuk', d)
    const [p1, p2] = [await prod(a, 'U-1'), await prod(a, 'U-2')]
    await przypiszKategorie(a, [p1, p2], w, 'CSV', USER)
    expect(await usunKategorie(a, d, { typ: 'rodzic' }, USER)).toMatchObject({
      ok: false,
      error: expect.stringContaining('podkategorie'),
    })
    expect(await usunKategorie(a, w, { typ: 'rodzic' }, USER)).toEqual({
      ok: true,
      value: { przeniesione: 2, dokad: 'Rodzic > Dziecko' },
    })
    for (const id of [p1, p2]) {
      expect(await a.product.findUniqueOrThrow({ where: { id } })).toMatchObject({ categoryId: d, categorySource: 'USUNIECIE' })
      const wpis = await a.auditLog.findFirst({
        where: {
          entity: 'Product',
          entityId: id,
          after: { path: ['zUsunietej'], equals: true },
        },
      })
      expect(wpis?.before).toEqual({ kategoria: 'Rodzic > Dziecko > Wnuk' })
    }
    expect(
      await a.auditLog.findFirst({
        where: {
          entity: 'ProductCategory',
          entityId: w,
          after: { path: ['usunieta'], equals: true },
        },
      }),
    ).not.toBeNull()
    // korzeń z produktami: bez jawnego celu odmowa, z „bez kategorii” produkty tracą kategorię i źródło
    await przeniesKategorie(a, d, null, USER)
    expect(await usunKategorie(a, d, { typ: 'rodzic' }, USER)).toMatchObject({
      ok: false,
      error: expect.stringContaining('najwyższego poziomu'),
    })
    expect(await usunKategorie(a, d, { typ: 'kategoria', id: r }, USER)).toMatchObject({ ok: true, value: { przeniesione: 2, dokad: 'Rodzic' } })
    expect(await usunKategorie(a, r, { typ: 'brak' }, USER)).toMatchObject({
      ok: true,
      value: { przeniesione: 2, dokad: null },
    })
    expect(await a.product.findUniqueOrThrow({ where: { id: p1 } })).toMatchObject({ categoryId: null, categorySource: null })
    expect(await a.productCategory.count()).toBe(0)
  })

  it('kategorii z produktami nie skasuje kod z pominięciem usunKategorie (FK Restrict)', async () => {
    const k = await kat(a, 'Chroniona')
    await przypiszKategorie(a, [await prod(a, 'F-1')], k, 'RECZNE', USER)
    await expect(a.productCategory.delete({ where: { id: k } })).rejects.toThrow()
  })
})

describe('izolacja firm (RLS i klucze złożone)', () => {
  it('firma B nie widzi drzewa A, nie przypisze kategorii A ani przez kod, ani wprost w bazie', async () => {
    const ka = await kat(a, 'Tylko A')
    const kaPod = await kat(a, 'Pod A', ka)
    await kat(b, 'Tylko A') // ta sama nazwa w innej firmie jest dozwolona
    const pb = await prod(b, 'B-1')
    expect((await drzewoKategorii(b)).map((k) => k.path)).toEqual(['Tylko A'])
    expect(await b.productCategory.findUnique({ where: { id: ka } })).toBeNull()
    expect(await przypiszKategorie(b, [pb], ka, 'RECZNE', USER)).toMatchObject({
      ok: false,
    })
    expect(await dodajKategorie(b, { nazwa: 'Pod obcą', parentId: ka }, USER)).toMatchObject({ ok: false })
    expect(await przeniesKategorie(b, kaPod, null, USER)).toMatchObject({
      ok: false,
    })
    expect(await usunKategorie(b, kaPod, { typ: 'brak' }, USER)).toMatchObject({
      ok: false,
    })
    expect(await zmienNazweKategorii(b, ka, 'Przejęta', USER)).toMatchObject({
      ok: false,
    })
    expect(await warunekKategorii(b, ka)).toEqual({ categoryId: { in: [] } })
    // wprost w bazie: klucz złożony (firma, kategoria) odrzuca zapis i klientem firmy, i systemowym
    await expect(b.product.update({ where: { id: pb }, data: { categoryId: ka } })).rejects.toThrow()
    await expect(
      testSystemDb().product.update({
        where: { id: pb },
        data: { categoryId: ka },
      }),
    ).rejects.toThrow()
    await expect(
      testSystemDb().productCategory.update({
        where: { id: kaPod },
        data: { organizationId: ORG_B },
      }),
    ).rejects.toThrow()
    expect((await drzewoKategorii(a)).map((k) => k.path)).toEqual(['Tylko A', 'Tylko A > Pod A'])
    const leaks = await crossOrgLeaks()
    expect(leaks).toMatchObject({ produkt_kategoria: 0, kategoria_rodzic: 0 })
  })
})

describe('CSV: kolumna „Kategoria”', () => {
  it('ścieżka tworzy brakujące poziomy, „(brak)” czyści, pusta nic nie zmienia, ponowny import = 0 zmian', async () => {
    const { importCsv, eksportCsv } = await import('@/lib/produkty/csv')
    const plik = ['SKU;Nazwa;Kategoria', 'C-1;Pierwszy;Napoje > Soki', 'C-2;Drugi;napoje>soki', 'C-3;Trzeci;', 'C-4;Czwarty;Napoje > Wody > Gazowane'].join('\n')
    const r1 = await importCsv(a, plik, USER, { hasWfirma: false })
    if ('blad' in r1) throw new Error(r1.blad)
    expect(r1).toMatchObject({ nowe: 4, bledy: [] })
    expect(await sciezki(a)).toEqual(['1:Napoje', '2:Napoje > Soki', '2:Napoje > Wody', '3:Napoje > Wody > Gazowane'])
    const c = async (sku: string) =>
      a.product.findFirstOrThrow({
        where: { sku },
        select: { categorySource: true, category: { select: { path: true } } },
      })
    expect(await c('C-2')).toEqual({
      categorySource: 'CSV',
      category: { path: 'Napoje > Soki' },
    })
    expect((await c('C-3')).category).toBeNull()
    const r2 = await importCsv(a, plik, USER, { hasWfirma: false })
    expect(r2).toMatchObject({ nowe: 0, zmienione: 0, bezZmian: 4, bledy: [] })
    expect(await a.productCategory.count()).toBe(4)
    // eksport → import bez zmian (kolumna ze ścieżką wraca tą samą wartością)
    const { tekst } = await eksportCsv(a)
    expect(await importCsv(a, tekst, USER, { hasWfirma: false })).toMatchObject({ zmienione: 0, bezZmian: 4, bledy: [] })
    const r3 = await importCsv(a, 'SKU;Kategoria\nC-1;(brak)\nC-2;\nC-4;Nowa > Gałąź', USER, { hasWfirma: false, tworzKategorie: false })
    expect(r3).toMatchObject({
      zmienione: 1,
      bezZmian: 1,
      bledy: [{ sku: 'C-4', komunikat: expect.stringContaining('Nie ma kategorii') }],
    })
    expect((await c('C-1')).category).toBeNull()
    expect((await c('C-2')).category).toEqual({ path: 'Napoje > Soki' })
    expect((await c('C-4')).category).toEqual({
      path: 'Napoje > Wody > Gazowane',
    })
    expect(await a.productCategory.count()).toBe(4)
    const r4 = await importCsv(a, 'SKU;Kategoria\nC-1;A > > B\nC-2;A>B>C>D>E>F', USER, { hasWfirma: false })
    expect(r4).toMatchObject({
      zmienione: 0,
      bledy: [{ sku: 'C-1' }, { sku: 'C-2' }],
    })
  })

  it('kategoriaZeSciezki bez tworzenia: istniejąca bez wielkości liter, brakująca = błąd', async () => {
    const n = await kat(a, 'Napoje')
    const s = await kat(a, 'Soki', n)
    expect(
      await kategoriaZeSciezki(a, ['NAPOJE', 'soki'], {
        tworz: false,
        userId: USER,
      }),
    ).toEqual({ ok: true, value: { id: s, utworzone: 0 } })
    expect(
      await kategoriaZeSciezki(a, ['Napoje', 'Wody'], {
        tworz: false,
        userId: USER,
      }),
    ).toMatchObject({ ok: false })
  })
})

describe('poprawki po przeglądzie E1', () => {
  it('CSV: odrzucony wiersz z nową ścieżką nie zostawia kategorii (nowy bez nazwy, istniejący ze złą ceną)', async () => {
    const { importCsv } = await import('@/lib/produkty/csv')
    await prod(a, 'P-1')
    const r = await importCsv(a, 'SKU;Nazwa;Cena brutto;Kategoria\nP-NOWY;;10,00;Nowa > Gałąź\nP-1;;abc;Inna > Gałąź', USER, { hasWfirma: false })
    expect(r).toMatchObject({ nowe: 0, zmienione: 0, bledy: [{ sku: 'P-NOWY' }, { sku: 'P-1' }] })
    expect(await a.productCategory.count()).toBe(0)
    expect(await a.auditLog.count({ where: { entity: 'ProductCategory' } })).toBe(0)
    // ta sama ścieżka w kolejnym, poprawnym wierszu tego samego importu: poziomy powstają raz, po zapisie wiersza
    const r2 = await importCsv(a, 'SKU;Nazwa;Cena brutto;Kategoria\nP-NOWY;;10,00;Nowa > Gałąź\nP-2;Produkt;10,00;Nowa > Gałąź\nP-3;Produkt;10,00;nowa > gałąź', USER, { hasWfirma: false })
    expect(r2).toMatchObject({ nowe: 2, bledy: [{ sku: 'P-NOWY' }] })
    expect(await sciezki(a)).toEqual(['1:Nowa', '2:Nowa > Gałąź'])
  })

  it('limit kategorii: ścieżka z kilkoma brakującymi poziomami odrzucona w całości, nic nie powstaje', async () => {
    await a.productCategory.createMany({ data: Array.from({ length: MAX_KATEGORII - 1 }, (_, i) => ({ name: `K${i}`, path: `K${i}`, depth: 1, slug: `k${i}`, sortOrder: i })) })
    const r = await kategoriaZeSciezki(a, ['Nowa', 'Gałąź'], { tworz: true, userId: USER })
    expect(r).toMatchObject({ ok: false })
    expect(await a.productCategory.count()).toBe(MAX_KATEGORII - 1)
    const { importCsv } = await import('@/lib/produkty/csv')
    const c = await importCsv(a, 'SKU;Nazwa;Cena brutto;Kategoria\nL-1;Produkt;10,00;Nowa > Gałąź', USER, { hasWfirma: false })
    expect(c).toMatchObject({ nowe: 0, bledy: [{ sku: 'L-1' }] })
    expect(await a.productCategory.count()).toBe(MAX_KATEGORII - 1)
    // jeden brakujący poziom mieści się w limicie
    expect(await kategoriaZeSciezki(a, ['Nowa'], { tworz: true, userId: USER })).toMatchObject({ ok: true, value: { utworzone: 1 } })
  })

  it('nazwa „brak” odrzucona (filtr „bez kategorii”); licznik gałęzi liczy tylko aktywne produkty', async () => {
    expect(checkNazwaKategorii('Brak')).toMatchObject({ ok: false })
    expect(checkNazwaKategorii('Brakujące')).toMatchObject({ ok: true })
    const n = await kat(a, 'Napoje')
    const p1 = await prod(a, 'N-1')
    const p2 = await prod(a, 'N-2')
    await przypiszKategorie(a, [p1, p2], n, 'RECZNE', USER)
    await a.product.update({ where: { id: p2 }, data: { active: false } })
    expect((await drzewoKategorii(a)).find((k) => k.id === n)).toMatchObject({ produktow: 1, wGalezi: 1 })
  })
})

describe('API i MCP: pole kategoria i filtr', () => {
  it('produkty z kategorią i ścieżką; filtr po id, ścieżce (gałąź), „brak”; nieznana = pusto; inna firma nie widzi', async () => {
    const { parseProductSearch, searchProducts, productBySku } = await import('@/lib/api/produkty')
    const n = await kat(a, 'Napoje')
    const s = await kat(a, 'Soki', n)
    const [p1, p2] = [await prod(a, 'API-1'), await prod(a, 'API-2')]
    await prod(a, 'API-3')
    await przypiszKategorie(a, [p1], s, 'RECZNE', USER)
    await przypiszKategorie(a, [p2], n, 'RECZNE', USER)
    const skus = async (qs: string) => (await searchProducts(a, parseProductSearch(new URLSearchParams(qs)))).produkty.map((p) => p.sku)
    expect((await searchProducts(a, parseProductSearch(new URLSearchParams('fraza=API-1')))).produkty[0]!.kategoria).toEqual({ id: s, sciezka: 'Napoje > Soki' })
    expect(await skus(`kategoria=${n}`)).toEqual(['API-1', 'API-2'])
    expect(await skus('kategoria=napoje > soki')).toEqual(['API-1'])
    expect(await skus('kategoria=brak&fraza=API')).toEqual(['API-3'])
    expect(await skus('kategoria=Nie ma takiej')).toEqual([])
    expect((await productBySku(a, 'API-3'))!.kategoria).toBeNull()
    await prod(b, 'API-B')
    expect((await searchProducts(b, parseProductSearch(new URLSearchParams(`kategoria=${n}`)))).produkty).toEqual([])
  })
})
