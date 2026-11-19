// Czyste funkcje: surowe odpowiedzi BL / wFirmy / Mirakl → znormalizowane rekordy. Bez I/O.
// Ilości w jednostce bazowej: szt. albo gramy (spec, rozdz. 1). Dane osobowe z zamówień nie wychodzą poza fromBlOrder.

export type UnitT = 'SZT' | 'KG'
// Typ kanału (= enum Channel). Sklep/konto rozróżnia accountId; które sklepy BL są kanałami firmy — ChannelMap.
export type ChannelT =
  | 'WOO'
  | 'ALLEGRO'
  | 'EMPIK'
  | 'EASYTOOLS'
  | 'BL_INNE'
  | 'RECZNE'

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim())
  return Number.isFinite(n) ? n : null
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

export function unitFromWfirma(unit: unknown): UnitT {
  return String(unit ?? '').trim().toLowerCase() === 'kg' ? 'KG' : 'SZT'
}

/** Ilość w jednostce wFirmy/BL → jednostka bazowa (kg → g, zaokrąglenie do grama; szt. → całe sztuki w dół). */
export function toBase(qty: number | null, unit: UnitT): number {
  if (qty === null) return 0
  if (unit === 'KG') return Math.round(qty * 1000)
  return Math.floor(qty + 1e-9)
}

/** Kontrola sumy GTIN-8/12/13/14. */
export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false
  const digits = code.split('').map(Number)
  const check = digits.pop()!
  let sum = 0
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i]! * w
  return (10 - (sum % 10)) % 10 === check
}

export function normalizeEan(v: unknown): { ean: string | null; raw: string | null; valid: boolean } {
  const raw = str(v)
  if (!raw) return { ean: null, raw: null, valid: false }
  const digits = raw.replace(/\s+/g, '')
  const valid = isValidGtin(digits)
  return { ean: valid ? digits : null, raw, valid }
}

/** Do porównań nazw: małe litery, bez podwójnych spacji i znaków typograficznych. */
export function normName(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[„”"'’`]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

export function round2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100
}

// ─── wFirma ─────────────────────────────────────────────────────────────────

export interface WfGood {
  id: string
  code: string | null
  name: string
  type: string
  unit: UnitT
  unitRaw: string
  vatCodeId: string | null
  vatRate: string | null
  priceNetRetail: number | null
  priceGrossRetail: number | null
  purchasePriceNet: number | null
  count: number | null // jednostka wFirmy
  countBase: number
  warehouseId: string | null
  ean: string | null
  visibility: string | null
  modified: string | null
}

function items(obj: unknown, key: string): Record<string, unknown>[] {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj as Record<string, unknown>)
    .filter(([k]) => k !== 'parameters')
    .map(([, v]) => (v as Record<string, unknown> | null)?.[key] as Record<string, unknown> | undefined)
    .filter((x): x is Record<string, unknown> => !!x)
}

export function wfGoodFromApi(raw: Record<string, unknown>, vatRates: Map<string, string>): WfGood {
  const unit = unitFromWfirma(raw['unit'])
  const prices = items(raw['good_prices'], 'good_price')
  const retail = prices.find((p) => String(p['name'] ?? '').toLowerCase() === 'detaliczna') ?? null
  const count = num(raw['count'])
  const value = num(raw['value'])
  const vatCodeId = str((raw['vat_code'] as Record<string, unknown> | undefined)?.['id'])
  return {
    id: String(raw['id']),
    code: str(raw['code']),
    name: str(raw['name']) ?? '',
    type: str(raw['type']) ?? 'good',
    unit,
    unitRaw: String(raw['unit'] ?? ''),
    vatCodeId,
    vatRate: vatCodeId ? (vatRates.get(vatCodeId) ?? null) : null,
    priceNetRetail: retail ? num(retail['netto']) : null,
    priceGrossRetail: retail ? num(retail['brutto']) : null,
    // średnia ważona partii = wartość / ilość (spec 8.2); przy zerowym stanie brak danych
    purchasePriceNet: count && count > 0 && value !== null ? Math.round((value / count) * 10_000) / 10_000 : null,
    count,
    countBase: toBase(count, unit),
    warehouseId: str((raw['warehouse'] as Record<string, unknown> | undefined)?.['id']),
    ean: str(raw['ean']),
    visibility: str(raw['visibility']),
    modified: str(raw['modified']),
  }
}

export function vatRatesFromApi(vatCodes: Record<string, unknown>[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const v of vatCodes) {
    const id = str(v['id'])
    const code = str(v['code'])
    if (id && code) m.set(id, code) // "23", "8", "5", "0", "zw", "np"…
  }
  return m
}

// ─── BaseLinker: katalog ─────────────────────────────────────────────────────

export interface BlLink {
  productId: string
  variantId: string
}

