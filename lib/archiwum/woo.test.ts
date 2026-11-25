// etap 1: mapowanie zamówienia Woo z przeszłości na wiersz archiwum (bez bazy, dane fikcyjne).
import { describe, expect, it } from 'vitest'
import { ReadOnlyViolation } from '../zrodla/http'
import { WooAdapter } from '../adaptery/woo'
import { czytnikWoo, zapytanieStronyWoo } from './czytnik-woo'
import { archiwumZWoo, bezDanychOsobowych, POLA_ZAKAZANE_WOO, POLA_ZAMOWIENIA_WOO, rozlozZwrot, statusArchiwumWoo, zwrotyWooGr } from './woo'

function raw(o: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 118438,
    number: '158405',
    status: 'completed',
    currency: 'PLN',
    date_created_gmt: '2025-06-10T08:15:00',
    date_modified_gmt: '2025-06-12T10:00:00',
    date_paid_gmt: '2025-06-10T08:16:00',
    date_completed_gmt: '2025-06-12T10:00:00',
    total: '75.97',
    shipping_total: '12.19',
    shipping_tax: '2.80',
    payment_method: 'przelewy24',
    line_items: [
      { id: 1, name: 'Towar testowy „Łąka” 100 g', sku: 'H-100', product_id: 501, variation_id: 0, quantity: 2, total: '24.39', total_tax: '5.61' },
      { id: 2, name: 'Kubek', sku: 'K-1', product_id: 502, variation_id: 77, quantity: 1, total: '25.20', total_tax: '5.80' },
    ],
    fee_lines: [],
    shipping_lines: [{ method_title: 'Paczkomat InPost' }],
    refunds: [],
    ...o,
  }
}

