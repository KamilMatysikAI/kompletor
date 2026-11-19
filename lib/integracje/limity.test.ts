// kubełek żetonów (czysta część, bez bazy). Przeniesione z testu integracyjnego.
import { describe, expect, it } from 'vitest'
import { zabierzZeton } from './limity'

describe('kubełek żetonów (czysta część)', () => {
  it('pełna minuta na start, potem uzupełnianie liniowe; brak żetonu = czas do następnego', () => {
    let s = null as ReturnType<typeof zabierzZeton>['stan'] | null
    for (let i = 0; i < 120; i++) {
      const r = zabierzZeton(s, 120, 0)
      expect(r.granted).toBe(true)
      s = r.stan
    }
    const odmowa = zabierzZeton(s, 120, 0)
    expect(odmowa).toMatchObject({ granted: false, retryAfterMs: 500 })
    expect(zabierzZeton(odmowa.stan, 120, 500).granted).toBe(true)
  })

  it('zegar, który stoi, nie uzupełnia kubełka (dlatego osłona odkłada od razu)', () => {
    let s = null as ReturnType<typeof zabierzZeton>['stan'] | null
    for (let i = 0; i < 30; i++) s = zabierzZeton(s, 30, 1_000).stan
    expect(zabierzZeton(s, 30, 1_000).granted).toBe(false)
    expect(zabierzZeton(zabierzZeton(s, 30, 1_000).stan, 30, 1_000).granted).toBe(false)
  })
})
