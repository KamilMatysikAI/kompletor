// po zmianie hasła startowego osoba ląduje na pulpicie, a nie zostaje na ekranie hasła
// z banerem. Zwykła zmiana hasła (bez wymogu) zostaje na ekranie z komunikatem. Błąd zmiany nigdy nie przekierowuje.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const stan = vi.hoisted(() => ({ odswiezone: [] as string[], startowe: true, wynik: { ok: true } as { ok: true } | { ok: false; message: string } }))

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: (p: string, t?: string) => stan.odswiezone.push(`${p}:${t}`) }))
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '127.0.0.1' }) }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`)
  },
}))
vi.mock('@/lib/panel/kontekst', () => ({
  requireSession: async () => ({ mustChangePassword: stan.startowe, user: { id: 'u-1' }, organization: { organizationId: 'org-1' }, sessionId: 's-1' }),
}))
vi.mock('@/lib/panel/uzytkownicy', () => ({
  changeOwnPasswordFromPanel: async () => stan.wynik,
  endOtherSessionsFromPanel: async () => 0,
}))

const { zmienHaslo } = await import('./akcje')

function form(): FormData {
  const f = new FormData()
  f.set('obecne', 'stare-haslo-startowe')
  f.set('nowe', 'nowe-haslo-dlugie-dosc')
  f.set('powtorz', 'nowe-haslo-dlugie-dosc')
  return f
}
const START = { error: null, ok: false, round: 0 }

describe('zmiana hasła startowego kończy się na pulpicie', () => {
  beforeEach(() => {
    stan.startowe = true
    stan.wynik = { ok: true }
    stan.odswiezone = []
  })

  it('hasło startowe zmienione: odświeżony layout (pełne menu zamiast szkieletu) i przekierowanie na /pulpit', async () => {
    await expect(zmienHaslo(START, form())).rejects.toThrow('REDIRECT /pulpit')
    expect(stan.odswiezone).toEqual(['/:layout'])
  })

  it('zwykła zmiana hasła: zostaje na ekranie z wynikiem ok', async () => {
    stan.startowe = false
    await expect(zmienHaslo(START, form())).resolves.toEqual({ error: null, ok: true, round: 1 })
  })

  it('błąd przy haśle startowym: komunikat przy formularzu, bez przekierowania', async () => {
    stan.wynik = { ok: false, message: 'Obecne hasło jest nieprawidłowe.' }
    await expect(zmienHaslo(START, form())).resolves.toEqual({ error: 'Obecne hasło jest nieprawidłowe.', ok: false, round: 0 })
    expect(stan.odswiezone).toEqual([])
  })
})
