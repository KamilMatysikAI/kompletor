// Terminy nieopłaconego zamówienia: zwykłe (dni robocze, tryb sezonowy) i termin zwolnienia towaru po nieudanej
// płatności online (godziny zegarowe). Bez bazy.
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, failedOnlineRemindAt, stockReleaseAtFor, termsFor } from './polityka'

const T = new Date('2026-11-14T20:36:00Z') // sobota wieczorem

describe('stockReleaseAtFor', () => {
  it('złożenie + godziny z polityki, także w weekend i w trybie dużego ruchu', () => {
    expect(stockReleaseAtFor(T, DEFAULT_POLICY)).toEqual(new Date('2026-11-14T22:36:00Z'))
    expect(stockReleaseAtFor(T, { ...DEFAULT_POLICY, seasonMode: true, failedOnlinePaymentHoldHours: 5 })).toEqual(new Date('2026-11-15T01:36:00Z'))
  })

  it('0 godzin: w chwili złożenia', () => {
    expect(stockReleaseAtFor(T, { ...DEFAULT_POLICY, failedOnlinePaymentHoldHours: 0 })).toEqual(T)
  })
})

describe('termsFor', () => {
  it('zwykłe terminy w dniach roboczych, ustawienie godzin bez wpływu', () => {
    const zwykle = termsFor(T, DEFAULT_POLICY)
    expect(termsFor(T, { ...DEFAULT_POLICY, failedOnlinePaymentHoldHours: 0 })).toEqual(zwykle)
    expect(zwykle.remindAt.getTime()).toBeGreaterThan(T.getTime())
    expect(zwykle.reservationDeadline.getTime()).toBeGreaterThan(T.getTime() + 3 * 24 * 3_600_000)
  })
})

