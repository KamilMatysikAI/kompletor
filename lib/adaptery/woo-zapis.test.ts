// adapter `woo.rest.zapis.v1` na sklepie WC REST w pamięci (za prawdziwym klientem HTTP adaptera).
// Suita kontraktowa + zapis stanów (paczki, warianty, wynik per pozycja), statusu (bez nadpisywania statusów końcowych,
// warunek „tylko nieopłacone”), numeru nadania (notatka, pole meta, bez dubli), wyłącznik i osobny klucz zapisu.
// Dane zmyślone; żadnego prawdziwego sklepu.
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../zrodla/http'
import { WooWriter } from '../zrodla/woo-zapis'
import { defaultRegistry } from './domyslne'
import { etapDoSklepu, hasOrderStatusWriter, hasStockWriter, hasTrackingWriter, STATUS_MAP_KEYS, type ChannelAdapter, type StatusMap, type StatusMapKey } from './kontrakt'
import { kluczZamowienia, zapisStatusu } from '../kanaly/zapis-host'
import { manifestProblems } from './rejestr'
import { type ContractHarness, PII_SENTINELS, runAdapterContract, type SeedOrder } from './suita-kontraktowa'
import type { FakeWriteFailure } from './falszywy'
import { WOO_ZAPIS_KEY, WOO_ZAPIS_MANIFEST, wooTrackingNote } from './woo-zapis'
import { executeWrite } from './zapis'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const ACC = { organizationId: 'test_a', kind: 'channel' as const, id: 'WOO/test', channel: 'WOO' as const, channelAccountId: 'test', name: 'Sklep testowy' }
const FAST = { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 }
const KEYS = { WOO_CONSUMER_KEY: 'ck_odczyt', WOO_CONSUMER_SECRET: 'cs_odczyt', WOO_WRITE_KEY: 'ck_zapis', WOO_WRITE_SECRET: 'cs_zapis' }
const basic = (k: string, s: string) => `Basic ${Buffer.from(`${k}:${s}`).toString('base64')}`

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const iso19 = (d: Date) => d.toISOString().slice(0, 19)

function wooRaw(o: SeedOrder): Record<string, unknown> {
  const status = o.state === 'open' ? 'on-hold' : o.state === 'cancelled' ? 'cancelled' : 'completed'
  return {
    id: Number(o.externalId),
    status,
    currency: 'PLN',
    date_created_gmt: iso19(o.createdAt),
    date_modified_gmt: iso19(o.modifiedAt),
    date_paid_gmt: null,
    total: (o.qty * 12.3).toFixed(2),
    payment_method: 'bacs',
    payment_method_title: 'Przelew',
    billing: { first_name: PII_SENTINELS[0], email: PII_SENTINELS[1], phone: PII_SENTINELS[2], address_1: PII_SENTINELS[3] },
    shipping: { first_name: PII_SENTINELS[0], address_1: PII_SENTINELS[3] },
    customer_note: PII_SENTINELS[4],
    meta_data: [],
    line_items: [{ id: Number(o.externalId) * 10, product_id: Number(o.offer), variation_id: 0, quantity: o.qty, total: (o.qty * 10).toFixed(2), total_tax: (o.qty * 2.3).toFixed(2), meta_data: [] }],
    shipping_lines: [{ method_title: 'Kurier DPD' }],
  }
}

