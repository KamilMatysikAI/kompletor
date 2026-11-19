// Czysta logika importu: plan katalogu (BL + wFirma), mapowanie ofert kanałów, duplikaty, zgodność z wFirmą.
// Bez I/O — testowane jednostkowo. Wynik zapisuje lib/import/zapis.ts, raport składa lib/import/raport.ts.
import { createHash } from 'node:crypto'
import {
  normName,
  round2,
  type BlProd,
  type ChannelT,
  type EmpikOffer,
  type SaleLine,
  type ShopOffer,
  type UnitT,
  type WfGood,
} from './normalizacja'

export type MappingStateT = 'MAPPED' | 'UNMAPPED' | 'AMBIGUOUS'
export type MappingSourceT = 'BL_LINK' | 'BL_ORDERS' | 'SKU' | 'OVERRIDE' | 'CONFIG' | 'NONE'

// ─── Katalog ─────────────────────────────────────────────────────────────────

export type WfMatch = 'LINK' | 'SKU' | 'EAN'

export interface PlannedProduct {
  key: string // wf:<id> dla STOCKED, bundle:<blId> dla BUNDLE, digital:<sku> dla DIGITAL (lib/import/bez-stanu.ts)
  sku: string
  kind: 'STOCKED' | 'BUNDLE' | 'DIGITAL'
  unit: UnitT
  groupId: string | null
  wf: WfGood | null
  title: string
  ean: string | null
  blIds: string[]
  components: { componentKey: string; qtyBase: number }[]
  notes: string[]
  /** Miejsce na półce z BL (pierwsze niepuste z rekordów BL tego produktu, po id). */
  location: string | null
  /** stan startowy z magazynu BL (firma bez wFirmy, `planCatalog(..., blStock)`); przy towarze wFirmy brak. */
  startStock?: number
  /** źródło danych produktu bez towaru wFirmy (domyślnie BL — import, przeprowadzka); z towarem zawsze WFIRMA. */
  dataSource?: 'RECZNE' | 'KANAL' | 'CSV' | 'BL'
}

export interface CatalogPlan {
  products: PlannedProduct[]
  blToKey: Map<string, string>
  blMatch: Map<string, WfMatch>
  blWithoutWfirma: BlProd[]
  linkSkuConflicts: { bl: BlProd; viaLink: WfGood; viaSku: WfGood }[]
  /** Link BL → wFirma wskazuje towar spoza pobranego zbioru (usunięty, inny magazyn): bez dopasowania po SKU/EAN. */
  linkTargetMissing: { bl: BlProd; wfirmaGoodIdLink: string }[]
  /** Różne miejsca na półce w rekordach BL jednego produktu (wzięte pierwsze). */
  locationConflicts: { key: string; locations: string[] }[]
  manyBlToOneWf: { wf: WfGood; bl: BlProd[] }[]
  serviceMatches: { bl: BlProd; wf: WfGood }[]
  bundleProblems: { bl: BlProd; problem: string }[]
  invalidEans: BlProd[]
  skuCollisions: { sku: string; keys: string[] }[]
}

/** Niepuste kody miejsc z BL (po kluczu magazynu, stabilnie). */
export function locationsOf(p: BlProd | undefined): string[] {
  if (!p?.locations) return []
  return Object.keys(p.locations)
    .sort()
    .map((k) => p.locations![k]!.trim())
    .filter(Boolean)
}

/** Produkty BL, które są ofertą/magazynem: bez rodziców z wariantami. */
export function sellableBl(bl: BlProd[]): BlProd[] {
  return bl.filter((p) => !p.hasVariants)
}

/**
 * `blStock` (przeprowadzka firmy bez wFirmy): produkt ze stanem powstaje z rekordu BL o jednoznacznym SKU,
 * stan startowy z magazynu BL (id produktu BL → ilość). Rekord bez SKU albo z SKU powtórzonym w BL nie jest sklejany
 * (ani po nazwie) — trafia do `blWithoutWfirma`, czyli do raportu.
 */
