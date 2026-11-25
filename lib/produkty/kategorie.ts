// E1: kategorie produktów — drzewo kategorii firmy i kategoria produktu (jedna na produkt).
// Ekran: Produkty → przycisk „Kategorie” (app/(panel)/produkty/kategorie). Uprawnienie `produkty.dodawanie`.
//
// Uniwersalnie: drzewo, nazwy i przypisania to dane firmy; kod nie zna żadnej nazwy kategorii ani kanału. Firma bez
// kanału buduje drzewo ręcznie albo z pliku CSV (kolumna „Kategoria” ze ścieżką `A > B`); import z kanału (E3) dopisze
// tylko źródło przypisania KANAL.
//
// Zasady drzewa: rodzic + zapisana ścieżka nazw (`path`, separator „ > ”) + głębokość (1 = korzeń, najwyżej 5).
// Ścieżka i głębokość poddrzewa przeliczają się w tej samej transakcji przy zmianie nazwy i przeniesieniu; zmiany drzewa
// jednej firmy idą po kolei (blokada transakcyjna na firmę), więc dwa równoległe zapisy nie rozjadą ścieżek. Usunięcie:
// tylko kategoria bez podkategorii; jej produkty przechodzą do rodzica albo wskazanej kategorii (albo „bez kategorii”
// na jawny wybór) w tej samej transakcji, z wpisem w historii. FK `Restrict` nie pozwoli skasować kategorii z produktami
// żadnemu innemu kodowi. Każda zmiana: wpis w AuditLog (`ProductCategory` dla drzewa, `Product` dla przypisania).
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'

export const SEPARATOR = ' > '
export const MAX_GLEBOKOSC = 5
export const MAX_KATEGORII = 2000
export const NAZWA_KATEGORII_MAX = 80
/** Wartość komórki CSV oznaczająca „usuń kategorię produktu”. */
export const BEZ_KATEGORII = '(brak)'
/** Wartość filtra listy produktów i API: produkty bez kategorii. */
export const FILTR_BEZ_KATEGORII = 'brak'
export const MASOWO_MAX = 1000

/** Skąd przypisanie kategorii produktu: ręcznie (karta, lista), plik CSV, kanał sprzedaży (E3), przeprowadzka z BL,
 * przeniesienie przy usunięciu kategorii (produkt nie trzyma źródła usuniętej kategorii). */
export const ZRODLA_KATEGORII = ['RECZNE', 'CSV', 'KANAL', 'BL', 'USUNIECIE'] as const
export type ZrodloKategorii = (typeof ZRODLA_KATEGORII)[number]
export const ZRODLO_KATEGORII_LABEL: Record<ZrodloKategorii, string> = { RECZNE: 'ustawiona ręcznie', CSV: 'z pliku CSV', KANAL: 'z kategorii sklepu', BL: 'z BaseLinkera', USUNIECIE: 'przeniesiona przy usunięciu kategorii' }

const ID = /^[a-z0-9]{1,40}$/i
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

type Db = PrismaClient | Prisma.TransactionClient
export type Wynik<T> = { ok: true; value: T } | { ok: false; error: string }

// ─── Walidacja (czyste funkcje) ──────────────────────────────────────────────────────────────────────────────────────

