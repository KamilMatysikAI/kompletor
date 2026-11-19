// Testy adaptera Shoper na atrapie HTTP (tests/shoper-atrapa.ts): suita kontraktowa dla obu kluczy
// i dwóch rozmiarów strony, mapowanie, strefa czasowa, limit tempa, tryb bez działającego filtra, wyłącznik zapisu,
// zapis częściowo nieudany, logowanie loginem i hasłem, lista stanów. Dane zmyślone, adresy example.invalid.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHANNEL_ADAPTER } from '../adaptery'
import { localToUtc } from '../zrodla/czas-lokalny'
import { ReadOnlyViolation, type FetchLike } from '../zrodla/http'
import { ShoperReadOnly, ShoperSession, ShoperWriter } from '../zrodla/shoper'
import { ShoperAtrapa, type ShoperAtrapaOpts } from '../../tests/shoper-atrapa'
import { defaultRegistry } from './domyslne'
import { AdapterError, type ChannelAdapter, hasOfferReader, hasOrderFeed, hasOrderStatusWriter, hasStockWriter, type OfferReader, type OrderFeed, type OrderStatusWriter, type StockWriter, UnreadableDataError } from './kontrakt'
import { AdapterConfigError } from './rejestr'
import { FILTR_NIE_DZIALA, FILTR_POZYCJI_NIE_DZIALA, shoperOrderFromApi, type ShoperSlowniki, shoperRevision, sinceLocal, TYP_STATUSU, utcToLocal, ZAPIS_WYLACZONY } from './shoper'
import { type ContractHarness, PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'
import { executeWrite } from './zapis'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const ACC = { organizationId: 'test_a', kind: 'channel' as const, id: 'SHOPER/demo', channel: 'SHOPER' as const, channelAccountId: 'demo', name: 'Sklep Shoper testowy' }
const FAST = { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 }
const TOKEN = 'tok-staly-test'
const LOOKBACK = { initialLookbackMs: 7 * 24 * 3600_000 }

type Full = ChannelAdapter & OrderFeed & OfferReader & Partial<StockWriter & OrderStatusWriter>

function make(opts: { key?: string; config?: Record<string, unknown>; secrets?: Record<string, string>; atrapa?: ShoperAtrapaOpts; http?: typeof FAST | { retry: typeof FAST.retry } } = {}) {
  const at = new ShoperAtrapa({ token: TOKEN, ...opts.atrapa })
  for (const id of ['10', '11', '12']) at.putStock(id)
  const adapter = defaultRegistry().create(opts.key ?? 'shoper.rest.v1', {
    integration: ACC,
    rawConfig: { baseUrl: at.host, ...opts.config },
    rawSecrets: opts.secrets ?? { SHOPER_ACCESS_TOKEN: TOKEN },
    fetch: at.fetch,
    now: () => NOW,
    http: opts.http ?? FAST,
  }) as Full
  return { at, adapter }
}

// ─── Suita kontraktowa: oba klucze, strony po 2 i po 50 ──────────────────────

function shoperHarness(key: 'shoper.rest.v1' | 'shoper.rest.zapis.v1', pageSize: number): ContractHarness {
  const zapis = key === 'shoper.rest.zapis.v1'
  return {
    name: `${key} (atrapa Shoper REST, strona ${pageSize})`,
    now: NOW,
    setup() {
      const { at, adapter } = make({ key, config: { pageSize, ...(zapis ? { zapisWlaczony: true } : {}) } })
      return {
        adapter,
        putOrder: (o) => at.putOrder(o),
        corruptOrder: (id) => at.corruptOrder(id),
        failNextList: (kind) => at.failNextList(kind),
        requests: () => at.requests(),
        ...(zapis ? { injectWriteFailure: (f: Parameters<ShoperAtrapa['injectWriteFailure']>[0]) => at.injectWriteFailure(f) } : {}),
      }
    },
  }
}

runAdapterContract(shoperHarness('shoper.rest.v1', 2))
runAdapterContract(shoperHarness('shoper.rest.v1', 50))
runAdapterContract(shoperHarness('shoper.rest.zapis.v1', 2))
runAdapterContract(shoperHarness('shoper.rest.zapis.v1', 50))

// ─── Mapowanie ───────────────────────────────────────────────────────────────

const SLOWNIKI: ShoperSlowniki = {
  statusy: new Map<string, number | null>([
    ['1', 1],
    ['2', 2],
    ['4', 3],
    ['5', 4],
    ['9', 7],
  ]),
  platnosci: new Map([['3', 'Przelewy24']]),
  dostawy: new Map([['7', 'Paczkomaty InPost']]),
  waluty: new Map([['1', 'PLN']]),
}
const zam = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  order_id: '500',
  date: '2026-11-02 10:00:00',
  status_date: '2026-11-02 10:05:00',
  confirm: '1',
  status_id: '1',
  sum: '24.60',
  is_paid: false,
  is_cash_on_delivery: false,
  is_underpayment: false,
  currency_id: '1',
  payment_id: '3',
  shipping_id: '7',
  email: PII_SENTINELS[1],
  billing_address: { firstname: PII_SENTINELS[0], street1: PII_SENTINELS[3], tax_identification_number: '' },
  delivery_address: { firstname: PII_SENTINELS[0], phone: PII_SENTINELS[2] },
  notes: PII_SENTINELS[4],
  ...over,
})
const poz = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: '9001', order_id: '500', stock_id: '10', code: 'SKU-10', price: '12.30', quantity: '2', tax_value: '23', ...over })
const map = (z = {}, p = [poz()], s = SLOWNIKI) => shoperOrderFromApi(zam(z), p, s, 'Europe/Warsaw')