describe('archiwumZWoo: mapowanie tą samą normalizacją co bieżące zamówienia', () => {
  it('zamówienie zrealizowane: numer, kwoty w groszach, pozycje z ofertą, status WYSLANE', () => {
    const m = archiwumZWoo(raw())
    expect(m.rodzaj).toBe('zamowienie')
    if (m.rodzaj !== 'zamowienie') return
    const z = m.zamowienie
    expect(z).toMatchObject({ externalId: '118438', channelNumber: '158405', status: 'WYSLANE', channelStatus: 'completed', paymentState: 'PAID', totalGrossGr: 7597, shippingGrossGr: 1499, refundGrossGr: 0, currency: 'PLN', deliveryMethod: 'Paczkomat InPost' })
    expect(z.createdAtChannel.toISOString()).toBe('2025-06-10T08:15:00.000Z')
    expect(z.closedAt?.toISOString()).toBe('2025-06-12T10:00:00.000Z')
    expect(z.lines).toEqual([
      { externalLineId: '1', offerId: '501', name: 'Towar testowy „Łąka” 100 g', sku: 'H-100', ean: null, qtyOffer: 2, lineGrossGr: 3000, vatRate: null, refundGr: 0 },
      { externalLineId: '2', offerId: '502/77', name: 'Kubek', sku: 'K-1', ean: null, qtyOffer: 1, lineGrossGr: 3100, vatRate: null, refundGr: 0 },
    ])
  })

  it('statusy: sprzedaż jak bieżący raport, anulowane osobno, szkic pominięty', () => {
    expect(statusArchiwumWoo('completed', 'PAID')).toBe('WYSLANE')
    expect(statusArchiwumWoo('processing', 'PAID')).toBeNull()
    expect(statusArchiwumWoo('on-hold', 'UNPAID')).toBe('ANULOWANE')
    expect(statusArchiwumWoo('on-hold', 'COD')).toBeNull()
    expect(statusArchiwumWoo('pending', 'UNPAID')).toBe('ANULOWANE')
    expect(statusArchiwumWoo('failed', 'UNPAID')).toBe('ANULOWANE')
    expect(statusArchiwumWoo('cancelled', 'PAID')).toBe('ANULOWANE')
    expect(statusArchiwumWoo('refunded', 'PAID')).toBe('ANULOWANE')
    expect(statusArchiwumWoo('wc-wlasny', 'PAID')).toBeNull()
    expect(statusArchiwumWoo('checkout-draft', 'UNPAID')).toBe('POMIN')
    expect(archiwumZWoo(raw({ status: 'trash' }))).toEqual({ rodzaj: 'pominiete', powod: 'szkic' })
    const pobranie = archiwumZWoo(raw({ status: 'on-hold', payment_method: 'cod', date_paid_gmt: null }))
    expect(pobranie.rodzaj === 'zamowienie' && pobranie.zamowienie.status).toBeNull()
    const nieoplacone = archiwumZWoo(raw({ status: 'pending', date_paid_gmt: null }))
    expect(nieoplacone.rodzaj === 'zamowienie' && nieoplacone.zamowienie.status).toBe('ANULOWANE')
  })

  it('rabat z ujemnej opłaty rozłożony na ceny pozycji regułą adaptera (jak w Order)', () => {
    const m = archiwumZWoo(raw({ total: '68.97', fee_lines: [{ total: '-5.69', total_tax: '-1.31' }] }))
    if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
    const towary = m.zamowienie.lines.reduce((s, l) => s + l.lineGrossGr, 0)
    expect(towary).toBeLessThan(6100)
    expect(m.zamowienie.warnings.some((w) => w.includes('rabat na zamówienie'))).toBe(true)
  })

  it('zwrot częściowy: kwota rozłożona proporcjonalnie, najwyżej do wartości pozycji', () => {
    expect(zwrotyWooGr(raw({ refunds: [{ id: 9, reason: 'tekst klienta', total: '-10.00' }, { id: 10, total: '-2.50' }] }), '1')).toBe(1250)
    expect(() => zwrotyWooGr(raw({ refunds: [{ total: 'abc' }] }), '1')).toThrow(/nieczytelna kwota zwrotu/)
    expect(rozlozZwrot([3000, 3100], 1250)).toEqual([614, 636])
    expect(rozlozZwrot([3000, 3100], 99_999)).toEqual([3000, 3100])
    expect(rozlozZwrot([3000, 3100], 0)).toEqual([0, 0])
    expect(rozlozZwrot([0, 0], 500)).toEqual([0, 0])
    // zwrot 30,00 zł przy wysyłce 14,99 zł: na towary schodzi 15,01 zł (przegląd etapu 1, W: zwrot wysyłki)
    const m = archiwumZWoo(raw({ refunds: [{ id: 9, total: '-30.00' }] }))
    if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
    expect(m.zamowienie.refundGrossGr).toBe(3000)
    expect(m.zamowienie.lines.map((l) => l.refundGr)).toEqual([738, 763])
  })

  it('zwrot samej wysyłki (nie większy niż koszt wysyłki) nie zmniejsza sprzedaży towarów', () => {
    for (const total of ['-14.99', '-5.00']) {
      const m = archiwumZWoo(raw({ refunds: [{ id: 9, total }] }))
      if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
      expect(m.zamowienie.refundGrossGr).toBe(Math.round(-Number(total) * 100))
      expect(m.zamowienie.lines.map((l) => l.refundGr)).toEqual([0, 0])
    }
  })

  it('nieczytelne pole = błąd (nigdy 0)', () => {
    expect(() => archiwumZWoo(raw({ total: 'x' }))).toThrow()
    expect(() => archiwumZWoo(raw({ line_items: 'x' }))).toThrow()
    expect(() => archiwumZWoo(raw({ id: undefined }))).toThrow()
  })
})

