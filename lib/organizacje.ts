// Firmy (organizacje) i ich konfiguracja w bazie. Zakładanie firmy i preset konfiguracji to kod
// systemowy (klient systemowy z lib/db.ts, jawne organizationId); odczyt konfiguracji robi klient firmy (RLS).
import type { Channel, OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { assertAdapterKey, DEFAULT_CHANNEL_ADAPTER } from './adaptery'
import { NonRetryableError } from './bledy'
import { appModeOf, assertOrgId, type AppMode } from './db'
import { parseCatalogRules, type CatalogRules } from './import/bez-stanu'
import { bezpiecznyAdresZdjecia } from './produkty/zdjecia-url'
import type { ChannelMap } from './import/normalizacja'
import { type CarrierRuleT, DEFAULT_CARRIER_RULES, validateCarrierRule } from './rdzen/przewoznicy'
import { DEFAULT_POLICY } from './rdzen/polityka'
import { DEFAULT_WAREHOUSE } from './rdzen/stan'
import { type PickupScheduleT, validateSchedule } from './pakowanie/harmonogram'
import { LEGACY_ZONES, type ZoneDefT, type ZoneRuleT, validateZoneDef, validateZoneRule } from './pakowanie/strefy'
import type { UstawieniaDokumentowJson } from './dokumenty/ustawienia'
import { DOMYSLNE_GRUPY_STATUSOW, DOMYSLNE_STATUSY, type GrupaStatusowT, type StatusFirmyT, validateZestawStatusow } from './panel/statusy'
import type { UstawieniaFirmy } from './firma/profil'
import type { UstawieniaFaktur } from './wfirma/konfiguracja'
import { parsujRegulyPresetu, type GrupaPresetuT, type RegulaPresetuT } from './automaty/szablon'
import { zastosujAutomatyPresetu } from './automaty/preset'

/**
 * Ustawienia firmy niebędące sekretami (Organization.settings). `catalog` (czyta `parseCatalogRules`):
 * `{ noStock: { skus: [...], shopCategories: ["<konto>:<kategoria>"] }, nonOfferSkus: [...] }`.
 */
export interface OrgSettings {
  /** `statusy`: mapa statusów BL zapisana przez przeprowadzkę, czyta `loadBlStatusMap`. */
  baselinker?: { inventoryId?: string; statusy?: BlStatusMap }
  catalog?: { noStock?: { skus?: string[]; shopCategories?: string[] }; nonOfferSkus?: string[] }
  /**
   * czyta `parseKonfiguracjaFaktur` (lib/wfirma/konfiguracja.ts). Program do faktur i zasady
   * wystawiania (`parseUstawieniaDokumentow`, lib/dokumenty/ustawienia.ts).
   */
  faktury?: UstawieniaFaktur & UstawieniaDokumentowJson
  /** profil firmy (Ustawienia → Dane firmy), czyta `parseProfilFirmy` (lib/firma/profil.ts). */
  firma?: UstawieniaFirmy
  /**
   * feedy produktowe (Google Merchant XML) do zdjęć produktów (Produkty → „Zdjęcia z feedu”), czyta
   * `czytajFeedy` (lib/produkty/zdjecia-feed.ts). `konto` = sklep feedu „KANAŁ:konto” (opcjonalnie).
   */
  feedyProduktowe?: { adresy: { url: string; konto?: string }[] }
}

export function parseOrgSettings(v: Prisma.JsonValue | null | undefined): OrgSettings {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const bl = o['baselinker'] && typeof o['baselinker'] === 'object' ? (o['baselinker'] as Record<string, unknown>) : undefined
  const inventoryId = bl && typeof bl['inventoryId'] === 'string' && bl['inventoryId'].trim() ? bl['inventoryId'].trim() : undefined
  return inventoryId ? { baselinker: { inventoryId } } : {}
}

/** id statusu BL → status Kompletora (przeprowadzka z BL, lib/przeprowadzka/statusy.ts). */
export type BlStatusMap = Record<string, { status: OrderStatus; nazwa: string; pewnosc: string; /** klucz statusu firmy z BL */ klucz?: string }>

/** Mapa statusów BL firmy (Organization.settings.baselinker.statusy); brak albo zły wpis = pominięty. */
export async function loadBlStatusMap(db: PrismaClient): Promise<BlStatusMap> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const o = org?.settings && typeof org.settings === 'object' && !Array.isArray(org.settings) ? (org.settings as Record<string, unknown>) : {}
  const bl = o['baselinker'] && typeof o['baselinker'] === 'object' ? (o['baselinker'] as Record<string, unknown>) : {}
  const raw = bl['statusy'] && typeof bl['statusy'] === 'object' && !Array.isArray(bl['statusy']) ? (bl['statusy'] as Record<string, unknown>) : {}
  const out: BlStatusMap = {}
  for (const [id, v] of Object.entries(raw)) {
    const e = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    if (e && typeof e['status'] === 'string' && typeof e['nazwa'] === 'string') out[id] = { status: e['status'] as OrderStatus, nazwa: e['nazwa'], pewnosc: String(e['pewnosc'] ?? ''), ...(typeof e['klucz'] === 'string' ? { klucz: e['klucz'] } : {}) }
  }
  return out
}