describe('shoper: mapowanie zamówienia', () => {
  it('typy statusu → cykl życia i kolejność (TYP_STATUSU)', () => {
    const cases: [string, string, number | null][] = [
      ['1', 'OPEN', 10],
      ['2', 'OPEN', 20],
      ['4', 'FULFILLED', 30],
      ['5', 'CANCELLED', null],
    ]
    for (const [s, life, rank] of cases) expect(map({ status_id: s }), s).toMatchObject({ channelStatus: s, lifecycle: life, statusRank: rank, warnings: [] })
    expect(Object.keys(TYP_STATUSU).sort()).toEqual(['1', '2', '3', '4'])
  })

  it('nieznany status i nieznany typ = otwarte, bez kolejności, z ostrzeżeniem', () => {
    const a = map({ status_id: '77' })
    expect(a).toMatchObject({ lifecycle: 'OPEN', statusRank: null })
    expect(a.warnings.join(' ')).toContain('nieznany status Shoper 77')
    const b = map({ status_id: '9' })
    expect(b).toMatchObject({ lifecycle: 'OPEN', statusRank: null })
    expect(b.warnings.join(' ')).toContain('nieznany typ statusu Shoper 7')
  })

  it('niepotwierdzone (confirm 0) rezerwuje, z ostrzeżeniem; anulowane niepotwierdzone zostaje anulowane', () => {
    const o = map({ confirm: '0' })
    expect(o.lifecycle).toBe('OPEN')
    expect(o.warnings.join(' ')).toContain('niepotwierdzone')
    expect(map({ confirm: '0', status_id: '5' }).lifecycle).toBe('CANCELLED')
    // confirm null (sklep bez etapu potwierdzenia) to nie „niepotwierdzone”
    expect(map({ confirm: null }).warnings.join(' ')).not.toContain('niepotwierdzone')
  })

  it('rewizja: późniejsza z dat + opłacenie; opłacenie przy tej samej dacie daje nowszą, nowsza data zawsze wygrywa', () => {
    const unpaid = map().revision
    const paid = map({ is_paid: true }).revision
    expect(unpaid).toBe('2026-11-02T09:05:00.000Z#0')
    expect(paid).toBe('2026-11-02T09:05:00.000Z#1')
    expect(paid > unpaid).toBe(true)
    const later = map({ status_date: '2026-11-02 10:06:00', is_paid: false }).revision
    expect(later > paid).toBe(true)
    // status_date pusty albo wcześniejszy niż date → date
    expect(map({ status_date: null }).revision).toBe('2026-11-02T09:00:00.000Z#0')
    expect(map({ status_date: '2026-11-01 08:00:00' }).revision).toBe('2026-11-02T09:00:00.000Z#0')
    expect(shoperRevision(zam({ is_paid: '1' }), 'Europe/Warsaw')).toBe(paid)
  })

  it('płatność: pobranie, opłacone, niedopłata, nieopłacone', () => {
    expect(map({ is_cash_on_delivery: '1', is_paid: '0' }).paymentState).toBe('COD')
    expect(map({ is_paid: true }).paymentState).toBe('PAID')
    expect(map({ is_underpayment: '1' }).paymentState).toBe('PARTIAL')
    expect(map().paymentState).toBe('UNPAID')
    expect(() => map({ is_paid: 'tak' })).toThrow(UnreadableDataError)
  })

  it('nazwy płatności i dostawy ze słowników; brak słownika = identyfikator i ostrzeżenie', () => {
    const o = map()
    expect(o).toMatchObject({ paymentMethod: 'Przelewy24', deliveryMethod: 'Paczkomaty InPost', currency: 'PLN', totalGross: 24.6, number: null, externalId: '500' })
    const bez = map({}, [poz()], { ...SLOWNIKI, platnosci: null, dostawy: null })
    expect(bez).toMatchObject({ paymentMethod: '3', deliveryMethod: '7' })
    expect(bez.warnings.join(' ')).toContain('słownik płatność nieodczytany')
    expect(map({ payment_id: null, shipping_id: null })).toMatchObject({ paymentMethod: '(brak)', deliveryMethod: null })
  })

  it('waluta nieczytelna = PLN z ostrzeżeniem; inna waluta ze słownika', () => {
    const o = map({ currency_id: '2' }, [poz()], { ...SLOWNIKI, waluty: null })
    expect(o.currency).toBe('PLN')
    expect(o.warnings.join(' ')).toContain('waluta')
    expect(map({ currency_id: '2' }, [poz()], { ...SLOWNIKI, waluty: new Map([['2', 'EUR']]) }).currency).toBe('EUR')
  })

  it('faktura na NIP: tylko tak/nie, wartość nie wychodzi; bez danych osobowych', () => {
    const o = map({ billing_address: { firstname: PII_SENTINELS[0], tax_identification_number: PII_SENTINELS[4] } })
    expect(o.wantInvoiceNip).toBe(true)
    expect(map().wantInvoiceNip).toBe(false)
    const json = JSON.stringify(o)
    for (const p of PII_SENTINELS) expect(json).not.toContain(p)
  })

  it('pozycja: stock_id jako oferta, ilość, cena, VAT; brak stock_id = null + ostrzeżenie', () => {
    const o = map({}, [poz(), poz({ id: '9002', stock_id: null, quantity: 1 })])
    expect(o.lines[0]).toEqual({ externalLineId: '9001', offerExternalId: '10', qty: 2, unitPriceGross: 12.3, vatRate: '23', sku: 'SKU-10' })
    expect(o.lines[1]!.offerExternalId).toBeNull()
    expect(o.warnings.join(' ')).toContain('bez stock_id')
  })

  it('ilość ułamkowa, zero, nieczytelna, cena nieczytelna, brak pozycji = UnreadableDataError (nigdy 0)', () => {
    expect(() => map({}, [poz({ quantity: '1.5' })])).toThrow(UnreadableDataError)
    expect(() => map({}, [poz({ quantity: '0' })])).toThrow(UnreadableDataError)
    expect(() => map({}, [poz({ quantity: 'abc' })])).toThrow(UnreadableDataError)
    expect(() => map({}, [poz({ price: '' })])).toThrow(UnreadableDataError)
    expect(() => map({ sum: 'x' })).toThrow(UnreadableDataError)
    expect(() => map({}, [])).toThrow(UnreadableDataError)
    expect(map({}, [poz({ quantity: '3.000' })]).lines[0]!.qty).toBe(3)
  })

  it('daty bez strefy → UTC w strefie sklepu; zła data = błąd', () => {
    expect(map({ date: '2026-07-01 12:00:00', status_date: '2026-07-01 12:00:00' }).createdAt.toISOString()).toBe('2026-07-01T10:00:00.000Z')
    expect(map({ date: '2026-12-01 12:00:00', status_date: null }).createdAt.toISOString()).toBe('2026-12-01T11:00:00.000Z')
    expect(() => map({ date: '01.11.2026' })).toThrow(UnreadableDataError)
    expect(() => map({ status_date: 'wczoraj' })).toThrow(UnreadableDataError)
    expect(shoperOrderFromApi(zam({ date: '2026-07-01 12:00:00', status_date: null }), [poz()], SLOWNIKI, 'UTC').createdAt.toISOString()).toBe('2026-07-01T12:00:00.000Z')
  })
})

