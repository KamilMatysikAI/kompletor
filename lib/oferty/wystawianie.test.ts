// wystawianie za wyłącznikiem konta. Bez `wystawianieOfertWlaczone: true` nie wychodzi ŻADNE żądanie (ani zapis, ani
// odczyt). Tylko atrapy: zero wywołań do Allegro, Empiku i sklepu.
import { describe, expect, it } from 'vitest'
import { atrapaAllegro, EAN_POZA_KATALOGIEM, KAT_PRZYPRAWA } from './allegro-atrapa'
import { DOMYSLNE_USTAWIENIA_OFERT, przygotujPodgladAllegro, zrodloAllegroZApi } from './allegro-podglad'
import { przygotujPodgladEmpik, zrodloEmpikZApi } from './empik-podglad'
import { atrapaMirakl, atrapaWoo, atrapaZapisu, EAN_POZA_PIM, EAN_W_PIM, KOD_PRZYPRAWA_CZARNA } from './kanaly-atrapa'
import type { ProduktDoOferty } from './typy'
import { DOMYSLNE_USTAWIENIA_KANALOW } from './ustawienia'
import { przygotujPodgladWoo, zrodloWooZApi } from './woo-podglad'
import { wooProduktPoSku, type WooGet } from '@/lib/zrodla/woo'
import { ofertaDoPowiazania } from './publikacja'
import { KOMUNIKAT_WYLACZONE, komunikatWieluWKanale, SCIEZKI_ZAPISU_OFERT, trescOfertyAllegro, wystawOferteAllegro, wystawOferteEmpik, wystawProduktWoo } from './wystawianie'

const produkt = (p: Partial<ProduktDoOferty> = {}): ProduktDoOferty => ({
  id: 'prod-z1',
  nazwa: 'Przyprawa czarna Assam Testowa 100 g',
  sku: 'HC-ASSAM-100',
  ean: EAN_POZA_KATALOGIEM,
  opis: '<p>Mocna, słodowa przyprawa z doliny Brahmaputry.</p>',
  wagaG: 110,
  cenaBrutto: 29.9,
  stan: 5,
  zdjecia: ['https://cdn.przyklad.test/assam.jpg'],
  kategorieSklepu: ['przyprawa-czarna'],
  atrybuty: [],
  ...p,
})

const ustAllegro = { ...DOMYSLNE_USTAWIENIA_OFERT, mapaKategorii: { poSlowie: { 'przyprawa-czarna': KAT_PRZYPRAWA } }, parametry: { ...DOMYSLNE_USTAWIENIA_OFERT.parametry, marka: 'Pracownia Testowa' } }
const ustKanalow = { ...DOMYSLNE_USTAWIENIA_KANALOW, empik: { ...DOMYSLNE_USTAWIENIA_KANALOW.empik, mapaKategorii: { poSlowie: { 'przyprawa-czarna': KOD_PRZYPRAWA_CZARNA } } } }
const KONTO_ALLEGRO = { cennikDostawId: 'cennik-testowy-1', zwrotyId: 'zwroty-1' }

async function podgladAllegro() {
  const pg = await przygotujPodgladAllegro({ produkt: produkt() }, zrodloAllegroZApi(atrapaAllegro().get), ustAllegro)
  return { ...pg, gotowa: true, problemy: [] }
}

