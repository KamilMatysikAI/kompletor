// „Dodaj produkt” + SKU. Produkt zakłada się raz: nowy towar dodaje się w magazynie wFirmy, a tu wystarczy
// SKU — nazwa, cena, cena zakupu, VAT, EAN i stan przychodzą z kopii towaru wFirmy (`WfirmaGood`: z importu katalogu
// albo z odczytu jednego towaru w workerze, lib/produkty/wfirma-towar.ts). Akcja serwera nigdy nie woła wFirmy.
//
// Zapis wspólny z importem (`upsertProduct`, `createInitialStock` z lib/import/zapis.ts): kolejny import znajduje
// produkt po `wfirmaGoodId` i nie dubluje ani produktu, ani stanu, ani ruchu startowego.
// Rodzaj wyłącznie z typu towaru wFirmy (good/set = ze stanem, service = bez stanu) albo z wyboru człowieka „bez
// stanu”, gdy w wFirmie nie ma towaru — nigdy z nazwy (spec). Produkt bez stanu: bez `Stock`, SKU dopisane do
// `settings.catalog.noStock`, żeby oferta z tym SKU łączyła się z nim przy imporcie.
import type { PrismaClient, WfirmaGood } from '@prisma/client'
import { organizationIdOf } from '../db'
import { NO_STOCK_NOTE } from '../import/bez-stanu'
import type { PlannedProduct } from '../import/mapowanie'
import { normalizeEan, num, toBase, unitFromWfirma, type WfGood } from '../import/normalizacja'
import { createInitialStockTx, MAIN_WAREHOUSE_ID, upsertProduct } from '../import/zapis-produktu'
import { changeNoStockTx } from './bez-stanu'
import { checkEan, checkSku, checkTitle } from './walidacja'
import { LIMIT_PAUSE_MS } from '../rdzen/kolejka-wfirmy'
import { LIMIT_MESSAGE, NOT_FOUND_MESSAGE, requestWfirmaGood, WFIRMA_GOOD_JOB, WFIRMA_GOOD_RUN, wfirmaPausedUntil, type LookupResult } from './wfirma-towar'

export const INITIAL_REASON = 'stan startowy, produkt dodany w panelu'
export const NO_SERVICE_NOTE = 'brak usługi w wFirmie o tym kodzie — faktura z nazwy i ceny pozycji'

/** Kopia towaru wFirmy (wiersz `WfirmaGood`) → rekord jak z API (`wfGoodFromApi`), do `PlannedProduct.wf`. */
export function wfGoodFromRow(r: WfirmaGood): WfGood {
  const unit = unitFromWfirma(r.unit)
  const count = r.count === null ? null : num(r.count.toString())
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    unit,
    unitRaw: r.unit,
    vatCodeId: r.vatCodeId,
    vatRate: r.vatRate,
    priceNetRetail: r.priceNetRetail === null ? null : num(r.priceNetRetail.toString()),
    priceGrossRetail: r.priceGrossRetail === null ? null : num(r.priceGrossRetail.toString()),
    purchasePriceNet: r.purchasePriceNet === null ? null : num(r.purchasePriceNet.toString()),
    count,
    countBase: toBase(count, unit),
    warehouseId: r.warehouseId,
    ean: r.ean,
    visibility: r.visibility,
    modified: r.modified,
  }
}

/** Rodzaj produktu z typu towaru wFirmy: usługa = bez stanu, towar i komplet = ze stanem. */
export const kindOfWfirmaType = (type: string): 'STOCKED' | 'DIGITAL' => (type === 'service' ? 'DIGITAL' : 'STOCKED')

export interface WfirmaCopy {
  good: WfGood
  readAt: Date
}

export type SkuState =
  | { stan: 'istnieje'; productId: string; title: string; kind: string }
  | { stan: 'kopia'; copy: WfirmaCopy; kind: 'STOCKED' | 'DIGITAL' }
  | { stan: 'kilka'; towary: { id: string; nazwa: string; typ: string }[] }
  | { stan: 'sprawdzam'; zawieszone?: true }
  | { stan: 'brak'; komunikat: string }
  | { stan: 'odmowa'; komunikat: string }
  | { stan: 'niesprawdzone' }

