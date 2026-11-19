// logowanie, sesje, role i dostęp panelu.
//  1. bez sesji nic: brak/zły/wygasły token = brak dostępu; każdy ekran zaczyna od requireSession (strażnik kodu);
//     proxy odsyła bez ciasteczka na /logowanie; rola aplikacji nie czyta kont ani sesji;
//  2. użytkownik firmy A nie widzi danych firmy B na żadnym ekranie (odczyty panelu przez klienta firmy z sesji);
//  3. logowanie: hasło, blokada po 5 próbach, konto bez firmy, przełącznik firmy tylko na własne firmy.
// Dane wyłącznie testowe (zmyślone produkty i zamówienia, adresy e-mail w domenie .test).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_ROLE } from '@/lib/db'
import {
  createUser,
  grantMembership,
  IDLE_MS,
  LOCK_MS,
  login,
  logout,
  MAX_FAILED,
  purgeExpiredSessions,
  resolveSession,
  revokeMembership,
  setPassword,
  switchOrganization,
  tokenHash,
} from '@/lib/auth/sesje'
import { attemptLogin, MSG_DOWN, MSG_INVALID, MSG_NO_ORG } from '@/lib/auth/logowanie'
import { SlidingLimiter } from '@/lib/auth/limiter'
import { applyOrgPreset } from '@/lib/organizacje'
import { ACME_PRESET } from '@/tests/preset-testowy'
import { orderListLines } from '@/lib/panel/lista-zamowien'
import { accounts, CARD_VIEWS, dashboard, grupaZAdresu, navCounts, orderDetail, ordersPage, productDetail, productsPage, shortagesData, type CardView } from '@/lib/panel/dane'
import { licznikiPanelu } from '@/lib/panel/zamowienia-lista'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { config as proxyConfig, proxy } from '@/proxy'
import { METODY_ZMIENIAJACE_STAN, WYJATKI_CSRF, wyjatekCsrf } from '@/lib/auth/csrf'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl } from './global-setup'
import { order, product, seedBase } from './rdzen-fixtures'

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
const PASS = 'haslo-testowe-0001'
const T = new Date('2026-10-25T10:00:00Z')

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  await createUser(sys, { email: 'Wlasciciel@Firma-A.test', name: 'Właściciel A', password: PASS })
  await grantMembership(sys, { email: 'wlasciciel@firma-a.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  await grantMembership(sys, { email: 'wlasciciel@firma-a.test', organizationId: ORG_B, role: 'BIURO' })
  await createUser(sys, { email: 'magazyn@firma-a.test', name: 'Magazyn A', password: PASS })
  await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_A, role: 'MAGAZYN' })
  await createUser(sys, { email: 'biuro@firma-b.test', name: 'Biuro B', password: PASS })
  await grantMembership(sys, { email: 'biuro@firma-b.test', organizationId: ORG_B, role: 'BIURO', permissions: ['zamowienia.anuluj_po_fakturze'] })
  await createUser(sys, { email: 'bez-firmy@x.test', name: 'Bez firmy', password: PASS })
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function tokenOf(email: string, now = T): Promise<string> {
  const r = await login(sys, email, PASS, { now })
  if (!r.ok) throw new Error(`logowanie ${email}: ${r.reason}`)
  return r.token
}

