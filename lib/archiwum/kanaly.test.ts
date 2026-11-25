// etap 2: mapowanie zamówień Allegro, Empik i EasyTools z przeszłości na wiersz archiwum, czytniki stron
// i plik zamówień (bez bazy, dane fikcyjne).
import { describe, expect, it } from 'vitest'
import { archiwumZAllegro, archiwumZEasyTools, archiwumZMirakl, bezDanychOsobowychAllegro, bezDanychOsobowychEasyTools, bezDanychOsobowychMirakl, statusArchiwumKanalu } from './kanaly'
import { czytnikAllegro, czytnikListy, czytnikMirakl, zamowieniaZPliku, zapytanieStronyAllegro, zapytanieStronyMirakl } from './zrodla'

function allegro(o: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'aaaa-1111',
    status: 'READY_FOR_PROCESSING',
    updatedAt: '2025-12-03T10:00:00.000Z',
    revision: 'r1',
    buyer: { email: 'kupujacy@example.test', login: 'kupujacy', firstName: 'Jan', lastName: 'Testowy', address: { street: 'Testowa 1' } },
    fulfillment: { status: 'SENT', shipmentSummary: { lineItemsSent: 'ALL' } },
    summary: { totalToPay: { amount: '61.99', currency: 'PLN' } },
    payment: { type: 'ONLINE', provider: 'P24', finishedAt: '2025-12-01T09:00:00Z', paidAmount: { amount: '61.99', currency: 'PLN' } },
    delivery: { method: { id: 'm1', name: 'Paczkomat' }, cost: { amount: '11.99', currency: 'PLN' }, address: { firstName: 'Jan', street: 'Testowa 1' }, pickupPoint: { id: 'POZ01M' } },
    invoice: { required: false, address: { company: { taxId: '0000000000' } } },
    messageToSeller: 'proszę o szybką wysyłkę',
    lineItems: [
      { id: 'l1', quantity: 2, price: { amount: '25.00', currency: 'PLN' }, boughtAt: '2025-12-01T08:59:00Z', offer: { id: '1001', name: 'Towar testowy A', external: { id: 'SKU-A' } } },
    ],
    ...o,
  }
}

function mirakl(o: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    order_id: 'E-1-A',
    commercial_id: 'E-1',
    order_state: 'SHIPPED',
    created_date: '2025-06-10T08:00:00Z',
    last_updated_date: '2025-06-12T08:00:00Z',
    total_price: 50,
    shipping_price: 10,
    currency_iso_code: 'PLN',
    shipping_type_label: 'Kurier',
    customer: { firstname: 'Jan', lastname: 'Testowy', billing_address: { street_1: 'Testowa 1' } },
    order_additional_fields: [{ code: 'customer-email', value: 'klient@example.test' }],
    customer_notification_email: 'zastepczy@example.test',
    order_lines: [
      { order_line_id: 'E-1-A-1', order_line_state: 'SHIPPED', quantity: 2, price_unit: 20, price: 40, product_sku: 'P-1', product_title: 'Towar testowy B', offer_sku: 'SKU-B', refunds: [{ amount: 5, reason_code: 'x' }] },
      { order_line_id: 'E-1-A-2', order_line_state: 'REFUSED', quantity: 1, price_unit: 9, price: 9, product_sku: 'P-2', product_title: 'Towar testowy C', offer_sku: 'SKU-C', refunds: [{ amount: 9 }] },
    ],
    ...o,
  }
}

