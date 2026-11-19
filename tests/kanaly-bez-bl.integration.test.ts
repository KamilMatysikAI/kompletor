// kanały i oferty bez BaseLinkera. Firma bez BL i bez wFirmy dodaje sklep Woo (atrapa REST w pamięci),
// pobiera oferty (produkty, stany startowe, oferty), zamówienie przechodzi przez ingestOrder bez „Do wyjaśnienia”,
// powstaje rezerwacja i spada stan dostępny. Do tego: powtórka pobrania, błąd jednej oferty, dwa sklepy z tym samym SKU,
// przypisanie z panelu przelicza zamówienie, firma z BL (propozycje, MANUAL nietknięte), izolacja dwóch firm.
// Dane zmyślone; „osobowe” wartości to znaczniki z suity kontraktowej.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountAdapter, loadChannelAccounts } from '@/lib/adaptery/konta'
import type { OfferReader } from '@/lib/adaptery/kontrakt'
import type { PrismaClient } from '@prisma/client'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { accountsForComparison } from '@/lib/cien/harmonogram'
import { kontoEkran, listaKont } from '@/lib/kanaly/dane'
import { korektaStanu } from '@/lib/kanaly/korekta-stanu'
import { dodajKonto, KontoError, wylaczKonto, zapiszSekrety, zmienKonto } from '@/lib/kanaly/konta'
import { doPrzypisania, przypiszOferte, utworzProduktZOferty } from '@/lib/kanaly/oferty'
import { KANAL_OFERTY_JOB, KANAL_TEST_JOB, wykonajPobranieOfert, wykonajTestPolaczenia, zlecPobranieOfert, zlecTestPolaczenia } from '@/lib/kanaly/zadania'
import { listSecrets, resolveSecrets, setSecret } from '@/lib/sekrety'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { wooOrderFromApi } from '@/lib/adaptery/woo'
import type { FetchLike } from '@/lib/zrodla/http'
import { ORG_A, ORG_B, seedImportConfig, testDb, truncateAll } from './db'
import { smallRaw } from './fixtures'
import { analyze } from '@/lib/import/katalog'
import { persistImport } from '@/lib/import/zapis'
import { expectInvariants } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const KEY = 'a'.repeat(64)
const ENV = { APP_ENCRYPTION_KEY: KEY, APP_MODE: 'self-host' }
const SRC = { env: ENV, envFallback: false }
const registry = defaultRegistry()
const OPTS = { actorId: 'test', env: ENV, registry }
const T = new Date('2026-11-02T10:00:00.000Z')
const CK = 'ck_tajny_klucz_testowy_123'
const CS = 'cs_tajny_sekret_testowy_456'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** Atrapa sklepu Woo (WC REST v3 w pamięci): produkty, warianty, zamówienia. Tylko GET. */
class WooAtrapa {
  products: Record<string, unknown>[] = []
  variations = new Map<number, Record<string, unknown>[]>()
  orders = new Map<number, Record<string, unknown>>()
  methods: string[] = []
  status = 200
  fetch: FetchLike = async (url, init) => {
    this.methods.push(init?.method ?? 'GET')
    const u = new URL(url)
    if (this.status !== 200) return json({ message: 'odmowa, treść kanału nie może trafić do panelu' }, this.status)
    const auth = (init?.headers as Record<string, string>)['Authorization']
    if (auth !== `Basic ${Buffer.from(`${CK}:${CS}`).toString('base64')}`) return json({ code: 'woocommerce_rest_cannot_view' }, 401)
    const path = u.pathname.replace(/^\/wp-json\/wc\/v3/, '')
    const per = Number(u.searchParams.get('per_page') ?? 10)
    const page = Number(u.searchParams.get('page') ?? 1)
    const pageOf = (all: unknown[]) => json(all.slice((page - 1) * per, page * per), 200, { 'x-wp-total': String(all.length), 'x-wp-totalpages': String(Math.max(1, Math.ceil(all.length / per))) })
    if (path === '/orders') return json([], 200, { 'x-wp-total': '0', 'x-wp-totalpages': '1' })
    const zam = /^\/orders\/(\d+)$/.exec(path)
    if (zam) return this.orders.has(Number(zam[1])) ? json(this.orders.get(Number(zam[1]))) : json({ code: 'woocommerce_rest_shop_order_invalid_id' }, 404)
    if (path === '/settings/products/woocommerce_hold_stock_minutes') return json({ value: '60' })
    if (path === '/products') return pageOf(this.products)
    const m = /^\/products\/(\d+)\/variations$/.exec(path)
    if (m) return pageOf(this.variations.get(Number(m[1])) ?? [])
    return json({ code: 'rest_no_route' }, 404)
  }
  simple(id: number, sku: string | null, qty: number | null, name = `Przyprawa testowa ${id}`) {
    this.products.push({ id, name, type: 'simple', status: 'publish', sku: sku ?? '', manage_stock: qty !== null, stock_quantity: qty, description: 'Jan Testowy' })
  }
}

