// GET /api/produkty/feed-bez-dopasowania?przebieg=<id> — pozycje feedu produktowego bez dopasowania z przebiegu
// „Zdjęcia z feedu” jako CSV. Sesja i `produkty.dodawanie` (requirePermissionApi), dane tylko przez klienta
// firmy (RLS). Bez danych klientów: identyfikatory, SKU, EAN i nazwy produktów z publicznego feedu sklepu.
import { csvBezDopasowania, FEED_RUN_KIND, type WynikPrzebieguFeedu } from '@/lib/produkty/zdjecia-feed'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const ctx = await requirePermissionApi('produkty.dodawanie')
  if (ctx instanceof Response) return ctx
  const id = new URL(req.url).searchParams.get('przebieg') ?? ''
  const run = /^[a-z0-9]{10,40}$/.test(id) ? await ctx.db.importRun.findFirst({ where: { id, kind: FEED_RUN_KIND }, select: { stats: true, startedAt: true } }) : null
  if (!run) return new Response('Nie ma takiego przebiegu', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  const lista = run.stats && typeof run.stats === 'object' && !Array.isArray(run.stats) ? ((run.stats as unknown as WynikPrzebieguFeedu).lista ?? []) : []
  const dzien = run.startedAt.toISOString().slice(0, 10)
  return new Response(csvBezDopasowania(Array.isArray(lista) ? lista : []), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="feed-bez-dopasowania-${dzien}.csv"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
