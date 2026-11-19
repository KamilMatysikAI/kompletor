// Wspólna suita kontraktowa adaptera (kontrakt pkt 6). Każdy adapter (nasz albo społeczności) dostaje
// „uprząż” — kanał w pamięci za jego prawdziwym klientem HTTP albo bezpośrednio — i przechodzi te same testy:
// manifest, strażniki zdolności, kursor do końca dziennika, pełne zamówienie, nieczytelne dane jako błąd elementu
// (nigdy 0), rodzaje błędów, brak danych osobowych w wyniku, tylko GET w adapterach do odczytu, zapis z referencją.
// Dziennik może zwrócić to samo zamówienie więcej niż raz (zakładka, stronicowanie po kluczu) — host odsiewa duble.
// Adapter z `orders.recipient`: kształt odbiorcy bez pustych stringów, brak zamówienia = błąd trwały,
// nieczytelne pole = UnreadableDataError bez wartości w komunikacie, tylko metody odczytu.
// Użycie w teście: `runAdapterContract(harness)` (np. lib/adaptery/adaptery.test.ts).
import { describe, expect, it } from 'vitest'
import {
  AdapterError,
  type ChannelAdapter,
  type ChannelOrder,
  hasOfferReader,
  hasOrderFeed,
  hasOrderStatusWriter,
  hasRecipientReader,
  hasReferenceFinder,
  hasShipmentPreparer,
  hasShipmentTracker,
  hasStockWriter,
  hasTrackingWriter,
  type ChannelOfferRow,
  type OfferPageWithProblems,
  type OrderFeed,
  type OrderRecipient,
  UnreadableDataError,
} from './kontrakt'
import type { FakeWriteFailure } from './falszywy'
import { manifestProblems } from './rejestr'
import { executeWrite } from './zapis'

/** Wartości „osobowe” wpisywane przez uprząż do surowych danych kanału; nie mogą wyjść w ChannelOrder. */
export const PII_SENTINELS = ['Jan Testowy', 'jan.testowy@example.invalid', '600100200', 'ul. Testowa 1', 'NIP 1234563218']

/**
 * atrapa sklepu Woo filtruje odpowiedź parametrem `_fields` tak jak WordPress
 * (`rest_filter_response_fields` + `_rest_array_intersect_key_recursive`): `a.b` = zagnieżdżone pole; lista
 * rozpoznawana tylko na najwyższym poziomie (każde zamówienie osobno), więc zagnieżdżona lista (np. `meta_data`)
 * przefiltrowana po kluczu (`meta_data.key`) wraca pusta. Bez `_fields` odpowiedź bez zmian.
 *
 * (prawdziwy WordPress 7.1 + WooCommerce 11.2 w Dockerze, tests/woo-prawdziwy): kontroler zamówień
 * WooCommerce (`WC_REST_Orders_V2_Controller::get_formatted_item_data`) liczy pola „dodatkowe” (`meta_data`,
 * `line_items`, `tax_lines`, `shipping_lines`, `fee_lines`, `coupon_lines`, `refunds`, `payment_url`, `is_editable`,
 * `needs_payment`, `needs_processing`) tylko wtedy, gdy `_fields` wymienia je w całości. Samo `meta_data.key`
 * daje odpowiedź BEZ pola `meta_data` (nie pustą listę). `_links` WordPress dokłada zawsze; atrapa ich nie ma,
 * adapter ich nie czyta.
 */
export const WC_POLA_DODATKOWE_ZAMOWIENIA = ['meta_data', 'line_items', 'tax_lines', 'shipping_lines', 'fee_lines', 'coupon_lines', 'refunds', 'payment_url', 'is_editable', 'needs_payment', 'needs_processing'] as const

