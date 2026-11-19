// GET /api/v1/raporty/dzien (zakres `raporty:odczyt`): liczby dnia jak pulpit „Dziś” — sprzedaż, praca
// magazynu i biura, wysłane dziś. Same liczby. Klucz API (requireApiKey), dane firmy klucza (RLS). Opis: docs/api.md.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { apiError, apiJson } from '@/lib/api/odpowiedzi'
import { dayReport } from '@/lib/api/raporty'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'raporty:odczyt')
  if (ctx instanceof Response) return ctx
  for (const k of req.nextUrl.searchParams.keys()) return apiError(400, `Nieznany parametr ${k}`, { pole: k })
  try {
    return apiJson(await dayReport(ctx.db))
  } catch (e) {
    console.error('[api/v1/raporty/dzien] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
