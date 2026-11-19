// wyszukiwarka punktów InPost na nagranej odpowiedzi publicznego API punktów (tests/nagrania). Zero
// połączeń z InPost. Klient publicznego API: tylko GET jednej ścieżki z listy parametrów.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReadOnlyViolation } from '../zrodla/http'
import { assertPunktyReadOnly, INPOST_PUNKTY_URL, pobierzPunkty } from '../zrodla/inpost-punkty'
import { LIMIT_WYSZUKIWAN_NA_MINUTE, rodzajZapytania, szukajPunktow, wolnoSzukacPunktow } from './punkt-inpost'

const NAGRANIE = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/nagrania/inpost-punkty-poznan.json'), 'utf8')) as unknown

describe('rodzaj zapytania', () => {
  it.each([
    ['POZ08M', { rodzaj: 'nazwa', wartosc: 'POZ08M' }],
    ['waw93a', { rodzaj: 'nazwa', wartosc: 'WAW93A' }],
    ['60-001', { rodzaj: 'kod', wartosc: '60-001' }],
    ['60001', { rodzaj: 'kod', wartosc: '60-001' }],
    ['Poznań', { rodzaj: 'miasto', wartosc: 'Poznań' }],
    ['Bielsko-Biała', { rodzaj: 'miasto', wartosc: 'Bielsko-Biała' }],
  ])('„%s”', (f, w) => expect(rodzajZapytania(f)).toEqual(w))
  it.each(['', '   ', '../etc', 'a'.repeat(61), '<script>', 'Gdansk2', 'Krakow12'])('śmieci „%s” = null', (f) => expect(rodzajZapytania(f)).toBeNull())
})

describe('szukajPunktow na nagranej odpowiedzi', () => {
  it('miasto: parametr city, punkty z adresem, stanem i pobraniem; bez nazwy i ze złą nazwą pominięte', async () => {
    const zapytania: Record<string, string>[] = []
    const p = await szukajPunktow(async (q) => {
      zapytania.push(q)
      return NAGRANIE
    }, 'Poznań')
    expect(zapytania).toEqual([{ per_page: '20', city: 'Poznań' }])
    expect(p.map((x) => x.nazwa)).toEqual(['POZ99X', 'POZ98X', 'POZ97X'])
    expect(p[0]).toEqual({ nazwa: 'POZ99X', adres: 'ul. Testowa 1, 60-001 Poznań', opis: 'Przy wejściu do sklepu spożywczego', dziala: true, typy: ['parcel_locker'], pobranie: true })
    expect(p[1]).toMatchObject({ dziala: false, opis: null, pobranie: false, typy: ['parcel_locker', 'pop'] })
    expect(p[2]).toMatchObject({ adres: 'os. Zielone 3', typy: ['pop'], pobranie: null })
  })
  it('kod paczkomatu: parametr name; kod pocztowy: relative_post_code', async () => {
    const zapytania: Record<string, string>[] = []
    const pobierz = async (q: Record<string, string>) => {
      zapytania.push(q)
      return { items: [] }
    }
    await szukajPunktow(pobierz, 'poz08m')
    await szukajPunktow(pobierz, '60-001')
    expect(zapytania).toEqual([
      { per_page: '20', name: 'POZ08M' },
      { per_page: '20', relative_post_code: '60-001' },
    ])
  })
  it('nieczytelna odpowiedź = błąd, nie pusta lista; zła fraza = komunikat bez zapytania', async () => {
    await expect(szukajPunktow(async () => ({ count: 0 }), 'Poznań')).rejects.toThrow(/nieczytelna/)
    let wolano = false
    await expect(
      szukajPunktow(async () => {
        wolano = true
        return { items: [] }
      }, '<x>'),
    ).rejects.toThrow(/Wpisz kod paczkomatu/)
    expect(wolano).toBe(false)
  })
})

describe('klient publicznego API punktów: tylko odczyt', () => {
  it.each([
    ['POST', '/v1/points', {}],
    ['GET', '/v1/shipments', {}],
    ['GET', '/v1/points/POZ08M', {}],
    ['GET', '/v1/points', { token: 'x' }],
  ] as const)('%s %s %j = ReadOnlyViolation', (m, p, q) => expect(() => assertPunktyReadOnly(m, p, q as Record<string, string>)).toThrow(ReadOnlyViolation))

  it('GET na stały adres, bez nagłówka Authorization, bez przekierowań', async () => {
    const wywolania: { url: string; init?: RequestInit }[] = []
    const r = await pobierzPunkty({ city: 'Poznań', per_page: '20' }, async (url, init) => {
      wywolania.push({ url, init })
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    })
    expect(r).toEqual({ items: [] })
    expect(wywolania).toHaveLength(1)
    expect(wywolania[0]!.url).toBe(`${INPOST_PUNKTY_URL}/v1/points?city=Pozna%C5%84&per_page=20`)
    expect(wywolania[0]!.init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(JSON.stringify(wywolania[0]!.init?.headers)).not.toMatch(/Authorization/i)
  })
  it('5xx = błąd przejściowy, 400 = trwały', async () => {
    await expect(pobierzPunkty({ city: 'X' }, async () => new Response('', { status: 503 }))).rejects.toMatchObject({ retryable: true })
    await expect(pobierzPunkty({ city: 'X' }, async () => new Response('', { status: 400 }))).rejects.toMatchObject({ retryable: false })
  })
})

describe('limit wyszukiwań na firmę', () => {
  it('30 na minutę na firmę, druga firma ma własny licznik, po minucie znowu wolno', () => {
    const t = 1_900_000_000_000
    for (let i = 0; i < LIMIT_WYSZUKIWAN_NA_MINUTE; i++) expect(wolnoSzukacPunktow('firma-limit-a', t + i)).toBe(true)
    expect(wolnoSzukacPunktow('firma-limit-a', t + 100)).toBe(false)
    expect(wolnoSzukacPunktow('firma-limit-b', t + 100)).toBe(true)
    expect(wolnoSzukacPunktow('firma-limit-a', t + 61_000)).toBe(true)
  })
})
