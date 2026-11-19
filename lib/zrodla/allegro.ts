// Allegro REST API — klient TYLKO DO ODCZYTU (GET) + dwa wywołania OAuth (POST /auth/oauth/token i
// /auth/oauth/device na serwerze autoryzacji). Własna para tokenów Kompletora (device flow), nigdy cudza:
// refresh token Allegro jest jednorazowy, więc dwa narzędzia na jednej parze unieważniałyby sobie nawzajem tokeny.
// Bez logowania nagłówków, tokenów, Client Secret, `device_code` ani treści odpowiedzi; komunikaty błędów tylko
// ze ścieżką, statusem HTTP i kodem błędu OAuth.
import { fetchWithTimeout, ReadOnlyViolation, type RetryOptions, SourceError, Throttle, withRetry, type FetchLike } from './http'

export const ALLEGRO_ACCEPT = 'application/vnd.allegro.public.v1+json'
export const ALLEGRO_API_URL = 'https://api.allegro.pl'
export const ALLEGRO_AUTH_URL = 'https://allegro.pl'
/** Produkcja i sandbox; inny host = błąd konfiguracji (tokeny nie mogą trafić pod obcy adres). */
export const ALLEGRO_API_URL_RE = /^https:\/\/api\.allegro\.pl(\.allegrosandbox\.pl)?\/?$/
export const ALLEGRO_AUTH_URL_RE = /^https:\/\/allegro\.pl(\.allegrosandbox\.pl)?\/?$/
/** „NazwaAplikacji/Wersja (+URL)” — wymóg Allegro dla nagłówka User-Agent. */
export const ALLEGRO_USER_AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,60}\/[0-9][0-9A-Za-z.]{0,15} \(\+https?:\/\/\S+\)$/
/** Podstawowy zakres, o który prosi Kompletor (odczyt zamówień). */
export const ALLEGRO_ORDERS_READ_SCOPE = 'allegro:api:orders:read'
/** odczyt listy ofert konta (`GET /sale/offers`, „Pobierz oferty” bez BL); tylko z `--z-ofertami`. */
export const ALLEGRO_OFFERS_READ_SCOPE = 'allegro:api:sale:offers:read'

const trimSlash = (u: string) => u.replace(/\/+$/, '')

export interface AllegroResponse<T> {
  status: number
  body: T | null
  /** Z nagłówka Retry-After (sekundy albo data HTTP); null = brak. */
  retryAfterMs: number | null
}

export function retryAfterMsOf(v: string | null, now = Date.now()): number | null {
  if (v === null || v.trim() === '') return null
  const s = Number(v)
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000)
  const d = Date.parse(v)
  return Number.isNaN(d) ? null : Math.max(0, d - now)
}

/**
 * GET ścieżki API. 5xx, sieć i odpowiedź nie-JSON → SourceError przejściowy (ponawiany z backoffem); pozostałe statusy
 * (401, 403, 404, 429, 4xx) wracają do wołającego, który decyduje (odświeżenie tokena, rodzaj błędu adaptera).
 */
export class AllegroReadOnly {
  private readonly throttle: Throttle
  private readonly base: string

  constructor(
    apiUrl: string,
    private readonly userAgent: string,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 100,
    private readonly retry: RetryOptions = { attempts: 3, baseDelayMs: 2_000 },
  ) {
    if (!ALLEGRO_API_URL_RE.test(apiUrl)) throw new Error('Adres API Allegro spoza listy (api.allegro.pl albo sandbox)')
    this.base = trimSlash(apiUrl)
    this.throttle = new Throttle(minIntervalMs)
  }

  async get<T>(path: string, query: Record<string, string | number> | [string, string][], accessToken: string, init: { method?: string } = {}): Promise<AllegroResponse<T>> {
    if ((init.method ?? 'GET') !== 'GET') throw new ReadOnlyViolation('Allegro: klient tylko do odczytu (GET)')
    if (!path.startsWith('/') || path.includes('..')) throw new Error('zła ścieżka Allegro')
    const entries = Array.isArray(query) ? query : Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string])
    return withRetry(
      async () => {
        await this.throttle.wait()
        const qs = new URLSearchParams(entries)
        const res = await fetchWithTimeout(
          this.fetchImpl,
          `${this.base}${path}${qs.size ? `?${qs}` : ''}`,
          { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: ALLEGRO_ACCEPT, 'User-Agent': this.userAgent } },
          60_000,
        )
        if (res.status >= 500) throw new SourceError(`Allegro ${path}: HTTP ${res.status}`, true)
        const retryAfterMs = retryAfterMsOf(res.headers.get('retry-after'))
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined)
          return { status: res.status, body: null, retryAfterMs }
        }
        let body: T
        try {
          body = (await res.json()) as T
        } catch {
          throw new SourceError(`Allegro ${path}: odpowiedź nie jest JSON`, true)
        }
        return { status: res.status, body, retryAfterMs }
      },
      this.retry,
    )
  }
}

