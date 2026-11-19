// produkt bez stanu (DIGITAL) w imporcie i rdzeniu, zamówienie ręczne tylko z katalogu. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_RULES } from '@/lib/import/bez-stanu'
import { analyze } from '@/lib/import/katalog'
import { persistImport } from '@/lib/import/zapis'
import { applyOrgPreset, loadImportConfig } from '@/lib/organizacje'
import { fullSyncChannel, runFanout } from '@/lib/rdzen/propagacja'
import { issueInvoice, packOrder } from '@/lib/rdzen/rozchod'
import { createReturn, ReturnError } from '@/lib/rdzen/zwroty'
import { cancelOrder, ingestOrder, ValidationError } from '@/lib/rdzen/zamowienia'
import { ORG_A, seedImportConfig, TEST_ORGS, testDb, testSystemDb, truncateAll } from './db'
import { sale, shop, smallRaw } from './fixtures'
import { expectInvariants, FakeWfirma, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

async function digital(sku: string): Promise<string> {
  const p = await db.product.create({ data: { sku, kind: 'DIGITAL', unit: 'SZT', nameAccounting: `E-book ${sku}`, title: `E-book ${sku}`, vatRate: '5' } })
  return p.id
}

describe('import: e-book z reguły firmy', () => {
  beforeEach(async () => {
    await truncateAll(db)
    await seedImportConfig() // preset ACME: settings.catalog.noStock.skus = ['ebook1']
  })

  function rawWithEbook() {
    const raw = smallRaw()
    raw.shopOffers.push(shop({ productId: '9100', sku: 'ebook1', name: 'Poradnik (e-book)' }))
    raw.sales.lines.push(sale({ channel: 'WOO', accountId: '7100001', storage: 'shop', storageId: 'shop_7100001', productId: '9100', sku: 'ebook1', qty: 2 }))
    return raw
  }

  it('reguła z konfiguracji firmy → produkt DIGITAL bez stanu i aktywna oferta CONFIG; drugi przebieg bez zmian', async () => {
    const rules = (await loadImportConfig(db)).catalog!
    expect(rules.noStockSkus).toEqual(['ebook1'])
    const raw = rawWithEbook()
    const s = await persistImport(db, raw, analyze(raw, [], rules))
    expect(s).toMatchObject({ status: 'OK', digitalProducts: 1, products: 3, stocksCreated: 3 })
    const p = await db.product.findFirstOrThrow({ where: { sku: 'ebook1' }, include: { stocks: true } })
    expect(p).toMatchObject({ kind: 'DIGITAL', unit: 'SZT', wfirmaGoodId: null, title: 'Poradnik (e-book)' })
    expect(p.stocks).toEqual([])
    expect(await db.stockMovement.count({ where: { productId: p.id } })).toBe(0)
    expect(await db.channelOffer.findFirst({ where: { externalId: '9100' } })).toMatchObject({ productId: p.id, active: true, mappingSource: 'CONFIG', qtyBasePerOffer: 1 })
    expect(await db.channelOfferImport.findFirst({ where: { externalId: '9100' } })).toMatchObject({ state: 'MAPPED', source: 'CONFIG', productId: p.id })

    const s2 = await persistImport(db, rawWithEbook(), analyze(rawWithEbook(), [], rules))
    expect(s2).toMatchObject({ status: 'OK', digitalProducts: 1 })
    expect(await db.product.count({ where: { kind: 'DIGITAL' } })).toBe(1)
  })

  it('bez reguły e-book zostaje bez powiązania (bez ChannelOffer)', async () => {
    const raw = rawWithEbook()
    await persistImport(db, raw, analyze(raw, [], EMPTY_RULES))
    expect(await db.channelOfferImport.findFirst({ where: { externalId: '9100' } })).toMatchObject({ state: 'UNMAPPED' })
    expect(await db.channelOffer.count({ where: { externalId: '9100' } })).toBe(0)
  })

  it('produkt o tym SKU istnieje już ze stanem → ImportIssue, rodzaj bez zmian', async () => {
    await db.product.create({ data: { sku: 'ebook1', kind: 'STOCKED', unit: 'SZT', nameAccounting: 'Stary', title: 'Stary' } })
    const raw = rawWithEbook()
    const s = await persistImport(db, raw, analyze(raw, [], (await loadImportConfig(db)).catalog))
    expect(s.status).toBe('PARTIAL')
    expect(await db.product.findFirst({ where: { sku: 'ebook1' } })).toMatchObject({ kind: 'STOCKED' })
    const issue = await db.importIssue.findFirstOrThrow({ where: { kind: 'produkt', ref: 'digital:ebook1' } })
    expect(issue.message).toContain('reguła bez stanu nie zmienia rodzaju')
  })
})

describe('rdzeń: pozycja bez stanu', () => {
  beforeEach(async () => {
    await truncateAll(db)
    await seedBase(db)
  })

  it('nie rezerwuje i nie trafia do „brakuje”; zamówienie z samym brakującym towarem i e-bookiem = „brak wszystkiego”', async () => {
    const tea = await product(db, 'HERB-1', 0)
    const ebook = await digital('ebook-t1')
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1 }, { productId: tea, qty: 2 }]), { now: T0 })
    expect(r).toMatchObject({ reservedUnits: 0, shortUnits: 2 })
    expect(await db.reservation.count({ where: { productId: ebook } })).toBe(0)
    expect(await db.shortage.count({ where: { productId: ebook } })).toBe(0)
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o.shortageWaitUntil).not.toBeNull()
    expect(o.status).toBe('DO_REALIZACJI')
    await expectInvariants(db)
  })

  it('faktura: e-book jako usługa obok towaru, bez ruchu magazynowego dla e-booka', async () => {
    const tea = await product(db, 'HERB-2', 5)
    const ebook = await digital('ebook-t2')
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 29.9 }, { productId: tea, qty: 2 }]), { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    const wf = new FakeWfirma()
    expect(await issueInvoice(db, r.orderId!, wf, { now: T0 })).toBe('WYSTAWIONA')
    const lines = wf.invoices[0]!.lines
    expect(lines).toContainEqual({ productId: ebook, qty: 1, unitGrossGr: 2990, vatRate: '5', service: true })
    expect(lines.find((l) => l.productId === tea)).toMatchObject({ qty: 2 })
    expect(lines.find((l) => l.productId === tea)!.service).toBeUndefined()
    expect(await db.pendingMovement.count({ where: { productId: ebook } })).toBe(0)
    expect((await stockOf(db, tea)).physical).toBe(3)
    await expectInvariants(db)
  })

  it('stan nie idzie na kanał: pełna synchronizacja konta pomija ofertę e-booka', async () => {
    const tea = await product(db, 'HERB-3', 5)
    const ebook = await digital('ebook-t3')
    const teaOffer = await offer(db, 'WOO_SD', '501', tea)
    const ebookOffer = await offer(db, 'WOO_SD', '9100', ebook)
    await fullSyncChannel(db, { channel: 'WOO', channelAccountId: 'sd' }, { now: T0 })
    await runFanout(db, { now: T0 })
    expect(await db.stockSyncJob.findUnique({ where: { offerId: teaOffer } })).not.toBeNull()
    expect(await db.stockSyncJob.findUnique({ where: { offerId: ebookOffer } })).toBeNull()
  })

  it('anulowanie w Woo: FORCE_PUSH tylko dla oferty towaru, oferta e-booka bez zdarzenia i bez joba', async () => {
    const tea = await product(db, 'HERB-4', 5)
    const ebook = await digital('ebook-t4')
    const teaOffer = await offer(db, 'WOO_SD', '502', tea)
    const ebookOffer = await offer(db, 'WOO_SD', '9101', ebook)
    const r = await ingestOrder(db, order([{ offerExternalId: '9101', qty: 1 }, { offerExternalId: '502', qty: 1 }]), { now: T0 })
    await cancelOrder(db, r.orderId!, { now: T0 })
    const ev = await db.outboxEvent.findMany({ where: { kind: 'FORCE_PUSH' } })
    expect(ev.map((e) => e.offerId)).toEqual([teaOffer])
    await runFanout(db, { now: T0 })
    expect(await db.stockSyncJob.findUnique({ where: { offerId: ebookOffer } })).toBeNull()
    expect(await db.outboxEvent.count({ where: { kind: 'FORCE_PUSH', processedAt: null } })).toBe(0)
  })

  it('zwrot/korekta e-booka: jawna odmowa (ręcznie w wFirmie), także w zwrocie mieszanym; nic nie zapisane', async () => {
    const tea = await product(db, 'HERB-5', 5)
    const ebook = await digital('ebook-t5')
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 29.9 }, { productId: tea, qty: 2 }]), { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    expect(await issueInvoice(db, r.orderId!, new FakeWfirma(), { now: T0 })).toBe('WYSTAWIONA')
    const lines = await db.orderLine.findMany({ where: { orderId: r.orderId! }, orderBy: { externalLineId: 'asc' } })
    const [ebookLine, teaLine] = [lines.find((l) => l.productId === ebook)!, lines.find((l) => l.productId === tea)!]
    const mixed = createReturn(db, r.orderId!, [{ orderLineId: teaLine.id, qty: 1 }, { orderLineId: ebookLine.id, qty: 1 }], { now: T0 })
    await expect(mixed).rejects.toBeInstanceOf(ReturnError)
    await expect(createReturn(db, r.orderId!, [{ orderLineId: ebookLine.id, qty: 1 }], { now: T0 })).rejects.toThrow(/bez stanu.*ręcznie w wFirmie/)
    await expect(
      createReturn(db, r.orderId!, [{ orderLineId: ebookLine.id, qty: 1, disposition: 'NA_STAN' }], { kind: 'KOREKTA', now: T0 }),
    ).rejects.toBeInstanceOf(ReturnError)
    expect(await db.return.count()).toBe(0)
    expect(await db.returnLine.count()).toBe(0)
    // sam towar z tego zamówienia nadal da się zwrócić
    await createReturn(db, r.orderId!, [{ orderLineId: teaLine.id, qty: 1 }], { now: T0 })
    expect(await db.return.count()).toBe(1)
  })
})