export interface BlProd {
  id: string
  parentId: string | null
  hasVariants: boolean
  sku: string | null
  ean: string | null
  eanRaw: string | null
  eanValid: boolean
  name: string
  isBundle: boolean
  bundleProducts: Record<string, number> | null
  taxRate: number | null
  priceGross: number | null
  stockAccounting: number | null
  stockBl: number | null
  links: Record<string, BlLink>
  wfirmaGoodIdLink: string | null
  /** Miejsca na półce: { "bl_<id magazynu>": "B-3-4" } (getInventoryProductsData → locations). */
  locations: Record<string, string> | null
}

function parseLocations(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, string> = {}
  for (const [k, l] of Object.entries(v as Record<string, unknown>)) {
    const s = str(l)
    if (s) out[k] = s.slice(0, 64)
  }
  return Object.keys(out).length ? out : null
}

function parseLinks(v: unknown): Record<string, BlLink> {
  const out: Record<string, BlLink> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, l] of Object.entries(v as Record<string, unknown>)) {
    const o = l as Record<string, unknown> | null
    const productId = str(o?.['product_id'])
    if (!productId || productId === '0') continue
    out[k] = { productId, variantId: str(o?.['variant_id']) ?? '0' }
  }
  return out
}

function parseBundle(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, number> = {}
  for (const [k, q] of Object.entries(v as Record<string, unknown>)) {
    const n = num(q)
    if (n && n > 0) out[k] = n
  }
  return Object.keys(out).length ? out : null
}

export function blProdFromApi(
  id: string,
  raw: Record<string, unknown>,
  priceGroupId: string,
  accountingKey = 'accounting_1',
): BlProd[] {
  const textFields = (raw['text_fields'] ?? {}) as Record<string, unknown>
  const stock = (raw['stock'] ?? {}) as Record<string, unknown>
  const prices = (raw['prices'] ?? {}) as Record<string, unknown>
  const links = parseLinks(raw['links'])
  const ean = normalizeEan(raw['ean'])
  const parentRaw = str(raw['parent_id'])
  const variantsRaw = raw['variants']
  const variants =
    variantsRaw && typeof variantsRaw === 'object' ? Object.entries(variantsRaw as Record<string, unknown>) : []
  const isBundle = raw['is_bundle'] === true || raw['is_bundle'] === 1 || raw['is_bundle'] === '1'
  const base: BlProd = {
    id,
    parentId: parentRaw && parentRaw !== '0' ? parentRaw : null,
    hasVariants: variants.length > 0,
    sku: str(raw['sku']),
    ean: ean.ean,
    eanRaw: ean.raw,
    eanValid: ean.valid,
    name: str(textFields['name']) ?? str(raw['name']) ?? '',
    isBundle,
    bundleProducts: isBundle ? parseBundle(raw['bundle_products']) : null,
    taxRate: num(raw['tax_rate']),
    priceGross: num(prices[priceGroupId]),
    stockAccounting: num(stock[accountingKey]),
    stockBl: num(Object.entries(stock).find(([k]) => k.startsWith('bl_'))?.[1]),
    links,
    wfirmaGoodIdLink: links[accountingKey]?.productId ?? null,
    locations: parseLocations(raw['locations']),
  }
  const out = [base]
  // Warianty zwracane w polu `variants` rodzica (gdy getInventoryProductsList ich nie wylicza osobno).
  for (const [vid, vRaw] of variants) {
    const v = (vRaw ?? {}) as Record<string, unknown>
    const vEan = normalizeEan(v['ean'])
    const vLinks = parseLinks(v['links'])
    const vStock = (v['stock'] ?? {}) as Record<string, unknown>
    const vPrices = (v['prices'] ?? {}) as Record<string, unknown>
    out.push({
      ...base,
      id: vid,
      parentId: id,
      hasVariants: false,
      sku: str(v['sku']),
      ean: vEan.ean,
      eanRaw: vEan.raw,
      eanValid: vEan.valid,
      name: `${base.name} ${str(v['name']) ?? ''}`.trim(),
      isBundle: false,
      bundleProducts: null,
      priceGross: num(vPrices[priceGroupId]) ?? base.priceGross,
      stockAccounting: num(vStock[accountingKey]),
      stockBl: num(Object.entries(vStock).find(([k]) => k.startsWith('bl_'))?.[1]),
      links: vLinks,
      wfirmaGoodIdLink: vLinks[accountingKey]?.productId ?? null,
      locations: parseLocations(v['locations']),
    })
  }
  return out
}

// ─── Sklepy Woo widziane przez BL (magazyny zewnętrzne shop_*) ──────────────

export interface ShopOffer {
  storageId: string // np. shop_1234567
  externalId: string // "<productId>" albo "<productId>/<variantId>"
  productId: string
  variantId: string | null
  sku: string | null
  ean: string | null
  name: string
  isParentWithVariants: boolean
  /** Kategoria produktu w sklepie (`category_id` z BL; wariant dziedziczy po rodzicu) — reguły bez stanu. */
  categoryId?: string
}

