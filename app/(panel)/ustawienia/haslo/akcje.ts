'use server'
// Zmiana własnego hasła: każda zalogowana osoba. Obecne hasło wymagane, limit prób jak przy logowaniu,
// po zmianie pozostałe sesje tej osoby są kończone (bieżąca zostaje). Hasła nie wracają w stanie formularza.
// „Zakończ pozostałe sesje” bez hasła — działa także w czasie blokady konta. Ten ekran i jego akcje
// są jedynymi dostępnymi przy haśle startowym (requireSession rozpoznaje adres /ustawienia/haslo).
// po zmianie hasła startowego od razu pulpit (sesja zostaje), zamiast ekranu hasła z banerem „Przejdź do pulpitu”.
// revalidatePath(layout): layout panelu był okrojonym szkieletem i klient Next trzymałby go w pamięci — pulpit
// bez menu, z banerem „Najpierw ustaw własne hasło”.
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { clientIp } from '@/lib/auth/limiter'
import { safeError } from '@/lib/auth/zmiana-hasla'
import { requireSession } from '@/lib/panel/kontekst'
import { changeOwnPasswordFromPanel, endOtherSessionsFromPanel } from '@/lib/panel/uzytkownicy'

export interface HasloState {
  error: string | null
  ok: boolean
  round: number
}

export interface SesjeState {
  error: string | null
  /** liczba zakończonych sesji po ostatnim kliknięciu */
  ended: number | null
}

export async function zmienHaslo(prev: HasloState, form: FormData): Promise<HasloState> {
  const ctx = await requireSession()
  const val = (k: string) => String(form.get(k) ?? '').slice(0, 1100)
  const r = await changeOwnPasswordFromPanel(
    { userId: ctx.user.id, organizationId: ctx.organization.organizationId, sessionId: ctx.sessionId },
    { current: val('obecne'), next: val('nowe'), repeat: val('powtorz'), ip: clientIp(await headers()) },
  )
  if (r.ok && ctx.mustChangePassword) {
    revalidatePath('/', 'layout')
    redirect('/pulpit')
  }
  return r.ok ? { error: null, ok: true, round: prev.round + 1 } : { error: r.message, ok: false, round: prev.round }
}

export async function zakonczSesje(_prev: SesjeState, _form: FormData): Promise<SesjeState> {
  const ctx = await requireSession()
  try {
    const n = await endOtherSessionsFromPanel({ userId: ctx.user.id, organizationId: ctx.organization.organizationId, sessionId: ctx.sessionId })
    return n === null ? { error: 'Ta sesja już wygasła. Zaloguj się ponownie.', ended: null } : { error: null, ended: n }
  } catch (e) {
    console.error(`[haslo] sesje: ${safeError(e)}`)
    return { error: 'Nie udało się zakończyć sesji (baza danych nie odpowiada). Spróbuj za minutę.', ended: null }
  }
}
