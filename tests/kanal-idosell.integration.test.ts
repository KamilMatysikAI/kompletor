// Konto IdoSell na bazie, wyłącznie na atrapie HTTP (tests/idosell-atrapa.ts), bez prawdziwego IdoSell:
// dodanie konta i sekretu, test połączenia (same odczyty), zamówienie z IdoSell przez rdzeń (rezerwacja od chwili
// zamówienia, kryterium 1), propagacja stanu na drugi kanał (fałszywy Woo) i z powrotem do IdoSell przez host zapisu;
// wyłącznik zapisu = zero żądań zapisu; konto pominięte w porównaniu z BL; bez uzupełnionej tabeli „Statusy w sklepie”
// zero zmian statusu w sklepie.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { IDOSELL_DEFINITION, IDOSELL_ZAPIS_DEFINITION } from '@/lib/adaptery/idosell'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { adapterStanowKonta, przebiegZapisuKanalow, wyslijStanyKonta, zaplanujZapisy } from '@/lib/kanaly/zapis-host'
import { runFanout, runStockPush } from '@/lib/rdzen/propagacja'
import { setSecret } from '@/lib/sekrety'
import { dodajKonto, testKonta } from '@/scripts/konto-kanalu'
import { ORG_A, testDb, truncateAll } from './db'
import { IdoSellAtrapa } from './idosell-atrapa'
import { ACC, offer, product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const T = new Date('2026-11-09T12:00:00.000Z')
const ENV = { APP_ENCRYPTION_KEY: '3'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const KEY = 'klucz-ido-integracja'
const IDO = { channel: 'IDOSELL' as const, channelAccountId: 'ido1' }
const SD = ACC.WOO_SD
const where = (a: { channel: 'IDOSELL' | 'WOO'; channelAccountId: string }) => ({ organizationId_channel_channelAccountId: { organizationId: ORG_A, ...a } })

let at: IdoSellAtrapa
let state: FakeChannelState
let registry: AdapterRegistry

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  at = new IdoSellAtrapa({ apiKey: KEY })
  state = new FakeChannelState()
  registry = new AdapterRegistry([IDOSELL_DEFINITION, IDOSELL_ZAPIS_DEFINITION, fakeDefinition(state, 'WOO')])
})

async function dodaj(adapter = 'idosell.admin.zapis.v1') {
  await dodajKonto(db, registry, { kanal: 'IDOSELL', konto: 'ido1', nazwa: 'Sklep IdoSell', adapter, config: { baseUrl: at.host } }, 'test-a')
  await setSecret(db, 'IDOSELL_API_KEY', KEY, ENV, IDO)
}
const konto = async () => (await loadChannelAccounts(db)).find((a) => a.channel === 'IDOSELL')!

