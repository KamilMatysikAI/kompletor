// Automatyczne akcje w bazie: lista dla ekranu Ustawienia → Automatyczne akcje (grupy, reguły z pigułkami,
// ostrzeżenia o konfliktach, liczba wykonań z 7 dni), zapis reguły jednym zapisem (walidacja lib/automaty/schemat.ts),
// włączanie, duplikowanie, usuwanie (reguła z historią wykonań = wyłączona i ukryta), kolejność i grupy. Każdy zapis
// zostawia wpis w AuditLog. Klient bazy firmy (RLS).
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { maileZwrotowWlaczone } from '@/lib/akcje/maile-zwrotow'
import { planWbudowanyWlaczony } from '@/lib/akcje/silnik'
import { CARRIER_LABEL, accountDisplayName } from '@/lib/panel/format'
import { kluczRdzenia, STATUS_ZAMOWIENIA, type StatusFirmyT } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { LIMITY, parsujRegule, SZABLONY_MAILI, ZDARZENIA, type BladReguly, type KontekstWalidacji, type RegulaT } from './schemat'
import { regulyWKolejnosci, type RegulaSilnika } from './silnik'
import { opisKroku, ostrzezenia, pigulkaWarunku, type Nazwy, type Ostrzezenie } from './warunki'

type Db = PrismaClient

export const AUDIT_AUTOMATU = 'AUTOMAT_REGULA'

export class AutomatyError extends Error {
  constructor(
    message: string,
    readonly bledy: BladReguly[] = [],
  ) {
    super(message)
  }
}

/** Kontekst walidacji: statusy firmy (także `RDZEN:<status>` dla firm bez statusów własnych). */
export function kontekstZ(statusy: readonly StatusFirmyT[]): KontekstWalidacji {
  const m = new Map<string, StatusFirmyT['baseStatus']>(statusy.map((s) => [s.key, s.baseStatus]))
  for (const s of Object.keys(STATUS_ZAMOWIENIA) as StatusFirmyT['baseStatus'][]) m.set(kluczRdzenia(s), s)
  return { statusy: m }
}

export async function nazwyFirmy(db: Db, statusy: readonly StatusFirmyT[]): Promise<Nazwy & { szablon(s: string): string }> {
  const konta = await db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, name: true, config: true } })
  const kan: Record<string, string> = { WOO: 'Sklep internetowy', ALLEGRO: 'Allegro', EMPIK: 'Empik', SHOPER: 'Shoper', PRESTASHOP: 'PrestaShop', EASYTOOLS: 'EasyTools', BL_INNE: 'Inne (BaseLinker)', RECZNE: 'Zamówienia ręczne' }
  return {
    status: (k) => statusy.find((s) => s.key === k)?.name ?? (k.startsWith('RDZEN:') ? (STATUS_ZAMOWIENIA[k.slice(6) as StatusFirmyT['baseStatus']]?.etykieta ?? k) : k),
    zrodlo: (v) => {
      const [ch, acc] = v.split(':')
      if (!acc) return `Dowolne konto ${kan[ch!] ?? ch}`
      const c = konta.find((x) => x.channel === ch && x.channelAccountId === acc)
      return c ? accountDisplayName(c.channel, c.channelAccountId, c.name, c.config) : `${kan[ch!] ?? ch}: ${acc}`
    },
    przewoznik: (c) => CARRIER_LABEL[c] ?? c,
    szablon: (s) => SZABLONY_MAILI[s as keyof typeof SZABLONY_MAILI]?.nazwa ?? s,
  }
}

export interface RegulaEkranu {
  id: string
  name: string
  enabled: boolean
  groupId: string | null
  event: RegulaT['event']
  zdarzenie: string
  conditions: RegulaT['conditions']
  actions: RegulaT['actions']
  buttonLabel: string | null
  buttonPlaces: string[]
  /** opis dla zespołu (np. powód wyłączenia) */
  description: string | null
  pigulki: { etykieta: string; wartosc: string; nie: boolean }[]
  kroki: { czasownik: string; co: string; wartosc: string }[]
  ostrzezenia: Ostrzezenie[]
  wykonan7: number
}

export interface GrupaEkranu {
  id: string
  name: string
  collapsed: boolean
}

