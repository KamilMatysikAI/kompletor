import { describe, expect, it } from 'vitest'
import { clientIp, Semaphore, SlidingLimiter } from './limiter'

describe('limit prób logowania per IP', () => {
  it('20 prób w 60 s przechodzi, 21. nie; po oknie znowu wolno; inne IP osobno', () => {
    const l = new SlidingLimiter(20, 60_000)
    for (let i = 0; i < 20; i++) expect(l.hit('1.1.1.1', 1000 + i)).toBe(true)
    expect(l.hit('1.1.1.1', 2000)).toBe(false)
    expect(l.hit('2.2.2.2', 2000)).toBe(true)
    expect(l.hit('1.1.1.1', 1000 + 60_001)).toBe(true)
  })

  it('liczba kluczy ograniczona (atak z wielu adresów nie zjada pamięci)', () => {
    const l = new SlidingLimiter(5, 60_000, 100)
    for (let i = 0; i < 1000; i++) l.hit(`ip-${i}`, 1000)
    expect((l as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThanOrEqual(100)
  })

  it('IP klienta: ostatni wpis X-Forwarded-For (dopisany przez nasze proxy), potem X-Real-IP', () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null })
    expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 10.0.0.1, 203.0.113.7' }))).toBe('203.0.113.7')
    expect(clientIp(h({ 'x-real-ip': ' 198.51.100.2 ' }))).toBe('198.51.100.2')
    expect(clientIp(h({}))).toBe('nieznany')
  })
})

describe('semafor argon2', () => {
  it('najwyżej 4 zadania naraz, reszta czeka i wszystkie się kończą', async () => {
    const s = new Semaphore(4)
    let now = 0
    let peak = 0
    const job = () =>
      s.run(async () => {
        now++
        peak = Math.max(peak, now)
        await new Promise((r) => setTimeout(r, 5))
        now--
        return 1
      })
    const out = await Promise.all(Array.from({ length: 20 }, job))
    expect(out).toHaveLength(20)
    expect(peak).toBe(4)
    expect(s.running).toBe(0)
  })

  it('zwalniający przekazuje miejsce czekającemu bez zejścia poniżej limitu (nikt nie wciśnie się w lukę)', async () => {
    const s = new Semaphore(1)
    let seen = -1
    let release!: () => void
    const held = s.run(() => new Promise<void>((r) => (release = r)))
    // czekający wpisany ręcznie: zostaje wybudzony synchronicznie w finally, więc widzi licznik w chwili przekazania
    ;(s as unknown as { queue: (() => void)[] }).queue.push(() => (seen = s.running))
    release()
    await held
    expect(seen).toBe(1)
  })

  it('błąd w zadaniu zwalnia miejsce', async () => {
    const s = new Semaphore(1)
    await expect(s.run(async () => { throw new Error('x') })).rejects.toThrow('x')
    await expect(s.run(async () => 2)).resolves.toBe(2)
  })
})
