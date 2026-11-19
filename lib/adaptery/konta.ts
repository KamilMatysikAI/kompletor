// Konta kanałów firmy → adaptery. Konto (ChannelConfig) wskazuje adapter kluczem tekstowym i niesie
// konfigurację (`config`, bez sekretów); sekrety konta są w IntegrationSecret przypisanym do konta.
// Self-host jednofirmowy może podać ustawienia i klucze w env: `config.envPrefix` = przedrostek konta (np. SD_WC →
// SD_WC_URL, SD_WC_KEY, SD_WC_SECRET), bo jedna zmienna env nie rozróżni dwóch sklepów. Hosting: tylko baza.
import type { Channel, Prisma, PrismaClient } from '@prisma/client'
import { DEFAULT_CHANNEL_ADAPTER } from '../adaptery'
import { rabatMaksProcent } from '../dokumenty/ustawienia'
import { appModeOf, organizationIdOf } from '../db'
import { guardedFetch, type Resolver } from '../kanaly/adres'
import { resolveSecrets, type SecretSource, setSecret } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import type { AdapterContext, AdapterManifest, ChannelAdapter, IntegrationRef, UstawieniaFirmyAdaptera } from './kontrakt'
import { AdapterConfigError, type AdapterRegistry } from './rejestr'
import { rotateAccountSecrets } from './rotacja-sekretow'
import { type OpcjeOslony, oslonAdapter } from '../integracje/oslona'
import { kluczKanalu, wylaczoneKonta, zapiszPorazke } from '../integracje/zdrowie'

export interface ChannelAccountSettings {
  organizationId: string
  channel: Channel
  channelAccountId: string
  name: string
  adapterKey: string
  config: Record<string, unknown>
  active: boolean
  /** konto wyłączone automatycznie po błędach (powód); null/brak = działa. Konfiguracja konta bez zmian. */
  wylaczonePoBledach?: string | null
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Konta kanałów firmy klienta `db` (RLS: tylko jej). */
export async function loadChannelAccounts(db: PrismaClient, opts: { activeOnly?: boolean } = {}): Promise<ChannelAccountSettings[]> {
  const organizationId = organizationIdOf(db)
  const rows = await db.channelConfig.findMany({ where: opts.activeOnly === false ? {} : { active: true }, orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }] })
  const wylaczone = rows.length ? await wylaczoneKonta(db) : new Map()
  return rows.map((r) => ({
    organizationId,
    channel: r.channel,
    channelAccountId: r.channelAccountId,
    name: r.name,
    adapterKey: r.adapterKey || DEFAULT_CHANNEL_ADAPTER[r.channel],
    config: asObject(r.config),
    active: r.active,
    wylaczonePoBledach: wylaczone.get(kluczKanalu(r.channel, r.channelAccountId))?.powod ?? null,
  }))
}

/**
 * Sekrety konta z bazy (IntegrationSecret przypisany do konta kanału). Bez fallbacku na env po samej nazwie:
 * `WOO_CONSUMER_KEY` w env nie rozróżni dwóch sklepów — env konta idzie przez `envPrefix` (withEnvInputs).
 */
async function accountSecretsFromDb(db: PrismaClient, acc: ChannelAccountSettings, names: string[], src: SecretSource): Promise<Record<string, string>> {
  if (!names.length) return {}
  return resolveSecrets(db, names, { env: src.env, envFallback: false }, { channel: acc.channel, channelAccountId: acc.channelAccountId })
}

export interface AccountInputs {
  rawConfig: Record<string, unknown>
  rawSecrets: Record<string, string | undefined>
}

/**
 * Czysta część: dokłada do konfiguracji i sekretów konta wartości z env `<envPrefix>_<envSuffix>` — tylko gdy
 * self-host pozwala na env (`src.envFallback`) i konto ma `envPrefix`. Wartości z bazy wygrywają.
 */
export function withEnvInputs(manifest: AdapterManifest, config: Record<string, unknown>, secrets: Record<string, string | undefined>, src: SecretSource): AccountInputs {
  const rawConfig: Record<string, unknown> = { ...config }
  const rawSecrets: Record<string, string | undefined> = { ...secrets }
  const prefix = typeof rawConfig['envPrefix'] === 'string' ? rawConfig['envPrefix'] : null
  if (src.envFallback && prefix && /^[A-Z][A-Z0-9_]{0,40}$/.test(prefix)) {
    for (const f of manifest.config) {
      const v = f.envSuffix ? src.env[`${prefix}_${f.envSuffix}`] : undefined
      if (v && (rawConfig[f.key] === undefined || rawConfig[f.key] === '')) rawConfig[f.key] = v
    }
    for (const s of manifest.secrets) {
      const v = s.envSuffix ? src.env[`${prefix}_${s.envSuffix}`] : undefined
      if (v && !rawSecrets[s.name]) rawSecrets[s.name] = v
    }
  }
  return { rawConfig, rawSecrets }
}

/** Konfiguracja i sekrety konta dla manifestu: baza, potem (self-host) env z przedrostkiem konta. */
export async function accountInputs(db: PrismaClient, acc: ChannelAccountSettings, manifest: AdapterManifest, src: SecretSource): Promise<AccountInputs> {
  const secrets = await accountSecretsFromDb(db, acc, manifest.secrets.map((s) => s.name), src)
  return withEnvInputs(manifest, acc.config, secrets, src)
}

