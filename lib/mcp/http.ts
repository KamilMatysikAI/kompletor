// Transport Streamable HTTP serwera MCP, trasa app/api/mcp/route.ts. Bezstanowo: żadnego stanu między
// żądaniami poza licznikami limitów; serwer nie wydaje `Mcp-Session-Id`, nie otwiera strumienia GET i nie wysyła SSE
// (każda odpowiedź to jeden obiekt JSON, co transport dopuszcza).
//
// Kolejność sprawdzeń w POST:
//  1. `Origin` (ochrona przed DNS rebinding, transport „Security”): obecny i spoza listy = 403. Lista: origin z
//     PANEL_URL i z MCP_DOZWOLONE_ORIGINY (po przecinku). Klienci serwerowi i CLI nie wysyłają `Origin` wcale.
//  2. `Accept` (musi dopuszczać application/json) i `Content-Type: application/json`.
//  3. Klucz API: `Authorization: Bearer kmp_…` przez `authenticateApiKey` (te same limity i `lastUsedAt` co /api/v1).
//     Brak / zły / odwołany klucz albo firma nieaktywna = 401 z `WWW-Authenticate: Bearer realm="Kompletor MCP"` —
//     bez `resource_metadata`, bo serwer nie ma OAuth (docs/mcp.md: które klienty działają kluczem).
//     Klucz obsługi klienta (`obsluga:odczyt`) = 403 już tutaj: nie dostaje nawet listy narzędzi.
//  4. Treść do 64 KB (jak POST /api/v1/zamowienia), jedna wiadomość JSON-RPC (paczki = 400).
//  5. Wersja: 2026-07-28 — `_meta` + nagłówki `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` zgodne z treścią
//     (inaczej 400 HeaderMismatch -32020); 2025-11-25 / 2025-06-18 — `initialize` albo nagłówek wersji;
//     inna wersja albo brak nagłówka = 400 UnsupportedProtocolVersion (-32022) z listą obsługiwanych.
// GET i DELETE = 405 (bez strumienia GET i bez sesji do zamknięcia).
import { authenticateApiKey, type ApiGuardDeps } from '@/lib/api/klucze'
import { ApiInputError } from '@/lib/api/odpowiedzi'
import { OBSLUGA_SCOPE } from '@/lib/api/zakresy'
import { readJsonBody } from '@/lib/api/zapis'
import { panelBaseUrl } from '@/lib/auth/zaproszenia'
import { contextFromApiKey } from './kontekst'
import {
  decodeHeaderValue,
  HEADER_MISMATCH,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  isLegacy,
  isModern,
  metaVersion,
  METHOD_NOT_FOUND,
  parseMessage,
  PARSE_ERROR,
  RATE_LIMITED,
  rpcError,
  UNAUTHORIZED,
  unsupportedVersion,
  type Era,
  type JsonRpcResponse,
} from './protokol'
import { handleRequest } from './serwer'

export const MCP_MAX_BODY_BYTES = 64 * 1024
export const MCP_PATH = '/api/mcp'

export interface McpHttpDeps extends ApiGuardDeps {
  env?: Record<string, string | undefined>
}

const HEADERS = { 'Cache-Control': 'no-store' }

function rpcJson(body: JsonRpcResponse, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...headers } })
}

/** Originy, z których przeglądarka może wołać serwer (poza nimi 403); bez `Origin` (CLI, serwery) zawsze wolno. */
export function allowedOrigins(env: Record<string, string | undefined>): Set<string> {
  const out = new Set<string>()
  const panel = panelBaseUrl(env)
  if (panel) out.add(new URL(panel).origin)
  for (const raw of (env['MCP_DOZWOLONE_ORIGINY'] ?? '').split(',')) {
    const v = raw.trim()
    if (!v) continue
    try {
      const u = new URL(v)
      if (u.protocol === 'https:' || u.protocol === 'http:') out.add(u.origin)
    } catch {
      // zły wpis pomijamy (nie poszerza listy)
    }
  }
  return out
}

/** Adres serwera MCP tej instalacji (ekran Agenci AI) albo null, gdy brak PANEL_URL. */
export function mcpServerUrl(env: Record<string, string | undefined>): string | null {
  const base = panelBaseUrl(env)
  return base ? `${base}${MCP_PATH}` : null
}

export function methodNotAllowed(): Response {
  return rpcJson(rpcError(null, INVALID_REQUEST, 'Ten serwer MCP przyjmuje tylko POST (bez strumienia GET i bez sesji)'), 405, { Allow: 'POST' })
}

const acceptsJson = (accept: string | null) => !accept || /(^|,)\s*(application\/json|application\/\*|\*\/\*)\s*(;|,|$)/i.test(accept)

