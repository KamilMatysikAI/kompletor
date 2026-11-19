// Ustawienia → Użytkownicy: lista osób firmy, rola i dodatkowe uprawnienia, dodanie osoby, wyłączenie
// dostępu. Tabele User i Session są poza zasięgiem roli aplikacji (RLS „nikt”), więc ten moduł pracuje
// klientem systemowym — i dlatego KAŻDE zapytanie ma tu jawnie firmę osoby wykonującej (`actor.organizationId`),
// a uprawnienie `uzytkownicy` jest sprawdzane z bazy, nie z sesji (strażnik: tests/organizacje-izolacja).
//
// Zmiany idą w transakcji pod blokadą wszystkich członkostw firmy (SELECT … FOR UPDATE): dwa równoległe żądania
// (np. dwóch właścicieli odbierających sobie nawzajem rolę) wykonują się po kolei, więc ostatni właściciel zostaje.
// Bezpieczniki (poza ostatnim właścicielem): rolę właściciela nadaje i odbiera, a właściciela wyłącza i włącza tylko
// właściciel (po ROLI: komplet uprawnień nie czyni właścicielem); nadawać i odbierać wolno tylko uprawnienia, które
// się samemu ma; ponowne włączenie dostępu przywraca uprawnienia, więc liczy się jak ich nadanie; osobę zarządzającą
// osobami z szerszymi uprawnieniami niż własne wyłącza tylko ktoś co najmniej taki; własnego dostępu nie wyłącza się
// z panelu. Każda zmiana ląduje w AuditLog firmy: kto (actorId), komu (entityId = id osoby), co (before/after: rola,
// uprawnienia, stan) — nigdy hasło.
//
// Dokładne uprawnienia: rola jest punktem startu, a osobie można dołożyć uprawnienie (`permissions`) albo odebrać je
// z zestawu roli (`deniedPermissions`). Dodatkowo: nikt nie odbiera sobie `uzytkownicy`, roli Właściciel nic się nie
// odbiera, zestaw bez podglądu panelu jest odrzucany, a wpis w AuditLog niesie `zmiana: { nadane, odebrane }`.
//
// w hostingu (`APP_MODE=hosted`) „Dodaj osobę” nie zakłada kont i nie dołącza istniejących — tworzy
// zaproszenie (lib/auth/zaproszenia.ts) po tych samych kontrolach, z odpowiedzią identyczną dla każdego adresu spoza
// firmy. Self-host bez zmian. Lista pokazuje aktywność w TEJ firmie (`Membership.lastSeenAt`), nie globalne dane konta.
import type { MemberRole, Prisma, PrismaClient } from '@prisma/client'
import { appModeOf, systemPrisma, type AppMode } from '@/lib/db'
import { addPerson, endOtherSessions, isValidEmail, normalizeEmail, prepareStartPassword } from '@/lib/auth/sesje'
import { copyLinkSender, createInvitation, invitationLink, markInvitationDelivered, panelBaseUrl, type InvitationSender } from '@/lib/auth/zaproszenia'
import { attemptPasswordChange, safeError, type PasswordChangeAttempt } from '@/lib/auth/zmiana-hasla'
import { ALL_PERMISSIONS, brakujaceZaleznosci, permissionsOf, uprawnieniaRoli, type Permission } from '@/lib/auth/uprawnienia'

export const ROLES: MemberRole[] = ['WLASCICIEL', 'BIURO', 'MAGAZYN']

export interface Actor {
  userId: string
  organizationId: string
}

export interface MemberRow {
  userId: string
  name: string
  email: string
  role: MemberRole
  /** dodatkowe uprawnienia ponad rolę (znane nazwy, bez tych, które daje już rola) */
  extra: Permission[]
  /** uprawnienia odebrane z zestawu roli (znane nazwy, tylko te, które rola daje) */
  denied: Permission[]
  active: boolean
  /**
   * Konto całej instalacji wyłączone (CLI) — osoba nie zaloguje się nigdzie. W hostingu tylko dla konta, które należy
   * wyłącznie do tej firmy (stan konta w innej firmie to nie sprawa tej firmy).
   */
  accountBlocked: boolean
  /** ostatnia aktywność w tej firmie, `null` = jeszcze nie pracowała */
  lastSeenAt: Date | null
  self: boolean
}

