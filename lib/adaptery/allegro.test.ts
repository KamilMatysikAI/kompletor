// Adapter Allegro na atrapie HTTP (tests/allegro-atrapa.ts): suita kontraktowa, dziennik zdarzeń,
// pierwszy odczyt, retencja, mapowanie, tokeny (odświeżenie, zapis przed użyciem, odrzucony refresh), błędy HTTP,
// strażnik tylko-odczytu. Zero prawdziwych wywołań; tokeny i Client ID fikcyjne.
import { describe, expect, it } from 'vitest'
import { API, AUTH, checkoutForm, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegro, productOffer, UA } from '@/tests/allegro-atrapa'
import { allegroEanOfertyZApi } from '../zrodla/allegro'
import { AllegroAccountError, ALLEGRO_DEFINITION, ALLEGRO_SECRETS as S, allegroOrderFromApi, allegroRecipientFromApi, AllegroReauthorizationError, parseAllegroCursor } from './allegro'
import { type ChannelAdapter, hasOfferEanReader, type OfferEanReader, type OfferReader, type OrderFeed, type SecretRotation, UnreadableDataError } from './kontrakt'
import { AdapterRegistry } from './rejestr'
import { PII_SENTINELS, runAdapterContract } from './suita-kontraktowa'
import { przytnijDoPowodu } from '../odbiorca/pobierz'

const NOW = new Date('2026-10-28T12:00:00.000Z')
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
const LOOKBACK = { initialLookbackMs: 24 * 3600_000 }
const registry = new AdapterRegistry([ALLEGRO_DEFINITION])

interface Opts {
  expiresAt?: string
  extraSecrets?: Record<string, string>
  persist?: (patch: Record<string, string>) => Promise<void>
  rotate?: (r: SecretRotation) => Promise<Record<string, string>>
  now?: () => Date
  pair?: { access: string; refresh: string }
}

function make(fake: FakeAllegro, o: Opts = {}): ChannelAdapter & OrderFeed {
  const pair = o.pair ?? fake.issuePair()
  return registry.create('allegro.v1', {
    integration: { organizationId: 'org', kind: 'channel', id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO', channelAccountId: '71045' },
    rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA },
    rawSecrets: {
      [S.clientId]: FAKE_CLIENT_ID,
      [S.clientSecret]: FAKE_CLIENT_SECRET,
      [S.access]: pair.access,
      [S.refresh]: pair.refresh,
      [S.expiresAt]: o.expiresAt ?? iso(600),
      ...o.extraSecrets,
    },
    fetch: fake.fetch,
    now: o.now ?? (() => NOW),
    http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 },
    ...(o.persist ? { persistSecrets: o.persist } : {}),
    ...(o.rotate ? { rotateSecrets: o.rotate } : {}),
  }) as ChannelAdapter & OrderFeed
}

async function readAll(a: OrderFeed, cursor: string | null = null) {
  const ids: string[] = []
  const warnings: string[] = []
  let cur = cursor
  for (let i = 0; i < 50; i++) {
    const p = await a.listOrderChanges(cur, LOOKBACK)
    ids.push(...p.items.map((x) => x.externalId))
    warnings.push(...(p.warnings ?? []))
    cur = p.nextCursor
    if (!p.hasMore) return { ids, cursor: cur, warnings }
  }
  throw new Error('bez końca')
}

// ─── Suita kontraktowa ───────────────────────────────────────────────────────

