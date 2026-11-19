// parametry oferty Allegro (port parameter_mapper.py).
import { describe, expect, it } from 'vitest'
import { allegroParametryZApi } from '@/lib/zrodla/allegro'
import { EAN_POZA_KATALOGIEM, KAT_PRZYPRAWA, KAT_KUBKI, PARAMETRY_PRZYPRAWY, PARAMETRY_KUBKOW } from './allegro-atrapa'
import { DOMYSLNE_ZASADY_PARAMETROW, idZeSlownika, wagaKg, zbudujParametry, type ZasadyParametrowFirmy } from './parametry'
import type { ProduktDoOferty } from './typy'

const produkt = (p: Partial<ProduktDoOferty> = {}): ProduktDoOferty => ({
  id: 'p1',
  nazwa: 'Kurkuma mielona z Japonii 100 g',
  sku: 'HZ-KURKUMA-100',
  ean: EAN_POZA_KATALOGIEM,
  opis: '<p>Łagodna przyprawa zielona.</p>',
  wagaG: 110,
  cenaBrutto: 39.9,
  stan: 12,
  zdjecia: ['https://cdn.przyklad.test/kurkuma-1.jpg'],
  kategorieSklepu: ['przyprawa-zielona'],
  atrybuty: [{ nazwa: 'Kraj pochodzenia', wartosc: 'Japonia' }],
  ...p,
})

const zasady: ZasadyParametrowFirmy = { ...DOMYSLNE_ZASADY_PARAMETROW, marka: 'Pracownia Testowa', stale: { '3458': 'liściasta' } }
const przyprawa = allegroParametryZApi(PARAMETRY_PRZYPRAWY)
const kubki = allegroParametryZApi(PARAMETRY_KUBKOW)

describe('parametry Allegro z produktu', () => {
  it('wypełnia EAN, markę, wagę, stan, stałą firmy i cechę; dzieli na parametry produktu i oferty', () => {
    const w = zbudujParametry(KAT_PRZYPRAWA, przyprawa, produkt(), zasady)
    expect(w.parametryProduktu).toEqual([
      { id: '225693', values: [EAN_POZA_KATALOGIEM] },
      { id: '248811', valuesIds: ['248811_1'] },
      { id: '221929', values: ['0.110'] },
      { id: '3458', valuesIds: ['3458_1'] },
      { id: '128430', valuesIds: ['128430_3'] },
    ])
    expect(w.parametryOferty).toEqual([{ id: '11323', valuesIds: ['11323_1'] }])
    expect(w.problemy).toEqual([])
    expect(w.wiersze.find((r) => r.id === '128430')).toMatchObject({ wartosc: 'Japonia', zrodlo: 'cecha', brak: false })
    expect(w.wiersze.find((r) => r.id === '17448')).toMatchObject({ wartosc: null, brak: false }) // nieobowiązkowy
  })

  it('braki wymaganych parametrów: na liście problemów i w wierszach z przykładami ze słownika', () => {
    const w = zbudujParametry(KAT_PRZYPRAWA, przyprawa, produkt({ atrybuty: [] }), DOMYSLNE_ZASADY_PARAMETROW)
    const braki = w.wiersze.filter((r) => r.brak)
    expect(braki.map((b) => b.nazwa)).toEqual(['Marka', 'Forma', 'Kraj pochodzenia'])
    expect(braki[2]!.przyklady).toEqual(['Chiny', 'Indie', 'Japonia'])
    expect(w.problemy).toContainEqual(expect.objectContaining({ kod: 'brak_parametrow', waga: 'blad', komunikat: 'Brakuje wymaganych parametrów: Marka, Forma, Kraj pochodzenia.' }))
  })

  it('marka z cechy produktu, gdy firma nie ustawiła stałej', () => {
    const w = zbudujParametry(KAT_PRZYPRAWA, przyprawa, produkt({ atrybuty: [{ nazwa: 'Producent', wartosc: 'Inna Marka' }] }))
    expect(w.parametryProduktu).toContainEqual({ id: '248811', valuesIds: ['248811_2'] })
  })

  it('marka spoza słownika bez „innej wartości” = błąd', () => {
    const bez = przyprawa.map((p) => (p.id === '248811' ? { ...p, dowolnaWartosc: false } : p))
    const w = zbudujParametry(KAT_PRZYPRAWA, bez, produkt(), { ...zasady, marka: 'Nieznana Marka' })
    expect(w.problemy).toContainEqual(expect.objectContaining({ kod: 'marka_spoza_slownika', waga: 'blad' }))
  })

  it('wartość ręczna wygrywa ze wszystkim', () => {
    const w = zbudujParametry(KAT_PRZYPRAWA, przyprawa, produkt(), zasady, { '128430': 'Chiny', '17448': 'jaśmin' })
    expect(w.parametryProduktu).toContainEqual({ id: '128430', valuesIds: ['128430_1'] })
    expect(w.parametryProduktu).toContainEqual({ id: '17448', values: ['jaśmin'] })
  })

  it('domyślne per kategoria z danych firmy: z cechy, stałe i z pola SKU (jak CATEGORY_PARAM_DEFAULTS dla kubków)', () => {
    const z: ZasadyParametrowFirmy = {
      ...zasady,
      domyslnePerKategoria: { [KAT_KUBKI]: { '220677': { zCechy: 'Pojemność' }, '23389': 'ceramika', '224017': { zPola: 'sku' } } },
    }
    const w = zbudujParametry(KAT_KUBKI, kubki, produkt({ nazwa: 'Kubek Żuraw', sku: 'KUB-ZUR-300', atrybuty: [{ nazwa: 'Pojemność', wartosc: '300' }] }), z)
    expect(w.parametryProduktu).toEqual([
      { id: '225693', values: [EAN_POZA_KATALOGIEM] },
      { id: '220677', values: ['300'] },
      { id: '23389', valuesIds: ['23389_1'] },
      { id: '224017', values: ['KUB-ZUR-300'] },
    ])
    expect(w.wiersze.filter((r) => r.zrodlo === 'kategoria')).toHaveLength(3)
  })

  it('waga zgadnięta z nazwy daje ostrzeżenie', () => {
    const w = zbudujParametry(KAT_PRZYPRAWA, przyprawa, produkt({ wagaG: null }), zasady)
    expect(w.parametryProduktu).toContainEqual({ id: '221929', values: ['0.100'] })
    expect(w.problemy).toContainEqual(expect.objectContaining({ kod: 'waga_zgadnieta', waga: 'ostrzezenie' }))
  })
})

