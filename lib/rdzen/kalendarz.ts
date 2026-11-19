// Kalendarz dni roboczych (spec 3.3). Kopia `polishHolidays`/`isBusinessDay` z
// system-najmu/lib/billing/dates.ts (kopia, nie wspólna paczka — zasada „produkty dzielą kod, nie infrastrukturę”).
// Chwile w UTC, logika dni roboczych w strefie Europe/Warsaw. Czyste funkcje — testy w kalendarz.test.ts.

export type IsoDay = string // RRRR-MM-DD

const DAY_MS = 86_400_000
const TZ = 'Europe/Warsaw'

function ms(day: IsoDay): number {
  return Date.parse(`${day}T00:00:00Z`)
}

function fromMs(value: number): IsoDay {
  return new Date(value).toISOString().slice(0, 10)
}

export function addDays(day: IsoDay, days: number): IsoDay {
  return fromMs(ms(day) + days * DAY_MS)
}

/** Niedziela Wielkanocna (algorytm Meeusa/Jonesa/Butchera). */
export function easterSunday(year: number): IsoDay {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const holidayCache = new Map<number, Set<IsoDay>>()

export function polishHolidays(year: number): Set<IsoDay> {
  const cached = holidayCache.get(year)
  if (cached) return cached
  const fixed = ['01-01', '01-06', '05-01', '05-03', '08-15', '11-01', '11-11', '12-25', '12-26']
  if (year >= 2025) fixed.push('12-24') // Wigilia wolna od 2025 r.
  const set = new Set<IsoDay>(fixed.map((md) => `${year}-${md}`))
  const easter = easterSunday(year)
  set.add(easter)
  set.add(addDays(easter, 1)) // Poniedziałek Wielkanocny
  set.add(addDays(easter, 49)) // Zielone Świątki (niedziela)
  set.add(addDays(easter, 60)) // Boże Ciało
  holidayCache.set(year, set)
  return set
}

export function isBusinessDay(day: IsoDay): boolean {
  const dow = new Date(ms(day)).getUTCDay()
  if (dow === 0 || dow === 6) return false
  return !polishHolidays(Number(day.slice(0, 4))).has(day)
}

// ─── Strefa Europe/Warsaw ────────────────────────────────────────────────────

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

interface LocalParts {
  day: IsoDay
  /** milisekundy od lokalnej północy */
  msOfDay: number
}

export function toWarsaw(t: Date): LocalParts {
  const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]))
  const day = `${p.year}-${p.month}-${p.day}`
  const msOfDay = ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 + t.getUTCMilliseconds()
  return { day, msOfDay }
}

/** Chwila UTC odpowiadająca lokalnemu czasowi w Warszawie (dla luki przy zmianie czasu bierze późniejszą chwilę). */
export function fromWarsaw(day: IsoDay, msOfDay: number): Date {
  const naive = ms(day) + msOfDay
  // dwa przybliżenia przesunięcia strefy wystarczają przy zmianie czasu (±1 h)
  let guess = naive - 3600_000
  for (let i = 0; i < 3; i++) {
    const local = toWarsaw(new Date(guess))
    const localNaive = ms(local.day) + local.msOfDay
    const diff = naive - localNaive
    if (diff === 0) return new Date(guess)
    guess += diff
  }
  return new Date(guess)
}

/** Dzień roboczy w Polsce dla chwili t. */
export function isBusinessInstant(t: Date): boolean {
  return isBusinessDay(toWarsaw(t).day)
}

/**
 * `addBusinessDays(t, n)` = ta sama godzina lokalna n-tego kolejnego dnia roboczego; gdy `t` wypada w dzień
 * wolny, liczymy od pierwszego dnia roboczego 00:00 (spec 3.3).
 */
export function addBusinessDays(t: Date, n: number): Date {
  if (n < 0) throw new Error('addBusinessDays: n < 0')
  let { day, msOfDay } = toWarsaw(t)
  if (!isBusinessDay(day)) {
    for (let i = 0; i < 30 && !isBusinessDay(day); i++) day = addDays(day, 1)
    msOfDay = 0
  }
  let left = n
  let guard = 0
  while (left > 0) {
    day = addDays(day, 1)
    if (isBusinessDay(day)) left--
    if (++guard > 400) throw new Error('addBusinessDays: pętla')
  }
  return fromWarsaw(day, msOfDay)
}
