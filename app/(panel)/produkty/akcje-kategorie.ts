'use server'
// Produkty → zaznaczenie na liście → „Przypisz kategorię”: kategoria dla zaznaczonych produktów (albo „bez
// kategorii”), źródło przypisania RECZNE, wpis w historii każdego zmienionego produktu. Uprawnienie `produkty.dodawanie`.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { FILTR_BEZ_KATEGORII, przypiszKategorie } from '@/lib/produkty/kategorie'
import { requirePermission } from '@/lib/panel/kontekst'

/** Powrót na tę samą stronę listy (filtry w adresie); tylko adres listy produktów. */
function powrot(v: FormDataEntryValue | null): string {
  const s = typeof v === 'string' ? v : ''
  return /^\/produkty(\?[^#\s]{0,1500})?$/.test(s) ? s : '/produkty'
}

const z = (adres: string, p: Record<string, string>) => `${adres}${adres.includes('?') ? '&' : '?'}${new URLSearchParams(p)}`

export async function przypiszKategorieZaznaczonym(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const wroc = powrot(form.get('wroc'))
  const kat = String(form.get('kategoria') ?? '')
  if (!kat) redirect(z(wroc, { blad: 'Wybierz kategorię albo „Bez kategorii”.' }))
  const ids = form.getAll('zaznaczone').map(String)
  const r = await przypiszKategorie(ctx.db, ids, kat === FILTR_BEZ_KATEGORII ? null : kat, 'RECZNE', ctx.user.id)
  if (!r.ok) redirect(z(wroc, { blad: r.error }))
  revalidatePath('/produkty')
  redirect(z(wroc, { zapisano: 'kategoria' }))
}
