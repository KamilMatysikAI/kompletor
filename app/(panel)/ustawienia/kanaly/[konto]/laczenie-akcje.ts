'use server'
// Ustawienia → Kanały sprzedaży → konto → „Łączenie ofert z produktami”: połączenie zaznaczonych ofert
// z podglądu po SKU albo EAN i zbiorcze zatwierdzenie propozycji. Uprawnienie `ustawienia`. Nic nie idzie do kanału.
import { revalidatePath } from 'next/cache'
import { kodKonta, parseKodKonta } from '@/lib/kanaly/konta'
import { int } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { polaczMasowo, zatwierdzPropozycje, type WynikLaczenia } from '@/lib/produkty/powiazania'

export interface StanLaczenia {
  ok: boolean
  komunikat: string | null
}

function opis(w: WynikLaczenia, co: string): string {
  const czesci = [`${co}: ${int(w.polaczone)}.`]
  if (w.remapped) czesci.push(`Przeliczone zamówienia: ${int(w.remapped)}.`)
  if (w.pominiete) czesci.push(`Pominięte, bo zmieniły się od podglądu: ${int(w.pominiete)}.`)
  if (w.bledy) czesci.push(`Nie udało się: ${int(w.bledy)} (są w alertach).`)
  return czesci.join(' ')
}

export async function polaczZaznaczone(_prev: StanLaczenia, form: FormData): Promise<StanLaczenia> {
  const ctx = await requirePermission('ustawienia')
  const ref = parseKodKonta(String(form.get('konto') ?? ''))
  const po = form.get('po') === 'EAN' ? 'EAN' : 'SKU'
  if (!ref) return { ok: false, komunikat: 'Nie ma takiego konta.' }
  const wybrane = form.getAll('zaznaczone').map(String)
  if (!wybrane.length) return { ok: false, komunikat: 'Zaznacz oferty do połączenia.' }
  try {
    const w = await polaczMasowo(ctx.db, ref, po, wybrane, ctx.user.id)
    revalidatePath(`/ustawienia/kanaly/${encodeURIComponent(kodKonta(ref))}`)
    revalidatePath('/zamowienia')
    return { ok: w.bledy === 0, komunikat: opis(w, 'Połączone oferty') }
  } catch {
    return { ok: false, komunikat: 'Nie udało się połączyć, spróbuj ponownie.' }
  }
}

export async function zatwierdzZaznaczone(_prev: StanLaczenia, form: FormData): Promise<StanLaczenia> {
  const ctx = await requirePermission('ustawienia')
  const ref = parseKodKonta(String(form.get('konto') ?? ''))
  if (!ref) return { ok: false, komunikat: 'Nie ma takiego konta.' }
  const wybrane = form.getAll('zaznaczone').map(String)
  if (!wybrane.length) return { ok: false, komunikat: 'Zaznacz propozycje do zatwierdzenia.' }
  try {
    const w = await zatwierdzPropozycje(ctx.db, ref, wybrane, ctx.user.id)
    revalidatePath(`/ustawienia/kanaly/${encodeURIComponent(kodKonta(ref))}`)
    revalidatePath('/zamowienia')
    return { ok: w.bledy === 0, komunikat: opis(w, 'Zatwierdzone propozycje') }
  } catch {
    return { ok: false, komunikat: 'Nie udało się zatwierdzić, spróbuj ponownie.' }
  }
}
