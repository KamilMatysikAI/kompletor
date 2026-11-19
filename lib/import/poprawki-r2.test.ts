// przypadki z drugiego przeglądu, bez bazy.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { bl, sale, shop, smallRaw, TEST_CHANNEL_MAP, testKnownAccounts, wf } from '@/tests/fixtures'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { SourceError, withRetry } from '../zrodla/http'
import type { MiraklReadOnly } from '../zrodla/mirakl'
import { WfirmaReadOnly } from '../zrodla/wfirma'
import { reportDir } from '../worker/zadania'
import { analyze, channelComplete, collectSources, MISSING_KEYS } from './katalog'
import { aggregateSales, classifyFromSales, classifyShopOffers, MANUAL_LINE_NAME, offerIntent, planCatalog } from './mapowanie'
import { applyOfferOverrides, parseOfferOverrides } from './nadpisania'
import { blProdFromApi } from './normalizacja'
import { fetchEmpikOffers } from './pobieranie'
import { renderReport } from './raport'

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('uwaga 1: Woo po samym SKU = propozycja; warianty o wspólnym SKU bez powiązania', () => {
  it('dwa warianty 7/70 i 7/71 z SKU X → wieloznaczne z notatką, pojedyncze po SKU → propozycja', () => {
    const blList = [bl({ id: 'b', sku: 'X' }), bl({ id: 'c', sku: 'Y' })]
    const offers = [
      shop({ productId: '7', isParentWithVariants: true }),
      shop({ productId: '7', variantId: '70', sku: 'X' }),
      shop({ productId: '7', variantId: '71', sku: 'X' }),
      shop({ productId: '8', sku: 'Y' }),
    ]
    const r = classifyShopOffers(offers, blList, new Map(), undefined, TEST_CHANNEL_MAP.shopAccounts)
    const by = Object.fromEntries(r.map((o) => [o.externalId, o]))
    for (const id of ['7/70', '7/71']) {
      expect(by[id]).toMatchObject({ state: 'AMBIGUOUS', source: 'SKU' })
      expect(by[id]!.notes.join()).toContain('warianty o wspólnym SKU')
    }
    expect(by['8']).toMatchObject({ state: 'MAPPED', source: 'SKU' })
    expect(offerIntent(by['8']!)).toBe('PROPOSAL')
  })

  it('pewne źródła (link BL, sprzedaż BL, Empik shop_sku, nadpisanie) dają ofertę aktywną', () => {
    const base = { channel: 'WOO' as const, accountId: '1', externalId: '1', sku: null, ean: null, name: '', state: 'MAPPED' as const, blProductIds: ['1'], sales90dQty: 0, sales90dOrders: 0, lastSoldAt: null, notes: [] }
    expect(offerIntent({ ...base, source: 'BL_LINK' })).toBe('ACTIVE')
    expect(offerIntent({ ...base, channel: 'EMPIK', source: 'SKU' })).toBe('ACTIVE')
    expect(offerIntent({ ...base, channel: 'ALLEGRO', source: 'OVERRIDE' })).toBe('ACTIVE')
  })
})

