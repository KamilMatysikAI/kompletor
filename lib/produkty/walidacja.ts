// walidacja wejścia „Dodaj produkt” i listy produktów bez stanu. Czyste funkcje — testy w produkty.test.ts.
import { normalizeEan } from '../import/normalizacja'

export const SKU_MAX = 64
export const TITLE_MAX = 200
/** Najwięcej pozycji na jednej liście bez stanu (SKU albo kategorii) — zabezpieczenie przed wklejeniem całego katalogu. */
export const NO_STOCK_MAX = 500

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** SKU po `trim`: 1–64 znaki, bez znaków sterujących (tabulator, nowa linia). */
export function checkSku(v: unknown): Checked<string> {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return { ok: false, error: 'Podaj SKU (kod towaru z wFirmy).' }
  if (s.length > SKU_MAX) return { ok: false, error: `SKU może mieć najwyżej ${SKU_MAX} znaki.` }
  if (CONTROL.test(s)) return { ok: false, error: 'SKU zawiera niedozwolony znak (tabulator, nowa linia).' }
  return { ok: true, value: s }
}

/** Nazwa produktu po `trim`: 1–200 znaków, bez znaków sterujących. */
export function checkTitle(v: unknown): Checked<string> {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return { ok: false, error: 'Podaj nazwę produktu.' }
  if (s.length > TITLE_MAX) return { ok: false, error: `Nazwa może mieć najwyżej ${TITLE_MAX} znaków.` }
  if (CONTROL.test(s)) return { ok: false, error: 'Nazwa zawiera niedozwolony znak (tabulator, nowa linia).' }
  return { ok: true, value: s }
}

/** EAN opcjonalny: puste = null; wpisany musi mieć poprawną sumę kontrolną (GTIN-8/12/13/14). */
export function checkEan(v: unknown): Checked<string | null> {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return { ok: true, value: null }
  const n = normalizeEan(s)
  if (!n.valid) return { ok: false, error: `EAN „${s.slice(0, 40)}” jest niepoprawny (zła długość albo cyfra kontrolna).` }
  return { ok: true, value: n.ean }
}

/** Kategoria sklepu jak w `settings.catalog.noStock.shopCategories`: „<konto sklepu>:<id kategorii>”. */
const CATEGORY_RE = /^[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{1,40}$/

/** Pole tekstowe (po jednej pozycji w wierszu) → lista bez pustych i bez powtórzeń. */
export function linesOf(v: unknown): string[] {
  const s = typeof v === 'string' ? v : ''
  return [...new Set(s.split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean))]
}

export interface NoStockInput {
  skus: string[]
  shopCategories: string[]
}

/**
 * Lista produktów bez stanu z formularza. Jak `parseCatalogRules` (lib/import/bez-stanu.ts): przycięte, bez pustych
 * i powtórzeń; dodatkowo SKU jak w „Dodaj produkt”, a kategoria w postaci „<konto>:<id kategorii>”.
 */
export function checkNoStock(skusRaw: unknown, categoriesRaw: unknown): Checked<NoStockInput> {
  const skus = linesOf(skusRaw)
  const shopCategories = linesOf(categoriesRaw)
  if (skus.length > NO_STOCK_MAX || shopCategories.length > NO_STOCK_MAX) return { ok: false, error: `Najwyżej ${NO_STOCK_MAX} pozycji na liście.` }
  for (const s of skus) {
    const c = checkSku(s)
    if (!c.ok) return { ok: false, error: `„${s.slice(0, 70)}”: ${c.error}` }
  }
  const bad = shopCategories.find((c) => !CATEGORY_RE.test(c))
  if (bad) return { ok: false, error: `Kategoria „${bad.slice(0, 90)}” nie ma postaci „<konto sklepu>:<id kategorii>” (np. sklep1:117).` }
  return { ok: true, value: { skus, shopCategories } }
}
