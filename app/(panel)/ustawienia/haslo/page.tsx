// Ustawienia → Hasło: zmiana własnego hasła, dla każdej zalogowanej osoby.
// przy haśle startowym to jedyny dostępny ekran panelu; „Zakończ pozostałe sesje” bez hasła.
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/hasla'
import { requireSession } from '@/lib/panel/kontekst'
import { FormularzHasla } from './formularz'
import { ZakonczSesje } from './sesje'

export const metadata = { title: 'Zmiana hasła' }

export default async function Haslo() {
  const ctx = await requireSession()
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Zmiana hasła</h1>
          <div className="sub" style={{ overflowWrap: 'anywhere' }}>
            Konto {ctx.user.email}. Po zmianie hasła wylogujemy Cię na innych urządzeniach; tu zostajesz zalogowany.
          </div>
        </div>
      </header>
      {ctx.mustChangePassword && (
        <div className="banner red" role="alert" style={{ maxWidth: 480 }}>
          <div>
            <b>Ustaw własne hasło.</b> Hasło startowe zna osoba, która je nadała. Do czasu zmiany panel pokazuje tylko ten ekran.
          </div>
        </div>
      )}
      <div className="stack">
        <section className="card" style={{ maxWidth: 480 }}>
          <FormularzHasla min={MIN_PASSWORD_LENGTH} startowe={ctx.mustChangePassword} />
        </section>
        <section className="card" style={{ maxWidth: 480 }} aria-labelledby="h-sesje">
          <div className="card-head">
            <h2 id="h-sesje">Inne urządzenia</h2>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Podejrzewasz, że ktoś inny korzysta z Twojego konta? Wyloguj wszystkie pozostałe przeglądarki i urządzenia — bez podawania hasła, także gdy konto jest chwilowo zablokowane po błędnych próbach.
          </p>
          <ZakonczSesje />
        </section>
      </div>
    </>
  )
}
