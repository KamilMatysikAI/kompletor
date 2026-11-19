// Ustawienia → Powiadomienia — ekran i akcje. Dostęp tylko z uprawnieniem `ustawienia` (inaczej 404),
// stan klucza „tak/nie” bez wartości, stan bramki instancji, zapis przez akcję z AuditLog osoby zalogowanej,
// wiadomość próbna przy wyłączonej instancji nic nie wysyła. Dane wyłącznie testowe (domeny .test).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { createUser, grantMembership, login } from '@/lib/auth/sesje'
import { setSecret } from '@/lib/sekrety'
import { testDb, testSystemDb, truncateAll, ORG_A } from './db'
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
const KEY_HEX = 'cd'.repeat(32)
process.env.APP_ENCRYPTION_KEY = KEY_HEX

const { zapiszPowiadomienia, wyslijProbna } = await import('@/app/(panel)/ustawienia/powiadomienia/akcje')
const { default: Powiadomienia } = await import('@/app/(panel)/ustawienia/powiadomienia/page')
const { wejsciaUstawien } = await import('./ustawienia-wejscia')

const sys = testSystemDb()
const a = testDb()
const PASS = 'haslo-testowe-0001'
const SECRET_VALUE = 'zulip-klucz-ekran-0001'
const html = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el)
const page = (sp: Record<string, string> = {}) => html(Powiadomienia({ searchParams: Promise.resolve(sp) }))

async function jako(email: string): Promise<string> {
  const r = await login(sys, email, PASS)
  if (!r.ok) throw new Error(`logowanie ${email}: ${r.reason}`)
  ciasteczko = r.token
  return (await sys.user.findUniqueOrThrow({ where: { email } })).id
}

beforeEach(async () => {
  await truncateAll()
  await createUser(sys, { email: 'wlasciciel@firma-a.test', name: 'Właściciel Testowy A', password: PASS })
  await grantMembership(sys, { email: 'wlasciciel@firma-a.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  await createUser(sys, { email: 'magazyn@firma-a.test', name: 'Magazyn Testowy A', password: PASS })
  await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_A, role: 'MAGAZYN' })
  ciasteczko = undefined
  vi.stubEnv('POWIADOMIENIA_WYSYLKA', '')
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await a.$disconnect()
})

describe('Ustawienia → Powiadomienia', () => {
  it('bez uprawnienia `ustawienia` = 404 (ekran i akcje); link w Ustawieniach tylko z uprawnieniem', async () => {
    await jako('magazyn@firma-a.test')
    await expect(page()).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/) })
    await expect(zapiszPowiadomienia(new FormData())).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/) })
    await expect(wyslijProbna(new FormData())).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/) })
    expect(await wejsciaUstawien()).not.toContain('href="/ustawienia/powiadomienia"')
    await jako('wlasciciel@firma-a.test')
    expect(await wejsciaUstawien()).toContain('href="/ustawienia/powiadomienia"')
  })

  it('ekran: domyślnie wyłączone, stan instancji, klucz „nie” → „tak” bez wartości', async () => {
    await jako('wlasciciel@firma-a.test')
    let h = await page()
    expect(h).toContain('Wysyłka powiadomień jest wyłączona na tej instalacji')
    expect(h).not.toContain('POWIADOMIENIA_WYSYLKA') // bez nazw zmiennych środowiska w panelu
    expect(h).toContain('wyłączone')
    expect(h).toMatch(/Klucz bota ustawiony: <b>nie<\/b>/)
    expect(h).toContain('value="Biuro"')
    expect(h).toContain('value="Magazyn"')
    await setSecret(a, 'ZULIP_API_KEY', SECRET_VALUE, process.env)
    h = await page()
    expect(h).toMatch(/Klucz bota ustawiony: <b>tak<\/b>/)
    expect(h).not.toContain(SECRET_VALUE)
  })

  it('zapis akcją: AuditLog osoby, błąd walidacji wraca komunikatem; próba przy wyłączonej instancji nic nie wysyła', async () => {
    const userId = await jako('wlasciciel@firma-a.test')
    const f = new FormData()
    f.set('wlaczone', 'tak')
    f.set('adres', 'https://firma-a.zulipchat.com')
    f.set('bot', 'kompletor-bot@firma-a.zulipchat.com')
    for (const g of ['KANAL_STANY', 'KANAL_ZAMOWIENIA', 'FAKTURY', 'MAGAZYN', 'INNE']) {
      f.set(`strumien_${g}`, g === 'MAGAZYN' ? 'Magazyn' : 'Biuro')
      f.set(`temat_${g}`, `Temat ${g}`)
    }
    await expect(zapiszPowiadomienia(f)).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;.*zapisano=1/) })
    const s = await a.notificationSettings.findFirstOrThrow()
    expect(s).toMatchObject({ enabled: true, zulipSite: 'https://firma-a.zulipchat.com', updatedById: userId })
    expect(await a.auditLog.count({ where: { entity: 'NotificationSettings', actorId: userId } })).toBe(1)
    f.set('adres', 'https://127.0.0.1')
    await expect(zapiszPowiadomienia(f)).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;.*blad=/) })
    expect((await a.notificationSettings.findFirstOrThrow()).zulipSite).toBe('https://firma-a.zulipchat.com')

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const p = new FormData()
    p.set('grupa', 'MAGAZYN')
    await expect(wyslijProbna(p)).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;.*proba=blad/) })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    expect(await page({ zapisano: '1' })).toContain('włączone od')
  })
})
