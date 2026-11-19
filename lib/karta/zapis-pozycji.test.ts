// która decyzja o braku z formularza idzie do rdzenia. Logika czysta, bez bazy.
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { cenaDoZapisu, decyzjaDoZapisu, iloscDoZapisu, zmianyZFormularza } = await import('./zapis-pozycji')
const { normalizujStawke } = await import('@/lib/rdzen/edycja')

describe('decyzjaDoZapisu', () => {
  it('brak decyzji w polu: nic', () => {
    expect(decyzjaDoZapisu(undefined, 'ZAMIEN', undefined)).toBe(false)
    expect(decyzjaDoZapisu('', undefined, 'X')).toBe(false)
  })
  it('nowa albo inna niż zapisana: zapis', () => {
    expect(decyzjaDoZapisu('DOSLIJ', undefined, undefined)).toBe(true)
    expect(decyzjaDoZapisu('ZAMIEN', 'DOSLIJ', undefined)).toBe(true)
  })
  it('ta sama decyzja inna niż ZAMIEN: bez zapisu', () => {
    expect(decyzjaDoZapisu('DOSLIJ', 'DOSLIJ', undefined)).toBe(false)
  })
  it('ta sama ZAMIEN z polem SKU: zapis (inny zamiennik rozpoznaje rdzeń)', () => {
    expect(decyzjaDoZapisu('ZAMIEN', 'ZAMIEN', 'A127-Z2')).toBe(true)
    expect(decyzjaDoZapisu('ZAMIEN', 'ZAMIEN', '')).toBe(true)
  })
  it('ta sama ZAMIEN bez pola SKU (po spakowaniu pole nie jest renderowane): bez zapisu', () => {
    expect(decyzjaDoZapisu('ZAMIEN', 'ZAMIEN', undefined)).toBe(false)
  })
})

describe('normalizujStawke', () => {
  it('liczby z kanału do postaci z listy, teksty bez zmian, pusta = null', () => {
    for (const v of ['23', '23.00', '23.0', '23,00', ' 23.00 ']) expect(normalizujStawke(v)).toBe('23')
    expect(normalizujStawke('8.00')).toBe('8')
    expect(normalizujStawke('0.00')).toBe('0')
    expect(normalizujStawke('zw')).toBe('zw')
    expect(normalizujStawke('NP')).toBe('np')
    expect(normalizujStawke('7.50')).toBe('7.50') // spoza listy i nie całkowita: oryginał
    expect(normalizujStawke('')).toBeNull()
    expect(normalizujStawke(null)).toBeNull()
  })
})

describe('cenaDoZapisu', () => {
  const l = { unitPriceGross: '10', vatRate: '23.00' as string | null }
  it('VAT „23.00” z kanału i „23” z listy: bez zmiany (z ukrytym polem i bez)', () => {
    expect(cenaDoZapisu({ cena: '10,00', vat: '23' }, l)).toBe('bez')
    expect(cenaDoZapisu({ cena: '10,00', vat: '23', cenaBylo: '10,00', vatBylo: '23' }, l)).toBe('bez')
  })
  it('zmiana tylko tego, co osoba zmieniła; niezmieniona część nie idzie do rdzenia', () => {
    expect(cenaDoZapisu({ cena: '12,50', vat: '23', cenaBylo: '10,00', vatBylo: '23' }, l)).toEqual({ cena: '12,50', vat: '', bylo: { priceGrossGr: 1000 } })
    expect(cenaDoZapisu({ cena: '10,00', vat: '8', cenaBylo: '10,00', vatBylo: '23' }, l)).toEqual({ cena: '', vat: '8', bylo: { vatRate: '23' } })
  })
  it('ktoś zmienił cenę w międzyczasie: formularz ze starą ceną nie cofa jej, nowa zmiana tej pozycji to konflikt', () => {
    const poZmianie = { unitPriceGross: '12', vatRate: '23.00' }
    expect(cenaDoZapisu({ cena: '10,00', vat: '23', cenaBylo: '10,00', vatBylo: '23' }, poZmianie)).toBe('bez')
    expect(cenaDoZapisu({ cena: '11,00', vat: '23', cenaBylo: '10,00', vatBylo: '23' }, poZmianie)).toBe('konflikt')
    expect(cenaDoZapisu({ cena: '10,00', vat: '5', cenaBylo: '10,00', vatBylo: '8' }, poZmianie)).toBe('konflikt')
  })
  it('pusta cena = bez zmiany; zła cena idzie do rdzenia po komunikat', () => {
    expect(cenaDoZapisu({ cena: '', vat: '', cenaBylo: '10,00', vatBylo: '23' }, l)).toBe('bez')
    expect(cenaDoZapisu({ cena: 'abc', vat: '23', cenaBylo: '10,00', vatBylo: '23' }, l)).toEqual({ cena: 'abc', vat: '' })
  })
})

describe('iloscDoZapisu', () => {
  it('względem ilości z renderu; cudza zmiana nie jest cofana, własna przy cudzej to konflikt', () => {
    expect(iloscDoZapisu({ ilosc: '3', iloscBylo: '3' }, { qty: 3 })).toBe('bez')
    expect(iloscDoZapisu({ ilosc: '4', iloscBylo: '3' }, { qty: 3 })).toBe('zmiana')
    expect(iloscDoZapisu({ ilosc: '3', iloscBylo: '3' }, { qty: 5 })).toBe('bez')
    expect(iloscDoZapisu({ ilosc: '4', iloscBylo: '3' }, { qty: 5 })).toBe('konflikt')
    expect(iloscDoZapisu({ ilosc: '4' }, { qty: 3 })).toBe('zmiana')
    expect(iloscDoZapisu({ ilosc: '' }, { qty: 3 })).toBe('bez')
  })
  it('formularz: pola *_bylo_ trafiają do zmian pozycji', () => {
    const f = new FormData()
    f.set('ilosc_l1', '4')
    f.set('ilosc_bylo_l1', '3')
    f.set('cena_bylo_l1', '10,00')
    f.set('vat_bylo_l1', '23.00')
    f.set('vat_l1', '23.00')
    expect(zmianyZFormularza(f)).toEqual([{ lineId: 'l1', ilosc: '4', iloscBylo: '3', cenaBylo: '10,00', vatBylo: '23.00', vat: '23.00' }])
  })
})
