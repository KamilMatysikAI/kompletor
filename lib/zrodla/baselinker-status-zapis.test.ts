// klient BL z jednym zapisem (`setOrderStatus`); każda inna metoda zapisu odrzucona przed żądaniem.
import { describe, expect, it, vi } from 'vitest'
import { assertBlStatusZapis, BaseLinkerReadOnly, BaseLinkerStatusZapis, BL_ZAPIS_DOZWOLONY } from './baselinker'
import { ReadOnlyViolation } from './http'

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('BaseLinkerStatusZapis', () => {
  it('lista zapisu ma tylko setOrderStatus', () => {
    expect([...BL_ZAPIS_DOZWOLONY]).toEqual(['setOrderStatus'])
  })

  it.each(['addOrder', 'setOrderFields', 'setOrderPayment', 'addOrderInvoiceFile', 'updateInventoryProductsStock', 'deleteOrder', 'runOrderMacroTrigger', 'setorderstatus', 'setOrderStatuses'])(
    'odrzuca %s bez wysłania żądania',
    async (m) => {
      const f = vi.fn()
      const c = new BaseLinkerStatusZapis('t', f, 0)
      await expect(c.call(m)).rejects.toBeInstanceOf(ReadOnlyViolation)
      expect(f).not.toHaveBeenCalled()
      expect(() => assertBlStatusZapis(m)).toThrow(ReadOnlyViolation)
    },
  )

  it('wysyła setOrderStatus i odczyty get*', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => okJson({ status: 'SUCCESS' }))
    const c = new BaseLinkerStatusZapis('t', f, 0)
    await c.call('setOrderStatus', { order_id: 1, status_id: 388071 })
    await c.call('getOrders', { order_id: 1 })
    expect(f).toHaveBeenCalledTimes(2)
    expect(String(f.mock.calls[0]![1]!.body)).toContain('method=setOrderStatus')
  })

  it('klient tylko do odczytu dalej odrzuca setOrderStatus', async () => {
    const f = vi.fn()
    await expect(new BaseLinkerReadOnly('t', f, 0).call('setOrderStatus')).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(f).not.toHaveBeenCalled()
  })
})
