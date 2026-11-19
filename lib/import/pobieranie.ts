// Pobieranie danych ze źródeł (tylko odczyt). Każde źródło osobno, błąd jednego nie przerywa reszty —
// wynik niesie listę problemów, a importer oznacza przebieg jako PARTIAL.
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import type { MiraklReadOnly } from '../zrodla/mirakl'
import { wfirmaItems, type WfirmaReadOnly } from '../zrodla/wfirma'
import {
  blProdFromApi,
  empikOfferFromApi,
  fromBlOrder,
  shopOffersFromApi,
  vatRatesFromApi,
  wfGoodFromApi,
  type BlProd,
  type ChannelMap,
  type EmpikOffer,
  type SaleLine,
  type ShopOffer,
  type WfGood,
} from './normalizacja'

export interface FetchIssue {
  kind: string
  ref: string
  message: string
  /**
   * `false` = ponowienie zadania nic nie da albo szkodzi (limit wFirmy, HTTP 429, inne 4xx, np. zły klucz).
   * Brak pola = ponawialne (zgodność ze starszymi zrzutami).
   */
  retryable?: boolean
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface BlCatalog {
  inventoryId: string
  priceGroupId: string
  products: BlProd[]
  integrations: Record<string, unknown>
}

export async function fetchBlCatalog(bl: BaseLinkerReadOnly, inventoryId: string, issues: FetchIssue[]): Promise<BlCatalog> {
  const inv = await bl.call<{ inventories: Record<string, unknown>[] }>('getInventories')
  const meta = inv.inventories.find((i) => String(i['inventory_id']) === inventoryId)
  if (!meta) throw new Error(`BL: brak magazynu ${inventoryId}`)
  const priceGroupId = String(meta['default_price_group'])
  const ids: string[] = []
  for (let page = 1; page < 50; page++) {
    const r = await bl.call<{ products: Record<string, unknown> }>('getInventoryProductsList', { inventory_id: Number(inventoryId), page })
    const keys = Object.keys(r.products ?? {})
    ids.push(...keys)
    if (keys.length < 1000) break
  }
  const products: BlProd[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    try {
      const r = await bl.call<{ products: Record<string, Record<string, unknown>> }>('getInventoryProductsData', {
        inventory_id: Number(inventoryId),
        products: chunk.map(Number),
      })
      for (const [id, raw] of Object.entries(r.products ?? {})) {
        try {
          products.push(...blProdFromApi(id, raw, priceGroupId))
        } catch (e) {
          issues.push({ kind: 'bl-produkt', ref: id, message: errMsg(e) })
        }
      }
    } catch (e) {
      issues.push({ kind: 'bl-paczka-produktow', ref: `${chunk[0]}…`, message: errMsg(e) })
    }
  }
  // Warianty wyliczone osobno i jako pole rodzica — bez dubli.
  const uniq = new Map(products.map((p) => [p.id, p]))
  const integrations = await bl
    .call<{ integrations: Record<string, unknown> }>('getInventoryIntegrations', { inventory_id: Number(inventoryId) })
    .then((r) => r.integrations ?? {})
    .catch((e) => {
      issues.push({ kind: 'bl-integracje', ref: inventoryId, message: errMsg(e) })
      return {}
    })
  return { inventoryId, priceGroupId, products: [...uniq.values()], integrations }
}

/** Produkty sklepów Woo tak, jak widzi je BL (magazyny zewnętrzne shop_*). Paginacja BL bywa ignorowana — stop przy braku nowych id. */
export async function fetchShopOffers(bl: BaseLinkerReadOnly, storageIds: string[], issues: FetchIssue[]): Promise<ShopOffer[]> {
  const out: ShopOffer[] = []
  for (const storageId of storageIds) {
    try {
      const ids: string[] = []
      const seen = new Set<string>()
      for (let page = 1; page < 50; page++) {
        const r = await bl.call<{ products: Record<string, unknown>[] }>('getExternalStorageProductsList', { storage_id: storageId, page })
        const list = Array.isArray(r.products) ? r.products : []
        const fresh = list.map((p) => String(p['product_id'])).filter((id) => !seen.has(id))
        fresh.forEach((id) => seen.add(id))
        ids.push(...fresh)
        if (fresh.length === 0 || list.length < 100) break
      }
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100)
        try {
          const r = await bl.call<{ products: Record<string, Record<string, unknown>> | Record<string, unknown>[] }>(
            'getExternalStorageProductsData',
            { storage_id: storageId, products: chunk },
          )
          const vals = Array.isArray(r.products) ? r.products : Object.values(r.products ?? {})
          for (const raw of vals) out.push(...shopOffersFromApi(storageId, raw as Record<string, unknown>))
        } catch (e) {
          issues.push({ kind: 'bl-sklep-paczka', ref: `${storageId}:${chunk[0]}…`, message: errMsg(e) })
        }
      }
    } catch (e) {
      issues.push({ kind: 'bl-sklep', ref: storageId, message: errMsg(e) })
    }
  }
  return out
}

