// „Dodaj produkt” + SKU z wFirmy, rodzaj bez stanu, lista noStock edytowana w panelu.
// Atrapa wFirmy zamiast sieci, dane wyłącznie fikcyjne (zmyślone towary, SKU i identyfikatory).
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { NonRetryableError } from '@/lib/bledy'
import { analyze } from '@/lib/import/katalog'
import { persistImport } from '@/lib/import/zapis'
import { applyOrgPreset, loadImportConfig } from '@/lib/organizacje'
import { addProduct, INITIAL_REASON, NO_SERVICE_NOTE, requestCheck, skuState } from '@/lib/produkty/dodawanie'
import { NoStockConflict, readNoStock, saveNoStock } from '@/lib/produkty/bez-stanu'
import { LIMIT_MESSAGE, lookupWfirmaGood, NOT_FOUND_MESSAGE, WFIRMA_GOOD_JOB, zadanieOdczytuTowaru } from '@/lib/produkty/wfirma-towar'
import { handlers } from '@/lib/worker/zadania'
import { SourceError } from '@/lib/zrodla/http'
import { ACME_PRESET } from '@/tests/preset-testowy'
import { ORG_A, ORG_B, seedImportConfig, TEST_ORGS, testDb, testSystemDb, truncateAll } from './db'
import { shop, smallRaw } from './fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const WH = '900014' // magazyn wFirmy firmy testowej (preset jak ACME)
const USER = 'uzytkownik-testowy-1'

type ApiGood = Record<string, unknown>
const apiGood = (id: string, code: string, over: ApiGood = {}): ApiGood => ({
  id,
  code,
  name: `Towar testowy ${id}`,
  type: 'good',
  unit: 'szt.',
  count: '12',
  value: '60',
  ean: '5901234123457',
  vat_code: { id: '222' },
  warehouse: { id: WH },
  good_prices: { 0: { good_price: { name: 'detaliczna', netto: '20.00', brutto: '24.60' } } },
  ...over,
})

/** Atrapa WfirmaReadOnly: tylko find, goods/find po warunku code eq; `limit` = odmowa jak przy blokadzie klucza. */
function fakeWfirma(goods: ApiGood[], opts: { limit?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    async call<T>(path: string, body: unknown = {}): Promise<T> {
      calls.push(path)
      if (!/\/find$/.test(path)) throw new Error(`atrapa: zapis ${path} zabroniony`)
      if (opts.limit) throw new SourceError(`wFirma ${path}: AUTH FAILED LIMIT WAIT 5 MINUTES — limit, bez ponawiania`, false)
      if (path === 'vat_codes/find') return { vat_codes: { 0: { vat_code: { id: '222', code: '23' } } } } as T
      const code = (body as { api: { goods: { parameters: { conditions: { condition: { value: string } } } } } }).api.goods.parameters.conditions.condition.value
      const hit = goods.filter((g) => g['code'] === code)
      return { goods: { ...Object.fromEntries(hit.map((g, i) => [String(i), { good: g }])), parameters: { total: hit.length } } } as T
    },
  }
}

/** Kopia towaru wFirmy jak z importu katalogu (wiersz WfirmaGood). */
async function copy(db: PrismaClient, id: string, code: string, over: { type?: string; count?: string; name?: string } = {}) {
  const run = await db.importRun.create({ data: { kind: 'katalog-bl-wfirma', status: 'OK' } })
  await db.wfirmaGood.create({
    data: {
      id,
      code,
      name: over.name ?? `Towar testowy ${id}`,
      type: over.type ?? 'good',
      unit: 'szt.',
      vatCodeId: '222',
      vatRate: '23',
      priceNetRetail: '20.00',
      priceGrossRetail: '24.60',
      purchasePriceNet: '5.0000',
      count: over.count ?? '7',
      warehouseId: WH,
      ean: null,
      importRunId: run.id,
    },
  })
}

