// GET /api/v1/stany: stany produktów dla systemów zewnętrznych (hurt-demo). Klucz API z zakresem
// `stany:odczyt` (requireApiKey); dane wyłącznie firmy klucza (RLS). Opis i przykłady: docs/api.md.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'
import { parseStockQuery, readStock } from '@/lib/api/stany'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'stany:odczyt')
  if (ctx instanceof Response) return ctx
  try {
    return apiJson(await readStock(ctx.db, parseStockQuery(req.nextUrl.searchParams)))
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/v1/stany] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
