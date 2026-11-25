// zamówienie w walucie innej niż PLN (Allegro CZ, kopia kanału z `currency: 'CZK'`) nie dostaje dokumentu
// sprzedaży z Kompletora żadną drogą: kolejka faktur z rozchodem i bez, „Ponów fakturę”, KSeF. Zamówienie w PLN i
// zamówienie bez kopii kanału zachowują się jak przed zmianą. Dane fikcyjne, atrapa programu do faktur, zero połączeń
// zewnętrznych.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Order } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prepareKsefForOrder, zlozFaktureDoWysylki } from '@/lib/ksef/szkice'
import { wyslijDoKsef } from '@/lib/ksef/wysylka'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { faktyPrzejscia, moveOrder, startPicking } from '@/lib/rdzen/przejscia'
import { beginDocument, beginInvoice, issueInvoice, packOrder, ponowFaktureRecznie } from '@/lib/rdzen/rozchod'
import { FAKTURA_OBCA_WALUTA, powodFakturyRecznej, walutaZamowienia } from '@/lib/rdzen/waluta'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

/** Kopia zamówienia z kanału (tak, jak zostawia ją odczyt kanału), z walutą. */
async function kopiaKanalu(o: Pick<Order, 'id' | 'channel' | 'channelAccountId' | 'externalId'>, currency: string): Promise<void> {
  const klucz = { organizationId_channel_channelAccountId_externalId: { organizationId: ORG_A, channel: o.channel, channelAccountId: o.channelAccountId, externalId: o.externalId } }
  await db.channelOrderSnapshot.upsert({
    where: klucz,
    update: { currency, orderId: o.id },
    create: {
      channel: o.channel,
      channelAccountId: o.channelAccountId,
      externalId: o.externalId,
      revision: '1',
      channelStatus: 'READY_FOR_PROCESSING',
      lifecycle: 'OPEN',
      paymentState: 'PAID',
      totalGross: 957,
      currency,
      lineCount: 1,
      warnings: [],
      createdAtChannel: T0,
      firstSeenAt: T0,
      lastSeenAt: T0,
      orderId: o.id,
    },
  })
}

/** Zamówienie z towarem (opcjonalnie z kopią kanału w danej walucie); kwota = pozycje (1 × 10,00). */
async function zamowienie(sku: string, waluta: string | null, over: Parameters<typeof order>[1] = {}): Promise<Order> {
  const tea = await product(db, sku, 5)
  const r = await ingestOrder(db, order([{ productId: tea, qty: 1, unitPriceGross: 10 }], { channel: 'ALLEGRO', totalGross: 10, ...over }), { now: T0 })
  const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
  if (waluta) await kopiaKanalu(o, waluta)
  return o
}

/**
 * Paczka dodatkowa tak, jak zakłada ją „dośle później” (lib/rdzen/brakuje.ts): ten sam kanał i konto, numer
 * `<główne>#dosle-n`, `parentOrderId`; bez własnej kopii kanału.
 */
async function paczkaDosle(glowne: Order, sku: string, n = 1): Promise<Order> {
  const z = await zamowienie(sku, null)
  return db.order.update({ where: { id: z.id }, data: { externalId: `${glowne.externalId}#dosle-${n}`, parentOrderId: glowne.id, packageNo: n + 1 } })
}

const POWOD_CZK = powodFakturyRecznej('CZK')

async function spakuj(id: string): Promise<void> {
  expect(await startPicking(db, id, { now: T0 })).toBe('ZBIERANIE')
  await packOrder(db, id, { now: T0 })
}

const slady = (orderId: string) => db.orderEvent.count({ where: { orderId, kind: FAKTURA_OBCA_WALUTA } })
const proby = (orderId: string) => db.invoiceAttempt.count({ where: { orderId } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  // konto Allegro w trybie pracy (wzorzec faktura-bl-blokada): kolejka faktur i pakowanie biorą tylko takie konta
  await db.channelConfig.updateMany({ where: { channel: 'ALLEGRO', channelAccountId: 'allegro' }, data: { statusMode: 'PRACA' } })
})

