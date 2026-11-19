// czyste funkcje — kwota zamówienia BL, porównanie sprzedaży dnia, zamykanie dnia, nagłówek faktury BL
// (bez danych nabywcy), odczyt WZ z wFirmy (atrapa wywołań), rewizja jako chwila zmiany. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import type { SalesOrder } from '../panel/dane'
import { blOrderHeader, blOrderTotalCents, type BlOrderHeader } from './bl-porownanie'
import { blInvoiceContent, blInvoiceHeader, WfirmaWzReader } from './faktury-bl'
import { revisionTime } from './metryki'
import { arrivedInDay, compareDaySales, dayToClose, divergenceMessage, salesCountBreakdown, warsawDay } from './sprzedaz-dnia'

const map = { shopAccounts: ['sd'], empikAccountId: null }

describe('kwota zamówienia BL (pozycje brutto × ilość + wysyłka)', () => {
  it('liczy w groszach, nieczytelna pozycja = null (nie 0)', () => {
    expect(blOrderTotalCents({ products: [{ price_brutto: 24.99, quantity: 2 }, { price_brutto: '10.10', quantity: '1' }], delivery_price: 12.99 })).toBe(7307)
    expect(blOrderTotalCents({ products: [], delivery_price: 0 })).toBe(0)
    expect(blOrderTotalCents({ products: [{ price_brutto: 'x', quantity: 1 }] })).toBeNull()
    expect(blOrderTotalCents({})).toBeNull()
  })
  it('nagłówek: kwota i potwierdzenie, bez danych klienta', () => {
    const h = blOrderHeader({ order_id: 1, order_source: 'shop', order_source_id: 'sd', shop_order_id: 5, order_status_id: 2, date_add: 1_790_000_000, confirmed: false, products: [{ price_brutto: 5, quantity: 1 }], delivery_price: 1, email: 'jan@example.invalid' }, map)!
    expect(h).toMatchObject({ totalGross: 6, confirmed: false, externalRef: '5' })
    expect(JSON.stringify(h)).not.toContain('example.invalid')
  })
})

