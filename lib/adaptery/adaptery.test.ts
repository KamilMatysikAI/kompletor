// Testy kontraktu adaptera: suita kontraktowa dla fałszywego adaptera, Woo i Mirakla (API w pamięci za
// prawdziwym klientem HTTP adaptera), mapowania, rejestr, zapis z czterema wynikami. Dane zmyślone; „osobowe”
// wartości to znaczniki PII_SENTINELS — sprawdzamy, że nie wychodzą z adaptera.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHANNEL_ADAPTER } from '../adaptery'
import type { FetchLike } from '../zrodla/http'
import { withEnvInputs } from './konta'
import { AdapterError, type AdapterDefinition, hasOrderFeed, readNumber, UnreadableDataError } from './kontrakt'
import { FakeChannelState, fakeDefinition, fakeOrder } from './falszywy'
import { MIRAKL_EMPIK_DEFINITION, miraklOrderFromApi } from './mirakl-empik'
import { AdapterConfigError, AdapterRegistry, deriveReference, manifestProblems, rodzinaAdaptera } from './rejestr'
import { type ContractHarness, filtrujPolaWp, PII_SENTINELS, runAdapterContract, type SeedOffer, type SeedOrder } from './suita-kontraktowa'
import { WOO_DEFINITION, wooOrderFromApi } from './woo'
import { executeWrite, mayRetry } from './zapis'
import { defaultRegistry } from './domyslne'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const ACC = { organizationId: 'test_a', kind: 'channel' as const, id: 'WOO/sd', channel: 'WOO' as const, channelAccountId: 'sd', name: 'Sklep testowy' }
const FAST = { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

// ─── Uprząż: fałszywy adapter ────────────────────────────────────────────────

const fakeHarness: ContractHarness = {
  name: 'fake.v1',
  now: NOW,
  setup() {
    const state = new FakeChannelState()
    const def = fakeDefinition(state, 'WOO', 'fake.v1', { recipient: true })
    const adapter = new AdapterRegistry([def]).create('fake.v1', { integration: ACC, rawConfig: {}, rawSecrets: {}, fetch, now: () => NOW })
    return {
      adapter,
      putOrder: (o: SeedOrder) => {
        state.recipients.set(o.externalId, { dostawa: null, punktOdbioru: null, faktura: null, problemy: ['adres_niedostepny_w_kanale'] })
        state.upsertOrder(
          fakeOrder({
            externalId: o.externalId,
            revision: o.modifiedAt.toISOString(),
            createdAt: o.createdAt,
            lifecycle: o.state === 'open' ? 'OPEN' : o.state === 'cancelled' ? 'CANCELLED' : 'FULFILLED',
            lines: [{ externalLineId: '1', offerExternalId: o.offer, qty: o.qty, unitPriceGross: 10, vatRate: null }],
          }),
        )
      },
      corruptOrder: (id) => state.corrupted.add(id),
      corruptRecipient: (id) => state.corruptedRecipients.add(id),
      failNextList: (kind) => state.listFailures.push(new AdapterError('awaria testowa', kind)),
      injectWriteFailure: (f) => state.writeFailures.push(f),
    }
  },
}

// ─── Uprząż: WooCommerce REST w pamięci ──────────────────────────────────────

const iso19 = (d: Date) => d.toISOString().slice(0, 19)

function wooRaw(o: SeedOrder): Record<string, unknown> {
  const status = o.state === 'open' ? 'processing' : o.state === 'cancelled' ? 'cancelled' : 'completed'
  return {
    id: Number(o.externalId),
    status,
    currency: 'PLN',
    date_created_gmt: iso19(o.createdAt),
    date_modified_gmt: iso19(o.modifiedAt),
    date_paid_gmt: o.state === 'cancelled' ? null : iso19(o.createdAt),
    total: (o.qty * 12.3).toFixed(2),
    payment_method: 'blik',
    payment_method_title: 'BLIK',
    billing: { first_name: PII_SENTINELS[0], email: PII_SENTINELS[1], phone: PII_SENTINELS[2], address_1: PII_SENTINELS[3] },
    shipping: { first_name: PII_SENTINELS[0], address_1: PII_SENTINELS[3] },
    customer_note: PII_SENTINELS[4],
    meta_data: [{ key: '_billing_nip', value: PII_SENTINELS[4] }],
    line_items: [{ id: Number(o.externalId) * 10, product_id: Number(o.offer), variation_id: 0, quantity: o.qty, total: (o.qty * 10).toFixed(2), total_tax: (o.qty * 2.3).toFixed(2), meta_data: [] }],
    shipping_lines: [{ method_title: 'Paczkomaty InPost' }],
  }
}

function wooHarness(pageSize = 2): ContractHarness {
  return {
    name: `woo.rest.v1 (WC REST w pamięci, strona ${pageSize})`,
    now: NOW,
    setup() {
      const store = new Map<string, Record<string, unknown>>()
      const products = new Map<string, Record<string, unknown>>()
      const methods: string[] = []
      let fail: number | null = null
      const fetchImpl: FetchLike = async (url, init) => {
        methods.push(init?.method ?? 'GET')
        const u = new URL(url)
        expect(u.origin).toBe('https://sklep.example')
        const path = u.pathname.replace(/^\/wp-json\/wc\/v3/, '')
        if (path === '/products') {
          // produkty sklepu (oferty), stronami jak /orders
          const per = Number(u.searchParams.get('per_page') ?? 10)
          const page = Number(u.searchParams.get('page') ?? 1)
          const all = [...products.values()]
          const pages = Math.max(1, Math.ceil(all.length / per))
          return json(all.slice((page - 1) * per, page * per), 200, { 'x-wp-total': String(all.length), 'x-wp-totalpages': String(pages) })
        }
        if (path === '/settings/products/woocommerce_hold_stock_minutes') return json({ id: 'woocommerce_hold_stock_minutes', value: '60' })
        if (path === '/orders') {
          if (fail) {
            const s = fail
            fail = null
            return new Response('awaria', { status: s })
          }
          const after = u.searchParams.get('modified_after')
          // dziennik: daty w GMT; test połączenia czyta ostatnie zamówienia bez filtra daty
          if (after) expect(u.searchParams.get('dates_are_gmt')).toBe('true')
          const per = Number(u.searchParams.get('per_page') ?? 10)
          const page = Number(u.searchParams.get('page') ?? 1)
          const all = [...store.values()]
            .filter((o) => !after || String(o['date_modified_gmt']) > after)
            .sort((a, b) => String(a['date_modified_gmt']).localeCompare(String(b['date_modified_gmt'])))
          const pages = Math.max(1, Math.ceil(all.length / per))
          // `_fields` jak w WordPressie (test połączenia prosi o `id,meta_data`)
          return json(filtrujPolaWp(all.slice((page - 1) * per, page * per), u.searchParams.get('_fields')), 200, { 'x-wp-total': String(all.length), 'x-wp-totalpages': String(pages) })
        }
        const m = /^\/orders\/(\d+)$/.exec(path)
        if (m) {
          const o = store.get(m[1]!)
          return o ? json(o) : json({ code: 'woocommerce_rest_shop_order_invalid_id' }, 404)
        }
        return json({ code: 'rest_no_route' }, 404)
      }
      const adapter = defaultRegistry().create('woo.rest.v1', {
        integration: ACC,
        rawConfig: { baseUrl: 'https://sklep.example', pageSize },
        rawSecrets: { WOO_CONSUMER_KEY: 'ck_test', WOO_CONSUMER_SECRET: 'cs_test' },
        fetch: fetchImpl,
        now: () => NOW,
        http: FAST,
      })
      return {
        adapter,
        putOrder: (o) => store.set(o.externalId, wooRaw(o)),
        corruptOrder: (id) => {
          const o = store.get(id)!
          ;(o['line_items'] as Record<string, unknown>[])[0]!['quantity'] = 'abc'
        },
        corruptRecipient: (id) => {
          ;(store.get(id)!['billing'] as Record<string, unknown>)['phone'] = [PII_SENTINELS[2]]
        },
        failNextList: (kind) => (fail = kind === 'PRZEJSCIOWY' ? 503 : 401),
        requests: () => methods,
        putOffer: (o: SeedOffer) =>
          products.set(o.externalId, {
            id: Number(o.externalId),
            name: o.name,
            type: 'simple',
            status: 'publish',
            sku: o.sku ?? '',
            manage_stock: o.qty !== null,
            stock_quantity: o.qty,
            description: PII_SENTINELS.join(' '), // pole nieczytane przez adapter
            meta_data: [{ key: '_ean', value: '5901234123457' }],
          }),
        corruptOffer: (id) => {
          products.get(id)!['stock_quantity'] = 'abc'
        },
      }
    },
  }
}

// ─── Uprząż: Mirakl OR11 w pamięci ───────────────────────────────────────────

function miraklRaw(o: SeedOrder): Record<string, unknown> {
  const state = o.state === 'open' ? 'SHIPPING' : o.state === 'cancelled' ? 'CANCELED' : 'SHIPPED'
  return {
    order_id: o.externalId,
    order_state: state,
    created_date: o.createdAt.toISOString(),
    last_updated_date: o.modifiedAt.toISOString(),
    total_price: o.qty * 12.3,
    currency_iso_code: 'PLN',
    shipping_type_label: 'Kurier DPD',
    payment_type: 'Empik',
    customer: { firstname: PII_SENTINELS[0], email: PII_SENTINELS[1], billing_address: { street_1: PII_SENTINELS[3], phone: PII_SENTINELS[2] } },
    order_lines: [{ order_line_id: `${o.externalId}-1`, product_sku: o.offer, offer_sku: 'SKU-T', quantity: o.qty, price_unit: 12.3, price: o.qty * 12.3, order_line_state: state }],
  }
}

function miraklHarness(pageSize = 2): ContractHarness {
  return {
    name: `mirakl.empik.v1 (OR11 w pamięci, strona ${pageSize})`,
    now: NOW,
    setup() {
      const store = new Map<string, Record<string, unknown>>()
      const offers = new Map<string, Record<string, unknown>>()
      const methods: string[] = []
      let fail: number | null = null
      const fetchImpl: FetchLike = async (url, init) => {
        methods.push(init?.method ?? 'GET')
        const u = new URL(url)
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('klucz-test')
        if (u.pathname === '/api/offers') {
          // OF21 stronami (max/offset)
          const max = Number(u.searchParams.get('max') ?? 10)
          const offset = Number(u.searchParams.get('offset') ?? 0)
          const all = [...offers.values()]
          return json({ offers: all.slice(offset, offset + max), total_count: all.length })
        }
        if (u.pathname !== '/api/orders') return json({ message: 'nie ma' }, 404)
        if (fail) {
          const s = fail
          fail = null
          return new Response('awaria', { status: s })
        }
        const ids = u.searchParams.get('order_ids')
        if (ids) return json({ orders: ids.split(',').map((i) => store.get(i)).filter(Boolean), total_count: 1 })
        const from = u.searchParams.get('start_update_date')
        const max = Number(u.searchParams.get('max') ?? 10)
        const offset = Number(u.searchParams.get('offset') ?? 0)
        const all = [...store.values()].filter((o) => !from || String(o['last_updated_date']) >= from).sort((a, b) => String(a['created_date']).localeCompare(String(b['created_date'])))
        return json({ orders: all.slice(offset, offset + max), total_count: all.length })
      }
      const adapter = defaultRegistry().create('mirakl.empik.v1', {
        integration: { ...ACC, id: 'EMPIK/empik', channel: 'EMPIK', channelAccountId: 'empik' },
        rawConfig: { baseUrl: 'https://empik.example/api', pageSize },
        rawSecrets: { MIRAKL_API_KEY: 'klucz-test' },
        fetch: fetchImpl,
        now: () => NOW,
        http: FAST,
      })
      return {
        adapter,
        putOrder: (o) => store.set(o.externalId, miraklRaw(o)),
        corruptOrder: (id) => {
          store.get(id)!['total_price'] = 'abc' // pozycje anulowanego są pomijane, więc psujemy kwotę zamówienia
        },
        corruptRecipient: (id) => {
          ;(store.get(id)!['customer'] as Record<string, unknown>)['shipping_address'] = [PII_SENTINELS[3]]
        },
        failNextList: (kind) => (fail = kind === 'PRZEJSCIOWY' ? 503 : 401),
        requests: () => methods,
        putOffer: (o: SeedOffer) =>
          offers.set(o.externalId, {
            offer_id: Number(o.externalId) + 9000,
            product_sku: o.externalId,
            shop_sku: o.sku,
            product_title: o.name,
            active: true,
            quantity: o.qty, // null = bez stanu (jawne null; brak pola albo „abc” = nieczytelne)
            product_references: [{ reference_type: 'EAN', reference: '5901234123457' }],
            shop: { name: PII_SENTINELS[0] },
          }),
        corruptOffer: (id) => {
          offers.get(id)!['quantity'] = 'abc'
        },
      }
    },
  }
}

runAdapterContract(fakeHarness)
runAdapterContract(wooHarness(2))
runAdapterContract(wooHarness(100))
runAdapterContract(miraklHarness(2))
runAdapterContract(miraklHarness(100))

// ─── Mapowanie Woo ───────────────────────────────────────────────────────────

describe('woo: mapowanie zamówienia', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    ...wooRaw({ externalId: '500', state: 'open', offer: '77', qty: 1, createdAt: NOW, modifiedAt: NOW }),
    ...over,
  })

  it('statusy → cykl życia i kolejność; nieznany status = otwarte z ostrzeżeniem', () => {
    const cases: [string, string, number | null][] = [
      ['pending', 'OPEN', 10],
      ['on-hold', 'OPEN', 10],
      ['processing', 'OPEN', 20],
      ['completed', 'FULFILLED', 30],
      ['cancelled', 'CANCELLED', null],
      ['failed', 'OPEN', 10],
      ['refunded', 'CANCELLED', null],
      ['checkout-draft', 'DRAFT', null],
    ]
    for (const [s, life, rank] of cases) expect(wooOrderFromApi(base({ status: s })), s).toMatchObject({ lifecycle: life, statusRank: rank })
    const u = wooOrderFromApi(base({ status: 'wc-wyslane-inpost' }))
    expect(u).toMatchObject({ lifecycle: 'OPEN', statusRank: null })
    expect(u.warnings.join(' ')).toContain('nieznany status')
  })

  it('płatność: pobranie, opłacone (date_paid albo processing), nieopłacone on-hold', () => {
    expect(wooOrderFromApi(base({ payment_method: 'cod', status: 'processing' })).paymentState).toBe('COD')
    expect(wooOrderFromApi(base({ status: 'processing', date_paid_gmt: null })).paymentState).toBe('PAID')
    expect(wooOrderFromApi(base({ status: 'on-hold', date_paid_gmt: null, payment_method: 'bacs' })).paymentState).toBe('UNPAID')
  })

  it('nieudana płatność (failed, np. BLIK): otwarte i nieopłacone jak pending, nie anulowane', () => {
    const o = wooOrderFromApi(base({ status: 'failed', date_paid_gmt: null, payment_method: 'payublik' }))
    expect(o).toMatchObject({ lifecycle: 'OPEN', statusRank: 10, paymentState: 'UNPAID', channelStatus: 'failed' })
    expect(o.warnings.join(' ')).not.toContain('nieznany status')
  })

  it('pozycja: wariant „produkt/wariant”, cena brutto z podatkiem, produkt usunięty = brak oferty + ostrzeżenie', () => {
    const o = wooOrderFromApi(
      base({
        line_items: [
          { id: 1, product_id: 77, variation_id: 78, quantity: 2, total: '20.00', total_tax: '4.60' },
          { id: 2, product_id: 0, variation_id: 0, quantity: 1, total: '5.00', total_tax: '0' },
        ],
      }),
    )
    expect(o.lines[0]).toMatchObject({ externalLineId: '1', offerExternalId: '77/78', qty: 2, unitPriceGross: 12.3 })
    expect(o.lines[1]!.offerExternalId).toBeNull()
    expect(o.warnings.join(' ')).toContain('product_id 0')
  })

  it('ujemne fee_lines (rabat spoza pozycji) rozłożone na ceny pozycji; kupon WC zostaje w total pozycji', () => {
    const linie = [
      { id: 1, product_id: 77, variation_id: 0, quantity: 1, subtotal: '13.00', subtotal_tax: '2.99', total: '13.00', total_tax: '2.99' },
      { id: 2, product_id: 78, variation_id: 0, quantity: 3, subtotal: '19.50', subtotal_tax: '4.49', total: '19.50', total_tax: '4.49' },
    ]
    const o = wooOrderFromApi(base({ total: '36.97', line_items: linie, fee_lines: [{ id: 9, name: 'Rabat', total: '-3.25', total_tax: '-0.75' }] }))
    // 15,99 i 3 × 7,996 = 23,99 → 39,98; rabat 4,00 → × 35,98 / 39,98
    expect(o.lines.map((l) => l.unitPriceGross)).toEqual([14.39, 7.2])
    expect(o.totalGross).toBe(36.97)
    expect(o.warnings).toContain('rabat na zamówienie 4.00 zł (opłata ujemna) rozłożony na ceny pozycji')
    // opłata dodatnia (pobranie) i brak fee_lines: ceny bez zmian, bez ostrzeżenia
    const bez = wooOrderFromApi(base({ line_items: linie, fee_lines: [{ id: 9, name: 'Pobranie', total: '4.07', total_tax: '0.93' }] }))
    expect(bez.lines.map((l) => l.unitPriceGross)).toEqual([15.99, 8])
    expect(bez.warnings.join(' ')).not.toContain('rabat')
    expect(wooOrderFromApi(base({ line_items: linie })).lines.map((l) => l.unitPriceGross)).toEqual([15.99, 8])
    // rabat nie mniejszy niż pozycje: ceny bez zmian, ostrzeżenie (dokument stanie z problemem, nie zgadujemy)
    const caly = wooOrderFromApi(base({ line_items: linie, fee_lines: [{ id: 9, total: '-40.00', total_tax: '0' }] }))
    expect(caly.lines.map((l) => l.unitPriceGross)).toEqual([15.99, 8])
    expect(caly.warnings.join(' ')).toContain('większy niż 50% wartości pozycji')
    // nieczytelna opłata = błąd, nigdy 0
    expect(() => wooOrderFromApi(base({ line_items: linie, fee_lines: [{ id: 9, total: 'n/a' }] }))).toThrow(UnreadableDataError)
    expect(() => wooOrderFromApi(base({ line_items: linie, fee_lines: 'x' }))).toThrow(UnreadableDataError)
  })

  it('numer zamówienia z wtyczki numeracji (inny niż id) — do łączenia z BL; równy id → brak', () => {
    expect(wooOrderFromApi(base({ number: '158405' })).number).toBe('158405')
    expect(wooOrderFromApi(base({ number: '500' })).number).toBeNull()
    expect(wooOrderFromApi(base({ number: 'BH/10/2026/500' })).number).toBe('BH/10/2026/500')
  })

  it('daty GMT bez strefy → UTC; rewizja jako ISO; metoda dostawy; faktura na NIP bez zapisu wartości', () => {
    const o = wooOrderFromApi(base({ date_created_gmt: '2026-10-25T09:15:00', date_modified_gmt: '2026-10-25T09:20:00' }))
    expect(o.createdAt.toISOString()).toBe('2026-10-25T09:15:00.000Z')
    expect(o.revision).toBe('2026-10-25T09:20:00.000Z')
    expect(o.deliveryMethod).toBe('Paczkomaty InPost')
    expect(o.wantInvoiceNip).toBe(true)
    expect(JSON.stringify(o)).not.toContain(PII_SENTINELS[4])
  })

  it('nieczytelne dane = błąd, nigdy 0', () => {
    expect(() => wooOrderFromApi(base({ total: 'n/a' }))).toThrow(UnreadableDataError)
    expect(() => wooOrderFromApi(base({ line_items: [{ id: 1, product_id: 1, quantity: 0, total: '1' }] }))).toThrow(UnreadableDataError)
    expect(() => wooOrderFromApi(base({ line_items: 'x' }))).toThrow(UnreadableDataError)
    expect(() => wooOrderFromApi(base({ date_created_gmt: 'wczoraj' }))).toThrow(UnreadableDataError)
    expect(() => readNumber('', 'x')).toThrow(UnreadableDataError)
  })
})

