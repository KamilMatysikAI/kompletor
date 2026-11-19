// GET /api/wydruki/faktura?z=<id zamówienia> — PDF wystawionej faktury bieżącej paczki z programu do faktur.
// Sesja i uprawnienie `zamowienia.faktury` (requirePermissionApi) oraz `klienci.dane` (faktura niesie dane nabywcy).
// Odczyt bez skutków ubocznych (GET wolno powtórzyć); plik nie jest zapisywany po naszej stronie. Żądanie z obcej
// strony (`Sec-Fetch-Site: cross-site`) dostaje 403.
import type { NextRequest } from 'next/server'
import { BladPdfFaktury, pdfFakturyZamowienia } from '@/lib/dokumenty/pdf'
import { appModeOf } from '@/lib/organizacje'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('zamowienia.faktury')
  if (ctx instanceof Response) return ctx
  if (!ctx.permissions.has('klienci.dane')) return Response.json({ error: 'Faktura zawiera dane klienta: potrzebne uprawnienie do danych klienta' }, { status: 403 })
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return Response.json({ error: 'Faktura tylko z panelu' }, { status: 403 })
  const id = req.nextUrl.searchParams.get('z') ?? ''
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return Response.json({ error: 'Nie ma takiego zamówienia' }, { status: 400 })
  try {
    const pdf = await pdfFakturyZamowienia(ctx.db, id, { secrets: { env: process.env, envFallback: appModeOf(process.env) === 'self-host' }, actorId: ctx.user.id })
    return new Response(new Uint8Array(pdf.bytes), {
      headers: { 'content-type': pdf.contentType, 'content-disposition': `inline; filename="${pdf.nazwaPliku}"`, 'cache-control': 'no-store' },
    })
  } catch (e) {
    if (e instanceof BladPdfFaktury) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}
