// Data lokalna sklepu bez strefy („2026-11-03 12:34:56”) na chwilę UTC. Null = nieczytelna, wołający rzuca błąd.
export function localToUtc(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
    return Date.UTC(+p['year']!, +p['month']! - 1, +p['day']!, +p['hour']!, +p['minute']!, +p['second']!) - t
  }
  return new Date(guess - offsetAt(guess - offsetAt(guess)))
}
