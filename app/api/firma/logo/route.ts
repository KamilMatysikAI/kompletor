// GET /api/firma/logo?w=druk — logo firmy z sesji: PNG do panelu, `w=druk` JPEG do wydruków. Sesja
// i `panel.podglad` (requirePermissionApi); firma z sesji (RLS). Plik zapisany od nowa przez sharp (lib/firma/logo.ts),
// bez metadanych i treści z przeglądarki. Brak logo = 404.
import type { NextRequest } from 'next/server'
import { plikLogo } from '@/lib/firma/logo'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('panel.podglad')
  if (ctx instanceof Response) return ctx
  const f = await plikLogo(ctx.db, req.nextUrl.searchParams.get('w') === 'druk' ? 'druk' : 'ekran')
  if (!f) return new Response('Nie znaleziono', { status: 404 })
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'content-type': f.mime,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=3600',
    },
  })
}
