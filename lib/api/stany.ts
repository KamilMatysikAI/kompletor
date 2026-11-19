// GET /api/v1/stany (zakres `stany:odczyt`): stan produktów po SKU albo po ofertach konta kanału
// (hurt-demo: produkt sklepu Woo → SKU, stan). Klient firmy klucza (RLS): inna firma nie istnieje.
//
// Pozycja: SKU, nazwa, rodzaj, jednostka, fizycznie, zarezerwowane, dostępne i aktywne oferty produktu. Dostępne =
// `availableOf` (fizycznie − zarezerwowane, nigdy poniżej 0) w magazynie domyślnym. Zestaw (BUNDLE) nie ma własnego
// stanu: dostępne = minimum po składnikach (`partsOf`) z dostępnych składnika / sztuk na zestaw — ta sama reguła co
// w runFanout (lib/rdzen/propagacja.ts), gdzie nie jest wydzielona do ponownego użycia; fizycznie i zarezerwowane
// zestawu = null. Produkt bez stanu (DIGITAL, e-book): `bezStanu: true` i bez liczb.
import type { Channel, PrismaClient, ProductKind, Unit } from '@prisma/client'
import { availableOf, type CatalogEntry, DEFAULT_WAREHOUSE, partsOf } from '@/lib/rdzen/stan'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { ApiInputError } from './odpowiedzi'

export const MAX_SKUS = 200
export const PAGE_SIZE = 200
// Kanały zamówień i ofert = rodziny z DEFAULT_CHANNEL_ADAPTER bez AI (nowy kanał, np. SHOPER, PRESTASHOP,
// nie wymaga dopisywania tutaj)
const CHANNELS: Channel[] = (Object.keys(DEFAULT_CHANNEL_ADAPTER) as Channel[]).filter((c) => c !== 'AI')

export interface StockOfferOut {
  kanal: Channel
  konto: string
  externalId: string
  sztukNaOferte: number
}

export type StockItemOut = {
  sku: string
  nazwa: string
  rodzaj: ProductKind
  jednostka: Unit
  oferty: StockOfferOut[]
} & ({ bezStanu: true } | { fizycznie: number | null; zarezerwowane: number | null; dostepne: number })

export interface StockQuery {
  skus?: string[]
  channel?: Channel
  channelAccountId?: string
  page: number
}

/** Parametry z adresu: `?sku=a,b` albo `?kanal=WOO&konto=sklep2&strona=N`. */
export function parseStockQuery(sp: URLSearchParams): StockQuery {
  const known = new Set(['sku', 'kanal', 'konto', 'strona'])
  for (const k of sp.keys()) if (!known.has(k)) throw new ApiInputError(`Nieznany parametr ${k}`, k)
  const skuRaw = sp.getAll('sku').join(',')
  const kanal = sp.get('kanal')
  const konto = sp.get('konto')
  const strona = sp.get('strona')
  if (skuRaw && (kanal || konto)) throw new ApiInputError('Podaj albo sku, albo kanal i konto')
  if (skuRaw) {
    if (strona) throw new ApiInputError('Parametr strona tylko z kanal i konto', 'strona')
    const skus = [...new Set(skuRaw.split(',').map((s) => s.trim()).filter(Boolean))]
    if (!skus.length) throw new ApiInputError('Pusta lista sku', 'sku')
    if (skus.length > MAX_SKUS) throw new ApiInputError(`Najwyżej ${MAX_SKUS} SKU w jednym żądaniu`, 'sku')
    if (skus.some((s) => s.length > 100)) throw new ApiInputError('SKU dłuższe niż 100 znaków', 'sku')
    return { skus, page: 1 }
  }
  if (!kanal || !konto) throw new ApiInputError('Podaj sku=<SKU,SKU…> albo kanal=<kanał>&konto=<konto>')
  if (!CHANNELS.includes(kanal as Channel)) throw new ApiInputError(`Nieznany kanał ${kanal}`, 'kanal')
  if (konto.length > 100) throw new ApiInputError('Za długie konto', 'konto')
  const page = strona === null ? 1 : Number(strona)
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new ApiInputError('strona: liczba całkowita od 1', 'strona')
  return { channel: kanal as Channel, channelAccountId: konto, page }
}

