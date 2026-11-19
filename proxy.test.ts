import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from './proxy'

// po scaleniu: bramka Basic Auth działa PIERWSZA, sesja panelu po niej, /api/health otwarte.
const hdr = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')
const go = (p: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`http://localhost:3000${p}`, { headers }))

describe('proxy: kolejność bramek', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('z BASIC_AUTH_*: bez hasła 401 (nie przekierowanie na logowanie), także /logowanie i API', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'kompletor')
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'tajne')
    for (const p of ['/', '/pulpit', '/logowanie', '/api/cokolwiek']) {
      const r = go(p)
      expect(r.status, p).toBe(401)
      expect(r.headers.get('WWW-Authenticate'), p).toMatch(/^Basic /)
    }
    expect(go('/api/health').headers.get('x-middleware-next')).toBe('1')
  })

  it('z BASIC_AUTH_* i dobrym hasłem: dalej bramka sesji (bez ciasteczka → /logowanie)', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'kompletor')
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'tajne')
    const auth = { authorization: hdr('kompletor', 'tajne') }
    const r = go('/pulpit', auth)
    expect(r.status).toBe(307)
    expect(new URL(r.headers.get('location')!).pathname).toBe('/logowanie')
    expect(go('/logowanie', auth).headers.get('x-middleware-next')).toBe('1')
    const api = go('/api/cokolwiek', auth)
    expect(api.status).toBe(401)
    expect(api.headers.get('WWW-Authenticate')).toBeNull() // 401 sesji panelu, nie Basic Auth
  })

  it('bez BASIC_AUTH_* poza produkcją: tylko sesja panelu (zachowanie)', () => {
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expect(go('/pulpit').status).toBe(307)
    expect(go('/logowanie').headers.get('x-middleware-next')).toBe('1')
  })

  // API dla systemów zewnętrznych — bramką jest klucz API w trasie, nie hasło Basic ani sesja panelu
  it('/api/v1: bez hasła Basic i bez ciasteczka przechodzi do trasy (Authorization: Bearer), /api/inne dalej 401', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'kompletor')
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'tajne')
    const bearer = { authorization: 'Bearer kmp_' + 'A'.repeat(43) }
    for (const p of ['/api/v1', '/api/v1/', '/api/v1/stany?sku=TEST-1', '/api/v1/zamowienia', '/api/v1/zamowienia/1001']) {
      expect(go(p).headers.get('x-middleware-next'), p).toBe('1')
      expect(go(p, bearer).headers.get('x-middleware-next'), p).toBe('1')
    }
    // dopasowanie ścisłe: podobne ścieżki dalej za bramką Basic Auth
    for (const p of ['/api/inne', '/api/v10/stany', '/api/v1x', '/api/wydruki/karty', '/v1/stany']) {
      const r = go(p, bearer)
      expect(r.status, p).toBe(401)
      expect(r.headers.get('WWW-Authenticate'), p).toMatch(/^Basic /)
    }
    // z dobrym hasłem Basic: /api/inne dalej wymaga sesji panelu (401 JSON), /api/v1 przechodzi bez sesji
    const auth = { authorization: hdr('kompletor', 'tajne') }
    expect(go('/api/inne', auth).status).toBe(401)
    expect(go('/api/v1/stany', auth).headers.get('x-middleware-next')).toBe('1')
  })

  it('/api/v1 w produkcji bez BASIC_AUTH_* nie dostaje 503 (bramka to klucz), panel dalej 503', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    vi.stubEnv('BASIC_AUTH_DISABLED', '')
    expect(go('/api/v1/stany').headers.get('x-middleware-next')).toBe('1')
    expect(go('/pulpit').status).toBe(503)
    expect(go('/api/inne').status).toBe(503)
  })
})

