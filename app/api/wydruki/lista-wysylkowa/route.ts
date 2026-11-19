// Lista wysyłkowa PDF dla zaznaczonych zamówień kolejki pakowania: GET ?z=<id,id…>, najwyżej 200.
// Najpierw sesja i `panel.podglad` przez requirePermissionApi (jak /api/wydruki/karty): odpowiedź
// 401/404 zamiast przekierowania; dane wyłącznie przez klienta firmy z sesji (RLS: cudze id po prostu nie istnieją).
// link otwiera nową kartę, więc błąd dla przeglądarki (Accept z text/html) to strona HTML po polsku,
// a dla `fetch` JSON `{ error }` jak dotąd (lib/panel/blad-wydruku.ts).
import type { NextRequest } from 'next/server'
import { parseOrderIds, shippingListData, SHIPPING_LIST_LIMIT } from '@/lib/pakowanie/dane'
import { odmowaDostepu, odpowiedzBleduWydruku } from '@/lib/panel/blad-wydruku'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { listaWysylkowa } from '@/lib/wydruki/lista-wysylkowa'

export const dynamic = 'force-dynamic'

const TYTUL = 'Nie udało się wydrukować listy wysyłkowej'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('panel.podglad')
  if (ctx instanceof Response) return odmowaDostepu(req, ctx, TYTUL, 'wydrukuj listę')
  const { ids, tooMany } = parseOrderIds(req.nextUrl.searchParams.get('z'))
  if (tooMany) {
    return odpowiedzBleduWydruku(req, {
      status: 400,
      tytul: TYTUL,
      komunikat: `Na jednej liście wysyłkowej mieści się najwyżej ${SHIPPING_LIST_LIMIT} zamówień. Zaznacz mniej i wydrukuj w kilku częściach.`,
    })
  }
  const now = new Date()
  const dane = await shippingListData(ctx.db, ids, { now, drukujacy: ctx.user.name })
  if (!dane) {
    return odpowiedzBleduWydruku(req, {
      status: 404,
      tytul: TYTUL,
      komunikat: 'Nie znaleziono zaznaczonych zamówień (mogły zostać połączone albo usunięte). Odśwież listę, zaznacz zamówienia i wydrukuj ponownie.',
    })
  }
  const pdf = await listaWysylkowa(dane)
  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="lista-wysylkowa-${toWarsaw(now).day}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
