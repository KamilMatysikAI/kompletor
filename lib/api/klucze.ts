// Uwierzytelnianie API dla systemów zewnętrznych kluczem firmy. Nagłówek `Authorization: Bearer kmp_…`.
//
// W bazie leży tylko SHA-256 klucza (`tokenHash` jak przy sesjach, lib/auth/sesje.ts). Odnalezienie klucza to jedyne
// miejsce z klientem systemowym — firma nie jest jeszcze znana; po nim całe żądanie pracuje na kliencie firmy klucza
// (prismaForOrg, RLS), tak jak trasy stanowiska (lib/stanowisko/sesja-api.ts). Firma nieaktywna, klucz odwołany,
// nieznany albo w złym formacie = ta sama odpowiedź 401, bez rozróżniania powodu. Brak zakresu = 403.
//
// Limity w pamięci procesu (jak logowanie, lib/auth/limiter.ts): 120 żądań na minutę na klucz i 30 nieudanych prób
// na 10 minut z jednego adresu IP. Blokada adresu dotyczy WYŁĄCZNIE żądań, które nie przeszły uwierzytelnienia: dobry
// klucz z zablokowanego adresu działa dalej (systemy klientów dzielą adresy: biuro, VPS — jeden skrypt ze starym
// kluczem po rotacji nie może odciąć pozostałych). Kubełek „nieznany” (brak X-Forwarded-For, self-host bez proxy) nie
// jest blokowany wcale, bo łączy wszystkich klientów. Klucz ma 256 bitów entropii, więc limit chroni bazę przed
// zalewem, nie klucz przed zgadywaniem; odnalezienie klucza to jeden SELECT po unikalnym indeksie.
// Klucza nie logujemy nawet częściowo; `lastUsedAt` podbijamy najwyżej raz na 5 minut.
import 'server-only'
import type { PrismaClient } from '@prisma/client'
import { prismaForOrg, systemPrisma } from '@/lib/db'
import { clientIp, SlidingLimiter } from '@/lib/auth/limiter'
import { tokenHash } from '@/lib/auth/sesje'
import { apiError } from './odpowiedzi'
import { API_KEY_RE, isApiScope, OBSLUGA_SCOPE, type ApiScope } from './zakresy'

export const REQUESTS_PER_MINUTE = 120
export const FAILED_PER_IP = 30
export const FAILED_WINDOW_MS = 10 * 60_000
export const TOUCH_EVERY_MS = 5 * 60_000
/** Wspólny kubełek clientIp() bez nagłówków proxy — nigdy nie blokowany (łączy wszystkich klientów). */
export const UNKNOWN_IP = 'nieznany'

export interface ApiContext {
  db: PrismaClient
  organizationId: string
  keyId: string
  scopes: ReadonlySet<ApiScope>
}

export interface FoundApiKey {
  id: string
  organizationId: string
  scopes: ApiScope[]
  lastUsedAt: Date | null
}

export class ApiLimiters {
  readonly perKey = new SlidingLimiter(REQUESTS_PER_MINUTE, 60_000)
  readonly failedPerIp = new SlidingLimiter(FAILED_PER_IP, FAILED_WINDOW_MS)
  readonly blockedUntil = new Map<string, number>()
}

let limiters = new ApiLimiters()

/** Tylko testy: liczniki od zera. */
export function resetApiLimiters(): void {
  limiters = new ApiLimiters()
}

/** Klucz z nagłówka `Authorization: Bearer <klucz>` albo null. */
export function bearerToken(authorization: string | null): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? '')
  return m ? m[1]! : null
}

/**
 * Aktywny klucz o tej treści albo null (nieznany, zły format, odwołany, firma nieaktywna — bez rozróżnienia).
 * `sys` = klient systemowy: tabela ApiKey pod RLS, a firma klucza nie jest jeszcze znana.
 */
export async function findApiKey(sys: PrismaClient, token: string | null): Promise<FoundApiKey | null> {
  if (!token || !API_KEY_RE.test(token)) return null
  const row = await sys.apiKey.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: { id: true, organizationId: true, scopes: true, lastUsedAt: true, revokedAt: true, organization: { select: { active: true } } },
  })
  if (!row || row.revokedAt || !row.organization.active) return null
  return { id: row.id, organizationId: row.organizationId, scopes: row.scopes.filter(isApiScope), lastUsedAt: row.lastUsedAt }
}

