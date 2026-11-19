// Dziennik wywołań narzędzi MCP (tabela McpCall). Wpis na każde wywołanie narzędzia: nazwa, wynik
// (OK / ODMOWA / BLAD / LIMIT), czas, liczba pozycji i NAZWY użytych parametrów — nigdy ich wartości ani treść wyniku
// (mogą nieść numery zamówień, SKU, frazy wpisane przez model). Zapis na kliencie firmy (RLS); błąd zapisu nie psuje
// odpowiedzi narzędzia. Retencja: `cleanupMcpCalls` w zadaniu workera `mcp-sprzatanie` (raz na dobę).
import type { McpCallResult, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import type { McpContext } from './kontekst'

export const MCP_LOG_RETENTION_DAYS = 90
export const MCP_LOG_JOB = 'mcp-sprzatanie'
const MAX_PARAMS = 20

export interface McpCallEntry {
  tool: string
  result: McpCallResult
  durationMs: number
  items?: number | null
  params: string[]
}

export async function logMcpCall(ctx: McpContext, e: McpCallEntry): Promise<void> {
  try {
    await ctx.db.mcpCall.create({
      data: {
        source: ctx.source.kind === 'klucz' ? 'KLUCZ' : 'PANEL',
        apiKeyId: ctx.source.kind === 'klucz' ? ctx.source.apiKeyId : null,
        userId: ctx.source.kind === 'panel' ? ctx.source.userId : null,
        tool: e.tool.slice(0, 64),
        result: e.result,
        durationMs: Math.max(0, Math.round(e.durationMs)),
        items: e.items ?? null,
        params: e.params.slice(0, MAX_PARAMS).map((p) => p.slice(0, 40)),
      },
    })
  } catch (err) {
    console.error('[mcp] zapis dziennika nie powiódł się', (err as Error)?.name)
  }
}

export interface McpCallRow {
  id: string
  tool: string
  result: McpCallResult
  durationMs: number
  items: number | null
  params: string[]
  createdAt: Date
  keyName: string | null
  keyPrefix: string | null
}

/** Ostatnie wywołania firmy (ekran Ustawienia → Agenci AI). */
export async function recentMcpCalls(db: PrismaClient, limit = 50): Promise<McpCallRow[]> {
  organizationIdOf(db) // klient firmy (RLS); klient systemowy = błąd
  const rows = await db.mcpCall.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(1, limit), 200),
    select: { id: true, tool: true, result: true, durationMs: true, items: true, params: true, createdAt: true, apiKey: { select: { name: true, prefix: true } } },
  })
  return rows.map((r) => ({ id: r.id, tool: r.tool, result: r.result, durationMs: r.durationMs, items: r.items, params: r.params, createdAt: r.createdAt, keyName: r.apiKey?.name ?? null, keyPrefix: r.apiKey?.prefix ?? null }))
}

/** Usuwa wpisy starsze niż retencja; zwraca liczbę usuniętych. Wołane z handlera workera, nigdy przy imporcie modułu. */
export async function cleanupMcpCalls(db: PrismaClient, now = new Date(), days = MCP_LOG_RETENTION_DAYS): Promise<number> {
  organizationIdOf(db)
  const r = await db.mcpCall.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - days * 24 * 3600_000) } } })
  return r.count
}