beforeEach(async () => {
  await truncateAll()
  await seedImportConfig() // magazyn „glowny” ↔ wFirma 900014, settings.catalog.noStock.skus = ['ebook1']
})

describe('SKU z kopii towarów wFirmy', () => {
  it('kopia z importu → produkt ze stanem startowym, ruch INITIAL_IMPORT od osoby; bez zadania dla wFirmy', async () => {
    await copy(a, '700', 'HERB-NOWA', { count: '7' })
    const st = await skuState(a, 'HERB-NOWA')
    expect(st).toMatchObject({ stan: 'kopia', kind: 'STOCKED' })
    expect(await requestCheck(a, 'HERB-NOWA')).toBe('gotowe')
    expect(await a.job.count()).toBe(0)

    const r = await addProduct(a, { sku: ' HERB-NOWA ', rodzaj: 'wfirma' }, USER)
    expect(r).toMatchObject({ ok: true, created: true, kind: 'STOCKED' })
    if (!r.ok) return
    const p = await a.product.findUniqueOrThrow({ where: { id: r.productId }, include: { stocks: true, movements: true } })
    expect(p).toMatchObject({ sku: 'HERB-NOWA', kind: 'STOCKED', wfirmaGoodId: '700', nameAccounting: 'Towar testowy 700', title: 'Towar testowy 700', vatRate: '23' })
    expect(p.priceNet?.toString()).toBe('20')
    expect(p.purchasePriceNet?.toString()).toBe('5')
    expect(p.stocks).toHaveLength(1)
    expect(p.stocks[0]).toMatchObject({ warehouseId: 'glowny', physical: 7, wfirmaCount: 7, reserved: 0 })
    expect(p.movements).toHaveLength(1)
    expect(p.movements[0]).toMatchObject({ source: 'INITIAL_IMPORT', deltaPhysical: 7, reason: INITIAL_REASON, actorId: `user:${USER}` })
    expect(await a.auditLog.count({ where: { entity: 'Product', entityId: p.id, actorId: USER } })).toBe(1)
    // produkt ze stanem nie trafia na listę bez stanu
    expect((await readNoStock(a)).skus).toEqual(['ebook1'])
    expect(await skuState(a, 'HERB-NOWA')).toMatchObject({ stan: 'istnieje', productId: p.id })
  })

  it('nazwa i EAN z formularza wygrywają z wFirmą; zły EAN i za długa nazwa odrzucone', async () => {
    await copy(a, '701', 'HERB-2')
    expect(await addProduct(a, { sku: 'HERB-2', rodzaj: 'wfirma', ean: '123' }, USER)).toMatchObject({ ok: false, field: 'ean' })
    expect(await addProduct(a, { sku: 'HERB-2', rodzaj: 'wfirma', title: 'x'.repeat(201) }, USER)).toMatchObject({ ok: false, field: 'title' })
    expect(await addProduct(a, { sku: 'x'.repeat(65), rodzaj: 'wfirma' }, USER)).toMatchObject({ ok: false, field: 'sku' })
    const r = await addProduct(a, { sku: 'HERB-2', rodzaj: 'wfirma', title: 'Przyprawa testowa', ean: '5901234123457' }, USER)
    expect(r.ok).toBe(true)
    expect(await a.product.findFirstOrThrow({ where: { sku: 'HERB-2' } })).toMatchObject({ title: 'Przyprawa testowa', ean: '5901234123457', nameAccounting: 'Towar testowy 701' })
  })
})

