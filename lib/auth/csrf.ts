// ochrona przed CSRF jedną regułą w proxy.ts (zamiast ręcznej linii w każdej trasie).
// Każde żądanie zmieniające stan (POST, PUT, PATCH, DELETE) na KAŻDĄ ścieżkę panelu — trasy /api i akcje serwera
// Next (POST na adres ekranu z nagłówkiem `Next-Action` albo formularz bez JS) — musi pochodzić z panelu:
//  1. `Sec-Fetch-Site` obecny: przechodzi tylko `same-origin` (każda nowoczesna przeglądarka wysyła go sama i strona
//     nie może go podrobić); `same-site`, `cross-site`, `none` = 403.
//  2. `Sec-Fetch-Site` brak (stara przeglądarka): `Origin`, a bez niego `Referer`, musi wskazywać host panelu.
//     Host panelu = `X-Forwarded-Host` (proxy Coolify/Traefik), `Host` oraz hosty z `PANEL_URL` i `APP_PUBLIC_URL`
//     — tak jak porównuje Next przy akcjach serwera (najpierw X-Forwarded-Host, potem Host). Obca strona nie ustawi
//     tych nagłówków w przeglądarce ofiary, więc porównanie z nimi jest bezpieczne.
//  3. Brak wszystkich trzech nagłówków = 403 (ciasteczko sesji poza przeglądarką nie ma po co trafiać do panelu).
// Wyjątki tylko dla tras z innym uwierzytelnieniem niż ciasteczko sesji (klucz albo token w nagłówku, podpis w treści):
// CSRF wykorzystuje ciasteczko, którego te trasy nie czytają. Strażnik: tests/panel-dostep.integration.test.ts.
// Pomysł za TwojOMS `src/core/bezpieczenstwo/csrf.js` (MIT), kod własny.

export const METODY_ZMIENIAJACE_STAN = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export type WyjatekCsrf = { wzor: RegExp; trasy: string; powod: string }

export const WYJATKI_CSRF: readonly WyjatekCsrf[] = [
  {
    wzor: /^\/api\/v1(\/|$)/,
    trasy: 'app/api/v1/**',
    powod: 'API dla systemów zewnętrznych: klucz API w `Authorization: Bearer` (requireApiKey), bez ciasteczka sesji',
  },
  {
    wzor: /^\/api\/mcp$/,
    trasy: 'app/api/mcp/route.ts',
    powod: 'serwer MCP dla agentów AI: klucz API agenta w `Authorization`; `Origin` przeglądarki sprawdza sam handleMcpHttp (PANEL_URL + MCP_DOZWOLONE_ORIGINY)',
  },
  {
    wzor: /^\/api\/druk(\/|$)/,
    trasy: 'app/api/druk/**',
    powod: 'agent druku na stanowisku: token stanowiska w `Authorization: Bearer` (requireStationToken), program bez przeglądarki',
  },
  {
    wzor: /^\/api\/kanaly\/woo\/klucze$/,
    trasy: 'app/api/kanaly/woo/klucze/route.ts',
    powod: 'POST serwera sklepu WooCommerce po „Połącz z WooCommerce” (wc-auth): podpisany jednorazowy `user_id` w treści, bez ciasteczka',
  },
]

export const wyjatekCsrf = (pathname: string): WyjatekCsrf | undefined => WYJATKI_CSRF.find((w) => w.wzor.test(pathname))

type Naglowki = { get(name: string): string | null }

const hostZAdresu = (raw: string | undefined): string | null => {
  const v = (raw ?? '').trim()
  if (!v) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host.toLowerCase() : null
  } catch {
    return null
  }
}

/** Hosty, pod którymi panel jest otwierany: z nagłówków żądania (proxy) i z adresu publicznego w env. */
export function hostyPanelu(h: Naglowki, env: Record<string, string | undefined>): Set<string> {
  const out = new Set<string>()
  const fwd = h.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase()
  if (fwd) out.add(fwd)
  const host = h.get('host')?.trim().toLowerCase()
  if (host) out.add(host)
  for (const k of ['PANEL_URL', 'APP_PUBLIC_URL']) {
    const x = hostZAdresu(env[k])
    if (x) out.add(x)
  }
  return out
}

export type DecyzjaCsrf = { ok: true; powod: 'metoda' | 'wyjatek' | 'sec-fetch-site' | 'origin' | 'referer' } | { ok: false; powod: string }

export function sprawdzCsrf(method: string, pathname: string, h: Naglowki, env: Record<string, string | undefined>): DecyzjaCsrf {
  if (!METODY_ZMIENIAJACE_STAN.has(method.toUpperCase())) return { ok: true, powod: 'metoda' }
  if (wyjatekCsrf(pathname)) return { ok: true, powod: 'wyjatek' }
  const site = h.get('sec-fetch-site')?.trim().toLowerCase()
  if (site) return site === 'same-origin' ? { ok: true, powod: 'sec-fetch-site' } : { ok: false, powod: `Sec-Fetch-Site: ${site}` }
  const hosty = hostyPanelu(h, env)
  const origin = h.get('origin')?.trim()
  if (origin) {
    const host = origin === 'null' ? null : hostZAdresu(origin)
    return host && hosty.has(host) ? { ok: true, powod: 'origin' } : { ok: false, powod: 'Origin spoza panelu' }
  }
  const referer = h.get('referer')?.trim()
  if (referer) {
    const host = hostZAdresu(referer)
    return host && hosty.has(host) ? { ok: true, powod: 'referer' } : { ok: false, powod: 'Referer spoza panelu' }
  }
  return { ok: false, powod: 'brak Sec-Fetch-Site, Origin i Referer' }
}

export const KOMUNIKAT_CSRF = 'Żądanie spoza panelu zostało odrzucone. Odśwież stronę panelu i spróbuj jeszcze raz.'
