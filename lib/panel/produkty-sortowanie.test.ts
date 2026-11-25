// parametry sortowania listy produktów z adresu (biała lista kluczy i kierunku, domyślna kolejność).
import { describe, expect, it } from 'vitest'
import { PRODUCT_SORT_DEFAULT, PRODUCT_SORT_KEYS, productSortZ } from './dane'

describe('productSortZ', () => {
  it('brak parametrów = nazwa rosnąco (kolejność sprzed zmiany)', () => {
    expect(productSortZ({})).toEqual({ klucz: 'produkt', kierunek: 'rosnaco' })
    expect(PRODUCT_SORT_DEFAULT).toEqual({ klucz: 'produkt', kierunek: 'rosnaco' })
  })

  it('każdy klucz z białej listy w obu kierunkach', () => {
    for (const k of PRODUCT_SORT_KEYS) {
      expect(productSortZ({ sort: k, kier: 'rosnaco' })).toEqual({ klucz: k, kierunek: 'rosnaco' })
      expect(productSortZ({ sort: k, kier: 'malejaco' })).toEqual({ klucz: k, kierunek: 'malejaco' })
    }
    expect(PRODUCT_SORT_KEYS).toEqual(['produkt', 'kategoria', 'lokalizacja', 'fizycznie', 'zarezerwowane', 'dostepne', 'oferty'])
  })

  it('nieznany kierunek = rosnąco; nieznany klucz albo próba SQL = kolejność domyślna', () => {
    expect(productSortZ({ sort: 'dostepne', kier: 'DESC' })).toEqual({ klucz: 'dostepne', kierunek: 'rosnaco' })
    expect(productSortZ({ sort: 'dostepne' })).toEqual({ klucz: 'dostepne', kierunek: 'rosnaco' })
    expect(productSortZ({ sort: 'cena', kier: 'malejaco' })).toEqual(PRODUCT_SORT_DEFAULT)
    expect(productSortZ({ sort: 'title; DROP TABLE "Product"', kier: 'malejaco' })).toEqual(PRODUCT_SORT_DEFAULT)
    expect(productSortZ({ sort: 'Dostepne', kier: 'malejaco' })).toEqual(PRODUCT_SORT_DEFAULT)
  })

  it('parametr powtórzony w adresie: liczy się pierwszy', () => {
    expect(productSortZ({ sort: ['fizycznie', 'oferty'], kier: ['malejaco', 'rosnaco'] })).toEqual({ klucz: 'fizycznie', kierunek: 'malejaco' })
  })
})
