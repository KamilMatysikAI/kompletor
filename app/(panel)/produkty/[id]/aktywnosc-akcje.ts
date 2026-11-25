'use server'
// Karta produktu → przycisk „Wyłącz produkt” / „Włącz produkt” (zlecenie). Wpis w historii
// zmian produktu; wyłączenie odmawia przy aktywnej ofercie, rezerwacji, otwartym zamówieniu albo aktywnym zestawie
// (lib/produkty/aktywnosc.ts). Uprawnienie `produkty.dodawanie` (dodawanie i edycja produktów).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { opisOdmow, opisUwag, ustawAktywnosc } from '@/lib/produkty/aktywnosc'

export async function ustawAktywnoscProduktu(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const id = String(form.get('produkt') ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) redirect('/produkty')
  const aktywny = String(form.get('aktywny') ?? '') === 'tak'
  const r = await ustawAktywnosc(ctx.db, [id], aktywny, ctx.user.id)
  revalidatePath(`/produkty/${id}`)
  revalidatePath('/produkty')
  const p: Record<string, string> = !r.ok ? { aktywnoscBlad: r.error } : r.value.odmowy.length ? { aktywnoscBlad: opisOdmow(r.value.odmowy) } : { aktywnosc: r.value.zmienione ? (aktywny ? 'wlaczony' : 'wylaczony') : 'bez-zmian' }
  // uwagi (stan zostaje, zestaw z wyłączonymi składnikami): osobny toast informacyjny
  if (r.ok && r.value.uwagi.length) p.aktywnoscUwaga = opisUwag(r.value.uwagi)
  redirect(`/produkty/${id}?${new URLSearchParams(p)}`)
}
