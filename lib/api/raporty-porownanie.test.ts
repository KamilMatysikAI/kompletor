// wybór okresu porównania raportu sprzedaży (czyste funkcje, bez bazy).
import { describe, expect, it } from 'vitest'
import { ApiInputError } from './odpowiedzi'
import { kluczePorownania, opisZakresu, przesunMiesiace, trybPasuje, zakresPorownania, zapytaniePorownania } from './raporty-porownanie'

describe('przesunMiesiace', () => {
  it('ten sam dzień miesiąca, koniec miesiąca przycięty, ostatni dzień zostaje ostatnim', () => {
    expect(przesunMiesiace('2026-11-25', -12)).toBe('2025-11-25')
    expect(przesunMiesiace('2026-01-15', -1)).toBe('2025-12-15') // przełom roku
    expect(przesunMiesiace('2026-03-31', -1)).toBe('2026-02-28') // luty krótszy: przycięcie
    expect(przesunMiesiace('2028-02-29', -12)).toBe('2027-02-28') // 29.02 w roku przestępnym
    expect(przesunMiesiace('2027-02-28', -12, true)).toBe('2026-02-28')
    expect(przesunMiesiace('2025-02-28', -12, true)).toBe('2024-02-29') // ostatni dzień lutego → ostatni dzień lutego
    expect(przesunMiesiace('2026-04-30', -1, true)).toBe('2026-03-31')
    expect(przesunMiesiace('2026-04-29', -1, true)).toBe('2026-03-29') // nie ostatni dzień: zwykłe przesunięcie
  })
})

describe('zakresPorownania', () => {
  it('poprzedni okres tej samej długości (domyślnie, jak dotąd)', () => {
    expect(zakresPorownania({ od: '2026-10-01', do: '2026-10-31', tryb: 'poprzedni' })).toEqual({ od: '2026-08-31', do: '2026-09-30' })
    expect(zakresPorownania({ od: '2026-01-01', do: '2026-01-07', tryb: 'poprzedni' })).toEqual({ od: '2025-12-25', do: '2025-12-31' })
  })

  it('rok wcześniej: te same daty, luty i 29.02', () => {
    expect(zakresPorownania({ od: '2026-11-01', do: '2026-11-25', tryb: 'rok' })).toEqual({ od: '2025-11-01', do: '2025-11-25' })
    expect(zakresPorownania({ od: '2026-01-01', do: '2026-11-25', tryb: 'rok' })).toEqual({ od: '2025-01-01', do: '2025-11-25' })
    expect(zakresPorownania({ od: '2025-02-01', do: '2025-02-28', tryb: 'rok' })).toEqual({ od: '2024-02-01', do: '2024-02-29' })
    expect(zakresPorownania({ od: '2028-02-01', do: '2028-02-29', tryb: 'rok' })).toEqual({ od: '2027-02-01', do: '2027-02-28' })
    // zakres od środka miesiąca: dzień w dzień (1 dzień nie porównuje się z 2, przegląd r1)
    expect(zakresPorownania({ od: '2025-02-28', do: '2025-02-28', tryb: 'rok' })).toEqual({ od: '2024-02-28', do: '2024-02-28' })
    expect(zakresPorownania({ od: '2025-02-15', do: '2025-02-28', tryb: 'rok' })).toEqual({ od: '2024-02-15', do: '2024-02-28' })
    expect(zakresPorownania({ od: '2028-03-15', do: '2028-03-31', tryb: 'miesiac' })).toEqual({ od: '2028-02-15', do: '2028-02-29' })
    expect(zakresPorownania({ od: '2025-12-15', do: '2026-01-14', tryb: 'rok' })).toEqual({ od: '2024-12-15', do: '2025-01-14' })
  })

  it('poprzedni miesiąc: te same dni, cały miesiąc do całego miesiąca, przełom roku', () => {
    expect(zakresPorownania({ od: '2026-10-01', do: '2026-10-31', tryb: 'miesiac' })).toEqual({ od: '2026-09-01', do: '2026-09-30' })
    expect(zakresPorownania({ od: '2026-11-01', do: '2026-11-25', tryb: 'miesiac' })).toEqual({ od: '2026-10-01', do: '2026-10-25' })
    expect(zakresPorownania({ od: '2026-01-01', do: '2026-01-31', tryb: 'miesiac' })).toEqual({ od: '2025-12-01', do: '2025-12-31' })
    expect(zakresPorownania({ od: '2026-03-01', do: '2026-03-31', tryb: 'miesiac' })).toEqual({ od: '2026-02-01', do: '2026-02-28' })
    expect(zakresPorownania({ od: '2028-03-01', do: '2028-03-31', tryb: 'miesiac' })).toEqual({ od: '2028-02-01', do: '2028-02-29' })
    expect(zakresPorownania({ od: '2026-03-30', do: '2026-03-30', tryb: 'miesiac' })).toEqual({ od: '2026-02-28', do: '2026-02-28' })
    expect(() => zakresPorownania({ od: '2026-10-15', do: '2026-11-14', tryb: 'miesiac' })).toThrow(ApiInputError)
  })

  it('poprzedni tydzień: zakres w jednym tygodniu (pon.–niedz.), też przez Nowy Rok', () => {
    expect(zakresPorownania({ od: '2026-11-23', do: '2026-11-29', tryb: 'tydzien' })).toEqual({ od: '2026-11-16', do: '2026-11-22' })
    expect(zakresPorownania({ od: '2026-11-23', do: '2026-11-25', tryb: 'tydzien' })).toEqual({ od: '2026-11-16', do: '2026-11-18' })
    expect(zakresPorownania({ od: '2026-01-05', do: '2026-01-11', tryb: 'tydzien' })).toEqual({ od: '2025-12-29', do: '2026-01-04' })
    expect(() => zakresPorownania({ od: '2026-11-22', do: '2026-11-23', tryb: 'tydzien' })).toThrow(ApiInputError) // niedziela + poniedziałek
  })

  it('własny zakres: walidacja dat, kolejności i długości; bez porównania = null', () => {
    expect(zakresPorownania({ od: '2026-11-01', do: '2026-11-25', tryb: 'wlasny', wlasnyOd: '2025-11-03', wlasnyDo: '2025-11-30' })).toEqual({ od: '2025-11-03', do: '2025-11-30' })
    expect(() => zakresPorownania({ od: '2026-11-01', do: '2026-11-25', tryb: 'wlasny', wlasnyOd: '2025-11-30', wlasnyDo: '2025-11-01' })).toThrow(/przed/)
    expect(() => zakresPorownania({ od: '2026-11-01', do: '2026-11-25', tryb: 'wlasny', wlasnyOd: '2025-02-30', wlasnyDo: '2025-03-01' })).toThrow(ApiInputError)
    expect(() => zakresPorownania({ od: '2026-11-01', do: '2026-11-25', tryb: 'wlasny', wlasnyOd: null, wlasnyDo: '2025-03-01' })).toThrow(ApiInputError)
    expect(() => zakresPorownania({ od: '2026-11-01', do: '2026-11-25', tryb: 'wlasny', wlasnyOd: '2023-01-01', wlasnyDo: '2025-01-01' })).toThrow(/366/)
    expect(zakresPorownania({ od: '2026-11-01', do: '2026-11-25', tryb: 'brak' })).toBeNull()
  })

  it('trybPasuje: miesiąc i tydzień tylko dla zakresu w jednym miesiącu albo tygodniu', () => {
    expect(trybPasuje('2026-11-01', '2026-11-25', 'miesiac')).toBe(true)
    expect(trybPasuje('2026-01-01', '2026-11-25', 'miesiac')).toBe(false)
    expect(trybPasuje('2026-11-23', '2026-11-29', 'tydzien')).toBe(true)
    expect(trybPasuje('2026-11-01', '2026-11-25', 'tydzien')).toBe(false)
    expect(trybPasuje('2026-01-01', '2026-11-25', 'rok')).toBe(true)
  })
})

