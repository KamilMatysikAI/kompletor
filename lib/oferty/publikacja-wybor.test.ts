// (3b-2b): ręczny wybór kategorii i parametrów na ekranie „Publikacja” — walidacja wejścia z przeglądarki,
// lista wyboru kategorii, parametry do uzupełnienia i przekazanie wyboru do podglądu Allegro (atrapa, bez bazy).
import { describe, expect, it } from 'vitest'
import { atrapaAllegro, EAN_POZA_KATALOGIEM, KAT_PRZYPRAWA } from './allegro-atrapa'
import { DOMYSLNE_USTAWIENIA_OFERT, przygotujPodgladAllegro, zrodloAllegroZApi } from './allegro-podglad'
import { kafelZPodgladu, opcjeKategorii, parametryDoUzupelnienia, PARAMETRY_RECZNE_MAX, WARTOSC_PARAMETRU_MAX, wyborPusty, wyborRecznyZWejscia, type KafelPublikacji } from './publikacja'
import { kontoBezKonta } from './publikacja-serwer'

const kafel = (z: Partial<KafelPublikacji> = {}): Pick<KafelPublikacji, 'kanal' | 'kategoria' | 'kategoriaId' | 'kategoriaReczna' | 'propozycjeKategorii' | 'parametry'> => ({
  kanal: 'allegro',
  kategoria: 'Przyprawy → Zielone',
  kategoriaId: '111',
  kategoriaReczna: false,
  propozycjeKategorii: [
    { id: '111', etykieta: 'Przyprawy → Zielone' },
    { id: '222', etykieta: 'Przyprawy → Czarne' },
  ],
  parametry: [
    { id: '11323', nazwa: 'Stan', wartosc: 'Nowy', brak: false, wymagany: true, reczna: false, przyklady: [] },
    { id: '3458', nazwa: 'Forma', wartosc: null, brak: true, wymagany: true, reczna: false, przyklady: ['liściasta', 'w torebkach'] },
    { id: '17448', nazwa: 'Kraj pochodzenia', wartosc: 'Chiny', brak: false, wymagany: true, reczna: true, przyklady: [] },
  ],
  ...z,
})

describe('wyborRecznyZWejscia', () => {
  it('przepuszcza numery Allegro i przycina wartości', () => {
    expect(wyborRecznyZWejscia({ kategoriaId: ' 222 ', parametry: { '3458': '  liściasta ', '17448': 'Chiny' } })).toEqual({ kategoriaId: '222', parametry: { '3458': 'liściasta', '17448': 'Chiny' } })
  })
  it('odrzuca śmieci: zły typ, klucze nienumeryczne, puste wartości, znaki sterujące, za długie', () => {
    expect(wyborRecznyZWejscia(null)).toEqual({ kategoriaId: null, parametry: {} })
    expect(wyborRecznyZWejscia('222')).toEqual({ kategoriaId: null, parametry: {} })
    expect(wyborRecznyZWejscia([1])).toEqual({ kategoriaId: null, parametry: {} })
    const w = wyborRecznyZWejscia({ kategoriaId: '../1', parametry: { __proto__x: 'a', abc: 'b', '1': '   ', '2': 5, '3': 'a\u0000b\nc', '4': 'x'.repeat(500) } })
    expect(w.kategoriaId).toBeNull()
    expect(w.parametry).toEqual({ '3': 'a b c', '4': 'x'.repeat(WARTOSC_PARAMETRU_MAX) })
  })
  it('najwyżej 60 parametrów', () => {
    const duzo = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i + 1), 'v']))
    expect(Object.keys(wyborRecznyZWejscia({ parametry: duzo }).parametry)).toHaveLength(PARAMETRY_RECZNE_MAX)
  })
  it('wyborPusty', () => {
    expect(wyborPusty(undefined)).toBe(true)
    expect(wyborPusty({ kategoriaId: null, parametry: {} })).toBe(true)
    expect(wyborPusty({ kategoriaId: '1', parametry: {} })).toBe(false)
    expect(wyborPusty({ kategoriaId: null, parametry: { '1': 'a' } })).toBe(false)
  })
})