runAdapterContract({
  name: 'allegro.v1 (atrapa HTTP)',
  now: NOW,
  setup() {
    const fake = new FakeAllegro()
    fake.clock = () => NOW.getTime()
    const adapter = make(fake)
    return {
      adapter,
      putOrder(s) {
        const status = s.state === 'cancelled' ? 'CANCELLED' : 'READY_FOR_PROCESSING'
        fake.putForm({
          id: s.externalId,
          status,
          fulfillment: s.state === 'fulfilled' ? 'SENT' : 'NEW',
          lines: [{ id: `${s.externalId}-1`, offerId: s.offer, qty: s.qty, price: 12.5 }],
          updatedAt: s.modifiedAt.toISOString(),
          boughtAt: s.createdAt.toISOString(),
          paid: 12.5 * s.qty,
        })
      },
      corruptOrder(id) {
        const f = fake.forms.get(id)!
        ;(f['lineItems'] as Record<string, unknown>[])[0]!['quantity'] = 'abc'
      },
      corruptRecipient(id) {
        const d = fake.forms.get(id)!['delivery'] as Record<string, unknown>
        ;(d['address'] as Record<string, unknown>)['phoneNumber'] = { numer: PII_SENTINELS[2] }
      },
      failNextList(kind) {
        fake.apiFailures.push({ status: kind === 'PRZEJSCIOWY' ? 503 : 400 })
      },
      requests: () => fake.requests.map((r) => r.split(' ')[0]!),
      putOffer(o) {
        fake.offersPageMax = 2
        fake.offers.set(o.externalId, {
          id: o.externalId,
          name: o.name,
          external: o.sku ? { id: o.sku } : null,
          stock: { available: o.qty, unit: 'UNIT' },
          publication: { status: 'ACTIVE' },
          seller: { login: PII_SENTINELS[0] },
        })
      },
      corruptOffer(id) {
        ;(fake.offers.get(id)!['stock'] as Record<string, unknown>)['available'] = 'abc'
      },
    }
  },
})

// ─── Dziennik zdarzeń ────────────────────────────────────────────────────────

