'use server'
// Strefa magazynu produktu: ręczne ustawienie albo powrót do reguły firmy. Uprawnienie ustawień firmy.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { setProductZone } from '@/lib/pakowanie/dane'
import { ZONE_KEY_RE } from '@/lib/pakowanie/strefy'

export async function ustawStrefe(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const id = String(form.get('produkt') ?? '')
  const v = String(form.get('strefa') ?? '')
  // klucz strefy firmy; czy strefa istnieje, sprawdza setProductZone
  const zone = ZONE_KEY_RE.test(v) ? v : null
  if (!/^[a-z0-9]{1,40}$/i.test(id) || (v !== '' && !zone)) redirect('/produkty')
  let ok = false
  try {
    ok = await setProductZone(ctx.db, id, zone, ctx.user.id)
  } catch {
    ok = false // strefa usunięta w międzyczasie
  }
  if (!ok) redirect('/produkty')
  revalidatePath(`/produkty/${id}`)
  revalidatePath('/pakowanie')
  redirect(`/produkty/${id}`)
}
