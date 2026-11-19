// Ustawienia → Zasady rezerwacji.
//  1. zapis z panelu idzie przez updatePolicy: wartości w bazie, wpis w AuditLog z id zalogowanej osoby, historia
//     na ekranie czytelnie (kto, co); niepoprawna wartość = komunikat po polsku, wpisane wartości zostają, bez zapisu;
//  2. izolacja dwóch firm (RLS): zapis w A nie zmienia B, historia i bufory tylko własnej firmy;
//  3. dostęp: rola bez `ustawienia` dostaje 404 (akcja i ekran), /ustawienia z `ustawienia` albo `uzytkownicy`;
//  4. przełączenie sezonu nie zmienia terminów istniejących zamówień, nowe dostają terminy sezonowe.
// Dane wyłącznie testowe (zmyślone produkty, numery zamówień i adresy e-mail w domenie .test).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { createUser, grantMembership, login } from '@/lib/auth/sesje'
import { parsePolicyForm, type PolicyFormState } from '@/lib/panel/ustawienia-rezerwacji-opis'
import { reservationSettings } from '@/lib/panel/ustawienia-rezerwacji'
import { DEFAULT_POLICY, getPolicy, savePolicy, updatePolicy } from '@/lib/rdzen/polityka'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { order, product, seedBase, T0 } from './rdzen-fixtures'
import { zbudujMenu } from '@/lib/panel/nawigacja'

// Akcja i ekrany biorą sesję z ciasteczka (next/headers) i klientów z lib/db — ciasteczko podstawiamy, a klienci
// łączą się z bazą testów (zmienne ustawione przed pierwszym użyciem). revalidatePath poza Next — atrapa.
let ciasteczko: string | undefined
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (_n: string) => (ciasteczko ? { value: ciasteczko } : undefined) }),
  headers: async () => new Headers(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const { zapiszZasady } = await import('@/app/(panel)/ustawienia/rezerwacje/akcje')
const { default: ZasadyRezerwacji } = await import('@/app/(panel)/ustawienia/rezerwacje/page')
const { wejsciaUstawien } = await import('./ustawienia-wejscia')
const { default: Ustawienia } = await import('@/app/(panel)/ustawienia/page')
const { default: DzialUstawien } = await import('@/app/(panel)/ustawienia/dzial/[dzial]/page')

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
const PASS = 'haslo-testowe-0001'

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  await createUser(sys, { email: 'wlasciciel@firma-a.test', name: 'Właściciel Testowy A', password: PASS })
  await grantMembership(sys, { email: 'wlasciciel@firma-a.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  await createUser(sys, { email: 'magazyn@firma-a.test', name: 'Magazyn Testowy A', password: PASS })
  await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_A, role: 'MAGAZYN' })
  await createUser(sys, { email: 'kadry@firma-a.test', name: 'Kadry Testowe A', password: PASS })
  await grantMembership(sys, { email: 'kadry@firma-a.test', organizationId: ORG_A, role: 'BIURO', permissions: ['uzytkownicy'] })
  await createUser(sys, { email: 'wlasciciel@firma-b.test', name: 'Właściciel Testowy B', password: PASS })
  await grantMembership(sys, { email: 'wlasciciel@firma-b.test', organizationId: ORG_B, role: 'WLASCICIEL' })
  ciasteczko = undefined
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

/** Logowanie zegarem rzeczywistym (resolveSession w requireSession liczy bezczynność od teraz). */
async function jako(email: string): Promise<string> {
  const r = await login(sys, email, PASS)
  if (!r.ok) throw new Error(`logowanie ${email}: ${r.reason}`)
  ciasteczko = r.token
  return (await sys.user.findUniqueOrThrow({ where: { email } })).id
}

const POLA = {
  normalReminderBusinessDays: '2',
  normalReleaseBusinessDays: '5',
  seasonReminderBusinessDays: '1',
  seasonReleaseBusinessDays: '3',
  allOutOfStockWaitBusinessDays: '3',
  failedOnlinePaymentHoldHours: '2',
  failedOnlinePaymentReminderDays: '1',
}
function formularz(over: Partial<Record<keyof typeof POLA | 'seasonMode' | 'wersja', string>> = {}): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries({ ...POLA, ...over })) if (v !== undefined) f.set(k, v)
  return f
}
const START: PolicyFormState = { values: parsePolicyForm(formularz()).values, current: DEFAULT_POLICY, version: '', error: null, field: null, savedAt: null }

