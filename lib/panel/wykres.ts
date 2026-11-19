// Geometria wykresu „miesiąc dzień po dniu” na pulpicie (port src/wykres_miesiaca.py z makiet).
// Zasady dataviz: jeden szereg, jeden kolor, jedna oś Y od zera, wartości tylko w podpowiedzi <title> (uwaga z 02.11: etykiety
// nad słupkami nachodziły na siebie), tabela pod wykresem. Czysta funkcja — test w wykres.test.ts.

export const W = 720
export const H = 220
const L = 52
const R = 8
const T = 22
const B = 26

/** Krok siatki 1/2/5 × 10^k tak, żeby było najwyżej 4 linie nad zerem. */
export function niceStep(max: number): number {
  if (max <= 0) return 1
  const raw = max / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

export interface Bar {
  day: number
  x: number
  w: number
  y: number
  path: string
  value: number
  today: boolean
}

export interface ChartGeom {
  grid: { y: number; value: number; base: boolean }[]
  bars: Bar[]
  ticks: { x: number; day: number; today: boolean }[]
  baseY: number
}

export function monthChart(values: { day: number; value: number; future: boolean }[], today: number): ChartGeom {
  const days = values.length
  const cw = (W - L - R) / Math.max(days, 1)
  const past = values.filter((v) => !v.future)
  const vmax = Math.max(0, ...past.map((v) => v.value))
  const step = niceStep(vmax)
  const top = step * (Math.floor(vmax / step) + 1)
  const y = (v: number) => T + (H - T - B) * (1 - v / top)
  const grid = Array.from({ length: Math.round(top / step) + 1 }, (_, k) => ({ y: y(k * step), value: k * step, base: k === 0 }))
  const bars: Bar[] = []
  const ticks: ChartGeom['ticks'] = []
  for (const v of values) {
    const x = L + (v.day - 1) * cw + 2
    const w = Math.max(1, cw - 4)
    // podpis osi co 5 dni + dziś; podpis za blisko dzisiejszego pomijamy (nachodziłyby na siebie)
    if (v.day === today || (v.day % 5 === 1 && Math.abs(v.day - today) > 1)) ticks.push({ x: x + w / 2, day: v.day, today: v.day === today })
    if (v.future) continue
    const yy = y(v.value)
    const r = Math.min(4, w / 2, Math.max(0, H - B - yy))
    const f = (n: number) => n.toFixed(1)
    const path = `M${f(x)},${H - B} V${f(yy + r)} Q${f(x)},${f(yy)} ${f(x + r)},${f(yy)} H${f(x + w - r)} Q${f(x + w)},${f(yy)} ${f(x + w)},${f(yy + r)} V${H - B} Z`
    bars.push({ day: v.day, x, w, y: yy, path, value: v.value, today: v.day === today })
  }
  return { grid, bars, ticks, baseY: H - B }
}

export const CHART = { W, H, L }