describe('konto IdoSell na atrapie', () => {
  it('dodaj → sekret → test połączenia: same odczyty (POST wyszukiwania), zapis wyłączony', async () => {
    await dodajKonto(db, registry, { kanal: 'IDOSELL', konto: 'ido1', nazwa: 'Sklep IdoSell', adapter: 'idosell.admin.zapis.v1', config: { baseUrl: at.host } }, 'test-a')
    const bez = await testKonta(db, registry, SRC, 'IDOSELL/ido1', { fetch: at.fetch })
    expect(bez.code).toBe(1)
    expect(bez.lines[0]).toContain('IDOSELL_API_KEY')
    await setSecret(db, 'IDOSELL_API_KEY', KEY, ENV, IDO)
    const ok = await testKonta(db, registry, SRC, 'IDOSELL/ido1', { fetch: at.fetch })
    expect(ok.code).toBe(0)
    expect(ok.lines[0]).toContain('odczyt zamówień i produktów działa')
    expect(ok.lines[0]).toContain('"zapisWlaczony":false')
    expect(new Set(at.requests())).toEqual(new Set(['POST']))
  })

  it('zamówienie z IdoSell rezerwuje od chwili zamówienia i obniża stan w drugim kanale; potem stan wraca do IdoSell (PRACA, zapis włączony)', async () => {
    await dodaj()
    const a = await product(db, 'A', 5)
    const ido = await db.channelOffer.create({ data: { ...IDO, externalId: '10', productId: a, qtyBasePerOffer: 1, lastPushedQty: 5, lastPushedAt: new Date(T.getTime() - 86_400_000) } })
    const woo = await offer(db, 'WOO_SD', '10', a)
    await db.channelOffer.update({ where: { id: woo }, data: { lastPushedQty: 5, lastPushedAt: new Date(T.getTime() - 86_400_000) } })
    await db.channelConfig.update({ where: where(SD), data: { adapterKey: 'fake.v1', stockMode: 'PRACA', config: { zapisWlaczony: true } as Prisma.InputJsonValue } })
    at.putProduct(10, [{ qty: 5 }])
    // nieopłacone zamówienie: rezerwacja od chwili zamówienia, nie od płatności
    at.putOrder({ externalId: '501', state: 'open', offer: '10', qty: 2, createdAt: new Date(T.getTime() - 3600_000), modifiedAt: new Date(T.getTime() - 3600_000) }, { paid: false })
    at.putOrder({ externalId: '502', state: 'open', offer: '99', qty: 1, createdAt: new Date(T.getTime() - 1800_000), modifiedAt: new Date(T.getTime() - 1800_000) })
    const s = await pollAccount(db, await konto(), { registry, secrets: SRC, fetch: at.fetch, now: () => T })
    expect(s).toMatchObject({ items: 2, bledyTrwale: 0, doPonowienia: 0 })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2, available: 3 })
    const orders = await db.order.findMany({ where: { channel: 'IDOSELL' }, orderBy: { externalId: 'asc' }, select: { externalId: true, status: true, paymentState: true } })
    expect(orders).toEqual([
      { externalId: '501', status: 'NOWE', paymentState: 'UNPAID' },
      { externalId: '502', status: 'DO_WYJASNIENIA', paymentState: 'PAID' }, // oferta 99 bez powiązania
    ])

    const t1 = new Date(T.getTime() + 5_000)
    await runFanout(db, { now: t1 })
    const ctx = { registry, secrets: SRC, now: new Date(T.getTime() + 30_000), fetch: at.fetch, http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 } }
    const wooAd = await adapterStanowKonta(db, SD, ctx)
    if (!wooAd || 'zablokowane' in wooAd) throw new Error('konto Woo powinno zapisać')
    expect((await runStockPush(db, SD, wooAd, { now: ctx.now })).sent).toBe(1)
    expect(state.stock.get('10')).toBe(3)

    // IdoSell w podglądzie: host nie daje adaptera, żadnego żądania zapisu
    const przed = at.writes().length
    expect(await adapterStanowKonta(db, IDO, ctx)).toBeNull()
    // PRACA bez włączonego zapisu: powód zamiast żądania
    await db.channelConfig.update({ where: where(IDO), data: { stockMode: 'PRACA' } })
    expect(await wyslijStanyKonta(db, IDO, ctx)).toMatchObject({ zablokowane: expect.stringMatching(/zapis do sklepu wyłączony/) })
    expect(at.writes().length).toBe(przed)
    // PRACA + zapis włączony: stan 3 ustawiony w IdoSell (set, magazyn 1)
    const cfg = (await db.channelConfig.findUniqueOrThrow({ where: where(IDO) })).config as Record<string, unknown>
    await db.channelConfig.update({ where: where(IDO), data: { config: { ...cfg, zapisWlaczony: true } as Prisma.InputJsonValue } })
    const st = await wyslijStanyKonta(db, IDO, ctx)
    expect(st).toMatchObject({ sent: 1 })
    expect(at.stockOf(10)).toBe(3)
    expect(at.writes().map((w) => w.path)).toEqual(['products/stocks'])
    expect((await db.channelOffer.findUniqueOrThrow({ where: { id: ido.id } })).lastPushedQty).toBe(3)

    // konto spoza BL nie wchodzi do porównania z BL
    const cmp = await accountsForComparison(db)
    expect(cmp.some((x) => x.channel === 'IDOSELL')).toBe(false)
  }, 60_000)

  it('PRACA + zapis włączony, ale bez uzupełnionej tabeli „Statusy w sklepie” = zero zmian statusu w IdoSell; po uzupełnieniu status idzie', async () => {
    await dodaj()
    at.putProduct(10, [{ qty: 5 }])
    at.putOrder({ externalId: '601', state: 'open', offer: '10', qty: 1, createdAt: new Date(T.getTime() - 3600_000), modifiedAt: new Date(T.getTime() - 3600_000) })
    expect(await pollAccount(db, await konto(), { registry, secrets: SRC, fetch: at.fetch, now: () => T })).toMatchObject({ items: 1, bledyTrwale: 0 })
    await db.channelConfig.update({ where: where(IDO), data: { statusMode: 'PRACA', stockMode: 'PRACA' } })
    const cfg = (await db.channelConfig.findUniqueOrThrow({ where: where(IDO) })).config as Record<string, unknown>
    expect(cfg['statusy']).toBeUndefined()
    await db.channelConfig.update({ where: where(IDO), data: { config: { ...cfg, zapisWlaczony: true } as Prisma.InputJsonValue } })
    await db.order.updateMany({ where: { channel: 'IDOSELL', externalId: '601' }, data: { status: 'WYSLANE', updatedAt: T } })
    const ctx = { registry, secrets: SRC, now: new Date(T.getTime() + 60_000), fetch: at.fetch, http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 } }

    expect((await zaplanujZapisy(db, registry, { now: ctx.now })).statusy).toBe(0)
    await przebiegZapisuKanalow(db, ctx)
    expect(at.writes().filter((w) => w.path === 'orders/orders')).toEqual([])
    expect(await db.channelWrite.count({ where: { channel: 'IDOSELL', kind: 'STATUS' } })).toBe(0)
    expect(at.statusOf('601')).toBe('new')

    // kontrola: świadomie uzupełniona tabela (Wysłane → finished) = jeden zapis statusu
    await db.channelConfig.update({ where: where(IDO), data: { config: { ...cfg, zapisWlaczony: true, statusy: { WYSLANE: 'finished' } } as Prisma.InputJsonValue } })
    expect((await zaplanujZapisy(db, registry, { now: ctx.now })).statusy).toBe(1)
    await przebiegZapisuKanalow(db, { ...ctx, now: new Date(ctx.now.getTime() + 60_000) })
    expect(at.writes().filter((w) => w.path === 'orders/orders').length).toBe(1)
    expect(at.statusOf('601')).toBe('finished')
  }, 60_000)
})