export function planCatalog(blAll: BlProd[], wfGoods: WfGood[], blStock?: ReadonlyMap<string, number>): CatalogPlan {
  const wfById = new Map(wfGoods.map((g) => [g.id, g]))
  const wfByCode = new Map<string, WfGood[]>()
  for (const g of wfGoods) if (g.code) wfByCode.set(g.code, [...(wfByCode.get(g.code) ?? []), g])
  const wfByEan = new Map<string, WfGood[]>()
  for (const g of wfGoods) if (g.ean) wfByEan.set(g.ean, [...(wfByEan.get(g.ean) ?? []), g])

  const plan: CatalogPlan = {
    products: [],
    blToKey: new Map(),
    blMatch: new Map(),
    blWithoutWfirma: [],
    linkSkuConflicts: [],
    linkTargetMissing: [],
    locationConflicts: [],
    manyBlToOneWf: [],
    serviceMatches: [],
    bundleProblems: [],
    invalidEans: [],
    skuCollisions: [],
  }
  const byKey = new Map<string, PlannedProduct>()
  const bl = sellableBl(blAll)

  const skuCount = new Map<string, number>()
  if (blStock) for (const p of bl) if (!p.isBundle && p.sku) skuCount.set(p.sku, (skuCount.get(p.sku) ?? 0) + 1)

  for (const p of bl) {
    if (p.eanRaw && !p.eanValid) plan.invalidEans.push(p)
    if (p.isBundle) continue
    if (blStock) {
      if (!p.sku || skuCount.get(p.sku) !== 1) {
        plan.blWithoutWfirma.push(p)
        continue
      }
      const key = `bl:${p.id}`
      const qty = blStock.get(p.id) ?? 0
      byKey.set(key, {
        key,
        sku: p.sku,
        kind: 'STOCKED',
        unit: 'SZT',
        groupId: p.parentId,
        wf: null,
        title: p.name,
        ean: p.ean,
        blIds: [p.id],
        components: [],
        notes: Number.isInteger(qty) ? [] : [`stan BL ${qty} nie jest całkowity — zaokrąglony w dół`],
        location: null,
        startStock: Math.max(0, Math.floor(qty)),
      })
      plan.blToKey.set(p.id, key)
      continue
    }
    const viaLink = p.wfirmaGoodIdLink ? wfById.get(p.wfirmaGoodIdLink) : undefined
    if (p.wfirmaGoodIdLink && !viaLink) {
      // BL bierze dziś stan z tego (nieznanego nam) towaru — dopasowanie po SKU/EAN dałoby stan innego towaru.
      plan.linkTargetMissing.push({ bl: p, wfirmaGoodIdLink: p.wfirmaGoodIdLink })
      plan.blWithoutWfirma.push(p)
      continue
    }
    const skuHits = p.sku ? (wfByCode.get(p.sku) ?? []) : []
    const viaSku = skuHits.length === 1 ? skuHits[0] : undefined
    const eanHits = p.ean ? (wfByEan.get(p.ean) ?? []) : []
    const viaEan = eanHits.length === 1 ? eanHits[0] : undefined
    // Link do wFirmy wygrywa: z niego BL bierze dziś stan (accounting_1).
    const wf = viaLink ?? viaSku ?? viaEan
    if (!wf) {
      plan.blWithoutWfirma.push(p)
      continue
    }
    const match: WfMatch = viaLink ? 'LINK' : viaSku ? 'SKU' : 'EAN'
    if (viaLink && viaSku && viaLink.id !== viaSku.id) plan.linkSkuConflicts.push({ bl: p, viaLink, viaSku })
    if (wf.type === 'service') {
      plan.serviceMatches.push({ bl: p, wf })
      plan.blWithoutWfirma.push(p)
      continue
    }
    plan.blMatch.set(p.id, match)
    const key = `wf:${wf.id}`
    const existing = byKey.get(key)
    if (existing) {
      existing.blIds.push(p.id)
      plan.blToKey.set(p.id, key)
      continue
    }
    const planned: PlannedProduct = {
      key,
      sku: wf.code ?? p.sku ?? `wf-${wf.id}`,
      kind: 'STOCKED',
      unit: wf.unit,
      groupId: p.parentId,
      wf,
      title: p.name || wf.name,
      ean: p.ean,
      blIds: [p.id],
      components: [],
      notes: wf.code ? [] : ['towar wFirmy bez kodu (SKU) — SKU tymczasowy'],
      location: null,
    }
    byKey.set(key, planned)
    plan.blToKey.set(p.id, key)
  }

  // Zestawy wirtualne: składniki muszą być produktami ze stanem.
  for (const p of bl.filter((x) => x.isBundle)) {
    const comps = Object.entries(p.bundleProducts ?? {})
    if (comps.length === 0) {
      plan.bundleProblems.push({ bl: p, problem: 'zestaw bez składników' })
      continue
    }
    const components: PlannedProduct['components'] = []
    let ok = true
    for (const [compBlId, qty] of comps) {
      const compKey = plan.blToKey.get(compBlId)
      const comp = compKey ? byKey.get(compKey) : undefined
      if (!comp || comp.kind !== 'STOCKED') {
        plan.bundleProblems.push({
          bl: p,
          problem: comp ? `składnik BL ${compBlId} jest zestawem (zestaw w zestawie zabroniony)` : `składnik BL ${compBlId} bez towaru w wFirmie`,
        })
        ok = false
        continue
      }
      // Ilość w zestawie BL jest w jednostce BL (1 = 1 szt. albo 1 kg).
      const qtyBase = comp.unit === 'KG' ? Math.round(qty * 1000) : qty
      if (!Number.isInteger(qtyBase) || qtyBase <= 0) {
        plan.bundleProblems.push({ bl: p, problem: `ilość składnika BL ${compBlId} (${qty} szt.) nie jest całkowita` })
        ok = false
        continue
      }
      components.push({ componentKey: compKey!, qtyBase })
    }
    if (!ok) continue
    const key = `bundle:${p.id}`
    byKey.set(key, {
      key,
      sku: p.sku ?? `bl-zestaw-${p.id}`,
      kind: 'BUNDLE',
      unit: 'SZT',
      groupId: p.parentId,
      wf: null,
      title: p.name,
      ean: p.ean,
      blIds: [p.id],
      components,
      notes: [],
      location: null,
    })
    plan.blToKey.set(p.id, key)
  }

  const blById = new Map(bl.map((b) => [b.id, b]))
  for (const prod of byKey.values()) {
    if (prod.kind !== 'STOCKED') continue
    const locs = [...new Set([...prod.blIds].sort().flatMap((id) => locationsOf(blById.get(id))))]
    prod.location = locs[0] ?? null
    if (locs.length > 1) plan.locationConflicts.push({ key: prod.key, locations: locs })
  }

  for (const prod of byKey.values()) {
    if (prod.kind === 'STOCKED' && prod.blIds.length > 1) {
      plan.manyBlToOneWf.push({ wf: prod.wf!, bl: prod.blIds.map((id) => bl.find((b) => b.id === id)!).filter(Boolean) })
    }
  }

  // SKU w Product jest unikalne: kolizja (np. SKU zestawu = kod towaru) → sufiks i notatka.
  const bySku = new Map<string, PlannedProduct[]>()
  for (const prod of byKey.values()) bySku.set(prod.sku, [...(bySku.get(prod.sku) ?? []), prod])
  for (const [sku, list] of bySku) {
    if (list.length < 2) continue
    plan.skuCollisions.push({ sku, keys: list.map((l) => l.key) })
    // Pierwszeństwo ma towar wFirmy; sufiks z klucza (id BL/wFirmy), żeby nie zmieniał się między przebiegami.
    const sorted = [...list].sort((x, y) => (x.kind === y.kind ? x.key.localeCompare(y.key) : x.kind === 'STOCKED' ? -1 : 1))
    for (const l of sorted.slice(1)) {
      const suffixed = `${sku}~${l.key.replace(':', '-')}`
      l.notes.push(`kolizja SKU „${sku}” — zapisany jako „${suffixed}”`)
      l.sku = suffixed
    }
  }

  plan.products = [...byKey.values()]
  return plan
}

