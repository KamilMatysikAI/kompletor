// Zmiana własnego hasła bez zależności od Next (testowalna): limit prób jak przy logowaniu (per IP)
// i dodatkowo per osoba (skradziona sesja nie zgadnie hasła seriami), wywołanie `changeOwnPassword`, komunikat.
// Hasła nie trafiają do logu ani do stanu formularza.
import type { PrismaClient } from '@prisma/client'
import { MIN_PASSWORD_LENGTH } from './hasla'
import { SlidingLimiter } from './limiter'
import { LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS } from './logowanie'
import { changeOwnPassword as realChange } from './sesje'

export const PASSWORD_CHANGE_PER_USER = 5
export const PASSWORD_CHANGE_USER_WINDOW_MS = 15 * 60_000
export const passwordIpLimiter = new SlidingLimiter(LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS)
export const passwordUserLimiter = new SlidingLimiter(PASSWORD_CHANGE_PER_USER, PASSWORD_CHANGE_USER_WINDOW_MS)

export const MSG_PW_LIMIT = 'Za dużo prób zmiany hasła. Spróbuj ponownie za kilkanaście minut.'
export const MSG_PW_CURRENT = 'Obecne hasło jest nieprawidłowe.'
export const MSG_PW_WEAK = `Nowe hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.`
export const MSG_PW_SAME = 'Nowe hasło musi się różnić od obecnego.'
export const MSG_PW_MISMATCH = 'Powtórzone hasło nie jest takie samo jak nowe.'
export const MSG_PW_DOWN = 'Nie udało się zmienić hasła (baza danych nie odpowiada). Spróbuj za minutę.'

export type PasswordChangeAttempt = { ok: true } | { ok: false; message: string }

/** Błąd do logu bez treści: komunikat Prismy może zawierać argumenty zapytania (np. skrót hasła). */
export const safeError = (e: unknown): string => `${e instanceof Error ? e.name : 'błąd'}${typeof e === 'object' && e && 'code' in e ? ` ${String((e as { code: unknown }).code)}` : ''}`

export async function attemptPasswordChange(
  sys: PrismaClient,
  p: { userId: string; organizationId: string; sessionId: string; current: string; next: string; repeat: string; ip: string },
  deps: { ipLimiter?: SlidingLimiter; userLimiter?: SlidingLimiter; change?: typeof realChange; now?: Date; log?: (msg: string) => void } = {},
): Promise<PasswordChangeAttempt> {
  const t = deps.now?.getTime()
  if (!(deps.ipLimiter ?? passwordIpLimiter).hit(p.ip, t) || !(deps.userLimiter ?? passwordUserLimiter).hit(p.userId, t)) return { ok: false, message: MSG_PW_LIMIT }
  if (p.next !== p.repeat) return { ok: false, message: MSG_PW_MISMATCH }
  try {
    const r = await (deps.change ?? realChange)(sys, { userId: p.userId, organizationId: p.organizationId, current: p.current, next: p.next, keepSessionId: p.sessionId, now: deps.now })
    if (r.ok) return r
    return { ok: false, message: r.reason === 'weak' ? MSG_PW_WEAK : r.reason === 'same' ? MSG_PW_SAME : r.reason === 'locked' ? MSG_PW_LIMIT : MSG_PW_CURRENT }
  } catch (e) {
    ;(deps.log ?? ((m: string) => console.error(m)))(`[haslo] błąd: ${safeError(e)}`)
    return { ok: false, message: MSG_PW_DOWN }
  }
}
