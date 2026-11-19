// GET /api/produkty/zdjecia/<id>?w=m|p — zdjęcie produktu firmy z sesji. `w` brak = pełne (webp do 1600 px),
// `m` = miniatura 160 px, `p` = JPEG do wydruku. Sesja i `panel.podglad` (requirePermissionApi); obca firma: 404 (RLS).
// Bajty z bazy (lib/produkty/zdjecia.ts), zapisane od nowa przez sharp, więc bez metadanych i treści
// z przeglądarki. Zawartość pod danym id i wariantem nigdy się nie zmienia: przeglądarka trzyma ją w pamięci podręcznej
// (immutable), a ponowne pytanie z If-None-Match dostaje 304 po samym sprawdzeniu, że zdjęcie jest w produkcie.
import type { NextRequest } from 'next/server'
import { BrakPlikuZdjecia, plikZdjecia, type Wariant } from '@/lib/produkty/zdjecia'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

const CACHE = 'private, max-age=31536000, immutable'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await requirePermissionApi('panel.podglad')
  if (ctx instanceof Response) return ctx
  const { id } = await params
  const w = req.nextUrl.searchParams.get('w')
  const wariant: Wariant = w === 'm' ? 'm' : w === 'p' ? 'p' : 'o'
  const etag = `"${id}-${wariant}"`
  if (req.headers.get('if-none-match') === etag && /^[a-z0-9]{10,40}$/.test(id)) {
    const jest = await ctx.db.productImage.findUnique({ where: { id }, select: { id: true } })
    if (jest) return new Response(null, { status: 304, headers: { etag, 'cache-control': CACHE } })
  }
  let f: Awaited<ReturnType<typeof plikZdjecia>>
  try {
    f = await plikZdjecia(ctx.db, id, wariant)
  } catch (e) {
    // zdjęcie jest w produkcie, a bajtów nie ma w bazie ani na dysku tego kontenera — opis, nie cichy 404
    if (!(e instanceof BrakPlikuZdjecia)) throw e
    console.error(`[zdjecia] ${e.imageId}: ${e.message}`)
    return new Response(e.message, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
  }
  if (!f) return new Response('Nie znaleziono', { status: 404 })
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'content-type': f.mime,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': CACHE,
      etag,
    },
  })
}
