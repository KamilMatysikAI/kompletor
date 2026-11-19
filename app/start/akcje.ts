'use server'
// Akcja kreatora pierwszego uruchomienia. Jak logowanie (app/akcje.ts): Next sprawdza Origin akcji
// serwera, ciasteczko sesji httpOnly + SameSite=Lax (+ Secure i __Host- w produkcji). Bez sesji z definicji (jeszcze
// nie ma kont), więc bramką jest kod instalacji i warunek „zero kont” w lib/instalacja/kreator.ts.
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { clientIp } from '@/lib/auth/limiter'
import { SESSION_COOKIE, sessionCookieOpts } from '@/lib/auth/sesja-ciasteczko'
import { wykonajKreator } from '@/lib/instalacja/kreator'

export interface StartState {
  error: string | null
  nazwaFirmy: string
  imie: string
  email: string
  /** wybrany szablon przepływu (pusty = bez szablonu) */
  szablon?: string
}

export async function zalozFirme(_prev: StartState, form: FormData): Promise<StartState> {
  const pole = (k: string, max = 254) => String(form.get(k) ?? '').slice(0, max)
  const back = { nazwaFirmy: pole('nazwaFirmy', 120), imie: pole('imie', 120), email: pole('email'), szablon: pole('szablon', 40) }
  const h = await headers()
  const r = await wykonajKreator({
    kod: pole('kod', 200),
    ...back,
    haslo: String(form.get('haslo') ?? ''),
    tryb: form.get('tryb') === 'demo' ? 'demo' : 'firma',
    ip: clientIp(h),
    userAgent: h.get('user-agent'),
  })
  if (!r.ok) {
    if (r.zamkniety) redirect('/logowanie')
    return { error: r.blad, ...back }
  }
  ;(await cookies()).set(SESSION_COOKIE, r.token, sessionCookieOpts(r.expiresAt))
  redirect('/pulpit')
}
