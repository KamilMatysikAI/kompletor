// zapis importu po drugim przeglądzie (uwagi 1–4, 8, 9, 17 + lokalizacje, nadpisania).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { analyze, MISSING_KEYS } from '@/lib/import/katalog'
import { parseOfferOverrides } from '@/lib/import/nadpisania'
import { ImportRefused, persistImport } from '@/lib/import/zapis'
import { reapStale, claimNext, enqueue } from '@/lib/worker/kolejka'
import { shop, smallRaw, testKnownAccounts } from './fixtures'
import { ORG_A, seedImportConfig, testDb, truncateAll } from './db'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedImportConfig() // magazyn i kanały z konfiguracji firmy, nie z importu
})
afterAll(() => db.$disconnect())

const offer = (externalId: string) => db.channelOffer.findFirst({ where: { externalId } })

describe('uwaga 1: Woo po samym SKU', () => {
  it('pojedyncza oferta po SKU → ChannelOffer nieaktywna do zatwierdzenia; warianty o wspólnym SKU → brak ChannelOffer', async () => {
    const raw = smallRaw()
    raw.shopOffers.push(
      shop({ productId: '600', sku: 'C1' }),
      shop({ productId: '7', isParentWithVariants: true }),
      shop({ productId: '7', variantId: '70', sku: 'B1' }),
      shop({ productId: '7', variantId: '71', sku: 'B1' }),
    )
    const s = await persistImport(db, raw, analyze(raw))
    expect(s.channelOffersProposed).toBe(1)
    expect(await offer('600')).toMatchObject({ active: false, needsApproval: true, mappingSource: 'SKU' })
    expect(await db.channelOffer.count({ where: { externalId: { in: ['7/70', '7/71'] } } })).toBe(0)
    const imp = await db.channelOfferImport.findFirstOrThrow({ where: { externalId: '7/70' } })
    expect(imp.state).toBe('AMBIGUOUS')
    expect(imp.notes.join()).toContain('warianty o wspólnym SKU')
    // drugi przebieg: propozycja zostaje nieaktywna (import jej nie włącza)
    await persistImport(db, raw, analyze(raw))
    expect(await offer('600')).toMatchObject({ active: false, needsApproval: true })
  })

  it('aktywna oferta, która straciła link i ma już tylko SKU, gaśnie jako propozycja; po powrocie linku wraca', async () => {
    const raw = smallRaw()
    await persistImport(db, raw, analyze(raw))
    expect(await offer('501')).toMatchObject({ active: true, mappingSource: 'BL_LINK' })
    const raw2 = smallRaw()
    raw2.bl.products[0]!.links = { accounting_1: { productId: '100', variantId: '0' } } // link do sklepu usunięty w BL
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.channelOffersDeactivated).toBe(1)
    expect(await offer('501')).toMatchObject({ active: false, needsApproval: true, mappingSource: 'SKU' })
    const s3 = await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect(s3.channelOffersReactivated).toBe(1)
    expect(await offer('501')).toMatchObject({ active: true, needsApproval: false, deactivatedByImportAt: null })
  })
})

describe('uwaga 2: ręczne powiązanie i ręczne wyłączenie przeżywają import', () => {
  it('MANUAL: import nie zmienia productId, active ani qtyBasePerOffer', async () => {
    const raw = smallRaw()
    await persistImport(db, raw, analyze(raw))
    const c1 = await db.product.findFirstOrThrow({ where: { sku: 'C1' } })
    await db.channelOffer.update({
      where: { organizationId_channel_channelAccountId_externalId: { organizationId: ORG_A, channel: 'ALLEGRO', channelAccountId: '71045', externalId: '9001' } },
      data: { mappingSource: 'MANUAL', productId: c1.id, qtyBasePerOffer: 50, active: true },
    })
    const raw2 = smallRaw()
    raw2.sales.lines.push({ ...raw2.sales.lines[1]!, orderId: 'x2', productId: '3' }) // BL widzi ofertę jako wieloznaczną
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.channelOffersManualKept).toBe(1)
    expect(await offer('9001')).toMatchObject({ mappingSource: 'MANUAL', productId: c1.id, qtyBasePerOffer: 50, active: true })
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect(await offer('9001')).toMatchObject({ mappingSource: 'MANUAL', productId: c1.id, qtyBasePerOffer: 50, active: true })
  })

  it('oferta wyłączona w panelu (bez deactivatedByImportAt) nie jest włączana przez import', async () => {
    const raw = smallRaw()
    await persistImport(db, raw, analyze(raw))
    await db.channelOffer.updateMany({ where: { externalId: '501' }, data: { active: false } })
    const s = await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect(s.channelOffersReactivated).toBe(0)
    expect((await offer('501'))!.active).toBe(false)
  })
})

