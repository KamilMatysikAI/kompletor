'use server'
// Akcja bloku „Faktura KSeF” w ekranie zamówienia. Zaczyna od requirePermission (sesja + uprawnienie, klient
// bazy firmy z sesji, RLS). Składa i zapisuje wyłącznie szkic w naszej bazie: nic nie idzie do KSeF.
import { revalidatePath } from 'next/cache'
import { BladKsef, prepareKsefForOrder, type WynikKsef } from '@/lib/ksef/szkice'
import { requirePermission } from '@/lib/panel/kontekst'

type WynikAkcji = { blad: string | null }

export async function przygotujFaktureKsef(orderId: string): Promise<WynikAkcji> {
  const ctx = await requirePermission('zamowienia.anuluj_po_fakturze')
  const id = String(orderId ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return { blad: 'Nie ma takiego zamówienia.' }
  let wynik: WynikKsef
  try {
    wynik = await prepareKsefForOrder(ctx.db, id)
  } catch (e) {
    if (e instanceof BladKsef) return { blad: e.message }
    throw e
  }
  revalidatePath(`/zamowienia/${id}`)
  return { blad: wynik.wynik === 'przygotowana' ? null : wynik.powod }
}