describe('Allegro → archiwum', () => {
  it('przycina formularz do listy pól: bez kupującego, adresów, punktu, wiadomości i danych faktury', () => {
    const r = bezDanychOsobowychAllegro(allegro())
    const tekst = JSON.stringify(r)
    expect(tekst).not.toMatch(/@|Testowy|Testowa|POZ01M|szybką|taxId/)
    expect(r['buyer']).toBeUndefined()
    expect(r['messageToSeller']).toBeUndefined()
    expect(r['delivery']).toEqual({ method: { name: 'Paczkomat' }, cost: { amount: '11.99', currency: 'PLN' } })
    expect(r['invoice']).toEqual({ required: false })
  })

  it('wysłane: WYSLANE, kwoty jak bieżące zamówienie, oferta i SKU pozycji, data = data zakupu', () => {
    const m = archiwumZAllegro(allegro())
    if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
    const z = m.zamowienie
    expect(z).toMatchObject({ externalId: 'aaaa-1111', status: 'WYSLANE', channelStatus: 'READY_FOR_PROCESSING/SENT', paymentState: 'PAID', totalGrossGr: 6199, shippingGrossGr: 1199, refundGrossGr: 0, currency: 'PLN', deliveryMethod: 'Paczkomat' })
    expect(z.createdAtChannel.toISOString()).toBe('2025-12-01T08:59:00.000Z')
    expect(z.sourceRevision).toBe('2025-12-03T10:00:00.000Z')
    expect(z.lines).toEqual([{ externalLineId: 'l1', offerId: '1001', name: 'Towar testowy A', sku: 'SKU-A', ean: null, qtyOffer: 2, lineGrossGr: 5000, vatRate: null, refundGr: 0 }])
  })

  it('statusy: anulowane, odebrane, nieopłacone, za pobraniem w realizacji', () => {
    const st = (o: Partial<Record<string, unknown>>) => {
      const m = archiwumZAllegro(allegro(o))
      return m.rodzaj === 'zamowienie' ? m.zamowienie.status : 'POMIN'
    }
    expect(st({ status: 'CANCELLED', fulfillment: { status: 'CANCELLED' } })).toBe('ANULOWANE')
    expect(st({ fulfillment: { status: 'PICKED_UP' } })).toBe('ODEBRANE')
    expect(st({ status: 'BOUGHT', fulfillment: null, payment: { type: 'ONLINE' } })).toBe('ANULOWANE')
    expect(st({ fulfillment: { status: 'NEW' }, payment: { type: 'CASH_ON_DELIVERY' } })).toBeNull()
  })
})

describe('Empik (OR11) → archiwum', () => {
  it('przycina OR11: bez klienta, pól dodatkowych z e-mailem i adresu zastępczego', () => {
    const tekst = JSON.stringify(bezDanychOsobowychMirakl(mirakl()))
    expect(tekst).not.toMatch(/@|Testowy|Testowa|customer|order_additional_fields|reason_code/)
  })

  it('wysłane: WYSLANE, numer = commercial_id, zwrot tylko z pozycji zamówienia (odrzucona pominięta)', () => {
    const m = archiwumZMirakl(mirakl())
    if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
    expect(m.zamowienie).toMatchObject({ externalId: 'E-1-A', channelNumber: 'E-1', status: 'WYSLANE', paymentState: 'PAID', totalGrossGr: 5000, shippingGrossGr: 1000, refundGrossGr: 500 })
    expect(m.zamowienie.lines).toHaveLength(1)
    expect(m.zamowienie.lines[0]).toMatchObject({ externalLineId: 'E-1-A-1', offerId: 'P-1', sku: 'SKU-B', qtyOffer: 2, lineGrossGr: 4000, refundGr: 500 })
  })

  it('statusy: RECEIVED = ODEBRANE, CANCELED = ANULOWANE, STAGING = szkic, czekające na płatność = ANULOWANE', () => {
    const st = (s: string) => {
      const m = archiwumZMirakl(mirakl({ order_state: s }))
      return m.rodzaj === 'zamowienie' ? m.zamowienie.status : m.powod
    }
    expect(st('RECEIVED')).toBe('ODEBRANE')
    expect(st('CLOSED')).toBe('ODEBRANE')
    expect(st('CANCELED')).toBe('ANULOWANE')
    expect(st('REFUNDED')).toBe('ANULOWANE')
    expect(st('STAGING')).toBe('szkic')
    expect(st('WAITING_DEBIT')).toBe('ANULOWANE')
    expect(st('SHIPPING')).toBeNull()
  })

  it('nieczytelna kwota zwrotu = błąd (nie zero)', () => {
    expect(() => archiwumZMirakl(mirakl({ order_lines: [{ order_line_id: 'x', quantity: 1, price_unit: 5, product_sku: 'P', refunds: [{ amount: 'abc' }] }] }))).toThrow(/zwrotu/)
  })
})

