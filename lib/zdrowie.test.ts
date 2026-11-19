import { describe, expect, it } from 'vitest'
import { buildInfo, cachedCheck, hasValidHealthToken, healthBodyFor, migrationState, overallStatus, type HealthBody } from './zdrowie'

describe('zdrowie: stan migracji', () => {
  it('liczy migracje z obrazu, których baza jeszcze nie ma, i podaje ostatnią zastosowaną', () => {
    const s = migrationState(['20261022105546_start', '20261022113903_rdzen', '20261025120000_organizacje'], [
      { name: '20261022105546_start', finished: true, rolledBack: false },
      { name: '20261022113903_rdzen', finished: true, rolledBack: false },
    ])
    expect(s).toEqual({ last: '20261022113903_rdzen', pending: 1, failed: 0 })
  })

  it('migracja nieukończona albo wycofana nie liczy się jako zastosowana, nieukończona to błąd', () => {
    const s = migrationState(['a', 'b'], [
      { name: 'a', finished: true, rolledBack: false },
      { name: 'b', finished: false, rolledBack: false },
    ])
    expect(s).toEqual({ last: 'a', pending: 1, failed: 1 })
    expect(migrationState(['a'], [{ name: 'a', finished: true, rolledBack: true }])).toEqual({ last: null, pending: 1, failed: 0 })
  })

  it('brak katalogu migracji w obrazie = pending nieznane (null), nie zero', () => {
    expect(migrationState(null, [{ name: 'a', finished: true, rolledBack: false }])).toEqual({ last: 'a', pending: null, failed: 0 })
  })
})

describe('zdrowie: status ogólny', () => {
  it('baza nie odpowiada = error; migracje do zrobienia albo nieudane = degraded; reszta ok', () => {
    expect(overallStatus({ db: false, migrations: null })).toBe('error')
    expect(overallStatus({ db: true, migrations: { last: 'a', pending: 1, failed: 0 } })).toBe('degraded')
    expect(overallStatus({ db: true, migrations: { last: 'a', pending: 0, failed: 1 } })).toBe('degraded')
    expect(overallStatus({ db: true, migrations: { last: 'a', pending: 0, failed: 0 } })).toBe('ok')
    expect(overallStatus({ db: true, migrations: { last: 'a', pending: null, failed: 0 } })).toBe('ok')
    // rola aplikacji się nie loguje = error (HTTP 503), `off` = stary tryb bez APP_DATABASE_URL
    const m = { last: 'a', pending: 0, failed: 0 }
    expect(overallStatus({ db: true, migrations: m, appRole: 'error' })).toBe('error')
    expect(overallStatus({ db: true, migrations: m, appRole: 'ok' })).toBe('ok')
    expect(overallStatus({ db: true, migrations: m, appRole: 'off' })).toBe('ok')
    expect(overallStatus({ db: true, migrations: { ...m, pending: 1 }, appRole: 'ok' })).toBe('degraded')
    // (scalenie): zły zestaw kluczy sekretów = error niezależnie od reszty; `none` = ok
    expect(overallStatus({ db: true, migrations: m, appRole: 'ok', secretsKey: 'error' })).toBe('error')
    expect(overallStatus({ db: true, migrations: { ...m, pending: 1 }, appRole: 'off', secretsKey: 'error' })).toBe('error')
    expect(overallStatus({ db: true, migrations: m, appRole: 'ok', secretsKey: 'none' })).toBe('ok')
    expect(overallStatus({ db: true, migrations: m, appRole: 'off', secretsKey: 'ok' })).toBe('ok')
    expect(overallStatus({ db: true, migrations: { ...m, failed: 1 }, appRole: 'ok', secretsKey: 'ok' })).toBe('degraded')
    expect(overallStatus({ db: false, migrations: null, appRole: null, secretsKey: 'ok' })).toBe('error')
  })
})

