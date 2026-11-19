import { describe, expect, it } from 'vitest'
import type { RolaDrukarki, StanDrukarki } from '../src/kontrakt.js'
import type { MapaRol, StanWindows } from '../src/mapowanie.js'
import { mapujStanWindows, nazwaDrukarki, rolaZapasowa, stanyRol } from '../src/mapowanie.js'

const sw = (nazwa: string, status: string, z: Partial<StanWindows> = {}): StanWindows => ({
  nazwa,
  status,
  offline: false,
  zleceniaWKolejce: 0,
  ...z,
})
const MAPA: MapaRol = { A4: 'Brother A4', TERMICZNA_1: 'Termiczna 1', TERMICZNA_2: 'Termiczna 2' }

describe('mapowanie ról na drukarki Windows', () => {
  it('nazwa z konfiguracji, puste = brak', () => {
    expect(nazwaDrukarki(MAPA, 'TERMICZNA_1')).toBe('Termiczna 1')
    expect(nazwaDrukarki({ A4: '  ' }, 'A4')).toBeUndefined()
    expect(nazwaDrukarki({}, 'TERMICZNA_2')).toBeUndefined()
  })

  it('stan Windows → stan dla serwera (nazwy i liczby PrinterStatus)', () => {
    expect(mapujStanWindows(sw('x', 'Normal'))).toEqual({ stan: 'DOSTEPNA' })
    expect(mapujStanWindows(sw('x', '0'))).toEqual({ stan: 'DOSTEPNA' })
    expect(mapujStanWindows(sw('x', 'Printing'))).toEqual({ stan: 'DOSTEPNA' })
    expect(mapujStanWindows(sw('x', 'TonerLow'))).toEqual({ stan: 'DOSTEPNA', komunikat: 'kończy się toner' })
    expect(mapujStanWindows(sw('x', 'Offline')).stan).toBe('OFFLINE')
    expect(mapujStanWindows(sw('x', '8')).stan).toBe('OFFLINE')
    expect(mapujStanWindows(sw('x', 'Normal', { offline: true })).stan).toBe('OFFLINE')
    expect(mapujStanWindows(sw('x', 'PaperOut'))).toEqual({ stan: 'BLAD', komunikat: 'brak papieru lub etykiet' })
    expect(mapujStanWindows(sw('x', '23'))).toEqual({ stan: 'BLAD', komunikat: 'otwarta pokrywa' })
    expect(mapujStanWindows(sw('x', 'Paused'))).toEqual({ stan: 'BLAD', komunikat: 'wstrzymana w Windows' })
    // Nieznany stan: drukujemy mimo to (README, sekcja 5), z komunikatem dla człowieka.
    expect(mapujStanWindows(sw('x', 'Cokolwiek'))).toEqual({ stan: 'DOSTEPNA', komunikat: 'nieznany stan drukarki: Cokolwiek — drukujemy mimo to' })
    expect(mapujStanWindows(sw('x', ''))).toMatchObject({ stan: 'DOSTEPNA', komunikat: expect.stringMatching(/brak/) })
  })

  it('nazwy z wyliczenia Get-Printer (PowerShell 5.1) i z tabeli liczbowej dają ten sam stan', () => {
    expect(mapujStanWindows(sw('x', 'UserInterventionRequired'))).toEqual({ stan: 'BLAD', komunikat: 'drukarka czeka na obsługę' })
    expect(mapujStanWindows(sw('x', 'ServerOffline'))).toMatchObject({ stan: 'OFFLINE' })
    expect(mapujStanWindows(sw('x', '26'))).toMatchObject({ stan: 'OFFLINE' })
    expect(mapujStanWindows(sw('x', 'DriverUpdateNeeded'))).toMatchObject({ stan: 'BLAD' })
    expect(mapujStanWindows(sw('x', '21'))).toEqual({ stan: 'BLAD', komunikat: 'drukarka czeka na obsługę' })
    expect(mapujStanWindows(sw('x', 'Initializing'))).toEqual({ stan: 'DOSTEPNA' })
    expect(mapujStanWindows(sw('x', '16'))).toEqual({ stan: 'DOSTEPNA' })
    expect(mapujStanWindows(sw('x', 'Error'))).toEqual({ stan: 'BLAD', komunikat: 'błąd drukarki' })
  })

  it('stany ról: tylko skonfigurowane role, nazwy bez rozróżniania wielkości liter, brakująca drukarka = BLAD', () => {
    const wynik = stanyRol({ A4: 'brother a4', TERMICZNA_1: 'Zebra GK420d' }, [
      sw('Brother A4', 'Normal', { zleceniaWKolejce: 3 }),
      sw('Microsoft Print to PDF', 'Normal'),
    ])
    expect(wynik).toEqual([
      { rola: 'A4', nazwa: 'brother a4', stan: 'DOSTEPNA', zleceniaWKolejce: 3 },
      {
        rola: 'TERMICZNA_1',
        nazwa: 'Zebra GK420d',
        stan: 'BLAD',
        komunikat: 'nie ma w Windows drukarki o nazwie „Zebra GK420d” — sprawdź konfigurację',
        zleceniaWKolejce: null,
      },
    ])
  })
})

