// śledzenie po „Wysłane” kończy się na doręczeniu (InPost ShipX „delivered”), działa tylko dla modułów,
// które deklarują, że zwracają doręczenie, i najwyżej SLEDZENIE_PO_WYSLANIU_DNI po „Wysłane”. Filtr JSON zdarzeń
// (`events.none.data.path`) sprawdzony na bazie. Fałszywy kanał, atrapa ShipX, dane fikcyjne, bez sieci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { kluczeSledzeniaDoDoreczenia, SLEDZENIE_PO_WYSLANIU_DNI, SLEDZENIE_PO_WYSYLCE_CO_MS, sledzeniePrzesylek } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { PRZYKLADOWE_ODBIORY } from './pakowanie-fixtures'
import { INPOST_ORG, INPOST_SANDBOX, INPOST_TOKEN, inpostAtrapa } from './inpost-atrapa'
import { testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const H = 3600_000
const D = 24 * H
const ENV = { EKRANY_PRACA: '1', INPOST_TOKEN }

let nr = 0
/** Zamówienie „Wysłane” z przesyłką ShipX i zdarzeniem „Wysłane” w podanej chwili. */
async function wyslana(wyslaneAt: Date): Promise<{ id: string; ref: number }> {
  const pid = await product(db, `P-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { paymentState: 'PAID' }), { now: T0 })
  const id = r.orderId!
  await db.order.update({ where: { id }, data: { carrier: 'PACZKOMATY', status: 'WYSLANE' } })
  await db.orderEvent.create({ data: { orderId: id, kind: 'WYSLANE', actorId: 'test', createdAt: wyslaneAt } })
  const ref = 900_000 + nr
  await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: `ref-${id}`, state: 'UTWORZONA', adapterKey: 'inpost.shipx.zapis.v1', carrier: 'PACZKOMATY', externalRef: `${ref}`, trackingNumber: `NR${100000 + nr}`, carrierStatus: 'taken_by_courier' } })
  return { id, ref }
}

const stany = async (orderId: string) =>
  (await db.orderEvent.findMany({ where: { orderId, kind: 'PRZESYLKA_STATUS' }, orderBy: { createdAt: 'asc' }, select: { data: true } })).map((e) => (e.data as Record<string, unknown>)['stan'])

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.carrierPickup.createMany({ data: PRZYKLADOWE_ODBIORY })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', trackingMode: 'PRACA', config: { zapisWlaczony: true } as Prisma.InputJsonValue } })
  await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'INPOST_SHIPX', adapterKey: 'inpost.shipx.zapis.v1', config: { baseUrl: INPOST_SANDBOX, organizationId: INPOST_ORG, zapisWlaczony: true } } })
})

describe('śledzenie po „Wysłane”', () => {
  it('moduły deklarujące doręczenie: Base Courier i InPost ShipX; Poczta Polska nie', () => {
    const k = kluczeSledzeniaDoDoreczenia(defaultRegistry())
    expect(k).toContain('inpost.shipx.zapis.v1')
    expect(k).toContain('basecourier.zapis.v1')
    expect(k.some((x) => /poczta/i.test(x))).toBe(false)
  })

  it('„delivered” = DORECZONA i koniec pytania; w drodze pytana dalej; po limicie dni po „Wysłane” bez pytania', async () => {
    const teraz = new Date(Date.now() + 3 * H)
    const doreczona = await wyslana(new Date(teraz.getTime() - D))
    const wDrodze = await wyslana(new Date(teraz.getTime() - D))
    const stara = await wyslana(new Date(teraz.getTime() - (SLEDZENIE_PO_WYSLANIU_DNI + 1) * D))
    const shipx = inpostAtrapa()
    shipx.ustawStatus(doreczona.ref, 'delivered')
    shipx.ustawStatus(wDrodze.ref, 'out_for_delivery')
    shipx.ustawStatus(stara.ref, 'out_for_delivery')
    const deps = { fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => teraz }
    const pytane = (od = 0) => shipx.calls.slice(od).filter((c) => c.method === 'GET').map((c) => Number(c.path.split('/').pop()))

    expect(await sledzeniePrzesylek(db, deps)).toMatchObject({ sprawdzone: 2, bledy: [] })
    expect(pytane().sort()).toEqual([doreczona.ref, wDrodze.ref].sort())
    expect(await stany(doreczona.id)).toEqual(['DORECZONA'])
    expect(await stany(wDrodze.id)).toEqual(['PRZEKAZANA'])
    expect(await stany(stara.id)).toEqual([])

    // kolejny przebieg po odstępie: doręczona już nie (filtr JSON zdarzeń na bazie), w drodze tak
    const potem = new Date(teraz.getTime() + SLEDZENIE_PO_WYSYLCE_CO_MS + H)
    const przed = shipx.calls.length
    expect(await sledzeniePrzesylek(db, { ...deps, now: () => potem })).toMatchObject({ sprawdzone: 1, bledy: [] })
    expect(pytane(przed)).toEqual([wDrodze.ref])
  })
})