describe('SKU spoza kopii: odczyt w workerze (atrapa wFirmy)', () => {
  it('„Sprawdź” zleca jedno zadanie (dedupe, maxAttempts 1); odczyt zapisuje kopię z własnym ImportRun', async () => {
    expect(await skuState(a, 'NOWY-1')).toEqual({ stan: 'niesprawdzone' })
    expect(await requestCheck(a, 'NOWY-1')).toBe('zlecone')
    expect(await requestCheck(a, 'NOWY-1')).toBe('gotowe') // już czeka
    const jobs = await a.job.findMany({ where: { kind: WFIRMA_GOOD_JOB } })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ payload: { sku: 'NOWY-1' }, maxAttempts: 1, status: 'PENDING' })
    expect(await skuState(a, 'NOWY-1')).toEqual({ stan: 'sprawdzam' })
    // worker nie odebrał zadania w minutę → ekran przestaje czekać
    expect(await skuState(a, 'NOWY-1', new Date(Date.now() + 2 * 60_000))).toEqual({ stan: 'sprawdzam', zawieszone: true })
    expect(handlers[WFIRMA_GOOD_JOB]).toBe(zadanieOdczytuTowaru)

    const wf = fakeWfirma([apiGood('800', 'NOWY-1'), apiGood('801', 'INNY')])
    expect(await lookupWfirmaGood(a, { wf, warehouseId: WH }, 'NOWY-1')).toMatchObject({ wynik: 'znaleziono', towarId: '800', typ: 'good' })
    expect(wf.calls).toEqual(['vat_codes/find', 'goods/find'])
    await a.job.updateMany({ data: { status: 'DONE', dedupeKey: null } })
    const g = await a.wfirmaGood.findFirstOrThrow({ where: { id: '800' } })
    const run = await a.importRun.findUniqueOrThrow({ where: { id: g.importRunId } })
    expect(run).toMatchObject({ kind: 'wfirma-towar', status: 'OK', stats: { wynik: 'znaleziono', sku: 'NOWY-1', towarId: '800', typ: 'good' } })
    expect(await skuState(a, 'NOWY-1')).toMatchObject({ stan: 'kopia', kind: 'STOCKED' })

    const r = await addProduct(a, { sku: 'NOWY-1', rodzaj: 'wfirma' }, USER)
    expect(r).toMatchObject({ ok: true, created: true })
    expect(await a.stock.findFirstOrThrow({ where: { product: { sku: 'NOWY-1' } } })).toMatchObject({ physical: 12 })
    expect(await a.product.findFirstOrThrow({ where: { sku: 'NOWY-1' } })).toMatchObject({ ean: '5901234123457', wfirmaGoodId: '800' })
  })

  it('zero trafień = „Nie ma takiego SKU w wFirmie”, bez kopii; dodanie jako towar odmówione', async () => {
    await requestCheck(a, 'BRAK-1')
    expect(await lookupWfirmaGood(a, { wf: fakeWfirma([apiGood('802', 'INNY')]), warehouseId: WH }, 'BRAK-1')).toEqual({ wynik: 'brak', sku: 'BRAK-1' })
    await a.job.updateMany({ data: { status: 'DONE', dedupeKey: null } })
    const st = await skuState(a, 'BRAK-1')
    expect(st).toMatchObject({ stan: 'brak' })
    expect(st.stan === 'brak' && st.komunikat).toContain(NOT_FOUND_MESSAGE)
    expect(await a.wfirmaGood.count()).toBe(0)
    expect(await addProduct(a, { sku: 'BRAK-1', rodzaj: 'wfirma' }, USER)).toMatchObject({ ok: false, field: 'sku' })
    // ponowne „Sprawdź” po werdykcie zleca nowy odczyt
    expect(await requestCheck(a, 'BRAK-1')).toBe('zlecone')
  })

  it('towar o tym kodzie w innym magazynie wFirmy = brak z wyjaśnieniem', async () => {
    await lookupWfirmaGood(a, { wf: fakeWfirma([apiGood('803', 'OBCY-1', { warehouse: { id: '999' } })]), warehouseId: WH }, 'OBCY-1')
    const st = await skuState(a, 'OBCY-1')
    expect(st.stan === 'brak' && st.komunikat).toContain('innym magazynie')
    expect(await a.wfirmaGood.count()).toBe(0)
  })

  it('kilka trafień = odmowa z listą towarów, bez kopii; kilka kopii z importu też blokuje dodanie', async () => {
    const res = await lookupWfirmaGood(a, { wf: fakeWfirma([apiGood('804', 'DUBEL'), apiGood('805', 'DUBEL')]), warehouseId: WH }, 'DUBEL')
    expect(res).toMatchObject({ wynik: 'kilka', towary: [{ id: '804' }, { id: '805' }] })
    expect(await a.wfirmaGood.count()).toBe(0)
    expect(await skuState(a, 'DUBEL')).toMatchObject({ stan: 'kilka' })
    // „Dodaj” po werdykcie „kilka” mówi o kilku towarach, nie „nie ma SKU”
    const r0 = await addProduct(a, { sku: 'DUBEL', rodzaj: 'wfirma' }, USER)
    expect(!r0.ok && r0.error).toMatch(/kilka towarów.*804.*805/)

    await copy(a, '806', 'DUBEL-2')
    await copy(a, '807', 'DUBEL-2')
    expect(await skuState(a, 'DUBEL-2')).toMatchObject({ stan: 'kilka' })
    const r = await addProduct(a, { sku: 'DUBEL-2', rodzaj: 'wfirma' }, USER)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/kilka towarów.*806.*807/)
    expect(await a.product.count({ where: { sku: 'DUBEL-2' } })).toBe(0)
  })

  it('limit wFirmy: błąd bez ponawiania, komunikat „chwilowo odmawia”, kolejne „Sprawdź” wstrzymane', async () => {
    const wf = fakeWfirma([], { limit: true })
    await expect(lookupWfirmaGood(a, { wf, warehouseId: WH }, 'LIM-1')).rejects.toBeInstanceOf(NonRetryableError)
    expect(wf.calls).toEqual(['vat_codes/find']) // jedna próba, bez pętli
    expect(await skuState(a, 'LIM-1')).toEqual({ stan: 'odmowa', komunikat: LIMIT_MESSAGE })
    expect(await requestCheck(a, 'LIM-1')).toBe('pauza')
    expect(await a.job.count()).toBe(0)
    // limit z odczytu towaru wstrzymuje też kolejkę wFirmy (lustro stanów, faktury)
    const st = await a.wfirmaQueueState.findFirst()
    expect(st?.pausedUntil && st.pausedUntil.getTime() - Date.now()).toBeGreaterThan(4 * 60_000)
  })

  it('pauza kolejki wFirmy z lustra: „Sprawdź” wstrzymane, worker nie woła wFirmy', async () => {
    const until = new Date(Date.now() + 5 * 60_000)
    await a.wfirmaQueueState.upsert({ where: { organizationId: ORG_A }, create: { organizationId: ORG_A, pausedUntil: until }, update: { pausedUntil: until } })
    expect(await requestCheck(a, 'PAUZA-1')).toBe('pauza')
    expect(await a.job.count()).toBe(0)
    const wf = fakeWfirma([apiGood('810', 'PAUZA-1')])
    await expect(lookupWfirmaGood(a, { wf, warehouseId: WH }, 'PAUZA-1')).rejects.toBeInstanceOf(NonRetryableError)
    expect(wf.calls).toEqual([])
    expect(await skuState(a, 'PAUZA-1')).toEqual({ stan: 'odmowa', komunikat: LIMIT_MESSAGE })
    // pauza firmy A nie dotyczy firmy B
    expect(await requestCheck(b, 'PAUZA-1')).toBe('zlecone')
    // po pauzie odczyt wraca
    await a.wfirmaQueueState.update({ where: { organizationId: ORG_A }, data: { pausedUntil: new Date(Date.now() - 1000) } })
    expect(await lookupWfirmaGood(a, { wf, warehouseId: WH }, 'PAUZA-1')).toMatchObject({ wynik: 'znaleziono', towarId: '810' })
  })

  it('handler bez kluczy i konfiguracji źródeł: werdykt dla ekranu i błąd bez ponawiania (bez sieci)', async () => {
    await expect(zadanieOdczytuTowaru(a, { sku: 'K-1' }, { secrets: { env: {}, envFallback: false } })).rejects.toBeInstanceOf(NonRetryableError)
    expect(await skuState(a, 'K-1')).toMatchObject({ stan: 'odmowa' })
    await expect(zadanieOdczytuTowaru(a, { sku: '' }, { secrets: { env: {}, envFallback: false } })).rejects.toBeInstanceOf(NonRetryableError)
  })
})