// ─── Sprzedaż 90 dni ─────────────────────────────────────────────────────────

/** BL: przy pozycji z magazynu (storage = db) właściwym produktem jest wariant, jeśli jest. */
export function blIdOfLine(l: SaleLine): string | null {
  if (l.storage !== 'db') return null
  return l.variantId ?? l.productId
}

/** Klucz oferty kanału dla linii sprzedaży. Sklepy Woo z magazynu BL wymagają odwróconych linków (null). */
export function offerKeyOfLine(l: SaleLine): string | null {
  switch (l.channel) {
    case 'WOO':
      if (l.storage === 'shop' && l.productId) return l.variantId ? `${l.productId}/${l.variantId}` : l.productId
      return null
    case 'EMPIK':
      return l.auctionId ? l.auctionId.replace(/^p/, '') : null
    default:
      return l.auctionId ?? (l.sku ? `sku:${l.sku}` : manualLineKey(l))
  }
}

/**
 * Pozycja bez SKU i bez oferty (dodana ręcznie w BL) ma nazwę wpisaną z ręki — może zawierać cokolwiek,
 * także dane klienta. Do klucza i raportu idzie tylko skrót nazwy (przegląd r2, uwaga 14).
 */
export const MANUAL_LINE_NAME = 'pozycja ręczna bez SKU'
export function manualLineKey(l: Pick<SaleLine, 'name'>): string {
  return `nazwa:${createHash('sha1').update(normName(l.name)).digest('hex').slice(0, 10)}`
}
/** Nazwa pozycji do raportu: dla pozycji z SKU albo ofertą — nazwa produktu/oferty, dla ręcznej — stały zamiennik. */
export function safeLineName(l: Pick<SaleLine, 'name' | 'sku' | 'auctionId' | 'productId'>): string {
  return l.sku || l.auctionId || l.productId ? l.name : MANUAL_LINE_NAME
}

