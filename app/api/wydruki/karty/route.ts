// POST /api/wydruki/karty (formularz, pole `z` = <id,id…>) — jeden PDF z kartami zamówień, kolejność
// jak w `z`, każda karta z nowym numerem wydruku w rejestrze (OrderCardPrint). Kontrakt z kolejką pakowania
// `z` = id `Order` rozdzielone przecinkami (pole może się powtarzać), najwyżej 100. Sesja i uprawnienie
// `pakowanie.stanowisko` (requirePermissionApi).
// Tylko POST (scalenie): wydruk ma efekt uboczny (nowy numer unieważnia karty
// w koszykach), więc nie może go powtórzyć F5 ani przywrócenie karty przeglądarki; GET nie istnieje (405).
// Żądanie z obcej strony (`Sec-Fetch-Site: cross-site`) dostaje 403.
// Bez pola `informacyjne` (kolejka pakowania): zamówienia z samymi produktami bez stanu (e-book), wysłane i anulowane
// są pomijane — ostatnia strona PDF-u „Pominięto: …” i nagłówek `x-karty-pominiete` (encodeURIComponent, po
// przecinku) dla fetch; same takie zamówienia = 422.
// pole `informacyjne=1` (lista zamówień, karta zamówienia) = każde zaznaczone zamówienie dostaje stronę;
// te bez karty do zbierania — wydruk informacyjny bez kodu, nagłówek `x-karty-informacyjne` (jak wyżej).
// Błędy: przeglądarka (Accept z text/html, czyli formularz w nowej karcie) dostaje stronę HTML po polsku, `fetch`
// — JSON `{ error }` jak dotąd (lib/panel/blad-wydruku.ts).
import type { NextRequest } from 'next/server'
import { odmowaDostepu, odpowiedzBleduWydruku } from '@/lib/panel/blad-wydruku'
import { BladKart, drukujKarty } from '@/lib/stanowisko/karty'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'
import { idZamowien, MAX_ZAMOWIEN } from '@/lib/stanowisko/zamowienia'

export const dynamic = 'force-dynamic'

const TYTUL = 'Nie udało się wydrukować kart'

export async function POST(req: NextRequest): Promise<Response> {
  const blad = (status: number, komunikat: string) => odpowiedzBleduWydruku(req, { status, komunikat, tytul: TYTUL })
  const ctx = await requirePermissionApi('pakowanie.stanowisko')
  if (ctx instanceof Response) return odmowaDostepu(req, ctx, TYTUL, 'wydrukuj karty')
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return blad(403, 'Karty można drukować tylko z panelu. Otwórz listę zamówień w panelu i kliknij „Drukuj karty zamówień” jeszcze raz.')
  let surowe: string[]
  let informacyjne = false
  try {
    const f = await req.formData()
    surowe = f.getAll('z').filter((v): v is string => typeof v === 'string')
    informacyjne = ['1', 'tak', 'true'].includes(String(f.get('informacyjne') ?? ''))
  } catch {
    return blad(400, 'Nie udało się odczytać zaznaczonych zamówień. Wróć do listy zamówień, zaznacz je jeszcze raz i wydrukuj.')
  }
  if (surowe.join(',').split(',').length > MAX_ZAMOWIEN * 2) {
    return blad(400, `Jednym wydrukiem można objąć najwyżej ${MAX_ZAMOWIEN} zamówień. Zaznacz mniej i wydrukuj w kilku częściach.`)
  }
  const ids = idZamowien(surowe)
  try {
    const w = await drukujKarty(ctx.db, ids, { userId: ctx.user.id, nazwa: ctx.user.name }, new Date(), { informacyjne })
    const { pdf, wydruki, pominiete } = w
    const nazwa =
      wydruki.length === 1 && !w.informacyjne.length
        ? `karta-${wydruki[0]!.kod.replace(/\//g, '-')}.pdf`
        : `karty-${wydruki.length + w.informacyjne.length}.pdf`
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${nazwa}"`,
        'cache-control': 'no-store',
        'x-karty': wydruki.map((x) => x.kod).join(','),
        ...(pominiete.length ? { 'x-karty-pominiete': pominiete.map((p) => encodeURIComponent(p.numer)).join(',') } : {}),
        ...(w.informacyjne.length ? { 'x-karty-informacyjne': w.informacyjne.map((p) => encodeURIComponent(p.numer)).join(',') } : {}),
      },
    })
  } catch (e) {
    if (e instanceof BladKart) return blad(e.status, e.message)
    throw e
  }
}