export interface InvitationRow {
  id: string
  email: string
  role: MemberRole
  extra: Permission[]
  denied: Permission[]
  expiresAt: Date
  invitedBy: string
}

export type ChangeResult = { ok: true } | { ok: false; message: string }
export type AddResult =
  | { ok: true; kind: 'added'; userId: string; created: boolean; password: string | null }
  /** hosting: zaproszenie; `link` do przekazania osobie (raz), `null` = wysłane przez dostawcę wysyłki */
  | { ok: true; kind: 'invited'; link: string | null }
  | { ok: false; message: string }

export const MSG_NO_PERMISSION = 'Nie masz uprawnienia do zmiany użytkowników.'
export const MSG_NOT_FOUND = 'Nie ma takiej osoby w tej firmie.'
export const MSG_LAST_OWNER = 'To ostatni właściciel firmy — najpierw nadaj rolę właściciela innej osobie.'
export const MSG_WIDER = 'Tę osobę może zmienić tylko ktoś z co najmniej takimi uprawnieniami (właściciel).'
export const MSG_GRANT = 'Nie możesz nadać uprawnienia, którego sam nie masz.'
export const MSG_SELF_OFF = 'Nie możesz wyłączyć własnego dostępu. Poproś o to innego właściciela.'
export const MSG_OWNER_ONLY = 'Rolę właściciela nadaje i odbiera, a właściciela wyłącza i włącza, tylko właściciel.'
export const MSG_BAD_ROLE = 'Nieznana rola.'
export const MSG_FAIL = 'Nie udało się zapisać — spróbuj ponownie.'
export const MSG_ALREADY = 'Ta osoba ma już dostęp do firmy.'
/** Hosting: osoba z listy tej firmy z wyłączonym dostępem wraca przez „Włącz dostęp” (kontrola), nie zaproszeniem. */
export const MSG_DISABLED_MEMBER = 'Ta osoba jest na liście z wyłączonym dostępem. Włącz go przyciskiem „Włącz dostęp ponownie” przy jej nazwisku.'
export const MSG_NO_PANEL_URL = 'Zaproszenia nie działają: w ustawieniach instalacji brakuje adresu panelu. Poproś obsługę instalacji o jego ustawienie (Pomoc → Konfiguracja).'
export const MSG_INVITE_GONE = 'Tego zaproszenia już nie ma (przyjęte, cofnięte albo wygasłe).'
export const MSG_SELF_USERS = 'Nie możesz odebrać sobie uprawnienia „Użytkownicy i uprawnienia”. Poproś o to innego właściciela.'
export const MSG_OWNER_FULL = 'Rola Właściciel ma zawsze wszystkie uprawnienia. Żeby ograniczyć dostęp, wybierz rolę Biuro albo Magazyn i odznacz to, czego osoba nie potrzebuje.'
export const MSG_DEPENDENCY = 'Bez „Podgląd panelu” osoba nie otworzy panelu i pozostałe uprawnienia nic jej nie dają. Zaznacz podgląd panelu; żeby odciąć osobę, użyj „Wyłącz dostęp do firmy”.'