describe('sprzedaż dnia: porównanie per konto', () => {
  const { from, to } = warsawDay('2026-10-26')
  const ours = (externalId: string, gross: string, channelNumber: string | null = null, over: Partial<SalesOrder> = {}): SalesOrder => ({
    channel: 'WOO', channelAccountId: 'sd', externalId, channelNumber, createdAtChannel: from, gross, outside: null,
    orderStatus: 'DO_REALIZACJI', cancelReason: null, paymentState: 'PAID', channelStatus: 'processing', lifecycle: 'OPEN', ...over,
  })
  const bl = (id: number, ref: string, total: number | null, over: Partial<BlOrderHeader> = {}): BlOrderHeader => ({
    blOrderId: id, orderSource: 'shop', orderSourceId: 'sd', channel: 'WOO', channelAccountId: 'sd', externalRef: ref, statusId: 2, deliveryMethod: null, paymentDone: null, totalGross: total, confirmed: true, dateAdd: from, dateConfirmed: from, ...over,
  })
  const accounts = [
    { channel: 'WOO' as const, channelAccountId: 'sd', name: 'SklepDemo', coverageFrom: from },
    { channel: 'ALLEGRO' as const, channelAccountId: 'a1', name: 'Allegro', coverageFrom: null },
  ]

  it('zgodny dzień: liczba i kwota, łączenie po numerze wtyczki Woo, tolerancja 1 gr, niepotwierdzone osobno', () => {
    const r = compareDaySales({
      day: '2026-10-26', final: true, from, to, blComplete: true, blErrors: [], accounts,
      ours: [ours('101', '99.95'), ours('118438', '50.00', '158405')],
      bl: [bl(1, '101', 99.95), bl(2, '158405', 50.01), bl(3, '777', 10, { confirmed: false }), bl(4, '9', 30, { channel: 'ALLEGRO', channelAccountId: 'a1', orderSource: 'allegro', orderSourceId: 'a1' })],
    })
    expect(r.ok).toBe(true)
    const k = r.accounts[0]!
    expect(k).toMatchObject({ ok: true, ours: { count: 2, cents: 14995 }, bl: { count: 2, cents: 14996, unconfirmed: 1 }, onlyHere: [], onlyBl: [] })
    expect(r.accounts).toHaveLength(1) // Allegro bez odczytu — bez porównania
    expect(r.notCompared).toEqual([{ key: 'Allegro', count: 1, cents: 3000 }])
  })

  it('rozjazd jak 26.10 (3 / 279,85 kontra 8 / 842,61): numery tylko w BL w treści alertu', () => {
    const o = [ours('101', '99.95'), ours('102', '89.95'), ours('103', '89.95')]
    const b = [bl(1, '101', 99.95), bl(2, '102', 89.95), bl(3, '103', 89.95), bl(4, '201', 120), bl(5, '202', 110.5), bl(6, '203', 99.99), bl(7, '204', 132.27), bl(8, '205', 100)]
    const r = compareDaySales({ day: '2026-10-26', final: true, from, to, ours: o, bl: b, blComplete: true, blErrors: [], accounts })
    const k = r.accounts[0]!
    expect(r.ok).toBe(false)
    expect(k).toMatchObject({ ok: false, ours: { count: 3, cents: 27985 }, bl: { count: 8, cents: 84261 }, onlyBl: ['201', '202', '203', '204', '205'] })
    const m = divergenceMessage('2026-10-26', k)
    expect(m).toContain('Kompletor 3 zam. / 279,85 zł, BL 8 zam. / 842,61 zł')
    expect(m).toContain('Tylko w BL: 201, 202, 203, 204, 205')
  })

  it('inna kwota przy tej samej liczbie = rozjazd; niepełne pobranie BL = dzień niezgodny', () => {
    const r = compareDaySales({ day: '2026-10-26', final: true, from, to, ours: [ours('101', '99.95')], bl: [bl(1, '101', 89.95)], blComplete: true, blErrors: [], accounts })
    expect(r.accounts[0]).toMatchObject({ ok: false, amountDiffs: [{ ref: '101', oursCents: 9995, blCents: 8995 }] })
    const r2 = compareDaySales({ day: '2026-10-26', final: true, from, to, ours: [ours('101', '99.95')], bl: [bl(1, '101', 99.95)], blComplete: false, blErrors: ['x'], accounts })
    expect(r2.accounts[0]!.ok).toBe(true)
    expect(r2.ok).toBe(false)
  })

  it('Woo failed/pending nieopłacone i anulowane przez kanał bez pary w BL — osobna lista, nie rozjazd', () => {
    const o = [
      ours('101', '99.95'),
      // dane sprzed zmiany znaczenia failed: dawna mapa Woo zapisywała failed jako anulowane (CANCELLED); zostają jako przypadek historyczny
      ours('102', '40.00', null, { orderStatus: 'ANULOWANE', cancelReason: 'CANCELLED', paymentState: 'UNPAID', channelStatus: 'failed', lifecycle: 'CANCELLED' }),
      ours('103', '30.00', null, { orderStatus: 'NOWE', paymentState: 'UNPAID', channelStatus: 'pending' }),
      ours('104', '20.00', null, { orderStatus: null, cancelReason: null, paymentState: 'UNPAID', channelStatus: 'cancelled', lifecycle: 'CANCELLED', outside: 'nieprzyjete' }),
    ]
    const r = compareDaySales({ day: '2026-10-26', final: true, from, to, ours: o, bl: [bl(1, '101', 99.95)], blComplete: true, blErrors: [], accounts })
    expect(r.ok).toBe(true)
    expect(r.accounts[0]).toMatchObject({ ok: true, onlyHere: [], notImportedByBl: ['102', '103', '104'], ours: { count: 4 }, bl: { count: 1 } })
    expect(divergenceMessage('2026-10-26', r.accounts[0]!)).toContain('BL ich nie importuje')
    // opłacone pending bez pary w BL (np. przelew zaksięgowany) to już rozjazd
    const r2 = compareDaySales({ day: '2026-10-26', final: true, from, to, ours: [ours('105', '10.00', null, { channelStatus: 'pending', paymentState: 'PAID' })], bl: [], blComplete: true, blErrors: [], accounts })
    expect(r2.accounts[0]).toMatchObject({ ok: false, onlyHere: ['105'], notImportedByBl: [] })
  })

  it('zamiana zamówienia na inne o tej samej kwocie (liczby i sumy równe) = rozjazd', () => {
    const r = compareDaySales({ day: '2026-10-26', final: true, from, to, ours: [ours('101', '50.00')], bl: [bl(1, '999', 50)], blComplete: true, blErrors: [], accounts })
    expect(r.accounts[0]).toMatchObject({ ok: false, ours: { count: 1, cents: 5000 }, bl: { count: 1, cents: 5000 }, onlyHere: ['101'], onlyBl: ['999'] })
    expect(r.ok).toBe(false)
  })

  it('zamówienie z 23:58 zaimportowane do BL o 00:03 — liczy się do dnia złożenia, następny dzień czysty', () => {
    const late = new Date(to.getTime() - 2 * 60_000) // 23:58 w Warszawie
    const imported = new Date(to.getTime() + 3 * 60_000) // 00:03 następnego dnia
    const o = [ours('101', '99.95'), ours('150', '45.00', null, { createdAtChannel: late })]
    const b = [bl(1, '101', 99.95), bl(2, '150', 45, { dateAdd: imported, dateConfirmed: imported })]
    const r = compareDaySales({ day: '2026-10-26', final: true, from, to, ours: o, bl: b, blComplete: true, blErrors: [], accounts })
    expect(r.accounts[0]).toMatchObject({ ok: true, ours: { count: 2, cents: 14495 }, bl: { count: 2, cents: 14495 }, onlyBl: [], onlyHere: [] })
    // dzień następny: to samo okno danych (± 2 h), zamówienie 150 sparowane z naszym z poprzedniego dnia — nie liczy się
    const next = warsawDay('2026-10-27')
    const r2 = compareDaySales({ day: '2026-10-27', final: true, from: next.from, to: next.to, ours: o, bl: b, blComplete: true, blErrors: [], accounts })
    expect(r2.accounts[0]).toMatchObject({ ok: true, ours: { count: 0 }, bl: { count: 0 }, onlyBl: [] })
    // BL bez pary liczy się po swoim date_add
    const r3 = compareDaySales({ day: '2026-10-27', final: true, from: next.from, to: next.to, ours: [], bl: [bl(3, '300', 10, { dateAdd: imported })], blComplete: true, blErrors: [], accounts })
    expect(r3.accounts[0]).toMatchObject({ ok: false, onlyBl: ['300'] })
  })

  it('import BL z opóźnieniem > 2 h po obu stronach, anulowane i pominięte w `ours`, liczba z rozbiciem', () => {
    const next = warsawDay('2026-10-27')
    const blLate = new Date(next.from.getTime() + 13 * 3600_000) // 27.10 13:00 w Warszawie
    // dzień 26.10: nasze 500 ma parę w BL dopiero z 27.10 (po oknie) — informacja, nie rozjazd
    const o = [
      ours('101', '99.95'),
      ours('500', '40.00'),
      // dane sprzed zmiany znaczenia failed (failed zapisane jako anulowane)
      ours('102', '40.00', null, { orderStatus: 'ANULOWANE', cancelReason: 'CANCELLED', paymentState: 'UNPAID', channelStatus: 'failed', lifecycle: 'CANCELLED' }),
      ours('103', '20.00', null, { orderStatus: null, lifecycle: 'CANCELLED', paymentState: 'PAID', outside: 'pominiete' }),
      ours('104', '25.00', null, { orderStatus: null, lifecycle: 'FULFILLED', outside: 'pominiete' }),
    ]
    const b = [bl(1, '101', 99.95), bl(3, '103', 20)]
    const r = compareDaySales({ day: '2026-10-26', final: true, from, to, ours: o, bl: b, blLater: [bl(2, '500', 40, { dateAdd: blLate })], blComplete: true, blErrors: [], accounts })
    const k = r.accounts[0]!
    expect(k).toMatchObject({ ok: false, blLaterImport: [{ ref: '500', blDay: '2026-10-27' }], notImportedByBl: ['102'], onlyHere: ['104'], ours: { count: 5, cancelled: 2, skipped: 1 } })
    expect(salesCountBreakdown(k, 'ours')).toBe('5 (1 nieimportowane przez BL, 1 import BL z opóźnieniem; w tym 2 anulowane)')
    expect(divergenceMessage('2026-10-26', k)).toContain('Kompletor 5 (1 nieimportowane przez BL, 1 import BL z opóźnieniem; w tym 2 anulowane) zam.')
    expect(divergenceMessage('2026-10-26', k)).toContain('500 (2026-10-27)')
    // dzień 27.10: BL 500 bez pary w oknie, u nas złożone 26.10 → lista informacyjna; BL 600 bez odpowiednika → rozjazd
    const elsewhere = [{ channel: 'WOO' as const, channelAccountId: 'sd', externalId: '500', channelNumber: null, createdAtChannel: from, gross: '40.00' }]
    const r2 = compareDaySales({ day: '2026-10-27', final: true, from: next.from, to: next.to, ours: [], bl: [bl(2, '500', 40, { dateAdd: blLate }), bl(4, '600', 5, { dateAdd: blLate })], elsewhere, blComplete: true, blErrors: [], accounts })
    expect(r2.accounts[0]).toMatchObject({ ok: false, blDelayedImport: [{ ref: '500', ourDay: '2026-10-26' }], onlyBl: ['600'], bl: { count: 2 } })
    expect(salesCountBreakdown(r2.accounts[0]!, 'bl')).toBe('2 (1 import z opóźnieniem, u nas z innego dnia)')
    // wpis dnia (bez nowych pól) — liczba bez rozbicia
    const old = { ...k, ours: { count: 3, cents: 0, beforeStart: 0, notIngested: 0 }, notImportedByBl: [] } as unknown as typeof k
    delete (old as Partial<typeof k>).blLaterImport
    expect(salesCountBreakdown(old, 'ours')).toBe('3')
  })

  it('kwota pary z opóźnionym importem porównywana po obu stronach', () => {
    const next = warsawDay('2026-10-27')
    const blLate = new Date(next.from.getTime() + 13 * 3600_000)
    const elsewhere = [{ channel: 'WOO' as const, channelAccountId: 'sd', externalId: '500', channelNumber: null, createdAtChannel: from, gross: '40.00' }]
    const dayD = (total: number | null) => compareDaySales({ day: '2026-10-26', final: true, from, to, ours: [ours('500', '40.00')], bl: [], blLater: [bl(2, '500', total, { dateAdd: blLate })], blComplete: true, blErrors: [], accounts }).accounts[0]!
    const dayNext = (total: number | null) => compareDaySales({ day: '2026-10-27', final: true, from: next.from, to: next.to, ours: [], bl: [bl(2, '500', total, { dateAdd: blLate })], elsewhere, blComplete: true, blErrors: [], accounts }).accounts[0]!
    // inna kwota: rozjazd po obu stronach, numer zostaje na liście informacyjnej
    expect(dayD(41)).toMatchObject({ ok: false, onlyHere: [], blLaterImport: [{ ref: '500', blDay: '2026-10-27' }], amountDiffs: [{ ref: '500', oursCents: 4000, blCents: 4100 }] })
    expect(dayNext(41)).toMatchObject({ ok: false, onlyBl: [], blDelayedImport: [{ ref: '500', ourDay: '2026-10-26' }], amountDiffs: [{ ref: '500', oursCents: 4000, blCents: 4100 }] })
    expect(divergenceMessage('2026-10-27', dayNext(41))).toContain('Inna kwota: 500 (40,00 / 41,00)')
    // tolerancja 1 gr jak przy zwykłej parze
    expect(dayD(40.01)).toMatchObject({ ok: true, amountDiffs: [] })
    expect(dayNext(40.01)).toMatchObject({ ok: true, amountDiffs: [] })
    // nieczytelna kwota BL: nie uchodzi za zgodną
    expect(dayD(null)).toMatchObject({ ok: false, amountDiffs: [{ ref: '500', oursCents: 4000, blCents: null }] })
    expect(dayNext(null)).toMatchObject({ ok: false, amountDiffs: [{ ref: '500', oursCents: 4000, blCents: null }] })
  })

  it('numery zamówień z wcześniejszych dni, które BL pokazał dopiero w sprawdzanym dniu', () => {
    const next = warsawDay('2026-10-27')
    const inNext = new Date(next.from.getTime() + 3600_000)
    const earlier = new Date(from.getTime() + 3600_000)
    const m = arrivedInDay(next.from, next.to, [
      ours('118438', '40.00', '158405', { createdAtChannel: earlier }), // BL po numerze wtyczki, oba numery w wyniku
      ours('501', '10.00', null, { createdAtChannel: earlier }), // BL niepotwierdzone
      ours('502', '10.00', null, { createdAtChannel: earlier }), // BL z innego dnia
      ours('503', '10.00', null, { createdAtChannel: inNext }), // zamówienie sprawdzanego dnia
    ], [bl(1, '158405', 40, { dateAdd: inNext }), bl(2, '501', 10, { dateAdd: inNext, confirmed: false }), bl(3, '502', 10), bl(4, '503', 10, { dateAdd: inNext })])
    expect([...m.keys()]).toEqual(['2026-10-26'])
    expect([...m.get('2026-10-26')!].sort()).toEqual(['WOO|sd|118438', 'WOO|sd|158405'])
  })

  it('dzień zamykany 30 min po północy w Warszawie (zmiana czasu 25/26.10)', () => {
    expect(warsawDay('2026-10-26')).toEqual({ from: new Date('2026-10-25T23:00:00Z'), to: new Date('2026-10-26T23:00:00Z') })
    expect(warsawDay('2026-10-25').from.toISOString()).toBe('2026-10-24T22:00:00.000Z') // CEST
    expect(dayToClose(new Date('2026-10-26T23:20:00Z'))).toBeNull()
    expect(dayToClose(new Date('2026-10-26T23:30:00Z'))).toBe('2026-10-26')
    expect(dayToClose(new Date('2026-10-27T15:00:00Z'))).toBe('2026-10-26')
  })
})

