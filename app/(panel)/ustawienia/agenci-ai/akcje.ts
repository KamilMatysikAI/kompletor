'use server'
// Ustawienia → Agenci AI: utworzenie klucza agenta. Tylko z uprawnieniem ustawień firmy; zapis wyłącznie
// przez lib/api/zarzadzanie.ts (ten sam mechanizm co Klucze API: SHA-256 w bazie, AuditLog bez wartości klucza).
// Zakres zawsze z listy MCP_SCOPES (dziś tylko `mcp:odczyt`), niezależnie od tego, co przyśle formularz. Pełny klucz
// wraca tylko w stanie formularza po utworzeniu — nie trafia do bazy, logu ani adresu strony.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { ApiKeyError, createApiKey, type ApiKeyFormState } from '@/lib/api/zarzadzanie'
import { MCP_SCOPES } from '@/lib/api/zakresy'
import { usunKluczAi, zapiszDostawceAi } from '@/lib/ai'

export async function utworzKluczAgenta(_prev: ApiKeyFormState, form: FormData): Promise<ApiKeyFormState> {
  const ctx = await requirePermission('ustawienia')
  const name = form.get('nazwa')
  const scopes = form.getAll('zakres').filter((s): s is string => typeof s === 'string')
  try {
    if (scopes.some((s) => !(MCP_SCOPES as readonly string[]).includes(s))) throw new ApiKeyError('Klucz agenta może mieć tylko zakresy MCP. Klucze dla innych systemów: Ustawienia → Integracje i agenci AI → Klucze API.')
    const k = await createApiKey(ctx.db, { name, scopes: scopes.length ? scopes : ['mcp:odczyt'] }, ctx.user.id)
    revalidatePath('/ustawienia/agenci-ai')
    revalidatePath('/ustawienia/klucze-api')
    return { error: null, created: { name: typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '', token: k.token, prefix: k.prefix } }
  } catch (e) {
    if (e instanceof ApiKeyError) return { error: e.message, created: null }
    throw e
  }
}

// sekcja „Dostawca AI” (opisy produktów i packshoty). Klucze wyłącznie do sekretów firmy (zaszyfrowane),
// w stanie formularza nigdy nie wracają.
export interface StanDostawcyAi {
  ok: boolean
  komunikat: string | null
  field?: string | null
}

export async function zapiszDostawceAiAkcja(_prev: StanDostawcyAi, form: FormData): Promise<StanDostawcyAi> {
  const ctx = await requirePermission('ustawienia')
  const co = String(form.get('co') ?? 'zapisz')
  if (co === 'usun-tekst' || co === 'usun-obrazy') {
    const ok = await usunKluczAi(ctx.db, co === 'usun-tekst' ? 'tekst' : 'obrazy', ctx.user.id)
    revalidatePath('/ustawienia/agenci-ai')
    return { ok, komunikat: ok ? 'Klucz usunięty.' : 'Tego klucza już nie było.' }
  }
  const r = await zapiszDostawceAi(ctx.db, { model: form.get('model'), packshot: form.get('packshot'), klucz: form.get('klucz'), kluczObrazow: form.get('kluczObrazow'), asystent: form.get('asystent') }, process.env, ctx.user.id)
  if (!r.ok) return { ok: false, komunikat: r.error, field: r.field ?? null }
  revalidatePath('/ustawienia/agenci-ai')
  revalidatePath('/produkty')
  revalidatePath('/', 'layout') // dymek asystenta w layoucie panelu
  return { ok: true, komunikat: r.zmiany.length ? 'Zapisano.' : 'Bez zmian.' }
}