export interface EkranAutomatow {
  grupy: GrupaEkranu[]
  reguly: RegulaEkranu[]
  statusy: { key: string; name: string; baseStatus: string }[]
  konta: { wartosc: string; nazwa: string }[]
  stanowiska: { id: string; nazwa: string }[]
  /** wbudowany plan maili do zamówień włączony (`settings.akcje.planWbudowany`) */
  planWbudowany: boolean
  /** Maile do klienta o zwrotach i reklamacjach włączone (`settings.akcje.maileZwrotow`, domyślnie nie) */
  maileZwrotow: boolean
}

/** Dane ekranu: grupy, reguły w kolejności wykonania z opisami, ostrzeżenia, listy wyboru do okna edycji. */
export async function ekranAutomatow(db: Db, now = new Date()): Promise<EkranAutomatow> {
  organizationIdOf(db)
  const sf = (await statusyFirmy(db)).statusy
  const [grupyRows, reguly, nazwy, konta, stan, licz, org] = await Promise.all([
    db.automationGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, name: true, collapsed: true } }),
    db.automationRule.findMany({ where: { hidden: false }, select: { id: true, groupId: true } }),
    nazwyFirmy(db, sf),
    db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, name: true, config: true }, orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }] }),
    db.printStation.findMany({ where: { disabledAt: null }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } }),
    db.automationRun.groupBy({ by: ['ruleId'], where: { createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) }, result: { not: 'W_TOKU' } }, _count: { _all: true } }),
    db.organization.findFirst({ select: { settings: true } }),
  ])
  const grupaReguly = new Map(reguly.map((r) => [r.id, r.groupId]))
  const lista = await regulyWKolejnosci(db)
  const nazwaReguly = new Map(lista.map((r) => [r.id, r.name]))
  const ost = ostrzezenia(
    lista.map((r, i) => ({ ...r, pozycja: i })),
    (id) => nazwaReguly.get(id) ?? id,
  )
  const ile = new Map(licz.map((x) => [x.ruleId, x._count._all]))
  const kanaly = [...new Set(konta.map((k) => k.channel))]
  return {
    grupy: grupyRows,
    reguly: lista.map((r: RegulaSilnika) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      groupId: grupaReguly.get(r.id) ?? null,
      event: r.event,
      zdarzenie: ZDARZENIA[r.event]?.nazwa ?? r.event,
      conditions: r.conditions,
      actions: r.actions,
      buttonLabel: r.buttonLabel ?? null,
      buttonPlaces: r.buttonPlaces ?? [],
      description: r.description ?? null,
      pigulki: r.conditions.map((w) => pigulkaWarunku(w, nazwy)),
      kroki: r.actions.map((a) => opisKroku(a, nazwy)),
      ostrzezenia: ost.filter((o) => o.regulaId === r.id),
      wykonan7: ile.get(r.id) ?? 0,
    })),
    statusy: sf.length ? sf.filter((s) => s.active).map((s) => ({ key: s.key, name: s.name, baseStatus: s.baseStatus })) : (Object.keys(STATUS_ZAMOWIENIA) as StatusFirmyT['baseStatus'][]).map((s) => ({ key: kluczRdzenia(s), name: STATUS_ZAMOWIENIA[s].etykieta, baseStatus: s })),
    konta: [...kanaly.map((c) => ({ wartosc: c, nazwa: nazwy.zrodlo(c) })), ...konta.map((k) => ({ wartosc: `${k.channel}:${k.channelAccountId}`, nazwa: nazwy.zrodlo(`${k.channel}:${k.channelAccountId}`) }))],
    stanowiska: stan.map((s) => ({ id: s.id, nazwa: s.name })),
    planWbudowany: planWbudowanyWlaczony(org?.settings),
    maileZwrotow: maileZwrotowWlaczone(org?.settings),
  }
}

/**
 * włączenie albo wyłączenie wbudowanego planu maili do zamówień (`settings.akcje.planWbudowany`). Blokada
 * wiersza firmy, zmiana tylko tego klucza (reszta `akcje` zostaje), ślad w AuditLog; bez zmiany = bez zapisu.
 */
export async function ustawPlanWbudowany(db: PrismaClient, wlaczony: boolean, userId: string): Promise<void> {
  const organizationId = organizationIdOf(db)
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    const raw = rows[0]?.settings
    const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Prisma.JsonValue>) : {}
    const przed = planWbudowanyWlaczony(raw ?? null)
    if (przed === wlaczony) return
    const akcje = settings['akcje'] && typeof settings['akcje'] === 'object' && !Array.isArray(settings['akcje']) ? (settings['akcje'] as Record<string, Prisma.JsonValue>) : {}
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, akcje: { ...akcje, planWbudowany: wlaczony } } as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.akcje.planWbudowany', entityId: organizationId, actorId: `user:${userId}`, before: { planWbudowany: przed }, after: { planWbudowany: wlaczony } } })
  })
}

