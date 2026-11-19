// (Etap 3a): ekran „Publikacja” — czysta logika kafla i powodów nieaktywnego „Wystaw” (bez bazy, bez sieci;
// atrapy kanałów w pamięci, dane fikcyjne).
import { describe, expect, it } from 'vitest'
import { atrapaAllegro, EAN_POZA_KATALOGIEM, EAN_W_KATALOGU, KAT_PRZYPRAWA } from './allegro-atrapa'
import { DOMYSLNE_USTAWIENIA_OFERT, przygotujPodgladAllegro, zrodloAllegroZApi, type UstawieniaOfertFirmy } from './allegro-podglad'
import { przygotujPodgladEmpik } from './empik-podglad'
import { atrapaWoo } from './kanaly-atrapa'
import { DROGA_KANALOW, kafelZPodgladu, type KontoPublikacji, powodyBlokadyWystawienia } from './publikacja'
import { kontoBezKonta, ZRODLO_ALLEGRO_BEZ_POLACZENIA, ZRODLO_EMPIK_BEZ_POLACZENIA, ZRODLO_WOO_BEZ_POLACZENIA } from './publikacja-serwer'
import type { ProduktDoOferty } from './typy'
import { przygotujPodgladWoo, zrodloWooZApi } from './woo-podglad'

const produkt = (p: Partial<ProduktDoOferty> = {}): ProduktDoOferty => ({
  id: 'prod-p1',
  nazwa: 'Kurkuma mielona z Japonii 100 g',
  sku: 'HZ-KURKUMA-100',
  ean: EAN_W_KATALOGU,
  opis: '<p>Łagodna kurkuma z wiosennego zbioru.</p>',
  wagaG: 110,
  cenaBrutto: 39.9,
  stan: 12,
  zdjecia: ['https://cdn.przyklad.test/kurkuma-1.jpg'],
  kategorieSklepu: ['przyprawa-zielona'],
  atrybuty: [{ nazwa: 'Kraj pochodzenia', wartosc: 'Japonia' }],
  ...p,
})

const ustawienia: UstawieniaOfertFirmy = {
  ...DOMYSLNE_USTAWIENIA_OFERT,
  mapaKategorii: { poSlowie: { 'przyprawa-zielona': KAT_PRZYPRAWA } },
  parametry: { ...DOMYSLNE_USTAWIENIA_OFERT.parametry, marka: 'Pracownia Testowa', stale: { '3458': 'liściasta' } },
}

const kontoAllegro = (k: Partial<KontoPublikacji> = {}): KontoPublikacji => ({
  kod: 'ALLEGRO-testowe',
  kanal: 'allegro',
  nazwa: 'Allegro testowe',
  aktywne: true,
  zZapisem: true,
  wystawianieWlaczone: true,
  zakresOfert: true,
  cennikDostawId: 'cennik-1',
  zwrotyId: 'zwroty-1',
  reklamacjeId: 'reklamacje-1',
  bezPolaczenia: false,
  ...k,
})

const podgladAllegro = (p: Partial<ProduktDoOferty> = {}) => przygotujPodgladAllegro({ produkt: produkt(p) }, zrodloAllegroZApi(atrapaAllegro().get), ustawienia)

