// Obsługa metod MCP niezależna od transportu: `tools/list`, `tools/call`, `server/discover` (2026-07-28)
// oraz `initialize` i `ping` (2025-11-25 / 2025-06-18, bez sesji). Transport HTTP (lib/mcp/http.ts) sprawdza nagłówki,
// klucz i wersję, a tu dostaje gotowy kontekst firmy. `callTool` jest też wejściem dla asystenta w panelu.
//
// Wywołanie narzędzia, w tej kolejności: znane narzędzie (inaczej błąd protokołu -32602) → zakres (ODMOWA) → limit
// minutowy i dzienny (LIMIT, z czasem ponowienia) → schemat argumentów (BLAD) → run → przycięcie wyniku do
// MAX_RESULT_CHARS → wpis dziennika. Błąd narzędzia wraca jako wynik z `isError: true` (model widzi powód i może
// poprawić wywołanie), nie jako błąd protokołu; wyjątek niespodziewany = „Błąd serwera” bez szczegółów.
import { ApiInputError } from '@/lib/api/odpowiedzi'
import { logMcpCall } from './dziennik'
import { limiterKey, type McpContext } from './kontekst'
import { mcpLimiters } from './limity'
import { findTool, MAX_RESULT_CHARS, TOOLS, type McpTool } from './narzedzia'
import { INVALID_PARAMS, LEGACY_VERSIONS, META_SERVER_INFO, METHOD_NOT_FOUND, MODERN_VERSIONS, rpcError, rpcResult, SERVER_INFO, SUPPORTED_VERSIONS, type Era, type JsonRpcRequest, type JsonRpcResponse } from './protokol'
import { validate } from './schemat'

export const SERVER_INSTRUCTIONS = [
  'Kompletor to system magazynowo-zamówieniowy sklepu. Narzędzia tylko czytają dane tej jednej firmy: zamówienia, stany, produkty, braki, rezerwacje i liczby dnia.',
  'Daty w ISO 8601; „dzisiaj” i „wczoraj” liczymy w czasie polskim (Europe/Warsaw).',
  'Dane klientów (imiona, adresy, telefony, e-maile) nie są dostępne — nie proś o nie i nie zgaduj.',
  'Narzędzia nie wysyłają niczego do sklepów, przewoźników ani urzędów.',
].join(' ')

export interface ToolCallResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface CallOutcome {
  result: ToolCallResult
  /** null = nieznane narzędzie (błąd protokołu, bez wpisu w dzienniku). */
  status: 'OK' | 'ODMOWA' | 'BLAD' | 'LIMIT' | null
}

const toolError = (text: string): ToolCallResult => ({ content: [{ type: 'text', text }], isError: true })

/** Definicje do `tools/list` (bez `run`, zakresów i pól wewnętrznych). */
export function toolDefinitions(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations }))
}

/** Nazwy użytych parametrów — tylko te ze schematu narzędzia (nigdy wartości ani dowolne klucze od modelu). */
function paramNames(tool: McpTool, args: Record<string, unknown>): string[] {
  const known = Object.keys(tool.inputSchema.properties ?? {})
  return known.filter((k) => args[k] !== undefined)
}

