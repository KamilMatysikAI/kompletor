// Zaproszenia do firmy w hostingu. W `APP_MODE=hosted` firma nie zakłada kont i nie dołącza cudzych:
// tworzy zaproszenie, a dostęp powstaje dopiero, gdy osoba z linku sama je przyjmie (zalogowana, logując się albo
// zakładając konto z własnym hasłem). Dodający dostaje w panelu tę samą odpowiedź dla adresu nowego, adresu konta
// z innej firmy i konta bez żadnej firmy (przeglądu 2). Granica: w trybie kopiowania linku
// (`copyLinkSender`) link trzyma zapraszający, więc może przyjąć zaproszenie sam i z wyniku drogi „Nie mam konta”
// dowiedzieć się, czy adres ma konto. Dlatego konto założone z linku niewysłanego przez dostawcę (`delivered: false`)
// ma `mustChangePassword` — hasło mógł ustawić ktoś inny niż właściciel adresu. Brak wyroczni dopiero z transportem
// e-mail (link idzie wyłącznie do zaproszonej osoby); sprzedaż hostingu obcym firmom dopiero z nim.
//
// Token: 32 losowe bajty w linku; w bazie wyłącznie jego SHA-256 (`tokenHash`), nigdy w logu ani AuditLog. Ważny
// 7 dni, jednorazowy, do cofnięcia. Tabela `Invitation` jest jak `User` i `Session` (RLS „nikt”), więc moduł dostaje
// klienta systemowego w parametrze, a każde zapytanie ma firmę albo skrót tokenu.
//
// Przyjęcie w jednej transakcji pod tą samą blokadą członkostw firmy co Ustawienia → Użytkownicy (kolejność wierszy
// jak w lib/panel/uzytkownicy.ts, więc bez zakleszczeń): zaproszenie nadal ważne, zapraszający nadal aktywny, nadal ma
// `uzytkownicy` i wszystkie zapraszane uprawnienia, a dla roli właściciela nadal jest właścicielem —
// inaczej zaproszenie przepada. `acceptedAt` warunkowo, więc dwa równoległe kliknięcia dają jedno członkostwo.
//
// Wysyłka: port `InvitationSender`. Domyślny `copyLinkSender` niczego nie wysyła — link wraca raz do osoby
// zapraszającej (jak hasło startowe: nie w adresie, nie w logu, nie w AuditLog). Panel podaje
// `zaproszeniaPoczta` (lib/poczta/zaproszenia.ts) — przy gotowej poczcie firmy link idzie mailem tylko do zaproszonej
// osoby i nie wraca do zapraszającego; bez poczty albo przy błędzie wysyłki zostaje kopiowanie linku.
import { randomBytes } from 'node:crypto'
import type { MemberRole, Prisma, PrismaClient } from '@prisma/client'
import { hashPassword, MIN_PASSWORD_LENGTH } from './hasla'
import { SlidingLimiter } from './limiter'
import { checkCredentials, confirmLogin, createUserWithHash, isValidEmail, normalizeEmail, startSession, tokenHash } from './sesje'
import { permissionsOf } from './uprawnienia'
import { safeError } from './zmiana-hasla'

export const INVITATION_TTL_MS = 7 * 24 * 3600_000
/** Strona /zaproszenie i jej akcje: próby per IP (zgadywanie tokenów, hasła kont). */
export const INVITATION_LIMIT_PER_IP = 20
export const INVITATION_WINDOW_MS = 60_000
export const invitationIpLimiter = new SlidingLimiter(INVITATION_LIMIT_PER_IP, INVITATION_WINDOW_MS)

export const MSG_INVITE_FAIL =
  'Nie udało się przyjąć zaproszenia. Sprawdź e-mail i hasło. Jeśli masz już konto w Kompletorze, zaloguj się nim w części „Mam już konto”. Zaproszenie mogło też wygasnąć albo zostać cofnięte.'
