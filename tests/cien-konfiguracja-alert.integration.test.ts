// ustawienia kont ACME przy starcie (seed uzupełnia puste klucze), alert „cień nie czyta” (błąd konfiguracji
// od razu, awaria po 15 min; raz na konto, zamykany udanym odczytem) i pole `cien` w /api/health + licznik pulpitu.
// Dane fikcyjne: konta testowe, adresy *.example, bez zamówień z danymi osobowymi.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { AdapterError } from '@/lib/adaptery/kontrakt'
import { FakeChannelState, fakeDefinition, fakeOrder } from '@/lib/adaptery/falszywy'
import { AdapterConfigError, AdapterRegistry } from '@/lib/adaptery/rejestr'
import { loadShadowReading, resetShadowHealthCache } from '@/lib/cien/stan-odczytu'
import { NOT_READING_ALERT, pollAccount } from '@/lib/cien/odczyt-zamowien'
import { POLL_JOB } from '@/lib/cien/harmonogram'
import { applyOrgPreset, loadImportConfig, type OrgPreset } from '@/lib/organizacje'
import { dashboard } from '@/lib/panel/dane'
import { handlers } from '@/lib/worker/zadania'
import { ACME_PRESET } from '@/tests/preset-testowy'
import { ACME_CHANNEL_CONFIG } from '@/tests/preset-testowy'
import { ORG_A, ORG_B, TEST_ORGS, testDb, testSystemDb, truncateAll } from './db'
import { seedBase } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const T = new Date('2026-10-26T10:00:00.000Z')
const min = (n: number) => new Date(T.getTime() + n * 60_000)
const SRC = { env: {}, envFallback: false }

describe('krok 1: seed przy starcie uzupełnia ustawienia kont ACME (tylko puste klucze)', () => {
  // konta ACME: bez config i z domyślnym adapterem rodziny
  const OLD: OrgPreset = { ...ACME_PRESET, channels: ACME_PRESET.channels!.map(({ config: _c, adapterKey: _a, ...c }) => c) }

  beforeEach(async () => {
    await truncateAll(db, [...TEST_ORGS, OLD])
  })

  it('stare konta dostają baseUrl/envPrefix, ręczna zmiana zostaje, drugi start nic nie zmienia', async () => {
    const key = (channelAccountId: string, channel: 'WOO' | 'EMPIK' = 'WOO') => ({ organizationId_channel_channelAccountId: { organizationId: 'acme', channel, channelAccountId } })
    expect((await sys.channelConfig.findUniqueOrThrow({ where: key('7100002') })).config).toEqual({})
    // SklepDemo: adres zmieniony ręcznie + hold_stock_minutes z `cien -- test`; HurtDemo: pusty adres
    await sys.channelConfig.update({ where: key('7100001'), data: { config: { baseUrl: 'https://sklep-nowa.example', holdStockMinutes: 60 } } })
    await sys.channelConfig.update({ where: key('7100002'), data: { config: { baseUrl: '' } } })

    const first = await applyOrgPreset(sys, ACME_PRESET)
    expect(first).toMatchObject({ created: false, channels: 0, channelSettings: 5 }) // 3 × Woo + Empik + Allegro
    const rows = Object.fromEntries((await sys.channelConfig.findMany({ where: { organizationId: 'acme' } })).map((r) => [r.channelAccountId, r.config]))
    expect(rows['7100001']).toEqual({ baseUrl: 'https://sklep-nowa.example', holdStockMinutes: 60, envPrefix: 'SD_WC' })
    expect(rows['7100002']).toEqual({ baseUrl: 'https://hurtdemo.pl', envPrefix: 'LAMPY_WC' })
    expect(rows['7100003']).toEqual({ envPrefix: 'KM_WC' })
    expect(rows['30193']).toEqual(ACME_CHANNEL_CONFIG.find((c) => c.channelAccountId === '30193')!.config)
    expect(rows['71045']).toEqual(ACME_CHANNEL_CONFIG.find((c) => c.channelAccountId === '71045')!.config)

    const before = await sys.channelConfig.findMany({ where: { organizationId: 'acme' }, orderBy: { channelAccountId: 'asc' } })
    const second = await applyOrgPreset(sys, ACME_PRESET)
    expect(second).toMatchObject({ channels: 0, channelSettings: 0 })
    const after = await sys.channelConfig.findMany({ where: { organizationId: 'acme' }, orderBy: { channelAccountId: 'asc' } })
    expect(after).toEqual(before) // także updatedAt: bez zapisu
  })

  it('nowa instalacja: konta zakładane od razu z ustawieniami i adapterem z seed/acme-kanaly.ts', async () => {
    await truncateAll(db)
    const s = await applyOrgPreset(sys, ACME_PRESET)
    expect(s).toMatchObject({ created: true, channels: 6, channelSettings: 0 }) // + EasyTools
    const sd = await sys.channelConfig.findFirstOrThrow({ where: { organizationId: 'acme', channelAccountId: '7100001' } })
    expect(sd).toMatchObject({ adapterKey: 'woo.rest.v1', config: { baseUrl: 'https://sklepdemo.pl', envPrefix: 'SD_WC' } })
    // KolorowyKubek (sklep do wyłączenia, 27.10.2026): konto jest, ale nieaktywne — cień go nie czyta
    const active = Object.fromEntries((await sys.channelConfig.findMany({ where: { organizationId: 'acme' } })).map((r) => [r.channelAccountId, r.active]))
    expect(active).toEqual({ '7100001': true, '7100002': true, '7100003': false, '71045': true, '30193': true, acme: true })
  })
})

