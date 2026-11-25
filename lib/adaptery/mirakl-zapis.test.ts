// Empik (Mirakl) z zapisem za wyłącznikiem — OR21 akceptacja, STO01 stany, OR23 numer nadania, OR24
// wysłane. Wyłącznie atrapa (tests/mirakl-atrapa.ts, adres empik.example); zero wywołań prawdziwego Empiku.
import { beforeEach, describe, expect, it } from 'vitest'
import { MIRAKL_HOST, MIRAKL_KEY, MiraklAtrapa } from '../../tests/mirakl-atrapa'
import { DEFAULT_CHANNEL_ADAPTER } from '../adaptery'
import { ReadOnlyViolation } from '../zrodla/http'
import { komunikatBleduMirakl, MIRAKL_MIN_INTERVAL_MS, miraklAccountThrottle, MiraklWriter } from '../zrodla/mirakl'
import { kanonicznyStatusKanalu, mapaStatusow, wynikiPerOferta } from '../kanaly/zapis-host'
import { ALLEGRO_ZAPIS_MANIFEST } from './allegro-zapis'
import { WOO_MANIFEST } from './woo'
import { Throttle } from '../zrodla/http'
import { defaultRegistry } from './domyslne'
import {
  ACCEPT_ALREADY_DECIDED,
  alreadyDecidedState,
  type ChannelAdapter,
  hasOrderAcceptor,
  hasOrderStatusWriter,
  hasReferenceFinder,
  hasStockImportStatus,
  hasStockWriter,
  type StockImportStatusReader,
  hasTrackingWriter,
  type OrderAcceptor,
  type OrderStatusWriter,
  type StockWriter,
  type TrackingWriter,
} from './kontrakt'
import { opisZdarzenia } from '../karta/historia'
import { carrierCodesOf, CZESCIOWA_AKCEPTACJA_WYLACZONA, EMPIK_KODY_PRZEWOZNIKOW,kodyZRaportuBledow, MIRAKL_EMPIK_MANIFEST, MIRAKL_EMPIK_ZAPIS_MANIFEST, SHOP_SKU_TTL_MS, wyczyscPamiecOfertEmpiku, ZAPIS_WYLACZONY } from './mirakl-empik'
import { manifestProblems, validateAccountConfig } from './rejestr'
import { type ContractHarness, runAdapterContract, type SeedOrder } from './suita-kontraktowa'
import { executeWrite } from './zapis'

const NOW = new Date('2026-11-06T09:00:00.000Z')
const ACC = { organizationId: 'test_a', kind: 'channel' as const, id: 'EMPIK/empik', channel: 'EMPIK' as const, channelAccountId: 'empik', name: 'Empik testowy' }
const FAST = { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 }
const ZAPIS = 'mirakl.empik.zapis.v1'

type Full = ChannelAdapter & StockWriter & OrderStatusWriter & OrderAcceptor & TrackingWriter & StockImportStatusReader

// mapa ofert jest w pamięci procesu (wspólna dla adapterów konta); każdy test zaczyna od pustej
beforeEach(() => wyczyscPamiecOfertEmpiku())

function make(config: Record<string, unknown> = { zapisWlaczony: true }, key = ZAPIS, at = new MiraklAtrapa(), now = NOW) {
  const adapter = defaultRegistry().create(key, {
    integration: ACC,
    rawConfig: { baseUrl: MIRAKL_HOST, pageSize: 2, ...config },
    rawSecrets: { MIRAKL_API_KEY: MIRAKL_KEY },
    fetch: at.fetch,
    now: () => now,
    http: FAST,
  }) as Full
  return { at, adapter }
}

// ─── Suita kontraktowa dla klucza z zapisem ──────────────────────────────────

const STAN: Record<SeedOrder['state'], string> = { open: 'SHIPPING', cancelled: 'CANCELED', fulfilled: 'SHIPPED' }

function zapisHarness(): ContractHarness {
  return {
    name: `${ZAPIS} (atrapa Mirakl, wyłącznik włączony)`,
    now: NOW,
    setup() {
      const { at, adapter } = make()
      at.putOffer('10', 'SKU-10')
      return {
        adapter,
        putOrder: (o) =>
          at.putOrder({ id: o.externalId, state: STAN[o.state], createdAt: o.createdAt.toISOString(), updatedAt: o.modifiedAt.toISOString(), lines: [{ id: `${o.externalId}-1`, sku: o.offer, qty: o.qty }] }),
        corruptOrder: (id) => {
          at.orders.get(id)!['total_price'] = 'abc'
        },
        failNextList: (kind) => at.failNextGet(kind === 'PRZEJSCIOWY' ? 503 : 401),
        requests: () => at.zapytania.map((z) => z.method),
        injectWriteFailure: (f) => {
          if (f === 'PRZEJSCIOWY' || f === 'TRWALY') at.injectWriteFailure(f)
        },
      }
    },
  }
}

runAdapterContract(zapisHarness())

// ─── Manifest i wyłącznik ────────────────────────────────────────────────────

