// drobne poprawki importu katalogu po (drobne 1, 2, 4–6; r3 drobne 7, 8).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { isNonRetryable } from '@/lib/bledy'
import { analyze, MISSING_KEYS } from '@/lib/import/katalog'
import { parseOfferOverrides } from '@/lib/import/nadpisania'
import { renderReport } from '@/lib/import/raport'
import { ImportRefused, persistImport } from '@/lib/import/zapis'
import { setOfferActiveManually } from '@/lib/oferty'
import { channelMapOf, loadImportConfig } from '@/lib/organizacje'
import { claimNext, enqueue, fail } from '@/lib/worker/kolejka'
import { sale, smallRaw, TEST_CHANNEL_MAP, testKnownAccounts } from './fixtures'
import { seedImportConfig, testDb, truncateAll } from './db'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedImportConfig()
})
afterAll(() => db.$disconnect())

const offer = (externalId: string) => db.channelOffer.findFirstOrThrow({ where: { externalId } })

describe('drobna 1: pusta lista kanału liczona ze źródła listy ofert, nie z ofert ze sprzedaży', () => {
  it('Woo: shopOffers = [] przy zachowanej sprzedaży WOO_SD → kanał niepełny, staleRemoved = 0, ImportIssue, PARTIAL', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const raw2 = smallRaw()
    raw2.shopOffers = [] // sprzedaż WOO 7100001 (oferta 77) zostaje w a.offers
    const a2 = analyze(raw2)
    expect(a2.offers.some((o) => o.channel === 'WOO' && o.accountId === '7100001')).toBe(true)
    const s2 = await persistImport(db, raw2, a2)
    expect(s2.staleRemoved).toBe(0)
    expect(s2.channelOffersDeactivated).toBe(0)
    expect(s2.status).toBe('PARTIAL')
    expect(await db.importIssue.count({ where: { runId: s2.runId, kind: 'oferta-nieaktualna', ref: 'WOO|7100001' } })).toBe(1)
    expect((await offer('501')).active).toBe(true)
  })

  it('Empik: pusta lista OF21 przy istniejących wierszach → nic nie skasowane, jedno ImportIssue', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const raw2 = smallRaw()
    raw2.empik = []
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.staleRemoved).toBe(0)
    expect(s2.status).toBe('PARTIAL')
    expect(await db.importIssue.count({ where: { runId: s2.runId, ref: 'EMPIK|30193' } })).toBe(1)
    expect((await offer('777')).active).toBe(true)
  })

  it('kanał bez wierszy z poprzednich przebiegów: pusta lista nie jest problemem (OK)', async () => {
    const s = await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect(s.status).toBe('OK') // sklepy 7100002 i 7100003 bez ofert od początku
  })

  it('Woo: błąd pobrania listy sklepu (bl-sklep) → tylko ImportIssue pobierania, bez drugiego „lista ucięta”', async () => {
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const raw2 = smallRaw()
    raw2.shopOffers = []
    raw2.issues = [{ kind: 'bl-sklep', ref: 'shop_7100001', message: 'BL: HTTP 503' }]
    const s2 = await persistImport(db, raw2, analyze(raw2))
    expect(s2.status).toBe('PARTIAL')
    expect(s2.staleRemoved).toBe(0)
    expect(await db.importIssue.count({ where: { runId: s2.runId, kind: 'oferta-nieaktualna' } })).toBe(0)
    expect(await db.importIssue.count({ where: { runId: s2.runId, kind: 'pobieranie:bl-sklep', ref: 'shop_7100001' } })).toBe(1)
    expect((await offer('501')).active).toBe(true)
  })
})