describe('uwaga 3: brak kluczy = niepełne pobranie', () => {
  const blStub = {
    async call(m: string) {
      if (m === 'getInventories') return { inventories: [{ inventory_id: 77701, default_price_group: 1 }] }
      if (m === 'getInventoryProductsList') return { products: {} }
      if (m === 'getInventoryIntegrations') return { integrations: {} }
      if (m === 'getExternalStorageProductsList') return { products: [] }
      return { orders: [] }
    },
  } as unknown as BaseLinkerReadOnly

  it('collectSources bez wFirmy i Empiku zapisuje „brak-kluczy” w issues', async () => {
    const raw = await collectSources({ bl: blStub, wfirma: null, empik: null, inventoryId: '77701', wfirmaWarehouseId: null, shopStorages: [], channels: TEST_CHANNEL_MAP })
    expect(raw.issues.filter((i) => i.kind === MISSING_KEYS).map((i) => i.ref).sort()).toEqual(['empik', 'wfirma'])
  })

  it('channelComplete: brak wFirmy → nic; brak Empiku → tylko Empik niepełny; błąd sklepu → tylko ten sklep', () => {
    const raw = smallRaw()
    expect(channelComplete(raw, 'WOO', '7100001')).toBe(true)
    expect(channelComplete({ ...raw, wfirma: null }, 'ALLEGRO', '71045')).toBe(false)
    const noEmpik = { ...raw, empik: null, issues: [{ kind: MISSING_KEYS, ref: 'empik', message: '' }] }
    expect(channelComplete(noEmpik, 'EMPIK', '30193')).toBe(false)
    expect(channelComplete(noEmpik, 'ALLEGRO', '71045')).toBe(true)
    const shopFail = { ...raw, issues: [{ kind: 'bl-sklep-paczka', ref: 'shop_7100002:1…', message: '' }] }
    expect(channelComplete(shopFail, 'WOO', '7100002')).toBe(false)
    expect(channelComplete(shopFail, 'WOO', '7100001')).toBe(true)
    expect(channelComplete({ ...raw, sales: { ...raw.sales, complete: false } }, 'ALLEGRO', '71045')).toBe(false)
    expect(channelComplete({ ...raw, issues: [{ kind: 'bl-paczka-produktow', ref: '1…', message: '' }] }, 'WOO', '7100001')).toBe(false)
  })
})

describe('uwaga 4: link BL do towaru spoza pobranego zbioru', () => {
  it('wfirmaGoodIdLink 999 + SKU zgodne z innym towarem → linkTargetMissing, bez produktu', () => {
    const plan = planCatalog([bl({ id: 'a', sku: 'S', wfirmaGoodIdLink: '999' })], [wf({ id: '1', code: 'S' })])
    expect(plan.linkTargetMissing).toHaveLength(1)
    expect(plan.linkTargetMissing[0]!.wfirmaGoodIdLink).toBe('999')
    expect(plan.products).toHaveLength(0)
    expect(plan.blWithoutWfirma.map((p) => p.id)).toEqual(['a'])
  })

  it('raport i CSV pokazują link do nieistniejącego towaru', () => {
    const raw = smallRaw()
    raw.bl.products.push(bl({ id: '9', sku: 'A1', wfirmaGoodIdLink: '999' }))
    const rep = renderReport(raw, analyze(raw), { generatedAt: new Date() })
    expect(rep.markdown).toContain('towar spoza pobranego magazynu** (usunięty albo w innym magazynie): **1**')
    expect(rep.csv['bl-bez-wfirmy.csv']).toMatch(/9;A1;.*;999;tak/)
  })
})

