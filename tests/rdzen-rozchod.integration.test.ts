// Rdzeń: faktura, lustro wFirmy, rozchód (spec 11: 20–24m bez 24l/24m, 26–29, 44, 44d). Atrapa wFirmy w pamięci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { markMissingOnShelf, moveToShortageByOffice, rejectShortagesAtAcceptance, shipLater } from '@/lib/rdzen/brakuje'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { runFanout } from '@/lib/rdzen/propagacja'
import { allocate } from '@/lib/rdzen/przydzial'
import {
  applyBlInvoice,
  applyBlShippedWithoutInvoice,
  type FakturyWfirma,
  issueInvoice,
  officeConfirmManual,
  packOrder,
  recordCorrection,
  resolveUnknownInvoices,
  shipWithoutInvoice,
} from '@/lib/rdzen/rozchod'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const S = 1000
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

async function paidPacked(lines: { productId: string; qty: number }[], over = {}) {
  const r = await ingestOrder(db, order(lines, over), { now: T0 })
  await packOrder(db, r.orderId!, { now: T0 })
  return r.orderId!
}

const changes = () => db.outboxEvent.count({ where: { kind: 'AVAILABLE_CHANGED' } })

describe('faktura i rozchód', () => {
  it('20: przed wywołaniem ruch IN_FLIGHT i rezerwacje CONSUMING (available bez zmian) → CONSUMED, APPLIED; bez propagacji', async () => {
    const a = await product(db, 'A', 10)
    const id = await paidPacked([{ productId: a, qty: 2 }])
    const before = await changes()
    const seen: unknown[] = []
    const wf = new FakeWfirma()
    const spy: FakturyWfirma = {
      issue: async (req) => {
        const m = await db.pendingMovement.findMany({ where: { productId: a } })
        const r = await db.reservation.findMany({ where: { orderId: id } })
        seen.push({ moves: m.map((x) => x.state), res: r.map((x) => x.state), stock: await stockOf(db, a) })
        return wf.issue(req)
      },
      findByPrefix: (p) => wf.findByPrefix(p),
    }
    expect(await issueInvoice(db, id, spy, { now: at(S) })).toBe('WYSTAWIONA')
    expect(seen[0]).toMatchObject({ moves: ['IN_FLIGHT'], res: ['CONSUMING'], stock: { physical: 8, reserved: 0, available: 8, pendingDelta: -2 } })
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: id } })).state).toBe('CONSUMED')
    expect((await db.pendingMovement.findFirstOrThrow({ where: { productId: a } })).state).toBe('APPLIED')
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, available: 8 })
    expect(await changes()).toBe(before)
    expect(wf.invoices[0]!.idExternal).toBe(`${id}/1/1`)
    await expectInvariants(db)
  })

  it('21: jednoznaczny błąd → ruch CANCELLED, rezerwacje ACTIVE, physical wraca, flaga; inne zamówienia fakturują się dalej', async () => {
    const a = await product(db, 'A', 10)
    const id1 = await paidPacked([{ productId: a, qty: 2 }])
    const id2 = await paidPacked([{ productId: a, qty: 3 }])
    const wf = new FakeWfirma()
    wf.next = ['ERROR', 'OK']
    const out = []
    for (const id of [id1, id2]) out.push(await issueInvoice(db, id, wf, { now: at(S) }))
    expect(out).toEqual(['BLAD', 'WYSTAWIONA'])
    expect((await db.pendingMovement.findFirstOrThrow({ where: { orderId: id1 } })).state).toBe('CANCELLED')
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: id1 } })).state).toBe('ACTIVE')
    const o1 = await db.order.findUniqueOrThrow({ where: { id: id1 } })
    expect(o1.status).toBe('SPAKOWANE')
    expect((o1.flags as { fakturaBlad?: boolean }).fakturaBlad).toBe(true)
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, reserved: 2, available: 5 })
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD' } })).toBe(1)
    await expectInvariants(db)
  })

  it('22 i 24e: timeout, ponowienie → atrapa ma fakturę z id_external → druga faktura nie powstaje', async () => {
    const a = await product(db, 'A', 10)
    const id = await paidPacked([{ productId: a, qty: 2 }])
    const wf = new FakeWfirma()
    wf.next = ['TIMEOUT_AFTER_CREATE']
    expect(await issueInvoice(db, id, wf, { now: at(S) })).toBe('TIMEOUT')
    expect((await db.pendingMovement.findFirstOrThrow({ where: { orderId: id } })).state).toBe('IN_FLIGHT')
    expect(await issueInvoice(db, id, wf, { now: at(2 * S) })).toBe('W_TOKU') // nie wysyła drugi raz
    expect((await resolveUnknownInvoices(db, wf, { now: at(10 * S) })).found).toBe(0) // za wcześnie (30 s)
    expect((await resolveUnknownInvoices(db, wf, { now: at(31 * S) })).found).toBe(1)
    expect(wf.invoices).toHaveLength(1)
    expect(wf.calls).toBe(1)
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: id } })).state).toBe('CONSUMED')
    await expectInvariants(db)
  })

  it('24e (druga gałąź): nie znajduje po 3 próbach → CANCELLED i nowa faktura z kolejnym numerem próby', async () => {
    const a = await product(db, 'A', 10)
    const id = await paidPacked([{ productId: a, qty: 2 }])
    const wf = new FakeWfirma()
    wf.next = ['TIMEOUT_NO_CREATE', 'OK']
    await issueInvoice(db, id, wf, { now: at(0) })
    await resolveUnknownInvoices(db, wf, { now: at(30 * S) })
    await resolveUnknownInvoices(db, wf, { now: at(2 * M) })
    const r = await resolveUnknownInvoices(db, wf, { now: at(5 * M) })
    expect(r.retried).toBe(1)
    expect(wf.invoices.map((i) => i.idExternal)).toEqual([`${id}/1/2`])
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: id } })).state).toBe('CONSUMED')
    await expectInvariants(db)
  })

  it('24k: find znajduje fakturę dopiero w drugiej próbie → brak drugiej faktury; dwie faktury na <orderId>/<n> → alert dubletu', async () => {
    const a = await product(db, 'A', 10)
    const id = await paidPacked([{ productId: a, qty: 2 }])
    const wf = new FakeWfirma()
    wf.next = ['TIMEOUT_AFTER_CREATE']
    let visibleFrom = Infinity
    const slow: FakturyWfirma = { issue: (r) => wf.issue(r), findByPrefix: async (p) => (Date.now() >= visibleFrom ? wf.findByPrefix(p) : []) }
    await issueInvoice(db, id, slow, { now: at(0) })
    expect((await resolveUnknownInvoices(db, slow, { now: at(30 * S) })).waiting).toBe(1)
    visibleFrom = 0
    expect((await resolveUnknownInvoices(db, slow, { now: at(2 * M) })).found).toBe(1)
    expect(wf.invoices).toHaveLength(1)
    // dublet: atrapa ma dwie faktury dla tej samej paczki innego zamówienia
    const id2 = await paidPacked([{ productId: a, qty: 1 }])
    const wf2 = new FakeWfirma()
    wf2.next = ['TIMEOUT_AFTER_CREATE']
    await issueInvoice(db, id2, wf2, { now: at(0) })
    wf2.invoices.push({ ...wf2.invoices[0]!, docId: 'FV/dubel', idExternal: `${id2}/1/9` })
    await resolveUnknownInvoices(db, wf2, { now: at(31 * S) })
    expect(await db.alert.count({ where: { kind: 'DUBLET_FAKTURY' } })).toBe(1)
    await expectInvariants(db)
  })

  it('28: „wyślij bez faktury” → CONSUMED + ruch MANUAL do kliknięcia biura, stan odjęty od razu', async () => {
    const a = await product(db, 'A', 10)
    const id = await paidPacked([{ productId: a, qty: 2 }])
    await shipWithoutInvoice(db, id, { now: at(S) })
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: id } })).state).toBe('CONSUMED')
    const m = await db.pendingMovement.findFirstOrThrow({ where: { orderId: id } })
    expect(m).toMatchObject({ type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' })
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, available: 8 })
    expect(await db.alert.count({ where: { kind: 'WYDANE_BEZ_DOKUMENTU' } })).toBe(1)
    await expectInvariants(db)
  })

  it('27a i 27b: pobranie z brakiem → COD_REDUCED; opłacone z brakiem → REFUND_PENDING, późniejsza dostawa go nie bierze', async () => {
    const a = await product(db, 'A', 1)
    const cod = await ingestOrder(db, order([{ productId: a, qty: 2 }], { paymentState: 'COD' }), { now: T0 })
    expect((await packOrder(db, cod.orderId!, { now: T0 })).codReduced).toBe(1)
    expect((await db.shortage.findFirstOrThrow({ where: { orderId: cod.orderId! } })).state).toBe('COD_REDUCED')
    const b = await product(db, 'B', 1)
    const paid = await ingestOrder(db, order([{ productId: b, qty: 2 }]), { now: T0 })
    expect((await packOrder(db, paid.orderId!, { now: T0 })).refund).toBe(1)
    await applyStockRead(db, { productId: b, countBase: 5, requestSentAt: at(M) }, { now: at(M) })
    await allocate(db, b, { now: at(M) })
    expect((await db.shortage.findFirstOrThrow({ where: { orderId: paid.orderId! } })).state).toBe('REFUND_PENDING')
    await expectInvariants(db)
  })

  it('27c: „dośle później” → podzamówienie z własną fakturą <orderId>/2; ponowienie drugiej paczki nie widzi faktury pierwszej', async () => {
    const a = await product(db, 'A', 1)
    const b = await product(db, 'B', 0)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: b, qty: 1 }]), { now: T0 })
    const lineB = await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId!, productId: b } })
    const { childOrderId } = await shipLater(db, lineB.id, { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    const wf = new FakeWfirma()
    await issueInvoice(db, r.orderId!, wf, { now: at(S) })
    await applyStockRead(db, { productId: b, countBase: 1, requestSentAt: at(M) }, { now: at(M) })
    await allocate(db, b, { now: at(M) })
    await packOrder(db, childOrderId, { now: at(2 * M) })
    wf.next = ['TIMEOUT_NO_CREATE', 'OK']
    await issueInvoice(db, childOrderId, wf, { now: at(2 * M) })
    const res = await resolveUnknownInvoices(db, wf, { now: at(2 * M + 31 * S) })
    expect(res.found).toBe(0) // faktura pierwszej paczki (<orderId>/1/) nie pasuje do <orderId>/2/
    expect(wf.invoices.map((i) => i.idExternal)).toEqual([`${r.orderId}/1/1`])
    await resolveUnknownInvoices(db, wf, { now: at(2 * M + 2 * M) })
    await resolveUnknownInvoices(db, wf, { now: at(2 * M + 5 * M) })
    expect(wf.invoices.map((i) => i.idExternal)).toEqual([`${r.orderId}/1/1`, `${r.orderId}/2/2`])
    await expectInvariants(db)
  })

  it('29: anulowanie przed fakturą → zwolnienie; po fakturze → „do korekty”, stan bez zmian; korekta → historia + odczyt', async () => {
    const a = await product(db, 'A', 10)
    const r1 = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await cancelOrder(db, r1.orderId!, { now: T0 })
    expect((await stockOf(db, a)).reserved).toBe(0)
    const id = await paidPacked([{ productId: a, qty: 3 }])
    await issueInvoice(db, id, new FakeWfirma(), { now: at(S) })
    await cancelOrder(db, id, { now: at(2 * S) })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o.status).toBe('ANULOWANE')
    expect((o.flags as { doKorekty?: boolean }).doKorekty).toBe(true)
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, available: 7 })
    await recordCorrection(db, id, 'KOR/1', [{ productId: a, qty: 3 }], { now: at(M) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, pendingDelta: -3 }) // bez ruchu dodatniego
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: a } })).toBeGreaterThan(0)
    await expectInvariants(db)
  })
})

