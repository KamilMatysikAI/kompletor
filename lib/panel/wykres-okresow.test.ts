// geometria wykresu okresów — oś od zera, słupki w obszarze wykresu, rzadkie podpisy, zero bez słupka.
import { describe, expect, it } from 'vitest'
import { WO, wykresOkresow } from './wykres-okresow'

describe('wykresOkresow', () => {
  it('oś Y od zera z zapasem nad maksimum, słupki w obszarze, zero bez ścieżki', () => {
    const g = wykresOkresow([{ podpis: '1', wartosc: 0 }, { podpis: '2', wartosc: 950 }, { podpis: '3', wartosc: 300 }])
    expect(g.siatka[0]).toMatchObject({ wartosc: 0, baza: true, y: WO.H - WO.B })
    expect(g.siatka.at(-1)!.wartosc).toBeGreaterThan(950)
    expect(g.slupki[0]!.path).toBe('')
    for (const s of g.slupki) {
      expect(s.x).toBeGreaterThanOrEqual(WO.L)
      expect(s.x + s.w).toBeLessThanOrEqual(WO.W - WO.R + 0.01)
    }
    expect(g.slupki[1]!.path).toMatch(/^M/)
  })

  it('przy 92 okresach najwyżej 8 podpisów osi, pierwszy zawsze', () => {
    const g = wykresOkresow(Array.from({ length: 92 }, (_, i) => ({ podpis: String(i), wartosc: i })))
    const os = g.slupki.filter((s) => s.os)
    expect(os.length).toBeLessThanOrEqual(8)
    expect(os[0]!.i).toBe(0)
  })

  it('wszystkie zera: siatka 0 i jeden krok, bez dzielenia przez zero', () => {
    const g = wykresOkresow([{ podpis: 'a', wartosc: 0 }])
    expect(g.siatka.map((s) => s.wartosc)).toEqual([0, 1])
    expect(g.slupki[0]!.path).toBe('')
  })
})
