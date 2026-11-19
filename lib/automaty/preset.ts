// Zakładanie grup i reguł automatycznych akcji: jeden silnik dla presetu firmy, szablonu przepływu i
// przeprowadzki z BL. Format i parser: lib/automaty/szablon.ts (`automationGroups`, `automationRules`,
// klucze `[a-z0-9-]`, `enabled` jawnie). Przepływ pracy jednej firmy to dane presetu, nie kod: firma edytuje reguły
// potem w Ustawienia → Automatyczne akcje jak każdą inną.
//
// Preset (`zastosujAutomatyPresetu`): grupa i reguła dostają `presetKey` = klucz z pliku. Zakładane są tylko brakujące
// klucze; reguła z kluczem już w bazie (także zmieniona albo ukryta w panelu) zostaje, jaka jest. Grupa powstaje tylko,
// gdy potrzebuje jej nowa reguła (grupa usunięta w panelu nie wraca). Drugie uruchomienie = zero zmian. Reguła, która
// nie pasuje do statusów firmy (np. status przemianowany w panelu), nie powstaje i trafia do raportu (`bledy`).
// Tryb `tylkoFirmaBezRegul` (seed przy zakładaniu firmy i przy starcie kontenera): firma z jakąkolwiek regułą nie
// dostaje nic. Funkcje bez skutków przy imporcie; zapis tylko w funkcjach poniżej (`sucho` = sam raport).
import type { Prisma, PrismaClient } from '@prisma/client'
import { LIMITY } from './schemat'
import { BladRegulPresetu, kontekstStatusow, parsujGrupyPresetu, parsujRegulePresetu, type GrupaPresetuT, type RegulaGotowa, type RegulaPresetuT } from './szablon'

type Db = PrismaClient | Prisma.TransactionClient

export interface AutomatyPresetu {
  automationGroups?: GrupaPresetuT[]
  automationRules?: RegulaPresetuT[]
}

export interface BladPresetu {
  klucz: string
  komunikat: string
}

export interface RaportPresetu {
  sucho: boolean
  grupyNowe: string[]
  regulyNowe: string[]
  /** reguły z kluczem już w bazie (także zmienione albo ukryte w panelu): bez zmian */
  regulyIstniejace: string[]
  /** reguły, które nie pasują do statusów firmy albo limitu: nie powstały */
  bledy: BladPresetu[]
  /** cały preset pominięty (tryb `tylkoFirmaBezRegul`, firma ma reguły) */
  pominiety: string | null
}

export interface ZapisRegul {
  grupy: number
  reguly: number
  /** id grupy zbiorczej (`grupaZbiorcza`), inaczej null */
  grupaId: string | null
}

/**
 * Rdzeń zapisu (w transakcji wywołującego): grupy z listy (po istniejących, kolejność z listy), reguły w kolejności
 * z listy, w grupie po istniejących regułach. `grupaZbiorcza` = wszystkie reguły do jednej nowej grupy (szablon do
 * firmy z własnymi regułami, przeprowadzka); `wlaczone` nadpisuje `enabled` z pliku; `kluczePresetu` = zapis
 * `presetKey` (tylko preset firmy: szablon wczytany drugi raz nie może zderzyć się z kluczami pierwszego).
 */
async function zapiszReguly(
  db: Db,
  organizationId: string,
  grupy: readonly Required<GrupaPresetuT>[],
  reguly: readonly RegulaGotowa[],
  opts: { grupaZbiorcza?: string; wlaczone?: boolean; kluczePresetu?: boolean; grupyIstniejace?: ReadonlyMap<string, string> },
): Promise<ZapisRegul> {
  const idGrupy = new Map(opts.grupyIstniejace ?? [])
  let nowychGrup = 0
  const maxGrup = await db.automationGroup.aggregate({ where: { organizationId }, _max: { sortOrder: true } })
  let kolejnaGrupa = (maxGrup._max.sortOrder ?? 0) + 10
  let zbiorcza: string | null = null
  if (opts.grupaZbiorcza) {
    zbiorcza = (await db.automationGroup.create({ data: { organizationId, name: opts.grupaZbiorcza.slice(0, 40), sortOrder: kolejnaGrupa, collapsed: false }, select: { id: true } })).id
    nowychGrup++
  } else
    for (const x of grupy) {
      if (idGrupy.has(x.key)) continue
      const g = await db.automationGroup.create({ data: { organizationId, name: x.name, sortOrder: kolejnaGrupa, collapsed: x.collapsed, ...(opts.kluczePresetu ? { presetKey: x.key } : {}) }, select: { id: true } })
      kolejnaGrupa += 10
      idGrupy.set(x.key, g.id)
      nowychGrup++
    }
  const sortWGrupie = new Map<string, number>()
  for (const r of reguly) {
    const groupId = zbiorcza ?? (r.groupKey ? (idGrupy.get(r.groupKey) ?? null) : null)
    const gk = groupId ?? ''
    if (!sortWGrupie.has(gk)) {
      const m = await db.automationRule.aggregate({ where: { organizationId, groupId, hidden: false }, _max: { sortOrder: true } })
      sortWGrupie.set(gk, (m._max.sortOrder ?? 0) + 10)
    }
    const sortOrder = sortWGrupie.get(gk)!
    sortWGrupie.set(gk, sortOrder + 10)
    await db.automationRule.create({
      data: {
        organizationId,
        groupId,
        name: r.name,
        description: r.description ?? null,
        event: r.event,
        conditions: r.conditions as unknown as Prisma.InputJsonArray,
        actions: r.actions as unknown as Prisma.InputJsonArray,
        buttonLabel: r.event === 'PRZYCISK' ? (r.buttonLabel ?? null) : null,
        buttonPlaces: r.event === 'PRZYCISK' ? (r.buttonPlaces ?? []) : [],
        enabled: opts.wlaczone ?? r.enabled,
        sortOrder,
        ...(opts.kluczePresetu ? { presetKey: r.key } : {}),
      },
    })
  }
  return { grupy: nowychGrup, reguly: reguly.length, grupaId: zbiorcza }
}

