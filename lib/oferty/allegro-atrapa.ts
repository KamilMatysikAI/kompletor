// Atrapa odczytów Allegro dla testów ofertowania: odpowiedzi w kształcie API Allegro
// (`/sale/products`, `/sale/categories`, `/sale/matching-categories`, `/sale/categories/{id}/parameters`),
// dane fikcyjne (id kategorii z zakresu 9xxxxx, EAN-y testowe, nazwy wymyślone). Id parametrów EAN, marki, wagi
// i stanu są prawdziwymi, wspólnymi id Allegro (jak w skillu allegro-oferty). Bez sieci.
import type { AllegroGet, AllegroResponse } from '@/lib/zrodla/allegro'

export const EAN_W_KATALOGU = '5901234123457'
export const EAN_POZA_KATALOGIEM = '5909876543210'
export const KAT_PRZYPRAWA = '900101'
export const KAT_KUBKI = '900202'
export const KAT_NADRZEDNA = '900100'

type Odp = { status: number; body: unknown }

const kategorie: Record<string, unknown> = {
  [KAT_NADRZEDNA]: { id: KAT_NADRZEDNA, name: 'Przyprawa', leaf: false, parent: { id: '900000' } },
  '900000': { id: '900000', name: 'Supermarket', leaf: false, parent: null },
  [KAT_PRZYPRAWA]: { id: KAT_PRZYPRAWA, name: 'Liściaste', leaf: true, parent: { id: KAT_NADRZEDNA } },
  [KAT_KUBKI]: { id: KAT_KUBKI, name: 'Kubki', leaf: true, parent: { id: '900200' } },
  '900200': { id: '900200', name: 'Naczynia', leaf: false, parent: null },
}

const slownikStanu = [
  { id: '11323_1', value: 'Nowy' },
  { id: '11323_2', value: 'Używany' },
]

export const PARAMETRY_PRZYPRAWY = {
  parameters: [
    { id: '225693', name: 'EAN (GTIN)', type: 'string', required: false, requiredForProduct: true, options: { describesProduct: true }, restrictions: { minLength: 8, maxLength: 14 } },
    {
      id: '248811',
      name: 'Marka',
      type: 'dictionary',
      required: false,
      requiredForProduct: true,
      options: { describesProduct: true },
      dictionary: [{ id: '248811_1', value: 'Pracownia Testowa' }, { id: '248811_2', value: 'Inna Marka' }],
      restrictions: { allowedOtherValue: true },
    },
    { id: '221929', name: 'Waga produktu z opakowaniem jednostkowym', type: 'float', unit: 'kg', required: false, requiredForProduct: true, options: { describesProduct: true } },
    {
      id: '3458',
      name: 'Forma',
      type: 'dictionary',
      required: false,
      requiredForProduct: true,
      options: { describesProduct: true },
      dictionary: [{ id: '3458_1', value: 'liściasta' }, { id: '3458_2', value: 'ekspresowa' }, { id: '3458_3', value: 'granulowana' }],
      restrictions: { allowedOtherValue: false },
    },
    {
      id: '128430',
      name: 'Kraj pochodzenia',
      type: 'dictionary',
      required: false,
      requiredForProduct: true,
      options: { describesProduct: true },
      dictionary: [{ id: '128430_1', value: 'Chiny' }, { id: '128430_2', value: 'Indie' }, { id: '128430_3', value: 'Japonia' }],
      restrictions: { allowedOtherValue: false },
    },
    { id: '17448', name: 'Smak', type: 'string', required: false, requiredForProduct: false, options: { describesProduct: true } },
    { id: '11323', name: 'Stan', type: 'dictionary', required: true, requiredForProduct: false, options: { describesProduct: false }, dictionary: slownikStanu },
  ],
}

export const PARAMETRY_KUBKOW = {
  parameters: [
    { id: '225693', name: 'EAN (GTIN)', type: 'string', required: false, requiredForProduct: true, options: { describesProduct: true } },
    { id: '220677', name: 'Pojemność', type: 'integer', unit: 'ml', required: true, requiredForProduct: true, options: { describesProduct: true } },
    { id: '23389', name: 'Materiał', type: 'dictionary', required: true, requiredForProduct: true, options: { describesProduct: true }, dictionary: [{ id: '23389_1', value: 'ceramika' }, { id: '23389_2', value: 'szkło' }] },
    { id: '224017', name: 'Kod producenta', type: 'string', required: false, requiredForProduct: false, options: { describesProduct: true } },
    { id: '11323', name: 'Stan', type: 'dictionary', required: true, requiredForProduct: false, options: { describesProduct: false }, dictionary: slownikStanu },
  ],
}

export const PRODUKTY_PO_EAN: Record<string, unknown> = {
  [EAN_W_KATALOGU]: {
    products: [
      {
        id: 'b1c2d3e4-0000-4000-8000-000000000001',
        name: 'Kurkuma mielona Testowa 100 g',
        category: { id: KAT_PRZYPRAWA },
        parameters: [{ id: '225693', name: 'EAN (GTIN)', values: [EAN_W_KATALOGU] }],
        images: [{ url: 'https://a.allegroimg.com/original/test/katalog-1.jpg' }],
      },
    ],
  },
  [EAN_POZA_KATALOGIEM]: { products: [] },
}

const DOPASOWANIA: Record<string, unknown> = {
  domyslne: {
    matchingCategories: [
      { id: KAT_NADRZEDNA, name: 'Przyprawa', leaf: false, parent: { id: '900000', name: 'Supermarket' } },
      { id: KAT_PRZYPRAWA, name: 'Liściaste', leaf: true, parent: { id: KAT_NADRZEDNA, name: 'Przyprawa' } },
    ],
  },
}

/** Domyślne odpowiedzi; `nadpisz` podmienia pojedyncze ścieżki (klucz `ścieżka` albo `ścieżka?zapytanie`). */
export function atrapaAllegro(nadpisz: Record<string, Odp> = {}): { get: AllegroGet; wywolania: string[] } {
  const wywolania: string[] = []
  const get = async <T,>(path: string, query: [string, string][]): Promise<AllegroResponse<T>> => {
    const qs = new URLSearchParams(query).toString()
    const klucz = qs ? `${path}?${qs}` : path
    wywolania.push(klucz)
    const o = nadpisz[klucz] ?? nadpisz[path] ?? domyslna(path, query)
    return { status: o.status, body: o.body as T, retryAfterMs: null }
  }
  return { get, wywolania }
}

function domyslna(path: string, query: [string, string][]): Odp {
  const q = Object.fromEntries(query)
  if (path === '/sale/products') {
    const b = PRODUKTY_PO_EAN[q['phrase'] ?? '']
    return b ? { status: 200, body: b } : { status: 200, body: { products: [] } }
  }
  if (path === '/sale/matching-categories') return { status: 200, body: DOPASOWANIA['domyslne'] }
  const par = /^\/sale\/categories\/([^/]+)\/parameters$/.exec(path)
  if (par) {
    if (par[1] === KAT_PRZYPRAWA) return { status: 200, body: PARAMETRY_PRZYPRAWY }
    if (par[1] === KAT_KUBKI) return { status: 200, body: PARAMETRY_KUBKOW }
    return { status: 404, body: null }
  }
  const kat = /^\/sale\/categories\/([^/]+)$/.exec(path)
  if (kat) {
    const b = kategorie[kat[1]!]
    return b ? { status: 200, body: b } : { status: 404, body: null }
  }
  return { status: 404, body: null }
}
