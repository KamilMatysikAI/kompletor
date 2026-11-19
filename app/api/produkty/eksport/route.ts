// GET /api/produkty/eksport — katalog produktów firmy z sesji jako CSV. Sesja i `produkty.dodawanie`
// (requirePermissionApi), dane tylko przez klienta firmy (RLS). Bez danych klientów. Separator „;” i BOM (Excel PL).
import { eksportCsv } from '@/lib/produkty/csv'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  // plik ma ceny zakupu całego katalogu: to samo uprawnienie co ekran /produkty/csv
  const ctx = await requirePermissionApi('produkty.dodawanie')
  if (ctx instanceof Response) return ctx
  const { tekst } = await eksportCsv(ctx.db)
  const dzien = new Date().toISOString().slice(0, 10)
  return new Response(tekst, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="produkty-${dzien}.csv"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
