// `allegro.zapis.v1` na atrapie HTTP (tests/allegro-zapis-atrapa.ts): suita kontraktowa z zapisem,
// komendy stanów (deterministyczny commandId, powtórka bez drugiej komendy, wynik częściowy przez failedItems), status
// realizacji („już ustawione” bez zapisu, warunek płatności), numer nadania (bez dubla), strażnik ścieżek zapisu.
// Dane fikcyjne, zero połączeń z prawdziwym Allegro.
import { describe, expect, it } from 'vitest'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, OFFERS_WRITE, ORDERS_WRITE, UA } from '@/tests/allegro-zapis-atrapa'
import { AllegroWriter, assertAllegroWritePath } from '../zrodla/allegro-zapis'
import { ReadOnlyViolation } from '../zrodla/http'
import { ALLEGRO_SECRETS as S } from './allegro'
import { ALLEGRO_ZAPIS_KEY, AllegroZapisAdapter, FUNKCJA_STANY, FUNKCJA_ZAMOWIENIA, OFFERS_PER_COMMAND, stockCommands, ZAPIS_WYLACZONY } from './allegro-zapis'
import { defaultRegistry } from './domyslne'
import { hasOrderStatusWriter, hasStockWriter, hasTrackingWriter } from './kontrakt'
import { deriveReference } from './rejestr'
import { runAdapterContract } from './suita-kontraktowa'
import { executeWrite } from './zapis'

const NOW = new Date('2026-11-06T10:00:00.000Z')
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
const FORM = '29a8e3c0-7f1b-11ef-9d6f-0d1c5b7a1e01'
const integration = { organizationId: 'org', kind: 'channel' as const, id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO' as const, channelAccountId: '71045' }

function make(fake: FakeAllegroZapis, config: Record<string, unknown> = { zapisWlaczony: true }): AllegroZapisAdapter {
  const pair = fake.base.issuePair()
  const a = defaultRegistry().create(ALLEGRO_ZAPIS_KEY, {
    integration,
    rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA, ...config },
    rawSecrets: { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: iso(600) },
    fetch: fake.fetch,
    now: () => NOW,
    http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0, pollDelayMs: 0 },
    persistSecrets: async () => {},
  })
  if (!(a instanceof AllegroZapisAdapter)) throw new Error('zły adapter')
  return a
}

function fakeNow(): FakeAllegroZapis {
  const f = new FakeAllegroZapis()
  f.base.clock = () => NOW.getTime()
  return f
}

runAdapterContract({
  name: `${ALLEGRO_ZAPIS_KEY} (atrapa HTTP z zapisem)`,
  now: NOW,
  setup() {
    const fake = fakeNow()
    const adapter = make(fake)
    return {
      adapter,
      putOrder(s) {
        fake.base.putForm({
          id: s.externalId,
          status: s.state === 'cancelled' ? 'CANCELLED' : 'READY_FOR_PROCESSING',
          fulfillment: s.state === 'fulfilled' ? 'SENT' : 'NEW',
          lines: [{ id: `${s.externalId}-1`, offerId: s.offer, qty: s.qty, price: 12.5 }],
          updatedAt: s.modifiedAt.toISOString(),
          boughtAt: s.createdAt.toISOString(),
          paid: 12.5 * s.qty,
        })
      },
      corruptOrder(id) {
        ;(fake.base.forms.get(id)!['lineItems'] as Record<string, unknown>[])[0]!['quantity'] = 'abc'
      },
      failNextList(kind) {
        fake.base.apiFailures.push({ status: kind === 'PRZEJSCIOWY' ? 503 : 400 })
      },
      requests: () => fake.requests.filter((r) => r !== 'POST /auth/oauth/token').map((r) => r.split(' ')[0]!),
      injectWriteFailure: (f) => fake.writeFailures.push(f),
      absoluteStockWrite: true,
      statusWrite: { target: 'PROCESSING', read: (id) => (fake.base.forms.get(id)?.['fulfillment'] as { status?: string } | undefined)?.status },
      readTracking: (id) => (fake.orderShipments.get(id) ?? []).map((s) => s.waybill),
      writeDisabled: () => make(fake, {}),
    }
  },
})

