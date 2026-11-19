// zamówienie bez wysyłki (sam e-book) na koncie w PRACA — przyjęcie bez „nieznanej metody dostawy”,
// spakowanie bez rezerwacji, faktura usługi na atrapie wFirmy, status końcowy bez kuriera. Dane fikcyjne, zero
// połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { rejectShortagesAtAcceptance } from '@/lib/rdzen/brakuje'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { finishWithoutShipping, moveOrder, readyForDispatch, startPicking } from '@/lib/rdzen/przejscia'
import { beginInvoice, completeInvoice, issueInvoice, PackError, packOrder, resolveUnknownInvoices } from '@/lib/rdzen/rozchod'
import { TransitionError } from '@/lib/rdzen/statusy'
import { cancelOrder, ingestOrder, resolveClarification } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const EBOOK_DELIVERY = 'Dostawa elektroniczna (test)' // nazwa metody bez reguły przewoźnika

async function digital(sku: string): Promise<string> {
  const p = await db.product.create({ data: { sku, kind: 'DIGITAL', unit: 'SZT', nameAccounting: `E-book ${sku}`, title: `E-book ${sku}`, vatRate: '5' } })
  return p.id
}

async function praca(channel: 'WOO' | 'EMPIK', channelAccountId: string): Promise<void> {
  await db.channelConfig.updateMany({ where: { channel, channelAccountId }, data: { statusMode: 'PRACA' } })
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('sam e-book na koncie w PRACA', () => {
  it('przyjęcie → BEZ_WYSYLKI bez rezerwacji → kolejka wFirmy: spakowane, faktura usługi, ODEBRANE; bez ruchu magazynowego', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw1')
    const tea = await product(db, 'HERB-BW1', 5) // osobny towar: stan ma się nie ruszyć
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 2, unitPriceGross: 29.9 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    expect(r).toMatchObject({ outcome: 'NOWE', status: 'DO_REALIZACJI', reservedUnits: 0, shortUnits: 0 })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o).toMatchObject({ carrier: 'BEZ_WYSYLKI', shippingModule: 'BRAK', deliveryMethod: EBOOK_DELIVERY, shortageWaitUntil: null })
    expect(JSON.stringify(o.flags)).not.toContain('nieznana metoda dostawy')
    expect(await db.reservation.count()).toBe(0)
    expect(await db.shortage.count()).toBe(0)

    // bez zbierania: T7 odmawia z komunikatem dla ekranu
    await expect(startPicking(db, o.id, { now: T0 })).rejects.toThrow(/bez wysyłki.*bez zbierania/)

    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(1)
    expect(wf.invoices[0]!.lines).toEqual([{ productId: ebook, qty: 2, unitGrossGr: 2990, vatRate: '5', service: true }])
    const done = await db.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(done.status).toBe('ODEBRANE')
    expect(await db.invoiceAttempt.findFirst({ where: { orderId: o.id } })).toMatchObject({ state: 'ISSUED', wfirmaDocId: 'FV/1' })
    const events = await db.orderEvent.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } })
    expect(events.find((e) => e.kind === 'SPAKOWANE')?.data).toMatchObject({ bezWysylki: true, braki: 0 })
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['PRZYJETE', 'SPAKOWANE', 'FAKTURA', 'ODEBRANE']))
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await db.reservation.count()).toBe(0)
    expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 0, pendingDelta: 0 })

    // drugi przebieg: nic nowego (bez drugiej faktury)
    await runWfirmaQueue(db, { faktury: wf }, { now: new Date(T0.getTime() + 60_000) })
    expect(wf.invoices).toHaveLength(1)
    await expectInvariants(db)
  })

  it('nieopłacone czeka w NOWE (bez spakowania i faktury); opłacone obok przechodzi do końca', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw2')
    const unpaid = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { deliveryMethod: EBOOK_DELIVERY, paymentState: 'UNPAID' }), { now: T0 })
    expect(unpaid.status).toBe('NOWE')
    const paid = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: unpaid.orderId! } })).status).toBe('NOWE')
    expect(wf.invoices).toHaveLength(1)
    expect((await db.order.findUniqueOrThrow({ where: { id: paid.orderId! } })).status).toBe('ODEBRANE')
    expect(await finishWithoutShipping(db, paid.orderId!, { now: T0 })).toBe('ODEBRANE') // ponowione kliknięcie: bez zmian
    await expectInvariants(db)
  })

  it('spakowane ręcznie: „Odebrane” dopiero po fakturze, „Do wysyłki” odmawia, faktura bez blokady stanu i ruchu', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw3')
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 19.9 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    await expect(finishWithoutShipping(db, r.orderId!, { now: T0 })).rejects.toThrow(/Najpierw faktura/)
    const b = await beginInvoice(db, r.orderId!, { now: T0 })
    expect(b).toMatchObject({ outcome: 'START', lines: [{ productId: ebook, qty: 1, unitGrossGr: 1990, service: true }] })
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await beginInvoice(db, r.orderId!, { now: T0 })).toEqual({ outcome: 'W_TOKU' })
    // pełny tor przez issueInvoice na osobnym zamówieniu
    const full = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 19.9 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    await packOrder(db, full.orderId!, { now: T0 })
    expect(await issueInvoice(db, full.orderId!, new FakeWfirma(), { now: T0 })).toBe('WYSTAWIONA')
    await expect(readyForDispatch(db, full.orderId!, { now: T0 })).rejects.toThrow(/bez wysyłki.*Odebrane/)
    expect(await finishWithoutShipping(db, full.orderId!, { now: T0 })).toBe('ODEBRANE')
    expect(await db.pendingMovement.count()).toBe(0)
    await expectInvariants(db)
  })

  it('anulowanie: w trakcie faktury usługi odłożone (po fakturze → do korekty), po fakturze od razu „do korekty”', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw11')
    const a = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    await packOrder(db, a.orderId!, { now: T0 })
    const b = await beginInvoice(db, a.orderId!, { now: T0 })
    if (b.outcome !== 'START') throw new Error(b.outcome)
    expect(await cancelOrder(db, a.orderId!, { now: T0 })).toBe('SPAKOWANE') // faktura w drodze: anulowanie czeka
    await completeInvoice(db, b.attemptId, 'FV/9', {}, { now: T0 })
    const ca = await db.order.findUniqueOrThrow({ where: { id: a.orderId! } })
    expect(ca).toMatchObject({ status: 'ANULOWANE', pendingAction: null })
    expect(ca.flags).toMatchObject({ doKorekty: true })

    const c = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    await runWfirmaQueue(db, { faktury: new FakeWfirma() }, { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: c.orderId! } })).status).toBe('ODEBRANE')
    expect(await cancelOrder(db, c.orderId!, { now: T0 })).toBe('ANULOWANE')
    expect((await db.order.findUniqueOrThrow({ where: { id: c.orderId! } })).flags).toMatchObject({ doKorekty: true })
    await expectInvariants(db)
  })

  it('edycja w kanale dodaje towar do zamówienia bez wysyłki → Do wyjaśnienia (paczka potrzebuje przewoźnika)', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw4')
    const tea = await product(db, 'HERB-BW4', 5)
    const first = order([{ productId: ebook, qty: 1 }], { deliveryMethod: EBOOK_DELIVERY })
    const r = await ingestOrder(db, first, { now: T0 })
    await ingestOrder(db, { ...first, externalRevision: '2', lines: [...first.lines, { externalLineId: 'L2', productId: tea, qty: 1, unitPriceGross: 10 }] }, { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o.status).toBe('DO_WYJASNIENIA')
    expect(JSON.stringify(o.flags)).toContain('towar w zamówieniu bez wysyłki')
    await expectInvariants(db)
  })

  it('e-book, edycja dokłada przyprawę, „wyjaśnione”: kolejka nie pakuje i nie fakturuje; dalej jak paczka przez zbieranie', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw12')
    const tea = await product(db, 'HERB-BW12', 5)
    const first = order([{ productId: ebook, qty: 1, unitPriceGross: 29.9 }], { deliveryMethod: EBOOK_DELIVERY })
    const r = await ingestOrder(db, first, { now: T0 })
    await ingestOrder(db, { ...first, externalRevision: '2', lines: [...first.lines, { externalLineId: 'L2', productId: tea, qty: 1, unitPriceGross: 10 }] }, { now: T0 })
    const id = r.orderId!
    // towar w zamówieniu bez wysyłki = „wyjaśnione” wymaga przewoźnika
    await expect(resolveClarification(db, id, { now: T0 })).rejects.toThrow(/wybierz przewoźnika/)
    expect(await resolveClarification(db, id, { now: T0, carrier: 'PACZKOMATY' })).toBe('DO_REALIZACJI')
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('PACZKOMATY')
    expect(await db.reservation.count({ where: { orderId: id, state: 'ACTIVE' } })).toBe(1)

    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
    expect(wf.invoices).toHaveLength(0)
    expect(await db.invoiceAttempt.count({ where: { orderId: id } })).toBe(0)
    expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 1 })

    // wyjście ręczne: zbieranie i spakowanie, faktura obu pozycji, „Do wysyłki”; „Odebrane” bez kuriera odmawia
    expect(await startPicking(db, id, { now: T0 })).toBe('ZBIERANIE')
    await packOrder(db, id, { now: T0 })
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(1)
    expect(wf.invoices[0]!.lines).toHaveLength(2)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('SPAKOWANE') // automat „Odebrane” nie dla towaru
    await expect(finishWithoutShipping(db, id, { now: T0 })).rejects.toThrow(/tylko dla zamówienia bez wysyłki/)
    expect(await readyForDispatch(db, id, { now: T0 })).toBe('DO_WYSLANIA')
    expect((await stockOf(db, tea)).physical).toBe(4)
    await expectInvariants(db)
  })

  describe('timeout faktury usługi', () => {
    const S = 1000
    const M = 60 * S
    const at = (ms: number) => new Date(T0.getTime() + ms)

    async function packedEbook(sku: string): Promise<string> {
      await praca('WOO', 'sd')
      const ebook = await digital(sku)
      const r = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
      await packOrder(db, r.orderId!, { now: T0 })
      return r.orderId!
    }

    it('TIMEOUT_AFTER_CREATE: find znajduje dokument, jedna faktura, ISSUED, koniec w ODEBRANE', async () => {
      const id = await packedEbook('ebook-bw13')
      const wf = new FakeWfirma()
      wf.next = ['TIMEOUT_AFTER_CREATE']
      expect(await issueInvoice(db, id, wf, { now: at(0) })).toBe('TIMEOUT')
      expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('UNKNOWN')
      expect((await resolveUnknownInvoices(db, wf, { now: at(30 * S) })).found).toBe(1)
      expect(wf.invoices).toHaveLength(1)
      expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('ISSUED')
      await runWfirmaQueue(db, { faktury: wf }, { now: at(M) })
      expect(wf.invoices).toHaveLength(1)
      expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('ODEBRANE')
      expect(await db.pendingMovement.count()).toBe(0)
      await expectInvariants(db)
    })

    it('TIMEOUT_NO_CREATE × 3 próby find: druga próba faktury, jedna faktura w wFirmie, koniec w ODEBRANE', async () => {
      const id = await packedEbook('ebook-bw14')
      const wf = new FakeWfirma()
      wf.next = ['TIMEOUT_NO_CREATE', 'OK']
      expect(await issueInvoice(db, id, wf, { now: at(0) })).toBe('TIMEOUT')
      expect((await resolveUnknownInvoices(db, wf, { now: at(30 * S) })).waiting).toBe(1)
      expect((await resolveUnknownInvoices(db, wf, { now: at(2 * M) })).waiting).toBe(1)
      expect((await resolveUnknownInvoices(db, wf, { now: at(5 * M) })).retried).toBe(1)
      expect(wf.invoices.map((i) => i.idExternal)).toEqual([`${id}/1/2`])
      const attempts = await db.invoiceAttempt.findMany({ where: { orderId: id }, orderBy: { attemptNo: 'asc' } })
      expect(attempts.map((a) => a.state)).toEqual(['FAILED', 'ISSUED'])
      await runWfirmaQueue(db, { faktury: wf }, { now: at(6 * M) })
      expect(wf.invoices).toHaveLength(1)
      expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('ODEBRANE')
      expect(await db.pendingMovement.count()).toBe(0)
      await expectInvariants(db)
    })
  })
})