export function shopOffersFromApi(storageId: string, raw: Record<string, unknown>): ShopOffer[] {
  const productId = String(raw['product_id'])
  const name = str(raw['name']) ?? ''
  const variants = Array.isArray(raw['variants']) ? (raw['variants'] as Record<string, unknown>[]) : []
  const categoryId = str(raw['category_id'])
  const cat = categoryId && categoryId !== '0' ? { categoryId } : {}
  const out: ShopOffer[] = [
    {
      storageId,
      externalId: productId,
      productId,
      variantId: null,
      sku: str(raw['sku']),
      ean: normalizeEan(raw['ean']).ean,
      name,
      isParentWithVariants: variants.length > 0,
      ...cat,
    },
  ]
  for (const v of variants) {
    const vid = str(v['variant_id'])
    if (!vid) continue
    out.push({
      storageId,
      externalId: `${productId}/${vid}`,
      productId,
      variantId: vid,
      sku: str(v['sku']),
      ean: normalizeEan(v['ean']).ean,
      name: `${name} ${str(v['name']) ?? ''}`.trim(),
      isParentWithVariants: false,
      ...cat,
    })
  }
  return out
}

// ─── Empik (Mirakl OF21) ────────────────────────────────────────────────────

export interface EmpikOffer {
  externalId: string // product_sku (Empik), w BL zamówieniach jako auction_id "p<product_sku>"
  offerId: string
  shopSku: string | null
  ean: string | null
  name: string
  active: boolean
  quantity: number | null
}

export function empikOfferFromApi(raw: Record<string, unknown>): EmpikOffer {
  const refs = Array.isArray(raw['product_references']) ? (raw['product_references'] as Record<string, unknown>[]) : []
  const eanRef = refs.find((r) => String(r['reference_type'] ?? '').toUpperCase() === 'EAN')
  return {
    externalId: String(raw['product_sku']),
    offerId: String(raw['offer_id']),
    shopSku: str(raw['shop_sku']),
    ean: normalizeEan(eanRef?.['reference']).ean,
    name: str(raw['product_title']) ?? '',
    active: raw['active'] === true,
    quantity: num(raw['quantity']),
  }
}

// ─── Zamówienia BL → linie sprzedaży BEZ danych osobowych ───────────────────

export interface SaleLine {
  channel: ChannelT
  accountId: string
  orderId: string // id zamówienia BL (nie jest daną osobową; nie zapisujemy go w bazie)
  soldAt: Date
  storage: string // db | shop | …
  storageId: string | null
  productId: string | null // db: id produktu BL; shop: id produktu sklepu
  variantId: string | null
  auctionId: string | null
  sku: string | null
  ean: string | null
  name: string
  qty: number
}

/**
 * Kanały firmy widziane przez BL (z konfiguracji firmy w bazie, nie ze stałych w kodzie — zastępuje
 * SHOP_CHANNELS i KNOWN_CHANNEL_ACCOUNTS). `shopAccounts` = konta sklepów Woo podpiętych w BL (order_source_id
 * zamówień „shop” = numer magazynu bez „shop_”). `names`: klucz „<kanał>|<konto>” każdego aktywnego konta firmy.
 */
export interface ChannelMap {
  shopAccounts: string[]
  empikAccountId: string | null
  names?: Record<string, string>
}

export function channelOfOrder(source: string, sourceId: string, map: ChannelMap): { channel: ChannelT; accountId: string } {
  if (source === 'shop' && map.shopAccounts.includes(sourceId)) return { channel: 'WOO', accountId: sourceId }
  if (source === 'allegro') return { channel: 'ALLEGRO', accountId: sourceId }
  if (source === 'empik') return { channel: 'EMPIK', accountId: sourceId }
  if (source === 'personal') return { channel: 'RECZNE', accountId: sourceId || '0' }
  return { channel: 'BL_INNE', accountId: `${source}:${sourceId}` }
}

/** Wyciąga z zamówienia BL tylko pozycje i źródło. Adres, e-mail, telefon, NIP itp. nigdy nie wychodzą z tej funkcji. */
export function fromBlOrder(o: Record<string, unknown>, map: ChannelMap): SaleLine[] {
  const { channel, accountId } = channelOfOrder(String(o['order_source'] ?? ''), String(o['order_source_id'] ?? ''), map)
  const ts = num(o['date_confirmed']) || num(o['date_add']) || 0
  const soldAt = new Date(ts * 1000)
  const orderId = String(o['order_id'])
  const products = Array.isArray(o['products']) ? (o['products'] as Record<string, unknown>[]) : []
  return products.map((p) => {
    const pid = str(p['product_id'])
    const vid = str(p['variant_id'])
    const auction = str(p['auction_id'])
    return {
      channel,
      accountId,
      orderId,
      soldAt,
      storage: str(p['storage']) ?? '',
      storageId: str(p['storage_id']),
      productId: pid && pid !== '0' ? pid : null,
      variantId: vid && vid !== '0' ? vid : null,
      auctionId: auction && auction !== '0' ? auction : null, // „0” = pozycja dodana ręcznie
      sku: str(p['sku']),
      ean: normalizeEan(p['ean']).ean,
      name: str(p['name']) ?? '',
      qty: num(p['quantity']) ?? 0,
    }
  })
}
