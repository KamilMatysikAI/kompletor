'use server'
// Korekta stanu produktu w firmie bez wFirmy (lib/kanaly/korekta-stanu.ts). Uprawnienie ustawień firmy.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { KontoError } from '@/lib/kanaly/konta'
import { korektaStanu } from '@/lib/kanaly/korekta-stanu'
import { requirePermission } from '@/lib/panel/kontekst'

export async function korygujStan(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const id = String(form.get('produkt') ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) redirect('/produkty')
  const raw = String(form.get('stan') ?? '').trim().replace(',', '.')
  const n = Number(raw)
  const kg = form.get('jednostka') === 'KG'
  // towar na wagę: ilość w kg w formularzu, w bazie gramy
  const physicalAfter = raw === '' ? Number.NaN : kg ? Math.round(n * 1000) : n
  let blad: string | null = null
  try {
    await korektaStanu(ctx.db, { productId: id, physicalAfter, reason: String(form.get('powod') ?? '') }, { actorId: ctx.user.id })
  } catch (e) {
    blad = e instanceof KontoError ? e.message : 'Nie udało się zapisać korekty, spróbuj ponownie'
  }
  revalidatePath(`/produkty/${id}`)
  revalidatePath('/produkty')
  redirect(`/produkty/${id}?${new URLSearchParams(blad ? { korekta: 'blad', blad } : { korekta: 'ok' })}`)
}
