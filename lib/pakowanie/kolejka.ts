// Kolejka pakowania: zamówienia przed wysyłką pogrupowane po przewoźniku, od najbliższego odbioru
// („od rana najpierw DPD, potem InPost”). Po „Przyjechał <przewoźnik>” zamówienia spakowane przed kliknięciem
// pojechały z kurierem (znikają z kolejki), a spakowane później liczą się do następnego odbioru.
// Czyste funkcje — testy w pakowanie.test.ts; dane z bazy składa lib/pakowanie/dane.ts.
import type { Carrier, OrderStatus } from '@prisma/client'
import { CARRIER_SHORT, lastArrival, minutesUntil, nextPickup, type NextPickup, type PickupArrivalT, type PickupScheduleT } from './harmonogram'
import type { OrderZone } from './strefy'

/** Statusy „do spakowania” (przed wysyłką). */
export const QUEUE_STATUSES = ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE'] as const satisfies readonly OrderStatus[]

export interface QueueOrder {
  id: string
  carrier: Carrier | null
  status: OrderStatus
  /** Ostatnie spakowanie (zdarzenie SPAKOWANE); null = jeszcze nie spakowane. */
  packedAt: Date | null
  createdAtChannel: Date
  zone: OrderZone
}

export interface QueueGroup<O extends QueueOrder = QueueOrder> {
  /** Przewoźnik grupy; null = zamówienia bez przewoźnika (BRAK albo puste). */
  carrier: Carrier | null
  label: string
  schedule: PickupScheduleT | null
  pickup: NextPickup | null
  /** Minuty do najbliższego odbioru (ujemne = kurier się spóźnia); null bez harmonogramu. */
  minutesLeft: number | null
  /** Ostatnie „Przyjechał” tego przewoźnika (do komunikatu „DPD odebrał 15:42, kolejne jutro 13:00”). */
  lastArrival: PickupArrivalT | null
  orders: O[]
  /** Do spakowania przed odjazdem (bez spakowanych). */
  toPack: number
  packed: number
  /** Spakowane przed ostatnim „Przyjechał” — pojechały z kurierem, poza listą. */
  handedOver: number
}

/** Czy zamówienie pojechało z kurierem: spakowane nie później niż ostatnie „Przyjechał” jego przewoźnika. */
export function handedOver(o: Pick<QueueOrder, 'status' | 'packedAt'>, arrival: PickupArrivalT | null): boolean {
  return o.status === 'SPAKOWANE' && !!arrival && !!o.packedAt && o.packedAt <= arrival.arrivedAt
}

function groupCarrier(c: Carrier | null): Carrier | null {
  return c && c !== 'BRAK' ? c : null
}

/**
 * Grupy przewoźników: najpierw te z najbliższym odbiorem (rosnąco po godzinie), potem przewoźnicy bez harmonogramu
 * (po nazwie), na końcu „bez przewoźnika”. Przewoźnik z harmonogramem pojawia się nawet bez zamówień (żeby dało się
 * kliknąć „Przyjechał”). W grupie: niespakowane od najstarszego, spakowane na końcu.
 */
export function buildQueue<O extends QueueOrder>(orders: readonly O[], schedules: readonly PickupScheduleT[], arrivals: readonly PickupArrivalT[], now: Date): QueueGroup<O>[] {
  const keys = new Set<Carrier | null>(schedules.filter((s) => s.active).map((s) => s.carrier))
  for (const o of orders) keys.add(groupCarrier(o.carrier))
  const groups: QueueGroup<O>[] = [...keys].map((carrier) => {
    const schedule = carrier ? (schedules.find((s) => s.carrier === carrier) ?? null) : null
    const pickup = nextPickup(schedule, arrivals, now)
    const arrival = carrier ? lastArrival(arrivals, carrier) : null
    const mine = orders.filter((o) => groupCarrier(o.carrier) === carrier)
    const visible = mine.filter((o) => !handedOver(o, arrival))
    visible.sort((a, b) => Number(a.status === 'SPAKOWANE') - Number(b.status === 'SPAKOWANE') || a.createdAtChannel.getTime() - b.createdAtChannel.getTime() || a.id.localeCompare(b.id))
    const packed = visible.filter((o) => o.status === 'SPAKOWANE').length
    return {
      carrier,
      label: carrier ? CARRIER_SHORT[carrier] : CARRIER_SHORT.BRAK,
      schedule,
      pickup,
      minutesLeft: pickup ? minutesUntil(pickup.at, now) : null,
      lastArrival: arrival,
      orders: visible,
      toPack: visible.length - packed,
      packed,
      handedOver: mine.length - visible.length,
    }
  })
  return groups.sort((a, b) => {
    if (!a.carrier !== !b.carrier) return a.carrier ? -1 : 1
    if (!a.pickup !== !b.pickup) return a.pickup ? -1 : 1
    if (a.pickup && b.pickup && a.pickup.at.getTime() !== b.pickup.at.getTime()) return a.pickup.at.getTime() - b.pickup.at.getTime()
    return a.label.localeCompare(b.label, 'pl')
  })
}

/** Kurier „pilny”: do odjazdu mniej niż godzina (albo po czasie), a są zamówienia do spakowania. */
export function isUrgent(g: Pick<QueueGroup, 'minutesLeft' | 'toPack'>): boolean {
  return g.minutesLeft !== null && g.minutesLeft < 60 && g.toPack > 0
}

/**
 * Strona kolejki: zamówienia w kolejności grup, `size` na stronę. Grupy bez zamówień (przewoźnik z harmonogramem,
 * wszystko odebrane) zostają na pierwszej stronie, żeby pasek kuriera był zawsze widoczny.
 */
export function pageOfQueue<O extends QueueOrder>(groups: readonly QueueGroup<O>[], page: number, size: number): { groups: QueueGroup<O>[]; pages: number; total: number } {
  const total = groups.reduce((s, g) => s + g.orders.length, 0)
  const pages = Math.max(1, Math.ceil(total / size))
  const p = Math.min(Math.max(1, page), pages)
  const from = (p - 1) * size
  const to = from + size
  let i = 0
  const out: QueueGroup<O>[] = []
  for (const g of groups) {
    const start = i
    i += g.orders.length
    if (g.orders.length === 0) {
      if (p === 1) out.push(g)
      continue
    }
    const a = Math.max(from, start)
    const b = Math.min(to, i)
    if (a < b) out.push({ ...g, orders: g.orders.slice(a - start, b - start) })
  }
  return { groups: out, pages, total }
}

type ZakladkaKolejki = 'naprawde' | 'na_sucho' | 'etykiety'
const KOLEJNOSC_ZAKLADEK: readonly ZakladkaKolejki[] = ['naprawde', 'na_sucho', 'etykiety']

/**
 * Zakładki kolejki do pokazania i zakładka do otwarcia. „Pakowanie próbne” (konta w podglądzie) widać tylko wtedy, gdy
 * ma zamówienia; pusta próbna z adresu otwiera „Do spakowania” zamiast pustej strony. Zakładka wraca sama, gdy pojawi
 * się zamówienie z konta w podglądzie.
 */
export function zakladkiKolejki(liczniki: Record<ZakladkaKolejki, number>, zadana: ZakladkaKolejki): { zakladka: ZakladkaKolejki; widoczne: ZakladkaKolejki[] } {
  const probna = liczniki.na_sucho > 0
  return { zakladka: zadana === 'na_sucho' && !probna ? 'naprawde' : zadana, widoczne: KOLEJNOSC_ZAKLADEK.filter((t) => t !== 'na_sucho' || probna) }
}
