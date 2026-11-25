// Adapter przewoźnika `inpost.shipx.v1`: paczkomat i kurier InPost bezpośrednio przez ShipX, w trybie
// „przygotuj, nie wysyłaj”. Liczy parametry przesyłki (lib/wysylka/inpost.ts) i sprawdza połączenie odczytem
// organizacji. Przesyłek nie tworzy: klient HTTP (lib/zrodla/inpost.ts) odmawia wszystkiego poza czterema odczytami.
// Zapis to osobny klucz `inpost.shipx.zapis.v1` (lib/adaptery/inpost-zapis.ts), za wyłącznikiem. Dane odbiorcy tu nie wchodzą.
import { INPOST_ID_RE, INPOST_URL_RE, InpostApiError, InpostReadOnly } from '../zrodla/inpost'
import { ustawieniaInpost, wyliczPrzesylkeInpost, type UstawieniaInpost } from '../wysylka/inpost'
import type { AdapterContext, AdapterDefinition, AdapterManifest, ChannelAdapter, ConfigField, ConnectionTest, PreparedParcel, ShipmentInput, ShipmentPreparer } from './kontrakt'

export const INPOST_SHIPX_KEY = 'inpost.shipx.v1'

/** Sposób nadania (`custom_attributes.sending_method`); lista wartości do potwierdzenia na sandboxie. */
export const SENDING_METHOD_RE = /^[a-z][a-z_]{1,40}$/
export const DOMYSLNY_SENDING_METHOD = 'dispatch_order'

/** Pola konfiguracji wspólne dla klucza odczytu i zapisu. */
export const INPOST_CONFIG: readonly ConfigField[] = [
  { key: 'baseUrl', type: 'string', required: true, description: 'adres API: https://api-shipx-pl.easypack24.net albo sandbox https://sandbox-api-shipx-pl.easypack24.net', pattern: INPOST_URL_RE, envSuffix: 'BASE_URL' },
  { key: 'organizationId', type: 'string', required: true, description: 'id organizacji w ShipX (Manager Paczek, ustawienia API)', pattern: INPOST_ID_RE, envSuffix: 'ORGANIZATION_ID', zKontaPrzewoznika: true },
  { key: 'sendingMethod', type: 'string', required: false, description: 'sposób nadania (domyślnie dispatch_order, czyli odbiór przez kuriera)', pattern: SENDING_METHOD_RE },
  { key: 'defaultSideXCm', type: 'number', required: false, description: 'domyślna długość paczki kurierskiej w cm' },
  { key: 'defaultSideYCm', type: 'number', required: false, description: 'domyślna szerokość paczki kurierskiej w cm' },
  { key: 'defaultSideZCm', type: 'number', required: false, description: 'domyślna wysokość paczki kurierskiej w cm' },
  { key: 'defaultWeightKg', type: 'number', required: false, description: 'waga paczki w kg, gdy produkty nie mają wagi' },
  { key: 'codLimit', type: 'number', required: false, description: 'najwyższa kwota pobrania w zł wg umowy z InPost' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env (np. INPOST)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
]

export const INPOST_SECRETS: AdapterManifest['secrets'] = [{ name: 'INPOST_TOKEN', required: true, description: 'token API ShipX (Manager Paczek, ustawienia API)', envSuffix: 'TOKEN' }]

export const INPOST_SHIPX_MANIFEST: AdapterManifest = {
  adapterKey: INPOST_SHIPX_KEY,
  version: '1.0.0',
  displayName: 'InPost ShipX (paczkomat, kurier)',
  kind: 'carrier',
  capabilities: ['shipment.prepare'],
  // limit API ShipX nie jest podany w dokumentacji: ostrożnie, adapter woła tylko test połączenia
  rateLimit: { requestsPerMinute: 60, maxConcurrent: 1, minPollIntervalMs: 0 },
  config: INPOST_CONFIG,
  secrets: INPOST_SECRETS,
  readOnly: true,
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Kształt odpowiedzi organizacji [NIEPEWNE]: pusta, inna organizacja albo bez id = brak połączenia. Nazwy nie przepisujemy. */
function organizationProblem(r: unknown, organizationId: string): string | null {
  if (!isRecord(r) || Object.keys(r).length === 0) return 'nieczytelna odpowiedź organizacji'
  const id = r['id']
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id) === '') return 'nieczytelna odpowiedź organizacji (bez id)'
  if (String(id) !== organizationId) return 'token należy do innej organizacji niż ustawiona'
  return null
}

/** Test połączenia wspólny dla obu kluczy: GET organizacji, wynik bez tokenu, nazwy i danych organizacji. */
export async function testInpostConnection(api: InpostReadOnly, organizationId: string): Promise<ConnectionTest> {
  try {
    const problem = organizationProblem(await api.get(`/v1/organizations/${organizationId}`), organizationId)
    return problem ? { ok: false, message: problem } : { ok: true, message: 'odczyt organizacji ShipX działa' }
  } catch (e) {
    if (e instanceof InpostApiError) return { ok: false, message: e.message, details: { rodzaj: e.kind, http: e.status } }
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export function inpostReadOnlyFromContext(ctx: AdapterContext): InpostReadOnly {
  return new InpostReadOnly(String(ctx.config['baseUrl']), ctx.secrets['INPOST_TOKEN']!, ctx.fetch, ctx.http?.minIntervalMs, ctx.http?.retry)
}

class InpostShipxAdapter implements ChannelAdapter, ShipmentPreparer {
  readonly manifest = INPOST_SHIPX_MANIFEST
  private readonly api: InpostReadOnly
  private readonly organizationId: string
  private readonly ustawienia: UstawieniaInpost

  constructor(ctx: AdapterContext) {
    this.api = inpostReadOnlyFromContext(ctx)
    this.organizationId = String(ctx.config['organizationId'])
    this.ustawienia = ustawieniaInpost(ctx.config)
  }

  testConnection(): Promise<ConnectionTest> {
    return testInpostConnection(this.api, this.organizationId)
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return wyliczPrzesylkeInpost(input, this.ustawienia)
  }
}

export const INPOST_SHIPX_DEFINITION: AdapterDefinition = { manifest: INPOST_SHIPX_MANIFEST, create: (ctx) => new InpostShipxAdapter(ctx) }