// ─── Mapowanie Mirakl ────────────────────────────────────────────────────────

describe('mirakl: mapowanie zamówienia', () => {
  const base = (over: Record<string, unknown> = {}) => ({ ...miraklRaw({ externalId: 'E-1', state: 'open', offer: 'P1', qty: 2, createdAt: NOW, modifiedAt: NOW }), ...over })

  it('stany → cykl życia, płatność; STAGING = szkic', () => {
    expect(miraklOrderFromApi(base({ order_state: 'WAITING_ACCEPTANCE' }))).toMatchObject({ lifecycle: 'OPEN', paymentState: 'UNPAID', statusRank: 10 })
    expect(miraklOrderFromApi(base({ order_state: 'WAITING_DEBIT_PAYMENT' }))).toMatchObject({ lifecycle: 'OPEN', paymentState: 'UNPAID' })
    expect(miraklOrderFromApi(base({ order_state: 'SHIPPING' }))).toMatchObject({ lifecycle: 'OPEN', paymentState: 'PAID', statusRank: 30 })
    expect(miraklOrderFromApi(base({ order_state: 'CLOSED' }))).toMatchObject({ lifecycle: 'FULFILLED' })
    expect(miraklOrderFromApi(base({ order_state: 'REFUSED' }))).toMatchObject({ lifecycle: 'CANCELLED' })
    expect(miraklOrderFromApi(base({ order_state: 'STAGING' }))).toMatchObject({ lifecycle: 'DRAFT' })
    const u = miraklOrderFromApi(base({ order_state: 'NOWY_STAN' }))
    expect(u).toMatchObject({ lifecycle: 'OPEN', statusRank: null })
    expect(u.warnings.join(' ')).toContain('nieznany stan')
  })

  it('pozycje odrzucone pominięte; oferta = product_sku; cena jednostkowa', () => {
    const o = miraklOrderFromApi(
      base({
        order_lines: [
          { order_line_id: 'a', product_sku: 'P1', quantity: 2, price_unit: 15.5, order_line_state: 'SHIPPING' },
          { order_line_id: 'b', product_sku: 'P2', quantity: 1, price_unit: 9, order_line_state: 'REFUSED' },
        ],
      }),
    )
    expect(o.lines).toEqual([{ externalLineId: 'a', offerExternalId: 'P1', qty: 2, unitPriceGross: 15.5, vatRate: null }])
    expect(o.warnings.join(' ')).toContain('REFUSED')
    expect(o.deliveryMethod).toBe('Kurier DPD')
  })

  it('nieczytelne dane = błąd', () => {
    expect(() => miraklOrderFromApi(base({ total_price: null }))).toThrow(UnreadableDataError)
    expect(() => miraklOrderFromApi(base({ order_lines: [{ order_line_id: 'a', product_sku: 'P', quantity: 'x', price_unit: 1 }] }))).toThrow(UnreadableDataError)
  })
})