/** Komunikaty błędów przekazywane w adresie jako kod: treści z adresu nie pokazujemy (nikt nie podsunie własnej). */
const ERRORS: Record<string, string> = {
  owner: MSG_OWNER_ONLY,
  wider: MSG_WIDER,
  grant: MSG_GRANT,
  last: MSG_LAST_OWNER,
  self: MSG_SELF_OFF,
  notfound: MSG_NOT_FOUND,
  noperm: MSG_NO_PERMISSION,
  role: MSG_BAD_ROLE,
  fail: MSG_FAIL,
  zaproszenie: MSG_INVITE_GONE,
  siebie: MSG_SELF_USERS,
  wlasciciel: MSG_OWNER_FULL,
  zaleznosc: MSG_DEPENDENCY,
}
export const errorCode = (message: string): string => Object.keys(ERRORS).find((k) => ERRORS[k] === message) ?? 'fail'
export const errorMessage = (code: string | undefined): string | undefined => (code !== undefined && Object.hasOwn(ERRORS, code) ? ERRORS[code] : undefined)

/**
 * `appMode`, `panelUrl`, `now` tylko w testach (domyślnie APP_MODE i PANEL_URL z env); `sender` = dostawca wysyłki
 * zaproszeń (domyślnie żaden: link do skopiowania).
 */
type Deps = { sys?: PrismaClient; appMode?: AppMode; panelUrl?: string | null; sender?: InvitationSender; now?: Date; log?: (msg: string) => void }
type Tx = Prisma.TransactionClient
interface Locked {
  userId: string
  email: string
  role: MemberRole
  permissions: string[]
  deniedPermissions: string[]
  active: boolean
  userActive: boolean
}

/** Tryb instalacji dla ekranu (ekrany nie importują lib/db): hosting = zaproszenia zamiast kont. */
export const isHosted = (deps: Deps = {}): boolean => (deps.appMode ?? appModeOf(process.env)) === 'hosted'

function isRole(v: string): v is MemberRole {
  return (ROLES as string[]).includes(v)
}

/** Dodatkowe uprawnienia do zapisu: tylko znane, bez powtórzeń i bez tych, które daje sama rola. */
export function normalizeExtra(role: MemberRole, list: readonly string[]): Permission[] {
  const fromRole = uprawnieniaRoli(role)
  return ALL_PERMISSIONS.filter((p) => list.includes(p) && !fromRole.has(p))
}

/** Odebrane do zapisu: tylko znane, bez powtórzeń i tylko te, które rola daje (innych nie ma czego odbierać). */
export function normalizeDenied(role: MemberRole, list: readonly string[]): Permission[] {
  const fromRole = uprawnieniaRoli(role)
  return ALL_PERMISSIONS.filter((p) => list.includes(p) && fromRole.has(p))
}

/**
 * Pełny zaznaczony zestaw z ekranu (rola jako punkt startu) → zapis: dołożone ponad rolę i odebrane z roli. Nieznane
 * nazwy odpadają. Rola Właściciel ma zawsze komplet, więc dla niej nic nie jest ani dołożone, ani odebrane.
 */
export function zestawDoZapisu(role: MemberRole, zaznaczone: readonly string[]): { permissions: Permission[]; denied: Permission[] } {
  if (role === 'WLASCICIEL') return { permissions: [], denied: [] }
  const fromRole = uprawnieniaRoli(role)
  return {
    permissions: ALL_PERMISSIONS.filter((p) => zaznaczone.includes(p) && !fromRole.has(p)),
    denied: ALL_PERMISSIONS.filter((p) => fromRole.has(p) && !zaznaczone.includes(p)),
  }
}

/**
 * Kontrole samego zestawu (bez osoby wykonującej): właścicielowi nic się nie odbiera, a zestaw musi mieć podgląd
 * panelu (brakujaceZaleznosci). `null` = wolno.
 */
function refusalOfSet(role: MemberRole, denied: readonly Permission[], after: Set<Permission>): string | null {
  if (role === 'WLASCICIEL' && denied.length) return MSG_OWNER_FULL
  return brakujaceZaleznosci(after).length ? MSG_DEPENDENCY : null
}

/** Do dziennika zmian: co osoba dostała i co straciła względem stanu sprzed zmiany (cały wynikowy zestaw, nie pola). */
function setChange(before: Set<Permission>, after: Set<Permission>): { nadane: Permission[]; odebrane: Permission[] } {
  return { nadane: ALL_PERMISSIONS.filter((p) => after.has(p) && !before.has(p)), odebrane: ALL_PERMISSIONS.filter((p) => before.has(p) && !after.has(p)) }
}

