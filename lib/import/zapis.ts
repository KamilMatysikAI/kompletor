// Zapis wyniku importu do lokalnej bazy. Idempotentny (upserty po kluczach naturalnych), błąd jednego
// elementu → ImportIssue i dalej (fail-safe per element). Stan: tylko wiersz startowy (INITIAL_IMPORT);
// dalszą synchronizację lustra wFirmy prowadzi rdzeń (spec 2.2).
//
// Oferty (ChannelOffer) — zasady po przeglądzie r2:
// - powiązanie pewne (link BL, sprzedaż BL, Empik shop_sku, tabela nadpisań) → oferta aktywna;
// - Woo dopasowane po samym SKU (bez linku BL) → propozycja: nieaktywna, `needsApproval`, do zatwierdzenia w panelu;
// - `mappingSource = MANUAL` (panel) → import nie zmienia productId, active ani qtyBasePerOffer;
// - import włącza z powrotem tylko ofertę, którą sam wyłączył (`deactivatedByImportAt`); wyłączenie w panelu jest trwałe;
// - wyłączanie ofert (brak powiązania, zniknięcie z kanału) tylko, gdy lista ofert kanału była pobrana w całości.
// po zapisie ofert zamówienia z pozycjami bez produktu, których oferta jest już aktywna (założona albo
// włączona tym albo wcześniejszym przebiegiem), dostają produkt i rezerwację (`przeliczZalegle`, każde osobno).
// zapis klientem firmy (RLS, unikalności z organizationId); magazyn i kanały zakłada konfiguracja firmy
// (lib/organizacje.ts), nie import.
import { Prisma, type PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { channelComplete, MISSING_KEYS, SALES_ONLY_CHANNELS, shopFetchFailed, type Analysis, type RawSources } from './katalog'
import { isSyntheticOfferId, offerIntent, type PlannedProduct } from './mapowanie'
import { NonRetryableError } from '../bledy'
import type { ChannelT } from './normalizacja'
import { createInitialStock, dec, MAIN_WAREHOUSE_ID, upsertProduct } from './zapis-produktu'
import { przeliczZalegle } from '../kanaly/przeliczenie'
import { powodOfertaWylaczony, wylaczoneProdukty } from '../produkty/aktywnosc'

// zapis jednego produktu (upsertProduct, createInitialStock) w osobnym module bez zależności od
// lib/import/katalog.ts — „Dodaj produkt” w panelu używa tego samego kodu, a katalog (plik nadpisań z dysku) nie
// trafia do serwera Next. Reeksport dla dotychczasowych importów.
export { createInitialStock, MAIN_WAREHOUSE_ID, upsertProduct }

/** Bezpiecznik masowej deaktywacji: odmowa, gdy w kanale do wyłączenia jest > 20 % aktywnych ofert i > 5 sztuk. */
export const MASS_OFF_SHARE = 0.2
export const MASS_OFF_MIN = 5

async function countDeactivations(db: PrismaClient, list: { offerId?: string; staleWhere?: Prisma.ChannelOfferWhereInput }[]): Promise<number> {
  let n = list.filter((x) => x.offerId).length
  const stale = list.filter((x) => x.staleWhere).map((x) => x.staleWhere!)
  if (stale.length) n += await db.channelOffer.count({ where: { OR: stale } })
  return n
}

export interface PersistStats {
  runId: string
  status: 'OK' | 'PARTIAL'
  products: number
  bundles: number
  /** Produkty bez stanu z reguł firmy: bez wiersza Stock. */
  digitalProducts: number
  stocksCreated: number
  stocksKept: number
  locationsSet: number
  wfirmaGoods: number
  blProducts: number
  offerImports: number
  channelOffers: number
  channelOffersProposed: number
  channelOffersReactivated: number
  channelOffersDeactivated: number
  channelOffersManualKept: number
  channelOffersMassOffRefused: number
  channelOffersMassOffAllowed: number
  /** oferty z pewnym powiązaniem do wyłączonego produktu, już nieaktywne — bez pozycji, nie zmienia statusu. */
  channelOffersOnDisabledProduct: number
  staleRemoved: number
  /** zamówienia, którym przebieg dopisał produkt do pozycji bez powiązania. */
  ordersRemapped: number
  ordersRemapFailed: number
  issues: number
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2000)

/**
 * Import odmawia zapisu bez towarów wFirmy: bez nich żaden produkt nie powstaje, a wszystkie oferty by zgasły.
 * Nieponawialny przy braku kluczy oraz przy limicie i odmowie API wFirmy (LIMIT, HTTP 429, inne 4xx) — następny
 * przebieg z harmonogramu. Przy 5xx i błędzie sieci `persistImport` rzuca zwykły `Error` tej samej treści — zadanie
 * workera się ponawia (drobna 2).
 */
export class ImportRefused extends NonRetryableError {
  constructor(message: string) {
    super(message)
    this.name = 'ImportRefused'
  }
}

/**
 * Liczba ofert kanału w samym źródle listy ofert (Woo: magazyn `shop_<konto>` z BL, Empik: OF21) — bez ofert
 * dopisanych ze sprzedaży. `null` = kanał bez pełnej listy ofert albo lista niepobrana (drobna 1).
 */
function sourceOfferCount(raw: RawSources, channel: ChannelT, accountId: string): number | null {
  if (channel === 'WOO') {
    if (!raw.channels.shopAccounts.includes(accountId)) return null
    return raw.shopOffers.filter((o) => o.storageId === `shop_${accountId}`).length
  }
  if (channel === 'EMPIK') return raw.empik !== null && raw.channels.empikAccountId === accountId ? raw.empik.length : null
  return null
}

export async function persistImport(
  db: PrismaClient,
  raw: RawSources,
  a: Analysis,
  opts: { actor?: string; now?: Date } = {},
): Promise<PersistStats> {
  const actor = opts.actor ?? 'system:import-katalogu'
  const now = opts.now ?? new Date()
  const organizationId = organizationIdOf(db)
  // przeprowadzka firmy bez wFirmy (stockSource 'bl') — produkty i stan z BL, bez wFirmy z założenia.
  const blOnly = raw.stockSource === 'bl'
  if (!raw.wfirma && !blOnly) {
    const missingKeys = raw.issues.some((i) => i.kind === MISSING_KEYS && i.ref === 'wfirma')
    const wfIssues = raw.issues.filter((i) => i.kind === 'wfirma')
    // Limit wFirmy, HTTP 429 i inne 4xx: ponowienie z kolejki tylko przedłuża blokadę klucza, którym BL wystawia
    // faktury — następna próba dopiero z harmonogramu.
    const refused = wfIssues.some((i) => i.retryable === false)
    const why = missingKeys
      ? 'brak kluczy wFirmy'
      : refused
        ? 'towary wFirmy nie zostały pobrane: limit albo odmowa API (bez ponawiania)'
        : 'towary wFirmy nie zostały pobrane (błąd serwera albo sieci)'
    // Treść odpowiedzi wFirmy (np. „AUTH FAILED LIMIT WAIT 5 MINUTES”, „HTTP 503”) też do bazy.
    const detail = wfIssues.length ? ` [wFirma: ${wfIssues.map((i) => i.message).join('; ')}]` : ''
    const message = errMsg(`import odrzucony: ${why} — bez wFirmy nie powstaje żaden produkt, a wszystkie oferty zostałyby wyłączone${detail}`)
    // Błąd musi zostać w bazie, nie tylko w logu procesu.
    await db.importRun.create({ data: { kind: 'katalog-bl-wfirma', status: 'FAILED', finishedAt: now, error: message } })
    throw missingKeys || refused ? new ImportRefused(message) : new Error(message)
  }
  const run = await db.importRun.create({ data: { kind: blOnly ? 'katalog-bl' : 'katalog-bl-wfirma' } })
  let issues = 0
  const issue = async (kind: string, ref: string, e: unknown) => {
    issues++
    await db.importIssue.create({ data: { runId: run.id, kind, ref, message: errMsg(e) } }).catch(() => {})
  }
  for (const i of raw.issues) await issue(`pobieranie:${i.kind}`, i.ref, i.message)
  for (const p of a.overrideProblems) await issue('nadpisanie-oferty', p.split(':')[0] ?? p, p)

  const stats: PersistStats = {
    runId: run.id,
    status: 'OK',
    products: 0,
    bundles: 0,
    digitalProducts: 0,
    stocksCreated: 0,
    stocksKept: 0,
    locationsSet: 0,
    wfirmaGoods: 0,
    blProducts: 0,
    offerImports: 0,
    channelOffers: 0,
    channelOffersProposed: 0,
    channelOffersReactivated: 0,
    channelOffersDeactivated: 0,
    channelOffersManualKept: 0,
    channelOffersMassOffRefused: 0,
    channelOffersMassOffAllowed: 0,
    channelOffersOnDisabledProduct: 0,
    staleRemoved: 0,
    ordersRemapped: 0,
    ordersRemapFailed: 0,
    issues: 0,
  }
  const completeCache = new Map<string, boolean>()
  // Kanał z pełną listą ofert (Woo, Empik), którego lista w źródle jest pusta przy istniejących wierszach
  // z poprzednich przebiegów = lista ucięta bez błędu (paginacja BL, pusta odpowiedź Mirakl) — traktujemy jak
  // niepełny (uwaga 2a). Liczymy listę źródła, nie `a.offers`: te mają też oferty ze
  // sprzedaży. Raz na kanał ImportIssue, przebieg PARTIAL.
  // Zbiór wypełnia pierwszy krok bloku `try` niżej (wyjątek z groupBy = ImportRun FAILED).
  const emptied = new Set<string>()
  const isComplete = (channel: ChannelT, accountId: string, purpose: 'deactivate' | 'stale' = 'deactivate') => {
    const k = `${channel}|${accountId}|${purpose}`
    if (!completeCache.has(k)) completeCache.set(k, !emptied.has(`${channel}|${accountId}`) && channelComplete(raw, channel, accountId, purpose))
    return completeCache.get(k)!
  }
  // Wyłączenia zbieramy i stosujemy na końcu per kanał z bezpiecznikiem masowej deaktywacji (uwaga 2b).
  type PendingOff = { channelKey: string; offerId?: string; data?: Prisma.ChannelOfferUpdateInput; staleImportId?: string; staleWhere?: Prisma.ChannelOfferWhereInput; ref: string }
  const pendingOff: PendingOff[] = []

  try {
    // groupBy nie zwraca grup o liczności 0, więc każda grupa ma wiersze z poprzednich przebiegów.
    const prevPerChannel = await db.channelOfferImport.groupBy({ by: ['channel', 'channelAccountId'], _count: { _all: true } })
    for (const g of prevPerChannel) {
      const channel = g.channel as ChannelT
      if (SALES_ONLY_CHANNELS.includes(channel)) continue
      if (sourceOfferCount(raw, channel, g.channelAccountId) !== 0) continue
      // Błąd pobrania listy sklepu jest już w ImportIssue `pobieranie:bl-sklep*` i sam robi kanał niepełnym —
      // bez drugiego, mylącego wpisu „lista ucięta”.
      if (channel === 'WOO' && shopFetchFailed(raw, g.channelAccountId)) continue
      const ck = `${channel}|${g.channelAccountId}`
      emptied.add(ck)
      await issue('oferta-nieaktualna', ck, `pusta lista ofert kanału przy ${g._count._all} wierszach z poprzednich przebiegów — lista prawdopodobnie ucięta; nic nie wyłączono`)
    }

    // Magazyn i kanały to konfiguracja firmy (applyOrgPreset / panel) — bez niej import nie ma gdzie zapisać stanu.
    if (!(await db.warehouse.findFirst({ where: { id: MAIN_WAREHOUSE_ID }, select: { id: true } })))
      throw new Error(`Brak magazynu „${MAIN_WAREHOUSE_ID}” w konfiguracji firmy — załóż konfigurację przed importem`)

    // Kopia towarów wFirmy
    for (const g of raw.wfirma?.goods ?? []) {
      try {
        const data = {
          code: g.code,
          name: g.name,
          type: g.type,
          unit: g.unitRaw,
          vatCodeId: g.vatCodeId,
          vatRate: g.vatRate,
          priceNetRetail: dec(g.priceNetRetail),
          priceGrossRetail: dec(g.priceGrossRetail),
          purchasePriceNet: dec(g.purchasePriceNet, 4),
          count: dec(g.count, 4),
          warehouseId: g.warehouseId,
          ean: g.ean,
          visibility: g.visibility,
          modified: g.modified,
          importRunId: run.id,
          importedAt: new Date(),
        }
        await db.wfirmaGood.upsert({ where: { organizationId_id: { organizationId, id: g.id } }, create: { organizationId, id: g.id, ...data }, update: data })
        stats.wfirmaGoods++
      } catch (e) {
        await issue('wfirma-towar', g.id, e)
      }
    }

    // Produkty (najpierw STOCKED, potem zestawy, bo te wskazują składniki; na końcu bez stanu)
    const keyToId = new Map<string, string>()
    const unitOf = new Map<string, 'SZT' | 'KG'>()
    const rank = { STOCKED: 0, BUNDLE: 1, DIGITAL: 2 } as const
    const ordered = [...a.plan.products].sort((x, y) => rank[x.kind] - rank[y.kind])
    for (const p of ordered) {
      try {
        const { id, unit, unitConflict } = await upsertProduct(db, organizationId, p, raw.fetchedAt)
        keyToId.set(p.key, id)
        unitOf.set(p.key, unit)
        if (unitConflict) {
          // Zmiana jednostki to decyzja biura, nie importu: Stock jest w starej jednostce bazowej (przegląd r2, uwaga 9).
          await issue('jednostka', p.key, `jednostka w wFirmie zmieniona ${unitConflict.from} → ${unitConflict.to} — produkt zostaje w ${unitConflict.from}, do decyzji biura`)
        }
        if (p.kind === 'BUNDLE') {
          const comps = p.components.map((c) => {
            const componentId = keyToId.get(c.componentKey)
            // Zestaw z niepełnym składem rezerwowałby za mało: cały zestaw idzie do ImportIssue.
            if (!componentId) throw new Error(`składnik ${c.componentKey} nie został zapisany — zestaw pominięty`)
            return { componentId, qtyBase: c.qtyBase }
          })
          await db.$transaction([
            db.bundleComponent.deleteMany({ where: { bundleId: id } }),
            db.bundleComponent.createMany({ data: comps.map((c) => ({ bundleId: id, ...c })) }),
          ])
          stats.bundles++
        } else if (p.kind === 'DIGITAL') {
          // Bez stanu: ani Stock, ani ruchu startowego, ani miejsca na półce.
          stats.digitalProducts++
        } else {
          stats.products++
          if (!unitConflict) {
            const created = await createInitialStock(db, id, p, actor, new Date(raw.fetchedAt))
            if (created) stats.stocksCreated++
            else stats.stocksKept++
          }
          if (p.location) {
            // Miejsce na półce: źródłem jest BL do przełączenia; pusty kod w BL nie kasuje wpisu.
            const r = await db.stock.updateMany({
              where: { productId: id, warehouseId: MAIN_WAREHOUSE_ID, OR: [{ location: null }, { location: { not: p.location } }] },
              data: { location: p.location },
            })
            stats.locationsSet += r.count
          }
        }
      } catch (e) {
        await issue('produkt', p.key, e)
      }
    }

    // Kopia produktów BL z powiązaniem do naszego produktu
    for (const b of raw.bl.products) {
      try {
        const key = a.plan.blToKey.get(b.id)
        const data = {
          inventoryId: raw.bl.inventoryId,
          parentId: b.parentId,
          sku: b.sku,
          ean: b.eanRaw,
          name: b.name,
          isBundle: b.isBundle,
          bundleProducts: (b.bundleProducts ?? undefined) as Prisma.InputJsonValue | undefined,
          taxRate: dec(b.taxRate),
          priceGross: dec(b.priceGross),
          stockAccounting: dec(b.stockAccounting, 4),
          stockBl: dec(b.stockBl, 4),
          links: b.links as unknown as Prisma.InputJsonValue,
          wfirmaGoodIdLink: b.wfirmaGoodIdLink,
          // BlProduct to kopia BL: wyczyszczone miejsca w BL czyszczą kopię (Stock.location zostaje — pusty kod go nie kasuje).
          locations: b.locations ? (b.locations as Prisma.InputJsonValue) : Prisma.DbNull,
          productId: key ? (keyToId.get(key) ?? null) : null,
          importRunId: run.id,
          importedAt: new Date(),
        }
        await db.blProduct.upsert({ where: { organizationId_id: { organizationId, id: b.id } }, create: { organizationId, id: b.id, ...data }, update: data })
        stats.blProducts++
      } catch (e) {
        await issue('bl-produkt', b.id, e)
      }
    }

    // produkty wyłączone w Kompletorze (import flagi nie zmienia). Pewne powiązanie nie aktywuje, nie wznawia
    // i nie przepina na nie oferty: oferta zostaje nieaktywna z pozycją w raporcie importu.
    const wylaczone = await wylaczoneProdukty(db, [...keyToId.values()])
    // Oferty kanałów: wynik mapowania (wszystkie) + ChannelOffer dla jednoznacznych z produktem
    for (const o of a.offers) {
      const ref = `${o.channel}|${o.accountId}|${o.externalId}`
      try {
        // Reguła bez stanu wskazuje produkt planu wprost; pozostałe przez jedyny produkt BL.
        const key =
          o.state !== 'MAPPED' || isSyntheticOfferId(o.externalId)
            ? undefined
            : (o.productKey ?? (o.blProductIds.length === 1 ? a.plan.blToKey.get(o.blProductIds[0]!) : undefined))
        const productId = key ? (keyToId.get(key) ?? null) : null
        const data = {
          sku: o.sku,
          ean: o.ean,
          name: o.name,
          state: o.state,
          source: o.source,
          blProductIds: o.blProductIds,
          productId,
          sales90dQty: Math.round(o.sales90dQty),
          sales90dOrders: o.sales90dOrders,
          lastSoldAt: o.lastSoldAt,
          notes: o.notes,
          importRunId: run.id,
        }
        const where = {
          organizationId_channel_channelAccountId_externalId: { organizationId, channel: o.channel, channelAccountId: o.accountId, externalId: o.externalId },
        }
        await db.channelOfferImport.upsert({
          where,
          create: { organizationId, channel: o.channel, channelAccountId: o.accountId, externalId: o.externalId, ...data },
          update: data,
        })
        stats.offerImports++
        const existing = await db.channelOffer.findUnique({ where })
        if (existing?.mappingSource === 'MANUAL') {
          stats.channelOffersManualKept++
          continue
        }
        const complete = isComplete(o.channel, o.accountId)
        if (productId && key) {
          // Oferta sprzedaje 1 jednostkę BL: przy towarze w kg to 1 kg = 1000 g (stan BL = kg z wFirmy).
          const qtyBasePerOffer = unitOf.get(key) === 'KG' ? 1000 : 1
          const intent = offerIntent(o)
          const skuWylaczonego = intent === 'ACTIVE' ? wylaczone.get(productId) : undefined
          // Aktywna oferta już przy tym produkcie (np. wyścig z wyłączeniem) idzie zwykłą ścieżką: nic jej nie wznawia.
          if (skuWylaczonego !== undefined && !(existing?.active && existing.productId === productId)) {
            // Pozycja w raporcie tylko przy zmianie stanu w tym przebiegu (nowa oferta albo gaszenie aktywnej). Oferta już
            // nieaktywna = sam licznik w stats: inaczej każdy kolejny import byłby PARTIAL bez końca.
            if (existing && !existing.active) {
              stats.channelOffersOnDisabledProduct++
              continue
            }
            await issue('oferta-produkt-wylaczony', ref, powodOfertaWylaczony(skuWylaczonego))
            if (!existing) {
              // jak wyłączona przez import: po włączeniu produktu następny import ją wznowi
              await db.channelOffer.create({
                data: { channel: o.channel, channelAccountId: o.accountId, externalId: o.externalId, productId, qtyBasePerOffer, mappingSource: o.source, active: false, deactivatedByImportAt: now },
              })
            } else if (existing.active) {
              // aktywna przy innym produkcie, a powiązanie wskazuje wyłączony: bez przepięcia, stara nie może dalej rezerwować
              pendingOff.push({ channelKey: `${o.channel}|${o.accountId}`, offerId: existing.id, data: { active: false, deactivatedByImportAt: now }, ref })
            }
            continue
          }
          if (!existing) {
            await db.channelOffer.create({
              data: {
                channel: o.channel,
                channelAccountId: o.accountId,
                externalId: o.externalId,
                productId,
                qtyBasePerOffer,
                mappingSource: o.source,
                ...(intent === 'PROPOSAL' ? { active: false, needsApproval: true, deactivatedByImportAt: now } : {}),
              },
            })
            if (intent === 'PROPOSAL') stats.channelOffersProposed++
            else stats.channelOffers++
            continue
          }
          const remap = existing.productId !== productId ? { productId, qtyBasePerOffer } : {}
          const offByImport = !existing.active && existing.deactivatedByImportAt !== null
          if (intent === 'ACTIVE') {
            await db.channelOffer.update({
              where: { id: existing.id },
              data: {
                ...remap,
                mappingSource: o.source,
                needsApproval: false,
                ...(offByImport ? { active: true, deactivatedByImportAt: null } : {}),
              },
            })
            if (offByImport) stats.channelOffersReactivated++
            stats.channelOffers++
          } else if (existing.active) {
            // Pewne powiązanie zniknęło, zostało samo SKU: wyłączamy do zatwierdzenia (tylko przy pełnej liście kanału).
            if (complete) {
              pendingOff.push({
                channelKey: `${o.channel}|${o.accountId}`,
                offerId: existing.id,
                data: { ...remap, mappingSource: o.source, active: false, needsApproval: true, deactivatedByImportAt: now },
                ref,
              })
            }
            // Przy niepełnym źródle nic nie zapisujemy: ChannelOffer.mappingSource (np. BL_LINK) może się wtedy różnić
            // od ChannelOfferImport.source (SKU) do pierwszego pełnego przebiegu — zamierzone (drobna 12).
          } else if (offByImport) {
            await db.channelOffer.update({ where: { id: existing.id }, data: { ...remap, mappingSource: o.source, needsApproval: true } })
            stats.channelOffersProposed++
          }
          // Oferta wyłączona w panelu (active = false bez deactivatedByImportAt) zostaje nietknięta.
        } else if (existing?.active && complete) {
          // Powiązanie zniknęło albo stało się wieloznaczne: stara oferta nie może dalej rezerwować dawnego produktu.
          pendingOff.push({ channelKey: `${o.channel}|${o.accountId}`, offerId: existing.id, data: { active: false, deactivatedByImportAt: now }, ref })
        }
      } catch (e) {
        await issue('oferta', ref, e)
      }
    }
    // Oferty, których nie ma już w źródłach: tylko dla kanałów z pełną listą ofert (Woo, Empik). Kanały znane
    // tylko z okna sprzedaży (Allegro, inne BL, ręczne, EasyTools) nie są sprzątane — oferta wypadła z okna,
    // a nie z kanału (uwaga 1; do zmiany po adapterze Allegro, F2).
    const current = new Set(a.offers.map((o) => `${o.channel}|${o.accountId}|${o.externalId}`))
    const stale = await db.channelOfferImport.findMany({
      where: { importRunId: { not: run.id } },
      select: { id: true, channel: true, channelAccountId: true, externalId: true },
    })
    for (const st of stale) {
      if (current.has(`${st.channel}|${st.channelAccountId}|${st.externalId}`)) continue
      if (!isComplete(st.channel as ChannelT, st.channelAccountId, 'stale')) continue
      pendingOff.push({
        channelKey: `${st.channel}|${st.channelAccountId}`,
        staleImportId: st.id,
        staleWhere: { channel: st.channel, channelAccountId: st.channelAccountId, externalId: st.externalId, active: true, mappingSource: { not: 'MANUAL' } },
        ref: `${st.channel}|${st.channelAccountId}|${st.externalId}`,
      })
    }

    // Bezpiecznik: więcej niż MASS_OFF_SHARE aktywnych ofert kanału (i ponad MASS_OFF_MIN) do wyłączenia w jednym
    // przebiegu = odmowa dla tego kanału, ImportIssue, przebieg PARTIAL. Rozstrzyga człowiek (uwaga 2b).
    const byChannel = new Map<string, PendingOff[]>()
    for (const po of pendingOff) byChannel.set(po.channelKey, [...(byChannel.get(po.channelKey) ?? []), po])
    for (const [ck, list] of byChannel) {
      const [channel, channelAccountId] = ck.split('|') as [ChannelT, string]
      const activeCount = await db.channelOffer.count({ where: { channel, channelAccountId, active: true } })
      const toDeactivate = await countDeactivations(db, list)
      // Obejście dla człowieka (drobna 3): ChannelConfig.allowMassOffUntil w przyszłości = świadoma
      // zgoda na masowe wyłączenie (sklep naprawdę zdjął dużo ofert); po terminie bezpiecznik wraca sam.
      const cfg = await db.channelConfig.findFirst({ where: { channel, channelAccountId }, select: { allowMassOffUntil: true } })
      const allowed = !!cfg?.allowMassOffUntil && cfg.allowMassOffUntil.getTime() > now.getTime()
      if (allowed && toDeactivate > MASS_OFF_MIN && toDeactivate > activeCount * MASS_OFF_SHARE) stats.channelOffersMassOffAllowed += toDeactivate
      if (!allowed && toDeactivate > MASS_OFF_MIN && toDeactivate > activeCount * MASS_OFF_SHARE) {
        await issue('oferta-nieaktualna', ck, `odmowa masowej deaktywacji: ${toDeactivate} z ${activeCount} aktywnych ofert kanału — lista ofert prawdopodobnie ucięta; nic nie wyłączono`)
        stats.channelOffersMassOffRefused += toDeactivate
        continue
      }
      for (const po of list) {
        try {
          if (po.offerId) {
            await db.channelOffer.update({ where: { id: po.offerId }, data: po.data! })
            stats.channelOffersDeactivated++
          } else {
            const r = await db.channelOffer.updateMany({ where: po.staleWhere!, data: { active: false, deactivatedByImportAt: now } })
            stats.channelOffersDeactivated += r.count
            await db.channelOfferImport.delete({ where: { id: po.staleImportId! } })
            stats.staleRemoved++
          }
        } catch (e) {
          await issue(po.offerId ? 'oferta' : 'oferta-nieaktualna', po.ref, e)
        }
      }
    }
  } catch (e) {
    await db.importRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), error: errMsg(e), stats: stats as unknown as Prisma.InputJsonValue },
    })
    throw e
  }

  // Po zapisie ofert: zaległe zamówienia „niezmapowana oferta” z aktywną już ofertą. Błąd jednego zamówienia
  // = ImportIssue, reszta leci dalej; błąd samego zapytania nie cofa zapisanego katalogu, tylko trafia do ImportIssue.
  try {
    const r = await przeliczZalegle(db, { now, onError: (orderId, e) => issue('zamowienie-przeliczenie', orderId, e) })
    stats.ordersRemapped = r.remapped
    stats.ordersRemapFailed = r.failed
  } catch (e) {
    await issue('zamowienia-przeliczenie', 'wszystkie', e)
  }

  stats.issues = issues
  stats.status = issues ? 'PARTIAL' : 'OK'
  await db.importRun.update({
    where: { id: run.id },
    data: { status: stats.status, finishedAt: new Date(), stats: stats as unknown as Prisma.InputJsonValue },
  })
  return stats
}
