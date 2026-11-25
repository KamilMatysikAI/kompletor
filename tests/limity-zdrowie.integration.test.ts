// limity tempa per konto i per zdolność (kubełek żetonów w Postgresie) i automatyczne wyłączanie zepsutej
// integracji z alertem i „Włącz ponownie”. Wszystko na atrapach w pamięci (fałszywy kanał, fałszywy przewoźnik), bez
// sieci, bez prawdziwych sklepów, kurierów i wFirmy, bez danych klientów.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterError, type AdapterManifest, type ChannelAdapter, type ShipmentCreateRequest, type WriteOutcome } from '@/lib/adaptery/kontrakt'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { executeWrite } from '@/lib/adaptery/zapis'
import { createAccountAdapter, loadChannelAccounts } from '@/lib/adaptery/konta'
import { planOrderPolls } from '@/lib/cien/harmonogram'
import { LimitTempaError, oslonAdapter } from '@/lib/integracje/oslona'
import { sprawdzLimit } from '@/lib/integracje/limity'
import { ALERT_INTEGRACJA_WYLACZONA, kluczKanalu, licznikPorazek, stanWylaczenia, wlaczanieTrwa, zapiszPorazke, zapiszProg } from '@/lib/integracje/zdrowie'
import { KANAL_TEST_JOB, wykonajTestPolaczenia, zlecTestPoNaprawie, zlecWlaczenieKonta } from '@/lib/kanaly/zadania'
import { AllegroAccountError } from '@/lib/adaptery/allegro'
import { ALLEGRO_WYSYLAM_ZAPIS_MANIFEST, AllegroWysylamZapisAdapter } from '@/lib/adaptery/allegro-wysylam-zapis'
import { createWysylamAdapter } from '@/lib/wysylka/allegro-konto'
import { przebiegZapisuKanalow, wykonajZapisy } from '@/lib/kanaly/zapis-host'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, truncateAll } from './db'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { kontoIntegracjiPrzewoznika } from '@/lib/wysylka/adapter-przewoznika'
import { kluczPrzewoznika } from '@/lib/integracje/zdrowie'
import { PRZEWOZNIK_TEST_JOB, wykonajTestKonta, zlecWlaczenieKontaPrzewoznika } from '@/lib/wysylka/konta'
import { ACC, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const SRC = { env: {}, envFallback: false }
const S = 1000
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)
const SD = ACC.WOO_SD
const where = { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...SD } }

let state: FakeChannelState
let registry: AdapterRegistry

/** Fałszywy kanał z dodatkowym limitem zdolności (manifest podmieniony w instancji, metody z atrapy). */
function zLimitem(st: FakeChannelState, perCapability: NonNullable<AdapterManifest['rateLimit']['perCapability']>) {
  const def = fakeDefinition(st, 'WOO')
  const manifest: AdapterManifest = { ...def.manifest, rateLimit: { ...def.manifest.rateLimit, perCapability } }
  return { manifest, create: (ctx: Parameters<typeof def.create>[0]) => Object.assign(Object.create(def.create(ctx)) as ChannelAdapter, { manifest }) }
}

async function konto(data: { statusMode?: 'CIEN' | 'PRACA'; stockMode?: 'CIEN' | 'PRACA'; config?: Record<string, unknown> }) {
  const { config, ...modes } = data
  await db.channelConfig.update({ where, data: { adapterKey: 'fake.v1', ...modes, ...(config ? { config: config as Prisma.InputJsonValue } : {}) } })
}

async function zamowienie(status: 'WYSLANE' | 'DO_REALIZACJI') {
  const a = await product(db, `P-${Math.random().toString(36).slice(2, 8)}`, 5)
  const r = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
  await db.order.update({ where: { id: r.orderId! }, data: { status } })
  return db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
}

const ctx = (now: Date) => ({ registry, secrets: SRC, now })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
})

// ─── Fałszywy przewoźnik (tylko pamięć) ──────────────────────────────────────

const PRZEWOZNIK: AdapterManifest = {
  adapterKey: 'fakecarrier.zapis.v1',
  version: '1.0.0',
  displayName: 'Fałszywy przewoźnik',
  kind: 'carrier',
  capabilities: ['shipment.prepare', 'shipment.create', 'shipment.track'],
  rateLimit: { requestsPerMinute: 6000, maxConcurrent: 1, minPollIntervalMs: 0, perCapability: { 'shipment.create': { requestsPerMinute: 120 } } },
  config: [],
  secrets: [],
  readOnly: false,
}

