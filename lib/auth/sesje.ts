// Logowanie i sesje panelu.
//
// Użytkownik jest wspólny dla instalacji (jedno konto może należeć do kilku firm — hosting), a przynależność do
// firmy i rola są w `Membership` (pod RLS jak dane). Tabele `User` i `Session` mają RLS z polityką „nikt”: rola
// aplikacji `logistyka_app` nie czyta ich nigdy, więc obsługuje je wyłącznie ten moduł przez klienta systemowego.
// Ekrany dostają od `requireSession` (lib/panel/kontekst.ts) tylko klienta firmy z sesji.
//
// Sesja: losowy token 32 bajty w ciasteczku httpOnly; w bazie leży wyłącznie jego SHA-256 (wyciek bazy nie daje
// sesji). Wygasa po 12 h bezczynności albo 7 dniach od logowania. 5 błędnych haseł z rzędu = blokada konta 15 min.
// ostatnia aktywność per firma (`Membership.lastSeenAt`) dotykana razem z sesją; hasło startowe
// do zmiany przy pierwszym logowaniu (`User.mustChangePassword`); „Zakończ pozostałe sesje” bez hasła.
import { createHash, randomBytes } from 'node:crypto'
import type { MemberRole, Prisma, PrismaClient } from '@prisma/client'
import { dummyHash, generatePassword, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './hasla'
import { permissionsOf, type Permission } from './uprawnienia'

export { SESSION_COOKIE } from './sesja-ciasteczko'
export const IDLE_MS = 12 * 3600_000
export const ABSOLUTE_MS = 7 * 24 * 3600_000
export const TOUCH_EVERY_MS = 5 * 60_000
export const MAX_FAILED = 5
export const LOCK_MS = 15 * 60_000

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email)
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface OrgMembership {
  organizationId: string
  slug: string
  name: string
  role: MemberRole
  permissions: string[]
  /** odebrane z zestawu roli; uprawnienia sesji liczy `permissionsOf` (lib/auth/uprawnienia.ts) */
  deniedPermissions: string[]
}

export interface SessionContext {
  sessionId: string
  user: { id: string; email: string; name: string }
  organization: OrgMembership
  permissions: Set<Permission>
  memberships: OrgMembership[]
  /** hasło startowe — do zmiany, zanim osoba zobaczy cokolwiek poza /ustawienia/haslo (lib/panel/kontekst.ts) */
  mustChangePassword: boolean
  /** gęstość panelu wybrana przez osobę (`null` = domyślna); wartość czyta lib/panel/gestosc.ts */
  gestosc?: string | null
  /** ukryte kolumny tabel (`User.kolumnyTabel`); wartość czyta lib/panel/kolumny.ts */
  kolumnyTabel?: unknown
  /** alerty listy zamówień schowane „Ignoruj” (`User.ukryteAlerty`); wartość czyta lib/panel/alerty-listy.ts */
  ukryteAlerty?: unknown
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'locked' | 'no_org' }