/** Sklep WC REST w pamięci: zamówienia, notatki, produkty i warianty; dziennik żądań (metoda, ścieżka, klucz). */
class Sklep {
  readonly orders = new Map<string, Record<string, unknown>>()
  readonly notes = new Map<string, { note: string; customer_note: boolean }[]>()
  readonly stock = new Map<string, number>() // „pid” albo „pid/vid”
  readonly log: { method: string; path: string; auth: string; body?: unknown }[] = []
  /** Kolejne awarie zapisu: status HTTP albo „siec-po” (zapis wykonany, odpowiedź zgubiona) / „siec” (niewykonany). */
  failures: (number | 'siec-po' | 'siec')[] = []
  /** Pozycje paczki, które sklep odrzuca błędem pozycji. */
  readonly rejectIds = new Set<number>()
  /** Następny odczyt listy zamówień kończy się tym kodem HTTP. */
  listFail: number | null = null

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    const method = init?.method ?? 'GET'
    const path = u.pathname.replace(/^\/wp-json\/wc\/v3/, '')
    const auth = String((init?.headers as Record<string, string>)['Authorization'])
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    this.log.push({ method, path, auth, body })
    expect(u.origin).toBe('https://sklep.example')
    if (method !== 'GET') {
      expect(auth).toBe(basic(KEYS.WOO_WRITE_KEY, KEYS.WOO_WRITE_SECRET)) // zapis tylko kluczem zapisu
      const f = this.failures.shift()
      if (f === 'siec') throw new TypeError('fetch failed')
      if (typeof f === 'number') return json({ code: 'blad' }, f)
      const r = this.write(method, path, body)
      if (f === 'siec-po') throw new TypeError('fetch failed')
      return r
    }
    expect(auth).toBe(basic(KEYS.WOO_CONSUMER_KEY, KEYS.WOO_CONSUMER_SECRET)) // odczyt kluczem odczytu
    if (path === '/orders') {
      if (this.listFail) {
        const st = this.listFail
        this.listFail = null
        return new Response('awaria', { status: st })
      }
      const all = [...this.orders.values()].sort((a, b) => String(a['date_modified_gmt']).localeCompare(String(b['date_modified_gmt'])))
      const after = u.searchParams.get('modified_after')
      const rows = all.filter((o) => !after || String(o['date_modified_gmt']) > after)
      return json(rows, 200, { 'x-wp-total': String(rows.length), 'x-wp-totalpages': '1' })
    }
    if (path === '/products') return json([], 200, { 'x-wp-total': '0', 'x-wp-totalpages': '1' })
    if (path === '/settings/products/woocommerce_hold_stock_minutes') return json({ value: '60' })
    let m = /^\/orders\/(\d+)$/.exec(path)
    if (m) return this.orders.has(m[1]!) ? json(this.orders.get(m[1]!)) : json({ code: 'woocommerce_rest_shop_order_invalid_id' }, 404)
    m = /^\/orders\/(\d+)\/notes$/.exec(path)
    if (m) return this.orders.has(m[1]!) ? json((this.notes.get(m[1]!) ?? []).map((n, i) => ({ id: i + 1, ...n }))) : json({ code: 'invalid' }, 404)
    return json({ code: 'rest_no_route' }, 404)
  }

  private write(method: string, path: string, body: Record<string, unknown>): Response {
    let m = /^\/products(?:\/(\d+)\/variations)?\/batch$/.exec(path)
    if (m && method === 'POST') {
      const parent = m[1]
      const update = (body['update'] as { id: number; stock_quantity: number }[]).map((x) => {
        if (this.rejectIds.has(x.id)) return { id: x.id, error: { code: 'woocommerce_rest_product_invalid_id', message: 'nie ma' } }
        this.stock.set(parent ? `${parent}/${x.id}` : String(x.id), x.stock_quantity)
        return { id: x.id, stock_quantity: x.stock_quantity }
      })
      return json({ update })
    }
    m = /^\/orders\/(\d+)$/.exec(path)
    if (m && method === 'PUT') {
      const o = this.orders.get(m[1]!)
      if (!o) return json({ code: 'invalid' }, 404)
      if (body['status']) o['status'] = body['status']
      for (const md of (body['meta_data'] as { key: string; value: string }[] | undefined) ?? []) {
        const meta = o['meta_data'] as { key: string; value: string }[]
        const hit = meta.find((x) => x.key === md.key)
        if (hit) hit.value = md.value
        else meta.push({ ...md })
      }
      return json(o)
    }
    m = /^\/orders\/(\d+)\/notes$/.exec(path)
    if (m && method === 'POST') {
      const list = this.notes.get(m[1]!) ?? []
      list.push({ note: String(body['note']), customer_note: body['customer_note'] === true })
      this.notes.set(m[1]!, list)
      return json({ id: list.length }, 201)
    }
    return json({ code: 'rest_no_route' }, 404)
  }

  writes(): string[] {
    return this.log.filter((l) => l.method !== 'GET').map((l) => `${l.method} ${l.path}`)
  }
}