export async function handleMcpHttp(req: Request, deps: McpHttpDeps = {}): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()
  const env = deps.env ?? process.env

  const origin = req.headers.get('origin')
  if (origin !== null && !allowedOrigins(env).has(origin)) return rpcJson(rpcError(null, INVALID_REQUEST, 'Niedozwolony nagłówek Origin'), 403)
  if (!acceptsJson(req.headers.get('accept'))) return rpcJson(rpcError(null, INVALID_REQUEST, 'Nagłówek Accept musi dopuszczać application/json'), 406)
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return rpcJson(rpcError(null, INVALID_REQUEST, 'Content-Type musi być application/json'), 415)

  const api = await authenticateApiKey(req, {
    ...deps,
    unauthorizedResponse: () =>
      rpcJson(rpcError(null, UNAUTHORIZED, 'Wymagany ważny klucz agenta w nagłówku Authorization: Bearer kmp_… (Ustawienia → Integracje i agenci AI → Agenci AI)'), 401, { 'WWW-Authenticate': 'Bearer realm="Kompletor MCP"' }),
  })
  if (api instanceof Response) {
    if (api.status !== 429) return api
    const retry = api.headers.get('retry-after') ?? '60'
    return rpcJson(rpcError(null, RATE_LIMITED, `Za dużo żądań tym kluczem. Spróbuj ponownie za ${retry} s.`, { ponowZaSekund: Number(retry) }), 429, { 'Retry-After': retry })
  }
  if (api.scopes.has(OBSLUGA_SCOPE)) return rpcJson(rpcError(null, UNAUTHORIZED, 'Klucz obsługi klienta nie ma dostępu do serwera MCP. Agent AI potrzebuje klucza z Ustawienia → Integracje i agenci AI → Agenci AI.'), 403)

  let body: unknown
  try {
    body = await readJsonBody(req, MCP_MAX_BODY_BYTES)
  } catch (e) {
    if (e instanceof ApiInputError && e.status === 413) return rpcJson(rpcError(null, INVALID_REQUEST, `Treść większa niż ${MCP_MAX_BODY_BYTES / 1024} KB`), 413)
    return rpcJson(rpcError(null, PARSE_ERROR, 'Treść nie jest poprawnym JSON-em'), 400)
  }

  const parsed = parseMessage(body)
  if (parsed.kind === 'invalid') return rpcJson(rpcError(parsed.id, INVALID_REQUEST, parsed.message), 400)
  // powiadomienia (np. notifications/initialized z 2025-11-25): przyjęte, bez treści odpowiedzi
  if (parsed.kind === 'notification') return new Response(null, { status: 202, headers: HEADERS })
  const msg = parsed.msg

  const hv = req.headers.get('mcp-protocol-version')
  const mv = metaVersion(msg.params)
  let era: Era
  if (msg.method === 'initialize' && mv === null && (hv === null || !isModern(hv))) {
    era = 'legacy'
  } else if (mv !== null || (hv !== null && isModern(hv))) {
    if (mv !== null && !isModern(mv)) return rpcJson(unsupportedVersion(msg.id, mv), 400)
    if (mv === null || hv !== mv) return rpcJson(rpcError(msg.id, HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version musi być równy _meta["io.modelcontextprotocol/protocolVersion"]'), 400)
    if (req.headers.get('mcp-method') !== msg.method) return rpcJson(rpcError(msg.id, HEADER_MISMATCH, 'Header mismatch: Mcp-Method musi być równy polu method'), 400)
    if (msg.method === 'tools/call') {
      const raw = req.headers.get('mcp-name')
      const name = raw === null ? null : decodeHeaderValue(raw)
      if (name === null || name !== msg.params?.name) return rpcJson(rpcError(msg.id, HEADER_MISMATCH, 'Header mismatch: Mcp-Name musi być równy params.name'), 400)
    }
    era = 'modern'
  } else {
    // brak nagłówka po initialize = 2025-11-25. Serwer jest bezstanowy (nie pamięta negocjacji),
    // a tools/list i tools/call są w 2025-06-18 i 2025-11-25 takie same; klucz jest już sprawdzony. 400 tylko dla jawnie
    // podanej nieobsługiwanej wersji.
    if (hv !== null && !isLegacy(hv)) return rpcJson(unsupportedVersion(msg.id, hv), 400)
    era = 'legacy'
  }

  try {
    const res = await handleRequest(contextFromApiKey(api), era, msg)
    // 2026-07-28: nieznana metoda = 404 z -32601; w 2025-11-25 404 znaczy „sesja wygasła”, więc tam zostaje 200
    const status = era === 'modern' && 'error' in res && res.error.code === METHOD_NOT_FOUND ? 404 : 200
    return rpcJson(res, status)
  } catch (e) {
    console.error('[mcp] błąd obsługi żądania', (e as Error)?.name)
    return rpcJson(rpcError(msg.id, INTERNAL_ERROR, 'Błąd serwera'), 500)
  }
}
