// Adapter przewoźnika `allegro.wysylam.v1`: Wysyłam z Allegro w trybie „przygotuj, nie wysyłaj”. Liczy
// parametry przesyłki (lib/wysylka/allegro.ts), sprawdza zakres przesyłek i umie odczytać propozycje dostawy. Przesyłek
// nie tworzy: strażnik (lib/zrodla/allegro-wysylam.ts) przepuszcza tylko GET `delivery-proposals/{id}` i `shipments/{id}`.
//
// Tokeny: TA SAMA para co `allegro.v1` na tym samym koncie (refresh token Allegro jest jednorazowy, więc druga para by
// się gryzła). Odświeżenie przez `AllegroTokens` z adaptera kanału i rotację hosta pod blokadą konta
// (`accountSecretRotator` w lib/wysylka/allegro-konto.ts): dwa adaptery z wygasłym tokenem robią jedno odświeżenie.
// Dane odbiorcy tu nie wchodzą: `suggestedInput` z `delivery-proposals` odrzuca parser.
import { ALLEGRO_WYSYLAM_KEY } from '../adaptery'
import { ALLEGRO_API_URL, ALLEGRO_AUTH_URL, AllegroReadOnly, type AllegroResponse } from '../zrodla/allegro'
import { ALLEGRO_SHIPMENTS_READ_SCOPE, getAllegroShipments } from '../zrodla/allegro-wysylam'
import type { FetchLike } from '../zrodla/http'
import { parseDeliveryOptions, wyliczPrzesylkeAllegro, type AllegroDeliveryOption } from '../wysylka/allegro'
import { ustawieniaPrzesylki, type UstawieniaPrzesylki } from '../wysylka/przesylka'
import { ALLEGRO_MANIFEST, ALLEGRO_SECRETS as S, AllegroAccountError, AllegroTokens, toAdapterError } from './allegro'
import { AdapterError, type AdapterContext, type AdapterDefinition, type AdapterManifest, type ChannelAdapter, type ConnectionTest, type PreparedParcel, type ShipmentInput, type ShipmentPreparer } from './kontrakt'

// Stała klucza żyje w lib/adaptery.ts (czysty moduł bez OAuth), żeby podgląd karty zamówienia nie wciągał adaptera.
export { ALLEGRO_WYSYLAM_KEY }

/** UUID spoza zakresu Allegro: test zakresu odczytu przesyłek bez czytania prawdziwej przesyłki. */
export const PROBE_SHIPMENT_ID = '00000000-0000-4000-8000-000000000000'

const AUTH_HINT = `„Połącz ponownie z Allegro” z zaznaczonym „Odczyt przesyłek” na ekranie konta (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto Allegro; zakres ${ALLEGRO_SHIPMENTS_READ_SCOPE})`

