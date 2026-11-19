// Testy czystych części cienia: mapa statusów BL, klasyfikacja różnic, porównanie, metryki, odstępy.
import { describe, expect, it } from 'vitest'
import type { ChannelMap } from '../import/normalizacja'
import { blOrderHeader, blStatusFamily, classifyStatus, compareShadowWithBl, type BlOrderHeader, type SnapRow } from './bl-porownanie'
import { percentile } from './metryki'
import { eventKeyOf, isPermanentItemError, pollIntervalMs, toIncoming } from './odczyt-zamowien'
import { AdapterError, UnreadableDataError } from '../adaptery/kontrakt'
import { ValidationError } from '../rdzen/zamowienia'
import { fakeOrder } from '../adaptery/falszywy'

const BL_STATUSES = new Map<number, string>([
  [327649, 'Nowe zamówienia'],
  [376446, 'E-book'],
  [356153, 'Do realizacji Paczkomaty'],
  [356154, 'Do realizacji DPD'],
  [356155, 'Do realizacji Osobisty'],
  [356156, 'Do realizacji Allegro'],
  [356197, 'Rozpoczęto zbieranie'],
  [356198, 'Zebrane Paczkomaty'],
  [356196, 'Spakowane Paczkomaty'],
  [327650, 'Do wysłania'],
  [359765, 'Do odbioru'],
  [327652, 'Anulowane'],
  [327651, 'Wysłane'],
  [359766, 'Odebrane '],
  [356023, 'Do wyjaśnienia'],
  [383036, 'Reklamacja'],
])

describe('mapa statusów BL (spec 7.1)', () => {
  it('22 statusy ACME → nasze rodziny i przewoźnik z końcówki', () => {
    const got = Object.fromEntries([...BL_STATUSES].map(([id, n]) => [id, blStatusFamily(n)]))
    expect(got[327649]).toEqual({ family: 'NOWE', carrier: null })
    expect(got[376446]!.family).toBe('EBOOK')
    expect(got[356153]).toEqual({ family: 'DO_REALIZACJI', carrier: 'PACZKOMATY' })
    expect(got[356154]).toEqual({ family: 'DO_REALIZACJI', carrier: 'DPD' })
    expect(got[356155]).toEqual({ family: 'DO_REALIZACJI', carrier: 'OSOBISTY' })
    expect(got[356156]).toEqual({ family: 'DO_REALIZACJI', carrier: 'ALLEGRO' })
    expect(got[356197]!.family).toBe('ZBIERANIE')
    expect(got[356198]).toEqual({ family: 'ZEBRANE', carrier: 'PACZKOMATY' })
    expect(got[356196]!.family).toBe('SPAKOWANE')
    expect(got[327650]!.family).toBe('DO_WYSLANIA')
    expect(got[359765]!.family).toBe('DO_ODBIORU')
    expect(got[327652]!.family).toBe('ANULOWANE')
    expect(got[327651]!.family).toBe('WYSLANE')
    expect(got[359766]!.family).toBe('ODEBRANE')
    expect(got[356023]!.family).toBe('DO_WYJASNIENIA')
    expect(got[383036]!.family).toBe('REKLAMACJA')
    expect(blStatusFamily('Coś nowego w BL').family).toBe('NIEZNANY')
  })
})

describe('klasyfikacja statusu cień vs BL', () => {
  const ord = (status: 'NOWE' | 'DO_REALIZACJI' | 'ANULOWANE' | 'DO_WYJASNIENIA', carrier: 'PACZKOMATY' | 'DPD' | 'DPD_EMPIK' | null = 'PACZKOMATY') => ({ kind: 'ORDER' as const, status, carrier })
  const bl = (n: string) => blStatusFamily(n)
  it('zgodne, BL dalej w realizacji, lepiej niż BL, przewoźnik, rozjazd', () => {
    expect(classifyStatus(ord('DO_REALIZACJI'), bl('Do realizacji Paczkomaty'))).toBe('ZGODNE')
    expect(classifyStatus(ord('DO_REALIZACJI'), bl('Wysłane'))).toBe('BL_DALEJ')
    expect(classifyStatus(ord('DO_REALIZACJI'), bl('Spakowane Paczkomaty'))).toBe('BL_DALEJ')
    expect(classifyStatus(ord('DO_REALIZACJI'), bl('Nowe zamówienia'))).toBe('LEPIEJ_NIZ_BL')
    expect(classifyStatus(ord('DO_REALIZACJI', 'DPD'), bl('Do realizacji Paczkomaty'))).toBe('PRZEWOZNIK')
    expect(classifyStatus(ord('DO_REALIZACJI', 'DPD_EMPIK'), bl('Do realizacji DPD'))).toBe('ZGODNE')
    expect(classifyStatus(ord('NOWE'), bl('Nowe zamówienia'))).toBe('ZGODNE')
    expect(classifyStatus(ord('NOWE'), bl('Do realizacji DPD'))).toBe('ROZJAZD')
    expect(classifyStatus(ord('ANULOWANE'), bl('Anulowane'))).toBe('ZGODNE')
    expect(classifyStatus(ord('DO_REALIZACJI'), bl('Anulowane'))).toBe('ROZJAZD')
    expect(classifyStatus(ord('ANULOWANE'), bl('Wysłane'))).toBe('ROZJAZD')
    expect(classifyStatus(ord('DO_WYJASNIENIA'), bl('Do realizacji DPD'))).toBe('U_NAS_DO_WYJASNIENIA')
    expect(classifyStatus({ kind: 'SKIPPED_FULFILLED' }, bl('Wysłane'))).toBe('ZGODNE')
    expect(classifyStatus({ kind: 'SKIPPED_FULFILLED' }, bl('Nowe zamówienia'))).toBe('ROZJAZD')
    expect(classifyStatus(ord('DO_REALIZACJI'), bl('E-book'))).toBe('BL_NIEZNANY')
  })
})