export interface StockResult {
  pozycje: StockItemOut[]
  nieznaneSku?: string[]
  strona?: number
  nastepnaStrona?: number | null
}

export async function readStock(db: PrismaClient, q: StockQuery): Promise<StockResult> {
  let ids: string[]
  let more = false
  if (q.skus) {
    ids = (await db.product.findMany({ where: { sku: { in: q.skus } }, select: { id: true } })).map((p) => p.id)
  } else {
    // produkty z aktywną ofertą konta, po SKU; strona po PAGE_SIZE produktów (+1 = czy jest następna)
    const rows = await db.product.findMany({
      where: { offers: { some: { channel: q.channel, channelAccountId: q.channelAccountId, active: true } } },
      select: { id: true },
      orderBy: [{ sku: 'asc' }, { id: 'asc' }],
      skip: (q.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
    })
    more = rows.length > PAGE_SIZE
    ids = rows.slice(0, PAGE_SIZE).map((r) => r.id)
  }
  const items = await stockItems(db, ids)
  if (q.skus) {
    const found = new Set(items.map((i) => i.sku))
    const order = new Map(q.skus.map((s, i) => [s, i]))
    items.sort((a, b) => order.get(a.sku)! - order.get(b.sku)!)
    return { pozycje: items, nieznaneSku: q.skus.filter((s) => !found.has(s)) }
  }
  return { pozycje: items, strona: q.page, nastepnaStrona: more ? q.page + 1 : null }
}

async function stockItems(db: PrismaClient, ids: string[]): Promise<StockItemOut[]> {
  if (!ids.length) return []
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      sku: true,
      title: true,
      kind: true,
      unit: true,
      bundleComponents: { select: { componentId: true, qtyBase: true } },
      offers: { where: { active: true }, select: { channel: true, channelAccountId: true, externalId: true, qtyBasePerOffer: true }, orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }, { externalId: 'asc' }] },
    },
    orderBy: [{ sku: 'asc' }, { id: 'asc' }],
  })
  const entries = new Map<string, CatalogEntry>(products.map((p) => [p.id, { id: p.id, kind: p.kind, components: p.kind === 'BUNDLE' ? p.bundleComponents : [] }]))
  const partIds = new Set<string>()
  for (const e of entries.values()) for (const part of partsOf(e)) partIds.add(part.productId)
  const stocks = new Map(
    (await db.stock.findMany({ where: { warehouseId: DEFAULT_WAREHOUSE, productId: { in: [...partIds] } }, select: { productId: true, physical: true, reserved: true } })).map((s) => [s.productId, s]),
  )
  const availOfPart = (id: string) => {
    const s = stocks.get(id)
    return s ? availableOf(s) : 0
  }
  return products.map((p) => {
    const base = {
      sku: p.sku,
      nazwa: p.title,
      rodzaj: p.kind,
      jednostka: p.unit,
      oferty: p.offers.map((o) => ({ kanal: o.channel, konto: o.channelAccountId, externalId: o.externalId, sztukNaOferte: o.qtyBasePerOffer })),
    }
    const entry = entries.get(p.id)!
    if (p.kind === 'DIGITAL') return { ...base, bezStanu: true as const }
    if (p.kind === 'BUNDLE') {
      const parts = partsOf(entry)
      const dostepne = parts.length ? Math.min(...parts.map((x) => Math.floor(availOfPart(x.productId) / Math.max(1, x.perUnit)))) : 0
      return { ...base, fizycznie: null, zarezerwowane: null, dostepne: Math.max(0, dostepne) }
    }
    const s = stocks.get(p.id)
    return { ...base, fizycznie: s?.physical ?? 0, zarezerwowane: s?.reserved ?? 0, dostepne: availOfPart(p.id) }
  })
}
