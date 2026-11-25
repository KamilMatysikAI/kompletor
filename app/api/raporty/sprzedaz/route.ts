// Eksport XLSX raportu sprzedaży z ekranu „Raporty”: GET z tymi samymi parametrami co ekran (od, do, grupuj,
// konto; porownaj, porownaj_od, porownaj_do jak w lib/api/raporty-porownanie.ts). Sesja i `raporty.sprzedaz` przez requirePermissionApi (jak ekran; Magazyn domyślnie bez),
// dane wyłącznie przez klienta firmy z sesji (RLS). Same agregaty: bez danych klientów. Zakres najwyżej 366 dni, liczy baza (GROUPING SETS),
// więc plik powstaje od razu, bez kolejki w tle (pomiar: docs/raporty.md).
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { ApiInputError } from '@/lib/api/odpowiedzi'
import { raportSprzedazy, SPRZEDAZ_MAKS_PRODUKTOW, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { XLSX_TYP, zapiszXlsx } from '@/lib/arkusz/xlsx'
import { accounts, accountKey } from '@/lib/panel/dane'
import { arkuszeRaportuSprzedazy } from '@/lib/arkusz/raport-sprzedazy'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('raporty.sprzedaz')
  if (ctx instanceof Response) return ctx
  const sp = req.nextUrl.searchParams
  let q
  try {
    q = zapytanieSprzedazy({ od: sp.get('od'), do: sp.get('do'), grupuj: sp.get('grupuj'), konto: sp.get('konto'), produktow: SPRZEDAZ_MAKS_PRODUKTOW, porownaj: sp.get('porownaj'), porownajOd: sp.get('porownaj_od'), porownajDo: sp.get('porownaj_do') })
  } catch (e) {
    if (e instanceof ApiInputError) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }
  const [r, accs] = await Promise.all([raportSprzedazy(ctx.db, q), accounts(ctx.db)])
  const opisKonta = q.konto ? (accs.find((a) => accountKey(a.channel, a.channelAccountId) === q.konto)?.name ?? q.konto) : 'wszystkie kanały'
  const plik = zapiszXlsx(arkuszeRaportuSprzedazy(r, opisKonta))
  return new Response(new Uint8Array(plik), {
    headers: {
      'Content-Type': XLSX_TYP,
      'Content-Disposition': `attachment; filename="sprzedaz-${q.od}-${q.do}.xlsx"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
