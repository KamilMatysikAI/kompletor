// zaproszenia do firmy w hostingu (`APP_MODE=hosted` przez deps, bez dotykania env).
//  1. „Dodaj osobę” w hostingu nie zakłada kont i nie dołącza nikogo; odpowiedź identyczna (i te same zapytania) dla
//     adresu nowego, konta z innej firmy i konta bez żadnej firmy; osoby z listy tej firmy — osobne komunikaty;
//  2. token: jednorazowy, wygasły, cofnięty, nowe zaproszenie unieważnia stare; GET (odczyt) niczego nie przyjmuje;
//  3. przyjęcie: nowe konto (bez hasła startowego), logowanie (także konto bez firmy), zalogowana osoba, zły adres;
//     dwie równoległe akceptacje = jedno członkostwo; zapraszający stracił prawa = zaproszenie przepada;
//  4. bezpieczniki/ dalej działają; izolacja firm (RLS „nikt”); brak tokenu w AuditLog i logach; port wysyłki.
//  5. poprawki: konto z linku niedoręczonego przez dostawcę ma mustChangePassword,
//     zaproszenia właściciela nie zastępuje nie-właściciel, hasło dopiero przy ważnym tokenie, AuditLog
//     z przyjmującym, aktywny członek przyjmuje bez zmiany roli.
// Dane wyłącznie testowe (adresy w domenie .test).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createUser, grantMembership, login, resolveSession, tokenHash } from '@/lib/auth/sesje'
import { SlidingLimiter } from '@/lib/auth/limiter'
import {
  acceptAsUser,
  acceptWithLogin,
  acceptWithNewAccount,
  attemptAccept,
  INVITATION_TTL_MS,
  invitationInfo,
  MSG_INVITE_FAIL,
  MSG_INVITE_LIMIT,
  MSG_INVITE_OTHER_ACCOUNT,
  panelBaseUrl,
  purgeInvitations,
  type InvitationMessage,
} from '@/lib/auth/zaproszenia'
import {
  addMember,
  listInvitations,
  MSG_ALREADY,
  MSG_DISABLED_MEMBER,
  MSG_GRANT,
  MSG_INVITE_GONE,
  MSG_NO_PANEL_URL,
  MSG_OWNER_ONLY,
  normalizeExtra,
  revokeInvitation,
  setMemberActive,
  updateMember,
} from '@/lib/panel/uzytkownicy'
import { ALL_PERMISSIONS } from '@/lib/auth/uprawnienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'

const sys = testSystemDb()
const PANEL = 'https://panel.example.test'
const hosted = { sys, appMode: 'hosted' as const, panelUrl: PANEL }
const PASS = 'haslo-testowe-0001'
const NEW_PASS = 'wlasne-haslo-zapr-01'
const ids: Record<string, string> = {}
const LINK_RE = /^https:\/\/panel\.example\.test\/zaproszenie\?t=([A-Za-z0-9_-]{43})$/

async function person(key: string, email: string, org: string | null, role: 'WLASCICIEL' | 'BIURO' | 'MAGAZYN' = 'MAGAZYN', permissions?: string[]) {
  if (!ids[key]) ids[key] = (await sys.user.findUnique({ where: { email } }))?.id ?? (await createUser(sys, { email, name: `Osoba ${key}`, password: PASS })).id
  if (org) await grantMembership(sys, { email, organizationId: org, role, permissions })
}
const A = (key: string) => ({ userId: ids[key]!, organizationId: ORG_A })
const membership = (org: string, key: string) => sys.membership.findUnique({ where: { organizationId_userId: { organizationId: org, userId: ids[key]! } } })

/** Zaproszenie przez panel; zwraca token z linku. */
async function invite(email: string, p: { by?: string; role?: 'WLASCICIEL' | 'BIURO' | 'MAGAZYN'; permissions?: string[] } = {}): Promise<string> {
  const r = await addMember(A(p.by ?? 'wlA'), { email, name: '', role: p.role ?? 'MAGAZYN', permissions: p.permissions ?? [] }, hosted)
  if (!r.ok || r.kind !== 'invited' || !r.link) throw new Error(`zaproszenie ${email}: ${JSON.stringify(r)}`)
  return LINK_RE.exec(r.link)![1]!
}

beforeEach(async () => {
  await truncateAll()
  for (const k of Object.keys(ids)) delete ids[k]
  await person('wlA', 'wlasciciel@firma-a.test', ORG_A, 'WLASCICIEL')
  await person('biuroA', 'biuro@firma-a.test', ORG_A, 'BIURO', ['uzytkownicy', 'zwroty.pieniadze'])
  await person('magA', 'magazyn@firma-a.test', ORG_A, 'MAGAZYN')
  await person('wlB', 'wlasciciel@firma-b.test', ORG_B, 'WLASCICIEL')
  await person('magB', 'magazyn@firma-b.test', ORG_B, 'MAGAZYN')
  // konto bez żadnej firmy (np. po CLI bez członkostwa albo po usunięciu firmy) — przegląd 2,
  await person('bezFirmy', 'bez-firmy@inna.test', null)
})
afterAll(async () => {
  await sys.$disconnect()
})

