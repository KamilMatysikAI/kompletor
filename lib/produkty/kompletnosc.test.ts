// ocena kompletności karty produktu (kafle nad listą produktów), czysta część bez bazy.
import { describe, expect, it } from 'vitest'
import { brakiProduktu, isBrakProduktu, policzKompletnosc, type ProduktDoOceny } from './kompletnosc'

const pelny: ProduktDoOceny = { id: 'p1', sku: 'HERB-1', ean: '5900000000001', title: 'Przyprawa', kind: 'STOCKED', weightG: 100, lengthCm: 10, widthCm: 8, heightCm: 4, packingZone: 'A', oferty: 1 }
const reguly = [{ priority: 1, pattern: '^KAWA', zone: 'K' }]
const zeStrefami = { maStrefy: true, reguly }

describe('kompletność produktu', () => {
  it('pełna karta nie ma braków; każde puste pole daje swój brak', () => {
    expect(brakiProduktu(pelny, zeStrefami)).toEqual([])
    expect(brakiProduktu({ ...pelny, ean: null }, zeStrefami)).toEqual(['bez_ean'])
    expect(brakiProduktu({ ...pelny, ean: '  ' }, zeStrefami)).toEqual(['bez_ean'])
    expect(brakiProduktu({ ...pelny, sku: '' }, zeStrefami)).toEqual(['bez_ean'])
    expect(brakiProduktu({ ...pelny, heightCm: null }, zeStrefami)).toEqual(['bez_wagi'])
    expect(brakiProduktu({ ...pelny, weightG: null }, zeStrefami)).toEqual(['bez_wagi'])
    expect(brakiProduktu({ ...pelny, oferty: 0 }, zeStrefami)).toEqual(['bez_oferty'])
    expect(brakiProduktu({ ...pelny, packingZone: null }, zeStrefami)).toEqual(['bez_strefy'])
  })

  it('strefa z reguły firmy liczy się jak ręczna; bez stref w firmie brak strefy nie jest brakiem', () => {
    expect(brakiProduktu({ ...pelny, packingZone: null, sku: 'KAWA-1' }, zeStrefami)).toEqual([])
    expect(brakiProduktu({ ...pelny, packingZone: null }, { maStrefy: false, reguly: [] })).toEqual([])
  })

  it('zestaw: bez strefy (zbiera się ze składników), ale waga i oferta tak; produkt bez stanu poza oceną', () => {
    expect(brakiProduktu({ ...pelny, kind: 'BUNDLE', packingZone: null, weightG: null }, zeStrefami)).toEqual(['bez_wagi'])
    expect(brakiProduktu({ ...pelny, kind: 'DIGITAL', ean: null, oferty: 0, weightG: null }, zeStrefami)).toEqual([])
  })

  it('liczniki: razem = towar i zestawy, kompletne bez żadnego braku, bez stanu osobno, id w zbiorach braków', () => {
    const k = policzKompletnosc(
      [pelny, { ...pelny, id: 'p2', ean: null, oferty: 0 }, { ...pelny, id: 'p3', weightG: null }, { ...pelny, id: 'e1', kind: 'DIGITAL', ean: null }],
      zeStrefami,
    )
    expect(k).toEqual({ razem: 3, kompletne: 1, bezStanu: 1, maStrefy: true, braki: { bez_ean: ['p2'], bez_wagi: ['p3'], bez_oferty: ['p2'], bez_strefy: [] } })
  })

  it('filtr z adresu tylko ze znanych braków', () => {
    expect(isBrakProduktu('bez_ean')).toBe(true)
    expect(isBrakProduktu('brak')).toBe(false)
    expect(isBrakProduktu(undefined)).toBe(false)
  })
})
