import { describe, expect, it } from 'vitest'
import { komunikatPrzelaczenia, nastepneWSesji, poBrakuWPracy, poCofnieciuWPracy, podsumowanieSesji, poPrzelaczeniu, poZapisie, type PozycjaSesji } from './sesja'

const poz = (id: string, stan: PozycjaSesji['stan'], extra: Partial<PozycjaSesji> = {}): PozycjaSesji => ({ id, numer: `SD ${id}`, tryb: 'CIEN', printId: null, stan, komunikat: null, czerwona: false, ...extra })

describe('poPrzelaczeniu', () => {
  it('seria z kolejki: zamówienie spoza serii staje przed odłożonym, po jego zapisie wraca do odłożonego, potem dalej', () => {
    const s = poPrzelaczeniu([poz('1', 'spakowane'), poz('2', 'czeka'), poz('3', 'czeka')], '2', poz('X', 'czeka', { printId: 'p1' }))
    expect(s.map((x) => x.id)).toEqual(['1', 'X', '2', '3'])
    expect(s[1]).toMatchObject({ id: 'X', printId: 'p1', stan: 'czeka' })
    expect(s[1]!.pojedynczy).toBeUndefined()
    const poX = s.map((x) => (x.id === 'X' ? { ...x, stan: 'spakowane' as const } : x))
    expect(nastepneWSesji(poX, 'X')?.id).toBe('2')
    expect(nastepneWSesji(poX.map((x) => (x.id === '2' ? { ...x, stan: 'spakowane' as const } : x)), '2')?.id).toBe('3')
  })
  it('zamówienie już na liście przesuwa się przed odłożone (bez dubla), łańcuch skanów wraca po kolei', () => {
    const s = poPrzelaczeniu([poz('1', 'czeka'), poz('2', 'czeka'), poz('3', 'czeka')], '1', poz('3', 'czeka'))
    expect(s.map((x) => x.id)).toEqual(['3', '1', '2'])
    const s2 = poPrzelaczeniu(s, '3', poz('Y', 'czeka'))
    expect(s2.map((x) => x.id)).toEqual(['Y', '3', '1', '2'])
    expect(nastepneWSesji(s2.map((x) => (x.id === 'Y' ? { ...x, stan: 'spakowane' as const } : x)), 'Y')?.id).toBe('3')
  })
  it('samodzielne stanowisko: po pojedynczym skanie nowe też pojedyncze (po zapisie „Zapisane”, odłożone czeka na skan)', () => {
    const s = poPrzelaczeniu([poz('A', 'czeka', { pojedynczy: true })], 'A', poz('B', 'czeka', { pojedynczy: true }))
    expect(s.map((x) => [x.id, x.pojedynczy])).toEqual([
      ['B', true],
      ['A', true],
    ])
    expect(poZapisie(s.map((x) => (x.id === 'B' ? { ...x, stan: 'spakowane' as const } : x)), 'B')).toBe('zapisane')
  })
  it('wcześniej „nie spakowano” albo z uwagą: po otwarciu znów „czeka”, bez komunikatu', () => {
    const s = poPrzelaczeniu([poz('1', 'czeka'), poz('2', 'nie_spakowano', { komunikat: 'x', czerwona: true })], '1', poz('2', 'czeka'))
    expect(s[0]).toMatchObject({ id: '2', stan: 'czeka', komunikat: null, czerwona: false })
  })
})

describe('komunikatPrzelaczenia', () => {
  it('mówi, co zostaje niespakowane, i wprost, że odhaczenia giną; braki zostają', () => {
    expect(komunikatPrzelaczenia('SD 2/1', { numer: 'SD 1/1', zapisane: false, odhaczone: false, braki: false })).toBe('Przełączono na SD 2/1; SD 1/1 zostaje niespakowane.')
    expect(komunikatPrzelaczenia('SD 2/1', { numer: 'SD 1/1', zapisane: false, odhaczone: true, braki: true })).toBe(
      'Przełączono na SD 2/1; SD 1/1 zostaje niespakowane. Odhaczenia z SD 1/1 wyzerowane, po ponownym skanie zbierasz je od nowa. Zapisane braki „Na półce nie było” zostają.',
    )
  })
  it('poprzednie już zapisane albo brak okna: zwykłe otwarcie', () => {
    expect(komunikatPrzelaczenia('SD 2/1', { numer: 'SD 1/1', zapisane: true, odhaczone: true, braki: false })).toBe('SD 2/1: otwarte do pakowania.')
    expect(komunikatPrzelaczenia('SD 2/1', null)).toBe('SD 2/1: otwarte do pakowania.')
  })
})

describe('nastepneWSesji', () => {
  it('sesja czeka / NIE PAKUJ / czeka: po pierwszym otwiera trzecie, po ostatnim nic', () => {
    const s = [poz('1', 'spakowane'), poz('2', 'blokada', { czerwona: true }), poz('3', 'czeka')]
    expect(nastepneWSesji(s, '1')?.id).toBe('3')
    expect(nastepneWSesji([s[0]!, s[1]!, poz('3', 'spakowane')], '3')).toBeNull()
  })
  it('wraca na początek listy, gdy zamówienie zostawiono za plecami', () => {
    expect(nastepneWSesji([poz('1', 'czeka'), poz('2', 'czeka')], '2')?.id).toBe('1')
  })
  it('nie zwraca bieżącego ani „nie spakowano”', () => {
    expect(nastepneWSesji([poz('1', 'czeka')], '1')).toBeNull()
    expect(nastepneWSesji([poz('1', 'nie_spakowano'), poz('2', 'spakowane')], null)).toBeNull()
  })
  it('bez bieżącego zaczyna od pierwszego „czeka”', () => {
    expect(nastepneWSesji([poz('1', 'blokada'), poz('2', 'czeka')], null)?.id).toBe('2')
  })
})