function przewoznik() {
  const created: string[] = []
  let tracked = 0
  const a = {
    manifest: PRZEWOZNIK,
    async testConnection() {
      return { ok: true, message: 'OK' }
    },
    prepareShipment() {
      throw new Error('nieużywane')
    },
    async createShipment(_req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
      created.push(reference)
      return { kind: 'OK', reference, externalRef: `X-${created.length}` }
    },
    async getLabel() {
      return { contentType: 'application/pdf', base64: '' }
    },
    async trackShipment(_ref: string) {
      tracked++
      return { stan: 'W_DRODZE' as const, status: null }
    },
  }
  return { a: a as unknown as ChannelAdapter & typeof a, created, tracked: () => tracked }
}

// czysta część kubełka i klasyfikacji: lib/integracje/limity.test.ts i oslona.test.ts

describe('limit zdolności shipment.create 120/min (osłona hosta)', () => {
  it('121 zleceń: 120 od razu, 1 odłożone z czasem ponowienia (nic nie wysłane, nic nie zginęło); inna zdolność działa', async () => {
    const { a, created, tracked } = przewoznik()
    const T = at(0)
    const o = await oslonAdapter(db, a, { klucz: 'przewoznik:fakecarrier', rodzaj: 'carrier', nazwa: 'Fałszywy przewoźnik' }, { now: () => T })
    const wyniki: WriteOutcome[] = []
    for (let i = 0; i < 121; i++) wyniki.push(await executeWrite(o, `ref-${i}`, () => o.createShipment({} as ShipmentCreateRequest, `ref-${i}`)))
    expect(wyniki.filter((w) => w.kind === 'OK')).toHaveLength(120)
    const odl = wyniki.filter((w) => w.kind !== 'OK')
    expect(odl).toHaveLength(1)
    expect(odl[0]).toMatchObject({ kind: 'PRZEJSCIOWY', reference: 'ref-120', odlozone: true, retryAfterMs: 500 })
    expect(created).toHaveLength(120) // 121. nie doszło do przewoźnika
    // limit jednej zdolności nie blokuje innej na tym samym koncie
    await o.trackShipment('X-1')
    expect(tracked()).toBe(1)
    // po czasie ponowienia to samo zlecenie przechodzi (ta sama referencja)
    const later = at(600)
    const o2 = await oslonAdapter(db, a, { klucz: 'przewoznik:fakecarrier', rodzaj: 'carrier', nazwa: 'Fałszywy przewoźnik' }, { now: () => later })
    expect(await executeWrite(o2, 'ref-120', () => o2.createShipment({} as ShipmentCreateRequest, 'ref-120'))).toMatchObject({ kind: 'OK' })
    expect(created).toHaveLength(121)
  })

  it('limit konta: odmowa konta oddaje żeton zdolności (nieudana próba niczego nie zużywa)', async () => {
    const rate = { requestsPerMinute: 2, maxConcurrent: 1, minPollIntervalMs: 0, perCapability: { 'shipment.create': { requestsPerMinute: 10 } } }
    const T = at(0)
    expect((await sprawdzLimit(db, 'k1', rate, 'shipment.track', T)).granted).toBe(true)
    expect((await sprawdzLimit(db, 'k1', rate, 'shipment.track', T)).granted).toBe(true)
    const r = await sprawdzLimit(db, 'k1', rate, 'shipment.create', T)
    expect(r).toMatchObject({ granted: false, zakres: '*' })
    const b = await db.integrationRateBucket.findFirstOrThrow({ where: { integrationKey: 'k1', scope: 'shipment.create' } })
    expect(b.tokens).toBeCloseTo(10, 5)
  })

  it('rezerwa konta w zapytaniu: odczyt w tle zostawia 1/3 kubełka, zapis bierze resztę; czas do żetonu do progu rezerwy', async () => {
    const rate = { requestsPerMinute: 30, maxConcurrent: 1, minPollIntervalMs: 0 }
    const T = at(0)
    for (let i = 0; i < 20; i++) expect((await sprawdzLimit(db, 'k2', rate, 'shipment.track', T, { rezerwaKonta: true })).granted).toBe(true)
    expect(await sprawdzLimit(db, 'k2', rate, 'shipment.track', T, { rezerwaKonta: true })).toMatchObject({ granted: false, retryAfterMs: 2_000, zakres: '*' })
    for (let i = 0; i < 10; i++) expect((await sprawdzLimit(db, 'k2', rate, 'shipment.create', T)).granted).toBe(true)
    expect((await sprawdzLimit(db, 'k2', rate, 'shipment.create', T)).granted).toBe(false)
    // po 22 s: 11 żetonów, odczyt w tle znowu przechodzi (bez zagłodzenia)
    expect((await sprawdzLimit(db, 'k2', rate, 'shipment.track', at(22_000), { rezerwaKonta: true })).granted).toBe(true)
  })

  it('zapis statusów odłożony przez limit zdolności: wiersz czeka bez liczenia próby i wychodzi po czasie', async () => {
    registry = new AdapterRegistry([zLimitem(state, { 'order.status.write': { requestsPerMinute: 2 } })])
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    const zam = [await zamowienie('WYSLANE'), await zamowienie('WYSLANE'), await zamowienie('WYSLANE')]
    const r = await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(r).toMatchObject({ wyslane: 2, ponowienia: 1, bledy: 0 })
    const czeka = await db.channelWrite.findFirstOrThrow({ where: { state: 'OCZEKUJE' } })
    expect(czeka.attempts).toBe(0) // odłożenie to nie próba
    expect(czeka.lastError).toContain('limit „order.status.write” 2/min')
    expect(czeka.nextAttemptAt.getTime()).toBe(at(M + 30 * S).getTime())
    expect(state.writeCalls.filter((c) => c.op === 'status')).toHaveLength(2)
    const r2 = await wykonajZapisy(db, ctx(at(M + 30 * S)))
    expect(r2.wyslane).toBe(1)
    expect(new Set(state.writeCalls.map((c) => c.target.split(':')[0]))).toEqual(new Set(zam.map((o) => o.externalId)))
  })

  it('stany odłożone przez limit zdolności: job czeka bez próby i bez alertu (czas ponowienia z wyniku)', async () => {
    registry = new AdapterRegistry([zLimitem(state, { 'stock.write': { requestsPerMinute: 1 } })])
    await konto({ stockMode: 'PRACA', config: { zapisWlaczony: true } })
    const a = await createAccountAdapter(db, registry, (await loadChannelAccounts(db)).find((x) => x.channelAccountId === SD.channelAccountId)!, SRC, { oslona: { now: () => at(0) } })
    expect(await executeWrite(a, 'r1', () => (a as unknown as { pushStock: (i: unknown[], r: string) => Promise<WriteOutcome> }).pushStock([{ offerExternalId: '1', qty: 1 }], 'r1'))).toMatchObject({ kind: 'OK' })
    const out = await executeWrite(a, 'r2', () => (a as unknown as { pushStock: (i: unknown[], r: string) => Promise<WriteOutcome> }).pushStock([{ offerExternalId: '1', qty: 2 }], 'r2'))
    expect(out).toMatchObject({ kind: 'PRZEJSCIOWY', odlozone: true, retryAfterMs: 60_000 })
    expect(state.writeCalls.filter((c) => c.op === 'stock')).toHaveLength(1)
  })
})

