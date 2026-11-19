// dane testowe wyłącznie zmyślone (produkty, oferty, zamówienia).
//  1. zdjęcia istniejących produktów z ofert: produkt bez zdjęcia z powiązaną ofertą i adresem zdjęcia w ostatnim
//     odczycie ofert dostaje zlecenie `produkt-zdjecia-z-oferty`; produkt ze zdjęciem, oferta bez adresu, oferta
//     wyłączona, niedawno nieudane pobranie i obca firma bez zlecenia; „Pobierz oferty” (atrapa adaptera, tylko odczyt)
//     zleca to samo i zapisuje wynik w przebiegu; powtórka nie dubluje zlecenia; najwyżej 200 zleceń na przebieg, reszta
//     w następnym, zlecenia rozłożone w czasie (zadanie dodane po przebiegu jest pierwsze w kolejce); worker nie dokłada
//     zdjęć produktowi, który dostał zdjęcie po zleceniu;
//  2. „Po terminie” na koncie w trybie „Tylko podgląd”: liczy się tylko zamówienie, które BL ma jeszcze przed wysyłką
//     (kopia nagłówka BL); wysłane w BL i bez kopii BL nie; konto w pracy jak dotąd. Licznik menu = widok = alert.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelAdapter, ChannelOfferRow } from '@/lib/adaptery/kontrakt'
import { pobierzOferty, uzupelnijZdjeciaZOfert } from '@/lib/kanaly/oferty'
import { daneAlertow } from '@/lib/panel/alerty-listy'
import { terminWysylki } from '@/lib/panel/termin-wysylki'
import { daneTerminow } from '@/lib/panel/termin-wysylki-dane'
import { filtryZ, licznikiPanelu, SORT_DOMYSLNY, stronaListy } from '@/lib/panel/zamowienia-lista'
import { ZDJECIA_LIMIT_NA_PRZEBIEG, ZDJECIA_ODSTEP_MS } from '@/lib/kanaly/oferty'
import { ZDJECIA_Z_OFERTY_JOB, zadanieZdjecZOferty } from '@/lib/produkty/zdjecia'
import { claimNext, enqueue } from '@/lib/worker/kolejka'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { ACC, offer, order, product, seedBase, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
const SD = ACC.WOO_SD

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function odczyt(db: typeof a, externalId: string, imageUrls: string[], acc: { channel: 'WOO' | 'ALLEGRO'; channelAccountId: string } = SD): Promise<void> {
  await db.channelOfferRead.create({ data: { ...acc, externalId, sku: null, imageUrls, state: 'POWIAZANA', runId: 'run-test', seenAt: T0 } })
}

const zlecenia = async (db: typeof a) =>
  (await db.job.findMany({ where: { kind: ZDJECIA_Z_OFERTY_JOB }, select: { payload: true, status: true } })).map((j) => j.payload as { productId: string; urls: string[] })

describe('zdjęcia istniejących produktów z ofert', () => {
  it('zleca tylko produktom bez zdjęcia z adresem w odczycie ofert; powtórka nie dubluje', async () => {
    const bez = await product(a, 'BEZ-ZDJECIA', 5)
    const ze = await product(a, 'ZE-ZDJECIEM', 5)
    const bezAdresu = await product(a, 'BEZ-ADRESU', 5)
    const wylaczona = await product(a, 'WYLACZONA', 5)
    const nieudane = await product(a, 'NIEUDANE', 5)
    await offer(a, 'WOO_SD', '101', bez)
    await offer(a, 'ALLEGRO', '7001', bez) // druga oferta tego samego produktu: jedno zlecenie
    await offer(a, 'WOO_SD', '102', ze)
    await offer(a, 'WOO_SD', '103', bezAdresu)
    const off = await offer(a, 'WOO_SD', '104', wylaczona)
    await a.channelOffer.update({ where: { id: off }, data: { active: false } })
    await offer(a, 'WOO_SD', '105', nieudane)
    await odczyt(a, '101', ['https://sklep.example.test/101.jpg', 'https://sklep.example.test/101b.jpg'])
    await odczyt(a, '7001', ['https://allegro.example.test/7001.jpg'], ACC.ALLEGRO)
    await odczyt(a, '102', ['https://sklep.example.test/102.jpg'])
    await odczyt(a, '103', [])
    await odczyt(a, '104', ['https://sklep.example.test/104.jpg'])
    await odczyt(a, '105', ['https://sklep.example.test/105.jpg'])
    await a.productImage.create({ data: { productId: ze, position: 0, width: 10, height: 10, bytes: 100, actorId: 'test' } })
    await a.job.create({ data: { kind: ZDJECIA_Z_OFERTY_JOB, payload: { productId: nieudane, urls: ['https://sklep.example.test/105.jpg'] }, status: 'FAILED', lastError: 'odmowa', updatedAt: T0 } })
    // obca firma: ten sam układ, nie widzimy jej ani nie zlecamy u niej
    const obcy = await product(b, 'BEZ-ZDJECIA', 5)
    await offer(b, 'WOO_SD', '101', obcy)
    await odczyt(b, '101', ['https://inny.example.test/101.jpg'])

    const w = await uzupelnijZdjeciaZOfert(a, undefined, T0)
    expect(w).toEqual({ bezZdjecia: 3, zlecone: 1, wKolejce: 0, bezAdresu: 1, odlozone: 1, pominiete: 0, bledy: 0 })
    const z = (await zlecenia(a)).filter((x) => x.productId !== nieudane)
    expect(z).toHaveLength(1)
    expect(z[0]!.productId).toBe(bez)
    // pierwsza oferta produktu (najstarsze powiązanie) — sklep, nie Allegro
    expect(z[0]!.urls).toEqual(['https://sklep.example.test/101.jpg', 'https://sklep.example.test/101b.jpg'])
    expect(await zlecenia(b)).toEqual([])

    // powtórka: zlecenie czeka, nic nie dochodzi i nie liczy się jako nowe
    expect(await uzupelnijZdjeciaZOfert(a, undefined, T0)).toMatchObject({ zlecone: 0, wKolejce: 1 })
    expect((await zlecenia(a)).filter((x) => x.productId === bez)).toHaveLength(1)
    // po 7 dniach od nieudanej próby produkt wraca do kolejki
    const pozniej = new Date(T0.getTime() + 8 * 24 * 3600_000)
    expect((await uzupelnijZdjeciaZOfert(a, undefined, pozniej)).odlozone).toBe(0)
  })

  it('adres tylko http nie jest liczony jako zlecenie', async () => {
    const p = await product(a, 'TYLKO-HTTP', 5)
    await offer(a, 'WOO_SD', '301', p)
    await odczyt(a, '301', ['http://sklep.example.test/301.jpg'])
    expect(await uzupelnijZdjeciaZOfert(a, undefined, T0)).toMatchObject({ bezZdjecia: 1, zlecone: 0, bezAdresu: 1 })
    expect(await zlecenia(a)).toEqual([])
  })

  it('300 produktów: 200 zleceń w przebiegu, reszta w następnym; zdjęcia rozłożone w czasie nie stoją przed nowym zadaniem', async () => {
    const N = 300
    for (let i = 0; i < N; i++) {
      const p = await product(a, `LIMIT-${String(i).padStart(3, '0')}`, 1)
      await offer(a, 'WOO_SD', `L${i}`, p)
      await odczyt(a, `L${i}`, [`https://sklep.example.test/L${i}.jpg`])
    }
    const now = new Date()
    const w1 = await uzupelnijZdjeciaZOfert(a, SD, now)
    expect(w1).toMatchObject({ bezZdjecia: N, zlecone: ZDJECIA_LIMIT_NA_PRZEBIEG, wKolejce: 0, pominiete: N - ZDJECIA_LIMIT_NA_PRZEBIEG })
    const joby = await a.job.findMany({ where: { kind: ZDJECIA_Z_OFERTY_JOB }, select: { runAfter: true, payload: true }, orderBy: { runAfter: 'asc' } })
    expect(joby).toHaveLength(ZDJECIA_LIMIT_NA_PRZEBIEG)
    // pierwsze zlecenie po jednym odstępie, ostatnie po 200 odstępach; każde z flagą „tylko gdy brak zdjęcia”
    expect(joby[0]!.runAfter.getTime() - now.getTime()).toBe(ZDJECIA_ODSTEP_MS)
    expect(joby.at(-1)!.runAfter.getTime() - now.getTime()).toBe(ZDJECIA_LIMIT_NA_PRZEBIEG * ZDJECIA_ODSTEP_MS)
    expect(joby.every((j) => (j.payload as { tylkoGdyBrak?: boolean }).tylkoGdyBrak === true)).toBe(true)

    // zadanie krytyczne dodane zaraz po przebiegu (np. faktura) worker bierze pierwsze, przed zdjęciami
    await enqueue(a, 'test-krytyczne', null)
    expect((await claimNext(sys, 'w-a192'))?.kind).toBe('test-krytyczne')

    // drugi przebieg: 200 czeka w kolejce, zlecona reszta
    const w2 = await uzupelnijZdjeciaZOfert(a, SD, new Date())
    expect(w2).toMatchObject({ zlecone: N - ZDJECIA_LIMIT_NA_PRZEBIEG, wKolejce: ZDJECIA_LIMIT_NA_PRZEBIEG, pominiete: 0 })
    expect(await a.job.count({ where: { kind: ZDJECIA_Z_OFERTY_JOB } })).toBe(N)
  }, 120_000)

  it('worker nie dokłada zdjęć z oferty produktowi, który dostał zdjęcie po zleceniu', async () => {
    const p = await product(a, 'WGRANE-RECZNIE', 5)
    await a.productImage.create({ data: { productId: p, position: 0, width: 10, height: 10, bytes: 100, actorId: 'test' } })
    let pobrania = 0
    const fetch = (async () => {
      pobrania++
      throw new Error('nie powinno pobierać')
    }) as unknown as typeof globalThis.fetch
    const wynik = await zadanieZdjecZOferty(a, { productId: p, urls: ['https://sklep.example.test/x.jpg'], tylkoGdyBrak: true }, { fetch, lookup: async () => ['93.184.216.34'] })
    expect(wynik).toEqual({ dodane: [], bledy: [] })
    expect(pobrania).toBe(0)
    expect(await a.productImage.count({ where: { productId: p } })).toBe(1)
  })

  it('„Pobierz oferty” (atrapa, tylko odczyt) zleca zdjęcia istniejącemu produktowi firmy z BL i wFirmą', async () => {
    const p = await product(a, 'PRZYPRAWA-A192', 5)
    await offer(a, 'WOO_SD', '201', p)
    const wiersze: ChannelOfferRow[] = [{ externalId: '201', sku: 'PRZYPRAWA-A192', ean: null, name: 'Przyprawa testowa', qty: 5, active: true, imageUrls: ['https://sklep.example.test/201.jpg'] }]
    const atrapa = { manifest: { capabilities: ['offers.read'] }, listOffers: async () => ({ items: wiersze, nextCursor: null }) } as unknown as ChannelAdapter
    const wynik = await pobierzOferty(a, SD, atrapa, { hasBl: true, hasWfirma: true, actorId: 'test', now: T0 })
    expect(wynik.newProducts).toBe(0)
    expect(wynik.zdjecia).toMatchObject({ bezZdjecia: 1, zlecone: 1 })
    expect((await zlecenia(a)).map((x) => x.productId)).toEqual([p])
    const run = await a.importRun.findUniqueOrThrow({ where: { id: wynik.runId } })
    expect((run.stats as { zdjecia?: { zlecone: number } }).zdjecia?.zlecone).toBe(1)
  })
})

describe('„Po terminie” na koncie w trybie „Tylko podgląd”', () => {
  it('liczy tylko zamówienia, które BL ma jeszcze przed wysyłką; konto w pracy jak dotąd', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })
    await a.carrierPickup.create({ data: { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true } })
    const p = await product(a, 'PRZYPRAWA', 1000)
    const stare = fromWarsaw('2026-10-12', 9 * 3_600_000)
    const zam = async (label: 'WOO_SD' | 'ALLEGRO', blOrderId: number | null) => {
      const id = (await ingestOrder(a, order([{ productId: p, qty: 1 }], { channel: label, createdAtChannel: stare }))).orderId!
      await sys.order.update({ where: { id }, data: { carrier: 'DPD', status: 'DO_REALIZACJI', paymentState: 'PAID', blOrderId } })
      return id
    }
    const czekaWBl = await zam('WOO_SD', 9001)
    const wyslaneWBl = await zam('WOO_SD', 9002)
    const bezKopii = await zam('WOO_SD', null)
    const praca = await zam('ALLEGRO', null)
    const snap = (blOrderId: number, statusId: number, statusName: string) =>
      a.blOrderSnapshot.create({ data: { blOrderId, orderSource: 'shop', orderSourceId: '1', ...SD, externalRef: String(blOrderId), statusId, statusName, dateAdd: stare, fetchedAt: T0 } })
    await snap(9001, 11, 'Do realizacji DPD')
    await snap(9002, 12, 'Wysłane DPD')
    await snap(9003, 11, 'Do realizacji DPD') // zamówienie BL bez pary u nas: nic nie zmienia

    const now = fromWarsaw('2026-10-15', 10 * 3_600_000)
    const t = await daneTerminow(a, now)
    expect(t.cien?.konta.map((k) => `${k.channel}:${k.channelAccountId}`).sort()).toEqual(['EMPIK:empik', 'RECZNE:panel', 'WOO:km', 'WOO:lampy', 'WOO:sd'])
    expect([...(t.cien?.otwarteWBl ?? [])].sort()).toEqual([9001, 9003])
    const wiersze = (await stronaListy(a, filtryZ({ widok: 'wszystkie' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze
    const termin = (id: string) => terminWysylki(wiersze.find((w) => w.id === id)!, t.harmonogramy, t.przyjazdy, now, t.cien)?.rodzaj ?? null
    expect([czekaWBl, wyslaneWBl, bezKopii, praca].map(termin)).toEqual(['po_terminie', null, null, 'po_terminie'])

    const widok = await stronaListy(a, filtryZ({ widok: 'po_terminie' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })
    expect(widok.wiersze.map((w) => w.id).sort()).toEqual([czekaWBl, praca].sort())
    expect((await licznikiPanelu(a)).poTerminie).toBe(2)
    expect((await daneAlertow(a)).poTerminie).toBe(2)
  })
})
