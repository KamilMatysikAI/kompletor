// Konta kanałów sprzedaży z panelu: dodanie sklepu, zmiana ustawień, wklejenie kluczy, wyłączenie.
// Klient firmy (RLS): firma widzi i zmienia tylko swoje konta. Formularz i walidacja z manifestu adaptera (rejestr),
// nie z listy w ekranie, więc kolejny adapter (np. Shoper, PrestaShop) działa bez zmian tutaj. Sekrety wyłącznie przez
// setSecret (AES-256-GCM, zakres konta); do AuditLog idą same nazwy kluczy. Trybu cień/praca ten moduł nie zmienia (przełącznik: lib/kanaly/tryb.ts).
// Self-host z env (`config.envPrefix`) zostaje jak był: pole nie jest w formularzu, a zapis go nie gubi.
import type { Channel, Prisma, PrismaClient } from '@prisma/client'
import type { AdapterManifest, ConfigField, SecretField } from '../adaptery/kontrakt'
import { type AdapterRegistry, validateAccountConfig } from '../adaptery/rejestr'
import { encryptionKeysFromEnv, type Env, setSecret } from '../sekrety'
import { AdresError, checkShopUrlShape } from './adres'
import { domyslnyTryb } from './tryb'
import { czyPoleMeta, wykryteZBazy } from './woo-meta'
import { uniewaznijKonto } from './rejestr-synchronizacji'

/** Błąd do pokazania w panelu: tekst po polsku, bez wartości sekretów. */
export class KontoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KontoError'
  }
}

/** Konto zapisane, a kluczy nie udało się zapisać: ekran konta zamiast „Dodaj” (bez drugiego konta). */
export class SekretyNieZapisaneError extends KontoError {
  constructor(public readonly ref: KontoRef) {
    super('Konto zapisane, ale kluczy nie udało się zapisać. Wklej je ponownie niżej.')
    this.name = 'SekretyNieZapisaneError'
  }
}

export interface KontoRef {
  channel: Channel
  channelAccountId: string
}

export interface KontoOpts {
  actorId: string
  env: Env
  registry: AdapterRegistry
}

// Pola, których panel nie pokazuje: przedrostek env działa tylko w self-hoście z kluczami w pliku .env.
const HIDDEN_CONFIG = new Set(['envPrefix'])

/**
 * Pola poza formularzami ustawień (kreator i „Ustawienia i klucze”, po przeglądzie): wyłącznik zapisu
 * ma własny przełącznik w sekcji „Zapis do sklepu” (potwierdzenie, warunki, uprawnienie „Zmiana trybu kanału”), więc
 * zapis ustawień konta go nie zmienia.
 */
export const POLA_POZA_FORMULARZEM: ReadonlySet<string> = new Set(['zapisWlaczony', 'wystawianieOfertWlaczone']) // wystawianie ofert ma własny przełącznik

/** Rodzaje kont do wyboru w kreatorze: kanały sprzedaży z dziennikiem zamówień. */
export function rodzajeKanalow(registry: AdapterRegistry): AdapterManifest[] {
  return registry
    .list()
    .filter((m) => m.kind === 'channel' && !!m.channel && m.capabilities.includes('orders.feed'))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pl'))
}

export function polaUstawien(m: AdapterManifest): ConfigField[] {
  return m.config.filter((f) => !HIDDEN_CONFIG.has(f.key))
}

/**
 * Sekrety do wklejenia w panelu: wymagane albo czytane też z env (klucze od człowieka). Opcjonalne bez env to wartości
 * zapisywane przez adapter albo autoryzację (np. termin ważności tokena Allegro) — ich nikt nie wkleja.
 */
export function polaSekretow(m: AdapterManifest): SecretField[] {
  return m.secrets.filter((s) => !SEKRETY_Z_AUTORYZACJI.has(s.name) && (s.required || !!s.envSuffix))
}

/**
 * Sekrety wymagane, ale zapisywane przez autoryzację konta, nie przez człowieka: tokeny
 * Allegro z device flow (`allegro-autoryzuj`). Ekran ich nie pokazuje jako pól do wklejenia; opisuje je `UwagaAllegro`.
 * Docelowo flaga w manifeście (zmiana kontraktu adapterów poza).
 */
export const SEKRETY_Z_AUTORYZACJI: ReadonlySet<string> = new Set(['ALLEGRO_ACCESS_TOKEN', 'ALLEGRO_REFRESH_TOKEN'])