export interface SalesAgg {
  qty: number
  orders: Set<string>
  lastSoldAt: Date | null
  blIds: Set<string>
  unlinkedLines: number
  sku: string | null
  ean: string | null
  name: string
}

export function offerMapKey(channel: ChannelT, accountId: string, externalId: string): string {
  return `${channel}|${accountId}|${externalId}`
}

/** Odwrócone linki BL: (sklep, oferta Woo) → produkty BL. */
export function shopLinkIndex(bl: BlProd[]): Map<string, string[]> {
  const idx = new Map<string, string[]>()
  for (const p of sellableBl(bl)) {
    for (const [storage, link] of Object.entries(p.links)) {
      if (!storage.startsWith('shop_')) continue
      const ext = link.variantId && link.variantId !== '0' ? `${link.productId}/${link.variantId}` : link.productId
      const k = `${storage}|${ext}`
      idx.set(k, [...(idx.get(k) ?? []), p.id])
    }
  }
  return idx
}

export function aggregateSales(lines: SaleLine[], bl: BlProd[]): Map<string, SalesAgg> {
  const blById = new Map(bl.map((p) => [p.id, p]))
  // Nazwa do raportu z katalogu BL (nazwa pozycji zamówienia jest w BL edytowalna —, drobna 8).
  const blBySku = new Map(bl.filter((p) => p.sku).map((p) => [p.sku!, p]))
  const out = new Map<string, SalesAgg>()
  for (const l of lines) {
    let ext = offerKeyOfLine(l)
    const blId = blIdOfLine(l)
    if (ext === null && blId) {
      // Sklep Woo, pozycja z magazynu BL: oferta = produkt sklepu podlinkowany do tego produktu BL.
      const link = blById.get(blId)?.links[`shop_${l.accountId}`]
      ext = link ? (link.variantId && link.variantId !== '0' ? `${link.productId}/${link.variantId}` : link.productId) : `bl:${blId}`
    }
    if (ext === null) ext = manualLineKey(l)
    const k = offerMapKey(l.channel, l.accountId, ext)
    const a =
      out.get(k) ??
      ({ qty: 0, orders: new Set(), lastSoldAt: null, blIds: new Set(), unlinkedLines: 0, sku: l.sku, ean: l.ean, name: (blId ? blById.get(blId)?.name : undefined) || (l.sku ? blBySku.get(l.sku)?.name : undefined) || safeLineName(l) } as SalesAgg)
    a.qty += l.qty
    a.orders.add(l.orderId)
    if (!a.lastSoldAt || l.soldAt > a.lastSoldAt) a.lastSoldAt = l.soldAt
    if (blId) a.blIds.add(blId)
    else a.unlinkedLines++
    out.set(k, a)
  }
  return out
}

// ─── Oferty kanałów i ich mapowanie ──────────────────────────────────────────

export interface OfferResult {
  channel: ChannelT
  accountId: string
  externalId: string
  sku: string | null
  ean: string | null
  name: string
  state: MappingStateT
  source: MappingSourceT
  blProductIds: string[]
  sales90dQty: number
  sales90dOrders: number
  lastSoldAt: Date | null
  notes: string[]
  /** Produkt z planu wprost (reguła bez stanu, źródło CONFIG) zamiast przez produkt BL. */
  productKey?: string
  /** Sklep Woo: kategoria produktu (reguły bez stanu). */
  shopCategoryId?: string
  /** Pozycja z magazynu bez oferty kanału (dodatek, składnik zestawu z konfiguracji firmy): poza progiem braków. */
  nonOffer?: boolean
}