describe('automatyczne wyłączenie zepsutej integracji', () => {
  it('5 kolejnych porażek uwierzytelnienia: konto „Wyłączone po błędach”, jeden alert, zero kolejnych wywołań', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    expect((await planOrderPolls(db, registry, at(0))).planned).toBe(1) // przed wyłączeniem odczyt konta jest planowany
    await db.job.deleteMany({})
    for (let i = 0; i < 7; i++) await zamowienie('WYSLANE')
    state.writeFailures.push(...Array(7).fill('UWIERZYTELNIENIE'))
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(state.writeCalls.filter((c) => c.op === 'status')).toHaveLength(5) // 6. i 7. już nie wołane
    const st = await stanWylaczenia(db, kluczKanalu(SD.channel, SD.channelAccountId))
    expect(st).toMatchObject({ porazki: 5 })
    expect(st!.powod).toContain('HTTP 401')
    expect(await db.alert.count({ where: { kind: ALERT_INTEGRACJA_WYLACZONA } })).toBe(1)
    // wiersze po wyłączeniu czekają bez liczenia prób
    const czekaja = await db.channelWrite.findMany({ where: { state: 'OCZEKUJE' } })
    expect(czekaja).toHaveLength(2)
    expect(czekaja.every((w) => w.attempts === 0 && (w.lastError ?? '').includes('wyłączona po błędach'))).toBe(true)
    // kolejne przebiegi: bez wywołań i bez nowego alertu
    await przebiegZapisuKanalow(db, ctx(at(30 * M)))
    expect(state.writeCalls.filter((c) => c.op === 'status')).toHaveLength(5)
    expect(await db.alert.count({ where: { kind: ALERT_INTEGRACJA_WYLACZONA } })).toBe(1)
    // odczyty zamówień konta nie są planowane
    expect((await planOrderPolls(db, registry, at(30 * M))).planned).toBe(0)
  })

  it('PRZEJSCIOWY, NIEJEDNOZNACZNY i błąd danych rekordu nie liczą się do progu; sukces zeruje licznik', async () => {
    const kolejka: (WriteOutcome | Error)[] = []
    const { a } = przewoznik()
    const ad = { ...a, async createShipment(_r: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
      const x = kolejka.shift()
      if (x instanceof Error) throw x
      return x ? { ...x, reference } : { kind: 'OK', reference }
    } } as unknown as ChannelAdapter & typeof a
    const konto = { klucz: 'przewoznik:fakecarrier', rodzaj: 'carrier' as const, nazwa: 'Fałszywy przewoźnik' }
    const o = await oslonAdapter(db, ad, konto, { now: () => at(0) })
    const raz = (i: number) => executeWrite(o, `r${i}`, () => o.createShipment({} as ShipmentCreateRequest, `r${i}`))
    kolejka.push(new AdapterError('HTTP 503', 'PRZEJSCIOWY'), { kind: 'NIEJEDNOZNACZNY', reference: '', message: 'timeout po wysłaniu' })
    for (let i = 0; i < 6; i++) kolejka.push({ kind: 'TRWALY', reference: '', message: 'kod pocztowy odbiorcy niepoprawny' })
    for (let i = 0; i < 8; i++) await raz(i)
    expect(await licznikPorazek(db, konto.klucz)).toBe(0)
    kolejka.push({ kind: 'TRWALY', reference: '', message: 'HTTP 401 (klucz odrzucony)' }, { kind: 'TRWALY', reference: '', message: 'x', errorClass: 'UWIERZYTELNIENIE' })
    await raz(8)
    await raz(9)
    expect(await licznikPorazek(db, konto.klucz)).toBe(2)
    await raz(10) // OK
    expect(await licznikPorazek(db, konto.klucz)).toBe(0)
    expect(await stanWylaczenia(db, konto.klucz)).toBeNull()
  })

  it('próg z ustawień firmy (np. 3) zamiast domyślnych 5', async () => {
    await zapiszProg(db, 3)
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    for (let i = 0; i < 4; i++) await zamowienie('WYSLANE')
    state.writeFailures.push(...Array(4).fill('UWIERZYTELNIENIE'))
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(state.writeCalls.filter((c) => c.op === 'status')).toHaveLength(3)
    expect(await stanWylaczenia(db, kluczKanalu(SD.channel, SD.channelAccountId))).toMatchObject({ porazki: 3 })
    await expect(zapiszProg(db, 1)).rejects.toThrow('od 2 do 50')
  })

  it('„Włącz ponownie”: nieudany test zostawia wyłączone z krokiem; udany przywraca ten sam tryb i zapisWlaczony, zapisy ruszają', async () => {
    await konto({ statusMode: 'PRACA', stockMode: 'PRACA', config: { zapisWlaczony: true } })
    for (let i = 0; i < 6; i++) await zamowienie('WYSLANE')
    state.writeFailures.push(...Array(5).fill('UWIERZYTELNIENIE'))
    await przebiegZapisuKanalow(db, ctx(at(M)))
    const klucz = kluczKanalu(SD.channel, SD.channelAccountId)
    expect(await stanWylaczenia(db, klucz)).not.toBeNull()
    const przed = await db.channelConfig.findUniqueOrThrow({ where })
    // nieudany test
    expect(await zlecWlaczenieKonta(db, SD, at(2 * M))).toBe(true)
    expect(await db.job.count({ where: { kind: KANAL_TEST_JOB } })).toBe(1)
    state.connectionOk = false
    await wykonajTestPolaczenia(db, { ...SD, wlacz: true }, { registry, secrets: SRC, now: () => at(2 * M) })
    const st = await stanWylaczenia(db, klucz)
    expect(st).not.toBeNull()
    expect(st!.ostatniaProba).toMatch(/^Test połączenia: /)
    // udany test
    state.connectionOk = true
    await zlecWlaczenieKonta(db, SD, at(3 * M))
    await wykonajTestPolaczenia(db, { ...SD, wlacz: true }, { registry, secrets: SRC, now: () => at(3 * M) })
    expect(await stanWylaczenia(db, klucz)).toBeNull()
    expect(await licznikPorazek(db, klucz)).toBe(0)
    const po = await db.channelConfig.findUniqueOrThrow({ where })
    expect({ s: po.statusMode, st: po.stockMode, c: po.config, a: po.active }).toEqual({ s: przed.statusMode, st: przed.stockMode, c: przed.config, a: przed.active })
    expect(await db.alert.count({ where: { kind: ALERT_INTEGRACJA_WYLACZONA, closedAt: null } })).toBe(0)
    // czekający wiersz idzie po czasie odłożenia
    const r = await wykonajZapisy(db, ctx(at(20 * M)))
    expect(r.wyslane).toBe(1)
    // konto niewyłączone: „Włącz ponownie” nic nie zleca
    expect(await zlecWlaczenieKonta(db, SD, at(21 * M))).toBe(false)
  })

  it('wyłączenie konta nie zmienia rezerwacji ani stanów w rdzeniu', async () => {
    await konto({ statusMode: 'PRACA', config: { zapisWlaczony: true } })
    await zamowienie('DO_REALIZACJI')
    const przed = { r: await db.reservation.findMany({ orderBy: { id: 'asc' } }), s: await db.stock.findMany({ orderBy: { productId: 'asc' } }) }
    for (let i = 0; i < 5; i++) await zamowienie('WYSLANE')
    const przedWszystko = { r: await db.reservation.count(), s: await db.stock.findMany({ orderBy: { productId: 'asc' } }) }
    state.writeFailures.push(...Array(5).fill('UWIERZYTELNIENIE'))
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(await stanWylaczenia(db, kluczKanalu(SD.channel, SD.channelAccountId))).not.toBeNull()
    expect(await db.reservation.count()).toBe(przedWszystko.r)
    expect(await db.stock.findMany({ orderBy: { productId: 'asc' } })).toEqual(przedWszystko.s)
    expect(przed.r.length).toBeGreaterThan(0)
  })

  it('firma bez BL i bez wFirmy (demo) z kontem na atrapie: wyłączenie po błędach testu połączenia i ponowne włączenie', async () => {
    await dbB.channelConfig.create({ data: { channel: 'SHOPER', channelAccountId: 'demo', name: 'Sklep demo', adapterKey: 'fake.v1' } })
    const st = new FakeChannelState()
    const reg = new AdapterRegistry([fakeDefinition(st, 'SHOPER')])
    st.connectionOk = false
    const deps = { registry: reg, secrets: SRC, now: () => at(M) }
    for (let i = 0; i < 5; i++) await wykonajTestPolaczenia(dbB, { channel: 'SHOPER', channelAccountId: 'demo' }, deps)
    const klucz = kluczKanalu('SHOPER', 'demo')
    expect(await stanWylaczenia(dbB, klucz)).toMatchObject({ porazki: 5 })
    expect((await loadChannelAccounts(dbB))[0]!.wylaczonePoBledach).toBeTruthy()
    // zero wywołań odczytu po wyłączeniu
    const a = await createAccountAdapter(dbB, reg, (await loadChannelAccounts(dbB))[0]!, SRC)
    await expect((a as unknown as { listOrderChanges: (c: null, o: object) => Promise<unknown> }).listOrderChanges(null, { initialLookbackMs: 1 })).rejects.toThrow('wyłączona po błędach')
    st.connectionOk = true
    expect(await zlecWlaczenieKonta(dbB, { channel: 'SHOPER', channelAccountId: 'demo' }, at(2 * M))).toBe(true)
    await wykonajTestPolaczenia(dbB, { channel: 'SHOPER', channelAccountId: 'demo', wlacz: true }, deps)
    expect(await stanWylaczenia(dbB, klucz)).toBeNull()
    expect((await loadChannelAccounts(dbB))[0]!.wylaczonePoBledach).toBeNull()
    // izolacja firm: firma A nie widzi stanu firmy B
    expect(await db.integrationHealth.count()).toBe(0)
  })

  it('konto przewoźnika: ten sam klucz co na ekranie kont; 5 nieudanych testów (brak klucza) wyłącza, „Włącz ponownie” mówi, na którym kroku pada; zero żądań do przewoźnika', async () => {
    expect(kontoIntegracjiPrzewoznika('dpd.zapis.v1', 'EMPIK', 'x').klucz).toBe(kluczPrzewoznika('dpd~EMPIK'))
    expect(kontoIntegracjiPrzewoznika('inpost.shipx.v1', null, 'x').klucz).toBe(kluczPrzewoznika('inpost'))
    const reg = defaultRegistry()
    let wolania = 0
    const fetch = async () => {
      wolania++
      return new Response('{}', { status: 401 })
    }
    const deps = { registry: reg, secrets: { env: { APP_ENCRYPTION_KEY: 'b'.repeat(64), APP_MODE: 'self-host' }, envFallback: false }, fetch, now: () => at(M) }
    for (let i = 0; i < 5; i++) expect((await wykonajTestKonta(db, { konto: 'inpost' }, deps))!.ok).toBe(false)
    const klucz = kluczPrzewoznika('inpost')
    expect(await stanWylaczenia(db, klucz)).toMatchObject({ porazki: 5 })
    expect(await db.alert.count({ where: { kind: ALERT_INTEGRACJA_WYLACZONA, ref: klucz } })).toBe(1)
    expect(await zlecWlaczenieKontaPrzewoznika(db, reg, 'inpost', at(2 * M))).toBe(true)
    expect(await db.job.count({ where: { kind: PRZEWOZNIK_TEST_JOB } })).toBe(1)
    await wykonajTestKonta(db, { konto: 'inpost', wlacz: true }, deps)
    const st = await stanWylaczenia(db, klucz)
    expect(st).not.toBeNull()
    expect(st!.ostatniaProba).toMatch(/^Konfiguracja przewoźnika: /)
    expect(wolania).toBe(0)
  })
})

