// odczyt listy zamówień Woo do archiwum (tylko GET /orders). Zakres po dacie złożenia w UTC
// (`dates_are_gmt`), od najstarszych, wszystkie statusy, `_fields` bez danych klienta (lib/archiwum/woo.ts).
// Granice o sekundę szersze niż zakres (sklep porównuje `after`/`before` ostro); dokładny zakres pilnuje importer.
import type { WooResponse } from '../zrodla/woo'
import type { CzytajStroneWoo } from './import'
import { POLA_ZAMOWIENIA_WOO } from './woo'

export type WooGetZamowien = (query: Record<string, string | number | boolean>) => Promise<WooResponse<unknown>>

export function zapytanieStronyWoo(q: { od: Date; do: Date; strona: number; naStrone: number }): Record<string, string | number | boolean> {
  return {
    after: new Date(q.od.getTime() - 1000).toISOString().slice(0, 19),
    before: new Date(q.do.getTime() + 1000).toISOString().slice(0, 19),
    dates_are_gmt: true,
    status: 'any',
    orderby: 'date',
    order: 'asc',
    per_page: q.naStrone,
    page: q.strona,
    _fields: POLA_ZAMOWIENIA_WOO,
  }
}

/** Czytnik stron dla importera z funkcji GET listy zamówień (adapter konta albo klient tylko do odczytu). */
export function czytnikWoo(get: WooGetZamowien): CzytajStroneWoo {
  return async (q) => {
    const r = await get(zapytanieStronyWoo(q))
    if (r.body === null) return { zamowienia: [], razem: r.total, stron: r.totalPages }
    if (!Array.isArray(r.body)) throw new Error('Woo /orders: odpowiedź nie jest listą')
    const zamowienia = (r.body as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    return { zamowienia, razem: r.total, stron: r.totalPages }
  }
}
