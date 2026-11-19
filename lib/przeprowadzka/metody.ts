// Przeprowadzka z BaseLinkera: DOKŁADNA lista metod BL, których używa przeprowadzka. Każda inna metoda —
// także odczyty z danymi klientów (getOrdersByEmail, getOrdersByPhone, getCrmClients…), etykiety i pliki faktur —
// jest odrzucana, zanim zapytanie wyjdzie z procesu. Metody zapisu odrzuca dodatkowo `assertBlReadOnly` (tylko get*),
// którego ta lista nie luzuje: klient przeprowadzki dziedziczy z `BaseLinkerReadOnly` i woła jego `call` dopiero po
// sprawdzeniu własnej listy.
//
// Nazwy metod: lista metod https://api.baselinker.com/ (sprawdzona 02.11.2026). Kształt odpowiedzi każdej metody,
// której repo wcześniej nie używało, jest oznaczony [NIEPEWNE] w miejscu odczytu (rozpoznanie.ts, zamowienia.ts) —
// do potwierdzenia na prawdziwym koncie BL.
import { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { ReadOnlyViolation, type FetchLike } from '../zrodla/http'

export const METODY_PRZEPROWADZKI = [
  'getInventories',
  'getInventoryWarehouses',
  'getInventoryPriceGroups',
  'getInventoryCategories',
  'getInventoryManufacturers',
  'getInventoryIntegrations',
  'getInventoryProductsList',
  'getInventoryProductsData',
  'getInventoryProductsStock',
  'getInventoryProductsPrices',
  'getExternalStoragesList',
  'getExternalStorageProductsList',
  'getExternalStorageProductsData',
  'getOrderSources',
  'getOrderStatusList',
  'getOrderStatusGroups',
  'getOrderExtraFields',
  'getOrders',
  'getCourierAccounts',
  'getCouriersList',
  'getSeries',
] as const

export type MetodaPrzeprowadzki = (typeof METODY_PRZEPROWADZKI)[number]

const DOZWOLONE: ReadonlySet<string> = new Set(METODY_PRZEPROWADZKI)

export class MetodaSpozaListy extends ReadOnlyViolation {
  constructor(method: string) {
    super(`BaseLinker: metoda „${method}” spoza listy przeprowadzki (lib/przeprowadzka/metody.ts) — odmowa`)
    this.name = 'MetodaSpozaListy'
  }
}

export function assertMetodaPrzeprowadzki(method: string): asserts method is MetodaPrzeprowadzki {
  if (!DOZWOLONE.has(method)) throw new MetodaSpozaListy(method)
}

/**
 * Klient BL przeprowadzki: tylko metody z listy, a pod spodem i tak tylko odczyt (`BaseLinkerReadOnly`). Dziedziczy po
 * kliencie tylko-do-odczytu, więc funkcje importu katalogu (`fetchBlCatalog`, `fetchShopOffers`) przyjmują go bez
 * zmian, a każde ich wywołanie przechodzi przez listę. `wywolania` liczy metody (do raportu i testów), bez parametrów.
 */
export class BlPrzeprowadzka extends BaseLinkerReadOnly {
  readonly wywolania = new Map<string, number>()

  constructor(token: string, fetchImpl: FetchLike = fetch, minIntervalMs?: number) {
    super(token, fetchImpl, minIntervalMs)
  }

  override async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    assertMetodaPrzeprowadzki(method)
    this.wywolania.set(method, (this.wywolania.get(method) ?? 0) + 1)
    return super.call<T>(method, params)
  }
}