describe('rodzaj z typu wFirmy: good, set, service', () => {
  it('set = ze stanem; service = bez stanu z usługą wFirmy: bez Stock, SKU na liście noStock', async () => {
    await copy(a, '710', 'KOMPLET-1', { type: 'set', count: '3' })
    await copy(a, '711', 'USLUGA-1', { type: 'service', count: '0', name: 'Konsultacja testowa' })
    expect(await skuState(a, 'USLUGA-1')).toMatchObject({ stan: 'kopia', kind: 'DIGITAL' })

    expect(await addProduct(a, { sku: 'KOMPLET-1', rodzaj: 'wfirma' }, USER)).toMatchObject({ ok: true, kind: 'STOCKED' })
    expect(await a.stock.count({ where: { product: { sku: 'KOMPLET-1' } } })).toBe(1)

    const r = await addProduct(a, { sku: 'USLUGA-1', rodzaj: 'bez-stanu' }, USER)
    expect(r).toMatchObject({ ok: true, created: true, kind: 'DIGITAL', warnings: [] })
    const p = await a.product.findFirstOrThrow({ where: { sku: 'USLUGA-1' }, include: { stocks: true, movements: true } })
    expect(p).toMatchObject({ kind: 'DIGITAL', wfirmaGoodId: '711', wfirmaType: 'service', nameAccounting: 'Konsultacja testowa' })
    expect(p.stocks).toEqual([])
    expect(p.movements).toEqual([])
    expect((await readNoStock(a)).skus).toEqual(['ebook1', 'USLUGA-1'])
    const audit = await a.auditLog.findFirstOrThrow({ where: { entity: 'Organization.catalog.noStock' } })
    expect(audit).toMatchObject({ actorId: USER, before: { skus: ['ebook1'] }, after: { skus: ['ebook1', 'USLUGA-1'] } })
  })

  it('usługa wybrana jako „towar z wFirmy” też jest bez stanu (rodzaj z wFirmy, nie z wyboru)', async () => {
    await copy(a, '712', 'USLUGA-2', { type: 'service' })
    expect(await addProduct(a, { sku: 'USLUGA-2', rodzaj: 'wfirma' }, USER)).toMatchObject({ ok: true, kind: 'DIGITAL' })
    expect(await a.stock.count()).toBe(0)
  })

  it('bez stanu bez usługi w wFirmie: nazwa wymagana, ostrzeżenie o fakturze z pozycji, wf null, SKU na liście', async () => {
    expect(await addProduct(a, { sku: 'EBOOK-NOWY', rodzaj: 'bez-stanu' }, USER)).toMatchObject({ ok: false, field: 'title' })
    const r = await addProduct(a, { sku: 'EBOOK-NOWY', rodzaj: 'bez-stanu', title: 'Poradnik testowy (e-book)' }, USER)
    expect(r).toMatchObject({ ok: true, created: true, kind: 'DIGITAL', warnings: [NO_SERVICE_NOTE] })
    const p = await a.product.findFirstOrThrow({ where: { sku: 'EBOOK-NOWY' }, include: { stocks: true } })
    expect(p).toMatchObject({ kind: 'DIGITAL', wfirmaGoodId: null, nameAccounting: 'Poradnik testowy (e-book)', title: 'Poradnik testowy (e-book)', unit: 'SZT' })
    expect(p.stocks).toEqual([])
    expect((await readNoStock(a)).skus).toContain('EBOOK-NOWY')
  })

  it('konflikt rodzaju: SKU jest w wFirmie towarem ze stanem → „bez stanu” odmówione, nic nie zapisane', async () => {
    await copy(a, '713', 'TOWAR-1')
    const r = await addProduct(a, { sku: 'TOWAR-1', rodzaj: 'bez-stanu', title: 'Udawany e-book' }, USER)
    expect(r).toMatchObject({ ok: false, field: 'sku' })
    expect(!r.ok && r.error).toContain('towarem ze stanem')
    expect(await a.product.count()).toBe(0)
    expect((await readNoStock(a)).skus).toEqual(['ebook1'])
  })
})

