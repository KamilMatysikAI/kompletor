import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { RawSources } from '../import/katalog'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'

// (r3, drobna 7): brak kluczy Empiku nie blokuje importu w workerze — Empik pominięty
// jako FetchIssue brak-kluczy (kanał niepełny), blokują tylko klucze wFirmy.
const bl = {
  async call(method: string) {
    if (method === 'getInventories') return { inventories: [{ inventory_id: 1, default_price_group: 1 }] }
    return { products: {} }
  },
} as unknown as BaseLinkerReadOnly

const persisted: RawSources[] = []
vi.mock('../konfiguracja', async (orig) => ({
  ...(await orig<typeof import('../konfiguracja')>()),
  clientsForOrg: vi.fn(async () => ({
    bl,
    wfirma: null,
    empik: null,
    missing: [],
    missingOptional: ['EMPIK_MIRAKL_BASE_URL', 'EMPIK_MIRAKL_API_KEY'],
    config: { inventoryId: '1', warehouseId: 'glowny', wfirmaWarehouseId: null, shops: [], empikAccountId: '30193', channelNames: {} },
  })),
}))
vi.mock('../import/zapis', () => ({ persistImport: vi.fn(async (_db: unknown, raw: RawSources) => (persisted.push(raw), { runId: 'test' })) }))
vi.mock('../import/nadpisania', async (orig) => ({ ...(await orig<typeof import('../import/nadpisania')>()), loadOfferOverrides: vi.fn(() => []) }))

const { handlers } = await import('./zadania')
const { clientsFrom } = await import('../konfiguracja')
const { MISSING_KEYS } = await import('../import/katalog')

describe('import-katalogu bez kluczy Empiku', () => {
  const wfKeys = { BASELINKER_TOKEN: 'atrapa', WFIRMA_ACCESS_KEY: 'a', WFIRMA_SECRET_KEY: 'b', WFIRMA_APP_KEY: 'c', WFIRMA_COMPANY_ID: 'd' }
  const cfg = (empikAccountId: string | null) => ({ inventoryId: '1', warehouseId: 'glowny', wfirmaWarehouseId: '123', shops: [], empikAccountId, channelNames: {} })

  it('clientsFrom z kontem Empik: klucze Empiku w missingOptional, missing (blokujące) puste', () => {
    const c = clientsFrom(wfKeys, cfg('30193'))
    expect(c.missing).toEqual([])
    expect(c.missingOptional).toEqual(['EMPIK_MIRAKL_BASE_URL', 'EMPIK_MIRAKL_API_KEY'])
    expect(c.empik).toBeNull()
    expect(clientsFrom({ BASELINKER_TOKEN: 'atrapa' }, cfg('30193')).missing).toEqual(['WFIRMA_ACCESS_KEY', 'WFIRMA_SECRET_KEY', 'WFIRMA_APP_KEY', 'WFIRMA_COMPANY_ID'])
  })

  it('clientsFrom bez konta Empik (firma tylko Woo/Allegro): missingOptional puste', () => {
    const c = clientsFrom(wfKeys, cfg(null))
    expect(c.missingOptional).toEqual([])
    expect(c.missing).toEqual([])
    expect(c.empik).toBeNull()
  })

  it('handler nie odmawia: import idzie dalej, Empik = FetchIssue brak-kluczy', async () => {
    await handlers['import-katalogu']!({} as PrismaClient, { salesDays: 0 }, { organizationId: 'org-test', secrets: { env: {}, envFallback: true } })
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.empik).toBeNull()
    expect(persisted[0]!.issues).toContainEqual(expect.objectContaining({ kind: MISSING_KEYS, ref: 'empik' }))
  })
})
