import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { analyze } from '@/lib/import/katalog'
import { persistImport } from '@/lib/import/zapis'
import { smallRaw } from './fixtures'
import { ORG_A, seedImportConfig, testDb, truncateAll } from './db'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedImportConfig()
})
afterAll(() => db.$disconnect())

describe('zapis importu do bazy', () => {
  it('zakłada produkty, zestaw, stan startowy w gramach i oferty kanałów; konfiguracja kanałów (z konfiguracji firmy) zostaje w trybie CIEN', async () => {
    const raw = smallRaw()
    const s = await persistImport(db, raw, analyze(raw))
    expect(s).toMatchObject({ status: 'OK', products: 3, bundles: 1, stocksCreated: 3, issues: 0 })
    const kg = await db.product.findUniqueOrThrow({ where: { organizationId_sku: { organizationId: ORG_A, sku: 'B1' } }, include: { stocks: true } })
    expect(kg.unit).toBe('KG')
    expect(kg.stocks[0]).toMatchObject({ wfirmaCount: 2500, physical: 2500, reserved: 0, pendingDelta: 0 })
    expect(kg.title).toBe('Przyprawa B')
    expect(kg.nameAccounting).toBe('Przyprawa B luz')
    const bundle = await db.product.findUniqueOrThrow({ where: { organizationId_sku: { organizationId: ORG_A, sku: 'A1-zestaw' } }, include: { bundleComponents: true, stocks: true } })
    expect(bundle.kind).toBe('BUNDLE')
    expect(bundle.stocks).toHaveLength(0)
    expect(bundle.bundleComponents.map((c) => c.qtyBase).sort()).toEqual([1, 2])
    const offers = await db.channelOffer.findMany({ orderBy: { externalId: 'asc' } })
    expect(offers.map((o) => `${o.channel}:${o.externalId}:${o.qtyBasePerOffer}`)).toEqual([
      'WOO:501:1',
      'EMPIK:777:1',
      'ALLEGRO:9001:1000',
    ])
    expect(await db.channelOfferImport.count({ where: { state: 'UNMAPPED' } })).toBe(2)
    expect(await db.channelConfig.count({ where: { stockMode: 'CIEN', publishMode: 'CIEN' } })).toBe(6) // 5 kont importu + EasyTools
    expect(await db.stockMovement.count({ where: { source: 'INITIAL_IMPORT' } })).toBe(3)
  })

  it('ponowny import jest idempotentny i nie nadpisuje stanu, tytułu z panelu ani trybu kanału', async () => {
    const raw = smallRaw()
    await persistImport(db, raw, analyze(raw))
    await db.product.update({ where: { organizationId_sku: { organizationId: ORG_A, sku: 'A1' } }, data: { title: 'Tytuł z panelu' } })
    await db.channelConfig.update({
      where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, channel: 'EMPIK', channelAccountId: '30193' } },
      data: { stockMode: 'PRACA' },
    })
    const raw2 = smallRaw()
    raw2.wfirma!.goods[0]!.countBase = 99
    raw2.wfirma!.goods[0]!.name = 'Nowa nazwa księgowa'
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2).toMatchObject({ stocksCreated: 0, stocksKept: 3, status: 'OK' })
    const a1 = await db.product.findUniqueOrThrow({ where: { organizationId_sku: { organizationId: ORG_A, sku: 'A1' } }, include: { stocks: true } })
    expect(a1.title).toBe('Tytuł z panelu')
    expect(a1.nameAccounting).toBe('Nowa nazwa księgowa')
    expect(a1.stocks[0]!.wfirmaCount).toBe(7) // lustro stanu prowadzi rdzeń, nie import
    expect(await db.product.count()).toBe(4)
    expect(await db.channelOffer.count()).toBe(3)
    expect(await db.stockMovement.count()).toBe(3)
    expect(await db.importRun.count()).toBe(2)
    const empik = await db.channelConfig.findFirstOrThrow({ where: { channel: 'EMPIK' } })
    expect(empik.stockMode).toBe('PRACA')
  })

  it('błąd jednego elementu nie przerywa importu: PARTIAL + ImportIssue, reszta zapisana', async () => {
    const raw = smallRaw()
    const a = analyze(raw)
    a.offers.push({ ...a.offers[0]!, channel: 'NIE_MA' as never, externalId: 'zly' })
    const s = await persistImport(db, raw, a)
    expect(s.status).toBe('PARTIAL')
    expect(s.issues).toBe(1)
    const run = await db.importRun.findUniqueOrThrow({ where: { id: s.runId }, include: { issues: true } })
    expect(run.status).toBe('PARTIAL')
    expect(run.issues[0]!.kind).toBe('oferta')
    expect(await db.channelOfferImport.count()).toBe(5)
  })

  it('oferta, która straciła jednoznaczne powiązanie, przestaje być aktywna (nie rezerwuje dawnego produktu)', async () => {
    const raw = smallRaw()
    await persistImport(db, raw, analyze(raw))
    const raw2 = smallRaw()
    raw2.sales.lines.push({ ...raw2.sales.lines[1]!, orderId: 'x2', productId: '3' }) // oferta 9001 → dwa produkty BL
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.channelOffersDeactivated).toBe(1)
    const o = await db.channelOffer.findFirstOrThrow({ where: { externalId: '9001' } })
    expect(o.active).toBe(false)
    expect((await db.channelOfferImport.findFirstOrThrow({ where: { externalId: '9001' } })).state).toBe('AMBIGUOUS')
    const s3 = await persistImport(db, raw, analyze(raw))
    expect(s3.channelOffersDeactivated).toBe(0)
    expect((await db.channelOffer.findFirstOrThrow({ where: { externalId: '9001' } })).active).toBe(true)
  })

  it('zestaw, którego składnik się nie zapisał, trafia do ImportIssue zamiast zapisać się z niepełnym składem', async () => {
    const raw = smallRaw()
    const a = analyze(raw)
    const bundle = a.plan.products.find((p) => p.kind === 'BUNDLE')!
    bundle.components.push({ componentKey: 'wf:nie-ma', qtyBase: 1 })
    const s = await persistImport(db, raw, a)
    expect(s.status).toBe('PARTIAL')
    expect(await db.bundleComponent.count()).toBe(0)
    expect(await db.importIssue.count({ where: { kind: 'produkt', ref: bundle.key } })).toBe(1)
  })

  it('syntetyczne id (bl:<id>) nigdy nie staje się ChannelOffer; zniknięte oferty są sprzątane', async () => {
    const raw = smallRaw()
    raw.sales.lines.push({ ...raw.sales.lines[0]!, orderId: 'b1', productId: '3' }) // Woo z magazynu BL, produkt bez linku
    await persistImport(db, raw, analyze(raw))
    expect(await db.channelOffer.count({ where: { externalId: { startsWith: 'bl:' } } })).toBe(0)
    expect((await db.channelOfferImport.findFirstOrThrow({ where: { externalId: 'bl:3' } })).state).toBe('UNMAPPED')
    const s2 = await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect(s2.staleRemoved).toBe(1)
    expect(await db.channelOfferImport.count({ where: { externalId: 'bl:3' } })).toBe(0)
  })

  it('problemy pobierania trafiają do ImportIssue', async () => {
    const raw = smallRaw()
    raw.issues.push({ kind: 'wfirma', ref: 'goods/find', message: 'TOTAL REQUESTS LIMIT EXCEEDED' })
    const s = await persistImport(db, raw, analyze(raw))
    expect(s.status).toBe('PARTIAL')
    expect(await db.importIssue.count({ where: { kind: 'pobieranie:wfirma' } })).toBe(1)
  })
})
