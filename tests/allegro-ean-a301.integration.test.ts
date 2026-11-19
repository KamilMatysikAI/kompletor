// „Pobierz oferty” na koncie Allegro dociąga EAN ze szczegółów oferty (atrapa Allegro, tylko GET), podgląd
// „po EAN” łączy ofertę bez sygnatury, lista „Bez pasującego produktu” ma powód przy każdej ofercie, oferta czekająca
// w propozycjach nie powtarza się w „Połączy”, a SKU różniące się tylko zerami na początku idzie do decyzji.
// Bez sieci i bez prawdziwego Allegro; dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ALLEGRO_DEFINITION, ALLEGRO_SECRETS as S } from '@/lib/adaptery/allegro'
import type { ChannelAdapter, ChannelOfferRow } from '@/lib/adaptery/kontrakt'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { EAN_LIMIT_NA_PRZEBIEG, pobierzOferty } from '@/lib/kanaly/oferty'
import { planLaczenia, polaczMasowo, propozycjeKonta } from '@/lib/produkty/powiazania'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegro, productOffer, UA } from './allegro-atrapa'
import { testDb, truncateAll } from './db'
import { ACC, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

const ALLEGRO = ACC.ALLEGRO
const SD = ACC.WOO_SD
const EAN_A = '5901234123457'
const EAN_B = '4006381333931'
const registry = new AdapterRegistry([ALLEGRO_DEFINITION])

function adapter(fake: FakeAllegro): ChannelAdapter {
  const pair = fake.issuePair('allegro:api:orders:read allegro:api:sale:offers:read')
  return registry.create('allegro.v1', {
    integration: { organizationId: 'test_a', kind: 'channel', id: 'ALLEGRO/allegro', name: 'Allegro', channel: 'ALLEGRO', channelAccountId: 'allegro' },
    rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA },
    rawSecrets: { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: new Date(T0.getTime() + 10 * 3600_000).toISOString() },
    fetch: fake.fetch,
    now: () => T0,
    http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 },
  })
}

function oferta(fake: FakeAllegro, id: string, sku: string | null) {
  fake.offers.set(id, { id, name: `Oferta testowa ${id}`, external: sku ? { id: sku } : null, stock: { available: 2, unit: 'UNIT' }, publication: { status: 'ACTIVE' } })
}

const szczegoly = (fake: FakeAllegro) => fake.requests.filter((r) => r.startsWith('GET /sale/product-offers/')).map((r) => r.slice('GET /sale/product-offers/'.length))
const odczyt = (externalId: string) => db.channelOfferRead.findFirstOrThrow({ where: { ...ALLEGRO, externalId } })
const opts = { hasBl: true, hasWfirma: true, actorId: 'test', now: T0 }