// ─── Rejestr, konfiguracja, sekrety ──────────────────────────────────────────

describe('rejestr adapterów', () => {
  it('domyślny rejestr: woo, empik, allegro, basecourier, allegro.wysylam, shoper, prestashop, inpost.shipx, dpd.services, ksef.fa3, allegro.zapis i allegro.wysylam.zapis, basecourier.zapis, orlenpaczka, pocztapolska.enadawca, idosell.admin i idosell.admin.zapis; poprawne manifesty, zapis tylko w kluczach .zapis.', () => {
    const r = defaultRegistry()
    // pełna lista (dodatkowy, przypadkowy adapter w rejestrze ma wywrócić test)
    expect(r.list().map((m) => m.adapterKey).sort()).toEqual(['allegro.v1', 'allegro.wysylam.v1', 'allegro.wysylam.zapis.v1', 'allegro.zapis.v1', 'basecourier.v1', 'basecourier.zapis.v1', 'dpd.services.v1', 'dpd.services.zapis.v1', 'gls.ade.v1', 'gls.ade.zapis.v1', 'idosell.admin.v1', 'idosell.admin.zapis.v1', 'inpost.shipx.v1', 'inpost.shipx.zapis.v1', 'ksef.fa3.v1', 'mirakl.empik.v1', 'mirakl.empik.zapis.v1', 'orlenpaczka.v1', 'orlenpaczka.zapis.v1', 'pocztapolska.enadawca.v1', 'pocztapolska.enadawca.zapis.v1', 'prestashop.ws.v1', 'prestashop.ws.zapis.v1', 'shoper.rest.v1', 'shoper.rest.zapis.v1', 'woo.rest.v1', 'woo.rest.zapis.v1'])
    for (const m of r.list()) {
      expect(manifestProblems(m)).toEqual([])
      // /083: zapis tylko w kluczu „….zapis.v1” (za wyłącznikiem konta), nigdy jako domyślny adapter kanału
      if (/\.zapis\.v\d+$/.test(m.adapterKey)) expect(Object.values(DEFAULT_CHANNEL_ADAPTER)).not.toContain(m.adapterKey)
      expect(m.readOnly, m.adapterKey).toBe(!/\.zapis\.v\d+$/.test(m.adapterKey))
      // /083/090: adapter z zapisem tylko z wyłącznikiem w konfiguracji (domyślnie wyłączony: pole nie jest wymagane)
      if (!m.readOnly) expect(m.config.find((f) => f.key === 'zapisWlaczony')).toMatchObject({ type: 'boolean', required: false })
    }
  })

  it('każdy X.zapis.vN ma w rejestrze X.vN tylko do odczytu, tego samego kanału i rodzaju, z tymi samymi zdolnościami odczytu', () => {
    const r = defaultRegistry()
    // zdolności, które ma tylko wersja z zapisem (zapis, odszukanie zapisu, wynik zapisu); reszta identyczna w obu wersjach
    // shipment.track tylko w wersji z zapisem (śledzi przesyłki, które utworzyła ta wersja; sam odczyt)
    // offers.publish (wystawienie oferty) tylko w wersji z zapisem; offers.prepare (sam odczyt) w obu
    const tylkoZapis = new Set(['stock.write', 'order.status.write', 'order.accept', 'order.tracking.write', 'shipment.create', 'shipment.cancel', 'invoice.issue', 'invoice.correct', 'stock.import.status', 'reference.find', 'shipment.track', 'offers.publish'])
    const zapisowe = r.list().filter((m) => /\.zapis\.v\d+$/.test(m.adapterKey))
    expect(zapisowe.length).toBeGreaterThan(0)
    for (const m of zapisowe) {
      const odczyt = r.get(rodzinaAdaptera(m.adapterKey))
      expect(odczyt, m.adapterKey).toBeDefined()
      expect(odczyt!.manifest.readOnly, m.adapterKey).toBe(true)
      expect(odczyt!.manifest.channel, m.adapterKey).toBe(m.channel)
      expect(odczyt!.manifest.kind, m.adapterKey).toBe(m.kind)
      const odczytZapisowej = m.capabilities.filter((c) => !tylkoZapis.has(c)).sort()
      expect(odczytZapisowej, m.adapterKey).toEqual([...odczyt!.manifest.capabilities].sort())
    }
  })

  it('nieznany klucz, inna rodzina kanału, brak sekretu, zły adres → AdapterConfigError (bez wartości sekretów)', () => {
    const r = defaultRegistry()
    const input = { integration: ACC, rawConfig: { baseUrl: 'https://sklep.example' }, rawSecrets: { WOO_CONSUMER_KEY: 'ck_tajne' }, fetch }
    expect(() => r.create('nie.ma.v1', input)).toThrow(AdapterConfigError)
    expect(() => r.create('mirakl.empik.v1', input)).toThrow(/kanału EMPIK/)
    try {
      r.create('woo.rest.v1', input)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterConfigError)
      expect((e as Error).message).toContain('WOO_CONSUMER_SECRET')
      expect((e as Error).message).not.toContain('ck_tajne')
    }
    expect(() => r.create('woo.rest.v1', { ...input, rawConfig: { baseUrl: 'http://bez-tls.example' }, rawSecrets: { WOO_CONSUMER_KEY: 'a', WOO_CONSUMER_SECRET: 'b' } })).toThrow(/baseUrl ma zły format/)
  })

  it('manifest: zły klucz, odczyt z zapisem, zdublowany sekret → odrzucony przy rejestracji', () => {
    const def = fakeDefinition(new FakeChannelState())
    const bad: AdapterDefinition = { ...def, manifest: { ...def.manifest, adapterKey: 'Zły-Klucz', readOnly: true, secrets: [def.manifest.secrets[0]!, def.manifest.secrets[0]!] } }
    // zły klucz + zdublowany sekret + odczyt z zapisem: stock.write, order.status.write, order.tracking.write
    expect(manifestProblems(bad.manifest).length).toBe(5)
    expect(() => new AdapterRegistry([bad])).toThrow(AdapterConfigError)
    const r = new AdapterRegistry([def])
    expect(() => r.register(def)).toThrow(/już jest/)
  })

  it('konfiguracja: typy i tylko pola z manifestu', () => {
    const r = defaultRegistry()
    expect(() =>
      r.create('woo.rest.v1', { integration: ACC, rawConfig: { baseUrl: 'https://s.example', pollIntervalSec: 'co minutę' }, rawSecrets: { WOO_CONSUMER_KEY: 'a', WOO_CONSUMER_SECRET: 'b' }, fetch }),
    ).toThrow(/pollIntervalSec nie jest liczbą/)
  })

  it('self-host: ustawienia i klucze konta z env po przedrostku; bez zgody na env — nic; baza wygrywa', () => {
    const env = { SD_WC_URL: 'https://sklep.example', SD_WC_KEY: 'k', SD_WC_SECRET: 's', WOO_CONSUMER_KEY: 'obcy' }
    const cfg = { envPrefix: 'SD_WC' }
    const yes = withEnvInputs(WOO_DEFINITION.manifest, cfg, {}, { env, envFallback: true })
    expect(yes.rawConfig['baseUrl']).toBe('https://sklep.example')
    expect(yes.rawSecrets).toEqual({ WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's' })
    const no = withEnvInputs(WOO_DEFINITION.manifest, cfg, {}, { env, envFallback: false })
    expect(no.rawSecrets).toEqual({})
    expect(no.rawConfig['baseUrl']).toBeUndefined()
    const db = withEnvInputs(WOO_DEFINITION.manifest, { ...cfg, baseUrl: 'https://z-bazy.example' }, { WOO_CONSUMER_KEY: 'z-bazy' }, { env, envFallback: true })
    expect(db.rawConfig['baseUrl']).toBe('https://z-bazy.example')
    expect(db.rawSecrets['WOO_CONSUMER_KEY']).toBe('z-bazy')
    const mk = withEnvInputs(MIRAKL_EMPIK_DEFINITION.manifest, { envPrefix: 'EMPIK_MIRAKL' }, {}, {
      env: { EMPIK_MIRAKL_BASE_URL: 'https://e.example/api', EMPIK_MIRAKL_API_KEY: 'x' },
      envFallback: true,
    })
    expect(mk).toEqual({ rawConfig: { envPrefix: 'EMPIK_MIRAKL', baseUrl: 'https://e.example/api' }, rawSecrets: { MIRAKL_API_KEY: 'x' } })
  })

  it('referencja zapisu: deterministyczna, w formacie UUID, różna dla innych części', () => {
    const a = deriveReference(['acme', 'WOO/sd', 'oferta-1', 7, 1])
    expect(a).toBe(deriveReference(['acme', 'WOO/sd', 'oferta-1', 7, 1]))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a).not.toBe(deriveReference(['acme', 'WOO/sd', 'oferta-1', 7, 2]))
    expect(deriveReference(['a|b', 'c'])).not.toBe(deriveReference(['a', 'b|c']))
    expect(() => deriveReference([])).toThrow()
  })
})

