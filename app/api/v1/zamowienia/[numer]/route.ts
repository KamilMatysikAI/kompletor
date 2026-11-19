// GET /api/v1/zamowienia/<numer> (zakres `zamowienia:odczyt`): zamówienia o numerze sklepu
// (Order.externalId) albo numerze BL; kilka kont kanału = wszystkie trafienia, `?kanal=&konto=` zawęża. Brak = 404.
// Klucz API (requireApiKey), dane wyłącznie firmy klucza (RLS). Opis: docs/api.md.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'
import { ordersByNumber, parseOrderNumberQuery } from '@/lib/api/zamowienia'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ numer: string }> }): Promise<Response> {
  const ctx = await requireApiKey(req, 'zamowienia:odczyt')
  if (ctx instanceof Response) return ctx
  try {
    const { numer } = await params
    const found = await ordersByNumber(ctx.db, parseOrderNumberQuery(numer, req.nextUrl.searchParams))
    if (!found.length) return apiError(404, 'Nie znaleziono zamówienia o tym numerze')
    return apiJson({ zamowienia: found })
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/v1/zamowienia/numer] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
