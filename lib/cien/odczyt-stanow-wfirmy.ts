// adapter odczytu stanów wFirmy dla kolejki wywołań (`OdczytStanowWfirma`, lib/rdzen/kolejka-wfirmy.ts).
// TYLKO ODCZYT: każde wywołanie idzie przez `WfirmaReadOnly.call` (strażnik `assertWfirmaReadOnly`: wyłącznie `*/find`
// i `*/get/<id>`), a adapter woła wyłącznie `goods/find`. Ten sam klucz API wystawia faktury w BL, więc:
//   - limit wFirmy (HTTP 429, kod z „LIMIT”) zamieniamy na `WfirmaLimitError` — tylko na niego kolejka wstrzymuje CAŁĄ
//     firmę (`pausedUntil`); każde kolejne żądanie w trakcie blokady mogłoby ją przedłużyć;
//   - jedno wywołanie `readGoods` = jedno żądanie (partia do 20 towarów), żeby budżet kolejki (`maxCalls`) odpowiadał
//     liczbie żądań do wFirmy.
// Spec 8.1: stan tylko z magazynu skonfigurowanego (`Warehouse.wfirmaWarehouseId`), z jawnym `warehouse_id` w zapytaniu.
// Warunek magazynu idzie w `parameters.conditions`, a pozycje z innego magazynu odrzucamy dodatkowo po stronie klienta
// (jak import, lib/import/pobieranie.ts) — gdyby wFirma pominęła warunek, pozycja z innego magazynu nigdy nie trafi do
// wyniku.
//
// DO POTWIERDZENIA NA ŻYWO przy pierwszym przebiegu (jak nazwy warunków w faktury-bl.ts): nazwa pola magazynu
// w warunku (`warehouse_id`) i operator listy dla id (`in` z wartościami po przecinku). Atrapa w testach przyjmuje ten
// sam kształt. Gdyby wFirma zignorowała warunek id i zwróciła inne towary, `readGoods` kończy się błędem (nie cichym
// „brakiem towaru”), bo wtedy kolejka zamykałaby zdarzenia z alertami WFIRMA_BRAK_TOWARU dla towarów, które istnieją.
import { wfGoodFromApi } from '../import/normalizacja'
import type { GoodCount, OdczytStanowWfirma } from '../rdzen/kolejka-wfirmy'
import { WfirmaLimitError } from '../rdzen/rozchod'
import { SourceError } from '../zrodla/http'
import { type WfirmaReadOnly, wfirmaItems } from '../zrodla/wfirma'

/** Rozmiar strony pełnego odczytu (jak import: `limit: 100`, ostatnia strona = mniej niż 100 pozycji). */
export const GOODS_PAGE_SIZE = 100
/** Pole warunku magazynu w `goods/find` (do potwierdzenia na żywo, patrz komentarz na górze). */
export const WAREHOUSE_FIELD = 'warehouse_id'
/** Partia `readGoods` — kolejka woła po 20 (READ_BATCH), tu górna granica na wypadek innego wołającego. */
const MAX_IDS_PER_CALL = 100

type Condition = { condition: { field: string; operator: string; value: string } }
const cond = (field: string, operator: string, value: string): Condition => ({ condition: { field, operator, value } })

/** Limit wFirmy: `WfirmaReadOnly` rzuca `SourceError` z „limit” w treści (HTTP 429 albo kod statusu z LIMIT). */
export function isWfirmaLimit(e: unknown): boolean {
  return e instanceof SourceError && /limit/i.test(e.message)
}

/** „AUTH FAILED LIMIT WAIT 5 MINUTES” → 5 min; brak liczby = domyślna pauza kolejki (LIMIT_PAUSE_MS). */
export function limitWaitMs(message: string): number | undefined {
  const m = /WAIT\s+(\d+)\s+MINUTE/i.exec(message)
  return m ? Number(m[1]) * 60_000 : undefined
}

export interface OdczytStanowStats {
  /** pozycje odrzucone, bo przyszły z innego magazynu niż zapytany */
  otherWarehouse: number
  /** pozycje bez czytelnego `count` (pominięte — kolejka potraktuje je jak brak w odpowiedzi) */
  unreadable: number
  /** żądania do wFirmy wysłane przez adapter */
  requests: number
}

