// Poczta instalacji: serwer SMTP ustawiany wyłącznie przez operatora serwera (zmienne RESET_SMTP_* w env), używany
// TYLKO do linków odzyskiwania konta („Nie pamiętam hasła”). Audyt bezpieczeństwa 13.11.2026: konta są
// wspólne dla instalacji, a serwer poczty firmy (Ustawienia → Poczta) zmienia każdy z uprawnieniem `ustawienia`.
// Link resetu wysłany pocztą firmy trafiał więc na serwer wybrany przez tę osobę (przejęcie konta właściciela, przy
// kontach w kilku firmach także cudzej firmy). Dlatego reset nigdy nie czyta MailSettings firmy: bez poczty instalacji
// link nie powstaje, a hasło startowe nadaje właściciel firmy albo administrator poleceniem z docs/instalacja.md.
//
// Zmienne (docs/poczta.md, „Reset hasła”):
//   RESET_SMTP_HOST         serwer, np. email-smtp.eu-central-1.amazonaws.com (puste = poczty instalacji nie ma)
//   RESET_SMTP_PORT         domyślnie 587
//   RESET_SMTP_SZYFROWANIE  STARTTLS (domyślnie), TLS albo BRAK (BRAK tylko poza hostingiem)
//   RESET_SMTP_LOGIN        login SMTP (puste = bez logowania)
//   RESET_SMTP_PASSWORD     hasło SMTP (wymagane, gdy jest login)
//   RESET_SMTP_NADAWCA      adres nadawcy (From), wymagany
//   RESET_SMTP_NAZWA        nazwa nadawcy, domyślnie „Kompletor”
import { poprawnyAdres, sprawdzKonfiguracje, type Bezpieczenstwo, type KonfiguracjaSmtp } from '../maile/transport'
import { appModeOf } from '../db'
import type { Env } from '../sekrety'

export interface PocztaInstalacji {
  smtp: KonfiguracjaSmtp
  nadawca: { email: string; nazwa: string }
}

export type WynikPocztyInstalacji = { ok: true; poczta: PocztaInstalacji } | { ok: false; brak: string }

const wartosc = (env: Env, k: string) => (env[k] ?? '').trim()

/** Konfiguracja poczty instalacji z env albo opis, czego brakuje (bez wartości sekretów). */
export function pocztaInstalacji(env: Env): WynikPocztyInstalacji {
  const host = wartosc(env, 'RESET_SMTP_HOST')
  if (!host) return { ok: false, brak: 'brak RESET_SMTP_HOST (poczta instalacji nie jest ustawiona)' }
  const portTxt = wartosc(env, 'RESET_SMTP_PORT') || '587'
  const port = /^\d{1,5}$/.test(portTxt) ? Number(portTxt) : NaN
  const szyfr = (wartosc(env, 'RESET_SMTP_SZYFROWANIE') || 'STARTTLS').toUpperCase()
  const bledy = sprawdzKonfiguracje({ host, port, bezpieczenstwo: szyfr }, { hosting: appModeOf(env) === 'hosted' })
  const login = wartosc(env, 'RESET_SMTP_LOGIN') || null
  const haslo = (env.RESET_SMTP_PASSWORD ?? '') || null
  if (login && !haslo) bledy.push('RESET_SMTP_LOGIN bez RESET_SMTP_PASSWORD')
  const email = wartosc(env, 'RESET_SMTP_NADAWCA')
  if (!poprawnyAdres(email)) bledy.push('RESET_SMTP_NADAWCA: poprawny adres e-mail nadawcy')
  if (bledy.length) return { ok: false, brak: `poczta instalacji niepoprawna: ${bledy.join('; ')}` }
  const nazwa = wartosc(env, 'RESET_SMTP_NAZWA').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 100) || 'Kompletor'
  return {
    ok: true,
    poczta: {
      smtp: { host, port, bezpieczenstwo: szyfr as Bezpieczenstwo, login, haslo: login ? haslo : null },
      nadawca: { email, nazwa },
    },
  }
}
