// Rejestr adapterów po `adapterKey`. Konto kanału w konfiguracji firmy (ChannelConfig.adapterKey +
// config) wskazuje klucz; rejestr sprawdza manifest, konfigurację i sekrety konta, zanim utworzy adapter.
// Nowy adapter = nowy wpis w rejestrze, bez migracji rdzenia.
import { createHash } from 'node:crypto'
import { ADAPTER_KEY_RE } from '../adaptery'
import {
  type AccountConfig,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  CAPABILITIES,
  type Capability,
  INTEGRATION_KINDS,
  STATUS_MAP_KEYS,
  type ChannelAdapter,
  type ConfigValue,
} from './kontrakt'

export class AdapterConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message)
    this.name = 'AdapterConfigError'
  }
}

const SECRET_RE = /^[A-Z][A-Z0-9_]{1,63}$/

/** Błędy manifestu (puste = poprawny). Rejestr odrzuca adapter z błędnym manifestem przy rejestracji. */
export function manifestProblems(m: AdapterManifest): string[] {
  const p: string[] = []
  if (!ADAPTER_KEY_RE.test(m.adapterKey) || m.adapterKey.length > 64) p.push(`zły adapterKey „${m.adapterKey}”`)
  if (!m.version.trim()) p.push('brak wersji')
  if (!m.displayName.trim()) p.push('brak nazwy')
  if (!INTEGRATION_KINDS.includes(m.kind)) p.push(`nieznany rodzaj integracji ${String(m.kind)}`)
  if (m.kind === 'channel' && !m.channel) p.push('adapter kanału bez rodziny kanału (channel)')
  for (const c of m.capabilities) if (!CAPABILITIES.includes(c)) p.push(`nieznana zdolność ${c}`)
  if (m.readOnly && m.capabilities.includes('stock.write')) p.push('adapter tylko do odczytu deklaruje stock.write')
  if (m.readOnly && m.capabilities.includes('order.status.write')) p.push('adapter tylko do odczytu deklaruje order.status.write')
  // przyjęcie zamówienia to też zapis w kanale
  if (m.readOnly && m.capabilities.includes('order.accept')) p.push('adapter tylko do odczytu deklaruje order.accept')
  // wystawienie i korekta dokumentu to zapis w programie do faktur
  if (m.readOnly && m.capabilities.includes('invoice.issue')) p.push('adapter tylko do odczytu deklaruje invoice.issue')
  if (m.readOnly && m.capabilities.includes('invoice.correct')) p.push('adapter tylko do odczytu deklaruje invoice.correct')
  if (m.kind !== 'invoicing' && m.capabilities.some((c) => c.startsWith('invoice.'))) p.push('zdolności faktur tylko dla rodzaju invoicing')
  if (m.readOnly && m.capabilities.includes('order.tracking.write')) p.push('adapter tylko do odczytu deklaruje order.tracking.write')
  if (m.readOnly && m.capabilities.includes('shipment.cancel')) p.push('adapter tylko do odczytu deklaruje shipment.cancel')
  // wystawienie oferty to zapis w kanale
  if (m.readOnly && m.capabilities.includes('offers.publish')) p.push('adapter tylko do odczytu deklaruje offers.publish')
  const b = m.channelBehavior
  if (b) {
    if (m.kind !== 'channel') p.push('zachowanie kanału (channelBehavior) tylko dla adaptera kanału')
    if (b.stockModel !== 'self-decrementing' && b.stockModel !== 'pushed') p.push('zły model stanu w channelBehavior')
    for (const [k, v] of Object.entries(b.defaultStatusMap ?? {})) {
      if (!(STATUS_MAP_KEYS as readonly string[]).includes(k)) p.push(`nieznany klucz mapy statusów ${k}`)
      if (typeof v !== 'string' || !v.trim()) p.push(`pusty status kanału dla ${k}`)
      else if (b.channelStatuses && !b.channelStatuses.some((s) => s.id === v)) p.push(`status kanału „${v}” spoza słownika (${k})`)
    }
  }
  const r = m.rateLimit
  if (!(r.requestsPerMinute > 0) || !(r.maxConcurrent >= 1) || !(r.minPollIntervalMs >= 0)) p.push('zły limit tempa')
  // limit zdolności tylko dla zdolności z manifestu, liczby dodatnie
  for (const [c, l] of Object.entries(r.perCapability ?? {})) {
    if (!(CAPABILITIES as readonly string[]).includes(c)) p.push(`limit tempa dla nieznanej zdolności ${c}`)
    else if (!m.capabilities.includes(c as Capability)) p.push(`limit tempa dla zdolności spoza manifestu ${c}`)
    if (!l || !(Number.isFinite(l.requestsPerMinute) && l.requestsPerMinute > 0)) p.push(`zły limit tempa zdolności ${c}`)
    if (l?.maxConcurrent !== undefined && !(Number.isInteger(l.maxConcurrent) && l.maxConcurrent >= 1)) p.push(`zła współbieżność zdolności ${c}`)
  }
  const keys = new Set<string>()
  for (const f of m.config) {
    if (keys.has(f.key)) p.push(`zdublowane pole konfiguracji ${f.key}`)
    keys.add(f.key)
  }
  const names = new Set<string>()
  for (const s of m.secrets) {
    if (!SECRET_RE.test(s.name)) p.push(`zła nazwa sekretu ${s.name}`)
    if (names.has(s.name)) p.push(`zdublowany sekret ${s.name}`)
    names.add(s.name)
  }
  return p
}

