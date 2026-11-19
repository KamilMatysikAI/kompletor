import { describe, expect, it } from 'vitest'
import { odczytaniaFrazy } from '../klienci/skroty'
import { adresPoSzukaniu } from './szukaj-adres'

const pieczec = (f: string) => `TOKEN(${f.length})`

describe('jedno pole szukania (R6)', () => {
  it('osoba z dostępem do danych klientów: fraza tylko zaszyfrowana, filtry listy zostają, strona nie', () => {
    const a = adresPoSzukaniu('jan@example.test', '?widok=wszystkie&sf=NOWE&przewoznik=DPD&strona=3&sd=xx&q=stare', pieczec)
    const p = new URLSearchParams(a.split('?')[1])
    expect(p.get('qz')).toBe('TOKEN(16)')
    expect([...p.keys()].sort()).toEqual(['przewoznik', 'qz', 'sf', 'widok'])
    expect(a).not.toContain('example')
  })

  it('osoba bez dostępu: numery i produkty jawnie, e-mail nie trafia do adresu', () => {
    expect(adresPoSzukaniu('48083', 'widok=wszystkie', null)).toBe('/zamowienia?widok=wszystkie&q=48083')
    expect(adresPoSzukaniu('jan@example.test', '', null)).toBe('/zamowienia?kb=uprawnienia')
  })

  it('osoba bez dostępu: telefon w zapisie telefonicznym nie trafia do adresu, same cyfry tak', () => {
    expect(adresPoSzukaniu('+48 511 222 333', '', null)).toBe('/zamowienia?kb=uprawnienia')
    expect(adresPoSzukaniu('511-222-333', '', null)).toBe('/zamowienia?kb=uprawnienia')
    expect(adresPoSzukaniu('511222333', '', null)).toBe('/zamowienia?q=511222333')
    expect(adresPoSzukaniu('5901234123457', '', null)).toBe('/zamowienia?q=5901234123457')
    expect(adresPoSzukaniu('RP-100', '', null)).toBe('/zamowienia?q=RP-100')
  })

  it('brak klucza danych klientów: numer jawnie, telefon/e-mail wcale', () => {
    const bezKlucza = () => {
      throw new Error('brak klucza')
    }
    expect(adresPoSzukaniu('SKU-1', '', bezKlucza)).toBe('/zamowienia?q=SKU-1')
    expect(adresPoSzukaniu('500 600 700', '', bezKlucza)).toBe('/zamowienia?kb=klucz')
  })

  it('pusta fraza czyści wyszukiwanie', () => {
    expect(adresPoSzukaniu('  ', 'widok=nowe&qz=abc', pieczec)).toBe('/zamowienia?widok=nowe')
  })

  it('odczytania frazy: e-mail, telefon, NIP (10 cyfr także jako telefon bez kierunkowego)', () => {
    expect(odczytaniaFrazy('Jan@Example.test')).toEqual([{ rodzaj: 'email', wartosc: 'jan@example.test' }])
    expect(odczytaniaFrazy('+48 500 600 700')).toEqual([{ rodzaj: 'telefon', wartosc: '48500600700' }])
    expect(odczytaniaFrazy('PL 123-456-32-18').map((x) => x.rodzaj)).toEqual(['nip'])
    expect(odczytaniaFrazy('1234563218').map((x) => x.rodzaj).sort()).toEqual(['nip', 'telefon'])
    expect(odczytaniaFrazy('Kowalski')).toEqual([])
    expect(odczytaniaFrazy('48083')).toEqual([])
  })
})
