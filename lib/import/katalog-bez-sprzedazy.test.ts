import { describe, expect, it } from 'vitest'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { collectSources } from './katalog'

// import na serwerze do czasu logowania w panelu działa z salesDays = 0 — bez getOrders,
// więc dane klientów z zamówień BL w ogóle nie przechodzą przez proces.
describe('collectSources: salesDays = 0', () => {
  it('nie woła getOrders, sprzedaż pusta i oznaczona jako niepełna', async () => {
    const calls: string[] = []
    const bl = {
      async call(method: string) {
        calls.push(method)
        if (method === 'getOrders') throw new Error('getOrders nie powinno być wołane')
        if (method === 'getInventories') return { inventories: [{ inventory_id: 1, default_price_group: 1 }] }
        return { products: {} }
      },
    } as unknown as BaseLinkerReadOnly
    const raw = await collectSources({
      bl,
      wfirma: null,
      empik: null,
      inventoryId: '1',
      salesDays: 0,
      wfirmaWarehouseId: null,
      shopStorages: [],
      channels: { shopAccounts: [], empikAccountId: null },
    })
    expect(calls).not.toContain('getOrders')
    expect(raw.sales.orders).toBe(0)
    expect(raw.sales.lines).toEqual([])
    expect(raw.sales.complete).toBe(false)
    expect(raw.issues.filter((i) => i.kind === 'bl-zamowienia')).toEqual([])
  })
})
