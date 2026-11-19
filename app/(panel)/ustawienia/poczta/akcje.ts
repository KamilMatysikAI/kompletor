'use server'
// Ustawienia → Poczta: zapis ustawień poczty firmy i mail próbny. Tylko z uprawnieniem ustawień firmy;
// zapis wyłącznie przez zapiszUstawieniaPoczty (walidacja, hasło jako sekret, AuditLog) z id zalogowanej osoby.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { BladUstawienPoczty, parseFormularzPoczty, zapiszUstawieniaPoczty } from '@/lib/poczta/ustawienia'
import { parseFormularzOdbic, zapiszUstawieniaOdbic } from '@/lib/poczta/czytnik-odbic'
import { wyslijMailProbny } from '@/lib/poczta/wysylka'

const PATH = '/ustawienia/poczta'

export async function zapiszPoczte(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  let blad: string | null = null
  try {
    await zapiszUstawieniaPoczty(ctx.db, parseFormularzPoczty(form), ctx.user.id, process.env)
  } catch (e) {
    // komunikaty walidacji pokazujemy; błąd bazy albo klucza szyfrowania — bez szczegółów
    blad = e instanceof BladUstawienPoczty ? e.message : 'Nie udało się zapisać — spróbuj ponownie'
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(blad ? { blad: blad.slice(0, 400) } : { zapisano: '1' })}`)
}

export async function wyslijTest(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const adres = String(form.get('adres') ?? '').slice(0, 254)
  let r: Awaited<ReturnType<typeof wyslijMailProbny>>
  try {
    r = await wyslijMailProbny(ctx.db, process.env, adres, ctx.user.id)
  } catch {
    r = { ok: false, error: 'Nie udało się wysłać — spróbuj ponownie' }
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(r.ok ? { proba: r.maska } : { blad: r.error.slice(0, 300) })}`)
}

/** karta „Odbicia” (skrzynka nadawcy przez IMAP, adres odbić). */
export async function zapiszOdbicia(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  let blad: string | null = null
  try {
    await zapiszUstawieniaOdbic(ctx.db, parseFormularzOdbic(form), ctx.user.id, process.env)
  } catch (e) {
    blad = e instanceof BladUstawienPoczty ? e.message : 'Nie udało się zapisać — spróbuj ponownie'
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(blad ? { blad: blad.slice(0, 400) } : { zapisano: '1' })}#odbicia`)
}