/** Produkt firmy o tym SKU albo powiązany z towarem wFirmy o tym kodzie. */
async function existingProduct(db: PrismaClient, sku: string, goodIds: string[]) {
  return db.product.findFirst({
    where: { OR: [{ sku }, ...(goodIds.length ? [{ wfirmaGoodId: { in: goodIds } }] : [])] },
    select: { id: true, title: true, kind: true },
    orderBy: { createdAt: 'asc' },
  })
}

async function copiesOf(db: PrismaClient, sku: string): Promise<WfirmaGood[]> {
  return db.wfirmaGood.findMany({ where: { code: sku }, orderBy: { id: 'asc' } })
}

/**
 * Co wiadomo o SKU: produkt już jest, kopia towaru wFirmy (jedna albo kilka), odczyt w toku albo jego werdykt.
 * Tylko odczyt bazy — bez wFirmy.
 */
/** Po tylu ms oczekiwania na worker ekran „Sprawdzam w wFirmie…” przestaje się odświeżać. */
export const CHECK_STALE_MS = 60_000

export async function skuState(db: PrismaClient, sku: string, now = new Date()): Promise<SkuState> {
  const copies = await copiesOf(db, sku)
  const existing = await existingProduct(db, sku, copies.map((c) => c.id))
  if (existing) return { stan: 'istnieje', productId: existing.id, title: existing.title, kind: existing.kind }
  if (copies.length > 1) return { stan: 'kilka', towary: copies.map((c) => ({ id: c.id, nazwa: c.name, typ: c.type })) }
  if (copies.length === 1) {
    const good = wfGoodFromRow(copies[0]!)
    return { stan: 'kopia', copy: { good, readAt: copies[0]!.importedAt }, kind: kindOfWfirmaType(good.type) }
  }
  const job = await db.job.findFirst({ where: { kind: WFIRMA_GOOD_JOB, payload: { path: ['sku'], equals: sku } }, orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true } })
  if (job && (job.status === 'PENDING' || job.status === 'RUNNING'))
    // worker nie odebrał zadania w minutę → ekran przestaje się odświeżać i mówi to wprost
    return now.getTime() - job.createdAt.getTime() > CHECK_STALE_MS ? { stan: 'sprawdzam', zawieszone: true } : { stan: 'sprawdzam' }
  const run = await db.importRun.findFirst({
    where: { kind: WFIRMA_GOOD_RUN, stats: { path: ['sku'], equals: sku }, ...(job ? { startedAt: { gte: new Date(job.createdAt.getTime() - 1000) } } : {}) },
    orderBy: { startedAt: 'desc' },
    select: { stats: true },
  })
  const res = run?.stats as LookupResult | null | undefined
  if (!res) return { stan: 'niesprawdzone' }
  switch (res.wynik) {
    case 'brak':
      return { stan: 'brak', komunikat: NOT_FOUND_MESSAGE + (res.innyMagazyn?.length ? ` (towar o tym kodzie jest w innym magazynie wFirmy niż magazyn firmy: id ${res.innyMagazyn.join(', ')})` : '') }
    case 'kilka':
      return { stan: 'kilka', towary: res.towary }
    case 'limit':
      return { stan: 'odmowa', komunikat: LIMIT_MESSAGE }
    case 'blad':
      return { stan: 'odmowa', komunikat: res.komunikat }
    default:
      // znaleziono, a kopii nie ma (np. kod towaru zmieniony w międzyczasie): do ponownego sprawdzenia
      return { stan: 'niesprawdzone' }
  }
}

/** Po odmowie wFirmy kolejny odczyt najwcześniej po tylu ms (stała wspólna z kolejką wFirmy). */
export { LIMIT_PAUSE_MS }

/**
 * „Sprawdź” na ekranie: zleca odczyt towaru w workerze, gdy SKU nie ma produktu ani kopii towaru wFirmy.
 * `pauza` = wFirma niedawno odmówiła (limit), odczyt nie został zlecony.
 */
