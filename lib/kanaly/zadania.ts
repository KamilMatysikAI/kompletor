// Test połączenia i pobranie ofert konta z panelu. Panel tylko zleca zadanie workera (kolejka Job,
// dedupe po koncie, najwyżej jedno na konto na 30 s); zewnętrzne API woła worker. Wynik testu leży w
// ChannelAccountStatus (decyzja: nie w ChannelConfig.config, bo to ustawienia adaptera, i nie w ChannelHealth, bo to
// zdrowie zapisu stanów w kanał, które czyta propagacja). Komunikat dla człowieka jest nasz, po polsku: bez treści
// odpowiedzi kanału i bez sekretów.
import type { Prisma, PrismaClient } from '@prisma/client'
import type { ConnectionTest } from '../adaptery/kontrakt'
import { type ChannelAccountSettings, createAccountAdapter, loadChannelAccounts } from '../adaptery/konta'
import { AdapterConfigError, type AdapterRegistry } from '../adaptery/rejestr'
import { organizationIdOf } from '../db'
import type { SecretSource } from '../sekrety'
import { enqueue } from '../worker/kolejka'
import type { FetchLike } from '../zrodla/http'
import { AdresError, guardedFetch, znanyKomunikatAdresu } from './adres'
import { firmaMaBl, firmaMaWfirme } from './firma'
import { KontoError, type KontoRef } from './konta'
import { pobierzOferty, type WynikOfert } from './oferty'
import { kluczKanalu, wynikWlaczenia, zlecWlaczenie } from '../integracje/zdrowie'

export const KANAL_TEST_JOB = 'kanal-test'
export const KANAL_OFERTY_JOB = 'kanal-oferty'
export const LIMIT_MS = 30_000

export type Zlecenie = 'ZLECONO' | 'ZA_CZESTO'

async function ensureStatus(db: PrismaClient, ref: KontoRef): Promise<void> {
  if (!(await db.channelConfig.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId }, select: { channel: true } }))) throw new KontoError('Nie ma takiego konta')
  await db.channelAccountStatus.upsert({
    where: { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel: ref.channel, channelAccountId: ref.channelAccountId } },
    create: { channel: ref.channel, channelAccountId: ref.channelAccountId },
    update: {},
  })
}

/** „Sprawdź połączenie”: zadanie `kanal-test`. Drugie kliknięcie w ciągu 30 s = ZA_CZESTO (nic nie zlecone). */
export async function zlecTestPolaczenia(db: PrismaClient, ref: KontoRef, now = new Date()): Promise<Zlecenie> {
  await ensureStatus(db, ref)
  const cutoff = new Date(now.getTime() - LIMIT_MS)
  const r = await db.channelAccountStatus.updateMany({
    where: { channel: ref.channel, channelAccountId: ref.channelAccountId, OR: [{ testRequestedAt: null }, { testRequestedAt: { lt: cutoff } }] },
    data: { testRequestedAt: now },
  })
  if (!r.count) return 'ZA_CZESTO'
  await enqueue(db, KANAL_TEST_JOB, { channel: ref.channel, channelAccountId: ref.channelAccountId }, { dedupeKey: `${KANAL_TEST_JOB}:${ref.channel}:${ref.channelAccountId}`, maxAttempts: 1 })
  return 'ZLECONO'
}

/**
 * „Włącz ponownie” konta wyłączonego po błędach: zadanie `kanal-test` z `wlacz: true`. Worker najpierw
 * testuje połączenie; OK = konto wraca (tryb i `zapisWlaczony` bez zmian), błąd = zostaje wyłączone z krokiem i komunikatem.
 * false = konto nie jest wyłączone (nic nie zlecone).
 */
export async function zlecWlaczenieKonta(db: PrismaClient, ref: KontoRef, now = new Date()): Promise<boolean> {
  await ensureStatus(db, ref)
  if (!(await zlecWlaczenie(db, kluczKanalu(ref.channel, ref.channelAccountId), now))) return false
  await db.channelAccountStatus.updateMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId }, data: { testRequestedAt: now } })
  await enqueue(db, KANAL_TEST_JOB, { channel: ref.channel, channelAccountId: ref.channelAccountId, wlacz: true }, { dedupeKey: `${KANAL_TEST_JOB}:${ref.channel}:${ref.channelAccountId}:wlacz`, maxAttempts: 1 })
  return true
}