/** Konfiguracja konta po walidacji z manifestem: tylko pola z manifestu, typy sprawdzone, wymagane obecne. */
export function validateAccountConfig(m: AdapterManifest, raw: Record<string, unknown>): { config: AccountConfig; problems: string[] } {
  const problems: string[] = []
  const out: Record<string, ConfigValue> = {}
  for (const f of m.config) {
    const v = raw[f.key]
    if (v === undefined || v === null || v === '') {
      if (f.required) problems.push(`brak ustawienia ${f.key} (${f.description})`)
      continue
    }
    if (f.type === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
      if (!Number.isFinite(n)) problems.push(`ustawienie ${f.key} nie jest liczbą`)
      else out[f.key] = n
    } else if (f.type === 'boolean') {
      if (typeof v === 'boolean') out[f.key] = v
      else if (v === 'true' || v === 'false') out[f.key] = v === 'true'
      else problems.push(`ustawienie ${f.key} nie jest tak/nie`)
    } else {
      if (typeof v !== 'string') problems.push(`ustawienie ${f.key} nie jest tekstem`)
      else if (f.pattern && !f.pattern.test(v)) problems.push(`ustawienie ${f.key} ma zły format`)
      else if (f.options && !f.options.some((o) => o.value === v)) problems.push(`ustawienie ${f.key} spoza listy`)
      else out[f.key] = v
    }
  }
  return { config: out, problems }
}

/** Sekrety po walidacji: wymagane obecne; komunikaty tylko z nazwami, nigdy z wartościami. */
export function validateAccountSecrets(m: AdapterManifest, raw: Record<string, string | undefined>): { secrets: Record<string, string>; problems: string[] } {
  const problems: string[] = []
  const out: Record<string, string> = {}
  for (const s of m.secrets) {
    const v = raw[s.name]
    if (!v) {
      if (s.required) problems.push(`brak sekretu ${s.name} (${s.description})`)
      continue
    }
    out[s.name] = v
  }
  return { secrets: out, problems }
}

export interface CreateInput {
  integration: AdapterContext['integration']
  rawConfig: Record<string, unknown>
  rawSecrets: Record<string, string | undefined>
  fetch: AdapterContext['fetch']
  now?: () => Date
  http?: AdapterContext['http']
  persistSecrets?: AdapterContext['persistSecrets']
  rotateSecrets?: AdapterContext['rotateSecrets']
  ustawieniaFirmy?: AdapterContext['ustawieniaFirmy']
}

export class AdapterRegistry {
  private readonly defs = new Map<string, AdapterDefinition>()