function adapter(sklep: Sklep, config: Record<string, unknown> = { zapisWlaczony: true }, secrets: Record<string, string> = KEYS): ChannelAdapter {
  return defaultRegistry().create(WOO_ZAPIS_KEY, { integration: ACC, rawConfig: { baseUrl: 'https://sklep.example', ...config }, rawSecrets: secrets, fetch: sklep.fetch, now: () => NOW, http: FAST })
}

const zapisHarness: ContractHarness = {
  name: `${WOO_ZAPIS_KEY} (WC REST w pamięci, zapis włączony)`,
  now: NOW,
  setup() {
    const sklep = new Sklep()
    const a = adapter(sklep)
    const inject = (f: FakeWriteFailure) => {
      sklep.failures.push(f === 'PRZEJSCIOWY' ? 503 : f === 'TRWALY' ? 400 : f === 'NIEJEDNOZNACZNY_WYKONANY' ? 'siec-po' : 'siec')
    }
    return {
      adapter: a,
      putOrder: (o) => sklep.orders.set(o.externalId, wooRaw(o)),
      corruptOrder: (id) => {
        ;(sklep.orders.get(id)!['line_items'] as Record<string, unknown>[])[0]!['quantity'] = 'abc'
      },
      failNextList: (kind) => (sklep.listFail = kind === 'PRZEJSCIOWY' ? 503 : 401),
      requests: () => sklep.log.map((l) => l.method),
      injectWriteFailure: inject,
      absoluteStockWrite: true,
      statusWrite: { target: 'processing', read: (id) => String(sklep.orders.get(id)?.['status'] ?? '') || undefined },
      readTracking: (id) => (sklep.notes.get(id) ?? []).map((n) => /Numer nadania: (\S+)/.exec(n.note)?.[1] ?? ''),
      writeDisabled: () => adapter(sklep, { zapisWlaczony: false }),
    }
  },
}

describe('woo.rest.zapis.v1: manifest', () => {
  it('poprawny, z zapisem za wyłącznikiem, osobnym kluczem zapisu i zachowaniem kanału', () => {
    const m = defaultRegistry().get(WOO_ZAPIS_KEY)!.manifest
    expect(manifestProblems(m)).toEqual([])
    expect(m.readOnly).toBe(false)
    expect(m.capabilities).toEqual(expect.arrayContaining(['orders.feed', 'stock.write', 'order.status.write', 'order.tracking.write', 'reference.find']))
    expect(m.secrets.find((s) => s.name === 'WOO_WRITE_KEY')).toMatchObject({ required: false })
    expect(m.channelBehavior).toMatchObject({ stockModel: 'self-decrementing', unpaidGuard: true, defaultStatusMap: { WYSLANE: 'completed', ANULOWANE_NIEOPLACONE: 'cancelled' } })
  })

  it('klient zapisu: tylko ścieżki z białej listy', async () => {
    expect(WooWriter.allowed('POST', '/products/batch')).toBe(true)
    expect(WooWriter.allowed('DELETE', '/orders/1')).toBe(false)
    expect(WooWriter.allowed('POST', '/orders')).toBe(false)
    expect(WooWriter.allowed('PUT', '/products/1')).toBe(false)
    const w = new WooWriter('https://sklep.example', 'k', 's', async () => json({}))
    await expect(w.send('PUT', '/settings/general/x', {})).rejects.toThrow(/niedozwolony/)
  })
})

