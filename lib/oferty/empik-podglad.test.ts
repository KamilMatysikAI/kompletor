// (kryterium akceptacji „Test Empik”): produkt w katalogu Empiku → podgląd oferty; produkt spoza katalogu →
// podgląd wniosku o produkt. Atrapa Mirakla, dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { miraklKategorie, miraklProduktyPoEan } from '@/lib/zrodla/mirakl'
import { csvEmpik, KOLUMNY_OFERTY_EMPIK, OPIS_OFERTY_EMPIK_MAX, przygotujPodgladEmpik, skrocOpisEmpik, zrodloEmpikZApi } from './empik-podglad'
import { atrapaMirakl, EAN_POZA_PIM, EAN_W_PIM, KOD_PRZYPRAWA_CZARNA } from './kanaly-atrapa'
import type { ProduktDoOferty } from './typy'
import { DOMYSLNE_USTAWIENIA_KANALOW, type UstawieniaOfertKanalow } from './ustawienia'

const produkt = (p: Partial<ProduktDoOferty> = {}): ProduktDoOferty => ({
  id: 'prod-e1',
  nazwa: 'Przyprawa czarna Assam Testowa 100 g',
  sku: 'HC-ASSAM-100',
  ean: EAN_W_PIM,
  opis: '<p>Mocna, słodowa przyprawa z doliny Brahmaputry.</p>',
  wagaG: 110,
  cenaBrutto: 29.9,
  stan: 5,
  zdjecia: ['https://cdn.przyklad.test/assam.jpg'],
  kategorieSklepu: [],
  atrybuty: [],
  ...p,
})

const ustawienia: UstawieniaOfertKanalow = { ...DOMYSLNE_USTAWIENIA_KANALOW, empik: { ...DOMYSLNE_USTAWIENIA_KANALOW.empik, mapaKategorii: { poSlowie: { 'przyprawa-czarna': KOD_PRZYPRAWA_CZARNA } } } }
const bledy = (p: { kod: string; waga: string }[]) => p.filter((x) => x.waga === 'blad').map((x) => x.kod)

describe('Mirakl: odczyt katalogu i kategorii', () => {
  it('P31 po EAN i H11 struktura kategorii (tylko GET, parsery odrzucają śmieci)', async () => {
    const a = atrapaMirakl()
    expect(await miraklProduktyPoEan(a.get, EAN_W_PIM)).toEqual([{ sku: 'PIM-777001', tytul: 'Przyprawa czarna Testowa Assam 100 g', kategoriaKod: KOD_PRZYPRAWA_CZARNA, kategoriaNazwa: 'Przyprawa czarna', eany: [EAN_W_PIM] }])
    expect(await miraklProduktyPoEan(a.get, EAN_POZA_PIM)).toEqual([])
    expect(await miraklKategorie(a.get)).toEqual([
      { kod: '13-34-8', nazwa: 'Przyprawa', poziom: 3, rodzicKod: '13-34' },
      { kod: KOD_PRZYPRAWA_CZARNA, nazwa: 'Przyprawa czarna', poziom: 4, rodzicKod: '13-34-8' },
    ])
    expect(a.wywolania).toEqual([`/products?product_references=EAN%7C${EAN_W_PIM}`, `/products?product_references=EAN%7C${EAN_POZA_PIM}`, '/hierarchies'])
    await expect(miraklProduktyPoEan(a.get, '12')).rejects.toThrow(/8–14/)
  })
})

