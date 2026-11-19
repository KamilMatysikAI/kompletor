// POST /api/druk/stan — raport stanu drukarek od agenta. Czas raportu = czas serwera.
import { obsluzStan } from '@/lib/druk/agent-api'
import { requireStationToken } from '@/lib/druk/tokeny'

export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const ctx = await requireStationToken(req)
  if (ctx instanceof Response) return ctx
  return obsluzStan(ctx, req)
}