describe('dziennik zdarzeń', () => {
  it('pierwszy odczyt: event-stats PRZED listą; zamówienie złożone między nimi i po liście nie ginie', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(-60) })
    fake.afterStats = () => fake.putForm({ id: 'f2', updatedAt: iso(-1) }) // między event-stats a listą
    fake.afterList = () => fake.putForm({ id: 'f3', updatedAt: iso(0) }) // po liście, przed dziennikiem
    const a = make(fake)
    const r = await readAll(a)
    const order = fake.requests.filter((x) => x.startsWith('GET /order/'))
    expect(order[0]).toBe('GET /order/event-stats')
    expect(order[1]).toBe('GET /order/checkout-forms')
    expect(new Set(r.ids)).toEqual(new Set(['f1', 'f2', 'f3']))
    expect(parseAllegroCursor(r.cursor!)).toMatchObject({ p: 'E', e: fake.events[fake.events.length - 1]!.id })
  })

  it('nowe, podwójne i poza kolejnością: jedno id na stronę, pełne zamówienie z getOrder; kursor przesuwa się', async () => {
    const fake = new FakeAllegro()
    const a = make(fake)
    const first = await readAll(a)
    fake.putForm({ id: 'f1', updatedAt: iso(1) })
    fake.putForm({ id: 'f2', updatedAt: iso(2) })
    fake.addEvent('f1', 'FILLED_IN', iso(1)) // podwójne
    fake.addEvent('f2', 'BOUGHT', iso(0)) // poza kolejnością (starsze occurredAt)
    const p = await a.listOrderChanges(first.cursor, LOOKBACK)
    expect(p.items.map((x) => x.externalId)).toEqual(['f1', 'f2'])
    expect(p.items.every((x) => !x.order)).toBe(true) // host woła getOrder
    expect(parseAllegroCursor(p.nextCursor).e).toBe(fake.events[fake.events.length - 1]!.id)
    expect(p.hasMore).toBe(false)
    const o = await a.getOrder('f1')
    expect(o).toMatchObject({ externalId: 'f1', revision: iso(1), lifecycle: 'OPEN' })
    const again = await a.listOrderChanges(p.nextCursor, LOOKBACK)
    expect(again.items).toEqual([])
  })

  it('pełna strona 1000 zdarzeń → hasMore i kolejna strona od ostatniego eventId', async () => {
    const fake = new FakeAllegro()
    const a = make(fake)
    const first = await readAll(a)
    for (let i = 0; i < 1003; i++) fake.addEvent(`f${i % 10}`, 'BUYER_MODIFIED')
    const p1 = await a.listOrderChanges(first.cursor, LOOKBACK)
    expect(p1.hasMore).toBe(true)
    expect(p1.items).toHaveLength(10)
    expect(parseAllegroCursor(p1.nextCursor).e).toBe(fake.events[999]!.id)
    const p2 = await a.listOrderChanges(p1.nextCursor, LOOKBACK)
    expect(p2.hasMore).toBe(false)
    expect(p2.items.map((x) => x.externalId)).toEqual(['f0', 'f1', 'f2'])
    expect(fake.requests.filter((x) => x === 'GET /order/events')).toHaveLength(3)
  })

  it('lista: stronicowanie offset+limit ≤ 100 i ≤ 10 000', async () => {
    const fake = new FakeAllegro()
    for (let i = 0; i < 230; i++) fake.putForm({ id: `f${String(i).padStart(3, '0')}`, updatedAt: iso(-100 + i * 0.1) })
    const r = await readAll(make(fake))
    expect(new Set(r.ids).size).toBe(230)
    expect(fake.requests.filter((x) => x === 'GET /order/checkout-forms')).toHaveLength(3)
  })

  it('kursor starszy niż retencja (60 dni) → lista zapasowa od ostatniego odczytu + ostrzeżenie', async () => {
    const fake = new FakeAllegro()
    const old = { v: 1, p: 'E', e: '000001', t: new Date(NOW.getTime() - 61 * 24 * 3600_000).toISOString() }
    fake.putForm({ id: 'stare', updatedAt: new Date(NOW.getTime() - 62 * 24 * 3600_000).toISOString() })
    fake.putForm({ id: 'w-luce', updatedAt: new Date(NOW.getTime() - 30 * 24 * 3600_000).toISOString() })
    const r = await readAll(make(fake), JSON.stringify(old))
    expect(r.ids).toEqual(['w-luce'])
    expect(r.warnings.join(' ')).toMatch(/retencj.*odczyt zapasowy/)
    expect(fake.requests.indexOf('GET /order/event-stats')).toBeLessThan(fake.requests.indexOf('GET /order/checkout-forms'))
  })

  it('kursor odrzucony przez API (400) → lista zapasowa + ostrzeżenie, nie cicha luka', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f0', updatedAt: iso(-20) })
    fake.putForm({ id: 'f1', updatedAt: iso(-10) })
    fake.eventsFromMin = 2 // zdarzenie 000001 wypadło z dziennika
    const cur = { v: 1, p: 'E', e: '000001', t: iso(-30) }
    const r = await readAll(make(fake), JSON.stringify(cur))
    expect(r.ids).toContain('f1')
    expect(r.warnings.join(' ')).toMatch(/odrzucony \(HTTP 400\)/)
  })

  it('event-stats bez ostatniego zdarzenia przy niepustej liście → ostrzeżenie; pusta lista bez ostrzeżenia', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(-5) })
    fake.events = []
    expect((await readAll(make(fake))).warnings.join(' ')).toMatch(/nie podało ostatniego zdarzenia/)
    expect((await readAll(make(new FakeAllegro()))).warnings).toEqual([])
  })

  it('zły kursor: błąd trwały (kontrakt) z instrukcją wyzerowania kursora', async () => {
    await expect(make(new FakeAllegro()).listOrderChanges('{nie-kursor', LOOKBACK)).rejects.toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('ChannelCursor.cursor = NULL') })
  })
})

// ─── Mapowanie ───────────────────────────────────────────────────────────────