const isUrlField = (f: ConfigField) => f.type === 'string' && /url$/i.test(f.key)

/** Kod konta w adresie ekranu: „<KANAŁ>.<konto>”. */
export function kodKonta(r: KontoRef): string {
  return `${r.channel}.${r.channelAccountId}`
}

// SHOPER i PRESTASHOP (bez nich ekran konta Shopera i PrestaShop dawał 404); IDOSELL
const CHANNELS: readonly Channel[] = ['WOO', 'ALLEGRO', 'EMPIK', 'EASYTOOLS', 'BL_INNE', 'RECZNE', 'AI', 'SHOPER', 'PRESTASHOP', 'IDOSELL']
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function parseKodKonta(s: string): KontoRef | null {
  let raw: string
  try {
    raw = decodeURIComponent(s)
  } catch {
    return null // zły zapis „%” w adresie = brak konta (404), nie błąd 500
  }
  const i = raw.indexOf('.')
  if (i <= 0) return null
  const channel = raw.slice(0, i) as Channel
  const channelAccountId = raw.slice(i + 1)
  if (!CHANNELS.includes(channel) || !ACCOUNT_ID_RE.test(channelAccountId)) return null
  return { channel, channelAccountId }
}

/** Część identyfikatora z nazwy: małe litery bez polskich znaków, myślniki; pusta = „sklep”. */
export function slugNazwy(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '')
  return s || 'sklep'
}

/** Identyfikator konta nadany z nazwy, unikalny w firmie (wszystkie kanały): „sklep-1”, „sklep-2”… */
export async function nadajIdentyfikator(db: PrismaClient, name: string): Promise<string> {
  const base = slugNazwy(name)
  const taken = new Set((await db.channelConfig.findMany({ where: { channelAccountId: { startsWith: `${base}-` } }, select: { channelAccountId: true } })).map((r) => r.channelAccountId))
  for (let n = 1; n < 10_000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  throw new KontoError('Nie udało się nadać identyfikatora konta')
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ')
  if (!n) throw new KontoError('Podaj nazwę sklepu')
  if (n.length > 80) throw new KontoError('Nazwa sklepu może mieć najwyżej 80 znaków')
  return n
}

/**
 * Ustawienia z formularza → konfiguracja konta po walidacji manifestu. `keep` = dotychczasowa konfiguracja: pola
 * spoza formularza (envPrefix i klucze nieznane manifestowi) zostają nietknięte.
 */
export function configZFormularza(m: AdapterManifest, form: Record<string, string>, env: Env, keep: Record<string, unknown> = {}): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const f of polaUstawien(m)) {
    const v = (form[f.key] ?? '').trim()
    if (f.type === 'boolean') raw[f.key] = v === 'true' || v === 'tak' || v === 'on' ? true : v === '' ? undefined : v
    else raw[f.key] = v === '' ? undefined : v
  }
  for (const f of polaUstawien(m)) {
    const v = raw[f.key]
    if (typeof v === 'string' && isUrlField(f)) {
      try {
        raw[f.key] = checkShopUrlShape(v, env)
      } catch (e) {
        if (e instanceof AdresError) throw new KontoError(`${f.description}: ${e.message}`)
        throw e
      }
    }
  }
  const hiddenKept = Object.fromEntries(Object.entries(keep).filter(([k]) => HIDDEN_CONFIG.has(k) || !m.config.some((f) => f.key === k)))
  const { config, problems } = validateAccountConfig(m, { ...hiddenKept, ...raw })
  if (problems.length) throw new KontoError(`Popraw ustawienia: ${problems.join('; ')}`)
  return { ...hiddenKept, ...config }
}

function manifestOf(registry: AdapterRegistry, adapterKey: string): AdapterManifest {
  const def = registry.get(adapterKey)
  if (!def || def.manifest.kind !== 'channel' || !def.manifest.channel) throw new KontoError('Nieznany rodzaj sklepu')
  return def.manifest
}

/** Sekrety z formularza: tylko nazwy z manifestu, puste pomijane (puste pole = bez zmiany). */
function sekretyZFormularza(m: AdapterManifest, form: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of polaSekretow(m)) {
    const v = (form[s.name] ?? '').trim()
    if (!v) continue
    if (v.length > 8192) throw new KontoError(`${s.description}: wartość jest za długa`)
    out[s.name] = v
  }
  return out
}

