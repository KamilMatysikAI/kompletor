// Ustawienia → Użytkownicy i zmiana własnego hasła.
//  1. izolacja firm: firma A nie widzi i nie zmienia osób firmy B (dwie firmy w jednej bazie);
//  2. bezpieczniki: ostatni właściciel (także dwa równoległe żądania), bez uprawnienia `uzytkownicy` nic, nikt nie
//     nadaje uprawnień, których sam nie ma;
//  3. odebranie uprawnień działa od następnego żądania, wyłączenie dostępu kończy sesje tylko w tej firmie;
//  4. AuditLog: kto, komu, co — bez haseł; hasło startowe wraca raz w wyniku;
//  5. zmiana hasła: złe obecne hasło, zasady haseł, limit prób, wylogowanie pozostałych sesji, blokada konta, AuditLog;
//  6. poprawki po przeglądzie: rola właściciela po roli, włączenie jak nadanie;
//  7. (lista bez uprawnienia = null → 404), (argon2 poza transakcją), (aktywność per firma),
//     (hasło startowe: przekierowanie bez pętli, API odmawia), („Zakończ pozostałe sesje” w czasie blokady).
//     Zaproszenia w hostingu (dawne): tests/zaproszenia.integration.test.ts.
// Dane wyłącznie testowe (adresy w domenie .test).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  addPersonAtomic,
  changeOwnPassword,
  createUser,
  grantMembership,
  LOCK_MS,
  login,
  MAX_FAILED,
  resolveSession,
  setPassword,
  switchOrganization,
  TOUCH_EVERY_MS,
  tokenHash,
} from '@/lib/auth/sesje'
import { argonGate } from '@/lib/auth/hasla'
import { PASSWORD_PATH, PATH_HEADER } from '@/lib/auth/sesja-ciasteczko'
import { SlidingLimiter } from '@/lib/auth/limiter'
import { attemptPasswordChange, MSG_PW_CURRENT, MSG_PW_DOWN, MSG_PW_LIMIT, MSG_PW_MISMATCH, MSG_PW_SAME, MSG_PW_WEAK } from '@/lib/auth/zmiana-hasla'
import {
  addMember,
  changeOwnPasswordFromPanel,
  endOtherSessionsFromPanel,
  errorCode,
  errorMessage,
  listMembers,
  MSG_ALREADY,
  MSG_FAIL,
  MSG_GRANT,
  MSG_LAST_OWNER,
  MSG_NO_PERMISSION,
  MSG_NOT_FOUND,
  MSG_OWNER_ONLY,
  MSG_DEPENDENCY,
  MSG_OWNER_FULL,
  MSG_SELF_OFF,
  MSG_SELF_USERS,
  MSG_WIDER,
  normalizeExtra,
  zestawDoZapisu,
  setMemberActive,
  updateMember,
} from '@/lib/panel/uzytkownicy'
import { ALL_PERMISSIONS, uprawnieniaRoli } from '@/lib/auth/uprawnienia'
import { uprawnieniaOsoby } from '@/lib/klienci/odczyt'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'