async function activeMemberships(sys: PrismaClient, userId: string): Promise<OrgMembership[]> {
  const rows = await sys.membership.findMany({
    where: { userId, active: true, organization: { active: true } },
    include: { organization: { select: { slug: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((m) => ({ organizationId: m.organizationId, slug: m.organization.slug, name: m.organization.name, role: m.role, permissions: m.permissions, deniedPermissions: m.deniedPermissions ?? [] }))
}

/**
 * Błędne hasło (logowanie i zmiana hasła): licznik atomowo w bazie, równoległe próby nie mogą
 * zgubić przyrostu i ominąć blokady. `true`, gdy ta próba zablokowała konto.
 */
async function registerFailedPassword(sys: PrismaClient, userId: string, now: Date): Promise<boolean> {
  const rows = await sys.$queryRaw<{ failed: number }[]>`
    UPDATE "User" SET
      "failedLogins" = CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN 1 ELSE "failedLogins" + 1 END,
      "lockedUntil" = CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN NULL ELSE "lockedUntil" END,
      "updatedAt" = ${now}
    WHERE id = ${userId}
    RETURNING "failedLogins" AS failed`
  if (Number(rows[0]?.failed ?? 0) < MAX_FAILED) return false
  await sys.user.updateMany({ where: { id: userId, failedLogins: { gte: MAX_FAILED } }, data: { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) } })
  return true
}

export type CredentialsResult = { ok: true; userId: string; email: string } | { ok: false; reason: 'invalid' | 'locked' }

/**
 * Sprawdzenie e-maila i hasła z licznikiem błędów i blokadą konta (logowanie i przyjęcie zaproszenia).
 * Nie zmienia stanu przy dobrym haśle — to robi `confirmLogin`, gdy logowanie naprawdę dochodzi do skutku. Czas
 * odpowiedzi nie zdradza, czy konto istnieje (porównanie ze skrótem-wabikiem).
 */
export async function checkCredentials(sys: PrismaClient, emailRaw: string, password: string, now: Date): Promise<CredentialsResult> {
  const email = normalizeEmail(emailRaw)
  if (!isValidEmail(email) || !password || password.length > 1024) {
    await verifyPassword(await dummyHash(), password || 'x')
    return { ok: false, reason: 'invalid' }
  }
  const user = await sys.user.findUnique({ where: { email } })
  if (!user || !user.active) {
    await verifyPassword(await dummyHash(), password)
    return { ok: false, reason: 'invalid' }
  }
  if (user.lockedUntil && user.lockedUntil > now) return { ok: false, reason: 'locked' }
  const ok = await verifyPassword(user.passwordHash, password)
  if (!ok) {
    return { ok: false, reason: (await registerFailedPassword(sys, user.id, now)) ? 'locked' : 'invalid' }
  }
  return { ok: true, userId: user.id, email: user.email }
}

/** Dobre hasło liczy się tylko, gdy konto nie zostało zablokowane w międzyczasie (równoległe błędne próby). */
export async function confirmLogin(sys: Db, userId: string, now: Date): Promise<boolean> {
  const unlocked = await sys.user.updateMany({
    where: { id: userId, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now },
  })
  return unlocked.count > 0
}

/** Nowa sesja w podanej firmie (osoba musi do niej należeć — sprawdza wywołujący). Token wraca raz, do ciasteczka. */
export async function startSession(sys: Db, p: { userId: string; organizationId: string; now: Date; userAgent?: string | null }): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(p.now.getTime() + ABSOLUTE_MS)
  await sys.session.create({
    data: { id: tokenHash(token), userId: p.userId, organizationId: p.organizationId, createdAt: p.now, lastSeenAt: p.now, expiresAt, userAgent: p.userAgent?.slice(0, 200) ?? null },
  })
  await touchMembership(sys, p.userId, p.organizationId, p.now)
  return { token, expiresAt }
}

/** ostatnia aktywność osoby w firmie — to samo zdarzenie co `lastSeenAt` sesji (ta sama częstotliwość). */
async function touchMembership(sys: Db, userId: string, organizationId: string, now: Date): Promise<void> {
  await sys.membership.updateMany({ where: { organizationId, userId }, data: { lastSeenAt: now } })
}

/** Logowanie e-mailem i hasłem. Ten sam komunikat dla złego e-maila i złego hasła. */
export async function login(sys: PrismaClient, emailRaw: string, password: string, ctx: { now?: Date; userAgent?: string | null } = {}): Promise<LoginResult> {
  const now = ctx.now ?? new Date()
  const cred = await checkCredentials(sys, emailRaw, password, now)
  if (!cred.ok) return cred
  const orgs = await activeMemberships(sys, cred.userId)
  if (!orgs.length) return { ok: false, reason: 'no_org' }
  if (!(await confirmLogin(sys, cred.userId, now))) return { ok: false, reason: 'locked' }
  const s = await startSession(sys, { userId: cred.userId, organizationId: orgs[0]!.organizationId, now, userAgent: ctx.userAgent })
  return { ok: true, ...s }
}

/**
 * Sesja z tokenu ciasteczka. `null`, gdy token nie istnieje, wygasł (bezczynność albo limit), konto jest wyłączone
 * albo użytkownik nie należy już do żadnej aktywnej firmy. Firma sesji, z której go usunięto, przechodzi na pierwszą
 * aktywną — nigdy na firmę spoza jego przynależności.
 */
export async function resolveSession(sys: PrismaClient, token: string | undefined | null, ctx: { now?: Date } = {}): Promise<SessionContext | null> {
  if (!token || token.length > 200) return null
  const now = ctx.now ?? new Date()
  const id = tokenHash(token)
  const s = await sys.session.findUnique({ where: { id }, include: { user: true } })
  if (!s) return null
  if (s.expiresAt <= now || now.getTime() - s.lastSeenAt.getTime() > IDLE_MS || !s.user.active) {
    await sys.session.deleteMany({ where: { id } })
    return null
  }
  const memberships = await activeMemberships(sys, s.userId)
  const org = memberships.find((m) => m.organizationId === s.organizationId) ?? memberships[0]
  if (!org) {
    await sys.session.deleteMany({ where: { id } })
    return null
  }
  if (org.organizationId !== s.organizationId || now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await sys.session.update({ where: { id }, data: { organizationId: org.organizationId, lastSeenAt: now } })
    await touchMembership(sys, s.userId, org.organizationId, now)
  }
  return {
    sessionId: id,
    user: { id: s.user.id, email: s.user.email, name: s.user.name },
    organization: org,
    permissions: permissionsOf(org),
    memberships,
    mustChangePassword: s.user.mustChangePassword,
    gestosc: s.user.gestosc,
    kolumnyTabel: s.user.kolumnyTabel,
    ukryteAlerty: s.user.ukryteAlerty,
  }
}

/** Przełączenie firmy w sesji — tylko na firmę, do której użytkownik należy. */
export async function switchOrganization(sys: PrismaClient, token: string, organizationId: string, ctx: { now?: Date } = {}): Promise<boolean> {
  const cur = await resolveSession(sys, token, ctx)
  if (!cur || !cur.memberships.some((m) => m.organizationId === organizationId)) return false
  const now = ctx.now ?? new Date()
  await sys.session.update({ where: { id: cur.sessionId }, data: { organizationId, lastSeenAt: now } })
  await touchMembership(sys, cur.user.id, organizationId, now)
  return true
}

export async function logout(sys: PrismaClient, token: string | undefined | null): Promise<void> {
  if (!token || token.length > 200) return
  await sys.session.deleteMany({ where: { id: tokenHash(token) } })
}

// ─── Zarządzanie kontami (CLI scripts/uzytkownik.ts, Ustawienia → Użytkownicy) ─

/** Klient systemowy albo transakcja na nim (Ustawienia → Użytkownicy robią zmiany pod blokadą). */
type Db = PrismaClient | Prisma.TransactionClient

export async function createUser(sys: Db, p: { email: string; name: string; password: string }): Promise<{ id: string }> {
  return createUserWithHash(sys, { email: p.email, name: p.name, passwordHash: await hashPassword(p.password) })
}

/**
 * Konto z gotowym skrótem hasła: argon2 czeka w kolejce `argonGate`, więc liczy się go PRZED transakcją pod
 * blokadą członkostw firmy, nie w niej. `mustChangePassword` dla hasła nadanego przez kogoś innego.
 */
export async function createUserWithHash(sys: Db, p: { email: string; name: string; passwordHash: string; mustChangePassword?: boolean }): Promise<{ id: string }> {
  const email = normalizeEmail(p.email)
  if (!isValidEmail(email)) throw new Error('Nieprawidłowy adres e-mail')
  if (!p.name.trim()) throw new Error('Brak imienia i nazwiska')
  return sys.user.create({ data: { email, name: p.name.trim(), passwordHash: p.passwordHash, mustChangePassword: p.mustChangePassword ?? false }, select: { id: true } })
}

/** CLI `haslo`: hasło nadane przez obsługę jest startowe — osoba zmienia je przy pierwszym logowaniu. */
export async function setPassword(sys: PrismaClient, emailRaw: string, password: string): Promise<void> {
  const email = normalizeEmail(emailRaw)
  const passwordHash = await hashPassword(password)
  const r = await sys.user.updateMany({ where: { email }, data: { passwordHash, failedLogins: 0, lockedUntil: null, mustChangePassword: true } })
  if (!r.count) throw new Error('Nie ma konta o tym adresie')
  // zmiana hasła wylogowuje wszystkie sesje
  await sys.session.deleteMany({ where: { user: { email } } })
}

export async function grantMembership(sys: Db, p: { email: string; organizationId: string; role: MemberRole; permissions?: string[]; deniedPermissions?: string[] }): Promise<void> {
  const user = await sys.user.findUnique({ where: { email: normalizeEmail(p.email) } })
  if (!user) throw new Error('Nie ma konta o tym adresie')
  const org = await sys.organization.findUnique({ where: { id: p.organizationId } })
  if (!org) throw new Error('Nie ma takiej firmy')
  // Bez `permissions` istniejące dodatkowe uprawnienia zostają; podane = zastępują. To samo
  // z odebranymi (`deniedPermissions`): bez nich zostają zapisane, czyli zmiana roli z CLI niczego osobie nie przywraca.
  await sys.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    create: { organizationId: org.id, userId: user.id, role: p.role, permissions: p.permissions ?? [], deniedPermissions: p.deniedPermissions ?? [] },
    update: { role: p.role, active: true, ...(p.permissions ? { permissions: p.permissions } : {}), ...(p.deniedPermissions ? { deniedPermissions: p.deniedPermissions } : {}) },
  })
}

export async function revokeMembership(sys: PrismaClient, emailRaw: string, organizationId: string): Promise<void> {
  const user = await sys.user.findUnique({ where: { email: normalizeEmail(emailRaw) } })
  if (!user) throw new Error('Nie ma konta o tym adresie')
  await sys.membership.updateMany({ where: { userId: user.id, organizationId }, data: { active: false } })
}

/** Hasło startowe i jego skrót, liczone przed transakcją. Hasło wraca osobie dodającej najwyżej raz. */
export interface StartPassword {
  password: string
  passwordHash: string
}

export async function prepareStartPassword(): Promise<StartPassword> {
  const password = generatePassword()
  return { password, passwordHash: await hashPassword(password) }
}

export type AddPersonResult =
  | { ok: true; userId: string; created: boolean; password: string | null; before: { role: MemberRole; permissions: string[]; deniedPermissions: string[]; active: boolean } | null }
  | { ok: false; reason: 'already_member' }

/**
 * Dodanie osoby do firmy (wspólne dla CLI `dodaj` i Ustawień → Użytkownicy). Nowe konto dostaje hasło
 * startowe z `generatePassword` (zasady haseł tylko w lib/auth/hasla.ts) — wynik zwraca je raz, do pokazania osobie
 * dodającej; nie zapisuj go nigdzie. Istniejące konto (np. z innej firmy w hostingu) dostaje tylko dostęp do tej
 * firmy, hasło bez zmian (`password: null`), imię i nazwisko jak w koncie (należy do osoby); osoba z aktywnym
 * dostępem → `already_member`. Skrót hasła startowego przychodzi gotowy (`start`): ta funkcja bywa wołana pod
 * blokadą członkostw firmy i nie może tam czekać na argon2. Nowe konto musi zmienić hasło startowe.
 */
export async function addPerson(db: Db, p: AddPersonInput & { start: StartPassword }): Promise<AddPersonResult> {
  const email = normalizeEmail(p.email)
  const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (!existing) {
    const u = await createUserWithHash(db, { email, name: p.name, passwordHash: p.start.passwordHash, mustChangePassword: true })
    await db.membership.create({ data: { organizationId: p.organizationId, userId: u.id, role: p.role, permissions: p.permissions ?? [], deniedPermissions: p.deniedPermissions ?? [] } })
    return { ok: true, userId: u.id, created: true, password: p.start.password, before: null }
  }
  const m = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: p.organizationId, userId: existing.id } } })
  if (m?.active) return { ok: false, reason: 'already_member' }
  await grantMembership(db, { email, organizationId: p.organizationId, role: p.role, permissions: p.permissions ?? [], deniedPermissions: p.deniedPermissions ?? [] })
  return { ok: true, userId: existing.id, created: false, password: null, before: m ? { role: m.role, permissions: m.permissions, deniedPermissions: m.deniedPermissions ?? [], active: m.active } : null }
}