/**
 * Włączenie albo wyłączenie maili do klienta o zwrotach i reklamacjach (`settings.akcje.maileZwrotow`, domyślnie
 * wyłączone). Ten sam wzór co plan wbudowany: blokada wiersza firmy, zmiana tylko tych kluczy, ślad w AuditLog.
 * Każde przejście wyłączone → włączone zapisuje chwilę włączenia (`akcje.maileZwrotowOd`): maile dotyczą tylko zwrotów
 * odebranych od tej chwili, więc włączenie nie wysyła zaległości. Wyłączenie zdejmuje chwilę włączenia.
 */
export async function ustawMaileZwrotow(db: PrismaClient, wlaczony: boolean, userId: string, now: Date = new Date()): Promise<void> {
  const organizationId = organizationIdOf(db)
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    const raw = rows[0]?.settings
    const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Prisma.JsonValue>) : {}
    const przed = maileZwrotowWlaczone(raw ?? null)
    if (przed === wlaczony) return
    const akcje = settings['akcje'] && typeof settings['akcje'] === 'object' && !Array.isArray(settings['akcje']) ? (settings['akcje'] as Record<string, Prisma.JsonValue>) : {}
    const reszta = { ...akcje }
    delete reszta['maileZwrotowOd']
    const po = wlaczony ? { ...reszta, maileZwrotow: true, maileZwrotowOd: now.toISOString() } : { ...reszta, maileZwrotow: false }
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, akcje: po } as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.akcje.maileZwrotow', entityId: organizationId, actorId: `user:${userId}`, before: { maileZwrotow: przed }, after: { maileZwrotow: wlaczony, ...(wlaczony ? { od: now.toISOString() } : {}) } } })
  })
}

async function audyt(db: Db | Prisma.TransactionClient, id: string, actorId: string, before: unknown, after: unknown): Promise<void> {
  await db.auditLog.create({ data: { entity: AUDIT_AUTOMATU, entityId: id, actorId: `user:${actorId}`, before: (before ?? undefined) as Prisma.InputJsonValue | undefined, after: (after ?? undefined) as Prisma.InputJsonValue | undefined } })
}

export interface WejscieReguly {
  id?: string | null
  groupId?: string | null
  enabled?: boolean
  regula: unknown
}

/** Zapis reguły (nowa albo zmiana). Błędy walidacji = AutomatyError z listą pól. Zwraca id i ostrzeżenia po zapisie. */
export async function zapiszRegule(db: Db, w: WejscieReguly, userId: string): Promise<{ id: string; ostrzezenia: Ostrzezenie[] }> {
  organizationIdOf(db)
  const sf = (await statusyFirmy(db)).statusy
  const p = parsujRegule(w.regula, kontekstZ(sf))
  if (!p.ok) throw new AutomatyError(p.bledy[0]?.komunikat ?? 'Popraw regułę', p.bledy)
  const r = p.regula
  if (w.groupId && !(await db.automationGroup.findUnique({ where: { id: w.groupId }, select: { id: true } }))) throw new AutomatyError('Tej grupy już nie ma: odśwież ekran.')
  const dane = {
    name: r.name,
    event: r.event,
    conditions: r.conditions as unknown as Prisma.InputJsonArray,
    actions: r.actions as unknown as Prisma.InputJsonArray,
    buttonLabel: r.event === 'PRZYCISK' ? (r.buttonLabel ?? null) : null,
    buttonPlaces: r.event === 'PRZYCISK' ? (r.buttonPlaces ?? []) : [],
    description: r.description ?? null,
    groupId: w.groupId ?? null,
  }
  let id: string
  if (w.id) {
    const przed = await db.automationRule.findFirst({ where: { id: w.id, hidden: false } })
    if (!przed) throw new AutomatyError('Tej reguły już nie ma: odśwież ekran.')
    const zmianaGrupy = (przed.groupId ?? null) !== (w.groupId ?? null)
    await db.automationRule.update({ where: { id: w.id }, data: { ...dane, ...(w.enabled !== undefined ? { enabled: w.enabled } : {}), ...(zmianaGrupy ? { sortOrder: await nastepnaKolejnosc(db, w.groupId ?? null) } : {}) } })
    await audyt(db, w.id, userId, { name: przed.name, event: przed.event, conditions: przed.conditions, actions: przed.actions, enabled: przed.enabled, description: przed.description }, dane)
    id = w.id
  } else {
    if ((await db.automationRule.count({ where: { hidden: false } })) >= LIMITY.regul) throw new AutomatyError(`Najwyżej ${LIMITY.regul} reguł.`)
    // nowa reguła startuje wyłączona, chyba że ekran wprost prosi o włączenie (po podglądzie na sucho)
    const n = await db.automationRule.create({ data: { ...dane, enabled: w.enabled === true, sortOrder: await nastepnaKolejnosc(db, w.groupId ?? null) }, select: { id: true } })
    await audyt(db, n.id, userId, null, dane)
    id = n.id
  }
  const lista = await regulyWKolejnosci(db)
  const nazwy = new Map(lista.map((x) => [x.id, x.name]))
  return { id, ostrzezenia: ostrzezenia(lista.map((x, i) => ({ ...x, pozycja: i })), (x) => nazwy.get(x) ?? x).filter((o) => o.regulaId === id) }
}

