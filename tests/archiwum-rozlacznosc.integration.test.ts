// przegląd końcowy: rozłączność archiwum z `Order` w SQL raportu.
//  - równoważność: fragment SQL (`sqlBrakWKompletorze`) daje dokładnie ten sam wynik co predykat TS
//    (`jestWKompletorze`) na przypadkach brzegowych reguły (id, numer w `channelNumber`, numer w `externalId` przy
//    pustym `channelNumber`, okno 36 h, kanał z numerem nieunikalnym, inne konto);
//  - wydajność (ARCHIWUM_WYDAJNOSC=1): ok. 15 tys. wierszy archiwum i 12 tys. `Order` na jednym koncie, raport roku
//    z porównaniem do roku poprzedniego; czas zapytania rozłączności i całego raportu w logu.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Prisma } from '@prisma/client'
import { Prisma as P } from '@prisma/client'
import { raportSprzedazy, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { jestWKompletorze, OKNO_NUMERU_MS } from '@/lib/archiwum/rozlacznosc'
import * as rozlacznosc from '@/lib/archiwum/rozlacznosc'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, seedBase, type TestChannel } from './rdzen-fixtures'

const a = testDb()

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
})
afterAll(async () => {
  await a.$disconnect()
})

const H = 3600_000
const T0 = new Date('2026-03-10T12:00:00Z')
const at = (godz: number) => new Date(T0.getTime() + godz * H)

function archiwum(konto: TestChannel, externalId: string, channelNumber: string | null, kiedy: Date): Prisma.ArchivedOrderCreateManyInput {
  return { ...ACC[konto], source: 'TEST', externalId, channelNumber, channelStatus: 'x', status: 'WYSLANE', createdAtChannel: kiedy, paymentState: 'PAID', totalGross: '10.00', currency: 'PLN', trackingNumbers: [], invoiceNumbers: [] }
}
function zamowienie(konto: TestChannel, externalId: string, channelNumber: string | null, kiedy: Date): Prisma.OrderCreateManyInput {
  return { ...ACC[konto], externalId, channelNumber, status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '10.00', createdAtChannel: kiedy }
}

/** Fragment SQL rozłączności dla aliasu archiwum `a` (nowa postać albo stara, dopóki jej nie ma). */
function sqlBrak(): P.Sql {
  const m = rozlacznosc as unknown as { sqlBrakWKompletorze?: (a: string) => P.Sql; sqlOrderWiazeArchiwum?: (x: string, a: string) => P.Sql }
  if (m.sqlBrakWKompletorze) return m.sqlBrakWKompletorze('a')
  return P.sql`NOT EXISTS (SELECT 1 FROM "Order" x WHERE ${m.sqlOrderWiazeArchiwum!('x', 'a')})`
}

describe('rozłączność archiwum z Order: SQL = predykat TS', () => {
  it('przypadki brzegowe reguły dają ten sam zbiór w SQL i w TS', async () => {
    const W = OKNO_NUMERU_MS / H // 36
    const ord: Prisma.OrderCreateManyInput[] = [
      zamowienie('WOO_SD', '1001', null, at(0)), // przeprowadzka: numer w externalId, bez channelNumber
      zamowienie('WOO_SD', '1002', '1002', at(0)), // przeprowadzka + numer dopisany z kanału
      zamowienie('WOO_SD', '55', '2001', at(0)), // id i numer osobno
      zamowienie('WOO_SD', '3001', '9999', at(0)), // numer w externalId, ale channelNumber inny: gałąź (b2) nie wiąże
      zamowienie('EMPIK', 'E-1-A', 'K-1', at(0)),
      zamowienie('WOO_LAMPY', '1001', null, at(0)), // inne konto
    ]
    const arch: Prisma.ArchivedOrderCreateManyInput[] = [
      archiwum('WOO_SD', '1001', null, at(500)), // (a) ten sam id, bez okna
      archiwum('WOO_SD', 'id-1', '1001', at(W)), // (b) numer = externalId przy pustym channelNumber, na granicy okna
      archiwum('WOO_SD', 'id-2', '1001', at(W + 0.001)), // tuż za oknem
      archiwum('WOO_SD', 'id-3', '1002', at(-W)), // (b) channelNumber = channelNumber, granica okna wstecz
      archiwum('WOO_SD', 'id-4', '1002', at(-W - 1)), // za oknem
      archiwum('WOO_SD', 'id-5', '2001', at(1)), // (b) numer
      archiwum('WOO_SD', '55', null, at(-900)), // (a) id
      archiwum('WOO_SD', 'id-6', '3001', at(0)), // channelNumber Order = 9999, nie 3001: brak wiązania
      archiwum('WOO_SD', 'id-7', '9999', at(2)), // (b) przez channelNumber
      archiwum('WOO_SD', 'id-8', null, at(0)), // bez numeru i bez id: osobne
      archiwum('EMPIK', 'E-1-B', 'K-1', at(0)), // Empik: numer nie wiąże
      archiwum('EMPIK', 'E-1-A', 'K-1', at(0)), // Empik: id wiąże
      archiwum('WOO_LAMPY', 'id-9', '1001', at(1)), // inne konto: numer wiąże w swoim koncie
      archiwum('WOO_LAMPY', 'id-10', '1002', at(1)), // numer z innego konta nie wiąże
      archiwum('ALLEGRO', '1001', null, at(0)), // inne konto i kanał, ten sam id
    ]
    await a.order.createMany({ data: ord })
    await a.archivedOrder.createMany({ data: arch })

    const sql = await a.$queryRaw<{ externalId: string; channelAccountId: string }[]>`
      SELECT a."externalId", a."channelAccountId" FROM "ArchivedOrder" a WHERE ${sqlBrak()} ORDER BY 2, 1`
    const orders = await a.order.findMany({ select: { channel: true, channelAccountId: true, externalId: true, channelNumber: true, createdAtChannel: true } })
    const archiwa = await a.archivedOrder.findMany({ select: { channel: true, channelAccountId: true, externalId: true, channelNumber: true, createdAtChannel: true } })
    const ts = archiwa
      .filter((z) => !jestWKompletorze(z.channel as Channel, z, orders.filter((x) => x.channel === z.channel && x.channelAccountId === z.channelAccountId)))
      .map((z) => ({ externalId: z.externalId, channelAccountId: z.channelAccountId }))
      .sort((p, q) => p.channelAccountId.localeCompare(q.channelAccountId) || p.externalId.localeCompare(q.externalId))
    expect(sql).toEqual(ts)
    // sprawdzenie samej oczekiwanej listy (żeby obie strony nie myliły się tak samo)
    expect(sql.map((r) => `${r.channelAccountId}:${r.externalId}`).sort()).toEqual(['allegro:1001', 'empik:E-1-B', 'lampy:id-10', 'sd:id-2', 'sd:id-4', 'sd:id-6', 'sd:id-8'])
  })
})

