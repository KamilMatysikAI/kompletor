// Product + ProductImage z bazy → ProduktDoOferty (czysta funkcja, bez bazy).
import { describe, expect, it } from 'vitest'
import { produktDoOferty, type ProduktZBazy } from './produkt-z-bazy'

const produkt = (p: Partial<ProduktZBazy> = {}): ProduktZBazy => ({
  id: 'p1',
  sku: ' KUB-300 ',
  title: ' Kubek ceramiczny 300 ml ',
  ean: '590 1234 560035',
  description: '<p>Kubek z grubej ceramiki.</p>',
  weightG: 320,
  priceGross: { toString: () => '49.90' },
  details: null,
  ...p,
})

describe('produkt z bazy → wejście oferty', () => {
  it('składa pola, zdjęcia po pozycji, cenę z Decimal', () => {
    const w = produktDoOferty(
      produkt(),
      [
        { id: 'z2', position: 2, sourceUrl: null },
        { id: 'z1', position: 1, sourceUrl: 'https://cdn.przyklad.test/kubek.jpg' },
        { id: 'z3', position: 3, sourceUrl: 'http://stary.przyklad.test/x.jpg' },
      ],
      { stan: 7.9 },
    )
    expect(w).toEqual({
      id: 'p1',
      nazwa: 'Kubek ceramiczny 300 ml',
      sku: 'KUB-300',
      ean: '5901234560035',
      opis: '<p>Kubek z grubej ceramiki.</p>',
      wagaG: 320,
      cenaBrutto: 49.9,
      stan: 7,
      zdjecia: ['https://cdn.przyklad.test/kubek.jpg', '/api/produkty/zdjecia/z2', '/api/produkty/zdjecia/z3'],
      kategorieSklepu: [],
      atrybuty: [],
    })
  })

  it('publiczny adres z opcji wygrywa; kategorie i cechy z details; braki → null', () => {
    const w = produktDoOferty(
      produkt({ ean: '', description: '  ', weightG: 0, priceGross: null, details: { kategorieSklepu: ['kubki', 3, ' '], cechy: [{ nazwa: 'Pojemność', wartosc: '300 ml' }, { nazwa: 'x' }] } }),
      [{ id: 'z1', position: 0, sourceUrl: null }],
      { stan: -2, adresZdjecia: (z) => `https://pliki.przyklad.test/${z.id}.webp` },
    )
    expect(w.ean).toBeNull()
    expect(w.opis).toBeNull()
    expect(w.wagaG).toBeNull()
    expect(w.cenaBrutto).toBeNull()
    expect(w.stan).toBe(0)
    expect(w.zdjecia).toEqual(['https://pliki.przyklad.test/z1.webp'])
    expect(w.kategorieSklepu).toEqual(['kubki'])
    expect(w.atrybuty).toEqual([{ nazwa: 'Pojemność', wartosc: '300 ml' }])
  })
})
