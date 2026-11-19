'use server'
// Akcje sekcji „Płatność” karty zamówienia: „Oznacz jako opłacone” (istniejące markPaid), „Zapisz dopłatę”
// i „Zwrot różnicy”. Zaczynają od requirePermission; bramkę trybu PRACA i warunki kwot sprawdza lib/karta/platnosci.ts.
// Tylko zapis w Kompletorze: bez banku i bez linków płatności.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ID_RE } from '@/lib/karta/bramka'
import { naKarte } from '@/lib/karta/komunikaty-serwer'
import { oznaczOplacone, zapiszPlatnosc } from '@/lib/karta/platnosci'
import type { WynikKarty } from '@/lib/karta/pozycje'
import { requirePermission } from '@/lib/panel/kontekst'

async function wroc(id: string, w: WynikKarty): Promise<never> {
  if (!ID_RE.test(id)) redirect('/zamowienia')
  revalidatePath(`/zamowienia/${id}`)
  redirect(await naKarte(id, w.blad ? { blad: w.blad } : w.zmiana ? { ok: 'zapisano' } : {}))
}

export async function oznaczOplaconeKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.oznacz_oplacone')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await oznaczOplacone(ctx.db, { orderId: id, userId: ctx.user.id, uprawnienia: ctx.permissions }))
}

export async function zapiszDoplateKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.oznacz_oplacone')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await zapiszPlatnosc(ctx.db, { orderId: id, rodzaj: 'DOPLATA', kwota: form.get('kwota'), data: form.get('data'), metoda: form.get('metoda'), userId: ctx.user.id, uprawnienia: ctx.permissions }))
}

export async function zwrotRoznicyKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zwroty.pieniadze')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await zapiszPlatnosc(ctx.db, { orderId: id, rodzaj: 'ZWROT', kwota: form.get('kwota'), data: form.get('data'), metoda: form.get('metoda'), userId: ctx.user.id, uprawnienia: ctx.permissions }))
}