// ─── Poprawki po przeglądzie ────────────────

describe('osłona nie dziedziczy zamrożonego zegara adaptera', () => {
  it('adapter z zegarem stałym (jak przegląd otwartych): 125 odczytów przy 120/min przechodzi w sekundach, bez błędów limitu', async () => {
    registry = new AdapterRegistry([zLimitem(state, { 'orders.feed': { requestsPerMinute: 120 } })])
    await konto({})
    const stala = at(0)
    const a = await createAccountAdapter(db, registry, (await loadChannelAccounts(db)).find((x) => x.channelAccountId === SD.channelAccountId)!, SRC, { now: () => stala })
    const getOrder = (a as unknown as { getOrder: (id: string) => Promise<unknown> }).getOrder
    const start = Date.now()
    let bledy = 0
    for (let i = 0; i < 125; i++) await getOrder(`brak-${i}`).catch(() => bledy++)
    const ms = Date.now() - start
    expect(bledy).toBe(0)
    // 5 nadmiarowych po ok. 0,5 s (realny zegar uzupełnia kubełek 2/s); przed poprawką 5 × 30 s
    expect(ms).toBeLessThan(15_000)
  }, 30_000)

  it('zegar osłony stoi (test): 200 odczytów przy 120/min = 120 wywołań i 80 odłożonych od razu, najwyżej jeden sen', async () => {
    registry = new AdapterRegistry([zLimitem(state, { 'orders.feed': { requestsPerMinute: 120 } })])
    await konto({})
    const sny: number[] = []
    const a = await createAccountAdapter(db, registry, (await loadChannelAccounts(db)).find((x) => x.channelAccountId === SD.channelAccountId)!, SRC, {
      now: () => at(0),
      oslona: { now: () => at(0), sleep: async (ms) => void sny.push(ms) },
    })
    const getOrder = (a as unknown as { getOrder: (id: string) => Promise<unknown> }).getOrder
    const start = Date.now()
    let ok = 0
    let odlozone = 0
    for (let i = 0; i < 200; i++) {
      try {
        await getOrder(`brak-${i}`)
        ok++
      } catch (e) {
        expect(e).toBeInstanceOf(LimitTempaError)
        odlozone++
      }
    }
    expect({ ok, odlozone }).toEqual({ ok: 120, odlozone: 80 })
    expect(sny.length).toBeLessThanOrEqual(1)
    expect(Date.now() - start).toBeLessThan(15_000)
  }, 30_000)
})