export function filtrujPolaWp(data: unknown, fields: string | null): unknown {
  if (fields === null || fields === '') return data
  type Drzewo = { [k: string]: true | Drzewo }
  const drzewo: Drzewo = {}
  // `break 2` jak w WP: pole podrzędne rodzica wybranego już w całości kończy
  // budowę drzewa — WordPress pomija wtedy także WSZYSTKIE dalsze pola z `_fields`, nie tylko to jedno
  pola: for (const f of fields.split(',').map((x) => x.trim()).filter(Boolean)) {
    const czesci = f.split('.')
    let w: Drzewo = drzewo
    for (const c of czesci.slice(0, -1)) {
      if (w[c] === true) break pola
      w = (w[c] ??= {}) as Drzewo
    }
    w[czesci[czesci.length - 1]!] = true
  }
  // pole dodatkowe zamówienia wybrane tylko przez pole podrzędne: WooCommerce go nie liczy, więc nie ma go w odpowiedzi
  for (const k of WC_POLA_DODATKOWE_ZAMOWIENIA) if (drzewo[k] !== undefined && drzewo[k] !== true) delete drzewo[k]
  // array_intersect_key: liczy się klucz (indeks listy też), rekurencja tylko, gdy obie strony są tablicami
  const przetnij = (v: unknown, d: Drzewo): unknown => {
    if (!v || typeof v !== 'object') return v
    const wpisy = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>)
    const out: Record<string, unknown> = {}
    for (const [k, x] of wpisy) {
      if (!(k in d)) continue
      const p = d[k]!
      out[k] = p !== true && x && typeof x === 'object' ? przetnij(x, p) : x
    }
    // PHP: tablica bez kluczy (pusty wynik) w JSON to []; lista z indeksami 0..n-1 zostaje listą
    const klucze = Object.keys(out)
    return klucze.every((k, i) => k === String(i)) ? klucze.map((k) => out[k]) : out
  }
  return Array.isArray(data) ? data.map((x) => przetnij(x, drzewo)) : przetnij(data, drzewo)
}

export interface SeedOrder {
  externalId: string
  state: 'open' | 'cancelled' | 'fulfilled'
  offer: string
  qty: number
  /** Kolejne wywołania z rosnącym `modifiedAt` = nowa rewizja. */
  modifiedAt: Date
  createdAt: Date
}

export interface HarnessInstance {
  adapter: ChannelAdapter
  putOrder(o: SeedOrder): void
  /** Psuje zamówienie w kanale (np. ilość „abc”) — getOrder musi rzucić UnreadableDataError. */
  corruptOrder(externalId: string): void
  failNextList(kind: 'PRZEJSCIOWY' | 'TRWALY'): void
  /** Metody HTTP wysłane przez adapter (uprzęże z klientem HTTP). */
  requests?: () => string[]
  /** Metody odczytu tego API; domyślnie GET (Base Courier czyta wyłącznie przez POST z listy endpointów). */
  readMethods?: string[]
  injectWriteFailure?: (f: FakeWriteFailure) => void
  /** Psuje pole odbiorcy w kanale (zły typ) — getOrderRecipient musi rzucić UnreadableDataError bez wartości. */
  corruptRecipient?: (externalId: string) => void
  /** oferta w kanale (uprzęże adapterów z `offers.read`); surowe dane z PII_SENTINELS w polach nieczytanych. */
  putOffer?: (o: SeedOffer) => void
  /** Psuje ilość oferty (np. „abc”) — oferta nie może wrócić z ilością 0. */
  corruptOffer?: (externalId: string) => void
  /**
   * zapis stanu jest bezwzględny (ustawia ilość, nie zmienia o deltę), więc zerwane połączenie po wysłaniu
   * adapter zwraca jako PRZEJSCIOWY (ponowienie bezpieczne), a nie NIEJEDNOZNACZNY.
   */
  absoluteStockWrite?: boolean
  /** status kanału, który suita ustawia w zamówieniu „101”, i odczyt statusu z kanału (uprzęże z zapisem statusu). */
  statusWrite?: { target: string; read(externalId: string): string | undefined }
  /** numery nadania zapisane w zamówieniu kanału (uprzęże z zapisem numeru nadania). */
  readTracking?: (externalId: string) => string[]
  /** ten sam kanał z adapterem, któremu wyłączono zapis (`zapisWlaczony` brak/false). */
  writeDisabled?: () => ChannelAdapter
}

export interface SeedOffer {
  /** Id w formacie ChannelOffer.externalId kanału (uprząż dobiera liczbowe, np. „201”). */
  externalId: string
  sku: string | null
  name: string
  /** null = kanał nie prowadzi stanu tej oferty. */
  qty: number | null
}

