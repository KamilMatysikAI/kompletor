// walidacja formularza produktu, skład zestawu, netto z brutto, ile zestawów, adresy zdjęć z oferty.
import { describe, expect, it } from 'vitest'
import { wooBrutto, wooOfferFromApi, wooVatByClass } from '../adaptery/woo'
import { checkKwota, checkPola, checkSklad, ileZestawow, nettoZBrutto, polaTylkoDoOdczytu } from './karta'
import { adresWewnetrzny, bezpiecznyAdresZdjecia } from './zdjecia'

describe('formularz produktu', () => {
  it('kwoty z przecinkiem, ujemne i tekst odrzucone', () => {
    expect(checkKwota('19,90', 'Cena')).toEqual({ ok: true, value: 19.9 })
    expect(checkKwota('', 'Cena')).toEqual({ ok: true, value: null })
    expect(checkKwota('-1', 'Cena').ok).toBe(false)
    expect(checkKwota('abc', 'Cena').ok).toBe(false)
  })

  it('pola: tylko obecne w formularzu, stawka VAT z listy, wymiary z jednym miejscem po przecinku', () => {
    expect(checkPola({ nazwa: 'X', vat: '8', dlugosc: '10,25', waga: '' }, { wymagajNazwy: true })).toEqual({ ok: true, value: { title: 'X', vatRate: '8', lengthCm: 10.3, weightG: null } })
    expect(checkPola({ vat: '7' }, { wymagajNazwy: false })).toMatchObject({ ok: false, field: 'vat' })
    expect(checkPola({ waga: '1,5' }, { wymagajNazwy: false })).toEqual({ ok: true, value: { weightG: 2 } })
    expect(checkPola({ opis: 'a\u0007b' }, { wymagajNazwy: false })).toMatchObject({ ok: false, field: 'opis' })
    expect(checkPola({}, { wymagajNazwy: true })).toMatchObject({ ok: false, field: 'nazwa' })
  })

  it('netto z brutto; zw i np bez podatku', () => {
    expect(nettoZBrutto(24.6, '23')).toBe(20)
    expect(nettoZBrutto(10.5, '5')).toBe(10)
    expect(nettoZBrutto(10, 'zw')).toBe(10)
    expect(nettoZBrutto(null, '23')).toBeNull()
  })

  it('pola tylko do odczytu tylko przy wFirmie', () => {
    expect(polaTylkoDoOdczytu('WFIRMA').pola).toContain('priceGross')
    expect(polaTylkoDoOdczytu('RECZNE').pola).toEqual([])
    expect(polaTylkoDoOdczytu('KANAL').pola).toEqual([])
  })
})

describe('skład zestawu', () => {
  it('pomija puste wiersze, odrzuca dubel, zero i udziały ≠ 100%', () => {
    expect(checkSklad(['a', '', 'b'], ['2', '', '1'], ['', '', ''])).toEqual({ ok: true, value: [{ productId: 'a', qtyBase: 2, priceShare: null }, { productId: 'b', qtyBase: 1, priceShare: null }] })
    expect(checkSklad(['a', 'a'], ['1', '1'], ['', '']).ok).toBe(false)
    expect(checkSklad(['a'], ['0'], ['']).ok).toBe(false)
    expect(checkSklad(['a', 'b'], ['1', '1'], ['70', '']).ok).toBe(false)
    expect(checkSklad(['a', 'b'], ['1', '1'], ['70', '30'])).toMatchObject({ ok: true, value: [{ priceShare: 0.7 }, { priceShare: 0.3 }] })
  })

  it('ile zestawów z dostępnego stanu', () => {
    expect(ileZestawow([{ qtyBase: 2, dostepne: 9 }, { qtyBase: 1, dostepne: 3 }])).toBe(3)
    expect(ileZestawow([{ qtyBase: 2, dostepne: 1 }])).toBe(0)
    expect(ileZestawow([])).toBe(0)
  })
})

