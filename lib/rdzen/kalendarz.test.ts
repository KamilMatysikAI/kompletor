import { describe, expect, it } from 'vitest'
import { addBusinessDays, easterSunday, isBusinessDay, polishHolidays, toWarsaw } from './kalendarz'

const w = (t: Date) => {
  const p = toWarsaw(t)
  const h = Math.floor(p.msOfDay / 3600_000)
  const m = Math.floor((p.msOfDay % 3600_000) / 60_000)
  return `${p.day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

describe('kalendarz dni roboczych (spec 3.3, przypadki 11–14)', () => {
  it('11: czwartek 10:00, tryb normalny → przypomnienie poniedziałek 10:00, zwolnienie czwartek kolejnego tygodnia 10:00', () => {
    const t = new Date('2026-10-15T08:00:00Z') // czw 10:00 CEST
    expect(w(t)).toBe('2026-10-15 10:00')
    expect(w(addBusinessDays(t, 2))).toBe('2026-10-19 10:00')
    expect(w(addBusinessDays(t, 5))).toBe('2026-10-22 10:00')
  })

  it('12: zamówienie w sobotę → liczenie od poniedziałku 00:00', () => {
    const sob = new Date('2026-10-17T13:00:00Z')
    expect(w(addBusinessDays(sob, 2))).toBe('2026-10-21 00:00')
    expect(addBusinessDays(sob, 2).toISOString()).toBe('2026-10-20T22:00:00.000Z')
    expect(w(addBusinessDays(sob, 0))).toBe('2026-10-19 00:00')
  })

  it('13: wtorek 22.12.2026 → 24, 25, 26.12 wolne (Wigilia wolna od 2025)', () => {
    const t = new Date('2026-12-22T09:00:00Z') // 10:00 CET
    expect(isBusinessDay('2026-12-24')).toBe(false)
    expect(isBusinessDay('2024-12-24')).toBe(true)
    expect(w(addBusinessDays(t, 2))).toBe('2026-12-28 10:00')
    expect(w(addBusinessDays(t, 5))).toBe('2026-12-31 10:00')
    expect(w(addBusinessDays(t, 3))).toBe('2026-12-29 10:00') // tryb sezonowy: 3 dni
  })

  it('14: święta ruchome 2027 (Wielkanoc, Boże Ciało) w kalendarzu', () => {
    expect(easterSunday(2027)).toBe('2027-03-28')
    const h = polishHolidays(2027)
    expect(h.has('2027-03-29')).toBe(true) // Poniedziałek Wielkanocny
    expect(h.has('2027-05-27')).toBe(true) // Boże Ciało
    expect(isBusinessDay('2027-05-27')).toBe(false)
    expect(isBusinessDay('2027-05-28')).toBe(true)
  })

  it('zmiana czasu 25.10.2026: ta sama godzina lokalna po przejściu na czas zimowy', () => {
    const t = new Date('2026-10-23T08:00:00Z') // pt 10:00 CEST
    const r = addBusinessDays(t, 1) // pon 26.10 10:00 CET
    expect(w(r)).toBe('2026-10-26 10:00')
    expect(r.toISOString()).toBe('2026-10-26T09:00:00.000Z')
  })
})
