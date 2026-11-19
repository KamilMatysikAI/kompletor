// poprawki po przeglądzie z 25.10 (ważne 1–5).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { NonRetryableError } from '@/lib/bledy'
import { analyze } from '@/lib/import/katalog'
import { parseOfferOverrides } from '@/lib/import/nadpisania'
import { persistImport } from '@/lib/import/zapis'
import { setOfferActiveManually } from '@/lib/oferty'
import { claimNext, enqueue, fail } from '@/lib/worker/kolejka'
import { handlers } from '@/lib/worker/zadania'
import { sale, shop, smallRaw, testKnownAccounts } from './fixtures'
import { ORG_A, seedImportConfig, testDb, truncateAll } from './db'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedImportConfig() // magazyn i kanały z konfiguracji firmy, nie z importu
})
afterAll(() => db.$disconnect())

const offer = (externalId: string) => db.channelOffer.findFirstOrThrow({ where: { externalId } })

describe('ważna 1: kanały znane tylko z okna sprzedaży nie są sprzątane', () => {
  it('oferta Allegro, która wypadła z okna 90 dni (sprzedaż pełna), zostaje aktywna i z wierszem importu', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const raw2 = smallRaw()
    raw2.sales = { ...raw2.sales, lines: raw2.sales.lines.filter((l) => l.auctionId !== '9001'), complete: true }
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.staleRemoved).toBe(0)
    expect((await offer('9001')).active).toBe(true)
    expect(await db.channelOfferImport.count({ where: { externalId: '9001' } })).toBe(1)
  })

  it('Woo (pełna lista ofert) nadal sprząta ofertę, która zniknęła z listy sklepu', async () => {
    // (przegląd r3, drobna 10): oferta z linkiem BL ma ChannelOffer — sprzątanie ją wyłącza.
    const withLink = () => {
      const r = smallRaw()
      r.bl.products[2]!.links = { shop_7100001: { productId: '503', variantId: '0' } }
      return r
    }
    const raw = withLink()
    raw.shopOffers.push(shop({ productId: '503', sku: 'nic' }))
    await persistImport(db, raw, analyze(raw))
    expect(await offer('503')).toMatchObject({ active: true, mappingSource: 'BL_LINK' })
    const s2 = await persistImport(db, withLink(), analyze(withLink()))
    expect(s2.staleRemoved).toBe(1)
    expect(s2.channelOffersDeactivated).toBe(1) // ścieżka updateMany w bloku stale
    const o = await offer('503')
    expect(o.active).toBe(false)
    expect(o.deactivatedByImportAt).not.toBeNull()
  })
})

describe('ważna 2: bezpiecznik masowej deaktywacji', () => {
  const tenAllegro = () => Array.from({ length: 10 }, (_, i) => sale({ channel: 'ALLEGRO', productId: '2', auctionId: `91${i}` }))

  it('> 20 % aktywnych ofert kanału do wyłączenia w jednym przebiegu → odmowa, ImportIssue, PARTIAL, oferty aktywne', async () => {
    const raw = smallRaw()
    raw.sales.lines.push(...tenAllegro())
    await persistImport(db, raw, analyze(raw))
    expect(await db.channelOffer.count({ where: { channel: 'ALLEGRO', active: true } })).toBe(11)
    const raw2 = smallRaw()
    raw2.sales.lines.push(...tenAllegro().map((l) => ({ ...l, productId: null }))) // BL nagle „nie zna” powiązań
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.status).toBe('PARTIAL')
    expect(s2.channelOffersDeactivated).toBe(0)
    expect(s2.channelOffersMassOffRefused).toBe(10)
    expect(await db.channelOffer.count({ where: { channel: 'ALLEGRO', active: true } })).toBe(11)
    const iss = await db.importIssue.findFirstOrThrow({ where: { runId: s2.runId, kind: 'oferta-nieaktualna' } })
    expect(iss.message).toContain('odmowa masowej deaktywacji: 10 z 11')
  })

  it('(drobna 3): zgoda w konfiguracji konta (allowMassOffUntil) przepuszcza masowe wyłączenie; po terminie bezpiecznik wraca', async () => {
    const raw = smallRaw()
    raw.sales.lines.push(...tenAllegro())
    await persistImport(db, raw, analyze(raw))
    const key = { organizationId_channel_channelAccountId: { organizationId: ORG_A, channel: 'ALLEGRO' as const, channelAccountId: '71045' } }
    const raw2 = smallRaw()
    raw2.sales.lines.push(...tenAllegro().map((l) => ({ ...l, productId: null })))
    await db.channelConfig.update({ where: key, data: { allowMassOffUntil: new Date(Date.now() - 60_000) } }) // zgoda wygasła
    expect((await persistImport(db, raw2, analyze(raw2))).channelOffersMassOffRefused).toBe(10)
    await db.channelConfig.update({ where: key, data: { allowMassOffUntil: new Date(Date.now() + 3600_000) } })
    const s3 = await persistImport(db, raw2, analyze(raw2))
    expect(s3).toMatchObject({ channelOffersMassOffRefused: 0, channelOffersMassOffAllowed: 10, channelOffersDeactivated: 10 })
    expect(await db.channelOffer.count({ where: { channel: 'ALLEGRO', active: true } })).toBe(1)
  })

  it('pojedyncze wyłączenie mieści się w progu i przechodzi', async () => {
    const raw = smallRaw()
    raw.sales.lines.push(...tenAllegro())
    await persistImport(db, raw, analyze(raw))
    const raw2 = smallRaw()
    raw2.sales.lines.push(...tenAllegro().map((l, i) => (i === 0 ? { ...l, productId: null } : l)))
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.channelOffersDeactivated).toBe(1)
    expect(s2.channelOffersMassOffRefused).toBe(0)
  })

  it('pusta lista kanału przy istniejących wierszach = kanał niepełny: nic nie wyłączone ani skasowane', async () => {
    const raw = smallRaw()
    raw.shopOffers.push(shop({ productId: '503', sku: 'nic' }))
    await persistImport(db, raw, analyze(raw))
    const raw2 = smallRaw()
    raw2.shopOffers = []
    raw2.sales.lines = raw2.sales.lines.filter((l) => l.channel !== 'WOO')
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.staleRemoved).toBe(0)
    expect((await offer('501')).active).toBe(true)
    expect(await db.channelOfferImport.count({ where: { channel: 'WOO', channelAccountId: '7100001' } })).toBe(3)
    // Raz na kanał ImportIssue, przebieg PARTIAL
    expect(s2.status).toBe('PARTIAL')
    expect(await db.importIssue.count({ where: { runId: s2.runId } })).toBe(1)
    expect((await db.importIssue.findFirstOrThrow({ where: { runId: s2.runId } })).message).toContain('pusta lista ofert kanału przy 3 wierszach')
  })
})

