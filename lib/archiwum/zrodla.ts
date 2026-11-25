// etap 2: źródła archiwum poza Woo, na tym samym szkielecie importu (lib/archiwum/import.ts).
//   Allegro z API      `GET /order/checkout-forms` z filtrem daty zakupu (API trzyma 12 miesięcy wstecz);
//   Allegro ze zrzutu  plik JSON w kształcie API (formularze zakupu bez danych kupującego), dla dni, które wypadły
//                      z okna API; ten sam klucz wiersza co z API, więc zrzut i API się nie dublują;
//   Empik (Mirakl)     OR11 `GET /orders` z zakresem daty utworzenia (pełna historia);
//   EasyTools          plik JSON z `GET /orders` EasyTools bez e-maila klienta (Kompletor nie czyta API EasyTools:
//                      zamówienia przychodzą przez API zapisu Kompletora, `Order.externalId` = id zamówienia EasyTools).
// Kanały tylko czytane. Zakres dat pilnuje importer (zamówienie spoza [od, do) = „poza zakresem dat”), czytniki tylko
// zawężają odczyt.
import { idPola, type CzytajStrone, type StronaZamowien, type ZrodloArchiwum } from './import'
import { archiwumZAllegro, archiwumZEasyTools, archiwumZMirakl, bezDanychOsobowychAllegro, bezDanychOsobowychEasyTools, bezDanychOsobowychMirakl } from './kanaly'

export const ZRODLO_ALLEGRO_API = 'ALLEGRO_API'
export const ZRODLO_ALLEGRO_ZRZUT = 'ALLEGRO_ZRZUT'
export const ZRODLO_MIRAKL = 'MIRAKL_API'
export const ZRODLO_EASYTOOLS = 'EASYTOOLS_API'

/** Allegro przyjmuje offset + limit najwyżej 10 000 (`/order/checkout-forms`). */
export const ALLEGRO_MAKS_OFFSET = 10_000
const PLIK_NA_STRONE = 500

const sekunda = (d: Date, delta: number) => new Date(d.getTime() + delta * 1000).toISOString()
const lista = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
const stronZ = (razem: number | null, naStrone: number) => (razem === null ? null : Math.max(1, Math.ceil(razem / naStrone)))

export type AllegroGetListy = (query: [string, string][]) => Promise<{ checkoutForms: unknown[]; totalCount: number | null }>
export type MiraklGetListy = (query: Record<string, string | number>) => Promise<{ orders: unknown[]; totalCount: number | null }>

export function zapytanieStronyAllegro(q: { od: Date; do: Date; strona: number; naStrone: number }): [string, string][] {
  const offset = (q.strona - 1) * q.naStrone
  if (offset + q.naStrone > ALLEGRO_MAKS_OFFSET) throw new Error(`Allegro: ponad ${ALLEGRO_MAKS_OFFSET} zamówień w zakresie, podziel zakres dat (np. po miesiącu)`)
  return [
    ['lineItems.boughtAt.gte', sekunda(q.od, -1)],
    ['lineItems.boughtAt.lte', sekunda(q.do, 1)],
    ['sort', 'lineItems.boughtAt'],
    ['limit', String(q.naStrone)],
    ['offset', String(offset)],
  ]
}

export function czytnikAllegro(get: AllegroGetListy): CzytajStrone {
  return async (q) => {
    const r = await get(zapytanieStronyAllegro(q))
    return { zamowienia: lista(r.checkoutForms), razem: r.totalCount, stron: stronZ(r.totalCount, q.naStrone) }
  }
}

export function zapytanieStronyMirakl(q: { od: Date; do: Date; strona: number; naStrone: number }): Record<string, string | number> {
  return { start_date: sekunda(q.od, -1), end_date: sekunda(q.do, 1), sort: 'dateCreated', order: 'asc', max: q.naStrone, offset: (q.strona - 1) * q.naStrone }
}

export function czytnikMirakl(get: MiraklGetListy): CzytajStrone {
  return async (q) => {
    const r = await get(zapytanieStronyMirakl(q))
    return { zamowienia: lista(r.orders), razem: r.totalCount, stron: stronZ(r.totalCount, q.naStrone) }
  }
}

/**
 * Zamówienia z pliku JSON: lista albo obiekt z listą w `checkoutForms` (zrzut Allegro), `orders` albo `items`.
 * Nieczytelny plik = błąd (nic się nie importuje).
 */
export function zamowieniaZPliku(tekst: string): Record<string, unknown>[] {
  let d: unknown
  try {
    d = JSON.parse(tekst)
  } catch {
    throw new Error('plik zamówień: to nie jest JSON')
  }
  const surowa = Array.isArray(d) ? d : d && typeof d === 'object' ? ((d as Record<string, unknown>)['checkoutForms'] ?? (d as Record<string, unknown>)['orders'] ?? (d as Record<string, unknown>)['items']) : null
  if (!Array.isArray(surowa)) throw new Error('plik zamówień: brak listy (oczekiwana lista albo pole checkoutForms / orders / items)')
  return lista(surowa)
}

/** Czytnik stron z listy w pamięci (plik); zakres dat filtruje importer. */
export function czytnikListy(zamowienia: readonly Record<string, unknown>[]): CzytajStrone {
  return async (q): Promise<StronaZamowien> => {
    const od = (q.strona - 1) * q.naStrone
    return { zamowienia: zamowienia.slice(od, od + q.naStrone), razem: zamowienia.length, stron: stronZ(zamowienia.length, q.naStrone) }
  }
}

export function zrodloAllegroApi(czytaj: CzytajStrone): ZrodloArchiwum {
  return { channel: 'ALLEGRO', source: ZRODLO_ALLEGRO_API, runKind: 'archiwum-allegro', etykieta: 'Allegro (API)', czytaj, oczysc: bezDanychOsobowychAllegro, mapuj: archiwumZAllegro, idSurowe: idPola('id'), rewizjaCzasem: true }
}

export function zrodloAllegroZrzut(zamowienia: readonly Record<string, unknown>[]): ZrodloArchiwum {
  return {
    channel: 'ALLEGRO',
    source: ZRODLO_ALLEGRO_ZRZUT,
    runKind: 'archiwum-allegro-zrzut',
    etykieta: 'Allegro (zrzut)',
    czytaj: czytnikListy(zamowienia),
    oczysc: bezDanychOsobowychAllegro,
    mapuj: archiwumZAllegro,
    idSurowe: idPola('id'),
    maksNaStrone: PLIK_NA_STRONE,
    rewizjaCzasem: true,
  }
}

export function zrodloEmpik(czytaj: CzytajStrone): ZrodloArchiwum {
  return { channel: 'EMPIK', source: ZRODLO_MIRAKL, runKind: 'archiwum-empik', etykieta: 'Empik', czytaj, oczysc: bezDanychOsobowychMirakl, mapuj: archiwumZMirakl, idSurowe: idPola('order_id'), rewizjaCzasem: true }
}

export function zrodloEasyTools(zamowienia: readonly Record<string, unknown>[]): ZrodloArchiwum {
  return {
    channel: 'EASYTOOLS',
    source: ZRODLO_EASYTOOLS,
    runKind: 'archiwum-easytools',
    etykieta: 'EasyTools',
    czytaj: czytnikListy(zamowienia),
    oczysc: bezDanychOsobowychEasyTools,
    mapuj: archiwumZEasyTools,
    idSurowe: idPola('id'),
    maksNaStrone: PLIK_NA_STRONE,
  }
}