async function firma(d: PrismaClient, wfirma = false) {
  await d.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)', wfirmaWarehouseId: wfirma ? '999001' : null, stockSource: wfirma ? 'WFIRMA' : 'KOMPLETOR' } })
}

async function dodajSklep(d: PrismaClient = db, name = 'Sklep testowy') {
  return dodajKonto(d, { adapterKey: 'woo.rest.v1', name, form: { baseUrl: 'https://sklep.example/', pageSize: '2', WOO_CONSUMER_KEY: CK, WOO_CONSUMER_SECRET: CS } }, OPTS)
}

const stockOf = async (productId: string) => db.stock.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId: DEFAULT_WAREHOUSE } } })

function wooOrder(id: number, productId: number, qty: number) {
  return wooOrderFromApi({
    id,
    status: 'processing',
    currency: 'PLN',
    date_created_gmt: '2026-11-02T09:00:00',
    date_modified_gmt: '2026-11-02T09:01:00',
    date_paid_gmt: '2026-11-02T09:00:30',
    total: '24.60',
    payment_method: 'blik',
    payment_method_title: 'BLIK',
    billing: { first_name: 'Jan Testowy' },
    line_items: [{ id: id * 10, product_id: productId, variation_id: 0, quantity: qty, total: '20.00', total_tax: '4.60' }],
    shipping_lines: [{ method_title: 'Paczkomaty InPost' }],
  })
}

async function ingest(d: PrismaClient, ref: { channel: 'WOO'; channelAccountId: string }, o: ReturnType<typeof wooOrder>) {
  return ingestOrder(d, {
    source: 'test',
    channel: ref.channel,
    channelAccountId: ref.channelAccountId,
    externalId: o.externalId,
    externalRevision: o.revision,
    createdAtChannel: o.createdAt,
    paymentState: o.paymentState,
    paymentMethod: o.paymentMethod,
    totalGross: o.totalGross,
    deliveryMethod: o.deliveryMethod,
    lines: o.lines.map((l) => ({ externalLineId: l.externalLineId, offerExternalId: l.offerExternalId, qty: l.qty, unitPriceGross: l.unitPriceGross })),
  }, { now: T })
}

let shop: WooAtrapa
beforeEach(async () => {
  await truncateAll(db)
  shop = new WooAtrapa()
})

const deps = () => ({ registry, secrets: SRC, fetch: shop.fetch, now: () => T })

