'use server'
// Ustawienia → Dane klientów: zapis w cieniu, retencja i tryb (raport albo usuwanie). Tylko z uprawnieniem
// ustawień firmy; zapis wyłącznie przez zapiszUstawieniaKlientow (walidacja + AuditLog) z id zalogowanej osoby.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { BladUstawienKlientow, parseFormularzUstawien, zapiszUstawieniaKlientow } from '@/lib/klienci/ustawienia'
import { requirePermission } from '@/lib/panel/kontekst'

const PATH = '/ustawienia/dane-klientow'

export async function zapiszDaneKlientow(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  let blad: string | null = null
  try {
    await zapiszUstawieniaKlientow(ctx.db, parseFormularzUstawien(form), ctx.user.id)
  } catch (e) {
    blad = e instanceof BladUstawienKlientow ? e.message : 'Nie udało się zapisać — spróbuj ponownie'
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(blad ? { blad } : { zapisano: '1' })}`)
}
