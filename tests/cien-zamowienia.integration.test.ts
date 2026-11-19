// Cień zamówień na bazie: odczyt konta przez fałszywy adapter → kopia → rdzeń (rezerwacje) → kursor;
// fail-safe per element, ponowienia, awaria listy, zła konfiguracja, planowanie per konto, porównanie z BL.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { accountInputs, createAccountAdapter, loadChannelAccounts } from '@/lib/adaptery/konta'
import type { AdapterDefinition } from '@/lib/adaptery/kontrakt'
import { handlers } from '@/lib/worker/zadania'
import { resolveSecrets } from '@/lib/sekrety'
import { WOO_DEFINITION } from '@/lib/adaptery/woo'
import { setSecret } from '@/lib/sekrety'
import { AdapterError } from '@/lib/adaptery/kontrakt'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterConfigError, AdapterRegistry } from '@/lib/adaptery/rejestr'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { runBlComparison } from '@/lib/cien/bl-porownanie'
import { accountsForComparison, planOrderPolls, POLL_JOB } from '@/lib/cien/harmonogram'
import { shadowMetrics } from '@/lib/cien/metryki'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { BaseLinkerReadOnly } from '@/lib/zrodla/baselinker'
import type { FetchLike } from '@/lib/zrodla/http'
import { ORG_B, testDb, truncateAll } from './db'
import { expectInvariants, offer, product, seedBase, stockOf } from './rdzen-fixtures'

// W-A: `ingestOrder` przepuszczany bez zmian; test może raz wstrzyknąć błąd przejściowy (np. zerwane połączenie z bazą)
const ingestFault = vi.hoisted(() => ({ failNext: 0 }))
vi.mock('@/lib/rdzen/zamowienia', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/rdzen/zamowienia')>()
  return {
    ...orig,
    ingestOrder: async (...args: Parameters<typeof orig.ingestOrder>) => {
      if (ingestFault.failNext > 0) {
        ingestFault.failNext--
        throw new Error('połączenie z bazą zerwane (test)')
      }
      return orig.ingestOrder(...args)
    },
  }
})

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const T = new Date('2026-10-25T10:00:00.000Z')
const SRC = { env: {}, envFallback: false }
const min = (n: number) => new Date(T.getTime() + n * 60_000)

async function sd(d: PrismaClient = db) {
  await d.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: d === db ? 'test_a' : ORG_B, channel: 'WOO', channelAccountId: 'sd' } }, data: { adapterKey: 'fake.v1' } })
  return (await loadChannelAccounts(d)).find((a) => a.channel === 'WOO' && a.channelAccountId === 'sd')!
}

let state: FakeChannelState
let registry: AdapterRegistry
let a: string

beforeEach(async () => {
  ingestFault.failNext = 0
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
  a = await product(db, 'A', 5)
  await offer(db, 'WOO_SD', '10', a)
})

const line = (offerId: string, qty: number) => [{ externalLineId: '1', offerExternalId: offerId, qty, unitPriceGross: 10, vatRate: null }]