describe('opcjeKategorii i parametryDoUzupelnienia', () => {
  it('Allegro z propozycjami: „automatycznie” + propozycje, bez dubla bieżącej', () => {
    expect(opcjeKategorii(kafel()).map((o) => o.wartosc)).toEqual(['', '111', '222'])
  })
  it('kategoria spoza propozycji (np. z mapy firmy) jest na liście jako „w podglądzie”', () => {
    const o = opcjeKategorii(kafel({ kategoriaId: '999', kategoria: 'Kawa → Ziarnista' }))
    expect(o.map((x) => x.wartosc)).toEqual(['', '999', '111', '222'])
    expect(o[1]!.etykieta).toContain('Kawa → Ziarnista')
  })
  it('bez propozycji i bez ręcznej kategorii = brak listy; Empik i sklep nigdy', () => {
    expect(opcjeKategorii(kafel({ propozycjeKategorii: [] }))).toEqual([])
    expect(opcjeKategorii(kafel({ propozycjeKategorii: [], kategoriaReczna: true })).map((o) => o.wartosc)).toEqual(['', '111'])
    expect(opcjeKategorii(kafel({ kanal: 'empik' }))).toEqual([])
    expect(opcjeKategorii(kafel({ kanal: 'woo' }))).toEqual([])
  })
  it('do uzupełnienia: brakujące i wpisane ręcznie, tylko Allegro', () => {
    expect(parametryDoUzupelnienia(kafel()).map((p) => p.nazwa)).toEqual(['Forma', 'Kraj pochodzenia'])
    expect(parametryDoUzupelnienia(kafel({ kanal: 'woo' }))).toEqual([])
  })
})

describe('ręczny wybór w podglądzie Allegro (atrapa nagranych odpowiedzi)', () => {
  const produktBezCech = {
    id: 'prod-1',
    nazwa: 'Kurkuma mielona z Japonii 100 g',
    sku: 'HZ-KURKUMA-100',
    ean: EAN_POZA_KATALOGIEM,
    opis: '<p>Łagodna kurkuma z wiosennego zbioru.</p>',
    wagaG: 110,
    cenaBrutto: 39.9,
    stan: 12,
    zdjecia: ['https://cdn.przyklad.test/kurkuma-1.jpg'],
    kategorieSklepu: ['przyprawa-zielona'],
    atrybuty: [],
  }
  const ust = { ...DOMYSLNE_USTAWIENIA_OFERT, mapaKategorii: { poSlowie: { 'przyprawa-zielona': KAT_PRZYPRAWA } } }

  it('wartości wpisane ręcznie usuwają braki i są oznaczone jako ręczne; kategoria z wyboru = ręczna', async () => {
    const bez = await przygotujPodgladAllegro({ produkt: produktBezCech }, zrodloAllegroZApi(atrapaAllegro().get), ust)
    const braki = bez.parametry.filter((p) => p.brak)
    expect(braki.map((p) => p.nazwa)).toEqual(['Marka', 'Forma', 'Kraj pochodzenia'])
    const reczne = wyborRecznyZWejscia({ kategoriaId: KAT_PRZYPRAWA, parametry: Object.fromEntries(braki.map((p) => [p.id, p.przyklady[0] ?? 'Japonia'])) })
    const z = await przygotujPodgladAllegro({ produkt: produktBezCech, recznaKategoriaId: reczne.kategoriaId, reczneParametry: reczne.parametry }, zrodloAllegroZApi(atrapaAllegro().get), ust)
    expect(z.parametry.filter((p) => p.brak)).toEqual([])
    const k = kafelZPodgladu(kontoBezKonta('allegro'), z, reczne)
    expect(k.kategoriaReczna).toBe(true)
    expect(k.kategoriaId).toBe(KAT_PRZYPRAWA)
    expect(parametryDoUzupelnienia(k).map((p) => p.nazwa)).toEqual(['Marka', 'Forma', 'Kraj pochodzenia'])
    expect(parametryDoUzupelnienia(k).every((p) => p.reczna && !p.brak)).toBe(true)
    expect(JSON.parse(JSON.stringify(k))).toEqual(k)
  })
})