describe('drobna 2 +: ImportRefused przy braku kluczy i limicie wFirmy; 5xx i sieć się ponawiają', () => {
  it('raw.wfirma = null z błędu pobierania → zwykły Error, ImportRun FAILED, zadanie się ponawia', async () => {
    const id = await enqueue(db, 'import-katalogu', null, { maxAttempts: 5 })
    const job = (await claimNext(db, 'w'))!
    const raw = { ...smallRaw(), wfirma: null, issues: [{ kind: 'wfirma', ref: 'goods/find', message: 'wFirma goods/find: HTTP 503' }] }
    const err = await persistImport(db, raw, analyze(raw)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ImportRefused)
    expect(isNonRetryable(err)).toBe(false)
    expect((err as Error).message).toContain('towary wFirmy nie zostały pobrane')
    expect(await fail(db, job, err)).toBe('RETRY')
    expect((await db.job.findUniqueOrThrow({ where: { id: id! } })).status).toBe('PENDING')
    const failed = await db.importRun.findFirstOrThrow({ where: { status: 'FAILED' } })
    expect(failed.error).toContain('towary wFirmy nie zostały pobrane (błąd serwera albo sieci)')
    expect(failed.error).toContain('HTTP 503') // treść odpowiedzi wFirmy w bazie
  })

  it('raw.wfirma = null z braku kluczy → ImportRefused, zadanie FAILED po 1. próbie', async () => {
    const id = await enqueue(db, 'import-katalogu', null, { maxAttempts: 5 })
    const job = (await claimNext(db, 'w'))!
    const raw = { ...smallRaw(), wfirma: null, issues: [{ kind: MISSING_KEYS, ref: 'wfirma', message: 'brak kluczy' }] }
    const err = await persistImport(db, raw, analyze(raw)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportRefused)
    expect(await fail(db, job, err)).toBe('FAILED')
    expect((await db.job.findUniqueOrThrow({ where: { id: id! } })).status).toBe('FAILED')
    expect(await db.importRun.count({ where: { status: 'FAILED' } })).toBe(1)
  })

  it('raw.wfirma = null z limitu wFirmy (retryable = false) → ImportRefused, zadanie FAILED bez ponawiania, treść limitu w bazie', async () => {
    const id = await enqueue(db, 'import-katalogu', null, { maxAttempts: 5 })
    const job = (await claimNext(db, 'w'))!
    const issues = [{ kind: 'wfirma', ref: 'goods/find', message: 'wFirma vat_codes/find: AUTH FAILED LIMIT WAIT 5 MINUTES', retryable: false }]
    const raw = { ...smallRaw(), wfirma: null, issues }
    const err = await persistImport(db, raw, analyze(raw)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportRefused)
    expect(isNonRetryable(err)).toBe(true)
    expect(await fail(db, job, err)).toBe('FAILED')
    expect((await db.job.findUniqueOrThrow({ where: { id: id! } })).status).toBe('FAILED')
    const run = await db.importRun.findFirstOrThrow({ where: { status: 'FAILED' } })
    expect(run.error).toContain('limit albo odmowa API (bez ponawiania)')
    expect(run.error).toContain('AUTH FAILED LIMIT WAIT 5 MINUTES')
  })
})

