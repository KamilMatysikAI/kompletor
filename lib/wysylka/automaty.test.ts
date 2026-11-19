// przełączniki automatów wysyłki firmy — domyślnie włączone, zła wartość = domyślna, opisy bez żargonu.
import { describe, expect, it } from 'vitest'
import { maZakazaneSlowo } from '@/lib/panel/slownik'
import { DOMYSLNE_AUTOMATY, OPISY_AUTOMATOW, parseAutomatyWysylki, parseRegulyDrogi } from './automaty'
import { regulyDrogiModulu, tekstPodgladu, tekstRaportu } from '../pakowanie/wyslane-po-przyjezdzie'
import { DPD_KEY, DPD_ZAPIS_KEY } from '../adaptery/dpd'
import { INPOST_SHIPX_ZAPIS_KEY } from '../adaptery/inpost-zapis'
import { PP_ZAPIS_MANIFEST } from '../adaptery/pocztapolska'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY } from '../adaptery/allegro-wysylam-zapis'

describe('automaty wysyłki', () => {
  it('brak ustawień = wszystko włączone (firma sprzed zmiany)', () => {
    expect(parseAutomatyWysylki(null)).toEqual(DOMYSLNE_AUTOMATY)
    expect(parseAutomatyWysylki({})).toEqual({ wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, sledzenieDoDoreczenia: false, odebranePoDoreczeniu: false, powiadomieniaODrodze: false, linkSledzeniaDoSklepu: false, dodatkowaPrzesylka: false })
  })
  it('jawne false wyłącza tylko swój przełącznik; zła wartość = domyślna', () => {
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { sledzenie: false } })).toEqual({ wyslanePoPrzyjezdzie: true, sledzenie: false, anulowanieWKanale: true, sledzenieDoDoreczenia: false, odebranePoDoreczeniu: false, powiadomieniaODrodze: false, linkSledzeniaDoSklepu: false, dodatkowaPrzesylka: false })
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { wyslanePoPrzyjezdzie: 'nie', anulowanieWKanale: false } })).toEqual({ wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: false, sledzenieDoDoreczenia: false, odebranePoDoreczeniu: false, powiadomieniaODrodze: false, linkSledzeniaDoSklepu: false, dodatkowaPrzesylka: false })
    expect(parseAutomatyWysylki({ wysylkaAutomaty: [] })).toEqual(DOMYSLNE_AUTOMATY)
  })
  it('reguły na osi statusów (Odebrane, powiadomienia) domyślnie wyłączone, także przy złej wartości', () => {
    expect(DOMYSLNE_AUTOMATY).toMatchObject({ odebranePoDoreczeniu: false, powiadomieniaODrodze: false })
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { odebranePoDoreczeniu: 'tak', powiadomieniaODrodze: 1 } })).toMatchObject({ odebranePoDoreczeniu: false, powiadomieniaODrodze: false })
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { odebranePoDoreczeniu: true, powiadomieniaODrodze: true } })).toMatchObject({ odebranePoDoreczeniu: true, powiadomieniaODrodze: true })
  })
  it('link śledzenia do sklepu domyślnie wyłączony, także przy złej wartości; jawne true włącza', () => {
    expect(DOMYSLNE_AUTOMATY.linkSledzeniaDoSklepu).toBe(false)
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { linkSledzeniaDoSklepu: 'tak' } }).linkSledzeniaDoSklepu).toBe(false)
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { linkSledzeniaDoSklepu: true } }).linkSledzeniaDoSklepu).toBe(true)
  })
  it('kolejna przesyłka do zamówienia domyślnie wyłączona, także przy złej wartości; jawne true włącza', () => {
    expect(DOMYSLNE_AUTOMATY.dodatkowaPrzesylka).toBe(false)
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { dodatkowaPrzesylka: 'tak' } }).dodatkowaPrzesylka).toBe(false)
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { dodatkowaPrzesylka: true } }).dodatkowaPrzesylka).toBe(true)
  })
  it('przewoźnicy objęci regułami: domyślnie InPost, Poczta Polska, Wysyłam z Allegro, reszta (DPD, nowy moduł) poza; wybór firmy wygrywa, złe wpisy pomijane', () => {
    expect(regulyDrogiModulu(INPOST_SHIPX_ZAPIS_KEY)).toBe(true)
    expect(regulyDrogiModulu(DPD_ZAPIS_KEY)).toBe(false)
    expect(regulyDrogiModulu(DPD_KEY)).toBe(false)
    expect(regulyDrogiModulu(PP_ZAPIS_MANIFEST.adapterKey)).toBe(true)
    expect(regulyDrogiModulu(ALLEGRO_WYSYLAM_ZAPIS_KEY)).toBe(true)
    expect(regulyDrogiModulu('nowy-przewoznik.v1')).toBe(false)
    expect(regulyDrogiModulu('nowy-przewoznik.v1', { 'nowy-przewoznik.v1': true })).toBe(true)
    expect(regulyDrogiModulu(DPD_ZAPIS_KEY, { [DPD_ZAPIS_KEY]: true })).toBe(true)
    expect(regulyDrogiModulu(INPOST_SHIPX_ZAPIS_KEY, { [INPOST_SHIPX_ZAPIS_KEY]: false })).toBe(false)
    expect(parseRegulyDrogi({ wysylkaRegulyDrogi: { [DPD_ZAPIS_KEY]: true, 'ZŁY KLUCZ': true, x: 'tak' } })).toEqual({ [DPD_ZAPIS_KEY]: true })
    expect(parseRegulyDrogi(null)).toEqual({})
  })
  it('opisy i teksty raportu bez słów wewnętrznych', () => {
    for (const o of Object.values(OPISY_AUTOMATOW)) {
      expect(maZakazaneSlowo(o.nazwa)).toBeNull()
      expect(maZakazaneSlowo(o.opis)).toBeNull()
    }
    expect(tekstRaportu({ stan: 'ZROBIONE', przeniesiono: 5, pominieto: 2 })).toBe('Do „Wysłane”: 5 · pominięte: 2')
    expect(tekstRaportu({ stan: 'ZROBIONE', przeniesiono: 3, pominieto: 0 })).toBe('Do „Wysłane”: 3')
    expect(tekstRaportu({ stan: 'W_TOKU', przeniesiono: 0, pominieto: 0 })).toMatch(/Przenoszę/)
    // operacja, która się nie skończyła, nie wisi jako „Przenoszę…”
    expect(tekstRaportu({ stan: 'BLAD', przeniesiono: 0, pominieto: 0 })).toMatch(/Nie udało się.*karcie zamówienia/)
    for (const t of [tekstRaportu({ stan: 'BLAD', przeniesiono: 0, pominieto: 0 }), tekstPodgladu(5)!]) expect(maZakazaneSlowo(t)).toBeNull()
  })
  it('jedna linia o sklepach w podglądzie, z odmianą', () => {
    expect(tekstPodgladu(0)).toBeNull()
    expect(tekstPodgladu(1)).toBe('1 zamówienie ze sklepów w trybie podglądu pominięto')
    expect(tekstPodgladu(3)).toBe('3 zamówienia ze sklepów w trybie podglądu pominięto')
    expect(tekstPodgladu(12)).toBe('12 zamówień ze sklepów w trybie podglądu pominięto')
    expect(tekstPodgladu(22)).toBe('22 zamówienia ze sklepów w trybie podglądu pominięto')
    expect(tekstPodgladu(48)).toBe('48 zamówień ze sklepów w trybie podglądu pominięto')
  })
})