describe('woo.rest.zapis.v1: wyłącznik i klucz zapisu', () => {
  it.each([[{}], [{ zapisWlaczony: false }], [{ zapisWlaczony: 'false' }]])('bez zapisWlaczony (%j): TRWALY, zero żądań (także GET)', async (config) => {
    const sklep = new Sklep()
    sklep.orders.set('5', wooRaw({ externalId: '5', state: 'open', offer: '1', qty: 1, createdAt: NOW, modifiedAt: NOW }))
    const a = adapter(sklep, config)
    if (!hasStockWriter(a) || !hasOrderStatusWriter(a) || !hasTrackingWriter(a)) throw new Error('brak zdolności')
    expect(await a.pushStock([{ offerExternalId: '1', qty: 2 }], 'r1')).toMatchObject({ kind: 'TRWALY', message: /wyłączony/ })
    expect(await a.setOrderStatus('5', 'completed', 'r2')).toMatchObject({ kind: 'TRWALY' })
    expect(await a.setTracking('5', { number: 'ABC12345', carrier: 'DPD' }, 'r3')).toMatchObject({ kind: 'TRWALY' })
    expect(sklep.log).toEqual([])
  })

  it('zapis włączony bez klucza zapisu: TRWALY z powodem, zero żądań; klucz odczytu nie służy do zapisu', async () => {
    const sklep = new Sklep()
    const a = adapter(sklep, { zapisWlaczony: true }, { WOO_CONSUMER_KEY: 'ck_odczyt', WOO_CONSUMER_SECRET: 'cs_odczyt' })
    if (!hasStockWriter(a)) throw new Error('brak zdolności')
    expect(await a.pushStock([{ offerExternalId: '1', qty: 2 }], 'r1')).toMatchObject({ kind: 'TRWALY', message: /WOO_WRITE_KEY/ })
    expect(sklep.log).toEqual([])
  })
})

describe('woo.rest.zapis.v1: stany', () => {
  it('produkty proste i warianty w osobnych paczkach po 100; wynik per pozycja', async () => {
    const sklep = new Sklep()
    const a = adapter(sklep)
    if (!hasStockWriter(a)) throw new Error('brak zdolności')
    const items = [
      ...Array.from({ length: 150 }, (_, i) => ({ offerExternalId: String(1000 + i), qty: i })),
      { offerExternalId: '50/51', qty: 3 },
      { offerExternalId: '50/52', qty: 0 },
      { offerExternalId: 'zly', qty: 1 },
    ]
    sklep.rejectIds.add(1005)
    const out = await a.pushStock(items, 'ref')
    expect(sklep.writes()).toEqual(['POST /products/batch', 'POST /products/batch', 'POST /products/50/variations/batch'])
    expect(sklep.log.filter((l) => l.path === '/products/batch').map((l) => (l.body as { update: unknown[] }).update.length)).toEqual([100, 50])
    expect(sklep.stock.get('1010')).toBe(10)
    expect(sklep.stock.get('50/51')).toBe(3)
    expect(sklep.stock.get('50/52')).toBe(0)
    expect(out.kind).toBe('TRWALY')
    if (out.kind === 'OK') throw new Error('oczekiwany błąd')
    expect(out.failedItems?.map((f) => f.offerExternalId).sort()).toEqual(['1005', 'zly'])
    // wysyłamy tylko id i ilość (bez zmiany manage_stock, cen, nazw)
    expect(Object.keys((sklep.log[0]!.body as { update: object[] }).update[0]!)).toEqual(['id', 'stock_quantity'])
  })

  it('503 i zerwane połączenie = PRZEJSCIOWY (zapis bezwzględny); 401 = TRWALY', async () => {
    const sklep = new Sklep()
    const a = adapter(sklep)
    if (!hasStockWriter(a)) throw new Error('brak zdolności')
    sklep.failures.push(503, 'siec-po', 401)
    expect((await a.pushStock([{ offerExternalId: '1', qty: 1 }], 'a')).kind).toBe('PRZEJSCIOWY')
    expect((await a.pushStock([{ offerExternalId: '1', qty: 1 }], 'b')).kind).toBe('PRZEJSCIOWY')
    const r = await a.pushStock([{ offerExternalId: '1', qty: 1 }], 'c')
    expect(r).toMatchObject({ kind: 'TRWALY', message: /bez prawa zapisu/ })
  })
})

