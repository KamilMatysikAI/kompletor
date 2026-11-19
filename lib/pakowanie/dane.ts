// Kolejka pakowania w panelu: odczyty i zapisy przez klienta firmy z sesji (RLS). Każda funkcja odmawia
// klienta systemowego (`organizationIdOf` rzuca błąd), jak lib/panel/dane.ts. Logika kolejki: czyste funkcje
// w harmonogram.ts, kolejka.ts i strefy.ts. Zmian statusów zamówień tu nie ma (akcje masowe); „Przyjechał”
// zleca tylko operację w tle „Wysłane” (wyslane-po-przyjezdzie.ts).
import type { Carrier, Channel, PaymentState, Prisma, PrismaClient, Unit } from '@prisma/client'
import { glowneZdjecia } from '../produkty/zdjecia'
import { plikLogo } from '../firma/logo'
import { organizationIdOf } from '@/lib/db'
import { accountName, accounts } from '@/lib/panel/dane'
import { channelPrefix, CARRIER_LABEL, shortExternalId } from '@/lib/panel/format'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { numerKartyZamowienia } from '@/lib/stanowisko/kod'
import { koszykiZamowien } from '@/lib/koszyki/koszyki'
import { SLOWNIK } from '@/lib/panel/slownik'
import { zamowieniaZFakturaBl } from '@/lib/rdzen/faktura-bl'
import type { ListaWysylkowaDane, NumerZamowienia } from '@/lib/wydruki/typy'
import { dayLabel, nextPickup, PICKUP_CARRIERS, PICKUP_CARRIERS_NA_ZADANIE, validateSchedule, warsawMinute, type NextPickup, type PickupArrivalT, type PickupCarrier, type PickupScheduleT } from './harmonogram'
import { raportyPrzyjazdow, zlecWyslanePoPrzyjezdzie } from './wyslane-po-przyjezdzie'
import { buildQueue, pageOfQueue, QUEUE_STATUSES, type QueueGroup, type QueueOrder } from './kolejka'
import { matchesZone, orderZone, parseZoneFilter, productZone, sortZones, zoneCounts, type ZoneCounts, type ZoneDefT, type ZoneFilter, type ZoneOfProduct, type ZoneRuleT } from './strefy'

type Db = PrismaClient

function assertOrg(db: Db): void {
  organizationIdOf(db)
}

/**
 * Zakładki kolejki: konta kanałów w pracy (statusy zapisuje ten system), w cieniu (pakowanie próbne), czekające na
 * etykietę. Klucze zostają (adresy `?zakladka=`), nazwy ze słownika UI (przegląd 06.11: bez „naprawdę / na sucho”).
 */
export const QUEUE_TABS = {
  naprawde: SLOWNIK.doSpakowania,
  na_sucho: SLOWNIK.pakowanieProbne,
  etykiety: 'Czekają na etykietę',
} as const
export type QueueTab = keyof typeof QUEUE_TABS

export function isQueueTab(v: string | undefined): v is QueueTab {
  return !!v && Object.prototype.hasOwnProperty.call(QUEUE_TABS, v)
}

export const QUEUE_PAGE_SIZE = 100
/** Górna granica zamówień czytanych do kolejki (sezon ~1 100 dziennie); więcej = komunikat na ekranie. */
export const QUEUE_LIMIT = 3000
/**
 * Spakowane czytamy tylko z ostatnich dni (zmiana zamówienia w oknie): starsze dawno pojechały z kurierem albo
 * czekają poza kolejką, a bez okna wypełniałyby QUEUE_LIMIT i wypychały z kolejki nowe zamówienia.
 */
export const PACKED_WINDOW_DAYS = 14
/** Okno kliknięć „Przyjechał” czytanych do kolejki — z zapasem nad PACKED_WINDOW_DAYS (zdarzenie SPAKOWANE bywa starsze niż zmiana zamówienia). */
const ARRIVALS_WINDOW_DAYS = 60
/** Lista wysyłkowa: najwięcej zamówień na jeden wydruk. */
export const SHIPPING_LIST_LIMIT = 200

