// Termin podjazdu kuriera dla przesyłki: propozycja z harmonogramu odbiorów firmy (Ustawienia → Wysyłka i druk →
// Przewoźnicy: dni tygodnia, godzina odbioru, „wyślemy dziś do”) i wybór dnia oraz okna godzin dla przewoźnika, który
// zamawia podjazd razem z przesyłką (Base Courier). Funkcje czyste poza `propozycjaPodjazduFirmy` (odczyt harmonogramu
// i kliknięć „Przyjechał”). Godziny w minutach od północy w Europe/Warsaw.
//
// Zasady:
//   - dzień: pierwszy dzień odbioru z harmonogramu od dziś (bez świąt), z pominięciem dzisiejszego, gdy minęła godzina
//     „wyślemy dziś do” albo magazyn kliknął już „Przyjechał <przewoźnik>”;
//   - okno: od godziny odbioru (w dół do kwadransa) przez `OKNO_PODJAZDU_MIN`, najpóźniej do 23:45; ustawienie konta
//     „okno podjazdu” (HH:MM-HH:MM) zastępuje godziny, nie dzień;
//   - gdy przewoźnik podał swoje terminy (lista dat), bierzemy pierwszy dzień harmonogramu z tej listy, a gdy żaden nie
//     pasuje: najbliższy termin przewoźnika od pierwszego dnia harmonogramu, z uwagą dla magazynu;
//   - bez harmonogramu: terminy i godziny domyślne przewoźnika; dziś tylko, gdy zostało co najmniej `MIN_OKNO_DZIS_MIN`.
import type { Carrier, PrismaClient } from '@prisma/client'
import type { PropozycjaPodjazdu } from '../adaptery/kontrakt'
import { formatHm, isPickupDay, parseHm, warsawMinute, type PickupArrivalT, type PickupScheduleT } from '../pakowanie/harmonogram'
import { addDays, toWarsaw, type IsoDay } from '../rdzen/kalendarz'

/** Długość okna podjazdu od godziny odbioru z harmonogramu. */
export const OKNO_PODJAZDU_MIN = 120
/** Dzisiejszy podjazd tylko, gdy od teraz do końca okna zostało co najmniej tyle minut. */
export const MIN_OKNO_DZIS_MIN = 60
/** Ile kolejnych dni odbioru podaje propozycja (wybór, gdy przewoźnik nie przyjmuje pierwszego). */
const ILE_DNI = 10
const NAJPOZNIEJ = 23 * 60 + 45

const wDol = (m: number) => Math.floor(m / 15) * 15
const wGore = (m: number) => Math.ceil(m / 15) * 15
const DZIEN_RE = /^\d{4}-\d{2}-\d{2}$/

