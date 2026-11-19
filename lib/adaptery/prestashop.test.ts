// Testy adaptera PrestaShop na atrapie HTTP (tests/prestashop-atrapa.ts): suita kontraktowa dla obu
// kluczy i obu rozmiarów strony, mapowanie (flagi statusów, anulowane, nieznany status, pobranie, warianty), strefy
// czasowe, kształty odpowiedzi [NIEPEWNE], wyłącznik zapisu (0 żądań), PATCH/PUT wg wersji, XML z ucieczką znaków,
// zapis częściowo nieudany, zmiana statusu i lista ofert. Dane zmyślone; „osobowe” wartości to PII_SENTINELS.
import { describe, expect, it } from 'vitest'
import { ATRAPA_KEY, ATRAPA_URL, type AtrapaOpts, PrestaAtrapa } from '@/tests/prestashop-atrapa'
import { DEFAULT_CHANNEL_ADAPTER } from '../adaptery'
import { localToUtc } from '../zrodla/czas-lokalny'
import { ReadOnlyViolation } from '../zrodla/http'
import { prestaApiBase, prestaListOf, PrestaReadOnly, PrestaWriter, prestaXml, xmlEscape } from '../zrodla/prestashop'
import { defaultRegistry } from './domyslne'
import {
  AdapterError,
  type ChannelAdapter,
  hasOfferReader,
  hasOrderFeed,
  hasOrderStatusWriter,
  hasStockWriter,
  type OfferReader,
  type OrderFeed,
  type OrderStatusWriter,
  type StockWriter,
  UnreadableDataError,
} from './kontrakt'
import { prestaOrderFromApi, type PrestaSlowniki, utcToLocal, prestaZdjecie } from './prestashop'
import { AdapterConfigError } from './rejestr'
import { type ContractHarness, PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const ACC = { organizationId: 'test_a', kind: 'channel' as const, id: 'PRESTASHOP/demo', channel: 'PRESTASHOP' as const, channelAccountId: 'demo', name: 'Sklep demo' }
const FAST = { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 }
const LOOKBACK = { initialLookbackMs: 7 * 24 * 3600_000 }
const READ = 'prestashop.ws.v1'
const ZAPIS = 'prestashop.ws.zapis.v1'

type Full = ChannelAdapter & OrderFeed & OfferReader
type Writer = Full & StockWriter & OrderStatusWriter

function make(key: string, opts: AtrapaOpts = {}, config: Record<string, unknown> = {}, secret = ATRAPA_KEY) {
  const atrapa = new PrestaAtrapa(opts)
  const adapter = defaultRegistry().create(key, {
    integration: ACC,
    rawConfig: { baseUrl: ATRAPA_URL, ...config },
    rawSecrets: { PRESTASHOP_WS_KEY: secret },
    fetch: atrapa.fetch,
    now: () => NOW,
    http: FAST,
  })
  return { atrapa, adapter: adapter as Full, writer: adapter as Writer }
}

// ─── Suita kontraktowa ───────────────────────────────────────────────────────

function harness(key: string, pageSize: number): ContractHarness {
  return {
    name: `${key} (atrapa Webservice, strona ${pageSize})`,
    now: NOW,
    setup() {
      const { atrapa, adapter } = make(key, {}, { pageSize, ...(key === ZAPIS ? { zapisWlaczony: true } : {}) })
      return {
        adapter,
        putOrder: (o) => atrapa.putOrder(o),
        corruptOrder: (id) => atrapa.corruptOrder(id),
        failNextList: (kind) => atrapa.failNextList(kind),
        requests: () => atrapa.requests(),
        injectWriteFailure: (f) => {
          if (f !== 'PRZEJSCIOWY' && f !== 'TRWALY') throw new Error(`atrapa nie udaje ${f} (adapter bez reference.find)`)
          atrapa.injectWriteFailure(f)
        },
      }
    },
  }
}

runAdapterContract(harness(READ, 2))
runAdapterContract(harness(READ, 100))
runAdapterContract(harness(ZAPIS, 2))
runAdapterContract(harness(ZAPIS, 100))

// ─── Mapowanie (funkcja czysta) ──────────────────────────────────────────────

const flags = (paid = false, shipped = false, delivery = false) => ({ paid, shipped, delivery })
const SLOW: PrestaSlowniki = {
  statusy: new Map([
    ['1', flags()],
    ['2', flags(true)],
    ['4', flags(true, true, true)],
    ['5', flags(false, false, true)],
    ['6', flags()],
    ['7', flags(true)],
    ['8', flags()],
    ['42', flags(true)],
  ]),
  waluty: new Map([['1', 'PLN'], ['2', 'EUR']]),
  przewoznicy: new Map([['3', 'Kurier testowy']]),
}
const CFG = { strefa: 'Europe/Warsaw', statusyAnulowane: ['6', '7', '8'] }
const row = (over: Record<string, unknown> = {}) => ({
  id: '5001',
  product_id: '10',
  product_attribute_id: '0',
  product_quantity: '2',
  product_name: 'Przyprawa',
  product_reference: 'SKU-10',
  product_ean13: '',
  unit_price_tax_incl: '12.300000',
  ...over,
})
const raw = (over: Record<string, unknown> = {}) => ({
  id: '500',
  current_state: '2',
  module: 'ps_wirepayment',
  payment: 'Przelew bankowy',
  reference: 'XKBKNABJK',
  date_add: '2026-11-02 10:00:00',
  date_upd: '2026-11-02 10:05:00',
  id_currency: '1',
  id_carrier: '3',
  total_paid_tax_incl: '24.600000',
  total_paid_real: '24.600000',
  valid: '1',
  id_shop: '1',
  id_customer: '7',
  id_address_delivery: '9',
  note: PII_SENTINELS[4],
  gift_message: PII_SENTINELS[0],
  secure_key: 'tajne',
  associations: { order_rows: [row()] },
  ...over,
})
const map = (over: Record<string, unknown> = {}, cfg = CFG) => prestaOrderFromApi(raw(over), SLOW, cfg)

describe('prestashop: mapowanie zamówienia', () => {
  it('flagi statusu → cykl życia i kolejność: shipped/delivery = FULFILLED 30, paid = OPEN 20, reszta OPEN 10', () => {
    expect(map({ current_state: '1' })).toMatchObject({ lifecycle: 'OPEN', statusRank: 10, channelStatus: '1' })
    expect(map({ current_state: '2' })).toMatchObject({ lifecycle: 'OPEN', statusRank: 20 })
    expect(map({ current_state: '4' })).toMatchObject({ lifecycle: 'FULFILLED', statusRank: 30 })
    expect(map({ current_state: '5' })).toMatchObject({ lifecycle: 'FULFILLED', statusRank: 30 })
  })

  it('statusyAnulowane: domyślnie 6, 7, 8 → CANCELLED bez kolejności; lista z konfiguracji wygrywa nad flagami', () => {
    for (const s of ['6', '7', '8']) expect(map({ current_state: s }), s).toMatchObject({ lifecycle: 'CANCELLED', statusRank: null })
    const own = { ...CFG, statusyAnulowane: ['6', '42'] }
    expect(map({ current_state: '42' }, own)).toMatchObject({ lifecycle: 'CANCELLED', statusRank: null })
    expect(map({ current_state: '7' }, own)).toMatchObject({ lifecycle: 'OPEN', statusRank: 20 })
  })

  it('statusyAnulowane z konfiguracji konta (z odstępami); zły format odrzuca rejestr', async () => {
    const { atrapa, adapter } = make(READ, {}, { statusyAnulowane: '6, 2' })
    atrapa.putOrder({ externalId: '101', state: 'open', offer: '10', qty: 1, createdAt: new Date(NOW.getTime() - 3600_000), modifiedAt: new Date(NOW.getTime() - 3600_000) })
    expect((await adapter.getOrder('101'))!.lifecycle).toBe('CANCELLED')
    expect(() => make(READ, {}, { statusyAnulowane: '6;7' })).toThrow(/statusyAnulowane ma zły format/)
  })

  it('nieznany status = OPEN bez kolejności i z ostrzeżeniem', () => {
    const o = map({ current_state: '77' })
    expect(o).toMatchObject({ lifecycle: 'OPEN', statusRank: null })
    expect(o.warnings.join(' ')).toContain('nieznany status')
  })

  it('płatność: pobranie z nazwy modułu, opłacone z flagi paid, niedopłata, nieopłacone; metoda z payment albo module', () => {
    expect(map({ module: 'ps_cashondelivery', current_state: '1' }).paymentState).toBe('COD')
    expect(map({ module: 'codpro', current_state: '2' }).paymentState).toBe('COD')
    expect(map({ module: 'platnosc_pobranie', current_state: '1' }).paymentState).toBe('COD')
    expect(map({ current_state: '2' }).paymentState).toBe('PAID')
    expect(map({ current_state: '1', total_paid_real: '10.00' }).paymentState).toBe('PARTIAL')
    expect(map({ current_state: '1', total_paid_real: '0.000000' }).paymentState).toBe('UNPAID')
    expect(map({ payment: '', module: 'ps_checkpayment' }).paymentMethod).toBe('ps_checkpayment')
    expect(() => map({ current_state: '1', total_paid_real: 'abc' })).toThrow(UnreadableDataError)
  })

  it('pozycje: produkt prosty „10”, wariant „10/55”, produkt usunięty = brak oferty + ostrzeżenie; cena brutto', () => {
    const o = map({
      associations: {
        order_rows: [row(), row({ id: '5002', product_attribute_id: '55', product_quantity: '1', unit_price_tax_incl: '9.99' }), row({ id: '5003', product_id: '0' })],
      },
    })
    expect(o.lines[0]).toEqual({ externalLineId: '5001', offerExternalId: '10', qty: 2, unitPriceGross: 12.3, vatRate: null, name: 'Przyprawa', sku: 'SKU-10' })
    expect(o.lines[1]).toMatchObject({ offerExternalId: '10/55', qty: 1, unitPriceGross: 9.99 })
    expect(o.lines[2]!.offerExternalId).toBeNull()
    expect(o.warnings.join(' ')).toContain('product_id 0')
  })

  it('nieczytelne dane = UnreadableDataError, nigdy 0', () => {
    expect(() => map({ associations: { order_rows: [row({ product_quantity: 'abc' })] } })).toThrow(UnreadableDataError)
    expect(() => map({ associations: { order_rows: [row({ product_quantity: '0' })] } })).toThrow(UnreadableDataError)
    expect(() => map({ associations: { order_rows: [row({ unit_price_tax_incl: '' })] } })).toThrow(UnreadableDataError)
    expect(() => map({ associations: { order_rows: [] } })).toThrow(UnreadableDataError)
    expect(() => map({ associations: undefined })).toThrow(UnreadableDataError)
    expect(() => map({ total_paid_tax_incl: 'n/a' })).toThrow(UnreadableDataError)
    expect(() => map({ date_add: 'wczoraj' })).toThrow(UnreadableDataError)
    expect(() => map({ current_state: '' })).toThrow(UnreadableDataError)
  })

  it('numer = reference, waluta i przewoźnik ze słowników; brak = PLN / null z ostrzeżeniem; bez NIP i danych klienta', () => {
    const o = map({ id_currency: '2' })
    expect(o).toMatchObject({ externalId: '500', number: 'XKBKNABJK', currency: 'EUR', deliveryMethod: 'Kurier testowy', wantInvoiceNip: false, totalGross: 24.6 })
    const u = map({ id_currency: '9', id_carrier: '8' })
    expect(u).toMatchObject({ currency: 'PLN', deliveryMethod: null })
    expect(u.warnings.join(' ')).toMatch(/waluta.*PLN/)
    expect(u.warnings.join(' ')).toContain('przewoźnik')
    expect(map({ id_carrier: '0' })).toMatchObject({ deliveryMethod: null, warnings: [] })
    const j = JSON.stringify(o)
    for (const p of PII_SENTINELS) expect(j).not.toContain(p)
    expect(j).not.toContain('tajne')
  })
})

// ─── Strefy czasowe ──────────────────────────────────────────────────────────

describe('prestashop: daty sklepu bez strefy', () => {
  it('przejście czasu w Europe/Warsaw (25.10.2026 i 29.03.2026): przed i po zmianie poprawny offset', () => {
    expect(localToUtc('2026-10-25 01:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-10-24T23:30:00.000Z')
    expect(localToUtc('2026-10-25 03:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-10-25T02:30:00.000Z')
    expect(localToUtc('2026-03-29 01:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-03-29T00:30:00.000Z')
    expect(localToUtc('2026-03-29 03:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    // godzina podwójna (02:30 jesienią) — jedna z dwóch chwil, zawsze ta sama
    expect(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']).toContain(localToUtc('2026-10-25 02:30:00', 'Europe/Warsaw')!.toISOString())
    expect(localToUtc('2026-03-29 02:30:00', 'Europe/Warsaw')).not.toBeNull()
    expect(localToUtc('2026-11-02T10:00:00', 'UTC')!.toISOString()).toBe('2026-11-02T10:00:00.000Z')
    expect(localToUtc('02.11.2026 10:00', 'Europe/Warsaw')).toBeNull()
  })

  it('mapowanie i zapytanie w strefie sklepu; utcToLocal odwraca localToUtc', async () => {
    expect(map({ date_add: '2026-10-25 01:30:00', date_upd: '2026-10-25 03:30:00' })).toMatchObject({
      createdAt: new Date('2026-10-24T23:30:00.000Z'),
      revision: '2026-10-25T02:30:00.000Z',
    })
    expect(map({ date_add: '2026-11-02 10:00:00' }, { ...CFG, strefa: 'UTC' }).createdAt.toISOString()).toBe('2026-11-02T10:00:00.000Z')
    for (const iso of ['2026-10-24T23:30:00.000Z', '2026-10-25T02:30:00.000Z', '2026-07-01T00:00:00.000Z'])
      expect(localToUtc(utcToLocal(new Date(iso), 'Europe/Warsaw'), 'Europe/Warsaw')!.toISOString()).toBe(iso)
    const { atrapa, adapter } = make(READ)
    await adapter.listOrderChanges(null, { initialLookbackMs: 3600_000 })
    const q = atrapa.log[0]!.query
    expect(q.get('filter[date_upd]')).toBe('[2026-11-02 12:00:00,2026-11-03 13:00:00]') // 11:00Z i 12:00Z+1 dzień w CET
    expect(q.get('date')).toBe('1')
    expect(q.get('sort')).toBe('[date_upd_ASC,id_ASC]')
    expect(q.get('limit')).toBe('0,100')
    expect(q.get('display')).toBe('full')
    expect(q.get('output_format')).toBe('JSON')
  })

  it('zła strefa albo idShop = błąd konfiguracji przy tworzeniu adaptera', () => {
    expect(() => make(READ, {}, { strefa: 'Mars/Olympus' })).toThrow(AdapterConfigError)
    expect(() => make(READ, {}, { idShop: 1.5 })).toThrow(AdapterConfigError)
  })
})

// ─── Dziennik: kształty odpowiedzi i błędy ───────────────────────────────────

const ago = (min: number) => new Date(NOW.getTime() - min * 60_000)

describe('prestashop: dziennik zamówień', () => {
  it('pusta lista jako [] i jako { orders: [] } — koniec dziennika bez błędu', async () => {
    for (const pustaListaJakoTablica of [true, false]) {
      const { adapter } = make(READ, { pustaListaJakoTablica })
      const p = await adapter.listOrderChanges(null, LOOKBACK)
      expect(p).toMatchObject({ items: [], hasMore: false })
    }
    expect(prestaListOf([], 'orders')).toEqual([])
    expect(prestaListOf('', 'orders')).toEqual([])
    expect(prestaListOf({}, 'orders')).toEqual([])
    expect(prestaListOf([{ id: 1 }], 'orders')).toBeNull()
    expect(prestaListOf({ inne: [] }, 'orders')).toBeNull()
  })

  it('lista bez associations.order_rows: element bez zamówienia, z rewizją; getOrder daje pełne zamówienie', async () => {
    const { atrapa, adapter } = make(READ, { listaBezPozycji: true })
    atrapa.putOrder({ externalId: '101', state: 'open', offer: '10', qty: 2, createdAt: ago(60), modifiedAt: ago(50) })
    const p = await adapter.listOrderChanges(null, LOOKBACK)
    expect(p.items).toHaveLength(1)
    expect(p.items[0]!.order).toBeUndefined()
    expect(p.items[0]!.revision).toBe(new Date(Math.floor(ago(50).getTime() / 1000) * 1000).toISOString())
    const o = await adapter.getOrder('101')
    expect(o!.lines[0]).toMatchObject({ offerExternalId: '10', qty: 2 })
    expect(o!.revision).toBe(p.items[0]!.revision)
  })

  it('pojedynczy zasób jako { orders: [ … ] } też czytelny', async () => {
    const { atrapa, adapter } = make(READ, { pojedynczyJakoLista: true })
    atrapa.putOrder({ externalId: '101', state: 'fulfilled', offer: '11', qty: 1, createdAt: ago(60), modifiedAt: ago(50) })
    expect((await adapter.getOrder('101'))!.lifecycle).toBe('FULFILLED')
  })

  it('odpowiedź HTML zamiast JSON = trwały z tekstem o przepisywaniu adresów, bez treści strony', async () => {
    const { adapter } = make(READ, { html: true })
    const e = await adapter.listOrderChanges(null, LOOKBACK).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AdapterError)
    expect(e).toMatchObject({ kind: 'TRWALY' })
    expect((e as Error).message).toMatch(/przepisywanie adresów/)
    expect((e as Error).message).not.toContain('Strona sklepu')
    const t = await adapter.testConnection()
    expect(t.ok).toBe(false)
    expect(t.message).toMatch(/przepisywanie adresów/)
  })

  it('400 na filtrze dat = trwały „sklep nie obsługuje filtra dat”', async () => {
    const { adapter } = make(READ, { filtrDat400: true })
    await expect(adapter.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/nie obsługuje filtra dat/) })
  })

  it('sklep ignoruje filtr dat: wiersze spoza zakresu odrzucone, ostrzeżenie raz na odczyt', async () => {
    const { atrapa, adapter } = make(READ, { ignorujFiltrDat: true })
    atrapa.putOrder({ externalId: '90', state: 'open', offer: '10', qty: 1, createdAt: ago(40 * 1440), modifiedAt: ago(40 * 1440) })
    atrapa.putOrder({ externalId: '91', state: 'open', offer: '10', qty: 1, createdAt: ago(30 * 1440), modifiedAt: ago(30 * 1440) })
    atrapa.putOrder({ externalId: '101', state: 'open', offer: '10', qty: 1, createdAt: ago(60), modifiedAt: ago(50) })
    const p = await adapter.listOrderChanges(null, LOOKBACK)
    expect(p.items.map((i) => i.externalId)).toEqual(['101'])
    expect(p.warnings).toHaveLength(1)
    expect(p.warnings![0]).toMatch(/2 zamówień spoza zakresu/)
  })

  it('cała strona w jednej sekundzie: kolejny offset zamiast zapętlenia; duble odsiewa host', async () => {
    const { atrapa, adapter } = make(READ, {}, { pageSize: 2 })
    for (let i = 1; i <= 5; i++) atrapa.putOrder({ externalId: String(200 + i), state: 'open', offer: '10', qty: 1, createdAt: ago(60), modifiedAt: ago(30) })
    const seen = new Set<string>()
    let cur: string | null = null
    let pages = 0
    for (; pages < 20; pages++) {
      const p = await adapter.listOrderChanges(cur, LOOKBACK)
      p.items.forEach((i) => seen.add(i.externalId))
      cur = p.nextCursor
      if (!p.hasMore) break
    }
    expect([...seen].sort()).toEqual(['201', '202', '203', '204', '205'])
    expect(pages).toBeLessThan(5)
    expect(atrapa.log.filter((r) => r.path.endsWith('/orders')).map((r) => r.query.get('limit'))).toEqual(['0,2', '0,2', '2,2', '4,2']) // skok kluczem, potem offsety w tej sekundzie
  })

  it('słowniki: statusy raz na instancję, waluta i przewoźnik z pamięci; błąd przewoźnika = null + ostrzeżenie', async () => {
    const { atrapa, adapter } = make(READ, { bezPrawa: ['carriers'] })
    for (const id of ['101', '102', '103']) atrapa.putOrder({ externalId: id, state: 'open', offer: '10', qty: 1, createdAt: ago(60), modifiedAt: ago(50 - Number(id) + 100) })
    const p = await adapter.listOrderChanges(null, LOOKBACK)
    await adapter.getOrder('101')
    const paths = atrapa.paths()
    expect(paths.filter((x) => x.endsWith('/order_states'))).toHaveLength(1)
    expect(paths.filter((x) => x.endsWith('/currencies/1'))).toHaveLength(1)
    expect(p.items[0]!.order).toMatchObject({ currency: 'PLN', deliveryMethod: null })
    expect(p.items[0]!.order!.warnings.join(' ')).toContain('przewoźnik')
  })

  it('multistore: id_shop w każdym odczycie; adapter nie pyta o klientów ani adresy', async () => {
    const { atrapa, adapter } = make(READ, {}, { idShop: 1 })
    atrapa.putOrder({ externalId: '101', state: 'open', offer: '10', qty: 1, createdAt: ago(60), modifiedAt: ago(50) })
    const p = await adapter.listOrderChanges(null, LOOKBACK)
    await adapter.getOrder('101')
    await adapter.listOffers(null)
    await adapter.testConnection()
    expect(atrapa.log.length).toBeGreaterThan(5)
    for (const r of atrapa.log) expect(r.query.get('id_shop'), r.path).toBe('1')
    for (const x of atrapa.paths()) expect(x).not.toMatch(/customers|addresses/)
    expect(JSON.stringify(p)).not.toMatch(new RegExp(PII_SENTINELS.join('|')))
  })
})

// ─── Test połączenia ─────────────────────────────────────────────────────────

describe('prestashop: test połączenia', () => {
  it('wersja z nagłówka PSWS-Version i PATCH od 8; brak nagłówka = null', async () => {
    for (const [wersja, patch] of [['8.1.7', true], ['9.0.0', true], ['1.7.8.11', false], [null, false]] as const) {
      const { atrapa, adapter } = make(READ, { wersja })
      const t = await adapter.testConnection()
      expect(t, String(wersja)).toMatchObject({ ok: true, details: { wersja, patch } })
      expect(atrapa.paths()).toEqual(['GET /sklep/api/orders', 'GET /sklep/api/order_states', 'GET /sklep/api/stock_availables', 'GET /sklep/api/currencies', 'GET /sklep/api/carriers', 'GET /sklep/api/products', 'GET /sklep/api/combinations'])
      expect(atrapa.log.every((r) => r.query.get('display') === '[id]' && r.query.get('limit') === '1')).toBe(true)
    }
  })

  it('401 = komunikat o kluczu, 403 = którego zasobu brakuje; bez rzucania i bez klucza w treści', async () => {
    const bad = make(READ, {}, {}, 'ZLYKLUCZ0000000000000000000000000')
    const t1 = await bad.adapter.testConnection()
    expect(t1.ok).toBe(false)
    expect(t1.message).toMatch(/klucz Webservice odrzucony/)
    expect(t1.message).not.toContain('ZLYKLUCZ')
    const t2 = await make(READ, { bezPrawa: ['stock_availables'] }).adapter.testConnection()
    expect(t2).toMatchObject({ ok: false, message: expect.stringContaining('stock_availables') })
    // brak prawa do walut wychodzi w teście połączenia, a nie jako cichy PLN w zamówieniu
    const t3 = await make(READ, { bezPrawa: ['currencies'] }).adapter.testConnection()
    expect(t3).toMatchObject({ ok: false, message: expect.stringContaining('currencies') })
  })
})

// ─── Oferty i stany ──────────────────────────────────────────────────────────

describe('prestashop: lista ofert', () => {
  const seed = (a: PrestaAtrapa) => {
    a.putProduct('20', { reference: 'KOSZ', ean13: '5900000000200', idDefaultImage: '345', variants: [{ id: '201', reference: 'KOSZ-S', ean13: '5900000000201', qty: 3 }, { id: '202', qty: 4 }] })
    a.putProduct('21', { reference: 'NIEAKT', active: false, qty: 0 })
  }
  const all = async (adapter: Full) => {
    const items = []
    let cur: string | null = null
    for (let i = 0; i < 20; i++) {
      const p = await adapter.listOffers(cur)
      items.push(...p.items)
      cur = p.nextCursor
      if (cur === null) break
    }
    return items
  }

  it('produkty proste i warianty; wiersz z atrybutem 0 produktu z wariantami pominięty (suma wariantów)', async () => {
    const { atrapa, adapter } = make(READ)
    seed(atrapa)
    expect(hasOfferReader(adapter)).toBe(true)
    const items = await all(adapter)
    expect(items.map((i) => i.externalId)).toEqual(['10', '11', '12', '20/201', '20/202', '21'])
    expect(items.find((i) => i.externalId === '10')).toEqual({ externalId: '10', sku: 'SKU-10', ean: '5900000000010', name: null, qty: 5, active: true })
    expect(items.find((i) => i.externalId === '20/201')).toMatchObject({ sku: 'KOSZ-S', ean: '5900000000201', qty: 3, active: true })
    // główne zdjęcie produktu (także dla wariantów) z publicznego katalogu img/p
    expect(items.find((i) => i.externalId === '20/202')?.imageUrls).toEqual(['https://sklep.example.invalid/sklep/img/p/3/4/5/345.jpg'])
    expect(items.find((i) => i.externalId === '20/202')).toMatchObject({ sku: 'KOSZ', ean: null, qty: 4 })
    expect(items.find((i) => i.externalId === '21')).toMatchObject({ active: false, qty: 0 })
  })

  it('adres zdjęcia produktu z id_default_image (tylko https, zły id = brak)', () => {
    expect(prestaZdjecie('https://sklep.example/', '7')).toBe('https://sklep.example/img/p/7/7.jpg')
    expect(prestaZdjecie('https://sklep.example/pl', 1203)).toBe('https://sklep.example/pl/img/p/1/2/0/3/1203.jpg')
    expect(prestaZdjecie('https://sklep.example', '0')).toBeNull()
    expect(prestaZdjecie('https://sklep.example', '')).toBeNull()
    expect(prestaZdjecie('https://sklep.example', '../1')).toBeNull()
    expect(prestaZdjecie('http://sklep.example', '7')).toBeNull()
  })

  it('strona po 2: wiersz sumy na innej stronie niż warianty — rozpoznany przez filter[id_product]', async () => {
    const { atrapa, adapter } = make(READ, {}, { pageSize: 2 })
    seed(atrapa)
    const items = await all(adapter)
    expect(items.map((i) => i.externalId)).toEqual(['10', '11', '12', '20/201', '20/202', '21'])
    const lookups = atrapa.log.filter((r) => r.path.endsWith('/stock_availables') && r.query.has('filter[id_product]'))
    expect(lookups.map((r) => r.query.get('filter[id_product]'))).toContain('[12|20]')
    expect(atrapa.log.filter((r) => r.path.endsWith('/stock_availables') && !r.query.has('filter[id_product]')).map((r) => r.query.get('limit'))).toEqual(['0,2', '2,2', '4,2', '6,2'])
  })

  it('nieczytelny stan = błąd, nigdy 0; zły kursor = trwały', async () => {
    const { atrapa, adapter } = make(READ)
    atrapa.stockOf('11')!['quantity'] = 'dużo'
    await expect(adapter.listOffers(null)).rejects.toBeInstanceOf(UnreadableDataError)
    await expect(adapter.listOffers('-1')).rejects.toMatchObject({ kind: 'TRWALY' })
  })
})

// ─── Wyłącznik zapisu ────────────────────────────────────────────────────────

describe('prestashop: wyłącznik zapisu', () => {
  it('domyślny adapter kanału to wersja tylko do odczytu, bez zdolności zapisu', () => {
    expect(DEFAULT_CHANNEL_ADAPTER.PRESTASHOP).toBe(READ)
    const { adapter } = make(READ, {}, { zapisWlaczony: true }) // pole spoza manifestu: pominięte przez rejestr
    expect(adapter.manifest.readOnly).toBe(true)
    expect(hasStockWriter(adapter)).toBe(false)
    expect(hasOrderStatusWriter(adapter)).toBe(false)
    expect((adapter as Partial<StockWriter>).pushStock).toBeUndefined()
    expect((adapter as Partial<OrderStatusWriter>).setOrderStatus).toBeUndefined()
  })

  it('klucz z zapisem bez zapisWlaczony (brak albo false): TRWALY „zapis wyłączony”, 0 żądań', async () => {
    for (const cfg of [{}, { zapisWlaczony: false }, { zapisWlaczony: 'false' }]) {
      const { atrapa, writer } = make(ZAPIS, {}, cfg)
      expect(hasStockWriter(writer)).toBe(true)
      expect(hasOrderStatusWriter(writer)).toBe(true)
      expect(await writer.pushStock([{ offerExternalId: '10', qty: 1 }], 'ref-a')).toEqual({ kind: 'TRWALY', reference: 'ref-a', message: 'zapis wyłączony na tym koncie' })
      expect(await writer.setOrderStatus('101', '4', 'ref-b')).toEqual({ kind: 'TRWALY', reference: 'ref-b', message: 'zapis wyłączony na tym koncie' })
      expect(atrapa.log).toHaveLength(0)
    }
  })

  it('klienci: odczyt tylko GET, zapis tylko dozwolone ścieżki — inne = błąd przed wysłaniem', async () => {
    const atrapa = new PrestaAtrapa()
    const r = new PrestaReadOnly(ATRAPA_URL, ATRAPA_KEY, atrapa.fetch, 0)
    await expect(r.get('/orders', {}, { method: 'POST' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    const w = new PrestaWriter(ATRAPA_URL, ATRAPA_KEY, atrapa.fetch, 0)
    await expect(w.send('POST', '/orders', '<x/>')).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(w.send('PUT', '/order_histories', '<x/>')).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(w.send('PATCH', '/products/1', '<x/>')).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(w.getForPut('/orders/1')).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(atrapa.log).toHaveLength(0)
    expect(prestaApiBase('https://sklep.example/')).toBe('https://sklep.example/api')
    expect(prestaApiBase('https://example.invalid/sklep/api/')).toBe('https://example.invalid/sklep/api')
    expect(() => prestaApiBase('http://sklep.example')).toThrow(/https/)
  })
})

// ─── Zapis stanu ─────────────────────────────────────────────────────────────

describe('prestashop: zapis stanu', () => {
  const on = (opts: AtrapaOpts = {}, cfg: Record<string, unknown> = {}) => make(ZAPIS, opts, { zapisWlaczony: true, ...cfg })

  it('wersja 8 i 9: PATCH z id i quantity, bez PUT', async () => {
    for (const wersja of ['8.1.7', '9.0.0']) {
      const { atrapa, writer } = on({ wersja })
      expect(await writer.pushStock([{ offerExternalId: '10', qty: 7 }], 'r1')).toEqual({ kind: 'OK', reference: 'r1' })
      const w = atrapa.log.filter((r) => r.method !== 'GET')
      expect(w.map((r) => `${r.method} ${r.path}`)).toEqual(['PATCH /sklep/api/stock_availables/100'])
      expect(w[0]!.contentType).toBe('text/xml')
      expect(w[0]!.body).toMatch(/<stock_available><id>100<\/id><quantity>7<\/quantity><\/stock_available>/)
      expect(w[0]!.body).not.toContain('\n')
      expect(atrapa.stockOf('10')!['quantity']).toBe('7')
    }
  })

  it('wersja 1.7 albo nieznana: GET całego wiersza i PUT ze zmienionym quantity, bez PATCH', async () => {
    for (const wersja of ['1.7.8.11', null]) {
      const { atrapa, writer } = on({ wersja })
      expect((await writer.pushStock([{ offerExternalId: '11', qty: 0 }], 'r1')).kind).toBe('OK')
      const paths = atrapa.paths().filter((p) => p.includes('/stock_availables/'))
      expect(paths).toEqual(['GET /sklep/api/stock_availables/101', 'PUT /sklep/api/stock_availables/101'])
      expect(atrapa.log.find((r) => r.method === 'GET' && r.path.endsWith('/101'))!.query.get('display')).toBe('full')
      expect(atrapa.stockOf('11')).toMatchObject({ quantity: '0', out_of_stock: '2', depends_on_stock: '0' })
    }
  })

  it('PUT w 1.7 nie odsyła pól liczonych przez sklep (physical_quantity, reserved_quantity) —', async () => {
    const { atrapa, writer } = on({ wersja: '1.7.8.11' })
    Object.assign(atrapa.stockOf('11')!, { physical_quantity: '5', reserved_quantity: '2' })
    expect((await writer.pushStock([{ offerExternalId: '11', qty: 3 }], 'r1')).kind).toBe('OK')
    const put = atrapa.log.find((r) => r.method === 'PUT')!.body
    expect(put).toContain('<quantity>3</quantity>')
    expect(put).not.toMatch(/physical_quantity|reserved_quantity/)
  })

  it('odczyt i zapis dzielą jeden limiter tempa —', async () => {
    const atrapa = new PrestaAtrapa({ wersja: '1.7.8.11' })
    const czasy: number[] = []
    const fetchZCzasem: typeof atrapa.fetch = async (url, init) => {
      czasy.push(Date.now())
      return atrapa.fetch(url, init)
    }
    const writer = defaultRegistry().create(ZAPIS, {
      integration: ACC,
      rawConfig: { baseUrl: ATRAPA_URL, zapisWlaczony: true },
      rawSecrets: { PRESTASHOP_WS_KEY: ATRAPA_KEY },
      fetch: fetchZCzasem,
      now: () => NOW,
      http: { ...FAST, minIntervalMs: 80 },
    }) as Writer
    expect((await writer.pushStock([{ offerExternalId: '11', qty: 1 }], 'r1')).kind).toBe('OK')
    expect(atrapa.paths().filter((x) => x.includes('stock_availables'))).toHaveLength(3) // GET listy, GET wiersza, PUT
    for (let i = 1; i < czasy.length; i++) expect(czasy[i]! - czasy[i - 1]!).toBeGreaterThanOrEqual(70)
  })

  it('znaki < i & w polach wiersza nie psują XML przy PUT', async () => {
    const { atrapa, writer } = on({ wersja: '1.7.8.11' })
    atrapa.stockOf('12')!['location'] = 'Regał <A> & "B"'
    expect((await writer.pushStock([{ offerExternalId: '12', qty: 9 }], 'r1')).kind).toBe('OK')
    expect(atrapa.stockOf('12')).toMatchObject({ quantity: '9', location: 'Regał <A> & "B"' })
    expect(atrapa.log.find((r) => r.method === 'PUT')!.body).toContain('Regał &lt;A&gt; &amp; &quot;B&quot;')
    expect(xmlEscape('a<b&c')).toBe('a&lt;b&amp;c')
    expect(() => prestaXml('stock_available', [['zła nazwa', 1]])).toThrow()
  })

  it('wariant: wiersz po produkcie i atrybucie; brak wiersza albo dwa wiersze = pozycja trwale nieudana', async () => {
    const { atrapa, writer } = on()
    atrapa.putProduct('20', { variants: [{ id: '201', qty: 3 }] })
    expect((await writer.pushStock([{ offerExternalId: '20/201', qty: 1 }], 'r1')).kind).toBe('OK')
    expect(atrapa.stockOf('20', '201')!['quantity']).toBe('1')
    const lookup = atrapa.log.find((r) => r.query.get('filter[id_product_attribute]') === '[201]')!
    expect(lookup.query.get('filter[id_product]')).toBe('[20]')
    // drugi sklep (multistore) z tym samym produktem: bez idShop dwa wiersze → TRWALY, z idShop — jeden
    atrapa.stock.set('900', { ...atrapa.stockOf('10')!, id: 900, id_shop: 2 })
    expect(await writer.pushStock([{ offerExternalId: '10', qty: 1 }], 'r2')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('10') })
    expect((await writer.pushStock([{ offerExternalId: '999', qty: 1 }], 'r3')).kind).toBe('TRWALY')
    expect((await writer.pushStock([{ offerExternalId: 'abc', qty: 1 }], 'r4')).kind).toBe('TRWALY')
    const shop1 = make(ZAPIS, {}, { zapisWlaczony: true, idShop: 1 })
    shop1.atrapa.stock.set('900', { ...shop1.atrapa.stockOf('10')!, id: 900, id_shop: 2 })
    expect((await shop1.writer.pushStock([{ offerExternalId: '10', qty: 1 }], 'r5')).kind).toBe('OK')
  })

  it('paczka częściowo nieudana: wszystkie pozycje idą, wynik = najgorszy rodzaj z liczbą i ofertami; referencja bez zmian', async () => {
    const { atrapa, writer } = on()
    atrapa.injectWriteFailure('PRZEJSCIOWY')
    const o = await writer.pushStock([{ offerExternalId: '11', qty: 1 }, { offerExternalId: '10', qty: 2 }, { offerExternalId: '999', qty: 1 }], 'paczka-1')
    expect(o).toMatchObject({ kind: 'TRWALY', reference: 'paczka-1' })
    expect((o as { message: string }).message).toMatch(/^2 z 3 pozycji nieudanych: 11, 999$/)
    expect(atrapa.stockOf('10')!['quantity']).toBe('2')
    atrapa.injectWriteFailure('PRZEJSCIOWY')
    expect(await writer.pushStock([{ offerExternalId: '11', qty: 1 }, { offerExternalId: '12', qty: 1 }], 'paczka-2')).toMatchObject({ kind: 'PRZEJSCIOWY', reference: 'paczka-2', message: '1 z 2 pozycji nieudanych: 11' })
  })

  it('timeout i 5xx po wysłaniu = PRZEJSCIOWY (zapis bezwzględny, ponowienie bezpieczne)', async () => {
    const { atrapa, writer } = on()
    atrapa.injectWriteFailure('TIMEOUT_PO_WYSLANIU')
    expect((await writer.pushStock([{ offerExternalId: '10', qty: 3 }], 'r1')).kind).toBe('PRZEJSCIOWY')
    atrapa.injectWriteFailure('5XX_PO_WYSLANIU')
    expect((await writer.pushStock([{ offerExternalId: '10', qty: 3 }], 'r2')).kind).toBe('PRZEJSCIOWY')
    expect((await writer.pushStock([{ offerExternalId: '10', qty: 3 }], 'r3')).kind).toBe('OK')
    expect(atrapa.stockOf('10')!['quantity']).toBe('3')
  })
})

// ─── Zmiana statusu ──────────────────────────────────────────────────────────

describe('prestashop: zmiana statusu zamówienia', () => {
  const setup = () => {
    const x = make(ZAPIS, {}, { zapisWlaczony: true })
    x.atrapa.putOrder({ externalId: '101', state: 'open', offer: '10', qty: 1, createdAt: ago(60), modifiedAt: ago(50) })
    return x
  }

  it('ten sam status = OK bez zapisu (tylko odczyt current_state)', async () => {
    const { atrapa, writer } = setup()
    expect(await writer.setOrderStatus('101', '2', 's1')).toEqual({ kind: 'OK', reference: 's1' })
    expect(atrapa.paths()).toEqual(['GET /sklep/api/orders/101'])
    expect(atrapa.log[0]!.query.get('display')).toBe('[id,current_state]')
  })

  it('inny status = POST order_histories z id_order i id_order_state, bez sendemail', async () => {
    const { atrapa, writer } = setup()
    expect(await writer.setOrderStatus('101', '4', 's1')).toEqual({ kind: 'OK', reference: 's1' })
    const post = atrapa.log.find((r) => r.method === 'POST')!
    expect(post.path).toBe('/sklep/api/order_histories')
    expect(post.query.has('sendemail')).toBe(false)
    expect(post.body).toMatch(/<order_history><id_order>101<\/id_order><id_order_state>4<\/id_order_state><\/order_history>/)
    expect(atrapa.histories).toEqual([{ id_order: '101', id_order_state: '4' }])
    expect(atrapa.paths().filter((p) => p.startsWith('PUT') || p.startsWith('PATCH'))).toEqual([])
  })

  it('timeout albo 5xx po wysłaniu = NIEJEDNOZNACZNY; kolejne wywołanie bezpieczne (zaczyna od odczytu stanu)', async () => {
    const { atrapa, writer } = setup()
    atrapa.injectWriteFailure('TIMEOUT_PO_WYSLANIU')
    expect((await writer.setOrderStatus('101', '4', 's1')).kind).toBe('NIEJEDNOZNACZNY')
    expect(atrapa.histories).toHaveLength(1) // wpis powstał mimo braku odpowiedzi
    expect(await writer.setOrderStatus('101', '4', 's1')).toEqual({ kind: 'OK', reference: 's1' })
    expect(atrapa.histories).toHaveLength(1)
    atrapa.injectWriteFailure('5XX_PO_WYSLANIU')
    expect((await writer.setOrderStatus('101', '5', 's2')).kind).toBe('NIEJEDNOZNACZNY')
  })

  it('brak zamówienia albo odrzucony wpis = TRWALY', async () => {
    const { atrapa, writer } = setup()
    expect((await writer.setOrderStatus('999', '4', 's1')).kind).toBe('TRWALY')
    atrapa.injectWriteFailure('TRWALY')
    expect((await writer.setOrderStatus('101', '4', 's2')).kind).toBe('TRWALY')
    expect((await writer.setOrderStatus('101', 'wysłane', 's3')).kind).toBe('TRWALY')
  })
})

describe('prestashop: rejestr', () => {
  it('oba klucze w domyślnym rejestrze; tylko klucz z zapisem deklaruje stock.write i order.status.write', () => {
    const r = defaultRegistry()
    expect(r.get(READ)!.manifest).toMatchObject({ readOnly: true, channel: 'PRESTASHOP', capabilities: ['orders.feed', 'offers.read'] })
    expect(r.get(ZAPIS)!.manifest).toMatchObject({ readOnly: false, channel: 'PRESTASHOP', capabilities: ['orders.feed', 'offers.read', 'stock.write', 'order.status.write'] })
    expect(r.get(ZAPIS)!.manifest.config.find((f) => f.key === 'zapisWlaczony')).toMatchObject({ type: 'boolean', required: false })
    expect(r.get(READ)!.manifest.config.find((f) => f.key === 'zapisWlaczony')).toBeUndefined()
    const { adapter } = make(READ)
    expect(hasOrderFeed(adapter)).toBe(true)
  })
})
