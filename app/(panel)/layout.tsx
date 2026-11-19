// Szkielet panelu: menu z drzewa nawigacji, górny pasek (okruszki, ustawienia, menu konta z firmą, gęstością, Pomocą
// i wylogowaniem), pasek trybu kont, toasty. Sesję sprawdza tu requireLayoutSession() (bez przekierowania hasła startowego),
// ale każdy ekran sprawdza ją jeszcze raz sam (layout nie blokuje renderu stron — zasada DAL z dokumentacji
// Next). Menu i okruszki z lib/panel/nawigacja.ts, gęstość z `User.gestosc`. Jasne menu
// z grupami, statusy zamówień z licznikami w menu (te same liczniki co dawny panel listy: `licznikiPanelu`).
import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { ROLE_LABEL } from '@/lib/auth/uprawnienia'
import { safeError } from '@/lib/auth/zmiana-hasla'
import { firmaMaBlWPanelu } from '@/lib/kanaly/firma'
import { accounts, navCounts } from '@/lib/panel/dane'
import { gestoscZ } from '@/lib/panel/gestosc'
import { MOTYW_CIASTECZKO, motywZ } from '@/lib/panel/motyw'
import { requireLayoutSession, requireLogin } from '@/lib/panel/kontekst'
import { pozycjeStatusow } from '@/lib/panel/menu-statusy'
import { zbudujMenu } from '@/lib/panel/nawigacja'
import { SLOWNIK } from '@/lib/panel/slownik'
import { licznikiPanelu } from '@/lib/panel/zamowienia-lista'
import { ToastProvider } from '@/app/ui'
import { asystentWlaczony } from '@/lib/asystent/wlacznik'
import { wyloguj } from '../akcje'
import { Asystent } from './_komponenty/asystent'
import { Menu } from './_komponenty/menu'

export const dynamic = 'force-dynamic'

function bladLicznika(co: string, e: unknown): null {
  console.error(`[panel] liczniki menu (${co}): ${safeError(e)}`)
  return null
}

