// Pobranie raportu przeprowadzki z BaseLinkera: GET ?id=<przebieg z panelu>. Sesja i uprawnienie
// `ustawienia` (jak ekran Ustawienia → Przeprowadzka z BaseLinkera) przez requirePermissionApi, odczyt wyłącznie
// klientem firmy z sesji (RLS: cudzy przebieg = 404). Raport to ten sam Markdown co z polecenia przeprowadzki,
// bez danych klientów (zamówienia tylko jako id BL, kanał i liczby pozycji).
import { raportPrzebiegu } from '@/lib/przeprowadzka/z-panelu'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { NextResponse, type NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('ustawienia')
  if (ctx instanceof Response) return ctx
  const id = req.nextUrl.searchParams.get('id') ?? ''
  const r = await raportPrzebiegu(ctx.db, id)
  if (!r) return NextResponse.json({ error: 'Nie ma takiego raportu' }, { status: 404 })
  const dzien = toWarsaw(r.start).day
  const nazwa = `przeprowadzka-${r.tryb === 'ZAPIS' ? 'import' : 'proba'}-${dzien}.md`
  return new Response(r.markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nazwa}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
