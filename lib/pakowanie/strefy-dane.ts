// Ustawienia → Strefy magazynu: strefy firmy (nazwa, kolor, kolejność) i reguły „słowa
// w nazwie albo SKU produktu → strefa”, zapisywane razem jednym zapisem (jedna transakcja, wpis w AuditLog).
// Ręczna strefa produktu zostaje w karcie produktu. Strefy, której używa produkt ustawiony ręcznie, nie da się
// usunąć (najpierw zmiana strefy produktu). Zmiana reguł działa od razu na kolejce pakowania (strefa liczy się przy
// odczycie, nic nie trzeba przeliczać).
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
type Db = PrismaClient

import { isZoneColor, MAX_ZONES, sortZones, validateZoneDef, validateZoneRule, zoneKeyFromName, type ZoneDefT, type ZoneRuleT } from './strefy'

export class StrefyError extends Error {
  constructor(
    message: string,
    /** pole z błędem, np. `strefa-2-nazwa`, `regula-1-slowa` */
    readonly pole?: string,
  ) {
    super(message)
  }
}

export interface StrefaUstawienia extends ZoneDefT {
  /** produkty z tą strefą ustawioną ręcznie */
  produktyRecznie: number
}

export interface RegulaUstawienia extends ZoneRuleT {
  example: boolean
}

export async function ustawieniaStref(db: Db): Promise<{ strefy: StrefaUstawienia[]; reguly: RegulaUstawienia[] }> {
  organizationIdOf(db)
  const [defs, rules, uzycie] = await Promise.all([
    db.packingZoneDef.findMany({ select: { key: true, name: true, color: true, sortOrder: true } }),
    db.productZoneRule.findMany({ orderBy: { priority: 'asc' }, select: { priority: true, pattern: true, zone: true, example: true } }),
    db.product.groupBy({ by: ['packingZone'], where: { packingZone: { not: null } }, _count: { _all: true } }),
  ])
  const ile = new Map(uzycie.map((u) => [u.packingZone, u._count._all]))
  return { strefy: sortZones(defs).map((d) => ({ ...d, produktyRecznie: ile.get(d.key) ?? 0 })), reguly: rules }
}

export { slowaZeWzorca, wzorzecZeSlow } from '@/lib/panel/slowa'

export interface StrefaWejscie {
  /** klucz istniejącej strefy; pusty = nowa strefa */
  key: string | null
  /** odnośnik nowej strefy w formularzu (reguły wskazują go, zanim strefa dostanie klucz) */
  ref: string
  name: string
  color: string
}

export interface RegulaWejscie {
  /** klucz strefy albo odnośnik nowej strefy */
  zone: string
  /** wzorzec gotowy (tryb „wzorzec”) albo ze słów */
  pattern: string
}

/**
 * Zapis całego ekranu stref: lista stref w kolejności z formularza (kolejność = sortOrder 10, 20, …) i reguły
 * (priorytet = kolejność wierszy). Brak strefy na liście = usunięcie (gdy nie używa jej ręcznie żaden produkt).
 */
