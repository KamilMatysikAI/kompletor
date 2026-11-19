'use server'
// Akcje serwera logowania. Next sprawdza nagłówek Origin akcji serwera (ochrona przed CSRF), ciasteczko
// sesji jest httpOnly + SameSite=Lax (+ Secure i prefiks __Host- w produkcji). Logika i limity: lib/auth/logowanie.ts.
// przyjęcie zaproszenia do firmy ze strony /zaproszenie (bez sesji firmy, więc tutaj, przy logowaniu —
// nie w app/zaproszenie): logika, limit per IP i komunikaty w lib/auth/zaproszenia.ts. Token tylko z pola formularza,
// nigdy do logu; wejście GET na stronę niczego nie przyjmuje.
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { gestoscZ } from '@/lib/panel/gestosc'
import { MOTYW_CIASTECZKO, motywZ } from '@/lib/panel/motyw'
import { zKolumnami } from '@/lib/panel/kolumny'
import { zIgnorowanym } from '@/lib/panel/alerty-listy'
import { systemPrisma } from '@/lib/db'
import { attemptLogin } from '@/lib/auth/logowanie'
import { clientIp } from '@/lib/auth/limiter'
import { logout, resolveSession, SESSION_COOKIE, switchOrganization } from '@/lib/auth/sesje'
import { sessionCookieOpts } from '@/lib/auth/sesja-ciasteczko'
import { attemptAccept, MSG_INVITE_FAIL, type AcceptInput } from '@/lib/auth/zaproszenia'
import { poprosOReset, ustawNoweHaslo } from '@/lib/auth/reset-hasla'
import { utworzWlasnaFirme } from '@/lib/instalacja/kreator'

export interface LoginState {
  error: string | null
  email: string
}

const cookieOpts = sessionCookieOpts

export async function zaloguj(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '').slice(0, 254)
  const password = String(form.get('haslo') ?? '')
  const h = await headers()
  const r = await attemptLogin(systemPrisma(), { email, password, ip: clientIp(h), userAgent: h.get('user-agent') })
  if (!r.ok) return { error: r.message, email }
  ;(await cookies()).set(SESSION_COOKIE, r.token, cookieOpts(r.expiresAt))
  redirect('/pulpit')
}

export async function wyloguj(): Promise<void> {
  const jar = await cookies()
  await logout(systemPrisma(), jar.get(SESSION_COOKIE)?.value)
  // Kasowanie przez set z tymi samymi atrybutami (Secure): przeglądarka odrzuca usunięcie __Host- bez Secure.
  jar.set(SESSION_COOKIE, '', cookieOpts(new Date(0)))
  redirect('/logowanie')
}

export async function zmienFirme(form: FormData): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const org = String(form.get('firma') ?? '')
  if (!token) redirect('/logowanie')
  const ok = await switchOrganization(systemPrisma(), token, org)
  redirect(ok ? '/pulpit' : '/pulpit?firma=brak-dostepu')
}

export interface WlasnaFirmaState {
  error: string | null
  nazwa: string
}

/**
 * „Utwórz własną firmę” z pulpitu firmy demo (self-host). Warunki (właściciel demo, brak innej firmy) i zapis
 * w lib/instalacja/kreator.ts; po sukcesie sesja przechodzi do nowej firmy (ta sama droga co przełącznik firm).
 */
export async function utworzWlasnaFirmeZDemo(_prev: WlasnaFirmaState, form: FormData): Promise<WlasnaFirmaState> {
  const nazwa = String(form.get('nazwa') ?? '').slice(0, 200)
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const s = await resolveSession(systemPrisma(), token)
  if (!s || !token) redirect('/logowanie')
  const r = await utworzWlasnaFirme({ userId: s.user.id, nazwa, zostawDemo: form.get('zostawDemo') === 'on' })
  if (!r.ok) return { error: r.blad, nazwa }
  await switchOrganization(systemPrisma(), token, r.organizationId)
  revalidatePath('/', 'layout')
  redirect('/pulpit?firma=nowa')
}

/**
 * gęstość panelu wybrana przez osobę (zapis w `User.gestosc`, działa na każdym urządzeniu po zalogowaniu).
 * Bez sesji nic nie zapisuje; wartość spoza listy = domyślna.
 */
export async function zmienGestosc(form: FormData): Promise<void> {
  const jar = await cookies()
  const s = await resolveSession(systemPrisma(), jar.get(SESSION_COOKIE)?.value)
  if (!s) redirect('/logowanie')
  await systemPrisma().user.update({ where: { id: s.user.id }, data: { gestosc: gestoscZ(form.get('gestosc')) } })
  revalidatePath('/', 'layout')
}

/**
 * motyw panelu (jasny, ciemny, jak system) w ciasteczku przeglądarki na rok. To ustawienie urządzenia, nie
 * konta, więc nie wymaga sesji ani zapisu w bazie; wartość spoza listy = domyślna. Ciasteczko nie niesie nic poufnego.
 */