describe('dubel i wyścig', () => {
  it('drugie zapisanie tego samego SKU = istniejący produkt, bez drugiego stanu i ruchu', async () => {
    await copy(a, '720', 'DWA-RAZY')
    const r1 = await addProduct(a, { sku: 'DWA-RAZY', rodzaj: 'wfirma' }, USER)
    const r2 = await addProduct(a, { sku: 'DWA-RAZY', rodzaj: 'wfirma' }, USER)
    expect(r1).toMatchObject({ ok: true, created: true })
    expect(r2).toMatchObject({ ok: true, created: false })
    expect(r1.ok && r2.ok && r1.productId === r2.productId).toBe(true)
    // istniejące SKU jako bez stanu też prowadzi do karty, rodzaj bez zmian
    expect(await addProduct(a, { sku: 'DWA-RAZY', rodzaj: 'bez-stanu', title: 'x' }, USER)).toMatchObject({ ok: true, created: false, kind: 'STOCKED' })
    expect(await a.product.count()).toBe(1)
    expect(await a.stock.count()).toBe(1)
    expect(await a.stockMovement.count()).toBe(1)
  })

  it('dwa kliknięcia naraz (osobne połączenia): jeden produkt, jeden stan, jeden ruch, oba wyniki z tym samym id', async () => {
    await copy(a, '721', 'WYSCIG')
    const a2 = testDb()
    try {
      const rs = await Promise.all([addProduct(a, { sku: 'WYSCIG', rodzaj: 'wfirma' }, USER), addProduct(a2, { sku: 'WYSCIG', rodzaj: 'wfirma' }, USER)])
      expect(rs.every((r) => r.ok)).toBe(true)
      expect(new Set(rs.map((r) => (r.ok ? r.productId : null))).size).toBe(1)
      expect(rs.filter((r) => r.ok && r.created).length).toBeGreaterThanOrEqual(1)
    } finally {
      await a2.$disconnect()
    }
    expect(await a.product.count()).toBe(1)
    expect(await a.stock.count()).toBe(1)
    expect(await a.stockMovement.count()).toBe(1)
  })

  it('wyścig bez stanu: jeden produkt, SKU raz na liście', async () => {
    const a2 = testDb()
    try {
      const input = { sku: 'EBOOK-W', rodzaj: 'bez-stanu', title: 'E-book testowy' }
      const rs = await Promise.all([addProduct(a, input, USER), addProduct(a2, input, USER)])
      expect(rs.every((r) => r.ok)).toBe(true)
    } finally {
      await a2.$disconnect()
    }
    expect(await a.product.count({ where: { sku: 'EBOOK-W' } })).toBe(1)
    expect((await readNoStock(a)).skus.filter((s) => s === 'EBOOK-W')).toHaveLength(1)
  })
})