export interface QueueLine {
  title: string
  /** główne zdjęcie produktu; brak = zaślepka. */
  zdjecie?: string | null
  sku: string | null
  qty: number
  unit: Unit
  bundle: boolean
  /** miejsce na półce (np. C-4-2) z katalogu; null = bez lokalizacji. */
  lokalizacja?: string | null
}

export interface QueueRow extends QueueOrder {
  channel: Channel
  channelAccountId: string
  accountName: string
  /** Numer do pokazania: przedrostek kanału + numer z kanału (SD 48213). */
  number: string
  externalId: string
  mode: 'PRACA' | 'CIEN'
  paymentState: PaymentState
  totalGross: number
  /** Wynik ćwiczenia na sucho: po zamknięciu okna pakowania widać, co już przećwiczone. */
  cwiczenie: 'SPAKOWANE' | 'NIE_SPAKOWANO' | null
  lines: QueueLine[]
  /** koszyk, w którym leży zamówienie (nazwa); null = bez koszyka. */
  koszyk: string | null
}

export interface PackingQueue {
  now: Date
  tab: QueueTab
  zone: ZoneFilter
  tabCounts: Record<QueueTab, number>
  zoneCounts: ZoneCounts
  /** strefy firmy (kolejność filtrów); pusta lista = firma bez stref, bez filtrów. */
  zones: ZoneDefT[]
  groups: QueueGroup<QueueRow>[]
  page: number
  pages: number
  /** Zamówień w widoku (po filtrze strefy). */
  total: number
  /** W bazie jest więcej zamówień przed wysyłką niż QUEUE_LIMIT. */
  truncated: boolean
  /** Ile zamówień nie zmieściło się w QUEUE_LIMIT (0, gdy truncated = false). */
  hidden: number
  /** Którykolwiek harmonogram ma wartości przykładowe z seedu. */
  exampleSchedules: boolean
  /**
   * zamówienia kont w trybie pracy z fakturą z BaseLinkera (kończy je BaseLinker): poza kolejką „do
   * spakowania”, na ekranie osobna ramka z numerami. Pakowanie i tak odmawia (`blokadaPakowaniaFakturaBl`).
   */
  konczyBl: { id: string; number: string; faktura: string }[]
}

const num = (v: { toString(): string } | null | undefined): number => (v === null || v === undefined ? 0 : Number(v.toString()))

function scheduleOf(r: { carrier: Carrier; weekdays: number[]; pickupMinute: number; promiseUntilMinute: number; active: boolean; example: boolean }): PickupScheduleT {
  return { carrier: r.carrier, weekdays: [...r.weekdays].sort((a, b) => a - b), pickupMinute: r.pickupMinute, promiseUntilMinute: r.promiseUntilMinute, active: r.active, example: r.example }
}

/**
 * Kliknięcia „Przyjechał” potrzebne kolejce: ostatnie każdego przewoźnika (co pojechało z kurierem) i zamknięte
 * odbiory od wczoraj (najbliższy odbiór). Starsze nie zmieniają ani jednego, ani drugiego.
 */
async function arrivalsFor(db: Db, now: Date): Promise<PickupArrivalT[]> {
  const since = new Date(now.getTime() - 2 * 86_400_000)
  // `distinct` Prisma robi w pamięci, więc ostatnie kliknięcie szukamy w oknie: starsze niż
  // ARRIVALS_WINDOW_DAYS nie zmienia, co pojechało, bo spakowane czytamy tylko z PACKED_WINDOW_DAYS
  const lastSince = new Date(now.getTime() - ARRIVALS_WINDOW_DAYS * 86_400_000)
  const [last, recent] = await Promise.all([
    db.carrierPickupEvent.findMany({ where: { arrivedAt: { gte: lastSince } }, distinct: ['carrier'], orderBy: [{ carrier: 'asc' }, { arrivedAt: 'desc' }] }),
    db.carrierPickupEvent.findMany({ where: { arrivedAt: { gte: since } }, orderBy: { arrivedAt: 'desc' }, take: 200 }),
  ])
  const byId = new Map([...last, ...recent].map((e) => [e.id, e]))
  // raport automatu „Wysłane” przy każdym przyjeździe
  const raporty = await raportyPrzyjazdow(db, [...byId.keys()], now)
  return [...byId.values()].map((e) => ({ carrier: e.carrier, pickupDay: e.pickupDay, arrivedAt: e.arrivedAt, actorName: e.actorName, wysylka: raporty.get(e.id) ?? null }))
}