describe('konta z panelu', () => {
  it('dodanie: identyfikator z nazwy, walidacja z manifestu, sekrety zaszyfrowane, tryb CIEN, audyt bez wartości', async () => {
    await firma(db)
    const a = await dodajSklep()
    const b = await dodajSklep(db, 'Sklep testowy')
    expect(a).toEqual({ channel: 'WOO', channelAccountId: 'sklep-testowy-1' })
    expect(b.channelAccountId).toBe('sklep-testowy-2')
    const cfg = await db.channelConfig.findFirstOrThrow({ where: { channelAccountId: a.channelAccountId } })
    expect(cfg).toMatchObject({ adapterKey: 'woo.rest.v1', active: true, stockMode: 'CIEN', statusMode: 'CIEN', config: { baseUrl: 'https://sklep.example', pageSize: 2 } })
    expect(await resolveSecrets(db, ['WOO_CONSUMER_KEY'], SRC, a)).toEqual({ WOO_CONSUMER_KEY: CK })
    const audit = JSON.stringify(await db.auditLog.findMany())
    expect(audit).toContain('WOO_CONSUMER_KEY')
    expect(audit).not.toContain(CK)
    expect(audit).not.toContain(CS)
    await expect(dodajKonto(db, { adapterKey: 'woo.rest.v1', name: 'Zły', form: { baseUrl: 'http://sklep.example' } }, OPTS)).rejects.toBeInstanceOf(KontoError)
    await expect(dodajKonto(db, { adapterKey: 'woo.rest.v1', name: 'Zły', form: { baseUrl: 'https://user:haslo@sklep.example' } }, OPTS)).rejects.toThrow(/loginu/)
    await expect(dodajKonto(db, { adapterKey: 'woo.rest.v1', name: 'Zły', form: {} }, OPTS)).rejects.toThrow(/baseUrl/)
    await expect(dodajKonto(db, { adapterKey: 'basecourier.v1', name: 'Kurier', form: {} }, OPTS)).rejects.toBeInstanceOf(KontoError)
  })

  it('hosting: adres prywatny odrzucony przy dodaniu', async () => {
    await firma(db)
    const env = { APP_ENCRYPTION_KEY: KEY, APP_MODE: 'hosted' }
    for (const baseUrl of ['https://127.0.0.1', 'https://0x7f.0.0.1', 'https://[::1]', 'https://169.254.169.254', 'https://localhost', 'https://sklep.internal'])
      await expect(dodajKonto(db, { adapterKey: 'woo.rest.v1', name: 'Zły', form: { baseUrl } }, { ...OPTS, env })).rejects.toBeInstanceOf(KontoError)
  })

  it('hosting: adapter konta z panelu (polling, przegląd, odbiorca) sprawdza DNS przed żądaniem', async () => {
    await firma(db)
    const env = { APP_ENCRYPTION_KEY: KEY, APP_MODE: 'hosted' }
    await dodajKonto(db, { adapterKey: 'woo.rest.v1', name: 'Sklep hostingu', form: { baseUrl: 'https://sklep.example/', WOO_CONSUMER_KEY: CK, WOO_CONSUMER_SECRET: CS } }, { ...OPTS, env })
    const acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO')!
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json([], 200, { 'x-wp-total': '0', 'x-wp-totalpages': '1' }))
    try {
      // rekord DNS wskazuje sieć prywatną: żądanie nie wychodzi (domyślny fetch, jak w zadaniach cienia bez deps.fetch)
      const zly = await createAccountAdapter(db, registry, acc, { env, envFallback: false }, { resolve: async () => ['192.168.1.1'] })
      await zly.testConnection().then(
        (r) => expect(r.ok).toBe(false),
        () => undefined,
      )
      await (zly as unknown as OfferReader).listOffers(null).then(
        () => expect.fail('listOffers przeszło mimo adresu prywatnego'),
        () => undefined,
      )
      expect(spy).not.toHaveBeenCalled()
      // adres publiczny: żądanie idzie, bez podążania za przekierowaniami
      const dobry = await createAccountAdapter(db, registry, acc, { env, envFallback: false }, { resolve: async () => ['93.184.216.34'] })
      await (dobry as unknown as OfferReader).listOffers(null)
      expect(spy).toHaveBeenCalled()
      expect(spy.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.redirect === 'manual')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('edycja nie gubi envPrefix, puste pole sekretu = bez zmiany, wyłączenie nie kasuje danych', async () => {
    await firma(db)
    const a = await dodajSklep()
    await db.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...a } }, data: { config: { baseUrl: 'https://sklep.example', envPrefix: 'SD_WC' } } })
    await zmienKonto(db, a, { name: 'Nowa nazwa', form: { baseUrl: 'https://inny.example', pollIntervalSec: '120' } }, OPTS)
    expect((await db.channelConfig.findFirstOrThrow({ where: { channelAccountId: a.channelAccountId } })).config).toEqual({ baseUrl: 'https://inny.example', envPrefix: 'SD_WC', pollIntervalSec: 120 })
    expect(await zapiszSekrety(db, a, { WOO_CONSUMER_KEY: '', WOO_CONSUMER_SECRET: 'nowy-sekret' }, OPTS)).toEqual(['WOO_CONSUMER_SECRET'])
    expect(await resolveSecrets(db, ['WOO_CONSUMER_KEY', 'WOO_CONSUMER_SECRET'], SRC, a)).toEqual({ WOO_CONSUMER_KEY: CK, WOO_CONSUMER_SECRET: 'nowy-sekret' })
    await wylaczKonto(db, a, false, OPTS)
    expect((await db.channelConfig.findFirstOrThrow({ where: { channelAccountId: a.channelAccountId } })).active).toBe(false)
    expect((await listSecrets(db)).length).toBe(2)
  })

  it('dwie firmy: firma B nie widzi kont, sekretów, ofert ani wyników firmy A', async () => {
    await firma(db)
    await firma(dbB)
    shop.simple(10, 'SKU-A', 3)
    const a = await dodajSklep()
    await wykonajPobranieOfert(db, a, deps())
    expect(await dbB.channelConfig.count()).toBe(0)
    expect(await dbB.integrationSecret.count()).toBe(0)
    expect(await dbB.channelOffer.count()).toBe(0)
    expect(await dbB.channelOfferRead.count()).toBe(0)
    expect(await dbB.channelAccountStatus.count()).toBe(0)
    await expect(zapiszSekrety(dbB, a, { WOO_CONSUMER_KEY: 'x' }, OPTS)).rejects.toThrow(/Nie ma takiego konta/)
    await expect(zlecTestPolaczenia(dbB, a, T)).rejects.toThrow(/Nie ma takiego konta/)
    expect(await wykonajPobranieOfert(dbB, a, deps())).toBeNull()
  })
})

