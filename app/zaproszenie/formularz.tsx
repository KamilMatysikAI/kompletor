'use client'
// Przyjęcie zaproszenia: zalogowana osoba jednym przyciskiem; inaczej logowanie albo nowe konto. Obie
// drogi zawsze widoczne. Token jedzie w ukrytym polu formularza (POST), hasła nie wracają w stanie formularza.
import { useActionState } from 'react'
import { przyjmijZaproszenie, type ZaproszenieState } from '../akcje'

const START: ZaproszenieState = { error: null }

function Blad({ state }: { state: ZaproszenieState }) {
  return state.error ? (
    <div className="banner red" role="alert">
      <div>{state.error}</div>
    </div>
  ) : null
}

const SEP = { borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 20 }

export function FormularzeZaproszenia({ token, zalogowany, min }: { token: string; zalogowany: string | null; min: number }) {
  const [sesja, przyjmijSesja, czekaSesja] = useActionState(przyjmijZaproszenie, START)
  const [logowanie, przyjmijLogujac, czekaLogowanie] = useActionState(przyjmijZaproszenie, START)
  const [nowe, przyjmijNowe, czekaNowe] = useActionState(przyjmijZaproszenie, START)
  return (
    <>
      {zalogowany && (
        <form action={przyjmijSesja} className="login-form" aria-label="Przyjmij jako zalogowana osoba">
          <input type="hidden" name="t" value={token} />
          <input type="hidden" name="droga" value="sesja" />
          <Blad state={sesja} />
          <p className="small" style={{ margin: 0, overflowWrap: 'anywhere' }}>
            Jesteś zalogowany jako <b>{zalogowany}</b>.
          </p>
          <button className="btn primary login-submit" type="submit" disabled={czekaSesja}>
            {czekaSesja ? 'Przyjmowanie…' : 'Przyjmij zaproszenie'}
          </button>
        </form>
      )}

      <section aria-labelledby="z-mam" style={zalogowany ? SEP : undefined}>
        <h2 id="z-mam" style={{ margin: '12px 0 0', fontSize: 18 }}>
          Mam już konto
        </h2>
        <form action={przyjmijLogujac} className="login-form" style={{ marginTop: 8 }}>
          <input type="hidden" name="t" value={token} />
          <input type="hidden" name="droga" value="logowanie" />
          <Blad state={logowanie} />
          <div className="field">
            <label htmlFor="z-email">E-mail</label>
            <input className="input" id="z-email" name="email" type="email" autoComplete="username" maxLength={254} required />
          </div>
          <div className="field">
            <label htmlFor="z-haslo">Hasło</label>
            <input className="input" id="z-haslo" name="haslo" type="password" autoComplete="current-password" maxLength={1024} required />
          </div>
          <button className="btn primary login-submit" type="submit" disabled={czekaLogowanie}>
            {czekaLogowanie ? 'Logowanie…' : 'Zaloguj się i przyjmij'}
          </button>
        </form>
      </section>

      <section aria-labelledby="z-nowe" style={SEP}>
        <h2 id="z-nowe" style={{ margin: 0, fontSize: 18 }}>
          Nie mam konta
        </h2>
        <form action={przyjmijNowe} className="login-form" style={{ marginTop: 8 }}>
          <input type="hidden" name="t" value={token} />
          <input type="hidden" name="droga" value="nowe" />
          <Blad state={nowe} />
          <div className="field">
            <label htmlFor="n-imie">Imię i nazwisko</label>
            <input className="input" id="n-imie" name="imie" autoComplete="name" maxLength={120} required />
          </div>
          <div className="field">
            <label htmlFor="n-email">E-mail (ten, na który przyszło zaproszenie)</label>
            <input className="input" id="n-email" name="email" type="email" autoComplete="email" maxLength={254} required />
          </div>
          <div className="field">
            <label htmlFor="n-haslo">Hasło</label>
            <input className="input" id="n-haslo" name="haslo" type="password" autoComplete="new-password" minLength={min} maxLength={1024} required aria-describedby="n-haslo-opis" />
            <span id="n-haslo-opis" className="small muted">
              Co najmniej {min} znaków. Najprościej: kilka przypadkowych słów.
            </span>
          </div>
          <div className="field">
            <label htmlFor="n-powtorz">Powtórz hasło</label>
            <input className="input" id="n-powtorz" name="powtorz" type="password" autoComplete="new-password" minLength={min} maxLength={1024} required />
          </div>
          <button className="btn primary login-submit" type="submit" disabled={czekaNowe}>
            {czekaNowe ? 'Zakładanie konta…' : 'Załóż konto i przyjmij'}
          </button>
        </form>
      </section>
    </>
  )
}
