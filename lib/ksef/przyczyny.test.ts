// przyczyny błędów wysyłki KSeF i dopasowanie faktury w sesji po hashu. Bez sieci.
import { describe, expect, it } from 'vitest'
import { BladKsefApi } from './api/polaczenie'
import { KsefHttpError, znajdzFaktureWSesji, type KsefInvoiceStatus, type KsefTransport } from './api/sesja'
import { automatPonawia, komunikatWysylki, odstepPonowienia, PONOWIENIA_AUTO_MAX, przyczynaWysylki, ODSTEPY_AUTO_MS } from './przyczyny'

describe('przyczynaWysylki', () => {
  it('sieć, przerwanie, 429, 5xx, 401/403 = automat; inne 4xx = człowiek', () => {
    expect(przyczynaWysylki(new BladKsefApi('KSeF: błąd sieci: reset'), false)).toBe('SIEC')
    expect(przyczynaWysylki(new Error('cokolwiek'), false)).toBe('SIEC')
    expect(przyczynaWysylki(new BladKsefApi('x'), true)).toBe('PRZERWANA')
    expect(przyczynaWysylki(new KsefHttpError(429, 'x'), false)).toBe('LIMIT_ZADAN')
    expect(przyczynaWysylki(new KsefHttpError(503, 'x'), false)).toBe('SERWER')
    expect(przyczynaWysylki(new KsefHttpError(400, 'x'), false)).toBe('KSEF_ODMOWA')
    // 401/403 (token odrzucony, odświeżenie nie pomogło) to problem logowania, nie faktury
    expect(przyczynaWysylki(new BladKsefApi('x', 401), false)).toBe('LOGOWANIE')
    expect(przyczynaWysylki(new KsefHttpError(401, 'x'), false)).toBe('LOGOWANIE')
    expect(przyczynaWysylki(new KsefHttpError(403, 'x'), false)).toBe('LOGOWANIE')
    expect(przyczynaWysylki(new KsefHttpError(404, 'x'), false)).toBe('KSEF_ODMOWA')
    for (const p of ['SIEC', 'PRZERWANA', 'LIMIT_ZADAN', 'SERWER', 'LOGOWANIE', 'PORZUCONA']) expect(automatPonawia(p)).toBe(true)
    for (const p of ['KSEF_ODMOWA', 'DANE', 'SCHEMAT', 'KONFIGURACJA', 'ODCZYT_STANU', null, '']) expect(automatPonawia(p)).toBe(false)
  })

  it('komunikat 429 nie mówi „nie przyjął”; odstępy rosną i mieszczą się w limicie prób', () => {
    expect(komunikatWysylki('LIMIT_ZADAN', 'HTTP 429')).toMatch(/^KSeF ograniczył liczbę żądań/)
    expect(komunikatWysylki('LIMIT_ZADAN', 'HTTP 429')).not.toMatch(/nie przyjął/)
    expect(komunikatWysylki('KSEF_ODMOWA', 'HTTP 400')).toMatch(/^KSeF nie przyjął faktury/)
    // odmowa przy otwarciu sesji to nie odmowa faktury
    expect(komunikatWysylki('KSEF_ODMOWA', 'HTTP 400', { otwarcieSesji: true })).toMatch(/^KSeF odrzucił otwarcie sesji: HTTP 400\. Faktura nie została wysłana/)
    expect(komunikatWysylki('KSEF_ODMOWA', 'HTTP 400', { otwarcieSesji: true })).not.toMatch(/nie przyjął/)
    expect(komunikatWysylki('LIMIT_ZADAN', 'HTTP 429', { otwarcieSesji: true })).toBe(komunikatWysylki('LIMIT_ZADAN', 'HTTP 429'))
    expect(komunikatWysylki('LOGOWANIE', 'HTTP 401')).toMatch(/^KSeF odrzucił logowanie/)
    expect(komunikatWysylki('LOGOWANIE', 'HTTP 401')).not.toMatch(/nie przyjął/)
    expect(ODSTEPY_AUTO_MS).toHaveLength(PONOWIENIA_AUTO_MAX)
    for (let i = 1; i < ODSTEPY_AUTO_MS.length; i++) expect(odstepPonowienia(i)).toBeGreaterThan(odstepPonowienia(i - 1))
    expect(odstepPonowienia(99)).toBe(ODSTEPY_AUTO_MS.at(-1))
  })
})

describe('znajdzFaktureWSesji', () => {
  const f = (numer: string, hash: string, invoicingDate = '2026-11-09T10:00:00Z'): KsefInvoiceStatus => ({
    ordinalNumber: 1,
    referenceNumber: `ref-${hash}`,
    invoiceNumber: numer,
    ksefNumber: `ksef-${hash}`,
    invoiceHash: hash,
    invoicingDate,
    status: { code: 200, description: 'Sukces' },
  })
  const transport = (strony: KsefInvoiceStatus[][]): KsefTransport => {
    let i = 0
    return {
      request: async () => {
        const invoices = strony[i] ?? []
        i++
        return new Response(JSON.stringify({ invoices, continuationToken: i < strony.length ? `t${i}` : null }), { status: 200 })
      },
    }
  }

  it('numer i hash zgodne = znaleziona (także na drugiej stronie)', async () => {
    const r = await znajdzFaktureWSesji(transport([[f('2/11/2026', 'h2')], [f('1/11/2026', 'h1')]]), 'S', '1/11/2026', { hashe: ['h1'] })
    expect(r).toMatchObject({ stan: 'znaleziona', faktura: { ksefNumber: 'ksef-h1' } })
  })

  it('numer zgodny, hash obcy = inna_tresc (numeru nie przypisujemy)', async () => {
    expect(await znajdzFaktureWSesji(transport([[f('1/11/2026', 'obcy')]]), 'S', '1/11/2026', { hashe: ['h1'] })).toMatchObject({ stan: 'inna_tresc' })
  })

  it('numer zgodny, hash obcy, a dalej w sesji nasza wersja = znaleziona', async () => {
    expect(await znajdzFaktureWSesji(transport([[f('1/11/2026', 'obcy'), f('1/11/2026', 'h1')]]), 'S', '1/11/2026', { hashe: ['h1'] })).toMatchObject({ stan: 'znaleziona', faktura: { invoiceHash: 'h1' } })
  })

  it('bez hashy (wiersze): przyjęta w KSeF przed dniem wystawienia u nas (czas warszawski) = inna_tresc', async () => {
    // 8.11 22:30 UTC = 8.11 23:30 w Warszawie: dzień przed wystawieniem
    expect(await znajdzFaktureWSesji(transport([[f('1/11/2026', 'x', '2026-11-08T22:30:00Z')]]), 'S', '1/11/2026', { dataWystawienia: '2026-11-09' })).toMatchObject({ stan: 'inna_tresc' })
    // 8.11 23:30 UTC = 9.11 00:30 w Warszawie: dzień wystawienia
    expect(await znajdzFaktureWSesji(transport([[f('1/11/2026', 'x', '2026-11-08T23:30:00Z')]]), 'S', '1/11/2026', { dataWystawienia: '2026-11-09' })).toMatchObject({ stan: 'znaleziona' })
  })

  it('brak faktury o tym numerze = brak', async () => {
    expect(await znajdzFaktureWSesji(transport([[f('9/11/2026', 'h9')]]), 'S', '1/11/2026', { hashe: ['h1'] })).toEqual({ stan: 'brak' })
  })
})