describe('waluta zamówienia z kopii kanału', () => {
  it('CZK z kopii, PLN z kopii, bez kopii = PLN; paczka dodatkowa dziedziczy walutę zamówienia głównego', async () => {
    const czk = await zamowienie('HERB-W1', 'czk')
    const pln = await zamowienie('HERB-W2', 'PLN')
    const bez = await zamowienie('HERB-W3', null)
    expect(await walutaZamowienia(db, czk)).toBe('CZK')
    expect(await walutaZamowienia(db, pln)).toBe('PLN')
    expect(await walutaZamowienia(db, bez)).toBe('PLN')
    const dz = await paczkaDosle(czk, 'HERB-W4')
    expect(dz.externalId).toBe(`${czk.externalId}#dosle-1`)
    expect(await walutaZamowienia(db, dz)).toBe('CZK')
    // kopia zamówienia głównego bez `orderId` (kanał zapisał kopię przed zamówieniem): paczka dalej dziedziczy walutę
    await db.channelOrderSnapshot.updateMany({ where: { externalId: czk.externalId }, data: { orderId: null } })
    expect(await walutaZamowienia(db, dz)).toBe('CZK')
  })
})

describe('bezpiecznik faktury w obcej walucie (źródło stanu wFirma)', () => {
  it('faktura z rozchodem: OBCA_WALUTA bez próby i bez ruchu stanu; kolejka nie wraca, ślad raz, PLN obok dostaje fakturę', async () => {
    const czk = await zamowienie('HERB-F1', 'CZK')
    const pln = await zamowienie('HERB-F2', 'PLN')
    const bez = await zamowienie('HERB-F3', null)
    for (const o of [czk, pln, bez]) await spakuj(o.id)

    expect(await beginInvoice(db, czk.id, { now: at(M) })).toEqual({ outcome: 'OBCA_WALUTA' })
    expect(await proby(czk.id)).toBe(0)
    expect(await db.pendingMovement.count({ where: { orderId: czk.id } })).toBe(0)
    expect(await db.reservation.count({ where: { orderId: czk.id, state: 'ACTIVE' } })).toBe(1)

    const wf = new FakeWfirma()
    expect(await issueInvoice(db, czk.id, wf, { now: at(2 * M) })).toBe('OBCA_WALUTA')
    await runWfirmaQueue(db, { faktury: wf }, { now: at(3 * M) })
    await runWfirmaQueue(db, { faktury: wf }, { now: at(4 * M) })
    // regresja: PLN z kopii i zamówienie bez kopii dostają fakturę jak dotąd; CZK żadnej
    expect(wf.invoices).toHaveLength(2)
    expect(await proby(czk.id)).toBe(0)
    expect(await proby(pln.id)).toBeGreaterThan(0)
    expect(await proby(bez.id)).toBeGreaterThan(0)
    expect(await slady(czk.id)).toBe(1)
    expect(await slady(pln.id)).toBe(0)
    expect(await db.alert.count({ where: { ref: czk.id, kind: 'FAKTURA_OBCA_WALUTA' } })).toBe(1)
    await expectInvariants(db)
  })

  it('„Ponów fakturę” przy zamówieniu w CZK: odmowa z powodem, bez nowej serii prób', async () => {
    const czk = await zamowienie('HERB-F4', 'CZK')
    await db.order.update({ where: { id: czk.id }, data: { flags: { fakturaBlad: true } } })
    await expect(ponowFaktureRecznie(db, czk.id, { now: at(M), actorId: 'test' })).rejects.toThrow(POWOD_CZK)
    expect(await db.orderEvent.count({ where: { orderId: czk.id, kind: 'FAKTURA_PONOWIONA' } })).toBe(0)
    expect(await proby(czk.id)).toBe(0)
  })

  it('paczka dodatkowa zamówienia w CZK (`#dosle-1`): bez faktury z Kompletora, własny alert obok alertu zamówienia głównego', async () => {
    const czk = await zamowienie('HERB-F5', 'CZK')
    const dosle = await paczkaDosle(czk, 'HERB-F6')
    for (const o of [czk, dosle]) await spakuj(o.id)
    expect(await beginInvoice(db, czk.id, { now: at(M) })).toEqual({ outcome: 'OBCA_WALUTA' })
    expect(await beginInvoice(db, dosle.id, { now: at(M) })).toEqual({ outcome: 'OBCA_WALUTA' })
    expect(await proby(dosle.id)).toBe(0)
    expect(await db.alert.count({ where: { ref: czk.id, kind: 'FAKTURA_OBCA_WALUTA' } })).toBe(1)
    expect(await db.alert.count({ where: { ref: dosle.id, kind: 'FAKTURA_OBCA_WALUTA' } })).toBe(1)
  })
})