  constructor(defs: AdapterDefinition[] = []) {
    for (const d of defs) this.register(d)
  }

  register(def: AdapterDefinition): void {
    const p = manifestProblems(def.manifest)
    if (p.length) throw new AdapterConfigError(`Manifest ${def.manifest.adapterKey}: ${p.join('; ')}`, p)
    if (this.defs.has(def.manifest.adapterKey)) throw new AdapterConfigError(`Adapter ${def.manifest.adapterKey} już jest w rejestrze`)
    this.defs.set(def.manifest.adapterKey, def)
  }

  get(adapterKey: string): AdapterDefinition | undefined {
    return this.defs.get(adapterKey)
  }

  list(): AdapterManifest[] {
    return [...this.defs.values()].map((d) => d.manifest)
  }

  /** Adapter konta: nieznany klucz, inna rodzina kanału, zła konfiguracja albo brak sekretu → AdapterConfigError. */
  create(adapterKey: string, input: CreateInput): ChannelAdapter {
    const def = this.defs.get(adapterKey)
    if (!def) throw new AdapterConfigError(`Nieznany adapter „${adapterKey}” (brak w rejestrze)`)
    const ref = input.integration
    if (def.manifest.kind !== ref.kind) throw new AdapterConfigError(`Adapter ${adapterKey} jest rodzaju ${def.manifest.kind}, integracja ${ref.id} — ${ref.kind}`)
    if (ref.kind === 'channel' && def.manifest.channel !== ref.channel)
      throw new AdapterConfigError(`Adapter ${adapterKey} jest dla kanału ${def.manifest.channel}, konto ma ${ref.channel}`)
    const c = validateAccountConfig(def.manifest, input.rawConfig)
    const s = validateAccountSecrets(def.manifest, input.rawSecrets)
    const problems = [...c.problems, ...s.problems]
    if (problems.length) throw new AdapterConfigError(`Konto ${ref.id}: ${problems.join('; ')}`, problems)
    const adapter = def.create({
      integration: ref,
      config: c.config,
      secrets: s.secrets,
      fetch: input.fetch,
      now: input.now ?? (() => new Date()),
      ...(input.http ? { http: input.http } : {}),
      ...(input.persistSecrets ? { persistSecrets: input.persistSecrets } : {}),
      ...(input.rotateSecrets ? { rotateSecrets: input.rotateSecrets } : {}),
      ...(input.ustawieniaFirmy ? { ustawieniaFirmy: input.ustawieniaFirmy } : {}),
    })
    if (adapter.manifest !== def.manifest) throw new AdapterConfigError(`Adapter ${adapterKey} zwrócił inny manifest niż zarejestrowany`)
    return adapter
  }
}

/**
 * Deterministyczna referencja zapisu (klucz idempotencji) z części: ta sama operacja → ta sama referencja, więc
 * ponowienie nie tworzy drugiej komendy w kanale. Np. (firma, konto, oferta, wersja stanu, numer próby).
 * Format UUID (część kanałów, np. Allegro commandId, wymaga UUID).
 */
export function deriveReference(parts: readonly (string | number)[]): string {
  if (!parts.length) throw new Error('referencja z pustych części')
  const h = createHash('sha256').update(parts.map((p) => String(p).replace(/\|/g, '\\|')).join('|')).digest('hex')
  // UUID wersji 5-podobny (bity wersji i wariantu ustawione), z SHA-256 zamiast SHA-1
  const v = `5${h.slice(13, 16)}`
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}-${h.slice(20, 32)}`
}

/**
 * rodzina adaptera = klucz bez wariantu zapisu („mirakl.empik.zapis.v1” → „mirakl.empik.v1”). Wersja z
 * zapisem dziedziczy odczyt 1:1 z wersji tylko do odczytu (ten sam kursor dziennika, te same sekrety i ustawienia),
 * więc zmiana rodzaju konta w obrębie rodziny nie zaczyna odczytu zamówień od nowa.
 */
export function rodzinaAdaptera(adapterKey: string): string {
  return adapterKey.replace(/\.zapis(\.v\d+)$/, '$1')
}
