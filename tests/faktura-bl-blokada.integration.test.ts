// Zamówienie z fakturą wystawioną w BaseLinkerze nigdy nie dostaje drugiej faktury z Kompletora: ani z kolejki
// faktur po spakowaniu, ani przez automat „bez paczki” (pozycja cyfrowa), ani dla paczki dodatkowej. Dane fikcyjne,
// atrapa programu do faktur, zero połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { FAKTURA_BL_POMINIETA, fakturaZBl, pakujMimoFakturyBl } from '@/lib/rdzen/faktura-bl'
import { startPicking } from '@/lib/rdzen/przejscia'
import { applyBlInvoice, beginInvoice, issueInvoice, packOrder, ponowFaktureRecznie } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const EBOOK_DELIVERY = 'Dostawa elektroniczna (test)'
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)
let blSeq = 9000

async function digital(sku: string): Promise<string> {
  return (await db.product.create({ data: { sku, kind: 'DIGITAL', unit: 'SZT', nameAccounting: `E-book ${sku}`, title: `E-book ${sku}`, vatRate: '5' } })).id
}

async function pracaEmpik(): Promise<void> {
  await db.channelConfig.updateMany({ where: { channel: 'EMPIK', channelAccountId: 'empik' }, data: { statusMode: 'PRACA' } })
}

/** Zamówienie z numerem BL i kopią faktury BL (tak, jak zostawia ją odczyt faktur BL). */
async function zFakturaBl(orderId: string, opts: { kind?: string | null; number?: string } = {}): Promise<number> {
  const blOrderId = ++blSeq
  await db.order.update({ where: { id: orderId }, data: { blOrderId } })
  await db.blInvoiceSnapshot.create({
    data: { blInvoiceId: blOrderId, blOrderId, number: opts.number ?? `FV/BL/${blOrderId}`, kind: opts.kind === undefined ? 'normal' : opts.kind, dateAdd: at(-60 * M), fetchedAt: at(-59 * M) },
  })
  return blOrderId
}

