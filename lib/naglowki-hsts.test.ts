// HSTS z next.config.ts pod tym samym warunkiem co prefiks __Host- ciasteczka sesji.
import { afterEach, describe, expect, it, vi } from 'vitest'

async function hsts(): Promise<string | undefined> {
  vi.resetModules()
  const { default: cfg } = await import('../next.config')
  const rules = await cfg.headers!()
  const all = rules.find((r) => r.source === '/:path*')!.headers
  return all.find((h) => h.key === 'Strict-Transport-Security')?.value
}

afterEach(() => vi.unstubAllEnvs())

describe('next.config.ts: Strict-Transport-Security', () => {
  it('produkcja po https (domyślnie): max-age rok, bez includeSubDomains i preload', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('COOKIE_SECURE', '')
    expect(await hsts()).toBe('max-age=31536000')
  })

  it('COOKIE_SECURE=false (instalacja po http) albo poza produkcją: brak nagłówka', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('COOKIE_SECURE', 'false')
    expect(await hsts()).toBeUndefined()
    vi.stubEnv('COOKIE_SECURE', '')
    vi.stubEnv('NODE_ENV', 'development')
    expect(await hsts()).toBeUndefined()
  })

  it('ten sam warunek co nazwa ciasteczka sesji z prefiksem __Host-', async () => {
    for (const [nodeEnv, secure] of [['production', ''], ['production', 'false'], ['test', '']] as const) {
      vi.stubEnv('NODE_ENV', nodeEnv)
      vi.stubEnv('COOKIE_SECURE', secure)
      const { SESSION_COOKIE } = await import('./auth/sesja-ciasteczko')
      expect(Boolean(await hsts())).toBe(SESSION_COOKIE.startsWith('__Host-'))
    }
  })
})