/** Nazwa kategorii: 1–80 znaków po `trim` i złączeniu spacji, bez „>” (separator ścieżki) i znaków sterujących. */
export function checkNazwaKategorii(v: unknown): Wynik<string> {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  if (!s) return { ok: false, error: 'Podaj nazwę kategorii.' }
  if (s.length > NAZWA_KATEGORII_MAX) return { ok: false, error: `Nazwa kategorii może mieć najwyżej ${NAZWA_KATEGORII_MAX} znaków.` }
  if (s.includes('>')) return { ok: false, error: 'Nazwa kategorii nie może zawierać znaku „>” (oddziela poziomy w ścieżce, np. „Napoje > Soki”).' }
  if (CONTROL.test(s)) return { ok: false, error: 'Nazwa kategorii zawiera niedozwolony znak.' }
  if (s.toLowerCase() === BEZ_KATEGORII) return { ok: false, error: `„${BEZ_KATEGORII}” oznacza w pliku CSV produkt bez kategorii: wybierz inną nazwę.` }
  // „brak” to filtr „bez kategorii” w API i MCP (`kategoria=brak`): kategoria o tej nazwie byłaby nieosiągalna filtrem
  if (s.toLowerCase() === FILTR_BEZ_KATEGORII) return { ok: false, error: `„${FILTR_BEZ_KATEGORII}” oznacza w filtrze produkty bez kategorii: wybierz inną nazwę.` }
  return { ok: true, value: s }
}

/** Ścieżka „A > B > C” (spacje wokół „>” dowolne) → lista nazw; pusta = null; najwyżej 5 poziomów. */
export function parsujSciezke(v: string): Wynik<string[] | null> {
  const s = v.trim()
  if (!s) return { ok: true, value: null }
  const czesci = s.split('>').map((x) => x.replace(/\s+/g, ' ').trim())
  if (czesci.some((x) => !x)) return { ok: false, error: `Ścieżka kategorii „${s.slice(0, 120)}” ma pusty poziom (dwa „>” obok siebie albo „>” na początku lub końcu).` }
  if (czesci.length > MAX_GLEBOKOSC) return { ok: false, error: `Ścieżka kategorii może mieć najwyżej ${MAX_GLEBOKOSC} poziomów.` }
  for (const c of czesci) {
    const n = checkNazwaKategorii(c)
    if (!n.ok) return n
  }
  return { ok: true, value: czesci }
}

export const sciezka = (nazwy: readonly string[]) => nazwy.join(SEPARATOR)
const klucz = (s: string) => s.toLocaleLowerCase('pl')

/** Slug z nazwy (adresy, API): małe litery a–z, cyfry i myślniki, bez polskich znaków, do 60 znaków. */
export function slugKategorii(nazwa: string): string {
  const s = nazwa
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return s || 'kategoria'
}

// ─── Odczyt ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KategoriaWiersz {
  id: string
  parentId: string | null
  name: string
  slug: string
  path: string
  depth: number
  sortOrder: number
  /** produkty przypisane wprost do tej kategorii */
  produktow: number
  /** produkty w całej gałęzi (ta kategoria i podkategorie) */
  wGalezi: number
  podkategorii: number
}

/** Całe drzewo firmy w kolejności wyświetlania (rodzeństwo po `sortOrder`, potem nazwie), z liczbą produktów. */
export async function drzewoKategorii(db: Db): Promise<KategoriaWiersz[]> {
  const [rows, counts] = await Promise.all([
    db.productCategory.findMany({ select: { id: true, parentId: true, name: true, slug: true, path: true, depth: true, sortOrder: true } }),
    // tylko aktywne, jak domyślna lista `/produkty?kategoria=` i licznik „bez kategorii” (przegląd E1, uwaga 4)
    db.product.groupBy({ by: ['categoryId'], where: { categoryId: { not: null }, active: true }, _count: { _all: true } }),
  ])
  const ile = new Map(counts.map((c) => [c.categoryId!, c._count._all]))
  const dzieci = new Map<string | null, typeof rows>()
  for (const r of rows) dzieci.set(r.parentId, [...(dzieci.get(r.parentId) ?? []), r])
  for (const lista of dzieci.values()) lista.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pl'))
  const out: KategoriaWiersz[] = []
  const odwiedzone = new Set<string>()
  const wejdz = (parentId: string | null): number => {
    let suma = 0
    for (const r of dzieci.get(parentId) ?? []) {
      if (odwiedzone.has(r.id)) continue // cykl niemożliwy przez kod, ale odczyt nigdy się na nim nie zapętli
      odwiedzone.add(r.id)
      const w: KategoriaWiersz = { ...r, produktow: ile.get(r.id) ?? 0, wGalezi: 0, podkategorii: (dzieci.get(r.id) ?? []).length }
      out.push(w)
      w.wGalezi = w.produktow + wejdz(r.id)
      suma += w.wGalezi
    }
    return suma
  }
  wejdz(null)
  return out
}

