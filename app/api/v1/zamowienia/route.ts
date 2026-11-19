// /api/v1/zamowienia. Klucz API (requireApiKey), dane wyłącznie firmy klucza (RLS). Opis: docs/api.md.
//  GET  (zakres `zamowienia:odczyt`): zamówienia zmienione od chwili, stronami po kursorze, okno do 14 dni (BotKlienta).
//  POST (zakres `zamowienia:zapis`): treść z polem `kanal` = kształt ogólny (RECZNE albo EASYTOOLS, klient,
//       dostawa z punktem, przewoźnik, źródło; lib/api/zapis-ogolny.ts + lib/zamowienia/ogolne.ts); bez `kanal` = zamówienie EasyTools z produktami z katalogu, przez ingestOrder; powtórzone
//       wywołanie z tą samą treścią daje to samo zamówienie (200, DUPLIKAT), pierwsze 201; ten sam numer z inną
//       treścią = 409 bez zmian (API nie edytuje przyjętych zamówień).
import type { NextRequest } from 'next/server'
import { requireApiKey } from '@/lib/api/klucze'
import { ApiInputError, apiError, apiJson, inputErrorResponse } from '@/lib/api/odpowiedzi'
import { listChangedOrders, parseOrderListQuery } from '@/lib/api/zamowienia'
import { parseEasyToolsOrder, readJsonBody, submitEasyToolsOrder } from '@/lib/api/zapis'
import { isGeneralShape, parseGeneralOrder } from '@/lib/api/zapis-ogolny'
import { przyjmijZamowienie } from '@/lib/zamowienia/ogolne'
import { ValidationError } from '@/lib/rdzen/zamowienia'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'zamowienia:odczyt')
  if (ctx instanceof Response) return ctx
  try {
    return apiJson(await listChangedOrders(ctx.db, parseOrderListQuery(req.nextUrl.searchParams, new Date())))
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    console.error('[api/v1/zamowienia] błąd odczytu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const ctx = await requireApiKey(req, 'zamowienia:zapis')
  if (ctx instanceof Response) return ctx
  try {
    const body = await readJsonBody(req)
    if (isGeneralShape(body)) {
      const r = await przyjmijZamowienie(ctx.db, parseGeneralOrder(body), { source: 'api', actorId: `api:${ctx.keyId}`, env: process.env })
      return apiJson(r.body, r.status)
    }
    const r = await submitEasyToolsOrder(ctx.db, parseEasyToolsOrder(body))
    return apiJson(r.body, r.status)
  } catch (e) {
    if (e instanceof ApiInputError) return inputErrorResponse(e)
    if (e instanceof ValidationError) return apiError(422, `Zamówienie odrzucone: ${e.message}`)
    // bez szczegółów w odpowiedzi i w logu (treść błędu bazy może zawierać dane z żądania)
    console.error('[api/v1/zamowienia] błąd zapisu', (e as Error)?.name)
    return apiError(500, 'Błąd serwera')
  }
}