export interface ContractHarness {
  name: string
  setup(): HarnessInstance
  /** Data „teraz” adaptera (zamówienia uprzęży powinny być w oknie wstecz od niej). */
  now: Date
}

const LOOKBACK = { initialLookbackMs: 7 * 24 * 3600_000 }

async function readAll(a: ChannelAdapter, cursor: string | null = null, maxPages = 50): Promise<{ orders: Map<string, ChannelOrder>; cursor: string | null; unreadable: string[] }> {
  if (!hasOrderFeed(a)) throw new Error('bez orders.feed')
  const orders = new Map<string, ChannelOrder>()
  const unreadable: string[] = []
  let cur = cursor
  for (let i = 0; i < maxPages; i++) {
    const p = await a.listOrderChanges(cur, LOOKBACK)
    for (const it of p.items) {
      try {
        const o = it.order ?? (await a.getOrder(it.externalId))
        if (o) orders.set(o.externalId, o)
      } catch (e) {
        if (e instanceof UnreadableDataError) {
          if (!unreadable.includes(it.externalId)) unreadable.push(it.externalId) // dziennik może powtórzyć zamówienie
        }
        else throw e
      }
    }
    cur = p.nextCursor
    if (!p.hasMore) return { orders, cursor: cur, unreadable }
  }
  throw new Error('dziennik bez końca (hasMore przez 50 stron)')
}

/** Tylko przewoźnik może nie mieć dziennika; kanał, który zgubił `orders.feed`, oblewa test zamiast go pominąć. */
function kanalZDziennikiem(a: ChannelAdapter): a is ChannelAdapter & OrderFeed {
  if (a.manifest.kind === 'carrier') return false
  expect(hasOrderFeed(a)).toBe(true)
  return true
}

function assertOrderShape(o: ChannelOrder): void {
  expect(typeof o.externalId).toBe('string')
  expect(o.externalId.length).toBeGreaterThan(0)
  expect(typeof o.revision).toBe('string')
  expect(o.createdAt).toBeInstanceOf(Date)
  expect(Number.isNaN(o.createdAt.getTime())).toBe(false)
  expect(['DRAFT', 'OPEN', 'CANCELLED', 'FULFILLED']).toContain(o.lifecycle)
  expect(['UNPAID', 'PAID', 'COD', 'PARTIAL']).toContain(o.paymentState)
  expect(Number.isFinite(o.totalGross)).toBe(true)
  for (const l of o.lines) {
    expect(Number.isInteger(l.qty) && l.qty > 0).toBe(true)
    expect(Number.isFinite(l.unitPriceGross)).toBe(true)
  }
}

/** Każdy tekst odbiorcy: null albo niepusty (nigdy '' w zastępstwie); problemy jako kody. */
function assertRecipientShape(r: OrderRecipient): void {
  expect(Array.isArray(r.problemy)).toBe(true)
  for (const p of r.problemy) expect(p).toMatch(/^[a-z_]+$/)
  const texts = (o: object | null) => (o ? Object.values(o) : [])
  for (const v of [...texts(r.dostawa), ...texts(r.punktOdbioru), ...texts(r.faktura)]) {
    expect(v === null || (typeof v === 'string' && v.trim().length > 0 && v === v.trim())).toBe(true)
  }
  if (r.dostawa) for (const k of ['imieNazwisko', 'firma', 'ulica', 'numerDomu', 'numerLokalu', 'kodPocztowy', 'miasto', 'kraj', 'telefon', 'email']) expect(r.dostawa).toHaveProperty(k)
  if (r.dostawa && r.dostawa.ulica && r.dostawa.numerDomu === null) expect(r.problemy).toContain('adres_bez_podzialu')
}

