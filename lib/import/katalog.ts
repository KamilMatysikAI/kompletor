// Import katalogu: zbierz (sieć, tylko odczyt) → analizuj (czysto) → zapisz (lokalna baza) → raport.
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import type { MiraklReadOnly } from '../zrodla/mirakl'
import { SourceError } from '../zrodla/http'
import type { WfirmaReadOnly } from '../zrodla/wfirma'
import {
  aggregateSales,
  classifyEmpik,
  classifyFromSales,
  classifyShopOffers,
  compareWithWfirma,
  duplicates,
  planCatalog,
  sellableBl,
  type CatalogPlan,
  type OfferResult,
  type WfCompliance,
} from './mapowanie'
import { applyCatalogRules, EMPTY_RULES, type CatalogRules, type RulesOutcome } from './bez-stanu'
import { applyOfferOverrides, type OfferOverride } from './nadpisania'
import type { BlProd, ChannelMap, ChannelT, EmpikOffer, SaleLine, ShopOffer, WfGood } from './normalizacja'
import {
  fetchBlCatalog,
  fetchBlSales,
  fetchEmpikOffers,
  fetchShopOffers,
  fetchWfirmaGoods,
  type BlCatalog,
  type FetchIssue,
} from './pobieranie'

export interface RawSources {
  fetchedAt: string
  salesDays: number
  /** Kanały firmy w chwili pobrania (konfiguracja firmy z bazy, zapisywana też w zrzucie). */
  channels: ChannelMap
  bl: BlCatalog
  shopOffers: ShopOffer[]
  sales: { lines: SaleLine[]; orders: number; oldestUnix: number | null; sinceUnix: number; complete?: boolean }
  wfirma: { goods: WfGood[]; total: number | null } | null
  empik: EmpikOffer[] | null
  issues: FetchIssue[]
  /**
   * źródło stanu startowego. Brak / 'wfirma' = towary wFirmy (jak dotąd). 'bl' = firma bez wFirmy
   * (przeprowadzka z BL): produkty z rekordów BL o jednoznacznym SKU, stan z `blStock` (id produktu BL → ilość).
   */
  stockSource?: 'wfirma' | 'bl'
  blStock?: Record<string, number>
}

export interface Sources {
  bl: BaseLinkerReadOnly
  wfirma: WfirmaReadOnly | null
  empik: MiraklReadOnly | null
  inventoryId: string
  salesDays?: number
  wfirmaWarehouseId: string | null
  /** Magazyny zewnętrzne BL sklepów Woo firmy (np. „shop_1234567”). */
  shopStorages: string[]
  channels: ChannelMap
  now?: Date
}

export async function collectSources(s: Sources): Promise<RawSources> {
  const issues: FetchIssue[] = []
  const now = s.now ?? new Date()
  const salesDays = s.salesDays ?? 90
  const sinceUnix = Math.floor(now.getTime() / 1000) - salesDays * 86_400
  const bl = await fetchBlCatalog(s.bl, s.inventoryId, issues)
  const shopOffers = await fetchShopOffers(s.bl, s.shopStorages, issues)
  // salesDays = 0: bez odczytu zamówień BL (żadne dane klientów nie przechodzą przez proces), sprzedaż w raporcie pusta.
  // Tak działa import na serwerze do czasu logowania w panelu.
  const sales =
    salesDays <= 0
      ? { lines: [] as SaleLine[], orders: 0, oldestUnix: null, complete: false }
      : await fetchBlSales(s.bl, sinceUnix, issues, s.channels).catch((e: unknown) => {
          issues.push({ kind: 'bl-zamowienia', ref: 'getOrders', message: e instanceof Error ? e.message : String(e) })
          return { lines: [] as SaleLine[], orders: 0, oldestUnix: null, complete: false }
        })
  const wfirma =
    s.wfirma && s.wfirmaWarehouseId
      ? await fetchWfirmaGoods(s.wfirma, issues, s.wfirmaWarehouseId).catch((e: unknown) => {
          // SourceError(retryable = false): limit wFirmy, HTTP 429, inne 4xx — persistImport odmówi bez ponawiania
          // zadania (każde żądanie w blokadzie może ją przedłużyć; kolejny przebieg z harmonogramu). 5xx po
          // wyczerpaniu withRetry i błąd sieci zostają ponawialne.
          issues.push({
            kind: 'wfirma',
            ref: 'goods/find',
            message: e instanceof Error ? e.message : String(e),
            retryable: e instanceof SourceError ? e.retryable : true,
          })
          return null
        })
      : null
  const empik = s.empik ? await fetchEmpikOffers(s.empik, issues) : null
  // Źródło pominięte z braku kluczy to też niepełne pobranie: bez tego wpisu import uznałby kanał za kompletny
  // i wyłączył jego oferty (przegląd r2, uwaga 3).
  if (!s.wfirma || !s.wfirmaWarehouseId) issues.push({ kind: MISSING_KEYS, ref: 'wfirma', message: 'brak kluczy wFirmy — towary i stany nie pobrane' })
  // Brak kluczy Empiku to problem tylko firmy ze skonfigurowanym kontem Empik — inaczej każdy przebieg byłby
  // PARTIAL z fałszywym alarmem.
  if (!s.empik && s.channels.empikAccountId) issues.push({ kind: MISSING_KEYS, ref: 'empik', message: 'brak klucza Empiku — lista ofert OF21 nie pobrana' })
  return { fetchedAt: now.toISOString(), salesDays, channels: s.channels, bl, shopOffers, sales: { ...sales, sinceUnix }, wfirma, empik, issues }
}

