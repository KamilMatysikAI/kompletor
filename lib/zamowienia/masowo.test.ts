// walidacja akcji masowych bez bazy (wykonanie: tests/lista-zamowien-panel-statusow.integration.test.ts).
import { describe, expect, it } from 'vitest'
import { bladParametrow, gabarytDla, idZFormularza, komunikatPrzerwania, MAKS_AKCJI, MAKS_ZAMOWIEN, PROG_TLA } from './masowo'
import { EKSPORT_ZAZNACZONE_MAKS } from './eksport-csv'
import { dataCsv, poleCsv } from './eksport-csv'

describe('akcje masowe: wejście', () => {
  it('identyfikatory: tylko poprawne, bez powtórzeń, z limitem', () => {
    expect(idZFormularza(['abc1', 'abc1', 'x y', 5, '../a', 'B2'])).toEqual({ ids: ['abc1', 'B2'], zaDuzo: false })
    const duzo = Array.from({ length: MAKS_ZAMOWIEN + 5 }, (_, i) => `id${i}`)
    expect(idZFormularza(duzo)).toMatchObject({ zaDuzo: true })
    expect(idZFormularza(duzo).ids).toHaveLength(MAKS_ZAMOWIEN)
  })
  it('parametry: status z powodem, rozmiar A/B/C, stanowisko druku', () => {
    expect(bladParametrow('STATUS', {})).toMatch(/status/)
    expect(bladParametrow('STATUS', { status: 'ANULOWANE', powod: 'x' })).toMatch(/powód/i)
    expect(bladParametrow('STATUS', { status: 'ANULOWANE', powod: 'Klient zrezygnował' })).toBeNull()
    expect(bladParametrow('PRZESYLKI', { gabaryt: 'D' })).toMatch(/gabaryt/)
    expect(bladParametrow('PRZESYLKI', { gabaryt: 'B' })).toBeNull()
    expect(bladParametrow('ETYKIETY', {})).toMatch(/stanowisko/)
  })
  it('rozmiar dobiera gabaryt przewoźnika zamówienia', () => {
    expect(gabarytDla('PACZKOMATY', 'B')).toBe('INPOST_B')
    expect(gabarytDla('ALLEGRO', 'C')).toBe('ALLEGRO_C')
    expect(gabarytDla('DPD', 'B')).toBe('DPD') // jedyny gabaryt
    expect(gabarytDla('PACZKOMATY', null)).toBeNull() // trzy do wyboru: host przesyłek zapyta
  })
})

describe('eksport CSV', () => {
  it('cudzysłowy, separator i formuły arkusza', () => {
    expect(poleCsv('Przyprawa; zielona')).toBe('"Przyprawa; zielona"')
    expect(poleCsv('Kubek "duży"')).toBe('"Kubek ""duży"""')
    expect(poleCsv('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(poleCsv('-12,50')).toBe('-12,50')
    expect(poleCsv(null)).toBe('')
    expect(dataCsv(new Date('2026-11-06T13:05:00Z'))).toBe('2026-11-06 14:05')
  })
})

describe('akcje masowe: progi', () => {
  it('przesyłki i etykiety idą w tle od 10 zamówień i mają limit 200; zmiana statusu od 50 do 1000', () => {
    expect(PROG_TLA).toEqual({ STATUS: 50, PRZESYLKI: 10, ETYKIETY: 10 })
    expect(MAKS_AKCJI).toEqual({ STATUS: 1000, PRZESYLKI: 200, ETYKIETY: 200 })
    expect(MAKS_ZAMOWIEN).toBe(1000)
    // 200 przesyłek po 5 s mieści się w godzinie, po której kolejka uznaje zadanie za porzucone
    expect(MAKS_AKCJI.PRZESYLKI * 5_000).toBeLessThan(60 * 60_000)
  })
  it('komunikat przerwania podaje, ile zamówień ma wynik', () => {
    expect(komunikatPrzerwania(120, 400)).toMatch(/wyniki są dla 120 z 400 zamówień/)
  })
  it('eksport zaznaczonych: najwyżej jedna strona listy (250)', () => {
    expect(EKSPORT_ZAZNACZONE_MAKS).toBe(250)
  })
})