/** Konto kanału jako integracja adaptera (kind „channel”, id „<kanał>/<konto>”). */
export function channelIntegration(acc: ChannelAccountSettings): IntegrationRef {
  return { organizationId: acc.organizationId, kind: 'channel', id: `${acc.channel}/${acc.channelAccountId}`, name: acc.name, channel: acc.channel, channelAccountId: acc.channelAccountId }
}

/**
 * Zapis odświeżonych sekretów konta przez adapter (OAuth): tylko nazwy z manifestu, szyfrowane
 * kluczem głównym (env APP_ENCRYPTION_KEY) w zakresie konta. Wartości nie trafiają do błędów.
 */
export function accountSecretWriter(db: PrismaClient, acc: ChannelAccountSettings, manifest: AdapterManifest, src: SecretSource): (patch: Record<string, string>) => Promise<void> {
  const allowed = new Set(manifest.secrets.map((s) => s.name))
  return async (patch) => {
    const bad = Object.keys(patch).filter((n) => !allowed.has(n))
    if (bad.length) throw new AdapterConfigError(`Adapter ${manifest.adapterKey} chce zapisać sekret spoza manifestu: ${bad.join(', ')}`)
    for (const [name, value] of Object.entries(patch)) await setSecret(db, name, value, src.env, { channel: acc.channel, channelAccountId: acc.channelAccountId })
  }
}

/**
 * Domyślny fetch adaptera konta: w hostingu z kontrolą adresu po DNS przed każdym żądaniem
 * i bez podążania za przekierowaniami (`guardedFetch`), bo konto i jego adres dodaje najemca w panelu; polling
 * zamówień, przegląd otwartych i odbiorca na żądanie nie mogą pytać sieci serwera. W self-hoście globalny fetch
 * (sieć prywatna celowo dozwolona). Wstrzyknięty `opts.fetch` (testy, zadania panelu z własną osłoną) wygrywa.
 */
export function defaultAccountFetch(env: SecretSource['env'], resolve?: Resolver): FetchLike {
  return appModeOf(env) === 'hosted' ? guardedFetch(env, (u, i) => fetch(u, i), resolve) : (u, i) => fetch(u, i)
}

/**
 * runda 3: ustawienia firmy dla adaptera kanału z `Organization.settings`, tymi samymi funkcjami co
 * dokument sprzedaży (`rabatMaksProcent` z lib/dokumenty/ustawienia.ts), więc limit rabatu ma jedno źródło.
 */
export function ustawieniaFirmyAdaptera(settings: Prisma.JsonValue | null | undefined): UstawieniaFirmyAdaptera {
  return { rabatMaksProcent: rabatMaksProcent(settings) }
}

/** Adapter konta albo AdapterConfigError (nieznany klucz, zła konfiguracja, brak sekretu). */
export async function createAccountAdapter(
  db: PrismaClient,
  registry: AdapterRegistry,
  acc: ChannelAccountSettings,
  src: SecretSource,
  /** `http`: odstęp i ponowienia klienta HTTP adaptera (testy: `{ minIntervalMs: 0 }`). */
  opts: { fetch?: FetchLike; now?: () => Date; resolve?: Resolver; http?: AdapterContext['http']; /** np. pominięcie wyłączenia przy „Włącz ponownie”. */ oslona?: OpcjeOslony } = {},
): Promise<ChannelAdapter> {
  const key = acc.adapterKey
  const def = registry.get(key)
  const integration = channelIntegration(acc)
  const f = opts.fetch ?? defaultAccountFetch(src.env, opts.resolve)
  if (!def) return registry.create(key, { integration, rawConfig: {}, rawSecrets: {}, fetch: f }) // AdapterConfigError: nieznany
  const inputs = await accountInputs(db, acc, def.manifest, src)
  const org = await db.organization.findUnique({ where: { id: acc.organizationId }, select: { settings: true } })
  const konto = { klucz: kluczKanalu(acc.channel, acc.channelAccountId), rodzaj: 'channel' as const, nazwa: acc.name }
  let adapter: ChannelAdapter
  try {
    adapter = registry.create(key, {
    integration,
    ...inputs,
    fetch: f,
    now: opts.now,
    ...(opts.http ? { http: opts.http } : {}),
    persistSecrets: accountSecretWriter(db, acc, def.manifest, src),
    rotateSecrets: accountSecretRotator(db, acc, def.manifest, src),
    ustawieniaFirmy: ustawieniaFirmyAdaptera(org?.settings),
    })
  } catch (e) {
    // zła konfiguracja albo brak sekretu też jest porażką konta (licznik do automatycznego wyłączenia)
    if (e instanceof AdapterConfigError) await zapiszPorazke(db, konto, `konfiguracja konta: ${e.message.slice(0, 300)}`, (opts.oslona?.now ?? (() => new Date()))()).catch(() => undefined)
    throw e
  }
  // osłona hosta (limity tempa konta i zdolności, zdrowie konta, wyłączenie po błędach)
  return oslonAdapter(db, adapter, konto, opts.oslona ?? {}) // bez zegara adaptera (bywa zamrożony na przebieg)
}

/** Rotacja sekretów konta pod blokadą wiersza w bazie (lib/adaptery/rotacja-sekretow.ts). */
export function accountSecretRotator(db: PrismaClient, acc: ChannelAccountSettings, manifest: AdapterManifest, src: SecretSource): NonNullable<AdapterContext['rotateSecrets']> {
  const allowed = new Set(manifest.secrets.map((s) => s.name))
  return (rotation) => rotateAccountSecrets(db, { channel: acc.channel, channelAccountId: acc.channelAccountId }, src.env, rotation, { allowed })
}
