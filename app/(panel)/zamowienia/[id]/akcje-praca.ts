'use server'
// Akcja sekcji „Co dalej” na karcie zamówienia (tryb PRACA). Zaczyna od requirePermission (sesja + uprawnienie,
// klient bazy firmy z sesji, RLS); obie bramki trybu PRACA, dostępność przycisku i wywołanie rdzenia sprawdza
// `wykonajPrzejscie` — także przy ręcznym wywołaniu akcji. Odmowa wraca jako komunikat na tej samej karcie.
// Nic nie idzie do kanału, wFirmy ani przewoźnika.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { naKarte } from '@/lib/karta/komunikaty-serwer'
import { requirePermission } from '@/lib/panel/kontekst'
import { wykonajPrzejscie } from '@/lib/praca/wykonaj'

export async function przejdz(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.przejscia')
  const id = String(form.get('zamowienie') ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) redirect('/zamowienia')
  const { blad } = await wykonajPrzejscie(ctx.db, {
    orderId: id,
    akcja: String(form.get('akcja') ?? ''),
    userId: ctx.user.id,
    uprawnienia: ctx.permissions,
    nadanie: form.get('nadanie'),
    przewoznik: form.get('przewoznik'),
  })
  revalidatePath(`/zamowienia/${id}`)
  revalidatePath('/zamowienia')
  // błąd kodem w adresie, treść w ciasteczku szczegółów (lib/karta/komunikaty-serwer.ts)
  redirect(await naKarte(id, blad ? { blad } : {}))
}