describe('rola zapasowa przy awarii termicznej', () => {
  const stany = (s: Partial<Record<RolaDrukarki, StanDrukarki>>) => new Map(Object.entries(s) as [RolaDrukarki, StanDrukarki][])

  it('druga termiczna, gdy działa (albo stan nieznany)', () => {
    expect(rolaZapasowa('TERMICZNA_1', MAPA, stany({ TERMICZNA_1: 'OFFLINE', TERMICZNA_2: 'DOSTEPNA' }))).toBe('TERMICZNA_2')
    expect(rolaZapasowa('TERMICZNA_2', MAPA, stany({}))).toBe('TERMICZNA_1')
  })

  it('A4, gdy druga termiczna też leży albo jej nie ma', () => {
    expect(rolaZapasowa('TERMICZNA_1', MAPA, stany({ TERMICZNA_2: 'BLAD' }))).toBe('A4')
    expect(rolaZapasowa('TERMICZNA_1', { A4: 'a', TERMICZNA_1: 't' }, stany({}))).toBe('A4')
  })

  it('brak zapasu: A4 nie ma roli zapasowej, a bez A4 i drugiej termicznej nie ma dokąd', () => {
    expect(rolaZapasowa('A4', MAPA, stany({}))).toBeUndefined()
    expect(rolaZapasowa('TERMICZNA_1', { TERMICZNA_1: 't' }, stany({}))).toBeUndefined()
  })
})

// dowolna liczba drukarek (rola według wzoru), zgodnie wstecz z trzema rolami 0.1.0
describe('wiele drukarek: 4 termiczne i A4_2', () => {
  const stany = (s: Partial<Record<RolaDrukarki, StanDrukarki>>) => new Map(Object.entries(s) as [RolaDrukarki, StanDrukarki][])
  const DUZA = { A4: 'Brother', A4_2: 'HP biuro', TERMICZNA_1: 'Zebra 1', TERMICZNA_2: 'Zebra 2', TERMICZNA_3: 'Zebra 3', TERMICZNA_4: 'Zebra 4' }

  it('rola zapasowa: kolejna działająca termiczna z konfiguracji, potem od początku, na końcu A4', () => {
    expect(rolaZapasowa('TERMICZNA_1', DUZA, stany({}))).toBe('TERMICZNA_2')
    expect(rolaZapasowa('TERMICZNA_3', DUZA, stany({}))).toBe('TERMICZNA_4')
    expect(rolaZapasowa('TERMICZNA_4', DUZA, stany({}))).toBe('TERMICZNA_1')
    expect(rolaZapasowa('TERMICZNA_2', DUZA, stany({ TERMICZNA_3: 'OFFLINE', TERMICZNA_4: 'BLAD' }))).toBe('TERMICZNA_1')
    expect(rolaZapasowa('TERMICZNA_2', DUZA, stany({ TERMICZNA_1: 'OFFLINE', TERMICZNA_3: 'OFFLINE', TERMICZNA_4: 'BLAD' }))).toBe('A4')
  })

  it('A4_2 to drukarka zwykła: bez zapasu; bez A4 zapasem termicznej jest pierwsza inna zwykła', () => {
    expect(rolaZapasowa('A4_2', DUZA, stany({}))).toBeUndefined()
    expect(rolaZapasowa('TERMICZNA_1', { A4_2: 'HP', TERMICZNA_1: 't' }, stany({}))).toBe('A4_2')
  })

  it('stan wszystkich ról z konfiguracji, w stałej kolejności (A4, A4_2, termiczne po numerze)', () => {
    const windows = Object.values(DUZA).map((nazwa) => ({ nazwa, status: 'Normal', offline: false, zleceniaWKolejce: 0 }))
    const mapa = { TERMICZNA_10: 'Zebra 4', TERMICZNA_2: 'Zebra 2', A4_2: 'HP biuro', A4: 'Brother', TERMICZNA_1: 'Zebra 1' }
    expect(stanyRol(mapa, windows).map((s) => s.rola)).toEqual(['A4', 'A4_2', 'TERMICZNA_1', 'TERMICZNA_2', 'TERMICZNA_10'])
  })
})
