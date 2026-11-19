// Zaproszenie do firmy (tylko hosting): link z tokenem od osoby z firmy. Strona publiczna (proxy.ts:
// `Referrer-Policy: no-referrer`, `noindex`), ale wejście GET niczego nie przyjmuje — skanery linków w poczcie
// otwierają linki same. Przyjęcie tylko akcją POST (app/akcje.ts). Treść: nazwa firmy i rola, bez adresu e-mail.
// Zawsze obie drogi (logowanie i nowe konto) — strona nie zdradza, czy adres z zaproszenia ma już konto.
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/hasla'
import { ROLE_LABEL } from '@/lib/auth/uprawnienia'
import { currentSession, invitationForPage } from '@/lib/panel/kontekst'
import { FormularzeZaproszenia } from './formularz'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Zaproszenie', robots: { index: false, follow: false }, referrer: 'no-referrer' as const }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Zaproszenie({ searchParams }: Props) {
  const token = one((await searchParams).t)
  const info = await invitationForPage(token)
  const who = info.state === 'ok' ? await currentSession() : null
  return (
    <main className="login">
      <div className="login-box">
        <div className="brand login-brand">
          <b>Kompletor</b>
          <span>zamówienia i wysyłki</span>
        </div>
        {info.state === 'ok' ? (
          <>
            <h1 style={{ overflowWrap: 'anywhere' }}>Zaproszenie do firmy {info.organizationName}</h1>
            <p className="muted small">
              Rola: <b>{ROLE_LABEL[info.role]}</b>. Dostęp do firmy powstanie dopiero wtedy, gdy przyjmiesz zaproszenie. Zaproszenie jest imienne: przyjmiesz je tylko kontem z adresem e-mail, na który
              zostało wystawione.
            </p>
            <FormularzeZaproszenia token={token ?? ''} zalogowany={who ? who.user.name : null} min={MIN_PASSWORD_LENGTH} />
          </>
        ) : (
          <>
            <h1>Zaproszenie nieważne</h1>
            <p className="muted small">Link wygasł, został cofnięty albo już go użyto. Poproś osobę z firmy o nowe zaproszenie.</p>
            <a className="btn primary login-submit" href="/logowanie" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              Przejdź do logowania
            </a>
          </>
        )}
      </div>
    </main>
  )
}