describe('woo.rest.zapis.v1: status zamówienia', () => {
  const seed = (sklep: Sklep, id: string, status: string, extra: Record<string, unknown> = {}) =>
    sklep.orders.set(id, { ...wooRaw({ externalId: id, state: 'open', offer: '1', qty: 1, createdAt: NOW, modifiedAt: NOW }), status, ...extra })

  it('zmienia przez PUT tylko przy innym statusie; statusów końcowych nie nadpisuje', async () => {
    const sklep = new Sklep()
    const a = adapter(sklep)
    if (!hasOrderStatusWriter(a)) throw new Error('brak zdolności')
    seed(sklep, '1', 'processing')
    seed(sklep, '2', 'refunded')
    seed(sklep, '3', 'completed')
    expect(await a.setOrderStatus('1', 'completed', 'r1')).toMatchObject({ kind: 'OK' })
    expect(sklep.orders.get('1')!['status']).toBe('completed')
    expect(await a.setOrderStatus('2', 'cancelled', 'r2')).toMatchObject({ kind: 'OK', externalRef: 'bez-zmian:refunded' })
    expect(await a.setOrderStatus('3', 'completed', 'r3')).toMatchObject({ kind: 'OK', externalRef: 'bez-zmian:completed' })
    expect(sklep.writes()).toEqual(['PUT /orders/1'])
    expect(sklep.log.find((l) => l.method === 'PUT')!.body).toEqual({ status: 'completed' })
  })

  it('nie cofa statusu (completed → processing, processing → on-hold); anulowanie z processing przechodzi', async () => {
    const sklep = new Sklep()
    const a = adapter(sklep)
    if (!hasOrderStatusWriter(a)) throw new Error('brak zdolności')
    seed(sklep, '1', 'completed')
    seed(sklep, '2', 'processing')
    seed(sklep, '3', 'processing')
    expect(await a.setOrderStatus('1', 'processing', 'r1')).toMatchObject({ kind: 'OK', externalRef: 'bez-zmian:completed' })
    expect(await a.setOrderStatus('2', 'on-hold', 'r2')).toMatchObject({ kind: 'OK', externalRef: 'bez-zmian:processing' })
    expect(await a.setOrderStatus('3', 'cancelled', 'r3')).toMatchObject({ kind: 'OK' })
    expect(sklep.writes()).toEqual(['PUT /orders/3'])
    expect(sklep.orders.get('1')!['status']).toBe('completed')
  })

  it('anulowanie nieopłaconego: płatność w sklepie = TRWALY bez zapisu; nieopłacone = anulowane', async () => {
    const sklep = new Sklep()
    const a = adapter(sklep)
    if (!hasOrderStatusWriter(a)) throw new Error('brak zdolności')
    seed(sklep, '1', 'on-hold', { date_paid_gmt: '2026-10-25T10:00:00' })
    seed(sklep, '2', 'processing')
    seed(sklep, '3', 'on-hold')
    expect(await a.setOrderStatus('1', 'cancelled', 'r1', { onlyIfUnpaid: true })).toMatchObject({ kind: 'TRWALY', message: /opłacone/ })
    expect(await a.setOrderStatus('2', 'cancelled', 'r2', { onlyIfUnpaid: true })).toMatchObject({ kind: 'TRWALY' })
    expect(await a.setOrderStatus('3', 'cancelled', 'r3', { onlyIfUnpaid: true })).toMatchObject({ kind: 'OK' })
    expect(sklep.writes()).toEqual(['PUT /orders/3'])
  })

  it('failed (nieudana płatność) jest otwarte: completed przechodzi, cancelled nieopłaconego przechodzi, opłaconego nie', async () => {
    const sklep = new Sklep()
    const a = adapter(sklep)
    if (!hasOrderStatusWriter(a)) throw new Error('brak zdolności')
    seed(sklep, '1', 'failed') // klient zapłacił przelewem, obsługa oznaczyła wpłatę, paczka wysłana
    seed(sklep, '2', 'failed') // termin płatności minął: anulowanie nieopłaconego
    seed(sklep, '3', 'failed', { date_paid_gmt: '2026-10-25T10:00:00' }) // opłacone w sklepie: nie anulujemy
    expect(await a.setOrderStatus('1', 'completed', 'r1')).toMatchObject({ kind: 'OK' })
    expect(await a.setOrderStatus('2', 'cancelled', 'r2', { onlyIfUnpaid: true })).toMatchObject({ kind: 'OK' })
    expect(await a.setOrderStatus('3', 'cancelled', 'r3', { onlyIfUnpaid: true })).toMatchObject({ kind: 'TRWALY', message: /opłacone/ })
    expect(sklep.writes()).toEqual(['PUT /orders/1', 'PUT /orders/2'])
    expect(sklep.orders.get('1')!['status']).toBe('completed')
    expect(sklep.orders.get('2')!['status']).toBe('cancelled')
    expect(sklep.orders.get('3')!['status']).toBe('failed')
  })

  it('status „Nowe” nie idzie do sklepu, więc nie nadpisze failed (ani z mapy konta, ani z nadpisania statusu firmy)', () => {
    expect(STATUS_MAP_KEYS as readonly string[]).not.toContain('NOWE')
    expect(etapDoSklepu('NOWE')).toBe(false)
    expect(Object.keys(WOO_ZAPIS_MANIFEST.channelBehavior?.defaultStatusMap ?? {})).not.toContain('NOWE')
    const mapa = { ...WOO_ZAPIS_MANIFEST.channelBehavior?.defaultStatusMap, ['NOWE' as StatusMapKey]: 'pending' } as StatusMap
    const nowe = { status: 'NOWE' as const, cancelReason: null, carrier: null, companyStatus: null }
    expect(kluczZamowienia(nowe, WOO_ZAPIS_MANIFEST)).toBeNull()
    expect(zapisStatusu(nowe, { mapa, mapaFirmy: {}, manifest: WOO_ZAPIS_MANIFEST }, [])).toBeNull()
  })

  it('zgubiona odpowiedź: NIEJEDNOZNACZNY → odszukanie po stanie zamówienia (wykonane = OK, nie = PRZEJSCIOWY); 5xx też', async () => {
    const sklep = new Sklep()
    const a = adapter(sklep)
    if (!hasOrderStatusWriter(a)) throw new Error('brak zdolności')
    seed(sklep, '1', 'processing')
    seed(sklep, '2', 'processing')
    sklep.failures.push('siec-po')
    expect((await executeWrite(a, 'r1', () => a.setOrderStatus('1', 'completed', 'r1'))).kind).toBe('OK')
    sklep.failures.push('siec')
    expect((await executeWrite(a, 'r2', () => a.setOrderStatus('2', 'completed', 'r2'))).kind).toBe('PRZEJSCIOWY')
    expect(sklep.orders.get('2')!['status']).toBe('processing')
    sklep.failures.push(502)
    expect((await executeWrite(a, 'r3', () => a.setOrderStatus('2', 'completed', 'r3'))).kind).toBe('PRZEJSCIOWY')
    sklep.failures.push(400)
    expect((await a.setOrderStatus('2', 'completed', 'r4')).kind).toBe('TRWALY')
  })
})