/** Podkategorie (wszystkie poziomy) kategorii o ścieżce `path`, bez niej samej. Prefiks bez LIKE: nazwy mogą mieć „%” i „_”. */
async function poddrzewo(db: Db, path: string): Promise<{ id: string; path: string; depth: number }[]> {
  return db.$queryRaw<{ id: string; path: string; depth: number }[]>`
    SELECT id, path, depth FROM "ProductCategory" WHERE starts_with(path, ${path + SEPARATOR})`
}

/** Id kategorii i wszystkich jej podkategorii (filtr gałęzi po prefiksie ścieżki); pusta lista = nie ma takiej. */
export async function idsGalezi(db: Db, categoryId: string): Promise<string[]> {
  if (!ID.test(categoryId)) return []
  const k = await db.productCategory.findUnique({ where: { id: categoryId }, select: { id: true, path: true } })
  if (!k) return []
  return [k.id, ...(await poddrzewo(db, k.path)).map((r) => r.id)]
}

/** Kategoria po id albo po ścieżce (bez rozróżniania wielkości liter); null = nie ma. Dla filtrów API i MCP. */
export async function znajdzKategorie(db: Db, v: string): Promise<{ id: string; path: string } | null> {
  const s = v.trim()
  if (!s || s.length > 500) return null
  if (ID.test(s)) {
    const k = await db.productCategory.findUnique({ where: { id: s }, select: { id: true, path: true } })
    if (k) return k
  }
  const p = parsujSciezke(s)
  if (!p.ok || !p.value) return null
  return db.productCategory.findFirst({ where: { path: { equals: sciezka(p.value), mode: 'insensitive' } }, select: { id: true, path: true }, orderBy: { id: 'asc' } })
}

/**
 * Warunek listy produktów dla filtra kategorii: `brak` = bez kategorii, id = cała gałąź. Nieznana kategoria = zbiór
 * pusty (nie cała lista), żeby stary link po usunięciu kategorii nie pokazał wszystkiego.
 */
export async function warunekKategorii(db: Db, filtr: string | null | undefined): Promise<Prisma.ProductWhereInput | null> {
  if (!filtr) return null
  if (filtr === FILTR_BEZ_KATEGORII) return { categoryId: null }
  return { categoryId: { in: await idsGalezi(db, filtr) } }
}

