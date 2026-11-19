// Empik (Mirakl): klient odczytu (GET) i osobny klient zapisu. Klucz współdzielony z BL i skillem
// allegro-oferty: nowego klucza nie generujemy. Zapis tworzy wyłącznie adapter `mirakl.empik.zapis.v1`
// przy włączonym wyłączniku konta; klient zapisu zna tylko cztery ścieżki (OR21, OR23, OR24, STO01).
import { createHash } from 'node:crypto'
import { retryAfterMsOf } from './shoper'
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'

/** Limit Empiku z manifestu adaptera (30 żądań/min) jako odstęp między żądaniami jednego konta. */
export const MIRAKL_MIN_INTERVAL_MS = 2_000

const accountThrottles = new Map<string, Throttle>()

/** Klucz konta Empiku w pamięci procesu: adres API + skrót klucza (sam klucz nie trafia do map). */
export function miraklAccountKey(baseUrl: string, apiKey: string): string {
  return `${baseUrl.replace(/\/+$/, '').toLowerCase()}|${createHash('sha256').update(apiKey).digest('hex').slice(0, 32)}`
}

/**
 * jeden odstęp na konto Empiku w procesie, wspólny dla wszystkich klientów odczytu i
 * zapisu tego konta (zadanie odczytu zamówień, przyjmowanie, stany). Klucz: adres API + skrót klucza (klucz nie jest
 * trzymany w mapie jawnie).
 */
export function miraklAccountThrottle(baseUrl: string, apiKey: string): Throttle {
  const key = miraklAccountKey(baseUrl, apiKey)
  let t = accountThrottles.get(key)
  if (!t) accountThrottles.set(key, (t = new Throttle(MIRAKL_MIN_INTERVAL_MS)))
  return t
}