export async function callTool(ctx: McpContext, name: string, rawArgs: unknown): Promise<CallOutcome> {
  const tool = findTool(name)
  if (!tool) return { result: toolError(`Nieznane narzędzie ${name.slice(0, 60)}`), status: null }
  const started = Date.now()
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs
  const params = args && typeof args === 'object' && !Array.isArray(args) ? paramNames(tool, args as Record<string, unknown>) : []
  const done = async (status: 'OK' | 'ODMOWA' | 'BLAD' | 'LIMIT', result: ToolCallResult, items: number | null = null): Promise<CallOutcome> => {
    await logMcpCall(ctx, { tool: tool.name, result: status, durationMs: Date.now() - started, items, params })
    return { result, status }
  }

  if (!ctx.scopes.has(tool.scope)) return done('ODMOWA', toolError(`Brak dostępu: klucz nie ma zakresu ${tool.scope}. Właściciel firmy nadaje go w panelu: Ustawienia → Integracje i agenci AI → Agenci AI.`))

  const now = ctx.now().getTime()
  const key = limiterKey(ctx)
  const lim = mcpLimiters()
  const perMinute = lim.calls.hit(key, now)
  const perDay = perMinute === null && tool.heavy ? lim.heavy.hit(key, now) : null
  const wait = perMinute ?? perDay
  if (wait !== null) {
    // bez structuredContent przy błędzie: klient może sprawdzać go ze schematem wyjścia narzędzia
    const which = perMinute !== null ? 'na minutę' : 'dzienny limit raportów'
    return done('LIMIT', toolError(`Za dużo wywołań narzędzi tym kluczem (${which}). Spróbuj ponownie za ${wait} s.`))
  }

  const errors = validate(tool.inputSchema, args)
  if (errors.length) return done('BLAD', toolError(`Złe argumenty: ${errors.slice(0, 5).join('; ')}`))

  try {
    let a = args as Record<string, unknown>
    for (;;) {
      const r = await tool.run(ctx, a)
      const text = JSON.stringify(r.data)
      if (text.length <= MAX_RESULT_CHARS) return done('OK', { content: [{ type: 'text', text }], structuredContent: r.data }, r.items)
      // za duży wynik: mniejsza strona (kursor zostaje poprawny), a bez argumentu limitu — prośba o zawężenie
      const limit = tool.limitArg ? (typeof a[tool.limitArg] === 'number' ? (a[tool.limitArg] as number) : r.items) : 0
      if (!tool.limitArg || limit <= 1) return done('BLAD', toolError('Wynik za duży na jedną odpowiedź. Zawęź zapytanie (mniej SKU, filtr kanału lub statusu).'), r.items)
      a = { ...a, [tool.limitArg]: Math.max(1, Math.floor(Math.min(limit, r.items) / 2)) }
    }
  } catch (e) {
    if (e instanceof ApiInputError) return done('BLAD', toolError(`Złe argumenty: ${e.message}`))
    console.error('[mcp] błąd narzędzia', tool.name, (e as Error)?.name)
    return done('BLAD', toolError('Błąd serwera Kompletora. Spróbuj ponownie później.'))
  }
}

/** Wynik zwykłej (nie-interim) odpowiedzi w danej erze: 2026-07-28 wymaga `resultType` i zaleca `serverInfo` w `_meta`. */
function result(era: Era, body: Record<string, unknown>): Record<string, unknown> {
  return era === 'modern' ? { resultType: 'complete', ...body, _meta: { [META_SERVER_INFO]: SERVER_INFO } } : body
}

const CAPABILITIES = { tools: { listChanged: false } }

/**
 * Odpowiedź na żądanie z kontekstem firmy. `version` = uzgodniona wersja (modern: z `_meta`, legacy: z nagłówka).
 * null = metoda nieznana w tej erze (transport zamienia na -32601 z właściwym statusem HTTP).
 */
export async function handleRequest(ctx: McpContext, era: Era, req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const p = req.params ?? {}
  switch (req.method) {
    case 'tools/list':
      return rpcResult(req.id, result(era, { tools: toolDefinitions(), ...(era === 'modern' ? { ttlMs: 300_000, cacheScope: 'public' } : {}) }))
    case 'tools/call': {
      if (typeof p.name !== 'string' || !p.name) return rpcError(req.id, INVALID_PARAMS, 'Brak params.name (nazwa narzędzia)')
      if (p.arguments !== undefined && (typeof p.arguments !== 'object' || p.arguments === null || Array.isArray(p.arguments))) return rpcError(req.id, INVALID_PARAMS, 'params.arguments musi być obiektem')
      const out = await callTool(ctx, p.name, p.arguments)
      if (out.status === null) return rpcError(req.id, INVALID_PARAMS, `Unknown tool: ${p.name.slice(0, 60)}`)
      return rpcResult(req.id, result(era, { ...out.result }))
    }
    case 'server/discover':
      if (era !== 'modern') break
      return rpcResult(
        req.id,
        result(era, { supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: CAPABILITIES, instructions: SERVER_INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: 'public' }),
      )
    case 'ping':
      if (era !== 'legacy') break
      return rpcResult(req.id, {})
    case 'initialize': {
      if (era !== 'legacy') break
      const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : ''
      // negocjacja z 2025-11-25 (lifecycle): ta sama wersja, jeśli ją obsługujemy, inaczej najnowsza nasza z tej ery
      const protocolVersion = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0]
      return rpcResult(req.id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS })
    }
  }
  return rpcError(req.id, METHOD_NOT_FOUND, `Method not found: ${req.method.slice(0, 60)}`, { supportedVersions: SUPPORTED_VERSIONS })
}
