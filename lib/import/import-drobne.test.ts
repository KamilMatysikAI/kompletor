// poprawki po przeglądzie, bez bazy.
import { describe, expect, it } from 'vitest'
import { smallRaw, TEST_CHANNEL_MAP } from '@/tests/fixtures'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { SourceError } from '../zrodla/http'
import type { WfirmaReadOnly } from '../zrodla/wfirma'
import { channelComplete, collectSources, MISSING_KEYS } from './katalog'

const blStub = {
  async call(m: string) {
    if (m === 'getInventories') return { inventories: [{ inventory_id: 77701, default_price_group: 1 }] }
    if (m === 'getInventoryProductsList') return { products: {} }
    if (m === 'getInventoryIntegrations') return { integrations: {} }
    if (m === 'getExternalStorageProductsList') return { products: [] }
    return { orders: [] }
  },
} as unknown as BaseLinkerReadOnly

const wfThrowing = (e: unknown) => ({ async call() { throw e } }) as unknown as WfirmaReadOnly
const collect = (over: Partial<Parameters<typeof collectSources>[0]> = {}) =>
  collectSources({ bl: blStub, wfirma: null, empik: null, inventoryId: '77701', wfirmaWarehouseId: '1', shopStorages: [], channels: TEST_CHANNEL_MAP, salesDays: 0, ...over })

describe('FetchIssue wFirmy niesie retryable z SourceError', () => {
  it('limit wFirmy (SourceError retryable = false) → retryable false', async () => {
    const raw = await collect({ wfirma: wfThrowing(new SourceError('wFirma vat_codes/find: AUTH FAILED LIMIT WAIT 5 MINUTES', false)) })
    expect(raw.wfirma).toBeNull()
    expect(raw.issues).toContainEqual(expect.objectContaining({ kind: 'wfirma', ref: 'goods/find', retryable: false }))
  })

  it('5xx po wyczerpaniu ponowień (SourceError retryable = true) i błąd sieci → retryable true', async () => {
    const r5 = await collect({ wfirma: wfThrowing(new SourceError('wFirma: HTTP 503', true)) })
    expect(r5.issues).toContainEqual(expect.objectContaining({ kind: 'wfirma', retryable: true }))
    const net = await collect({ wfirma: wfThrowing(new TypeError('fetch failed')) })
    expect(net.issues).toContainEqual(expect.objectContaining({ kind: 'wfirma', retryable: true }))
  })
})

describe('brak kluczy Empiku zgłaszany tylko przy skonfigurowanym koncie Empik', () => {
  it('firma z kontem Empik → FetchIssue brak-kluczy/empik', async () => {
    const raw = await collect()
    expect(raw.issues).toContainEqual(expect.objectContaining({ kind: MISSING_KEYS, ref: 'empik' }))
  })

  it('firma bez konta Empik → brak wpisu o Empiku', async () => {
    const raw = await collect({ channels: { ...TEST_CHANNEL_MAP, empikAccountId: null } })
    expect(raw.issues.filter((i) => i.ref === 'empik')).toEqual([])
  })
})

describe('channelComplete Empiku porównuje konto z konfiguracją', () => {
  it('konto spoza konfiguracji (stare po zmianie) → niepełny, nic nie idzie do sprzątania', () => {
    const raw = smallRaw()
    expect(channelComplete(raw, 'EMPIK', '30193')).toBe(true)
    expect(channelComplete(raw, 'EMPIK', '99999')).toBe(false)
    expect(channelComplete(raw, 'EMPIK', '99999', 'stale')).toBe(false)
  })
})