const subset = (a: Set<Permission>, b: Set<Permission>) => [...a].every((p) => b.has(p))
/**
 * Powód odmowy wyłączenia (`active` = false) albo włączenia (true) dostępu osoby; `null` = wolno. Wspólne dla zapisu
 * i ekranu. Właściciela zmienia tylko właściciel. Włączenie przywraca zapisane uprawnienia, więc wymaga ich posiadania
 * jak nadanie. Wyłączenie jest celowo luźniejsze: osobę bez `uzytkownicy` wyłączy każdy, kto zarządza osobami, także
 * gdy nie mógłby odebrać jej pojedynczego uprawnienia — odebranie dostępu pracownikowi nie jest eskalacją.
 */
export function switchRefusal(t: { role: MemberRole; permissions: readonly string[]; deniedPermissions: readonly string[] | null }, me: { role: MemberRole; perms: Set<Permission> }, active: boolean): string | null {
  if (t.role === 'WLASCICIEL' && me.role !== 'WLASCICIEL') return MSG_OWNER_ONLY
  const theirs = permissionsOf(t)
  if (active && !subset(theirs, me.perms)) return MSG_GRANT
  return theirs.has('uzytkownicy') && !subset(theirs, me.perms) ? MSG_WIDER : null
}
const isOwner = (m: Locked) => m.role === 'WLASCICIEL' && m.active && m.userActive
const snap = (m: { role: MemberRole; permissions: string[]; deniedPermissions: string[]; active: boolean }) => ({
  role: m.role,
  permissions: [...m.permissions],
  deniedPermissions: [...m.deniedPermissions],
  active: m.active,
})

/**
 * Transakcja pod blokadą członkostw firmy. `fn` dostaje zablokowane wiersze i osobę wykonującą — tylko gdy jej
 * członkostwo jest aktywne i (w tej chwili, z bazy) ma `uzytkownicy`.
 */
async function locked<T>(actor: Actor, deps: Deps, fn: (tx: Tx, rows: Locked[], me: Locked & { perms: Set<Permission> }) => Promise<T>): Promise<T | { ok: false; message: string }> {
  const sys = deps.sys ?? systemPrisma()
  return sys.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Locked[]>`
        SELECT m."userId", u.email, m.role::text AS role, m.permissions, COALESCE(m."deniedPermissions", ARRAY[]::text[]) AS "deniedPermissions", m.active, u.active AS "userActive"
        FROM "Membership" m JOIN "User" u ON u.id = m."userId"
        WHERE m."organizationId" = ${actor.organizationId}
        ORDER BY m."userId"
        FOR UPDATE OF m`
      const me = rows.find((r) => r.userId === actor.userId && r.active && r.userActive)
      const perms = me ? permissionsOf(me) : null
      if (!me || !perms?.has('uzytkownicy')) return { ok: false as const, message: MSG_NO_PERMISSION }
      return fn(tx, rows, { ...me, perms })
    },
    { timeout: 20_000, maxWait: 20_000 },
  )
}

async function audit(tx: Tx, actor: Actor, userId: string, before: object | null, after: object): Promise<void> {
  await tx.auditLog.create({
    data: { organizationId: actor.organizationId, entity: 'Membership', entityId: userId, actorId: actor.userId, before: (before ?? undefined) as Prisma.InputJsonValue | undefined, after: after as Prisma.InputJsonValue },
  })
}

/**
 * Osoby firmy osoby wykonującej (tylko z uprawnieniem `uzytkownicy`, z bazy). Właściciele pierwsi, potem po imieniu.
 * `null` = brak uprawnienia (odebrane w chwili między sprawdzeniem sesji a odczytem; ekran daje 404, nie 500).
 */