describe('mapowanie formularza', () => {
  it('nieopłacone BOUGHT → OPEN, UNPAID; FILLED_IN → OPEN', () => {
    const o = allegroOrderFromApi(checkoutForm({ id: 'x', status: 'BOUGHT', updatedAt: iso(0), paid: null }))
    expect(o).toMatchObject({ lifecycle: 'OPEN', paymentState: 'UNPAID', channelStatus: 'BOUGHT/NEW', statusRank: 1, warnings: [] })
    expect(allegroOrderFromApi(checkoutForm({ id: 'x', status: 'FILLED_IN', updatedAt: iso(0) })).lifecycle).toBe('OPEN')
  })

  it('anulowane → CANCELLED; wysłane i odebrane → FULFILLED; status realizacji do statusRank', () => {
    expect(allegroOrderFromApi(checkoutForm({ id: 'x', status: 'CANCELLED', updatedAt: iso(0) })).lifecycle).toBe('CANCELLED')
    const sent = allegroOrderFromApi(checkoutForm({ id: 'x', fulfillment: 'SENT', updatedAt: iso(0), paid: 10 }))
    expect(sent).toMatchObject({ lifecycle: 'FULFILLED', statusRank: 40, channelStatus: 'READY_FOR_PROCESSING/SENT', paymentState: 'PAID' })
    expect(allegroOrderFromApi(checkoutForm({ id: 'x', fulfillment: 'PICKED_UP', updatedAt: iso(0) })).lifecycle).toBe('FULFILLED')
    expect(allegroOrderFromApi(checkoutForm({ id: 'x', fulfillment: 'PROCESSING', updatedAt: iso(0) }))).toMatchObject({ lifecycle: 'OPEN', statusRank: 20 })
  })

  it('nieznany status → ostrzeżenie, stan nieterminalny (OPEN), bez kolejności', () => {
    const o = allegroOrderFromApi(checkoutForm({ id: 'x', status: 'NOWY_STATUS', updatedAt: iso(0) }))
    expect(o).toMatchObject({ lifecycle: 'OPEN', statusRank: null })
    expect(o.warnings.join(' ')).toContain('NOWY_STATUS')
  })

  it('płatność: pobranie COD, niedopłata PARTIAL; pozycje, dostawa, faktura; bez danych kupującego', () => {
    expect(allegroOrderFromApi(checkoutForm({ id: 'x', paymentType: 'CASH_ON_DELIVERY', updatedAt: iso(0) })).paymentState).toBe('COD')
    const o = allegroOrderFromApi(checkoutForm({ id: 'x', updatedAt: iso(0), paid: 5, invoice: true, lines: [{ id: 'l1', offerId: '777', qty: 2, price: '19.99' }] }))
    expect(o).toMatchObject({ paymentState: 'PARTIAL', totalGross: 39.98, deliveryMethod: 'Allegro Paczkomaty InPost', wantInvoiceNip: true })
    expect(o.lines).toEqual([{ externalLineId: 'l1', offerExternalId: '777', qty: 2, unitPriceGross: 19.99, vatRate: '23.00', name: 'Przyprawa testowa' }])
    const json = JSON.stringify(o)
    for (const p of [...PII_SENTINELS, 'kupujacy_testowy', 'Testowo']) expect(json).not.toContain(p)
  })

  it('wyrównanie (reconciliation) liczy się do zapłaty: PAID zamiast PARTIAL; nieczytelne = błąd', () => {
    const f = (rec: unknown) => {
      const raw = checkoutForm({ id: 'x', updatedAt: iso(0), paid: 7, total: 10 })
      ;(raw['payment'] as Record<string, unknown>)['reconciliation'] = rec
      return raw
    }
    expect(allegroOrderFromApi(f({ amount: '3.00', currency: 'PLN' })).paymentState).toBe('PAID')
    expect(allegroOrderFromApi(f({ amount: '2.00', currency: 'PLN' })).paymentState).toBe('PARTIAL')
    expect(allegroOrderFromApi(f(undefined)).paymentState).toBe('PARTIAL')
    expect(() => allegroOrderFromApi(f({ amount: 'brak' }))).toThrow(UnreadableDataError)
  })

  it('nieczytelna ilość albo cena → UnreadableDataError, nigdy 0', () => {
    expect(() => allegroOrderFromApi(checkoutForm({ id: 'x', updatedAt: iso(0), lines: [{ id: 'l', offerId: '1', qty: 'abc' }] }))).toThrow(UnreadableDataError)
    expect(() => allegroOrderFromApi(checkoutForm({ id: 'x', updatedAt: iso(0), lines: [{ id: 'l', offerId: '1', qty: 1, price: 'brak' }] }))).toThrow(UnreadableDataError)
  })
})

// ─── Tokeny ──────────────────────────────────────────────────────────────────

