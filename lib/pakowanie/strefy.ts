// Strefy magazynu (definiuje je firma): część towaru stoi w innym pomieszczeniu albo dalej
// od stanowiska, więc do zbierania wybiera się zamówienia jednej strefy. Strefę (nazwa, kolor, kolejność) firma
// zakłada w Ustawienia → Strefy magazynu; strefa produktu: ręczne ustawienie w karcie produktu, inaczej pierwsza
// pasująca reguła firmy (nazwa albo SKU). Strefa zamówienia: wspólna strefa pozycji albo „mieszane”.
// Klucze dawnego enuma (HERBATY_KAWY, BOMBY_AKCESORIA) zostają, bo są zapisane w bazach firm; nazwy stref
// firma ma w presecie (lista `zones`) albo w ustawieniach. Nazwy niżej to neutralny zapas dla presetu bez listy stref.
// Czyste funkcje — testy w pakowanie.test.ts i strefy.test.ts.

/** Kolory stref (klasy `.zone.z-<kolor>` w panel.css). */
export const ZONE_COLORS = { ziemia: 'brązowy', sliwka: 'śliwkowy', zielen: 'zielony', niebo: 'niebieski', szary: 'szary' } as const
export type ZoneColor = keyof typeof ZONE_COLORS
export const isZoneColor = (v: string | null | undefined): v is ZoneColor => !!v && Object.hasOwn(ZONE_COLORS, v)

export interface ZoneDefT {
  key: string
  name: string
  color: string
  sortOrder: number
}

/**
 * Strefy (dawny enum): migracja daje je firmom, które ich używały, a preset bez listy `zones`
 * z regułami na te klucze dostaje je tak samo. Nowa firma ich nie dostaje.
 */
export const LEGACY_ZONES: readonly ZoneDefT[] = [
  { key: 'HERBATY_KAWY', name: 'produkty spożywcze', color: 'ziemia', sortOrder: 10 },
  { key: 'BOMBY_AKCESORIA', name: 'akcesoria', color: 'sliwka', sortOrder: 20 },
]

export const ZONE_KEY_RE = /^[A-Z0-9][A-Z0-9_]{0,39}$/
export const MAX_ZONES = 20

/** Strefa zamówienia: jedna strefa wszystkich pozycji, „mieszane” albo brak (żadna pozycja nie ma strefy). */
export type OrderZone = string | 'MIESZANE' | null

export interface ZoneRuleT {
  priority: number
  pattern: string
  zone: string
}

const compiled = new Map<string, RegExp | null>()

function regexOf(pattern: string): RegExp | null {
  let re = compiled.get(pattern)
  if (re === undefined) {
    try {
      re = new RegExp(pattern, 'iu')
    } catch {
      re = null // zła reguła nie pasuje do niczego (walidacja przy zapisie)
    }
    compiled.set(pattern, re)
  }
  return re
}

export function validateZoneDef(d: ZoneDefT): void {
  if (!ZONE_KEY_RE.test(d.key) || d.key === 'MIESZANE') throw new Error(`Zły klucz strefy: ${d.key}`)
  const n = d.name.trim()
  if (!n) throw new Error('Strefa musi mieć nazwę')
  if (n.length > 40) throw new Error('Nazwa strefy może mieć najwyżej 40 znaków')
  if (!isZoneColor(d.color)) throw new Error(`Nieznany kolor strefy: ${d.color}`)
  if (!Number.isInteger(d.sortOrder) || d.sortOrder < 0 || d.sortOrder > 100_000) throw new Error(`Zła kolejność strefy: ${d.sortOrder}`)
}

/** `keys` = klucze stref firmy; bez listy sprawdzany jest tylko format klucza. */
export function validateZoneRule(r: ZoneRuleT, keys?: readonly string[]): void {
  if (!Number.isInteger(r.priority) || r.priority < 0 || r.priority > 100_000) throw new Error(`Zły priorytet reguły strefy: ${r.priority}`)
  if (typeof r.zone !== 'string' || !ZONE_KEY_RE.test(r.zone) || (keys && !keys.includes(r.zone))) throw new Error(`Nieznana strefa: ${r.zone}`)
  if (!r.pattern.trim() || r.pattern.length > 300) throw new Error('Wzorzec reguły strefy pusty albo dłuższy niż 300 znaków')
  try {
    new RegExp(r.pattern, 'iu')
  } catch {
    throw new Error(`Zły wzorzec reguły strefy: ${r.pattern}`)
  }
}