describe('import katalogu po dodaniu w panelu', () => {
  it('towar: import znajduje produkt po wfirmaGoodId — bez dubla produktu, stanu i ruchu', async () => {
    // kopia towaru „A1” (id 100) jak w fixtures importu, stan 7
    await copy(a, '100', 'A1', { count: '7' })
    const r = await addProduct(a, { sku: 'A1', rodzaj: 'wfirma', title: 'Przyprawa z panelu' }, USER)
    expect(r).toMatchObject({ ok: true, created: true })
    if (!r.ok) return
    const raw = smallRaw()
    const s = await persistImport(a, raw, analyze(raw, [], (await loadImportConfig(a)).catalog))
    expect(s.status).toBe('OK')
    expect(await a.product.count({ where: { OR: [{ sku: 'A1' }, { wfirmaGoodId: '100' }] } })).toBe(1)
    const p = await a.product.findUniqueOrThrow({ where: { id: r.productId }, include: { stocks: true, movements: true } })
    expect(p.title).toBe('Przyprawa z panelu') // własny tytuł z panelu wygrywa z importem
    expect(p.stocks).toHaveLength(1)
    expect(p.movements).toHaveLength(1)
    expect(p.movements[0]!.reason).toBe(INITIAL_REASON)
    // drugi przebieg też nic nie dokłada
    await persistImport(a, smallRaw(), analyze(smallRaw(), [], (await loadImportConfig(a)).catalog))
    expect(await a.stock.count({ where: { productId: p.id } })).toBe(1)
    expect(await a.stockMovement.count({ where: { productId: p.id } })).toBe(1)
  })

  it('bez stanu: oferta z tym SKU łączy się przy imporcie z produktem z panelu (lista noStock), bez dubla i bez Stock', async () => {
    const r = await addProduct(a, { sku: 'EBOOK-P', rodzaj: 'bez-stanu', title: 'Poradnik z panelu' }, USER)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const raw = smallRaw()
    raw.shopOffers.push(shop({ productId: '9200', sku: 'EBOOK-P', name: 'Poradnik (e-book)' }))
    const s = await persistImport(a, raw, analyze(raw, [], (await loadImportConfig(a)).catalog))
    expect(s).toMatchObject({ status: 'OK', digitalProducts: 1 })
    expect(await a.product.count({ where: { sku: 'EBOOK-P' } })).toBe(1)
    expect(await a.channelOffer.findFirstOrThrow({ where: { externalId: '9200' } })).toMatchObject({ productId: r.productId, active: true, mappingSource: 'CONFIG' })
    expect(await a.stock.count({ where: { productId: r.productId } })).toBe(0)
    expect(await a.stockMovement.count({ where: { productId: r.productId } })).toBe(0)
    // nazwa z panelu (z niej faktura) zostaje, import nie nadpisuje jej nazwą oferty
    expect(await a.product.findUniqueOrThrow({ where: { id: r.productId } })).toMatchObject({ nameAccounting: 'Poradnik z panelu', title: 'Poradnik z panelu' })
  })
})

