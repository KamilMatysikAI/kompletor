'use server'
// Ustawienia → Poczta → Szablony: zapis treści szablonu firmy i przywrócenie treści domyślnej.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { BladSzablonu } from '@/lib/maile'
import { requirePermission } from '@/lib/panel/kontekst'
import { BladSzablonuFirmy, isRodzajEdytowalny, nadpisanieZFormularza, przywrocDomyslny, zapiszSzablon } from '@/lib/poczta/szablony'

const PATH = '/ustawienia/poczta/szablony'

export async function zapiszSzablonFirmy(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const rodzaj = String(form.get('rodzaj') ?? '')
  if (!isRodzajEdytowalny(rodzaj)) redirect(PATH)
  let blad: string | null = null
  try {
    await zapiszSzablon(ctx.db, rodzaj, nadpisanieZFormularza(rodzaj, form), ctx.user.id)
  } catch (e) {
    blad = e instanceof BladSzablonuFirmy || e instanceof BladSzablonu ? e.message : 'Nie udało się zapisać — spróbuj ponownie'
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams({ rodzaj, ...(blad ? { blad: blad.slice(0, 500) } : { zapisano: '1' }) })}`)
}

export async function przywrocSzablon(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const rodzaj = String(form.get('rodzaj') ?? '')
  if (!isRodzajEdytowalny(rodzaj)) redirect(PATH)
  await przywrocDomyslny(ctx.db, rodzaj, ctx.user.id)
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams({ rodzaj, przywrocono: '1' })}`)
}