export interface ChannelPreset {
  channel: Channel
  channelAccountId: string
  name: string
  blStorageId?: string | null
  /** Domyślnie adapter rodziny kanału (lib/adaptery.ts). */
  adapterKey?: string
  config?: Prisma.InputJsonValue
  /**
   * Domyślnie true. false = konto zakładane jako nieaktywne (sklep wyłączany, bez odczytu cienia). Dotyczy tylko
   * nowych wierszy: istniejącego konta preset nie włącza ani nie wyłącza (to robi panel albo migracja danych).
   */
  active?: boolean
}

export interface WarehousePreset {
  id: string
  name: string
  wfirmaWarehouseId?: string | null
  /** źródło stanu; brak = wywnioskowane z wfirmaWarehouseId (lib/rdzen/zrodlo-stanu.ts). */
  stockSource?: 'KOMPLETOR' | 'WFIRMA'
}

export interface OrgPreset {
  id: string
  slug: string
  name: string
  settings?: OrgSettings
  warehouses?: WarehousePreset[]
  channels?: ChannelPreset[]
  carrierRules?: CarrierRuleT[]
  /** godziny odbiorów przewoźników i reguły stref magazynu (tylko gdy firma nie ma żadnych). */
  carrierPickups?: PickupScheduleT[]
  zoneRules?: ZoneRuleT[]
  /**
   * strefy magazynu firmy (tylko gdy firma nie ma żadnych). Preset bez `zones` z regułami na klucze dawnego
   * enuma (HERBATY_KAWY, BOMBY_AKCESORIA) dostaje te dwie strefy jak dotąd (zgodność presetów sprzed zmiany).
   */
  zones?: ZoneDefT[]
  /**
   * statusy firmy i ich grupy (tylko gdy firma nie ma żadnych statusów). Preset bez `statuses` dostaje
   * neutralne statusy (DOMYSLNE_STATUSY, po jednym na status rdzenia).
   */
  statusGroups?: GrupaStatusowT[]
  statuses?: (Omit<StatusFirmyT, 'carriers' | 'active' | 'customerName' | 'groupKey'> & Partial<Pick<StatusFirmyT, 'carriers' | 'active' | 'customerName' | 'groupKey'>>)[]
  /**
   * (format wspólny): grupy i reguły automatycznych akcji (lib/automaty/szablon.ts), zakładane
   * tylko firmie bez żadnej reguły. Reguły walidowane na statusach presetu.
   */
  automationGroups?: GrupaPresetuT[]
  automationRules?: RegulaPresetuT[]
}

/** Statusy i grupy, które preset zakłada: własne albo neutralne domyślne (pola opcjonalne uzupełnione). */
export function presetStatusy(p: Pick<OrgPreset, 'statuses' | 'statusGroups'>): { grupy: GrupaStatusowT[]; statusy: StatusFirmyT[] } {
  if (!p.statuses) return { grupy: DOMYSLNE_GRUPY_STATUSOW.map((g) => ({ ...g })), statusy: DOMYSLNE_STATUSY.map((x) => ({ ...x, carriers: [...x.carriers] })) }
  return {
    grupy: (p.statusGroups ?? []).map((g) => ({ key: g.key, name: g.name, sortOrder: g.sortOrder, collapsed: g.collapsed ?? false })),
    statusy: p.statuses.map((x) => ({ ...x, customerName: x.customerName ?? null, groupKey: x.groupKey ?? null, carriers: [...(x.carriers ?? [])], active: x.active ?? true })),
  }
}

