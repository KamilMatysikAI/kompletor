// Przeprowadzka z BL na bazie: tryb próbny bez zapisu, zapis i powtórka (idempotencja), przerwanie
// i wznowienie, zły rekord nie zatrzymuje partii, odmowa dla firmy w cieniu, dwie firmy (RLS), brak danych osobowych.
// BL wyłącznie jako atrapa HTTP z danymi fikcyjnymi (tests/bl-przeprowadzka-atrapa.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { loadBlStatusMap } from '@/lib/organizacje'
import { METODY_PRZEPROWADZKI } from '@/lib/przeprowadzka/metody'
import { zbierz, type ZebraneDane } from '@/lib/przeprowadzka/przebieg'
import { parseMapa, type MapaCzlowieka } from '@/lib/przeprowadzka/statusy'
import { uruchomPrzeprowadzke } from '@/lib/przeprowadzka/uruchomienie'
import { OdmowaZapisu, RODZAJ_PRZEBIEGU } from '@/lib/przeprowadzka/zapis'
import { AtrapaBlPrzeprowadzki, NOW, PII_SENTINELS } from './bl-przeprowadzka-atrapa'
import { crossOrgLeaks, ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'

// Firmy jak po `npm run org:create`: magazyn „glowny”, startowe reguły przewoźników, bez kont kanałów.
const NOWE_FIRMY = [
  { id: ORG_A, slug: 'test-a', name: 'Firma testowa A' },
  { id: ORG_B, slug: 'test-b', name: 'Firma testowa B' },
]
const MAPA: MapaCzlowieka = parseMapa({ statusy: { '5': 'DO_REALIZACJI' }, przewoznicy: { 'Poczta Polska': 'BRAK' } })

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const registry = defaultRegistry()

afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

beforeEach(async () => {
  await truncateAll(undefined, NOWE_FIRMY)
})

async function zbierzZAtrapy(fake = new AtrapaBlPrzeprowadzki(), mapa: MapaCzlowieka = MAPA): Promise<ZebraneDane> {
  return zbierz({ bl: fake.client(), wfirma: null, wfirmaWarehouseId: null }, { mapa, registry, now: NOW })
}

/** Liczba wierszy każdej tabeli (klient systemowy, wszystkie firmy). */
async function liczbyWierszy(): Promise<Record<string, number>> {
  const sys = testSystemDb()
  const tables = await sys.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`
  const out: Record<string, number> = {}
  for (const t of tables) out[t.tablename] = Number((await sys.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t.tablename}"`))[0]!.n)
  return out
}

/** Cała baza jako tekst (wszystkie tabele, wszystkie firmy) — do szukania wartowników danych osobowych. */
async function caloscBazy(): Promise<string> {
  const sys = testSystemDb()
  const tables = await sys.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  let all = ''
  for (const t of tables) {
    const rows = await sys.$queryRawUnsafe<{ j: unknown }[]>(`SELECT row_to_json(x) AS j FROM "${t.tablename}" x`)
    all += JSON.stringify(rows)
  }
  return all
}

async function stan(c: PrismaClient = db) {
  return {
    konta: await c.channelConfig.count(),
    produkty: await c.product.count(),
    stany: await c.stock.count(),
    ruchy: await c.stockMovement.count(),
    oferty: await c.channelOffer.count(),
    reguly: await c.carrierRule.count(),
    zamowienia: await c.order.count(),
    pozycje: await c.orderLine.count(),
    rezerwacje: await c.reservation.count(),
  }
}

