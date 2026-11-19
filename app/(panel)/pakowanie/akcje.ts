'use server'
// Akcje kolejki pakowania. Każda zaczyna od requirePermission — klient bazy tylko z firmy sesji (RLS).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { isPickupCarrier, markCarrierArrived } from '@/lib/pakowanie/dane'

/** Powrót na ten sam widok kolejki (zakładka, strefa, strona) — tylko ścieżki /pakowanie. */
function back(v: FormDataEntryValue | null): string {
  const s = typeof v === 'string' ? v : ''
  return /^\/pakowanie(\?[\w=&%.-]*)?$/.test(s) ? s : '/pakowanie'
}

/** „Przyjechał <przewoźnik>”: zamyka dzisiejszy odbiór (drugie kliknięcie tego dnia nic nie zmienia). */
export async function przyjechal(form: FormData): Promise<void> {
  const ctx = await requirePermission('pakowanie.kurier')
  const carrier = String(form.get('przewoznik') ?? '')
  if (isPickupCarrier(carrier)) {
    await markCarrierArrived(ctx.db, { carrier, actorId: ctx.user.id, actorName: ctx.user.name })
    revalidatePath('/pakowanie')
  }
  redirect(back(form.get('wroc')))
}