describe('e-book i towar odrzucony w całości (Empik, PRACA)', () => {
  it('spakowanie bez rezerwacji z ekranu, faktura tylko usługi z kolejki, koniec przez „Odebrane”', async () => {
    await praca('EMPIK', 'empik')
    const ebook = await digital('ebook-bw5')
    const tea = await product(db, 'HERB-BW5', 0)
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 25 }, { productId: tea, qty: 2 }], { channel: 'EMPIK' }), { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o.carrier).toBe('PACZKOMATY') // mieszane: przewoźnik z metody dostawy, jak dotąd
    expect(await rejectShortagesAtAcceptance(db, o.id, { now: T0 })).toBe(2)

    // spakowanie z ekranu przed przebiegiem kolejki (automat bez wysyłki: tests/tryb-praca)
    const wf = new FakeWfirma()
    const packed = await packOrder(db, o.id, { now: T0 })
    expect(packed).toEqual({ status: 'SPAKOWANE', refund: 0, codReduced: 0 })
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(1)
    expect(wf.invoices[0]!.lines).toEqual([{ productId: ebook, qty: 1, unitGrossGr: 2500, vatRate: '5', service: true }])
    // koniec bez kuriera robi już automat (bez warunku przewoźnika); „Do wysyłki” i tak odmawia
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('ODEBRANE')
    await expect(moveOrder(db, o.id, 'DO_WYSLANIA', { now: T0 })).rejects.toThrow(/Niedozwolone/)
    expect(await finishWithoutShipping(db, o.id, { now: T0 })).toBe('ODEBRANE')
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await stockOf(db, tea)).toMatchObject({ physical: 0, reserved: 0, pendingDelta: 0 })
    await expectInvariants(db)
  })

  it('bez e-booka (sam odrzucony towar) dalej „Nic do spakowania”', async () => {
    await praca('EMPIK', 'empik')
    const tea = await product(db, 'HERB-BW6', 0)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 2 }], { channel: 'EMPIK' }), { now: T0 })
    await rejectShortagesAtAcceptance(db, r.orderId!, { now: T0 })
    await expect(packOrder(db, r.orderId!, { now: T0 })).rejects.toBeInstanceOf(PackError)
  })

  it('101 starszych zamówień bez usługi (towar odrzucony) nie zasłania nowszego z e-bookiem', async () => {
    await praca('EMPIK', 'empik')
    const ebook = await digital('ebook-bw8')
    const tea = await product(db, 'HERB-BW8', 0)
    for (let i = 0; i < 101; i++) {
      const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }], { channel: 'EMPIK', externalId: `EMP-STARE-${i}`, createdAtChannel: new Date(T0.getTime() - (200 - i) * 60_000) }), { now: T0 })
      await rejectShortagesAtAcceptance(db, r.orderId!, { now: T0 })
    }
    const nowe = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 25 }, { productId: tea, qty: 1 }], { channel: 'EMPIK', externalId: 'EMP-EBOOK', createdAtChannel: T0 }), { now: T0 })
    await rejectShortagesAtAcceptance(db, nowe.orderId!, { now: T0 })
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(1)
    expect(wf.invoices[0]!.lines).toEqual([{ productId: ebook, qty: 1, unitGrossGr: 2500, vatRate: '5', service: true }])
    expect((await db.order.findUniqueOrThrow({ where: { id: nowe.orderId! } })).status).toBe('ODEBRANE')
    expect(await db.order.count({ where: { status: 'DO_REALIZACJI' } })).toBe(101)
  }, 180_000)

  it('e-book z otwartym brakiem towaru: spakowanie bez rezerwacji odmawia', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw7')
    const tea = await product(db, 'HERB-BW7', 0)
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1 }, { productId: tea, qty: 1 }]), { now: T0 })
    await expect(packOrder(db, r.orderId!, { now: T0 })).rejects.toThrow(/Nic do spakowania/)
  })
})

