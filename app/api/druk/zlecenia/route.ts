// GET /api/druk/zlecenia?stanowisko=<kod> — zlecenia dla agenta druku (kontrakt: agent-druku/README.md,
// sekcja 4). Bramka: token stanowiska (requireStationToken), bez sesji panelu i bez Basic Auth (proxy.ts).
import { obsluzListeZlecen } from '@/lib/druk/agent-api'
import { requireStationToken } from '@/lib/druk/tokeny'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const ctx = await requireStationToken(req)
  if (ctx instanceof Response) return ctx
  return obsluzListeZlecen(ctx, req)
}
