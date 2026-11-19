// Zadania workera poczty: `poczta-wysylka` (plan akcji, co 60 s per firma) i `poczta-reset` (link do
// ustawienia hasła, z kolejki po prośbie ze strony logowania). Zła wartość POCZTA_WYSYLKA = błąd bez ponawiania.
import { Prisma, type PrismaClient } from '@prisma/client'
import { panelBaseUrl } from '../auth/zaproszenia'
import { sprzatajResety, tokenDoWysylki, wyczyscToken } from '../auth/reset-hasla'
import { NonRetryableError } from '../bledy'
import { systemPrisma } from '../db'
import { BladSzablonu, renderujMail, type GotowyMail } from '../maile'
import { bezpiecznyBlad, maskujAdres, transportSmtp, type Koperta, type WynikSmtp } from '../maile/transport'
import type { SecretSource } from '../sekrety'
import { pocztaInstalacji } from './instalacja'
import { kontekstFirmy } from './marka'
import { hosting, wysylkaPocztyZEnv } from './ustawienia'
import { opisWyniku, wyslijZaplanowane, type DepsWysylki } from './wysylka'

/** Zadanie sprzątania linków resetu hasła: raz na dobę per firma. */
export const ZADANIE_SPRZATANIA_RESETOW = 'poczta-reset-sprzatanie'

type Ctx = { organizationId: string; secrets: SecretSource }

