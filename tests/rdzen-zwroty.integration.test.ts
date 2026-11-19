// Rdzeń: zwroty i korekty (spec 3.5, 3.6, 4.5, 7.4 — przypadek 30 i warianty v1.5). Atrapa wFirmy w pamięci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { markShipped, readyForDispatch } from '@/lib/rdzen/przejscia'
import { issueInvoice, officeConfirmManual, packOrder } from '@/lib/rdzen/rozchod'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import {
  completeCorrection,
  confirmPz,
  createReturn,
  issueCorrection,
  listCorrectionsWithoutPz,
  listDamagedForRw,
  markReturnRefunded,
  receiveReturn,
  rejectReturn,
  requestCorrection,
  resolveUnknownCorrections,
  retryCorrection,
  ReturnError,
} from '@/lib/rdzen/zwroty'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { testDb, truncateAll } from './db'
import { bundle, expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const S = 1000
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

/** Zamówienie wysłane z fakturą (atrapa), potwierdzone odczytem wFirmy. Zwraca id zamówienia i pozycje. */
async function shipped(lines: { productId: string; qty: number }[], wf = new FakeWfirma()) {
  const { orderId } = await ingestOrder(db, order(lines), { now: T0 })
  const id = orderId!
  await packOrder(db, id, { now: T0 })
  expect(await issueInvoice(db, id, wf, { now: at(S) })).toBe('WYSTAWIONA')
  await readyForDispatch(db, id, { now: at(2 * S) })
  await markShipped(db, id, { now: at(3 * S) })
  // wFirma po WZ: odczyt potwierdza ruchy faktury (zestaw — jego składniki)
  for (const m of await db.pendingMovement.findMany({ where: { orderId: id, state: 'APPLIED' } })) {
    const s = await stockOf(db, m.productId)
    await applyStockRead(db, { productId: m.productId, countBase: s.wfirmaCount + m.delta, requestSentAt: at(10 * S) }, { now: at(10 * S) })
  }
  const ol = await db.orderLine.findMany({ where: { orderId: id }, orderBy: { externalLineId: 'asc' } })
  return { id, lines: ol, wf }
}

describe('zwroty (przypadek 30)', () => {
  it('30: zwrot 2× A „na stan” i 1× B „uszkodzone” → korekta przez atrapę; A bez ruchu dodatniego (wzrost pokaże odczyt i allocate), B od razu poza sprzedażą do RW', async () => {
    const a = await product(db, 'A', 10)
    const b = await product(db, 'B', 10)
    const { id, lines, wf } = await shipped([{ productId: a, qty: 3 }, { productId: b, qty: 2 }])
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, pendingDelta: 0 })
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 2 }, { orderLineId: lines[1]!.id, qty: 1 }], { now: at(M) })
    expect((await db.return.findUniqueOrThrow({ where: { id: rid } })).status).toBe('ZGLOSZONY')
    // drugi zwrot ponad to, co wyszło fakturą i nie jest już w zwrocie → odrzucony
    await expect(createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 2 }])).rejects.toThrow(/Za dużo do zwrotu/)
    await expect(requestCorrection(db, rid)).rejects.toThrow(/przyjętego/)
    const rl = await db.returnLine.findMany({ where: { returnId: rid } })
    await receiveReturn(db, rid, Object.fromEntries(rl.map((l) => [l.id, l.productId === a ? ('NA_STAN' as const) : ('USZKODZONE' as const)])), { now: at(2 * M) })
    await requestCorrection(db, rid, { now: at(2 * M) })
    const changesBefore = await db.outboxEvent.count({ where: { kind: 'AVAILABLE_CHANGED', productId: b } })
    expect(await issueCorrection(db, rid, wf, { now: at(3 * M) })).toBe('WYSTAWIONA')
    expect(wf.corrections).toHaveLength(1)
    expect(wf.corrections[0]).toMatchObject({ invoiceDocId: 'FV/1', idExternal: `zwrot/${rid}/1` })
    expect(wf.corrections[0]!.lines.sort((x, y) => x.qty - y.qty)).toEqual([{ productId: b, qty: 1 }, { productId: a, qty: 2 }])
    const r = await db.return.findUniqueOrThrow({ where: { id: rid } })
    expect(r).toMatchObject({ status: 'ZAKONCZONY', correctionState: 'ISSUED', correctionDocId: 'KOR/1' })
    // A: tylko historia i zlecony odczyt — bez ruchu dodatniego (2.2 pkt 3)
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, pendingDelta: 0 })
    expect(await db.stockMovement.findFirst({ where: { productId: a, source: 'OWN_CORRECTION' } })).toMatchObject({ deltaPhysical: 0 })
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: a, processedAt: null } })).toBeGreaterThan(0)
    // B: korekta z PZ przywraca uszkodzoną sztukę na stan wFirmy → od razu −1 (kanały), lista „uszkodzone do RW”
    expect(await stockOf(db, b)).toMatchObject({ physical: 7, pendingDelta: -1, available: 7 })
    expect(await db.outboxEvent.count({ where: { kind: 'AVAILABLE_CHANGED', productId: b } })).toBe(changesBefore + 1)
    const rw = await listDamagedForRw(db)
    expect(rw.map((m) => [m.productId, m.delta, m.state])).toEqual([[b, -1, 'MANUAL']])
    expect(await db.alert.count({ where: { kind: 'USZKODZONE_DO_RW' } })).toBe(1)
    // odczyt po korekcie: A +2 → wzrost przez allocate; B +1 → wraca do 8 − 1 (uszkodzona nie idzie do sprzedaży)
    await applyStockRead(db, { productId: a, countBase: 9, requestSentAt: at(4 * M) }, { now: at(4 * M) })
    await applyStockRead(db, { productId: b, countBase: 9, requestSentAt: at(4 * M) }, { now: at(4 * M) })
    expect(await stockOf(db, a)).toMatchObject({ physical: 9 })
    expect(await db.outboxEvent.count({ where: { kind: 'ALLOCATE', productId: a } })).toBe(1)
    expect(await stockOf(db, b)).toMatchObject({ physical: 8, available: 8 })
    // biuro: RW w wFirmie, „poprawione” → potwierdza dopiero odczyt po kliknięciu
    await officeConfirmManual(db, rw[0]!.id, { now: at(5 * M) })
    await applyStockRead(db, { productId: b, countBase: 8, requestSentAt: at(6 * M) }, { now: at(6 * M) })
    expect(await stockOf(db, b)).toMatchObject({ physical: 8, pendingDelta: 0 })
    expect(await listDamagedForRw(db)).toEqual([])
    const ev = (await db.orderEvent.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } })).map((e) => e.kind)
    expect(ev.slice(-4)).toEqual(['ZWROT_ZGLOSZONY', 'ZWROT_PRZYJETY', 'KOREKTA_ZLECONA', 'KOREKTA'])
    await markReturnRefunded(db, rid, { now: at(7 * M) })
    expect((await db.return.findUniqueOrThrow({ where: { id: rid } })).moneyRefundedAt).toEqual(at(7 * M))
    await expectInvariants(db)
  })

  it('30b (3.5 v1.5): korekta „na stan” bez PZ → lista „korekta bez PZ” i alert; „PZ wystawione” zdejmuje z listy i zleca odczyt', async () => {
    const a = await product(db, 'A', 10)
    const { id, lines, wf } = await shipped([{ productId: a, qty: 3 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 3 }], { now: at(M) })
    await receiveReturn(db, rid, 'NA_STAN', { now: at(M) })
    await requestCorrection(db, rid)
    wf.pzOverride = (_p, q) => q - 2 // PZ tylko na 1 z 3
    await issueCorrection(db, rid, wf, { now: at(2 * M) })
    const list = await listCorrectionsWithoutPz(db)
    expect(list.map((l) => [l.qty, l.pzQty])).toEqual([[3, 1]])
    expect(await db.alert.count({ where: { kind: 'KOREKTA_BEZ_PZ' } })).toBe(1)
    expect(await stockOf(db, a)).toMatchObject({ physical: 7, pendingDelta: 0 }) // nic nie zgadujemy: stan pokaże odczyt
    const reads = await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: a } })
    await confirmPz(db, list[0]!.id, { now: at(3 * M) })
    expect(await listCorrectionsWithoutPz(db)).toEqual([])
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: a } })).toBe(reads + 1)
    await expectInvariants(db)
  })

  it('30c (3.5): anulowanie po fakturze → „do korekty”; korekta bez przesyłki (towar na półce) zdejmuje flagę; bez ruchu dodatniego', async () => {
    const a = await product(db, 'A', 10)
    const { orderId } = await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })
    const id = orderId!
    await packOrder(db, id, { now: T0 })
    const wf = new FakeWfirma()
    await issueInvoice(db, id, wf, { now: at(S) })
    await cancelOrder(db, id, { now: at(2 * S) })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).flags).toMatchObject({ doKorekty: true })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    await expect(createReturn(db, id, [{ orderLineId: line.id, qty: 2 }], { kind: 'KOREKTA' })).rejects.toThrow(/oznaczenia/)
    const rid = await createReturn(db, id, [{ orderLineId: line.id, qty: 2, disposition: 'NA_STAN' }], { kind: 'KOREKTA', now: at(M) })
    expect((await db.return.findUniqueOrThrow({ where: { id: rid } })).status).toBe('PRZYJETY')
    await requestCorrection(db, rid)
    await issueCorrection(db, rid, wf, { now: at(2 * M) })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).flags).toMatchObject({ doKorekty: false })
    expect(await stockOf(db, a)).toMatchObject({ physical: 8, pendingDelta: -2 })
    await expectInvariants(db)
  })

  it('30d (4.5 v1.5): korekta brakującej pozycji (na fakturze, nie w paczce) → STOCK_MISSING MANUAL, available od razu niżej', async () => {
    const a = await product(db, 'A', 5)
    const other = await product(db, 'B', 5)
    const { id, lines, wf } = await shipped([{ productId: a, qty: 2 }])
    // inne zamówienie trzyma 3 szt. A: brak −1 nie może dać reserved > physical bez overcommitSince (niezmiennik 5)
    await ingestOrder(db, order([{ productId: a, qty: 3 }, { productId: other, qty: 1 }]), { now: at(M) })
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1, disposition: 'BRAK' }], { kind: 'KOREKTA', now: at(2 * M) })
    await requestCorrection(db, rid)
    await issueCorrection(db, rid, wf, { now: at(3 * M) })
    const m = await db.pendingMovement.findFirstOrThrow({ where: { productId: a, type: 'STOCK_MISSING' } })
    expect(m).toMatchObject({ state: 'MANUAL', delta: -1 })
    const s = await stockOf(db, a)
    expect(s).toMatchObject({ physical: 2, reserved: 3, available: 0 })
    expect(s.overcommitSince).not.toBeNull()
    await expectInvariants(db)
  })

  it('zestaw: zwrot całej pozycji rozbija się na składniki; częściowy zwrot składnika', async () => {
    const x = await product(db, 'X', 10)
    const y = await product(db, 'Y', 10)
    const z = await bundle(db, 'XY', [{ id: x, qty: 1 }, { id: y, qty: 2 }])
    const { id, lines } = await shipped([{ productId: z, qty: 2 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }])
    expect((await db.returnLine.findMany({ where: { returnId: rid } })).map((l) => [l.productId === x ? 'X' : 'Y', l.qty]).sort()).toEqual([['X', 1], ['Y', 2]])
    await createReturn(db, id, [{ orderLineId: lines[0]!.id, productId: y, qty: 2 }])
    await expect(createReturn(db, id, [{ orderLineId: lines[0]!.id, productId: y, qty: 1 }])).rejects.toThrow(/Za dużo/)
    await expect(createReturn(db, id, [{ orderLineId: lines[0]!.id, productId: 'obcy', qty: 1 }])).rejects.toBeInstanceOf(ReturnError)
  })

  // po 3 nieudanych find korekta czeka na osobę (FAILED + alert), ponowienie tylko z potwierdzeniem
  it('timeout korekty: find znajduje → zakończona bez drugiej korekty; nie znajduje po 3 próbach → do sprawdzenia, kolejna próba dopiero po potwierdzeniu', async () => {
    const a = await product(db, 'A', 10)
    const { id, lines, wf } = await shipped([{ productId: a, qty: 4 }])
    const r1 = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { now: at(M) })
    const r2 = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { now: at(M) })
    for (const r of [r1, r2]) {
      await receiveReturn(db, r, 'NA_STAN')
      await requestCorrection(db, r)
    }
    wf.correctionNext = ['TIMEOUT_AFTER_CREATE', 'TIMEOUT_NO_CREATE']
    expect(await issueCorrection(db, r1, wf, { now: at(2 * M) })).toBe('TIMEOUT')
    expect(await issueCorrection(db, r2, wf, { now: at(2 * M) })).toBe('TIMEOUT')
    expect(await issueCorrection(db, r1, wf, { now: at(2 * M) })).toBe('W_TOKU')
    await resolveUnknownCorrections(db, wf, { now: at(2 * M + 30 * S) })
    expect((await db.return.findUniqueOrThrow({ where: { id: r1 } })).status).toBe('ZAKONCZONY')
    await resolveUnknownCorrections(db, wf, { now: at(4 * M + 30 * S) })
    const st = await resolveUnknownCorrections(db, wf, { now: at(9 * M + 30 * S) })
    expect(st.doSprawdzenia).toBe(1)
    expect(await db.return.findUniqueOrThrow({ where: { id: r2 } })).toMatchObject({ correctionState: 'FAILED', lastError: expect.stringMatching(/^timeout/) })
    expect(await db.alert.count({ where: { kind: 'KOREKTA_NIEWIADOMA', ref: id } })).toBe(1)
    // kolejka sama nie ponawia; osoba bez potwierdzenia dostaje odmowę
    expect(await issueCorrection(db, r2, wf, { now: at(10 * M) })).toBe('NIC')
    await expect(retryCorrection(db, r2)).rejects.toThrow(/potwierdź/)
    await retryCorrection(db, r2, { potwierdzone: true, actorId: 'test' })
    expect(await issueCorrection(db, r2, wf, { now: at(10 * M) })).toBe('WYSTAWIONA')
    expect(wf.corrections.map((c) => c.idExternal)).toEqual([`zwrot/${r1}/1`, `zwrot/${r2}/2`])
    await expectInvariants(db)
  })

  it('find korekt zawsze puste → osobny test kontrolny korekt nie przechodzi, korekta zostaje UNKNOWN, zero drugiej', async () => {
    const a = await product(db, 'A', 10)
    const { id, lines, wf } = await shipped([{ productId: a, qty: 4 }])
    const r1 = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { now: at(M) })
    const r2 = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { now: at(M) })
    for (const r of [r1, r2]) {
      await receiveReturn(db, r, 'NA_STAN')
      await requestCorrection(db, r)
    }
    expect(await issueCorrection(db, r1, wf, { now: at(2 * M) })).toBe('WYSTAWIONA') // sonda pozytywna korekt
    wf.correctionNext = ['TIMEOUT_AFTER_CREATE']
    expect(await issueCorrection(db, r2, wf, { now: at(3 * M) })).toBe('TIMEOUT')
    wf.findCorrectionsEmpty = true
    const runs = []
    for (const t of [4 * M, 6 * M, 12 * M, 30 * M]) runs.push(await runWfirmaQueue(db, { faktury: wf, korekty: wf }, { now: at(t) }))
    expect(runs[0]!.findCheckCorr).toBe(false) // sonda w pierwszym przebiegu; kolejne w ciągu godziny jej nie powtarzają
    expect(runs.slice(1).every((r) => r.findCheckCorr === undefined)).toBe(true)
    expect(await db.return.findUniqueOrThrow({ where: { id: r2 } })).toMatchObject({ status: 'KOREKTA', correctionState: 'UNKNOWN', correctionTry: 1 })
    expect(wf.corrections.filter((c) => c.idExternal.startsWith(`zwrot/${r2}/`))).toHaveLength(1)
    const q = await db.wfirmaQueueState.findFirstOrThrow()
    expect(q.findCheckCorrFailedAt).not.toBeNull()
    expect(q.findCheckCorrOkAt).toBeNull()
    // find naprawiony: po godzinie sonda przechodzi, korekta znaleziona — nadal jedna
    wf.findCorrectionsEmpty = false
    await runWfirmaQueue(db, { faktury: wf, korekty: wf }, { now: at(100 * M) })
    expect((await db.return.findUniqueOrThrow({ where: { id: r2 } })).status).toBe('ZAKONCZONY')
    expect(wf.corrections.filter((c) => c.idExternal.startsWith(`zwrot/${r2}/`))).toHaveLength(1)
    await expectInvariants(db)
  })

  it('błąd korekty → FAILED + alert, kolejka nie ponawia sama; „ponów” po poprawce; odrzucenie zwrotu przed korektą; korekta drugi raz = bez skutku', async () => {
    const a = await product(db, 'A', 10)
    const { id, lines, wf } = await shipped([{ productId: a, qty: 2 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }])
    await receiveReturn(db, rid, 'NA_STAN')
    await requestCorrection(db, rid)
    wf.correctionNext = ['ERROR']
    expect(await issueCorrection(db, rid, wf)).toBe('BLAD')
    expect(await db.alert.count({ where: { kind: 'KOREKTA_BLAD' } })).toBe(1)
    expect(await issueCorrection(db, rid, wf)).toBe('NIC')
    await retryCorrection(db, rid)
    expect(await issueCorrection(db, rid, wf)).toBe('WYSTAWIONA')
    await completeCorrection(db, rid, 'KOR/1', {}) // powtórzone rozstrzygnięcie: bez drugiego zapisu
    expect(await db.stockMovement.count({ where: { source: 'OWN_CORRECTION' } })).toBe(1)
    await expect(rejectReturn(db, rid)).rejects.toThrow(/przed korektą/)
    const r2 = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }])
    await rejectReturn(db, r2, { note: 'klient się rozmyślił' })
    // odrzucony nie blokuje ilości: można zgłosić ponownie
    await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }])
    await expect(receiveReturn(db, r2, 'NA_STAN')).rejects.toThrow(/odrzucony: paczki nie da się już odebrać/) // czytelny komunikat
  })

  it('zwrot zamówienia bez faktury (wydane bez dokumentu) → odmowa: najpierw dokument', async () => {
    const a = await product(db, 'A', 10)
    const { orderId } = await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })
    await packOrder(db, orderId!, { now: T0 })
    const { shipWithoutInvoice } = await import('@/lib/rdzen/rozchod')
    await shipWithoutInvoice(db, orderId!, { now: at(S) })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: orderId! } })
    await expect(createReturn(db, orderId!, [{ orderLineId: line.id, qty: 1 }])).rejects.toThrow(/Brak faktury/)
  })
})