function assertKeysReady(env: Env, secrets: Record<string, string>): void {
  if (!Object.keys(secrets).length) return
  try {
    encryptionKeysFromEnv(env)
  } catch {
    throw new KontoError('Serwer nie ma klucza szyfrowania (APP_ENCRYPTION_KEY), więc nie może zapisać kluczy sklepu. Zgłoś to administratorowi.')
  }
}

async function audit(db: PrismaClient | Prisma.TransactionClient, ref: KontoRef, actorId: string, before: unknown, after: unknown): Promise<void> {
  await db.auditLog.create({
    data: {
      entity: 'ChannelConfig',
      entityId: `${ref.channel}/${ref.channelAccountId}`,
      actorId,
      before: before === null ? undefined : (before as Prisma.InputJsonValue),
      after: after as Prisma.InputJsonValue,
    },
  })
}

export interface NoweKonto {
  adapterKey: string
  name: string
  /** Pola formularza: ustawienia (klucz z manifestu) i sekrety (nazwa sekretu). */
  form: Record<string, string>
}

/** Nowe konto kanału z panelu. Tryb z `domyslnyTryb()` (lib/kanaly/tryb.ts, „Tylko podgląd”); przełącza go ekran konta. */
export async function dodajKonto(db: PrismaClient, input: NoweKonto, opts: KontoOpts): Promise<KontoRef> {
  const m = manifestOf(opts.registry, input.adapterKey)
  if (!rodzajeKanalow(opts.registry).some((x) => x.adapterKey === m.adapterKey)) throw new KontoError('Ten rodzaj konta nie jest kanałem sprzedaży')
  const name = cleanName(input.name)
  const config = configZFormularza(m, input.form, opts.env)
  // nowe konto zawsze bez zapisu, także ze spreparowanego formularza (włącza go przełącznik na ekranie konta)
  for (const k of POLA_POZA_FORMULARZEM) delete config[k]
  const secrets = sekretyZFormularza(m, input.form)
  assertKeysReady(opts.env, secrets)
  const channel = m.channel!
  let ref: KontoRef | null = null
  for (let attempt = 0; attempt < 3 && !ref; attempt++) {
    const channelAccountId = await nadajIdentyfikator(db, name)
    try {
      await db.$transaction(async (tx) => {
        const tryb = domyslnyTryb()
        await tx.channelConfig.create({ data: { channel, channelAccountId, name, adapterKey: m.adapterKey, config: config as Prisma.InputJsonValue, active: true, stockMode: tryb, statusMode: tryb, trackingMode: tryb } })
        await tx.channelAccountStatus.create({ data: { channel, channelAccountId, createdInPanel: true } })
        await audit(tx, { channel, channelAccountId }, opts.actorId, null, { name, adapterKey: m.adapterKey, config, active: true, sekrety: Object.keys(secrets) })
      })
      ref = { channel, channelAccountId }
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e // równoległe dodanie o tej samej nazwie: kolejny numer
    }
  }
  if (!ref) throw new KontoError('Nie udało się zapisać konta, spróbuj ponownie')
  try {
    for (const [n, v] of Object.entries(secrets)) await setSecret(db, n, v, opts.env, ref)
  } catch {
    throw new SekretyNieZapisaneError(ref) // bez treści błędu: mogłaby nieść fragment klucza
  }
  return ref
}

async function loadConfig(db: PrismaClient, ref: KontoRef) {
  const row = await db.channelConfig.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId } })
  if (!row) throw new KontoError('Nie ma takiego konta')
  return row
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Zmiana nazwy i ustawień konta (bez sekretów, bez trybów). */
export async function zmienKonto(db: PrismaClient, ref: KontoRef, input: { name: string; form: Record<string, string> }, opts: KontoOpts): Promise<void> {
  const row = await loadConfig(db, ref)
  const m = manifestOf(opts.registry, row.adapterKey)
  const name = cleanName(input.name)
  const before = asObject(row.config)
  const config = configZFormularza(m, input.form, opts.env, before)
  // wyłącznik zapisu ma własny przełącznik (lib/kanaly/tryb.ts, ustawZapisKonta): zapis ustawień zostawia go bez zmian
  for (const k of POLA_POZA_FORMULARZEM) {
    if (k in before) config[k] = before[k]
    else delete config[k]
  }
  await db.$transaction(async (tx) => {
    await tx.channelConfig.update({
      where: { organizationId_channel_channelAccountId: { organizationId: row.organizationId, channel: ref.channel, channelAccountId: ref.channelAccountId } },
      data: { name, config: config as Prisma.InputJsonValue },
    })
    await audit(tx, ref, opts.actorId, { name: row.name, config: before }, { name, config })
  })
}

