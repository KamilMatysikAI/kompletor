import { describe, expect, it } from 'vitest'
import { monthChart, niceStep } from './wykres'

describe('wykres miesiąca', () => {
  it('krok siatki 1/2/5 × 10^k, najwyżej 4 linie nad zerem', () => {
    expect(niceStep(29)).toBe(10)
    expect(niceStep(1863)).toBe(500)
    expect(niceStep(0)).toBe(1)
    expect(niceStep(3)).toBe(1)
  })

  it('słupki tylko do dziś, oś od zera', () => {
    const vals = Array.from({ length: 31 }, (_, i) => ({ day: i + 1, value: i + 1 === 12 ? 27 : 10, future: i + 1 > 22 }))
    const g = monthChart(vals, 22)
    expect(g.bars).toHaveLength(22)
    expect(g.grid[0]).toMatchObject({ value: 0, base: true })
    expect(g.ticks.map((t) => t.day)).toEqual([1, 6, 11, 16, 22, 26, 31])
    const top = g.grid.at(-1)!.value
    expect(top).toBeGreaterThan(27)
  })

  it('pusty miesiąc nie dzieli przez zero', () => {
    const g = monthChart([{ day: 1, value: 0, future: false }], 1)
    expect(g.bars[0]!.y).toBeLessThanOrEqual(g.baseY)
    expect(Number.isFinite(g.bars[0]!.y)).toBe(true)
  })
})
