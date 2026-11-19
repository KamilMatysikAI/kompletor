// POST /api/druk/zlecenia/<id>/wynik — wynik druku od agenta. Idempotentne: pierwszy wynik wygrywa.
import { obsluzWynik } from '@/lib/druk/agent-api'
import { requireStationToken } from '@/lib/druk/tokeny'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await requireStationToken(req)
  if (ctx instanceof Response) return ctx
  return obsluzWynik(ctx, (await params).id, req)
}