describe('zdrowie: wersja i commit', () => {
  it('commit z BUILD_SHA, inaczej z SOURCE_COMMIT (Coolify), skrócony; wersja z APP_VERSION albo package.json', () => {
    expect(buildInfo({ BUILD_SHA: 'abcdef1234567890' }, '0.1.0')).toEqual({ version: '0.1.0', sha: 'abcdef123456' })
    expect(buildInfo({ SOURCE_COMMIT: '1234567890abcdef1234' }, '0.1.0')).toEqual({ version: '0.1.0', sha: '1234567890ab' })
    expect(buildInfo({ APP_VERSION: 'v0.2.0', BUILD_SHA: 'unknown' }, '0.1.0')).toEqual({ version: 'v0.2.0', sha: null })
    expect(buildInfo({ BUILD_SHA: 'nie-hex!' }, '0.1.0')).toEqual({ version: '0.1.0', sha: null })
  })
})

describe('cachedCheck: wynik sprawdzenia z /api/health pamiętany i jeden lot w locie', () => {
  it('równoległe żądania = jedno sprawdzenie; w oknie ttl bez nowych; po ttl nowe', async () => {
    let t = 0
    let calls = 0
    let release: (v: string) => void = () => {}
    const check = () => {
      calls++
      return new Promise<string>((res) => (release = res))
    }
    const get = cachedCheck(check, 10_000, () => t)
    const a = get()
    const b = get()
    expect(calls).toBe(1) // jeden lot w locie
    release('ok')
    expect(await a).toBe('ok')
    expect(await b).toBe('ok')
    t = 9_999
    expect(await get()).toBe('ok')
    expect(calls).toBe(1) // z pamięci
    t = 10_000
    const c = get()
    expect(calls).toBe(2) // po ttl nowe sprawdzenie
    release('error')
    expect(await c).toBe('error')
  })

  it('odrzucony lot nie jest pamiętany', async () => {
    let calls = 0
    const get = cachedCheck(async () => {
      calls++
      if (calls === 1) throw new Error('pad')
      return 'ok'
    }, 10_000, () => 0)
    await expect(get()).rejects.toThrow('pad')
    expect(await get()).toBe('ok')
    expect(calls).toBe(2)
  })
})

describe('token operatora i okrojone ciało /api/health w hostingu', () => {
  const env = { HEALTH_TOKEN: 'sekret-testowy-1234' }
  it('hasValidHealthToken: tylko Bearer z dokładnie tą wartością; brak zmiennej = nigdy', () => {
    expect(hasValidHealthToken('Bearer sekret-testowy-1234', env)).toBe(true)
    expect(hasValidHealthToken('bearer   sekret-testowy-1234 ', env)).toBe(true)
    expect(hasValidHealthToken('Bearer sekret-testowy-123', env)).toBe(false)
    expect(hasValidHealthToken('Basic sekret-testowy-1234', env)).toBe(false)
    expect(hasValidHealthToken(null, env)).toBe(false)
    expect(hasValidHealthToken('Bearer ', { HEALTH_TOKEN: '' })).toBe(false)
    expect(hasValidHealthToken('Bearer x', {})).toBe(false)
  })

  const full: HealthBody = {
    ok: true,
    status: 'ok',
    version: '1.0.0',
    sha: 'abc123abc123',
    appMode: 'hosted',
    db: 'ok',
    appRole: 'ok',
    migrations: { last: '20260101_x', pending: 0, failed: 0 },
    secretsKey: 'ok',
    queue: { lastActivity: null, failedLastHour: 0 },
    cien: { enabled: true, status: 'ok', accounts: 1 },
    time: '2026-11-11T00:00:00.000Z',
  }

  it('healthBodyFor: hosted bez autoryzacji okrojone; z autoryzacją i w self-hoście pełne', () => {
    expect(healthBodyFor(full, { hosted: true, authorized: false })).toEqual({
      ok: true,
      status: 'ok',
      sha: 'abc123abc123',
      appMode: 'hosted',
      db: 'ok',
      appRole: 'ok',
      secretsKey: 'ok',
      migrations: { pending: 0, failed: 0 },
      time: '2026-11-11T00:00:00.000Z',
    })
    expect(healthBodyFor({ ...full, migrations: null }, { hosted: true, authorized: false })).toMatchObject({ migrations: null })
    expect(healthBodyFor(full, { hosted: true, authorized: true })).toBe(full)
    expect(healthBodyFor(full, { hosted: false, authorized: false })).toBe(full)
  })
})
