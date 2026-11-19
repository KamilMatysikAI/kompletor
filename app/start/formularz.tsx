'use client'
import { useActionState, useState } from 'react'
import { zalozFirme, type StartState } from './akcje'

/** szablony przepływów do wyboru (id, nazwa, dla kogo) — lista z serwera, bez importu silnika do klienta. */
export interface OpcjaSzablonu {
  id: string
  nazwa: string
  dlaKogo: string
}

const START: StartState = { error: null, nazwaFirmy: '', imie: '', email: '', szablon: '' }

export function FormularzStartu({ kod, pytajONazwe, szablony = [] }: { kod: string; pytajONazwe: boolean; szablony?: OpcjaSzablonu[] }) {
  const [state, action, pending] = useActionState(zalozFirme, START)
  const [wybrany, setWybrany] = useState<string | null>(null) // null = bez zmiany od ostatniej odpowiedzi serwera
  const dlaKogo = szablony.find((s) => s.id === (wybrany ?? state.szablon))?.dlaKogo
  return (
    <form action={action} className="login-form" noValidate>
      {state.error && (
        <div className="banner red" role="alert">
          <div>{state.error}</div>
        </div>
      )}
      <div className="field">
        <label htmlFor="kod">Kod instalacji</label>
        <input className="input mono" id="kod" name="kod" type="text" autoComplete="off" spellCheck={false} required defaultValue={kod} />
      </div>
      {pytajONazwe && (
        <div className="field">
          <label htmlFor="nazwaFirmy">Nazwa firmy</label>
          <input className="input" id="nazwaFirmy" name="nazwaFirmy" type="text" autoComplete="organization" maxLength={120} defaultValue={state.nazwaFirmy} autoFocus />
        </div>
      )}
      {pytajONazwe && szablony.length > 0 && (
        <div className="field">
          <label htmlFor="szablon">Jak pracujesz z zamówieniami</label>
          <select className="input" id="szablon" name="szablon" defaultValue={state.szablon ?? ''} aria-describedby="szablon-pomoc" onChange={(e) => setWybrany(e.target.value)}>
            <option value="">Wybiorę później</option>
            {szablony.map((s) => (
              <option key={s.id} value={s.id} title={s.dlaKogo}>
                {s.nazwa}
              </option>
            ))}
          </select>
          <p className="muted small" id="szablon-pomoc">
            {dlaKogo ? `Dla kogo: ${dlaKogo} ` : ''}Gotowe statusy i automatyczne akcje. Zmienisz je potem w Ustawieniach → Sprzedaż i kanały → Automatyczne akcje.
          </p>
        </div>
      )}
      <div className="field">
        <label htmlFor="imie">Imię</label>
        <input className="input" id="imie" name="imie" type="text" autoComplete="name" maxLength={120} required defaultValue={state.imie} />
      </div>
      <div className="field">
        <label htmlFor="email">E-mail</label>
        <input className="input" id="email" name="email" type="email" autoComplete="username" required defaultValue={state.email} />
      </div>
      <div className="field">
        <label htmlFor="haslo">Hasło (co najmniej 12 znaków)</label>
        <input className="input" id="haslo" name="haslo" type="password" autoComplete="new-password" minLength={12} required />
      </div>
      <button className="btn primary login-submit" type="submit" name="tryb" value="firma" disabled={pending}>
        {pending ? 'Zakładanie…' : pytajONazwe ? 'Załóż firmę' : 'Załóż konto właściciela'}
      </button>
      {pytajONazwe && (
        <button className="btn login-submit" type="submit" name="tryb" value="demo" disabled={pending}>
          Najpierw zobacz demo
        </button>
      )}
      {pytajONazwe && <p className="muted small">Demo zakłada firmę „Sklep Demo” z danymi fikcyjnymi, a Ty zostajesz jej właścicielem. Własną firmę dodasz później poleceniem z README.</p>}
    </form>
  )
}
