// Wysyłam z Allegro: strażnik TYLKO DO ODCZYTU dla zasobów `/shipment-management`. Żądania idą przez
// istniejący klient `AllegroReadOnly` (lib/zrodla/allegro.ts), który i tak odmawia innych metod niż GET; tu dochodzi
// zamknięta lista ścieżek. Tworzenie i anulowanie przesyłek, odbiory, etykiety, protokoły i przestarzałe
// `delivery-services` kończą się wyjątkiem jeszcze przed wysyłką. Bez logowania treści odpowiedzi (`delivery-proposals`
// niesie w `suggestedInput` nadawcę i odbiorcę, czyli dane osobowe).
// do listy doszła historia statusów przesyłki (`GET /order/carriers/{carrierId}/tracking?waybill=…`), jedyna
// ścieżka z parametrem zapytania: wyłącznie `waybill` (1–20 numerów, litery, cyfry i myślnik).
import { type AllegroReadOnly, type AllegroResponse } from './allegro'
import { ReadOnlyViolation } from './http'

/** Odczyt przesyłek: o ten zakres prosi `allegro-autoryzuj --z-przesylkami` (test połączenia). */
export const ALLEGRO_SHIPMENTS_READ_SCOPE = 'allegro:api:shipments:read'
/**
 * Zapis przesyłek, a w specyfikacji także odczyt `delivery-proposals`. NIGDZIE o niego nie prosimy: to osobna decyzja
 * właściciela konta (docs/wysylam-z-allegro.md). Stała tylko do komunikatów i dokumentacji.
 */
export const ALLEGRO_SHIPMENTS_WRITE_SCOPE = 'allegro:api:shipments:write'

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

/** Identyfikator przewoźnika Allegro (pole `carrier` przesyłki, np. `ALLEGRO`): wchodzi do ścieżki, więc wąsko. */
export const ALLEGRO_CARRIER_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
/** Numer nadania (`packages[].waybill`): wchodzi do zapytania śledzenia. */
export const ALLEGRO_WAYBILL_RE = /^[A-Za-z0-9-]{4,64}$/
/** Allegro przyjmuje najwyżej 20 numerów w jednym zapytaniu śledzenia (swagger: `maxItems: 20`). */
export const ALLEGRO_TRACKING_MAX_WAYBILLS = 20

/** Identyfikator odbioru w Allegro (`pickupId` z wyniku komendy odbioru): wchodzi do ścieżki, więc wąsko. */
export const ALLEGRO_PICKUP_ID_RE = /^[A-Za-z0-9-]{1,64}$/
/**
 * Jedyne dozwolone ścieżki: propozycje dostawy zamówienia, szczegóły przesyłki, szczegóły zamówionego odbioru (które
 * przesyłki obejmuje) i historia statusów. Bez `..`.
 */
const READ_ONLY_PATHS = [
  new RegExp(`^/shipment-management/delivery-proposals/${UUID}$`),
  new RegExp(`^/shipment-management/shipments/${UUID}$`),
  /^\/shipment-management\/pickups\/(?!create-commands$)[A-Za-z0-9-]{1,64}$/,
] as const
const TRACKING_PATH = /^\/order\/carriers\/[A-Za-z0-9_-]{1,40}\/tracking$/

export function assertAllegroWysylamReadOnly(path: string, method = 'GET', query: readonly [string, string][] = []): void {
  if (method !== 'GET') throw new ReadOnlyViolation(`Wysyłam z Allegro: metoda ${method} nie jest odczytem (tryb „przygotuj, nie wysyłaj”)`)
  const zla = typeof path !== 'string' || path.includes('..') || path.includes('?') || path.includes('#')
  // ścieżka bez wartości: może nieść identyfikatory, a komunikat trafia do logów
  const odmowa = () => new ReadOnlyViolation('Wysyłam z Allegro: ścieżka spoza listy odczytu (tylko delivery-proposals/{id}, shipments/{id}, pickups/{id} i carriers/{id}/tracking)')
  if (zla) throw odmowa()
  if (TRACKING_PATH.test(path)) {
    const ok = query.length >= 1 && query.length <= ALLEGRO_TRACKING_MAX_WAYBILLS && query.every(([k, v]) => k === 'waybill' && ALLEGRO_WAYBILL_RE.test(v))
    if (!ok) throw new ReadOnlyViolation('Wysyłam z Allegro: śledzenie przyjmuje tylko parametr waybill (1–20 numerów nadania)')
    return
  }
  if (query.length || !READ_ONLY_PATHS.some((re) => re.test(path))) throw odmowa()
}

/** Odczyt `/shipment-management` (i śledzenia) przez `AllegroReadOnly`: zawsze GET, po strażniku. */
export async function getAllegroShipments<T>(api: AllegroReadOnly, path: string, accessToken: string, query: readonly [string, string][] = []): Promise<AllegroResponse<T>> {
  assertAllegroWysylamReadOnly(path, 'GET', query)
  return api.get<T>(path, [...query], accessToken)
}
