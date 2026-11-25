// blok nadania przesyłki. Ostrzeżenia do potwierdzenia mają być zwykłym krokiem przed pierwszym kliknięciem
// („Sprawdź przed nadaniem” + pole wyboru na ostrzeżenie + „Potwierdzam i tworzę przesyłkę”), a nie odmową po kliknięciu;
// po utworzeniu przesyłki krok znika. Środowisko testów bez DOM: render statyczny stanu początkowego (bez efektów).
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { StanNadania } from '../zamowienia/[id]/akcje-przesylka'

vi.mock('../zamowienia/[id]/akcje-przesylka', () => ({
  anulujPrzesylkeAkcja: vi.fn(),
  pobierzEtykieteAkcja: vi.fn(),
  rozstrzygnijPrzesylkeAkcja: vi.fn(),
  sprawdzPrzesylkeAkcja: vi.fn(),
  stanNadania: vi.fn(),
  utworzPrzesylkeAkcja: vi.fn(),
}))
vi.mock('./druk', () => ({ useStanowiskaDruku: () => null, DrukujNaStanowisku: () => null }))
vi.mock('./podzial-adresu-ai', () => ({ PodzialAdresuAi: () => null }))

const { NadaniePrzesylki, polaczPotwierdzenia, potwierdzeniaDoWyslania, zaznaczeniaPoOdmowie } = await import('./nadanie-przesylki')
const { naPrzeliczeniePrzesylki, ogloszPrzeliczeniePrzesylki } = await import('./przeliczenie-przesylki-zdarzenie')

const WAGA = { kod: 'waga_domyslna', tekst: 'Paczka pójdzie z wagą 1 kg: produkty nie mają wpisanej wagi, a firma nie ustawiła wagi domyślnej.' }
const stan = (o: Partial<StanNadania> = {}): StanNadania => ({
  powod: null,
  nieDotyczy: false,
  gabaryty: [],
  modul: 'DPD',
  przesylka: null,
  moznaPoprawic: false,
  mozeRozstrzygnac: false,
  poprzednia: null,
  podzialAdresu: null,
  doPotwierdzenia: [],
  ...o,
})
const render = (s: StanNadania) => renderToStaticMarkup(h(NadaniePrzesylki, { orderId: 'z1', poczatkowy: s }))

describe('NadaniePrzesylki: krok potwierdzeń', () => {
  it('ostrzeżenia z podglądu widać przed pierwszym kliknięciem: pole wyboru i przycisk „Potwierdzam…” nieaktywny do zaznaczenia', () => {
    const t = render(stan({ doPotwierdzenia: [WAGA] }))
    expect(t).toContain('Sprawdź przed nadaniem')
    expect(t).toMatch(/<input type="checkbox" id="np-potw-z1-waga_domyslna"/)
    expect(t).toContain(WAGA.tekst)
    expect(t).toContain('Potwierdzam i tworzę przesyłkę: DPD')
    expect(t).toMatch(/aria-disabled="true"[^>]*data-powod="Najpierw zaznacz pola w „Sprawdź przed nadaniem”\."/)
    expect(t).not.toContain('role="switch"')
    expect(t).not.toContain('banner red')
  })

  it('bez ostrzeżeń: zwykłe „Utwórz przesyłkę”, aktywne, bez kroku', () => {
    const t = render(stan())
    expect(t).toContain('Utwórz przesyłkę: DPD')
    expect(t).not.toContain('Sprawdź przed nadaniem')
    expect(t).not.toContain('aria-disabled')
  })

  it('nadawanie wyłączone (powód bramki): bez kroku potwierdzeń, przycisk z powodem bramki', () => {
    const t = render(stan({ powod: 'Nadawanie wyłączone.', doPotwierdzenia: [WAGA] }))
    expect(t).not.toContain('Sprawdź przed nadaniem')
    expect(t).toContain('data-powod="Nadawanie wyłączone."')
  })

  it('po utworzeniu przesyłki: stan, numer i akcje, bez kroku potwierdzeń i bez przycisku tworzenia', () => {
    const przesylka = { id: 's1', stan: 'UTWORZONA', przewoznik: 'DPD_EMPIK', gabaryt: null, numer: '0000123456789A', etykieta: true, etykietaBlad: null, blad: null, uwaga: null, moznaAnulowac: false, doSprawdzenia: false, referencja: 'r', rozstrzygniecie: { etykietaNumeru: 'n', wskazowka: 'w' }, utworzono: new Date(), proba: 1, uKuriera: null } as const
    const t = render(stan({ przesylka: przesylka as unknown as StanNadania['przesylka'], doPotwierdzenia: [WAGA] }))
    expect(t).toContain('Utworzona')
    expect(t).toContain('0000123456789A')
    expect(t).not.toContain('Sprawdź przed nadaniem')
    expect(t).not.toContain('Utwórz przesyłkę')
    expect(t).not.toContain('Potwierdzam')
  })

  it('polaczPotwierdzenia: bez powtórzeń po kodzie, nowszy tekst wygrywa', () => {
    expect(polaczPotwierdzenia([WAGA, { kod: 'nieoplacone', tekst: 'a' }], [{ kod: 'waga_domyslna', tekst: 'nowy' }])).toEqual([
      { kod: 'waga_domyslna', tekst: 'nowy' },
      { kod: 'nieoplacone', tekst: 'a' },
    ])
  })
})

describe(',', () => {
  it('potwierdzeniaDoWyslania: tylko kody widoczne w kroku, każdy z tekstem, który człowiek widział', () => {
    const COD = { kod: 'pobranie_kilka_paczek', tekst: 'Ta paczka pobiera 120,00 zł.' }
    expect(potwierdzeniaDoWyslania([WAGA, COD], ['waga_domyslna', 'stary_kod'])).toEqual([WAGA])
    expect(potwierdzeniaDoWyslania([], ['waga_domyslna'])).toEqual([])
  })

  it('zaznaczeniaPoOdmowie: kody zwrócone przez nadanie tracą zaznaczenie, reszta zostaje', () => {
    expect(zaznaczeniaPoOdmowie(['waga_domyslna', 'wymiary_domyslne'], [{ kod: 'waga_domyslna' }])).toEqual(['wymiary_domyslne'])
    expect(zaznaczeniaPoOdmowie(['waga_domyslna'], undefined)).toEqual(['waga_domyslna'])
  })

  it('zdarzenie przeliczenia dochodzi tylko do bloku tego zamówienia, z tekstami z odmowy', () => {
    const okno = new EventTarget()
    vi.stubGlobal('window', okno)
    try {
      const z1: unknown[] = []
      const z2: unknown[] = []
      const wypisz1 = naPrzeliczeniePrzesylki('z1', (p) => z1.push(p))
      const wypisz2 = naPrzeliczeniePrzesylki('z2', (p) => z2.push(p))
      ogloszPrzeliczeniePrzesylki({ orderId: 'z1' })
      ogloszPrzeliczeniePrzesylki({ orderId: 'z1', doPotwierdzenia: [WAGA] })
      expect(z1).toEqual([{ orderId: 'z1' }, { orderId: 'z1', doPotwierdzenia: [WAGA] }])
      expect(z2).toEqual([])
      wypisz1()
      wypisz2()
      ogloszPrzeliczeniePrzesylki({ orderId: 'z1' })
      expect(z1).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
