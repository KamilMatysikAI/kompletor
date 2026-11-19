// Pomost stdio → Streamable HTTP (komenda `kompletor-mcp`, scripts/kompletor-mcp.ts). Dla klientów MCP,
// które uruchamiają serwer jako proces (Claude Desktop bez OAuth, self-host): czyta wiadomości JSON-RPC z stdin (jedna
// na linię, transport stdio), wysyła każdą osobnym POST-em do /api/mcp z kluczem z env i odpisuje odpowiedź na stdout.
// Bez dostępu do bazy: jedna ścieżka uwierzytelnienia (klucz API agenta), te same limity i dziennik co klient HTTP.
// Klucz tylko z env (KOMPLETOR_API_KEY) — nigdy w argumentach linii komend ani w logu (stderr dostaje same statusy).
//
// Wersja: wiadomość 2026-07-28 niesie wersję w `_meta` (pomost kopiuje ją do nagłówka); klient 2025-11-25 robi
// `initialize` — pomost zapamiętuje uzgodnioną wersję na czas procesu (stdio = jedna „sesja”) i dokłada ją w nagłówku.
import { META_PROTOCOL_VERSION } from './protokol'

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>

export interface BridgeOptions {
  url: string
  apiKey: string
  fetch: FetchFn
  write: (line: string) => void
  log?: (line: string) => void
}

/** Adres serwera z KOMPLETOR_URL: sam adres instalacji albo pełny adres /api/mcp. */
export function mcpEndpoint(base: string): string {
  const u = new URL(base.trim())
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('KOMPLETOR_URL: adres http(s)')
  if (u.username || u.password || u.search || u.hash) throw new Error('KOMPLETOR_URL: bez loginu, zapytania i kotwicy')
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.origin}${path.endsWith('/api/mcp') ? path : `${path}/api/mcp`}`
}

/** Nagłówek z wartością spoza bezpiecznego ASCII zapisany jako =?base64?…?= (transport, „Value Encoding”). */
export function headerValue(v: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(v) && !/^=\?base64\?.*\?=$/.test(v)
  return plain ? v : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function createBridge(o: BridgeOptions) {
  const endpoint = mcpEndpoint(o.url)
  let legacyVersion: string | null = null
  // trwające `initialize`: kolejne wiadomości czekają na uzgodnioną wersję (klient może je wysłać od razu po sobie)
  let initializing: Promise<void> | null = null
  const log = o.log ?? (() => undefined)

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return
    if (/"method"\s*:\s*"initialize"/.test(line)) {
      const run = send(line)
      initializing = run.finally(() => {
        if (initializing === wait) initializing = null
      })
      const wait = initializing
      return run
    }
    if (initializing) await initializing.catch(() => undefined)
    return send(line)
  }

  async function send(line: string): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      o.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }
    const id = isObj(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null
    const method = isObj(msg) && typeof msg.method === 'string' ? msg.method : null
    const params = isObj(msg) && isObj(msg.params) ? msg.params : undefined
    const meta = params && isObj(params._meta) ? params._meta : undefined
    const modern = meta && typeof meta[META_PROTOCOL_VERSION] === 'string' ? (meta[META_PROTOCOL_VERSION] as string) : null
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    const version = modern ?? (method === 'initialize' ? null : legacyVersion)
    if (version) headers['mcp-protocol-version'] = version
    if (modern && method) headers['mcp-method'] = method
    if (modern && method === 'tools/call' && typeof params?.name === 'string') headers['mcp-name'] = headerValue(params.name)

    let status = 0
    let text = ''
    try {
      const res = await o.fetch(endpoint, { method: 'POST', headers, body: line })
      status = res.status
      text = await res.text()
    } catch (e) {
      log(`[kompletor-mcp] brak połączenia z serwerem (${(e as Error)?.name ?? 'błąd'})`)
      if (id !== null) o.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Brak połączenia z serwerem Kompletora' } }))
      return
    }
    if (id === null) return // powiadomienie: 202 bez treści
    if (status >= 400) log(`[kompletor-mcp] ${method ?? '?'}: HTTP ${status}`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      o.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: `Serwer Kompletora odpowiedział HTTP ${status}` } }))
      return
    }
    if (isObj(body)) {
      if (method === 'initialize' && isObj(body.result) && typeof body.result.protocolVersion === 'string') legacyVersion = body.result.protocolVersion
      // błędy przed odczytem treści (401, 403, 413, 429) serwer zwraca z id null — klient stdio czeka na swoje id
      if (body.id === null || body.id === undefined) body.id = id
    }
    o.write(JSON.stringify(body))
  }

  return { handleLine, endpoint, get legacyVersion() {
    return legacyVersion
  } }
}