describe('zapytaniePorownania (biała lista)', () => {
  it('puste = poprzedni okres; nieznany tryb = błąd z polem', () => {
    expect(zapytaniePorownania({})).toEqual({ porownaj: 'poprzedni', porownajOd: null, porownajDo: null })
    expect(zapytaniePorownania({ porownaj: 'rok', porownajOd: '2025-01-01' })).toEqual({ porownaj: 'rok', porownajOd: null, porownajDo: null })
    expect(zapytaniePorownania({ porownaj: 'wlasny', porownajOd: '2025-01-01', porownajDo: '2025-01-31' })).toEqual({ porownaj: 'wlasny', porownajOd: '2025-01-01', porownajDo: '2025-01-31' })
    try {
      zapytaniePorownania({ porownaj: "rok'; DROP" })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ApiInputError)
      expect((e as ApiInputError).field).toBe('porownaj')
    }
  })
})

describe('kluczePorownania: który okres porównania stoi przy którym wierszu', () => {
  it('rok wcześniej po dniach: ta sama data, 29.02 bez pary', () => {
    const m = kluczePorownania(['2028-02-28', '2028-02-29', '2028-03-01'], ['2027-02-28', '2027-03-01'], 'rok', 'dzien')
    expect(m).toEqual(['2027-02-28', null, '2027-03-01'])
  })
  it('rok wcześniej po miesiącach i inne tryby: kolejno, nadmiarowe wiersze bez pary', () => {
    expect(kluczePorownania(['2026-01-01', '2026-02-01'], ['2025-01-01', '2025-02-01'], 'rok', 'miesiac')).toEqual(['2025-01-01', '2025-02-01'])
    expect(kluczePorownania(['2026-10-01', '2026-10-02', '2026-10-03'], ['2026-09-01', '2026-09-02'], 'miesiac', 'dzien')).toEqual(['2026-09-01', '2026-09-02', null])
  })
})

describe('opisZakresu', () => {
  it('krótko: ten sam miesiąc, różne miesiące, inny rok niż raport', () => {
    expect(opisZakresu('2026-10-01', '2026-10-13', '2026')).toBe('1–13.10')
    expect(opisZakresu('2026-09-28', '2026-10-04', '2026')).toBe('28.09–4.10')
    expect(opisZakresu('2025-11-01', '2025-11-25', '2026')).toBe('1–25.11.2025')
    expect(opisZakresu('2025-12-25', '2026-01-07', '2026')).toBe('25.12.2025–7.01.2026')
    expect(opisZakresu('2026-10-05', '2026-10-05', '2026')).toBe('5.10')
  })
})