export interface AddPersonInput {
  email: string
  name: string
  organizationId: string
  role: MemberRole
  permissions?: string[]
  /** odebrane z zestawu roli (Ustawienia → Użytkownicy); bez = nic nie odebrane */
  deniedPermissions?: string[]
}

/** CLI: osobna transakcja, żeby błąd między kontem a członkostwem nie zostawił konta bez hasła do przekazania. */
export async function addPersonAtomic(sys: PrismaClient, p: AddPersonInput): Promise<AddPersonResult> {
  const start = await prepareStartPassword()
  return sys.$transaction((tx) => addPerson(tx, { ...p, start }), { timeout: 20_000, maxWait: 20_000 })
}

export type ChangePasswordResult = { ok: true } | { ok: false; reason: 'invalid_current' | 'weak' | 'same' | 'locked' }

/**
 * Zmiana własnego hasła: wymaga obecnego hasła; nowe według zasad z lib/auth/hasla.ts. Po zmianie
 * znikają wszystkie sesje tej osoby poza bieżącą (`keepSessionId` = id sesji, czyli skrót tokenu). Błędne obecne
 * hasło liczy się do tej samej blokady co logowanie; blokada wstrzymuje też zmianę (istniejące sesje działają dalej).
 * Ślad w AuditLog firmy z bieżącej sesji (AuditLog jest per firma; chodzi o „kiedy”): bez hasła i skrótu.
 */
