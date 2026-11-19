// GET /api/wydruki/program — paczka programu druku (Kompletor-Druk-<wersja>-win-x64.zip) z katalogu
// AGENT_DRUKU_KATALOG (lib/druk/paczka.ts): przycisk „Pobierz program (Windows)” w Ustawienia → Wysyłka i druk → Druk.
// Sesja i uprawnienie `ustawienia`, jak ekran Druk (requirePermissionApi: 401 bez sesji, 404 bez uprawnienia).
// Nazwy pliku nie ma w żądaniu: trasa bierze jedyną albo najnowszą paczkę według wzoru. Plik idzie strumieniem
// (ok. 40 MB, bez wczytywania do pamięci), `Cache-Control: no-store`. Brak zmiennej, katalogu albo pliku = 404.
// Przeglądarka (Accept z text/html) dostaje błąd jako stronę po polsku, `fetch` — JSON `{ error }`.
import { open, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { komunikatDostepu, odpowiedzBleduWydruku } from '@/lib/panel/blad-wydruku'
import { BRAK_PACZKI, paczkaProgramu } from '@/lib/druk/paczka'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

const TYTUL = 'Nie udało się pobrać programu druku'
const POWROT = { href: '/ustawienia/druk', etykieta: 'Wróć do ustawień druku' }

export async function GET(req: Request): Promise<Response> {
  const ctx = await requirePermissionApi('ustawienia')
  if (ctx instanceof Response) {
    const komunikat = ctx.status === 404 ? 'Nie znaleziono.' : komunikatDostepu(ctx.status, 'pobierz program')
    const powrot = ctx.status === 401 ? { href: '/logowanie', etykieta: 'Zaloguj się' } : POWROT
    return odpowiedzBleduWydruku(req, { status: ctx.status, tytul: TYTUL, komunikat, powrot })
  }
  const paczka = await paczkaProgramu()
  if (!paczka) return odpowiedzBleduWydruku(req, { status: 404, tytul: TYTUL, komunikat: BRAK_PACZKI, powrot: POWROT })
  // rozmiar z otwartego pliku, nie z wcześniejszego odczytu katalogu: podmiana pliku w międzyczasie nie psuje Content-Length
  let uchwyt: FileHandle | undefined
  try {
    uchwyt = await open(paczka.sciezka, 'r')
    const s = await uchwyt.stat()
    if (!s.isFile()) throw new Error('nie plik')
    const strumien = uchwyt.createReadStream({ autoClose: true })
    return new Response(Readable.toWeb(strumien) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${paczka.nazwa}"`,
        'Content-Length': String(s.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    await uchwyt?.close().catch(() => {})
    return odpowiedzBleduWydruku(req, { status: 404, tytul: TYTUL, komunikat: BRAK_PACZKI, powrot: POWROT })
  }
}