describe('EAN ofert Allegro przy „Pobierz oferty”', () => {
  it('dociąga EAN ofert bez powiązania, błąd jednej oferty w błędach pobrania; powtórka nie odpytuje ofert z EAN ani powiązanych', async () => {
    const fake = new FakeAllegro()
    const powiazany = await product(db, 'SKU-AKT', 3)
    await db.channelOffer.create({ data: { ...ALLEGRO, externalId: '7703', productId: powiazany, mappingSource: 'MANUAL' } })
    oferta(fake, '7701', null) // bez sygnatury, EAN w produkcie oferty
    fake.productOffers.set('7701', productOffer('7701', [EAN_A]))
    oferta(fake, '7702', null) // bez sygnatury i bez EAN
    fake.productOffers.set('7702', productOffer('7702', [null]))
    oferta(fake, '7703', 'SKU-AKT') // aktywnie powiązana: nie odpytujemy
    fake.productOffers.set('7703', productOffer('7703', [EAN_B]))
    oferta(fake, '7704', null) // awaria szczegółów tej jednej oferty
    fake.productOffers.set('7704', 500)
    oferta(fake, '7705', '1505') // sygnatura bez produktu; szczegółów brak (404)

    const w = await pobierzOferty(db, ALLEGRO, adapter(fake), opts)
    expect(szczegoly(fake).sort()).toEqual(['7701', '7702', '7704', '7705'])
    expect(w.ean).toEqual({ zZapisu: 0, sprawdzone: 3, znalezione: 1, bezEan: 2, pozostale: 0, bledy: 1 })
    expect(w.read).toBe(5)
    expect(await odczyt('7701')).toMatchObject({ ean: EAN_A, state: 'BEZ_SKU', note: expect.stringContaining('Podgląd: po EAN') })
    expect(await odczyt('7702')).toMatchObject({ ean: null, state: 'BEZ_SKU', note: expect.stringContaining('bez SKU i bez EAN') })
    expect((await odczyt('7702')).note).toContain('nie ma EAN')
    expect(await odczyt('7703')).toMatchObject({ ean: null })
    const bledy = await db.importIssue.findMany({ where: { runId: w.runId } })
    expect(bledy.map((b) => [b.kind, b.ref])).toEqual([['oferta-ean', '7704']])
    expect(fake.nonGet()).toEqual([])

    // powtórka: 7701 ma zapisany EAN (bez wywołania), 7703 powiązana; reszta jeszcze raz
    fake.requests.length = 0
    fake.productOffers.set('7704', productOffer('7704', [null]))
    const w2 = await pobierzOferty(db, ALLEGRO, adapter(fake), opts)
    expect(szczegoly(fake).sort()).toEqual(['7702', '7704', '7705'])
    expect(w2.ean).toMatchObject({ zZapisu: 1, sprawdzone: 3, bledy: 0 })
    expect(await odczyt('7701')).toMatchObject({ ean: EAN_A })
  })

  it(`najwyżej ${EAN_LIMIT_NA_PRZEBIEG} szczegółów na przebieg; limit zapytań Allegro (429) zatrzymuje odpytywanie, reszta przy następnym`, async () => {
    const fake = new FakeAllegro()
    for (let i = 0; i < EAN_LIMIT_NA_PRZEBIEG + 3; i++) oferta(fake, String(800000 + i), null)
    const w = await pobierzOferty(db, ALLEGRO, adapter(fake), opts)
    expect(szczegoly(fake)).toHaveLength(EAN_LIMIT_NA_PRZEBIEG)
    expect(w.ean).toMatchObject({ sprawdzone: EAN_LIMIT_NA_PRZEBIEG, pozostale: 3 })

    const f2 = new FakeAllegro()
    for (const id of ['9001', '9002', '9003', '9004']) oferta(f2, id, null)
    f2.productOffers.set('9001', productOffer('9001', [EAN_A]))
    f2.productOffers.set('9002', 429)
    await truncateAll(db)
    await seedBase(db)
    const w2 = await pobierzOferty(db, ALLEGRO, adapter(f2), opts)
    expect(szczegoly(f2)).toEqual(['9001', '9002'])
    expect(w2.ean).toMatchObject({ sprawdzone: 1, znalezione: 1, pozostale: 3 })
    const bledy = await db.importIssue.findMany({ where: { runId: w2.runId } })
    expect(bledy).toHaveLength(1)
    expect(bledy[0]!.message).toContain('odczyt przerwany')
    expect(bledy[0]!.message).toContain('następne „Pobierz oferty”')
  })

  it('kanał bez odczytu EAN ze szczegółów (np. Empik, Woo): bez zmian, żadnych dodatkowych wywołań', async () => {
    const wiersze: ChannelOfferRow[] = [{ externalId: '501', sku: null, ean: null, name: 'Oferta testowa 501', qty: 1, active: true }]
    const stub = { manifest: { capabilities: ['offers.read'] }, listOffers: async () => ({ items: wiersze, nextCursor: null }) } as unknown as ChannelAdapter
    const w = await pobierzOferty(db, SD, stub, opts)
    expect(w.ean).toBeUndefined()
    expect(await db.channelOfferRead.findFirstOrThrow({ where: { ...SD, externalId: '501' } })).toMatchObject({ state: 'BEZ_SKU', ean: null })
  })
})