/** „Pobierz oferty”: zadanie `kanal-oferty`, ten sam limit. */
export async function zlecPobranieOfert(db: PrismaClient, ref: KontoRef, now = new Date()): Promise<Zlecenie> {
  await ensureStatus(db, ref)
  const cutoff = new Date(now.getTime() - LIMIT_MS)
  const r = await db.channelAccountStatus.updateMany({
    where: { channel: ref.channel, channelAccountId: ref.channelAccountId, OR: [{ offersRequestedAt: null }, { offersRequestedAt: { lt: cutoff } }] },
    data: { offersRequestedAt: now },
  })
  if (!r.count) return 'ZA_CZESTO'
  await enqueue(db, KANAL_OFERTY_JOB, { channel: ref.channel, channelAccountId: ref.channelAccountId }, { dedupeKey: `${KANAL_OFERTY_JOB}:${ref.channel}:${ref.channelAccountId}`, maxAttempts: 1 })
  return 'ZLECONO'
}

export interface KanalDeps {
  registry: AdapterRegistry
  secrets: SecretSource
  /** Atrapa w testach; produkcyjnie fetch z kontrolą adresu (guardedFetch). */
  fetch?: FetchLike
  now?: () => Date
}

/** Konto z payloadu zadania (także wyłączone: test połączenia przed włączeniem ma sens). */
export async function kontoZPayloadu(db: PrismaClient, payload: unknown): Promise<ChannelAccountSettings | null> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Partial<KontoRef>
  return (await loadChannelAccounts(db, { activeOnly: false })).find((a) => a.channel === p.channel && a.channelAccountId === p.channelAccountId) ?? null
}

/**
 * Komunikat testu dla człowieka z błędu albo komunikatu adaptera. Nigdy nie przepisujemy treści odpowiedzi kanału:
 * tylko rozpoznany rodzaj problemu (kod HTTP z naszego klienta) i stały tekst.
 */
export function komunikatBledu(e: unknown): string {
  if (e instanceof AdapterConfigError) {
    const p = e.problems.length ? e.problems : [e.message]
    // problemy z walidacji manifestu mają tylko nazwy i opisy pól, bez wartości
    return `Brakuje ustawień albo kluczy: ${p.join('; ')}`.slice(0, 500)
  }
  if (e instanceof AdresError) return e.message
  return komunikatTekstu(e instanceof Error ? e.message : String(e))
}

export function komunikatTekstu(raw: string): string {
  const m = raw.match(/HTTP (\d{3})/)
  const code = m ? Number(m[1]) : null
  if (code === 401 || code === 403 || /invalid_client|invalid_grant|odrzucon/i.test(raw)) return 'Kanał odrzucił klucz albo klucz nie ma prawa odczytu. Sprawdź klucz i jego uprawnienia.'
  if (code === 404) return 'Pod tym adresem nie ma API sklepu. Sprawdź adres.'
  if (code === 429) return 'Kanał chwilowo ogranicza liczbę zapytań. Spróbuj za kilka minut.'
  if (code !== null && code >= 300 && code < 400) return 'Adres sklepu przekierowuje gdzie indziej. Wpisz adres docelowy (https://…).'
  if ((code !== null && code >= 500) || /nie jest JSON/i.test(raw)) return 'Kanał chwilowo nie odpowiada poprawnie. Spróbuj za kilka minut.'
  if (code !== null) return `Kanał odpowiedział błędem (HTTP ${code}).`
  // tylko nasze stałe komunikaty adresu (lib/kanaly/adres.ts), nigdy surowa treść odpowiedzi kanału
  const adres = znanyKomunikatAdresu(raw)
  if (adres) return adres
  return 'Nie udało się połączyć z kanałem (sieć, adres albo certyfikat).'
}

async function saveTest(db: PrismaClient, acc: ChannelAccountSettings, ok: boolean, message: string, now: Date, orderMeta?: ConnectionTest['orderMeta']): Promise<void> {
  // nazwy kluczy meta z udanego testu (podpowiedź pól NIP / punktu / faktury); nieudany test ich nie kasuje
  const meta = orderMeta ? { testMetaKeys: { sample: orderMeta.sample, keys: orderMeta.keys, at: now.toISOString() } as Prisma.InputJsonValue } : {}
  await db.channelAccountStatus.upsert({
    where: { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel: acc.channel, channelAccountId: acc.channelAccountId } },
    create: { channel: acc.channel, channelAccountId: acc.channelAccountId, testCheckedAt: now, testOk: ok, testMessage: message, ...meta },
    update: { testCheckedAt: now, testOk: ok, testMessage: message, ...meta },
  })
}