describe('powody nieaktywnego „Wystaw”', () => {
  it('konto gotowe i produkt z katalogu Allegro → „Wystaw” aktywny', async () => {
    const pg = await podgladAllegro()
    expect(pg.gotowa).toBe(true)
    expect(powodyBlokadyWystawienia(kontoAllegro(), pg)).toEqual([])
    expect(kafelZPodgladu(kontoAllegro(), pg).wystaw).toEqual({ mozna: true, powody: [] })
  })

  it('wyłączone wystawianie ofert: powód z pełną drogą do przełącznika', async () => {
    const powody = powodyBlokadyWystawienia(kontoAllegro({ wystawianieWlaczone: false }), await podgladAllegro())
    expect(powody).toHaveLength(1)
    expect(powody[0]).toContain(`${DROGA_KANALOW} → „Allegro testowe” → „Zapis do sklepu” → „Włącz wystawianie ofert”`)
  })

  it('każda przeszkoda konta osobnym powodem: tylko odczyt, konto wyłączone, brak zgody na oferty, brak cennika', async () => {
    const pg = await podgladAllegro()
    const tylkoOdczyt = powodyBlokadyWystawienia(kontoAllegro({ zZapisem: false, wystawianieWlaczone: false }), pg)
    expect(tylkoOdczyt).toHaveLength(1)
    expect(tylkoOdczyt[0]).toContain('tylko czyta z kanału')
    expect(powodyBlokadyWystawienia(kontoAllegro({ aktywne: false }), pg)).toEqual([expect.stringContaining('jest wyłączone')])
    for (const zakresOfert of [false, null]) expect(powodyBlokadyWystawienia(kontoAllegro({ zakresOfert }), pg)).toEqual([expect.stringContaining('nie ma zgody na zakładanie ofert')])
    expect(powodyBlokadyWystawienia(kontoAllegro({ cennikDostawId: null }), pg)).toEqual([expect.stringContaining('cennika dostaw')])
    const wszystko = powodyBlokadyWystawienia(kontoAllegro({ aktywne: false, zakresOfert: false, cennikDostawId: null }), pg)
    expect(wszystko).toHaveLength(3)
  })

  it('brak EAN i zdjęcie bez publicznego adresu blokują Allegro', async () => {
    const bezEan = powodyBlokadyWystawienia(kontoAllegro(), await podgladAllegro({ ean: null }))
    expect(bezEan).toEqual(expect.arrayContaining([expect.stringContaining('kodu EAN')]))
    const zdjecie = powodyBlokadyWystawienia(kontoAllegro(), await podgladAllegro({ zdjecia: ['https://cdn.przyklad.test/a.jpg', '/api/produkty/zdjecia/z2'] }))
    expect(zdjecie).toEqual(expect.arrayContaining([expect.stringContaining('publicznego adresu (https)')]))
  })

  it('Woo: sklep ma już produkt z tym SKU → powód „powiąż”, nie zakładamy drugiego', async () => {
    const konto: KontoPublikacji = { ...kontoAllegro({ kanal: 'woo', kod: 'WOO-sklep', nazwa: 'Sklep', zakresOfert: null, cennikDostawId: null }) }
    const pg = await przygotujPodgladWoo({ produkt: produkt({ sku: 'KUB-1' }) }, zrodloWooZApi(atrapaWoo({ skuWSklepie: { 'KUB-1': 501 } }).get))
    expect(pg.tryb).toBe('istnieje')
    const k = kafelZPodgladu(konto, pg)
    expect(k.wystaw.mozna).toBe(false)
    expect(k.wystaw.powody).toEqual([expect.stringContaining('powiąż go z produktem')])
    expect(k.rodzaj).toContain('nr 501')
  })
})

describe('firma bez kont kanałów (np. demonstracyjna)', () => {
  it('trzy kafle „bez konta” z podglądem z danych produktu, serializowalne, z powodem „Dodaj konto”', async () => {
    const p = produkt({ ean: EAN_POZA_KATALOGIEM })
    const kafle = [
      kafelZPodgladu(kontoBezKonta('woo'), await przygotujPodgladWoo({ produkt: p }, ZRODLO_WOO_BEZ_POLACZENIA)),
      kafelZPodgladu(kontoBezKonta('allegro'), await przygotujPodgladAllegro({ produkt: p }, ZRODLO_ALLEGRO_BEZ_POLACZENIA, ustawienia)),
      kafelZPodgladu(kontoBezKonta('empik'), await przygotujPodgladEmpik({ produkt: p }, ZRODLO_EMPIK_BEZ_POLACZENIA)),
    ]
    expect(kafle.map((k) => k.klucz)).toEqual(['brak:woo', 'brak:allegro', 'brak:empik'])
    for (const k of kafle) {
      expect(k.kod).toBeNull()
      expect(k.nazwaKonta).toBeNull()
      expect(k.bezPolaczenia).toBe(true)
      expect(k.tytul).toBeTruthy()
      expect(k.wystaw.mozna).toBe(false)
      expect(k.wystaw.powody[0]).toContain('„Dodaj konto”')
      expect(JSON.parse(JSON.stringify(k))).toEqual(k)
    }
  })
})

describe('kafel Allegro', () => {
  it('opis oczyszczony: bez <script> i bez linków', async () => {
    const pg = await podgladAllegro({ opis: '<p>Kurkuma <a href="https://obcy.test">tutaj</a>.</p><script>alert(1)</script>' })
    const html = kafelZPodgladu(kontoAllegro(), pg)
      .opis.filter((f) => f.typ === 'tekst')
      .map((f) => (f.typ === 'tekst' ? f.html : ''))
      .join('')
    expect(html).toContain('Kurkuma')
    expect(html).not.toMatch(/<script|href=/i)
  })

  it('cena po polsku, zdjęcia z flagą publicznego adresu', async () => {
    const k = kafelZPodgladu(kontoAllegro(), await podgladAllegro({ zdjecia: ['https://cdn.przyklad.test/a.jpg', '/api/produkty/zdjecia/z2'] }))
    expect(k.cena).toBe('39,90 zł')
    expect(k.zdjecia.map((z) => z.publiczny)).toEqual(expect.arrayContaining([true]))
  })
})
