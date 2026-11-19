'use client'
// Zmiana hasła. Pola z app/ui (etykieta, opis, „Pokaż”), wynik zapisu jako toast; błąd zostaje przy
// formularzu, bo trzeba go poprawić. Po haśle startowym zostaje też baner z przejściem na pulpit.
import { useActionState } from 'react'
import { Baner, PoleHasla, Przycisk, ToastPoAkcji } from '@/app/ui'
import { zmienHaslo, type HasloState } from './akcje'

const START: HasloState = { error: null, ok: false, round: 0 }

export function FormularzHasla({ min, startowe = false }: { min: number; startowe?: boolean }) {
  const [state, action, pending] = useActionState(zmienHaslo, START)
  return (
    <>
      <ToastPoAkcji stan={state} sukces="Hasło zmienione. Inne urządzenia zostały wylogowane." bledy={false} />
      <form key={state.round} action={action} className="login-form" style={{ marginTop: 0 }} aria-label="Zmiana hasła">
        {state.ok && startowe && (
          <Baner ton="sukces" rola="status">
            Hasło zmienione. <a href="/pulpit">Przejdź do pulpitu</a>
          </Baner>
        )}
        {state.error && <Baner ton="blad">{state.error}</Baner>}
        <PoleHasla id="obecne" name="obecne" etykieta={startowe ? 'Obecne hasło (startowe)' : 'Obecne hasło'} autoComplete="current-password" required />
        <PoleHasla id="nowe" name="nowe" etykieta="Nowe hasło" autoComplete="new-password" minLength={min} maxLength={1024} required pomoc={`Co najmniej ${min} znaków. Najprościej: kilka przypadkowych słów.`} />
        <PoleHasla id="powtorz" name="powtorz" etykieta="Powtórz nowe hasło" autoComplete="new-password" minLength={min} maxLength={1024} required />
        <Przycisk wariant="glowny" type="submit" className="login-submit" ladowanie={pending}>
          {pending ? 'Zmienianie…' : 'Zmień hasło'}
        </Przycisk>
      </form>
    </>
  )
}