describe('Wysyłam z Allegro w osłonie (klucz konta Allegro)', () => {
  function wysylamAtrapa() {
    const manifest = { ...ALLEGRO_WYSYLAM_ZAPIS_MANIFEST, secrets: [], config: [] }
    const utworzone: string[] = []
    let blad: Error | null = null
    const def = {
      manifest,
      create: () =>
        Object.assign(Object.create(AllegroWysylamZapisAdapter.prototype) as AllegroWysylamZapisAdapter, {
          manifest,
          async createShipment(_r: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
            if (blad) throw blad
            utworzone.push(reference)
            return { kind: 'OK', reference, externalRef: `W-${utworzone.length}` }
          },
          async testConnection() {
            return { ok: true, message: 'OK' }
          },
        }),
    }
    return { reg: new AdapterRegistry([def as never]), utworzone, ustawBlad: (e: Error | null) => void (blad = e), key: manifest.adapterKey }
  }

  it('121 zleceń: 120 do Allegro, 1 odłożone; kubełek na kluczu konta Allegro', async () => {
    const w = wysylamAtrapa()
    const a = await createWysylamAdapter(db, w.reg, ACC.ALLEGRO.channelAccountId, SRC, { adapterKey: w.key, oslona: { now: () => at(0) } })
    expect(a).toBeInstanceOf(AllegroWysylamZapisAdapter)
    const wyniki: WriteOutcome[] = []
    for (let i = 0; i < 121; i++) wyniki.push(await executeWrite(a, `w-${i}`, () => (a as unknown as AllegroWysylamZapisAdapter).createShipment({} as ShipmentCreateRequest, `w-${i}`)))
    expect(wyniki.filter((x) => x.kind === 'OK')).toHaveLength(120)
    expect(wyniki[120]).toMatchObject({ kind: 'PRZEJSCIOWY', odlozone: true, reference: 'w-120' })
    expect(w.utworzone).toHaveLength(120)
    expect(await db.integrationRateBucket.count({ where: { integrationKey: kluczKanalu('ALLEGRO', ACC.ALLEGRO.channelAccountId), scope: 'shipment.create' } })).toBe(1)
  })

  it('odrzucony token Wysyłam (AllegroAccountError przy zapisie) liczy się do wyłączenia konta Allegro', async () => {
    const w = wysylamAtrapa()
    w.ustawBlad(new AllegroAccountError('Allegro /shipment-management/shipments/create-commands: HTTP 401 także po odświeżeniu tokena — konto wymaga sprawdzenia autoryzacji'))
    const a = await createWysylamAdapter(db, w.reg, ACC.ALLEGRO.channelAccountId, SRC, { adapterKey: w.key, oslona: { now: () => at(0) } })
    for (let i = 0; i < 2; i++) await executeWrite(a, `w-${i}`, () => (a as unknown as AllegroWysylamZapisAdapter).createShipment({} as ShipmentCreateRequest, `w-${i}`))
    expect(await licznikPorazek(db, kluczKanalu('ALLEGRO', ACC.ALLEGRO.channelAccountId))).toBe(2)
  })
})