describe('tokeny i odświeżenie', () => {
  it('wygasający token: nowa para zapisana PRZED pierwszym użyciem nowego access tokena', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(0) })
    const log: string[] = []
    const origFetch = fake.fetch
    fake.fetch = async (url, init) => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      log.push(`fetch ${new URL(url).pathname} ${auth.startsWith('Bearer ') ? auth.slice(7) : ''}`)
      return origFetch(url, init)
    }
    const saved: Record<string, string> = {}
    const a = make(fake, {
      expiresAt: iso(4), // < 5 min
      persist: async (p) => {
        Object.assign(saved, p)
        log.push(`zapis ${p[S.access]}`)
      },
    })
    await a.getOrder('f1')
    const newAccess = saved[S.access]!
    expect(newAccess).toBeTruthy()
    const firstUse = log.findIndex((x) => x.endsWith(newAccess) && x.startsWith('fetch /order'))
    expect(log.indexOf(`zapis ${newAccess}`)).toBeGreaterThanOrEqual(0)
    expect(log.indexOf(`zapis ${newAccess}`)).toBeLessThan(firstUse)
    expect(saved[S.refresh]).toBeTruthy()
    expect(Date.parse(saved[S.expiresAt]!)).toBeGreaterThan(NOW.getTime())
    expect(fake.tokenCalls).toBe(1)
  })

  it('odświeżenie zapisuje zakres zwrócony przez Allegro; bez zakresu albo ze śmieciem — poprzedni zostaje', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(0) })
    const pair = fake.issuePair('allegro:api:orders:read allegro:api:shipments:read')
    fake.grantScope = 'allegro:api:orders:read' // właściciel cofnął w Allegro zgodę na przesyłki
    const saved: Record<string, string> = {}
    const a = make(fake, { pair, expiresAt: iso(-1), extraSecrets: { [S.scope]: 'allegro:api:orders:read allegro:api:shipments:read' }, persist: async (p) => void Object.assign(saved, p) })
    await a.getOrder('f1')
    expect(saved[S.scope]).toBe('allegro:api:orders:read')

    for (const [omit, grant] of [[true, null], [false, 'Zły Zakres; DROP']] as const) {
      const f2 = new FakeAllegro()
      f2.putForm({ id: 'f1', updatedAt: iso(0) })
      f2.omitScope = omit
      f2.grantScope = grant
      const s2: Record<string, string> = {}
      await make(f2, { expiresAt: iso(-1), persist: async (p) => void Object.assign(s2, p) }).getOrder('f1')
      expect(s2[S.access]).toBeTruthy()
      expect(S.scope in s2).toBe(false)
    }
  })

  it('rotacja hosta obejmuje zakres (ten sam zapis co para tokenów)', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(0) })
    const pair = fake.issuePair('allegro:api:orders:read allegro:api:sale:offers:read')
    let names: readonly string[] = []
    let fresh: Record<string, string> = {}
    const a = make(fake, {
      pair,
      expiresAt: iso(-1),
      rotate: async (r) => {
        names = r.names
        fresh = await r.refresh({ [S.refresh]: pair.refresh, [S.access]: pair.access })
        return fresh
      },
    })
    expect(await a.getOrder('f1')).not.toBeNull()
    expect(names).toContain(S.scope)
    expect(names[0]).toBe(S.refresh)
    expect(fresh[S.scope]).toBe('allegro:api:orders:read allegro:api:sale:offers:read')
  })

  it('dwa równoległe odczyty z wygasłym tokenem = jedno wywołanie /auth/oauth/token', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(0) })
    fake.tokenDelayMs = 20
    const a = make(fake, { expiresAt: iso(-1), persist: async () => undefined })
    await Promise.all([a.getOrder('f1'), a.getOrder('f1'), a.testConnection()])
    expect(fake.tokenCalls).toBe(1)
  })

  it('nieudany zapis nowej pary → jedna ponowna próba (okno 60 s); dwa nieudane → błąd, nowa para nieużyta', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(0) })
    let fails = 1
    let writes = 0
    const a = make(fake, {
      expiresAt: iso(-1),
      persist: async () => {
        writes++
        if (fails-- > 0) throw new Error('baza niedostępna')
      },
    })
    expect(await a.getOrder('f1')).not.toBeNull()
    expect(writes).toBe(2)
    const b = make(fake, { expiresAt: iso(-1), persist: async () => Promise.reject(new Error('baza niedostępna')) })
    const before = fake.requests.filter((x) => x.startsWith('GET /order/checkout-forms/')).length
    await expect(b.getOrder('f1')).rejects.toMatchObject({ kind: 'PRZEJSCIOWY', message: expect.stringContaining('nie zapisana') })
    expect(fake.requests.filter((x) => x.startsWith('GET /order/checkout-forms/')).length).toBe(before) // nie użyta
  })

  it('rotacja hosta: inny proces już odświeżył → bez wywołania /auth/oauth/token, świeża para z bazy', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(0) })
    const db = fake.issuePair()
    const a = make(fake, {
      expiresAt: iso(-1),
      rotate: async (r) => {
        expect(r.names[0]).toBe(S.refresh)
        expect(r.stale.name).toBe(S.access)
        return { [S.access]: db.access, [S.refresh]: db.refresh, [S.expiresAt]: iso(700) } // inny proces był pierwszy
      },
    })
    expect(await a.getOrder('f1')).not.toBeNull()
    expect(fake.tokenCalls).toBe(0)
  })

  it('refresh odrzucony (invalid_grant) → błąd ponownej autoryzacji, znacznik zapisany; kolejny odczyt bez próby odświeżenia', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(0) })
    const pair = fake.issuePair()
    fake.revoked.add(pair.refresh)
    const saved: Record<string, string> = {}
    const a = make(fake, { pair, expiresAt: iso(-1), persist: async (p) => void Object.assign(saved, p) })
    const err = await a.getOrder('f1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AllegroReauthorizationError)
    expect((err as Error).message).toContain('Połącz ponownie z Allegro')
    expect((err as Error).message).not.toContain('npm run')
    expect((err as Error).message).not.toContain(pair.refresh)
    expect(saved[S.rejected]).toMatch(/^[0-9a-f]{32}$/)
    expect(fake.tokenCalls).toBe(1)
    await expect(a.listOrderChanges(null, LOOKBACK)).rejects.toBeInstanceOf(AllegroReauthorizationError)
    const b = make(fake, { pair, expiresAt: iso(-1), extraSecrets: { [S.rejected]: saved[S.rejected]! }, persist: async () => undefined })
    await expect(b.getOrder('f1')).rejects.toBeInstanceOf(AllegroReauthorizationError)
    expect(fake.tokenCalls).toBe(1) // bez kolejnych prób tym samym tokenem
  })
})

