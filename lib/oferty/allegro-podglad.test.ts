// podgląd oferty Allegro (port przepływu create_offer_v2.py) na nagranych/fikcyjnych odpowiedziach Allegro.
// Kryterium akceptacji: produkt z EAN z katalogu → podgląd z katalogu; produkt spoza katalogu → pełny produkt z kategorią
// i parametrami; walidator odrzuca tytuł z `!` i opis z linkiem; braki parametrów na liście problemów.
import { describe, expect, it } from 'vitest'
import { atrapaAllegro, EAN_POZA_KATALOGIEM, EAN_W_KATALOGU, KAT_PRZYPRAWA } from './allegro-atrapa'
import { DOMYSLNE_USTAWIENIA_OFERT, POWOD_NIESPRAWDZONEJ_KATEGORII, przygotujPodgladAllegro, wybierzZKatalogu, zrodloAllegroZApi, type UstawieniaOfertFirmy } from './allegro-podglad'
import { atrapaZapisu } from './kanaly-atrapa'
import { wystawOferteAllegro } from './wystawianie'
import type { ProduktDoOferty } from './typy'

const produkt = (p: Partial<ProduktDoOferty> = {}): ProduktDoOferty => ({
  id: 'prod-1',
  nazwa: 'Kurkuma mielona z Japonii 100 g',
  sku: 'HZ-KURKUMA-100',
  ean: EAN_POZA_KATALOGIEM,
  opis: '<p>Łagodna kurkuma z wiosennego zbioru o świeżym, trawiastym smaku.</p>',
  wagaG: 110,
  cenaBrutto: 39.9,
  stan: 12,
  zdjecia: ['https://cdn.przyklad.test/kurkuma-1.jpg', 'https://cdn.przyklad.test/kurkuma-2.jpg', 'https://cdn.przyklad.test/kurkuma-1.jpg'],
  kategorieSklepu: ['przyprawa-zielona'],
  atrybuty: [{ nazwa: 'Kraj pochodzenia', wartosc: 'Japonia' }],
  ...p,
})

const ustawienia: UstawieniaOfertFirmy = {
  ...DOMYSLNE_USTAWIENIA_OFERT,
  mapaKategorii: { poSlowie: { 'przyprawa-zielona': KAT_PRZYPRAWA } },
  parametry: { ...DOMYSLNE_USTAWIENIA_OFERT.parametry, marka: 'Pracownia Testowa', stale: { '3458': 'liściasta' } },
}

const kody = (p: { kod: string; waga: string }[]) => p.filter((x) => x.waga === 'blad').map((x) => x.kod)

