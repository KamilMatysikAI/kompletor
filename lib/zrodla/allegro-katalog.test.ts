// odczyty kategorii, parametrów i katalogu Allegro (tylko GET, nagrane/fikcyjne odpowiedzi, bez sieci).
import { describe, expect, it } from 'vitest'
import { atrapaAllegro, EAN_W_KATALOGU, KAT_PRZYPRAWA, PARAMETRY_PRZYPRAWY } from '@/lib/oferty/allegro-atrapa'
import {
  AllegroOdczytError,
  allegroDopasujKategorie,
  allegroKategoria,
  allegroParametryKategorii,
  allegroParametryZApi,
  allegroProduktKataloguZApi,
  allegroProduktyPoEan,
  allegroSciezkaKategorii,
} from './allegro'

describe('Allegro: kategorie i katalog (odczyt)', () => {
  it('kategoria i ścieżka od korzenia; 404 = null', async () => {
    const { get } = atrapaAllegro()
    expect(await allegroKategoria(get, KAT_PRZYPRAWA)).toEqual({ id: KAT_PRZYPRAWA, nazwa: 'Liściaste', lisc: true, rodzicId: '900100' })
    expect(await allegroSciezkaKategorii(get, KAT_PRZYPRAWA)).toEqual(['Supermarket', 'Przyprawa', 'Liściaste'])
    expect(await allegroKategoria(get, '123')).toBeNull()
  })

  it('złe id nie trafia do ścieżki URL', async () => {
    const { get, wywolania } = atrapaAllegro()
    await expect(allegroKategoria(get, '../sale/offers')).rejects.toThrow('złe id')
    expect(wywolania).toEqual([])
  })

  it('propozycje kategorii z nazwą kategorii nadrzędnej', async () => {
    const { get, wywolania } = atrapaAllegro()
    const k = await allegroDopasujKategorie(get, 'Kurkuma mielona')
    expect(k.map((x) => [x.id, x.lisc, x.rodzicNazwa])).toEqual([
      ['900100', false, 'Supermarket'],
      [KAT_PRZYPRAWA, true, 'Przyprawa'],
    ])
    expect(wywolania).toEqual(['/sale/matching-categories?name=Kurkuma+mielona'])
  })

  it('parametry kategorii: wymagalność, poziom produkt/oferta, słownik, „inna wartość”', async () => {
    const { get } = atrapaAllegro()
    const p = await allegroParametryKategorii(get, KAT_PRZYPRAWA)
    expect(p).toHaveLength(7)
    expect(p.find((x) => x.id === '248811')).toMatchObject({ nazwa: 'Marka', wymaganyDlaProduktu: true, opisujeProdukt: true, dowolnaWartosc: true })
    expect(p.find((x) => x.id === '3458')).toMatchObject({ dowolnaWartosc: false, slownik: [{ id: '3458_1', wartosc: 'liściasta' }, { id: '3458_2', wartosc: 'ekspresowa' }, { id: '3458_3', wartosc: 'granulowana' }] })
    expect(p.find((x) => x.id === '11323')).toMatchObject({ wymagany: true, opisujeProdukt: false })
    expect(p.find((x) => x.id === '221929')).toMatchObject({ jednostka: 'kg', typ: 'float' })
    expect(allegroParametryZApi({ parameters: [{ name: 'bez id' }, null, 'x'] })).toEqual([])
    expect(allegroParametryZApi(PARAMETRY_PRZYPRAWY)).toEqual(p)
  })

  it('katalog po EAN: produkty z EAN-ami z parametrów; zły EAN odrzucony przed zapytaniem', async () => {
    const { get, wywolania } = atrapaAllegro()
    const pr = await allegroProduktyPoEan(get, EAN_W_KATALOGU)
    expect(pr).toEqual([
      {
        id: 'b1c2d3e4-0000-4000-8000-000000000001',
        nazwa: 'Kurkuma mielona Testowa 100 g',
        kategoriaId: KAT_PRZYPRAWA,
        eany: [EAN_W_KATALOGU],
        zdjecia: ['https://a.allegroimg.com/original/test/katalog-1.jpg'],
      },
    ])
    await expect(allegroProduktyPoEan(get, '12ab')).rejects.toThrow('EAN')
    expect(wywolania).toHaveLength(1)
    expect(allegroProduktKataloguZApi({ name: 'bez id' })).toBeNull()
  })

  it('status inny niż 2xx i 404 → AllegroOdczytError ze statusem', async () => {
    const { get } = atrapaAllegro({ '/sale/products': { status: 403, body: null } })
    const e = await allegroProduktyPoEan(get, EAN_W_KATALOGU).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AllegroOdczytError)
    expect((e as AllegroOdczytError).httpStatus).toBe(403)
  })
})