describe('zamówienie ręczne (RECZNE) tylko z katalogu', () => {
  beforeEach(async () => {
    await truncateAll(db)
    await seedBase(db)
  })

  it('pozycja bez produktu albo z ofertą zamiast produktu → ValidationError, nic nie zapisane', async () => {
    const tea = await product(db, 'HERB-4', 5)
    await expect(ingestOrder(db, order([{ qty: 3, offerExternalId: 'lizak hurt' }], { channel: 'RECZNE' }), { now: T0 })).rejects.toThrow(ValidationError)
    await expect(ingestOrder(db, order([{ productId: tea, offerExternalId: 'x', qty: 1 }], { channel: 'RECZNE' }), { now: T0 })).rejects.toThrow(ValidationError)
    await expect(ingestOrder(db, order([{ productId: 'nie-ma-takiego', qty: 1 }], { channel: 'RECZNE' }), { now: T0 })).rejects.toThrow(/spoza katalogu/)
    expect(await db.order.count()).toBe(0)
    expect(await db.inboundEvent.count()).toBe(0)
  })

  it('produkt z katalogu → rezerwacja jak w każdym kanale (zdejmuje stan)', async () => {
    const tea = await product(db, 'HERB-5', 200)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 144 }], { channel: 'RECZNE' }), { now: T0 })
    expect(r).toMatchObject({ outcome: 'NOWE', reservedUnits: 144, shortUnits: 0 })
    expect((await stockOf(db, tea)).reserved).toBe(144)
    await expectInvariants(db)
  })
})

