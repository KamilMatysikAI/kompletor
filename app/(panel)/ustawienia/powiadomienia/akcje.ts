'use server'
// Ustawienia → Powiadomienia: zapis ustawień Zulipa i wiadomość próbna. Tylko z uprawnieniem ustawień
// firmy; zapis wyłącznie przez saveNotificationSettings (walidacja + AuditLog) z id zalogowanej osoby.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { isGroup, NotificationConfigError } from '@/lib/powiadomienia/adres'
import { parseNotificationForm, saveNotificationSettings, sendTestNotification } from '@/lib/powiadomienia/ustawienia'
import { zapiszProg } from '@/lib/integracje/zdrowie'

const PATH = '/ustawienia/powiadomienia'

export async function zapiszPowiadomienia(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  let blad: string | null = null
  try {
    await saveNotificationSettings(ctx.db, parseNotificationForm(form), ctx.user.id, process.env)
  } catch (e) {
    // komunikaty walidacji pokazujemy; błąd bazy — bez szczegółów
    blad = e instanceof NotificationConfigError ? e.message : 'Nie udało się zapisać — spróbuj ponownie'
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(blad ? { blad } : { zapisano: '1' })}`)
}

/** próg automatycznego wyłączenia integracji (kolejne błędy połączenia jednego konta). */
export async function zapiszProgWylaczenia(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  let blad: string | null = null
  try {
    await zapiszProg(ctx.db, Number(String(form.get('prog') ?? '').trim()))
  } catch (e) {
    blad = e instanceof Error && e.message.startsWith('Próg') ? e.message : 'Nie udało się zapisać — spróbuj ponownie'
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(blad ? { blad } : { zapisano: '1' })}`)
}

export async function wyslijProbna(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const group = String(form.get('grupa') ?? '')
  if (!isGroup(group)) redirect(PATH)
  let r: Awaited<ReturnType<typeof sendTestNotification>>
  try {
    r = await sendTestNotification(ctx.db, process.env, group, ctx.user.id, (u, i) => globalThis.fetch(u, i))
  } catch {
    r = { ok: false, error: 'Nie udało się wysłać — spróbuj ponownie' }
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(r.ok ? { proba: 'ok' } : { proba: 'blad', blad: r.error.slice(0, 200) })}`)
}
