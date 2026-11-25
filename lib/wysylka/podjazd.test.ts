// Termin podjazdu kuriera: propozycja z harmonogramu odbiorów firmy i wybór dnia oraz okna dla przewoźnika.
import { describe, expect, it } from 'vitest'
import { fromWarsaw } from '../rdzen/kalendarz'
import type { PickupArrivalT, PickupScheduleT } from '../pakowanie/harmonogram'
import { dzisDzienOdbioru, OKNO_PODJAZDU_MIN, parseOknoPodjazdu, parseTerminyPodjazdu, propozycjaPodjazdu, wybierzPodjazd } from './podjazd'

// pt. 20.11.2026, pon. 23.11.2026
const o = (day: string, hm: string) => fromWarsaw(day, (Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))) * 60_000)
const DPD: PickupScheduleT = { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true }

describe('dziś jeszcze może przyjechać kurier (dzisDzienOdbioru)', () => {
  it('dzień odbioru bez „Przyjechał” = tak, także po godzinie „wyślemy dziś do”; po „Przyjechał” albo w dzień bez odbiorów = nie', () => {
    expect(dzisDzienOdbioru(DPD, [], o('2026-11-23', '09:00'))).toBe(true)
    expect(dzisDzienOdbioru(DPD, [], o('2026-11-23', '15:00'))).toBe(true)
    const a: PickupArrivalT[] = [{ carrier: 'DPD', pickupDay: '2026-11-23', arrivedAt: o('2026-11-23', '10:00'), actorName: 'x' }]
    expect(dzisDzienOdbioru(DPD, a, o('2026-11-23', '10:30'))).toBe(false)
    expect(dzisDzienOdbioru(DPD, [{ ...a[0]!, carrier: 'PACZKOMATY' }], o('2026-11-23', '10:30'))).toBe(true)
    expect(dzisDzienOdbioru(DPD, [], o('2026-11-21', '09:00'))).toBe(false)
    expect(dzisDzienOdbioru({ ...DPD, weekdays: [2, 4] }, [], o('2026-11-23', '09:00'))).toBe(false)
    expect(dzisDzienOdbioru(null, [], o('2026-11-21', '09:00'))).toBe(true)
    expect(dzisDzienOdbioru({ ...DPD, active: false }, [], o('2026-11-21', '09:00'))).toBe(true)
  })
})

describe('propozycja podjazdu z harmonogramu', () => {
  it('przed godziną „wyślemy dziś do”: dziś, okno od godziny odbioru przez 2 godziny', () => {
    const p = propozycjaPodjazdu(DPD, [], o('2026-11-20', '09:30'))
    expect(p).toMatchObject({ odMin: 13 * 60, doMin: 15 * 60 })
    expect(p!.dni.slice(0, 3)).toEqual(['2026-11-20', '2026-11-23', '2026-11-24'])
    expect(OKNO_PODJAZDU_MIN).toBe(120)
  })

  it('po godzinie granicznej: następny dzień odbioru z harmonogramu (piątek → poniedziałek)', () => {
    expect(propozycjaPodjazdu(DPD, [], o('2026-11-20', '12:00'))!.dni[0]).toBe('2026-11-23')
    expect(propozycjaPodjazdu(DPD, [], o('2026-11-21', '08:00'))!.dni[0]).toBe('2026-11-23')
  })

  it('„Przyjechał” dziś zamyka dzisiejszy odbiór: podjazd na następny dzień', () => {
    const a: PickupArrivalT[] = [{ carrier: 'DPD', pickupDay: '2026-11-23', arrivedAt: o('2026-11-23', '10:00'), actorName: 'x' }]
    expect(propozycjaPodjazdu(DPD, a, o('2026-11-23', '10:30'))!.dni[0]).toBe('2026-11-24')
    // przyjazd innego przewoźnika niczego nie zamyka
    expect(propozycjaPodjazdu(DPD, [{ ...a[0]!, carrier: 'PACZKOMATY' }], o('2026-11-23', '10:30'))!.dni[0]).toBe('2026-11-23')
  })

  it('święto pomijane; brak albo wyłączony harmonogram = null', () => {
    // 11.11.2026 (śr.) Święto Niepodległości
    expect(propozycjaPodjazdu(DPD, [], o('2026-11-10', '13:00'))!.dni[0]).toBe('2026-11-12')
    expect(propozycjaPodjazdu(null, [], o('2026-11-20', '09:00'))).toBeNull()
    expect(propozycjaPodjazdu({ ...DPD, active: false }, [], o('2026-11-20', '09:00'))).toBeNull()
  })

  it('odbiór późnym wieczorem: okno kończy się najpóźniej 23:45, minuty co kwadrans', () => {
    const p = propozycjaPodjazdu({ ...DPD, pickupMinute: 22 * 60 + 50, promiseUntilMinute: 20 * 60 }, [], o('2026-11-20', '09:00'))
    expect(p).toMatchObject({ odMin: 22 * 60 + 45, doMin: 23 * 60 + 45 })
  })
})