async function nastepnaKolejnosc(db: Db, groupId: string | null): Promise<number> {
  const m = await db.automationRule.aggregate({ where: { groupId, hidden: false }, _max: { sortOrder: true } })
  return (m._max.sortOrder ?? 0) + 10
}

/** Włączenie / wyłączenie. Włączenie sprawdza regułę od nowa (status mógł zniknąć z ustawień). */
export async function przelaczRegule(db: Db, id: string, enabled: boolean, userId: string): Promise<void> {
  const r = await db.automationRule.findFirst({ where: { id, hidden: false } })
  if (!r) throw new AutomatyError('Tej reguły już nie ma: odśwież ekran.')
  if (enabled) {
    const p = parsujRegule({ name: r.name, event: r.event, conditions: r.conditions, actions: r.actions, buttonLabel: r.buttonLabel, buttonPlaces: r.buttonPlaces }, kontekstZ((await statusyFirmy(db)).statusy))
    if (!p.ok) throw new AutomatyError(`Nie da się włączyć: ${p.bledy[0]?.komunikat ?? 'popraw regułę'}`, p.bledy)
  }
  if (r.enabled === enabled) return
  await db.automationRule.update({ where: { id }, data: { enabled } })
  await audyt(db, id, userId, { enabled: r.enabled }, { enabled })
}

/** Kopia reguły tuż pod oryginałem, wyłączona. */
export async function duplikujRegule(db: Db, id: string, userId: string): Promise<string> {
  const r = await db.automationRule.findFirst({ where: { id, hidden: false } })
  if (!r) throw new AutomatyError('Tej reguły już nie ma: odśwież ekran.')
  const nazwa = `${r.name} (kopia)`.slice(0, LIMITY.nazwa)
  await db.automationRule.updateMany({ where: { groupId: r.groupId, hidden: false, sortOrder: { gt: r.sortOrder } }, data: { sortOrder: { increment: 10 } } })
  const n = await db.automationRule.create({
    data: { name: nazwa, groupId: r.groupId, event: r.event, conditions: r.conditions as Prisma.InputJsonValue, actions: r.actions as Prisma.InputJsonValue, buttonLabel: r.buttonLabel, buttonPlaces: r.buttonPlaces, description: r.description, enabled: false, sortOrder: r.sortOrder + 5 },
    select: { id: true },
  })
  await audyt(db, n.id, userId, null, { kopiaZ: id })
  return n.id
}

/** Usunięcie: reguła z historią wykonań albo z presetu firmy zostaje ukryta i wyłączona (historia na kartach zamówień zostaje). */
export async function usunRegule(db: Db, id: string, userId: string): Promise<'usunieta' | 'ukryta'> {
  const r = await db.automationRule.findFirst({ where: { id, hidden: false } })
  if (!r) return 'usunieta'
  const runy = await db.automationRun.count({ where: { ruleId: id } })
  // reguła z presetu firmy zostaje ukryta: kolejny `org:automaty` zna jej klucz i jej nie wskrzesi
  if (runy || r.presetKey) {
    await db.automationRule.update({ where: { id }, data: { hidden: true, enabled: false } })
    await audyt(db, id, userId, { name: r.name, enabled: r.enabled }, { ukryta: true })
    return 'ukryta'
  }
  await db.automationRule.delete({ where: { id } })
  await audyt(db, id, userId, { name: r.name, event: r.event, conditions: r.conditions, actions: r.actions }, null)
  return 'usunieta'
}