export async function changeOwnPassword(
  sys: PrismaClient,
  p: { userId: string; organizationId: string; current: string; next: string; keepSessionId: string; now?: Date },
): Promise<ChangePasswordResult> {
  const now = p.now ?? new Date()
  const user = await sys.user.findUnique({ where: { id: p.userId } })
  if (!user || !user.active || !p.current || p.current.length > 1024) {
    await verifyPassword(await dummyHash(), p.current || 'x')
    return { ok: false, reason: 'invalid_current' }
  }
  if (user.lockedUntil && user.lockedUntil > now) return { ok: false, reason: 'locked' }
  if (!(await verifyPassword(user.passwordHash, p.current))) return { ok: false, reason: (await registerFailedPassword(sys, user.id, now)) ? 'locked' : 'invalid_current' }
  if (p.next.length < MIN_PASSWORD_LENGTH || p.next.length > 1024) return { ok: false, reason: 'weak' }
  if (p.next === p.current) return { ok: false, reason: 'same' }
  const passwordHash = await hashPassword(p.next)
  // tylko gdy hasło nie zmieniło się w międzyczasie (równoległa zmiana z innej sesji albo CLI)
  // razem: nowe hasło nie może zostać przy żywych starych sesjach (błąd między zapisami)
  return sys.$transaction(async (tx): Promise<ChangePasswordResult> => {
    const r = await tx.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash, failedLogins: 0, lockedUntil: null, mustChangePassword: false } })
    if (!r.count) return { ok: false, reason: 'invalid_current' }
    const ended = await tx.session.deleteMany({ where: { userId: user.id, id: { not: p.keepSessionId } } })
    await tx.auditLog.create({ data: { organizationId: p.organizationId, entity: 'User', entityId: user.id, actorId: user.id, after: { hasloZmienione: true, sesjeZakonczone: ended.count } } })
    return { ok: true }
  })
}

