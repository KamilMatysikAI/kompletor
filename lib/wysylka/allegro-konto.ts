// Adapter Wysyłam z Allegro dla konta Allegro firmy. `createAccountAdapter` (lib/adaptery/konta.ts) daje
// integrację rodzaju „channel”, a rejestr odrzuca na niej adapter przewoźnika, więc tu powstaje integracja rodzaju
// „carrier” podpięta pod konto kanału ALLEGRO: te same sekrety (ta sama para tokenów co `allegro.v1`), ten sam zapis
// i ta sama rotacja pod blokadą konta. Dwa adaptery na jednym koncie nie odświeżają tokena dwa razy.
import type { PrismaClient } from '@prisma/client'
import { ALLEGRO_WYSYLAM_KEY, AllegroWysylamAdapter } from '../adaptery/allegro-wysylam'
import { accountInputs, accountSecretRotator, accountSecretWriter, loadChannelAccounts, type ChannelAccountSettings } from '../adaptery/konta'
import type { IntegrationRef } from '../adaptery/kontrakt'
import { AdapterConfigError, type AdapterRegistry } from '../adaptery/rejestr'
import { type OpcjeOslony, oslonAdapter } from '../integracje/oslona'
import { kluczKanalu, zapiszPorazke } from '../integracje/zdrowie'
import type { SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'

/** Klucze adapterów Wysyłam z Allegro (podgląd i nadawanie): adapter powstaje na koncie kanału, nie z reguły. */
export const WYSYLAM_KEY_RE = /^allegro\.wysylam(\.zapis)?\.v\d+$/

/** Integracja przewoźnika na koncie kanału ALLEGRO: id „ALLEGRO/<konto>”, z kanałem i kontem (zakres sekretów). */
export function wysylamIntegration(acc: ChannelAccountSettings): IntegrationRef {
  return { organizationId: acc.organizationId, kind: 'carrier', id: `ALLEGRO/${acc.channelAccountId}`, name: acc.name, channel: 'ALLEGRO', channelAccountId: acc.channelAccountId }
}

/**
 * Konto ALLEGRO firmy klienta `db` (RLS): wskazane albo jedyne. Brak konta albo kilka bez wskazania = jawny błąd
 * konfiguracji (nie zgadujemy konta, bo sekrety i tokeny są per konto).
 */
export async function wysylamAccount(db: PrismaClient, channelAccountId?: string | null): Promise<ChannelAccountSettings> {
  const konta = (await loadChannelAccounts(db, { activeOnly: false })).filter((a) => a.channel === 'ALLEGRO')
  if (channelAccountId) {
    const acc = konta.find((a) => a.channelAccountId === channelAccountId)
    if (!acc) throw new AdapterConfigError(`Firma nie ma konta ALLEGRO/${channelAccountId}: Wysyłam z Allegro wymaga konta Allegro z autoryzacją`)
    return acc
  }
  const aktywne = konta.filter((a) => a.active)
  if (aktywne.length === 1) return aktywne[0]!
  if (!aktywne.length) throw new AdapterConfigError('Firma nie ma aktywnego konta ALLEGRO: Wysyłam z Allegro wymaga konta Allegro z autoryzacją')
  throw new AdapterConfigError(`Firma ma ${aktywne.length} aktywne konta ALLEGRO: wskaż konto (--konto <id>)`)
}

/** Adapter `allegro.wysylam.v1` konta albo AdapterConfigError (brak konta, zła konfiguracja, brak sekretu). */
export async function createWysylamAdapter(
  db: PrismaClient,
  registry: AdapterRegistry,
  acc: ChannelAccountSettings | string | null | undefined,
  src: SecretSource,
  opts: {
    fetch?: FetchLike
    now?: () => Date
    /** `allegro.wysylam.zapis.v1` (nadawanie) zamiast domyślnego `allegro.wysylam.v1`. */
    adapterKey?: string
    /** ustawienia z reguły przewoźnika (wyłącznik nadawania, format etykiety) ponad konfiguracją konta. */
    config?: Record<string, unknown>
    http?: { pollDelayMs?: number; minIntervalMs?: number }
    /** opcje osłony hosta (testy: zegar, sen; „Włącz ponownie”: pominięcie wyłączenia). */
    oslona?: OpcjeOslony
  } = {},
): Promise<AllegroWysylamAdapter> {
  const konto = acc && typeof acc === 'object' ? acc : await wysylamAccount(db, acc)
  if (konto.channel !== 'ALLEGRO') throw new AdapterConfigError(`Wysyłam z Allegro działa tylko na koncie ALLEGRO (jest ${konto.channel}/${konto.channelAccountId})`)
  const key = opts.adapterKey ?? ALLEGRO_WYSYLAM_KEY
  if (!WYSYLAM_KEY_RE.test(key)) throw new AdapterConfigError(`Adapter „${key}” nie jest adapterem Wysyłam z Allegro`)
  const def = registry.get(key)
  if (!def) throw new AdapterConfigError(`Nieznany adapter „${key}” (brak w rejestrze)`)
  const inputs = await accountInputs(db, opts.config ? { ...konto, config: { ...konto.config, ...opts.config } } : konto, def.manifest, src)
  // ten sam klucz co konto kanału Allegro (ten sam token i ten sam limit Client ID), więc
  // limit `shipment.create` z manifestu działa, a odrzucony token Wysyłam liczy się do wyłączenia konta Allegro
  const kontoIntegracji = { klucz: kluczKanalu('ALLEGRO', konto.channelAccountId), rodzaj: 'channel' as const, nazwa: konto.name }
  let adapter: ReturnType<AdapterRegistry['create']>
  try {
    adapter = registry.create(key, {
      integration: wysylamIntegration(konto),
      ...inputs,
      ...(opts.http ? { http: opts.http } : {}),
      fetch: opts.fetch ?? fetch,
      now: opts.now,
      persistSecrets: accountSecretWriter(db, konto, def.manifest, src),
      rotateSecrets: accountSecretRotator(db, konto, def.manifest, src),
    })
  } catch (e) {
    if (e instanceof AdapterConfigError) await zapiszPorazke(db, kontoIntegracji, `konfiguracja Wysyłam z Allegro: ${e.message.slice(0, 300)}`, (opts.oslona?.now ?? (() => new Date()))()).catch(() => undefined)
    throw e
  }
  // sprawdzenie typu przed owinięciem (Proxy bez pułapki getPrototypeOf i tak przechodzi instanceof)
  if (!(adapter instanceof AllegroWysylamAdapter)) throw new AdapterConfigError(`Adapter ${key} w rejestrze nie jest adapterem Wysyłam z Allegro`)
  return oslonAdapter(db, adapter, kontoIntegracji, opts.oslona ?? {})
}
