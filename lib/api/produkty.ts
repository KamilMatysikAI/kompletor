// GET /api/v1/produkty i /api/v1/produkty/<sku> (zakres `produkty:odczyt`) oraz narzędzia MCP
// `produkty_szukaj` i `produkt_szczegoly`. Klient firmy klucza (RLS): inna firma nie istnieje.
//
// Odpowiedź budowana pole po polu z jawnej listy (PRODUCT_FIELDS, PRODUCT_DETAIL_FIELDS) — nigdy cały rekord. Bez opisu,
// `details`, danych wFirmy (id, hash, cena zakupu) i strefy magazynu: to nie jest katalog dla klienta, tylko odczyt dla
// systemów i agentów firmy. Stan i aktywne oferty z tej samej funkcji co GET /api/v1/stany (`readStock`).
//
// Lista: `?fraza=<tekst>&rodzaj=STOCKED,BUNDLE&aktywne=1|0|wszystkie&limit=<1–100>&po=<kursor>`, kolejność po SKU
// (unikalne w firmie), kursor = SKU ostatniej pozycji (base64url).
import type { Channel, Prisma, PrismaClient, ProductKind, Unit } from '@prisma/client'
import { ApiInputError } from './odpowiedzi'
import { readStock, type StockItemOut } from './stany'
import { enumList } from './zamowienia'

export const PRODUCT_KINDS: ProductKind[] = ['STOCKED', 'BUNDLE', 'DIGITAL']
export const PRODUCTS_MAX_LIMIT = 100
export const PRODUCTS_DEFAULT_LIMIT = 50
export const MAX_RELATED = 50

export const PRODUCT_FIELDS = ['sku', 'nazwa', 'rodzaj', 'jednostka', 'ean', 'aktywny'] as const
export const PRODUCT_DETAIL_FIELDS = [...PRODUCT_FIELDS, 'cenaBrutto', 'progNiskiegoStanu', 'stan', 'oferty', 'skladniki', 'wZestawach'] as const

export interface ProductOut {
  sku: string
  nazwa: string
  rodzaj: ProductKind
  jednostka: Unit
  ean: string | null
  aktywny: boolean
}

export interface ProductOfferOut {
  kanal: Channel
  konto: string
  externalId: string
  sztukNaOferte: number
  aktywna: boolean
}

export interface ProductPartOut {
  sku: string
  nazwa: string
  ilosc: number
}

export type ProductStockOut = { bezStanu: true } | { fizycznie: number | null; zarezerwowane: number | null; dostepne: number }

export interface ProductDetailOut extends ProductOut {
  cenaBrutto: number | null
  progNiskiegoStanu: number | null
  stan: ProductStockOut
  oferty: ProductOfferOut[]
  skladniki: ProductPartOut[]
  wZestawach: ProductPartOut[]
}

export interface ProductSearchQuery {
  phrase?: string
  kinds?: ProductKind[]
  active: boolean | null
  limit: number
  after: string | null
}

export function encodeSkuCursor(sku: string): string {
  return Buffer.from(sku, 'utf8').toString('base64url')
}

export function decodeSkuCursor(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) return null
  const sku = Buffer.from(s, 'base64url').toString('utf8')
  return sku && sku.length <= 100 && encodeSkuCursor(sku) === s ? sku : null
}

/** Wspólna walidacja wejścia dla trasy i narzędzia MCP (wartości jako tekst). */
export function productSearchQuery(
  v: { fraza?: string | null; rodzaj?: string | string[] | null; aktywne?: string | null; limit?: number | null; po?: string | null },
  maxLimit = PRODUCTS_MAX_LIMIT,
): ProductSearchQuery {
  const phrase = v.fraza?.trim()
  if (phrase !== undefined && phrase.length > 100) throw new ApiInputError('fraza: najwyżej 100 znaków', 'fraza')
  const kinds = v.rodzaj === null || v.rodzaj === undefined ? undefined : enumList(v.rodzaj, PRODUCT_KINDS, 'rodzaj')
  let active: boolean | null = true
  if (v.aktywne !== null && v.aktywne !== undefined) {
    if (v.aktywne === '1' || v.aktywne === 'tak') active = true
    else if (v.aktywne === '0' || v.aktywne === 'nie') active = false
    else if (v.aktywne === 'wszystkie') active = null
    else throw new ApiInputError('aktywne: 1, 0 albo wszystkie', 'aktywne')
  }
  const limit = v.limit === null || v.limit === undefined ? Math.min(PRODUCTS_DEFAULT_LIMIT, maxLimit) : v.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new ApiInputError(`limit: liczba całkowita 1–${maxLimit}`, 'limit')
  const after = v.po === null || v.po === undefined ? null : decodeSkuCursor(v.po)
  if (v.po !== null && v.po !== undefined && after === null) throw new ApiInputError('po: zły kursor (użyj wartości nastepny z poprzedniej odpowiedzi)', 'po')
  return { phrase: phrase || undefined, kinds, active, limit, after }
}