/** Pewne powiązanie → oferta aktywna; Woo po samym SKU → propozycja do zatwierdzenia. */
export function offerIntent(o: OfferResult): 'ACTIVE' | 'PROPOSAL' {
  return o.channel === 'WOO' && o.source === 'SKU' ? 'PROPOSAL' : 'ACTIVE'
}

/** Identyfikatory zastępcze (nie są id oferty w kanale): nie mogą stać się ChannelOffer. */
export function isSyntheticOfferId(externalId: string): boolean {
  return /^(bl|sku|nazwa):/.test(externalId)
}

/**
 * Stan powiązania. `known` = produkty BL, z których powstał produkt w systemie (plan.blToKey);
 * id spoza zbioru (produkt usunięty z BL albo bez towaru w wFirmie) nie daje MAPPED.
 */
function stateOf(ids: string[], notes: string[], known?: Set<string>): MappingStateT {
  if (ids.length === 0) return 'UNMAPPED'
  if (ids.length > 1) return 'AMBIGUOUS'
  if (known && !known.has(ids[0]!)) {
    notes.push('produkt BL usunięty z katalogu albo bez towaru w wFirmie')
    return 'UNMAPPED'
  }
  return 'MAPPED'
}

function applySales(r: OfferResult, s: SalesAgg | undefined): OfferResult {
  if (!s) return r
  r.sales90dQty = s.qty
  r.sales90dOrders = s.orders.size
  r.lastSoldAt = s.lastSoldAt
  return r
}

function skuIndex(bl: BlProd[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const p of sellableBl(bl)) if (p.sku) m.set(p.sku, [...(m.get(p.sku) ?? []), p.id])
  return m
}

/** Sklepy Woo: oferty z magazynów zewnętrznych BL, mapowanie po linkach BL, awaryjnie po SKU. */
export function classifyShopOffers(
  offers: ShopOffer[],
  bl: BlProd[],
  sales: Map<string, SalesAgg>,
  known: Set<string> | undefined,
  shopAccounts: readonly string[],
): OfferResult[] {
  const links = shopLinkIndex(bl)
  const bySku = skuIndex(bl)
  const blById = new Map(bl.map((p) => [p.id, p]))
  const results: OfferResult[] = []
  const seen = new Set<string>()
  for (const o of offers) {
    if (o.isParentWithVariants) continue // sprzedają się warianty, nie rodzic
    // konto sklepu = id magazynu zewnętrznego BL bez „shop_” (konwencja BL); tylko sklepy z konfiguracji firmy
    const accountId = o.storageId.replace(/^shop_/, '')
    if (!shopAccounts.includes(accountId)) continue
    const channel: ChannelT = 'WOO'
    const key = offerMapKey(channel, accountId, o.externalId)
    if (seen.has(key)) continue
    seen.add(key)
    const linked = links.get(`${o.storageId}|${o.externalId}`) ?? []
    const notes: string[] = []
    let ids = linked
    let source: MappingSourceT = linked.length ? 'BL_LINK' : 'NONE'
    if (linked.length === 0 && o.sku) {
      const hits = bySku.get(o.sku) ?? []
      if (hits.length) {
        ids = hits
        source = 'SKU'
        notes.push('brak linku w BL — dopasowane po SKU, do zatwierdzenia (oferta nieaktywna)')
      }
    }
    if (linked.length === 1 && o.sku) {
      const blSku = blById.get(linked[0]!)?.sku
      if (blSku && blSku !== o.sku) notes.push(`SKU w sklepie „${o.sku}” ≠ SKU w BL „${blSku}”`)
    }
    if (o.sku?.startsWith('ignore-')) notes.push('SKU „ignore-*” — produkt techniczny sklepu')
    results.push(
      applySales(
        {
          channel,
          accountId,
          externalId: o.externalId,
          sku: o.sku,
          ean: o.ean,
          name: o.name,
          state: stateOf(ids, notes, known),
          source,
          blProductIds: ids,
          sales90dQty: 0,
          sales90dOrders: 0,
          lastSoldAt: null,
          notes,
          ...(o.categoryId ? { shopCategoryId: o.categoryId } : {}),
        },
        sales.get(key),
      ),
    )
  }
  // Warianty jednego produktu sklepu dopasowane po samym SKU do jednego produktu BL: wariant to zwykle inna
  // gramatura albo opakowanie, więc przynajmniej jeden rezerwowałby złą ilość (przegląd r2, uwaga 1).
  const bySkuGroup = new Map<string, OfferResult[]>()
  for (const r of results) {
    if (r.source !== 'SKU' || r.state !== 'MAPPED' || !r.externalId.includes('/')) continue
    const g = `${r.channel}|${r.accountId}|${r.externalId.split('/')[0]}|${r.blProductIds[0]}`
    bySkuGroup.set(g, [...(bySkuGroup.get(g) ?? []), r])
  }
  for (const list of bySkuGroup.values()) {
    if (list.length < 2) continue
    for (const r of list) {
      r.state = 'AMBIGUOUS'
      r.notes = r.notes.filter((x) => !x.startsWith('brak linku w BL'))
      r.notes.push(`warianty o wspólnym SKU (${list.map((x) => x.externalId).join(', ')}) — który wariant to ten towar, rozstrzyga człowiek`)
    }
  }
  // Sprzedaż w sklepie, której nie ma na liście produktów sklepu (usunięty produkt albo pozycja „bl:<id>”).
  for (const [k, s] of sales) {
    const [channel, accountId, externalId] = k.split('|') as [ChannelT, string, string]
    if (channel !== 'WOO' || seen.has(k)) continue
    const ids = [...s.blIds]
    const synthetic = isSyntheticOfferId(externalId)
    const notes = [
      synthetic
        ? 'sprzedaż z magazynu BL bez linku do produktu sklepu — oferta sklepu nieznana'
        : 'nie ma na liście produktów sklepu w BL',
    ]
    // Bez znanej oferty sklepu nie ma czego powiązać: liczy się do progu braków.
    const state: MappingStateT = synthetic ? 'UNMAPPED' : stateOf(ids, notes, known)
    results.push({
      channel,
      accountId,
      externalId,
      sku: s.sku,
      ean: s.ean,
      name: s.name,
      state,
      source: ids.length ? 'BL_ORDERS' : 'NONE',
      blProductIds: ids,
      sales90dQty: s.qty,
      sales90dOrders: s.orders.size,
      lastSoldAt: s.lastSoldAt,
      notes,
    })
  }
  return results
}

