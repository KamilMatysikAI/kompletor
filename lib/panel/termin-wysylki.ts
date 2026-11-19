// (R9 z przeglądu TwojOMS 08.11): termin wysyłki zamówienia na liście („wysyłka: dziś / jutro / po
// terminie”) i warunek widoku „Po terminie”. Czysty moduł (bez bazy): harmonogram odbiorów przewoźnika /
// (`CarrierPickup`: dni tygodnia, godzina odbioru, „wyślemy dziś do”) i kliknięcia „Przyjechał” z dzisiaj.
//
// Reguła: zamówienie złożone przed godziną „wyślemy dziś do” w dniu odbioru przewoźnika jedzie tego dnia; złożone później
// (albo w dzień bez odbioru, w święto) jedzie najbliższym kolejnym odbiorem. Zamówienie, którego planowany dzień minął,
// albo którego dzisiejszy odbiór już się odbył („Przyjechał”), jest po terminie. Termin mają tylko zamówienia przed
// wysyłką, opłacone albo za pobraniem (nieopłacone czekają na wpłatę: na liście „zwolni towar …”), i tylko przewoźnik
// z aktywnym harmonogramem; bez harmonogramu terminu nie zgadujemy (firma ustawia go w Ustawienia → Przewoźnicy).
//
// konto w trybie „Tylko podgląd” (`statusMode = CIEN`): nasz status nie idzie dalej niż „Do realizacji”
// (pakuje i wysyła BaseLinker albo sklep), więc sam nie mówi, czy paczka pojechała. Zamówienie takiego konta ma termin
// tylko wtedy, gdy kopia zamówienia z BL (`BlOrderSnapshot`) nadal jest przed wysyłką (`CienTerminow.otwarteWBl`);
// bez kopii BL terminu nie liczymy (nie wiemy). Wcześniej każde zamówienie podglądu starsze niż ostatni odbiór było
// „po terminie” (na stagingu 09.11: 172 z 257 zamówień).
import type { Carrier, Channel, OrderStatus, PaymentState, Prisma } from '@prisma/client'
import { isPickupDay, isoWeekday, type PickupArrivalT, type PickupScheduleT } from '../pakowanie/harmonogram'
import { addDays, fromWarsaw, toWarsaw, type IsoDay } from '../rdzen/kalendarz'

/** Statusy „przed wysyłką”: paczka jeszcze nie pojechała z kurierem. */
export const STATUSY_PRZED_WYSYLKA: readonly OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU']
const BEZ_TERMINU_PLATNOSCI: readonly PaymentState[] = ['UNPAID', 'PARTIAL']

/** Ile dni szukamy dnia odbioru (jak `nextPickup`). */
const OKNO_DNI = 21

/** konta w trybie „Tylko podgląd” i zamówienia BL nadal przed wysyłką (numery BL). */
export interface CienTerminow {
  konta: readonly { channel: Channel; channelAccountId: string }[]
  otwarteWBl: readonly number[]
  /** firma ma kopię zamówień BL dla tych kont (zdanie nad widokiem mówi o BaseLinkerze tylko wtedy) */
  zBl?: boolean
}

const wCieniu = (c: CienTerminow | undefined, o: { channel: Channel; channelAccountId: string }) => !!c?.konta.some((k) => k.channel === o.channel && k.channelAccountId === o.channelAccountId)

/** Zamówienie konta w podglądzie, którego BL nie ma już przed wysyłką (albo bez kopii BL): bez terminu. */
export function bezTerminuWCieniu(o: { channel: Channel; channelAccountId: string; blOrderId: number | null }, c?: CienTerminow): boolean {
  return wCieniu(c, o) && (o.blOrderId === null || !c!.otwarteWBl.includes(o.blOrderId))
}

export type RodzajTerminu = 'dzis' | 'jutro' | 'pozniej' | 'po_terminie'

export interface TerminWysylki {
  rodzaj: RodzajTerminu
  /** planowany dzień odbioru (Warszawa) */
  dzien: IsoDay
  /** „wysyłka: dziś”, „wysyłka: jutro”, „wysyłka: pon. 10.11”, „po terminie (od 06.11)” */
  tekst: string
}