/** strefy firmy w kolejności filtrów. */
export async function zoneDefs(db: Db): Promise<ZoneDefT[]> {
  return sortZones(await db.packingZoneDef.findMany({ select: { key: true, name: true, color: true, sortOrder: true } }))
}

async function zoneRules(db: Db): Promise<ZoneRuleT[]> {
  return (await db.productZoneRule.findMany({ orderBy: { priority: 'asc' } })).map((r) => ({ priority: r.priority, pattern: r.pattern, zone: r.zone }))
}

/** Zamówienia przed wysyłką jako wiersze kolejki (strefa, tryb konta, produkty). */
async function queueRows(
  db: Db,
  now: Date,
  accs: Awaited<ReturnType<typeof accounts>>,
  limit: number,
): Promise<{ rows: QueueRow[]; truncated: boolean; hidden: number; konczyBl: PackingQueue['konczyBl'] }> {
  const packedSince = new Date(now.getTime() - PACKED_WINDOW_DAYS * 86_400_000)
  const where: Prisma.OrderWhereInput = {
    OR: [
      { status: { in: QUEUE_STATUSES.filter((s) => s !== 'SPAKOWANE') } },
      { status: 'SPAKOWANE', updatedAt: { gte: packedSince } },
    ],
  }
  const [rules, list] = await Promise.all([
    zoneRules(db),
    db.order.findMany({
      where,
      orderBy: [{ createdAtChannel: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        channel: true,
        channelAccountId: true,
        externalId: true,
        status: true,
        carrier: true,
        paymentState: true,
        totalGross: true,
        createdAtChannel: true,
        updatedAt: true,
        blOrderId: true,
        parentOrderId: true,
        flags: true,
        lines: { where: { removed: false }, orderBy: { createdAt: 'asc' }, select: { productId: true, qty: true, channelName: true, channelSku: true } },
        events: { where: { kind: 'SPAKOWANE' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
      },
    }),
  ])
  const truncated = list.length > limit
  const hidden = truncated ? (await db.order.count({ where })) - limit : 0
  const wszystkie = list.slice(0, limit)
  // konto w trybie pracy + faktura BL przed spakowaniem = kończy BaseLinker (poza kolejką, osobna ramka).
  // Konta w podglądzie i firma bez BL: nic się nie zmienia. Konto bez konfiguracji liczy się jak tryb pracy, tak samo
  // jak w rdzeniu (`kontoWPodgladzie`): lista nie pokazuje do pakowania zamówienia, którego pakowanie rdzeń odrzuci.
  const wPracy = (o: (typeof wszystkie)[number]) => accs.find((a) => a.channel === o.channel && a.channelAccountId === o.channelAccountId)?.statusMode !== 'CIEN'
  const doSprawdzenia = wszystkie.filter((o) => o.status !== 'SPAKOWANE' && wPracy(o))
  const zFakturaBl = doSprawdzenia.length ? await zamowieniaZFakturaBl(db, doSprawdzenia) : new Map<string, string>()
  const orders = wszystkie.filter((o) => !zFakturaBl.has(o.id))
  const konczyBl = wszystkie
    .filter((o) => zFakturaBl.has(o.id))
    .map((o) => ({ id: o.id, number: `${channelPrefix(o.channel, accountName(accs, o.channel, o.channelAccountId))} ${shortExternalId(o.externalId)}`, faktura: zFakturaBl.get(o.id)! }))
  const ids = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.productId).filter((x): x is string => !!x)))]
  const prods = ids.length
    ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, sku: true, unit: true, kind: true, packingZone: true } })
    : []
  const byId = new Map(prods.map((p) => [p.id, { ...p, zone: productZone(p, rules).zone }]))
  const zdj = await glowneZdjecia(db, ids) // miniatury w kolejce pakowania
  // lokalizacja przy każdej pozycji i koszyk zamówienia
  const [stocks, koszyki] = await Promise.all([
    ids.length ? db.stock.findMany({ where: { productId: { in: ids }, location: { not: null } }, select: { productId: true, location: true } }) : [],
    koszykiZamowien(db, orders.map((o) => o.id)),
  ])
  const lok = new Map<string, string>()
  for (const st of stocks) if (st.location?.trim() && !lok.has(st.productId)) lok.set(st.productId, st.location.trim())
  const cwiczenia = new Map<string, 'SPAKOWANE' | 'NIE_SPAKOWANO'>()
  const zapisane = orders.length ? await db.packDrill.findMany({ where: { orderId: { in: orders.map((o) => o.id) }, outcome: { not: null } }, select: { orderId: true, outcome: true } }) : []
  for (const d of zapisane) if (d.outcome === 'SPAKOWANE' || !cwiczenia.has(d.orderId)) cwiczenia.set(d.orderId, d.outcome as 'SPAKOWANE' | 'NIE_SPAKOWANO')
  // produkt bez stanu (e-book) nie jest do zebrania: poza wierszem i strefą; zamówienie z samymi
  // produktami bez stanu nie trafia do kolejki pakowania
  const doZebrania = (o: (typeof orders)[number]) =>
    o.lines.map((l) => ({ l, p: l.productId ? byId.get(l.productId) : undefined })).filter(({ p }) => p?.kind !== 'DIGITAL')
  const rows = orders.filter((o) => doZebrania(o).length > 0).map((o): QueueRow => {
    const acc = accs.find((a) => a.channel === o.channel && a.channelAccountId === o.channelAccountId)
    const name = accountName(accs, o.channel, o.channelAccountId)
    const lines = doZebrania(o)
    return {
      id: o.id,
      carrier: o.carrier,
      status: o.status,
      // spakowane bez zdarzenia (np. status z importu) — ostatnia zmiana zamówienia
      packedAt: o.status === 'SPAKOWANE' ? (o.events[0]?.createdAt ?? o.updatedAt) : null,
      createdAtChannel: o.createdAtChannel,
      zone: orderZone(lines.map(({ p }) => p?.zone ?? null)),
      channel: o.channel,
      channelAccountId: o.channelAccountId,
      accountName: name,
      number: `${channelPrefix(o.channel, name)} ${shortExternalId(o.externalId)}`,
      externalId: o.externalId,
      mode: acc?.statusMode === 'PRACA' ? 'PRACA' : 'CIEN',
      paymentState: o.paymentState,
      totalGross: num(o.totalGross),
      cwiczenie: cwiczenia.get(o.id) ?? null,
      koszyk: koszyki.get(o.id) ?? null,
      lines: lines.map(({ l, p }) => ({ lokalizacja: p ? (lok.get(p.id) ?? null) : null, zdjecie: p ? (zdj.get(p.id) ?? null) : null, title: p?.title ?? (l.channelName ? `${l.channelName} (bez powiązania z produktem)` : 'pozycja bez powiązania z produktem'), sku: p?.sku ?? l.channelSku ?? null, qty: l.qty, unit: p?.unit ?? 'SZT', bundle: p?.kind === 'BUNDLE' })),
    }
  })
  return { rows, truncated, hidden, konczyBl }
}