export const MSG_INVITE_OTHER_ACCOUNT = 'Jesteś zalogowany na inne konto niż to, do którego jest zaproszenie. Wyloguj się i przyjmij je właściwym kontem.'
export const MSG_INVITE_LIMIT = 'Za dużo prób. Spróbuj ponownie za minutę.'
export const MSG_INVITE_DOWN = 'Nie udało się przyjąć zaproszenia (baza danych nie odpowiada). Spróbuj za minutę.'
export const MSG_INVITE_NAME = 'Podaj imię i nazwisko.'
export const MSG_INVITE_WEAK = `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.`
export const MSG_INVITE_MISMATCH = 'Powtórzone hasło nie jest takie samo jak pierwsze.'

type Db = PrismaClient | Prisma.TransactionClient

// ─── Port wysyłki ───────────────────────────────────────────────────────────

export interface InvitationMessage {
  /** Id zaproszenia (klucz jednej wysyłki na zaproszenie); bez tokenu. */
  id?: string
  email: string
  organizationName: string
  role: MemberRole
  link: string
  expiresAt: Date
}

/** Dostawca wysyłki zaproszeń (przyszły transport maili). `delivered: false` = link trzeba przekazać ręcznie. */
export interface InvitationSender {
  send(m: InvitationMessage): Promise<{ delivered: boolean }>
}

/** Domyślnie: bez wysyłki. Link wraca raz w stanie akcji do skopiowania i przekazania osobie. */
export const copyLinkSender: InvitationSender = {
  async send() {
    return { delivered: false }
  },
}

/**
 * Adres panelu do linków (`PANEL_URL`), nigdy z nagłówka Host (ten podaje klient). Tylko http(s), bez zapytania i
 * kotwicy; końcowy „/” odcięty. `null` = brak albo zły adres (hosting: czytelna odmowa zaproszenia).
 */
export function panelBaseUrl(env: Record<string, string | undefined>): string | null {
  const raw = (env['PANEL_URL'] ?? '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.search || u.hash || u.username || u.password) return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

export const invitationLink = (base: string, token: string): string => `${base}/zaproszenie?t=${encodeURIComponent(token)}`

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/
export const isTokenShape = (t: string | null | undefined): t is string => typeof t === 'string' && TOKEN_RE.test(t)

// ─── Zakładanie, cofanie, sprzątanie (wołane z lib/panel/uzytkownicy.ts pod blokadą firmy) ─

/**
 * Nowe zaproszenie; otwarte zaproszenie tej firmy na ten adres zostaje cofnięte (nowy link zastępuje stary). Token
 * wraca raz — do linku; w bazie tylko skrót.
 */
export async function createInvitation(
  tx: Db,
  p: { organizationId: string; email: string; role: MemberRole; permissions: string[]; deniedPermissions?: string[]; invitedById: string; now: Date },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const email = normalizeEmail(p.email)
  await tx.invitation.updateMany({ where: { organizationId: p.organizationId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: p.now } })
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(p.now.getTime() + INVITATION_TTL_MS)
  const inv = await tx.invitation.create({
    data: {
      organizationId: p.organizationId,
      email,
      role: p.role,
      permissions: p.permissions,
      deniedPermissions: p.deniedPermissions ?? [],
      invitedById: p.invitedById,
      tokenHash: tokenHash(token),
      expiresAt,
      createdAt: p.now,
    },
    select: { id: true },
  })
  return { id: inv.id, token, expiresAt }
}

/** Dostawca wysyłki potwierdził doręczenie linku zaproszonej osobie. Wołane po `send`, poza blokadą firmy. */
export async function markInvitationDelivered(sys: Db, p: { id: string; organizationId: string }): Promise<void> {
  await sys.invitation.updateMany({ where: { id: p.id, organizationId: p.organizationId }, data: { delivered: true } })
}

/** Sprzątanie: wygasłe i cofnięte zaproszenia (CLI `sprzataj`, jak `purgeExpiredSessions`). */
export async function purgeInvitations(sys: Db, now = new Date()): Promise<number> {
  const r = await sys.invitation.deleteMany({ where: { OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }] } })
  return r.count
}

// ─── Strona /zaproszenie ────────────────────────────────────────────────────

type InvitationRow = Prisma.InvitationGetPayload<{ include: { organization: { select: { name: true; active: true } } } }>

const usable = (inv: InvitationRow | null, now: Date): inv is InvitationRow => !!inv && !inv.acceptedAt && !inv.revokedAt && inv.expiresAt > now && inv.organization.active

