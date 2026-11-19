// Wysyłam z Allegro: strażnik TYLKO DO ODCZYTU dla zasobów `/shipment-management`. Żądania idą przez
// istniejący klient `AllegroReadOnly` (lib/zrodla/allegro.ts), który i tak odmawia innych metod niż GET; tu dochodzi
// zamknięta lista ścieżek. Tworzenie i anulowanie przesyłek, odbiory, etykiety, protokoły i przestarzałe
// `delivery-services` kończą się wyjątkiem jeszcze przed wysyłką. Bez logowania treści odpowiedzi (`delivery-proposals`
// niesie w `suggestedInput` nadawcę i odbiorcę, czyli dane osobowe).
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

/** Jedyne dozwolone ścieżki: propozycje dostawy zamówienia i szczegóły przesyłki. Bez zapytania, bez `..`. */
const READ_ONLY_PATHS = [new RegExp(`^/shipment-management/delivery-proposals/${UUID}$`), new RegExp(`^/shipment-management/shipments/${UUID}$`)] as const

export function assertAllegroWysylamReadOnly(path: string, method = 'GET'): void {
  if (method !== 'GET') throw new ReadOnlyViolation(`Wysyłam z Allegro: metoda ${method} nie jest odczytem (tryb „przygotuj, nie wysyłaj”)`)
  if (typeof path !== 'string' || path.includes('..') || path.includes('?') || path.includes('#') || !READ_ONLY_PATHS.some((re) => re.test(path))) {
    // ścieżka bez wartości: może nieść identyfikatory, a komunikat trafia do logów
    throw new ReadOnlyViolation('Wysyłam z Allegro: ścieżka spoza listy odczytu (tylko delivery-proposals/{id} i shipments/{id})')
  }
}

const PRZEWOZNIK_RE = /^[A-Z0-9_]{1,32}$/
const NUMER_NADANIA_RE = /^[A-Za-z0-9-]{4,64}$/

/**
 * Historia statusów przesyłki: `GET /order/carriers/{carrierId}/tracking?waybill=…` (poradnik Allegro „Jak zarządzać
 * przesyłkami przez Wysyłam z Allegro”: `carrierId` = pole `carrier` szczegółów przesyłki, numer z
 * `packages[].waybill`). Jeden numer na żądanie, oba identyfikatory sprawdzone wzorcem przed wysyłką.
 */
export async function getAllegroTracking<T>(api: AllegroReadOnly, carrierId: string, waybill: string, accessToken: string): Promise<AllegroResponse<T>> {
  if (!PRZEWOZNIK_RE.test(carrierId) || !NUMER_NADANIA_RE.test(waybill)) throw new ReadOnlyViolation('Wysyłam z Allegro: zły przewoźnik albo numer nadania do śledzenia')
  return api.get<T>(`/order/carriers/${carrierId}/tracking`, [['waybill', waybill]], accessToken)
}

/** Odczyt `/shipment-management` przez `AllegroReadOnly`: zawsze GET, bez parametrów zapytania, po strażniku. */
export async function getAllegroShipments<T>(api: AllegroReadOnly, path: string, accessToken: string): Promise<AllegroResponse<T>> {
  assertAllegroWysylamReadOnly(path)
  return api.get<T>(path, [], accessToken)
}