describe('nagłówek zamówienia BL bez danych klienta', () => {
  const map: ChannelMap = { shopAccounts: ['7100001'], empikAccountId: '30193' }
  it('sklep: numer Woo z shop_order_id; Empik: external_order_id; dane osobowe nie wychodzą', () => {
    const raw = {
      order_id: 9001,
      order_source: 'shop',
      order_source_id: 7100001,
      shop_order_id: 12345,
      external_order_id: '',
      order_status_id: 356153,
      date_add: 1_792_000_000,
      date_confirmed: 1_792_000_100,
      delivery_method: 'Paczkomaty InPost',
      payment_done: '49.90',
      email: 'jan.testowy@example.invalid',
      phone: '600100200',
      delivery_fullname: 'Jan Testowy',
      delivery_address: 'ul. Testowa 1',
      invoice_nip: '1234563218',
    }
    const h = blOrderHeader(raw, map)!
    expect(h).toMatchObject({ blOrderId: 9001, channel: 'WOO', channelAccountId: '7100001', externalRef: '12345', statusId: 356153, paymentDone: 49.9 })
    expect(JSON.stringify(h)).not.toMatch(/Testow|600100200|1234563218|example\.invalid/)
    const e = blOrderHeader({ ...raw, order_source: 'empik', order_source_id: 30193, shop_order_id: 0, external_order_id: 'E-77-A' }, map)!
    expect(e).toMatchObject({ channel: 'EMPIK', channelAccountId: '30193', externalRef: 'E-77-A' })
    expect(blOrderHeader({ order_id: 1 }, map)).toBeNull()
  })
})

describe('porównanie cienia z BL', () => {
  const now = new Date('2026-10-25T12:00:00Z')
  const windowFrom = new Date('2026-10-24T12:00:00Z')
  const coverageFrom = new Date('2026-10-24T13:00:00Z')
  const t = (h: number) => new Date(windowFrom.getTime() + h * 3600_000)
  const snap = (externalId: string, over: Partial<SnapRow> = {}): SnapRow => ({
    channel: 'WOO',
    channelAccountId: 'sd',
    externalId,
    channelStatus: 'processing',
    lifecycle: 'OPEN',
    skipReason: null,
    orderId: `o${externalId}`,
    createdAtChannel: t(2),
    ...over,
  })
  const blh = (externalRef: string, statusId: number, over: Partial<BlOrderHeader> = {}): BlOrderHeader => ({
    blOrderId: Number(externalRef.replace(/\D/g, '')) + 9000,
    orderSource: 'shop',
    orderSourceId: 'sd',
    channel: 'WOO',
    channelAccountId: 'sd',
    externalRef,
    statusId,
    deliveryMethod: null,
    paymentDone: null,
    totalGross: null,
    confirmed: true,
    dateAdd: t(2.2),
    dateConfirmed: t(2.2),
    ...over,
  })

  it('pary, braki w obie strony, statusy, okno i karencja, źródła bez adaptera', () => {
    const r = compareShadowWithBl({
      accounts: [
        { channel: 'WOO', channelAccountId: 'sd', name: 'SD', coverageFrom },
        { channel: 'ALLEGRO', channelAccountId: '71045', name: 'Allegro', coverageFrom: null },
      ],
      snaps: [
        snap('1'),
        snap('2', { channelStatus: 'pending' }), // brak w BL
        snap('3'),
        snap('4', { createdAtChannel: new Date(now.getTime() - 5 * 60_000) }), // w karencji — nie liczone
        snap('5', { orderId: null, skipReason: 'zrealizowane-przed-pierwszym-odczytem', lifecycle: 'FULFILLED' }),
        snap('6', { lifecycle: 'DRAFT' }),
        snap('7', { createdAtChannel: new Date(windowFrom.getTime() - 3600_000) }), // przed oknem
        snap('118438', { channelNumber: '158405', orderId: null, skipReason: 'zrealizowane-przed-pierwszym-odczytem', lifecycle: 'FULFILLED' }), // BL zna numer, nie id
      ],
      bl: [
        blh('1', 356153),
        blh('3', 327651),
        blh('5', 327651),
        blh('158405', 327651), // para po numerze zamówienia (Woo z numeracją wtyczki)
        blh('8', 327649), // brak u nas
        blh('9', 327649, { dateAdd: new Date(coverageFrom.getTime() + 10 * 60_000) }), // za blisko początku pokrycia
        blh('', 327649, { channel: 'ALLEGRO', channelAccountId: '71045', orderSource: 'allegro', orderSourceId: '71045', externalRef: 'abc', blOrderId: 1 }),
      ],
      statuses: BL_STATUSES,
      orders: new Map([
        ['o1', { id: 'o1', status: 'DO_REALIZACJI', carrier: 'PACZKOMATY', activeReservations: 2 }],
        ['o2', { id: 'o2', status: 'NOWE', carrier: 'PACZKOMATY', activeReservations: 1 }],
        ['o3', { id: 'o3', status: 'DO_REALIZACJI', carrier: 'PACZKOMATY', activeReservations: 3 }],
      ]),
      windowFrom,
      now,
      graceMs: 20 * 60_000,
      coverageMarginMs: 30 * 60_000,
    })
    const sd = r.accounts.find((a) => a.channel === 'WOO')!
    expect(sd).toMatchObject({ polled: true, inChannel: 5, paired: 4, missingInBl: 1, missingInBlByStatus: { pending: 1 }, missingHere: 1, missingHereByBlStatus: { 'Nowe zamówienia': 1 } })
    expect(sd.inBl).toBe(6)
    expect(sd.verdicts).toMatchObject({ ZGODNE: 3, BL_DALEJ: 1, ROZJAZD: 0 })
    expect(sd.activeReservationsBlAhead).toBe(3)
    expect(r.pairings.map((p) => p.snapExternalId).sort()).toEqual(['1', '118438', '3', '5'])
    expect(r.unpolled).toEqual({ 'Allegro (ALLEGRO)': 1 })
    const al = r.accounts.find((a) => a.channel === 'ALLEGRO')!
    expect(al).toMatchObject({ polled: false, missingHere: 0 })
  })
})

