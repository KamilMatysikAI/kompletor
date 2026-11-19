// Harmonogram odbiorów przewoźników: najbliższy odbiór, „do odjazdu”, „Przyjechał <przewoźnik>”.
// Czyste funkcje — testy w pakowanie.test.ts. Godziny w minutach od północy w Europe/Warsaw; dni odbioru to dni
// tygodnia z harmonogramu bez polskich świąt (lib/rdzen/kalendarz.ts). Jeden odbiór dziennie na przewoźnika.
import type { Carrier } from '@prisma/client'
import { addDays, fromWarsaw, polishHolidays, toWarsaw, type IsoDay } from '../rdzen/kalendarz'

/** Przewoźnicy, którym magazyn wydaje paczki (bez BRAK). */
export const PICKUP_CARRIERS = ['DPD', 'PACZKOMATY', 'ALLEGRO', 'DPD_EMPIK', 'OSOBISTY', 'INPOST_KURIER', 'ORLEN_PACZKA', 'GLS', 'POCZTA_POLSKA'] as const satisfies readonly Carrier[]
export type PickupCarrier = (typeof PICKUP_CARRIERS)[number]

/**
 * Przewoźnicy „na żądanie”: wiersz odbioru w Ustawienia → Przewoźnicy pokazujemy tylko firmie, która
 * z nich korzysta: ma zapisany harmonogram, regułę przewoźnika albo klucz konta (prefiks nazwy sekretu, także drugie
 * konto z sufiksem). Firma bez Orlenu nie widzi pustego, wyłączonego wiersza.
 */
export const PICKUP_CARRIERS_NA_ZADANIE: Partial<Record<PickupCarrier, { prefiksSekretu: string }>> = {
  ORLEN_PACZKA: { prefiksSekretu: 'ORLEN_' },
  GLS: { prefiksSekretu: 'GLS_' },
  POCZTA_POLSKA: { prefiksSekretu: 'ENADAWCA_' },
}

/** Krótka nazwa na przycisku „Przyjechał …” i w pasku kuriera (InPost = paczkomaty). */
export const CARRIER_SHORT: Record<Carrier, string> = {
  DPD: 'DPD',
  PACZKOMATY: 'InPost',
  ALLEGRO: 'Allegro',
  DPD_EMPIK: 'DPD Empik',
  INPOST_KURIER: 'InPost kurier',
  ORLEN_PACZKA: 'Orlen Paczka',
  GLS: 'GLS',
  POCZTA_POLSKA: 'Poczta Polska',
  OSOBISTY: 'Odbiór osobisty',
  BRAK: 'Bez przewoźnika',
  BEZ_WYSYLKI: 'Bez wysyłki',
}

export interface PickupScheduleT {
  carrier: Carrier
  /** Dni tygodnia ISO: 1 = poniedziałek … 7 = niedziela. */
  weekdays: number[]
  pickupMinute: number
  /** „Wyślemy dziś do”: do tej godziny sklep może obiecywać wysyłkę tego dnia. */
  promiseUntilMinute: number
  active: boolean
  /** Wartości przykładowe z seedu, jeszcze niepotwierdzone przez firmę. */
  example?: boolean
}

export interface PickupArrivalT {
  carrier: Carrier
  /** Dzień odbioru (Warszawa), który zamknęło kliknięcie. */
  pickupDay: IsoDay
  arrivedAt: Date
  actorName: string
  /** raport automatu „Wysłane” po tym przyjeździe (brak = automat wyłączony albo przyjazd sprzed zmiany). */
  wysylka?: { stan: 'CZEKA' | 'W_TOKU' | 'ZROBIONE' | 'WYLACZONE' | 'BLAD'; przeniesiono: number; pominieto: number; pominiete: { nr: string; powod: string }[]; wPodgladzie: number } | null
}

export interface NextPickup {
  day: IsoDay
  at: Date
  promiseUntil: Date
}

