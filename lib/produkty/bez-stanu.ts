// lista produktów bez stanu (`Organization.settings.catalog.noStock`) edytowana w panelu
// (Produkty i stany → Produkty bez stanu) i dopisywana przez „Dodaj produkt” rodzaju bez stanu (lib/produkty/dodawanie.ts).
//
// Zapis to odczyt i zmiana SUROWEGO JSON `settings` w jednej transakcji z blokadą wiersza firmy: `parseOrgSettings`
// zostawia tylko `baselinker`, więc zapis przez niego zgubiłby `catalog.nonOfferSkus`, `faktury` i resztę. Po zapisie
// z edytora `catalog.edytowanoWPanelu = true` — preset (applyOrgPreset → fillMissingCatalog) nie uzupełnia już listy,
// także pustej. Usunięcie SKU z listy nie kasuje produktu i nie zmienia jego rodzaju (decyzja człowieka).
// Klient firmy (RLS): firma z sesji, rola aplikacji ma UPDATE na `Organization.settings`.
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { parseCatalogRules } from '../import/bez-stanu'
import type { NoStockInput } from './walidacja'

type Tx = Prisma.TransactionClient
type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export interface NoStockView extends NoStockInput {
  /** Lista zapisana z panelu: preset jej nie uzupełnia (także pustej). */
  editedInPanel: boolean
}

export async function readNoStock(db: PrismaClient): Promise<NoStockView> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const catalog = isObj(org?.settings) ? org!.settings['catalog'] : undefined
  const r = parseCatalogRules(catalog)
  return { skus: r.noStockSkus, shopCategories: r.noStockShopCategories, editedInPanel: isObj(catalog) && catalog['edytowanoWPanelu'] === true }
}

export const DIGITAL_LIST_LIMIT = 200

/** Produkty bez stanu firmy (do podglądu obok listy). */
export async function digitalProducts(db: PrismaClient): Promise<{ id: string; sku: string; title: string }[]> {
  return db.product.findMany({ where: { kind: 'DIGITAL' }, select: { id: true, sku: true, title: true }, orderBy: { sku: 'asc' }, take: DIGITAL_LIST_LIMIT })
}

/** SKU z listy, które w katalogu są towarem ze stanem albo zestawem: reguła bez stanu ich nie obejmie (jak w imporcie). */
export async function noStockConflicts(db: PrismaClient | Tx, skus: string[]): Promise<{ sku: string; kind: 'STOCKED' | 'BUNDLE' }[]> {
  if (!skus.length) return []
  const rows = await db.product.findMany({ where: { sku: { in: skus }, kind: { in: ['STOCKED', 'BUNDLE'] } }, select: { sku: true, kind: true }, orderBy: { sku: 'asc' } })
  return rows.map((r) => ({ sku: r.sku, kind: r.kind as 'STOCKED' | 'BUNDLE' }))
}

export function conflictMessage(c: { sku: string; kind: 'STOCKED' | 'BUNDLE' }[]): string {
  const list = c.map((x) => `„${x.sku}” jest w katalogu ${x.kind === 'BUNDLE' ? 'zestawem' : 'produktem ze stanem'}`).join('; ')
  return `SKU ${list} — reguła bez stanu ${c.length === 1 ? 'go' : 'ich'} nie obejmie, a zmiana rodzaju produktu to osobna decyzja. Usuń z listy.`
}

export class NoStockConflict extends Error {
  constructor(readonly conflicts: { sku: string; kind: 'STOCKED' | 'BUNDLE' }[]) {
    super(conflictMessage(conflicts))
    this.name = 'NoStockConflict'
  }
}

/**
 * Zmiana `catalog.noStock` w transakcji `tx` z blokadą wiersza firmy (dwa zapisy naraz nie gubią się nawzajem).
 * `change` dostaje bieżącą listę i zwraca nową; `edited` = zapis z edytora (ustawia `edytowanoWPanelu`). Wpis
 * w AuditLog tylko przy zmianie. Zwraca listę po zapisie.
 */
export async function changeNoStockTx(
  tx: Tx,
  organizationId: string,
  change: (cur: NoStockInput) => NoStockInput,
  opts: { actorId: string; edited: boolean },
): Promise<NoStockInput> {
  const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
  if (!rows[0]) throw new Error('Brak firmy klienta (klient bez firmy?)')
  const settings: Json = isObj(rows[0].settings) ? rows[0].settings : {}
  const catalog: Json = isObj(settings['catalog']) ? settings['catalog'] : {}
  const noStock: Json = isObj(catalog['noStock']) ? catalog['noStock'] : {}
  const r = parseCatalogRules(catalog)
  const before: NoStockInput = { skus: r.noStockSkus, shopCategories: r.noStockShopCategories }
  const after = change(before)
  const same = before.skus.join('\n') === after.skus.join('\n') && before.shopCategories.join('\n') === after.shopCategories.join('\n')
  if (same && (!opts.edited || catalog['edytowanoWPanelu'] === true)) return before
  const nextCatalog: Json = { ...catalog, noStock: { ...noStock, skus: after.skus, shopCategories: after.shopCategories } }
  if (opts.edited) nextCatalog['edytowanoWPanelu'] = true
  await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, catalog: nextCatalog } as Prisma.InputJsonValue } })
  await tx.auditLog.create({
    data: {
      entity: 'Organization.catalog.noStock',
      entityId: organizationId,
      actorId: opts.actorId,
      before: before as unknown as Prisma.InputJsonValue,
      after: { ...after, ...(opts.edited ? { edytowanoWPanelu: true } : {}) } as unknown as Prisma.InputJsonValue,
    },
  })
  return after
}

/**
 * Zapis listy z edytora w panelu. SKU, które w katalogu jest towarem ze stanem albo zestawem → `NoStockConflict`
 * (nic nie zapisane). Wynik: lista po zapisie.
 */
export async function saveNoStock(db: PrismaClient, input: NoStockInput, actorId: string): Promise<NoStockInput> {
  const organizationId = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    const conflicts = await noStockConflicts(tx, input.skus)
    if (conflicts.length) throw new NoStockConflict(conflicts)
    return changeNoStockTx(tx, organizationId, () => input, { actorId, edited: true })
  })
}
