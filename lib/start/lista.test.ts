// reguły listy uruchomienia na faktach, bez bazy.
import { describe, expect, it } from 'vitest'
import { komunikatPominiec, komunikatWlaczenia } from './tryb-firmy'
import { type FaktyStartu, parseUstawieniaStartu, zbudujListe } from './lista'

const F: FaktyStartu = {
  firmaZBl: false,
  kluczBl: false,
  trybPracyZablokowany: false,
  firmaDziala: false,
  przeprowadzkaZapisana: false,
  przejscieZakonczone: false,
  brakiDanychFirmy: [],
  zrodloPotwierdzone: true,
  kontaSklepow: [{ nazwa: 'Sklep', kod: 'WOO.sklep', aktywne: false }],
  produkty: 1,
  przewoznikUstawiony: true,
  dokumentyUstawione: true,
  pocztaWlaczona: true,
  zamowienia: 0,
}
const U = { pominiete: [], ukryta: null }
const kanal = (f: Partial<FaktyStartu>) => zbudujListe({ ...F, ...f }, U).kroki.find((k) => k.id === 'kanal')!

describe('krok „Kanał sprzedaży”', () => {
  it('firma bez BL z kontem w podglądzie: do zrobienia, opis każe włączyć tryb pracy', () => {
    const k = kanal({})
    expect(k.stan).toBe('do_zrobienia')
    expect(k.opis).toMatch(/Tylko podgląd: Sklep\. Włącz tryb pracy/)
  })

  it('firma z BL: zrobione, a opis mówi, co jest (bez polecenia „Włącz”); przy blokadzie instancji: administrator', () => {
    const zablokowana = kanal({ firmaZBl: true, trybPracyZablokowany: true })
    expect(zablokowana.stan).toBe('zrobione')
    expect(zablokowana.opis).toMatch(/^Podłączone: Sklep\. Konta zostają w podglądzie/)
    expect(zablokowana.opis).toMatch(/administrator serwera/)
    expect(zablokowana.opis).not.toMatch(/Włącz tryb pracy na koncie/)
    const wolna = kanal({ firmaZBl: true })
    expect(wolna.stan).toBe('zrobione')
    expect(wolna.opis).toMatch(/„Stan kanałów”/)
  })

  it('wszystkie konta aktywne albo brak kont', () => {
    expect(kanal({ kontaSklepow: [{ nazwa: 'Sklep', kod: 'WOO.sklep', aktywne: true }] })).toMatchObject({ stan: 'zrobione', opis: 'Podłączone: Sklep.' })
    expect(kanal({ kontaSklepow: [] })).toMatchObject({ stan: 'do_zrobienia', akcja: 'Dodaj sklep' })
  })
})

describe('krok przeprowadzki i widoczność listy', () => {
  it('krok „Przenieś dane z BaseLinkera” dla firmy z BL albo z samym kluczem', () => {
    expect(zbudujListe(F, U).kroki[0]!.id).toBe('dane-firmy')
    expect(zbudujListe({ ...F, kluczBl: true }, U).kroki[0]!.id).toBe('przeprowadzka')
    expect(zbudujListe({ ...F, firmaZBl: true }, U).kroki[0]!.id).toBe('przeprowadzka')
  })

  it('działająca firma: domyślnie schowana; jawny wybór właściciela wygrywa', () => {
    expect(zbudujListe({ ...F, firmaDziala: true }, U).ukryta).toBe(true)
    expect(zbudujListe({ ...F, firmaDziala: true }, { pominiete: [], ukryta: false }).ukryta).toBe(false)
    expect(zbudujListe(F, { pominiete: [], ukryta: true }).ukryta).toBe(true)
    expect(zbudujListe(F, U).ukryta).toBe(false)
  })

  it('ustawienia: brak wyboru = null, wybór zapamiętany', () => {
    expect(parseUstawieniaStartu({})).toEqual({ pominiete: [], ukryta: null })
    expect(parseUstawieniaStartu({ start: { ukryta: false, pominiete: ['poczta', 'zle'] } })).toEqual({ pominiete: ['poczta'], ukryta: false })
  })
})

