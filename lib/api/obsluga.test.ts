// Obsługa klienta przez API, części bez bazy: wejście, limit na klucz, zakres klucza, normalizacja kontaktu.
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const { scopeRefusal } = await import('./klucze')
import { kontaktObslugi, warunekKont, warunekNumeru } from '@/lib/klienci/obsluga'
import { ApiInputError } from './odpowiedzi'
import { OBSLUGA_PER_HOUR, OBSLUGA_PER_MINUTE, obslugaLimit, parseObslugaWejscie, resetObslugaLimiters } from './obsluga'
import { parseApiKeyInput } from './zarzadzanie'
import { ALL_API_SCOPES, KOLEJNOSC_ZAKRESOW, OBSLUGA_SCOPE, type ApiScope } from './zakresy'

beforeEach(() => resetObslugaLimiters())

describe('obsługa klienta: kontakt', () => {
  it('e-mail: małe litery, bez spacji na brzegach, pełny adres z domeną', () => {
    expect(kontaktObslugi('email', '  Ala.Test@Example.TEST ')).toEqual({ rodzaj: 'email', wartosc: 'ala.test@example.test' })
    for (const v of ['ala', 'ala@', '@example.test', 'ala@example', 'a la@example.test', `${'a'.repeat(250)}@example.test`]) expect(kontaktObslugi('email', v), v).toBeNull()
  })

  it('telefon: te same cyfry w różnych zapisach dają tę samą wartość; litery i za krótki = brak', () => {
    const w = '48511000111'
    for (const v of ['511 000 111', '+48 511-000-111', '0048511000111', '(48) 511 000 111']) expect(kontaktObslugi('telefon', v)?.wartosc, v).toBe(w)
    for (const v of ['51100011', 'tel. 511000111', '511000111x', '1'.repeat(30)]) expect(kontaktObslugi('telefon', v), v).toBeNull()
  })

  it('warunek numeru: numer sklepu, numer widoczny i numer BL tylko dla liczby w zakresie', () => {
    expect(warunekNumeru('A-1')).toEqual({ OR: [{ externalId: 'A-1' }, { channelNumber: 'A-1' }] })
    expect(warunekNumeru('123')).toEqual({ OR: [{ externalId: '123' }, { channelNumber: '123' }, { blOrderId: 123 }] })
    expect(warunekNumeru('99999999999')).toEqual({ OR: [{ externalId: '99999999999' }, { channelNumber: '99999999999' }] })
    expect(warunekKont([{ konto: 'sd' }, { kanal: 'ALLEGRO', konto: 'a1' }])).toEqual({ OR: [{ channelAccountId: 'sd' }, { channelAccountId: 'a1', channel: 'ALLEGRO' }] })
  })
})

describe('obsługa klienta: wejście', () => {
  it('dokładnie jedno z email/telefon, domyślny limit, konta', () => {
    expect(parseObslugaWejscie({ email: 'a@example.test' }, 'zamowienia-klienta')).toEqual({ kontakt: { rodzaj: 'email', wartosc: 'a@example.test' }, konta: undefined, limit: 10 })
    expect(parseObslugaWejscie({ telefon: '511000111', limit: 3, konta: [{ kanal: 'WOO', konto: ' sd ' }] }, 'zamowienia-klienta')).toEqual({
      kontakt: { rodzaj: 'telefon', wartosc: '48511000111' },
      konta: [{ konto: 'sd', kanal: 'WOO' }],
      limit: 3,
    })
    expect(parseObslugaWejscie({ numer: 7700123, email: 'a@example.test' }, 'zamowienie')).toMatchObject({ numer: '7700123', limit: 20 })
    expect(parseObslugaWejscie({ numer: ' TEST-1 ', email: 'a@example.test' }, 'zamowienie')).toMatchObject({ numer: 'TEST-1' })
  })

  it('złe wejście = ApiInputError bez wartości z żądania w komunikacie', () => {
    const zle: [unknown, 'zamowienia-klienta' | 'zamowienie'][] = [
      [null, 'zamowienia-klienta'],
      [[], 'zamowienia-klienta'],
      [{}, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', telefon: '511000111' }, 'zamowienia-klienta'],
      [{ email: 'tajne-bez-malpy' }, 'zamowienia-klienta'],
      [{ email: 123 }, 'zamowienia-klienta'],
      [{ telefon: '99' }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', numer: '1' }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', limit: 0 }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', limit: 21 }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', limit: 2.5 }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', konta: [] }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', konta: [{}] }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', konta: [{ konto: 'x', kanal: 'AI-X' }] }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test', konta: Array.from({ length: 21 }, () => ({ konto: 'x' })) }, 'zamowienia-klienta'],
      [{ email: 'tajne@example.test' }, 'zamowienie'],
      [{ numer: '', email: 'tajne@example.test' }, 'zamowienie'],
      [{ numer: 'TAJNE NUMER', email: 'tajne@example.test' }, 'zamowienie'],
      [{ numer: -5, email: 'tajne@example.test' }, 'zamowienie'],
      [{ numer: 'x'.repeat(101), email: 'tajne@example.test' }, 'zamowienie'],
      [{ numer: 'A1', email: 'tajne@example.test', limit: 1 }, 'zamowienie'],
      [{ numer: 'A1', email: 'tajne@example.test', imie: 'TAJNE' }, 'zamowienie'],
    ]
    for (const [body, trasa] of zle) {
      let err: unknown
      try {
        parseObslugaWejscie(body, trasa)
      } catch (e) {
        err = e
      }
      expect(err, JSON.stringify(body)).toBeInstanceOf(ApiInputError)
      expect((err as Error).message.toLowerCase()).not.toContain('tajne')
    }
  })
})

