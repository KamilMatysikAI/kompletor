// adres karty z informacją, po czym ją otwarto, i link „Pokaż wyniki” (dane zmyślone).
import { describe, expect, it } from 'vitest'
import { adresOtwarcia, bezSkoku, informacjaOOtwarciu } from './otwarcie'

const z = (adres: string) => {
  const p = new URL(adres, 'http://x.test').searchParams
  return (k: string) => p.get(k)
}

describe('adresOtwarcia i informacjaOOtwarciu', () => {
  it('numer zamówienia: „Otwarte po numerze 45210.”, bez linku do wyników', () => {
    const a = adresOtwarcia('ord-1', { przez: 'numer', trafienie: '45210' })
    expect(a).toBe('/zamowienia/ord-1?po=n.45210')
    expect(informacjaOOtwarciu(z(a))).toEqual({ tekst: 'Otwarte po numerze 45210.', trafienie: '45210', wyniki: null })
  })
  it('numer przesyłki, kod karty, koszyk', () => {
    expect(informacjaOOtwarciu(z(adresOtwarcia('o', { przez: 'przesylka', trafienie: '602000000000000000000017' })))?.tekst).toBe('Otwarte po numerze przesyłki 602000000000000000000017.')
    expect(informacjaOOtwarciu(z(adresOtwarcia('o', { przez: 'karta', trafienie: 'NR48213-2/1' })))?.tekst).toBe('Otwarte po kodzie karty NR48213-2/1.')
    expect(informacjaOOtwarciu(z(adresOtwarcia('o', { przez: 'koszyk', trafienie: 'A' })))?.tekst).toBe('Otwarte po koszyku A.')
  })
  it('z „Szukaj”: link do listy z tą frazą i parametrem bez skoku', () => {
    const a = adresOtwarcia('o', { przez: 'numer', trafienie: '45210' }, '/zamowienia?q=45210&widok=wszystkie')
    expect(informacjaOOtwarciu(z(a))).toEqual({ tekst: 'Otwarte po numerze 45210.', trafienie: '45210', wyniki: '/zamowienia?q=45210&widok=wszystkie&skok=nie' })
    expect(informacjaOOtwarciu(z(adresOtwarcia('o', { przez: 'numer', trafienie: '45210' }, '/zamowienia')))?.wyniki).toBe('/zamowienia?skok=nie')
  })
  it('link tylko do listy zamówień: inne ścieżki i hosty odrzucone', () => {
    for (const zly of ['https://zly.test/zamowienia?q=1', '//zly.test/zamowienia', '/ustawienia?q=1', '/zamowienia/../ustawienia', '/zamowienia?q=1#x', 'javascript:alert(1)']) {
      expect(informacjaOOtwarciu((k) => (k === 'po' ? 'n.45210' : k === 'wyniki' ? zly : null))?.wyniki).toBeNull()
      expect(adresOtwarcia('o', { przez: 'numer', trafienie: '45210' }, zly)).toBe('/zamowienia/o?po=n.45210')
    }
  })
  it('śmieci w parametrze nie dają komunikatu', () => {
    for (const po of ['x.45210', 'n.', 'n.<b>45210</b>', `n.${'1'.repeat(80)}`, 'n.45 210', '45210']) {
      expect(informacjaOOtwarciu((k) => (k === 'po' ? po : null))).toBeNull()
    }
    expect(informacjaOOtwarciu(() => null)).toBeNull()
    expect(adresOtwarcia('o', { przez: 'numer', trafienie: 'a b<c>' })).toBe('/zamowienia/o')
  })
})

describe('bezSkoku', () => {
  it('tylko „skok=nie” w adresie listy wyłącza skok do karty', () => {
    expect(bezSkoku('?skok=nie&widok=wszystkie')).toBe(true)
    expect(bezSkoku('skok=nie')).toBe(true)
    expect(bezSkoku('?widok=wszystkie')).toBe(false)
    expect(bezSkoku('?skok=tak')).toBe(false)
    expect(bezSkoku('')).toBe(false)
  })
})