describe('logowanie i sesje', () => {
  it('poprawne logowanie: sesja w firmie, w bazie tylko skrót tokenu; e-mail bez znaczenia wielkości liter', async () => {
    const r = await login(sys, '  WLASCICIEL@firma-a.test ', PASS, { now: T, userAgent: 'test' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rows = await sys.session.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(tokenHash(r.token))
    expect(rows[0]!.id).not.toContain(r.token)
    const s = await resolveSession(sys, r.token, { now: T })
    expect(s?.user.email).toBe('wlasciciel@firma-a.test')
    expect(s?.organization.organizationId).toBe(ORG_A)
    expect(s?.permissions.has('uzytkownicy')).toBe(true)
    expect(s?.memberships.map((m) => m.organizationId).sort()).toEqual([ORG_A, ORG_B])
  })

  it('złe hasło i nieznany e-mail dają ten sam wynik; hasło nie trafia do bazy', async () => {
    expect(await login(sys, 'wlasciciel@firma-a.test', 'zle-haslo-000000', { now: T })).toEqual({ ok: false, reason: 'invalid' })
    expect(await login(sys, 'nie-ma@firma-a.test', PASS, { now: T })).toEqual({ ok: false, reason: 'invalid' })
    expect(await login(sys, 'to nie mail', PASS, { now: T })).toEqual({ ok: false, reason: 'invalid' })
    expect(await login(sys, 'wlasciciel@firma-a.test', '', { now: T })).toEqual({ ok: false, reason: 'invalid' })
    const u = await sys.user.findUniqueOrThrow({ where: { email: 'wlasciciel@firma-a.test' } })
    expect(u.passwordHash).not.toContain(PASS)
    expect(u.passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(await sys.session.count()).toBe(0)
  })

  it(`${MAX_FAILED} błędnych haseł blokuje konto na 15 min (także dobre hasło), po czasie logowanie wraca`, async () => {
    for (let i = 1; i < MAX_FAILED; i++) expect((await login(sys, 'magazyn@firma-a.test', 'zle-haslo-000000', { now: T })).ok).toBe(false)
    expect(await login(sys, 'magazyn@firma-a.test', 'zle-haslo-000000', { now: T })).toEqual({ ok: false, reason: 'locked' })
    expect(await login(sys, 'magazyn@firma-a.test', PASS, { now: new Date(T.getTime() + 60_000) })).toEqual({ ok: false, reason: 'locked' })
    const later = new Date(T.getTime() + LOCK_MS + 1000)
    expect((await login(sys, 'magazyn@firma-a.test', PASS, { now: later })).ok).toBe(true)
    const u = await sys.user.findUniqueOrThrow({ where: { email: 'magazyn@firma-a.test' } })
    expect(u.failedLogins).toBe(0)
  })

  it('konto bez żadnej firmy i konto wyłączone nie logują się', async () => {
    expect(await login(sys, 'bez-firmy@x.test', PASS, { now: T })).toEqual({ ok: false, reason: 'no_org' })
    await sys.user.update({ where: { email: 'magazyn@firma-a.test' }, data: { active: false } })
    expect(await login(sys, 'magazyn@firma-a.test', PASS, { now: T })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('bez sesji nic: brak, śmieciowy i zbyt długi token = null', async () => {
    expect(await resolveSession(sys, undefined)).toBeNull()
    expect(await resolveSession(sys, '')).toBeNull()
    expect(await resolveSession(sys, 'abc')).toBeNull()
    expect(await resolveSession(sys, 'x'.repeat(5000))).toBeNull()
    await tokenOf('wlasciciel@firma-a.test')
    const row = await sys.session.findFirstOrThrow()
    expect(await resolveSession(sys, row.id)).toBeNull() // skrót z bazy nie jest tokenem
  })

  it('sesja wygasa po 12 h bezczynności i po 7 dniach od logowania; wygasła znika z bazy', async () => {
    const t1 = await tokenOf('magazyn@firma-a.test')
    expect(await resolveSession(sys, t1, { now: new Date(T.getTime() + IDLE_MS - 60_000) })).not.toBeNull()
    expect(await resolveSession(sys, t1, { now: new Date(T.getTime() + 2 * IDLE_MS + 60_000) })).toBeNull()
    expect(await sys.session.count({ where: { id: tokenHash(t1) } })).toBe(0)
    // aktywna co godzinę, ale po 7 dniach koniec
    const t2 = await tokenOf('magazyn@firma-a.test')
    let now = T
    for (let h = 1; h < 7 * 24; h += 6) {
      now = new Date(T.getTime() + h * 3600_000)
      expect(await resolveSession(sys, t2, { now })).not.toBeNull()
    }
    expect(await resolveSession(sys, t2, { now: new Date(T.getTime() + 7 * 24 * 3600_000 + 1000) })).toBeNull()
  })

  it('wyłączenie konta i zmiana hasła kończą sesje; wylogowanie usuwa sesję', async () => {
    const t1 = await tokenOf('magazyn@firma-a.test')
    await sys.user.update({ where: { email: 'magazyn@firma-a.test' }, data: { active: false } })
    expect(await resolveSession(sys, t1, { now: T })).toBeNull()
    const t2 = await tokenOf('wlasciciel@firma-a.test')
    await setPassword(sys, 'wlasciciel@firma-a.test', 'nowe-haslo-0000000')
    expect(await resolveSession(sys, t2, { now: T })).toBeNull()
    expect((await login(sys, 'wlasciciel@firma-a.test', PASS, { now: T })).ok).toBe(false)
    const r = await login(sys, 'wlasciciel@firma-a.test', 'nowe-haslo-0000000', { now: T })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await logout(sys, r.token)
    expect(await resolveSession(sys, r.token, { now: T })).toBeNull()
  })

  it('przełącznik firmy: tylko na firmę, do której użytkownik należy; odebrany dostęp przenosi albo kończy sesję', async () => {
    const owner = await tokenOf('wlasciciel@firma-a.test')
    const mag = await tokenOf('magazyn@firma-a.test')
    expect(await switchOrganization(sys, mag, ORG_B, { now: T })).toBe(false)
    expect((await resolveSession(sys, mag, { now: T }))?.organization.organizationId).toBe(ORG_A)
    expect(await switchOrganization(sys, owner, ORG_B, { now: T })).toBe(true)
    const inB = await resolveSession(sys, owner, { now: T })
    expect(inB?.organization.organizationId).toBe(ORG_B)
    expect(inB?.permissions.has('uzytkownicy')).toBe(false) // w B jest biurem
    await revokeMembership(sys, 'wlasciciel@firma-a.test', ORG_B)
    expect((await resolveSession(sys, owner, { now: T }))?.organization.organizationId).toBe(ORG_A)
    await revokeMembership(sys, 'magazyn@firma-a.test', ORG_A)
    expect(await resolveSession(sys, mag, { now: T })).toBeNull()
    // firma wyłączona = brak dostępu do niej
    await sys.organization.update({ where: { id: ORG_A }, data: { active: false } })
    expect(await resolveSession(sys, owner, { now: T })).toBeNull()
  })

  it('12 równoległych błędnych prób blokuje konto; dobre hasło zaraz potem też „locked”', async () => {
    const res = await Promise.all(Array.from({ length: 12 }, () => login(sys, 'magazyn@firma-a.test', 'zle-haslo-000000', { now: T })))
    expect(res.some((r) => !r.ok && r.reason === 'locked')).toBe(true)
    const u = await sys.user.findUniqueOrThrow({ where: { email: 'magazyn@firma-a.test' } })
    expect(u.lockedUntil?.getTime()).toBeGreaterThan(T.getTime())
    expect(await login(sys, 'magazyn@firma-a.test', PASS, { now: new Date(T.getTime() + 1000) })).toEqual({ ok: false, reason: 'locked' })
    expect(await sys.session.count()).toBe(0)
  })

  it('formularz — limit prób per IP nie woła logowania; złe dane, blokada i limit dają ten sam komunikat', async () => {
    let calls = 0
    const spy: typeof login = async (...a) => {
      calls++
      return login(...a)
    }
    const limiter = new SlidingLimiter(3, 60_000)
    const base = { email: 'magazyn@firma-a.test', password: 'zle-haslo-000000', ip: '203.0.113.9' }
    for (let i = 0; i < 3; i++) expect(await attemptLogin(sys, base, { limiter, login: spy, now: T })).toEqual({ ok: false, message: MSG_INVALID })
    expect(await attemptLogin(sys, { ...base, password: PASS }, { limiter, login: spy, now: T })).toEqual({ ok: false, message: MSG_INVALID })
    expect(calls).toBe(3) // czwarta próba (nawet z dobrym hasłem) nie doszła do bazy ani do argon2
    // inne IP przechodzi; konto bez firmy ma własny komunikat
    const ok = await attemptLogin(sys, { ...base, password: PASS, ip: '198.51.100.1' }, { limiter, login: spy, now: T })
    expect(ok.ok).toBe(true)
    expect(await attemptLogin(sys, { email: 'bez-firmy@x.test', password: PASS, ip: '198.51.100.2' }, { limiter, now: T })).toEqual({ ok: false, message: MSG_NO_ORG })
    // blokada konta: ten sam komunikat co złe hasło (nie zdradza, że konto istnieje)
    await sys.user.update({ where: { email: 'magazyn@firma-a.test' }, data: { lockedUntil: new Date(T.getTime() + 60_000) } })
    expect(await attemptLogin(sys, { ...base, password: PASS, ip: '198.51.100.3' }, { limiter, now: T })).toEqual({ ok: false, message: MSG_INVALID })
    expect(await attemptLogin(sys, { ...base, email: 'nie-ma@firma-a.test', ip: '198.51.100.4' }, { limiter, now: T })).toEqual({ ok: false, message: MSG_INVALID })
    // awaria bazy: komunikat o awarii i wpis w logu bez hasła
    const logs: string[] = []
    const boom: typeof login = async () => {
      throw new Error('połączenie zerwane')
    }
    expect(await attemptLogin(sys, { ...base, ip: '198.51.100.5' }, { limiter, login: boom, log: (m) => logs.push(m) })).toEqual({ ok: false, message: MSG_DOWN })
    expect(logs).toEqual(['[logowanie] błąd: połączenie zerwane'])
    expect(logs.join()).not.toContain(base.password)
  })

  it('dostęp bez --uprawnienia nie zeruje dodatkowych uprawnień; podane zastępują', async () => {
    await grantMembership(sys, { email: 'biuro@firma-b.test', organizationId: ORG_B, role: 'BIURO' })
    const m1 = await sys.membership.findFirstOrThrow({ where: { organizationId: ORG_B, user: { email: 'biuro@firma-b.test' } } })
    expect(m1.permissions).toEqual(['zamowienia.anuluj_po_fakturze'])
    await grantMembership(sys, { email: 'biuro@firma-b.test', organizationId: ORG_B, role: 'BIURO', permissions: [] })
    const m2 = await sys.membership.findFirstOrThrow({ where: { organizationId: ORG_B, user: { email: 'biuro@firma-b.test' } } })
    expect(m2.permissions).toEqual([])
  })

  it('sprzątanie usuwa tylko wygasłe sesje', async () => {
    await tokenOf('magazyn@firma-a.test')
    await tokenOf('wlasciciel@firma-a.test', new Date(T.getTime() + 2 * IDLE_MS))
    expect(await purgeExpiredSessions(sys, new Date(T.getTime() + 2 * IDLE_MS + 1000))).toBe(1)
    expect(await sys.session.count()).toBe(1)
  })

  it(`rola ${APP_ROLE} nie czyta kont ani sesji; członków widzi tylko swojej firmy i nie może ich zmieniać`, async () => {
    await tokenOf('magazyn@firma-a.test')
    const c = new pg.Client({ connectionString: testAppDbUrl(), options: `-c app.org_id=${ORG_A}` })
    await c.connect()
    try {
      await expect(c.query('SELECT count(*) FROM "User"')).rejects.toThrow(/permission denied/)
      await expect(c.query('SELECT count(*) FROM "Session"')).rejects.toThrow(/permission denied/)
      const m = await c.query<{ org: string }>('SELECT DISTINCT "organizationId" AS org FROM "Membership"')
      expect(m.rows.map((r) => r.org)).toEqual([ORG_A])
      await expect(c.query(`UPDATE "Membership" SET role = 'WLASCICIEL'`)).rejects.toThrow(/permission denied/)
      await expect(c.query(`INSERT INTO "Membership" ("userId", role, "updatedAt") VALUES ('x', 'WLASCICIEL', now())`)).rejects.toThrow(/permission denied/)
    } finally {
      await c.end()
    }
    // także przez klienta Prismy firmy
    await expect(a.user.count()).rejects.toThrow()
    await expect(a.session.count()).rejects.toThrow()
  })
})

describe('panel: użytkownik firmy A nie widzi danych firmy B', () => {
  async function seedOrders() {
    const pa = await product(a, 'WSPOLNY', 5)
    await a.product.update({ where: { id: pa }, data: { title: 'Przyprawa firmy A' } })
    const pb = await product(b, 'WSPOLNY', 1)
    await b.product.update({ where: { id: pb }, data: { title: 'Kawa firmy B' } })
    const now = new Date()
    const oa = await ingestOrder(a, order([{ productId: pa, qty: 2 }], { createdAtChannel: now, totalGross: 40 }))
    // B: zamówienie na 3 szt. przy stanie 1 → brakuje 2
    const ob = await ingestOrder(b, order([{ productId: pb, qty: 3 }], { createdAtChannel: now, totalGross: 999 }))
    const ob2 = await ingestOrder(b, order([{ productId: pb, qty: 1 }], { createdAtChannel: now, paymentState: 'UNPAID', paymentMethod: 'przelew', totalGross: 11 }))
    return { pa, pb, oa: oa.orderId!, ob: ob.orderId!, ob2: ob2.orderId!, now }
  }

  /** Jak requireSession(): klient bazy wyłącznie z firmy sesji. Sesja zakładana zegarem rzeczywistym (resolveSession
   *  bez `now` liczy bezczynność od teraz — stała data T dawała wygasłą sesję po 12 h od T). */
  async function dbOfSession(token: string) {
    const s = await resolveSession(sys, token)
    if (!s) throw new Error('brak sesji')
    return testDb({ organizationId: s.organization.organizationId })
  }

  it('lista i szczegóły zamówień, produkty, braki, pulpit i liczniki menu: tylko dane firmy z sesji', async () => {
    const ids = await seedOrders()
    const db = await dbOfSession(await tokenOf('magazyn@firma-a.test', new Date()))
    try {
      const all = await ordersPage(db, { view: 'wszystkie' })
      expect(all.total).toBe(1)
      expect(all.rows.map((r) => r.id)).toEqual([ids.oa])
      expect((await orderListLines(db, [ids.oa])).get(ids.oa)![0]!.title).toBe('Przyprawa firmy A')
      expect(Object.values(all.counts).reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(7)
      expect(all.counts.wszystkie).toBe(1)
      expect((await ordersPage(db, { view: 'wszystkie', q: 'Kawa firmy B' })).total).toBe(0)
      expect((await ordersPage(db, { view: 'wszystkie', q: 'WSPOLNY' })).total).toBe(1)
      expect(await orderDetail(db, ids.ob)).toBeNull()
      expect((await orderDetail(db, ids.oa))?.products.get(ids.pa)?.title).toBe('Przyprawa firmy A')
      expect(await orderDetail(db, "x' OR 1=1 --")).toBeNull()

      const prods = await productsPage(db, { filter: 'wszystkie' })
      expect(prods.rows.map((r) => r.id)).toEqual([ids.pa])
      expect(prods.rows[0]).toMatchObject({ physical: 5, reserved: 2, available: 3 })
      expect((await productsPage(db, { filter: 'brak' })).total).toBe(0)
      expect(await productDetail(db, ids.pb)).toBeNull()

      const sh = await shortagesData(db)
      expect(sh.open).toHaveLength(0)
      const d = await dashboard(db, ids.now)
      expect(d.today.count).toBe(1)
      expect(d.today.gross).toBe(40)
      expect(d.work.shortageLines).toBe(0)
      expect(d.monthTotals.count).toBe(1)
      expect(await navCounts(db)).toEqual({ shortages: 0 })
      expect((await licznikiPanelu(db)).grupy.wymaga).toBe(0)
    } finally {
      await db.$disconnect()
    }

    // ta sama osoba po przełączeniu na B widzi B (i tylko B)
    const t = await tokenOf('wlasciciel@firma-a.test', new Date())
    expect(await switchOrganization(sys, t, ORG_B)).toBe(true)
    const dbB = await dbOfSession(t)
    try {
      const all = await ordersPage(dbB, { view: 'wszystkie' })
      expect(all.rows.map((r) => r.id).sort()).toEqual([ids.ob, ids.ob2].sort())
      expect(await orderDetail(dbB, ids.oa)).toBeNull()
      expect((await shortagesData(dbB)).open.length).toBeGreaterThan(0)
      expect((await productsPage(dbB, { filter: 'brak' })).rows.map((r) => r.id)).toEqual([ids.pb])
      const d = await dashboard(dbB, ids.now)
      expect(d.today.count).toBe(2)
      expect(d.today.gross).toBe(1010)
      expect((await ordersPage(dbB, { view: 'wymaga' })).rows.map((r) => r.id).sort()).toEqual([ids.ob, ids.ob2].sort())
    } finally {
      await dbB.$disconnect()
    }
  })

  it('lokalizacja z importu (Stock.location) i filtr „Bez lokalizacji” — tylko w obrębie firmy', async () => {
    const ids = await seedOrders()
    await a.stock.updateMany({ where: { productId: ids.pa }, data: { location: 'B-3-4' } })
    await b.stock.updateMany({ where: { productId: ids.pb }, data: { location: null } })
    const pa2 = await product(a, 'BEZ-MIEJSCA', 1)
    expect((await productsPage(a, { filter: 'wszystkie' })).rows.find((r) => r.id === ids.pa)?.location).toBe('B-3-4')
    expect((await productsPage(a, { filter: 'bez_lokalizacji' })).rows.map((r) => r.id)).toEqual([pa2])
    expect((await productsPage(b, { filter: 'bez_lokalizacji' })).rows.map((r) => r.id)).toEqual([ids.pb])
    expect((await orderDetail(a, ids.oa))?.products.get(ids.pa)?.location).toBe('B-3-4')
  })

  it('warianty na liście produktów — liczba w grupie i filtr ?grupa= (tylko w obrębie firmy)', async () => {
    const ids = await seedOrders()
    const v1 = await product(a, 'KUB-S', 1)
    const v2 = await product(a, 'KUB-M', 1)
    await a.product.updateMany({ where: { id: { in: [v1, v2] } }, data: { groupId: 'kubek' } })
    await b.product.updateMany({ where: { id: ids.pb }, data: { groupId: 'kubek' } })
    const rows = (await productsPage(a, { filter: 'wszystkie' })).rows
    expect(rows.find((r) => r.id === v1)).toMatchObject({ groupId: 'kubek', wariantow: 2 })
    expect(rows.find((r) => r.id === ids.pa)).toMatchObject({ groupId: null, wariantow: null })
    const grupa = await productsPage(a, { filter: 'wszystkie', grupa: 'kubek' })
    expect(grupa.rows.map((r) => r.id).sort()).toEqual([v1, v2].sort())
    expect(grupa.total).toBe(2)
    expect(grupaZAdresu('  kubek ')).toBe('kubek')
    expect(grupaZAdresu('')).toBeNull()
    expect(grupaZAdresu('x'.repeat(101))).toBeNull()
  })

  it('każdy kafelek pulpitu = liczba wierszy listy, do której prowadzi', async () => {
    const ids = await seedOrders()
    // dodatkowe stany: zbierane, do wyjaśnienia, nieudana faktura, brak „dośle później”
    await b.order.update({ where: { id: ids.ob }, data: { status: 'ZBIERANIE' } })
    await b.invoiceAttempt.create({ data: { orderId: ids.ob, packageNo: 1, attemptNo: 1, idExternal: `${ids.ob}/1/1`, state: 'FAILED' } })
    await b.shortage.updateMany({ where: { orderId: ids.ob }, data: { state: 'SHIP_LATER' } })
    await b.order.update({ where: { id: ids.ob2 }, data: { paymentState: 'PARTIAL' } })
    for (const db of [a, b]) {
      const d = await dashboard(db, ids.now)
      const cards: Record<CardView, number> = { do_spakowania: d.work.toPack, do_wyjasnienia: d.work.clarify, nieoplacone: d.work.unpaid, blad_faktury: d.work.invoiceFailed }
      for (const v of Object.keys(CARD_VIEWS) as CardView[]) expect((await ordersPage(db, { view: v })).total, v).toBe(cards[v])
      const sh = await shortagesData(db)
      expect(sh.open.length).toBe(d.work.shortageLines)
      expect((await navCounts(db)).shortages).toBe(d.work.shortageLines)
      expect(sh.manual.length + sh.overcommit.length).toBe(d.work.wfirmaFix + d.work.overcommit)
    }
    const dB = await dashboard(b, ids.now)
    expect(dB.work).toMatchObject({ toPack: 1, unpaid: 1, invoiceFailed: 1 })
    expect(dB.work.shortageLines).toBeGreaterThan(0)
  })

  it('konta kanałów zawsze czytelną nazwą, nigdy surowym id z BaseLinkera', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { name: 'sd' } })
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { name: '71045' } })
    await a.channelConfig.updateMany({
      where: { channel: 'WOO', channelAccountId: 'lampy' },
      data: { name: 'shop_7100002', config: { baseUrl: 'https://www.hurtdemo.pl' } },
    })
    await a.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'km' }, data: { name: 'KolorowyKubek' } })
    const names = (await accounts(a)).map((x) => x.name)
    expect(names).toContain('Allegro')
    expect(names).toContain('KolorowyKubek')
    // dwa sklepy bez nazwy: ten z adresem w konfiguracji pokazuje domenę, drugi „Sklep bez nazwy”
    expect(names).toContain('hurtdemo.pl')
    expect(names.filter((n) => n === 'Sklep bez nazwy')).toHaveLength(1)
    const rawId = /\d{4,}|^sd$|shop_/
    expect(rawId.test('7100001') && rawId.test('shop_7100002') && rawId.test('sd')).toBe(true) // asercja naprawdę łapie id
    expect(names.filter((n) => rawId.test(n))).toEqual([])
    // zamówienie z konta bez konfiguracji (np. EasyTools): pulpit pokazuje rodzaj kanału, nie id
    const p = await product(a, 'N1', 5)
    await ingestOrder(a, order([{ productId: p, qty: 1 }], { channel: 'EASYTOOLS', createdAtChannel: new Date() }))
    const d = await dashboard(a)
    expect(d.today.perAccount.map((x) => x.name)).toContain('EasyTools')
    expect(d.today.perAccount.filter((x) => /^et$|EASYTOOLS/.test(x.name))).toEqual([])
  })

  it('odczyty panelu odmawiają klienta systemowego (przez wszystkie firmy)', async () => {
    await expect(ordersPage(sys, { view: 'wszystkie' })).rejects.toThrow(/klienta firmy/)
    await expect(dashboard(sys)).rejects.toThrow(/klienta firmy/)
    await expect(productsPage(sys, { filter: 'wszystkie' })).rejects.toThrow(/klienta firmy/)
    await expect(shortagesData(sys)).rejects.toThrow(/klienta firmy/)
  })
})

