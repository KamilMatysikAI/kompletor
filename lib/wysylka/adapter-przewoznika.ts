// Adapter przewoźnika z reguły przewoźnika firmy: klucz z `CarrierRule.adapterKey` (albo domyślny dla
// modułu), konfiguracja z `CarrierRule.config`, sekrety firmy z bazy (IntegrationSecret bez konta kanału), w self-hoście
// jednofirmowym też z env (z przedrostkiem `envPrefix` reguły, np. DPD_EMPIK_LOGIN dla drugiego konta DPD). Drugie konto
// tego samego przewoźnika w bazie (DPD Salony Empik obok DPD) = reguła z `sekretyKonta: "EMPIK"`: host czyta wtedy
// sekrety `<NAZWA>_EMPIK` (np. DPD_LOGIN_EMPIK) i podaje adapterowi pod nazwami z manifestu. Dane nadawcy (DPD, Base
// Courier): profil firmy (Ustawienia → Dane firmy, `settings.firma`) z nadpisaniem `settings.nadawca`, złożone tu
// (`nadawcaFirmy`; wcześniej adapter dostawał samo `nadawca` i profil nie działał). Wysyłam z Allegro ma własną drogę (konto kanału, lib/wysylka/allegro-konto.ts).
import type { Carrier, PrismaClient, ShippingModule } from '@prisma/client'
import { DEFAULT_SHIPPING_ADAPTER } from '../adaptery'
import type { ChannelAdapter } from '../adaptery/kontrakt'
import { AdapterConfigError, type AdapterRegistry } from '../adaptery/rejestr'
import { withEnvInputs } from '../adaptery/konta'
import { organizationIdOf } from '../db'
import { resolveSecrets, type SecretSource } from '../sekrety'
import { parseProfilFirmy } from '../firma/profil'
import { parseNadawca } from './zlecenie-dpd'
import type { FetchLike } from '../zrodla/http'
import { type OpcjeOslony, oslonAdapter } from '../integracje/oslona'
import { type KontoIntegracji, kluczPrzewoznika, zapiszPorazke } from '../integracje/zdrowie'

export interface RegulaNadania {
  id: string
  carrier: Carrier
  shippingModule: ShippingModule
  adapterKey: string | null
  config: Record<string, unknown>
}

export const SEKRETY_KONTA_RE = /^[A-Z][A-Z0-9]{0,15}$/

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * Nadawca dla adaptera (`config.nadawca`, JSON): pełny z `parseNadawca` (nadpisanie `settings.nadawca` + profil firmy),
 * a gdy czegoś brakuje — to, co jest (adapter zgłosi dokładnie brakujące pola). undefined = nic nie ustawione.
 */
export function nadawcaFirmy(settings: unknown): Record<string, unknown> | undefined {
  const z = parseNadawca(settings as never)
  if (z.nadawca) return { ...z.nadawca }
  const p = parseProfilFirmy(settings as never)
  const zProfilu: Record<string, unknown> = { name: p.nazwa, address: p.adres?.ulica, city: p.adres?.miasto, postalCode: p.adres?.kodPocztowy, countryCode: p.adres?.kodKraju, phone: p.telefon, email: p.email }
  const n = { ...Object.fromEntries(Object.entries(zProfilu).filter(([, v]) => v !== null && v !== undefined)), ...asObject(asObject(settings)['nadawca']) }
  return Object.keys(n).length ? n : undefined
}

/** Klucz adaptera reguły: jawny albo domyślny dla modułu wysyłki. */
export const kluczReguly = (r: Pick<RegulaNadania, 'adapterKey' | 'shippingModule'>): string | null => r.adapterKey ?? DEFAULT_SHIPPING_ADAPTER[r.shippingModule]

/** konto przewoźnika reguły (`config.sekretyKonta`, np. EMPIK); null = konto główne modułu. */
export const kontoReguly = (r: Pick<RegulaNadania, 'config'>): string | null => {
  const s = asObject(r.config)['sekretyKonta']
  return typeof s === 'string' && SEKRETY_KONTA_RE.test(s) ? s : null
}