describe('poZapisie', () => {
  it('pojedynczy skan po zakończonej sesji: „Zapisane” z odliczaniem, nie podsumowanie', () => {
    expect(poZapisie([poz('A', 'spakowane'), poz('B', 'spakowane'), poz('C', 'spakowane', { pojedynczy: true })], 'C')).toBe('zapisane')
  })
  it('pojedynczy skan bez sesji: „Zapisane”; porzucony wcześniej pojedynczy skan nie otwiera się sam', () => {
    expect(poZapisie([poz('C', 'spakowane', { pojedynczy: true })], 'C')).toBe('zapisane')
    const s = [poz('X', 'czeka', { pojedynczy: true }), poz('C', 'spakowane', { pojedynczy: true })]
    expect(nastepneWSesji(s, 'C')).toBeNull()
    expect(poZapisie(s, 'C')).toBe('zapisane')
  })
  it('skan w trakcie pakowania dokłada następne: przejście, po nim podsumowanie', () => {
    expect(poZapisie([poz('A', 'spakowane', { pojedynczy: true }), poz('B', 'czeka')], 'A')).toBe('nastepne')
    expect(poZapisie([poz('A', 'spakowane', { pojedynczy: true }), poz('B', 'spakowane')], 'B')).toBe('podsumowanie')
  })
  it('sesja z kolejki: następne albo podsumowanie, „Nie spakowano” tak samo', () => {
    expect(poZapisie([poz('1', 'nie_spakowano'), poz('2', 'czeka')], '1')).toBe('nastepne')
    expect(poZapisie([poz('1', 'nie_spakowano'), poz('2', 'spakowane')], '1')).toBe('podsumowanie')
  })
})

describe('podsumowanieSesji', () => {
  it('każde zamówienie raz: spakowane + z brakiem = licznik nagłówka, czerwone i nie spakowane to pominięte', () => {
    expect(
      podsumowanieSesji([
        poz('1', 'spakowane'),
        poz('2', 'spakowane', { zBrakiem: true }),
        poz('3', 'blokada', { czerwona: true }),
        poz('4', 'nie_spakowano'),
        poz('5', 'blokada'),
        poz('6', 'nie_spakowano', { zBrakiem: true }),
      ]),
    ).toEqual({ spakowane: 1, zBrakiem: 2, pominiete: 3 })
  })
})

describe('poBrakuWPracy', () => {
  it('zwykła pozycja: ekran dalej liczy ilość minus brak okna', () => {
    const w = poBrakuWPracy({ pozycje: [{ klucz: 'a', ilosc: 3 }], braki: { a: { ilosc: 1 } }, zebrane: { a: 2 } }, [{ klucz: 'a', ilosc: 2 }])
    expect(w).toEqual({ pozycje: [{ klucz: 'a', ilosc: 3 }], zebrane: { a: 2 } })
  })
  it('zestaw: składnik bez sztuk do zebrania znika, zebrane nie przekraczają tego, co zostało', () => {
    const w = poBrakuWPracy(
      { pozycje: [{ klucz: 'a', ilosc: 1 }, { klucz: 'b', ilosc: 4 }, { klucz: 'k', ilosc: 1 }], braki: { b: { ilosc: 1 } }, zebrane: { a: 1, b: 3, k: 1 } },
      [{ klucz: 'b', ilosc: 2 }, { klucz: 'k', ilosc: 1 }],
    )
    expect(w).toEqual({ pozycje: [{ klucz: 'b', ilosc: 3 }, { klucz: 'k', ilosc: 1 }], zebrane: { b: 2, k: 1 } })
  })
})

describe('poCofnieciuWPracy', () => {
  it('zwykła pozycja: brak cofnięty, do zebrania pełna ilość, zebrane zostają', () => {
    const w = poCofnieciuWPracy({ pozycje: [{ klucz: 'a', ilosc: 3 }], braki: {}, zebrane: { a: 2 } }, [{ klucz: 'a', ilosc: 3 }])
    expect(w).toEqual({ pozycje: [{ klucz: 'a', ilosc: 3 }], zebrane: { a: 2 } })
  })
  it('zestaw: składnik, który zniknął z okna, wraca; inny brak okna zostaje doliczony', () => {
    const w = poCofnieciuWPracy(
      { pozycje: [{ klucz: 'b', ilosc: 3 }, { klucz: 'c', ilosc: 1 }], braki: { c: { ilosc: 1 } }, zebrane: { b: 2 } },
      [{ klucz: 'a', ilosc: 1 }, { klucz: 'b', ilosc: 4 }],
    )
    expect(w).toEqual({ pozycje: [{ klucz: 'a', ilosc: 1 }, { klucz: 'b', ilosc: 4 }, { klucz: 'c', ilosc: 1 }], zebrane: { a: 0, b: 2, c: 0 } })
  })
})