export async function listMembers(actor: Actor, deps: Deps = {}): Promise<MemberRow[] | null> {
  const sys = deps.sys ?? systemPrisma()
  const rows = await sys.membership.findMany({
    where: { organizationId: actor.organizationId },
    include: { user: { select: { id: true, name: true, email: true, active: true } } },
  })
  const me = rows.find((r) => r.userId === actor.userId && r.active && r.user.active)
  if (!me || !permissionsOf(me).has('uzytkownicy')) return null
  // hosting: stan konta tylko dla kont wyłącznie tej firmy — o kontach z innymi firmami nic (sam fakt też nie trafia na ekran)
  const hosted = isHosted(deps)
  const blocked = rows.filter((m) => !m.user.active).map((m) => m.userId)
  const elsewhere = new Set(
    hosted && blocked.length
      ? (await sys.membership.findMany({ where: { userId: { in: blocked }, organizationId: { not: actor.organizationId } }, select: { userId: true } })).map((m) => m.userId)
      : [],
  )
  const order = (r: MemberRole) => ROLES.indexOf(r)
  return rows
    .map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      extra: normalizeExtra(m.role, m.permissions),
      denied: m.role === 'WLASCICIEL' ? [] : normalizeDenied(m.role, m.deniedPermissions),
      active: m.active,
      accountBlocked: !m.user.active && !elsewhere.has(m.userId),
      lastSeenAt: m.lastSeenAt,
      self: m.userId === actor.userId,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || order(a.role) - order(b.role) || a.name.localeCompare(b.name, 'pl'))
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && b.every((x) => a.includes(x))

/**
 * Zmiana roli, dodatkowych (`permissions`) i odebranych z roli (`denied`) uprawnień osoby z tej firmy. Bez `denied`
 * = nic nie odebrane. Działa od następnego żądania tej osoby (sesja liczy uprawnienia z bazy przy każdym żądaniu).
 */
export async function updateMember(
  actor: Actor,
  userId: string,
  p: { role: string; permissions: readonly string[]; denied?: readonly string[] },
  deps: Deps = {},
): Promise<ChangeResult> {
  if (!isRole(p.role)) return { ok: false, message: MSG_BAD_ROLE }
  const role = p.role
  const extra = normalizeExtra(role, p.permissions)
  const denied = normalizeDenied(role, p.denied ?? [])
  const after = permissionsOf({ role, permissions: extra, deniedPermissions: denied })
  const setRefusal = refusalOfSet(role, denied, after)
  if (setRefusal) return { ok: false, message: setRefusal }
  return locked(actor, deps, async (tx, rows, me): Promise<ChangeResult> => {
    const t = rows.find((r) => r.userId === userId)
    if (!t) return { ok: false, message: MSG_NOT_FOUND }
    if ((t.role === 'WLASCICIEL' || role === 'WLASCICIEL') && me.role !== 'WLASCICIEL') return { ok: false, message: MSG_OWNER_ONLY }
    const before = permissionsOf(t)
    // zmieniać (dodawać i odbierać) wolno tylko uprawnienia, które się ma — reszta osoby zostaje nietknięta
    if ([...before].some((p) => !after.has(p) && !me.perms.has(p))) return { ok: false, message: MSG_WIDER }
    if ([...after].some((p) => !before.has(p) && !me.perms.has(p))) return { ok: false, message: MSG_GRANT }
    if (isOwner(t) && role !== 'WLASCICIEL' && !rows.some((r) => r.userId !== t.userId && isOwner(r))) return { ok: false, message: MSG_LAST_OWNER }
    // zarządzania osobami nie odbiera się samemu sobie (ani zmianą roli, ani odznaczeniem): robi to inna osoba
    if (userId === actor.userId && !after.has('uzytkownicy')) return { ok: false, message: MSG_SELF_USERS }
    if (t.role === role && sameList(t.permissions, extra) && sameList(t.deniedPermissions, denied)) return { ok: true }
    await tx.membership.update({ where: { organizationId_userId: { organizationId: actor.organizationId, userId } }, data: { role, permissions: extra, deniedPermissions: denied } })
    await audit(tx, actor, userId, snap(t), { role, permissions: extra, deniedPermissions: denied, active: t.active, zmiana: setChange(before, after) })
    return { ok: true }
  })
}

