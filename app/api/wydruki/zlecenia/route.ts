// POST /api/wydruki/zlecenia — „Drukuj” z panelu na stanowisko druku. Treść JSON:
// { typ: 'karta' | 'lista' | 'etykieta', z: <id zamówień>, stanowisko: <id stanowiska>, klucz: <losowy na jedno kliknięcie> }.
// Sesja i uprawnienie jak dotychczasowe wydruki: karty i etykieta próbna `pakowanie.stanowisko`, lista `panel.podglad`
// (requirePermissionApi; brak = 404). Żądanie z obcej strony (`Sec-Fetch-Site`) = 403, jak w trasie kart.
// Podwójny klik (ten sam klucz) zwraca istniejące zlecenie bez drugiego wydruku kart (lib/druk/zlecenia.ts).
import type { NextRequest } from 'next/server'
import { czytajJson } from '@/lib/druk/agent-api'
import { parsujZlecenieZPanelu, zlecZPanelu } from '@/lib/druk/panel'
import { BladDruku } from '@/lib/druk/zlecenia'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('panel.podglad')
  if (ctx instanceof Response) return ctx
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return Response.json({ error: 'Druk tylko z panelu' }, { status: 403 })
  const tresc = await czytajJson(req)
  if (!tresc.ok) return tresc.odpowiedz
  const z = parsujZlecenieZPanelu(tresc.json)
  if ('blad' in z) return Response.json({ error: z.blad }, { status: 400 })
  if (z.typ !== 'lista' && !ctx.permissions.has('pakowanie.stanowisko')) return Response.json({ error: 'Nie znaleziono' }, { status: 404 })
  try {
    return Response.json(await zlecZPanelu(ctx.db, { userId: ctx.user.id, nazwa: ctx.user.name }, z), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof BladDruku) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}
