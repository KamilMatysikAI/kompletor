// Reguły automatycznych akcji w presecie firmy i w szablonach przepływów (format uzgodniony). Preset i szablon niosą `automationGroups` + `automationRules`; reguły
// mają ten sam kształt co zapis z ekranu (lib/automaty/schemat.ts `RegulaT`) i przechodzą tę samą walidację
// (`parsujRegule`) na statusach z presetu. Czyste funkcje; zapis (jeden silnik dla presetu, szablonu i przeprowadzki):
// lib/automaty/preset.ts. Testy w szablony.test.ts.
import type { OrderStatus } from '@prisma/client'
import { kluczRdzenia, STATUSY_RDZENIA, type StatusFirmyT } from '@/lib/panel/statusy'
import { LIMITY, parsujRegule, type KontekstWalidacji, type RegulaT } from './schemat'

export const KLUCZ_REGULY_RE = /^[a-z0-9][a-z0-9-]{0,59}$/

export interface GrupaPresetuT {
  key: string
  name: string
  sortOrder?: number
  collapsed?: boolean
}

export interface RegulaPresetuT {
  key: string
  groupKey?: string | null
  name: string
  enabled?: boolean
  event: string
  conditions?: unknown[]
  actions: unknown[]
  buttonLabel?: string | null
  buttonPlaces?: string[]
  /** opis dla zespołu (np. powód wyłączenia), widoczny na liście reguł */
  description?: string | null
}

/** Reguła po walidacji: `RegulaT` + klucz z pliku, grupa i włączenie. */
export interface RegulaGotowa extends RegulaT {
  key: string
  groupKey: string | null
  enabled: boolean
}

export class BladRegulPresetu extends Error {}

/** Kontekst walidacji z listy statusów presetu (klucz → etap) plus `RDZEN:<etap>` (jak `kontekstZ` w dane.ts). */
export function kontekstStatusow(statusy: readonly Pick<StatusFirmyT, 'key' | 'baseStatus'>[]): KontekstWalidacji {
  const m = new Map<string, OrderStatus>(statusy.map((s) => [s.key, s.baseStatus]))
  for (const s of STATUSY_RDZENIA) m.set(kluczRdzenia(s), s)
  return { statusy: m }
}

/** Grupy presetu: klucze, nazwy, kolejność (gdy brak: pozycja × 10). Błąd = `BladRegulPresetu`. */
export function parsujGrupyPresetu(grupy: readonly GrupaPresetuT[] | undefined): Required<GrupaPresetuT>[] {
  const g = (grupy ?? []).map((x, i) => {
    if (!KLUCZ_REGULY_RE.test(x.key)) throw new BladRegulPresetu(`automationGroups[${i}]: zły klucz „${x.key}” (małe litery, cyfry, myślnik)`)
    const name = x.name?.trim()
    if (!name || name.length > 40) throw new BladRegulPresetu(`automationGroups[${i}]: nazwa grupy 1–40 znaków`)
    return { key: x.key, name, sortOrder: x.sortOrder ?? (i + 1) * 10, collapsed: x.collapsed ?? false }
  })
  if (new Set(g.map((x) => x.key)).size !== g.length) throw new BladRegulPresetu('automationGroups: powtórzony klucz grupy')
  if (g.length > LIMITY.grup) throw new BladRegulPresetu(`automationGroups: najwyżej ${LIMITY.grup} grup`)
  return g
}

/**
 * Jedna reguła presetu na statusach `k` (klucz, grupa z `kluczeGrup`, treść przez `parsujRegule`). `enabled` jawnie:
 * brak = wyłączona. Błąd = `BladRegulPresetu` z kluczem reguły.
 */
export function parsujRegulePresetu(r: RegulaPresetuT, i: number, kluczeGrup: ReadonlySet<string>, k: KontekstWalidacji): RegulaGotowa {
  if (!r || typeof r !== 'object') throw new BladRegulPresetu(`automationRules[${i}]: oczekiwany obiekt`)
  if (typeof r.key !== 'string' || !KLUCZ_REGULY_RE.test(r.key)) throw new BladRegulPresetu(`automationRules[${i}]: zły klucz „${String(r.key)}” (małe litery, cyfry, myślnik)`)
  const groupKey = r.groupKey ?? null
  if (groupKey !== null && !kluczeGrup.has(groupKey)) throw new BladRegulPresetu(`automationRules[${i}] „${r.key}”: nieznana grupa „${groupKey}”`)
  const p = parsujRegule({ name: r.name, event: r.event, conditions: r.conditions ?? [], actions: r.actions, buttonLabel: r.buttonLabel, buttonPlaces: r.buttonPlaces, description: r.description }, k)
  if (!p.ok) throw new BladRegulPresetu(`automationRules[${i}] „${r.key}”: ${p.bledy[0]?.komunikat ?? 'zła reguła'}`)
  return { ...p.regula, key: r.key, groupKey, enabled: r.enabled === true }
}

/**
 * Walidacja grup i reguł presetu na statusach presetu. Błąd = `BladRegulPresetu` z kluczem reguły i komunikatem
 * pierwszego błędu (plik z literówką ma się nie wczytać, zamiast po cichu zgubić regułę).
 */
export function parsujRegulyPresetu(grupy: readonly GrupaPresetuT[] | undefined, reguly: readonly RegulaPresetuT[] | undefined, statusy: readonly Pick<StatusFirmyT, 'key' | 'baseStatus'>[]): { grupy: Required<GrupaPresetuT>[]; reguly: RegulaGotowa[] } {
  const g = parsujGrupyPresetu(grupy)
  const klucze = new Set(g.map((x) => x.key))
  const k = kontekstStatusow(statusy)
  const out = (reguly ?? []).map((r, i) => parsujRegulePresetu(r, i, klucze, k))
  if (new Set(out.map((x) => x.key)).size !== out.length) throw new BladRegulPresetu('automationRules: powtórzony klucz reguły')
  if (out.length > LIMITY.regul) throw new BladRegulPresetu(`automationRules: najwyżej ${LIMITY.regul} reguł`)
  return { grupy: g, reguly: out }
}

export const AUDIT_SZABLONU = 'AUTOMAT_SZABLON'