/**
 * Kolejność: lista grup z identyfikatorami reguł w kolejności (`null` = reguły bez grupy). Przeniesienie reguły do
 * innej grupy przeciąganiem też idzie tędy. Reguły spoza listy nie zmieniają miejsca.
 */
export async function ustawKolejnosc(db: Db, uklad: { groupId: string | null; ids: string[] }[], userId: string): Promise<void> {
  const grupy = new Set((await db.automationGroup.findMany({ select: { id: true } })).map((g) => g.id))
  const wszystkie = uklad.flatMap((u) => u.ids)
  if (new Set(wszystkie).size !== wszystkie.length) throw new AutomatyError('Reguła powtórzona w układzie: odśwież ekran.')
  for (const u of uklad) if (u.groupId && !grupy.has(u.groupId)) throw new AutomatyError('Tej grupy już nie ma: odśwież ekran.')
  const istnieja = new Set((await db.automationRule.findMany({ where: { id: { in: wszystkie }, hidden: false }, select: { id: true } })).map((r) => r.id))
  await db.$transaction(async (tx) => {
    for (const u of uklad)
      for (const [i, id] of u.ids.entries()) if (istnieja.has(id)) await tx.automationRule.update({ where: { id }, data: { groupId: u.groupId, sortOrder: (i + 1) * 10 } })
    await audyt(tx, 'kolejnosc', userId, null, uklad as unknown as Prisma.InputJsonValue)
  })
}

// ─── Grupy ───────────────────────────────────────────────────────────────────

const nazwaGrupy = (v: unknown): string => {
  const n = typeof v === 'string' ? v.trim() : ''
  if (!n) throw new AutomatyError('Podaj nazwę grupy.')
  if (n.length > 40) throw new AutomatyError('Nazwa grupy może mieć najwyżej 40 znaków.')
  return n
}

export async function zapiszGrupe(db: Db, g: { id?: string | null; name: unknown; collapsed?: boolean }, userId: string): Promise<string> {
  const name = nazwaGrupy(g.name)
  if (g.id) {
    const r = await db.automationGroup.updateMany({ where: { id: g.id }, data: { name, ...(g.collapsed !== undefined ? { collapsed: g.collapsed } : {}) } })
    if (!r.count) throw new AutomatyError('Tej grupy już nie ma: odśwież ekran.')
    await audyt(db, g.id, userId, null, { grupa: name })
    return g.id
  }
  if ((await db.automationGroup.count()) >= LIMITY.grup) throw new AutomatyError(`Najwyżej ${LIMITY.grup} grup.`)
  const m = await db.automationGroup.aggregate({ _max: { sortOrder: true } })
  const n = await db.automationGroup.create({ data: { name, collapsed: g.collapsed ?? false, sortOrder: (m._max.sortOrder ?? 0) + 10 }, select: { id: true } })
  await audyt(db, n.id, userId, null, { grupa: name })
  return n.id
}

/** Usunięcie grupy: jej reguły przechodzą do „Bez grupy” (na koniec), nic nie znika. */
export async function usunGrupe(db: Db, id: string, userId: string): Promise<void> {
  const g = await db.automationGroup.findUnique({ where: { id }, select: { id: true, name: true } })
  if (!g) return
  const start = await nastepnaKolejnosc(db, null)
  const reguly = await db.automationRule.findMany({ where: { groupId: id }, orderBy: { sortOrder: 'asc' }, select: { id: true } })
  await db.$transaction(async (tx) => {
    for (const [i, r] of reguly.entries()) await tx.automationRule.update({ where: { id: r.id }, data: { groupId: null, sortOrder: start + i * 10 } })
    await tx.automationGroup.delete({ where: { id } })
    await audyt(tx, id, userId, { grupa: g.name }, null)
  })
}

export async function kolejnoscGrup(db: Db, ids: string[], userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.automationGroup.updateMany({ where: { id }, data: { sortOrder: (i + 1) * 10 } })
    await audyt(tx, 'grupy', userId, null, ids)
  })
}
