// Protokół odbioru zaznaczonych przesyłek: GET ?z=<id,id…>, najwyżej MAKS_PLIKU. Od przewoźnika, gdy
// wszystkie są z jednego konta przewoźnika, który wydaje protokół (DPD, przy włączonym nadawaniu); inaczej własna lista
// przekazanych paczek z miejscem na podpis kuriera (lib/wysylka/protokol.ts). Sesja i `pakowanie.stanowisko`.
import { type NextRequest } from 'next/server'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { idPrzesylekZ } from '@/lib/wysylka/lista'
import { MAKS_PLIKU } from '@/lib/wysylka/masowo-progi'
import { BladProtokolu, protokolPrzesylek } from '@/lib/wysylka/protokol'

export const dynamic = 'force-dynamic'

const tekst = (t: string, status: number) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } })

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('pakowanie.stanowisko')
  if (ctx instanceof Response) return ctx
  const { ids, zaDuzo } = idPrzesylekZ(req.nextUrl.searchParams.get('z'), MAKS_PLIKU)
  if (zaDuzo) return tekst(`Najwyżej ${MAKS_PLIKU} przesyłek w jednym protokole: zaznacz mniej.`, 400)
  if (!ids.length) return tekst('Nie zaznaczono żadnej przesyłki.', 400)
  try {
    const p = await protokolPrzesylek(ctx.db, ids, { nazwa: ctx.user.name })
    return new Response(new Uint8Array(p.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="protokol-${toWarsaw(new Date()).day}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Protokol-Zrodlo': p.zrodlo,
        'X-Protokol-Pominiete': String(p.pominiete.length),
      },
    })
  } catch (e) {
    if (e instanceof BladProtokolu) return tekst(e.message, 409)
    throw e
  }
}
