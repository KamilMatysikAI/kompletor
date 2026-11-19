// przypisanie rodzaju wydruku do drukarki innego komputera w istniejącym polu `PrintStation.routing`.
import { describe, expect, it } from 'vitest'
import { bladCelu, opisCelu, parsujWartoscPrzypisania, przypisaniaStanowiska, routingDoZapisu, routingStanowiska, wartoscPrzypisania } from './role'

const teraz = new Date('2026-11-04T08:00:00Z')
const drukarki = [{ rola: 'A4', nazwa: 'Drukarka A4', stan: 'DOSTEPNA', zleceniaWKolejce: 0 }]
const cel = { id: 'stbiuro', name: 'Komputer w biurze', disabledAt: null, maToken: true, printers: drukarki, lastReportAt: teraz }

describe('przypisania drukarek', () => {
  it('stary kształt `routing` (same role) działa bez zmian: własne drukarki, brakujące typy domyślnie', () => {
    expect(przypisaniaStanowiska({ karta: 'A4_2', etykieta: 'TERMICZNA_3' })).toEqual({
      karta: { rola: 'A4_2' },
      lista: { rola: 'A4' },
      spis: { rola: 'A4' },
      etykieta: { rola: 'TERMICZNA_3' },
    })
    expect(routingStanowiska({ karta: 'A4_2' })).toEqual({ karta: 'A4_2', lista: 'A4', spis: 'A4', etykieta: 'TERMICZNA_1' })
    expect(przypisaniaStanowiska(null).karta).toEqual({ rola: 'A4' })
  })

  it('wskazanie innego stanowiska; samo siebie = własna drukarka; śmieci = domyślna rola na własnym komputerze', () => {
    const p = przypisaniaStanowiska(
      { karta: { stanowisko: 'stbiuro', rola: 'A4' }, lista: { stanowisko: 'stja', rola: 'A4_2' }, spis: { stanowisko: '../x', rola: 'A4' }, etykieta: { rola: 'ZLA' } },
      'stja',
    )
    expect(p).toEqual({ karta: { stanowisko: 'stbiuro', rola: 'A4' }, lista: { rola: 'A4_2' }, spis: { rola: 'A4' }, etykieta: { rola: 'TERMICZNA_1' } })
    // stary odczyt (same role) nie wybucha na nowym kształcie
    expect(routingStanowiska({ karta: { stanowisko: 'stbiuro', rola: 'A4' } }).karta).toBe('A4')
    expect(routingDoZapisu(p)).toEqual({ karta: { stanowisko: 'stbiuro', rola: 'A4' }, lista: 'A4_2', spis: 'A4', etykieta: 'TERMICZNA_1' })
  })

  it('wartość pola formularza: rola albo <id>:<rola>, w obie strony', () => {
    expect(wartoscPrzypisania({ rola: 'A4' })).toBe('A4')
    expect(wartoscPrzypisania({ rola: 'TERMICZNA_1', stanowisko: 'stbiuro' })).toBe('stbiuro:TERMICZNA_1')
    expect(parsujWartoscPrzypisania('A4')).toEqual({ rola: 'A4' })
    expect(parsujWartoscPrzypisania('stbiuro:TERMICZNA_1')).toEqual({ rola: 'TERMICZNA_1', stanowisko: 'stbiuro' })
    for (const zle of ['stbiuro:', ':A4', 'st-biuro:A4', 'stbiuro:A5', 'X', 42, null]) expect(parsujWartoscPrzypisania(zle), String(zle)).toBeNull()
  })

  it('komputer docelowy: wyłączony, bez tokenu, milczący, bez drukarki albo z innej firmy = komunikat z nazwą komputera i drukarki', () => {
    expect(bladCelu('Pakowanie', 'karta', cel, 'A4', teraz)).toBeNull()
    expect(bladCelu('Pakowanie', 'karta', null, 'A4', teraz)).toMatch(/nie ma w tej firmie/)
    expect(bladCelu('Pakowanie', 'karta', { ...cel, disabledAt: teraz }, 'A4', teraz)).toMatch(/Karty zamówień ze stanowiska „Pakowanie” idą na drukarkę A4 komputera „Komputer w biurze”, a to stanowisko jest wyłączone/)
    expect(bladCelu('Pakowanie', 'lista', { ...cel, maToken: false }, 'A4', teraz)).toMatch(/„Komputer w biurze”.*nie ma tokenu/)
    expect(bladCelu('Pakowanie', 'lista', { ...cel, lastReportAt: null }, 'A4', teraz)).toMatch(/jeszcze się nie zgłosił/)
    expect(bladCelu('Pakowanie', 'lista', cel, 'A4', new Date(teraz.getTime() + 4 * 60_000))).toMatch(/nie odpowiada od 4 min/)
    expect(bladCelu('Pakowanie', 'etykieta', cel, 'TERMICZNA_1', teraz)).toMatch(/Termiczna 1 komputera „Komputer w biurze”, a ten komputer nie zgłasza takiej drukarki/)
    expect(opisCelu('Komputer w biurze', 'A4')).toBe('Komputer w biurze, A4')
  })
})