// ─── OAuth (serwer autoryzacji) ──────────────────────────────────────────────

export interface AllegroTokenSet {
  accessToken: string
  refreshToken: string
  /** Koniec ważności access tokena (z `expires_in`). */
  expiresAt: Date
  /**
   * zakres przyznany przez Allegro (`scope` w odpowiedzi tokena, spacjami).
   * Brak, gdy Allegro go nie zwróciło albo ma nieoczekiwany kształt — wtedy zostaje zakres zapisany wcześniej.
   */
  scope?: string
}

/** Zakres OAuth: nazwy `allegro:api:…` rozdzielone spacjami; inny kształt pomijamy (nie zapisujemy śmieci). */
const SCOPE_RE = /^[a-z][a-z0-9:_.-]{0,99}( [a-z][a-z0-9:_.-]{0,99}){0,49}$/

/** Błąd OAuth: tylko kod (`invalid_grant`, `authorization_pending`…) i status HTTP — bez treści żądania. */
export class AllegroOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`Allegro OAuth: ${code} (HTTP ${status})`)
    this.name = 'AllegroOAuthError'
  }
}

export interface AllegroOAuthClient {
  authUrl: string
  clientId: string
  clientSecret: string
  userAgent: string
  fetch: FetchLike
  now?: () => Date
}

const OAUTH_CODE_RE = /^[a-z_]{1,64}$/

