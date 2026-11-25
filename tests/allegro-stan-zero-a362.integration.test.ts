// host zapisu stanów + adapter `allegro.zapis.v1` na atrapie HTTP Allegro (tests/allegro-zapis-atrapa.ts):
// stan 0 kończy aktywną ofertę (znacznik na powiązaniu oferty i wpis w dzienniku), stan 0 na zakończonej = nic, stan
// dodatni wznawia tylko ofertę zakończoną przez Kompletor, oferta zakończona przez kogoś innego zostaje (wpis), dobowy
// bezpiecznik zakończeń (alert, job odstawiony bez ponowień), „Wyślij stany ponownie” nie gubi znacznika.
// Dane fikcyjne, zero połączeń z prawdziwym Allegro.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ALLEGRO_SECRETS as S } from '@/lib/adaptery/allegro'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { writeAccountSecrets } from '@/lib/adaptery/rotacja-sekretow'
import { adapterStanowKonta, ekranZapisu, wyslijStanyKonta, wyslijStanyPonownie } from '@/lib/kanaly/zapis-host'
import { ENCJA_DZIENNIKA } from '@/lib/kanaly/stan-zerowy-host'
import { PARKED_MS, type PushItem } from '@/lib/rdzen/propagacja'
import { setSecret } from '@/lib/sekrety'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, UA } from './allegro-zapis-atrapa'
import { testDb, truncateAll } from './db'
import { product, seedBase } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const T = new Date('2026-11-20T21:00:00.000Z')
const at = (min: number) => new Date(T.getTime() + min * 60_000)
const ENV = { APP_ENCRYPTION_KEY: '0'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const ACC = { channel: 'ALLEGRO' as const, channelAccountId: '71045' }

let fake: FakeAllegroZapis
let pid: string
const ctx = (now: Date) => ({ registry: defaultRegistry(), secrets: SRC, fetch: fake.fetch, now, http: { pollDelayMs: 0, minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 0 } } })

async function konto(config: Record<string, unknown> = {}) {
  await db.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { active: false } })
  await db.channelConfig.create({
    data: { ...ACC, name: 'Allegro', adapterKey: 'allegro.zapis.v1', stockMode: 'PRACA', config: { apiUrl: API, authUrl: AUTH, userAgent: UA, zapisWlaczony: true, ...config } },
  })
  await setSecret(db, S.clientId, FAKE_CLIENT_ID, ENV, ACC)
  await setSecret(db, S.clientSecret, FAKE_CLIENT_SECRET, ENV, ACC)
  const pair = fake.base.issuePair()
  await writeAccountSecrets(db, ACC, { [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: at(600).toISOString() }, ENV)
}

async function oferta(externalId: string, extra: { endedByZeroStockAt?: Date; lastPushedQty?: number } = {}) {
  return db.channelOffer.create({ data: { ...ACC, externalId, productId: pid, qtyBasePerOffer: 1, ...extra } })
}

async function push(items: { offerId: string; externalId: string; qty: number }[], now = T) {
  const a = await adapterStanowKonta(db, ACC, ctx(now))
  if (!a || 'zablokowane' in a) throw new Error(`konto zablokowane: ${a && 'zablokowane' in a ? a.zablokowane : 'cień'}`)
  return a.push(items.map((i): PushItem => ({ offerId: i.offerId, externalId: i.externalId, channelAccountId: ACC.channelAccountId, targetQty: i.qty })))
}

const dziennik = async () => (await db.auditLog.findMany({ where: { entity: ENCJA_DZIENNIKA }, orderBy: { createdAt: 'asc' } })).map((r) => [(r.after as Record<string, unknown>)['oferta'], (r.after as Record<string, unknown>)['akcja']])

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  fake = new FakeAllegroZapis()
  fake.base.clock = () => T.getTime()
  pid = await product(db, 'P-A362', 0)
})

