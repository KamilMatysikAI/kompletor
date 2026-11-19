// (Etap 3a): publiczny odczyt do ofertowania i transport wystawiania w adapterach Allegro, Empiku i sklepu Woo.
// Odczyt tylko GET z listy ścieżek; zapis ofert tylko przy osobnym wyłączniku `wystawianieOfertWlaczone` (włączony zapis
// stanów `zapisWlaczony` NIE wystarcza) i tylko na jednej ścieżce kanału. Wyłącznie atrapa `fetch` w pamięci: żadnego
// prawdziwego Allegro, Empiku ani sklepu.
import { describe, expect, it } from 'vitest'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, UA } from '@/tests/allegro-atrapa'
import { assertAllegroWritePath } from '../zrodla/allegro-zapis'
import { type FetchLike, ReadOnlyViolation } from '../zrodla/http'
import { miraklQueryZapisu } from '../zrodla/mirakl'
import { WooWriter } from '../zrodla/woo-zapis'
import { ALLEGRO_SECRETS as S } from './allegro'
import { ALLEGRO_ZAPIS_KEY, ALLEGRO_ZAPIS_MANIFEST } from './allegro-zapis'
import { defaultRegistry } from './domyslne'
import { WYSTAWIANIE_OFERT_KLUCZ } from './kontrakt'
import { MIRAKL_EMPIK_ZAPIS_MANIFEST } from './mirakl-empik'
import { WOO_ZAPIS_KEY, WOO_ZAPIS_MANIFEST } from './woo-zapis'

const NOW = new Date('2026-11-10T10:00:00.000Z')
const FAST = { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0, pollDelayMs: 0 }

type Wywolanie = { metoda: string; url: string }
function atrapa(odp: () => Response = () => new Response('{"id":"7700123"}', { status: 201, headers: { 'content-type': 'application/json' } })) {
  const wywolania: Wywolanie[] = []
  const fetch: FetchLike = async (u, i) => {
    wywolania.push({ metoda: String(i?.method ?? 'GET'), url: String(u) })
    return odp()
  }
  return { fetch, wywolania }
}

type Ofertowy = { odczytDoOfert: (p: string, q?: unknown) => Promise<unknown>; zapisOfert: (m: 'POST', s: string, c: unknown, q?: Record<string, string>) => Promise<{ status: number }> }

function allegro(config: Record<string, unknown>, f = atrapa()) {
  const a = defaultRegistry().create(ALLEGRO_ZAPIS_KEY, {
    integration: { organizationId: 'org', kind: 'channel', id: 'ALLEGRO/test', name: 'Allegro', channel: 'ALLEGRO', channelAccountId: 'test' },
    rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA, ...config },
    rawSecrets: { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: 'token-atrapa', [S.refresh]: 'odswiezenie-atrapa', [S.expiresAt]: new Date(NOW.getTime() + 3_600_000).toISOString() },
    fetch: f.fetch,
    now: () => NOW,
    http: FAST,
    persistSecrets: async () => {},
  }) as unknown as Ofertowy
  return { a, f }
}

function empik(config: Record<string, unknown>, f = atrapa()) {
  const a = defaultRegistry().create('mirakl.empik.zapis.v1', {
    integration: { organizationId: 'org', kind: 'channel', id: 'EMPIK/test', name: 'Empik', channel: 'EMPIK', channelAccountId: 'test' },
    rawConfig: { baseUrl: 'https://empik.example/api', ...config },
    rawSecrets: { MIRAKL_API_KEY: 'klucz-atrapa' },
    fetch: f.fetch,
    now: () => NOW,
    http: FAST,
  }) as unknown as Ofertowy
  return { a, f }
}

function woo(config: Record<string, unknown>, sekrety: Record<string, string> = { WOO_WRITE_KEY: 'ck_zapis', WOO_WRITE_SECRET: 'cs_zapis' }, f = atrapa()) {
  const a = defaultRegistry().create(WOO_ZAPIS_KEY, {
    integration: { organizationId: 'org', kind: 'channel', id: 'WOO/test', name: 'Sklep', channel: 'WOO', channelAccountId: 'test' },
    rawConfig: { baseUrl: 'https://sklep.example', ...config },
    rawSecrets: { WOO_CONSUMER_KEY: 'ck_odczyt', WOO_CONSUMER_SECRET: 'cs_odczyt', ...sekrety },
    fetch: f.fetch,
    now: () => NOW,
    http: FAST,
  }) as unknown as Ofertowy
  return { a, f }
}

const plik = () => {
  const form = new FormData()
  form.append('file', new Blob(['a;b'], { type: 'text/csv' }), 'offers.csv')
  return form
}

