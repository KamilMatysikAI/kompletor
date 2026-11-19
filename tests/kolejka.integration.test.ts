import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { INVOICES_JOB } from '@/lib/cien/faktury-bl'
import { WZ_JOB } from '@/lib/cien/wz-wfirmy'
import { ZADANIE_WYSYLKI } from '@/lib/poczta/wysylka'
import { PACKSHOT_JOB } from '@/lib/produkty/packshot'
import { ZDJECIA_Z_OFERTY_JOB } from '@/lib/produkty/zdjecia'
import { FEED_JOB } from '@/lib/produkty/zdjecia-feed'
import { OFERTY_MASOWO_JOB } from '@/lib/oferty/masowo'
import { backoffMs, claimNext, complete, enqueue, fail, RODZAJE_TLA, reapStale, release } from '@/lib/worker/kolejka'
import { testDb, truncateAll } from './db'

const db = testDb()
beforeEach(() => truncateAll(db))
afterAll(() => db.$disconnect())

describe('kolejka zadań workera', () => {
  it('dedupeKey: to samo czekające zadanie nie dubluje się; po zakończeniu można dodać ponownie', async () => {
    const a = await enqueue(db, 'import-katalogu', null, { dedupeKey: 'import' })
    expect(await enqueue(db, 'import-katalogu', null, { dedupeKey: 'import' })).toBeNull()
    const job = await claimNext(db, 'w1')
    expect(job!.id).toBe(a)
    await complete(db, a!)
    expect(await enqueue(db, 'import-katalogu', null, { dedupeKey: 'import' })).not.toBeNull()
  })

  it('dwa równoległe pobrania nie dostają tego samego zadania', async () => {
    await enqueue(db, 'x')
    await enqueue(db, 'x')
    const [j1, j2] = await Promise.all([claimNext(db, 'w1'), claimNext(db, 'w2')])
    expect(j1).not.toBeNull()
    expect(j2).not.toBeNull()
    expect(j1!.id).not.toBe(j2!.id)
    expect(await claimNext(db, 'w3')).toBeNull()
  })

  it('błąd: ponowienie z opóźnieniem, po maxAttempts FAILED z treścią błędu', async () => {
    const id = await enqueue(db, 'x', null, { maxAttempts: 2 })
    const j1 = (await claimNext(db, 'w'))!
    expect(await fail(db, j1, new Error('pierwszy'))).toBe('RETRY')
    expect(await claimNext(db, 'w')).toBeNull() // runAfter w przyszłości
    await db.job.update({ where: { id: id! }, data: { runAfter: new Date(Date.now() - 1000) } })
    const j2 = (await claimNext(db, 'w'))!
    expect(j2.attempts).toBe(2)
    expect(await fail(db, j2, new Error('drugi'))).toBe('FAILED')
    const row = await db.job.findUniqueOrThrow({ where: { id: id! } })
    expect(row).toMatchObject({ status: 'FAILED', lastError: 'drugi' })
    expect(backoffMs(1)).toBe(30_000)
    expect(backoffMs(20)).toBe(60 * 60_000)
  })

  it('release: zadanie wraca bez zużycia próby i bez blokady, do ponownego wzięcia dopiero po terminie (P4)', async () => {
    const id = await enqueue(db, 'x', null, { maxAttempts: 1 })
    const job = (await claimNext(db, 'w'))!
    const t0 = Date.now()
    await release(db, job, 60_000)
    const row = await db.job.findUniqueOrThrow({ where: { id: id! } })
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0, lockedBy: null, lockedAt: null })
    expect(Math.abs(row.runAfter.getTime() - (t0 + 60_000))).toBeLessThan(5_000)
    expect(await claimNext(db, 'w')).toBeNull() // przed terminem nikt go nie bierze
    await db.job.update({ where: { id: id! }, data: { runAfter: new Date(Date.now() - 1000) } })
    expect((await claimNext(db, 'w'))!).toMatchObject({ id, attempts: 1 }) // maxAttempts 1 nadal do wykorzystania
  })

  it('porzucone RUNNING wracają do kolejki', async () => {
    const id = await enqueue(db, 'x')
    await claimNext(db, 'martwy')
    await db.job.update({ where: { id: id! }, data: { lockedAt: new Date(Date.now() - 2 * 3600_000) } })
    expect(await reapStale(db, 3600_000)).toBe(1)
    // wraca z opóźnieniem jak po błędzie (backoffMs), nie od razu
    expect(await claimNext(db, 'zywy')).toBeNull()
    await db.job.update({ where: { id: id! }, data: { runAfter: new Date(Date.now() - 1000) } })
    expect((await claimNext(db, 'zywy'))!.id).toBe(id)
  })

  // zdjęcia i packshoty za zadaniami pilnymi, ale bez głodzenia.
  describe('priorytet: zadania w tle (zdjęcia, feed, packshot) za pilnymi', () => {
    const minus = (ms: number) => new Date(Date.now() - ms)

    it('lista rodzajów tła zgadza się ze stałymi modułów zdjęć', () => {
      expect([...RODZAJE_TLA].sort()).toEqual([FEED_JOB, PACKSHOT_JOB, ZDJECIA_Z_OFERTY_JOB, OFERTY_MASOWO_JOB].sort())
    })

    it('dojrzałe zdjęcia z wcześniejszym runAfter, faktura dodana później → najpierw faktura, potem WZ i mail, dopiero potem zdjęcia', async () => {
      const zdjecia: string[] = []
      for (let i = 0; i < 5; i++) zdjecia.push((await enqueue(db, ZDJECIA_Z_OFERTY_JOB, { productId: `p${i}` }, { runAfter: minus(600_000 - i * 5_000) }))!)
      const feed = (await enqueue(db, FEED_JOB, null, { runAfter: minus(700_000) }))!
      const packshot = (await enqueue(db, PACKSHOT_JOB, null, { runAfter: minus(800_000) }))!
      const faktura = (await enqueue(db, INVOICES_JOB, null, { runAfter: minus(3_000) }))!
      const wz = (await enqueue(db, WZ_JOB, null, { runAfter: minus(2_000) }))!
      const mail = (await enqueue(db, ZADANIE_WYSYLKI, null, { runAfter: minus(1_000) }))!

      const kolejnosc: string[] = []
      for (let job = await claimNext(db, 'w'); job; job = await claimNext(db, 'w')) {
        kolejnosc.push(job.id)
        await complete(db, job.id)
      }
      // pilne (runAfter kilka sekund temu, czyli później niż każde zdjęcie) w kolejności runAfter, tło w kolejności runAfter (packshot, feed, zdjęcia po kolei)
      expect(kolejnosc).toEqual([faktura, wz, mail, packshot, feed, ...zdjecia])
    })

    it('zdjęcia nie głodzą się: gdy pilne nie dojrzały (runAfter w przyszłości), worker bierze zdjęcie; pilne po dojrzeniu idzie przed resztą zdjęć', async () => {
      const z1 = (await enqueue(db, ZDJECIA_Z_OFERTY_JOB, { productId: 'a' }, { runAfter: minus(60_000) }))!
      const z2 = (await enqueue(db, ZDJECIA_Z_OFERTY_JOB, { productId: 'b' }, { runAfter: minus(50_000) }))!
      const faktura = (await enqueue(db, INVOICES_JOB, null, { runAfter: new Date(Date.now() + 60_000) }))!
      const j1 = (await claimNext(db, 'w'))!
      expect(j1.id).toBe(z1) // pilne jeszcze nie dojrzało: nic pilnego nie czeka, zdjęcie ma swoją kolej
      await complete(db, j1.id)
      await db.job.update({ where: { id: faktura }, data: { runAfter: minus(1_000) } })
      expect((await claimNext(db, 'w'))!.id).toBe(faktura)
      await complete(db, faktura)
      expect((await claimNext(db, 'w'))!.id).toBe(z2)
    })

    it('dwa workery naraz: jeden bierze pilne, drugi najstarsze zadanie tła; trzeci dostaje kolejne zdjęcie', async () => {
      const z = (await enqueue(db, PACKSHOT_JOB, null, { runAfter: minus(120_000) }))!
      const z2 = (await enqueue(db, ZDJECIA_Z_OFERTY_JOB, { productId: 'c' }, { runAfter: minus(110_000) }))!
      const mail = (await enqueue(db, ZADANIE_WYSYLKI, null, { runAfter: minus(1_000) }))!
      const [a, b] = await Promise.all([claimNext(db, 'w1'), claimNext(db, 'w2')])
      expect(new Set([a!.id, b!.id])).toEqual(new Set([mail, z]))
      expect(await claimNext(db, 'w3')).toMatchObject({ id: z2 })
    })
  })
})
