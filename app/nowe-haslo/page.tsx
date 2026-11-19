// ustawienie nowego hasła z jednorazowego linku z maila (publiczne, bez sesji; nagłówki no-referrer i
// noindex z proxy.ts). Wejście GET niczego nie zmienia: hasło ustawia dopiero wysłany formularz. app/ui.
import Link from 'next/link'
import { Baner } from '@/app/ui'
import { linkWazny, MSG_RESET_ZLY_LINK } from '@/lib/auth/reset-hasla'
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/hasla'
import { systemPrisma } from '@/lib/db'
import { FormularzNowegoHasla } from './formularz'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Nowe hasło', robots: { index: false, follow: false } }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function NoweHaslo({ searchParams }: Props) {
  const sp = await searchParams
  const t = (Array.isArray(sp.t) ? sp.t[0] : sp.t) ?? ''
  let wazny = false
  try {
    wazny = await linkWazny(systemPrisma(), t)
  } catch {
    wazny = false
  }
  return (
    <main className="login">
      <div className="login-box">
        <div className="brand login-brand">
          <b>Kompletor</b>
          <span>zamówienia i wysyłki</span>
        </div>
        <h1>Nowe hasło</h1>
        {wazny ? (
          <>
            <p className="muted small">Po zmianie wylogujemy to konto na wszystkich urządzeniach.</p>
            <FormularzNowegoHasla token={t} min={MIN_PASSWORD_LENGTH} />
          </>
        ) : (
          <Baner ton="blad">{MSG_RESET_ZLY_LINK}</Baner>
        )}
      </div>
      <p className="login-foot small muted">
        <Link href="/logowanie">Wróć do logowania</Link>
      </p>
    </main>
  )
}
