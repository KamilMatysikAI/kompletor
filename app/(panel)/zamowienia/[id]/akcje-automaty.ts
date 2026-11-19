'use server'
// przycisk automatycznej akcji na karcie zamówienia (reguła ze zdarzeniem „Kliknięto przycisk”). Uprawnienie
// jak przejścia „Co dalej”; warunki reguły, bramki kroków (tryb pracy, nadawanie, faktury) i idempotencję po kluczu
// kliknięcia sprawdza silnik (lib/automaty/silnik.ts `kliknijPrzycisk`).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { kliknijPrzycisk } from '@/lib/automaty/silnik'
import { naKarte } from '@/lib/karta/komunikaty-serwer'
import { requirePermission } from '@/lib/panel/kontekst'

export async function przyciskReguly(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.przejscia')
  const id = String(form.get('zamowienie') ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) redirect('/zamowienia')
  const { blad } = await kliknijPrzycisk(ctx.db, String(form.get('regula') ?? ''), id, String(form.get('klucz') ?? ''), 'karta')
  revalidatePath(`/zamowienia/${id}`)
  redirect(await naKarte(id, blad ? { blad } : { ok: 'automat.wykonany' }, blad ? '' : '#historia'))
}