describe('manifest i rejestr', () => {
  it('wersja z zapisem obok allegro.v1, ten sam zestaw sekretów, zachowanie kanału z mapą statusów', () => {
    const r = defaultRegistry()
    const m = r.get(ALLEGRO_ZAPIS_KEY)!.manifest
    expect(m.readOnly).toBe(false)
    expect(m.capabilities).toEqual(expect.arrayContaining(['stock.write', 'order.status.write', 'order.tracking.write', 'reference.find']))
    expect(m.secrets.map((s) => s.name)).toEqual(r.get('allegro.v1')!.manifest.secrets.map((s) => s.name))
    expect(m.channelBehavior?.defaultStatusMap?.WYSLANE).toBe('SENT')
    expect(m.config.some((f) => f.key === 'zapisWlaczony')).toBe(true)
  })
})

describe('strażnik ścieżek zapisu', () => {
  const U = '00000000-0000-4000-8000-000000000000'
  it.each([
    ['PUT', '/sale/offers/123'],
    ['PATCH', `/sale/product-offers/123`],
    ['POST', `/sale/offer-quantity-change-commands/${U}`],
    ['DELETE', `/order/checkout-forms/${U}/shipments`],
    ['PUT', `/order/checkout-forms/${U}/fulfillment?x=1`],
    ['PUT', `/order/checkout-forms/../fulfillment`],
    ['POST', `/shipment-management/pickups/create-commands/${U}`],
    ['GET', '/shipment-management/pickups/create-commands/nie-uuid'],
    ['POST', '/shipment-management/protocol'],
    ['GET', '/shipment-management/delivery-services'],
  ])('%s %s → odmowa przed wysłaniem', (method, path) => {
    expect(() => assertAllegroWritePath(method, path)).toThrow(ReadOnlyViolation)
  })

  it('klient zapisu odmawia hosta spoza listy i nie wysyła nic poza listę', async () => {
    expect(() => new AllegroWriter('https://evil.example', UA, fetch)).toThrow(/spoza listy/)
    let calls = 0
    const w = new AllegroWriter(API, UA, async () => {
      calls++
      return new Response(null, { status: 204 })
    })
    await expect(w.send('PUT', '/sale/offers/1', {}, 't')).rejects.toThrow(ReadOnlyViolation)
    expect(calls).toBe(0)
  })
})

