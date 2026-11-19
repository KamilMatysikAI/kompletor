// GET /api/v1/automaty (zakres `zamowienia:odczyt`): automatyczne akcje firmy i ostatnie wykonania
// (`?zamowienie=<id>` = tylko to zamówienie, `?limit=1..100`). Tylko odczyt. Opis: docs/api.md, sekcja „Automatyczne akcje: odczyt”.
import type { NextRequest } from 'next/server'
import { automatyFirmy, parametryAutomatow } from '@/lib/api/automaty'
import { requireApiKey } from '@/lib/api/klucze'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'zamowienia:odczyt')
  if (ctx instanceof Response) return ctx
  try {
    return apiJson(await automatyFirmy(ctx.db, parametryAutomatow(req.nextUrl.searchParams)))
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/automaty]', e instanceof Error ? e.message : e)
    return apiError(500, 'Błąd serwera')
  }
}
