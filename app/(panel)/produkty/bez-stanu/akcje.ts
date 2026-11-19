'use server'
// Produkty i stany → Produkty bez stanu: zapis listy `noStock` (SKU i kategorie sklepu). Tylko
// z uprawnieniem `produkty.dodawanie`; zapis wyłącznie przez saveNoStock (surowy JSON ustawień, AuditLog).
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { NoStockConflict, saveNoStock } from '@/lib/produkty/bez-stanu'
import { checkNoStock } from '@/lib/produkty/walidacja'
import type { StanListy } from './stan'

export async function zapiszListe(_prev: StanListy, form: FormData): Promise<StanListy> {
  const ctx = await requirePermission('produkty.dodawanie')
  const skus = String(form.get('skus') ?? '')
  const shopCategories = String(form.get('kategorie') ?? '')
  const parsed = checkNoStock(skus, shopCategories)
  if (!parsed.ok) return { skus, shopCategories, error: parsed.error, savedAt: null }
  try {
    const saved = await saveNoStock(ctx.db, parsed.value, ctx.user.id)
    revalidatePath('/produkty/bez-stanu')
    return { skus: saved.skus.join('\n'), shopCategories: saved.shopCategories.join('\n'), error: null, savedAt: Date.now() }
  } catch (e) {
    if (e instanceof NoStockConflict) return { skus, shopCategories, error: e.message, savedAt: null }
    throw e
  }
}
