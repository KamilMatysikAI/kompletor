// Adapter programu do faktur `ksef.fa3.v1`: KSeF bezpośrednio, dla firm bez wFirmy, w trybie
// „przygotuj, nie wysyłaj”. Składa fakturę FA(3) (lib/ksef/fa3/builder.ts) i sprawdza połączenie z TEST albo DEMO
// (`POST /auth/challenge`). Nie wysyła i nie ma zapisu, także za wyłącznikiem: wysyłka to osobne zadanie po decyzji
// właściciela. Produkcja (`PROD`) jest odrzucana przez walidację konfiguracji, a host produkcyjny przez klienta.
import { zbudujFa3 } from '../ksef/fa3/builder'
import type { WejscieFa3 } from '../ksef/fa3/typy'
import { KsefReadOnly } from '../ksef/klient'
import type { AdapterContext, AdapterDefinition, AdapterManifest, ChannelAdapter, ConnectionTest, InvoicePreparer, PreparedInvoice } from './kontrakt'

export const KSEF_KEY = 'ksef.fa3.v1'

export const KSEF_MANIFEST: AdapterManifest = {
  adapterKey: KSEF_KEY,
  version: '1.0.0',
  displayName: 'KSeF (FA(3), bez wFirmy)',
  kind: 'invoicing',
  capabilities: ['invoice.prepare'],
  rateLimit: { requestsPerMinute: 10, maxConcurrent: 1, minPollIntervalMs: 0 },
  config: [
    { key: 'srodowisko', type: 'string', required: true, description: 'środowisko KSeF: TEST albo DEMO (produkcja zablokowana)', pattern: /^(TEST|DEMO)$/, envSuffix: 'SRODOWISKO' },
    { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env (np. KSEF)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  ],
  secrets: [{ name: 'KSEF_TOKEN', required: false, description: 'token KSeF firmy: wysyłka faktur programu „KSeF bezpośrednio” (lib/ksef/wysylka.ts); adapter sam tylko sprawdza połączenie', envSuffix: 'TOKEN' }],
  readOnly: true,
}

class KsefAdapter implements ChannelAdapter, InvoicePreparer<WejscieFa3> {
  readonly manifest = KSEF_MANIFEST
  private readonly api: KsefReadOnly

  constructor(ctx: AdapterContext) {
    this.api = new KsefReadOnly(String(ctx.config['srodowisko']), ctx.fetch, ctx.http?.minIntervalMs, ctx.http?.retry)
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      await this.api.challenge()
      return { ok: true, message: 'KSeF odpowiada (wyzwanie uwierzytelnienia), nic nie zostało wysłane' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  prepareInvoice(input: WejscieFa3): PreparedInvoice {
    const f = zbudujFa3(input)
    return { xml: f.xml, schemaVersion: f.wersjaSchemy, sumy: { nettoGr: f.sumy.nettoGr, vatGr: f.sumy.vatGr, bruttoGr: f.sumy.bruttoGr }, problems: f.problemy }
  }
}

export const KSEF_DEFINITION: AdapterDefinition = { manifest: KSEF_MANIFEST, create: (ctx) => new KsefAdapter(ctx) }