const DZIEN_TYG = ['', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.', 'niedz.']
const krotko = (d: IsoDay) => `${d.slice(8, 10)}.${d.slice(5, 7)}`

/** Czy zamówienie w ogóle ma termin wysyłki (status przed wysyłką, opłacone albo pobranie). */
export function czekaNaWysylke(o: { status: OrderStatus; paymentState: PaymentState }): boolean {
  return STATUSY_PRZED_WYSYLKA.includes(o.status) && !BEZ_TERMINU_PLATNOSCI.includes(o.paymentState)
}

/** Planowany dzień odbioru: pierwszy dzień odbioru od dnia złożenia, w którym zamówienie zdążyło przed „wyślemy dziś do”. */
export function planowanyDzien(s: PickupScheduleT, zlozone: Date): IsoDay | null {
  if (!s.active) return null
  let day = toWarsaw(zlozone).day
  for (let i = 0; i < OKNO_DNI; i++, day = addDays(day, 1)) {
    if (!isPickupDay(s, day)) continue
    if (i > 0 || zlozone < fromWarsaw(day, s.promiseUntilMinute * 60_000)) return day
  }
  return null
}

const zamkniety = (arrivals: readonly PickupArrivalT[], carrier: Carrier, day: IsoDay) => arrivals.some((a) => a.carrier === carrier && a.pickupDay === day)

/** Termin wysyłki do wiersza listy; null = bez terminu (wysłane, nieopłacone, przewoźnik bez harmonogramu). */
export function terminWysylki(
  o: { status: OrderStatus; paymentState: PaymentState; carrier: Carrier | null; createdAtChannel: Date; channel?: Channel; channelAccountId?: string; blOrderId?: number | null },
  harmonogramy: readonly PickupScheduleT[],
  arrivals: readonly PickupArrivalT[],
  now: Date,
  cien?: CienTerminow,
): TerminWysylki | null {
  if (!o.carrier || !czekaNaWysylke(o)) return null
  if (cien && o.channel && o.channelAccountId !== undefined && bezTerminuWCieniu({ channel: o.channel, channelAccountId: o.channelAccountId, blOrderId: o.blOrderId ?? null }, cien)) return null
  const s = harmonogramy.find((h) => h.carrier === o.carrier && h.active)
  if (!s) return null
  const dzien = planowanyDzien(s, o.createdAtChannel)
  if (!dzien) return null
  const dzis = toWarsaw(now).day
  if (dzien < dzis || (dzien === dzis && zamkniety(arrivals, o.carrier, dzis))) return { rodzaj: 'po_terminie', dzien, tekst: `po terminie (od ${krotko(dzien)})` }
  if (dzien === dzis) return { rodzaj: 'dzis', dzien, tekst: 'wysyłka: dziś' }
  if (dzien === addDays(dzis, 1)) return { rodzaj: 'jutro', dzien, tekst: 'wysyłka: jutro' }
  return { rodzaj: 'pozniej', dzien, tekst: `wysyłka: ${DZIEN_TYG[isoWeekday(dzien)]} ${krotko(dzien)}` }
}

/**
 * Odcięcie przewoźnika: zamówienia złożone przed tą chwilą (i czekające na wysyłkę) są po terminie. To „wyślemy dziś do”
 * ostatniego dnia odbioru przed dziś, albo dzisiejszego, gdy kurier już dziś przyjechał. Planowany dzień rośnie razem
 * z chwilą złożenia, więc jedno porównanie daje ten sam zbiór co `terminWysylki(...).rodzaj === 'po_terminie'`.
 */
export function odciecie(s: PickupScheduleT, arrivals: readonly PickupArrivalT[], now: Date): Date | null {
  if (!s.active) return null
  const dzis = toWarsaw(now).day
  let day = zamkniety(arrivals, s.carrier, dzis) ? dzis : addDays(dzis, -1)
  for (let i = 0; i < OKNO_DNI; i++, day = addDays(day, -1)) {
    if (isPickupDay(s, day)) return fromWarsaw(day, s.promiseUntilMinute * 60_000)
  }
  return null
}

/** Warunek widoku „Po terminie” (jedno zapytanie: OR po przewoźnikach z harmonogramem). */
export function warunekPoTerminie(harmonogramy: readonly PickupScheduleT[], arrivals: readonly PickupArrivalT[], now: Date, cien?: CienTerminow): Prisma.OrderWhereInput {
  const lub = harmonogramy.flatMap((s): Prisma.OrderWhereInput[] => {
    const c = odciecie(s, arrivals, now)
    return c ? [{ carrier: s.carrier, createdAtChannel: { lt: c } }] : []
  })
  if (!lub.length) return { id: '__brak__' }
  const w: Prisma.OrderWhereInput = { status: { in: [...STATUSY_PRZED_WYSYLKA] }, paymentState: { notIn: [...BEZ_TERMINU_PLATNOSCI] }, OR: lub }
  if (!cien?.konta.length) return w
  // konta w podglądzie tylko z zamówieniami, które BL ma jeszcze przed wysyłką
  const konta = cien.konta.map((k) => ({ channel: k.channel, channelAccountId: k.channelAccountId }))
  return { AND: [w, { OR: [{ NOT: { OR: konta } }, { blOrderId: { in: [...cien.otwarteWBl] } }] }] }
}