describe('test połączenia', () => {
  it('limit 30 s na konto, zadanie z dedupe, wynik bez treści kanału i bez sekretów', async () => {
    await firma(db)
    const a = await dodajSklep()
    expect(await zlecTestPolaczenia(db, a, T)).toBe('ZLECONO')
    expect(await zlecTestPolaczenia(db, a, new Date(T.getTime() + 10_000))).toBe('ZA_CZESTO')
    expect(await zlecTestPolaczenia(db, a, new Date(T.getTime() + 31_000))).toBe('ZLECONO')
    expect(await db.job.count({ where: { kind: KANAL_TEST_JOB } })).toBe(1) // drugie zlecenie czeka w tym samym zadaniu
    expect(await wykonajTestPolaczenia(db, a, deps())).toMatchObject({ ok: true })
    shop.status = 401
    const r = await wykonajTestPolaczenia(db, a, deps())
    expect(r).toMatchObject({ ok: false })
    const st = await db.channelAccountStatus.findFirstOrThrow({ where: { channelAccountId: a.channelAccountId } })
    expect(st.testOk).toBe(false)
    expect(st.testMessage).toMatch(/odrzucił klucz/)
    expect(st.testMessage).not.toContain('odmowa')
    expect(JSON.stringify(st)).not.toContain(CK)
    expect(new Set(shop.methods)).toEqual(new Set(['GET']))
  })
})