describe('stany (komendy offer-quantity-change-commands)', () => {
  it('jedna komenda na ilość, commandId z referencji; powtórka tej samej paczki nie zakłada drugiej komendy', async () => {
    const fake = fakeNow()
    const a = make(fake)
    const items = [
      { offerExternalId: '11', qty: 3 },
      { offerExternalId: '10', qty: 3 },
      { offerExternalId: '12', qty: 0 },
    ]
    const out = await a.pushStock(items, 'ref-a')
    expect(out).toMatchObject({ kind: 'OK', externalRef: 'QTY:2' })
    expect(fake.qtyCommands.size).toBe(2)
    const cmds = stockCommands(items, 'ref-a')
    expect(cmds.map((c) => [c.qty, c.offers])).toEqual([
      [0, ['12']],
      [3, ['10', '11']],
    ])
    expect([...fake.qtyCommands.keys()].sort()).toEqual(cmds.map((c) => c.commandId).sort())
    expect(cmds[0]!.commandId).toBe(deriveReference(['ref-a', 'allegro-stany', 0, 0]))
    expect(fake.stock.get('10')).toBe(3)
    expect(fake.stock.get('12')).toBe(0)
    // powtórka: Allegro odpowiada 409, adapter czyta wynik istniejącej komendy
    expect((await a.pushStock(items, 'ref-a')).kind).toBe('OK')
    expect(fake.qtyCommands.size).toBe(2)
  })

  it('ponad 1000 ofert jednej ilości = kilka komend', () => {
    const items = Array.from({ length: OFFERS_PER_COMMAND + 5 }, (_, i) => ({ offerExternalId: String(1000 + i), qty: 1 }))
    const c = stockCommands(items, 'r')
    expect(c.map((x) => x.offers.length)).toEqual([OFFERS_PER_COMMAND, 5])
    expect(new Set(c.map((x) => x.commandId)).size).toBe(2)
  })

  it('wynik częściowy: oferta odrzucona przez Allegro tylko w failedItems, reszta zapisana; zła pozycja bez wysyłki', async () => {
    const fake = fakeNow()
    fake.rejectOffers.add('11')
    const out = await make(fake).pushStock(
      [
        { offerExternalId: '10', qty: 2 },
        { offerExternalId: '11', qty: 2 },
        { offerExternalId: 'abc', qty: 2 },
      ],
      'ref-b',
    )
    expect(out.kind).toBe('TRWALY')
    if (out.kind === 'OK') throw new Error()
    expect(out.failedItems?.map((f) => [f.offerExternalId, f.kind])).toEqual([
      ['abc', 'TRWALY'],
      ['11', 'TRWALY'],
    ])
    expect(fake.stock.get('10')).toBe(2)
  })

  it('komenda w toku po odpytywaniu: oferty PRZEJSCIOWY (do ponowienia), nie OK', async () => {
    const fake = fakeNow()
    fake.pendingPolls = 99
    const out = await make(fake).pushStock([{ offerExternalId: '10', qty: 1 }], 'ref-c')
    expect(out.kind).toBe('PRZEJSCIOWY')
    if (out.kind !== 'OK') expect(out.failedItems?.[0]).toMatchObject({ offerExternalId: '10', kind: 'PRZEJSCIOWY' })
  })

  it('taskCount.total = 0 tuż po PUT (zadania niepoliczone) to w toku, nie OK', async () => {
    const fake = fakeNow()
    fake.pendingPolls = 0
    fake.qtyZeroTotalReads = 99
    fake.rejectOffers.add('11')
    const out = await make(fake).pushStock(
      [
        { offerExternalId: '10', qty: 1 },
        { offerExternalId: '11', qty: 1 },
      ],
      'ref-d4',
    )
    expect(out.kind).toBe('PRZEJSCIOWY')
    if (out.kind !== 'OK') expect(out.failedItems?.map((f) => [f.offerExternalId, f.kind])).toEqual([
      ['10', 'PRZEJSCIOWY'],
      ['11', 'PRZEJSCIOWY'],
    ])
    // po policzeniu zadań wynik jest prawdziwy: odrzucona oferta TRWALY
    fake.qtyZeroTotalReads = 0
    const again = await make(fake).pushStock(
      [
        { offerExternalId: '10', qty: 1 },
        { offerExternalId: '11', qty: 1 },
      ],
      'ref-d4',
    )
    expect(again.kind).toBe('TRWALY')
    if (again.kind !== 'OK') expect(again.failedItems?.map((f) => f.offerExternalId)).toEqual(['11'])
  })

  it('powtórny PUT z 422 dla komendy, którą Allegro zna = odczyt wyniku, nie TRWALY', async () => {
    const fake = fakeNow()
    const a = make(fake)
    const items = [{ offerExternalId: '10', qty: 5 }]
    expect((await a.pushStock(items, 'ref-d5')).kind).toBe('OK')
    fake.repeatPutStatus = 422
    expect(await a.pushStock(items, 'ref-d5')).toMatchObject({ kind: 'OK' })
    expect(fake.qtyCommands.size).toBe(1)
    // 422 dla komendy, której Allegro nie zna = prawdziwa odmowa (TRWALY)
    fake.writeFailures.push({ status: 422 })
    expect((await a.pushStock([{ offerExternalId: '12', qty: 1 }], 'ref-d5b')).kind).toBe('TRWALY')
  })

  it('brak zakresu: TRWALY z nazwą funkcji do dodania w autoryzacji', async () => {
    const fake = fakeNow()
    fake.scopes.delete(OFFERS_WRITE)
    const out = await make(fake).pushStock([{ offerExternalId: '10', qty: 1 }], 'ref-d')
    expect(out.kind).toBe('TRWALY')
    if (out.kind !== 'OK') expect(out.message).toContain(`„${FUNKCJA_STANY}”`)
  })

  it('odszukanie po referencji: komendy przebiegu istnieją = znaleziono; nieznana referencja = wyjątek', async () => {
    const fake = fakeNow()
    const a = make(fake)
    fake.writeFailures.push('NIEJEDNOZNACZNY_WYKONANY')
    expect((await executeWrite(a, 'ref-e', () => a.pushStock([{ offerExternalId: '10', qty: 4 }], 'ref-e'))).kind).toBe('PRZEJSCIOWY')
    expect(await a.findByReference('ref-e')).toEqual({ found: true, externalRef: 'QTY:1' })
    await expect(a.findByReference('inna')).rejects.toThrow(/nieznana referencja/)
  })
})