// serwer MCP dla agentów AI — bramką jest klucz API agenta w trasie (lib/mcp/http.ts), nie Basic Auth
describe('proxy: /api/mcp dla agentów AI', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('staging (BASIC_AUTH_*): /api/mcp przechodzi bez hasła Basic i bez ciasteczka; podobne ścieżki dalej za bramką', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'kompletor')
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'tajne')
    const bearer = { authorization: 'Bearer kmp_' + 'A'.repeat(43) }
    expect(go('/api/mcp').headers.get('x-middleware-next')).toBe('1')
    expect(go('/api/mcp', bearer).headers.get('x-middleware-next')).toBe('1')
    for (const p of ['/api/mcp/', '/api/mcp/cos', '/api/mcpx', '/mcp', '/api/mcp-panel']) {
      const r = go(p, bearer)
      expect(r.status, p).toBe(401)
      expect(r.headers.get('WWW-Authenticate'), p).toMatch(/^Basic /)
    }
  })

  it('produkcja bez BASIC_AUTH_*: /api/mcp nie dostaje 503 (bramka to klucz), panel dalej 503', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    vi.stubEnv('BASIC_AUTH_DISABLED', '')
    expect(go('/api/mcp').headers.get('x-middleware-next')).toBe('1')
    expect(go('/pulpit').status).toBe(503)
  })
})

// /zaproszenie publiczne (link z zaproszenia, bez sesji) z nagłówkami prywatności; ścieżka żądania dla
// requireSession (ekran zmiany hasła bez pętli przekierowań) zawsze od proxy, nie od klienta.
describe('proxy: zaproszenia i ścieżka żądania', () => {
  afterEach(() => vi.unstubAllEnvs())
  const noBasic = () => {
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
  }

  it('/zaproszenie bez sesji przepuszczone, no-referrer i noindex; tylko ta ścieżka', () => {
    noBasic()
    const r = go('/zaproszenie?t=abcdefghijklmnopqrstuvwxyz')
    expect(r.headers.get('x-middleware-next')).toBe('1')
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(r.headers.get('X-Robots-Tag')).toMatch(/noindex/)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    for (const p of ['/zaproszenie/x', '/zaproszenia', '/zaproszeniex']) expect(go(p).status, p).toBe(307)
    expect(go('/logowanie').headers.get('Referrer-Policy')).toBeNull()
  })

  // reset hasła mailem — prośba i ustawienie z linku bez sesji; /nowe-haslo z nagłówkami jak zaproszenie
  it('/nie-pamietam-hasla i /nowe-haslo bez sesji przepuszczone; token z linku bez Referer', () => {
    noBasic()
    expect(go('/nie-pamietam-hasla').headers.get('x-middleware-next')).toBe('1')
    const r = go('/nowe-haslo?t=abcdefghijklmnopqrstuvwxyz')
    expect(r.headers.get('x-middleware-next')).toBe('1')
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    for (const p of ['/nowe-haslo/x', '/nie-pamietam-hasla/x']) expect(go(p).status, p).toBe(307)
  })

  // token resetu w `?t=` — bez Referer, bez zapisu w pamięci podręcznej i bez
  // indeksowania, także dla zalogowanej przeglądarki i przy wysłaniu formularza (POST akcji na tej samej ścieżce)
  it('/nowe-haslo z sesją i bez, GET i POST: no-referrer, no-store, noindex; strona prośby bez tych nagłówków', () => {
    noBasic()
    for (const h of [{}, { cookie: 'kompletor_sesja=cos' }] as Record<string, string>[]) {
      for (const method of ['GET', 'POST']) {
        // POST akcji z przeglądarki niesie Sec-Fetch-Site: same-origin (bez niego reguła CSRF daje 403)
        const hh = method === 'POST' ? { ...h, 'sec-fetch-site': 'same-origin' } : h
        const r = proxy(new NextRequest(new URL('/nowe-haslo?t=abcdefghijklmnopqrstuvwxyz', 'http://localhost'), { headers: hh, method }))
        expect(r.headers.get('Referrer-Policy'), `${method} ${JSON.stringify(h)}`).toBe('no-referrer')
        expect(r.headers.get('Cache-Control')).toBe('no-store')
        expect(r.headers.get('X-Robots-Tag')).toMatch(/noindex/)
      }
    }
    expect(go('/nie-pamietam-hasla').headers.get('Cache-Control')).toBeNull()
  })

  it('nagłówek ścieżki ustawia proxy (nadpisuje wartość od klienta)', () => {
    noBasic()
    const r = go('/pulpit', { cookie: 'kompletor_sesja=cos', 'x-kompletor-sciezka': '/ustawienia/haslo' })
    expect(r.headers.get('x-middleware-next')).toBe('1')
    expect(r.headers.get('x-middleware-request-x-kompletor-sciezka')).toBe('/pulpit')
    expect(go('/ustawienia/haslo', { cookie: 'kompletor_sesja=cos' }).headers.get('x-middleware-request-x-kompletor-sciezka')).toBe('/ustawienia/haslo')
  })
})

