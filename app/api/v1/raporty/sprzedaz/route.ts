// GET /api/v1/raporty/sprzedaz (zakres `raporty:odczyt`): sprzedaż wg okresu, konta kanału i produktu z marżą
// z ceny zakupu i porównaniem z poprzednim okresem — ten sam kształt co ekran „Raporty” w panelu. Same agregaty, bez danych
// klientów. Klucz API (requireApiKey), dane firmy klucza (RLS). Opis: docs/api.md, reguły liczenia: docs/raporty.md.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'
import { parseZapytanieSprzedazy, raportSprzedazy } from '@/lib/api/raporty-sprzedaz'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'raporty:odczyt')
  if (ctx instanceof Response) return ctx
  try {
    return apiJson(await raportSprzedazy(ctx.db, parseZapytanieSprzedazy(req.nextUrl.searchParams)))
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/v1/raporty/sprzedaz] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
