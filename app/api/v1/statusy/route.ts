// GET /api/v1/statusy (zakres `zamowienia:odczyt`): słownik statusów zamówień i płatności z opisami.
// Klucz API (requireApiKey). Opis: docs/api.md, sekcja „Rozszerzenie: produkty, statusy, raporty, filtry listy zamówień”.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { apiError, apiJson } from '@/lib/api/odpowiedzi'
import { statusDictionaryFirmy } from '@/lib/api/statusy'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'zamowienia:odczyt')
  if (ctx instanceof Response) return ctx
  for (const k of req.nextUrl.searchParams.keys()) return apiError(400, `Nieznany parametr ${k}`, { pole: k })
  return apiJson(await statusDictionaryFirmy(ctx.db))
}