// ─── Zapis drzewa ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Zmiany drzewa jednej firmy po kolei (ścieżki poddrzewa przeliczane bez wyścigu). */
async function blokadaDrzewa(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'kategorie:' + organizationId}, 0))) s`
}

const ZAJETA = (nazwa: string) => `Kategoria „${nazwa}” już jest na tym poziomie: wybierz inną nazwę albo innego rodzica.`

async function nazwaZajeta(tx: Db, parentId: string | null, nazwa: string, pominId?: string): Promise<boolean> {
  const r = await tx.productCategory.findFirst({ where: { parentId, name: { equals: nazwa, mode: 'insensitive' }, ...(pominId ? { id: { not: pominId } } : {}) }, select: { id: true } })
  return !!r
}

async function wolnySlug(tx: Db, baza: string): Promise<string> {
  // slug ma tylko a–z, 0–9 i „-”, więc prefiks nie zawiera znaków specjalnych wzorca
  const zajete = new Set((await tx.productCategory.findMany({ where: { slug: { startsWith: baza } }, select: { slug: true } })).map((r) => r.slug))
  if (!zajete.has(baza)) return baza
  for (let i = 2; ; i++) if (!zajete.has(`${baza}-${i}`)) return `${baza}-${i}`
}

async function nastepnaKolejnosc(tx: Db, parentId: string | null): Promise<number> {
  const r = await tx.productCategory.aggregate({ where: { parentId }, _max: { sortOrder: true } })
  return (r._max.sortOrder ?? 0) + 10
}

/** Zakłada kategorię w transakcji (blokadę bierze wołający). */
async function utworz(tx: Prisma.TransactionClient, nazwa: string, rodzic: { id: string; path: string; depth: number } | null, userId: string): Promise<{ id: string; path: string; depth: number }> {
  const path = rodzic ? `${rodzic.path}${SEPARATOR}${nazwa}` : nazwa
  const depth = rodzic ? rodzic.depth + 1 : 1
  const slug = await wolnySlug(tx, slugKategorii(path.replaceAll(SEPARATOR, ' ')))
  const k = await tx.productCategory.create({
    data: { name: nazwa, parentId: rodzic?.id ?? null, path, depth, slug, sortOrder: await nastepnaKolejnosc(tx, rodzic?.id ?? null) },
    select: { id: true, path: true, depth: true },
  })
  await tx.auditLog.create({ data: { entity: 'ProductCategory', entityId: k.id, actorId: userId, after: { dodana: true, sciezka: path } } })
  return k
}

async function limitKategorii(tx: Db, nowych: number): Promise<string | null> {
  const n = await tx.productCategory.count()
  return n + nowych > MAX_KATEGORII ? `Firma może mieć najwyżej ${MAX_KATEGORII} kategorii.` : null
}

/** Wyścig mimo blokady (np. inny proces bez blokady): unikalna nazwa wśród rodzeństwa = zwykły komunikat. */
const zP2002 = async <T>(f: () => Promise<Wynik<T>>, nazwa: string): Promise<Wynik<T>> => {
  try {
    return await f()
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return { ok: false, error: ZAJETA(nazwa) }
    throw e
  }
}

export async function dodajKategorie(db: PrismaClient, input: { nazwa: unknown; parentId?: string | null }, userId: string): Promise<Wynik<{ id: string }>> {
  const n = checkNazwaKategorii(input.nazwa)
  if (!n.ok) return n
  const parentId = input.parentId || null
  if (parentId && !ID.test(parentId)) return { ok: false, error: 'Nie ma takiej kategorii nadrzędnej.' }
  const org = organizationIdOf(db)
  return zP2002(
    () =>
      db.$transaction(async (tx) => {
        await blokadaDrzewa(tx, org)
        const rodzic = parentId ? await tx.productCategory.findUnique({ where: { id: parentId }, select: { id: true, path: true, depth: true } }) : null
        if (parentId && !rodzic) return { ok: false as const, error: 'Nie ma takiej kategorii nadrzędnej (odśwież stronę).' }
        if (rodzic && rodzic.depth >= MAX_GLEBOKOSC) return { ok: false as const, error: `Drzewo może mieć najwyżej ${MAX_GLEBOKOSC} poziomów.` }
        const limit = await limitKategorii(tx, 1)
        if (limit) return { ok: false as const, error: limit }
        if (await nazwaZajeta(tx, parentId, n.value)) return { ok: false as const, error: ZAJETA(n.value) }
        const k = await utworz(tx, n.value, rodzic, userId)
        return { ok: true as const, value: { id: k.id } }
      }),
    n.value,
  )
}

/** Ścieżka i głębokość poddrzewa po zmianie ścieżki jego korzenia (`stara` → `nowa`, głębokość o `delta`). */
async function przeliczPoddrzewo(tx: Prisma.TransactionClient, stara: string, nowa: string, delta: number): Promise<void> {
  for (const r of await poddrzewo(tx, stara)) await tx.productCategory.update({ where: { id: r.id }, data: { path: nowa + r.path.slice(stara.length), depth: r.depth + delta } })
}

export async function zmienNazweKategorii(db: PrismaClient, id: string, nazwa: unknown, userId: string): Promise<Wynik<{ zmieniona: boolean }>> {
  const n = checkNazwaKategorii(nazwa)
  if (!n.ok) return n
  if (!ID.test(id)) return { ok: false, error: 'Nie ma takiej kategorii.' }
  const org = organizationIdOf(db)
  return zP2002<{ zmieniona: boolean }>(
    () =>
      db.$transaction(async (tx) => {
        await blokadaDrzewa(tx, org)
        const k = await tx.productCategory.findUnique({ where: { id }, select: { name: true, path: true, parentId: true } })
        if (!k) return { ok: false as const, error: 'Nie ma takiej kategorii (odśwież stronę).' }
        if (k.name === n.value) return { ok: true as const, value: { zmieniona: false } }
        if (await nazwaZajeta(tx, k.parentId, n.value, id)) return { ok: false as const, error: ZAJETA(n.value) }
        const nowa = k.path.slice(0, k.path.length - k.name.length) + n.value
        await tx.productCategory.update({ where: { id }, data: { name: n.value, path: nowa } })
        await przeliczPoddrzewo(tx, k.path, nowa, 0)
        await tx.auditLog.create({ data: { entity: 'ProductCategory', entityId: id, actorId: userId, before: { sciezka: k.path }, after: { sciezka: nowa } } })
        return { ok: true as const, value: { zmieniona: true } }
      }),
    n.value,
  )
}

/** Przeniesienie kategorii (z poddrzewem) pod innego rodzica albo na najwyższy poziom (`parentId` null). */
export async function przeniesKategorie(db: PrismaClient, id: string, parentId: string | null, userId: string): Promise<Wynik<{ zmieniona: boolean }>> {
  if (!ID.test(id) || (parentId !== null && !ID.test(parentId))) return { ok: false, error: 'Nie ma takiej kategorii.' }
  if (parentId === id) return { ok: false, error: 'Kategoria nie może być swoją kategorią nadrzędną.' }
  const org = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    await blokadaDrzewa(tx, org)
    const k = await tx.productCategory.findUnique({ where: { id }, select: { name: true, path: true, depth: true, parentId: true } })
    if (!k) return { ok: false as const, error: 'Nie ma takiej kategorii (odśwież stronę).' }
    if (k.parentId === parentId) return { ok: true as const, value: { zmieniona: false } }
    const rodzic = parentId ? await tx.productCategory.findUnique({ where: { id: parentId }, select: { id: true, path: true, depth: true } }) : null
    if (parentId && !rodzic) return { ok: false as const, error: 'Nie ma takiej kategorii nadrzędnej (odśwież stronę).' }
    if (rodzic && (rodzic.path === k.path || rodzic.path.startsWith(k.path + SEPARATOR))) return { ok: false as const, error: 'Kategorii nie da się przenieść do jej własnej podkategorii.' }
    const pod = await poddrzewo(tx, k.path)
    const wysokosc = Math.max(k.depth, ...pod.map((r) => r.depth)) - k.depth // ile poziomów pod przenoszoną
    const nowaGlebokosc = rodzic ? rodzic.depth + 1 : 1
    if (nowaGlebokosc + wysokosc > MAX_GLEBOKOSC) return { ok: false as const, error: `Po przeniesieniu drzewo miałoby więcej niż ${MAX_GLEBOKOSC} poziomów.` }
    if (await nazwaZajeta(tx, parentId, k.name, id)) return { ok: false as const, error: ZAJETA(k.name) }
    const nowa = rodzic ? `${rodzic.path}${SEPARATOR}${k.name}` : k.name
    await tx.productCategory.update({ where: { id }, data: { parentId, path: nowa, depth: nowaGlebokosc, sortOrder: await nastepnaKolejnosc(tx, parentId) } })
    await przeliczPoddrzewo(tx, k.path, nowa, nowaGlebokosc - k.depth)
    await tx.auditLog.create({ data: { entity: 'ProductCategory', entityId: id, actorId: userId, before: { sciezka: k.path }, after: { sciezka: nowa, przeniesiona: true } } })
    return { ok: true as const, value: { zmieniona: true } }
  })
}

/** Kolejność wśród rodzeństwa: o jedno miejsce w górę albo w dół. */
export async function przesunKategorie(db: PrismaClient, id: string, kierunek: 'gora' | 'dol'): Promise<Wynik<{ zmieniona: boolean }>> {
  if (!ID.test(id)) return { ok: false, error: 'Nie ma takiej kategorii.' }
  const org = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    await blokadaDrzewa(tx, org)
    const k = await tx.productCategory.findUnique({ where: { id }, select: { parentId: true } })
    if (!k) return { ok: false as const, error: 'Nie ma takiej kategorii (odśwież stronę).' }
    const rodzenstwo = (await tx.productCategory.findMany({ where: { parentId: k.parentId }, select: { id: true, name: true, sortOrder: true } })).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pl'),
    )
    const i = rodzenstwo.findIndex((r) => r.id === id)
    const j = kierunek === 'gora' ? i - 1 : i + 1
    if (i < 0 || j < 0 || j >= rodzenstwo.length) return { ok: true as const, value: { zmieniona: false } }
    ;[rodzenstwo[i], rodzenstwo[j]] = [rodzenstwo[j]!, rodzenstwo[i]!]
    for (const [n, r] of rodzenstwo.entries()) if (r.sortOrder !== (n + 1) * 10) await tx.productCategory.update({ where: { id: r.id }, data: { sortOrder: (n + 1) * 10 } })
    return { ok: true as const, value: { zmieniona: true } }
  })
}

/** Gdzie trafiają produkty usuwanej kategorii. */
export type CelUsuniecia = { typ: 'rodzic' } | { typ: 'kategoria'; id: string } | { typ: 'brak' }

/**
 * Usunięcie kategorii bez podkategorii. Produkty przechodzą do celu w tej samej transakcji (z wpisem w historii każdego
 * produktu); kategoria najwyższego poziomu z produktami wymaga jawnego celu (inna kategoria albo „bez kategorii”).
 */
export async function usunKategorie(db: PrismaClient, id: string, cel: CelUsuniecia, userId: string): Promise<Wynik<{ przeniesione: number; dokad: string | null }>> {
  if (!ID.test(id) || (cel.typ === 'kategoria' && !ID.test(cel.id))) return { ok: false, error: 'Nie ma takiej kategorii.' }
  if (cel.typ === 'kategoria' && cel.id === id) return { ok: false, error: 'Wybierz dla produktów inną kategorię niż usuwana.' }
  const org = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    await blokadaDrzewa(tx, org)
    const k = await tx.productCategory.findUnique({ where: { id }, select: { path: true, parentId: true, _count: { select: { children: true, products: true } } } })
    if (!k) return { ok: false as const, error: 'Nie ma takiej kategorii (odśwież stronę).' }
    if (k._count.children > 0) return { ok: false as const, error: 'Kategoria ma podkategorie: najpierw je przenieś albo usuń.' }
    let celKat: { id: string; path: string } | null = null
    if (cel.typ === 'kategoria') {
      celKat = await tx.productCategory.findUnique({ where: { id: cel.id }, select: { id: true, path: true } })
      if (!celKat) return { ok: false as const, error: 'Nie ma kategorii wybranej dla produktów (odśwież stronę).' }
    } else if (cel.typ === 'rodzic' && k.parentId) {
      celKat = await tx.productCategory.findUnique({ where: { id: k.parentId }, select: { id: true, path: true } })
    } else if (cel.typ === 'rodzic' && k._count.products > 0) {
      return { ok: false as const, error: 'Kategoria najwyższego poziomu nie ma kategorii nadrzędnej: wybierz, dokąd przenieść jej produkty (inna kategoria albo „bez kategorii”).' }
    }
    const produkty = await tx.product.findMany({ where: { categoryId: id }, select: { id: true } })
    if (produkty.length) {
      const teraz = new Date()
      await tx.product.updateMany({
        where: { categoryId: id },
        data: celKat ? { categoryId: celKat.id, categorySource: 'USUNIECIE' satisfies ZrodloKategorii, categorySetAt: teraz } : { categoryId: null, categorySource: null, categorySetAt: teraz },
      })
      await tx.auditLog.createMany({
        data: produkty.map((p) => ({ entity: 'Product', entityId: p.id, actorId: userId, before: { kategoria: k.path }, after: { kategoria: celKat?.path ?? null, zUsunietej: true } })),
      })
    }
    await tx.productCategory.delete({ where: { id } })
    await tx.auditLog.create({ data: { entity: 'ProductCategory', entityId: id, actorId: userId, before: { sciezka: k.path }, after: { usunieta: true, produktow: produkty.length, przeniesioneDo: celKat?.path ?? null } } })
    return { ok: true as const, value: { przeniesione: produkty.length, dokad: celKat?.path ?? null } }
  })
}

// ─── Przypisanie produktów ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Kategoria dla produktów (karta: jeden, lista: zaznaczone, CSV: wiersz). `categoryId` null = bez kategorii. Zmienia
 * tylko produkty z inną kategorią (ponowienie = 0 zmian, źródło przypisania zostaje), z wpisem w historii każdego
 * zmienionego produktu. Jedna transakcja na wywołanie.
 */
export async function przypiszKategorie(db: PrismaClient, productIds: readonly string[], categoryId: string | null, zrodlo: ZrodloKategorii, userId: string): Promise<Wynik<{ zmienione: number; bezZmian: number }>> {
  const ids = [...new Set(productIds)]
  if (!ids.length) return { ok: false, error: 'Zaznacz produkty.' }
  if (ids.length > MASOWO_MAX) return { ok: false, error: `Najwyżej ${MASOWO_MAX} produktów naraz.` }
  if (ids.some((i) => !ID.test(i)) || (categoryId !== null && !ID.test(categoryId))) return { ok: false, error: 'Nie ma takiego produktu albo kategorii.' }
  if (!(ZRODLA_KATEGORII as readonly string[]).includes(zrodlo)) return { ok: false, error: 'Nieznane źródło przypisania.' }
  return db.$transaction(async (tx) => {
    const kat = categoryId ? await tx.productCategory.findUnique({ where: { id: categoryId }, select: { id: true, path: true } }) : null
    if (categoryId && !kat) return { ok: false as const, error: 'Nie ma takiej kategorii (odśwież stronę).' }
    const produkty = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, categoryId: true, category: { select: { path: true } } } })
    if (produkty.length !== ids.length) return { ok: false as const, error: 'Któregoś produktu nie ma w katalogu (odśwież stronę).' }
    const zmiana = produkty.filter((p) => p.categoryId !== categoryId)
    if (zmiana.length) {
      await tx.product.updateMany({ where: { id: { in: zmiana.map((p) => p.id) } }, data: { categoryId, categorySource: categoryId ? zrodlo : null, categorySetAt: new Date() } })
      await tx.auditLog.createMany({
        data: zmiana.map((p) => ({ entity: 'Product', entityId: p.id, actorId: userId, before: { kategoria: p.category?.path ?? null }, after: { kategoria: kat?.path ?? null } })),
      })
    }
    return { ok: true as const, value: { zmienione: zmiana.length, bezZmian: produkty.length - zmiana.length } }
  })
}

type Poziom = { id: string; path: string; depth: number }

/** Istniejące poziomy ścieżki od korzenia (bez rozróżniania wielkości liter), aż do pierwszego brakującego. */
async function istniejacePoziomy(db: Db, nazwy: readonly string[]): Promise<Poziom[]> {
  const out: Poziom[] = []
  for (const nazwa of nazwy) {
    const jest: Poziom | null = await db.productCategory.findFirst({
      where: { parentId: out.at(-1)?.id ?? null, name: { equals: nazwa, mode: 'insensitive' } },
      select: { id: true, path: true, depth: true },
      orderBy: { id: 'asc' },
    })
    if (!jest) break
    out.push(jest)
  }
  return out
}

const NIE_MA_SCIEZKI = (nazwy: readonly string[]) => `Nie ma kategorii „${sciezka(nazwy)}”: dodaj ją na ekranie „Kategorie” albo zaznacz „Twórz brakujące kategorie”.`

/**
 * Sprawdzenie ścieżki bez zapisu (CSV przed zapisem wiersza): id istniejącej kategorii albo liczba poziomów do
 * założenia. Odmawia, gdy brakuje poziomów, a tworzenie jest wyłączone, albo gdy nowe poziomy przekroczą limit firmy.
 */
export async function sprawdzSciezke(db: Db, nazwy: readonly string[], opts: { tworz: boolean; pamiec?: Map<string, string> }): Promise<Wynik<{ id: string | null; brakuje: number }>> {
  const z = opts.pamiec?.get(klucz(sciezka(nazwy)))
  if (z) return { ok: true, value: { id: z, brakuje: 0 } }
  const jest = await istniejacePoziomy(db, nazwy)
  const brakuje = nazwy.length - jest.length
  if (!brakuje) return { ok: true, value: { id: jest.at(-1)!.id, brakuje: 0 } }
  if (!opts.tworz) return { ok: false, error: NIE_MA_SCIEZKI(nazwy) }
  const limit = await limitKategorii(db, brakuje)
  return limit ? { ok: false, error: limit } : { ok: true, value: { id: null, brakuje } }
}

/**
 * Kategoria ze ścieżki nazw (CSV): istniejąca (bez rozróżniania wielkości liter) albo, przy `tworz`, założona razem
 * z brakującymi poziomami. Wszystko albo nic: brakujące poziomy liczone pod blokadą drzewa przed pierwszym zapisem,
 * więc limit firmy odmawia całej ścieżki, zanim powstanie pierwszy poziom (przegląd E1, uwaga 2).
 * `pamiec` = ścieżka (małe litery) → id w obrębie jednego importu; wpis dopiero po zatwierdzonej transakcji.
 */
export async function kategoriaZeSciezki(db: PrismaClient, nazwy: readonly string[], opts: { tworz: boolean; userId: string; pamiec?: Map<string, string> }): Promise<Wynik<{ id: string; utworzone: number }>> {
  const pelna = klucz(sciezka(nazwy))
  const z = opts.pamiec?.get(pelna)
  if (z) return { ok: true, value: { id: z, utworzone: 0 } }
  const org = organizationIdOf(db)
  const r = await zP2002(
    () =>
      db.$transaction(async (tx) => {
        await blokadaDrzewa(tx, org)
        const jest = await istniejacePoziomy(tx, nazwy)
        const brakuje = nazwy.slice(jest.length)
        let rodzic: Poziom | null = jest.at(-1) ?? null
        if (!brakuje.length) return { ok: true as const, value: { id: rodzic!.id, utworzone: 0 } }
        if (!opts.tworz) return { ok: false as const, error: NIE_MA_SCIEZKI(nazwy) }
        const limit = await limitKategorii(tx, brakuje.length)
        if (limit) return { ok: false as const, error: limit }
        for (const nazwa of brakuje) rodzic = await utworz(tx, nazwa, rodzic, opts.userId)
        return { ok: true as const, value: { id: rodzic!.id, utworzone: brakuje.length } }
      }),
    nazwy.at(-1) ?? '',
  )
  if (r.ok) opts.pamiec?.set(pelna, r.value.id)
  return r
}
