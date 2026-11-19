// Reguły firmy na osi statusów przesyłki (czyste funkcje): co robi stan drogi paczki po „Wysłane”.
import { describe, expect, it } from 'vitest'
import { STANY_DROGI } from './stany-przesylki'
import { ALERT_PROBLEM_PRZESYLKI, ALERT_ZWROT_PRZESYLKI, KODY_ZAPOWIEDZI_ZWROTU, skutkiDrogi, trescAlertuDrogi, wszystkieDoreczone } from './reguly-drogi'
import { groupOf } from '../powiadomienia/grupy'
import { zdarzeniaZDziennika } from '../automaty/silnik'
import { opisZdarzenia } from '../karta/historia'

const WSZYSTKO = { odebrane: true, powiadomienia: true, przewoznikObjety: true, praca: true }

describe('skutkiDrogi', () => {
  it('doręczona: „Odebrane” i zamknięcie alertu problemu, tylko z włączonym przełącznikiem', () => {
    expect(skutkiDrogi('DORECZONA', WSZYSTKO)).toEqual({ odebrane: true, alert: null, zamknijProblem: true })
    expect(skutkiDrogi('DORECZONA', { ...WSZYSTKO, odebrane: false })).toEqual({ odebrane: false, alert: null, zamknijProblem: true })
  })

  it('zwrot i problem: alert, nigdy zmiana statusu zamówienia', () => {
    expect(skutkiDrogi('ZWROT', WSZYSTKO)).toEqual({ odebrane: false, alert: 'ZWROT', zamknijProblem: false })
    expect(skutkiDrogi('PROBLEM', WSZYSTKO)).toEqual({ odebrane: false, alert: 'PROBLEM', zamknijProblem: false })
    expect(skutkiDrogi('ZWROT', { ...WSZYSTKO, powiadomienia: false }).alert).toBeNull()
  })

  it('podgląd albo przewoźnik spoza listy: nic (oś i historia zostają)', () => {
    for (const stan of STANY_DROGI) {
      expect(skutkiDrogi(stan, { ...WSZYSTKO, praca: false })).toEqual({ odebrane: false, alert: null, zamknijProblem: false })
      expect(skutkiDrogi(stan, { ...WSZYSTKO, przewoznikObjety: false })).toEqual({ odebrane: false, alert: null, zamknijProblem: false })
    }
  })

  it('pozostałe stany (w drodze, w punkcie, nieudane doręczenie…) nic nie robią', () => {
    for (const stan of STANY_DROGI.filter((s) => !['DORECZONA', 'ZWROT', 'PROBLEM'].includes(s))) expect(skutkiDrogi(stan, WSZYSTKO)).toEqual({ odebrane: false, alert: null, zamknijProblem: false })
  })
})

describe('wszystkieDoreczone', () => {
  it('każda aktywna przesyłka zamówienia doręczona; brak przesyłek = nie', () => {
    expect(wszystkieDoreczone([{ trackState: 'DORECZONA' }])).toBe(true)
    expect(wszystkieDoreczone([{ trackState: 'DORECZONA' }, { trackState: 'W_DRODZE' }])).toBe(false)
    expect(wszystkieDoreczone([{ trackState: 'DORECZONA' }, { trackState: null }])).toBe(false)
    expect(wszystkieDoreczone([])).toBe(false)
  })
})

describe('treść alertu', () => {
  it('zwrot z kodu „zapowiedzi” mówi, że paczka może jeszcze zostać odebrana', () => {
    expect(KODY_ZAPOWIEDZI_ZWROTU.has('pickup_time_expired')).toBe(true)
    expect(KODY_ZAPOWIEDZI_ZWROTU.has('rejected_by_receiver')).toBe(true)
    const z = trescAlertuDrogi('ZWROT', { nr: 'SD 1001', numerNadania: 'NR1', kod: 'pickup_time_expired' })
    expect(z).toContain('może jeszcze zostać odebrana')
    expect(z).toContain('SD 1001')
    const pewny = trescAlertuDrogi('ZWROT', { nr: 'SD 1001', numerNadania: 'NR1', kod: 'returned_to_sender' })
    expect(pewny).not.toContain('może jeszcze')
    expect(pewny).toContain('wraca do nadawcy')
    expect(trescAlertuDrogi('PROBLEM', { nr: 'SD 1001', numerNadania: 'NR1', kod: 'ISSUE' })).toContain('problem')
  })

  it('rodzaje alertów w grupach powiadomień', () => {
    expect(groupOf(ALERT_ZWROT_PRZESYLKI)).toBe('MAGAZYN')
    expect(groupOf(ALERT_PROBLEM_PRZESYLKI)).toBe('INNE')
  })
})

describe('zdarzenie zamówienia o stanie przesyłki', () => {
  it('nie uruchamia automatycznych akcji (żadnego zdarzenia reguł)', () => {
    expect(zdarzeniaZDziennika({ kind: 'PRZESYLKA_STAN', actorId: 'system:sledzenie-przesylki', data: { stan: 'DORECZONA' } })).toEqual([])
  })
  it('w historii karty: opis stanu po polsku i kod przewoźnika', () => {
    expect(opisZdarzenia('PRZESYLKA_STAN', { stan: 'DORECZONA', kod: 'delivered' })).toBe('Przesyłka: Doręczona (kod przewoźnika: delivered)')
    expect(opisZdarzenia('PRZESYLKA_STAN', { stan: 'ZWROT', kod: '' })).toBe('Przesyłka: Zwrot do nadawcy')
  })
})