// requireSession bierze ciasteczko i ścieżkę (nagłówek od proxy) z next/headers — w teście podstawione; klient
// systemowy z env łączy się z bazą testów (zmienne przed pierwszym użyciem, jak w stanowisko-na-sucho).
let ciasteczko: string | undefined
let sciezka = '/pulpit'
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (_n: string) => (ciasteczko ? { value: ciasteczko } : undefined) }),
  headers: async () => new Headers({ [PATH_HEADER]: sciezka }),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`)
  },
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
}))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const sys = testSystemDb()
const deps = { sys }
const PASS = 'haslo-testowe-0001'
const ids: Record<string, string> = {}

async function person(key: string, email: string, org: string, role: 'WLASCICIEL' | 'BIURO' | 'MAGAZYN', permissions?: string[]) {
  if (!ids[key]) ids[key] = (await sys.user.findUnique({ where: { email } }))?.id ?? (await createUser(sys, { email, name: `Osoba ${key}`, password: PASS })).id
  await grantMembership(sys, { email, organizationId: org, role, permissions })
}
const A = (key: string) => ({ userId: ids[key]!, organizationId: ORG_A })
const B = (key: string) => ({ userId: ids[key]!, organizationId: ORG_B })
const membership = (org: string, key: string) => sys.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org, userId: ids[key]! } } })
const owners = (org: string) => sys.membership.count({ where: { organizationId: org, role: 'WLASCICIEL', active: true } })
async function tokenOf(email: string, password = PASS): Promise<string> {
  const r = await login(sys, email, password)
  if (!r.ok) throw new Error(`logowanie ${email}: ${r.reason}`)
  return r.token
}

beforeEach(async () => {
  await truncateAll()
  for (const k of Object.keys(ids)) delete ids[k]
  await person('wlA', 'wlasciciel@firma-a.test', ORG_A, 'WLASCICIEL')
  await person('biuroA', 'biuro@firma-a.test', ORG_A, 'BIURO', ['uzytkownicy', 'zwroty.pieniadze'])
  await person('magA', 'magazyn@firma-a.test', ORG_A, 'MAGAZYN')
  await person('wlB', 'wlasciciel@firma-b.test', ORG_B, 'WLASCICIEL')
  await person('magB', 'magazyn@firma-b.test', ORG_B, 'MAGAZYN')
})
afterAll(async () => {
  await sys.$disconnect()
})

describe('izolacja firm', () => {
  it('lista: każda firma widzi tylko swoje osoby', async () => {
    const la = (await listMembers(A('wlA'), deps))!
    expect(la.map((m) => m.email).sort()).toEqual(['biuro@firma-a.test', 'magazyn@firma-a.test', 'wlasciciel@firma-a.test'])
    expect(la.find((m) => m.email === 'biuro@firma-a.test')?.extra).toEqual(['zwroty.pieniadze', 'uzytkownicy'])
    expect(la.find((m) => m.self)?.email).toBe('wlasciciel@firma-a.test')
    const lb = (await listMembers(B('wlB'), deps))!
    expect(lb.map((m) => m.email).sort()).toEqual(['magazyn@firma-b.test', 'wlasciciel@firma-b.test'])
  })

  it('firma A nie zmienia, nie wyłącza i nie „dodaje” osób firmy B', async () => {
    expect(await updateMember(A('wlA'), ids.magB!, { role: 'WLASCICIEL', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_NOT_FOUND })
    expect(await setMemberActive(A('wlA'), ids.wlB!, false, deps)).toEqual({ ok: false, message: MSG_NOT_FOUND })
    // właściciel A podszywający się pod firmę B (zła firma w „sesji”) nie ma tam członkostwa
    expect(await updateMember({ userId: ids.wlA!, organizationId: ORG_B }, ids.magB!, { role: 'WLASCICIEL', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_NO_PERMISSION })
    expect(await listMembers({ userId: ids.wlA!, organizationId: ORG_B }, deps)).toBeNull()
    expect((await membership(ORG_B, 'magB')).role).toBe('MAGAZYN')
    expect((await membership(ORG_B, 'wlB')).active).toBe(true)
    // dodanie istniejącego konta z B do A daje dostęp tylko do A; B bez zmian
    const r = await addMember(A('wlA'), { email: 'magazyn@firma-b.test', name: 'X', role: 'MAGAZYN', permissions: [] }, deps)
    expect(r).toMatchObject({ ok: true, kind: 'added', created: false, password: null })
    expect((await membership(ORG_B, 'magB')).role).toBe('MAGAZYN')
    expect((await sys.user.findUniqueOrThrow({ where: { id: ids.magB! } })).name).toBe('Osoba magB')
    expect(await sys.auditLog.count({ where: { organizationId: ORG_B } })).toBe(0)
    // klient firmy B (RLS) nie widzi wpisów AuditLog firmy A
    const b = testDb({ organizationId: ORG_B })
    try {
      expect(await b.auditLog.count()).toBe(0)
    } finally {
      await b.$disconnect()
    }
  })
})

describe('bezpieczniki', () => {
  it('bez uprawnienia `uzytkownicy` nic: lista, zmiana siebie, dodanie osoby', async () => {
    expect(await listMembers(A('magA'), deps)).toBeNull() // brak uprawnienia = null (ekran: 404), nie wyjątek
    expect(await updateMember(A('magA'), ids.magA!, { role: 'WLASCICIEL', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_NO_PERMISSION })
    expect(await updateMember(A('magA'), ids.magA!, { role: 'MAGAZYN', permissions: ['uzytkownicy'] }, deps)).toEqual({ ok: false, message: MSG_NO_PERMISSION })
    expect(await addMember(A('magA'), { email: 'nowy@firma-a.test', name: 'Nowy', role: 'MAGAZYN', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_NO_PERMISSION })
    expect(await membership(ORG_A, 'magA')).toMatchObject({ role: 'MAGAZYN', permissions: [] })
    expect(await sys.user.count({ where: { email: 'nowy@firma-a.test' } })).toBe(0)
    // wyłączone członkostwo z `uzytkownicy` też nic nie może
    await sys.membership.update({ where: { organizationId_userId: { organizationId: ORG_A, userId: ids.biuroA! } }, data: { active: false } })
    expect(await updateMember(A('biuroA'), ids.magA!, { role: 'MAGAZYN', permissions: ['zwroty.pieniadze'] }, deps)).toEqual({ ok: false, message: MSG_NO_PERMISSION })
  })

  it('nikt nie nadaje uprawnień, których sam nie ma; osobę z szerszymi zmienia tylko właściciel', async () => {
    // biuro z `uzytkownicy` nie ma `kanaly.tryb` ani roli właściciela
    expect(await updateMember(A('biuroA'), ids.biuroA!, { role: 'WLASCICIEL', permissions: [] }, deps)).toMatchObject({ ok: false })
    expect(await updateMember(A('biuroA'), ids.biuroA!, { role: 'BIURO', permissions: ['uzytkownicy', 'kanaly.tryb'] }, deps)).toMatchObject({ ok: false })
    expect(await updateMember(A('biuroA'), ids.magA!, { role: 'MAGAZYN', permissions: ['kanaly.tryb'] }, deps)).toMatchObject({ ok: false })
    expect(await addMember(A('biuroA'), { email: 'nowy@firma-a.test', name: 'Nowy', role: 'WLASCICIEL', permissions: [] }, deps)).toMatchObject({ ok: false })
    expect(await updateMember(A('biuroA'), ids.wlA!, { role: 'MAGAZYN', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_OWNER_ONLY })
    expect(await setMemberActive(A('biuroA'), ids.wlA!, false, deps)).toEqual({ ok: false, message: MSG_OWNER_ONLY })
    // drugie biuro z `uzytkownicy` i dodatkowo `kanaly.tryb` jest „szersze”: biuro A go nie wyłączy ani nie odbierze mu kanałów
    await person('biuroA2', 'biuro2@firma-a.test', ORG_A, 'BIURO', ['uzytkownicy', 'kanaly.tryb'])
    expect(await setMemberActive(A('biuroA'), ids.biuroA2!, false, deps)).toEqual({ ok: false, message: MSG_WIDER })
    expect(await updateMember(A('biuroA'), ids.biuroA2!, { role: 'BIURO', permissions: ['uzytkownicy'] }, deps)).toEqual({ ok: false, message: MSG_WIDER })
    // ale może mu dodać to, co sama ma (kanały zostają)
    expect(await updateMember(A('biuroA'), ids.biuroA2!, { role: 'BIURO', permissions: ['uzytkownicy', 'kanaly.tryb', 'zwroty.pieniadze'] }, deps)).toEqual({ ok: true })
    // magazyn (bez zarządzania osobami) wyłączy, ale włączenie przywraca `pakowanie.stanowisko`, którego biuro nie ma
    expect(await setMemberActive(A('biuroA'), ids.magA!, false, deps)).toEqual({ ok: true })
    expect(await setMemberActive(A('biuroA'), ids.magA!, true, deps)).toEqual({ ok: false, message: MSG_GRANT })
    expect(await setMemberActive(A('wlA'), ids.magA!, true, deps)).toEqual({ ok: true })
    expect((await membership(ORG_A, 'biuroA2')).permissions.sort()).toEqual(['kanaly.tryb', 'uzytkownicy', 'zwroty.pieniadze'])
    expect((await membership(ORG_A, 'biuroA')).permissions.sort()).toEqual(['uzytkownicy', 'zwroty.pieniadze'])
    expect((await membership(ORG_A, 'wlA'))).toMatchObject({ role: 'WLASCICIEL', active: true })
    // to, co ma, może nadać; uprawnienia z roli nie są zapisywane jako dodatkowe, nieznane odpadają
    expect(await updateMember(A('biuroA'), ids.magA!, { role: 'MAGAZYN', permissions: ['zwroty.pieniadze', 'panel.podglad', 'nie.ma.takiego'] }, deps)).toEqual({ ok: true })
    expect((await membership(ORG_A, 'magA')).permissions).toEqual(['zwroty.pieniadze'])
    // zmiana roli magazynu na biuro odbiera `pakowanie.stanowisko`, którego biuro nie ma — odmowa
    expect(await updateMember(A('biuroA'), ids.magA!, { role: 'BIURO', permissions: ['zwroty.pieniadze'] }, deps)).toEqual({ ok: false, message: MSG_WIDER })
    // AuditLog: kto (biuro), komu (magazyn)
    expect(await sys.auditLog.findMany({ where: { entityId: ids.magA! }, select: { actorId: true } })).toEqual(expect.arrayContaining([{ actorId: ids.biuroA }]))
  })

  it('komplet uprawnień bez roli nie przejmuje firmy; to samo właściciel może', async () => {
    await person('wlA2', 'wlasciciel2@firma-a.test', ORG_A, 'WLASCICIEL')
    await person('pelne', 'pelne@firma-a.test', ORG_A, 'BIURO', normalizeExtra('BIURO', ALL_PERMISSIONS))
    const p = A('pelne')
    const no = { ok: false, message: MSG_OWNER_ONLY }
    // nadanie roli: sobie, komuś, nowej osobie
    expect(await updateMember(p, ids.pelne!, { role: 'WLASCICIEL', permissions: [] }, deps)).toEqual(no)
    expect(await updateMember(p, ids.magA!, { role: 'WLASCICIEL', permissions: [] }, deps)).toEqual(no)
    expect(await addMember(p, { email: 'przejecie@firma-a.test', name: 'X', role: 'WLASCICIEL', permissions: [] }, deps)).toEqual(no)
    expect(await sys.user.count({ where: { email: 'przejecie@firma-a.test' } })).toBe(0)
    // odebranie roli i wyłączenie, także przy drugim właścicielu (bez „ostatniego właściciela” w tle)
    expect(await updateMember(p, ids.wlA!, { role: 'MAGAZYN', permissions: [] }, deps)).toEqual(no)
    expect(await setMemberActive(p, ids.wlA!, false, deps)).toEqual(no)
    // wyłączony właściciel: nie włączy go ani nie zdegraduje przez „Dodaj osobę”
    expect(await setMemberActive(A('wlA'), ids.wlA2!, false, deps)).toEqual({ ok: true })
    expect(await setMemberActive(p, ids.wlA2!, true, deps)).toEqual(no)
    expect(await addMember(p, { email: 'wlasciciel2@firma-a.test', name: 'X', role: 'MAGAZYN', permissions: [] }, deps)).toEqual(no)
    expect(await membership(ORG_A, 'wlA2')).toMatchObject({ role: 'WLASCICIEL', active: false })
    expect(await membership(ORG_A, 'pelne')).toMatchObject({ role: 'BIURO' })
    expect(await sys.auditLog.count({ where: { actorId: ids.pelne! } })).toBe(0)
    // komplet uprawnień nadal działa na zwykłych osobach
    expect(await updateMember(p, ids.magA!, { role: 'BIURO', permissions: [] }, deps)).toEqual({ ok: true })
    // właściciel może wszystko z powyższych
    expect(await setMemberActive(A('wlA'), ids.wlA2!, true, deps)).toEqual({ ok: true })
    expect(await updateMember(A('wlA'), ids.pelne!, { role: 'WLASCICIEL', permissions: [] }, deps)).toEqual({ ok: true })
    expect(await updateMember(A('wlA'), ids.wlA2!, { role: 'MAGAZYN', permissions: [] }, deps)).toEqual({ ok: true })
    expect(await setMemberActive(A('wlA'), ids.pelne!, false, deps)).toEqual({ ok: true })
    expect(await addMember(A('wlA'), { email: 'nowy-wl@firma-a.test', name: 'Nowy', role: 'WLASCICIEL', permissions: [] }, deps)).toMatchObject({ ok: true, created: true })
  })

  it('ponowne włączenie nie przywraca uprawnień, których włączający nie ma', async () => {
    await person('kanaly', 'kanaly@firma-a.test', ORG_A, 'MAGAZYN', ['kanaly.tryb'])
    const off = await setMemberActive(A('biuroA'), ids.kanaly!, false, deps)
    expect(off).toEqual({ ok: true }) // wyłączenie jest celowo luźniejsze (komentarz switchRefusal)
    expect(await setMemberActive(A('biuroA'), ids.kanaly!, true, deps)).toEqual({ ok: false, message: MSG_GRANT })
    expect((await membership(ORG_A, 'kanaly')).active).toBe(false)
    // ta sama droga przez „Dodaj osobę”: bez `kanaly.tryb` nie włączy i nie odbierze go po cichu
    expect(await addMember(A('biuroA'), { email: 'kanaly@firma-a.test', name: 'X', role: 'BIURO', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_WIDER })
    expect(await addMember(A('biuroA'), { email: 'kanaly@firma-a.test', name: 'X', role: 'BIURO', permissions: ['kanaly.tryb'] }, deps)).toEqual({ ok: false, message: MSG_GRANT })
    expect(await membership(ORG_A, 'kanaly')).toMatchObject({ active: false, permissions: ['kanaly.tryb'] })
    expect(await setMemberActive(A('wlA'), ids.kanaly!, true, deps)).toEqual({ ok: true })
    expect((await membership(ORG_A, 'kanaly')).active).toBe(true)
    // osobę w granicach własnych uprawnień biuro włączy
    await person('biuroZwykle', 'biuro-zwykle@firma-a.test', ORG_A, 'BIURO')
    expect(await setMemberActive(A('biuroA'), ids.biuroZwykle!, false, deps)).toEqual({ ok: true })
    expect(await setMemberActive(A('biuroA'), ids.biuroZwykle!, true, deps)).toEqual({ ok: true })
  })

  it('ostatni właściciel: nie odbierze sobie roli, nie wyłączy się; drugi właściciel to umożliwia', async () => {
    expect(await updateMember(A('wlA'), ids.wlA!, { role: 'BIURO', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_LAST_OWNER })
    expect(await setMemberActive(A('wlA'), ids.wlA!, false, deps)).toEqual({ ok: false, message: MSG_SELF_OFF })
    expect(await owners(ORG_A)).toBe(1)
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'WLASCICIEL', permissions: [] }, deps)).toEqual({ ok: true })
    // samemu sobie nie odbiera się zarządzania osobami, więc zostaje dołożone `uzytkownicy`
    expect(await updateMember(A('wlA'), ids.wlA!, { role: 'BIURO', permissions: ['uzytkownicy'] }, deps)).toEqual({ ok: true })
    expect(await owners(ORG_A)).toBe(1)
    // drugi (teraz jedyny) właściciel nie może zostać wyłączony ani zdegradowany przez kogokolwiek
    expect(await updateMember(A('magA'), ids.magA!, { role: 'MAGAZYN', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_LAST_OWNER })
  })

  it('ostatni właściciel przy dwóch równoległych żądaniach (blokada w transakcji): zostaje dokładnie jeden', async () => {
    for (let round = 0; round < 3; round++) {
      await person('wlA2', 'wlasciciel2@firma-a.test', ORG_A, 'WLASCICIEL')
      await grantMembership(sys, { email: 'wlasciciel@firma-a.test', organizationId: ORG_A, role: 'WLASCICIEL' })
      expect(await owners(ORG_A)).toBe(2)
      // każdy odbiera rolę sobie nawzajem / sobie — naraz
      const res =
        round === 0
          ? await Promise.all([
              updateMember(A('wlA'), ids.wlA2!, { role: 'BIURO', permissions: [] }, deps),
              updateMember(A('wlA2'), ids.wlA!, { role: 'BIURO', permissions: [] }, deps),
            ])
          : round === 1
            ? await Promise.all([
                updateMember(A('wlA'), ids.wlA!, { role: 'MAGAZYN', permissions: ['uzytkownicy'] }, deps),
                updateMember(A('wlA2'), ids.wlA2!, { role: 'MAGAZYN', permissions: ['uzytkownicy'] }, deps),
              ])
            : await Promise.all([setMemberActive(A('wlA'), ids.wlA2!, false, deps), setMemberActive(A('wlA2'), ids.wlA!, false, deps)])
      expect(res.filter((r) => r.ok)).toHaveLength(1)
      expect(res.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.message))[0]).toMatch(/ostatni właściciel|uprawnienia do zmiany/i)
      expect(await owners(ORG_A)).toBe(1)
      await grantMembership(sys, { email: 'wlasciciel2@firma-a.test', organizationId: ORG_A, role: 'WLASCICIEL' })
    }
  })
})

describe('dokładne uprawnienia: odebrane z zestawu roli', () => {
  it('odebranie z roli: zapis, lista, sesja i odczyt danych klienta od następnego żądania', async () => {
    const t = await tokenOf('biuro@firma-a.test')
    expect((await resolveSession(sys, t))?.permissions.has('klienci.dane')).toBe(true)
    expect(await updateMember(A('wlA'), ids.biuroA!, { role: 'BIURO', permissions: ['uzytkownicy', 'zwroty.pieniadze'], denied: ['klienci.dane', 'raporty.sprzedaz'] }, deps)).toEqual({ ok: true })
    expect(await membership(ORG_A, 'biuroA')).toMatchObject({ permissions: ['zwroty.pieniadze', 'uzytkownicy'], deniedPermissions: ['raporty.sprzedaz', 'klienci.dane'] })
    expect((await listMembers(A('wlA'), deps))!.find((m) => m.userId === ids.biuroA)).toMatchObject({ denied: ['raporty.sprzedaz', 'klienci.dane'] })
    const s = await resolveSession(sys, t)
    expect(s?.permissions.has('klienci.dane')).toBe(false)
    expect(s?.permissions.has('raporty.sprzedaz')).toBe(false)
    expect(s?.permissions.has('klienci.skrot')).toBe(true)
    const db = testDb({ organizationId: ORG_A })
    try {
      expect((await uprawnieniaOsoby(db, ids.biuroA!)).has('klienci.dane')).toBe(false)
    } finally {
      await db.$disconnect()
    }
    // przywrócenie zestawu roli
    expect(await updateMember(A('wlA'), ids.biuroA!, { role: 'BIURO', permissions: ['uzytkownicy', 'zwroty.pieniadze'] }, deps)).toEqual({ ok: true })
    expect((await resolveSession(sys, t))?.permissions.has('klienci.dane')).toBe(true)
  })

  it('pełny zestaw z ekranu → dołożone i odebrane; nieznane nazwy odpadają; Właściciel = nic', () => {
    const zestaw = [...uprawnieniaRoli('MAGAZYN')].filter((p) => p !== 'klienci.skrot')
    expect(zestawDoZapisu('MAGAZYN', [...zestaw, 'raporty.sprzedaz', 'nie.ma.takiego'])).toEqual({ permissions: ['raporty.sprzedaz'], denied: ['klienci.skrot'] })
    expect(zestawDoZapisu('WLASCICIEL', [])).toEqual({ permissions: [], denied: [] })
  })

  it('nikt nie nada uprawnienia, którego sam nie ma; odebrać może tylko to, co sam ma', async () => {
    // biuro (z `uzytkownicy`) nie ma stanowiska pakowania: pełnej roli Magazyn nie nada, węższą tak
    expect(await addMember(A('biuroA'), { email: 'nowy-mag@firma-a.test', name: 'Nowy', role: 'MAGAZYN', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_GRANT })
    expect(await addMember(A('biuroA'), { email: 'nowy-mag@firma-a.test', name: 'Nowy', role: 'MAGAZYN', permissions: [], denied: ['pakowanie.stanowisko'] }, deps)).toMatchObject({ ok: true })
    // magazynowi stanowiska nie odbierze (sam go nie ma), skrót danych klienta tak
    expect(await updateMember(A('biuroA'), ids.magA!, { role: 'MAGAZYN', permissions: [], denied: ['pakowanie.stanowisko'] }, deps)).toEqual({ ok: false, message: MSG_WIDER })
    expect(await updateMember(A('biuroA'), ids.magA!, { role: 'MAGAZYN', permissions: [], denied: ['klienci.skrot'] }, deps)).toEqual({ ok: true })
    // zmiana roli na Biuro: biuro ma cały zestaw tej roli, a stanowisko (którego nie ma) zostaje u osoby jako dołożone
    expect(await updateMember(A('biuroA'), ids.magA!, { role: 'BIURO', permissions: ['pakowanie.stanowisko'], denied: [] }, deps)).toEqual({ ok: true })
    expect(await membership(ORG_A, 'magA')).toMatchObject({ role: 'BIURO', permissions: ['pakowanie.stanowisko'], deniedPermissions: [] })
    // trybu kanału biuro nie ma, więc go nie nada
    expect(await updateMember(A('biuroA'), ids.magA!, { role: 'BIURO', permissions: ['pakowanie.stanowisko', 'kanaly.tryb'] }, deps)).toEqual({ ok: false, message: MSG_GRANT })
  })

  it('nie odbierze sobie `uzytkownicy` (odznaczeniem ani rolą); inna osoba może', async () => {
    expect(await updateMember(A('biuroA'), ids.biuroA!, { role: 'BIURO', permissions: ['zwroty.pieniadze'] }, deps)).toEqual({ ok: false, message: MSG_SELF_USERS })
    await person('wlA2', 'wlasciciel2@firma-a.test', ORG_A, 'WLASCICIEL')
    expect(await updateMember(A('wlA'), ids.wlA!, { role: 'BIURO', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_SELF_USERS })
    expect(await updateMember(A('wlA2'), ids.biuroA!, { role: 'BIURO', permissions: ['zwroty.pieniadze'] }, deps)).toEqual({ ok: true })
    expect(await membership(ORG_A, 'biuroA')).toMatchObject({ permissions: ['zwroty.pieniadze'] })
  })

  it('rola Właściciel: nic się jej nie odbiera (ostatni właściciel zawsze ma `uzytkownicy`)', async () => {
    expect(await updateMember(A('wlA'), ids.wlA!, { role: 'WLASCICIEL', permissions: [], denied: ['uzytkownicy'] }, deps)).toEqual({ ok: false, message: MSG_OWNER_FULL })
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'WLASCICIEL', permissions: [], denied: ['ustawienia'] }, deps)).toEqual({ ok: false, message: MSG_OWNER_FULL })
    expect(await addMember(A('wlA'), { email: 'wl-waski@firma-a.test', name: 'X', role: 'WLASCICIEL', permissions: [], denied: ['kanaly.tryb'] }, deps)).toEqual({ ok: false, message: MSG_OWNER_FULL })
    expect(await membership(ORG_A, 'wlA')).toMatchObject({ role: 'WLASCICIEL', deniedPermissions: [] })
  })

  it('zależność: bez podglądu panelu odmowa (także przy pustym zestawie: od tego jest wyłączenie dostępu)', async () => {
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'MAGAZYN', permissions: [], denied: ['panel.podglad'] }, deps)).toEqual({ ok: false, message: MSG_DEPENDENCY })
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'MAGAZYN', permissions: [], denied: [...uprawnieniaRoli('MAGAZYN')] }, deps)).toEqual({ ok: false, message: MSG_DEPENDENCY })
    expect(await addMember(A('wlA'), { email: 'bez-podgladu@firma-a.test', name: 'X', role: 'BIURO', permissions: [], denied: ['panel.podglad'] }, deps)).toEqual({ ok: false, message: MSG_DEPENDENCY })
    const keep = ALL_PERMISSIONS.filter((p) => p !== 'panel.podglad' && uprawnieniaRoli('MAGAZYN').has(p))
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'MAGAZYN', permissions: [], denied: keep }, deps)).toEqual({ ok: true })
    expect(await membership(ORG_A, 'magA')).toMatchObject({ deniedPermissions: keep })
  })

  it('nieznane nazwy i odebrane spoza roli nie trafiają do bazy', async () => {
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'MAGAZYN', permissions: [], denied: ['nie.ma.takiego', 'ustawienia', 'klienci.skrot', '__proto__'] }, deps)).toEqual({ ok: true })
    expect(await membership(ORG_A, 'magA')).toMatchObject({ deniedPermissions: ['klienci.skrot'] })
  })

  it('dziennik zmian: kto, komu, co nadane i co odebrane (wynikowy zestaw); zapis bez zmian bez wpisu', async () => {
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'MAGAZYN', permissions: ['raporty.sprzedaz'], denied: ['klienci.skrot'] }, deps)).toEqual({ ok: true })
    const log = await sys.auditLog.findFirstOrThrow({ where: { entity: 'Membership', entityId: ids.magA! }, orderBy: { createdAt: 'desc' } })
    expect(log).toMatchObject({ organizationId: ORG_A, actorId: ids.wlA })
    expect(log.before).toEqual({ role: 'MAGAZYN', permissions: [], deniedPermissions: [], active: true })
    expect(log.after).toEqual({ role: 'MAGAZYN', permissions: ['raporty.sprzedaz'], deniedPermissions: ['klienci.skrot'], active: true, zmiana: { nadane: ['raporty.sprzedaz'], odebrane: ['klienci.skrot'] } })
    const ile = await sys.auditLog.count({ where: { entity: 'Membership', entityId: ids.magA! } })
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'MAGAZYN', permissions: ['raporty.sprzedaz'], denied: ['klienci.skrot'] }, deps)).toEqual({ ok: true })
    expect(await sys.auditLog.count({ where: { entity: 'Membership', entityId: ids.magA! } })).toBe(ile)
  })

  it('CLI `dostep` bez list zostawia odebrane (zmiana roli z terminala niczego nie przywraca)', async () => {
    await updateMember(A('wlA'), ids.magA!, { role: 'MAGAZYN', permissions: [], denied: ['klienci.skrot'] }, deps)
    await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_A, role: 'MAGAZYN' })
    expect(await membership(ORG_A, 'magA')).toMatchObject({ deniedPermissions: ['klienci.skrot'] })
  })
})

describe('sesje', () => {
  it('odebranie uprawnienia działa od następnego żądania tej osoby', async () => {
    const t = await tokenOf('biuro@firma-a.test')
    expect((await resolveSession(sys, t))?.permissions.has('zwroty.pieniadze')).toBe(true)
    expect(await updateMember(A('wlA'), ids.biuroA!, { role: 'BIURO', permissions: [] }, deps)).toEqual({ ok: true })
    const s = await resolveSession(sys, t)
    expect(s?.permissions.has('zwroty.pieniadze')).toBe(false)
    expect(s?.permissions.has('uzytkownicy')).toBe(false)
    // i teraz sama nie przywróci sobie uprawnień
    expect(await updateMember(A('biuroA'), ids.biuroA!, { role: 'BIURO', permissions: ['uzytkownicy'] }, deps)).toEqual({ ok: false, message: MSG_NO_PERMISSION })
  })

  it('wyłączenie dostępu kończy sesje osoby w tej firmie, w innej firmie pracuje dalej; ponowne włączenie przywraca dostęp', async () => {
    await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_B, role: 'MAGAZYN' })
    const tA = await tokenOf('magazyn@firma-a.test')
    const tB = await tokenOf('magazyn@firma-a.test')
    await sys.session.update({ where: { id: tokenHash(tB) }, data: { organizationId: ORG_B } })
    expect(await setMemberActive(A('wlA'), ids.magA!, false, deps)).toEqual({ ok: true })
    expect(await sys.session.count({ where: { id: tokenHash(tA) } })).toBe(0)
    expect(await resolveSession(sys, tA)).toBeNull()
    expect((await resolveSession(sys, tB))?.organization.organizationId).toBe(ORG_B)
    // konto nie jest kasowane, lista pokazuje wyłączony dostęp
    expect(await sys.user.count({ where: { id: ids.magA! } })).toBe(1)
    expect((await listMembers(A('wlA'), deps))!.find((m) => m.userId === ids.magA)?.active).toBe(false)
    expect(await setMemberActive(A('wlA'), ids.magA!, true, deps)).toEqual({ ok: true })
    expect((await membership(ORG_A, 'magA')).active).toBe(true)
  })
})

describe('self-host bez zmian', () => {
  it('konto z innej firmy dostaje dostęp jak dotąd, hasło i imię bez zmian; nowe konto: hasło startowe do zmiany', async () => {
    const self = { sys, appMode: 'self-host' as const }
    const r = await addMember(A('wlA'), { email: 'magazyn@firma-b.test', name: 'Inne Imię', role: 'MAGAZYN', permissions: [] }, self)
    expect(r).toEqual({ ok: true, kind: 'added', userId: ids.magB, created: false, password: null })
    expect((await sys.user.findUniqueOrThrow({ where: { id: ids.magB! } })).name).toBe('Osoba magB')
    expect(await addMember(A('wlA'), { email: 'magazyn@firma-b.test', name: 'X', role: 'MAGAZYN', permissions: [] }, self)).toEqual({ ok: false, message: MSG_ALREADY })
    expect(await sys.invitation.count()).toBe(0)
    const n = await addMember(A('wlA'), { email: 'nowy-self@firma-a.test', name: 'Nowy', role: 'MAGAZYN', permissions: [] }, self)
    expect(n).toMatchObject({ ok: true, kind: 'added', created: true })
    expect((await sys.user.findUniqueOrThrow({ where: { email: 'nowy-self@firma-a.test' } })).mustChangePassword).toBe(true)
  })
})

describe('błędy w adresie', () => {
  it('kody w obie strony; obca treść, prototyp i nieznany kod nie dają komunikatu', () => {
    for (const m of [MSG_OWNER_ONLY, MSG_WIDER, MSG_GRANT, MSG_LAST_OWNER, MSG_SELF_OFF, MSG_NOT_FOUND, MSG_NO_PERMISSION, MSG_FAIL]) expect(errorMessage(errorCode(m))).toBe(m)
    expect(errorCode('coś nieznanego')).toBe('fail')
    expect(errorMessage('Twoje hasło wygasło, zadzwoń pod 500 000 000')).toBeUndefined()
    expect(errorMessage('__proto__')).toBeUndefined()
    expect(errorMessage('constructor')).toBeUndefined()
    expect(errorMessage(undefined)).toBeUndefined()
  })
})

describe('dodanie osoby i AuditLog', () => {
  it('błąd między kontem a członkostwem nie zostawia konta; ponowne dodanie daje hasło', async () => {
    const p = { email: 'cli@firma-a.test', name: 'Z CLI', role: 'MAGAZYN' as const }
    await expect(addPersonAtomic(sys, { ...p, organizationId: '00000000-0000-0000-0000-00000000dead' })).rejects.toThrow()
    expect(await sys.user.count({ where: { email: p.email } })).toBe(0)
    const r = await addPersonAtomic(sys, { ...p, organizationId: ORG_A })
    expect(r.ok && r.password).toBeTruthy()
    // CLI `dodaj`: hasło startowe do zmiany przy pierwszym logowaniu
    expect((await sys.user.findUniqueOrThrow({ where: { email: p.email } })).mustChangePassword).toBe(true)
    expect(await sys.membership.count({ where: { organizationId: ORG_A, userId: r.ok ? r.userId : '' } })).toBe(1)
  })

  it('nowe konto: hasło startowe raz w wyniku, działa przy logowaniu; AuditLog bez hasła i skrótu', async () => {
    const r = await addMember(A('wlA'), { email: ' Nowa@Firma-A.test ', name: 'Nowa Osoba', role: 'BIURO', permissions: ['zwroty.pieniadze'] }, deps)
    if (!r.ok || r.kind !== 'added' || !r.created || !r.password) throw new Error('brak hasła startowego')
    expect(r.password.length).toBeGreaterThanOrEqual(12)
    expect((await login(sys, 'nowa@firma-a.test', r.password)).ok).toBe(true)
    // ponownie ten sam adres: już ma dostęp
    expect(await addMember(A('wlA'), { email: 'nowa@firma-a.test', name: 'Nowa', role: 'BIURO', permissions: [] }, deps)).toEqual({ ok: false, message: MSG_ALREADY })
    await updateMember(A('wlA'), r.userId, { role: 'MAGAZYN', permissions: [] }, deps)
    await setMemberActive(A('wlA'), r.userId, false, deps)

    const logs = await sys.auditLog.findMany({ where: { entity: 'Membership' }, orderBy: { createdAt: 'asc' } })
    expect(logs).toHaveLength(3)
    expect(logs.every((l) => l.organizationId === ORG_A && l.actorId === ids.wlA && l.entityId === r.userId)).toBe(true)
    expect(logs[0]!.after).toMatchObject({ role: 'BIURO', permissions: ['zwroty.pieniadze'], deniedPermissions: [], active: true, noweKonto: true })
    expect(logs[1]!.before).toEqual({ role: 'BIURO', permissions: ['zwroty.pieniadze'], deniedPermissions: [], active: true })
    expect(logs[1]!.after).toMatchObject({ role: 'MAGAZYN', permissions: [], deniedPermissions: [], active: true })
    expect(logs[2]!.after).toMatchObject({ active: false })
    const hash = (await sys.user.findUniqueOrThrow({ where: { id: r.userId } })).passwordHash
    const all = JSON.stringify(await sys.auditLog.findMany())
    expect(all).not.toContain(r.password)
    expect(all).not.toContain(hash)
    expect(all).not.toMatch(/argon2|haslo|password/i)
  })

  it('złe dane: e-mail, imię, rola', async () => {
    expect(await addMember(A('wlA'), { email: 'to nie mail', name: 'X', role: 'BIURO', permissions: [] }, deps)).toMatchObject({ ok: false })
    expect(await addMember(A('wlA'), { email: 'x@firma-a.test', name: '   ', role: 'BIURO', permissions: [] }, deps)).toMatchObject({ ok: false })
    expect(await addMember(A('wlA'), { email: 'x@firma-a.test', name: 'X', role: 'ADMIN', permissions: [] }, deps)).toMatchObject({ ok: false })
    expect(await updateMember(A('wlA'), ids.magA!, { role: 'ADMIN', permissions: [] }, deps)).toMatchObject({ ok: false })
    expect(await sys.user.count({ where: { email: 'x@firma-a.test' } })).toBe(0)
  })
})

describe('zmiana własnego hasła', () => {
  const NEW = 'nowe-haslo-testowe-01'

  it('złe obecne hasło: odmowa, hasło i sesje bez zmian; potem poprawna zmiana wylogowuje pozostałe sesje', async () => {
    const t1 = await tokenOf('magazyn@firma-a.test')
    const t2 = await tokenOf('magazyn@firma-a.test')
    const before = (await sys.user.findUniqueOrThrow({ where: { id: ids.magA! } })).passwordHash
    const s = { userId: ids.magA!, organizationId: ORG_A, sessionId: tokenHash(t1) }
    const ip = '203.0.113.7'
    expect(await changeOwnPasswordFromPanel(s, { current: 'zle-haslo-0000000', next: NEW, repeat: NEW, ip }, deps)).toEqual({ ok: false, message: MSG_PW_CURRENT })
    expect(await changeOwnPasswordFromPanel(s, { current: PASS, next: NEW, repeat: `${NEW}x`, ip }, deps)).toEqual({ ok: false, message: MSG_PW_MISMATCH })
    expect(await changeOwnPasswordFromPanel(s, { current: PASS, next: 'krotkie', repeat: 'krotkie', ip }, deps)).toEqual({ ok: false, message: MSG_PW_WEAK })
    expect(await changeOwnPasswordFromPanel(s, { current: PASS, next: PASS, repeat: PASS, ip }, deps)).toEqual({ ok: false, message: MSG_PW_SAME })
    expect((await sys.user.findUniqueOrThrow({ where: { id: ids.magA! } })).passwordHash).toBe(before)
    expect(await sys.session.count({ where: { userId: ids.magA! } })).toBe(2)

    expect(await changeOwnPasswordFromPanel(s, { current: PASS, next: NEW, repeat: NEW, ip }, deps)).toEqual({ ok: true })
    expect(await resolveSession(sys, t1)).not.toBeNull()
    expect(await resolveSession(sys, t2)).toBeNull()
    expect((await login(sys, 'magazyn@firma-a.test', PASS)).ok).toBe(false)
    expect((await login(sys, 'magazyn@firma-a.test', NEW)).ok).toBe(true)
    // innych osób nie dotyka
    expect((await login(sys, 'wlasciciel@firma-a.test', PASS)).ok).toBe(true)
  })

  it('limit prób jak przy logowaniu: per IP i per osoba; limit nie woła sprawdzania hasła', async () => {
    let calls = 0
    const change = async () => {
      calls++
      return { ok: false as const, reason: 'invalid_current' as const }
    }
    const userLimiter = new SlidingLimiter(5, 15 * 60_000)
    const ipLimiter = new SlidingLimiter(20, 60_000)
    const p = { userId: ids.magA!, organizationId: ORG_A, sessionId: 'x', current: 'zle-haslo-0000000', next: NEW, repeat: NEW, ip: '203.0.113.8' }
    for (let i = 0; i < 5; i++) expect(await attemptPasswordChange(sys, p, { change, userLimiter, ipLimiter })).toEqual({ ok: false, message: MSG_PW_CURRENT })
    expect(await attemptPasswordChange(sys, p, { change, userLimiter, ipLimiter })).toEqual({ ok: false, message: MSG_PW_LIMIT })
    expect(calls).toBe(5)
    // inna osoba z tego samego IP: aż do limitu IP
    const ip2 = new SlidingLimiter(2, 60_000)
    const u2 = new SlidingLimiter(5, 15 * 60_000)
    expect((await attemptPasswordChange(sys, { ...p, userId: 'a' }, { change, userLimiter: u2, ipLimiter: ip2 })).ok).toBe(false)
    expect((await attemptPasswordChange(sys, { ...p, userId: 'b' }, { change, userLimiter: u2, ipLimiter: ip2 })).ok).toBe(false)
    expect(await attemptPasswordChange(sys, { ...p, userId: 'c' }, { change, userLimiter: u2, ipLimiter: ip2 })).toEqual({ ok: false, message: MSG_PW_LIMIT })
  })

  it('błąd zapisu w logu tylko jako nazwa i kod, bez treści z argumentami zapytania', async () => {
    const lines: string[] = []
    const secret = '$argon2id$v=19$m=65536$tajny-skrot'
    const change = async () => {
      throw Object.assign(new Error(`Invalid update where passwordHash = ${secret}`), { name: 'PrismaClientKnownRequestError', code: 'P2010' })
    }
    const r = await attemptPasswordChange(
      sys,
      { userId: ids.magA!, organizationId: ORG_A, sessionId: 'x', current: PASS, next: NEW, repeat: NEW, ip: '203.0.113.9' },
      { change, userLimiter: new SlidingLimiter(5, 60_000), ipLimiter: new SlidingLimiter(5, 60_000), log: (m) => lines.push(m) },
    )
    expect(r).toEqual({ ok: false, message: MSG_PW_DOWN })
    expect(lines).toEqual(['[haslo] błąd: PrismaClientKnownRequestError P2010'])
  })

  it('błędne obecne hasło liczy się do blokady konta: logowanie i zmiana stoją, sesja działa, po czasie wraca', async () => {
    const t = await tokenOf('magazyn@firma-a.test')
    const now = new Date()
    const p = { userId: ids.magA!, organizationId: ORG_A, keepSessionId: tokenHash(t), next: NEW, now }
    for (let i = 1; i < MAX_FAILED; i++) expect(await changeOwnPassword(sys, { ...p, current: 'zle-haslo-0000000' })).toEqual({ ok: false, reason: 'invalid_current' })
    expect((await sys.user.findUniqueOrThrow({ where: { id: ids.magA! } })).failedLogins).toBe(MAX_FAILED - 1)
    expect(await changeOwnPassword(sys, { ...p, current: 'zle-haslo-0000000' })).toEqual({ ok: false, reason: 'locked' })
    expect((await sys.user.findUniqueOrThrow({ where: { id: ids.magA! } })).lockedUntil).toEqual(new Date(now.getTime() + LOCK_MS))
    // dobre hasło też nie przejdzie, dopóki trwa blokada; istniejąca sesja działa
    expect(await changeOwnPassword(sys, { ...p, current: PASS })).toEqual({ ok: false, reason: 'locked' })
    expect(await login(sys, 'magazyn@firma-a.test', PASS, { now })).toEqual({ ok: false, reason: 'locked' })
    expect(await resolveSession(sys, t, { now })).not.toBeNull()
    // komunikat dla osoby
    const limits = { userLimiter: new SlidingLimiter(5, 60_000), ipLimiter: new SlidingLimiter(5, 60_000), now }
    expect(await attemptPasswordChange(sys, { userId: ids.magA!, organizationId: ORG_A, sessionId: tokenHash(t), current: PASS, next: NEW, repeat: NEW, ip: '203.0.113.10' }, limits)).toEqual({ ok: false, message: MSG_PW_LIMIT })
    const later = new Date(now.getTime() + LOCK_MS + 1000)
    expect(await changeOwnPassword(sys, { ...p, current: PASS, now: later })).toEqual({ ok: true })
    expect(await sys.user.findUniqueOrThrow({ where: { id: ids.magA! } })).toMatchObject({ failedLogins: 0, lockedUntil: null })
  })

  it('udana zmiana zostawia ślad w AuditLog firmy z sesji, bez hasła; nieudana nie zostawia', async () => {
    await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_B, role: 'MAGAZYN' })
    const t1 = await tokenOf('magazyn@firma-a.test')
    await tokenOf('magazyn@firma-a.test')
    const p = { userId: ids.magA!, organizationId: ORG_A, keepSessionId: tokenHash(t1), next: NEW }
    expect(await changeOwnPassword(sys, { ...p, current: 'zle-haslo-0000000' })).toMatchObject({ ok: false })
    expect(await sys.auditLog.count({ where: { entity: 'User' } })).toBe(0)
    expect(await changeOwnPassword(sys, { ...p, current: PASS })).toEqual({ ok: true })
    const logs = await sys.auditLog.findMany({ where: { entity: 'User' } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ organizationId: ORG_A, entityId: ids.magA, actorId: ids.magA, after: { hasloZmienione: true, sesjeZakonczone: 1 } })
    const hash = (await sys.user.findUniqueOrThrow({ where: { id: ids.magA! } })).passwordHash
    const all = JSON.stringify(logs)
    expect(all).not.toContain(hash)
    expect(all).not.toContain(NEW)
    expect(await sys.auditLog.count({ where: { organizationId: ORG_B } })).toBe(0)
  })
})

// ─── ──────────────────────────────────────────────────────────────

describe('argon2 poza transakcją pod blokadą członkostw', () => {
  it('dodanie nowej osoby liczy skrót hasła przed transakcją, w transakcji ani razu', async () => {
    let inTx = false
    const calls: boolean[] = []
    const orig = argonGate.run.bind(argonGate)
    const spy = vi.spyOn(argonGate, 'run').mockImplementation(((fn: () => Promise<unknown>) => {
      calls.push(inTx)
      return orig(fn)
    }) as typeof argonGate.run)
    // klient, który zaznacza czas trwania każdej transakcji
    const watched = new Proxy(sys, {
      get(t, k) {
        if (k === '$transaction')
          return (fn: (tx: unknown) => Promise<unknown>, o?: object) =>
            t.$transaction(async (tx) => {
              inTx = true
              try {
                return await fn(tx)
              } finally {
                inTx = false
              }
            }, o)
        const v = Reflect.get(t, k, t)
        return typeof v === 'function' ? v.bind(t) : v
      },
    }) as PrismaClient
    try {
      const r = await addMember(A('wlA'), { email: 'd7@firma-a.test', name: 'D7', role: 'MAGAZYN', permissions: [] }, { sys: watched, appMode: 'self-host' })
      expect(r).toMatchObject({ ok: true, kind: 'added', created: true })
      // także dla istniejącego konta skrót liczony przed blokadą (czas nie zależy od istnienia konta)
      expect(await addMember(A('wlA'), { email: 'magazyn@firma-b.test', name: 'X', role: 'MAGAZYN', permissions: [] }, { sys: watched, appMode: 'self-host' })).toMatchObject({ ok: true, created: false })
      expect(calls).toEqual([false, false])
      // hosting: zaproszenie bez żadnego hashowania
      calls.length = 0
      expect(await addMember(A('wlA'), { email: 'd7-h@firma-a.test', name: '', role: 'MAGAZYN', permissions: [] }, { sys: watched, appMode: 'hosted', panelUrl: 'https://panel.example.test' })).toMatchObject({ ok: true, kind: 'invited' })
      expect(calls).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('aktywność per firma zamiast globalnego logowania', () => {
  it('logowanie i sesja dotykają Membership.lastSeenAt tylko w firmie sesji; lista nie pokazuje aktywności w innej firmie', async () => {
    await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_B, role: 'MAGAZYN' })
    const t0 = new Date('2026-11-02T08:00:00Z')
    const r = await login(sys, 'magazyn@firma-a.test', PASS, { now: t0 })
    if (!r.ok) throw new Error('logowanie')
    expect((await membership(ORG_A, 'magA')).lastSeenAt).toEqual(t0)
    // praca w firmie B: dotyk po TOUCH_EVERY_MS, tylko członkostwo B
    const t1 = new Date(t0.getTime() + 60_000)
    expect(await switchOrganization(sys, r.token, ORG_B, { now: t1 })).toBe(true) // przełącznik firmy: dotyk od razu
    const t2 = new Date(t1.getTime() + TOUCH_EVERY_MS - 1000)
    await resolveSession(sys, r.token, { now: t2 }) // przed upływem TOUCH_EVERY_MS: bez zapisu
    expect((await membership(ORG_B, 'magA')).lastSeenAt).toEqual(t1)
    const t3 = new Date(t1.getTime() + TOUCH_EVERY_MS + 1000)
    await resolveSession(sys, r.token, { now: t3 })
    expect((await membership(ORG_B, 'magA')).lastSeenAt).toEqual(t3)
    expect((await membership(ORG_A, 'magA')).lastSeenAt).toEqual(t0)
    const row = (await listMembers(A('wlA'), deps))!.find((m) => m.userId === ids.magA)!
    expect(row.lastSeenAt).toEqual(t0)
    expect(row).not.toHaveProperty('lastLoginAt')
    // osoba bez aktywności w tej firmie
    expect((await listMembers(A('wlA'), deps))!.find((m) => m.userId === ids.biuroA)!.lastSeenAt).toBeNull()
  })

  it('„konto zablokowane” w hostingu tylko dla konta wyłącznie tej firmy; w self-hoście jak dotąd', async () => {
    await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_B, role: 'MAGAZYN' })
    await sys.user.updateMany({ where: { id: { in: [ids.magA!, ids.biuroA!] } }, data: { active: false } })
    const hosted = (await listMembers(A('wlA'), { sys, appMode: 'hosted' }))!
    expect(hosted.find((m) => m.userId === ids.biuroA)!.accountBlocked).toBe(true) // tylko firma A
    expect(hosted.find((m) => m.userId === ids.magA)!.accountBlocked).toBe(false) // należy też do B
    const self = (await listMembers(A('wlA'), { sys, appMode: 'self-host' }))!
    expect(self.find((m) => m.userId === ids.magA)!.accountBlocked).toBe(true)
  })
})

describe('hasło startowe do zmiany przy pierwszym logowaniu', () => {
  const kontekst = () => import('@/lib/panel/kontekst')
  const api = () => import('@/lib/stanowisko/sesja-api')

  it('istniejące konta nic nie odczuwają; CLI `haslo` i dodanie osoby ustawiają flagę, udana zmiana hasła ją czyści', async () => {
    expect(await sys.user.count({ where: { mustChangePassword: true } })).toBe(0)
    const t = await tokenOf('magazyn@firma-a.test')
    expect((await resolveSession(sys, t))?.mustChangePassword).toBe(false)
    await setPassword(sys, 'magazyn@firma-a.test', 'haslo-startowe-cli-01')
    expect((await sys.user.findUniqueOrThrow({ where: { id: ids.magA! } })).mustChangePassword).toBe(true)
    const t2 = await tokenOf('magazyn@firma-a.test', 'haslo-startowe-cli-01')
    expect((await resolveSession(sys, t2))?.mustChangePassword).toBe(true)
    // nieudana zmiana nie czyści, udana czyści
    const s = { userId: ids.magA!, organizationId: ORG_A, sessionId: tokenHash(t2) }
    expect((await changeOwnPasswordFromPanel(s, { current: 'zle-haslo-0000000', next: 'nowe-haslo-u2-0001', repeat: 'nowe-haslo-u2-0001', ip: '203.0.113.20' }, deps)).ok).toBe(false)
    expect((await resolveSession(sys, t2))?.mustChangePassword).toBe(true)
    expect(await changeOwnPasswordFromPanel(s, { current: 'haslo-startowe-cli-01', next: 'nowe-haslo-u2-0001', repeat: 'nowe-haslo-u2-0001', ip: '203.0.113.20' }, deps)).toEqual({ ok: true })
    expect((await resolveSession(sys, t2))?.mustChangePassword).toBe(false)
  })

  it('requireSession: przekierowanie na /ustawienia/haslo wszędzie poza tym ekranem (bez pętli); API odmawia; po zmianie normalnie', async () => {
    const r = await addMember(A('wlA'), { email: 'startowe@firma-a.test', name: 'Startowe', role: 'MAGAZYN', permissions: [] }, deps)
    if (!r.ok || r.kind !== 'added' || !r.password) throw new Error('brak hasła startowego')
    ciasteczko = await tokenOf('startowe@firma-a.test', r.password)
    const k = await kontekst()
    try {
      for (const p of ['/pulpit', '/zamowienia', '/ustawienia/uzytkownicy', '/stanowisko', '/ustawienia/haslo/inne']) {
        sciezka = p
        await expect(k.requireSession(), p).rejects.toThrow(`REDIRECT ${PASSWORD_PATH}`)
        await expect(k.requirePermission('pakowanie.stanowisko'), p).rejects.toThrow(`REDIRECT ${PASSWORD_PATH}`)
        // szkielet panelu (requireLogin) działa — z niego „Wyloguj”
        expect((await k.requireLogin()).user.email).toBe('startowe@firma-a.test')
      }
      // na ekranie hasła (strona, layout i akcje — ten sam adres) bez przekierowania: brak pętli
      sciezka = PASSWORD_PATH
      expect((await k.requireSession()).mustChangePassword).toBe(true)
      // trasy API: odmowa, nie obejście
      const res = await (await api()).requirePermissionApi('pakowanie.stanowisko')
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(403)
      // zmiana hasła czyści flagę: dalej normalnie
      const ctx = await k.requireSession()
      expect(await changeOwnPasswordFromPanel({ userId: ctx.user.id, organizationId: ORG_A, sessionId: ctx.sessionId }, { current: r.password, next: 'wlasne-haslo-u2-001', repeat: 'wlasne-haslo-u2-001', ip: '203.0.113.21' }, deps)).toEqual({ ok: true })
      sciezka = '/pulpit'
      expect((await k.requireSession()).mustChangePassword).toBe(false)
      expect(await (await api()).requirePermissionApi('pakowanie.stanowisko')).not.toBeInstanceOf(Response)
    } finally {
      ciasteczko = undefined
      sciezka = '/pulpit'
    }
  })
})

describe('„Zakończ pozostałe sesje” bez hasła', () => {
  it('działa w czasie blokady konta, nie dotyka bieżącej sesji ani innych osób; AuditLog w tej samej transakcji', async () => {
    await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_B, role: 'MAGAZYN' })
    const mine = await tokenOf('magazyn@firma-a.test')
    const thief1 = await tokenOf('magazyn@firma-a.test')
    const thief2 = await tokenOf('magazyn@firma-a.test')
    await sys.session.update({ where: { id: tokenHash(thief2) }, data: { organizationId: ORG_B } })
    const other = await tokenOf('wlasciciel@firma-a.test')
    // atakujący zna tylko e-mail i trzyma blokadę złymi logowaniami
    for (let i = 0; i < MAX_FAILED; i++) await login(sys, 'magazyn@firma-a.test', 'zle-haslo-0000000')
    expect(await login(sys, 'magazyn@firma-a.test', PASS)).toEqual({ ok: false, reason: 'locked' })
    expect(await changeOwnPassword(sys, { userId: ids.magA!, organizationId: ORG_A, current: PASS, next: 'nowe-haslo-u5-0001', keepSessionId: tokenHash(mine) })).toEqual({ ok: false, reason: 'locked' })

    // AuditLog mówi, z jakiej przeglądarki kliknięto
    await sys.session.update({ where: { id: tokenHash(mine) }, data: { userAgent: 'Przegladarka-testowa/1.0' } })
    const n = await endOtherSessionsFromPanel({ userId: ids.magA!, organizationId: ORG_A, sessionId: tokenHash(mine) }, deps)
    expect(n).toBe(2)
    expect(await resolveSession(sys, mine)).not.toBeNull()
    expect(await resolveSession(sys, thief1)).toBeNull()
    expect(await resolveSession(sys, thief2)).toBeNull()
    expect(await resolveSession(sys, other)).not.toBeNull()
    // blokada konta i hasło bez zmian (akcja niczego nie zgaduje i nie odblokowuje)
    expect((await sys.user.findUniqueOrThrow({ where: { id: ids.magA! } })).lockedUntil).not.toBeNull()
    const logs = await sys.auditLog.findMany({ where: { entity: 'User', entityId: ids.magA! } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ organizationId: ORG_A, actorId: ids.magA, after: { sesjeZakonczone: 2, zostalaPrzegladarka: 'Przegladarka-testowa/1.0' } })
    // drugi raz: nic do zakończenia
    expect(await endOtherSessionsFromPanel({ userId: ids.magA!, organizationId: ORG_A, sessionId: tokenHash(mine) }, deps)).toBe(0)
  })

  it('tylko z żywej sesji tej osoby: cudza albo nieistniejąca sesja nie kończy niczego', async () => {
    const mine = await tokenOf('magazyn@firma-a.test')
    const other = await tokenOf('wlasciciel@firma-a.test')
    expect(await endOtherSessionsFromPanel({ userId: ids.magA!, organizationId: ORG_A, sessionId: tokenHash(other) }, deps)).toBeNull()
    expect(await endOtherSessionsFromPanel({ userId: ids.magA!, organizationId: ORG_A, sessionId: 'nie-ma-takiej' }, deps)).toBeNull()
    expect(await resolveSession(sys, mine)).not.toBeNull()
    expect(await resolveSession(sys, other)).not.toBeNull()
    expect(await sys.auditLog.count({ where: { entity: 'User' } })).toBe(0)
  })
})