describe('zdjęcia z oferty sklepu', () => {
  it('tylko https z publiczną nazwą hosta', () => {
    expect(bezpiecznyAdresZdjecia('https://sklep.example/a.jpg')?.hostname).toBe('sklep.example')
    for (const u of ['http://sklep.example/a.jpg', 'https://localhost/a.jpg', 'https://192.168.1.5/a.jpg', 'https://[::1]/a.jpg', 'https://u:p@sklep.example/a.jpg', 'https://serwer.internal/a.jpg', 'https://intranet/a.jpg', 'file:///etc/passwd'])
      expect(bezpiecznyAdresZdjecia(u), u).toBeNull()
  })

  it('adresy wewnętrzne z DNS', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.0.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1']) expect(adresWewnetrzny(ip), ip).toBe(true)
    for (const ip of ['93.184.216.34', '2606:4700::1111', '172.32.0.1']) expect(adresWewnetrzny(ip), ip).toBe(false)
  })

  it('oferta Woo: zdjęcia (wariant, potem rodzic), cena brutto tylko przy cenach z podatkiem', () => {
    const raw = { id: 5, name: 'Przyprawa', sku: 'H5', status: 'publish', manage_stock: false, regular_price: '19.90', price: '17.00', images: [{ src: 'https://sklep.example/1.jpg' }, { src: 'http://sklep.example/2.jpg' }] }
    expect(wooOfferFromApi(raw, '5', null, true)).toMatchObject({ priceGross: 19.9, vatRate: null, imageUrls: ['https://sklep.example/1.jpg'] })
    expect(wooOfferFromApi(raw, '5', null, false).priceGross).toBeNull()
    expect(wooOfferFromApi(raw, '5', null, null).priceGross).toBeNull()
    const v = { id: 7, sku: 'H5-V', manage_stock: false, regular_price: '', price: '15', image: { src: 'https://sklep.example/v.jpg' } }
    expect(wooOfferFromApi(v, '5/7', raw, true)).toMatchObject({ priceGross: 15, imageUrls: ['https://sklep.example/v.jpg', 'https://sklep.example/1.jpg'] })
  })

  it('stawka VAT z klasy podatkowej Woo (/taxes), brutto z netto przy cenach bez podatku', () => {
    const vat = wooVatByClass([
      { id: 1, country: 'PL', rate: '23.0000', class: 'standard' },
      { id: 2, country: 'PL', rate: '8.0000', class: 'obnizona-8' },
      { id: 3, country: '', rate: '5.0000', class: 'obnizona-5' },
      { id: 4, country: 'DE', rate: '19.0000', class: 'standard' },
      { id: 5, country: 'PL', rate: '23.0000', class: 'mieszana' },
      { id: 6, country: 'PL', rate: '8.0000', class: 'mieszana' },
      { id: 7, country: 'PL', rate: '7.5000', class: 'dziwna' },
    ])
    expect(Object.fromEntries(vat)).toEqual({ standard: '23', 'obnizona-8': '8', 'obnizona-5': '5' })
    const raw = { id: 5, name: 'Przyprawa', sku: 'H5', status: 'publish', manage_stock: false, regular_price: '10.00', tax_status: 'taxable', tax_class: '' }
    expect(wooOfferFromApi(raw, '5', null, true, vat)).toMatchObject({ priceGross: 10, vatRate: '23' })
    expect(wooOfferFromApi(raw, '5', null, false, vat)).toMatchObject({ priceGross: 12.3, vatRate: '23' })
    expect(wooOfferFromApi({ ...raw, tax_class: 'obnizona-8' }, '5', null, false, vat)).toMatchObject({ priceGross: 10.8, vatRate: '8' })
    expect(wooOfferFromApi({ ...raw, tax_class: 'mieszana' }, '5', null, false, vat)).toMatchObject({ priceGross: null, vatRate: null })
    expect(wooOfferFromApi({ ...raw, tax_status: 'none' }, '5', null, true, vat)).toMatchObject({ priceGross: 10, vatRate: null })
    // wariant z klasą „parent” bierze klasę produktu nadrzędnego
    const rodzic = { ...raw, tax_class: 'obnizona-5' }
    expect(wooOfferFromApi({ id: 7, sku: 'H5-V', manage_stock: false, regular_price: '20', tax_class: 'parent' }, '5/7', rodzic, false, vat)).toMatchObject({ priceGross: 21, vatRate: '5' })
    // bez odczytu stawek: jak dotąd
    expect(wooOfferFromApi(raw, '5', null, false, null)).toMatchObject({ priceGross: null, vatRate: null })
  })
  it('brutto z netto na groszach z tekstu ceny, połówki w górę, netto z 4 miejsc nieucinane', () => {
    expect(wooBrutto('0.50', 23)).toBe(0.62)
    expect(wooBrutto('7.50', 23)).toBe(9.23)
    expect(wooBrutto('12.50', 23)).toBe(15.38)
    // 4 miejsca po przecinku liczą się przed mnożeniem: 8,1301 × 1,23 = 10,000023 → 10,00
    expect(wooBrutto('8.1301', 23)).toBe(10)
    expect(wooBrutto('0.4045', 23)).toBe(0.5) // 0,497535 → 0,50; ucięcie do 0,40 dałoby 0,49
    expect(wooBrutto('10.005', 0)).toBe(10.01) // ceny brutto z 4 miejscami: połówka w górę
    expect(wooBrutto('12,50', 23)).toBeNull()
    expect(wooBrutto('', 23)).toBeNull()
    const raw = { id: 5, name: 'Przyprawa', sku: 'H5', status: 'publish', manage_stock: false, regular_price: '7.50', tax_status: 'taxable', tax_class: '' }
    const vat = wooVatByClass([{ id: 1, country: 'PL', rate: '23.0000', class: 'standard' }])
    expect(wooOfferFromApi(raw, '5', null, false, vat)).toMatchObject({ priceGross: 9.23, vatRate: '23' })
  })

  it('szeroki zakres cen × 23/8/5/0 zgodny z obliczeniem wzorcowym na BigInt', () => {
    const wzorzec = (netto: string, stawka: number): number => {
      const [c, u = ''] = netto.split('.')
      const n = BigInt(c!) * 10000n + BigInt(u.padEnd(4, '0'))
      const g = (n * BigInt(100 + stawka) + 5000n) / 10000n
      return Number(g) / 100
    }
    let sprawdzone = 0
    for (let gr = 1; gr <= 20000; gr++) {
      const netto = `${Math.floor(gr / 100)}.${String(gr % 100).padStart(2, '0')}`
      for (const st of [23, 8, 5, 0]) {
        expect(wooBrutto(netto, st)).toBe(wzorzec(netto, st))
        sprawdzone++
      }
    }
    // ceny z 4 miejscami i duże kwoty
    for (let i = 0; i < 5000; i++) {
      const netto = `${(i * 7919) % 1000000}.${String((i * 104729) % 10000).padStart(4, '0')}`
      for (const st of [23, 8, 5]) expect(wooBrutto(netto, st)).toBe(wzorzec(netto, st))
    }
    expect(wooBrutto('999999999.9999', 23)).toBe(wzorzec('999999999.9999', 23))
    expect(sprawdzone).toBe(80000)
  })

  it('podatek tylko od wysyłki = brak stawki; dwa wiersze tej samej klasy i kraju = brak stawki', () => {
    const vat = wooVatByClass([
      { id: 1, country: 'PL', rate: '23.0000', class: 'standard' },
      { id: 2, country: 'PL', rate: '8.0000', class: 'podwojna', priority: 1 },
      { id: 3, country: 'PL', rate: '8.0000', class: 'podwojna', priority: 2 },
      { id: 4, country: '', rate: '5.0000', class: 'dowolny-podwojny' },
      { id: 5, country: '', rate: '5.0000', class: 'dowolny-podwojny' },
    ])
    expect(Object.fromEntries(vat)).toEqual({ standard: '23' })
    const raw = { id: 5, name: 'Przyprawa', sku: 'H5', status: 'publish', manage_stock: false, regular_price: '10.00', tax_status: 'taxable', tax_class: '' }
    expect(wooOfferFromApi({ ...raw, tax_class: 'podwojna' }, '5', null, false, vat)).toMatchObject({ priceGross: null, vatRate: null })
    expect(wooOfferFromApi({ ...raw, tax_status: 'shipping' }, '5', null, false, vat)).toMatchObject({ priceGross: null, vatRate: null })
    expect(wooOfferFromApi({ ...raw, tax_status: 'shipping' }, '5', null, true, vat)).toMatchObject({ priceGross: 10, vatRate: null })
  })
})