describe('krok 3: alert „cień nie czyta”', () => {
  let state: FakeChannelState
  let registry: AdapterRegistry

  beforeEach(async () => {
    await truncateAll(db)
    await seedBase(db)
    state = new FakeChannelState()
    registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
  })

  const sd = async (adapterKey: string) => {
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey } })
    return (await loadChannelAccounts(db)).find((a) => a.channelAccountId === 'sd')!
  }
  const openAlerts = () => db.alert.findMany({ where: { kind: NOT_READING_ALERT, closedAt: null } })

  it('błąd konfiguracji: alert od razu, jeden na konto mimo kolejnych prób; pierwszy udany odczyt go zamyka', async () => {
    const bad = await sd('nieznany.v1')
    await expect(pollAccount(db, bad, { registry, secrets: SRC, now: () => T })).rejects.toBeInstanceOf(AdapterConfigError)
    await expect(pollAccount(db, bad, { registry, secrets: SRC, now: () => min(5) })).rejects.toBeInstanceOf(AdapterConfigError)
    const open = await openAlerts()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ ref: 'WOO/sd' })
    expect(open[0]!.message).toMatch(/cień nie czyta — błąd konfiguracji konta \(konfiguracja: /)

    state.upsertOrder(fakeOrder({ externalId: '1', lines: [] }))
    await pollAccount(db, await sd('fake.v1'), { registry, secrets: SRC, now: () => min(6) })
    expect(await openAlerts()).toHaveLength(0)
    const closed = await db.alert.findFirstOrThrow({ where: { kind: NOT_READING_ALERT } })
    expect(closed.closedAt?.toISOString()).toBe(min(6).toISOString())

    // nowy epizod: zwykła awaria kanału — bez alertu przez pierwsze 15 min, potem nowy (drugi wiersz, nie stary)
    state.listFailures.push(new AdapterError('503', 'PRZEJSCIOWY'))
    const acc = await sd('fake.v1')
    await expect(pollAccount(db, acc, { registry, secrets: SRC, now: () => min(7) })).rejects.toThrow('503')
    expect(await openAlerts()).toHaveLength(0)
    state.listFailures.push(new AdapterError('503', 'PRZEJSCIOWY'))
    await expect(pollAccount(db, acc, { registry, secrets: SRC, now: () => min(23) })).rejects.toThrow('503')
    expect(await openAlerts()).toHaveLength(1)
    expect(await db.alert.count({ where: { kind: NOT_READING_ALERT } })).toBe(2)
  })

  it('odczyt z zaległymi ponowieniami (nie pełny) alertu nie zamyka', async () => {
    const bad = await sd('nieznany.v1')
    await expect(pollAccount(db, bad, { registry, secrets: SRC, now: () => T })).rejects.toThrow()
    state.upsertOrder(fakeOrder({ externalId: '9', lines: [] }))
    state.corrupted.add('9')
    state.getFailures.push(new AdapterError('503', 'PRZEJSCIOWY'))
    const s = await pollAccount(db, await sd('fake.v1'), { registry, secrets: SRC, now: () => min(1) })
    expect(s.doPonowienia).toBe(1)
    expect(await openAlerts()).toHaveLength(1)
  })

  it('zadanie workera z błędem konfiguracji kończy się bez wyjątku (DONE), ale alert jest od razu', async () => {
    // lampy: domyślny adapter woo.rest.v1 bez adresu i kluczy
    await handlers[POLL_JOB]!(db, { channel: 'WOO', channelAccountId: 'lampy' }, { organizationId: ORG_A, secrets: { env: {}, envFallback: false } })
    const open = await openAlerts()
    expect(open.map((a) => a.ref)).toEqual(['WOO/lampy'])
    expect((await db.channelCursor.findFirstOrThrow({ where: { channelAccountId: 'lampy' } })).lastError).toMatch(/^konfiguracja: /)
  })
})

