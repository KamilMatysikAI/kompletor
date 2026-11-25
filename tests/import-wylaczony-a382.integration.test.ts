// (przegląd r2, część B, ważna 1): import katalogu przy pewnym powiązaniu nie zakłada aktywnej oferty,
// nie wznawia oferty wyłączonej przez import i nie przepina oferty na produkt wyłączony w Kompletorze. Oferta zostaje
// nieaktywna z pozycją w raporcie importu; po włączeniu produktu następny import ją podpina. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { analyze } from '@/lib/import/katalog'
import { persistImport } from '@/lib/import/zapis'
import { setOfferActiveManually } from '@/lib/oferty'
import { przypiszOferte } from '@/lib/kanaly/oferty'
import { propozycjeKonta } from '@/lib/produkty/powiazania'
import { smallRaw } from './fixtures'
import { seedImportConfig, testDb, truncateAll } from './db'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedImportConfig()
})
afterAll(() => db.$disconnect())

const offer = (externalId: string) => db.channelOffer.findFirstOrThrow({ where: { externalId } })
const produkt = (sku: string) => db.product.findFirstOrThrow({ where: { sku } })
const wylacz = async (sku: string, active = false) => db.product.update({ where: { id: (await produkt(sku)).id }, data: { active } })
const importuj = async (raw = smallRaw()) => persistImport(db, raw, analyze(raw))
/** 9001 (Allegro) wskazuje w BL produkt 3 (C1) zamiast 2 (B1). */
const naC1 = () => {
  const r = smallRaw()
  r.sales.lines = r.sales.lines.map((l) => (l.auctionId === '9001' ? { ...l, productId: '3' } : l))
  return r
}

describe('import katalogu a produkt wyłączony', () => {
  it('nowa oferta pewnego powiązania na wyłączony produkt: nieaktywna, pozycja w raporcie; po włączeniu import ją podpina', async () => {
    await importuj()
    expect(await offer('9001')).toMatchObject({ active: true, productId: (await produkt('B1')).id })
    await db.channelOffer.delete({ where: { id: (await offer('9001')).id } }) // „nowa” oferta przy następnym imporcie
    await wylacz('B1')
    const s = await importuj()
    expect(await offer('9001')).toMatchObject({ active: false, productId: (await produkt('B1')).id })
    expect((await offer('9001')).deactivatedByImportAt).not.toBeNull()
    expect(s.status).toBe('PARTIAL')
    const iss = await db.importIssue.findFirstOrThrow({ where: { runId: s.runId, kind: 'oferta-produkt-wylaczony' } })
    expect(iss.message).toContain('B1')
    expect((await produkt('B1')).active).toBe(false) // import flagi nie zmienia
    // kolejny import przy wyłączonym: dalej nieaktywna, bez nowej pozycji i bez PARTIAL
    const sBez = await importuj()
    expect((await offer('9001')).active).toBe(false)
    expect(sBez.status).toBe('OK')
    expect(sBez.channelOffersOnDisabledProduct).toBeGreaterThan(0)
    expect(await db.importIssue.count({ where: { runId: sBez.runId } })).toBe(0)
    await wylacz('B1', true)
    const s2 = await importuj()
    expect((await offer('9001')).active).toBe(true)
    expect(s2.channelOffersReactivated).toBeGreaterThanOrEqual(1)
  })

  it('oferta wyłączona przez import nie wznawia się na wyłączonym produkcie', async () => {
    await importuj()
    await db.channelOffer.update({ where: { id: (await offer('9001')).id }, data: { active: false, deactivatedByImportAt: new Date() } })
    await wylacz('B1')
    const s = await importuj()
    expect((await offer('9001')).active).toBe(false)
    expect(s.channelOffersReactivated).toBe(0)
    // oferta już nieaktywna: stan się nie zmienia, więc tylko licznik
    expect(await db.importIssue.count({ where: { runId: s.runId, kind: 'oferta-produkt-wylaczony' } })).toBe(0)
    expect(s.channelOffersOnDisabledProduct).toBe(1)
  })

  it('powiązanie przeszło na wyłączony produkt: bez przepięcia, stara oferta gaśnie; po włączeniu import przepina i włącza', async () => {
    await importuj()
    const b1 = (await produkt('B1')).id
    const c1 = (await produkt('C1')).id
    await wylacz('C1')
    const s = await importuj(naC1())
    expect(await offer('9001')).toMatchObject({ active: false, productId: b1 })
    expect((await offer('9001')).deactivatedByImportAt).not.toBeNull() // od tego zależy wznowienie po włączeniu C1
    expect(await db.importIssue.count({ where: { runId: s.runId, kind: 'oferta-produkt-wylaczony' } })).toBe(1)
    expect(s.status).toBe('PARTIAL')
    await wylacz('C1', true)
    await importuj(naC1())
    expect(await offer('9001')).toMatchObject({ active: true, productId: c1, qtyBasePerOffer: 1 })
  })

  it('ręczne włączenie oferty na wyłączony produkt = odmowa', async () => {
    await importuj()
    const o = await offer('9001')
    await db.channelOffer.update({ where: { id: o.id }, data: { active: false } })
    await wylacz('B1')
    await expect(setOfferActiveManually(db, o.id, true, { actorId: 'test' })).rejects.toThrow('wyłączony')
    expect((await offer('9001')).active).toBe(false)
    await setOfferActiveManually(db, o.id, false, { actorId: 'test' }) // wyłączenie wolno zawsze
  })

  it('propozycja na wyłączony produkt: znika z listy do zatwierdzenia, ręczne powiązanie odmawia jasnym komunikatem', async () => {
    await importuj()
    const o = await offer('9001')
    const ref = { channel: o.channel, channelAccountId: o.channelAccountId }
    await db.channelOffer.update({ where: { id: o.id }, data: { active: false, needsApproval: true, deactivatedByImportAt: new Date() } })
    expect((await propozycjeKonta(db, ref)).map((x) => x.offerId)).toEqual([o.id])
    await wylacz('B1')
    expect(await propozycjeKonta(db, ref)).toEqual([])
    await expect(przypiszOferte(db, ref, { externalId: '9001', productId: o.productId, qtyBasePerOffer: 1 }, { actorId: 'test' })).rejects.toThrow('Produkt jest wyłączony')
    expect((await offer('9001')).active).toBe(false)
    await wylacz('B1', true)
    expect((await propozycjeKonta(db, ref)).map((x) => x.offerId)).toEqual([o.id])
  })
})