describe('listy dozwolonych zapisów', () => {
  it('Allegro: POST /sale/product-offers dozwolone, inna metoda i parametry nie', () => {
    expect(() => assertAllegroWritePath('POST', '/sale/product-offers')).not.toThrow()
    expect(() => assertAllegroWritePath('PUT', '/sale/product-offers')).toThrow(ReadOnlyViolation)
    expect(() => assertAllegroWritePath('POST', '/sale/product-offers/123')).toThrow(ReadOnlyViolation)
    expect(() => assertAllegroWritePath('POST', '/sale/product-offers?x=1')).toThrow(ReadOnlyViolation)
  })

  it('Mirakl: `import_mode` tylko przy importach ofert i produktów, tylko znane wartości', () => {
    expect(miraklQueryZapisu('/offers/imports', { import_mode: 'NORMAL' })).toBe('?import_mode=NORMAL')
    expect(miraklQueryZapisu('/products/imports', { import_mode: 'NORMAL' })).toBe('?import_mode=NORMAL')
    expect(miraklQueryZapisu('/offers/imports', undefined)).toBe('')
    expect(() => miraklQueryZapisu('/offers/stock/imports', { import_mode: 'NORMAL' })).toThrow(ReadOnlyViolation)
    expect(() => miraklQueryZapisu('/offers/imports', { import_mode: 'DELETE_ALL' })).toThrow(ReadOnlyViolation)
    // tylko NORMAL — REPLACE kasuje oferty spoza pliku
    for (const tryb of ['REPLACE', 'PARTIAL_UPDATE', 'normal', ''])
      for (const sciezka of ['/offers/imports', '/products/imports']) expect(() => miraklQueryZapisu(sciezka, { import_mode: tryb })).toThrow(ReadOnlyViolation)
    expect(() => miraklQueryZapisu('/offers/imports', { import_mode: 'NORMAL', shop: '1' })).toThrow(ReadOnlyViolation)
  })

  it('Woo: `POST /products/batch` jest na liście (zakładanie produktu idzie tą samą ścieżką co stany)', () => {
    expect(WooWriter.allowed('POST', '/products/batch')).toBe(true)
    expect(WooWriter.allowed('POST', '/products')).toBe(false)
  })

  it('manifesty z zapisem mają osobny wyłącznik wystawiania; Allegro także cennik dostaw, zwroty i reklamacje', () => {
    for (const m of [ALLEGRO_ZAPIS_MANIFEST, MIRAKL_EMPIK_ZAPIS_MANIFEST, WOO_ZAPIS_MANIFEST]) expect(m.config.some((f) => f.key === WYSTAWIANIE_OFERT_KLUCZ && f.type === 'boolean')).toBe(true)
    const klucze = ALLEGRO_ZAPIS_MANIFEST.config.map((f) => f.key)
    expect(klucze).toEqual(expect.arrayContaining(['cennikDostawId', 'zwrotyId', 'reklamacjeId']))
  })
})

