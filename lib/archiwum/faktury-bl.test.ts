import { describe, expect, it } from 'vitest'
import { archiwumZFakturyBl, bezDanychOsobowychFaktury, fakturaBlZSurowej, fakturyZPliku, parujFaktury, zrodloFakturyBl, zwrotyZKorekt, type KandydatPary } from './faktury-bl'

const T0 = Date.UTC(2025, 5, 10, 10) / 1000
const surowa = (o: Partial<Record<string, unknown>> = {}) => ({
  invoice_id: 1001,
  order_id: 5001,
  series_id: 1,
  type: 'normal',
  number: '1/6/2025',
  date_add: T0,
  date_sell: T0,
  currency: 'PLN',
  total_price_brutto: 52.5,
  total_price_netto: 42.68,
  correcting_to_invoice_id: 0,
  payment: 'kupujacy@example.com',
  invoice_fullname: 'Jan Testowy',
  invoice_nip: '1234567890',
  invoice_address: 'ul. Testowa 1',
  issuer: 'Pracownik',
  additional_info: 'uwaga',
  items: [
    { name: 'Towar testowy A', sku: 'A-1', ean: '5900000000001', price_brutto: 20, price_netto: 16.26, tax_rate: 23, quantity: 2, is_shipment: 0, order_product_id: 11 },
    { name: 'Wysyłka', sku: '', ean: '', price_brutto: 12.5, tax_rate: 23, quantity: 1, is_shipment: 1, order_product_id: 0 },
  ],
  ...o,
})
const kand = (o: Partial<KandydatPary> = {}): KandydatPary => ({ kanal: 'WOO', id: 'w1', czas: new Date(T0 * 1000 - 3600_000), bruttoGr: 5250, waluta: 'PLN', skus: ['A-1'], ...o })

describe('faktury BL: przycięcie i odczyt', () => {
  it('odcina dane nabywcy, payment, wystawcę i uwagi', () => {
    const r = bezDanychOsobowychFaktury(surowa())
    for (const k of ['payment', 'invoice_fullname', 'invoice_nip', 'invoice_address', 'issuer', 'additional_info']) expect(r).not.toHaveProperty(k)
    expect(JSON.stringify(r)).not.toContain('example.com')
    expect(r['invoice_id']).toBe(1001)
  })
  it('plik JSON Lines i lista JSON dają to samo; zły wiersz = błąd', () => {
    const a = fakturyZPliku(`${JSON.stringify(surowa())}\n${JSON.stringify(surowa({ invoice_id: 1002 }))}\n`)
    const b = fakturyZPliku(JSON.stringify([surowa(), surowa({ invoice_id: 1002 })]))
    expect(a).toEqual(b)
    expect(a).toHaveLength(2)
    expect(() => fakturyZPliku('{"a":1}\nnie-json')).toThrow(/wiersz 2/)
  })
  it('kwoty w groszach, wysyłka osobno, data sprzedaży', () => {
    const f = fakturaBlZSurowej(surowa())
    expect(f.bruttoGr).toBe(5250)
    expect(f.pozycje.map((p) => [p.bruttoGr, p.wysylka])).toEqual([[4000, false], [1250, true]])
    expect(f.czasSprzedazy.getTime()).toBe(T0 * 1000)
  })
  it('nieczytelna kwota albo brak id = błąd', () => {
    expect(() => fakturaBlZSurowej(surowa({ total_price_brutto: 'x' }))).toThrow(/kwota/)
    expect(() => fakturaBlZSurowej(surowa({ invoice_id: 0 }))).toThrow(/invoice_id/)
  })
})

