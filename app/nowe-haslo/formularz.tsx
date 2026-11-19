'use client'
// pola z app/ui (hasło z „Pokaż”), przycisk z app/ui. Wynik zostaje banerem (strona bez panelu i bez toastów).
import Link from 'next/link'
import { useActionState } from 'react'
import { Baner, PoleHasla, Przycisk } from '@/app/ui'
import { ustawHasloZLinku, type NoweHasloState } from '../akcje'

const START: NoweHasloState = { error: null, ok: false }

export function FormularzNowegoHasla({ token, min }: { token: string; min: number }) {
  const [state, action, pending] = useActionState(ustawHasloZLinku, START)
  if (state.ok)
    return (
      <Baner ton="sukces" rola="status">
        Hasło zmienione. <Link href="/logowanie">Zaloguj się nowym hasłem</Link>.
      </Baner>
    )
  return (
    <form action={action} className="login-form" noValidate>
      {state.error && <Baner ton="blad">{state.error}</Baner>}
      <input type="hidden" name="t" value={token} />
      <PoleHasla id="haslo" name="haslo" etykieta="Nowe hasło" autoComplete="new-password" minLength={min} maxLength={1024} required autoFocus pomoc={`Co najmniej ${min} znaków. Najprościej: kilka przypadkowych słów.`} />
      <PoleHasla id="haslo2" name="haslo2" etykieta="Powtórz hasło" autoComplete="new-password" minLength={min} maxLength={1024} required />
      <Przycisk wariant="glowny" type="submit" className="login-submit" ladowanie={pending}>
        {pending ? 'Zapisywanie…' : 'Ustaw hasło'}
      </Przycisk>
    </form>
  )
}
