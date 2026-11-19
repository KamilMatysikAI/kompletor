import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentSession } from '@/lib/panel/kontekst'
import { FormularzLogowania } from './formularz'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Logowanie' }

export default async function Logowanie() {
  if (await currentSession()) redirect('/pulpit')
  return (
    <main className="login">
      <div className="login-box">
        <div className="brand login-brand">
          <b>Kompletor</b>
          <span>zamówienia i wysyłki</span>
        </div>
        <h1>Zaloguj się</h1>
        <p className="muted small">Panel firmy: zamówienia, pakowanie i stany magazynu.</p>
        <FormularzLogowania />
      </div>
      {/* reset hasła mailem (poczta serwera RESET_SMTP_*, nigdy poczta firmy); bez niej hasło startowe nadaje właściciel */}
      <p className="login-foot small muted">
        <Link href="/nie-pamietam-hasla">Nie pamiętam hasła</Link>
      </p>
    </main>
  )
}