export class WfirmaStockReader implements OdczytStanowWfirma {
  readonly stats: OdczytStanowStats = { otherWarehouse: 0, unreadable: 0, requests: 0 }

  constructor(private readonly wf: Pick<WfirmaReadOnly, 'call'>) {}

  async readGoodsPage(page: number, warehouseId: string): Promise<{ items: GoodCount[]; last: boolean }> {
    if (!Number.isInteger(page) || page < 1) throw new Error(`wFirma goods/find: zła strona ${page}`)
    const raw = await this.find({
      page,
      limit: GOODS_PAGE_SIZE,
      // stabilne sortowanie po id dla pełnego odczytu stronami (spec 2.2 pkt 4), jak import
      order: { asc: 'id' },
      conditions: cond(WAREHOUSE_FIELD, 'eq', warehouseId),
    })
    // `last` z liczby pozycji w odpowiedzi PRZED odrzuceniem innych magazynów: gdyby wFirma zignorowała warunek
    // magazynu, strona ze 100 pozycjami (część z innego magazynu) nie może udawać ostatniej
    return { items: this.counts(raw, warehouseId), last: raw.length < GOODS_PAGE_SIZE }
  }

  async readGoods(goodIds: string[], warehouseId: string): Promise<GoodCount[]> {
    const ids = [...new Set(goodIds)]
    if (!ids.length) return []
    if (ids.length > MAX_IDS_PER_CALL) throw new Error(`wFirma goods/find: najwyżej ${MAX_IDS_PER_CALL} towarów w jednym żądaniu (jest ${ids.length})`)
    for (const id of ids) if (!/^\d+$/.test(id)) throw new Error(`wFirma goods/find: zły id towaru „${id}”`)
    // jedno żądanie na partię: warunek magazynu ORAZ id z listy (operator `in`, wartości po przecinku)
    const raw = await this.find({
      page: 1,
      limit: Math.max(ids.length, 1),
      order: { asc: 'id' },
      conditions: { and: [cond(WAREHOUSE_FIELD, 'eq', warehouseId), cond('id', 'in', ids.join(','))] },
    })
    const wanted = new Set(ids)
    const foreign = raw.map((r) => String(r['id'] ?? '')).filter((id) => !wanted.has(id))
    if (foreign.length)
      throw new Error(`wFirma goods/find: odpowiedź zawiera towary spoza zapytania (${foreign.slice(0, 5).join(', ')}) — warunek id nie działa, odczyt celowany wstrzymany do poprawy adaptera`)
    // brak towaru w odpowiedzi = brak w wyniku (kolejka liczy próby i daje alert WFIRMA_BRAK_TOWARU)
    return this.counts(raw, warehouseId)
  }

  private async find(parameters: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    this.stats.requests++
    let r: { goods?: unknown }
    try {
      r = await this.wf.call<{ goods?: unknown }>('goods/find', { api: { goods: { parameters } } })
    } catch (e) {
      if (isWfirmaLimit(e)) {
        const message = (e as Error).message
        throw new WfirmaLimitError(`odczyt stanów wFirmy: ${message}`, limitWaitMs(message))
      }
      throw e
    }
    return wfirmaItems<Record<string, unknown>>(r.goods, 'good')
  }

  /** Pozycje → `count` w jednostce wFirmy, tylko z zapytanego magazynu (parsowanie jak import: `wfGoodFromApi`). */
  private counts(raw: Record<string, unknown>[], warehouseId: string): GoodCount[] {
    const out: GoodCount[] = []
    for (const r of raw) {
      const g = wfGoodFromApi(r, new Map())
      if (g.warehouseId !== warehouseId) {
        this.stats.otherWarehouse++
        continue
      }
      // ujemny stan przechodzi dalej: lustro odrzuci go z błędem zapisu (widocznym), a nie jako „brak towaru”
      if (g.count === null) {
        this.stats.unreadable++
        continue
      }
      out.push({ wfirmaGoodId: g.id, count: g.count })
    }
    return out
  }
}