/**
 * Wyłączenie (albo ponowne włączenie) dostępu osoby do tej firmy — bez kasowania konta: historia (AuditLog,
 * działania osoby) zostaje. Wyłączenie usuwa sesje tej osoby w tej firmie; w innych firmach pracuje dalej.
 */
export async function setMemberActive(actor: Actor, userId: string, active: boolean, deps: Deps = {}): Promise<ChangeResult> {
  return locked(actor, deps, async (tx, rows, me): Promise<ChangeResult> => {
    const t = rows.find((r) => r.userId === userId)
    if (!t) return { ok: false, message: MSG_NOT_FOUND }
    const refusal = switchRefusal(t, me, active)
    if (refusal) return { ok: false, message: refusal }
    if (!active && userId === actor.userId) return { ok: false, message: MSG_SELF_OFF }
    if (!active && isOwner(t) && !rows.some((r) => r.userId !== t.userId && isOwner(r))) return { ok: false, message: MSG_LAST_OWNER }
    if (t.active === active) return { ok: true }
    await tx.membership.update({ where: { organizationId_userId: { organizationId: actor.organizationId, userId } }, data: { active } })
    if (!active) await tx.session.deleteMany({ where: { userId, organizationId: actor.organizationId } })
    await audit(tx, actor, userId, snap(t), { ...snap(t), active })
    return { ok: true }
  })
}

/**
 * Dodanie osoby. Self-host: wspólna logika z CLI (`addPerson`) — hasło startowe nowego konta wraca w wyniku JEDEN raz,
 * do pokazania osobie dodającej; nie trafia do logu ani AuditLog. Istniejące konto dostaje tylko dostęp (hasło, imię
 * i nazwisko bez zmian — należą do osoby). Skrót hasła startowego liczony przed blokadą.
 * Hosting: zaproszenie zamiast konta — te same kontrole pod blokadą, potem `createInvitation`; odpowiedź (i jej
 * czas) nie zależy od tego, czy adres ma konto gdzie indziej, ani czy konto ma jakąkolwiek firmę. Inaczej tylko dla
 * osób z listy tej firmy (i tak je widać): aktywna = „ma już dostęp”, wyłączona = „Włącz dostęp” (kontrola).
 * Wyłączona osoba tej firmy w self-hoście to zmiana jej dostępu, więc obowiązują te same bezpieczniki co przy roli.
 */