describe('dodanie w hostingu = zaproszenie', () => {
  it('identyczna odpowiedź i te same zapytania dla adresu nowego, konta z innej firmy i konta bez firmy; nikt nie dołączony', async () => {
    const seen: Record<string, string[]> = {}
    // klient zapisujący, po jakich tabelach chodzi „Dodaj osobę” (czas odpowiedzi nie może zależeć od istnienia konta)
    const watch = (key: string): PrismaClient => {
      const log = (seen[key] = [] as string[])
      const wrap = <T extends object>(target: T): T =>
        new Proxy(target, {
          get(t, k) {
            const v = Reflect.get(t, k, t)
            if (typeof k === 'string' && v && typeof v === 'object' && 'findMany' in v) {
              return new Proxy(v as object, {
                get(d, m) {
                  const f = Reflect.get(d, m, d)
                  return typeof f === 'function' ? (...a: unknown[]) => (log.push(`${k}.${String(m)}`), f.apply(d, a)) : f
                },
              })
            }
            if (k === '$transaction') return (fn: (tx: unknown) => Promise<unknown>, o?: object) => (t as PrismaClient).$transaction((tx) => fn(wrap(tx)), o)
            if (k === '$queryRaw') return (...a: unknown[]) => (log.push('$queryRaw'), (v as (...x: unknown[]) => unknown).apply(t, a))
            return typeof v === 'function' ? v.bind(t) : v
          },
        })
      return wrap(sys)
    }
    const res: Record<string, unknown> = {}
    for (const [key, email] of [
      ['nowy', 'nowy@inna.test'],
      ['innaFirma', 'magazyn@firma-b.test'],
      ['bezFirmy', 'bez-firmy@inna.test'],
    ] as const) {
      const r = await addMember(A('wlA'), { email, name: '', role: 'MAGAZYN', permissions: [] }, { ...hosted, sys: watch(key) })
      expect(r.ok && r.kind === 'invited' && LINK_RE.test(r.link ?? ''), key).toBe(true)
      res[key] = JSON.parse(JSON.stringify(r).replace(/t=[A-Za-z0-9_-]+/, 't=X'))
    }
    expect(res.innaFirma).toEqual(res.nowy)
    expect(res.bezFirmy).toEqual(res.nowy)
    expect(seen.innaFirma).toEqual(seen.nowy)
    expect(seen.bezFirmy).toEqual(seen.nowy)
    expect(seen.nowy!.some((q) => q.startsWith('user.'))).toBe(false)
    // nikogo nie dołączono, żadnego konta nie założono
    expect(await membership(ORG_A, 'magB')).toBeNull()
    expect(await membership(ORG_A, 'bezFirmy')).toBeNull()
    expect(await sys.user.count({ where: { email: 'nowy@inna.test' } })).toBe(0)
    expect(await sys.invitation.count({ where: { organizationId: ORG_A, acceptedAt: null, revokedAt: null } })).toBe(3)
    // firma B nie widzi niczego z tego
    expect(await sys.auditLog.count({ where: { organizationId: ORG_B } })).toBe(0)
  })

  it('osoby z listy tej firmy: aktywna = „ma już dostęp”, wyłączona = „Włącz dostęp” (kontrola); bez PANEL_URL odmowa', async () => {
    expect(await addMember(A('wlA'), { email: 'magazyn@firma-a.test', name: '', role: 'MAGAZYN', permissions: [] }, hosted)).toEqual({ ok: false, message: MSG_ALREADY })
    expect(await setMemberActive(A('wlA'), ids.magA!, false, hosted)).toEqual({ ok: true })
    expect(await addMember(A('wlA'), { email: 'magazyn@firma-a.test', name: '', role: 'MAGAZYN', permissions: [] }, hosted)).toEqual({ ok: false, message: MSG_DISABLED_MEMBER })
    // biuro bez `pakowanie.stanowisko` wyłączy magazyniera, ale nie włączy go z powrotem
    expect(await setMemberActive(A('biuroA'), ids.magA!, true, hosted)).toEqual({ ok: false, message: MSG_GRANT })
    expect(await addMember(A('wlA'), { email: 'x@inna.test', name: '', role: 'MAGAZYN', permissions: [] }, { ...hosted, panelUrl: null })).toEqual({ ok: false, message: MSG_NO_PANEL_URL })
    expect(await sys.invitation.count()).toBe(0)
  })

  it('PANEL_URL: tylko http(s) bez zapytania i kotwicy; końcowy ukośnik odcięty', () => {
    expect(panelBaseUrl({ PANEL_URL: 'https://panel.example.test/' })).toBe(PANEL)
    expect(panelBaseUrl({ PANEL_URL: 'https://example.test/kompletor/' })).toBe('https://example.test/kompletor')
    expect(panelBaseUrl({})).toBeNull()
    expect(panelBaseUrl({ PANEL_URL: 'javascript:alert(1)' })).toBeNull()
    expect(panelBaseUrl({ PANEL_URL: 'https://panel.example.test/?x=1' })).toBeNull()
    expect(panelBaseUrl({ PANEL_URL: 'nie adres' })).toBeNull()
  })

  it('nie-właściciel nie zaprasza właściciela ani nie nadaje cudzych uprawnień; dalej działa', async () => {
    await person('pelne', 'pelne@firma-a.test', ORG_A, 'BIURO', normalizeExtra('BIURO', ALL_PERMISSIONS))
    expect(await addMember(A('pelne'), { email: 'przejecie@inna.test', name: '', role: 'WLASCICIEL', permissions: [] }, hosted)).toEqual({ ok: false, message: MSG_OWNER_ONLY })
    expect(await addMember(A('biuroA'), { email: 'kanaly@inna.test', name: '', role: 'BIURO', permissions: ['kanaly.tryb'] }, hosted)).toEqual({ ok: false, message: MSG_GRANT })
    expect(await addMember(A('magA'), { email: 'x@inna.test', name: '', role: 'MAGAZYN', permissions: [] }, hosted)).toMatchObject({ ok: false })
    expect(await sys.invitation.count()).toBe(0)
    expect(await updateMember(A('pelne'), ids.wlA!, { role: 'MAGAZYN', permissions: [] }, hosted)).toEqual({ ok: false, message: MSG_OWNER_ONLY })
    // zaproszenie właściciela cofa tylko właściciel
    await invite('nowy-wl@inna.test', { role: 'WLASCICIEL' })
    const [inv] = await sys.invitation.findMany()
    expect(await revokeInvitation(A('pelne'), inv!.id, hosted)).toEqual({ ok: false, message: MSG_OWNER_ONLY })
    expect(await revokeInvitation(A('wlA'), inv!.id, hosted)).toEqual({ ok: true })
  })

  it('nie-właściciel nie zastępuje otwartego zaproszenia właściciela nowym na ten adres; właściciel może; inne role tak', async () => {
    const tWl = await invite('przyszly-wl@inna.test', { role: 'WLASCICIEL' })
    // rola, którą Biuro może nadać (Magazyn ma pakowanie.stanowisko, którego Biuro nie ma → MSG_GRANT przed sprawdzeniem zaproszenia)
    expect(await addMember(A('biuroA'), { email: 'przyszly-wl@inna.test', name: '', role: 'BIURO', permissions: [] }, hosted)).toEqual({ ok: false, message: MSG_OWNER_ONLY })
    expect(await invitationInfo(sys, tWl)).toEqual({ organizationName: 'Firma testowa A', role: 'WLASCICIEL' })
    expect(await sys.invitation.count({ where: { email: 'przyszly-wl@inna.test', revokedAt: null } })).toBe(1)
    // właściciel zastępuje własne zaproszenie
    const tMag = await invite('przyszly-wl@inna.test', { role: 'MAGAZYN' })
    expect(await invitationInfo(sys, tWl)).toBeNull()
    expect(await invitationInfo(sys, tMag)).toEqual({ organizationName: 'Firma testowa A', role: 'MAGAZYN' })
    // zaproszenie na inną rolę Biuro zastępuje jak dotąd
    const tBiuro = await invite('przyszly-wl@inna.test', { by: 'biuroA', role: 'BIURO' })
    expect(await invitationInfo(sys, tMag)).toBeNull()
    expect(await invitationInfo(sys, tBiuro)).not.toBeNull()
    // wygasłe zaproszenie właściciela (niewidoczne na liście) nie blokuje
    await invite('stare-wl@inna.test', { role: 'WLASCICIEL' })
    await sys.invitation.updateMany({ where: { email: 'stare-wl@inna.test' }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await addMember(A('biuroA'), { email: 'stare-wl@inna.test', name: '', role: 'BIURO', permissions: [] }, hosted)).toMatchObject({ ok: true, kind: 'invited' })
  })

  it('port wysyłki: dostawca dostaje link i dane, link wtedy nie wraca; błąd wysyłki = link do ręcznego przekazania, w logu bez linku', async () => {
    const sent: InvitationMessage[] = []
    const ok = await addMember(A('wlA'), { email: 'Wysylka@Inna.test', name: '', role: 'BIURO', permissions: [] }, { ...hosted, sender: { send: async (m) => (sent.push(m), { delivered: true }) } })
    expect(ok).toEqual({ ok: true, kind: 'invited', link: null })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ email: 'wysylka@inna.test', organizationName: 'Firma testowa A', role: 'BIURO' })
    expect(sent[0]!.link).toMatch(LINK_RE)
    // doręczony link zapisany w zaproszeniu; konto z niego zakłada się z własnym hasłem bez wymuszonej zmiany
    expect(await sys.invitation.findFirstOrThrow({ where: { email: 'wysylka@inna.test' } })).toMatchObject({ delivered: true })
    const tSent = LINK_RE.exec(sent[0]!.link)![1]!
    const acc = await acceptWithNewAccount(sys, { token: tSent, email: 'wysylka@inna.test', name: 'Wysyłka', password: NEW_PASS, now: new Date() })
    expect(acc.ok).toBe(true)
    expect(await sys.user.findUniqueOrThrow({ where: { email: 'wysylka@inna.test' } })).toMatchObject({ mustChangePassword: false })
    const lines: string[] = []
    const bad = await addMember(A('wlA'), { email: 'wysylka2@inna.test', name: '', role: 'BIURO', permissions: [] }, {
      ...hosted,
      sender: {
        send: async (m) => {
          throw new Error(`smtp odrzucił ${m.link}`)
        },
      },
      log: (m) => lines.push(m),
    })
    if (!bad.ok || bad.kind !== 'invited' || !bad.link) throw new Error('brak linku')
    expect(await sys.invitation.findFirstOrThrow({ where: { email: 'wysylka2@inna.test' } })).toMatchObject({ delivered: false })
    expect(lines).toEqual(['[zaproszenia] wysyłka: Error'])
    expect(lines.join()).not.toContain(LINK_RE.exec(bad.link)![1])
  })
})

