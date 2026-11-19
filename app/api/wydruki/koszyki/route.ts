// Kody koszyków firmy do naklejenia: GET, PDF A4. Sesja i `pakowanie.stanowisko` przez requirePermissionApi
// (401/404 JSON jak pozostałe wydruki); koszyki wyłącznie przez klienta firmy z sesji (RLS).
import { NextResponse } from 'next/server'
import { listaKoszykow } from '@/lib/koszyki/koszyki'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { kodyKoszykow } from '@/lib/wydruki/koszyki'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const ctx = await requirePermissionApi('pakowanie.stanowisko')
  if (ctx instanceof Response) return ctx
  const koszyki = await listaKoszykow(ctx.db)
  if (!koszyki.length) return NextResponse.json({ error: 'Firma nie ma jeszcze koszyków' }, { status: 404 })
  const pdf = await kodyKoszykow(koszyki, { firma: ctx.organization.name })
  return new Response(new Uint8Array(pdf), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="kody-koszykow.pdf"', 'Cache-Control': 'private, no-store' },
  })
}
