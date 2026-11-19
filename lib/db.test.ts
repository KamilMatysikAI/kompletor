import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appModeOf, appRolePasswordOf, createOrgClient, createSystemClient, isLoopbackUrl, orgClientModeOf, scramVerifier } from './db'

const URL = 'postgresql://u:p@127.0.0.1:1/baza'

describe('lib/db: parametry startowe sesji tylko z kodu', () => {
  afterEach(() => {
    delete process.env.PGOPTIONS
    delete process.env.APP_MODE
    delete process.env.APP_DATABASE_URL
  })

  it('options w adresie odrzucone, także zakodowane', () => {
    expect(() => createSystemClient({ connectionString: `${URL}?options=-c%20role%3Dx` })).toThrow(/options/)
    expect(() => createSystemClient({ connectionString: `${URL}?%6Fptions=-c%20role%3Dx` })).toThrow(/options/)
    expect(() => createOrgClient('firma_a', { connectionString: `${URL}?sslmode=disable&OPTIONS=x` })).toThrow(/options/)
  })

  it('PGOPTIONS w środowisku odrzucone', () => {
    process.env.PGOPTIONS = '-c role=logistyka_app -c app.org_id=x'
    expect(() => createSystemClient({ connectionString: URL })).toThrow(/PGOPTIONS/)
  })

  it('zły identyfikator firmy nie trafia do parametru options', () => {
    expect(() => createOrgClient('a -c role=postgres', { connectionString: URL })).toThrow(/id organizacji/)
  })

  it('options w adresie roli aplikacji też odrzucone', () => {
    expect(() => createOrgClient('firma_a', { appConnectionString: `${URL}?options=-c%20app.org_id%3Dx` })).toThrow(/APP_DATABASE_URL.*options/)
  })
})

describe('lib/db: rola LOGIN klienta firmy', () => {
  const APP_URL = 'postgresql://logistyka_app:haslo-testowe-0123456789@127.0.0.1:1/baza'
  // jednorazowe ostrzeżenie starego trybu role= nie zaśmieca logu przebiegu unit
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    delete process.env.APP_MODE
    delete process.env.APP_DATABASE_URL
    vi.restoreAllMocks()
  })

  it('APP_DATABASE_URL z env = tryb LOGIN; jawny adres właściciela bez adresu roli = stary tryb role=', () => {
    process.env.APP_DATABASE_URL = APP_URL
    expect(orgClientModeOf(createOrgClient('firma_a'))).toBe('login')
    expect(orgClientModeOf(createOrgClient('firma_a', { connectionString: URL }))).toBe('role') // inna baza niż w env
    expect(orgClientModeOf(createOrgClient('firma_a', { connectionString: URL, appConnectionString: APP_URL }))).toBe('login')
  })

  it('hosting bez adresu roli aplikacji = odmowa; self-host = stary tryb', () => {
    process.env.APP_MODE = 'hosted'
    expect(() => createOrgClient('firma_a', { connectionString: URL })).toThrow(/APP_MODE=hosted wymaga APP_DATABASE_URL/)
    process.env.APP_MODE = 'self-host'
    expect(orgClientModeOf(createOrgClient('firma_a', { connectionString: URL }))).toBe('role')
  })

  it('APP_MODE z jednego źródła — nieznana wartość („Hosted”) = błąd także w lib/db, spacje obcięte', () => {
    process.env.APP_MODE = 'Hosted'
    expect(() => createOrgClient('firma_a', { connectionString: URL })).toThrow(/APP_MODE musi być/)
    expect(appModeOf({ APP_MODE: ' hosted ' })).toBe('hosted')
    expect(appModeOf({})).toBe('self-host')
    expect(() => appModeOf({ APP_MODE: '' })).toThrow(/APP_MODE/)
  })

  it('hasło z .env.example (publiczne) tylko na loopback', () => {
    const example = readFileSync(path.join(process.cwd(), '.env.example'), 'utf8').match(/^APP_DATABASE_URL=(\S+)$/m)?.[1]
    expect(example).toBeTruthy()
    const local = new globalThis.URL(example!)
    expect(isLoopbackUrl(local.toString())).toBe(true)
    expect(() => appRolePasswordOf(local.toString())).not.toThrow()
    for (const host of ['localhost', '[::1]']) {
      const u = new globalThis.URL(local.toString())
      u.hostname = host
      expect(() => appRolePasswordOf(u.toString())).not.toThrow()
    }
    const remote = new globalThis.URL(local.toString())
    remote.hostname = 'db.example.com'
    expect(isLoopbackUrl(remote.toString())).toBe(false)
    expect(() => appRolePasswordOf(remote.toString())).toThrow(/\.env\.example.*tylko na 127\.0\.0\.1/)
    // inne hasło na serwerze spoza loopback: w porządku
    const own = new globalThis.URL(remote.toString())
    own.password = 'wlasne-haslo-serwera-0123456789'
    expect(() => appRolePasswordOf(own.toString())).not.toThrow()
    expect(isLoopbackUrl('nie adres')).toBe(false)
  })

  it('hasło roli: z adresu, tylko dla logistyka_app, min. 16 znaków ASCII', () => {
    expect(appRolePasswordOf(APP_URL)).toBe('haslo-testowe-0123456789')
    expect(appRolePasswordOf('postgresql://logistyka_app:a%2Fb%40c-0123456789xyz@h/b')).toBe('a/b@c-0123456789xyz')
    expect(() => appRolePasswordOf('postgresql://postgres:haslo-testowe-0123456789@h/b')).toThrow(/logistyka_app/)
    expect(() => appRolePasswordOf('postgresql://logistyka_app:krotkie@h/b')).toThrow(/za krótkie/)
    expect(() => appRolePasswordOf('postgresql://logistyka_app:zażółć-gęślą-jaźń-123@h/b')).toThrow(/ASCII/)
    expect(() => appRolePasswordOf('nie adres')).toThrow(/poprawnym adresem/)
  })

  it('weryfikator SCRAM-SHA-256 w formacie Postgresa, bez hasła w treści, deterministyczny dla soli', () => {
    const salt = Buffer.alloc(16, 7)
    const v = scramVerifier('haslo-testowe-0123456789', salt)
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/)
    expect(v).not.toContain('haslo')
    expect(scramVerifier('haslo-testowe-0123456789', salt)).toBe(v)
    expect(scramVerifier('haslo-testowe-0123456789')).not.toBe(v) // losowa sól
  })
})
