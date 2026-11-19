// Rdzeń: przejścia statusów z ekranów zbierania, pakowania i wysyłki (spec 7, T7–T13). Atrapa wFirmy w pamięci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { cancelPicking, finishPicking, markReceived, markShipped, moveOrder, readyForDispatch, startPicking } from '@/lib/rdzen/przejscia'
import { processAllocateEvents } from '@/lib/rdzen/przydzial'
import { issueInvoice, packOrder, shipWithoutInvoice } from '@/lib/rdzen/rozchod'
import { TransitionError } from '@/lib/rdzen/statusy'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)
const statusOf = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).status

describe('przejścia z ekranów (T7–T13)', () => {
  it('przesyłka: DO_REALIZACJI → ZBIERANIE → ZEBRANE → SPAKOWANE → (faktura) → DO_WYSLANIA → WYSLANE → ODEBRANE, historia każdego kroku', async () => {
    const a = await product(db, 'A', 5)
    const { orderId } = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    const id = orderId!
    expect(await startPicking(db, id, { now: at(M) })).toBe('ZBIERANIE')
    expect(await startPicking(db, id, { now: at(M) })).toBe('ZBIERANIE') // podwójne kliknięcie: bez błędu i bez drugiego wpisu
    expect(await finishPicking(db, id, { now: at(2 * M) })).toBe('ZEBRANE')
    await packOrder(db, id, { now: at(3 * M) })
    // przed fakturą towar nie jest wydany: rezerwacja ACTIVE po wysyłce łamałaby niezmiennik 4d
    await expect(readyForDispatch(db, id)).rejects.toThrow(/Najpierw faktura/)
    expect(await issueInvoice(db, id, new FakeWfirma(), { now: at(4 * M) })).toBe('WYSTAWIONA')
    expect(await readyForDispatch(db, id, { now: at(5 * M) })).toBe('DO_WYSLANIA')
    expect(await markShipped(db, id, { now: at(6 * M), trackingNo: 'TEST-NADANIE-1' })).toBe('WYSLANE')
    expect(await markReceived(db, id, { now: at(7 * M) })).toBe('ODEBRANE')
    const ev = await db.orderEvent.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } })
    expect(ev.map((e) => e.kind)).toEqual(['PRZYJETE', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'FAKTURA', 'DO_WYSLANIA', 'WYSLANE', 'ODEBRANE'])
    expect(ev.find((e) => e.kind === 'WYSLANE')!.data).toMatchObject({ z: 'DO_WYSLANIA', na: 'WYSLANE', nadanie: 'TEST-NADANIE-1' })
    await expectInvariants(db)
  })

  it('odbiór osobisty: SPAKOWANE → (faktura) → DO_ODBIORU → ODEBRANE; „Do wysłania” odrzucone', async () => {
    const a = await product(db, 'A', 5)
    const { orderId } = await ingestOrder(db, order([{ productId: a, qty: 1 }], { deliveryMethod: 'Odbiór osobisty' }), { now: T0 })
    const id = orderId!
    await packOrder(db, id, { now: T0 })
    await issueInvoice(db, id, new FakeWfirma(), { now: at(M) })
    await expect(moveOrder(db, id, 'DO_WYSLANIA')).rejects.toThrow(/Do odbioru/)
    expect(await readyForDispatch(db, id)).toBe('DO_ODBIORU')
    await expect(markShipped(db, id)).rejects.toThrow('Niedozwolone przejście DO_ODBIORU → WYSLANE')
    expect(await markReceived(db, id)).toBe('ODEBRANE')
    await expectInvariants(db)
  })

  it('„wyślij bez faktury” ustawia DO_WYSLANIA; dalej WYSLANE jak zwykle', async () => {
    const a = await product(db, 'A', 5)
    const { orderId } = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    await packOrder(db, orderId!, { now: T0 })
    await shipWithoutInvoice(db, orderId!, { now: at(M) })
    expect(await markShipped(db, orderId!)).toBe('WYSLANE')
    await expectInvariants(db)
  })

  it('odrzucenia: nieopłacone NOWE → ZBIERANIE, zbieranie bez rezerwacji, skok przez etapy, DO_WYJASNIENIA, SPAKOWANE spoza packOrder', async () => {
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 0)
    const unpaid = (await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })).orderId!
    await expect(startPicking(db, unpaid)).rejects.toThrow('Niedozwolone przejście NOWE → ZBIERANIE')
    const empty = (await ingestOrder(db, order([{ productId: b, qty: 1 }]), { now: T0 })).orderId!
    await expect(startPicking(db, empty)).rejects.toThrow(/Nic do zbierania/)
    const ok = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    await expect(markShipped(db, ok)).rejects.toBeInstanceOf(TransitionError)
    await expect(moveOrder(db, ok, 'SPAKOWANE')).rejects.toThrow(/packOrder/)
    await expect(moveOrder(db, ok, 'ANULOWANE')).rejects.toThrow(/własną funkcję/) // bez zwolnienia rezerwacji nie wolno
    await expect(moveOrder(db, unpaid, 'DO_REALIZACJI')).rejects.toThrow(/własną funkcję/)
    const clarify = (await ingestOrder(db, order([{ offerExternalId: 'nieznana', qty: 1 }]), { now: T0 })).orderId!
    expect(await statusOf(clarify)).toBe('DO_WYJASNIENIA')
    await expect(startPicking(db, clarify)).rejects.toThrow('Niedozwolone przejście DO_WYJASNIENIA → ZBIERANIE')
    expect(await statusOf(ok)).toBe('DO_REALIZACJI')
    expect(await db.orderEvent.count({ where: { orderId: ok, kind: { not: 'PRZYJETE' } } })).toBe(0)
  })

  it('cofnięcie zbierania: dostawa w trakcie ZBIERANIE czeka; po powrocie do DO_REALIZACJI przydział ją bierze', async () => {
    const a = await product(db, 'A', 1)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })).orderId!
    await startPicking(db, id, { now: at(M) })
    await applyStockRead(db, { productId: a, countBase: 2, requestSentAt: at(2 * M) }, { now: at(2 * M) })
    await processAllocateEvents(db, { now: at(2 * M) })
    expect(await db.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(1) // 25c: w trakcie zbierania pominięte
    expect(await cancelPicking(db, id, { now: at(3 * M) })).toBe('DO_REALIZACJI')
    await processAllocateEvents(db, { now: at(3 * M) })
    expect(await db.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).flags).toMatchObject({ brakuje: false })
    await expectInvariants(db)
  })

  it('anulowanie odłożone (faktura w drodze) blokuje ruch naprzód', async () => {
    const a = await product(db, 'A', 5)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    await packOrder(db, id, { now: T0 })
    const wf = new FakeWfirma()
    wf.next = ['TIMEOUT_NO_CREATE']
    expect(await issueInvoice(db, id, wf, { now: at(M) })).toBe('TIMEOUT')
    await cancelOrder(db, id, { now: at(2 * M) })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).pendingAction).toBe('CANCEL:CANCELLED')
    await expect(readyForDispatch(db, id)).rejects.toThrow(/Anulowanie w toku/)
  })
})
