'use server'
// Ustawienia → Klucze API: utworzenie i odwołanie klucza. Tylko z uprawnieniem ustawień firmy; zapis
// wyłącznie przez lib/api/zarzadzanie.ts (klient firmy z sesji, AuditLog z id zalogowanej osoby, bez wartości klucza).
// Pełny klucz wraca tylko w stanie formularza po utworzeniu — nie trafia do bazy, logu ani adresu strony.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { ApiKeyError, createApiKey, revokeApiKey, type ApiKeyFormState } from '@/lib/api/zarzadzanie'

export async function utworzKlucz(_prev: ApiKeyFormState, form: FormData): Promise<ApiKeyFormState> {
  const ctx = await requirePermission('ustawienia')
  const name = form.get('nazwa')
  try {
    const k = await createApiKey(ctx.db, { name, scopes: form.getAll('zakres'), konta: form.getAll('konto'), wszystkieKonta: form.get('konta_wszystkie') }, ctx.user.id)
    revalidatePath('/ustawienia/klucze-api')
    return { error: null, created: { name: typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '', token: k.token, prefix: k.prefix } }
  } catch (e) {
    if (e instanceof ApiKeyError) return { error: e.message, created: null }
    throw e
  }
}

export async function odwolajKlucz(_prev: string | null, form: FormData): Promise<string | null> {
  const ctx = await requirePermission('ustawienia')
  const id = form.get('id')
  try {
    if (typeof id !== 'string' || !id) throw new ApiKeyError('Nie znaleziono klucza.')
    await revokeApiKey(ctx.db, id, ctx.user.id)
    revalidatePath('/ustawienia/klucze-api')
    return null
  } catch (e) {
    if (e instanceof ApiKeyError) return e.message
    throw e
  }
}