const MINUTES_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** „13:00” → 780; zły zapis → null. */
export function parseHm(v: string): number | null {
  const m = MINUTES_RE.exec(v.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** 780 → „13:00”. */
export function formatHm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

export function validateSchedule(s: PickupScheduleT): void {
  for (const [k, v] of [['godzina odbioru', s.pickupMinute], ['„wyślemy dziś do”', s.promiseUntilMinute]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 1439) throw new Error(`Zła ${k}: ${v}`)
  }
  if (s.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new Error('Dni tygodnia tylko 1–7')
  if (new Set(s.weekdays).size !== s.weekdays.length) throw new Error('Powtórzony dzień tygodnia')
  if (s.active && s.weekdays.length === 0) throw new Error('Aktywny odbiór musi mieć co najmniej jeden dzień')
  if (s.promiseUntilMinute > s.pickupMinute) throw new Error('„Wyślemy dziś do” nie może być później niż odbiór')
  if (s.carrier === 'BRAK' || s.carrier === 'BEZ_WYSYLKI') throw new Error('Odbiór „bez przewoźnika” nie istnieje')
}

/** Dzień tygodnia ISO (1 = poniedziałek) dla dnia RRRR-MM-DD. */
export function isoWeekday(day: IsoDay): number {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** Czy przewoźnik odbiera w ten dzień: dzień tygodnia z harmonogramu i nie święto. */
export function isPickupDay(s: PickupScheduleT, day: IsoDay): boolean {
  return s.active && s.weekdays.includes(isoWeekday(day)) && !polishHolidays(Number(day.slice(0, 4))).has(day)
}

/** Ostatnie kliknięcie „Przyjechał” przewoźnika (najpóźniejsze `arrivedAt`). */
export function lastArrival(arrivals: readonly PickupArrivalT[], carrier: Carrier): PickupArrivalT | null {
  let best: PickupArrivalT | null = null
  for (const a of arrivals) if (a.carrier === carrier && (!best || a.arrivedAt > best.arrivedAt)) best = a
  return best
}

/**
 * Najbliższy otwarty odbiór: pierwszy dzień odbioru od dziś, którego nie zamknęło „Przyjechał”. Dzisiejszy odbiór
 * po godzinie zostaje otwarty (kurier się spóźnia) do kliknięcia albo do północy. Brak w 21 dniach → null.
 */
export function nextPickup(s: PickupScheduleT | null | undefined, arrivals: readonly PickupArrivalT[], now: Date): NextPickup | null {
  if (!s || !s.active) return null
  const closed = new Set(arrivals.filter((a) => a.carrier === s.carrier).map((a) => a.pickupDay))
  let day = toWarsaw(now).day
  for (let i = 0; i < 21; i++, day = addDays(day, 1)) {
    if (isPickupDay(s, day) && !closed.has(day)) return { day, at: fromWarsaw(day, s.pickupMinute * 60_000), promiseUntil: fromWarsaw(day, s.promiseUntilMinute * 60_000) }
  }
  return null
}

/**
 * Czy sklep może jeszcze obiecać wysyłkę dziś: dziś jest odbiór, kurier jeszcze nie przyjechał i nie minęła godzina
 * „wyślemy dziś do”. (Komunikat w sklepie to osobne zadanie — tu tylko reguła.)
 */
export function canPromiseToday(s: PickupScheduleT | null | undefined, arrivals: readonly PickupArrivalT[], now: Date): boolean {
  const n = nextPickup(s, arrivals, now)
  return !!n && n.day === toWarsaw(now).day && now < n.promiseUntil
}

/** Minuty do odbioru (ujemne = po czasie), zaokrąglone w dół. */
export function minutesUntil(at: Date, now: Date): number {
  return Math.floor((at.getTime() - now.getTime()) / 60_000)
}

/** „do odjazdu 1:05” / „po czasie 0:12”. */
export function countdownText(minutes: number): string {
  const m = Math.abs(minutes)
  const hm = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  return minutes >= 0 ? `do odjazdu ${hm}` : `po czasie ${hm}`
}

const WEEKDAY_SHORT = ['', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.', 'niedz.']

/** „dziś 13:00”, „jutro 13:00”, „pon. 13:00”, dalej „03.11 13:00”. */
export function dayLabel(day: IsoDay, minute: number, now: Date): string {
  const today = toWarsaw(now).day
  const hm = formatHm(minute)
  if (day === today) return `dziś ${hm}`
  if (day === addDays(today, 1)) return `jutro ${hm}`
  const diff = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
  if (diff > 0 && diff < 7) return `${WEEKDAY_SHORT[isoWeekday(day)]} ${hm}`
  return `${day.slice(8, 10)}.${day.slice(5, 7)} ${hm}`
}

/** Minuty od północy (Warszawa) dla chwili t. */
export function warsawMinute(t: Date): number {
  return Math.floor(toWarsaw(t).msOfDay / 60_000)
}

/** Dni tygodnia do formularza i opisu. */
export const WEEKDAY_LABEL: Record<number, string> = { 1: 'pon.', 2: 'wt.', 3: 'śr.', 4: 'czw.', 5: 'pt.', 6: 'sob.', 7: 'niedz.' }