describe('podgląd oferty Empik', () => {
  it('produkt w katalogu Empiku → oferta (wiersz importu ofert, kategoria z katalogu)', async () => {
    const pg = await przygotujPodgladEmpik({ produkt: produkt() }, zrodloEmpikZApi(atrapaMirakl().get), ustawienia)
    expect(pg.tryb).toBe('oferta')
    expect(pg.produktPim?.sku).toBe('PIM-777001')
    expect(pg.kategoria.kod).toBe(KOD_PRZYPRAWA_CZARNA)
    expect(pg.wierszProduktu).toBeNull()
    expect(pg.zdjecia).toEqual([])
    expect(pg.gotowa).toBe(true)
    expect(Object.keys(pg.wierszOferty)).toEqual([...KOLUMNY_OFERTY_EMPIK])
    expect(pg.wierszOferty).toMatchObject({ sku: 'HC-ASSAM-100', 'product-id': EAN_W_PIM, 'product-id-type': 'EAN', price: '29.90', quantity: '5', 'min-quantity-alert': '2', state: '11' })
    expect(pg.wierszOferty['description']).toContain('Mocna, słodowa przyprawa')
    expect(pg.wierszOferty['description']).not.toMatch(/</)
  })

  it('produkt spoza katalogu → wniosek o produkt z kategorią z mapy firmy i zdjęciem', async () => {
    const pg = await przygotujPodgladEmpik({ produkt: produkt({ ean: EAN_POZA_PIM }) }, zrodloEmpikZApi(atrapaMirakl().get), ustawienia)
    expect(pg.tryb).toBe('wniosek_o_produkt')
    expect(pg.problemy.map((x) => x.kod)).toContain('empik_poza_katalogiem')
    expect(pg.kategoria).toEqual({ kod: KOD_PRZYPRAWA_CZARNA, opis: 'z mapy firmy (słowo „przyprawa-czarna”)' })
    expect(pg.wierszProduktu).toEqual({
      sku: 'HC-ASSAM-100',
      'product-id': EAN_POZA_PIM,
      'product-id-type': 'EAN',
      STR_GOLD: KOD_PRZYPRAWA_CZARNA,
      CATALOG_CODE: 'HC-ASSAM-100',
      PELNY_TYTUL: 'Przyprawa czarna Assam Testowa 100 g',
      OPIS_PRODUKTU_PELNY: expect.stringContaining('Mocna, słodowa przyprawa'),
      ZDJECIE_OKLADKI_PRZOD_DUZY: 'https://cdn.przyklad.test/assam.jpg',
      VAT_VALUE: '23%',
      EAN: EAN_POZA_PIM,
    })
    expect(pg.gotowa).toBe(true)
  })

  it('wniosek bez kategorii, bez publicznego zdjęcia i z linkiem w opisie → błędy', async () => {
    const pg = await przygotujPodgladEmpik(
      { produkt: produkt({ ean: EAN_POZA_PIM, nazwa: 'Świeca zapachowa wanilia', zdjecia: ['/api/produkty/zdjecia/z1'], opis: '<p>Więcej na https://sklep.przyklad.test</p>' }) },
      zrodloEmpikZApi(atrapaMirakl().get),
      ustawienia,
    )
    expect(bledy(pg.problemy)).toEqual(expect.arrayContaining(['bez_kategorii', 'zdjecie_bez_adresu', 'link']))
    expect(pg.problemy.find((x) => x.kod === 'link')?.komunikat).toContain('Empik')
    expect(pg.gotowa).toBe(false)
  })

  it('ręczny kod kategorii: zły format = błąd, dobry wygrywa z mapą', async () => {
    const z = zrodloEmpikZApi(atrapaMirakl().get)
    const zly = await przygotujPodgladEmpik({ produkt: produkt({ ean: EAN_POZA_PIM }), recznaKategoria: 'przyprawa' }, z, ustawienia)
    expect(bledy(zly.problemy)).toContain('kategoria_zly_kod')
    const dobry = await przygotujPodgladEmpik({ produkt: produkt({ ean: EAN_POZA_PIM }), recznaKategoria: '13-34-8-7' }, z, ustawienia)
    expect(dobry.kategoria.kod).toBe('13-34-8-7')
  })

  it('bez EAN albo bez odpowiedzi Empiku nie wiadomo, co wysłać → błąd, podgląd i tak powstaje', async () => {
    const bezEan = await przygotujPodgladEmpik({ produkt: produkt({ ean: null }) }, zrodloEmpikZApi(atrapaMirakl().get), ustawienia)
    expect(bledy(bezEan.problemy)).toContain('bez_ean')
    const awaria = await przygotujPodgladEmpik({ produkt: produkt() }, zrodloEmpikZApi(atrapaMirakl(['/products']).get), ustawienia)
    expect(bledy(awaria.problemy)).toContain('empik_niedostepne')
    expect(awaria.gotowa).toBe(false)
    expect(awaria.wierszOferty['sku']).toBe('HC-ASSAM-100')
  })

  it('opis dłuższy niż limit: skrót na granicy zdania + ostrzeżenie', async () => {
    const zdanie = 'Przyprawa o głębokim, słodowym smaku z nutą miodu. '
    const dlugi = `<p>${zdanie.repeat(60)}</p>`
    const s = skrocOpisEmpik(dlugi)
    expect(s.length).toBeLessThanOrEqual(OPIS_OFERTY_EMPIK_MAX)
    expect(s.endsWith('.')).toBe(true)
    expect(skrocOpisEmpik(`<p>${'a'.repeat(3000)}</p>`)).toMatch(/…$/)
    const pg = await przygotujPodgladEmpik({ produkt: produkt({ opis: dlugi }) }, zrodloEmpikZApi(atrapaMirakl().get), ustawienia)
    expect(pg.problemy.map((x) => x.kod)).toContain('opis_skrocony')
  })

  it('CSV importu: średnik, cudzysłowy, bez nowych linii w polach, CRLF', () => {
    expect(csvEmpik(['sku', 'description'], [{ sku: 'A"1', description: 'linia 1\nlinia 2' }])).toBe('"sku";"description"\r\n"A""1";"linia 1 linia 2"\r\n')
  })
})