/** Strefy, które preset zakłada: jawne `zones` albo dawne dwie, gdy reguły ich używają. */
export function presetZones(p: Pick<OrgPreset, 'zones' | 'zoneRules'>): ZoneDefT[] {
  if (p.zones) return p.zones
  return p.zoneRules?.length ? LEGACY_ZONES.map((z) => ({ ...z })) : []
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export function validatePreset(p: OrgPreset): void {
  assertOrgId(p.id)
  if (!SLUG_RE.test(p.slug)) throw new Error(`Zły slug firmy „${p.slug}” (małe litery, cyfry, myślnik)`)
  if (!p.name.trim()) throw new Error('Brak nazwy firmy')
  for (const c of p.channels ?? []) {
    if (!c.channelAccountId.trim()) throw new Error(`Kanał ${c.channel} bez channelAccountId`)
    if (c.adapterKey) assertAdapterKey(c.adapterKey)
  }
  for (const r of p.carrierRules ?? []) validateCarrierRule(r)
  // adres feedu ta sama osłona co przy odczycie (https, bez IP i nazw wewnętrznych): preset z literówką pada
  // głośno przy seedzie, a nie cicho przy pierwszym przebiegu
  for (const f of p.settings?.feedyProduktowe?.adresy ?? []) if (!bezpiecznyAdresZdjecia(f.url)) throw new Error(`Preset: zły adres feedu produktowego „${f.url.slice(0, 80)}” (tylko https://…)`)
  for (const s of p.carrierPickups ?? []) validateSchedule(s)
  const zones = presetZones(p)
  for (const z of zones) validateZoneDef(z)
  if (new Set(zones.map((z) => z.key)).size !== zones.length) throw new Error('Preset: powtórzony klucz strefy')
  for (const r of p.zoneRules ?? []) validateZoneRule(r, zones.map((z) => z.key))
  const st = presetStatusy(p)
  try {
    validateZestawStatusow(st.statusy, st.grupy)
  } catch (e) {
    throw new Error(`Preset: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (p.automationGroups || p.automationRules) {
    try {
      parsujRegulyPresetu(p.automationGroups, p.automationRules, st.statusy)
    } catch (e) {
      throw new Error(`Preset: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

function hasKey(v: Prisma.JsonValue | null | undefined, key: string): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && key in v
}

export interface ApplyStats {
  created: boolean
  warehouses: number
  channels: number
  carrierRules: number
  /** Konta, którym preset uzupełnił puste klucze `config`. */
  channelSettings: number
  /** reguły automatycznych akcji założone z presetu (tylko firmie bez reguł). */
  automationRules?: number
  /** reguły presetu, które nie powstały (status firmy nie pasuje, limit), z powodem. */
  automationSkipped?: string
  /** liczba reguł presetu, które nie powstały. */
  automationErrors?: number
}

const isEmptySetting = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/**
 * Ustawienia konta z presetu dopisane tylko tam, gdzie klucz jest pusty (brak, null, pusty tekst) — wartość
 * zmieniona ręcznie (panel, `cien -- test`) zostaje. Zwraca nowe ustawienia albo null, gdy nie ma czego uzupełniać.
 */
export function fillMissingSettings(current: unknown, preset: Record<string, unknown>): Record<string, unknown> | null {
  const cur = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
  const missing = Object.entries(preset).filter(([k, v]) => isEmptySetting(cur[k]) && !isEmptySetting(v))
  return missing.length ? { ...cur, ...Object.fromEntries(missing) } : null
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isEmptyCatalogValue = (v: unknown) => isEmptySetting(v) || (Array.isArray(v) && v.length === 0)

/**
 * `catalog` firmy uzupełniony z presetu podklucz po podkluczu, także w `noStock`: tylko tam, gdzie brak albo pusta
 * lista (`nonOfferSkus: []` z wcześniejszego presetu). Niepusta lista firmy zostaje.
 * listę `noStock` edytuje panel (Produkty i stany → Produkty bez stanu); po zapisie z panelu `catalog.edytowanoWPanelu
 * = true` i wtedy preset nie uzupełnia `noStock` — lista wyczyszczona w panelu ma zostać pusta (pozostałe klucze tak). Zwraca nowy `catalog`
 * albo null, gdy nie ma czego uzupełniać.
 */
export function fillMissingCatalog(current: unknown, preset: Record<string, unknown>): Record<string, unknown> | null {
  const cur = isPlainObject(current) ? current : {}
  // flaga zamraża tylko listę edytowaną w panelu (`noStock`), reszta (`nonOfferSkus`) dalej z presetu
  const frozenNoStock = cur['edytowanoWPanelu'] === true
  const filled: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(preset)) {
    if (frozenNoStock && k === 'noStock') continue
    if (isPlainObject(v)) {
      const sub = fillMissingCatalog(cur[k], v)
      if (sub) filled[k] = sub
    } else if (isEmptyCatalogValue(cur[k]) && !isEmptyCatalogValue(v)) filled[k] = v
  }
  return Object.keys(filled).length ? { ...cur, ...filled } : null
}

/**
 * Zakłada firmę albo uzupełnia jej brakującą konfigurację (idempotentnie). Niczego nie nadpisuje: tryby kanałów,
 * nazwy i reguły zmienia panel; preset tylko zakłada brakujące wiersze. Reguły przewoźników — tylko gdy firma
 * nie ma żadnej (inaczej zmiana w panelu zostałaby rozjechana z presetem). Ustawienia istniejącego konta (`config`)
 * preset uzupełnia klucz po kluczu, tylko puste (konta nie miały baseUrl ani envPrefix).
 * `catalog` firmy tak samo, podklucz po podkluczu (`fillMissingCatalog`).
 */
export async function applyOrgPreset(sys: PrismaClient, p: OrgPreset): Promise<ApplyStats> {
  validatePreset(p)
  return sys.$transaction((tx) => applyOrgPresetTx(tx, p))
}

/**
 * To samo co `applyOrgPreset`, w transakcji wywołującego (kreator pierwszego uruchomienia zakłada firmę
 * i konto właściciela w jednej transakcji pod blokadą).
 */
export async function applyOrgPresetTx(tx: Prisma.TransactionClient, p: OrgPreset): Promise<ApplyStats> {
  validatePreset(p)
  return (async () => {
    const stats: ApplyStats = { created: false, warehouses: 0, channels: 0, carrierRules: 0, channelSettings: 0 }
    const existing = await tx.organization.findUnique({ where: { id: p.id } })
    if (!existing) {
      await tx.organization.create({ data: { id: p.id, slug: p.slug, name: p.name, settings: (p.settings ?? {}) as Prisma.InputJsonValue } })
      stats.created = true
    } else if (existing.slug !== p.slug) throw new Error(`Firma ${p.id} ma slug „${existing.slug}”, preset „${p.slug}”`)
    else if (p.settings) {
      // ustawienia z presetu tylko tam, gdzie firma nic nie ma (zmiany z panelu wygrywają): klucz po kluczu na surowym
      // JSON, żeby `catalog` czy `akcje` firmy bez `baselinker` nie zginęły;
      // `baselinker` bez inventoryId liczy się jako brak
      const raw = existing.settings
      const cur = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Prisma.JsonValue>) : {}
      const missing = Object.entries(p.settings).filter(
        ([k, v]) => v !== undefined && k !== 'catalog' && (k === 'baselinker' ? !parseOrgSettings(existing.settings).baselinker : !hasKey(existing.settings, k)),
      )
      const catalog = p.settings.catalog ? fillMissingCatalog(cur['catalog'], p.settings.catalog) : null
      if (catalog) missing.push(['catalog', catalog as OrgSettings['catalog']])
      if (missing.length) await tx.organization.update({ where: { id: p.id }, data: { settings: { ...cur, ...Object.fromEntries(missing) } as Prisma.InputJsonValue } })
    }
    const organizationId = p.id
    for (const w of p.warehouses ?? [{ id: DEFAULT_WAREHOUSE, name: 'Główny' }]) {
      const r = await tx.warehouse.createMany({ data: [{ organizationId, id: w.id, name: w.name, wfirmaWarehouseId: w.wfirmaWarehouseId ?? null, stockSource: w.stockSource ?? (w.wfirmaWarehouseId ? 'WFIRMA' : 'KOMPLETOR') }], skipDuplicates: true })
      stats.warehouses += r.count
    }
    for (const c of p.channels ?? []) {
      const r = await tx.channelConfig.createMany({
        data: [
          {
            organizationId,
            channel: c.channel,
            channelAccountId: c.channelAccountId,
            name: c.name,
            blStorageId: c.blStorageId ?? null,
            adapterKey: c.adapterKey ?? DEFAULT_CHANNEL_ADAPTER[c.channel],
            config: c.config ?? {},
            active: c.active ?? true,
          },
        ],
        skipDuplicates: true,
      })
      stats.channels += r.count
      const preset = c.config && typeof c.config === 'object' && !Array.isArray(c.config) ? (c.config as Record<string, unknown>) : null
      if (r.count || !preset) continue
      const key = { organizationId_channel_channelAccountId: { organizationId, channel: c.channel, channelAccountId: c.channelAccountId } }
      const row = await tx.channelConfig.findUnique({ where: key, select: { config: true } })
      const filled = row ? fillMissingSettings(row.config, preset) : null
      if (!filled) continue
      await tx.channelConfig.update({ where: key, data: { config: filled as Prisma.InputJsonValue } })
      stats.channelSettings++
    }
    if ((await tx.carrierRule.count({ where: { organizationId } })) === 0) {
      const rules = p.carrierRules ?? DEFAULT_CARRIER_RULES
      await tx.carrierRule.createMany({ data: rules.map((r) => ({ organizationId, ...r })) })
      stats.carrierRules = rules.length
    }
    // harmonogram odbiorów i reguły stref jak reguły przewoźników — tylko firmie, która nie ma żadnych
    if (p.carrierPickups?.length && (await tx.carrierPickup.count({ where: { organizationId } })) === 0) {
      await tx.carrierPickup.createMany({ data: p.carrierPickups.map((s) => ({ organizationId, ...s })) })
    }
    const zones = presetZones(p)
    if (zones.length && (await tx.packingZoneDef.count({ where: { organizationId } })) === 0) {
      await tx.packingZoneDef.createMany({ data: zones.map((z) => ({ organizationId, ...z })) })
    }
    if (p.zoneRules?.length && (await tx.productZoneRule.count({ where: { organizationId } })) === 0) {
      await tx.productZoneRule.createMany({ data: p.zoneRules.map((r) => ({ organizationId, ...r, example: true })) })
    }
    // statusy firmy jak strefy — tylko firmie, która nie ma żadnych (zmiany z panelu zostają)
    if ((await tx.orderStatusDef.count({ where: { organizationId } })) === 0) {
      const st = presetStatusy(p)
      if (st.grupy.length) await tx.orderStatusGroup.createMany({ data: st.grupy.map((g) => ({ organizationId, ...g })), skipDuplicates: true })
      await tx.orderStatusDef.createMany({ data: st.statusy.map((x) => ({ organizationId, ...x, carriers: [...x.carriers] })) })
    }
    // automatyczne akcje z presetu jak statusy — tylko firmie, która nie ma żadnej reguły (także ukrytej);
    // silnik zakładania wspólny z `npm run org:automaty` (lib/automaty/preset.ts). Reguła na status, którego
    // firma nie ma (zmieniony w panelu), nie powstaje: ostrzeżenie w logu i w wyniku, nie błąd startu kontenera.
    if (p.automationRules?.length) {
      const r = await zastosujAutomatyPresetu(tx, organizationId, p, { tylkoFirmaBezRegul: true })
      if (r.regulyNowe.length) stats.automationRules = r.regulyNowe.length
      if (r.bledy.length) {
        stats.automationErrors = r.bledy.length
        stats.automationSkipped = r.bledy.map((b) => `${b.klucz}: ${b.komunikat}`).join('; ')
        console.warn(`[preset] ${p.id}: ${r.bledy.length} automatycznych akcji z presetu nie powstało: ${stats.automationSkipped}`)
      }
    }
    await tx.reservationPolicy.createMany({ data: [{ organizationId, ...DEFAULT_POLICY }], skipDuplicates: true })
    return stats
  })()
}

/**
 * Preset nowej, pustej firmy (wspólny dla `npm run org:create` i kreatora /start): magazyn „glowny”,
 * domyślne reguły przewoźników i okresy rezerwacji, bez kanałów (dodaje je panel albo preset firmy). Id = slug
 * z `_` zamiast `-` (przechodzi assertOrgId). Program do faktur jawnie — `brak`, a `wfirma` tylko
 * z podanym magazynem wFirmy (wtedy też źródło stanu WFIRMA); nowa firma nie dostaje wFirmy po cichu.
 */
export function presetNowejFirmy(p: { slug: string; name: string; inventoryId?: string; wfirmaWarehouseId?: string | null; szablon?: SzablonNowejFirmy | null }): OrgPreset {
  // szablon przepływu wybrany w kreatorze: jego statusy, grupy i reguły (włączone, firma jest pusta)
  const sz = p.szablon
    ? { statusGroups: p.szablon.statusGroups.map((g) => ({ ...g })), statuses: p.szablon.statuses.map((x) => ({ ...x, carriers: [...x.carriers] })), automationGroups: p.szablon.automationGroups.map((g) => ({ ...g })), automationRules: p.szablon.automationRules.map((r) => ({ ...r, enabled: true })) }
    : {}
  return {
    ...sz,
    id: p.slug.replace(/-/g, '_'),
    slug: p.slug,
    name: p.name.trim(),
    settings: { ...(p.inventoryId ? { baselinker: { inventoryId: p.inventoryId } } : {}), faktury: { program: p.wfirmaWarehouseId ? 'wfirma' : 'brak' } },
    warehouses: [{ id: DEFAULT_WAREHOUSE, name: 'Główny', wfirmaWarehouseId: p.wfirmaWarehouseId ?? null, stockSource: p.wfirmaWarehouseId ? 'WFIRMA' : 'KOMPLETOR' }],
  }
}

/** Fragment szablonu przepływu potrzebny presetowi nowej firmy (lib/automaty/szablony.ts `SzablonPrzeplywu`). */
export interface SzablonNowejFirmy {
  statusGroups: GrupaStatusowT[]
  statuses: StatusFirmyT[]
  automationGroups: GrupaPresetuT[]
  automationRules: (RegulaPresetuT & { conditions: unknown[] })[]
}

const PL: Record<string, string> = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }

/**
 * Slug firmy z jej nazwy: polskie znaki bez ogonków, inne akcenty zdjęte, reszta znaków → myślnik,
 * najwyżej 40 znaków. Pusty wynik (np. sama interpunkcja) → `fallback`.
 */
export function slugZNazwy(nazwa: string, fallback = 'firma'): string {
  const s = nazwa
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => PL[c] ?? c)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return SLUG_RE.test(s) ? s : fallback
}

