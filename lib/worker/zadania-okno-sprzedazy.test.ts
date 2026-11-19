import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'

// sufit KATALOG_IMPORT_DNI_SPRZEDAZY egzekwuje handler, nie tylko harmonogram.
// Zadanie bez payloadu (ręczne enqueue, stary wiersz Job) ani z salesDays 90 nie może przy suficie 0 wołać getOrders.
const calls: string[] = []
const bl = {
  async call(method: string) {
    calls.push(method)
    if (method === 'getOrders') throw new Error('getOrders nie powinno być wołane')
    if (method === 'getInventories') return { inventories: [{ inventory_id: 1, default_price_group: 1 }] }
    return { products: {} }
  },
} as unknown as BaseLinkerReadOnly

vi.mock('../konfiguracja', () => ({
  clientsForOrg: vi.fn(async () => ({
    bl,
    wfirma: null,
    empik: null,
    missing: [],
    missingOptional: [],
    config: { inventoryId: '1', warehouseId: 'glowny', wfirmaWarehouseId: null, shops: [], empikAccountId: null, channelNames: {} },
  })),
}))
vi.mock('../import/zapis', () => ({ persistImport: vi.fn(async () => ({ runId: 'test' })) }))
vi.mock('../import/nadpisania', async (orig) => ({ ...(await orig<typeof import('../import/nadpisania')>()), loadOfferOverrides: vi.fn(() => []) }))

const { handlers } = await import('./zadania')
const { NonRetryableError } = await import('../bledy')
const db = {} as PrismaClient
const ctx = (env: Record<string, string | undefined>) => ({ organizationId: 'org-test', secrets: { env, envFallback: true } })

describe('handler import-katalogu: sufit dni sprzedaży', () => {
  beforeEach(() => {
    calls.length = 0
  })
  it.each([
    ['payload null', null],
    ['payload {}', {}],
    ['salesDays 90', { salesDays: 90 }],
  ])('%s przy suficie 0 → bez getOrders', async (_n, payload) => {
    await handlers['import-katalogu']!(db, payload, ctx({ KATALOG_IMPORT_DNI_SPRZEDAZY: '0' }))
    expect(calls).toContain('getInventories')
    expect(calls).not.toContain('getOrders')
  })
  it('brak zmiennej = sufit 0 → bez getOrders', async () => {
    await handlers['import-katalogu']!(db, { salesDays: 90 }, ctx({}))
    expect(calls).not.toContain('getOrders')
  })
  it('zła wartość zmiennej = NonRetryableError przed odczytem źródeł', async () => {
    await expect(handlers['import-katalogu']!(db, null, ctx({ KATALOG_IMPORT_DNI_SPRZEDAZY: 'dużo' }))).rejects.toBeInstanceOf(NonRetryableError)
    expect(calls).toEqual([])
  })
})