export const ALLEGRO_WYSYLAM_MANIFEST: AdapterManifest = {
  adapterKey: ALLEGRO_WYSYLAM_KEY,
  version: '1.0.0',
  displayName: 'Wysyłam z Allegro (przesyłki Allegro)',
  kind: 'carrier',
  capabilities: ['shipment.prepare'],
  // wspólny limit z `allegro.v1` na Client ID; adapter woła tylko test połączenia i propozycje dostawy
  rateLimit: { requestsPerMinute: 60, maxConcurrent: 1, minPollIntervalMs: 0 },
  // jak ALLEGRO_MANIFEST (to samo konto i te same ustawienia), bez częstotliwości dziennika, z wagą domyślną
  config: [
    ...ALLEGRO_MANIFEST.config.filter((f) => f.key !== 'pollIntervalSec'),
    { key: 'defaultWeightKg', type: 'number', required: false, description: 'waga paczki w kg, gdy produkty nie mają wagi (tylko prepareShipment adaptera; podgląd na karcie zamówienia bierze wagę z reguły przewoźnika)' },
  ],
  secrets: ALLEGRO_MANIFEST.secrets,
  readOnly: true,
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Ścieżka do komunikatów bez identyfikatorów (id przesyłki, przewoźnik). */
const etykietaSciezki = (path: string) => path.replace(/[0-9a-fA-F-]{36}$/, '{id}').replace(/^\/order\/carriers\/[^/]+\/tracking$/, '/order/carriers/{id}/tracking')

export class AllegroWysylamAdapter implements ChannelAdapter, ShipmentPreparer {
  readonly manifest: AdapterManifest
  protected readonly api: AllegroReadOnly
  protected readonly tokens: AllegroTokens
  protected readonly ustawienia: UstawieniaPrzesylki

  constructor(
    protected readonly ctx: AdapterContext,
    manifest: AdapterManifest = ALLEGRO_WYSYLAM_MANIFEST,
  ) {
    this.manifest = manifest
    const userAgent = String(ctx.config['userAgent'])
    this.api = new AllegroReadOnly(String(ctx.config['apiUrl'] ?? ALLEGRO_API_URL), userAgent, ctx.fetch as FetchLike, ctx.http?.minIntervalMs, ctx.http?.retry)
    this.tokens = new AllegroTokens(ctx, {
      authUrl: String(ctx.config['authUrl'] ?? ALLEGRO_AUTH_URL),
      clientId: ctx.secrets[S.clientId]!,
      clientSecret: ctx.secrets[S.clientSecret]!,
      userAgent,
      fetch: ctx.fetch as FetchLike,
      now: ctx.now,
    })
    this.ustawienia = ustawieniaPrzesylki(ctx.config)
  }

  /**
   * GET po strażniku: 401 → jedno odświeżenie i jedna powtórka (wzór `allegro.v1`); 401 po odświeżeniu = błąd konta;
   * 429 z `Retry-After`; 403 = brak zakresu przesyłek (nie `orders:read`). Reszta statusów do wołającego.
   */
  protected async call<T>(path: string, brakujacyZakres: string, query: readonly [string, string][] = []): Promise<AllegroResponse<T>> {
    const r = await this.odczyt<T>(path, query)
    if (r.status === 403) throw new AllegroAccountError(`Allegro ${etykietaSciezki(path)}: HTTP 403 — token bez zakresu przesyłek (${brakujacyZakres}); zakres odczytu zamówień tu nie wystarcza`)
    return r
  }

  /**
   * GET po strażniku bez rozstrzygania 403: 401 → jedno odświeżenie i powtórka, 401 po odświeżeniu = błąd
   * konta, 429 = PRZEJSCIOWY. Reszta statusów (w tym 403) do wołającego.
   */
  protected async odczyt<T>(path: string, query: readonly [string, string][] = []): Promise<AllegroResponse<T>> {
    const get = async (token: string) => {
      try {
        return await getAllegroShipments<T>(this.api, path, token, query)
      } catch (e) {
        throw toAdapterError(e)
      }
    }
    const { token: used, refreshed } = await this.tokens.current()
    let r = await get(used)
    if (r.status === 401 && !refreshed) r = await get(await this.tokens.afterUnauthorized(used))
    const label = etykietaSciezki(path)
    if (r.status === 401) throw new AllegroAccountError(`Allegro ${label}: HTTP 401 także po odświeżeniu tokena — konto wymaga sprawdzenia autoryzacji`)
    if (r.status === 429) throw new AdapterError(`Allegro ${label}: HTTP 429 (limit zapytań)`, 'PRZEJSCIOWY', r.retryAfterMs ?? 60_000)
    return r
  }

  /**
   * Zakres odczytu przesyłek: `GET shipments/{UUID spoza zakresu}`. 404 albo 200 = zakres działa, 403 = brak zakresu.
   * NIEPEWNE: czy Allegro daje 404 dla nieistniejącego UUID przy samym zakresie odczytu (do potwierdzenia na żywo).
   */
  async testConnection(): Promise<ConnectionTest> {
    try {
      const r = await this.call(`/shipment-management/shipments/${PROBE_SHIPMENT_ID}`, ALLEGRO_SHIPMENTS_READ_SCOPE)
      if (r.status === 404 || (r.status >= 200 && r.status < 300)) return { ok: true, message: 'zakres przesyłek działa (odczyt przesyłek)' }
      return { ok: false, message: `Allegro /shipment-management/shipments/{id}: HTTP ${r.status}` }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false, message: e instanceof AllegroAccountError && /HTTP 403/.test(message) ? `${message}; ${AUTH_HINT}` : message }
    }
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return wyliczPrzesylkeAllegro(input, this.ustawienia)
  }

  /**
   * Opcje dostawy zamówienia (`delivery-proposals`), wyłącznie wynik parsera: `suggestedInput` z danymi nadawcy
   * i odbiorcy zostaje w tej metodzie. Wymaga zakresu `shipments:write`, o który dziś nikt nie prosi: metoda nie
   * jest podpięta do panelu. null = Allegro nie zna zamówienia (404).
   */
  async readDeliveryOptions(orderExternalId: string): Promise<AllegroDeliveryOption[] | null> {
    if (!UUID_RE.test(orderExternalId)) throw new AdapterError('zły numer formularza Allegro (oczekiwany UUID)', 'TRWALY')
    const r = await this.call<unknown>(`/shipment-management/delivery-proposals/${orderExternalId}`, 'zapis przesyłek: osobna decyzja właściciela konta, docs/wysylam-z-allegro.md')
    if (r.status === 404) return null
    if (r.status < 200 || r.status >= 300) throw new AdapterError(`Allegro /shipment-management/delivery-proposals/{id}: HTTP ${r.status}`, 'TRWALY')
    return parseDeliveryOptions(r.body)
  }
}

export const ALLEGRO_WYSYLAM_DEFINITION: AdapterDefinition = { manifest: ALLEGRO_WYSYLAM_MANIFEST, create: (ctx) => new AllegroWysylamAdapter(ctx) }
