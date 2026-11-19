// konto PrestaShop (i Shoper) nie ma źródła w BL — porównanie cienia z BL nie może go pokazywać jako
// rozjazdu („brak w BL” dla każdego zamówienia), więc accountsForComparison je pomija. Konta Woo zostają.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { testDb, truncateAll } from './db'
import { seedBase } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('porównanie z BL: konta sklepów bez BL', () => {
  it('PRESTASHOP i SHOPER pominięte, WOO i reszta zostają', async () => {
    await db.channelConfig.createMany({
      data: [
        { channel: 'PRESTASHOP', channelAccountId: 'demo', name: 'Sklep PrestaShop', adapterKey: 'prestashop.ws.v1', config: { baseUrl: 'https://sklep.example.invalid' } },
        { channel: 'SHOPER', channelAccountId: 'demo', name: 'Sklep Shoper', adapterKey: 'shoper.rest.v1', config: { baseUrl: 'https://shoper.example.invalid' } },
      ],
    })
    const acc = await accountsForComparison(db)
    expect(acc.map((a) => a.channel)).not.toContain('PRESTASHOP')
    expect(acc.map((a) => a.channel)).not.toContain('SHOPER')
    expect(acc.map((a) => `${a.channel}/${a.channelAccountId}`)).toContain('WOO/sd')
  })
})