const BEZ_ZNAKOW: Record<string, string> = { Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z' }

/** Klucz nowej strefy z nazwy („Regał A — kawy” → REGAL_A_KAWY), unikalny wśród `zajete`. */
export function zoneKeyFromName(name: string, zajete: readonly string[]): string {
  const base =
    name
      .toUpperCase()
      .replace(/[ĄĆĘŁŃÓŚŹŻ]/g, (c) => BEZ_ZNAKOW[c] ?? c)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'STREFA'
  const safe = /^[A-Z0-9]/.test(base) && base !== 'MIESZANE' ? base : `S_${base}`.slice(0, 32)
  if (!zajete.includes(safe)) return safe
  for (let i = 2; ; i++) if (!zajete.includes(`${safe}_${i}`)) return `${safe}_${i}`
}

export interface ZoneOfProduct {
  zone: string | null
  source: 'RECZNIE' | 'REGULA' | null
}

/** Strefa produktu: ręczne `packingZone`, inaczej pierwsza reguła (rosnąco po priorytecie) pasująca do nazwy albo SKU. */
export function productZone(p: { title: string; sku: string; packingZone: string | null }, rules: readonly ZoneRuleT[]): ZoneOfProduct {
  if (p.packingZone) return { zone: p.packingZone, source: 'RECZNIE' }
  for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
    const re = regexOf(r.pattern)
    if (re && (re.test(p.title) || re.test(p.sku))) return { zone: r.zone, source: 'REGULA' }
  }
  return { zone: null, source: null }
}

/**
 * Strefa zamówienia z pozycji: wszystkie w jednej strefie → ta strefa; różne strefy albo część bez strefy →
 * „mieszane” (pozycji bez strefy nie wiadomo, gdzie szukać); żadna pozycja ze strefą (albo brak pozycji) → null.
 */
export function orderZone(lineZones: readonly (string | null)[]): OrderZone {
  const set = new Set(lineZones)
  if (set.size === 0) return null
  if (set.size === 1) return lineZones[0] ?? null
  return 'MIESZANE'
}

/** Filtr strefy na kolejce: „wszystkie”, „mieszane” albo klucz strefy firmy. */
export type ZoneFilter = string
export const ZONE_FILTER_ALL = 'wszystkie'
export const ZONE_FILTER_MIXED = 'mieszane'
/** Stare adresy filtrów (`?strefa=herbaty`) z zakładek pracowników. */
const ZONE_FILTER_ALIASES: Record<string, string> = { herbaty: 'HERBATY_KAWY', bomby: 'BOMBY_AKCESORIA' }

/** Filtr z adresu: znany klucz strefy firmy, „mieszane” albo „wszystkie” (także dla nieznanej wartości). */
export function parseZoneFilter(v: string | undefined, defs: readonly Pick<ZoneDefT, 'key'>[]): ZoneFilter {
  if (!v) return ZONE_FILTER_ALL
  if (v === ZONE_FILTER_MIXED) return defs.length ? ZONE_FILTER_MIXED : ZONE_FILTER_ALL
  const key = ZONE_FILTER_ALIASES[v] ?? v
  return defs.some((d) => d.key === key) ? key : ZONE_FILTER_ALL
}

export function matchesZone(z: OrderZone, f: ZoneFilter): boolean {
  if (f === ZONE_FILTER_ALL) return true
  if (f === ZONE_FILTER_MIXED) return z === 'MIESZANE'
  return z === f
}

export interface ZoneCounts {
  wszystkie: number
  mieszane: number
  bez: number
  strefy: Record<string, number>
}

/** Liczby do filtra (z kolejki przed filtrowaniem). „Bez strefy” liczy się tylko do „wszystkie”. */
export function zoneCounts(zones: readonly OrderZone[]): ZoneCounts {
  const c: ZoneCounts = { wszystkie: zones.length, mieszane: 0, bez: 0, strefy: {} }
  for (const z of zones) {
    if (z === 'MIESZANE') c.mieszane++
    else if (z === null) c.bez++
    else c.strefy[z] = (c.strefy[z] ?? 0) + 1
  }
  return c
}

/** Przyciski filtra stref w kolejności firmy; firma bez stref = brak filtrów (pusta lista). */
export function zoneFilterButtons(defs: readonly ZoneDefT[], counts: ZoneCounts): { value: ZoneFilter; label: string; color: string | null; count: number }[] {
  if (!defs.length) return []
  return [
    { value: ZONE_FILTER_ALL, label: 'Wszystkie', color: null, count: counts.wszystkie },
    ...sortZones(defs).map((d) => ({ value: d.key, label: `Tylko ${d.name}`, color: d.color, count: counts.strefy[d.key] ?? 0 })),
    { value: ZONE_FILTER_MIXED, label: 'Mieszane', color: null, count: counts.mieszane },
  ]
}

export const sortZones = <T extends Pick<ZoneDefT, 'sortOrder' | 'name'>>(defs: readonly T[]): T[] => [...defs].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pl'))

/** Nazwa strefy po kluczu (nieznany klucz = sam klucz, żeby nic nie zniknęło z ekranu). */
export const zoneName = (defs: readonly Pick<ZoneDefT, 'key' | 'name'>[], key: string | null): string | null => (key === null ? null : (defs.find((d) => d.key === key)?.name ?? key))
export const zoneColor = (defs: readonly Pick<ZoneDefT, 'key' | 'color'>[], key: string | null): string => {
  const c = defs.find((d) => d.key === key)?.color
  return isZoneColor(c) ? c : 'szary'
}
