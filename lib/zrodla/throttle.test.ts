// Throttle (lib/zrodla/http.ts): odstęp liczony od faktycznego startu poprzedniego wywołania, rezerwacja terminu dla
// wywołań równoległych. Przegląd poprawki be82aae, osobny test zamiast pilnowania tylko
// progiem 490 ms w teście Shopera.
import { describe, expect, it } from 'vitest'
import { sleep, Throttle } from './http'

const I = 120 // ms; krótko, żeby test był szybki, i z zapasem wobec rozdzielczości zegara

describe('Throttle', () => {
  it('trzy równoległe wait(): starty w kolejności wywołań, odstępy faktycznych startów ≥ interwał', async () => {
    const t = new Throttle(I)
    const starty: { nr: number; at: number }[] = []
    await Promise.all([1, 2, 3].map((nr) => t.wait().then(() => starty.push({ nr, at: Date.now() }))))
    expect(starty.map((s) => s.nr)).toEqual([1, 2, 3])
    for (let i = 1; i < starty.length; i++) expect(starty[i]!.at - starty[i - 1]!.at).toBeGreaterThanOrEqual(I - 5) // pomiar po wait(), kilka ms po faktycznym starcie
  })

  it('wywołania po kolei z pracą między nimi: odstęp liczony od faktycznego startu, nie od rezerwacji', async () => {
    const t = new Throttle(I)
    await t.wait()
    const pierwszy = Date.now()
    await sleep(I + 30) // praca dłuższa niż interwał: drugie wywołanie startuje od razu
    const przed = Date.now()
    await t.wait()
    expect(Date.now() - przed).toBeLessThan(I)
    const drugi = Date.now()
    await t.wait()
    expect(Date.now() - drugi).toBeGreaterThanOrEqual(I - 5)
    expect(drugi - pierwszy).toBeGreaterThanOrEqual(I)
  })

  it('interwał 0: bez czekania', async () => {
    const t = new Throttle(0)
    const s = Date.now()
    await Promise.all([t.wait(), t.wait(), t.wait()])
    expect(Date.now() - s).toBeLessThan(50)
  })
})
