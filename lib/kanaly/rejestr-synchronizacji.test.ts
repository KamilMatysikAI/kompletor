// czysta decyzja rejestru synchronizacji (SYNC / UPDATE / SKIP / RETRY) i skrót treści zapisu stanu.
import { describe, expect, it } from 'vitest'
import { decyzja, pelnyZapisCoGodz, skrotTresci, trescKanoniczna, type WpisRejestru } from './rejestr-synchronizacji'

const T = new Date('2026-12-10T10:00:00Z')
const H = 3600_000
const tresc = { adapterKey: 'woo.rest.zapis.v1', offerExternalId: '10', qty: 5, productId: 'p1', qtyBasePerOffer: 1 }
const S = skrotTresci(tresc)
const ok = (over: Partial<WpisRejestru> = {}): WpisRejestru => ({ contentHash: S, syncedAt: new Date(T.getTime() - H), failures: 0, lastError: null, ...over })
const o = { now: T, maksWiekMs: 24 * H }

describe('skrót treści', () => {
  it('ta sama treść = ten sam skrót; każde pole zmienia skrót', () => {
    expect(skrotTresci({ ...tresc })).toBe(S)
    expect(S).toMatch(/^[0-9a-f]{64}$/)
    for (const zmiana of [{ qty: 4 }, { offerExternalId: '11' }, { productId: 'p2' }, { qtyBasePerOffer: 2 }, { adapterKey: 'woo.rest.v1' }]) expect(skrotTresci({ ...tresc, ...zmiana })).not.toBe(S)
  })

  it('postać kanoniczna nie zależy od kolejności pól i nie skleja wartości', () => {
    const odwrotnie = { qtyBasePerOffer: 1, productId: 'p1', qty: 5, offerExternalId: '10', adapterKey: 'woo.rest.zapis.v1' }
    expect(trescKanoniczna(odwrotnie)).toBe(trescKanoniczna(tresc))
    expect(skrotTresci({ ...tresc, offerExternalId: '1', qty: 55 })).not.toBe(skrotTresci({ ...tresc, offerExternalId: '15', qty: 5 }))
  })
})

describe('decyzja', () => {
  it('SYNC: brak wpisu (pierwszy przebieg po wdrożeniu wysyła wszystko jak dawniej)', () => {
    expect(decyzja(null, S, o)).toBe('SYNC')
  })

  it('SKIP: ta sama treść co ostatni udany zapis, w terminie siatki', () => {
    expect(decyzja(ok(), S, o)).toBe('SKIP')
  })

  it('UPDATE: inna treść', () => {
    expect(decyzja(ok(), skrotTresci({ ...tresc, qty: 4 }), o)).toBe('UPDATE')
  })

  it('RETRY: ostatni zapis nieudany (skrót pusty z błędem albo licznikiem porażek)', () => {
    expect(decyzja(ok({ contentHash: null, lastError: 'PRZEJSCIOWY: 503' }), S, o)).toBe('RETRY')
    expect(decyzja(ok({ contentHash: null, failures: 2 }), S, o)).toBe('RETRY')
  })

  it('skrót pusty bez śladu błędu (przebieg przerwany po skasowaniu) nie pomija', () => {
    expect(decyzja(ok({ contentHash: null }), S, o)).toBe('UPDATE')
  })

  it('zapis wymuszony nigdy nie pomija', () => {
    expect(decyzja(ok(), S, { ...o, wymuszony: true })).toBe('SYNC')
  })

  it('siatka: skrót starszy niż odstęp pełnego zapisu = SYNC', () => {
    expect(decyzja(ok({ syncedAt: new Date(T.getTime() - 24 * H) }), S, o)).toBe('SYNC')
    expect(decyzja(ok({ syncedAt: new Date(T.getTime() - 23 * H) }), S, o)).toBe('SKIP')
    expect(decyzja(ok({ syncedAt: null }), S, o)).toBe('SYNC')
  })

  it('zmiana konta po zapisie (tryb, wyłącznik, ustawienia) = SYNC', () => {
    expect(decyzja(ok(), S, { ...o, kontoZmienioneAt: new Date(T.getTime() - H / 2) })).toBe('SYNC')
    expect(decyzja(ok(), S, { ...o, kontoZmienioneAt: new Date(T.getTime() - 2 * H) })).toBe('SKIP')
  })
})

describe('odstęp pełnego zapisu z konfiguracji konta', () => {
  it('domyślnie 24 h; poprawne 1–168; śmieci = domyślnie', () => {
    expect(pelnyZapisCoGodz({})).toBe(24)
    expect(pelnyZapisCoGodz(null)).toBe(24)
    expect(pelnyZapisCoGodz({ pelnyZapisStanowCoGodz: 6 })).toBe(6)
    expect(pelnyZapisCoGodz({ pelnyZapisStanowCoGodz: '12' })).toBe(12)
    for (const zle of [0, -1, 169, 2.5, 'abc', '', true]) expect(pelnyZapisCoGodz({ pelnyZapisStanowCoGodz: zle })).toBe(24)
  })
})
