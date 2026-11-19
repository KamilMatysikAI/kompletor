// Zapis jednego produktu z planu importu: produkt po kluczach naturalnych i wiersz startowy
// stanu. Wspólne dla importu katalogu (lib/import/zapis.ts) i „Dodaj produkt” w panelu (lib/produkty) —
// osobny moduł bez zależności od lib/import/katalog.ts, żeby panel nie wciągał do serwera Next czytania plików nadpisań.
import type { Prisma, PrismaClient } from '@prisma/client'
import type { PlannedProduct } from './mapowanie'

export const MAIN_WAREHOUSE_ID = 'glowny'

export const dec = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? null : n.toFixed(digits))

/** Produkt z planu: po `wfirmaGoodId`, a bez towaru wFirmy po rekordzie BL i SKU. Też „Dodaj produkt”. */
export async function upsertProduct(
  db: PrismaClient,
  organizationId: string,
  p: PlannedProduct,
  fetchedAt: string,
): Promise<{ id: string; unit: 'SZT' | 'KG'; unitConflict?: { from: string; to: string } }> {
  const wf = p.wf
  const select = { id: true, title: true, ean: true, unit: true, sku: true, kind: true, nameAccounting: true } as const
  let existing = wf ? await db.product.findUnique({ where: { organizationId_wfirmaGoodId: { organizationId, wfirmaGoodId: wf.id } }, select }) : null
  if (!wf) {
    // Zestaw: najpierw po rekordzie BL (SKU zestawu w BL może się zmienić), dopiero potem po SKU (przegląd r2, uwaga 8).
    const viaBl = p.blIds[0] ? await db.blProduct.findUnique({ where: { organizationId_id: { organizationId, id: p.blIds[0] } }, select: { productId: true } }) : null
    if (viaBl?.productId) existing = await db.product.findUnique({ where: { id: viaBl.productId }, select })
    if (existing && existing.kind !== p.kind) existing = null
    existing ??= await db.product.findUnique({ where: { organizationId_sku: { organizationId, sku: p.sku } }, select })
    // Zmiana rodzaju (np. produkt ze stanem → bez stanu) to decyzja człowieka, nie importu: ImportIssue.
    if (existing && p.kind === 'DIGITAL' && existing.kind !== 'DIGITAL')
      throw new Error(`produkt o SKU „${p.sku}” istnieje jako ${existing.kind} — reguła bez stanu nie zmienia rodzaju produktu`)
  }
  const unitConflict = wf && existing && existing.unit !== wf.unit ? { from: existing.unit, to: wf.unit } : undefined
  const fromWfirma = wf
    ? {
        wfirmaType: wf.type,
        nameAccounting: wf.name,
        priceNet: dec(wf.priceNetRetail),
        priceGross: dec(wf.priceGrossRetail),
        vatRate: wf.vatRate,
        purchasePriceNet: dec(wf.purchasePriceNet, 4),
        ...(unitConflict ? {} : { unit: wf.unit }),
        wfirmaSyncedAt: new Date(fetchedAt),
        dataSource: 'WFIRMA' as const,
      }
    : { nameAccounting: p.title, unit: p.unit }
  if (existing) {
    // Bez towaru wFirmy nazwa księgowa (z niej faktura) jak tytuł: uzupełniana tylko, gdy pusta — nazwa wpisana
    // w „Dodaj produkt” nie jest nadpisywana nazwą oferty sklepu.
    if (!wf && existing.nameAccounting) delete (fromWfirma as { nameAccounting?: string | null }).nameAccounting
    // Pola z wFirmy odświeżamy; własne (tytuł, EAN) uzupełniamy tylko, gdy puste — edycja w panelu wygrywa.
    await db.product.update({
      where: { id: existing.id },
      data: {
        ...fromWfirma,
        ...(!wf && existing.sku !== p.sku ? { sku: p.sku } : {}),
        groupId: p.groupId,
        ...(existing.ean ? {} : { ean: p.ean }),
        ...(existing.title ? {} : { title: p.title }),
      },
    })
    return { id: existing.id, unit: unitConflict ? (existing.unit as 'SZT' | 'KG') : p.unit, unitConflict }
  }
  const created = await db.product.create({
    data: {
      sku: p.sku,
      kind: p.kind,
      groupId: p.groupId,
      wfirmaGoodId: wf?.id ?? null,
      title: p.title,
      ean: p.ean,
      ...fromWfirma,
      unit: p.unit,
      // towar wFirmy = WFIRMA; bez towaru: z planu (np. RECZNE z „Dodaj produkt”), domyślnie BL
      dataSource: wf ? 'WFIRMA' : (p.dataSource ?? 'BL'),
    },
    select: { id: true },
  })
  return { id: created.id, unit: p.unit }
}

/**
 * Wiersz `Stock` ze stanem startowym z wFirmy i ruch INITIAL_IMPORT, gdy produkt nie ma jeszcze stanu. Też „Dodaj
 * produkt” z własnym powodem ruchu.
 */
export async function createInitialStock(
  db: PrismaClient,
  productId: string,
  p: PlannedProduct,
  actor: string,
  readAt: Date,
  reason = p.wf ? 'stan startowy z wFirmy (import katalogu)' : 'stan startowy z magazynu BL (przeprowadzka)',
): Promise<boolean> {
  // produkt z BL (firma bez wFirmy) ma stan startowy z magazynu BL
  const count = p.wf ? p.wf.countBase : p.startStock
  if (count === undefined) return false
  const exists = await db.stock.findUnique({
    where: { productId_warehouseId: { productId, warehouseId: MAIN_WAREHOUSE_ID } },
    select: { productId: true },
  })
  if (exists) return false
  await db.$transaction(stockRows(db, productId, count, p.location, actor, readAt, reason))
  return true
}

function stockRows(db: Prisma.TransactionClient | PrismaClient, productId: string, count: number, location: string | null, actor: string, readAt: Date, reason: string) {
  return [
    db.stock.create({
      data: { productId, warehouseId: MAIN_WAREHOUSE_ID, wfirmaCount: count, wfirmaReadAt: readAt, physical: count, location },
    }),
    db.stockMovement.create({
      data: {
        productId,
        warehouseId: MAIN_WAREHOUSE_ID,
        deltaPhysical: count,
        source: 'INITIAL_IMPORT',
        reason,
        actorId: actor,
      },
    }),
  ]
}

/**
 * To samo co `createInitialStock`, ale w transakcji wołającego („Dodaj produkt” zapisuje
 * produkt, stan i audyt razem — bez produktu STOCKED bez wiersza Stock po przerwanym zapisie).
 */
export async function createInitialStockTx(
  tx: Prisma.TransactionClient,
  productId: string,
  p: PlannedProduct,
  actor: string,
  readAt: Date,
  reason: string,
): Promise<boolean> {
  if (!p.wf) return false
  const exists = await tx.stock.findUnique({ where: { productId_warehouseId: { productId, warehouseId: MAIN_WAREHOUSE_ID } }, select: { productId: true } })
  if (exists) return false
  for (const q of stockRows(tx, productId, p.wf.countBase, p.location, actor, readAt, reason)) await q
  return true
}