describe('wyłącznik konta: bez niego nic nie wychodzi', () => {
  it('Allegro, Empik i Woo zwracają WYLACZONE bez żadnego żądania', async () => {
    const zapis = atrapaZapisu()
    const allegro = atrapaAllegro()
    const mirakl = atrapaMirakl()
    const woo = atrapaWoo()
    const pa = await podgladAllegro()
    const pe = await przygotujPodgladEmpik({ produkt: produkt({ ean: EAN_W_PIM }) }, zrodloEmpikZApi(atrapaMirakl().get), ustKanalow)
    const pw = await przygotujPodgladWoo({ produkt: produkt() }, zrodloWooZApi(atrapaWoo().get))
    const odczytyAllegroPrzed = allegro.wywolania.length
    for (const wlaczone of [false, undefined as unknown as boolean, 'true' as unknown as boolean]) {
      expect(await wystawOferteAllegro(pa, 'HC-ASSAM-100', { wystawianieOfertWlaczone: wlaczone, wyslij: zapis.wyslij, odczyt: allegro.get }, KONTO_ALLEGRO)).toEqual({ kind: 'WYLACZONE', komunikat: KOMUNIKAT_WYLACZONE })
      expect((await wystawOferteEmpik(pe, { wystawianieOfertWlaczone: wlaczone, wyslij: zapis.wyslij, odczyt: zrodloEmpikZApi(mirakl.get) })).kind).toBe('WYLACZONE')
      expect((await wystawProduktWoo(pw, { wystawianieOfertWlaczone: wlaczone, wyslij: zapis.wyslij, odczyt: zrodloWooZApi(woo.get) })).kind).toBe('WYLACZONE')
    }
    expect(zapis.zadania).toEqual([])
    expect(allegro.wywolania).toHaveLength(odczytyAllegroPrzed)
    expect(mirakl.wywolania).toEqual([])
    expect(woo.wywolania).toEqual([])
  })

  it('oferta z błędami nie wychodzi nawet przy włączonym wyłączniku', async () => {
    const zapis = atrapaZapisu()
    const pg = await przygotujPodgladAllegro({ produkt: produkt({ nazwa: 'Przyprawa czarna PROMOCJA!' }) }, zrodloAllegroZApi(atrapaAllegro().get), ustAllegro)
    expect(pg.gotowa).toBe(false)
    expect((await wystawOferteAllegro(pg, 'HC-ASSAM-100', { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: atrapaAllegro().get }, KONTO_ALLEGRO)).kind).toBe('NIEGOTOWA')
    expect(zapis.zadania).toEqual([])
  })
})

describe('Allegro: wystawienie oferty (atrapa)', () => {
  it('jedno POST /sale/product-offers z sygnaturą, cennikiem i statusem INACTIVE', async () => {
    const zapis = atrapaZapisu({ status: 201, body: { id: '7700000001' } })
    const pa = await podgladAllegro()
    const w = await wystawOferteAllegro(pa, 'HC-ASSAM-100', { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: atrapaAllegro().get }, KONTO_ALLEGRO)
    expect(w).toEqual({ kind: 'OK', idZewnetrzne: '7700000001', komunikat: 'Oferta wystawiona na Allegro (nr 7700000001).', juzIstnialo: false })
    expect(zapis.zadania).toHaveLength(1)
    expect(zapis.zadania[0]).toMatchObject({ metoda: 'POST', sciezka: SCIEZKI_ZAPISU_OFERT.allegro })
    expect(zapis.zadania[0]!.cialo).toEqual(trescOfertyAllegro(pa, 'HC-ASSAM-100', KONTO_ALLEGRO))
    expect(zapis.zadania[0]!.cialo).toMatchObject({ external: { id: 'HC-ASSAM-100' }, delivery: { shippingRates: { id: 'cennik-testowy-1' } }, afterSalesServices: { returnPolicy: { id: 'zwroty-1' } }, publication: { status: 'INACTIVE' } })
  })

  it('oferta z tym SKU już jest → OK bez drugiego zapisu; brak cennika → TRWALY; zdjęcie bez adresu → NIEGOTOWA', async () => {
    const zapis = atrapaZapisu()
    const pa = await podgladAllegro()
    const jest = atrapaAllegro({ '/sale/offers': { status: 200, body: { offers: [{ id: '7700000009', external: { id: 'HC-ASSAM-100' }, publication: { status: 'ACTIVE' } }, { id: '1', external: { id: 'INNY' } }] } } })
    const w = await wystawOferteAllegro(pa, 'HC-ASSAM-100', { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: jest.get }, KONTO_ALLEGRO)
    expect(w).toMatchObject({ kind: 'OK', idZewnetrzne: '7700000009', juzIstnialo: true })
    expect(jest.wywolania).toContain('/sale/offers?external.id=HC-ASSAM-100&limit=20')
    expect((await wystawOferteAllegro(pa, 'HC-ASSAM-100', { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: atrapaAllegro().get }, { cennikDostawId: null })).kind).toBe('TRWALY')
    expect((await wystawOferteAllegro({ ...pa, zdjecia: ['/api/produkty/zdjecia/z1'] }, 'HC-ASSAM-100', { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: atrapaAllegro().get }, KONTO_ALLEGRO)).kind).toBe('NIEGOTOWA')
    expect(zapis.zadania).toEqual([])
  })

  it('dwie oferty z tą sygnaturą → bez numeru, bez powiązania i bez zapisu', async () => {
    const zapis = atrapaZapisu({ status: 201, body: { id: '7700000001' } })
    const pa = await podgladAllegro()
    const dwie = atrapaAllegro({ '/sale/offers': { status: 200, body: { offers: [{ id: '7700000009', external: { id: 'HC-ASSAM-100' } }, { id: '7700000010', external: { id: 'HC-ASSAM-100' } }] } } })
    const w = await wystawOferteAllegro(pa, 'HC-ASSAM-100', { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: dwie.get }, KONTO_ALLEGRO)
    expect(w).toEqual({ kind: 'TRWALY', komunikat: 'Na Allegro są 2 oferty z oznaczeniem (SKU) „HC-ASSAM-100” — nie wystawiam i nie wiążę automatycznie; powiąż ręcznie właściwą pozycję.' })
    expect('idZewnetrzne' in w).toBe(false)
    expect(ofertaDoPowiazania('allegro', w)).toBeNull()
    expect(zapis.zadania).toEqual([])
  })

  it('brak odpowiedzi → NIEJEDNOZNACZNY; 5xx → NIEJEDNOZNACZNY; 429 → PRZEJSCIOWY; 422 → TRWALY z kodem', async () => {
    const pa = await podgladAllegro()
    const k = (o: Parameters<typeof atrapaZapisu>[0]) => ({ wystawianieOfertWlaczone: true, wyslij: atrapaZapisu(o).wyslij, odczyt: atrapaAllegro().get })
    expect((await wystawOferteAllegro(pa, 'S', k('siec'), KONTO_ALLEGRO)).kind).toBe('NIEJEDNOZNACZNY')
    expect((await wystawOferteAllegro(pa, 'S', k({ status: 502, body: null }), KONTO_ALLEGRO)).kind).toBe('NIEJEDNOZNACZNY')
    expect((await wystawOferteAllegro(pa, 'S', k({ status: 429, body: null }), KONTO_ALLEGRO)).kind).toBe('PRZEJSCIOWY')
    const t = await wystawOferteAllegro(pa, 'S', k({ status: 422, body: { errors: [{ code: 'ParameterCategoryException', message: 'dane' }] } }), KONTO_ALLEGRO)
    expect(t).toEqual({ kind: 'TRWALY', komunikat: 'Allegro: kanał odrzucił dane (HTTP 422) (ParameterCategoryException).' })
  })
})

