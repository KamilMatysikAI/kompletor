'use server'
// Produkty → zaznaczenie na liście → „Wyłącz / włącz” (zlecenie): wyłączenie albo włączenie
// zaznaczonych produktów z wpisem w historii każdego zmienionego. Produkty z przeszkodą (aktywna oferta, rezerwacja,
// otwarte zamówienie, aktywny zestaw) zostają bez zmian i wracają w komunikacie. Uprawnienie `produkty.dodawanie`.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { opisOdmow, opisUwag, ustawAktywnosc } from '@/lib/produkty/aktywnosc'
import { requirePermission } from '@/lib/panel/kontekst'

/** Powrót na tę samą stronę listy (filtry w adresie); tylko adres listy produktów. */
function powrot(v: FormDataEntryValue | null): string {
  const s = typeof v === 'string' ? v : ''
  return /^\/produkty(\?[^#\s]{0,1500})?$/.test(s) ? s : '/produkty'
}

const z = (adres: string, p: Record<string, string>) => `${adres}${adres.includes('?') ? '&' : '?'}${new URLSearchParams(p)}`

export async function ustawAktywnoscZaznaczonym(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const wroc = powrot(form.get('wroc'))
  const v = String(form.get('aktywny') ?? '')
  if (v !== 'tak' && v !== 'nie') redirect(z(wroc, { blad: 'Wybierz: wyłącz albo włącz.' }))
  const r = await ustawAktywnosc(ctx.db, form.getAll('zaznaczone').map(String), v === 'tak', ctx.user.id)
  if (!r.ok) redirect(z(wroc, { blad: r.error }))
  revalidatePath('/produkty')
  const ile = `${v === 'tak' ? 'Włączone' : 'Wyłączone'}: ${r.value.zmienione}.`
  // uwagi (stan zostaje, zestaw z wyłączonymi składnikami): osobny toast informacyjny obok wyniku
  const uwaga: Record<string, string> = r.value.uwagi.length ? { uwaga: opisUwag(r.value.uwagi) } : {}
  if (r.value.odmowy.length) redirect(z(wroc, { blad: `${ile} ${opisOdmow(r.value.odmowy)}`.slice(0, 300), ...uwaga }))
  redirect(z(wroc, { zapisano: v === 'tak' ? 'wlaczone' : 'wylaczone', ile: String(r.value.zmienione), ...uwaga }))
}