describe('token', () => {
  it('jednorazowy; GET (odczyt) niczego nie przyjmuje; strona pokazuje tylko firmę i rolę', async () => {
    const t = await invite('nowy@inna.test', { role: 'BIURO' })
    const info = await invitationInfo(sys, t)
    expect(info).toEqual({ organizationName: 'Firma testowa A', role: 'BIURO' })
    await invitationInfo(sys, t)
    expect((await sys.invitation.findFirstOrThrow()).acceptedAt).toBeNull()
    const r = await acceptWithNewAccount(sys, { token: t, email: 'nowy@inna.test', name: 'Nowa Osoba', password: NEW_PASS, now: new Date() })
    expect(r.ok).toBe(true)
    expect(await invitationInfo(sys, t)).toBeNull()
    expect(await acceptWithNewAccount(sys, { token: t, email: 'inny@inna.test', name: 'X', password: NEW_PASS, now: new Date() })).toEqual({ ok: false })
    expect(await acceptAsUser(sys, { token: t, userId: ids.wlB!, now: new Date() })).toMatchObject({ ok: false })
    expect(await invitationInfo(sys, 'zly-token-zly-token-zly-token')).toBeNull()
    expect(await invitationInfo(sys, 'x')).toBeNull()
  })

  it('wygasły po 7 dniach; cofnięty; nowe zaproszenie na ten sam adres unieważnia poprzednie', async () => {
    const now = new Date()
    const t = await invite('bez-firmy@inna.test')
    const later = new Date(now.getTime() + INVITATION_TTL_MS + 60_000)
    expect(await invitationInfo(sys, t, later)).toBeNull()
    expect(await acceptWithLogin(sys, { token: t, email: 'bez-firmy@inna.test', password: PASS, now: later })).toEqual({ ok: false })
    expect(await membership(ORG_A, 'bezFirmy')).toBeNull()

    const t2 = await invite('bez-firmy@inna.test')
    expect(await invitationInfo(sys, t)).toBeNull() // stare zastąpione
    expect(await sys.invitation.count({ where: { organizationId: ORG_A, email: 'bez-firmy@inna.test', acceptedAt: null, revokedAt: null } })).toBe(1)
    const open = (await listInvitations(A('wlA'), hosted))!
    expect(open.map((i) => i.email)).toEqual(['bez-firmy@inna.test'])
    expect(await revokeInvitation(A('biuroA'), open[0]!.id, hosted)).toEqual({ ok: true })
    expect(await invitationInfo(sys, t2)).toBeNull()
    expect(await acceptWithLogin(sys, { token: t2, email: 'bez-firmy@inna.test', password: PASS, now: new Date() })).toEqual({ ok: false })
    expect(await revokeInvitation(A('wlA'), open[0]!.id, hosted)).toEqual({ ok: false, message: MSG_INVITE_GONE })
    expect((await listInvitations(A('wlA'), hosted))!).toEqual([])
    // sprzątanie: cofnięte i wygasłe znikają
    expect(await purgeInvitations(sys, later)).toBe(2)
    expect(await sys.invitation.count()).toBe(0)
  })
})