describe('pomocnicze', () => {
  it('słownik: najpierw dokładnie, potem zawieranie, bez ogonków', () => {
    const s = [{ id: '1', wartosc: 'liściasta' }, { id: '2', wartosc: 'liściasta z dodatkami' }]
    expect(idZeSlownika('LIŚCIASTA', s)?.id).toBe('1')
    expect(idZeSlownika('z dodatkami', s)?.id).toBe('2')
    expect(idZeSlownika('ekspresowa', s)).toBeNull()
  })
  it('waga: karta, potem gramatura w nazwie, potem słowo i kategoria sklepu z danych firmy', () => {
    const z = { ...DOMYSLNE_ZASADY_PARAMETROW, wagiPoSlowie: { lampa: '0.020' }, wagiPoKategoriiSklepu: { 'przyprawy-*': '0.050', akcesoria: '0.500' } }
    expect(wagaKg(produkt({ wagaG: 1250 }), z)).toEqual({ kg: '1.250', zgadnieta: false })
    expect(wagaKg(produkt({ wagaG: null, nazwa: 'Papryka 30 g' }), z)).toEqual({ kg: '0.030', zgadnieta: true })
    expect(wagaKg(produkt({ wagaG: null, nazwa: 'Lampa przyprawowa serce' }), z)).toEqual({ kg: '0.020', zgadnieta: true })
    expect(wagaKg(produkt({ wagaG: null, nazwa: 'Kurkuma', kategorieSklepu: ['przyprawy-zielone'] }), z)).toEqual({ kg: '0.050', zgadnieta: true })
    expect(wagaKg(produkt({ wagaG: null, nazwa: 'Czajnik', kategorieSklepu: ['akcesoria'] }), z)).toEqual({ kg: '0.500', zgadnieta: true })
    expect(wagaKg(produkt({ wagaG: null, nazwa: 'Czajnik', kategorieSklepu: [] }), z)).toBeNull()
  })
})