describe('wydajność (ARCHIWUM_WYDAJNOSC=1): rozłączność przy 15 tys. archiwum i 12 tys. Order', () => {
  it.runIf(process.env.ARCHIWUM_WYDAJNOSC === '1')('raport roku z porównaniem: czas zapytań', async () => {
    const ARCH = 15_000
    const ORD = 12_000
    const start = new Date('2025-01-01T00:00:00Z').getTime()
    const arch: Prisma.ArchivedOrderCreateManyInput[] = []
    for (let i = 0; i < ARCH; i++) {
      const kiedy = new Date(start + Math.floor((i * 700 * 86_400_000) / ARCH)) // 2025-01 … 2026-11
      arch.push(archiwum('WOO_SD', `id-${i}`, String(100_000 + i), kiedy))
    }
    // Order od grudnia 2025: co trzeci z przeprowadzki (numer w externalId), reszta z kanału (numer w channelNumber)
    const ord: Prisma.OrderCreateManyInput[] = []
    const startOrd = new Date('2025-12-01T00:00:00Z').getTime()
    for (let i = 0; i < ORD; i++) {
      const kiedy = new Date(startOrd + Math.floor((i * 355 * 86_400_000) / ORD))
      const nr = String(200_000 + i)
      ord.push(i % 3 === 0 ? zamowienie('WOO_SD', nr, i % 2 ? nr : null, kiedy) : zamowienie('WOO_SD', `ext-${i}`, nr, kiedy))
    }
    for (let i = 0; i < arch.length; i += 2000) await a.archivedOrder.createMany({ data: arch.slice(i, i + 2000) })
    for (let i = 0; i < ord.length; i += 2000) await a.order.createMany({ data: ord.slice(i, i + 2000) })
    // statystyki jak po autovacuum na produkcji: ANALYZE właścicielem tabel (rola aplikacji jest pomijana)
    await testSystemDb().$executeRawUnsafe('ANALYZE "Order"')
    await testSystemDb().$executeRawUnsafe('ANALYZE "ArchivedOrder"')

    const t0 = performance.now()
    const n = (await a.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ArchivedOrder" a WHERE ${sqlBrak()}`)[0]!.n
    const tZap = Math.round(performance.now() - t0)
    if (process.env.ARCHIWUM_EXPLAIN === '1') {
      const plan = await a.$queryRaw<{ 'QUERY PLAN': string }[]>`EXPLAIN (ANALYZE, COSTS OFF) SELECT count(*) AS n FROM "ArchivedOrder" a WHERE ${sqlBrak()}`
      console.log(plan.map((p) => p['QUERY PLAN']).join('\n'))
    }
    expect(Number(n)).toBe(ARCH)
    const t1 = performance.now()
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2026-01-01', do: '2026-11-30', grupuj: 'miesiac' }, new Date('2026-12-01T09:00:00Z')), new Date('2026-12-01T09:00:00Z'))
    const tRap = Math.round(performance.now() - t1)
    console.log(`[A-292 W-2] rozłączność: ${ARCH} archiwum × ${ORD} Order: zapytanie NOT EXISTS ${tZap} ms; raport 2026 z porównaniem ${tRap} ms (${r.razem.zamowien} zamówień)`)
  }, 600_000)
})
