'use server'
// Akcja bloku „Przesyłka” w ekranie zamówienia. Zaczyna od requirePermission (sesja + uprawnienie, klient
// bazy firmy z sesji, RLS). Liczy i zapisuje wyłącznie podgląd: nic nie idzie do przewoźnika.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { BladPrzesylki, prepareForOrder, type WynikPrzygotowania } from '@/lib/wysylka/podglad'

export interface StanPrzygotowania {
  blad: string | null
}

export async function przygotujPrzesylke(orderId: string, gabaryt: string | null): Promise<StanPrzygotowania> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return { blad: 'Nie ma takiego zamówienia.' }
  let wynik: WynikPrzygotowania
  try {
    wynik = await prepareForOrder(ctx.db, id, gabaryt ? String(gabaryt).slice(0, 40) : null)
  } catch (e) {
    if (e instanceof BladPrzesylki) return { blad: e.message }
    throw e
  }
  revalidatePath(`/zamowienia/${id}`) // „nie dotyczy” też zmienia ekran: stary podgląd znika
  return { blad: wynik.wynik === 'nie_dotyczy' ? wynik.powod : null }
}
