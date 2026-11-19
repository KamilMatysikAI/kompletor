'use server'
// Akcja bloku „Faktura” karty zamówienia: „Ponów fakturę” po błędzie. Zaczyna od requirePermission (sesja +
// uprawnienie, klient bazy firmy z sesji, RLS). Nic tu nie woła programu do faktur: zdejmuje błąd i nową próbę
// wystawia kolejka w najbliższym przebiegu (co 2 minuty), z tym samym rozstrzyganiem timeoutów, więc bez drugiej faktury.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { PackError, ponowFaktureRecznie, potwierdzDokumentWystawiony } from '@/lib/rdzen/rozchod'

type WynikAkcji = { blad: string | null }

export async function ponowFakture(orderId: string): Promise<WynikAkcji> {
  const ctx = await requirePermission('zamowienia.faktury')
  const id = String(orderId ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return { blad: 'Nie ma takiego zamówienia.' }
  try {
    await ponowFaktureRecznie(ctx.db, id, { actorId: ctx.user.id })
  } catch (e) {
    if (e instanceof PackError) return { blad: e.message }
    throw e
  }
  revalidatePath(`/zamowienia/${id}`)
  return { blad: null }
}

/**
 * „Dokument wystawiony” — biuro wystawiło dokument w wFirmie ręcznie (albo sprawdziło,
 * że WZ z Kompletora jednak powstało). Zamyka pozycje „wydane bez dokumentu” zamówienia i alerty o nich; nic nie idzie
 * do programu. Wpis w historii zamówienia i w dzienniku zmian z osobą z sesji.
 */
export async function potwierdzDokument(orderId: string): Promise<WynikAkcji> {
  const ctx = await requirePermission('zamowienia.faktury')
  const id = String(orderId ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return { blad: 'Nie ma takiego zamówienia.' }
  try {
    await potwierdzDokumentWystawiony(ctx.db, id, { actorId: ctx.user.id })
  } catch (e) {
    if (e instanceof PackError) return { blad: e.message }
    throw e
  }
  revalidatePath(`/zamowienia/${id}`)
  return { blad: null }
}
