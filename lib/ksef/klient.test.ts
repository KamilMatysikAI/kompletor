// klient KSeF tylko do odczytu. Strażnik każdej ścieżki zapisu i hosta produkcyjnego; sieci nie ma
// (atrapa fetch, która zapisuje żądania). Do TEST i DEMO KSeF też się nie łączymy.
import { describe, expect, it } from 'vitest'
import { ReadOnlyViolation } from '../zrodla/http'
import { assertKsefReadOnly, KSEF_BAZY, KsefReadOnly } from './klient'

const TEST = KSEF_BAZY.TEST
const PROD = 'https://api.ksef.mf.gov.pl/v2'

function atrapa(odpowiedz: (url: string, init?: RequestInit) => Response = () => new Response(JSON.stringify({ challenge: 'c-123', timestamp: '2026-11-02T10:00:00Z' }), { status: 200 })) {
  const zadania: string[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    zadania.push(`${init?.method ?? 'GET'} ${url}`)
    return odpowiedz(url, init)
  }
  return { zadania, fetchImpl }
}

describe('assertKsefReadOnly', () => {
  it('dozwolone tylko POST /auth/challenge i GET /security/public-key-certificates na TEST i DEMO', () => {
    expect(() => assertKsefReadOnly('POST', `${TEST}/auth/challenge`)).not.toThrow()
    expect(() => assertKsefReadOnly('GET', `${TEST}/security/public-key-certificates`)).not.toThrow()
    expect(() => assertKsefReadOnly('post', `${KSEF_BAZY.DEMO}/auth/challenge`)).not.toThrow()
  })

  it.each([
    ['POST', '/sessions/online'],
    ['POST', '/sessions/online/REF/invoices'],
    ['POST', '/sessions/online/REF/close'],
    ['GET', '/sessions/REF/invoices/INV'],
    ['GET', '/sessions/REF/invoices/INV/upo'],
    ['POST', '/sessions/batch'],
    ['POST', '/auth/ksef-token'],
    ['POST', '/auth/xades-signature'],
    ['GET', '/auth/REF'],
    ['POST', '/auth/token/redeem'],
    ['POST', '/auth/token/refresh'],
    ['GET', '/invoices/ksef/1111111111-20261102-ABC'],
    ['POST', '/invoices/query/metadata'],
    ['POST', '/tokens'],
    ['GET', '/tokens'],
    ['DELETE', '/tokens/REF'],
    ['GET', '/auth/challenge'],
    ['POST', '/security/public-key-certificates'],
    ['POST', '/auth/challenge/../../sessions/online'],
  ])('%s %s → ReadOnlyViolation', (method, sciezka) => {
    expect(() => assertKsefReadOnly(method, `${TEST}${sciezka}`)).toThrow(ReadOnlyViolation)
  })

  it('host produkcyjny = wyjątek w każdej ścieżce, także w odczytach', () => {
    for (const s of ['/auth/challenge', '/security/public-key-certificates', '/sessions/online', '/invoices/query/metadata', '/tokens', '/'])
      for (const m of ['GET', 'POST']) expect(() => assertKsefReadOnly(m, `${PROD}${s}`)).toThrow(/produkcyjne/)
    expect(() => assertKsefReadOnly('POST', 'https://api.ksef.mf.gov.pl:443/v2/auth/challenge')).toThrow(/produkcyjne/)
  })

  it('obce hosty, http, brak /v2, dodatki w adresie', () => {
    expect(() => assertKsefReadOnly('POST', 'https://ksef.example.invalid/v2/auth/challenge')).toThrow(ReadOnlyViolation)
    expect(() => assertKsefReadOnly('POST', 'http://api-test.ksef.mf.gov.pl/v2/auth/challenge')).toThrow(ReadOnlyViolation)
    expect(() => assertKsefReadOnly('POST', 'https://api-test.ksef.mf.gov.pl/api/v2/auth/challenge')).toThrow(ReadOnlyViolation)
    expect(() => assertKsefReadOnly('POST', 'https://api-test.ksef.mf.gov.pl/auth/challenge')).toThrow(ReadOnlyViolation)
    expect(() => assertKsefReadOnly('POST', `${TEST}/auth/challenge?x=1`)).toThrow(ReadOnlyViolation)
    expect(() => assertKsefReadOnly('POST', 'https://u:p@api-test.ksef.mf.gov.pl/v2/auth/challenge')).toThrow(ReadOnlyViolation)
    expect(() => assertKsefReadOnly('POST', 'nie-adres')).toThrow(ReadOnlyViolation)
  })
})

describe('KsefReadOnly', () => {
  it('środowisko PROD i nieznane odrzucone już w konstruktorze', () => {
    expect(() => new KsefReadOnly('PROD')).toThrow(ReadOnlyViolation)
    expect(() => new KsefReadOnly('prod')).toThrow(ReadOnlyViolation)
    expect(() => new KsefReadOnly('')).toThrow(ReadOnlyViolation)
  })

  it('challenge: POST na TEST przez atrapę, bez przekierowań', async () => {
    let init: RequestInit | undefined
    const a = atrapa((_u, i) => {
      init = i
      return new Response(JSON.stringify({ challenge: 'c-123', timestamp: '2026-11-02T10:00:00Z' }), { status: 200 })
    })
    const k = new KsefReadOnly('TEST', a.fetchImpl, 0)
    expect(await k.challenge()).toEqual({ challenge: 'c-123', timestamp: '2026-11-02T10:00:00Z' })
    expect(a.zadania).toEqual([`POST ${TEST}/auth/challenge`])
    expect(init?.redirect).toBe('error')
  })

  it('klucze publiczne: GET na DEMO; odpowiedź nie-lista = błąd', async () => {
    const a = atrapa(() => new Response('[{"certificate":"x"}]', { status: 200 }))
    expect(await new KsefReadOnly('DEMO', a.fetchImpl, 0).publicKeyCertificates()).toEqual([{ certificate: 'x' }])
    expect(a.zadania).toEqual([`GET ${KSEF_BAZY.DEMO}/security/public-key-certificates`])
    await expect(new KsefReadOnly('DEMO', atrapa(() => new Response('{}', { status: 200 })).fetchImpl, 0).publicKeyCertificates()).rejects.toThrow(/nie jest listą/)
  })

  it('400 bez ponowień, 503 z ponowieniem', async () => {
    const a = atrapa(() => new Response('{}', { status: 400 }))
    await expect(new KsefReadOnly('TEST', a.fetchImpl, 0, { attempts: 3, baseDelayMs: 1 }).challenge()).rejects.toThrow(/HTTP 400/)
    expect(a.zadania).toHaveLength(1)
    const b = atrapa(() => new Response('{}', { status: 503 }))
    await expect(new KsefReadOnly('TEST', b.fetchImpl, 0, { attempts: 2, baseDelayMs: 1 }).challenge()).rejects.toThrow(/HTTP 503/)
    expect(b.zadania).toHaveLength(2)
  })
})
