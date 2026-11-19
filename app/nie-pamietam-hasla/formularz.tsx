'use client'
// pola i przyciski z app/ui. Wynik prośby zostaje banerem zamiast formularza (strona bez panelu i bez toastów).
import { useActionState } from 'react'
import { Baner, PoleTekstowe, Przycisk } from '@/app/ui'
import { poprosONoweHaslo, type ResetState } from '../akcje'

const START: ResetState = { message: null, error: null }

export function FormularzResetu() {
  const [state, action, pending] = useActionState(poprosONoweHaslo, START)
  if (state.message)
    return (
      <Baner ton="sukces" rola="status">
        {state.message}
      </Baner>
    )
  return (
    <form action={action} className="login-form" noValidate>
      {state.error && <Baner ton="blad">{state.error}</Baner>}
      <PoleTekstowe id="email" name="email" type="email" etykieta="E-mail" autoComplete="username" required autoFocus />
      <Przycisk wariant="glowny" type="submit" className="login-submit" ladowanie={pending}>
        {pending ? 'Wysyłanie…' : 'Wyślij link'}
      </Przycisk>
    </form>
  )
}
