// części serwera MCP bez bazy — protokół, walidator schematów, rejestr narzędzi, limity, fragmenty
// konfiguracji klientów i pomost stdio (z podstawionym fetch, bez sieci).
import { describe, expect, it } from 'vitest'
import { MCP_SCOPES } from '@/lib/api/zakresy'
import { clientConfigs, KEY_PLACEHOLDER } from './konfiguracje'
import { RetryLimiter } from './limity'
import { TOOLS } from './narzedzia'
import { createBridge, headerValue, mcpEndpoint, type FetchFn } from './pomost'
import { decodeHeaderValue, LEGACY_VERSIONS, MCP_PROTOCOL_LATEST, MODERN_VERSIONS, parseMessage, SUPPORTED_VERSIONS } from './protokol'
import { assertSupportedSchema, validate } from './schemat'

describe('protokół', () => {
  it('wersje: aktualna 2026-07-28 i poprzednie bez sesji', () => {
    expect(MCP_PROTOCOL_LATEST).toBe('2026-07-28')
    expect(MODERN_VERSIONS).toEqual(['2026-07-28'])
    expect(LEGACY_VERSIONS).toEqual(['2025-11-25', '2025-06-18'])
    expect(SUPPORTED_VERSIONS).toEqual(['2026-07-28', '2025-11-25', '2025-06-18'])
  })

  it('parseMessage: żądanie, powiadomienie, odpowiedź od klienta, paczka, złe pola', () => {
    expect(parseMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toMatchObject({ kind: 'request', msg: { id: 1, method: 'tools/list' } })
    expect(parseMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toMatchObject({ kind: 'notification' })
    expect(parseMessage({ jsonrpc: '2.0', id: 1, result: {} })).toMatchObject({ kind: 'invalid', id: 1 })
    expect(parseMessage([{ jsonrpc: '2.0', id: 1, method: 'x' }])).toMatchObject({ kind: 'invalid', id: null })
    expect(parseMessage({ jsonrpc: '1.0', id: 1, method: 'x' })).toMatchObject({ kind: 'invalid' })
    expect(parseMessage({ jsonrpc: '2.0', id: { a: 1 }, method: 'x' })).toMatchObject({ kind: 'invalid' })
    expect(parseMessage({ jsonrpc: '2.0', id: 1, method: 'x', params: [1] })).toMatchObject({ kind: 'invalid' })
    expect(parseMessage('tekst')).toMatchObject({ kind: 'invalid' })
  })

  it('nagłówki: zapis =?base64?…?= dekodowany, znaki sterujące odrzucone', () => {
    expect(decodeHeaderValue('statusy')).toBe('statusy')
    expect(decodeHeaderValue(`=?base64?${Buffer.from('zamówienia').toString('base64')}?=`)).toBe('zamówienia')
    expect(decodeHeaderValue('=?base64?***?=')).toBeNull()
    expect(decodeHeaderValue('a\u0001b')).toBeNull()
    expect(headerValue('statusy')).toBe('statusy')
    expect(decodeHeaderValue(headerValue('zamówienia'))).toBe('zamówienia')
    expect(decodeHeaderValue(headerValue(' spacja '))).toBe(' spacja ')
    expect(headerValue('=?base64?abc?=')).toMatch(/^=\?base64\?/)
  })
})

describe('walidator schematów', () => {
  const s = { type: 'object' as const, properties: { a: { type: 'integer' as const, minimum: 1, maximum: 5 }, b: { type: 'array' as const, items: { type: 'string' as const, enum: ['X', 'Y'] }, maxItems: 2 }, c: { type: ['string' as const, 'null' as const] } }, required: ['a'], additionalProperties: false as const }
  it('typy, zakresy, enum, wymagane, nieznane pola, null', () => {
    expect(validate(s, { a: 3, b: ['X'], c: null })).toEqual([])
    expect(validate(s, {})).toEqual(['a: pole wymagane'])
    expect(validate(s, { a: 9 })).toEqual(['a: najwyżej 5'])
    expect(validate(s, { a: 1.5 })[0]).toMatch(/typ integer/)
    expect(validate(s, { a: 1, b: ['Z'] })[0]).toMatch(/b\[0\]: dozwolone/)
    expect(validate(s, { a: 1, b: ['X', 'Y', 'X'] })[0]).toMatch(/najwyżej 2 pozycji/)
    expect(validate(s, { a: 1, x: 1 })).toEqual(['x: nieznane pole'])
    expect(validate(s, [1])[0]).toMatch(/typ object/)
  })
})

describe('rejestr narzędzi', () => {
  it('nazwy snake_case bez znaków diakrytycznych, unikalne, w stałej kolejności', () => {
    const names = TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]{2,40}$/)
  })

  it('każde narzędzie: opis po polsku z przykładem, schematy obsługiwane przez walidator, zakres MCP, adnotacje tylko-odczyt', () => {
    for (const t of TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(80)
      expect(t.description, t.name).toMatch(/[ąćęłńóśźż]/)
      expect(t.description, t.name).toMatch(/„|\?/)
      expect(t.inputSchema.type).toBe('object')
      expect(t.inputSchema.additionalProperties, t.name).toBe(false)
      expect(() => assertSupportedSchema(t.inputSchema), t.name).not.toThrow()
      expect(() => assertSupportedSchema(t.outputSchema), t.name).not.toThrow()
      expect(MCP_SCOPES).toContain(t.scope)
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
      // schemat nie ma pola z firmą: firma zawsze z kontekstu
      expect(Object.keys(t.inputSchema.properties ?? {}).some((k) => /org|firma|organization/i.test(k)), t.name).toBe(false)
      if (t.limitArg) expect(t.inputSchema.properties?.[t.limitArg]?.type, t.name).toBe('integer')
    }
  })
})

