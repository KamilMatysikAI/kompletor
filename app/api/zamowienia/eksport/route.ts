// Eksport listy zamówień (CSV, L3 z luk wobec BL; XLSX): GET ?z=<id,id…> (zaznaczone) albo z parametrami
// filtrów listy (bez `z`: wszystkie pasujące, najwyżej EKSPORT_MAKS; z `z` najwyżej EKSPORT_ZAZNACZONE_MAKS); `format=xlsx`
// daje arkusz Excela z tymi samymi kolumnami (kwota jako liczba, data jako data), bez niego CSV. Sesja i `panel.podglad`
// przez requirePermissionApi, dane wyłącznie przez klienta firmy z sesji (RLS). Bez danych osobowych klientów: numer,
// kanał, daty, status, przewoźnik, płatność, kwota, faktura, numer nadania, kraj i pozycje. CSV: separator „;” i BOM,
// żeby Excel w polskich ustawieniach otworzył plik od razu z polskimi znakami. Filtry razem z wyszukiwaniem
// z listy (`qz`, stare `kh`/`kf`) przez `filtryZSzukaniem`, więc plik liczy ten sam zbiór co ekran.
import { filtryZSzukaniem } from '@/lib/panel/szukaj-lista'
import { idPasujacych } from '@/lib/panel/zamowienia-lista'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { XLSX_TYP, zapiszXlsx } from '@/lib/arkusz/xlsx'
import { dataCsv, EKSPORT_MAKS, EKSPORT_ZAZNACZONE_MAKS, poleCsv } from '@/lib/zamowienia/eksport-csv'
import { KOLUMNY_EKSPORTU, wierszeEksportu } from '@/lib/zamowienia/eksport-lista'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { NextResponse, type NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const ID_RE = /^[a-z0-9]{1,40}$/i

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('panel.podglad')
  if (ctx instanceof Response) return ctx
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries())
  const { f } = await filtryZSzukaniem(sp, { db: ctx.db, actorId: ctx.user.id, organizationId: ctx.organization.organizationId, canKlient: ctx.permissions.has('klienci.dane') })
  const xlsx = req.nextUrl.searchParams.get('format') === 'xlsx'
  const z = req.nextUrl.searchParams.get('z')
  if (z) {
    const ids = [...new Set(z.split(',').map((x) => x.trim()).filter((x) => ID_RE.test(x)))]
    if (ids.length > EKSPORT_ZAZNACZONE_MAKS) return NextResponse.json({ error: `Najwyżej ${EKSPORT_ZAZNACZONE_MAKS} zaznaczonych zamówień w jednym pliku: przy większej liczbie eksportuj wszystkie pasujące do filtrów` }, { status: 400 })
    f.ids = ids
    f.widok = 'wszystkie'
  } else {
    const r = await idPasujacych(ctx.db, f, EKSPORT_MAKS + 1)
    if (r.razem > EKSPORT_MAKS) return NextResponse.json({ error: `Pasuje ${r.razem} zamówień, najwyżej ${EKSPORT_MAKS} w jednym pliku: zawęź filtry` }, { status: 400 })
  }
  const wiersze = await wierszeEksportu(ctx.db, f)
  const dzien = toWarsaw(new Date()).day
  if (xlsx) {
    return new Response(new Uint8Array(zapiszXlsx([{ nazwa: 'Zamówienia', kolumny: KOLUMNY_EKSPORTU, wiersze }])), {
      headers: { 'Content-Type': XLSX_TYP, 'Content-Disposition': `attachment; filename="zamowienia-${dzien}.xlsx"`, 'Cache-Control': 'private, no-store' },
    })
  }
  const out = [KOLUMNY_EKSPORTU.map((k) => poleCsv(k.naglowek)).join(';')]
  for (const w of wiersze) {
    out.push(
      w
        .map((v, i) => {
          if (v instanceof Date) return poleCsv(dataCsv(v))
          if (typeof v === 'number' && KOLUMNY_EKSPORTU[i]!.typ === 'kwota') return poleCsv(v.toFixed(2).replace('.', ','))
          return poleCsv(v)
        })
        .join(';'),
    )
  }
  return new Response(`﻿${out.join('\r\n')}\r\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="zamowienia-${dzien}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
