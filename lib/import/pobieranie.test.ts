import { describe, expect, it } from 'vitest'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import type { WfirmaReadOnly } from '../zrodla/wfirma'
import { fetchBlSales, fetchWfirmaGoods, type FetchIssue } from './pobieranie'

const order = (id: number, ts: number) => ({
  order_id: id,
  order_source: 'allegro',
  order_source_id: 1,
  date_confirmed: ts,
  products: [{ storage: 'db', product_id: '5', quantity: 1, auction_id: 'a' }],
})

function fakeBl(all: ReturnType<typeof order>[], failAtCall?: number) {
  const calls: number[] = []
  const bl = {
    async call(_m: string, p: { date_confirmed_from: number }) {
      calls.push(p.date_confirmed_from)
      if (failAtCall !== undefined && calls.length === failAtCall) throw new Error('limit')
      return { orders: all.filter((o) => o.date_confirmed >= p.date_confirmed_from).slice(0, 100) }
    },
  } as unknown as BaseLinkerReadOnly
  return { bl, calls }
}

describe('fetchBlSales: paginacja getOrders', () => {
  it('nie gubi zamówień z tej samej sekundy co ostatnie w paczce', async () => {
    // 99 zamówień w sekundach 1..99, potem 3 w sekundzie 100 — paczka 1 kończy się na pierwszym z nich.
    const all = [...Array.from({ length: 99 }, (_, i) => order(i + 1, i + 1)), order(100, 100), order(101, 100), order(102, 100)]
    const { bl, calls } = fakeBl(all)
    const r = await fetchBlSales(bl, 0, [], { shopAccounts: [], empikAccountId: null })
    expect(r.orders).toBe(102)
    expect(r.complete).toBe(true)
    expect(calls).toEqual([0, 100])
  })

  it('błąd w połowie: pobrane strony zostają, complete = false', async () => {
    const all = Array.from({ length: 150 }, (_, i) => order(i + 1, i + 1))
    const { bl } = fakeBl(all, 2)
    const issues: FetchIssue[] = []
    const r = await fetchBlSales(bl, 0, issues, { shopAccounts: [], empikAccountId: null })
    expect(r.orders).toBe(100)
    expect(r.complete).toBe(false)
    expect(issues[0]!.kind).toBe('bl-zamowienia')
  })
})

describe('fetchWfirmaGoods: tylko magazyn główny', () => {
  it('towar z innego magazynu jest pomijany z alertem', async () => {
    const good = (key: string, id: string, wh: number) => ({ [key]: { good: { id, name: 'x', unit: 'szt.', count: '1', warehouse: { id: wh } } } })
    const wf = {
      async call(path: string) {
        if (path === 'vat_codes/find') return { vat_codes: {} }
        return { goods: { parameters: { total: '2' }, ...good('0', '1', 900014), ...good('1', '2', 828384) } }
      },
    } as unknown as WfirmaReadOnly
    const issues: FetchIssue[] = []
    const r = await fetchWfirmaGoods(wf, issues, '900014')
    expect(r.goods.map((g) => g.id)).toEqual(['1'])
    expect(issues.some((i) => i.kind === 'wfirma-inny-magazyn' && i.ref === '2')).toBe(true)
  })
})
