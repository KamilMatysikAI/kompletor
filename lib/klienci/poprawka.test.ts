// poprawka adresu zmienia odbiorcę (dostawę), nie nabywcę. Przy prezencie kupuje A,
// odbiera B: nazwisko kupującego zostaje w rekordzie (karta z pełnym adresem, odbiorca bez dostawy). Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { rekordPoPoprawce, zmienionePola, type PoprawkaDostawy } from './poprawka'
import { PUSTY_REKORD, type RekordKlienta } from './rekord'

const PREZENT: RekordKlienta = {
  ...PUSTY_REKORD,
  nabywca: { imieNazwisko: 'Adam Kupujący', firma: null },
  dostawa: { imieNazwisko: 'Beata Odbierająca', firma: null, ulica: 'ul. Atrapowa', numerDomu: '9', numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL' },
  telefon: '+48511222333',
}

const z = (p: Partial<PoprawkaDostawy>): PoprawkaDostawy => ({
  imieNazwisko: 'Beata Odbierająca',
  firma: null,
  ulica: 'ul. Atrapowa',
  numerDomu: '9',
  numerLokalu: null,
  kodPocztowy: '60-002',
  miasto: 'Poznań',
  telefon: '+48511222333',
  punkt: null,
  ...p,
})

describe('poprawka nie nadpisuje nabywcy', () => {
  it('zmiana numeru domu przy prezencie: nabywca zostaje, dostawa poprawiona', () => {
    const r = rekordPoPoprawce(PREZENT, z({ numerDomu: '11' }))
    expect(r.nabywca).toEqual({ imieNazwisko: 'Adam Kupujący', firma: null })
    expect(r.dostawa).toMatchObject({ imieNazwisko: 'Beata Odbierająca', numerDomu: '11' })
  })

  it('zmiana nazwiska odbiorcy: zmienia się dostawa, nie nabywca; pole liczone względem dostawy', () => {
    expect(zmienionePola(PREZENT, z({}))).toEqual([])
    expect(zmienionePola(PREZENT, z({ imieNazwisko: 'Celina Inna' }))).toEqual(['imie_nazwisko'])
    const r = rekordPoPoprawce(PREZENT, z({ imieNazwisko: 'Celina Inna' }))
    expect(r.nabywca?.imieNazwisko).toBe('Adam Kupujący')
    expect(r.dostawa?.imieNazwisko).toBe('Celina Inna')
  })

  it('sam punkt odbioru bez adresu: odbiorca zapisany w dostawie z pustym adresem, nabywca zostaje', () => {
    const r = rekordPoPoprawce(PREZENT, z({ imieNazwisko: 'Celina Inna', ulica: null, numerDomu: null, kodPocztowy: null, miasto: null, punkt: 'POZ08M' }))
    expect(r.nabywca?.imieNazwisko).toBe('Adam Kupujący')
    expect(r.dostawa).toEqual({ imieNazwisko: 'Celina Inna', firma: null, ulica: null, numerDomu: null, numerLokalu: null, kodPocztowy: null, miasto: null, kraj: 'PL' })
    expect(r.punktOdbioru).toEqual({ kod: 'POZ08M', nazwa: null })
  })

  it('rekord bez nabywcy i bez dostawy (zamówienie ręczne): nabywca z poprawki', () => {
    const r = rekordPoPoprawce(PUSTY_REKORD, z({}))
    expect(r.nabywca).toEqual({ imieNazwisko: 'Beata Odbierająca', firma: null })
    // bez dostawy porównanie idzie do nabywcy (odbiorcaZRekordu bierze wtedy nabywcę)
    expect(zmienionePola({ ...PUSTY_REKORD, nabywca: { imieNazwisko: 'Beata Odbierająca', firma: null } }, z({ ulica: null, numerDomu: null, kodPocztowy: null, miasto: null, telefon: null }))).toEqual([])
  })
})