describe('„Włącz ponownie” zawsze ma wyjście', () => {
  async function wylacz() {
    const klucz = kluczKanalu(SD.channel, SD.channelAccountId)
    for (let i = 0; i < 5; i++) await zapiszPorazke(db, { klucz, rodzaj: 'channel', nazwa: 'SD' }, 'HTTP 401', at(0))
    return klucz
  }

  it('zlecenie, które nie dało wyniku: po 5 min przycisk aktywny', async () => {
    await konto({})
    const klucz = await wylacz()
    expect(await zlecWlaczenieKonta(db, SD, at(2 * M))).toBe(true)
    const st = (await stanWylaczenia(db, klucz))!
    expect(wlaczanieTrwa(st, at(3 * M))).toBe(true)
    expect(wlaczanieTrwa(st, at(8 * M))).toBe(false)
    // drugie kliknięcie po czasie znowu zleca (konto dalej wyłączone)
    expect(await zlecWlaczenieKonta(db, SD, at(8 * M))).toBe(true)
  })

  it('błąd zapisu wyniku testu nie zostawia flagi: wynik włączenia i tak zapisany', async () => {
    await konto({})
    const klucz = await wylacz()
    await zlecWlaczenieKonta(db, SD, at(2 * M))
    // osobny klient firmy z zepsutym zapisem wyniku testu (wspólny `db` zostaje nietknięty)
    const dbX = testDb()
    let wolania = 0
    Object.defineProperty(dbX, 'channelAccountStatus', {
      configurable: true,
      value: { upsert: () => { wolania++; return Promise.reject(new Error('baza chwilowo niedostępna')) } },
    })
    try {
      await expect(wykonajTestPolaczenia(dbX, { ...SD, wlacz: true }, { registry, secrets: SRC, now: () => at(2 * M) })).rejects.toThrow('niedostępna')
    } finally {
      await dbX.$disconnect()
    }
    expect(wolania).toBe(1)
    expect(await stanWylaczenia(db, klucz)).toBeNull() // test OK → konto wróciło mimo błędu zapisu wyniku testu
  })
})