describe('okno z ustawienia konta i terminy przewoźnika', () => {
  it('okno „HH:MM-HH:MM”; złe albo odwrócone = null', () => {
    expect(parseOknoPodjazdu('10:00-15:30')).toEqual({ odMin: 600, doMin: 930 })
    expect(parseOknoPodjazdu(' 9:00 - 14:00 ')).toEqual({ odMin: 540, doMin: 840 })
    for (const z of ['', '15:00-10:00', '10:00', 'x', null, 5]) expect(parseOknoPodjazdu(z)).toBeNull()
  })

  it('terminy z odpowiedzi przewoźnika: daty RRRR-MM-DD i godziny domyślne', () => {
    expect(parseTerminyPodjazdu({ success: true, data: { dates: { '2026-11-23': 'pon.', '2026-11-24': 'wt.', zle: 'x' }, start_default_hour: 8, end_default_hour: 16 } })).toEqual({ daty: ['2026-11-23', '2026-11-24'], odGodz: 8, doGodz: 16 })
    expect(parseTerminyPodjazdu({ success: true, data: { dates: [] } })).toBeNull()
    expect(parseTerminyPodjazdu({ success: false })).toBeNull()
  })
})

describe('wybór podjazdu', () => {
  const prop = { dni: ['2026-11-23', '2026-11-24', '2026-11-25'], odMin: 780, doMin: 900 }
  it('okno stałe (DPD): dziś idzie cały przedział bez przycinania; za mało czasu = następny dzień', () => {
    const dni = { ...prop, dni: ['2026-11-23', '2026-11-24'] }
    const stale = { odMin: 9 * 60, doMin: 17 * 60 }
    expect(wybierzPodjazd(dni, stale, null, o('2026-11-23', '09:55'), true).podjazd).toEqual({ data: '2026-11-23', odMin: 540, doMin: 1020 })
    expect(wybierzPodjazd(dni, stale, null, o('2026-11-23', '16:30'), true).podjazd).toEqual({ data: '2026-11-24', odMin: 540, doMin: 1020 })
    expect(wybierzPodjazd({ ...prop, dni: ['2026-11-24'] }, stale, null, o('2026-11-23', '11:53'), true).podjazd).toEqual({ data: '2026-11-24', odMin: 540, doMin: 1020 })
    // bez znacznika zachowanie jak dotąd: początek przycięty do bieżącej godziny
    expect(wybierzPodjazd(dni, stale, null, o('2026-11-23', '09:55')).podjazd).toEqual({ data: '2026-11-23', odMin: 600, doMin: 1020 })
  })

  it('bez terminów przewoźnika: pierwszy dzień z harmonogramu', () => {
    expect(wybierzPodjazd(prop, null, null, o('2026-11-20', '15:00'))).toEqual({ podjazd: { data: '2026-11-23', odMin: 780, doMin: 900 }, uwaga: null })
  })

  it('terminy przewoźnika: pierwszy dzień harmonogramu, który przewoźnik przyjmuje; okno z ustawienia konta wygrywa', () => {
    const api = { daty: ['2026-11-24', '2026-11-25'], odGodz: 8, doGodz: 16 }
    expect(wybierzPodjazd(prop, { odMin: 600, doMin: 840 }, api, o('2026-11-20', '15:00')).podjazd).toEqual({ data: '2026-11-24', odMin: 600, doMin: 840 })
  })

  it('żaden dzień harmonogramu nie pasuje: najbliższy termin przewoźnika po pierwszym dniu harmonogramu, z uwagą', () => {
    const w = wybierzPodjazd({ ...prop, dni: ['2026-11-23'] }, null, { daty: ['2026-11-20', '2026-11-26'], odGodz: 8, doGodz: 16 }, o('2026-11-20', '15:00'))
    expect(w.podjazd).toEqual({ data: '2026-11-26', odMin: 780, doMin: 900 })
    expect(w.uwaga).toMatch(/26\.11/)
  })

  it('bez harmonogramu: terminy i godziny domyślne przewoźnika; dziś tylko, gdy zostało co najmniej godzinę okna', () => {
    const api = { daty: ['2026-11-20', '2026-11-23'], odGodz: 8, doGodz: 16 }
    expect(wybierzPodjazd(null, null, api, o('2026-11-20', '09:10')).podjazd).toEqual({ data: '2026-11-20', odMin: 9 * 60 + 15, doMin: 16 * 60 })
    expect(wybierzPodjazd(null, null, api, o('2026-11-20', '15:10')).podjazd).toEqual({ data: '2026-11-23', odMin: 8 * 60, doMin: 16 * 60 })
  })

  it('nic do wyboru: bez podjazdu z uwagą dla magazynu', () => {
    const w = wybierzPodjazd(null, null, null, o('2026-11-20', '09:00'))
    expect(w.podjazd).toBeNull()
    expect(w.uwaga).toMatch(/harmonogram/)
  })
})
