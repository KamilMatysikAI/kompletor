// GET /api/druk/pliki/<id> — plik zlecenia dla agenta: tylko zlecenie tego stanowiska, no-store, bez
// przekierowań; cudze id = 404.
import { obsluzPlik } from '@/lib/druk/agent-api'
import { requireStationToken } from '@/lib/druk/tokeny'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await requireStationToken(req)
  if (ctx instanceof Response) return ctx
  return obsluzPlik(ctx, (await params).id)
}
