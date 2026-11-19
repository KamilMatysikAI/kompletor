import { describe, expect, it } from 'vitest'
import { AtrapaBlPrzeprowadzki } from '@/tests/bl-przeprowadzka-atrapa'
import { ReadOnlyViolation } from '../zrodla/http'
import { assertMetodaPrzeprowadzki, METODY_PRZEPROWADZKI, MetodaSpozaListy } from './metody'

describe('lista metod BL przeprowadzki', () => {
  it('dokładna lista: 21 metod odczytu, wszystkie get*', () => {
    expect([...METODY_PRZEPROWADZKI].sort()).toEqual(
      [
        'getInventories',
        'getInventoryWarehouses',
        'getInventoryPriceGroups',
        'getInventoryCategories',
        'getInventoryManufacturers',
        'getInventoryIntegrations',
        'getInventoryProductsList',
        'getInventoryProductsData',
        'getInventoryProductsStock',
        'getInventoryProductsPrices',
        'getExternalStoragesList',
        'getExternalStorageProductsList',
        'getExternalStorageProductsData',
        'getOrderSources',
        'getOrderStatusList',
        'getOrderStatusGroups',
        'getOrderExtraFields',
        'getOrders',
        'getCourierAccounts',
        'getCouriersList',
        'getSeries',
      ].sort(),
    )
    for (const m of METODY_PRZEPROWADZKI) expect(m).toMatch(/^get[A-Z]/)
  })

  it.each(['getOrdersByEmail', 'getOrdersByPhone', 'getCrmClients', 'getCrmClientData', 'getLabel', 'getInvoiceFile', 'getInvoices', 'getOrderPackages', 'getJournalList'])(
    'odmowa odczytu spoza listy: %s — zapytanie nie wychodzi',
    async (method) => {
      const fake = new AtrapaBlPrzeprowadzki()
      const bl = fake.client()
      await expect(bl.call(method)).rejects.toBeInstanceOf(MetodaSpozaListy)
      expect(fake.calls).toEqual([])
      expect(() => assertMetodaPrzeprowadzki(method)).toThrow(ReadOnlyViolation)
    },
  )

  it.each(['addOrder', 'setOrderStatus', 'updateInventoryProductsStock', 'deleteOrder', 'runOrderMacroTrigger'])('odmowa zapisu: %s', async (method) => {
    const fake = new AtrapaBlPrzeprowadzki()
    await expect(fake.client().call(method)).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(fake.calls).toEqual([])
  })

  it('metoda z listy przechodzi i jest liczona', async () => {
    const fake = new AtrapaBlPrzeprowadzki()
    const bl = fake.client()
    await bl.call('getOrderStatusList')
    await bl.call('getOrderStatusList')
    expect(fake.calls.map((c) => c.method)).toEqual(['getOrderStatusList', 'getOrderStatusList'])
    expect(bl.wywolania.get('getOrderStatusList')).toBe(2)
  })
})