export async function addMember(
  actor: Actor,
  p: { email: string; name: string; role: string; permissions: readonly string[]; denied?: readonly string[] },
  deps: Deps = {},
): Promise<AddResult> {
  const email = normalizeEmail(p.email)
  const name = p.name.trim().slice(0, 120)
  const hosted = isHosted(deps)
  if (!isValidEmail(email)) return { ok: false, message: 'Nieprawidłowy adres e-mail.' }
  if (!hosted && !name) return { ok: false, message: 'Podaj imię i nazwisko.' }
  if (!isRole(p.role)) return { ok: false, message: MSG_BAD_ROLE }
  const role = p.role
  const extra = normalizeExtra(role, p.permissions)
  const denied = normalizeDenied(role, p.denied ?? [])
  const after = permissionsOf({ role, permissions: extra, deniedPermissions: denied })
  const setRefusal = refusalOfSet(role, denied, after)
  if (setRefusal) return { ok: false, message: setRefusal }
  if (hosted) return invite(actor, { email, role, extra, denied }, deps)
  const start = await prepareStartPassword()
  try {
    return await locked(actor, deps, async (tx, rows, me): Promise<AddResult> => {
      if (role === 'WLASCICIEL' && me.role !== 'WLASCICIEL') return { ok: false, message: MSG_OWNER_ONLY }
      if (!subset(after, me.perms)) return { ok: false, message: MSG_GRANT }
      const member = rows.find((r) => r.email === email)
      if (member && !member.active) {
        if (member.role === 'WLASCICIEL' && me.role !== 'WLASCICIEL') return { ok: false, message: MSG_OWNER_ONLY }
        if ([...permissionsOf(member)].some((x) => !after.has(x) && !me.perms.has(x))) return { ok: false, message: MSG_WIDER }
      }
      const res = await addPerson(tx, { email, name, organizationId: actor.organizationId, role, permissions: extra, deniedPermissions: denied, start })
      if (!res.ok) return { ok: false, message: MSG_ALREADY }
      const before = res.before?.active ? permissionsOf(res.before) : new Set<Permission>()
      await audit(tx, actor, res.userId, res.before, {
        role,
        permissions: extra,
        deniedPermissions: denied,
        active: true,
        zmiana: setChange(before, after),
        ...(res.created ? { noweKonto: true } : {}),
      })
      return { ok: true, kind: 'added', userId: res.userId, created: res.created, password: res.password }
    })
  } catch (e) {
    // równoległe założenie konta o tym samym adresie (inna firma): unikalny e-mail
    if (typeof e === 'object' && e && (e as { code?: string }).code === 'P2002') return { ok: false, message: MSG_FAIL }
    throw e
  }
}

/** Hosting: zaproszenie. Link wraca raz; tokenu nie ma w bazie (skrót), w logu ani w AuditLog. */
async function invite(actor: Actor, p: { email: string; role: MemberRole; extra: Permission[]; denied: Permission[] }, deps: Deps): Promise<AddResult> {
  const base = deps.panelUrl !== undefined ? deps.panelUrl : panelBaseUrl(process.env)
  if (!base) return { ok: false, message: MSG_NO_PANEL_URL }
  const now = deps.now ?? new Date()
  const r = await locked(actor, deps, async (tx, rows, me) => {
    if (p.role === 'WLASCICIEL' && me.role !== 'WLASCICIEL') return { ok: false as const, message: MSG_OWNER_ONLY }
    if (!subset(permissionsOf({ role: p.role, permissions: p.extra, deniedPermissions: p.denied }), me.perms)) return { ok: false as const, message: MSG_GRANT }
    // tylko osoby tej firmy (zablokowane wiersze); konto w innej firmie albo bez firmy niczym się tu nie różni od nowego adresu
    const member = rows.find((m) => m.email === p.email)
    if (member) return { ok: false as const, message: member.active ? MSG_ALREADY : MSG_DISABLED_MEMBER }
    // nowe zaproszenie cofa otwarte na ten adres, więc zastąpienie zaproszenia właściciela to jego cofnięcie —
    // tylko właściciel (jak „Cofnij”). Zapytanie idzie zawsze i zależy od zaproszeń tej firmy (widać je na liście),
    // nie od kont, więc odpowiedź dla adresu spoza firmy dalej nie zdradza, czy ma konto.
    const open = await tx.invitation.findFirst({
      where: { organizationId: actor.organizationId, email: p.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      select: { role: true },
    })
    if (open?.role === 'WLASCICIEL' && me.role !== 'WLASCICIEL') return { ok: false as const, message: MSG_OWNER_ONLY }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { name: true } })
    const inv = await createInvitation(tx, {
      organizationId: actor.organizationId,
      email: p.email,
      role: p.role,
      permissions: p.extra,
      deniedPermissions: p.denied,
      invitedById: actor.userId,
      now,
    })
    await tx.auditLog.create({
      data: {
        organizationId: actor.organizationId,
        entity: 'Invitation',
        entityId: inv.id,
        actorId: actor.userId,
        after: { role: p.role, permissions: p.extra, deniedPermissions: p.denied, zaproszenie: true },
      },
    })
    return { ok: true as const, id: inv.id, token: inv.token, expiresAt: inv.expiresAt, organizationName: org.name }
  })
  if (!r.ok) return r
  const link = invitationLink(base, r.token)
  let delivered = false
  try {
    delivered = (await (deps.sender ?? copyLinkSender).send({ id: r.id, email: p.email, organizationName: r.organizationName, role: p.role, link, expiresAt: r.expiresAt })).delivered
    // tylko link doręczony zaproszonej osobie zakłada konto bez wymuszonej zmiany hasła
    if (delivered) await markInvitationDelivered(deps.sys ?? systemPrisma(), { id: r.id, organizationId: actor.organizationId })
  } catch (e) {
    // zaproszenie zostaje; link wraca do ręcznego przekazania (bez treści błędu: mogłaby zawierać link)
    ;(deps.log ?? ((m: string) => console.error(m)))(`[zaproszenia] wysyłka: ${safeError(e)}`)
  }
  return { ok: true, kind: 'invited', link: delivered ? null : link }
}

