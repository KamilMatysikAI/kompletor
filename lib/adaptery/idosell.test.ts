// Testy adaptera IdoSell wyłącznie na atrapie HTTP (tests/idosell-atrapa.ts): suita kontraktowa dla obu
// kluczy i dwóch rozmiarów strony, kursor bez gubienia i dubli między stronami, mapowanie statusów, płatności i kwot,
// oferty z rozmiarami, wyłącznik zapisu (zero żądań), 429 z czasem ponowienia, 5xx i zerwane połączenie po zapisie,
// częściowy sukces paczki stanów, zmiana statusu. Dane zmyślone, adresy example.invalid; zero połączeń z IdoSell.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHANNEL_ADAPTER } from '../adaptery'
import { ReadOnlyViolation } from '../zrodla/http'
import { IdoSellOdczyt, IdoSellSesja, IdoSellZapis, idosellApiBase } from '../zrodla/idosell'
import { IdoSellAtrapa, type IdoSellAtrapaOpts } from '../../tests/idosell-atrapa'
import { defaultRegistry } from './domyslne'
import { IDOSELL_BEHAVIOR, IDOSELL_STATUS, idosellMinIntervalMs, idosellOffersFromApi, idosellOrderFromApi, parseOfferId, ZAPIS_WYLACZONY } from './idosell'
import { type ChannelAdapter, type ChannelOrder, hasOrderStatusWriter, hasStockWriter, type OfferReader, type OrderFeed, type OrderStatusWriter, type StockWriter, UnreadableDataError } from './kontrakt'
import { AdapterConfigError, manifestProblems } from './rejestr'
import { type ContractHarness, PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'
import { executeWrite } from './zapis'

const NOW = new Date('2026-11-09T12:00:00.000Z')
const ACC = { organizationId: 'test_a', kind: 'channel' as const, id: 'IDOSELL/demo', channel: 'IDOSELL' as const, channelAccountId: 'demo', name: 'Sklep IdoSell testowy' }
const FAST = { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 }
const KEY = 'klucz-ido-test'
const LOOKBACK = { initialLookbackMs: 7 * 24 * 3600_000 }
const ZAPIS = 'idosell.admin.zapis.v1'

type Full = ChannelAdapter & OrderFeed & OfferReader & Partial<StockWriter & OrderStatusWriter>

function make(opts: { key?: string; config?: Record<string, unknown>; secrets?: Record<string, string>; atrapa?: IdoSellAtrapaOpts } = {}) {
  const at = new IdoSellAtrapa({ apiKey: KEY, ...opts.atrapa })
  for (const id of [10, 11, 12, 13]) at.putProduct(id)
  const create = (config: Record<string, unknown> = opts.config ?? {}) =>
    defaultRegistry().create(opts.key ?? 'idosell.admin.v1', {
      integration: ACC,
      rawConfig: { baseUrl: at.host, ...config },
      rawSecrets: opts.secrets ?? { IDOSELL_API_KEY: KEY },
      fetch: at.fetch,
      now: () => NOW,
      http: FAST,
    }) as Full
  return { at, adapter: create(), create }
}

// ─── Suita kontraktowa: oba klucze, strony po 2 i po 100 ─────────────────────

function harness(key: 'idosell.admin.v1' | typeof ZAPIS, pageSize: number, pusta404 = true): ContractHarness {
  const zapis = key === ZAPIS
  return {
    name: `${key} (atrapa IdoSell, strona ${pageSize}${pusta404 ? '' : ', pusty wynik 200'})`,
    now: NOW,
    setup() {
      const { at, adapter, create } = make({ key, config: { pageSize, ...(zapis ? { zapisWlaczony: true } : {}) }, atrapa: { pustaJako404: pusta404 } })
      let wyczyszczone = false
      return {
        adapter,
        putOrder: (o) => at.putOrder(o),
        corruptOrder: (id) => at.corruptOrder(id),
        failNextList: (kind) => at.failNextList(kind),
        requests: () => at.requests(),
        readMethods: ['POST'],
        putOffer: (o) => {
          // produkty 10–13 (pod zapis stanu) nie należą do listy ofert suity
          if (!wyczyszczone) at.products.clear()
          wyczyszczone = true
          at.putOffer(o)
        },
        corruptOffer: (id) => at.corruptOffer(id),
        ...(zapis
          ? {
              injectWriteFailure: (f: Parameters<IdoSellAtrapa['injectWriteFailure']>[0]) => at.injectWriteFailure(f),
              absoluteStockWrite: true,
              statusWrite: { target: 'packed', read: (id: string) => at.statusOf(id) },
              writeDisabled: () => create({ pageSize }),
            }
          : {}),
      }
    },
  }
}

runAdapterContract(harness('idosell.admin.v1', 2))
runAdapterContract(harness('idosell.admin.v1', 100))
runAdapterContract(harness(ZAPIS, 2))
runAdapterContract(harness(ZAPIS, 100, false))

// ─── Manifest i rejestr ──────────────────────────────────────────────────────

describe('idosell: manifest, rejestr, konfiguracja', () => {
  it('dwa klucze w rejestrze, domyślny tylko do odczytu, zapis za wyłącznikiem, mapa statusów ze słownika', () => {
    const r = defaultRegistry()
    expect(DEFAULT_CHANNEL_ADAPTER.IDOSELL).toBe('idosell.admin.v1')
    const odczyt = r.get('idosell.admin.v1')!.manifest
    const zapis = r.get(ZAPIS)!.manifest
    expect(manifestProblems(odczyt)).toEqual([])
    expect(manifestProblems(zapis)).toEqual([])
    expect(odczyt).toMatchObject({ readOnly: true, channel: 'IDOSELL', kind: 'channel', capabilities: ['orders.feed', 'offers.read'] })
    expect(zapis.capabilities).toEqual(['orders.feed', 'offers.read', 'stock.write', 'order.status.write'])
    expect(zapis.config.find((f) => f.key === 'zapisWlaczony')).toMatchObject({ type: 'boolean', required: false })
    // bez domyślnej mapy statusów (tabela „Statusy w sklepie” do świadomego uzupełnienia, jak Shoper)
    expect(IDOSELL_BEHAVIOR.defaultStatusMap).toBeUndefined()
    // cele zapisu tylko ze słownika i bez statusów, które ustawia sam sklep albo kurier
    const cele = IDOSELL_BEHAVIOR.channelStatuses!.map((s) => s.id)
    for (const v of cele) expect(IDOSELL_STATUS[v]).toBeDefined()
    for (const v of ['joined', 'missing', 'lost', 'false']) expect(cele).not.toContain(v)
    expect(IDOSELL_BEHAVIOR.channelStatuses!.find((s) => s.id === 'finished')!.label).toMatch(/do potwierdzenia/)
    // bez strojenia hosta odstęp między żądaniami z limitu manifestu
    expect(idosellMinIntervalMs(odczyt)).toBe(60_000 / odczyt.rateLimit.requestsPerMinute)
    expect(idosellMinIntervalMs(zapis)).toBe(60_000 / zapis.rateLimit.requestsPerMinute)
  })

  it('zła konfiguracja: brak klucza, zły adres, zła wersja, zły magazyn, zła strefa = błąd konfiguracji przed żądaniem', () => {
    expect(() => make({ secrets: {} })).toThrow(/IDOSELL_API_KEY/)
    expect(() => make({ config: { baseUrl: 'http://sklep.example.invalid' } })).toThrow(AdapterConfigError)
    expect(() => make({ config: { wersjaApi: 'v5' } })).toThrow(AdapterConfigError)
    expect(() => make({ config: { magazyn: 0 } })).toThrow(AdapterConfigError)
    expect(() => make({ config: { strefa: 'Mars/Olympus' } })).toThrow(AdapterConfigError)
  })

  it('adres API: domena panelu, także z /api/admin/vN; ścieżka i parametry odrzucone', () => {
    expect(idosellApiBase('https://client1.idosell.com/')).toBe('https://client1.idosell.com/api/admin/v8')
    expect(idosellApiBase('https://sklep.pl/api/admin/v6', 'v6')).toBe('https://sklep.pl/api/admin/v6')
    expect(() => idosellApiBase('https://sklep.pl/panel')).toThrow()
    expect(() => idosellApiBase('https://sklep.pl?x=1')).toThrow()
  })

  it('klient odczytu: tylko POST na ścieżki wyszukiwania; klient zapisu: tylko PUT stanów i statusów', async () => {
    const at = new IdoSellAtrapa({ apiKey: KEY })
    const s = new IdoSellSesja(at.host, 'v8', KEY, at.fetch, 0, FAST.retry)
    await expect(new IdoSellOdczyt(s).search('products/products', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(new IdoSellOdczyt(s).search('orders/orders/search', {}, { method: 'PUT' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(new IdoSellZapis(s).put('orders/packages', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(new IdoSellZapis(s).put('products/products', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(at.log).toEqual([])
  })

  it('test połączenia: liczby bez danych; zły klucz i brak uprawnienia mówią wprost, bez treści odpowiedzi sklepu', async () => {
    const { at, adapter } = make()
    at.putOrder({ externalId: '1', state: 'open', offer: '10', qty: 1, createdAt: NOW, modifiedAt: NOW })
    expect(await adapter.testConnection()).toEqual({ ok: true, message: 'odczyt zamówień i produktów działa', details: { orders: 1, products: 4, magazyn: 1 } })
    const zly = make({ secrets: { IDOSELL_API_KEY: 'inny' } })
    expect(await zly.adapter.testConnection()).toMatchObject({ ok: false, message: 'klucz API odrzucony przez IdoSell' })
    const bez = make()
    bez.at.failNext('products/products/search', 403)
    const r = await bez.adapter.testConnection()
    expect(r).toMatchObject({ ok: false, message: 'klucz API bez uprawnienia do odczytu: produkty' })
    expect(JSON.stringify(r)).not.toContain(PII_SENTINELS[1])
    const zapis = make({ key: ZAPIS })
    expect((await zapis.adapter.testConnection()).details).toMatchObject({ zapisWlaczony: false })
    expect(new Set(zapis.at.requests())).toEqual(new Set(['POST']))
  })

  it('zły adres panelu (HTML 404) = błąd trwały z podpowiedzią', async () => {
    const { adapter } = make({ atrapa: { wersja: 'v6' } }) // atrapa słucha na v6, adapter woła v8
    await expect(adapter.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/nie odpowiada jak API IdoSell/) })
  })
})

// ─── Dziennik zamówień ───────────────────────────────────────────────────────

async function readAll(a: Full, cursor: string | null = null): Promise<{ seen: string[]; orders: Map<string, ChannelOrder>; cursor: string; pages: number }> {
  const seen: string[] = []
  const orders = new Map<string, ChannelOrder>()
  let cur = cursor
  for (let pages = 1; pages < 100; pages++) {
    const p = await a.listOrderChanges(cur, LOOKBACK)
    for (const it of p.items) {
      seen.push(it.externalId)
      orders.set(it.externalId, it.order ?? (await a.getOrder(it.externalId))!)
    }
    cur = p.nextCursor
    if (!p.hasMore) return { seen, orders, cursor: cur, pages }
  }
  throw new Error('bez końca')
}

describe('idosell: kursor dziennika', () => {
  const t = (min: number) => new Date(NOW.getTime() - 3 * 3600_000 + min * 60_000)

  it('7 zamówień na stronach po 2: każde dokładnie raz, w kolejności numerów, bez getOrder (pełne zamówienie z wyszukiwania)', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 } })
    for (let i = 1; i <= 7; i++) at.putOrder({ externalId: String(i), state: 'open', offer: '10', qty: 1, createdAt: t(i), modifiedAt: t(i) })
    const r = await readAll(adapter)
    expect(r.seen).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(r.pages).toBe(4)
    // strony od 0, filtr po dacie zmiany, sortowanie rosnąco po numerze
    const bodies = at.log.map((x) => x.body?.['params'] as Record<string, unknown>)
    expect(bodies.map((b) => b['resultsPage'])).toEqual([0, 1, 2, 3])
    expect(bodies[0]).toMatchObject({ resultsLimit: 2, ordersRange: { ordersDateRange: { ordersDateType: 'modified' } }, ordersBy: [{ elementName: 'id', sortDirection: 'ASC' }] })
  })

  it('odpowiedź bez resultsNumberPage — pełna strona = czytamy dalej, zamówienia ze stron 2…n nie giną', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 }, atrapa: { bezLiczbyStron: true, pustaJako404: false } })
    for (let i = 1; i <= 7; i++) at.putOrder({ externalId: String(i), state: 'open', offer: '10', qty: 1, createdAt: t(i), modifiedAt: t(i) })
    const r = await readAll(adapter)
    expect(r.seen).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(r.pages).toBe(4) // ostatnia niepełna strona kończy przebieg
    // równo pełne strony: jedna pusta strona na końcu, bez błędu (także jako „brak wyników” 404)
    for (const pusta of [false, true]) {
      const x = make({ config: { pageSize: 2 }, atrapa: { bezLiczbyStron: true, pustaJako404: pusta } })
      for (let i = 1; i <= 4; i++) x.at.putOrder({ externalId: String(i), state: 'open', offer: '10', qty: 1, createdAt: t(i), modifiedAt: t(i) })
      const y = await readAll(x.adapter)
      expect(y.seen).toEqual(['1', '2', '3', '4'])
      expect(y.pages).toBe(3)
    }
  })

  it('zmiana zamówienia z przeczytanej strony w trakcie odczytu: nie gubi następnych stron, a zmiana przychodzi w kolejnym przebiegu', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 } })
    for (let i = 1; i <= 5; i++) at.putOrder({ externalId: String(i), state: 'open', offer: '10', qty: 1, createdAt: t(i), modifiedAt: t(i) })
    const p1 = await adapter.listOrderChanges(null, LOOKBACK)
    expect(p1.items.map((x) => x.externalId)).toEqual(['1', '2'])
    at.putOrder({ externalId: '1', state: 'cancelled', offer: '10', qty: 1, createdAt: t(1), modifiedAt: t(100) })
    at.putOrder({ externalId: '6', state: 'open', offer: '11', qty: 1, createdAt: t(101), modifiedAt: t(101) })
    const rest = await readAll(adapter, p1.nextCursor)
    // zamówienie 1 zostaje na swoim miejscu listy (sort po numerze), więc nic się nie przesuwa; 6 dochodzi na końcu
    expect(rest.seen).toEqual(['3', '4', '5', '6'])
    const next = await readAll(adapter, rest.cursor)
    // następny przebieg od najpóźniejszej zmiany minus zakładka 5 min: zmiana zamówienia 1 przychodzi, 6 wraca (host odsiewa po rewizji)
    expect(next.seen).toEqual(['1', '6'])
    expect(next.orders.get('1')!.lifecycle).toBe('CANCELLED')
    expect(next.orders.get('6')!.revision).toBe(rest.orders.get('6')!.revision)
  })

  it('pusty dziennik (brak wyników 404 albo pusta lista) = koniec bez błędu', async () => {
    for (const pusta of [true, false]) {
      const { adapter } = make({ atrapa: { pustaJako404: pusta } })
      const p = await adapter.listOrderChanges(null, LOOKBACK)
      expect(p).toMatchObject({ items: [], hasMore: false })
    }
  })

  it('429 przy odczycie = PRZEJSCIOWY z czasem ponowienia z Retry-After', async () => {
    const { at, adapter } = make()
    at.failNext('orders/orders/search', 429, { 'Retry-After': '17' })
    await expect(adapter.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 17_000 })
  })
})