/** Pola konfiguracji, które czyta host (nie adapter): zdejmowane przed walidacją z manifestem. */
const POLA_HOSTA = ['sekretyKonta', 'formatEtykiety'] as const

/**
 * konto przewoźnika reguły jako konto integracji (licznik błędów, wyłączenie, limity): ten sam identyfikator
 * co konto na ekranie Ustawienia → Przewoźnicy (`kontaPrzewoznikow`: rodzina adaptera i sufiks drugiego konta).
 */
export function kontoIntegracjiPrzewoznika(adapterKey: string, sufiks: string | null, nazwa: string): KontoIntegracji {
  return { klucz: kluczPrzewoznika(`${adapterKey.split('.')[0]}${sufiks ? `~${sufiks}` : ''}`), rodzaj: 'carrier', nazwa }
}

export async function adapterPrzewoznika(db: PrismaClient, regula: RegulaNadania, registry: AdapterRegistry, src: SecretSource, opts: { fetch?: FetchLike; now?: () => Date; oslona?: OpcjeOslony } = {}): Promise<ChannelAdapter> {
  const key = kluczReguly(regula)
  if (!key) throw new AdapterConfigError('Reguła przewoźnika nie ma modułu wysyłki')
  const def = registry.get(key)
  if (!def) throw new AdapterConfigError(`Nieznany adapter „${key}” (brak w rejestrze)`)
  if (def.manifest.kind !== 'carrier') throw new AdapterConfigError(`Adapter ${key} nie jest adapterem przewoźnika`)
  const config = { ...asObject(regula.config) }
  const sufiks = config['sekretyKonta']
  for (const k of POLA_HOSTA) delete config[k]
  if (sufiks !== undefined && (typeof sufiks !== 'string' || !SEKRETY_KONTA_RE.test(sufiks))) throw new AdapterConfigError('sekretyKonta: wielkie litery i cyfry, np. EMPIK')
  const nazwy = def.manifest.secrets.map((s) => s.name)
  const zBazy = await resolveSecrets(db, sufiks ? nazwy.map((n) => `${n}_${sufiks}`) : nazwy, src)
  const sekrety: Record<string, string> = {}
  for (const n of nazwy) {
    const v = zBazy[sufiks ? `${n}_${sufiks}` : n]
    if (v) sekrety[n] = v
  }
  if (def.manifest.config.some((f) => f.key === 'nadawca')) {
    const org = await db.organization.findUnique({ where: { id: organizationIdOf(db) }, select: { settings: true } })
    const n = nadawcaFirmy(org?.settings)
    if (n !== undefined) config['nadawca'] = JSON.stringify(n)
  }
  const inputs = withEnvInputs(def.manifest, config, sekrety, src)
  const konto = kontoIntegracjiPrzewoznika(key, typeof sufiks === 'string' ? sufiks : null, `Przewoźnik ${def.manifest.displayName}${typeof sufiks === 'string' ? ` (konto ${sufiks})` : ''}`)
  let adapter: ChannelAdapter
  try {
    adapter = registry.create(key, {
      integration: { organizationId: organizationIdOf(db), kind: 'carrier', id: `${key}/${regula.id}`, name: def.manifest.displayName },
      ...inputs,
      fetch: opts.fetch ?? fetch,
      now: opts.now,
    })
  } catch (e) {
    // brak sekretu albo zła konfiguracja przewoźnika liczy się do automatycznego wyłączenia konta
    if (e instanceof AdapterConfigError) await zapiszPorazke(db, konto, `konfiguracja przewoźnika: ${e.message.slice(0, 300)}`, (opts.oslona?.now ?? (() => new Date()))()).catch(() => undefined)
    throw e
  }
  return oslonAdapter(db, adapter, konto, opts.oslona ?? {}) // bez zegara adaptera (bywa zamrożony na przebieg)
}