describe('ważna 3: nadpisanie nie wygrywa z bieżącym powiązaniem BL', () => {
  it('9001 w BL → produkt 2, CSV → C1: overrideProblems, oferta zostaje BL_ORDERS na B1', async () => {
    const raw = smallRaw()
    const a = analyze(raw, parseOfferOverrides('n\nALLEGRO;71045;9001;C1;stary wiersz\n', testKnownAccounts()))
    expect(a.overrideProblems).toHaveLength(1)
    expect(a.overrideProblems[0]).toContain('wygrywa BL')
    await persistImport(db, raw, a)
    const b1 = await db.product.findFirstOrThrow({ where: { sku: 'B1' } })
    expect(await offer('9001')).toMatchObject({ mappingSource: 'BL_ORDERS', productId: b1.id, active: true })
    expect(await db.importIssue.count({ where: { kind: 'nadpisanie-oferty' } })).toBe(1)
  })
})

describe('ważna 4: worker bez kluczy nie czyta API i nie ponawia', () => {
  it('handler import-katalogu bez wFirmy/Empiku rzuca NonRetryableError przed odczytem; fail → FAILED po 1. próbie', async () => {
    await expect(handlers['import-katalogu']!(db, {}, { organizationId: ORG_A, secrets: { env: { BASELINKER_TOKEN: 'atrapa' }, envFallback: true } })).rejects.toBeInstanceOf(NonRetryableError)
    const id = await enqueue(db, 'import-katalogu', null, { maxAttempts: 5 })
    const job = (await claimNext(db, 'w'))!
    expect(await fail(db, job, new NonRetryableError('brak zmiennych'))).toBe('FAILED')
    expect((await db.job.findUniqueOrThrow({ where: { id: id! } })).status).toBe('FAILED')
  })
})

describe('ważna 5: kontrakt panelu — setOfferActiveManually', () => {
  it('panel włączył bez zerowania pola, potem wyłączył przez setOfferActiveManually → import nie włącza', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const raw2 = smallRaw()
    raw2.sales.lines.push({ ...raw2.sales.lines[1]!, orderId: 'x2', productId: '3' }) // 9001 wieloznaczna → import wyłącza
    await persistImport(db, raw2, analyze(raw2))
    const o = await offer('9001')
    expect(o.deactivatedByImportAt).not.toBeNull()
    await db.channelOffer.update({ where: { id: o.id }, data: { active: true } }) // „zły” panel: bez zerowania
    await setOfferActiveManually(db, o.id, false, { actorId: 'test:anna' })
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect(await offer('9001')).toMatchObject({ active: false, deactivatedByImportAt: null })
    expect(await db.auditLog.count({ where: { entity: 'ChannelOffer', entityId: o.id } })).toBe(1)
  })

  it('zatwierdzenie propozycji = MANUAL aktywna, import jej nie rusza; odrzucenie = trwale wyłączona', async () => {
    const raw = smallRaw()
    raw.shopOffers.push(shop({ productId: '600', sku: 'C1' }), shop({ productId: '601', sku: 'B1' }))
    await persistImport(db, raw, analyze(raw))
    const ok = await offer('600')
    const no = await offer('601')
    expect(ok).toMatchObject({ active: false, needsApproval: true })
    await setOfferActiveManually(db, ok.id, true, { actorId: 'test:anna' })
    await setOfferActiveManually(db, no.id, false, { actorId: 'test:anna' })
    await persistImport(db, raw, analyze(raw))
    await persistImport(db, raw, analyze(raw))
    expect(await offer('600')).toMatchObject({ active: true, mappingSource: 'MANUAL', needsApproval: false })
    expect(await offer('601')).toMatchObject({ active: false, needsApproval: false, deactivatedByImportAt: null })
  })
})

describe('drobne', () => {
  it('10: wyczyszczone miejsca w BL czyszczą kopię BlProduct, Stock.location zostaje', async () => {
    const raw = smallRaw()
    raw.bl.products[0]!.locations = { bl_1: 'B-3-4' }
    await persistImport(db, raw, analyze(raw))
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect((await db.blProduct.findFirstOrThrow({ where: { id: '1' } })).locations).toBeNull()
    const a1 = await db.product.findFirstOrThrow({ where: { sku: 'A1' }, include: { stocks: true } })
    expect(a1.stocks[0]!.location).toBe('B-3-4')
  })
})