describe('komunikaty „Włącz tryb pracy”', () => {
  it('krótko przy wielu kontach, pełny powód przy jednym', () => {
    expect(komunikatWlaczenia(['A', 'B'])).toBe('Tryb pracy włączony: A, B.')
    expect(komunikatWlaczenia(['A', 'B', 'C'])).toBe('Tryb pracy włączony: 3 konta.')
    expect(komunikatWlaczenia(['A', 'B', 'C', 'D', 'E'])).toBe('Tryb pracy włączony: 5 kont.')
    expect(komunikatPominiec([{ nazwa: 'A', powod: 'Sprawdź połączenie.' }])).toBe('A: Sprawdź połączenie.')
    expect(komunikatPominiec([{ nazwa: 'A', powod: 'X' }, { nazwa: 'B', powod: 'Y' }])).toMatch(/^Zostaje w podglądzie: 2 konta\. Powody pokazują ekrany kont/)
    expect(komunikatPominiec([{ nazwa: 'A', powod: 'Blokada.' }, { nazwa: 'B', powod: 'Blokada.' }])).toBe('Zostaje w podglądzie: 2 konta. Blokada.')
  })
})

describe('krok „Przełącz sklepy na Kompletora”', () => {
  const krok = (f: Partial<FaktyStartu>) => zbudujListe({ ...F, ...f }, U).kroki.find((k) => k.id === 'przejscie')
  it('firma bez BL: kroku nie ma', () => {
    expect(krok({})).toBeUndefined()
  })
  it('firma z BL przed importem: do zrobienia, opis każe najpierw importować', () => {
    const k = krok({ firmaZBl: true, trybPracyZablokowany: true })!
    expect(k.stan).toBe('do_zrobienia')
    expect(k.opis).toMatch(/Po imporcie z BaseLinkera/)
    // przed importem przycisk prowadzi na przeprowadzkę, nie do „Włącz tryb pracy”, który by odmówił
    expect(k).toMatchObject({ href: '/ustawienia/przeprowadzka', akcja: 'Przeprowadzka' })
    // instancja z włączonym trybem pracy (EKRANY_PRACA): bez blokady zostaje „Włącz tryb pracy”
    expect(krok({ firmaZBl: true, trybPracyZablokowany: false })).toMatchObject({ href: '/pulpit#stan-kanalow', akcja: 'Włącz tryb pracy' })
  })
  it('po imporcie przy blokadzie instancji: odesłanie do „Zakończ przejście”; po znaczniku: „Włącz tryb pracy”', () => {
    const k = krok({ firmaZBl: true, trybPracyZablokowany: true, przeprowadzkaZapisana: true })!
    expect(k).toMatchObject({ stan: 'do_zrobienia', href: '/ustawienia/przeprowadzka#koniec', akcja: 'Zakończ przejście' })
    const po = krok({ firmaZBl: false, przejscieZakonczone: true, przeprowadzkaZapisana: true })!
    expect(po).toMatchObject({ stan: 'do_zrobienia', href: '/pulpit#stan-kanalow', akcja: 'Włącz tryb pracy' })
  })
  it('wszystkie konta w trybie pracy: zrobione; „Kanał sprzedaży” firmy z BL zostaje zrobiony przy podglądzie', () => {
    expect(krok({ przejscieZakonczone: true, przeprowadzkaZapisana: true, kontaSklepow: [{ nazwa: 'Sklep', kod: 'WOO.sklep', aktywne: true }] })!.stan).toBe('zrobione')
    expect(kanal({ firmaZBl: true }).stan).toBe('zrobione')
  })
})

describe('krok „Przepływ pracy”', () => {
  const przeplyw = (f: Partial<FaktyStartu>) => zbudujListe({ ...F, ...f }, U).kroki.find((k) => k.id === 'przeplyw')!
  it('bez reguł: wybór szablonu; same wyłączone (import z BL, szablon w trybie dodania): dalej do zrobienia; jedna włączona: zrobione', () => {
    expect(przeplyw({})).toMatchObject({ stan: 'do_zrobienia', href: '/ustawienia/automaty/szablony', akcja: 'Wybierz szablon' })
    const wylaczone = przeplyw({ automatyczneAkcje: 6, automatyczneAkcjeWlaczone: 0 })
    expect(wylaczone).toMatchObject({ stan: 'do_zrobienia', href: '/ustawienia/automaty', akcja: 'Sprawdź i włącz' })
    expect(wylaczone.opis).toMatch(/wszystkie wyłączone/)
    expect(przeplyw({ automatyczneAkcje: 6, automatyczneAkcjeWlaczone: 1 })).toMatchObject({ stan: 'zrobione', opis: 'Automatyczne akcje: 6 (włączone: 1).' })
  })
})
