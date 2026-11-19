// Ustawienia → Klucze API. Utworzenie z panelu: pełny klucz tylko w odpowiedzi akcji (raz), na liście sam
// początek; odwołanie z AuditLog z id osoby; rola bez `ustawienia` = 404 (ekran i akcje); wejście z /ustawienia.
// Dane wyłącznie testowe (konta w domenie .test).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { createUser, grantMembership, login } from '@/lib/auth/sesje'
import type { ApiKeyFormState } from '@/lib/api/zarzadzanie'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'

let ciasteczko: string | undefined
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (_n: string) => (ciasteczko ? { value: ciasteczko } : undefined) }),
  headers: async () => new Headers(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const { utworzKlucz, odwolajKlucz } = await import('@/app/(panel)/ustawienia/klucze-api/akcje')
const { default: KluczeApi } = await import('@/app/(panel)/ustawienia/klucze-api/page')
const { wejsciaUstawien } = await import('./ustawienia-wejscia')
const { findApiKey } = await import('@/lib/api/klucze')

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
const PASS = 'haslo-testowe-0001'
const START: ApiKeyFormState = { error: null, created: null }

beforeEach(async () => {
  await truncateAll()
  await createUser(sys, { email: 'wlasciciel@firma-a.test', name: 'Właściciel Testowy A', password: PASS })
  await grantMembership(sys, { email: 'wlasciciel@firma-a.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  await createUser(sys, { email: 'magazyn@firma-a.test', name: 'Magazyn Testowy A', password: PASS })
  await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_A, role: 'MAGAZYN' })
  await createUser(sys, { email: 'wlasciciel@firma-b.test', name: 'Właściciel Testowy B', password: PASS })
  await grantMembership(sys, { email: 'wlasciciel@firma-b.test', organizationId: ORG_B, role: 'WLASCICIEL' })
  ciasteczko = undefined
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function jako(email: string): Promise<string> {
  const r = await login(sys, email, PASS)
  if (!r.ok) throw new Error(`logowanie ${email}: ${r.reason}`)
  ciasteczko = r.token
  return (await sys.user.findUniqueOrThrow({ where: { email } })).id
}
const form = (nazwa: string, zakresy: string[]) => {
  const f = new FormData()
  f.set('nazwa', nazwa)
  for (const z of zakresy) f.append('zakres', z)
  return f
}
const html = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el)
async function expect404(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/) })
}

describe('Ustawienia → Klucze API', () => {
  it('utworzenie: pełny klucz raz w odpowiedzi akcji, na ekranie tylko początek; odwołanie z AuditLog', async () => {
    const uid = await jako('wlasciciel@firma-a.test')
    const s = await utworzKlucz(START, form('BotKlienta', ['zamowienia:odczyt']))
    expect(s.error).toBeNull()
    expect(s.created).toMatchObject({ name: 'BotKlienta', token: expect.stringMatching(/^kmp_/), prefix: s.created!.token.slice(0, 12) })
    const key = await findApiKey(sys, s.created!.token)
    expect(key).toMatchObject({ organizationId: ORG_A, scopes: ['zamowienia:odczyt'] })
    const page = await html(KluczeApi())
    expect(page).toContain('BotKlienta')
    expect(page).toContain(`${s.created!.prefix}…`)
    expect(page).not.toContain(s.created!.token.slice(12))
    expect(page).toContain('zamowienia:odczyt')
    expect(page).toContain('nieużywany')
    expect(page).toContain('Odwołaj')
    // błąd formularza po polsku, bez zapisu
    expect((await utworzKlucz(START, form('Bez zakresu', []))).error).toMatch(/co najmniej jeden zakres/)
    expect(await a.apiKey.count()).toBe(1)
    const f = new FormData()
    f.set('id', key!.id)
    expect(await odwolajKlucz(null, f)).toBeNull()
    expect(await findApiKey(sys, s.created!.token)).toBeNull()
    const audit = await a.auditLog.findMany({ where: { entity: 'ApiKey', entityId: key!.id }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((x) => x.actorId)).toEqual([uid, uid])
    expect(JSON.stringify(audit)).not.toContain(s.created!.token.slice(12))
    expect(await html(KluczeApi())).toContain('odwołany')
  })

  it('izolacja: firma B nie widzi i nie odwoła klucza firmy A', async () => {
    await jako('wlasciciel@firma-a.test')
    const s = await utworzKlucz(START, form('Klucz A', ['stany:odczyt']))
    const id = (await findApiKey(sys, s.created!.token))!.id
    await jako('wlasciciel@firma-b.test')
    expect(await html(KluczeApi())).not.toContain('Klucz A')
    const f = new FormData()
    f.set('id', id)
    expect(await odwolajKlucz(null, f)).toMatch(/Nie znaleziono/)
    expect(await findApiKey(sys, s.created!.token)).not.toBeNull()
  })

  it('rola bez `ustawienia`: ekran i akcje = 404; /ustawienia pokazuje wejście tylko z uprawnieniem', async () => {
    await jako('magazyn@firma-a.test')
    await expect404(KluczeApi())
    await expect404(utworzKlucz(START, form('x', ['stany:odczyt'])))
    await expect404(odwolajKlucz(null, new FormData()))
    expect(await wejsciaUstawien()).not.toContain('/ustawienia/klucze-api')
    expect(await a.apiKey.count()).toBe(0)
    await jako('wlasciciel@firma-a.test')
    expect(await wejsciaUstawien()).toContain('/ustawienia/klucze-api')
  })
})