describe('pomocnicze', () => {
  it('percentyl', () => {
    expect(percentile([], 95)).toBeNull()
    expect(percentile([5], 95)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
  })
  it('odstęp odczytów: limit adaptera, ustawienie konta, awaria co 5 min', () => {
    expect(pollIntervalMs(30_000, {}, false)).toBe(60_000)
    expect(pollIntervalMs(30_000, { pollIntervalSec: 45 }, false)).toBe(45_000)
    expect(pollIntervalMs(60_000, { pollIntervalSec: 10 }, false)).toBe(60_000)
    expect(pollIntervalMs(60_000, {}, true)).toBe(300_000)
  })
  it('błąd trwały elementu vs przejściowy', () => {
    expect(isPermanentItemError(new UnreadableDataError('x'))).toBe(true)
    expect(isPermanentItemError(new ValidationError('x'))).toBe(true)
    expect(isPermanentItemError(new AdapterError('x', 'TRWALY'))).toBe(true)
    expect(isPermanentItemError(new AdapterError('x', 'PRZEJSCIOWY'))).toBe(false)
    expect(isPermanentItemError(new Error('baza'))).toBe(false)
  })
  it('zamówienie kanału → wejście rdzenia (źródło per konto, anulowane, rewizja)', () => {
    const i = toIncoming({ channel: 'WOO', channelAccountId: 'sd' }, fakeOrder({ externalId: '5', lifecycle: 'CANCELLED', revision: '2026-10-25T10:00:00.000Z' }))
    expect(i).toMatchObject({ source: 'poll:WOO:sd', externalId: '5', externalRevision: '2026-10-25T10:00:00.000Z', cancelled: true })
    expect(i.lines[0]).toMatchObject({ offerExternalId: '10', qty: 1 })
  })
})

describe('klucz zdarzenia', () => {
  it('ta sama rewizja, inny status albo płatność → inny klucz; wymuszone anulowanie też', () => {
    const o = fakeOrder({ externalId: '5', revision: '2026-10-25T10:00:00.000Z', channelStatus: 'pending', paymentState: 'UNPAID' })
    const a = eventKeyOf(o)
    expect(eventKeyOf({ ...o, channelStatus: 'processing' })).not.toBe(a)
    expect(eventKeyOf({ ...o, paymentState: 'PAID' })).not.toBe(a)
    expect(eventKeyOf(o, true)).not.toBe(a)
    expect(toIncoming({ channel: 'WOO', channelAccountId: 'sd' }, o).eventKey).toBe(a)
    expect(toIncoming({ channel: 'WOO', channelAccountId: 'sd' }, o, { forceCancelled: true }).cancelled).toBe(true)
  })
})
