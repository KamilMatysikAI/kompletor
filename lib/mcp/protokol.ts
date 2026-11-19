// Protokół MCP: stałe wersji, kształty JSON-RPC i kody błędów. Czyste funkcje, bez bazy i bez Next.
//
// Specyfikacja: https://modelcontextprotocol.io/specification/2026-07-28 (sprawdzona 03.11.2026 w repozytorium
// specyfikacji, najnowsza wydana rewizja; po niej jest tylko `draft`). Typy wzorowane na `schema/2026-07-28/schema.ts`.
//
// Serwer jest „dual-era” (basic/versioning, „Backward Compatibility”):
//  - rewizja 2026-07-28 (modern): bez `initialize`, wersja i możliwości klienta w `_meta` każdego żądania, nagłówki
//    `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` sprawdzane z treścią, `server/discover`, `resultType` w wyniku;
//  - rewizje 2025-11-25 i 2025-06-18 (legacy): `initialize` + nagłówek `MCP-Protocol-Version`, ale BEZ sesji
//    (serwer nie wydaje `Mcp-Session-Id`, co poprzednie rewizje dopuszczają) — każde żądanie obsłużone osobno.
// Starsze wersje (2025-03-26 i wcześniej, także brak nagłówka wersji poza `initialize`) = UnsupportedProtocolVersion.

export const MCP_PROTOCOL_LATEST = '2026-07-28'
/** Rewizje bez `initialize` (wersja w `_meta` każdego żądania). */
export const MODERN_VERSIONS = ['2026-07-28'] as const
/** Rewizje z `initialize` obsługiwane bez sesji; pierwsza = odpowiedź, gdy klient poprosi o nieznaną. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18'] as const
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS]

export const SERVER_INFO = { name: 'kompletor', title: 'Kompletor', version: '1.0.0' } as const

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

// Kody JSON-RPC (basic/index, „Error Codes”)
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603
export const HEADER_MISMATCH = -32020
export const UNSUPPORTED_PROTOCOL_VERSION = -32022
/** Zakres implementacji (-32000…-32019): brak uwierzytelnienia w treści 401 (sam status HTTP niesie znaczenie). */
export const UNAUTHORIZED = -32001
/** Zakres implementacji: przekroczony wspólny limit żądań klucza (HTTP 429 z Retry-After). */
export const RATE_LIMITED = -32005

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId | null; result: Record<string, unknown> } | { jsonrpc: '2.0'; id: JsonRpcId | null; error: JsonRpcError }

export type Era = 'modern' | 'legacy'

export const isModern = (v: string): boolean => (MODERN_VERSIONS as readonly string[]).includes(v)
export const isLegacy = (v: string): boolean => (LEGACY_VERSIONS as readonly string[]).includes(v)

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
}

export function rpcResult(id: JsonRpcId, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export const unsupportedVersion = (id: JsonRpcId | null, requested: string): JsonRpcResponse =>
  rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested: requested.slice(0, 40) })

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export type ParsedMessage =
  | { kind: 'request'; msg: JsonRpcRequest }
  | { kind: 'notification'; msg: JsonRpcNotification }
  | { kind: 'invalid'; id: JsonRpcId | null; message: string }

/** Jedna wiadomość JSON-RPC z treści POST (paczki tablicą usunięte w 2025-06-18 — nie przyjmujemy). */
export function parseMessage(body: unknown): ParsedMessage {
  if (Array.isArray(body)) return { kind: 'invalid', id: null, message: 'Paczki JSON-RPC (tablica) nie są obsługiwane: jedna wiadomość na żądanie' }
  if (!isObj(body)) return { kind: 'invalid', id: null, message: 'Oczekiwany obiekt JSON-RPC' }
  const id = typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id)) ? (body.id as JsonRpcId) : null
  if (body.jsonrpc !== '2.0') return { kind: 'invalid', id, message: 'Pole jsonrpc musi mieć wartość "2.0"' }
  if (typeof body.method !== 'string' || !body.method || body.method.length > 100) {
    // odpowiedź od klienta (result/error) też tu trafia: klient nie wysyła odpowiedzi w tym transporcie
    return { kind: 'invalid', id, message: 'Brak pola method (klient wysyła tylko żądania i powiadomienia)' }
  }
  if (body.params !== undefined && !isObj(body.params)) return { kind: 'invalid', id, message: 'Pole params musi być obiektem' }
  const params = body.params as Record<string, unknown> | undefined
  if (!('id' in body) || body.id === undefined) return { kind: 'notification', msg: { jsonrpc: '2.0', method: body.method, params } }
  if (id === null) return { kind: 'invalid', id: null, message: 'Pole id musi być tekstem albo liczbą' }
  return { kind: 'request', msg: { jsonrpc: '2.0', id, method: body.method, params } }
}

/** Wersja protokołu z `params._meta` (modern) albo null. */
export function metaVersion(params: Record<string, unknown> | undefined): string | null {
  const meta = params?.['_meta']
  if (!isObj(meta)) return null
  const v = meta[META_PROTOCOL_VERSION]
  return typeof v === 'string' ? v : null
}

/** Nazwa klienta z `_meta` (tylko do dziennika serwera; niezweryfikowana). */
export function clientName(params: Record<string, unknown> | undefined): string | null {
  const meta = params?.['_meta']
  const info = isObj(meta) ? meta[META_CLIENT_INFO] : undefined
  return isObj(info) && typeof info.name === 'string' ? info.name.slice(0, 60) : null
}

/**
 * Wartość nagłówka `Mcp-Name` / `Mcp-Param-*` po zdjęciu kodowania `=?base64?…?=` (transport, „Value Encoding”).
 * null = zły zapis (niedozwolone znaki albo zły base64).
 */
export function decodeHeaderValue(raw: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(raw)
  if (!m && /^=\?base64\?.*\?=$/.test(raw)) return null // wygląda na zapis base64, ale zły
  if (m) {
    try {
      const text = Buffer.from(m[1]!, 'base64').toString('utf8')
      return Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '') === m[1]!.replace(/=+$/, '') ? text : null
    } catch {
      return null
    }
  }
  return /^[\x20-\x7e\t]*$/.test(raw) ? raw : null
}