/** Kanały znane tylko ze sprzedaży (Allegro, inne źródła BL): mapowanie z pozycji zamówień BL. */
export function classifyFromSales(sales: Map<string, SalesAgg>, channels: ChannelT[], known?: Set<string>): OfferResult[] {
  const out: OfferResult[] = []
  for (const [k, s] of sales) {
    const [channel, accountId, externalId] = k.split('|') as [ChannelT, string, string]
    if (!channels.includes(channel)) continue
    const ids = [...s.blIds]
    const notes: string[] = []
    if (ids.length && s.unlinkedLines) notes.push(`${s.unlinkedLines} pozycji sprzedaży bez powiązania z magazynem`)
    if (ids.length > 1) notes.push('jedna oferta → kilka produktów BL (zmiana powiązania albo oferta wielowariantowa)')
    out.push({
      channel,
      accountId,
      externalId,
      sku: s.sku,
      ean: s.ean,
      name: s.name,
      state: stateOf(ids, notes, known),
      source: ids.length ? 'BL_ORDERS' : 'NONE',
      blProductIds: ids,
      sales90dQty: s.qty,
      sales90dOrders: s.orders.size,
      lastSoldAt: s.lastSoldAt,
      notes,
    })
  }
  return out
}

/** Empik: oferty z OF21 (shop_sku = SKU BL) + powiązania ze sprzedaży BL (auction_id „p<product_sku>”). */
export function classifyEmpik(
  offers: EmpikOffer[],
  accountId: string,
  bl: BlProd[],
  sales: Map<string, SalesAgg>,
  known?: Set<string>,
): OfferResult[] {
  const bySku = skuIndex(bl)
  const out: OfferResult[] = []
  const seen = new Set<string>()
  for (const o of offers) {
    const key = offerMapKey('EMPIK', accountId, o.externalId)
    if (seen.has(key)) continue
    seen.add(key)
    const s = sales.get(key)
    const fromSales = s ? [...s.blIds] : []
    const fromSku = o.shopSku ? (bySku.get(o.shopSku) ?? []) : []
    const ids = [...new Set([...fromSales, ...fromSku])]
    const notes: string[] = []
    if (fromSales.length && fromSku.length && fromSales.some((id) => !fromSku.includes(id))) {
      notes.push('sprzedaż w BL idzie na inny produkt niż wskazuje shop_sku')
    }
    if (!o.active) notes.push('oferta nieaktywna na Empiku')
    out.push(
      applySales(
        {
          channel: 'EMPIK',
          accountId,
          externalId: o.externalId,
          sku: o.shopSku,
          ean: o.ean,
          name: o.name,
          state: stateOf(ids, notes, known),
          source: fromSales.length ? 'BL_ORDERS' : fromSku.length ? 'SKU' : 'NONE',
          blProductIds: ids,
          sales90dQty: 0,
          sales90dOrders: 0,
          lastSoldAt: null,
          notes,
        },
        s,
      ),
    )
  }
  for (const r of classifyFromSales(sales, ['EMPIK'], known)) {
    if (seen.has(offerMapKey('EMPIK', r.accountId, r.externalId))) continue
    r.notes.push('brak na liście ofert Empiku (OF21)')
    out.push(r)
  }
  return out
}