describe('status realizacji', () => {
  const put = (fake: FakeAllegroZapis, o: { fulfillment?: string; paid?: number | null } = {}) =>
    fake.base.putForm({ id: FORM, updatedAt: iso(-10), fulfillment: o.fulfillment ?? 'NEW', paid: o.paid === undefined ? 10 : o.paid })

  it('ustawia status; „już ustawione” = OK bez drugiego zapisu', async () => {
    const fake = fakeNow()
    put(fake)
    const a = make(fake)
    expect((await a.setOrderStatus(FORM, 'SENT', 's1')).kind).toBe('OK')
    expect(fake.writes()).toEqual([`PUT /order/checkout-forms/${FORM}/fulfillment`])
    expect(await a.setOrderStatus(FORM, 'SENT', 's2')).toMatchObject({ kind: 'OK', externalRef: 'JUZ_USTAWIONE' })
    expect(fake.writes()).toHaveLength(1)
  })

  it('status spoza listy Allegro i nieistniejący formularz: TRWALY', async () => {
    const fake = fakeNow()
    put(fake)
    const a = make(fake)
    expect((await a.setOrderStatus(FORM, 'completed', 's1')).kind).toBe('TRWALY')
    expect((await a.setOrderStatus('00000000-0000-4000-8000-0000000000aa', 'SENT', 's2')).kind).toBe('TRWALY')
    expect(fake.writes()).toEqual([])
  })

  it('anulowanie nieopłaconego: Allegro widzi płatność → TRWALY bez zapisu', async () => {
    const fake = fakeNow()
    put(fake, { paid: 10 })
    const out = await make(fake).setOrderStatus(FORM, 'CANCELLED', 's1', { onlyIfUnpaid: true })
    expect(out.kind).toBe('TRWALY')
    expect(fake.writes()).toEqual([])
  })

  it('zgubiona odpowiedź po zapisie: świeży odczyt pokazuje status = OK', async () => {
    const fake = fakeNow()
    put(fake)
    fake.writeFailures.push('NIEJEDNOZNACZNY_WYKONANY')
    expect((await make(fake).setOrderStatus(FORM, 'PROCESSING', 's1')).kind).toBe('OK')
  })

  it('brak zakresu zapisu zamówień: TRWALY z nazwą funkcji', async () => {
    const fake = fakeNow()
    put(fake)
    fake.scopes.delete(ORDERS_WRITE)
    const out = await make(fake).setOrderStatus(FORM, 'SENT', 's1')
    expect(out.kind).toBe('TRWALY')
    if (out.kind !== 'OK') expect(out.message).toContain(`„${FUNKCJA_ZAMOWIENIA}”`)
  })
})

