'use client'
// „Zakończ pozostałe sesje”: bez hasła, więc działa także, gdy konto jest zablokowane po błędnych
// próbach (np. ktoś zna e-mail i podtrzymuje blokadę). Bieżąca sesja zostaje.
import { useActionState } from 'react'
import { zakonczSesje, type SesjeState } from './akcje'

const START: SesjeState = { error: null, ended: null }

/** „zakończono 1 sesję / 2 sesje / 5 sesji” */
export function sesjeTekst(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  const word = n === 1 ? 'sesję' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'sesje' : 'sesji'
  return `Zakończono ${n} ${word}.`
}

export function ZakonczSesje() {
  const [state, action, pending] = useActionState(zakonczSesje, START)
  return (
    <form action={action} aria-label="Zakończ pozostałe sesje">
      {state.ended !== null && (
        <div className="banner leaf-soft" role="status" style={{ marginTop: 0 }}>
          <div>{state.ended === 0 ? 'Nie było innych sesji.' : `${sesjeTekst(state.ended)} Ta przeglądarka zostaje zalogowana.`}</div>
        </div>
      )}
      {state.error && (
        <div className="banner red" role="alert">
          <div>{state.error}</div>
        </div>
      )}
      <button className="btn danger" type="submit" disabled={pending}>
        {pending ? 'Kończenie…' : 'Zakończ pozostałe sesje'}
      </button>
    </form>
  )
}
