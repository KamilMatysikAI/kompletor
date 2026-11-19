// /api/mcp: serwer MCP Kompletora dla agentów AI (Streamable HTTP, bezstanowo). Bramka: klucz API agenta
// (`Authorization: Bearer kmp_…`, zakres `mcp:odczyt`) w lib/mcp/http.ts — nie sesja panelu i nie Basic Auth stagingu
// (wyjątek w proxy.ts). GET i DELETE = 405 (bez strumienia GET i bez sesji). Opis: docs/mcp.md.
import { handleMcpHttp, methodNotAllowed } from '@/lib/mcp/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  return handleMcpHttp(req)
}

export async function GET(): Promise<Response> {
  return methodNotAllowed()
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed()
}