describe('drobne 4 i 5: nadpisania', () => {
  it('konflikt z BL: komunikat ze źródłem powiązania BL', () => {
    const a = analyze(smallRaw(), parseOfferOverrides('n\nALLEGRO;71045;9001;C1;stary wiersz\n', testKnownAccounts()))
    expect(a.overrideProblems[0]).toContain('BL (BL_ORDERS) wskazuje produkt 2, nadpisanie 3')
  })

  it('nadpisanie zgodne z BL: zostaje BL_ORDERS, notatka „nadpisanie zgodne”, brak problemów, wpis w sekcji „Nadpisania” raportu', async () => {
    const raw = smallRaw()
    const a = analyze(raw, parseOfferOverrides('n\nALLEGRO;71045;9001;B1;powiązane w BL\n', testKnownAccounts()))
    expect(a.overrideProblems).toEqual([])
    const o = a.offers.find((x) => x.externalId === '9001')!
    expect(o).toMatchObject({ source: 'BL_ORDERS', state: 'MAPPED', blProductIds: ['2'] })
    expect(o.notes.some((n) => n.includes('nadpisanie zgodne z BL'))).toBe(true)
    const md = renderReport(raw, a, { generatedAt: new Date('2026-10-22T12:00:00Z') }).markdown
    const section = md.slice(md.indexOf('## Nadpisania powiązań'), md.indexOf('## Duplikaty'))
    expect(section).toContain('`9001`')
    expect(section).toContain('nadpisanie zgodne z BL')
    const s = await persistImport(db, raw, a)
    expect(s.status).toBe('OK')
    expect(await offer('9001')).toMatchObject({ mappingSource: 'BL_ORDERS', active: true })
    expect(await db.importIssue.count({ where: { kind: 'nadpisanie-oferty' } })).toBe(0)
  })

  it('oferta wieloznaczna w BL + nadpisanie → OVERRIDE na produkt z CSV, 1 wpis w overrideProblems', async () => {
    const raw = smallRaw()
    raw.sales.lines.push(sale({ channel: 'ALLEGRO', productId: '3', auctionId: '9001' })) // 9001 → produkty 2 i 3
    expect(analyze(raw).offers.find((x) => x.externalId === '9001')!.state).toBe('AMBIGUOUS')
    const a = analyze(raw, parseOfferOverrides('n\nALLEGRO;71045;9001;C1;rozstrzygnięcie\n', testKnownAccounts()))
    expect(a.overrideProblems).toHaveLength(1)
    expect(a.overrideProblems[0]).toContain('oferta wieloznaczna w BL')
    expect(a.offers.find((x) => x.externalId === '9001')).toMatchObject({ state: 'MAPPED', source: 'OVERRIDE', blProductIds: ['3'] })
    await persistImport(db, raw, a)
    const c1 = await db.product.findFirstOrThrow({ where: { sku: 'C1' } })
    expect(await offer('9001')).toMatchObject({ mappingSource: 'OVERRIDE', productId: c1.id, active: true })
    expect(await db.importIssue.count({ where: { kind: 'nadpisanie-oferty' } })).toBe(1)
  })
})

describe('drobna 6: migawka AuditLog z deactivatedByImportAt i qtyBasePerOffer', () => {
  it('ręczne włączenie oferty wyłączonej przez import zapisuje oba pola przed i po', async () => {
    const raw = smallRaw()
    raw.sales.lines.push(sale({ channel: 'ALLEGRO', productId: '3', auctionId: '9001' })) // 9001 wieloznaczna
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    await persistImport(db, raw, analyze(raw))
    const o = await offer('9001')
    expect(o.deactivatedByImportAt).not.toBeNull()
    await setOfferActiveManually(db, o.id, true, { actorId: 'test:operator', qtyBasePerOffer: 500 })
    const log = await db.auditLog.findFirstOrThrow({ where: { entity: 'ChannelOffer', entityId: o.id } })
    expect(log.before).toMatchObject({ active: false, qtyBasePerOffer: 1000, deactivatedByImportAt: o.deactivatedByImportAt!.toISOString() })
    expect(log.after).toMatchObject({ active: true, mappingSource: 'MANUAL', qtyBasePerOffer: 500, deactivatedByImportAt: null })
  })
})

describe('r3 drobna 8: spójność kont kanałów w imporcie z konfiguracją firmy', () => {
  // Pilnuje, że fixture TEST_CHANNEL_MAP nie rozjeżdża się z konfiguracją z seeda (seed/acme.ts); asercje „konto w
  // names” są pomocnicze — loadImportConfig buduje shops i channelNames z tych samych wierszy.
  it('fixture TEST_CHANNEL_MAP = konfiguracja firmy z seeda; każdy sklep Woo i Empik ma konto w names', async () => {
    const map = channelMapOf(await loadImportConfig(db))
    expect([...map.shopAccounts].sort()).toEqual([...TEST_CHANNEL_MAP.shopAccounts].sort())
    expect(map.names).toEqual(TEST_CHANNEL_MAP.names)
    expect(map.empikAccountId).toBe(TEST_CHANNEL_MAP.empikAccountId)
    for (const acc of map.shopAccounts) expect(map.names).toHaveProperty([`WOO|${acc}`])
    expect(map.names).toHaveProperty([`EMPIK|${map.empikAccountId}`])
  })
})
