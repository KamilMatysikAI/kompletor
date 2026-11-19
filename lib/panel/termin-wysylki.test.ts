import { describe, expect, it } from 'vitest'
import type { PickupArrivalT, PickupScheduleT } from '../pakowanie/harmonogram'
import { fromWarsaw } from '../rdzen/kalendarz'
import { bezTerminuWCieniu, odciecie, planowanyDzien, terminWysylki, warunekPoTerminie, type CienTerminow } from './termin-wysylki'

// 2026-11-09 to poniedziałek; 2026-11-11 (środa) to święto (Narodowe Święto Niepodległości)
const DPD: PickupScheduleT = { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true }
const H = (day: string, hm: string) => fromWarsaw(day, (Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))) * 60_000)
const zam = (zlozone: Date, o: Partial<{ status: 'NOWE' | 'DO_REALIZACJI' | 'WYSLANE'; paymentState: 'PAID' | 'UNPAID' | 'COD'; carrier: 'DPD' | 'PACZKOMATY' | null }> = {}) => ({
  status: o.status ?? 'DO_REALIZACJI',
  paymentState: o.paymentState ?? 'PAID',
  carrier: o.carrier === undefined ? ('DPD' as const) : o.carrier,
  createdAtChannel: zlozone,
})
const przyjazd = (day: string): PickupArrivalT => ({ carrier: 'DPD', pickupDay: day, arrivedAt: H(day, '13:10'), actorName: 'Magazyn' })

describe('termin wysyłki (R9)', () => {
  it('planowany dzień: przed „wyślemy dziś do” = ten dzień, po = następny dzień odbioru (z pominięciem weekendu i święta)', () => {
    expect(planowanyDzien(DPD, H('2026-11-09', '11:59'))).toBe('2026-11-09')
    expect(planowanyDzien(DPD, H('2026-11-09', '12:00'))).toBe('2026-11-10')
    expect(planowanyDzien(DPD, H('2026-11-10', '15:00'))).toBe('2026-11-12') // 11.11 święto
    expect(planowanyDzien(DPD, H('2026-11-07', '10:00'))).toBe('2026-11-09') // sobota → poniedziałek
  })

  it('dziś / jutro / później / po terminie wg godzin odbioru', () => {
    const now = H('2026-11-09', '09:00')
    expect(terminWysylki(zam(H('2026-11-09', '08:00')), [DPD], [], now)).toMatchObject({ rodzaj: 'dzis', tekst: 'wysyłka: dziś' })
    expect(terminWysylki(zam(H('2026-11-09', '12:30')), [DPD], [], now)).toMatchObject({ rodzaj: 'jutro', tekst: 'wysyłka: jutro' })
    expect(terminWysylki(zam(H('2026-11-06', '12:30')), [DPD], [], now)).toMatchObject({ rodzaj: 'dzis' }) // pt. po 12:00 → pon.
    expect(terminWysylki(zam(H('2026-11-06', '10:00')), [DPD], [], now)).toMatchObject({ rodzaj: 'po_terminie', tekst: 'po terminie (od 06.11)' })
    expect(terminWysylki(zam(H('2026-11-10', '13:00')), [DPD], [], H('2026-11-10', '13:30'))).toMatchObject({ rodzaj: 'pozniej', tekst: 'wysyłka: czw. 12.11' })
  })

  it('kurier już dziś przyjechał: dzisiejsze niewysłane są po terminie', () => {
    const now = H('2026-11-09', '14:00')
    expect(terminWysylki(zam(H('2026-11-09', '08:00')), [DPD], [przyjazd('2026-11-09')], now)?.rodzaj).toBe('po_terminie')
    expect(terminWysylki(zam(H('2026-11-09', '08:00')), [DPD], [], now)?.rodzaj).toBe('dzis')
  })

  it('bez terminu: wysłane, nieopłacone, bez przewoźnika albo bez harmonogramu', () => {
    const now = H('2026-11-09', '09:00')
    const z = H('2026-11-09', '08:00')
    expect(terminWysylki(zam(z, { status: 'WYSLANE' }), [DPD], [], now)).toBeNull()
    expect(terminWysylki(zam(z, { paymentState: 'UNPAID' }), [DPD], [], now)).toBeNull()
    expect(terminWysylki(zam(z, { paymentState: 'COD' }), [DPD], [], now)?.rodzaj).toBe('dzis')
    expect(terminWysylki(zam(z, { carrier: null }), [DPD], [], now)).toBeNull()
    expect(terminWysylki(zam(z, { carrier: 'PACZKOMATY' }), [DPD], [], now)).toBeNull()
    expect(terminWysylki(zam(z), [{ ...DPD, active: false }], [], now)).toBeNull()
  })

  it('odcięcie widoku „Po terminie” daje ten sam zbiór co termin wiersza', () => {
    for (const [now, arrivals] of [
      [H('2026-11-09', '09:00'), []],
      [H('2026-11-09', '14:00'), [przyjazd('2026-11-09')]],
      [H('2026-11-12', '08:00'), []],
    ] as [Date, PickupArrivalT[]][]) {
      const c = odciecie(DPD, arrivals, now)!
      for (let h = 0; h < 24 * 8; h += 1) {
        const z = new Date(now.getTime() - h * 3_600_000 - 17 * 60_000)
        const poTerminie = terminWysylki(zam(z), [DPD], arrivals, now)?.rodzaj === 'po_terminie'
        expect(z < c, `${z.toISOString()} przy ${now.toISOString()}`).toBe(poTerminie)
      }
    }
  })

  it('warunek widoku: bez harmonogramu nic, z harmonogramem OR po przewoźniku', () => {
    expect(warunekPoTerminie([], [], new Date())).toEqual({ id: '__brak__' })
    const w = warunekPoTerminie([DPD], [], H('2026-11-09', '09:00'))
    expect(w.OR).toEqual([{ carrier: 'DPD', createdAtChannel: { lt: H('2026-11-06', '12:00') } }])
  })
})

