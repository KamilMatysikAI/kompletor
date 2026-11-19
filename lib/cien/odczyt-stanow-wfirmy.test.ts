// adapter odczytu stanów wFirmy — atrapa na poziomie `call` (zero połączeń z prawdziwą wFirmą), towary
// i magazyny zmyślone (T-001…).
import { describe, expect, it, vi } from 'vitest'
import { WfirmaLimitError } from '../rdzen/rozchod'
import { ReadOnlyViolation, SourceError } from '../zrodla/http'
import { assertWfirmaReadOnly, WfirmaReadOnly } from '../zrodla/wfirma'
import { GOODS_PAGE_SIZE, limitWaitMs, WAREHOUSE_FIELD, WfirmaStockReader } from './odczyt-stanow-wfirmy'

const WH = '999001'
const good = (id: number, count: number | string | null, wh = WH, unit = 'szt.') => ({ good: { id: String(id), code: `T-${String(id).padStart(3, '0')}`, name: `Towar testowy ${id}`, unit, count, warehouse: { id: wh } } })
const collection = (items: ReturnType<typeof good>[]) => ({ goods: { ...Object.fromEntries(items.map((g, i) => [String(i), g])), parameters: { total: items.length } } })

type Body = { api: { goods: { parameters: Record<string, unknown> } } }

/** Atrapa `call`: zapisuje ścieżki i parametry, odpowiada kolejno z `replies`. */
function fakeCall(replies: (unknown | Error)[]) {
  const paths: string[] = []
  const params: Record<string, unknown>[] = []
  const call = vi.fn(async (path: string, body: unknown) => {
    assertWfirmaReadOnly(path) // jak WfirmaReadOnly: ścieżka zapisu = wyjątek
    paths.push(path)
    params.push((body as Body).api.goods.parameters)
    const r = replies.shift()
    if (r instanceof Error) throw r
    return r as never
  })
  return { call, paths, params }
}

describe('WfirmaStockReader — pełny odczyt stronami', () => {
  it('strona: limit 100, sortowanie po id, jawny warunek magazynu, count jak import (kg zostaje w kg)', async () => {
    const items = Array.from({ length: GOODS_PAGE_SIZE }, (_, i) => good(i + 1, i % 3))
    items[5] = good(6, '1,25', WH, 'kg')
    const f = fakeCall([collection(items)])
    const r = new WfirmaStockReader(f)
    const page = await r.readGoodsPage(3, WH)
    expect(f.paths).toEqual(['goods/find'])
    expect(f.params[0]).toEqual({ page: 3, limit: 100, order: { asc: 'id' }, conditions: { condition: { field: WAREHOUSE_FIELD, operator: 'eq', value: WH } } })
    expect(page.last).toBe(false)
    expect(page.items).toHaveLength(100)
    expect(page.items[0]).toEqual({ wfirmaGoodId: '1', count: 0 })
    expect(page.items[5]).toEqual({ wfirmaGoodId: '6', count: 1.25 })
  })

  it('ostatnia strona = mniej niż 100 pozycji; pusta strona też ostatnia', async () => {
    const f = fakeCall([collection([good(1, 4), good(2, 7)]), collection([])])
    const r = new WfirmaStockReader(f)
    expect(await r.readGoodsPage(1, WH)).toEqual({ items: [{ wfirmaGoodId: '1', count: 4 }, { wfirmaGoodId: '2', count: 7 }], last: true })
    expect(await r.readGoodsPage(2, WH)).toEqual({ items: [], last: true })
  })

  it('pozycja z innego magazynu nigdy nie trafia do items; pełna strona z obcymi pozycjami nie udaje ostatniej', async () => {
    const items = Array.from({ length: GOODS_PAGE_SIZE }, (_, i) => good(i + 1, 5, i < 10 ? '777' : WH))
    const f = fakeCall([collection(items), collection([good(500, 3, '777'), good(501, 2)])])
    const r = new WfirmaStockReader(f)
    const p1 = await r.readGoodsPage(1, WH)
    expect(p1.items).toHaveLength(90)
    expect(p1.items.some((i) => Number(i.wfirmaGoodId) <= 10)).toBe(false)
    expect(p1.last).toBe(false)
    const p2 = await r.readGoodsPage(2, WH)
    expect(p2).toEqual({ items: [{ wfirmaGoodId: '501', count: 2 }], last: true })
    expect(r.stats).toMatchObject({ otherWarehouse: 11, requests: 2 })
  })

  it('pozycja bez count pominięta (nie 0)', async () => {
    const f = fakeCall([collection([good(1, null), good(2, 3)])])
    const r = new WfirmaStockReader(f)
    expect((await r.readGoodsPage(1, WH)).items).toEqual([{ wfirmaGoodId: '2', count: 3 }])
    expect(r.stats.unreadable).toBe(1)
  })
})