/** „23.11” z RRRR-MM-DD. */
const krotko = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`

export function propozycjaPodjazdu(s: PickupScheduleT | null | undefined, arrivals: readonly PickupArrivalT[], now: Date): PropozycjaPodjazdu | null {
  if (!s || !s.active) return null
  const dzis = toWarsaw(now).day
  const teraz = warsawMinute(now)
  const zamkniete = new Set(arrivals.filter((a) => a.carrier === s.carrier).map((a) => a.pickupDay))
  const dni: IsoDay[] = []
  let d = dzis
  for (let i = 0; i < 60 && dni.length < ILE_DNI; i++, d = addDays(d, 1)) {
    if (!isPickupDay(s, d) || zamkniete.has(d)) continue
    if (d === dzis && teraz >= s.promiseUntilMinute) continue
    dni.push(d)
  }
  if (!dni.length) return null
  const od = Math.min(wDol(s.pickupMinute), NAJPOZNIEJ - 15)
  return { dni, odMin: od, doMin: Math.min(wGore(s.pickupMinute + OKNO_PODJAZDU_MIN), NAJPOZNIEJ) }
}

/** Ustawienie konta „okno podjazdu”: „10:00-15:00” → minuty; puste, złe albo odwrócone = null. */
export function parseOknoPodjazdu(v: unknown): { odMin: number; doMin: number } | null {
  if (typeof v !== 'string') return null
  const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(v)
  if (!m) return null
  const od = parseHm(m[1]!)
  const dO = parseHm(m[2]!)
  return od !== null && dO !== null && od < dO ? { odMin: od, doMin: dO } : null
}

export interface TerminyPrzewoznika {
  /** Dni, na które przewoźnik przyjmuje podjazd (RRRR-MM-DD, rosnąco). */
  daty: string[]
  odGodz: number | null
  doGodz: number | null
}

const godzina = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : typeof v === 'string' && /^\d{1,2}$/.test(v) && Number(v) <= 23 ? Number(v) : null)

/** Odpowiedź `getPickupDateOptions` (Base Courier): `data.dates` (klucze RRRR-MM-DD), `start_default_hour`, `end_default_hour`. */
export function parseTerminyPodjazdu(json: unknown): TerminyPrzewoznika | null {
  if (!json || typeof json !== 'object' || (json as Record<string, unknown>)['success'] === false) return null
  const data = (json as Record<string, unknown>)['data']
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const dates = d['dates']
  const daty = dates && typeof dates === 'object' && !Array.isArray(dates) ? Object.keys(dates).filter((k) => DZIEN_RE.test(k)).sort() : []
  if (!daty.length) return null
  return { daty, odGodz: godzina(d['start_default_hour']), doGodz: godzina(d['end_default_hour']) }
}

export interface Podjazd {
  data: string
  odMin: number
  doMin: number
}

/**
 * Dzień i okno podjazdu. `okno` = ustawienie konta (zastępuje godziny), `terminy` = lista dni przewoźnika (null = nie
 * pobrano: wtedy pierwszy dzień harmonogramu bez sprawdzania). `podjazd: null` = nie ma z czego wybrać (bez
 * harmonogramu i bez terminów przewoźnika); `uwaga` = tekst dla magazynu, gdy dzień albo okno odbiega od harmonogramu.
 * `oknoStale` = `okno` jest przedziałem z listy przewoźnika (DPD): dziś też idzie w całości, bez przycinania początku
 * do bieżącej godziny, o ile do końca zostało co najmniej `MIN_OKNO_DZIS_MIN`.
 */
export function wybierzPodjazd(prop: PropozycjaPodjazdu | null, okno: { odMin: number; doMin: number } | null, terminy: TerminyPrzewoznika | null, now: Date, oknoStale = false): { podjazd: Podjazd | null; uwaga: string | null } {
  const dzis = toWarsaw(now).day
  const teraz = warsawMinute(now)
  const godzinyApi = terminy && terminy.odGodz !== null && terminy.doGodz !== null && terminy.odGodz < terminy.doGodz ? { odMin: terminy.odGodz * 60, doMin: terminy.doGodz * 60 } : null
  const ramy = okno ?? (prop ? { odMin: prop.odMin, doMin: prop.doMin } : godzinyApi)
  // dzisiejszy dzień: okno od teraz (w górę do kwadransa), o ile zostaje co najmniej MIN_OKNO_DZIS_MIN
  const zDniem = (data: string): Podjazd | null => {
    if (!ramy) return null
    if (data < dzis) return null
    if (data !== dzis) return { data, ...ramy }
    // przewoźnik ze stałymi przedziałami (DPD) odrzuca okno z przesuniętym początkiem, więc idzie całe
    if (oknoStale && okno) return ramy.doMin - teraz >= MIN_OKNO_DZIS_MIN ? { data, ...ramy } : null
    const od = Math.max(ramy.odMin, wGore(teraz))
    return ramy.doMin - od >= MIN_OKNO_DZIS_MIN ? { data, odMin: od, doMin: ramy.doMin } : null
  }
  const pierwszy = (kandydaci: readonly string[]) => {
    for (const k of kandydaci) {
      const p = zDniem(k)
      if (p) return p
    }
    return null
  }
  if (prop && prop.dni.length) {
    if (!terminy) return { podjazd: pierwszy(prop.dni), uwaga: null }
    const zgodne = prop.dni.filter((d) => terminy.daty.includes(d))
    const p = pierwszy(zgodne)
    if (p) return { podjazd: p, uwaga: null }
    const inne = pierwszy(terminy.daty.filter((d) => d >= prop.dni[0]!))
    if (inne) return { podjazd: inne, uwaga: `Przewoźnik nie przyjmuje podjazdu w dniu z harmonogramu firmy (${krotko(prop.dni[0]!)}): podjazd zamówiony na ${krotko(inne.data)}, ${formatHm(inne.odMin)}–${formatHm(inne.doMin)}.` }
    return { podjazd: null, uwaga: `Przewoźnik nie podał terminu podjazdu zgodnego z harmonogramem firmy: przesyłka bez daty podjazdu, sprawdź podjazd w panelu przewoźnika.` }
  }
  if (terminy) {
    const p = pierwszy(terminy.daty)
    if (p) return { podjazd: p, uwaga: null }
  }
  return { podjazd: null, uwaga: 'Brak harmonogramu odbiorów tego przewoźnika (Ustawienia → Wysyłka i druk → Przewoźnicy) i terminów od przewoźnika: przesyłka bez daty podjazdu, sprawdź podjazd w panelu przewoźnika.' }
}

/**
 * Czy dziś może jeszcze przyjechać kurier tego przewoźnika: dziś jest dniem odbioru z harmonogramu i nikt nie kliknął
 * „Przyjechał” na dziś. Bez aktywnego harmonogramu = true (brak wiedzy, decyduje osoba). Minięta godzina „wyślemy dziś
 * do” dnia nie zamyka: podjazd na dziś da się jeszcze zamówić.
 */
export function dzisDzienOdbioru(s: PickupScheduleT | null | undefined, arrivals: readonly PickupArrivalT[], now: Date): boolean {
  if (!s || !s.active) return true
  const dzis = toWarsaw(now).day
  return isPickupDay(s, dzis) && !arrivals.some((a) => a.carrier === s.carrier && a.pickupDay === dzis)
}

/**
 * Propozycja podjazdu dla przewoźnika z danych firmy (harmonogram i kliknięcia „Przyjechał” z ostatnich 2 dni) oraz
 * `dzisOdbior` z `dzisDzienOdbioru`. Błąd odczytu = brak propozycji i `dzisOdbior: false` (okno nie podpowiada dziś).
 */
export async function podjazdFirmy(db: PrismaClient, carrier: Carrier, now: Date): Promise<{ propozycja: PropozycjaPodjazdu | null; dzisOdbior: boolean }> {
  try {
    const r = await db.carrierPickup.findFirst({ where: { carrier } })
    if (!r) return { propozycja: null, dzisOdbior: true }
    const zdarzenia = await db.carrierPickupEvent.findMany({ where: { carrier, arrivedAt: { gte: new Date(now.getTime() - 2 * 86_400_000) } }, select: { carrier: true, pickupDay: true, arrivedAt: true, actorName: true } })
    const s: PickupScheduleT = { carrier: r.carrier, weekdays: [...r.weekdays], pickupMinute: r.pickupMinute, promiseUntilMinute: r.promiseUntilMinute, active: r.active }
    return { propozycja: propozycjaPodjazdu(s, zdarzenia, now), dzisOdbior: dzisDzienOdbioru(s, zdarzenia, now) }
  } catch {
    return { propozycja: null, dzisOdbior: false }
  }
}

/** Sama propozycja z `podjazdFirmy` (błąd odczytu = null: przesyłka powstaje dalej, moduł bierze terminy przewoźnika). */
export async function propozycjaPodjazduFirmy(db: PrismaClient, carrier: Carrier, now: Date): Promise<PropozycjaPodjazdu | null> {
  return (await podjazdFirmy(db, carrier, now)).propozycja
}