describe('limity', () => {
  it('okno przesuwne z czasem do zwolnienia miejsca, osobno na klucz', () => {
    const l = new RetryLimiter(2, 60_000)
    expect(l.hit('k', 0)).toBeNull()
    expect(l.hit('k', 10_000)).toBeNull()
    expect(l.hit('k', 20_000)).toBe(40)
    expect(l.hit('inny', 20_000)).toBeNull()
    expect(l.hit('k', 60_001)).toBeNull()
  })

  it('dzienny limit raportów: czas do zwolnienia w sekundach z doby', () => {
    const day = new RetryLimiter(1, 24 * 3600_000)
    expect(day.hit('k', 0)).toBeNull()
    expect(day.hit('k', 3600_000)).toBe(23 * 3600)
  })
})

describe('fragmenty konfiguracji', () => {
  const URL = 'https://kompletor.example.invalid/api/mcp'
  it('klucz tylko, gdy podany; inaczej <TWÓJ_KLUCZ>; ChatGPT uczciwie „wkrótce”', () => {
    const withKey = clientConfigs(URL, 'kmp_PRZYKLADOWY_KLUCZ')
    const noKey = clientConfigs(URL, null)
    expect(withKey.find((c) => c.id === 'claude-code')!.text).toBe(`claude mcp add --transport http kompletor ${URL} --header "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ"`)
    for (const c of noKey) {
      expect(c.text ?? '', c.id).not.toMatch(/kmp_[A-Za-z0-9]/)
      if (c.text && c.id !== 'vscode') expect(c.text, c.id).toContain(KEY_PLACEHOLDER)
    }
    // VS Code: klucz nigdy w pliku, zawsze z bezpiecznego pola
    expect(withKey.find((c) => c.id === 'vscode')!.text).not.toContain('kmp_PRZYKLADOWY_KLUCZ')
    expect(JSON.parse(withKey.find((c) => c.id === 'cursor')!.text!)).toEqual({ mcpServers: { kompletor: { url: URL, headers: { Authorization: 'Bearer kmp_PRZYKLADOWY_KLUCZ' } } } })
    expect(JSON.parse(withKey.find((c) => c.id === 'claude-desktop')!.text!).mcpServers.kompletor.env).toEqual({ KOMPLETOR_URL: 'https://kompletor.example.invalid', KOMPLETOR_API_KEY: 'kmp_PRZYKLADOWY_KLUCZ' })
    expect(withKey.find((c) => c.id === 'chatgpt')).toMatchObject({ mode: 'oauth', text: null })
  })
})

