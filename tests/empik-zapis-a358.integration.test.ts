// Empik w trybie pracy z zapisem — numer nadania (OR23) z kodem przewoźnika z listy Empiku, „wysłane” (OR24)
// po numerze, mapa statusów zapisana z panelu małymi literami („shipped”) i ponowienie zaległych zapisów przez
// „Wypchnij teraz”. Wyłącznie atrapa Mirakl (empik.example); zero wywołań prawdziwego Empiku.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { setSecret } from '@/lib/sekrety'
import { przebiegZapisuKanalow, wykonajZapisy, wypchnijTeraz, zapiszMapeStatusow, ZDARZENIE_NUMER_NADANIA } from '@/lib/kanaly/zapis-host'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, testDb, truncateAll } from './db'
import { MIRAKL_HOST, MIRAKL_KEY, MiraklAtrapa } from './mirakl-atrapa'
import { ACC, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const ENV = { APP_ENCRYPTION_KEY: '3'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const SCOPE = ACC.EMPIK
const where = { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...SCOPE } }
const registry = defaultRegistry()
const FAST = { minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 0 } }
const M = 60_000
const at0 = (ms: number) => new Date(T0.getTime() + ms)

let at: MiraklAtrapa

const ctx = (now: Date) => ({ registry, secrets: SRC, now, fetch: at.fetch, http: FAST })

async function konto(config: Record<string, unknown>) {
  await db.channelConfig.update({
    where,
    data: { adapterKey: 'mirakl.empik.zapis.v1', statusMode: 'PRACA', trackingMode: 'PRACA', config: { baseUrl: MIRAKL_HOST, zapisWlaczony: true, ...config } as Prisma.InputJsonValue },
  })
}

/** Zamówienie Empiku spakowane i wysłane w Kompletorze, z przesyłką (zdarzenie numeru nadania jak przy etykiecie). */
async function wyslane(externalId: string, carrier: 'PACZKOMATY' | 'DPD_EMPIK', nr: string) {
  const p = await product(db, `P-${externalId}`, 5)
  const r = await ingestOrder(db, order([{ productId: p, qty: 1 }], { channel: 'EMPIK', externalId }), { now: T0 })
  const o = await db.order.update({ where: { id: r.orderId! }, data: { status: 'WYSLANE', carrier } })
  at.putOrder({ id: externalId, state: 'SHIPPING', lines: [{ id: `${externalId}-1`, sku: 'X', qty: 1 }] })
  const after = { shipmentId: `sh-${externalId}`, orderId: o.id, packageNo: 1, carrier, trackingNumber: nr, adapterKey: 'basecourier.zapis.v1' }
  await db.auditLog.create({ data: { entity: ZDARZENIE_NUMER_NADANIA, entityId: `sh-${externalId}`, actorId: 'system', after } })
  return o
}

const zapisyMirakl = () => at.zapytania.filter((z) => z.method === 'PUT').map((z) => z.path)

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  at = new MiraklAtrapa()
  await setSecret(db, 'MIRAKL_API_KEY', MIRAKL_KEY, ENV, SCOPE)
})

