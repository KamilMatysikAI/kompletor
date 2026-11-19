// zaszyfrowana fraza wyszukiwania klienta w adresie listy zamówień.
import { describe, expect, it } from 'vitest'
import { otworzFraze, otworzTokenFrazy, WAZNOSC_MS, zapieczetujFraze } from './fraza-token'

const ENV = { CUSTOMER_DATA_KEYS: `1:${'7'.repeat(64)}` }
const T = new Date('2026-11-06T10:00:00Z')

describe('token frazy klienta', () => {
  it('ta sama firma i osoba odczytują frazę; inna osoba, firma, termin albo zmiana tokenu = null; nazwiska nie ma w tokenie', () => {
    const t = zapieczetujFraze(ENV, 'org1', 'u1', 'Kowalska', T)
    expect(t).not.toMatch(/Kowalska/i)
    expect(otworzFraze(ENV, 'org1', 'u1', t, T)).toBe('Kowalska')
    expect(otworzFraze(ENV, 'org1', 'u2', t, T)).toBeNull()
    expect(otworzFraze(ENV, 'org2', 'u1', t, T)).toBeNull()
    expect(otworzFraze(ENV, 'org1', 'u1', t, new Date(T.getTime() + WAZNOSC_MS + 1))).toBeNull()
    // zmiana znaku w środku szyfrogramu (ostatni znak base64url niesie bity dopełnienia, jego zmiana bywa bez skutku)
    const i = t.lastIndexOf('.') + Math.floor((t.length - t.lastIndexOf('.')) / 2)
    const zmieniony = `${t.slice(0, i)}${t[i] === 'A' ? 'B' : 'A'}${t.slice(i + 1)}`
    expect(zmieniony).not.toBe(t)
    expect(otworzFraze(ENV, 'org1', 'u1', zmieniony, T)).toBeNull()
    expect(otworzFraze(ENV, 'org1', 'u1', 'śmieci', T)).toBeNull()
    expect(otworzFraze({}, 'org1', 'u1', t, T)).toBeNull()
  })

  it('flaga „także w danych klientów” jedzie w tokenie, bez niej false', () => {
    const z = zapieczetujFraze(ENV, 'org1', 'u1', 'Kowalska', T, { klienci: true })
    expect(otworzTokenFrazy(ENV, 'org1', 'u1', z, T)).toEqual({ fraza: 'Kowalska', klienci: true })
    expect(otworzTokenFrazy(ENV, 'org1', 'u1', zapieczetujFraze(ENV, 'org1', 'u1', 'Kowalska', T), T)).toEqual({ fraza: 'Kowalska', klienci: false })
    expect(otworzTokenFrazy(ENV, 'org1', 'u2', z, T)).toBeNull()
    expect(otworzFraze(ENV, 'org1', 'u1', z, T)).toBe('Kowalska')
  })
})