/** Wklejenie nowych kluczy: puste pole = bez zmiany. Zwraca nazwy zapisanych (do komunikatu, bez wartości). */
export async function zapiszSekrety(db: PrismaClient, ref: KontoRef, form: Record<string, string>, opts: KontoOpts): Promise<string[]> {
  const row = await loadConfig(db, ref)
  const m = manifestOf(opts.registry, row.adapterKey)
  const secrets = sekretyZFormularza(m, form)
  if (!Object.keys(secrets).length) return []
  assertKeysReady(opts.env, secrets)
  for (const [n, v] of Object.entries(secrets)) await setSecret(db, n, v, opts.env, ref)
  // nowe klucze mogą wskazywać inny sklep: pełny zapis stanów, bez pomijania niezmienionych. Klucze są już
  // zapisane, więc błąd rejestru idzie tylko do logu; klucze nie zmieniają `ChannelConfig.updatedAt`, więc
  // przy takiej awarii stan dogoni nocna pełna synchronizacja albo siatka godzin
  await uniewaznijKonto(db, ref).catch((e) => console.warn(`[rejestr-synchronizacji] ${ref.channel}/${ref.channelAccountId}: kasowanie skrótów po nowych kluczach nieudane (${e instanceof Error ? e.message : String(e)})`))
  await audit(db, ref, opts.actorId, null, { sekretyZmienione: Object.keys(secrets) })
  return Object.keys(secrets)
}

/** Włączenie albo wyłączenie konta. Niczego nie kasuje: oferty, sekrety, kursor i zamówienia zostają. */
export async function wylaczKonto(db: PrismaClient, ref: KontoRef, active: boolean, opts: Pick<KontoOpts, 'actorId'>): Promise<void> {
  const row = await loadConfig(db, ref)
  if (row.active === active) return
  await db.$transaction(async (tx) => {
    await tx.channelConfig.update({
      where: { organizationId_channel_channelAccountId: { organizationId: row.organizationId, channel: ref.channel, channelAccountId: ref.channelAccountId } },
      data: { active },
    })
    await audit(tx, ref, opts.actorId, { active: row.active }, { active })
  })
}

/**
 * „Użyj” przy wykrytym polu zamówienia (NIP, punkt odbioru, „chcę fakturę”). Tylko pola z listy i tylko
 * klucz, który test połączenia faktycznie widział w zamówieniach tego konta (nie dowolny tekst z formularza). Zmiana
 * jednego pola konfiguracji z wpisem w historii zmian; ten sam klucz = bez zapisu.
 */
export async function uzyjPolaMeta(db: PrismaClient, ref: KontoRef, pole: string, klucz: string, opts: KontoOpts): Promise<'ZMIENIONO' | 'BEZ_ZMIAN'> {
  if (!czyPoleMeta(pole)) throw new KontoError('Nieznane pole zamówienia')
  const row = await loadConfig(db, ref)
  const m = manifestOf(opts.registry, row.adapterKey)
  if (!m.config.some((f) => f.key === pole)) throw new KontoError('Ten rodzaj konta nie ma takiego pola')
  const status = await db.channelAccountStatus.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId }, select: { testMetaKeys: true } })
  const wykryte = wykryteZBazy(status?.testMetaKeys)
  if (!wykryte?.keys.some((k) => k.key === klucz)) throw new KontoError('Tego pola nie było w ostatnich zamówieniach. Sprawdź połączenie jeszcze raz albo wpisz nazwę w „Zaawansowane”.')
  const before = asObject(row.config)
  if (before[pole] === klucz) return 'BEZ_ZMIAN'
  const { config, problems } = validateAccountConfig(m, { ...before, [pole]: klucz })
  if (problems.length) throw new KontoError(`Popraw ustawienia: ${problems.join('; ')}`)
  const after = { ...before, ...config, [pole]: klucz }
  await db.$transaction(async (tx) => {
    await tx.channelConfig.update({
      where: { organizationId_channel_channelAccountId: { organizationId: row.organizationId, channel: ref.channel, channelAccountId: ref.channelAccountId } },
      data: { config: after as Prisma.InputJsonValue },
    })
    await audit(tx, ref, opts.actorId, { [pole]: before[pole] ?? null }, { [pole]: klucz, zrodlo: 'wykryte w zamówieniach' })
  })
  return 'ZMIENIONO'
}