describe('lista noStock w panelu', () => {
  it('zapis zmienia tylko noStock: reszta ustawień zostaje; flaga edytowanoWPanelu i AuditLog', async () => {
    await saveNoStock(a, { skus: ['ebook1', 'ebook2'], shopCategories: ['7100001:117'] }, USER)
    const org = await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })
    const st = org.settings as Record<string, Record<string, unknown>>
    expect(st['baselinker']).toEqual({ inventoryId: '77701' })
    expect(st['faktury']).toEqual(ACME_PRESET.settings!.faktury)
    expect(st['catalog']!['nonOfferSkus']).toEqual(ACME_PRESET.settings!.catalog!.nonOfferSkus)
    expect(st['catalog']!['edytowanoWPanelu']).toBe(true)
    expect(await readNoStock(a)).toEqual({ skus: ['ebook1', 'ebook2'], shopCategories: ['7100001:117'], editedInPanel: true })
    expect((await loadImportConfig(a)).catalog).toMatchObject({ noStockSkus: ['ebook1', 'ebook2'], noStockShopCategories: ['7100001:117'] })
    expect(await a.auditLog.count({ where: { entity: 'Organization.catalog.noStock', actorId: USER } })).toBe(1)
    // zapis bez zmian nie dokłada wpisu
    await saveNoStock(a, { skus: ['ebook1', 'ebook2'], shopCategories: ['7100001:117'] }, USER)
    expect(await a.auditLog.count({ where: { entity: 'Organization.catalog.noStock' } })).toBe(1)
  })

  it('wyczyszczona lista zostaje pusta po applyOrgPreset; bez flagi preset ją uzupełnia (jak dotąd)', async () => {
    const org = TEST_ORGS.find((o) => o.id === ORG_A)!
    const preset = { ...ACME_PRESET, channels: ACME_PRESET.channels!.map((c) => ({ ...c, active: true })), id: org.id, slug: org.slug, name: org.name }
    await saveNoStock(a, { skus: [], shopCategories: [] }, USER)
    await applyOrgPreset(sys, preset)
    expect(await readNoStock(a)).toEqual({ skus: [], shopCategories: [], editedInPanel: true })

    // kontrola: firma B z pustą listą bez flagi dostaje listę z presetu
    const orgB = TEST_ORGS.find((o) => o.id === ORG_B)!
    await sys.organization.update({ where: { id: ORG_B }, data: { settings: { catalog: { noStock: { skus: [] } } } } })
    await applyOrgPreset(sys, { ...preset, id: orgB.id, slug: orgB.slug, name: orgB.name })
    expect((await readNoStock(b)).skus).toEqual(['ebook1'])
  })

  it('SKU produktu ze stanem albo zestawu na liście = odmowa z wyjaśnieniem; usunięcie z listy nie rusza produktu', async () => {
    await copy(a, '730', 'STAN-1')
    await addProduct(a, { sku: 'STAN-1', rodzaj: 'wfirma' }, USER)
    await expect(saveNoStock(a, { skus: ['ebook1', 'STAN-1'], shopCategories: [] }, USER)).rejects.toBeInstanceOf(NoStockConflict)
    await expect(saveNoStock(a, { skus: ['STAN-1'], shopCategories: [] }, USER)).rejects.toThrow(/produktem ze stanem/)
    expect((await readNoStock(a)).skus).toEqual(['ebook1'])

    await addProduct(a, { sku: 'EBOOK-X', rodzaj: 'bez-stanu', title: 'E-book X' }, USER)
    await saveNoStock(a, { skus: ['ebook1'], shopCategories: [] }, USER)
    expect(await a.product.findFirstOrThrow({ where: { sku: 'EBOOK-X' } })).toMatchObject({ kind: 'DIGITAL', active: true })
  })
})