// agent druku — bramką jest token stanowiska w trasie, nie hasło Basic (nagłówek Authorization zajęty
// przez Bearer) ani sesja panelu (agent nie ma ciasteczka)
describe('proxy: /api/druk dla agenta druku', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('staging (BASIC_AUTH_*): /api/druk przechodzi bez hasła Basic i bez ciasteczka; panel i /api/wydruki dalej nie', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'kompletor')
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'tajne')
    const bearer = { authorization: 'Bearer kmd_' + 'A'.repeat(43) }
    for (const p of ['/api/druk', '/api/druk/zlecenia?stanowisko=magazyn-1', '/api/druk/pliki/abc', '/api/druk/zlecenia/abc/wynik', '/api/druk/stan']) {
      expect(go(p).headers.get('x-middleware-next'), p).toBe('1')
      expect(go(p, bearer).headers.get('x-middleware-next'), p).toBe('1')
    }
    for (const p of ['/', '/pulpit', '/ustawienia/druk', '/api/wydruki/stan', '/api/wydruki/zlecenia', '/api/drukx', '/api/druk-panel', '/druk/zlecenia']) {
      const r = go(p, bearer)
      expect(r.status, p).toBe(401)
      expect(r.headers.get('WWW-Authenticate'), p).toMatch(/^Basic /)
    }
    // z dobrym hasłem Basic: /api/wydruki dalej wymaga sesji panelu (401 JSON bez Basic)
    const auth = { authorization: hdr('kompletor', 'tajne') }
    const panel = go('/api/wydruki/stan', auth)
    expect(panel.status).toBe(401)
    expect(panel.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('produkcja bez BASIC_AUTH_*: /api/druk nie dostaje 503 (bramka to token), panel dalej 503', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    vi.stubEnv('BASIC_AUTH_DISABLED', '')
    expect(go('/api/druk/zlecenia?stanowisko=x').headers.get('x-middleware-next')).toBe('1')
    expect(go('/pulpit').status).toBe(503)
    expect(go('/api/wydruki/stan').status).toBe(503)
  })
})

// klucze ze sklepu WooCommerce (wc-auth) — POST serwera sklepu bez hasła Basic i bez ciasteczka; bramką
// jest podpisany jednorazowy `user_id` w trasie. Otwarta tylko ta jedna ścieżka.
describe('proxy: /api/kanaly/woo/klucze dla sklepu WooCommerce', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('staging i produkcja: trasa kluczy przechodzi bez hasła i bez ciasteczka; sąsiednie ścieżki nie', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'kompletor')
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'tajne')
    expect(go('/api/kanaly/woo/klucze').headers.get('x-middleware-next')).toBe('1')
    for (const p of ['/api/kanaly', '/api/kanaly/woo', '/api/kanaly/woo/klucze/x', '/api/kanaly/woo/kluczex', '/ustawienia/kanaly']) expect(go(p).status, p).toBe(401)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    vi.stubEnv('BASIC_AUTH_DISABLED', '')
    expect(go('/api/kanaly/woo/klucze').headers.get('x-middleware-next')).toBe('1')
    expect(go('/api/kanaly/woo').status).toBe(503)
  })
})

