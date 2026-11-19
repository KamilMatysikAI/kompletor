// „Nie pamiętam hasła” — prośba o link do ustawienia nowego hasła (publiczna, bez sesji). Odpowiedź zawsze
// ta sama, mail wysyła worker pocztą instalacji, nigdy pocztą firmy (lib/auth/reset-hasla.ts). Formularz na app/ui.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentSession } from '@/lib/panel/kontekst'
import { FormularzResetu } from './formularz'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Nie pamiętam hasła', robots: { index: false, follow: false } }

export default async function NiePamietamHasla() {
  if (await currentSession()) redirect('/pulpit')
  return (
    <main className="login">
      <div className="login-box">
        <div className="brand login-brand">
          <b>Kompletor</b>
          <span>zamówienia i wysyłki</span>
        </div>
        <h1>Nie pamiętam hasła</h1>
        <p className="muted small">Podaj adres e-mail konta. Wyślemy link do ustawienia nowego hasła (działa 60 minut, jeden raz).</p>
        <FormularzResetu />
      </div>
      <p className="login-foot small muted">
        <Link href="/logowanie">Wróć do logowania</Link>
      </p>
    </main>
  )
}
