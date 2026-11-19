'use server'
// Skan czytnikiem i wklejenie numeru na liście zamówień: jedno zamówienie = jego karta. Uprawnienie jak
// karta zamówienia (sesja panelu), klient bazy firmy z sesji (RLS): zamówienie innej firmy daje „Nie znam kodu”.
import { requireSession } from '@/lib/panel/kontekst'
import { kodNaLiscie, type WynikKoduListy } from '@/lib/stanowisko/skan-poza-oknem'

export async function kodListyZamowien(tekst: string, zrodlo: 'skan' | 'wklej'): Promise<WynikKoduListy> {
  const ctx = await requireSession()
  return kodNaLiscie(ctx.db, String(tekst ?? '').slice(0, 2000), zrodlo === 'wklej' ? 'wklej' : 'skan')
}