describe('odczyt konta → rdzeń', () => {
  it('otwarte rezerwuje, anulowane i szkic nie, zrealizowane widziane pierwszy raz nie rezerwuje; kursor i odczyt OK', async () => {
    state.upsertOrder(fakeOrder({ externalId: '1', createdAt: min(-30), lines: line('10', 2) }))
    state.upsertOrder(fakeOrder({ externalId: '2', lifecycle: 'CANCELLED', lines: line('10', 1) }))
    state.upsertOrder(fakeOrder({ externalId: '3', lifecycle: 'FULFILLED', lines: line('10', 1) }))
    state.upsertOrder(fakeOrder({ externalId: '4', lifecycle: 'DRAFT', lines: line('10', 1) }))
    const acc = await sd()
    const s = await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })
    expect(s).toMatchObject({ pages: 2, items: 4, nowe: 2, pominiete: 2, bledyTrwale: 0, doPonowienia: 0 })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2, available: 3 })
    const snaps = await db.channelOrderSnapshot.findMany({ orderBy: { externalId: 'asc' } })
    expect(snaps.map((x) => [x.externalId, x.ingestOutcome, x.skipReason])).toEqual([
      ['1', 'NOWE', null],
      ['2', 'NOWE', null],
      ['3', null, 'zrealizowane-przed-pierwszym-odczytem'],
      ['4', null, 'szkic'],
    ])
    const o2 = await db.order.findFirstOrThrow({ where: { externalId: '2' } })
    expect(o2.status).toBe('ANULOWANE')
    const cur = await db.channelCursor.findFirstOrThrow()
    expect(cur).toMatchObject({ adapterKey: 'fake.v1', cursor: '4', lastError: null, failingSince: null })
    expect(cur.firstPollAt?.toISOString()).toBe(T.toISOString())
    const polls = await db.channelOrderPoll.findMany()
    expect(polls).toHaveLength(1)
    expect(polls[0]!.ok).toBe(true)
    await expectInvariants(db)
  })

  it('powtórny odczyt bez zmian = BEZ_ZMIAN; nowa rewizja (anulowanie) zwalnia rezerwację', async () => {
    state.upsertOrder(fakeOrder({ externalId: '1', lines: line('10', 2) }))
    const acc = await sd()
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })
    const again = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    expect(again).toMatchObject({ items: 0, nowe: 0 })
    state.upsertOrder(fakeOrder({ externalId: '1', revision: '2026-10-25T10:05:00.000Z', lifecycle: 'CANCELLED', lines: line('10', 2) }))
    const s = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(2) })
    expect(s.zmiany).toBe(1)
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0, available: 5 })
    // ta sama rewizja przeczytana jeszcze raz (zakładka kursora) → BEZ_ZMIAN, bez skutków
    await db.channelCursor.updateMany({ data: { cursor: '0' } })
    const s2 = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(3) })
    expect(s2).toMatchObject({ bezZmian: 1, zmiany: 0 })
    await expectInvariants(db)
  })

  it('nieczytelne zamówienie: alert i błąd w kopii, reszta przechodzi; przejściowy błąd getOrder → ponowienie w następnym odczycie', async () => {
    state.upsertOrder(fakeOrder({ externalId: '1', lines: line('10', 1) }))
    state.upsertOrder(fakeOrder({ externalId: '2', lines: line('10', 1) }))
    state.upsertOrder(fakeOrder({ externalId: '3', lines: line('10', 1) }))
    state.corrupted.add('2')
    const acc = await sd()
    const s1 = await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })
    expect(s1).toMatchObject({ nowe: 2, bledyTrwale: 1, doPonowienia: 0 })
    // odczyt z nieczytelnym zamówieniem nie jest „OK” (nie znamy wszystkich zamówień → wzrosty stanu stoją)
    const p1 = await db.channelOrderPoll.findFirstOrThrow({ orderBy: { startedAt: 'desc' } })
    expect(p1.ok).toBe(false)
    expect(p1.error).toContain('1 zamówień nieczytelnych')
    expect((await db.channelCursor.findFirstOrThrow()).lastOkAt).toBeNull()
    const al = await db.alert.findMany({ where: { kind: 'ZAMOWIENIE_KANALU_BLAD' } })
    expect(al).toHaveLength(1)
    expect(al[0]!.ref).toBe('WOO/sd/2')

    // przejściowy: lista daje „9” bez treści, getOrder pada przejściowo → lista ponowień; odczyt nie jest „OK”
    state.corrupted.clear()
    state.upsertOrder(fakeOrder({ externalId: '9', lines: line('10', 1) }))
    state.corrupted.add('9')
    state.getFailures.push(new AdapterError('503', 'PRZEJSCIOWY'))
    const s2 = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    expect(s2).toMatchObject({ doPonowienia: 1, bledyTrwale: 0 })
    const cur = await db.channelCursor.findFirstOrThrow()
    expect(cur.retryIds).toEqual([{ id: '9', attempts: 0 }])
    expect((await db.channelOrderPoll.findMany({ orderBy: { startedAt: 'desc' } }))[0]!.ok).toBe(false)
    state.corrupted.delete('9')
    const s3 = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(2) })
    expect(s3).toMatchObject({ ponowione: 1, doPonowienia: 0 })
    expect(await db.order.count({ where: { externalId: '9' } })).toBe(1)
    await expectInvariants(db)
  })

  it('awaria listy: wyjątek, kursor bez zmian, odczyt nieudany; po 15 min alert kanału', async () => {
    state.upsertOrder(fakeOrder({ externalId: '1', lines: line('10', 1) }))
    const acc = await sd()
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })
    const before = await db.channelCursor.findFirstOrThrow()
    state.listFailures.push(new AdapterError('503', 'PRZEJSCIOWY'))
    await expect(pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })).rejects.toThrow('503')
    let cur = await db.channelCursor.findFirstOrThrow()
    expect(cur.cursor).toBe(before.cursor)
    expect(cur.failingSince?.toISOString()).toBe(min(1).toISOString())
    expect(await db.alert.count({ where: { kind: 'KANAL_ZAMOWIENIA_NIEDOSTEPNY' } })).toBe(0)
    state.listFailures.push(new AdapterError('503', 'PRZEJSCIOWY'))
    await expect(pollAccount(db, acc, { registry, secrets: SRC, now: () => min(17) })).rejects.toThrow()
    expect(await db.alert.count({ where: { kind: 'KANAL_ZAMOWIENIA_NIEDOSTEPNY' } })).toBe(1)
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(20) })
    cur = await db.channelCursor.findFirstOrThrow()
    expect(cur.failingSince).toBeNull()
    expect(cur.lastError).toBeNull()
  })

  it('zła konfiguracja konta (Woo bez kluczy) → AdapterConfigError, zapisana w kursorze bez wartości sekretów', async () => {
    const acc = (await loadChannelAccounts(db)).find((x) => x.channelAccountId === 'lampy')!
    expect(acc.adapterKey).toBe('woo.rest.v1') // domyślny adapter rodziny WOO
    await expect(pollAccount(db, acc, { registry: defaultRegistry(), secrets: SRC, now: () => T })).rejects.toBeInstanceOf(AdapterConfigError)
    const cur = await db.channelCursor.findFirstOrThrow({ where: { channelAccountId: 'lampy' } })
    expect(cur.lastError).toMatch(/^konfiguracja: .*baseUrl.*WOO_CONSUMER_KEY/)
  })

  it('sekrety konta z bazy (per sklep): dwa sklepy Woo mają osobne klucze; env bez przedrostka nie wchodzi', async () => {
    const env = { APP_ENCRYPTION_KEY: '0'.repeat(64), WOO_CONSUMER_KEY: 'z-env-bez-konta' }
    await setSecret(db, 'WOO_CONSUMER_KEY', 'klucz-sd', env, { channel: 'WOO', channelAccountId: 'sd' })
    await setSecret(db, 'WOO_CONSUMER_KEY', 'klucz-lampy', env, { channel: 'WOO', channelAccountId: 'lampy' })
    const accs = await loadChannelAccounts(db)
    const src = { env, envFallback: true }
    const k = await accountInputs(db, accs.find((x) => x.channelAccountId === 'sd')!, WOO_DEFINITION.manifest, src)
    const b = await accountInputs(db, accs.find((x) => x.channelAccountId === 'lampy')!, WOO_DEFINITION.manifest, src)
    expect(k.rawSecrets).toEqual({ WOO_CONSUMER_KEY: 'klucz-sd' })
    expect(b.rawSecrets).toEqual({ WOO_CONSUMER_KEY: 'klucz-lampy' })
    const km = await accountInputs(db, accs.find((x) => x.channelAccountId === 'km')!, WOO_DEFINITION.manifest, src)
    expect(km.rawSecrets).toEqual({})
  })

  it('dwie firmy: to samo konto i numer zamówienia rezerwuje tylko własny stan', async () => {
    await seedBase(dbB)
    const b = await product(dbB, 'A', 1)
    await offer(dbB, 'WOO_SD', '10', b)
    state.upsertOrder(fakeOrder({ externalId: '1', lines: line('10', 1) }))
    await pollAccount(db, await sd(db), { registry, secrets: SRC, now: () => T })
    await pollAccount(dbB, await sd(dbB), { registry, secrets: SRC, now: () => T })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 1 })
    expect(await stockOf(dbB, b)).toMatchObject({ reserved: 1, available: 0 })
    expect(await db.channelOrderSnapshot.count()).toBe(1)
    expect(await dbB.channelOrderSnapshot.count()).toBe(1)
  })
})