async function schedules(db: Db): Promise<PickupScheduleT[]> {
  return (await db.carrierPickup.findMany()).map(scheduleOf)
}

const inTab = (r: QueueRow, tab: QueueTab) => (tab === 'naprawde' ? r.mode === 'PRACA' : tab === 'na_sucho' ? r.mode === 'CIEN' : false)

/**
 * Kolejka „do spakowania” dla zakładki i filtru strefy. Paski kurierów („zostało N”) liczą całą zakładkę, nie tylko
 * filtr strefy; liczby przy filtrze strefy — zamówienia zakładki widoczne na kolejce (bez tych, które pojechały).
 * „Czekają na etykietę” jest pusta do czasu adapterów przewoźników.
 */
export async function packingQueue(
  db: Db,
  opts: { tab: QueueTab; zone: ZoneFilter; page?: number; accounts?: Awaited<ReturnType<typeof accounts>>; limit?: number },
  now = new Date(),
): Promise<PackingQueue> {
  assertOrg(db)
  const accs = opts.accounts ?? (await accounts(db))
  const [{ rows, truncated, hidden, konczyBl }, sch, arrivals, zones] = await Promise.all([queueRows(db, now, accs, opts.limit ?? QUEUE_LIMIT), schedules(db), arrivalsFor(db, now), zoneDefs(db)])
  const visibleCount = (tab: QueueTab) => buildQueue(rows.filter((r) => inTab(r, tab)), sch, arrivals, now).reduce((s, g) => s + g.orders.length, 0)
  const tabCounts: Record<QueueTab, number> = { naprawde: visibleCount('naprawde'), na_sucho: visibleCount('na_sucho'), etykiety: 0 }
  const all = buildQueue(rows.filter((r) => inTab(r, opts.tab)), sch, arrivals, now)
  const zc = zoneCounts(all.flatMap((g) => g.orders.map((o) => o.zone)))
  // filtr z adresu sprawdzony z listą stref firmy (nieznana strefa = wszystkie)
  const zone = parseZoneFilter(opts.zone, zones)
  const filtered = all.map((g) => ({ ...g, orders: g.orders.filter((o) => matchesZone(o.zone, zone)) }))
  const page = pageOfQueue(opts.tab === 'etykiety' ? [] : filtered, Math.max(1, Math.floor(opts.page ?? 1)), QUEUE_PAGE_SIZE)
  return {
    now,
    tab: opts.tab,
    zone,
    tabCounts,
    zoneCounts: zc,
    zones,
    groups: page.groups,
    page: Math.min(Math.max(1, Math.floor(opts.page ?? 1)), page.pages),
    pages: page.pages,
    total: page.total,
    truncated,
    hidden,
    exampleSchedules: sch.some((s) => s.active && s.example),
    konczyBl,
  }
}