function bramka(env: Record<string, string | undefined>, kind: string): boolean {
  try {
    return wysylkaPocztyZEnv(env)
  } catch (e) {
    throw new NonRetryableError(`${kind}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function zadanieWysylkiPoczty(deps: DepsWysylki = {}, log: (s: string) => void = (s) => console.log(s)) {
  return async (db: PrismaClient, _payload: unknown, ctx: Ctx): Promise<void> => {
    bramka(ctx.secrets.env, 'poczta-wysylka')
    const r = await wyslijZaplanowane(db, ctx.secrets.env, deps)
    const ruch = r.sent + r.retry + r.failed + r.uncertain + r.waiting + r.skippedPlans + r.stale + r.deferred > 0
    if (ruch) log(`[poczta] ${ctx.organizationId}: ${r.skipped ? `pominięto (${r.skipped}); ` : ''}${opisWyniku(r)}`)
    if (r.errors.length) throw new Error(`poczta-wysylka: ${r.errors.length} błędów: ${r.errors.join('; ')}`.slice(0, 2000))
  }
}

/**
 * Mail z linkiem do ustawienia hasła. Jedna wysyłka na prośbę (MailDelivery „reset:<id>”, SENDING przed wywołaniem).
 * Ponowienie przez kolejkę zadań tylko przy RETRY (mail na pewno nie wyszedł); po każdej innej próbie token znika z
 * bazy. Transport WYŁĄCZNIE poczta instalacji (RESET_SMTP_* w env), nigdy serwer poczty firmy z Ustawień →
 * Poczta: zadanie nie czyta MailSettings (nadawca i odpowiedź = nadawca instalacji, stopka z danych firmy). Bez poczty
 * instalacji, bez POCZTA_WYSYLKA=1 albo bez PANEL_URL link nie wychodzi (prośba przepada po cichu, odpowiedź na stronie
 * była ta sama). Mail renderuje się przed zajęciem wpisu SENDING (błąd szablonu nie zostawia wpisu „w trakcie”).
 * Odrzucony login albo konfiguracja serwera instalacji: tylko log workera (to sprawa operatora, nie firmy), bez
 * zmian w ustawieniach poczty firmy.
 */
export function zadanieResetuHasla(deps: DepsWysylki & { sys?: () => PrismaClient; renderuj?: typeof renderujMail } = {}, log: (s: string) => void = (s) => console.warn(s)) {
  return async (db: PrismaClient, payload: unknown, ctx: Ctx): Promise<void> => {
    const env = ctx.secrets.env
    const id = payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string' ? (payload as { id: string }).id : null
    if (!id) throw new NonRetryableError('poczta-reset: brak id prośby')
    const sys = deps.sys ? deps.sys() : systemPrisma()
    if (!bramka(env, 'poczta-reset')) {
      log('[poczta-reset] wysyłka maili na instancji wyłączona (POCZTA_WYSYLKA) — link nie wyszedł')
      await wyczyscToken(sys, id)
      return
    }
    const now = (deps.now ?? (() => new Date()))()
    const panel = panelBaseUrl(env)
    const inst = pocztaInstalacji(env)
    const dane = await tokenDoWysylki(sys, { id, organizationId: ctx.organizationId, env, now })
    // bramka resetu: poczta instalacji ustawiona i PANEL_URL; poczta firmy i jej włączniki nie mają tu znaczenia
    if (!dane || !panel || !inst.ok) {
      if (dane) log(`[poczta-reset] ${ctx.organizationId}: ${!panel ? 'brak PANEL_URL' : !inst.ok ? inst.brak : ''} — link nie wyszedł`)
      await wyczyscToken(sys, id)
      return
    }
    const dedupeKey = `reset:${id}`
    const maska = maskujAdres(dane.email)
    // render przed zajęciem: wyjątek tutaj nie zostawia wpisu SENDING (ponowienie trafiłoby na „w trakcie” i fałszywy
    // alert o porzuconej wysyłce); błąd szablonu albo danych firmy sam się nie naprawi, więc bez ponawiania
    let mail: GotowyMail
    let koperta: Koperta
    try {
      // marka bez MailSettings firmy: nadawca i adres odpowiedzi z poczty instalacji, stopka z profilu firmy
      const { kontekst, nadawca } = await kontekstFirmy(db, { officeEmail: null, fromEmail: inst.poczta.nadawca.email, fromName: inst.poczta.nadawca.nazwa, nadawcy: {} })
      mail = (deps.renderuj ?? renderujMail)('reset-hasla', kontekst, { email: dane.email, link: `${panel}/nowe-haslo?t=${encodeURIComponent(dane.token)}`, waznyDo: dane.expiresAt })
      koperta = { od: nadawca, do: dane.email, odpowiedzDo: mail.odpowiedzDo, id: dedupeKey }
    } catch (e) {
      await wyczyscToken(sys, id)
      const opis = bezpiecznyBlad(e instanceof Error ? e.message : String(e), null, [dane.email])
      log(`[poczta-reset] ${ctx.organizationId}: mail nie powstał (${opis}) — link nie wyszedł`)
      throw new NonRetryableError(`poczta-reset: ${e instanceof BladSzablonu ? 'szablon albo dane firmy: ' : ''}${opis}`)
    }
    let deliveryId: string
    const cur = await db.mailDelivery.findFirst({ where: { dedupeKey }, select: { id: true, state: true } })
    if (cur) {
      // wcześniejsza próba: ponawiamy tylko po RETRY (FAILED z terminem), nigdy po SENT/UNCERTAIN
      const r = await db.mailDelivery.updateMany({ where: { id: cur.id, state: 'FAILED', nextAttemptAt: { not: null } }, data: { state: 'SENDING', attempts: { increment: 1 }, lastAttemptAt: new Date(), nextAttemptAt: null } })
      if (!r.count) {
        await wyczyscToken(sys, id)
        return
      }
      deliveryId = cur.id
    } else {
      try {
        deliveryId = (await db.mailDelivery.create({ data: { dedupeKey, kind: 'reset-hasla', state: 'SENDING', attempts: 1, lastAttemptAt: new Date(), recipient: maska }, select: { id: true } })).id
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return
        throw e
      }
    }
    const res: WynikSmtp = await (deps.transport ?? ((c) => transportSmtp(c, { tylkoPubliczne: hosting(env) })))(inst.poczta.smtp).wyslij(mail, koperta)
    if (res.kind === 'SENT') {
      await db.mailDelivery.update({ where: { id: deliveryId }, data: { state: 'SENT', sentAt: now, messageId: res.messageId, lastError: null } })
      await wyczyscToken(sys, id)
      return
    }
    const ponow = res.kind === 'RETRY'
    await db.mailDelivery.update({ where: { id: deliveryId }, data: { state: res.kind === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED', nextAttemptAt: ponow ? now : null, lastError: bezpiecznyBlad(res.error, null, [dane.email]) } })
    // serwer instalacji odrzucił login albo konfigurację: sprawa operatora (RESET_SMTP_*), poczta firmy bez zmian
    if (res.kind === 'AUTH' || res.kind === 'KONFIGURACJA') log(`[poczta-reset] ${ctx.organizationId}: poczta instalacji (RESET_SMTP_*) odrzuciła wysyłkę (${res.kind}: ${bezpiecznyBlad(res.error, null)}) — link nie wyszedł`)
    if (!ponow) {
      await wyczyscToken(sys, id)
      return
    }
    throw new Error(`poczta-reset: ${res.error}`.slice(0, 500)) // kolejka ponowi (maxAttempts 4)
  }
}

/**
 * Sprzątanie linków resetu hasła firmy: wygasłe linki tracą szyfrogram tokenu od razu (prośba, której kolejka nie
 * wysłała, nie trzyma go do ręcznego sprzątania), a wygasłe lub użyte starsze niż doba znikają. Klient systemowy, jak
 * worker resetu (tabela PasswordReset bez dostępu dla klienta firmy), zawsze z filtrem firmy z kontekstu zadania.
 */
export function zadanieSprzataniaResetow(deps: { sys?: () => PrismaClient; now?: () => Date } = {}) {
  return async (_db: PrismaClient, _payload: unknown, ctx: Ctx): Promise<void> => {
    const sys = deps.sys ? deps.sys() : systemPrisma()
    await sprzatajResety(sys, (deps.now ?? (() => new Date()))(), ctx.organizationId)
  }
}