/** notFound() z next/navigation rzuca błąd z digest „NEXT_HTTP_ERROR_FALLBACK;404”. */
async function expect404(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/) })
}
const html = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el)

describe('zapis zasad z panelu', () => {
  it('zapis przez updatePolicy: wartości w bazie, AuditLog z id osoby, historia czytelnie', async () => {
    const userId = await jako('wlasciciel@firma-a.test')
    const r = await zapiszZasady(START, formularz({ seasonMode: 'tak', seasonReleaseBusinessDays: '4', normalReminderBusinessDays: '1' }))
    expect(r.error).toBeNull()
    expect(r.savedAt).not.toBeNull()
    expect(r.current).toEqual({ ...DEFAULT_POLICY, seasonMode: true, seasonReleaseBusinessDays: 4, normalReminderBusinessDays: 1 })
    expect(await getPolicy(a)).toMatchObject({ seasonMode: true, seasonReleaseBusinessDays: 4, normalReminderBusinessDays: 1 })

    const logs = await a.auditLog.findMany({ where: { entity: 'ReservationPolicy' } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ actorId: userId, entityId: ORG_A, before: DEFAULT_POLICY })
    expect(logs[0]!.after).toMatchObject({ seasonMode: true, seasonReleaseBusinessDays: 4 })

    const s = await reservationSettings(a)
    expect(s.history).toHaveLength(1)
    expect(s.history[0]!.who).toBe('Właściciel Testowy A')
    expect(s.history[0]!.changes).toEqual([
      { label: 'Tryb sezonowy', from: 'wyłączony', to: 'włączony' },
      { label: 'Tryb normalny, przypomnienie', from: '2 dni robocze', to: '1 dzień roboczy' },
      { label: 'Tryb sezonowy, zwolnienie rezerwacji', from: '3 dni robocze', to: '4 dni robocze' },
    ])

    // ekran: aktualny stan, przykład słowami, historia bez surowego JSON-a, bufor tylko do podglądu
    const page = await html(ZasadyRezerwacji())
    expect(page).toContain('teraz obowiązuje: tryb sezonowy')
    expect(page).toContain('zamówień, które system przyjmie po zapisaniu zmiany')
    expect(page).toContain('nieopłacone: przypomnienie po 1 dniu roboczym, zwolnienie rezerwacji po 5 dniach roboczych')
    expect(page).toContain('Tryb sezonowy, zwolnienie rezerwacji: 3 dni robocze → <b>4 dni robocze</b>')
    expect(page).not.toMatch(/seasonReleaseBusinessDays&quot;|\{&quot;/)
    expect(page).toContain('Bufor bezpieczeństwa')
    expect(page).toContain('w tej wersji bufora nie zmienia się z panelu')
  })

  it('niepoprawna wartość: komunikat po polsku, wpisane wartości zostają, bez zapisu i bez AuditLog', async () => {
    await jako('wlasciciel@firma-a.test')
    const cases: [Record<string, string>, RegExp][] = [
      [{ seasonReleaseBusinessDays: '31' }, /^Tryb sezonowy, zwolnienie rezerwacji: wpisz liczbę całkowitą dni roboczych od 0 do 30\.$/],
      [{ normalReminderBusinessDays: '' }, /^Tryb normalny, przypomnienie: wpisz liczbę/],
      [{ allOutOfStockWaitBusinessDays: 'trzy' }, /^„Brakuje wszystkiego”, oczekiwanie: wpisz liczbę/],
      [{ normalReleaseBusinessDays: '-1' }, /^Tryb normalny, zwolnienie rezerwacji: wpisz liczbę/],
      [{ seasonReminderBusinessDays: '2,5' }, /^Tryb sezonowy, przypomnienie: wpisz liczbę/],
      [{ normalReminderBusinessDays: '6', normalReleaseBusinessDays: '5' }, /^Przypomnienie nie może być później niż zwolnienie rezerwacji/],
    ]
    for (const [over, msg] of cases) {
      const r = await zapiszZasady(START, formularz({ seasonMode: 'tak', ...over }))
      expect(r.error, JSON.stringify(over)).toMatch(msg)
      expect(r.savedAt).toBeNull()
      expect(r.values).toMatchObject({ ...POLA, ...over, seasonMode: true })
      expect(r.current).toEqual(DEFAULT_POLICY) // „obowiązuje teraz” bez zmian
    }
    expect(await getPolicy(a)).toMatchObject(DEFAULT_POLICY)
    expect(await a.auditLog.count()).toBe(0)
  })

  it('zapis bez zmian: bez wpisu w historii, baner zostaje, wersja wiersza bez zmian', async () => {
    await jako('wlasciciel@firma-a.test')
    const ekran = await reservationSettings(a)
    const r = await zapiszZasady(START, formularz({ wersja: ekran.version }))
    expect(r.error).toBeNull()
    expect(r.savedAt).not.toBeNull()
    expect(await a.auditLog.count()).toBe(0)
    expect(r.version).toBe(ekran.version)

    const saved = await zapiszZasady(r, formularz({ wersja: r.version, seasonMode: 'tak' }))
    expect(saved.error).toBeNull()
    const again = await zapiszZasady(saved, formularz({ wersja: saved.version, seasonMode: 'tak' }))
    expect(again.error).toBeNull()
    expect(again.version).toBe(saved.version)
    expect(await a.auditLog.count()).toBe(1)
  })

  it('dwie osoby naraz: drugi zapis ze starego ekranu odmawia i niczego nie cofa', async () => {
    await jako('wlasciciel@firma-a.test')
    const ekran = await reservationSettings(a)
    const pierwszy = await zapiszZasady(START, formularz({ wersja: ekran.version, seasonMode: 'tak' }))
    expect(pierwszy.error).toBeNull()
    expect(pierwszy.version).not.toBe('')

    // drugi ekran otwarty przed zapisem pierwszego: sezon jeszcze wyłączony, zmienia inne pole
    const stary = await zapiszZasady(START, formularz({ wersja: ekran.version, normalReleaseBusinessDays: '7' }))
    expect(stary.error).toBe('Ktoś zapisał zasady w międzyczasie. Odśwież ekran i wpisz zmiany jeszcze raz.')
    expect(stary.savedAt).toBeNull()
    expect(stary.values.normalReleaseBusinessDays).toBe('7') // wpisane zostaje
    expect(stary.current.seasonMode).toBe(true) // „obowiązuje teraz” z bazy
    expect(await getPolicy(a)).toMatchObject({ seasonMode: true, normalReleaseBusinessDays: 5 })
    // ponowne kliknięcie bez odświeżenia też odmawia
    expect((await zapiszZasady(stary, formularz({ wersja: stary.version, normalReleaseBusinessDays: '7' }))).error).toMatch(/^Ktoś zapisał/)
    expect(await a.auditLog.count()).toBe(1)

    // ten sam scenariusz, gdy wiersz już jest (wersja = updatedAt)
    const trzeci = await zapiszZasady(pierwszy, formularz({ wersja: pierwszy.version, seasonMode: 'tak', normalReleaseBusinessDays: '6' }))
    expect(trzeci.error).toBeNull()
    expect((await zapiszZasady(pierwszy, formularz({ wersja: pierwszy.version, seasonMode: 'tak', normalReleaseBusinessDays: '8' }))).error).toMatch(/^Ktoś zapisał/)
    expect(await getPolicy(a)).toMatchObject({ normalReleaseBusinessDays: 6 })
  })

  it('dwa równoległe zapisy tej samej wersji: przechodzi jeden, jeden wpis w historii', async () => {
    const { version } = await savePolicy(a, { normalReleaseBusinessDays: 6 }, 'test')
    const r = await Promise.allSettled([
      savePolicy(a, { normalReleaseBusinessDays: 7 }, 'test', version),
      savePolicy(a, { normalReleaseBusinessDays: 8 }, 'test', version),
    ])
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(await a.auditLog.count()).toBe(2)
  })

  it('historia: ostatnie 10 zapisów, najnowszy pierwszy; identyfikatory techniczne jako „system”', async () => {
    await updatePolicy(a, { normalReleaseBusinessDays: 6 }, 'worker-test')
    await jako('wlasciciel@firma-a.test')
    for (let i = 7; i <= 18; i++) await zapiszZasady(START, formularz({ normalReleaseBusinessDays: String(i) }))
    const s = await reservationSettings(a)
    expect(s.history).toHaveLength(10)
    expect(s.history[0]!.changes).toEqual([{ label: 'Tryb normalny, zwolnienie rezerwacji', from: '17 dni roboczych', to: '18 dni roboczych' }])
    expect(s.history.every((h) => h.who === 'Właściciel Testowy A')).toBe(true)
    // wpis spoza panelu (worker, skrypt) — bez technicznego id na ekranie
    await updatePolicy(a, { normalReleaseBusinessDays: 20 }, 'worker-test')
    expect((await reservationSettings(a)).history[0]!.who).toBe('system')
  })
})

describe('izolacja dwóch firm', () => {
  it('zapis w A nie zmienia B; historia i bufory tylko własnej firmy; osoba z innej firmy bez nazwy', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { defaultSafetyBuffer: 2 } })
    await b.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { defaultSafetyBuffer: 7 } })
    await jako('wlasciciel@firma-a.test')
    await zapiszZasady(START, formularz({ seasonMode: 'tak' }))
    expect((await getPolicy(b)).seasonMode).toBe(false)
    expect(await getPolicy(b)).toMatchObject(DEFAULT_POLICY)
    expect(await b.auditLog.count()).toBe(0)

    const userB = await jako('wlasciciel@firma-b.test')
    await zapiszZasady(START, formularz({ normalReleaseBusinessDays: '9' }))
    expect(await getPolicy(a)).toMatchObject({ seasonMode: true, normalReleaseBusinessDays: 5 })
    expect(await getPolicy(b)).toMatchObject({ seasonMode: false, normalReleaseBusinessDays: 9 })

    const sa = await reservationSettings(a)
    const sb = await reservationSettings(b)
    expect(sa.history.map((h) => h.who)).toEqual(['Właściciel Testowy A'])
    expect(sb.history.map((h) => h.who)).toEqual(['Właściciel Testowy B'])
    expect(sa.buffers.find((x) => x.channel === 'ALLEGRO')?.buffer).toBe(2)
    expect(sb.buffers.find((x) => x.channel === 'ALLEGRO')?.buffer).toBe(7)
    expect(sa.buffers.map((x) => x.channel)).not.toContain('RECZNE')

    // wpis w A z id osoby, która nie należy do A: nazwy z innej firmy nie pokazujemy
    await updatePolicy(a, { seasonMode: false }, userB)
    expect((await reservationSettings(a)).history[0]!.who).toBe('system')
    // odczyt ekranu odmawia klienta systemowego (przez wszystkie firmy)
    await expect(reservationSettings(sys)).rejects.toThrow(/klienta firmy/)
  })
})