export interface OrgRef {
  id: string
  slug: string
  name: string
}

/** Aktywne firmy (kod systemowy: worker, harmonogram). */
export async function listActiveOrganizations(sys: PrismaClient): Promise<OrgRef[]> {
  return sys.organization.findMany({ where: { active: true }, select: { id: true, slug: true, name: true }, orderBy: { id: 'asc' } })
}

// APP_MODE: jedno źródło w lib/db.ts; tu re-eksport dla dotychczasowych importów
export { appModeOf, type AppMode }

/**
 * Czy klucze integracji wolno brać z env (fallback self-hostu jednofirmowego). Hosting: nigdy — inaczej każda firma
 * dostałaby klucze z env serwera. Self-host: tylko firma wskazana `SELFHOST_ORG_SLUG` albo jedyna firma w bazie.
 */
export function envSecretsAllowed(env: Record<string, string | undefined>, org: { slug: string }, activeOrgCount: number): boolean {
  if (appModeOf(env) === 'hosted') return false
  const pinned = env['SELFHOST_ORG_SLUG']?.trim()
  return pinned ? org.slug === pinned : activeOrgCount === 1
}

/** Firma self-hostu (panel bez logowania, skrypty): SELFHOST_ORG_SLUG albo jedyna aktywna. Hosting → null. */
export async function resolveSelfHostOrganization(sys: PrismaClient, env: Record<string, string | undefined>): Promise<OrgRef | null> {
  if (appModeOf(env) === 'hosted') return null
  const orgs = await listActiveOrganizations(sys)
  const pinned = env['SELFHOST_ORG_SLUG']?.trim()
  if (pinned) return orgs.find((o) => o.slug === pinned) ?? null
  return orgs.length === 1 ? orgs[0]! : null
}

