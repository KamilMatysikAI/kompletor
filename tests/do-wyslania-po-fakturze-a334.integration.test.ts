// „Do wysłania po fakturze” (lib/worker/zadania.ts). Na bazie, dane fikcyjne, bez sieci.
// (1) odrzucone przejście nie zagładza kolejnych zamówień, (2) okno liczy się też od wystawienia faktury,
// (3) odbiór osobisty i anulowane zostają, (4) wysłane nie wraca do „Do wysłania”.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Carrier, OrderStatus } from '@prisma/client'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { DO_WYSLANIA_ODROCZENIE_MS, doWyslaniaPoFakturze } from '@/lib/worker/zadania'
import { testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const D = 86_400_000
const NOW = new Date(T0.getTime() + 10 * D)

let nr = 0
/** Zamówienie „Spakowane” z wystawioną fakturą (towar wydany) i przesyłką z numerem. */
async function spakowane(o: { updatedAt: Date; fakturaAt?: Date; pending?: boolean; carrier?: Carrier; status?: OrderStatus }): Promise<string> {
  const pid = await product(db, `P-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1 }]), { now: T0 })
  const id = r.orderId!
  await db.reservation.updateMany({ where: { orderId: id }, data: { state: 'CONSUMED' } })
  const inv = await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: `FV/T/${nr}` } })
  await db.$executeRaw`UPDATE "InvoiceAttempt" SET "updatedAt" = ${o.fakturaAt ?? o.updatedAt} WHERE id = ${inv.id}`
  await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: `ref-${id}`, state: 'UTWORZONA', adapterKey: 'inpost.shipx.zapis.v1', carrier: o.carrier ?? 'PACZKOMATY', externalRef: `${900_000 + nr}`, trackingNumber: `NR${100000 + nr}` } })
  await db.order.update({ where: { id }, data: { status: o.status ?? 'SPAKOWANE', carrier: o.carrier ?? 'PACZKOMATY', pendingAction: o.pending ? 'ANULUJ' : null } })
  await db.$executeRaw`UPDATE "Order" SET "updatedAt" = ${o.updatedAt} WHERE id = ${id}`
  return id
}

const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('doWyslaniaPoFakturze', () => {
  it('odrzucone najstarsze nie blokują nowych: następny przebieg bierze kolejne, odrzucone wracają po odroczeniu', async () => {
    const stare1 = await spakowane({ updatedAt: new Date(NOW.getTime() - 2 * D), pending: true })
    const stare2 = await spakowane({ updatedAt: new Date(NOW.getTime() - 2 * D + 1000), pending: true })
    const nowe = await spakowane({ updatedAt: new Date(NOW.getTime() - D) })
    const odrzucone = new Map<string, number>()

    expect(await doWyslaniaPoFakturze(db, NOW, { limit: 2, odrzucone })).toBe(0)
    expect([...odrzucone.keys()].sort()).toEqual([stare1, stare2].sort())
    expect(await status(nowe)).toBe('SPAKOWANE')

    expect(await doWyslaniaPoFakturze(db, new Date(NOW.getTime() + 60_000), { limit: 2, odrzucone })).toBe(1)
    expect(await status(nowe)).toBe('DO_WYSLANIA')

    // po odroczeniu odrzucone próbowane znowu (dalej odmowa, ale bez wyjątku)
    const potem = new Date(NOW.getTime() + DO_WYSLANIA_ODROCZENIE_MS + 120_000)
    expect(await doWyslaniaPoFakturze(db, potem, { limit: 2, odrzucone })).toBe(0)
    expect(odrzucone.get(stare1)).toBe(potem.getTime() + DO_WYSLANIA_ODROCZENIE_MS)
    expect(await status(stare1)).toBe('SPAKOWANE')
  })

  it('faktura wystawiona później niż 3 dni po ostatniej zmianie zamówienia też przenosi', async () => {
    const id = await spakowane({ updatedAt: new Date(NOW.getTime() - 5 * D), fakturaAt: new Date(NOW.getTime() - 60_000) })
    const bardzoStare = await spakowane({ updatedAt: new Date(NOW.getTime() - 5 * D), fakturaAt: new Date(NOW.getTime() - 4 * D) })
    expect(await doWyslaniaPoFakturze(db, NOW, { odrzucone: new Map() })).toBe(1)
    expect(await status(id)).toBe('DO_WYSLANIA')
    expect(await status(bardzoStare)).toBe('SPAKOWANE')
  })

  it('odbiór osobisty, anulowane i wysłane nie przechodzą do „Do wysłania”', async () => {
    const osobisty = await spakowane({ updatedAt: new Date(NOW.getTime() - D), carrier: 'OSOBISTY' })
    const anulowane = await spakowane({ updatedAt: new Date(NOW.getTime() - D), status: 'ANULOWANE' })
    const wyslane = await spakowane({ updatedAt: new Date(NOW.getTime() - D), status: 'WYSLANE' })
    const odrzucone = new Map<string, number>()
    expect(await doWyslaniaPoFakturze(db, NOW, { odrzucone })).toBe(0)
    expect(await status(osobisty)).toBe('SPAKOWANE')
    expect(await status(anulowane)).toBe('ANULOWANE')
    expect(await status(wyslane)).toBe('WYSLANE')
    expect([...odrzucone.keys()]).toEqual([osobisty])
  })
})