describe('podgląd oferty Allegro', () => {
  it('produkt z EAN w katalogu Allegro → oferta do produktu katalogowego', async () => {
    const a = atrapaAllegro()
    const pg = await przygotujPodgladAllegro({ produkt: produkt({ ean: EAN_W_KATALOGU }) }, zrodloAllegroZApi(a.get), ustawienia)
    expect(pg.tryb).toBe('katalog')
    expect(pg.produktKatalogowy).toEqual({ id: 'b1c2d3e4-0000-4000-8000-000000000001', nazwa: 'Kurkuma mielona Testowa 100 g' })
    expect(pg.kategoria).toMatchObject({ id: KAT_PRZYPRAWA, sciezka: ['Supermarket', 'Przyprawa', 'Liściaste'] })
    // w trybie katalogowym tylko parametry oferty (Stan)
    expect(pg.parametry.map((w) => [w.nazwa, w.wartosc])).toEqual([['Stan', 'Nowy']])
    expect(pg.szkicOferty).toMatchObject({
      name: 'Kurkuma mielona z Japonii 100 g',
      productSet: [{ product: { id: 'b1c2d3e4-0000-4000-8000-000000000001', images: ['https://cdn.przyklad.test/kurkuma-1.jpg'] } }],
      sellingMode: { format: 'BUY_NOW', price: { amount: '39.90', currency: 'PLN' } },
      stock: { available: 12, unit: 'UNIT' },
      parameters: [{ id: '11323', valuesIds: ['11323_1'] }],
      language: 'pl-PL',
    })
    expect(kody(pg.problemy)).toEqual([])
    expect(pg.gotowa).toBe(true)
    expect(a.wywolania[0]).toBe(`/sale/products?phrase=${EAN_W_KATALOGU}&language=pl-PL`)
    expect(a.wywolania.some((w) => w.startsWith('/sale/matching-categories'))).toBe(false)
  })

  it('produkt spoza katalogu → pełny produkt z kategorią z mapy firmy i parametrami', async () => {
    const pg = await przygotujPodgladAllegro({ produkt: produkt() }, zrodloAllegroZApi(atrapaAllegro().get), ustawienia)
    expect(pg.tryb).toBe('nowy_produkt')
    expect(pg.produktKatalogowy).toBeNull()
    expect(pg.kategoria).toMatchObject({ id: KAT_PRZYPRAWA, sciezka: ['Supermarket', 'Przyprawa', 'Liściaste'] })
    expect(pg.kategoria.opis).toContain('mapy kategorii firmy')
    expect(pg.parametry.filter((w) => w.brak)).toEqual([])
    expect(pg.zdjecia).toEqual(['https://cdn.przyklad.test/kurkuma-1.jpg', 'https://cdn.przyklad.test/kurkuma-2.jpg']) // bez powtórzeń
    const prod = (pg.szkicOferty['productSet'] as { product: Record<string, unknown> }[])[0]!.product
    expect(prod).toMatchObject({ name: pg.tytul, category: { id: KAT_PRZYPRAWA }, images: pg.zdjecia })
    expect(prod['parameters']).toContainEqual({ id: '225693', values: [EAN_POZA_KATALOGIEM] })
    expect(prod['parameters']).toContainEqual({ id: '128430', valuesIds: ['128430_3'] })
    expect(pg.opis.sections[0]).toEqual({ items: [{ type: 'IMAGE', url: 'https://cdn.przyklad.test/kurkuma-1.jpg' }] })
    expect(pg.gotowa).toBe(true)
  })

  it('tytuł z wykrzyknikiem i opis z linkiem → oferta niegotowa, błędy na liście', async () => {
    const pg = await przygotujPodgladAllegro(
      { produkt: produkt(), tresc: { tytul: 'Kurkuma mielona 100 g, nowość!', opis: '<p>Przepis: <a href="https://przyklad.test/przepis">tutaj</a></p>' } },
      zrodloAllegroZApi(atrapaAllegro().get),
      ustawienia,
    )
    expect(pg.gotowa).toBe(false)
    expect(pg.problemy).toContainEqual(expect.objectContaining({ kod: 'tytul_wykrzyknik', waga: 'blad', pole: 'tytul' }))
    expect(pg.problemy).toContainEqual(expect.objectContaining({ kod: 'link', waga: 'blad', pole: 'opis' }))
    // opis w podglądzie już bez linku
    expect(JSON.stringify(pg.opis)).not.toContain('href')
  })

  it('braki wymaganych parametrów (firma bez marki i stałych) → błąd z nazwami parametrów', async () => {
    const pg = await przygotujPodgladAllegro(
      { produkt: produkt({ atrybuty: [] }) },
      zrodloAllegroZApi(atrapaAllegro().get),
      { ...DOMYSLNE_USTAWIENIA_OFERT, mapaKategorii: ustawienia.mapaKategorii },
    )
    expect(pg.parametry.filter((w) => w.brak).map((w) => w.nazwa)).toEqual(['Marka', 'Forma', 'Kraj pochodzenia'])
    expect(pg.problemy).toContainEqual(expect.objectContaining({ kod: 'brak_parametrow', waga: 'blad' }))
    expect(pg.gotowa).toBe(false)
  })

  it('firma bez mapy kategorii → propozycja Allegro do sprawdzenia', async () => {
    const pg = await przygotujPodgladAllegro({ produkt: produkt() }, zrodloAllegroZApi(atrapaAllegro().get), { ...ustawienia, mapaKategorii: { poSlowie: {} } })
    expect(pg.kategoria).toMatchObject({ id: KAT_PRZYPRAWA, propozycje: [{ id: KAT_PRZYPRAWA, nazwa: 'Liściaste', rodzicNazwa: 'Przyprawa' }] })
    expect(pg.kategoria.opis).toContain('propozycja Allegro')
  })

  it('bez EAN, ceny, zdjęć i stanu → błędy, bez pytania katalogu', async () => {
    const a = atrapaAllegro()
    const pg = await przygotujPodgladAllegro({ produkt: produkt({ ean: null, cenaBrutto: null, zdjecia: [], stan: 0 }) }, zrodloAllegroZApi(a.get), ustawienia)
    expect(kody(pg.problemy)).toEqual(expect.arrayContaining(['bez_ean', 'bez_zdjec', 'bez_ceny', 'brak_stanu']))
    expect(a.wywolania.some((w) => w.startsWith('/sale/products'))).toBe(false)
    expect(pg.cena).toBeNull()
  })

  it('nieudany odczyt kategorii albo parametrów = ostrzeżenie w podglądzie, ale `gotowa: false` z powodem i bez wystawienia', async () => {
    const baza = zrodloAllegroZApi(atrapaAllegro().get)
    const ok = await przygotujPodgladAllegro({ produkt: produkt() }, baza, ustawienia)
    expect(ok.gotowa).toBe(true)
    expect(ok.powodNiegotowej).toBeNull()
    const awaria = async () => Promise.reject(new Error('HTTP 503'))
    const bezParametrow = await przygotujPodgladAllegro({ produkt: produkt() }, { ...baza, parametryKategorii: awaria }, ustawienia)
    const bezKategorii = await przygotujPodgladAllegro({ produkt: produkt() }, { ...baza, kategoria: awaria }, ustawienia)
    const recznaNiesprawdzona = await przygotujPodgladAllegro({ produkt: produkt(), recznaKategoriaId: KAT_PRZYPRAWA }, { ...baza, kategoria: awaria, dopasujKategorie: awaria }, ustawienia)
    for (const pg of [bezParametrow, bezKategorii, recznaNiesprawdzona]) {
      expect(pg.problemy).toContainEqual(expect.objectContaining({ kod: 'allegro_niedostepne', waga: 'ostrzezenie' }))
      expect(kody(pg.problemy)).not.toContain('allegro_niedostepne')
      expect(pg.gotowa).toBe(false)
      expect(pg.powodNiegotowej).toBe(POWOD_NIESPRAWDZONEJ_KATEGORII)
      const zapis = atrapaZapisu({ status: 201, body: { id: '7700000001' } })
      const w = await wystawOferteAllegro(pg, 'HZ-KURKUMA-100', { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: atrapaAllegro().get }, { cennikDostawId: 'cennik-1' })
      expect(w).toEqual({ kind: 'NIEGOTOWA', komunikat: POWOD_NIESPRAWDZONEJ_KATEGORII })
      expect(zapis.zadania).toEqual([])
      // nawet podmieniona flaga `gotowa` nie przepuszcza podglądu z powodem blokady
      expect((await wystawOferteAllegro({ ...pg, gotowa: true }, 'HZ-KURKUMA-100', { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: atrapaAllegro().get }, { cennikDostawId: 'cennik-1' })).kind).toBe('NIEGOTOWA')
      expect(zapis.zadania).toEqual([])
    }
  })

  it('awaria katalogu Allegro nie wywraca podglądu: ostrzeżenie i pełny produkt', async () => {
    const pg = await przygotujPodgladAllegro({ produkt: produkt({ ean: EAN_W_KATALOGU }) }, zrodloAllegroZApi(atrapaAllegro({ '/sale/products': { status: 503, body: null } }).get), ustawienia)
    expect(pg.tryb).toBe('nowy_produkt')
    expect(pg.problemy).toContainEqual(expect.objectContaining({ kod: 'allegro_niedostepne', waga: 'ostrzezenie', pole: 'katalog' }))
    expect(pg.kategoria.id).toBe(KAT_PRZYPRAWA)
  })

  it('wymuszony nowy produkt pomija katalog (skill: --force-new-product), cena z ekranu wygrywa', async () => {
    const a = atrapaAllegro()
    const pg = await przygotujPodgladAllegro({ produkt: produkt({ ean: EAN_W_KATALOGU }), wymusNowyProdukt: true, cenaBrutto: 44.5 }, zrodloAllegroZApi(a.get), ustawienia)
    expect(pg.tryb).toBe('nowy_produkt')
    expect(pg.cena).toEqual({ kwota: '44.50', waluta: 'PLN' })
    expect(a.wywolania.some((w) => w.startsWith('/sale/products'))).toBe(false)
  })
})

describe('wybór produktu z katalogu', () => {
  const p = (id: string, eany: string[]) => ({ id, nazwa: `Produkt ${id}`, kategoriaId: null, eany, zdjecia: [] })
  it('bierze produkt z tym samym EAN (także GTIN-14 z zerem z przodu)', () => {
    expect(wybierzZKatalogu('5901234123457', [p('a', ['111']), p('b', ['05901234123457'])]).produkt?.id).toBe('b')
  })
  it('inny EAN = pełny produkt z ostrzeżeniem; produkt bez EAN = trafienie do sprawdzenia', () => {
    expect(wybierzZKatalogu('5901234123457', [p('a', ['111'])])).toMatchObject({ produkt: null, problem: { kod: 'katalog_inny_ean' } })
    expect(wybierzZKatalogu('5901234123457', [p('a', [])])).toMatchObject({ produkt: { id: 'a' }, problem: { kod: 'katalog_bez_potwierdzenia_ean' } })
    expect(wybierzZKatalogu('5901234123457', [])).toEqual({ produkt: null, problem: null })
  })
})
