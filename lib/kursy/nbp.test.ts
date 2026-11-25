// pobieranie kursów średnich NBP na atrapie (bez sieci): sukces, błędy, weekend, zły zapis w ustawieniach.
import { describe, expect, it } from 'vitest'
import { HARMONOGRAM_RDZENIA } from '@/lib/worker/harmonogram'
import { KURSY_WALUT_JOB, NBP_TABELA_A_URL, parsujTabeleNbp, parsujZapisKursow, pobierzTabeleNbp } from './nbp'

/** Tabela w kształcie odpowiedzi `tables/a/?format=json` (dane fikcyjne). */
const tabela = (effectiveDate: string, rates: { code: string; mid: unknown }[]) =>
  JSON.stringify([{ table: 'A', no: '226/A/NBP/2026', effectiveDate, rates: rates.map((r) => ({ currency: 'waluta', ...r })) }])

type Init = { signal: AbortSignal; headers: Record<string, string> }
const odpowiedz = (body: string, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })

describe('pobierzTabeleNbp (atrapa)', () => {
  it('sukces: tabela, dzień notowania, kursy; adres i limit czasu przekazane', async () => {
    let url = ''
    let init: Init | null = null
    const t = await pobierzTabeleNbp({
      url: 'https://atrapa.test/nbp',
      fetch: async (u, i) => {
        url = u
        init = i
        return { ok: true, status: 200, text: async () => tabela('2026-11-21', [{ code: 'CZK', mid: 0.1712 }, { code: 'EUR', mid: 4.2311 }]) }
      },
    })
    expect(t).toEqual({ tabela: '226/A/NBP/2026', data: '2026-11-21', kursy: { CZK: 0.1712, EUR: 4.2311 } })
    expect(url).toBe('https://atrapa.test/nbp')
    expect(init!.signal).toBeInstanceOf(AbortSignal)
    expect(NBP_TABELA_A_URL).toBe('https://api.nbp.pl/api/exchangerates/tables/a/?format=json')
  })

  it('weekend albo święto: NBP zwraca ostatnią opublikowaną tabelę, jej data zostaje datą kursu', async () => {
    const t = await pobierzTabeleNbp({ fetch: odpowiedz(tabela('2026-11-20', [{ code: 'CZK', mid: 0.1709 }])) })
    expect(t.data).toBe('2026-11-20')
  })

  it('błąd HTTP, zła odpowiedź, brak połączenia, limit czasu = KursyNbpError, bez kursu domyślnego', async () => {
    await expect(pobierzTabeleNbp({ fetch: odpowiedz('', 503) })).rejects.toThrow('NBP: HTTP 503')
    await expect(pobierzTabeleNbp({ fetch: odpowiedz('<html>') })).rejects.toThrow('NBP: odpowiedź nie jest JSON-em')
    await expect(pobierzTabeleNbp({ fetch: odpowiedz('[]') })).rejects.toThrow('NBP: brak tabeli')
    await expect(pobierzTabeleNbp({ fetch: odpowiedz('x'.repeat(300 * 1024)) })).rejects.toThrow('NBP: odpowiedź za duża')
    await expect(
      pobierzTabeleNbp({
        fetch: async () => {
          throw new TypeError('fetch failed')
        },
      }),
    ).rejects.toThrow('NBP: błąd połączenia')
    // atrapa wisi, dopóki sygnał nie przerwie żądania: limit czasu działa
    await expect(
      pobierzTabeleNbp({
        timeoutMs: 20,
        fetch: (_u, i) =>
          new Promise((_res, rej) => {
            i.signal.addEventListener('abort', () => rej(i.signal.reason))
          }),
      }),
    ).rejects.toThrow('NBP: brak odpowiedzi w limicie czasu')
  })
})

describe('parsujTabeleNbp', () => {
  it('odsiewa złe kody i kursy, wymaga daty, numeru i co najmniej jednego kursu', () => {
    const t = parsujTabeleNbp(
      tabela('2026-11-21', [
        { code: 'czk', mid: 0.1712 },
        { code: 'EURO', mid: 4.2 },
        { code: 'USD', mid: 0 },
        { code: 'GBP', mid: '5.1' },
        { code: 'PLN', mid: 1 },
      ]),
    )
    expect(t.kursy).toEqual({ CZK: 0.1712 })
    expect(() => parsujTabeleNbp(tabela('21.11.2026', [{ code: 'CZK', mid: 0.17 }]))).toThrow('NBP: brak daty notowania')
    expect(() => parsujTabeleNbp(tabela('2026-11-21', [{ code: 'USD', mid: -1 }]))).toThrow('NBP: tabela bez kursów')
    expect(() => parsujTabeleNbp(JSON.stringify([{ effectiveDate: '2026-11-21', rates: [{ code: 'CZK', mid: 0.17 }] }]))).toThrow('NBP: brak numeru tabeli')
  })
})

describe('parsujZapisKursow (ustawienia firmy)', () => {
  it('poprawny zapis, zły zapis = null (ekran liczy wtedy bez przeliczenia)', () => {
    const z = parsujZapisKursow({ zrodlo: 'NBP-A', tabela: '226/A/NBP/2026', data: '2026-11-21', pobrano: '2026-11-21T12:30:00.000Z', kursy: { CZK: 0.1712, zle: 1, EUR: 'x' } })
    expect(z).toEqual({ zrodlo: 'NBP-A', tabela: '226/A/NBP/2026', data: '2026-11-21', pobrano: '2026-11-21T12:30:00.000Z', kursy: { CZK: 0.1712 } })
    expect(parsujZapisKursow(null)).toBeNull()
    expect(parsujZapisKursow({ data: '2026-11-21', kursy: {} })).toBeNull()
    expect(parsujZapisKursow({ data: 'wczoraj', kursy: { CZK: 0.17 } })).toBeNull()
    expect(parsujZapisKursow([1])).toBeNull()
  })
})

describe('harmonogram', () => {
  it('kursy walut: zadanie okresowe raz na dobę (pierwsze zaraz po starcie workera)', () => {
    expect(HARMONOGRAM_RDZENIA.find((h) => h.kind === KURSY_WALUT_JOB)).toEqual({ kind: 'kursy-walut', everyMs: 6 * 3600_000 })
  })
})