function fetchFor(deps: KanalDeps): FetchLike {
  return deps.fetch ?? guardedFetch(deps.secrets.env)
}

/** Handler `kanal-test`: test połączenia adaptera, wynik w ChannelAccountStatus. Błąd kanału nie jest błędem zadania. */
export async function wykonajTestPolaczenia(db: PrismaClient, payload: unknown, deps: KanalDeps): Promise<{ ok: boolean; message: string } | null> {
  const acc = await kontoZPayloadu(db, payload)
  if (!acc) return null
  const now = (deps.now ?? (() => new Date()))()
  // „Włącz ponownie” — test przechodzi przez wyłączone konto, wynik decyduje o włączeniu
  const wlacz = !!payload && typeof payload === 'object' && (payload as { wlacz?: unknown }).wlacz === true
  let ok = false
  let message: string
  let orderMeta: ConnectionTest['orderMeta']
  let krok = 'Konfiguracja konta'
  try {
    const adapter = await createAccountAdapter(db, deps.registry, acc, deps.secrets, { fetch: fetchFor(deps), now: deps.now, ...(wlacz ? { oslona: { pomijajWylaczenie: true } } : {}) })
    krok = 'Test połączenia'
    const r = await adapter.testConnection()
    ok = r.ok
    if (r.ok) orderMeta = r.orderMeta
    if (r.ok) {
      const orders = typeof r.details?.['orders'] === 'number' ? r.details['orders'] : null
      message = orders !== null ? `Połączenie działa. Zamówień w kanale: ${orders}.` : 'Połączenie działa.'
    } else message = komunikatTekstu(r.message)
  } catch (e) {
    message = komunikatBledu(e)
  }
  try {
    await saveTest(db, acc, ok, message, now, orderMeta)
  } finally {
    // wynik „Włącz ponownie” zapisany także wtedy, gdy zapis wyniku testu padł (flaga zawsze zdjęta)
    if (wlacz) await wynikWlaczenia(db, kluczKanalu(acc.channel, acc.channelAccountId), ok ? { ok: true } : { ok: false, krok, komunikat: message }, now)
  }
  return { ok, message }
}

/**
 * po naprawie konta (nowe klucze, zmiana ustawień, zakończona autoryzacja Allegro albo Woo) konto
 * wyłączone po błędach od razu dostaje „Włącz ponownie” (ten sam test połączenia; 0 zł, odwracalne). Konto działające
 * dostaje zwykły test połączenia (`zwyklyTest`) albo nic. Zwraca, co zlecono.
 */
export async function zlecTestPoNaprawie(db: PrismaClient, ref: KontoRef, now = new Date(), opts: { zwyklyTest?: boolean } = {}): Promise<'WLACZANIE' | 'ZLECONO' | 'ZA_CZESTO' | 'NIC'> {
  if (await zlecWlaczenieKonta(db, ref, now)) return 'WLACZANIE'
  return opts.zwyklyTest === false ? 'NIC' : zlecTestPolaczenia(db, ref, now)
}

/** Handler `kanal-oferty`: pobranie ofert konta (lib/kanaly/oferty.ts). Błąd konfiguracji = wpis w przebiegu. */
export async function wykonajPobranieOfert(db: PrismaClient, payload: unknown, deps: KanalDeps): Promise<WynikOfert | null> {
  const acc = await kontoZPayloadu(db, payload)
  if (!acc) return null
  const now = (deps.now ?? (() => new Date()))()
  const ref = { channel: acc.channel, channelAccountId: acc.channelAccountId }
  let adapter
  try {
    adapter = await createAccountAdapter(db, deps.registry, acc, deps.secrets, { fetch: fetchFor(deps), now: deps.now })
  } catch (e) {
    const run = await db.importRun.create({ data: { kind: 'kanal-oferty', status: 'FAILED', finishedAt: now, error: komunikatBledu(e) } })
    await db.channelAccountStatus.updateMany({ where: ref, data: { offersRunId: run.id } })
    return null
  }
  const [hasBl, hasWfirma] = await Promise.all([firmaMaBl(db, deps.secrets), firmaMaWfirme(db)])
  try {
    return await pobierzOferty(db, ref, adapter, { hasBl, hasWfirma, actorId: 'system:kanal-oferty', now })
  } catch (e) {
    // przebieg ma już status FAILED i komunikat; do Job.lastError tylko nasz tekst
    throw new Error(`pobranie ofert: ${komunikatBledu(e)}`)
  }
}