// ─── Błędy HTTP ──────────────────────────────────────────────────────────────

describe('błędy HTTP', () => {
  it('401 → jedno odświeżenie i jedna powtórka; drugi 401 → błąd konta', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(0) })
    const pair = fake.issuePair()
    fake.validAccess.delete(pair.access) // unieważniony mimo terminu
    const a = make(fake, { pair, persist: async () => undefined })
    expect(await a.getOrder('f1')).not.toBeNull()
    expect(fake.tokenCalls).toBe(1)
    expect(fake.requests.filter((x) => x === 'GET /order/checkout-forms/f1')).toHaveLength(2)

    const fake2 = new FakeAllegro()
    const p2 = fake2.issuePair()
    fake2.apiFailures.push({ status: 401 }, { status: 401 })
    const b = make(fake2, { pair: p2, persist: async () => undefined })
    const e = await b.getOrder('f1').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AllegroAccountError)
    expect((e as Error).message).toContain('401')
    expect(fake2.tokenCalls).toBe(1)
  })

  it('401 tuż po odświeżeniu z powodu terminu: bez drugiego odświeżenia w tym samym wywołaniu', async () => {
    const fake = new FakeAllegro()
    fake.apiFailures.push({ status: 401 })
    const a = make(fake, { expiresAt: iso(-1), persist: async () => undefined })
    await expect(a.getOrder('f1')).rejects.toBeInstanceOf(AllegroAccountError)
    expect(fake.tokenCalls).toBe(1)
    expect(fake.requests.filter((x) => x === 'GET /order/checkout-forms/f1')).toHaveLength(1)
  })

  it('złe Client ID przy odświeżeniu = błąd konta, nie zamówienia', async () => {
    const fake = new FakeAllegro()
    const a = registry.create('allegro.v1', {
      integration: { organizationId: 'org', kind: 'channel', id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO', channelAccountId: '71045' },
      rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA },
      rawSecrets: { [S.clientId]: 'inne', [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: 'a', [S.refresh]: 'r', [S.expiresAt]: iso(-1) },
      fetch: fake.fetch,
      now: () => NOW,
      http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 },
      persistSecrets: async () => undefined,
    }) as ChannelAdapter & OrderFeed
    await expect(a.getOrder('f1')).rejects.toBeInstanceOf(AllegroAccountError)
  })

  it('429 → PRZEJSCIOWY z Retry-After; 5xx → PRZEJSCIOWY; 403 → błąd konta z zakresem', async () => {
    const fake = new FakeAllegro()
    const a = make(fake)
    fake.apiFailures.push({ status: 429, retryAfter: '17' })
    await expect(a.getOrder('f1')).rejects.toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 17_000 })
    fake.apiFailures.push({ status: 502 })
    await expect(a.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    fake.apiFailures.push({ status: 403 })
    const e = await a.getOrder('f1').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AllegroAccountError)
    expect((e as Error).message).toContain('allegro:api:orders:read')
    // lista ofert — komunikat podaje zakres ofert i jak go dodać
    fake.apiFailures.push({ status: 403 })
    const eo = await (a as unknown as OfferReader).listOffers(null).catch((x: unknown) => x)
    expect(eo).toBeInstanceOf(AllegroAccountError)
    expect((eo as Error).message).toContain('allegro:api:sale:offers:read')
    expect((eo as Error).message).toContain('Odczyt ofert')
    expect((eo as Error).message).not.toContain('npm run')
  })

  it('komunikaty błędów bez tokenów i Client Secret', async () => {
    const fake = new FakeAllegro()
    const pair = fake.issuePair()
    fake.validAccess.delete(pair.access)
    fake.revoked.add(pair.refresh)
    const a = make(fake, { pair, persist: async () => undefined })
    const r = await a.testConnection()
    expect(r.ok).toBe(false)
    for (const s of [pair.access, pair.refresh, FAKE_CLIENT_SECRET, 'Bearer', 'Basic']) expect(r.message).not.toContain(s)
  })
})

