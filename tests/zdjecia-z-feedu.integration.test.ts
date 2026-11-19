// zdjęcia produktów z feedu produktowego (Google Merchant XML). Dane wyłącznie zmyślone: feed z pliku
// tests/feed/google-merchant-rss.xml (adresy sklep.example.test), produkty testowe, bez sieci (pobranie podstawione).
//  1. przebieg: parowanie SKU / id jako SKU / EAN / oferta wariantu, zlecenie tylko produktom bez zdjęcia
//     (`tylkoGdyBrak`), wynik w ImportRun, lista bez dopasowania; powtórka nie dubluje; obca firma nietknięta;
//  2. feed z błędem (sieć, HTML zamiast XML) nie wywraca przebiegu: FAILED z komunikatem, drugi feed i tak działa;
//  3. limit 200 zleceń na przebieg wspólny z ofertami;
//  4. firma bez feedu: brak zadania w harmonogramie i brak przebiegu; zadanie nocne tylko w oknie 2–6 raz na dobę;
//  5. zapis adresów z panelu (AuditLog), preset nie nadpisuje adresów z panelu.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyOrgPreset } from '@/lib/organizacje'
import { ZDJECIA_LIMIT_NA_PRZEBIEG, ZDJECIA_Z_OFERTY_JOB } from '@/lib/produkty/zdjecia'
import { FEED_JOB, FEED_RUN_KIND, feedNalezny, feedyFirmy, odchudzStarePrzebiegi, ostatniPrzebiegFeedu, przebiegFeedow, zapiszFeedy } from '@/lib/produkty/zdjecia-feed'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { HARMONOGRAM_RDZENIA } from '@/lib/worker/harmonogram'
import { OrgClients, planSchedule, type WorkerDeps } from '@/lib/worker/petla'
import { handlers } from '@/lib/worker/zadania'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testDbUrl } from './global-setup'
import { offer, product, seedBase, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
const FEED = readFileSync(path.join(__dirname, 'feed', 'google-merchant-rss.xml'))
const ADRES = 'https://sklep.example.test/wp-content/uploads/feed/abc.xml'

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
  await sys.$disconnect()
})

const zlecenia = async (db: typeof a) =>
  (await db.job.findMany({ where: { kind: ZDJECIA_Z_OFERTY_JOB }, select: { payload: true }, orderBy: { runAfter: 'asc' } })).map((j) => j.payload as { productId: string; urls: string[]; tylkoGdyBrak?: boolean })

const zdjecie = (db: typeof a, productId: string) => db.productImage.create({ data: { productId, position: 0, width: 10, height: 10, bytes: 100, actorId: 'test' } })

async function katalogTestowy() {
  const p1 = await product(a, 'T-0001', 3) // g:mpn
  const p2 = await product(a, 'KUBEK', 3) // g:gtin
  await a.product.update({ where: { id: p2 }, data: { ean: '5901234123457' } })
  const p3 = await product(a, 'PUSZKA-CZ', 3) // oferta wariantu 610/611
  await offer(a, 'WOO_SD', '610/611', p3)
  const p4 = await product(a, 'T-0004', 3) // g:id jako SKU, ale ma już zdjęcie
  await zdjecie(a, p4)
  return { p1, p2, p3, p4 }
}

