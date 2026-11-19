'use server'
// Koszyki. Każda akcja zaczyna od requirePermission (klient bazy firmy z sesji, RLS): dodawanie, usuwanie
// i ustawienie „wymagaj skanu koszyka” = `ustawienia` (konfiguracja firmy), zwalnianie i przydział = `pakowanie.stanowisko`.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { BladKoszyka, dodajKoszyki, przypiszWolne, usunKoszyk, zwolnijKoszyk } from '@/lib/koszyki/koszyki'
import { zapiszKoszykWymagany } from '@/lib/stanowisko/ustawienia'
import { idZamowien } from '@/lib/stanowisko/zamowienia'

export interface StanKoszykow {
  ok?: boolean
  komunikat: string | null
}

const SCIEZKA = '/pakowanie/koszyki'

export async function dodaj(_prev: StanKoszykow, form: FormData): Promise<StanKoszykow> {
  const ctx = await requirePermission('ustawienia')
  try {
    const nazwy = String(form.get('nazwy') ?? '')
      .split(/[\s,;]+/)
      .map((n) => n.trim())
      .filter(Boolean)
    const dodane = nazwy.length ? await dodajKoszyki(ctx.db, { nazwy }) : await dodajKoszyki(ctx.db, { ile: Number(form.get('ile') ?? 0) })
    revalidatePath(SCIEZKA)
    return dodane.length ? { ok: true, komunikat: `Dodano koszyki: ${dodane.join(', ')}.` } : { ok: true, komunikat: 'Takie koszyki już są, nic nie dodano.' }
  } catch (e) {
    if (e instanceof BladKoszyka) return { ok: false, komunikat: e.message }
    throw e
  }
}

export async function usun(_prev: StanKoszykow, form: FormData): Promise<StanKoszykow> {
  const ctx = await requirePermission('ustawienia')
  const ok = await usunKoszyk(ctx.db, String(form.get('id') ?? ''))
  revalidatePath(SCIEZKA)
  return ok ? { ok: true, komunikat: 'Koszyk usunięty.' } : { ok: false, komunikat: 'Koszyk z zamówieniem najpierw zwolnij.' }
}

export async function zwolnij(_prev: StanKoszykow, form: FormData): Promise<StanKoszykow> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  await zwolnijKoszyk(ctx.db, String(form.get('id') ?? ''))
  revalidatePath(SCIEZKA)
  revalidatePath('/pakowanie')
  return { ok: true, komunikat: 'Koszyk wolny.' }
}

export async function ustawWymagany(_prev: StanKoszykow, form: FormData): Promise<StanKoszykow> {
  const ctx = await requirePermission('ustawienia')
  const wl = form.get('wymagany') === 'tak'
  await zapiszKoszykWymagany(ctx.db, wl, ctx.user.id)
  revalidatePath(SCIEZKA)
  return { ok: true, komunikat: wl ? 'Stanowisko wymaga teraz skanu koszyka przed „Spakowano”.' : 'Skan koszyka nie jest już wymagany.' }
}

/** Lista zbierania: wolne koszyki dla zamówień bez koszyka, w kolejności listy. */
export async function przypiszKoszyki(_prev: StanKoszykow, form: FormData): Promise<StanKoszykow> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const ids = idZamowien(String(form.get('z') ?? ''))
  const w = await przypiszWolne(ctx.db, ids, ctx.user.id)
  revalidatePath('/pakowanie/zbieranie')
  revalidatePath('/pakowanie')
  if (!w.przypisane.length && w.bezKoszyka) return { ok: false, komunikat: `Brak wolnych koszyków: ${w.bezKoszyka} zamówień zostaje bez koszyka. Zwolnij koszyki albo dodaj nowe.` }
  const reszta = w.bezKoszyka ? ` Bez koszyka zostało ${w.bezKoszyka}: zabrakło wolnych.` : ''
  return { ok: true, komunikat: w.przypisane.length ? `Przypisano ${w.przypisane.length} koszyków.${reszta}` : 'Każde zamówienie ma już koszyk.' }
}