describe('dostęp', () => {
  it('rola bez `ustawienia`: akcja i ekran = 404, nic się nie zapisuje', async () => {
    await jako('magazyn@firma-a.test')
    await expect404(zapiszZasady(START, formularz({ seasonMode: 'tak' })))
    await expect404(ZasadyRezerwacji())
    await jako('kadry@firma-a.test') // tylko `uzytkownicy`
    await expect404(zapiszZasady(START, formularz({ seasonMode: 'tak' })))
    await expect404(ZasadyRezerwacji())
    expect(await getPolicy(a)).toMatchObject(DEFAULT_POLICY)
    expect(await a.auditLog.count()).toBe(0)
  })

  it('bez sesji: przekierowanie na /logowanie', async () => {
    ciasteczko = undefined
    await expect(zapiszZasady(START, formularz())).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;.*\/logowanie/) })
  })

  it('/ustawienia: działy i zakładki według uprawnień, samo /ustawienia przekierowuje', async () => {
    await jako('wlasciciel@firma-a.test')
    const all = await wejsciaUstawien()
    for (const href of ['/ustawienia/przewoznicy', '/ustawienia/rezerwacje', '/ustawienia/uzytkownicy', '/ustawienia/haslo']) expect(all).toContain(`href="${href}"`)
    await jako('kadry@firma-a.test')
    const kadry = await wejsciaUstawien()
    expect(kadry).toContain('href="/ustawienia/uzytkownicy"')
    expect(kadry).not.toContain('href="/ustawienia/rezerwacje"')
    expect(kadry).not.toContain('href="/ustawienia/przewoznicy"')
    // bez uprawnień do ustawień firmy: dział „Zespół i dostęp” z własnym hasłem jest dla każdego
    await jako('magazyn@firma-a.test')
    const magazyn = await wejsciaUstawien()
    expect(magazyn).toContain('href="/ustawienia/haslo"')
    for (const href of ['/ustawienia/przewoznicy', '/ustawienia/rezerwacje', '/ustawienia/uzytkownicy']) expect(magazyn).not.toContain(`href="${href}"`)
    // samo /ustawienia przekierowuje na pierwszą zakładkę pierwszego działu, który osoba widzi
    const cel = async () => (await Ustawienia().catch((e: { digest?: string }) => e.digest ?? String(e))) as string
    expect(await cel()).toMatch(/^NEXT_REDIRECT;.*;\/ustawienia\/haslo;/)
    await jako('kadry@firma-a.test')
    expect(await cel()).toMatch(/^NEXT_REDIRECT;.*;\/ustawienia\/uzytkownicy;/)
    await jako('wlasciciel@firma-b.test')
    expect(await cel()).toMatch(/^NEXT_REDIRECT;.*;\/ustawienia\/kanaly;/)
    // adres działu: pierwsza widoczna zakładka działu, dział bez widocznej zakładki albo nieznany = 404
    const dzial = async (d: string) => (await DzialUstawien({ params: Promise.resolve({ dzial: d }) }).catch((e: { digest?: string }) => e.digest ?? String(e))) as string
    expect(await dzial('wysylka')).toMatch(/^NEXT_REDIRECT;.*;\/ustawienia\/przewoznicy;/)
    expect(await dzial('nie-ma')).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/)
    await jako('magazyn@firma-a.test')
    expect(await dzial('wysylka')).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/)
    expect(await dzial('zespol')).toMatch(/^NEXT_REDIRECT;.*;\/ustawienia\/haslo;/)
  })

  it('menu: jedna pozycja „Ustawienia” dla każdego, akcja zaczyna od requirePermission', () => {
    const root = path.resolve(__dirname, '..')
    // menu z drzewa nawigacji; „Ustawienia” bez uprawnienia (zmiana hasła jest dla każdego), ekrany ustawień
    // firmy jako pozycje podrzędne tylko z uprawnieniem „ustawienia”
    const menu = zbudujMenu({ uprawnienia: new Set(['panel.podglad']), maBl: false, liczniki: { zamowienia: 0, braki: 0 } })
    const ust = menu.flatMap((s) => s.pozycje).find((p) => p.href === '/ustawienia')
    expect(ust).toBeDefined()
    expect(ust!.dzieci.map((d) => d.href)).not.toContain('/ustawienia/przewoznicy')
    const akcje = readFileSync(path.join(root, 'app/(panel)/ustawienia/rezerwacje/akcje.ts'), 'utf8')
    expect(akcje).toMatch(/export async function zapiszZasady\([^)]*\)[^{]*\{\s*\n\s*const ctx = await requirePermission\('ustawienia'\)/)
    expect(akcje).toContain('savePolicy(ctx.db, patch, ctx.user.id,')
  })
})