// ─── Duplikaty ───────────────────────────────────────────────────────────────

export function duplicates<T>(items: T[], keyOf: (t: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = keyOf(it)
    if (!k) continue
    m.set(k, [...(m.get(k) ?? []), it])
  }
  for (const [k, v] of m) if (v.length < 2) m.delete(k)
  return m
}

// ─── Zgodność BL ↔ wFirma (punkt 3a) ─────────────────────────────────────────

export interface WfDiff {
  bl: BlProd
  wf: WfGood
  match: WfMatch
  nameDiff: boolean
  priceDiff: { bl: number | null; wf: number | null } | null
  vatDiff: { bl: number | null; wf: string | null } | null
  stockDiff: { bl: number | null; wf: number | null } | null
}

export interface WfCompliance {
  checked: number
  byMatch: Record<WfMatch, number>
  withoutCounterpart: BlProd[]
  diffs: WfDiff[]
}

export function compareWithWfirma(plan: CatalogPlan, blAll: BlProd[]): WfCompliance {
  const res: WfCompliance = { checked: 0, byMatch: { LINK: 0, SKU: 0, EAN: 0 }, withoutCounterpart: [], diffs: [] }
  const keyToProduct = new Map(plan.products.map((p) => [p.key, p]))
  for (const p of sellableBl(blAll)) {
    if (p.isBundle) continue
    res.checked++
    const match = plan.blMatch.get(p.id)
    const prod = keyToProduct.get(plan.blToKey.get(p.id) ?? '')
    if (!match || !prod?.wf) {
      res.withoutCounterpart.push(p)
      continue
    }
    res.byMatch[match]++
    const wf = prod.wf
    const nameDiff = normName(p.name) !== normName(wf.name)
    const priceDiff =
      p.priceGross !== null && wf.priceGrossRetail !== null && Math.abs(p.priceGross - wf.priceGrossRetail) >= 0.01
        ? { bl: round2(p.priceGross), wf: round2(wf.priceGrossRetail) }
        : p.priceGross !== null && wf.priceGrossRetail === null
          ? { bl: round2(p.priceGross), wf: null }
          : null
    const wfVat = wf.vatRate !== null && /^\d+$/.test(wf.vatRate) ? Number(wf.vatRate) : null
    const vatDiff = p.taxRate !== null && wfVat !== null && p.taxRate !== wfVat ? { bl: p.taxRate, wf: wf.vatRate } : null
    // BL obcina ułamki kg; różnica stanu tylko informacyjnie (755/763 zgodne).
    const wfStockInBlUnits = wf.count === null ? null : wf.unit === 'KG' ? Math.floor(wf.count) : wf.count
    const stockDiff =
      p.stockAccounting !== null && wfStockInBlUnits !== null && Math.abs(p.stockAccounting - wfStockInBlUnits) >= 0.001
        ? { bl: p.stockAccounting, wf: wf.count }
        : null
    if (nameDiff || priceDiff || vatDiff || stockDiff) res.diffs.push({ bl: p, wf, match, nameDiff, priceDiff, vatDiff, stockDiff })
  }
  return res
}