describe('uwaga 3: niepełne źródła nie wyłączają ofert', () => {
  it('raw.wfirma = null → persistImport odmawia, ImportRun FAILED, aktywne oferty bez zmian', async () => {
    const raw = smallRaw()
    await persistImport(db, raw, analyze(raw))
    const before = await db.channelOffer.count({ where: { active: true } })
    const raw2 = { ...smallRaw(), wfirma: null, issues: [{ kind: MISSING_KEYS, ref: 'wfirma', message: 'brak kluczy' }] }
    await expect(persistImport(db, raw2, analyze(raw2))).rejects.toBeInstanceOf(ImportRefused)
    expect(await db.channelOffer.count({ where: { active: true } })).toBe(before)
    expect(await db.channelOfferImport.count()).toBe(5)
    const failed = await db.importRun.findFirstOrThrow({ where: { status: 'FAILED' } })
    expect(failed.error).toContain('brak kluczy wFirmy')
  })

  it('brak kluczy Empiku: oferta Empiku bez sprzedaży nie jest wyłączana ani kasowana jako „nieaktualna”', async () => {
    const raw = smallRaw()
    raw.empik!.push({ externalId: '888', offerId: '2', shopSku: 'A1', ean: null, name: 'A bez sprzedaży', active: true, quantity: 1 })
    await persistImport(db, raw, analyze(raw))
    expect((await offer('888'))!.active).toBe(true)
    const raw2 = { ...smallRaw(), empik: null, issues: [{ kind: MISSING_KEYS, ref: 'empik', message: 'brak klucza' }] }
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.staleRemoved).toBe(0)
    expect((await offer('888'))!.active).toBe(true)
    expect(await db.channelOfferImport.count({ where: { externalId: '888' } })).toBe(1)
    // po powrocie pełnego Empiku bez oferty 888 — dopiero wtedy sprzątanie
    const s3 = await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect(s3.staleRemoved).toBe(1)
    expect((await offer('888'))!.active).toBe(false)
  })

  it('niepełna sprzedaż: oferta Allegro, która zniknęła z okna, zostaje aktywna', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const raw2 = smallRaw()
    raw2.sales = { ...raw2.sales, lines: raw2.sales.lines.filter((l) => l.auctionId !== '9001'), complete: false }
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.staleRemoved).toBe(0)
    expect((await offer('9001'))!.active).toBe(true)
  })
})

