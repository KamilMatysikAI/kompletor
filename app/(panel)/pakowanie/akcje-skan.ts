'use server'
// Skan czytnikiem na kolejce Pakowania i liście zbierania, gdy okno pakowania nie jest otwarte.
// Uprawnienie jak stanowisko (`pakowanie.stanowisko`), klient bazy firmy z sesji (RLS).
import { requirePermission } from '@/lib/panel/kontekst'
import { skanDoPakowania, type WynikSkanuKolejki } from '@/lib/stanowisko/skan-poza-oknem'

export async function skanNaKolejce(tekst: string): Promise<WynikSkanuKolejki> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  return skanDoPakowania(ctx.db, String(tekst ?? '').slice(0, 300))
}