export async function zmienMotyw(form: FormData): Promise<void> {
  const jar = await cookies()
  jar.set(MOTYW_CIASTECZKO, motywZ(form.get('motyw')), { path: '/', sameSite: 'lax', httpOnly: true, secure: SESSION_COOKIE.startsWith('__Host-'), maxAge: 60 * 60 * 24 * 365 })
  revalidatePath('/', 'layout')
}

/** ukryte kolumny tabeli zapisane na koncie osoby (wybór „Kolumny” działa na każdym komputerze). */
export async function zapiszKolumny(tabela: string, ukryte: string[]): Promise<void> {
  const jar = await cookies()
  const s = await resolveSession(systemPrisma(), jar.get(SESSION_COOKIE)?.value)
  if (!s) return
  const nowe = zKolumnami(s.kolumnyTabel, tabela, ukryte)
  if (!nowe) return
  await systemPrisma().user.update({ where: { id: s.user.id }, data: { kolumnyTabel: nowe } })
}

/**
 * „Ignoruj” przy alercie nad listą zamówień. Chowa alert tej osobie w bieżącej firmie, dopóki nie zmieni się
 * jego liczba (podpis). Pisze tylko `User.ukryteAlerty` osoby z sesji; rodzaj i podpis walidowane (lib/panel/alerty-listy.ts).
 */
export async function ignorujAlert(form: FormData): Promise<void> {
  const jar = await cookies()
  const s = await resolveSession(systemPrisma(), jar.get(SESSION_COOKIE)?.value)
  if (!s) redirect('/logowanie')
  const nowe = zIgnorowanym(s.ukryteAlerty, s.organization.organizationId, String(form.get('rodzaj') ?? ''), String(form.get('podpis') ?? ''))
  if (nowe) await systemPrisma().user.update({ where: { id: s.user.id }, data: { ukryteAlerty: nowe } })
  revalidatePath('/zamowienia')
}

export interface ZaproszenieState {
  error: string | null
}

/** Przyjęcie zaproszenia: `droga` = sesja (zalogowana osoba), logowanie albo nowe konto. Sukces = pulpit w tej firmie. */
export async function przyjmijZaproszenie(_prev: ZaproszenieState, form: FormData): Promise<ZaproszenieState> {
  const val = (k: string, max: number) => String(form.get(k) ?? '').slice(0, max)
  const token = val('t', 200)
  const droga = val('droga', 20)
  const jar = await cookies()
  const sys = systemPrisma()
  const current = jar.get(SESSION_COOKIE)?.value
  let input: AcceptInput
  if (droga === 'sesja') {
    const s = await resolveSession(sys, current)
    if (!s) return { error: MSG_INVITE_FAIL }
    input = { kind: 'session', token, userId: s.user.id }
  } else if (droga === 'logowanie') {
    input = { kind: 'login', token, email: val('email', 254), password: val('haslo', 1100) }
  } else {
    input = { kind: 'new', token, email: val('email', 254), name: val('imie', 120), password: val('haslo', 1100), repeat: val('powtorz', 1100) }
  }
  const h = await headers()
  const r = await attemptAccept(sys, input, { ip: clientIp(h), userAgent: h.get('user-agent') })
  if (!r.ok) return { error: r.message }
  if (r.session) {
    // poprzednia sesja w tej przeglądarce (np. innego konta) się kończy
    await logout(sys, current)
    jar.set(SESSION_COOKIE, r.session.token, cookieOpts(r.session.expiresAt))
  } else if (current) {
    await switchOrganization(sys, current, r.organizationId)
  }
  redirect('/pulpit')
}

// ───: reset hasła mailem ──────────────────────────────────────────
// Prośba zawsze kończy się tym samym komunikatem (bez wyroczni „czy konto istnieje”); mail wysyła worker z kolejki.
// Token z linku tylko z pola formularza, nigdy do logu.

export interface ResetState {
  message: string | null
  error: string | null
}

export async function poprosONoweHaslo(_prev: ResetState, form: FormData): Promise<ResetState> {
  const email = String(form.get('email') ?? '').slice(0, 254)
  const h = await headers()
  const r = await poprosOReset(systemPrisma(), { email, ip: clientIp(h) })
  return r.ok ? { message: r.message, error: null } : { message: null, error: r.message }
}

export interface NoweHasloState {
  error: string | null
  ok: boolean
}

export async function ustawHasloZLinku(_prev: NoweHasloState, form: FormData): Promise<NoweHasloState> {
  const h = await headers()
  const r = await ustawNoweHaslo(systemPrisma(), {
    token: String(form.get('t') ?? '').slice(0, 200),
    next: String(form.get('haslo') ?? ''),
    repeat: String(form.get('haslo2') ?? ''),
    ip: clientIp(h),
  })
  return r.ok ? { error: null, ok: true } : { error: r.message, ok: false }
}
