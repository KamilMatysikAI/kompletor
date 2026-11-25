// zaznaczanie per kurier i zwijane sekcje kolejki pakowania (czyste funkcje).
import { describe, expect, it } from 'vitest'
import { idsKurieraPozaStrona, kluczKuriera, przelaczRozwiniete, rozbicieZaznaczenia, rozwinieteZ, zaznaczone, zaznaczonePoKurierach } from './zaznaczenie'

const o = (id: string, status = 'DO_REALIZACJI') => ({ id, status })

describe('idsKurieraPozaStrona', () => {
  it('lista tylko dla kuriera, który ma zamówienia do spakowania poza stroną; spakowane się nie liczą', () => {
    const wszystkie = [
      { carrier: 'DPD', orders: [o('d1'), o('d2')] },
      { carrier: 'PACZKOMATY', orders: [o('i1'), o('i2'), o('i3'), o('i4', 'SPAKOWANE')] },
      { carrier: null, orders: [o('b1')] },
    ]
    const strona = [
      { carrier: 'DPD', orders: [o('d1'), o('d2')] },
      { carrier: 'PACZKOMATY', orders: [o('i1')] },
    ]
    expect(idsKurieraPozaStrona(wszystkie, strona)).toEqual({ PACZKOMATY: ['i1', 'i2', 'i3'], brak: ['b1'] })
  })

  it('kurier w całości na stronie (także ze spakowanymi poza listą pól) nie dostaje listy', () => {
    const g = [{ carrier: 'DPD', orders: [o('d1'), o('d2', 'SPAKOWANE')] }]
    expect(idsKurieraPozaStrona(g, g)).toEqual({})
  })

  it('klucz sekcji', () => {
    expect(kluczKuriera('DPD')).toBe('DPD')
    expect(kluczKuriera(null)).toBe('brak')
  })
})

describe('zaznaczone', () => {
  const sekcje = [
    { klucz: 'DPD', naStronie: ['d1', 'd2'], zaznaczone: new Set(['d2']) },
    { klucz: 'PACZKOMATY', naStronie: ['i3', 'i4'], zaznaczone: new Set(['i3', 'i4']) },
  ]
  const wszystkie = { PACZKOMATY: ['i1', 'i2', 'i3', 'i4', 'i5'] }

  it('bez „wszystkie tego kuriera”: zaznaczone pola na stronie w kolejności sekcji', () => {
    expect(zaznaczone(sekcje, new Set(), wszystkie)).toEqual(['d2', 'i3', 'i4'])
  })

  it('„wszystkie tego kuriera”: zamówienia z innych stron w kolejności kolejki, bez odznaczonych na stronie', () => {
    expect(zaznaczone(sekcje, new Set(['PACZKOMATY']), wszystkie)).toEqual(['d2', 'i1', 'i2', 'i3', 'i4', 'i5'])
    const odznaczone = [sekcje[0]!, { ...sekcje[1]!, zaznaczone: new Set(['i4']) }]
    expect(zaznaczone(odznaczone, new Set(['PACZKOMATY']), wszystkie)).toEqual(['d2', 'i1', 'i2', 'i4', 'i5'])
  })

  it('kurier bez listy z serwera: tylko strona; bez powtórzeń', () => {
    expect(zaznaczone(sekcje, new Set(['DPD']), wszystkie)).toEqual(['d2', 'i3', 'i4'])
    expect(zaznaczone([{ klucz: 'X', naStronie: ['a', 'a'], zaznaczone: new Set(['a']) }], new Set(['X']), { X: ['a', 'b'] })).toEqual(['a', 'b'])
  })
})

describe('zaznaczone per kurier', () => {
  const sekcje = [
    { klucz: 'DPD', naStronie: ['d1', 'd2'], zaznaczone: new Set(['d2']) },
    { klucz: 'PACZKOMATY', naStronie: ['i3', 'i4'], zaznaczone: new Set(['i3']) },
    { klucz: 'brak', naStronie: ['b1'], zaznaczone: new Set<string>() },
  ]
  const wszystkie = { PACZKOMATY: ['i1', 'i2', 'i3', 'i4', 'i5'] }
  const etykiety = { DPD: 'DPD', PACZKOMATY: 'InPost' }

  it('podział na kurierów sumuje się do listy „Zaznaczono” i liczy zamówienia z innych stron przy kurierze', () => {
    for (const caly of [new Set<string>(), new Set(['PACZKOMATY'])]) {
      const po = zaznaczonePoKurierach(sekcje, caly, wszystkie)
      expect(po.flatMap((s) => s.ids)).toEqual(zaznaczone(sekcje, caly, wszystkie))
    }
    const po = zaznaczonePoKurierach(sekcje, new Set(['PACZKOMATY']), wszystkie)
    expect(po.map((s) => [s.klucz, s.ids.length])).toEqual([
      ['DPD', 1],
      ['PACZKOMATY', 4],
      ['brak', 0],
    ])
  })

  it('id powtórzone w dwóch sekcjach liczy się raz, przy pierwszej', () => {
    const po = zaznaczonePoKurierach([{ klucz: 'A', naStronie: ['x'], zaznaczone: new Set(['x']) }, { klucz: 'B', naStronie: ['x', 'y'], zaznaczone: new Set(['x', 'y']) }], new Set(), {})
    expect(po).toEqual([
      { klucz: 'A', ids: ['x'] },
      { klucz: 'B', ids: ['y'] },
    ])
  })

  it('rozbicie w pasku tylko przy więcej niż jednym kurierze, w kolejności kolejki, z etykietami', () => {
    const liczby = (caly: Set<string>) => zaznaczonePoKurierach(sekcje, caly, wszystkie).map((s) => ({ klucz: s.klucz, ile: s.ids.length }))
    expect(rozbicieZaznaczenia(liczby(new Set(['PACZKOMATY'])), etykiety)).toBe('DPD 1, InPost 4')
    expect(rozbicieZaznaczenia([{ klucz: 'PACZKOMATY', ile: 40 }, { klucz: 'DPD', ile: 0 }], etykiety)).toBeNull()
    expect(rozbicieZaznaczenia([], etykiety)).toBeNull()
    expect(rozbicieZaznaczenia([{ klucz: 'DPD', ile: 3 }, { klucz: 'brak', ile: 2 }], etykiety)).toBe('DPD 3, brak 2')
  })
})

describe('rozwinięte sekcje (ciasteczko)', () => {
  it('czyta tylko poprawne klucze, bez powtórzeń', () => {
    expect(rozwinieteZ('DPD,PACZKOMATY,DPD')).toEqual(['DPD', 'PACZKOMATY'])
    expect(rozwinieteZ(encodeURIComponent('DPD,brak'))).toEqual(['DPD', 'brak'])
    expect(rozwinieteZ('<script>,DPD')).toEqual(['DPD'])
    expect(rozwinieteZ('%E0%A4%A')).toEqual([])
    expect(rozwinieteZ(undefined)).toEqual([])
  })

  it('przełączanie', () => {
    expect(przelaczRozwiniete(['DPD'], 'PACZKOMATY', true)).toEqual(['DPD', 'PACZKOMATY'])
    expect(przelaczRozwiniete(['DPD', 'PACZKOMATY'], 'DPD', false)).toEqual(['PACZKOMATY'])
    expect(przelaczRozwiniete(['DPD'], 'DPD', true)).toEqual(['DPD'])
  })
})
