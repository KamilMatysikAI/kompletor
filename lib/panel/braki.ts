// Lista „Brakuje” na ekranie Braki towaru: otwarte braki (OPEN, SHIP_LATER), domyślnie bez
// zamówień zamkniętych (wysłane, odebrane, anulowane), z wyszukiwarką (produkt, SKU, numer zamówienia), widokiem po
// produkcie (suma braków i liczba zamówień) albo po zamówieniu, sortowaniem i stronami. Decyzje masowe: wiele pozycji
// naraz przez `zdecydujOBraku` — każda pozycja osobno (błąd jednej nie zatrzymuje reszty), wynik zbiorczo.
//
// Dlaczego nie OPEN_SHORTAGE: tamta definicja (menu, pulpit, API) liczy też REFUND_PENDING, czyli braki paczek, które
// już wyszły (zwrot do zrobienia). Te są na liście „Do zwrotu”; na „Brakuje” zostaje to, o czym da się jeszcze
// zdecydować. Demo dodatkowo zostawiało OPEN przy zamówieniach „Wysłane” (status zmieniany bez pakowania;
// poprawione w lib/instalacja/demo.ts).
import type { Channel, OrderStatus, PrismaClient, Prisma, ShortageAction } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { BladStanowiska } from '@/lib/stanowisko/cwiczenie'
import { zdecydujOBraku } from '@/lib/stanowisko/decyzje'
import { productInfo } from './dane'

type Db = PrismaClient

export const BRAK_DO_DECYZJI = ['OPEN', 'SHIP_LATER'] as const
export const ZAMKNIETE: OrderStatus[] = ['WYSLANE', 'ODEBRANE', 'ANULOWANE']
/** Decyzje dostępne masowo i w wierszu (zamiana wymaga SKU zamiennika: tylko na karcie zamówienia). */
export const DECYZJE_MASOWE: ShortageAction[] = ['WYSLIJ_RESZTE', 'DOSLIJ', 'POCZEKAJ']

export type WidokBrakow = 'produkty' | 'zamowienia'

export interface PozycjaBraku {
  id: string
  orderLineId: string
  productId: string
  qtyBase: number
  state: string
  createdAt: Date
  order: { id: string; channel: Channel; channelAccountId: string; externalId: string; status: OrderStatus }
  title: string
  sku: string
  unit: string
  decyzja: { action: ShortageAction; dryRun: boolean } | null
}

export interface GrupaBrakow {
  productId: string
  title: string
  sku: string
  unit: string
  qty: number
  zamowien: number
  pozycje: number
  najstarszy: Date
  decyzje: Partial<Record<ShortageAction | 'BRAK', number>>
  /** id pozycji zamówień (do decyzji dla całej grupy) */
  linie: string[]
}

export interface FiltryBrakow {
  q?: string
  zamkniete?: boolean
  widok: WidokBrakow
}

/** Najwięcej pozycji na liście naraz (ekran pokazuje, ile jest wszystkich, gdy więcej). */
export const LIMIT_LISTY = 2000

/**
 * Warunek listy: szukanie po nazwie i SKU produktu oraz numerze zamówienia w bazie, nie w
 * pamięci, więc przy dowolnej liczbie braków licznik i wyszukiwarka widzą wszystkie. `zamkniete` = także zamówienia
 * wysłane, odebrane i anulowane.
 */
async function warunekBrakow(db: Db, f: Pick<FiltryBrakow, 'q' | 'zamkniete'>): Promise<Prisma.ShortageWhereInput> {
  const where: Prisma.ShortageWhereInput = { state: { in: [...BRAK_DO_DECYZJI] }, ...(f.zamkniete ? {} : { order: { status: { notIn: ZAMKNIETE } } }) }
  const q = f.q?.trim().slice(0, 100)
  if (!q) return where
  const zawiera = { contains: q, mode: 'insensitive' as const }
  const produkty = await db.product.findMany({ where: { OR: [{ title: zawiera }, { sku: zawiera }, { nameAccounting: zawiera }] }, select: { id: true }, take: 5000 })
  return { AND: [where, { OR: [{ productId: { in: produkty.map((x) => x.id) } }, { order: { externalId: zawiera } }] }] }
}

/** Liczba braków do decyzji (te same filtry co lista, bez limitu listy). */
export async function liczbaBrakow(db: Db, f: Pick<FiltryBrakow, 'q' | 'zamkniete'> = {}): Promise<number> {
  organizationIdOf(db)
  return db.shortage.count({ where: await warunekBrakow(db, f) })
}

/** Braki do decyzji przy zamówieniach zamkniętych, których lista „tylko otwarte” nie pokazuje. */
export async function ukrytePrzyZamknietych(db: Db, f: Pick<FiltryBrakow, 'q'> = {}): Promise<number> {
  organizationIdOf(db)
  const w = await warunekBrakow(db, { ...f, zamkniete: true })
  return db.shortage.count({ where: { AND: [w, { order: { status: { in: ZAMKNIETE } } }] } })
}

export async function pozycjeBrakow(db: Db, f: Pick<FiltryBrakow, 'q' | 'zamkniete'>): Promise<PozycjaBraku[]> {
  organizationIdOf(db)
  const where = await warunekBrakow(db, f)
  const rows = await db.shortage.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: LIMIT_LISTY,
    select: { id: true, orderLineId: true, productId: true, qtyBase: true, state: true, createdAt: true, order: { select: { id: true, channel: true, channelAccountId: true, externalId: true, status: true } } },
  })
  const [info, decyzje] = await Promise.all([
    productInfo(db, rows.map((r) => r.productId)),
    rows.length ? db.shortageDecision.findMany({ where: { orderLineId: { in: [...new Set(rows.map((r) => r.orderLineId))] } }, select: { orderLineId: true, action: true, dryRun: true } }) : [],
  ])
  const dec = new Map(decyzje.map((d) => [d.orderLineId, { action: d.action, dryRun: d.dryRun }]))
  return rows.map((r) => {
    const p = info.get(r.productId)
    return { ...r, title: p?.title ?? 'produkt', sku: p?.sku ?? '', unit: p?.unit ?? 'SZT', decyzja: dec.get(r.orderLineId) ?? null }
  })
}