async function findByToken(db: Db, token: string): Promise<InvitationRow | null> {
  if (!isTokenShape(token)) return null
  return db.invitation.findUnique({ where: { tokenHash: tokenHash(token) }, include: { organization: { select: { name: true, active: true } } } })
}

/** Treść strony: tylko nazwa firmy i rola (bez adresu e-mail i zapraszającego). `null` = nieważne. GET niczego nie zmienia. */
export async function invitationInfo(sys: Db, token: string, now = new Date()): Promise<{ organizationName: string; role: MemberRole } | null> {
  const inv = await findByToken(sys, token)
  return usable(inv, now) ? { organizationName: inv.organization.name, role: inv.role } : null
}

interface LockedRow {
  userId: string
  role: MemberRole
  permissions: string[]
  deniedPermissions: string[]
  active: boolean
  userActive: boolean
}

type Outcome = { ok: true; organizationId: string } | { ok: false; reason: 'invalid' | 'email'; revoke?: boolean }

/** Przyjęcie przez konto `user` w transakcji `tx` (zaproszenie `inv` przeczytane w tej transakcji). */
async function acceptInTx(tx: Prisma.TransactionClient, inv: InvitationRow, user: { id: string; email: string }, now: Date): Promise<Outcome> {
  if (inv.email !== user.email) return { ok: false, reason: 'email' }
  // ta sama blokada i kolejność co `locked` w lib/panel/uzytkownicy.ts: zmiany uprawnień zapraszającego idą po kolei
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT m."userId", m.role::text AS role, m.permissions, COALESCE(m."deniedPermissions", ARRAY[]::text[]) AS "deniedPermissions", m.active, u.active AS "userActive"
    FROM "Membership" m JOIN "User" u ON u.id = m."userId"
    WHERE m."organizationId" = ${inv.organizationId}
    ORDER BY m."userId"
    FOR UPDATE OF m`
  const inviter = rows.find((r) => r.userId === inv.invitedById && r.active && r.userActive)
  const perms = inviter ? permissionsOf(inviter) : null
  const granted = permissionsOf(inv)
  const inviterOk = !!inviter && !!perms?.has('uzytkownicy') && [...granted].every((p) => perms.has(p)) && (inv.role !== 'WLASCICIEL' || inviter.role === 'WLASCICIEL')
  const existing = rows.find((r) => r.userId === user.id)
  // wyłączona osoba tej firmy wraca tylko przez „Włącz dostęp” (kontrola), nie przez stare zaproszenie
  if (!inviterOk || (existing && !existing.active)) return { ok: false, reason: 'invalid', revoke: true }
  const taken = await tx.invitation.updateMany({
    where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { acceptedAt: now, acceptedById: user.id },
  })
  if (!taken.count) return { ok: false, reason: 'invalid' }
  if (!existing) {
    // zestaw z zaproszenia 1:1: dołożone i odebrane z roli (sprawdzone wyżej względem zapraszającego, `permissionsOf`)
    await tx.membership.create({ data: { organizationId: inv.organizationId, userId: user.id, role: inv.role, permissions: inv.permissions, deniedPermissions: inv.deniedPermissions ?? [] } })
    // kto nadał (zapraszający), kto przyjął, komu, co; bez tokenu i jego skrótu
    await tx.auditLog.create({
      data: {
        organizationId: inv.organizationId,
        entity: 'Membership',
        entityId: user.id,
        actorId: inv.invitedById,
        after: { role: inv.role, permissions: inv.permissions, deniedPermissions: inv.deniedPermissions ?? [], active: true, zaproszenie: inv.id, przyjete: true, przyjalId: user.id },
      },
    })
  } else {
    // osoba jest już aktywnym członkiem (dostęp nadany inną drogą po zaproszeniu, np. CLI `dostep`). Rola
    // i uprawnienia z zaproszenia NIE nadpisują nadanych — inaczej „zaproszenie na właściciela, potem CLI jako magazyn,
    // potem przyjęcie” dawałoby właściciela. Zaproszenie się zamyka, a AuditLog zapisuje przyjęcie bez zmiany dostępu.
    await tx.auditLog.create({
      data: {
        organizationId: inv.organizationId,
        entity: 'Invitation',
        entityId: inv.id,
        actorId: user.id,
        after: { przyjete: true, przyjalId: user.id, bezZmianyDostepu: true, rolaZaproszenia: inv.role, rolaOsoby: existing.role },
      },
    })
  }
  return { ok: true, organizationId: inv.organizationId }
}

async function revokeById(sys: Db, id: string, now: Date): Promise<void> {
  await sys.invitation.updateMany({ where: { id, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
}

class Rollback extends Error {
  constructor(readonly outcome: Outcome) {
    super('rollback')
  }
}

const TX = { timeout: 20_000, maxWait: 20_000 } as const

/** Przyjęcie przez osobę zalogowaną (konto z sesji). */
export async function acceptAsUser(sys: PrismaClient, p: { token: string; userId: string; now: Date }): Promise<Outcome> {
  const user = await sys.user.findUnique({ where: { id: p.userId }, select: { id: true, email: true, active: true } })
  if (!user?.active || !isTokenShape(p.token)) return { ok: false, reason: 'invalid' }
  const r = await sys.$transaction(async (tx) => {
    const inv = await findByToken(tx, p.token)
    if (!usable(inv, p.now)) return { ok: false as const, reason: 'invalid' as const }
    const out = await acceptInTx(tx, inv, user, p.now)
    if (!out.ok && out.revoke) await revokeById(tx, inv.id, p.now)
    return out
  }, TX)
  return r
}

type Session = { token: string; expiresAt: Date }

/**
 * Przyjęcie z logowaniem (e-mail i hasło konta, także konta bez żadnej firmy — zwykłe logowanie odmówiłoby mu).
 * Złe dane liczą się do tej samej blokady konta co logowanie. Sesja startuje w zapraszającej firmie.
 * najpierw ważne zaproszenie (bez argonu), dopiero potem hasło — bez ważnego tokenu ta strona nie jest drugim
 * punktem logowania (zgadywanie haseł, nabijanie blokady konta, koszt argonu na śmieciowe żądania). Ważność tokenu
 * i tak widać na GET, więc kolejność niczego nie zdradza.
 */
export async function acceptWithLogin(
  sys: PrismaClient,
  p: { token: string; email: string; password: string; now: Date; userAgent?: string | null },
): Promise<{ ok: true; organizationId: string; session: Session } | { ok: false }> {
  const inv = await findByToken(sys, p.token)
  if (!usable(inv, p.now)) return { ok: false }
  const cred = await checkCredentials(sys, p.email, p.password, p.now)
  if (!cred.ok || inv.email !== cred.email) return { ok: false }
  if (!(await confirmLogin(sys, cred.userId, p.now))) return { ok: false }
  const out = await sys.$transaction(async (tx) => {
    const fresh = await findByToken(tx, p.token)
    if (!usable(fresh, p.now)) return { ok: false as const, reason: 'invalid' as const }
    const o = await acceptInTx(tx, fresh, { id: cred.userId, email: cred.email }, p.now)
    if (!o.ok && o.revoke) await revokeById(tx, fresh.id, p.now)
    return o
  }, TX)
  if (!out.ok) return { ok: false }
  return { ok: true, organizationId: out.organizationId, session: await startSession(sys, { userId: cred.userId, organizationId: out.organizationId, now: p.now, userAgent: p.userAgent }) }
}

/**
 * Przyjęcie z założeniem konta. Hasło podaje przyjmujący; `mustChangePassword` tylko, gdy link nie przyszedł od
 * dostawcy wysyłki (`delivered: false`): wtedy przyjąć mógł zapraszający, który trzyma link. Adres musi być tym
 * z zaproszenia; adres,
 * który ma już konto, kończy się tym samym ogólnym niepowodzeniem co każde inne. Skrót hasła liczony zawsze i przed
 * transakcją — czas nie zdradza, czy konto istnieje.
 */
export async function acceptWithNewAccount(
  sys: PrismaClient,
  p: { token: string; email: string; name: string; password: string; now: Date; userAgent?: string | null },
): Promise<{ ok: true; organizationId: string; session: Session } | { ok: false }> {
  const email = normalizeEmail(p.email)
  const name = p.name.trim().slice(0, 120)
  if (!isValidEmail(email) || !name || p.password.length < MIN_PASSWORD_LENGTH || p.password.length > 1024) return { ok: false }
  const passwordHash = await hashPassword(p.password)
  let organizationId: string
  let userId: string
  try {
    ;({ organizationId, userId } = await sys.$transaction(async (tx) => {
      const inv = await findByToken(tx, p.token)
      if (!usable(inv, p.now) || inv.email !== email) throw new Rollback({ ok: false, reason: 'invalid' })
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) throw new Rollback({ ok: false, reason: 'invalid' })
      const u = await createUserWithHash(tx, { email, name, passwordHash, mustChangePassword: !inv.delivered })
      const o = await acceptInTx(tx, inv, { id: u.id, email }, p.now)
      if (!o.ok) throw new Rollback(o)
      return { organizationId: o.organizationId, userId: u.id }
    }, TX))
  } catch (e) {
    if (e instanceof Rollback) {
      // zapraszający stracił prawa: zaproszenie przepada (poza wycofaną transakcją z kontem)
      if (!e.outcome.ok && e.outcome.revoke) {
        const inv = await findByToken(sys, p.token)
        if (inv) await revokeById(sys, inv.id, p.now)
      }
      return { ok: false }
    }
    // równoległe założenie konta o tym samym adresie: unikalny e-mail
    if (typeof e === 'object' && e && (e as { code?: string }).code === 'P2002') return { ok: false }
    throw e
  }
  return { ok: true, organizationId, session: await startSession(sys, { userId, organizationId, now: p.now, userAgent: p.userAgent }) }
}

// ─── Logika formularzy strony (bez Next, testowalna; jak lib/auth/logowanie.ts) ─

export type AcceptInput =
  | { kind: 'session'; token: string; userId: string }
  | { kind: 'login'; token: string; email: string; password: string }
  | { kind: 'new'; token: string; email: string; name: string; password: string; repeat: string }

export type AcceptAttempt = { ok: true; organizationId: string; session: Session | null } | { ok: false; message: string }

export interface AcceptDeps {
  limiter?: SlidingLimiter
  now?: Date
  log?: (msg: string) => void
}

/**
 * Przyjęcie z formularza: limit per IP, wywołanie, komunikat. Każde niepowodzenie (zły token, złe hasło, adres z
 * kontem przy zakładaniu, adres spoza zaproszenia, zapraszający bez praw) daje ten sam komunikat — poza kontem
 * zalogowanym na inny adres, gdzie mówimy tylko tyle (bez adresu z zaproszenia). Hasła i token nie trafiają do logu.
 */
export async function attemptAccept(sys: PrismaClient, input: AcceptInput, ctx: { ip: string; userAgent?: string | null }, deps: AcceptDeps = {}): Promise<AcceptAttempt> {
  const now = deps.now ?? new Date()
  if (!(deps.limiter ?? invitationIpLimiter).hit(ctx.ip, now.getTime())) return { ok: false, message: MSG_INVITE_LIMIT }
  if (input.kind === 'new') {
    if (!input.name.trim()) return { ok: false, message: MSG_INVITE_NAME }
    if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 1024) return { ok: false, message: MSG_INVITE_WEAK }
    if (input.password !== input.repeat) return { ok: false, message: MSG_INVITE_MISMATCH }
  }
  try {
    if (input.kind === 'session') {
      const r = await acceptAsUser(sys, { token: input.token, userId: input.userId, now })
      if (r.ok) return { ok: true, organizationId: r.organizationId, session: null }
      return { ok: false, message: r.reason === 'email' ? MSG_INVITE_OTHER_ACCOUNT : MSG_INVITE_FAIL }
    }
    const r =
      input.kind === 'login'
        ? await acceptWithLogin(sys, { token: input.token, email: input.email, password: input.password, now, userAgent: ctx.userAgent })
        : await acceptWithNewAccount(sys, { token: input.token, email: input.email, name: input.name, password: input.password, now, userAgent: ctx.userAgent })
    return r.ok ? { ok: true, organizationId: r.organizationId, session: r.session } : { ok: false, message: MSG_INVITE_FAIL }
  } catch (e) {
    ;(deps.log ?? ((m: string) => console.error(m)))(`[zaproszenie] błąd: ${safeError(e)}`)
    return { ok: false, message: MSG_INVITE_DOWN }
  }
}