export const MISSING_KEYS = 'brak-kluczy'

/** Problemy pobierania, które oznaczają niepełny katalog (wtedy żadna oferta nie jest wyłączana). */
const CATALOG_ISSUES = /^(bl-paczka-produktow|bl-produkt|wfirma|wfirma-towar|wfirma-liczba)$/
const SALES_ISSUES = /^(bl-zamowienia|bl-zamowienie)$/

/**
 * Czy lista ofert kanału jest pełna — tylko wtedy import może wyłączać oferty, które z niej zniknęły albo
 * straciły powiązanie. Niepełny katalog BL/wFirmy albo sprzedaż = żaden kanał nie jest pełny.
 * `purpose = 'stale'` (sprzątanie ofert, których nie ma w źródle): kanały znane tylko z okna sprzedaży
 * (Allegro, inne BL, ręczne, EasyTools) nigdy nie mają pełnej listy — oferta wypada z okna, nie z kanału.
 */
/** Czy pobranie listy ofert sklepu Woo (magazyn BL `shop_<konto>`) padło w całości albo w paczce. */
export function shopFetchFailed(raw: RawSources, accountId: string): boolean {
  const storage = `shop_${accountId}`
  return raw.issues.some((i) => (i.kind === 'bl-sklep' || i.kind === 'bl-sklep-paczka') && (i.ref === storage || i.ref.startsWith(`${storage}:`)))
}

export const SALES_ONLY_CHANNELS: ChannelT[] =['ALLEGRO', 'BL_INNE', 'RECZNE', 'EASYTOOLS']
export function channelComplete(raw: RawSources, channel: ChannelT, accountId: string, purpose: 'deactivate' | 'stale' = 'deactivate'): boolean {
  if (purpose === 'stale' && SALES_ONLY_CHANNELS.includes(channel)) return false
  if (!raw.wfirma) return false
  if (raw.issues.some((i) => CATALOG_ISSUES.test(i.kind))) return false
  if (raw.sales.complete === false || raw.issues.some((i) => SALES_ISSUES.test(i.kind))) return false
  if (channel === 'WOO') {
    if (!raw.channels.shopAccounts.includes(accountId)) return false
    return !shopFetchFailed(raw, accountId)
  }
  // Konto Empik porównane z konfiguracją jak Woo: po zmianie konta stare wiersze nie idą do sprzątania.
  if (channel === 'EMPIK') return raw.empik !== null && raw.channels.empikAccountId === accountId && !raw.issues.some((i) => i.kind === 'empik-oferty' || (i.kind === MISSING_KEYS && i.ref === 'empik'))
  return true
}

export interface Analysis {
  overrideProblems: string[]
  /** Reguły firmy: oferty produktów bez stanu, dodatki bez oferty, konflikty z katalogiem. */
  catalogRules: RulesOutcome
  plan: CatalogPlan
  compliance: WfCompliance | null
  offers: OfferResult[]
  dupSkuBl: Map<string, BlProd[]>
  dupEanBl: Map<string, BlProd[]>
  dupCodeWfirma: Map<string, WfGood[]>
  bundles: BlProd[]
  variants: BlProd[]
}

/**
 * `overrides` — tabela nadpisań (`loadOfferOverrides()`); testy podają ją jawnie. `rules` — reguły katalogu firmy
 * (`ImportConfig.catalog`), stosowane po nadpisaniach: nadpisanie wygrywa z regułą.
 */
export function analyze(raw: RawSources, overrides: OfferOverride[] = [], rules: CatalogRules = EMPTY_RULES): Analysis {
  const blAll = raw.bl.products
  const wfGoods = raw.wfirma?.goods ?? []
  const plan = planCatalog(blAll, wfGoods, raw.stockSource === 'bl' ? new Map(Object.entries(raw.blStock ?? {})) : undefined)
  const compliance = raw.wfirma ? compareWithWfirma(plan, blAll) : null
  const sales = aggregateSales(raw.sales.lines, blAll)
  const known = new Set(plan.blToKey.keys())
  const offers = [
    ...classifyShopOffers(raw.shopOffers, blAll, sales, known, raw.channels.shopAccounts),
    ...classifyFromSales(sales, ['ALLEGRO', 'BL_INNE', 'RECZNE', 'EASYTOOLS'], known),
    ...(raw.empik && raw.channels.empikAccountId
      ? classifyEmpik(raw.empik, raw.channels.empikAccountId, blAll, sales, known)
      : classifyFromSales(sales, ['EMPIK'], known)),
  ]
  const overrideProblems = applyOfferOverrides(offers, overrides, blAll, known)
  const catalogRules = applyCatalogRules(offers, plan, rules, blAll, wfGoods)
  const sellable = sellableBl(blAll)
  return {
    overrideProblems,
    catalogRules,
    plan,
    compliance,
    offers,
    dupSkuBl: duplicates(sellable, (p) => p.sku),
    dupEanBl: duplicates(sellable, (p) => p.ean),
    dupCodeWfirma: duplicates(
      wfGoods.filter((g) => g.type !== 'service'),
      (g) => g.code,
    ),
    bundles: sellable.filter((p) => p.isBundle),
    variants: blAll.filter((p) => p.parentId),
  }
}