describe('shoper: strefa czasowa (localToUtc, przejścia czasu)', () => {
  it('zwykłe daty zimą i latem', () => {
    expect(localToUtc('2026-01-15 12:34:56', 'Europe/Warsaw')!.toISOString()).toBe('2026-01-15T11:34:56.000Z')
    expect(localToUtc('2026-07-15 12:34:56', 'Europe/Warsaw')!.toISOString()).toBe('2026-07-15T10:34:56.000Z')
    expect(localToUtc('2026-07-15T12:34:56', 'Europe/Warsaw')!.toISOString()).toBe('2026-07-15T10:34:56.000Z')
    expect(localToUtc('15.07.2026 12:34', 'Europe/Warsaw')).toBeNull()
  })

  it('jesień 25.10.2026: 02:30 występuje dwa razy — wynik to drugie wystąpienie (CET), godziny obok jednoznaczne', () => {
    expect(localToUtc('2026-10-25 01:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-10-24T23:30:00.000Z')
    expect(localToUtc('2026-10-25 02:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-10-25T01:30:00.000Z')
    expect(localToUtc('2026-10-25 03:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-10-25T02:30:00.000Z')
  })

  it('wiosna 29.03.2026: 03:30 to 01:30 UTC; nieistniejąca 02:30 ląduje na tej samej chwili', () => {
    expect(localToUtc('2026-03-29 03:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(localToUtc('2026-03-29 01:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-03-29T00:30:00.000Z')
    expect(localToUtc('2026-03-29 02:30:00', 'Europe/Warsaw')!.toISOString()).toBe('2026-03-29T01:30:00.000Z')
  })

  it('rewizje przez przejście jesienne rosną, utcToLocal odwraca localToUtc', () => {
    const r1 = map({ date: '2026-10-25 01:59:59', status_date: null }).revision
    const r2 = map({ date: '2026-10-25 03:00:00', status_date: null }).revision
    expect(r2 > r1).toBe(true)
    for (const iso of ['2026-10-25T02:30:00Z', '2026-03-29T01:30:00Z', '2026-11-02T12:00:00Z']) expect(localToUtc(utcToLocal(new Date(iso), 'Europe/Warsaw'), 'Europe/Warsaw')!.toISOString()).toBe(new Date(iso).toISOString())
    // pierwsze 02:30 jesienią (CEST) wraca jako drugie (CET): godzina później — kursor cofa się o zakładkę, duble odsiewa host
    expect(localToUtc(utcToLocal(new Date('2026-10-25T00:30:00Z'), 'Europe/Warsaw'), 'Europe/Warsaw')!.toISOString()).toBe('2026-10-25T01:30:00.000Z')
    expect(utcToLocal(new Date('2026-11-02T12:00:00Z'), 'Europe/Warsaw')).toBe('2026-11-02 13:00:00')
  })

  it('filtr „od” w pierwszym wystąpieniu godziny powtarzanej jesienią zaczyna od pełnej godziny', () => {
    expect(sinceLocal(new Date('2026-10-25T00:36:12.345Z'), 'Europe/Warsaw')).toBe('2026-10-25 02:00:00')
    expect(sinceLocal(new Date('2026-10-25T01:36:12.345Z'), 'Europe/Warsaw')).toBe('2026-10-25 02:36:12')
    expect(sinceLocal(new Date('2026-11-02T12:00:00.500Z'), 'Europe/Warsaw')).toBe('2026-11-02 13:00:00')
  })

  it('kursor nie wybiega poza „teraz” (zmiana z 02:40 czasu letniego widziana jako 01:40 UTC)', async () => {
    const at = new ShoperAtrapa({ token: TOKEN })
    const teraz = new Date('2026-10-25T00:41:00.000Z')
    const adapter = defaultRegistry().create('shoper.rest.v1', { integration: ACC, rawConfig: { baseUrl: at.host }, rawSecrets: { SHOPER_ACCESS_TOKEN: TOKEN }, fetch: at.fetch, now: () => teraz, http: FAST }) as Full
    at.putOrder({ externalId: '1', state: 'open', offer: '10', qty: 1, createdAt: new Date('2026-10-25T00:40:00Z'), modifiedAt: new Date('2026-10-25T00:40:00Z') })
    const p = await adapter.listOrderChanges(null, LOOKBACK)
    expect(p.items[0]!.revision).toBe('2026-10-25T01:40:00.000Z#1')
    expect(JSON.parse(p.nextCursor)).toMatchObject({ m: teraz.toISOString(), a: '2026-10-25T00:36:00.000Z' })
    await adapter.listOrderChanges(p.nextCursor, LOOKBACK)
    expect(at.log.at(-1)!.query['filters[status_date][>=]']).toBe('2026-10-25 02:00:00')
  })

  it('dziennik pyta o datę lokalną sklepu', async () => {
    const { at, adapter } = make()
    await adapter.listOrderChanges(null, LOOKBACK)
    expect(at.log[0]!.query['filters[status_date][>=]']).toBe('2026-10-26 13:00:00')
  })
})

// ─── Dziennik ────────────────────────────────────────────────────────────────

const seedMany = (at: ShoperAtrapa, ids: number[], modifiedAt: Date) => {
  for (const i of ids) at.putOrder({ externalId: String(i), state: 'open', offer: '10', qty: 1, createdAt: modifiedAt, modifiedAt })
}

describe('shoper: dziennik zamówień', () => {
  it('lista bez pełnego zamówienia; getOrder składa pozycje; kursor po końcu cofnięty o zakładkę', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 } })
    seedMany(at, [1, 2, 3], new Date(NOW.getTime() - 3600_000))
    const p1 = await adapter.listOrderChanges(null, LOOKBACK)
    expect(p1.items.map((i) => i.order)).toEqual([undefined, undefined])
    expect(p1.hasMore).toBe(true)
    const p2 = await adapter.listOrderChanges(p1.nextCursor, LOOKBACK)
    expect(p2.hasMore).toBe(false)
    expect(JSON.parse(p2.nextCursor)).toEqual({ a: new Date(NOW.getTime() - 3600_000 - 5 * 60_000).toISOString(), p: 1, m: new Date(NOW.getTime() - 3600_000).toISOString() })
    await expect(adapter.listOrderChanges('{"a":1}', LOOKBACK)).rejects.toMatchObject({ kind: 'TRWALY' })
  })

  it('filtr status_date nie działa: ostrzeżenie raz, odczyt od ostatniej strony wstecz, starsze odrzucone', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 }, atrapa: { filtrDatyDziala: false } })
    seedMany(at, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], new Date(NOW.getTime() - 10 * 24 * 3600_000))
    seedMany(at, [13, 14, 15], new Date(NOW.getTime() - 3600_000))
    const p = await adapter.listOrderChanges(null, LOOKBACK)
    expect(p.warnings).toEqual([FILTR_NIE_DZIALA])
    expect(p.hasMore).toBe(false)
    expect(p.items.map((i) => i.externalId).sort()).toEqual(['13', '14', '15'])
    // strona 1 (z kursora), potem 8 (15), 7 (13, 14), 6 (11, 12 — bez nowych → koniec)
    expect(at.log.filter((r) => r.path === '/orders').map((r) => r.query['page'])).toEqual(['1', '8', '7', '6'])
  })

  it('filtr nie działa: najwyżej 5 stron na odczyt', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 }, atrapa: { filtrDatyDziala: false } })
    seedMany(at, [1, 2], new Date(NOW.getTime() - 10 * 24 * 3600_000))
    seedMany(at, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], new Date(NOW.getTime() - 3600_000))
    const p = await adapter.listOrderChanges(null, LOOKBACK)
    expect(p.warnings).toEqual([FILTR_NIE_DZIALA])
    expect(at.log.filter((r) => r.path === '/orders')).toHaveLength(5)
    expect(p.items).toHaveLength(8) // strony 10, 9, 8, 7
  })

  it('pozycje: filtr order_id nie działa → wiersze innych zamówień odrzucone', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 }, atrapa: { filtrPozycjiDziala: false } })
    seedMany(at, [1, 2, 3, 4, 5], new Date(NOW.getTime() - 3600_000))
    const o = await adapter.getOrder('4')
    expect(o!.lines).toHaveLength(1)
    expect(at.log.filter((r) => r.path === '/order-products').length).toBe(3)
    // brak filtra widać w ostrzeżeniu zamówienia, a nie tylko w liczbie żądań
    expect(o!.warnings).toContain(FILTR_POZYCJI_NIE_DZIALA)
  })

  it('pozycje: filtr order_id działa → bez ostrzeżenia o filtrze', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 } })
    seedMany(at, [1, 2, 3], new Date(NOW.getTime() - 3600_000))
    expect((await adapter.getOrder('2'))!.warnings).not.toContain(FILTR_POZYCJI_NIE_DZIALA)
  })

  it('pozycje: filtr nie działa i więcej niż 10 stron → TRWALY z powodem „filtr order_id nie działa”', async () => {
    const { at, adapter } = make({ config: { pageSize: 1 }, atrapa: { filtrPozycjiDziala: false } })
    seedMany(at, Array.from({ length: 12 }, (_, i) => i + 1), new Date(NOW.getTime() - 3600_000))
    await expect(adapter.getOrder('12')).rejects.toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('filtr order_id w /order-products nie działa') })
    expect(at.log.filter((r) => r.path === '/order-products').length).toBe(10)
  })

  it('404 na liście (adres nie jest API Shopera) → TRWALY, test połączenia mówi to wprost', async () => {
    const { at, adapter } = make()
    at.failNext('/orders', 404)
    await expect(adapter.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('nie odpowiada jak API Shoper') })
    at.failNext('/orders', 404)
    expect(await adapter.testConnection()).toMatchObject({ ok: false, message: expect.stringContaining('nie odpowiada jak API Shoper') })
  })

  it('słowniki raz na instancję; błąd słownika płatności = identyfikator i ostrzeżenie', async () => {
    const { at, adapter } = make()
    seedMany(at, [1, 2], new Date(NOW.getTime() - 3600_000))
    at.failNext('/payments', 500)
    const a = await adapter.getOrder('1')
    expect(a!.paymentMethod).toBe('3')
    await adapter.getOrder('2')
    for (const p of ['/statuses', '/payments', '/shippings', '/currencies']) expect(at.log.filter((r) => r.path === p), p).toHaveLength(1)
  })

  it('429 z Retry-After → PRZEJSCIOWY z retryAfterMs; 403 → TRWALY', async () => {
    const { at, adapter } = make()
    at.failNext('/orders', 429, { 'retry-after': '7' })
    await expect(adapter.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 7000 })
    at.failNext('/orders', 403)
    await expect(adapter.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'TRWALY' })
  })

  it('odstęp między żądaniami domyślnie 500 ms', async () => {
    const at = new ShoperAtrapa({ token: TOKEN })
    const times: number[] = []
    const timed: FetchLike = async (url, init) => {
      times.push(Date.now())
      return at.fetch(url, init)
    }
    const adapter = defaultRegistry().create('shoper.rest.v1', { integration: ACC, rawConfig: { baseUrl: at.host }, rawSecrets: { SHOPER_ACCESS_TOKEN: TOKEN }, fetch: timed, now: () => NOW, http: { retry: FAST.retry } })
    await adapter.testConnection()
    await adapter.testConnection()
    expect(times).toHaveLength(4)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(490)
  })
})

