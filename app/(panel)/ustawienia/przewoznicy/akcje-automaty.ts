'use server'
// Ustawienia → Przewoźnicy → „Automatyczne statusy wysyłki”. Tylko z uprawnieniem ustawień firmy.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { modulySledzenia } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { type AutomatyWysylki, type SledzeniePrzewoznikow, zapiszAutomatyWysylki, zapiszRegulyDrogi, zapiszSledzeniePrzewoznikow } from '@/lib/wysylka/automaty'

export interface StanAutomatow {
  ok?: boolean
  komunikat?: string
  automaty?: AutomatyWysylki
  sledzenie?: SledzeniePrzewoznikow
  reguly?: SledzeniePrzewoznikow
}

export async function zapiszAutomaty(_prev: StanAutomatow, form: FormData): Promise<StanAutomatow> {
  const ctx = await requirePermission('ustawienia')
  const tak = (k: string) => form.get(k) === 'tak'
  try {
    const automaty = await zapiszAutomatyWysylki(ctx.db, { wyslanePoPrzyjezdzie: tak('wyslanePoPrzyjezdzie'), sledzenie: tak('sledzenie'), anulowanieWKanale: tak('anulowanieWKanale'), sledzenieDoDoreczenia: tak('sledzenieDoDoreczenia'), odebranePoDoreczeniu: tak('odebranePoDoreczeniu'), powiadomieniaODrodze: tak('powiadomieniaODrodze'), linkSledzeniaDoSklepu: tak('linkSledzeniaDoSklepu'), dodatkowaPrzesylka: tak('dodatkowaPrzesylka') }, ctx.user.id)
    // moduły ze śledzeniem z rejestru: brak pola w formularzu = wyłączony (przełącznik niezaznaczony)
    const moduly = modulySledzenia(defaultRegistry()).map((m) => m.adapterKey)
    const sledzenie = await zapiszSledzeniePrzewoznikow(ctx.db, Object.fromEntries(moduly.map((k) => [k, tak(`sledzenie:${k}`)])), moduly, ctx.user.id)
    const reguly = await zapiszRegulyDrogi(ctx.db, Object.fromEntries(moduly.map((k) => [k, tak(`reguly:${k}`)])), moduly, ctx.user.id)
    revalidatePath('/ustawienia/przewoznicy')
    revalidatePath('/pakowanie')
    return { ok: true, komunikat: 'Zapisano automatyczne statusy wysyłki.', automaty, sledzenie, reguly }
  } catch {
    return { ok: false, komunikat: 'Nie udało się zapisać — spróbuj ponownie' }
  }
}