describe('stan 0 na Allegro przez host', () => {
  it('0 na aktywnej → zakończona: znacznik na powiązaniu, wpis w dzienniku, ekran konta bez błędu', async () => {
    await konto()
    fake.putOffer('5001', 'ACTIVE', 241)
    const o = await oferta('5001')
    const r = await push([{ offerId: o.id, externalId: '5001', qty: 0 }])
    expect(r).toEqual([{ offerId: o.id, ok: true }])
    expect(fake.publicationOf('5001')).toBe('ENDED')
    expect((await db.channelOffer.findUniqueOrThrow({ where: { id: o.id } })).endedByZeroStockAt).toEqual(T)
    expect(await dziennik()).toEqual([['5001', 'zakonczona']])
    const e = await ekranZapisu(db, defaultRegistry(), ACC, T)
    expect(e?.stanZerowy).toMatchObject({ limit: 100, zakonczone24h: 1, zakonczoneTeraz: 1 })
    expect(e?.stanZerowy?.wpisy[0]).toMatchObject({ oferta: '5001', opis: 'oferta zakończona: stan 0' })
    expect(e?.stany.bledy).toEqual([])
  })

  it('0 na zakończonej → nic (bez zapisu w Allegro, bez wpisu); >0 na zakończonej przez nas → wznowiona, znacznik skasowany', async () => {
    await konto()
    fake.putOffer('5002', 'ENDED', 0, at(-1).toISOString())
    const o = await oferta('5002', { endedByZeroStockAt: at(-1) })
    expect(await push([{ offerId: o.id, externalId: '5002', qty: 0 }])).toEqual([{ offerId: o.id, ok: true }])
    expect(fake.writes()).toEqual([])
    expect(await dziennik()).toEqual([])
    const r = await push([{ offerId: o.id, externalId: '5002', qty: 6 }], at(30))
    expect(r).toEqual([{ offerId: o.id, ok: true }])
    expect(fake.publicationOf('5002')).toBe('ACTIVE')
    expect(fake.stock.get('5002')).toBe(6)
    expect((await db.channelOffer.findUniqueOrThrow({ where: { id: o.id } })).endedByZeroStockAt).toBeNull()
    expect(await dziennik()).toEqual([['5002', 'wznowiona']])
  })

  it('>0 na ofercie zakończonej przez kogoś innego (bez znacznika) → bez wznowienia; ze znacznikiem, ale zakończonej później → wpis, bez wznowienia', async () => {
    await konto()
    fake.putOffer('5003', 'ENDED', 0, at(-5).toISOString())
    fake.putOffer('5004', 'ENDED', 0, at(-5).toISOString())
    const a = await oferta('5003')
    const b = await oferta('5004', { endedByZeroStockAt: at(-300) })
    const r = await push([
      { offerId: a.id, externalId: '5003', qty: 4 },
      { offerId: b.id, externalId: '5004', qty: 4 },
    ])
    expect(r.every((x) => x.ok)).toBe(true)
    expect(fake.pubActions('ACTIVATE')).toEqual([])
    expect(fake.publicationOf('5003')).toBe('ENDED')
    expect(fake.publicationOf('5004')).toBe('ENDED')
    expect(await dziennik()).toEqual([['5004', 'zakonczona-poza']])
  })

  it('„Wyślij stany ponownie” kasuje rejestr, ale nie znacznik zakończenia', async () => {
    await konto()
    fake.putOffer('5005', 'ACTIVE', 3)
    const o = await oferta('5005')
    await push([{ offerId: o.id, externalId: '5005', qty: 0 }])
    await wyslijStanyPonownie(db, ACC, { now: at(1), actorId: 'u-test' })
    expect((await db.channelOffer.findUniqueOrThrow({ where: { id: o.id } })).endedByZeroStockAt).toEqual(T)
  })

  it('bezpiecznik: po limicie zakończeń w 24 h oferta zostaje aktywna, job odstawiony bez ponowień, alert', async () => {
    await konto({ limitZakonczenDoba: 1 })
    fake.putOffer('5006', 'ACTIVE', 9)
    fake.putOffer('5007', 'ACTIVE', 9)
    const a = await oferta('5006', { lastPushedQty: 9 })
    const b = await oferta('5007', { lastPushedQty: 9 })
    for (const o of [a, b]) await db.stockSyncJob.create({ data: { offerId: o.id, ...ACC, targetQty: 0, sourceVersion: 1, computedAt: T, firstChangeAt: T, nextAttemptAt: T } })
    await wyslijStanyKonta(db, ACC, ctx(T))
    expect(fake.pubActions('END')).toEqual(['5006'])
    expect(fake.publicationOf('5007')).toBe('ACTIVE')
    const job = await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: b.id } })
    expect(job.nextAttemptAt.getTime()).toBe(T.getTime() + PARKED_MS)
    expect(job.lastError).toContain('dobowy limit zakończeń')
    expect(await db.stockSyncJob.count({ where: { offerId: a.id } })).toBe(0)
    const kinds = (await db.alert.findMany()).map((x) => x.kind).sort()
    expect(kinds).toEqual(['KANAL_LIMIT_ZAKONCZEN', 'KANAL_STAN_BLAD'])
    expect(await dziennik()).toEqual([['5006', 'zakonczona']])
  })

  it('odmowa Allegro przy zakończeniu: błąd z treścią, job odstawiony (jedna próba), bez znacznika', async () => {
    await konto()
    fake.putOffer('5008', 'ACTIVE', 9)
    fake.rejectPublication.add('5008')
    const o = await oferta('5008', { lastPushedQty: 9 })
    await db.stockSyncJob.create({ data: { offerId: o.id, ...ACC, targetQty: 0, sourceVersion: 1, computedAt: T, firstChangeAt: T, nextAttemptAt: T } })
    await wyslijStanyKonta(db, ACC, ctx(T))
    const job = await db.stockSyncJob.findUniqueOrThrow({ where: { offerId: o.id } })
    expect(job).toMatchObject({ attempts: 1 })
    expect(job.lastError).toContain('Allegro nie zakończyło oferty')
    expect(job.nextAttemptAt.getTime()).toBe(T.getTime() + PARKED_MS)
    expect((await db.channelOffer.findUniqueOrThrow({ where: { id: o.id } })).endedByZeroStockAt).toBeNull()
    // kolejny przebieg nie ponawia (job odstawiony)
    await wyslijStanyKonta(db, ACC, ctx(at(10)))
    expect(fake.pubCommands.size).toBe(1)
  })
})