describe('strażnik: bez sesji nic nie jest dostępne', () => {
  afterEach(() => vi.unstubAllEnvs())
  const ROOT = path.resolve(__dirname, '..')
  const walk = (dir: string, out: string[] = []) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) walk(p, out)
      else out.push(path.relative(ROOT, p).replace(/\\/g, '/'))
    }
    return out
  }
  const appFiles = walk(path.join(ROOT, 'app'))

  it('każdy ekran i layout panelu zaczyna od requireSession/requirePermission i nie bierze klienta bazy sam', () => {
    const screens = appFiles.filter((f) => /^app\/\(panel\)\/.*(page|layout)\.tsx$/.test(f))
    expect(screens.length).toBeGreaterThanOrEqual(8)
    // layout przez requireLayoutSession (ta sama sesja i podgląd, bez przekierowania hasła startowego)
    const bad = screens.filter((f) => {
      const src = readFileSync(path.join(ROOT, f), 'utf8')
      const bramka = /layout\.tsx$/.test(f) ? /\brequireLayoutSession\(/ : /\b(requireSession|requirePermission)\(\)?/
      return !bramka.test(src) || /@\/lib\/db|createOrgClient|prismaForOrg|systemPrisma/.test(src)
    })
    expect(bad).toEqual([])
  })

  it('requireLayoutSession i requireLogin tylko w layoutach — strona ani akcja serwera nie omija przekierowania hasła startowego', () => {
    const pliki = appFiles.filter((f) => /\.(tsx?|ts)$/.test(f) && !/layout\.tsx$/.test(f) && !/\.test\.tsx?$/.test(f))
    const bad = pliki.filter((f) => /\b(requireLayoutSession|requireLogin)\(/.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(bad).toEqual([])
  })

  it('poza logowaniem i /api/health nie ma tras bez sesji (route handlers też przez requireSession)', () => {
    // trasy /api/v1 mają własną bramkę (klucz API), trasy /api/druk (token stanowiska),
    // /api/mcp (klucz API agenta w lib/mcp/http.ts) — osobne testy niżej
    // /api/kanaly/woo/klucze (POST serwera sklepu WooCommerce, podpisany jednorazowy user_id) — test niżej
    const routes = appFiles.filter(
      (f) =>
        /route\.ts$/.test(f) &&
        f !== 'app/api/health/route.ts' &&
        f !== 'app/api/mcp/route.ts' &&
        f !== 'app/api/kanaly/woo/klucze/route.ts' &&
        !f.startsWith('app/api/v1/') &&
        !f.startsWith('app/api/druk/'),
    )
    const bad = routes.filter((f) => !/requireSession|requirePermission/.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(bad).toEqual([])
    const pages = appFiles.filter((f) => /page\.tsx$/.test(f) && !f.startsWith('app/(panel)/'))
    // /zaproszenie publiczne z założenia (proxy.ts), GET niczego nie przyjmuje
    // /nie-pamietam-hasla i /nowe-haslo publiczne z założenia (reset hasła mailem, proxy.ts), GET niczego nie zmienia
    expect(pages.sort()).toEqual(['app/(stanowisko)/stanowisko/page.tsx', 'app/logowanie/page.tsx', 'app/nie-pamietam-hasla/page.tsx', 'app/nowe-haslo/page.tsx', 'app/page.tsx', 'app/start/page.tsx', 'app/zaproszenie/page.tsx'])
  })

  it('jedyna trasa /api/kanaly bez sesji to klucze ze sklepu Woo; bramką jest przyjmijKluczeWoo (podpis przed bazą)', () => {
    const routes = appFiles.filter((f) => f.startsWith('app/api/kanaly/') && /route\.ts$/.test(f))
    expect(routes).toEqual(['app/api/kanaly/woo/klucze/route.ts'])
    const src = readFileSync(path.join(ROOT, routes[0]!), 'utf8')
    // tylko POST (i GET z odmową), klient bazy wyłącznie przez fabrykę podaną bramce (firma z podpisanego user_id)
    expect([...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]).sort()).toEqual(['GET', 'POST'])
    expect(src).toMatch(/przyjmijKluczeWoo\(body, \{ env: process\.env, db: prismaForOrg \}\)/)
    expect(src).not.toMatch(/systemPrisma|createSystemClient|createOrgClient|console\./)
  })

  it('każda trasa /api/v1 zaczyna od requireApiKey i nie bierze klienta bazy sama', () => {
    const routes = appFiles.filter((f) => f.startsWith('app/api/v1/') && /route\.ts$/.test(f))
    expect(routes.sort()).toEqual([
      'app/api/v1/automaty/route.ts', // odczyt automatycznych akcji
      'app/api/v1/obsluga/zamowienia-klienta/route.ts', // obsługa klienta: zamówienia po e-mailu albo telefonie
      'app/api/v1/obsluga/zamowienie/route.ts', // obsługa klienta: zamówienie po numerze z kontaktem
      'app/api/v1/produkty/[sku]/route.ts',
      'app/api/v1/produkty/route.ts',
      'app/api/v1/raporty/braki/route.ts',
      'app/api/v1/raporty/dzien/route.ts',
      'app/api/v1/raporty/rezerwacje/route.ts',
      'app/api/v1/raporty/sprzedaz/route.ts',
      'app/api/v1/stany/route.ts',
      'app/api/v1/statusy/route.ts',
      'app/api/v1/zamowienia/[numer]/route.ts',
      'app/api/v1/zamowienia/route.ts',
    ])
    const bad: string[] = []
    for (const f of routes) {
      const src = readFileSync(path.join(ROOT, f), 'utf8')
      if (/@\/lib\/db|createOrgClient|prismaForOrg|systemPrisma/.test(src)) bad.push(`${f}: sam bierze klienta bazy`)
      // każdy eksportowany handler: pierwsza instrukcja to requireApiKey(req, <zakres>)
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)[^{]*\{\s*\n\s*([^\n]*)/g)]
      if (!handlers.length) bad.push(`${f}: brak handlera`)
      for (const [, name, first] of handlers) if (!/^const ctx = await requireApiKey\(req, '[a-z]+:[a-z]+'\)/.test(first ?? '')) bad.push(`${f}: ${name}`)
    }
    expect(bad).toEqual([])
    // inne pliki w app/api/v1 (poza route.ts) nie mogą obejść bramki
    expect(appFiles.filter((f) => f.startsWith('app/api/v1/') && !/route\.ts$/.test(f))).toEqual([])
  })

  it('/api/mcp tylko przekazuje żądanie do handleMcpHttp (klucz API agenta), bez sesji i bez własnego klienta bazy', () => {
    const routes = appFiles.filter((f) => f.startsWith('app/api/mcp/'))
    expect(routes).toEqual(['app/api/mcp/route.ts'])
    const src = readFileSync(path.join(ROOT, 'app/api/mcp/route.ts'), 'utf8')
    expect(src).not.toMatch(/@\/lib\/db|createOrgClient|prismaForOrg|systemPrisma|requireSession/)
    expect(src).toMatch(/export async function POST\(req: Request\)[^{]*\{\s*\n\s*return handleMcpHttp\(req\)/)
    // GET/DELETE niczego nie czytają
    for (const m of ['GET', 'DELETE']) expect(src).toMatch(new RegExp(`export async function ${m}\\(\\)[^{]*\\{\\s*\\n\\s*return methodNotAllowed\\(\\)`))
    // handleMcpHttp: klient bazy wyłącznie z authenticateApiKey (firma klucza, RLS), nigdy z argumentów ani nagłówków
    const http = readFileSync(path.join(ROOT, 'lib/mcp/http.ts'), 'utf8')
    expect(http).toMatch(/await authenticateApiKey\(req/)
    expect(http).not.toMatch(/@\/lib\/db|createOrgClient|prismaForOrg|systemPrisma/)
  })

  it('każda trasa /api/druk zaczyna od tokenu stanowiska, bez sesji panelu i bez własnego klienta bazy', () => {
    const routes = appFiles.filter((f) => f.startsWith('app/api/druk/') && /route\.ts$/.test(f))
    expect(routes.sort()).toEqual(['app/api/druk/pliki/[id]/route.ts', 'app/api/druk/stan/route.ts', 'app/api/druk/zlecenia/[id]/wynik/route.ts', 'app/api/druk/zlecenia/route.ts'])
    const bad = routes.filter((f) => {
      const src = readFileSync(path.join(ROOT, f), 'utf8')
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)[^{]*\{\s*\n\s*([^\n]*)/g)]
      return !handlers.length || handlers.some(([, , first]) => !/^const ctx = await requireStationToken\(req\)/.test(first ?? '')) || /@\/lib\/db|createOrgClient|prismaForOrg|systemPrisma|requireSession/.test(src)
    })
    expect(bad).toEqual([])
    // trasy panelu dla druku są pod /api/wydruki (sesja), nie pod /api/druk
    expect(appFiles.filter((f) => f.startsWith('app/api/wydruki/') && /route\.ts$/.test(f)).every((f) => /requirePermissionApi\(/.test(readFileSync(path.join(ROOT, f), 'utf8')))).toBe(true)
  })

  it('ekran i layout stanowiska pakowania zaczynają od requireSession/requirePermission, bez własnego klienta bazy', () => {
    const screens = appFiles.filter((f) => /^app\/\(stanowisko\)\/.*(page|layout)\.tsx$/.test(f))
    expect(screens.sort()).toEqual(['app/(stanowisko)/layout.tsx', 'app/(stanowisko)/stanowisko/page.tsx'])
    const bad = screens.filter((f) => {
      const src = readFileSync(path.join(ROOT, f), 'utf8')
      const bramka = /layout\.tsx$/.test(f) ? /\brequireLayoutSession\(/ : /\b(requireSession|requirePermission)\(/
      return !bramka.test(src) || /@\/lib\/db|createOrgClient|prismaForOrg|systemPrisma/.test(src)
    })
    expect(bad).toEqual([])
  })

  it('każda akcja serwera (poza logowaniem) zaczyna od requireSession/requirePermission', () => {
    // app/start/akcje.ts: kreator pierwszego uruchomienia, z definicji bez sesji (bramka: kod instalacji)
    const files = appFiles.filter((f) => /\.tsx?$/.test(f) && f !== 'app/akcje.ts' && f !== 'app/start/akcje.ts' && /^\s*(\/\/.*\n\s*)*['"]use server['"]/.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(files).toContain('app/(stanowisko)/stanowisko/akcje.ts')
    expect(files).toContain('app/(panel)/rozjazdy/akcje.ts')
    // „Przyjechał”, godziny odbiorów, strefa produktu
    expect(files).toContain('app/(panel)/pakowanie/akcje.ts')
    expect(files).toContain('app/(panel)/ustawienia/przewoznicy/akcje.ts')
    expect(files).toContain('app/(panel)/produkty/[id]/akcje.ts')
    const bad: string[] = []
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, f), 'utf8')
      const actions = [...src.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\s*\n\s*([^\n]*)/g)]
      if (!actions.length) bad.push(`${f}: brak akcji`)
      if (/@\/lib\/db|createOrgClient|prismaForOrg|systemPrisma/.test(src)) bad.push(`${f}: sam bierze klienta bazy`)
      for (const [, name, first] of actions) {
        if (!/^const ctx = await (requireSession|requirePermission)\(/.test(first ?? '')) bad.push(`${f}: ${name}`)
      }
      if (/export (const|function) /.test(src.replace(/export async function/g, ''))) bad.push(`${f}: eksport poza akcją async`)
    }
    expect(bad).toEqual([])
  })

  // CSRF jedną regułą w proxy.ts (lib/auth/csrf.ts). Każda trasa zmieniająca stan przechodzi przez regułę
  // albo jest na jawnej liście wyjątków; wyjątek tylko dla trasy bez ciasteczka sesji (klucz, token, podpis).
  // Plik app/… → adres: bez grup „(x)”, segment [id] → „id-1”, bez /route.ts albo /page.tsx.
  const adresPliku = (f: string) =>
    f
      .replace(/^app/, '')
      .replace(/\/\([^/]+\)/g, '')
      .replace(/\[(?:\.\.\.)?([^\]]+)\]/g, '$1-1')
      .replace(/\/(route\.ts|page\.tsx)$/, '') || '/'
  const proxyReq = (url: string, method: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(`http://localhost:55437${url}`, { method, headers }))

  it('każda trasa POST/PUT/PATCH/DELETE przechodzi przez regułę CSRF albo jest na liście wyjątków (bez sesji)', () => {
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    // proxy obejmuje wszystko poza plikami statycznymi Next (trasy /api i akcje serwera na adresach ekranów)
    expect(proxyConfig.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)'])
    const trasy = appFiles
      .filter((f) => /route\.ts$/.test(f))
      .map((f) => {
        const src = readFileSync(path.join(ROOT, f), 'utf8')
        const metody = [...src.matchAll(/export (?:async )?(?:function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!)
        return { f, src, mut: metody.filter((m) => METODY_ZMIENIAJACE_STAN.has(m)) }
      })
      .filter((t) => t.mut.length > 0)
    expect(trasy.length).toBeGreaterThanOrEqual(5)
    // lista tras z wyjątkiem — dopisanie trasy tutaj = świadoma decyzja z uzasadnieniem w lib/auth/csrf.ts
    expect(trasy.filter((t) => wyjatekCsrf(adresPliku(t.f))).map((t) => t.f).sort()).toEqual([
      'app/api/druk/stan/route.ts',
      'app/api/druk/zlecenia/[id]/wynik/route.ts',
      'app/api/kanaly/woo/klucze/route.ts',
      'app/api/mcp/route.ts',
      'app/api/v1/obsluga/zamowienia-klienta/route.ts',
      'app/api/v1/obsluga/zamowienie/route.ts',
      'app/api/v1/zamowienia/route.ts',
    ])
    const bad: string[] = []
    for (const t of trasy) {
      const url = adresPliku(t.f)
      if (wyjatekCsrf(url)) {
        // wyjątek nie może czytać ciasteczka sesji (wtedy CSRF wraca) i musi być publiczny w proxy (bez ciasteczka)
        if (/requireSession|requirePermission|SESSION_COOKIE|cookies\(/.test(t.src)) bad.push(`${t.f}: wyjątek CSRF z sesją panelu`)
        if (proxyReq(url, t.mut[0]!).headers.get('x-middleware-next') !== '1') bad.push(`${t.f}: wyjątek nie przechodzi bez ciasteczka`)
        continue
      }
      for (const m of t.mut) {
        const sesja = { cookie: 'kompletor_sesja=cos' }
        const obca = proxyReq(url, m, { ...sesja, 'sec-fetch-site': 'cross-site', origin: 'https://zly.test' })
        if (obca.status !== 403) bad.push(`${t.f} ${m}: obca strona dostała ${obca.status}`)
        const brak = proxyReq(url, m, sesja)
        if (brak.status !== 403) bad.push(`${t.f} ${m}: bez nagłówków przeglądarki ${brak.status}`)
        const panel = proxyReq(url, m, { ...sesja, 'sec-fetch-site': 'same-origin' })
        if (panel.headers.get('x-middleware-next') !== '1') bad.push(`${t.f} ${m}: z panelu nie przechodzi (${panel.status})`)
      }
    }
    expect(bad).toEqual([])
    // każdy wyjątek obejmuje istniejącą trasę (martwy wyjątek = do usunięcia z listy)
    const adresy = appFiles.filter((f) => /route\.ts$/.test(f)).map(adresPliku)
    for (const w of WYJATKI_CSRF) expect(adresy.some((u) => w.wzor.test(u)), w.trasy).toBe(true)
  })

  it('akcje serwera — POST na adres każdego ekranu z obcej strony = 403, z panelu przechodzi', () => {
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    const ekrany = appFiles.filter((f) => /page\.tsx$/.test(f)).map(adresPliku)
    expect(ekrany.length).toBeGreaterThanOrEqual(10)
    const akcja = { cookie: 'kompletor_sesja=cos', 'next-action': 'a'.repeat(42) }
    const bad: string[] = []
    for (const u of ekrany) {
      if (wyjatekCsrf(u)) bad.push(`${u}: ekran na liście wyjątków`)
      if (proxyReq(u, 'POST', { ...akcja, origin: 'https://zly.test' }).status !== 403) bad.push(`${u}: obcy Origin`)
      if (proxyReq(u, 'POST', { ...akcja, 'sec-fetch-site': 'cross-site' }).status !== 403) bad.push(`${u}: cross-site`)
      if (proxyReq(u, 'POST', { ...akcja, 'sec-fetch-site': 'same-origin', origin: 'http://localhost:55437' }).headers.get('x-middleware-next') !== '1') bad.push(`${u}: z panelu`)
    }
    expect(bad).toEqual([])
  })

  it('proxy: bez ciasteczka sesji ekrany → /logowanie, API → 401; logowanie i health przepuszcza', () => {
    // test sesji panelu niezależny od BASIC_AUTH_* z lokalnego .env (jak proxy.test.ts)
    vi.stubEnv('BASIC_AUTH_USER', '')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    const go = (p: string, cookie?: string) => proxy(new NextRequest(`http://localhost:55437${p}`, cookie ? { headers: { cookie } } : undefined))
    for (const p of ['/', '/pulpit', '/zamowienia', '/zamowienia/abc', '/produkty', '/braki', '/rozjazdy', '/akcje', '/pakowanie', '/ustawienia', '/ustawienia/przewoznicy', '/ustawienia/przewoznicy/konta', '/ustawienia/strefy', '/ustawienia/rezerwacje', '/stanowisko', '/stanowisko?z=abc', '/przesylki']) {
      const r = go(p)
      expect(r.status, p).toBe(307)
      expect(new URL(r.headers.get('location')!).pathname).toBe('/logowanie')
    }
    expect(go('/api/cokolwiek').status).toBe(401)
    expect(go('/api/wydruki/karty?z=abc').status).toBe(401)
    expect(go('/api/wydruki/lista-wysylkowa?z=abc').status).toBe(401)
    expect(go('/api/przesylki/etykiety?z=abc').status).toBe(401)
    expect(go('/api/przesylki/protokol?z=abc').status).toBe(401)
    expect(go('/logowanie').headers.get('x-middleware-next')).toBe('1')
    expect(go('/api/health').headers.get('x-middleware-next')).toBe('1')
    expect(go('/pulpit', 'kompletor_sesja=cos').headers.get('x-middleware-next')).toBe('1') // dalej sprawdza requireSession
  })
})