describe('parujFaktury', () => {
  const f = (o: Partial<Record<string, unknown>> = {}) => fakturaBlZSurowej(surowa(o))
  it('para: kwota ±1 gr i okno dat; poza oknem albo inna kwota = brak pary', () => {
    expect(parujFaktury([f()], [kand()]).get(1001)?.id).toBe('w1')
    expect(parujFaktury([f({ total_price_brutto: 52.51 })], [kand()]).get(1001)?.id).toBe('w1')
    expect(parujFaktury([f({ total_price_brutto: 52.52 })], [kand()]).size).toBe(0)
    expect(parujFaktury([f()], [kand({ czas: new Date(T0 * 1000 - 22 * 86_400_000) })]).size).toBe(0)
    expect(parujFaktury([f()], [kand({ czas: new Date(T0 * 1000 + 2 * 86_400_000) })]).size).toBe(0)
    expect(parujFaktury([f({ currency: 'CZK' })], [kand()]).size).toBe(0)
  })
  it('jeden do jednego: zgodne SKU wygrywa, potem bliższa data; wynik niezależny od kolejności', () => {
    const fa = [f(), f({ invoice_id: 1002, items: [{ name: 'B', sku: 'B-1', price_brutto: 52.5, quantity: 1, is_shipment: 0 }] })]
    const ka = [kand({ id: 'bliski-inne-sku', skus: ['B-1'], czas: new Date(T0 * 1000 - 60_000) }), kand({ id: 'dalszy-to-samo-sku', czas: new Date(T0 * 1000 - 5 * 86_400_000) })]
    const p1 = parujFaktury(fa, ka)
    const p2 = parujFaktury([...fa].reverse(), [...ka].reverse())
    expect(p1.get(1001)?.id).toBe('dalszy-to-samo-sku')
    expect(p1.get(1002)?.id).toBe('bliski-inne-sku')
    expect([...p2].sort()).toEqual([...p1].sort())
    // jeden kandydat na dwie faktury: druga bez pary
    expect(parujFaktury([f(), f({ invoice_id: 1003 })], [kand()]).size).toBe(1)
  })
  it('korekty nie są parowane', () => {
    expect(parujFaktury([f({ type: 'correcting', correcting_to_invoice_id: 999 })], [kand()]).size).toBe(0)
  })
})

describe('archiwum z faktury', () => {
  it('wiersz Allegro: pozycje bez wysyłki, wysyłka w shippingGross, zwrot z korekty na pozycje', () => {
    const fa = fakturaBlZSurowej(surowa())
    const kor = fakturaBlZSurowej(surowa({ invoice_id: 2001, type: 'correcting', correcting_to_invoice_id: 1001, total_price_brutto: -20, items: [] }))
    const zw = zwrotyZKorekt([fa, kor])
    expect(zw.get(1001)).toBe(2000)
    const m = archiwumZFakturyBl(fa, zw.get(1001))
    if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
    const z = m.zamowienie
    expect(z.externalId).toBe('1001')
    expect(z.totalGrossGr).toBe(5250)
    expect(z.shippingGrossGr).toBe(1250)
    expect(z.refundGrossGr).toBe(2000)
    expect(z.lines).toHaveLength(1)
    expect(z.lines[0]).toMatchObject({ sku: 'A-1', qtyOffer: 2, lineGrossGr: 4000, refundGr: 2000, offerId: null })
    expect(z.status).toBe('WYSLANE')
    expect(z.warnings).toEqual([])
  })
  it('źródło: faktura z parą pominięta, bez pary = zamówienie z numerem BL i numerem faktury; korekty nie są zamówieniami', async () => {
    const raw = [surowa(), surowa({ invoice_id: 1002 }), surowa({ invoice_id: 2001, type: 'correcting', correcting_to_invoice_id: 1002, total_price_brutto: -52.5, items: [] })].map(bezDanychOsobowychFaktury)
    const zr = zrodloFakturyBl(raw, new Map([[1001, kand()]]))
    expect(zr.kanalOdtworzony).toBe(true)
    const s = await zr.czytaj({ od: new Date(0), do: new Date(), strona: 1, naStrone: 500 })
    expect(s.zamowienia).toHaveLength(2)
    expect(zr.mapuj(s.zamowienia[0]!)).toEqual({ rodzaj: 'pominiete', powod: 'para w innym kanale' })
    const m = zr.mapuj(s.zamowienia[1]!)
    if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
    expect(m.zamowienie).toMatchObject({ externalId: '1002', blOrderId: 5001, invoiceNumbers: ['1/6/2025'], refundGrossGr: 5250, status: 'ANULOWANE' })
  })
})