describe('Empik — numer nadania i „wysłane”', () => {
  it('mapa z panelu „shipped” i paczkomat bez kodów w koncie: OR23 z kodem paczkomatyinpost, potem OR24; salon Empik = dpd', async () => {
    await konto({ statusy: { WYSLANE: 'shipped' } })
    await wyslane('10000000000001-A', 'PACZKOMATY', '620000123456789012345678')
    await wyslane('10000000000002-A', 'DPD_EMPIK', '1000123456789U')
    const s = await przebiegZapisuKanalow(db, ctx(at0(M)))
    expect(s).toMatchObject({ statusy: 2, nadania: 2, bledy: 0 })
    expect(at.tracking.get('10000000000001-A')).toEqual({ carrier_code: 'paczkomatyinpost', tracking_number: '620000123456789012345678' })
    expect(at.tracking.get('10000000000002-A')).toEqual({ carrier_code: 'dpd', tracking_number: '1000123456789U' })
    // wiersze statusu zapisane w pisowni Empiku, nie z mapy konta
    expect((await db.channelWrite.findMany({ where: { kind: 'STATUS' }, select: { channelStatus: true } })).map((w) => w.channelStatus)).toEqual(['SHIPPED', 'SHIPPED'])
    // status mógł poczekać na numer (odłożenie bez liczenia próby): drugi przebieg go dowozi
    await wykonajZapisy(db, ctx(at0(3 * M)))
    expect(at.stateOf('10000000000001-A')).toBe('SHIPPED')
    expect(at.stateOf('10000000000002-A')).toBe('SHIPPED')
    for (const id of ['10000000000001-A', '10000000000002-A']) {
      const kolejnosc = zapisyMirakl().filter((p) => p.includes(id))
      expect(kolejnosc).toEqual([`/orders/${id}/tracking`, `/orders/${id}/ship`])
    }
    expect(await db.channelWrite.count({ where: { state: { not: 'WYSLANE' } } })).toBe(0)
    expect(await db.alert.count({ where: { kind: 'KANAL_ZAPIS_BLAD' } })).toBe(0)
  })

  it('status czeka, póki numer nadania tego zamówienia jest w kolejce; bez liczenia prób', async () => {
    await konto({})
    const o = await wyslane('E-KOL', 'PACZKOMATY', '620000999')
    await przebiegZapisuKanalow(db, ctx(at0(M)))
    // symulacja: numer jeszcze nie wyszedł (np. ponowienie po 503)
    await db.channelWrite.updateMany({ where: { orderId: o.id, kind: 'NADANIE' }, data: { state: 'OCZEKUJE', nextAttemptAt: at0(60 * M) } })
    await db.channelWrite.updateMany({ where: { orderId: o.id, kind: 'STATUS' }, data: { state: 'OCZEKUJE', nextAttemptAt: at0(M), attempts: 0 } })
    at.putOrder({ id: 'E-KOL', state: 'SHIPPING', lines: [{ id: 'E-KOL-1', sku: 'X', qty: 1 }] })
    const przed = zapisyMirakl().length
    await wykonajZapisy(db, ctx(at0(2 * M)))
    expect(zapisyMirakl().length).toBe(przed)
    const st = await db.channelWrite.findFirstOrThrow({ where: { orderId: o.id, kind: 'STATUS' } })
    expect(st).toMatchObject({ state: 'OCZEKUJE', attempts: 0 })
    expect(st.lastError).toContain('czeka na wysłanie numeru nadania')
  })

  it('zaległe zapisy z produkcji (status „shipped” i numer z błędem 400) wracają przez „Wypchnij teraz” i wychodzą', async () => {
    await konto({ statusy: { WYSLANE: 'shipped' } })
    const o = await wyslane('10000000000001-A', 'PACZKOMATY', '620000123456789012345678')
    await przebiegZapisuKanalow(db, ctx(at0(M)))
    // stan jak na produkcji 20.11.2026: oba zapisy w BLAD, wiersz statusu z „shipped” zaplanowany przed poprawką
    await db.channelWrite.updateMany({ where: { orderId: o.id, kind: 'STATUS' }, data: { state: 'BLAD', channelStatus: 'shipped', lastError: 'Empik: Kompletor ustawia tylko status SHIPPED (wysłane), nie „shipped”' } })
    await db.channelWrite.updateMany({ where: { orderId: o.id, kind: 'NADANIE' }, data: { state: 'BLAD', lastError: 'numer nadania zamówienia 10000000000001-A (OR23): HTTP 400' } })
    at.putOrder({ id: '10000000000001-A', state: 'SHIPPING', lines: [{ id: 'x-1', sku: 'X', qty: 1 }] })
    at.tracking.clear()
    expect(await wypchnijTeraz(db, SCOPE, { now: at0(5 * M), actorId: 'test' })).toMatchObject({ zapisy: 2 })
    await wykonajZapisy(db, ctx(at0(5 * M)))
    await wykonajZapisy(db, ctx(at0(7 * M)))
    expect(at.tracking.get('10000000000001-A')).toEqual({ carrier_code: 'paczkomatyinpost', tracking_number: '620000123456789012345678' })
    expect(at.stateOf('10000000000001-A')).toBe('SHIPPED')
    expect(await db.channelWrite.count({ where: { orderId: o.id, state: { not: 'WYSLANE' } } })).toBe(0)
  })

  it('odmowa Empiku 400: alert z oczyszczonym komunikatem Empiku', async () => {
    await konto({})
    const o = await wyslane('E-400', 'PACZKOMATY', '620000777')
    at.injectWriteFailure('TRWALY')
    await przebiegZapisuKanalow(db, ctx(at0(M)))
    const w = await db.channelWrite.findFirstOrThrow({ where: { orderId: o.id, kind: 'NADANIE' } })
    expect(w.state).toBe('BLAD')
    expect(w.lastError).toContain('HTTP 400 (VALIDATION_ERROR), Empik: „VALIDATION_ERROR: zmyślony komunikat atrapy”')
    const a = await db.alert.findFirstOrThrow({ where: { kind: 'KANAL_ZAPIS_BLAD' } })
    expect(a.message).toContain('Empik: „VALIDATION_ERROR: zmyślony komunikat atrapy”')
  })

  it('zapis mapy z panelu: status ze słownika Empiku zostaje „SHIPPED” (także wpisany małymi literami)', async () => {
    await konto({})
    expect(await zapiszMapeStatusow(db, SCOPE, { status_WYSLANE: 'shipped' }, { registry, actorId: 'test' })).toEqual({ WYSLANE: 'SHIPPED' })
    expect(await zapiszMapeStatusow(db, SCOPE, { status_WYSLANE: 'SHIPPED' }, { registry, actorId: 'test' })).toEqual({ WYSLANE: 'SHIPPED' })
    const c = await db.channelConfig.findUniqueOrThrow({ where })
    expect((c.config as Record<string, unknown>)['statusy']).toEqual({ WYSLANE: 'SHIPPED' })
  })
})