describe('bez danych osobowych', () => {
  it('lista pól odczytu nie zawiera danych klienta ani nazwy metody płatności', () => {
    const pola = POLA_ZAMOWIENIA_WOO.split(',')
    for (const z of POLA_ZAKAZANE_WOO) expect(pola).not.toContain(z)
  })

  it('pola spoza listy są odrzucane, zanim cokolwiek je czyta; w wyniku nie ma danych klienta', () => {
    const r = raw({ billing: { email: 'jan@przyklad.test', phone: '600100200' }, shipping: { address_1: 'ul. Testowa 1' }, customer_note: 'notatka', payment_method_title: 'PayPal jan@przyklad.test', meta_data: [{ key: '_billing_nip', value: '1234567890' }], customer_ip_address: '10.0.0.1' })
    const czyste = bezDanychOsobowych(r)
    for (const z of POLA_ZAKAZANE_WOO) expect(czyste).not.toHaveProperty(z)
    const m = archiwumZWoo(czyste)
    const tekst = JSON.stringify(m)
    for (const s of ['jan@przyklad.test', '600100200', 'Testowa', 'notatka', '1234567890', '10.0.0.1', 'PayPal']) expect(tekst).not.toContain(s)
  })

  it('adapter: lista zamówień do archiwum tylko z `_fields` bez pól klienta', async () => {
    const wolania: string[] = []
    const fetchImpl = (async (url: string) => {
      wolania.push(String(url))
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'x-wp-total': '0', 'x-wp-totalpages': '0' } })
    }) as unknown as typeof fetch
    const a = new WooAdapter({ config: { baseUrl: 'https://sklep.przyklad.test' }, secrets: { WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's' }, fetch: fetchImpl, http: { minIntervalMs: 0 } } as never)
    await expect(a.odczytListyZamowienArchiwum({ per_page: 1 })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(a.odczytListyZamowienArchiwum({ _fields: 'id,billing' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(a.odczytListyZamowienArchiwum({ _fields: 'id,payment_method_title' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(a.odczytListyZamowienArchiwum({ _fields: 'id,shipping.address_1' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(a.odczytListyZamowienArchiwum({ _fields: 'id,customer_note' })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(wolania).toEqual([])
    const s = await czytnikWoo((q) => a.odczytListyZamowienArchiwum(q))({ od: new Date('2025-01-01T00:00:00Z'), do: new Date('2025-02-01T00:00:00Z'), strona: 2, naStrone: 100 })
    expect(s).toEqual({ zamowienia: [], razem: 0, stron: 0 })
    expect(wolania).toHaveLength(1)
    const u = new URL(wolania[0]!)
    expect(u.pathname).toBe('/wp-json/wc/v3/orders')
    expect(Object.fromEntries(u.searchParams)).toEqual({ ...Object.fromEntries(Object.entries(zapytanieStronyWoo({ od: new Date('2025-01-01T00:00:00Z'), do: new Date('2025-02-01T00:00:00Z'), strona: 2, naStrone: 100 })).map(([k, v]) => [k, String(v)])) })
    expect(u.searchParams.get('after')).toBe('2024-12-31T23:59:59')
    expect(u.searchParams.get('before')).toBe('2025-02-01T00:00:01')
    expect(u.searchParams.get('_fields')).toBe(POLA_ZAMOWIENIA_WOO)
  })
})

describe('sufit rabatu firmy w archiwum (przegląd etapu 1, W: sufit rabatu)', () => {
  it('adapter podaje sufit z ustawień firmy, a źródło Woo przekazuje go do mapowania', async () => {
    const { zrodloWoo } = await import('./import')
    const a = new WooAdapter({ config: { baseUrl: 'https://sklep.przyklad.test' }, secrets: { WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's' }, fetch: async () => new Response('[]'), http: { minIntervalMs: 0 }, ustawieniaFirmy: { rabatMaksProcent: 7 } } as never)
    expect(a.opcjeZamowienArchiwum()).toEqual({ rabatMaksProcent: 7 })
    const r = raw({ fee_lines: [{ id: 5, name: 'Rabat', total: '-20.00', total_tax: '0' }] })
    for (const sufit of [0, 7, 100]) {
      const zr = zrodloWoo(async () => ({ zamowienia: [], razem: 0, stron: 0 }), { rabatMaksProcent: sufit })
      expect(JSON.stringify(zr.mapuj(r))).toBe(JSON.stringify(archiwumZWoo(r, { rabatMaksProcent: sufit })))
    }
  })
})
