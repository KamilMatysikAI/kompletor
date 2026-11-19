// Reset hasła mailem (L5): „Nie pamiętam hasła” na stronie logowania → jednorazowy link ważny 60 min
// → /nowe-haslo. Bez zależności od Next (testowalne), klient systemowy jak w lib/auth/zaproszenia.ts.
//
// Transport (audyt bezpieczeństwa 13.11.2026): link idzie WYŁĄCZNIE pocztą instalacji (RESET_SMTP_* w env, lib/poczta/instalacja.ts), nigdy
// serwerem poczty firmy: ten ustawia każdy z uprawnieniem `ustawienia`, a konto jest wspólne dla instalacji, więc link
// na serwer firmy oznaczał przejęcie konta właściciela (i kont w innych firmach). Prośba nie czyta MailSettings.
// Bez poczty instalacji link nie powstaje; hasło startowe nadaje właściciel firmy albo administrator (CLI).
//
// Bez wyroczni: odpowiedź na prośbę jest zawsze ta sama (konto jest albo nie, poczta instalacji jest albo nie), a mail
// wysyła worker z kolejki (zadanie `poczta-reset`), więc czas odpowiedzi nie zdradza, czy konto istnieje. Limity:
// prośby per IP i najwyżej 3 linki na konto na godzinę, liczone z bazy tylko dla linków faktycznie utworzonych
// (dawny limit per adres w pamięci liczył każdą prośbę przed sprawdzeniem konta, więc
// 3 obce prośby blokowały właścicielowi reset na godzinę, także gdy żaden link nie powstał).
//
// Token: 32 losowe bajty; w bazie `tokenHash` (SHA-256) do sprawdzenia linku i — tylko do chwili wysyłki — token
// zaszyfrowany kluczem głównym sekretów (AAD = firma nadawcy + id), bo link musi trafić do maila z workera. Worker
// czyści szyfrogram po próbie wysyłki. Ustawienie hasła: warunkowo jednorazowe (`usedAt` IS NULL), kończy wszystkie
// sesje konta, zdejmuje blokadę i „hasło do zmiany”, unieważnia pozostałe linki. Ślad w AuditLog firmy (bez hasła).
import { randomBytes, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { enqueue } from '../worker/kolejka'
import { prismaForOrg } from '../db'
import { pocztaInstalacji } from '../poczta/instalacja'
import { encryptionKeysFromEnv, openSecret, sealSecret, type Env } from '../sekrety'
import { hashPassword, MIN_PASSWORD_LENGTH } from './hasla'
import { SlidingLimiter } from './limiter'
import { isValidEmail, normalizeEmail, tokenHash } from './sesje'
import { isTokenShape } from './zaproszenia'

export const RESET_TTL_MS = 60 * 60_000
export const RESET_PER_USER_PER_HOUR = 3
export const ZADANIE_RESETU = 'poczta-reset'
export const resetIpLimiter = new SlidingLimiter(10, 15 * 60_000)
export const ustawIpLimiter = new SlidingLimiter(20, 60_000)

export const MSG_RESET_WYSLANY =
  'Jeśli pod tym adresem jest konto, a serwer Kompletora ma ustawioną pocztę, za chwilę przyjdzie mail z linkiem do ustawienia nowego hasła (link działa 60 minut). Mail nie przychodzi? Sprawdź spam albo poproś właściciela firmy o hasło startowe.'
export const MSG_RESET_ZLY_LINK = 'Link do ustawienia hasła wygasł, został już użyty albo jest niepełny. Poproś o nowy na stronie logowania („Nie pamiętam hasła”).'
export const MSG_RESET_SLABE = `Nowe hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.`
export const MSG_RESET_ROZNE = 'Powtórzone hasło nie jest takie samo jak pierwsze.'
export const MSG_RESET_LIMIT = 'Za dużo prób. Spróbuj ponownie za kilka minut.'
export const MSG_RESET_DOWN = 'Nie udało się (baza danych nie odpowiada). Spróbuj za minutę.'

const ref = (id: string) => `reset:${id}`

export interface DepsResetu {
  now?: Date
  env?: Env
  ipLimiter?: SlidingLimiter
  /** Klient firmy do kolejki (testy); domyślnie prismaForOrg. */
  orgClient?: (organizationId: string) => PrismaClient
  log?: (m: string) => void
}

/**
 * Prośba o link. Zawsze kończy się tym samym komunikatem (`MSG_RESET_WYSLANY`) albo limitem; szczegół (brak konta,
 * brak poczty instalacji) tylko w logu serwera bez adresu.
 */
export async function poprosOReset(sys: PrismaClient, p: { email: string; ip: string }, deps: DepsResetu = {}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const now = deps.now ?? new Date()
  const t = now.getTime()
  const email = normalizeEmail(p.email ?? '')
  if (!(deps.ipLimiter ?? resetIpLimiter).hit(p.ip, t)) return { ok: false, message: MSG_RESET_LIMIT }
  if (!isValidEmail(email)) return { ok: true, message: MSG_RESET_WYSLANY }
  const log = deps.log ?? ((m: string) => console.warn(m))
  try {
    const user = await sys.user.findUnique({ where: { email }, select: { id: true, active: true } })
    if (!user?.active) return { ok: true, message: MSG_RESET_WYSLANY }
    // poczta instalacji (env operatora), nigdy poczta firmy: bez niej link nie powstaje
    const inst = pocztaInstalacji(deps.env ?? process.env)
    if (!inst.ok) {
      log(`[reset-hasla] link nie powstał: ${inst.brak}`)
      return { ok: true, message: MSG_RESET_WYSLANY }
    }
    // firma prośby (kolejka workera, ślad w AuditLog, stopka maila): ostatnio używana aktywna firma osoby
    const m = await sys.membership.findFirst({
      where: { userId: user.id, active: true, organization: { active: true } },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { organizationId: 'asc' }],
      select: { organizationId: true },
    })
    const org = m?.organizationId
    if (!org) {
      log('[reset-hasla] konto bez aktywnej firmy — link nie powstał')
      return { ok: true, message: MSG_RESET_WYSLANY }
    }
    // limit per konto po cichu (ta sama odpowiedź), z bazy: liczą się tylko linki, które powstały (i poszły do
    // właściciela adresu), więc seria próśb nie zasypie skrzynki, a prośby bez linku (brak poczty instalacji) nie blokują resetu
    const otwarte = await sys.passwordReset.count({ where: { userId: user.id, createdAt: { gte: new Date(t - 3600_000) } } })
    if (otwarte >= RESET_PER_USER_PER_HOUR) return { ok: true, message: MSG_RESET_WYSLANY }
    const id = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const sealed = sealSecret(encryptionKeysFromEnv(deps.env ?? process.env), org, ref(id), token)
    await sys.passwordReset.create({
      data: {
        id,
        userId: user.id,
        organizationId: org,
        tokenHash: tokenHash(token),
        sealedToken: Buffer.from(sealed.ciphertext),
        sealedIv: Buffer.from(sealed.iv),
        sealedTag: Buffer.from(sealed.authTag),
        keyVersion: sealed.keyVersion,
        expiresAt: new Date(t + RESET_TTL_MS),
        createdAt: now,
      },
    })
    await enqueue((deps.orgClient ?? prismaForOrg)(org), ZADANIE_RESETU, { id }, { dedupeKey: ref(id), maxAttempts: 4 })
  } catch (e) {
    log(`[reset-hasla] błąd: ${e instanceof Error ? e.name : 'błąd'}`)
    return { ok: false, message: MSG_RESET_DOWN }
  }
  return { ok: true, message: MSG_RESET_WYSLANY }
}

