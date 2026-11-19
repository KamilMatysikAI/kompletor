// Zapis produktu i stanu startowego z danych kanału. Produkt z kanału: STOCKED, SZT, bez wFirmy, źródło
// danych KANAL (cena brutto i VAT z oferty, gdy kanał je podaje; wszystko edytowalne w karcie produktu).
// `stanStartowy` używa też „Dodaj produkt” w panelu (lib/produkty/karta.ts). Stan startowy nigdy nie nadpisuje Stock.
// Wspólne `upsertProduct` z lib/import/zapis-produktu.ts zostaje dla importu wFirmy/BL (szuka po towarze wFirmy i BL);
// tu produkt zawsze powstaje nowy po sprawdzeniu SKU przez wołającego, więc osobna, prosta funkcja.
import type { Prisma, PrismaClient } from '@prisma/client'
import { normalizeEan } from '../import/normalizacja'
import { DEFAULT_WAREHOUSE } from '../rdzen/stan'

type Tx = Prisma.TransactionClient | PrismaClient

export interface ProduktZKanalu {
  sku: string
  name: string
  ean: string | null
  priceGross?: number | null
  vatRate?: string | null
}

const VAT_OK = new Set(['23', '8', '5', '0', 'zw', 'np'])

/** Nowy produkt STOCKED w sztukach; tytuł i nazwa księgowa z nazwy oferty (pusta = SKU). */
export async function zalozProdukt(tx: Tx, p: ProduktZKanalu): Promise<{ id: string; unit: 'SZT' }> {
  const name = (p.name.trim() || p.sku).slice(0, 300)
  const vat = p.vatRate && VAT_OK.has(p.vatRate) ? p.vatRate : null
  const created = await tx.product.create({
    data: {
      sku: p.sku,
      kind: 'STOCKED',
      unit: 'SZT',
      dataSource: 'KANAL',
      title: name,
      nameAccounting: name,
      ean: normalizeEan(p.ean).ean,
      priceGross: p.priceGross ?? null,
      vatRate: vat,
      priceNet: p.priceGross == null ? null : vat && Number.isFinite(Number(vat)) ? Number((p.priceGross / (1 + Number(vat) / 100)).toFixed(2)) : vat ? p.priceGross : null,
    },
    select: { id: true },
  })
  return { id: created.id, unit: 'SZT' }
}

/**
 * Wiersz Stock z ilością startową i ruch INITIAL_IMPORT. Istniejący wiersz zostaje nietknięty (false). Firma bez wFirmy:
 * `wfirmaCount` = ilość startowa, żeby zachować niezmiennik physical = wfirmaCount + pendingDelta (lib/rdzen/niezmienniki.ts).
 */
export async function stanStartowy(tx: Tx, productId: string, qty: number, actorId: string, reason: string, now: Date, warehouseId = DEFAULT_WAREHOUSE): Promise<boolean> {
  const exists = await tx.stock.findUnique({ where: { productId_warehouseId: { productId, warehouseId } }, select: { productId: true } })
  if (exists) return false
  const count = Math.max(0, Math.trunc(qty))
  await tx.stock.create({ data: { productId, warehouseId, wfirmaCount: count, wfirmaReadAt: now, physical: count } })
  await tx.stockMovement.create({ data: { productId, warehouseId, deltaPhysical: count, source: 'INITIAL_IMPORT', reason, actorId } })
  return true
}
