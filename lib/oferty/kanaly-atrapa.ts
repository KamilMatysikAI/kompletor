// Atrapy Empiku (Mirakl), sklepu Woo i zapisu ofert dla testów ofertowania (Etap 2). Odpowiedzi w kształcie
// API (Mirakl P31 `/products`, H11 `/hierarchies`, WC REST `/products/categories`, `/products?sku=`), dane fikcyjne:
// EAN-y testowe, nazwy wymyślone, adresy w domenie `.test`. Bez sieci.
import type { MiraklGet } from '@/lib/zrodla/mirakl'
import type { WooGet, WooResponse } from '@/lib/zrodla/woo'
import type { OdpowiedzZapisu, WyslijZapis } from './wystawianie'

export const EAN_W_PIM = '5901234560301'
export const EAN_POZA_PIM = '5901234560318'
export const KOD_PRZYPRAWA_CZARNA = '13-34-8-2'

export const PIM_PO_EAN: Record<string, unknown> = {
  [EAN_W_PIM]: {
    products: [
      {
        product_sku: 'PIM-777001',
        product_title: 'Przyprawa czarna Testowa Assam 100 g',
        category_code: KOD_PRZYPRAWA_CZARNA,
        category_label: 'Przyprawa czarna',
        product_references: [{ reference_type: 'EAN', reference: EAN_W_PIM }],
      },
    ],
    total_count: 1,
  },
}

/** Mirakl GET: `bladDla` = ścieżki, na których atrapa rzuca (jak `MiraklReadOnly` przy HTTP ≥ 400). */
export function atrapaMirakl(bladDla: string[] = []): { get: MiraklGet; wywolania: string[] } {
  const wywolania: string[] = []
  const get = (async (path: string, query: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
    wywolania.push(qs ? `${path}?${qs}` : path)
    if (bladDla.includes(path)) throw new Error(`Mirakl ${path}: HTTP 403`)
    if (path === '/products') {
      const ean = String(query['product_references'] ?? '').replace(/^EAN\|/, '')
      return PIM_PO_EAN[ean] ?? { products: [], total_count: 0 }
    }
    if (path === '/hierarchies')
      return {
        hierarchies: [
          { code: '13-34-8', label: 'Przyprawa', level: 3, parent_code: '13-34' },
          { code: KOD_PRZYPRAWA_CZARNA, label: 'Przyprawa czarna', level: 4, parent_code: '13-34-8' },
          { label: 'bez kodu' },
        ],
      }
    throw new Error(`Mirakl ${path}: HTTP 404`)
  }) as MiraklGet
  return { get, wywolania }
}

export const KATEGORIE_SKLEPU = [
  { id: 15, name: 'Przyprawa czarna', slug: 'przyprawa-czarna', parent: 0 },
  { id: 16, name: 'Kubki i filiżanki', slug: 'kubki', parent: 20 },
  { id: 20, name: 'Akcesoria', slug: 'akcesoria', parent: 0 },
]

/** WC REST GET: kategorie na 2 stronach (po 2), produkty po SKU z `skuWSklepie`. */
export function atrapaWoo(o: { skuWSklepie?: Record<string, number>; blad?: boolean } = {}): { get: WooGet; wywolania: string[] } {
  const wywolania: string[] = []
  const get = (async <T,>(path: string, query: Record<string, string | number | boolean> = {}): Promise<WooResponse<T>> => {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
    wywolania.push(qs ? `${path}?${qs}` : path)
    if (o.blad) throw new Error(`Woo ${path}: HTTP 503`)
    if (path === '/products/categories') {
      const page = Number(query['page'] ?? 1)
      return { status: 200, body: KATEGORIE_SKLEPU.slice((page - 1) * 2, page * 2) as T, totalPages: 2, total: KATEGORIE_SKLEPU.length }
    }
    if (path === '/products') {
      const sku = String(query['sku'] ?? '')
      const id = o.skuWSklepie?.[sku]
      // WC szuka też po fragmencie w niektórych wtyczkach — atrapa zwraca podobny SKU, który trzeba odrzucić
      const body = [...(id ? [{ id, sku, status: 'publish' }] : []), { id: 999, sku: `${sku}-X`, status: 'draft' }]
      return { status: 200, body: body as T, totalPages: 1, total: body.length }
    }
    return { status: 404, body: null, totalPages: null, total: null }
  }) as WooGet
  return { get, wywolania }
}

/** Zapis: zapamiętuje żądania; `odpowiedz` = stała odpowiedź albo `'siec'` (brak odpowiedzi). */
export function atrapaZapisu(odpowiedz: OdpowiedzZapisu | 'siec' = { status: 201, body: { id: '7700000001' } }): { wyslij: WyslijZapis; zadania: { metoda: string; sciezka: string; cialo: unknown; query?: Record<string, string> }[] } {
  const zadania: { metoda: string; sciezka: string; cialo: unknown; query?: Record<string, string> }[] = []
  const wyslij: WyslijZapis = async (metoda, sciezka, cialo, query) => {
    zadania.push({ metoda, sciezka, cialo, ...(query ? { query } : {}) })
    if (odpowiedz === 'siec') throw new Error('timeout')
    return odpowiedz
  }
  return { wyslij, zadania }
}
