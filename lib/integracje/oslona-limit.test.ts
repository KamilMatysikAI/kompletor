// Osłona hosta a limit tempa konta: zapis z panelu czeka krótko na żeton, zapis z tła odkładany od razu, odczyt w tle
// zostawia rezerwę kubełka konta dla zapisów i nie jest przy tym głodzony. Kubełek w pamięci tą samą czystą regułą co
// zapytanie w Postgresie (`zabierzZeton`); samo zapytanie sprawdza test integracyjny limitów.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { Capability, ChannelAdapter, RateLimit } from '../adaptery/kontrakt'
import type { StanKubelka } from './limity'

const h = vi.hoisted(() => ({ kubelki: new Map<string, StanKubelka | null>() }))

vi.mock('./zdrowie', async (orig) => ({
  ...(await orig<typeof import('./zdrowie')>()),
  stanKonta: vi.fn(async () => null),
  zapiszSukces: vi.fn(async () => undefined),
  zapiszPorazke: vi.fn(async () => ({ wylaczono: false, porazki: 1 })),
}))

vi.mock('./limity', async (orig) => {
  const m = await orig<typeof import('./limity')>()
  const zajmij = (klucz: string, zakres: string, perMinute: number, now: Date, rezerwa: number) => {
    const k = `${klucz}|${zakres}`
    const r = m.zabierzZeton(h.kubelki.get(k) ?? null, perMinute, now.getTime(), rezerwa)
    h.kubelki.set(k, r.stan)
    return r
  }
  return {
    ...m,
    sprawdzLimit: vi.fn(async (_db: unknown, klucz: string, rate: RateLimit, cap: Capability | null, now: Date, opts: { rezerwaKonta?: boolean } = {}) => {
      const lc = cap ? rate.perCapability?.[cap] : undefined
      if (lc) {
        const r = zajmij(klucz, cap!, lc.requestsPerMinute, now, 0)
        if (!r.granted) return { granted: false, retryAfterMs: r.retryAfterMs, zakres: cap!, perMinute: lc.requestsPerMinute }
      }
      const k = zajmij(klucz, m.ZAKRES_KONTA, rate.requestsPerMinute, now, opts.rezerwaKonta ? m.rezerwaKubelka(rate.requestsPerMinute) : 0)
      if (!k.granted) {
        if (lc) {
          const s = h.kubelki.get(`${klucz}|${cap}`)!
          h.kubelki.set(`${klucz}|${cap}`, { tokens: Math.min(lc.requestsPerMinute, s.tokens + 1), at: s.at })
        }
        return { granted: false, retryAfterMs: k.retryAfterMs, zakres: m.ZAKRES_KONTA, perMinute: rate.requestsPerMinute }
      }
      return { granted: true, retryAfterMs: 0 }
    }),
  }
})

const { oslonAdapter, LimitTempaError, CZEKANIE_ZAPISU_MS } = await import('./oslona')

const KLUCZ = 'przewoznik:test'
const konto = { klucz: KLUCZ, rodzaj: 'carrier', nazwa: 'Przewoźnik testowy' } as const

interface Atrapa {
  create: number
  track: number
  label: number
}

function atrapa(rate: RateLimit): { adapter: ChannelAdapter; licz: Atrapa } {
  const licz: Atrapa = { create: 0, track: 0, label: 0 }
  const adapter = {
    manifest: { adapterKey: 'atrapa.v1', rateLimit: rate },
    testConnection: async () => ({ ok: true, message: 'ok' }),
    createShipment: async (_req: unknown, reference: string) => {
      licz.create++
      return { kind: 'OK', reference, externalRef: `X${licz.create}` }
    },
    getLabel: async () => {
      licz.label++
      return { contentType: 'application/pdf', base64: 'JVBERi0=' }
    },
    trackShipment: async () => {
      licz.track++
      return { stan: 'PRZEKAZANA', status: 'w drodze' }
    },
  }
  return { adapter: adapter as unknown as ChannelAdapter, licz }
}

type Wolajacy = ChannelAdapter & {
  createShipment: (req: unknown, reference: string) => Promise<{ kind: string }>
  trackShipment: (ref: string) => Promise<unknown>
  getLabel: (ref: string, f: string) => Promise<unknown>
}

/** Zegar testu: płynie tylko przez sen osłony (`opoznienie` = ile czasu mija w trakcie snu, domyślnie tyle, o ile prosi). */
function zegar() {
  const z = { teraz: 1_000_000, sny: [] as number[], poSnie: null as null | (() => void) }
  return {
    z,
    now: () => new Date(z.teraz),
    sleep: async (ms: number) => {
      z.sny.push(ms)
      z.teraz += ms
      z.poSnie?.()
    },
  }
}

const RATE_30: RateLimit = { requestsPerMinute: 30, maxConcurrent: 1, minPollIntervalMs: 0 }
const db = {} as PrismaClient
const pusty = (teraz: number) => h.kubelki.set(`${KLUCZ}|*`, { tokens: 0, at: teraz })

beforeEach(() => h.kubelki.clear())