describe('Allegro: odczyt do ofert i wystawianie', () => {
  it('odczyt idzie GET z tokenem konta tylko na ścieżki ofertowania', async () => {
    const { a, f } = allegro({})
    await a.odczytDoOfert('/sale/products', [['phrase', '5901234123457']])
    await a.odczytDoOfert('/sale/categories/258832/parameters', [])
    expect(f.wywolania.map((w) => w.metoda)).toEqual(['GET', 'GET'])
    expect(f.wywolania[0]!.url).toContain('/sale/products?phrase=5901234123457')
    await expect(a.odczytDoOfert('/order/checkout-forms', [])).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(a.odczytDoOfert('/sale/offer-quantity-change-commands/x', [])).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(f.wywolania).toHaveLength(2)
  })

  it('bez `wystawianieOfertWlaczone` zero żądań, także przy włączonym zapisie stanów', async () => {
    // Uwaga: tekst 'true' rejestr zamienia na true (jak każdy przełącznik boolean manifestu), więc tu jawne „nie”.
    for (const config of [{}, { zapisWlaczony: true }, { zapisWlaczony: true, [WYSTAWIANIE_OFERT_KLUCZ]: false }, { [WYSTAWIANIE_OFERT_KLUCZ]: 'false' }]) {
      const { a, f } = allegro(config)
      await expect(a.zapisOfert('POST', '/sale/product-offers', { name: 'x' })).rejects.toBeInstanceOf(ReadOnlyViolation)
      expect(f.wywolania).toEqual([])
    }
  })

  it('z wyłącznikiem: jedno POST /sale/product-offers; inna ścieżka odrzucona przed wysłaniem', async () => {
    const { a, f } = allegro({ [WYSTAWIANIE_OFERT_KLUCZ]: true })
    const r = await a.zapisOfert('POST', '/sale/product-offers', { name: 'Przyprawa' })
    expect(r.status).toBe(201)
    expect(f.wywolania).toEqual([{ metoda: 'POST', url: `${API}/sale/product-offers` }])
    await expect(a.zapisOfert('POST', '/sale/offer-quantity-change-commands/abc', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(f.wywolania).toHaveLength(1)
  })
})

describe('Empik: odczyt do ofert i wystawianie', () => {
  it('odczyt tylko P31 i H11', async () => {
    const { a, f } = empik({}, atrapa(() => new Response('{"products":[]}', { status: 200 })))
    await a.odczytDoOfert('/products', { product_references: 'EAN|5901234123457' })
    await a.odczytDoOfert('/hierarchies', {})
    expect(f.wywolania.map((w) => w.metoda)).toEqual(['GET', 'GET'])
    await expect(a.odczytDoOfert('/orders', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(f.wywolania).toHaveLength(2)
  })

  it('bez wyłącznika wystawiania zero żądań; z nim import z `import_mode`, tylko plik', async () => {
    const off = empik({ zapisWlaczony: true })
    await expect(off.a.zapisOfert('POST', '/offers/imports', plik(), { import_mode: 'NORMAL' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(off.f.wywolania).toEqual([])
    const on = empik({ [WYSTAWIANIE_OFERT_KLUCZ]: true }, atrapa(() => new Response('{"import_id":42}', { status: 201 })))
    const r = await on.a.zapisOfert('POST', '/offers/imports', plik(), { import_mode: 'NORMAL' })
    expect(r).toEqual({ status: 201, body: { import_id: 42 } })
    expect(on.f.wywolania).toEqual([{ metoda: 'POST', url: 'https://empik.example/api/offers/imports?import_mode=NORMAL' }])
    await expect(on.a.zapisOfert('POST', '/offers/imports', { json: true })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(on.a.zapisOfert('POST', '/offers/stock/imports', plik())).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(on.f.wywolania).toHaveLength(1)
  })

  it('`import_mode` REPLACE i PARTIAL_UPDATE odrzucone przed wysłaniem (zero żądań)', async () => {
    const on = empik({ [WYSTAWIANIE_OFERT_KLUCZ]: true }, atrapa(() => new Response('{"import_id":42}', { status: 201 })))
    for (const tryb of ['REPLACE', 'PARTIAL_UPDATE'])
      for (const sciezka of ['/offers/imports', '/products/imports'])
        await expect(on.a.zapisOfert('POST', sciezka, plik(), { import_mode: tryb })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(on.f.wywolania).toEqual([])
  })
})

describe('sklep Woo: odczyt do ofert i wystawianie', () => {
  it('odczyt tylko kategorii i produktów', async () => {
    const { a, f } = woo({}, undefined, atrapa(() => new Response('[]', { status: 200 })))
    await a.odczytDoOfert('/products/categories', { per_page: 100 })
    await a.odczytDoOfert('/products', { sku: 'HC-1' })
    await expect(a.odczytDoOfert('/orders', {})).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(f.wywolania.map((w) => w.metoda)).toEqual(['GET', 'GET'])
  })

  it('bez wyłącznika albo bez klucza zapisu zero żądań; z nimi jeden `create`', async () => {
    const off = woo({ zapisWlaczony: true })
    await expect(off.a.zapisOfert('POST', '/products/batch', { create: [{ name: 'x' }] })).rejects.toBeInstanceOf(ReadOnlyViolation)
    const bezKlucza = woo({ [WYSTAWIANIE_OFERT_KLUCZ]: true }, {})
    await expect(bezKlucza.a.zapisOfert('POST', '/products/batch', { create: [{ name: 'x' }] })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect([...off.f.wywolania, ...bezKlucza.f.wywolania]).toEqual([])
    const on = woo({ [WYSTAWIANIE_OFERT_KLUCZ]: true }, undefined, atrapa(() => new Response('{"create":[{"id":501}]}', { status: 200 })))
    expect((await on.a.zapisOfert('POST', '/products/batch', { create: [{ name: 'x' }] })).status).toBe(200)
    // stany (`update`) i kilka produktów naraz nie idą tą drogą
    await expect(on.a.zapisOfert('POST', '/products/batch', { update: [{ id: 1, stock_quantity: 0 }] })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(on.a.zapisOfert('POST', '/products/batch', { create: [{}, {}] })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(on.f.wywolania).toHaveLength(1)
    expect(on.f.wywolania[0]!.metoda).toBe('POST')
  })
})