describe('konto w trybie „Tylko podgląd”', () => {
  // SD w podglądzie: BL ma zamówienie 501 przed wysyłką, 502 już wysłał; Allegro w pracy
  const cien: CienTerminow = { konta: [{ channel: 'WOO', channelAccountId: 'sd' }], otwarteWBl: [501] }
  const stare = H('2026-11-02', '09:00')
  const teraz = H('2026-11-09', '09:00')
  const sd = (blOrderId: number | null) => ({ ...zam(stare), channel: 'WOO' as const, channelAccountId: 'sd', blOrderId })

  it('po terminie tylko, gdy BL nadal ma zamówienie przed wysyłką', () => {
    expect(terminWysylki(sd(501), [DPD], [], teraz, cien)?.rodzaj).toBe('po_terminie')
    expect(terminWysylki(sd(502), [DPD], [], teraz, cien)).toBeNull()
    expect(terminWysylki(sd(null), [DPD], [], teraz, cien)).toBeNull()
  })
  it('konto w pracy liczy jak dotąd; bez danych o podglądzie też', () => {
    const allegro = { ...zam(stare), channel: 'ALLEGRO' as const, channelAccountId: 'a1', blOrderId: null }
    expect(terminWysylki(allegro, [DPD], [], teraz, cien)?.rodzaj).toBe('po_terminie')
    expect(terminWysylki(sd(502), [DPD], [], teraz)?.rodzaj).toBe('po_terminie')
    expect(bezTerminuWCieniu({ channel: 'WOO', channelAccountId: 'inne', blOrderId: null }, cien)).toBe(false)
  })
  it('warunek widoku: konta w podglądzie tylko z otwartymi w BL', () => {
    const w = warunekPoTerminie([DPD], [], teraz, cien)
    expect(w.AND).toEqual([warunekPoTerminie([DPD], [], teraz), { OR: [{ NOT: { OR: [{ channel: 'WOO', channelAccountId: 'sd' }] } }, { blOrderId: { in: [501] } }] }])
    expect(warunekPoTerminie([DPD], [], teraz, { konta: [], otwarteWBl: [] })).toEqual(warunekPoTerminie([DPD], [], teraz))
  })
})
