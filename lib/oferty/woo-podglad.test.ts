// podgląd produktu w sklepie Woo z danych produktu Kompletora (atrapa WC REST, dane fikcyjne).
import { describe, expect, it } from 'vitest'
import { wooKategorie, wooProduktPoSku } from '@/lib/zrodla/woo'
import { atrapaWoo, KATEGORIE_SKLEPU } from './kanaly-atrapa'
import type { ProduktDoOferty } from './typy'
import { DOMYSLNE_USTAWIENIA_KANALOW } from './ustawienia'
import { dopasujKategorieWoo, przygotujPodgladWoo, zrodloWooZApi } from './woo-podglad'

const produkt = (p: Partial<ProduktDoOferty> = {}): ProduktDoOferty => ({
  id: 'prod-w1',
  nazwa: 'Kubek ceramiczny Poranek 300 ml',
  sku: 'KUB-PORANEK',
  ean: '5901234560325',
  opis: '<p>Kubek z grubej ceramiki.</p><script>alert(1)</script>',
  wagaG: 320,
  cenaBrutto: 49.9,
  stan: 4,
  zdjecia: ['https://cdn.przyklad.test/kubek-1.jpg', '/api/produkty/zdjecia/z2'],
  kategorieSklepu: ['Kubki i filizanki', 'nieznana'],
  atrybuty: [],
  ...p,
})

describe('Woo: odczyty do ofertowania', () => {
  it('kategorie ze wszystkich stron, produkt po dokładnym SKU', async () => {
    const a = atrapaWoo({ skuWSklepie: { 'KUB-1': 501 } })
    expect((await wooKategorie(a.get)).map((k) => k.id)).toEqual(KATEGORIE_SKLEPU.map((k) => k.id))
    expect(await wooProduktPoSku(a.get, 'KUB-1')).toEqual({ id: 501, status: 'publish', liczba: 1 })
    expect(await wooProduktPoSku(a.get, 'KUB-2')).toBeNull()
    expect(a.wywolania.filter((w) => w.startsWith('/products/categories'))).toHaveLength(2)
  })

  it('dopasowanie kategorii po slugu i po nazwie bez ogonków', () => {
    const sklep = KATEGORIE_SKLEPU.map((k) => ({ id: k.id, nazwa: k.name, slug: k.slug, rodzicId: k.parent || null }))
    expect(dopasujKategorieWoo(['przyprawa-czarna', 'Kubki i filizanki', 'brak'], sklep)).toEqual({
      kategorie: [sklep[0], sklep[1]],
      bezOdpowiednika: ['brak'],
    })
  })
})

describe('podgląd produktu w sklepie Woo', () => {
  it('nowy produkt: szkic WC REST, EAN w global_unique_id, szkic (draft), zdjęcia tylko publiczne', async () => {
    const pg = await przygotujPodgladWoo({ produkt: produkt() }, zrodloWooZApi(atrapaWoo().get))
    expect(pg.tryb).toBe('nowy')
    expect(pg.gotowa).toBe(true)
    expect(pg.problemy.map((x) => x.kod)).toEqual(expect.arrayContaining(['kategoria_sklepu_brak', 'zdjecie_bez_adresu']))
    expect(pg.szkicProduktu).toEqual({
      name: 'Kubek ceramiczny Poranek 300 ml',
      type: 'simple',
      status: 'draft',
      sku: 'KUB-PORANEK',
      regular_price: '49.90',
      description: '<p>Kubek z grubej ceramiki.</p>',
      short_description: '',
      manage_stock: true,
      stock_quantity: 4,
      weight: '0.320',
      categories: [{ id: 16 }],
      images: [{ src: 'https://cdn.przyklad.test/kubek-1.jpg' }],
      global_unique_id: '5901234560325',
    })
  })

  it('EAN w polu meta, gdy firma tak ustawiła; ręczne kategorie sprawdzone ze sklepem', async () => {
    const u = { ...DOMYSLNE_USTAWIENIA_KANALOW, woo: { status: 'publish' as const, poleEan: '_ean' } }
    const pg = await przygotujPodgladWoo({ produkt: produkt(), kategorieIds: [15, 77] }, zrodloWooZApi(atrapaWoo().get), u)
    expect(pg.szkicProduktu['meta_data']).toEqual([{ key: '_ean', value: '5901234560325' }])
    expect(pg.szkicProduktu['status']).toBe('publish')
    expect(pg.kategorie).toEqual([{ id: 15, nazwa: 'Przyprawa czarna' }, { id: 77, nazwa: 'kategoria nr 77' }])
    expect(pg.problemy.find((x) => x.kod === 'kategoria_nie_istnieje')?.waga).toBe('blad')
  })

  it('SKU już w sklepie → tryb „istnieje” i błąd (bez dubla); awaria sklepu → ostrzeżenia, podgląd powstaje', async () => {
    const jest = await przygotujPodgladWoo({ produkt: produkt() }, zrodloWooZApi(atrapaWoo({ skuWSklepie: { 'KUB-PORANEK': 4321 } }).get))
    expect(jest.tryb).toBe('istnieje')
    expect(jest.istniejacyId).toBe(4321)
    expect(jest.gotowa).toBe(false)
    const awaria = await przygotujPodgladWoo({ produkt: produkt({ cenaBrutto: null }) }, zrodloWooZApi(atrapaWoo({ blad: true }).get))
    expect(awaria.problemy.filter((x) => x.kod === 'sklep_niedostepny')).toHaveLength(2)
    expect(awaria.problemy.find((x) => x.kod === 'bez_ceny')?.waga).toBe('blad')
  })
})