describe('przeprowadzka z BL', () => {
  it('zbieranie woła tylko metody z listy', async () => {
    const fake = new AtrapaBlPrzeprowadzki()
    const dane = await zbierzZAtrapy(fake)
    const used = new Set(fake.calls.map((c) => c.method))
    for (const m of used) expect(METODY_PRZEPROWADZKI as readonly string[]).toContain(m)
    expect(used.has('getOrders')).toBe(true)
    expect(used.has('getInventoryProductsStock')).toBe(true) // firma bez wFirmy: stan z magazynu BL
    expect(fake.calls.filter((c) => c.method === 'getOrders').every((c) => c.params['get_unconfirmed_orders'] === true)).toBe(true)
    expect(dane.katalog?.stockSource).toBe('bl')
  })

  it('tryb próbny: nic nie trafia do bazy; raport mówi, co przejdzie i co wymaga decyzji', async () => {
    const dane = await zbierzZAtrapy(undefined, parseMapa({}))
    const przed = await liczbyWierszy()
    const w = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, registry, zapisz: false, now: NOW })
    expect(await liczbyWierszy()).toEqual(przed)
    expect(w.zapis).toBeNull()
    expect(w.raport.tryb).toBe('PROBNY')
    // status 5 niepewny z otwartym zamówieniem → zapis byłby odrzucony
    expect(w.powodyOdmowy.join(' ')).toMatch(/Status Xyz/)
    expect(w.raport.doDecyzji.statusy.map((s) => s.id)).toEqual(['5'])
    expect(w.raport.doDecyzji.przewoznicy.map((p) => p.metoda)).toEqual(['Poczta Polska'])
    expect(w.raport.doDecyzji.produktyBezSku.map((p) => p.idBl).sort()).toEqual(['1003', '1004', '1005'])
    expect(w.raport.doDecyzji.ofertyBezPowiazania.some((o) => o.oferta === '502')).toBe(true)
    expect(w.raport.coPrzejdzie['produkty']).toBe(2)
    expect(w.raport.coPrzejdzie['zestawy']).toBe(1)
    const zg = Object.fromEntries(w.raport.zgodnosc.map((z) => [z.wiersz, z]))
    expect(zg['Otwarte zamówienia']).toMatchObject({ bl: 6, plan: 5 }) // 5001–5003, 5005, 5006, 5008 (5007 odrzucony w parserze; 5008 nie przejdzie walidacji rdzenia)
    expect(w.raport.doDecyzji.zamowieniaDoWyjasnienia.find((z) => z.idBl === '5008')?.powod).toMatch(/zdublowana pozycja/)
    expect(w.markdown).toContain('## 5. Tabela zgodności')
    expect(w.markdown).toContain('tryb próbny (nic nie zapisano)')
    // zapis bez decyzji: odmowa, baza bez zmian
    await expect(uruchomPrzeprowadzke(db, { firma: 'test-a', dane, registry, zapisz: true, now: NOW })).rejects.toBeInstanceOf(OdmowaZapisu)
    expect(await liczbyWierszy()).toEqual(przed)
  })

  it('zapis: konfiguracja, produkty, stany, oferty, reguły, zamówienia; powtórka nic nie dubluje', async () => {
    const dane = await zbierzZAtrapy()
    const w = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: true, now: NOW })
    expect(w.zapis).not.toBeNull()
    const s1 = await stan()
    expect(s1).toMatchObject({ konta: 4, produkty: 3, stany: 2, reguly: 4 })
    const konta = await db.channelConfig.findMany()
    expect(konta.every((k) => k.stockMode === 'CIEN' && k.statusMode === 'CIEN' && k.trackingMode === 'CIEN' && k.publishMode === 'CIEN')).toBe(true)
    // magazyn z przeprowadzki ma jawne źródło KOMPLETOR (przeprowadzka z BL nie ma magazynu wFirmy)
    expect(await db.warehouse.findFirstOrThrow({ select: { stockSource: true, wfirmaWarehouseId: true } })).toEqual({ stockSource: 'KOMPLETOR', wfirmaWarehouseId: null })
    // stan startowy z magazynu BL, ruch INITIAL_IMPORT
    const her1 = await db.product.findFirstOrThrow({ where: { sku: 'HER-001' }, include: { stocks: true } })
    expect(her1.stocks[0]!.physical).toBe(12)
    expect(await db.product.count({ where: { sku: { in: ['DUP-1'] } } })).toBe(0) // SKU powtórzone: nie sklejamy
    // zamówienia: 5001, 5002, 5003, 5005, 5006 w rdzeniu; 5008 (zdublowana pozycja) błąd bez zatrzymania partii
    const wyniki = Object.fromEntries(w.zapis!.zamowienia.map((z) => [z.blOrderId, z]))
    expect(wyniki['5008']!.wynik).toBe('BLAD')
    expect(['5001', '5002', '5003', '5005', '5006'].map((id) => wyniki[id]!.wynik)).toEqual(['NOWE', 'NOWE', 'NOWE', 'NOWE', 'NOWE'])
    expect(s1.zamowienia).toBe(5)
    const z5001 = await db.order.findFirstOrThrow({ where: { externalId: '7001' } })
    expect(z5001).toMatchObject({ channel: 'WOO', channelAccountId: '9001', blOrderId: 5001, status: 'DO_REALIZACJI', carrier: 'DPD' })
    expect(await db.order.findFirstOrThrow({ where: { externalId: '7002' } })).toMatchObject({ status: 'DO_WYJASNIENIA' }) // oferta 502 bez powiązania
    expect(await db.order.findFirstOrThrow({ where: { externalId: 'alg-1111' } })).toMatchObject({ channel: 'ALLEGRO', carrier: 'ALLEGRO' })
    expect(await db.order.findFirstOrThrow({ where: { externalId: 'bl:5006' } })).toMatchObject({ channel: 'BL_INNE', channelAccountId: 'tiktok:5', status: 'DO_WYJASNIENIA' })
    expect(await db.reservation.count()).toBeGreaterThan(0)
    // mapa statusów w ustawieniach firmy
    const mapa = await loadBlStatusMap(db)
    expect(mapa['5']).toMatchObject({ status: 'DO_REALIZACJI', pewnosc: 'DECYZJA' })
    expect(mapa['3']).toMatchObject({ status: 'WYSLANE', pewnosc: 'PEWNE' })
    const run = await db.importRun.findFirstOrThrow({ where: { kind: RODZAJ_PRZEBIEGU } })
    expect(run.stats).toMatchObject({ zamowieniaNowe: 5, zamowieniaBledy: 1, produkty: 2 })
    expect(await db.importIssue.count({ where: { runId: run.id, kind: 'zamowienie', ref: '5008' } })).toBe(1)

    // powtórka: te same liczby, zamówienia DUPLIKAT
    const w2 = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane: await zbierzZAtrapy(), mapa: MAPA, registry, zapisz: true, now: NOW })
    expect(await stan()).toEqual(s1)
    expect(w2.zapis!.zamowienia.filter((z) => z.wynik === 'DUPLIKAT').map((z) => z.blOrderId)).toEqual(['5001', '5002', '5003', '5005', '5006'])
    expect(await db.importRun.count({ where: { kind: RODZAJ_PRZEBIEGU } })).toBe(2)
  })

  it('istniejący stan nie jest nadpisywany — różnica idzie do raportu', async () => {
    await uruchomPrzeprowadzke(db, { firma: 'test-a', dane: await zbierzZAtrapy(), mapa: MAPA, registry, zapisz: true, now: NOW })
    const fake = new AtrapaBlPrzeprowadzki()
    fake.produkty.find((p) => p.id === 1001)!.stock = 20
    const dane = await zbierzZAtrapy(fake)
    const probny = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: false, now: NOW })
    expect(probny.raport.doDecyzji.rozniceStanow).toEqual([{ sku: 'HER-001', kompletor: 12, zrodlo: 20 }])
    const zapis = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: true, now: NOW })
    expect(zapis.raport.doDecyzji.rozniceStanow).toEqual([{ sku: 'HER-001', kompletor: 12, zrodlo: 20 }])
    expect((await db.product.findFirstOrThrow({ where: { sku: 'HER-001' }, include: { stocks: true } })).stocks[0]!.physical).toBe(12)
  })

  it('przerwanie w połowie i wznowienie kończy to samo', async () => {
    const dane = await zbierzZAtrapy()
    await expect(
      uruchomPrzeprowadzke(db, {
        firma: 'test-a',
        dane,
        mapa: MAPA,
        registry,
        zapisz: true,
        now: NOW,
        poEtapie: (e) => {
          if (e === 'produkty') throw new Error('przerwane (test)')
        },
      }),
    ).rejects.toThrow('przerwane')
    const czesc = await stan()
    expect(czesc.produkty).toBe(3)
    expect(czesc.zamowienia).toBe(0)
    expect((await db.importRun.findFirstOrThrow({ where: { kind: RODZAJ_PRZEBIEGU } })).status).toBe('FAILED')
    await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: true, now: NOW })
    const wznowione = await stan()
    // ten sam wynik co jednym przebiegiem w czystej firmie B
    await uruchomPrzeprowadzke(dbB, { firma: 'test-b', dane, mapa: MAPA, registry, zapisz: true, now: NOW })
    expect(wznowione).toEqual(await stan(dbB))
  })

  it('decyzja o przewoźniku dopisana w mapie po pierwszym zapisie wchodzi przy drugim; reguły człowieka zostają', async () => {
    const bezPoczty = parseMapa({ statusy: { '5': 'DO_REALIZACJI' } })
    const w1 = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane: await zbierzZAtrapy(undefined, bezPoczty), mapa: bezPoczty, registry, zapisz: true, now: NOW })
    expect(w1.zapis!.reguly.pozostawione).toBe(false)
    const pocztaDpd = async () => (await db.carrierRule.findMany()).some((r) => r.carrier === 'DPD' && /poczta/i.test(r.pattern ?? ''))
    expect(await pocztaDpd()).toBe(false)
    // człowiek dopisuje decyzję; tryb próbny liczy z reguł, które zostaną po zapisie, a 5006 jest już przeniesione
    const zPoczta = parseMapa({ statusy: { '5': 'DO_REALIZACJI' }, przewoznicy: { 'Poczta Polska': 'DPD' } })
    const dane2 = await zbierzZAtrapy(undefined, zPoczta)
    const proba = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane: dane2, mapa: zPoczta, registry, zapisz: false, now: NOW })
    const z5006 = await db.order.findFirstOrThrow({ where: { blOrderId: 5006 } })
    expect(proba.zamowienia.find((z) => z.blOrderId === '5006')).toMatchObject({ wynik: 'DUPLIKAT', status: z5006.status })
    const w2 = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane: dane2, mapa: zPoczta, registry, zapisz: true, now: NOW })
    expect(w2.zapis!.reguly).toMatchObject({ pozostawione: false })
    expect(w2.zapis!.reguly.zapisane).toBeGreaterThan(0)
    expect(await pocztaDpd()).toBe(true)
    // reguła zmieniona przez człowieka po zapisie: kolejny zapis jej nie rusza
    const r = await db.carrierRule.findFirstOrThrow({ where: { carrier: 'DPD' } })
    await db.carrierRule.update({ where: { id: r.id }, data: { priority: r.priority + 1 } })
    const w3 = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane: await zbierzZAtrapy(undefined, MAPA), mapa: MAPA, registry, zapisz: true, now: NOW })
    expect(w3.zapis!.reguly).toMatchObject({ pozostawione: true, zapisane: 0 })
  })

  it('niepełne pobranie otwartych zamówień blokuje --zapisz; obcięte okno „ostatnich” nie robi przebiegu PARTIAL', async () => {
    const dane = await zbierzZAtrapy()
    const niepelne = { ...dane, zamowienia: { ...dane.zamowienia, complete: false } }
    const przed = await liczbyWierszy()
    const proba = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane: niepelne, mapa: MAPA, registry, zapisz: false, now: NOW })
    expect(proba.powodyOdmowy.join(' ')).toMatch(/nie wszystkie otwarte zamówienia/)
    await expect(uruchomPrzeprowadzke(db, { firma: 'test-a', dane: niepelne, mapa: MAPA, registry, zapisz: true, now: NOW })).rejects.toBeInstanceOf(OdmowaZapisu)
    expect(await liczbyWierszy()).toEqual(przed)
    const obciete = { ...dane, zamowienia: { ...dane.zamowienia, ostatnieObciete: true } }
    const w = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane: obciete, mapa: MAPA, registry, zapisz: true, now: NOW })
    expect(w.raport.zgodnosc.find((z) => z.wiersz.startsWith('Ostatnie zamówienia'))!.uwagi).toMatch(/to nie błąd/)
    const run = await db.importRun.findFirstOrThrow({ where: { id: w.zapis!.runId } })
    expect(run.status).not.toBe('FAILED')
    expect(await db.importIssue.count({ where: { runId: run.id, kind: { startsWith: 'pobieranie:' } } })).toBe(dane.issues.length) // obcięte okno nic nie dokłada
  })

  it('firma w cieniu (ACME): tryb próbny działa, zapis odmówiony', async () => {
    const dane = await zbierzZAtrapy()
    await db.channelConfig.create({ data: { channel: 'WOO', channelAccountId: '7100001', name: 'Sklep w cieniu', adapterKey: 'woo.rest.v1', stockMode: 'PRACA' } })
    await db.inboundEvent.create({ data: { id: 'ie_test_cien', source: 'poll:WOO:7100001', eventKey: 'x:1', receivedAt: NOW } })
    const przed = await liczbyWierszy()
    const w = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: false, now: NOW })
    expect(w.powodyOdmowy.join(' ')).toMatch(/trybie innym niż CIEN/)
    expect(w.powodyOdmowy.join(' ')).toMatch(/zamówienia z własnych kanałów/)
    await expect(uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: true, now: NOW })).rejects.toBeInstanceOf(OdmowaZapisu)
    expect(await liczbyWierszy()).toEqual(przed)
  })

  it('dwie firmy: zapis jednej nie widać w drugiej (RLS), bez przecieków', async () => {
    const dane = await zbierzZAtrapy()
    await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: true, now: NOW })
    expect(await stan(dbB)).toMatchObject({ konta: 0, produkty: 0, stany: 0, oferty: 0, zamowienia: 0 })
    expect(await loadBlStatusMap(dbB)).toEqual({})
    await uruchomPrzeprowadzke(dbB, { firma: 'test-b', dane, mapa: MAPA, registry, zapisz: true, now: NOW })
    expect(await stan(dbB)).toEqual(await stan(db))
    expect(Object.values(await crossOrgLeaks()).every((n) => n === 0)).toBe(true)
  })

  it('brak danych osobowych: ani w bazie, raporcie, zrzucie, ImportIssue, statystykach, ani w logu', async () => {
    const logs: string[] = []
    const spies = (['log', 'warn', 'error', 'info'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))))
    try {
      const dane = await zbierzZAtrapy()
      const probny = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: false, now: NOW })
      const zapis = await uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa: MAPA, registry, zapisz: true, now: NOW })
      const teksty = {
        zrzut: JSON.stringify(dane),
        raportProbny: probny.markdown + JSON.stringify(probny.raport),
        raportZapisu: zapis.markdown + JSON.stringify(zapis.raport),
        baza: await caloscBazy(),
        issues: JSON.stringify(await db.importIssue.findMany()),
        stats: JSON.stringify(await db.importRun.findMany({ select: { stats: true, error: true } })),
        log: logs.join('\n'),
      }
      for (const [gdzie, t] of Object.entries(teksty)) for (const s of PII_SENTINELS) expect(t.includes(s), `${s} w: ${gdzie}`).toBe(false)
      expect(teksty.zrzut).not.toContain('nowe_pole_bl')
      expect(teksty.baza).toContain('HER-001') // baza nie jest pusta — test szuka w prawdziwych danych
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})
