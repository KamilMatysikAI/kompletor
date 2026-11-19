// WooCommerce REST v3 — klient TYLKO DO ODCZYTU (GET). Zapis w sklepie (po decyzji właściciela dla danego
// kanału) to osobny klient i osobne zadanie. Uwierzytelnienie Basic po HTTPS: klucz/sekret WC REST albo login
// i hasło aplikacji WordPressa. Bez logowania nagłówków, adresów z kluczami ani treści odpowiedzi.
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'

export interface WooResponse<T> {
  status: number
  body: T | null // null przy 404
  totalPages: number | null
  total: number | null
}

/** Adres sklepu → baza WC REST v3 (`https://sklep.pl` albo z `/wp-json`, `/wp-json/wc/v3`). */
export function wooApiBase(url: string): string {
  const u = url.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s]+/i.test(u)) throw new Error('Adres sklepu Woo musi zaczynać się od https://')
  const root = u.replace(/\/wp-json(\/wc\/v3)?$/i, '')
  return `${root}/wp-json/wc/v3`
}

const headerInt = (h: Headers, name: string): number | null => {
  const v = h.get(name)
  if (v === null || v.trim() === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

export class WooReadOnly {
  private readonly throttle: Throttle
  private readonly base: string
  private readonly auth: string

  constructor(
    url: string,
    user: string,
    password: string,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 250,
    private readonly retry: RetryOptions = { attempts: 3, baseDelayMs: 2_000 },
  ) {
    if (!user || !password) throw new Error('Brak klucza albo sekretu Woo')
    this.base = wooApiBase(url)
    this.auth = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
    this.throttle = new Throttle(minIntervalMs)
  }

  /** GET ścieżki względem /wp-json/wc/v3. 404 → body null; 401/403 i inne 4xx → błąd trwały; 429/5xx/sieć → przejściowy. */
  async get<T>(path: string, query: Record<string, string | number | boolean> = {}, init: { method?: string } = {}): Promise<WooResponse<T>> {
    if ((init.method ?? 'GET') !== 'GET') throw new ReadOnlyViolation('Woo: klient tylko do odczytu (GET)')
    if (!path.startsWith('/') || path.includes('..')) throw new Error('zła ścieżka Woo')
    return withRetry(
      async () => {
        await this.throttle.wait()
        const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))
        const res = await fetchWithTimeout(
          this.fetchImpl,
          `${this.base}${path}${qs.size ? `?${qs}` : ''}`,
          { method: 'GET', headers: { Authorization: this.auth, Accept: 'application/json' } },
          60_000,
        )
        if (res.status === 404) return { status: 404, body: null, totalPages: null, total: null }
        if (res.status === 429 || res.status >= 500) throw new SourceError(`Woo ${path}: HTTP ${res.status}`, true)
        if (res.status === 401 || res.status === 403) throw new SourceError(`Woo ${path}: HTTP ${res.status} (klucz odrzucony albo bez prawa odczytu)`, false)
        if (!res.ok) throw new SourceError(`Woo ${path}: HTTP ${res.status}`, false)
        let body: T
        try {
          body = (await res.json()) as T
        } catch {
          // HTML zamiast JSON (antybot, przerwa techniczna, cache) — chwilowe, nie dane
          throw new SourceError(`Woo ${path}: odpowiedź nie jest JSON`, true)
        }
        return { status: res.status, body, totalPages: headerInt(res.headers, 'x-wp-totalpages'), total: headerInt(res.headers, 'x-wp-total') }
      },
      this.retry,
    )
  }
}

// ─── Odczyty do ofertowania: kategorie sklepu i produkt po SKU, tylko GET ──────────────────────────────

/** Odczyt GET względem /wp-json/wc/v3 (np. `WooReadOnly.get`). */
/** jedyne ścieżki odczytu do ofertowania (kategorie sklepu, produkt po SKU). */
export const ODCZYT_OFERT_WOO_RE = /^\/products(\/categories)?$/

export type WooGet = <T>(path: string, query?: Record<string, string | number | boolean>) => Promise<WooResponse<T>>

export interface WooKategoria {
  id: number
  nazwa: string
  slug: string
  rodzicId: number | null
}

const wrec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export function wooKategoriaZApi(raw: unknown): WooKategoria | null {
  const r = wrec(raw)
  const id = typeof r['id'] === 'number' && Number.isInteger(r['id']) && (r['id'] as number) > 0 ? (r['id'] as number) : null
  if (id === null) return null
  const rodzic = typeof r['parent'] === 'number' && (r['parent'] as number) > 0 ? (r['parent'] as number) : null
  return { id, nazwa: typeof r['name'] === 'string' ? r['name'] : '', slug: typeof r['slug'] === 'string' ? r['slug'] : '', rodzicId: rodzic }
}

/** Wszystkie kategorie produktów sklepu (po 100 na stronę, najwyżej `maxStron` stron). */
export async function wooKategorie(get: WooGet, maxStron = 20): Promise<WooKategoria[]> {
  const out: WooKategoria[] = []
  for (let page = 1; page <= maxStron; page++) {
    const r = await get<unknown[]>('/products/categories', { per_page: 100, page, orderby: 'id', order: 'asc' })
    const lista = Array.isArray(r.body) ? r.body : []
    out.push(...lista.map(wooKategoriaZApi).filter((k): k is WooKategoria => k !== null))
    const strony = r.totalPages ?? 1
    if (!lista.length || page >= strony) break
  }
  return out
}

/**
 * Pierwszy produkt sklepu z tym SKU (dokładne porównanie) albo null. `liczba` = ile produktów ma dokładnie to SKU
 * (przy liczbie > 1 wołający nie wiąże z pierwszym, tylko prosi o powiązanie ręczne).
 */
export async function wooProduktPoSku(get: WooGet, sku: string): Promise<{ id: number; status: string; liczba: number } | null> {
  if (!sku.trim()) return null
  const r = await get<unknown[]>('/products', { sku: sku.trim(), per_page: 10, _fields: 'id,sku,status' })
  const trafienia = (Array.isArray(r.body) ? r.body : []).map(wrec).filter((p) => typeof p['id'] === 'number' && String(p['sku'] ?? '').trim() === sku.trim())
  if (!trafienia.length) return null
  return { id: trafienia[0]!['id'] as number, status: String(trafienia[0]!['status'] ?? ''), liczba: trafienia.length }
}
