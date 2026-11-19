// Konto Shoper na bazie, wyłącznie na atrapie HTTP: `npm run konto -- dodaj` i `-- test` (sekret konta
// w bazie, zaszyfrowany), odczyt zamówień do cienia z rezerwacją, pozycja bez oferty → „Do wyjaśnienia”, i pominięcie
// konta bez BL w porównaniu z BL (accountsForComparison).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { setSecret } from '@/lib/sekrety'
import { dodajKonto, testKonta } from '@/scripts/konto-kanalu'
import { testDb, truncateAll } from './db'
import { product, seedBase, stockOf } from './rdzen-fixtures'
import { ShoperAtrapa } from './shoper-atrapa'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const T = new Date('2026-11-02T12:00:00.000Z')
const ENV = { APP_ENCRYPTION_KEY: '2'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const TOKEN = 'tok-shoper-test'
const SCOPE = { channel: 'SHOPER' as const, channelAccountId: 'sklep1' }

let at: ShoperAtrapa

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  at = new ShoperAtrapa({ token: TOKEN })
})

async function dodaj() {
  return dodajKonto(db, defaultRegistry(), { kanal: 'SHOPER', konto: 'sklep1', nazwa: 'Sklep na Shoperze', adapter: 'shoper.rest.v1', config: { baseUrl: at.host } }, 'test-a')
}

describe('konto Shoper na atrapie', () => {
  it('dodaj → sekret → test połączenia; drugie dodanie odmówione', async () => {
    await dodaj()
    const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'SHOPER')!
    expect(acc).toMatchObject({ channelAccountId: 'sklep1', adapterKey: 'shoper.rest.v1', config: { baseUrl: at.host }, active: true })
    await expect(dodaj()).rejects.toThrow(/już istnieje/)
    const bez = await testKonta(db, defaultRegistry(), SRC, 'SHOPER/sklep1', { fetch: at.fetch })
    expect(bez.code).toBe(1)
    expect(bez.lines[0]).toContain('brak sekretu SHOPER_ACCESS_TOKEN')
    await setSecret(db, 'SHOPER_ACCESS_TOKEN', TOKEN, ENV, SCOPE)
    const ok = await testKonta(db, defaultRegistry(), SRC, 'SHOPER/sklep1', { fetch: at.fetch })
    expect(ok).toEqual({ code: 0, lines: ['[konto] Sklep na Shoperze (SHOPER/sklep1, shoper.rest.v1): OK — odczyt zamówień i statusów działa {"orders":0,"statuses":5}'] })
    expect(new Set(at.requests())).toEqual(new Set(['GET']))
  })

  it('odczyt do cienia: oferta z importu rezerwuje, pozycja bez oferty → do wyjaśnienia; konto pominięte w porównaniu z BL', async () => {
    await dodaj()
    await setSecret(db, 'SHOPER_ACCESS_TOKEN', TOKEN, ENV, SCOPE)
    const a = await product(db, 'A', 5)
    await db.channelOffer.create({ data: { ...SCOPE, externalId: '10', productId: a, qtyBasePerOffer: 1 } })
    at.putOrder({ externalId: '1', state: 'open', offer: '10', qty: 2, createdAt: new Date(T.getTime() - 3600_000), modifiedAt: new Date(T.getTime() - 3600_000) })
    at.putOrder({ externalId: '2', state: 'open', offer: '99', qty: 1, createdAt: new Date(T.getTime() - 1800_000), modifiedAt: new Date(T.getTime() - 1800_000) })
    const acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'SHOPER')!
    const s = await pollAccount(db, acc, { registry: defaultRegistry(), secrets: SRC, fetch: at.fetch, now: () => T })
    expect(s).toMatchObject({ items: 2, bledyTrwale: 0, doPonowienia: 0 })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2, available: 3 })
    const orders = await db.order.findMany({ where: { channel: 'SHOPER' }, orderBy: { externalId: 'asc' }, select: { externalId: true, status: true } })
    expect(orders).toEqual([
      { externalId: '1', status: 'DO_REALIZACJI' }, // opłacone
      { externalId: '2', status: 'DO_WYJASNIENIA' },
    ])
    const cmp = await accountsForComparison(db)
    expect(cmp.some((x) => x.channel === 'SHOPER')).toBe(false)
    expect(cmp.some((x) => x.channel === 'WOO')).toBe(true)
  }, 60_000)
})