describe('przełączenie sezonu a terminy zamówień', () => {
  it('istniejące zamówienie zachowuje terminy normalne, nowe dostaje sezonowe', async () => {
    const p = await product(a, 'SEZON-1', 5)
    const r1 = await ingestOrder(a, order([{ productId: p, qty: 1 }], { paymentState: 'UNPAID', paymentMethod: 'przelew' }), { now: T0 })
    const before = await a.order.findUniqueOrThrow({ where: { id: r1.orderId! } })
    expect(before.termsSeasonMode).toBe(false)

    await jako('wlasciciel@firma-a.test')
    const r = await zapiszZasady(START, formularz({ seasonMode: 'tak' }))
    expect(r.error).toBeNull()

    const after = await a.order.findUniqueOrThrow({ where: { id: r1.orderId! } })
    expect({ m: after.termsSeasonMode, r: after.remindAt, d: after.reservationDeadline }).toEqual({ m: false, r: before.remindAt, d: before.reservationDeadline })
    expect(after.reservationDeadline?.toISOString()).toBe('2026-10-22T08:00:00.000Z') // 5 dni roboczych od T0

    const r2 = await ingestOrder(a, order([{ productId: p, qty: 1 }], { paymentState: 'UNPAID', paymentMethod: 'przelew' }), { now: T0 })
    const o2 = await a.order.findUniqueOrThrow({ where: { id: r2.orderId! } })
    expect(o2.termsSeasonMode).toBe(true)
    expect(o2.remindAt?.toISOString()).toBe('2026-10-16T08:00:00.000Z') // 1 dzień roboczy
    expect(o2.reservationDeadline?.toISOString()).toBe('2026-10-20T08:00:00.000Z') // 3 dni robocze
  })
})
