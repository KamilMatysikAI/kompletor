'use server'
// przyciski automatycznych akcji na stanowisku pakowania (reguły „Kliknięto przycisk” z miejscem
// „Stanowisko pakowania”). Uprawnienie stanowiska; warunki, bramki kroków i idempotencję sprawdza silnik.
import { kliknijPrzycisk, przyciskiZamowienia, type PrzyciskZamowienia } from '@/lib/automaty/silnik'
import { requirePermission } from '@/lib/panel/kontekst'

const ID = /^[a-z0-9]{1,40}$/i

export async function przyciskiStanowiska(orderId: string): Promise<PrzyciskZamowienia[]> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  if (!ID.test(orderId)) return []
  return przyciskiZamowienia(ctx.db, orderId, 'pakowanie').catch(() => [])
}

export async function kliknijNaStanowisku(orderId: string, regulaId: string, klucz: string): Promise<{ blad: string | null }> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  if (!ID.test(orderId)) return { blad: 'Nie ma takiego zamówienia.' }
  const { blad } = await kliknijPrzycisk(ctx.db, regulaId, orderId, klucz, 'pakowanie')
  return { blad }
}
