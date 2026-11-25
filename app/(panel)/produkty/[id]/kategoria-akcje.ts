'use server'
// Karta produktu → sekcja „Kategoria”: kategoria z drzewa firmy albo „bez kategorii”, źródło RECZNE, wpis
// w historii zmian produktu. Uprawnienie `produkty.dodawanie` (dane produktu).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { przypiszKategorie } from '@/lib/produkty/kategorie'

export async function ustawKategorie(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const id = String(form.get('produkt') ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) redirect('/produkty')
  const v = String(form.get('kategoria') ?? '')
  const r = await przypiszKategorie(ctx.db, [id], v || null, 'RECZNE', ctx.user.id)
  revalidatePath(`/produkty/${id}`)
  revalidatePath('/produkty')
  redirect(`/produkty/${id}?${new URLSearchParams(r.ok ? { kategoria: r.value.zmienione ? 'zapisana' : 'bez-zmian' } : { kategoriaBlad: r.error })}#kategoria`)
}
