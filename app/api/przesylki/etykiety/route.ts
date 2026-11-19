// Etykiety zaznaczonych przesyłek w jednym PDF (lista przesyłek): GET ?z=<id,id…>, najwyżej MAKS_PLIKU.
// Sesja i `pakowanie.stanowisko` (etykieta ma adres odbiorcy); dane przez klienta firmy z sesji (RLS). Etykiety
// z zapisanych plików, bez pytania przewoźnika. Pominięte z powodem na ostatniej stronie pliku. Jedna przesyłka
// z etykietą ZPL = plik ZPL do pobrania (drukarka termiczna), żeby przycisk „Etykieta” w wierszu działał dla każdej.
import { type NextRequest } from 'next/server'
import { BladDruku } from '@/lib/druk/zlecenia'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { etykietaPrzesylkiPoId } from '@/lib/wysylka/etykieta-przewoznika'
import { etykietyJednymPlikiem, powodBlokadyEtykiety } from '@/lib/wysylka/etykiety-zbiorcze'
import { idPrzesylekZ } from '@/lib/wysylka/lista'
import { MAKS_PLIKU } from '@/lib/wysylka/masowo-progi'

export const dynamic = 'force-dynamic'

const tekst = (t: string, status: number) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } })

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('pakowanie.stanowisko')
  if (ctx instanceof Response) return ctx
  const { ids, zaDuzo } = idPrzesylekZ(req.nextUrl.searchParams.get('z'), MAKS_PLIKU)
  if (zaDuzo) return tekst(`Najwyżej ${MAKS_PLIKU} etykiet w jednym pliku: zaznacz mniej przesyłek.`, 400)
  if (!ids.length) return tekst('Nie zaznaczono żadnej przesyłki.', 400)
  const now = new Date()
  const dzien = toWarsaw(now).day
  if (ids.length === 1) {
    // ta sama bramka konta co w pliku zbiorczym: adres wpisany ręcznie nie omija wyłącznika
    const blokada = await powodBlokadyEtykiety(ctx.db, ids[0]!)
    if (blokada) return tekst(blokada, 409)
    try {
      const e = await etykietaPrzesylkiPoId(ctx.db, ids[0]!)
      if (e.zpl) return new Response(new Uint8Array(e.zpl), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="etykieta-${dzien}.zpl"`, 'Cache-Control': 'private, no-store' } })
    } catch (e) {
      if (e instanceof BladDruku) return tekst(e.message, e.status)
      throw e
    }
  }
  const w = await etykietyJednymPlikiem(ctx.db, ids, { now })
  if (!w.pdf) return tekst('Brak etykiet do pobrania.', 404)
  return new Response(new Uint8Array(w.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="etykiety-${dzien}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Etykiety-Dolaczone': String(w.dolaczone),
      'X-Etykiety-Pominiete': String(w.pominiete.length),
    },
  })
}
