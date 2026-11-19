// Import katalogu, stanów startowych i powiązań ofert z BL + zgodność z wFirmą. Wszystko TYLKO DO ODCZYTU ze źródeł.
//
//   npm run import:katalog -- [--firma <slug>] [--raport <katalog>] [--zapisz-zrzut <plik.json>] [--z-zrzutu <plik.json>]
//                             [--bez-bazy] [--dni N] [--klucze-z <mapa.json>]
//
// --dni: okno sprzedaży BL; domyślnie i najwyżej KATALOG_IMPORT_DNI_SPRZEDAZY (puste = 0 = bez zamówień BL, bez danych
// klientów). Więcej niż sufit = błąd; lokalnie, żeby raport liczył sprzedaż, ustaw np. KATALOG_IMPORT_DNI_SPRZEDAZY=90.
//
// --firma: firma, do której idzie import; domyślnie SELFHOST_ORG_SLUG albo jedyna firma w bazie.
// Konfiguracja (inventory BL, magazyn wFirmy, sklepy, konto Empik) z bazy firmy; klucze z jej sekretów, w self-hoście
// jednofirmowym także z env. Tabela nadpisań: dane/nadpisania-ofert/<id firmy>.csv.
//
// --klucze-z <mapa.json> (albo env KLUCZE_LOKALNE): brakujące klucze z plików .env innych projektów wg mapy trzymanej
// poza repo (scripts/klucze-lokalne.ts), bez kopiowania ich do tego repo i bez wypisywania wartości.
// Zrzut (--zapisz-zrzut) zawiera dane produktów i linie sprzedaży (produkt, ilość, id zamówienia BL) —
// bez danych klientów; i tak trzymaj go poza repo: sama nazwa pliku ląduje w %LOCALAPPDATA%logistykazrzuty,
// ścieżka wewnątrz repo jest odrzucana.
// Brak kluczy któregoś źródła bez --bez-bazy = kod wyjścia 1 (niepełny przebieg wyłączałby oferty — przegląd r2, uwaga 3).
import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { createOrgClient, createSystemClient } from '../lib/db'
import type { CatalogRules } from '../lib/import/bez-stanu'
import { analyze, collectSources, type RawSources } from '../lib/import/katalog'
import { loadOfferOverrides } from '../lib/import/nadpisania'
import { dniSprzedazyZEnv, dniZArgumentu } from '../lib/import/okno-sprzedazy'
import type { ChannelMap } from '../lib/import/normalizacja'
import { renderReport } from '../lib/import/raport'
import { persistImport } from '../lib/import/zapis'
import { clientsForOrg, type Env } from '../lib/konfiguracja'
import { channelMapOf, envSecretsAllowed, listActiveOrganizations, loadCatalogRules, loadImportConfig } from '../lib/organizacje'
import { envWithLocalKeys } from './klucze-lokalne'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(name)

function reviveRaw(json: string): RawSources {
  const raw = JSON.parse(json) as RawSources
  for (const l of raw.sales.lines) l.soldAt = new Date(l.soldAt as unknown as string)
  return raw
}

/** Zrzut poza repo: sama nazwa → katalog lokalny użytkownika; ścieżka w repo → błąd. */
function dumpPath(requested: string, repoRoot = process.cwd()): string {
  const base = process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'logistyka', 'zrzuty') : path.join(os.homedir(), '.logistyka', 'zrzuty')
  const abs = path.basename(requested) === requested ? path.join(base, requested) : path.resolve(requested)
  const rel = path.relative(path.resolve(repoRoot), abs)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`zrzut ${abs} wewnątrz repo — podaj ścieżkę poza repo albo samą nazwę pliku (${base})`)
  return abs
}

type OrgPick = { id: string; slug: string; envFallback: boolean }

async function pickOrganization(env: Env): Promise<OrgPick> {
  const sys = createSystemClient({ poolMax: 1 })
  try {
    const orgs = await listActiveOrganizations(sys)
    const slug = arg('--firma') ?? env['SELFHOST_ORG_SLUG']
    const org = slug ? orgs.find((o) => o.slug === slug) : orgs.length === 1 ? orgs[0] : undefined
    if (!org) throw new Error(slug ? `Nie ma aktywnej firmy ${slug}` : `Wskaż firmę (--firma), aktywnych: ${orgs.length}`)
    return { id: org.id, slug: org.slug, envFallback: envSecretsAllowed(env, org, orgs.length) }
  } finally {
    await sys.$disconnect()
  }
}

