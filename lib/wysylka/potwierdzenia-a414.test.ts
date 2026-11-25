// potwierdzenie ostrzeżenia liczy się tylko przy tym samym tekście co w świeżym liczeniu
// (waga, wymiary, kwota pobrania), gdy panel podaje teksty; automat stanowiska i nadanie masowe podają same kody.
import { describe, expect, it } from 'vitest'
import { potwierdzoneZgodnieZTekstem } from './nadanie'

const WAGA = { kod: 'waga_domyslna', tekst: 'Paczka pójdzie z wagą 1 kg.' }
const COD = { kod: 'pobranie_kilka_paczek', tekst: 'Ta paczka pobiera 120,00 zł.' }

describe('potwierdzoneZgodnieZTekstem', () => {
  it('bez tekstów (automat): kody bez zmian', () => {
    expect(potwierdzoneZgodnieZTekstem([WAGA], ['waga_domyslna', 'wymiary_domyslne'])).toEqual(['waga_domyslna', 'wymiary_domyslne'])
  })

  it('tekst zgodny ze świeżym liczeniem: kod liczy się', () => {
    expect(potwierdzoneZgodnieZTekstem([WAGA, COD], ['waga_domyslna', 'pobranie_kilka_paczek'], { waga_domyslna: WAGA.tekst, pobranie_kilka_paczek: COD.tekst })).toEqual(['waga_domyslna', 'pobranie_kilka_paczek'])
  })

  it('inna liczba w tekście (stary podgląd): kod się nie liczy', () => {
    expect(potwierdzoneZgodnieZTekstem([WAGA, COD], ['waga_domyslna', 'pobranie_kilka_paczek'], { waga_domyslna: 'Paczka pójdzie z wagą 5 kg.', pobranie_kilka_paczek: 'Ta paczka pobiera 99,00 zł.' })).toEqual([])
  })

  it('panel podał teksty, a kod jest bez tekstu: kod się nie liczy (także klucze z prototypu)', () => {
    expect(potwierdzoneZgodnieZTekstem([WAGA], ['waga_domyslna'], {})).toEqual([])
    expect(potwierdzoneZgodnieZTekstem([{ kod: 'toString', tekst: 'x' }], ['toString'], {})).toEqual([])
  })
})