describe('pomost stdio', () => {
  const KEY = 'kmp_' + 'A'.repeat(43)
  function harness(reply: (body: Record<string, unknown>) => { status: number; body: unknown }) {
    const sent: { url: string; headers: Record<string, string>; body: string }[] = []
    const out: string[] = []
    const logs: string[] = []
    const fetch: FetchFn = async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body })
      const r = reply(JSON.parse(init.body))
      return { status: r.status, headers: { get: () => null }, text: async () => (r.body === null ? '' : JSON.stringify(r.body)) }
    }
    const bridge = createBridge({ url: 'https://kompletor.example.invalid', apiKey: KEY, fetch, write: (l) => out.push(l), log: (l) => logs.push(l) })
    return { bridge, sent, out, logs }
  }

  it('adres: sama instalacja albo pełny /api/mcp; tylko http(s), bez loginu w adresie', () => {
    expect(mcpEndpoint('https://kompletor.example.invalid')).toBe('https://kompletor.example.invalid/api/mcp')
    expect(mcpEndpoint('https://kompletor.example.invalid/api/mcp/')).toBe('https://kompletor.example.invalid/api/mcp')
    expect(mcpEndpoint('https://kompletor.example.invalid/sub')).toBe('https://kompletor.example.invalid/sub/api/mcp')
    expect(() => mcpEndpoint('ftp://x.example.invalid')).toThrow()
    expect(() => mcpEndpoint('https://u:p@x.example.invalid')).toThrow()
  })

  it('2026-07-28: wersja z _meta do nagłówków, Mcp-Method i Mcp-Name; klucz tylko w Authorization, nigdy w logu', async () => {
    const h = harness((b) => ({ status: 200, body: { jsonrpc: '2.0', id: b.id, result: { resultType: 'complete', content: [] } } }))
    const msg = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'statusy', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }
    await h.bridge.handleLine(JSON.stringify(msg))
    expect(h.sent[0]!.url).toBe('https://kompletor.example.invalid/api/mcp')
    expect(h.sent[0]!.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'statusy', 'content-type': 'application/json' })
    expect(JSON.parse(h.out[0]!)).toMatchObject({ id: 7, result: { resultType: 'complete' } })
    expect(h.logs.join('\n')).not.toContain(KEY.slice(4))
  })

  it('2025-11-25: wersja z initialize zapamiętana w procesie i dokładana w nagłówku; powiadomienie bez odpowiedzi', async () => {
    const h = harness((b) => (b.id === undefined ? { status: 202, body: null } : b.method === 'initialize' ? { status: 200, body: { jsonrpc: '2.0', id: b.id, result: { protocolVersion: '2025-11-25' } } } : { status: 200, body: { jsonrpc: '2.0', id: b.id, result: { tools: [] } } }))
    await h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))
    expect(h.sent[0]!.headers['mcp-protocol-version']).toBeUndefined()
    await h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    await h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    expect(h.sent[2]!.headers['mcp-protocol-version']).toBe('2025-11-25')
    expect(h.sent[2]!.headers['mcp-method']).toBeUndefined()
    expect(h.out).toHaveLength(2) // initialize + tools/list; powiadomienie bez linii na stdout
  })

  it('wiadomości wysłane od razu po initialize czekają na uzgodnioną wersję (bez wyścigu)', async () => {
    const h = harness((b) => (b.method === 'initialize' ? { status: 200, body: { jsonrpc: '2.0', id: b.id, result: { protocolVersion: '2025-06-18' } } } : { status: 200, body: { jsonrpc: '2.0', id: b.id, result: {} } }))
    // obie linie naraz (jak z potoku): druga nie może wyjść przed odpowiedzią na initialize
    await Promise.all([
      h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })),
      h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })),
    ])
    expect(h.sent.map((x) => x.headers['mcp-protocol-version'])).toEqual([undefined, '2025-06-18'])
  })

  it('błąd przed odczytem treści (401, id null) wraca z id żądania; brak sieci = błąd JSON-RPC; zły JSON = -32700', async () => {
    const h = harness(() => ({ status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Wymagany klucz' } } }))
    await h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'a1', method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }))
    expect(JSON.parse(h.out[0]!)).toMatchObject({ id: 'a1', error: { code: -32001 } })
    expect(h.logs[0]).toMatch(/HTTP 401/)
    await h.bridge.handleLine('{zly')
    expect(JSON.parse(h.out[1]!)).toMatchObject({ id: null, error: { code: -32700 } })
    const offline = createBridge({ url: 'https://kompletor.example.invalid', apiKey: KEY, fetch: async () => { throw new TypeError('fetch failed') }, write: (l) => h.out.push(l) })
    await offline.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }))
    expect(JSON.parse(h.out[2]!)).toMatchObject({ id: 5, error: { code: -32603 } })
  })
})