export function runAdapterContract(h: ContractHarness): void {
  describe(`kontrakt adaptera: ${h.name}`, () => {
    const t0 = new Date(h.now.getTime() - 3 * 3600_000)
    const seed = (x: HarnessInstance) => {
      x.putOrder({ externalId: '101', state: 'open', offer: '10', qty: 2, createdAt: t0, modifiedAt: new Date(t0.getTime() + 60_000) })
      x.putOrder({ externalId: '102', state: 'cancelled', offer: '11', qty: 1, createdAt: t0, modifiedAt: new Date(t0.getTime() + 120_000) })
      x.putOrder({ externalId: '103', state: 'fulfilled', offer: '12', qty: 3, createdAt: t0, modifiedAt: new Date(t0.getTime() + 180_000) })
    }

    it('manifest poprawny, zdolności zgodne z metodami', () => {
      const { adapter } = h.setup()
      expect(manifestProblems(adapter.manifest)).toEqual([])
      if (adapter.manifest.capabilities.includes('orders.feed')) expect(hasOrderFeed(adapter)).toBe(true)
      if (adapter.manifest.kind === 'channel') expect(hasOrderFeed(adapter)).toBe(true)
      if (adapter.manifest.capabilities.includes('stock.write')) expect(hasStockWriter(adapter)).toBe(true)
      if (adapter.manifest.capabilities.includes('reference.find')) expect(hasReferenceFinder(adapter)).toBe(true)
      if (adapter.manifest.capabilities.includes('shipment.prepare')) expect(hasShipmentPreparer(adapter)).toBe(true)
      // zadeklarowane śledzenie przesyłki = metoda trackShipment
      if (adapter.manifest.capabilities.includes('shipment.track')) expect(hasShipmentTracker(adapter)).toBe(true)
      if (adapter.manifest.capabilities.includes('offers.read')) expect(hasOfferReader(adapter)).toBe(true)
      if (adapter.manifest.readOnly) expect(hasStockWriter(adapter)).toBe(false)
    })

    // limity zdolności (perCapability) tylko dla zdolności z manifestu, z dodatnią liczbą na minutę
    it('limity zdolności w manifeście poprawne', () => {
      const { adapter } = h.setup()
      for (const [c, l] of Object.entries(adapter.manifest.rateLimit.perCapability ?? {})) {
        expect(adapter.manifest.capabilities).toContain(c)
        expect(l!.requestsPerMinute).toBeGreaterThan(0)
        if (l!.maxConcurrent !== undefined) expect(Number.isInteger(l!.maxConcurrent) && l!.maxConcurrent >= 1).toBe(true)
      }
    })

    it('test połączenia zwraca ok/komunikat bez rzucania', async () => {
      const { adapter } = h.setup()
      const r = await adapter.testConnection()
      expect(typeof r.ok).toBe('boolean')
      expect(typeof r.message).toBe('string')
    })

    // test połączenia może podać nazwy pól dodatkowych zamówień (podpowiedź NIP / punktu / faktury) —
    // wyłącznie nazwy kluczy, nigdy wartości ani dane klienta
    it('test połączenia po zamówieniach: nazwy pól bez wartości i bez danych klienta', async () => {
      const x = h.setup()
      if (!kanalZDziennikiem(x.adapter)) return
      seed(x)
      const r = await x.adapter.testConnection()
      for (const p of PII_SENTINELS) expect(JSON.stringify(r)).not.toContain(p)
      if (!r.orderMeta) return
      expect(Number.isInteger(r.orderMeta.sample)).toBe(true)
      for (const k of r.orderMeta.keys) {
        expect(k.key).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
        expect(Number.isInteger(k.orders) && k.orders >= 1 && k.orders <= r.orderMeta.sample).toBe(true)
      }
    })

    it('dziennik od zera do końca zwraca każde zamówienie, z poprawnym cyklem życia', async () => {
      const x = h.setup()
      if (!kanalZDziennikiem(x.adapter)) return // przewoźnik nie ma dziennika
      seed(x)
      const { orders } = await readAll(x.adapter)
      expect([...orders.keys()].sort()).toEqual(['101', '102', '103'])
      for (const o of orders.values()) assertOrderShape(o)
      expect(orders.get('101')!.lifecycle).toBe('OPEN')
      expect(orders.get('102')!.lifecycle).toBe('CANCELLED')
      expect(orders.get('103')!.lifecycle).toBe('FULFILLED')
      expect(orders.get('101')!.lines[0]).toMatchObject({ offerExternalId: '10', qty: 2 })
    })

    it('zmiana po zapisanym kursorze przychodzi z nowszą rewizją', async () => {
      const x = h.setup()
      if (!kanalZDziennikiem(x.adapter)) return // przewoźnik nie ma dziennika
      seed(x)
      const first = await readAll(x.adapter)
      const old = first.orders.get('101')!.revision
      x.putOrder({ externalId: '101', state: 'cancelled', offer: '10', qty: 2, createdAt: t0, modifiedAt: new Date(t0.getTime() + 3600_000) })
      const second = await readAll(x.adapter, first.cursor)
      const o = second.orders.get('101')
      expect(o).toBeDefined()
      expect(o!.revision > old).toBe(true)
      expect(o!.lifecycle).toBe('CANCELLED')
    })

    it('getOrder: pełne zamówienie; nieznane → null', async () => {
      const x = h.setup()
      seed(x)
      if (!kanalZDziennikiem(x.adapter)) return
      const o = await x.adapter.getOrder('101')
      expect(o?.externalId).toBe('101')
      expect(await x.adapter.getOrder('999999')).toBeNull()
    })

    it('nieczytelne zamówienie nie psuje strony; getOrder rzuca UnreadableDataError (nigdy 0)', async () => {
      const x = h.setup()
      if (!kanalZDziennikiem(x.adapter)) return // przewoźnik nie ma dziennika
      seed(x)
      x.corruptOrder('102')
      const r = await readAll(x.adapter)
      expect(r.unreadable).toEqual(['102'])
      expect([...r.orders.keys()].sort()).toEqual(['101', '103'])
      if (hasOrderFeed(x.adapter)) await expect(x.adapter.getOrder('102')).rejects.toBeInstanceOf(UnreadableDataError)
    })

    it('błąd listy ma rodzaj: przejściowy i trwały', async () => {
      const x = h.setup()
      seed(x)
      if (!kanalZDziennikiem(x.adapter)) return
      x.failNextList('PRZEJSCIOWY')
      await expect(x.adapter.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
      x.failNextList('TRWALY')
      await expect(x.adapter.listOrderChanges(null, LOOKBACK)).rejects.toMatchObject({ kind: 'TRWALY' })
      const ok = await x.adapter.listOrderChanges(null, LOOKBACK)
      expect(ok.items.length).toBeGreaterThan(0)
    })

    it('zły kursor = błąd trwały (nie cichy odczyt od zera)', async () => {
      const { adapter } = h.setup()
      if (!kanalZDziennikiem(adapter)) return
      await expect(adapter.listOrderChanges('{nie-kursor', LOOKBACK)).rejects.toBeInstanceOf(AdapterError)
    })

    it('wynik bez danych osobowych klienta', async () => {
      const x = h.setup()
      if (!kanalZDziennikiem(x.adapter)) return // przewoźnik nie ma dziennika
      seed(x)
      const { orders } = await readAll(x.adapter)
      const json = JSON.stringify([...orders.values()])
      for (const p of PII_SENTINELS) expect(json).not.toContain(p)
    })

    it('adapter tylko do odczytu wysyła wyłącznie metody odczytu', async () => {
      const x = h.setup()
      if (!x.adapter.manifest.readOnly || !x.requests) return
      seed(x)
      if (hasOrderFeed(x.adapter)) {
        await readAll(x.adapter)
        await x.adapter.getOrder('101')
      }
      await x.adapter.testConnection()
      expect(x.requests().length).toBeGreaterThan(0)
      expect(new Set(x.requests())).toEqual(new Set(x.readMethods ?? ['GET']))
    })

    it('odbiorca na żądanie: kształt bez pustych stringów, brak zamówienia = błąd trwały, nieczytelne pole bez wartości', async () => {
      const x = h.setup()
      if (x.adapter.manifest.capabilities.includes('orders.recipient')) expect(hasRecipientReader(x.adapter)).toBe(true)
      if (!hasRecipientReader(x.adapter)) return
      seed(x)
      const r = await x.adapter.getOrderRecipient('101')
      assertRecipientShape(r)
      await expect(x.adapter.getOrderRecipient('999999')).rejects.toMatchObject({ kind: 'TRWALY' })
      await expect(x.adapter.getOrderRecipient('../zly')).rejects.toBeInstanceOf(AdapterError)
      if (x.corruptRecipient) {
        x.corruptRecipient('103')
        const e = await x.adapter.getOrderRecipient('103').then(() => null, (err: unknown) => err)
        expect(e).toBeInstanceOf(UnreadableDataError)
        for (const p of PII_SENTINELS) expect(String((e as Error).message)).not.toContain(p)
      }
      if (x.adapter.manifest.readOnly && x.requests) expect(new Set(x.requests())).toEqual(new Set(x.readMethods ?? ['GET']))
    })

    // lista ofert (offers.read) — strony do końca kursora, bez danych osobowych, nieczytelne nie jako 0.
    it('oferty: wszystkie strony do pustego kursora, bez PII, nieczytelna ilość nie jest zerem', async () => {
      const x = h.setup()
      if (!hasOfferReader(x.adapter) || !x.putOffer) return
      const seeded: SeedOffer[] = [
        { externalId: '201', sku: 'SKU-201', name: 'Przyprawa testowa 1', qty: 5 },
        { externalId: '202', sku: 'SKU-202', name: 'Przyprawa testowa 2', qty: 0 },
        { externalId: '203', sku: null, name: 'Bez SKU', qty: 2 },
        { externalId: '204', sku: 'SKU-204', name: 'Bez stanu', qty: null },
        { externalId: '205', sku: 'SKU-205', name: 'Przyprawa testowa 5', qty: 7 },
      ]
      for (const o of seeded) x.putOffer(o)
      if (x.corruptOffer) x.corruptOffer('205')
      const all: ChannelOfferRow[] = []
      const unreadable: string[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const p: OfferPageWithProblems = await x.adapter.listOffers(cursor)
        all.push(...p.items)
        unreadable.push(...(p.unreadable ?? []).map((u) => u.externalId))
        cursor = p.nextCursor
        pages++
        if (pages > 50) throw new Error('oferty bez końca kursora (50 stron)')
      } while (cursor !== null)
      const byId = new Map(all.map((o) => [o.externalId, o]))
      const expected = seeded.filter((o) => !x.corruptOffer || o.externalId !== '205')
      expect([...byId.keys()].sort()).toEqual(expected.map((o) => o.externalId).sort())
      for (const o of expected) expect(byId.get(o.externalId)).toMatchObject({ sku: o.sku, qty: o.qty })
      if (x.corruptOffer) {
        expect(byId.has('205')).toBe(false) // nigdy z ilością 0
        expect(unreadable).toContain('205')
      }
      const json = JSON.stringify(all)
      for (const p of PII_SENTINELS) expect(json).not.toContain(p)
      if (x.adapter.manifest.readOnly && x.requests) expect(new Set(x.requests())).toEqual(new Set(x.readMethods ?? ['GET']))
      await expect(x.adapter.listOffers('nie-kursor')).rejects.toBeInstanceOf(AdapterError)
    })

    it('zapis stanu: OK, idempotentny po referencji; niejednoznaczny rozstrzyga odszukanie', async () => {
      const x = h.setup()
      const a = x.adapter
      if (!hasStockWriter(a) || !x.injectWriteFailure) return
      const items = [{ offerExternalId: '10', qty: 5 }]
      expect((await executeWrite(a, 'ref-1', () => a.pushStock(items, 'ref-1'))).kind).toBe('OK')
      expect((await executeWrite(a, 'ref-1', () => a.pushStock(items, 'ref-1'))).kind).toBe('OK')
      x.injectWriteFailure('PRZEJSCIOWY')
      expect((await executeWrite(a, 'ref-2', () => a.pushStock(items, 'ref-2'))).kind).toBe('PRZEJSCIOWY')
      x.injectWriteFailure('TRWALY')
      expect((await executeWrite(a, 'ref-3', () => a.pushStock(items, 'ref-3'))).kind).toBe('TRWALY')
      if (x.absoluteStockWrite) {
        // zerwane połączenie po wysłaniu: bezwzględny zapis wolno ponowić, więc PRZEJSCIOWY w obu przypadkach
        x.injectWriteFailure('NIEJEDNOZNACZNY_WYKONANY')
        expect((await executeWrite(a, 'ref-4', () => a.pushStock(items, 'ref-4'))).kind).toBe('PRZEJSCIOWY')
        x.injectWriteFailure('NIEJEDNOZNACZNY_NIEWYKONANY')
        expect((await executeWrite(a, 'ref-5', () => a.pushStock(items, 'ref-5'))).kind).toBe('PRZEJSCIOWY')
      } else if (hasReferenceFinder(a)) {
        x.injectWriteFailure('NIEJEDNOZNACZNY_WYKONANY')
        expect((await executeWrite(a, 'ref-4', () => a.pushStock(items, 'ref-4'))).kind).toBe('OK')
        x.injectWriteFailure('NIEJEDNOZNACZNY_NIEWYKONANY')
        expect((await executeWrite(a, 'ref-5', () => a.pushStock(items, 'ref-5'))).kind).toBe('PRZEJSCIOWY')
      }
    })

    // zapis statusu i numeru nadania — idempotentny (powtórka nie zapisuje drugi raz), niejednoznaczny
    // rozstrzyga odszukanie po referencji; zapis wyłączony = TRWALY bez żadnego żądania (także GET).
    it('zapis statusu: OK, powtórka bez drugiego zapisu, niejednoznaczny rozstrzyga odszukanie', async () => {
      const x = h.setup()
      const a = x.adapter
      if (a.manifest.capabilities.includes('order.status.write')) expect(hasOrderStatusWriter(a)).toBe(true)
      if (!hasOrderStatusWriter(a) || !x.statusWrite) return
      seed(x)
      const t = x.statusWrite.target
      expect((await executeWrite(a, 's-1', () => a.setOrderStatus('101', t, 's-1'))).kind).toBe('OK')
      expect(x.statusWrite.read('101')).toBe(t)
      // metody odczytu z uprzęży (IdoSell czyta przez POST wyszukiwania), domyślnie GET
      const odczyt = x.readMethods ?? ['GET']
      const before = x.requests?.().filter((m) => !odczyt.includes(m)).length
      expect((await executeWrite(a, 's-2', () => a.setOrderStatus('101', t, 's-2'))).kind).toBe('OK')
      if (x.requests) expect(x.requests().filter((m) => !odczyt.includes(m)).length).toBe(before)
      expect((await executeWrite(a, 's-3', () => a.setOrderStatus('999999', t, 's-3'))).kind).toBe('TRWALY')
      if (x.injectWriteFailure && hasReferenceFinder(a)) {
        // zamówienie otwarte (zrealizowanego adapter może nie cofać)
        x.putOrder({ externalId: '104', state: 'open', offer: '13', qty: 1, createdAt: t0, modifiedAt: new Date(t0.getTime() + 240_000) })
        x.injectWriteFailure('NIEJEDNOZNACZNY_WYKONANY')
        expect((await executeWrite(a, 's-4', () => a.setOrderStatus('104', t, 's-4'))).kind).toBe('OK')
        expect(x.statusWrite.read('104')).toBe(t)
      }
    })

    it('zapis numeru nadania: OK, powtórka nie dubluje wpisu', async () => {
      const x = h.setup()
      const a = x.adapter
      if (a.manifest.capabilities.includes('order.tracking.write')) expect(hasTrackingWriter(a)).toBe(true)
      if (!hasTrackingWriter(a) || !x.readTracking) return
      seed(x)
      const t = { number: 'TEST1234567890', carrier: 'DPD' }
      expect((await executeWrite(a, 't-1', () => a.setTracking('101', t, 't-1'))).kind).toBe('OK')
      expect((await executeWrite(a, 't-2', () => a.setTracking('101', t, 't-2'))).kind).toBe('OK')
      expect(x.readTracking('101').filter((n) => n === t.number)).toHaveLength(1)
    })

    it('zapis wyłączony na koncie: TRWALY, zero żądań do kanału', async () => {
      const x = h.setup()
      if (!x.writeDisabled) return
      const off = x.writeDisabled()
      const n0 = x.requests?.().length ?? 0
      if (hasStockWriter(off)) expect((await off.pushStock([{ offerExternalId: '10', qty: 1 }], 'w-1')).kind).toBe('TRWALY')
      if (hasOrderStatusWriter(off)) expect((await off.setOrderStatus('101', x.statusWrite?.target ?? 'x', 'w-2')).kind).toBe('TRWALY')
      if (hasTrackingWriter(off)) expect((await off.setTracking('101', { number: 'TEST1234567890', carrier: 'DPD' }, 'w-3')).kind).toBe('TRWALY')
      if (x.requests) expect(x.requests().length).toBe(n0)
    })
  })
}
