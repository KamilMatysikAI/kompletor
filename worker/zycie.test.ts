import { describe, expect, it } from 'vitest'
import { loopAlive, MAX_TICK_AGE_MS } from './zycie'

describe('plik życia workera', () => {
  const t0 = Date.parse('2026-11-01T10:00:00Z')

  it('świeży obrót pętli = zapis', () => {
    expect(loopAlive(t0, t0)).toBe(true)
    expect(loopAlive(t0 + 30_000, t0)).toBe(true)
  })

  it('długie zadanie (import) do 2 h nie gasi pliku życia', () => {
    expect(MAX_TICK_AGE_MS).toBe(2 * 3600_000)
    expect(loopAlive(t0 + MAX_TICK_AGE_MS - 1, t0)).toBe(true)
  })

  it('pętla stoi 2 h i dłużej (np. zawieszone połączenie z bazą) = bez zapisu, healthcheck kontenera padnie', () => {
    expect(loopAlive(t0 + MAX_TICK_AGE_MS, t0)).toBe(false)
    expect(loopAlive(t0 + 3 * 3600_000, t0)).toBe(false)
  })

  it('własny limit', () => {
    expect(loopAlive(t0 + 999, t0, 1000)).toBe(true)
    expect(loopAlive(t0 + 1000, t0, 1000)).toBe(false)
  })
})