describe('izolacja dwóch firm', () => {
  it('kopia towaru, produkt i lista noStock firmy A są niewidoczne dla firmy B', async () => {
    await seedImportConfig(ORG_B)
    await copy(a, '740', 'WSPOLNE-SKU')
    const r = await addProduct(a, { sku: 'WSPOLNE-SKU', rodzaj: 'wfirma' }, USER)
    expect(r.ok).toBe(true)
    await addProduct(a, { sku: 'EBOOK-A', rodzaj: 'bez-stanu', title: 'E-book firmy A' }, USER)

    expect(await skuState(b, 'WSPOLNE-SKU')).toEqual({ stan: 'niesprawdzone' })
    expect(await addProduct(b, { sku: 'WSPOLNE-SKU', rodzaj: 'wfirma' }, USER)).toMatchObject({ ok: false })
    expect(await b.product.count()).toBe(0)
    expect(await b.wfirmaGood.count()).toBe(0)
    expect((await readNoStock(b)).skus).not.toContain('EBOOK-A')
    // to samo SKU w firmie B to osobny produkt
    await copy(b, '740', 'WSPOLNE-SKU')
    expect(await addProduct(b, { sku: 'WSPOLNE-SKU', rodzaj: 'wfirma' }, USER)).toMatchObject({ ok: true, created: true })
    expect(await sys.product.count({ where: { sku: 'WSPOLNE-SKU' } })).toBe(2)
  })
})