export function grupujPoProdukcie(pozycje: readonly PozycjaBraku[]): GrupaBrakow[] {
  const m = new Map<string, GrupaBrakow & { _z: Set<string> }>()
  for (const p of pozycje) {
    let g = m.get(p.productId)
    if (!g) {
      g = { productId: p.productId, title: p.title, sku: p.sku, unit: p.unit, qty: 0, zamowien: 0, pozycje: 0, najstarszy: p.createdAt, decyzje: {}, linie: [], _z: new Set() }
      m.set(p.productId, g)
    }
    g.qty += p.qtyBase
    g.pozycje++
    g._z.add(p.order.id)
    if (p.createdAt < g.najstarszy) g.najstarszy = p.createdAt
    const k = p.decyzja?.action ?? 'BRAK'
    g.decyzje[k] = (g.decyzje[k] ?? 0) + 1
    if (!g.linie.includes(p.orderLineId)) g.linie.push(p.orderLineId)
  }
  return [...m.values()].map(({ _z, ...g }) => ({ ...g, zamowien: _z.size }))
}

type Kierunek = 'rosnaco' | 'malejaco'
const cmp = (a: number | string, b: number | string) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'pl'))

export function sortujGrupy(g: GrupaBrakow[], sort: { klucz: string; kierunek: Kierunek }): GrupaBrakow[] {
  const k = (x: GrupaBrakow): number | string => (sort.klucz === 'produkt' ? x.title : sort.klucz === 'zamowien' ? x.zamowien : sort.klucz === 'od' ? x.najstarszy.getTime() : x.qty)
  const s = [...g].sort((a, b) => cmp(k(a), k(b)) || a.title.localeCompare(b.title, 'pl'))
  return sort.kierunek === 'malejaco' ? s.reverse() : s
}

export function sortujPozycje(p: PozycjaBraku[], sort: { klucz: string; kierunek: Kierunek }): PozycjaBraku[] {
  const k = (x: PozycjaBraku): number | string => (sort.klucz === 'produkt' ? x.title : sort.klucz === 'brakuje' ? x.qtyBase : sort.klucz === 'zamowienie' ? x.order.externalId : x.createdAt.getTime())
  const s = [...p].sort((a, b) => cmp(k(a), k(b)) || a.id.localeCompare(b.id))
  return sort.kierunek === 'malejaco' ? s.reverse() : s
}

export interface WynikMasowy {
  zapisane: number
  bezZmian: number
  /** pozycje ponad limit jednego zapisu: do zapisania kolejnym kliknięciem */
  pominiete: number
  bledy: { orderLineId: string; komunikat: string }[]
}

/** Najwięcej pozycji w jednym zapisie decyzji masowej. */
export const LIMIT_MASOWY = 500

/**
 * Decyzja dla wielu pozycji: każda osobno, odmowa jednej (np. paczka już wyszła) nie zatrzymuje pozostałych.
 * pozycje, które już mają tę decyzję, liczą się od razu jako „bez zmian” i nie zajmują miejsca w
 * porcji, więc kolejne kliknięcie dla tej samej grupy bierze następne {@link LIMIT_MASOWY} pozycji, aż do końca.
 */
export async function zdecydujMasowo(db: Db, orderLineIds: readonly string[], akcja: ShortageAction, userId: string): Promise<WynikMasowy> {
  organizationIdOf(db)
  if (!DECYZJE_MASOWE.includes(akcja)) throw new BladStanowiska('Tej decyzji nie da się zapisać dla wielu pozycji naraz')
  const wszystkie = [...new Set(orderLineIds.filter((x) => /^[a-z0-9]{1,40}$/i.test(x)))]
  const juz = new Set<string>()
  for (let i = 0; i < wszystkie.length; i += 1000) {
    const porcja = wszystkie.slice(i, i + 1000)
    for (const d of await db.shortageDecision.findMany({ where: { orderLineId: { in: porcja }, action: akcja, replacementProductId: null }, select: { orderLineId: true } })) juz.add(d.orderLineId)
  }
  const doZapisu = wszystkie.filter((x) => !juz.has(x))
  const ids = doZapisu.slice(0, LIMIT_MASOWY)
  const w: WynikMasowy = { zapisane: 0, bezZmian: juz.size, pominiete: doZapisu.length - ids.length, bledy: [] }
  for (const orderLineId of ids) {
    try {
      const r = await zdecydujOBraku(db, { orderLineId, akcja, userId })
      if (r.zmiana) w.zapisane++
      else w.bezZmian++
    } catch (e) {
      w.bledy.push({ orderLineId, komunikat: e instanceof BladStanowiska ? e.message : 'Nie udało się zapisać' })
    }
  }
  return w
}

/** Pozycje zamówień grup produktów (decyzja „dla całej grupy”) z tymi samymi filtrami co lista. */
export async function linieProduktow(db: Db, productIds: readonly string[], f: Pick<FiltryBrakow, 'q' | 'zamkniete'>): Promise<string[]> {
  const ids = new Set(productIds)
  return [...new Set((await pozycjeBrakow(db, f)).filter((p) => ids.has(p.productId)).map((p) => p.orderLineId))]
}