describe('planowanie i metryki', () => {
  it('planowanie: zadanie na konto z adapterem odczytu, bez dubli, odstęp konta; konta bez adaptera pominięte', async () => {
    await sd()
    const r1 = await planOrderPolls(db, registry, T)
    expect(r1.planned).toBe(1) // WOO/sd (fake); pozostałe konta: brak adaptera w tym rejestrze
    expect(r1.withoutAdapter.length).toBe(5)
    expect((await planOrderPolls(db, registry, T)).planned).toBe(0) // dedupe: zadanie już czeka
    const jobs = await db.job.findMany({ where: { kind: POLL_JOB } })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.payload).toEqual({ channel: 'WOO', channelAccountId: 'sd' })
    await db.job.deleteMany({})
    await pollAccount(db, await sd(), { registry, secrets: SRC, now: () => T })
    expect((await planOrderPolls(db, registry, new Date(T.getTime() + 30_000))).notDue).toBe(1)
    expect((await planOrderPolls(db, registry, new Date(T.getTime() + 61_000))).planned).toBe(1)
  })

  it('metryki: opóźnienie tylko dla zamówień po pierwszym odczycie, p95, odstępy odczytów', async () => {
    const acc = await sd()
    state.upsertOrder(fakeOrder({ externalId: 'stare', createdAt: min(-600), lines: line('10', 1) }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })
    state.upsertOrder(fakeOrder({ externalId: 'n1', createdAt: min(0.5), revision: '2026-10-25T10:00:30.000Z', lines: line('10', 1) }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    state.upsertOrder(fakeOrder({ externalId: 'n2', createdAt: min(1.5), revision: '2026-10-25T10:01:30.000Z', lines: line('10', 1) }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(2) })
    const [m] = await shadowMetrics(db, { until: min(3) })
    expect(m).toMatchObject({ channel: 'WOO', channelAccountId: 'sd', snapshots: 3, ingested: 3, liveOrders: 2 })
    expect(m!.latencyMs).toEqual({ p50: 30_000, p95: 30_000, max: 30_000 })
    expect(m!.polls).toMatchObject({ ok: 3, failed: 0, gapP95Ms: 60_000, gapMaxMs: 60_000 })
  })
})

describe('porównanie z BL (getOrders w pamięci)', () => {
  it('pary dostają numer BL (kopia i zamówienie), nagłówki BL bez danych klienta, braki w obie strony', async () => {
    const acc = await sd()
    const now = new Date('2026-10-25T12:00:00.000Z')
    state.upsertOrder(fakeOrder({ externalId: '501', createdAt: new Date('2026-10-25T09:00:00Z'), lines: line('10', 1) }))
    state.upsertOrder(fakeOrder({ externalId: '502', createdAt: new Date('2026-10-25T09:30:00Z'), lines: line('10', 1) }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => new Date('2026-10-25T08:00:00Z'), initialLookbackMs: 3600_000 })
    const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    const blOrders = [
      { order_id: 7001, order_source: 'shop', order_source_id: 'sd', shop_order_id: 501, order_status_id: 356153, date_add: sec('2026-10-25T09:05:00Z'), date_confirmed: sec('2026-10-25T09:05:00Z'), email: 'jan.testowy@example.invalid', delivery_fullname: 'Jan Testowy' },
      { order_id: 7002, order_source: 'shop', order_source_id: 'sd', shop_order_id: 999, order_status_id: 327649, date_add: sec('2026-10-25T10:00:00Z'), date_confirmed: sec('2026-10-25T10:00:00Z'), phone: '600100200' },
    ]
    const calls: string[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = new URLSearchParams(String(init?.body))
      const method = body.get('method')!
      calls.push(method)
      if (method === 'getOrderStatusList') return new Response(JSON.stringify({ status: 'SUCCESS', statuses: [{ id: 356153, name: 'Do realizacji Paczkomaty' }, { id: 327649, name: 'Nowe zamówienia' }] }))
      return new Response(JSON.stringify({ status: 'SUCCESS', orders: blOrders }))
    }
    const bl = new BaseLinkerReadOnly('token-test', fetchImpl, 0)
    const r = await runBlComparison(db, bl, { shopAccounts: ['sd'], empikAccountId: null }, await accountsForComparison(db), { now, windowMs: 4 * 3600_000 })
    expect(calls).toEqual(['getOrderStatusList', 'getOrders', 'getJournalList']) // dziennik BL po kopiach
    const k = r.accounts.find((x) => x.channel === 'WOO' && x.channelAccountId === 'sd')!
    expect(k).toMatchObject({ paired: 1, missingInBl: 1, missingHere: 1 })
    expect(k.verdicts.ZGODNE).toBe(1)
    const o = await db.order.findFirstOrThrow({ where: { externalId: '501' } })
    expect(o.blOrderId).toBe(7001)
    const s = await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: '501' } })
    expect(s).toMatchObject({ blOrderId: 7001, blStatusId: 356153 })
    const copies = await db.blOrderSnapshot.findMany()
    expect(copies).toHaveLength(2)
    expect(JSON.stringify(copies)).not.toMatch(/Testow|600100200|example\.invalid/)
  })
})

