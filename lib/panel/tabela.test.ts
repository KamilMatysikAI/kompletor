import { describe, expect, it } from 'vitest'
import { adresSortu, adresZ, sortZ, stronaZ, zakresStrony } from './tabela'

describe('stan tabeli w adresie', () => {
  const dom = { klucz: 'data', kierunek: 'malejaco' } as const

  it('sort tylko po dozwolonych kolumnach, śmieci = domyślny', () => {
    expect(sortZ({ sort: 'kwota', kier: 'rosnaco' }, ['data', 'kwota'], dom)).toEqual({ klucz: 'kwota', kierunek: 'rosnaco' })
    expect(sortZ({ sort: 'haslo' }, ['data', 'kwota'], dom)).toEqual(dom)
    expect(sortZ({ sort: 'kwota', kier: 'w bok' }, ['kwota'], dom)).toEqual({ klucz: 'kwota', kierunek: 'rosnaco' })
  })

  it('strona i rozmiar: tylko 25/50/100/250, strona od 1', () => {
    expect(stronaZ({ strona: '3', ile: '25' })).toEqual({ strona: 3, ile: 25, pomin: 50 })
    expect(stronaZ({ strona: '-1', ile: '9999' })).toEqual({ strona: 1, ile: 50, pomin: 0 })
    expect(stronaZ({ strona: 'abc' }, 100)).toEqual({ strona: 1, ile: 100, pomin: 0 })
  })

  it('adres zachowuje filtry, usuwa puste, stała kolejność', () => {
    expect(adresZ('/zamowienia', { q: 'abc', status: '' }, { strona: 2 })).toBe('/zamowienia?q=abc&strona=2')
    expect(adresZ('/zamowienia', { q: 'a b' }, { q: undefined })).toBe('/zamowienia')
    expect(adresZ('/x', { z: '1', a: '2' }, {})).toBe('/x?a=2&z=1')
  })

  it('klik w nagłówek: ta sama kolumna odwraca kierunek, strona wraca na 1', () => {
    expect(adresSortu('/p', { strona: '4' }, { klucz: 'kwota', kierunek: 'rosnaco' }, 'kwota')).toBe('/p?kier=malejaco&sort=kwota')
    expect(adresSortu('/p', {}, { klucz: 'kwota', kierunek: 'malejaco' }, 'kwota')).toBe('/p?kier=rosnaco&sort=kwota')
    expect(adresSortu('/p', {}, undefined, 'data')).toBe('/p?kier=rosnaco&sort=data')
  })

  it('zakres strony', () => {
    expect(zakresStrony(2, 20, 133)).toEqual({ od: 21, do: 40, stron: 7 })
    expect(zakresStrony(1, 50, 0)).toEqual({ od: 0, do: 0, stron: 1 })
  })
})