describe('Empik z zapisem: manifest i wyłącznik', () => {
  it('domyślny adapter kanału EMPIK zostaje tylko do odczytu, bez zdolności zapisu', () => {
    expect(DEFAULT_CHANNEL_ADAPTER.EMPIK).toBe('mirakl.empik.v1')
    const { adapter } = make({}, 'mirakl.empik.v1')
    expect(adapter.manifest.readOnly).toBe(true)
    for (const g of [hasStockWriter, hasOrderStatusWriter, hasOrderAcceptor, hasTrackingWriter, hasStockImportStatus]) expect(g(adapter)).toBe(false)
  })

  it('klucz z zapisem: wszystkie zdolności zapisu, bez reference.find (powtórka bezpieczna przez odczyt stanu)', () => {
    const { adapter } = make()
    expect(manifestProblems(adapter.manifest)).toEqual([])
    for (const g of [hasStockWriter, hasOrderStatusWriter, hasOrderAcceptor, hasTrackingWriter, hasStockImportStatus]) expect(g(adapter)).toBe(true)
    expect(hasReferenceFinder(adapter)).toBe(false)
    expect(adapter.manifest.config.map((c) => c.key)).toEqual(expect.arrayContaining(['zapisWlaczony', 'akceptacjaBraki', 'akceptacjaAlertGodzin', 'kodyPrzewoznikow', 'magazynEmpik']))
  })

  it('domyślna mapa statusów „Wysłane” → SHIPPED (konto bez własnej mapy nie stoi bez statusu); wybór tylko z SHIPPED', () => {
    const { adapter } = make()
    expect(mapaStatusow({}, adapter.manifest)).toEqual({ mapa: { WYSLANE: 'SHIPPED' }, wlasna: false })
    expect(adapter.manifest.channelBehavior?.channelStatuses?.map((s) => s.id)).toEqual(['SHIPPED'])
    // własna mapa konta (także pusta) dalej wygrywa z domyślną
    expect(mapaStatusow({ statusy: {} }, adapter.manifest)).toEqual({ mapa: {}, wlasna: true })
  })

  it('manifest odrzuca zdolności zapisu przy readOnly', () => {
    const { adapter } = make()
    const m = { ...adapter.manifest, readOnly: true }
    expect(manifestProblems(m)).toEqual(expect.arrayContaining(['adapter tylko do odczytu deklaruje order.accept', 'adapter tylko do odczytu deklaruje order.tracking.write']))
  })

  it.each([[{}], [{ zapisWlaczony: false }], [{ zapisWlaczony: 'false' }]])('bez wyłącznika (%j): każda metoda zapisu TRWALY „zapis wyłączony”, zero żądań', async (config) => {
    const { at, adapter } = make(config)
    at.putOrder({ id: 'E-1', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-1-1', sku: 'P1', qty: 1 }] })
    expect(await adapter.pushStock([{ offerExternalId: 'P1', qty: 3 }], 'r1')).toEqual({ kind: 'TRWALY', reference: 'r1', message: ZAPIS_WYLACZONY })
    expect(await adapter.acceptOrder('E-1', [{ externalLineId: 'E-1-1', accepted: true }], 'r2')).toMatchObject({ kind: 'TRWALY', message: ZAPIS_WYLACZONY })
    expect(await adapter.setOrderStatus('E-1', 'SHIPPED', 'r3')).toMatchObject({ kind: 'TRWALY', message: ZAPIS_WYLACZONY })
    expect(await adapter.setTracking('E-1', { carrier: 'DPD', number: 'DPD123456' }, 'r4')).toMatchObject({ kind: 'TRWALY', message: ZAPIS_WYLACZONY })
    expect(at.zapytania).toEqual([])
    expect(at.stateOf('E-1')).toBe('WAITING_ACCEPTANCE')
  })

  it('klient zapisu zna tylko cztery ścieżki', async () => {
    const at = new MiraklAtrapa()
    const w = new MiraklWriter(MIRAKL_HOST, MIRAKL_KEY, at.fetch, new Throttle(0))
    await expect(w.send('PUT', '/offers', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(w.send('POST', '/orders/E-1/accept', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(w.send('PUT', '/orders/../accept', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(at.zapytania).toEqual([])
  })
})

// ─── OR21 akceptacja ─────────────────────────────────────────────────────────

describe('Empik OR21: przyjęcie zamówienia', () => {
  const zamowienie = (at: MiraklAtrapa, state = 'WAITING_ACCEPTANCE') =>
    at.putOrder({
      id: 'E-7',
      state,
      lines: [
        { id: 'E-7-1', sku: 'P1', qty: 2 },
        { id: 'E-7-2', sku: 'P2', qty: 1 },
      ],
    })

  it('przyjęcie wszystkich pozycji: PUT accept z decyzją dla każdej, wynik OK', async () => {
    const { at, adapter } = make()
    zamowienie(at)
    const r = await adapter.acceptOrder('E-7', [{ externalLineId: 'E-7-1', accepted: true }, { externalLineId: 'E-7-2', accepted: true }], 'ref-a')
    expect(r).toEqual({ kind: 'OK', reference: 'ref-a' })
    expect(at.zapisy()).toEqual([{ method: 'PUT', path: '/orders/E-7/accept', query: {}, body: { order_lines: [{ id: 'E-7-1', accepted: true }, { id: 'E-7-2', accepted: true }] } }])
    expect(at.stateOf('E-7')).toBe('WAITING_DEBIT')
  })

  it('odrzucenie jednej pozycji; przy wyłączonej częściowej akceptacji TRWALY z rozpoznawalnym komunikatem', async () => {
    const { at, adapter } = make()
    zamowienie(at)
    at.injectWriteFailure('CZESCIOWA_WYLACZONA')
    const d = [{ externalLineId: 'E-7-1', accepted: true }, { externalLineId: 'E-7-2', accepted: false }]
    const r = await adapter.acceptOrder('E-7', d, 'ref-b')
    expect(r.kind).toBe('TRWALY')
    expect(r.kind !== 'OK' && r.message.startsWith(CZESCIOWA_AKCEPTACJA_WYLACZONA)).toBe(true)
    expect(at.stateOf('E-7')).toBe('WAITING_ACCEPTANCE')
    expect(await adapter.acceptOrder('E-7', d, 'ref-c')).toEqual({ kind: 'OK', reference: 'ref-c' })
    expect((at.orders.get('E-7')!['order_lines'] as Record<string, unknown>[]).map((l) => l['order_line_state'])).toEqual(['WAITING_DEBIT', 'REFUSED'])
  })

  it('powtórka po zgubionej odpowiedzi: PRZEJSCIOWY, potem OK „już rozstrzygnięte” bez drugiej decyzji', async () => {
    const { at, adapter } = make()
    zamowienie(at)
    const d = [{ externalLineId: 'E-7-1', accepted: true }, { externalLineId: 'E-7-2', accepted: true }]
    at.injectWriteFailure('SIEC_PO_WYKONANIU')
    expect((await executeWrite(adapter, 'ref-d', () => adapter.acceptOrder('E-7', d, 'ref-d'))).kind).toBe('PRZEJSCIOWY')
    expect(at.stateOf('E-7')).toBe('WAITING_DEBIT') // zapis się wykonał
    expect(await adapter.acceptOrder('E-7', d, 'ref-d')).toEqual({ kind: 'OK', reference: 'ref-d', externalRef: `${ACCEPT_ALREADY_DECIDED}:WAITING_DEBIT` })
    expect(at.zapisy().filter((z) => z.path.endsWith('/accept'))).toHaveLength(2) // druga odbita przez Empik (zły stan), stan bez zmian
  })

  it('zamówienie rozstrzygnięte poza Kompletorem = OK „już rozstrzygnięte” ze stanem kanału (anulowane rozpoznawalne)', async () => {
    for (const state of ['SHIPPING', 'CANCELED']) {
      const { at, adapter } = make()
      zamowienie(at, state)
      expect(await adapter.acceptOrder('E-7', [{ externalLineId: 'E-7-1', accepted: true }, { externalLineId: 'E-7-2', accepted: true }], 'x')).toEqual({ kind: 'OK', reference: 'x', externalRef: `${ACCEPT_ALREADY_DECIDED}:${state}` })
    }
  })

  it('błędy: 503 i 429 przejściowe (z Retry-After), 400 walidacji trwały, zła lista decyzji bez żądania', async () => {
    const { at, adapter } = make()
    zamowienie(at)
    const d = [{ externalLineId: 'E-7-1', accepted: true }, { externalLineId: 'E-7-2', accepted: true }]
    at.injectWriteFailure('PRZEJSCIOWY')
    expect((await adapter.acceptOrder('E-7', d, 'a')).kind).toBe('PRZEJSCIOWY')
    at.injectWriteFailure('LIMIT')
    expect(await adapter.acceptOrder('E-7', d, 'b')).toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 60_000 })
    at.injectWriteFailure('TRWALY')
    expect(await adapter.acceptOrder('E-7', d, 'c')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('VALIDATION_ERROR') })
    const n = at.zapytania.length
    expect((await adapter.acceptOrder('E-7', [], 'd')).kind).toBe('TRWALY')
    expect((await adapter.acceptOrder('E-7', [d[0]!, d[0]!], 'e')).kind).toBe('TRWALY')
    expect((await adapter.acceptOrder('../E-7', d, 'f')).kind).toBe('TRWALY')
    expect(at.zapytania.length).toBe(n)
  })
})

// ─── STO01 stany ─────────────────────────────────────────────────────────────

describe('Empik STO01: stany', () => {
  it('CSV samych stanów po offer-sku (shop_sku z OF21), wynik OK z numerem importu', async () => {
    const { at, adapter } = make({ zapisWlaczony: true, magazynEmpik: 'GLOWNY' })
    at.magazyny.add('GLOWNY')
    at.putOffer('P1', 'SD-001')
    at.putOffer('P2', 'SD-0"02')
    at.putOffer('P3', 'SD-003')
    const r = await adapter.pushStock([{ offerExternalId: 'P1', qty: 4 }, { offerExternalId: 'P2', qty: 0 }], 'ref-s')
    expect(r).toEqual({ kind: 'OK', reference: 'ref-s', externalRef: 'STO01:1001' })
    expect([...at.stany]).toEqual([['SD-001', 4], ['SD-0"02', 0]])
    const post = at.zapisy()
    expect(post).toHaveLength(1)
    expect(post[0]).toMatchObject({ method: 'POST', path: '/offers/stock/imports' })
    expect(String(post[0]!.body).split('\n')[1]).toBe('"SD-001";"4";"GLOWNY";"update"')
  })

  it('oferta nieznana albo dwie oferty jednego produktu: bez zgadywania, reszta idzie, nieudane w failedItems', async () => {
    const { at, adapter } = make()
    at.putOffer('P1', 'SD-001')
    at.putOffer('P9', 'A')
    at.putOffer('P9', 'B')
    const r = await adapter.pushStock([{ offerExternalId: 'P1', qty: 2 }, { offerExternalId: 'P9', qty: 1 }, { offerExternalId: 'BRAK', qty: 1 }], 'ref-u')
    expect(r).toMatchObject({
      kind: 'TRWALY',
      reference: 'ref-u',
      message: expect.stringContaining('P9, BRAK'),
      failedItems: [
        { offerExternalId: 'P9', kind: 'TRWALY', message: 'brak jednej oferty w Empiku' },
        { offerExternalId: 'BRAK', kind: 'TRWALY', message: 'brak jednej oferty w Empiku' },
      ],
    })
    expect(r).not.toHaveProperty('warnings')
    expect(r.kind !== 'OK' && r.message).toContain('STO01:1001')
    expect([...at.stany]).toEqual([['SD-001', 2]])
    // nic do wysłania: cała paczka TRWALY, bez failedItems (host oznacza wszystkie pozycje), bez żądania importu
    const nic = await make().adapter.pushStock([{ offerExternalId: 'NIC', qty: 1 }], 'r')
    expect(nic).toMatchObject({ kind: 'TRWALY' })
    expect(nic).not.toHaveProperty('failedItems')
  })

  it('wynik częściowy przez host zapisu: pozycja bez oferty niewysłana, reszta wysłana', async () => {
    const { at, adapter } = make()
    at.putOffer('P1', 'SD-001')
    const items = [
      { offerId: 'o1', externalId: 'P1', channelAccountId: 'empik', targetQty: 5 },
      { offerId: 'o2', externalId: 'BRAK', channelAccountId: 'empik', targetQty: 1 },
    ]
    const out = await executeWrite(adapter, 'ref-h', () => adapter.pushStock([{ offerExternalId: 'P1', qty: 5 }, { offerExternalId: 'BRAK', qty: 1 }], 'ref-h'))
    expect(wynikiPerOferta(items, out)).toEqual([
      { offerId: 'o1', ok: true },
      { offerId: 'o2', ok: false, kind: 'TRWALY', error: 'brak jednej oferty w Empiku' },
    ])
    expect(at.stany.get('SD-001')).toBe(5)
  })

  it('oferta założona w Empiku po pierwszym zapisie: jedno przeładowanie ofert i zapis', async () => {
    const { at, adapter } = make()
    at.putOffer('P1', 'SD-001')
    expect((await adapter.pushStock([{ offerExternalId: 'P1', qty: 1 }], 'r1')).kind).toBe('OK')
    at.putOffer('P5', 'SD-005')
    const odczytyPrzed = at.zapytania.filter((z) => z.path === '/offers').length
    expect(await adapter.pushStock([{ offerExternalId: 'P5', qty: 3 }], 'r2')).toMatchObject({ kind: 'OK' })
    expect(at.stany.get('SD-005')).toBe(3)
    expect(at.zapytania.filter((z) => z.path === '/offers').length).toBe(odczytyPrzed + 1)
    // znana oferta: bez kolejnego odczytu ofert
    await adapter.pushStock([{ offerExternalId: 'P5', qty: 4 }], 'r3')
    expect(at.zapytania.filter((z) => z.path === '/offers').length).toBe(odczytyPrzed + 1)
  })

  it('odstęp żądań z limitu manifestu, gdy host nie stroi klienta', async () => {
    const at = new MiraklAtrapa()
    const adapter = defaultRegistry().create(ZAPIS, { integration: ACC, rawConfig: { baseUrl: MIRAKL_HOST, zapisWlaczony: true }, rawSecrets: { MIRAKL_API_KEY: MIRAKL_KEY }, fetch: at.fetch, now: () => NOW })
    const t0 = Date.now()
    await adapter.testConnection()
    await adapter.testConnection()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900) // 30 żądań/min = 2 s
  })

  it('odstęp wspólny dla konta: instancja odczytu i zapisu tego samego konta razem nie przekraczają 30/min', async () => {
    expect(MIRAKL_MIN_INTERVAL_MS).toBe(60_000 / MIRAKL_EMPIK_MANIFEST.rateLimit.requestsPerMinute)
    expect(MIRAKL_MIN_INTERVAL_MS).toBe(60_000 / MIRAKL_EMPIK_ZAPIS_MANIFEST.rateLimit.requestsPerMinute)
    const at = new MiraklAtrapa()
    const base = MIRAKL_HOST // pozostałe testy pliku stroją klienta (FAST), więc nie dzielą tego odstępu
    const opts = (key: string) => defaultRegistry().create(key, { integration: ACC, rawConfig: { baseUrl: base, zapisWlaczony: true }, rawSecrets: { MIRAKL_API_KEY: MIRAKL_KEY }, fetch: at.fetch, now: () => NOW })
    const odczyt = opts('mirakl.empik.v1')
    const zapis = opts(ZAPIS)
    const t0 = Date.now()
    // równolegle z dwóch instancji: trzy żądania to co najmniej dwa odstępy po 2 s
    await Promise.allSettled([odczyt.testConnection(), zapis.testConnection(), odczyt.testConnection()])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3900)
    expect(miraklAccountThrottle(base, MIRAKL_KEY)).toBe(miraklAccountThrottle(`${base}/`, MIRAKL_KEY))
    expect(miraklAccountThrottle(base, MIRAKL_KEY)).not.toBe(miraklAccountThrottle(base, 'inny-klucz'))
  }, 15_000)

  it('powtórka bezpieczna: brak odpowiedzi = PRZEJSCIOWY, ten sam stan drugi raz; zła ilość bez żądania', async () => {
    const { at, adapter } = make()
    at.putOffer('P1', 'SD-001')
    at.injectWriteFailure('SIEC_PO_WYKONANIU')
    expect((await adapter.pushStock([{ offerExternalId: 'P1', qty: 7 }], 'r')).kind).toBe('PRZEJSCIOWY')
    expect((await adapter.pushStock([{ offerExternalId: 'P1', qty: 7 }], 'r')).kind).toBe('OK')
    expect(at.stany.get('SD-001')).toBe(7)
    const n = at.zapytania.length
    expect((await adapter.pushStock([{ offerExternalId: 'P1', qty: -1 }], 'r2')).kind).toBe('TRWALY')
    expect((await adapter.pushStock([{ offerExternalId: 'P1', qty: 1.5 }], 'r3')).kind).toBe('TRWALY')
    expect(at.zapytania.length).toBe(n)
  })

  it('konto bez STO01 (404): TRWALY z jasnym powodem; 429 przejściowe', async () => {
    const { at, adapter } = make()
    at.putOffer('P1', 'SD-001')
    at.injectWriteFailure('BRAK_STO01')
    expect(await adapter.pushStock([{ offerExternalId: 'P1', qty: 1 }], 'r')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('niedostępny na tym koncie') })
    at.injectWriteFailure('LIMIT')
    expect((await adapter.pushStock([{ offerExternalId: 'P1', qty: 1 }], 'r')).kind).toBe('PRZEJSCIOWY')
  })

  it('nigdy OF24 (wysłanie niepełnej oferty zeruje jej pola): żadnego POST/PUT na /offers', async () => {
    const { at, adapter } = make()
    at.putOffer('P1', 'SD-001')
    await adapter.pushStock([{ offerExternalId: 'P1', qty: 1 }], 'r')
    expect(at.zapisy().map((z) => `${z.method} ${z.path}`)).toEqual(['POST /offers/stock/imports'])
  })
})

// ───: wynik importu stanów (STO02/STO03) i pamięć ofert ───────────

describe('Empik STO02/STO03: wynik importu stanów', () => {
  it('przyjęty import bez błędów: GOTOWE z liczbą przyjętych, bez raportu błędów', async () => {
    const { at, adapter } = make()
    at.putOffer('P1', 'SD-001')
    const r = await adapter.pushStock([{ offerExternalId: 'P1', qty: 4 }], 'r')
    expect(r).toMatchObject({ kind: 'OK', externalRef: 'STO01:1001' })
    expect(await adapter.getStockImportStatus('STO01:1001')).toEqual({ state: 'GOTOWE', przyjete: 1, odrzucone: 0, kodyOdrzuconych: [] })
    expect(at.zapytania.filter((z) => z.path.endsWith('/error_report'))).toEqual([])
  })

  it('wiersz odrzucony przez Empik (magazyn spoza konta): liczba i kod oferty z raportu, bez treści błędu', async () => {
    const { at, adapter } = make({ zapisWlaczony: true, magazynEmpik: 'ZLY' })
    at.putOffer('P1', 'SD-001')
    at.putOffer('P2', 'SD-002')
    await adapter.pushStock([{ offerExternalId: 'P1', qty: 1 }, { offerExternalId: 'P2', qty: 2 }], 'r')
    const st = await adapter.getStockImportStatus('STO01:1001')
    expect(st).toEqual({ state: 'GOTOWE', przyjete: 0, odrzucone: 2, kodyOdrzuconych: ['SD-001', 'SD-002'] })
    expect(JSON.stringify(st)).not.toContain('zmyślony błąd')
    expect(at.zapytania.map((z) => `${z.method} ${z.path}`)).toEqual(expect.arrayContaining(['GET /offers/stock/imports/1001/status', 'GET /offers/stock/imports/1001/error_report']))
  })

  it('pusta kolumna magazynu (stan całej oferty) przechodzi; import w toku = W_TOKU; cały plik odrzucony = NIEUDANE', async () => {
    const { at, adapter } = make()
    at.putOffer('P1', 'SD-001')
    at.odczytowWToku = 1
    await adapter.pushStock([{ offerExternalId: 'P1', qty: 1 }], 'r')
    expect(await adapter.getStockImportStatus('STO01:1001')).toEqual({ state: 'W_TOKU' })
    expect(await adapter.getStockImportStatus('STO01:1001')).toMatchObject({ state: 'GOTOWE', odrzucone: 0 })
    at.odczytowWToku = 0
    at.nastepnyImportNieudany = true
    await adapter.pushStock([{ offerExternalId: 'P1', qty: 2 }], 'r2')
    expect(await adapter.getStockImportStatus('STO01:1002')).toMatchObject({ state: 'NIEUDANE' })
  })

  it('zły identyfikator: TRWALY bez żądania; 503 przy odczycie: PRZEJSCIOWY; tylko GET (bez wyłącznika zapisu)', async () => {
    const { at, adapter } = make({})
    await expect(adapter.getStockImportStatus('STO01:../x')).rejects.toMatchObject({ kind: 'TRWALY' })
    await expect(adapter.getStockImportStatus('X:1')).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(at.zapytania).toEqual([])
    at.failNextGet(503)
    await expect(adapter.getStockImportStatus('STO01:5')).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    expect(at.zapisy()).toEqual([])
  })

  it('403/404 przy odczycie STO02 = NIEDOSTEPNY (brak dostępu), 401 = NIEDOSTEPNY (klucz); nie „odrzucone” i bez wyjątku', async () => {
    const { at, adapter } = make({})
    at.failNextGet(403)
    expect(await adapter.getStockImportStatus('STO01:5')).toEqual({ state: 'NIEDOSTEPNY', powod: 'BRAK_DOSTEPU', message: 'Mirakl STO02: HTTP 403' })
    // atrapa: nieznany import = 404
    expect(await adapter.getStockImportStatus('STO01:6')).toMatchObject({ state: 'NIEDOSTEPNY', powod: 'BRAK_DOSTEPU' })
    at.failNextGet(401)
    expect(await adapter.getStockImportStatus('STO01:5')).toMatchObject({ state: 'NIEDOSTEPNY', powod: 'KLUCZ' })
    at.failNextGet(400)
    await expect(adapter.getStockImportStatus('STO01:5')).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(at.zapisy()).toEqual([])
  })

  it('separator i cudzysłów w treści błędu nie przesuwają kolumny offer-sku', () => {
    expect(kodyZRaportuBledow('"error-message";"offer-sku";"quantity"\n"zły; magazyn ""X""";"A-1";"1"\n"b";"B-2";"2"\n')).toEqual({ wiersze: 2, kody: ['A-1', 'B-2'] })
  })

  it('raport błędów: kolumna offer-sku z nagłówka; bez niej sama liczba wierszy', () => {
    expect(kodyZRaportuBledow('"offer-sku";"quantity";"error-message"\n"A-1";"1";"x"\n"B-2";"2";"y"\n')).toEqual({ wiersze: 2, kody: ['A-1', 'B-2'] })
    expect(kodyZRaportuBledow('line,reason\n2,zly\n')).toEqual({ wiersze: 1, kody: [] })
    expect(kodyZRaportuBledow('')).toEqual({ wiersze: 0, kody: [] })
  })
})

describe('Empik: pamięć ofert przed zapisem stanów (pkt 3)', () => {
  it('nowy adapter tego samego konta nie czyta OF21 od nowa; po godzinie czyta', async () => {
    const at = new MiraklAtrapa()
    at.putOffer('P1', 'SD-001')
    const oferty = () => at.zapytania.filter((z) => z.path === '/offers').length
    await make(undefined, ZAPIS, at).adapter.pushStock([{ offerExternalId: 'P1', qty: 1 }], 'r1')
    const po1 = oferty()
    await make(undefined, ZAPIS, at).adapter.pushStock([{ offerExternalId: 'P1', qty: 2 }], 'r2')
    expect(oferty()).toBe(po1)
    await make(undefined, ZAPIS, at, new Date(NOW.getTime() + SHOP_SKU_TTL_MS)).adapter.pushStock([{ offerExternalId: 'P1', qty: 3 }], 'r3')
    expect(oferty()).toBeGreaterThan(po1)
    expect(at.stany.get('SD-001')).toBe(3)
  })

  it('nowa oferta w Empiku: przeładowanie mimo pamięci; inne konto nie dzieli pamięci', async () => {
    const at = new MiraklAtrapa()
    at.putOffer('P1', 'SD-001')
    await make(undefined, ZAPIS, at).adapter.pushStock([{ offerExternalId: 'P1', qty: 1 }], 'r1')
    at.putOffer('P2', 'SD-002')
    expect(await make(undefined, ZAPIS, at).adapter.pushStock([{ offerExternalId: 'P2', qty: 5 }], 'r2')).toMatchObject({ kind: 'OK' })
    expect(at.stany.get('SD-002')).toBe(5)
    const inne = defaultRegistry().create(ZAPIS, {
      integration: { ...ACC, id: 'EMPIK/drugie', channelAccountId: 'drugie' },
      rawConfig: { baseUrl: MIRAKL_HOST, zapisWlaczony: true },
      rawSecrets: { MIRAKL_API_KEY: MIRAKL_KEY },
      fetch: at.fetch,
      now: () => NOW,
      http: FAST,
    }) as Full
    const n = at.zapytania.filter((z) => z.path === '/offers').length
    await inne.pushStock([{ offerExternalId: 'P1', qty: 1 }], 'r3')
    expect(at.zapytania.filter((z) => z.path === '/offers').length).toBeGreaterThan(n)
  })
})

// ─── OR23 numer nadania, OR24 wysłane ────────────────────────────────────────

describe('Empik OR23 i OR24: numer nadania i wysłane', () => {
  it('przewoźnik z kodem z konfiguracji: carrier_code; bez kodu (także domyślnego): nazwa i adres śledzenia', async () => {
    const { at, adapter } = make({ zapisWlaczony: true, kodyPrzewoznikow: '{"DPD":"dpd-wlasny","PACZKOMATY":"x y"}' })
    at.putOrder({ id: 'E-2', state: 'SHIPPING', lines: [{ id: 'E-2-1', sku: 'P1', qty: 1 }] })
    expect(await adapter.setTracking('E-2', { carrier: 'DPD', number: '0000123456789U' }, 't1')).toEqual({ kind: 'OK', reference: 't1' })
    expect(at.tracking.get('E-2')).toEqual({ carrier_code: 'dpd-wlasny', tracking_number: '0000123456789U' })
    expect(await adapter.setTracking('E-2', { carrier: 'OSOBISTY', number: '6200001', url: 'https://sklep.example/s/6200001' }, 't2')).toEqual({ kind: 'OK', reference: 't2' })
    expect(at.tracking.get('E-2')).toEqual({ carrier_name: 'Odbiór osobisty', tracking_number: '6200001', carrier_url: 'https://sklep.example/s/6200001' })
  })

  it('bez kodów w koncie przewoźnicy z listy Empiku (SH21) idą z kodem, nie z nazwą; zły kod konta = domyślny', async () => {
    const { at, adapter } = make({ zapisWlaczony: true, kodyPrzewoznikow: '{"PACZKOMATY":"x y"}' })
    at.putOrder({ id: 'E-6', state: 'SHIPPING', lines: [{ id: 'E-6-1', sku: 'P1', qty: 1 }] })
    const kod = async (carrier: string, number: string) => {
      expect(await adapter.setTracking('E-6', { carrier, number, url: 'https://kurier.example/x' }, `t-${carrier}`)).toEqual({ kind: 'OK', reference: `t-${carrier}` })
      return at.tracking.get('E-6')
    }
    // zamówienie 10000000000001-A: paczkomat przez Base Courier; 10000000000002-A: salon Empik, DPD z literą na końcu
    expect(await kod('PACZKOMATY', '620000123456789012345678')).toEqual({ carrier_code: 'paczkomatyinpost', tracking_number: '620000123456789012345678' })
    expect(await kod('DPD_EMPIK', '1000123456789U')).toEqual({ carrier_code: 'dpd', tracking_number: '1000123456789U' })
    expect(await kod('DPD', '1000123456789U')).toEqual({ carrier_code: 'dpd', tracking_number: '1000123456789U' })
    expect(await kod('INPOST_KURIER', '520000123')).toEqual({ carrier_code: 'inpostpaczkakurierska', tracking_number: '520000123' })
    expect(await kod('GLS', 'GLS12345')).toEqual({ carrier_code: 'gls', tracking_number: 'GLS12345' })
    expect(await kod('ORLEN_PACZKA', '9000123')).toEqual({ carrier_code: 'ORLEN', tracking_number: '9000123' })
    expect(await kod('POCZTA_POLSKA', 'PX1234567')).toEqual({ carrier_code: 'pocztex', tracking_number: 'PX1234567' })
    expect(EMPIK_KODY_PRZEWOZNIKOW.PACZKOMATY).toBe('paczkomatyinpost')
  })

  it('odmowa OR23 (400) niesie treść komunikatu Empiku, oczyszczoną (bez e-maili i telefonów)', async () => {
    const { at, adapter } = make()
    at.putOrder({ id: 'E-7', state: 'SHIPPING', lines: [{ id: 'E-7-1', sku: 'P1', qty: 1 }] })
    at.injectWriteFailure('TRWALY')
    const r = await adapter.setTracking('E-7', { carrier: 'DPD', number: 'ABC123' }, 'x')
    expect(r).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('HTTP 400 (VALIDATION_ERROR)') })
    expect((r as { message: string }).message).toContain('Empik: „VALIDATION_ERROR: zmyślony komunikat atrapy”')
    expect(komunikatBleduMirakl('{"status":400,"message":"Carrier  \\n x for jan.kowalski@example.pl, tel. +48 600 100 200"}')).toBe('Carrier x for [e-mail], tel. [telefon]')
    expect(komunikatBleduMirakl('{"status":400,"errors":[{"field":"carrier_code","message":"must not be blank"}]}')).toBe('carrier_code: must not be blank')
    expect(komunikatBleduMirakl('<html>bramka</html>')).toBeNull()
    expect(komunikatBleduMirakl('')).toBeNull()
    expect(komunikatBleduMirakl(JSON.stringify({ message: 'x'.repeat(500) }))!.length).toBeLessThanOrEqual(200)
  })

  it('numer nadania: zły numer albo adres bez żądania; 503 przejściowe; brak odpowiedzi przejściowe (nadpisanie bezpieczne)', async () => {
    const { at, adapter } = make()
    at.putOrder({ id: 'E-2', state: 'SHIPPING', lines: [{ id: 'E-2-1', sku: 'P1', qty: 1 }] })
    expect((await adapter.setTracking('E-2', { carrier: 'DPD', number: 'a b' }, 'x')).kind).toBe('TRWALY')
    // adres śledzenia sprawdzany tylko przy przewoźniku bez kodu (z kodem Empik liczy adres sam)
    expect((await adapter.setTracking('E-2', { carrier: 'OSOBISTY', number: 'ABC123', url: 'http://bez-tls.example' }, 'x')).kind).toBe('TRWALY')
    expect(at.zapytania).toEqual([])
    at.injectWriteFailure('PRZEJSCIOWY')
    expect((await adapter.setTracking('E-2', { carrier: 'DPD', number: 'ABC123' }, 'x')).kind).toBe('PRZEJSCIOWY')
    at.injectWriteFailure('SIEC')
    expect((await adapter.setTracking('E-2', { carrier: 'DPD', number: 'ABC123' }, 'x')).kind).toBe('PRZEJSCIOWY')
  })

  it('OR24: SHIPPING → SHIPPED; drugi raz OK z odczytu stanu (idempotentnie); inny status niż SHIPPED odrzucony bez żądania', async () => {
    const { at, adapter } = make()
    at.putOrder({ id: 'E-3', state: 'SHIPPING', lines: [{ id: 'E-3-1', sku: 'P1', qty: 1 }] })
    expect(await adapter.setOrderStatus('E-3', 'SHIPPED', 's1')).toEqual({ kind: 'OK', reference: 's1' })
    expect(at.stateOf('E-3')).toBe('SHIPPED')
    expect(await adapter.setOrderStatus('E-3', 'SHIPPED', 's1')).toEqual({ kind: 'OK', reference: 's1', externalRef: 'SHIPPED' })
    const n = at.zapytania.length
    expect(await adapter.setOrderStatus('E-3', 'RECEIVED', 's2')).toMatchObject({ kind: 'TRWALY' })
    expect(at.zapytania.length).toBe(n)
  })

  it('„shipped” małymi literami (mapa zapisana z panelu przed poprawką) = SHIPPED, OR24 wychodzi', async () => {
    const { at, adapter } = make()
    at.putOrder({ id: 'E-8', state: 'SHIPPING', lines: [{ id: 'E-8-1', sku: 'P1', qty: 1 }] })
    expect(await adapter.setOrderStatus('E-8', 'shipped', 's8')).toEqual({ kind: 'OK', reference: 's8' })
    expect(at.stateOf('E-8')).toBe('SHIPPED')
  })

  it('wartość mapy statusów porównywana bez wielkości liter ze słownikiem kanału (Empik, Allegro), Woo bez zmian', () => {
    const empik = make().adapter.manifest
    expect(kanonicznyStatusKanalu('shipped', empik)).toBe('SHIPPED')
    expect(kanonicznyStatusKanalu(' Shipped ', empik)).toBe('SHIPPED')
    expect(kanonicznyStatusKanalu('wlasny', empik)).toBe('wlasny')
    expect(kanonicznyStatusKanalu('sent', ALLEGRO_ZAPIS_MANIFEST)).toBe('SENT')
    expect(kanonicznyStatusKanalu('ready_for_shipment', ALLEGRO_ZAPIS_MANIFEST)).toBe('READY_FOR_SHIPMENT')
    expect(kanonicznyStatusKanalu('completed', WOO_MANIFEST)).toBe('completed')
    expect(kanonicznyStatusKanalu('wc-wyslane', WOO_MANIFEST)).toBe('wc-wyslane')
    expect(kanonicznyStatusKanalu('x', null)).toBe('x')
    // mapa zapisana z panelu 20.11.2026 (WYSLANE: „shipped”) działa bez ręcznej poprawki
    expect(mapaStatusow({ statusy: { WYSLANE: 'shipped' } }, empik)).toEqual({ mapa: { WYSLANE: 'SHIPPED' }, wlasna: true })
    expect(empik.channelBehavior?.trackingBeforeStatus).toBe(true)
  })

  it('OR24 na zamówieniu jeszcze nieopłaconym: TRWALY ze stanem; zgubiona odpowiedź: PRZEJSCIOWY, potem OK', async () => {
    const { at, adapter } = make()
    at.putOrder({ id: 'E-4', state: 'WAITING_DEBIT_PAYMENT', lines: [{ id: 'E-4-1', sku: 'P1', qty: 1 }] })
    expect(await adapter.setOrderStatus('E-4', 'SHIPPED', 's')).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('WAITING_DEBIT_PAYMENT') })
    at.putOrder({ id: 'E-5', state: 'SHIPPING', lines: [{ id: 'E-5-1', sku: 'P1', qty: 1 }] })
    at.injectWriteFailure('SIEC_PO_WYKONANIU')
    expect((await adapter.setOrderStatus('E-5', 'SHIPPED', 's')).kind).toBe('PRZEJSCIOWY')
    expect((await adapter.setOrderStatus('E-5', 'SHIPPED', 's')).kind).toBe('OK')
  })

  it('kody przewoźników: tylko znane przewoźniki i bezpieczne kody; zły JSON = brak kodów', () => {
    expect(carrierCodesOf('{"DPD":"dpd","NIEZNANY":"a","DPD_EMPIK":"x y","toString":"t"}')).toEqual({ DPD: 'dpd' })
    expect(carrierCodesOf('nie json')).toEqual({})
    expect(carrierCodesOf(undefined)).toEqual({})
  })
})

