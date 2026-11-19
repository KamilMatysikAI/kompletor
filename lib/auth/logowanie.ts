// Logika formularza logowania bez zależności od Next (testowalna): limit prób per IP, wywołanie `login`,
// komunikat dla użytkownika. Złe dane, blokada konta i przekroczony limit dają TEN SAM komunikat — odpowiedź nie
// zdradza, czy konto istnieje.
import type { PrismaClient } from '@prisma/client'
import { SlidingLimiter } from './limiter'
import { login as realLogin, type LoginResult } from './sesje'

export const LOGIN_LIMIT_PER_IP = 20
export const LOGIN_WINDOW_MS = 60_000
export const ipLimiter = new SlidingLimiter(LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS)

export const MSG_INVALID = 'Nieprawidłowy e-mail albo hasło. Po kilku nieudanych próbach konto jest blokowane na 15 minut.'
export const MSG_NO_ORG = 'To konto nie ma dostępu do żadnej firmy. Poproś właściciela o nadanie dostępu.'
export const MSG_DOWN = 'Logowanie chwilowo nie działa (baza danych nie odpowiada). Spróbuj za minutę.'

export type AttemptResult = { ok: true; token: string; expiresAt: Date } | { ok: false; message: string }

export async function attemptLogin(
  sys: PrismaClient,
  p: { email: string; password: string; ip: string; userAgent?: string | null },
  deps: { limiter?: SlidingLimiter; login?: typeof realLogin; now?: Date; log?: (msg: string) => void } = {},
): Promise<AttemptResult> {
  const limiter = deps.limiter ?? ipLimiter
  if (!limiter.hit(p.ip, deps.now?.getTime())) return { ok: false, message: MSG_INVALID }
  let r: LoginResult
  try {
    r = await (deps.login ?? realLogin)(sys, p.email, p.password, { userAgent: p.userAgent, now: deps.now })
  } catch (e) {
    // bez hasła i e-maila w logu; Prisma nie wypisuje argumentów (log: [])
    ;(deps.log ?? ((m: string) => console.error(m)))(`[logowanie] błąd: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, message: MSG_DOWN }
  }
  if (r.ok) return r
  return { ok: false, message: r.reason === 'no_org' ? MSG_NO_ORG : MSG_INVALID }
}
