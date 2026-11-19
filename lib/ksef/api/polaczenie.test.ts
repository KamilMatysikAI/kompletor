// poprawki po przeglądzie: limit czasu uwierzytelnienia z zegara, ponowienia GET przy błędzie
// sieci i `Retry-After` przy 429, przerwanie sygnałem. Atrapa KSeF TEST, sztuczny zegar przesuwany przez `sleep`
// (bez prawdziwego czekania), bez sieci i bez bazy.
import { describe, expect, it } from 'vitest'
import { atrapaKsef } from '@/tests/ksef-atrapa'
import { bramkaWysylki, type WarunkiWysylki } from './bramka'
import { BladKsefApi, CZEKANIE_429_MAX_MS, CZEKANIE_429_MS, czasZRetryAfter, KsefPolaczenie, PONOWIENIA_MS, STATUS_MAX_MS } from './polaczenie'
import { getSessionInvoiceStatus } from './sesja'

const W: WarunkiWysylki = { program: 'ksef', fakturyWlaczone: true, trybKonta: 'PRACA', kanal: 'WOO', srodowisko: 'TEST', nipSprzedawcy: '1111111111' }
const bramka = () => {
  const b = bramkaWysylki(W, {})
  if (!b.dozwolona) throw new Error('bramka zamknięta')
  return b
}
const DANE = { nip: '1111111111', token: 'token-testowy-atrapy' }

/** Sztuczny zegar: `sleep` przesuwa czas i zapisuje odstępy. */
function zegarSztuczny() {
  let t = Date.UTC(2026, 10, 9, 9, 0, 0)
  const czekania: number[] = []
  return {
    zegar: () => t,
    sleep: async (ms: number) => {
      czekania.push(ms)
      t += ms
    },
    czekania,
  }
}

describe('KsefPolaczenie.otworz: limit czasu uwierzytelnienia', () => {
  it('status 100 bez końca → BladKsefApi po 30 s zegara, bez prawdziwego czekania i bez pętli bez końca', async () => {
    const a = atrapaKsef({ uwierzytelnienieWToku: Infinity })
    const z = zegarSztuczny()
    // `now` stałe jak w wysyłce: limit i tak liczy zegar
    const stala = new Date('2026-11-09T09:00:00.000Z')
    const start = Date.now()
    await expect(KsefPolaczenie.otworz(bramka(), DANE, { fetch: a.fetch, sleep: z.sleep, zegar: z.zegar, now: () => stala })).rejects.toThrow(/ponad 30 s/)
    expect(Date.now() - start).toBeLessThan(5_000)
    const odpytania = a.wywolania.filter((w) => /^GET \/auth\/[^/]+$/.test(w) && !w.includes('challenge')).length
    expect(odpytania).toBe(STATUS_MAX_MS / 2_000 + 1)
    expect(a.wywolania).not.toContain('POST /auth/token/redeem')
  })

  it('kilka statusów 100, potem 200 → połączenie gotowe', async () => {
    const a = atrapaKsef({ uwierzytelnienieWToku: 3 })
    const z = zegarSztuczny()
    const p = await KsefPolaczenie.otworz(bramka(), DANE, { fetch: a.fetch, sleep: z.sleep, zegar: z.zegar })
    expect(p).toBeInstanceOf(KsefPolaczenie)
    expect(z.czekania).toEqual([2_000, 2_000, 2_000])
  })
})

describe('ponowienia GET (jak DewFlow ksefFetch)', () => {
  it('błąd sieci przy GET: ponowienie 1/3/9 s, potem sukces', async () => {
    const a = atrapaKsef({ bledySieciGet: 2 })
    const z = zegarSztuczny()
    await KsefPolaczenie.otworz(bramka(), DANE, { fetch: a.fetch, sleep: z.sleep, zegar: z.zegar })
    // dwa zerwane GET kluczy publicznych, trzeci przechodzi
    expect(a.wywolania.filter((w) => w === 'GET /security/public-key-certificates')).toHaveLength(3)
    expect(z.czekania.slice(0, 2)).toEqual([1_000, 3_000])
  })

  it('błąd sieci przy GET dłużej niż limit prób → BladKsefApi bez kodu (stan nieznany) z liczbą prób', async () => {
    const a = atrapaKsef({ bledySieciGet: 99 })
    const z = zegarSztuczny()
    const e = await KsefPolaczenie.otworz(bramka(), DANE, { fetch: a.fetch, sleep: z.sleep, zegar: z.zegar }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BladKsefApi)
    expect((e as BladKsefApi).status).toBeUndefined()
    expect((e as Error).message).toMatch(/błąd sieci.*po 4 próbach/)
    expect(z.czekania).toEqual(PONOWIENIA_MS)
  })

  it('429 z Retry-After: czeka tyle, ile każe KSeF (+1 s), potem odczyt stanu się udaje', async () => {
    const a = atrapaKsef({ bladStatusu: { kod: 429, ile: 1, retryAfter: '12' } })
    const z = zegarSztuczny()
    const p = await KsefPolaczenie.otworz(bramka(), DANE, { fetch: a.fetch, sleep: z.sleep, zegar: z.zegar })
    // nieznana faktura po ponowieniu → 404 z atrapy, ale ważne jest czekanie przed ponowieniem
    await getSessionInvoiceStatus(p, 'S', 'F').catch(() => {})
    expect(z.czekania).toContain(13_000)
  })

  it('czasZRetryAfter: nagłówek w sekundach i jako data, treść „po N sekundach”, retryAfter w JSON, górna granica', () => {
    const now = Date.UTC(2026, 10, 9, 9, 0, 0)
    expect(czasZRetryAfter('7', null, now)).toBe(8_000)
    expect(czasZRetryAfter(new Date(now + 20_000).toUTCString(), null, now)).toBe(21_000)
    expect(czasZRetryAfter(null, 'Przekroczono limit 16 żądań na minutę. Spróbuj ponownie po 45 sekundach.', now)).toBe(46_000)
    expect(czasZRetryAfter(null, '{"retryAfter": 3}', now)).toBe(4_000)
    expect(czasZRetryAfter('3600', null, now)).toBe(CZEKANIE_429_MAX_MS)
    expect(czasZRetryAfter(null, 'brak podpowiedzi', now)).toBeNull()
    expect(CZEKANIE_429_MS).toBe(45_000)
  })
})

describe('przerwanie sygnałem (twardy limit zadania ksef-wysylka)', () => {
  it('sygnał przerwany w trakcie czekania na uwierzytelnienie → BladKsefApi bez kodu, bez kolejnych żądań', async () => {
    const a = atrapaKsef({ uwierzytelnienieWToku: Infinity })
    const z = zegarSztuczny()
    const ctrl = new AbortController()
    let n = 0
    const sleep = async (ms: number) => {
      await z.sleep(ms)
      if (++n === 3) ctrl.abort()
    }
    const e = await KsefPolaczenie.otworz(bramka(), DANE, { fetch: a.fetch, sleep, zegar: z.zegar, sygnal: ctrl.signal }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BladKsefApi)
    expect((e as BladKsefApi).status).toBeUndefined()
    expect((e as Error).message).toMatch(/przerwano/)
    const poPrzerwaniu = a.wywolania.length
    expect(poPrzerwaniu).toBeLessThan(10)
  })
})
