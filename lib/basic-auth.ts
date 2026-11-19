// Bramka Basic Auth na cały panel, w proxy.ts PRZED sesją panelu.
// Włączona, gdy ustawiono OBA: BASIC_AUTH_USER i BASIC_AUTH_PASSWORD (staging w Coolify). Jedno bez drugiego =
// odmowa wszystkiego (503), żeby literówka w konfiguracji nie otworzyła panelu. Bez obu:
//  - poza produkcją (lokalnie, testy) brak bramki;
//  - w NODE_ENV=production też 503 (zgubione zmienne nie mogą wystawić panelu), chyba że
//    BASIC_AUTH_DISABLED=1 — jawne wyłączenie dla self-hostu za własnym proxy albo instancji z samym logowaniem.
// Bramkę wyłączamy tą zmienną, nie kasowaniem kodu. `/api/health` zostaje otwarte: healthcheck kontenera woła go bez hasła, a odpowiedź
// nie zawiera danych firm. Dlaczego w aplikacji, a nie w proxy Coolify: Coolify 4.1.2 odpowiada 500 na
// `is_http_basic_auth_enabled` przy zakładaniu aplikacji (25.10.2026), a PATCH tego pola nie przyjmuje.

export type BasicAuthDecision =
  | { kind: 'pass' }
  | { kind: 'challenge' }
  | { kind: 'misconfigured'; reason: 'partial' | 'missing-in-production' }

// /api/v1 — Authorization: Bearer <klucz API firmy>; trasa bez ważnego klucza odpowiada 401 JSON sama
// /api/druk — agent druku wysyła `Authorization: Bearer <token stanowiska>` (nagłówek zajęty, więc nie
// może podać hasła Basic); trasa bez ważnego tokenu odpowiada 401 JSON sama (lib/druk/tokeny.ts)
// /api/mcp — serwer MCP; agent wysyła `Authorization: Bearer <klucz API agenta>`, trasa bez klucza = 401 sama
// /api/kanaly/woo/klucze — POST z kluczami wysyła serwer sklepu WooCommerce (wc-auth), bez hasła Basic;
// bramką jest podpisany jednorazowy `user_id` w samej trasie (lib/kanaly/woo-autoryzacja.ts)
const OPEN_PATHS = [/^\/api\/health$/, /^\/api\/v1(\/|$)/, /^\/api\/mcp$/, /^\/api\/druk(\/|$)/, /^\/api\/kanaly\/woo\/klucze$/]

/** Porównanie w czasie niezależnym od miejsca pierwszej różnicy (długość może wyciec, treść nie). */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

export function basicAuthDecision(
  pathname: string,
  authorization: string | null,
  env: Record<string, string | undefined>,
): BasicAuthDecision {
  const user = env.BASIC_AUTH_USER ?? ''
  const password = env.BASIC_AUTH_PASSWORD ?? ''
  if (!user && !password) {
    if (env.NODE_ENV !== 'production' || env.BASIC_AUTH_DISABLED === '1') return { kind: 'pass' }
    if (OPEN_PATHS.some((r) => r.test(pathname))) return { kind: 'pass' }
    return { kind: 'misconfigured', reason: 'missing-in-production' }
  }
  if (OPEN_PATHS.some((r) => r.test(pathname))) return { kind: 'pass' }
  if (!user || !password) return { kind: 'misconfigured', reason: 'partial' }
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization ?? '')
  if (!m) return { kind: 'challenge' }
  let decoded: string
  try {
    decoded = Buffer.from(m[1]!, 'base64').toString('utf8')
  } catch {
    return { kind: 'challenge' }
  }
  const i = decoded.indexOf(':')
  if (i < 0) return { kind: 'challenge' }
  const okUser = safeEqual(decoded.slice(0, i), user)
  const okPass = safeEqual(decoded.slice(i + 1), password)
  return okUser && okPass ? { kind: 'pass' } : { kind: 'challenge' }
}

const MISCONFIGURED_TEXT: Record<'partial' | 'missing-in-production', string> = {
  partial: 'Panel wyłączony: niepełna konfiguracja Basic Auth (BASIC_AUTH_USER i BASIC_AUTH_PASSWORD).',
  'missing-in-production':
    'Panel bez bramki: ustaw BASIC_AUTH_USER i BASIC_AUTH_PASSWORD albo BASIC_AUTH_DISABLED=1 (własne proxy / logowanie do panelu).',
}

/** Odpowiedź bramki albo null (przepuść dalej). */
export function basicAuthResponse(pathname: string, authorization: string | null, env: Record<string, string | undefined>): Response | null {
  const d = basicAuthDecision(pathname, authorization, env)
  if (d.kind === 'pass') return null
  if (d.kind === 'misconfigured')
    return new Response(MISCONFIGURED_TEXT[d.reason], {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  return new Response('Wymagane logowanie', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Kompletor", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * Czy żądanie niesie poprawne hasło Basic Auth (szczegóły kont w /api/health). Tylko przy włączonej bramce
 * (oba BASIC_AUTH_*): bez bramki (self-host, lokalnie) szczegółów w health nie ma — są w panelu po zalogowaniu.
 */
export function hasValidBasicAuth(authorization: string | null, env: Record<string, string | undefined>): boolean {
  if (!env.BASIC_AUTH_USER || !env.BASIC_AUTH_PASSWORD) return false
  return basicAuthDecision('/', authorization, env).kind === 'pass'
}