// ─── „Przyjechał <przewoźnik>” ───────────────────────────────────────────────

export function isPickupCarrier(v: string): v is PickupCarrier {
  return (PICKUP_CARRIERS as readonly string[]).includes(v)
}

export interface ArrivalResult {
  arrival: PickupArrivalT
  /** false = odbiór dnia był już zamknięty (podwójne kliknięcie) — nic nie zapisano. */
  created: boolean
  next: NextPickup | null
}

/**
 * Kurier przyjechał: zamyka DZISIEJSZY odbiór przewoźnika (także poza harmonogramem — dodatkowy przyjazd).
 * Jedno kliknięcie na dzień: drugie nie zamyka jutrzejszego odbioru, tylko zwraca pierwsze.
 */
export async function markCarrierArrived(db: Db, input: { carrier: Carrier; actorId: string; actorName: string; now?: Date }): Promise<ArrivalResult> {
  assertOrg(db)
  if (!isPickupCarrier(input.carrier)) throw new Error(`Nieznany przewoźnik: ${input.carrier}`)
  const now = input.now ?? new Date()
  const pickupDay = toWarsaw(now).day
  const actorName = input.actorName.trim().slice(0, 120) || input.actorId
  const r = await db.carrierPickupEvent.createMany({
    data: [{ carrier: input.carrier, pickupDay, arrivedAt: now, actorId: input.actorId, actorName }],
    skipDuplicates: true,
  })
  const ev = await db.carrierPickupEvent.findUniqueOrThrow({
    where: { organizationId_carrier_pickupDay: { organizationId: organizationIdOf(db), carrier: input.carrier, pickupDay } },
  })
  // pierwsze kliknięcie dnia = operacja w tle „spakowane z numerem nadania → Wysłane” (drugie nic nie dokłada)
  if (r.count === 1) await zlecWyslanePoPrzyjezdzie(db, ev)
  const [sch, arrivals] = await Promise.all([db.carrierPickup.findUnique({ where: { organizationId_carrier: { organizationId: organizationIdOf(db), carrier: input.carrier } } }), arrivalsFor(db, now)])
  return {
    arrival: { carrier: ev.carrier, pickupDay: ev.pickupDay, arrivedAt: ev.arrivedAt, actorName: ev.actorName, wysylka: (await raportyPrzyjazdow(db, [ev.id], now)).get(ev.id) ?? null },
    created: r.count === 1,
    next: nextPickup(sch ? scheduleOf(sch) : null, arrivals, now),
  }
}

