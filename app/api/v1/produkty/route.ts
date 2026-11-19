// GET /api/v1/produkty (zakres `produkty:odczyt`): katalog firmy po SKU, z frazą, rodzajem i kursorem.
// Klucz API (requireApiKey), dane wyłącznie firmy klucza (RLS). Opis: docs/api.md, sekcja „Rozszerzenie: produkty, statusy, raporty, filtry listy zamówień”.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'
import { parseProductSearch, searchProducts } from '@/lib/api/produkty'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'produkty:odczyt')
  if (ctx instanceof Response) return ctx
  try {
    return apiJson(await searchProducts(ctx.db, parseProductSearch(req.nextUrl.searchParams)))
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/v1/produkty] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