export interface ApiGuardDeps {
  sys?: () => PrismaClient
  orgDb?: (organizationId: string) => PrismaClient
  now?: () => number
}

const unauthorized = () =>
  apiError(401, 'Wymagany ważny klucz API w nagłówku Authorization: Bearer kmp_…', {}, { 'WWW-Authenticate': 'Bearer realm="Kompletor API"' })

const tooMany = (retryAfterSec: number) =>
  apiError(429, 'Za dużo żądań, spróbuj później', { ponowZaSekund: retryAfterSec }, { 'Retry-After': String(retryAfterSec) })

/**
 * Bramka każdej trasy /api/v1 (strażnik w tests/panel-dostep.integration.test.ts): klient firmy klucza albo gotowa
 * odpowiedź błędu (401 / 403 / 429).
 */
export async function requireApiKey(req: Request, scope: ApiScope, deps: ApiGuardDeps = {}): Promise<ApiContext | Response> {
  return guard(req, (scopes) => scopeRefusal(scopes, scope), deps)
}

/**
 * Odmowa zakresu (403) albo null. Klucz obsługi klienta dostaje wyłącznie trasy obsługi, także gdyby w bazie miał
 * inny zakres obok (warunek ApiKey_obsluga_osobno tego nie dopuszcza; to druga zapora).
 */
export function scopeRefusal(scopes: ReadonlySet<ApiScope>, scope: ApiScope): Response | null {
  if (!scopes.has(scope)) return apiError(403, `Klucz nie ma zakresu ${scope}`)
  if (scope !== OBSLUGA_SCOPE && scopes.has(OBSLUGA_SCOPE)) return apiError(403, `Klucz obsługi klienta nie ma dostępu do tej trasy`)
  return null
}

/**
 * ta sama bramka bez wymaganego zakresu — dla serwera MCP (/api/mcp), który sprawdza zakres osobno dla
 * każdego narzędzia (brak zakresu = błąd narzędzia, nie 403 całego żądania). Klucz, limity, `lastUsedAt` i odpowiedzi
 * 401 / 429 dokładnie jak w `requireApiKey`; `unauthorizedResponse` pozwala trasie podać własną odpowiedź 401.
 */
export async function authenticateApiKey(req: Request, deps: ApiGuardDeps & { unauthorizedResponse?: () => Response } = {}): Promise<ApiContext | Response> {
  return guard(req, () => null, deps)
}

async function guard(
  req: Request,
  checkScopes: (scopes: ReadonlySet<ApiScope>) => Response | null,
  deps: ApiGuardDeps & { unauthorizedResponse?: () => Response },
): Promise<ApiContext | Response> {
  const now = (deps.now ?? Date.now)()
  const denied = deps.unauthorizedResponse ?? unauthorized
  const key = await findApiKey((deps.sys ?? systemPrisma)(), bearerToken(req.headers.get('authorization')))
  if (!key) {
    const ip = clientIp(req.headers)
    if (ip === UNKNOWN_IP) return denied()
    const blocked = limiters.blockedUntil.get(ip)
    if (blocked !== undefined) {
      if (blocked > now) return tooMany(Math.ceil((blocked - now) / 1000))
      limiters.blockedUntil.delete(ip)
    }
    if (!limiters.failedPerIp.hit(ip, now)) {
      limiters.blockedUntil.set(ip, now + FAILED_WINDOW_MS)
      if (limiters.blockedUntil.size > 10_000) limiters.blockedUntil.delete(limiters.blockedUntil.keys().next().value as string)
      return tooMany(Math.ceil(FAILED_WINDOW_MS / 1000))
    }
    return denied()
  }
  if (!limiters.perKey.hit(key.id, now)) return tooMany(60)
  const scopes = new Set(key.scopes)
  const refused = checkScopes(scopes)
  if (refused) return refused
  const db = (deps.orgDb ?? prismaForOrg)(key.organizationId)
  if (!key.lastUsedAt || now - key.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
    // warunek w zapytaniu: równoległe żądania (i kilka instancji) podbijają najwyżej raz na 5 min; błąd zapisu nie
    // zatrzymuje odczytu
    await db.apiKey
      .updateMany({ where: { id: key.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now - TOUCH_EVERY_MS) } }] }, data: { lastUsedAt: new Date(now) } })
      .catch(() => undefined)
  }
  return { db, organizationId: key.organizationId, keyId: key.id, scopes }
}