describe('obsługa klienta: limit na klucz', () => {
  it(`${OBSLUGA_PER_MINUTE}/min i ${OBSLUGA_PER_HOUR}/h, osobno dla każdego klucza`, async () => {
    const t0 = Date.UTC(2026, 10, 15, 9)
    for (let i = 0; i < OBSLUGA_PER_MINUTE; i++) expect(obslugaLimit('k1', t0)).toBeNull()
    const r = obslugaLimit('k1', t0)
    expect(r?.status).toBe(429)
    expect(r?.headers.get('retry-after')).toBe('60')
    expect(obslugaLimit('k2', t0)).toBeNull()
    // po minucie znowu można, ale godzina ma swój limit
    let t = t0
    let ok = OBSLUGA_PER_MINUTE
    while (ok < OBSLUGA_PER_HOUR) {
      t += 61_000
      for (let i = 0; i < OBSLUGA_PER_MINUTE && ok < OBSLUGA_PER_HOUR; i++, ok++) expect(obslugaLimit('k1', t)).toBeNull()
    }
    const h = obslugaLimit('k1', t + 61_000)
    expect(h?.status).toBe(429)
    expect(h?.headers.get('retry-after')).toBe('600')
  })
})

describe('zakres obsługi klienta', () => {
  it('klucz tylko z tym zakresem; dotychczasowe zakresy łączą się jak dawniej', () => {
    expect(parseApiKeyInput({ name: 'Chatbot', scopes: [OBSLUGA_SCOPE] }).scopes).toEqual([OBSLUGA_SCOPE])
    expect(() => parseApiKeyInput({ name: 'x', scopes: [OBSLUGA_SCOPE, 'stany:odczyt'] })).toThrow(/nie może mieć innych zakresów/)
    expect(parseApiKeyInput({ name: 'x', scopes: [...ALL_API_SCOPES].reverse() }).scopes).toEqual(ALL_API_SCOPES)
    expect(ALL_API_SCOPES).not.toContain(OBSLUGA_SCOPE)
    expect(KOLEJNOSC_ZAKRESOW).toEqual([...ALL_API_SCOPES, OBSLUGA_SCOPE])
  })

  it('bramka: klucz obsługi tylko na trasach obsługi, inny klucz bez zakresu obsługi = 403', () => {
    const obsl = new Set<ApiScope>([OBSLUGA_SCOPE])
    expect(scopeRefusal(obsl, OBSLUGA_SCOPE)).toBeNull()
    for (const s of ALL_API_SCOPES) expect(scopeRefusal(obsl, s)?.status, s).toBe(403)
    // mieszany zestaw (warunek bazy go nie dopuszcza) dalej nie dostaje tras ogólnych
    const mieszany = new Set<ApiScope>([OBSLUGA_SCOPE, 'stany:odczyt'])
    expect(scopeRefusal(mieszany, 'stany:odczyt')?.status).toBe(403)
    const ogolny = new Set<ApiScope>(ALL_API_SCOPES)
    expect(scopeRefusal(ogolny, OBSLUGA_SCOPE)?.status).toBe(403)
    for (const s of ALL_API_SCOPES) expect(scopeRefusal(ogolny, s)).toBeNull()
  })
})