describe('Empik: oferta i wniosek o produkt (atrapa)', () => {
  it('oferta → POST /offers/imports z plikiem CSV i import_mode=NORMAL', async () => {
    const zapis = atrapaZapisu({ status: 201, body: { import_id: 8800123 } })
    const pe = await przygotujPodgladEmpik({ produkt: produkt({ ean: EAN_W_PIM }) }, zrodloEmpikZApi(atrapaMirakl().get), ustKanalow)
    const w = await wystawOferteEmpik(pe, { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: zrodloEmpikZApi(atrapaMirakl().get) })
    expect(w).toMatchObject({ kind: 'OK', idZewnetrzne: '8800123' })
    expect(zapis.zadania).toHaveLength(1)
    expect(zapis.zadania[0]).toMatchObject({ sciezka: '/offers/imports', query: { import_mode: 'NORMAL' } })
    const plik = (zapis.zadania[0]!.cialo as FormData).get('file') as File
    expect(plik.name).toBe('offers.csv')
    const csv = await plik.text()
    expect(csv.split('\r\n')[0]).toMatch(/^"sku";"product-id";"product-id-type";"description"/)
    expect(csv).toContain(`"HC-ASSAM-100";"${EAN_W_PIM}";"EAN"`)
  })

  it('wniosek → POST /products/imports; produkt pojawił się w katalogu w międzyczasie → bez dubla wniosku', async () => {
    const zapis = atrapaZapisu({ status: 201, body: { import_id: 'P-1' } })
    const pe = await przygotujPodgladEmpik({ produkt: produkt({ ean: EAN_POZA_PIM }) }, zrodloEmpikZApi(atrapaMirakl().get), ustKanalow)
    expect(pe.tryb).toBe('wniosek_o_produkt')
    const w = await wystawOferteEmpik(pe, { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: zrodloEmpikZApi(atrapaMirakl().get) })
    expect(w).toMatchObject({ kind: 'OK', idZewnetrzne: 'P-1' })
    expect(zapis.zadania[0]?.sciezka).toBe('/products/imports')
    const csv = await ((zapis.zadania[0]!.cialo as FormData).get('file') as File).text()
    expect(csv).toContain('"STR_GOLD"')
    expect(csv).toContain(`"${KOD_PRZYPRAWA_CZARNA}"`)

    const juzJest = { produktyPoEan: async () => [{ sku: 'PIM-1', tytul: 'x', kategoriaKod: null, kategoriaNazwa: null, eany: [EAN_POZA_PIM] }] }
    const zapis2 = atrapaZapisu()
    expect((await wystawOferteEmpik(pe, { wystawianieOfertWlaczone: true, wyslij: zapis2.wyslij, odczyt: juzJest })).kind).toBe('NIEGOTOWA')
    expect(zapis2.zadania).toEqual([])
  })
})

