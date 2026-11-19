// bez bazy: niepełne pobranie faktur BL, ułamkowy stan BL w raporcie, pamięć „firma ma BL” w
// harmonogramie workera. BL wyłącznie atrapa w pamięci, dane fikcyjne.
import { describe, expect, it } from 'vitest'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { BL_CONFIGURED_TTL_MS, type BlConfiguredCache, cachedBlConfigured } from '../worker/petla'
import { fetchBlInvoices } from './faktury-bl'
import { compareStock, stockGap } from './raport-dzienny'

/** Atrapa `getInvoices` z nieskończoną liczbą faktur: każda strona to pełne 100 kolejnych numerów od `id_from`. */
function endlessBl(): { bl: BaseLinkerReadOnly; calls: number } {
  const st = { calls: 0 }
  const bl = {
    call: async (_method: string, p: { id_from?: number }) => {
      st.calls++
      const from = p.id_from ?? 1
      return { invoices: Array.from({ length: 100 }, (_, i) => ({ invoice_id: from + i, order_id: 7000 + from + i, number: `FV ${from + i}/10/2026`, type: 'normal', date_add: 1_790_000_000 })) }
    },
  } as unknown as BaseLinkerReadOnly
  return {
    bl,
    get calls() {
      return st.calls
    },
  }
}

describe('faktury BL: niepełne pobranie', () => {
  it('wyczerpany limit 100 stron → complete: false i błąd w wyniku, nie „wszystko pobrane”', async () => {
    const x = endlessBl()
    const f = await fetchBlInvoices(x.bl, { idFrom: 1 })
    expect(x.calls).toBe(100)
    expect(f.headers).toHaveLength(10_000)
    expect(f.complete).toBe(false)
    expect(f.errors.join(' ')).toMatch(/ponad 100 stron getInvoices/)
  })

  it('krótka strona kończy odczyt jako pełny', async () => {
    const bl = { call: async () => ({ invoices: [{ invoice_id: 5, order_id: 7005, number: 'FV 5/10/2026', type: 'normal', date_add: 1_790_000_000 }] }) } as unknown as BaseLinkerReadOnly
    expect(await fetchBlInvoices(bl, { idFrom: 1 })).toMatchObject({ complete: true, errors: [], headers: [expect.objectContaining({ blInvoiceId: 5 })] })
  })
})

describe('raport dzienny: stan BL kontra nasz', () => {
  it('sztuki z ułamkiem w BL = stan nieczytelny, nie zaokrąglenie (różnica < 0,5 nie znika)', () => {
    expect(compareStock(10, 10.4, 'SZT')).toBe('NIECZYTELNY')
    expect(compareStock(10, 9.6, 'SZT')).toBe('NIECZYTELNY')
    expect(compareStock(10, 10, 'SZT')).toBe('ZGODNY')
    expect(compareStock(10, 9, 'SZT')).toBe('ROZJAZD')
    expect(compareStock(0, -0, 'SZT')).toBe('ZGODNY')
  })

  it('kilogramy: BL trzyma kg ucięte, u nas gramy — ułamek kg nie jest nieczytelny', () => {
    expect(compareStock(2500, 2.5, 'KG')).toBe('ZGODNY')
    expect(compareStock(2999, 2.75, 'KG')).toBe('ZGODNY')
    expect(compareStock(3000, 2.9, 'KG')).toBe('ROZJAZD')
  })

  it('stockGap: dla kg odległość w g od przedziału [floor(bl)·1000, +999], dla sztuk zwykła różnica', () => {
    expect(stockGap(2850, 3, 'KG')).toBe(150) // sprzedaż 250 g przez granicę kg: realnie 150 g, nie 1000
    expect(stockGap(2999, 3, 'KG')).toBe(1)
    expect(stockGap(3000, 3, 'KG')).toBe(0)
    expect(stockGap(3999, 3.2, 'KG')).toBe(0)
    expect(stockGap(4100, 3, 'KG')).toBe(101)
    expect(stockGap(0, 0, 'KG')).toBe(0)
    expect(stockGap(10, 50, 'SZT')).toBe(40)
    expect(stockGap(7, 5, 'SZT')).toBe(2)
  })
})

describe('harmonogram workera: pamięć „firma ma BL”', () => {
  it('wynik pamiętany per firma przez TTL, potem liczony od nowa; błąd nie jest pamiętany', async () => {
    const cache: BlConfiguredCache = new Map()
    let calls = 0
    const compute = (v: boolean) => async () => {
      calls++
      return v
    }
    expect(await cachedBlConfigured(cache, 'org-a', 0, compute(true))).toBe(true)
    expect(await cachedBlConfigured(cache, 'org-a', BL_CONFIGURED_TTL_MS - 1, compute(false))).toBe(true)
    expect(calls).toBe(1)
    expect(await cachedBlConfigured(cache, 'org-b', 1, compute(false))).toBe(false)
    expect(calls).toBe(2)
    expect(await cachedBlConfigured(cache, 'org-a', BL_CONFIGURED_TTL_MS, compute(false))).toBe(false)
    expect(calls).toBe(3)
    await expect(
      cachedBlConfigured(cache, 'org-c', 5, async () => {
        throw new Error('baza niedostępna')
      }),
    ).rejects.toThrow('baza niedostępna')
    expect(cache.has('org-c')).toBe(false)
    expect(BL_CONFIGURED_TTL_MS).toBe(10 * 60_000)
  })
})