/**
 * Szablon i przeprowadzka: reguły już sprawdzone (`parsujRegulyPresetu`) do firmy, bez kluczy presetu.
 * Nie sprawdza, czy firma ma reguły: o tym decyduje wywołujący.
 */
export function zalozReguly(
  tx: Prisma.TransactionClient,
  organizationId: string,
  dane: { grupy: Required<GrupaPresetuT>[]; reguly: RegulaGotowa[] },
  opts: { grupaZbiorcza?: string; wlaczone?: boolean } = {},
): Promise<ZapisRegul> {
  return zapiszReguly(tx, organizationId, dane.grupy, dane.reguly, opts)
}

/**
 * Preset firmy: zakłada brakujące grupy i reguły w firmie `organizationId` (jawny filtr firmy: działa w transakcji
 * klienta systemowego przy zakładaniu firmy i w kliencie firmy). Reguły sprawdzane na statusach firmy z bazy.
 * Zły klucz albo nazwa grupy = wyjątek `BladRegulPresetu` (plik do poprawy; `validatePreset` łapie to przy wczytaniu).
 */
export async function zastosujAutomatyPresetu(db: Db, organizationId: string, p: AutomatyPresetu, opts: { sucho?: boolean; tylkoFirmaBezRegul?: boolean } = {}): Promise<RaportPresetu> {
  const sucho = opts.sucho === true
  const raport: RaportPresetu = { sucho, grupyNowe: [], regulyNowe: [], regulyIstniejace: [], bledy: [], pominiety: null }
  const reguly = p.automationRules ?? []
  if (!reguly.length) return raport
  if (opts.tylkoFirmaBezRegul && (await db.automationRule.count({ where: { organizationId } })) > 0) {
    raport.pominiety = 'firma ma już automatyczne akcje (także ukryte)'
    return raport
  }
  const grupy = parsujGrupyPresetu(p.automationGroups)
  const kluczeGrup = new Set(grupy.map((g) => g.key))
  const k = kontekstStatusow(await db.orderStatusDef.findMany({ where: { organizationId }, select: { key: true, baseStatus: true } }))
  const grupyBazy = new Map((await db.automationGroup.findMany({ where: { organizationId, presetKey: { not: null } }, select: { id: true, presetKey: true } })).map((g) => [g.presetKey!, g.id]))
  // ukryta (usunięta w panelu z historią) i każda inna z kluczem liczy się jako istniejąca
  const istniejace = new Set((await db.automationRule.findMany({ where: { organizationId, presetKey: { not: null } }, select: { presetKey: true } })).map((r) => r.presetKey!))
  let miejsce = LIMITY.regul - (await db.automationRule.count({ where: { organizationId, hidden: false } }))
  const nowe: RegulaGotowa[] = []
  const widziane = new Set<string>()
  for (const [i, r] of reguly.entries()) {
    const klucz = typeof r?.key === 'string' ? r.key : `automationRules[${i}]`
    if (widziane.has(klucz)) {
      raport.bledy.push({ klucz, komunikat: 'Powtórzony klucz reguły.' })
      continue
    }
    widziane.add(klucz)
    if (istniejace.has(klucz)) {
      raport.regulyIstniejace.push(klucz)
      continue
    }
    let g: RegulaGotowa
    try {
      g = parsujRegulePresetu(r, i, kluczeGrup, k)
    } catch (e) {
      if (!(e instanceof BladRegulPresetu)) throw e
      raport.bledy.push({ klucz, komunikat: e.message })
      continue
    }
    if (miejsce <= 0) {
      raport.bledy.push({ klucz, komunikat: `Firma ma już ${LIMITY.regul} reguł.` })
      continue
    }
    miejsce--
    nowe.push(g)
    raport.regulyNowe.push(klucz)
  }
  // grupa tylko wtedy, gdy potrzebuje jej któraś nowa reguła (grupa usunięta w panelu nie wraca przy kolejnym przebiegu)
  const potrzebne = grupy.filter((g) => !grupyBazy.has(g.key) && nowe.some((r) => r.groupKey === g.key))
  raport.grupyNowe = potrzebne.map((g) => g.key)
  if (sucho || !nowe.length) return raport
  await zapiszReguly(db, organizationId, potrzebne, nowe, { kluczePresetu: true, grupyIstniejace: grupyBazy })
  await db.auditLog.create({ data: { organizationId, entity: 'AutomationRule.preset', entityId: organizationId, actorId: 'system:preset', before: {}, after: { reguly: raport.regulyNowe, grupy: raport.grupyNowe } } })
  return raport
}

/** Raport jedną linią dla CLI i logu zadania. */
export function opisRaportu(r: RaportPresetu): string {
  if (r.pominiety) return `${r.sucho ? 'NA SUCHO: ' : ''}pominięty: ${r.pominiety}`
  const tryb = r.sucho ? 'NA SUCHO (nic nie zapisano)' : 'zapisano'
  const bl = r.bledy.length ? `; nie powstały (${r.bledy.length}): ${r.bledy.map((b) => `${b.klucz}: ${b.komunikat}`).join(' | ')}` : ''
  return `${tryb}: grup nowych ${r.grupyNowe.length}, reguł nowych ${r.regulyNowe.length}, reguł już w firmie ${r.regulyIstniejace.length}${bl}`
}
