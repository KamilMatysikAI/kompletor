// POST /api/v1/obsluga/zamowienie (zakres `obsluga:odczyt`): zamówienie o tym numerze (numer sklepu, numer widoczny
// w kanale albo numer BL), jeśli e-mail albo telefon zamówienia pasuje do podanego. Brak numeru i niezgodny kontakt =
// ten sam 404 tą samą ścieżką (jedno zapytanie), żeby nie dało się zgadywać numerów. Klucz API (requireApiKey), dane
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
    const q = parseObslugaWejscie(await readObslugaBody(req), 'zamowienie')
    const r = await zamowieniaKontaktu(ctx.db, { actorId: `api:${ctx.keyId}`, trasa: 'zamowienie', kontakt: q.kontakt, numer: q.numer, konta: q.konta, limit: q.limit, env: process.env })
    if (r.stan === 'BRAK_KLUCZA') return apiError(503, 'Wyszukiwanie po kliencie jest niedostępne na tej instalacji')
    const found = await zamowieniaObslugi(ctx.db, r.orderIds)
    if (!found.length) return apiError(404, 'Nie znaleziono zamówienia')
    return apiJson({ zamowienia: found })
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/v1/obsluga/zamowienie] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
