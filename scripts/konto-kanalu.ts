// Konto kanału bez ekranu w panelu: dodanie konta sklepu (ChannelConfig) i test połączenia przez adapter
// z rejestru. Ogólne — działa dla każdego adaptera kanału (Shoper, PrestaShop, Woo). Sekrety konta osobno, przez
// `npm run sekret -- … --konto KANAŁ/<id>` (wartości nigdy w argumentach). Wynik bez sekretów i danych klientów.
//   npm run konto -- dodaj --firma <slug> --kanal SHOPER --konto <id> --nazwa "<nazwa>" --adapter shoper.rest.v1 \
//                         --config baseUrl=https://sklep.pl [--config pageSize=50 …]
//   npm run konto -- test --firma <slug> --konto SHOPER/<id>
//   npm run konto -- rodzaj --firma <slug> --konto EMPIK/<id> --na zapis|odczyt
//     (wersja tylko do odczytu ↔ z zapisem za wyłącznikiem tej samej rodziny; klucz API, ustawienia i kursor
//     zamówień zostają, zapis do sklepu po zmianie wyłączony; to samo co przycisk na ekranie konta, wpis w dzienniku zmian)
// Istniejące konto = odmowa (zmiany konta to inne polecenie, nie nadpisanie po cichu).
import 'dotenv/config'
import type { Channel, Prisma, PrismaClient } from '@prisma/client'
import { DEFAULT_CHANNEL_ADAPTER } from '../lib/adaptery'
import { defaultRegistry } from '../lib/adaptery/domyslne'
import { type ChannelAccountSettings, createAccountAdapter, loadChannelAccounts } from '../lib/adaptery/konta'
import type { ChannelAdapter } from '../lib/adaptery/kontrakt'
import { type AdapterRegistry, validateAccountConfig } from '../lib/adaptery/rejestr'
import type { SecretSource } from '../lib/sekrety'
import type { FetchLike } from '../lib/zrodla/http'
import { type RodzajKonta, zmienRodzajKonta } from '../lib/kanaly/zapis-host'

export interface DodajArgs {
  kanal: string
  konto: string
  nazwa: string
  adapter: string
  /** Pary z `--config klucz=wartość` (typy sprawdza manifest adaptera). */
  config: Record<string, string>
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Argumenty `--nazwa wartość` (powtarzalne `--config`). */
export function parseArgs(argv: readonly string[]): { cmd: string | undefined; opts: Record<string, string>; config: Record<string, string> } {
  const opts: Record<string, string> = {}
  const config: Record<string, string> = {}
  let cmd: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) {
      cmd ??= a
      continue
    }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`Brak wartości dla ${a}`)
    i++
    if (a === '--config') {
      const eq = v.indexOf('=')
      if (eq <= 0) throw new Error(`--config w formacie klucz=wartość (jest „${v.slice(0, 40)}”)`)
      config[v.slice(0, eq)] = v.slice(eq + 1)
    } else opts[a.slice(2)] = v
  }
  return { cmd, opts, config }
}

function channelOf(kanal: string): Channel {
  if (!(kanal in DEFAULT_CHANNEL_ADAPTER)) throw new Error(`Nieznany kanał „${kanal}” (dozwolone: ${Object.keys(DEFAULT_CHANNEL_ADAPTER).join(', ')})`)
  return kanal as Channel
}

/** Konto „KANAŁ/id” → części. */
export function parseAccountRef(ref: string): { channel: Channel; channelAccountId: string } {
  const [kanal, id, ...rest] = ref.split('/')
  if (!kanal || !id || rest.length) throw new Error('--konto w formacie KANAŁ/konto, np. SHOPER/sklep1')
  return { channel: channelOf(kanal), channelAccountId: id }
}

/** Część bazy potrzebna do dodania konta (klient firmy z RLS albo atrapa w teście). */
export type KontaDb = Pick<PrismaClient, 'channelConfig'>