describe('EasyTools → archiwum', () => {
  const et = (o: Partial<Record<string, unknown>> = {}) => ({ id: 'et-1', status: 'completed', amount: 8900, currency: 'pln', quantity: 1, product_name: 'Towar testowy e-book', customer_email: 'k@example.test', created_at: '2026-03-02T10:00:00+01:00', ...o })

  it('bez e-maila klienta; kwota w groszach, jedna pozycja, waluta wielkimi literami', () => {
    expect(JSON.stringify(bezDanychOsobowychEasyTools(et()))).not.toMatch(/@/)
    const m = archiwumZEasyTools(et())
    if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
    expect(m.zamowienie).toMatchObject({ externalId: 'et-1', status: 'WYSLANE', paymentState: 'PAID', totalGrossGr: 8900, currency: 'PLN', sourceRevision: 'completed|8900' })
    expect(m.zamowienie.createdAtChannel.toISOString()).toBe('2026-03-02T09:00:00.000Z')
    expect(m.zamowienie.lines).toEqual([{ externalLineId: '1', offerId: null, name: 'Towar testowy e-book', sku: null, ean: null, qtyOffer: 1, lineGrossGr: 8900, vatRate: null, refundGr: 0 }])
  })

  it('anulowane, zwrócone, czekające na płatność i nieznany status = ANULOWANE (nieznany z ostrzeżeniem)', () => {
    for (const s of ['canceled', 'refunded', 'awaiting_payment', 'cos_nowego']) {
      const m = archiwumZEasyTools(et({ status: s }))
      if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
      expect(m.zamowienie.status).toBe('ANULOWANE')
      expect(m.zamowienie.warnings.length).toBe(s === 'cos_nowego' ? 1 : 0)
    }
  })

  it('nieczytelne pola = błąd', () => {
    expect(() => archiwumZEasyTools(et({ amount: '89.00' }))).toThrow(/kwota/)
    expect(() => archiwumZEasyTools(et({ id: '' }))).toThrow(/bez id/)
    expect(() => archiwumZEasyTools(et({ created_at: 'wczoraj' }))).toThrow(/data/)
    expect(() => archiwumZEasyTools(et({ quantity: 0 }))).toThrow(/ilość/)
  })
})

describe('status archiwum z cyklu życia', () => {
  it('DRAFT pomijany, OPEN opłacone w realizacji', () => {
    expect(statusArchiwumKanalu({ lifecycle: 'DRAFT', paymentState: 'PAID', channelStatus: 'STAGING' })).toBe('POMIN')
    expect(statusArchiwumKanalu({ lifecycle: 'OPEN', paymentState: 'PAID', channelStatus: 'X' })).toBeNull()
    expect(statusArchiwumKanalu({ lifecycle: 'OPEN', paymentState: 'PARTIAL', channelStatus: 'X' })).toBe('ANULOWANE')
  })
})

describe('czytniki stron i plik', () => {
  const q = { od: new Date('2025-06-01T00:00:00Z'), do: new Date('2025-07-01T00:00:00Z'), strona: 3, naStrone: 100 }

  it('Allegro: filtr daty zakupu o sekundę szerszy, sortowanie po dacie zakupu, offset ze strony, sufit 10 000', async () => {
    expect(zapytanieStronyAllegro(q)).toEqual([
      ['lineItems.boughtAt.gte', '2025-05-31T23:59:59.000Z'],
      ['lineItems.boughtAt.lte', '2025-07-01T00:00:01.000Z'],
      ['sort', 'lineItems.boughtAt'],
      ['limit', '100'],
      ['offset', '200'],
    ])
    expect(() => zapytanieStronyAllegro({ ...q, strona: 101 })).toThrow(/podziel zakres/)
    const czytaj = czytnikAllegro(async () => ({ checkoutForms: [{ id: 'a' }, null, 'x'], totalCount: 250 }))
    expect(await czytaj(q)).toEqual({ zamowienia: [{ id: 'a' }], razem: 250, stron: 3 })
  })

  it('Mirakl: zakres daty utworzenia, rosnąco, max i offset', async () => {
    expect(zapytanieStronyMirakl(q)).toEqual({ start_date: '2025-05-31T23:59:59.000Z', end_date: '2025-07-01T00:00:01.000Z', sort: 'dateCreated', order: 'asc', max: 100, offset: 200 })
    const czytaj = czytnikMirakl(async () => ({ orders: [{ order_id: '1' }], totalCount: null }))
    expect(await czytaj(q)).toEqual({ zamowienia: [{ order_id: '1' }], razem: null, stron: null })
  })

  it('plik: lista albo obiekt z checkoutForms / orders / items; zły plik = błąd', () => {
    expect(zamowieniaZPliku('[{"id":1}]')).toEqual([{ id: 1 }])
    expect(zamowieniaZPliku('{"pobrano":"x","checkoutForms":[{"id":"a"}]}')).toEqual([{ id: 'a' }])
    expect(zamowieniaZPliku('{"items":[{"id":"e"}, 5]}')).toEqual([{ id: 'e' }])
    expect(() => zamowieniaZPliku('nie json')).toThrow(/JSON/)
    expect(() => zamowieniaZPliku('{"a":1}')).toThrow(/brak listy/)
  })

  it('czytnik listy: strony po kolei, razem = cały plik', async () => {
    const lista = Array.from({ length: 5 }, (_, i) => ({ id: i }))
    const czytaj = czytnikListy(lista)
    expect(await czytaj({ ...q, strona: 2, naStrone: 2 })).toEqual({ zamowienia: [{ id: 2 }, { id: 3 }], razem: 5, stron: 3 })
    expect((await czytaj({ ...q, strona: 4, naStrone: 2 })).zamowienia).toEqual([])
  })
})
