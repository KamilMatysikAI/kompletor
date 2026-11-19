// Kontekst wywołania narzędzia MCP. Jedno miejsce, z którego narzędzie wie, czyje dane czyta i co mu wolno.
// Dwa źródła:
//  - klucz API (`contextFromApiKey`): trasa /api/mcp po `authenticateApiKey` — klient firmy klucza (RLS), zakresy
//    MCP klucza;
//  - sesja panelu (`contextFromPanel`): przyszły asystent w panelu — klient firmy z sesji i uprawnienia
//    osoby zamienione na te same zakresy (`panel.podglad` → `mcp:odczyt`).
// Firma jest ZAWSZE z kontekstu (klient bazy z RLS), nigdy z argumentów narzędzia: model nie ma jak wskazać innej firmy.
import type { PrismaClient } from '@prisma/client'
import type { ApiContext } from '@/lib/api/klucze'
import { MCP_SCOPES, type McpScope } from '@/lib/api/zakresy'
import type { Permission } from '@/lib/auth/uprawnienia'

export type McpSource = { kind: 'klucz'; apiKeyId: string } | { kind: 'panel'; userId: string }

export interface McpContext {
  /** Klient firmy (RLS) — jedyna droga do danych. */
  db: PrismaClient
  organizationId: string
  source: McpSource
  scopes: ReadonlySet<McpScope>
  now: () => Date
}

const isMcpScope = (s: string): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s)

export function contextFromApiKey(api: ApiContext, now: () => Date = () => new Date()): McpContext {
  return { db: api.db, organizationId: api.organizationId, source: { kind: 'klucz', apiKeyId: api.keyId }, scopes: new Set([...api.scopes].filter(isMcpScope)), now }
}

/** Uprawnienie panelu, które daje dany zakres MCP asystentowi w panelu. */
export const PANEL_PERMISSION_FOR: Record<McpScope, Permission> = {
  'mcp:odczyt': 'panel.podglad',
}

export function contextFromPanel(p: { db: PrismaClient; organizationId: string; userId: string; permissions: ReadonlySet<Permission> }, now: () => Date = () => new Date()): McpContext {
  const scopes = new Set(MCP_SCOPES.filter((s) => p.permissions.has(PANEL_PERMISSION_FOR[s])))
  return { db: p.db, organizationId: p.organizationId, source: { kind: 'panel', userId: p.userId }, scopes, now }
}

/** Klucz licznika limitów: osobny dla każdego klucza API i każdej osoby w panelu. */
export function limiterKey(ctx: McpContext): string {
  return ctx.source.kind === 'klucz' ? `k:${ctx.source.apiKeyId}` : `u:${ctx.organizationId}:${ctx.source.userId}`
}