describe('zapis z panelu (interaktywne) przy wyczerpanym limicie konta', () => {
  it('czeka na żeton i przechodzi: jedno wywołanie przewoźnika, bez drugiej paczki', async () => {
    const { adapter, licz } = atrapa(RATE_30)
    const c = zegar()
    pusty(c.z.teraz)
    const a = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep, interaktywne: true })) as Wolajacy
    const w = await a.createShipment({}, 'ref-1')
    expect(w.kind).toBe('OK')
    expect(licz.create).toBe(1)
    expect(c.z.sny).toEqual([2_000]) // 30/min = 1 żeton na 2 s
  })

  it('nie czeka dłużej niż próg: żeton za daleko = komunikat od razu, bez snu i bez żądania', async () => {
    const { adapter, licz } = atrapa({ ...RATE_30, requestsPerMinute: 3 }) // 1 żeton na 20 s > 10 s
    const c = zegar()
    pusty(c.z.teraz)
    const a = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep, interaktywne: true })) as Wolajacy
    await expect(a.createShipment({}, 'ref-1')).rejects.toBeInstanceOf(LimitTempaError)
    expect(licz.create).toBe(0)
    expect(c.z.sny).toEqual([])
  })

  it('próg liczy się łącznie: żeton zabrany przez inny proces w trakcie snu nie przedłuża czekania ponad 10 s', async () => {
    const { adapter, licz } = atrapa({ ...RATE_30, requestsPerMinute: 10 }) // 1 żeton na 6 s
    const c = zegar()
    pusty(c.z.teraz)
    c.z.poSnie = () => pusty(c.z.teraz) // ktoś inny bierze każdy uzupełniony żeton
    const a = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep, interaktywne: true })) as Wolajacy
    await expect(a.createShipment({}, 'ref-1')).rejects.toThrow(/limit konta 10\/min wyczerpany \(createShipment\)/)
    expect(licz.create).toBe(0)
    expect(c.z.sny).toEqual([6_000])
    expect(c.z.sny.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(CZEKANIE_ZAPISU_MS)
  })

  it('zegar, który stoi, dalej odkłada od razu po pierwszym obrocie (bez wiszenia)', async () => {
    const { adapter, licz } = atrapa(RATE_30)
    const sny: number[] = []
    pusty(5_000)
    const a = (await oslonAdapter(db, adapter, konto, { now: () => new Date(5_000), sleep: async (ms) => void sny.push(ms), interaktywne: true })) as Wolajacy
    await expect(a.createShipment({}, 'ref-1')).rejects.toBeInstanceOf(LimitTempaError)
    expect(licz.create).toBe(0)
    expect(sny).toEqual([2_000])
  })
})

describe('zapis z tła (worker, automaty)', () => {
  it('jak dotąd: odmowa limitu = odłożony od razu, bez snu i bez żądania', async () => {
    const { adapter, licz } = atrapa(RATE_30)
    const c = zegar()
    pusty(c.z.teraz)
    const a = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep })) as Wolajacy
    const e = await a.createShipment({}, 'ref-1').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(LimitTempaError)
    expect((e as InstanceType<typeof LimitTempaError>).retryAfterMs).toBe(2_000)
    expect(licz.create).toBe(0)
    expect(c.z.sny).toEqual([])
  })
})

describe('odczyt w tle zostawia rezerwę konta dla zapisów', () => {
  it('śledzenie zjada najwyżej 2/3 kubełka naraz; zapis z panelu zaraz po nim przechodzi bez czekania', async () => {
    const { adapter, licz } = atrapa(RATE_30)
    const c = zegar()
    const tlo = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep })) as Wolajacy
    for (let i = 0; i < 20; i++) await tlo.trackShipment(`S${i}`)
    expect(c.z.sny).toEqual([]) // 20 z 30 od razu
    await tlo.trackShipment('S20')
    expect(c.z.sny).toEqual([2_000]) // 21. czeka na żeton ponad rezerwą 10
    const panel = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep, interaktywne: true })) as Wolajacy
    for (let i = 0; i < 5; i++) {
      expect((await panel.createShipment({}, `ref-${i}`)).kind).toBe('OK')
      await panel.getLabel(`X${i + 1}`, 'PDF') // etykieta z panelu też bez rezerwy
    }
    expect(licz).toEqual({ create: 5, track: 21, label: 5 })
    expect(c.z.sny).toEqual([2_000]) // 5 paczek = 10 żetonów rezerwy, bez czekania
  })

  it('bez zagłodzenia: 50 odczytów w tle przechodzi w tempie uzupełniania, żaden nie czeka dłużej niż jeden żeton', async () => {
    const { adapter, licz } = atrapa(RATE_30)
    const c = zegar()
    const tlo = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep })) as Wolajacy
    for (let i = 0; i < 50; i++) await tlo.trackShipment(`S${i}`)
    expect(licz.track).toBe(50)
    expect(c.z.sny).toHaveLength(30)
    expect(Math.max(...c.z.sny)).toBe(2_000)
  })

  it('odczyt w tle przy kubełku poniżej rezerwy czeka na żeton ponad nią, a za długo = odłożony jak przy pustym', async () => {
    const { adapter, licz } = atrapa({ ...RATE_30, requestsPerMinute: 6 }) // rezerwa 2, 1 żeton na 10 s
    const c = zegar()
    pusty(c.z.teraz) // do progu 3 żetonów: 30 s
    const tlo = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep })) as Wolajacy
    expect(await tlo.trackShipment('S1')).toBeTruthy()
    expect(c.z.sny).toEqual([30_000])
    pusty(c.z.teraz)
    c.z.poSnie = () => pusty(c.z.teraz)
    await expect(tlo.trackShipment('S2')).rejects.toBeInstanceOf(LimitTempaError)
    expect(licz.track).toBe(1)
  })

  it('odczyt z panelu bierze z całego kubełka (30 od razu)', async () => {
    const { adapter, licz } = atrapa(RATE_30)
    const c = zegar()
    const panel = (await oslonAdapter(db, adapter, konto, { now: c.now, sleep: c.sleep, interaktywne: true })) as Wolajacy
    for (let i = 0; i < 30; i++) await panel.trackShipment(`S${i}`)
    expect(licz.track).toBe(30)
    expect(c.z.sny).toEqual([])
  })
})