export async function requestCheck(db: PrismaClient, sku: string, now = new Date()): Promise<'gotowe' | 'zlecone' | 'pauza'> {
  const state = await skuState(db, sku)
  if (state.stan === 'istnieje' || state.stan === 'kopia' || state.stan === 'kilka' || state.stan === 'sprawdzam') return 'gotowe'
  const limited = await db.importRun.findFirst({
    where: { kind: WFIRMA_GOOD_RUN, startedAt: { gte: new Date(now.getTime() - LIMIT_PAUSE_MS) }, stats: { path: ['wynik'], equals: 'limit' } },
    select: { id: true },
  })
  if (limited) return 'pauza'
  // pauza kolejki wFirmy (lustro stanów, faktury BL): ten sam klucz, nie zlecamy odczytu
  if (await wfirmaPausedUntil(db, now)) return 'pauza'
  await requestWfirmaGood(db, sku)
  return 'zlecone'
}

export function manyMessage(towary: { id: string; nazwa: string }[]): string {
  return `W wFirmie jest kilka towarów o tym kodzie (${towary.map((t) => `id ${t.id}: ${t.nazwa}`).join('; ')}). Popraw kody w wFirmie, żeby SKU było jednoznaczne.`
}

export interface AddInput {
  sku: unknown
  /** `wfirma` = towar albo usługa z kopii wFirmy; `bez-stanu` = e-book albo usługa (z usługą w wFirmie albo bez). */
  rodzaj: unknown
  /** Nazwa: wymagana dla bez stanu bez usługi w wFirmie, poza tym domyślnie nazwa z wFirmy. */
  title?: unknown
  ean?: unknown
}

export type AddResult =
  | { ok: true; productId: string; created: boolean; kind: 'STOCKED' | 'DIGITAL'; warnings: string[] }
  | { ok: false; error: string; field?: 'sku' | 'title' | 'ean' }

/**
 * Zakłada produkt z SKU. Produkt już istniejący (po SKU albo towarze wFirmy) — także po wyścigu dwóch kliknięć —
 * to wynik `created: false` z jego id (ekran prowadzi do karty), nie błąd. `userId` → `actorId` ruchu i audytu.
 */
