// przesyłki Wysyłam z Allegro w przebiegu śledzenia (lib/pakowanie/wyslane-po-przyjezdzie.ts). Moduł
// `allegro.wysylam.zapis.v1` deklaruje `shipment.track` i doręczenie: paczka w „Do wysłania” z historią „w drodze”
// przechodzi do „Wysłane”, paczka z samym PENDING zostaje, doręczona po „Wysłane” dostaje wpis DORECZONA, a błąd jednej
// paczki nie zatrzymuje reszty. Atrapa Allegro (tests/allegro-zapis-atrapa.ts), dane fikcyjne, bez sieci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ALLEGRO_SECRETS as S } from '@/lib/adaptery/allegro'
import { writeAccountSecrets } from '@/lib/adaptery/rotacja-sekretow'
import { SLEDZENIE_PO_WYSYLCE_CO_MS, sledzeniePrzesylek } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { setSecret } from '@/lib/sekrety'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, UA } from './allegro-zapis-atrapa'
import { testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const H = 3600_000
const ENV = { APP_ENCRYPTION_KEY: '0'.repeat(64), EKRANY_PRACA: '1' }
const SCOPE = { channel: 'ALLEGRO' as const, channelAccountId: 'allegro' }

let fake: FakeAllegroZapis
let nr = 0

/** Zamówienie Allegro z przesyłką Wysyłam z Allegro (numer nadania jest); historia statusów w atrapie. */
async function paczka(statuses: { code: string; occurredAt: string }[] | null, o: { status?: 'DO_WYSLANIA' | 'WYSLANE'; wyslaneAt?: Date } = {}): Promise<{ id: string; shipmentId: string }> {
  nr++
  const pid = await product(db, `P-${nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const form = `29a8e3c0-7f1b-11ef-9d6f-${String(nr).padStart(12, '0')}`
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: 'ALLEGRO', externalId: form, paymentState: 'PAID', paymentMethod: 'ONLINE' }), { now: T0 })
  const id = r.orderId!
  await db.order.update({ where: { id }, data: { carrier: 'ALLEGRO', status: o.status ?? 'DO_WYSLANIA' } })
  await db.orderEvent.create({ data: { orderId: id, kind: 'SPAKOWANE', actorId: 'test', createdAt: new Date(T0.getTime() + H) } })
  if (o.status === 'WYSLANE') await db.orderEvent.create({ data: { orderId: id, kind: 'WYSLANE', actorId: 'test', createdAt: o.wyslaneAt ?? new Date() } })
  const shipmentId = `00000000-0000-4000-9000-${String(nr).padStart(12, '0')}`
  const waybill = `ALE${String(nr).padStart(10, '0')}`
  fake.wys.shipments.set(shipmentId, { id: shipmentId, carrier: 'ALLEGRO', canceledDate: null, packages: [{ waybill }] })
  if (statuses) fake.wys.tracking.set(`ALLEGRO:${waybill}`, statuses)
  await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: `ref-${id}`, state: 'UTWORZONA', adapterKey: 'allegro.wysylam.zapis.v1', carrier: 'ALLEGRO', externalRef: shipmentId, trackingNumber: waybill } })
  return { id, shipmentId }
}

const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const stany = async (orderId: string) =>
  (await db.orderEvent.findMany({ where: { orderId, kind: 'PRZESYLKA_STATUS' }, orderBy: { createdAt: 'asc' }, select: { data: true } })).map((e) => e.data as Record<string, unknown>)

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  fake = new FakeAllegroZapis()
  fake.base.clock = () => T0.getTime()
  await db.channelConfig.updateMany({ where: SCOPE, data: { statusMode: 'PRACA', config: { apiUrl: API, authUrl: AUTH, userAgent: UA } } })
  await setSecret(db, S.clientId, FAKE_CLIENT_ID, ENV, SCOPE)
  await setSecret(db, S.clientSecret, FAKE_CLIENT_SECRET, ENV, SCOPE)
  const pair = fake.base.issuePair()
  await writeAccountSecrets(db, SCOPE, { [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: new Date(T0.getTime() + 10 * 3600_000).toISOString() }, ENV)
  await db.carrierRule.updateMany({ where: { carrier: 'ALLEGRO' }, data: { shippingModule: 'WYSYLAM_Z_ALLEGRO', adapterKey: 'allegro.wysylam.zapis.v1', config: { zapisWlaczony: true } } })
})

describe('śledzenie Wysyłam z Allegro', () => {
  it('„w drodze” = Wysłane z wpisem PRZEKAZANA; samo PENDING zostaje w „Do wysłania”; zły numer nie zatrzymuje reszty', async () => {
    const wDrodze = await paczka([{ code: 'PENDING', occurredAt: '2026-11-20T08:00:00Z' }, { code: 'IN_TRANSIT', occurredAt: '2026-11-20T15:00:00Z' }])
    const czeka = await paczka([{ code: 'PENDING', occurredAt: '2026-11-20T08:00:00Z' }])
    const zepsuta = await paczka(null)
    fake.wys.shipments.delete(zepsuta.shipmentId)
    const pozniej = new Date(Date.now() + 3 * H)
    const deps = { fetch: fake.fetch, env: ENV, secrets: { env: ENV, envFallback: false }, http: { minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 0 } }, now: () => pozniej }

    const w = await sledzeniePrzesylek(db, deps)
    expect(w).toMatchObject({ sprawdzone: 2, przeniesione: 1 })
    expect(w.bledy).toHaveLength(1)
    expect(w.bledy[0]).toContain('404')
    expect(await status(wDrodze.id)).toBe('WYSLANE')
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: wDrodze.id, kind: 'WYSLANE' } })).actorId).toBe('system:sledzenie-przesylki')
    expect(await stany(wDrodze.id)).toEqual([expect.objectContaining({ status: 'IN_TRANSIT', stan: 'PRZEKAZANA', opis: 'W drodze' })])
    expect(await status(czeka.id)).toBe('DO_WYSLANIA')
    expect(await stany(czeka.id)).toEqual([expect.objectContaining({ status: 'PENDING', stan: 'PRZED_NADANIEM' })])
    expect(await status(zepsuta.id)).toBe('DO_WYSLANIA')
    // każda paczka ma trackedAt (także ta z błędem: nie wraca w każdym przebiegu)
    expect(await db.shipment.count({ where: { trackedAt: null } })).toBe(0)
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: wDrodze.id } })).carrierStatus).toBe('IN_TRANSIT')
    // sam odczyt: żadnego zapisu do Allegro przy śledzeniu
    expect(fake.requests.filter((r) => r.includes('/tracking') || r.includes('/shipment-management/shipments/')).every((r) => r.startsWith('GET '))).toBe(true)
  })

  it('doręczona po „Wysłane”: wpis DORECZONA raz, potem przesyłka nie jest już pytana', async () => {
    const p = await paczka([{ code: 'IN_TRANSIT', occurredAt: '2026-11-20T15:00:00Z' }, { code: 'DELIVERED', occurredAt: '2026-11-21T10:00:00Z' }], { status: 'WYSLANE', wyslaneAt: new Date(Date.now() - H) })
    const teraz = new Date(Date.now() + 3 * H)
    const deps = { fetch: fake.fetch, env: ENV, secrets: { env: ENV, envFallback: false }, http: { minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 0 } }, now: () => teraz }
    expect(await sledzeniePrzesylek(db, deps)).toMatchObject({ sprawdzone: 1, bledy: [] })
    expect((await stany(p.id)).map((s) => s['stan'])).toEqual(['DORECZONA'])
    expect(await status(p.id)).toBe('WYSLANE')
    const potem = new Date(teraz.getTime() + SLEDZENIE_PO_WYSYLCE_CO_MS + H)
    const przed = fake.requests.length
    expect(await sledzeniePrzesylek(db, { ...deps, now: () => potem })).toMatchObject({ sprawdzone: 0 })
    expect(fake.requests.slice(przed).some((r) => r.includes('/tracking'))).toBe(false)
  })
})