describe('numer nadania', () => {
  it('przewoźnik z listy Allegro (DPD), powtórka bez dubla; przewoźnik spoza listy jako „inny” z nazwą', async () => {
    const fake = fakeNow()
    fake.base.putForm({ id: FORM, updatedAt: iso(-10), paid: 10 })
    const a = make(fake)
    expect((await a.setTracking(FORM, { number: '0000123456789A', carrier: 'DPD' }, 't1')).kind).toBe('OK')
    expect((await a.setTracking(FORM, { number: '0000123456789a', carrier: 'DPD' }, 't2')).kind).toBe('OK')
    expect((await a.setTracking(FORM, { number: 'PACZKA9999', carrier: 'POCZTEX' }, 't3')).kind).toBe('OK')
    expect(fake.orderShipments.get(FORM)).toEqual([
      { id: expect.any(String), waybill: '0000123456789A', carrierId: 'DPD' },
      { id: expect.any(String), waybill: 'PACZKA9999', carrierId: 'OTHER', carrierName: 'POCZTEX' },
    ])
  })

  it('paczkomat InPost → INPOST; własny kod z konfiguracji wygrywa', async () => {
    const fake = fakeNow()
    fake.base.putForm({ id: FORM, updatedAt: iso(-10), paid: 10 })
    await make(fake).setTracking(FORM, { number: '620000111222333', carrier: 'PACZKOMATY' }, 't1')
    await make(fake, { zapisWlaczony: true, kodyPrzewoznikow: '{"DPD":"DPD_PL"}' }).setTracking(FORM, { number: 'DPD000111', carrier: 'DPD' }, 't2')
    expect(fake.orderShipments.get(FORM)!.map((s) => s.carrierId)).toEqual(['INPOST', 'DPD_PL'])
  })

  it('Wysyłam z Allegro: numer dopisuje Allegro; brak w zamówieniu = PRZEJSCIOWY bez zapisu, jest = OK', async () => {
    const fake = fakeNow()
    fake.base.putForm({ id: FORM, updatedAt: iso(-10), paid: 10 })
    const a = make(fake)
    expect((await a.setTracking(FORM, { number: 'AL000111222PL', carrier: 'ALLEGRO' }, 't1')).kind).toBe('PRZEJSCIOWY')
    expect(fake.writes()).toEqual([])
    fake.orderShipments.set(FORM, [{ id: 'x', waybill: 'AL000111222PL', carrierId: 'ALLEGRO' }])
    expect((await a.setTracking(FORM, { number: 'AL000111222PL', carrier: 'ALLEGRO' }, 't2')).kind).toBe('OK')
  })

  it('zgubiona odpowiedź po dopisaniu: odczyt pokazuje numer = OK, jeden wpis', async () => {
    const fake = fakeNow()
    fake.base.putForm({ id: FORM, updatedAt: iso(-10), paid: 10 })
    fake.writeFailures.push('NIEJEDNOZNACZNY_WYKONANY')
    const a = make(fake)
    expect((await a.setTracking(FORM, { number: '0000123456789A', carrier: 'DPD' }, 't1')).kind).toBe('OK')
    expect((await a.setTracking(FORM, { number: '0000123456789A', carrier: 'DPD' }, 't1')).kind).toBe('OK')
    expect(fake.orderShipments.get(FORM)).toHaveLength(1)
  })
})

describe('wyłącznik', () => {
  it('bez zapisWlaczony: TRWALY, zero żądań (także odczytu)', async () => {
    const fake = fakeNow()
    const a = make(fake, {})
    expect(hasStockWriter(a) && hasOrderStatusWriter(a) && hasTrackingWriter(a)).toBe(true)
    expect(await a.pushStock([{ offerExternalId: '10', qty: 1 }], 'r')).toMatchObject({ kind: 'TRWALY', message: ZAPIS_WYLACZONY })
    expect((await a.setOrderStatus(FORM, 'SENT', 'r')).kind).toBe('TRWALY')
    expect((await a.setTracking(FORM, { number: 'DPD000111', carrier: 'DPD' }, 'r')).kind).toBe('TRWALY')
    expect(fake.requests).toEqual([])
  })
})
