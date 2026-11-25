// kubełek żetonów (czysta część, bez bazy). Przeniesione z testu integracyjnego.
import { describe, expect, it } from 'vitest'
import { rezerwaKubelka, zabierzZeton } from './limity'

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

  it('rezerwa: odczyt w tle bierze żeton tylko ponad nią; czas do żetonu liczony do progu rezerwy', () => {
    expect(rezerwaKubelka(30)).toBe(10)
    expect(rezerwaKubelka(2)).toBe(0)
    let s = null as ReturnType<typeof zabierzZeton>['stan'] | null
    for (let i = 0; i < 20; i++) {
      const r = zabierzZeton(s, 30, 0, 10)
      expect(r.granted).toBe(true)
      s = r.stan
    }
    const odmowa = zabierzZeton(s, 30, 0, 10)
    expect(odmowa).toMatchObject({ granted: false, retryAfterMs: 2_000 })
    // bez rezerwy (zapis, panel) ten sam kubełek ma jeszcze 10 żetonów
    expect(zabierzZeton(odmowa.stan, 30, 0).granted).toBe(true)
    expect(zabierzZeton(odmowa.stan, 30, 2_000, 10).granted).toBe(true)
  })
})