describe('lustro wFirmy', () => {
  async function invoiced(stock: number, qty: number, wf = new FakeWfirma(), when = at(S)) {
    const a = await product(db, 'A', stock)
    const id = await paidPacked([{ productId: a, qty }])
    await issueInvoice(db, id, wf, { now: when })
    return { a, id }
  }

  it('23: odczyt celowany 2 s po odpowiedzi na fakturę → ruch potwierdzony, bez podwójnego odjęcia', async () => {
    const { a } = await invoiced(10, 2)
    const r = await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(3 * S) }, { now: at(4 * S) })
    expect(r).toMatchObject({ outcome: 'ZAPISANY', confirmed: 1, physicalAfter: 8 })
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, pendingDelta: 0, available: 8 })
    expect(await db.shortage.count()).toBe(0)
    await expectInvariants(db)
  })

  it('24: odczyt wysłany przed fakturą, odpowiedź po → niepotwierdzony, chwilowo niżej; następny odczyt potwierdza bez skoku ponad stan', async () => {
    const { a } = await invoiced(10, 2, new FakeWfirma(), at(5 * S))
    const r1 = await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(4 * S) }, { now: at(6 * S) })
    expect(r1.confirmed).toBe(0)
    expect((await stockOf(db, a)).physical).toBe(6)
    const r2 = await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(7 * S) }, { now: at(8 * S) })
    expect(r2.confirmed).toBe(1)
    expect((await stockOf(db, a)).physical).toBe(8)
    await expectInvariants(db)
  })

  it('24a: odczyt z requestSentAt starszym niż zapisany wfirmaReadAt → odrzucony', async () => {
    const a = await product(db, 'A', 10)
    await applyStockRead(db, { productId: a, countBase: 9, requestSentAt: at(10 * S) }, { now: at(11 * S) })
    expect((await applyStockRead(db, { productId: a, countBase: 50, requestSentAt: at(5 * S) }, { now: at(12 * S) })).outcome).toBe('ODRZUCONY_STARSZY')
    expect((await stockOf(db, a)).physical).toBe(9)
  })

  it('24b: atrapa wFirmy z zegarem przesuniętym o ±10 min → wynik identyczny', async () => {
    const results: unknown[] = []
    for (const skew of [0, 10 * M, -10 * M]) {
      await truncateAll(db)
      await seedBase(db)
      const wf = new FakeWfirma()
      wf.clockSkewMs = skew
      const { a } = await invoiced(10, 2, wf)
      await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(3 * S) }, { now: at(4 * S) })
      const s = await stockOf(db, a)
      results.push([s.physical, s.pendingDelta, s.reserved])
    }
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
  }, 30_000) // 3 × TRUNCATE + seed: przy obciążonym komputerze ponad domyślne 5 s (25.10: na main 6b298ee też 8–11 s)

  it('24c: faktura bez WZ i z WZ na część → MANUAL, odczyt bez spadku nie podnosi available; „poprawione” nie potwierdza, robi to odczyt po kliknięciu', async () => {
    const x = await product(db, 'X', 10)
    const y = await product(db, 'Y', 10)
    const id = await paidPacked([{ productId: x, qty: 5 }, { productId: y, qty: 5 }])
    const wf = new FakeWfirma()
    wf.wzOverride = (p, q) => (p === x ? 0 : p === y ? 2 : q)
    await issueInvoice(db, id, wf, { now: at(S) })
    const moves = await db.pendingMovement.findMany({ orderBy: { delta: 'asc' } })
    expect(moves.map((m) => `${m.productId === x ? 'X' : 'Y'}:${m.state}:${m.delta}`).sort()).toEqual(['X:MANUAL:-5', 'Y:APPLIED:-2', 'Y:MANUAL:-3'])
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BEZ_WZ' } })).toBe(1)
    await applyStockRead(db, { productId: x, countBase: 10, requestSentAt: at(2 * S) }, { now: at(2 * S) }) // wFirma bez spadku
    await applyStockRead(db, { productId: y, countBase: 8, requestSentAt: at(2 * S) }, { now: at(2 * S) })
    expect(await stockOf(db, x)).toMatchObject({ physical: 5, available: 5 })
    expect(await stockOf(db, y)).toMatchObject({ physical: 5, available: 5 })
    const mx = moves.find((m) => m.productId === x)!
    await officeConfirmManual(db, mx.id, { now: at(M) })
    expect((await db.pendingMovement.findUniqueOrThrow({ where: { id: mx.id } })).state).toBe('APPLIED')
    // odczyt wysłany przed kliknięciem (biuro poprawiło w wFirmie: count 5) → nie potwierdza
    await applyStockRead(db, { productId: x, countBase: 5, requestSentAt: at(M - S) }, { now: at(M + S) })
    expect((await stockOf(db, x)).physical).toBe(0) // podwójnie odjęte, bezpiecznie
    await applyStockRead(db, { productId: x, countBase: 5, requestSentAt: at(M + 2 * S) }, { now: at(M + 3 * S) })
    expect(await stockOf(db, x)).toMatchObject({ physical: 5, pendingDelta: 0 })
    await expectInvariants(db)
  })

  it('24d: odczyt innego zamówienia między sentAt a odpowiedzią faktury → IN_FLIGHT niepotwierdzony, rezerwacje bez zmian; następny odczyt wyrównuje', async () => {
    const a = await product(db, 'A', 10)
    const id = await paidPacked([{ productId: a, qty: 2 }])
    const other = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    const wf = new FakeWfirma()
    const mid: FakturyWfirma = {
      issue: async (req) => {
        await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(2 * S) }, { now: at(2 * S) })
        return wf.issue(req)
      },
      findByPrefix: (p) => wf.findByPrefix(p),
    }
    await issueInvoice(db, id, mid, { now: at(S) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 6, reserved: 1 }) // 8 − 2 (podwójnie)
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: other.orderId! } })).state).toBe('ACTIVE')
    await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(5 * S) }, { now: at(5 * S) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, reserved: 1, available: 7 })
    await expectInvariants(db)
  })

  it('24f: spadek (faktura BL) widziany przed fakturą BL → overcommitSince, available 0, bez przenoszenia; po fakturze i odczycie zdjęte', async () => {
    const a = await product(db, 'A', 2)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await applyStockRead(db, { productId: a, countBase: 0, requestSentAt: at(M) }, { now: at(M) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 0, reserved: 2, available: 0 })
    expect((await stockOf(db, a)).overcommitSince).not.toBeNull()
    expect(await db.shortage.count()).toBe(0)
    await applyBlInvoice(db, r.orderId!, 'FV/BL/1', { [a]: 2 }, { now: at(3 * M) })
    await applyStockRead(db, { productId: a, countBase: 0, requestSentAt: at(4 * M) }, { now: at(4 * M) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 0, reserved: 0, overcommitSince: null })
    await expectInvariants(db)
  })

  it('24g i 26: nadmiar w 2 odczytach ≥ 30 min, ruchy z chwili pierwszego potwierdzone → lista „Nadmiar”, mimo nowych faktur; przeniesienie tylko przyciskiem', async () => {
    const a = await product(db, 'A', 5)
    const rA = await ingestOrder(db, order([{ productId: a, qty: 3 }]), { now: T0 })
    const rB = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await applyStockRead(db, { productId: a, countBase: 3, requestSentAt: at(M) }, { now: at(M) }) // faktura spoza systemu −2
    expect((await stockOf(db, a)).overcommitListedAt).toBeNull()
    await packOrder(db, rA.orderId!, { now: at(10 * M) })
    await issueInvoice(db, rA.orderId!, new FakeWfirma(), { now: at(10 * M) })
    const r2 = await applyStockRead(db, { productId: a, countBase: 0, requestSentAt: at(36 * M) }, { now: at(36 * M) })
    expect(r2.listedOvercommit).toBe(true)
    expect(await db.alert.count({ where: { kind: 'NADMIAR_REZERWACJI' } })).toBe(1)
    expect((await db.reservation.findFirstOrThrow({ where: { orderId: rB.orderId!, state: 'ACTIVE' } })).qtyBase).toBe(2) // nietknięte
    const lineB = await db.orderLine.findFirstOrThrow({ where: { orderId: rB.orderId! } })
    await moveToShortageByOffice(db, lineB.id, a, 2, { now: at(40 * M) })
    expect(await db.shortage.count({ where: { orderId: rB.orderId!, state: 'OPEN' } })).toBe(1)
    await applyStockRead(db, { productId: a, countBase: 0, requestSentAt: at(41 * M) }, { now: at(41 * M) })
    expect((await stockOf(db, a)).overcommitSince).toBeNull()
    await expectInvariants(db)
  })

  it('24h: korekta (+3) i równoległy odczyt sprzed odpowiedzi korekty → physical = nowy count, available nigdy ponad półkę; wzrost przez allocate', async () => {
    const { a, id } = await invoiced(10, 3)
    await applyStockRead(db, { productId: a, countBase: 7, requestSentAt: at(2 * S) }, { now: at(2 * S) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, pendingDelta: 0 })
    // odczyt wysłany przed odpowiedzią korekty, wFirma już ją przetworzyła (count 10)
    await applyStockRead(db, { productId: a, countBase: 10, requestSentAt: at(M) }, { now: at(M + S) })
    await recordCorrection(db, id, 'KOR/7', [{ productId: a, qty: 3 }], { now: at(M + 2 * S) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 10, pendingDelta: 0, available: 10 })
    await applyStockRead(db, { productId: a, countBase: 10, requestSentAt: at(2 * M) }, { now: at(2 * M) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 10, pendingDelta: 0, available: 10 })
    expect((await stockOf(db, a)).allocationPendingSince).not.toBeNull()
    expect(await db.outboxEvent.count({ where: { kind: 'ALLOCATE', productId: a } })).toBe(1)
    expect(await db.stockMovement.count({ where: { productId: a, source: 'OWN_CORRECTION' } })).toBe(1)
    await expectInvariants(db)
  })

  it('24i: „nie ma na półce” przy physical 1, reserved 1 → Shortage OPEN, ruch STOCK_MISSING, available 0, kanały bez wzrostu', async () => {
    const a = await product(db, 'A', 1)
    const r = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    await runFanout(db, { now: T0 })
    const ev = await changes()
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId! } })
    await markMissingOnShelf(db, line.id, a, 1, { now: at(M) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 0, reserved: 0, available: 0, pendingDelta: -1 })
    expect((await db.pendingMovement.findFirstOrThrow({ where: { productId: a } })).type).toBe('STOCK_MISSING')
    expect(await db.shortage.count({ where: { state: 'OPEN' } })).toBe(1)
    expect(await changes()).toBe(ev)
    await expectInvariants(db)
  })

  it('24j: anulowanie w trakcie wystawiania faktury: faktura wychodzi → tor korekty (T6); faktura pada → zwolnienie (T5)', async () => {
    const a = await product(db, 'A', 10)
    for (const mode of ['OK', 'ERROR'] as const) {
      const id = await paidPacked([{ productId: a, qty: 2 }])
      const wf = new FakeWfirma()
      wf.next = [mode]
      const hook: FakturyWfirma = {
        issue: async (req) => {
          expect(await cancelOrder(db, id, { now: at(S) })).toBe('SPAKOWANE') // odłożone
          return wf.issue(req)
        },
        findByPrefix: (p) => wf.findByPrefix(p),
      }
      await issueInvoice(db, id, hook, { now: at(S) })
      const o = await db.order.findUniqueOrThrow({ where: { id } })
      expect(o.status).toBe('ANULOWANE')
      expect(await db.reservation.count({ where: { orderId: id, state: { in: ['ACTIVE', 'CONSUMING'] } } })).toBe(0)
      expect(Boolean((o.flags as { doKorekty?: boolean }).doKorekty)).toBe(mode === 'OK')
    }
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0, physical: 8 })
    await expectInvariants(db)
  })
})

