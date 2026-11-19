import { describe, expect, it, vi } from 'vitest'
import { assertBlReadOnly, BaseLinkerReadOnly } from './baselinker'
import { ReadOnlyViolation, SourceError } from './http'
import { MiraklReadOnly } from './mirakl'
import { assertWfirmaReadOnly, WfirmaReadOnly, wfirmaItems } from './wfirma'

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('BaseLinker — tylko odczyt', () => {
  it.each(['addOrder', 'updateInventoryProductsStock', 'setOrderStatus', 'deleteInventoryProduct', 'runOrderMacroTrigger', 'get', 'getorders'])(
    'odrzuca %s bez wysłania żądania',
    async (m) => {
      const f = vi.fn()
      const c = new BaseLinkerReadOnly('t', f, 0)
      await expect(c.call(m)).rejects.toBeInstanceOf(ReadOnlyViolation)
      expect(f).not.toHaveBeenCalled()
    },
  )

  it('wysyła get* z tokenem w nagłówku, nie w treści', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => okJson({ status: 'SUCCESS', orders: [] }))
    const c = new BaseLinkerReadOnly('sekretny-token', f, 0)
    await c.call('getOrders', { date_confirmed_from: 1 })
    const init = f.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>)['X-BLToken']).toBe('sekretny-token')
    expect(String(init.body)).not.toContain('sekretny-token')
    expect(String(init.body)).toContain('method=getOrders')
  })

  it('błąd BL bez ponawiania dla błędu parametrów', async () => {
    const f = vi.fn(async () => okJson({ status: 'ERROR', error_code: 'ERROR_BAD_PARAMETERS', error_message: 'x' }))
    const c = new BaseLinkerReadOnly('t', f, 0)
    await expect(c.call('getOrders')).rejects.toBeInstanceOf(SourceError)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('assertBlReadOnly przepuszcza get*', () => {
    expect(() => assertBlReadOnly('getInventoryProductsData')).not.toThrow()
  })
})

describe('wFirma — tylko odczyt', () => {
  it.each(['goods/add', 'invoices/add', 'invoices/edit/5', 'goods/delete/1', 'webhooks/add', 'goods/find/../add', 'goods/get/abc'])(
    'odrzuca %s',
    (p) => expect(() => assertWfirmaReadOnly(p)).toThrow(ReadOnlyViolation),
  )
  it.each(['goods/find', 'invoices/find', 'goods/get/123', 'vat_codes/find'])('przepuszcza %s', (p) =>
    expect(() => assertWfirmaReadOnly(p)).not.toThrow(),
  )

  it('klucze w nagłówkach, company_id w adresie, status != OK = błąd', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => okJson({ status: { code: 'OK' }, goods: {} }))
    const c = new WfirmaReadOnly({ accessKey: 'a', secretKey: 's', appKey: 'p', companyId: '42' }, f, 0)
    await c.call('goods/find', {})
    expect(f.mock.calls[0]![0]).toContain('company_id=42')
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>)['secretKey']).toBe('s')
    const g = vi.fn(async () => okJson({ status: { code: 'NOT FOUND' } }))
    const c2 = new WfirmaReadOnly({ accessKey: 'a', secretKey: 's', appKey: 'p', companyId: '42' }, g, 0)
    await expect(c2.call('goods/find', {})).rejects.toThrow('NOT FOUND')
  })

  it('call() z zapisem nie wysyła żądania', async () => {
    const f = vi.fn()
    const c = new WfirmaReadOnly({ accessKey: 'a', secretKey: 's', appKey: 'p', companyId: '42' }, f, 0)
    await expect(c.call('goods/add', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(f).not.toHaveBeenCalled()
  })

  it('wfirmaItems pomija „parameters”', () => {
    expect(wfirmaItems({ parameters: { total: 1 }, '0': { good: { id: 1 } } }, 'good')).toEqual([{ id: 1 }])
  })
})

describe('Mirakl — tylko GET', () => {
  it('ma wyłącznie metodę get i wysyła klucz bez „Bearer”', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => okJson({ offers: [] }))
    const c = new MiraklReadOnly('https://example.test/api/', 'klucz', f, 0)
    await c.get('/offers', { max: 1 })
    expect(f.mock.calls[0]![0]).toBe('https://example.test/api/offers?max=1')
    expect(f.mock.calls[0]![1]!.method).toBe('GET')
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>)['Authorization']).toBe('klucz')
    const proto = Object.getOwnPropertyNames(MiraklReadOnly.prototype).filter((n) => n !== 'constructor')
    // getText (STO03, raport błędów CSV) to też GET
    expect(proto).toEqual(['get', 'getText'])
    await c.getText('/offers/stock/imports/1/error_report')
    expect(f.mock.calls[1]![1]!.method).toBe('GET')
  })
})