describe('faktura BL i WZ z wFirmy', () => {
  it('nagłówek faktury: numery, typ i data — nabywca, NIP, adres nie wychodzą', () => {
    const h = blInvoiceHeader({ invoice_id: 55, order_id: 7001, number: 'FV 12/10/2026', external_invoice_number: 'FV 12/2026', type: 'normal', date_add: 1_790_000_000, invoice_fullname: 'Jan Testowy', invoice_nip: '1234563218', invoice_address: 'ul. Fikcyjna 1' })!
    expect(h).toEqual({ blInvoiceId: 55, blOrderId: 7001, number: 'FV 12/10/2026', externalNumber: 'FV 12/2026', kind: 'normal', dateAdd: new Date(1_790_000_000_000) })
    expect(JSON.stringify(h)).not.toMatch(/Testowy|1234563218|Fikcyjna/)
    expect(blInvoiceHeader({ invoice_id: 1, number: 'x', date_add: 1 })).toBeNull()
  })

  it('treść faktury: sumy, płatność, pozycje — nabywca, NIP, adres i nazwy pozycji nie wychodzą', () => {
    const c = blInvoiceContent({
      total_price_brutto: 61.5,
      total_price_netto: '50.00',
      payment: 'Płatność BLIK',
      invoice_fullname: 'Jan Testowy',
      invoice_nip: '1234563218',
      invoice_address: 'ul. Fikcyjna 1',
      items: [
        { name: 'Przyprawa Testowa', sku: 'A1', ean: '590', price_brutto: 25, price_netto: 20.33, tax_rate: 23, quantity: 2, is_shipment: 0 },
        { name: 'Kurier Testowy', sku: '', price_brutto: 11.5, tax_rate: 23, quantity: 1, is_shipment: 1 },
      ],
    })
    expect(c).toEqual({
      totalGross: 61.5,
      totalNet: 50,
      paymentName: 'Płatność BLIK',
      lines: [
        { sku: 'A1', qty: 2, priceGross: 25, taxRate: 23, shipment: false },
        { sku: null, qty: 1, priceGross: 11.5, taxRate: 23, shipment: true },
      ],
    })
    expect(JSON.stringify(c)).not.toMatch(/Testow|1234563218|Fikcyjna/)
    expect(blInvoiceContent({})).toEqual({ totalGross: null, totalNet: null, paymentName: null, lines: null })
  })

  it.each([
    ['PayPal - ktos@example.invalid', 'PayPal'],
    ['PayPal – ktos@example.invalid', 'PayPal'],
    ['PayPal ktos@example.invalid', 'PayPal'],
    ['Przelewy24 - Jan Testowy', 'Przelewy24'],
    ['ktos@example.invalid', null],
    ['Płatność online z PayU', 'Płatność online z PayU'],
    ['Za pobraniem', 'Za pobraniem'],
  ])('W-1: płatność %s → %s, bez adresu płacącego', (payment, nazwa) => {
    const c = blInvoiceContent({ payment })
    expect(c.paymentName).toBe(nazwa)
    expect(JSON.stringify(c)).not.toMatch(/@|Testowy/)
  })

  it('WZ: invoices/find → warehouse_documents/find → pozycje; brak faktury albo WZ = null; nieczytelna pozycja = błąd', async () => {
    const calls: string[] = []
    let wzBody: Record<string, unknown> = {
      warehouse_documents: { '0': { warehouse_document: { id: '9', warehouse_document_contents: { '0': { warehouse_document_content: { good: { id: '100' }, count: '2.0000' } }, '1': { warehouse_document_content: { good: { id: '200' }, count: '0.250' } } } } }, parameters: {} },
    }
    const wf = {
      call: async <T,>(p: string): Promise<T> => {
        calls.push(p)
        if (p === 'invoices/find') return { invoices: { '0': { invoice: { id: '777' } }, parameters: {} } } as T
        return wzBody as T
      },
    }
    const r = new WfirmaWzReader(wf)
    expect(await r.wzForInvoice('FV 12/2026')).toEqual([{ wfirmaGoodId: '100', count: 2 }, { wfirmaGoodId: '200', count: 0.25 }])
    expect(calls).toEqual(['invoices/find', 'warehouse_documents/find'])
    wzBody = { warehouse_documents: { parameters: {} } }
    expect(await r.wzForInvoice('FV 12/2026')).toBeNull()
    wzBody = { warehouse_documents: { '0': { warehouse_document: { warehouse_document_contents: { '0': { warehouse_document_content: { good: { id: '100' } } } } } } } }
    await expect(r.wzForInvoice('FV 12/2026')).rejects.toThrow(/nieczytelna/)
  })
})

describe('metryka „zmiana w kanale → u nas”', () => {
  it('rewizja ISO = chwila zmiany (bez strefy = UTC), numer = brak', () => {
    expect(revisionTime('2026-10-27T10:00:00.000Z')).toBe(Date.parse('2026-10-27T10:00:00Z'))
    expect(revisionTime('2026-10-27T10:00:00')).toBe(Date.parse('2026-10-27T10:00:00Z'))
    expect(revisionTime('2026-10-27T12:00:00+02:00')).toBe(Date.parse('2026-10-27T10:00:00Z'))
    expect(revisionTime('12345')).toBeNull()
  })
})