describe('bezpiecznik dokumentu bez rozchodu (źródło stanu Kompletor)', () => {
  beforeEach(async () => {
    await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR' } })
  })

  it('beginDocument: CZK = OBCA_WALUTA bez próby; PLN i bez kopii startują jak dotąd', async () => {
    const czk = await zamowienie('HERB-D1', 'CZK')
    const pln = await zamowienie('HERB-D2', 'PLN')
    const bez = await zamowienie('HERB-D3', null)
    expect(await beginDocument(db, czk.id, { now: at(M), statusy: [czk.status] })).toEqual({ outcome: 'OBCA_WALUTA' })
    expect(await proby(czk.id)).toBe(0)
    expect(await slady(czk.id)).toBe(1)
    expect((await beginDocument(db, pln.id, { now: at(M), statusy: [pln.status] })).outcome).toBe('START')
    expect((await beginDocument(db, bez.id, { now: at(M), statusy: [bez.status] })).outcome).toBe('START')
  })

  it('„Dokument przed wysyłką”: CZK nie czeka na dokument i wychodzi z magazynu raz; PLN dalej czeka', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { faktury: { program: 'ksef', przedWysylka: true } } as never } })
    const czk = await zamowienie('HERB-D4', 'CZK')
    const pln = await zamowienie('HERB-D5', 'PLN')
    for (const o of [czk, pln]) await spakuj(o.id)
    expect((await faktyPrzejscia(db, czk)).dokumentWymagany).toBe(false)
    expect((await faktyPrzejscia(db, pln)).dokumentWymagany).toBe(true)

    expect(await moveOrder(db, czk.id, 'DO_WYSLANIA', { now: at(M) })).toBe('DO_WYSLANIA')
    expect(await db.reservation.count({ where: { orderId: czk.id, state: 'ACTIVE' } })).toBe(0)
    expect(await proby(czk.id)).toBe(0)
    await expect(moveOrder(db, pln.id, 'DO_WYSLANIA', { now: at(M) })).rejects.toThrow(/Najpierw dokument sprzedaży/)
    await expectInvariants(db)
  })
})

describe('KSeF przy zamówieniu w obcej walucie', () => {
  const KSEF = {
    faktury: { program: 'ksef' },
    ksef: { sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca Testowy sp. z o.o.', adres: { linia1: 'ul. Fikcyjna 1', linia2: '00-001 Warszawa' } }, seriaKod: 'FV' },
  }

  it('szkic: CZK = nie dotyczy z powodem i bez szkicu; PLN = szkic jak dotąd; złożenie do wysyłki CZK odmówione', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: KSEF as never } })
    const czk = await zamowienie('HERB-K1', 'CZK', { wantInvoiceNip: true })
    const pln = await zamowienie('HERB-K2', 'PLN', { wantInvoiceNip: true })
    const r = await prepareKsefForOrder(db, czk.id, { now: at(M), xsdDir: await mkdtemp(path.join(tmpdir(), 'ksef-bez-xsd-')) })
    expect(r).toMatchObject({ wynik: 'nie_dotyczy', powod: POWOD_CZK })
    expect(await db.ksefInvoiceDraft.count({ where: { orderId: czk.id } })).toBe(0)
    expect(await prepareKsefForOrder(db, pln.id, { now: at(M), xsdDir: await mkdtemp(path.join(tmpdir(), 'ksef-bez-xsd-')) })).toMatchObject({ wynik: 'przygotowana' })
    expect(await db.ksefInvoiceDraft.count({ where: { orderId: pln.id } })).toBe(1)

    const z = await zlozFaktureDoWysylki(db, czk.id, 1, { numer: 'FV/1/2026', dataWystawienia: '2026-11-23', now: at(2 * M) })
    expect(z).toMatchObject({ ok: false, problemy: [{ kod: 'obca-waluta' }] })
  })

  it('wysyłka szkicu sprzed bezpiecznika (zamówienie okazało się w CZK): odmowa przed numerem, seria nietknięta', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: KSEF as never } })
    const o = await zamowienie('HERB-K3', 'PLN', { wantInvoiceNip: true })
    expect(await prepareKsefForOrder(db, o.id, { now: at(M), xsdDir: await mkdtemp(path.join(tmpdir(), 'ksef-bez-xsd-')) })).toMatchObject({ wynik: 'przygotowana' })
    const szkic = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: o.id } })
    await db.ksefInvoiceDraft.update({ where: { id: szkic.id }, data: { status: 'ZLOZONA' } })
    await kopiaKanalu(o, 'CZK')
    const r = await wyslijDoKsef(db, szkic.id, { secrets: { env: {}, envFallback: true }, env: {}, now: at(2 * M), fetch: async () => { throw new Error('bez sieci w teście') } })
    expect(r).toEqual({ wynik: 'odmowa', powod: POWOD_CZK })
    expect(await db.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: szkic.id } })).toMatchObject({ numer: null, status: 'ZLOZONA', proby: szkic.proby })
    expect(await db.invoiceNumberSeries.count()).toBe(0)
  })
})