describe('przyjęcie', () => {
  it('nowe konto: tylko adres z zaproszenia, własne hasło, rola i uprawnienia z zaproszenia, sesja w tej firmie; link skopiowany przez zapraszającego = mustChangePassword', async () => {
    const t = await invite('nowa@inna.test', { by: 'biuroA', role: 'BIURO', permissions: ['zwroty.pieniadze'] })
    expect(await acceptWithNewAccount(sys, { token: t, email: 'ktos-inny@inna.test', name: 'X', password: NEW_PASS, now: new Date() })).toEqual({ ok: false })
    expect(await sys.user.count({ where: { email: 'ktos-inny@inna.test' } })).toBe(0)
    const r = await acceptWithNewAccount(sys, { token: t, email: ' Nowa@Inna.test ', name: 'Nowa Osoba', password: NEW_PASS, now: new Date() })
    if (!r.ok) throw new Error('przyjęcie')
    const u = await sys.user.findUniqueOrThrow({ where: { email: 'nowa@inna.test' } })
    // link nie przyszedł od dostawcy wysyłki (trzymał go zapraszający), więc hasło do zmiany przy pierwszym logowaniu
    expect(u).toMatchObject({ name: 'Nowa Osoba', mustChangePassword: true })
    expect(await sys.membership.findUnique({ where: { organizationId_userId: { organizationId: ORG_A, userId: u.id } } })).toMatchObject({ role: 'BIURO', permissions: ['zwroty.pieniadze'], active: true })
    const s = await resolveSession(sys, r.session.token)
    expect(s?.organization.organizationId).toBe(ORG_A)
    expect(s?.mustChangePassword).toBe(true)
    expect((await login(sys, 'nowa@inna.test', NEW_PASS)).ok).toBe(true)
  })

  it('adres, który ma konto: zakładanie kończy się tym samym ogólnym niepowodzeniem; logowanie przyjmuje (konto z innej firmy i bez firmy)', async () => {
    const tB = await invite('magazyn@firma-b.test')
    const tN = await invite('bez-firmy@inna.test')
    const zlyToken = await acceptWithNewAccount(sys, { token: 'zly-token-zly-token-zly-token', email: 'magazyn@firma-b.test', name: 'X', password: NEW_PASS, now: new Date() })
    const maKonto = await acceptWithNewAccount(sys, { token: tB, email: 'magazyn@firma-b.test', name: 'X', password: NEW_PASS, now: new Date() })
    expect(maKonto).toEqual(zlyToken)
    const limits = { limiter: new SlidingLimiter(100, 60_000) }
    const msg = await attemptAccept(sys, { kind: 'new', token: tB, email: 'magazyn@firma-b.test', name: 'X', password: NEW_PASS, repeat: NEW_PASS }, { ip: '203.0.113.30' }, limits)
    const msgZly = await attemptAccept(sys, { kind: 'new', token: 'zly-token-zly-token-zly-token', email: 'nowy@inna.test', name: 'X', password: NEW_PASS, repeat: NEW_PASS }, { ip: '203.0.113.30' }, limits)
    expect(msg).toEqual({ ok: false, message: MSG_INVITE_FAIL })
    expect(msgZly).toEqual(msg)
    // hasło konta bez zmian, zaproszenie nadal ważne
    expect((await login(sys, 'magazyn@firma-b.test', PASS)).ok).toBe(true)
    expect(await invitationInfo(sys, tB)).not.toBeNull()
    // zły login = ten sam komunikat
    expect(await attemptAccept(sys, { kind: 'login', token: tB, email: 'magazyn@firma-b.test', password: 'zle-haslo-0000000' }, { ip: '203.0.113.30' }, limits)).toEqual({ ok: false, message: MSG_INVITE_FAIL })

    const rB = await attemptAccept(sys, { kind: 'login', token: tB, email: 'magazyn@firma-b.test', password: PASS }, { ip: '203.0.113.30' }, limits)
    if (!rB.ok || !rB.session) throw new Error('logowanie B')
    const sB = await resolveSession(sys, rB.session.token)
    expect(sB?.organization.organizationId).toBe(ORG_A)
    expect(sB?.memberships.map((m) => m.organizationId).sort()).toEqual([ORG_A, ORG_B])
    expect(await membership(ORG_B, 'magB')).toMatchObject({ role: 'MAGAZYN', active: true })

    // konto bez firmy: zwykłe logowanie odmawia, przyjęcie z logowaniem działa
    expect(await login(sys, 'bez-firmy@inna.test', PASS)).toEqual({ ok: false, reason: 'no_org' })
    const rN = await acceptWithLogin(sys, { token: tN, email: 'bez-firmy@inna.test', password: PASS, now: new Date() })
    expect(rN.ok).toBe(true)
    expect(await membership(ORG_A, 'bezFirmy')).toMatchObject({ role: 'MAGAZYN', active: true })
  })

  it('zalogowany na inny adres: odmowa bez podawania adresu z zaproszenia, zaproszenie zostaje; właściwe konto przyjmuje', async () => {
    const t = await invite('magazyn@firma-b.test')
    const r = await attemptAccept(sys, { kind: 'session', token: t, userId: ids.wlB! }, { ip: '203.0.113.31' }, { limiter: new SlidingLimiter(100, 60_000) })
    expect(r).toEqual({ ok: false, message: MSG_INVITE_OTHER_ACCOUNT })
    expect(JSON.stringify(r)).not.toContain('magazyn@firma-b.test')
    expect(await invitationInfo(sys, t)).not.toBeNull()
    expect(await acceptWithLogin(sys, { token: t, email: 'wlasciciel@firma-b.test', password: PASS, now: new Date() })).toEqual({ ok: false })
    expect(await acceptAsUser(sys, { token: t, userId: ids.magB!, now: new Date() })).toEqual({ ok: true, organizationId: ORG_A })
    expect(await membership(ORG_A, 'magB')).toMatchObject({ active: true })
  })

  it('dwie równoległe akceptacje dają jedno członkostwo (zalogowana osoba i zakładanie konta)', async () => {
    const t = await invite('magazyn@firma-b.test')
    const now = new Date()
    const rs = await Promise.all([acceptAsUser(sys, { token: t, userId: ids.magB!, now }), acceptAsUser(sys, { token: t, userId: ids.magB!, now })])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(await sys.membership.count({ where: { organizationId: ORG_A, userId: ids.magB! } })).toBe(1)

    const t2 = await invite('rownolegle@inna.test')
    const ns = await Promise.all([
      acceptWithNewAccount(sys, { token: t2, email: 'rownolegle@inna.test', name: 'R1', password: NEW_PASS, now }),
      acceptWithNewAccount(sys, { token: t2, email: 'rownolegle@inna.test', name: 'R2', password: NEW_PASS, now }),
    ])
    expect(ns.filter((r) => r.ok)).toHaveLength(1)
    expect(await sys.user.count({ where: { email: 'rownolegle@inna.test' } })).toBe(1)
    expect(await sys.membership.count({ where: { organizationId: ORG_A, user: { email: 'rownolegle@inna.test' } } })).toBe(1)
    // AuditLog: jedno przyjęcie na osobę
    expect(await sys.auditLog.count({ where: { organizationId: ORG_A, entity: 'Membership', entityId: ids.magB! } })).toBe(1)
  })

  it('zapraszający stracił uprawnienia, został wyłączony albo nie jest już właścicielem: zaproszenie przepada', async () => {
    // biuro zaprasza z `zwroty.pieniadze`, potem traci to uprawnienie
    const t1 = await invite('bez-firmy@inna.test', { by: 'biuroA', role: 'BIURO', permissions: ['zwroty.pieniadze'] })
    expect(await updateMember(A('wlA'), ids.biuroA!, { role: 'BIURO', permissions: ['uzytkownicy'] }, hosted)).toEqual({ ok: true })
    expect(await acceptWithLogin(sys, { token: t1, email: 'bez-firmy@inna.test', password: PASS, now: new Date() })).toEqual({ ok: false })
    expect(await membership(ORG_A, 'bezFirmy')).toBeNull()
    expect((await sys.invitation.findFirstOrThrow({ where: { tokenHash: tokenHash(t1) } })).revokedAt).not.toBeNull()

    // zapraszający wyłączony
    const t2 = await invite('magazyn@firma-b.test', { by: 'biuroA', role: 'BIURO' })
    expect(await setMemberActive(A('wlA'), ids.biuroA!, false, hosted)).toEqual({ ok: true })
    expect(await acceptAsUser(sys, { token: t2, userId: ids.magB!, now: new Date() })).toMatchObject({ ok: false })
    expect(await membership(ORG_A, 'magB')).toBeNull()

    // zaproszenie na właściciela, zapraszający przestał być właścicielem (zakładanie konta: wycofane razem z kontem)
    await person('wlA2', 'wlasciciel2@firma-a.test', ORG_A, 'WLASCICIEL')
    const t3 = await invite('nowy-wl@inna.test', { role: 'WLASCICIEL' })
    expect(await updateMember({ userId: ids.wlA2!, organizationId: ORG_A }, ids.wlA!, { role: 'BIURO', permissions: normalizeExtra('BIURO', ALL_PERMISSIONS) }, hosted)).toEqual({ ok: true })
    expect(await acceptWithNewAccount(sys, { token: t3, email: 'nowy-wl@inna.test', name: 'Nowy', password: NEW_PASS, now: new Date() })).toEqual({ ok: false })
    expect(await sys.user.count({ where: { email: 'nowy-wl@inna.test' } })).toBe(0)
    expect((await sys.invitation.findFirstOrThrow({ where: { tokenHash: tokenHash(t3) } })).revokedAt).not.toBeNull()
  })

  it('osoba wyłączona w tej firmie po zaproszeniu nie wraca przez stare zaproszenie', async () => {
    const t = await invite('magazyn@firma-b.test')
    await grantMembership(sys, { email: 'magazyn@firma-b.test', organizationId: ORG_A, role: 'MAGAZYN' })
    expect(await setMemberActive(A('wlA'), ids.magB!, false, hosted)).toEqual({ ok: true })
    expect(await acceptAsUser(sys, { token: t, userId: ids.magB!, now: new Date() })).toMatchObject({ ok: false })
    expect(await membership(ORG_A, 'magB')).toMatchObject({ active: false })
  })

  it('bez ważnego zaproszenia „Mam już konto” nie sprawdza hasła (licznik błędów i blokada konta bez zmian)', async () => {
    const before = await sys.user.findUniqueOrThrow({ where: { email: 'magazyn@firma-b.test' }, select: { failedLogins: true, lockedUntil: true } })
    for (let i = 0; i < 8; i++) {
      expect(await acceptWithLogin(sys, { token: 'zly-token-zly-token-zly-token', email: 'magazyn@firma-b.test', password: 'zle-haslo-0000000', now: new Date() })).toEqual({ ok: false })
    }
    // cofnięte zaproszenie też nie otwiera sprawdzania hasła
    const t = await invite('magazyn@firma-b.test')
    const [inv] = await sys.invitation.findMany({ where: { email: 'magazyn@firma-b.test' } })
    expect(await revokeInvitation(A('wlA'), inv!.id, hosted)).toEqual({ ok: true })
    expect(await acceptWithLogin(sys, { token: t, email: 'magazyn@firma-b.test', password: 'zle-haslo-0000000', now: new Date() })).toEqual({ ok: false })
    expect(await sys.user.findUniqueOrThrow({ where: { email: 'magazyn@firma-b.test' }, select: { failedLogins: true, lockedUntil: true } })).toEqual(before)
    expect((await login(sys, 'magazyn@firma-b.test', PASS)).ok).toBe(true)
    // ważne zaproszenie: złe hasło liczy się do blokady jak dotąd
    const t2 = await invite('magazyn@firma-b.test')
    expect(await acceptWithLogin(sys, { token: t2, email: 'magazyn@firma-b.test', password: 'zle-haslo-0000000', now: new Date() })).toEqual({ ok: false })
    expect((await sys.user.findUniqueOrThrow({ where: { email: 'magazyn@firma-b.test' } })).failedLogins).toBe(1)
  })

  it('aktywny członek przyjmuje zaproszenie na wyższą rolę: rola bez zmian, zaproszenie zamknięte, ślad w AuditLog', async () => {
    const t = await invite('magazyn@firma-b.test', { role: 'WLASCICIEL' })
    // dostęp nadany inną drogą po zaproszeniu (CLI `dostep`)
    await grantMembership(sys, { email: 'magazyn@firma-b.test', organizationId: ORG_A, role: 'MAGAZYN' })
    expect(await acceptAsUser(sys, { token: t, userId: ids.magB!, now: new Date() })).toEqual({ ok: true, organizationId: ORG_A })
    expect(await membership(ORG_A, 'magB')).toMatchObject({ role: 'MAGAZYN', active: true })
    expect(await invitationInfo(sys, t)).toBeNull()
    const inv = await sys.invitation.findFirstOrThrow({ where: { tokenHash: tokenHash(t) } })
    expect(inv.acceptedById).toBe(ids.magB)
    const log = await sys.auditLog.findFirstOrThrow({ where: { organizationId: ORG_A, entity: 'Invitation', entityId: inv.id, actorId: ids.magB! } })
    expect(log.after).toMatchObject({ przyjete: true, przyjalId: ids.magB, bezZmianyDostepu: true, rolaZaproszenia: 'WLASCICIEL', rolaOsoby: 'MAGAZYN' })
    expect(await sys.auditLog.count({ where: { organizationId: ORG_A, entity: 'Membership', entityId: ids.magB! } })).toBe(0)
  })

  it('limit prób per IP; błąd bazy w logu bez tokenu i hasła', async () => {
    const limiter = new SlidingLimiter(2, 60_000)
    const input = { kind: 'login' as const, token: 'zly-token-zly-token-zly-token', email: 'x@inna.test', password: 'zle-haslo-0000000' }
    await attemptAccept(sys, input, { ip: '203.0.113.32' }, { limiter })
    await attemptAccept(sys, input, { ip: '203.0.113.32' }, { limiter })
    expect(await attemptAccept(sys, input, { ip: '203.0.113.32' }, { limiter })).toEqual({ ok: false, message: MSG_INVITE_LIMIT })
    const t = await invite('nowy@inna.test')
    const lines: string[] = []
    const broken = new Proxy(sys, {
      get(target, k) {
        if (k === '$transaction')
          return async () => {
            throw Object.assign(new Error(`Invalid invocation tokenHash = ${tokenHash(t)} haslo ${NEW_PASS}`), { name: 'PrismaClientKnownRequestError', code: 'P1001' })
          }
        const v = Reflect.get(target, k, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) as PrismaClient
    const r = await attemptAccept(broken, { kind: 'new', token: t, email: 'nowy@inna.test', name: 'N', password: NEW_PASS, repeat: NEW_PASS }, { ip: '203.0.113.33' }, { limiter: new SlidingLimiter(10, 60_000), log: (m) => lines.push(m) })
    expect(r.ok).toBe(false)
    expect(lines).toEqual(['[zaproszenie] błąd: PrismaClientKnownRequestError P1001'])
  })
})

describe('izolacja i ślady', () => {
  it('firma widzi i cofa tylko swoje zaproszenia; rola aplikacji nie czyta tabeli (RLS „nikt”)', async () => {
    await invite('nowy@inna.test')
    const rB = await addMember({ userId: ids.wlB!, organizationId: ORG_B }, { email: 'nowy@inna.test', name: '', role: 'MAGAZYN', permissions: [] }, hosted)
    expect(rB).toMatchObject({ ok: true, kind: 'invited' })
    const invB = await sys.invitation.findFirstOrThrow({ where: { organizationId: ORG_B } })
    expect((await listInvitations(A('wlA'), hosted))!.map((i) => i.id)).not.toContain(invB.id)
    expect(await revokeInvitation(A('wlA'), invB.id, hosted)).toEqual({ ok: false, message: MSG_INVITE_GONE })
    expect((await sys.invitation.findUniqueOrThrow({ where: { id: invB.id } })).revokedAt).toBeNull()
    // osoba bez `uzytkownicy` nie widzi listy zaproszeń
    expect(await listInvitations(A('magA'), hosted)).toBeNull()
    const a = testDb()
    try {
      await expect(a.invitation.count()).rejects.toThrow()
    } finally {
      await a.$disconnect()
    }
  })

  it('token nie trafia do bazy, AuditLog ani wyniku listy; AuditLog: kto zaprosił, kto przyjął', async () => {
    const t = await invite('nowy@inna.test', { role: 'BIURO' })
    const r = await acceptWithNewAccount(sys, { token: t, email: 'nowy@inna.test', name: 'Nowy', password: NEW_PASS, now: new Date() })
    if (!r.ok) throw new Error('przyjęcie')
    const rows = JSON.stringify(await sys.invitation.findMany())
    expect(rows).not.toContain(t)
    expect(rows).toContain(tokenHash(t))
    const logs = await sys.auditLog.findMany({ where: { organizationId: ORG_A }, orderBy: { createdAt: 'asc' } })
    const all = JSON.stringify(logs)
    expect(all).not.toContain(t)
    expect(all).not.toContain(tokenHash(t))
    expect(all).not.toMatch(/haslo|password|argon2/i)
    const nowy = await sys.user.findUniqueOrThrow({ where: { email: 'nowy@inna.test' } })
    expect(logs.map((l) => [l.entity, l.actorId])).toEqual([
      ['Invitation', ids.wlA],
      ['Membership', ids.wlA],
    ])
    expect(logs[1]).toMatchObject({ entityId: nowy.id, after: { role: 'BIURO', active: true, przyjete: true, przyjalId: nowy.id } })
  })
})

describe('zaproszenie z dokładnym zestawem uprawnień (rola jako punkt startu)', () => {
  it('odebrane i dołożone z zaproszenia osoba dostaje przy przyjęciu; widać je na liście zaproszeń i w dzienniku', async () => {
    const r = await addMember(A('wlA'), { email: 'dokladnie@inna.test', name: '', role: 'BIURO', permissions: ['zwroty.pieniadze'], denied: ['klienci.dane', 'raporty.sprzedaz', 'nie.ma.takiego'] }, hosted)
    if (!r.ok || r.kind !== 'invited' || !r.link) throw new Error('zaproszenie')
    const t = LINK_RE.exec(r.link)![1]!
    const lista = (await listInvitations(A('wlA'), hosted))!
    expect(lista.find((z) => z.email === 'dokladnie@inna.test')).toMatchObject({ extra: ['zwroty.pieniadze'], denied: ['raporty.sprzedaz', 'klienci.dane'] })
    const acc = await acceptWithNewAccount(sys, { token: t, email: 'dokladnie@inna.test', name: 'Dokładna Osoba', password: NEW_PASS, now: new Date() })
    if (!acc.ok) throw new Error('przyjęcie')
    const u = await sys.user.findUniqueOrThrow({ where: { email: 'dokladnie@inna.test' } })
    expect(await sys.membership.findUnique({ where: { organizationId_userId: { organizationId: ORG_A, userId: u.id } } })).toMatchObject({
      role: 'BIURO',
      permissions: ['zwroty.pieniadze'],
      deniedPermissions: ['raporty.sprzedaz', 'klienci.dane'],
    })
    const s = await resolveSession(sys, acc.session.token)
    expect(s?.permissions.has('klienci.dane')).toBe(false)
    expect(s?.permissions.has('raporty.sprzedaz')).toBe(false)
    expect(s?.permissions.has('zwroty.pieniadze')).toBe(true)
    expect(s?.permissions.has('klienci.skrot')).toBe(true)
    const log = await sys.auditLog.findFirstOrThrow({ where: { entity: 'Membership', entityId: u.id } })
    expect(log.after).toMatchObject({ deniedPermissions: ['raporty.sprzedaz', 'klienci.dane'], przyjete: true })
  })

  it('nie-właściciel może zaprosić z węższym zestawem roli, której pełnego zestawu sam nie ma (odebrane to, czego nie ma)', async () => {
    // biuro nie ma stanowiska pakowania, które daje rola Magazyn
    const pelny = await addMember(A('biuroA'), { email: 'waski@inna.test', name: '', role: 'MAGAZYN', permissions: [] }, hosted)
    expect(pelny).toEqual({ ok: false, message: MSG_GRANT })
    const waski = await addMember(A('biuroA'), { email: 'waski@inna.test', name: '', role: 'MAGAZYN', permissions: [], denied: ['pakowanie.stanowisko'] }, hosted)
    expect(waski).toMatchObject({ ok: true, kind: 'invited' })
  })

  it('zapraszający stracił uprawnienie, które zaproszenie daje: przepada; odebrane w zaproszeniu nie liczą się jako nadane', async () => {
    const r = await addMember(A('biuroA'), { email: 'po-zmianie@inna.test', name: '', role: 'BIURO', permissions: ['zwroty.pieniadze'], denied: ['klienci.dane'] }, hosted)
    if (!r.ok || r.kind !== 'invited' || !r.link) throw new Error('zaproszenie')
    const t = LINK_RE.exec(r.link)![1]!
    // właściciel odbiera biuru dane klienta z roli: zaproszenie ich nie daje, więc dalej ważne
    expect(await updateMember(A('wlA'), ids.biuroA!, { role: 'BIURO', permissions: ['uzytkownicy', 'zwroty.pieniadze'], denied: ['klienci.dane'] }, hosted)).toEqual({ ok: true })
    expect((await acceptWithNewAccount(sys, { token: t, email: 'po-zmianie@inna.test', name: 'Po Zmianie', password: NEW_PASS, now: new Date() })).ok).toBe(true)
    // a teraz odbiera zwroty pieniędzy, które kolejne zaproszenie daje: przepada
    const r2 = await addMember(A('biuroA'), { email: 'po-zmianie2@inna.test', name: '', role: 'BIURO', permissions: ['zwroty.pieniadze'], denied: ['klienci.dane'] }, hosted)
    if (!r2.ok || r2.kind !== 'invited' || !r2.link) throw new Error('zaproszenie 2')
    expect(await updateMember(A('wlA'), ids.biuroA!, { role: 'BIURO', permissions: ['uzytkownicy'], denied: ['klienci.dane'] }, hosted)).toEqual({ ok: true })
    expect((await acceptWithNewAccount(sys, { token: LINK_RE.exec(r2.link)![1]!, email: 'po-zmianie2@inna.test', name: 'X', password: NEW_PASS, now: new Date() })).ok).toBe(false)
  })
})