// ─── Konfiguracja importu z BL (odczyt klientem firmy) ───────────────────────

export interface ImportConfig {
  inventoryId: string
  warehouseId: string
  wfirmaWarehouseId: string | null
  /** Sklepy Woo podpięte w BL: magazyn zewnętrzny BL → konto kanału. */
  shops: { storageId: string; channelAccountId: string }[]
  empikAccountId: string | null
  /** Nazwy kont kanałów do raportu: „<kanał>|<konto>” → nazwa z ChannelConfig. */
  channelNames: Record<string, string>
  /** Reguły katalogu: produkty bez stanu, dodatki bez oferty. Brak = bez reguł. */
  catalog?: CatalogRules
}

function catalogOf(settings: Prisma.JsonValue | null | undefined): CatalogRules {
  const o = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  return parseCatalogRules(o['catalog'])
}

/** Reguły katalogu firmy bez reszty konfiguracji importu (przeliczenie zrzutu). */
export async function loadCatalogRules(db: PrismaClient): Promise<CatalogRules> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return catalogOf(org?.settings)
}

export function channelMapOf(cfg: ImportConfig): ChannelMap {
  return { shopAccounts: cfg.shops.map((s) => s.channelAccountId), empikAccountId: cfg.empikAccountId, names: cfg.channelNames }
}