describe('podgląd łączenia po EAN i SKU', () => {
  it('po EAN łączy ofertę bez sygnatury; bez pary z powodem; SKU z zerami na początku do decyzji z produktem', async () => {
    const fake = new FakeAllegro()
    const herb = await product(db, 'HERB-EAN', 4)
    await db.product.update({ where: { id: herb }, data: { ean: EAN_A } })
    const zera = await product(db, '01505', 4)
    oferta(fake, '7701', null)
    fake.productOffers.set('7701', productOffer('7701', [EAN_A]))
    oferta(fake, '7702', null)
    fake.productOffers.set('7702', productOffer('7702', [null]))
    oferta(fake, '7705', '1505')
    oferta(fake, '7706', null)
    fake.productOffers.set('7706', productOffer('7706', [EAN_B]))
    oferta(fake, '7707', 'BRAK-PRODUKTU')
    await pobierzOferty(db, ALLEGRO, adapter(fake), opts)

    const ean = await planLaczenia(db, ALLEGRO, 'EAN')
    expect(ean.polaczy.map((x) => [x.externalId, x.produkt?.id])).toEqual([['7701', herb]])
    const powodEan = new Map(ean.bezPary.map((x) => [x.externalId, x.powod]))
    expect(ean.bezTrafienia).toBe(4)
    expect(powodEan.get('7702')).toContain('bez SKU (sygnatury) i bez EAN')
    expect(powodEan.get('7705')).toContain('oferta bez EAN; ma SKU „1505”')
    expect(powodEan.get('7706')).toContain(`jest EAN ${EAN_B}, nie ma aktywnego produktu`)

    const sku = await planLaczenia(db, ALLEGRO, 'SKU')
    expect(sku.polaczy).toEqual([])
    expect(sku.decyzja.map((x) => [x.externalId, x.produkt?.id])).toEqual([['7705', zera]])
    expect(sku.decyzja[0]!.powod).toContain('tylko zerami na początku')
    const powodSku = new Map(sku.bezPary.map((x) => [x.externalId, x.powod]))
    expect(powodSku.get('7701')).toContain(`ma EAN ${EAN_A}`)
    expect(powodSku.get('7707')).toContain('jest SKU „BRAK-PRODUKTU”, nie ma aktywnego produktu')
    expect(sku.bezTrafienia).toBe(sku.bezPary.length)

    const w = await polaczMasowo(db, ALLEGRO, 'EAN', ['7701', '7705'], 'user:u1')
    expect(w).toMatchObject({ polaczone: 1, pominiete: 1, bledy: 0 })
    expect(await db.channelOffer.findFirstOrThrow({ where: { ...ALLEGRO, externalId: '7701' } })).toMatchObject({ productId: herb, active: true, mappingSource: 'MANUAL' })
    // automat nie łączy SKU różniącego się zerami
    expect(await db.channelOffer.findFirst({ where: { ...ALLEGRO, externalId: '7705' } })).toBeNull()
  })

  it('oferta czekająca w propozycjach tego samego produktu nie powtarza się w „Połączy”; propozycja pokazuje SKU i EAN oferty', async () => {
    const p = await product(db, 'SKU-P', 2)
    const q = await product(db, 'SKU-Q', 2)
    await db.channelOfferRead.createMany({
      data: [
        { ...SD, externalId: '900', sku: 'SKU-P', ean: EAN_A, name: 'Oferta testowa 900', qty: 1, state: 'POWIAZANA', runId: 'run-test', seenAt: T0 },
        { ...SD, externalId: '901', sku: 'SKU-Q', name: 'Oferta testowa 901', qty: 1, state: 'BEZ_PRODUKTU', runId: 'run-test', seenAt: T0 },
      ],
    })
    await db.channelOffer.create({ data: { ...SD, externalId: '900', productId: p, active: false, needsApproval: true, mappingSource: 'SKU', deactivatedByImportAt: T0 } })
    const plan = await planLaczenia(db, SD, 'SKU')
    expect(plan.polaczy.map((x) => x.externalId)).toEqual(['901'])
    expect(plan.wPropozycjach).toBe(1)
    expect(plan.koliduje).toEqual([])
    expect((await propozycjeKonta(db, SD)).map((x) => [x.externalId, x.sku, x.ean, x.produkt.id])).toEqual([['900', 'SKU-P', EAN_A, p]])
    expect(q).toBeTruthy()
  })
})
