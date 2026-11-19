// Zaproszenia mailem (reszta pkt 3): `InvitationSender` (lib/auth/zaproszenia.ts) przez pocztę
// firmy. Link idzie wyłącznie na adres zaproszonej osoby, więc `delivered: true` (konto z linku bez wymuszonej zmiany
// hasła) dopiero po przyjęciu maila przez serwer (SENT). Dopiero ta droga usuwa wyrocznię „czy adres ma konto” z trybu
// kopiowania linku (komentarz): zapraszający nie dostaje linku do ręki.
//
// Bramki jak reset hasła: POCZTA_WYSYLKA=1 na instancji, serwer poczty firmy ustawiony i nie odrzucił logowania;
// włącznik „wysyłki z planu akcji” nie ma tu znaczenia (zaproszenie wysyła osoba z panelu, nie automat). Brak bramki,
// błąd albo wynik niepewny = `delivered: false`: link wraca do skopiowania (jak dziś), konto z niego ma hasło do zmiany.
// Jedna próba na zaproszenie (MailDelivery „zaproszenie:<id>”, SENDING przed wywołaniem serwera); ponowienie = nowe
// zaproszenie z nowym linkiem. Link i adres nie trafiają do bazy ani logu (w MailDelivery maska adresu).
// Odrzucony login: jak w wysyłce z planu, poczta firmy wyłączona do naprawy i alert.
//
// Hamulce: zaproszenia liczą się do limitu godzinowego firmy (każda próba w MailDelivery), więc
// go też sprawdzają (to samo zapytanie co wysyłka z planu), plus najwyżej LIMIT_NA_ADRES maili na godzinę na adres
// (po masce adresu, bo pełnego adresu w bazie nie ma; maska jest zgrubna, więc limit bywa ostrzejszy, nigdy luźniejszy)
// i LIMIT_FIRMY zaproszeń na godzinę na firmę. Przekroczenie = link do skopiowania, jak bez poczty. Akcja w panelu
// czeka na serwer poczty najwyżej TIMEOUT_MS na krok (połączenie, powitanie, gniazdo), nie domyślne 20 s.
import type { PrismaClient } from '@prisma/client'
import { type InvitationMessage, type InvitationSender } from '../auth/zaproszenia'
import { ROLE_LABEL } from '../auth/uprawnienia'
import { renderujMail } from '../maile'
import { bezpiecznyBlad, maskujAdres, transportSmtp, type KonfiguracjaSmtp, type TransportPoczty, type WynikSmtp } from '../maile/transport'
import { alert } from '../rdzen/stan'
import type { Env } from '../sekrety'
import { kontekstFirmy } from './marka'
import { hosting, pocztaFirmy, ustawBladPoczty, wysylkaPocztyZEnv } from './ustawienia'
import { ALERT_KONFIGURACJA, ALERT_LOGOWANIE, alertKonfiguracji, komunikatKonfiguracji, limitGodzinyWolny } from './wysylka'

export interface DepsZaproszen {
  transport?: (cfg: KonfiguracjaSmtp) => TransportPoczty
  now?: () => Date
  log?: (m: string) => void
}

/** Rodzaj wpisu wysyłki (MailDelivery.kind) dla zaproszeń. */
export const RODZAJ_ZAPROSZENIA = 'zaproszenie'
/** Najwyżej tyle maili z zaproszeniem na godzinę na jeden adres (po masce). */
export const LIMIT_NA_ADRES = 3
/** Najwyżej tyle maili z zaproszeniem na godzinę w firmie. */
export const LIMIT_FIRMY = 20
/** Czas oczekiwania na serwer poczty w akcji panelu (na krok), zamiast domyślnych 20 s transportu. */
export const TIMEOUT_MS = 10_000

/** Domyślny transport zaproszeń: krótszy czas oczekiwania, bo czeka osoba w panelu. */
export const transportZaproszen = (env: Env) => (c: KonfiguracjaSmtp) => transportSmtp(c, { tylkoPubliczne: hosting(env), timeoutMs: TIMEOUT_MS })

