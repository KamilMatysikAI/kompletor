import { describe, expect, it } from 'vitest'
import { basicAuthDecision, basicAuthResponse, safeEqual } from './basic-auth'

const env = { BASIC_AUTH_USER: 'kompletor', BASIC_AUTH_PASSWORD: 'tajne:haslo' }
const hdr = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')

describe('bramka Basic Auth (do logowania)', () => {
  it('bez obu zmiennych bramki nie ma', () => {
    expect(basicAuthDecision('/', null, {})).toEqual({ kind: 'pass' })
  })

  it('poprawne dane przechodzą (hasło może mieć dwukropek), złe i brak nagłówka = 401', () => {
    expect(basicAuthDecision('/', hdr('kompletor', 'tajne:haslo'), env)).toEqual({ kind: 'pass' })
    expect(basicAuthDecision('/', hdr('kompletor', 'zle'), env)).toEqual({ kind: 'challenge' })
    expect(basicAuthDecision('/', hdr('inny', 'tajne:haslo'), env)).toEqual({ kind: 'challenge' })
    expect(basicAuthDecision('/', null, env)).toEqual({ kind: 'challenge' })
    expect(basicAuthDecision('/', 'Bearer abc', env)).toEqual({ kind: 'challenge' })
    expect(basicAuthDecision('/', 'Basic ' + Buffer.from('bezdwukropka').toString('base64'), env)).toEqual({ kind: 'challenge' })
  })

  it('niepełna konfiguracja zamyka wszystko poza zdrowiem (fail-closed)', () => {
    expect(basicAuthDecision('/', hdr('kompletor', ''), { BASIC_AUTH_USER: 'kompletor' })).toEqual({ kind: 'misconfigured', reason: 'partial' })
    expect(basicAuthDecision('/', null, { BASIC_AUTH_PASSWORD: 'x' })).toEqual({ kind: 'misconfigured', reason: 'partial' })
    expect(basicAuthResponse('/', null, { BASIC_AUTH_PASSWORD: 'x' })?.status).toBe(503)
  })

  it('produkcja bez obu zmiennych = 503, chyba że BASIC_AUTH_DISABLED=1; health dalej otwarte', () => {
    const prod = { NODE_ENV: 'production' }
    expect(basicAuthDecision('/', null, prod)).toEqual({ kind: 'misconfigured', reason: 'missing-in-production' })
    expect(basicAuthDecision('/pulpit', null, { ...prod, BASIC_AUTH_DISABLED: '0' })).toEqual({ kind: 'misconfigured', reason: 'missing-in-production' })
    const r = basicAuthResponse('/', null, prod)
    expect(r?.status).toBe(503)
    expect(r?.headers.get('Cache-Control')).toBe('no-store')
    expect(basicAuthDecision('/api/health', null, prod)).toEqual({ kind: 'pass' })
    expect(basicAuthDecision('/', null, { ...prod, BASIC_AUTH_DISABLED: '1' })).toEqual({ kind: 'pass' })
    expect(basicAuthDecision('/', null, { NODE_ENV: 'test' })).toEqual({ kind: 'pass' })
    // ustawione obie zmienne: BASIC_AUTH_DISABLED nie wyłącza bramki (zmienne wygrywają)
    expect(basicAuthDecision('/', null, { ...prod, ...env, BASIC_AUTH_DISABLED: '1' })).toEqual({ kind: 'challenge' })
  })

  it('/api/health otwarte (healthcheck kontenera bez hasła), inne ścieżki API nie', () => {
    expect(basicAuthDecision('/api/health', null, env)).toEqual({ kind: 'pass' })
    expect(basicAuthDecision('/api/health/x', null, env)).toEqual({ kind: 'challenge' })
    expect(basicAuthDecision('/api/cokolwiek', null, env)).toEqual({ kind: 'challenge' })
  })

  it('401 z nagłówkiem WWW-Authenticate', () => {
    const r = basicAuthResponse('/', null, env)
    expect(r?.status).toBe(401)
    expect(r?.headers.get('WWW-Authenticate')).toMatch(/^Basic realm="Kompletor"/)
    expect(basicAuthResponse('/', hdr('kompletor', 'tajne:haslo'), env)).toBeNull()
  })

  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})
