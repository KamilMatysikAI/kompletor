// GET /api/zwroty/<id>/zdjecie — zdjęcie zwrotu albo reklamacji. Sesja i `zwroty.przyjecie`
// (requirePermissionApi; zdjęcie paczki bywa z etykietą adresową klienta, więc widzi je tylko ten,
// kto przyjmuje zwroty, nie każdy z podglądem panelu); firma z sesji (RLS), więc zwrot innej firmy = 404. JPEG zapisany od nowa przez sharp
// (lib/zwroty/zdjecie.ts), bez metadanych i treści z przeglądarki.
import type { NextRequest } from 'next/server'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { zdjecieZwrotu } from '@/lib/zwroty/zdjecie'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await requirePermissionApi('zwroty.przyjecie')
  if (ctx instanceof Response) return ctx
  const { id } = await params
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return new Response('Nie znaleziono', { status: 404 })
  const z = await zdjecieZwrotu(ctx.db, id)
  if (!z) return new Response('Nie znaleziono', { status: 404 })
  return new Response(new Uint8Array(z.content), {
    headers: {
      'content-type': z.mime,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=600',
    },
  })
}