describe('nadpisania, lokalizacje, jednostka, zestaw', () => {
  it('oferta z tabeli nadpisań → aktywna ChannelOffer ze źródłem OVERRIDE', async () => {
    const raw = smallRaw()
    await persistImport(db, raw, analyze(raw, parseOfferOverrides('n\nALLEGRO;71045;9002;C1;test\n', testKnownAccounts())))
    const c1 = await db.product.findFirstOrThrow({ where: { sku: 'C1' } })
    expect(await offer('9002')).toMatchObject({ active: true, mappingSource: 'OVERRIDE', productId: c1.id })
  })

  it('miejsce na półce z BL trafia do Stock i do kopii BL; pusty kod w BL nie kasuje wpisu', async () => {
    const raw = smallRaw()
    raw.bl.products[0]!.locations = { bl_1: 'B-3-4' }
    await persistImport(db, raw, analyze(raw))
    const a1 = await db.product.findFirstOrThrow({ where: { sku: 'A1' }, include: { stocks: true } })
    expect(a1.stocks[0]!.location).toBe('B-3-4')
    expect((await db.blProduct.findFirstOrThrow({ where: { id: '1' } })).locations).toEqual({ bl_1: 'B-3-4' })
    const raw2 = smallRaw()
    raw2.bl.products[0]!.locations = { bl_1: 'C-1-1' }
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.locationsSet).toBe(1)
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect((await db.stock.findFirstOrThrow({ where: { productId: a1.id } })).location).toBe('C-1-1')
  })

  it('9: zmiana jednostki w wFirmie → ImportIssue, produkt zostaje w starej jednostce', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const raw2 = smallRaw()
    Object.assign(raw2.wfirma!.goods[0]!, { unit: 'KG', unitRaw: 'kg', countBase: 7000 })
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.status).toBe('PARTIAL')
    expect(await db.importIssue.count({ where: { kind: 'jednostka', ref: 'wf:100' } })).toBe(1)
    const a1 = await db.product.findFirstOrThrow({ where: { sku: 'A1' }, include: { stocks: true } })
    expect(a1.unit).toBe('SZT')
    expect(a1.stocks[0]!.wfirmaCount).toBe(7)
    expect((await offer('501'))!.qtyBasePerOffer).toBe(1)
  })

  it('8: zmiana SKU zestawu w BL nie tworzy drugiego produktu', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const raw2 = smallRaw()
    raw2.bl.products[3]!.sku = 'A1-zestaw-nowy'
    await persistImport(db, raw2, analyze(raw2))
    expect(await db.product.count({ where: { kind: 'BUNDLE' } })).toBe(1)
    expect((await db.product.findFirstOrThrow({ where: { kind: 'BUNDLE' } })).sku).toBe('A1-zestaw-nowy')
  })

  it('17: historia ruchów blokuje kasowanie produktu; składnik zestawu z ilością 0 odrzucony przez bazę', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const a1 = await db.product.findFirstOrThrow({ where: { sku: 'A1' } })
    await db.channelOffer.deleteMany({ where: { productId: a1.id } })
    await db.bundleComponent.deleteMany({ where: { componentId: a1.id } })
    await expect(db.product.delete({ where: { id: a1.id } })).rejects.toThrow()
    const bundle = await db.product.findFirstOrThrow({ where: { kind: 'BUNDLE' } })
    const c1 = await db.product.findFirstOrThrow({ where: { sku: 'C1' } })
    await expect(db.bundleComponent.update({ where: { bundleId_componentId: { bundleId: bundle.id, componentId: c1.id } }, data: { qtyBase: 0 } })).rejects.toThrow()
  })

  it('pozycja ręczna: tekst z BL nie trafia do bazy', async () => {
    const raw = smallRaw()
    raw.sales.lines.push({ ...raw.sales.lines[0]!, channel: 'RECZNE', accountId: '0', productId: null, auctionId: null, sku: null, name: 'Pani Nowak tel 600' })
    await persistImport(db, raw, analyze(raw))
    const rows = await db.channelOfferImport.findMany({ where: { channel: 'RECZNE' } })
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('Nowak')
  })
})

describe('uwaga 6: reapStale z wyczerpanymi próbami', () => {
  it('maxAttempts 1, RUNNING od 2 h → FAILED; zadanie z zapasem prób → PENDING z opóźnieniem', async () => {
    const dead = await enqueue(db, 'x', null, { maxAttempts: 1, dedupeKey: 'd' })
    const alive = await enqueue(db, 'y', null, { maxAttempts: 3 })
    await claimNext(db, 'martwy')
    await claimNext(db, 'martwy')
    const now = new Date()
    await db.job.updateMany({ data: { lockedAt: new Date(now.getTime() - 2 * 3600_000) } })
    expect(await reapStale(db, 3600_000, now)).toBe(2)
    expect(await db.job.findUniqueOrThrow({ where: { id: dead! } })).toMatchObject({
      status: 'FAILED',
      dedupeKey: null,
      lastError: 'porzucone przez worker (timeout), wyczerpane próby',
    })
    const a = await db.job.findUniqueOrThrow({ where: { id: alive! } })
    expect(a.status).toBe('PENDING')
    expect(a.runAfter.getTime() - now.getTime()).toBeGreaterThanOrEqual(29_000)
    expect(await claimNext(db, 'zywy')).toBeNull() // jeszcze przed runAfter
  })
})