export async function addProduct(db: PrismaClient, input: AddInput, userId: string): Promise<AddResult> {
  const sku = checkSku(input.sku)
  if (!sku.ok) return { ok: false, error: sku.error, field: 'sku' }
  const ean = checkEan(input.ean)
  if (!ean.ok) return { ok: false, error: ean.error, field: 'ean' }
  const rodzaj = input.rodzaj === 'bez-stanu' ? 'bez-stanu' : input.rodzaj === 'wfirma' ? 'wfirma' : null
  if (!rodzaj) return { ok: false, error: 'Wybierz rodzaj produktu.' }
  const titleRaw = typeof input.title === 'string' ? input.title.trim() : ''
  const title = titleRaw ? checkTitle(titleRaw) : null
  if (title && !title.ok) return { ok: false, error: title.error, field: 'title' }

  const copies = await copiesOf(db, sku.value)
  const existing = await existingProduct(db, sku.value, copies.map((c) => c.id))
  if (existing) return { ok: true, productId: existing.id, created: false, kind: existing.kind === 'DIGITAL' ? 'DIGITAL' : 'STOCKED', warnings: [] }
  if (copies.length > 1) return { ok: false, error: manyMessage(copies.map((c) => ({ id: c.id, nazwa: c.name }))), field: 'sku' }
  const wf = copies[0] ? wfGoodFromRow(copies[0]) : null
  const readAt = copies[0]?.importedAt ?? new Date()

  let kind: 'STOCKED' | 'DIGITAL'
  const notes: string[] = []
  if (rodzaj === 'wfirma') {
    if (!wf) {
      // werdykt „kilka towarów” z odczytu (bez kopii) to nie „brak SKU”
      const st = await skuState(db, sku.value)
      if (st.stan === 'kilka') return { ok: false, error: manyMessage(st.towary), field: 'sku' }
      return { ok: false, error: `${NOT_FOUND_MESSAGE} Najpierw sprawdź SKU w wFirmie albo dodaj produkt bez stanu.`, field: 'sku' }
    }
    kind = kindOfWfirmaType(wf.type)
  } else {
    // bez stanu: towar ze stanem w wFirmie to konflikt rodzaju (zdjęcie stanu przy fakturze), rozstrzyga człowiek
    if (wf && wf.type !== 'service')
      return {
        ok: false,
        error: `SKU „${sku.value}” jest w wFirmie towarem ze stanem (${wf.type === 'set' ? 'komplet' : 'towar'}) — dodaj go jako towar z magazynu albo zmień kod w wFirmie.`,
        field: 'sku',
      }
    kind = 'DIGITAL'
    if (!wf) {
      if (!title) return { ok: false, error: 'Produkt bez usługi w wFirmie potrzebuje nazwy (z niej faktura).', field: 'title' }
      notes.push(NO_SERVICE_NOTE)
    }
    notes.push(NO_STOCK_NOTE)
  }
  if (kind === 'STOCKED' && !(await db.warehouse.findFirst({ where: { id: MAIN_WAREHOUSE_ID }, select: { id: true } })))
    return { ok: false, error: `Brak magazynu „${MAIN_WAREHOUSE_ID}” w konfiguracji firmy — produkt ze stanem nie ma gdzie trzymać stanu.` }

  const p: PlannedProduct = {
    key: wf ? `wf:${wf.id}` : `digital:${sku.value}`,
    sku: wf?.code ?? sku.value,
    kind,
    unit: wf?.unit ?? 'SZT',
    groupId: null,
    wf,
    title: title?.ok ? title.value : (wf?.name ?? sku.value),
    ean: ean.value ?? normalizeEan(wf?.ean).ean,
    blIds: [],
    components: [],
    notes,
    location: null,
    ...(wf ? {} : { dataSource: 'RECZNE' as const }),
  }
  const actor = `user:${userId}`
  const organizationId = organizationIdOf(db)
  const audit = (productId: string) => ({ entity: 'Product', entityId: productId, actorId: userId, after: { dodanyWPanelu: true, sku: p.sku, kind, wfirmaGoodId: wf?.id ?? null } })
  let productId: string
  try {
    if (kind === 'DIGITAL') {
      // bez stanu: produkt, SKU na liście noStock i audyt razem (lista z blokadą wiersza firmy); nigdy Stock —
      // createInitialStock założyłby go przy usłudze wFirmy. Klient transakcji ma te same modele co klient firmy.
      productId = await db.$transaction(async (tx) => {
        const id = (await upsertProduct(tx as unknown as PrismaClient, organizationId, p, readAt.toISOString())).id
        await changeNoStockTx(tx, organizationId, (cur) => (cur.skus.includes(p.sku) ? cur : { ...cur, skus: [...cur.skus, p.sku] }), { actorId: userId, edited: false })
        await tx.auditLog.create({ data: audit(id) })
        return id
      })
    } else {
      // produkt, stan startowy i audyt w jednej transakcji
      productId = await db.$transaction(async (tx) => {
        const id = (await upsertProduct(tx as unknown as PrismaClient, organizationId, p, readAt.toISOString())).id
        await createInitialStockTx(tx, id, p, actor, readAt, INITIAL_REASON)
        await tx.auditLog.create({ data: audit(id) })
        return id
      })
    }
  } catch (e) {
    // wyścig dwóch kliknięć (albo import w tej samej chwili): unikalność SKU / towaru wFirmy → istniejący produkt
    if ((e as { code?: string }).code !== 'P2002') throw e
    const again = await existingProduct(db, sku.value, wf ? [wf.id] : [])
    if (!again) throw e
    return { ok: true, productId: again.id, created: false, kind: again.kind === 'DIGITAL' ? 'DIGITAL' : 'STOCKED', warnings: [] }
  }
  return { ok: true, productId, created: true, kind, warnings: notes.filter((n) => n !== NO_STOCK_NOTE) }
}