/** „DPD odebrał 15:42, kolejne jutro 13:00” (pasek kuriera po kliknięciu). */
export function arrivalText(label: string, arrival: PickupArrivalT, next: NextPickup | null, schedule: PickupScheduleT | null, now: Date): string {
  const hm = `${String(Math.floor(warsawMinute(arrival.arrivedAt) / 60)).padStart(2, '0')}:${String(warsawMinute(arrival.arrivedAt) % 60).padStart(2, '0')}`
  const when = toWarsaw(arrival.arrivedAt).day === toWarsaw(now).day ? hm : dayLabel(toWarsaw(arrival.arrivedAt).day, warsawMinute(arrival.arrivedAt), now)
  const nextText = next && schedule ? `, kolejne ${dayLabel(next.day, schedule.pickupMinute, now)}` : ''
  return `${label} odebrał ${when}${nextText}`
}

// ─── Ustawienia → Przewoźnicy ────────────────────────────────────────────────

/**
 * Harmonogramy przewoźników (brak wiersza = wyłączony, godziny domyślne do formularza). Przewoźnik „na żądanie”
 * (Orlen Paczka) jest na liście tylko u firmy, która go używa: zapisany harmonogram, reguła przewoźnika
 * albo klucz konta (`PICKUP_CARRIERS_NA_ZADANIE`).
 */
export async function pickupSettings(db: Db): Promise<PickupScheduleT[]> {
  assertOrg(db)
  const rows = await schedules(db)
  const naZadanie = Object.entries(PICKUP_CARRIERS_NA_ZADANIE) as [PickupCarrier, { prefiksSekretu: string }][]
  const uzywane = new Set<string>(rows.map((r) => r.carrier))
  if (naZadanie.some(([c]) => !uzywane.has(c))) {
    const [reguly, sekrety] = await Promise.all([
      db.carrierRule.findMany({ where: { carrier: { in: naZadanie.map(([c]) => c) } }, select: { carrier: true }, distinct: ['carrier'] }),
      db.integrationSecret.findMany({ where: { channel: null, OR: naZadanie.map(([, n]) => ({ name: { startsWith: n.prefiksSekretu } })) }, select: { name: true } }),
    ])
    for (const r of reguly) uzywane.add(r.carrier)
    for (const [c, n] of naZadanie) if (sekrety.some((s) => s.name.startsWith(n.prefiksSekretu))) uzywane.add(c)
  }
  return PICKUP_CARRIERS.filter((carrier) => !(carrier in PICKUP_CARRIERS_NA_ZADANIE) || uzywane.has(carrier)).map(
    (carrier) => rows.find((r) => r.carrier === carrier) ?? { carrier, weekdays: [1, 2, 3, 4, 5], pickupMinute: 14 * 60, promiseUntilMinute: 13 * 60, active: false, example: false },
  )
}

/** Zapis harmonogramu przewoźnika (po zapisie wartość nie jest już przykładowa); zmiana w AuditLog. */
export async function saveCarrierPickup(db: Db, s: PickupScheduleT, actorId: string): Promise<void> {
  assertOrg(db)
  if (!isPickupCarrier(s.carrier)) throw new Error(`Nieznany przewoźnik: ${s.carrier}`)
  const clean: PickupScheduleT = { ...s, weekdays: [...new Set(s.weekdays)].sort((a, b) => a - b), example: false }
  validateSchedule(clean)
  const organizationId = organizationIdOf(db)
  await db.$transaction(async (tx) => {
    const before = await tx.carrierPickup.findUnique({ where: { organizationId_carrier: { organizationId, carrier: s.carrier } } })
    const data = { weekdays: clean.weekdays, pickupMinute: clean.pickupMinute, promiseUntilMinute: clean.promiseUntilMinute, active: clean.active, example: false }
    const after = await tx.carrierPickup.upsert({ where: { organizationId_carrier: { organizationId, carrier: s.carrier } }, create: { carrier: s.carrier, ...data }, update: data })
    await tx.auditLog.create({
      data: { entity: 'CarrierPickup', entityId: s.carrier, actorId, before: before ? (scheduleOf(before) as unknown as Prisma.InputJsonValue) : undefined, after: scheduleOf(after) as unknown as Prisma.InputJsonValue },
    })
  })
}

