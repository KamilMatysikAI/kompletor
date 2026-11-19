// Symulacja sezonu (spec 11: 48–50). Wynik w konsoli (JSON) i — gdy ustawione SYM_RAPORT — w pliku.
import { writeFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { crossOrgLeaks, ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { type DecemberReport, runDecember, runPeak, runPropagation } from './symulacja/silnik'

const db = testDb({ poolMax: 60 })
beforeEach(() => truncateAll(db))
afterAll(() => db.$disconnect())

const results: Record<string, unknown> = {}
const save = (k: string, v: unknown) => {
  results[k] = v
  console.log(`[symulacja ${k}] ${JSON.stringify(v)}`)
  if (process.env.SYM_RAPORT) writeFileSync(process.env.SYM_RAPORT, JSON.stringify(results, null, 2), 'utf8')
}

describe('symulacja grudnia', () => {
  it('48: grudzień realny — 1 630 zamówień, 0 naruszeń niezmienników, 0 faktur ponad stan, każde zamówienie z brakiem ma Shortage', async () => {
    const rep = await runDecember(db, { log: process.env.SYM_LOG ? (s) => console.log(s) : undefined })
    save('48', rep)
    expect(rep.orders).toBe(1630)
    expect(rep.invariantViolations).toBe(0)
    expect(rep.oversoldInvoices).toBe(0)
    expect(rep.ordersWithShortageWithoutRow).toBe(0)
    expect(rep.alerts['ALLOCATE_ZALEGLE'] ?? 0).toBe(0) // przydział nadąża bez strażnika
  }, 10_800_000) // limit z zapasem: przy obciążonym komputerze 48 trwa do ~1 h

  // ten sam grudzień, ale faktury i odczyty jednym torem kolejki, z timeoutami (2%) i limitem wFirmy
  // (co 300. faktura): odczyty nakładają się na żądania faktur, budżet przebiegu obejmuje `find`.
  it('48q: grudzień przez kolejkę wFirmy — 0 naruszeń, 0 faktur ponad stan, 0 dubli, budżet przebiegu trzymany, nic nie zostaje bez faktury', async () => {
    const rep = await runDecember(db, { viaQueue: true })
    save('48q', rep)
    expect(rep.orders).toBe(1630)
    expect(rep.invariantViolations).toBe(0)
    expect(rep.oversoldInvoices).toBe(0)
    expect(rep.ordersWithShortageWithoutRow).toBe(0)
    expect(rep.alerts['ALLOCATE_ZALEGLE'] ?? 0).toBe(0)
    expect(rep.queue!.timeouts).toBeGreaterThan(0)
    expect(rep.queue!.limits).toBeGreaterThan(0)
    expect(rep.queue!.maxCallsInRun).toBeLessThanOrEqual(rep.queue!.maxCalls)
    expect(rep.queue!.doubleInvoices).toBe(0)
    expect(rep.queue!.notInvoicedAtEnd).toBe(0)
    expect(rep.queue!.unknownAtEnd).toBe(0)
    expect(rep.queue!.invoiceErrorFlags).toBe(0)
    expect(rep.alertsOpen['FAKTURA_BLAD'] ?? 0).toBe(0) // każda wyszła, więc żaden alert faktury nie zostaje otwarty
  }, 10_800_000)

  it('49: szczyt × 10 — 1 120 zamówień, 50 połączeń, 20% na 10 produktów z małym stanem, równoległe odczyty wFirmy i faktury; p95 ≤ 200 ms, max ≤ 2 s', async () => {
    const rep = await runPeak(db, { spreadSeconds: Number(process.env.SYM_SZCZYT_SEKUNDY) || 120 })
    save('49', rep)
    expect(rep.errors).toBe(0)
    expect(rep.invariantViolations).toBe(0)
    expect(rep.hotOverReserved).toBe(0)
    expect(rep.invoices).toBeGreaterThan(0) // faktury naprawdę szły w trakcie szczytu
    expect(rep.oversoldInvoices).toBe(0)
    expect(rep.ingestMs.p95).toBeLessThanOrEqual(200)
    expect(rep.ingestMs.max).toBeLessThanOrEqual(2000)
  }, 1_800_000)

  // dwie firmy w jednej bazie naraz. A = ten sam grudzień co 48 (to samo ziarno, te same id produktów),
  // B = inny grudzień (inne ziarno), te same numery zamówień SYM-1… i te same SKU/oferty (unikalne w obrębie firmy).
  it('48b: dwie firmy naraz — 0 przecieków między firmami, 0 naruszeń i 0 faktur ponad stan w każdej', async () => {
    const dbB = testDb({ organizationId: ORG_B, poolMax: 30 })
    try {
      const [ra, rb] = await Promise.all([
        runDecember(db, { seq: { n: 0 } }),
        runDecember(dbB, { seed: 20251202, idPrefix: 'b_', seq: { n: 0 } }),
      ])
      const leaks = await crossOrgLeaks()
      const sys = testSystemDb()
      const perOrg = Object.fromEntries(
        (await sys.order.groupBy({ by: ['organizationId'], _count: true })).map((g) => [g.organizationId, g._count]),
      )
      // porównanie A z jedną firmą (48 w tym samym przebiegu): pola wyniku niezależne od czasu
      const single = results['48'] as DecemberReport | undefined
      const fields = ['orders', 'perChannel', 'lines', 'ordersWithShortage', 'shortageUnits', 'invoices', 'invoicesWithoutWz', 'deliveries', 'paidLate', 'expired', 'refundPending', 'codReduced', 'alerts', 'reads'] as const
      const diffVs48 = single ? fields.filter((f) => JSON.stringify(ra[f]) !== JSON.stringify(single[f])) : null
      save('48b', { A: ra, B: rb, leaks, ordersPerOrg: perOrg, diffVs48 })
      expect(Object.values(leaks).every((n) => n === 0)).toBe(true)
      expect(perOrg).toEqual({ [ORG_A]: 1630, [ORG_B]: 1630 })
      for (const r of [ra, rb]) {
        expect(r.orders).toBe(1630)
        expect(r.invariantViolations).toBe(0)
        expect(r.oversoldInvoices).toBe(0)
        expect(r.ordersWithShortageWithoutRow).toBe(0)
      }
    } finally {
      await dbB.$disconnect()
    }
  }, 14_400_000)

  it('50: propagacja w szczycie — atrapy kanałów z limitami, p95 opóźnienia zmiana → wysyłka ≤ 5 min', async () => {
    const rep = await runPropagation(db)
    save('50', rep)
    expect(rep.pushes).toBeGreaterThan(0)
    expect(rep.delaySec.p95).toBeLessThanOrEqual(300)
    expect(rep.heldIncreases).toBeGreaterThan(0) // wstrzymanie wzrostów przy dostawie naprawdę zadziałało
  }, 1_800_000)

  // ten sam szczyt z rejestrem synchronizacji: nie więcej zapisów niż bez rejestru i zero różnic w końcowym
  // stanie ofert w atrapach kanałów (rejestr pomija tylko to, co kanał już ma)
  it('50r: propagacja z rejestrem synchronizacji — końcowy stan ofert jak bez rejestru, zapisów nie więcej', async () => {
    const bez = await runPropagation(db)
    await truncateAll(db)
    const z = await runPropagation(db, { rejestr: true })
    const zapisy = (r: typeof bez) => Object.values(r.perChannel).reduce((a, c) => ({ calls: a.calls + c.calls, items: a.items + c.items }), { calls: 0, items: 0 })
    save('50r', { bez: { ...zapisy(bez), pushes: bez.pushes }, z: { ...zapisy(z), pushes: z.pushes, pominiete: z.skippedUnchanged }, perChannelBez: bez.perChannel, perChannelZ: z.perChannel, ofert: Object.keys(z.finalStock).length })
    expect(Object.keys(z.finalStock).length).toBeGreaterThan(0)
    expect(z.finalStock).toEqual(bez.finalStock)
    expect(zapisy(z).items).toBeLessThanOrEqual(zapisy(bez).items)
    expect(z.delaySec.p95).toBeLessThanOrEqual(300)
  }, 3_600_000)
})