/** Dodaje konto kanału firmy klienta `db`. Zwraca linie do wypisania; błąd walidacji albo istniejące konto = wyjątek. */
export async function dodajKonto(db: KontaDb, registry: AdapterRegistry, a: DodajArgs, firma: string): Promise<string[]> {
  const channel = channelOf(a.kanal)
  if (!ACCOUNT_ID_RE.test(a.konto)) throw new Error('--konto: litery, cyfry, „_”, „.”, „-” (do 64 znaków), bez „/”')
  const nazwa = a.nazwa.trim()
  if (!nazwa) throw new Error('Podaj --nazwa (nazwa konta widoczna w panelu)')
  const def = registry.get(a.adapter)
  if (!def) throw new Error(`Nieznany adapter „${a.adapter}” (w rejestrze: ${registry.list().map((m) => m.adapterKey).join(', ')})`)
  if (def.manifest.kind !== 'channel' || def.manifest.channel !== channel) throw new Error(`Adapter ${a.adapter} nie jest adapterem kanału ${channel}`)
  const unknown = Object.keys(a.config).filter((k) => !def.manifest.config.some((f) => f.key === k))
  if (unknown.length) throw new Error(`Adapter ${a.adapter} nie zna ustawień: ${unknown.join(', ')}`)
  const v = validateAccountConfig(def.manifest, a.config)
  if (v.problems.length) throw new Error(`Złe ustawienia konta: ${v.problems.join('; ')}`)
  const existing = await db.channelConfig.findFirst({ where: { channel, channelAccountId: a.konto }, select: { name: true } })
  if (existing) throw new Error(`Konto ${channel}/${a.konto} już istnieje („${existing.name}”) — nic nie zmieniono`)
  await db.channelConfig.create({ data: { channel, channelAccountId: a.konto, name: nazwa, adapterKey: a.adapter, config: v.config as Prisma.InputJsonValue, active: true } })
  const lines = [`[konto] dodane ${channel}/${a.konto} „${nazwa}”, adapter ${a.adapter}, ustawienia: ${Object.keys(v.config).join(', ') || '(brak)'}`]
  if (def.manifest.secrets.length) {
    lines.push(`[konto] sekrety konta (wymagane: ${def.manifest.secrets.filter((s) => s.required).map((s) => s.name).join(', ') || 'wg opisu adaptera'}):`)
    for (const s of def.manifest.secrets)
      lines.push(`  npm run sekret -- --firma ${firma} --ustaw ${s.name} --z-env ${s.name} --konto ${channel}/${a.konto}   # ${s.description}`)
  }
  lines.push(`[konto] potem: npm run konto -- test --firma ${firma} --konto ${channel}/${a.konto}`)
  return lines
}

export interface TestDeps {
  loadAccounts?: () => Promise<ChannelAccountSettings[]>
  createAdapter?: (acc: ChannelAccountSettings) => Promise<ChannelAdapter>
}

/** Test połączenia konta: adapter z rejestru + testConnection. Kod 0 = OK. Bez sekretów w wyniku. */
export async function testKonta(
  db: PrismaClient,
  registry: AdapterRegistry,
  src: SecretSource,
  ref: string,
  opts: { fetch?: FetchLike } & TestDeps = {},
): Promise<{ code: number; lines: string[] }> {
  const { channel, channelAccountId } = parseAccountRef(ref)
  const accounts = await (opts.loadAccounts ?? (() => loadChannelAccounts(db, { activeOnly: false })))()
  const acc = accounts.find((a) => a.channel === channel && a.channelAccountId === channelAccountId)
  if (!acc) return { code: 1, lines: [`[konto] nie ma konta ${channel}/${channelAccountId} w tej firmie`] }
  const label = `${acc.name} (${channel}/${channelAccountId}, ${acc.adapterKey})`
  let adapter: ChannelAdapter
  try {
    adapter = await (opts.createAdapter ?? ((a) => createAccountAdapter(db, registry, a, src, { fetch: opts.fetch })))(acc)
  } catch (e) {
    // AdapterConfigError niesie tylko nazwy pól i sekretów, nigdy wartości
    return { code: 1, lines: [`[konto] ${label}: nie da się utworzyć adaptera — ${e instanceof Error ? e.message : 'błąd'}`] }
  }
  const t = await adapter.testConnection()
  const lines = [`[konto] ${label}: ${t.ok ? 'OK' : 'BŁĄD'} — ${t.message}${t.details ? ' ' + JSON.stringify(t.details) : ''}`]
  if (!acc.active) lines.push('[konto] uwaga: konto nieaktywne — odczyt zamówień go pomija')
  return { code: t.ok ? 0 : 1, lines }
}