const pominiete = (orderId: string) => db.orderEvent.count({ where: { orderId, kind: FAKTURA_BL_POMINIETA } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('blokada drugiej faktury po fakturze BL', () => {
  it('mieszane (towar + e-book) rozliczone fakturą BL: automat „bez paczki” nie pakuje, kolejka nie fakturuje', async () => {
    await pracaEmpik()
    const ebook = await digital('ebook-fbl1')
    const tea = await product(db, 'HERB-FBL1', 5)
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 29.9 }, { productId: tea, qty: 2 }], { channel: 'EMPIK' }), { now: T0 })
    const id = r.orderId!
    await applyBlInvoice(db, id, 'FV/BL/1', { [tea]: 2 }, { now: at(M) }) // rezerwacje CONSUMED, zdarzenie FAKTURA_BL
    expect(await db.reservation.count({ where: { orderId: id, state: 'ACTIVE' } })).toBe(0)

    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: at(2 * M) })
    await runWfirmaQueue(db, { faktury: wf }, { now: at(3 * M) })
    expect(wf.invoices).toHaveLength(0)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
    expect(await db.invoiceAttempt.count({ where: { orderId: id } })).toBe(0)
    await expectInvariants(db)
  })

  it('sam e-book z kopią faktury BL (bez zdarzenia): automat nie pakuje, ślad w historii raz', async () => {
    await pracaEmpik()
    const ebook = await digital('ebook-fbl2')
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { channel: 'EMPIK', deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    const id = r.orderId!
    await zFakturaBl(id, { number: 'FV/BL/2' })
    // zamówienie obok bez faktury BL idzie normalnie (blokada nie zatrzymuje reszty)
    const czyste = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { channel: 'EMPIK', deliveryMethod: EBOOK_DELIVERY }), { now: T0 })

    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: at(M) })
    await runWfirmaQueue(db, { faktury: wf }, { now: at(2 * M) })
    expect(wf.invoices).toHaveLength(1)
    expect((await db.order.findUniqueOrThrow({ where: { id: czyste.orderId! } })).status).toBe('ODEBRANE')
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
    expect(await pominiete(id)).toBe(1)
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: FAKTURA_BL_POMINIETA } })
    expect(ev.data).toMatchObject({ numer: 'FV/BL/2' })
  })

  it('spakowane ręcznie po fakturze BL czekającej na WZ (rezerwacja aktywna): faktura odmówiona bez ruchu stanu, kolejka nie wraca', async () => {
    const tea = await product(db, 'HERB-FBL3', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 2 }]), { now: T0 })
    const id = r.orderId!
    await zFakturaBl(id)
    expect(await startPicking(db, id, { now: T0 })).toBe('ZBIERANIE')
    await packOrder(db, id, { now: T0 })

    expect(await beginInvoice(db, id, { now: at(M) })).toEqual({ outcome: 'FAKTURA_BL' })
    expect(await db.pendingMovement.count({ where: { orderId: id } })).toBe(0)
    expect(await db.reservation.count({ where: { orderId: id, state: 'ACTIVE' } })).toBe(1)
    expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 2, pendingDelta: 0 })

    const wf = new FakeWfirma()
    expect(await issueInvoice(db, id, wf, { now: at(2 * M) })).toBe('FAKTURA_BL')
    await runWfirmaQueue(db, { faktury: wf }, { now: at(3 * M) })
    await runWfirmaQueue(db, { faktury: wf }, { now: at(4 * M) })
    expect(wf.invoices).toHaveLength(0)
    expect(await pominiete(id)).toBe(1)
    await expectInvariants(db)
  })

  it('mieszane spakowane ręcznie po rozliczonej fakturze BL: kolejka nie wystawia faktury usługi', async () => {
    await pracaEmpik()
    const ebook = await digital('ebook-fbl4')
    const tea = await product(db, 'HERB-FBL4', 5)
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1 }, { productId: tea, qty: 1 }], { channel: 'EMPIK' }), { now: T0 })
    const id = r.orderId!
    await applyBlInvoice(db, id, 'FV/BL/4', { [tea]: 1 }, { now: at(M) })
    // tryb pracy: pakowanie po fakturze BL wymaga świadomego odblokowania z karty
    await expect(packOrder(db, id, { now: at(2 * M) })).rejects.toThrow(/wstrzymał pakowanie/)
    expect(await pakujMimoFakturyBl(db, id, { now: at(2 * M) })).toBe(true)
    await packOrder(db, id, { now: at(2 * M) }) // bez rezerwacji ACTIVE pakuje się sama usługa
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: at(3 * M) })
    expect(wf.invoices).toHaveLength(0)
    expect(await pominiete(id)).toBe(1)
  })

  it('paczka dodatkowa zamówienia z fakturą BL: bez faktury z Kompletora', async () => {
    const tea = await product(db, 'HERB-FBL5', 5)
    const glowne = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    await applyBlInvoice(db, glowne.orderId!, 'FV/BL/5', { [tea]: 1 }, { now: at(M) })
    const dosle = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    await db.order.update({ where: { id: dosle.orderId! }, data: { parentOrderId: glowne.orderId! } })
    const o = await db.order.findUniqueOrThrow({ where: { id: dosle.orderId! } })
    expect(await fakturaZBl(db, o)).toBe('FV/BL/5')
    await startPicking(db, o.id, { now: T0 })
    await packOrder(db, o.id, { now: T0 })
    expect(await beginInvoice(db, o.id, { now: at(2 * M) })).toEqual({ outcome: 'FAKTURA_BL' })
  })

  it('sama korekta BL nie blokuje; zamówienie bez faktury BL dostaje fakturę jak dotąd', async () => {
    const tea = await product(db, 'HERB-FBL6', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    await zFakturaBl(r.orderId!, { kind: 'correcting' })
    expect(await fakturaZBl(db, await db.order.findUniqueOrThrow({ where: { id: r.orderId! } }))).toBeNull()
    await startPicking(db, r.orderId!, { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    const wf = new FakeWfirma()
    expect(await issueInvoice(db, r.orderId!, wf, { now: at(M) })).toBe('WYSTAWIONA')
    expect(wf.invoices).toHaveLength(1)
    expect(await pominiete(r.orderId!)).toBe(0)
    await expectInvariants(db)
  })

  it('„Ponów fakturę” przy zamówieniu z fakturą BL: odmowa z powodem, bez nowej serii prób', async () => {
    const tea = await product(db, 'HERB-FBL7', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    const id = r.orderId!
    await db.order.update({ where: { id }, data: { flags: { fakturaBlad: true } } })
    await zFakturaBl(id, { number: 'FV/BL/7' })
    await expect(ponowFaktureRecznie(db, id, { now: at(M), actorId: 'test' })).rejects.toThrow(/fakturę z BaseLinkera \(FV\/BL\/7\): Kompletor nie wystawi drugiej/)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'FAKTURA_PONOWIONA' } })).toBe(0)
  })
})