describe('zapis: cztery wyniki', () => {
  const setup = () => {
    const state = new FakeChannelState()
    const a = new AdapterRegistry([fakeDefinition(state)]).create('fake.v1', { integration: ACC, rawConfig: {}, rawSecrets: {}, fetch })
    return { state, a: a as typeof a & { pushStock: (i: { offerExternalId: string; qty: number }[], r: string) => Promise<never> } }
  }

  it('nieznany wyjątek = NIEJEDNOZNACZNY → odszukanie: nie wykonany → PRZEJSCIOWY (wolno ponowić)', async () => {
    const { state, a } = setup()
    state.writeFailures.push('WYJATEK')
    const o = await executeWrite(a, 'r1', () => a.pushStock([{ offerExternalId: '1', qty: 1 }], 'r1'))
    expect(o.kind).toBe('PRZEJSCIOWY')
    expect(mayRetry(o)).toBe(true)
  })

  it('bez zdolności odszukania niejednoznaczny zostaje niejednoznaczny (człowiek, bez ponowienia)', async () => {
    const a = new AdapterRegistry([fakeDefinition(new FakeChannelState(), 'WOO', 'fake.v1', { readOnly: true })]).create('fake.v1', { integration: ACC, rawConfig: {}, rawSecrets: {}, fetch })
    const o = await executeWrite(a, 'r1', async () => {
      throw new AdapterError('timeout po wysłaniu', 'NIEJEDNOZNACZNY')
    })
    expect(o.kind).toBe('NIEJEDNOZNACZNY')
    expect(mayRetry(o)).toBe(false)
  })

  it('wynik z inną referencją niż zlecona = NIEJEDNOZNACZNY → odszukanie', async () => {
    const { a } = setup()
    const o = await executeWrite(a, 'r9', async () => ({ kind: 'OK', reference: 'inna' }))
    expect(o.kind).toBe('PRZEJSCIOWY')
  })

  it('adapter tylko do odczytu nie przechodzi strażnika zapisu', () => {
    const state = new FakeChannelState()
    const a = new AdapterRegistry([fakeDefinition(state, 'WOO', 'fake.v1', { readOnly: true })]).create('fake.v1', { integration: ACC, rawConfig: {}, rawSecrets: {}, fetch })
    expect(hasOrderFeed(a)).toBe(true)
    expect(a.manifest.capabilities).not.toContain('stock.write')
  })
})