/** Token do maila (worker): odszyfrowany szyfrogram prośby albo null (wygasła, użyta, wyczyszczona, inna firma). */
export async function tokenDoWysylki(sys: PrismaClient, p: { id: string; organizationId: string; env: Env; now: Date }): Promise<{ token: string; email: string; expiresAt: Date } | null> {
  const r = await sys.passwordReset.findUnique({ where: { id: p.id }, include: { user: { select: { email: true, active: true } } } })
  if (!r || r.organizationId !== p.organizationId || r.usedAt || r.expiresAt <= p.now || !r.user.active) return null
  if (!r.sealedToken || !r.sealedIv || !r.sealedTag || r.keyVersion == null) return null
  const token = openSecret(encryptionKeysFromEnv(p.env), r.organizationId, ref(r.id), { ciphertext: r.sealedToken, iv: r.sealedIv, authTag: r.sealedTag, keyVersion: r.keyVersion })
  return { token, email: r.user.email, expiresAt: r.expiresAt }
}

/** Po próbie wysyłki token przestaje istnieć w bazie (zostaje tylko skrót do sprawdzenia linku). */
export async function wyczyscToken(sys: PrismaClient, id: string): Promise<void> {
  await sys.passwordReset.updateMany({ where: { id }, data: { sealedToken: null, sealedIv: null, sealedTag: null, keyVersion: null } })
}

