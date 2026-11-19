'use server'
// Akcje karty zamówienia: „Powiąż z produktem” (pozycja bez produktu → powiązanie oferty z katalogiem)
// i „Odśwież opis z kanału” (nazwa, SKU, EAN pozycji, numer i koszt wysyłki dla zamówień sprzed zmiany). Obie bez zapisu
// do kanału, więc działają także na koncie w cieniu. Komunikat wraca parametrem adresu na tę samą kartę. „Odśwież opis”
// woła API kanału i zapisuje pola zamówienia, więc wymaga `zamowienia.edycja_pozycji`, nie samego podglądu.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { ID_RE } from '@/lib/karta/bramka'
import { BLEDY_KARTY } from '@/lib/karta/komunikaty'
import { naKarte } from '@/lib/karta/komunikaty-serwer'
import { odswiezOpisZKanalu } from '@/lib/karta/opis-z-kanalu'
import { powiazPozycje } from '@/lib/karta/powiaz'
import type { WynikKarty } from '@/lib/karta/pozycje'
import { appModeOf } from '@/lib/organizacje'
import { requirePermission } from '@/lib/panel/kontekst'

async function wroc(id: string, w: WynikKarty): Promise<never> {
  if (!ID_RE.test(id)) redirect('/zamowienia')
  revalidatePath(`/zamowienia/${id}`)
  revalidatePath('/zamowienia')
  redirect(await naKarte(id, w.blad ? { blad: w.blad } : { ok: w.info ?? 'zapisano', n: w.n }))
}

export async function powiazKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await powiazPozycje(ctx.db, { orderId: id, lineId: form.get('pozycja'), sku: form.get('sku'), sztuk: form.get('sztuk'), actorId: ctx.user.id }))
}

export async function odswiezOpisKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.edycja_pozycji')
  const id = String(form.get('zamowienie') ?? '')
  if (!ID_RE.test(id)) redirect('/zamowienia')
  const r = await odswiezOpisZKanalu(ctx.db, id, { registry: defaultRegistry(), secrets: { env: process.env, envFallback: appModeOf(process.env) === 'self-host' }, actorId: `user:${ctx.user.id}` })
  if (r.wynik === 'OK') return await wroc(id, { zmiana: true, blad: null, info: r.zmian ? 'opis.odswiezono' : 'opis.bez-zmian' })
  if (r.wynik === 'BRAK_W_KANALE') return await wroc(id, { zmiana: false, blad: BLEDY_KARTY['kanal-nie-zna'] })
  await wroc(id, { zmiana: false, blad: r.powod })
}