export async function zapiszStrefy(db: Db, wejscie: { strefy: StrefaWejscie[]; reguly: RegulaWejscie[] }, actorId: string): Promise<{ strefy: number; reguly: number }> {
  const organizationId = organizationIdOf(db)
  if (wejscie.strefy.length > MAX_ZONES) throw new StrefyError(`Najwyżej ${MAX_ZONES} stref`)
  if (wejscie.reguly.length > 200) throw new StrefyError('Najwyżej 200 reguł')
  return db.$transaction(async (tx) => {
    const przed = await tx.packingZoneDef.findMany({ select: { key: true, name: true, color: true, sortOrder: true } })
    const istniejace = new Set(przed.map((d) => d.key))
    const zajete = [...istniejace]
    const nazwy = new Set<string>()
    const ref = new Map<string, string>()
    const nowe: ZoneDefT[] = []
    wejscie.strefy.forEach((s, i) => {
      const name = s.name.trim()
      const pole = `strefa-${i}-nazwa`
      if (!name) throw new StrefyError('Wpisz nazwę strefy', pole)
      const n = name.toLocaleLowerCase('pl')
      if (nazwy.has(n)) throw new StrefyError(`Strefa „${name}” jest dwa razy`, pole)
      nazwy.add(n)
      if (!isZoneColor(s.color)) throw new StrefyError('Wybierz kolor z listy', `strefa-${i}-kolor`)
      let key: string
      if (s.key) {
        if (!istniejace.has(s.key)) throw new StrefyError('Ta strefa została w międzyczasie usunięta — odśwież stronę', pole)
        key = s.key
      } else {
        key = zoneKeyFromName(name, zajete)
        zajete.push(key)
      }
      if (s.ref) ref.set(s.ref, key)
      ref.set(key, key)
      const d = { key, name, color: s.color, sortOrder: (i + 1) * 10 }
      try {
        validateZoneDef(d)
      } catch (e) {
        throw new StrefyError(e instanceof Error ? e.message : 'Zła strefa', pole)
      }
      nowe.push(d)
    })
    const zostaja = new Set(nowe.map((d) => d.key))
    const usuwane = przed.filter((d) => !zostaja.has(d.key))
    if (usuwane.length) {
      const reczne = await tx.product.groupBy({ by: ['packingZone'], where: { packingZone: { in: usuwane.map((d) => d.key) } }, _count: { _all: true } })
      const r = reczne[0]
      if (r) {
        const d = usuwane.find((x) => x.key === r.packingZone)
        throw new StrefyError(`Strefy „${d?.name ?? r.packingZone}” nie można usunąć: ${r._count._all} prod. ma ją ustawioną ręcznie w karcie produktu. Zmień najpierw ich strefę.`)
      }
    }
    const reguly: ZoneRuleT[] = wejscie.reguly.map((r, i) => {
      const zone = ref.get(r.zone)
      if (!zone) throw new StrefyError('Wybierz strefę z listy', `regula-${i}-strefa`)
      const pattern = r.pattern.trim()
      if (!pattern) throw new StrefyError('Wpisz słowa (np. kawa, przyprawa)', `regula-${i}-slowa`)
      const rule = { priority: (i + 1) * 10, pattern, zone }
      try {
        validateZoneRule(rule, [...zostaja])
      } catch (e) {
        throw new StrefyError(e instanceof Error ? e.message.replace(/^Zły wzorzec reguły strefy: .*/, 'Wzorzec ma błąd składni') : 'Zła reguła', `regula-${i}-slowa`)
      }
      return rule
    })
    const regulyPrzed = await tx.productZoneRule.findMany({ select: { priority: true, pattern: true, zone: true } })
    // reguły najpierw (wskazują strefy), potem strefy; organizationId w where obok RLS
    await tx.productZoneRule.deleteMany({ where: { organizationId } })
    if (usuwane.length) await tx.packingZoneDef.deleteMany({ where: { organizationId, key: { in: usuwane.map((d) => d.key) } } })
    for (const d of nowe) {
      await tx.packingZoneDef.upsert({
        where: { organizationId_key: { organizationId, key: d.key } },
        create: { organizationId, ...d },
        update: { name: d.name, color: d.color, sortOrder: d.sortOrder },
      })
    }
    if (reguly.length) await tx.productZoneRule.createMany({ data: reguly.map((r) => ({ organizationId, ...r, example: false })) }) // zapis z panelu = firma przyjęła reguły, chip „przykładowa” znika
    await tx.auditLog.create({
      data: {
        entity: 'PackingZoneDef',
        entityId: organizationId,
        actorId,
        before: { strefy: sortZones(przed).map((d) => ({ ...d })), reguly: regulyPrzed.sort((a, b) => a.priority - b.priority).map((r) => ({ priority: r.priority, pattern: r.pattern, zone: r.zone })) },
        after: { strefy: nowe.map((d) => ({ ...d })), reguly: reguly.map((r) => ({ ...r })) },
      },
    })
    return { strefy: nowe.length, reguly: reguly.length }
  })
}
