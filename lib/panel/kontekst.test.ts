// hasło startowe a layouty panelu. Przekierowanie na /ustawienia/haslo rzucone w LAYOUCIE zostaje
// w kliencie Next w segmencie layoutu (wspólnym dla wszystkich ekranów): nawigacja na /ustawienia/haslo pobiera już tylko
// segment strony, layout z pamięci rzuca to samo przekierowanie znowu i ekran hasła ładuje się w pętli, pusty.
// Dlatego przekierowuje wyłącznie strona (requireSession), a layout bierze sesję przez requireLayoutSession.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const stan = vi.hoisted(() => ({ sciezka: '/pulpit' as string | null, sesja: null as unknown }))

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'token' }) }),
  headers: async () => new Headers(stan.sciezka ? { 'x-kompletor-sciezka': stan.sciezka } : {}),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`)
  },
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
}))
vi.mock('@/lib/db', () => ({ systemPrisma: () => ({}), prismaForOrg: (id: string) => ({ org: id }) }))
vi.mock('@/lib/auth/sesje', () => ({ SESSION_COOKIE: 'kompletor_sesja', resolveSession: async () => stan.sesja }))
vi.mock('@/lib/auth/zaproszenia', () => ({ invitationInfo: async () => null, isTokenShape: () => false }))

const { requireLayoutSession, requireSession } = await import('./kontekst')

function sesja(mustChangePassword: boolean) {
  return { mustChangePassword, permissions: new Set(['panel.podglad']), organization: { organizationId: 'org-1' }, user: { id: 'u-1' } }
}

describe('hasło startowe przekierowuje strona, nie layout', () => {
  beforeEach(() => {
    stan.sciezka = '/pulpit'
    stan.sesja = sesja(true)
  })

  it('requireSession na innym ekranie niż hasło: przekierowanie na /ustawienia/haslo', async () => {
    await expect(requireSession()).rejects.toThrow('REDIRECT /ustawienia/haslo')
  })

  it('requireSession na ekranie hasła: bez przekierowania (bez pętli po stronie serwera)', async () => {
    stan.sciezka = '/ustawienia/haslo'
    await expect(requireSession()).resolves.toMatchObject({ mustChangePassword: true, db: { org: 'org-1' } })
  })

  it('requireLayoutSession przy haśle startowym nigdy nie przekierowuje — także bez nagłówka ścieżki', async () => {
    await expect(requireLayoutSession()).resolves.toMatchObject({ mustChangePassword: true, db: { org: 'org-1' } })
    stan.sciezka = null
    await expect(requireLayoutSession()).resolves.toMatchObject({ mustChangePassword: true })
  })

  it('requireLayoutSession: bez sesji na logowanie, bez podglądu 404 (jak requireSession)', async () => {
    stan.sesja = null
    await expect(requireLayoutSession()).rejects.toThrow('REDIRECT /logowanie')
    stan.sesja = { ...sesja(false), permissions: new Set() }
    await expect(requireLayoutSession()).rejects.toThrow('NOT_FOUND')
  })

  it('bez hasła startowego requireSession nie patrzy na ścieżkę', async () => {
    stan.sesja = sesja(false)
    stan.sciezka = null
    await expect(requireSession()).resolves.toMatchObject({ mustChangePassword: false })
  })
})

describe('strażnik: żaden layout nie woła requireSession/requirePermission', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const walk = (dir: string, out: string[] = []) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) walk(p, out)
      else out.push(path.relative(ROOT, p).replace(/\\/g, '/'))
    }
    return out
  }
  const layouts = walk(path.join(ROOT, 'app')).filter((f) => /(^|\/)(layout|template)\.tsx$/.test(f))

  it('layouty z sesją biorą ją przez requireLayoutSession (przekierowanie w layoucie = pętla w kliencie)', () => {
    expect(layouts).toContain('app/(panel)/layout.tsx')
    const bad = layouts.filter((f) => /\b(requireSession|requirePermission)\(/.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(bad).toEqual([])
    for (const f of ['app/(panel)/layout.tsx', 'app/(stanowisko)/layout.tsx']) expect(readFileSync(path.join(ROOT, f), 'utf8')).toMatch(/\brequireLayoutSession\(\)/)
  })

  it('layout panelu przy haśle startowym rysuje szkielet bez menu, zanim sięgnie po dane panelu', () => {
    const src = readFileSync(path.join(ROOT, 'app/(panel)/layout.tsx'), 'utf8')
    const galaz = src.indexOf('who.mustChangePassword')
    expect(galaz).toBeGreaterThan(-1)
    expect(galaz).toBeLessThan(src.indexOf('await requireLayoutSession()'))
  })
})
