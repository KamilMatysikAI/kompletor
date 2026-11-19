// Zmiana sposobu wysyłki na karcie zamówienia: czyste reguły (bez bazy) — rodzaj dostawy przewoźnika, pobranie,
// lista usług z reguł firmy, wymagany punkt albo adres, punkt poprzedniego przewoźnika.
import { describe, expect, it } from 'vitest'
import type { PoprawkaDostawy } from '@/lib/klienci/poprawka'
import { obslugujePobranie, opcjeZRegul, rodzajDostawy, sprawdzDaneDlaSposobu } from './zmiana-sposobu'

const ADRES: PoprawkaDostawy = { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'ul. Fikcyjna', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', telefon: '500600700', punkt: null }
const BEZ_ADRESU: PoprawkaDostawy = { ...ADRES, ulica: null, numerDomu: null, kodPocztowy: null, miasto: null }

describe('rodzajDostawy', () => {
  it('paczkomat, salon Empik i Orlen Paczka wymagają punktu; kurierzy adresu; DPD i GLS adres z opcjonalnym punktem', () => {
    expect(rodzajDostawy('PACZKOMATY')).toBe('PUNKT')
    expect(rodzajDostawy('DPD_EMPIK')).toBe('PUNKT')
    expect(rodzajDostawy('ORLEN_PACZKA')).toBe('PUNKT')
    expect(rodzajDostawy('INPOST_KURIER')).toBe('ADRES')
    expect(rodzajDostawy('POCZTA_POLSKA')).toBe('ADRES')
    expect(rodzajDostawy('DPD')).toBe('ADRES_LUB_PUNKT')
    expect(rodzajDostawy('GLS')).toBe('ADRES_LUB_PUNKT')
    expect(rodzajDostawy('OSOBISTY')).toBe('ODBIOR')
    expect(rodzajDostawy('ALLEGRO')).toBe('Z_KANALU')
    expect(rodzajDostawy('BRAK')).toBeNull()
    expect(rodzajDostawy('BEZ_WYSYLKI')).toBeNull()
  })
})

describe('obslugujePobranie', () => {
  it('Orlen Paczka i moduł Poczty Polskiej bez pobrania, reszta z pobraniem', () => {
    expect(obslugujePobranie('ORLEN_PACZKA', 'ORLEN_PACZKA')).toBe(false)
    expect(obslugujePobranie('POCZTA_POLSKA', 'POCZTA_POLSKA')).toBe(false)
    expect(obslugujePobranie('DPD', 'DPD_BEZPOSREDNIO')).toBe(true)
    expect(obslugujePobranie('PACZKOMATY', 'INPOST_SHIPX')).toBe(true)
    expect(obslugujePobranie('ALLEGRO', 'WYSYLAM_Z_ALLEGRO')).toBe(true)
  })
})

describe('opcjeZRegul', () => {
  const REGULY = [
    { priority: 10, channel: 'ALLEGRO' as const, carrier: 'ALLEGRO' as const, shippingModule: 'WYSYLAM_Z_ALLEGRO' as const },
    { priority: 25, channel: null, carrier: 'PACZKOMATY' as const, shippingModule: 'INPOST_SHIPX' as const },
    { priority: 20, channel: null, carrier: 'PACZKOMATY' as const, shippingModule: 'INPOST_SHIPX' as const },
    { priority: 40, channel: null, carrier: 'DPD' as const, shippingModule: 'DPD_BEZPOSREDNIO' as const },
    { priority: 45, channel: 'EMPIK' as const, carrier: 'DPD_EMPIK' as const, shippingModule: 'DPD_BEZPOSREDNIO' as const },
    { priority: 50, channel: null, carrier: 'OSOBISTY' as const, shippingModule: 'BRAK' as const },
    { priority: 60, channel: null, carrier: 'BRAK' as const, shippingModule: 'BRAK' as const },
  ]
  it('zamówienie ze sklepu: bez Allegro, bez reguł innego kanału, bez „BRAK”, bez powtórzeń przewoźnika i modułu, wg priorytetu', () => {
    const o = opcjeZRegul(REGULY, 'WOO')
    expect(o.map((x) => x.klucz)).toEqual(['PACZKOMATY:INPOST_SHIPX', 'DPD:DPD_BEZPOSREDNIO', 'OSOBISTY:BRAK'])
    expect(o[0]).toMatchObject({ carrier: 'PACZKOMATY', shippingModule: 'INPOST_SHIPX', rodzaj: 'PUNKT', pobranie: true })
    expect(o[0]!.etykieta).toMatch(/Paczkomat/i)
  })
  it('zamówienie z Allegro: Wysyłam z Allegro jest na liście', () => {
    expect(opcjeZRegul(REGULY, 'ALLEGRO').map((x) => x.klucz)).toContain('ALLEGRO:WYSYLAM_Z_ALLEGRO')
  })
})

describe('sprawdzDaneDlaSposobu', () => {
  const stary = { carrier: 'PACZKOMATY' as const, punkt: 'POZ08M' }
  it('z paczkomatu na kuriera DPD: wymagany pełny adres, punkt paczkomatu znika', () => {
    expect(sprawdzDaneDlaSposobu('DPD', BEZ_ADRESU, stary)).toEqual({ blad: expect.stringMatching(/adres/i) })
    expect(sprawdzDaneDlaSposobu('DPD', ADRES, stary)).toEqual({ dane: ADRES })
  })
  it('brak formularza przy przewoźniku, który go wymaga: odmowa', () => {
    expect(sprawdzDaneDlaSposobu('DPD', null, stary)).toEqual({ blad: expect.stringMatching(/adres/i) })
  })
  it('punkt poprzedniego przewoźnika nie przechodzi na nowego (paczkomat jako punkt DPD albo salon Empik)', () => {
    expect(sprawdzDaneDlaSposobu('DPD', { ...ADRES, punkt: 'POZ08M' }, stary)).toEqual({ blad: expect.stringMatching(/poprzedniego przewoźnika/) })
    expect(sprawdzDaneDlaSposobu('DPD_EMPIK', { ...ADRES, punkt: 'POZ08M' }, stary)).toEqual({ blad: expect.stringMatching(/poprzedniego przewoźnika/) })
  })
  it('punkt poprzedniego przewoźnika bez względu na wielkość liter', () => {
    expect(sprawdzDaneDlaSposobu('DPD', { ...ADRES, punkt: 'poz08m' }, stary)).toEqual({ blad: expect.stringMatching(/poprzedniego przewoźnika/) })
  })
  it('punkt, który po kodzie nie pasuje do nowego przewoźnika: odmowa także bez punktu sprzed zmiany', () => {
    // formularz otwarty przed wcześniejszą zmianą podsuwa stary kod paczkomatu, a w danych nie ma już punktu
    const bezPunktu = { carrier: 'DPD' as const, punkt: null }
    expect(sprawdzDaneDlaSposobu('DPD', { ...ADRES, punkt: 'WAW93A' }, bezPunktu)).toEqual({ blad: expect.stringMatching(/paczkomat/i) })
    expect(sprawdzDaneDlaSposobu('GLS', { ...ADRES, punkt: 'POZ08M' }, bezPunktu)).toEqual({ blad: expect.stringMatching(/paczkomat/i) })
    expect(sprawdzDaneDlaSposobu('DPD_EMPIK', { ...ADRES, punkt: 'POZ08M' }, bezPunktu)).toEqual({ blad: expect.stringMatching(/paczkomat/i) })
    expect(sprawdzDaneDlaSposobu('ORLEN_PACZKA', { ...ADRES, punkt: 'POZ08M' }, bezPunktu)).toEqual({ blad: expect.stringMatching(/paczkomat/i) })
    expect(sprawdzDaneDlaSposobu('PACZKOMATY', { ...ADRES, punkt: 'WS-116263-C3-01' }, bezPunktu)).toEqual({ blad: expect.stringMatching(/Orlen/) })
    expect(sprawdzDaneDlaSposobu('DPD', { ...ADRES, punkt: 'WS-116263-C3-01' }, bezPunktu)).toEqual({ blad: expect.stringMatching(/Orlen/) })
    // kody, których nie rozpoznajemy jako cudze, przechodzą (format punktu DPD i GLS sprawdza nadanie)
    expect(sprawdzDaneDlaSposobu('DPD', { ...ADRES, punkt: 'PL11033' }, bezPunktu)).toEqual({ dane: { ...ADRES, punkt: 'PL11033' } })
    expect(sprawdzDaneDlaSposobu('ORLEN_PACZKA', { ...BEZ_ADRESU, punkt: 'WS-116263-C3-01' }, bezPunktu)).toEqual({ dane: { ...BEZ_ADRESU, punkt: 'WS-116263-C3-01' } })
  })
  it('kurier pod adres: wpisany punkt nie zostaje (kurier go nie używa)', () => {
    expect(sprawdzDaneDlaSposobu('INPOST_KURIER', { ...ADRES, punkt: 'KRA010' }, { carrier: 'DPD', punkt: null })).toEqual({ dane: ADRES })
  })
  it('z kuriera na paczkomat: wymagany punkt', () => {
    expect(sprawdzDaneDlaSposobu('PACZKOMATY', ADRES, { carrier: 'DPD', punkt: null })).toEqual({ blad: expect.stringMatching(/punkt/i) })
    expect(sprawdzDaneDlaSposobu('PACZKOMATY', { ...BEZ_ADRESU, punkt: 'KRA010' }, { carrier: 'DPD', punkt: null })).toEqual({ dane: { ...BEZ_ADRESU, punkt: 'KRA010' } })
  })
  it('ten sam przewoźnik (inny moduł): punkt zostaje', () => {
    expect(sprawdzDaneDlaSposobu('PACZKOMATY', { ...ADRES, punkt: 'POZ08M' }, stary)).toEqual({ dane: { ...ADRES, punkt: 'POZ08M' } })
  })
  it('odbiór osobisty i Wysyłam z Allegro: bez wymagań, danych odbiorcy nie zmieniamy', () => {
    expect(sprawdzDaneDlaSposobu('OSOBISTY', ADRES, stary)).toEqual({ dane: null })
    expect(sprawdzDaneDlaSposobu('ALLEGRO', null, stary)).toEqual({ dane: null })
  })
})