// ─── Mapowanie ───────────────────────────────────────────────────────────────

const wiersz = (det: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> => ({
  orderId: 'sklep-1-500',
  orderSerialNumber: 500,
  clientResult: { clientBillingAddress: { clientFirstName: PII_SENTINELS[0], clientNip: '' }, clientDeliveryAddress: { clientDeliveryAddressPhone1: PII_SENTINELS[2] } },
  orderDetails: {
    orderStatus: 'new',
    orderAddDate: '2026-11-02 10:00:00',
    orderChangeDate: '2026-11-02 10:05:00',
    payments: { orderPaymentType: 'prepaid', orderCurrency: { currencyId: 'PLN', orderProductsCost: 24.6, orderDeliveryCost: 12.99, orderPayformCost: 0 } },
    prepaids: [],
    dispatch: { courierName: 'InPost Paczkomaty' },
    productsResults: [{ productId: 10, sizeId: 'uniw', productQuantity: 2, productOrderPrice: 12.3, productVat: 23, productName: 'Przyprawa', productCode: 'SKU-10', basketPosition: 1 }],
    ...det,
  },
  ...top,
})
const map = (det = {}, top = {}) => idosellOrderFromApi(wiersz(det, top), { strefa: 'Europe/Warsaw' })

describe('idosell: mapowanie zamówienia', () => {
  it('statusy → cykl życia; nieznany = otwarte bez kolejności z ostrzeżeniem', () => {
    expect(map({ orderStatus: 'new' })).toMatchObject({ lifecycle: 'OPEN', statusRank: 10, channelStatus: 'new' })
    expect(map({ orderStatus: 'packed_ready' })).toMatchObject({ lifecycle: 'OPEN', statusRank: 35 })
    expect(map({ orderStatus: 'finished' })).toMatchObject({ lifecycle: 'FULFILLED' })
    expect(map({ orderStatus: 'canceled' })).toMatchObject({ lifecycle: 'CANCELLED' })
    expect(map({ orderStatus: 'joined' })).toMatchObject({ lifecycle: 'CANCELLED' })
    expect(map({ orderStatus: { orderStatus: 'on_order' } })).toMatchObject({ lifecycle: 'OPEN', channelStatus: 'on_order' }) // starszy kształt (OIP)
    const n = map({ orderStatus: 'cosnowego' })
    expect(n).toMatchObject({ lifecycle: 'OPEN', statusRank: null })
    expect(n.warnings.join(' ')).toContain('nieznany status IdoSell')
  })

  it('kwoty, waluta, pozycja (oferta z rozmiarem), numer zamówienia i NIP tylko jako tak/nie', () => {
    const o = map({ productsResults: [{ productId: 20, sizeId: 'M', productQuantity: 1, productOrderPrice: 30, productVat: 8, productSizeCodeExternal: 'SKU-20-M', basketPosition: 3 }] }, { clientResult: { clientBillingAddress: { clientNip: PII_SENTINELS[4] } } })
    expect(o).toMatchObject({ externalId: '500', number: 'sklep-1-500', totalGross: 37.59, currency: 'PLN', shippingCostGross: 12.99, deliveryMethod: 'InPost Paczkomaty', wantInvoiceNip: true })
    expect(o.lines).toEqual([{ externalLineId: '3', offerExternalId: '20/M', qty: 1, unitPriceGross: 30, vatRate: '8', sku: 'SKU-20-M' }])
    expect(map().lines[0]!.offerExternalId).toBe('10')
    expect(map().wantInvoiceNip).toBe(false)
    for (const p of PII_SENTINELS) expect(JSON.stringify(o)).not.toContain(p)
  })

  it('płatność: pobranie, zaksięgowane wpłaty (pełna, częściowa, zwrot), niepotwierdzona = nieopłacone', () => {
    expect(map({ payments: { orderPaymentType: 'cash_on_delivery', orderCurrency: { orderProductsCost: 10, currencyId: 'PLN' } } }).paymentState).toBe('COD')
    const pay = (prepaids: unknown[]) => map({ prepaids }).paymentState
    expect(pay([{ paymentStatus: 'y', paymentType: 'payment', paymentValue: 37.59, payformName: 'Przelewy24' }])).toBe('PAID')
    expect(pay([{ paymentStatus: 'y', paymentType: 'advance', paymentValue: 10 }])).toBe('PARTIAL')
    expect(pay([{ paymentStatus: 'y', paymentType: 'payment', paymentValue: 37.59 }, { paymentStatus: 'y', paymentType: 'repayment', paymentValue: 37.59 }])).toBe('UNPAID')
    expect(pay([{ paymentStatus: 'n', paymentType: 'payment', paymentValue: 37.59 }])).toBe('UNPAID')
    expect(map({ prepaids: [{ paymentStatus: 'y', paymentType: 'payment', paymentValue: 37.59, payformName: 'Przelewy24' }] }).paymentMethod).toBe('Przelewy24')
    expect(map().paymentMethod).toBe('Przedpłata')
  })

  it('rewizja: data zmiany w UTC + opłacone; opłacenie przy tej samej dacie daje nowszą', () => {
    const unpaid = map().revision
    const paid = map({ prepaids: [{ paymentStatus: 'y', paymentType: 'payment', paymentValue: 37.59 }] }).revision
    expect(unpaid).toBe('2026-11-02T09:05:00.000Z#0')
    expect(paid > unpaid).toBe(true)
    expect(map({ orderChangeDate: '' }).revision).toBe('2026-11-02T09:00:00.000Z#0')
  })

  it('nieczytelne = UnreadableDataError, nigdy 0: ilość ułamkowa, zero, tekst; cena; kwota; brak pozycji; zła data; brak numeru', () => {
    const line = (over: Record<string, unknown>) => () => map({ productsResults: [{ productId: 10, productQuantity: 1, productOrderPrice: 1, ...over }] })
    expect(line({ productQuantity: 1.5 })).toThrow(UnreadableDataError)
    expect(line({ productQuantity: 0 })).toThrow(UnreadableDataError)
    expect(line({ productQuantity: 'abc' })).toThrow(UnreadableDataError)
    expect(line({ productOrderPrice: '' })).toThrow(UnreadableDataError)
    expect(line({ productId: 'x' })).toThrow(UnreadableDataError)
    expect(line({ sizeId: '../x' })).toThrow(UnreadableDataError)
    expect(() => map({ payments: { orderCurrency: { orderProductsCost: 'abc' } } })).toThrow(UnreadableDataError)
    expect(() => map({ productsResults: [] })).toThrow(UnreadableDataError)
    expect(() => map({ orderAddDate: '02.11.2026' })).toThrow(UnreadableDataError)
    expect(() => map({ orderChangeDate: 'wczoraj' })).toThrow(UnreadableDataError)
    expect(() => map({}, { orderSerialNumber: null })).toThrow(UnreadableDataError)
  })

  it('kwoty netto i zestaw: ostrzeżenia', () => {
    expect(map({ payments: { orderWorthCalculateType: 'net', orderCurrency: { currencyId: 'PLN', orderProductsCost: 1 } } }).warnings.join(' ')).toContain('netto')
    expect(map({ productsResults: [{ productId: 10, productQuantity: 1, productOrderPrice: 1, bundleId: 77 }] }).warnings.join(' ')).toContain('zestawu')
  })
})

// ─── Oferty ──────────────────────────────────────────────────────────────────

describe('idosell: oferty', () => {
  it('produkt z rozmiarami: oferta na rozmiar, SKU i EAN rozmiaru, stan z magazynu konta, nazwa po polsku', async () => {
    const { at, adapter } = make({ config: { magazyn: 2 } })
    at.products.clear()
    at.putProduct(20, [
      { sizeId: 'S', qty: 3, code: 'SKU-20-S', ean: '5901234123457' },
      { sizeId: 'M', qty: 4, code: 'SKU-20-M', ean: 'nie-ean' },
    ])
    for (const s of at.products.get(20)!.sizes) s.stocks = new Map([[1, 99], [2, s.sizeId === 'S' ? 3 : 4]])
    const p = await adapter.listOffers(null)
    expect(p.items).toEqual([
      { externalId: '20/M', sku: 'SKU-20-M', ean: null, name: 'Przyprawa testowa 20', qty: 4, active: true, priceGross: 19.9, vatRate: '23', imageUrls: ['https://cdn.example.invalid/20.jpg'] },
      { externalId: '20/S', sku: 'SKU-20-S', ean: '5901234123457', name: 'Przyprawa testowa 20', qty: 3, active: true, priceGross: 19.9, vatRate: '23', imageUrls: ['https://cdn.example.invalid/20.jpg'] },
    ])
  })

  it('lista ofert bez resultsNumberPage czytana do niepełnej strony', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 }, atrapa: { bezLiczbyStron: true, pustaJako404: false } })
    at.putProduct(14) // produkty 10–14: strony 2 + 2 + 1
    const ids: string[] = []
    let cur: string | null = null
    let strony = 0
    do {
      const p = await adapter.listOffers(cur)
      ids.push(...p.items.map((x) => x.externalId))
      cur = p.nextCursor
      strony++
    } while (cur !== null && strony < 20)
    expect(ids).toEqual(['10', '11', '12', '13', '14'])
    expect(strony).toBe(3)
  })

  it('rozmiar bez wpisu w magazynie konta = nieczytelny (nie 0); produkt bez danych magazynu = bez stanu (null); niewidoczny = nieaktywny', () => {
    const base = { productId: 30, productIsVisible: 'n', productSizesAttributes: [{ sizeId: 'uniw' }] }
    expect(idosellOffersFromApi(base, 1).rows[0]).toMatchObject({ externalId: '30', qty: null, active: false })
    const r = idosellOffersFromApi({ ...base, productStocksData: { productStocksQuantities: [{ stockId: 2, productSizesData: [{ sizeId: 'uniw', productSizeQuantity: 5 }] }] } }, 1)
    expect(r.rows).toEqual([])
    expect(r.problems[0]).toMatchObject({ externalId: '30', message: expect.stringMatching(/magazynie 1/) })
    expect(idosellOffersFromApi({ ...base, productStocksData: { productStocksQuantities: [{ stockId: 1, productSizesData: [{ sizeId: 'uniw', productSizeQuantity: 2.5 }] }] } }, 1).problems).toHaveLength(1)
  })

  it('identyfikator oferty: produkt prosty = numer, wariant = numer/rozmiar; zły format = null', () => {
    expect(parseOfferId('10')).toEqual({ productId: 10, sizeId: 'uniw' })
    expect(parseOfferId('20/M')).toEqual({ productId: 20, sizeId: 'M' })
    expect(parseOfferId('20/../x')).toBeNull()
    expect(parseOfferId('abc')).toBeNull()
  })
})