// ─── Strefa produktu ─────────────────────────────────────────────────────────

export interface ProductZoneInfo extends ZoneOfProduct {
  manual: string | null
  /** Strefa, którą dałaby sama reguła firmy (podpowiedź przy ręcznym ustawieniu). */
  byRule: string | null
  /** strefy firmy do wyboru */
  zones: ZoneDefT[]
}

export async function productZoneInfo(db: Db, productId: string): Promise<ProductZoneInfo | null> {
  assertOrg(db)
  if (!/^[a-z0-9]{1,40}$/i.test(productId)) return null
  const [p, rules, zones] = await Promise.all([db.product.findUnique({ where: { id: productId }, select: { title: true, sku: true, packingZone: true } }), zoneRules(db), zoneDefs(db)])
  if (!p) return null
  return { ...productZone(p, rules), manual: p.packingZone, byRule: productZone({ ...p, packingZone: null }, rules).zone, zones }
}

/** Ręczna strefa produktu (null = wróć do reguły firmy); zmiana w AuditLog. Cudzy produkt = false (RLS). */
export async function setProductZone(db: Db, productId: string, zone: string | null, actorId: string): Promise<boolean> {
  assertOrg(db)
  if (!/^[a-z0-9]{1,40}$/i.test(productId)) return false
  return db.$transaction(async (tx) => {
    // strefa z listy stref firmy (RLS: tylko własne)
    if (zone !== null && !(await tx.packingZoneDef.findUnique({ where: { organizationId_key: { organizationId: organizationIdOf(db), key: zone } } }))) throw new Error(`Nieznana strefa: ${zone}`)
    const before = await tx.product.findUnique({ where: { id: productId }, select: { packingZone: true } })
    if (!before) return false
    if (before.packingZone === zone) return true
    await tx.product.update({ where: { id: productId }, data: { packingZone: zone } })
    await tx.auditLog.create({ data: { entity: 'Product.packingZone', entityId: productId, actorId, before: { packingZone: before.packingZone }, after: { packingZone: zone } } })
    return true
  })
}

// ─── Lista wysyłkowa ─────────────────────────────────────────────────────────

/** Id zamówień z parametru `z` (lista po przecinku): poprawne, bez powtórzeń, najwyżej SHIPPING_LIST_LIMIT. */
export function parseOrderIds(v: string | null | undefined): { ids: string[]; tooMany: boolean } {
  const ids = [...new Set((v ?? '').split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9]{1,40}$/i.test(x)))]
  return { ids: ids.slice(0, SHIPPING_LIST_LIMIT), tooMany: ids.length > SHIPPING_LIST_LIMIT }
}

/**
 * Dane listy wysyłkowej dla zaznaczonych zamówień — tylko zamówienia firmy z sesji (RLS: cudze id po prostu nie
 * istnieją). Rdzeń nie trzyma danych odbiorcy ani numerów nadania (etykiety: adaptery przewoźników), więc te pola
 * są puste. Odbiór: najbliższy odbiór przewoźnika, gdy wszystkie zamówienia mają jednego; inaczej chwila wydruku.
 */