describe('failedOnlineRemindAt (pytanie o płatność po nieudanej płatności online)', () => {
  const zwykle = termsFor(T, DEFAULT_POLICY)

  it('domyślnie następnego dnia o 9:00 czasu polskiego, także w weekend', () => {
    // sobota 21:36 w Warszawie → niedziela 9:00 (8:00 UTC zimą)
    expect(failedOnlineRemindAt(T, DEFAULT_POLICY, zwykle.remindAt, zwykle.reservationDeadline, T)).toEqual(new Date('2026-11-15T08:00:00Z'))
  })

  it('dzień liczony w czasie polskim: 00:30 w Warszawie to już nowy dzień', () => {
    const t = new Date('2026-11-16T23:30:00Z') // wtorek 00:30 w Warszawie
    const z = termsFor(t, DEFAULT_POLICY)
    expect(failedOnlineRemindAt(t, DEFAULT_POLICY, z.remindAt, z.reservationDeadline, t)).toEqual(new Date('2026-11-18T08:00:00Z'))
  })

  it('N dni z zasad firmy; czas letni (9:00 = 7:00 UTC)', () => {
    const lato = new Date('2026-06-10T10:00:00Z')
    const z = termsFor(lato, DEFAULT_POLICY)
    expect(failedOnlineRemindAt(lato, { ...DEFAULT_POLICY, failedOnlinePaymentReminderDays: 3 }, z.remindAt, z.reservationDeadline, lato)).toEqual(new Date('2026-06-13T07:00:00Z'))
  })

  it('nie przed terminem anulowania = zwykłe przypomnienie', () => {
    const p = { ...DEFAULT_POLICY, normalReleaseBusinessDays: 1, normalReminderBusinessDays: 1, failedOnlinePaymentReminderDays: 7 }
    const z = termsFor(T, p)
    expect(failedOnlineRemindAt(T, p, z.remindAt, z.reservationDeadline, T)).toEqual(z.remindAt)
  })

  it('znacznik po 2 dniach (9:00 minęła): najbliższa 9:00 po teraz, nie od razu', () => {
    // złożone w sobotę wieczorem, znacznik w poniedziałek 14:00 → wtorek 9:00
    const teraz = new Date('2026-11-16T13:00:00Z')
    expect(failedOnlineRemindAt(T, DEFAULT_POLICY, zwykle.remindAt, zwykle.reservationDeadline, teraz)).toEqual(new Date('2026-11-17T08:00:00Z'))
    // to samo, gdy znacznik przychodzi przed 9:00 → ten sam dzień 9:00
    const rano = new Date('2026-11-16T06:30:00Z')
    expect(failedOnlineRemindAt(T, DEFAULT_POLICY, zwykle.remindAt, zwykle.reservationDeadline, rano)).toEqual(new Date('2026-11-16T08:00:00Z'))
  })

  it('przeliczenie wieczorem starego zamówienia: następnego ranka o 9:00, nie w ciągu minut', () => {
    const stare = new Date('2026-11-10T10:00:00Z') // wtorek
    const z = termsFor(stare, DEFAULT_POLICY)
    const wieczorem = new Date('2026-11-12T22:40:00Z') // czwartek 23:40 w Warszawie
    const at = failedOnlineRemindAt(stare, DEFAULT_POLICY, z.remindAt, z.reservationDeadline, wieczorem)
    expect(at).toEqual(new Date('2026-11-13T08:00:00Z'))
    expect(at.getTime()).toBeLessThan(z.reservationDeadline.getTime())
  })

  it('zmiana czasu: 9:00 czasu polskiego w dniu zmiany na zimowy i na letni', () => {
    // 24.10 (sobota) wieczorem → niedziela 25.10, w nocy zmiana na czas zimowy: 9:00 = 8:00 UTC
    const przedZimowym = new Date('2026-10-24T19:00:00Z')
    const zz = termsFor(przedZimowym, DEFAULT_POLICY)
    expect(failedOnlineRemindAt(przedZimowym, DEFAULT_POLICY, zz.remindAt, zz.reservationDeadline, przedZimowym)).toEqual(new Date('2026-10-25T08:00:00Z'))
    // znacznik w nocy zmiany na letni (29.03, 1:30 UTC = 2:30/3:30 lokalnie) → tego dnia 9:00 = 7:00 UTC
    const nocLetni = new Date('2026-03-29T01:30:00Z')
    const zl = termsFor(new Date('2026-03-27T10:00:00Z'), DEFAULT_POLICY)
    expect(failedOnlineRemindAt(new Date('2026-03-27T10:00:00Z'), DEFAULT_POLICY, zl.remindAt, zl.reservationDeadline, nocLetni)).toEqual(new Date('2026-03-29T07:00:00Z'))
  })

  it('9:00 równa terminowi anulowania = zwykłe przypomnienie', () => {
    const z = termsFor(T, DEFAULT_POLICY)
    const at = new Date('2026-11-15T08:00:00Z')
    expect(failedOnlineRemindAt(T, DEFAULT_POLICY, z.remindAt, at, T)).toEqual(z.remindAt)
  })

  it('najbliższe rano po terminie anulowania i zwykłe przypomnienie już minione: bez przypomnienia (termin anulowania)', () => {
    const stare = new Date('2026-11-10T10:00:00Z')
    const zwykleMinione = new Date('2026-11-11T10:00:00Z')
    const anulowanie = new Date('2026-11-13T05:00:00Z') // piątek 6:00, przed 9:00
    const wieczorem = new Date('2026-11-12T21:00:00Z')
    expect(failedOnlineRemindAt(stare, DEFAULT_POLICY, zwykleMinione, anulowanie, wieczorem)).toEqual(anulowanie)
    // zwykłe przypomnienie jeszcze przed nami: zostaje
    const zwyklePrzed = new Date('2026-11-12T22:00:00Z')
    expect(failedOnlineRemindAt(stare, DEFAULT_POLICY, zwyklePrzed, anulowanie, wieczorem)).toEqual(zwyklePrzed)
  })
})
