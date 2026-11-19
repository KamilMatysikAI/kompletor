// Proxy Next. Trzy bramki, w tej kolejności (CSRF zaraz po Basic Auth, przed listą publicznych ścieżek):
// 1. Basic Auth (lib/basic-auth.ts) — na cały panel, gdy ustawione BASIC_AUTH_USER/PASSWORD
//    (staging). W NODE_ENV=production brak obu zmiennych = 503, chyba że BASIC_AUTH_DISABLED=1.
//    Bramkę wyłączamy zmienną BASIC_AUTH_DISABLED=1, nie kasowaniem kodu. Otwarte zostaje tylko /api/health, /api/v1,
//    /api/mcp i /api/druk (/ /: nagłówek Authorization niesie tam klucz API albo token
//    stanowiska, nie hasło Basic).
// 2. Szybkie odcięcie bez ciasteczka sesji. To tylko pierwsza linia: właściwe sprawdzenie sesji robi
//    każdy ekran przez requireSession() (lib/panel/kontekst.ts), bo samo ciasteczko może być stare albo podrobione.
// 1a. CSRF jedną regułą — POST/PUT/PATCH/DELETE na każdą ścieżkę (trasy /api i akcje serwera) tylko
//    z panelu: `Sec-Fetch-Site: same-origin` albo Origin/Referer z hostem panelu, inaczej 403. Wyjątki (klucz albo
//    token w nagłówku, podpis w treści) z uzasadnieniem w lib/auth/csrf.ts. Akcje serwera mają dodatkowo własne
//    sprawdzenie Origin w Next (to przepuszcza żądanie bez Origin; nasza reguła nie).
// /zaproszenie (link z zaproszenia do firmy) jest publiczne, z `Referrer-Policy: no-referrer` (token
// z adresu nie wycieka do zasobów obcych) i `X-Robots-Tag: noindex`. Każde przepuszczone żądanie dostaje nagłówek
// żądania PATH_HEADER ze swoją ścieżką (nadpisany, nie od klienta) — requireSession rozpoznaje ekran zmiany hasła.
import { NextResponse, type NextRequest } from 'next/server'
import { basicAuthResponse } from '@/lib/basic-auth'
import { KOMUNIKAT_CSRF, sprawdzCsrf } from '@/lib/auth/csrf'
import { PATH_HEADER, SESSION_COOKIE } from '@/lib/auth/sesja-ciasteczko'

// /api/v1 — API dla systemów zewnętrznych; bramką jest klucz API w samej trasie (requireApiKey), nie sesja
// /api/druk — wyłącznie trasy agenta druku; bramką jest token stanowiska w trasie (requireStationToken),
// nie sesja panelu (agent nie ma ciasteczka). Trasy panelu dla druku są pod /api/wydruki (sesja).
// /api/mcp — serwer MCP dla agentów AI; bramką jest klucz API agenta w trasie (lib/mcp/http.ts), tylko ta ścieżka
const PUBLIC = [
  /^\/logowanie(\/|$)/,
  /^\/api\/health$/,
  /^\/api\/v1(\/|$)/,
  /^\/api\/mcp$/,
  /^\/api\/druk(\/|$)/,
  // klucze ze sklepu WooCommerce po „Połącz z WooCommerce” (POST serwera sklepu, bez ciasteczka); bramką
  // jest podpisany jednorazowy `user_id` w trasie (lib/kanaly/woo-autoryzacja.ts)
  /^\/api\/kanaly\/woo\/klucze$/,
  /^\/zaproszenie$/,
  /^\/start$/, // kreator pierwszej firmy (zamknięty po pierwszym koncie i w hostingu)
  // reset hasła mailem (prośba o link i ustawienie nowego hasła z linku), bez sesji
  /^\/nie-pamietam-hasla$/,
  /^\/nowe-haslo$/,
]

function pass(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers)
  headers.set(PATH_HEADER, req.nextUrl.pathname)
  const res = NextResponse.next({ request: { headers } })
  // /nowe-haslo niesie jednorazowy token w adresie — te same nagłówki co zaproszenie
  if (req.nextUrl.pathname === '/zaproszenie' || req.nextUrl.pathname === '/nowe-haslo') {
    res.headers.set('Referrer-Policy', 'no-referrer')
    res.headers.set('X-Robots-Tag', 'noindex, nofollow')
    res.headers.set('Cache-Control', 'no-store')
  }
  return res
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const basic = basicAuthResponse(pathname, req.headers.get('authorization'), process.env)
  if (basic) return basic
  const csrf = sprawdzCsrf(req.method, pathname, req.headers, process.env)
  if (!csrf.ok) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: KOMUNIKAT_CSRF }, { status: 403 })
    return new NextResponse(KOMUNIKAT_CSRF, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
  if (PUBLIC.some((r) => r.test(pathname))) return pass(req)
  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Wymagane logowanie' }, { status: 401 })
    return NextResponse.redirect(new URL('/logowanie', req.url))
  }
  return pass(req)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