describe('poprawki po przeglądzie', () => {
  it('ta sama rewizja (ta sama sekunda), pending → processing: płatność wchodzi do rdzenia', async () => {
    const rev = '2026-10-25T10:00:00.000Z'
    state.upsertOrder(fakeOrder({ externalId: '1', revision: rev, channelStatus: 'pending', statusRank: 10, paymentState: 'UNPAID', lines: line('10', 1) }))
    const acc = await sd()
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })
    expect((await db.order.findFirstOrThrow({ where: { externalId: '1' } })).status).toBe('NOWE')
    state.upsertOrder(fakeOrder({ externalId: '1', revision: rev, channelStatus: 'processing', statusRank: 20, paymentState: 'PAID', lines: line('10', 1) }))
    const s = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    expect(s.zmiany).toBe(1)
    const o = await db.order.findFirstOrThrow({ where: { externalId: '1' } })
    expect(o).toMatchObject({ status: 'DO_REALIZACJI', paymentState: 'PAID' })
    // i ponownie ta sama treść → bez zmian
    await db.channelCursor.updateMany({ data: { cursor: '0' } })
    expect((await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(2) })).bezZmian).toBe(1)
    await expectInvariants(db)
  })

  it('odczyt ucięty limitem stron nie jest OK, konto nie ma pokrycia do porównania; pełny odczyt — jest', async () => {
    for (let i = 1; i <= 5; i++) state.upsertOrder(fakeOrder({ externalId: String(i), lines: line('10', 1) }))
    const acc = await sd()
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => T, maxPages: 1 })
    let p = await db.channelOrderPoll.findFirstOrThrow({ orderBy: { startedAt: 'desc' } })
    expect(p.ok).toBe(false)
    expect(p.error).toMatch(/ucięty po 1 stronach/)
    let cur = await db.channelCursor.findFirstOrThrow()
    expect(cur.lastOkAt).toBeNull()
    expect((await accountsForComparison(db)).find((a) => a.channelAccountId === 'sd')!.coverageFrom).toBeNull()
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    p = await db.channelOrderPoll.findFirstOrThrow({ orderBy: { startedAt: 'desc' } })
    expect(p.ok).toBe(true)
    cur = await db.channelCursor.findFirstOrThrow()
    expect(cur.lastOkAt?.toISOString()).toBe(min(1).toISOString())
    expect((await accountsForComparison(db)).find((a) => a.channelAccountId === 'sd')!.coverageFrom).not.toBeNull()
    expect(await db.order.count()).toBe(5)
  })

  it('zamówienie w rdzeniu cofnięte w kanale do szkicu/kosza → anulowane, rezerwacja zwolniona, alert', async () => {
    state.upsertOrder(fakeOrder({ externalId: '1', lines: line('10', 2) }))
    const acc = await sd()
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })
    expect((await stockOf(db, a)).reserved).toBe(2)
    state.upsertOrder(fakeOrder({ externalId: '1', revision: '2026-10-25T10:10:00.000Z', lifecycle: 'DRAFT', channelStatus: 'trash', statusRank: null, lines: line('10', 2) }))
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    expect((await db.order.findFirstOrThrow({ where: { externalId: '1' } })).status).toBe('ANULOWANE')
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await db.alert.count({ where: { kind: 'ZAMOWIENIE_COFNIETE_W_KANALE' } })).toBe(1)
    const snap = await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: '1' } })
    expect(snap.warnings.join(' ')).toContain('cofnięte w kanale')
    await expectInvariants(db)
  })

  it('W-A: szkic → otwarte z jednorazowym błędem przejściowym przyjęcia → kolejny odczyt przyjmuje (NOWE, nie BEZ_ZMIAN)', async () => {
    state.upsertOrder(fakeOrder({ externalId: '1', lifecycle: 'DRAFT', channelStatus: 'checkout-draft', statusRank: null, lines: line('10', 2) }))
    const acc = await sd()
    expect((await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })).pominiete).toBe(1)
    expect((await db.channelOrderSnapshot.findFirstOrThrow()).skipReason).toBe('szkic')
    state.upsertOrder(fakeOrder({ externalId: '1', revision: '2026-10-25T10:05:00.000Z', lines: line('10', 2) }))
    ingestFault.failNext = 1
    const s2 = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    expect(s2).toMatchObject({ nowe: 0, doPonowienia: 1 })
    const snap2 = await db.channelOrderSnapshot.findFirstOrThrow()
    expect(snap2).toMatchObject({ revision: '2026-10-25T10:05:00.000Z', skipReason: null, ingestedRevision: null })
    expect(await db.order.count()).toBe(0)
    const s3 = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(2) })
    expect(s3).toMatchObject({ nowe: 1, bezZmian: 0, doPonowienia: 0 })
    expect(await db.order.count({ where: { externalId: '1', status: { not: 'ANULOWANE' } } })).toBe(1)
    expect((await db.channelOrderSnapshot.findFirstOrThrow()).ingestedRevision).toBe('2026-10-25T10:05:00.000Z')
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })

  it('W-B: zamówienie już WYSLANE przeniesione w kanale do kosza → status bez zmian, alert z dopiskiem po wysyłce', async () => {
    state.upsertOrder(fakeOrder({ externalId: '1', lines: line('10', 2) }))
    const acc = await sd()
    await pollAccount(db, acc, { registry, secrets: SRC, now: () => T })
    const o = await db.order.findFirstOrThrow({ where: { externalId: '1' } })
    await db.order.update({ where: { id: o.id }, data: { status: 'WYSLANE' } })
    const reservedBefore = (await stockOf(db, a)).reserved
    state.upsertOrder(fakeOrder({ externalId: '1', revision: '2026-10-25T10:10:00.000Z', lifecycle: 'DRAFT', channelStatus: 'trash', statusRank: null, lines: line('10', 2) }))
    const s = await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(1) })
    expect(s).toMatchObject({ pominiete: 1, zmiany: 0, doPonowienia: 0 })
    expect((await db.order.findFirstOrThrow({ where: { externalId: '1' } })).status).toBe('WYSLANE')
    expect((await stockOf(db, a)).reserved).toBe(reservedBefore)
    const al = await db.alert.findMany({ where: { kind: 'ZAMOWIENIE_COFNIETE_W_KANALE' } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('po wysyłce')
    const snap = await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: '1' } })
    expect(snap).toMatchObject({ skipReason: 'cofniete-po-wysylce', ingestedRevision: '2026-10-25T10:10:00.000Z' })
    expect(snap.warnings.join(' ')).toContain('rdzeń bez zmian')
    // powtórny odczyt tej samej treści → BEZ_ZMIAN, bez drugiego alertu
    await db.channelCursor.updateMany({ data: { cursor: '0' } })
    expect((await pollAccount(db, acc, { registry, secrets: SRC, now: () => min(2) })).bezZmian).toBe(1)
    expect(await db.alert.count({ where: { kind: 'ZAMOWIENIE_COFNIETE_W_KANALE' } })).toBe(1)
  })

  it('porównanie z BL bez tokena BL — ciche pominięcie (bez błędu i bez wpisu)', async () => {
    await expect(handlers['cien-bl-porownanie']!(db, null, { organizationId: 'test_a', secrets: SRC })).resolves.toBeUndefined()
    expect(await db.importRun.count({ where: { kind: 'cien-bl' } })).toBe(0)
  })

  it('adapter zapisuje odświeżony sekret konta przez host (tylko nazwy z manifestu, zakres konta)', async () => {
    const env = { APP_ENCRYPTION_KEY: '1'.repeat(64) }
    let persist: ((p: Record<string, string>) => Promise<void>) | undefined
    const base = fakeDefinition(state)
    const spy: AdapterDefinition = { manifest: base.manifest, create: (ctx) => ((persist = ctx.persistSecrets), base.create(ctx)) }
    const acc = await sd()
    await createAccountAdapter(db, new AdapterRegistry([spy]), acc, { env, envFallback: false })
    await persist!({ FAKE_TOKEN: 'odswiezony' })
    expect(await resolveSecrets(db, ['FAKE_TOKEN'], { env, envFallback: false }, { channel: 'WOO', channelAccountId: 'sd' })).toEqual({ FAKE_TOKEN: 'odswiezony' })
    expect(await resolveSecrets(db, ['FAKE_TOKEN'], { env, envFallback: false }, { channel: 'WOO', channelAccountId: 'lampy' })).toEqual({})
    await expect(persist!({ OBCY: 'x' })).rejects.toBeInstanceOf(AdapterConfigError)
  })
})
