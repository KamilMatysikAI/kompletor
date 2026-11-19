// GET /api/v1/raporty/braki (zakres `raporty:odczyt`): produkty z otwartym brakiem i numery zamówień, które czekają na towar.
// `?sku=a,b` zawęża, `?limit=<1–100>` (domyślnie 50 produktów). Bez danych klientów. Klucz API (requireApiKey), RLS.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'
import { parseReportQuery, shortagesReport } from '@/lib/api/raporty'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'raporty:odczyt')
  if (ctx instanceof Response) return ctx
  try {
    return apiJson(await shortagesReport(ctx.db, parseReportQuery(req.nextUrl.searchParams)))
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/v1/raporty/braki] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