/** Otwarte (nieprzyjęte, niecofnięte, ważne) zaproszenia firmy; `null` = brak uprawnienia `uzytkownicy`. */
export async function listInvitations(actor: Actor, deps: Deps = {}): Promise<InvitationRow[] | null> {
  const sys = deps.sys ?? systemPrisma()
  const me = await sys.membership.findUnique({ where: { organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId } }, include: { user: { select: { active: true } } } })
  if (!me?.active || !me.user.active || !permissionsOf(me).has('uzytkownicy')) return null
  const now = deps.now ?? new Date()
  const rows = await sys.invitation.findMany({
    where: { organizationId: actor.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    include: { invitedBy: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    extra: normalizeExtra(i.role, i.permissions),
    denied: i.role === 'WLASCICIEL' ? [] : normalizeDenied(i.role, i.deniedPermissions),
    expiresAt: i.expiresAt,
    invitedBy: i.invitedBy.name,
  }))
}

/** „Cofnij” zaproszenie tej firmy. Zaproszenie właściciela cofa tylko właściciel (jak nadanie roli). */
export async function revokeInvitation(actor: Actor, invitationId: string, deps: Deps = {}): Promise<ChangeResult> {
  const now = deps.now ?? new Date()
  return locked(actor, deps, async (tx, _rows, me): Promise<ChangeResult> => {
    const inv = await tx.invitation.findFirst({ where: { id: invitationId, organizationId: actor.organizationId, acceptedAt: null, revokedAt: null } })
    if (!inv) return { ok: false, message: MSG_INVITE_GONE }
    if (inv.role === 'WLASCICIEL' && me.role !== 'WLASCICIEL') return { ok: false, message: MSG_OWNER_ONLY }
    await tx.invitation.updateMany({ where: { id: inv.id, organizationId: actor.organizationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
    await tx.auditLog.create({ data: { organizationId: actor.organizationId, entity: 'Invitation', entityId: inv.id, actorId: actor.userId, after: { cofniete: true } } })
    return { ok: true }
  })
}

/** „Zakończ pozostałe sesje” z /ustawienia/haslo: osoba z sesji, bez hasła i bez blokady. `null` = sesja wygasła. */
export async function endOtherSessionsFromPanel(s: { userId: string; organizationId: string; sessionId: string }, deps: Deps = {}): Promise<number | null> {
  return endOtherSessions(deps.sys ?? systemPrisma(), { userId: s.userId, organizationId: s.organizationId, keepSessionId: s.sessionId })
}

/** Zmiana własnego hasła z panelu (/ustawienia/haslo): osoba z sesji, bez innych osób i bez firmy. */
export async function changeOwnPasswordFromPanel(
  s: { userId: string; organizationId: string; sessionId: string },
  p: { current: string; next: string; repeat: string; ip: string },
  deps: Deps = {},
): Promise<PasswordChangeAttempt> {
  return attemptPasswordChange(deps.sys ?? systemPrisma(), { userId: s.userId, organizationId: s.organizationId, sessionId: s.sessionId, ...p })
}