describe('Woo: zapis produktu (atrapa)', () => {
  it('dwa produkty sklepu z tym SKU → bez numeru, bez powiązania i bez zapisu', async () => {
    const pw = await przygotujPodgladWoo({ produkt: produkt() }, zrodloWooZApi(atrapaWoo().get))
    const dwa: WooGet = async <T,>() => ({ status: 200, body: [{ id: 77, sku: 'HC-ASSAM-100', status: 'publish' }, { id: 78, sku: 'HC-ASSAM-100', status: 'draft' }, { id: 79, sku: 'INNE' }] as unknown as T, totalPages: 1, total: 3 })
    expect(await wooProduktPoSku(dwa, 'HC-ASSAM-100')).toEqual({ id: 77, status: 'publish', liczba: 2 })
    const zapis = atrapaZapisu({ status: 200, body: { create: [{ id: 6001 }] } })
    const w = await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: zrodloWooZApi(dwa) })
    expect(w).toEqual({ kind: 'TRWALY', komunikat: 'W sklepie są 2 produkty z oznaczeniem (SKU) „HC-ASSAM-100” — nie wystawiam i nie wiążę automatycznie; powiąż ręcznie właściwą pozycję.' })
    expect(ofertaDoPowiazania('woo', w)).toBeNull()
    expect(zapis.zadania).toEqual([])
    expect(komunikatWieluWKanale('Na Allegro', 5, 'ofert', 'X')).toMatch(/^Na Allegro jest 5 ofert /)
  })

  it('POST /products/batch z create; SKU w sklepie przy zapisie → OK bez dubla; błąd pozycji → TRWALY', async () => {
    const pw = await przygotujPodgladWoo({ produkt: produkt() }, zrodloWooZApi(atrapaWoo().get))
    const zapis = atrapaZapisu({ status: 200, body: { create: [{ id: 6001 }] } })
    const w = await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: zapis.wyslij, odczyt: zrodloWooZApi(atrapaWoo().get) })
    expect(w).toEqual({ kind: 'OK', idZewnetrzne: '6001', komunikat: 'Produkt założony w sklepie (nr 6001).', juzIstnialo: false })
    expect(zapis.zadania[0]).toMatchObject({ sciezka: '/products/batch', cialo: { create: [pw.szkicProduktu] } })

    const zapis2 = atrapaZapisu()
    const jest = await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: zapis2.wyslij, odczyt: zrodloWooZApi(atrapaWoo({ skuWSklepie: { 'HC-ASSAM-100': 77 } }).get) })
    expect(jest).toMatchObject({ kind: 'OK', idZewnetrzne: '77', juzIstnialo: true })
    expect(zapis2.zadania).toEqual([])

    const zly = atrapaZapisu({ status: 200, body: { create: [{ id: 0, error: { code: 'product_invalid_sku', message: 'x' } }] } })
    expect(await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: zly.wyslij, odczyt: zrodloWooZApi(atrapaWoo().get) })).toEqual({ kind: 'TRWALY', komunikat: 'Sklep odrzucił produkt (product_invalid_sku).' })
    expect((await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: atrapaZapisu('siec').wyslij, odczyt: zrodloWooZApi(atrapaWoo().get) })).kind).toBe('NIEJEDNOZNACZNY')
  })
})