/**
 * „Zakończ pozostałe sesje” (przegląd 2): bez hasła, więc działa także w czasie blokady konta, którą
 * atakujący znający tylko e-mail może podtrzymywać złymi logowaniami. Tylko z żywej sesji tej osoby (`keepSessionId`
 * musi należeć do niej) — ona zostaje, wszystkie inne sesje osoby (we wszystkich firmach) znikają. Bez limitu: akcja
 * niczego nie zgaduje. Ślad w AuditLog firmy z bieżącej sesji w tej samej transakcji. `null` = sesji już nie ma.
 */
export async function endOtherSessions(sys: PrismaClient, p: { userId: string; organizationId: string; keepSessionId: string }): Promise<number | null> {
  return sys.$transaction(async (tx) => {
    const own = await tx.session.findFirst({ where: { id: p.keepSessionId, userId: p.userId }, select: { userAgent: true } })
    if (!own) return null
    const ended = await tx.session.deleteMany({ where: { userId: p.userId, id: { not: p.keepSessionId } } })
    // akcja jest symetryczna (nie rozstrzyga, kto jest właścicielem konta), więc ślad mówi,
    // z jakiej przeglądarki kliknięto — obsługa widzi to po zgłoszeniu „ktoś mnie wylogował”
    await tx.auditLog.create({
      data: { organizationId: p.organizationId, entity: 'User', entityId: p.userId, actorId: p.userId, after: { sesjeZakonczone: ended.count, zostalaPrzegladarka: own.userAgent?.slice(0, 200) ?? null } },
    })
    return ended.count
  })
}

/** Sprzątanie wygasłych sesji (worker albo CLI). */
export async function purgeExpiredSessions(sys: PrismaClient, now = new Date()): Promise<number> {
  const r = await sys.session.deleteMany({ where: { OR: [{ expiresAt: { lte: now } }, { lastSeenAt: { lt: new Date(now.getTime() - IDLE_MS) } }] } })
  return r.count
}