export default async function PanelLayout({ children }: { children: ReactNode }) {
  // osoba bez podglądu panelu (rola bez `panel.podglad`) dostaje tylko informację i „Wyloguj” — inaczej
  // ekrany dają 404, a /logowanie odsyła na pulpit, więc nie byłoby wyjścia.
  const who = await requireLogin()
  if (!who.permissions.has('panel.podglad')) {
    return (
      <main className="login">
        <div className="login-box">
          <div className="brand login-brand">
            <b>Kompletor</b>
            <span>{who.organization.name}</span>
          </div>
          <h1>Brak dostępu do panelu</h1>
          <p className="muted small">
            Konto {who.user.name} nie ma w tej firmie uprawnienia do podglądu panelu. Poproś właściciela o nadanie uprawnień w ustawieniach.
          </p>
          <form action={wyloguj}>
            <button className="btn primary login-submit" type="submit">
              Wyloguj
            </button>
          </form>
        </div>
      </main>
    )
  }
  // hasło startowe — okrojony szkielet bez menu i bez danych panelu; na ekran zmiany hasła odsyła
  // strona (requireSession), nie layout. Przekierowanie z layoutu zostawało w kliencie w segmencie layoutu i ekran
  // /ustawienia/haslo ładował się w pętli, pusty. Linki tu zwykłe <a>: po zmianie hasła pełne przeładowanie pokazuje menu.
  if (who.mustChangePassword) {
    return (
      <ToastProvider>
        <div className="shell-haslo">
          <div className="main">
            <div className="banner amber" role="note">
              <div>
                <b>Kompletor · {who.organization.name}</b>. Najpierw ustaw własne hasło, potem zobaczysz cały panel.
              </div>
              <form action={wyloguj}>
                <button className="btn small" type="submit">
                  Wyloguj
                </button>
              </form>
            </div>
            <main className="page" id="tresc">
              {children}
            </main>
          </div>
        </div>
      </ToastProvider>
    )
  }
  const ctx = await requireLayoutSession()
  // liczniki menu to dodatek; ich awaria (np. przekroczony czas zapytania) daje menu
  // bez liczników i statusów oraz wpis w logu serwera, a nie błąd całego panelu na każdym ekranie.
  const [counts, statusy, accs, maBl, asystent] = await Promise.all([
    navCounts(ctx.db).catch((e: unknown) => bladLicznika('braki', e)),
    licznikiPanelu(ctx.db).catch((e: unknown) => bladLicznika('statusy', e)),
    accounts(ctx.db),
    firmaMaBlWPanelu(ctx.db),
    // dymek „Zapytaj” tylko przy włączonym asystencie firmy; błąd odczytu = brak dymka, panel bez zmian
    asystentWlaczony(ctx.db),
  ])
  const menu = zbudujMenu({
    uprawnienia: ctx.permissions,
    maBl,
    liczniki: { zamowienia: statusy?.grupy.wymaga ?? 0, braki: counts?.shortages ?? 0 },
    // statusy firmy (grupy, kolory, liczniki) z tych samych liczników; „Ustaw statusy” dla osoby z ustawieniami
    statusyZamowien: statusy ? pozycjeStatusow(statusy, { ustawienia: ctx.permissions.has('ustawienia') }) : [],
  })
  const gestosc = gestoscZ(ctx.gestosc)
  const active = accs.filter((a) => a.active && a.channel !== 'RECZNE')
  const podglad = active.filter((a) => a.stockMode === 'CIEN' && a.statusMode === 'CIEN')
  const aktywne = active.filter((a) => a.stockMode === 'PRACA' || a.statusMode === 'PRACA')
  const org = ctx.organization
  const konto = {
    imie: ctx.user.name,
    rola: ROLE_LABEL[org.role],
    firma: { id: org.organizationId, nazwa: org.name },
    firmy: ctx.memberships.map((m) => ({ id: m.organizationId, nazwa: m.name })),
    gestosc,
    motyw: motywZ((await cookies()).get(MOTYW_CIASTECZKO)?.value),
  }
  return (
    <ToastProvider>
      <div className="shell" data-gestosc={gestosc}>
        <Menu menu={menu} konto={konto}>
          {/* firma demo (lib/instalacja/demo.ts) ma pasek na każdym ekranie, żeby nikt nie wziął jej za prawdziwe dane */}
          {ctx.organization.slug === 'demo' && (
            <div className="banner amber" role="note">
              <div>
                <b>Dane fikcyjne, demo Kompletora.</b> Produkty i zamówienia są zmyślone, a konta kanałów wyłączone.
              </div>
            </div>
          )}
          {active.length > 0 && (
            <div className="tryb-kont" role="note">
              {podglad.length > 0 && (
                <span>
                  <span className="ui-odznaka" data-ton="info">
                    {SLOWNIK.tylkoPodglad}
                  </span>
                  {podglad.map((a) => a.name).join(', ')}
                  <span className="long">: {SLOWNIK.tylkoPodgladOpis}</span>
                </span>
              )}
              {aktywne.length > 0 && (
                <span>
                  <span className="ui-odznaka" data-ton="sukces">
                    {SLOWNIK.aktywny}
                  </span>
                  {/* konto pracujące bez stanów (stany ofert wysyła dotychczasowy system) z dopiskiem */}
                  {aktywne.map((a) => (a.statusMode === 'PRACA' && a.stockMode === 'CIEN' ? `${a.name} (bez stanów)` : a.name)).join(', ')}
                  <span className="long">: {SLOWNIK.aktywnyOpis}</span>
                </span>
              )}
            </div>
          )}
          <main className="page" id="tresc">
            {children}
          </main>
          {asystent && <Asystent />}
        </Menu>
      </div>
    </ToastProvider>
  )
}
