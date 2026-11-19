import { describe, expect, it } from 'vitest'
import { hostyPanelu, sprawdzCsrf, WYJATKI_CSRF, wyjatekCsrf } from './csrf'

// reguła CSRF (lib/auth/csrf.ts) bez proxy — decyzja z nagłówków i env.
const h = (o: Record<string, string> = {}) => new Headers(o)
const ok = (method: string, path: string, headers: Record<string, string>, env: Record<string, string | undefined> = {}) =>
  sprawdzCsrf(method, path, h(headers), env).ok

describe('sprawdzCsrf', () => {
  it('GET, HEAD i OPTIONS przechodzą bez nagłówków (reguła tylko dla zmian stanu)', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(ok(m, '/api/wydruki/karty', {}), m).toBe(true)
  })

  it('POST/PUT/PATCH/DELETE bez Sec-Fetch-Site, Origin i Referer = odmowa (także małe litery metody)', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      const d = sprawdzCsrf(m, '/api/wydruki/zlecenia', h({ host: 'panel.test' }), {})
      expect(d.ok, m).toBe(false)
    }
  })

  it('Sec-Fetch-Site: przechodzi tylko same-origin; same-site, cross-site i none = odmowa nawet z dobrym Origin', () => {
    expect(ok('POST', '/api/x', { 'sec-fetch-site': 'same-origin' })).toBe(true)
    expect(ok('POST', '/api/x', { 'sec-fetch-site': 'Same-Origin' })).toBe(true)
    for (const s of ['same-site', 'cross-site', 'none']) {
      expect(ok('POST', '/api/x', { 'sec-fetch-site': s, host: 'panel.test', origin: 'https://panel.test' }), s).toBe(false)
    }
  })

  it('bez Sec-Fetch-Site: Origin z hostem żądania przechodzi, obcy, "null" i śmieci nie', () => {
    expect(ok('POST', '/zamowienia', { host: 'panel.test', origin: 'https://panel.test' })).toBe(true)
    expect(ok('POST', '/zamowienia', { host: 'panel.test:3100', origin: 'http://panel.test:3100' })).toBe(true)
    expect(ok('POST', '/zamowienia', { host: 'panel.test', origin: 'https://zly.test' })).toBe(false)
    expect(ok('POST', '/zamowienia', { host: 'panel.test', origin: 'https://panel.test.zly.test' })).toBe(false)
    expect(ok('POST', '/zamowienia', { host: 'panel.test', origin: 'null' })).toBe(false)
    expect(ok('POST', '/zamowienia', { host: 'panel.test', origin: 'nie-adres' })).toBe(false)
    expect(ok('POST', '/zamowienia', { host: 'panel.test', origin: 'ftp://panel.test' })).toBe(false)
    // Origin rozstrzyga: dobry Referer nie ratuje obcego Origin
    expect(ok('POST', '/zamowienia', { host: 'panel.test', origin: 'https://zly.test', referer: 'https://panel.test/zamowienia' })).toBe(false)
  })

  it('bez Sec-Fetch-Site i Origin: decyduje Referer', () => {
    expect(ok('POST', '/api/x', { host: 'panel.test', referer: 'https://panel.test/zamowienia?z=1' })).toBe(true)
    expect(ok('POST', '/api/x', { host: 'panel.test', referer: 'https://zly.test/panel.test' })).toBe(false)
  })

  it('za proxy Coolify/Traefik: Host wewnętrzny, X-Forwarded-Host publiczny — Origin publiczny przechodzi', () => {
    const za = { host: 'kontener:3100', 'x-forwarded-host': 'kompletor.example.pl', 'x-forwarded-proto': 'https' }
    expect(ok('POST', '/api/x', { ...za, origin: 'https://kompletor.example.pl' })).toBe(true)
    expect(ok('POST', '/api/x', { ...za, 'x-forwarded-host': 'kompletor.example.pl, inny.test', origin: 'https://kompletor.example.pl' })).toBe(true)
    expect(ok('POST', '/api/x', { ...za, origin: 'https://zly.test' })).toBe(false)
  })

  it('adres publiczny z PANEL_URL i APP_PUBLIC_URL też jest hostem panelu (proxy bez X-Forwarded-Host)', () => {
    const wew = { host: 'kontener:3100' }
    expect(ok('POST', '/api/x', { ...wew, origin: 'https://kompletor.example.pl' })).toBe(false)
    expect(ok('POST', '/api/x', { ...wew, origin: 'https://kompletor.example.pl' }, { PANEL_URL: 'https://kompletor.example.pl' })).toBe(true)
    expect(ok('POST', '/api/x', { ...wew, origin: 'https://kompletor.example.pl' }, { APP_PUBLIC_URL: 'https://Kompletor.Example.pl/' })).toBe(true)
    expect(ok('POST', '/api/x', { ...wew, referer: 'https://kompletor.example.pl/x' }, { PANEL_URL: 'https://kompletor.example.pl' })).toBe(true)
    // zły adres w env niczego nie otwiera
    expect([...hostyPanelu(h(wew), { PANEL_URL: 'nie-adres', APP_PUBLIC_URL: 'javascript:alert(1)' })]).toEqual(['kontener:3100'])
  })

  it('wyjątki: POST bez nagłówków przeglądarki przechodzi tylko na trasach z listy; podobne ścieżki nie', () => {
    for (const p of ['/api/v1/zamowienia', '/api/v1', '/api/mcp', '/api/druk/stan', '/api/druk/zlecenia/z1/wynik', '/api/kanaly/woo/klucze']) {
      expect(sprawdzCsrf('POST', p, h(), {}), p).toEqual({ ok: true, powod: 'wyjatek' })
    }
    for (const p of ['/api/v10/x', '/api/v1x', '/api/mcp/x', '/api/mcpx', '/api/drukx', '/api/kanaly/woo/klucze/x', '/api/kanaly/woo', '/api/wydruki/zlecenia', '/v1/zamowienia', '/logowanie']) {
      expect(wyjatekCsrf(p), p).toBeUndefined()
      expect(ok('POST', p, {}), p).toBe(false)
    }
  })

  it('każdy wyjątek ma uzasadnienie i wskazanie tras', () => {
    expect(WYJATKI_CSRF.length).toBeLessThanOrEqual(6)
    for (const w of WYJATKI_CSRF) {
      expect(w.powod.length, w.trasy).toBeGreaterThan(30)
      expect(w.trasy).toMatch(/^app\/api\//)
    }
  })
})