describe('pobranie ofert, firma bez BL i bez wFirmy', () => {
  it('przykład: oferty → produkty i stany; zamówienie bez „Do wyjaśnienia”, rezerwacja, dostępny spada', async () => {
    await firma(db)
    shop.simple(10, 'HERB-1', 7)
    shop.simple(11, 'HERB-2', null) // bez stanu w kanale → stan startowy 0
    shop.simple(12, null, 4) // bez SKU → do przypisania
    shop.products.push({ id: 20, name: 'Papryka', type: 'variable', status: 'publish', sku: 'PAPRYKA', manage_stock: false })
    shop.variations.set(20, [
      { id: 21, sku: 'PAPRYKA-30', manage_stock: true, stock_quantity: 5, attributes: [{ option: '30 g' }], status: 'publish' },
      { id: 22, sku: 'PAPRYKA-50', manage_stock: 'parent', attributes: [{ option: '50 g' }], status: 'publish' },
    ])
    const a = await dodajSklep()
    expect(await zlecPobranieOfert(db, a, T)).toBe('ZLECONO')
    expect(await db.job.count({ where: { kind: KANAL_OFERTY_JOB } })).toBe(1)
    const w = (await wykonajPobranieOfert(db, a, deps()))!
    expect(w).toMatchObject({ status: 'OK', read: 5, newProducts: 4, newOffers: 4, bezSku: 1, errors: 0, complete: true })
    expect(w.pages).toBe(2) // strona 2 produktów na stronę
    // PAPRYKA-50: manage_stock „parent” przy rodzicu bez stanu → bez stanu (0 sztuk startowo)
    const herb1 = await db.product.findFirstOrThrow({ where: { sku: 'HERB-1' } })
    expect(herb1).toMatchObject({ kind: 'STOCKED', unit: 'SZT', title: 'Przyprawa testowa 10', nameAccounting: 'Przyprawa testowa 10', wfirmaGoodId: null })
    expect(await stockOf(herb1.id)).toMatchObject({ physical: 7, reserved: 0 })
    expect(await db.stockMovement.findFirst({ where: { productId: herb1.id } })).toMatchObject({ source: 'INITIAL_IMPORT', deltaPhysical: 7, reason: expect.stringContaining('stan startowy z kanału') })
    expect(await stockOf((await db.product.findFirstOrThrow({ where: { sku: 'HERB-2' } })).id)).toMatchObject({ physical: 0 })
    const off = await db.channelOffer.findFirstOrThrow({ where: { externalId: '20/21' } })
    expect(off).toMatchObject({ active: true, needsApproval: false, mappingSource: 'SKU' })
    expect((await doPrzypisania(db, a)).map((x) => x.externalId)).toEqual(['12'])

    const r = await ingest(db, a as { channel: 'WOO'; channelAccountId: string }, wooOrder(500, 10, 2))
    expect(r.status).not.toBe('DO_WYJASNIENIA')
    expect(r.reservedUnits).toBe(2)
    const order = await db.order.findFirstOrThrow({ include: { lines: true, reservations: true } })
    expect(order.lines[0]!.productId).toBe(herb1.id)
    expect(order.reservations).toHaveLength(1)
    const s = await stockOf(herb1.id)
    expect(s.physical - s.reserved).toBe(5)
    await expectInvariants(db)
  })

  it('powtórka nic nie dubluje i nie zmienia ilości; błąd jednej oferty nie przerywa przebiegu', async () => {
    await firma(db)
    shop.simple(10, 'HERB-1', 7)
    shop.simple(11, 'HERB-2', 3)
    shop.products.push({ id: 12, name: 'Zepsuta', type: 'simple', status: 'publish', sku: 'HERB-3', manage_stock: true, stock_quantity: 'abc' })
    const a = await dodajSklep()
    const w1 = (await wykonajPobranieOfert(db, a, deps()))!
    expect(w1).toMatchObject({ status: 'PARTIAL', newProducts: 2, newOffers: 2, unreadable: 1 })
    expect(await db.product.findFirst({ where: { sku: 'HERB-3' } })).toBeNull() // nigdy z ilością 0
    expect(await db.importIssue.count({ where: { runId: w1.runId, kind: 'oferta-nieczytelna' } })).toBe(1)
    ;(shop.products[0] as Record<string, unknown>)['stock_quantity'] = 99 // kanał zmienił stan: u nas bez zmiany
    const w2 = (await wykonajPobranieOfert(db, a, deps()))!
    expect(w2).toMatchObject({ newProducts: 0, newOffers: 0, kept: 2 })
    expect(w2.rozjazdy).toEqual([{ externalId: '10', sku: 'HERB-1', kanal: 99, stan: 7 }])
    expect(await db.product.count()).toBe(2)
    expect(await db.channelOffer.count()).toBe(2)
    expect(await db.stockMovement.count()).toBe(2)
    expect((await stockOf((await db.product.findFirstOrThrow({ where: { sku: 'HERB-1' } })).id)).physical).toBe(7)
  })

  it('dwa sklepy z tym samym SKU: jeden produkt, stan startowy z pierwszego, drugi tylko oferta i rozjazd', async () => {
    await firma(db)
    shop.simple(10, 'HERB-1', 7)
    const a = await dodajSklep(db, 'Sklep pierwszy')
    await wykonajPobranieOfert(db, a, deps())
    const shop2 = new WooAtrapa()
    shop2.simple(77, 'HERB-1', 4)
    const b = await dodajSklep(db, 'Sklep drugi')
    const w = (await wykonajPobranieOfert(db, b, { ...deps(), fetch: shop2.fetch }))!
    expect(w).toMatchObject({ newProducts: 0, newOffers: 1, rozjazdy: [{ externalId: '77', sku: 'HERB-1', kanal: 4, stan: 7 }] })
    expect(await db.product.count()).toBe(1)
    expect(await db.channelOffer.count()).toBe(2)
  })

  it('SKU powtórzone na dwóch ofertach konta: obie do przypisania; przypisanie przelicza zamówienie „Do wyjaśnienia”', async () => {
    await firma(db)
    shop.simple(10, 'DUBEL', 5)
    shop.simple(11, 'DUBEL', 5)
    const a = await dodajSklep()
    const w = (await wykonajPobranieOfert(db, a, deps()))!
    expect(w).toMatchObject({ wieloznaczne: 2, newProducts: 0 })
    // zamówienie przyszło przed przypisaniem: „Do wyjaśnienia”, bez rezerwacji
    const r = await ingest(db, a as { channel: 'WOO'; channelAccountId: string }, wooOrder(600, 11, 1))
    expect(r.status).toBe('DO_WYJASNIENIA')
    const lista = await doPrzypisania(db, a)
    expect(lista.find((x) => x.externalId === '11')).toMatchObject({ orders: 1, state: 'WIELOZNACZNE' })
    expect(JSON.stringify(lista)).not.toContain('Jan Testowy')
    const { productId } = await utworzProduktZOferty(db, a, '10', { actorId: 'test', hasWfirma: false, now: T })
    const p2 = await db.product.create({ data: { sku: 'DUBEL-B', kind: 'STOCKED', unit: 'SZT', title: 'Dubel B', nameAccounting: 'Dubel B' } })
    await db.stock.create({ data: { productId: p2.id, warehouseId: DEFAULT_WAREHOUSE, wfirmaCount: 3, physical: 3, wfirmaReadAt: T } })
    const res = await przypiszOferte(db, a, { externalId: '11', productId: p2.id, qtyBasePerOffer: 2 }, { actorId: 'test', now: T })
    expect(res).toEqual({ remapped: 1, failed: 0 })
    const o = await db.order.findFirstOrThrow({ include: { lines: true } })
    expect(o.status).not.toBe('DO_WYJASNIENIA')
    expect(o.lines[0]).toMatchObject({ productId: p2.id, qty: 2 })
    expect((await stockOf(p2.id)).reserved).toBe(2)
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '11' } })).toMatchObject({ mappingSource: 'MANUAL', active: true })
    expect((await doPrzypisania(db, a)).length).toBe(0)
    expect(productId).toBeTruthy()
    // kolejne pobranie nie rusza przypisania z panelu
    await wykonajPobranieOfert(db, a, { ...deps(), now: () => new Date(T.getTime() + 60_000) })
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '11' } })).toMatchObject({ mappingSource: 'MANUAL', productId: p2.id, qtyBasePerOffer: 2 })
    await expectInvariants(db)
  })

  it('konto firmy bez BL nie trafia do porównania z BL', async () => {
    await firma(db)
    const a = await dodajSklep()
    expect((await accountsForComparison(db)).map((x) => x.channelAccountId)).not.toContain(a.channelAccountId)
    await db.organization.update({ where: { id: ORG_A }, data: { settings: { baselinker: { inventoryId: '777' } } } })
    expect((await accountsForComparison(db)).map((x) => x.channelAccountId)).toContain(a.channelAccountId)
  })

  it('firma z tokenem BL bez inventory: konto z panelu w porównaniu, jak w firmaMaBl', async () => {
    await firma(db)
    const a = await dodajSklep()
    expect((await accountsForComparison(db, SRC)).map((x) => x.channelAccountId)).not.toContain(a.channelAccountId)
    await setSecret(db, 'BASELINKER_TOKEN', 'token-bl-testowy', ENV)
    expect((await accountsForComparison(db, SRC)).map((x) => x.channelAccountId)).toContain(a.channelAccountId)
  })
})