describe('woo: stronicowanie po kluczu', () => {
  it('zamówienie zmienione w trakcie odczytu stron nie wypycha innego z odczytu', async () => {
    const x = wooHarness(2).setup()
    const t0 = new Date(NOW.getTime() - 3600_000)
    const at = (m: number) => new Date(t0.getTime() + m * 60_000)
    for (let i = 1; i <= 5; i++) x.putOrder({ externalId: String(200 + i), state: 'open', offer: '10', qty: 1, createdAt: t0, modifiedAt: at(i) })
    const a = x.adapter
    if (!hasOrderFeed(a)) throw new Error('bez orders.feed')
    const seen = new Set<string>()
    const p1 = await a.listOrderChanges(null, { initialLookbackMs: 24 * 3600_000 })
    p1.items.forEach((i) => seen.add(i.externalId))
    expect(p1.hasMore).toBe(true)
    // 201 zmienione między stronami → przeskakuje na koniec listy (przy numerach stron 203 wypadłoby z odczytu)
    x.putOrder({ externalId: '201', state: 'cancelled', offer: '10', qty: 1, createdAt: t0, modifiedAt: at(30) })
    let cur = p1.nextCursor
    for (let i = 0; i < 10; i++) {
      const p = await a.listOrderChanges(cur, { initialLookbackMs: 24 * 3600_000 })
      p.items.forEach((it) => seen.add(it.externalId))
      cur = p.nextCursor
      if (!p.hasMore) break
    }
    expect([...seen].sort()).toEqual(['201', '202', '203', '204', '205'])
  })
})

