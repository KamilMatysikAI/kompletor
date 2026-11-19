// POST /api/v1/obsluga/zamowienia-klienta (zakres `obsluga:odczyt`): zamówienia klienta o tym e-mailu albo telefonie,
// najnowsze pierwsze, bez danych osobowych w odpowiedzi; brak = 200 z pustą listą. Klucz API (requireApiKey), dane
// wyłącznie firmy klucza (RLS), osobny limit zapytań o klientów, wpis w dzienniku podglądów. Opis: docs/api.md.
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { obslugaLimit, parseObslugaWejscie, readObslugaBody, zamowieniaObslugi } from '@/lib/api/obsluga'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'
import { zamowieniaKontaktu } from '@/lib/klienci/obsluga'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'obsluga:odczyt')
  if (ctx instanceof Response) return ctx
  const limited = obslugaLimit(ctx.keyId)
  if (limited) return limited
  try {
    const q = parseObslugaWejscie(await readObslugaBody(req), 'zamowienia-klienta')
    const r = await zamowieniaKontaktu(ctx.db, { actorId: `api:${ctx.keyId}`, trasa: 'zamowienia-klienta', kontakt: q.kontakt, konta: q.konta, limit: q.limit, env: process.env })
    if (r.stan === 'BRAK_KLUCZA') return apiError(503, 'Wyszukiwanie po kliencie jest niedostępne na tej instalacji')
    return apiJson({ zamowienia: await zamowieniaObslugi(ctx.db, r.orderIds) })
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    // bez szczegółów w odpowiedzi i w logu (treść błędu bazy może zawierać dane z żądania)
    console.error('[api/v1/obsluga/zamowienia-klienta] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