describe('firma z BL', () => {
  it('import BL nie nadpisuje przypisania z panelu (MANUAL)', async () => {
    await seedImportConfig()
    await persistImport(db, smallRaw(), analyze(smallRaw()))
    const o = await db.channelOffer.findFirstOrThrow({ where: { externalId: '501' } })
    const c1 = await db.product.findFirstOrThrow({ where: { sku: 'C1' } })
    expect(o.productId).not.toBe(c1.id)
    await przypiszOferte(db, { channel: o.channel, channelAccountId: o.channelAccountId }, { externalId: '501', productId: c1.id, qtyBasePerOffer: 3 }, { actorId: 'test' })
    const s = await persistImport(db, smallRaw(), analyze(smallRaw()))
    expect(s.channelOffersManualKept).toBeGreaterThanOrEqual(1)
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '501' } })).toMatchObject({ mappingSource: 'MANUAL', productId: c1.id, qtyBasePerOffer: 3, active: true })
  })


  it('nowe oferty po SKU tylko jako propozycje, bez zakładania produktów; MANUAL i powiązania BL nietknięte', async () => {
    await firma(db, true)
    await db.organization.update({ where: { id: ORG_A }, data: { settings: { baselinker: { inventoryId: '777' } } } })
    const p = await db.product.create({ data: { sku: 'HERB-1', kind: 'STOCKED', unit: 'SZT', title: 'H1', nameAccounting: 'H1', wfirmaGoodId: '1' } })
    const q = await db.product.create({ data: { sku: 'HERB-9', kind: 'STOCKED', unit: 'SZT', title: 'H9', nameAccounting: 'H9', wfirmaGoodId: '9' } })
    shop.simple(10, 'HERB-1', 5)
    shop.simple(11, 'NOWY', 5)
    shop.simple(12, 'HERB-1-INNY', 5)
    shop.simple(13, 'HERB-1-LINK', 5)
    const a = await dodajSklep()
    await db.channelOffer.create({ data: { ...a, externalId: '12', productId: q.id, mappingSource: 'MANUAL' } })
    await db.channelOffer.create({ data: { ...a, externalId: '13', productId: q.id, mappingSource: 'BL_LINK' } })
    const w = (await wykonajPobranieOfert(db, a, deps()))!
    expect(w).toMatchObject({ newProducts: 0, proposals: 1, kept: 2, bezProduktu: 1 })
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '10' } })).toMatchObject({ productId: p.id, active: false, needsApproval: true, mappingSource: 'SKU' })
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '12' } })).toMatchObject({ productId: q.id, mappingSource: 'MANUAL', active: true })
    expect(await db.channelOffer.findFirstOrThrow({ where: { externalId: '13' } })).toMatchObject({ productId: q.id, mappingSource: 'BL_LINK' })
    expect(await db.product.count()).toBe(2)
    expect(await db.stock.count()).toBe(0)
    await expect(utworzProduktZOferty(db, a, '11', { actorId: 'test', hasWfirma: true })).rejects.toBeInstanceOf(KontoError)
  })
})

