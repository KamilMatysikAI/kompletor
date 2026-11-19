// GET /api/wydruki/zlecenia/<id> — stan zlecenia druku do krótkiego odpytywania po „Drukuj”.
// Sesja i `panel.podglad`; klient firmy z sesji (RLS: cudze id = 404).
import { statusZleceniaLubNull } from '@/lib/druk/panel'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await requirePermissionApi('panel.podglad')
  if (ctx instanceof Response) return ctx
  const id = (await params).id
  const s = /^[A-Za-z0-9_-]{1,100}$/.test(id) ? await statusZleceniaLubNull(ctx.db, id) : null
  if (!s) return Response.json({ error: 'Nie znaleziono' }, { status: 404 })
  return Response.json({ zlecenie: s }, { headers: { 'Cache-Control': 'no-store' } })
}