/** Czy link jest ważny (strona /nowe-haslo przed pokazaniem formularza). */
export async function linkWazny(sys: PrismaClient, token: string, now = new Date()): Promise<boolean> {
  if (!isTokenShape(token)) return false
  const r = await sys.passwordReset.findUnique({ where: { tokenHash: tokenHash(token) }, select: { usedAt: true, expiresAt: true, user: { select: { active: true } } } })
  return !!r && !r.usedAt && r.expiresAt > now && r.user.active
}

export type WynikUstawienia = { ok: true } | { ok: false; message: string }

/** Ustawienie nowego hasła z linku: jednorazowo, z zakończeniem wszystkich sesji konta. */
export async function ustawNoweHaslo(sys: PrismaClient, p: { token: string; next: string; repeat: string; ip: string }, deps: { now?: Date; ipLimiter?: SlidingLimiter; log?: (m: string) => void } = {}): Promise<WynikUstawienia> {
  const now = deps.now ?? new Date()
  if (!(deps.ipLimiter ?? ustawIpLimiter).hit(p.ip, now.getTime())) return { ok: false, message: MSG_RESET_LIMIT }
  if (!isTokenShape(p.token)) return { ok: false, message: MSG_RESET_ZLY_LINK }
  if (p.next.length < MIN_PASSWORD_LENGTH || p.next.length > 1024) return { ok: false, message: MSG_RESET_SLABE }
  if (p.next !== p.repeat) return { ok: false, message: MSG_RESET_ROZNE }
  try {
    const r = await sys.passwordReset.findUnique({ where: { tokenHash: tokenHash(p.token) }, select: { id: true, userId: true, organizationId: true, usedAt: true, expiresAt: true, user: { select: { active: true } } } })
    if (!r || r.usedAt || r.expiresAt <= now || !r.user.active) return { ok: false, message: MSG_RESET_ZLY_LINK }
    const passwordHash = await hashPassword(p.next)
    return await sys.$transaction(async (tx): Promise<WynikUstawienia> => {
      const used = await tx.passwordReset.updateMany({ where: { id: r.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now, sealedToken: null, sealedIv: null, sealedTag: null, keyVersion: null } })
      if (!used.count) return { ok: false, message: MSG_RESET_ZLY_LINK } // równoległe użycie tego samego linku
      await tx.user.update({ where: { id: r.userId }, data: { passwordHash, failedLogins: 0, lockedUntil: null, mustChangePassword: false } })
      // pozostałe otwarte linki tego konta tracą ważność; wszystkie sesje (we wszystkich firmach) się kończą
      await tx.passwordReset.updateMany({ where: { userId: r.userId, usedAt: null }, data: { usedAt: now, sealedToken: null, sealedIv: null, sealedTag: null, keyVersion: null } })
      const ended = await tx.session.deleteMany({ where: { userId: r.userId } })
      await tx.auditLog.create({ data: { organizationId: r.organizationId, entity: 'User', entityId: r.userId, actorId: r.userId, after: { hasloZmienione: true, zLinkuMailowego: true, sesjeZakonczone: ended.count } } })
      return { ok: true }
    })
  } catch (e) {
    ;(deps.log ?? ((m: string) => console.error(m)))(`[reset-hasla] błąd: ${e instanceof Error ? e.name : 'błąd'}`)
    return { ok: false, message: MSG_RESET_DOWN }
  }
}

/**
 * Sprzątanie (CLI `uzytkownik sprzataj` dla całej instancji, worker raz na dobę per firma): wygasłe linki tracą
 * szyfrogram tokenu, linki wygasłe lub użyte starsze niż doba znikają. Zwraca liczbę usuniętych.
 */
export async function sprzatajResety(sys: PrismaClient, now = new Date(), organizationId?: string): Promise<number> {
  const firma = organizationId ? { organizationId } : {}
  await sys.passwordReset.updateMany({ where: { ...firma, expiresAt: { lte: now }, sealedToken: { not: null } }, data: { sealedToken: null, sealedIv: null, sealedTag: null, keyVersion: null } })
  const doba = new Date(now.getTime() - 24 * 3600_000)
  const r = await sys.passwordReset.deleteMany({ where: { ...firma, OR: [{ expiresAt: { lt: doba } }, { usedAt: { lt: doba } }] } })
  return r.count
}
