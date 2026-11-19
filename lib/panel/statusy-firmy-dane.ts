// Statusy firmy w bazie: odczyt definicji i grup, liczniki zamówień per status firmy i zapis ekranu
// Ustawienia → Statusy zamówień jednym zapisem (jedna transakcja, wpis w AuditLog). Logika wyboru statusu firmy dla
// zamówienia jest czysta i leży w lib/panel/statusy.ts (`wybierzStatusFirmy`), tu tylko dane.
// Rdzeń bez zmian: status firmy to nazwa nad enumem, przypisanie wprost (Order.companyStatus) nie zmienia stanu
// rdzenia, a status firmy z innym statusem bazowym przechodzi przez funkcję rdzenia (lib/praca/status-dowolny.ts).
import type { Carrier, OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { zoneKeyFromName } from '@/lib/pakowanie/strefy'
import {
  brakujaceBazowe,
  isKolorStatusu,
  kluczRdzenia,
  MAX_GRUP,
  MAX_STATUSOW,
  PRZEWOZNICY_WSZYSCY,
  sortujStatusy,
  STATUS_ZAMOWIENIA,
  STATUSY_RDZENIA,
  validateGrupaStatusow,
  validateStatusFirmy,
  wybierzStatusFirmy,
  type GrupaStatusowT,
  type StatusFirmyT,
} from './statusy'

type Db = PrismaClient

export interface StatusyFirmy {
  statusy: StatusFirmyT[]
  grupy: GrupaStatusowT[]
}

const POLA_STATUSU = { key: true, name: true, customerName: true, color: true, groupKey: true, sortOrder: true, baseStatus: true, carriers: true, active: true } as const
const POLA_GRUPY = { key: true, name: true, sortOrder: true, collapsed: true } as const

/** Statusy i grupy firmy z sesji (RLS), w kolejności. Firma bez statusów = puste listy (panel pokazuje nazwy rdzenia). */
export async function statusyFirmy(db: Db): Promise<StatusyFirmy> {
  organizationIdOf(db)
  const [statusy, grupy] = await Promise.all([db.orderStatusDef.findMany({ select: POLA_STATUSU }), db.orderStatusGroup.findMany({ select: POLA_GRUPY })])
  return { statusy: sortujStatusy(statusy), grupy: sortujStatusy(grupy) }
}

/**
 * Liczba zamówień per status firmy (klucz statusu albo `RDZEN:<status>` dla zamówień bez pasującego statusu firmy).
 * Jedno zapytanie `groupBy(status, carrier, companyStatus)`; przypisanie liczy `wybierzStatusFirmy`.
 */
export function zlozLicznikiStatusow(defs: readonly StatusFirmyT[], wiersze: { status: OrderStatus; carrier: Carrier | null; companyStatus: string | null; n: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const w of wiersze) {
    const k = wybierzStatusFirmy(defs, w)?.key ?? kluczRdzenia(w.status)
    out.set(k, (out.get(k) ?? 0) + w.n)
  }
  return out
}

export type WierszStatusu = { status: OrderStatus; carrier: Carrier | null; companyStatus: string | null; n: number }

/**
 * (menu „Zamówienia”): podział zamówień statusu firmy na przewoźników, z tych samych wierszy i tym samym
 * przypisaniem (`wybierzStatusFirmy`) co `zlozLicznikiStatusow`, więc suma przewoźników = licznik statusu.
 * Brak przewoźnika liczy się jako `BRAK`, jak w panelu.
 */
export function zlozPrzewoznikowStatusow(defs: readonly StatusFirmyT[], wiersze: WierszStatusu[]): Map<string, Partial<Record<Carrier, number>>> {
  const out = new Map<string, Partial<Record<Carrier, number>>>()
  for (const w of wiersze) {
    if (w.n <= 0) continue
    const k = wybierzStatusFirmy(defs, w)?.key ?? kluczRdzenia(w.status)
    const c: Carrier = w.carrier ?? 'BRAK'
    const m = out.get(k) ?? {}
    m[c] = (m[c] ?? 0) + w.n
    out.set(k, m)
  }
  return out
}

export async function wierszeStatusow(db: Db): Promise<WierszStatusu[]> {
  organizationIdOf(db)
  const rows = await db.order.groupBy({ by: ['status', 'carrier', 'companyStatus'], _count: { _all: true } })
  return rows.map((r) => ({ status: r.status, carrier: r.carrier, companyStatus: r.companyStatus, n: r._count._all }))
}

export async function licznikiStatusowFirmy(db: Db, defs: readonly StatusFirmyT[]): Promise<Map<string, number>> {
  return zlozLicznikiStatusow(defs, await wierszeStatusow(db))
}

/** Liczniki statusów firmy i ich podział na przewoźników z jednego zapytania (menu „Zamówienia”). */
export async function licznikiStatusowFirmyZPrzewoznikami(db: Db, defs: readonly StatusFirmyT[]): Promise<{ ile: Map<string, number>; przewoznicy: Map<string, Partial<Record<Carrier, number>>> }> {
  const w = await wierszeStatusow(db)
  return { ile: zlozLicznikiStatusow(defs, w), przewoznicy: zlozPrzewoznikowStatusow(defs, w) }
}

export interface StatusUstawienia extends StatusFirmyT {
  /** zamówienia, które mają teraz ten status (wyliczony albo przypisany wprost) */
  zamowienia: number
}

export async function ustawieniaStatusow(db: Db): Promise<{ statusy: StatusUstawienia[]; grupy: GrupaStatusowT[] }> {
  const s = await statusyFirmy(db)
  const [ile, wprost] = await Promise.all([licznikiStatusowFirmy(db, s.statusy), db.order.groupBy({ by: ['companyStatus'], where: { companyStatus: { not: null } }, _count: { _all: true } })])
  const ileWprost = new Map(wprost.map((w) => [w.companyStatus, w._count._all]))
  // status z zamówieniami: wyliczony teraz albo kiedyś przypisany wprost (klucz zostaje w zamówieniu)
  return { grupy: s.grupy, statusy: s.statusy.map((x) => ({ ...x, zamowienia: Math.max(ile.get(x.key) ?? 0, ileWprost.get(x.key) ?? 0) })) }
}

export class StatusyError extends Error {
  constructor(
    message: string,
    /** pole z błędem, np. `status-2-nazwa`, `grupa-1-nazwa` */
    readonly pole?: string,
  ) {
    super(message)
  }
}

export interface GrupaWejscie {
  /** klucz istniejącej grupy; pusty = nowa */
  key: string | null
  /** odnośnik nowej grupy w formularzu (status wskazuje go, zanim grupa dostanie klucz) */
  ref: string
  name: string
  collapsed: boolean
}

export interface StatusWejscie {
  key: string | null
  name: string
  customerName: string
  color: string
  /** klucz grupy, odnośnik nowej grupy albo pusty (bez grupy) */
  group: string
  baseStatus: string
  carriers: string[]
  active: boolean
}

/**
 * Zapis całego ekranu statusów: grupy i statusy w kolejności z formularza (kolejność = sortOrder 10, 20, …). Brak
 * statusu na liście = usunięcie, ale tylko gdy nie ma żadnego zamówienia (inaczej: ukryj). Każdy status rdzenia musi
 * mieć co najmniej jeden aktywny status firmy (status bazowy nie znika z panelu).
 */
export async function zapiszStatusyFirmy(db: Db, wejscie: { grupy: GrupaWejscie[]; statusy: StatusWejscie[] }, actorId: string): Promise<{ statusy: number; grupy: number }> {
  const organizationId = organizationIdOf(db)
  if (wejscie.statusy.length > MAX_STATUSOW) throw new StatusyError(`Najwyżej ${MAX_STATUSOW} statusów`)
  if (wejscie.grupy.length > MAX_GRUP) throw new StatusyError(`Najwyżej ${MAX_GRUP} grup`)
  // liczniki zamówień („wyliczone” do sprawdzenia usunięcia) czytane przed transakcją. Wyścig
  // z równoległą zmianą zamówienia jest akceptowany: najwyżej zamówienie trafi pod inny status firmy albo etap (nazwa
  // liczona z enumu i przewoźnika), bez utraty danych; przypisanie wprost sprawdza transakcja.
  const przed = await ustawieniaStatusow(db)
  return db.$transaction(async (tx) => {
    const grupyPrzed = await tx.orderStatusGroup.findMany({ select: POLA_GRUPY })
    const statusyPrzed = await tx.orderStatusDef.findMany({ select: POLA_STATUSU })
    const gIst = new Set(grupyPrzed.map((g) => g.key))
    const sIst = new Set(statusyPrzed.map((s) => s.key))
    const gZajete = [...gIst]
    const ref = new Map<string, string>()
    const nazwyG = new Set<string>()
    const grupy: GrupaStatusowT[] = wejscie.grupy.map((g, i) => {
      const pole = `grupa-${i}-nazwa`
      const name = g.name.trim()
      if (!name) throw new StatusyError('Wpisz nazwę grupy', pole)
      const n = name.toLocaleLowerCase('pl')
      if (nazwyG.has(n)) throw new StatusyError(`Grupa „${name}” jest dwa razy`, pole)
      nazwyG.add(n)
      let key: string
      if (g.key) {
        if (!gIst.has(g.key)) throw new StatusyError('Ta grupa została w międzyczasie usunięta — odśwież stronę', pole)
        key = g.key
      } else {
        key = zoneKeyFromName(name, gZajete)
        gZajete.push(key)
      }
      if (g.ref) ref.set(g.ref, key)
      ref.set(key, key)
      const d = { key, name, sortOrder: (i + 1) * 10, collapsed: g.collapsed }
      try {
        validateGrupaStatusow(d)
      } catch (e) {
        throw new StatusyError(e instanceof Error ? e.message : 'Zła grupa', pole)
      }
      return d
    })
    const sZajete = [...sIst]
    const nazwyS = new Set<string>()
    const statusy: StatusFirmyT[] = wejscie.statusy.map((s, i) => {
      const pole = `status-${i}-nazwa`
      const name = s.name.trim()
      if (!name) throw new StatusyError('Wpisz nazwę statusu', pole)
      const n = name.toLocaleLowerCase('pl')
      if (nazwyS.has(n)) throw new StatusyError(`Status „${name}” jest dwa razy`, pole)
      nazwyS.add(n)
      if (!isKolorStatusu(s.color)) throw new StatusyError('Wybierz kolor z listy', `status-${i}-kolor`)
      if (!(STATUSY_RDZENIA as string[]).includes(s.baseStatus)) throw new StatusyError('Wybierz etap z listy', `status-${i}-bazowy`)
      const carriers = [...new Set(s.carriers)].filter((c): c is Carrier => (PRZEWOZNICY_WSZYSCY as string[]).includes(c))
      let key: string
      if (s.key) {
        if (!sIst.has(s.key)) throw new StatusyError('Ten status został w międzyczasie usunięty — odśwież stronę', pole)
        key = s.key
      } else {
        key = zoneKeyFromName(name, sZajete)
        sZajete.push(key)
      }
      const groupKey = s.group ? ref.get(s.group) : null
      if (s.group && !groupKey) throw new StatusyError('Wybierz grupę z listy', `status-${i}-grupa`)
      const d: StatusFirmyT = { key, name, customerName: s.customerName.trim() || null, color: s.color, groupKey: groupKey ?? null, sortOrder: (i + 1) * 10, baseStatus: s.baseStatus as OrderStatus, carriers, active: s.active }
      try {
        validateStatusFirmy(d)
      } catch (e) {
        throw new StatusyError(e instanceof Error ? e.message : 'Zły status', pole)
      }
      return d
    })
    if (!statusy.length) throw new StatusyError('Firma musi mieć statusy: dodaj co najmniej jeden na każdy etap')
    const bezAktywnego = brakujaceBazowe(statusy.filter((s) => s.active))
    if (bezAktywnego.length) throw new StatusyError(`Każdy etap musi mieć widoczny status. Brakuje: ${bezAktywnego.map((b) => STATUS_ZAMOWIENIA[b].etykieta).join(', ')}`)
    const zostaja = new Set(statusy.map((s) => s.key))
    const usuwane = statusyPrzed.filter((s) => !zostaja.has(s.key))
    for (const u of usuwane) {
      const ile = przed.statusy.find((x) => x.key === u.key)?.zamowienia ?? 0
      const wprost = await tx.order.count({ where: { companyStatus: u.key } })
      if (ile || wprost) throw new StatusyError(`Statusu „${u.name}” nie można usunąć: ma zamówienia (${Math.max(ile, wprost)}). Ukryj go zamiast usuwać.`)
    }
    const gZostaja = new Set(grupy.map((g) => g.key))
    // organizationId w where obok RLS (jak)
    if (usuwane.length) await tx.orderStatusDef.deleteMany({ where: { organizationId, key: { in: usuwane.map((s) => s.key) } } })
    for (const g of grupy) {
      await tx.orderStatusGroup.upsert({ where: { organizationId_key: { organizationId, key: g.key } }, create: { organizationId, ...g }, update: { name: g.name, sortOrder: g.sortOrder, collapsed: g.collapsed } })
    }
    for (const s of statusy) {
      const data = { name: s.name, customerName: s.customerName ?? null, color: s.color, groupKey: s.groupKey ?? null, sortOrder: s.sortOrder, baseStatus: s.baseStatus, carriers: [...s.carriers], active: s.active }
      await tx.orderStatusDef.upsert({ where: { organizationId_key: { organizationId, key: s.key } }, create: { organizationId, key: s.key, ...data }, update: data })
    }
    const gUsuwane = grupyPrzed.filter((g) => !gZostaja.has(g.key)).map((g) => g.key)
    if (gUsuwane.length) await tx.orderStatusGroup.deleteMany({ where: { organizationId, key: { in: gUsuwane } } })
    await tx.auditLog.create({
      data: {
        entity: 'OrderStatusDef',
        entityId: organizationId,
        actorId,
        before: { grupy: sortujStatusy(grupyPrzed).map((g) => ({ ...g })), statusy: sortujStatusy(statusyPrzed).map((s) => ({ ...s, carriers: [...s.carriers] })) } as Prisma.InputJsonValue,
        after: { grupy: grupy.map((g) => ({ ...g })), statusy: statusy.map((s) => ({ ...s, carriers: [...s.carriers] })) } as Prisma.InputJsonValue,
      },
    })
    return { statusy: statusy.length, grupy: grupy.length }
  })
}