export async function shippingListData(db: Db, ids: string[], ctx: { now?: Date; drukujacy: string }): Promise<ListaWysylkowaDane | null> {
  assertOrg(db)
  const now = ctx.now ?? new Date()
  if (!ids.length) return null
  const [accs, orders, sch, arrivals] = await Promise.all([
    accounts(db),
    db.order.findMany({
      where: { id: { in: ids.slice(0, SHIPPING_LIST_LIMIT) } },
      orderBy: [{ createdAtChannel: 'asc' }, { id: 'asc' }],
      select: { id: true, channel: true, channelAccountId: true, externalId: true, carrier: true, blOrderId: true, parentOrderId: true, packageNo: true },
    }),
    schedules(db),
    arrivalsFor(db, now),
  ])
  if (!orders.length) return null
  const numery = await numeryJakNaKarcie(db, orders, accs)
  const carriers = [...new Set(orders.map((o) => (o.carrier && o.carrier !== 'BRAK' ? o.carrier : null)))]
  const one = carriers.length === 1 ? (carriers[0] ?? null) : null
  const pickup = one ? nextPickup(sch.find((s) => s.carrier === one), arrivals, now) : null
  const label = (c: Carrier | null) => (c ? CARRIER_LABEL[c] : CARRIER_LABEL.BRAK)
  return {
    dataOdbioru: pickup?.at ?? now,
    opisOdbioru: pickup ? `${label(one)} — odbiór ${dayLabel(pickup.day, sch.find((s) => s.carrier === one)!.pickupMinute, now)}` : carriers.map(label).join(', '),
    wydrukowano: now,
    drukujacy: ctx.drukujacy,
    // logo firmy (wersja do wydruku); brak albo błąd odczytu = lista bez logo
    logo: (await plikLogo(db, 'druk').catch(() => null))?.bytes ?? null,
    zamowienia: orders.map((o) => ({
      zamowienie: numery.get(o.id)!,
      przewoznik: label(o.carrier && o.carrier !== 'BRAK' ? o.carrier : null),
      liczbaPaczek: 1,
      numeryNadania: [],
      odbiorca: { imie: '', nazwisko: '', miasto: '' },
    })),
  }
}


/**
 * Numer zamówienia na liście wysyłkowej liczony jak kod karty (`numerDoKarty`: id z kanału, gdy liczbowe →
 * numer w kanale z cienia → numer w BaseLinkerze; podzamówienie od zamówienia nadrzędnego z numerem paczki), żeby
 * magazyn sparował kartę z listą także dla Allegro. Gdy numeru liczbowego nie ma — pełny id z kanału
 * (na papierze jednoznaczny, obcięty byłby bezużyteczny).
 */
async function numeryJakNaKarcie(
  db: Db,
  orders: { id: string; channel: Channel; channelAccountId: string; externalId: string; blOrderId: number | null; parentOrderId: string | null; packageNo: number }[],
  accs: Awaited<ReturnType<typeof accounts>>,
): Promise<Map<string, NumerZamowienia>> {
  const parentIds = [...new Set(orders.map((o) => o.parentOrderId).filter((x): x is string => !!x))]
  const parents = parentIds.length
    ? await db.order.findMany({ where: { id: { in: parentIds } }, select: { id: true, channel: true, channelAccountId: true, externalId: true, blOrderId: true } })
    : []
  const src = [...orders, ...parents]
  const snaps = await db.channelOrderSnapshot.findMany({
    where: { OR: src.map((o) => ({ channel: o.channel, channelAccountId: o.channelAccountId, externalId: o.externalId })) },
    select: { channel: true, channelAccountId: true, externalId: true, channelNumber: true, blOrderId: true },
  })
  const key = (c: string, a: string, e: string) => `${c}|${a}|${e}`
  const snap = new Map(snaps.map((s) => [key(s.channel, s.channelAccountId, s.externalId), s]))
  const parentOf = new Map(parents.map((p) => [p.id, p]))
  const out = new Map<string, NumerZamowienia>()
  for (const o of orders) {
    const parent = o.parentOrderId ? parentOf.get(o.parentOrderId) : undefined
    const base = parent ?? o
    const s = snap.get(key(base.channel, base.channelAccountId, base.externalId))
    const name = accountName(accs, o.channel, o.channelAccountId)
    const podzamowienie = parent ? o.packageNo : null
    const numer = numerKartyZamowienia({
      channel: o.channel,
      nazwaKonta: name,
      numerZrodlowy: { externalId: base.externalId, channelNumber: s?.channelNumber, blOrderId: base.blOrderId ?? s?.blOrderId },
      podzamowienie,
    })
    out.set(o.id, numer ?? { przedrostek: channelPrefix(o.channel, name), numer: base.externalId, podzamowienie })
  }
  return out
}

/** Reguły stref firmy do podglądu w ustawieniach (rosnąco po priorytecie). */
export async function zoneRulesList(db: Db): Promise<(ZoneRuleT & { example: boolean })[]> {
  assertOrg(db)
  return (await db.productZoneRule.findMany({ orderBy: { priority: 'asc' } })).map((r) => ({ priority: r.priority, pattern: r.pattern, zone: r.zone, example: r.example }))
}
