// Token stanowiska druku: `Authorization: Bearer kmd_<43 znaki base64url>` (32 losowe bajty).
//
// W bazie leży tylko SHA-256 tokenu (`tokenHash` jak przy sesjach, lib/auth/sesje.ts). Odnalezienie stanowiska po
// skrócie to JEDYNE miejsce serwera druku z klientem systemowym — firma nie jest jeszcze znana (strażnik
// SYSTEM_CLIENT_ALLOWED w tests/organizacje-izolacja.integration.test.ts). Dalej całe żądanie pracuje na kliencie firmy
// tokenu (prismaForOrg, RLS). Token nieznany, unieważniony, w złym formacie, stanowisko wyłączone i firma nieaktywna =
// ta sama odpowiedź 401, bez rozróżniania powodu. `stanowisko` z zapytania albo treści inne niż `code` tokenu = 403.
//
// Limity w pamięci procesu (jak logowanie, lib/auth/limiter.ts): 30 nieudanych prób na 10 minut z jednego IP (potem
// 429 dla każdego NIEZNANEGO tokenu z tego adresu do końca okna; ważny token przechodzi) i 240 żądań na minutę na stanowisko (agent pyta co 5 s, raz na minutę
// wysyła stan, do tego pliki i wyniki). Tokenu nie logujemy, nawet częściowo; nagłówków też nie.
import 'server-only'
import { randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { clientIp, SlidingLimiter } from '@/lib/auth/limiter'
import { tokenHash } from '@/lib/auth/sesje'
import { prismaForOrg, systemPrisma } from '@/lib/db'

export const PREFIKS_TOKENU = 'kmd_'
export const WZOR_TOKENU = /^kmd_[A-Za-z0-9_-]{43}$/
export const ZADAN_NA_MINUTE = 240
export const NIEUDANYCH_Z_IP = 30
export const OKNO_NIEUDANYCH_MS = 10 * 60_000

/** Nowy token stanowiska: pełna wartość (pokazana raz) i skrót do bazy. */
export function nowyTokenStanowiska(): { token: string; hash: string } {
  const token = PREFIKS_TOKENU + randomBytes(32).toString('base64url')
  return { token, hash: tokenHash(token) }
}

export interface StanowiskoTokenu {
  id: string
  organizationId: string
  code: string
  name: string
}

export interface KontekstStanowiska {
  db: PrismaClient
  organizationId: string
  stanowisko: StanowiskoTokenu
}

/** Token z nagłówka `Authorization: Bearer <token>` albo null. */
export function bearerToken(authorization: string | null): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? '')
  return m ? m[1]! : null
}

/**
 * Aktywne stanowisko tokenu albo null (nieznany, zły format, unieważniony, stanowisko wyłączone, firma nieaktywna —
 * bez rozróżnienia). `sys` = klient systemowy: tabela pod RLS, a firma tokenu nie jest jeszcze znana.
 */
export async function znajdzStanowiskoTokenu(sys: PrismaClient, token: string | null): Promise<StanowiskoTokenu | null> {
  if (!token || !WZOR_TOKENU.test(token)) return null
  const s = await sys.printStation.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: { id: true, organizationId: true, code: true, name: true, disabledAt: true, organization: { select: { active: true } } },
  })
  if (!s || s.disabledAt || !s.organization.active) return null
  return { id: s.id, organizationId: s.organizationId, code: s.code, name: s.name }
}

class Limity {
  readonly naStanowisko = new SlidingLimiter(ZADAN_NA_MINUTE, 60_000)
  readonly nieudaneZIp = new SlidingLimiter(NIEUDANYCH_Z_IP, OKNO_NIEUDANYCH_MS)
  readonly zablokowaneDo = new Map<string, number>()
}

let limity = new Limity()

/** Tylko testy: liczniki od zera. */
export function resetLimitowDruku(): void {
  limity = new Limity()
}

export interface ZaleznosciTokenu {
  sys?: () => PrismaClient
  orgDb?: (organizationId: string) => PrismaClient
  now?: () => number
}

const nieautoryzowany = () =>
  Response.json(
    { error: 'Wymagany ważny token stanowiska w nagłówku Authorization: Bearer kmd_…' },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="Kompletor druk"', 'Cache-Control': 'no-store' } },
  )

const zaDuzo = (sekund: number) =>
  Response.json({ error: 'Za dużo żądań, spróbuj później' }, { status: 429, headers: { 'Retry-After': String(sekund), 'Cache-Control': 'no-store' } })

/**
 * Bramka każdej trasy /api/druk (strażnik w tests/panel-dostep.integration.test.ts): klient firmy tokenu albo gotowa
 * odpowiedź błędu (401 / 429).
 */
export async function requireStationToken(req: Request, deps: ZaleznosciTokenu = {}): Promise<KontekstStanowiska | Response> {
  const now = (deps.now ?? Date.now)()
  const ip = clientIp(req.headers)
  // Najpierw token, potem blokada adresu: stanowiska za jednym NAT-em albo bez odwrotnego proxy
  // (`clientIp` = „nieznany”) dzielą adres, więc stary agent z unieważnionym tokenem nie może odciąć pozostałych.
  // Blokada dotyczy wyłącznie prób z nieznanym tokenem; koszt to jedno zapytanie po indeksie unikalnym na próbę.
  const stanowisko = await znajdzStanowiskoTokenu((deps.sys ?? systemPrisma)(), bearerToken(req.headers.get('authorization')))
  if (!stanowisko) {
    const blokada = limity.zablokowaneDo.get(ip)
    if (blokada !== undefined) {
      if (blokada > now) return zaDuzo(Math.ceil((blokada - now) / 1000))
      limity.zablokowaneDo.delete(ip)
    }
    if (!limity.nieudaneZIp.hit(ip, now)) {
      limity.zablokowaneDo.set(ip, now + OKNO_NIEUDANYCH_MS)
      if (limity.zablokowaneDo.size > 10_000) limity.zablokowaneDo.delete(limity.zablokowaneDo.keys().next().value as string)
      return zaDuzo(Math.ceil(OKNO_NIEUDANYCH_MS / 1000))
    }
    return nieautoryzowany()
  }
  if (!limity.naStanowisko.hit(stanowisko.id, now)) return zaDuzo(60)
  return { db: (deps.orgDb ?? prismaForOrg)(stanowisko.organizationId), organizationId: stanowisko.organizationId, stanowisko }
}

/** `stanowisko` z zapytania albo treści musi być kodem stanowiska tokenu; inaczej 403. */
export function sprawdzKodStanowiska(ctx: KontekstStanowiska, kod: unknown): Response | null {
  if (kod === ctx.stanowisko.code) return null
  return Response.json({ error: 'Token należy do innego stanowiska' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
}
