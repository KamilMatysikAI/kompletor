'use server'
// Ustawienia → Użytkownicy: dodanie osoby, rola i uprawnienia, wyłączenie dostępu. Tylko z uprawnieniem
// `uzytkownicy`; bezpieczniki (ostatni właściciel, nadawanie tylko posiadanych uprawnień) w lib/panel/uzytkownicy.ts.
// Hasło startowe wraca tylko w stanie formularza (raz, do pokazania) — nie w adresie, nie w logu.
// w hostingu „Dodaj osobę” tworzy zaproszenie; link wraca tak samo jak hasło startowe (raz, w stanie
// formularza). „Cofnij” zaproszenie — tylko w hostingu, na tym samym ekranie. Przy gotowej poczcie firmy
// (Ustawienia → Poczta) link idzie mailem do zaproszonej osoby i nie wraca do formularza.
// akcje zwracają stan (useActionState) zamiast przekierowania: wynik jako toast, błąd w oknie osoby.
import { revalidatePath } from 'next/cache'
import { safeError } from '@/lib/auth/zmiana-hasla'
import { requirePermission } from '@/lib/panel/kontekst'
import type { MemberRole } from '@prisma/client'
import { addMember, MSG_FAIL, revokeInvitation, ROLES, setMemberActive, updateMember, zestawDoZapisu } from '@/lib/panel/uzytkownicy'
import { zaproszeniaPoczta } from '@/lib/poczta/zaproszenia'

export interface DodajState {
  error: string | null
  /** hasło startowe nowego konta — pokazywane raz */
  created: { email: string; password: string } | null
  /** hosting: link zaproszenia do przekazania osobie — pokazywany raz; `link: null` = wysłany przez dostawcę */
  invited: { email: string; link: string | null } | null
  info: string | null
  round: number
}

/** Wynik zapisu osoby, przełączenia dostępu i cofnięcia zaproszenia (toast; `ok: false` = błąd). */
export interface StanOsoby {
  ok?: boolean
  komunikat?: string
}

const PATH = '/ustawienia/uzytkownicy'
const str = (form: FormData, k: string, max: number) => String(form.get(k) ?? '').slice(0, max)
const logFail = (where: string, e: unknown) => console.error(`[uzytkownicy] ${where}: ${safeError(e)}`)

/**
 * Rola i uprawnienia z formularza. Ekran wysyła pełny zaznaczony zestaw (`zestaw=pelny`): z niego wynikają dołożone
 * i odebrane względem roli. Formularz bez znacznika (strona otwarta przed wdrożeniem) wysyła jak dawniej same dodatkowe
 * uprawnienia; wtedy nic nie jest odbierane. Bezpieczniki i tak sprawdza serwer (lib/panel/uzytkownicy.ts).
 */
function rolaIUprawnienia(form: FormData): { role: string; permissions: string[]; denied: string[] } {
  const role = str(form, 'rola', 20)
  const zaznaczone = form.getAll('uprawnienia').map(String)
  if (form.get('zestaw') !== 'pelny' || !(ROLES as string[]).includes(role)) return { role, permissions: zaznaczone, denied: [] }
  return { role, ...zestawDoZapisu(role as MemberRole, zaznaczone) }
}

export async function dodajOsobe(prev: DodajState, form: FormData): Promise<DodajState> {
  const ctx = await requirePermission('uzytkownicy')
  const email = str(form, 'email', 254)
  const actor = { userId: ctx.user.id, organizationId: ctx.organization.organizationId }
  let r: Awaited<ReturnType<typeof addMember>>
  try {
    r = await addMember(actor, { email, name: str(form, 'imie', 120), ...rolaIUprawnienia(form) }, { sender: zaproszeniaPoczta(ctx.db, process.env) })
  } catch (e) {
    logFail('dodanie', e)
    return { error: MSG_FAIL, created: null, invited: null, info: null, round: prev.round }
  }
  if (!r.ok) return { error: r.message, created: null, invited: null, info: null, round: prev.round }
  revalidatePath(PATH)
  const shown = email.trim().toLowerCase()
  if (r.kind === 'invited') return { error: null, created: null, invited: { email: shown, link: r.link }, info: null, round: prev.round + 1 }
  if (r.password) return { error: null, created: { email: shown, password: r.password }, invited: null, info: null, round: prev.round + 1 }
  // self-host: konto należy do osoby, więc jej imię i nazwisko z formularza nie nadpisuje danych konta
  return {
    error: null,
    created: null,
    invited: null,
    info: 'Konto o tym adresie już istniało — dodano dostęp do firmy, hasło bez zmian, imię i nazwisko zostają takie, jak w koncie.',
    round: prev.round + 1,
  }
}

export async function cofnijZaproszenie(_prev: StanOsoby, form: FormData): Promise<StanOsoby> {
  const ctx = await requirePermission('uzytkownicy')
  const id = str(form, 'zaproszenie', 64)
  try {
    const r = await revokeInvitation({ userId: ctx.user.id, organizationId: ctx.organization.organizationId }, id)
    revalidatePath(PATH)
    return r.ok ? { ok: true, komunikat: 'Zaproszenie cofnięte — link już nie działa.' } : { ok: false, komunikat: r.message }
  } catch (e) {
    logFail('cofnięcie zaproszenia', e)
    return { ok: false, komunikat: MSG_FAIL }
  }
}

export async function zapiszOsobe(_prev: StanOsoby, form: FormData): Promise<StanOsoby> {
  const ctx = await requirePermission('uzytkownicy')
  const userId = str(form, 'osoba', 64)
  try {
    const r = await updateMember({ userId: ctx.user.id, organizationId: ctx.organization.organizationId }, userId, rolaIUprawnienia(form))
    revalidatePath(PATH)
    return r.ok ? { ok: true, komunikat: 'Zapisano. Zmiana działa od następnego kliknięcia tej osoby.' } : { ok: false, komunikat: r.message }
  } catch (e) {
    logFail('zmiana', e)
    return { ok: false, komunikat: MSG_FAIL }
  }
}

export async function przelaczDostep(_prev: StanOsoby, form: FormData): Promise<StanOsoby> {
  const ctx = await requirePermission('uzytkownicy')
  const userId = str(form, 'osoba', 64)
  const active = form.get('dostep') === 'wlacz'
  try {
    const r = await setMemberActive({ userId: ctx.user.id, organizationId: ctx.organization.organizationId }, userId, active)
    revalidatePath(PATH)
    if (!r.ok) return { ok: false, komunikat: r.message }
    return { ok: true, komunikat: active ? 'Dostęp włączony.' : 'Dostęp wyłączony, sesje tej osoby w firmie zakończone.' }
  } catch (e) {
    logFail('dostęp', e)
    return { ok: false, komunikat: MSG_FAIL }
  }
}