describe('tryb cienia i Empik', () => {
  it('44: faktura BL → CONSUMED + ruch niepotwierdzony; odczyt po fakturze → potwierdzony; BL „Wysłane” bez faktury → MANUAL w raporcie', async () => {
    const a = await product(db, 'A', 10)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    await applyBlInvoice(db, r.orderId!, 'FV/BL/9', { [a]: 2 }, { now: at(M) })
    expect((await db.pendingMovement.findFirstOrThrow({ where: { orderId: r.orderId! } })).state).toBe('APPLIED')
    await applyStockRead(db, { productId: a, countBase: 8, requestSentAt: at(2 * M) }, { now: at(2 * M) })
    expect((await db.pendingMovement.findFirstOrThrow({ where: { orderId: r.orderId! } })).state).toBe('CONFIRMED')
    const r2 = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    await applyBlShippedWithoutInvoice(db, r2.orderId!, { now: at(3 * M) })
    expect(await db.reservation.count({ where: { orderId: r2.orderId!, state: 'ACTIVE' } })).toBe(0)
    expect((await db.pendingMovement.findFirstOrThrow({ where: { orderId: r2.orderId! } })).state).toBe('MANUAL')
    await applyBlInvoice(db, r2.orderId!, 'FV/BL/10', { [a]: 1 }, { now: at(4 * M) })
    expect((await db.pendingMovement.findFirstOrThrow({ where: { orderId: r2.orderId! } })).type).toBe('BL_INVOICE')
    await expectInvariants(db)
  })

  it('44d: Empik — pozycje z brakiem odrzucone przy akceptacji: qtyRejected, Shortage CANCELLED, niezmiennik 4', async () => {
    const a = await product(db, 'A', 1)
    const r = await ingestOrder(db, order([{ productId: a, qty: 3 }], { channel: 'EMPIK', deliveryMethod: 'Dostawa do Salonu Empik' }), { now: T0 })
    expect(await rejectShortagesAtAcceptance(db, r.orderId!, { now: T0 })).toBe(2)
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId! } })).qtyRejected).toBe(2)
    await expectInvariants(db)
  })
})
