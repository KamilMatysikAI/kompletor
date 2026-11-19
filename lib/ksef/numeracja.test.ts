// okresy i format numerów (bez bazy). Atomowość i brak dziur: tests/ksef-szkice.integration.test.ts.
import { describe, expect, it } from 'vitest'
import { formatujNumer, kluczOkresu, problemySerii } from './numeracja'

describe('numeracja', () => {
  it('klucz okresu: rok, miesiąc, bez resetu', () => {
    expect(kluczOkresu('ROK', '2026-11-02')).toBe('2026')
    expect(kluczOkresu('MIESIAC', '2026-11-02')).toBe('2026-11')
    expect(kluczOkresu('NIGDY', '2026-11-02')).toBe('-')
    expect(() => kluczOkresu('ROK', '2026-02-30')).toThrow()
  })

  it('format numeru ze wzorca', () => {
    expect(formatujNumer('FV/{NR}/{MM}/{RRRR}', 17, '2026-11-02')).toBe('FV/17/11/2026')
    expect(formatujNumer('{RR}-{DD}-{NR}', 3, '2026-01-09')).toBe('26-09-3')
  })

  it('definicja serii: {NR} obowiązkowy, reset wymaga okresu we wzorcu', () => {
    expect(problemySerii({ code: 'FV', pattern: 'FV/{NR}/{MM}/{RRRR}', resetPeriod: 'MIESIAC' })).toEqual([])
    expect(problemySerii({ code: 'FV', pattern: 'FV/{NR}/{RRRR}', resetPeriod: 'ROK' })).toEqual([])
    expect(problemySerii({ code: 'FV', pattern: 'FV/{NR}', resetPeriod: 'NIGDY' })).toEqual([])
    expect(problemySerii({ code: 'FV', pattern: 'FV/{MM}', resetPeriod: 'NIGDY' })).toEqual(['wzorzec numeru bez numeru ({NR} albo %N)'])
    expect(problemySerii({ code: 'FV', pattern: 'FV/{NR}/{RRRR}', resetPeriod: 'MIESIAC' })).toHaveLength(1)
    expect(problemySerii({ code: 'FV', pattern: 'FV/{NR}', resetPeriod: 'ROK' })).toHaveLength(1)
    expect(problemySerii({ code: 'zła seria', pattern: 'FV/{NR}', resetPeriod: 'NIGDY' })).toHaveLength(1)
  })

  it('wzór jak w BaseLinkerze (%N/%M/%Y, korekty %N/%M/%Y/K), mieszany z klamrami', () => {
    expect(formatujNumer('%N/%M/%Y', 7, '2026-11-09')).toBe('7/11/2026')
    expect(formatujNumer('%N/%M/%Y/K', 2, '2026-11-09')).toBe('2/11/2026/K')
    expect(formatujNumer('FV %N/{MM}/%y', 12, '2026-03-01')).toBe('FV 12/03/26')
    expect(problemySerii({ code: 'FV', pattern: '%N/%M/%Y', resetPeriod: 'MIESIAC' })).toEqual([])
    expect(problemySerii({ code: 'KOR', pattern: '%N/%M/%Y/K', resetPeriod: 'ROK' })).toEqual([])
    expect(problemySerii({ code: 'FV', pattern: '%N/%Q', resetPeriod: 'NIGDY' })).toEqual(['nieznany znacznik z % we wzorcu (dozwolone %N, %M, %Y, %D, %y)'])
    expect(problemySerii({ code: 'FV', pattern: '%N', resetPeriod: 'MIESIAC' })).toHaveLength(1)
  })
})
