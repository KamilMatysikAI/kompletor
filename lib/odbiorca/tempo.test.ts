// Odstęp odczytów odbiorcy konta: zegar i sen wstrzyknięte, bez realnego czekania.
import { describe, expect, it } from 'vitest'
import { MIRAKL_EMPIK_MANIFEST } from '../adaptery/mirakl-empik'
import { TempoOdbiorcy, TempoPrzekroczone } from './tempo'

function zegar() {
  let t = 1_000_000
  const sny: number[] = []
  const tempo = new TempoOdbiorcy(
    () => t,
    async (ms) => {
      sny.push(ms)
      t += ms
    },
  )
  return { tempo, sny, uplyw: (ms: number) => (t += ms) }
}

describe('TempoOdbiorcy', () => {
  it('dwa odczyty Empiku pod rząd: drugi czeka pełny odstęp OR11 (60 s z manifestu)', async () => {
    const odstep = MIRAKL_EMPIK_MANIFEST.rateLimit.recipientMinIntervalMs!
    expect(odstep).toBe(60_000)
    const { tempo, sny } = zegar()
    await tempo.czekaj('org-a:EMPIK/empik', odstep)
    await tempo.czekaj('org-a:EMPIK/empik', odstep)
    expect(sny).toEqual([60_000])
  })

  it('po upływie odstępu bez czekania; inne konto ma własne okno', async () => {
    const { tempo, sny, uplyw } = zegar()
    await tempo.czekaj('a', 60_000)
    await tempo.czekaj('b', 60_000)
    uplyw(60_000)
    await tempo.czekaj('a', 60_000)
    expect(sny).toEqual([])
  })

  it('wywołania równoległe ustawiają się w kolejce (rezerwacja przed snem)', async () => {
    const sny: number[] = []
    const tempo = new TempoOdbiorcy(() => 0, async (ms) => void sny.push(ms))
    await Promise.all([tempo.czekaj('a', 1_000, 10_000), tempo.czekaj('a', 1_000, 10_000), tempo.czekaj('a', 1_000, 10_000)])
    expect(sny).toEqual([1_000, 2_000])
  })

  it('czekanie dłuższe niż limit (domyślnie jeden odstęp): TempoPrzekroczone bez rezerwacji okna', async () => {
    const tempo = new TempoOdbiorcy(() => 0, async () => undefined)
    await tempo.czekaj('a', 60_000)
    await tempo.czekaj('a', 60_000) // okno za 60 s mieści się w limicie
    await expect(tempo.czekaj('a', 60_000)).rejects.toBeInstanceOf(TempoPrzekroczone) // okno za 120 s
    await expect(tempo.czekaj('a', 60_000)).rejects.toBeInstanceOf(TempoPrzekroczone) // nadal 120 s: odmowa nie rezerwuje
    await expect(tempo.czekaj('a', 60_000, 120_000)).resolves.toBeUndefined()
  })

  it('odstęp 0 albo brak (Woo, Allegro) = bez czekania i bez wpisu', async () => {
    const { tempo, sny } = zegar()
    for (let i = 0; i < 5; i++) await tempo.czekaj('woo', 0)
    expect(sny).toEqual([])
  })
})