describe('woo.rest.zapis.v1: numer nadania', () => {
  const seed = (sklep: Sklep, id: string) => sklep.orders.set(id, wooRaw({ externalId: id, state: 'open', offer: '1', qty: 1, createdAt: NOW, modifiedAt: NOW }))
  const T = { number: '1000123456789U', carrier: 'DPD' }

  it('domyślnie prywatna notatka, bez dubla przy powtórce; dla klienta tylko z ustawienia', async () => {
    const sklep = new Sklep()
    seed(sklep, '1')
    const a = adapter(sklep)
    if (!hasTrackingWriter(a)) throw new Error('brak zdolności')
    expect((await a.setTracking('1', T, 'r1')).kind).toBe('OK')
    expect((await a.setTracking('1', T, 'r2')).kind).toBe('OK')
    expect(sklep.notes.get('1')).toEqual([{ note: wooTrackingNote(T), customer_note: false }])
    const b = adapter(sklep, { zapisWlaczony: true, nadanieDlaKlienta: true })
    if (!hasTrackingWriter(b)) throw new Error('brak zdolności')
    seed(sklep, '2')
    await b.setTracking('2', T, 'r3')
    expect(sklep.notes.get('2')![0]!.customer_note).toBe(true)
    // notatka zawiera tylko numer i przewoźnika; nieznany przewoźnik bez „(BRAK)”
    expect(wooTrackingNote(T)).toBe('Numer nadania: 1000123456789U (DPD)')
    expect(wooTrackingNote({ number: 'ABC12345', carrier: 'BRAK' })).toBe('Numer nadania: ABC12345')
  })

  it('notatka klienta z tym samym ciągiem nie blokuje naszej notatki', async () => {
    const sklep = new Sklep()
    seed(sklep, '1')
    sklep.notes.set('1', [{ note: 'Klient pyta o paczkę 1000123456789U', customer_note: false }])
    const a = adapter(sklep)
    if (!hasTrackingWriter(a)) throw new Error('brak zdolności')
    expect((await a.setTracking('1', T, 'r1')).kind).toBe('OK')
    expect(sklep.notes.get('1')!.map((n) => n.note)).toEqual(['Klient pyta o paczkę 1000123456789U', 'Numer nadania: 1000123456789U (DPD)'])
  })

  it('pole meta wtyczki śledzenia (bez notatki); bez żadnego miejsca = TRWALY', async () => {
    const sklep = new Sklep()
    seed(sklep, '1')
    const a = adapter(sklep, { zapisWlaczony: true, nadanieNotatka: false, nadanieMetaKlucz: '_tracking_number' })
    if (!hasTrackingWriter(a)) throw new Error('brak zdolności')
    expect((await a.setTracking('1', T, 'r1')).kind).toBe('OK')
    expect((await a.setTracking('1', T, 'r2')).kind).toBe('OK')
    expect(sklep.writes()).toEqual(['PUT /orders/1'])
    expect(sklep.orders.get('1')!['meta_data']).toEqual([{ key: '_tracking_number', value: T.number }])
    const none = adapter(sklep, { zapisWlaczony: true, nadanieNotatka: false })
    if (!hasTrackingWriter(none)) throw new Error('brak zdolności')
    expect((await none.setTracking('1', T, 'r3')).kind).toBe('TRWALY')
  })

  it('zgubiona odpowiedź przy notatce: odszukanie znajduje notatkę (OK), brak notatki = PRZEJSCIOWY; zły numer = TRWALY', async () => {
    const sklep = new Sklep()
    seed(sklep, '1')
    seed(sklep, '2')
    const a = adapter(sklep)
    if (!hasTrackingWriter(a)) throw new Error('brak zdolności')
    sklep.failures.push('siec-po')
    expect((await executeWrite(a, 'r1', () => a.setTracking('1', T, 'r1'))).kind).toBe('OK')
    sklep.failures.push('siec')
    expect((await executeWrite(a, 'r2', () => a.setTracking('2', T, 'r2'))).kind).toBe('PRZEJSCIOWY')
    expect(sklep.notes.get('1')).toHaveLength(1)
    expect((await a.setTracking('1', { number: 'zły numer', carrier: 'DPD' }, 'r3')).kind).toBe('TRWALY')
  })
})

runAdapterContract(zapisHarness)
