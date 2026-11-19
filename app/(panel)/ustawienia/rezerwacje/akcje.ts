'use server'
// Ustawienia → Zasady rezerwacji: zapis przełącznika sezonu i długości okresów. Tylko z uprawnieniem
// ustawień firmy; zapis wyłącznie przez savePolicy (walidacja + AuditLog) z id zalogowanej osoby.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { formValuesOf, parsePolicyForm, policyOf, readableError, type PolicyFormState } from '@/lib/panel/ustawienia-rezerwacji-opis'
import { getPolicy, savePolicy } from '@/lib/rdzen/polityka'

export async function zapiszZasady(prev: PolicyFormState, form: FormData): Promise<PolicyFormState> {
  const ctx = await requirePermission('ustawienia')
  const { values, patch } = parsePolicyForm(form)
  try {
    const version = form.get('wersja')
    const saved = await savePolicy(ctx.db, patch, ctx.user.id, typeof version === 'string' ? version : undefined)
    revalidatePath('/ustawienia/rezerwacje')
    return { values: formValuesOf(saved.policy), current: saved.policy, version: saved.version, error: null, field: null, savedAt: Date.now() }
  } catch (e) {
    const { message, field } = readableError(e)
    // wpisane wartości wracają do formularza; „obowiązuje teraz” — z bazy, a gdy baza nie odpowiada, ostatnie znane
    const current = await getPolicy(ctx.db).then(policyOf, () => prev.current)
    // wersja zostaje ta z odczytu: po cudzym zapisie kolejne kliknięcie też odmawia, aż ktoś odświeży ekran
    return { values, current, version: prev.version, error: message, field, savedAt: null }
  }
}
