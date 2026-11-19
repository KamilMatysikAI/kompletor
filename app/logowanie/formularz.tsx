'use client'
import { useActionState } from 'react'
import { zaloguj, type LoginState } from '../akcje'

const START: LoginState = { error: null, email: '' }

export function FormularzLogowania() {
  const [state, action, pending] = useActionState(zaloguj, START)
  return (
    <form action={action} className="login-form" noValidate>
      {state.error && (
        <div className="banner red" role="alert">
          <div>{state.error}</div>
        </div>
      )}
      <div className="field">
        <label htmlFor="email">E-mail</label>
        <input className="input" id="email" name="email" type="email" autoComplete="username" required defaultValue={state.email} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="haslo">Hasło</label>
        <input className="input" id="haslo" name="haslo" type="password" autoComplete="current-password" required />
      </div>
      <button className="btn primary login-submit" type="submit" disabled={pending}>
        {pending ? 'Logowanie…' : 'Zaloguj się'}
      </button>
    </form>
  )
}