describe('i', () => {
  it('brak klucza ZAPISU (KONFIGURACJA przy zapisie) nie liczy się do wyłączenia; brak sekretu przy odczycie tak', async () => {
    const { a } = przewoznik()
    const ad = { ...a, async createShipment(_r: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
      return { kind: 'TRWALY', reference, message: 'brak klucza zapisu Woo (WOO_WRITE_KEY i WOO_WRITE_SECRET)' }
    }, async trackShipment(): Promise<never> {
      throw new AdapterError('brak sekretu TRACK_KEY', 'TRWALY')
    } } as unknown as ChannelAdapter & typeof a
    const konto = { klucz: 'przewoznik:fakecarrier', rodzaj: 'carrier' as const, nazwa: 'Fałszywy przewoźnik' }
    const o = await oslonAdapter(db, ad, konto, { now: () => at(0) })
    for (let i = 0; i < 6; i++) expect(await executeWrite(o, `r${i}`, () => o.createShipment({} as ShipmentCreateRequest, `r${i}`))).toMatchObject({ kind: 'TRWALY' })
    expect(await licznikPorazek(db, konto.klucz)).toBe(0)
    expect(await stanWylaczenia(db, konto.klucz)).toBeNull()
    await o.trackShipment('X').catch(() => undefined)
    expect(await licznikPorazek(db, konto.klucz)).toBe(1)
  })

  it('naprawa konta (nowe klucze, autoryzacja) zleca „Włącz ponownie” tylko kontu wyłączonemu', async () => {
    await konto({})
    expect(await zlecTestPoNaprawie(db, SD, at(0), { zwyklyTest: false })).toBe('NIC')
    expect(await db.job.count({ where: { kind: KANAL_TEST_JOB } })).toBe(0)
    const klucz = kluczKanalu(SD.channel, SD.channelAccountId)
    for (let i = 0; i < 5; i++) await zapiszPorazke(db, { klucz, rodzaj: 'channel', nazwa: 'SD' }, 'HTTP 401', at(0))
    expect(await zlecTestPoNaprawie(db, SD, at(M))).toBe('WLACZANIE')
    const job = await db.job.findFirstOrThrow({ where: { kind: KANAL_TEST_JOB } })
    expect(job.payload).toMatchObject({ wlacz: true })
    await wykonajTestPolaczenia(db, job.payload, { registry, secrets: SRC, now: () => at(M) })
    expect(await stanWylaczenia(db, klucz)).toBeNull()
  })
})
