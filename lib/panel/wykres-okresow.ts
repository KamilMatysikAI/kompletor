// geometria wykresu słupkowego „sprzedaż w okresach” (ekran Raporty). Zasady dataviz jak wykres miesiąca
// (lib/panel/wykres.ts): jeden szereg, jeden kolor, jedna oś Y od zera, zaokrąglone końce słupków przy wartości, wartości
// w podpowiedzi i w tabeli pod wykresem (bez liczb nad słupkami), podpisy osi X rzadsze przy wielu okresach.
// Czysta funkcja — test w wykres-okresow.test.ts.
import { niceStep } from './wykres'

export const WO = { W: 720, H: 220, L: 84, R: 8, T: 16, B: 26 }

export interface SlupekOkresu {
  i: number
  x: number
  w: number
  path: string
  wartosc: number
  podpis: string
  /** podpis osi pod tym słupkiem (co k-ty okres, zawsze pierwszy i ostatni nie nachodzą na siebie) */
  os: boolean
}

export function wykresOkresow(wartosci: { podpis: string; wartosc: number }[], maksPodpisow = 8): { siatka: { y: number; wartosc: number; baza: boolean }[]; slupki: SlupekOkresu[]; bazaY: number } {
  const n = Math.max(1, wartosci.length)
  const cw = (WO.W - WO.L - WO.R) / n
  const vmax = Math.max(0, ...wartosci.map((v) => v.wartosc))
  const step = niceStep(vmax)
  const top = step * (Math.floor(vmax / step) + 1)
  const y = (v: number) => WO.T + (WO.H - WO.T - WO.B) * (1 - Math.max(0, v) / top)
  const siatka = Array.from({ length: Math.round(top / step) + 1 }, (_, k) => ({ y: y(k * step), wartosc: k * step, baza: k === 0 }))
  const co = Math.max(1, Math.ceil(n / maksPodpisow))
  const f = (v: number) => v.toFixed(1)
  const bazaY = WO.H - WO.B
  const slupki = wartosci.map((v, i) => {
    const gap = cw > 8 ? 2 : 1 // odstęp 2 px między słupkami (powierzchnia), przy bardzo wąskich 1 px
    const x = WO.L + i * cw + gap
    const w = Math.max(1, cw - 2 * gap)
    const yy = y(v.wartosc)
    const r = Math.min(4, w / 2, Math.max(0, bazaY - yy))
    const path = v.wartosc > 0 ? `M${f(x)},${bazaY} V${f(yy + r)} Q${f(x)},${f(yy)} ${f(x + r)},${f(yy)} H${f(x + w - r)} Q${f(x + w)},${f(yy)} ${f(x + w)},${f(yy + r)} V${bazaY} Z` : ''
    return { i, x, w, path, wartosc: v.wartosc, podpis: v.podpis, os: i % co === 0 }
  })
  return { siatka, slupki, bazaY }
}
