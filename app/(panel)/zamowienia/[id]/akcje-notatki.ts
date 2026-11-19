'use server'
// Akcje notatek wewnętrznych karty zamówienia. Zaczynają od requirePermission; okno 15 minut i autora
// sprawdza zapis w lib/karta/notatki.ts. Treść notatki nie trafia do komunikatów ani logów.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ID_RE } from '@/lib/karta/bramka'
import { naKarte } from '@/lib/karta/komunikaty-serwer'
import { dodajNotatke, poprawNotatke } from '@/lib/karta/notatki'
import type { WynikKarty } from '@/lib/karta/pozycje'
import { requirePermission } from '@/lib/panel/kontekst'

async function wroc(id: string, w: WynikKarty): Promise<never> {
  if (!ID_RE.test(id)) redirect('/zamowienia')
  revalidatePath(`/zamowienia/${id}`)
  redirect(await naKarte(id, w.blad ? { blad: w.blad } : w.zmiana ? { ok: 'notatka' } : {}, '#notatki'))
}

export async function dodajNotatkeKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.notatki')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await dodajNotatke(ctx.db, { orderId: id, tresc: form.get('tresc'), naKarcie: form.get('na_karcie'), userId: ctx.user.id, uprawnienia: ctx.permissions }))
}

export async function poprawNotatkeKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.notatki')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await poprawNotatke(ctx.db, { orderId: id, noteId: form.get('notatka'), tresc: form.get('tresc'), naKarcie: form.get('na_karcie'), userId: ctx.user.id, uprawnienia: ctx.permissions }))
}
