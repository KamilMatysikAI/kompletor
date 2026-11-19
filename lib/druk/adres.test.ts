import { describe, expect, it } from 'vitest'
import { ostrzezenieAdresuSerwera } from './adres'

describe('ostrzezenieAdresuSerwera', () => {
  it('https i adresy lokalne bez ostrzeżenia', () => {
    expect(ostrzezenieAdresuSerwera('https://kompletor.example.invalid')).toBeNull()
    expect(ostrzezenieAdresuSerwera('http://localhost:3000')).toBeNull()
    expect(ostrzezenieAdresuSerwera('http://127.0.0.1:3000')).toBeNull()
  })

  it('http poza komputerem lokalnym i adres nieczytelny = ostrzeżenie', () => {
    expect(ostrzezenieAdresuSerwera('http://192.168.1.10:3000')).toMatch(/bez https.*instalator go odrzuci/)
    expect(ostrzezenieAdresuSerwera('http://kompletor.example.invalid')).toMatch(/https:\/\//)
    expect(ostrzezenieAdresuSerwera('nie-adres')).toMatch(/Nie udało się ustalić adresu/)
  })
})
