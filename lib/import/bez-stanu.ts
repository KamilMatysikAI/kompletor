// produkty bez stanu (e-book, usługa) i dodatki z magazynu, które nie są ofertą (naklejka, banderola).
// Rozpoznanie wyłącznie z konfiguracji firmy (Organization.settings.catalog: SKU, kategoria sklepu), nigdy z nazwy
// pozycji. Czyste funkcje — wynik zapisuje lib/import/zapis.ts, raport składa lib/import/raport.ts.
import { isSyntheticOfferId, type CatalogPlan, type OfferResult, type PlannedProduct } from './mapowanie'
import type { BlProd, WfGood } from './normalizacja'

export interface CatalogRules {
  /** SKU produktów bez stanu: oferta (dowolny kanał) z takim SKU dostaje produkt DIGITAL zamiast powiązania z magazynem. */
  noStockSkus: string[]
  /** Kategorie produktów sklepów Woo widziane przez BL (`category_id`) jako „<konto sklepu>:<id kategorii>”. */
  noStockShopCategories: string[]
  /**
   * SKU produktów BL, które idą w zamówieniach z magazynu BL bez oferty kanału (dodatek dokładany do zamówienia albo
   * składnik zestawu rozbijanego przez BL): to nie oferta, więc nie liczy się do progu braków. Do ustalenia z BL.
   */
  nonOfferSkus: string[]
}

export const EMPTY_RULES: CatalogRules = { noStockSkus: [], noStockShopCategories: [], nonOfferSkus: [] }

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : []

/** `settings.catalog` firmy → reguły (puste listy, gdy brak; śmieci pomijane). */
export function parseCatalogRules(v: unknown): CatalogRules {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const noStock = o['noStock'] && typeof o['noStock'] === 'object' ? (o['noStock'] as Record<string, unknown>) : {}
  return { noStockSkus: strings(noStock['skus']), noStockShopCategories: strings(noStock['shopCategories']), nonOfferSkus: strings(o['nonOfferSkus']) }
}

export function rulesEmpty(r: CatalogRules): boolean {
  return !r.noStockSkus.length && !r.noStockShopCategories.length && !r.nonOfferSkus.length
}

export const NO_STOCK_NOTE = 'produkt bez stanu (konfiguracja firmy) — nie rezerwuje, nie trafia do „brakuje”, na fakturze jako usługa'
export const NON_OFFER_NOTE = 'dodatek albo składnik z magazynu bez oferty kanału (konfiguracja firmy) — poza progiem braków'

export interface RulesOutcome {
  /** Oferty powiązane z produktem bez stanu. */
  noStock: OfferResult[]
  /** Pozycje z magazynu bez oferty kanału, wyłączone z progu. */
  nonOffer: OfferResult[]
  /** Reguła trafiła w SKU, które w katalogu jest produktem ze stanem albo zestawem — rozstrzyga człowiek. */
  conflicts: { offer: OfferResult; sku: string; reason: string }[]
}

/** SKU produktu bez stanu dla oferty z kategorii bez SKU: stały, z konta i id oferty (bez nazwy). */
function digitalSkuOf(o: OfferResult): string {
  return o.sku?.trim() || `cyfrowy-${o.accountId}-${o.externalId.replace(/\//g, '-')}`
}

/**
 * Stosuje reguły do ofert bez jednoznacznego powiązania (po nadpisaniach): produkt bez stanu → MAPPED / CONFIG
 * z planowanym produktem DIGITAL (`digital:<sku>`), dodatek bez oferty → `nonOffer`. Oferty powiązane z magazynem
 * zostają nietknięte. Dopisuje produkty DIGITAL do `plan.products`.
 */
export function applyCatalogRules(offers: OfferResult[], plan: CatalogPlan, rules: CatalogRules, blAll: BlProd[], wfGoods: WfGood[]): RulesOutcome {
  const out: RulesOutcome = { noStock: [], nonOffer: [], conflicts: [] }
  if (rulesEmpty(rules)) return out
  const noStockSkus = new Set(rules.noStockSkus)
  const categories = new Set(rules.noStockShopCategories)
  const nonOfferSkus = new Set(rules.nonOfferSkus)
  const blById = new Map(blAll.map((p) => [p.id, p]))
  const planned = new Map(plan.products.map((p) => [p.sku, p]))
  for (const o of offers) {
    if (o.state === 'MAPPED') continue
    const byCategory = o.channel === 'WOO' && !!o.shopCategoryId && categories.has(`${o.accountId}:${o.shopCategoryId}`)
    // SKU porównywane po trim jak reguły (normalizacja już przycina; oferta spoza niej też)
    if ((o.sku && noStockSkus.has(o.sku.trim())) || byCategory) {
      const sku = digitalSkuOf(o)
      const other = planned.get(sku)
      if (other && other.kind !== 'DIGITAL') {
        const reason = `SKU „${sku}” jest w katalogu ${other.kind === 'BUNDLE' ? 'zestawem' : 'produktem ze stanem'} — reguła bez stanu pominięta, rozstrzyga człowiek`
        o.notes.push(reason)
        out.conflicts.push({ offer: o, sku, reason })
        continue
      }
      const key = `digital:${sku}`
      if (!other) {
        // Usługa w wFirmie o tym kodzie: z niej nazwa księgowa, cena i VAT na fakturę. Towar (good) nie — zdjąłby stan.
        const services = wfGoods.filter((g) => g.code === sku && g.type === 'service')
        const p: PlannedProduct = {
          key,
          sku,
          kind: 'DIGITAL',
          unit: 'SZT',
          groupId: null,
          wf: services.length === 1 ? services[0]! : null,
          title: o.name,
          ean: o.ean,
          blIds: [],
          components: [],
          notes: services.length === 1 ? [] : ['brak usługi w wFirmie o tym kodzie — faktura z nazwy i ceny pozycji'],
          location: null,
        }
        plan.products.push(p)
        planned.set(sku, p)
      }
      o.state = 'MAPPED'
      o.source = 'CONFIG'
      o.productKey = key
      o.notes.push(NO_STOCK_NOTE)
      out.noStock.push(o)
      continue
    }
    // Dodatek tylko jako pozycja z magazynu bez oferty (id zastępcze): prawdziwa oferta z tym SKU dalej wymaga powiązania.
    if (nonOfferSkus.size && isSyntheticOfferId(o.externalId)) {
      const skus = [o.sku, ...o.blProductIds.map((id) => blById.get(id)?.sku ?? null)].map((x) => x?.trim()).filter((x): x is string => !!x)
      if (skus.some((s) => nonOfferSkus.has(s))) {
        o.nonOffer = true
        o.notes.push(NON_OFFER_NOTE)
        out.nonOffer.push(o)
      }
    }
  }
  return out
}