describe('krok 3b: /api/health i pulpit liczą konta, które nie czytają', () => {
  const g = globalThis as unknown as { prismaSystem?: unknown }
  const ENV_KEYS = ['BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD', 'CIEN_ODCZYT'] as const
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

  beforeEach(async () => {
    await truncateAll(db)
    await seedBase(db)
    await seedBase(dbB)
    g.prismaSystem = sys // route bierze klienta systemowego z globalThis (lib/db.ts systemPrisma)
    for (const k of ENV_KEYS) delete process.env[k]
    resetShadowHealthCache()
  })
  afterEach(() => {
    delete g.prismaSystem
    for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  })

  const now = new Date()
  const ok = async (d: typeof db, id: string) =>
    d.channelCursor.create({ data: { channel: id === 'empik' ? 'EMPIK' : id === 'allegro' ? 'ALLEGRO' : 'WOO', channelAccountId: id, adapterKey: 'x', firstPollAt: now, lastOkAt: now } })

  it('wszystkie konta czytają = ok; jedno z błędem konfiguracji = degraded na HTTP 200, ok:false', async () => {
    const { GET } = await import('@/app/api/health/route')
    for (const d of [db, dbB]) for (const id of ['sd', 'lampy', 'km', 'empik', 'allegro']) await ok(d, id) // allegro: adapter
    let res = await GET(new Request('http://x/api/health'))
    let body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, status: 'ok', cien: { enabled: true, status: 'ok', accounts: 10, notReading: 0, openAlerts: 0 } })

    // firma B: konto Empik z błędem konfiguracji (alert od razu, jak w pollAccount)
    await handlers[POLL_JOB]!(dbB, { channel: 'EMPIK', channelAccountId: 'empik' }, { organizationId: ORG_B, secrets: { env: {}, envFallback: false } })
    // w ciągu 10 s health oddaje zapamiętany stan (otwarta ścieżka nie liczy go przy każdym żądaniu) …
    body = await (await GET(new Request('http://x/api/health'))).json()
    expect(body.cien).toMatchObject({ status: 'ok', notReading: 0 })
    // … a po upływie bufora (tu: wyczyszczony) liczy od nowa
    resetShadowHealthCache()
    res = await GET(new Request('http://x/api/health'))
    body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: false, status: 'degraded', cien: { status: 'degraded', accounts: 10, notReading: 1, openAlerts: 1 } })
    expect(body.cien.details).toBeUndefined() // bez Basic Auth: same liczniki, bez kont i firm
    expect(JSON.stringify(body)).not.toMatch(/test_b|empik/)

    process.env.BASIC_AUTH_USER = 'jan'
    process.env.BASIC_AUTH_PASSWORD = 'haslo-testowe'
    res = await GET(new Request('http://x/api/health', { headers: { authorization: 'Basic ' + Buffer.from('jan:zle').toString('base64') } }))
    expect((await res.json()).cien.details).toBeUndefined()
    res = await GET(new Request('http://x/api/health', { headers: { authorization: 'Basic ' + Buffer.from('jan:haslo-testowe').toString('base64') } }))
    body = await res.json()
    const bad = body.cien.details.filter((d: { reading: boolean }) => !d.reading)
    expect(bad).toEqual([expect.objectContaining({ organizationId: ORG_B, account: 'EMPIK/empik', reason: 'alert', lastError: expect.stringMatching(/^konfiguracja: /) })])

    // pulpit firmy B: licznik „nie czyta”; firma A go nie widzi (RLS)
    expect((await dashboard(dbB)).shadow).toMatchObject({ enabled: true, accounts: 5, notReading: 1, notReadingNames: ['EMPIK test'] })
    expect((await dashboard(db)).shadow).toMatchObject({ accounts: 5, notReading: 0 })

    // CIEN_ODCZYT=0: cień wyłączony świadomie — nie degraded
    process.env.CIEN_ODCZYT = '0'
    body = await (await GET(new Request('http://x/api/health'))).json()
    expect(body).toMatchObject({ ok: true, status: 'ok', cien: { enabled: false, status: 'off', notReading: 0 } })
  })

  it('włączony cień bez żadnego odczytu (worker nic nie czyta, 26.10) = degraded; firma wyłączona się nie liczy', async () => {
    const { GET } = await import('@/app/api/health/route')
    let body = await (await GET(new Request('http://x/api/health'))).json()
    expect(body.cien).toMatchObject({ status: 'degraded', accounts: 10, notReading: 10 })
    for (const id of ['sd', 'lampy', 'km', 'empik', 'allegro']) await ok(db, id)
    await sys.organization.update({ where: { id: ORG_B }, data: { active: false } })
    resetShadowHealthCache()
    try {
      body = await (await GET(new Request('http://x/api/health'))).json()
      expect(body.cien).toMatchObject({ status: 'ok', accounts: 5, notReading: 0 })
    } finally {
      await sys.organization.update({ where: { id: ORG_B }, data: { active: true } })
    }
    const s = await loadShadowReading(db, { enabled: true })
    expect(s.accounts).toBe(5) // klient firmy: tylko jej konta
  })
})