export class MiraklReadOnly {
  /** Wspólny z klientem zapisu: odczyt i zapis jednego konta idą w jednym odstępie (bez strojenia: wspólny na konto). */
  readonly throttle: Throttle

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    /** Brak = wspólny odstęp konta (`miraklAccountThrottle`, 2 s); podany jawnie (testy, strojenie hosta) = własny. */
    minIntervalMs?: number,
    private readonly retry: RetryOptions = { attempts: 4, baseDelayMs: 5_000 },
  ) {
    if (!baseUrl || !apiKey) throw new Error('Brak EMPIK_MIRAKL_BASE_URL albo EMPIK_MIRAKL_API_KEY')
    this.throttle = minIntervalMs === undefined ? miraklAccountThrottle(baseUrl, apiKey) : new Throttle(minIntervalMs)
  }

  async get<T = Record<string, unknown>>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    if (!path.startsWith('/')) throw new Error('ścieżka musi zaczynać się od /')
    return withRetry(
      async () => {
        await this.throttle.wait()
        const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))
        const url = `${this.baseUrl.replace(/\/$/, '')}${path}${qs.size ? `?${qs}` : ''}`
        const res = await fetchWithTimeout(
          this.fetchImpl,
          url,
          { method: 'GET', headers: { Authorization: this.apiKey, Accept: 'application/json' } },
          60_000,
        )
        if (res.status === 429 || res.status >= 500) throw new SourceError(`Mirakl ${path}: HTTP ${res.status}`, true, res.status)
        if (!res.ok) throw new SourceError(`Mirakl ${path}: HTTP ${res.status}`, false, res.status)
        return (await res.json()) as T
      },
      this.retry,
    )
  }

  /**
   * odczyt treści tekstowej (STO03: raport błędów importu stanów w CSV). Te same zasady co `get`; treść
   * przycięta do `maxChars` (raport bywa duży, a potrzebujemy tylko nagłówka i pierwszych wierszy).
   */
  async getText(path: string, maxChars = 200_000): Promise<string> {
    if (!path.startsWith('/')) throw new Error('ścieżka musi zaczynać się od /')
    return withRetry(
      async () => {
        await this.throttle.wait()
        const res = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl.replace(/\/$/, '')}${path}`, { method: 'GET', headers: { Authorization: this.apiKey, Accept: 'text/csv' } }, 60_000)
        if (res.status === 429 || res.status >= 500) throw new SourceError(`Mirakl ${path}: HTTP ${res.status}`, true, res.status)
        if (!res.ok) throw new SourceError(`Mirakl ${path}: HTTP ${res.status}`, false, res.status)
        return (await res.text()).slice(0, maxChars)
      },
      this.retry,
    )
  }
}

/** Ścieżki zapisu: OR21 akceptacja, OR23 numer nadania, OR24 wysłane, STO01 import stanów. Nic poza nimi. */
const WRITE_PATHS: readonly { method: 'PUT' | 'POST'; re: RegExp }[] = [
  { method: 'PUT', re: /^\/orders\/[A-Za-z0-9_-]{1,64}\/(accept|tracking|ship)$/ },
  { method: 'POST', re: /^\/offers\/stock\/imports$/ },
  // OF01 import ofert i P41 wniosek o nowy produkt (osobny wyłącznik konta `wystawianieOfertWlaczone`)
  { method: 'POST', re: /^\/offers\/imports$/ },
  { method: 'POST', re: /^\/products\/imports$/ },
]

/**
 * Dozwolone parametry adresu zapisu: tylko `import_mode` i tylko przy importach ofert i produktów.
 * Wyłącznie `NORMAL`: `REPLACE` w imporcie ofert kasuje oferty spoza pliku, `PARTIAL_UPDATE` nadpisuje pola istniejących ofert.
 */
const IMPORT_MODES = new Set(['NORMAL'])
export function miraklQueryZapisu(path: string, query: Record<string, string> | undefined): string {
  if (!query || !Object.keys(query).length) return ''
  const klucze = Object.keys(query)
  if (!/^\/(offers|products)\/imports$/.test(path) || klucze.some((k) => k !== 'import_mode') || !IMPORT_MODES.has(query['import_mode'] ?? ''))
    throw new ReadOnlyViolation(`Mirakl: parametry zapisu poza dozwolonymi (${path.slice(0, 60)})`)
  return `?${new URLSearchParams(query)}`
}

/** Ścieżki odczytu do ofertowania (P31 katalog po EAN, H11 kategorie). */
export const ODCZYT_OFERT_MIRAKL_RE = /^\/(products|hierarchies)$/

export interface MiraklWriteResult {
  status: number
  /** Kod błędu Mirakla z treści odpowiedzi (np. ORDER_INVALID_STATE), bez reszty treści. */
  errorCode: string | null
  /** Treść JSON odpowiedzi 2xx (np. `import_id` z STO01); null = pusta albo nie-JSON. */
  body: Record<string, unknown> | null
  retryAfterMs?: number
}

const ERROR_CODE_RE = /\b(ORDER_[A-Z_]+|OFFER_[A-Z_]+|VALIDATION_ERROR|SHOP_[A-Z_]+)\b/

/**
 * Klient zapisu Mirakla: jedno żądanie bez ponawiania (wynik, także 4xx/5xx, wraca do adaptera, który decyduje o
 * rodzaju błędu); wyjątek tylko przy błędzie sieci albo timeoucie (SourceError z fetchWithTimeout). Treść błędu nie
 * trafia do wyniku poza kodem błędu (odpowiedź może zawierać dane zamówienia).
 */
export class MiraklWriter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
    private readonly throttle: Throttle,
  ) {
    if (!baseUrl || !apiKey) throw new Error('Brak adresu albo klucza API Mirakla')
  }

  async send(method: 'PUT' | 'POST', path: string, body: Record<string, unknown> | FormData | null, query?: Record<string, string>): Promise<MiraklWriteResult> {
    if (!WRITE_PATHS.some((p) => p.method === method && p.re.test(path))) throw new ReadOnlyViolation(`Mirakl: zapis poza dozwolonymi ścieżkami (${method} ${path.slice(0, 60)})`)
    const qs = miraklQueryZapisu(path, query)
    await this.throttle.wait()
    const headers: Record<string, string> = { Authorization: this.apiKey, Accept: 'application/json' }
    let payload: BodyInit | undefined
    if (body instanceof FormData) payload = body // multipart: granicę ustawia fetch
    else if (body) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl.replace(/\/$/, '')}${path}${qs}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) }, 60_000)
    let text = ''
    try {
      text = await res.text()
    } catch {
      // bez treści
    }
    let json: Record<string, unknown> | null = null
    if (res.ok && text) {
      try {
        const v = JSON.parse(text) as unknown
        json = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
      } catch {
        json = null
      }
    }
    const ra = res.status === 429 ? retryAfterMsOf(res.headers.get('retry-after')) : undefined
    return { status: res.status, errorCode: res.ok ? null : (ERROR_CODE_RE.exec(text)?.[1] ?? null), body: json, ...(ra !== undefined ? { retryAfterMs: ra } : {}) }
  }
}

// ─── Katalog (PIM) i struktura kategorii Empiku: tylko odczyt (ofertowanie) ───────────────────────────
// Port wiedzy ze skilla allegro-oferty (`SKILL.md` „Ograniczenia realnego API Mirakl”, `references/empik_categories.json`):
// - produkt w katalogu Empiku sprawdzamy po EAN przez P31 `GET /products?product_references=EAN|<ean>` (wyszukiwanie po
//   słowie nie istnieje: Mirakl odpowiada 400 „product_references is required”);
// - kategoria produktu to kod „Struktury towarowej GOLD” (np. `13-34-8-1`), ten sam w P31 (`category_code`) i w ofertach;
// - drzewo kategorii H11 `GET /hierarchies` bywa niedostępne dla klucza sklepu (skill: `/categories` → 403), więc
//   wołający traktuje błąd jak brak drzewa, a kod kategorii bierze z mapy firmy.

/** Odczyt GET względem bazy API Mirakla (np. `MiraklReadOnly.get`). Błąd HTTP = wyjątek (`SourceError`). */
export type MiraklGet = <T = Record<string, unknown>>(path: string, query?: Record<string, string | number>) => Promise<T>

export interface MiraklProduktPim {
  sku: string
  tytul: string
  kategoriaKod: string | null
  kategoriaNazwa: string | null
  /** Identyfikatory produktu typu EAN (do sprawdzenia trafienia). */
  eany: string[]
}

export interface MiraklKategoria {
  kod: string
  nazwa: string
  poziom: number | null
  rodzicKod: string | null
}

const mrec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const mstr = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const marr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export function miraklProduktZApi(raw: unknown): MiraklProduktPim | null {
  const r = mrec(raw)
  const sku = mstr(r['product_sku'])
  if (!sku) return null
  const eany = marr(r['product_references'])
    .map(mrec)
    .filter((x) => /^(EAN|GTIN|EAN13)$/i.test(mstr(x['reference_type'])))
    .map((x) => mstr(x['reference']))
    .filter((e) => /^\d{8,14}$/.test(e))
  return { sku, tytul: mstr(r['product_title']), kategoriaKod: mstr(r['category_code']) || null, kategoriaNazwa: mstr(r['category_label']) || null, eany }
}

export function miraklKategoriaZApi(raw: unknown): MiraklKategoria | null {
  const r = mrec(raw)
  const kod = mstr(r['code'])
  if (!kod) return null
  const poziom = typeof r['level'] === 'number' && Number.isFinite(r['level']) ? (r['level'] as number) : null
  return { kod, nazwa: mstr(r['label']) || kod, poziom, rodzicKod: mstr(r['parent_code']) || null }
}

/** P31: produkty katalogu Empiku z tym kodem EAN (pusta lista = produktu nie ma w katalogu). */
export async function miraklProduktyPoEan(get: MiraklGet, ean: string): Promise<MiraklProduktPim[]> {
  if (!/^\d{8,14}$/.test(ean)) throw new Error('EAN musi mieć 8–14 cyfr')
  const body = await get<unknown>('/products', { product_references: `EAN|${ean}` })
  return marr(mrec(body)['products'])
    .map(miraklProduktZApi)
    .filter((p): p is MiraklProduktPim => p !== null)
}

/** H11: struktura kategorii (płaska lista z kodem rodzica). `kod` = gałąź od tego miejsca, brak = całe drzewo. */
export async function miraklKategorie(get: MiraklGet, kod?: string): Promise<MiraklKategoria[]> {
  const body = await get<unknown>('/hierarchies', kod ? { hierarchy: kod } : {})
  return marr(mrec(body)['hierarchies'])
    .map(miraklKategoriaZApi)
    .filter((k): k is MiraklKategoria => k !== null)
}