describe('regresja', () => {
  it('mieszane (e-book + towar na stanie) w PRACA: przewoźnik z metody, zbieranie, faktura z usługą, wysyłka jak dotąd', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw8')
    const tea = await product(db, 'HERB-BW8', 5)
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 29.9 }, { productId: tea, qty: 2 }]), { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o).toMatchObject({ carrier: 'PACZKOMATY', status: 'DO_REALIZACJI' })
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(0)
    expect(await startPicking(db, o.id, { now: T0 })).toBe('ZBIERANIE')
    await packOrder(db, o.id, { now: T0 })
    await expect(finishWithoutShipping(db, o.id, { now: T0 })).rejects.toBeInstanceOf(TransitionError)
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(1)
    expect(wf.invoices[0]!.lines).toHaveLength(2)
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('SPAKOWANE') // bez automatu
    await expect(finishWithoutShipping(db, o.id, { now: T0 })).rejects.toThrow(/tylko dla zamówienia bez wysyłki/)
    expect(await readyForDispatch(db, o.id, { now: T0 })).toBe('DO_WYSLANIA')
    expect((await stockOf(db, tea)).physical).toBe(3)
    await expectInvariants(db)
  })

  it('sam e-book na koncie w CIEN: bez zmian — nieznana metoda dostawy → Do wyjaśnienia, kolejka niczego nie robi', async () => {
    const ebook = await digital('ebook-bw9')
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    expect(r.status).toBe('DO_WYJASNIENIA')
    const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o.carrier).toBe('BRAK')
    expect(JSON.stringify(o.flags)).toContain('nieznana metoda dostawy')
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(0)
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('DO_WYJASNIENIA')
  })

  it('sam e-book w PRACA ze znaną metodą dostawy: i tak bez wysyłki (rozpoznanie po rodzaju pozycji, nie po nazwie)', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-bw10')
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1 }], { deliveryMethod: 'Paczkomaty InPost' }), { now: T0 })
    expect((await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })).carrier).toBe('BEZ_WYSYLKI')
  })
})