describe('strażnik tylko-odczytu', () => {
  it('poza POST /auth/oauth/token wyłącznie GET', async () => {
    const fake = new FakeAllegro()
    fake.putForm({ id: 'f1', updatedAt: iso(-5) })
    const a = make(fake, { expiresAt: iso(-1), persist: async () => undefined })
    const r = await readAll(a)
    fake.putForm({ id: 'f2', updatedAt: iso(1) })
    await readAll(a, r.cursor)
    await a.getOrder('f1')
    await a.testConnection()
    expect(fake.requests).toContain('POST /auth/oauth/token')
    expect(fake.nonGet()).toEqual([])
  })
})

describe('opis z formularza', () => {
  it('pozycja: nazwa oferty i sygnatura (SKU) sprzedawcy; koszt wysyłki z delivery.cost; nieczytelny koszt = null, nie błąd', () => {
    const raw = checkoutForm({ id: 'x', updatedAt: iso(0), lines: [{ id: 'l1', offerId: '777', qty: 1, price: '10' }] })
    const li = (raw['lineItems'] as Record<string, unknown>[])[0]!
    ;(li['offer'] as Record<string, unknown>)['external'] = { id: 'SKU-777' }
    ;(raw['delivery'] as Record<string, unknown>)['cost'] = { amount: '8.99', currency: 'PLN' }
    const o = allegroOrderFromApi(raw)
    expect(o.lines[0]).toMatchObject({ name: 'Przyprawa testowa', sku: 'SKU-777' })
    expect(o.shippingCostGross).toBe(8.99)
    ;(raw['delivery'] as Record<string, unknown>)['cost'] = { amount: 'abc' }
    expect(allegroOrderFromApi(raw).shippingCostGross).toBeNull()
  })

  it('odbiorca: login kupującego, wiadomość do sprzedającego i adres punktu; przesyłka i faktura ich nie dostają', () => {
    const r = allegroRecipientFromApi(checkoutForm({ id: 'x', updatedAt: iso(0), pickupPoint: { id: 'KRA01M', name: 'Paczkomat' } }))
    expect(r.login).toBe('kupujacy_testowy')
    expect(r.uwagi).toContain('wiadomość od')
    expect(r.punktOdbioru?.adres?.kodPocztowy).toBe('00-001')
    for (const powod of ['PRZESYLKA', 'FAKTURA'] as const) {
      const p = przytnijDoPowodu(r, powod)
      expect(p.login).toBeUndefined()
      expect(p.uwagi).toBeUndefined()
    }
  })
})

