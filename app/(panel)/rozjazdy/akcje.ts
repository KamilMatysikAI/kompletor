'use server'
// Akcje ekranu rozjazdów: biuro zamyka pozycję „Do poprawy w wFirmie — z ćwiczenia” po poprawie stanu.
// Każda akcja zaczyna od requirePermission (sesja + uprawnienie, klient firmy z sesji — RLS).
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { zamknijDoPoprawy } from '@/lib/stanowisko/cwiczenie'

export async function zamknijPozycjeDoPoprawy(form: FormData): Promise<void> {
  const ctx = await requirePermission('pakowanie.do_poprawy')
  await zamknijDoPoprawy(ctx.db, String(form.get('id') ?? ''), ctx.user.id)
  revalidatePath('/rozjazdy')
}