/** `rodzaj` — zmiana rodzaju konta (tylko odczyt ↔ z zapisem). Zwraca linie do wypisania. */
export async function rodzajKonta(db: PrismaClient, registry: AdapterRegistry, ref: string, na: string, actorId = 'cli:konto'): Promise<string[]> {
  if (na !== 'zapis' && na !== 'odczyt') throw new Error('--na zapis albo --na odczyt')
  const acc = parseAccountRef(ref)
  const before = await db.channelConfig.findFirst({ where: acc, select: { adapterKey: true } })
  if (!before) throw new Error(`Nie ma konta ${ref} w tej firmie`)
  const key = await zmienRodzajKonta(db, acc, na as RodzajKonta, { registry, actorId })
  if (key === before.adapterKey) return [`[konto] ${ref}: bez zmian, rodzaj już ${na === 'zapis' ? 'z zapisem' : 'tylko do odczytu'} (${key})`]
  return [
    `[konto] ${ref}: ${before.adapterKey} → ${key}; klucz API, ustawienia i odczyt zamówień bez zmian, zapis do sklepu wyłączony`,
    ...(na === 'zapis' ? ['[konto] zapis włączasz w panelu: Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → „Zapis do sklepu”'] : []),
  ]
}

async function main(): Promise<number> {
  const { createOrgClient, createSystemClient } = await import('../lib/db')
  const { envSecretsAllowed, listActiveOrganizations } = await import('../lib/organizacje')
  const { cmd, opts, config } = parseArgs(process.argv.slice(2))
  if (cmd !== 'dodaj' && cmd !== 'test' && cmd !== 'rodzaj') throw new Error('Polecenie: dodaj, test albo rodzaj (npm run konto -- dodaj|test|rodzaj --firma <slug> …)')
  const slug = opts['firma']
  if (!slug) throw new Error('Podaj --firma <slug>')
  const sys = createSystemClient({ poolMax: 1 })
  const orgs = await listActiveOrganizations(sys).finally(() => sys.$disconnect())
  const org = orgs.find((o) => o.slug === slug)
  if (!org) throw new Error(`Nie ma aktywnej firmy ${slug}`)
  const db = createOrgClient(org.id, { poolMax: 1 })
  try {
    const registry = defaultRegistry()
    if (cmd === 'dodaj') {
      const need = ['kanal', 'konto', 'nazwa', 'adapter'].filter((k) => !opts[k])
      if (need.length) throw new Error(`Brak: ${need.map((k) => `--${k}`).join(', ')}`)
      for (const l of await dodajKonto(db, registry, { kanal: opts['kanal']!, konto: opts['konto']!, nazwa: opts['nazwa']!, adapter: opts['adapter']!, config }, slug)) console.log(l)
      return 0
    }
    if (!opts['konto']) throw new Error('Podaj --konto KANAŁ/konto')
    if (cmd === 'rodzaj') {
      for (const l of await rodzajKonta(db, registry, opts['konto'], opts['na'] ?? '')) console.log(l)
      return 0
    }
    const r = await testKonta(db, registry, { env: process.env, envFallback: envSecretsAllowed(process.env, org, orgs.length) }, opts['konto'])
    for (const l of r.lines) console.log(l)
    return r.code
  } finally {
    await db.$disconnect()
  }
}

// uruchomione jako skrypt (npm run konto), nie przy imporcie w teście
if (/konto-kanalu\.ts$/.test(process.argv[1] ?? ''))
  main().then(
    (c) => process.exit(c),
    (e: unknown) => {
      console.error('[konto] błąd:', e instanceof Error ? e.message : e)
      process.exit(1)
    },
  )