describe('EAN oferty ze szczegółów (GET /sale/product-offers/{id})', () => {
  const eanOf = (a: ChannelAdapter) => (a as unknown as OfferEanReader).getOfferEan.bind(a)

  it('EAN z parametru produktu 225693; jedno GET na ofertę; zestaw, brak EAN i 404 = brak z powodem', async () => {
    const fake = new FakeAllegro()
    const a = make(fake)
    expect(hasOfferEanReader(a)).toBe(true)
    fake.productOffers.set('7700001', productOffer('7700001', ['5901234123457']))
    fake.productOffers.set('7700002', productOffer('7700002', [null]))
    fake.productOffers.set('7700003', productOffer('7700003', ['5901234123457', '5909876543210']))
    expect(await eanOf(a)('7700001')).toEqual({ ean: '5901234123457', powod: null })
    expect(fake.requests.filter((r) => r.startsWith('GET /sale/product-offers/'))).toEqual(['GET /sale/product-offers/7700001'])
    expect(await eanOf(a)('7700002')).toMatchObject({ ean: null, powod: expect.stringContaining('nie ma EAN') })
    expect(await eanOf(a)('7700003')).toMatchObject({ ean: null, powod: expect.stringContaining('zestaw') })
    expect(await eanOf(a)('7700009')).toMatchObject({ ean: null, powod: expect.stringContaining('nie ma już') })
    expect(fake.nonGet()).toEqual([])
  })

  it('zły numer oferty odrzucony przed wysłaniem; 403 = błąd konta z zakresem ofert; 429 = PRZEJSCIOWY z Retry-After', async () => {
    const fake = new FakeAllegro()
    const a = make(fake)
    await expect(eanOf(a)('../order/checkout-forms')).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(fake.requests.some((r) => r.includes('product-offers'))).toBe(false)
    fake.productOffers.set('7700004', 403)
    const e = await eanOf(a)('7700004').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AllegroAccountError)
    expect((e as Error).message).toContain('allegro:api:sale:offers:read')
    fake.apiFailures.push({ status: 429, retryAfter: '9' })
    await expect(eanOf(a)('7700001')).rejects.toMatchObject({ kind: 'PRZEJSCIOWY', retryAfterMs: 9_000 })
  })

  it('parser: parametry oferty, pole ean, flaga isGTIN, kilka różnych EAN i ten sam EAN dwa razy', () => {
    expect(allegroEanOfertyZApi({ parameters: [{ id: '225693', values: ['5901234123457'] }] })).toEqual({ ean: '5901234123457', powod: null })
    expect(allegroEanOfertyZApi({ ean: '5901234123457' })).toEqual({ ean: '5901234123457', powod: null })
    expect(allegroEanOfertyZApi({ productSet: [{ product: { parameters: [{ id: '1', name: 'Kod', options: { isGTIN: true }, values: ['5901234123457'] }] } }] }).ean).toBe('5901234123457')
    expect(allegroEanOfertyZApi({ productSet: [{ product: { parameters: [{ id: '225693', values: ['5901234123457', '5909876543210'] }] } }] })).toMatchObject({ ean: null, powod: 'oferta ma kilka różnych EAN' })
    expect(allegroEanOfertyZApi({ productSet: [{ product: { parameters: [{ id: '225693', values: ['5901234123457'] }] } }], ean: '5901234123457' }).ean).toBe('5901234123457')
    expect(allegroEanOfertyZApi({ productSet: [{ product: { parameters: [{ id: '225693', values: ['brak'] }] } }] }).ean).toBeNull()
    expect(allegroEanOfertyZApi(null)).toMatchObject({ ean: null })
  })
})