describe('WfirmaStockReader — odczyt celowany', () => {
  it('jedno żądanie na partię: warunek magazynu i id z listy; towaru brak w odpowiedzi = brak w wyniku', async () => {
    const f = fakeCall([collection([good(11, 4), good(13, 0)])])
    const r = new WfirmaStockReader(f)
    const got = await r.readGoods(['11', '12', '13', '11'], WH)
    expect(f.paths).toEqual(['goods/find'])
    expect(f.params[0]).toEqual({
      page: 1,
      limit: 3,
      order: { asc: 'id' },
      conditions: { and: [{ condition: { field: WAREHOUSE_FIELD, operator: 'eq', value: WH } }, { condition: { field: 'id', operator: 'in', value: '11,12,13' } }] },
    })
    expect(got).toEqual([{ wfirmaGoodId: '11', count: 4 }, { wfirmaGoodId: '13', count: 0 }])
  })

  it('towar z innego magazynu odrzucony; odpowiedź z towarami spoza zapytania = błąd (filtr id nie działa), nie cichy brak', async () => {
    const f = fakeCall([collection([good(11, 4, '777'), good(12, 1)]), collection([good(11, 4), good(99, 1)])])
    const r = new WfirmaStockReader(f)
    expect(await r.readGoods(['11', '12'], WH)).toEqual([{ wfirmaGoodId: '12', count: 1 }])
    await expect(r.readGoods(['11'], WH)).rejects.toThrow(/spoza zapytania \(99\)/)
  })

  it('pusta lista = bez żądania; zły id = błąd przed żądaniem', async () => {
    const f = fakeCall([])
    const r = new WfirmaStockReader(f)
    expect(await r.readGoods([], WH)).toEqual([])
    await expect(r.readGoods(['12; DROP'], WH)).rejects.toThrow(/zły id/)
    expect(f.call).not.toHaveBeenCalled()
  })
})

describe('WfirmaStockReader — limit wFirmy i strażnik zapisu', () => {
  it('SourceError z limitem (HTTP 429, kod LIMIT) → WfirmaLimitError z czasem z komunikatu; inne błędy bez zmian', async () => {
    const f = fakeCall([
      new SourceError('wFirma goods/find: HTTP 429 (limit) — bez ponawiania', false),
      new SourceError('wFirma goods/find: AUTH FAILED LIMIT WAIT 5 MINUTES — limit, bez ponawiania', false),
      new SourceError('wFirma goods/find: HTTP 503', true),
    ])
    const r = new WfirmaStockReader(f)
    const e1 = await r.readGoodsPage(1, WH).catch((e: unknown) => e)
    expect(e1).toBeInstanceOf(WfirmaLimitError)
    expect((e1 as WfirmaLimitError).retryAfterMs).toBeUndefined()
    const e2 = await r.readGoods(['1'], WH).catch((e: unknown) => e)
    expect(e2).toBeInstanceOf(WfirmaLimitError)
    expect((e2 as WfirmaLimitError).retryAfterMs).toBe(5 * 60_000)
    const e3 = await r.readGoodsPage(1, WH).catch((e: unknown) => e)
    expect(e3).toBeInstanceOf(SourceError)
    expect(e3).not.toBeInstanceOf(WfirmaLimitError)
    expect(limitWaitMs('TOTAL REQUESTS LIMIT EXCEEDED')).toBeUndefined()
  })

  it('prawdziwy klient WfirmaReadOnly (fetch z atrapy): 429 i kod LIMIT → WfirmaLimitError po JEDNYM żądaniu (bez ponawiania)', async () => {
    const keys = { accessKey: 'a', secretKey: 's', appKey: 'p', companyId: '1' }
    for (const res of [new Response('', { status: 429 }), Response.json({ status: { code: 'TOTAL REQUESTS LIMIT EXCEEDED' } })]) {
      const fetchImpl = vi.fn(async () => res)
      const r = new WfirmaStockReader(new WfirmaReadOnly(keys, fetchImpl, 0))
      await expect(r.readGoodsPage(1, WH)).rejects.toBeInstanceOf(WfirmaLimitError)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/api2\.wfirma\.pl\/goods\/find\?/)
    }
  })

  it('każda ścieżka adaptera przechodzi strażnika odczytu; ścieżka zapisu nie pada nigdy', async () => {
    const seen: string[] = []
    const call = vi.fn(async (path: string) => {
      seen.push(path)
      return collection([good(1, 1)]) as never
    })
    const r = new WfirmaStockReader({ call })
    await r.readGoodsPage(1, WH)
    await r.readGoods(['1'], WH)
    expect(seen.length).toBe(2)
    for (const p of seen) {
      expect(() => assertWfirmaReadOnly(p)).not.toThrow()
      expect(p).not.toMatch(/add|edit|delete|update|send/)
    }
    expect(() => assertWfirmaReadOnly('goods/edit/1')).toThrow(ReadOnlyViolation)
  })
})
