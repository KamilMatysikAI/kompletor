// Adapter przewoźnika `basecourier.v1`: InPost, DPD i DPD do salonu Empik przez Base Courier, w trybie
// „przygotuj, nie wysyłaj”. Liczy parametry przesyłki (lib/wysylka/przesylka.ts) i sprawdza połączenie. Przesyłek nie
// tworzy: klient HTTP odmawia `createOrderV2.json`, `cancelOrder.json` i `getWaybill.json`. Dane odbiorcy tu nie wchodzą.
import { BASE_COURIER_URL_RE, BaseCourierReadOnly } from '../zrodla/basecourier'
import { COURIER_CODES, ustawieniaPrzesylki, wyliczPrzesylke, type UstawieniaPrzesylki } from '../wysylka/przesylka'
import type { AdapterContext, AdapterDefinition, AdapterManifest, ChannelAdapter, ConnectionTest, PreparedParcel, ShipmentInput, ShipmentPreparer } from './kontrakt'

export const BASE_COURIER_KEY = 'basecourier.v1'

export const BASE_COURIER_MANIFEST: AdapterManifest = {
  adapterKey: BASE_COURIER_KEY,
  version: '1.0.0',
  displayName: 'Base Courier (InPost, DPD)',
  kind: 'carrier',
  capabilities: ['shipment.prepare'],
  // limitów API nie ma w dokumentacji: ostrożnie, adapter woła tylko test połączenia
  rateLimit: { requestsPerMinute: 30, maxConcurrent: 1, minPollIntervalMs: 0 },
  config: [
    { key: 'baseUrl', type: 'string', required: true, description: 'adres API: https://api.blpaczka.com/api (albo https://api.basecourier.com/api), sandbox https://sandbox.basecourier.com/api', pattern: BASE_COURIER_URL_RE, envSuffix: 'BASE_URL' },
    { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env (np. BASE_COURIER)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
    { key: 'courierCode', type: 'string', required: false, description: 'kod kuriera Base Courier, gdy inny niż domyślny dla przewoźnika', pattern: new RegExp(`^(${COURIER_CODES.join('|')})$`) },
    { key: 'defaultSideXCm', type: 'number', required: false, description: 'domyślna długość paczki DPD w cm' },
    { key: 'defaultSideYCm', type: 'number', required: false, description: 'domyślna szerokość paczki DPD w cm' },
    { key: 'defaultSideZCm', type: 'number', required: false, description: 'domyślna wysokość paczki DPD w cm' },
    { key: 'defaultWeightKg', type: 'number', required: false, description: 'waga paczki w kg, gdy produkty nie mają wagi' },
  ],
  secrets: [
    { name: 'BASE_COURIER_LOGIN', required: true, description: 'e-mail konta Base Courier', envSuffix: 'LOGIN' },
    { name: 'BASE_COURIER_API_KEY', required: true, description: 'klucz API konta (panel Base Courier, Konfiguracja API)', envSuffix: 'API_KEY' },
  ],
  readOnly: true,
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Kształt odpowiedzi nie jest potwierdzony: odmowa albo pusta odpowiedź to brak połączenia, treści nie przepisujemy. */
function profileProblem(r: unknown): string | null {
  if (!isRecord(r) || Object.keys(r).length === 0) return 'nieczytelna odpowiedź getProfile'
  if (r['success'] === false || r['status'] === false || r['status'] === 'error' || r['error'] || r['errors']) return 'Base Courier odrzucił zapytanie o profil'
  return null
}

class BaseCourierAdapter implements ChannelAdapter, ShipmentPreparer {
  readonly manifest = BASE_COURIER_MANIFEST
  private readonly api: BaseCourierReadOnly
  private readonly ustawienia: UstawieniaPrzesylki

  constructor(ctx: AdapterContext) {
    this.api = new BaseCourierReadOnly(String(ctx.config['baseUrl']), ctx.secrets['BASE_COURIER_LOGIN']!, ctx.secrets['BASE_COURIER_API_KEY']!, ctx.fetch, ctx.http?.minIntervalMs, ctx.http?.retry)
    this.ustawienia = ustawieniaPrzesylki(ctx.config)
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const problem = profileProblem(await this.api.post('getProfile.json'))
      return problem ? { ok: false, message: problem } : { ok: true, message: 'odczyt profilu konta działa' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return wyliczPrzesylke(input, this.ustawienia)
  }
}

export const BASE_COURIER_DEFINITION: AdapterDefinition = { manifest: BASE_COURIER_MANIFEST, create: (ctx) => new BaseCourierAdapter(ctx) }