describe('runda 3: limit rabatu adaptera z ustawień firmy', () => {
  it('host podaje adapterowi Woo `faktury.rabatMaksProcent` firmy: rabat 40% przy limicie 30 zostaje bez rozkładu, przy 50 rozłożony', async () => {
    await firma(db)
    await dodajSklep()
    shop.orders.set(77, {
      id: 77,
      status: 'processing',
      currency: 'PLN',
      date_created_gmt: '2026-11-02T09:00:00',
      date_modified_gmt: '2026-11-02T09:01:00',
      date_paid_gmt: '2026-11-02T09:00:30',
      total: '72.99',
      shipping_total: '10.56',
      shipping_tax: '2.43',
      payment_method: 'blik',
      line_items: [{ id: 770, product_id: 10, variation_id: 0, quantity: 1, total: '81.30', total_tax: '18.70' }],
      fee_lines: [{ id: 771, name: 'Rabat', total: '-32.52', total_tax: '-7.48' }],
      shipping_lines: [{ method_title: 'Kurier' }],
    })
    const acc = (await loadChannelAccounts(db)).find((x) => x.channel === 'WOO')!
    const odczyt = async () => (await createAccountAdapter(db, registry, acc, SRC, { fetch: shop.fetch, now: () => T }) as unknown as { getOrder(id: string): Promise<{ lines: { unitPriceGross: number }[]; warnings: string[] } | null> }).getOrder('77')
    await db.organization.update({ where: { id: ORG_A }, data: { settings: { faktury: { rabatMaksProcent: 30 } } } })
    const przy30 = await odczyt()
    expect(przy30!.lines[0]!.unitPriceGross).toBe(100)
    expect(przy30!.warnings.join(' ')).toContain('większy niż 30%')
    await db.organization.update({ where: { id: ORG_A }, data: { settings: { faktury: { rabatMaksProcent: 50 } } } })
    expect((await odczyt())!.lines[0]!.unitPriceGross).toBe(60)
    // pole konta nie ma już znaczenia (nie ma go w manifeście): firma bez ustawienia = domyślne 50
    await db.organization.update({ where: { id: ORG_A }, data: { settings: {} } })
    expect((await odczyt())!.lines[0]!.unitPriceGross).toBe(60)
  })
})