async function oauthPost(c: AllegroOAuthClient, path: '/auth/oauth/token' | '/auth/oauth/device', form: Record<string, string>): Promise<Record<string, unknown>> {
  if (!ALLEGRO_AUTH_URL_RE.test(c.authUrl)) throw new Error('Adres autoryzacji Allegro spoza listy (allegro.pl albo sandbox)')
  if (!c.clientId || !c.clientSecret) throw new AllegroOAuthError('brak_client_id_albo_secret', 0, false)
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`, 'utf8').toString('base64')
  let res: Response
  try {
    res = await fetchWithTimeout(
      c.fetch,
      `${trimSlash(c.authUrl)}${path}`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': c.userAgent },
        body: new URLSearchParams(form).toString(),
      },
      30_000,
    )
  } catch {
    // treść błędu sieci bywa z adresem i fragmentem żądania — tylko rodzaj
    throw new AllegroOAuthError('blad_sieci', 0, true)
  }
  let body: Record<string, unknown> = {}
  try {
    const j = (await res.json()) as unknown
    if (j && typeof j === 'object' && !Array.isArray(j)) body = j as Record<string, unknown>
  } catch {
    // brak JSON: niżej po statusie
  }
  if (res.ok) return body
  const raw = typeof body['error'] === 'string' ? body['error'] : ''
  const code = OAUTH_CODE_RE.test(raw) ? raw : res.status === 401 ? 'invalid_client' : `http_${res.status}`
  throw new AllegroOAuthError(code, res.status, res.status === 429 || res.status >= 500)
}

// zakres o złym kształcie zostawia na ekranie zakres zapisany wcześniej — jeden wpis
// diagnostyczny na proces (bez wartości zakresu), żeby ten stan zostawił ślad w logu.
let zakresPominietyZgloszony = false
function zakresPominiety(): void {
  if (zakresPominietyZgloszony) return
  zakresPominietyZgloszony = true
  console.warn('[allegro-oauth] zakres pominięty (zły kształt): zostaje zakres zapisany wcześniej')
}

function tokenSetOf(body: Record<string, unknown>, now: Date): AllegroTokenSet {
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : ''
  const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : ''
  const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : Number(body['expires_in'])
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new AllegroOAuthError('niepelna_odpowiedz_tokena', 200, false)
  const rawScope = typeof body['scope'] === 'string' ? body['scope'].trim().replace(/\s+/g, ' ') : ''
  const scope = SCOPE_RE.test(rawScope) ? rawScope : undefined
  if (!scope && body['scope'] !== undefined && body['scope'] !== '') zakresPominiety()
  return { accessToken, refreshToken, expiresAt: new Date(now.getTime() + expiresIn * 1000), ...(scope ? { scope } : {}) }
}

/** Odświeżenie pary: refresh token zużyty przez Allegro (nowy zwrócony w odpowiedzi). */
export async function refreshAllegroToken(c: AllegroOAuthClient, refreshToken: string): Promise<AllegroTokenSet> {
  const body = await oauthPost(c, '/auth/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken })
  return tokenSetOf(body, (c.now ?? (() => new Date()))())
}

export interface AllegroDeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresInSec: number
  intervalSec: number
}

/** Początek device flow: kod urządzenia + link dla właściciela konta. `scope` = zawężenie uprawnień (spacjami). */
export async function requestAllegroDeviceCode(c: AllegroOAuthClient, scope: string | null): Promise<AllegroDeviceCode> {
  const body = await oauthPost(c, '/auth/oauth/device', { client_id: c.clientId, ...(scope ? { scope } : {}) })
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '')
  const n = (k: string, d: number) => (Number.isFinite(Number(body[k])) && Number(body[k]) > 0 ? Number(body[k]) : d)
  const out = {
    deviceCode: s('device_code'),
    userCode: s('user_code'),
    verificationUri: s('verification_uri'),
    verificationUriComplete: s('verification_uri_complete'),
    expiresInSec: n('expires_in', 3600),
    intervalSec: n('interval', 5),
  }
  if (!out.deviceCode || !out.verificationUriComplete) throw new AllegroOAuthError('niepelna_odpowiedz_device', 200, false)
  return out
}

/** Jedno odpytanie o token device flow; błąd OAuth (`authorization_pending`, `slow_down`…) jako AllegroOAuthError. */
export async function pollAllegroDeviceToken(c: AllegroOAuthClient, deviceCode: string): Promise<AllegroTokenSet> {
  const body = await oauthPost(c, '/auth/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode })
  return tokenSetOf(body, (c.now ?? (() => new Date()))())
}

// ─── Kategorie, parametry i katalog produktów (tylko odczyt) ──────────────────────────────────────
// Port odczytów ze skilla allegro-oferty (`scripts/allegro_api.py`: get_matching_categories, get_category,
// get_category_parameters, search_products_by_ean). Funkcje dostają gotowy GET (np. `AllegroAdapter.call` z
// tokenem i odświeżaniem), więc nie znają tokenów; surowe odpowiedzi przechodzą przez parsery `...ZApi`,
// testowane na nagranych odpowiedziach bez sieci. Zapisu ofert tu nie ma.

/** GET ścieżki API Allegro z tokenem konta (401/403/429 obsługuje wołający, np. `AllegroAdapter.call`). */
export type AllegroGet = <T>(path: string, query: [string, string][]) => Promise<AllegroResponse<T>>

/** jedyne ścieżki odczytu do ofertowania (kategorie, parametry, dopasowanie, katalog, oferty po sygnaturze). */
export const ODCZYT_OFERT_ALLEGRO_RE = /^\/sale\/(categories(\/[0-9A-Za-z-]{1,64}(\/parameters)?)?|matching-categories|products|offers)$/

/** Błąd odczytu katalogu/kategorii: status HTTP inny niż 2xx i 404. */
export class AllegroOdczytError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'AllegroOdczytError'
  }
}

export interface AllegroKategoria {
  id: string
  nazwa: string
  /** Oferta może trafić tylko do kategorii-liścia. */
  lisc: boolean
  rodzicId: string | null
}

export interface AllegroWartoscSlownika {
  id: string
  wartosc: string
}

export interface AllegroParametrKategorii {
  id: string
  nazwa: string
  /** dictionary | string | integer | float — jak w API. */
  typ: string
  wymagany: boolean
  wymaganyDlaProduktu: boolean
  /** true = parametr produktu (`productSet[].product.parameters`), false = parametr oferty (`parameters`). */
  opisujeProdukt: boolean
  slownik: AllegroWartoscSlownika[]
  /** Słownik dopuszcza wartość spoza listy (`restrictions.allowedOtherValue`); domyślnie true jak w skillu. */
  dowolnaWartosc: boolean
  jednostka: string | null
}

export interface AllegroProduktKatalogu {
  id: string
  nazwa: string
  kategoriaId: string | null
  /** Wartości EAN/GTIN zapisane w parametrach produktu katalogowego (do sprawdzenia trafienia). */
  eany: string[]
  zdjecia: string[]
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Id parametru EAN (GTIN) w Allegro; wspólne dla wszystkich kategorii (skill: `PARAM_EAN_ID`). */
export const ALLEGRO_PARAM_EAN = '225693'

export function allegroKategoriaZApi(raw: unknown): AllegroKategoria | null {
  const r = rec(raw)
  const id = str(r['id'])
  if (!id) return null
  const parent = rec(r['parent'])
  return { id, nazwa: str(r['name']), lisc: r['leaf'] === true, rodzicId: str(parent['id']) || null }
}

export function allegroParametryZApi(raw: unknown): AllegroParametrKategorii[] {
  const out: AllegroParametrKategorii[] = []
  for (const p of arr(rec(raw)['parameters'])) {
    const r = rec(p)
    const id = str(r['id'])
    if (!id) continue
    const restr = rec(r['restrictions'])
    out.push({
      id,
      nazwa: str(r['name']),
      typ: str(r['type']) || 'string',
      wymagany: r['required'] === true,
      wymaganyDlaProduktu: r['requiredForProduct'] === true,
      opisujeProdukt: rec(r['options'])['describesProduct'] === true,
      slownik: arr(r['dictionary'])
        .map((d) => ({ id: str(rec(d)['id']), wartosc: str(rec(d)['value']) }))
        .filter((d) => d.id),
      dowolnaWartosc: restr['allowedOtherValue'] !== false,
      jednostka: str(r['unit']) || null,
    })
  }
  return out
}

export function allegroProduktKataloguZApi(raw: unknown): AllegroProduktKatalogu | null {
  const r = rec(raw)
  const id = str(r['id'])
  if (!id) return null
  const eany: string[] = []
  for (const p of arr(r['parameters'])) {
    const pr = rec(p)
    if (str(pr['id']) !== ALLEGRO_PARAM_EAN && !/\b(ean|gtin)\b/i.test(str(pr['name']))) continue
    for (const v of arr(pr['values'])) if (str(v)) eany.push(str(v).trim())
    for (const v of arr(pr['valuesLabels'])) if (str(v)) eany.push(str(v).trim())
  }
  return {
    id,
    nazwa: str(r['name']),
    kategoriaId: str(rec(r['category'])['id']) || null,
    eany: [...new Set(eany)],
    zdjecia: arr(r['images'])
      .map((i) => str(rec(i)['url']) || str(i))
      .filter(Boolean),
  }
}

/** Wartości parametrów EAN (GTIN) z listy parametrów Allegro (id 225693, flaga `options.isGTIN` albo nazwa EAN/GTIN). */
function eanyZParametrow(params: unknown): string[] {
  const out: string[] = []
  for (const p of arr(params)) {
    const pr = rec(p)
    if (str(pr['id']) !== ALLEGRO_PARAM_EAN && rec(pr['options'])['isGTIN'] !== true && !/\b(ean|gtin)\b/i.test(str(pr['name']))) continue
    for (const v of [...arr(pr['values']), ...arr(pr['valuesLabels'])]) {
      const t = str(v).replace(/\s+/g, '')
      if (/^\d{8,14}$/.test(t)) out.push(t)
    }
  }
  return out
}

export interface AllegroEanOferty {
  /** EAN oferty (8–14 cyfr, bez sprawdzenia cyfry kontrolnej: to robi host); null = brak albo niejednoznaczny. */
  ean: string | null
  /** Dlaczego bez EAN (np. zestaw kilku produktów), do notatki oferty; null przy znalezionym EAN. */
  powod: string | null
}

/**
 * EAN oferty z odpowiedzi `GET /sale/product-offers/{offerId}`. GTIN leży w parametrach produktu
 * (`productSet[].product.parameters[]`, id 225693), w starszych ofertach także w parametrach oferty (`parameters[]`)
 * albo w polu tylko do odczytu `ean`. Zestaw kilku produktów z różnymi EAN-ami albo kilka różnych EAN-ów = brak
 * (który towar to który, rozstrzyga człowiek).
 */
export function allegroEanOfertyZApi(raw: unknown): AllegroEanOferty {
  const r = rec(raw)
  const zestaw = arr(r['productSet'])
  const zProduktow = zestaw.map((x) => eanyZParametrow(rec(rec(x)['product'])['parameters']))
  const wszystkie = new Set<string>([...zProduktow.flat(), ...eanyZParametrow(r['parameters'])])
  const stare = str(r['ean']).replace(/\s+/g, '')
  if (/^\d{8,14}$/.test(stare)) wszystkie.add(stare)
  if (wszystkie.size === 1) {
    if (zestaw.length > 1) return { ean: null, powod: 'oferta to zestaw kilku produktów: EAN nie wskazuje jednego towaru' }
    return { ean: [...wszystkie][0]!, powod: null }
  }
  if (wszystkie.size > 1) return { ean: null, powod: zestaw.length > 1 ? 'oferta to zestaw kilku produktów z różnymi EAN' : 'oferta ma kilka różnych EAN' }
  return { ean: null, powod: 'produkt oferty w Allegro nie ma EAN' }
}

function oczekuj<T>(r: AllegroResponse<T>, path: string): T | null {
  if (r.status === 404) return null
  if (r.status < 200 || r.status >= 300) throw new AllegroOdczytError(`Allegro ${path}: HTTP ${r.status}`, r.status)
  return r.body
}

const idSciezki = (id: string) => {
  if (!/^[0-9A-Za-z-]{1,64}$/.test(id)) throw new Error('złe id dla Allegro')
  return id
}

/** `GET /sale/categories/{id}`; null = kategorii nie ma. */
export async function allegroKategoria(get: AllegroGet, id: string): Promise<AllegroKategoria | null> {
  const path = `/sale/categories/${idSciezki(id)}`
  return allegroKategoriaZApi(oczekuj(await get<unknown>(path, []), path))
}

/** Ścieżka nazw od korzenia do kategorii (np. „Supermarket > Przyprawy > Mielone”); najwyżej `maks` poziomów. */
export async function allegroSciezkaKategorii(get: AllegroGet, id: string, maks = 8): Promise<string[]> {
  const nazwy: string[] = []
  let biezace: string | null = id
  for (let i = 0; biezace && i < maks; i++) {
    const k = await allegroKategoria(get, biezace)
    if (!k) break
    nazwy.unshift(k.nazwa)
    biezace = k.rodzicId
  }
  return nazwy
}

/** `GET /sale/matching-categories?name=` — propozycje kategorii po nazwie produktu (z kategorią nadrzędną). */
export async function allegroDopasujKategorie(get: AllegroGet, nazwa: string): Promise<(AllegroKategoria & { rodzicNazwa: string | null })[]> {
  const path = '/sale/matching-categories'
  const body = oczekuj(await get<unknown>(path, [['name', nazwa.slice(0, 250)]]), path)
  const out: (AllegroKategoria & { rodzicNazwa: string | null })[] = []
  for (const c of arr(rec(body)['matchingCategories'])) {
    const k = allegroKategoriaZApi(c)
    if (k) out.push({ ...k, rodzicNazwa: str(rec(rec(c)['parent'])['name']) || null })
  }
  return out
}

/** `GET /sale/categories/{id}/parameters`. */
export async function allegroParametryKategorii(get: AllegroGet, id: string): Promise<AllegroParametrKategorii[]> {
  const path = `/sale/categories/${idSciezki(id)}/parameters`
  return allegroParametryZApi(oczekuj(await get<unknown>(path, []), path))
}

/** `GET /sale/products?phrase=<EAN>&language=pl-PL` — wyszukanie w katalogu Allegro po EAN (jak skill). */
export async function allegroProduktyPoEan(get: AllegroGet, ean: string): Promise<AllegroProduktKatalogu[]> {
  if (!/^\d{8,14}$/.test(ean)) throw new Error('EAN musi mieć 8–14 cyfr')
  const path = '/sale/products'
  const body = oczekuj(await get<unknown>(path, [['phrase', ean], ['language', 'pl-PL']]), path)
  return arr(rec(body)['products'])
    .map(allegroProduktKataloguZApi)
    .filter((p): p is AllegroProduktKatalogu => p !== null)
}

/**
 * oferty konta z tą sygnaturą (`external.id`, u nas SKU) — sprawdzenie przed wystawieniem, żeby powtórka
 * nie założyła drugiej oferty. Tylko GET `/sale/offers`.
 */
export async function allegroOfertyPoSygnaturze(get: AllegroGet, sygnatura: string): Promise<{ id: string; status: string }[]> {
  const s = sygnatura.trim()
  if (!s) return []
  const path = '/sale/offers'
  const body = oczekuj(await get<unknown>(path, [['external.id', s], ['limit', '20']]), path)
  return arr(rec(body)['offers'])
    .map(rec)
    .filter((o) => str(rec(o['external'])['id']) === s && str(o['id']))
    .map((o) => ({ id: str(o['id']), status: str(rec(o['publication'])['status']) }))
}
