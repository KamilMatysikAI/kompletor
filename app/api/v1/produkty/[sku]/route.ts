// GET /api/v1/produkty/<sku> (zakres `produkty:odczyt`): produkt po SKU ze stanem, ofertami i składnikami
// zestawu. Brak = 404. Klucz API (requireApiKey), dane wyłącznie firmy klucza (RLS). Opis: docs/api.md.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'
import { parseSku, productBySku } from '@/lib/api/produkty'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ sku: string }> }): Promise<Response> {
  const ctx = await requireApiKey(req, 'produkty:odczyt')
  if (ctx instanceof Response) return ctx
  try {
    for (const k of req.nextUrl.searchParams.keys()) throw new ApiInputError(`Nieznany parametr ${k}`, k)
    const { sku } = await params
    const p = await productBySku(ctx.db, parseSku(sku))
    if (!p) return apiError(404, 'Nie znaleziono produktu o tym SKU')
    return apiJson({ produkt: p })
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/v1/produkty/sku] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