describe('ekran konta', () => {
  it('dane ekranu (lista, konto, do przypisania) nie zawierają wartości sekretów', async () => {
    await firma(db)
    shop.simple(10, null, 1)
    const a = await dodajSklep()
    await wykonajPobranieOfert(db, a, deps())
    await wykonajTestPolaczenia(db, a, deps())
    const e = await kontoEkran(db, registry, a, T)
    expect(e!.sekrety.map((x) => [x.field.name, !!x.savedAt])).toEqual([
      ['WOO_CONSUMER_KEY', true],
      ['WOO_CONSUMER_SECRET', true],
    ])
    expect(e!.doPrzypisania).toHaveLength(1)
    const html = JSON.stringify([e, await listaKont(db, registry)])
    expect(html).not.toContain(CK)
    expect(html).not.toContain(CS)
    expect(await kontoEkran(dbB, registry, a, T)).toBeNull()
  })
})

describe('korekta stanu', () => {
  it('firma bez wFirmy: ruch OWN_CORRECTION, outbox, niezmienniki; z wFirmą odmowa', async () => {
    await firma(db)
    const p = await db.product.create({ data: { sku: 'KOR-1', kind: 'STOCKED', unit: 'SZT', title: 'K', nameAccounting: 'K' } })
    expect(await korektaStanu(db, { productId: p.id, physicalAfter: 5, reason: 'inwentaryzacja' }, { actorId: 'test', now: T })).toEqual({ delta: 5 })
    expect(await stockOf(p.id)).toMatchObject({ physical: 5, wfirmaCount: 5, pendingDelta: 0 })
    expect(await korektaStanu(db, { productId: p.id, physicalAfter: 3, reason: 'uszkodzone' }, { actorId: 'test', now: T })).toEqual({ delta: -2 })
    expect((await db.stockMovement.findMany({ where: { productId: p.id }, orderBy: { createdAt: 'asc' } })).map((m) => [m.source, m.deltaPhysical])).toEqual([
      ['OWN_CORRECTION', 5],
      ['OWN_CORRECTION', -2],
    ])
    expect(await db.outboxEvent.count({ where: { productId: p.id, kind: 'AVAILABLE_CHANGED' } })).toBe(2)
    await expect(korektaStanu(db, { productId: p.id, physicalAfter: -1, reason: 'zly' }, { actorId: 'test' })).rejects.toBeInstanceOf(KontoError)
    await expect(korektaStanu(db, { productId: p.id, physicalAfter: 1, reason: '' }, { actorId: 'test' })).rejects.toBeInstanceOf(KontoError)
    await expectInvariants(db)
    await db.warehouse.update({ where: { organizationId_id: { organizationId: ORG_A, id: DEFAULT_WAREHOUSE } }, data: { wfirmaWarehouseId: '999001', stockSource: 'WFIRMA' } })
    await expect(korektaStanu(db, { productId: p.id, physicalAfter: 9, reason: 'inwentaryzacja' }, { actorId: 'test' })).rejects.toThrow(/lustro wFirmy/)
  })
})
