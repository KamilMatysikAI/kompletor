// kod stanowiska druku generowany z nazwy (Ustawienia → Druk).
import { describe, expect, it } from 'vitest'
import { kodZNazwy, WZOR_KODU_STANOWISKA } from './role'

describe('kodZNazwy', () => {
  it('polskie znaki, spacje i znaki specjalne', () => {
    expect(kodZNazwy('Pakowanie przy oknie')).toBe('pakowanie-przy-oknie')
    expect(kodZNazwy('Łódź — magazyn nr 2')).toBe('lodz-magazyn-nr-2')
    expect(kodZNazwy('  Żółć!!! ')).toBe('zolc')
  })
  it('pusta albo bez liter i cyfr = „stanowisko”, wynik zawsze pasuje do wzorca kodu', () => {
    expect(kodZNazwy('—')).toBe('stanowisko')
    for (const n of ['a'.repeat(80), 'x — y', 'ąęśćżźńół', '123']) expect(kodZNazwy(n)).toMatch(WZOR_KODU_STANOWISKA)
    expect(kodZNazwy('a '.repeat(60)).length).toBeLessThanOrEqual(46)
  })
})