describe('preset firmy nie kasuje ustawień spoza `baselinker`', () => {
  beforeEach(async () => {
    await truncateAll(db)
  })

  const sys = testSystemDb()
  const settingsOf = async () => (await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings
  const preset = { ...TEST_ORGS[0]!, settings: { baselinker: { inventoryId: '777' }, catalog: { noStock: { skus: ['z-presetu'] } } } }

  it('firma z samym `catalog`: dostaje brakujący `baselinker`, jej `catalog` zostaje', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { catalog: { noStock: { skus: ['ebook-firmy'] } } } } })
    await applyOrgPreset(sys, preset)
    expect(await settingsOf()).toEqual({ catalog: { noStock: { skus: ['ebook-firmy'] } }, baselinker: { inventoryId: '777' } })
    await applyOrgPreset(sys, preset) // drugi start bez zmian
    expect(await settingsOf()).toEqual({ catalog: { noStock: { skus: ['ebook-firmy'] } }, baselinker: { inventoryId: '777' } })
  })

  it('pusty `baselinker` liczy się jako brak; inne klucze firmy (np. `akcje`) zostają; ustawiony `baselinker` wygrywa', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { baselinker: { inventoryId: '' }, akcje: { trybProduktow: 'PRACA' } } } })
    await applyOrgPreset(sys, preset)
    expect(await settingsOf()).toEqual({ baselinker: { inventoryId: '777' }, akcje: { trybProduktow: 'PRACA' }, catalog: { noStock: { skus: ['z-presetu'] } } })
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { baselinker: { inventoryId: '123' } } } })
    await applyOrgPreset(sys, preset)
    expect(await settingsOf()).toEqual({ baselinker: { inventoryId: '123' }, catalog: { noStock: { skus: ['z-presetu'] } } })
  })

  it('firma z `nonOfferSkus: []` dostaje listę z presetu, jej `noStock.skus` zostaje, drugi start bez zmian', async () => {
    const acmeLike = { ...preset, settings: { catalog: { noStock: { skus: ['z-presetu'] }, nonOfferSkus: ['naklejka', '80011'] } } }
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { baselinker: { inventoryId: '123' }, catalog: { noStock: { skus: ['ebook-firmy'] }, nonOfferSkus: [] } } } })
    const expected = { baselinker: { inventoryId: '123' }, catalog: { noStock: { skus: ['ebook-firmy'] }, nonOfferSkus: ['naklejka', '80011'] } }
    await applyOrgPreset(sys, acmeLike)
    expect(await settingsOf()).toEqual(expected)
    await applyOrgPreset(sys, acmeLike)
    expect(await settingsOf()).toEqual(expected)
  })

  it('firma bez ustawień dostaje cały preset', async () => {
    await applyOrgPreset(sys, preset)
    expect(await settingsOf()).toEqual(preset.settings)
  })
})