/** Klient firmy (RLS) i env instancji. Bez gotowej poczty zachowuje się jak `copyLinkSender`. */
export function zaproszeniaPoczta(db: PrismaClient, env: Env, deps: DepsZaproszen = {}): InvitationSender {
  const log = deps.log ?? ((m: string) => console.warn(m))
  return {
    async send(m: InvitationMessage): Promise<{ delivered: boolean }> {
      let instancja: boolean
      try {
        instancja = wysylkaPocztyZEnv(env)
      } catch {
        instancja = false
      }
      if (!instancja) return { delivered: false }
      const cfg = await pocztaFirmy(db, env)
      if (!cfg.ok || cfg.poczta.loginRejectedAt) return { delivered: false }
      const now = (deps.now ?? (() => new Date()))()
      const { kontekst, nadawca } = await kontekstFirmy(db, cfg.poczta)
      const mail = renderujMail('zaproszenie', kontekst, { email: m.email, link: m.link, rola: ROLE_LABEL[m.role], waznyDo: m.expiresAt })
      const maska = maskujAdres(m.email)
      const godzine = { gte: new Date(now.getTime() - 3600_000) }
      const hamulec = !(await limitGodzinyWolny(db, now))
        ? 'limit godzinowy maili firmy'
        : (await db.mailDelivery.count({ where: { kind: RODZAJ_ZAPROSZENIA, recipient: maska, lastAttemptAt: godzine, attempts: { gt: 0 } } })) >= LIMIT_NA_ADRES
          ? `limit ${LIMIT_NA_ADRES} zaproszeń na godzinę na adres`
          : (await db.mailDelivery.count({ where: { kind: RODZAJ_ZAPROSZENIA, lastAttemptAt: godzine, attempts: { gt: 0 } } })) >= LIMIT_FIRMY
            ? `limit ${LIMIT_FIRMY} zaproszeń na godzinę w firmie`
            : null
      if (hamulec) {
        log(`[zaproszenia] mail do ${maska} nie wyszedł (${hamulec}): link do skopiowania w panelu`)
        return { delivered: false }
      }
      const dedupeKey = m.id ? `zaproszenie:${m.id}` : `zaproszenie:${now.getTime()}:${Math.random().toString(36).slice(2, 10)}`
      const delivery = await db.mailDelivery.create({ data: { dedupeKey, kind: RODZAJ_ZAPROSZENIA, state: 'SENDING', attempts: 1, lastAttemptAt: now, recipient: maska }, select: { id: true } })
      let res: WynikSmtp
      try {
        res = await (deps.transport ?? transportZaproszen(env))(cfg.poczta.smtp).wyslij(mail, { od: nadawca, do: m.email, odpowiedzDo: mail.odpowiedzDo, id: dedupeKey })
      } catch (e) {
        res = { kind: 'UNCERTAIN', error: e instanceof Error ? e.message : String(e) }
      }
      if (res.kind === 'SENT') {
        await db.mailDelivery.update({ where: { id: delivery.id }, data: { state: 'SENT', sentAt: now, messageId: res.messageId, lastError: null } })
        return { delivered: true }
      }
      const blad = bezpiecznyBlad(res.error, null, [m.email])
      await db.mailDelivery.update({ where: { id: delivery.id }, data: { state: res.kind === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED', nextAttemptAt: null, lastError: blad } })
      if (res.kind === 'AUTH') {
        await ustawBladPoczty(db, `Serwer poczty odrzucił login albo hasło (${bezpiecznyBlad(res.error, null)}) — wysyłka wyłączona; popraw dane i włącz ponownie`, now, true)
        await alert(db, ALERT_LOGOWANIE, 'poczta', 'Serwer poczty odrzucił login albo hasło (mail z zaproszeniem). Wysyłka maili wyłączona: Ustawienia → Komunikacja i poczta → Poczta.', `poczta:${delivery.id}:${ALERT_LOGOWANIE}`)
      }
      if (res.kind === 'KONFIGURACJA') {
        await ustawBladPoczty(db, komunikatKonfiguracji(bezpiecznyBlad(res.error, null), res.polaczenie === true), now, true)
        await alert(db, ALERT_KONFIGURACJA, 'poczta', alertKonfiguracji(res.polaczenie === true, 'mail z zaproszeniem'), `poczta:${delivery.id}:${ALERT_KONFIGURACJA}`)
      }
      log(`[zaproszenia] mail do ${maska} nie wyszedł (${res.kind}): link do skopiowania w panelu`)
      return { delivered: false }
    },
  }
}