describe('poprawki po przeglądzie', () => {
  it('Mirakl — incydenty i oczekiwanie na zwrot są po wysyłce (FULFILLED), REFUNDED zostaje anulowane', () => {
    const raw = (state: string) => miraklRaw({ externalId: 'E-9', state: 'open', offer: 'P1', qty: 1, createdAt: NOW, modifiedAt: NOW })
    for (const st of ['INCIDENT_OPEN', 'INCIDENT_CLOSED', 'WAITING_REFUND', 'WAITING_REFUND_PAYMENT']) {
      const o = miraklOrderFromApi({ ...raw(st), order_state: st })
      expect(o, st).toMatchObject({ lifecycle: 'FULFILLED', paymentState: 'PAID', statusRank: 55 })
      expect(o.warnings.join(' ')).not.toContain('nieznany')
    }
    expect(miraklOrderFromApi({ ...raw('x'), order_state: 'REFUNDED' }).lifecycle).toBe('CANCELLED')
  })

  it('faktura na NIP tylko z klucza meta „nip” jako słowa, nie z podciągu (np. _snippet_id)', () => {
    const base = wooRaw({ externalId: '700', state: 'open', offer: '1', qty: 1, createdAt: NOW, modifiedAt: NOW })
    expect(wooOrderFromApi({ ...base, meta_data: [{ key: '_snippet_id', value: '5' }] }).wantInvoiceNip).toBe(false)
    expect(wooOrderFromApi({ ...base, meta_data: [{ key: '_billing_nip', value: '123' }] }).wantInvoiceNip).toBe(true)
    expect(wooOrderFromApi({ ...base, meta_data: [{ key: 'nip', value: '123' }] }).wantInvoiceNip).toBe(true)
    expect(wooOrderFromApi({ ...base, meta_data: [{ key: '_billing_nip', value: '' }] }).wantInvoiceNip).toBe(false)
  })

  it('rodzaj integracji w manifeście; przewoźnik bez kanału; rejestr odrzuca zły rodzaj i kanał bez rodziny', () => {
    const def = fakeDefinition(new FakeChannelState())
    const carrier: AdapterDefinition = {
      manifest: { ...def.manifest, adapterKey: 'basecourier.v1', kind: 'carrier', channel: undefined, capabilities: [], readOnly: true, channelBehavior: undefined },
      create: (ctx) => ({ manifest: carrier.manifest, testConnection: async () => ({ ok: true, message: ctx.integration.id }) }),
    }
    expect(manifestProblems(carrier.manifest)).toEqual([])
    expect(manifestProblems({ ...def.manifest, channel: undefined })).toContain('adapter kanału bez rodziny kanału (channel)')
    expect(manifestProblems({ ...def.manifest, kind: 'magazyn' as never })[0]).toMatch(/nieznany rodzaj/)
    const r = new AdapterRegistry([def, carrier])
    expect(() => r.create('basecourier.v1', { integration: ACC, rawConfig: {}, rawSecrets: {}, fetch })).toThrow(/rodzaju carrier/)
    const ok = r.create('basecourier.v1', { integration: { organizationId: 'test_a', kind: 'carrier', id: 'basecourier', name: 'Base Courier' }, rawConfig: {}, rawSecrets: {}, fetch })
    expect(ok.manifest.kind).toBe('carrier')
  })

  it('kontekst niesie persistSecrets od hosta (OAuth), bez niego — brak', () => {
    let seen: unknown = 'nie wołano'
    const def = fakeDefinition(new FakeChannelState())
    const spy: AdapterDefinition = { manifest: def.manifest, create: (ctx) => ((seen = ctx.persistSecrets), def.create(ctx)) }
    const r = new AdapterRegistry([spy])
    r.create('fake.v1', { integration: ACC, rawConfig: {}, rawSecrets: {}, fetch })
    expect(seen).toBeUndefined()
    const writer = async () => {}
    r.create('fake.v1', { integration: ACC, rawConfig: {}, rawSecrets: {}, fetch, persistSecrets: writer })
    expect(seen).toBe(writer)
  })
})