/** Brak albo zła konfiguracja firmy: ponowienie zadania nic nie zmieni, więc bez ponawiania. */
export class ConfigError extends NonRetryableError {}

export async function loadImportConfig(db: PrismaClient, warehouseId = DEFAULT_WAREHOUSE): Promise<ImportConfig> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  if (!org) throw new ConfigError('Brak organizacji klienta (klient bez firmy?)')
  const inventoryId = parseOrgSettings(org.settings).baselinker?.inventoryId
  if (!inventoryId) throw new ConfigError('Brak ustawienia baselinker.inventoryId w organizacji (Ustawienia → Integracje i agenci AI → Integracje)')
  const wh = await db.warehouse.findFirst({ where: { id: warehouseId }, select: { wfirmaWarehouseId: true } })
  if (!wh) throw new ConfigError(`Brak magazynu „${warehouseId}” w konfiguracji firmy`)
  const channels = await db.channelConfig.findMany({ where: { active: true }, orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }] })
  const shops = channels
    .filter((c) => c.channel === 'WOO' && c.blStorageId)
    .map((c) => ({ storageId: c.blStorageId!, channelAccountId: c.channelAccountId }))
  // BL: zamówienie ze sklepu ma order_source_id = numer magazynu „shop_<numer>” — konto musi być tym numerem
  for (const s of shops)
    if (s.storageId !== `shop_${s.channelAccountId}`)
      throw new ConfigError(`Sklep ${s.channelAccountId}: blStorageId „${s.storageId}” ≠ „shop_${s.channelAccountId}” (konto Woo w BL = numer magazynu)`)
  const empik = channels.filter((c) => c.channel === 'EMPIK')
  if (empik.length > 1) throw new ConfigError('Więcej niż jedno aktywne konto Empik — import z BL rozróżnia jedno')
  // konta kanałów sprzedaży (rodzina AI to integracja, nie kanał — nie trafia do importu ani tabeli nadpisań;
  // EASYTOOLS też nie: BL zapisuje te zamówienia jako BL_INNE, a nadpisania EASYTOOLS są odrzucane)
  const channelNames = Object.fromEntries(channels.filter((c) => c.channel !== 'AI' && c.channel !== 'EASYTOOLS').map((c) => [`${c.channel}|${c.channelAccountId}`, c.name]))
  return {
    inventoryId,
    warehouseId,
    wfirmaWarehouseId: wh.wfirmaWarehouseId,
    shops,
    empikAccountId: empik[0]?.channelAccountId ?? null,
    channelNames,
    catalog: catalogOf(org.settings),
  }
}