describe('uwaga 5 i 13: limit wFirmy i ponawianie', () => {
  const keys = { accessKey: 'a', secretKey: 's', appKey: 'p', companyId: '42' }
  it.each(['AUTH FAILED LIMIT WAIT 5 MINUTES', 'TOTAL REQUESTS LIMIT EXCEEDED'])('%s → fetch wywołany raz', async (code) => {
    const f = vi.fn(async () => okJson({ status: { code } }))
    await expect(new WfirmaReadOnly(keys, f, 0).call('goods/find', {})).rejects.toThrow('bez ponawiania')
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('HTTP 429 z wFirmy → bez ponawiania', async () => {
    const f = vi.fn(async () => new Response('', { status: 429 }))
    await expect(new WfirmaReadOnly(keys, f, 0).call('goods/find', {})).rejects.toBeInstanceOf(SourceError)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('withRetry: błąd w kodzie (SyntaxError) leci od razu, SourceError.retryable i AbortError są ponawiane', async () => {
    const syntax = vi.fn(async () => {
      throw new SyntaxError('zły JSON')
    })
    await expect(withRetry(syntax, { attempts: 4, baseDelayMs: 0 })).rejects.toBeInstanceOf(SyntaxError)
    expect(syntax).toHaveBeenCalledTimes(1)
    let n = 0
    const flaky = vi.fn(async () => {
      if (n++ === 0) throw Object.assign(new Error('przerwane'), { name: 'AbortError' })
      if (n === 2) throw new SourceError('503', true)
      return 'ok'
    })
    await expect(withRetry(flaky, { attempts: 4, baseDelayMs: 0 })).resolves.toBe('ok')
    expect(flaky).toHaveBeenCalledTimes(3)
  })
})

describe('drobne', () => {
  it('7: składnik w szt. z ułamkową ilością → problem zestawu, zestaw nie powstaje', () => {
    const plan = planCatalog(
      [bl({ id: 's', sku: 'S', wfirmaGoodIdLink: '1' }), bl({ id: 'z', sku: 'Z', isBundle: true, bundleProducts: { s: 1.5 } })],
      [wf({ id: '1', code: 'S' })],
    )
    expect(plan.products.find((p) => p.sku === 'Z')).toBeUndefined()
    expect(plan.bundleProblems[0]!.problem).toContain('nie jest całkowita')
  })

  it('11: błąd w środku stronicowania OF21 → null (nie niepełna lista)', async () => {
    let call = 0
    const mk = {
      async get() {
        if (call++ === 0) return { offers: Array.from({ length: 100 }, (_, i) => ({ product_sku: String(i), offer_id: i })), total_count: 150 }
        throw new Error('503')
      },
    } as unknown as MiraklReadOnly
    const issues: { kind: string; ref: string; message: string }[] = []
    expect(await fetchEmpikOffers(mk, issues)).toBeNull()
    expect(issues[0]!.kind).toBe('empik-oferty')
  })

  it('14: pozycja ręczna bez SKU i oferty — w kluczu i nazwie tylko skrót, nie tekst z BL', () => {
    const lines = [sale({ channel: 'RECZNE', accountId: '0', name: 'Jan Kowalski, ul. Prosta 1', productId: null, auctionId: null })]
    const r = classifyFromSales(aggregateSales(lines, []), ['RECZNE'])
    expect(r[0]!.externalId).toMatch(/^nazwa:[0-9a-f]{10}$/)
    expect(r[0]!.name).toBe(MANUAL_LINE_NAME)
    expect(JSON.stringify(r)).not.toContain('Kowalski')
  })

  it('15: raportDir tylko wewnątrz RAPORTY_DIR', () => {
    const env = { RAPORTY_DIR: 'C:\\tmp\\raporty-test' }
    expect(reportDir(env, 'import-2026')).toMatch(/raporty-test[\\/]import-2026$/)
    for (const bad of ['..\\poza', '../poza', 'C:\\Windows', '/etc', 'a/../../b']) expect(() => reportDir(env, bad)).toThrow('odrzucony')
  })

  it('lokalizacje z BL: parsowane, pierwsza wygrywa, konflikt raportowany', () => {
    const [p] = blProdFromApi('1', { sku: 'A', locations: { bl_2: 'B-3-4', bl_1: ' A-1-1 ', bl_3: '' } }, '1')
    expect(p!.locations).toEqual({ bl_2: 'B-3-4', bl_1: 'A-1-1' })
    const plan = planCatalog(
      [bl({ id: 'a', sku: 'X', wfirmaGoodIdLink: '1', locations: { bl_1: 'B-3-4' } }), bl({ id: 'b', sku: '0X', wfirmaGoodIdLink: '1', locations: { bl_1: 'C-1-1' } })],
      [wf({ id: '1', code: 'X' })],
    )
    expect(plan.products[0]!.location).toBe('B-3-4')
    expect(plan.locationConflicts).toEqual([{ key: 'wf:1', locations: ['B-3-4', 'C-1-1'] }])
  })
})

describe('nadpisania ofert', () => {
  const csvText = 'kanal;konto;id_oferty;sku;uwagi\n# komentarz\nALLEGRO;71045;9002;C1;powiązane w BL\nALLEGRO;71045;5555;A1;bez sprzedaży\nALLEGRO;71045;6666;NIE-MA;\n'
  it('parsuje plik, odrzuca zły wiersz i duble', () => {
    expect(parseOfferOverrides(csvText, testKnownAccounts())).toHaveLength(3)
    expect(() => parseOfferOverrides('nagłówek\nALLEGRO;71045;1\n', testKnownAccounts())).toThrow('wiersz 2')
    expect(() => parseOfferOverrides('n\nALLEGRO;71045;1;A\nALLEGRO;71045;1;B\n', testKnownAccounts())).toThrow('powtórzona')
  })

  it('oferta bez powiązania z historii staje się MAPPED/OVERRIDE; brakująca w oknie dopisana; zły SKU = problem', () => {
    const raw = smallRaw()
    const a = analyze(raw, parseOfferOverrides(csvText, testKnownAccounts()))
    const by = Object.fromEntries(a.offers.filter((o) => o.channel === 'ALLEGRO').map((o) => [o.externalId, o]))
    expect(by['9002']).toMatchObject({ state: 'MAPPED', source: 'OVERRIDE', blProductIds: ['3'], sales90dQty: 5 })
    expect(by['5555']).toMatchObject({ state: 'MAPPED', source: 'OVERRIDE', blProductIds: ['1'], sales90dQty: 0 })
    expect(by['6666']).toBeUndefined()
    expect(a.overrideProblems.join()).toContain('NIE-MA')
    const rep = renderReport(raw, a, { generatedAt: new Date() })
    expect(rep.markdown).toContain('## Nadpisania powiązań')
    expect(rep.markdown).toContain('bez jednoznacznego powiązania = 0**')
  })

  it('applyOfferOverrides nie wiąże z produktem BL bez towaru w wFirmie', () => {
    const offers: Parameters<typeof applyOfferOverrides>[0] = []
    const p = applyOfferOverrides(offers, [{ channel: 'ALLEGRO', accountId: '71045', externalId: '1', sku: 'Q', note: '' }], [bl({ id: 'q', sku: 'Q' })], new Set())
    expect(offers).toHaveLength(0)
    expect(p[0]).toContain('nie ma towaru w wFirmie')
  })
})

describe('drobne 6–8', () => {
  it('6: domyślny plik nadpisań liczony od katalogu repo, nie od cwd', async () => {
    // plik per firma (dane/nadpisania-ofert/<id>.csv); ACME ma swój, firma bez pliku = brak nadpisań
    const { overridesFileOf, loadOfferOverrides } = await import('./nadpisania')
    // plik firmy spoza publicznego repo leży w prywatnej nakładce (prywatne/nadpisania-ofert/<id>.csv)
    expect(overridesFileOf('acme', {}).replace(/\\/g, '/')).toMatch(/\/(dane|prywatne)\/nadpisania-ofert\/acme\.csv$/)
    expect(overridesFileOf('firma_bez_pliku', {}).replace(/\\/g, '/')).toMatch(/\/dane\/nadpisania-ofert\/firma_bez_pliku\.csv$/)
    expect(overridesFileOf('acme', { KOMPLETOR_NADPISANIA_KATALOG: '/konfiguracja/nadpisania' })).toBe(path.join(path.resolve('/konfiguracja/nadpisania'), 'acme.csv'))
    // plik nadpisań ACME jest opcjonalny (repo bez niego też przechodzi testy)
    if (existsSync(overridesFileOf('acme'))) expect(loadOfferOverrides('acme', testKnownAccounts(), '').length).toBeGreaterThan(0)
    else expect(loadOfferOverrides('acme', testKnownAccounts(), '')).toEqual([])
    expect(loadOfferOverrides('firma_bez_pliku', testKnownAccounts(), '')).toEqual([])
    expect(() => loadOfferOverrides('acme', testKnownAccounts(), 'C:/nie-ma/nadpisania.csv')).toThrow('brak pliku nadpisań')
  })
  it('7: nieznane konto kanału w CSV = błąd wiersza', () => {
    expect(() => parseOfferOverrides('n\nALLEGRO;99999;1;A;\n', testKnownAccounts())).toThrow('nieznane konto')
    expect(() => parseOfferOverrides('n\nWOO_SD;71045;1;A;\n', testKnownAccounts())).toThrow('nieznane konto')
  })
  it('8: nazwa pozycji z katalogu BL, nie z (edytowalnej) linii zamówienia', () => {
    const blList = [bl({ id: '2', sku: 'B1', name: 'Przyprawa B z katalogu' })]
    const r = classifyFromSales(aggregateSales([sale({ productId: '2', auctionId: 'a1', name: 'tekst wpisany w BL' })], blList), ['ALLEGRO'])
    expect(r[0]!.name).toBe('Przyprawa B z katalogu')
  })
})