describe('zdjęcia z feedu produktowego', () => {
  it('przebieg: paruje, zleca tylko brakujące, zapisuje wynik i listę bez dopasowania; powtórka nie dubluje', async () => {
    const { p1, p2, p3, p4 } = await katalogTestowy()
    await zapiszFeedy(a, [{ url: ADRES, konto: 'WOO:sd' }], 'test')
    // obca firma ma ten sam SKU i ten sam feed: jej produktów nie dotykamy
    const obcy = await product(b, 'T-0001', 1)
    const pobrane: string[] = []
    const w = await przebiegFeedow(a, { zrodlo: 'panel', now: T0, pobierz: async (u) => (pobrane.push(u), FEED) })
    expect(pobrane).toEqual([ADRES])
    expect(w).toMatchObject({ doPobrania: 3, zlecone: 3, wKolejce: 0, pominiete: 0, bledy: 0 })
    expect(w!.feedy).toEqual([
      {
        adres: 'sklep.example.test/…/abc.xml',
        pozycje: 5,
        sparowane: 4,
        maZdjecie: 1,
        bezZdjeciaWFeedzie: 0,
        bezDopasowania: 1,
        niejednoznaczne: 0,
        wedlugReguly: { sku: 1, 'id-jako-sku': 1, ean: 1, oferta: 1 },
      },
    ])
    const z = await zlecenia(a)
    expect(z.map((x) => x.productId)).toEqual([p1, p2, p3])
    expect(z.every((x) => x.tylkoGdyBrak === true)).toBe(true)
    expect(z[0]!.urls).toEqual(['https://sklep.example.test/zdjecia/501.webp', 'https://sklep.example.test/zdjecia/501-b.webp', 'https://sklep.example.test/zdjecia/501-c.webp'])
    expect(z.some((x) => x.productId === p4)).toBe(false)
    expect(await b.job.count({ where: { kind: ZDJECIA_Z_OFERTY_JOB } })).toBe(0)
    expect(obcy).toBeTruthy()

    const ost = await ostatniPrzebiegFeedu(a)
    expect(ost).toMatchObject({ status: 'OK', error: null })
    expect(ost!.wynik!.lista).toEqual([{ feed: 1, id: '700', mpn: 'X-999', gtin: '', tytul: 'Pozycja bez dopasowania & bez zdjęcia', powod: 'brak' }])
    expect(await ostatniPrzebiegFeedu(b)).toBeNull()

    // powtórka: zlecenia czekają, nic nie dochodzi
    const w2 = await przebiegFeedow(a, { zrodlo: 'panel', now: T0, pobierz: async () => FEED })
    expect(w2).toMatchObject({ zlecone: 0, wKolejce: 3 })
    expect(await a.job.count({ where: { kind: ZDJECIA_Z_OFERTY_JOB } })).toBe(3)
  })

  it('bez sklepu przy feedzie reguła oferty nie działa (wariant bez SKU z feedu zostaje bez dopasowania)', async () => {
    await katalogTestowy()
    await zapiszFeedy(a, [{ url: ADRES }], 'test')
    const w = await przebiegFeedow(a, { zrodlo: 'panel', now: T0, pobierz: async () => FEED })
    expect(w!.feedy[0]).toMatchObject({ sparowane: 3, bezDopasowania: 2 })
  })

  it('feed z błędem nie wywraca przebiegu: FAILED z komunikatem; przy dwóch feedach drugi działa (PARTIAL)', async () => {
    await katalogTestowy()
    await zapiszFeedy(a, [{ url: ADRES }], 'test')
    const w = await przebiegFeedow(a, { zrodlo: 'noc', now: T0, pobierz: async () => Buffer.from('<!doctype html><html><body>Strona sklepu</body></html>') })
    expect(w!.feedy[0]!.blad).toMatch(/To nie jest feed produktowy/)
    expect(w!.zlecone).toBe(0)
    const ost = await ostatniPrzebiegFeedu(a)
    expect(ost).toMatchObject({ status: 'FAILED' })
    expect(ost!.error).toMatch(/To nie jest feed produktowy/)

    const DRUGI = 'https://drugi.example.test/feed.xml'
    await zapiszFeedy(a, [{ url: ADRES }, { url: DRUGI }], 'test')
    const w2 = await przebiegFeedow(a, {
      zrodlo: 'noc',
      now: T0,
      pobierz: async (u) => {
        if (u === ADRES) throw Object.assign(new Error('getaddrinfo ENOTFOUND sklep.example.test'), { code: 'ENOTFOUND' })
        return FEED
      },
    })
    expect(w2!.feedy.map((f) => f.blad ?? 'ok')).toEqual(['Nie ma takiego serwera (sprawdź adres feedu).', 'ok'])
    expect(w2!.zlecone).toBe(2) // T-0001 i KUBEK (bez sklepu przy feedzie wariant nie paruje się ofertą)
    expect((await ostatniPrzebiegFeedu(a))!.status).toBe('PARTIAL')
  })

  it(`najwyżej ${ZDJECIA_LIMIT_NA_PRZEBIEG} zleceń na przebieg, reszta w następnym`, async () => {
    const N = ZDJECIA_LIMIT_NA_PRZEBIEG + 20
    const items: string[] = []
    for (let i = 0; i < N; i++) {
      await product(a, `F-${i}`, 1)
      items.push(`<item><g:id>${i}</g:id><g:mpn>F-${i}</g:mpn><g:image_link>https://sklep.example.test/f/${i}.jpg</g:image_link></item>`)
    }
    const xml = Buffer.from(`<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>${items.join('')}</channel></rss>`)
    await zapiszFeedy(a, [{ url: ADRES }], 'test')
    const w1 = await przebiegFeedow(a, { zrodlo: 'panel', now: new Date(), pobierz: async () => xml })
    expect(w1).toMatchObject({ doPobrania: N, zlecone: ZDJECIA_LIMIT_NA_PRZEBIEG, pominiete: 20 })
    const w2 = await przebiegFeedow(a, { zrodlo: 'panel', now: new Date(), pobierz: async () => xml })
    expect(w2).toMatchObject({ zlecone: 20, wKolejce: ZDJECIA_LIMIT_NA_PRZEBIEG, pominiete: 0 })
  }, 120_000)

  it('firma bez feedu: przebieg nic nie robi, harmonogram nie planuje zadania; z feedem planuje', async () => {
    expect(await przebiegFeedow(a, { zrodlo: 'panel', pobierz: async () => FEED })).toBeNull()
    expect(await a.importRun.count({ where: { kind: FEED_RUN_KIND } })).toBe(0)
    const orgs = new OrgClients({ connectionString: testDbUrl() })
    try {
      const deps: WorkerDeps = { system: sys, orgs, handlers, env: {}, workerId: 'test' }
      const lista = [
        { id: ORG_A, slug: 'test-a', name: 'A' },
        { id: ORG_B, slug: 'test-b', name: 'B' },
      ]
      await zapiszFeedy(a, [{ url: ADRES }], 'test')
      const wpis = HARMONOGRAM_RDZENIA.filter((h) => h.kind === FEED_JOB)
      expect(wpis).toEqual([{ kind: FEED_JOB, everyMs: 3600_000, requires: 'feed' }])
      const plan = await planSchedule(deps, lista, wpis, new Map(), Date.now())
      expect(plan.errors).toEqual([])
      expect(await sys.job.count({ where: { organizationId: ORG_A, kind: FEED_JOB } })).toBe(1)
      expect(await sys.job.count({ where: { organizationId: ORG_B, kind: FEED_JOB } })).toBe(0)
    } finally {
      await orgs.closeAll()
    }
  })

  it('automat nocny: tylko 2:00–6:00 czasu Warszawy i raz na dobę; zadanie poza oknem kończy się bez przebiegu', async () => {
    const dzien = '2026-11-10'
    expect(await feedNalezny(a, fromWarsaw(dzien, 1.5 * 3600_000))).toBe(false)
    expect(await feedNalezny(a, fromWarsaw(dzien, 2 * 3600_000))).toBe(true)
    expect(await feedNalezny(a, fromWarsaw(dzien, 6 * 3600_000))).toBe(false)
    await a.importRun.create({ data: { kind: FEED_RUN_KIND, status: 'OK', startedAt: fromWarsaw(dzien, 0.5 * 3600_000), finishedAt: fromWarsaw(dzien, 0.5 * 3600_000) } })
    expect(await feedNalezny(a, fromWarsaw(dzien, 3 * 3600_000))).toBe(false)
    expect(await feedNalezny(a, fromWarsaw('2026-11-11', 3 * 3600_000))).toBe(true)
    // handler bez `wymus` w dzień (test działa o dowolnej porze: firma bez feedu i tak kończy bez przebiegu)
    await handlers[FEED_JOB]!(a, null, { organizationId: ORG_A } as never)
    expect(await a.importRun.count({ where: { kind: FEED_RUN_KIND } })).toBe(1)
  })

  it('zapis adresów: AuditLog przy zmianie; preset nie nadpisuje adresów firmy, uzupełnia brak', async () => {
    await zapiszFeedy(a, [{ url: ADRES, konto: 'WOO:sd' }], 'u-test')
    await zapiszFeedy(a, [{ url: ADRES, konto: 'WOO:sd' }], 'u-test') // bez zmiany: bez drugiego wpisu
    expect(await a.auditLog.count({ where: { entity: 'Organization.feedyProduktowe' } })).toBe(1)
    const org = await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })
    await applyOrgPreset(sys, { id: ORG_A, slug: org.slug, name: org.name, settings: { feedyProduktowe: { adresy: [{ url: 'https://inny.example.test/p.xml' }] } } })
    expect(await feedyFirmy(a)).toEqual([{ url: ADRES, konto: 'WOO:sd' }])
    const orgB = await sys.organization.findUniqueOrThrow({ where: { id: ORG_B } })
    await applyOrgPreset(sys, { id: ORG_B, slug: orgB.slug, name: orgB.name, settings: { feedyProduktowe: { adresy: [{ url: 'https://inny.example.test/p.xml' }] } } })
    expect(await feedyFirmy(b)).toEqual([{ url: 'https://inny.example.test/p.xml' }])
    await expect(applyOrgPreset(sys, { id: ORG_B, slug: orgB.slug, name: orgB.name, settings: { feedyProduktowe: { adresy: [{ url: 'http://zly.example.test/p.xml' }] } } })).rejects.toThrow(/adres feedu/)
  })

  it('przebiegi starsze niż 14 dni tracą listę bez dopasowania, liczniki i wiersz zostają; obca firma nietknięta', async () => {
    const now = new Date('2026-11-20T03:00:00Z')
    const stats = { zrodlo: 'noc', feedy: [{ adres: 'x', pozycje: 3 }], lista: [{ feed: 1, id: '1', mpn: '', gtin: '', tytul: 'A', powod: 'brak' }] }
    const stary = await a.importRun.create({ data: { kind: FEED_RUN_KIND, status: 'OK', startedAt: new Date('2026-11-01T03:00:00Z'), stats } })
    const swiezy = await a.importRun.create({ data: { kind: FEED_RUN_KIND, status: 'OK', startedAt: new Date('2026-11-10T03:00:00Z'), stats } })
    const innyRodzaj = await a.importRun.create({ data: { kind: 'inny-import', status: 'OK', startedAt: new Date('2026-11-01T03:00:00Z'), stats } })
    const obcy = await b.importRun.create({ data: { kind: FEED_RUN_KIND, status: 'OK', startedAt: new Date('2026-11-01T03:00:00Z'), stats } })
    expect(await odchudzStarePrzebiegi(a, now)).toBe(1)
    expect(await odchudzStarePrzebiegi(a, now)).toBe(0) // idempotentne
    const s = async (db: typeof a, id: string) => (await db.importRun.findUniqueOrThrow({ where: { id } })).stats as Record<string, unknown>
    expect(await s(a, stary.id)).toEqual({ zrodlo: 'noc', feedy: [{ adres: 'x', pozycje: 3 }] })
    expect((await s(a, swiezy.id))['lista']).toHaveLength(1)
    expect((await s(a, innyRodzaj.id))['lista']).toHaveLength(1)
    expect((await s(b, obcy.id))['lista']).toHaveLength(1)
  })
})