// CSRF jedną regułą (lib/auth/csrf.ts) — POST/PUT/PATCH/DELETE tylko z panelu, na każdą ścieżkę
describe('proxy: CSRF dla żądań zmieniających stan', () => {
  afterEach(() => vi.unstubAllEnvs())
  const noBasic = () => {
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
  }
  const req = (p: string, method: string, headers: Record<string, string> = {}, base = 'http://localhost:3100') =>
    proxy(new NextRequest(new URL(p, base), { method, headers }))
  const sesja = { cookie: 'kompletor_sesja=cos' }

  it('trasa API z sesją: obca strona = 403 JSON, panel (same-origin) przechodzi; GET bez zmian', async () => {
    noBasic()
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = req('/api/wydruki/zlecenia', m, { ...sesja, 'sec-fetch-site': 'cross-site', origin: 'https://zly.test' })
      expect(r.status, m).toBe(403)
      expect((await r.json()).error).toMatch(/spoza panelu/)
      expect(req('/api/wydruki/zlecenia', m, { ...sesja, 'sec-fetch-site': 'same-origin' }).headers.get('x-middleware-next'), m).toBe('1')
    }
    expect(req('/api/wydruki/zlecenia', 'POST', sesja).status).toBe(403) // bez żadnego nagłówka przeglądarki
    expect(req('/api/wydruki/stan', 'GET', sesja).headers.get('x-middleware-next')).toBe('1')
  })

  it('akcja serwera (POST na adres ekranu z Next-Action) i formularz bez JS: obcy Origin = 403, własny przechodzi', () => {
    noBasic()
    const akcja = { ...sesja, 'next-action': 'a'.repeat(40), 'content-type': 'text/plain;charset=UTF-8' }
    const r = req('/zamowienia/abc', 'POST', { ...akcja, origin: 'https://zly.test', host: 'localhost:3100' })
    expect(r.status).toBe(403)
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(req('/zamowienia/abc', 'POST', { ...akcja, 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3100' }).headers.get('x-middleware-next')).toBe('1')
    expect(req('/ustawienia', 'POST', { ...sesja, 'content-type': 'multipart/form-data; boundary=x', 'sec-fetch-site': 'cross-site' }).status).toBe(403)
  })

  it('publiczne ekrany też: logowanie i reset hasła z obcej strony = 403 (CSRF logowania), z panelu przechodzą', () => {
    noBasic()
    for (const p of ['/logowanie', '/nowe-haslo?t=abc', '/nie-pamietam-hasla', '/zaproszenie?t=abc', '/start']) {
      expect(req(p, 'POST', { 'sec-fetch-site': 'cross-site' }).status, p).toBe(403)
      expect(req(p, 'POST', { 'sec-fetch-site': 'same-origin' }).headers.get('x-middleware-next'), p).toBe('1')
    }
  })

  it('za proxy Coolify/Traefik (stara przeglądarka bez Sec-Fetch-Site): Origin = X-Forwarded-Host albo PANEL_URL', () => {
    noBasic()
    const za = { ...sesja, host: 'kontener:3100', 'x-forwarded-host': 'kompletor.example.pl', 'x-forwarded-proto': 'https' }
    expect(req('/api/wydruki/zlecenia', 'POST', { ...za, origin: 'https://kompletor.example.pl' }, 'http://kontener:3100').headers.get('x-middleware-next')).toBe('1')
    expect(req('/api/wydruki/zlecenia', 'POST', { ...za, origin: 'https://zly.test' }, 'http://kontener:3100').status).toBe(403)
    const bezFwd = { ...sesja, host: 'kontener:3100' }
    expect(req('/api/wydruki/zlecenia', 'POST', { ...bezFwd, origin: 'https://kompletor.example.pl' }, 'http://kontener:3100').status).toBe(403)
    vi.stubEnv('PANEL_URL', 'https://kompletor.example.pl')
    expect(req('/api/wydruki/zlecenia', 'POST', { ...bezFwd, origin: 'https://kompletor.example.pl' }, 'http://kontener:3100').headers.get('x-middleware-next')).toBe('1')
    expect(req('/api/wydruki/zlecenia', 'POST', { ...bezFwd, referer: 'https://kompletor.example.pl/pakowanie' }, 'http://kontener:3100').headers.get('x-middleware-next')).toBe('1')
  })

  it('wyjątki (klucz, token, podpis) przechodzą bez nagłówków przeglądarki; Basic Auth dalej pierwszy', () => {
    noBasic()
    for (const p of ['/api/v1/zamowienia', '/api/mcp', '/api/druk/stan', '/api/druk/zlecenia/z1/wynik', '/api/kanaly/woo/klucze']) {
      expect(req(p, 'POST').headers.get('x-middleware-next'), p).toBe('1')
    }
    vi.stubEnv('BASIC_AUTH_USER', 'kompletor')
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'tajne')
    expect(req('/api/wydruki/zlecenia', 'POST', { 'sec-fetch-site': 'cross-site' }).status).toBe(401)
    expect(req('/api/v1/zamowienia', 'POST').headers.get('x-middleware-next')).toBe('1')
  })
})