/** Zamówienia BL z N dni → same linie sprzedaży. Surowe zamówienie (z danymi osobowymi) żyje tylko w tej pętli. */
export async function fetchBlSales(
  bl: BaseLinkerReadOnly,
  sinceUnix: number,
  issues: FetchIssue[],
  channels: ChannelMap,
): Promise<{ lines: SaleLine[]; orders: number; oldestUnix: number | null; complete: boolean }> {
  const lines: SaleLine[] = []
  let orders = 0
  let complete = true
  let oldest: number | null = null
  let from = sinceUnix
  const seen = new Set<string>()
  for (let guard = 0; guard < 1000; guard++) {
    let batch: Record<string, unknown>[]
    try {
      const r = await bl.call<{ orders: Record<string, unknown>[] }>('getOrders', {
        date_confirmed_from: from,
        get_unconfirmed_orders: false,
      })
      batch = Array.isArray(r.orders) ? r.orders : []
    } catch (e) {
      // Pobrane strony zostają; raport dostaje ostrzeżenie „sprzedaż niepełna”.
      issues.push({ kind: 'bl-zamowienia', ref: `od ${from}`, message: errMsg(e) })
      complete = false
      break
    }
    let fresh = 0
    for (const o of batch) {
      const id = String(o['order_id'])
      if (seen.has(id)) continue
      seen.add(id)
      fresh++
      try {
        lines.push(...fromBlOrder(o, channels))
        orders++
        const ts = Number(o['date_confirmed'])
        if (Number.isFinite(ts) && (oldest === null || ts < oldest)) oldest = ts
      } catch (e) {
        issues.push({ kind: 'bl-zamowienie', ref: id, message: errMsg(e) })
      }
    }
    if (batch.length < 100) break
    if (fresh === 0) {
      // Pełna paczka bez nowych zamówień: ponad 100 zamówień w jednej sekundzie — nie da się iść dalej tą metodą.
      issues.push({ kind: 'bl-zamowienia', ref: `od ${from}`, message: 'pełna paczka bez nowych zamówień (ta sama sekunda)' })
      complete = false
      break
    }
    // Dokumentacja BL: następna strona od date_confirmed ostatniego zamówienia (bez +1), duble odsiewa `seen`.
    const last = Number(batch[batch.length - 1]?.['date_confirmed'])
    from = Number.isFinite(last) ? last : from + 1
  }
  return { lines, orders, oldestUnix: oldest, complete }
}

export async function fetchWfirmaGoods(
  wf: WfirmaReadOnly,
  issues: FetchIssue[],
  warehouseId: string,
): Promise<{ goods: WfGood[]; total: number | null }> {
  const vc = await wf.call<{ vat_codes: unknown }>('vat_codes/find', {
    api: { vat_codes: { parameters: { page: 1, limit: 100 } } },
  })
  const vat = vatRatesFromApi(wfirmaItems<Record<string, unknown>>(vc.vat_codes, 'vat_code'))
  const goods: WfGood[] = []
  let fetched = 0
  let total: number | null = null
  for (let page = 1; page < 100; page++) {
    const r = await wf.call<{ goods: Record<string, unknown> }>('goods/find', {
      // Stabilne sortowanie po id dla pełnego odczytu stronami (spec 2.2 pkt 4).
      api: { goods: { parameters: { page, limit: 100, order: { asc: 'id' } } } },
    })
    const params = (r.goods?.['parameters'] ?? {}) as Record<string, unknown>
    total = Number(params['total']) || total
    const items = wfirmaItems<Record<string, unknown>>(r.goods, 'good')
    fetched += items.length
    for (const raw of items) {
      try {
        const g = wfGoodFromApi(raw, vat)
        // Spec 8.1: stan tylko z magazynu „Główny”; towar z innego magazynu odrzucony z alertem.
        if (g.warehouseId !== warehouseId) {
          issues.push({ kind: 'wfirma-inny-magazyn', ref: g.id, message: `towar w magazynie ${g.warehouseId ?? 'brak'}, oczekiwany ${warehouseId} — pominięty` })
          continue
        }
        goods.push(g)
      } catch (e) {
        issues.push({ kind: 'wfirma-towar', ref: String(raw['id']), message: errMsg(e) })
      }
    }
    if (items.length < 100) break
  }
  if (total !== null && fetched !== total) {
    issues.push({ kind: 'wfirma-liczba', ref: 'goods/find', message: `pobrano ${fetched} z ${total}` })
  }
  return { goods: [...new Map(goods.map((g) => [g.id, g])).values()], total }
}

/** Błąd w środku stronicowania = null (niepełna lista nie może udawać pełnej — przegląd r2, uwaga 11). */
export async function fetchEmpikOffers(mk: MiraklReadOnly, issues: FetchIssue[]): Promise<EmpikOffer[] | null> {
  const out: EmpikOffer[] = []
  for (let offset = 0; offset < 50_000; offset += 100) {
    try {
      const r = await mk.get<{ offers: Record<string, unknown>[]; total_count: number }>('/offers', { max: 100, offset })
      const list = r.offers ?? []
      out.push(...list.map(empikOfferFromApi))
      if (list.length < 100 || out.length >= r.total_count) break
    } catch (e) {
      issues.push({ kind: 'empik-oferty', ref: String(offset), message: errMsg(e) })
      return null
    }
  }
  return out
}
