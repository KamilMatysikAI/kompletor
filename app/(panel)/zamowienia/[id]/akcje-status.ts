'use server'
// „Zmień status” z menu „Więcej” na karcie zamówienia. Zaczyna od requirePermission (sesja + uprawnienie,
// klient bazy firmy z sesji, RLS); bramki trybu PRACA, lista dozwolonych statusów, powód i wykonanie sprawdza
// `zmienStatus` (lib/praca/status-dowolny.ts) — także przy ręcznym wywołaniu akcji. Nic nie idzie do kanału.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { naKarte } from '@/lib/karta/komunikaty-serwer'
import { requirePermission } from '@/lib/panel/kontekst'
import { zmienStatus } from '@/lib/praca/status-dowolny'

export async function zmienStatusKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.status_dowolny')
  const id = String(form.get('zamowienie') ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) redirect('/zamowienia')
  const { blad } = await zmienStatus(ctx.db, { orderId: id, status: String(form.get('status') ?? ''), powod: form.get('powod'), userId: ctx.user.id, uprawnienia: ctx.permissions })
  revalidatePath(`/zamowienia/${id}`)
  revalidatePath('/zamowienia')
  redirect(await naKarte(id, blad ? { blad } : { ok: 'status.zmieniony' }, blad ? '' : '#historia'))
}
