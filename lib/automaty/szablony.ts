// Szablony przepływów dla nowej firmy: gotowe statusy i automatyczne akcje do wyboru jednym kliknięciem
// (lista startu, Ustawienia → Automatyczne akcje → „Wczytaj szablon”). Pliki `lib/automaty/szablony-przeplywow/<id>.json` to treść
// produktu (bez nazw firm; poza seed/, bo kod produkcyjny nie importuje presetów), importowana statycznie: jest w bundlu panelu i polecenia, bez odczytu z dysku.
//
// Dwa tryby wczytania (`planWczytania`, czysta funkcja):
//  - PELNY: firma bez reguł, bez zamówień, ze statusami nietkniętymi (domyślne albo brak): statusy szablonu zastępują
//    nazwy domyślne (te same klucze etapów), grupy i reguły szablonu włączone — firma od razu pracuje na szablonie;
//  - DODANIE: każda inna firma. Statusy firmy zostają bez zmian, reguły szablonu idą do nowej, wyłączonej grupy
//    „Szablon: <nazwa>”, a każdy status z reguły szablonu wskazuje status firmy tego samego etapu (ten sam klucz,
//    inaczej pierwszy aktywny status firmy tego etapu, inaczej sam etap). Niczego nie nadpisuje.
import type { OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { DOMYSLNE_STATUSY, kluczRdzenia, sortujStatusy, STATUS_ZAMOWIENIA, validateZestawStatusow, type GrupaStatusowT, type StatusFirmyT } from '@/lib/panel/statusy'
import kurier from './szablony-przeplywow/kurier-i-paczkomaty.json'
import odbior from './szablony-przeplywow/odbior-osobisty.json'
import allegro from './szablony-przeplywow/allegro-wysylam-z-allegro.json'
import bezWysylki from './szablony-przeplywow/bez-wysylki.json'
import { kontekstZ } from './dane'
import { krokiNigdyDozwolone, parsujRegule, type Krok, type Warunek } from './schemat'
import { AUDIT_SZABLONU, parsujRegulyPresetu, type GrupaPresetuT, type RegulaGotowa, type RegulaPresetuT } from './szablon'
import { zalozReguly } from './preset'

type Db = PrismaClient

export interface SzablonPrzeplywu {
  id: string
  nazwa: string
  dlaKogo: string
  opis: string[]
  kolejnosc: number
  statusGroups: GrupaStatusowT[]
  statuses: StatusFirmyT[]
  automationGroups: Required<GrupaPresetuT>[]
  automationRules: RegulaGotowa[]
}

interface SurowySzablon {
  id: string
  nazwa: string
  dlaKogo: string
  opis: string[]
  kolejnosc: number
  statusGroups: GrupaStatusowT[]
  statuses: (Omit<StatusFirmyT, 'carriers'> & { carriers?: string[] })[]
  automationGroups: GrupaPresetuT[]
  automationRules: RegulaPresetuT[]
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Sprawdza plik szablonu (statusy jak preset, reguły `parsujRegulyPresetu`). Zły plik = błąd przy starcie, nie po cichu. */
export function zbudujSzablon(raw: unknown): SzablonPrzeplywu {
  const s = raw as SurowySzablon
  if (!s || typeof s !== 'object' || !ID_RE.test(String(s.id))) throw new Error(`Szablon: zły identyfikator „${String((s as { id?: unknown })?.id)}”`)
  for (const k of ['nazwa', 'dlaKogo'] as const) if (typeof s[k] !== 'string' || !s[k].trim()) throw new Error(`Szablon ${s.id}: brak pola ${k}`)
  if (!Array.isArray(s.opis) || !s.opis.length) throw new Error(`Szablon ${s.id}: brak opisu`)
  const statuses: StatusFirmyT[] = s.statuses.map((x) => ({ ...x, customerName: x.customerName ?? null, groupKey: x.groupKey ?? null, carriers: [...(x.carriers ?? [])] as StatusFirmyT['carriers'], active: x.active ?? true }))
  validateZestawStatusow(statuses, s.statusGroups)
  // parsujRegule (w parsujRegulyPresetu) odrzuca też kroki, których rdzeń nigdy nie wykona (`krokiNigdyDozwolone`
  // na statusach szablonu), więc i tryb PELNY nie przemyci przejścia wstecz (test w szablony.test.ts)
  const r = parsujRegulyPresetu(s.automationGroups, s.automationRules, statuses)
  return { id: s.id, nazwa: s.nazwa.trim(), dlaKogo: s.dlaKogo.trim(), opis: s.opis, kolejnosc: s.kolejnosc ?? 0, statusGroups: s.statusGroups, statuses, automationGroups: r.grupy, automationRules: r.reguly }
}

/** Wszystkie szablony w kolejności wyświetlania. */
export const SZABLONY: readonly SzablonPrzeplywu[] = [kurier, odbior, allegro, bezWysylki].map(zbudujSzablon).sort((a, b) => a.kolejnosc - b.kolejnosc)

export function szablonPrzeplywu(id: string | null | undefined): SzablonPrzeplywu | null {
  return SZABLONY.find((s) => s.id === id) ?? null
}

// ─── Dopasowanie statusów szablonu do statusów firmy ─────────────────────────

/**
 * Status firmy dla statusu szablonu: ten sam klucz i etap, inaczej pierwszy aktywny status firmy tego etapu (bez
 * przewoźników przed tymi z przewoźnikami), inaczej sam etap (`RDZEN:<etap>`). Firma bez statusów = sam etap.
 */
export function statusFirmyDla(szablonowy: Pick<StatusFirmyT, 'key' | 'baseStatus'>, firmy: readonly StatusFirmyT[]): string {
  const ten = firmy.find((f) => f.key === szablonowy.key && f.baseStatus === szablonowy.baseStatus && f.active)
  if (ten) return ten.key
  const etap = sortujStatusy(firmy.filter((f) => f.active && f.baseStatus === szablonowy.baseStatus))
  const ogolny = etap.find((f) => !f.carriers.length) ?? etap[0]
  return ogolny ? ogolny.key : kluczRdzenia(szablonowy.baseStatus)
}

/** Reguła z kluczami statusów szablonu przepisana na klucze statusów firmy (warunek „Status” i krok „Ustaw status”). */
export function przepiszRegule<T extends { conditions: Warunek[]; actions: Krok[] }>(r: T, mapa: ReadonlyMap<string, string>): T {
  const m = (k: string) => mapa.get(k) ?? k
  return {
    ...r,
    conditions: r.conditions.map((w) => (w.typ === 'status' ? { ...w, wartosci: [...new Set(w.wartosci.map(m))] } : w)),
    actions: r.actions.map((a) => (a.typ === 'ustawStatus' ? { ...a, status: m(a.status) } : a)),
  }
}

export interface DopasowanieStatusu {
  szablon: string
  nazwaSzablonu: string
  etap: string
  /** klucz statusu firmy albo `RDZEN:<etap>` */
  klucz: string
  nazwa: string
  /** status firmy o tej samej nazwie co w szablonie */
  takiSam: boolean
}

export interface RegulaPlanu {
  nazwa: string
  zdarzenie: string
  /** null = reguła przejdzie; tekst = dlaczego jej nie przeniesiemy */
  pominieta: string | null
}

export interface PlanWczytania {
  szablon: { id: string; nazwa: string }
  tryb: 'PELNY' | 'DODANIE'
  /** Dlaczego taki tryb (zdanie dla ekranu). */
  powodTrybu: string
  /** Nazwa nowej grupy (tryb DODANIE); w trybie PELNY grupy szablonu. */
  grupa: string | null
  /** PELNY: statusy, które zmienią nazwę (klucz, było, będzie). */
  zmianyStatusow: { klucz: string; bylo: string; bedzie: string; ukryty: boolean }[]
  /** DODANIE: jak statusy szablonu trafią na statusy firmy. */
  dopasowania: DopasowanieStatusu[]
  reguly: RegulaPlanu[]
  /** Reguły włączone od razu (PELNY) albo wyłączone (DODANIE). */
  wlaczone: boolean
  ostrzezenia: string[]
}

export interface StanFirmyDlaSzablonu {
  statusy: StatusFirmyT[]
  grupy: GrupaStatusowT[]
  regul: number
  zamowien: number
  nazwyGrupAutomatow: string[]
}

/** Statusy nietknięte: brak albo dokładnie domyślne (klucze, nazwy, etapy) — firma ich jeszcze nie ustawiała. */
export function statusyNietkniete(statusy: readonly StatusFirmyT[]): boolean {
  if (!statusy.length) return true
  if (statusy.length !== DOMYSLNE_STATUSY.length) return false
  return DOMYSLNE_STATUSY.every((d) => statusy.some((s) => s.key === d.key && s.name === d.name && s.baseStatus === d.baseStatus && s.active && (s.customerName ?? null) === null && !s.carriers.length))
}

const nazwaGrupySzablonu = (nazwa: string, istniejace: readonly string[]) => {
  const baza = `Szablon: ${nazwa}`.slice(0, 36)
  if (!istniejace.includes(baza)) return baza
  for (let i = 2; i < 100; i++) if (!istniejace.includes(`${baza} (${i})`)) return `${baza} (${i})`
  return `${baza} (${Date.now().toString(36).slice(-3)})`
}

/** Plan wczytania szablonu do firmy (czysty): tryb, co się zmieni, które reguły przejdą. Nic nie zapisuje. */
export function planWczytania(sz: SzablonPrzeplywu, f: StanFirmyDlaSzablonu): PlanWczytania {
  const pelny = f.regul === 0 && f.zamowien === 0 && statusyNietkniete(f.statusy)
  const ostrzezenia: string[] = []
  if (pelny) {
    const zmianyStatusow = sz.statuses
      .map((s) => ({ klucz: s.key, bylo: f.statusy.find((x) => x.key === s.key)?.name ?? STATUS_ZAMOWIENIA[s.baseStatus].etykieta, bedzie: s.name, ukryty: !s.active }))
      .filter((z) => z.bylo !== z.bedzie || z.ukryty)
    return {
      szablon: { id: sz.id, nazwa: sz.nazwa },
      tryb: 'PELNY',
      powodTrybu: 'Firma nie ma jeszcze zamówień ani automatycznych akcji: statusy i reguły szablonu wejdą w całości, reguły od razu włączone.',
      grupa: null,
      zmianyStatusow,
      dopasowania: [],
      reguly: sz.automationRules.map((r) => ({ nazwa: r.name, zdarzenie: r.event, pominieta: null })),
      wlaczone: true,
      ostrzezenia,
    }
  }
  const mapa = new Map<string, string>()
  const dopasowania: DopasowanieStatusu[] = []
  for (const s of sz.statuses) {
    const k = statusFirmyDla(s, f.statusy)
    mapa.set(s.key, k)
    const def = f.statusy.find((x) => x.key === k)
    dopasowania.push({ szablon: s.key, nazwaSzablonu: s.name, etap: STATUS_ZAMOWIENIA[s.baseStatus].etykieta, klucz: k, nazwa: def?.name ?? STATUS_ZAMOWIENIA[s.baseStatus].etykieta, takiSam: !!def && def.name === s.name })
  }
  const kontekst = kontekstZ(f.statusy)
  const reguly: RegulaPlanu[] = sz.automationRules.map((r) => {
    const p = parsujRegule(przepiszRegule(r, mapa), kontekst)
    return { nazwa: r.name, zdarzenie: r.event, pominieta: p.ok ? null : (p.bledy[0]?.komunikat ?? 'reguła nie pasuje do statusów firmy') }
  })
  if (f.regul > 0) ostrzezenia.push(`Firma ma już reguły (${f.regul}): zostaną bez zmian. Nowe reguły sprawdź przyciskiem „Sprawdź na ostatnich 7 dniach”, zanim je włączysz.`)
  const grupa = nazwaGrupySzablonu(sz.nazwa, f.nazwyGrupAutomatow)
  if (grupa !== `Szablon: ${sz.nazwa}`.slice(0, 36)) ostrzezenia.push('Ten szablon był już wczytany: powstanie kolejna grupa z tymi samymi regułami.')
  return {
    szablon: { id: sz.id, nazwa: sz.nazwa },
    tryb: 'DODANIE',
    powodTrybu: f.zamowien > 0 || f.regul > 0 ? 'Firma ma już zamówienia albo reguły: statusy zostają bez zmian, reguły szablonu trafią do nowej, wyłączonej grupy.' : 'Statusy firmy są już zmienione: zostają bez zmian, reguły szablonu trafią do nowej, wyłączonej grupy.',
    grupa,
    zmianyStatusow: [],
    dopasowania,
    reguly,
    wlaczone: false,
    ostrzezenia,
  }
}

async function stanFirmy(db: Db | Prisma.TransactionClient): Promise<StanFirmyDlaSzablonu> {
  const [st, grupy, regul, zamowien, grupyAut] = await Promise.all([
    db.orderStatusDef.findMany({ select: { key: true, name: true, customerName: true, color: true, groupKey: true, sortOrder: true, baseStatus: true, carriers: true, active: true } }),
    db.orderStatusGroup.findMany({ select: { key: true, name: true, sortOrder: true, collapsed: true } }),
    db.automationRule.count(),
    db.order.count(),
    db.automationGroup.findMany({ select: { name: true } }),
  ])
  return { statusy: sortujStatusy(st), grupy: sortujStatusy(grupy), regul, zamowien, nazwyGrupAutomatow: grupyAut.map((g) => g.name) }
}

export class SzablonError extends Error {}

/** „1 reguła”, „3 reguły”, „5 reguł”, „22 reguły”. */
export function liczbaRegul(n: number): string {
  const d = n % 10
  const s = n % 100
  return `${n} ${n === 1 ? 'reguła' : d >= 2 && d <= 4 && (s < 12 || s > 14) ? 'reguły' : 'reguł'}`
}

/** Podgląd wczytania (ekran, przed zapisem). */
export async function podgladSzablonu(db: Db, id: string): Promise<PlanWczytania> {
  organizationIdOf(db)
  const sz = szablonPrzeplywu(id)
  if (!sz) throw new SzablonError('Nie ma takiego szablonu.')
  return planWczytania(sz, await stanFirmy(db))
}

export interface WynikWczytania {
  tryb: PlanWczytania['tryb']
  reguly: number
  pominiete: number
  statusy: number
  grupa: string | null
}

/**
 * Wczytanie szablonu w jednej transakcji (blokada wiersza firmy: dwa kliknięcia naraz dają jeden plan liczony po
 * kolei). Plan liczony od nowa w transakcji, więc firma, która w międzyczasie dostała zamówienie, wpada w DODANIE.
 * Zamówienie przyjęte w oknie samej transakcji PELNY zachowuje status (statusy idą upsertem po tych samych kluczach,
 * nic nie jest usuwane); nie złapie tylko reguły na zdarzenie, które poszło przed założeniem reguł.
 */
export async function wczytajSzablon(db: Db, id: string, userId: string): Promise<WynikWczytania> {
  const organizationId = organizationIdOf(db)
  const sz = szablonPrzeplywu(id)
  if (!sz) throw new SzablonError('Nie ma takiego szablonu.')
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    const f = await stanFirmy(tx)
    const plan = planWczytania(sz, f)
    let wynik: WynikWczytania
    if (plan.tryb === 'PELNY') {
      for (const g of sz.statusGroups)
        await tx.orderStatusGroup.upsert({ where: { organizationId_key: { organizationId, key: g.key } }, create: { organizationId, ...g }, update: { name: g.name, sortOrder: g.sortOrder, collapsed: g.collapsed } })
      for (const s of sz.statuses) {
        const dane = { name: s.name, customerName: s.customerName ?? null, color: s.color, groupKey: s.groupKey ?? null, sortOrder: s.sortOrder, baseStatus: s.baseStatus, carriers: [...s.carriers], active: s.active }
        await tx.orderStatusDef.upsert({ where: { organizationId_key: { organizationId, key: s.key } }, create: { organizationId, key: s.key, ...dane }, update: dane })
      }
      // grupy domyślne, których szablon nie używa (np. „Gotowe” w szablonie bez wysyłki) i do których nic nie należy
      const uzywane = new Set((await tx.orderStatusDef.findMany({ select: { groupKey: true } })).map((x) => x.groupKey).filter(Boolean))
      await tx.orderStatusGroup.deleteMany({ where: { key: { notIn: [...sz.statusGroups.map((g) => g.key), ...uzywane] as string[] } } })
      const z = await zalozReguly(tx, organizationId, { grupy: sz.automationGroups, reguly: sz.automationRules }, { wlaczone: true })
      wynik = { tryb: 'PELNY', reguly: z.reguly, pominiete: 0, statusy: sz.statuses.length, grupa: null }
    } else {
      const mapa = new Map(plan.dopasowania.map((d) => [d.szablon, d.klucz]))
      const kontekst = kontekstZ(f.statusy)
      const reguly: RegulaGotowa[] = []
      for (const r of sz.automationRules) {
        const p = parsujRegule(przepiszRegule(r, mapa), kontekst)
        if (p.ok && !krokiNigdyDozwolone(p.regula, kontekst).length) reguly.push({ ...r, ...p.regula, enabled: false })
      }
      const z = await zalozReguly(tx, organizationId, { grupy: [], reguly }, { grupaZbiorcza: plan.grupa!, wlaczone: false })
      wynik = { tryb: 'DODANIE', reguly: z.reguly, pominiete: sz.automationRules.length - reguly.length, statusy: 0, grupa: plan.grupa }
    }
    await tx.auditLog.create({ data: { entity: AUDIT_SZABLONU, entityId: sz.id, actorId: `user:${userId}`, after: { ...wynik } as unknown as Prisma.InputJsonObject } })
    return wynik
  })
}

/** Etap rdzenia statusu szablonu (do testów i opisów). */
export const etapStatusu = (sz: SzablonPrzeplywu, klucz: string): OrderStatus | null => sz.statuses.find((s) => s.key === klucz)?.baseStatus ?? null