describe('Empik: ustawienia przyjmowania i opis w historii', () => {
  it('lista wyboru „gdy brakuje towaru”: tylko czekaj/odrzuc, w obu kluczach Empiku', () => {
    for (const m of [MIRAKL_EMPIK_MANIFEST, MIRAKL_EMPIK_ZAPIS_MANIFEST]) {
      expect(m.config.find((f) => f.key === 'akceptacjaBraki')?.options?.map((o) => o.value)).toEqual(['czekaj', 'odrzuc'])
      expect(validateAccountConfig(m, { baseUrl: MIRAKL_HOST, akceptacjaBraki: 'odrzuc', akceptacjaAlertGodzin: '6' })).toEqual({ config: { baseUrl: MIRAKL_HOST, akceptacjaBraki: 'odrzuc', akceptacjaAlertGodzin: 6 }, problems: [] })
      expect(validateAccountConfig(m, { baseUrl: MIRAKL_HOST, akceptacjaBraki: 'zawsze' }).problems).toEqual(['ustawienie akceptacjaBraki ma zły format'])
    }
  })

  it('historia zamówienia: powód decyzji i liczba odrzuconych pozycji, bez danych klienta', () => {
    expect(opisZdarzenia('EMPIK_PRZYJECIE_DO_DECYZJI', { zamowienie: 'E-1', powod: 'pozycja E-1-1: brak towaru' })).toBe('Empik: przyjęcie czeka na decyzję: pozycja E-1-1: brak towaru')
    expect(opisZdarzenia('EMPIK_PRZYJETE', { decyzje: [{ pozycja: 'a', przyjeta: true }, { pozycja: 'b', przyjeta: false }] })).toBe('Przyjęte w Empiku (odrzucone pozycje: 1)')
    expect(opisZdarzenia('EMPIK_ZAAKCEPTOWALBYM', { decyzje: [{ pozycja: 'a', przyjeta: true }], powod: 'konto w podglądzie' })).toBe('Empik: zaakceptowałbym zamówienie (podgląd, nic nie wysłane)')
  })
})

describe('kontrakt: stan z wyniku „już rozstrzygnięte”', () => {
  it('alreadyDecidedState', () => {
    expect(alreadyDecidedState(`${ACCEPT_ALREADY_DECIDED}:CANCELED`)).toBe('CANCELED')
    expect(alreadyDecidedState(ACCEPT_ALREADY_DECIDED)).toBe('?')
    expect(alreadyDecidedState('STO01:1')).toBeNull()
    expect(alreadyDecidedState(undefined)).toBeNull()
  })
})