// ─── Test połączenia, uwierzytelnienie, konfiguracja ─────────────────────────

describe('shoper: połączenie i uwierzytelnienie', () => {
  it('test połączenia: liczby; 403 mówi, którego uprawnienia brak, bez treści odpowiedzi', async () => {
    const { at, adapter } = make()
    seedMany(at, [1, 2], new Date(NOW.getTime() - 3600_000))
    expect(await adapter.testConnection()).toEqual({ ok: true, message: 'odczyt zamówień i statusów działa', details: { orders: 2, statuses: 5 } })
    at.failNext('/statuses', 403)
    const r = await adapter.testConnection()
    expect(r).toMatchObject({ ok: false, message: 'token bez uprawnienia do odczytu: statusy zamówień' })
    expect(JSON.stringify(r)).not.toContain(PII_SENTINELS[1])
  })

  it('login i hasło: token z POST /auth w pamięci, 401 = jedna ponowna autoryzacja', async () => {
    const login = { login: 'api-kompletor', password: 'haslo-testowe' }
    const { at, adapter } = make({ atrapa: { token: undefined, login }, secrets: { SHOPER_API_LOGIN: login.login, SHOPER_API_PASSWORD: login.password } })
    seedMany(at, [1], new Date(NOW.getTime() - 3600_000))
    expect((await adapter.getOrder('1'))!.externalId).toBe('1')
    expect(at.tokensIssued).toBe(1)
    expect(at.log.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/auth'])
    at.expireTokens()
    expect((await adapter.getOrder('1'))!.externalId).toBe('1')
    expect(at.tokensIssued).toBe(2)
    expect(new Set(at.log.filter((r) => r.path !== '/auth').map((r) => r.method))).toEqual(new Set(['GET']))
  })

  it('złe hasło = błąd trwały; 401 przy tokenie wprost = trwały bez logowania', async () => {
    const { adapter } = make({ atrapa: { token: undefined, login: { login: 'a', password: 'b' } }, secrets: { SHOPER_API_LOGIN: 'a', SHOPER_API_PASSWORD: 'zle' } })
    await expect(adapter.getOrder('1')).rejects.toMatchObject({ kind: 'TRWALY' })
    const t = make({ secrets: { SHOPER_ACCESS_TOKEN: 'inny' } })
    await expect(t.adapter.getOrder('1')).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(t.at.log.some((r) => r.path === '/auth')).toBe(false)
    expect((await t.adapter.testConnection()).message).toContain('odrzucone')
  })

  it('brak tokena i loginu = AdapterConfigError; adres tylko https; zła strefa', () => {
    expect(() => make({ secrets: {} })).toThrow(AdapterConfigError)
    expect(() => make({ secrets: { SHOPER_API_LOGIN: 'tylko-login' } })).toThrow(AdapterConfigError)
    expect(() => make({ config: { baseUrl: 'http://sklep.example.invalid' } })).toThrow(AdapterConfigError)
    expect(() => make({ config: { strefa: 'Mars/Olympus' } })).toThrow(AdapterConfigError)
  })

  it('klienty: odczyt tylko GET (POST tylko /auth), zapis tylko PUT na dwóch ścieżkach', async () => {
    const at = new ShoperAtrapa({ token: TOKEN })
    const s = new ShoperSession(at.host, { token: TOKEN }, at.fetch, 0, FAST.retry)
    const ro = new ShoperReadOnly(s)
    await expect(ro.get('/orders', {}, { method: 'POST' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(ro.get('/auth')).rejects.toThrow('zła ścieżka')
    await expect(ro.get('/orders/../x')).rejects.toThrow('zła ścieżka')
    const w = new ShoperWriter(s)
    await expect(w.put('/products/1', { stock: 1 })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(w.put('/product-stocks/1/x', { stock: 1 })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(w.put('/orders/1', { status_id: '2' }, { method: 'DELETE' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(at.log).toHaveLength(0)
  })
})

// ─── Oferty i stany ──────────────────────────────────────────────────────────

describe('shoper: listOffers', () => {
  it('po stronach, kursor = numer strony; stan nieczytelny = błąd', async () => {
    const { at, adapter } = make({ config: { pageSize: 2 } })
    expect(hasOfferReader(adapter)).toBe(true)
    at.putStock('11', { stock: '0', active: '0', ean: null })
    const p1 = await adapter.listOffers(null)
    expect(p1.items).toEqual([
      { externalId: '10', sku: 'SKU-10', ean: '5901234123457', name: null, qty: 7, active: true },
      { externalId: '11', sku: 'SKU-11', ean: null, name: null, qty: 0, active: false },
    ])
    expect(p1.nextCursor).toBe('2')
    const p2 = await adapter.listOffers(p1.nextCursor)
    expect(p2).toEqual({ items: [expect.objectContaining({ externalId: '12' })], nextCursor: null })
    await expect(adapter.listOffers('x')).rejects.toMatchObject({ kind: 'TRWALY' })
    at.putStock('12', { stock: 'abc' })
    await expect(adapter.listOffers('2')).rejects.toBeInstanceOf(UnreadableDataError)
  })
})

// ─── Zapis za wyłącznikiem ───────────────────────────────────────────────────

describe('shoper: zapis za wyłącznikiem', () => {
  it('domyślny adapter kanału SHOPER jest tylko do odczytu, bez metod zapisu', () => {
    expect(DEFAULT_CHANNEL_ADAPTER.SHOPER).toBe('shoper.rest.v1')
    const { adapter } = make()
    expect(adapter.manifest.readOnly).toBe(true)
    expect(hasStockWriter(adapter)).toBe(false)
    expect(hasOrderStatusWriter(adapter)).toBe(false)
    expect(hasOrderFeed(adapter)).toBe(true)
  })

  it('klucz zapisu bez zapisWlaczony: TRWALY „zapis wyłączony” i zero żądań do sklepu', async () => {
    for (const config of [{}, { zapisWlaczony: false }, { zapisWlaczony: 'false' }]) {
      const { at, adapter } = make({ key: 'shoper.rest.zapis.v1', config })
      expect(hasStockWriter(adapter) && hasOrderStatusWriter(adapter)).toBe(true)
      expect(await adapter.pushStock!([{ offerExternalId: '10', qty: 3 }], 'ref-1')).toEqual({ kind: 'TRWALY', reference: 'ref-1', message: ZAPIS_WYLACZONY })
      expect(await adapter.setOrderStatus!('1', '2', 'ref-2')).toEqual({ kind: 'TRWALY', reference: 'ref-2', message: ZAPIS_WYLACZONY })
      expect(at.log).toHaveLength(0)
    }
  })

  const zapis = () => make({ key: 'shoper.rest.zapis.v1', config: { zapisWlaczony: true } })

  it('zapis stanu: PUT z samym polem stock, po kolei; wynik z niezmienioną referencją', async () => {
    const { at, adapter } = zapis()
    const out = await executeWrite(adapter, 'ref-ok', () => adapter.pushStock!([{ offerExternalId: '10', qty: 3 }, { offerExternalId: '12', qty: 0 }], 'ref-ok'))
    expect(out).toEqual({ kind: 'OK', reference: 'ref-ok' })
    expect(at.log.map((r) => [r.method, r.path, r.body])).toEqual([
      ['PUT', '/product-stocks/10', { stock: 3 }],
      ['PUT', '/product-stocks/12', { stock: 0 }],
    ])
    expect(at.stocks.get('10')!['stock']).toBe('3')
  })

  it('zapis częściowo nieudany: wszystkie pozycje wysłane, najgorszy rodzaj, liczba i oferty', async () => {
    const { at, adapter } = zapis()
    at.injectWriteFailure('PRZEJSCIOWY') // pierwsza (10)
    const items = [
      { offerExternalId: '10', qty: 1 },
      { offerExternalId: '11', qty: 2 },
      { offerExternalId: '12', qty: 3 },
    ]
    const a = await adapter.pushStock!(items, 'ref-a')
    expect(a).toMatchObject({ kind: 'PRZEJSCIOWY', reference: 'ref-a' })
    expect(a.kind !== 'OK' && a.message).toContain('1 z 3 ofert: 10')
    expect(at.log.filter((r) => r.method === 'PUT')).toHaveLength(3)
    expect(at.stocks.get('12')!['stock']).toBe('3')
    at.injectWriteFailure('PRZEJSCIOWY')
    at.injectWriteFailure('TRWALY')
    const b = await adapter.pushStock!(items, 'ref-b')
    expect(b.kind).toBe('TRWALY')
    expect(b.kind !== 'OK' && b.message).toContain('2 z 3')
    expect(JSON.stringify(b)).not.toContain(PII_SENTINELS[1]) // bez treści odpowiedzi
    at.injectWriteFailure('SIEC')
    expect((await adapter.pushStock!([{ offerExternalId: '10', qty: 1 }], 'ref-c')).kind).toBe('PRZEJSCIOWY')
    expect((await adapter.pushStock!([{ offerExternalId: '999', qty: 1 }], 'ref-d')).kind).toBe('TRWALY')
    expect((await adapter.pushStock!([{ offerExternalId: '10', qty: 1.5 }], 'ref-e')).kind).toBe('TRWALY')
  })

  it('zapis: 429 z Retry-After przechodzi do wyniku', async () => {
    const { at, adapter } = zapis()
    at.failNext('/product-stocks/10', 429, { 'retry-after': '3' })
    expect(await adapter.pushStock!([{ offerExternalId: '10', qty: 1 }], 'ref-r')).toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 3000 })
  })

  it('sklep z modułem magazynów: TRWALY z informacją o module', async () => {
    const { at, adapter } = zapis()
    at.magazyny = true
    const r = await adapter.pushStock!([{ offerExternalId: '10', qty: 1 }], 'ref-m')
    expect(r.kind).toBe('TRWALY')
    expect(r.kind !== 'OK' && r.message).toContain('moduł magazynów')
    expect(r.kind !== 'OK' && r.message).not.toContain('read only')
  })

  it('status zamówienia: ten sam = OK bez zapisu; inny = PUT z samym status_id; nieznany status = TRWALY bez zapisu', async () => {
    const { at, adapter } = zapis()
    seedMany(at, [1], new Date(NOW.getTime() - 3600_000))
    expect(await adapter.setOrderStatus!('1', '1', 'ref-s1')).toEqual({ kind: 'OK', reference: 'ref-s1' })
    expect(at.log.filter((r) => r.method === 'PUT')).toHaveLength(0)
    expect(await adapter.setOrderStatus!('1', '4', 'ref-s2')).toEqual({ kind: 'OK', reference: 'ref-s2' })
    expect(at.log.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body])).toEqual([['/orders/1', { status_id: '4' }]])
    expect(at.orders.get('1')!['status_id']).toBe('4')
    expect((await adapter.setOrderStatus!('1', '42', 'ref-s3')).kind).toBe('TRWALY')
    expect((await adapter.setOrderStatus!('999', '2', 'ref-s4')).kind).toBe('TRWALY')
    expect(at.log.filter((r) => r.method === 'PUT')).toHaveLength(1)
  })

  it('test połączenia klucza zapisu pokazuje stan wyłącznika, bez żadnego zapisu', async () => {
    const wl = zapis()
    expect((await wl.adapter.testConnection()).details).toMatchObject({ zapisWlaczony: true })
    const wyl = make({ key: 'shoper.rest.zapis.v1' })
    expect((await wyl.adapter.testConnection()).details).toMatchObject({ zapisWlaczony: false })
    expect([...wl.at.log, ...wyl.at.log].filter((r) => r.method !== 'GET')).toHaveLength(0)
  })

  it('suita odczytu dla klucza zapisu nie wysyła PUT', async () => {
    const { at, adapter } = zapis()
    seedMany(at, [1, 2], new Date(NOW.getTime() - 3600_000))
    await adapter.listOrderChanges(null, LOOKBACK)
    await adapter.getOrder('1')
    await adapter.listOffers(null)
    await adapter.testConnection()
    expect(new Set(at.requests())).toEqual(new Set(['GET']))
  })
})

it('błąd adaptera to AdapterError z rodzajem (nie surowy SourceError)', async () => {
  const { at, adapter } = make()
  at.failNext('/orders/1', 502)
  await expect(adapter.getOrder('1')).rejects.toBeInstanceOf(AdapterError)
})