// ─── Zapis ───────────────────────────────────────────────────────────────────

describe('idosell: zapis stanów i statusów', () => {
  const zapisowy = (config: Record<string, unknown> = { zapisWlaczony: true }) => make({ key: ZAPIS, config })

  it('bez zapisWlaczony: zero żądań (także odczytu) i TRWALY z powodem; klucz tylko do odczytu nie ma zapisu', async () => {
    for (const config of [{}, { zapisWlaczony: false }]) {
      const { at, adapter } = make({ key: ZAPIS, config: config as Record<string, unknown> })
      expect(await adapter.pushStock!([{ offerExternalId: '10', qty: 1 }], 'r1')).toEqual({ kind: 'TRWALY', reference: 'r1', message: ZAPIS_WYLACZONY })
      expect(await adapter.setOrderStatus!('1', 'packed', 'r2')).toEqual({ kind: 'TRWALY', reference: 'r2', message: ZAPIS_WYLACZONY })
      expect(at.log).toEqual([])
    }
    const ro = make()
    expect(hasStockWriter(ro.adapter)).toBe(false)
    expect(hasOrderStatusWriter(ro.adapter)).toBe(false)
  })

  it('stan: PUT products/stocks z operacją „set” w magazynie konta, rozmiary jednego produktu w jednym wpisie; powtórka = ten sam stan', async () => {
    const { at, adapter } = zapisowy({ zapisWlaczony: true, magazyn: 3 })
    at.putProduct(20, [{ sizeId: 'S', qty: 1 }, { sizeId: 'M', qty: 1 }])
    const items = [{ offerExternalId: '20/S', qty: 5 }, { offerExternalId: '20/M', qty: 0 }, { offerExternalId: '10', qty: 2 }]
    expect(await adapter.pushStock!(items, 'ref-a')).toEqual({ kind: 'OK', reference: 'ref-a' })
    expect(await adapter.pushStock!(items, 'ref-a')).toEqual({ kind: 'OK', reference: 'ref-a' })
    expect(at.stockOf(20, 'S', 3)).toBe(5)
    expect(at.stockOf(20, 'M', 3)).toBe(0)
    expect(at.stockOf(10, 'uniw', 3)).toBe(2)
    const w = at.writes()
    expect(w).toHaveLength(2)
    expect(w[0]!.path).toBe('products/stocks')
    expect(w[0]!.body).toEqual({
      params: {
        products: [
          {
            ident: { identType: 'id', identValue: '20' },
            sizes: [
              { ident: { identType: 'id', identValue: 'S' }, quantity: { stocks: [{ stock_id: 3, quantity_operation: { operation: 'set', quantity: 5 } }] } },
              { ident: { identType: 'id', identValue: 'M' }, quantity: { stocks: [{ stock_id: 3, quantity_operation: { operation: 'set', quantity: 0 } }] } },
            ],
          },
          { ident: { identType: 'id', identValue: '10' }, sizes: [{ ident: { identType: 'id', identValue: 'uniw' }, quantity: { stocks: [{ stock_id: 3, quantity_operation: { operation: 'set', quantity: 2 } }] } }] },
        ],
      },
    })
  })

  it('207 z błędem jednego rozmiaru i nieznany produkt: wynik per oferta, reszta zapisana', async () => {
    const { at, adapter } = zapisowy()
    at.putProduct(20, [{ sizeId: 'S', qty: 1 }, { sizeId: 'M', qty: 1 }])
    at.injectWriteFailure('CZESCIOWY')
    const out = await adapter.pushStock!([{ offerExternalId: '20/S', qty: 5 }, { offerExternalId: '20/M', qty: 6 }, { offerExternalId: '777', qty: 1 }, { offerExternalId: 'zly/../', qty: 1 }], 'ref-b')
    expect(out.kind).toBe('TRWALY')
    if (out.kind === 'OK') throw new Error('oczekiwany błąd')
    expect(out.failedItems?.map((f) => [f.offerExternalId, f.kind])).toEqual([
      ['zly/../', 'TRWALY'],
      ['20/S', 'TRWALY'],
      ['777', 'TRWALY'],
    ])
    expect(at.stockOf(20, 'M')).toBe(6)
    expect(JSON.stringify(out)).not.toContain(PII_SENTINELS[1])
  })

  it('rozmiar bez wpisu w odpowiedzi przy isSizesErrors = PRZEJSCIOWY; bez flagi błędów = zapisany', async () => {
    for (const [f, oczekiwane] of [['BRAK_ROZMIARU', [['20/S', 'PRZEJSCIOWY']]], ['BRAK_ROZMIARU_BEZ_BLEDOW', []]] as const) {
      const { at, adapter } = zapisowy()
      at.putProduct(20, [{ sizeId: 'S', qty: 1 }, { sizeId: 'M', qty: 1 }])
      at.injectWriteFailure(f)
      const out = await adapter.pushStock!([{ offerExternalId: '20/S', qty: 5 }, { offerExternalId: '20/M', qty: 6 }], `ref-${f}`)
      if (!oczekiwane.length) {
        expect(out.kind).toBe('OK')
        continue
      }
      if (out.kind === 'OK') throw new Error('oczekiwany błąd')
      expect(out.kind).toBe('PRZEJSCIOWY')
      expect(out.failedItems?.map((x) => [x.offerExternalId, x.kind])).toEqual(oczekiwane)
      expect(out.failedItems?.[0]?.message).toMatch(/brak wyniku rozmiaru/)
    }
  })

  it('429 = PRZEJSCIOWY z czasem ponowienia; następne paczki nie wychodzą', async () => {
    const { at, adapter } = zapisowy()
    for (let i = 100; i < 250; i++) at.putProduct(i)
    at.injectWriteFailure('LIMIT')
    const items = Array.from({ length: 150 }, (_, i) => ({ offerExternalId: String(100 + i), qty: 1 }))
    const out = await adapter.pushStock!(items, 'ref-c')
    expect(out).toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 30_000 })
    if (out.kind === 'OK') throw new Error('oczekiwany błąd')
    expect(out.failedItems).toHaveLength(150)
    expect(at.writes()).toHaveLength(1) // druga paczka (50 rozmiarów) czeka na następny przebieg
    const r = await executeWrite(adapter, 'ref-c', () => adapter.pushStock!(items, 'ref-c'))
    expect(r.kind).toBe('OK')
  })

  it('5xx i zerwane połączenie po wysłaniu = PRZEJSCIOWY (zapis bezwzględny); 422 i 401 = TRWALY', async () => {
    const { at, adapter } = zapisowy()
    const items = [{ offerExternalId: '10', qty: 4 }]
    for (const [f, kind] of [['PRZEJSCIOWY', 'PRZEJSCIOWY'], ['SIEC', 'PRZEJSCIOWY'], ['TRWALY', 'TRWALY']] as const) {
      at.injectWriteFailure(f)
      expect((await executeWrite(adapter, 'r', () => adapter.pushStock!(items, 'r'))).kind, f).toBe(kind)
    }
    const zly = make({ key: ZAPIS, config: { zapisWlaczony: true }, secrets: { IDOSELL_API_KEY: 'inny' } })
    expect((await zly.adapter.pushStock!(items, 'r')).kind).toBe('TRWALY')
  })

  it('status: odczyt, zapis tylko przy zmianie; zamknięte w sklepie i cofnięcie bez zapisu; nieznany status = TRWALY bez żądania', async () => {
    const { at, adapter } = zapisowy()
    at.putOrder({ externalId: '7', state: 'open', offer: '10', qty: 1, createdAt: NOW, modifiedAt: NOW })
    expect(await adapter.setOrderStatus!('7', 'packed', 's1')).toEqual({ kind: 'OK', reference: 's1' })
    expect(at.statusOf('7')).toBe('packed')
    expect(at.writes()[0]!.body).toEqual({ params: { orders: [{ orderSerialNumber: 7, orderStatus: 'packed' }] } })
    expect(await adapter.setOrderStatus!('7', 'packed', 's2')).toMatchObject({ kind: 'OK', externalRef: 'bez-zmian:packed' })
    expect(await adapter.setOrderStatus!('7', 'new', 's3')).toMatchObject({ kind: 'OK', externalRef: 'bez-zmian:packed' }) // bez cofania
    at.putOrder({ externalId: '8', state: 'cancelled', offer: '10', qty: 1, createdAt: NOW, modifiedAt: NOW })
    expect(await adapter.setOrderStatus!('8', 'finished', 's4')).toMatchObject({ kind: 'OK', externalRef: 'bez-zmian:canceled' })
    expect(at.writes()).toHaveLength(1)
    const n = at.log.length
    expect((await adapter.setOrderStatus!('7', 'wysłane', 's5')).kind).toBe('TRWALY')
    expect((await adapter.setOrderStatus!('7', 'canceled', 's6', { onlyIfUnpaid: true })).kind).toBe('TRWALY')
    expect(at.log.length).toBe(n)
  })

  it('status: 429 przy zapisie = PRZEJSCIOWY z czasem ponowienia; 5xx = PRZEJSCIOWY, a powtórka nie wysyła drugiego zapisu po udanym', async () => {
    const { at, adapter } = zapisowy()
    at.putOrder({ externalId: '9', state: 'open', offer: '10', qty: 1, createdAt: NOW, modifiedAt: NOW })
    at.injectWriteFailure('LIMIT')
    expect(await adapter.setOrderStatus!('9', 'ready', 's1')).toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 30_000 })
    at.injectWriteFailure('PRZEJSCIOWY')
    expect((await adapter.setOrderStatus!('9', 'ready', 's1')).kind).toBe('PRZEJSCIOWY')
    expect((await adapter.setOrderStatus!('9', 'ready', 's1')).kind).toBe('OK')
    expect((await adapter.setOrderStatus!('9', 'ready', 's1')).kind).toBe('OK')
    expect(at.writes()).toHaveLength(3) // 429, 503, udany; czwarte wywołanie tylko czyta
  })
})

// ─── Pomoc i kreator ─────────────────────────────────────────────────────────

describe('idosell: kafel w kreatorze i Pomoc', () => {
  it('kafel „IdoSell” zakłada wersję z zapisem (zapis startuje wyłączony) i linkuje do istniejącej strony Pomocy', async () => {
    const { platformaZAdresu } = await import('../kanaly/platformy')
    const { docFiles, dozwolony, slugOf } = await import('../pomoc/dokumenty')
    const p = platformaZAdresu(defaultRegistry(), { platforma: 'idosell' })!
    expect(p).toMatchObject({ channel: 'IDOSELL', nazwa: 'IdoSell', adapterKey: ZAPIS, pomoc: '/pomoc/integracje-idosell' })
    expect(docFiles()).toContain('integracje/idosell.md')
    expect(slugOf('integracje/idosell.md')).toBe('integracje-idosell')
    expect(dozwolony('integracje-idosell')).toBe(true)
  })
})
