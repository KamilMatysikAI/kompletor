// czyste części listy zamówień v2 — liczniki panelu statusów i filtry z adresu.
import { describe, expect, it } from 'vitest'
import { filtryZ, ileFiltrow, nazwaWidoku, widokZ, zlozLiczniki } from './zamowienia-lista'

describe('zlozLiczniki', () => {
  it('grupy etapu dostają liczniki per przewoźnik, null liczy się jako „bez przewoźnika”', () => {
    const l = zlozLiczniki(
      [
        { status: 'DO_REALIZACJI', carrier: 'DPD', n: 3 },
        { status: 'DO_REALIZACJI', carrier: 'PACZKOMATY', n: 5 },
        { status: 'DO_REALIZACJI', carrier: null, n: 1 },
        { status: 'ZBIERANIE', carrier: 'DPD', n: 2 },
        { status: 'ZEBRANE', carrier: 'DPD', n: 1 },
        { status: 'WYSLANE', carrier: 'DPD', n: 40 },
        { status: 'ODEBRANE', carrier: 'OSOBISTY', n: 2 },
        { status: 'REKLAMACJA', carrier: 'DPD', n: 1 },
        { status: 'DO_WYJASNIENIA', carrier: null, n: 2 },
      ],
      7,
    )
    expect(l.grupy).toMatchObject({ do_realizacji: 9, zebrane: 3, wyslane: 42, problemowe: 3, wszystkie: 57, wymaga: 7, nowe: 0, anulowane: 0 })
    expect(l.przewoznicy.do_realizacji).toEqual({ DPD: 3, PACZKOMATY: 5, BRAK: 1 })
    expect(l.przewoznicy.zebrane).toEqual({ DPD: 3 })
    expect(l.przewoznicy.wyslane).toBeUndefined() // grupa zakończonych bez podziału na kurierów
  })
})

describe('filtryZ', () => {
  it('śmieci z adresu odrzucone, poprawne wartości przechodzą', () => {
    const f = filtryZ({ widok: 'zebrane', status: 'WYSLANE', przewoznik: 'DPD', platnosc: 'PAID', od: '2026-11-01', do: '2026-11-30', faktura: 'chce_bez', kraj: 'de', q: '  48c7 ' })
    expect(f).toMatchObject({ widok: 'zebrane', status: 'WYSLANE', przewoznik: 'DPD', platnosc: 'PAID', od: '2026-11-01', do: '2026-11-30', faktura: 'chce_bez', kraj: 'DE', q: '48c7' })
    expect(ileFiltrow(f)).toBe(7)
    const z = filtryZ({ widok: 'x', status: 'DROP TABLE', przewoznik: 'UPS', platnosc: 'tak', od: '1.11.2026', faktura: 'zawsze', kraj: 'POL' })
    expect(z).toMatchObject({ widok: 'wszystkie', status: undefined, przewoznik: undefined, platnosc: undefined, od: undefined, faktura: undefined, kraj: undefined })
    expect(ileFiltrow(z)).toBe(0)
  })
  it('stare widoki z pulpitu dalej działają', () => {
    expect(widokZ('do_spakowania')).toBe('do_spakowania')
    expect(nazwaWidoku('nieoplacone')).toBe('Nieopłacone z rezerwacją')
    expect(nazwaWidoku('do_realizacji')).toBe('Do realizacji')
  })
})
