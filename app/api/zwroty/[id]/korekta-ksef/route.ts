// GET /api/zwroty/<id>/korekta-ksef — szkic korekty FA(3) zwrotu do pobrania. Sesja i `zwroty.korekty`
// (requirePermissionApi) oraz `klienci.dane` (XML niesie NIP, nazwę i adres nabywcy, jak PDF faktury), firma z sesji
// (RLS). Nabywca czytany jako osoba z sesji (ślad KLIENT_PODGLAD na nią, audyt bezpieczeństwa). Bez zapisu i bez wysyłki do KSeF.
// Problemy danych = 422 z listą kodów i ścieżek pól (bez wartości).
import type { NextRequest } from 'next/server'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { szkicKorektyKsef } from '@/lib/zwroty/korekta-ksef'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await requirePermissionApi('zwroty.korekty')
  if (ctx instanceof Response) return ctx
  if (!ctx.permissions.has('klienci.dane')) return Response.json({ error: 'Szkic korekty zawiera dane klienta: potrzebne uprawnienie do danych klienta' }, { status: 403 })
  const { id } = await params
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return new Response('Nie znaleziono', { status: 404 })
  const w = await szkicKorektyKsef(ctx.db, id, { actorId: ctx.user.id })
  if (!w.ok) {
    const lista = w.problemy.map((p) => `- ${p.pole ? `${p.pole}: ` : ''}${p.tekst}`).join('\n')
    return new Response(`${w.powod}${lista ? `\n${lista}` : ''}\n`, { status: 422, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } })
  }
  return new Response(w.xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': `attachment; filename="${w.nazwaPliku}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
}