export function parseProductSearch(sp: URLSearchParams): ProductSearchQuery {
  const known = new Set(['fraza', 'rodzaj', 'aktywne', 'limit', 'po'])
  for (const k of sp.keys()) if (!known.has(k)) throw new ApiInputError(`Nieznany parametr ${k}`, k)
  const limitRaw = sp.get('limit')
  return productSearchQuery({
    fraza: sp.get('fraza'),
    rodzaj: sp.getAll('rodzaj').length ? sp.getAll('rodzaj').join(',') : null,
    aktywne: sp.get('aktywne'),
    limit: limitRaw === null ? null : Number(limitRaw),
    po: sp.get('po'),
  })
}

const BASE_SELECT = { id: true, sku: true, title: true, kind: true, unit: true, ean: true, active: true } satisfies Prisma.ProductSelect
type BaseRow = Prisma.ProductGetPayload<{ select: typeof BASE_SELECT }>

// allowlista: każde pole wypisane jawnie, kolejność jak w PRODUCT_FIELDS
const baseOut = (p: BaseRow): ProductOut => ({ sku: p.sku, nazwa: p.title, rodzaj: p.kind, jednostka: p.unit, ean: p.ean, aktywny: p.active })

export async function searchProducts(db: PrismaClient, q: ProductSearchQuery): Promise<{ produkty: ProductOut[]; nastepny: string | null }> {
  const rows = await db.product.findMany({
    where: {
      AND: [
        ...(q.active === null ? [] : [{ active: q.active }]),
        ...(q.kinds ? [{ kind: { in: q.kinds } }] : []),
        ...(q.phrase ? [{ OR: [{ sku: { contains: q.phrase, mode: 'insensitive' as const } }, { title: { contains: q.phrase, mode: 'insensitive' as const } }, { ean: q.phrase }] }] : []),
        ...(q.after ? [{ sku: { gt: q.after } }] : []),
      ],
    },
    select: BASE_SELECT,
    orderBy: { sku: 'asc' },
    take: q.limit + 1,
  })
  const page = rows.slice(0, q.limit)
  const last = page.at(-1)
  return { produkty: page.map(baseOut), nastepny: rows.length > q.limit && last ? encodeSkuCursor(last.sku) : null }
}

export function parseSku(raw: string): string {
  let s = raw.trim()
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s)
    } catch {
      throw new ApiInputError('Złe SKU', 'sku')
    }
  }
  if (!s || s.length > 100) throw new ApiInputError('Złe SKU', 'sku')
  return s
}

const stockOf = (i: StockItemOut): ProductStockOut => ('bezStanu' in i ? { bezStanu: true } : { fizycznie: i.fizycznie, zarezerwowane: i.zarezerwowane, dostepne: i.dostepne })

/** Produkt po SKU (dokładnie) albo null. */
export async function productBySku(db: PrismaClient, sku: string): Promise<ProductDetailOut | null> {
  const p = await db.product.findFirst({
    where: { sku },
    select: {
      ...BASE_SELECT,
      priceGross: true,
      lowStockThreshold: true,
      offers: {
        select: { channel: true, channelAccountId: true, externalId: true, qtyBasePerOffer: true, active: true },
        orderBy: [{ active: 'desc' }, { channel: 'asc' }, { channelAccountId: 'asc' }, { externalId: 'asc' }],
        take: MAX_RELATED,
      },
      bundleComponents: { select: { qtyBase: true, component: { select: { sku: true, title: true } } }, take: MAX_RELATED },
      usedInBundles: { select: { qtyBase: true, bundle: { select: { sku: true, title: true } } }, take: MAX_RELATED },
    },
  })
  if (!p) return null
  const stock = (await readStock(db, { skus: [p.sku], page: 1 })).pozycje[0]
  const out: ProductDetailOut = {
    ...baseOut(p),
    cenaBrutto: p.priceGross === null ? null : Math.round(p.priceGross.toNumber() * 100) / 100,
    progNiskiegoStanu: p.lowStockThreshold,
    stan: stock ? stockOf(stock) : { fizycznie: 0, zarezerwowane: 0, dostepne: 0 },
    oferty: p.offers.map((o) => ({ kanal: o.channel, konto: o.channelAccountId, externalId: o.externalId, sztukNaOferte: o.qtyBasePerOffer, aktywna: o.active })),
    skladniki: p.kind === 'BUNDLE' ? p.bundleComponents.map((c) => ({ sku: c.component.sku, nazwa: c.component.title, ilosc: c.qtyBase })).sort((a, b) => a.sku.localeCompare(b.sku)) : [],
    wZestawach: p.usedInBundles.map((c) => ({ sku: c.bundle.sku, nazwa: c.bundle.title, ilosc: c.qtyBase })).sort((a, b) => a.sku.localeCompare(b.sku)),
  }
  return out
}