// test połączenia Woo podaje nazwy kluczy meta z ostatnich zamówień (bez wartości)
describe('woo: nazwy pól zamówień w teście połączenia', () => {
  it('klucze z ostatnich zamówień z liczbą wystąpień, bez wartości (NIP z wartością testową nie wychodzi)', async () => {
    const x = wooHarness(2).setup()
    for (const id of ['101', '102']) x.putOrder({ externalId: id, state: 'open', offer: '10', qty: 1, createdAt: NOW, modifiedAt: NOW })
    const r = await x.adapter.testConnection()
    expect(r.ok).toBe(true)
    expect(r.orderMeta).toEqual({ sample: 2, keys: [{ key: '_billing_nip', orders: 2 }] })
    for (const p of PII_SENTINELS) expect(JSON.stringify(r)).not.toContain(p)
  })

  it('atrapa filtruje `_fields` jak WordPress z WooCommerce — samo `meta_data.key` pomija `meta_data`, `meta_data` daje całą', () => {
    const zam = [{ id: 1, billing: { email: 'x' }, meta_data: [{ id: 5, key: '_billing_nip', value: 'v' }] }]
    // prawdziwy WooCommerce nie zwraca `meta_data` wybranego tylko przez `meta_data.key` (tests/woo-prawdziwy/fields-wp.json)
    expect(filtrujPolaWp(zam, 'id,meta_data.key')).toEqual([{ id: 1 }])
    expect(filtrujPolaWp(zam, 'id,meta_data')).toEqual([{ id: 1, meta_data: [{ id: 5, key: '_billing_nip', value: 'v' }] }])
    expect(filtrujPolaWp(zam, 'billing.email')).toEqual([{ billing: { email: 'x' } }])
    expect(filtrujPolaWp(zam, null)).toBe(zam)
    // `break 2` w WP — pole podrzędne rodzica wybranego w całości kończy listę pól (`id` też odpada)
    expect(filtrujPolaWp([{ id: 1, key: 'k', meta_data: [] }], 'meta_data,meta_data.key,id')).toEqual([{ meta_data: [] }])
    expect(filtrujPolaWp([{ id: 1, key: 'k', meta_data: [] }], 'id,meta_data,meta_data.key')).toEqual([{ id: 1, meta_data: [] }])
  })

  it('test połączenia prosi o `id,meta_data` (sklep z filtrem WordPressa oddaje nazwy), bez danych odbiorcy', async () => {
    const zapytania: URL[] = []
    const zam = [
      { id: 2, billing: { email: PII_SENTINELS[1] }, meta_data: [{ id: 1, key: '_billing_nip', value: PII_SENTINELS[4] }, { id: 2, key: '_paczkomat_id', value: 'POZ01M' }] },
      { id: 1, billing: { email: PII_SENTINELS[1] }, meta_data: [{ id: 3, key: '_billing_nip', value: '' }] },
    ]
    const fetchImpl: FetchLike = async (url) => {
      const u = new URL(url)
      zapytania.push(u)
      const path = u.pathname.replace(/^\/wp-json\/wc\/v3/, '')
      if (path === '/orders') return json(filtrujPolaWp(zam.slice(0, Number(u.searchParams.get('per_page') ?? 10)), u.searchParams.get('_fields')), 200, { 'x-wp-total': '2', 'x-wp-totalpages': '1' })
      return json({ code: 'rest_no_route' }, 404)
    }
    const adapter = defaultRegistry().create('woo.rest.v1', {
      integration: ACC,
      rawConfig: { baseUrl: 'https://sklep.example' },
      rawSecrets: { WOO_CONSUMER_KEY: 'ck_test', WOO_CONSUMER_SECRET: 'cs_test' },
      fetch: fetchImpl,
      now: () => NOW,
      http: FAST,
    })
    const r = await adapter.testConnection()
    expect(r.ok).toBe(true)
    expect(r.orderMeta).toEqual({ sample: 2, keys: [{ key: '_billing_nip', orders: 2 }, { key: '_paczkomat_id', orders: 1 }] })
    expect(zapytania.find((u) => u.searchParams.get('per_page') === '10')?.searchParams.get('_fields')).toBe('id,meta_data')
    for (const p of [...PII_SENTINELS, 'POZ01M']) expect(JSON.stringify(r)).not.toContain(p)
  })
})