async function main(): Promise<number> {
  const env = envWithLocalKeys(process.env as Env, arg('--klucze-z') ?? process.env['KLUCZE_LOKALNE'])
  const fromDump = arg('--z-zrzutu')
  const noDb = flag('--bez-bazy')
  // Bez bazy da się tylko przeliczyć zrzut, który niesie kanały firmy (zrzuty).
  const org = noDb && fromDump ? null : await pickOrganization(env)
  const db: PrismaClient | null = org ? createOrgClient(org.id, { poolMax: 2 }) : null
  try {
    return await run(env, fromDump, noDb, org, db)
  } finally {
    await db?.$disconnect()
  }
}

async function run(env: Env, fromDump: string | undefined, noDb: boolean, org: OrgPick | null, db: PrismaClient | null): Promise<number> {
  const dumpOutArg = arg('--zapisz-zrzut')
  const dumpOut = dumpOutArg ? dumpPath(dumpOutArg) : undefined
  let raw: RawSources
  let channels: ChannelMap
  let rules: CatalogRules | undefined
  if (fromDump) {
    raw = reviveRaw(await readFile(fromDump, 'utf8'))
    if (!raw.channels) {
      // zrzut nie ma kanałów firmy — bierzemy je z konfiguracji firmy w bazie
      if (!db) throw new Error('Zrzut bez kanałów firmy (stary format) — podaj --firma zamiast --bez-bazy')
      raw.channels = channelMapOf(await loadImportConfig(db))
    }
    channels = raw.channels
    // reguły katalogu zawsze bieżące z bazy firmy; bez bazy — bez reguł
    rules = db ? await loadCatalogRules(db) : undefined
    console.log(`[import] dane ze zrzutu ${fromDump} (pobrane ${raw.fetchedAt})`)
  } else {
    // Okno sprzedaży przed pierwszym odczytem API: --dni ponad sufit = błąd.
    const salesDays = dniZArgumentu(arg('--dni'), dniSprzedazyZEnv(env))
    const c = await clientsForOrg(db!, { env, envFallback: org!.envFallback })
    channels = channelMapOf(c.config)
    rules = c.config.catalog
    if (c.missing.length) {
      if (!noDb) {
        console.error(`[import] brak kluczy: ${c.missing.join(', ')} — zapis do bazy odrzucony (sekrety firmy, .env albo --bez-bazy)`)
        return 1
      }
      console.warn(`[import] brak kluczy: ${c.missing.join(', ')} — te źródła pominięte (tylko raport, bez bazy)`)
    }
    if (c.missingOptional.length) console.warn(`[import] brak kluczy: ${c.missingOptional.join(', ')} — Empik pominięty, jego oferty nie są wyłączane`)
    const zamowienia = salesDays
      ? `zamówienia BL (${salesDays} dni)`
      : 'bez zamówień BL (KATALOG_IMPORT_DNI_SPRZEDAZY=0: raport bez sprzedaży, oferty nie będą wyłączane)'
    console.log(`[import] firma ${org!.slug}: pobieram BL katalog, sklepy Woo (przez BL), ${zamowienia}, wFirma, Empik — tylko odczyt…`)
    raw = await collectSources({
      bl: c.bl,
      wfirma: c.wfirma,
      empik: c.empik,
      inventoryId: c.config.inventoryId,
      salesDays,
      wfirmaWarehouseId: c.config.wfirmaWarehouseId,
      shopStorages: c.config.shops.map((x) => x.storageId),
      channels,
    })
  }
  const overrides = org ? loadOfferOverrides(org.id, new Set(Object.keys(channels.names ?? {}))) : []
  if (dumpOut) {
    await mkdir(path.dirname(dumpOut), { recursive: true })
    await writeFile(dumpOut, JSON.stringify(raw), 'utf8')
    console.log(`[import] zrzut: ${dumpOut}`)
  }
  const a = analyze(raw, overrides, rules)
  let runId: string | undefined
  if (!noDb && db) {
    const stats = await persistImport(db, raw, a)
    runId = stats.runId
    console.log('[import] baza:', JSON.stringify(stats))
  }
  const dir = arg('--raport')
  if (dir) {
    const rep = renderReport(raw, a, { generatedAt: new Date(), runId })
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'raport-mapowania.md'), rep.markdown, 'utf8')
    for (const [name, body] of Object.entries(rep.csv)) await writeFile(path.join(dir, name), '\ufeff' + body, 'utf8')
    console.log(`[import] raport: ${path.join(dir, 'raport-mapowania.md')} + ${Object.keys(rep.csv).length} CSV`)
  }
  console.log(
    `[import] BL ${raw.bl.products.length}, wFirma ${raw.wfirma?.goods.length ?? 0}, oferty ${a.offers.length}, ` +
      `produkty ${a.plan.products.length}, problemy pobierania ${raw.issues.length}`,
  )
  return raw.issues.length ? 2 : 0
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('[import] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
